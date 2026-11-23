//! Implements the Gemini Developer API streaming provider.
use std::collections::HashMap;

use async_stream::try_stream;
use base64::{engine::general_purpose::STANDARD, Engine};
use eventsource_stream::Eventsource;
use futures_util::StreamExt;
use serde_json::{json, Map, Value};
use tokio_util::sync::CancellationToken;

use crate::{
    config::ProviderConfig,
    model::{ContentPart, ModelInvocation, ModelRequest, ProjectedContent, ProjectedMessage, ProviderReplayState, Role, Usage},
    Error, Result,
};

use super::{
    attempt::{send_once, Attempt},
    map_sse_error, merge_extra_params, provider_event_error, recorder::recorded_headers,
    CallRecorder, FinishReason, ModelEvent, Provider, ProviderStream,
};

const REPLAY_KIND: &str = "gemini";

pub struct GeminiProvider
{
    client: reqwest::Client,
    config: ProviderConfig,
    recorder: Option<CallRecorder>,
}

impl GeminiProvider
{
    pub fn new(client: reqwest::Client, config: ProviderConfig) -> Self
    {
        Self { client, config, recorder: None }
    }

    pub fn with_recorder(mut self, recorder: Option<CallRecorder>) -> Self
    {
        self.recorder = recorder;
        self
    }
}

impl Provider for GeminiProvider
{
    fn stream(&self, invocation: ModelInvocation, cancellation: CancellationToken) -> ProviderStream
    {
        let client = self.client.clone();
        let config = self.config.clone();
        let recorder = self.recorder.clone();
        Box::pin(try_stream! {
            let body = request_body(&invocation.request, config.max_output_tokens)?;
            if let Some(recorder) = &recorder
            {
                recorder.request(recorded_headers(&config, &[("content-type", "application/json")]), &body).await?;
            }
            let attempt = send_once(
                "Gemini",
                || client.post(&config.request_url).headers(config.custom_headers.clone()).header("x-goog-api-key", &config.api_key).json(&body),
                &cancellation,
                recorder.as_ref(),
            ).await?;
            let Attempt::Response(response) = attempt else { return };
            yield ModelEvent::Start { model_call_id: invocation.call_id };

            let chunk_recorder = recorder.clone();
            let chunks = response.bytes_stream().then(move |chunk| {
                let recorder = chunk_recorder.clone();
                async move {
                    let chunk = chunk?;
                    if let Some(recorder) = recorder
                    {
                        recorder.response_chunk(&chunk).await?;
                    }
                    Ok::<_, Error>(chunk)
                }
            });
            let source = chunks.eventsource();
            futures_util::pin_mut!(source);
            let mut parts = Vec::new();
            let mut active_thought = None;
            let mut tool_count = 0;
            let mut usage = Map::new();
            let mut finish = None;

            while let Some(event) = tokio::select! {
                _ = cancellation.cancelled() => return,
                event = source.next() => event,
            }
            {
                let event = event.map_err(|error| map_sse_error("Gemini", error))?;
                let value: Value = serde_json::from_str(&event.data)?;
                if let Some(error) = provider_event_error("Gemini", &value)
                {
                    Err(error)?;
                }
                if let Some(update) = value.get("usageMetadata").and_then(Value::as_object)
                {
                    usage.extend(update.clone());
                }
                if let Some(reason) = value.pointer("/promptFeedback/blockReason").and_then(Value::as_str).filter(|reason| *reason != "BLOCK_REASON_UNSPECIFIED")
                {
                    Err(upstream_finish_error(reason))?;
                }
                let Some(candidate) = value.pointer("/candidates/0") else { continue };
                if let Some(chunk_parts) = candidate.pointer("/content/parts").and_then(Value::as_array)
                {
                    for part in chunk_parts
                    {
                        if let Some(call) = part.get("functionCall")
                        {
                            let name = call.get("name").and_then(Value::as_str).filter(|name| !name.is_empty()).ok_or_else(|| Error::Provider("Gemini function call has no name".into()))?;
                            let arguments = call.get("args").cloned().unwrap_or_else(|| json!({}));
                            if !arguments.is_object()
                            {
                                Err(Error::Provider("Gemini function-call arguments must be an object".into()))?;
                            }
                            if let Some(thought) = active_thought.take()
                            {
                                yield end_block(thought);
                            }
                            let index = tool_count;
                            tool_count += 1;
                            yield ModelEvent::ToolCallStart { index, call_id: format!("gemini_{}", uuid::Uuid::new_v4().simple()), name: name.into() };
                            yield ModelEvent::ToolCallArgumentsDelta { index, delta: serde_json::to_string(&arguments)? };
                            yield ModelEvent::ToolCallEnd { index };
                        }
                        else if let Some(text) = part.get("text").and_then(Value::as_str).filter(|text| !text.is_empty())
                        {
                            let thought = part.get("thought").and_then(Value::as_bool).unwrap_or(false);
                            if active_thought != Some(thought)
                            {
                                if let Some(previous) = active_thought.replace(thought)
                                {
                                    yield end_block(previous);
                                }
                                yield if thought { ModelEvent::ThinkingStart } else { ModelEvent::TextStart };
                            }
                            yield if thought { ModelEvent::ThinkingDelta(text.into()) } else { ModelEvent::TextDelta(text.into()) };
                        }
                        append_replay_part(&mut parts, part);
                    }
                }
                match candidate.get("finishReason").and_then(Value::as_str)
                {
                    Some("STOP") => finish = Some(FinishReason::Stop),
                    Some("MAX_TOKENS") => finish = Some(FinishReason::Length),
                    None | Some("" | "FINISH_REASON_UNSPECIFIED") => {}
                    Some(reason) => Err(upstream_finish_error(reason))?,
                }
            }

            let finish = finish.ok_or_else(|| Error::Provider("Gemini stream ended without a finish reason".into()))?;
            if let Some(thought) = active_thought
            {
                yield end_block(thought);
            }
            if !parts.is_empty()
            {
                yield ModelEvent::ProviderReplayState(ProviderReplayState { provider_kind: REPLAY_KIND.into(), value: json!({"parts": parts}) });
            }
            if !usage.is_empty()
            {
                yield ModelEvent::Usage(gemini_usage(&Value::Object(usage)));
            }
            yield ModelEvent::Done(if tool_count > 0 && finish == FinishReason::Stop { FinishReason::ToolUse } else { finish });
        })
    }
}

fn end_block(thought: bool) -> ModelEvent
{
    if thought { ModelEvent::ThinkingEnd } else { ModelEvent::TextEnd }
}

fn upstream_finish_error(reason: &str) -> Error
{
    Error::Upstream { status: None, code: Some(reason.into()), message: format!("Gemini generation stopped: {reason}") }
}

fn append_replay_part(parts: &mut Vec<Value>, part: &Value)
{
    // Only join consecutive unsigned text deltas. A signature always stays in its original part.
    if let Some(text) = part.get("text").and_then(Value::as_str)
    {
        if let Some(previous) = parts.last_mut()
        {
            let text_only = |value: &Value| value.as_object().is_some_and(|object| object.keys().all(|name| matches!(name.as_str(), "text" | "thought")));
            if previous.get("thought") == part.get("thought") && text_only(previous) && text_only(part)
            {
                if let Some(previous_text) = previous.get_mut("text").filter(|value| value.is_string())
                {
                    let Value::String(mut joined) = previous_text.take() else { unreachable!("checked string") };
                    joined.push_str(text);
                    *previous_text = Value::String(joined);
                    return;
                }
            }
        }
    }
    parts.push(part.clone());
}

fn request_body(request: &ModelRequest, default_max_tokens: Option<u64>) -> Result<Value>
{
    let mut body = json!({"contents": gemini_contents(&request.history)?});
    if !request.prompt.instructions.is_empty()
    {
        body["systemInstruction"] = json!({"parts": [{"text": request.prompt.instructions}]});
    }
    if !request.prompt.tools.is_empty()
    {
        let declarations = request.prompt.tools.iter().map(|tool| json!({
            "name": tool.name,
            "description": tool.description,
            "parametersJsonSchema": tool.parameters,
        })).collect::<Vec<_>>();
        body["tools"] = json!([{"functionDeclarations": declarations}]);
    }

    let mut extra = request.model.extra_params.as_object().cloned().ok_or_else(|| Error::Config("model extra params must be an object".into()))?;
    let native = extra.remove("generationConfig");
    let mut generation = Map::new();
    if let Some(max_tokens) = request.model.max_output_tokens.or(default_max_tokens)
    {
        generation.insert("maxOutputTokens".into(), json!(max_tokens));
    }
    if let Some(native) = native
    {
        generation.extend(native.as_object().cloned().ok_or_else(|| Error::Config("Gemini generationConfig must be an object".into()))?);
    }
    for (key, wire_key) in [("temperature", "temperature"), ("top_p", "topP"), ("stop", "stopSequences")]
    {
        if let Some(value) = extra.remove(key)
        {
            generation.insert(wire_key.into(), value);
        }
    }
    let reasoning = &request.model.reasoning;
    if reasoning.enabled_override.unwrap_or(reasoning.enabled) || (reasoning.enabled_override == Some(false) && generation.contains_key("thinkingConfig"))
    {
        let thinking = generation.entry("thinkingConfig").or_insert_with(|| json!({})).as_object_mut().ok_or_else(|| Error::Config("Gemini thinkingConfig must be an object".into()))?;
        let visible = json!(reasoning.enabled_override.unwrap_or(reasoning.enabled));
        if reasoning.enabled_override.is_some()
        {
            thinking.insert("includeThoughts".into(), visible);
        }
        else
        {
            thinking.entry("includeThoughts").or_insert(visible);
        }
    }
    if generation.get("candidateCount").is_some_and(|count| count.as_u64() != Some(1))
    {
        return Err(Error::Config("Gemini requires a single candidate".into()));
    }
    if !generation.is_empty()
    {
        body["generationConfig"] = Value::Object(generation);
    }
    for key in ["contents", "systemInstruction", "system_instruction", "generation_config"]
    {
        if extra.contains_key(key)
        {
            return Err(Error::Config(format!("Gemini extra params cannot replace {key}")));
        }
    }
    merge_extra_params(&mut body, &Value::Object(extra))?;
    Ok(body)
}

fn gemini_contents(messages: &[ProjectedMessage]) -> Result<Vec<Value>>
{
    let mut contents = Vec::new();
    let mut tool_calls = HashMap::<&str, (usize, Value)>::new();
    let mut responses = Vec::new();
    for message in messages
    {
        if let ProjectedContent::ToolResult(result) = &message.content
        {
            let (index, call) = tool_calls.get(result.call_id.as_str()).ok_or_else(|| Error::Protocol(format!("Gemini tool result has no matching call: {}", result.call_id)))?;
            let result_key = if result.is_error { "error" } else { "output" };
            let mut response = json!({"name": call["name"], "response": {result_key: result.content}});
            if let Some(id) = call.get("id")
            {
                response["id"] = id.clone();
            }
            let images = result.provider_parts.iter().filter(|part| matches!(part, ContentPart::Image { .. })).filter_map(gemini_part).collect::<Vec<_>>();
            if !images.is_empty()
            {
                response["parts"] = json!(images);
            }
            responses.push((*index, json!({"functionResponse": response})));
            continue;
        }
        flush_responses(&mut contents, &mut responses);

        let (role, parts) = match &message.content
        {
            ProjectedContent::Parts(parts) => (if message.role == Role::Assistant { "model" } else { "user" }, parts.iter().filter_map(gemini_part).collect()),
            ProjectedContent::Assistant { text, replay_state, calls, .. } =>
            {
                let parts = match replay_state.as_ref().filter(|state| state.provider_kind == REPLAY_KIND)
                {
                    Some(state) => state.value.get("parts").and_then(Value::as_array).cloned().ok_or_else(|| Error::Protocol("Gemini replay state is missing parts".into()))?,
                    None =>
                    {
                        let mut parts = Vec::new();
                        if !text.is_empty()
                        {
                            parts.push(json!({"text": text}));
                        }
                        for (index, call) in calls.iter().enumerate()
                        {
                            let mut part = json!({"functionCall": {"id": call.call_id, "name": call.name, "args": call.arguments}});
                            if index == 0
                            {
                                // Google documents this marker for tool history imported from a different API.
                                part["thoughtSignature"] = json!("skip_thought_signature_validator");
                            }
                            parts.push(part);
                        }
                        parts
                    }
                };
                let native_calls = parts.iter().filter_map(|part| part.get("functionCall")).collect::<Vec<_>>();
                if native_calls.len() != calls.len()
                {
                    return Err(Error::Protocol("Gemini replay does not match projected tool calls".into()));
                }
                for (index, (call, native)) in calls.iter().zip(native_calls).enumerate()
                {
                    tool_calls.insert(call.call_id.as_str(), (index, native.clone()));
                }
                ("model", parts)
            }
            ProjectedContent::ToolResult(_) => unreachable!("handled above"),
        };
        if !parts.is_empty()
        {
            contents.push(json!({"role": role, "parts": parts}));
        }
    }
    flush_responses(&mut contents, &mut responses);
    Ok(contents)
}

fn flush_responses(contents: &mut Vec<Value>, responses: &mut Vec<(usize, Value)>)
{
    if !responses.is_empty()
    {
        responses.sort_by_key(|(index, _)| *index);
        let parts = responses.drain(..).map(|(_, part)| part).collect::<Vec<_>>();
        contents.push(json!({"role": "user", "parts": parts}));
    }
}

fn gemini_part(part: &ContentPart) -> Option<Value>
{
    match part
    {
        ContentPart::Text { text } if text.is_empty() => None,
        ContentPart::Text { text } => Some(json!({"text": text})),
        ContentPart::Image { mime_type, data } => Some(json!({"inlineData": {"mimeType": mime_type, "data": STANDARD.encode(data)}})),
    }
}

pub(crate) fn gemini_usage(value: &Value) -> Usage
{
    let read = |key| value.get(key).and_then(Value::as_u64);
    let prompt = read("promptTokenCount");
    let tool_input = read("toolUsePromptTokenCount");
    let reasoning = read("thoughtsTokenCount");
    let candidates = read("candidatesTokenCount");
    Usage {
        input_tokens: prompt.or(tool_input).map(|_| prompt.unwrap_or_default().saturating_add(tool_input.unwrap_or_default())),
        context_input_tokens: prompt,
        output_tokens: candidates.or(reasoning).map(|_| candidates.unwrap_or_default().saturating_add(reasoning.unwrap_or_default())),
        total_tokens: read("totalTokenCount"),
        cache_read_tokens: read("cachedContentTokenCount"),
        cache_write_tokens: None,
        reasoning_tokens: reasoning,
    }
}

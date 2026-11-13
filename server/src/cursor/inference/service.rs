//! Owns one client-loop inference stream per Cursor request ID.
use std::{collections::HashMap, sync::Arc};

use axum::http::HeaderMap;
use bytes::Bytes;
use futures_util::StreamExt;
use parking_lot::Mutex;
use prost::Message;
use tokio::{
    sync::{mpsc, Mutex as AsyncMutex, Notify},
    task::JoinSet,
};
use tokio_util::sync::CancellationToken;

use crate::{
    cursor::{
        protocol::{
            connect,
            proto::{agent::v1 as agent, inference as pb},
        },
        transport::{OutputHub, TransportRegistry},
        variant,
    },
    model::{CallOrigin, ModelInvocation, ModelType},
    provider::{ModelEvent, Provider},
    Error, Result,
};

use super::{
    project,
    selection::{RunHeaders, Selections},
};

#[derive(Clone)]
pub(crate) struct InferenceService {
    state: Arc<Mutex<State>>,
    changed: Arc<Notify>,
    registry: TransportRegistry,
}

#[derive(Default)]
struct State {
    routes: HashMap<String, InferenceRoute>,
    selections: Selections,
}

#[derive(Clone)]
pub(crate) enum InferenceRoute {
    Local(Arc<Run>),
    Upstream,
}

pub(crate) struct Run {
    input: mpsc::Sender<pb::RunInferenceClientMessage>,
    output: Arc<OutputHub>,
    next_seqno: AsyncMutex<i64>,
}

struct ModelInfo {
    display_name: String,
    model_type: ModelType,
    context_window_tokens: Option<u64>,
    model_id: String,
    reasoning_effort: Option<String>,
}

impl InferenceService {
    pub fn new(registry: TransportRegistry) -> Self {
        Self {
            state: Arc::new(Mutex::new(State::default())),
            changed: Arc::new(Notify::new()),
            registry,
        }
    }

    pub fn route(&self, request_id: &str) -> Option<InferenceRoute> {
        self.state.lock().routes.get(request_id).cloned()
    }

    pub async fn wait_route(&self, request_id: &str) -> InferenceRoute {
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if let Some(route) = self.route(request_id) {
                return route;
            }
            changed.await;
        }
    }

    pub async fn begin(
        &self,
        request_id: &str,
        message: &pb::RunInferenceClientMessage,
        headers: &HeaderMap,
    ) -> Result<InferenceRoute> {
        let Some(pb::run_inference_client_message::Message::RunRequest(request)) =
            message.message.as_ref()
        else {
            return Err(Error::Protocol(
                "first RunInference message must start a run".into(),
            ));
        };
        let requested_model = request
            .requested_model
            .as_ref()
            .filter(|model| !model.model_id.is_empty())
            .ok_or_else(|| Error::Protocol("RunInference model is required".into()))?;
        if request.conversation_id.is_empty() {
            return Err(Error::Protocol(
                "RunInference conversation ID is required".into(),
            ));
        }
        let resolved =
            variant::resolve_cursor_model(&self.registry, &requested_model.model_id).await?;
        let requested_model = variant::apply_to_inference_model(requested_model, &resolved);
        let model_id = resolved.base_model_id.as_str();
        let incoming_selection = project(&pb::InferenceStreamRequest::default(), &requested_model)?;
        let configured = resolved.configured;
        let local = resolved.local;
        let mut state = self.state.lock();
        if let Some(route) = state.routes.get(request_id) {
            return Ok(route.clone());
        }
        let route = if local {
            let headers = RunHeaders::parse(headers)?;
            let default_effort = configured.as_ref().and_then(|model| {
                if model.model_type == ModelType::Anthropic {
                    model.anthropic_thinking_effort.as_deref()
                } else {
                    model.reasoning_effort.as_deref()
                }
            });
            let requested_model = state.selections.resolve(
                &request.conversation_id,
                &requested_model,
                &headers,
                default_effort,
            )?;
            let selection = project(&pb::InferenceStreamRequest::default(), &requested_model)?;
            state.selections.remember(
                request_id,
                &request.conversation_id,
                &requested_model,
                &headers,
            )?;
            tracing::info!(
                request_id,
                model_id,
                conversation_id = %request.conversation_id,
                parent_request_id = ?headers.parent_request_id,
                root_parent_request_id = ?headers.root_parent_request_id,
                incoming_run_effort = ?incoming_selection.model.reasoning.effort,
                incoming_run_thinking_override = ?incoming_selection.model.reasoning.enabled_override,
                run_effort = ?selection.model.reasoning.effort,
                run_thinking_override = ?selection.model.reasoning.enabled_override,
                run_context_tokens = ?selection.model.context_window_tokens,
                run_latency = ?selection.model.latency,
                "routing Cursor RunInference to BYOK provider"
            );
            let (sender, receiver) = mpsc::channel(64);
            let output = Arc::new(OutputHub::default());
            let run = Arc::new(Run {
                input: sender,
                output: output.clone(),
                next_seqno: AsyncMutex::new(0),
            });
            tokio::spawn(serve(
                receiver,
                output,
                self.registry.provider(),
                request_id.into(),
                request.conversation_id.clone(),
                requested_model,
                configured.map(|model| ModelInfo {
                    display_name: model.display_name,
                    model_type: model.model_type,
                    context_window_tokens: model.context_window_tokens,
                    model_id: model.model_id,
                    reasoning_effort: if model.model_type == ModelType::Anthropic {
                        model.anthropic_thinking_effort
                    } else {
                        model.reasoning_effort
                    },
                }),
            ));
            InferenceRoute::Local(run)
        } else {
            tracing::info!(
                request_id,
                model_id,
                "routing Cursor RunInference to Cursor upstream"
            );
            InferenceRoute::Upstream
        };
        state.routes.insert(request_id.into(), route.clone());
        drop(state);
        self.changed.notify_waiters();
        Ok(route)
    }

    pub fn finish(&self, request_id: &str) {
        let mut state = self.state.lock();
        state.routes.remove(request_id);
        state.selections.finish(request_id);
    }
}

impl Run {
    pub async fn append(&self, seqno: i64, message: pb::RunInferenceClientMessage) -> Result<()> {
        let mut next = self.next_seqno.lock().await;
        if seqno < *next {
            return Ok(());
        }
        if seqno != *next {
            return Err(Error::Protocol(format!(
                "RunInference append sequence {seqno} differs from expected {}",
                *next
            )));
        }
        self.input
            .send(message)
            .await
            .map_err(|_| Error::Protocol("RunInference stream has ended".into()))?;
        *next += 1;
        Ok(())
    }

    pub fn subscribe(&self) -> mpsc::UnboundedReceiver<Bytes> {
        self.output.subscribe()
    }
}

async fn serve(
    mut input: mpsc::Receiver<pb::RunInferenceClientMessage>,
    output: Arc<OutputHub>,
    provider: Arc<dyn Provider>,
    run_id: String,
    conversation_id: String,
    requested_model: pb::InferenceRequestedModel,
    model_info: Option<ModelInfo>,
) {
    let invocations = Arc::new(Mutex::new(HashMap::<String, CancellationToken>::new()));
    let mut tasks = JoinSet::new();
    let mut finished = false;
    let mut provider_call_index = 0;
    while let Some(message) = input.recv().await {
        use pb::run_inference_client_message::Message;
        match message.message {
            Some(Message::RunRequest(_)) => {
                let ready = run_ready(Some(requested_model.clone()), model_info.as_ref());
                emit(
                    &output,
                    pb::run_inference_server_message::Message::RunReady(ready),
                );
            }
            Some(Message::InvokeModel(invoke)) => {
                let id = invoke.invocation_id.clone();
                let Some(request) = invoke.request else {
                    invocation_error(&output, id, "RunInference model request is missing");
                    continue;
                };
                if invoke.delta_base.is_some() || invoke.compressed_request.is_some() {
                    invocation_error(
                        &output,
                        id,
                        "RunInference delta or compressed requests are not supported",
                    );
                    continue;
                }
                let mut request = match project(&request, &requested_model) {
                    Ok(request) => request,
                    Err(error) => {
                        invocation_error(&output, id, &error.to_string());
                        continue;
                    }
                };
                tracing::info!(
                    request_id = %run_id,
                    invocation_id = %id,
                    effective_effort = ?request.model.reasoning.effort,
                    effective_thinking_override = ?request.model.reasoning.enabled_override,
                    configured_effort = ?model_info.as_ref().and_then(|model| model.reasoning_effort.as_deref()),
                    "resolved Cursor RunInference model selection"
                );
                if request.model.context_window_tokens.is_none() {
                    request.model.context_window_tokens = model_info
                        .as_ref()
                        .and_then(|model| model.context_window_tokens);
                }
                let cancellation = CancellationToken::new();
                invocations.lock().insert(id.clone(), cancellation.clone());
                tasks.spawn(serve_invocation(
                    provider.clone(),
                    output.clone(),
                    invocations.clone(),
                    cancellation,
                    ModelInvocation {
                        call_id: id,
                        run_id: run_id.clone(),
                        conversation_id: conversation_id.clone(),
                        provider_call_index,
                        origin: CallOrigin::Run,
                        request,
                    },
                ));
                provider_call_index += 1;
            }
            Some(Message::CancelInvocation(cancel)) => {
                if let Some(token) = invocations.lock().remove(&cancel.invocation_id) {
                    token.cancel();
                }
            }
            Some(Message::FinishRun(finish)) => {
                finished = true;
                if finish.aborted {
                    for (_, token) in invocations.lock().drain() {
                        token.cancel();
                    }
                }
                break;
            }
            None => {}
        }
    }
    if !finished {
        for (_, token) in invocations.lock().drain() {
            token.cancel();
        }
    }
    while tasks.join_next().await.is_some() {}
    output.emit(connect::encode_end_stream());
    output.close();
}

fn run_ready(
    requested_model: Option<pb::InferenceRequestedModel>,
    model_info: Option<&ModelInfo>,
) -> pb::RunInferenceRunReady {
    let (display_name, model_type) = model_info
        .map(|model| (model.display_name.clone(), model.model_type))
        .unwrap_or_else(|| (String::new(), ModelType::OpenAi));
    let anthropic = model_type == ModelType::Anthropic;
    let name = model_info
        .map(|model| model.model_id.to_ascii_lowercase())
        .unwrap_or_default();
    let selection = requested_model
        .as_ref()
        .and_then(|model| project(&pb::InferenceStreamRequest::default(), model).ok())
        .map(|request| request.model);
    let reasoning_effort = if selection
        .as_ref()
        .is_some_and(|model| model.reasoning.enabled_override == Some(false))
    {
        None
    } else {
        selection
            .as_ref()
            .and_then(|model| model.reasoning.effort.clone())
            .or_else(|| model_info.and_then(|model| model.reasoning_effort.clone()))
    };
    let context_limit = selection
        .as_ref()
        .and_then(|model| model.context_window_tokens)
        .or_else(|| model_info.and_then(|model| model.context_window_tokens));
    let claude = anthropic && name.contains("claude");
    let gpt5 = !anthropic && name.starts_with("gpt-5");
    let resolved_model = requested_model.map(|mut model| {
        if let Some(selection) = selection.as_ref() {
            if let Some(variant_id) = variant::encode_legacy_slug(
                &model.model_id,
                model_info.and_then(|info| info.context_window_tokens),
                selection,
            ) {
                model.model_id = variant_id;
            }
        }
        model
    });
    pb::RunInferenceRunReady {
        resolved_model,
        routed_model_display_name: (!display_name.is_empty()).then_some(display_name),
        prompt_model_metadata: Some(pb::RunInferencePromptModelMetadata {
            vendor: if anthropic { "anthropic" } else { "openai" }.into(),
            prompt_version: "latest".into(),
            reasoning_effort,
            agent_token_limit: context_limit.map(|limit| count(Some(limit))),
            is_claude_4x: claude,
            is_sonnet4: claude && name.contains("sonnet"),
            is_gpt5_family: gpt5,
            is_gpt5: gpt5,
            persona: "auto".into(),
            self_identity_name: "Cursor".into(),
            agent_mode_configs: agent_mode_configs(),
            use_new_plan_mode_prompts: Some(true),
            ask_question_config: Some(pb::RunInferenceAskQuestionConfig {
                tool_name: "AskQuestion".into(),
                auto_reject_first: false,
            }),
            ..Default::default()
        }),
        accepts_aborted_finish: true,
        ..Default::default()
    }
}

fn agent_mode_configs() -> Vec<pb::RunInferenceAgentModeConfig> {
    vec![
        mode_config("agent", true, Some(&["plan", "debug"])),
        mode_config("chat", true, None),
        mode_config("plan", true, Some(&["agent"])),
        mode_config("debug", true, Some(&["agent", "plan"])),
        mode_config("triage", true, None),
        mode_config("multitask", true, Some(&["agent", "plan", "debug"])),
    ]
}

fn mode_config(
    mode_id: &str,
    enable_ask_question_tool: bool,
    switch_targets: Option<&[&str]>,
) -> pb::RunInferenceAgentModeConfig {
    pb::RunInferenceAgentModeConfig {
        mode_id: mode_id.into(),
        enable_ask_question_tool,
        switch_mode_tool_config: switch_targets.map(|targets| {
            pb::RunInferenceSwitchModeToolConfig {
                target_modes: targets.iter().map(|&mode| mode.into()).collect(),
            }
        }),
    }
}

async fn serve_invocation(
    provider: Arc<dyn Provider>,
    output: Arc<OutputHub>,
    invocations: Arc<Mutex<HashMap<String, CancellationToken>>>,
    cancellation: CancellationToken,
    invocation: ModelInvocation,
) {
    let id = invocation.call_id.clone();
    let context_window_tokens = invocation.request.model.context_window_tokens;
    let mut stream = provider.stream(invocation, cancellation);
    let mut tool_calls = HashMap::<usize, (String, String, String)>::new();
    let mut error = None;
    while let Some(next) = stream.next().await {
        match next {
            Ok(event) => {
                for response in model_responses(event, &mut tool_calls, context_window_tokens) {
                    emit(
                        &output,
                        pb::run_inference_server_message::Message::InvocationResponse(
                            pb::RunInferenceInvocationResponse {
                                invocation_id: id.clone(),
                                response: Some(response),
                            },
                        ),
                    );
                }
            }
            Err(value) => {
                let (code, failure) = super::events::failure(&value);
                let message = failure.message.clone();
                emit(
                    &output,
                    pb::run_inference_server_message::Message::InvocationResponse(
                        pb::RunInferenceInvocationResponse {
                            invocation_id: id.clone(),
                            response: Some(pb::InferenceStreamResponse {
                                response: Some(pb::inference_stream_response::Response::Error(
                                    failure,
                                )),
                            }),
                        },
                    ),
                );
                error = Some(pb::RunInferenceInvocationError { code, message });
                break;
            }
        }
    }
    invocations.lock().remove(&id);
    let message = pb::RunInferenceInvocationEnd {
        invocation_id: id,
        error,
        ..Default::default()
    };
    emit(
        &output,
        pb::run_inference_server_message::Message::InvocationEnd(message),
    );
}

fn model_responses(
    event: ModelEvent,
    tool_calls: &mut HashMap<usize, (String, String, String)>,
    context_window_tokens: Option<u64>,
) -> impl Iterator<Item = pb::InferenceStreamResponse> {
    // Cursor resolves usage and extended_usage independently. Its context ring reads
    // used tokens from usage.total_tokens and the limit from extended_usage.max_tokens.
    let usage_response = if let ModelEvent::Usage(usage) = &event {
        let input_tokens = usage.context_input_tokens.or(usage.input_tokens);
        let total_tokens = input_tokens
            .map(|input| input.saturating_add(usage.output_tokens.unwrap_or_default()))
            .or(usage.total_tokens);
        Some(pb::InferenceStreamResponse {
            response: Some(pb::inference_stream_response::Response::Usage(
                pb::InferenceUsageInfo {
                    prompt_tokens: count(input_tokens),
                    completion_tokens: count(usage.output_tokens),
                    total_tokens: total_tokens.map(|total| count(Some(total))),
                },
            )),
        })
    } else {
        None
    };
    usage_response
        .into_iter()
        .chain(model_response(event, tool_calls, context_window_tokens))
}

fn model_response(
    event: ModelEvent,
    tool_calls: &mut HashMap<usize, (String, String, String)>,
    context_window_tokens: Option<u64>,
) -> Option<pb::InferenceStreamResponse> {
    use pb::inference_stream_response::Response;
    let response = match event {
        ModelEvent::TextDelta(text) => Response::TextPart(pb::InferenceTextStreamPart {
            text,
            is_final: false,
        }),
        ModelEvent::TextEnd => Response::TextPart(pb::InferenceTextStreamPart {
            text: String::new(),
            is_final: true,
        }),
        ModelEvent::ThinkingDelta(text) => {
            Response::ThinkingPart(pb::InferenceThinkingStreamPart {
                text,
                is_final: false,
                ..Default::default()
            })
        }
        ModelEvent::ThinkingEnd => Response::ThinkingPart(pb::InferenceThinkingStreamPart {
            text: String::new(),
            is_final: true,
            ..Default::default()
        }),
        ModelEvent::ThinkingSignature(signature) => {
            Response::ThinkingPart(pb::InferenceThinkingStreamPart {
                text: String::new(),
                signature: Some(signature),
                is_final: true,
                ..Default::default()
            })
        }
        ModelEvent::RedactedThinking(data) => {
            Response::ThinkingPart(pb::InferenceThinkingStreamPart {
                text: String::new(),
                redacted_data: Some(data),
                is_final: true,
                ..Default::default()
            })
        }
        ModelEvent::ToolCallStart {
            index,
            call_id,
            name,
        } => {
            tool_calls.insert(index, (call_id.clone(), name.clone(), String::new()));
            Response::ToolCallPart(pb::InferenceToolCallStreamPart {
                tool_call_id: call_id,
                tool_name: name,
                args: String::new(),
                is_complete: false,
                tool_index: i32::try_from(index).ok(),
            })
        }
        ModelEvent::ToolCallArgumentsDelta { index, delta } => {
            let (call_id, _, arguments) = tool_calls.get_mut(&index)?;
            arguments.push_str(&delta);
            Response::ToolCallPart(pb::InferenceToolCallStreamPart {
                tool_call_id: call_id.clone(),
                tool_name: String::new(),
                args: delta,
                is_complete: false,
                tool_index: i32::try_from(index).ok(),
            })
        }
        ModelEvent::ToolCallEnd { index } => {
            let (call_id, name, arguments) = tool_calls.remove(&index)?;
            Response::ToolCallPart(pb::InferenceToolCallStreamPart {
                tool_call_id: call_id,
                tool_name: name,
                args: arguments,
                is_complete: true,
                tool_index: i32::try_from(index).ok(),
            })
        }
        ModelEvent::Usage(usage) => Response::ExtendedUsage(pb::InferenceExtendedUsageInfo {
            input_tokens: count(usage.context_input_tokens.or(usage.input_tokens)),
            output_tokens: count(usage.output_tokens),
            cache_read_tokens: count(usage.cache_read_tokens),
            cache_write_tokens: count(usage.cache_write_tokens),
            max_tokens: count(context_window_tokens),
            reasoning_tokens: usage.reasoning_tokens.map(|tokens| count(Some(tokens))),
        }),
        ModelEvent::Start { model_call_id } => {
            Response::InvocationId(pb::InferenceInvocationIdInfo {
                invocation_id: model_call_id,
            })
        }
        ModelEvent::TextStart
        | ModelEvent::ThinkingStart
        | ModelEvent::ProviderReplayState(_)
        | ModelEvent::Done(_) => return None,
    };
    Some(pb::InferenceStreamResponse {
        response: Some(response),
    })
}

fn count(value: Option<u64>) -> i32 {
    value.unwrap_or_default().min(i32::MAX as u64) as i32
}

fn invocation_error(output: &OutputHub, id: String, message: &str) {
    emit(
        output,
        pb::run_inference_server_message::Message::InvocationEnd(pb::RunInferenceInvocationEnd {
            invocation_id: id,
            error: Some(pb::RunInferenceInvocationError {
                code: 3,
                message: message.into(),
            }),
            ..Default::default()
        }),
    );
}

fn emit(output: &OutputHub, message: pb::run_inference_server_message::Message) {
    let message = pb::RunInferenceServerMessage {
        message: Some(message),
    };
    if let Ok(frame) = connect::encode_message(&message) {
        output.emit(frame);
    }
}

pub(crate) fn decode_append(data: &[u8]) -> Result<pb::RunInferenceClientMessage> {
    pb::RunInferenceClientMessage::decode(data).map_err(Error::from)
}

/// Identifies an unrouted `BidiAppend` first frame that starts a client-owned
/// `RunInference` stream rather than an `AgentService` run.
///
/// Both top-level client messages place `RunRequest` at field 1, and `RunRequest`
/// shares field 1 (wire type LEN) and field 3 (`model_id` at field 1). Plain string
/// `conversation_id` values make no format assumptions (such as UUID shape); instead,
/// we verify whether the frame fails `AgentClientMessage` decoding or lacks any
/// `AgentRunRequest`-specific message structure.
pub(crate) fn starts_run_inference(payload: &[u8]) -> bool {
    let Ok(pb::RunInferenceClientMessage {
        message: Some(pb::run_inference_client_message::Message::RunRequest(inference)),
    }) = decode_append(payload)
    else {
        return false;
    };
    if inference.conversation_id.is_empty()
        || !inference
            .requested_model
            .as_ref()
            .is_some_and(|model| !model.model_id.is_empty())
    {
        return false;
    }
    let Ok(agent::AgentClientMessage {
        message: Some(agent::agent_client_message::Message::RunRequest(agent)),
    }) = agent::AgentClientMessage::decode(payload)
    else {
        return true;
    };
    !looks_like_agent_run_request(&agent, &inference)
}

fn looks_like_agent_run_request(
    agent: &agent::AgentRunRequest,
    inference: &pb::RunInferenceRunRequest,
) -> bool {
    agent.requested_model.is_some()
        || agent
            .action
            .as_ref()
            .is_some_and(|action| *action != agent::ConversationAction::default())
        || agent
            .mcp_tools
            .as_ref()
            .is_some_and(|tools| !tools.mcp_tools.is_empty())
        || is_populated_conversation_state(agent.conversation_state.as_ref())
        || inference
            .conversation_id
            .bytes()
            .any(|byte| byte < 0x20 || byte == 0x7f)
}

fn is_populated_conversation_state(state: Option<&agent::ConversationStateStructure>) -> bool {
    let Some(state) = state else {
        return false;
    };
    let valid_mode = state.mode.filter(|mode| (0..=8).contains(mode));
    let baseline = agent::ConversationStateStructure {
        mode: state.mode,
        ..Default::default()
    };
    state != &baseline || valid_mode.is_some()
}

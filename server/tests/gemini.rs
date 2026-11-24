//! Verifies native Gemini discovery, streaming, tool replay, and call accounting.
#[path = "support/fixtures.rs"]
mod fixtures;

use std::{collections::HashMap, sync::Arc, time::Duration};

use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderMap},
    routing::{get, post},
    Json, Router,
};
use cursor_server::{
    control::ControlService,
    model::{
        CallOrigin, ContentPart, ModelConfigInput, ModelInvocation, ModelRequest, ModelSpec,
        ProjectedContent, ProjectedMessage, PromptSpec, ProviderConfigInput, RequestFormat, Role,
        ToolCallContent, ToolDefinition, ToolResultContent,
    },
    network::NetworkClients,
    plugin::{PluginRegistry, PluginRuntime},
    provider::{FinishReason, ModelEvent, Provider, ProviderRouter},
};
use futures_util::{StreamExt, TryStreamExt};
use serde_json::{json, Value};
use tokio::{net::TcpListener, sync::mpsc};
use tokio_util::sync::CancellationToken;

async fn discover(Query(query): Query<HashMap<String, String>>, headers: HeaderMap) -> Json<Value> {
    assert_eq!(headers["x-goog-api-key"], "test-key");
    assert_eq!(headers["x-shared"], "test-gateway");
    if query.get("pageToken").is_some_and(|value| value == "next") {
        return Json(json!({"models": [
            {"name": "models/gemini-b", "supportedGenerationMethods": ["generateContent"]},
            {"name": "models/gemini-embed", "supportedGenerationMethods": ["embedContent"]}
        ]}));
    }
    Json(
        json!({"models": [{"name": "models/gemini-a", "supportedGenerationMethods": ["generateContent"]}], "nextPageToken": "next"}),
    )
}

async fn generate(
    State(requests): State<mpsc::UnboundedSender<Value>>,
    Path(method): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> ([(header::HeaderName, &'static str); 1], String) {
    assert_eq!(method, "gemini-a:streamGenerateContent");
    assert_eq!(query.get("alt").map(String::as_str), Some("sse"));
    assert_eq!(headers["x-goog-api-key"], "test-key");
    assert_eq!(headers["x-shared"], "test-gateway");
    assert!(!headers.contains_key("authorization"));
    let fail_generation = body
        .pointer("/contents/0/parts/0/text")
        .and_then(Value::as_str)
        == Some("fail-generation");
    let first_tool_round =
        body.get("tools").is_some() && body["contents"].as_array().unwrap().len() == 1;
    requests.send(body).unwrap();
    let mut chunks = if fail_generation {
        vec![
            json!({"candidates": [{"content": {"parts": [{"thought": true, "text": "Thinking"}, {"functionCall": {"name": "read_file", "willContinue": true}}]}}], "usageMetadata": {"promptTokenCount": 4200, "cachedContentTokenCount": 4000}}),
            json!({"candidates": [{"content": {"parts": [{"functionCall": {"partialArgs": "broken"}}]}, "finishReason": "MALFORMED_RESPONSE", "finishMessage": "Could not produce an answer"}], "usageMetadata": {"thoughtsTokenCount": 40, "totalTokenCount": 4240}}),
        ]
    } else if first_tool_round {
        vec![
            json!({"candidates": [{"content": {"parts": [{"thought": true, "text": "Thinking"}]}}]}),
            json!({"candidates": [{"content": {"parts": [{"text": "Next "}]}}]}),
            json!({"candidates": [{"content": {"parts": [
                {"text": "step"},
                {"functionCall": {"name": "read_file", "id": "native-a", "partialArgs": [{"jsonPath": "$.path", "stringValue": "a", "willContinue": true}], "willContinue": true}, "thoughtSignature": "signed-tool"}
            ]}}]}),
            json!({"candidates": [{"content": {"parts": [{"text": "", "thoughtSignature": "interleaved-signature"}, {"functionCall": {"partialArgs": [{"jsonPath": "$.path", "stringValue": ".txt", "willContinue": true}, {"jsonPath": "$.options[1]", "boolValue": true}, {"jsonPath": "$.options[0]['line.count']", "numberValue": 3}], "willContinue": true}}]}}]}),
            json!({"candidates": [{"content": {"parts": [
                {"functionCall": {"partialArgs": [{"jsonPath": "$['path']"}], "willContinue": true}},
                {"functionCall": {}},
                {"functionCall": {"name": "read_file", "args": {"path": "b.txt"}}}
            ]}, "finishReason": "STOP"}]}),
        ]
    } else {
        vec![
            json!({"candidates": [{"content": {"parts": [{"text": "Done"}, {"text": "", "thoughtSignature": "signed-text"}]}, "finishReason": "STOP"}]}),
        ]
    };
    if !fail_generation {
        chunks.push(json!({"usageMetadata": {"promptTokenCount": 4200, "cachedContentTokenCount": 4000, "candidatesTokenCount": 9, "thoughtsTokenCount": 40, "totalTokenCount": 4249}}));
    }
    (
        [(header::CONTENT_TYPE, "text/event-stream")],
        chunks
            .into_iter()
            .map(|chunk| format!("data: {chunk}\n\n"))
            .collect(),
    )
}

#[tokio::test]
async fn discovers_and_routes_gemini_with_native_tool_and_thought_replay() {
    let (_directory, store) = fixtures::temp_store().await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (requests, mut received) = mpsc::unbounded_channel();
    let app = Router::new()
        .route("/edge/v1beta/models", get(discover))
        .route("/edge/v1beta/models/{method}", post(generate))
        .with_state(requests);
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let provider = store
        .create_provider(&ProviderConfigInput {
            icon: None,
            sort_order: 0,
            name: "Gateway".into(),
            base_url: format!("http://{address}/edge"),
            api_key: "test-key".into(),
            custom_headers_enabled: true,
            custom_headers: json!({"x-shared": "test-gateway"}),
        })
        .await
        .unwrap();
    let model = store.create_model(&ModelConfigInput {
        provider_id: provider.provider_id.clone(),
        request_format: RequestFormat::Gemini,
        request_url_override: None,
        extra_params_enabled: true,
        extra_params: json!({"generationConfig": {"thinkingConfig": {"thinkingLevel": "low"}, "topP": 0.9}}),
        sort_order: 0,
        display_name: "Gemini test".into(),
        tooltip_data: "Gemini test".into(),
        model_id: "models/gemini-a".into(),
        reasoning_effort: None,
        context_window_tokens: None,
        max_output_tokens: Some(1024),
        anthropic_thinking_effort: None,
        thinking_budget_tokens: None,
    }).await.unwrap();
    assert_eq!(
        model.request_url().unwrap(),
        format!("http://{address}/edge/v1beta/models/gemini-a:streamGenerateContent?alt=sse")
    );

    let runtime = PluginRuntime::managed().unwrap();
    let plugins = PluginRegistry::managed(store.clone(), runtime.clone(), "test".into()).unwrap();
    let clients = NetworkClients::new(store.clone());
    let provider_router = Arc::new(ProviderRouter::new(
        store.clone(),
        plugins.clone(),
        clients.clone(),
        Duration::from_secs(5),
        Duration::from_secs(5),
    ));
    let control = ControlService::new(
        store.clone(),
        provider_router.clone(),
        runtime,
        plugins,
        clients,
        "test".into(),
    )
    .unwrap();
    assert_eq!(
        control
            .discover_provider_models(
                &provider.provider_id,
                RequestFormat::Gemini,
                Some(&model.request_url().unwrap())
            )
            .await
            .unwrap()
            .models,
        ["gemini-a", "gemini-b"]
    );
    assert_eq!(
        control
            .test_model(&model.model_hash, "gemini-connectivity")
            .await
            .unwrap()
            .output,
        "Done"
    );
    received.try_recv().unwrap();

    let mut spec = ModelSpec::new(model.model_hash.clone());
    spec.reasoning.enabled = true;
    spec.extra_params = json!({"temperature": 0.4, "stop": ["end"], "toolConfig": {"functionCallingConfig": {"streamFunctionCallArguments": true}}});
    let mut request = ModelRequest {
        model: spec,
        prompt: PromptSpec {
            instructions: "system".into(),
            tools: vec![ToolDefinition {
                name: "read_file".into(),
                description: "Read a test file".into(),
                parameters: json!({"type": "object", "properties": {"path": {"type": "string"}}}),
            }],
        },
        history: vec![ProjectedMessage {
            message_id: "user".into(),
            role: Role::User,
            content: ProjectedContent::Parts(vec![
                ContentPart::Text {
                    text: "Read files".into(),
                },
                ContentPart::Image {
                    mime_type: "image/png".into(),
                    data: vec![1, 2, 3],
                },
            ]),
        }],
    };
    let events = provider_router
        .stream(
            invocation("gemini-first", request.clone()),
            CancellationToken::new(),
        )
        .try_collect::<Vec<_>>()
        .await
        .unwrap();
    let first = received.try_recv().unwrap();
    assert_eq!(first["systemInstruction"]["parts"][0]["text"], "system");
    assert_eq!(
        first["toolConfig"]["functionCallingConfig"]["streamFunctionCallArguments"],
        true
    );
    assert_eq!(
        first["contents"][0]["parts"][1]["inlineData"]["data"],
        "AQID"
    );
    assert_eq!(
        first["tools"][0]["functionDeclarations"][0]["parametersJsonSchema"]["properties"]["path"]
            ["type"],
        "string"
    );
    assert_eq!(
        first["generationConfig"],
        json!({
            "maxOutputTokens": 1024, "thinkingConfig": {"thinkingLevel": "low", "includeThoughts": true}, "temperature": 0.4, "topP": 0.9, "stopSequences": ["end"]
        })
    );
    assert!(events.contains(&ModelEvent::ThinkingDelta("Thinking".into())));
    assert!(events.contains(&ModelEvent::TextDelta("Next ".into())));
    assert_eq!(
        events.last(),
        Some(&ModelEvent::Done(FinishReason::ToolUse))
    );
    let replay = events
        .iter()
        .find_map(|event| match event {
            ModelEvent::ProviderReplayState(state) => Some(state.clone()),
            _ => None,
        })
        .unwrap();
    let calls = events
        .iter()
        .filter_map(|event| match event {
            ModelEvent::ToolCallStart {
                index,
                call_id,
                name,
            } => Some(ToolCallContent {
                index: *index,
                call_id: call_id.clone(),
                name: name.clone(),
                arguments: events
                    .iter()
                    .find_map(|event| match event {
                        ModelEvent::ToolCallArgumentsDelta {
                            index: args_index,
                            delta,
                        } if args_index == index => Some(serde_json::from_str(delta).unwrap()),
                        _ => None,
                    })
                    .unwrap(),
            }),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(calls.len(), 2);
    assert_ne!(calls[0].call_id, calls[1].call_id);
    assert!(events.contains(&ModelEvent::ToolCallArgumentsDelta {
        index: 0,
        delta: json!({"path": "a.txt", "options": [{"line.count": 3}, true]}).to_string(),
    }));
    assert_eq!(
        replay.value["parts"][2],
        json!({"functionCall": {"name": "read_file", "id": "native-a", "args": {"path": "a.txt", "options": [{"line.count": 3}, true]}}, "thoughtSignature": "signed-tool"})
    );
    assert_eq!(
        replay.value["parts"][3],
        json!({"text": "", "thoughtSignature": "interleaved-signature"})
    );
    request.history.push(ProjectedMessage {
        message_id: "assistant".into(),
        role: Role::Assistant,
        content: ProjectedContent::Assistant {
            text: "Next step".into(),
            thinking: "Thinking".into(),
            replay_state: Some(replay.clone()),
            calls: calls.clone(),
        },
    });
    for call in calls.iter().rev() {
        request.history.push(ProjectedMessage {
            message_id: format!("tool-{}", call.index),
            role: Role::Tool,
            content: ProjectedContent::ToolResult(ToolResultContent {
                call_id: call.call_id.clone(),
                name: call.name.clone(),
                content: format!("result-{}", call.index),
                is_error: false,
                image: None,
                provider_parts: Vec::new(),
            }),
        });
    }
    let events = provider_router
        .stream(
            invocation("gemini-second", request.clone()),
            CancellationToken::new(),
        )
        .try_collect::<Vec<_>>()
        .await
        .unwrap();
    let second = received.try_recv().unwrap();
    assert_eq!(second["contents"][0], first["contents"][0]);
    assert_eq!(second["systemInstruction"], first["systemInstruction"]);
    assert_eq!(second["tools"], first["tools"]);
    assert_eq!(second["contents"][1]["parts"], replay.value["parts"]);
    let parts = second["contents"][1]["parts"].as_array().unwrap();
    assert_eq!(parts[1], json!({"text": "Next step"}));
    assert_eq!(parts[2]["thoughtSignature"], "signed-tool");
    assert_eq!(
        second["contents"][2],
        json!({"role": "user", "parts": [
            {"functionResponse": {"id": "native-a", "name": "read_file", "response": {"output": "result-0"}}},
            {"functionResponse": {"name": "read_file", "response": {"output": "result-1"}}}
        ]})
    );
    assert_eq!(events.last(), Some(&ModelEvent::Done(FinishReason::Stop)));
    assert!(events.iter().any(|event| matches!(event, ModelEvent::ProviderReplayState(state) if state.value["parts"][1]["thoughtSignature"] == "signed-text")));
    let stored = store.llm_call("gemini-second").await.unwrap().unwrap();
    assert_eq!(stored.request_type, "gemini");
    assert_eq!(stored.request_url, model.request_url().unwrap());
    assert_eq!(
        stored.endpoint_key,
        Some(format!("http://{address}/edge/v1beta/models"))
    );
    assert_eq!(stored.output_tokens, Some(49));
    assert_eq!(stored.cache_read_tokens, Some(4000));
    assert_eq!(stored.reasoning_tokens, Some(40));

    request.history.truncate(1);
    request.history[0].content = ProjectedContent::Parts(vec![ContentPart::Text {
        text: "fail-generation".into(),
    }]);
    let events = provider_router
        .stream(
            invocation("gemini-failure", request),
            CancellationToken::new(),
        )
        .collect::<Vec<_>>()
        .await;
    assert!(events
        .iter()
        .filter_map(|event| event.as_ref().ok())
        .all(|event| !matches!(
            event,
            ModelEvent::ToolCallStart { .. } | ModelEvent::Done(_)
        )));
    let error = events.into_iter().last().unwrap().unwrap_err();
    assert!(
        matches!(error, cursor_server::Error::Upstream { status: Some(200), code: Some(code), message } if code == "MALFORMED_RESPONSE" && message.contains("Could not produce an answer"))
    );
    let stored = store.llm_call("gemini-failure").await.unwrap().unwrap();
    assert_eq!(stored.http_status, Some(200));
    assert_eq!(stored.input_tokens, Some(4200));
    assert_eq!(stored.cache_read_tokens, Some(4000));
    assert_eq!(stored.reasoning_tokens, Some(40));
    assert_eq!(stored.total_tokens, Some(4240));
    server.abort();
}

fn invocation(id: &str, request: ModelRequest) -> ModelInvocation {
    ModelInvocation {
        call_id: id.into(),
        run_id: "gemini-run".into(),
        conversation_id: "conversation".into(),
        provider_call_index: 0,
        origin: CallOrigin::Run,
        request,
    }
}

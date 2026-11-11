//! Verifies that call records describe the effective model request sent upstream.
#[path = "support/fixtures.rs"]
mod fixtures;

use std::time::Duration;

use axum::{
    extract::State,
    http::{header, Uri},
    Json, Router,
};
use cursor_server::{
    model::{
        CallOrigin, ModelConfigInput, ModelInvocation, ModelRequest, ModelSpec, ModelType,
        PromptSpec, OPENAI_CHAT_ENDPOINT, OPENAI_RESPONSES_ENDPOINT,
    },
    network::NetworkClients,
    plugin::{PluginRegistry, PluginRuntime},
    provider::{Provider, ProviderRouter},
};
use futures_util::StreamExt;
use serde_json::{json, Value};
use tokio::{net::TcpListener, sync::mpsc};
use tokio_util::sync::CancellationToken;

async fn upstream(
    State(requests): State<mpsc::UnboundedSender<Value>>,
    uri: Uri,
    Json(body): Json<Value>,
) -> ([(header::HeaderName, &'static str); 1], String) {
    requests.send(body).unwrap();
    let events = match uri.path() {
        "/v1/messages" => vec![
            json!({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
            json!({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "ok"}}),
            json!({"type": "message_delta", "delta": {"stop_reason": "end_turn"}}),
            json!({"type": "message_stop"}),
        ],
        "/v1/responses" => vec![
            json!({"type": "response.output_text.delta", "delta": "ok"}),
            json!({"type": "response.completed", "response": {"status": "completed"}}),
        ],
        "/v1/chat/completions" => vec![
            json!({"choices": [{"index": 0, "delta": {"content": "ok"}, "finish_reason": "stop"}]}),
        ],
        path => panic!("unexpected upstream path: {path}"),
    };
    let body = events
        .into_iter()
        .map(|event| format!("data: {event}\n\n"))
        .collect::<String>();
    ([(header::CONTENT_TYPE, "text/event-stream")], body)
}

#[tokio::test]
async fn recorded_reasoning_effort_matches_the_effective_request() {
    let (_directory, store) = fixtures::temp_store().await;
    let (requests, mut received) = mpsc::unbounded_channel();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = Router::new().fallback(upstream).with_state(requests);
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let plugins = PluginRegistry::managed(
        store.clone(),
        PluginRuntime::managed().unwrap(),
        "0.1.0".into(),
    )
    .unwrap();
    let router = ProviderRouter::new(
        store.clone(),
        plugins,
        NetworkClients::new(store.clone()),
        Duration::from_secs(5),
        Duration::from_secs(5),
    );

    for (model_type, endpoint, effort_pointer) in [
        (ModelType::Anthropic, "", "/output_config/effort"),
        (ModelType::OpenAi, OPENAI_CHAT_ENDPOINT, "/reasoning_effort"),
        (
            ModelType::OpenAi,
            OPENAI_RESPONSES_ENDPOINT,
            "/reasoning/effort",
        ),
    ] {
        for (configured, requested, expected) in [
            (Some("medium"), None, Some("medium")),
            (Some("medium"), Some("high"), Some("high")),
            (None, None, None),
        ] {
            // Anthropic configurations always receive a default effort during normalization.
            if model_type == ModelType::Anthropic && configured.is_none() {
                continue;
            }
            let input = ModelConfigInput {
                sort_order: 0,
                display_name: "Test Model".into(),
                group_name: None,
                model_type,
                base_url: format!("http://{address}"),
                use_full_url: false,
                api_key: "test-key".into(),
                tooltip_data: "Test Model".into(),
                model_id: uuid::Uuid::new_v4().to_string(),
                reasoning_effort: configured.map(str::to_owned),
                openai_endpoint: endpoint.into(),
                openai_extra_params_enabled: false,
                openai_extra_params: json!({}),
                custom_headers_enabled: false,
                custom_headers: json!({}),
                anthropic_extra_params_enabled: false,
                anthropic_extra_params: json!({}),
                context_window_tokens: None,
                max_completion_tokens: None,
                anthropic_max_tokens: None,
                anthropic_thinking_effort: configured.map(str::to_owned),
                thinking_budget_tokens: None,
            };
            let configured_model = store.create_model(&input).await.unwrap();
            let mut model = ModelSpec::new(&configured_model.model_hash);
            model.reasoning.effort = requested.map(str::to_owned);
            let call_id = uuid::Uuid::new_v4().to_string();
            let invocation = ModelInvocation {
                call_id: call_id.clone(),
                run_id: "run".into(),
                conversation_id: "conversation".into(),
                provider_call_index: 0,
                origin: CallOrigin::Run,
                request: ModelRequest {
                    prompt: PromptSpec {
                        instructions: String::new(),
                        tools: Vec::new(),
                    },
                    model,
                    history: Vec::new(),
                },
            };
            let mut stream = router.stream(invocation, CancellationToken::new());
            while let Some(event) = stream.next().await {
                event.unwrap();
            }
            let body = received.try_recv().unwrap();
            let sent_effort = body.pointer(effort_pointer).and_then(Value::as_str);
            assert_eq!(
                sent_effort, expected,
                "upstream request for {model_type:?} {endpoint}"
            );
            let call = store.llm_call(&call_id).await.unwrap().unwrap();
            assert_eq!(
                call.reasoning_effort.as_deref(),
                sent_effort,
                "recorded effort for {model_type:?} {endpoint}"
            );
        }
    }
    server.abort();
}

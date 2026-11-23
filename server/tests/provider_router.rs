//! Verifies that call records describe the effective model request sent upstream.
#[path = "support/fixtures.rs"]
mod fixtures;

use std::{sync::Arc, time::Duration};

use axum::{
    extract::State,
    http::{header, HeaderMap, Uri},
    Json, Router,
};
use cursor_server::{
    control::ControlService,
    model::{
        CallOrigin, ModelConfigInput, ModelInvocation, ModelRequest, ModelSpec, RequestFormat,
        PromptSpec, ProviderConfigInput,
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
    State(requests): State<mpsc::UnboundedSender<(Uri, HeaderMap, Value)>>,
    uri: Uri,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> ([(header::HeaderName, &'static str); 1], String) {
    requests.send((uri.clone(), headers, body)).unwrap();
    let events = match uri.path() {
        "/v1/messages" => vec![
            json!({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
            json!({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "ok"}}),
            json!({"type": "message_delta", "delta": {"stop_reason": "end_turn"}}),
            json!({"type": "message_stop"}),
        ],
        "/relay/v2/responses" => vec![
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

async fn discover(uri: Uri, headers: HeaderMap) -> Json<Value>
{
    assert_eq!(headers["x-shared"], "gateway");
    let id = if headers.contains_key("x-api-key")
    {
        assert_eq!(headers["x-api-key"], "test-key");
        "anthropic-model"
    }
    else
    {
        assert_eq!(headers["authorization"], "Bearer test-key");
        if uri.path() == "/relay/v2/models" { "responses-model" } else { "openai-model" }
    };
    Json(json!({"data": [{"id": id}]}))
}

#[tokio::test]
async fn recorded_reasoning_effort_matches_the_effective_request() {
    let (_directory, store) = fixtures::temp_store().await;
    let (requests, mut received) = mpsc::unbounded_channel();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = Router::new().route("/v1/models", axum::routing::get(discover)).route("/relay/v2/models", axum::routing::get(discover)).fallback(upstream).with_state(requests);
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let runtime = PluginRuntime::managed().unwrap();
    let plugins = PluginRegistry::managed(
        store.clone(),
        runtime.clone(),
        "0.1.0".into(),
    )
    .unwrap();
    let clients = NetworkClients::new(store.clone());
    let router = Arc::new(ProviderRouter::new(
        store.clone(),
        plugins.clone(),
        clients.clone(),
        Duration::from_secs(5),
        Duration::from_secs(5),
    ));
    let control = ControlService::new(store.clone(), router.clone(), runtime, plugins, clients, "test".into()).unwrap();
    let provider_cfg = store.create_provider(&ProviderConfigInput {
        sort_order: 0,
        name: "Shared gateway".into(),
        base_url: format!("http://{address}"),
        api_key: "test-key".into(),
        custom_headers_enabled: true,
        custom_headers: json!({"x-shared": "gateway"}),
    }).await.unwrap();

    for (request_format, effort_pointer) in [
        (RequestFormat::Anthropic, "/output_config/effort"),
        (RequestFormat::OpenAiChat, "/reasoning_effort"),
        (
            RequestFormat::OpenAiResponses,
            "/reasoning/effort",
        ),
    ] {
        for (configured, requested, expected) in [
            (Some("medium"), None, Some("medium")),
            (Some("medium"), Some("high"), Some("high")),
            (None, None, None),
        ] {
            // Anthropic configurations always receive a default effort during normalization.
            if request_format == RequestFormat::Anthropic && configured.is_none() {
                continue;
            }
            let input = ModelConfigInput {
                provider_id: provider_cfg.provider_id.clone(),
                request_format,
                request_url_override: (request_format == RequestFormat::OpenAiResponses).then(|| format!("http://{address}/relay/v2/responses?channel=direct")),
                extra_params_enabled: configured.is_some(),
                extra_params: json!({"top_p": 0.8}),
                sort_order: 0,
                display_name: "Test Model".into(),
                tooltip_data: "Test Model".into(),
                model_id: uuid::Uuid::new_v4().to_string(),
                reasoning_effort: configured.map(str::to_owned),
                context_window_tokens: None,
                max_output_tokens: None,
                anthropic_thinking_effort: configured.map(str::to_owned),
                thinking_budget_tokens: None,
            };
            let configured_model = store.create_model(&input).await.unwrap();
            if requested.is_none() && configured.is_some()
            {
                let models = control.discover_provider_models(&provider_cfg.provider_id, request_format, input.request_url_override.as_deref()).await.unwrap().models;
                assert_eq!(models, [match request_format
                {
                    RequestFormat::Gemini => unreachable!("tested separately"),
                    RequestFormat::OpenAiChat => "openai-model",
                    RequestFormat::OpenAiResponses => "responses-model",
                    RequestFormat::Anthropic => "anthropic-model",
                }]);
                let result = control.test_model(&configured_model.model_hash, &uuid::Uuid::new_v4().to_string()).await.unwrap();
                assert_eq!(result.output, "ok");
                assert_eq!(received.try_recv().unwrap().2["model"], configured_model.model_id);
            }
            let mut model = ModelSpec::new(&configured_model.model_hash);
            model.extra_params = json!({"temperature": 0.25, "stop": ["done"]});
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
            let (uri, headers, body) = received.try_recv().unwrap();
            assert_eq!(headers["x-shared"], "gateway");
            match request_format
            {
                RequestFormat::Gemini => unreachable!("tested separately"),
                RequestFormat::OpenAiChat =>
                {
                    assert_eq!(uri.path(), "/v1/chat/completions");
                    assert_eq!(headers["authorization"], "Bearer test-key");
                    assert!(body["messages"].is_array());
                }
                RequestFormat::OpenAiResponses =>
                {
                    assert_eq!(uri.to_string(), "/relay/v2/responses?channel=direct");
                    assert_eq!(headers["authorization"], "Bearer test-key");
                    assert!(body["input"].is_array());
                }
                RequestFormat::Anthropic =>
                {
                    assert_eq!(uri.path(), "/v1/messages");
                    assert_eq!(headers["x-api-key"], "test-key");
                    assert!(body["messages"].is_array());
                }
            }
            assert_eq!(body["temperature"], 0.25);
            assert_eq!(body["top_p"].as_f64(), configured.map(|_| 0.8));
            assert_eq!(
                body[if request_format == RequestFormat::Anthropic {
                    "stop_sequences"
                } else {
                    "stop"
                }],
                json!(["done"])
            );
            let sent_effort = body.pointer(effort_pointer).and_then(Value::as_str);
            assert_eq!(
                sent_effort, expected,
                "upstream request for {request_format:?}"
            );
            let call = store.llm_call(&call_id).await.unwrap().unwrap();
            assert_eq!(call.request_type, request_format.as_str());
            assert_eq!(call.request_url, configured_model.request_url().unwrap());
            assert_eq!(
                call.reasoning_effort.as_deref(),
                sent_effort,
                "recorded effort for {request_format:?}"
            );
        }
    }
    server.abort();
}

#[tokio::test]
async fn incomplete_responses_keep_usage_and_replay() {
    use cursor_server::{
        config::{ProviderConfig, ProviderKind},
        provider::{FinishReason, ModelEvent, OpenAiResponsesProvider},
    };
    let app = Router::new().fallback(|| async
    {
        ([(header::CONTENT_TYPE, "text/event-stream")], "data: {\"type\":\"response.output_item.done\",\"item\":{\"type\":\"reasoning\",\"id\":\"reasoning-id\",\"encrypted_content\":\"opaque\"}}\n\ndata: {\"type\":\"response.incomplete\",\"response\":{\"usage\":{\"input_tokens\":100,\"output_tokens\":20,\"output_tokens_details\":{\"reasoning_tokens\":10}}}}\n\n")
    });
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let provider = OpenAiResponsesProvider::new(
        reqwest::Client::new(),
        ProviderConfig {
            kind: ProviderKind::OpenAiResponses,
            request_url: format!("http://{address}/v1/responses"),
            api_key: "test-key".into(),
            custom_headers: Default::default(),
            max_output_tokens: None,
            request_timeout: Duration::from_secs(5),
            allowed_body_fields: None,
        },
    );
    let invocation = ModelInvocation {
        call_id: "call".into(),
        run_id: "run".into(),
        conversation_id: "conversation".into(),
        provider_call_index: 0,
        origin: CallOrigin::Run,
        request: ModelRequest {
            prompt: PromptSpec {
                instructions: String::new(),
                tools: Vec::new(),
            },
            model: ModelSpec::new("test"),
            history: Vec::new(),
        },
    };
    let mut stream = provider.stream(invocation, CancellationToken::new());
    let mut usage = None;
    let mut replay = None;
    let mut endings = 0;
    while let Some(event) = stream.next().await {
        match event.unwrap() {
            ModelEvent::Usage(value) => usage = Some(value),
            ModelEvent::ProviderReplayState(value) => replay = Some(value),
            ModelEvent::Done(reason) => {
                assert_eq!(reason, FinishReason::Length);
                endings += 1;
            }
            _ => {}
        }
    }
    let usage = usage.expect("missing terminal usage");
    assert_eq!(usage.input_tokens, Some(100));
    assert_eq!(usage.reasoning_tokens, Some(10));
    assert_eq!(
        replay.unwrap().value["items"][0]["encrypted_content"],
        "opaque"
    );
    assert_eq!(endings, 1);
    server.abort();
}

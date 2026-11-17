//! Verifies timing and unchanged response bytes through native protocol forwarding.
#[path = "support/fake_provider.rs"]
mod fake_provider;
#[path = "support/fixtures.rs"]
mod fixtures;

use std::{convert::Infallible, sync::Arc, time::Duration};

use axum::{
    body::{to_bytes, Body, Bytes},
    http::{header, Request, StatusCode},
    Router,
};
use cursor_server::{
    api::byok,
    model::{
        ModelConfigInput, ModelType, ProviderConfigInput, SpeedStatus, OPENAI_CHAT_ENDPOINT,
        OPENAI_RESPONSES_ENDPOINT,
    },
    network::NetworkClients,
    plugin::{PluginRegistry, PluginRuntime},
    store::{ExternalApiSettings, LlmCallFilter},
};
use serde_json::json;
use tower::ServiceExt;

async fn native_stream(protocol: &str, thinking_first: bool) {
    let (model_type, endpoint, path, thinking, first, last, usage) = match protocol {
        "chat" => (
            ModelType::OpenAi,
            OPENAI_CHAT_ENDPOINT,
            "/byok/v1/chat/completions",
            json!({"choices":[{"delta":{"reasoning_content":"summary"}}]}),
            json!({"choices":[{"delta":{"content":"first "}}]}),
            json!({"choices":[{"delta":{"content":"last"}}]}),
            json!({"choices":[],"usage":{"completion_tokens":401,"completion_tokens_details":{"reasoning_tokens":300}}}),
        ),
        "responses" => (
            ModelType::OpenAi,
            OPENAI_RESPONSES_ENDPOINT,
            "/byok/v1/responses",
            json!({"type":"response.reasoning_summary_text.delta","delta":"summary"}),
            json!({"type":"response.output_text.delta","delta":"first "}),
            json!({"type":"response.output_text.delta","delta":"last"}),
            json!({"type":"response.completed","response":{"usage":{"output_tokens":401,"output_tokens_details":{"reasoning_tokens":300}}}}),
        ),
        "messages" => (
            ModelType::Anthropic,
            "",
            "/byok/v1/messages",
            json!({"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"summary"}}),
            json!({"type":"content_block_delta","delta":{"type":"text_delta","text":"first "}}),
            json!({"type":"content_block_delta","delta":{"type":"text_delta","text":"last"}}),
            json!({"type":"message_delta","usage":{"output_tokens":401,"output_tokens_details":{"thinking_tokens":300}}}),
        ),
        _ => unreachable!(),
    };
    let mut events = Vec::new();
    if thinking_first {
        events.push((0, thinking.clone()));
    }
    events.push((0, first));
    if !thinking_first {
        events.push((0, thinking));
    }
    events.push((250, last));
    events.push((250, usage));
    let expected = events
        .iter()
        .map(|(_, event)| format!("data: {event}\n\n"))
        .collect::<String>();
    let events = Arc::new(events);
    let upstream = Router::new().fallback(move || {
        let events = events.clone();
        async move {
            let body = Body::from_stream(async_stream::stream! {
                for (delay_ms, event) in events.iter()
                {
                    tokio::time::sleep(Duration::from_millis(*delay_ms)).await;
                    yield Ok::<_, Infallible>(Bytes::from(format!("data: {event}\n\n")));
                }
            });
            ([(header::CONTENT_TYPE, "text/event-stream")], body)
        }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, upstream).await.unwrap();
    });
    let (_directory, store) = fixtures::temp_store().await;
    store
        .set_external_api_settings(ExternalApiSettings {
            enabled: true,
            api_key: "test-secret".into(),
        })
        .await
        .unwrap();
    let provider = store
        .create_provider(&ProviderConfigInput {
            sort_order: 0,
            name: protocol.into(),
            model_type,
            base_url: format!("http://{address}"),
            use_full_url: false,
            api_key: "test-key".into(),
            openai_endpoint: endpoint.into(),
            custom_headers_enabled: false,
            custom_headers: json!({}),
            extra_params_enabled: false,
            extra_params: json!({}),
        })
        .await
        .unwrap();
    store
        .create_model(&ModelConfigInput {
            provider_id: provider.provider_id,
            sort_order: 0,
            display_name: "Test model".into(),
            tooltip_data: "test".into(),
            model_id: "test-model".into(),
            reasoning_effort: None,
            context_window_tokens: None,
            max_output_tokens: Some(1024),
            anthropic_thinking_effort: None,
            thinking_budget_tokens: None,
        })
        .await
        .unwrap();
    let runtime = PluginRuntime::managed().unwrap();
    let plugins = PluginRegistry::managed(store.clone(), runtime, "test".into()).unwrap();
    let native = byok::NativeForwarder::new(
        store.clone(),
        NetworkClients::new(store.clone()),
        Duration::from_secs(10),
        Duration::from_secs(10),
    );
    let router = byok::router(
        store.clone(),
        plugins,
        Arc::new(fake_provider::FakeProvider::default()),
        Some(native),
    );
    let request = Request::builder()
        .method("POST")
        .uri(path)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::AUTHORIZATION, "Bearer test-secret")
        .body(Body::from(
            json!({"model":format!("{protocol}/test-model"),"stream":true}).to_string(),
        ))
        .unwrap();
    let response = router.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    server.abort();
    assert_eq!(body.as_ref(), expected.as_bytes());
    let calls = store
        .llm_calls(&LlmCallFilter::with_limit(10))
        .await
        .unwrap();
    assert_eq!(calls.len(), 1);
    let call = &calls[0];
    assert!(call.observed_thinking);
    assert_eq!(call.generation_output_events, Some(2));
    let generation_ms = call.generation_ms.unwrap();
    assert!(generation_ms >= 200);
    assert!(call.duration_ms.unwrap() - generation_ms >= 200);
    assert_eq!(call.performance.speed_status, SpeedStatus::Estimated);
    assert_eq!(
        call.performance.tokens_per_second,
        Some(100_000.0 / generation_ms as f64)
    );
}

#[tokio::test]
async fn native_chat_records_all_visible_output_before_and_after_thinking() {
    native_stream("chat", false).await;
    native_stream("chat", true).await;
}

#[tokio::test]
async fn native_responses_record_all_visible_output_before_and_after_thinking() {
    native_stream("responses", false).await;
    native_stream("responses", true).await;
}

#[tokio::test]
async fn native_messages_record_all_visible_output_before_and_after_thinking() {
    native_stream("messages", false).await;
    native_stream("messages", true).await;
}

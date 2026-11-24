//! Verifies model-test speed through the real HTTP provider and persisted call record.
#[path = "support/fixtures.rs"]
mod fixtures;

use std::{convert::Infallible, sync::Arc, time::Duration};

use axum::{
    body::{Body, Bytes},
    http::header,
    Router,
};
use cursor_server::{
    control::{ControlService, ModelConnectivityResult},
    model::{
        LlmCallSummary, ModelConfigInput, ProviderConfigInput, RequestFormat, SpeedStatus,
        SpeedUnavailableReason,
    },
    network::NetworkClients,
    plugin::{PluginRegistry, PluginRuntime},
    provider::ProviderRouter,
    store::LlmCallFilter,
};

async fn model_test(events: Vec<(u64, &'static str)>) -> (ModelConnectivityResult, LlmCallSummary) {
    let (_directory, store) = fixtures::temp_store().await;
    let events = Arc::new(events);
    let upstream = Router::new().fallback(move || {
        let events = events.clone();
        async move {
            let body = Body::from_stream(async_stream::stream! {
                for (delay_ms, payload) in events.iter()
                {
                    tokio::time::sleep(Duration::from_millis(*delay_ms)).await;
                    yield Ok::<_, Infallible>(Bytes::from(format!("data: {payload}\n\n")));
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
    let provider = store
        .create_provider(&ProviderConfigInput {
            icon: None,
            sort_order: 0,
            name: "test-provider".into(),
            base_url: format!("http://{address}"),
            api_key: "test-key".into(),
            custom_headers_enabled: false,
            custom_headers: serde_json::json!({}),
        })
        .await
        .unwrap();
    let model = store
        .create_model(&ModelConfigInput {
            provider_id: provider.provider_id,
            request_format: RequestFormat::OpenAiResponses,
            request_url_override: None,
            extra_params_enabled: false,
            extra_params: serde_json::json!({}),
            sort_order: 0,
            display_name: "Test model".into(),
            tooltip_data: "Test model".into(),
            model_id: "test-model".into(),
            reasoning_effort: Some("low".into()),
            context_window_tokens: None,
            max_output_tokens: Some(1_024),
            anthropic_thinking_effort: None,
            thinking_budget_tokens: None,
        })
        .await
        .unwrap();
    let clients = NetworkClients::new(store.clone());
    let runtime = PluginRuntime::managed().unwrap();
    let plugins = PluginRegistry::managed(store.clone(), runtime.clone(), "test".into()).unwrap();
    let router = ProviderRouter::new(
        store.clone(),
        plugins.clone(),
        clients.clone(),
        Duration::from_secs(10),
        Duration::from_secs(10),
    );
    let control = ControlService::new(
        store.clone(),
        Arc::new(router),
        runtime,
        plugins,
        clients,
        "test".into(),
    )
    .unwrap();
    let result = control.test_model(&model.model_hash, "speed-test").await;
    server.abort();
    let result = result.unwrap();
    let mut calls = store
        .llm_calls(&LlmCallFilter::with_limit(10))
        .await
        .unwrap();
    assert_eq!(calls.len(), 1);
    (result, calls.remove(0))
}

#[tokio::test]
async fn missing_usage_does_not_turn_words_or_chinese_text_into_tokens() {
    let (result, record) = model_test(vec![
        (
            0,
            r#"{"type":"response.output_text.delta","delta":"第一段"}"#,
        ),
        (
            250,
            r#"{"type":"response.output_text.delta","delta":"第二段"}"#,
        ),
        (
            0,
            r#"{"type":"response.completed","response":{"status":"completed"}}"#,
        ),
    ])
    .await;
    assert_eq!(result.output, "第一段第二段");
    assert_eq!(result.output_tokens, None);
    assert_eq!(result.tokens_per_second, None);
    assert_eq!(result.overall_tokens_per_second, None);
    assert_eq!(
        result.overall_reason,
        Some(SpeedUnavailableReason::MissingOutputTokens)
    );
    assert_eq!(
        result.speed_reason,
        Some(SpeedUnavailableReason::MissingOutputTokens)
    );
    assert_eq!(record.generation_output_events, Some(2));
    assert_eq!(
        result.tokens_per_second,
        record.performance.tokens_per_second
    );
}

#[tokio::test]
async fn reasoning_summary_speed_uses_visible_tokens_and_excludes_terminal_delay() {
    let (result, record) = model_test(vec![
        (0, r#"{"type":"response.reasoning_summary_text.delta","delta":"summary"}"#),
        (250, r#"{"type":"response.output_text.delta","delta":"first "}"#),
        (250, r#"{"type":"response.output_text.delta","delta":"last"}"#),
        (500, r#"{"type":"response.completed","response":{"status":"completed","usage":{"output_tokens":401,"output_tokens_details":{"reasoning_tokens":300}}}}"#),
    ]).await;
    assert!(record.observed_thinking);
    assert_eq!(record.generation_output_events, Some(2));
    assert_eq!(result.output_tokens, Some(401));
    assert_eq!(result.speed_status, SpeedStatus::Estimated);
    assert_eq!(
        result.overall_tokens_per_second,
        record.performance.overall_tokens_per_second
    );
    assert_eq!(result.overall_reason, None);
    let generation_ms = result.generation_ms.unwrap();
    assert!(result.duration_ms - generation_ms >= 700);
    assert_eq!(
        result.tokens_per_second,
        Some(100_000.0 / generation_ms as f64)
    );
    assert_eq!(
        result.tokens_per_second,
        record.performance.tokens_per_second
    );
}

#[tokio::test]
async fn buffered_output_is_not_a_generation_sample_even_after_a_long_tail() {
    let (result, record) = model_test(vec![
        (0, r#"{"type":"response.output_text.delta","delta":"all output at once"}"#),
        (250, r#"{"type":"response.completed","response":{"status":"completed","usage":{"output_tokens":120}}}"#),
    ]).await;
    assert_eq!(record.generation_output_events, Some(1));
    assert_eq!(result.generation_ms, Some(0));
    assert_eq!(result.tokens_per_second, None);
    assert_eq!(
        result.speed_reason,
        Some(SpeedUnavailableReason::InsufficientOutputEvents)
    );
    assert!(record.performance.overall_tokens_per_second.is_some());
    assert_eq!(
        result.overall_tokens_per_second,
        record.performance.overall_tokens_per_second
    );
}

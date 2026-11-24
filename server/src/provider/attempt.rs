//! Sends one Provider HTTP attempt without applying retry policy.

use tokio_util::sync::CancellationToken;

use crate::{Error, Result};

use super::CallRecorder;

#[derive(Debug)]
pub(crate) enum Attempt {
    Response(reqwest::Response),
    Cancelled,
}

pub(crate) async fn send_once<F>(
    label: &str,
    build: F,
    cancellation: &CancellationToken,
    recorder: Option<&CallRecorder>,
) -> Result<Attempt>
where
    F: FnOnce() -> reqwest::RequestBuilder,
{
    let request = build();
    if let Some(recorder) = recorder {
        recorder.mark_request_sent().await;
    }
    let response = tokio::select! {
        _ = cancellation.cancelled() => return Ok(Attempt::Cancelled),
        response = request.send() => response,
    }?;
    if let Some(recorder) = recorder {
        recorder
            .response_headers(response.status().as_u16())
            .await?;
    }
    if response.status().is_success() {
        return Ok(Attempt::Response(response));
    }
    let status = response.status();
    let bytes = tokio::select! {
        _ = cancellation.cancelled() => return Ok(Attempt::Cancelled),
        bytes = response.bytes() => bytes,
    }?;
    let payload = serde_json::from_slice::<serde_json::Value>(&bytes).unwrap_or_default();
    Err(Error::Upstream {
        status: Some(status.as_u16()),
        code: payload
            .pointer("/error/code")
            .or_else(|| payload.pointer("/error/type"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        message: payload
            .pointer("/error/message")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| format!("{label}: {}", String::from_utf8_lossy(&bytes))),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn server(response: &'static [u8]) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 1024];
            let _ = socket.read(&mut request).await;
            socket.write_all(response).await.unwrap();
        });
        format!("http://{address}")
    }

    #[tokio::test]
    async fn non_success_status_is_one_failed_attempt() {
        let url =
            server(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 4\r\n\r\ndown").await;
        let client = reqwest::Client::new();
        let error = send_once("test", || client.get(&url), &CancellationToken::new(), None)
            .await
            .unwrap_err();
        assert!(
            matches!(error, Error::Upstream { status: Some(503), message, .. } if message.contains("down"))
        );
    }

    #[tokio::test]
    async fn response_body_transport_failure_is_one_failed_attempt() {
        let url =
            server(b"HTTP/1.1 500 Internal Server Error\r\nContent-Length: 100\r\n\r\nshort").await;
        let client = reqwest::Client::new();
        let error = send_once("test", || client.get(&url), &CancellationToken::new(), None)
            .await
            .unwrap_err();
        assert!(matches!(error, Error::Http(_)));
    }

    #[tokio::test]
    async fn request_transport_failure_is_one_failed_attempt() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        let url = format!("http://{address}");
        let client = reqwest::Client::new();
        let error = send_once("test", || client.get(&url), &CancellationToken::new(), None)
            .await
            .unwrap_err();
        assert!(matches!(error, Error::Http(_)));
    }

    #[tokio::test]
    async fn send_once_marks_request_sent_before_http_send() {
        use crate::{
            model::{
                CallOrigin, ModelConfigInput, NewLlmCall, ProviderConfigInput, ProviderType,
                RequestFormat,
            },
            provider::FinishReason,
            store::Store,
        };

        let directory = tempfile::tempdir().unwrap();
        let store = Store::connect(&format!(
            "sqlite://{}",
            directory.path().join("test.db").display()
        ))
        .await
        .unwrap();
        let provider = store
            .create_provider(&ProviderConfigInput {
                icon: None,
                sort_order: 0,
                name: "example.com".into(),
                base_url: "https://example.com/v1".into(),
                api_key: "test-key".into(),
                custom_headers_enabled: false,
                custom_headers: serde_json::json!({}),
            })
            .await
            .unwrap();
        let model = store
            .create_model(&ModelConfigInput {
                provider_id: provider.provider_id,
                request_format: RequestFormat::OpenAiChat,
                request_url_override: None,
                extra_params_enabled: false,
                extra_params: serde_json::json!({}),
                sort_order: 0,
                display_name: "Test Model".into(),
                tooltip_data: "Test Model".into(),
                model_id: "test-model".into(),
                reasoning_effort: None,
                context_window_tokens: None,
                max_output_tokens: None,
                anthropic_thinking_effort: None,
                thinking_budget_tokens: None,
            })
            .await
            .unwrap();
        let recorder = CallRecorder::start(
            store.clone(),
            NewLlmCall {
                call_id: "attempt-send-once".into(),
                run_id: "run".into(),
                conversation_id: "conversation".into(),
                provider_call_index: 0,
                model_hash: model.model_hash,
                provider_type: ProviderType::OpenAiChat,
                provider_url: "https://example.com".into(),
                request_type: ProviderType::OpenAiChat,
                request_url: "https://example.com/v1/chat/completions".into(),
                model_id: "test-model".into(),
                display_name: "Test Model".into(),
                reasoning_effort: None,
                fast: false,
                message_count: 1,
                tool_count: 0,
                detailed: false,
                origin: CallOrigin::Run,
                streaming: true,
            },
        )
        .await
        .unwrap();

        let test_start = std::time::Instant::now();
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let pre_send_ms = test_start.elapsed().as_millis() as i64;
        let send_window_start = std::time::Instant::now();
        let url = server(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok").await;
        let client = reqwest::Client::new();
        let attempt = send_once(
            "test",
            || client.get(&url),
            &CancellationToken::new(),
            Some(&recorder),
        )
        .await
        .unwrap();
        let send_window_ms = send_window_start.elapsed().as_millis() as i64;
        assert!(matches!(attempt, Attempt::Response(_)));
        recorder.completed(FinishReason::Stop).await.unwrap();

        let call = store.llm_call("attempt-send-once").await.unwrap().unwrap();
        let ttfb = call.ttfb_ms.unwrap();
        assert!(
            ttfb <= send_window_ms && ttfb < pre_send_ms,
            "ttfb_ms={ttfb} exceeded send_window_ms={send_window_ms} (pre_send_ms={pre_send_ms})"
        );
    }
}

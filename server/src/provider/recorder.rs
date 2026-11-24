//! Records provider requests, responses, usage, and timing.
use std::{
    sync::{
        atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering},
        Arc, OnceLock,
    },
    time::Instant,
};

use tokio::sync::Mutex;

use crate::{
    model::{NewLlmCall, Usage},
    store::{BufferedLlmChunk, CallFinish, Store},
    Result,
};

use super::{is_valid_response_event, FinishReason, ModelEvent};

pub(crate) fn recorded_headers(
    config: &crate::config::ProviderConfig,
    defaults: &[(&str, &str)],
) -> serde_json::Value {
    let mut output = serde_json::Map::new();
    for (name, value) in defaults {
        output.insert((*name).into(), (*value).into());
    }
    for (name, value) in &config.custom_headers {
        if crate::model::is_sensitive_header(name.as_str()) {
            continue;
        }
        if let Ok(value) = value.to_str() {
            output.insert(name.as_str().into(), value.into());
        }
    }
    serde_json::Value::Object(output)
}

#[derive(Clone)]
pub struct CallRecorder {
    inner: Arc<Inner>,
}

pub(crate) struct CancelOnDrop {
    recorder: CallRecorder,
}

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        if self.recorder.is_finished() {
            return;
        }
        let recorder = self.recorder.clone();
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            tracing::warn!(
                call_id = recorder.call_id(),
                "unfinished LLM call dropped outside Tokio runtime"
            );
            return;
        };
        runtime.spawn(async move {
            if let Err(error) = recorder.cancelled().await {
                tracing::warn!(call_id = recorder.call_id(), %error, "failed to mark dropped LLM call cancelled");
            }
        });
    }
}

struct Inner {
    store: Store,
    base_call: NewLlmCall,
    detailed: bool,
    started: Instant,
    request_sent: OnceLock<Instant>,
    stream_ended: std::sync::Mutex<Option<StreamEnded>>,
    attempt: Mutex<AttemptState>,
    next_generation: AtomicU64,
    finished: AtomicBool,
}

#[derive(Clone, Copy)]
struct StreamEnded {
    at: Instant,
    explicit: bool,
}

struct AttemptState {
    call_id: String,
    next_chunk: AtomicI64,
    chunks: ChunkBuffer,
    first_text_recorded: AtomicBool,
    first_valid_response_recorded: AtomicBool,
    first_output_recorded: AtomicBool,
    generation_started: Option<Instant>,
    generation_ended: Option<Instant>,
    generation_output_events: i64,
    thinking_observed: AtomicBool,
}

impl AttemptState {
    fn new(call_id: String) -> Self {
        Self {
            call_id,
            next_chunk: AtomicI64::new(0),
            chunks: ChunkBuffer::default(),
            first_text_recorded: AtomicBool::new(false),
            first_valid_response_recorded: AtomicBool::new(false),
            first_output_recorded: AtomicBool::new(false),
            generation_started: None,
            generation_ended: None,
            generation_output_events: 0,
            thinking_observed: AtomicBool::new(false),
        }
    }
}

#[derive(Default)]
struct ChunkBuffer {
    chunks: Vec<BufferedLlmChunk>,
    bytes: usize,
    first_chunk_at: Option<Instant>,
    generation: u64,
}

const MAX_BUFFERED_CHUNKS: usize = 32;
const MAX_BUFFERED_BYTES: usize = 256 * 1024;
const MAX_BUFFER_AGE: std::time::Duration = std::time::Duration::from_millis(50);

impl CallRecorder {
    pub async fn start(store: Store, mut call: NewLlmCall) -> Result<Self> {
        call.detailed = store.detailed_logging().await?;
        store.start_llm_call(&call).await?;
        Ok(Self {
            inner: Arc::new(Inner {
                store,
                base_call: call.clone(),
                detailed: call.detailed,
                started: Instant::now(),
                request_sent: OnceLock::new(),
                stream_ended: std::sync::Mutex::new(None),
                attempt: Mutex::new(AttemptState::new(call.call_id.clone())),
                next_generation: AtomicU64::new(0),
                finished: AtomicBool::new(false),
            }),
        })
    }

    /// Marks when the upstream HTTP request is actually dispatched so local
    /// setup, serialization, DB request logging, and plugin IPC are excluded
    /// from response and generation latencies.
    pub async fn mark_request_sent(&self) {
        let _ = self.inner.request_sent.set(Instant::now());
    }

    /// Marks when the upstream response stream finishes so post-stream DB
    /// usage/chunk flushes are excluded from `duration_ms` and `generation_ms`.
    pub async fn mark_stream_ended(&self) {
        self.record_stream_ended(Instant::now(), true);
    }

    fn origin(&self) -> Instant {
        *self.inner.request_sent.get().unwrap_or(&self.inner.started)
    }

    fn record_stream_ended(&self, at: Instant, explicit: bool) {
        let mut ended = self
            .inner
            .stream_ended
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match *ended {
            Some(current) if current.explicit => {}
            Some(current) if explicit => {
                // Promote a tentative Usage timestamp captured right before DB usage persistence.
                *ended = Some(StreamEnded {
                    at: current.at,
                    explicit: true,
                });
            }
            _ => {
                *ended = Some(StreamEnded { at, explicit });
            }
        }
    }

    fn clear_tentative_stream_ended(&self) {
        let mut ended = self
            .inner
            .stream_ended
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if matches!(*ended, Some(current) if !current.explicit) {
            *ended = None;
        }
    }

    fn stream_ended_or(&self, fallback: Instant) -> Instant {
        let ended = self
            .inner
            .stream_ended
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        ended.map_or(fallback, |mark| mark.at)
    }

    pub fn detailed(&self) -> bool {
        self.inner.detailed
    }

    pub fn is_finished(&self) -> bool {
        self.inner.finished.load(Ordering::Acquire)
    }

    pub(crate) fn cancel_on_drop(&self) -> CancelOnDrop {
        CancelOnDrop {
            recorder: self.clone(),
        }
    }

    pub async fn request(
        &self,
        headers: serde_json::Value,
        body: &serde_json::Value,
    ) -> Result<()> {
        let attempt = self.inner.attempt.lock().await;
        self.inner
            .store
            .record_llm_request(&attempt.call_id, &headers, body, self.inner.detailed)
            .await?;
        Ok(())
    }

    pub async fn response_headers(&self, status: u16) -> Result<()> {
        let elapsed = elapsed_since(self.origin(), Instant::now());
        let attempt = self.inner.attempt.lock().await;
        self.inner
            .store
            .record_llm_response_headers(&attempt.call_id, elapsed, status)
            .await
    }

    pub async fn response_chunk(&self, data: &[u8]) -> Result<()> {
        let elapsed = elapsed_since(self.origin(), Instant::now());
        let mut attempt = self.inner.attempt.lock().await;
        if self.is_finished() {
            return Ok(());
        }
        let seq = attempt.next_chunk.fetch_add(1, Ordering::Relaxed);
        let schedule_flush = if attempt.chunks.chunks.is_empty() {
            attempt.chunks.generation = self
                .inner
                .next_generation
                .fetch_add(1, Ordering::Relaxed)
                .wrapping_add(1);
            attempt.chunks.first_chunk_at = Some(Instant::now());
            Some(attempt.chunks.generation)
        } else {
            None
        };
        attempt.chunks.bytes += data.len();
        attempt.chunks.chunks.push(if self.inner.detailed {
            BufferedLlmChunk::new(seq, elapsed, data)
        } else {
            BufferedLlmChunk::metrics(seq, elapsed, data.len())
        });
        let expired = attempt
            .chunks
            .first_chunk_at
            .is_some_and(|started| started.elapsed() >= MAX_BUFFER_AGE);
        if attempt.chunks.chunks.len() >= MAX_BUFFERED_CHUNKS
            || attempt.chunks.bytes >= MAX_BUFFERED_BYTES
            || expired
        {
            self.flush_locked(&mut attempt).await?;
        }
        drop(attempt);
        if let Some(generation) = schedule_flush {
            let recorder = self.clone();
            tokio::spawn(async move {
                tokio::time::sleep(MAX_BUFFER_AGE).await;
                if let Err(error) = recorder.flush_generation(generation).await {
                    tracing::warn!(call_id = recorder.call_id(), %error, "failed to flush LLM response chunks");
                }
            });
        }
        Ok(())
    }

    pub async fn event(&self, event: &ModelEvent) -> Result<()> {
        let event_at = Instant::now();
        if is_stream_continuation_event(event) {
            self.clear_tentative_stream_ended();
        }
        let origin = self.origin();
        let attempt = self.inner.attempt.lock().await;
        if is_valid_response_event(event)
            && attempt
                .first_valid_response_recorded
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
        {
            if let Err(error) = self
                .inner
                .store
                .record_llm_first_valid_response(&attempt.call_id, elapsed_since(origin, event_at))
                .await
            {
                attempt
                    .first_valid_response_recorded
                    .store(false, Ordering::Release);
                return Err(error);
            }
        }
        drop(attempt);

        if is_output_event(event) {
            self.note_output_at(is_thinking_event(event), event_at)
                .await?;
        }

        match event {
            ModelEvent::TextDelta(delta) if !delta.trim().is_empty() => {
                let attempt = self.inner.attempt.lock().await;
                if attempt
                    .first_text_recorded
                    .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                    .is_ok()
                {
                    if let Err(error) = self
                        .inner
                        .store
                        .record_llm_first_text(&attempt.call_id, elapsed_since(origin, event_at))
                        .await
                    {
                        attempt.first_text_recorded.store(false, Ordering::Release);
                        return Err(error);
                    }
                }
            }
            ModelEvent::Usage(usage) => {
                // Providers emit Usage at stream end right before Done; capture it
                // tentatively before SQLite usage writes so DB contention doesn't
                // inflate duration_ms or generation_ms.
                self.record_stream_ended(event_at, false);
                self.usage(*usage).await?;
            }
            ModelEvent::Done(reason) => {
                self.record_stream_ended(event_at, true);
                self.completed(*reason).await?;
            }
            _ => {}
        }
        Ok(())
    }

    /// Records first-output latency, observed thinking, and the visible output interval.
    /// Native forwarding supplies chunk arrival time to exclude observer delays.
    pub(crate) async fn note_output_at(&self, thinking: bool, at: Instant) -> Result<()> {
        let elapsed = elapsed_since(self.origin(), at);
        let mut attempt = self.inner.attempt.lock().await;
        if self.is_finished() {
            return Ok(());
        }
        if !thinking {
            attempt.generation_started.get_or_insert(at);
            attempt.generation_ended = Some(at);
            attempt.generation_output_events = attempt.generation_output_events.saturating_add(1);
        }
        let record_first = attempt
            .first_output_recorded
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok();
        let record_thinking = thinking
            && attempt
                .thinking_observed
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_ok();
        if !record_first && !record_thinking {
            return Ok(());
        }
        match self
            .inner
            .store
            .record_llm_output(
                &attempt.call_id,
                record_first.then_some(elapsed),
                record_thinking,
            )
            .await
        {
            Ok(()) => Ok(()),
            Err(error) => {
                if record_first {
                    attempt
                        .first_output_recorded
                        .store(false, Ordering::Release);
                }
                if record_thinking {
                    attempt.thinking_observed.store(false, Ordering::Release);
                }
                Err(error)
            }
        }
    }

    pub async fn usage(&self, usage: Usage) -> Result<()> {
        let attempt = self.inner.attempt.lock().await;
        self.inner
            .store
            .record_llm_usage(&attempt.call_id, usage)
            .await
    }

    pub async fn completed(&self, reason: FinishReason) -> Result<()> {
        self.finish("completed", Some(finish_reason(reason)), None, None)
            .await
    }

    pub async fn failed(&self, error: &crate::Error) -> Result<()> {
        self.clear_tentative_stream_ended();
        self.finish(
            "error",
            None,
            Some(error_kind(error)),
            Some(&error.to_string()),
        )
        .await
    }

    pub async fn cancelled(&self) -> Result<()> {
        self.clear_tentative_stream_ended();
        self.finish("cancelled", None, None, None).await
    }

    async fn finish(
        &self,
        status: &str,
        reason: Option<&str>,
        error_kind: Option<&str>,
        error_message: Option<&str>,
    ) -> Result<()> {
        if self.is_finished() {
            return Ok(());
        }
        let fallback_end = Instant::now();
        let mut attempt = self.inner.attempt.lock().await;
        if self.is_finished() {
            return Ok(());
        }
        let ended_at = self.stream_ended_or(fallback_end);
        self.flush_locked(&mut attempt).await?;
        let elapsed_ms = elapsed_since(self.origin(), ended_at);
        let generation_ms = attempt
            .generation_started
            .zip(attempt.generation_ended)
            .map(|(first, last)| elapsed_since(first, last));
        self.inner
            .store
            .finish_llm_call(
                &attempt.call_id,
                CallFinish {
                    status,
                    finish_reason: reason,
                    elapsed_ms,
                    generation_ms,
                    generation_output_events: Some(attempt.generation_output_events),
                    error_kind,
                    error_message,
                },
            )
            .await?;
        self.inner.finished.store(true, Ordering::Release);
        Ok(())
    }

    async fn flush_generation(&self, generation: u64) -> Result<()> {
        let mut attempt = self.inner.attempt.lock().await;
        if attempt.chunks.generation != generation {
            return Ok(());
        }
        self.flush_locked(&mut attempt).await
    }

    async fn flush_locked(&self, attempt: &mut AttemptState) -> Result<()> {
        let buffer = &mut attempt.chunks;
        if buffer.chunks.is_empty() {
            return Ok(());
        }
        let chunks = std::mem::take(&mut buffer.chunks);
        buffer.bytes = 0;
        buffer.first_chunk_at = None;
        if let Err(error) = self
            .inner
            .store
            .record_llm_chunks(&attempt.call_id, &chunks, self.inner.detailed)
            .await
        {
            buffer.bytes = chunks.iter().map(|chunk| chunk.byte_count).sum();
            buffer.first_chunk_at = Some(Instant::now());
            buffer.chunks = chunks;
            return Err(error);
        }
        Ok(())
    }

    fn call_id(&self) -> String {
        self.inner
            .attempt
            .try_lock()
            .map(|attempt| attempt.call_id.clone())
            .unwrap_or_else(|_| self.inner.base_call.call_id.clone())
    }
}

fn elapsed_since(started: Instant, ended: Instant) -> i64 {
    ended
        .saturating_duration_since(started)
        .as_millis()
        .min(i64::MAX as u128) as i64
}

fn is_stream_continuation_event(event: &ModelEvent) -> bool {
    is_output_event(event)
        || matches!(
            event,
            ModelEvent::TextStart | ModelEvent::ThinkingStart | ModelEvent::ToolCallStart { .. }
        )
}

/// Returns whether an event carries actual model output: non-empty text,
/// reasoning content, or a tool name/argument. Transport markers, heartbeats,
/// empty deltas, usage, and completion events do not start the generation clock.
fn is_output_event(event: &ModelEvent) -> bool {
    match event {
        ModelEvent::TextDelta(delta) => !delta.trim().is_empty(),
        ModelEvent::ThinkingDelta(delta) => !delta.trim().is_empty(),
        ModelEvent::RedactedThinking(_) => true,
        ModelEvent::ToolCallStart { name, .. } => !name.trim().is_empty(),
        ModelEvent::ToolCallArgumentsDelta { delta, .. } => !delta.trim().is_empty(),
        _ => false,
    }
}

fn is_thinking_event(event: &ModelEvent) -> bool {
    matches!(
        event,
        ModelEvent::ThinkingStart | ModelEvent::ThinkingDelta(_) | ModelEvent::RedactedThinking(_)
    )
}

fn finish_reason(reason: FinishReason) -> &'static str {
    match reason {
        FinishReason::Stop => "stop",
        FinishReason::Length => "length",
        FinishReason::ToolUse => "tool_use",
    }
}

fn error_kind(error: &crate::Error) -> &'static str {
    match error {
        crate::Error::Provider(_) | crate::Error::Upstream { .. } | crate::Error::Http(_) => {
            "provider"
        }
        crate::Error::Cancelled => "cancelled",
        crate::Error::Database(_) | crate::Error::Store(_) => "store",
        _ => "internal",
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use crate::model::{
        CallOrigin, ModelConfigInput, NewLlmCall, ProviderConfigInput, ProviderType, RequestFormat,
        Usage,
    };

    use super::*;

    async fn test_recorder(call_id: &str) -> (tempfile::TempDir, Store, CallRecorder) {
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
                call_id: call_id.into(),
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
        (directory, store, recorder)
    }

    #[tokio::test]
    async fn dropping_an_unfinished_call_guard_marks_the_call_cancelled() {
        let (_directory, store, recorder) = test_recorder("cancel-on-drop").await;

        drop(recorder.cancel_on_drop());

        let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
        loop {
            let status: String =
                sqlx::query_scalar("SELECT status FROM llm_calls WHERE call_id = ?")
                    .bind("cancel-on-drop")
                    .fetch_one(store.pool())
                    .await
                    .unwrap();
            if status == "cancelled" {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "unfinished recorder stayed running after its stream was dropped"
            );
            tokio::task::yield_now().await;
        }
    }

    #[tokio::test]
    async fn generation_excludes_thinking_and_the_terminal_metadata_wait() {
        let (_directory, store, recorder) = test_recorder("visible-generation").await;
        let origin = Instant::now() - Duration::from_secs(5);
        recorder.inner.request_sent.set(origin).unwrap();
        recorder
            .note_output_at(true, origin + Duration::from_millis(500))
            .await
            .unwrap();
        recorder
            .note_output_at(false, origin + Duration::from_secs(2))
            .await
            .unwrap();
        recorder
            .note_output_at(false, origin + Duration::from_secs(3))
            .await
            .unwrap();
        recorder.record_stream_ended(origin + Duration::from_secs(4), true);
        recorder.completed(FinishReason::Stop).await.unwrap();
        let call = store.llm_call("visible-generation").await.unwrap().unwrap();
        assert_eq!(call.ttfo_ms, Some(500));
        assert_eq!(call.generation_ms, Some(1_000));
        assert_eq!(call.duration_ms, Some(4_000));
    }

    #[tokio::test]
    async fn a_buffered_response_has_no_generation_sample() {
        let (_directory, store, recorder) = test_recorder("buffered-generation").await;
        let origin = Instant::now() - Duration::from_secs(5);
        recorder.inner.request_sent.set(origin).unwrap();
        recorder
            .note_output_at(false, origin + Duration::from_secs(1))
            .await
            .unwrap();
        recorder
            .usage(Usage {
                output_tokens: Some(120),
                ..Default::default()
            })
            .await
            .unwrap();
        recorder.record_stream_ended(origin + Duration::from_secs(3), true);
        recorder.completed(FinishReason::Stop).await.unwrap();
        let call = store
            .llm_call("buffered-generation")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(call.performance.tokens_per_second, None);
        assert_eq!(call.generation_ms, Some(0));
    }

    #[tokio::test]
    async fn mark_request_sent_excludes_pre_send_delay_from_latencies() {
        let (_directory, store, recorder) = test_recorder("pre-send-delay").await;
        let test_start = Instant::now();

        tokio::time::sleep(Duration::from_millis(200)).await;
        let pre_send_ms = test_start.elapsed().as_millis() as i64;
        recorder.mark_request_sent().await;
        let post_send_start = Instant::now();

        tokio::time::sleep(Duration::from_millis(15)).await;
        recorder.response_headers(200).await.unwrap();
        tokio::time::sleep(Duration::from_millis(15)).await;
        recorder
            .event(&ModelEvent::TextDelta("hello".into()))
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(15)).await;
        recorder
            .event(&ModelEvent::Done(FinishReason::Stop))
            .await
            .unwrap();
        let post_send_ms = post_send_start.elapsed().as_millis() as i64;
        let total_ms = test_start.elapsed().as_millis() as i64;

        let call = store.llm_call("pre-send-delay").await.unwrap().unwrap();
        let ttfb = call.ttfb_ms.unwrap();
        let ttfr = call.ttfr_ms.unwrap();
        let ttfo = call.ttfo_ms.unwrap();
        let ttft = call.ttft_ms.unwrap();
        let duration = call.duration_ms.unwrap();
        let generation = call.generation_ms.unwrap();

        assert!(
            ttfb <= post_send_ms && ttfb < pre_send_ms,
            "ttfb_ms={ttfb} exceeded post_send_ms={post_send_ms} (pre_send_ms={pre_send_ms})"
        );
        assert!(
            ttfr <= post_send_ms && ttfr < pre_send_ms,
            "ttfr_ms={ttfr} exceeded post_send_ms={post_send_ms}"
        );
        assert!(
            ttfo <= post_send_ms && ttfo < pre_send_ms,
            "ttfo_ms={ttfo} exceeded post_send_ms={post_send_ms}"
        );
        assert!(
            ttft <= post_send_ms && ttft < pre_send_ms,
            "ttft_ms={ttft} exceeded post_send_ms={post_send_ms}"
        );
        assert!(
            duration <= post_send_ms && total_ms - duration >= pre_send_ms - 5,
            "duration_ms={duration} included pre-send delay (total_ms={total_ms}, pre_send_ms={pre_send_ms})"
        );
        assert!(
            generation <= duration,
            "generation_ms={generation} exceeded duration_ms={duration}"
        );
        assert!(ttfb <= ttfo);
        assert!(ttfo <= duration);
    }

    #[tokio::test]
    async fn mark_stream_ended_excludes_post_stream_flush_delay() {
        let (_directory, store, recorder) = test_recorder("post-stream-delay").await;
        let send_start = Instant::now();

        recorder.mark_request_sent().await;
        recorder.response_headers(200).await.unwrap();
        recorder
            .event(&ModelEvent::TextDelta("hello".into()))
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(20)).await;
        recorder.response_chunk(b"data: [DONE]\n\n").await.unwrap();
        recorder.mark_stream_ended().await;
        let stream_window_ms = send_start.elapsed().as_millis() as i64;

        tokio::time::sleep(Duration::from_millis(200)).await;
        recorder.completed(FinishReason::Stop).await.unwrap();
        let total_ms = send_start.elapsed().as_millis() as i64;

        let call = store.llm_call("post-stream-delay").await.unwrap().unwrap();
        let duration = call.duration_ms.unwrap();
        let generation = call.generation_ms.unwrap();
        assert!(
            duration <= stream_window_ms && total_ms - duration >= 180,
            "duration_ms={duration} included post-stream delay (stream_window_ms={stream_window_ms}, total_ms={total_ms})"
        );
        assert!(
            generation <= stream_window_ms,
            "generation_ms={generation} included post-stream delay (stream_window_ms={stream_window_ms})"
        );
    }

    #[tokio::test]
    async fn usage_before_done_captures_stream_end_while_mid_stream_usage_resets() {
        let (_dir_a, store_a, recorder_a) = test_recorder("usage-before-done").await;
        let send_start_a = Instant::now();
        recorder_a.mark_request_sent().await;
        recorder_a
            .event(&ModelEvent::TextDelta("hello".into()))
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(20)).await;
        let before_usage_ms = send_start_a.elapsed().as_millis() as i64;
        recorder_a
            .event(&ModelEvent::Usage(Usage {
                output_tokens: Some(10),
                ..Default::default()
            }))
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        recorder_a
            .event(&ModelEvent::Done(FinishReason::Stop))
            .await
            .unwrap();
        let total_a_ms = send_start_a.elapsed().as_millis() as i64;

        let call_a = store_a
            .llm_call("usage-before-done")
            .await
            .unwrap()
            .unwrap();
        let duration_a = call_a.duration_ms.unwrap();
        let generation_a = call_a.generation_ms.unwrap();
        assert!(
            duration_a <= before_usage_ms + 5 && total_a_ms - duration_a >= 180,
            "duration_ms={duration_a} included post-Usage delay (before_usage_ms={before_usage_ms}, total_a_ms={total_a_ms})"
        );
        assert!(
            generation_a <= before_usage_ms + 5,
            "generation_ms={generation_a} included post-Usage delay (before_usage_ms={before_usage_ms})"
        );

        let (_dir_b, store_b, recorder_b) = test_recorder("mid-stream-usage").await;
        recorder_b.mark_request_sent().await;
        recorder_b
            .event(&ModelEvent::TextDelta("part1".into()))
            .await
            .unwrap();
        recorder_b
            .event(&ModelEvent::Usage(Usage {
                output_tokens: Some(5),
                ..Default::default()
            }))
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        recorder_b
            .event(&ModelEvent::TextDelta("part2".into()))
            .await
            .unwrap();
        recorder_b
            .event(&ModelEvent::Done(FinishReason::Stop))
            .await
            .unwrap();

        let call_b = store_b.llm_call("mid-stream-usage").await.unwrap().unwrap();
        assert!(
            call_b.duration_ms.unwrap() >= 180,
            "duration_ms={:?} froze at mid-stream Usage",
            call_b.duration_ms
        );
        assert!(
            call_b.generation_ms.unwrap() >= 180,
            "generation_ms={:?} froze at mid-stream Usage",
            call_b.generation_ms
        );
    }

    #[tokio::test]
    async fn latencies_fall_back_to_start_when_request_sent_is_not_marked() {
        let (_directory, store, recorder) = test_recorder("fallback-start").await;

        tokio::time::sleep(Duration::from_millis(80)).await;
        recorder.response_headers(200).await.unwrap();
        recorder
            .event(&ModelEvent::TextDelta("hello".into()))
            .await
            .unwrap();
        recorder.completed(FinishReason::Stop).await.unwrap();

        let call = store.llm_call("fallback-start").await.unwrap().unwrap();
        assert!(call.ttfb_ms.unwrap() >= 60);
        assert!(call.ttfo_ms.unwrap() >= 60);
        assert!(call.duration_ms.unwrap() >= 60);
    }
}

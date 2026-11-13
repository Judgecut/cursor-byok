//! Persists provider call payloads, timing, frozen pricing snapshots, and usage costs.
use std::{collections::HashMap, str::FromStr};

use sqlx::Row;

use crate::{
    model::{
        evaluate as evaluate_performance, LlmCallRequest, LlmCallResponseChunk, LlmCallSummary,
        NewLlmCall, ProviderType, SpeedSample, Usage,
    },
    pricing::{
        calculate_cost, canonical_supplier_identity, format_nano_usd, PricingRates,
        PricingSnapshot, PricingSource,
    },
    Result,
};

use super::{
    now_ms,
    overview::{normalize_string_array_filter, supplier_id_sql},
    pricing::resolve_snapshot_conn,
    Store,
};

#[derive(Clone, Copy, Debug, Default)]
pub struct LlmCallFilter<'a> {
    pub start_ms: Option<i64>,
    pub end_ms: Option<i64>,
    pub suppliers: Option<&'a str>,
    pub supplier_keys: Option<&'a str>,
    pub limit: i64,
    pub offset: i64,
}

impl<'a> LlmCallFilter<'a> {
    pub fn with_limit(limit: i64) -> Self {
        Self {
            limit,
            ..Default::default()
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum TimelineCallRef {
    Llm(String),
    Cursor(String),
}

const LLM_CALL_COLUMNS: &str = r#"
    call_id, run_id, conversation_id, provider_call_index, model_hash,
    supplier_key, endpoint_key,
    provider_type, provider_url, request_type, request_url, model_id, display_name,
    reasoning_effort, fast, status, finish_reason,
    created_at_ms, request_started_at_ms, response_headers_at_ms,
    first_event_at_ms, first_text_at_ms, first_valid_response_at_ms, finished_at_ms,
    first_output_at_ms, streaming, call_origin, observed_thinking,
    queue_ms, ttfb_ms, ttft_ms, ttfr_ms, ttfo_ms, duration_ms, generation_ms,
    input_tokens, output_tokens, total_tokens,
    cache_read_tokens, cache_write_tokens, reasoning_tokens, usage_json,
    pricing_source, pricing_provider_id, pricing_model_id, pricing_snapshot_at_ms,
    unit_input_per_million, unit_output_per_million,
    unit_cache_read_per_million, unit_cache_write_per_million,
    cost_status, input_cost_nano, output_cost_nano,
    cache_read_cost_nano, cache_write_cost_nano, total_cost_nano,
    cost_calculated_at_ms, cost_backfilled,
    message_count, tool_count, request_bytes, response_bytes, stream_event_count,
    http_status, error_kind, error_message, detailed
"#;

/// Terminal state written when a call stops, whether it completed, failed, or was
/// cancelled. Generation time is absent when no actual output was observed.
#[derive(Clone, Copy, Debug)]
pub struct CallFinish<'a> {
    pub status: &'a str,
    pub finish_reason: Option<&'a str>,
    pub elapsed_ms: i64,
    pub generation_ms: Option<i64>,
    pub error_kind: Option<&'a str>,
    pub error_message: Option<&'a str>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ContextUsageAnchor {
    pub(crate) context_input_tokens: u64,
    pub(crate) message_count: usize,
}

#[derive(Clone, Debug)]
pub(crate) struct BufferedLlmChunk {
    pub(crate) seq: i64,
    pub(crate) elapsed_ms: i64,
    pub(crate) data: Option<Vec<u8>>,
    pub(crate) byte_count: usize,
}

impl BufferedLlmChunk {
    pub(crate) fn new(seq: i64, elapsed_ms: i64, data: &[u8]) -> Self {
        Self {
            seq,
            elapsed_ms,
            data: Some(data.to_vec()),
            byte_count: data.len(),
        }
    }

    pub(crate) fn metrics(seq: i64, elapsed_ms: i64, byte_count: usize) -> Self {
        Self {
            seq,
            elapsed_ms,
            data: None,
            byte_count,
        }
    }
}

impl Store {
    pub async fn detailed_logging(&self) -> Result<bool> {
        let value: String = sqlx::query_scalar(
            "SELECT value_json FROM service_settings WHERE setting_key = 'llm_detailed_logging'",
        )
        .fetch_one(&self.pool)
        .await?;
        Ok(serde_json::from_str(&value)?)
    }

    pub async fn set_detailed_logging(&self, enabled: bool) -> Result<()> {
        let _write = self.writes.lock().await;
        sqlx::query(
            "INSERT INTO service_settings(setting_key, value_json, updated_at_ms) VALUES ('llm_detailed_logging', ?, ?) ON CONFLICT(setting_key) DO UPDATE SET value_json = excluded.value_json, updated_at_ms = excluded.updated_at_ms",
        )
        .bind(serde_json::to_string(&enabled)?)
        .bind(now_ms())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn start_llm_call(&self, call: &NewLlmCall) -> Result<()> {
        let identity = canonical_supplier_identity(
            call.request_type,
            &call.request_url,
            &call.provider_url,
            &call.model_id,
        );
        let _write = self.writes.lock().await;
        let now = now_ms();
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let snapshot = resolve_snapshot_conn(&mut transaction, &identity, now).await?;
        sqlx::query(
            r#"INSERT INTO llm_calls(
                call_id, run_id, conversation_id, provider_call_index, model_hash,
                supplier_key, endpoint_key,
                provider_type, provider_url, request_type, request_url, model_id, display_name,
                reasoning_effort, fast, status,
                created_at_ms, request_started_at_ms, queue_ms,
                call_origin, streaming,
                pricing_source, pricing_provider_id, pricing_model_id, pricing_snapshot_at_ms,
                unit_input_per_million, unit_output_per_million,
                unit_cache_read_per_million, unit_cache_write_per_million,
                cost_backfilled,
                message_count, tool_count, detailed
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)"#,
        )
        .bind(&call.call_id)
        .bind(&call.run_id)
        .bind(&call.conversation_id)
        .bind(call.provider_call_index)
        .bind(&call.model_hash)
        .bind(&identity.supplier_key)
        .bind(&identity.endpoint_key)
        .bind(call.provider_type.as_str())
        .bind(&call.provider_url)
        .bind(call.request_type.as_str())
        .bind(&call.request_url)
        .bind(&call.model_id)
        .bind(&call.display_name)
        .bind(&call.reasoning_effort)
        .bind(call.fast)
        .bind(now)
        .bind(now)
        .bind(call.origin.as_str())
        .bind(call.streaming)
        .bind(snapshot.source.as_str())
        .bind(&snapshot.provider_id)
        .bind(&snapshot.model_id)
        .bind(snapshot.snapshot_at_ms)
        .bind(&snapshot.rates.input_per_million)
        .bind(&snapshot.rates.output_per_million)
        .bind(&snapshot.rates.cache_read_per_million)
        .bind(&snapshot.rates.cache_write_per_million)
        .bind(call.message_count as i64)
        .bind(call.tool_count as i64)
        .bind(call.detailed)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(())
    }

    pub async fn record_llm_request(
        &self,
        call_id: &str,
        headers: &serde_json::Value,
        body: &serde_json::Value,
        detailed: bool,
    ) -> Result<()> {
        let body_json = serde_json::to_string(body)?;
        let headers_json = detailed
            .then(|| serde_json::to_string(headers))
            .transpose()?;
        let _write = self.writes.lock().await;
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        if detailed {
            sqlx::query("INSERT INTO llm_call_requests(call_id, headers_json, body_json, byte_count) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM llm_calls WHERE call_id = ?)")
                .bind(call_id)
                .bind(headers_json)
                .bind(&body_json)
                .bind(body_json.len() as i64)
                .bind(call_id)
                .execute(&mut *transaction)
                .await?;
        }
        sqlx::query("UPDATE llm_calls SET request_bytes = ? WHERE call_id = ?")
            .bind(body_json.len() as i64)
            .bind(call_id)
            .execute(&mut *transaction)
            .await?;
        transaction.commit().await?;
        Ok(())
    }

    pub async fn record_llm_response_headers(
        &self,
        call_id: &str,
        elapsed_ms: i64,
        http_status: u16,
    ) -> Result<()> {
        let _write = self.writes.lock().await;
        sqlx::query("UPDATE llm_calls SET response_headers_at_ms = ?, ttfb_ms = ?, http_status = ? WHERE call_id = ?")
            .bind(now_ms())
            .bind(elapsed_ms)
            .bind(http_status as i64)
            .bind(call_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn record_llm_chunk(
        &self,
        call_id: &str,
        seq: i64,
        elapsed_ms: i64,
        data: &[u8],
        detailed: bool,
    ) -> Result<()> {
        let chunk = if detailed {
            BufferedLlmChunk::new(seq, elapsed_ms, data)
        } else {
            BufferedLlmChunk::metrics(seq, elapsed_ms, data.len())
        };
        self.record_llm_chunks(call_id, &[chunk], detailed).await
    }

    pub(crate) async fn record_llm_chunks(
        &self,
        call_id: &str,
        chunks: &[BufferedLlmChunk],
        detailed: bool,
    ) -> Result<()> {
        if chunks.is_empty() {
            return Ok(());
        }
        let byte_count = chunks
            .iter()
            .map(|chunk| chunk.byte_count as i64)
            .sum::<i64>();
        let event_count = chunks.len() as i64;
        let _write = self.writes.lock().await;
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        if detailed {
            for chunk in chunks {
                let data = chunk.data.as_deref().ok_or_else(|| {
                    crate::Error::Store("detailed LLM chunk is missing payload data".into())
                })?;
                sqlx::query("INSERT INTO llm_call_response_chunks(call_id, seq, received_offset_ms, data, byte_count) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM llm_calls WHERE call_id = ?)")
                    .bind(call_id)
                    .bind(chunk.seq)
                    .bind(chunk.elapsed_ms)
                    .bind(data)
                    .bind(chunk.byte_count as i64)
                    .bind(call_id)
                    .execute(&mut *transaction)
                    .await?;
            }
        }
        sqlx::query("UPDATE llm_calls SET first_event_at_ms = COALESCE(first_event_at_ms, ?), response_bytes = response_bytes + ?, stream_event_count = stream_event_count + ? WHERE call_id = ?")
            .bind(now_ms())
            .bind(byte_count)
            .bind(event_count)
            .bind(call_id)
            .execute(&mut *transaction)
            .await?;
        transaction.commit().await?;
        Ok(())
    }

    pub async fn record_llm_first_valid_response(
        &self,
        call_id: &str,
        elapsed_ms: i64,
    ) -> Result<()> {
        let _write = self.writes.lock().await;
        sqlx::query("UPDATE llm_calls SET first_valid_response_at_ms = COALESCE(first_valid_response_at_ms, ?), ttfr_ms = COALESCE(ttfr_ms, ?) WHERE call_id = ?")
            .bind(now_ms())
            .bind(elapsed_ms)
            .bind(call_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn record_llm_first_text(&self, call_id: &str, elapsed_ms: i64) -> Result<()> {
        let _write = self.writes.lock().await;
        sqlx::query("UPDATE llm_calls SET first_text_at_ms = COALESCE(first_text_at_ms, ?), ttft_ms = COALESCE(ttft_ms, ?) WHERE call_id = ?")
            .bind(now_ms())
            .bind(elapsed_ms)
            .bind(call_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Records the delay to the first actual output and whether thinking content
    /// was observed. Both writes stay conditional so a repeated call is harmless.
    pub async fn record_llm_output(
        &self,
        call_id: &str,
        first_output_elapsed_ms: Option<i64>,
        observed_thinking: bool,
    ) -> Result<()> {
        let _write = self.writes.lock().await;
        sqlx::query(
            "UPDATE llm_calls SET
                first_output_at_ms = COALESCE(first_output_at_ms, ?),
                ttfo_ms = COALESCE(ttfo_ms, ?),
                observed_thinking = CASE WHEN ? THEN 1 ELSE observed_thinking END
             WHERE call_id = ?",
        )
        .bind(first_output_elapsed_ms.map(|_| now_ms()))
        .bind(first_output_elapsed_ms)
        .bind(observed_thinking)
        .bind(call_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn record_llm_usage(&self, call_id: &str, usage: Usage) -> Result<()> {
        let usage_json = serde_json::to_string(&usage)?;
        let now = now_ms();
        let _write = self.writes.lock().await;
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let frozen = sqlx::query(
            "SELECT
                request_type,
                pricing_source,
                pricing_provider_id,
                pricing_model_id,
                pricing_snapshot_at_ms,
                unit_input_per_million,
                unit_output_per_million,
                unit_cache_read_per_million,
                unit_cache_write_per_million
             FROM llm_calls
             WHERE call_id = ?",
        )
        .bind(call_id)
        .fetch_optional(&mut *transaction)
        .await?;

        let Some(row) = frozen else {
            return Ok(());
        };
        let request_type_raw: String = row.try_get("request_type")?;
        let request_type =
            ProviderType::from_str(&request_type_raw).unwrap_or(ProviderType::OpenAiChat);
        let source_raw: Option<String> = row.try_get("pricing_source")?;
        let snapshot = PricingSnapshot {
            source: PricingSource::parse(source_raw.as_deref().unwrap_or("unpriced")),
            provider_id: row.try_get("pricing_provider_id")?,
            model_id: row.try_get("pricing_model_id")?,
            snapshot_at_ms: row
                .try_get::<Option<i64>, _>("pricing_snapshot_at_ms")?
                .unwrap_or(now),
            rates: PricingRates {
                input_per_million: row.try_get("unit_input_per_million")?,
                output_per_million: row.try_get("unit_output_per_million")?,
                cache_read_per_million: row.try_get("unit_cache_read_per_million")?,
                cache_write_per_million: row.try_get("unit_cache_write_per_million")?,
            },
        };
        let calculated = calculate_cost(request_type, &usage, &snapshot)?;

        sqlx::query(
            "UPDATE llm_calls SET
                input_tokens = ?,
                output_tokens = ?,
                total_tokens = ?,
                cache_read_tokens = ?,
                cache_write_tokens = ?,
                reasoning_tokens = ?,
                usage_json = ?,
                cost_status = ?,
                input_cost_nano = ?,
                output_cost_nano = ?,
                cache_read_cost_nano = ?,
                cache_write_cost_nano = ?,
                total_cost_nano = ?,
                cost_calculated_at_ms = ?,
                cost_backfilled = 0
             WHERE call_id = ?",
        )
        .bind(as_i64(usage.input_tokens))
        .bind(as_i64(usage.output_tokens))
        .bind(as_i64(usage.total_tokens))
        .bind(as_i64(usage.cache_read_tokens))
        .bind(as_i64(usage.cache_write_tokens))
        .bind(as_i64(usage.reasoning_tokens))
        .bind(usage_json)
        .bind(calculated.status.as_str())
        .bind(calculated.input_cost_nano)
        .bind(calculated.output_cost_nano)
        .bind(calculated.cache_read_cost_nano)
        .bind(calculated.cache_write_cost_nano)
        .bind(calculated.total_cost_nano)
        .bind(now)
        .bind(call_id)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(())
    }

    pub async fn finish_llm_call(&self, call_id: &str, finish: CallFinish<'_>) -> Result<()> {
        let now = now_ms();
        let _write = self.writes.lock().await;
        sqlx::query(
            "UPDATE llm_calls SET
                status = ?,
                finish_reason = ?,
                finished_at_ms = ?,
                duration_ms = ?,
                generation_ms = COALESCE(generation_ms, ?),
                error_kind = ?,
                error_message = ?,
                cost_status = COALESCE(cost_status, 'incomplete_usage'),
                cost_calculated_at_ms = COALESCE(cost_calculated_at_ms, ?)
             WHERE call_id = ? AND status = 'running'",
        )
        .bind(finish.status)
        .bind(finish.finish_reason)
        .bind(now)
        .bind(finish.elapsed_ms)
        .bind(finish.generation_ms)
        .bind(finish.error_kind)
        .bind(finish.error_message)
        .bind(now)
        .bind(call_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub(crate) async fn latest_context_usage(
        &self,
        conversation_id: &str,
    ) -> Result<Option<ContextUsageAnchor>> {
        let row = sqlx::query(
            "SELECT usage_json, message_count FROM llm_calls
             WHERE conversation_id = ?
               AND json_extract(usage_json, '$.context_input_tokens') IS NOT NULL
             ORDER BY created_at_ms DESC, rowid DESC
             LIMIT 1",
        )
        .bind(conversation_id)
        .fetch_optional(&self.pool)
        .await?;
        let Some(row) = row else {
            return Ok(None);
        };
        let usage: Usage = serde_json::from_str(row.try_get("usage_json")?)?;
        let Some(context_input_tokens) = usage.context_input_tokens else {
            return Ok(None);
        };
        let message_count = row.try_get::<i64, _>("message_count")?;
        let Ok(message_count) = usize::try_from(message_count) else {
            return Ok(None);
        };
        Ok(Some(ContextUsageAnchor {
            context_input_tokens,
            message_count,
        }))
    }

    pub async fn count_llm_calls(&self, filter: &LlmCallFilter<'_>) -> Result<i64> {
        let supplier_keys_json =
            normalize_string_array_filter(filter.supplier_keys, "supplier_keys")?;
        let suppliers_json = normalize_string_array_filter(filter.suppliers, "suppliers")?;
        let supplier_id_expr = supplier_id_sql();
        let query = format!(
            "SELECT COUNT(*) FROM llm_calls
             WHERE (? IS NULL OR created_at_ms >= ?)
               AND (? IS NULL OR created_at_ms < ?)
               AND (? IS NULL OR supplier_key IN (SELECT value FROM json_each(?)))
               AND (? IS NULL OR {supplier_id_expr} IN (SELECT value FROM json_each(?)))"
        );
        let total: i64 = sqlx::query_scalar(&query)
            .bind(filter.start_ms)
            .bind(filter.start_ms)
            .bind(filter.end_ms)
            .bind(filter.end_ms)
            .bind(&supplier_keys_json)
            .bind(&supplier_keys_json)
            .bind(&suppliers_json)
            .bind(&suppliers_json)
            .fetch_one(&self.pool)
            .await?;
        Ok(total.max(0))
    }

    pub async fn llm_calls(&self, filter: &LlmCallFilter<'_>) -> Result<Vec<LlmCallSummary>> {
        let supplier_keys_json =
            normalize_string_array_filter(filter.supplier_keys, "supplier_keys")?;
        let suppliers_json = normalize_string_array_filter(filter.suppliers, "suppliers")?;
        let supplier_id_expr = supplier_id_sql();
        let query = format!(
            "SELECT {LLM_CALL_COLUMNS}
             FROM llm_calls
             WHERE (? IS NULL OR created_at_ms >= ?)
               AND (? IS NULL OR created_at_ms < ?)
               AND (? IS NULL OR supplier_key IN (SELECT value FROM json_each(?)))
               AND (? IS NULL OR {supplier_id_expr} IN (SELECT value FROM json_each(?)))
             ORDER BY created_at_ms DESC, rowid DESC
             LIMIT ? OFFSET ?"
        );
        let rows = sqlx::query(&query)
            .bind(filter.start_ms)
            .bind(filter.start_ms)
            .bind(filter.end_ms)
            .bind(filter.end_ms)
            .bind(&supplier_keys_json)
            .bind(&supplier_keys_json)
            .bind(&suppliers_json)
            .bind(&suppliers_json)
            .bind(filter.limit.clamp(1, 500))
            .bind(filter.offset.max(0))
            .fetch_all(&self.pool)
            .await?;
        rows.into_iter().map(summary_from_row).collect()
    }

    pub async fn llm_calls_by_ids(
        &self,
        call_ids: &[String],
    ) -> Result<HashMap<String, LlmCallSummary>> {
        if call_ids.is_empty() {
            return Ok(HashMap::new());
        }
        let ids_json = serde_json::to_string(call_ids)?;
        let query = format!(
            "SELECT {LLM_CALL_COLUMNS}
             FROM llm_calls
             WHERE call_id IN (SELECT value FROM json_each(?))"
        );
        let rows = sqlx::query(&query)
            .bind(ids_json)
            .fetch_all(&self.pool)
            .await?;
        rows.into_iter()
            .map(|row| {
                let summary = summary_from_row(row)?;
                Ok((summary.call_id.clone(), summary))
            })
            .collect()
    }

    pub(crate) async fn unfiltered_call_timeline_page(
        &self,
        start_ms: Option<i64>,
        end_ms: Option<i64>,
        limit: i64,
        offset: i64,
    ) -> Result<Vec<TimelineCallRef>> {
        let rows = sqlx::query(
            "SELECT 'llm' AS kind, call_id AS id, created_at_ms AS ts
             FROM llm_calls
             WHERE (? IS NULL OR created_at_ms >= ?)
               AND (? IS NULL OR created_at_ms < ?)
             UNION ALL
             SELECT 'cursor' AS kind, request_id AS id, received_at_ms AS ts
             FROM cursor_run_traces
             WHERE route = 'cursor_official'
               AND (? IS NULL OR received_at_ms >= ?)
               AND (? IS NULL OR received_at_ms < ?)
             ORDER BY ts DESC, kind DESC, id DESC
             LIMIT ? OFFSET ?",
        )
        .bind(start_ms)
        .bind(start_ms)
        .bind(end_ms)
        .bind(end_ms)
        .bind(start_ms)
        .bind(start_ms)
        .bind(end_ms)
        .bind(end_ms)
        .bind(limit.clamp(1, 500))
        .bind(offset.max(0))
        .fetch_all(&self.pool)
        .await?;

        rows.into_iter()
            .map(|row| {
                let kind: String = row.try_get("kind")?;
                let id: String = row.try_get("id")?;
                Ok(if kind == "cursor" {
                    TimelineCallRef::Cursor(id)
                } else {
                    TimelineCallRef::Llm(id)
                })
            })
            .collect()
    }

    pub async fn llm_call(&self, call_id: &str) -> Result<Option<LlmCallSummary>> {
        let query = format!("SELECT {LLM_CALL_COLUMNS} FROM llm_calls WHERE call_id = ?");
        sqlx::query(&query)
            .bind(call_id)
            .fetch_optional(&self.pool)
            .await?
            .map(summary_from_row)
            .transpose()
    }

    pub async fn llm_call_request(&self, call_id: &str) -> Result<Option<LlmCallRequest>> {
        let row = sqlx::query(
            "SELECT headers_json, body_json, byte_count FROM llm_call_requests WHERE call_id = ?",
        )
        .bind(call_id)
        .fetch_optional(&self.pool)
        .await?;
        row.map(|row| {
            Ok(LlmCallRequest {
                headers: serde_json::from_str(row.try_get("headers_json")?)?,
                body: serde_json::from_str(row.try_get("body_json")?)?,
                byte_count: row.try_get("byte_count")?,
            })
        })
        .transpose()
    }

    pub async fn llm_call_chunks(&self, call_id: &str) -> Result<Vec<LlmCallResponseChunk>> {
        let rows = sqlx::query("SELECT seq, received_offset_ms, data, byte_count FROM llm_call_response_chunks WHERE call_id = ? ORDER BY seq")
            .bind(call_id)
            .fetch_all(&self.pool)
            .await?;
        rows.into_iter()
            .map(|row| {
                Ok(LlmCallResponseChunk {
                    seq: row.try_get("seq")?,
                    received_offset_ms: row.try_get("received_offset_ms")?,
                    data: String::from_utf8_lossy(&row.try_get::<Vec<u8>, _>("data")?).into_owned(),
                    byte_count: row.try_get("byte_count")?,
                })
            })
            .collect()
    }
}

fn as_i64(value: Option<u64>) -> Option<i64> {
    value.map(|value| value.min(i64::MAX as u64) as i64)
}

fn summary_from_row(row: sqlx::sqlite::SqliteRow) -> Result<LlmCallSummary> {
    let usage = row.try_get::<Option<String>, _>("usage_json")?;
    let request_type: String = row.try_get("request_type")?;
    let status: String = row.try_get("status")?;
    let streaming: Option<bool> = row.try_get("streaming")?;
    let observed_thinking: bool = row.try_get("observed_thinking")?;
    let ttfo_ms: Option<i64> = row.try_get("ttfo_ms")?;
    let generation_ms: Option<i64> = row.try_get("generation_ms")?;
    let output_tokens: Option<i64> = row.try_get("output_tokens")?;
    let reasoning_tokens: Option<i64> = row.try_get("reasoning_tokens")?;
    let input_tokens: Option<i64> = row.try_get("input_tokens")?;
    let cache_read_tokens: Option<i64> = row.try_get("cache_read_tokens")?;
    let cache_write_tokens: Option<i64> = row.try_get("cache_write_tokens")?;
    let billed_input_tokens = input_tokens.map(|raw_input| {
        if request_type == ProviderType::Anthropic.as_str() {
            raw_input.max(0)
        } else {
            raw_input
                .saturating_sub(cache_read_tokens.unwrap_or(0).max(0))
                .saturating_sub(cache_write_tokens.unwrap_or(0).max(0))
                .max(0)
        }
    });
    // Reasoning tokens reported without any observed thinking content hide part
    // of the generation window, so the rate is reported as an estimate.
    let performance = evaluate_performance(SpeedSample {
        status: &status,
        streaming,
        output_tokens,
        first_output_ms: ttfo_ms,
        generation_ms,
        duration_ms: row.try_get("duration_ms")?,
        tokens_estimated: false,
        hidden_reasoning: reasoning_tokens.unwrap_or(0) > 0 && !observed_thinking,
    });

    Ok(LlmCallSummary {
        call_id: row.try_get("call_id")?,
        run_id: row.try_get("run_id")?,
        conversation_id: row.try_get("conversation_id")?,
        provider_call_index: row.try_get("provider_call_index")?,
        model_hash: row.try_get("model_hash")?,
        supplier_key: row.try_get("supplier_key")?,
        endpoint_key: row.try_get("endpoint_key")?,
        provider_type: row.try_get("provider_type")?,
        provider_url: row.try_get("provider_url")?,
        request_type,
        request_url: row.try_get("request_url")?,
        model_id: row.try_get("model_id")?,
        display_name: row.try_get("display_name")?,
        reasoning_effort: row.try_get("reasoning_effort")?,
        fast: Some(row.try_get("fast")?),
        status,
        finish_reason: row.try_get("finish_reason")?,
        created_at_ms: row.try_get("created_at_ms")?,
        request_started_at_ms: row.try_get("request_started_at_ms")?,
        response_headers_at_ms: row.try_get("response_headers_at_ms")?,
        first_event_at_ms: row.try_get("first_event_at_ms")?,
        first_text_at_ms: row.try_get("first_text_at_ms")?,
        first_valid_response_at_ms: row.try_get("first_valid_response_at_ms")?,
        first_output_at_ms: row.try_get("first_output_at_ms")?,
        finished_at_ms: row.try_get("finished_at_ms")?,
        queue_ms: row.try_get("queue_ms")?,
        ttfb_ms: row.try_get("ttfb_ms")?,
        ttft_ms: row.try_get("ttft_ms")?,
        ttfr_ms: row.try_get("ttfr_ms")?,
        ttfo_ms,
        duration_ms: row.try_get("duration_ms")?,
        generation_ms,
        streaming,
        call_origin: row.try_get("call_origin")?,
        observed_thinking,
        performance,
        input_tokens,
        billed_input_tokens,
        output_tokens,
        total_tokens: row.try_get("total_tokens")?,
        cache_read_tokens,
        cache_write_tokens,
        reasoning_tokens,
        usage: usage
            .map(|value| serde_json::from_str(&value))
            .transpose()?,
        pricing_source: row.try_get("pricing_source")?,
        pricing_provider_id: row.try_get("pricing_provider_id")?,
        pricing_model_id: row.try_get("pricing_model_id")?,
        pricing_snapshot_at_ms: row.try_get("pricing_snapshot_at_ms")?,
        unit_input_per_million: row.try_get("unit_input_per_million")?,
        unit_output_per_million: row.try_get("unit_output_per_million")?,
        unit_cache_read_per_million: row.try_get("unit_cache_read_per_million")?,
        unit_cache_write_per_million: row.try_get("unit_cache_write_per_million")?,
        cost_status: row.try_get("cost_status")?,
        input_cost: row
            .try_get::<Option<i64>, _>("input_cost_nano")?
            .map(format_nano_usd),
        output_cost: row
            .try_get::<Option<i64>, _>("output_cost_nano")?
            .map(format_nano_usd),
        cache_read_cost: row
            .try_get::<Option<i64>, _>("cache_read_cost_nano")?
            .map(format_nano_usd),
        cache_write_cost: row
            .try_get::<Option<i64>, _>("cache_write_cost_nano")?
            .map(format_nano_usd),
        total_cost: row
            .try_get::<Option<i64>, _>("total_cost_nano")?
            .map(format_nano_usd),
        cost_calculated_at_ms: row.try_get("cost_calculated_at_ms")?,
        cost_backfilled: row.try_get("cost_backfilled")?,
        message_count: row.try_get("message_count")?,
        tool_count: row.try_get("tool_count")?,
        request_bytes: row.try_get("request_bytes")?,
        response_bytes: row.try_get("response_bytes")?,
        stream_event_count: row.try_get("stream_event_count")?,
        http_status: row.try_get("http_status")?,
        error_kind: row.try_get("error_kind")?,
        error_message: row.try_get("error_message")?,
        detailed: row.try_get("detailed")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{CallOrigin, ProviderType};

    /// 插件模型不在 model_configs 中,调用记录必须照常落库并可按其稳定供应商键筛选。
    #[tokio::test]
    async fn plugin_calls_record_without_a_model_config_row() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::connect(&format!(
            "sqlite://{}",
            directory.path().join("test.db").display()
        ))
        .await
        .unwrap();
        let plugin_model = "plugin:dev.example/codex/gpt-test";
        store
            .start_llm_call(&NewLlmCall {
                call_id: "plugin-call".into(),
                run_id: "run".into(),
                conversation_id: "conversation".into(),
                provider_call_index: 0,
                model_hash: plugin_model.into(),
                provider_type: ProviderType::Plugin,
                provider_url: "plugin://dev.example/codex".into(),
                request_type: ProviderType::Plugin,
                request_url: "plugin://dev.example/codex".into(),
                model_id: "gpt-test".into(),
                display_name: "GPT Test".into(),
                reasoning_effort: None,
                fast: false,
                message_count: 1,
                tool_count: 0,
                detailed: false,
                origin: CallOrigin::Run,
                streaming: true,
            })
            .await
            .unwrap();
        store
            .finish_llm_call(
                "plugin-call",
                CallFinish {
                    status: "completed",
                    finish_reason: None,
                    elapsed_ms: 10,
                    generation_ms: None,
                    error_kind: None,
                    error_message: None,
                },
            )
            .await
            .unwrap();
        let overview = store
            .overview(
                None,
                None,
                Some(&format!("[\"{plugin_model}\"]")),
                None,
                None,
            )
            .await
            .unwrap();
        assert_eq!(overview.metrics.llm_calls, 1);
        assert_eq!(overview.metrics.successful_calls, 1);
        assert_eq!(overview.metrics.incomplete_usage_calls, 1);
    }

    #[tokio::test]
    async fn thinking_observed_after_the_first_output_keeps_both_facts() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::connect(&format!(
            "sqlite://{}",
            directory.path().join("test.db").display()
        ))
        .await
        .unwrap();
        store
            .start_llm_call(&NewLlmCall {
                call_id: "text-then-thinking".into(),
                run_id: "run".into(),
                conversation_id: "conversation".into(),
                provider_call_index: 0,
                model_hash: "mh".into(),
                provider_type: ProviderType::Anthropic,
                provider_url: "https://example.com/v1".into(),
                request_type: ProviderType::Anthropic,
                request_url: "https://example.com/v1/messages".into(),
                model_id: "claude".into(),
                display_name: "Claude".into(),
                reasoning_effort: None,
                fast: false,
                message_count: 1,
                tool_count: 0,
                detailed: false,
                origin: CallOrigin::Run,
                streaming: true,
            })
            .await
            .unwrap();

        // Text arrives first, so the first-output wait is fixed here.
        store
            .record_llm_output("text-then-thinking", Some(400), false)
            .await
            .unwrap();
        // Reasoning follows; it must not move the first-output time but must be
        // remembered, otherwise the rate would be marked as an estimate.
        store
            .record_llm_output("text-then-thinking", None, true)
            .await
            .unwrap();

        let call = store
            .llm_call("text-then-thinking")
            .await
            .unwrap()
            .expect("call record");
        assert_eq!(call.ttfo_ms, Some(400));
        assert!(call.observed_thinking);
    }

    #[tokio::test]
    async fn latest_context_usage_follows_conversation_chronology() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::connect(&format!(
            "sqlite://{}",
            directory.path().join("test.db").display()
        ))
        .await
        .unwrap();

        for (call_id, model_id, context_input_tokens, message_count) in [
            ("call-a-1", "model-a", 100_u64, 3_usize),
            ("call-b", "model-b", 200_u64, 5_usize),
            ("call-a-2", "model-a", 300_u64, 7_usize),
        ] {
            store
                .start_llm_call(&NewLlmCall {
                    call_id: call_id.into(),
                    run_id: format!("run-{call_id}"),
                    conversation_id: "conversation".into(),
                    provider_call_index: 0,
                    model_hash: model_id.into(),
                    provider_type: ProviderType::Plugin,
                    provider_url: "plugin://test".into(),
                    request_type: ProviderType::Plugin,
                    request_url: "plugin://test".into(),
                    model_id: model_id.into(),
                    display_name: model_id.into(),
                    reasoning_effort: None,
                    fast: false,
                    message_count,
                    tool_count: 0,
                    detailed: false,
                    origin: CallOrigin::Run,
                    streaming: true,
                })
                .await
                .unwrap();
            store
                .record_llm_usage(
                    call_id,
                    Usage {
                        input_tokens: Some(context_input_tokens),
                        context_input_tokens: Some(context_input_tokens),
                        output_tokens: Some(10),
                        total_tokens: Some(context_input_tokens + 10),
                        ..Default::default()
                    },
                )
                .await
                .unwrap();
        }

        assert_eq!(
            store.latest_context_usage("conversation").await.unwrap(),
            Some(ContextUsageAnchor {
                context_input_tokens: 300,
                message_count: 7,
            })
        );
        assert_eq!(store.latest_context_usage("other").await.unwrap(), None);
    }
}

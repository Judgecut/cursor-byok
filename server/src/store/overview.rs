//! Efficient SQLite aggregates for the desktop overview dashboard, cost trends,
//! model -> supplier breakdowns, and filter model lists.

use std::{
    collections::{BTreeMap, HashMap},
    str::FromStr,
};

use chrono::Utc;
use sqlx::Row;

use crate::{
    model::{
        Overview, OverviewFilterModel, OverviewMetrics, OverviewModelSummary,
        OverviewSupplierSummary, ProviderType, SpeedAggregate, SpeedSampleTotals, TokenUsageBucket,
        TokenUsageGranularity, MIN_SPEED_GENERATION_MS, MIN_SPEED_OUTPUT_TOKENS,
    },
    plugin::PluginModelDescriptor,
    pricing::{
        canonical_supplier_identity, divide_nano_round_half_up, endpoint_host, format_nano_usd,
        SourceKind,
    },
    Error, Result,
};

use super::Store;

const OVERVIEW_DAYS: u64 = 365;
const MAX_RANGE_BUCKETS: i64 = 60;
const MAX_EXPLICIT_BUCKETS: i64 = 1440;
const MINUTE_MS: i64 = 60_000;
const HOUR_MS: i64 = 60 * MINUTE_MS;
const DAY_MS: i64 = 24 * HOUR_MS;

impl Store {
    pub async fn overview(
        &self,
        start_ms: Option<i64>,
        end_ms: Option<i64>,
        supplier_keys: Option<&str>,
        bucket_ms: Option<i64>,
    ) -> Result<Overview> {
        self.overview_with_plugins(start_ms, end_ms, supplier_keys, bucket_ms, &[])
            .await
    }

    pub async fn overview_with_plugins(
        &self,
        start_ms: Option<i64>,
        end_ms: Option<i64>,
        supplier_keys: Option<&str>,
        bucket_ms: Option<i64>,
        plugin_models: &[PluginModelDescriptor],
    ) -> Result<Overview> {
        let supplier_keys_json = normalize_supplier_keys_filter(supplier_keys)?;

        let summary_row = sqlx::query(&format!(
            "SELECT
                COUNT(*) AS llm_calls,
                COALESCE(SUM(status = 'completed'), 0) AS successful_calls,
                COALESCE(SUM(status != 'completed'), 0) AS failed_calls,
                COALESCE(SUM({fresh_input}), 0) AS input_tokens,
                COALESCE(SUM(COALESCE(cache_read_tokens, 0)), 0) AS cache_read_tokens,
                COALESCE(SUM(COALESCE(cache_write_tokens, 0)), 0) AS cache_write_tokens,
                COALESCE(SUM(COALESCE(output_tokens, 0)), 0) AS output_tokens,
                COALESCE(SUM(CASE WHEN cost_status = 'priced' THEN COALESCE(input_cost_nano, 0) ELSE 0 END), 0) AS input_cost_nano,
                COALESCE(SUM(CASE WHEN cost_status = 'priced' THEN COALESCE(output_cost_nano, 0) ELSE 0 END), 0) AS output_cost_nano,
                COALESCE(SUM(CASE WHEN cost_status = 'priced' THEN COALESCE(cache_read_cost_nano, 0) ELSE 0 END), 0) AS cache_read_cost_nano,
                COALESCE(SUM(CASE WHEN cost_status = 'priced' THEN COALESCE(cache_write_cost_nano, 0) ELSE 0 END), 0) AS cache_write_cost_nano,
                COALESCE(SUM(CASE WHEN cost_status = 'priced' THEN COALESCE(total_cost_nano, 0) ELSE 0 END), 0) AS total_cost_nano,
                COALESCE(SUM(cost_status = 'priced'), 0) AS priced_calls,
                COALESCE(SUM(cost_status IS NULL OR cost_status = 'unpriced'), 0) AS unpriced_calls,
                COALESCE(SUM(cost_status = 'incomplete_usage'), 0) AS incomplete_usage_calls
             FROM llm_calls
             WHERE status != 'running'
               AND (? IS NULL OR created_at_ms >= ?)
               AND (? IS NULL OR created_at_ms < ?)
               AND (? IS NULL OR supplier_key IN (SELECT value FROM json_each(?)))",
            fresh_input = fresh_input_sql(),
        ))
        .bind(start_ms)
        .bind(start_ms)
        .bind(end_ms)
        .bind(end_ms)
        .bind(&supplier_keys_json)
        .bind(&supplier_keys_json)
        .fetch_one(&self.pool)
        .await?;

        let input_tokens = non_negative(summary_row.try_get("input_tokens")?);
        let cache_read_tokens = non_negative(summary_row.try_get("cache_read_tokens")?);
        let cache_write_tokens = non_negative(summary_row.try_get("cache_write_tokens")?);
        let output_tokens = non_negative(summary_row.try_get("output_tokens")?);
        let prompt_tokens = saturating_sum(&[input_tokens, cache_read_tokens, cache_write_tokens]);

        let input_cost_nano = non_negative(summary_row.try_get("input_cost_nano")?);
        let output_cost_nano = non_negative(summary_row.try_get("output_cost_nano")?);
        let cache_read_cost_nano = non_negative(summary_row.try_get("cache_read_cost_nano")?);
        let cache_write_cost_nano = non_negative(summary_row.try_get("cache_write_cost_nano")?);
        let total_cost_nano = non_negative(summary_row.try_get("total_cost_nano")?);
        let priced_calls = non_negative(summary_row.try_get("priced_calls")?);
        let unpriced_calls = non_negative(summary_row.try_get("unpriced_calls")?);
        let incomplete_usage_calls = non_negative(summary_row.try_get("incomplete_usage_calls")?);

        let metrics = OverviewMetrics {
            llm_calls: summary_row.try_get("llm_calls")?,
            successful_calls: summary_row.try_get("successful_calls")?,
            failed_calls: summary_row.try_get("failed_calls")?,
            token_usage: prompt_tokens.saturating_add(output_tokens),
            prompt_tokens,
            input_tokens,
            cache_read_tokens,
            cache_write_tokens,
            output_tokens,
            total_cost: format_nano_usd(total_cost_nano),
            input_cost: format_nano_usd(input_cost_nano),
            output_cost: format_nano_usd(output_cost_nano),
            cache_read_cost: format_nano_usd(cache_read_cost_nano),
            cache_write_cost: format_nano_usd(cache_write_cost_nano),
            average_priced_cost: divide_nano_round_half_up(total_cost_nano, priced_calls)
                .map(format_nano_usd),
            priced_calls,
            unpriced_calls,
            incomplete_usage_calls,
        };

        let (token_usage_granularity, bucket_ms, series_start_ms, bucket_count) =
            token_usage_buckets(start_ms, end_ms, bucket_ms);
        let series_rows = sqlx::query(&format!(
            "SELECT
                (created_at_ms / {bucket_ms}) * {bucket_ms} AS bucket_start_ms,
                COALESCE(SUM({fresh_input}), 0) AS input_tokens,
                COALESCE(SUM(COALESCE(cache_read_tokens, 0)), 0) AS cache_read_tokens,
                COALESCE(SUM(COALESCE(cache_write_tokens, 0)), 0) AS cache_write_tokens,
                COALESCE(SUM(COALESCE(output_tokens, 0)), 0) AS output_tokens,
                COALESCE(SUM(CASE WHEN cost_status = 'priced' THEN COALESCE(input_cost_nano, 0) ELSE 0 END), 0) AS input_cost_nano,
                COALESCE(SUM(CASE WHEN cost_status = 'priced' THEN COALESCE(output_cost_nano, 0) ELSE 0 END), 0) AS output_cost_nano,
                COALESCE(SUM(CASE WHEN cost_status = 'priced' THEN COALESCE(cache_read_cost_nano, 0) ELSE 0 END), 0) AS cache_read_cost_nano,
                COALESCE(SUM(CASE WHEN cost_status = 'priced' THEN COALESCE(cache_write_cost_nano, 0) ELSE 0 END), 0) AS cache_write_cost_nano,
                COALESCE(SUM(CASE WHEN cost_status = 'priced' THEN COALESCE(total_cost_nano, 0) ELSE 0 END), 0) AS total_cost_nano,
                COALESCE(SUM(cost_status = 'priced'), 0) AS priced_calls,
                COALESCE(SUM(cost_status IS NULL OR cost_status = 'unpriced'), 0) AS unpriced_calls,
                COALESCE(SUM(cost_status = 'incomplete_usage'), 0) AS incomplete_usage_calls
             FROM llm_calls
             WHERE status != 'running'
               AND created_at_ms >= ?
               AND (? IS NULL OR created_at_ms < ?)
               AND (? IS NULL OR supplier_key IN (SELECT value FROM json_each(?)))
             GROUP BY bucket_start_ms
             ORDER BY bucket_start_ms",
            fresh_input = fresh_input_sql(),
        ))
        .bind(start_ms.unwrap_or(series_start_ms).max(series_start_ms))
        .bind(end_ms)
        .bind(end_ms)
        .bind(&supplier_keys_json)
        .bind(&supplier_keys_json)
        .fetch_all(&self.pool)
        .await?;

        let mut recorded = series_rows
            .into_iter()
            .map(|row| {
                let bucket_start_ms: i64 = row.try_get("bucket_start_ms")?;
                Ok((
                    bucket_start_ms,
                    TokenUsageBucket {
                        bucket_start_ms,
                        input_tokens: non_negative(row.try_get("input_tokens")?),
                        cache_read_tokens: non_negative(row.try_get("cache_read_tokens")?),
                        cache_write_tokens: non_negative(row.try_get("cache_write_tokens")?),
                        output_tokens: non_negative(row.try_get("output_tokens")?),
                        input_cost: format_nano_usd(non_negative(row.try_get("input_cost_nano")?)),
                        output_cost: format_nano_usd(non_negative(
                            row.try_get("output_cost_nano")?,
                        )),
                        cache_read_cost: format_nano_usd(non_negative(
                            row.try_get("cache_read_cost_nano")?,
                        )),
                        cache_write_cost: format_nano_usd(non_negative(
                            row.try_get("cache_write_cost_nano")?,
                        )),
                        total_cost: format_nano_usd(non_negative(row.try_get("total_cost_nano")?)),
                        priced_calls: non_negative(row.try_get("priced_calls")?),
                        unpriced_calls: non_negative(row.try_get("unpriced_calls")?),
                        incomplete_usage_calls: non_negative(
                            row.try_get("incomplete_usage_calls")?,
                        ),
                    },
                ))
            })
            .collect::<Result<BTreeMap<_, _>>>()?;

        let token_usage_series = (0..bucket_count)
            .map(|offset| series_start_ms.saturating_add(offset.saturating_mul(bucket_ms)))
            .map(|bucket_start_ms| {
                recorded
                    .remove(&bucket_start_ms)
                    .unwrap_or(TokenUsageBucket {
                        bucket_start_ms,
                        ..TokenUsageBucket::default()
                    })
            })
            .collect();

        let (supplier_meta, available_models) = self.load_supplier_metadata(plugin_models).await?;
        let models = self
            .load_model_summaries(
                start_ms,
                end_ms,
                supplier_keys_json.as_deref(),
                &supplier_meta,
            )
            .await?;

        Ok(Overview {
            metrics,
            token_usage_granularity,
            token_usage_series,
            models,
            available_models,
        })
    }

    /// Sums eligible speed samples per supplier model, keeping measured and
    /// estimated samples apart so a rate always divides real totals.
    async fn load_speed_totals(
        &self,
        start_ms: Option<i64>,
        end_ms: Option<i64>,
        supplier_keys_json: Option<&str>,
    ) -> Result<HashMap<(String, String), SpeedSampleTotals>> {
        let eligible = speed_eligible_sql();
        let hidden = hidden_reasoning_sql();
        let rows = sqlx::query(&format!(
            "SELECT supplier_key, model_id,
                COALESCE(SUM(CASE WHEN {eligible} AND NOT ({hidden}) THEN output_tokens ELSE 0 END), 0) AS measured_output_tokens,
                COALESCE(SUM(CASE WHEN {eligible} AND NOT ({hidden}) THEN generation_ms ELSE 0 END), 0) AS measured_generation_ms,
                COALESCE(SUM(CASE WHEN {eligible} AND NOT ({hidden}) THEN 1 ELSE 0 END), 0) AS measured_samples,
                COALESCE(SUM(CASE WHEN {eligible} AND ({hidden}) THEN output_tokens ELSE 0 END), 0) AS estimated_output_tokens,
                COALESCE(SUM(CASE WHEN {eligible} AND ({hidden}) THEN generation_ms ELSE 0 END), 0) AS estimated_generation_ms,
                COALESCE(SUM(CASE WHEN {eligible} AND ({hidden}) THEN 1 ELSE 0 END), 0) AS estimated_samples
             FROM llm_calls
             WHERE (? IS NULL OR created_at_ms >= ?)
               AND (? IS NULL OR created_at_ms < ?)
               AND (? IS NULL OR supplier_key IN (SELECT value FROM json_each(?)))
             GROUP BY supplier_key, model_id"
        ))
        .bind(start_ms)
        .bind(start_ms)
        .bind(end_ms)
        .bind(end_ms)
        .bind(supplier_keys_json)
        .bind(supplier_keys_json)
        .fetch_all(&self.pool)
        .await?;

        rows.into_iter()
            .map(|row| {
                let key = (
                    row.try_get::<String, _>("supplier_key")?,
                    row.try_get::<String, _>("model_id")?,
                );
                Ok((
                    key,
                    SpeedSampleTotals {
                        measured_output_tokens: non_negative(
                            row.try_get("measured_output_tokens")?,
                        ),
                        measured_generation_ms: non_negative(
                            row.try_get("measured_generation_ms")?,
                        ),
                        measured_samples: non_negative(row.try_get("measured_samples")?),
                        estimated_output_tokens: non_negative(
                            row.try_get("estimated_output_tokens")?,
                        ),
                        estimated_generation_ms: non_negative(
                            row.try_get("estimated_generation_ms")?,
                        ),
                        estimated_samples: non_negative(row.try_get("estimated_samples")?),
                    },
                ))
            })
            .collect()
    }

    /// Median first-output wait of successful streamed calls, grouped by either
    /// `supplier_key, model_id` or `model_id` alone. The median ignores the speed
    /// sample minimum because it measures the wait, not the rate.
    async fn load_first_output_medians(
        &self,
        start_ms: Option<i64>,
        end_ms: Option<i64>,
        supplier_keys_json: Option<&str>,
        group_by: &str,
        include_supplier_key: bool,
    ) -> Result<HashMap<(String, String), i64>> {
        let supplier_select = if include_supplier_key {
            "supplier_key"
        } else {
            "'' AS supplier_key"
        };
        let rows = sqlx::query(&format!(
            "SELECT {supplier_select}, model_id, CAST(AVG(ttfo_ms) AS INTEGER) AS median_ms
             FROM (
               SELECT supplier_key, model_id, ttfo_ms,
                 ROW_NUMBER() OVER (PARTITION BY {group_by} ORDER BY ttfo_ms) AS rn,
                 COUNT(*) OVER (PARTITION BY {group_by}) AS cnt
               FROM llm_calls
               WHERE {eligible}
                 AND ttfo_ms IS NOT NULL
                 AND (? IS NULL OR created_at_ms >= ?)
                 AND (? IS NULL OR created_at_ms < ?)
                 AND (? IS NULL OR supplier_key IN (SELECT value FROM json_each(?)))
             )
             WHERE rn IN ((cnt + 1) / 2, (cnt + 2) / 2)
             GROUP BY {group_by}",
            eligible = first_output_eligible_sql(),
        ))
        .bind(start_ms)
        .bind(start_ms)
        .bind(end_ms)
        .bind(end_ms)
        .bind(supplier_keys_json)
        .bind(supplier_keys_json)
        .fetch_all(&self.pool)
        .await?;

        rows.into_iter()
            .map(|row| {
                Ok((
                    (
                        row.try_get::<String, _>("supplier_key")?,
                        row.try_get::<String, _>("model_id")?,
                    ),
                    row.try_get::<Option<i64>, _>("median_ms")?.unwrap_or(0),
                ))
            })
            .collect()
    }

    async fn load_supplier_metadata(
        &self,
        plugin_models: &[PluginModelDescriptor],
    ) -> Result<(HashMap<String, SupplierMetadata>, Vec<OverviewFilterModel>)> {
        let mut groups_by_supplier: HashMap<String, String> = HashMap::new();
        for model in self.models().await? {
            if let Ok(request_url) = model.request_url() {
                let identity = canonical_supplier_identity(
                    model.provider_type(),
                    &request_url,
                    &model.base_url,
                    &model.model_id,
                );
                let group = model
                    .group_name
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_owned)
                    .or_else(|| endpoint_host(&identity.endpoint_key))
                    .unwrap_or_else(|| identity.endpoint_key.clone());
                groups_by_supplier
                    .entry(identity.supplier_key)
                    .or_insert(group);
            }
        }
        for plugin in plugin_models {
            let endpoint_url = format!("plugin://{}/{}", plugin.plugin_id, plugin.provider_id);
            let identity = canonical_supplier_identity(
                ProviderType::Plugin,
                &endpoint_url,
                &endpoint_url,
                &plugin.model_id,
            );
            groups_by_supplier
                .entry(identity.supplier_key)
                .or_insert_with(|| plugin.plugin_name.clone());
        }

        let pricing_views = self.supplier_pricing_models(plugin_models).await?;
        let mut metadata = HashMap::with_capacity(pricing_views.len());
        let mut available_models = Vec::new();

        for view in pricing_views {
            let group = groups_by_supplier
                .get(&view.supplier_key)
                .cloned()
                .or_else(|| endpoint_host(&view.endpoint_key))
                .unwrap_or_else(|| view.endpoint_key.clone());

            if view.active || view.call_count > 0 {
                available_models.push(OverviewFilterModel {
                    supplier_key: view.supplier_key.clone(),
                    source_kind: view.source_kind.as_str().to_owned(),
                    endpoint_key: view.endpoint_key.clone(),
                    model_id: view.model_id.clone(),
                    label: view.display_name.clone(),
                    group: group.clone(),
                    provider_type: view.provider_type.clone(),
                    plugin_icon: view.plugin_icon.clone(),
                    active: view.active,
                });
            }

            metadata.insert(
                view.supplier_key,
                SupplierMetadata {
                    source_kind: view.source_kind,
                    endpoint_key: view.endpoint_key,
                    label: view.display_name,
                    provider_type: view.provider_type,
                    active: view.active,
                    pricing_source: view.effective_source.as_str().to_owned(),
                },
            );
        }

        Ok((metadata, available_models))
    }

    async fn load_model_summaries(
        &self,
        start_ms: Option<i64>,
        end_ms: Option<i64>,
        supplier_keys_json: Option<&str>,
        metadata: &HashMap<String, SupplierMetadata>,
    ) -> Result<Vec<OverviewModelSummary>> {
        let rows = sqlx::query(&format!(
            "SELECT
                supplier_key,
                endpoint_key,
                model_id,
                MAX(request_type) AS request_type,
                MAX(request_url) AS request_url,
                MAX(provider_url) AS provider_url,
                MAX(display_name) AS latest_display_name,
                COUNT(*) AS llm_calls,
                COALESCE(SUM(status = 'completed'), 0) AS successful_calls,
                COALESCE(SUM(status != 'completed'), 0) AS failed_calls,
                COALESCE(SUM({fresh_input}), 0) AS input_tokens,
                COALESCE(SUM(COALESCE(cache_read_tokens, 0)), 0) AS cache_read_tokens,
                COALESCE(SUM(COALESCE(cache_write_tokens, 0)), 0) AS cache_write_tokens,
                COALESCE(SUM(COALESCE(output_tokens, 0)), 0) AS output_tokens,
                COALESCE(SUM(CASE WHEN cost_status = 'priced' THEN COALESCE(input_cost_nano, 0) ELSE 0 END), 0) AS input_cost_nano,
                COALESCE(SUM(CASE WHEN cost_status = 'priced' THEN COALESCE(output_cost_nano, 0) ELSE 0 END), 0) AS output_cost_nano,
                COALESCE(SUM(CASE WHEN cost_status = 'priced' THEN COALESCE(cache_read_cost_nano, 0) ELSE 0 END), 0) AS cache_read_cost_nano,
                COALESCE(SUM(CASE WHEN cost_status = 'priced' THEN COALESCE(cache_write_cost_nano, 0) ELSE 0 END), 0) AS cache_write_cost_nano,
                COALESCE(SUM(CASE WHEN cost_status = 'priced' THEN COALESCE(total_cost_nano, 0) ELSE 0 END), 0) AS total_cost_nano,
                COALESCE(SUM(cost_status = 'priced'), 0) AS priced_calls,
                COALESCE(SUM(cost_status IS NULL OR cost_status = 'unpriced'), 0) AS unpriced_calls,
                COALESCE(SUM(cost_status = 'incomplete_usage'), 0) AS incomplete_usage_calls
             FROM llm_calls
             WHERE status != 'running'
               AND (? IS NULL OR created_at_ms >= ?)
               AND (? IS NULL OR created_at_ms < ?)
               AND (? IS NULL OR supplier_key IN (SELECT value FROM json_each(?)))
             GROUP BY supplier_key, endpoint_key, model_id",
            fresh_input = fresh_input_sql(),
        ))
        .bind(start_ms)
        .bind(start_ms)
        .bind(end_ms)
        .bind(end_ms)
        .bind(supplier_keys_json)
        .bind(supplier_keys_json)
        .fetch_all(&self.pool)
        .await?;

        #[derive(Default)]
        struct SupplierAccum {
            source_kind: String,
            endpoint_key: String,
            model_id: String,
            label: String,
            provider_type: String,
            active: bool,
            pricing_source: String,
            llm_calls: i64,
            successful_calls: i64,
            failed_calls: i64,
            input_tokens: i64,
            cache_read_tokens: i64,
            cache_write_tokens: i64,
            output_tokens: i64,
            input_cost_nano: i64,
            output_cost_nano: i64,
            cache_read_cost_nano: i64,
            cache_write_cost_nano: i64,
            total_cost_nano: i64,
            priced_calls: i64,
            unpriced_calls: i64,
            incomplete_usage_calls: i64,
            speed: SpeedSampleTotals,
            first_output_median_ms: Option<i64>,
        }

        let mut by_model: BTreeMap<String, BTreeMap<String, SupplierAccum>> = BTreeMap::new();

        for row in rows {
            let model_id: String = row.try_get("model_id")?;
            let request_type_raw: String = row.try_get("request_type")?;
            let request_url: String = row.try_get("request_url")?;
            let provider_url: String = row.try_get("provider_url")?;
            let request_type =
                ProviderType::from_str(&request_type_raw).unwrap_or(ProviderType::OpenAiChat);
            let fallback_identity =
                canonical_supplier_identity(request_type, &request_url, &provider_url, &model_id);
            let supplier_key = row
                .try_get::<Option<String>, _>("supplier_key")?
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| fallback_identity.supplier_key.clone());
            let endpoint_key = row
                .try_get::<Option<String>, _>("endpoint_key")?
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| fallback_identity.endpoint_key.clone());
            let latest_display_name: String = row.try_get("latest_display_name")?;
            let meta = metadata.get(&supplier_key);
            let source_kind = meta
                .map(|item| item.source_kind.as_str().to_owned())
                .unwrap_or_else(|| {
                    if request_type == ProviderType::Plugin || endpoint_key.starts_with("plugin://")
                    {
                        SourceKind::Plugin.as_str().to_owned()
                    } else {
                        SourceKind::Builtin.as_str().to_owned()
                    }
                });

            let acc = by_model
                .entry(model_id.clone())
                .or_default()
                .entry(supplier_key)
                .or_insert_with(|| SupplierAccum {
                    source_kind,
                    endpoint_key: meta
                        .map(|item| item.endpoint_key.clone())
                        .unwrap_or(endpoint_key),
                    model_id: model_id.clone(),
                    label: meta
                        .map(|item| item.label.clone())
                        .unwrap_or(latest_display_name),
                    provider_type: meta
                        .map(|item| item.provider_type.clone())
                        .unwrap_or(request_type_raw),
                    active: meta.is_some_and(|item| item.active),
                    pricing_source: meta
                        .map(|item| item.pricing_source.clone())
                        .unwrap_or_else(|| "unpriced".into()),
                    ..SupplierAccum::default()
                });

            acc.llm_calls += non_negative(row.try_get("llm_calls")?);
            acc.successful_calls += non_negative(row.try_get("successful_calls")?);
            acc.failed_calls += non_negative(row.try_get("failed_calls")?);
            acc.input_tokens = acc
                .input_tokens
                .saturating_add(non_negative(row.try_get("input_tokens")?));
            acc.cache_read_tokens = acc
                .cache_read_tokens
                .saturating_add(non_negative(row.try_get("cache_read_tokens")?));
            acc.cache_write_tokens = acc
                .cache_write_tokens
                .saturating_add(non_negative(row.try_get("cache_write_tokens")?));
            acc.output_tokens = acc
                .output_tokens
                .saturating_add(non_negative(row.try_get("output_tokens")?));
            acc.input_cost_nano = acc
                .input_cost_nano
                .saturating_add(non_negative(row.try_get("input_cost_nano")?));
            acc.output_cost_nano = acc
                .output_cost_nano
                .saturating_add(non_negative(row.try_get("output_cost_nano")?));
            acc.cache_read_cost_nano = acc
                .cache_read_cost_nano
                .saturating_add(non_negative(row.try_get("cache_read_cost_nano")?));
            acc.cache_write_cost_nano = acc
                .cache_write_cost_nano
                .saturating_add(non_negative(row.try_get("cache_write_cost_nano")?));
            acc.total_cost_nano = acc
                .total_cost_nano
                .saturating_add(non_negative(row.try_get("total_cost_nano")?));
            acc.priced_calls += non_negative(row.try_get("priced_calls")?);
            acc.unpriced_calls += non_negative(row.try_get("unpriced_calls")?);
            acc.incomplete_usage_calls += non_negative(row.try_get("incomplete_usage_calls")?);
        }

        let speed_totals = self
            .load_speed_totals(start_ms, end_ms, supplier_keys_json)
            .await?;
        let supplier_medians = self
            .load_first_output_medians(
                start_ms,
                end_ms,
                supplier_keys_json,
                "supplier_key, model_id",
                true,
            )
            .await?;
        let model_medians = self
            .load_first_output_medians(start_ms, end_ms, supplier_keys_json, "model_id", false)
            .await?;
        for suppliers in by_model.values_mut() {
            for (supplier_key, acc) in suppliers {
                if let Some(totals) =
                    speed_totals.get(&(supplier_key.clone(), acc.model_id.clone()))
                {
                    acc.speed = *totals;
                }
                acc.first_output_median_ms = supplier_medians
                    .get(&(supplier_key.clone(), acc.model_id.clone()))
                    .copied();
            }
        }

        let mut models_with_sort: Vec<(i64, OverviewModelSummary)> = by_model
            .into_iter()
            .map(|(model_id, suppliers)| {
                let mut parent_calls = 0_i64;
                let mut parent_success = 0_i64;
                let mut parent_failed = 0_i64;
                let mut parent_input_tokens = 0_i64;
                let mut parent_cache_read_tokens = 0_i64;
                let mut parent_cache_write_tokens = 0_i64;
                let mut parent_output_tokens = 0_i64;
                let mut parent_input_cost_nano = 0_i64;
                let mut parent_output_cost_nano = 0_i64;
                let mut parent_cache_read_cost_nano = 0_i64;
                let mut parent_cache_write_cost_nano = 0_i64;
                let mut parent_total_cost_nano = 0_i64;
                let mut parent_priced_calls = 0_i64;
                let mut parent_unpriced_calls = 0_i64;
                let mut parent_incomplete_calls = 0_i64;
                let mut parent_speed = SpeedSampleTotals::default();

                let mut provider_entries: Vec<(i64, OverviewSupplierSummary)> = suppliers
                    .into_iter()
                    .map(|(supplier_key, acc)| {
                        parent_calls += acc.llm_calls;
                        parent_success += acc.successful_calls;
                        parent_failed += acc.failed_calls;
                        parent_input_tokens = parent_input_tokens.saturating_add(acc.input_tokens);
                        parent_cache_read_tokens =
                            parent_cache_read_tokens.saturating_add(acc.cache_read_tokens);
                        parent_cache_write_tokens =
                            parent_cache_write_tokens.saturating_add(acc.cache_write_tokens);
                        parent_output_tokens =
                            parent_output_tokens.saturating_add(acc.output_tokens);
                        parent_input_cost_nano =
                            parent_input_cost_nano.saturating_add(acc.input_cost_nano);
                        parent_output_cost_nano =
                            parent_output_cost_nano.saturating_add(acc.output_cost_nano);
                        parent_cache_read_cost_nano =
                            parent_cache_read_cost_nano.saturating_add(acc.cache_read_cost_nano);
                        parent_cache_write_cost_nano =
                            parent_cache_write_cost_nano.saturating_add(acc.cache_write_cost_nano);
                        parent_total_cost_nano =
                            parent_total_cost_nano.saturating_add(acc.total_cost_nano);
                        parent_priced_calls += acc.priced_calls;
                        parent_unpriced_calls += acc.unpriced_calls;
                        parent_incomplete_calls += acc.incomplete_usage_calls;
                        parent_speed += acc.speed;

                        let prompt_tokens = saturating_sum(&[
                            acc.input_tokens,
                            acc.cache_read_tokens,
                            acc.cache_write_tokens,
                        ]);
                        (
                            acc.total_cost_nano,
                            OverviewSupplierSummary {
                                supplier_key,
                                source_kind: acc.source_kind,
                                endpoint_key: acc.endpoint_key,
                                model_id: acc.model_id,
                                label: acc.label,
                                provider_type: acc.provider_type,
                                active: acc.active,
                                pricing_source: acc.pricing_source,
                                llm_calls: acc.llm_calls,
                                successful_calls: acc.successful_calls,
                                failed_calls: acc.failed_calls,
                                token_usage: prompt_tokens.saturating_add(acc.output_tokens),
                                prompt_tokens,
                                input_tokens: acc.input_tokens,
                                cache_read_tokens: acc.cache_read_tokens,
                                cache_write_tokens: acc.cache_write_tokens,
                                output_tokens: acc.output_tokens,
                                total_cost: format_nano_usd(acc.total_cost_nano),
                                input_cost: format_nano_usd(acc.input_cost_nano),
                                output_cost: format_nano_usd(acc.output_cost_nano),
                                cache_read_cost: format_nano_usd(acc.cache_read_cost_nano),
                                cache_write_cost: format_nano_usd(acc.cache_write_cost_nano),
                                average_priced_cost: divide_nano_round_half_up(
                                    acc.total_cost_nano,
                                    acc.priced_calls,
                                )
                                .map(format_nano_usd),
                                priced_calls: acc.priced_calls,
                                unpriced_calls: acc.unpriced_calls,
                                incomplete_usage_calls: acc.incomplete_usage_calls,
                                speed: SpeedAggregate::from_totals(
                                    acc.speed,
                                    acc.first_output_median_ms,
                                ),
                            },
                        )
                    })
                    .collect();

                provider_entries.sort_by(|(cost_a, item_a), (cost_b, item_b)| {
                    cost_b
                        .cmp(cost_a)
                        .then_with(|| item_b.llm_calls.cmp(&item_a.llm_calls))
                        .then_with(|| {
                            item_a
                                .label
                                .to_lowercase()
                                .cmp(&item_b.label.to_lowercase())
                        })
                        .then_with(|| item_a.supplier_key.cmp(&item_b.supplier_key))
                });
                let providers = provider_entries.into_iter().map(|(_, item)| item).collect();
                let parent_prompt_tokens = saturating_sum(&[
                    parent_input_tokens,
                    parent_cache_read_tokens,
                    parent_cache_write_tokens,
                ]);
                let parent_first_output_median_ms = model_medians
                    .get(&(String::new(), model_id.clone()))
                    .copied();
                (
                    parent_total_cost_nano,
                    OverviewModelSummary {
                        model_id,
                        llm_calls: parent_calls,
                        successful_calls: parent_success,
                        failed_calls: parent_failed,
                        token_usage: parent_prompt_tokens.saturating_add(parent_output_tokens),
                        prompt_tokens: parent_prompt_tokens,
                        input_tokens: parent_input_tokens,
                        cache_read_tokens: parent_cache_read_tokens,
                        cache_write_tokens: parent_cache_write_tokens,
                        output_tokens: parent_output_tokens,
                        total_cost: format_nano_usd(parent_total_cost_nano),
                        input_cost: format_nano_usd(parent_input_cost_nano),
                        output_cost: format_nano_usd(parent_output_cost_nano),
                        cache_read_cost: format_nano_usd(parent_cache_read_cost_nano),
                        cache_write_cost: format_nano_usd(parent_cache_write_cost_nano),
                        average_priced_cost: divide_nano_round_half_up(
                            parent_total_cost_nano,
                            parent_priced_calls,
                        )
                        .map(format_nano_usd),
                        priced_calls: parent_priced_calls,
                        unpriced_calls: parent_unpriced_calls,
                        incomplete_usage_calls: parent_incomplete_calls,
                        speed: SpeedAggregate::from_totals(
                            parent_speed,
                            parent_first_output_median_ms,
                        ),
                        providers,
                    },
                )
            })
            .collect();

        models_with_sort.sort_by(|(cost_a, item_a), (cost_b, item_b)| {
            cost_b
                .cmp(cost_a)
                .then_with(|| item_b.llm_calls.cmp(&item_a.llm_calls))
                .then_with(|| item_a.model_id.cmp(&item_b.model_id))
        });

        Ok(models_with_sort.into_iter().map(|(_, item)| item).collect())
    }
}

struct SupplierMetadata {
    source_kind: SourceKind,
    endpoint_key: String,
    label: String,
    provider_type: String,
    active: bool,
    pricing_source: String,
}

fn normalize_supplier_keys_filter(supplier_keys: Option<&str>) -> Result<Option<String>> {
    let Some(raw) = supplier_keys
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    let keys: Vec<String> = serde_json::from_str(raw)
        .map_err(|_| Error::Config("supplier_keys must be a JSON array of strings".into()))?;
    if keys.is_empty() {
        return Ok(None);
    }
    Ok(Some(serde_json::to_string(&keys)?))
}

fn token_usage_buckets(
    start_ms: Option<i64>,
    end_ms: Option<i64>,
    requested_bucket_ms: Option<i64>,
) -> (TokenUsageGranularity, i64, i64, i64) {
    if let (Some(start_ms), Some(end_ms)) = (start_ms, end_ms) {
        let duration_ms = end_ms.saturating_sub(start_ms).max(1);
        let explicit_bucket_ms = requested_bucket_ms.filter(|bucket_ms| *bucket_ms >= MINUTE_MS);
        let bucket_ms = explicit_bucket_ms.unwrap_or({
            if duration_ms <= HOUR_MS {
                MINUTE_MS
            } else if duration_ms <= MAX_RANGE_BUCKETS * HOUR_MS {
                HOUR_MS
            } else {
                DAY_MS
            }
        });
        let granularity = if bucket_ms < HOUR_MS {
            TokenUsageGranularity::Minute
        } else if bucket_ms < DAY_MS {
            TokenUsageGranularity::Hour
        } else {
            TokenUsageGranularity::Day
        };
        let max_buckets = if explicit_bucket_ms.is_some() {
            MAX_EXPLICIT_BUCKETS
        } else {
            MAX_RANGE_BUCKETS
        };
        let last_bucket_ms = end_ms.saturating_sub(1).div_euclid(bucket_ms) * bucket_ms;
        let first_bucket_ms = start_ms.div_euclid(bucket_ms) * bucket_ms;
        let bucket_count =
            ((last_bucket_ms - first_bucket_ms).div_euclid(bucket_ms) + 1).clamp(1, max_buckets);
        let series_start_ms =
            last_bucket_ms.saturating_sub((bucket_count - 1).saturating_mul(bucket_ms));
        return (granularity, bucket_ms, series_start_ms, bucket_count);
    }

    let today_start_ms = Utc::now()
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .map(|value| value.and_utc().timestamp_millis())
        .unwrap_or(0);
    let series_start_ms = today_start_ms.saturating_sub(
        i64::try_from(OVERVIEW_DAYS - 1)
            .unwrap_or(0)
            .saturating_mul(DAY_MS),
    );
    (
        TokenUsageGranularity::Day,
        DAY_MS,
        series_start_ms,
        i64::try_from(OVERVIEW_DAYS).unwrap_or(0),
    )
}

/// A call contributes a rate only when it succeeded, streamed, and produced enough
/// output over a long enough generation window.
fn speed_eligible_sql() -> String {
    format!(
        "status = 'completed' AND COALESCE(streaming, 0) = 1 AND call_origin = 'run' \
         AND COALESCE(output_tokens, 0) >= {MIN_SPEED_OUTPUT_TOKENS} \
         AND COALESCE(generation_ms, 0) >= {MIN_SPEED_GENERATION_MS}"
    )
}

/// Billed reasoning tokens that no output event ever showed hide part of the
/// generation window, so such samples are aggregated as estimates.
fn hidden_reasoning_sql() -> &'static str {
    "(COALESCE(reasoning_tokens, 0) > 0 AND observed_thinking = 0)"
}

fn first_output_eligible_sql() -> &'static str {
    "status = 'completed' AND COALESCE(streaming, 0) = 1 AND call_origin = 'run'"
}

fn fresh_input_sql() -> &'static str {
    "CASE
        WHEN request_type = 'anthropic' THEN MAX(0, COALESCE(input_tokens, 0))
        ELSE MAX(0, COALESCE(input_tokens, 0)
            - COALESCE(cache_read_tokens, 0)
            - COALESCE(cache_write_tokens, 0))
     END"
}

fn non_negative(value: i64) -> i64 {
    value.max(0)
}

fn saturating_sum(values: &[i64]) -> i64 {
    values
        .iter()
        .fold(0_i64, |total, value| total.saturating_add(*value))
}

#[cfg(test)]
mod tests {
    use crate::{
        model::{CallOrigin, NewLlmCall, ProviderType, SpeedStatus, Usage},
        store::CallFinish,
    };

    use super::*;

    struct Sample<'a> {
        call_id: &'a str,
        origin: CallOrigin,
        output_tokens: u64,
        reasoning_tokens: u64,
        first_output_ms: i64,
        generation_ms: i64,
    }

    async fn record(store: &Store, sample: Sample<'_>) {
        store
            .start_llm_call(&NewLlmCall {
                call_id: sample.call_id.into(),
                run_id: "run".into(),
                conversation_id: "conversation".into(),
                provider_call_index: 0,
                model_hash: "mh".into(),
                provider_type: ProviderType::OpenAiChat,
                provider_url: "https://example.com/v1".into(),
                request_type: ProviderType::OpenAiChat,
                request_url: "https://example.com/v1/chat/completions".into(),
                model_id: "glm-4.6".into(),
                display_name: "GLM 4.6".into(),
                reasoning_effort: None,
                fast: false,
                message_count: 1,
                tool_count: 0,
                detailed: false,
                origin: sample.origin,
                streaming: true,
            })
            .await
            .unwrap();
        store
            .record_llm_output(sample.call_id, Some(sample.first_output_ms), false)
            .await
            .unwrap();
        store
            .record_llm_usage(
                sample.call_id,
                Usage {
                    input_tokens: Some(10),
                    output_tokens: Some(sample.output_tokens),
                    reasoning_tokens: Some(sample.reasoning_tokens),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        store
            .finish_llm_call(
                sample.call_id,
                CallFinish {
                    status: "completed",
                    finish_reason: Some("stop"),
                    elapsed_ms: sample.first_output_ms + sample.generation_ms,
                    generation_ms: Some(sample.generation_ms),
                    error_kind: None,
                    error_message: None,
                },
            )
            .await
            .unwrap();
    }

    /// Model tests must not pollute the business samples, short calls must not
    /// dilute the rate, and the median wait covers every successful streamed call.
    #[tokio::test]
    async fn speed_aggregates_pool_eligible_samples_and_exclude_model_tests() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::connect(&format!(
            "sqlite://{}",
            directory.path().join("test.db").display()
        ))
        .await
        .unwrap();

        record(
            &store,
            Sample {
                call_id: "measured",
                origin: CallOrigin::Run,
                output_tokens: 1_000,
                reasoning_tokens: 0,
                first_output_ms: 2_000,
                generation_ms: 10_000,
            },
        )
        .await;
        // Too few tokens to be a sample, but its wait still joins the median.
        record(
            &store,
            Sample {
                call_id: "short",
                origin: CallOrigin::Run,
                output_tokens: 50,
                reasoning_tokens: 0,
                first_output_ms: 300,
                generation_ms: 5_000,
            },
        )
        .await;
        // Hidden reasoning marks the sample as estimated.
        record(
            &store,
            Sample {
                call_id: "estimated",
                origin: CallOrigin::Run,
                output_tokens: 500,
                reasoning_tokens: 200,
                first_output_ms: 1_000,
                generation_ms: 5_000,
            },
        )
        .await;
        record(
            &store,
            Sample {
                call_id: "model-test",
                origin: CallOrigin::ModelTest,
                output_tokens: 4_000,
                reasoning_tokens: 0,
                first_output_ms: 50,
                generation_ms: 1_000,
            },
        )
        .await;

        let overview = store.overview(None, None, None, None).await.unwrap();
        let model = overview
            .models
            .iter()
            .find(|item| item.model_id == "glm-4.6")
            .expect("model summary");

        assert_eq!(model.speed.status, SpeedStatus::Measured);
        assert_eq!(model.speed.measured.samples, 1);
        assert_eq!(model.speed.measured.output_tokens, 1_000);
        assert_eq!(model.speed.estimated.samples, 1);
        assert!((model.speed.average_tokens_per_second.unwrap() - 100.0).abs() < 0.001);
        assert_eq!(model.speed.first_output_median_ms, Some(1_000));

        let provider = &model.providers[0];
        assert_eq!(provider.speed.status, SpeedStatus::Measured);
        assert_eq!(provider.speed.first_output_median_ms, Some(1_000));
    }
}

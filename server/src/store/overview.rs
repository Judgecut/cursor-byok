//! Efficient SQLite aggregates for the desktop overview dashboard, cost trends,
//! annual activity series, cross-model supplier breakdowns, model summaries,
//! and complete filter candidate lists.

mod trend;
mod cost_quota;

pub use cost_quota::{CostQuotaRange, CostQuotaUsage};

use std::collections::{BTreeMap, BTreeSet, HashMap};

use chrono::{Days, Utc};
use sqlx::Row;

use crate::{
    model::{
        Overview, OverviewActivityDay, OverviewFilterModel, OverviewFilterSupplier,
        OverviewMetrics, OverviewModelSummary, OverviewSupplierBreakdown, OverviewTrendBreakdown,
        SpeedAggregate, SpeedTotals, TokenUsageBucket, TokenUsageGranularity,
    },
    plugin::PluginModelDescriptor,
    pricing::{divide_nano_round_half_up, endpoint_host, format_nano_usd, SourceKind},
    Error, Result,
};

use super::{
    supplier_groups::{endpoint_origin, plugin_group_id, SupplierGroups},
    Store,
};

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
        suppliers: Option<&str>,
        bucket_ms: Option<i64>,
    ) -> Result<Overview> {
        self.overview_with_plugins(start_ms, end_ms, supplier_keys, suppliers, bucket_ms, &[])
            .await
    }

    pub async fn overview_with_plugins(
        &self,
        start_ms: Option<i64>,
        end_ms: Option<i64>,
        supplier_keys: Option<&str>,
        suppliers: Option<&str>,
        bucket_ms: Option<i64>,
        plugin_models: &[PluginModelDescriptor],
    ) -> Result<Overview> {
        let supplier_keys_json = normalize_string_array_filter(supplier_keys, "supplier_keys")?;
        let suppliers_json = normalize_string_array_filter(suppliers, "suppliers")?;
        let providers = self.providers().await?;
        let models = self.models().await?;
        let groups = SupplierGroups::new(&providers, &models);
        let supplier_group_expr = groups.expr();

        let summary_row = sqlx::query(&format!(
            "SELECT
                COUNT(*) AS llm_calls,
                COALESCE(SUM(status = 'completed'), 0) AS successful_calls,
                COALESCE(SUM(status != 'completed'), 0) AS failed_calls,
                COALESCE(SUM({fresh_input}), 0) AS input_tokens,
                COALESCE(SUM(CASE WHEN cache_read_tokens IS NOT NULL OR cache_write_tokens IS NOT NULL THEN {fresh_input} ELSE 0 END), 0) AS reported_cache_input_tokens,
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
                COALESCE(SUM(cost_status = 'incomplete_usage'), 0) AS incomplete_usage_calls,
                {cache_estimation_cols}
             FROM llm_calls
             WHERE status != 'running'
               AND (? IS NULL OR created_at_ms >= ?)
               AND (? IS NULL OR created_at_ms < ?)
               AND (? IS NULL OR supplier_key IN (SELECT value FROM json_each(?)))
               AND (? IS NULL OR {supplier_group_expr} IN (SELECT value FROM json_each(?)))",
            fresh_input = fresh_input_sql(),
            cache_estimation_cols = cache_estimation_aggregate_sql(),
        ))
        .bind(start_ms)
        .bind(start_ms)
        .bind(end_ms)
        .bind(end_ms)
        .bind(&supplier_keys_json)
        .bind(&supplier_keys_json)
        .bind(&suppliers_json)
        .bind(&suppliers_json)
        .fetch_one(&self.pool)
        .await?;

        let input_tokens = non_negative(summary_row.try_get("input_tokens")?);
        let reported_cache_input_tokens =
            non_negative(summary_row.try_get("reported_cache_input_tokens")?);
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
        let unreported_cache_calls = non_negative(summary_row.try_get("unreported_cache_calls")?);
        let assumed_cache_calls = non_negative(summary_row.try_get("assumed_cache_calls")?);
        let assumed_cache_cost_nano = non_negative(summary_row.try_get("assumed_cache_cost_nano")?);
        let estimated_cache_read_tokens =
            non_negative(summary_row.try_get("estimated_cache_read_tokens")?);
        let overall_speed = self
            .load_overall_speed(
                start_ms,
                end_ms,
                supplier_keys_json.as_deref(),
                suppliers_json.as_deref(),
                supplier_group_expr,
            )
            .await?;

        let metrics = OverviewMetrics {
            llm_calls: summary_row.try_get("llm_calls")?,
            successful_calls: summary_row.try_get("successful_calls")?,
            failed_calls: summary_row.try_get("failed_calls")?,
            token_usage: prompt_tokens.saturating_add(output_tokens),
            prompt_tokens,
            input_tokens,
            reported_cache_input_tokens,
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
            unreported_cache_calls,
            assumed_cache_calls,
            assumed_cache_cost: format_nano_usd(assumed_cache_cost_nano),
            estimated_cache_read_tokens,
            speed: overall_speed,
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
                COALESCE(SUM(cost_status = 'incomplete_usage'), 0) AS incomplete_usage_calls,
                {cache_estimation_cols}
             FROM llm_calls
             WHERE status != 'running'
               AND created_at_ms >= ?
               AND (? IS NULL OR created_at_ms < ?)
               AND (? IS NULL OR supplier_key IN (SELECT value FROM json_each(?)))
               AND (? IS NULL OR {supplier_group_expr} IN (SELECT value FROM json_each(?)))
             GROUP BY bucket_start_ms
             ORDER BY bucket_start_ms",
            fresh_input = fresh_input_sql(),
            cache_estimation_cols = cache_estimation_aggregate_sql(),
        ))
        .bind(start_ms.unwrap_or(series_start_ms).max(series_start_ms))
        .bind(end_ms)
        .bind(end_ms)
        .bind(&supplier_keys_json)
        .bind(&supplier_keys_json)
        .bind(&suppliers_json)
        .bind(&suppliers_json)
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
                        unreported_cache_calls: non_negative(
                            row.try_get("unreported_cache_calls")?,
                        ),
                        assumed_cache_calls: non_negative(row.try_get("assumed_cache_calls")?),
                        assumed_cache_cost: format_nano_usd(non_negative(
                            row.try_get("assumed_cache_cost_nano")?,
                        )),
                        estimated_cache_read_tokens: non_negative(
                            row.try_get("estimated_cache_read_tokens")?,
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

        let activity_series = self
            .load_activity_series(
                supplier_keys_json.as_deref(),
                suppliers_json.as_deref(),
                supplier_group_expr,
            )
            .await?;

        let (supplier_meta, available_suppliers, available_models) =
            self.load_supplier_metadata(plugin_models, &groups).await?;

        let suppliers = self
            .load_supplier_breakdowns(
                start_ms,
                end_ms,
                supplier_keys_json.as_deref(),
                suppliers_json.as_deref(),
                supplier_group_expr,
                &supplier_meta,
            )
            .await?;

        let models = self
            .load_model_summaries(
                start_ms,
                end_ms,
                supplier_keys_json.as_deref(),
                suppliers_json.as_deref(),
                supplier_group_expr,
            )
            .await?;

        let trend_breakdown = if let (Some(start_ms), Some(end_ms)) = (start_ms, end_ms) {
            let range = start_ms.max(series_start_ms)..end_ms;
            let (models, mut supplier_trends) = tokio::try_join!(
                self.load_trend_series(
                    range.clone(),
                    bucket_ms,
                    supplier_keys_json.as_deref(),
                    suppliers_json.as_deref(),
                    supplier_group_expr,
                    "model_id"
                ),
                self.load_trend_series(
                    range,
                    bucket_ms,
                    supplier_keys_json.as_deref(),
                    suppliers_json.as_deref(),
                    supplier_group_expr,
                    supplier_group_expr
                ),
            )?;
            for series in &mut supplier_trends {
                if let Some(supplier) = suppliers
                    .iter()
                    .find(|supplier| supplier.supplier_id == series.id)
                {
                    series.label.clone_from(&supplier.label);
                }
            }
            Some(OverviewTrendBreakdown {
                models,
                suppliers: supplier_trends,
            })
        } else {
            None
        };

        Ok(Overview {
            metrics,
            token_usage_granularity,
            token_usage_series,
            trend_breakdown,
            activity_series,
            suppliers,
            models,
            available_suppliers,
            available_models,
        })
    }

    async fn load_activity_series(
        &self,
        supplier_keys_json: Option<&str>,
        suppliers_json: Option<&str>,
        supplier_group_expr: &str,
    ) -> Result<Vec<OverviewActivityDay>> {
        let today = Utc::now().date_naive();
        let start_date = today
            .checked_sub_days(Days::new(OVERVIEW_DAYS - 1))
            .unwrap_or(today);
        let start_ms = start_date
            .and_hms_opt(0, 0, 0)
            .map(|dt| dt.and_utc().timestamp_millis())
            .unwrap_or(0);
        let end_exclusive_ms = today
            .and_hms_opt(0, 0, 0)
            .map(|dt| dt.and_utc().timestamp_millis().saturating_add(DAY_MS))
            .unwrap_or(i64::MAX);

        let rows = sqlx::query(&format!(
            "SELECT
                (created_at_ms / {DAY_MS}) * {DAY_MS} AS day_start_ms,
                COALESCE(SUM({fresh_input}), 0)
                  + COALESCE(SUM(COALESCE(cache_read_tokens, 0)), 0)
                  + COALESCE(SUM(COALESCE(cache_write_tokens, 0)), 0)
                  + COALESCE(SUM(COALESCE(output_tokens, 0)), 0) AS token_usage,
                COALESCE(SUM(CASE WHEN cost_status = 'priced' THEN COALESCE(total_cost_nano, 0) ELSE 0 END), 0) AS total_cost_nano
             FROM llm_calls
             WHERE status != 'running'
               AND created_at_ms >= ?
               AND created_at_ms < ?
               AND (? IS NULL OR supplier_key IN (SELECT value FROM json_each(?)))
               AND (? IS NULL OR {supplier_group_expr} IN (SELECT value FROM json_each(?)))
             GROUP BY day_start_ms",
            fresh_input = fresh_input_sql(),
        ))
        .bind(start_ms)
        .bind(end_exclusive_ms)
        .bind(supplier_keys_json)
        .bind(supplier_keys_json)
        .bind(suppliers_json)
        .bind(suppliers_json)
        .fetch_all(&self.pool)
        .await?;

        let mut by_day = HashMap::with_capacity(rows.len());
        for row in rows {
            let day_start_ms: i64 = row.try_get("day_start_ms")?;
            let token_usage = non_negative(row.try_get("token_usage")?);
            let total_cost_nano = non_negative(row.try_get("total_cost_nano")?);
            by_day.insert(day_start_ms, (token_usage, total_cost_nano));
        }

        let mut series = Vec::with_capacity(OVERVIEW_DAYS as usize);
        for offset in 0..OVERVIEW_DAYS {
            let day = start_date
                .checked_add_days(Days::new(offset))
                .unwrap_or(today);
            let day_ms = day
                .and_hms_opt(0, 0, 0)
                .map(|dt| dt.and_utc().timestamp_millis())
                .unwrap_or(0);
            let (token_usage, total_cost_nano) = by_day.get(&day_ms).copied().unwrap_or_default();
            series.push(OverviewActivityDay {
                date: day.format("%Y-%m-%d").to_string(),
                token_usage,
                total_cost: format_nano_usd(total_cost_nano),
            });
        }
        Ok(series)
    }

    async fn load_overall_speed(
        &self,
        start_ms: Option<i64>,
        end_ms: Option<i64>,
        supplier_keys_json: Option<&str>,
        suppliers_json: Option<&str>,
        supplier_group_expr: &str,
    ) -> Result<SpeedAggregate> {
        let eligible = speed_eligible_sql();
        let effective_output = effective_output_tokens_sql();
        let row = sqlx::query(&format!(
            "SELECT
                COALESCE(SUM({effective_output}), 0) AS output_tokens,
                COALESCE(SUM(generation_ms), 0) AS generation_ms,
                COUNT(*) AS samples
             FROM llm_calls
             WHERE {eligible}
               AND (? IS NULL OR created_at_ms >= ?)
               AND (? IS NULL OR created_at_ms < ?)
               AND (? IS NULL OR supplier_key IN (SELECT value FROM json_each(?)))
               AND (? IS NULL OR {supplier_group_expr} IN (SELECT value FROM json_each(?)))"
        ))
        .bind(start_ms)
        .bind(start_ms)
        .bind(end_ms)
        .bind(end_ms)
        .bind(supplier_keys_json)
        .bind(supplier_keys_json)
        .bind(suppliers_json)
        .bind(suppliers_json)
        .fetch_one(&self.pool)
        .await?;

        let totals = SpeedTotals {
            output_tokens: non_negative(row.try_get("output_tokens")?),
            generation_ms: non_negative(row.try_get("generation_ms")?),
            samples: non_negative(row.try_get("samples")?),
        };

        let median_row = sqlx::query(&format!(
            "SELECT CAST(AVG(ttfo_ms) AS INTEGER) AS median_ms
             FROM (
               SELECT ttfo_ms,
                 ROW_NUMBER() OVER (ORDER BY ttfo_ms) AS rn,
                 COUNT(*) OVER () AS cnt
               FROM llm_calls
               WHERE {eligible}
                 AND ttfo_ms IS NOT NULL
                 AND (? IS NULL OR created_at_ms >= ?)
                 AND (? IS NULL OR created_at_ms < ?)
                 AND (? IS NULL OR supplier_key IN (SELECT value FROM json_each(?)))
                 AND (? IS NULL OR {supplier_group_expr} IN (SELECT value FROM json_each(?)))
             )
             WHERE rn IN ((cnt + 1) / 2, (cnt + 2) / 2)",
            eligible = first_output_eligible_sql(),
        ))
        .bind(start_ms)
        .bind(start_ms)
        .bind(end_ms)
        .bind(end_ms)
        .bind(supplier_keys_json)
        .bind(supplier_keys_json)
        .bind(suppliers_json)
        .bind(suppliers_json)
        .fetch_one(&self.pool)
        .await?;

        let median_ms = median_row.try_get::<Option<i64>, _>("median_ms")?;
        Ok(SpeedAggregate::from_totals(totals, median_ms))
    }

    async fn load_speed_totals_by(
        &self,
        start_ms: Option<i64>,
        end_ms: Option<i64>,
        supplier_keys_json: Option<&str>,
        suppliers_json: Option<&str>,
        supplier_group_expr: &str,
    ) -> Result<HashMap<String, SpeedTotals>> {
        let eligible = speed_eligible_sql();
        let effective_output = effective_output_tokens_sql();
        let rows = sqlx::query(&format!(
            "SELECT {supplier_group_expr} AS group_key,
                COALESCE(SUM({effective_output}), 0) AS output_tokens,
                COALESCE(SUM(generation_ms), 0) AS generation_ms,
                COUNT(*) AS samples
             FROM llm_calls
             WHERE {eligible}
               AND (? IS NULL OR created_at_ms >= ?)
               AND (? IS NULL OR created_at_ms < ?)
               AND (? IS NULL OR supplier_key IN (SELECT value FROM json_each(?)))
               AND (? IS NULL OR {supplier_group_expr} IN (SELECT value FROM json_each(?)))
             GROUP BY group_key"
        ))
        .bind(start_ms)
        .bind(start_ms)
        .bind(end_ms)
        .bind(end_ms)
        .bind(supplier_keys_json)
        .bind(supplier_keys_json)
        .bind(suppliers_json)
        .bind(suppliers_json)
        .fetch_all(&self.pool)
        .await?;

        rows.into_iter()
            .map(|row| {
                let key: String = row.try_get("group_key")?;
                Ok((
                    key,
                    SpeedTotals {
                        output_tokens: non_negative(row.try_get("output_tokens")?),
                        generation_ms: non_negative(row.try_get("generation_ms")?),
                        samples: non_negative(row.try_get("samples")?),
                    },
                ))
            })
            .collect()
    }

    async fn load_first_output_medians_by(
        &self,
        start_ms: Option<i64>,
        end_ms: Option<i64>,
        supplier_keys_json: Option<&str>,
        suppliers_json: Option<&str>,
        supplier_group_expr: &str,
    ) -> Result<HashMap<String, i64>> {
        let rows = sqlx::query(&format!(
            "SELECT group_key, CAST(AVG(ttfo_ms) AS INTEGER) AS median_ms
             FROM (
               SELECT {supplier_group_expr} AS group_key, ttfo_ms,
                 ROW_NUMBER() OVER (PARTITION BY {supplier_group_expr} ORDER BY ttfo_ms) AS rn,
                 COUNT(*) OVER (PARTITION BY {supplier_group_expr}) AS cnt
               FROM llm_calls
               WHERE {eligible}
                 AND ttfo_ms IS NOT NULL
                 AND (? IS NULL OR created_at_ms >= ?)
                 AND (? IS NULL OR created_at_ms < ?)
                 AND (? IS NULL OR supplier_key IN (SELECT value FROM json_each(?)))
                 AND (? IS NULL OR {supplier_group_expr} IN (SELECT value FROM json_each(?)))
             )
             WHERE rn IN ((cnt + 1) / 2, (cnt + 2) / 2)
             GROUP BY group_key",
            eligible = first_output_eligible_sql(),
        ))
        .bind(start_ms)
        .bind(start_ms)
        .bind(end_ms)
        .bind(end_ms)
        .bind(supplier_keys_json)
        .bind(supplier_keys_json)
        .bind(suppliers_json)
        .bind(suppliers_json)
        .fetch_all(&self.pool)
        .await?;

        rows.into_iter()
            .map(|row| {
                Ok((
                    row.try_get::<String, _>("group_key")?,
                    row.try_get::<Option<i64>, _>("median_ms")?.unwrap_or(0),
                ))
            })
            .collect()
    }

    async fn load_supplier_metadata(
        &self,
        plugin_models: &[PluginModelDescriptor],
        groups: &SupplierGroups,
    ) -> Result<(
        HashMap<String, CanonicalSupplierMeta>,
        Vec<OverviewFilterSupplier>,
        Vec<OverviewFilterModel>,
    )> {
        struct GroupAccum {
            source_kind: SourceKind,
            provider_id: Option<String>,
            endpoint_key: String,
            label: String,
            provider_type: String,
            plugin_icon: Option<String>,
            active: bool,
            model_ids: BTreeSet<String>,
        }

        let mut accum: HashMap<String, GroupAccum> = HashMap::new();

        // Configured built-in suppliers: one row per provider ID, regardless
        // of how many protocols its models use.
        for group in groups.groups() {
            if !group.is_active() {
                continue;
            }
            accum.insert(
                group.id.clone(),
                GroupAccum {
                    source_kind: SourceKind::Builtin,
                    provider_id: Some(group.provider_id.clone()),
                    endpoint_key: group.base_url.clone(),
                    label: group.label.clone(),
                    provider_type: group.provider_type.clone().unwrap_or_default(),
                    plugin_icon: None,
                    active: true,
                    model_ids: group.model_ids.clone(),
                },
            );
        }

        // Configured plugin suppliers keep their endpoint-level identity.
        for plugin in plugin_models {
            let endpoint = format!("plugin://{}/{}", plugin.plugin_id, plugin.provider_id);
            let group_id = plugin_group_id(&endpoint);
            let entry = accum.entry(group_id).or_insert_with(|| GroupAccum {
                source_kind: SourceKind::Plugin,
                provider_id: None,
                endpoint_key: endpoint.clone(),
                label: plugin.plugin_name.clone(),
                provider_type: plugin.provider_type.clone(),
                plugin_icon: Some(plugin.icon.clone()),
                active: true,
                model_ids: BTreeSet::new(),
            });
            entry.active = true;
            entry.plugin_icon = Some(plugin.icon.clone());
            entry.model_ids.insert(plugin.model_id.clone());
        }

        // Endpoints observed in calls, including deleted models and providers.
        let pricing_views = self.supplier_pricing_models(plugin_models).await?;
        let mut available_models = Vec::new();
        for view in &pricing_views {
            if !(view.active || view.call_count > 0) {
                continue;
            }

            let group_id = match view.source_kind {
                SourceKind::Plugin => plugin_group_id(&view.endpoint_key),
                SourceKind::Builtin => groups.group_for_endpoint(&view.endpoint_key),
            };
            let group_label = accum
                .get(&group_id)
                .map(|entry| entry.label.clone())
                .or_else(|| groups.group(&group_id).map(|group| group.label.clone()))
                .unwrap_or_else(|| fallback_group_label(&group_id, &view.endpoint_key));
            available_models.push(OverviewFilterModel {
                supplier_key: view.supplier_key.clone(),
                source_kind: view.source_kind.as_str().to_owned(),
                endpoint_key: view.endpoint_key.clone(),
                model_id: view.model_id.clone(),
                label: view.display_name.clone(),
                group: group_label,
                provider_type: view.provider_type.clone(),
                plugin_icon: view.plugin_icon.clone(),
                active: view.active,
            });
            // Configured models already belong to their provider's group. A
            // shared request endpoint must not add a second supplier entry.
            if view.source_kind == SourceKind::Builtin && view.active {
                continue;
            }
            let entry = accum.entry(group_id.clone()).or_insert_with(|| {
                if let Some(group) = groups.group(&group_id) {
                    return GroupAccum {
                        source_kind: SourceKind::Builtin,
                        provider_id: Some(group.provider_id.clone()),
                        endpoint_key: group.base_url.clone(),
                        label: group.label.clone(),
                        provider_type: group.provider_type.clone().unwrap_or_default(),
                        plugin_icon: None,
                        active: group.is_active(),
                        model_ids: BTreeSet::new(),
                    };
                }
                if view.source_kind == SourceKind::Plugin {
                    GroupAccum {
                        source_kind: SourceKind::Plugin,
                        provider_id: None,
                        endpoint_key: view.endpoint_key.clone(),
                        label: endpoint_host(&view.endpoint_key)
                            .unwrap_or_else(|| view.endpoint_key.clone()),
                        provider_type: view.provider_type.clone(),
                        plugin_icon: view.plugin_icon.clone(),
                        active: view.active,
                        model_ids: BTreeSet::new(),
                    }
                } else {
                    let label = group_id
                        .strip_prefix("builtin::host::")
                        .unwrap_or(&view.endpoint_key)
                        .to_owned();
                    GroupAccum {
                        source_kind: SourceKind::Builtin,
                        provider_id: None,
                        endpoint_key: endpoint_origin(&view.endpoint_key),
                        label,
                        provider_type: view.provider_type.clone(),
                        plugin_icon: None,
                        active: false,
                        model_ids: BTreeSet::new(),
                    }
                }
            });
            entry.active |= view.active;
            if entry.plugin_icon.is_none() {
                entry.plugin_icon = view.plugin_icon.clone();
            }
            if entry.provider_type.is_empty() {
                entry.provider_type = view.provider_type.clone();
            }
            entry.model_ids.insert(view.model_id.clone());
        }

        let mut meta_by_id = HashMap::with_capacity(accum.len());
        let mut available_suppliers: Vec<OverviewFilterSupplier> = accum
            .into_iter()
            .filter(|(_, entry)| !entry.model_ids.is_empty())
            .map(|(supplier_id, entry)| {
                meta_by_id.insert(
                    supplier_id.clone(),
                    CanonicalSupplierMeta {
                        source_kind: entry.source_kind,
                        provider_id: entry.provider_id.clone(),
                        endpoint_key: entry.endpoint_key.clone(),
                        label: entry.label.clone(),
                        provider_type: entry.provider_type.clone(),
                        plugin_icon: entry.plugin_icon.clone(),
                        active: entry.active,
                    },
                );
                OverviewFilterSupplier {
                    supplier_id,
                    provider_id: entry.provider_id,
                    source_kind: entry.source_kind.as_str().to_owned(),
                    endpoint_key: entry.endpoint_key,
                    label: entry.label,
                    provider_type: entry.provider_type,
                    plugin_icon: entry.plugin_icon,
                    active: entry.active,
                    model_count: entry.model_ids.len() as i64,
                }
            })
            .collect();

        available_suppliers.sort_by(|left, right| {
            right
                .active
                .cmp(&left.active)
                .then_with(|| left.label.to_lowercase().cmp(&right.label.to_lowercase()))
                .then_with(|| left.endpoint_key.cmp(&right.endpoint_key))
                .then_with(|| left.supplier_id.cmp(&right.supplier_id))
        });

        Ok((meta_by_id, available_suppliers, available_models))
    }

    async fn load_supplier_breakdowns(
        &self,
        start_ms: Option<i64>,
        end_ms: Option<i64>,
        supplier_keys_json: Option<&str>,
        suppliers_json: Option<&str>,
        supplier_group_expr: &str,
        metadata: &HashMap<String, CanonicalSupplierMeta>,
    ) -> Result<Vec<OverviewSupplierBreakdown>> {
        let rows = sqlx::query(&format!(
            "SELECT
                {supplier_group_expr} AS supplier_id,
                MAX(endpoint_key) AS endpoint_key,
                MAX(request_type) AS request_type,
                MAX(request_url) AS request_url,
                MAX(provider_url) AS provider_url,
                MAX(model_id) AS sample_model_id,
                COUNT(DISTINCT model_id) AS model_count,
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
                COALESCE(SUM(cost_status = 'incomplete_usage'), 0) AS incomplete_usage_calls,
                COALESCE(SUM(pricing_source = 'custom'), 0) > 0 AS has_custom_pricing,
                COALESCE(SUM(pricing_source = 'catalog'), 0) > 0 AS has_catalog_pricing,
                COALESCE(SUM(pricing_source IS NULL OR pricing_source NOT IN ('custom', 'catalog')), 0) > 0 AS has_unpriced_pricing,
                {cache_estimation_cols}
             FROM llm_calls
             WHERE status != 'running'
               AND (? IS NULL OR created_at_ms >= ?)
               AND (? IS NULL OR created_at_ms < ?)
               AND (? IS NULL OR supplier_key IN (SELECT value FROM json_each(?)))
               AND (? IS NULL OR {supplier_group_expr} IN (SELECT value FROM json_each(?)))
             GROUP BY {supplier_group_expr}",
            fresh_input = fresh_input_sql(),
            cache_estimation_cols = cache_estimation_aggregate_sql(),
        ))
        .bind(start_ms)
        .bind(start_ms)
        .bind(end_ms)
        .bind(end_ms)
        .bind(supplier_keys_json)
        .bind(supplier_keys_json)
        .bind(suppliers_json)
        .bind(suppliers_json)
        .fetch_all(&self.pool)
        .await?;

        let speed_totals = self
            .load_speed_totals_by(
                start_ms,
                end_ms,
                supplier_keys_json,
                suppliers_json,
                supplier_group_expr,
            )
            .await?;
        let first_output_medians = self
            .load_first_output_medians_by(
                start_ms,
                end_ms,
                supplier_keys_json,
                suppliers_json,
                supplier_group_expr,
            )
            .await?;

        let mut breakdowns: Vec<(i64, OverviewSupplierBreakdown)> = Vec::with_capacity(rows.len());
        for row in rows {
            let supplier_id: String = row.try_get("supplier_id")?;
            let request_type_raw: String = row.try_get("request_type")?;
            let fallback_endpoint = row
                .try_get::<Option<String>, _>("endpoint_key")?
                .filter(|value| !value.is_empty())
                .or_else(|| {
                    row.try_get::<Option<String>, _>("request_url")
                        .ok()
                        .flatten()
                        .filter(|value| !value.is_empty())
                })
                .or_else(|| {
                    row.try_get::<Option<String>, _>("provider_url")
                        .ok()
                        .flatten()
                        .filter(|value| !value.is_empty())
                })
                .unwrap_or_default();
            let meta = metadata.get(&supplier_id);

            let input_tokens = non_negative(row.try_get("input_tokens")?);
            let cache_read_tokens = non_negative(row.try_get("cache_read_tokens")?);
            let cache_write_tokens = non_negative(row.try_get("cache_write_tokens")?);
            let output_tokens = non_negative(row.try_get("output_tokens")?);
            let prompt_tokens =
                saturating_sum(&[input_tokens, cache_read_tokens, cache_write_tokens]);
            let token_usage = prompt_tokens.saturating_add(output_tokens);

            let input_cost_nano = non_negative(row.try_get("input_cost_nano")?);
            let output_cost_nano = non_negative(row.try_get("output_cost_nano")?);
            let cache_read_cost_nano = non_negative(row.try_get("cache_read_cost_nano")?);
            let cache_write_cost_nano = non_negative(row.try_get("cache_write_cost_nano")?);
            let total_cost_nano = non_negative(row.try_get("total_cost_nano")?);
            let priced_calls = non_negative(row.try_get("priced_calls")?);
            let speed_sample = speed_totals.get(&supplier_id).copied().unwrap_or_default();
            let first_output_median_ms = first_output_medians.get(&supplier_id).copied();

            let label = meta
                .map(|item| item.label.clone())
                .unwrap_or_else(|| fallback_group_label(&supplier_id, &fallback_endpoint));
            let source_kind = meta
                .map(|item| item.source_kind.as_str().to_owned())
                .unwrap_or_else(|| fallback_group_source_kind(&supplier_id));
            let endpoint_key = meta
                .map(|item| item.endpoint_key.clone())
                .unwrap_or_else(|| endpoint_origin(&fallback_endpoint));

            breakdowns.push((
                total_cost_nano,
                OverviewSupplierBreakdown {
                    supplier_id,
                    provider_id: meta.and_then(|item| item.provider_id.clone()),
                    source_kind,
                    endpoint_key,
                    label,
                    provider_type: meta
                        .map(|item| item.provider_type.clone())
                        .unwrap_or(request_type_raw),
                    plugin_icon: meta.and_then(|item| item.plugin_icon.clone()),
                    active: meta.is_some_and(|item| item.active),
                    model_count: non_negative(row.try_get("model_count")?),
                    pricing_sources: collect_pricing_sources(
                        row.try_get::<bool, _>("has_custom_pricing")?,
                        row.try_get::<bool, _>("has_catalog_pricing")?,
                        row.try_get::<bool, _>("has_unpriced_pricing")?,
                    ),
                    llm_calls: non_negative(row.try_get("llm_calls")?),
                    successful_calls: non_negative(row.try_get("successful_calls")?),
                    failed_calls: non_negative(row.try_get("failed_calls")?),
                    token_usage,
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
                    unpriced_calls: non_negative(row.try_get("unpriced_calls")?),
                    incomplete_usage_calls: non_negative(row.try_get("incomplete_usage_calls")?),
                    unreported_cache_calls: non_negative(row.try_get("unreported_cache_calls")?),
                    assumed_cache_calls: non_negative(row.try_get("assumed_cache_calls")?),
                    assumed_cache_cost: format_nano_usd(non_negative(
                        row.try_get("assumed_cache_cost_nano")?,
                    )),
                    estimated_cache_read_tokens: non_negative(
                        row.try_get("estimated_cache_read_tokens")?,
                    ),
                    speed: SpeedAggregate::from_totals(speed_sample, first_output_median_ms),
                },
            ));
        }

        breakdowns.sort_by(|(cost_a, item_a), (cost_b, item_b)| {
            item_b
                .token_usage
                .cmp(&item_a.token_usage)
                .then_with(|| cost_b.cmp(cost_a))
                .then_with(|| item_b.llm_calls.cmp(&item_a.llm_calls))
                .then_with(|| {
                    item_a
                        .label
                        .to_lowercase()
                        .cmp(&item_b.label.to_lowercase())
                })
                .then_with(|| item_a.supplier_id.cmp(&item_b.supplier_id))
        });

        Ok(breakdowns.into_iter().map(|(_, item)| item).collect())
    }

    async fn load_model_summaries(
        &self,
        start_ms: Option<i64>,
        end_ms: Option<i64>,
        supplier_keys_json: Option<&str>,
        suppliers_json: Option<&str>,
        supplier_group_expr: &str,
    ) -> Result<Vec<OverviewModelSummary>> {
        let rows = sqlx::query(&format!(
            "SELECT
                model_id,
                COUNT(DISTINCT {supplier_group_expr}) AS supplier_count,
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
                COALESCE(SUM(cost_status = 'incomplete_usage'), 0) AS incomplete_usage_calls,
                COALESCE(SUM(pricing_source = 'custom'), 0) > 0 AS has_custom_pricing,
                COALESCE(SUM(pricing_source = 'catalog'), 0) > 0 AS has_catalog_pricing,
                COALESCE(SUM(pricing_source IS NULL OR pricing_source NOT IN ('custom', 'catalog')), 0) > 0 AS has_unpriced_pricing,
                {cache_estimation_cols}
             FROM llm_calls
             WHERE status != 'running'
               AND (? IS NULL OR created_at_ms >= ?)
               AND (? IS NULL OR created_at_ms < ?)
               AND (? IS NULL OR supplier_key IN (SELECT value FROM json_each(?)))
               AND (? IS NULL OR {supplier_group_expr} IN (SELECT value FROM json_each(?)))
             GROUP BY model_id",
            fresh_input = fresh_input_sql(),
            cache_estimation_cols = cache_estimation_aggregate_sql(),
        ))
        .bind(start_ms)
        .bind(start_ms)
        .bind(end_ms)
        .bind(end_ms)
        .bind(supplier_keys_json)
        .bind(supplier_keys_json)
        .bind(suppliers_json)
        .bind(suppliers_json)
        .fetch_all(&self.pool)
        .await?;

        let speed_totals = self
            .load_speed_totals_by(
                start_ms,
                end_ms,
                supplier_keys_json,
                suppliers_json,
                "model_id",
            )
            .await?;
        let model_medians = self
            .load_first_output_medians_by(
                start_ms,
                end_ms,
                supplier_keys_json,
                suppliers_json,
                "model_id",
            )
            .await?;

        let mut models_with_sort: Vec<(i64, OverviewModelSummary)> = Vec::with_capacity(rows.len());
        for row in rows {
            let model_id: String = row.try_get("model_id")?;
            let input_tokens = non_negative(row.try_get("input_tokens")?);
            let cache_read_tokens = non_negative(row.try_get("cache_read_tokens")?);
            let cache_write_tokens = non_negative(row.try_get("cache_write_tokens")?);
            let output_tokens = non_negative(row.try_get("output_tokens")?);
            let prompt_tokens =
                saturating_sum(&[input_tokens, cache_read_tokens, cache_write_tokens]);
            let token_usage = prompt_tokens.saturating_add(output_tokens);

            let input_cost_nano = non_negative(row.try_get("input_cost_nano")?);
            let output_cost_nano = non_negative(row.try_get("output_cost_nano")?);
            let cache_read_cost_nano = non_negative(row.try_get("cache_read_cost_nano")?);
            let cache_write_cost_nano = non_negative(row.try_get("cache_write_cost_nano")?);
            let total_cost_nano = non_negative(row.try_get("total_cost_nano")?);
            let priced_calls = non_negative(row.try_get("priced_calls")?);
            let speed_sample = speed_totals.get(&model_id).copied().unwrap_or_default();
            let first_output_median_ms = model_medians.get(&model_id).copied();

            models_with_sort.push((
                total_cost_nano,
                OverviewModelSummary {
                    model_id,
                    supplier_count: non_negative(row.try_get("supplier_count")?),
                    pricing_sources: collect_pricing_sources(
                        row.try_get::<bool, _>("has_custom_pricing")?,
                        row.try_get::<bool, _>("has_catalog_pricing")?,
                        row.try_get::<bool, _>("has_unpriced_pricing")?,
                    ),
                    llm_calls: non_negative(row.try_get("llm_calls")?),
                    successful_calls: non_negative(row.try_get("successful_calls")?),
                    failed_calls: non_negative(row.try_get("failed_calls")?),
                    token_usage,
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
                    unpriced_calls: non_negative(row.try_get("unpriced_calls")?),
                    incomplete_usage_calls: non_negative(row.try_get("incomplete_usage_calls")?),
                    unreported_cache_calls: non_negative(row.try_get("unreported_cache_calls")?),
                    assumed_cache_calls: non_negative(row.try_get("assumed_cache_calls")?),
                    assumed_cache_cost: format_nano_usd(non_negative(
                        row.try_get("assumed_cache_cost_nano")?,
                    )),
                    estimated_cache_read_tokens: non_negative(
                        row.try_get("estimated_cache_read_tokens")?,
                    ),
                    speed: SpeedAggregate::from_totals(speed_sample, first_output_median_ms),
                },
            ));
        }

        models_with_sort.sort_by(|(cost_a, item_a), (cost_b, item_b)| {
            item_b
                .token_usage
                .cmp(&item_a.token_usage)
                .then_with(|| cost_b.cmp(cost_a))
                .then_with(|| item_b.llm_calls.cmp(&item_a.llm_calls))
                .then_with(|| item_a.model_id.cmp(&item_b.model_id))
        });

        Ok(models_with_sort.into_iter().map(|(_, item)| item).collect())
    }
}

struct CanonicalSupplierMeta {
    source_kind: SourceKind,
    provider_id: Option<String>,
    endpoint_key: String,
    label: String,
    provider_type: String,
    plugin_icon: Option<String>,
    active: bool,
}

pub(crate) fn normalize_string_array_filter(
    raw: Option<&str>,
    field_name: &str,
) -> Result<Option<String>> {
    let Some(trimmed) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let values: Vec<String> = serde_json::from_str(trimmed)
        .map_err(|_| Error::Config(format!("{field_name} must be a JSON array of strings")))?;
    if values.is_empty() {
        return Ok(None);
    }
    Ok(Some(serde_json::to_string(&values)?))
}

fn collect_pricing_sources(has_custom: bool, has_catalog: bool, has_unpriced: bool) -> Vec<String> {
    let mut sources = Vec::new();
    if has_custom {
        sources.push("custom".into());
    }
    if has_catalog {
        sources.push("catalog".into());
    }
    if has_unpriced {
        sources.push("unpriced".into());
    }
    sources
}

/// Label for a supplier row whose group has no metadata entry yet.
fn fallback_group_label(group_id: &str, fallback_endpoint: &str) -> String {
    if let Some(rest) = group_id.strip_prefix("builtin::host::") {
        return rest.to_owned();
    }
    endpoint_host(fallback_endpoint).unwrap_or_else(|| fallback_endpoint.to_owned())
}

fn fallback_group_source_kind(group_id: &str) -> String {
    if group_id.starts_with("plugin::") {
        "plugin".to_owned()
    } else {
        "builtin".to_owned()
    }
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

fn effective_output_tokens_sql() -> &'static str {
    "MAX(0, output_tokens - MAX(0, COALESCE(reasoning_tokens, 0)) - 1)"
}

/// A call contributes to the pooled generation rate when it succeeded, belongs
/// to a business run, streamed its response, generated for at least 200 ms, and
/// produced positive effective visible output.
fn speed_eligible_sql() -> String {
    let effective_output = effective_output_tokens_sql();
    format!(
        "status = 'completed' AND call_origin = 'run' \
         AND COALESCE(streaming, 0) = 1 \
         AND output_tokens IS NOT NULL \
         AND COALESCE(generation_output_events, 0) >= 2 \
         AND (observed_thinking = 0 OR reasoning_tokens IS NOT NULL) \
         AND COALESCE(generation_ms, 0) >= {min_generation_ms} \
         AND {effective_output} > 0",
        min_generation_ms = crate::model::MIN_SPEED_GENERATION_MS,
    )
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

fn cache_estimation_aggregate_sql() -> &'static str {
    "COALESCE(SUM(input_tokens IS NOT NULL AND cache_read_tokens IS NULL AND cache_write_tokens IS NULL), 0) AS unreported_cache_calls,
     COALESCE(SUM(cost_status = 'priced' AND cost_basis = 'assumed_cache'), 0) AS assumed_cache_calls,
     COALESCE(SUM(CASE WHEN cost_status = 'priced' AND cost_basis = 'assumed_cache' THEN COALESCE(total_cost_nano, 0) ELSE 0 END), 0) AS assumed_cache_cost_nano,
     COALESCE(SUM(CASE WHEN cost_status = 'priced' AND cost_basis = 'assumed_cache' THEN COALESCE(estimated_cache_read_tokens, 0) ELSE 0 END), 0) AS estimated_cache_read_tokens"
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
        model::{
            CallOrigin, ModelConfigInput, NewLlmCall, ProviderConfigInput, ProviderType,
            RequestFormat, Usage,
        },
        store::CallFinish,
    };

    use super::*;

    struct Sample<'a> {
        call_id: &'a str,
        origin: CallOrigin,
        endpoint_url: &'a str,
        model_id: &'a str,
        display_name: &'a str,
        output_tokens: u64,
        input_tokens: u64,
        reasoning_tokens: u64,
        observed_thinking: bool,
        streaming: bool,
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
                provider_url: sample.endpoint_url.into(),
                request_type: ProviderType::OpenAiChat,
                request_url: format!(
                    "{}/chat/completions",
                    sample.endpoint_url.trim_end_matches('/')
                ),
                model_id: sample.model_id.into(),
                display_name: sample.display_name.into(),
                reasoning_effort: None,
                fast: false,
                message_count: 1,
                tool_count: 0,
                detailed: false,
                origin: sample.origin,
                streaming: sample.streaming,
            })
            .await
            .unwrap();
        store
            .record_llm_output(
                sample.call_id,
                Some(sample.first_output_ms),
                sample.observed_thinking,
            )
            .await
            .unwrap();
        store
            .record_llm_usage(
                sample.call_id,
                Usage {
                    input_tokens: Some(sample.input_tokens),
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
                    generation_output_events: Some(2),
                    error_kind: None,
                    error_message: None,
                },
            )
            .await
            .unwrap();
    }

    #[allow(clippy::too_many_arguments)]
    async fn record_endpoint(
        store: &Store,
        call_id: &str,
        endpoint: &str,
        request_type: ProviderType,
        model_hash: &str,
        model_id: &str,
        input_tokens: u64,
        output_tokens: u64,
    ) {
        store
            .start_llm_call(&NewLlmCall {
                call_id: call_id.into(),
                run_id: "run".into(),
                conversation_id: "conversation".into(),
                provider_call_index: 0,
                model_hash: model_hash.into(),
                provider_type: request_type,
                provider_url: endpoint.into(),
                request_type,
                request_url: endpoint.into(),
                model_id: model_id.into(),
                display_name: model_id.into(),
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
            .record_llm_usage(
                call_id,
                Usage {
                    input_tokens: Some(input_tokens),
                    output_tokens: Some(output_tokens),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        store
            .finish_llm_call(
                call_id,
                CallFinish {
                    status: "completed",
                    finish_reason: Some("stop"),
                    elapsed_ms: 100,
                    generation_ms: None,
                    generation_output_events: None,
                    error_kind: None,
                    error_message: None,
                },
            )
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn quota_usage_sums_priced_finished_calls_across_overlapping_periods()
    {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::connect(&format!("sqlite://{}", directory.path().join("test.db").display())).await.unwrap();
        for (id, time, cost, status, pricing) in [
            ("before", 99, 9_000_000_000i64, "completed", "priced"),
            ("week", 100, 1_000_000_000, "completed", "priced"),
            ("year", 200, 2_000_000_000, "failed", "priced"),
            ("month", 300, 3_000_000_000, "completed", "priced"),
            ("running", 310, 9_000_000_000, "running", "priced"),
            ("unpriced", 320, 9_000_000_000, "completed", "unpriced"),
            ("after", 400, 9_000_000_000, "completed", "priced"),
        ]
        {
            record_endpoint(&store, id, "https://example.com", ProviderType::OpenAiChat, "mh", "model", 1, 1).await;
            sqlx::query("UPDATE llm_calls SET created_at_ms = ?, total_cost_nano = ?, status = ?, cost_status = ? WHERE call_id = ?").bind(time).bind(cost).bind(status).bind(pricing).bind(id).execute(&store.pool).await.unwrap();
        }
        let range = CostQuotaRange { week_start_ms: 100, month_start_ms: 300, year_start_ms: 200, end_ms: 400 };
        let usage = store.cost_quota_usage(range).await.unwrap();
        assert_eq!(usage, CostQuotaUsage { week: "6".into(), month: "3".into(), year: "5".into() });
        let usage = store.cost_quota_usage(CostQuotaRange { week_start_ms: 500, month_start_ms: 500, year_start_ms: 500, end_ms: 500 }).await.unwrap();
        assert_eq!(usage, CostQuotaUsage { week: "0".into(), month: "0".into(), year: "0".into() });
    }

    /// Model tests must not pollute business speed samples, eligible streamed run
    /// calls pool effective visible output over generation time (deducting hidden
    /// reasoning tokens and excluding non-streamed / sub-200ms / zero-visible
    /// calls), overall/supplier/model aggregates match SQL pooling and medians,
    /// and the activity calendar stays fixed at 365 days regardless of start_ms/end_ms.
    #[tokio::test]
    async fn speed_aggregates_pool_eligible_samples_across_overall_supplier_and_model() {
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
                endpoint_url: "https://example.com/v1",
                model_id: "glm-4.6",
                display_name: "GLM 4.6",
                output_tokens: 1_000,
                input_tokens: 10,
                reasoning_tokens: 0,
                observed_thinking: false,
                streaming: true,
                first_output_ms: 2_000,
                generation_ms: 10_000,
            },
        )
        .await;
        // Short output (< 100 tokens) still joins the generation pool when generation_ms >= 200.
        record(
            &store,
            Sample {
                call_id: "short",
                origin: CallOrigin::Run,
                endpoint_url: "https://example.com/v1",
                model_id: "glm-4.6",
                display_name: "GLM 4.6",
                output_tokens: 50,
                input_tokens: 10,
                reasoning_tokens: 0,
                observed_thinking: false,
                streaming: true,
                first_output_ms: 300,
                generation_ms: 5_000,
            },
        )
        .await;
        // Hidden reasoning deducts reasoning_tokens (500 - 200 = 300 effective tokens).
        record(
            &store,
            Sample {
                call_id: "estimated",
                origin: CallOrigin::Run,
                endpoint_url: "https://example.com/v1",
                model_id: "glm-4.6",
                display_name: "GLM 4.6",
                output_tokens: 500,
                input_tokens: 10,
                reasoning_tokens: 200,
                observed_thinking: false,
                streaming: true,
                first_output_ms: 1_000,
                generation_ms: 5_000,
            },
        )
        .await;
        // Non-streaming, sub-200ms generation, and zero-visible-output calls are excluded from speed.
        record(
            &store,
            Sample {
                call_id: "non-streaming",
                origin: CallOrigin::Run,
                endpoint_url: "https://example.com/v1",
                model_id: "glm-4.6",
                display_name: "GLM 4.6",
                output_tokens: 900,
                input_tokens: 10,
                reasoning_tokens: 0,
                observed_thinking: false,
                streaming: false,
                first_output_ms: 1_000,
                generation_ms: 3_000,
            },
        )
        .await;
        record(
            &store,
            Sample {
                call_id: "too-brief",
                origin: CallOrigin::Run,
                endpoint_url: "https://example.com/v1",
                model_id: "glm-4.6",
                display_name: "GLM 4.6",
                output_tokens: 120,
                input_tokens: 10,
                reasoning_tokens: 0,
                observed_thinking: false,
                streaming: true,
                first_output_ms: 2_000,
                generation_ms: 199,
            },
        )
        .await;
        record(
            &store,
            Sample {
                call_id: "reasoning-only",
                origin: CallOrigin::Run,
                endpoint_url: "https://example.com/v1",
                model_id: "glm-4.6",
                display_name: "GLM 4.6",
                output_tokens: 200,
                input_tokens: 10,
                reasoning_tokens: 200,
                observed_thinking: false,
                streaming: true,
                first_output_ms: 500,
                generation_ms: 2_000,
            },
        )
        .await;
        record(
            &store,
            Sample {
                call_id: "model-test",
                origin: CallOrigin::ModelTest,
                endpoint_url: "https://example.com/v1",
                model_id: "glm-4.6",
                display_name: "GLM 4.6",
                output_tokens: 4_000,
                input_tokens: 10,
                reasoning_tokens: 0,
                observed_thinking: false,
                streaming: true,
                first_output_ms: 50,
                generation_ms: 1_000,
            },
        )
        .await;

        let overview = store.overview(None, None, None, None, None).await.unwrap();
        assert_eq!(overview.activity_series.len(), 365);

        // Pooled over the three eligible streamed calls: 1,347 effective tokens over 20.0 s.
        assert_eq!(overview.metrics.speed.samples, 3);
        assert_eq!(overview.metrics.speed.output_tokens, 1_347);
        assert_eq!(overview.metrics.speed.generation_ms, 20_000);
        assert!((overview.metrics.speed.average_tokens_per_second.unwrap() - 67.35).abs() < 0.001);
        assert_eq!(overview.metrics.speed.first_output_median_ms, Some(1_000));
        // The JSON contract the desktop reads; a rename here must update the client type.
        let speed_json = serde_json::to_value(overview.metrics.speed).unwrap();
        assert_eq!(speed_json["samples"], 3);
        assert_eq!(speed_json["output_tokens"], 1_347);
        assert_eq!(speed_json["generation_ms"], 20_000);
        assert!(speed_json.get("duration_ms").is_none());

        let model = overview
            .models
            .iter()
            .find(|item| item.model_id == "glm-4.6")
            .expect("model summary");
        assert_eq!(model.speed.samples, 3);
        assert_eq!(model.speed.output_tokens, 1_347);
        assert_eq!(model.speed.generation_ms, 20_000);
        assert!((model.speed.average_tokens_per_second.unwrap() - 67.35).abs() < 0.001);
        assert_eq!(model.speed.first_output_median_ms, Some(1_000));

        let supplier = overview
            .suppliers
            .iter()
            .find(|item| item.endpoint_key == "https://example.com")
            .expect("supplier breakdown");
        assert_eq!(supplier.speed.samples, 3);
        assert_eq!(supplier.speed.output_tokens, 1_347);
        assert_eq!(supplier.speed.generation_ms, 20_000);
        assert_eq!(supplier.speed.first_output_median_ms, Some(1_000));
        assert_eq!(supplier.model_count, 1);

        // Filtering by an empty future time range must keep available_suppliers and 365-day activity_series.
        let future_ms = Utc::now().timestamp_millis() + DAY_MS * 10;
        let filtered_empty = store
            .overview(Some(future_ms), Some(future_ms + HOUR_MS), None, None, None)
            .await
            .unwrap();
        assert_eq!(filtered_empty.metrics.llm_calls, 0);
        assert_eq!(filtered_empty.suppliers.len(), 0);
        assert_eq!(filtered_empty.models.len(), 0);
        assert_eq!(filtered_empty.available_suppliers.len(), 1);
        assert_eq!(filtered_empty.activity_series.len(), 365);
        let activity_total: i64 = filtered_empty
            .activity_series
            .iter()
            .map(|day| day.token_usage)
            .sum();
        assert_eq!(activity_total, overview.metrics.token_usage);
    }

    #[tokio::test]
    async fn supplier_aggregation_groups_unconfigured_endpoints_by_domain_and_sorts_models_by_token_usage(
    ) {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::connect(&format!(
            "sqlite://{}",
            directory.path().join("test.db").display()
        ))
        .await
        .unwrap();

        // Two different endpoints carrying different token volumes and models.
        record(
            &store,
            Sample {
                call_id: "c1",
                origin: CallOrigin::Run,
                endpoint_url: "https://api-a.example.com/v1",
                model_id: "model-small",
                display_name: "OpenAI",
                output_tokens: 200,
                input_tokens: 100,
                reasoning_tokens: 0,
                observed_thinking: false,
                streaming: true,
                first_output_ms: 400,
                generation_ms: 2_000,
            },
        )
        .await;
        record(
            &store,
            Sample {
                call_id: "c2",
                origin: CallOrigin::Run,
                endpoint_url: "https://api-a.example.com/v1",
                model_id: "model-large",
                display_name: "OpenAI",
                output_tokens: 2_000,
                input_tokens: 3_000,
                reasoning_tokens: 0,
                observed_thinking: false,
                streaming: true,
                first_output_ms: 800,
                generation_ms: 10_000,
            },
        )
        .await;
        record(
            &store,
            Sample {
                call_id: "c3",
                origin: CallOrigin::Run,
                endpoint_url: "https://api-b.example.com/v1",
                model_id: "model-large",
                display_name: "OpenAI",
                output_tokens: 1_000,
                input_tokens: 500,
                reasoning_tokens: 400,
                observed_thinking: true,
                streaming: true,
                first_output_ms: 500,
                generation_ms: 5_000,
            },
        )
        .await;

        let all = store.overview(None, None, None, None, None).await.unwrap();
        assert_eq!(all.suppliers.len(), 2);
        assert_eq!(all.models.len(), 2);
        assert_eq!(all.models[0].model_id, "model-large");
        assert_eq!(all.models[0].token_usage, 6_500);
        assert_eq!(all.models[0].supplier_count, 2);
        // Visible output excludes 400 reasoning tokens and one initial token per call.
        assert_eq!(all.models[0].speed.output_tokens, 2_598);
        assert_eq!(all.models[0].speed.generation_ms, 15_000);
        assert_eq!(
            all.models[0].speed.average_tokens_per_second,
            Some(2_598.0 / 15.0)
        );
        assert_eq!(all.models[1].model_id, "model-small");
        assert_eq!(all.models[1].token_usage, 300);
        assert_eq!(all.models[1].supplier_count, 1);

        // Supplier filter selects all models belonging to endpoint A without leaking endpoint B.
        let supplier_a = &all
            .suppliers
            .iter()
            .find(|s| s.endpoint_key == "https://api-a.example.com")
            .unwrap()
            .supplier_id;
        assert_eq!(supplier_a, "builtin::host::api-a.example.com");
        assert_eq!(all.suppliers[0].supplier_id, *supplier_a);
        assert_eq!(all.suppliers[0].model_count, 2);
        assert_eq!(all.suppliers[0].token_usage, 5_300);

        let now_ms = Utc::now().timestamp_millis();
        let filtered = store
            .overview(
                Some(now_ms - DAY_MS),
                Some(now_ms + HOUR_MS),
                None,
                Some(&serde_json::to_string(&vec![supplier_a]).unwrap()),
                None,
            )
            .await
            .unwrap();
        assert_eq!(filtered.metrics.llm_calls, 2);
        assert_eq!(filtered.metrics.token_usage, 5_300);
        assert_eq!(filtered.suppliers.len(), 1);
        assert_eq!(filtered.models.len(), 2);
        assert_eq!(filtered.models[0].token_usage, 5_000);
        assert_eq!(filtered.models[0].supplier_count, 1);
        assert_eq!(filtered.available_suppliers.len(), 2);
        let trend = filtered.trend_breakdown.unwrap();
        assert_eq!(trend.suppliers.len(), 1);
        assert_eq!(trend.suppliers[0].id, *supplier_a);
        assert_eq!(trend.suppliers[0].label, filtered.suppliers[0].label);
        assert_eq!(trend.models.len(), 2);
        let large = trend
            .models
            .iter()
            .find(|series| series.id == "model-large")
            .unwrap();
        assert_eq!(large.token_rank, Some(1));
        assert_eq!(large.cost_rank, None);
        assert_eq!(
            large
                .buckets
                .iter()
                .map(|bucket| bucket.token_usage)
                .sum::<i64>(),
            5_000
        );
        assert!(large.buckets.iter().all(|bucket| filtered
            .token_usage_series
            .iter()
            .any(|total| total.bucket_start_ms == bucket.bucket_start_ms)));
    }

    #[tokio::test]
    async fn supplier_aggregation_merges_protocol_endpoints_by_provider_configuration() {
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
                name: "Gateway".into(),
                base_url: "https://gateway.example.com".into(),
                api_key: "key".into(),
                custom_headers_enabled: false,
                custom_headers: serde_json::json!({}),
            })
            .await
            .unwrap();
        let model_input = |request_format: RequestFormat, model_id: &str| ModelConfigInput {
            provider_id: provider.provider_id.clone(),
            request_format,
            request_url_override: None,
            extra_params_enabled: false,
            extra_params: serde_json::json!({}),
            sort_order: 0,
            display_name: model_id.into(),
            tooltip_data: model_id.into(),
            model_id: model_id.into(),
            reasoning_effort: None,
            context_window_tokens: None,
            max_output_tokens: None,
            anthropic_thinking_effort: None,
            thinking_budget_tokens: None,
        };
        let claude = store
            .create_model(&model_input(RequestFormat::Anthropic, "claude-opus-5.5"))
            .await
            .unwrap();
        let gemini = store
            .create_model(&model_input(RequestFormat::Gemini, "gemini-4-neon"))
            .await
            .unwrap();

        record_endpoint(
            &store,
            "c-anthropic",
            "https://gateway.example.com/v1/messages",
            ProviderType::Anthropic,
            &claude.model_hash,
            "claude-opus-5.5",
            100,
            10,
        )
        .await;
        record_endpoint(
            &store,
            "c-gemini",
            "https://gateway.example.com/v1beta/models",
            ProviderType::Gemini,
            &gemini.model_hash,
            "gemini-4-neon",
            200,
            20,
        )
        .await;
        // Historical protocol endpoint that no longer has a model configuration.
        record_endpoint(
            &store,
            "c-legacy",
            "https://gateway.example.com/v1/responses",
            ProviderType::OpenAiResponses,
            "legacy-hash",
            "gpt-6.1-sol",
            300,
            30,
        )
        .await;

        let overview = store.overview(None, None, None, None, None).await.unwrap();
        assert_eq!(overview.suppliers.len(), 1);
        let supplier = &overview.suppliers[0];
        assert_eq!(supplier.supplier_id, format!("builtin::provider::{}", provider.provider_id));
        assert_eq!(
            supplier.provider_id.as_deref(),
            Some(provider.provider_id.as_str())
        );
        assert_eq!(supplier.label, "Gateway");
        assert_eq!(supplier.endpoint_key, "https://gateway.example.com");
        assert!(supplier.active);
        assert_eq!(supplier.llm_calls, 3);
        assert_eq!(supplier.model_count, 3);
        assert_eq!(supplier.token_usage, 660);
        assert_eq!(overview.available_suppliers.len(), 1);
        assert_eq!(
            overview.available_suppliers[0].provider_id,
            supplier.provider_id
        );
        assert_eq!(overview.available_suppliers[0].model_count, 3);
        assert!(overview
            .available_models
            .iter()
            .all(|model| model.group == "Gateway"));

        let filtered = store
            .overview(
                None,
                None,
                None,
                Some(&serde_json::to_string(&vec![supplier.supplier_id.clone()]).unwrap()),
                None,
            )
            .await
            .unwrap();
        assert_eq!(filtered.metrics.llm_calls, 3);
        assert_eq!(filtered.suppliers.len(), 1);
        assert_eq!(filtered.models.len(), 3);
    }

    #[tokio::test]
    async fn supplier_aggregation_keeps_same_name_configurations_separate_on_a_shared_host() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::connect(&format!(
            "sqlite://{}",
            directory.path().join("test.db").display()
        ))
        .await
        .unwrap();

        let plan_provider = store
            .create_provider(&ProviderConfigInput {
                icon: None,
                sort_order: 0,
                name: "Shared Gateway".into(),
                base_url: "https://shared.example.com/api/plan".into(),
                api_key: "key".into(),
                custom_headers_enabled: false,
                custom_headers: serde_json::json!({}),
            })
            .await
            .unwrap();
        let coding_provider = store
            .create_provider(&ProviderConfigInput {
                icon: None,
                sort_order: 0,
                name: "Shared Gateway".into(),
                base_url: "https://shared.example.com/api/coding".into(),
                api_key: "key".into(),
                custom_headers_enabled: false,
                custom_headers: serde_json::json!({}),
            })
            .await
            .unwrap();
        let plan_model = store
            .create_model(&ModelConfigInput {
                provider_id: plan_provider.provider_id.clone(),
                request_format: RequestFormat::Anthropic,
                request_url_override: None,
                extra_params_enabled: false,
                extra_params: serde_json::json!({}),
                sort_order: 0,
                display_name: "Plan Model".into(),
                tooltip_data: "Plan Model".into(),
                model_id: "plan-model".into(),
                reasoning_effort: None,
                context_window_tokens: None,
                max_output_tokens: None,
                anthropic_thinking_effort: None,
                thinking_budget_tokens: None,
            })
            .await
            .unwrap();
        let coding_model = store
            .create_model(&ModelConfigInput {
                provider_id: coding_provider.provider_id.clone(),
                request_format: RequestFormat::Anthropic,
                request_url_override: None,
                extra_params_enabled: false,
                extra_params: serde_json::json!({}),
                sort_order: 0,
                display_name: "Coding Model".into(),
                tooltip_data: "Coding Model".into(),
                model_id: "coding-model".into(),
                reasoning_effort: None,
                context_window_tokens: None,
                max_output_tokens: None,
                anthropic_thinking_effort: None,
                thinking_budget_tokens: None,
            })
            .await
            .unwrap();

        record_endpoint(
            &store,
            "c-plan",
            "https://shared.example.com/api/plan/v1/messages",
            ProviderType::Anthropic,
            &plan_model.model_hash,
            "plan-model",
            10,
            1,
        )
        .await;
        record_endpoint(
            &store,
            "c-coding",
            "https://shared.example.com/api/coding/v1/messages",
            ProviderType::Anthropic,
            &coding_model.model_hash,
            "coding-model",
            20,
            2,
        )
        .await;
        // Historical call without a live model configuration: the base path decides.
        record_endpoint(
            &store,
            "c-coding-history",
            "https://shared.example.com/api/coding/v1/messages",
            ProviderType::Anthropic,
            "legacy-hash",
            "legacy-model",
            30,
            3,
        )
        .await;
        // Not under any configured base path: falls back to the host group.
        record_endpoint(
            &store,
            "c-other",
            "https://shared.example.com/api/other/v1/messages",
            ProviderType::Anthropic,
            "legacy-hash",
            "legacy-model",
            40,
            4,
        )
        .await;

        let overview = store.overview(None, None, None, None, None).await.unwrap();
        let mut ids = overview
            .suppliers
            .iter()
            .map(|supplier| (supplier.supplier_id.clone(), supplier.llm_calls))
            .collect::<Vec<_>>();
        ids.sort_unstable();
        let mut expected = vec![
            ("builtin::host::shared.example.com".to_owned(), 1),
            (format!("builtin::provider::{}", coding_provider.provider_id), 2),
            (format!("builtin::provider::{}", plan_provider.provider_id), 1),
        ];
        expected.sort_unstable();
        assert_eq!(ids, expected);
        assert_eq!(overview.available_suppliers.len(), 3);
    }
}

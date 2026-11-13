//! Efficient SQLite aggregates for the desktop overview dashboard, cost trends,
//! annual activity series, cross-model supplier breakdowns, model summaries,
//! and complete filter candidate lists.

use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    str::FromStr,
};

use chrono::{Days, Utc};
use sqlx::Row;

use crate::{
    model::{
        Overview, OverviewActivityDay, OverviewFilterModel, OverviewFilterSupplier,
        OverviewMetrics, OverviewModelSummary, OverviewSupplierBreakdown, ProviderType,
        SpeedAggregate, SpeedTotals, TokenUsageBucket, TokenUsageGranularity,
    },
    plugin::PluginModelDescriptor,
    pricing::{
        canonical_supplier_id, canonical_supplier_identity, divide_nano_round_half_up,
        endpoint_host, format_nano_usd, source_kind_for, SourceKind,
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
        let supplier_id_expr = supplier_id_sql();

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
               AND (? IS NULL OR supplier_key IN (SELECT value FROM json_each(?)))
               AND (? IS NULL OR {supplier_id_expr} IN (SELECT value FROM json_each(?)))",
            fresh_input = fresh_input_sql(),
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
        let overall_speed = self
            .load_overall_speed(
                start_ms,
                end_ms,
                supplier_keys_json.as_deref(),
                suppliers_json.as_deref(),
            )
            .await?;

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
                COALESCE(SUM(cost_status = 'incomplete_usage'), 0) AS incomplete_usage_calls
             FROM llm_calls
             WHERE status != 'running'
               AND created_at_ms >= ?
               AND (? IS NULL OR created_at_ms < ?)
               AND (? IS NULL OR supplier_key IN (SELECT value FROM json_each(?)))
               AND (? IS NULL OR {supplier_id_expr} IN (SELECT value FROM json_each(?)))
             GROUP BY bucket_start_ms
             ORDER BY bucket_start_ms",
            fresh_input = fresh_input_sql(),
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
            .load_activity_series(supplier_keys_json.as_deref(), suppliers_json.as_deref())
            .await?;

        let (supplier_meta, available_suppliers, available_models) =
            self.load_supplier_metadata(plugin_models).await?;

        let suppliers = self
            .load_supplier_breakdowns(
                start_ms,
                end_ms,
                supplier_keys_json.as_deref(),
                suppliers_json.as_deref(),
                &supplier_meta,
            )
            .await?;

        let models = self
            .load_model_summaries(
                start_ms,
                end_ms,
                supplier_keys_json.as_deref(),
                suppliers_json.as_deref(),
            )
            .await?;

        Ok(Overview {
            metrics,
            token_usage_granularity,
            token_usage_series,
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
        let supplier_id_expr = supplier_id_sql();

        let rows = sqlx::query(&format!(
            "SELECT
                (created_at_ms / {DAY_MS}) * {DAY_MS} AS day_start_ms,
                COALESCE(SUM({fresh_input}), 0)
                  + COALESCE(SUM(COALESCE(cache_read_tokens, 0)), 0)
                  + COALESCE(SUM(COALESCE(cache_write_tokens, 0)), 0)
                  + COALESCE(SUM(COALESCE(output_tokens, 0)), 0) AS token_usage
             FROM llm_calls
             WHERE status != 'running'
               AND created_at_ms >= ?
               AND created_at_ms < ?
               AND (? IS NULL OR supplier_key IN (SELECT value FROM json_each(?)))
               AND (? IS NULL OR {supplier_id_expr} IN (SELECT value FROM json_each(?)))
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

        let mut by_day_ms = HashMap::with_capacity(rows.len());
        for row in rows {
            let day_start_ms: i64 = row.try_get("day_start_ms")?;
            let token_usage = non_negative(row.try_get("token_usage")?);
            by_day_ms.insert(day_start_ms, token_usage);
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
            series.push(OverviewActivityDay {
                date: day.format("%Y-%m-%d").to_string(),
                token_usage: by_day_ms.get(&day_ms).copied().unwrap_or(0),
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
    ) -> Result<SpeedAggregate> {
        let eligible = speed_eligible_sql();
        let supplier_id_expr = supplier_id_sql();
        let row = sqlx::query(&format!(
            "SELECT
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(duration_ms), 0) AS duration_ms,
                COUNT(*) AS samples
             FROM llm_calls
             WHERE {eligible}
               AND (? IS NULL OR created_at_ms >= ?)
               AND (? IS NULL OR created_at_ms < ?)
               AND (? IS NULL OR supplier_key IN (SELECT value FROM json_each(?)))
               AND (? IS NULL OR {supplier_id_expr} IN (SELECT value FROM json_each(?)))"
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
            duration_ms: non_negative(row.try_get("duration_ms")?),
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
                 AND (? IS NULL OR {supplier_id_expr} IN (SELECT value FROM json_each(?)))
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
        group_expr: &str,
    ) -> Result<HashMap<String, SpeedTotals>> {
        let eligible = speed_eligible_sql();
        let supplier_id_expr = supplier_id_sql();
        let rows = sqlx::query(&format!(
            "SELECT {group_expr} AS group_key,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(duration_ms), 0) AS duration_ms,
                COUNT(*) AS samples
             FROM llm_calls
             WHERE {eligible}
               AND (? IS NULL OR created_at_ms >= ?)
               AND (? IS NULL OR created_at_ms < ?)
               AND (? IS NULL OR supplier_key IN (SELECT value FROM json_each(?)))
               AND (? IS NULL OR {supplier_id_expr} IN (SELECT value FROM json_each(?)))
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
                        duration_ms: non_negative(row.try_get("duration_ms")?),
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
        group_expr: &str,
    ) -> Result<HashMap<String, i64>> {
        let supplier_id_expr = supplier_id_sql();
        let rows = sqlx::query(&format!(
            "SELECT group_key, CAST(AVG(ttfo_ms) AS INTEGER) AS median_ms
             FROM (
               SELECT {group_expr} AS group_key, ttfo_ms,
                 ROW_NUMBER() OVER (PARTITION BY {group_expr} ORDER BY ttfo_ms) AS rn,
                 COUNT(*) OVER (PARTITION BY {group_expr}) AS cnt
               FROM llm_calls
               WHERE {eligible}
                 AND ttfo_ms IS NOT NULL
                 AND (? IS NULL OR created_at_ms >= ?)
                 AND (? IS NULL OR created_at_ms < ?)
                 AND (? IS NULL OR supplier_key IN (SELECT value FROM json_each(?)))
                 AND (? IS NULL OR {supplier_id_expr} IN (SELECT value FROM json_each(?)))
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
    ) -> Result<(
        HashMap<String, CanonicalSupplierMeta>,
        Vec<OverviewFilterSupplier>,
        Vec<OverviewFilterModel>,
    )> {
        struct CanonicalSupplierAccum {
            source_kind: SourceKind,
            endpoint_key: String,
            configured_label: Option<String>,
            provider_type: String,
            plugin_icon: Option<String>,
            active: bool,
            model_ids: BTreeSet<String>,
        }

        let mut canonical_suppliers: HashMap<String, CanonicalSupplierAccum> = HashMap::new();
        let mut groups_by_supplier_key: HashMap<String, String> = HashMap::new();

        for model in self.models().await? {
            if let Ok(request_url) = model.request_url() {
                let provider_type = model.provider_type();
                let identity = canonical_supplier_identity(
                    provider_type,
                    &request_url,
                    &model.base_url,
                    &model.model_id,
                );
                let configured_group = model
                    .group_name
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_owned);
                let group = configured_group
                    .clone()
                    .or_else(|| endpoint_host(&identity.endpoint_key))
                    .unwrap_or_else(|| identity.endpoint_key.clone());
                groups_by_supplier_key
                    .entry(identity.supplier_key)
                    .or_insert(group);

                let supplier_id =
                    canonical_supplier_id(identity.source_kind, &identity.endpoint_key);
                let entry = canonical_suppliers.entry(supplier_id).or_insert_with(|| {
                    CanonicalSupplierAccum {
                        source_kind: identity.source_kind,
                        endpoint_key: identity.endpoint_key,
                        configured_label: configured_group.clone(),
                        provider_type: provider_type.as_str().to_owned(),
                        plugin_icon: None,
                        active: true,
                        model_ids: BTreeSet::new(),
                    }
                });
                entry.active = true;
                if entry.configured_label.is_none() {
                    entry.configured_label = configured_group;
                }
                entry.model_ids.insert(identity.model_id);
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
            groups_by_supplier_key
                .entry(identity.supplier_key)
                .or_insert_with(|| plugin.plugin_name.clone());

            let supplier_id = canonical_supplier_id(SourceKind::Plugin, &identity.endpoint_key);
            let entry =
                canonical_suppliers
                    .entry(supplier_id)
                    .or_insert_with(|| CanonicalSupplierAccum {
                        source_kind: SourceKind::Plugin,
                        endpoint_key: identity.endpoint_key,
                        configured_label: Some(plugin.plugin_name.clone()),
                        provider_type: ProviderType::Plugin.as_str().to_owned(),
                        plugin_icon: Some(plugin.icon.clone()),
                        active: true,
                        model_ids: BTreeSet::new(),
                    });
            entry.active = true;
            entry.configured_label = Some(plugin.plugin_name.clone());
            entry.plugin_icon = Some(plugin.icon.clone());
            entry.model_ids.insert(identity.model_id);
        }

        let pricing_views = self.supplier_pricing_models(plugin_models).await?;
        let mut available_models = Vec::new();

        for view in pricing_views {
            if !(view.active || view.call_count > 0) {
                continue;
            }

            let group = groups_by_supplier_key
                .get(&view.supplier_key)
                .cloned()
                .or_else(|| endpoint_host(&view.endpoint_key))
                .unwrap_or_else(|| view.endpoint_key.clone());

            available_models.push(OverviewFilterModel {
                supplier_key: view.supplier_key.clone(),
                source_kind: view.source_kind.as_str().to_owned(),
                endpoint_key: view.endpoint_key.clone(),
                model_id: view.model_id.clone(),
                label: view.display_name.clone(),
                group,
                provider_type: view.provider_type.clone(),
                plugin_icon: view.plugin_icon.clone(),
                active: view.active,
            });

            let supplier_id = canonical_supplier_id(view.source_kind, &view.endpoint_key);
            let entry =
                canonical_suppliers
                    .entry(supplier_id)
                    .or_insert_with(|| CanonicalSupplierAccum {
                        source_kind: view.source_kind,
                        endpoint_key: view.endpoint_key.clone(),
                        configured_label: None,
                        provider_type: view.provider_type.clone(),
                        plugin_icon: view.plugin_icon.clone(),
                        active: view.active,
                        model_ids: BTreeSet::new(),
                    });
            entry.active |= view.active;
            if entry.plugin_icon.is_none() {
                entry.plugin_icon = view.plugin_icon.clone();
            }
            entry.model_ids.insert(view.model_id);
        }

        let mut meta_by_id = HashMap::with_capacity(canonical_suppliers.len());
        let mut available_suppliers: Vec<OverviewFilterSupplier> = canonical_suppliers
            .into_iter()
            .map(|(supplier_id, acc)| {
                let label = acc
                    .configured_label
                    .or_else(|| endpoint_host(&acc.endpoint_key))
                    .unwrap_or_else(|| acc.endpoint_key.clone());
                meta_by_id.insert(
                    supplier_id.clone(),
                    CanonicalSupplierMeta {
                        source_kind: acc.source_kind,
                        endpoint_key: acc.endpoint_key.clone(),
                        label: label.clone(),
                        provider_type: acc.provider_type.clone(),
                        plugin_icon: acc.plugin_icon.clone(),
                        active: acc.active,
                    },
                );
                OverviewFilterSupplier {
                    supplier_id,
                    source_kind: acc.source_kind.as_str().to_owned(),
                    endpoint_key: acc.endpoint_key,
                    label,
                    provider_type: acc.provider_type,
                    plugin_icon: acc.plugin_icon,
                    active: acc.active,
                    model_count: acc.model_ids.len() as i64,
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
        metadata: &HashMap<String, CanonicalSupplierMeta>,
    ) -> Result<Vec<OverviewSupplierBreakdown>> {
        let supplier_id_expr = supplier_id_sql();
        let rows = sqlx::query(&format!(
            "SELECT
                {supplier_id_expr} AS supplier_id,
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
                COALESCE(SUM(pricing_source IS NULL OR pricing_source NOT IN ('custom', 'catalog')), 0) > 0 AS has_unpriced_pricing
             FROM llm_calls
             WHERE status != 'running'
               AND (? IS NULL OR created_at_ms >= ?)
               AND (? IS NULL OR created_at_ms < ?)
               AND (? IS NULL OR supplier_key IN (SELECT value FROM json_each(?)))
               AND (? IS NULL OR {supplier_id_expr} IN (SELECT value FROM json_each(?)))
             GROUP BY {supplier_id_expr}",
            fresh_input = fresh_input_sql(),
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
                supplier_id_expr,
            )
            .await?;
        let first_output_medians = self
            .load_first_output_medians_by(
                start_ms,
                end_ms,
                supplier_keys_json,
                suppliers_json,
                supplier_id_expr,
            )
            .await?;

        let mut breakdowns: Vec<(i64, OverviewSupplierBreakdown)> = Vec::with_capacity(rows.len());
        for row in rows {
            let sql_supplier_id: String = row.try_get("supplier_id")?;
            let request_type_raw: String = row.try_get("request_type")?;
            let request_url: String = row.try_get("request_url")?;
            let provider_url: String = row.try_get("provider_url")?;
            let sample_model_id: String = row.try_get("sample_model_id")?;
            let request_type =
                ProviderType::from_str(&request_type_raw).unwrap_or(ProviderType::OpenAiChat);
            let fallback_identity = canonical_supplier_identity(
                request_type,
                &request_url,
                &provider_url,
                &sample_model_id,
            );
            let endpoint_key = row
                .try_get::<Option<String>, _>("endpoint_key")?
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| fallback_identity.endpoint_key.clone());
            let source_kind = source_kind_for(request_type, &endpoint_key);
            let canonical_id = canonical_supplier_id(source_kind, &endpoint_key);
            let meta = metadata
                .get(&canonical_id)
                .or_else(|| metadata.get(&sql_supplier_id));

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
            let speed_sample = speed_totals
                .get(&sql_supplier_id)
                .copied()
                .unwrap_or_default();
            let first_output_median_ms = first_output_medians.get(&sql_supplier_id).copied();

            let label = meta
                .map(|item| item.label.clone())
                .or_else(|| endpoint_host(&endpoint_key))
                .unwrap_or_else(|| endpoint_key.clone());

            breakdowns.push((
                total_cost_nano,
                OverviewSupplierBreakdown {
                    supplier_id: meta
                        .map(|_| canonical_id.clone())
                        .unwrap_or_else(|| sql_supplier_id.clone()),
                    source_kind: meta
                        .map(|item| item.source_kind.as_str().to_owned())
                        .unwrap_or_else(|| source_kind.as_str().to_owned()),
                    endpoint_key: meta
                        .map(|item| item.endpoint_key.clone())
                        .unwrap_or(endpoint_key),
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
    ) -> Result<Vec<OverviewModelSummary>> {
        let supplier_id_expr = supplier_id_sql();
        let rows = sqlx::query(&format!(
            "SELECT
                model_id,
                COUNT(DISTINCT {supplier_id_expr}) AS supplier_count,
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
                COALESCE(SUM(pricing_source IS NULL OR pricing_source NOT IN ('custom', 'catalog')), 0) > 0 AS has_unpriced_pricing
             FROM llm_calls
             WHERE status != 'running'
               AND (? IS NULL OR created_at_ms >= ?)
               AND (? IS NULL OR created_at_ms < ?)
               AND (? IS NULL OR supplier_key IN (SELECT value FROM json_each(?)))
               AND (? IS NULL OR {supplier_id_expr} IN (SELECT value FROM json_each(?)))
             GROUP BY model_id",
            fresh_input = fresh_input_sql(),
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
    endpoint_key: String,
    label: String,
    provider_type: String,
    plugin_icon: Option<String>,
    active: bool,
}

pub(crate) fn supplier_id_sql() -> &'static str {
    "(CASE
        WHEN request_type = 'plugin'
          OR COALESCE(NULLIF(endpoint_key, ''), request_url, provider_url) LIKE 'plugin://%'
        THEN 'plugin'
        ELSE 'builtin'
      END || '::' || COALESCE(NULLIF(endpoint_key, ''), NULLIF(request_url, ''), provider_url))"
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

/// A call contributes to the pooled end-to-end rate when it succeeded, belongs
/// to a business run, reported an output count, and has a positive wall-clock
/// duration. Streaming is not required because waiting is part of the denominator.
fn speed_eligible_sql() -> &'static str {
    "status = 'completed' AND call_origin = 'run' \
     AND output_tokens IS NOT NULL \
     AND COALESCE(duration_ms, 0) > 0"
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
        model::{CallOrigin, NewLlmCall, ProviderType, Usage},
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
                    error_kind: None,
                    error_message: None,
                },
            )
            .await
            .unwrap();
    }

    /// Model tests must not pollute business speed samples, every completed run
    /// call contributes its output and whole duration, overall/supplier/model
    /// aggregates must match SQL pooling and medians, and the activity calendar
    /// stays fixed at 365 days regardless of start_ms/end_ms.
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
                first_output_ms: 2_000,
                generation_ms: 10_000,
            },
        )
        .await;
        // Too few tokens for a generation sample, but its whole call still joins
        // the end-to-end pool and its wait still joins the median.
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
                first_output_ms: 300,
                generation_ms: 5_000,
            },
        )
        .await;
        // Hidden reasoning no longer changes the end-to-end rate: its wait is in
        // the duration denominator.
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
                endpoint_url: "https://example.com/v1",
                model_id: "glm-4.6",
                display_name: "GLM 4.6",
                output_tokens: 4_000,
                input_tokens: 10,
                reasoning_tokens: 0,
                first_output_ms: 50,
                generation_ms: 1_000,
            },
        )
        .await;

        let overview = store.overview(None, None, None, None, None).await.unwrap();
        assert_eq!(overview.activity_series.len(), 365);

        // Pooled over the three business calls: 1,550 tokens over 23.3 s.
        assert_eq!(overview.metrics.speed.samples, 3);
        assert_eq!(overview.metrics.speed.output_tokens, 1_550);
        assert_eq!(overview.metrics.speed.duration_ms, 23_300);
        assert!((overview.metrics.speed.average_tokens_per_second.unwrap() - 66.524).abs() < 0.001);
        assert_eq!(overview.metrics.speed.first_output_median_ms, Some(1_000));
        // The JSON contract the desktop reads; a rename here must update the client type.
        let speed_json = serde_json::to_value(overview.metrics.speed).unwrap();
        assert_eq!(speed_json["samples"], 3);
        assert_eq!(speed_json["output_tokens"], 1_550);
        assert_eq!(speed_json["duration_ms"], 23_300);

        let model = overview
            .models
            .iter()
            .find(|item| item.model_id == "glm-4.6")
            .expect("model summary");
        assert_eq!(model.speed.samples, 3);
        assert_eq!(model.speed.output_tokens, 1_550);
        assert_eq!(model.speed.duration_ms, 23_300);
        assert!((model.speed.average_tokens_per_second.unwrap() - 66.524).abs() < 0.001);
        assert_eq!(model.speed.first_output_median_ms, Some(1_000));

        let supplier = overview
            .suppliers
            .iter()
            .find(|item| item.endpoint_key == "https://example.com/v1/chat/completions")
            .expect("supplier breakdown");
        assert_eq!(supplier.speed.samples, 3);
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
    async fn supplier_aggregation_keeps_same_name_endpoints_separate_and_sorts_models_by_token_usage(
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
                reasoning_tokens: 0,
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
        assert_eq!(all.models[1].model_id, "model-small");
        assert_eq!(all.models[1].token_usage, 300);
        assert_eq!(all.models[1].supplier_count, 1);

        // Supplier filter selects all models belonging to endpoint A without leaking endpoint B.
        let supplier_a = &all
            .suppliers
            .iter()
            .find(|s| s.endpoint_key == "https://api-a.example.com/v1/chat/completions")
            .unwrap()
            .supplier_id;
        assert_eq!(all.suppliers[0].supplier_id, *supplier_a);
        assert_eq!(all.suppliers[0].model_count, 2);
        assert_eq!(all.suppliers[0].token_usage, 5_300);

        let filtered = store
            .overview(
                None,
                None,
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
    }
}

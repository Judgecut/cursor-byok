//! Persistence for public model pricing catalog, supplier pricing bindings/overrides,
//! snapshot resolution, and idempotent backfill batches.
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    str::FromStr,
};

use serde::{Deserialize, Serialize};
use sqlx::{Row, SqliteConnection};

use crate::{
    model::{ProviderType, Usage},
    plugin::PluginModelDescriptor,
    pricing::{
        canonical_supplier_identity, canonicalize_custom_price, parse_models_dev_catalog,
        resolve_supplier_pricing, BindingMode, CalculatedCost, CatalogMatchKind, CatalogModel,
        CostStatus, ModelPricingConfig, PricingRates, PricingSnapshot, PricingSource,
        PricingSyncState, SourceKind, SupplierIdentity, DEFAULT_SYNC_INTERVAL_HOURS,
    },
    Error, Result,
};

use super::{now_ms, Store};

const PRICING_SYNC_SETTING_KEY: &str = "pricing_catalog_sync";
const CATALOG_SEARCH_DEFAULT_LIMIT: i64 = 100;
const CATALOG_SEARCH_MAX_LIMIT: i64 = 200;

#[derive(Clone, Debug)]
pub enum BackfillCallUpdate {
    Priced {
        call_id: String,
        snapshot: PricingSnapshot,
        calculated: CalculatedCost,
    },
    StillUnpriced {
        call_id: String,
        snapshot: PricingSnapshot,
    },
    IncompleteUsage {
        call_id: String,
    },
}

#[derive(Clone, Debug)]
pub struct BackfillCandidate {
    pub rowid: i64,
    pub call_id: String,
    pub request_type: ProviderType,
    pub identity: SupplierIdentity,
    pub usage: Usage,
}

#[derive(Clone, Debug, Serialize)]
pub struct CatalogProviderOption {
    pub provider_id: String,
    pub provider_name: String,
    pub provider_api: Option<String>,
    pub model_count: i64,
}

#[derive(Clone, Debug, Serialize)]
pub struct CatalogSearchResult {
    pub total: i64,
    pub providers: Vec<CatalogProviderOption>,
    pub items: Vec<CatalogModel>,
}

#[derive(Clone, Debug, Serialize)]
pub struct SupplierPricingView {
    pub supplier_key: String,
    pub source_kind: SourceKind,
    pub endpoint_key: String,
    pub model_id: String,
    pub display_name: String,
    pub provider_type: String,
    pub plugin_icon: Option<String>,
    pub active: bool,
    pub call_count: i64,
    pub unpriced_call_count: i64,
    pub binding_mode: BindingMode,
    pub catalog_match_kind: CatalogMatchKind,
    pub matched_provider_id: Option<String>,
    pub matched_provider_name: Option<String>,
    pub matched_model_id: Option<String>,
    pub matched_model_name: Option<String>,
    pub matched_rates: Option<PricingRates>,
    pub custom_rates: PricingRates,
    pub effective_source: PricingSource,
    pub effective_rates: PricingRates,
    pub updated_at_ms: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct SaveSupplierPricingInput {
    pub source_kind: SourceKind,
    pub endpoint_key: String,
    pub model_id: String,
    pub binding_mode: BindingMode,
    #[serde(default)]
    pub catalog_provider_id: Option<String>,
    #[serde(default)]
    pub catalog_model_id: Option<String>,
    #[serde(default)]
    pub custom_rates: PricingRates,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct StoredSyncMeta {
    #[serde(default = "default_true")]
    auto_sync_enabled: bool,
    #[serde(default)]
    last_attempted_at_ms: Option<i64>,
    #[serde(default)]
    last_synced_at_ms: Option<i64>,
    #[serde(default)]
    last_error: Option<String>,
}

impl Default for StoredSyncMeta {
    fn default() -> Self {
        Self {
            auto_sync_enabled: true,
            last_attempted_at_ms: None,
            last_synced_at_ms: None,
            last_error: None,
        }
    }
}

fn default_true() -> bool {
    true
}

impl Store {
    pub(crate) async fn ensure_llm_call_supplier_keys(&self) -> Result<usize> {
        let missing = sqlx::query(
            "SELECT call_id, request_type, request_url, provider_url, model_id
             FROM llm_calls
             WHERE supplier_key IS NULL OR endpoint_key IS NULL",
        )
        .fetch_all(&self.pool)
        .await?;
        if missing.is_empty() {
            return Ok(0);
        }

        let _write = self.writes.lock().await;
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let mut updated = 0usize;
        for row in missing {
            let call_id: String = row.try_get("call_id")?;
            let request_type_raw: String = row.try_get("request_type")?;
            let request_url: String = row.try_get("request_url")?;
            let provider_url: String = row.try_get("provider_url")?;
            let model_id: String = row.try_get("model_id")?;
            let request_type =
                ProviderType::from_str(&request_type_raw).unwrap_or(ProviderType::OpenAiChat);
            let identity =
                canonical_supplier_identity(request_type, &request_url, &provider_url, &model_id);
            let result = sqlx::query(
                "UPDATE llm_calls
                 SET supplier_key = COALESCE(supplier_key, ?),
                     endpoint_key = COALESCE(endpoint_key, ?)
                 WHERE call_id = ?",
            )
            .bind(&identity.supplier_key)
            .bind(&identity.endpoint_key)
            .bind(&call_id)
            .execute(&mut *transaction)
            .await?;
            updated += result.rows_affected() as usize;
        }
        transaction.commit().await?;
        Ok(updated)
    }

    pub(crate) async fn unpriced_finished_calls_batch(
        &self,
        after_rowid: i64,
        limit: usize,
    ) -> Result<Vec<BackfillCandidate>> {
        let rows = sqlx::query(
            "SELECT
                rowid,
                call_id,
                request_type,
                request_url,
                provider_url,
                model_id,
                input_tokens,
                output_tokens,
                cache_read_tokens,
                cache_write_tokens,
                reasoning_tokens
             FROM llm_calls
             WHERE rowid > ?
               AND status != 'running'
               AND (cost_status IS NULL OR cost_status = 'unpriced')
             ORDER BY rowid ASC
             LIMIT ?",
        )
        .bind(after_rowid)
        .bind(limit.clamp(1, 500) as i64)
        .fetch_all(&self.pool)
        .await?;

        rows.into_iter()
            .map(|row| {
                let request_type_raw: String = row.try_get("request_type")?;
                let request_url: String = row.try_get("request_url")?;
                let provider_url: String = row.try_get("provider_url")?;
                let model_id: String = row.try_get("model_id")?;
                let request_type =
                    ProviderType::from_str(&request_type_raw).unwrap_or(ProviderType::OpenAiChat);
                let identity = canonical_supplier_identity(
                    request_type,
                    &request_url,
                    &provider_url,
                    &model_id,
                );
                Ok(BackfillCandidate {
                    rowid: row.try_get("rowid")?,
                    call_id: row.try_get("call_id")?,
                    request_type,
                    identity,
                    usage: Usage {
                        input_tokens: to_opt_u64(row.try_get("input_tokens")?),
                        context_input_tokens: None,
                        output_tokens: to_opt_u64(row.try_get("output_tokens")?),
                        total_tokens: None,
                        cache_read_tokens: to_opt_u64(row.try_get("cache_read_tokens")?),
                        cache_write_tokens: to_opt_u64(row.try_get("cache_write_tokens")?),
                        reasoning_tokens: to_opt_u64(row.try_get("reasoning_tokens")?),
                    },
                })
            })
            .collect()
    }

    pub(crate) async fn resolve_snapshot_for_identity(
        &self,
        identity: &SupplierIdentity,
    ) -> Result<PricingSnapshot> {
        let mut conn = self.pool.acquire().await?;
        resolve_snapshot_conn(&mut conn, identity, now_ms()).await
    }

    pub(crate) async fn apply_backfill_batch(&self, updates: &[BackfillCallUpdate]) -> Result<()> {
        if updates.is_empty() {
            return Ok(());
        }
        let now = now_ms();
        let _write = self.writes.lock().await;
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        for update in updates {
            match update {
                BackfillCallUpdate::Priced {
                    call_id,
                    snapshot,
                    calculated,
                } => {
                    sqlx::query(
                        "UPDATE llm_calls SET
                            pricing_source = ?,
                            pricing_provider_id = ?,
                            pricing_model_id = ?,
                            pricing_snapshot_at_ms = ?,
                            unit_input_per_million = ?,
                            unit_output_per_million = ?,
                            unit_cache_read_per_million = ?,
                            unit_cache_write_per_million = ?,
                            cost_status = ?,
                            input_cost_nano = ?,
                            output_cost_nano = ?,
                            cache_read_cost_nano = ?,
                            cache_write_cost_nano = ?,
                            total_cost_nano = ?,
                            cost_calculated_at_ms = ?,
                            cost_backfilled = 1
                         WHERE call_id = ?
                           AND status != 'running'
                           AND (cost_status IS NULL OR cost_status = 'unpriced')",
                    )
                    .bind(snapshot.source.as_str())
                    .bind(&snapshot.provider_id)
                    .bind(&snapshot.model_id)
                    .bind(snapshot.snapshot_at_ms)
                    .bind(&snapshot.rates.input_per_million)
                    .bind(&snapshot.rates.output_per_million)
                    .bind(&snapshot.rates.cache_read_per_million)
                    .bind(&snapshot.rates.cache_write_per_million)
                    .bind(CostStatus::Priced.as_str())
                    .bind(calculated.input_cost_nano)
                    .bind(calculated.output_cost_nano)
                    .bind(calculated.cache_read_cost_nano)
                    .bind(calculated.cache_write_cost_nano)
                    .bind(calculated.total_cost_nano)
                    .bind(now)
                    .bind(call_id)
                    .execute(&mut *transaction)
                    .await?;
                }
                BackfillCallUpdate::StillUnpriced { call_id, snapshot } => {
                    sqlx::query(
                        "UPDATE llm_calls SET
                            pricing_source = ?,
                            pricing_provider_id = ?,
                            pricing_model_id = ?,
                            pricing_snapshot_at_ms = ?,
                            unit_input_per_million = ?,
                            unit_output_per_million = ?,
                            unit_cache_read_per_million = ?,
                            unit_cache_write_per_million = ?,
                            cost_status = ?,
                            input_cost_nano = NULL,
                            output_cost_nano = NULL,
                            cache_read_cost_nano = NULL,
                            cache_write_cost_nano = NULL,
                            total_cost_nano = NULL,
                            cost_calculated_at_ms = ?,
                            cost_backfilled = 0
                         WHERE call_id = ?
                           AND status != 'running'
                           AND (cost_status IS NULL OR cost_status = 'unpriced')",
                    )
                    .bind(snapshot.source.as_str())
                    .bind(&snapshot.provider_id)
                    .bind(&snapshot.model_id)
                    .bind(snapshot.snapshot_at_ms)
                    .bind(&snapshot.rates.input_per_million)
                    .bind(&snapshot.rates.output_per_million)
                    .bind(&snapshot.rates.cache_read_per_million)
                    .bind(&snapshot.rates.cache_write_per_million)
                    .bind(CostStatus::Unpriced.as_str())
                    .bind(now)
                    .bind(call_id)
                    .execute(&mut *transaction)
                    .await?;
                }
                BackfillCallUpdate::IncompleteUsage { call_id } => {
                    sqlx::query(
                        "UPDATE llm_calls SET
                            cost_status = ?,
                            input_cost_nano = NULL,
                            output_cost_nano = NULL,
                            cache_read_cost_nano = NULL,
                            cache_write_cost_nano = NULL,
                            total_cost_nano = NULL,
                            cost_calculated_at_ms = ?,
                            cost_backfilled = 0
                         WHERE call_id = ?
                           AND status != 'running'
                           AND (cost_status IS NULL OR cost_status = 'unpriced')",
                    )
                    .bind(CostStatus::IncompleteUsage.as_str())
                    .bind(now)
                    .bind(call_id)
                    .execute(&mut *transaction)
                    .await?;
                }
            }
        }
        transaction.commit().await?;
        Ok(())
    }

    pub(crate) async fn pricing_sync_state(&self) -> Result<PricingSyncState> {
        let meta = read_sync_meta(&self.pool).await?;
        let catalog_model_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM pricing_catalog_models")
                .fetch_one(&self.pool)
                .await?;
        Ok(PricingSyncState {
            auto_sync_enabled: meta.auto_sync_enabled,
            sync_interval_hours: DEFAULT_SYNC_INTERVAL_HOURS,
            catalog_model_count,
            last_attempted_at_ms: meta.last_attempted_at_ms,
            last_synced_at_ms: meta.last_synced_at_ms,
            last_error: meta.last_error,
            syncing: false,
            backfilling: false,
        })
    }

    pub(crate) async fn set_pricing_auto_sync(&self, enabled: bool) -> Result<()> {
        let _write = self.writes.lock().await;
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let mut meta = read_sync_meta_conn(&mut transaction).await?;
        meta.auto_sync_enabled = enabled;
        write_sync_meta_conn(&mut transaction, &meta, now_ms()).await?;
        transaction.commit().await?;
        Ok(())
    }

    pub(crate) async fn replace_pricing_catalog(
        &self,
        entries: &[CatalogModel],
        attempted_at_ms: i64,
        synced_at_ms: i64,
    ) -> Result<()> {
        let _write = self.writes.lock().await;
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        sqlx::query("DELETE FROM pricing_catalog_models")
            .execute(&mut *transaction)
            .await?;

        for entry in entries {
            sqlx::query(
                "INSERT INTO pricing_catalog_models(
                    provider_id, provider_name, provider_api, model_id, model_name,
                    input_per_million, output_per_million, cache_read_per_million,
                    cache_write_per_million, synced_at_ms
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(provider_id, model_id) DO UPDATE SET
                    provider_name = excluded.provider_name,
                    provider_api = excluded.provider_api,
                    model_name = excluded.model_name,
                    input_per_million = excluded.input_per_million,
                    output_per_million = excluded.output_per_million,
                    cache_read_per_million = excluded.cache_read_per_million,
                    cache_write_per_million = excluded.cache_write_per_million,
                    synced_at_ms = excluded.synced_at_ms",
            )
            .bind(&entry.provider_id)
            .bind(&entry.provider_name)
            .bind(&entry.provider_api)
            .bind(&entry.model_id)
            .bind(&entry.model_name)
            .bind(&entry.rates.input_per_million)
            .bind(&entry.rates.output_per_million)
            .bind(&entry.rates.cache_read_per_million)
            .bind(&entry.rates.cache_write_per_million)
            .bind(entry.synced_at_ms)
            .execute(&mut *transaction)
            .await?;
        }

        let mut meta = read_sync_meta_conn(&mut transaction).await?;
        meta.last_attempted_at_ms = Some(attempted_at_ms);
        meta.last_synced_at_ms = Some(synced_at_ms);
        meta.last_error = None;
        write_sync_meta_conn(&mut transaction, &meta, synced_at_ms).await?;
        transaction.commit().await?;
        Ok(())
    }

    pub(crate) async fn record_pricing_sync_failure(
        &self,
        attempted_at_ms: i64,
        error: &str,
    ) -> Result<()> {
        let _write = self.writes.lock().await;
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let mut meta = read_sync_meta_conn(&mut transaction).await?;
        meta.last_attempted_at_ms = Some(attempted_at_ms);
        meta.last_error = Some(error.chars().take(500).collect());
        write_sync_meta_conn(&mut transaction, &meta, attempted_at_ms).await?;
        transaction.commit().await?;
        Ok(())
    }

    pub async fn replace_pricing_catalog_from_json(
        &self,
        bytes: &[u8],
        synced_at_ms: i64,
    ) -> Result<usize> {
        let entries = parse_models_dev_catalog(bytes, synced_at_ms)?;
        let count = entries.len();
        self.replace_pricing_catalog(&entries, synced_at_ms, synced_at_ms)
            .await?;
        Ok(count)
    }

    pub async fn search_pricing_catalog(
        &self,
        query: Option<&str>,
        provider_id: Option<&str>,
        limit: Option<i64>,
        offset: Option<i64>,
    ) -> Result<CatalogSearchResult> {
        let provider_rows = sqlx::query(
            "SELECT
                provider_id,
                MAX(provider_name) AS provider_name,
                MAX(provider_api) AS provider_api,
                COUNT(*) AS model_count
             FROM pricing_catalog_models
             GROUP BY provider_id
             ORDER BY LOWER(MAX(provider_name)), provider_id",
        )
        .fetch_all(&self.pool)
        .await?;

        let providers = provider_rows
            .into_iter()
            .map(|row| {
                Ok(CatalogProviderOption {
                    provider_id: row.try_get("provider_id")?,
                    provider_name: row.try_get("provider_name")?,
                    provider_api: row.try_get("provider_api")?,
                    model_count: row.try_get("model_count")?,
                })
            })
            .collect::<Result<Vec<_>>>()?;

        let provider_filter = provider_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned);
        let search_like = query
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| format!("%{}%", escape_like(&value.to_ascii_lowercase())));

        let limit = limit
            .unwrap_or(CATALOG_SEARCH_DEFAULT_LIMIT)
            .clamp(1, CATALOG_SEARCH_MAX_LIMIT);
        let offset = offset.unwrap_or(0).max(0);

        let total: i64 = sqlx::query_scalar(
            "SELECT COUNT(*)
             FROM pricing_catalog_models
             WHERE (? IS NULL OR provider_id = ?)
               AND (
                 ? IS NULL
                 OR LOWER(model_id) LIKE ? ESCAPE '\\'
                 OR LOWER(model_name) LIKE ? ESCAPE '\\'
                 OR LOWER(provider_id) LIKE ? ESCAPE '\\'
                 OR LOWER(provider_name) LIKE ? ESCAPE '\\'
                 OR LOWER(provider_api) LIKE ? ESCAPE '\\'
               )",
        )
        .bind(&provider_filter)
        .bind(&provider_filter)
        .bind(&search_like)
        .bind(&search_like)
        .bind(&search_like)
        .bind(&search_like)
        .bind(&search_like)
        .bind(&search_like)
        .fetch_one(&self.pool)
        .await?;

        let item_rows = sqlx::query(
            "SELECT
                provider_id, provider_name, provider_api, model_id, model_name,
                input_per_million, output_per_million, cache_read_per_million,
                cache_write_per_million, synced_at_ms
             FROM pricing_catalog_models
             WHERE (? IS NULL OR provider_id = ?)
               AND (
                 ? IS NULL
                 OR LOWER(model_id) LIKE ? ESCAPE '\\'
                 OR LOWER(model_name) LIKE ? ESCAPE '\\'
                 OR LOWER(provider_id) LIKE ? ESCAPE '\\'
                 OR LOWER(provider_name) LIKE ? ESCAPE '\\'
                 OR LOWER(provider_api) LIKE ? ESCAPE '\\'
               )
             ORDER BY LOWER(provider_name), provider_id, LOWER(model_id)
             LIMIT ? OFFSET ?",
        )
        .bind(&provider_filter)
        .bind(&provider_filter)
        .bind(&search_like)
        .bind(&search_like)
        .bind(&search_like)
        .bind(&search_like)
        .bind(&search_like)
        .bind(&search_like)
        .bind(limit)
        .bind(offset)
        .fetch_all(&self.pool)
        .await?;

        let items = item_rows
            .into_iter()
            .map(catalog_model_from_row)
            .collect::<Result<Vec<_>>>()?;

        Ok(CatalogSearchResult {
            total,
            providers,
            items,
        })
    }

    pub async fn supplier_pricing_models(
        &self,
        plugin_models: &[PluginModelDescriptor],
    ) -> Result<Vec<SupplierPricingView>> {
        let now = now_ms();
        let active_models = self.models().await?;

        struct SupplierEntry {
            identity: SupplierIdentity,
            display_name: String,
            provider_type: String,
            plugin_icon: Option<String>,
            active: bool,
            call_count: i64,
            unpriced_call_count: i64,
        }

        let mut map: BTreeMap<String, SupplierEntry> = BTreeMap::new();

        for model in active_models {
            let Ok(request_url) = model.request_url() else {
                continue;
            };
            let provider_type = model.provider_type();
            let identity = canonical_supplier_identity(
                provider_type,
                &request_url,
                &model.base_url,
                &model.model_id,
            );
            map.entry(identity.supplier_key.clone())
                .or_insert_with(|| SupplierEntry {
                    identity,
                    display_name: model.display_name.clone(),
                    provider_type: provider_type.as_str().to_owned(),
                    plugin_icon: None,
                    active: true,
                    call_count: 0,
                    unpriced_call_count: 0,
                });
        }

        for plugin in plugin_models {
            let endpoint_url = format!("plugin://{}/{}", plugin.plugin_id, plugin.provider_id);
            let identity = canonical_supplier_identity(
                ProviderType::Plugin,
                &endpoint_url,
                &endpoint_url,
                &plugin.model_id,
            );
            map.entry(identity.supplier_key.clone())
                .and_modify(|existing| {
                    existing.display_name = plugin.display_name.clone();
                    existing.plugin_icon = Some(plugin.icon.clone());
                    existing.active = true;
                })
                .or_insert_with(|| SupplierEntry {
                    identity,
                    display_name: plugin.display_name.clone(),
                    provider_type: ProviderType::Plugin.as_str().to_owned(),
                    plugin_icon: Some(plugin.icon.clone()),
                    active: true,
                    call_count: 0,
                    unpriced_call_count: 0,
                });
        }

        let call_stats = sqlx::query(
            "SELECT
                supplier_key,
                MAX(endpoint_key) AS endpoint_key,
                model_id,
                MAX(request_type) AS request_type,
                MAX(request_url) AS request_url,
                MAX(provider_url) AS provider_url,
                MAX(display_name) AS latest_display_name,
                COUNT(CASE WHEN status != 'running' THEN 1 END) AS finished_calls,
                COUNT(
                    CASE WHEN status != 'running'
                              AND (cost_status IS NULL OR cost_status = 'unpriced')
                    THEN 1 END
                ) AS unpriced_calls
             FROM llm_calls
             GROUP BY supplier_key, model_id",
        )
        .fetch_all(&self.pool)
        .await?;

        for row in call_stats {
            let model_id: String = row.try_get("model_id")?;
            let request_type_raw: String = row.try_get("request_type")?;
            let request_url: String = row.try_get("request_url")?;
            let provider_url: String = row.try_get("provider_url")?;
            let request_type =
                ProviderType::from_str(&request_type_raw).unwrap_or(ProviderType::OpenAiChat);
            let fallback_identity =
                canonical_supplier_identity(request_type, &request_url, &provider_url, &model_id);
            let supplier_key: String = row
                .try_get::<Option<String>, _>("supplier_key")?
                .unwrap_or_else(|| fallback_identity.supplier_key.clone());
            let endpoint_key: String = row
                .try_get::<Option<String>, _>("endpoint_key")?
                .unwrap_or_else(|| fallback_identity.endpoint_key.clone());
            let source_kind =
                if request_type == ProviderType::Plugin || endpoint_key.starts_with("plugin://") {
                    SourceKind::Plugin
                } else {
                    SourceKind::Builtin
                };
            let latest_display_name: String = row.try_get("latest_display_name")?;
            let finished_calls: i64 = row.try_get("finished_calls")?;
            let unpriced_calls: i64 = row.try_get("unpriced_calls")?;

            let entry = map
                .entry(supplier_key.clone())
                .or_insert_with(|| SupplierEntry {
                    identity: SupplierIdentity {
                        supplier_key,
                        source_kind,
                        endpoint_key,
                        model_id,
                    },
                    display_name: latest_display_name,
                    provider_type: request_type_raw,
                    plugin_icon: None,
                    active: false,
                    call_count: 0,
                    unpriced_call_count: 0,
                });
            entry.call_count += finished_calls;
            entry.unpriced_call_count += unpriced_calls;
        }

        let configs = load_all_pricing_configs(&self.pool).await?;
        for config in configs.values() {
            map.entry(config.supplier_key.clone())
                .or_insert_with(|| SupplierEntry {
                    identity: SupplierIdentity {
                        supplier_key: config.supplier_key.clone(),
                        source_kind: config.source_kind,
                        endpoint_key: config.endpoint_key.clone(),
                        model_id: config.model_id.clone(),
                    },
                    display_name: config.model_id.clone(),
                    provider_type: match config.source_kind {
                        SourceKind::Plugin => ProviderType::Plugin.as_str().to_owned(),
                        SourceKind::Builtin => ProviderType::OpenAiChat.as_str().to_owned(),
                    },
                    plugin_icon: None,
                    active: false,
                    call_count: 0,
                    unpriced_call_count: 0,
                });
        }

        let model_ids: BTreeSet<String> = map
            .values()
            .map(|entry| entry.identity.model_id.clone())
            .collect();
        let candidates_by_model = load_catalog_by_model_ids(&self.pool, &model_ids).await?;

        let manual_refs: BTreeSet<(String, String)> = configs
            .values()
            .filter_map(|config| {
                config
                    .catalog_provider_id
                    .clone()
                    .zip(config.catalog_model_id.clone())
            })
            .collect();
        let manual_entries = load_catalog_entries_by_refs(&self.pool, &manual_refs).await?;

        let mut views: Vec<SupplierPricingView> = map
            .into_values()
            .map(|entry| {
                let config = configs.get(&entry.identity.supplier_key);
                let candidates = candidates_by_model
                    .get(&entry.identity.model_id)
                    .map(Vec::as_slice)
                    .unwrap_or(&[]);
                let manual_entry = config
                    .and_then(|cfg| {
                        cfg.catalog_provider_id
                            .clone()
                            .zip(cfg.catalog_model_id.clone())
                    })
                    .and_then(|key| manual_entries.get(&key).cloned());
                let resolved = resolve_supplier_pricing(
                    &entry.identity,
                    config,
                    candidates,
                    manual_entry,
                    now,
                );
                let matched_entry = resolved.catalog_entry.as_ref();
                SupplierPricingView {
                    supplier_key: entry.identity.supplier_key,
                    source_kind: entry.identity.source_kind,
                    endpoint_key: entry.identity.endpoint_key,
                    model_id: entry.identity.model_id,
                    display_name: entry.display_name,
                    provider_type: entry.provider_type,
                    plugin_icon: entry.plugin_icon,
                    active: entry.active,
                    call_count: entry.call_count,
                    unpriced_call_count: entry.unpriced_call_count,
                    binding_mode: resolved.binding_mode,
                    catalog_match_kind: resolved.catalog_match_kind,
                    matched_provider_id: matched_entry
                        .map(|item| item.provider_id.clone())
                        .or_else(|| {
                            resolved
                                .configured_catalog_ref
                                .as_ref()
                                .map(|(provider_id, _)| provider_id.clone())
                        }),
                    matched_provider_name: matched_entry.map(|item| item.provider_name.clone()),
                    matched_model_id: matched_entry.map(|item| item.model_id.clone()).or_else(
                        || {
                            resolved
                                .configured_catalog_ref
                                .as_ref()
                                .map(|(_, model_id)| model_id.clone())
                        },
                    ),
                    matched_model_name: matched_entry.map(|item| item.model_name.clone()),
                    matched_rates: matched_entry.map(|item| item.rates.clone()),
                    custom_rates: resolved.custom_rates,
                    effective_source: resolved.snapshot.source,
                    effective_rates: resolved.snapshot.rates,
                    updated_at_ms: config.map(|cfg| cfg.updated_at_ms),
                }
            })
            .collect();

        views.sort_by(|left, right| {
            right
                .active
                .cmp(&left.active)
                .then_with(|| right.call_count.cmp(&left.call_count))
                .then_with(|| {
                    left.display_name
                        .to_lowercase()
                        .cmp(&right.display_name.to_lowercase())
                })
                .then_with(|| left.model_id.cmp(&right.model_id))
                .then_with(|| left.supplier_key.cmp(&right.supplier_key))
        });

        Ok(views)
    }

    pub async fn save_supplier_pricing_config(
        &self,
        input: &SaveSupplierPricingInput,
        plugin_models: &[PluginModelDescriptor],
    ) -> Result<SupplierPricingView> {
        let identity = crate::pricing::build_supplier_identity(
            input.source_kind,
            &input.endpoint_key,
            &input.model_id,
        )?;
        let custom_rates = PricingRates {
            input_per_million: canonicalize_custom_price(
                input.custom_rates.input_per_million.as_deref(),
            )?,
            output_per_million: canonicalize_custom_price(
                input.custom_rates.output_per_million.as_deref(),
            )?,
            cache_read_per_million: canonicalize_custom_price(
                input.custom_rates.cache_read_per_million.as_deref(),
            )?,
            cache_write_per_million: canonicalize_custom_price(
                input.custom_rates.cache_write_per_million.as_deref(),
            )?,
        };

        let (catalog_provider_id, catalog_model_id) = match input.binding_mode {
            BindingMode::Auto => (None, None),
            BindingMode::Manual => {
                let provider_id = input
                    .catalog_provider_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| {
                        Error::Config("manual pricing binding requires catalog_provider_id".into())
                    })?
                    .to_owned();
                let model_id = input
                    .catalog_model_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| {
                        Error::Config("manual pricing binding requires catalog_model_id".into())
                    })?
                    .to_owned();
                (Some(provider_id), Some(model_id))
            }
        };

        let now = now_ms();
        let _write = self.writes.lock().await;
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;

        if let (Some(provider_id), Some(model_id)) = (&catalog_provider_id, &catalog_model_id) {
            let exists_in_catalog: bool = sqlx::query_scalar(
                "SELECT EXISTS(
                    SELECT 1 FROM pricing_catalog_models
                    WHERE provider_id = ? AND model_id = ?
                )",
            )
            .bind(provider_id)
            .bind(model_id)
            .fetch_one(&mut *transaction)
            .await?;

            if !exists_in_catalog {
                let unchanged_existing_manual = if custom_rates.has_any() {
                    sqlx::query_scalar::<_, bool>(
                        "SELECT EXISTS(
                            SELECT 1 FROM model_pricing_configs
                            WHERE supplier_key = ?
                              AND binding_mode = 'manual'
                              AND catalog_provider_id = ?
                              AND catalog_model_id = ?
                        )",
                    )
                    .bind(&identity.supplier_key)
                    .bind(provider_id)
                    .bind(model_id)
                    .fetch_one(&mut *transaction)
                    .await?
                } else {
                    false
                };
                if !unchanged_existing_manual {
                    return Err(Error::Config(format!(
                        "catalog model '{provider_id}/{model_id}' does not exist in synced catalog"
                    )));
                }
            }
        }

        if input.binding_mode == BindingMode::Auto && !custom_rates.has_any() {
            sqlx::query("DELETE FROM model_pricing_configs WHERE supplier_key = ?")
                .bind(&identity.supplier_key)
                .execute(&mut *transaction)
                .await?;
        } else {
            sqlx::query(
                "INSERT INTO model_pricing_configs(
                    supplier_key, source_kind, endpoint_key, model_id, binding_mode,
                    catalog_provider_id, catalog_model_id,
                    custom_input_per_million, custom_output_per_million,
                    custom_cache_read_per_million, custom_cache_write_per_million,
                    updated_at_ms
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(supplier_key) DO UPDATE SET
                    source_kind = excluded.source_kind,
                    endpoint_key = excluded.endpoint_key,
                    model_id = excluded.model_id,
                    binding_mode = excluded.binding_mode,
                    catalog_provider_id = excluded.catalog_provider_id,
                    catalog_model_id = excluded.catalog_model_id,
                    custom_input_per_million = excluded.custom_input_per_million,
                    custom_output_per_million = excluded.custom_output_per_million,
                    custom_cache_read_per_million = excluded.custom_cache_read_per_million,
                    custom_cache_write_per_million = excluded.custom_cache_write_per_million,
                    updated_at_ms = excluded.updated_at_ms",
            )
            .bind(&identity.supplier_key)
            .bind(identity.source_kind.as_str())
            .bind(&identity.endpoint_key)
            .bind(&identity.model_id)
            .bind(input.binding_mode.as_str())
            .bind(&catalog_provider_id)
            .bind(&catalog_model_id)
            .bind(&custom_rates.input_per_million)
            .bind(&custom_rates.output_per_million)
            .bind(&custom_rates.cache_read_per_million)
            .bind(&custom_rates.cache_write_per_million)
            .bind(now)
            .execute(&mut *transaction)
            .await?;
        }

        transaction.commit().await?;
        drop(_write);

        let all = self.supplier_pricing_models(plugin_models).await?;
        all.into_iter()
            .find(|item| item.supplier_key == identity.supplier_key)
            .ok_or_else(|| Error::Store("saved supplier pricing view disappeared".into()))
    }
}

pub(crate) async fn resolve_snapshot_conn(
    conn: &mut SqliteConnection,
    identity: &SupplierIdentity,
    now_ms: i64,
) -> Result<PricingSnapshot> {
    let config_row = sqlx::query(
        "SELECT
            supplier_key, source_kind, endpoint_key, model_id, binding_mode,
            catalog_provider_id, catalog_model_id,
            custom_input_per_million, custom_output_per_million,
            custom_cache_read_per_million, custom_cache_write_per_million,
            updated_at_ms
         FROM model_pricing_configs
         WHERE supplier_key = ?",
    )
    .bind(&identity.supplier_key)
    .fetch_optional(&mut *conn)
    .await?;

    let config = config_row.map(config_from_row).transpose()?;

    let (candidates, manual_entry) = match &config {
        Some(cfg) if cfg.binding_mode == BindingMode::Manual => {
            let manual = if let (Some(provider_id), Some(model_id)) =
                (&cfg.catalog_provider_id, &cfg.catalog_model_id)
            {
                sqlx::query(
                    "SELECT
                        provider_id, provider_name, provider_api, model_id, model_name,
                        input_per_million, output_per_million, cache_read_per_million,
                        cache_write_per_million, synced_at_ms
                     FROM pricing_catalog_models
                     WHERE provider_id = ? AND model_id = ?",
                )
                .bind(provider_id)
                .bind(model_id)
                .fetch_optional(&mut *conn)
                .await?
                .map(catalog_model_from_row)
                .transpose()?
            } else {
                None
            };
            (Vec::new(), manual)
        }
        _ => {
            let rows = sqlx::query(
                "SELECT
                    provider_id, provider_name, provider_api, model_id, model_name,
                    input_per_million, output_per_million, cache_read_per_million,
                    cache_write_per_million, synced_at_ms
                 FROM pricing_catalog_models
                 WHERE model_id = ?",
            )
            .bind(&identity.model_id)
            .fetch_all(&mut *conn)
            .await?;
            let candidates = rows
                .into_iter()
                .map(catalog_model_from_row)
                .collect::<Result<Vec<_>>>()?;
            (candidates, None)
        }
    };

    Ok(
        resolve_supplier_pricing(identity, config.as_ref(), &candidates, manual_entry, now_ms)
            .snapshot,
    )
}

async fn read_sync_meta(pool: &sqlx::SqlitePool) -> Result<StoredSyncMeta> {
    let raw: Option<String> =
        sqlx::query_scalar("SELECT value_json FROM service_settings WHERE setting_key = ?")
            .bind(PRICING_SYNC_SETTING_KEY)
            .fetch_optional(pool)
            .await?;
    Ok(raw
        .map(|text| serde_json::from_str::<StoredSyncMeta>(&text))
        .transpose()?
        .unwrap_or_default())
}

async fn read_sync_meta_conn(conn: &mut SqliteConnection) -> Result<StoredSyncMeta> {
    let raw: Option<String> =
        sqlx::query_scalar("SELECT value_json FROM service_settings WHERE setting_key = ?")
            .bind(PRICING_SYNC_SETTING_KEY)
            .fetch_optional(&mut *conn)
            .await?;
    Ok(raw
        .map(|text| serde_json::from_str::<StoredSyncMeta>(&text))
        .transpose()?
        .unwrap_or_default())
}

async fn write_sync_meta_conn(
    conn: &mut SqliteConnection,
    meta: &StoredSyncMeta,
    updated_at_ms: i64,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO service_settings(setting_key, value_json, updated_at_ms)
         VALUES (?, ?, ?)
         ON CONFLICT(setting_key) DO UPDATE SET
            value_json = excluded.value_json,
            updated_at_ms = excluded.updated_at_ms",
    )
    .bind(PRICING_SYNC_SETTING_KEY)
    .bind(serde_json::to_string(meta)?)
    .bind(updated_at_ms)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

async fn load_all_pricing_configs(
    pool: &sqlx::SqlitePool,
) -> Result<HashMap<String, ModelPricingConfig>> {
    let rows = sqlx::query(
        "SELECT
            supplier_key, source_kind, endpoint_key, model_id, binding_mode,
            catalog_provider_id, catalog_model_id,
            custom_input_per_million, custom_output_per_million,
            custom_cache_read_per_million, custom_cache_write_per_million,
            updated_at_ms
         FROM model_pricing_configs",
    )
    .fetch_all(pool)
    .await?;
    let mut configs = HashMap::new();
    for row in rows {
        let cfg = config_from_row(row)?;
        configs.insert(cfg.supplier_key.clone(), cfg);
    }
    Ok(configs)
}

async fn load_catalog_by_model_ids(
    pool: &sqlx::SqlitePool,
    model_ids: &BTreeSet<String>,
) -> Result<HashMap<String, Vec<CatalogModel>>> {
    if model_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let json = serde_json::to_string(&model_ids.iter().collect::<Vec<_>>())?;
    let rows = sqlx::query(
        "SELECT
            provider_id, provider_name, provider_api, model_id, model_name,
            input_per_million, output_per_million, cache_read_per_million,
            cache_write_per_million, synced_at_ms
         FROM pricing_catalog_models
         WHERE model_id IN (SELECT value FROM json_each(?))",
    )
    .bind(json)
    .fetch_all(pool)
    .await?;
    let mut grouped: HashMap<String, Vec<CatalogModel>> = HashMap::new();
    for row in rows {
        let item = catalog_model_from_row(row)?;
        grouped.entry(item.model_id.clone()).or_default().push(item);
    }
    Ok(grouped)
}

async fn load_catalog_entries_by_refs(
    pool: &sqlx::SqlitePool,
    refs: &BTreeSet<(String, String)>,
) -> Result<HashMap<(String, String), CatalogModel>> {
    let mut entries = HashMap::new();
    for (provider_id, model_id) in refs {
        if let Some(row) = sqlx::query(
            "SELECT
                provider_id, provider_name, provider_api, model_id, model_name,
                input_per_million, output_per_million, cache_read_per_million,
                cache_write_per_million, synced_at_ms
             FROM pricing_catalog_models
             WHERE provider_id = ? AND model_id = ?",
        )
        .bind(provider_id)
        .bind(model_id)
        .fetch_optional(pool)
        .await?
        {
            let entry = catalog_model_from_row(row)?;
            entries.insert((entry.provider_id.clone(), entry.model_id.clone()), entry);
        }
    }
    Ok(entries)
}

fn config_from_row(row: sqlx::sqlite::SqliteRow) -> Result<ModelPricingConfig> {
    Ok(ModelPricingConfig {
        supplier_key: row.try_get("supplier_key")?,
        source_kind: SourceKind::parse(row.try_get("source_kind")?)?,
        endpoint_key: row.try_get("endpoint_key")?,
        model_id: row.try_get("model_id")?,
        binding_mode: BindingMode::parse(row.try_get("binding_mode")?)?,
        catalog_provider_id: row.try_get("catalog_provider_id")?,
        catalog_model_id: row.try_get("catalog_model_id")?,
        custom_rates: PricingRates {
            input_per_million: row.try_get("custom_input_per_million")?,
            output_per_million: row.try_get("custom_output_per_million")?,
            cache_read_per_million: row.try_get("custom_cache_read_per_million")?,
            cache_write_per_million: row.try_get("custom_cache_write_per_million")?,
        },
        updated_at_ms: row.try_get("updated_at_ms")?,
    })
}

fn catalog_model_from_row(row: sqlx::sqlite::SqliteRow) -> Result<CatalogModel> {
    Ok(CatalogModel {
        provider_id: row.try_get("provider_id")?,
        provider_name: row.try_get("provider_name")?,
        provider_api: row.try_get("provider_api")?,
        model_id: row.try_get("model_id")?,
        model_name: row.try_get("model_name")?,
        rates: PricingRates {
            input_per_million: row.try_get("input_per_million")?,
            output_per_million: row.try_get("output_per_million")?,
            cache_read_per_million: row.try_get("cache_read_per_million")?,
            cache_write_per_million: row.try_get("cache_write_per_million")?,
        },
        synced_at_ms: row.try_get("synced_at_ms")?,
    })
}

fn to_opt_u64(value: Option<i64>) -> Option<u64> {
    value.and_then(|v| u64::try_from(v).ok())
}

fn escape_like(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '\\' | '%' | '_' => {
                escaped.push('\\');
                escaped.push(ch);
            }
            _ => escaped.push(ch),
        }
    }
    escaped
}

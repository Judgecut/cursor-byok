use std::{collections::BTreeMap, ops::Range};

use sqlx::Row;

use crate::{
    model::{OverviewTrendBucket, OverviewTrendSeries},
    pricing::format_nano_usd,
    Result,
};

use super::{fresh_input_sql, non_negative, Store};

const TOP_GROUPS: i64 = 7;

impl Store {
    pub(super) async fn load_trend_series(
        &self,
        range: Range<i64>,
        bucket_ms: i64,
        supplier_keys_json: Option<&str>,
        suppliers_json: Option<&str>,
        supplier_group_expr: &str,
        group_expr: &str,
    ) -> Result<Vec<OverviewTrendSeries>> {
        let rows = sqlx::query(&format!(
            "WITH buckets AS (
                SELECT {group_expr} AS group_id,
                       (created_at_ms / {bucket_ms}) * {bucket_ms} AS bucket_start_ms,
                       SUM({fresh_input} + COALESCE(cache_read_tokens, 0) + COALESCE(cache_write_tokens, 0) + COALESCE(output_tokens, 0)) AS token_usage,
                       SUM(CASE WHEN cost_status = 'priced' THEN COALESCE(total_cost_nano, 0) ELSE 0 END) AS total_cost_nano
                FROM llm_calls
                WHERE status != 'running'
                  AND created_at_ms >= ?
                  AND created_at_ms < ?
                  AND (? IS NULL OR supplier_key IN (SELECT value FROM json_each(?)))
                  AND (? IS NULL OR {supplier_group_expr} IN (SELECT value FROM json_each(?)))
                GROUP BY group_id, bucket_start_ms
            ), totals AS (
                SELECT group_id, SUM(token_usage) AS tokens, SUM(total_cost_nano) AS cost
                FROM buckets
                GROUP BY group_id
            ), ranks AS (
                SELECT group_id,
                       CASE WHEN tokens > 0 THEN ROW_NUMBER() OVER (ORDER BY tokens DESC, cost DESC, group_id) END AS token_rank,
                       CASE WHEN cost > 0 THEN ROW_NUMBER() OVER (ORDER BY cost DESC, tokens DESC, group_id) END AS cost_rank
                FROM totals
            )
            SELECT buckets.*,
                   CASE WHEN ranks.token_rank <= {TOP_GROUPS} THEN ranks.token_rank END AS token_rank,
                   CASE WHEN ranks.cost_rank <= {TOP_GROUPS} THEN ranks.cost_rank END AS cost_rank
            FROM buckets JOIN ranks USING (group_id)
            WHERE (ranks.token_rank <= {TOP_GROUPS} OR ranks.cost_rank <= {TOP_GROUPS})
              AND (buckets.token_usage > 0 OR buckets.total_cost_nano > 0)
            ORDER BY buckets.group_id, buckets.bucket_start_ms",
            fresh_input = fresh_input_sql(),
        ))
        .bind(range.start)
        .bind(range.end)
        .bind(supplier_keys_json)
        .bind(supplier_keys_json)
        .bind(suppliers_json)
        .bind(suppliers_json)
        .fetch_all(&self.pool)
        .await?;

        let mut groups = BTreeMap::new();
        for row in rows {
            let id: String = row.try_get("group_id")?;
            let token_rank = row.try_get("token_rank")?;
            let cost_rank = row.try_get("cost_rank")?;
            groups
                .entry(id.clone())
                .or_insert_with(|| OverviewTrendSeries {
                    label: id.clone(),
                    id,
                    token_rank,
                    cost_rank,
                    buckets: Vec::new(),
                })
                .buckets
                .push(OverviewTrendBucket {
                    bucket_start_ms: row.try_get("bucket_start_ms")?,
                    token_usage: non_negative(row.try_get("token_usage")?),
                    total_cost: format_nano_usd(non_negative(row.try_get("total_cost_nano")?)),
                });
        }
        Ok(groups.into_values().collect())
    }
}

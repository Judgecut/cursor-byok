use serde::{Deserialize, Serialize};

use crate::{pricing::format_nano_usd, Error, Result};

use super::Store;

#[derive(Clone, Copy, Debug, Deserialize)]
pub struct CostQuotaRange
{
    pub week_start_ms: i64,
    pub month_start_ms: i64,
    pub year_start_ms: i64,
    pub end_ms: i64,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct CostQuotaUsage
{
    pub week: String,
    pub month: String,
    pub year: String,
}

impl Store
{
    pub async fn cost_quota_usage(&self, range: CostQuotaRange) -> Result<CostQuotaUsage>
    {
        let CostQuotaRange { week_start_ms, month_start_ms, year_start_ms, end_ms } = range;
        if week_start_ms.max(month_start_ms).max(year_start_ms) > end_ms
        {
            return Err(Error::Config("quota period start must be at or before end_ms".into()));
        }

        let (week, month, year) = sqlx::query_as::<_, (i64, i64, i64)>(
            "SELECT
                COALESCE(SUM(CASE WHEN created_at_ms >= ? AND cost_status = 'priced' THEN total_cost_nano END), 0),
                COALESCE(SUM(CASE WHEN created_at_ms >= ? AND cost_status = 'priced' THEN total_cost_nano END), 0),
                COALESCE(SUM(CASE WHEN created_at_ms >= ? AND cost_status = 'priced' THEN total_cost_nano END), 0)
             FROM llm_calls
             WHERE created_at_ms >= ? AND created_at_ms < ?
               AND status != 'running'",
        )
        .bind(week_start_ms)
        .bind(month_start_ms)
        .bind(year_start_ms)
        .bind(week_start_ms.min(month_start_ms).min(year_start_ms))
        .bind(end_ms)
        .fetch_one(&self.pool)
        .await?;

        Ok(CostQuotaUsage { week: format_nano_usd(week.max(0)), month: format_nano_usd(month.max(0)), year: format_nano_usd(year.max(0)) })
    }
}

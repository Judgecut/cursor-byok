//! Implements control dashboard overview endpoints.
//! HTTP handler for the desktop overview aggregates.

use axum::{
    extract::{Query, State},
    Json,
};
use serde::Deserialize;

use crate::{model::Overview, Result};

use super::ControlService;

#[derive(Debug, Default, Deserialize)]
pub struct OverviewRange {
    start_ms: Option<i64>,
    end_ms: Option<i64>,
    supplier_keys: Option<String>,
    suppliers: Option<String>,
    bucket_ms: Option<i64>,
}

pub async fn get(
    State(service): State<ControlService>,
    Query(range): Query<OverviewRange>,
) -> Result<Json<Overview>> {
    Ok(Json(
        service
            .overview(
                range.start_ms,
                range.end_ms,
                range.supplier_keys.as_deref(),
                range.suppliers.as_deref(),
                range.bucket_ms,
            )
            .await?,
    ))
}

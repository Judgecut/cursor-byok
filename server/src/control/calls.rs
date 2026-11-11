//! Implements provider call inspection endpoints.
use axum::{
    extract::{Path, Query, State},
    Json,
};
use serde::Deserialize;

use crate::{store::LlmCallFilter, Result};

use super::{CallDetail, CallListResult, ControlService};

#[derive(Debug, Default, Deserialize)]
pub struct CallQuery {
    start_ms: Option<i64>,
    end_ms: Option<i64>,
    suppliers: Option<String>,
    supplier_keys: Option<String>,
    #[serde(default = "default_limit")]
    limit: i64,
    #[serde(default)]
    offset: i64,
}

pub async fn list(
    State(service): State<ControlService>,
    Query(query): Query<CallQuery>,
) -> Result<Json<CallListResult>> {
    let filter = LlmCallFilter {
        start_ms: query.start_ms,
        end_ms: query.end_ms,
        suppliers: query.suppliers.as_deref(),
        supplier_keys: query.supplier_keys.as_deref(),
        limit: query.limit,
        offset: query.offset,
    };
    Ok(Json(service.calls(&filter).await?))
}

pub async fn detail(
    State(service): State<ControlService>,
    Path(call_id): Path<String>,
) -> Result<Json<CallDetail>> {
    Ok(Json(service.call(&call_id).await?))
}

fn default_limit() -> i64 {
    100
}

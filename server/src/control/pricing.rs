//! Implements control API handlers for model pricing catalog, supplier bindings, and sync.
use axum::{
    extract::{Query, State},
    Json,
};
use serde::Deserialize;

use crate::{
    pricing::PricingSyncState,
    store::{CatalogSearchResult, SaveSupplierPricingInput, SupplierPricingView},
    Result,
};

use super::ControlService;

#[derive(Debug, Default, Deserialize)]
pub struct CatalogQuery {
    query: Option<String>,
    provider_id: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateSyncSettingsInput {
    pub auto_sync_enabled: bool,
}

pub async fn get_catalog(
    State(service): State<ControlService>,
    Query(query): Query<CatalogQuery>,
) -> Result<Json<CatalogSearchResult>> {
    Ok(Json(
        service
            .pricing_catalog(
                query.query.as_deref(),
                query.provider_id.as_deref(),
                query.limit,
                query.offset,
            )
            .await?,
    ))
}

pub async fn list_models(
    State(service): State<ControlService>,
) -> Result<Json<Vec<SupplierPricingView>>> {
    Ok(Json(service.pricing_models().await?))
}

pub async fn update_model(
    State(service): State<ControlService>,
    Json(input): Json<SaveSupplierPricingInput>,
) -> Result<Json<SupplierPricingView>> {
    Ok(Json(service.save_pricing_model(&input).await?))
}

pub async fn sync_status(State(service): State<ControlService>) -> Result<Json<PricingSyncState>> {
    Ok(Json(service.pricing_sync_status().await?))
}

pub async fn update_sync(
    State(service): State<ControlService>,
    Json(input): Json<UpdateSyncSettingsInput>,
) -> Result<Json<PricingSyncState>> {
    Ok(Json(
        service
            .set_pricing_auto_sync(input.auto_sync_enabled)
            .await?,
    ))
}

pub async fn trigger_sync(State(service): State<ControlService>) -> Result<Json<PricingSyncState>> {
    Ok(Json(service.sync_pricing_now().await?))
}

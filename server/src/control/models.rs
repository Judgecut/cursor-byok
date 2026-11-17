//! Implements provider and model configuration endpoints.
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::Deserialize;

use crate::{
    model::{ModelConfig, ModelConfigInput, ProviderConfig, ProviderConfigInput},
    Result,
};

use super::{
    ControlService, DiscoveredModels, LegacyModelImportPreview, LegacyModelImportResult,
    ModelConnectivityResult,
};

#[derive(Deserialize)]
pub struct SaveModels {
    pub models: Vec<ModelConfigInput>,
}

#[derive(Deserialize)]
pub struct ProviderOrder {
    pub provider_ids: Vec<String>,
}

#[derive(Deserialize)]
pub struct ModelOrder {
    pub model_hashes: Vec<String>,
}

pub async fn list_providers(
    State(service): State<ControlService>,
) -> Result<Json<Vec<ProviderConfig>>> {
    Ok(Json(service.providers().await?))
}

pub async fn reorder_providers(
    State(service): State<ControlService>,
    Json(input): Json<ProviderOrder>,
) -> Result<Json<Vec<ProviderConfig>>> {
    Ok(Json(service.reorder_providers(&input.provider_ids).await?))
}

pub async fn create_provider(
    State(service): State<ControlService>,
    Json(input): Json<ProviderConfigInput>,
) -> Result<(StatusCode, Json<ProviderConfig>)> {
    Ok((
        StatusCode::CREATED,
        Json(service.create_provider(&input).await?),
    ))
}

pub async fn update_provider(
    State(service): State<ControlService>,
    Path(provider_id): Path<String>,
    Json(input): Json<ProviderConfigInput>,
) -> Result<Json<ProviderConfig>> {
    Ok(Json(service.update_provider(&provider_id, &input).await?))
}

pub async fn remove_provider(
    State(service): State<ControlService>,
    Path(provider_id): Path<String>,
) -> Result<StatusCode> {
    service.delete_provider(&provider_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn discover_provider_models(
    State(service): State<ControlService>,
    Path(provider_id): Path<String>,
) -> Result<Json<DiscoveredModels>> {
    Ok(Json(service.discover_provider_models(&provider_id).await?))
}

pub async fn list(State(service): State<ControlService>) -> Result<Json<Vec<ModelConfig>>> {
    Ok(Json(service.models().await?))
}

pub async fn create(
    State(service): State<ControlService>,
    Json(input): Json<SaveModels>,
) -> Result<(StatusCode, Json<Vec<ModelConfig>>)> {
    Ok((
        StatusCode::CREATED,
        Json(service.create_models(&input.models).await?),
    ))
}

pub async fn reorder(
    State(service): State<ControlService>,
    Path(provider_id): Path<String>,
    Json(input): Json<ModelOrder>,
) -> Result<Json<Vec<ModelConfig>>> {
    Ok(Json(
        service
            .reorder_models(&provider_id, &input.model_hashes)
            .await?,
    ))
}

pub async fn remove(
    State(service): State<ControlService>,
    Path(model_hash): Path<String>,
) -> Result<StatusCode> {
    service.delete_model(&model_hash).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn update(
    State(service): State<ControlService>,
    Path(model_hash): Path<String>,
    Json(input): Json<ModelConfigInput>,
) -> Result<Json<ModelConfig>> {
    Ok(Json(service.update_model(&model_hash, &input).await?))
}

pub async fn test(
    State(service): State<ControlService>,
    Path((model_hash, test_id)): Path<(String, String)>,
) -> Result<Json<ModelConnectivityResult>> {
    Ok(Json(service.test_model(&model_hash, &test_id).await?))
}

pub async fn cancel(
    State(service): State<ControlService>,
    Path((_model_hash, test_id)): Path<(String, String)>,
) -> Result<StatusCode> {
    service.cancel_model_test(&test_id);
    Ok(StatusCode::NO_CONTENT)
}

pub async fn import_v0049(
    State(service): State<ControlService>,
) -> Result<Json<LegacyModelImportResult>> {
    Ok(Json(service.import_v0049_models().await?))
}

pub async fn preview_v0049(
    State(service): State<ControlService>,
) -> Result<Json<LegacyModelImportPreview>> {
    Ok(Json(service.preview_v0049_models().await?))
}

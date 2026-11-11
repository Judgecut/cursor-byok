#[path = "support/fake_provider.rs"]
mod fake_provider;
#[path = "support/fixtures.rs"]
mod fixtures;

use std::sync::Arc;

use axum::{
    body::{to_bytes, Body},
    http::{header, Request, StatusCode},
};
use cursor_server::{
    control,
    network::NetworkClients,
    plugin::{PluginRegistry, PluginRuntime},
    store::Store,
};
use serde_json::{json, Value};
use tower::ServiceExt;

async fn setup_router(store: Store) -> (axum::Router, PluginRuntime) {
    let runtime = PluginRuntime::managed().unwrap();
    let plugins = PluginRegistry::managed(store.clone(), runtime.clone(), "0.1.0".into()).unwrap();
    let shared_provider = Arc::new(fake_provider::FakeProvider::default());
    let control = control::ControlService::new(
        store.clone(),
        shared_provider,
        runtime.clone(),
        plugins,
        NetworkClients::new(store),
        "0.1.0".into(),
    )
    .unwrap();
    (control::api_router(control), runtime)
}

async fn send(
    router: axum::Router,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut request = Request::builder().method(method).uri(path);
    let body = match body {
        Some(value) => {
            request = request.header(header::CONTENT_TYPE, "application/json");
            Body::from(value.to_string())
        }
        None => Body::empty(),
    };
    let response = router.oneshot(request.body(body).unwrap()).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    let parsed = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, parsed)
}

#[tokio::test]
async fn interface_settings_round_trip_and_survive_store_restart() {
    let directory = tempfile::tempdir().unwrap();
    let url = format!("sqlite://{}", directory.path().join("test.db").display());
    let store = Store::connect(&url).await.unwrap();
    let (router, _runtime) = setup_router(store).await;

    let (status, initial) = send(
        router.clone(),
        "GET",
        "/__byok-api__/api/settings/interface",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        initial,
        json!({
            "locale": "system",
            "theme": "default-dark",
            "currency": "USD",
            "cny_rate": null,
            "overview_chart_mode": "tokens",
            "overview_chart_type": "bar",
            "home_refresh_interval_seconds": 30
        })
    );

    // Rejects switching to CNY without an exchange rate.
    let (status, _) = send(
        router.clone(),
        "PUT",
        "/__byok-api__/api/settings/interface",
        Some(json!({ "currency": "CNY" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Rejects invalid rate and zero interval.
    let (status, _) = send(
        router.clone(),
        "PUT",
        "/__byok-api__/api/settings/interface",
        Some(json!({ "cny_rate": "0" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (status, _) = send(
        router.clone(),
        "PUT",
        "/__byok-api__/api/settings/interface",
        Some(json!({ "home_refresh_interval_seconds": 0 })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Saves theme and rate, then switches currency & chart preferences in separate patches.
    let (status, updated) = send(
        router.clone(),
        "PUT",
        "/__byok-api__/api/settings/interface",
        Some(json!({ "theme": "default-light", "cny_rate": "07.20" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(updated["theme"], "default-light");
    assert_eq!(updated["cny_rate"], "7.2");

    let (status, updated) = send(
        router.clone(),
        "PUT",
        "/__byok-api__/api/settings/interface",
        Some(json!({
            "locale": "en-US",
            "currency": "CNY",
            "overview_chart_mode": "cost",
            "overview_chart_type": "line",
            "home_refresh_interval_seconds": 45
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        updated,
        json!({
            "locale": "en-US",
            "theme": "default-light",
            "currency": "CNY",
            "cny_rate": "7.2",
            "overview_chart_mode": "cost",
            "overview_chart_type": "line",
            "home_refresh_interval_seconds": 45
        })
    );

    // Simulates reopening the application with a fresh SQLite connection and router.
    let reopened = Store::connect(&url).await.unwrap();
    let (reopened_router, _reopened_runtime) = setup_router(reopened).await;
    let (status, loaded) = send(
        reopened_router.clone(),
        "GET",
        "/__byok-api__/api/settings/interface",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(loaded, updated);

    // Clearing the exchange rate resets currency back to USD while preserving other preferences.
    let (status, cleared) = send(
        reopened_router,
        "PUT",
        "/__byok-api__/api/settings/interface",
        Some(json!({ "cny_rate": null })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        cleared,
        json!({
            "locale": "en-US",
            "theme": "default-light",
            "currency": "USD",
            "cny_rate": null,
            "overview_chart_mode": "cost",
            "overview_chart_type": "line",
            "home_refresh_interval_seconds": 45
        })
    );
}

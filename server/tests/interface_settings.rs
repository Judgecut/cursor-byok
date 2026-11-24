#[path = "support/fake_provider.rs"]
mod fake_provider;
#[path = "support/fixtures.rs"]
mod fixtures;

use std::sync::Arc;

use axum::{
    body::{to_bytes, Body},
    http::{header, Request, StatusCode},
};
use base64::{engine::general_purpose::STANDARD, Engine};
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
async fn provider_icons_round_trip_through_management_api() {
    let directory = tempfile::tempdir().unwrap();
    let url = format!("sqlite://{}", directory.path().join("test.db").display());
    let store = Store::connect(&url).await.unwrap();
    let (router, _runtime) = setup_router(store).await;
    let providers = "/__byok-api__/api/providers";
    let mut input = json!({ "name": "Provider", "base_url": "https://api.deepseek.com", "api_key": "test-key", "icon": "openai" });
    let (status, created) = send(router.clone(), "POST", providers, Some(input.clone())).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(created["icon"], "openai");
    let provider = format!("{providers}/{}", created["provider_id"].as_str().unwrap());

    let mut png = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgba8(96, 96)
        .write_to(&mut png, image::ImageFormat::Png)
        .unwrap();
    let custom_icon = format!("data:image/png;base64,{}", STANDARD.encode(png.get_ref()));
    input["icon"] = json!(custom_icon);
    let (status, updated) = send(router.clone(), "PUT", &provider, Some(input.clone())).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(updated["icon"], custom_icon);

    let mut oversized = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgba8(97, 96)
        .write_to(&mut oversized, image::ImageFormat::Png)
        .unwrap();
    let png_bytes = png.get_ref();
    let without_iend_crc = &png_bytes[..png_bytes.len() - 4];
    let mut invalid_crc = png_bytes.clone();
    *invalid_crc.last_mut().unwrap() ^= 1;
    for invalid_icon in [
        "https://example.com/logo.png".to_owned(),
        "file:///logo.png".to_owned(),
        "data:image/svg+xml;base64,AAAA".to_owned(),
        format!(
            "data:image/png;base64,{}",
            STANDARD.encode(&png_bytes[..33])
        ),
        format!(
            "data:image/png;base64,{}",
            STANDARD.encode(without_iend_crc)
        ),
        format!("data:image/png;base64,{}", STANDARD.encode(invalid_crc)),
        format!(
            "data:image/png;base64,{}",
            STANDARD.encode(oversized.get_ref())
        ),
        format!("data:image/png;base64,{}", "AAAA".repeat(23_000)),
    ] {
        input["icon"] = json!(invalid_icon);
        let (status, _) = send(router.clone(), "PUT", &provider, Some(input.clone())).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    drop(router);
    let reopened = Store::connect(&url).await.unwrap();
    let (router, _runtime) = setup_router(reopened).await;
    let (status, listed) = send(router.clone(), "GET", providers, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(listed[0]["icon"], custom_icon);

    input["icon"] = Value::Null;
    let (status, reset) = send(router, "PUT", &provider, Some(input)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(reset["icon"], Value::Null);
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
            "eur_rate": null,
            "jpy_rate": null,
            "twd_rate": null,
            "try_rate": null,
            "krw_rate": null,
            "overview_range_preset": "month",
            "overview_chart_mode": "tokens",
            "overview_chart_type": "bar",
            "overview_calendar_window": "year",
            "overview_calendar_chart_type": "heatmap",
            "sidebar_collapsed": false,
            "home_motion_mode": "system",
            "home_auto_refresh_enabled": true,
            "home_refresh_interval_seconds": 30,
            "calls_refresh_interval_seconds": 5
        })
    );

    // Allows switching to CNY without configuring a custom exchange rate (default rate is used).
    let (status, cny_default) = send(
        router.clone(),
        "PUT",
        "/__byok-api__/api/settings/interface",
        Some(json!({ "currency": "CNY" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(cny_default["currency"], "CNY");
    assert_eq!(cny_default["cny_rate"], Value::Null);

    // Rejects invalid rate and zero interval.
    let (status, _) = send(
        router.clone(),
        "PUT",
        "/__byok-api__/api/settings/interface",
        Some(json!({ "cny_rate": "0", "eur_rate": "0.93" })),
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

    for interval in [4, 61] {
        let (status, _) = send(
            router.clone(),
            "PUT",
            "/__byok-api__/api/settings/interface",
            Some(json!({ "calls_refresh_interval_seconds": interval })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    // Saves theme and rate, then switches currency & chart preferences in separate patches.
    let (status, updated) = send(
        router.clone(),
        "PUT",
        "/__byok-api__/api/settings/interface",
        Some(json!({ "theme": "default-light", "cny_rate": "07.20", "jpy_rate": "0150.00" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(updated["theme"], "default-light");
    assert_eq!(updated["cny_rate"], "7.2");
    assert_eq!(updated["eur_rate"], Value::Null);
    assert_eq!(updated["jpy_rate"], "150");

    let (status, updated) = send(
        router.clone(),
        "PUT",
        "/__byok-api__/api/settings/interface",
        Some(json!({
            "locale": "en-US",
            "currency": "JPY",
            "overview_range_preset": "week",
            "overview_chart_mode": "cost",
            "overview_chart_type": "line",
            "overview_calendar_window": "month",
            "overview_calendar_chart_type": "bar",
            "sidebar_collapsed": true,
            "home_motion_mode": "off",
            "home_auto_refresh_enabled": false,
            "home_refresh_interval_seconds": 45,
            "calls_refresh_interval_seconds": 60
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        updated,
        json!({
            "locale": "en-US",
            "theme": "default-light",
            "currency": "JPY",
            "cny_rate": "7.2",
            "eur_rate": null,
            "jpy_rate": "150",
            "twd_rate": null,
            "try_rate": null,
            "krw_rate": null,
            "overview_range_preset": "week",
            "overview_chart_mode": "cost",
            "overview_chart_type": "line",
            "overview_calendar_window": "month",
            "overview_calendar_chart_type": "bar",
            "sidebar_collapsed": true,
            "home_motion_mode": "off",
            "home_auto_refresh_enabled": false,
            "home_refresh_interval_seconds": 45,
            "calls_refresh_interval_seconds": 60
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

    // Clearing CNY preserves the selected currency and its independent rate.
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
            "currency": "JPY",
            "cny_rate": null,
            "eur_rate": null,
            "jpy_rate": "150",
            "twd_rate": null,
            "try_rate": null,
            "krw_rate": null,
            "overview_range_preset": "week",
            "overview_chart_mode": "cost",
            "overview_chart_type": "line",
            "overview_calendar_window": "month",
            "overview_calendar_chart_type": "bar",
            "sidebar_collapsed": true,
            "home_motion_mode": "off",
            "home_auto_refresh_enabled": false,
            "home_refresh_interval_seconds": 45,
            "calls_refresh_interval_seconds": 60
        })
    );
}

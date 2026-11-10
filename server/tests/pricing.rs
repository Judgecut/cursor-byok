#[path = "support/fake_provider.rs"]
mod fake_provider;
#[path = "support/fixtures.rs"]
mod fixtures;

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use axum::{
    body::{to_bytes, Body},
    http::{header, Request, StatusCode},
    routing::get,
    Json, Router,
};
use cursor_server::{
    api::byok,
    control,
    model::{
        ModelConfigInput, ModelType, NewLlmCall, ProviderType, Usage, OPENAI_CHAT_ENDPOINT,
        OPENAI_RESPONSES_ENDPOINT,
    },
    network::NetworkClients,
    plugin::{PluginRegistry, PluginRuntime},
    pricing::{canonical_supplier_identity, BindingMode, PricingRates, PricingService, SourceKind},
    provider::ProviderRouter,
    store::{ExternalApiSettings, SaveSupplierPricingInput},
};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tower::ServiceExt;

fn model_input(
    display_name: &str,
    group_name: Option<&str>,
    model_type: ModelType,
    base_url: &str,
    api_key: &str,
    model_id: &str,
    endpoint: &str,
) -> ModelConfigInput {
    ModelConfigInput {
        sort_order: 0,
        display_name: display_name.into(),
        group_name: group_name.map(str::to_owned),
        model_type,
        base_url: base_url.into(),
        use_full_url: false,
        api_key: api_key.into(),
        tooltip_data: display_name.into(),
        model_id: model_id.into(),
        reasoning_effort: None,
        openai_endpoint: endpoint.into(),
        openai_extra_params_enabled: false,
        openai_extra_params: json!({}),
        custom_headers_enabled: false,
        custom_headers: json!({}),
        anthropic_extra_params_enabled: false,
        anthropic_extra_params: json!({}),
        context_window_tokens: None,
        max_completion_tokens: None,
        anthropic_max_tokens: None,
        anthropic_thinking_effort: None,
        thinking_budget_tokens: None,
    }
}

async fn send(
    router: Router,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(path);
    let request = match body {
        Some(json) => {
            builder = builder.header(header::CONTENT_TYPE, "application/json");
            builder.body(Body::from(json.to_string())).unwrap()
        }
        None => builder.body(Body::empty()).unwrap(),
    };
    let response = router.oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 4 * 1024 * 1024)
        .await
        .unwrap();
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned()))
    };
    (status, value)
}

async fn setup_control_with_catalog(
    catalog_url: &str,
) -> (
    Router,
    cursor_server::store::Store,
    PricingService,
    tempfile::TempDir,
) {
    let (directory, store) = fixtures::temp_store().await;
    let runtime = PluginRuntime::managed().unwrap();
    let plugins = PluginRegistry::managed(store.clone(), runtime.clone(), "0.1.0".into()).unwrap();
    let clients = NetworkClients::new(store.clone());
    let pricing = PricingService::with_catalog_url(store.clone(), clients.clone(), catalog_url);
    let provider = Arc::new(fake_provider::FakeProvider::default());
    let control = control::ControlService::new(
        store.clone(),
        provider,
        runtime,
        plugins,
        clients,
        "0.1.0".into(),
    )
    .unwrap()
    .with_pricing_service(pricing.clone());
    (control::api_router(control), store, pricing, directory)
}

fn sample_models_dev_json() -> Value {
    json!({
        "openai": {
            "id": "openai",
            "name": "OpenAI",
            "api": "https://api.openai.com/v1",
            "models": {
                "gpt-4o": {
                    "id": "gpt-4o",
                    "name": "GPT-4o",
                    "cost": { "input": 2.5, "output": 10, "cache_read": 1.25, "cache_write": 0 }
                }
            }
        },
        "openrouter": {
            "id": "openrouter",
            "name": "OpenRouter",
            "api": "https://openrouter.ai/api/v1",
            "models": {
                "gpt-4o": {
                    "id": "gpt-4o",
                    "name": "GPT-4o (OpenRouter)",
                    "cost": { "input": 2.8, "output": 11.2, "cache_read": 1.4, "cache_write": 0 }
                }
            }
        },
        "vendor": {
            "id": "vendor",
            "name": "Vendor",
            "models": {
                "unique-model-v1": {
                    "id": "unique-model-v1",
                    "name": "Unique Model",
                    "cost": { "input": 1.2, "output": 4.8 }
                }
            }
        }
    })
}

#[tokio::test]
async fn same_model_across_suppliers_aggregates_cleanly_and_shares_identity_across_key_rename() {
    let (_directory, store) = fixtures::temp_store().await;
    store
        .replace_pricing_catalog_from_json(sample_models_dev_json().to_string().as_bytes(), 1_000)
        .await
        .unwrap();

    let openai_model = store
        .create_model(&model_input(
            "OpenAI Main",
            Some("official"),
            ModelType::OpenAi,
            "https://api.openai.com/v1",
            "sk-key-1",
            "gpt-4o",
            OPENAI_RESPONSES_ENDPOINT,
        ))
        .await
        .unwrap();
    let openrouter_model = store
        .create_model(&model_input(
            "OpenRouter Pool",
            Some("relay"),
            ModelType::OpenAi,
            "https://openrouter.ai/api/v1",
            "sk-or-1",
            "gpt-4o",
            OPENAI_CHAT_ENDPOINT,
        ))
        .await
        .unwrap();

    let openai_url = openai_model.request_url().unwrap();
    let or_url = openrouter_model.request_url().unwrap();

    store
        .start_llm_call(&NewLlmCall {
            call_id: "c-openai-1".into(),
            run_id: "r1".into(),
            conversation_id: "conv1".into(),
            provider_call_index: 0,
            model_hash: openai_model.model_hash.clone(),
            provider_type: ProviderType::OpenAiResponses,
            provider_url: openai_url.clone(),
            request_type: ProviderType::OpenAiResponses,
            request_url: openai_url.clone(),
            model_id: "gpt-4o".into(),
            display_name: openai_model.display_name.clone(),
            reasoning_effort: None,
            fast: false,
            message_count: 1,
            tool_count: 0,
            detailed: false,
        })
        .await
        .unwrap();
    store
        .record_llm_usage(
            "c-openai-1",
            Usage {
                input_tokens: Some(1_000_000),
                output_tokens: Some(500_000),
                cache_read_tokens: Some(500_000),
                cache_write_tokens: Some(0),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    store
        .finish_llm_call("c-openai-1", "completed", Some("stop"), 100, None, None)
        .await
        .unwrap();

    // Update API key, display name, and group name; identity must stay identical!
    let mut edited = model_input(
        "OpenAI Renamed",
        Some("renamed-group"),
        ModelType::OpenAi,
        "https://api.openai.com/v1",
        "sk-key-2",
        "gpt-4o",
        OPENAI_RESPONSES_ENDPOINT,
    );
    edited.sort_order = openai_model.sort_order;
    let openai_updated = store
        .update_model(&openai_model.model_hash, &edited)
        .await
        .unwrap();
    assert_ne!(openai_model.model_hash, openai_updated.model_hash);

    store
        .start_llm_call(&NewLlmCall {
            call_id: "c-openai-2".into(),
            run_id: "r2".into(),
            conversation_id: "conv1".into(),
            provider_call_index: 1,
            model_hash: openai_updated.model_hash.clone(),
            provider_type: ProviderType::OpenAiResponses,
            provider_url: openai_url.clone(),
            request_type: ProviderType::OpenAiResponses,
            request_url: openai_url.clone(),
            model_id: "gpt-4o".into(),
            display_name: openai_updated.display_name.clone(),
            reasoning_effort: None,
            fast: false,
            message_count: 1,
            tool_count: 0,
            detailed: false,
        })
        .await
        .unwrap();
    store
        .record_llm_usage(
            "c-openai-2",
            Usage {
                input_tokens: Some(500_000),
                output_tokens: Some(100_000),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    store
        .finish_llm_call("c-openai-2", "completed", Some("stop"), 80, None, None)
        .await
        .unwrap();

    // Second supplier (OpenRouter) for the same model_id:
    store
        .start_llm_call(&NewLlmCall {
            call_id: "c-or-1".into(),
            run_id: "r3".into(),
            conversation_id: "conv2".into(),
            provider_call_index: 0,
            model_hash: openrouter_model.model_hash.clone(),
            provider_type: ProviderType::OpenAiChat,
            provider_url: or_url.clone(),
            request_type: ProviderType::OpenAiChat,
            request_url: or_url.clone(),
            model_id: "gpt-4o".into(),
            display_name: openrouter_model.display_name.clone(),
            reasoning_effort: None,
            fast: false,
            message_count: 1,
            tool_count: 0,
            detailed: false,
        })
        .await
        .unwrap();
    store
        .record_llm_usage(
            "c-or-1",
            Usage {
                input_tokens: Some(1_000_000),
                output_tokens: Some(0),
                cache_read_tokens: Some(0),
                cache_write_tokens: Some(0),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    store
        .finish_llm_call("c-or-1", "completed", Some("stop"), 90, None, None)
        .await
        .unwrap();

    // Delete OpenAI model config: historical calls and overview attribution must remain!
    store
        .delete_model(&openai_updated.model_hash)
        .await
        .unwrap();

    let overview = store.overview(None, None, None, None).await.unwrap();
    assert_eq!(overview.models.len(), 1);
    let gpt4o = &overview.models[0];
    assert_eq!(gpt4o.model_id, "gpt-4o");
    assert_eq!(gpt4o.providers.len(), 2);
    assert_eq!(gpt4o.llm_calls, 3);
    assert_eq!(gpt4o.priced_calls, 3);
    // OpenAI c1: 500k*2.5/M + 500k*10/M + 500k*1.25/M = 1.25 + 5.0 + 0.625 = 6.875
    // OpenAI c2: 500k*2.5/M + 100k*10/M = 1.25 + 1.0 = 2.25  => OpenAI total = 9.125
    // OpenRouter c1: 1M*2.8/M = 2.8 => Model total = 11.925
    assert_eq!(gpt4o.total_cost, "11.925");
    assert_eq!(overview.metrics.total_cost, "11.925");
    assert_eq!(gpt4o.average_priced_cost.as_deref(), Some("3.975"));

    let openai_summary = gpt4o
        .providers
        .iter()
        .find(|p| p.endpoint_key == "https://api.openai.com/v1/responses")
        .unwrap();
    assert!(!openai_summary.active);
    assert_eq!(openai_summary.llm_calls, 2);
    assert_eq!(openai_summary.total_cost, "9.125");

    let or_summary = gpt4o
        .providers
        .iter()
        .find(|p| p.endpoint_key == "https://openrouter.ai/api/v1/chat/completions")
        .unwrap();
    assert!(or_summary.active);
    assert_eq!(or_summary.llm_calls, 1);
    assert_eq!(or_summary.total_cost, "2.8");

    // Deleted supplier stays available in overview.available_models for filtering!
    assert!(overview
        .available_models
        .iter()
        .any(|m| m.supplier_key == openai_summary.supplier_key && !m.active));
}

#[tokio::test]
async fn protocol_billing_and_native_external_api_forwarding_agree() {
    let (_dir, store) = fixtures::temp_store().await;
    store
        .set_external_api_settings(ExternalApiSettings {
            enabled: true,
            api_key: "ext-secret".into(),
        })
        .await
        .unwrap();

    // Local mock upstream HTTP server serving NativeForwarder for OpenAI & Anthropic protocols.
    let upstream = Router::new().route(
        "/{*path}",
        axum::routing::post(|uri: axum::http::Uri| async move {
            let p = uri.path();
            if p.ends_with("/messages") {
                Json(json!({
                    "id": "msg_1",
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "text", "text": "ok"}],
                    "stop_reason": "end_turn",
                    "usage": {
                        "input_tokens": 100_000,
                        "output_tokens": 50_000,
                        "cache_read_input_tokens": 400_000,
                        "cache_creation_input_tokens": 200_000
                    }
                }))
            } else if p.ends_with("/responses") {
                Json(json!({
                    "id": "resp_1",
                    "output": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "ok"}]}],
                    "usage": {
                        "input_tokens": 1_000_000,
                        "output_tokens": 100_000,
                        "input_tokens_details": { "cached_tokens": 800_000 },
                        "output_tokens_details": { "reasoning_tokens": 40_000 }
                    }
                }))
            } else {
                Json(json!({
                    "id": "chat_1",
                    "choices": [{"index": 0, "message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}],
                    "usage": {
                        "prompt_tokens": 1_000_000,
                        "completion_tokens": 100_000,
                        "prompt_tokens_details": { "cached_tokens": 800_000 },
                        "completion_tokens_details": { "reasoning_tokens": 40_000 }
                    }
                }))
            }
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });

    let chat_model = store
        .create_model(&model_input(
            "Native Chat",
            Some("chat"),
            ModelType::OpenAi,
            &format!("http://127.0.0.1:{port}/v1"),
            "k1",
            "proto-model",
            OPENAI_CHAT_ENDPOINT,
        ))
        .await
        .unwrap();
    let resp_model = store
        .create_model(&model_input(
            "Native Resp",
            Some("resp"),
            ModelType::OpenAi,
            &format!("http://127.0.0.1:{port}/v1"),
            "k2",
            "proto-model",
            OPENAI_RESPONSES_ENDPOINT,
        ))
        .await
        .unwrap();
    let ant_model = store
        .create_model(&model_input(
            "Native Ant",
            Some("ant"),
            ModelType::Anthropic,
            &format!("http://127.0.0.1:{port}"),
            "k3",
            "proto-model",
            "",
        ))
        .await
        .unwrap();

    for model in [&chat_model, &resp_model, &ant_model] {
        let req_url = model.request_url().unwrap();
        let identity = canonical_supplier_identity(
            model.provider_type(),
            &req_url,
            &model.base_url,
            &model.model_id,
        );
        store
            .save_supplier_pricing_config(
                &SaveSupplierPricingInput {
                    source_kind: identity.source_kind,
                    endpoint_key: identity.endpoint_key,
                    model_id: identity.model_id,
                    binding_mode: BindingMode::Auto,
                    catalog_provider_id: None,
                    catalog_model_id: None,
                    custom_rates: PricingRates {
                        input_per_million: Some("2".into()),
                        output_per_million: Some("10".into()),
                        cache_read_per_million: Some("0.5".into()),
                        cache_write_per_million: Some("2.5".into()),
                    },
                },
                &[],
            )
            .await
            .unwrap();
    }

    let runtime = PluginRuntime::managed().unwrap();
    let plugins = PluginRegistry::managed(store.clone(), runtime, "0.1.0".into()).unwrap();
    let router = byok::router(
        store.clone(),
        plugins,
        Arc::new(ProviderRouter::new(
            store.clone(),
            PluginRegistry::managed(
                store.clone(),
                PluginRuntime::managed().unwrap(),
                "0.1.0".into(),
            )
            .unwrap(),
            NetworkClients::new(store.clone()),
            std::time::Duration::from_secs(5),
            std::time::Duration::from_secs(5),
        )),
        Some(byok::NativeForwarder::new(
            store.clone(),
            NetworkClients::new(store.clone()),
            std::time::Duration::from_secs(5),
            std::time::Duration::from_secs(5),
        )),
    );

    for (path, body) in [
        (
            "/byok/v1/chat/completions",
            json!({"model": "chat/proto-model", "messages": [{"role": "user", "content": "hi"}]}),
        ),
        (
            "/byok/v1/responses",
            json!({"model": "resp/proto-model", "input": "hi"}),
        ),
        (
            "/byok/v1/messages",
            json!({"model": "ant/proto-model", "max_tokens": 32, "messages": [{"role": "user", "content": "hi"}]}),
        ),
    ] {
        let req = Request::builder()
            .method("POST")
            .uri(path)
            .header(header::AUTHORIZATION, "Bearer ext-secret")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        let resp = router.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    let calls = store.llm_calls(20).await.unwrap();
    assert_eq!(calls.len(), 3);
    for call in &calls {
        assert_eq!(call.cost_status.as_deref(), Some("priced"));
        match call.request_type.as_str() {
            "openai-chat" | "openai-responses" => {
                // non-cached = 1M - 800k = 200k => $0.4; output = 100k => $1.0 (reasoning not extra); cache_read = 800k => $0.4; total = $1.8
                assert_eq!(call.billed_input_tokens, Some(200_000));
                assert_eq!(call.total_cost.as_deref(), Some("1.8"));
            }
            "anthropic" => {
                // input = 100k => $0.2; output = 50k => $0.5; cache_read = 400k => $0.2; cache_write = 200k => $0.5; total = $1.4
                assert_eq!(call.billed_input_tokens, Some(100_000));
                assert_eq!(call.total_cost.as_deref(), Some("1.4"));
            }
            other => panic!("unexpected request_type {other}"),
        }
    }
    server.abort();
}

#[tokio::test]
async fn running_call_keeps_frozen_snapshot_while_excluded_from_overview() {
    let (router, store, _pricing, _dir) =
        setup_control_with_catalog("http://127.0.0.1:1/unused").await;
    let endpoint = "https://api.openai.com/v1/responses";
    let save = |input_price: &str| SaveSupplierPricingInput {
        source_kind: SourceKind::Builtin,
        endpoint_key: endpoint.into(),
        model_id: "gpt-5".into(),
        binding_mode: BindingMode::Auto,
        catalog_provider_id: None,
        catalog_model_id: None,
        custom_rates: PricingRates {
            input_per_million: Some(input_price.into()),
            output_per_million: Some("20".into()),
            cache_read_per_million: Some("1".into()),
            cache_write_per_million: Some("0".into()),
        },
    };
    store
        .save_supplier_pricing_config(&save("10"), &[])
        .await
        .unwrap();

    // Start first call under $10 input rate.
    store
        .start_llm_call(&NewLlmCall {
            call_id: "running-1".into(),
            run_id: "run-1".into(),
            conversation_id: "conv-1".into(),
            provider_call_index: 0,
            model_hash: "mh".into(),
            provider_type: ProviderType::OpenAiResponses,
            provider_url: endpoint.into(),
            request_type: ProviderType::OpenAiResponses,
            request_url: endpoint.into(),
            model_id: "gpt-5".into(),
            display_name: "GPT-5".into(),
            reasoning_effort: None,
            fast: false,
            message_count: 1,
            tool_count: 0,
            detailed: false,
        })
        .await
        .unwrap();

    // Mutate price to $50 while call is STILL RUNNING.
    store
        .save_supplier_pricing_config(&save("50"), &[])
        .await
        .unwrap();

    store
        .record_llm_usage(
            "running-1",
            Usage {
                input_tokens: Some(1_000_000),
                output_tokens: Some(0),
                ..Default::default()
            },
        )
        .await
        .unwrap();

    // Provisional detail has $10 cost, while overview still excludes running call.
    let (_, detail_json) = send(
        router.clone(),
        "GET",
        "/__byok-api__/api/llm-calls/running-1",
        None,
    )
    .await;
    assert_eq!(detail_json["call"]["total_cost"], "10");
    assert_eq!(detail_json["call"]["unit_input_per_million"], "10");
    assert_eq!(detail_json["call"]["status"], "running");

    let overview_while_running = store.overview(None, None, None, None).await.unwrap();
    assert_eq!(overview_while_running.metrics.llm_calls, 0);
    assert_eq!(overview_while_running.metrics.total_cost, "0");

    // Finish first call, and start+finish a second call using the $50 rate.
    store
        .finish_llm_call("running-1", "completed", Some("stop"), 100, None, None)
        .await
        .unwrap();
    store
        .start_llm_call(&NewLlmCall {
            call_id: "done-2".into(),
            run_id: "run-2".into(),
            conversation_id: "conv-1".into(),
            provider_call_index: 0,
            model_hash: "mh".into(),
            provider_type: ProviderType::OpenAiResponses,
            provider_url: endpoint.into(),
            request_type: ProviderType::OpenAiResponses,
            request_url: endpoint.into(),
            model_id: "gpt-5".into(),
            display_name: "GPT-5".into(),
            reasoning_effort: None,
            fast: false,
            message_count: 1,
            tool_count: 0,
            detailed: false,
        })
        .await
        .unwrap();
    store
        .record_llm_usage(
            "done-2",
            Usage {
                input_tokens: Some(1_000_000),
                output_tokens: Some(0),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    store
        .finish_llm_call("done-2", "completed", Some("stop"), 100, None, None)
        .await
        .unwrap();

    let overview_after = store.overview(None, None, None, None).await.unwrap();
    assert_eq!(overview_after.metrics.llm_calls, 2);
    assert_eq!(overview_after.metrics.total_cost, "60");
    assert_eq!(
        overview_after.metrics.average_priced_cost.as_deref(),
        Some("30")
    );
}

#[tokio::test]
async fn failed_cancelled_zero_incomplete_and_unpriced_states_plus_retry_compaction_per_call() {
    let (_dir, store) = fixtures::temp_store().await;
    let paid_ep = "https://paid.example.com/v1/chat/completions";
    let free_ep = "https://free.example.com/v1/chat/completions";
    let partial_price_ep = "https://partial.example.com/v1/chat/completions";

    store
        .save_supplier_pricing_config(
            &SaveSupplierPricingInput {
                source_kind: SourceKind::Builtin,
                endpoint_key: paid_ep.into(),
                model_id: "paid-model".into(),
                binding_mode: BindingMode::Auto,
                catalog_provider_id: None,
                catalog_model_id: None,
                custom_rates: PricingRates {
                    input_per_million: Some("4".into()),
                    output_per_million: Some("8".into()),
                    cache_read_per_million: Some("1".into()),
                    cache_write_per_million: Some("2".into()),
                },
            },
            &[],
        )
        .await
        .unwrap();

    store
        .save_supplier_pricing_config(
            &SaveSupplierPricingInput {
                source_kind: SourceKind::Builtin,
                endpoint_key: free_ep.into(),
                model_id: "free-model".into(),
                binding_mode: BindingMode::Auto,
                catalog_provider_id: None,
                catalog_model_id: None,
                custom_rates: PricingRates {
                    input_per_million: Some("0".into()),
                    output_per_million: Some("0".into()),
                    cache_read_per_million: Some("0".into()),
                    cache_write_per_million: Some("0".into()),
                },
            },
            &[],
        )
        .await
        .unwrap();

    // Missing cache_read price.
    store
        .save_supplier_pricing_config(
            &SaveSupplierPricingInput {
                source_kind: SourceKind::Builtin,
                endpoint_key: partial_price_ep.into(),
                model_id: "partial-price-model".into(),
                binding_mode: BindingMode::Auto,
                catalog_provider_id: None,
                catalog_model_id: None,
                custom_rates: PricingRates {
                    input_per_million: Some("2".into()),
                    output_per_million: Some("6".into()),
                    cache_read_per_million: None,
                    cache_write_per_million: None,
                },
            },
            &[],
        )
        .await
        .unwrap();

    // 1. Failed + cancelled calls sharing one run_id (e.g. retry) bill independently.
    for (id, status, finish_reason) in [
        ("retry-fail", "error", None),
        ("retry-cancel", "cancelled", Some("length")),
    ] {
        store
            .start_llm_call(&NewLlmCall {
                call_id: id.into(),
                run_id: "shared-run".into(),
                conversation_id: "conv".into(),
                provider_call_index: 0,
                model_hash: "mh1".into(),
                provider_type: ProviderType::OpenAiChat,
                provider_url: paid_ep.into(),
                request_type: ProviderType::OpenAiChat,
                request_url: paid_ep.into(),
                model_id: "paid-model".into(),
                display_name: "Paid".into(),
                reasoning_effort: None,
                fast: false,
                message_count: 1,
                tool_count: 0,
                detailed: false,
            })
            .await
            .unwrap();
        store
            .record_llm_usage(
                id,
                Usage {
                    input_tokens: Some(500_000),
                    output_tokens: Some(250_000),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        store
            .finish_llm_call(id, status, finish_reason, 50, None, None)
            .await
            .unwrap();
    }

    // 2. Zero price -> priced with "0".
    store
        .start_llm_call(&NewLlmCall {
            call_id: "zero-cost".into(),
            run_id: "run-zero".into(),
            conversation_id: "conv".into(),
            provider_call_index: 0,
            model_hash: "mh2".into(),
            provider_type: ProviderType::OpenAiChat,
            provider_url: free_ep.into(),
            request_type: ProviderType::OpenAiChat,
            request_url: free_ep.into(),
            model_id: "free-model".into(),
            display_name: "Free".into(),
            reasoning_effort: None,
            fast: false,
            message_count: 1,
            tool_count: 0,
            detailed: false,
        })
        .await
        .unwrap();
    store
        .record_llm_usage(
            "zero-cost",
            Usage {
                input_tokens: Some(1_000_000),
                output_tokens: Some(100_000),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    store
        .finish_llm_call("zero-cost", "completed", Some("stop"), 10, None, None)
        .await
        .unwrap();

    // 3. Used cache_read without cache_read rate -> unpriced.
    store
        .start_llm_call(&NewLlmCall {
            call_id: "missing-cache-price".into(),
            run_id: "run-u".into(),
            conversation_id: "conv".into(),
            provider_call_index: 0,
            model_hash: "mh3".into(),
            provider_type: ProviderType::OpenAiChat,
            provider_url: partial_price_ep.into(),
            request_type: ProviderType::OpenAiChat,
            request_url: partial_price_ep.into(),
            model_id: "partial-price-model".into(),
            display_name: "Partial".into(),
            reasoning_effort: None,
            fast: false,
            message_count: 1,
            tool_count: 0,
            detailed: false,
        })
        .await
        .unwrap();
    store
        .record_llm_usage(
            "missing-cache-price",
            Usage {
                input_tokens: Some(1_000_000),
                output_tokens: Some(100_000),
                cache_read_tokens: Some(500_000),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    store
        .finish_llm_call(
            "missing-cache-price",
            "completed",
            Some("stop"),
            10,
            None,
            None,
        )
        .await
        .unwrap();

    // 4. Incomplete usage -> incomplete_usage.
    store
        .start_llm_call(&NewLlmCall {
            call_id: "missing-output".into(),
            run_id: "run-inc".into(),
            conversation_id: "conv".into(),
            provider_call_index: 0,
            model_hash: "mh1".into(),
            provider_type: ProviderType::OpenAiChat,
            provider_url: paid_ep.into(),
            request_type: ProviderType::OpenAiChat,
            request_url: paid_ep.into(),
            model_id: "paid-model".into(),
            display_name: "Paid".into(),
            reasoning_effort: None,
            fast: false,
            message_count: 1,
            tool_count: 0,
            detailed: false,
        })
        .await
        .unwrap();
    store
        .finish_llm_call(
            "missing-output",
            "error",
            None,
            20,
            Some("net"),
            Some("dropped"),
        )
        .await
        .unwrap();

    let overview = store.overview(None, None, None, None).await.unwrap();
    assert_eq!(overview.metrics.llm_calls, 5);
    assert_eq!(overview.metrics.priced_calls, 3); // retry-fail ($4) + retry-cancel ($4) + zero-cost ($0)
    assert_eq!(overview.metrics.unpriced_calls, 1);
    assert_eq!(overview.metrics.incomplete_usage_calls, 1);
    assert_eq!(overview.metrics.total_cost, "8");
    // average = $8 / 3 priced calls = 2.666666667
    assert_eq!(
        overview.metrics.average_priced_cost.as_deref(),
        Some("2.666666667")
    );
}

#[tokio::test]
async fn catalog_sync_matching_override_priority_and_offline_resilience() {
    let fail_upstream = Arc::new(AtomicBool::new(false));
    let flag = fail_upstream.clone();
    let app = Router::new().route(
        "/api.json",
        get(move || {
            let flag = flag.clone();
            async move {
                if flag.load(Ordering::Acquire) {
                    (StatusCode::INTERNAL_SERVER_ERROR, "catalog down").into_response()
                } else {
                    Json(sample_models_dev_json()).into_response()
                }
            }
        }),
    );
    use axum::response::IntoResponse;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    let catalog_url = format!("http://127.0.0.1:{port}/api.json");
    let (router, store, _pricing, _dir) = setup_control_with_catalog(&catalog_url).await;

    // Legacy global pricing endpoint must return 404.
    let (legacy_status, _) = send(
        router.clone(),
        "GET",
        "/__byok-api__/api/settings/pricing",
        None,
    )
    .await;
    assert_eq!(legacy_status, StatusCode::NOT_FOUND);

    // Sync catalog via HTTP endpoint.
    let (sync_status, sync_body) = send(
        router.clone(),
        "POST",
        "/__byok-api__/api/pricing/sync",
        None,
    )
    .await;
    assert_eq!(sync_status, StatusCode::OK, "{sync_body}");
    assert_eq!(sync_body["catalog_model_count"], 3);
    assert!(sync_body["last_error"].is_null());

    // Search catalog endpoint.
    let (cat_status, cat_body) = send(
        router.clone(),
        "GET",
        "/__byok-api__/api/pricing/catalog?query=gpt-4o&provider_id=openrouter",
        None,
    )
    .await;
    assert_eq!(cat_status, StatusCode::OK);
    assert_eq!(cat_body["total"], 1);
    assert_eq!(cat_body["items"][0]["model_id"], "gpt-4o");

    let (api_search_status, api_search_body) = send(
        router.clone(),
        "GET",
        "/__byok-api__/api/pricing/catalog?query=api.openai.com",
        None,
    )
    .await;
    assert_eq!(api_search_status, StatusCode::OK);
    assert_eq!(api_search_body["total"], 1);
    assert_eq!(api_search_body["items"][0]["provider_id"], "openai");

    // Add relay gpt-4o (multi-provider -> auto_default openai) + unique model (auto_unique) -> check pricing_models API.
    let relay = store
        .create_model(&model_input(
            "Generic Relay",
            Some("relay"),
            ModelType::OpenAi,
            "https://relay.example.com/v1",
            "sk",
            "gpt-4o",
            OPENAI_CHAT_ENDPOINT,
        ))
        .await
        .unwrap();
    let unique = store
        .create_model(&model_input(
            "Unique Model",
            Some("vendor"),
            ModelType::OpenAi,
            "https://relay.example.com/v1",
            "sk",
            "unique-model-v1",
            OPENAI_CHAT_ENDPOINT,
        ))
        .await
        .unwrap();

    let (list_status, models_json) = send(
        router.clone(),
        "GET",
        "/__byok-api__/api/pricing/models",
        None,
    )
    .await;
    assert_eq!(list_status, StatusCode::OK);
    let views = models_json.as_array().unwrap();
    let relay_view = views.iter().find(|v| v["model_id"] == "gpt-4o").unwrap();
    let unique_view = views
        .iter()
        .find(|v| v["model_id"] == "unique-model-v1")
        .unwrap();
    assert_eq!(relay_view["effective_source"], "catalog");
    assert_eq!(relay_view["catalog_match_kind"], "auto_default");
    assert_eq!(relay_view["matched_provider_id"], "openai");
    assert_eq!(relay_view["effective_rates"]["input_per_million"], "2.5");
    assert_eq!(unique_view["effective_source"], "catalog");
    assert_eq!(unique_view["catalog_match_kind"], "auto_unique");

    // Manually bind relay -> openrouter AND set custom override on unique.
    let (put_status, bound_relay) = send(
        router.clone(),
        "PUT",
        "/__byok-api__/api/pricing/models",
        Some(json!({
            "source_kind": "builtin",
            "endpoint_key": relay.request_url().unwrap(),
            "model_id": "gpt-4o",
            "binding_mode": "manual",
            "catalog_provider_id": "openrouter",
            "catalog_model_id": "gpt-4o",
            "custom_rates": {
                "input_per_million": "9.99",
                "output_per_million": "19.99"
            }
        })),
    )
    .await;
    assert_eq!(put_status, StatusCode::OK);
    assert_eq!(bound_relay["effective_source"], "custom");
    assert_eq!(bound_relay["effective_rates"]["input_per_million"], "9.99");

    // Re-sync must NOT overwrite custom override!
    let (resync_status, _) = send(
        router.clone(),
        "POST",
        "/__byok-api__/api/pricing/sync",
        None,
    )
    .await;
    assert_eq!(resync_status, StatusCode::OK);
    let (_, after_resync) = send(
        router.clone(),
        "GET",
        "/__byok-api__/api/pricing/models",
        None,
    )
    .await;
    let relay_after = after_resync
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["supplier_key"] == bound_relay["supplier_key"])
        .unwrap();
    assert_eq!(relay_after["effective_source"], "custom");
    assert_eq!(relay_after["effective_rates"]["input_per_million"], "9.99");

    // Clearing custom override restores bound public catalog pricing!
    let (clear_status, restored) = send(
        router.clone(),
        "PUT",
        "/__byok-api__/api/pricing/models",
        Some(json!({
            "source_kind": "builtin",
            "endpoint_key": relay.request_url().unwrap(),
            "model_id": "gpt-4o",
            "binding_mode": "manual",
            "catalog_provider_id": "openrouter",
            "catalog_model_id": "gpt-4o",
            "custom_rates": {}
        })),
    )
    .await;
    assert_eq!(clear_status, StatusCode::OK);
    assert_eq!(restored["effective_source"], "catalog");
    assert_eq!(restored["effective_rates"]["input_per_million"], "2.8");

    // Catalog server fails -> retains old catalog, records last_error, does not block local calls!
    fail_upstream.store(true, Ordering::Release);
    let (err_sync_status, _) = send(
        router.clone(),
        "POST",
        "/__byok-api__/api/pricing/sync",
        None,
    )
    .await;
    assert_ne!(err_sync_status, StatusCode::OK);

    let (status_status, status_json) = send(
        router.clone(),
        "GET",
        "/__byok-api__/api/pricing/sync",
        None,
    )
    .await;
    assert_eq!(status_status, StatusCode::OK);
    assert_eq!(status_json["catalog_model_count"], 3);
    assert!(status_json["last_error"].as_str().unwrap().contains("500"));

    // Toggle auto_sync_enabled.
    let (put_sync_status, put_sync_json) = send(
        router,
        "PUT",
        "/__byok-api__/api/pricing/sync",
        Some(json!({ "auto_sync_enabled": false })),
    )
    .await;
    assert_eq!(put_sync_status, StatusCode::OK);
    assert_eq!(put_sync_json["auto_sync_enabled"], false);
    assert_eq!(unique.model_id, "unique-model-v1");
    server.abort();
}

#[tokio::test]
async fn backfill_is_idempotent_and_clear_storage_preserves_costs_on_details_only() {
    let (router, store, pricing, _dir) =
        setup_control_with_catalog("http://127.0.0.1:1/unused").await;
    let endpoint = "https://api.openai.com/v1/responses";

    // Pre-existing priced call + unpriced finished historical call (legacy NULL cost_status) + unpriced finished call.
    store
        .save_supplier_pricing_config(
            &SaveSupplierPricingInput {
                source_kind: SourceKind::Builtin,
                endpoint_key: endpoint.into(),
                model_id: "gpt-4o".into(),
                binding_mode: BindingMode::Auto,
                catalog_provider_id: None,
                catalog_model_id: None,
                custom_rates: PricingRates {
                    input_per_million: Some("10".into()),
                    output_per_million: Some("20".into()),
                    ..Default::default()
                },
            },
            &[],
        )
        .await
        .unwrap();

    // 1. Existing priced call (frozen at $10).
    store
        .start_llm_call(&NewLlmCall {
            call_id: "already-priced".into(),
            run_id: "r1".into(),
            conversation_id: "c1".into(),
            provider_call_index: 0,
            model_hash: "mh".into(),
            provider_type: ProviderType::OpenAiResponses,
            provider_url: endpoint.into(),
            request_type: ProviderType::OpenAiResponses,
            request_url: endpoint.into(),
            model_id: "gpt-4o".into(),
            display_name: "GPT-4o".into(),
            reasoning_effort: None,
            fast: false,
            message_count: 1,
            tool_count: 0,
            detailed: true,
        })
        .await
        .unwrap();
    store
        .record_llm_usage(
            "already-priced",
            Usage {
                input_tokens: Some(1_000_000),
                output_tokens: Some(0),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    store
        .finish_llm_call("already-priced", "completed", Some("stop"), 10, None, None)
        .await
        .unwrap();

    // 2. Simulate pre-pricing historical finished call inserted with NULL cost_status & NULL supplier_key.
    sqlx::query(
        "INSERT INTO llm_calls(
            call_id, run_id, conversation_id, provider_call_index, model_hash,
            provider_type, provider_url, request_type, request_url, model_id, display_name,
            status, created_at_ms, finished_at_ms, duration_ms,
            input_tokens, output_tokens, total_tokens,
            message_count, tool_count, detailed
        ) VALUES ('legacy-null', 'r2', 'c2', 0, 'mh', 'openai-responses', ?, 'openai-responses', ?, 'gpt-4o', 'Legacy GPT-4o',
                  'completed', 1000, 1100, 100, 500000, 250000, 750000, 1, 0, 1)",
    )
    .bind(endpoint)
    .bind(endpoint)
    .execute(store.pool())
    .await
    .unwrap();

    // Update price to $2/$4 BEFORE backfill: already-priced stays $10 (cost_backfilled=false),
    // legacy-null backfills to 0.5*2 + 0.25*4 = $2 (cost_backfilled=true)!
    store
        .save_supplier_pricing_config(
            &SaveSupplierPricingInput {
                source_kind: SourceKind::Builtin,
                endpoint_key: endpoint.into(),
                model_id: "gpt-4o".into(),
                binding_mode: BindingMode::Auto,
                catalog_provider_id: None,
                catalog_model_id: None,
                custom_rates: PricingRates {
                    input_per_million: Some("2".into()),
                    output_per_million: Some("4".into()),
                    ..Default::default()
                },
            },
            &[],
        )
        .await
        .unwrap();

    let first_backfill = pricing.backfill_now().await.unwrap();
    assert_eq!(first_backfill, 1);
    let second_backfill = pricing.backfill_now().await.unwrap();
    assert_eq!(second_backfill, 0);

    let already = store.llm_call("already-priced").await.unwrap().unwrap();
    assert_eq!(already.total_cost.as_deref(), Some("10"));
    assert!(!already.cost_backfilled);

    let legacy = store.llm_call("legacy-null").await.unwrap().unwrap();
    assert_eq!(legacy.cost_status.as_deref(), Some("priced"));
    assert_eq!(legacy.total_cost.as_deref(), Some("2"));
    assert!(legacy.cost_backfilled);

    // Clear storage `details`: llm_calls & costs remain!
    let (d_status, _) = send(
        router.clone(),
        "DELETE",
        "/__byok-api__/api/settings/storage/statistics",
        Some(json!({ "scope": "details" })),
    )
    .await;
    assert_eq!(d_status, StatusCode::OK);
    assert_eq!(
        store
            .overview(None, None, None, None)
            .await
            .unwrap()
            .metrics
            .total_cost,
        "12"
    );

    // Clear storage `all`: llm_calls cleared while model_pricing_configs stays!
    let (a_status, _) = send(
        router.clone(),
        "DELETE",
        "/__byok-api__/api/settings/storage/statistics",
        Some(json!({ "scope": "all" })),
    )
    .await;
    assert_eq!(a_status, StatusCode::OK);
    assert_eq!(
        store
            .overview(None, None, None, None)
            .await
            .unwrap()
            .metrics
            .llm_calls,
        0
    );

    let (_, remaining_models) = send(router, "GET", "/__byok-api__/api/pricing/models", None).await;
    assert!(remaining_models
        .as_array()
        .unwrap()
        .iter()
        .any(|m| m["model_id"] == "gpt-4o" && m["effective_rates"]["input_per_million"] == "2"));
}

#[tokio::test]
async fn partial_custom_rates_fallback_to_catalog_across_views_calls_and_backfill() {
    let (router, store, pricing, _dir) =
        setup_control_with_catalog("http://127.0.0.1:1/unused").await;
    store
        .replace_pricing_catalog_from_json(sample_models_dev_json().to_string().as_bytes(), 1_000)
        .await
        .unwrap();

    let openai_ep = "https://api.openai.com/v1/responses";
    let relay_ep = "https://relay.example.com/v1/chat/completions";

    store
        .create_model(&model_input(
            "OpenAI Partial",
            Some("official"),
            ModelType::OpenAi,
            "https://api.openai.com/v1",
            "sk-partial",
            "gpt-4o",
            OPENAI_RESPONSES_ENDPOINT,
        ))
        .await
        .unwrap();

    // Override only input price; output/cache_read/cache_write must fall back to openai catalog.
    let (put_status, _) = send(
        router.clone(),
        "PUT",
        "/__byok-api__/api/pricing/models",
        Some(json!({
            "source_kind": "builtin",
            "endpoint_key": openai_ep,
            "model_id": "gpt-4o",
            "binding_mode": "auto",
            "custom_rates": {
                "input_per_million": "5"
            }
        })),
    )
    .await;
    assert_eq!(put_status, StatusCode::OK);

    let (models_status, models_json) =
        send(router, "GET", "/__byok-api__/api/pricing/models", None).await;
    assert_eq!(models_status, StatusCode::OK);
    let openai_view = models_json
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["endpoint_key"] == openai_ep && item["model_id"] == "gpt-4o")
        .unwrap();
    assert_eq!(openai_view["effective_source"], "custom");
    assert_eq!(openai_view["matched_provider_id"], "openai");
    assert_eq!(openai_view["custom_rates"]["input_per_million"], "5");
    assert!(openai_view["custom_rates"]["output_per_million"].is_null());
    assert_eq!(openai_view["effective_rates"]["input_per_million"], "5");
    assert_eq!(openai_view["effective_rates"]["output_per_million"], "10");
    assert_eq!(
        openai_view["effective_rates"]["cache_read_per_million"],
        "1.25"
    );
    assert_eq!(
        openai_view["effective_rates"]["cache_write_per_million"],
        "0"
    );

    // Live call persists merged snapshot: 600k*$5 + 200k*$10 + 400k*$1.25 = $5.5.
    store
        .start_llm_call(&NewLlmCall {
            call_id: "partial-live".into(),
            run_id: "r-partial-1".into(),
            conversation_id: "c-partial".into(),
            provider_call_index: 0,
            model_hash: "mh-openai".into(),
            provider_type: ProviderType::OpenAiResponses,
            provider_url: openai_ep.into(),
            request_type: ProviderType::OpenAiResponses,
            request_url: openai_ep.into(),
            model_id: "gpt-4o".into(),
            display_name: "OpenAI Partial".into(),
            reasoning_effort: None,
            fast: false,
            message_count: 1,
            tool_count: 0,
            detailed: false,
        })
        .await
        .unwrap();
    store
        .record_llm_usage(
            "partial-live",
            Usage {
                input_tokens: Some(1_000_000),
                output_tokens: Some(200_000),
                cache_read_tokens: Some(400_000),
                cache_write_tokens: Some(0),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    store
        .finish_llm_call("partial-live", "completed", Some("stop"), 50, None, None)
        .await
        .unwrap();

    let live_call = store.llm_call("partial-live").await.unwrap().unwrap();
    assert_eq!(live_call.cost_status.as_deref(), Some("priced"));
    assert_eq!(live_call.pricing_source.as_deref(), Some("custom"));
    assert_eq!(live_call.pricing_provider_id.as_deref(), Some("openai"));
    assert_eq!(live_call.unit_input_per_million.as_deref(), Some("5"));
    assert_eq!(live_call.unit_output_per_million.as_deref(), Some("10"));
    assert_eq!(
        live_call.unit_cache_read_per_million.as_deref(),
        Some("1.25")
    );
    assert_eq!(live_call.total_cost.as_deref(), Some("5.5"));

    // Historical unpriced relay call + manual catalog binding + output-only custom override.
    sqlx::query(
        "INSERT INTO llm_calls(
            call_id, run_id, conversation_id, provider_call_index, model_hash,
            provider_type, provider_url, request_type, request_url, model_id, display_name,
            status, created_at_ms, finished_at_ms, duration_ms,
            input_tokens, output_tokens, total_tokens,
            message_count, tool_count, detailed
        ) VALUES ('partial-backfill', 'r-partial-2', 'c-partial', 0, 'mh-relay', 'openai-chat', ?, 'openai-chat', ?, 'gpt-4o', 'Relay GPT-4o',
                  'completed', 1000, 1100, 100, 1000000, 250000, 1250000, 1, 0, 0)",
    )
    .bind(relay_ep)
    .bind(relay_ep)
    .execute(store.pool())
    .await
    .unwrap();

    store
        .save_supplier_pricing_config(
            &SaveSupplierPricingInput {
                source_kind: SourceKind::Builtin,
                endpoint_key: relay_ep.into(),
                model_id: "gpt-4o".into(),
                binding_mode: BindingMode::Manual,
                catalog_provider_id: Some("openrouter".into()),
                catalog_model_id: Some("gpt-4o".into()),
                custom_rates: PricingRates {
                    input_per_million: None,
                    output_per_million: Some("20".into()),
                    cache_read_per_million: None,
                    cache_write_per_million: None,
                },
            },
            &[],
        )
        .await
        .unwrap();

    assert_eq!(pricing.backfill_now().await.unwrap(), 1);
    let backfilled = store.llm_call("partial-backfill").await.unwrap().unwrap();
    assert_eq!(backfilled.cost_status.as_deref(), Some("priced"));
    assert_eq!(backfilled.pricing_source.as_deref(), Some("custom"));
    assert_eq!(
        backfilled.pricing_provider_id.as_deref(),
        Some("openrouter")
    );
    assert_eq!(backfilled.unit_input_per_million.as_deref(), Some("2.8"));
    assert_eq!(backfilled.unit_output_per_million.as_deref(), Some("20"));
    assert_eq!(backfilled.total_cost.as_deref(), Some("7.8"));
    assert!(backfilled.cost_backfilled);

    let overview = store.overview(None, None, None, None).await.unwrap();
    assert_eq!(overview.metrics.priced_calls, 2);
    assert_eq!(overview.metrics.unpriced_calls, 0);
    assert_eq!(overview.metrics.total_cost, "13.3");
}

#[tokio::test]
async fn relay_calls_backfill_automatically_from_default_public_catalog() {
    let (_router, store, pricing, _dir) =
        setup_control_with_catalog("http://127.0.0.1:1/unused").await;
    let relay_ep = "https://gateway.internal.example/v1/messages";

    // Record finished call before catalog sync -> initially unpriced.
    store
        .start_llm_call(&NewLlmCall {
            call_id: "relay-before-sync".into(),
            run_id: "r-relay".into(),
            conversation_id: "c-relay".into(),
            provider_call_index: 0,
            model_hash: "mh-relay".into(),
            provider_type: ProviderType::Anthropic,
            provider_url: relay_ep.into(),
            request_type: ProviderType::Anthropic,
            request_url: relay_ep.into(),
            model_id: "gpt-4o".into(),
            display_name: "Relay GPT-4o".into(),
            reasoning_effort: None,
            fast: false,
            message_count: 1,
            tool_count: 0,
            detailed: false,
        })
        .await
        .unwrap();
    store
        .record_llm_usage(
            "relay-before-sync",
            Usage {
                input_tokens: Some(1_000_000),
                output_tokens: Some(500_000),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    store
        .finish_llm_call(
            "relay-before-sync",
            "completed",
            Some("end_turn"),
            40,
            None,
            None,
        )
        .await
        .unwrap();

    let before = store.llm_call("relay-before-sync").await.unwrap().unwrap();
    assert_eq!(before.cost_status.as_deref(), Some("unpriced"));

    // Sync public catalog containing both openai ($2.5/$10) and openrouter ($2.8/$11.2):
    // relay defaults to canonical openai public rates and backfills automatically.
    store
        .replace_pricing_catalog_from_json(sample_models_dev_json().to_string().as_bytes(), 1_000)
        .await
        .unwrap();

    assert_eq!(pricing.backfill_now().await.unwrap(), 1);
    let after = store.llm_call("relay-before-sync").await.unwrap().unwrap();
    assert_eq!(after.cost_status.as_deref(), Some("priced"));
    assert_eq!(after.pricing_source.as_deref(), Some("catalog"));
    assert_eq!(after.pricing_provider_id.as_deref(), Some("openai"));
    assert_eq!(after.total_cost.as_deref(), Some("7.5"));
    assert!(after.cost_backfilled);
}

#[tokio::test]
async fn default_creator_prices_preserve_cache_and_free_costs_in_live_calls_and_backfill() {
    let (_router, store, pricing, _dir) =
        setup_control_with_catalog("http://127.0.0.1:1/unused").await;
    let endpoint = "https://relay.example.com/v1/chat/completions";
    let usage = Usage {
        input_tokens: Some(1_000_000),
        output_tokens: Some(200_000),
        cache_read_tokens: Some(400_000),
        ..Default::default()
    };
    let catalog = json!({
        "alibaba-cn": { "models": { "MiniMax-M2.5": { "cost": { "input": 0.3, "output": 1.2 } } } },
        "minimax": { "models": { "MiniMax-M2.5": { "cost": { "input": 0.3, "output": 1.2, "cache_read": 0.03, "cache_write": 0.375 } } } },
        "cortecs": { "models": { "glm-4.7-flash": { "cost": { "input": 0.08, "output": 0.478 } } } },
        "zai": { "models": { "glm-4.7-flash": { "cost": { "input": 0, "output": 0, "cache_read": 0, "cache_write": 0 } } } }
    });
    for phase in ["historical", "live"] {
        if phase == "live" {
            store
                .replace_pricing_catalog_from_json(catalog.to_string().as_bytes(), 1_000)
                .await
                .unwrap();
            assert_eq!(pricing.backfill_now().await.unwrap(), 2);
        }
        for model_id in ["MiniMax-M2.5", "glm-4.7-flash"] {
            let call_id = format!("{phase}-{model_id}");
            store
                .start_llm_call(&NewLlmCall {
                    call_id: call_id.clone(),
                    run_id: "creator-pricing".into(),
                    conversation_id: "creator-pricing".into(),
                    provider_call_index: 0,
                    model_hash: "creator-pricing".into(),
                    provider_type: ProviderType::OpenAiChat,
                    provider_url: endpoint.into(),
                    request_type: ProviderType::OpenAiChat,
                    request_url: endpoint.into(),
                    model_id: model_id.into(),
                    display_name: model_id.into(),
                    reasoning_effort: None,
                    fast: false,
                    message_count: 1,
                    tool_count: 0,
                    detailed: false,
                })
                .await
                .unwrap();
            store
                .record_llm_usage(&call_id, usage.clone())
                .await
                .unwrap();
            store
                .finish_llm_call(&call_id, "completed", Some("stop"), 10, None, None)
                .await
                .unwrap();
        }
    }
    for phase in ["historical", "live"] {
        for (model_id, provider_id, total) in [
            ("MiniMax-M2.5", "minimax", "0.432"),
            ("glm-4.7-flash", "zai", "0"),
        ] {
            let call = store
                .llm_call(&format!("{phase}-{model_id}"))
                .await
                .unwrap()
                .unwrap();
            assert_eq!(call.pricing_provider_id.as_deref(), Some(provider_id));
            assert_eq!(call.cost_status.as_deref(), Some("priced"));
            assert_eq!(call.total_cost.as_deref(), Some(total));
            assert_eq!(call.cost_backfilled, phase == "historical");
        }
    }
    let views = store.supplier_pricing_models(&[]).await.unwrap();
    assert_eq!(views.len(), 2);
    assert!(views.iter().all(|view| view.catalog_match_kind
        == cursor_server::pricing::CatalogMatchKind::AutoDefault
        && view.unpriced_call_count == 0));
    let overview = store.overview(None, None, None, None).await.unwrap();
    assert_eq!(overview.metrics.priced_calls, 4);
    assert_eq!(overview.metrics.unpriced_calls, 0);
    assert_eq!(overview.metrics.total_cost, "0.864");
}

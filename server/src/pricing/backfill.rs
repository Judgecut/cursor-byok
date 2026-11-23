//! Idempotent batched background backfill for unpriced finished historical calls.
use std::collections::HashMap;

use tokio_util::sync::CancellationToken;

use crate::{pricing::calculator::calculate_cost, store::Store, Result};

use super::calculator::{CostStatus, PricingSnapshot};

const BACKFILL_BATCH_SIZE: usize = 200;

/// Cache reads are estimated only when the supplier's recent calls show that
/// it never reports cache details; the verdict is memoized per supplier key for
/// the whole pass because backfill writes no evidence columns.
async fn estimation_hit_rate(
    store: &Store,
    cache: &mut HashMap<String, Option<i64>>,
    supplier_key: &str,
    assumed_cache_hit_rate_bps: i64,
) -> Result<Option<i64>> {
    if let Some(cached) = cache.get(supplier_key) {
        return Ok(*cached);
    }
    let window = store.supplier_cache_reporting(supplier_key).await?;
    let hit_rate = window
        .justifies_estimation()
        .then_some(assumed_cache_hit_rate_bps);
    cache.insert(supplier_key.to_owned(), hit_rate);
    Ok(hit_rate)
}

pub async fn run_backfill_once(store: &Store, cancellation: &CancellationToken) -> Result<usize> {
    store.ensure_llm_call_supplier_keys().await?;
    let assumed_cache_hit_rate_bps = store.pricing_settings().await?.assumed_cache_hit_rate_bps;
    let mut backfilled_count = 0usize;
    let mut snapshot_cache: HashMap<String, PricingSnapshot> = HashMap::new();
    let mut estimation_cache: HashMap<String, Option<i64>> = HashMap::new();
    let mut after_rowid: i64 = 0;

    loop {
        if cancellation.is_cancelled() {
            return Ok(backfilled_count);
        }
        let batch = store
            .unpriced_finished_calls_batch(after_rowid, BACKFILL_BATCH_SIZE)
            .await?;
        if batch.is_empty() {
            break;
        }
        after_rowid = batch.last().expect("non-empty batch").rowid;

        let mut updates = Vec::new();
        for item in batch {
            if item.usage.input_tokens.is_none() || item.usage.output_tokens.is_none() {
                updates.push(crate::store::pricing::BackfillCallUpdate::IncompleteUsage {
                    call_id: item.call_id,
                });
                continue;
            }
            if item.existing_cost_status.as_deref() == Some("priced") {
                if let Some(snapshot) = item.frozen_snapshot {
                    let hit_rate = estimation_hit_rate(
                        store,
                        &mut estimation_cache,
                        &item.identity.supplier_key,
                        assumed_cache_hit_rate_bps,
                    )
                    .await?;
                    let calculated = calculate_cost(
                        item.request_type,
                        item.call_origin,
                        &item.usage,
                        &snapshot,
                        hit_rate,
                    )?;
                    match calculated.status {
                        CostStatus::Priced => {
                            backfilled_count += 1;
                            updates.push(
                                crate::store::pricing::BackfillCallUpdate::BasisRecalculated {
                                    call_id: item.call_id,
                                    calculated,
                                },
                            );
                        }
                        CostStatus::Unpriced => {
                            updates.push(
                                crate::store::pricing::BackfillCallUpdate::StillUnpriced {
                                    call_id: item.call_id,
                                    snapshot,
                                },
                            );
                        }
                        CostStatus::IncompleteUsage => {
                            updates.push(
                                crate::store::pricing::BackfillCallUpdate::IncompleteUsage {
                                    call_id: item.call_id,
                                },
                            );
                        }
                    }
                    continue;
                }
            }
            let snapshot = if let Some(cached) = snapshot_cache.get(&item.identity.supplier_key) {
                cached.clone()
            } else {
                let resolved = store.resolve_snapshot_for_identity(&item.identity).await?;
                snapshot_cache.insert(item.identity.supplier_key.clone(), resolved.clone());
                resolved
            };
            let hit_rate = estimation_hit_rate(
                store,
                &mut estimation_cache,
                &item.identity.supplier_key,
                assumed_cache_hit_rate_bps,
            )
            .await?;
            let calculated =
                calculate_cost(item.request_type, item.call_origin, &item.usage, &snapshot, hit_rate)?;
            match calculated.status {
                CostStatus::Priced => {
                    backfilled_count += 1;
                    updates.push(crate::store::pricing::BackfillCallUpdate::Priced {
                        call_id: item.call_id,
                        snapshot,
                        calculated,
                    });
                }
                CostStatus::Unpriced => {
                    updates.push(crate::store::pricing::BackfillCallUpdate::StillUnpriced {
                        call_id: item.call_id,
                        snapshot,
                    });
                }
                CostStatus::IncompleteUsage => {
                    updates.push(crate::store::pricing::BackfillCallUpdate::IncompleteUsage {
                        call_id: item.call_id,
                    });
                }
            }
        }

        store.apply_backfill_batch(&updates).await?;
        tokio::task::yield_now().await;
    }

    Ok(backfilled_count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        model::{CallOrigin, NewLlmCall, ProviderType, Usage},
        pricing::{BindingMode, PricingRates, SourceKind},
        store::{CallFinish, SaveSupplierPricingInput},
    };

    const ENDPOINT: &str = "https://gateway.example.com/v1";
    const MODEL_ID: &str = "gemini-2.5-pro";

    async fn record_call(
        store: &Store,
        call_id: &str,
        provider_type: ProviderType,
        input_tokens: u64,
        output_tokens: u64,
    ) {
        store
            .start_llm_call(&NewLlmCall {
                call_id: call_id.into(),
                run_id: format!("run-{call_id}"),
                conversation_id: "conversation".into(),
                provider_call_index: 0,
                model_hash: format!("mh-{call_id}"),
                provider_type,
                provider_url: ENDPOINT.into(),
                request_type: provider_type,
                request_url: ENDPOINT.into(),
                model_id: MODEL_ID.into(),
                display_name: "Gemini-2.5-Pro".into(),
                reasoning_effort: None,
                fast: false,
                message_count: 1,
                tool_count: 0,
                detailed: false,
                origin: CallOrigin::Run,
                streaming: true,
            })
            .await
            .unwrap();
        store
            .record_llm_usage(
                call_id,
                Usage {
                    input_tokens: Some(input_tokens),
                    output_tokens: Some(output_tokens),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        store
            .finish_llm_call(
                call_id,
                CallFinish {
                    status: "completed",
                    finish_reason: Some("stop"),
                    elapsed_ms: 50,
                    generation_ms: None,
                    generation_output_events: None,
                    error_kind: None,
                    error_message: None,
                },
            )
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn backfill_estimates_unreported_cache_only_with_supplier_evidence() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::connect(&format!(
            "sqlite://{}",
            directory.path().join("test.db").display()
        ))
        .await
        .unwrap();
        store
            .save_supplier_pricing_config(
                &SaveSupplierPricingInput {
                    source_kind: SourceKind::Builtin,
                    endpoint_key: ENDPOINT.into(),
                    model_id: MODEL_ID.into(),
                    binding_mode: BindingMode::Auto,
                    catalog_provider_id: None,
                    catalog_model_id: None,
                    custom_rates: PricingRates {
                        input_per_million: Some("1.5".into()),
                        output_per_million: Some("7.5".into()),
                        cache_read_per_million: Some("0.075".into()),
                        cache_write_per_million: Some("0.375".into()),
                    },
                },
                &[],
            )
            .await
            .unwrap();

        // A settled history of large calls that never report cache details is the
        // evidence the live path relies on, so a later unpriced row inherits it.
        for index in 0..crate::pricing::ASSUMED_CACHE_MIN_SAMPLE_CALLS - 1 {
            record_call(
                &store,
                &format!("history-{index}"),
                ProviderType::OpenAiChat,
                2_048,
                1,
            )
            .await;
        }
        record_call(&store, "history-boundary", ProviderType::OpenAiChat, 2_048, 1).await;
        store.record_llm_usage("history-boundary", Usage {
            input_tokens: Some(2_048),
            output_tokens: Some(1),
            ..Default::default()
        }).await.unwrap();
        let boundary = store.llm_call("history-boundary").await.unwrap().unwrap();
        assert_eq!(boundary.cost_basis.as_deref(), Some("reported"));

        record_call(&store, "target", ProviderType::Anthropic, 179_726, 798).await;
        // Simulate a legacy row recorded before pricing could be computed.
        sqlx::query(
            "UPDATE llm_calls SET
                cost_status = 'unpriced',
                cost_basis = NULL,
                assumed_cache_hit_rate_bps = NULL,
                estimated_cache_read_tokens = NULL,
                input_cost_nano = NULL,
                output_cost_nano = NULL,
                cache_read_cost_nano = NULL,
                cache_write_cost_nano = NULL,
                total_cost_nano = NULL
             WHERE call_id = 'target'",
        )
        .execute(store.pool())
        .await
        .unwrap();

        let token = CancellationToken::new();
        let updated = run_backfill_once(&store, &token).await.unwrap();
        assert_eq!(updated, 1);

        let call = store.llm_call("target").await.unwrap().unwrap();
        assert_eq!(call.cost_basis.as_deref(), Some("assumed_cache"));
        assert_eq!(call.assumed_cache_hit_rate_bps, Some(9_000));
        assert_eq!(call.estimated_cache_read_tokens, Some(161_753));
        assert_eq!(call.billed_input_tokens, Some(17_973));
        assert_eq!(call.input_cost.as_deref(), Some("0.0269595"));
        assert_eq!(call.cache_read_cost.as_deref(), Some("0.012131475"));
        assert_eq!(call.output_cost.as_deref(), Some("0.005985"));
        assert_eq!(call.total_cost.as_deref(), Some("0.045075975"));
        assert!(call.cost_backfilled);

        let second_pass = run_backfill_once(&store, &token).await.unwrap();
        assert_eq!(second_pass, 0);
    }
}

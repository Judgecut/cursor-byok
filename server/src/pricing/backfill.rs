//! Idempotent batched background backfill for unpriced finished historical calls.
use std::collections::HashMap;

use tokio_util::sync::CancellationToken;

use crate::{pricing::calculator::calculate_cost, store::Store, Result};

use super::calculator::{CostStatus, PricingSnapshot};

const BACKFILL_BATCH_SIZE: usize = 200;

pub async fn run_backfill_once(store: &Store, cancellation: &CancellationToken) -> Result<usize> {
    store.ensure_llm_call_supplier_keys().await?;
    let mut backfilled_count = 0usize;
    let mut cache: HashMap<String, PricingSnapshot> = HashMap::new();
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
            let snapshot = if let Some(cached) = cache.get(&item.identity.supplier_key) {
                cached.clone()
            } else {
                let resolved = store.resolve_snapshot_for_identity(&item.identity).await?;
                cache.insert(item.identity.supplier_key.clone(), resolved.clone());
                resolved
            };
            let calculated = calculate_cost(item.request_type, &item.usage, &snapshot)?;
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

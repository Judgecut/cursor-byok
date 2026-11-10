//! Model pricing catalog sync, strict matching, snapshot resolution, and usage cost calculation.
pub mod backfill;
pub mod calculator;
pub mod decimal;
pub mod identity;
pub mod matcher;
pub mod sync;

pub use calculator::{
    billed_tokens, calculate_cost, BilledTokens, CalculatedCost, CostStatus, PricingRates,
    PricingSnapshot, PricingSource,
};
pub use decimal::{canonicalize_custom_price, divide_nano_round_half_up, format_nano_usd};
pub use identity::{
    build_supplier_identity, canonical_supplier_identity, endpoint_host, normalize_endpoint_key,
    SourceKind, SupplierIdentity,
};
pub use matcher::{
    parse_models_dev_catalog, resolve_supplier_pricing, BindingMode, CatalogMatchKind,
    CatalogModel, ModelPricingConfig, ResolvedPricing,
};
pub use sync::{PricingService, PricingSyncState, DEFAULT_SYNC_INTERVAL_HOURS};

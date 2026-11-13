//! Adapts Cursor's client-owned Agent loop to configured model providers.
mod events;
mod project;
mod selection;
mod service;

pub(crate) use project::project;
pub(crate) use service::{decode_append, starts_run_inference, InferenceRoute, InferenceService};

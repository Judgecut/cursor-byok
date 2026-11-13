//! Retains reasoning selections by conversation/model and resolves native parent request IDs.
use std::collections::{HashMap, VecDeque};

use axum::http::HeaderMap;

use crate::{
    cursor::{model_selection, protocol::proto::inference as pb},
    model::{ModelSpec, ReasoningSpec},
    Error, Result,
};

// Active requests remain available for their complete lifecycle. Retain a bounded
// history after completion so delayed children and subsequent turns can resolve it.
const COMPLETED_SELECTIONS: usize = 1024;

#[cfg(test)]
#[path = "selection_tests.rs"]
mod tests;

#[derive(Default)]
pub(super) struct Selections {
    active: HashMap<String, Selection>,
    completed: VecDeque<Selection>,
    next_order: u64,
}

struct Selection {
    request_id: String,
    original_request_id: Option<String>,
    conversation_id: String,
    model_id: String,
    reasoning: ReasoningSpec,
    order: u64,
}

#[derive(Default)]
pub(super) struct RunHeaders {
    pub original_request_id: Option<String>,
    pub parent_request_id: Option<String>,
    pub root_parent_request_id: Option<String>,
}

impl RunHeaders {
    pub fn parse(headers: &HeaderMap) -> Result<Self> {
        let value = |name: &str| -> Result<Option<String>> {
            Ok(headers
                .get(name)
                .map(|value| value.to_str())
                .transpose()
                .map_err(|error| Error::Protocol(format!("invalid {name} header: {error}")))?
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned))
        };
        Ok(Self {
            original_request_id: value("x-original-request-id")?,
            parent_request_id: value("x-parent-request-id")?,
            root_parent_request_id: value("x-root-parent-request-id")?,
        })
    }
}

impl Selections {
    fn all(&self) -> impl Iterator<Item = &Selection> {
        self.active.values().chain(self.completed.iter())
    }

    fn latest(&self, conversation_id: &str, model_id: &str) -> Option<&Selection> {
        self.all()
            .filter(|selection| {
                selection.conversation_id == conversation_id && selection.model_id == model_id
            })
            .max_by_key(|selection| selection.order)
    }

    pub fn resolve(
        &self,
        conversation_id: &str,
        requested: &pb::InferenceRequestedModel,
        headers: &RunHeaders,
        default_effort: Option<&str>,
    ) -> Result<pb::InferenceRequestedModel> {
        let parent_id = headers
            .parent_request_id
            .as_deref()
            .or(headers.root_parent_request_id.as_deref());
        let parent = parent_id.and_then(|id| {
            self.all()
                .filter(|selection| {
                    selection.request_id == id
                        || selection.original_request_id.as_deref() == Some(id)
                })
                .max_by_key(|selection| selection.order)
        });
        let inherited = self
            .latest(conversation_id, &requested.model_id)
            .or_else(|| {
                parent
                    .filter(|parent| parent.model_id == requested.model_id)
                    .and_then(|parent| self.latest(&parent.conversation_id, &parent.model_id))
            });
        let mut model = ModelSpec::new(&requested.model_id);
        if let Some(inherited) = inherited {
            model.reasoning = inherited.reasoning.clone();
        }
        model.reasoning.enabled |= requested.max_mode;
        model_selection::apply(
            &mut model,
            requested
                .parameters
                .iter()
                .map(|parameter| (parameter.id.as_str(), parameter.value.as_str())),
        )?;
        if model.reasoning.effort.is_none() && model.reasoning.enabled_override != Some(false) {
            model.reasoning.effort = default_effort.map(str::to_owned);
        }
        model.reasoning.enabled |= model.reasoning.effort.is_some();
        let mut resolved = requested.clone();
        resolved.parameters.retain(|parameter| {
            !matches!(parameter.id.as_str(), "reasoning" | "effort" | "thinking")
        });
        let parameter = if let Some(effort) = model.reasoning.effort {
            Some(("reasoning", effort))
        } else if let Some(enabled) = model.reasoning.enabled_override {
            Some(("thinking", enabled.to_string()))
        } else if model.reasoning.enabled {
            Some(("thinking", "true".into()))
        } else {
            None
        };
        if let Some((id, value)) = parameter {
            resolved.parameters.insert(
                0,
                pb::InferenceModelParameterValue {
                    id: id.into(),
                    value,
                },
            );
        }
        Ok(resolved)
    }

    pub fn remember(
        &mut self,
        request_id: &str,
        conversation_id: &str,
        model: &pb::InferenceRequestedModel,
        headers: &RunHeaders,
    ) -> Result<()> {
        let request = super::project(&pb::InferenceStreamRequest::default(), model)?;
        self.next_order += 1;
        self.active.insert(
            request_id.into(),
            Selection {
                request_id: request_id.into(),
                original_request_id: headers.original_request_id.clone(),
                conversation_id: conversation_id.into(),
                model_id: model.model_id.clone(),
                reasoning: request.model.reasoning,
                order: self.next_order,
            },
        );
        Ok(())
    }

    pub fn finish(&mut self, request_id: &str) {
        if let Some(selection) = self.active.remove(request_id) {
            self.completed.push_back(selection);
            while self.completed.len() > COMPLETED_SELECTIONS {
                self.completed.pop_front();
            }
        }
    }
}

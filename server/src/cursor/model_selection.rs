//! Interprets model parameters shared by both Cursor entry points.
use crate::{
    model::{parse_token_count, ModelLatency, ModelSpec},
    Error, Result,
};

pub(crate) fn apply<'a>(
    model: &mut ModelSpec,
    parameters: impl IntoIterator<Item = (&'a str, &'a str)>,
) -> Result<()> {
    for (id, value) in parameters {
        match id {
            "reasoning" | "effort" => {
                let effort = value.trim();
                if !matches!(
                    effort,
                    "none" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra"
                ) {
                    return Err(Error::Protocol(format!(
                        "invalid Cursor reasoning effort: {value}"
                    )));
                }
                let enabled = effort != "none";
                model.reasoning.enabled_override = Some(enabled);
                model.reasoning.enabled = enabled;
                model.reasoning.effort = enabled.then(|| effort.to_owned());
            }
            "thinking" => {
                let enabled = boolean(id, value)?;
                model.reasoning.enabled_override = Some(enabled);
                model.reasoning.enabled = enabled;
                if !enabled {
                    model.reasoning.effort = None;
                }
            }
            "fast" => {
                model.latency = if boolean(id, value)? {
                    ModelLatency::Fast
                } else {
                    ModelLatency::Standard
                };
            }
            "context" => {
                model.context_window_tokens = Some(
                    parse_token_count(value)
                        .filter(|tokens| *tokens > 0)
                        .ok_or_else(|| {
                            Error::Protocol(format!("invalid Cursor context token count: {value}"))
                        })?,
                );
            }
            _ => {}
        }
    }
    Ok(())
}

fn boolean(id: &str, value: &str) -> Result<bool> {
    match value {
        "true" => Ok(true),
        "false" => Ok(false),
        _ => Err(Error::Protocol(format!(
            "invalid Cursor boolean model parameter {id}={value}"
        ))),
    }
}

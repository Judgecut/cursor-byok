//! Maps structured upstream failures to Cursor's existing error wire contract.
use crate::{cursor::protocol::proto::inference as pb, Error};

pub(super) fn failure(error: &Error) -> (i32, pb::InferenceStreamError) {
    let (rpc, kind) = match error {
        Error::Cancelled => (1, 1),
        Error::Protocol(_) | Error::Config(_) => (3, 1),
        Error::Upstream { status, code, .. } => match code.as_deref() {
            Some("context_length_exceeded" | "input_token_limit_exceeded" | "prompt_too_long") => {
                (8, 2)
            }
            Some("max_output_tokens" | "output_token_limit_exceeded") => (8, 3),
            Some("rate_limit_exceeded" | "rate_limit_error") => (8, 4),
            Some("authentication_error" | "invalid_api_key") => (16, 5),
            Some("permission_error") => (7, 6),
            Some("overloaded_error") => (14, 7),
            Some("content_filter" | "content_policy_violation") => (7, 8),
            _ => match status {
                Some(401) => (16, 5),
                Some(403) => (7, 6),
                Some(429) => (8, 4),
                Some(503 | 529) => (14, 7),
                _ => (13, 1),
            },
        },
        _ => (13, 1),
    };
    (
        rpc,
        pb::InferenceStreamError {
            message: error.to_string(),
            code: rpc.to_string(),
            error_type: kind,
            is_input_token_limit_error: kind == 2,
            is_output_token_limit_error: kind == 3,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_classification_uses_codes_not_message_keywords() {
        let error = Error::Upstream {
            status: Some(400),
            code: Some("context_length_exceeded".into()),
            message: "too large".into(),
        };
        let (rpc, wire) = failure(&error);
        assert_eq!(rpc, 8);
        assert!(wire.is_input_token_limit_error);
        let (_, wire) = failure(&Error::Provider(
            "context_length_exceeded inside an ordinary message".into(),
        ));
        assert!(!wire.is_input_token_limit_error);
        assert_eq!(failure(&Error::Cancelled).0, 1);
    }
}

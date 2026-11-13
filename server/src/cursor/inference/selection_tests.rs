use super::*;

fn requested(parameters: &[(&str, &str)]) -> pb::InferenceRequestedModel {
    pb::InferenceRequestedModel {
        model_id: "model".into(),
        parameters: parameters
            .iter()
            .map(|(id, value)| pb::InferenceModelParameterValue {
                id: (*id).into(),
                value: (*value).into(),
            })
            .collect(),
        ..Default::default()
    }
}

#[test]
fn completed_history_is_bounded_without_evicting_active_parents() {
    let mut selections = Selections::default();
    selections
        .remember(
            "active",
            "parent",
            &requested(&[("reasoning", "high")]),
            &RunHeaders::default(),
        )
        .unwrap();
    for index in 0..COMPLETED_SELECTIONS + 2 {
        let id = format!("completed-{index}");
        selections
            .remember(
                &id,
                &id,
                &requested(&[("reasoning", "low")]),
                &RunHeaders::default(),
            )
            .unwrap();
        selections.finish(&id);
    }
    assert_eq!(selections.active.len(), 1);
    assert_eq!(selections.completed.len(), COMPLETED_SELECTIONS);
    assert_eq!(
        selections.completed.front().unwrap().request_id,
        "completed-2"
    );
    let headers = RunHeaders {
        parent_request_id: Some("active".into()),
        ..Default::default()
    };
    let child = selections
        .resolve("child", &requested(&[]), &headers, Some("medium"))
        .unwrap();
    assert_eq!(child.parameters[0].value, "high");
}

#[test]
fn invalid_selection_does_not_replace_a_valid_session_choice() {
    let mut selections = Selections::default();
    selections
        .remember(
            "valid",
            "conversation",
            &requested(&[("reasoning", "high")]),
            &RunHeaders::default(),
        )
        .unwrap();
    assert!(selections
        .resolve(
            "conversation",
            &requested(&[("reasoning", "invalid")]),
            &RunHeaders::default(),
            None
        )
        .is_err());
    assert_eq!(
        selections
            .resolve(
                "conversation",
                &requested(&[]),
                &RunHeaders::default(),
                None
            )
            .unwrap()
            .parameters[0]
            .value,
        "high"
    );
}

#[test]
fn explicit_disablement_overrides_session_reasoning_and_preserves_other_parameters() {
    let mut selections = Selections::default();
    selections
        .remember(
            "parent",
            "conversation",
            &requested(&[("reasoning", "high")]),
            &RunHeaders::default(),
        )
        .unwrap();
    let child = selections
        .resolve(
            "conversation",
            &requested(&[("reasoning", "none"), ("context", "128k"), ("fast", "true")]),
            &RunHeaders::default(),
            Some("medium"),
        )
        .unwrap();
    let projected = super::super::project(&pb::InferenceStreamRequest::default(), &child).unwrap();
    assert_eq!(projected.model.reasoning.enabled_override, Some(false));
    assert_eq!(projected.model.reasoning.effort, None);
    assert_eq!(projected.model.context_window_tokens, Some(128_000));
    assert_eq!(projected.model.latency, crate::model::ModelLatency::Fast);
}

#[test]
fn parent_headers_ignore_empty_values_and_reject_non_text() {
    let mut headers = HeaderMap::new();
    headers.insert("x-parent-request-id", "   ".parse().unwrap());
    assert_eq!(RunHeaders::parse(&headers).unwrap().parent_request_id, None);
    headers.insert(
        "x-parent-request-id",
        axum::http::HeaderValue::from_bytes(b"\xff").unwrap(),
    );
    assert!(RunHeaders::parse(&headers).is_err());
}

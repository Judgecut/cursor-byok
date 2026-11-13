//! Verifies native parent headers without relying on a patched Cursor client.
use super::*;
use axum::body::BodyDataStream;

struct ClientRun {
    id: String,
    sequence: i64,
    stream: BodyDataStream,
    ready: pb::RunInferenceRunReady,
}

impl ClientRun {
    async fn start(
        router: &axum::Router,
        id: &str,
        conversation: &str,
        model: &str,
        parameters: &[(&str, &str)],
        headers: &[(&str, &str)],
    ) -> Self {
        let message = pb::RunInferenceClientMessage {
            message: Some(pb::run_inference_client_message::Message::RunRequest(
                pb::RunInferenceRunRequest {
                    conversation_id: conversation.into(),
                    requested_model: Some(pb::InferenceRequestedModel {
                        model_id: model.into(),
                        parameters: parameters
                            .iter()
                            .map(|(id, value)| pb::InferenceModelParameterValue {
                                id: (*id).into(),
                                value: (*value).into(),
                            })
                            .collect(),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
            )),
        };
        let append = ai::BidiAppendRequest {
            request_id: Some(ai::BidiRequestId {
                request_id: id.into(),
            }),
            data_binary: message.encode_to_vec(),
            ..Default::default()
        };
        let mut request = Request::post("/aiserver.v1.BidiService/BidiAppend")
            .header(header::CONTENT_TYPE, "application/proto");
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        let response = router
            .clone()
            .oneshot(request.body(Body::from(append.encode_to_vec())).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let response = router
            .clone()
            .oneshot(
                Request::post("/aiserver.v1.InferenceService/RunInferenceSSE")
                    .body(Body::from(
                        agent::BidiRequestId {
                            request_id: id.into(),
                        }
                        .encode_to_vec(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        let mut stream = response.into_body().into_data_stream();
        let Some(pb::run_inference_server_message::Message::RunReady(ready)) =
            next_message(&mut stream).await.message
        else {
            panic!("expected RunReady");
        };
        Self {
            id: id.into(),
            sequence: 1,
            stream,
            ready,
        }
    }

    fn effort(&self) -> Option<&str> {
        self.ready
            .prompt_model_metadata
            .as_ref()
            .unwrap()
            .reasoning_effort
            .as_deref()
    }

    async fn invoke(&mut self, router: &axum::Router, provider: &FakeProvider) -> ModelRequest {
        provider.push(vec![ModelEvent::Done(FinishReason::Stop)]);
        let invocation_id = format!("{}-{}", self.id, self.sequence);
        append(
            router,
            &self.id,
            self.sequence,
            pb::RunInferenceClientMessage {
                message: Some(pb::run_inference_client_message::Message::InvokeModel(
                    pb::RunInferenceInvokeModel {
                        invocation_id: invocation_id.clone(),
                        request: Some(pb::InferenceStreamRequest {
                            messages: vec![pb::InferenceCoreMessage {
                                role: 1,
                                content: Some(pb::inference_core_message::Content::Text(
                                    "question".into(),
                                )),
                                ..Default::default()
                            }],
                            ..Default::default()
                        }),
                        ..Default::default()
                    },
                )),
            },
        )
        .await;
        self.sequence += 1;
        loop {
            if let Some(pb::run_inference_server_message::Message::InvocationEnd(end)) =
                next_message(&mut self.stream).await.message
            {
                assert_eq!(end.invocation_id, invocation_id);
                assert!(end.error.is_none());
                break;
            }
        }
        provider.requests().last().unwrap().clone()
    }

    async fn finish(mut self, router: &axum::Router) {
        append(
            router,
            &self.id,
            self.sequence,
            pb::RunInferenceClientMessage {
                message: Some(pb::run_inference_client_message::Message::FinishRun(
                    pb::RunInferenceFinishRun { aborted: false },
                )),
            },
        )
        .await;
        let frame = next_message_raw(&mut self.stream).await;
        assert_eq!(
            frame[0] & connect::END_STREAM_FLAG,
            connect::END_STREAM_FLAG
        );
        assert!(self.stream.next().await.is_none());
    }
}

#[tokio::test]
async fn native_parent_headers_inherit_after_parent_completion_and_original_id_aliasing() {
    let (_directory, store) = temp_store().await;
    let mut input = model_input();
    input.reasoning_effort = Some("medium".into());
    let model = store.create_model(&input).await.unwrap();
    let provider = FakeProvider::default();
    let (_router_directory, router) = router(store, provider.clone());
    let parent = ClientRun::start(
        &router,
        "parent-attempt",
        "parent-session",
        &model.model_hash,
        &[("reasoning", "high")],
        &[("x-original-request-id", "parent-original")],
    )
    .await;
    parent.finish(&router).await;
    let mut child = ClientRun::start(
        &router,
        "child",
        "child-session",
        &model.model_hash,
        &[],
        &[
            ("x-parent-request-id", "parent-original"),
            ("x-parent-agent-tool-call-id", "task-1"),
        ],
    )
    .await;
    assert_eq!(child.effort(), Some("high"));
    assert_eq!(
        child.ready.resolved_model.as_ref().unwrap().parameters[0].value,
        "high"
    );
    let first = child.invoke(&router, &provider).await;
    let second = child.invoke(&router, &provider).await;
    assert_eq!(first.model.reasoning.effort.as_deref(), Some("high"));
    assert_eq!(first.prompt, second.prompt);
    assert_eq!(first.history, second.history);
    child.finish(&router).await;
}

#[tokio::test]
async fn latest_session_selection_changes_new_children_without_changing_existing_runs() {
    let (_directory, store) = temp_store().await;
    let model = store.create_model(&model_input()).await.unwrap();
    let provider = FakeProvider::default();
    let (_router_directory, router) = router(store, provider.clone());
    let parent = ClientRun::start(
        &router,
        "parent-high",
        "parent",
        &model.model_hash,
        &[("reasoning", "high")],
        &[],
    )
    .await;
    let mut child = ClientRun::start(
        &router,
        "child-high",
        "child",
        &model.model_hash,
        &[],
        &[("x-parent-request-id", "parent-high")],
    )
    .await;
    assert_eq!(child.effort(), Some("high"));
    let changed = ClientRun::start(
        &router,
        "parent-low",
        "parent",
        &model.model_hash,
        &[("effort", "low")],
        &[],
    )
    .await;
    let latest = ClientRun::start(
        &router,
        "child-low",
        "new-child",
        &model.model_hash,
        &[],
        &[("x-parent-request-id", "parent-high")],
    )
    .await;
    assert_eq!(latest.effort(), Some("low"));
    assert_eq!(
        child
            .invoke(&router, &provider)
            .await
            .model
            .reasoning
            .effort
            .as_deref(),
        Some("high")
    );
    changed.finish(&router).await;
    parent.finish(&router).await;
    let continued = ClientRun::start(
        &router,
        "parent-next",
        "parent",
        &model.model_hash,
        &[],
        &[],
    )
    .await;
    assert_eq!(continued.effort(), Some("low"));
    let resumed = ClientRun::start(
        &router,
        "child-next",
        "child",
        &model.model_hash,
        &[],
        &[("x-parent-request-id", "parent-next")],
    )
    .await;
    assert_eq!(resumed.effort(), Some("high"));
    child.finish(&router).await;
    latest.finish(&router).await;
    continued.finish(&router).await;
    resumed.finish(&router).await;
}

#[tokio::test]
async fn child_overrides_nested_inheritance_and_model_boundaries_are_preserved() {
    let (_directory, store) = temp_store().await;
    let mut input = model_input();
    input.reasoning_effort = Some("medium".into());
    let model = store.create_model(&input).await.unwrap();
    input.model_id = "other-model".into();
    let other = store.create_model(&input).await.unwrap();
    let provider = FakeProvider::default();
    let (_router_directory, router) = router(store, provider.clone());
    let parent = ClientRun::start(
        &router,
        "parent",
        "parent",
        &model.model_hash,
        &[("reasoning", "high")],
        &[],
    )
    .await;
    let child = ClientRun::start(
        &router,
        "child-low",
        "child",
        &model.model_hash,
        &[("reasoning", "low")],
        &[("x-parent-request-id", "parent")],
    )
    .await;
    assert_eq!(child.effort(), Some("low"));
    let nested = ClientRun::start(
        &router,
        "nested",
        "nested",
        &model.model_hash,
        &[],
        &[
            ("x-parent-request-id", "child-low"),
            ("x-root-parent-request-id", "parent"),
        ],
    )
    .await;
    assert_eq!(nested.effort(), Some("low"));
    let mut disabled = ClientRun::start(
        &router,
        "disabled",
        "disabled",
        &model.model_hash,
        &[("thinking", "false")],
        &[("x-parent-request-id", "parent")],
    )
    .await;
    assert_eq!(disabled.effort(), None);
    assert_eq!(
        disabled
            .invoke(&router, &provider)
            .await
            .model
            .reasoning
            .enabled_override,
        Some(false)
    );
    let inherited_disabled = ClientRun::start(
        &router,
        "disabled-child",
        "disabled-child",
        &model.model_hash,
        &[],
        &[("x-parent-request-id", "disabled")],
    )
    .await;
    assert_eq!(inherited_disabled.effort(), None);
    let different = ClientRun::start(
        &router,
        "different",
        "different",
        &other.model_hash,
        &[],
        &[("x-parent-request-id", "parent")],
    )
    .await;
    assert_eq!(different.effort(), Some("medium"));
    let root_only = ClientRun::start(
        &router,
        "root-only",
        "root-only",
        &model.model_hash,
        &[],
        &[("x-root-parent-request-id", "parent")],
    )
    .await;
    assert_eq!(root_only.effort(), Some("high"));
    let missing = ClientRun::start(
        &router,
        "missing",
        "missing",
        &model.model_hash,
        &[],
        &[
            ("x-parent-request-id", "unknown"),
            ("x-root-parent-request-id", "parent"),
        ],
    )
    .await;
    assert_eq!(missing.effort(), Some("medium"));
    for run in [
        parent,
        child,
        nested,
        disabled,
        inherited_disabled,
        different,
        root_only,
        missing,
    ] {
        run.finish(&router).await;
    }
}

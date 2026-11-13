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

#[tokio::test]
async fn variant_slug_round_trip_preserves_routing_and_selection_parameters() {
    let (_directory, store) = temp_store().await;
    let mut input = model_input();
    input.context_window_tokens = Some(258_000);
    input.reasoning_effort = Some("medium".into());
    let model = store.create_model(&input).await.unwrap();
    let provider = FakeProvider::default();
    let (_router_directory, router) = router(store, provider.clone());

    let parent = ClientRun::start(
        &router,
        "parent-variant",
        "parent-conv",
        &model.model_hash,
        &[("context", "1m"), ("reasoning", "xhigh"), ("fast", "true")],
        &[],
    )
    .await;
    let expected_slug = format!("{}-1m-xhigh-fast", model.model_hash);
    assert_eq!(
        parent.ready.resolved_model.as_ref().unwrap().model_id,
        expected_slug
    );

    let mut child = ClientRun::start(
        &router,
        "child-variant",
        "child-conv",
        &expected_slug,
        &[],
        &[("x-parent-request-id", "parent-variant")],
    )
    .await;
    assert_eq!(
        child.ready.resolved_model.as_ref().unwrap().model_id,
        expected_slug
    );
    assert_eq!(child.effort(), Some("xhigh"));
    let child_request = child.invoke(&router, &provider).await;
    assert_eq!(child_request.model.model_id, model.model_hash);
    assert_eq!(
        child_request.model.reasoning.effort.as_deref(),
        Some("xhigh")
    );
    assert_eq!(child_request.model.context_window_tokens, Some(1_000_000));
    assert_eq!(
        child_request.model.latency,
        crate::model::ModelLatency::Fast
    );

    let custom_slug = format!("{}-258000-low", model.model_hash);
    let mut custom = ClientRun::start(
        &router,
        "custom-variant",
        "custom-conv",
        &custom_slug,
        &[],
        &[],
    )
    .await;
    assert_eq!(
        custom.ready.resolved_model.as_ref().unwrap().model_id,
        custom_slug
    );
    let custom_request = custom.invoke(&router, &provider).await;
    assert_eq!(custom_request.model.model_id, model.model_hash);
    assert_eq!(
        custom_request.model.reasoning.effort.as_deref(),
        Some("low")
    );
    assert_eq!(custom_request.model.context_window_tokens, Some(258_000));
    assert_eq!(
        custom_request.model.latency,
        crate::model::ModelLatency::Standard
    );

    let overridden = ClientRun::start(
        &router,
        "override-variant",
        "override-conv",
        &expected_slug,
        &[("reasoning", "low")],
        &[],
    )
    .await;
    assert_eq!(
        overridden.ready.resolved_model.as_ref().unwrap().model_id,
        format!("{}-1m-low-fast", model.model_hash)
    );

    let default_context_parent = ClientRun::start(
        &router,
        "default-context-parent",
        "default-context-parent-conv",
        &model.model_hash,
        &[],
        &[],
    )
    .await;
    let default_custom_slug = format!("{}-258000-medium", model.model_hash);
    assert_eq!(
        default_context_parent
            .ready
            .resolved_model
            .as_ref()
            .unwrap()
            .model_id,
        default_custom_slug
    );
    let mut default_context_child = ClientRun::start(
        &router,
        "default-context-child",
        "default-context-child-conv",
        &default_custom_slug,
        &[],
        &[],
    )
    .await;
    let default_context_child_request = default_context_child.invoke(&router, &provider).await;
    assert_eq!(
        default_context_child_request.model.context_window_tokens,
        Some(258_000)
    );

    let mut thinking_true = ClientRun::start(
        &router,
        "thinking-true-variant",
        "thinking-true-conv",
        &expected_slug,
        &[("thinking", "true")],
        &[],
    )
    .await;
    assert_eq!(thinking_true.effort(), Some("xhigh"));
    assert_eq!(
        thinking_true
            .ready
            .resolved_model
            .as_ref()
            .unwrap()
            .model_id,
        expected_slug
    );
    let thinking_true_request = thinking_true.invoke(&router, &provider).await;
    assert_eq!(
        thinking_true_request.model.reasoning.effort.as_deref(),
        Some("xhigh")
    );

    let mut thinking_false = ClientRun::start(
        &router,
        "thinking-false-variant",
        "thinking-false-conv",
        &expected_slug,
        &[("thinking", "false")],
        &[],
    )
    .await;
    assert_eq!(thinking_false.effort(), None);
    assert_eq!(
        thinking_false
            .ready
            .resolved_model
            .as_ref()
            .unwrap()
            .model_id,
        model.model_hash
    );
    let thinking_false_request = thinking_false.invoke(&router, &provider).await;
    assert!(!thinking_false_request.model.reasoning.enabled);
    assert_eq!(thinking_false_request.model.reasoning.effort, None);

    for run in [
        parent,
        child,
        custom,
        overridden,
        default_context_parent,
        default_context_child,
        thinking_true,
        thinking_false,
    ] {
        run.finish(&router).await;
    }
}

#[tokio::test]
async fn agent_run_and_unknown_variant_slugs_route_correctly() {
    let (_directory, store) = temp_store().await;
    let model = store.create_model(&model_input()).await.unwrap();
    let provider = FakeProvider::default();
    provider.push(vec![ModelEvent::Done(FinishReason::Stop)]);

    let directory = tempfile::tempdir().unwrap();
    let assets = PromptAssets::load(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("prompt/cursor")
            .as_path(),
    )
    .unwrap();
    let clients = NetworkClients::new(store.clone());
    let registry = TransportRegistry::new(
        store,
        Arc::new(provider.clone()),
        PromptCompiler::new(assets),
    );
    let proxy = CursorProxy::with_upstream(clients, "http://127.0.0.1:1");
    let knowledge = KnowledgeService::with_root(directory.path().join("rules")).unwrap();
    let router = router_with_proxy(registry.clone(), proxy, knowledge);

    let local_request_id = "agent-variant-1";
    let local_payload = agent::AgentClientMessage {
        message: Some(agent::agent_client_message::Message::RunRequest(
            agent::AgentRunRequest {
                conversation_id: Some("agent-conv".into()),
                conversation_state: Some(agent::ConversationStateStructure {
                    mode: Some(agent::AgentMode::Agent as i32),
                    ..Default::default()
                }),
                action: Some(agent::ConversationAction {
                    action: Some(agent::conversation_action::Action::UserMessageAction(
                        agent::UserMessageAction {
                            user_message: Some(agent::UserMessage {
                                text: "hello".into(),
                                message_id: "msg-1".into(),
                                mode: agent::AgentMode::Agent as i32,
                                ..Default::default()
                            }),
                            ..Default::default()
                        },
                    )),
                    ..Default::default()
                }),
                requested_model: Some(agent::RequestedModel {
                    model_id: format!("{}-1m-xhigh-fast", model.model_hash),
                    ..Default::default()
                }),
                ..Default::default()
            },
        )),
    }
    .encode_to_vec();
    append_binary(&router, local_request_id, 0, local_payload).await;
    assert!(registry.local(local_request_id).await.is_some());

    let resolved_model =
        crate::cursor::variant::resolve_cursor_model(&registry, "cursor-official-model-1m-xhigh")
            .await
            .unwrap();
    assert!(!resolved_model.local);
    assert_eq!(resolved_model.variant, None);
}

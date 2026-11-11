//! Exercises the client-owned Agent inference handshake and model stream.
use std::sync::{Arc, Mutex};

use super::{router_with_proxy, CursorProxy};
use crate::{
    cursor::{
        prompting::{PromptAssets, PromptCompiler},
        protocol::{
            connect,
            proto::{agent::v1 as agent, aiserver::v1 as ai, inference as pb},
        },
        services::knowledge::KnowledgeService,
        transport::TransportRegistry,
    },
    model::{
        ModelConfigInput, ModelInvocation, ModelRequest, ModelType, ProjectedContent,
        OPENAI_CHAT_ENDPOINT,
    },
    network::NetworkClients,
    provider::{FinishReason, ModelEvent, Provider, ProviderStream},
    store::Store,
};
use axum::{
    body::{Body, Bytes},
    http::{header, Request, StatusCode},
};
use futures_util::{stream, StreamExt};
use prost::Message;
use tokio_util::sync::CancellationToken;
use tower::ServiceExt;

#[tokio::test]
async fn client_loop_receives_ready_text_tool_call_and_completion() {
    let (_directory, store) = temp_store().await;
    let model = store.create_model(&model_input()).await.unwrap();
    let provider = FakeProvider::default();
    provider.push(vec![
        ModelEvent::Start {
            model_call_id: "invoke-1".into(),
        },
        ModelEvent::ThinkingStart,
        ModelEvent::ThinkingDelta("Checking the file".into()),
        ModelEvent::ThinkingEnd,
        ModelEvent::ThinkingSignature("signature-1".into()),
        ModelEvent::TextStart,
        ModelEvent::TextDelta("Let me check".into()),
        ModelEvent::TextEnd,
        ModelEvent::ToolCallStart {
            index: 0,
            call_id: "call-1".into(),
            name: "Read".into(),
        },
        ModelEvent::ToolCallArgumentsDelta {
            index: 0,
            delta: "{\"path\":\"a.rs\"}".into(),
        },
        ModelEvent::ToolCallEnd { index: 0 },
        ModelEvent::Done(FinishReason::ToolUse),
    ]);
    let (_router_directory, router) = router(store, provider.clone());
    let request_id = "inference-test";
    append(
        &router,
        request_id,
        0,
        pb::RunInferenceClientMessage {
            message: Some(pb::run_inference_client_message::Message::RunRequest(
                pb::RunInferenceRunRequest {
                    conversation_id: "conversation-test".into(),
                    requested_model: Some(pb::InferenceRequestedModel {
                        model_id: model.model_hash.clone(),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
            )),
        },
    )
    .await;
    let response = router
        .clone()
        .oneshot(
            Request::post("/aiserver.v1.InferenceService/RunInferenceSSE")
                .header(header::CONTENT_TYPE, "application/proto")
                .body(Body::from(
                    connect::encode_message(&agent::BidiRequestId {
                        request_id: request_id.into(),
                    })
                    .unwrap(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let mut stream = response.into_body().into_data_stream();
    let ready = next_message(&mut stream).await;
    let Some(pb::run_inference_server_message::Message::RunReady(ready)) = ready.message else {
        panic!("expected run_ready");
    };
    assert_eq!(ready.resolved_model.unwrap().model_id, model.model_hash);
    let metadata = ready.prompt_model_metadata.unwrap();
    assert!(!metadata.is_gpt5);
    assert_mode_metadata(&metadata);

    append(
        &router,
        request_id,
        1,
        pb::RunInferenceClientMessage {
            message: Some(pb::run_inference_client_message::Message::InvokeModel(
                pb::RunInferenceInvokeModel {
                    invocation_id: "invoke-1".into(),
                    request: Some(pb::InferenceStreamRequest {
                        messages: vec![pb::InferenceCoreMessage {
                            role: 1,
                            content: Some(pb::inference_core_message::Content::Text(
                                "Read a.rs".into(),
                            )),
                            ..Default::default()
                        }],
                        tools: vec![pb::InferenceAgentTool {
                            name: "Read".into(),
                            description: "Read a file".into(),
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

    let mut text = String::new();
    let mut tool = String::new();
    let mut completed_tool = None;
    let mut signature = None;
    let mut invocation_id = None;
    loop {
        let message = next_message(&mut stream).await;
        match message.message.unwrap() {
            pb::run_inference_server_message::Message::InvocationResponse(response) => {
                match response.response.unwrap().response.unwrap() {
                    pb::inference_stream_response::Response::TextPart(part) => {
                        text.push_str(&part.text)
                    }
                    pb::inference_stream_response::Response::ToolCallPart(part) => {
                        if part.is_complete {
                            completed_tool = Some(part.args);
                        } else if part.tool_name.is_empty() {
                            tool.push_str(&part.args);
                        }
                    }
                    pb::inference_stream_response::Response::ThinkingPart(part) => {
                        signature = signature.or(part.signature);
                    }
                    pb::inference_stream_response::Response::InvocationId(info) => {
                        invocation_id = Some(info.invocation_id);
                    }
                    _ => {}
                }
            }
            pb::run_inference_server_message::Message::InvocationEnd(end) => {
                assert_eq!(end.invocation_id, "invoke-1");
                assert!(end.error.is_none());
                break;
            }
            _ => {}
        }
    }
    assert_eq!(text, "Let me check");
    assert_eq!(tool, "{\"path\":\"a.rs\"}");
    assert_eq!(completed_tool.as_deref(), Some(tool.as_str()));
    assert_eq!(signature.as_deref(), Some("signature-1"));
    assert_eq!(invocation_id.as_deref(), Some("invoke-1"));
    let requests = provider.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].history.len(), 1);
    assert_eq!(requests[0].prompt.tools[0].name, "Read");
    assert!(matches!(
        &requests[0].history[0].content,
        ProjectedContent::Parts(_)
    ));

    append(
        &router,
        request_id,
        2,
        pb::RunInferenceClientMessage {
            message: Some(pb::run_inference_client_message::Message::FinishRun(
                pb::RunInferenceFinishRun { aborted: false },
            )),
        },
    )
    .await;
    let end = tokio::time::timeout(std::time::Duration::from_secs(3), stream.next())
        .await
        .expect("end frame timed out")
        .expect("inference stream ended before its end frame")
        .unwrap();
    assert_eq!(
        connect::decode_frames(&end).unwrap()[0].0,
        connect::END_STREAM_FLAG
    );
}

#[tokio::test]
async fn client_loop_inherits_run_reasoning_without_leaking_invocation_overrides() {
    let (_directory, store) = temp_store().await;
    let model = store.create_model(&model_input()).await.unwrap();
    let provider = FakeProvider::default();
    let (_router_directory, router) = router(store, provider.clone());
    for run_effort in ["high", "xhigh"] {
        let request_id = format!("reasoning-{run_effort}");
        append(
            &router,
            &request_id,
            0,
            pb::RunInferenceClientMessage {
                message: Some(pb::run_inference_client_message::Message::RunRequest(
                    pb::RunInferenceRunRequest {
                        conversation_id: "reasoning-conversation".into(),
                        requested_model: Some(pb::InferenceRequestedModel {
                            model_id: model.model_hash.clone(),
                            parameters: vec![pb::InferenceModelParameterValue {
                                id: "reasoning".into(),
                                value: run_effort.into(),
                            }],
                            ..Default::default()
                        }),
                        ..Default::default()
                    },
                )),
            },
        )
        .await;
        let response = router
            .clone()
            .oneshot(
                Request::post("/aiserver.v1.InferenceService/RunInferenceSSE")
                    .header(header::CONTENT_TYPE, "application/proto")
                    .body(Body::from(
                        connect::encode_message(&agent::BidiRequestId {
                            request_id: request_id.clone(),
                        })
                        .unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        let mut stream = response.into_body().into_data_stream();
        let ready = next_message(&mut stream).await;
        let Some(pb::run_inference_server_message::Message::RunReady(ready)) = ready.message else {
            panic!("expected run_ready");
        };
        assert_eq!(
            ready.resolved_model.unwrap().parameters[0].value,
            run_effort
        );
        for (index, (requested_model, expected)) in [
            (None, run_effort),
            (
                Some(pb::InferenceRequestedModel {
                    parameters: vec![pb::InferenceModelParameterValue {
                        id: "effort".into(),
                        value: "low".into(),
                    }],
                    ..Default::default()
                }),
                "low",
            ),
            (Some(pb::InferenceRequestedModel::default()), run_effort),
            (None, run_effort),
        ]
        .into_iter()
        .enumerate()
        {
            provider.push(vec![
                ModelEvent::TextStart,
                ModelEvent::TextDelta("ok".into()),
                ModelEvent::TextEnd,
                ModelEvent::Done(FinishReason::Stop),
            ]);
            let invocation_id = format!("{request_id}-{index}");
            append(
                &router,
                &request_id,
                index as i64 + 1,
                pb::RunInferenceClientMessage {
                    message: Some(pb::run_inference_client_message::Message::InvokeModel(
                        pb::RunInferenceInvokeModel {
                            invocation_id: invocation_id.clone(),
                            request: Some(pb::InferenceStreamRequest {
                                requested_model,
                                ..Default::default()
                            }),
                            ..Default::default()
                        },
                    )),
                },
            )
            .await;
            loop {
                let message = next_message(&mut stream).await;
                if let Some(pb::run_inference_server_message::Message::InvocationEnd(end)) =
                    message.message
                {
                    assert_eq!(end.invocation_id, invocation_id);
                    assert!(end.error.is_none());
                    break;
                }
            }
            let requests = provider.requests();
            let request = requests.last().unwrap();
            assert_eq!(request.model.reasoning.effort.as_deref(), Some(expected));
            assert!(request.model.reasoning.enabled);
        }
        append(
            &router,
            &request_id,
            5,
            pb::RunInferenceClientMessage {
                message: Some(pb::run_inference_client_message::Message::FinishRun(
                    pb::RunInferenceFinishRun { aborted: false },
                )),
            },
        )
        .await;
        let end = stream.next().await.unwrap().unwrap();
        assert_eq!(
            connect::decode_frames(&end).unwrap()[0].0,
            connect::END_STREAM_FLAG
        );
    }
}

#[tokio::test]
async fn run_inference_accepts_binary_append_and_arbitrary_non_uuid_conversation_ids() {
    let (_directory, store) = temp_store().await;
    let model = store.create_model(&model_input()).await.unwrap();
    for conversation_id in ["conv-1", "conversation-non-uuid", "PA"] {
        let provider = FakeProvider::default();
        provider.push(vec![
            ModelEvent::Start {
                model_call_id: "invoke-bin".into(),
            },
            ModelEvent::TextStart,
            ModelEvent::TextDelta(format!("ok:{conversation_id}")),
            ModelEvent::TextEnd,
            ModelEvent::Done(FinishReason::Stop),
        ]);
        let (_router_directory, router) = router(store.clone(), provider);
        let request_id = format!("inf-bin-{conversation_id}");
        let mut run_payload = pb::RunInferenceClientMessage {
            message: Some(pb::run_inference_client_message::Message::RunRequest(
                pb::RunInferenceRunRequest {
                    conversation_id: conversation_id.into(),
                    requested_model: Some(pb::InferenceRequestedModel {
                        model_id: model.model_hash.clone(),
                        ..Default::default()
                    }),
                    agent_mode: Some("plan".into()),
                },
            )),
        }
        .encode_to_vec();
        if conversation_id == "conv-1" {
            // Simulate Cursor 3.29 RunInferenceRunRequest bool capability fields (tags 17, 18, 25)
            // embedded inside the top-level field 1 RunRequest bytes by re-encoding with tag 1 length.
            let inner_plus_flags = {
                let mut inner = pb::RunInferenceRunRequest {
                    conversation_id: conversation_id.into(),
                    requested_model: Some(pb::InferenceRequestedModel {
                        model_id: model.model_hash.clone(),
                        ..Default::default()
                    }),
                    agent_mode: Some("plan".into()),
                }
                .encode_to_vec();
                // tag 17 varint = 1, tag 18 varint = 1, tag 25 varint = 1
                inner.extend_from_slice(&[0x88, 0x01, 0x01, 0x90, 0x01, 0x01, 0xc8, 0x01, 0x01]);
                let mut wrapped = Vec::new();
                prost::encoding::bytes::encode(1, &inner, &mut wrapped);
                wrapped
            };
            run_payload = inner_plus_flags;
        }
        append_binary(&router, &request_id, 0, run_payload).await;

        let response = router
            .clone()
            .oneshot(
                Request::post("/aiserver.v1.InferenceService/RunInferenceSSE")
                    .header(header::CONTENT_TYPE, "application/proto")
                    .body(Body::from(
                        connect::encode_message(&agent::BidiRequestId {
                            request_id: request_id.clone(),
                        })
                        .unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let mut stream = response.into_body().into_data_stream();
        let ready = next_message(&mut stream).await;
        let Some(pb::run_inference_server_message::Message::RunReady(ready)) = ready.message else {
            panic!("expected run_ready for {conversation_id}");
        };
        assert_mode_metadata(&ready.prompt_model_metadata.unwrap());

        append_binary(
            &router,
            &request_id,
            1,
            pb::RunInferenceClientMessage {
                message: Some(pb::run_inference_client_message::Message::InvokeModel(
                    pb::RunInferenceInvokeModel {
                        invocation_id: "invoke-bin".into(),
                        request: Some(pb::InferenceStreamRequest {
                            messages: vec![pb::InferenceCoreMessage {
                                role: 1,
                                content: Some(pb::inference_core_message::Content::Text(
                                    "hello".into(),
                                )),
                                ..Default::default()
                            }],
                            ..Default::default()
                        }),
                        ..Default::default()
                    },
                )),
            }
            .encode_to_vec(),
        )
        .await;

        let mut text = String::new();
        loop {
            let message = next_message(&mut stream).await;
            match message.message.unwrap() {
                pb::run_inference_server_message::Message::InvocationResponse(resp) => {
                    if let Some(pb::inference_stream_response::Response::TextPart(part)) =
                        resp.response.unwrap().response
                    {
                        text.push_str(&part.text);
                    }
                }
                pb::run_inference_server_message::Message::InvocationEnd(end) => {
                    assert!(end.error.is_none());
                    break;
                }
                _ => {}
            }
        }
        assert_eq!(text, format!("ok:{conversation_id}"));

        append_binary(
            &router,
            &request_id,
            2,
            pb::RunInferenceClientMessage {
                message: Some(pb::run_inference_client_message::Message::FinishRun(
                    pb::RunInferenceFinishRun { aborted: false },
                )),
            }
            .encode_to_vec(),
        )
        .await;
        let end = tokio::time::timeout(std::time::Duration::from_secs(3), stream.next())
            .await
            .expect("end frame timed out")
            .unwrap()
            .unwrap();
        assert_eq!(
            connect::decode_frames(&end).unwrap()[0].0,
            connect::END_STREAM_FLAG
        );
    }
}

#[tokio::test]
async fn confusing_minimal_agent_run_requests_are_not_misrouted_to_inference() {
    let (_directory, store) = temp_store().await;
    let model = store.create_model(&model_input()).await.unwrap();

    let agent_with_action = minimal_agent_run(&model.model_hash, true);
    let agent_state_only = minimal_agent_run(&model.model_hash, false);
    let agent_printable_state = agent::AgentClientMessage {
        message: Some(agent::agent_client_message::Message::RunRequest(
            agent::AgentRunRequest {
                conversation_state: Some(agent::ConversationStateStructure {
                    previous_workspace_uris: vec!["x".repeat(32)],
                    ..Default::default()
                }),
                model_details: Some(agent::ModelDetails {
                    model_id: model.model_hash.clone(),
                    ..Default::default()
                }),
                ..Default::default()
            },
        )),
    };

    for (label, message, use_binary) in [
        ("action-hex", agent_with_action.clone(), false),
        ("action-bin", agent_with_action, true),
        ("state-only-hex", agent_state_only.clone(), false),
        ("state-only-bin", agent_state_only, true),
        ("printable-state-bin", agent_printable_state, true),
    ] {
        let provider = FakeProvider::default();
        provider.push(vec![
            ModelEvent::Start {
                model_call_id: format!("call-{label}"),
            },
            ModelEvent::TextStart,
            ModelEvent::TextDelta(format!("agent:{label}")),
            ModelEvent::TextEnd,
            ModelEvent::Done(FinishReason::Stop),
        ]);
        let (_router_directory, router) = router(store.clone(), provider.clone());
        let request_id = format!("agent-min-{label}");
        let raw = message.encode_to_vec();
        if use_binary {
            append_binary(&router, &request_id, 0, raw).await;
        } else {
            append_raw(&router, &request_id, 0, raw).await;
        }

        let sse = router
            .clone()
            .oneshot(
                Request::post("/agent.v1.AgentService/RunSSE")
                    .header(header::CONTENT_TYPE, "application/proto")
                    .body(Body::from(
                        connect::encode_message(&agent::BidiRequestId {
                            request_id: request_id.clone(),
                        })
                        .unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            sse.status(),
            StatusCode::OK,
            "case {label} must route to AgentService"
        );
        let text = collect_agent_text(&router, &request_id, 1, use_binary, sse).await;
        assert_eq!(text, format!("agent:{label}"), "case {label}");
        assert_eq!(provider.requests().len(), 1, "case {label}");
    }
}

#[tokio::test]
async fn existing_routes_honor_followup_frames_and_reject_empty_payload() {
    let (_directory, store) = temp_store().await;
    let model = store.create_model(&model_input()).await.unwrap();

    // 1. Existing RunInference route rejects empty payload explicitly and rejects non-inference bytes
    //    without falling back to AgentService; follow-ups work across mixed binary & hex frames.
    {
        let provider = FakeProvider::default();
        provider.push(vec![
            ModelEvent::Start {
                model_call_id: "invoke-mix".into(),
            },
            ModelEvent::TextStart,
            ModelEvent::TextDelta("mixed-ok".into()),
            ModelEvent::TextEnd,
            ModelEvent::Done(FinishReason::Stop),
        ]);
        let (_router_directory, router) = router(store.clone(), provider);
        let request_id = "inf-existing-route";
        append_binary(
            &router,
            request_id,
            0,
            pb::RunInferenceClientMessage {
                message: Some(pb::run_inference_client_message::Message::RunRequest(
                    pb::RunInferenceRunRequest {
                        conversation_id: "conv-existing".into(),
                        requested_model: Some(pb::InferenceRequestedModel {
                            model_id: model.model_hash.clone(),
                            ..Default::default()
                        }),
                        ..Default::default()
                    },
                )),
            }
            .encode_to_vec(),
        )
        .await;

        let empty = post_bidi_append(
            &router,
            ai::BidiAppendRequest {
                request_id: Some(ai::BidiRequestId {
                    request_id: request_id.into(),
                }),
                append_seqno: 1,
                ..Default::default()
            },
        )
        .await;
        assert_eq!(empty.status(), StatusCode::BAD_REQUEST);
        let empty_body = axum::body::to_bytes(empty.into_body(), 4096).await.unwrap();
        let empty_text = std::str::from_utf8(&empty_body).unwrap();
        assert!(empty_text.contains("BidiAppend contains no AgentClientMessage"));
        assert!(!empty_text.contains("protobuf decode error"));

        let response = router
            .clone()
            .oneshot(
                Request::post("/aiserver.v1.InferenceService/RunInferenceSSE")
                    .header(header::CONTENT_TYPE, "application/proto")
                    .body(Body::from(
                        connect::encode_message(&agent::BidiRequestId {
                            request_id: request_id.into(),
                        })
                        .unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        let mut stream = response.into_body().into_data_stream();
        let _ready = next_message(&mut stream).await;

        append(
            &router,
            request_id,
            1,
            pb::RunInferenceClientMessage {
                message: Some(pb::run_inference_client_message::Message::InvokeModel(
                    pb::RunInferenceInvokeModel {
                        invocation_id: "invoke-mix".into(),
                        request: Some(pb::InferenceStreamRequest {
                            messages: vec![pb::InferenceCoreMessage {
                                role: 1,
                                content: Some(pb::inference_core_message::Content::Text(
                                    "hi".into(),
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
        loop {
            let msg = next_message(&mut stream).await;
            if matches!(
                msg.message,
                Some(pb::run_inference_server_message::Message::InvocationEnd(_))
            ) {
                break;
            }
        }
        append_binary(
            &router,
            request_id,
            2,
            pb::RunInferenceClientMessage {
                message: Some(pb::run_inference_client_message::Message::FinishRun(
                    pb::RunInferenceFinishRun { aborted: false },
                )),
            }
            .encode_to_vec(),
        )
        .await;
        let _ = next_message_raw(&mut stream).await;
    }

    // 2. Active local AgentService route keeps follow-up frames on AgentService even if the
    //    follow-up payload decodes as a RunInferenceRunRequest (tested in both hex and binary).
    for use_binary in [false, true] {
        let provider = FakeProvider::default();
        provider.push(vec![
            ModelEvent::Start {
                model_call_id: "call-active-agent".into(),
            },
            ModelEvent::TextStart,
            ModelEvent::TextDelta("agent-kept-route".into()),
            ModelEvent::TextEnd,
            ModelEvent::Done(FinishReason::Stop),
        ]);
        let (_router_directory, router) = router(store.clone(), provider);
        let request_id = format!("active-agent-{use_binary}");
        let start = minimal_agent_run(&model.model_hash, true);
        if use_binary {
            append_binary(&router, &request_id, 0, start.encode_to_vec()).await;
        } else {
            append_raw(&router, &request_id, 0, start.encode_to_vec()).await;
        }
        let sse = router
            .clone()
            .oneshot(
                Request::post("/agent.v1.AgentService/RunSSE")
                    .header(header::CONTENT_TYPE, "application/proto")
                    .body(Body::from(
                        connect::encode_message(&agent::BidiRequestId {
                            request_id: request_id.clone(),
                        })
                        .unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(sse.status(), StatusCode::OK);

        // Send a valid Agent heartbeat in binary while active, then a deceptive RunInferenceRunRequest
        // payload (seqno 2) which fails AgentClientMessage::decode with invalid wire data (not
        // hijacked into starting InferenceService!).
        append_binary(
            &router,
            &request_id,
            1,
            agent::AgentClientMessage {
                message: Some(agent::agent_client_message::Message::ClientHeartbeat(
                    agent::ClientHeartbeat {},
                )),
            }
            .encode_to_vec(),
        )
        .await;

        let deceptive = pb::RunInferenceClientMessage {
            message: Some(pb::run_inference_client_message::Message::RunRequest(
                pb::RunInferenceRunRequest {
                    conversation_id: "conv-hijack-attempt".into(),
                    requested_model: Some(pb::InferenceRequestedModel {
                        model_id: model.model_hash.clone(),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
            )),
        }
        .encode_to_vec();
        assert!(
            crate::cursor::inference::starts_run_inference(&deceptive),
            "deceptive payload would start RunInference if the route were not active"
        );
        let req = ai::BidiAppendRequest {
            request_id: Some(ai::BidiRequestId {
                request_id: request_id.clone(),
            }),
            data: if use_binary {
                String::new()
            } else {
                hex::encode(&deceptive)
            },
            data_binary: if use_binary { deceptive } else { Vec::new() },
            append_seqno: 2,
        };
        let hijack_resp = post_bidi_append(&router, req).await;
        assert_eq!(
            hijack_resp.status(),
            StatusCode::BAD_REQUEST,
            "active AgentService route must decode follow-ups as AgentClientMessage, not start RunInference"
        );

        // Also test a payload that satisfies BOTH AgentClientMessage::decode and starts_run_inference:
        // active AgentService route must route it to bidi::append (catching conflicting conversation_id)
        // instead of creating a RunInference route.
        let dual_decodable = pb::RunInferenceClientMessage {
            message: Some(pb::run_inference_client_message::Message::RunRequest(
                pb::RunInferenceRunRequest {
                    conversation_id: "PA".into(),
                    requested_model: Some(pb::InferenceRequestedModel {
                        model_id: model.model_hash.clone(),
                        ..Default::default()
                    }),
                    agent_mode: Some("plan".into()),
                },
            )),
        }
        .encode_to_vec();
        assert!(agent::AgentClientMessage::decode(dual_decodable.as_slice()).is_ok());
        assert!(crate::cursor::inference::starts_run_inference(
            &dual_decodable
        ));
        let dual_req = ai::BidiAppendRequest {
            request_id: Some(ai::BidiRequestId {
                request_id: request_id.clone(),
            }),
            data: if use_binary {
                String::new()
            } else {
                hex::encode(&dual_decodable)
            },
            data_binary: if use_binary {
                dual_decodable
            } else {
                Vec::new()
            },
            append_seqno: 2,
        };
        let dual_resp = post_bidi_append(&router, dual_req).await;
        assert_eq!(dual_resp.status(), StatusCode::BAD_REQUEST);
        let dual_body = axum::body::to_bytes(dual_resp.into_body(), 4096)
            .await
            .unwrap();
        assert!(
            std::str::from_utf8(&dual_body)
                .unwrap()
                .contains("conflicting conversation ids"),
            "dual-decodable follow-up must stay on active AgentService transport"
        );

        let text = collect_agent_text(&router, &request_id, 2, use_binary, sse).await;
        assert_eq!(text, "agent-kept-route");
    }

    // 3. Active upstream AgentService route forwards deceptive RunInference-looking follow-up to
    //    upstream without starting a local RunInference route.
    {
        let upstream_calls = Arc::new(Mutex::new(Vec::<Vec<u8>>::new()));
        let recorded = upstream_calls.clone();
        let mock_upstream = axum::Router::new().route(
            "/aiserver.v1.BidiService/BidiAppend",
            axum::routing::post(move |body: Bytes| {
                let recorded = recorded.clone();
                async move {
                    recorded.lock().unwrap().push(body.to_vec());
                    StatusCode::OK
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, mock_upstream).await;
        });

        let directory = tempfile::tempdir().unwrap();
        let assets = PromptAssets::load(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("prompt/cursor")
                .as_path(),
        )
        .unwrap();
        let clients = NetworkClients::new(store.clone());
        let registry = TransportRegistry::new(
            store.clone(),
            Arc::new(FakeProvider::default()),
            PromptCompiler::new(assets),
        );
        let proxy = CursorProxy::with_upstream(clients, format!("http://{addr}"));
        let knowledge = KnowledgeService::with_root(directory.path().join("rules")).unwrap();
        let router = router_with_proxy(registry.clone(), proxy, knowledge);

        let request_id = "upstream-agent-1";
        let initial = agent::AgentClientMessage {
            message: Some(agent::agent_client_message::Message::RunRequest(
                agent::AgentRunRequest {
                    conversation_state: Some(agent::ConversationStateStructure {
                        mode: Some(agent::AgentMode::Agent as i32),
                        ..Default::default()
                    }),
                    model_details: Some(agent::ModelDetails {
                        model_id: "cursor-official-model".into(),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
            )),
        }
        .encode_to_vec();
        append_binary(&router, request_id, 0, initial).await;
        assert!(registry.upstream(request_id).await);

        let dual_followup = pb::RunInferenceClientMessage {
            message: Some(pb::run_inference_client_message::Message::RunRequest(
                pb::RunInferenceRunRequest {
                    conversation_id: "PA".into(),
                    requested_model: Some(pb::InferenceRequestedModel {
                        model_id: "cursor-official-model".into(),
                        ..Default::default()
                    }),
                    agent_mode: Some("plan".into()),
                },
            )),
        }
        .encode_to_vec();
        assert!(agent::AgentClientMessage::decode(dual_followup.as_slice()).is_ok());
        assert!(
            crate::cursor::inference::starts_run_inference(&dual_followup),
            "dual-decodable payload would start RunInference if upstream route were not active"
        );
        append_binary(&router, request_id, 1, dual_followup).await;
        assert_eq!(upstream_calls.lock().unwrap().len(), 2);

        let deceptive_followup = pb::RunInferenceClientMessage {
            message: Some(pb::run_inference_client_message::Message::RunRequest(
                pb::RunInferenceRunRequest {
                    conversation_id: "conv-upstream-followup".into(),
                    requested_model: Some(pb::InferenceRequestedModel {
                        model_id: model.model_hash.clone(),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
            )),
        }
        .encode_to_vec();
        assert!(agent::AgentClientMessage::decode(deceptive_followup.as_slice()).is_err());
        assert!(
            crate::cursor::inference::starts_run_inference(&deceptive_followup),
            "deceptive payload would start RunInference if upstream route were not active"
        );
        append_binary(&router, request_id, 2, deceptive_followup).await;
        assert_eq!(upstream_calls.lock().unwrap().len(), 3);

        server.abort();
    }
}

fn assert_mode_metadata(metadata: &pb::RunInferencePromptModelMetadata) {
    assert_eq!(metadata.use_new_plan_mode_prompts, Some(true));
    assert_eq!(
        metadata.ask_question_config,
        Some(pb::RunInferenceAskQuestionConfig {
            tool_name: "AskQuestion".into(),
            auto_reject_first: false,
        })
    );
    assert_eq!(
        metadata.agent_mode_configs,
        vec![
            pb::RunInferenceAgentModeConfig {
                mode_id: "agent".into(),
                enable_ask_question_tool: true,
                switch_mode_tool_config: Some(pb::RunInferenceSwitchModeToolConfig {
                    target_modes: vec!["plan".into(), "debug".into()],
                }),
            },
            pb::RunInferenceAgentModeConfig {
                mode_id: "chat".into(),
                enable_ask_question_tool: true,
                switch_mode_tool_config: None,
            },
            pb::RunInferenceAgentModeConfig {
                mode_id: "plan".into(),
                enable_ask_question_tool: true,
                switch_mode_tool_config: Some(pb::RunInferenceSwitchModeToolConfig {
                    target_modes: vec!["agent".into()],
                }),
            },
            pb::RunInferenceAgentModeConfig {
                mode_id: "debug".into(),
                enable_ask_question_tool: true,
                switch_mode_tool_config: Some(pb::RunInferenceSwitchModeToolConfig {
                    target_modes: vec!["agent".into(), "plan".into()],
                }),
            },
            pb::RunInferenceAgentModeConfig {
                mode_id: "triage".into(),
                enable_ask_question_tool: true,
                switch_mode_tool_config: None,
            },
            pb::RunInferenceAgentModeConfig {
                mode_id: "multitask".into(),
                enable_ask_question_tool: true,
                switch_mode_tool_config: Some(pb::RunInferenceSwitchModeToolConfig {
                    target_modes: vec!["agent".into(), "plan".into(), "debug".into()],
                }),
            },
        ]
    );
}

fn minimal_agent_run(model_id: &str, with_action: bool) -> agent::AgentClientMessage {
    agent::AgentClientMessage {
        message: Some(agent::agent_client_message::Message::RunRequest(
            agent::AgentRunRequest {
                conversation_state: Some(agent::ConversationStateStructure {
                    mode: Some(agent::AgentMode::Agent as i32),
                    ..Default::default()
                }),
                action: with_action.then(|| agent::ConversationAction {
                    action: Some(agent::conversation_action::Action::UserMessageAction(
                        agent::UserMessageAction {
                            user_message: Some(agent::UserMessage {
                                text: "hello".into(),
                                message_id: "msg-min".into(),
                                mode: agent::AgentMode::Agent as i32,
                                ..Default::default()
                            }),
                            ..Default::default()
                        },
                    )),
                    ..Default::default()
                }),
                model_details: Some(agent::ModelDetails {
                    model_id: model_id.into(),
                    ..Default::default()
                }),
                conversation_id: with_action.then(|| "conv-agent".into()),
                ..Default::default()
            },
        )),
    }
}

async fn append_binary(router: &axum::Router, request_id: &str, seqno: i64, bytes: Vec<u8>) {
    let response = post_bidi_append(
        router,
        ai::BidiAppendRequest {
            request_id: Some(ai::BidiRequestId {
                request_id: request_id.into(),
            }),
            data_binary: bytes,
            append_seqno: seqno,
            ..Default::default()
        },
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
}

async fn append_raw(router: &axum::Router, request_id: &str, seqno: i64, bytes: Vec<u8>) {
    let response = post_bidi_append(
        router,
        ai::BidiAppendRequest {
            request_id: Some(ai::BidiRequestId {
                request_id: request_id.into(),
            }),
            data: hex::encode(bytes),
            append_seqno: seqno,
            ..Default::default()
        },
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
}

async fn post_bidi_append(
    router: &axum::Router,
    request: ai::BidiAppendRequest,
) -> axum::response::Response {
    router
        .clone()
        .oneshot(
            Request::post("/aiserver.v1.BidiService/BidiAppend")
                .header(header::CONTENT_TYPE, "application/proto")
                .body(Body::from(request.encode_to_vec()))
                .unwrap(),
        )
        .await
        .unwrap()
}

async fn collect_agent_text(
    router: &axum::Router,
    request_id: &str,
    mut next_seqno: i64,
    use_binary: bool,
    response: axum::response::Response,
) -> String {
    let mut stream = response.into_body().into_data_stream();
    let mut text = String::new();
    while let Some(chunk) = tokio::time::timeout(std::time::Duration::from_secs(5), stream.next())
        .await
        .expect("agent frame timed out")
    {
        let bytes = chunk.unwrap();
        for (flags, payload) in connect::decode_frames(&bytes).unwrap() {
            if flags & connect::END_STREAM_FLAG != 0 {
                return text;
            }
            let message = agent::AgentServerMessage::decode(payload).unwrap();
            match message.message {
                Some(agent::agent_server_message::Message::InteractionUpdate(update)) => {
                    if let Some(agent::interaction_update::Message::TextDelta(delta)) =
                        update.message
                    {
                        text.push_str(&delta.text);
                    }
                }
                Some(agent::agent_server_message::Message::KvServerMessage(kv)) => {
                    let reply = match kv.message {
                        Some(agent::kv_server_message::Message::GetBlobArgs(_)) => {
                            agent::kv_client_message::Message::GetBlobResult(agent::GetBlobResult {
                                blob_data: None,
                                error: None,
                            })
                        }
                        _ => {
                            agent::kv_client_message::Message::SetBlobResult(agent::SetBlobResult {
                                error: None,
                            })
                        }
                    };
                    let ack = agent::AgentClientMessage {
                        message: Some(agent::agent_client_message::Message::KvClientMessage(
                            agent::KvClientMessage {
                                id: kv.id,
                                message: Some(reply),
                            },
                        )),
                    }
                    .encode_to_vec();
                    if use_binary {
                        append_binary(router, request_id, next_seqno, ack).await;
                    } else {
                        append_raw(router, request_id, next_seqno, ack).await;
                    }
                    next_seqno += 1;
                }
                Some(agent::agent_server_message::Message::ExecServerMessage(exec)) => {
                    let close = agent::AgentClientMessage {
                        message: Some(
                            agent::agent_client_message::Message::ExecClientControlMessage(
                                agent::ExecClientControlMessage {
                                    message: Some(
                                        agent::exec_client_control_message::Message::StreamClose(
                                            agent::ExecClientStreamClose { id: exec.id },
                                        ),
                                    ),
                                },
                            ),
                        ),
                    }
                    .encode_to_vec();
                    let result = agent::AgentClientMessage {
                        message: Some(agent::agent_client_message::Message::ExecClientMessage(
                            agent::ExecClientMessage {
                                id: exec.id,
                                message: Some(
                                    agent::exec_client_message::Message::RequestContextResult(
                                        agent::RequestContextResult {
                                            result: Some(
                                                agent::request_context_result::Result::Success(
                                                    agent::RequestContextSuccess {
                                                        request_context: Some(
                                                            agent::RequestContext::default(),
                                                        ),
                                                        ..Default::default()
                                                    },
                                                ),
                                            ),
                                        },
                                    ),
                                ),
                                ..Default::default()
                            },
                        )),
                    }
                    .encode_to_vec();
                    for msg in [close, result] {
                        if use_binary {
                            append_binary(router, request_id, next_seqno, msg).await;
                        } else {
                            append_raw(router, request_id, next_seqno, msg).await;
                        }
                        next_seqno += 1;
                    }
                }
                _ => {}
            }
        }
    }
    text
}

async fn next_message_raw<S>(stream: &mut S) -> Bytes
where
    S: futures_util::Stream<Item = Result<Bytes, axum::Error>> + Unpin,
{
    tokio::time::timeout(std::time::Duration::from_secs(3), stream.next())
        .await
        .expect("end frame timed out")
        .expect("inference stream ended before its end frame")
        .unwrap()
}

async fn append(
    router: &axum::Router,
    request_id: &str,
    seqno: i64,
    message: pb::RunInferenceClientMessage,
) {
    let request = ai::BidiAppendRequest {
        request_id: Some(ai::BidiRequestId {
            request_id: request_id.into(),
        }),
        data: hex::encode(message.encode_to_vec()),
        append_seqno: seqno,
        ..Default::default()
    };
    let response = router
        .clone()
        .oneshot(
            Request::post("/aiserver.v1.BidiService/BidiAppend")
                .header(header::CONTENT_TYPE, "application/proto")
                .body(Body::from(request.encode_to_vec()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}

async fn next_message<S>(stream: &mut S) -> pb::RunInferenceServerMessage
where
    S: futures_util::Stream<Item = Result<Bytes, axum::Error>> + Unpin,
{
    let frame = tokio::time::timeout(std::time::Duration::from_secs(3), stream.next())
        .await
        .expect("inference frame timed out")
        .expect("inference stream ended")
        .unwrap();
    let (flags, bytes) = connect::decode_frames(&frame).unwrap().pop().unwrap();
    assert_eq!(flags, 0);
    pb::RunInferenceServerMessage::decode(bytes).unwrap()
}

fn router(store: crate::store::Store, provider: FakeProvider) -> (tempfile::TempDir, axum::Router) {
    let directory = tempfile::tempdir().unwrap();
    let assets = PromptAssets::load(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("prompt/cursor")
            .as_path(),
    )
    .unwrap();
    let clients = NetworkClients::new(store.clone());
    let registry = TransportRegistry::new(store, Arc::new(provider), PromptCompiler::new(assets));
    let proxy = CursorProxy::cursor(clients);
    let knowledge = KnowledgeService::with_root(directory.path().join("rules")).unwrap();
    (directory, router_with_proxy(registry, proxy, knowledge))
}

async fn temp_store() -> (tempfile::TempDir, Store) {
    let directory = tempfile::tempdir().unwrap();
    let url = format!("sqlite://{}", directory.path().join("test.db").display());
    let store = Store::connect(&url).await.unwrap();
    (directory, store)
}

#[derive(Clone, Default)]
struct FakeProvider {
    requests: Arc<Mutex<Vec<ModelRequest>>>,
    events: Arc<Mutex<Vec<ModelEvent>>>,
}

impl FakeProvider {
    fn push(&self, events: Vec<ModelEvent>) {
        *self.events.lock().unwrap() = events;
    }

    fn requests(&self) -> Vec<ModelRequest> {
        self.requests.lock().unwrap().clone()
    }
}

impl Provider for FakeProvider {
    fn stream(
        &self,
        invocation: ModelInvocation,
        _cancellation: CancellationToken,
    ) -> ProviderStream {
        self.requests.lock().unwrap().push(invocation.request);
        let events = std::mem::take(&mut *self.events.lock().unwrap());
        Box::pin(stream::iter(events.into_iter().map(Ok)))
    }
}

fn model_input() -> ModelConfigInput {
    ModelConfigInput {
        sort_order: 1,
        display_name: "Test model".into(),
        group_name: None,
        model_type: ModelType::OpenAi,
        base_url: "https://example.com/v1".into(),
        use_full_url: false,
        api_key: "test-key".into(),
        tooltip_data: "Test model".into(),
        model_id: "test-model".into(),
        reasoning_effort: None,
        openai_endpoint: OPENAI_CHAT_ENDPOINT.into(),
        openai_extra_params_enabled: false,
        openai_extra_params: serde_json::json!({}),
        custom_headers_enabled: false,
        custom_headers: serde_json::json!({}),
        anthropic_extra_params_enabled: false,
        anthropic_extra_params: serde_json::json!({}),
        context_window_tokens: None,
        max_completion_tokens: None,
        anthropic_max_tokens: None,
        anthropic_thinking_effort: None,
        thinking_budget_tokens: None,
    }
}

//! Exercises context changes, retries, and checkpoint recovery through the Cursor transport.
#[path = "support/fake_provider.rs"]
mod fake_provider;
#[path = "support/fixtures.rs"]
mod fixtures;

use std::{collections::HashMap, path::Path, sync::Arc};

use cursor_server::{
    cursor::{
        prompting::{PromptAssets, PromptCompiler},
        protocol::{connect, proto::agent::v1 as pb},
        TransportCommand, TransportRegistry,
    },
    model::{ContentPart, ModelRequest, ProjectedContent, ProjectedMessage},
    provider::{FinishReason, ModelEvent},
    store::Store,
};
use prost::Message;

fn registry(
    store: Store,
    provider: &fake_provider::FakeProvider,
    rules: &Path,
) -> TransportRegistry {
    let assets =
        PromptAssets::load(&Path::new(env!("CARGO_MANIFEST_DIR")).join("prompt/cursor")).unwrap();
    TransportRegistry::with_local_rules(
        store,
        Arc::new(provider.clone()),
        PromptCompiler::new(assets),
        rules.to_path_buf(),
    )
}

async fn turn(
    registry: &TransportRegistry,
    provider: &fake_provider::FakeProvider,
    transport_id: &str,
    input_id: &str,
    state: Option<pb::ConversationStateStructure>,
    blobs: &mut HashMap<Vec<u8>, Vec<u8>>,
) -> pb::ConversationStateStructure {
    provider.push(vec![
        ModelEvent::Start {
            model_call_id: transport_id.into(),
        },
        ModelEvent::TextStart,
        ModelEvent::TextDelta("answer".into()),
        ModelEvent::TextEnd,
        ModelEvent::Done(FinishReason::Stop),
    ]);
    let handle = registry.get_or_create(transport_id).await.unwrap();
    let mut output = handle.subscribe();
    let request = pb::AgentRunRequest {
        action: Some(pb::ConversationAction {
            action: Some(pb::conversation_action::Action::UserMessageAction(
                pb::UserMessageAction {
                    user_message: Some(pb::UserMessage {
                        text: format!("query {input_id}"),
                        message_id: input_id.into(),
                        mode: pb::AgentMode::Agent as i32,
                        ..Default::default()
                    }),
                    ..Default::default()
                },
            )),
            ..Default::default()
        }),
        conversation_state: state,
        conversation_id: Some("context-history".into()),
        run_id: Some(transport_id.into()),
        requested_model: Some(pb::RequestedModel {
            model_id: "test-model".into(),
            ..Default::default()
        }),
        ..Default::default()
    };
    handle
        .command(TransportCommand::Append {
            seqno: 0,
            message: Box::new(pb::AgentClientMessage {
                message: Some(pb::agent_client_message::Message::RunRequest(request)),
            }),
        })
        .await
        .unwrap();
    let mut seqno = 1;
    let mut checkpoint = None;
    loop {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(10), output.recv())
            .await
            .expect("turn finishes")
            .unwrap();
        for (flags, payload) in connect::decode_frames(&frame).unwrap() {
            if flags & connect::END_STREAM_FLAG != 0 {
                let end: serde_json::Value = serde_json::from_slice(&payload).unwrap();
                assert!(end.get("error").is_none(), "turn failed: {end}");
                return checkpoint.expect("completed turn publishes a checkpoint");
            }
            match pb::AgentServerMessage::decode(payload).unwrap().message {
                Some(pb::agent_server_message::Message::ConversationCheckpointUpdate(state)) => {
                    checkpoint = Some(state)
                }
                Some(pb::agent_server_message::Message::KvServerMessage(kv)) => {
                    let result = match kv.message.unwrap() {
                        pb::kv_server_message::Message::SetBlobArgs(args) => {
                            blobs.insert(args.blob_id, args.blob_data);
                            pb::kv_client_message::Message::SetBlobResult(pb::SetBlobResult {
                                error: None,
                            })
                        }
                        pb::kv_server_message::Message::GetBlobArgs(args) => {
                            let data = blobs
                                .get(&args.blob_id)
                                .expect("client retained checkpoint dependency")
                                .clone();
                            pb::kv_client_message::Message::GetBlobResult(pb::GetBlobResult {
                                blob_data: Some(data),
                                error: None,
                            })
                        }
                    };
                    handle
                        .command(TransportCommand::Append {
                            seqno,
                            message: Box::new(pb::AgentClientMessage {
                                message: Some(pb::agent_client_message::Message::KvClientMessage(
                                    pb::KvClientMessage {
                                        id: kv.id,
                                        message: Some(result),
                                    },
                                )),
                            }),
                        })
                        .await
                        .unwrap();
                    seqno += 1;
                }
                _ => {}
            }
        }
    }
}

fn contexts(request: &ModelRequest) -> Vec<&ProjectedMessage> {
    request
        .history
        .iter()
        .filter(|message| message.message_id.starts_with("request-context:"))
        .collect()
}

fn text(message: &ProjectedMessage) -> &str {
    let ProjectedContent::Parts(parts) = &message.content else {
        panic!("context must contain text parts")
    };
    let [ContentPart::Text { text }] = parts.as_slice() else {
        panic!("context must contain exactly one text part")
    };
    text
}

fn assert_prefix(first: &ModelRequest, next: &ModelRequest) {
    assert_eq!(
        first.prompt, next.prompt,
        "system instructions and tools stay stable"
    );
    assert!(next.history.len() > first.history.len());
    assert_eq!(
        first.history,
        next.history[..first.history.len()],
        "complete provider history stays unchanged"
    );
}

async fn assert_persisted_contexts(store: &Store, expected: i64) {
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM messages WHERE conversation_id = 'context-history' AND message_id LIKE 'request-context:%'").fetch_one(store.pool()).await.unwrap();
    assert_eq!(count, expected, "no duplicate context is persisted");
}

#[tokio::test]
async fn identical_rules_across_two_turns_preserve_the_complete_provider_prefix() {
    let (_directory, store) = fixtures::temp_store().await;
    let rules = tempfile::tempdir().unwrap();
    std::fs::write(rules.path().join("rule.md"), "Rule A").unwrap();
    let provider = fake_provider::FakeProvider::default();
    let registry = registry(store.clone(), &provider, rules.path());
    let mut blobs = HashMap::new();
    let state = turn(&registry, &provider, "first", "one", None, &mut blobs).await;
    turn(
        &registry,
        &provider,
        "second",
        "two",
        Some(state),
        &mut blobs,
    )
    .await;
    let requests = provider.requests();
    assert_eq!(requests.len(), 2);
    assert_prefix(&requests[0], &requests[1]);
    assert_eq!(contexts(&requests[0]), contexts(&requests[1]));
    assert_eq!(contexts(&requests[1]).len(), 1);
    assert!(text(contexts(&requests[1])[0]).contains("Rule A"));
    assert_persisted_contexts(&store, 1).await;
    registry.shutdown().await;
}

#[tokio::test]
async fn rules_a_b_a_append_three_distinct_events_immediately_before_each_runtime() {
    let (_directory, store) = fixtures::temp_store().await;
    let rules = tempfile::tempdir().unwrap();
    let provider = fake_provider::FakeProvider::default();
    let registry = registry(store.clone(), &provider, rules.path());
    let mut blobs = HashMap::new();
    let mut state = None;
    for (id, rule) in [("one", "Rule A"), ("two", "Rule B"), ("three", "Rule A")] {
        std::fs::write(rules.path().join("rule.md"), rule).unwrap();
        state = Some(turn(&registry, &provider, id, id, state, &mut blobs).await);
    }
    let requests = provider.requests();
    assert_eq!(requests.len(), 3);
    for pair in requests.windows(2) {
        assert_prefix(&pair[0], &pair[1]);
    }
    for (index, request) in requests.iter().enumerate() {
        assert_eq!(contexts(request).len(), index + 1);
        let tail = &request.history[request.history.len() - 2..];
        assert!(tail[0].message_id.starts_with("request-context:"));
        assert!(tail[1].message_id.starts_with("runtime:"));
    }
    let events = contexts(&requests[2]);
    assert_eq!(text(events[0]), text(events[2]));
    assert_ne!(text(events[0]), text(events[1]));
    assert_ne!(events[0].message_id, events[2].message_id);
    assert_persisted_contexts(&store, 3).await;
    registry.shutdown().await;
}

#[tokio::test]
async fn retrying_the_same_user_event_reuses_context_and_runtime_identity() {
    let (_directory, store) = fixtures::temp_store().await;
    let rules = tempfile::tempdir().unwrap();
    std::fs::write(rules.path().join("rule.md"), "Rule A").unwrap();
    let provider = fake_provider::FakeProvider::default();
    let registry = registry(store.clone(), &provider, rules.path());
    let mut blobs = HashMap::new();
    turn(&registry, &provider, "first", "one", None, &mut blobs).await;
    turn(&registry, &provider, "retry", "one", None, &mut blobs).await;
    let requests = provider.requests();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0].history, requests[1].history);
    assert_eq!(requests[0].prompt, requests[1].prompt);
    assert_eq!(contexts(&requests[1]).len(), 1);
    assert_persisted_contexts(&store, 1).await;
    registry.shutdown().await;
}

#[tokio::test]
async fn checkpoint_hydration_into_a_fresh_store_preserves_context_deduplication_and_retry() {
    let (_directory, store) = fixtures::temp_store().await;
    let rules = tempfile::tempdir().unwrap();
    std::fs::write(rules.path().join("rule.md"), "Rule A").unwrap();
    let provider = fake_provider::FakeProvider::default();
    let first = registry(store, &provider, rules.path());
    let mut blobs = HashMap::new();
    let state = turn(&first, &provider, "first", "one", None, &mut blobs).await;
    first.shutdown().await;
    let (_recovered_directory, recovered_store) = fixtures::temp_store().await;
    let recovered = registry(recovered_store.clone(), &provider, rules.path());
    turn(
        &recovered,
        &provider,
        "recovered",
        "two",
        Some(state.clone()),
        &mut blobs,
    )
    .await;
    turn(
        &recovered,
        &provider,
        "retry",
        "two",
        Some(state),
        &mut blobs,
    )
    .await;
    let requests = provider.requests();
    assert_eq!(requests.len(), 3);
    assert_prefix(&requests[0], &requests[1]);
    assert_eq!(contexts(&requests[0]), contexts(&requests[1]));
    assert_eq!(requests[1].history, requests[2].history);
    assert_eq!(contexts(&requests[2]).len(), 1);
    assert_persisted_contexts(&recovered_store, 1).await;
    recovered.shutdown().await;
}

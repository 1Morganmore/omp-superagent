use serde_json::{Value, json};

use super::{Fixture, ack, message, send};

fn slash(command: &str, text: &str, envelope: &str) -> Value {
    json!({
        "type":"slash_commands", "envelope_id":envelope, "accepts_response_payload":true,
        "payload":{
            "api_app_id":"ALOCAL", "team_id":"TLOCAL", "channel_id":"CALLOWED", "user_id":"UOWNER",
            "command":command, "text":text, "trigger_id":format!("private-trigger-{envelope}"),
        },
    })
}

#[tokio::test]
async fn native_and_thread_commands_preserve_arguments_and_distinct_sources() {
    let fixture = Fixture::new().await;
    let (mut peer, started) = fixture.start("ALOCAL").await;
    started.expect("authenticated Slack adapter");
    fixture.hub.ready.send(true).expect("open native readiness");

    let native = "cwd: \"/tmp/First & Second\"\nAsk @owner about https://example.test/?a=1&b=2 and the literal &lt;.";
    send(
        &mut peer,
        slash("/superagent-new", &format!("  {native}  "), "native"),
    )
    .await;
    let accepted = ack(&mut peer).await;
    assert_eq!(accepted["envelope_id"], "native");
    assert_eq!(accepted["payload"]["response_type"], "ephemeral");
    let native_row = fixture
        .store
        .next(None)
        .expect("read durable intake")
        .expect("native command");
    let input = &native_row.event["input"];
    assert_eq!(input["text"], format!("/new {native}"));
    assert!(input["messageId"].is_null());
    assert!(input["route"]["threadId"].is_null());
    assert_eq!(input["invocationId"].as_str().map(str::len), Some(64));

    let threaded = "cwd: \"/tmp/First &amp; Second\"\nAsk <@UOWNER> about <https://example.test/?a=1&amp;b=2> and the literal &amp;lt;.";
    let mut event = message("thread", "CALLOWED", &format!("!new\t {threaded}"));
    event["payload"]["event"]["ts"] = json!("1000.000002");
    event["payload"]["event"]["thread_ts"] = json!("1000.000001");
    send(&mut peer, event).await;
    assert_eq!(ack(&mut peer).await, json!({"envelope_id":"thread"}));
    let thread_row = fixture
        .store
        .next(Some(native_row.sequence + 1))
        .expect("read durable intake")
        .expect("thread command");
    let input = &thread_row.event["input"];
    assert_eq!(input["text"], format!("/new\t {threaded}"));
    assert_eq!(input["messageId"], "1000.000002");
    assert_eq!(input["route"]["threadId"], "1000.000001");
    assert_eq!(input["route"]["authorityId"], "UOWNER");
    assert!(input["invocationId"].is_null());
    fixture.hub.stop().await.expect("stop Slack adapter");
}

#[tokio::test]
async fn slack_slash_syntax_refusal_is_only_for_an_authorized_route() {
    let fixture = Fixture::new().await;
    let (mut peer, started) = fixture.start("ALOCAL").await;
    started.expect("authenticated Slack adapter");
    fixture.hub.ready.send(true).expect("open native readiness");

    let bad_argument = slash("/superagent-status", "do not echo this", "bad-argument");
    for (id, field, value, syntax) in [
        ("bad-argument", "channel_id", "CALLOWED", true),
        ("wrong-channel", "channel_id", "CDENIED", false),
        ("wrong-owner", "user_id", "UOTHER", false),
        ("thread-claim", "thread_ts", "1000.000001", false),
    ] {
        let mut event = bad_argument.clone();
        event["envelope_id"] = json!(id);
        event["payload"][field] = json!(value);
        send(&mut peer, event).await;
        let refused = ack(&mut peer).await;
        assert_eq!(refused["envelope_id"], id);
        assert_eq!(refused["payload"]["response_type"], "ephemeral");
        let text = refused["payload"]["text"].as_str().expect("refusal text");
        assert!(text.contains("refused"));
        assert_eq!(
            text.contains("/superagent-status does not take arguments"),
            syntax
        );
        assert!(!text.contains("do not echo this"));
    }
    assert_eq!(fixture.store.pending().expect("read pending count"), 0);
    fixture.hub.stop().await.expect("stop Slack adapter");
}

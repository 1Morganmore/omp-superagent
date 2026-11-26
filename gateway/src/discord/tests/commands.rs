use super::{
    *,
    addressing_tests::{mention, owner, parent, start},
};

#[tokio::test]
async fn discord_argument_commands_preserve_the_request_on_native_and_addressed_ingress() {
    let (_temporary, store, hub, ws, mut observed, _, server) =
        discord_fixture(json!({"discord":{"requireAddressing":true}})).await;
    let mut socket = start(&hub, &ws, false).await;
    let route = parent();

    // Check the real WebSocket -> durable intake path, not the old Bun parser.
    // Keep these representative requests independent of the generated catalog.
    for (index, (name, args)) in [
        ("head", "Compare these  two topics:\n- 변경 사항\n- The literal `<@71>`"),
        ("cron", r#"add "every 2h" Check the build"#),
        ("resolve", "--lane discord:71:203"),
        ("model", "--lane openai-codex/gpt-6.2-sol"),
        ("effort", "high"),
        ("compact", "Keep the exact IDs.\nOmit repeated observations."),
        ("stop", "head"),
        ("new", "cwd: \"/tmp/work tree\"\nDraft  two notes."),
    ]
    .into_iter()
    .enumerate()
    {
        let sequence = 3 + 3 * u64::try_from(index).unwrap();
        let interaction_id = (500 + sequence).to_string();
        let expected = format!("/{name} {args}");
        let payload = json!({
            "application_id":"72","guild_id":"77","member":{"user":{"id":"42"}},
            "channel":{"id":"88","type":0},
            "token":"offline-interaction","type":2,"id":interaction_id,
            "data":{
                "id":(800 + sequence).to_string(),"type":1,"name":name,
                "options":[{"type":3,"name":"text","value":format!(" {args} ")}],
            }
        });
        dispatch(&mut socket, sequence, "INTERACTION_CREATE", payload).await;
        let ack = received(
            &mut observed,
            &format!("/interactions/{interaction_id}/offline-interaction/callback"),
        )
        .await;
        assert_eq!(ack["type"], 4);
        assert_eq!(ack["data"]["flags"], 64);
        let native = event(&hub, &store).await;
        assert_eq!(native["input"]["text"], expected, "native /{name}");
        assert_eq!(native["input"]["route"], route);
        assert_eq!(native["input"]["interactionId"], interaction_id);
        assert_eq!(native["input"]["messageId"], Value::Null);

        let ignored_id = (700 + sequence + 1).to_string();
        dispatch(
            &mut socket,
            sequence + 1,
            "MESSAGE_CREATE",
            owner(&ignored_id, &expected),
        )
        .await;
        let message_id = (700 + sequence + 2).to_string();
        let written = if index % 2 == 0 {
            format!("<@!71> {expected}")
        } else {
            format!("{expected} <@71>")
        };
        dispatch(
            &mut socket,
            sequence + 2,
            "MESSAGE_CREATE",
            mention(&message_id, &written),
        )
        .await;
        let text = event(&hub, &store).await;
        assert_eq!(text["input"]["text"], expected, "addressed /{name}");
        assert_eq!(text["input"]["route"], route);
        assert_eq!(text["input"]["messageId"], message_id);
        assert_eq!(text["input"]["discordOriginalText"], written);
        assert!(text["input"].get("interactionId").is_none());
    }

    hub.stop().await.unwrap();
    server.abort();
}

#[tokio::test]
async fn discord_argument_commands_reject_stale_options_without_durable_admission() {
    let (_temporary, store, hub, ws, mut observed, _, server) =
        discord_fixture(json!({"discord":{}})).await;
    let mut socket = start(&hub, &ws, false).await;

    let text = json!({"type":3,"name":"text","value":"high"});
    for (index, (name, options)) in [
        ("effort", json!([{"type":3,"name":"level","value":"high"}])),
        ("effort", json!([{"type":7,"name":"text","value":"700"}])),
        ("effort", json!([{"type":3,"name":"text","value":1}])),
        ("effort", json!([{"type":3,"name":"text","value":"high","focused":true}])),
        ("effort", json!([text, text])),
        ("fast", json!([{"type":3,"name":"text","value":"ultra"}])),
    ]
    .into_iter()
    .enumerate()
    {
        let sequence = 3 + u64::try_from(index).unwrap();
        let id = (500 + sequence).to_string();
        dispatch(
            &mut socket,
            sequence,
            "INTERACTION_CREATE",
            interaction(&id, 2, json!({"type":1,"name":name,"options":options})),
        )
        .await;
        let ack = received(
            &mut observed,
            &format!("/interactions/{id}/offline-interaction/callback"),
        )
        .await;
        assert_eq!(ack["data"]["flags"], 64);
        assert!(
            ack["data"]["content"]
                .as_str()
                .unwrap()
                .contains("unsupported or stale")
        );
        assert_eq!(store.pending().unwrap(), 0, "malformed /{name} options");
    }

    hub.stop().await.unwrap();
    server.abort();
}

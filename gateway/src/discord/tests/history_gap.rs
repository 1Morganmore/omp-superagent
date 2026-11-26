use super::{
    *,
    addressing_recovery_tests::assert_checkpoint,
    addressing_tests::{bot_message, reply, respond, start},
};

const STAGED: &str = "gateway:discord-history-staged";
const REFERENCE: &str = "/channels/88/messages/111";

async fn replace_session(socket: &mut FixtureSocket, listener: &TcpListener) -> FixtureSocket {
    wire(socket, json!({"op":9,"d":false})).await;
    let (mut replacement, identify) = time::timeout(Duration::from_secs(8), gateway_login(listener))
        .await.expect("Discord did not re-identify after invalidating its old session");
    assert_eq!(identify["op"], 2);
    dispatch(&mut replacement, 1, "READY", json!({"user":{"id":"71","bot":true},
        "application":{"id":"72"},"session_id":"replacement-session",
        "resume_gateway_url":format!("ws://{}/", listener.local_addr().unwrap())})).await;
    replacement
}

async fn resume_replacement(socket: &mut FixtureSocket, listener: &TcpListener) -> FixtureSocket {
    wire(socket, json!({"op":7})).await;
    let (resumed, resume) = time::timeout(Duration::from_secs(5), gateway_login(listener))
        .await.expect("Discord did not resume the replacement session");
    assert_eq!(resume["op"], 6);
    assert_eq!(resume["d"]["session_id"], "replacement-session");
    assert_eq!(resume["d"]["seq"], 1);
    resumed
}

#[tokio::test]
async fn discord_history_gap_survives_full_intake_then_resumed() {
    let temporary = Temp::new();
    let store = Arc::new(Store::open(&temporary.0).unwrap());
    let (hub, ws, mut observed, _, server, responses, _) = discord_fixture_with_store(json!({
        "discord":{"allowedChannelIds":["88","89"],"requireAddressing":true},
        "groupRooms":[{"platform":"discord","guildId":"77","channelId":"89","userIds":["43"],
            "mode":"chat","revision":"gap-fixture","dailyLimit":1}]
    }), &store).await;
    let mut socket = start(&hub, &ws, false).await;
    respond(&responses, REFERENCE, StatusCode::SERVICE_UNAVAILABLE, Value::Null);
    dispatch(&mut socket, 3, "MESSAGE_CREATE", reply("202", "older owner input")).await;
    received(&mut observed, REFERENCE).await;
    // The blocked owner lookup holds the worker while these live group frames
    // use all bounded queue slots. They are not group commands or durable work.
    for sequence in 4..1028 {
        dispatch(&mut socket, sequence, "MESSAGE_CREATE",
            message("203", Some("77"), "89", "43", "ordinary group chat")).await;
    }
    assert_checkpoint(&mut socket, 1027).await;

    let mut replacement = replace_session(&mut socket, &ws).await;
    assert_checkpoint(&mut replacement, 1).await;
    assert_eq!(store.get_meta(STAGED).unwrap().as_deref(), Some("1"));
    assert_eq!(store.pending().unwrap(), 0, "the gap must follow older owner intake");
    let mut resumed = resume_replacement(&mut replacement, &ws).await;
    respond(&responses, REFERENCE, StatusCode::OK, bot_message());
    time::timeout(Duration::from_secs(12), hub.changed.notified())
        .await.expect("unblocked owner intake did not drain");
    assert_eq!(event(&hub, &store).await["input"]["messageId"], "202");
    let gap = queued_event(&hub, &store).await;
    assert_eq!(gap.event["kind"], "reconnect");
    assert_eq!(gap.event["historyRecovery"], true);
    assert_eq!(gap.event["historyPlatform"], "discord");
    assert!(gap.event["historyBeforeUs"].as_i64().is_some());
    assert!(store.has_wake_input().unwrap());
    store.receipt(gap.sequence, GatewayReceipt::Accepted).unwrap();
    assert!(store.get_meta(STAGED).unwrap().is_none());

    dispatch(&mut resumed, 2, "RESUMED", json!({})).await;
    let reconnect = queued_event(&hub, &store).await;
    assert_eq!(reconnect.event, json!({"kind":"reconnect"}));
    assert!(!store.has_wake_input().unwrap());
    store.receipt(reconnect.sequence, GatewayReceipt::Accepted).unwrap();
    // A second ready-like dispatch on the same physical link is not another reconnect.
    dispatch(&mut resumed, 3, "RESUMED", json!({})).await;
    dispatch(&mut resumed, 4, "MESSAGE_CREATE",
        message("204", None, "99", "42", "post-resume input")).await;
    assert_eq!(event(&hub, &store).await["input"]["messageId"], "204");
    hub.stop().await.unwrap();
    server.abort();
}

#[tokio::test]
async fn discord_history_gap_survives_interrupted_supervisor_and_waits_for_initial_approvals() {
    let temporary = Temp::new();
    let config = json!({"discord":{}});
    let store = Arc::new(Store::open(&temporary.0).unwrap());
    let (hub, ws, _, _, server, _, _) = discord_fixture_with_store(config.clone(), &store).await;
    let (started, mut socket) = time::timeout(Duration::from_secs(5), async {
        tokio::join!(hub.start(), identify(&ws, false))
    }).await.unwrap();
    started.unwrap();
    // The approval barrier is intentionally unopened even though the adapter
    // authenticated. READY and RESUMED must still complete on their sockets.
    let mut replacement = replace_session(&mut socket, &ws).await;
    let mut resumed = resume_replacement(&mut replacement, &ws).await;
    dispatch(&mut resumed, 2, "RESUMED", json!({})).await;
    assert_checkpoint(&mut resumed, 2).await;
    assert_eq!(store.pending().unwrap(), 0);
    assert!(!store.has_wake_input().unwrap());
    assert_eq!(store.get_meta(STAGED).unwrap().as_deref(), Some("1"));
    hub.stop().await.unwrap();
    server.abort();
    drop(hub);
    drop(store);

    let store = Arc::new(Store::open(&temporary.0).unwrap());
    let (hub, ws, _, _, server, _, _) = discord_fixture_with_store(config, &store).await;
    let (started, mut socket) = time::timeout(Duration::from_secs(5), async {
        tokio::join!(hub.start(), identify(&ws, false))
    }).await.unwrap();
    started.unwrap();
    assert_eq!(store.pending().unwrap(), 0);
    hub.ready.send_replace(true);
    let gap = event(&hub, &store).await;
    assert_eq!(gap["historyRecovery"], true);
    assert_eq!(gap["historyPlatform"], "discord");
    assert!(store.get_meta(STAGED).unwrap().is_none());
    dispatch(&mut socket, 2, "MESSAGE_CREATE", message("205", None, "99", "42", "new work")).await;
    assert_eq!(event(&hub, &store).await["input"]["messageId"], "205");
    hub.stop().await.unwrap();
    server.abort();
}

#[tokio::test]
async fn discord_bounded_history_pages_back_to_the_cursor_then_returns_oldest_first() {
    use super::addressing_tests::{owner, parent};

    let temporary = Temp::new();
    let store = Arc::new(Store::open(&temporary.0).unwrap());
    let (hub, ws, _, _, server, responses, _) =
        discord_fixture_with_store(json!({"discord":{}}), &store).await;
    let _socket = start(&hub, &ws, false).await;
    let before_us = 1_420_070_400_001_000_i64;
    let mut first: Vec<_> = (204..304).rev().map(|id| owner(&id.to_string(), "newer")).collect();
    first[0]["edited_timestamp"] = json!("2026-11-21T01:02:03.456000+00:00");
    respond(&responses, "/channels/88/messages?before=4194304&limit=100", StatusCode::OK, json!(first));
    respond(&responses, "/channels/88/messages?before=204&limit=100", StatusCode::OK, json!([
        owner("203", "earlier"), owner("200", "oldest in the gap"), owner("199", "saved cursor"),
    ]));
    let result = hub.effect("fetchAfter", &[parent(), json!("199"), json!(before_us)]).await.unwrap();
    let ids: Vec<_> = result.as_array().unwrap().iter().map(|input| input["messageId"].as_str().unwrap()).collect();
    let expected: Vec<_> = [200, 203].into_iter().chain(204..303).map(|id| id.to_string()).collect();
    assert_eq!(ids, expected);
    hub.stop().await.unwrap();
    server.abort();
}

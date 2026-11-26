use super::*;

#[tokio::test]
async fn slack_modal_and_rehydrated_card_keep_their_original_route_and_generation() {
    let mut fixture = Fixture::new().await;
    let (mut peer, result) = fixture.start("ALOCAL").await;
    result.expect("matching Slack application");
    fixture.hub.ready.send(true).expect("open native readiness");
    let route = json!({
        "platform":"slack", "accountId":"TLOCAL:UBOT", "authorityId":"UOWNER", "guildId":null,
        "channelId":"DOWNER", "threadId":"1000.000001", "topicId":"original-logical-topic",
    });
    let mut approval = json!({
        "id":"original-approval", "target":"head", "generation":7, "requestId":"original-native-request",
        "route": route, "state":"pending", "remoteId":null,
        "request":{"method":"editor","title":"Review <!channel>", "prefill":"private prefill"},
    });
    let receipt = fixture
        .hub
        .effect("showApproval", &[approval.clone()])
        .await
        .expect("show card");
    assert_eq!(receipt, "2000.000001");
    approval["remoteId"] = receipt.clone();
    let posted = fixture.called("chat.postMessage").await;
    assert_eq!(posted["thread_ts"], route["threadId"]);
    assert_eq!(posted["blocks"][0]["text"]["type"], "plain_text");
    assert!(!posted.to_string().contains("private prefill"));
    let card = fixture.state.card.lock().await.clone();
    let action = card["blocks"][1]["elements"][0]["action_id"].clone();
    // Expected identity is sha256(JSON.stringify([id, generation, target, requestId, routeKey])), truncated.
    let correlation = "omp:6a38ce570f9520b4762b9fc6:open";
    assert_eq!(action, correlation);

    let mut forged = approval.clone();
    forged["generation"] = json!(8);
    assert!(fixture.hub.effect("showApproval", &[forged]).await.is_err());
    let card = fixture.state.card.lock().await.clone();
    let open = json!({
        "type":"interactive","envelope_id":"open","payload":{
            "type":"block_actions","api_app_id":"ALOCAL","team":{"id":"TLOCAL"},"user":{"id":"UOWNER"},
            "channel":{"id":"DOWNER"},"container":{"type":"message","channel_id":"DOWNER","message_ts":receipt},
            "message":card,"actions":[{"type":"button","action_ts":"2001.000001","action_id":action}],
            "trigger_id":"open-private-capability",
        },
    });
    send(&mut peer, open).await;
    assert_eq!(ack(&mut peer).await, json!({"envelope_id":"open"}));
    let opened = fixture.called("views.open").await;
    let view = &opened["view"];
    assert_eq!(
        view["blocks"][0]["element"]["initial_value"],
        "private prefill"
    );

    let make_submit = |id, metadata: Value| {
        json!({
            "type":"interactive", "envelope_id":id, "payload":{
                "type":"view_submission", "team":{"id":"TLOCAL"}, "user":{"id":"UOWNER"},
                "view":{
                    "callback_id":view["callback_id"], "id":"VMODAL","private_metadata":metadata,
                    "state":{"values":{"response":{"value":{"type":"plain_text_input","value":"  exact private reply\n"}}}},
                },
            },
        })
    };
    send(&mut peer, make_submit("forged", json!("forged-metadata"))).await;
    assert_eq!(ack(&mut peer).await, json!({"envelope_id":"forged"}));
    assert!(
        fixture
            .store
            .next(None)
            .expect("look for forged answer")
            .is_none()
    );
    send(
        &mut peer,
        make_submit("submitted", view["private_metadata"].clone()),
    )
    .await;
    assert_eq!(ack(&mut peer).await, json!({"envelope_id":"submitted"}));
    let row = fixture
        .store
        .next(None)
        .expect("read durable answer")
        .expect("admit linked modal");
    assert_eq!(
        row.event,
        json!({"kind":"answer", "approvalId":"original-approval",
        "response":{"value":"  exact private reply\n"}, "route":route})
    );
    let updated = fixture.called("chat.update").await;
    assert!(
        updated["blocks"]
            .as_array()
            .expect("Slack card blocks")
            .iter()
            .all(|block| block["type"] != "actions")
    );
    assert!(!updated.to_string().contains("exact private reply"));
    fixture.hub.stop().await.expect("stop Slack adapter");

    // A durably queued answer prevents callbacks or a second card after restart.
    let (mut replacement, result) = fixture.start("ALOCAL").await;
    result.expect("restart same Slack account");
    assert_eq!(
        fixture
            .hub
            .effect("showApproval", &[approval])
            .await
            .expect("resolve authoritative original card"),
        receipt
    );
    send(
        &mut replacement,
        make_submit("retried", view["private_metadata"].clone()),
    )
    .await;
    assert_eq!(
        ack(&mut replacement).await,
        json!({"envelope_id":"retried"})
    );
    assert_eq!(
        fixture.store.pending().expect("exact pending answer count"),
        1
    );
    fixture
        .hub
        .stop()
        .await
        .expect("stop restarted Slack adapter");
}

const DECISION_ID: &str = "d-0123456789abcdef01234567";

fn decision_approval(decision_id: &str, suffixes: [&str; 2]) -> Value {
    json!({
        "id":"lane-approval", "target":"lane-12", "generation":7, "requestId":"native-decision-request",
        "route":{
            "platform":"slack", "accountId":"TLOCAL:UBOT", "authorityId":"UOWNER", "guildId":null,
            "channelId":"DOWNER", "threadId":"1000.000001", "topicId":"original-logical-topic",
        },
        "state":"pending", "remoteId":null, "decision":{"id":decision_id},
        "request":{"method":"ask","questions":[
            {"id":format!("{decision_id}{}", suffixes[0]),"question":"Choose an approach",
             "options":[{"label":"Implement"},{"label":"Inspect"}]},
            {"id":format!("{decision_id}{}", suffixes[1]),"question":"Choose a brief",
             "options":[{"label":"Full"},{"label":"Summary"}]},
        ]},
    })
}

fn decision_action(card: &Value, control: &str, envelope: &str) -> Value {
    let element = card["blocks"]
        .as_array()
        .expect("card blocks")
        .iter()
        .filter_map(|block| block["elements"].as_array())
        .flatten()
        .find(|element| {
            element["action_id"]
                .as_str()
                .and_then(|id| id.rsplit_once(':'))
                .is_some_and(|(_, action)| action == control)
        })
        .expect("original question control");
    let mut action = json!({
        "type":element["type"], "action_id":element["action_id"], "action_ts":"2001.000001",
    });
    if element["type"] == "static_select" {
        action["selected_option"] = json!({"value":"1"});
    }
    json!({
        "type":"interactive","envelope_id":envelope,"payload":{
            "type":"block_actions","api_app_id":"ALOCAL","team":{"id":"TLOCAL"},"user":{"id":"UOWNER"},
            "channel":{"id":card["channel"]},
            "container":{"type":"message","channel_id":card["channel"],"message_ts":card["ts"]},
            "message":card,"actions":[action],
        },
    })
}

#[tokio::test]
async fn slack_decision_cards_submit_both_original_id_formats_on_the_original_route() {
    for (suffixes, context) in [
        ([":0", ":1"], None),
        (
            [":head:0", ":head:1"],
            Some("The owner chooses the report format."),
        ),
    ] {
        let mut fixture = Fixture::new().await;
        let (mut peer, result) = fixture.start("ALOCAL").await;
        result.expect("matching Slack application");
        fixture.hub.ready.send(true).expect("open native readiness");
        let mut approval = decision_approval(DECISION_ID, suffixes);
        if let Some(context) = context {
            approval["ownerContext"] = json!(context);
        }

        let receipt = fixture
            .hub
            .effect("showApproval", std::slice::from_ref(&approval))
            .await
            .expect("show original decision card");
        assert_eq!(receipt, "2000.000001");
        let posted = fixture.called("chat.postMessage").await;
        let route = &approval["route"];
        assert_eq!(posted["channel"], route["channelId"]);
        assert_eq!(posted["thread_ts"], route["threadId"]);
        if let Some(context) = context {
            assert!(
                posted["text"]
                    .as_str()
                    .expect("card text")
                    .contains(context)
            );
        }
        assert_eq!(fixture.store.pending().expect("pending answer count"), 0);

        let mut wrong_receipt = approval.clone();
        wrong_receipt["remoteId"] = json!("2000.000002");
        assert!(
            fixture
                .hub
                .effect("showApproval", &[wrong_receipt])
                .await
                .is_err()
        );

        for index in 0..2 {
            let card = fixture.state.card.lock().await.clone();
            let choose = format!("choose-{index}");
            send(&mut peer, decision_action(&card, &choose, &choose)).await;
            assert_eq!(ack(&mut peer).await, json!({"envelope_id":choose}));
            fixture.called("chat.update").await;

            let card = fixture.state.card.lock().await.clone();
            let next = format!("next-{index}");
            if index == 1 {
                let mut forged = decision_action(&card, &next, "wrong-thread");
                forged["payload"]["message"]["thread_ts"] = json!("1000.000002");
                send(&mut peer, forged).await;
                assert_eq!(ack(&mut peer).await, json!({"envelope_id":"wrong-thread"}));
                assert_eq!(fixture.store.pending().expect("pending answer count"), 0);
            }
            send(&mut peer, decision_action(&card, &next, &next)).await;
            assert_eq!(ack(&mut peer).await, json!({"envelope_id":next}));
            let updated = fixture.called("chat.update").await;
            assert_eq!(updated["channel"], route["channelId"]);
            assert_eq!(updated["ts"], receipt);
        }

        let row = fixture
            .store
            .next(None)
            .expect("read durable answer")
            .expect("admit original decision answers");
        assert_eq!(
            row.event,
            json!({"kind":"answer","approvalId":"lane-approval","route":route,"response":{"answers":[
                {"id":format!("{DECISION_ID}{}", suffixes[0]),"selectedOptions":["Inspect"]},
                {"id":format!("{DECISION_ID}{}", suffixes[1]),"selectedOptions":["Summary"]},
            ]}}),
        );
        assert_eq!(fixture.store.pending().expect("pending answer count"), 1);
        fixture.hub.stop().await.expect("stop Slack adapter");
    }
}

#[tokio::test]
async fn slack_decision_cards_cancel_malformed_question_ids_on_the_original_route() {
    for (id, suffixes) in [
        (DECISION_ID, [":head:0", ":1"]),
        (DECISION_ID, [":0", ":head:1"]),
        (DECISION_ID, [":head:0", ":head:2"]),
        (DECISION_ID, [":0", ":2"]),
        (DECISION_ID, [":head:00", ":head:1"]),
        ("d-0123456789abcdef01234567:head", [":0", ":1"]),
    ] {
        let mut fixture = Fixture::new().await;
        let (_peer, result) = fixture.start("ALOCAL").await;
        result.expect("matching Slack application");
        let approval = decision_approval(id, suffixes);

        let receipt = fixture
            .hub
            .effect("showApproval", std::slice::from_ref(&approval))
            .await
            .expect("deliver unsupported-dialog notice");
        assert_eq!(receipt, "2000.000001");
        let posted = fixture.called("chat.postMessage").await;
        let route = &approval["route"];
        assert_eq!(posted["channel"], route["channelId"]);
        assert_eq!(posted["thread_ts"], route["threadId"]);
        assert!(
            posted["blocks"]
                .as_array()
                .expect("notice blocks")
                .iter()
                .all(|block| block["type"] != "actions"),
            "malformed decision supplied controls: {id} {suffixes:?}",
        );
        let row = fixture
            .store
            .next(None)
            .expect("read durable cancellation")
            .expect("cancel unsupported native dialog");
        assert_eq!(
            row.event,
            json!({"kind":"answer","approvalId":"lane-approval","route":route,
                "response":{"cancelled":true}}),
        );
        assert_eq!(fixture.store.pending().expect("pending answer count"), 1);
        fixture.hub.stop().await.expect("stop Slack adapter");
    }
}

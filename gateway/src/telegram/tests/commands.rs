use anyhow::{Context as _, Result};
use serde_json::{Value, json};

use crate::store::GatewayReceipt;

use super::{Fixture, group, route};

#[tokio::test]
async fn telegram_poll_removes_only_a_confirmed_leading_bot_suffix_and_keeps_arguments() -> Result<()> {
    let mut fixture = Fixture::start().await?;
    fixture.hub.ready.send_replace(true);
    let (_, poll) = fixture.poll().await?;
    let dm = json!({"id":42,"type":"private"});
    let mut dm_route = route();
    dm_route["channelId"] = json!("42");
    dm_route["guildId"] = Value::Null;
    let mut main_dm = dm_route.clone();
    main_dm["threadId"] = Value::Null;
    let mut group_parent = route();
    group_parent["threadId"] = Value::Null;
    let basic_group = json!({"id":-100,"type":"group"});
    let message = |id, chat: Value, thread: Option<u64>, text: &str, entities: Value| {
        json!({
            "message_id":id,"date":100,"chat":chat,"message_thread_id":thread,
            "from":{"id":42,"is_bot":false},"text":text,"entities":entities,
        })
    };
    let bot_command = |offset, length| {
        json!({"type":"bot_command","offset":offset,"length":length})
    };
    let token = "/new@ROOM_BOT";
    let prefix = "\u{3000}\t";
    let argument = "\n😀  cwd: \"/tmp/work space\"\nKeep @other_bot as text.";
    let addressed_text = format!("{prefix}{token}{argument}");
    let plain = "/model\t  --lane provider/model";
    let qualified_dm = "/head@room_bot";
    let dm_argument = "\u{a0}Keep this  text.\nSecond line.";
    let dm_text = format!("{qualified_dm}{dm_argument}");
    let expected_dm = format!("/head{dm_argument}");
    let not_ours = "/stop@other_bot";
    let foreign_text = format!("{prefix}{not_ours}\nhead");
    let quoted_token = "/restart@room_bot";
    let quoted_text = format!("{quoted_token}\nThis is ordinary prose.");
    let body = "😀 /stop@room_bot is an example.";
    let coded = "\t/stop head\n/restart";
    let prelude = "sample\n/new";
    let updates = [
        message(1, group(), Some(7), &addressed_text, json!([
            bot_command(prefix.encode_utf16().count(), token.len()),
            {"type":"code","offset":format!("{prefix}{token}\n😀  cwd: ").encode_utf16().count(),
                "length":"\"/tmp/work space\"".len()},
        ])),
        message(2, basic_group.clone(), None, plain, json!([])),
        message(3, dm.clone(), Some(7), &dm_text, json!([bot_command(0, qualified_dm.len())])),
        message(4, dm.clone(), None, &foreign_text, json!([bot_command(prefix.encode_utf16().count(), not_ours.len())])),
        message(5, dm.clone(), None, &quoted_text, json!([
            bot_command(0, quoted_token.len()),
            {"type":"blockquote","offset":0,"length":quoted_token.len()},
        ])),
        message(6, dm, None, body, json!([bot_command("😀 ".encode_utf16().count(), "/stop@room_bot".len())])),
        message(7, basic_group.clone(), None, coded, json!([
            {"type":"code","offset":1,"length":5},
        ])),
        message(8, basic_group.clone(), None, prelude, json!([
            {"type":"pre","offset":0,"length":7},
        ])),
        message(9, basic_group, None, plain, json!([
            {"type":"code","offset":9,"length":21},
        ])),
    ];
    let updates: Vec<_> = updates
        .into_iter()
        .enumerate()
        .map(|(index, message)| json!({"update_id":index + 1,"message":message}))
        .collect();
    poll.send(json!(updates))
        .expect("Telegram fixture update response");

    let (ack, _next_poll) = fixture.poll().await?;
    assert_eq!(ack["offset"], 10);
    let expected = [
        (
            "1",
            route(),
            format!("{prefix}/new{argument}"),
            format!("{prefix}/new\n😀  cwd: \nKeep @other_bot as text."),
            false,
        ),
        ("2", group_parent.clone(), plain.into(), plain.into(), false),
        ("3", dm_route, expected_dm.clone(), expected_dm, false),
        (
            "5",
            main_dm.clone(),
            quoted_text,
            "\nThis is ordinary prose.".into(),
            true,
        ),
        ("6", main_dm, body.into(), body.into(), false),
        ("7", group_parent.clone(), coded.into(), "\t head\n/restart".into(), true),
        ("8", group_parent.clone(), prelude.into(), "\n/new".into(), true),
        ("9", group_parent, plain.into(), "/model\t  ".into(), false),
    ];
    assert_eq!(fixture.store.pending()?, u64::try_from(expected.len())?);
    for (id, route, text, routing_text, blocked) in expected {
        let event = fixture
            .store
            .next(None)?
            .context("Owner input missing after poll ACK")?;
        assert_eq!(event.event["kind"], "message");
        let input = &event.event["input"];
        assert_eq!(input["messageId"], id);
        assert_eq!(input["route"], route);
        assert_eq!(input["text"], text);
        assert_eq!(input["routingText"], routing_text);
        assert_eq!(input["telegramProtectedCommand"], blocked);
        fixture
            .store
            .receipt(event.sequence, GatewayReceipt::Accepted)?;
    }
    fixture.hub.stop().await
}

#[tokio::test]
async fn telegram_poll_acknowledges_exact_legacy_qualified_receipts_without_replacing_them() -> Result<()> {
    let mut fixture = Fixture::start().await?;
    let wrapped = "/restart@room_bot";
    let literal = "\u{3000}/status@ROOM_BOT  keep 😀";
    let ignored = "\t/status@other_bot  keep 😀";
    let document = json!({"file_id":"doc_1","file_unique_id":"unique","file_name":"request.txt","file_size":17});
    let attachment = json!({"id":"doc_1","name":"request.txt","url":"telegram-file:doc_1","size":17});
    let receipt = |id, text, view: Option<&str>, files: Value| {
        let mut input = json!({"id":format!("telegram:900:-100:{id}:original"),"route":route(),
            "messageId":id,"receivedAt":100000,"text":text,"attachments":files});
        if let Some(view) = view {
            input["routingText"] = json!(view);
        }
        json!({"kind":"message","input":input})
    };
    let receipts = [
        receipt("10", literal, None, json!([attachment])),
        receipt("11", "/restart\n/status", Some("\n/status"), json!([])),
        receipt("12", ignored, Some(ignored), json!([])),
    ];
    for event in &receipts {
        assert!(fixture.store.admit(event)?);
    }
    fixture.hub.ready.send_replace(true);
    let (_, poll) = fixture.poll().await?;
    let owner_wire = |id, text: &str, entities| {
        json!({"message_id":id,"date":100,"chat":group(),"message_thread_id":7,
            "from":{"id":42,"is_bot":false},"text":text,"entities":entities})
    };
    let mut caption = owner_wire(10, literal, json!([
        {"type":"bot_command","offset":1,"length":16},
    ]));
    let body = caption.as_object_mut().context("owner fixture message")?;
    body.remove("text");
    let entities = body.remove("entities").context("owner fixture entities")?;
    caption["caption"] = json!(literal);
    caption["caption_entities"] = entities;
    caption["document"] = document;
    let code = owner_wire(11, &format!("{wrapped}\n/status"), json!([
        {"type":"bot_command","offset":0,"length":wrapped.len()},
        {"type":"blockquote","offset":0,"length":wrapped.len()},
    ]));
    let foreign = owner_wire(12, ignored, json!([
        {"type":"bot_command","offset":1,"length":17},
    ]));
    poll.send(json!([
        {"update_id":17,"message":caption},
        {"update_id":18,"message":code},
        {"update_id":19,"message":foreign},
    ])).expect("Telegram fixture update response");

    let (advanced, _) = fixture.poll().await?;
    assert_eq!(advanced["offset"], 20);
    assert_eq!(fixture.store.pending()?, 3);
    for receipt in receipts {
        let stored = fixture.store.next(None)?.context("Original receipt lost on redelivery")?;
        assert_eq!(stored.event, receipt);
        fixture.store.receipt(stored.sequence, GatewayReceipt::Accepted)?;
    }
    assert!(fixture.store.next(None)?.is_none());
    fixture.hub.stop().await
}

#[tokio::test]
async fn telegram_poll_holds_qualified_replay_when_its_attachment_does_not_match() -> Result<()> {
    let mut fixture = Fixture::start().await?;
    let token = "/stop@room_bot";
    let event = json!({"kind":"message","input":{"id":"telegram:900:-100:10:original","route":route(),
        "messageId":"10","receivedAt":100000,"text":"/stop head","routingText":"",
        "attachments":[{"id":"old_doc","name":"notes.txt","url":"telegram-file:old_doc","size":12}]}});
    assert!(fixture.store.admit(&event)?);
    fixture.hub.ready.send_replace(true);
    let (_, poll) = fixture.poll().await?;
    let original = format!("{token} head");
    poll.send(json!([{"update_id":17,"message":{
        "message_id":10,"date":100,"chat":group(),"message_thread_id":7,"from":{"id":42,"is_bot":false},
        "caption":original,"caption_entities":[
            {"type":"bot_command","offset":0,"length":token.len()},
            {"type":"pre","offset":0,"length":original.len()},
        ],"document":{"file_id":"different_doc","file_unique_id":"unique","file_name":"notes.txt","file_size":12}
    }}])).expect("Telegram fixture update response");

    let (retry, _) = fixture.poll().await?;
    assert!(retry.get("offset").is_none());
    assert!(fixture.store.get_meta("telegram:900:offset")?.is_none());
    assert_eq!(fixture.store.next(None)?.context("Receipt missing after conflict")?.event, event);
    assert_eq!(fixture.store.pending()?, 1);
    fixture.hub.stop().await
}

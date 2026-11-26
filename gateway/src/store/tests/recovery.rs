use anyhow::{Context, Result};
use rusqlite::{Connection, params};
use serde_json::{Value, json};

use crate::store::ingress::recovery::{NEXT, PENDING_BARRIER};

use super::{GatewayReceipt, StateDir, Store};

fn route() -> Value {
    json!({"platform":"telegram","accountId":"bot","authorityId":"owner",
        "guildId":null,"channelId":"chat","threadId":null,"topicId":"original"})
}

fn message(id: &str, text: &str) -> Value {
    json!({"kind":"message","input":{"id":id,"text":text,"route":route(),
        "messageId":id,"receivedAt":123,"attachments":[]}})
}

#[test]
fn quarantine_prioritizes_barriers_then_exact_whitespace_recovery_controls() -> Result<()> {
    let root = StateDir::new()?;
    let store = Store::open(&root.0)?;
    let held_message = message("held", "unresolved ordinary input");
    assert!(store.admit(&held_message)?);
    let held = store.next(None)?.context("Original message was not queued")?;
    store.attempt(held.sequence)?;
    store.receipt(held.sequence, GatewayReceipt::Unresolved)?;

    let ordinary = message("ordinary", "ordinary input");
    assert!(store.admit(&ordinary)?);
    assert!(store.admit(&json!({"kind":"reconnect"}))?);
    assert!(store.admit(&json!({"kind":"reconnect","barrier":null}))?);
    let malformed = [
        "/restart now",
        "/stop head now",
        "/stop lane",
        "/stophead",
        "/stop Head",
        "/Stop head",
        "/stop\u{85}head",
        "\u{180e}/restart",
        "/stop\u{200b}head",
        "/stop \u{200b}head",
        "/stop\u{0} head",
        "/restart\u{0}",
        "/restart\u{0}now",
    ];
    for (index, text) in malformed.iter().enumerate() {
        assert!(store.admit(&message(&format!("malformed-{index}"), text))?);
    }
    for (index, text) in ["/restart", "/stop", "/stop \t head"].iter().enumerate() {
        let mut protected = message(&format!("protected-{index}"), text);
        protected["input"]["telegramProtectedCommand"] = json!(true);
        assert!(store.admit(&protected)?);
    }
    let mut legacy_masked = message("legacy-masked", "/stop head");
    legacy_masked["input"]["routingText"] = json!("");
    assert!(store.admit(&legacy_masked)?);
    let whitespace = "\t\n\u{b}\u{c}\r \u{a0}\u{1680}\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\
        \u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}";
    let mut verified = message("verified-telegram", "/stop head");
    verified["input"]["telegramProtectedCommand"] = json!(false);
    verified["input"]["routingText"] = json!("");
    let mut slack = message("slack", "/stop head");
    slack["input"]["route"]["platform"] = json!("slack");
    slack["input"]["routingText"] = json!("");
    let controls = [
        message(
            "stop-head",
            &format!("{whitespace}/stop{whitespace}head{whitespace}"),
        ),
        message("restart", "\n\u{feff} /restart\u{3000}\t"),
        message("stop", "\u{a0} /stop\r "),
        verified,
        slack,
    ];
    let barrier = json!({"kind":"reconnect","barrier":"initial"});
    for event in controls.iter().chain([&barrier]) {
        assert!(store.admit(event)?);
    }
    drop(store);
    let store = Store::open(&root.0)?;
    let original = store
        .next(Some(held.sequence))?
        .context("Held message lookup failed")?;
    assert_eq!(original.event, held_message);
    for original in [&barrier].into_iter().chain(&controls) {
        let queued = store.next(None)?.context("Expected original recovery event")?;
        assert_eq!(&queued.event, original);
        store.receipt(queued.sequence, GatewayReceipt::Accepted)?;
    }
    let queued = store.next(None)?.context("Quarantine was lost")?;
    assert_eq!(queued.sequence, held.sequence);
    assert_eq!(queued.event, held_message);
    assert_eq!(queued.reconciliation, None);
    assert_eq!(store.pending()?, u64::try_from(malformed.len())? + 8);
    store.receipt(held.sequence, GatewayReceipt::Rejected)?;
    let next = store.next(None)?.context("Ordinary ordering was lost")?;
    assert_eq!(next.event, ordinary);
    Ok(())
}

#[test]
fn legacy_quarantine_uses_an_ordered_recovery_index_without_rewriting_events() -> Result<()> {
    let root = StateDir::new()?;
    let path = root.0.join("coordination.sqlite");
    let mut legacy = Connection::open(&path)?;
    let tx = legacy.transaction()?;
    tx.execute_batch(
        "CREATE TABLE gateway_events (
           sequence INTEGER PRIMARY KEY AUTOINCREMENT, identity TEXT NOT NULL UNIQUE,
           data TEXT NOT NULL, received_at INTEGER NOT NULL, delivered_at INTEGER, delivery_error TEXT
         );",
    )?;
    let held =
        json!({"kind":"answer","approvalId":"held","route":route(),"response":{"confirmed":true}});
    tx.execute(
        "INSERT INTO gateway_events VALUES(1,'answer:held',?,1,2,'Head rejected admitted event')",
        [held.to_string()],
    )?;
    let mut control = message("legacy-control", "/stop\u{202f}head");
    control["input"]["routingText"] = control["input"]["text"].clone();
    let control_data = format!(
        " \n{}\n",
        control.to_string().replace("/stop", r"\/st\u006fp")
    );
    let first_barrier = json!({"kind":"reconnect","barrier":"first"});
    let second_barrier = json!({"kind":"reconnect","barrier":"second"});
    {
        let mut insert = tx.prepare(
            "INSERT INTO gateway_events(identity,data,received_at,delivered_at) VALUES(?,?,1,?)",
        )?;
        insert.execute(params![
            "message:delivered",
            message("delivered", "/restart").to_string(),
            2,
        ])?;
        let ordinary = "ordinary text ".repeat(64);
        for n in 0..256 {
            let id = format!("ordinary-{n}");
            insert.execute(params![
                format!("message:{id}"),
                message(&id, &ordinary).to_string(),
                None::<i64>,
            ])?;
        }
        // A legacy Bun writer can serialize unpaired surrogates. Neither
        // SQLite string normalization nor a failed Rust decode can promote one.
        let surrogate = message("surrogate", "/restartTAIL")
            .to_string()
            .replace("TAIL", r"\uD800");
        insert.execute(params!["message:surrogate", surrogate, None::<i64>])?;
        for (id, data) in [
            ("message:legacy-control", control_data.clone()),
            ("reconnect:first", first_barrier.to_string()),
            ("reconnect:second", second_barrier.to_string()),
        ] {
            insert.execute(params![id, data, None::<i64>])?;
        }
    }
    tx.commit()?;
    drop(legacy);

    let store = Store::open(&root.0)?;
    let ledger = Connection::open(&path)?;
    for sql in [NEXT.as_str(), PENDING_BARRIER.as_str()] {
        let mut explain = ledger.prepare(&format!("EXPLAIN QUERY PLAN {sql}"))?;
        let plan = explain
            .query_map([], |row| row.get::<_, String>(3))?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .join("\n");
        assert!(plan.contains("INDEX gateway_events_recovery"), "{plan}");
        assert!(!plan.contains("TEMP B-TREE"), "{plan}");
        if sql == NEXT.as_str() {
            assert!(plan.contains("INDEX gateway_events_pending"), "{plan}");
            assert!(plan.contains("INTEGER PRIMARY KEY"), "{plan}");
        }
    }
    assert_eq!(store.pending_barrier()?.as_deref(), Some("first"));
    for original in [&first_barrier, &second_barrier, &control] {
        let next = store.next(None)?.context("Legacy recovery event missing")?;
        assert_eq!(&next.event, original);
        store.receipt(next.sequence, GatewayReceipt::Accepted)?;
    }
    assert_eq!(store.pending_barrier()?, None);
    let original = store.next(None)?.context("Legacy quarantined answer missing")?;
    assert_eq!(original.sequence, 1);
    assert_eq!(original.event, held);
    assert_eq!(original.reconciliation, Some(true));
    let stored: String = ledger.query_row(
        "SELECT data FROM gateway_events WHERE identity='message:legacy-control'",
        [],
        |row| row.get(0),
    )?;
    assert_eq!(stored, control_data);
    Ok(())
}

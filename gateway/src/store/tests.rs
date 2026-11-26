use std::{fs, path::PathBuf};

use anyhow::{Context, Result};
use rusqlite::{Connection, params};
use serde_json::json;
use uuid::Uuid;

use super::{GatewayReceipt, HEAD_ROTATION, HEAD_SESSION_FILE, HibernationChange, Store, answer_digest};

mod recovery;

struct StateDir(PathBuf);

impl StateDir {
    fn new() -> Result<Self> {
        let path = std::env::temp_dir().join(format!("gateway-store-{}", Uuid::new_v4()));
        fs::create_dir(&path)?;
        Ok(Self(path))
    }
}

impl Drop for StateDir {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_dir_all(&self.0) {
            eprintln!("Could not remove Gateway store test directory: {error}");
        }
    }
}

#[test]
fn rotation_keeps_later_input_durable_without_redelivering_preceding_input() -> Result<()> {
    let root = StateDir::new()?;
    let route = json!({"platform":"telegram","accountId":"bot","authorityId":"owner",
        "guildId":null,"channelId":"chat","threadId":null,"topicId":"original"});
    let answer = |id| json!({"kind":"answer","approvalId":id,"route":route,"response":{"confirmed":true}});
    let stopping = json!({"stage":"stopping"}).to_string();
    {
        let store = Store::open(&root.0)?;
        assert!(store.admit(&answer("old"))?);
        assert!(!store.begin_rotation(None, None, &stopping)?);
        let event = store.next(None)?.context("Prior event not delivered")?;
        store.receipt(event.sequence, GatewayReceipt::Accepted)?;
        assert!(store.begin_rotation(None, None, &stopping)?);
        assert!(store.admit(&answer("during-rotation"))?);
        assert!(store.next(None)?.is_none());
    }
    let store = Store::open(&root.0)?;
    assert_eq!(store.pending()?, 1);
    assert!(store.next(None)?.is_none());
    store.finish_rotation(
        &json!({"sessionId":"new"}),
        &json!({"stage":"complete","original":{"sessionId":"old"},
            "attestation":{"selection":{"modelSettings":{}}}}).to_string(),
    )?;
    let event = store.next(None)?.context("Durable rotation input was lost")?;
    assert_eq!(event.event["approvalId"], "during-rotation");
    store.receipt(event.sequence, GatewayReceipt::Accepted)?;
    assert!(store.next(None)?.is_none());
    Ok(())
}

#[test]
fn rotation_shutdown_authority_is_refused_after_an_operator_lifecycle_fence() -> Result<()> {
    let root = StateDir::new()?;
    let store = Store::open(&root.0)?;
    let stopping = json!({"stage":"stopping"}).to_string();
    store.set_meta("gateway:operator-stop", "explicit-stop")?;
    assert!(!store.begin_rotation(None, None, &stopping)?);
    store.set_meta("head:restart-fence", "{}")?;
    assert!(!store.begin_rotation(None, Some("explicit-stop"), &stopping)?);
    assert!(store.get_meta(super::HEAD_ROTATION)?.is_none());
    Ok(())
}

#[test]
fn hibernation_preserves_same_session_and_holds_later_ingress_in_order_across_reopen() -> Result<()> {
    let root = StateDir::new()?;
    let journal = "/saved/sessions/main/rotated/current/session.jsonl";
    let original = json!({"sessionId":"same","sessionFile":journal,"pid":101,"ownerPid":102,"dev":1,"ino":1});
    let settings = json!({"modelRoles":{"default":"provider/model"},"defaultThinkingLevel":"high"});
    let mut plan = json!({"id":"sleep","mode":"hibernate","stage":"stopping","original":original,
        "sessionFile":journal,"stopBoundary":null,"replacementSessionId":null,"replacementOwnerPid":null,
        "attestation":{"generation":3,"selection":{"modelSettings":settings}}});
    let stopping = plan.to_string();
    {
        let store = Store::open(&root.0)?;
        store.set_meta(HEAD_SESSION_FILE, journal)?;
        store.set_meta("main:sessionId", "same")?;
        store.set_meta("main:generation", "3")?;
        store.set_meta("head:model-settings:same", r#"{"settings":{},"clearedRoles":["advisor"]}"#)?;
        store.set_meta("gateway:head", &original.to_string())?;
        store.begin_effect("group-reply", "sendGroup", &[])?;
        assert!(!store.begin_rotation(None, None, &stopping)?);
        store.finish_effect("group-reply", &json!({"ok":true}))?;
        assert!(store.begin_rotation(None, None, &stopping)?);
        assert!(store.begin_effect("late-send", "send", &[]).is_err());
        assert!(store.admit(&json!({"kind":"reconnect"}))?);
        assert!(!store.has_wake_input()?);
        for id in ["first", "second"] {
            assert!(store.admit(&json!({"kind":"message","input":{"id":id}}))?);
        }
        assert!(store.has_wake_input()?);
        assert!(store.next(None)?.is_none());
        plan["stage"] = json!("sleeping");
        store.commit_hibernation(&stopping, &plan.to_string(), HibernationChange::Park)?;
    }
    let store = Store::open(&root.0)?;
    let sleeping = plan.to_string();
    assert_eq!(store.get_meta("gateway:head")?.as_deref(), Some("null"));
    assert_eq!(store.get_meta(HEAD_SESSION_FILE)?.as_deref(), Some(journal));
    assert_eq!(store.get_meta("main:sessionId")?.as_deref(), Some("same"));
    assert_eq!(store.get_meta("main:generation")?.as_deref(), Some("3"));
    let saved: serde_json::Value = serde_json::from_str(
        &store.get_meta("head:model-settings:same")?.context("Missing preserved HEAD selection")?,
    )?;
    assert_eq!(saved, json!({"settings":settings,"clearedRoles":["advisor"]}));
    assert!(store.next(None)?.is_none());
    plan["stage"] = json!("launching");
    plan["replacementSessionId"] = json!("same");
    let launching = plan.to_string();
    store.commit_hibernation(&sleeping, &launching, HibernationChange::ReserveWake)?;
    assert!(store.commit_hibernation(&sleeping, &launching, HibernationChange::ReserveWake).is_err());
    plan["replacementOwnerPid"] = json!(202);
    let owned = plan.to_string();
    store.commit_hibernation(&launching, &owned, HibernationChange::RecordOwner)?;
    assert!(store.next(None)?.is_none());

    let mut awake = original;
    awake["pid"] = json!(201);
    awake["ownerPid"] = json!(202);
    plan["stage"] = json!("complete");
    let complete = plan.to_string();
    let mut wrong = awake.clone();
    wrong["sessionId"] = json!("other");
    assert!(store.commit_hibernation(&owned, &complete, HibernationChange::Publish(&wrong)).is_err());
    store.set_meta("gateway:operator-stop", "stop")?;
    assert!(store.commit_hibernation(&owned, &complete, HibernationChange::Publish(&awake)).is_err());
    assert_eq!(store.get_meta(HEAD_ROTATION)?.as_deref(), Some(owned.as_str()));
    assert!(store.next(None)?.is_none());

    // The unchanged stop boundary is the successful publication control.
    store.db()?.execute("DELETE FROM metadata WHERE key='gateway:operator-stop'", [])?;
    store.commit_hibernation(&owned, &complete, HibernationChange::Publish(&awake))?;
    let reconnect = store.next(None)?.context("Original transport notice missing")?;
    assert_eq!(reconnect.event["kind"], "reconnect");
    store.receipt(reconnect.sequence, GatewayReceipt::Accepted)?;
    for id in ["first", "second"] {
        let frame = store.next(None)?.context("Durably buffered input missing")?;
        assert_eq!(frame.event["input"]["id"], id);
        store.receipt(frame.sequence, GatewayReceipt::Accepted)?;
    }
    assert!(store.next(None)?.is_none());
    assert_eq!(store.get_meta("main:generation")?.as_deref(), Some("3"));
    Ok(())
}

#[test]
fn operator_stop_retires_only_the_exact_parked_hibernation() -> Result<()> {
    let root = StateDir::new()?;
    let store = Store::open(&root.0)?;
    let journal = "/saved/sessions/main/rotated/current/session.jsonl";
    let original = json!({"sessionId":"same","sessionFile":journal,"pid":101,"ownerPid":102});
    let mut plan = json!({"id":"sleep","mode":"hibernate","stage":"stopping","original":original,
        "sessionFile":journal,"stopBoundary":null,"resumeProfileHash":"old-profile",
        "attestation":{"generation":3,"selection":{"modelSettings":{"modelRoles":{"default":"provider/model"}}}}});
    store.set_meta(HEAD_SESSION_FILE, journal)?;
    store.set_meta("main:sessionId", "same")?;
    store.set_meta("main:generation", "3")?;
    store.set_meta("gateway:head", &original.to_string())?;
    let stopping = plan.to_string();
    assert!(store.begin_rotation(None, None, &stopping)?);

    plan["stage"] = json!("sleeping");
    // A failed spawn must restore the exact checkpoint bytes, not a
    // reserialized approximation or a checkpoint at the new stop fence.
    let sleeping = serde_json::to_string_pretty(&plan)?;
    store.commit_hibernation(&stopping, &sleeping, HibernationChange::Park)?;
    let mut wake = plan.clone();
    wake["stage"] = json!("launching");
    wake["configHash"] = json!("wake-config");
    wake["replacementSessionId"] = json!("same");
    let reserved = wake.to_string();
    store.commit_hibernation(&sleeping, &reserved, HibernationChange::ReserveWake)?;
    store.set_meta("gateway:operator-stop", "current-stop")?;
    let mut incorrectly_rebased = plan.clone();
    incorrectly_rebased["stopBoundary"] = json!("current-stop");
    assert!(store.commit_hibernation(&reserved, &incorrectly_rebased.to_string(),
        HibernationChange::ReleaseUnspawnedWake).is_err());
    store.commit_hibernation(&reserved, &sleeping, HibernationChange::ReleaseUnspawnedWake)?;
    assert_eq!(store.get_meta(HEAD_ROTATION)?.as_deref(), Some(sleeping.as_str()));
    assert!(store.commit_hibernation(&sleeping, &wake.to_string(), HibernationChange::ReserveWake).is_err());
    wake["stopBoundary"] = json!("current-stop");
    assert!(store.commit_hibernation(&sleeping, &wake.to_string(), HibernationChange::ReserveWake).is_err());

    let settings = store.get_meta("head:model-settings:same")?.context("Missing parked HEAD settings")?;
    plan["stage"] = json!("complete");
    plan["resumeProfileHash"] = json!(null);
    plan["stopBoundary"] = json!("stale-stop");
    assert!(store.commit_hibernation(&sleeping, &plan.to_string(), HibernationChange::OperatorStopped).is_err());
    plan["stopBoundary"] = json!("current-stop");
    let retired = serde_json::to_string_pretty(&plan)?;
    store.set_meta("gateway:head", &original.to_string())?;
    assert!(store.commit_hibernation(&sleeping, &retired, HibernationChange::OperatorStopped).is_err());
    assert_eq!(store.get_meta(HEAD_ROTATION)?.as_deref(), Some(sleeping.as_str()));

    store.set_meta("gateway:head", "null")?;
    store.commit_hibernation(&sleeping, &retired, HibernationChange::OperatorStopped)?;
    assert_eq!(store.get_meta(HEAD_ROTATION)?.as_deref(), Some(retired.as_str()));
    assert!(store.commit_hibernation(&sleeping, &wake.to_string(), HibernationChange::ReserveWake).is_err());

    let started = json!({"sessionId":"same","sessionFile":journal,"pid":201,"ownerPid":202});
    plan["stage"] = json!("launching");
    plan["configHash"] = json!("new-config");
    plan["resumeProfileHash"] = json!("new-profile");
    plan["replacementSessionId"] = json!("same");
    store.set_meta("gateway:operator-stop", "later-stop")?;
    assert!(store.commit_hibernation(&retired, &plan.to_string(), HibernationChange::ReserveOperatorStart).is_err());
    assert_eq!(store.get_meta("gateway:head")?.as_deref(), Some("null"));
    plan["stopBoundary"] = json!("later-stop");
    let reserved = plan.to_string();
    store.commit_hibernation(&retired, &reserved, HibernationChange::ReserveOperatorStart)?;
    assert!(store.commit_hibernation(&retired, &reserved, HibernationChange::ReserveOperatorStart).is_err());
    store.set_meta("gateway:operator-stop", "newer-stop")?;
    store.commit_hibernation(&reserved, &retired, HibernationChange::ReleaseUnspawnedWake)?;
    assert_eq!(store.get_meta(HEAD_ROTATION)?.as_deref(), Some(retired.as_str()));
    assert_eq!(store.get_meta("gateway:operator-stop")?.as_deref(), Some("newer-stop"));
    assert!(store.commit_hibernation(&retired, &reserved, HibernationChange::ReserveOperatorStart).is_err());
    plan["stopBoundary"] = json!("newer-stop");
    let reserved = plan.to_string();
    store.commit_hibernation(&retired, &reserved, HibernationChange::ReserveOperatorStart)?;
    plan["replacementOwnerPid"] = json!(202);
    let owned = plan.to_string();
    store.commit_hibernation(&reserved, &owned, HibernationChange::RecordOwner)?;
    assert!(store.commit_hibernation(&reserved, &retired, HibernationChange::ReleaseUnspawnedWake).is_err());
    assert!(store.commit_hibernation(&owned, &retired, HibernationChange::ReleaseUnspawnedWake).is_err());
    drop(store);
    let store = Store::open(&root.0)?;
    assert_eq!(store.get_meta(HEAD_ROTATION)?.as_deref(), Some(owned.as_str()));
    assert_eq!(store.get_meta("gateway:head")?.as_deref(), Some("null"));
    plan["stage"] = json!("complete");
    let published = plan.to_string();
    store.commit_hibernation(&owned, &published, HibernationChange::Publish(&started))?;
    assert_eq!(store.get_meta("gateway:head")?, Some(started.to_string()));
    assert_eq!(store.get_meta(HEAD_ROTATION)?.as_deref(), Some(published.as_str()));
    store.set_meta("gateway:head", "null")?;
    assert!(store.commit_hibernation(&published, &reserved, HibernationChange::ReserveOperatorStart).is_err());
    for (key, expected) in [
        (HEAD_SESSION_FILE, journal),
        ("main:sessionId", "same"),
        ("main:generation", "3"),
        ("head:model-settings:same", settings.as_str()),
    ] {
        assert_eq!(store.get_meta(key)?.as_deref(), Some(expected));
    }
    Ok(())
}

#[test]
fn legacy_pending_and_generic_error_callbacks_require_original_state_reconciliation() -> Result<()>
{
    let root = StateDir::new()?;
    let legacy = Connection::open(root.0.join("coordination.sqlite"))?;
    legacy.execute_batch(
        "CREATE TABLE gateway_events (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT, identity TEXT NOT NULL UNIQUE,
            data TEXT NOT NULL, received_at INTEGER NOT NULL, delivered_at INTEGER, delivery_error TEXT
         );",
    )?;
    let route = json!({"platform":"telegram","accountId":"bot","authorityId":"owner",
        "guildId":null,"channelId":"chat","threadId":null});
    for (id, delivered, error) in [
        ("pending", None, None),
        (
            "generic-error",
            Some(2),
            Some("Head rejected admitted event"),
        ),
    ] {
        let event =
            json!({"kind":"answer","approvalId":id,"route":route,"response":{"confirmed":true}});
        legacy.execute(
            "INSERT INTO gateway_events(identity,data,received_at,delivered_at,delivery_error)
             VALUES(?,?,1,?,?)",
            params![format!("answer:{id}"), event.to_string(), delivered, error],
        )?;
    }
    drop(legacy);

    {
        let store = Store::open(&root.0)?;
        let first = store
            .next(None)?
            .context("Original pending callback missing")?;
        assert_eq!(first.event["approvalId"], "pending");
        assert_eq!(first.reconciliation, Some(true));
        store.receipt(first.sequence, GatewayReceipt::Rejected)?;
    }
    let store = Store::open(&root.0)?;
    let old_error = store
        .next(None)?
        .context("Legacy failure was not recovered")?;
    assert_eq!(old_error.event["approvalId"], "generic-error");
    assert_eq!(old_error.reconciliation, Some(true));
    assert_eq!(store.unresolved()?, 1);
    Ok(())
}

#[test]
fn callback_admission_proof_survives_head_receipt_without_proving_foreign_answers() -> Result<()> {
    let root = StateDir::new()?;
    let route = json!({"platform":"telegram","accountId":"bot","authorityId":"owner",
        "guildId":null,"channelId":"chat","threadId":null,"topicId":"original"});
    let response =
        json!({"answers":[{"id":"question","selectedOptions":["one","two"],"customInput":"text"}]});
    {
        let store = Store::open(&root.0)?;
        assert!(store.admit(
            &json!({"kind":"answer","approvalId":"card","route":route,"response":response})
        )?);
        let frame = store.next(None)?.context("Committed answer missing")?;
        store.receipt(frame.sequence, GatewayReceipt::Accepted)?;
    }
    let store = Store::open(&root.0)?;
    assert!(!store.has_pending_answer("card", &route)?);
    let reordered_keys =
        json!({"answers":[{"customInput":"text","selectedOptions":["one","two"],"id":"question"}]});
    let digest = answer_digest(&reordered_keys)?;
    assert!(store.has_durable_answer("card", &route, &digest)?);
    assert!(!store.has_durable_answer("different-card", &route, &digest)?);
    for (field, different) in [
        ("topicId", "different-topic"),
        ("accountId", "different-bot"),
        ("authorityId", "different-owner"),
    ] {
        let mut foreign = route.clone();
        foreign[field] = json!(different);
        assert!(!store.has_durable_answer("card", &foreign, &digest)?);
    }
    let reordered_choices =
        json!({"answers":[{"id":"question","selectedOptions":["two","one"],"customInput":"text"}]});
    assert!(!store.has_durable_answer("card", &route, &answer_digest(&reordered_choices)?)?);
    Ok(())
}

#[test]
fn restart_authority_retains_exact_source_route_and_historical_receipt() -> Result<()> {
    let root = StateDir::new()?;
    let store = Store::open(&root.0)?;
    let head = Connection::open(root.0.join("coordination.sqlite"))?;
    head.execute_batch(
        "CREATE TABLE inputs (id TEXT PRIMARY KEY, data TEXT NOT NULL, target TEXT, state TEXT);
         CREATE TABLE outputs (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, route TEXT NOT NULL, state TEXT, remote_id TEXT);",
    )?;
    for id in ["first", "latest"] {
        let route = json!({"platform":"telegram","accountId":"bot","authorityId":"owner",
            "guildId":null,"channelId":"chat","threadId":null,"topicId":id});
        let input = json!({"id":id,"text":" /restart\n","route":route});
        head.execute(
            "INSERT INTO inputs VALUES(?,?,'main','done')",
            params![id, input.to_string()],
        )?;
        let mut wrong_route = route.clone();
        wrong_route["topicId"] = json!("another-topic");
        let ack = format!("{id}-ack");
        head.execute(
            "INSERT INTO outputs VALUES(?,?,?,'sent','sent-message')",
            params![ack, id, wrong_route.to_string()],
        )?;
        store.set_meta(&format!("user-source:{id}"), "true")?;
        let record = json!({"requestId":id,"inputId":id,"ackOutputId":ack,"gatewayPid":2,
            "headPid":3,"sessionId":"head","sessionFile":"/head.jsonl","state":"accepted"});
        assert!(
            store.set_restart(&record).is_err(),
            "a different topic must not grant restart authority"
        );
        assert!(store.get_restart(Some(id))?.is_none());
        head.execute(
            "UPDATE outputs SET route=? WHERE id=?",
            params![route.to_string(), ack],
        )?;
        for (field, value) in [("telegramProtectedCommand", json!(true)), ("routingText", json!(""))] {
            let mut example = input.clone();
            example[field] = value;
            head.execute("UPDATE inputs SET data=? WHERE id=?", params![example.to_string(), id])?;
            assert!(store.set_restart(&record).is_err(), "an example with a sent reply must not authorize restart");
        }
        head.execute("UPDATE inputs SET data=? WHERE id=?", params![input.to_string(), id])?;
        store.set_restart(&record)?;
    }
    let mut old = store
        .get_restart(Some("first"))?
        .context("Missing accepted restart")?;
    old["state"] = json!("refused");
    store.set_restart(&old)?;
    drop(store);
    let reopened = Store::open(&root.0)?;
    assert_eq!(
        reopened
            .get_restart(None)?
            .context("Missing latest restart")?["requestId"],
        "latest"
    );
    assert_eq!(reopened.get_restart(Some("first"))?, Some(old));
    Ok(())
}

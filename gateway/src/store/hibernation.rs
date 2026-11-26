use anyhow::{Context, Result, ensure};
use rusqlite::{Connection, TransactionBehavior};
use serde_json::{Value, json};

use super::{HEAD_ROTATION, HEAD_SESSION_FILE, Store, get_meta, set_meta, string};
use crate::adapter::EffectError;

pub(super) fn require_awake(db: &Connection) -> Result<()> {
    let held: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM metadata WHERE key=?
          AND json_extract(value,'$.mode')='hibernate'
          AND json_extract(value,'$.stage') IN ('stopping','sleeping','launching'))",
        [HEAD_ROTATION],
        |row| row.get(0),
    )?;
    ensure!(!held, EffectError::rejected("HEAD is not awake; no Gateway effect was attempted"));
    Ok(())
}

pub(crate) enum HibernationChange<'a> {
    Refused,
    Park,
    ReserveWake,
    ReleaseUnspawnedWake,
    RecordOwner,
    StopWake,
    Publish(&'a Value),
    OperatorStopped,
    ReserveOperatorStart,
}

impl Store {
    /// Compare the durable plan byte for byte. Wake owns an exact launch
    /// reservation before spawning; publication cannot survive a new stop
    /// fence. No hibernation transition changes the native session pointer.
    pub(crate) fn commit_hibernation(
        &self,
        expected: &str,
        next: &str,
        change: HibernationChange<'_>,
    ) -> Result<()> {
        let mut db = self.db()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure!(get_meta(&tx, HEAD_ROTATION)?.as_deref() == Some(expected),
            "Durable HEAD hibernation changed");
        let prior: Value = serde_json::from_str(expected)?;
        let plan: Value = serde_json::from_str(next)?;
        let session = string(&prior["original"], "sessionId")?;
        let file = string(&prior, "sessionFile")?;
        let generation = get_meta(&tx, "main:generation")?.as_deref().unwrap_or("0").parse::<u64>()?;
        ensure!(prior["mode"] == "hibernate" && plan["mode"] == "hibernate"
            && prior["id"] == plan["id"] && prior["original"] == plan["original"]
            && prior["attestation"] == plan["attestation"] && prior["sessionFile"] == plan["sessionFile"]
            && prior["original"]["sessionFile"].as_str() == Some(file)
            && get_meta(&tx, HEAD_SESSION_FILE)?.is_none_or(|saved| saved == file)
            && get_meta(&tx, "main:sessionId")?.as_deref() == Some(session)
            && prior["attestation"]["generation"].as_u64() == Some(generation),
            "Durable HEAD hibernation session identity changed");
        let before = string(&prior, "stage")?;
        let after = string(&plan, "stage")?;
        let head: Value = serde_json::from_str(
            &get_meta(&tx, "gateway:head")?.context("Missing durable HEAD ownership")?,
        )?;
        if !matches!(&change, HibernationChange::OperatorStopped | HibernationChange::ReserveOperatorStart
            | HibernationChange::ReleaseUnspawnedWake)
        {
            ensure!(prior["stopBoundary"] == plan["stopBoundary"] && prior["resumeProfileHash"] == plan["resumeProfileHash"],
                "HEAD hibernation wake authority or resume profile changed");
        }
        if matches!(&change, HibernationChange::ReserveWake | HibernationChange::Publish(_)
            | HibernationChange::OperatorStopped | HibernationChange::ReserveOperatorStart)
        {
            ensure!(get_meta(&tx, "gateway:operator-stop")?.as_deref() == plan["stopBoundary"].as_str()
                && !get_meta(&tx, "head:restart-fence")?.is_some_and(|value| !value.is_empty()),
                "Gateway stop or restart fence changed during HEAD hibernation transition");
        }
        let unclaimed = |record: &Value| ["replacementOwnerPid", "replacementSessionId", "wakeStop"]
            .into_iter().all(|key| record[key].is_null());
        match change {
            HibernationChange::Refused => {
                ensure!((before, after) == ("stopping", "refused") && head == prior["original"],
                    "HEAD hibernation shutdown refusal is not current");
            }
            HibernationChange::Park => {
                ensure!(after == "sleeping" && ((before == "stopping" && head == prior["original"])
                    || (before == "launching" && head.is_null() && prior["wakeStop"].is_object())),
                    "HEAD hibernation exit proof is not current");
                let key = format!("head:model-settings:{session}");
                let cleared_roles = get_meta(&tx, &key)?
                    .map(|saved| serde_json::from_str::<Value>(&saved)).transpose()?
                    .and_then(|saved| saved.get("clearedRoles").cloned()).unwrap_or_else(|| json!([]));
                let settings = &plan["attestation"]["selection"]["modelSettings"];
                set_meta(&tx, &key, &json!({ "settings": settings, "clearedRoles": cleared_roles }).to_string())?;
                set_meta(&tx, "gateway:head", "null")?;
            }
            HibernationChange::ReserveWake => {
                ensure!((before, after) == ("sleeping", "launching") && head.is_null()
                    && plan["replacementOwnerPid"].is_null()
                    && plan["replacementSessionId"].as_str() == Some(session),
                    "HEAD is not available to reserve for wake");
            }
            HibernationChange::ReleaseUnspawnedWake => {
                // No spawn means no owner or shutdown effect to reconcile. A newer
                // stop fence must not prevent restoring (or authorize waking) the
                // saved checkpoint: restore its original fence bytes unchanged.
                let restores_checkpoint = match after {
                    "sleeping" => prior["stopBoundary"] == plan["stopBoundary"]
                        && prior["resumeProfileHash"] == plan["resumeProfileHash"],
                    "complete" => plan["resumeProfileHash"].is_null()
                        && plan["stopBoundary"].as_str().is_some_and(|stop| !stop.is_empty()),
                    _ => false,
                };
                ensure!(before == "launching" && head.is_null() && restores_checkpoint
                    && prior["replacementOwnerPid"].is_null() && prior["wakeStop"].is_null()
                    && prior["replacementSessionId"].as_str() == Some(session)
                    && unclaimed(&plan),
                    "HEAD wake reservation is not an unspawned launch");
            }
            HibernationChange::RecordOwner => {
                ensure!(before == "launching" && after == before && head.is_null()
                    && prior["replacementOwnerPid"].is_null()
                    && plan["replacementOwnerPid"].as_u64().is_some_and(|pid| pid > 0)
                    && plan["replacementSessionId"] == prior["replacementSessionId"],
                    "HEAD wake reservation already has an owner");
            }
            HibernationChange::StopWake => {
                ensure!(before == "launching" && after == before && head.is_null()
                    && prior["replacementOwnerPid"] == plan["replacementOwnerPid"]
                    && prior["replacementSessionId"] == plan["replacementSessionId"]
                    && prior["wakeStop"].is_null() != plan["wakeStop"].is_null(),
                    "HEAD wake shutdown attempt is not current");
            }
            HibernationChange::Publish(awakened) => {
                ensure!((before, after) == ("launching", "complete") && head.is_null()
                    && prior["wakeStop"].is_null()
                    && prior["replacementOwnerPid"].as_u64().is_some_and(|pid| pid > 0)
                    && awakened["ownerPid"] == prior["replacementOwnerPid"]
                    && awakened["sessionFile"].as_str() == Some(file)
                    && awakened["sessionId"].as_str() == Some(session),
                    "HEAD wake launch ownership was not proved");
                set_meta(&tx, "gateway:head", &awakened.to_string())?;
            }
            HibernationChange::OperatorStopped => {
                ensure!((before, after) == ("sleeping", "complete") && head.is_null()
                    && plan["stopBoundary"].as_str().is_some_and(|stop| !stop.is_empty())
                    && prior["stopBoundary"] != plan["stopBoundary"]
                    && plan["resumeProfileHash"].is_null()
                    && unclaimed(&prior) && unclaimed(&plan),
                    "HEAD hibernation does not have a clean parked owner at this operator stop fence");
            }
            HibernationChange::ReserveOperatorStart => {
                ensure!((before, after) == ("complete", "launching") && head.is_null()
                    && prior["resumeProfileHash"].is_null() && unclaimed(&prior) && plan["wakeStop"].is_null()
                    && plan["stopBoundary"].as_str().is_some_and(|stop| !stop.is_empty())
                    && plan["configHash"].as_str().is_some_and(|hash| !hash.is_empty())
                    && plan["resumeProfileHash"].as_str().is_some_and(|hash| !hash.is_empty())
                    && plan["replacementOwnerPid"].is_null()
                    && plan["replacementSessionId"].as_str() == Some(session),
                    "Explicit HEAD startup cannot reserve the retired hibernation checkpoint");
            }
        }
        set_meta(&tx, HEAD_ROTATION, next)?;
        tx.commit()?;
        Ok(())
    }
}

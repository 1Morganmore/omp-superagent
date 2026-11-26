use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Result, ensure};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde_json::{Value, json};

use super::{PHYSICAL_ROUTE_FIELDS, Store, now, string};

pub(crate) fn history_gap(platform: &str) -> Result<Value> {
    let before = i64::try_from(SystemTime::now().duration_since(UNIX_EPOCH)?.as_micros())?;
    Ok(json!({
        "kind": "reconnect", "historyRecovery": true,
        "historyPlatform": platform, "historyBeforeUs": before,
    }))
}

fn pending_fence(db: &Connection, sequence: i64, platform: &str) -> Result<Option<i64>> {
    Ok(db.query_row(
        "SELECT COALESCE(json_extract(data,'$.historyBeforeUs'), received_at*1000)
         FROM gateway_events
         WHERE sequence=?1 AND delivered_at IS NULL AND identity LIKE 'reconnect:%'
           AND json_extract(data,'$.historyRecovery')=1
           AND (json_extract(data,'$.historyPlatform') IS NULL
                OR json_extract(data,'$.historyPlatform')=?2)",
        params![sequence, platform],
        |row| row.get(0),
    ).optional()?)
}

impl Store {
    /// The requested fence comes from the immutable pending gap, never from
    /// the controller's clock or the time at which the REST read finally runs.
    pub(crate) fn history_fence(&self, sequence: i64, platform: &str) -> Result<Option<i64>> {
        let db = self.db()?;
        pending_fence(&db, sequence, platform)
    }

    pub(crate) fn ordered_history(
        &self,
        route: &Value,
        sequence: Option<i64>,
        history: Vec<Value>,
    ) -> Result<Vec<Value>> {
        let mut db = self.db()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(sequence) = sequence {
            // A cancelled HEAD can lose an RPC while the adapter's read
            // finishes. A superseded scan cannot append new ingress.
            ensure!(pending_fence(&tx, sequence, string(route, "platform")?)?.is_some(),
                "History gap is no longer pending");
        }
        let mut result = Vec::with_capacity(history.len());
        let mut deferred = false;
        {
            let mut queued = tx.prepare_cached(
                "SELECT EXISTS(SELECT 1 FROM gateway_events
                 WHERE identity=?1 AND (delivered_at IS NULL OR delivery_error='rejected')),
                 EXISTS(SELECT 1 FROM gateway_events
                 WHERE delivered_at IS NULL AND identity LIKE 'message:%'
                   AND json_extract(data,'$.input.messageId')=?2
                   AND json_extract(data,'$.input.route.platform')=json_extract(?3,'$.platform')
                   AND json_extract(data,'$.input.route.accountId')=json_extract(?3,'$.accountId')
                   AND json_extract(data,'$.input.route.authorityId')=json_extract(?3,'$.authorityId')
                   AND json_extract(data,'$.input.route.channelId')=json_extract(?3,'$.channelId')
                   AND json_extract(data,'$.input.route.guildId') IS json_extract(?3,'$.guildId')
                   AND json_extract(data,'$.input.route.threadId') IS json_extract(?3,'$.threadId'))",
            )?;
            let physical = route.to_string();
            for input in history {
                ensure!(PHYSICAL_ROUTE_FIELDS.iter().all(|field|
                    input["route"].get(*field) == route.get(*field)), "History crossed physical routes");
                let identity = format!("message:{}", string(&input, "id")?);
                let id = string(&input, "messageId")?;
                let (exact, original_pending): (bool, bool) = queued.query_row(
                    params![identity, id, physical], |row| Ok((row.get(0)?, row.get(1)?)),
                )?;
                if exact {
                    continue;
                }
                if original_pending && sequence.is_some() {
                    // The live receipt owns the original position. Keep the
                    // distinct revision in the inbox so the head can inherit
                    // the original topic, even if this scan or HEAD is lost.
                    let event = json!({"kind": "message", "input": input, "historyDeferred": true});
                    deferred |= tx.execute(
                        "INSERT INTO gateway_events(identity,data,received_at) VALUES (?,?,?)
                         ON CONFLICT(identity) DO NOTHING",
                        params![identity, event.to_string(), now()?],
                    )? > 0;
                } else if !original_pending {
                    result.push(input);
                }
            }
        }
        tx.commit()?;
        if deferred {
            self.ingress.notify_one();
        }
        Ok(result)
    }
}

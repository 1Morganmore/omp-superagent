use anyhow::{Result, ensure};
use rusqlite::{Connection, OptionalExtension, params};

use super::Store;

const MAX_PENDING: u32 = 1024;
const MAX_PAYLOAD_BYTES: usize = 128 * 1024;

pub(super) fn create(db: &Connection) -> Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS discord_owner_intake (
           sequence INTEGER PRIMARY KEY AUTOINCREMENT,
           account_id TEXT NOT NULL, owner_id TEXT NOT NULL, channel_id TEXT NOT NULL,
           data TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS discord_owner_intake_route
           ON discord_owner_intake(account_id, owner_id, channel_id);",
    )?;
    Ok(())
}

pub(crate) struct DiscordIntake<'a>(pub(crate) &'a Store);

impl DiscordIntake<'_> {
    pub(crate) fn push(&self, source: (&str, &str, &str), data: &str) -> Result<i64> {
        ensure!(data.len() <= MAX_PAYLOAD_BYTES, "Discord candidate exceeds its storage limit");
        let db = self.0.db()?;
        let inserted = db.execute(
            "INSERT INTO discord_owner_intake(account_id, owner_id, channel_id, data)
             SELECT ?1, ?2, ?3, ?4 WHERE (SELECT COUNT(*) FROM discord_owner_intake) < ?5",
            params![source.0, source.1, source.2, data, MAX_PENDING],
        )?;
        ensure!(inserted == 1, "Discord durable intake is full");
        Ok(db.last_insert_rowid())
    }

    pub(crate) fn last(&self) -> Result<Option<i64>> {
        Ok(self.0.db()?.query_row("SELECT MAX(sequence) FROM discord_owner_intake", [], |row| {
            row.get(0)
        })?)
    }

    pub(crate) fn next(&self, through: i64) -> Result<Option<(i64, String)>> {
        Ok(self.0.db()?.query_row(
            "SELECT sequence, data FROM discord_owner_intake WHERE sequence <= ?
             ORDER BY sequence LIMIT 1",
            [through],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional()?)
    }

    pub(crate) fn contains(&self, source: (&str, &str, &str)) -> Result<bool> {
        Ok(self.0.db()?.query_row(
            "SELECT EXISTS(SELECT 1 FROM discord_owner_intake
             WHERE account_id=?1 AND owner_id=?2 AND channel_id=?3)",
            params![source.0, source.1, source.2],
            |row| row.get(0),
        )?)
    }

    pub(crate) fn pin(&self, sequence: i64, data: &str) -> Result<()> {
        ensure!(data.len() <= MAX_PAYLOAD_BYTES, "Discord candidate exceeds its storage limit");
        let updated = self.0.db()?.execute(
            "UPDATE discord_owner_intake SET data=? WHERE sequence=?",
            params![data, sequence],
        )?;
        ensure!(updated == 1, "Discord candidate disappeared before verification");
        Ok(())
    }

    pub(crate) fn retire(&self, sequence: i64) -> Result<()> {
        self.0.db()?.execute("DELETE FROM discord_owner_intake WHERE sequence=?", [sequence])?;
        Ok(())
    }
}

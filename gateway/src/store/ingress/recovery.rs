use std::sync::LazyLock;

use rusqlite::{Connection, OptionalExtension};

use super::EventRow;

static RANK: LazyLock<String> = LazyLock::new(|| {
    include_str!("recovery_rank.sql").replace(
        "{whitespace}",
        // ECMAScript WhiteSpace and LineTerminator, matching js_trim.
        "char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,\
         8200,8201,8202,8232,8233,8239,8287,12288,65279)",
    )
});

pub(in crate::store) fn create(db: &Connection) -> rusqlite::Result<()> {
    // The partial index builds from legacy rows without rewriting any event.
    // Its built-in SQL expressions also maintain it for other SQLite writers.
    let rank = RANK.as_str();
    db.execute_batch(&format!(
        "CREATE INDEX IF NOT EXISTS gateway_events_recovery ON gateway_events(({rank}), sequence)
         WHERE delivered_at IS NULL AND ({rank}) IS NOT NULL;"
    ))
}

pub(in crate::store) static NEXT: LazyLock<String> = LazyLock::new(|| {
    let rank = RANK.as_str();
    format!(
        "SELECT sequence,data,attempted_at FROM gateway_events WHERE sequence=(
           SELECT CASE WHEN head.delivery_error='unresolved' THEN COALESCE((
             SELECT sequence FROM gateway_events INDEXED BY gateway_events_recovery
             WHERE delivered_at IS NULL AND ({rank}) IS NOT NULL
             ORDER BY ({rank}),sequence LIMIT 1
           ),head.sequence) ELSE head.sequence END
           FROM (SELECT sequence,delivery_error FROM gateway_events
                 WHERE delivered_at IS NULL ORDER BY sequence LIMIT 1) AS head
         )"
    )
});

pub(in crate::store) static PENDING_BARRIER: LazyLock<String> = LazyLock::new(|| {
    let rank = RANK.as_str();
    format!(
        "SELECT json_extract(data,'$.barrier') FROM gateway_events INDEXED BY gateway_events_recovery
         WHERE delivered_at IS NULL AND ({rank}) IS NOT NULL AND ({rank})=0
           AND json_type(data,'$.barrier')='text'
         ORDER BY sequence LIMIT 1"
    )
});

pub(super) fn next(db: &Connection) -> rusqlite::Result<Option<EventRow>> {
    // Resolve the head and any quarantine exception in one snapshot. Only
    // the chosen row is fetched: barriers first, then controls, then the head.
    db.prepare_cached(&NEXT)?
        .query_row([], EventRow::read)
        .optional()
}

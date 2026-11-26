use std::{
    fs,
    io::{self, BufRead, BufReader, ErrorKind, Read},
    os::unix::fs::MetadataExt,
    path::Path,
    time::Instant,
};

use crate::journal_format::{
    ObjectEnd, invalid_journal, is_json_string, is_title_slot, json_space, object_fields,
    open_journal, same_file, session_id, text_field,
};

/// Read the original, size-bounded record stream: active branches,
/// compaction, external blobs and tool spill links do not supply proof.
pub(crate) fn scan(
    path: &Path,
    expected_id: &str,
    deadline: Instant,
    mut visit: impl FnMut([Option<&str>; 3]),
) -> io::Result<bool> {
    let (file, initial) = open_journal(path)?.ok_or_else(invalid_journal)?;
    let mut reader = BufReader::with_capacity(16 * 1024, file.take(initial.len()));
    let mut record = Vec::new();
    let mut end = ObjectEnd::default();
    let mut first_line = true;
    let mut header_matches = None;
    loop {
        before_deadline(deadline)?;
        let offset = record.len();
        if reader.read_until(b'\n', &mut record)? == 0 {
            break;
        }
        if record.last() != Some(&b'\n') {
            return Ok(false);
        }
        let title_slot = first_line && is_title_slot(&record);
        first_line = false;
        if offset == 0 {
            let first = record.iter().copied().find(|&byte| !json_space(byte));
            if title_slot || first.is_none() {
                record.clear();
                continue;
            }
            if first != Some(b'{') {
                return Ok(false);
            }
        }
        // Consume only newly read bytes; parse a multiline record once.
        if end.scan(&record[offset..]).is_none() {
            continue;
        }
        let Ok(text) = std::str::from_utf8(&record) else {
            return Ok(false);
        };
        let Some([kind, id, custom_type, data]) =
            object_fields(text, ["type", "id", "customType", "data"])
        else {
            return Ok(false);
        };
        if !is_json_string(kind) {
            return Ok(false);
        }
        match (header_matches, text_field(kind).as_deref()) {
            (None, Some("session")) => {
                let Some(id) = session_id(id) else {
                    return Ok(false);
                };
                header_matches = Some(id.as_ref() == expected_id);
            }
            (None, _) | (Some(_), Some("session" | "title")) => return Ok(false),
            (Some(_), Some("custom")) => visit([id, custom_type, data]),
            (Some(_), _) => {}
        }
        record.clear();
        end = ObjectEnd::default();
    }
    let Some(header_matches) = header_matches else {
        return Ok(false);
    };
    if !record.is_empty() || reader.into_inner().limit() != 0 {
        return Ok(false);
    }
    let after = fs::metadata(path)?;
    Ok(header_matches
        && same_file(&initial, &after)
        && initial.len() == after.len()
        && initial.mtime() == after.mtime()
        && initial.mtime_nsec() == after.mtime_nsec()
        && initial.ctime() == after.ctime()
        && initial.ctime_nsec() == after.ctime_nsec())
}

pub(crate) fn before_deadline(deadline: Instant) -> io::Result<()> {
    if Instant::now() >= deadline {
        return Err(io::Error::new(
            ErrorKind::TimedOut,
            "Native exit persistence verification timed out",
        ));
    }
    Ok(())
}

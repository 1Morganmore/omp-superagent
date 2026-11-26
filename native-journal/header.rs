use std::{
    borrow::Cow,
    fs,
    io::{self, Read},
    path::Path,
};

use crate::journal_format::{
    ObjectEnd, invalid_journal, is_title_slot, json_space, object_fields, open_journal, same_file,
    session_id, text_field,
};

const HEADER_LIMIT: u64 = 1024 * 1024;
const FIRST_READ: usize = 16 * 1024;

fn header_id(prefix: &[u8]) -> io::Result<Option<String>> {
    let mut body = prefix;
    if let Some(lf) = prefix.iter().position(|&byte| byte == b'\n')
        && is_title_slot(&prefix[..lf])
    {
        body = &prefix[lf + 1..];
    }
    let Some(start) = body.iter().position(|&byte| !json_space(byte)) else {
        return Ok(None);
    };
    let body = &body[start..];
    if body.first() != Some(&b'{') {
        return Ok(None);
    }

    // Parse through the matching brace only. A complete, possibly multiline
    // header need not end in LF, and damage after it is not an identity error.
    let Some(end) = ObjectEnd::default().scan(body) else {
        return Ok(None);
    };
    let text = std::str::from_utf8(&body[..end]).map_err(|_| invalid_journal())?;
    let [kind, id] = object_fields(text, ["type", "id"]).ok_or_else(invalid_journal)?;
    // The object may be a title slot with its physical LF outside this
    // prefix. Allow the next bounded read.
    if text_field(kind).as_deref() == Some("session") {
        return Ok(session_id(id).map(Cow::into_owned));
    }
    Ok(None)
}

/// Bounded identity read. An absent path is different from an existing
/// journal whose native header or file identity cannot be established.
pub(crate) fn read_session_id(path: &Path) -> io::Result<Option<String>> {
    if !path.is_absolute() {
        return Err(invalid_journal());
    }
    let Some((file, initial)) = open_journal(path)? else {
        return Ok(None);
    };
    let mut remaining = file.take(initial.len().min(HEADER_LIMIT));
    let mut prefix = Vec::new();
    while remaining.limit() > 0 {
        let step = u64::try_from(FIRST_READ.max(prefix.len())).map_err(io::Error::other)?;
        if remaining.by_ref().take(step).read_to_end(&mut prefix)? == 0 {
            break;
        }
        if let Some(id) = header_id(&prefix)? {
            if same_file(&initial, &fs::metadata(path)?) {
                return Ok(Some(id));
            }
            break;
        }
    }
    Err(invalid_journal())
}

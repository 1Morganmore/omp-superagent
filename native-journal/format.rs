use std::{
    borrow::Cow,
    fs::{File, Metadata},
    io::{self, ErrorKind},
    os::unix::fs::MetadataExt,
    path::Path,
};

use rustix::fs::{Mode, OFlags, open};
use serde::{
    Deserialize,
    de::{DeserializeOwned, IgnoredAny},
};
use serde_json::Deserializer;

#[derive(Deserialize)]
struct JsonText<'a>(#[serde(borrow)] Cow<'a, str>);

/// Check the object envelope and borrow only the requested fields. IgnoredAny
/// checks the JSON grammar without requiring strings to decode as Rust text.
pub(crate) fn object_fields<'a, const N: usize>(
    text: &'a str,
    names: [&str; N],
) -> Option<[Option<&'a str>; N]> {
    let mut rest = trim_json_start(trim_json_start(text).strip_prefix('{')?);
    let mut fields = [None; N];
    if !rest.starts_with('}') {
        loop {
            if !rest.starts_with('"') {
                return None;
            }
            let (raw_key, tail) = split_json_value(rest)?;
            rest = trim_json_start(tail).strip_prefix(':')?;
            let (raw, tail) = split_json_value(trim_json_start(rest))?;
            // A syntactically valid name with an unpaired surrogate cannot match any requested name.
            if let Some(name) = text_field(Some(raw_key))
                && let Some(index) = names.iter().position(|&key| key == name.as_ref())
            {
                // Like native JSON.parse, the last occurrence wins.
                fields[index] = Some(raw);
            }
            rest = trim_json_start(tail);
            let Some(next) = rest.strip_prefix(',') else {
                break;
            };
            rest = trim_json_start(next);
        }
    }
    trim_json_start(rest.strip_prefix('}')?)
        .is_empty()
        .then_some(fields)
}

fn split_json_value(text: &str) -> Option<(&str, &str)> {
    let mut value = Deserializer::from_str(text).into_iter::<IgnoredAny>();
    value.next()?.ok()?;
    Some(text.split_at(value.byte_offset()))
}

fn trim_json_start(text: &str) -> &str {
    text.trim_start_matches([' ', '\t', '\r', '\n'])
}

pub(crate) fn field<T: DeserializeOwned>(raw: Option<&str>) -> Option<T> {
    serde_json::from_str(raw?).ok()
}

pub(crate) fn text_field(raw: Option<&str>) -> Option<Cow<'_, str>> {
    serde_json::from_str::<JsonText<'_>>(raw?)
        .ok()
        .map(|text| text.0)
}

pub(crate) fn is_json_string(raw: Option<&str>) -> bool {
    raw.is_some_and(|value| value.starts_with('"'))
}

// Open nonblocking before checking the descriptor: a FIFO must not wait for
// another process to open it. Like native resume, these callers follow links.
pub(crate) fn open_journal(path: &Path) -> io::Result<Option<(File, Metadata)>> {
    let file = match open(path, OFlags::RDONLY | OFlags::NONBLOCK | OFlags::CLOEXEC, Mode::empty()) {
        Ok(fd) => File::from(fd),
        Err(rustix::io::Errno::NOENT | rustix::io::Errno::NOTDIR) => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(invalid_journal());
    }
    Ok(Some((file, metadata)))
}

pub(crate) fn invalid_journal() -> io::Error {
    io::Error::new(ErrorKind::InvalidData, "Unrecognized or incomplete native session journal")
}

pub(crate) fn same_file(before: &Metadata, after: &Metadata) -> bool {
    before.dev() == after.dev() && before.ino() == after.ino()
}

pub(crate) const fn json_space(byte: u8) -> bool {
    matches!(byte, b' ' | b'\t' | b'\r' | b'\n')
}

/// Locate an object's closing brace without interpreting any payload. The
/// caller has already established the first non-whitespace byte is `{`; serde
/// validates the whole object once it is available.
#[derive(Default)]
pub(crate) struct ObjectEnd {
    depth: usize,
    quoted: bool,
    escaped: bool,
}

impl ObjectEnd {
    pub(crate) fn scan(&mut self, bytes: &[u8]) -> Option<usize> {
        for (i, byte) in bytes.iter().copied().enumerate() {
            if self.escaped {
                self.escaped = false;
                continue;
            }
            match byte {
                b'\\' if self.quoted => self.escaped = true,
                b'"' => self.quoted = !self.quoted,
                b'{' if !self.quoted => self.depth += 1,
                b'}' if !self.quoted => {
                    self.depth = self.depth.checked_sub(1)?;
                    if self.depth == 0 {
                        return Some(i + 1);
                    }
                }
                _ => {}
            }
        }
        None
    }
}

fn js_space(ch: char) -> bool {
    matches!(
        ch,
        '\u{0009}'..='\u{000D}' | ' ' | '\u{00A0}' | '\u{1680}' | '\u{2000}'..='\u{200A}'
            | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}'
    )
}

/// Stock OMP allows one optional, complete title record on the first
/// physical line. Only this slot gets ECMAScript's wider string trim.
pub(crate) fn is_title_slot(line: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(line) else {
        return false;
    };
    let Some([kind, version, title, updated, pad, source]) = object_fields(
        text.trim_matches(js_space),
        ["type", "v", "title", "updatedAt", "pad", "source"],
    ) else {
        return false;
    };
    text_field(kind).as_deref() == Some("title")
        && field::<f64>(version).is_some_and(|v| v.to_bits() == 1.0_f64.to_bits())
        && [title, updated, pad].into_iter().all(is_json_string)
        && (source.is_none() || matches!(text_field(source).as_deref(), Some("auto" | "user")))
}

pub(crate) fn session_id(raw: Option<&str>) -> Option<Cow<'_, str>> {
    text_field(raw).filter(|id| !id.is_empty())
}

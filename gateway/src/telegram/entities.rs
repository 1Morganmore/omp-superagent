use std::ops::Range;

use serde::{Deserialize, Deserializer};
use serde_json::Value;

use crate::{commands::accepts_text, store::js_trim};

#[derive(Deserialize)]
pub(super) struct Entity {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default, deserialize_with = "utf16_index")]
    pub offset: Option<usize>,
    #[serde(default, deserialize_with = "utf16_index")]
    pub length: Option<usize>,
}

// An unrecognized bound invalidates the routing view, not the owner message.
fn utf16_index<'de, D: Deserializer<'de>>(value: D) -> Result<Option<usize>, D::Error> {
    Ok(Value::deserialize(value)?
        .as_u64()
        .and_then(|value| usize::try_from(value).ok()))
}

impl Entity {
    fn is_protected(&self) -> bool {
        matches!(
            self.kind.as_str(),
            "blockquote" | "expandable_blockquote" | "pre" | "code"
        )
    }
}

pub(super) fn protected_command(entities: &[Entity], utf16_span: Range<usize>) -> bool {
    entities
        .iter()
        .filter(|entity| entity.is_protected())
        .any(|entity| {
            let (Some(start), Some(length)) = (entity.offset, entity.length) else {
                return false;
            };
            start < utf16_span.end && length > utf16_span.start.saturating_sub(start)
        })
}

pub(super) struct QualifiedCommand<'a> {
    pub name: &'a str,
    pub token: &'a str,
    username: &'a str,
    start: usize,
}

impl<'a> QualifiedCommand<'a> {
    pub fn leading(text: &'a str, entities: &[Entity]) -> Option<Self> {
        let (prefix, _) = text.split_once('/')?;
        if !js_trim(prefix).is_empty() {
            return None;
        }
        let command = Self::at(text, entities, prefix)?;
        let start = prefix.encode_utf16().count();
        let end = start.checked_add(command.token.len())?;
        (!protected_command(entities, start..end)).then_some(command)
    }

    fn at(text: &'a str, entities: &[Entity], prefix: &str) -> Option<Self> {
        let offset = prefix.encode_utf16().count();
        let length = entities
            .iter()
            .find(|entity| entity.kind == "bot_command" && entity.offset == Some(offset))?
            .length?;
        // The command token itself is ASCII; only its original offset needs
        // separate UTF-8 and UTF-16 coordinates.
        let start = prefix.len();
        let end = start.checked_add(length)?;
        let token = text.get(start..end)?;
        let rest = &text[end..];
        let (name, username) = token.strip_prefix('/')?.split_once('@')?;
        let word = |value: &str| {
            !value.is_empty()
                && value
                    .bytes()
                    .all(|ch| ch.is_ascii_alphanumeric() || ch == b'_')
        };
        if name.len() > 32
            || !word(name)
            || !word(username)
            || rest
                .chars()
                .next()
                .is_some_and(|ch| !js_trim(&rest[..ch.len_utf8()]).is_empty())
        {
            return None;
        }
        Some(Self {
            name,
            token,
            username,
            start,
        })
    }

    pub fn addressed_to(&self, bot: Option<&str>) -> bool {
        bot.is_some_and(|bot| self.username.eq_ignore_ascii_case(bot))
    }

    fn suffix(&self) -> Range<usize> {
        (self.start + 1 + self.name.len())..(self.start + self.token.len())
    }
}

// Return the original byte range removed so routing entities can be projected
// onto the normalized text.
pub(super) fn command_suffix(
    command: Option<QualifiedCommand<'_>>,
    bot: Option<&str>,
) -> Option<Range<usize>> {
    match command {
        Some(command) if !command.addressed_to(bot) => None,
        Some(command) if accepts_text(command.name).is_some() => Some(command.suffix()),
        Some(_) | None => Some(0..0),
    }
}

pub(super) fn legacy_suffix(
    text: &str,
    entities: &[Entity],
    bot: Option<&str>,
) -> Option<Range<usize>> {
    // Older admission recognized an offset-zero entity even inside code or a
    // quote. This projection is for comparing an existing receipt only.
    command_suffix(QualifiedCommand::at(text, entities, ""), bot)
}

pub(super) fn without_suffix(text: &str, suffix: &Range<usize>) -> String {
    let mut normalized = text.to_owned();
    normalized.replace_range(suffix.clone(), "");
    normalized
}

pub(super) fn command_blocked(
    original: &str,
    entities: &[Entity],
    view: Option<&str>,
) -> bool {
    let trimmed = js_trim(original);
    if trimmed.starts_with('/') {
        if view.is_none() {
            return true;
        }
        // Keep the protected-span comparison on the physical token, before a
        // bot suffix or the contents of any entities are removed.
        let start = original
            .split_once('/')
            .map_or(0, |(prefix, _)| prefix.encode_utf16().count());
        let token = trimmed
            .split(|ch: char| js_trim(ch.encode_utf8(&mut [0; 4])).is_empty())
            .next()
            .unwrap_or_default();
        return protected_command(entities, start..start + token.encode_utf16().count());
    }
    view.is_some_and(|text| js_trim(text).starts_with('/'))
}

pub(super) fn routing_text(
    original: &str,
    normalized: &str,
    entities: &[Entity],
    command_suffix: Range<usize>,
) -> Option<String> {
    let mut excluded = entities
        .iter()
        .filter(|entity| entity.is_protected())
        .peekable();
    if excluded.peek().is_none() {
        return Some(normalized.to_owned());
    }

    // Only Unicode scalar boundaries are valid. A UTF-16 offset in the middle
    // of a surrogate pair has no corresponding UTF-8 index.
    let mut boundaries = Vec::with_capacity(original.len() + 1);
    for (byte, ch) in original.char_indices() {
        boundaries.push(Some(byte));
        if ch.len_utf16() == 2 {
            boundaries.push(None);
        }
    }
    boundaries.push(Some(original.len()));
    let after_command =
        |byte: usize| byte - byte.saturating_sub(command_suffix.start).min(command_suffix.len());
    let mut spans = Vec::new();
    for entity in excluded {
        let offset = entity.offset?;
        let length = entity.length.filter(|length| *length > 0)?;
        let start = after_command((*boundaries.get(offset)?)?);
        let end = after_command((*boundaries.get(offset.checked_add(length)?)?)?);
        if start < end {
            spans.push(start..end);
        }
    }
    spans.sort_unstable_by_key(|span| span.start);

    let mut view = String::with_capacity(normalized.len());
    let mut cursor = 0;
    for span in spans {
        if span.end <= cursor {
            continue;
        }
        if span.start > cursor {
            view.push_str(normalized.get(cursor..span.start)?);
        }
        let masked = normalized.get(span.start.max(cursor)..span.end)?;
        // A redaction is a separator, not a concatenation of neighboring
        // words. Keep line boundaries without carrying any quoted prose.
        if masked.contains(['\r', '\n']) {
            view.extend(masked.chars().filter(|ch| *ch == '\r' || *ch == '\n'));
        } else if !view.is_empty() && !view.ends_with(char::is_whitespace) {
            view.push(' ');
        }
        cursor = span.end;
    }
    view.push_str(normalized.get(cursor..)?);
    if view.trim().is_empty() {
        view.clear();
    }
    Some(view)
}

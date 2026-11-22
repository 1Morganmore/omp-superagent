use super::model::Message;

// Inline code requires a closing run of the same length. An unmatched run is
// literal text, so it must not hide later genuine mentions.
fn code_end(text: &str, opening: usize) -> Option<usize> {
    let (start, mut tail) = text.split_at(opening);
    while let Some(next) = tail.find('`') {
        tail = &tail[next..];
        let length = tail.bytes().take_while(|&byte| byte == b'`').count();
        tail = &tail[length..];
        if length == start.len() {
            return Some(text.len() - tail.len());
        }
    }
    None
}

fn prose_mentions<'a>(
    text: &'a str,
    account: &'a str,
) -> impl Iterator<Item = (usize, usize)> + 'a {
    let mut tail = text;
    std::iter::from_fn(move || {
        while let Some(next) = tail.find(['<', '`', '\\']) {
            tail = &tail[next..];
            let start = text.len() - tail.len();
            let first = tail.as_bytes()[0];
            if first == b'`' {
                let opening = tail.bytes().take_while(|&byte| byte == b'`').count();
                tail = &tail[code_end(tail, opening).unwrap_or(opening)..];
                continue;
            }
            tail = &tail[1..];
            if first == b'\\' && tail.as_bytes().first().is_some_and(u8::is_ascii_punctuation) {
                tail = &tail[1..];
            } else if first == b'<'
                && let Some(after) = tail.strip_prefix('@').and_then(|user| {
                    user.strip_prefix('!')
                        .unwrap_or(user)
                        .strip_prefix(account)?
                        .strip_prefix('>')
                })
            {
                tail = after;
                return Some((start, text.len() - tail.len()));
            }
        }
        None
    })
}

fn fence(line: &str) -> Option<(usize, &str)> {
    let text = line.trim_start_matches(' ');
    let length = text.bytes().take_while(|&byte| byte == b'`').count();
    (line.len() - text.len() <= 3 && length >= 3).then(|| (length, &text[length..]))
}

fn inline_mentions<'a>(
    text: &'a str,
    account: &'a str,
) -> impl Iterator<Item = (usize, usize)> + 'a {
    // Bound inline code to the prose around fenced blocks. Otherwise an
    // unmatched prose tick can pair with a tick inside the fence and cause
    // the rest of that fenced code to be mistaken for ordinary text.
    let mut lines = text.split_inclusive('\n');
    let mut cursor = 0;
    let mut prose_start = 0;
    std::iter::from_fn(move || {
        while let Some(line) = lines.next() {
            let line_start = cursor;
            cursor += line.len();
            if let Some((opening, info)) = fence(line)
                && !info.contains('`')
            {
                let mut remaining = lines.clone();
                let mut end = cursor;
                if remaining.any(|line| {
                    end += line.len();
                    fence(line).is_some_and(|(closing, rest)| closing >= opening && rest.trim().is_empty())
                }) {
                    lines = remaining;
                    cursor = end;
                    let start = std::mem::replace(&mut prose_start, end);
                    if start < line_start {
                        return Some((start, line_start));
                    }
                }
            }
        }
        (prose_start < cursor).then(|| (std::mem::replace(&mut prose_start, cursor), cursor))
    }).flat_map(move |(start, end)| {
        prose_mentions(&text[start..end], account).map(move |(from, to)| (start + from, start + to))
    })
}

pub(super) fn has_inline_mention(text: &str, account: &str) -> bool {
    inline_mentions(text, account).next().is_some()
}

pub(super) fn addressed_text(message: &Message, account: &str) -> Option<String> {
    // Discord also lists the author of a pinged reply even when no inline
    // tag addresses them. Both the syntax and the platform record must match.
    if !message.mentions.as_ref()?.iter().any(|user| user.id == account) {
        return None;
    }
    let text = &message.content;
    let mut mentions = inline_mentions(text, account).peekable();
    mentions.peek()?;
    let mut result = String::with_capacity(text.len());
    let mut copied = 0;
    for (start, end) in mentions {
        result.push_str(&text[copied..start]);
        // Removing an inline tag must not join fragments into a new command.
        if result.ends_with(|ch: char| !ch.is_whitespace())
            && text[end..].starts_with(|ch: char| !ch.is_whitespace())
        {
            result.push(' ');
        }
        copied = end;
    }
    result.push_str(&text[copied..]);
    Some(result.trim().to_owned())
}

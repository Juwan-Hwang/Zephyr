//! Subscription content processing — platform-agnostic pure functions.
//!
//! Migrated from `src-tauri/src/core/subscription.rs` for cross-platform reuse.
//! Network I/O (reqwest, Tauri `AppHandle`) stays in src-tauri.

use base64::Engine as _;
use std::net::IpAddr;

/// Maximum response size for subscription downloads (10 MB).
pub const MAX_RESPONSE_SIZE: usize = 10 * 1024 * 1024;

#[inline]
const fn decode_hex_digit(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

// ── Pure functions for subscription content sanitization ─────────────────

/// Quote `short-id` values in YAML content before parsing.
/// This prevents YAML from interpreting hex-like values (e.g., "34010e92") as scientific notation.
///
/// A `short-id` key, plain or quoted (`"short-id":`), is found where YAML has
/// a key: at the start of a line, after a `- ` sequence entry, or inside a
/// flow mapping (`{public-key: k, short-id: 34010e92}`). Its value is quoted when it is a
/// plain scalar, whole (`abc def` becomes `"abc def"`), on the key's line or
/// alone on a following, more indented line. Quoted values, block scalar
/// indicators, flow collections, anchors, aliases, tags and plain scalars
/// that go on over more lines are left alone. Text inside a block scalar
/// (`|` or `>`) or a quoted scalar is not a key, so a password whose text
/// holds `short-id: abc` keeps it. A plain null (`null`, `~`) stays null.
///
/// Lines end where the YAML parser ends them: at LF, CRLF, a lone CR, and
/// NEL, LS or PS (U+0085, U+2028, U+2029).
#[must_use]
pub fn quote_short_id_values(content: &str) -> String {
    // Fast path: if "short-id" is not present at all, return input immediately.
    if !content.contains(SHORT_ID) {
        return content.to_owned();
    }

    let spans = match unicode_breaks_as_ascii(content) {
        Some(scan) => short_id_value_spans(&scan),
        None => short_id_value_spans(content),
    };
    let mut out = String::with_capacity(content.len() + spans.len() * 2 + 16);
    let mut last = 0;
    for (start, end) in spans {
        let (Some(before), Some(scalar)) = (content.get(last..start), content.get(start..end))
        else {
            return content.to_owned();
        };
        if matches!(scalar, "null" | "Null" | "NULL" | "~") {
            // A null value means no short ID; quoting it would make it the
            // text "null", which is not a valid one.
            continue;
        }
        out.push_str(before);
        out.push('"');
        for c in scalar.chars() {
            if matches!(c, '"' | '\\') {
                out.push('\\');
            }
            out.push(c);
        }
        out.push('"');
        last = end;
    }
    out.push_str(content.get(last..).unwrap_or_default());
    out
}

/// A copy of `content` with each NEL, LS and PS line break written as ASCII
/// line breaks of the same byte length (NEL as CRLF, LS and PS as a space
/// and CRLF), so the scanner, which reads ASCII line breaks, ends lines
/// where the YAML parser does, and its byte ranges still fit `content`.
/// `None` when `content` holds none of them.
fn unicode_breaks_as_ascii(content: &str) -> Option<String> {
    let bytes = content.as_bytes();
    let break_len = |at: usize| match (byte_at(bytes, at), byte_at(bytes, at + 1)) {
        (0xC2, 0x85) => Some(2),
        (0xE2, 0x80) if matches!(byte_at(bytes, at + 2), 0xA8 | 0xA9) => Some(3),
        _ => None,
    };
    let mut copy: Option<Vec<u8>> = None;
    let mut from = 0;
    while let Some(found) = bytes
        .get(from..)
        .and_then(|rest| memchr::memchr2(0xC2, 0xE2, rest))
    {
        let at = from + found;
        from = at + 1;
        let Some(len) = break_len(at) else {
            continue;
        };
        let ascii: &[u8] = if len == 2 { b"\r\n" } else { b" \r\n" };
        if let Some(target) = copy
            .get_or_insert_with(|| bytes.to_vec())
            .get_mut(at..at + len)
        {
            target.copy_from_slice(ascii);
        }
        from = at + len;
    }
    // Whole characters were replaced by ASCII, so the copy is still UTF-8.
    copy.and_then(|ascii_copy| String::from_utf8(ascii_copy).ok())
}

/// The byte ranges of the plain scalar values of `short-id` keys in
/// `content`, in order: the spans [`quote_short_id_values`] wraps in quotes.
fn short_id_value_spans(content: &str) -> Vec<(usize, usize)> {
    let mut scanner = ShortIdScanner::default();
    let mut line_start = 0;
    let mut next = NextInteresting::new(content);
    while line_start < content.len() {
        if scanner.is_idle() {
            // Nothing carries over, so lines with neither a `short-id` nor a
            // structure byte change nothing: jump to the start of the line
            // holding the next of either, without reading the lines between.
            let Some(target) = next.from(line_start) else {
                break;
            };
            line_start = content
                .as_bytes()
                .get(line_start..target)
                .and_then(|between| memchr::memrchr2(b'\n', b'\r', between))
                .map_or(line_start, |newline| line_start + newline + 1);
        }
        let Some(rest) = content.get(line_start..) else {
            break;
        };
        let line_len = line_len(rest.as_bytes());
        let Some(line) = rest.get(..line_len) else {
            break;
        };
        let next_line = line_start + line_len;
        let at = LineAt {
            content,
            line,
            line_start,
            next_line,
        };
        if !scanner.skip_continuation(&at) && !scanner.skip_line(&at) {
            scanner.scan_line(&at);
        }
        scanner.read_to = next_line;
        line_start = next_line;
    }
    scanner.spans
}

/// The length of the line at the start of `rest`, with its line ending: a
/// `\n`, a `\r\n`, or a lone `\r`, which YAML also reads as a line break.
fn line_len(rest: &[u8]) -> usize {
    match memchr::memchr2(b'\n', b'\r', rest) {
        Some(at) if byte_at(rest, at) == b'\r' && rest.get(at + 1) == Some(&b'\n') => at + 2,
        Some(at) => at + 1,
        None => rest.len(),
    }
}

/// Finds, from a given offset on, the next place in the content that
/// [`ShortIdScanner`] has to read: a `short-id`, or a byte that opens or
/// closes a quoted scalar, a flow collection or a block scalar. Lines before
/// it change nothing while the scanner is idle.
///
/// Each kind of byte is searched for on its own and its next position is
/// kept, so the content is searched through once in all, however often
/// this is asked.
struct NextInteresting<'a> {
    content: &'a [u8],
    key_finder: memchr::memmem::Finder<'static>,
    /// The next position of a `short-id`, then of each group of structure
    /// bytes; `None` once there are no more.
    next: [Option<usize>; 4],
}

impl<'a> NextInteresting<'a> {
    fn new(content: &'a str) -> Self {
        let mut finder = Self {
            content: content.as_bytes(),
            key_finder: memchr::memmem::Finder::new(SHORT_ID.as_bytes()),
            next: [None; 4],
        };
        for group in 0..finder.next.len() {
            finder.search(group, 0);
        }
        finder
    }

    /// Search for the next position of `group` at or after `from`.
    fn search(&mut self, group: usize, from: usize) {
        let rest = self.content.get(from..).unwrap_or_default();
        let found = match group {
            0 => self.key_finder.find(rest),
            1 => memchr::memchr3(b'"', b'\'', b'|', rest),
            2 => memchr::memchr3(b'{', b'}', b'[', rest),
            _ => memchr::memchr2(b']', b'>', rest),
        };
        if let Some(slot) = self.next.get_mut(group) {
            *slot = found.map(|at| from + at);
        }
    }

    /// The first interesting position at or after `from`, if any. `from`
    /// never goes back between calls.
    fn from(&mut self, from: usize) -> Option<usize> {
        for group in 0..self.next.len() {
            if self
                .next
                .get(group)
                .copied()
                .flatten()
                .is_some_and(|at| at < from)
            {
                self.search(group, from);
            }
        }
        self.next.iter().flatten().copied().min()
    }
}

/// One line of the content [`ShortIdScanner`] reads.
struct LineAt<'a> {
    /// The whole content, for looking at later lines.
    content: &'a str,
    /// The line, with its line ending.
    line: &'a str,
    /// Where the line starts in `content`.
    line_start: usize,
    /// Where the next line starts in `content`.
    next_line: usize,
}

impl LineAt<'_> {
    const fn bytes(&self) -> &[u8] {
        self.line.as_bytes()
    }

    /// The length of the line without its line ending.
    fn text_end(&self) -> usize {
        self.line.trim_end_matches(['\n', '\r']).len()
    }

    /// The line's leading space count.
    fn indent(&self) -> usize {
        self.line.len() - self.line.trim_start_matches(' ').len()
    }
}

/// What [`ShortIdScanner`] carries from one line to the next.
#[derive(Default)]
struct ShortIdScanner {
    spans: Vec<(usize, usize)>,
    /// How many flow collections (`{`, `[`) are open.
    flow_depth: usize,
    /// The quote of a quoted scalar that is still open.
    quote: Option<u8>,
    /// Column of the node that owns the block scalar being skipped: the
    /// scalar's text is every following line indented deeper than it.
    block_owner: Option<usize>,
    /// Column of a `short-id:` key whose value comes on a later line.
    pending_key: Option<usize>,
    /// Whether a `short-id:` key inside a flow mapping ended its line, so
    /// the next token is its value.
    pending_flow_value: bool,
    /// Whether the last line read ended inside a plain scalar in a flow
    /// collection: the next line goes on with that scalar.
    flow_plain: bool,
    /// Column of the node owning the plain scalar that ended the last line
    /// read, outside flow collections: a later line indented deeper than it
    /// goes on with that scalar (`name: Node` then `    'West`).
    plain_owner: Option<usize>,
    /// Where the lines read so far end. Lines between here and the line
    /// being read were skipped unread.
    read_to: usize,
}

/// Where [`ShortIdScanner::scan_line`] is on its line.
struct Cursor {
    /// The byte being read.
    pos: usize,
    /// Whether a new node may start at `pos`.
    token_start: bool,
    /// Column of the token being read.
    token_col: usize,
    /// Column of the node that owns a block scalar starting on this line:
    /// the key, or a `- ` entry.
    owner_col: usize,
    /// Whether the cursor is inside a plain scalar.
    in_plain: bool,
    /// Whether the node just read is JSON-like (quoted, or a flow
    /// collection): in a flow collection, a `:` right after it separates a
    /// value even with no space (`{"short-id":34010e92}`).
    json_like: bool,
}

/// The key whose values [`quote_short_id_values`] quotes.
const SHORT_ID: &str = "short-id";

impl ShortIdScanner {
    /// Whether nothing carries over from earlier lines: no open quote, flow
    /// collection or block scalar, and no `short-id` key waiting for its
    /// value.
    const fn is_idle(&self) -> bool {
        self.quote.is_none()
            && self.flow_depth == 0
            && self.block_owner.is_none()
            && self.pending_key.is_none()
            && !self.pending_flow_value
    }

    /// Handle a line while idle that is blank, a comment, or goes on with
    /// a plain scalar from an earlier line. Returns `true` when the line
    /// needs no other reading. A continuation line is plain text: a quote
    /// or bracket at its start opens nothing, so it and the lines after it
    /// that are indented as deep are skipped like block scalar text.
    fn skip_continuation(&mut self, at: &LineAt<'_>) -> bool {
        if !self.is_idle() {
            return false;
        }
        let text = at.line.trim_start_matches([' ', '\t']);
        if text.trim_end().is_empty() || text.starts_with('#') {
            return true;
        }
        match self.plain_owner_before(at) {
            Some(owner) if at.indent() > owner => {
                self.block_owner = Some(owner);
                true
            }
            _ => false,
        }
    }

    /// The owner column of a plain scalar still open at the start of
    /// `at`'s line (see [`Self::plain_owner`]), working through the lines
    /// skipped unread since the last line read. Those lines hold no quote,
    /// bracket or block indicator, so each is read on its own. A line with
    /// a key cannot go on with an earlier scalar, so the lines before it do
    /// not matter; only the key-less lines after it are worked through.
    fn plain_owner_before(&self, at: &LineAt<'_>) -> Option<usize> {
        let bytes = at.content.as_bytes();
        let mut lines = Vec::new();
        let mut base = self.plain_owner;
        let mut end = at.line_start;
        while end > self.read_to {
            let mut text_end = end;
            if byte_at(bytes, text_end - 1) == b'\n' {
                text_end -= 1;
            }
            if text_end > self.read_to && byte_at(bytes, text_end - 1) == b'\r' {
                text_end -= 1;
            }
            let start = bytes
                .get(self.read_to..text_end)
                .and_then(|region| memchr::memrchr2(b'\n', b'\r', region))
                .map_or(self.read_to, |at| self.read_to + at + 1);
            end = start;
            let line = at.content.get(start..text_end).unwrap_or_default();
            let text = line.trim_start_matches([' ', '\t']);
            if text.trim_end().is_empty() || text.starts_with('#') {
                continue;
            }
            let (owner, has_key) = plain_line_owner(line);
            if has_key {
                base = owner;
                break;
            }
            lines.push((line.len() - line.trim_start_matches(' ').len(), owner));
        }
        lines
            .into_iter()
            .rev()
            .fold(base, |state, (indent, owner)| match state {
                Some(open) if indent > open => state,
                _ => owner,
            })
    }

    /// Handle a line that is block scalar text, blank or a comment before a
    /// pending value, or the pending value itself. Returns `true` when the
    /// line needs no other reading.
    fn skip_line(&mut self, at: &LineAt<'_>) -> bool {
        if self.quote.is_some() {
            return false;
        }
        let blank = at.line.trim().is_empty();
        if let Some(owner) = self.block_owner {
            if blank || at.indent() > owner {
                return true;
            }
            self.block_owner = None;
        }
        let Some(key_col) = self.pending_key else {
            return false;
        };
        if blank || at.line.trim_start().starts_with('#') {
            return true;
        }
        self.pending_key = None;
        let indent = at.indent();
        if self.flow_depth > 0 || indent <= key_col {
            return false;
        }
        match plain_scalar_end(at.bytes(), indent, at.text_end(), false) {
            Some((end, true)) => {
                if plain_scalar_continues(at.content, at.next_line, key_col) {
                    // Left alone; its next lines are plain text.
                    self.block_owner = Some(key_col);
                } else {
                    self.spans
                        .push((at.line_start + indent, at.line_start + end));
                }
                self.plain_owner = Some(key_col);
                true
            }
            _ => false,
        }
    }

    fn scan_line(&mut self, at: &LineAt<'_>) {
        let start = if self.quote.is_some() {
            0
        } else if self.flow_depth == 0 && starts_with_document_marker(at.bytes()) {
            // The root node may start on the `---` line after the marker.
            skip_inline_blanks(at.bytes(), 3, at.text_end())
        } else {
            at.indent()
        };
        let mut cursor = Cursor {
            pos: start,
            token_start: self.quote.is_none() && !self.flow_plain,
            token_col: start,
            owner_col: start,
            in_plain: self.flow_plain,
            json_like: false,
        };
        let text_end = at.text_end();
        while cursor.pos < text_end {
            if !self.step(at, &mut cursor) {
                break;
            }
        }
        let open_plain = cursor.in_plain && self.quote.is_none();
        self.flow_plain = open_plain && self.flow_depth > 0;
        self.plain_owner = (open_plain && self.is_idle()).then_some(cursor.owner_col);
    }

    /// Read on from the cursor. Returns `false` when the rest of the line
    /// holds nothing more to read.
    fn step(&mut self, at: &LineAt<'_>, cursor: &mut Cursor) -> bool {
        let bytes = at.bytes();
        if let Some(quote) = self.quote {
            let Some(after) = quoted_scalar_end(bytes, cursor.pos, at.text_end(), quote) else {
                return false;
            };
            self.quote = None;
            cursor.pos = after;
            cursor.token_start = false;
            cursor.in_plain = false;
            cursor.json_like = true;
            return true;
        }
        let b = byte_at(bytes, cursor.pos);
        if matches!(b, b' ' | b'\t') {
            cursor.pos += 1;
            return true;
        }
        let after_blank = cursor.pos == 0 || matches!(byte_at(bytes, cursor.pos - 1), b' ' | b'\t');
        if b == b'#' && after_blank {
            return false;
        }
        if cursor.token_start {
            return self.step_token_start(at, cursor);
        }
        let in_flow = self.flow_depth > 0;
        let json_like = std::mem::take(&mut cursor.json_like);
        match b {
            b':' if is_value_separator(byte_at(bytes, cursor.pos + 1), in_flow)
                || (in_flow && json_like) =>
            {
                cursor.owner_col = cursor.token_col;
                cursor.token_start = true;
                cursor.in_plain = false;
            }
            b',' if in_flow => {
                cursor.token_start = true;
                cursor.in_plain = false;
            }
            b'}' | b']' if in_flow => {
                self.flow_depth -= 1;
                cursor.in_plain = false;
                cursor.json_like = true;
            }
            _ => {}
        }
        cursor.pos += 1;
        true
    }

    /// Read the node that starts at the cursor.
    fn step_token_start(&mut self, at: &LineAt<'_>, cursor: &mut Cursor) -> bool {
        let bytes = at.bytes();
        let pos = cursor.pos;
        let b = byte_at(bytes, pos);
        let in_flow = self.flow_depth > 0;
        cursor.json_like = false;
        if std::mem::take(&mut self.pending_flow_value) && in_flow {
            // The value of a `short-id:` that ended an earlier line.
            return self.read_short_id_value(at, cursor, pos, cursor.owner_col);
        }
        cursor.token_col = pos;
        cursor.pos += 1;
        match b {
            b'-' | b'?' if !in_flow && is_blank_byte(byte_at(bytes, pos + 1)) => {
                cursor.owner_col = pos;
            }
            b'"' | b'\'' => {
                // A quoted key (`"short-id":`) is a key like the plain one.
                // YAML allows blanks before the colon (`"short-id" :`).
                let quoted_len = SHORT_ID.len() + 2;
                let colon = skip_inline_blanks(bytes, pos + quoted_len, at.text_end());
                let is_key = at.line.get(pos..pos + quoted_len).is_some_and(|quoted| {
                    quoted
                        .strip_prefix(char::from(b))
                        .and_then(|q| q.strip_suffix(char::from(b)))
                        == Some(SHORT_ID)
                }) && byte_at(bytes, colon) == b':'
                    && (in_flow || is_value_separator(byte_at(bytes, colon + 1), false));
                if is_key {
                    return self.step_short_id_value(at, cursor, pos, colon + 1 - pos);
                }
                self.quote = Some(b);
                cursor.token_start = false;
            }
            b'|' | b'>' if !in_flow => {
                if is_block_scalar_indicator(bytes, pos, at.text_end()) {
                    self.block_owner = Some(cursor.owner_col);
                }
                return false;
            }
            b'&' | b'!' => {
                // An anchor or a tag comes before the node it names.
                while cursor.pos < at.text_end() && !is_blank_byte(byte_at(bytes, cursor.pos)) {
                    cursor.pos += 1;
                }
            }
            b'{' | b'[' => self.flow_depth += 1,
            b'}' | b']' if in_flow => {
                self.flow_depth -= 1;
                cursor.token_start = false;
                cursor.json_like = true;
            }
            b',' if in_flow => {}
            _ => {
                // YAML allows blanks before the colon (`short-id :`).
                let colon = skip_inline_blanks(bytes, pos + SHORT_ID.len(), at.text_end());
                let is_key = at.line.get(pos..pos + SHORT_ID.len()) == Some(SHORT_ID)
                    && byte_at(bytes, colon) == b':'
                    && is_value_separator(byte_at(bytes, colon + 1), in_flow);
                if !is_key {
                    cursor.token_start = false;
                    cursor.in_plain = true;
                    return true;
                }
                return self.step_short_id_value(at, cursor, pos, colon + 1 - pos);
            }
        }
        true
    }

    /// Read the value of the `short-id` key at column `key_col`, `key_len`
    /// bytes long with its colon, recording it when it is a plain scalar.
    fn step_short_id_value(
        &mut self,
        at: &LineAt<'_>,
        cursor: &mut Cursor,
        key_col: usize,
        key_len: usize,
    ) -> bool {
        let bytes = at.bytes();
        let text_end = at.text_end();
        let in_flow = self.flow_depth > 0;
        cursor.owner_col = key_col;
        let mut value = key_col + key_len;
        while value < text_end && matches!(byte_at(bytes, value), b' ' | b'\t') {
            value += 1;
        }
        if value >= text_end || byte_at(bytes, value) == b'#' {
            if in_flow {
                self.pending_flow_value = true;
            } else {
                self.pending_key = Some(key_col);
            }
            return false;
        }
        self.read_short_id_value(at, cursor, value, key_col)
    }

    /// Read the value of a `short-id` key at column `key_col` that starts
    /// at `value`, recording it when it is a plain scalar.
    fn read_short_id_value(
        &mut self,
        at: &LineAt<'_>,
        cursor: &mut Cursor,
        value: usize,
        key_col: usize,
    ) -> bool {
        let bytes = at.bytes();
        let text_end = at.text_end();
        let in_flow = self.flow_depth > 0;
        cursor.pos = value;
        let Some((end, ends_line)) = plain_scalar_end(bytes, value, text_end, in_flow) else {
            return true;
        };
        // A plain scalar may go on over the next lines: it is left alone
        // then, as quoting its first line would break it.
        let continues = if in_flow {
            ends_line
                && !at
                    .line
                    .get(end..text_end)
                    .is_some_and(|rest| rest.trim_start().starts_with('#'))
                && flow_scalar_continues(at.content, at.next_line)
        } else {
            plain_scalar_continues(at.content, at.next_line, key_col)
        };
        if !continues {
            self.spans
                .push((at.line_start + value, at.line_start + end));
        }
        cursor.token_start = false;
        cursor.in_plain = true;
        cursor.pos = end;
        true
    }
}

/// The byte at `i` in `bytes`, or `\n` past the end.
fn byte_at(bytes: &[u8], i: usize) -> u8 {
    bytes.get(i).copied().unwrap_or(b'\n')
}

/// Whether `b` is whitespace or the end of the line.
const fn is_blank_byte(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\r' | b'\n')
}

/// Whether the byte after a `:` makes the colon a key separator.
const fn is_value_separator(next: u8, in_flow: bool) -> bool {
    is_blank_byte(next) || (in_flow && matches!(next, b',' | b'}' | b']'))
}

/// Where the plain scalar starting at `start` ends on its line, with
/// trailing whitespace left out, and whether it runs to the end of the line
/// (or to a comment). `None` when no plain scalar starts there, or when the
/// text is not one plain scalar (`a: b` holds a key).
fn plain_scalar_end(
    bytes: &[u8],
    start: usize,
    text_end: usize,
    in_flow: bool,
) -> Option<(usize, bool)> {
    let first = byte_at(bytes, start);
    let next = byte_at(bytes, start + 1);
    let starts_plain = match first {
        b'-' | b'?' | b':' => !(is_blank_byte(next) || in_flow && b",[]{}".contains(&next)),
        b',' | b'[' | b']' | b'{' | b'}' | b'#' | b'&' | b'*' | b'!' | b'|' | b'>' | b'\''
        | b'"' | b'%' | b'@' | b'`' => false,
        b => !is_blank_byte(b),
    };
    if !starts_plain {
        return None;
    }
    let mut i = start;
    let mut end = start;
    let mut ends_line = true;
    while i < text_end {
        let b = byte_at(bytes, i);
        let prev_blank = i > start && matches!(byte_at(bytes, i - 1), b' ' | b'\t');
        if b == b'#' && prev_blank {
            break;
        }
        if b == b':' && is_value_separator(byte_at(bytes, i + 1), in_flow) {
            return None;
        }
        if in_flow && matches!(b, b',' | b'}' | b']') {
            ends_line = false;
            break;
        }
        if in_flow && matches!(b, b'{' | b'[') {
            return None;
        }
        if !matches!(b, b' ' | b'\t') {
            end = i + 1;
        }
        i += 1;
    }
    Some((end, ends_line))
}

/// Whether the plain scalar value of a block key at column `key_col` goes on
/// past its line: the next line that is not blank or a comment is indented
/// deeper than the key. `from` is where that search starts.
fn plain_scalar_continues(content: &str, from: usize, key_col: usize) -> bool {
    content
        .get(from..)
        .unwrap_or_default()
        .split(['\n', '\r'])
        .find(|line| {
            let text = line.trim();
            !text.is_empty() && !text.starts_with('#')
        })
        .is_some_and(|line| line.len() - line.trim_start_matches(' ').len() > key_col)
}

/// For a block line with no quote, bracket or block indicator (`line`
/// without its line ending): the column of the node owning the plain
/// scalar that ends the line, if one does (the key of `key: value`, the
/// `- ` of `- value`), and whether the line holds a key.
fn plain_line_owner(line: &str) -> (Option<usize>, bool) {
    let bytes = line.as_bytes();
    let end = bytes.len();
    let skip_blanks = |mut i: usize| {
        while i < end && matches!(byte_at(bytes, i), b' ' | b'\t') {
            i += 1;
        }
        i
    };
    // Anchors and tags come before the node they name.
    let skip_properties = |mut i: usize| {
        while matches!(byte_at(bytes, i), b'&' | b'!') {
            while i < end && !is_blank_byte(byte_at(bytes, i)) {
                i += 1;
            }
            i = skip_blanks(i);
        }
        i
    };
    let ends = |i: usize| i >= end || byte_at(bytes, i) == b'#';
    if starts_with_document_marker(bytes) {
        // `---` or `...` ends the document's nodes: no scalar goes on past it.
        return (None, true);
    }
    let mut i = skip_blanks(0);
    let mut owner = i;
    while matches!(byte_at(bytes, i), b'-' | b'?' | b':') && is_blank_byte(byte_at(bytes, i + 1)) {
        owner = i;
        i = skip_blanks(i + 1);
    }
    i = skip_properties(i);
    if ends(i) {
        return (None, false);
    }
    let token = i;
    let mut j = i;
    while j < end {
        let b = byte_at(bytes, j);
        if b == b'#' && matches!(byte_at(bytes, j - 1), b' ' | b'\t') {
            break;
        }
        if b == b':' && is_blank_byte(byte_at(bytes, j + 1)) {
            let value = skip_properties(skip_blanks(j + 1));
            return ((!ends(value)).then_some(token), true);
        }
        j += 1;
    }
    (Some(owner), false)
}

/// Whether `line` starts with a document marker, `---` or `...`, at column
/// zero, followed by a blank or the end of the line.
fn starts_with_document_marker(line: &[u8]) -> bool {
    (line.starts_with(b"---") || line.starts_with(b"...")) && is_blank_byte(byte_at(line, 3))
}

/// The first position at or after `from`, before `text_end`, that is not a
/// space or a tab.
fn skip_inline_blanks(bytes: &[u8], mut from: usize, text_end: usize) -> usize {
    while from < text_end && matches!(byte_at(bytes, from), b' ' | b'\t') {
        from += 1;
    }
    from
}

/// Whether a plain scalar inside a flow collection that runs to the end of
/// its line goes on over the next line: the next text, past whitespace and
/// line breaks, is not a `,`, `}` or `]` that ends it, a comment, or the end
/// of the content. `from` is where the next line starts.
fn flow_scalar_continues(content: &str, from: usize) -> bool {
    content
        .get(from..)
        .unwrap_or_default()
        .trim_start()
        .starts_with(|c: char| !matches!(c, ',' | '}' | ']' | '#'))
}

/// The end of a quoted scalar opened with `quote`, searching from `from`:
/// the byte after its closing quote, or `None` when it does not close on
/// this line.
fn quoted_scalar_end(bytes: &[u8], from: usize, text_end: usize, quote: u8) -> Option<usize> {
    let mut i = from;
    while i < text_end {
        let b = byte_at(bytes, i);
        if quote == b'"' && b == b'\\' {
            i += 2;
            continue;
        }
        if b == quote {
            // In single quotes, `''` is an escaped quote.
            if quote == b'\'' && byte_at(bytes, i + 1) == b'\'' {
                i += 2;
                continue;
            }
            return Some(i + 1);
        }
        i += 1;
    }
    None
}

/// Whether the token at `start` is a block scalar indicator (`|`, `>-`,
/// `|2+`), with only whitespace or a comment after it.
fn is_block_scalar_indicator(bytes: &[u8], start: usize, text_end: usize) -> bool {
    let mut i = start + 1;
    while i < text_end && i <= start + 2 && matches!(byte_at(bytes, i), b'+' | b'-' | b'1'..=b'9') {
        i += 1;
    }
    i >= text_end || matches!(byte_at(bytes, i), b' ' | b'\t')
}

/// Strip a YAML `#` comment from an unquoted scalar. In YAML, `#` only
/// starts a comment when it is the first character or is preceded by a space
/// or tab; otherwise it is part of the scalar (e.g. `Group#1` stays whole).
fn strip_yaml_comment(s: &str) -> &str {
    let mut prev: Option<u8> = None;
    for (i, &b) in s.as_bytes().iter().enumerate() {
        if b == b'#' && matches!(prev, None | Some(b' ') | Some(b'\t')) {
            return s.get(..i).map(str::trim_end).unwrap_or("");
        }
        prev = Some(b);
    }
    s
}

/// Decode one quoted sequence item, or return `None` when the scanner cannot
/// reproduce `serde_yaml` exactly: a closing quote missing on this line
/// (multiline scalar), trailing tokens after the closing quote, or escape
/// sequences in a double-quoted scalar. Single-quoted `''` escapes are
/// decoded, matching YAML.
fn unquote_item_scalar(item: &str) -> Option<String> {
    let mut chars = item.char_indices().peekable();
    let (_, quote) = chars.next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    let mut out = String::new();
    while let Some((i, c)) = chars.next() {
        if quote == '"' && c == '\\' {
            return None;
        }
        if c == quote {
            if quote == '\'' {
                if let Some(&(_, '\'')) = chars.peek() {
                    chars.next();
                    out.push('\'');
                    continue;
                }
            }
            let rest = item.get(i + c.len_utf8()..).unwrap_or("").trim_start();
            if rest.is_empty() || rest.starts_with('#') {
                return Some(out);
            }
            return None;
        }
        out.push(c);
    }
    None
}

/// Whether a line is a YAML document marker (`---` or `...`, optionally
/// followed by whitespace or a comment).
fn is_document_marker(line: &str) -> Option<bool> {
    if line == "---" || line.starts_with("--- ") || line.starts_with("---\t") {
        Some(true)
    } else if line == "..." || line.starts_with("... ") || line.starts_with("...\t") {
        Some(false)
    } else {
        None
    }
}

/// Whether a top-level line looks like a mapping key (`key:`, `key: value`,
/// quoted keys included). Used only to tell a real section end from a
/// stray scalar line; anything uncertain falls back to the full parser.
fn looks_like_key_line(line: &str) -> bool {
    line.contains(": ") || line.contains(":\t") || line.ends_with(':')
}

/// Whether an unindented line is a `rules:` key line the scanner can read:
/// a bare or quoted `rules` key, a colon (a space or tab may precede it),
/// and nothing after the colon but a comment. `rules:#comment` is not a
/// header at all (the whole line reads as a plain scalar), and a flow
/// value after the colon is a complex header the scanner cannot read.
fn is_rules_header_line(line: &str) -> bool {
    let after_key = if let Some(rest) = line.strip_prefix("rules") {
        rest
    } else if let Some(rest) = line.strip_prefix("\"rules\"") {
        rest
    } else if let Some(rest) = line.strip_prefix("'rules'") {
        rest
    } else {
        return false;
    };
    let rest_trimmed = after_key.trim_start();
    if let Some(rest_after_colon) = rest_trimmed.strip_prefix(':') {
        if rest_after_colon.is_empty()
            || rest_after_colon.starts_with(' ')
            || rest_after_colon.starts_with('\t')
        {
            let rest_comment = rest_after_colon.trim();
            return rest_comment.is_empty() || rest_comment.starts_with('#');
        }
    }
    false
}

/// Whether an unindented line is a `rules` key in any value form
/// (`rules:`, `rules: [a]`, `rules: foo`, …). This is a superset of
/// `is_rules_header_line`: a flow or scalar value is still a `rules` key,
/// so it still counts toward duplicate-key detection. `rules:#comment`
/// is not a key at all (the whole line is a plain scalar) and is not
/// counted.
fn is_rules_key_line(line: &str) -> bool {
    let after_prefix = line
        .strip_prefix("rules")
        .or_else(|| line.strip_prefix("\"rules\""))
        .or_else(|| line.strip_prefix("'rules'"))
        .unwrap_or("");
    after_prefix.trim_start().starts_with(':')
}

/// Advance `lines` past the top-level `rules:` key line, if there is one.
/// Returns `false` when there is no such key or its header is a complex
/// form the scanner cannot read (e.g. a flow sequence). Scanning this way
/// avoids collecting every line up front for inputs without a rules block.
fn skip_to_rules_header(lines: &mut std::str::Lines<'_>) -> bool {
    let mut seen_content = false;
    let mut seen_key = false;
    // Whether indentless sequence items may follow the last key, and at
    // which indent they started (indentless items are always at indent 0).
    // This is what `serde_yaml::to_string` emits for top-level sequences.
    let mut seq_allowed = false;
    let mut seq_indent: Option<usize> = None;
    for line in lines.by_ref() {
        let trimmed = line.trim_start();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if line.starts_with(' ') || line.starts_with('\t') {
            // Indented content (e.g. a block scalar line that looks like a
            // marker) is not a document boundary. A document whose first
            // content line is indented cannot hold a top-level `rules:`
            // key later, so reject it; otherwise an indented line only
            // means the current key's value is nested, which forbids later
            // indentless items.
            if !seen_key {
                return false;
            }
            seen_content = true;
            if seq_indent.is_none() {
                seq_allowed = false;
            }
            continue;
        }
        // A document marker after content starts a new document, so rules
        // after it would belong to a later document (which single-document
        // parsing rejects); a leading `---` is just an explicit start.
        if let Some(is_start) = is_document_marker(trimmed) {
            if !is_start || seen_content {
                return false;
            }
            continue;
        }
        seen_content = true;
        if is_rules_header_line(line) {
            return true;
        }
        // A line starting with `rules` (bare or quoted) that is not a
        // header is still a top-level line. A `rules` key with a complex
        // value (e.g. `rules: [a]`) is still a `rules` key, so the scan
        // cannot continue past it: a later `rules:` header would be a
        // duplicate. Any other `rules`-prefixed line behaves like the
        // generic branch: a real key (e.g. `rulesx: y`) continues the
        // scan, while a scalar or garbage line (e.g. `rulesfoo`) makes
        // the document root implausible.
        if line.starts_with("rules") || line.starts_with("\"rules\"") || line.starts_with("'rules'")
        {
            let after_prefix = line
                .strip_prefix("rules")
                .or_else(|| line.strip_prefix("\"rules\""))
                .or_else(|| line.strip_prefix("'rules'"))
                .unwrap_or("");
            if after_prefix.trim_start().starts_with(':') {
                return false;
            }
            if looks_like_key_line(trimmed) {
                seen_key = true;
                // A key with an empty value may be followed by an
                // indentless sequence; any other value may not.
                seq_allowed = trimmed.trim_end().ends_with(':');
                seq_indent = None;
                continue;
            }
            return false;
        }
        // Not the header: the line must still be plausible top-level
        // mapping structure, or the document root is not a mapping
        // and any later `rules:` line would not be a real key.
        if looks_like_key_line(trimmed) {
            seen_key = true;
            // A key with an empty value may be followed by an
            // indentless sequence; any other value may not.
            seq_allowed = trimmed.trim_end().ends_with(':');
            seq_indent = None;
            continue;
        }
        let is_item = trimmed == "-" || trimmed.starts_with("- ");
        if is_item && seq_allowed {
            match seq_indent {
                None => seq_indent = Some(0),
                Some(0) => {}
                Some(_) => return false,
            }
            continue;
        }
        return false;
    }
    false
}

/// Whether the item just read really ended: the next significant line is
/// a new item at the same indentation, a top-level key, or end of input.
/// A following more-indented line would fold into the scalar (plain
/// multiline scalar) or nest under it, so it does not count as ended.
/// Consumes `lines` up to that next significant line; callers only use
/// this check when they are about to return, so consuming is safe.
fn rules_item_ended(lines: &mut std::str::Lines<'_>, item_indent: usize) -> bool {
    for next in lines.by_ref() {
        let next_trimmed = next.trim_start();
        if next_trimmed.is_empty() || next_trimmed.starts_with('#') {
            continue;
        }
        let next_indent = next.len() - next_trimmed.len();
        // A more-indented line folds into the scalar (or nests under it),
        // so it never counts as ended — including lines that look like
        // document markers, which are only markers at column 0.
        if next_indent > item_indent {
            return false;
        }
        if next_indent == 0 {
            // A document start marker means another document follows, which
            // single-document parsing rejects; a document end marker confirms
            // only when nothing but blanks and comments follow it.
            if let Some(is_start) = is_document_marker(next_trimmed) {
                if is_start {
                    return false;
                }
                return lines.by_ref().all(|rest| {
                    rest.trim_start().is_empty() || rest.trim_start().starts_with('#')
                });
            }
        }
        if next_indent == item_indent {
            if next_trimmed == "-" || next_trimmed.starts_with("- ") {
                return true;
            }
            if item_indent == 0 {
                return looks_like_key_line(next_trimmed);
            }
            return false;
        }
        if next_indent == 0 && next_trimmed != "-" && !next_trimmed.starts_with("- ") {
            return looks_like_key_line(next_trimmed);
        }
        return false;
    }
    true
}

/// Outcome of the fast-path scan: a name, proof that no rule yields one,
/// or "cannot tell" (fall back to the full parser). The middle case matters
/// because a fully read but nameless section makes the fallback parse
/// provably redundant — common for subscriptions opening with more than
/// ten generic rules.
enum FastScan {
    Found(String),
    NoName,
    Unknown,
}

/// Fast-path line scanner for extracting policy group names from `rules:`.
/// Avoids allocating and parsing large subscription YAML ASTs for typical rule files.
///
/// The scanner returns a name only for shapes it can read exactly like
/// `serde_yaml` would. Anything unusual — aliases, mappings, nested or
/// mixed-indentation sequences, multiline scalars, quoted escapes, tab
/// indentation, lone carriage returns — aborts the fast path so the caller
/// falls back to the full parser. A candidate name is only returned once
/// the next significant line proves its item ended, so a folded continuation
/// line cannot silently truncate the name. Parity is guaranteed for
/// well-formed documents; callers that need strict whole-document
/// validation must parse first.
fn extract_name_from_rules_fast(content: &str) -> FastScan {
    // A lone carriage return is a YAML line break but not a `str::lines`
    // boundary; fall back so the parser splits the items correctly.
    // (`\r\n` pairs are fine: `lines` strips them.)
    let bytes = content.as_bytes();
    if bytes
        .iter()
        .enumerate()
        .any(|(i, &b)| b == b'\r' && bytes.get(i + 1) != Some(&b'\n'))
    {
        return FastScan::Unknown;
    }
    // Unicode line breaks (NEL, LS, PS) are YAML line breaks too, but not
    // `str::lines` boundaries either; fall back for the same reason.
    if content
        .chars()
        .any(|c| matches!(c, '\u{85}' | '\u{2028}' | '\u{2029}'))
    {
        return FastScan::Unknown;
    }
    // A second top-level `rules` key makes the whole document invalid
    // (the full parser rejects duplicate keys), so a name from the first
    // section would disagree with it. Any value form counts, not just
    // readable headers: `rules: []` after a section is a duplicate too.
    // Nested `rules:` keys are indented and never counted here; a false
    // positive only costs a fallback.
    let header_count = content
        .lines()
        .filter(|line| !line.starts_with(' ') && !line.starts_with('\t') && is_rules_key_line(line))
        .take(2)
        .count();
    if header_count >= 2 {
        return FastScan::Unknown;
    }
    let mut lines = content.lines();
    if !skip_to_rules_header(&mut lines) {
        return FastScan::Unknown;
    }

    let mut scanned_count = 0;
    let mut item_indent_len: Option<usize> = None;
    while let Some(line) = lines.next() {
        let trimmed = line.trim_start();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let indent_len = line.len() - trimmed.len();
        if indent_len == 0 {
            // An indentless list item belongs to the sequence only when the
            // sequence itself started indentless (as `serde_yaml::to_string`
            // emits). An unindented non-item line ends the section, so the
            // answer is definitively "no name"; an indentless item after
            // indented items is not a clean section end, so fall back.
            let is_item = trimmed == "-" || trimmed.starts_with("- ");
            if !is_item {
                return FastScan::NoName;
            }
            match item_indent_len {
                None => item_indent_len = Some(0),
                Some(0) => {}
                Some(_) => return FastScan::Unknown,
            }
        } else {
            if line.as_bytes().iter().take(indent_len).any(|&b| b == b'\t') {
                return FastScan::Unknown;
            }
            match item_indent_len {
                None => item_indent_len = Some(indent_len),
                Some(prev) if prev != indent_len => return FastScan::Unknown,
                _ => {}
            }
        }

        // `-` must be followed by a space or end of line; `-foo` is a plain
        // scalar, not a sequence item.
        let item_str = if trimmed == "-" {
            ""
        } else if let Some(rest) = trimmed.strip_prefix("- ") {
            rest.trim()
        } else {
            // Not a list item line: a continuation or nested line, which
            // only the full parser can read.
            return FastScan::Unknown;
        };

        scanned_count += 1;
        if scanned_count > 10 {
            // The full parser only looks at the first ten rules too, so a
            // nameless first ten means the answer is definitively "no name".
            return FastScan::NoName;
        }

        // Aliases resolve to earlier scalars; skipping one would change
        // first-match order, so fall back.
        if item_str.starts_with('*') {
            return FastScan::Unknown;
        }
        // Flow collections are not plain rule strings.
        if item_str.starts_with('{') || item_str.starts_with('[') {
            return FastScan::Unknown;
        }
        // Indicators that change how the node is read — anchors, tags,
        // block scalars, explicit keys, directives, reserved characters —
        // or a nested sequence item: only the full parser can read these,
        // so fall back rather than misreading them as plain rule strings.
        if matches!(
            item_str.chars().next(),
            Some('&' | '!' | '|' | '>' | '?' | '%' | '@' | '`' | ':' | ',')
        ) || item_str == "-"
            || item_str.starts_with("- ")
        {
            return FastScan::Unknown;
        }

        // Decode the scalar the way YAML would, or fall back.
        let scalar: std::borrow::Cow<'_, str> =
            if item_str.starts_with('"') || item_str.starts_with('\'') {
                match unquote_item_scalar(item_str) {
                    Some(s) => std::borrow::Cow::Owned(s),
                    None => return FastScan::Unknown,
                }
            } else {
                let s = strip_yaml_comment(item_str);
                // A `:` followed by a space or tab (or a trailing `:`)
                // makes this a mapping item, not a rule string; only the
                // full parser can read it.
                if s.contains(": ") || s.contains(":\t") || s.ends_with(':') {
                    return FastScan::Unknown;
                }
                std::borrow::Cow::Borrowed(s)
            };

        let Some(name) = rule_policy_name(&scalar) else {
            continue;
        };

        if !rules_item_ended(&mut lines, item_indent_len.unwrap_or(0)) {
            return FastScan::Unknown;
        }
        return FastScan::Found(name.to_owned());
    }

    FastScan::NoName
}

/// Return the third comma-separated field of a rule string when it is a
/// usable policy-group name: non-empty, not a generic target, at most 64
/// bytes, and only alphanumeric, `-`, `_`, or ASCII whitespace characters.
/// Shared by the fast path and the full parser so the two cannot drift apart.
fn rule_policy_name(rule_str: &str) -> Option<&str> {
    let name = rule_str.split(',').nth(2)?.trim();
    // Zero-allocation case-insensitive comparisons against generic policy target names.
    // Non-ASCII names keep the previous Unicode-aware uppercasing: `to_uppercase`
    // folds characters like `ß` (so `paß` still matches `PASS`), while the ASCII
    // comparison does not, and the old behaviour is what callers relied on.
    let is_generic = if name.is_ascii() {
        name.eq_ignore_ascii_case("DIRECT")
            || name.eq_ignore_ascii_case("REJECT")
            || name.eq_ignore_ascii_case("MATCH")
            || name.eq_ignore_ascii_case("PROXY")
            || name.eq_ignore_ascii_case("PASS")
            || name.eq_ignore_ascii_case("DROP")
    } else {
        let upper = name.to_uppercase();
        upper == "DIRECT"
            || upper == "REJECT"
            || upper == "MATCH"
            || upper == "PROXY"
            || upper == "PASS"
            || upper == "DROP"
    };
    if name.is_empty() || is_generic {
        return None;
    }
    if name.len() > 64 {
        return None;
    }
    if !name
        .chars()
        .all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c.is_ascii_whitespace())
    {
        return None;
    }
    Some(name)
}

/// Extract a name from the rules' policy-group field.
/// Scans up to 10 rules, returns the first non-generic policy-group name.
#[must_use]
pub fn extract_name_from_rules(content: &str) -> Option<String> {
    // Fast path: scan rules lines directly to avoid full serde_yaml AST allocations.
    match extract_name_from_rules_fast(content) {
        FastScan::Found(name) => return Some(name),
        FastScan::NoName => return None,
        FastScan::Unknown => {}
    }

    let yaml: serde_yaml::Value = serde_yaml::from_str(content).ok()?;

    let rules_seq = yaml.get("rules").and_then(|r| r.as_sequence())?;

    if rules_seq.is_empty() {
        return None;
    }

    let max_scan = 10.min(rules_seq.len());
    for rule_val in rules_seq.iter().take(max_scan) {
        let rule_str = match rule_val.as_str() {
            Some(s) => s,
            None => continue,
        };

        let Some(name) = rule_policy_name(rule_str) else {
            continue;
        };

        return Some(name.to_owned());
    }

    None
}

/// Parse filename from a Content-Disposition header value.
/// Supports both `filename="name"` and `filename*=UTF-8''encoded_name` (RFC 5987).
#[must_use]
pub fn parse_content_disposition_filename(header_value: &str) -> Option<String> {
    // Try filename*= first (RFC 5987, takes precedence)
    for raw_part in header_value.split(';') {
        let part = raw_part.trim();
        if let Some(raw_encoded) = part.strip_prefix("filename*=") {
            let encoded = raw_encoded.trim_matches('"');
            if let Some(name) = encoded.split("''").last() {
                let decoded = percent_decode(name);
                let trimmed = decoded.trim();
                if !trimmed.is_empty() {
                    return Some(trimmed.to_owned());
                }
            }
        }
    }
    // Fallback to filename=
    for raw_part in header_value.split(';') {
        let part = raw_part.trim();
        if let Some(filename) = part.strip_prefix("filename=") {
            let trimmed = filename.trim_matches('"').trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_owned());
            }
        }
    }
    None
}

/// Longest profile stem, in bytes, accepted from a `Content-Disposition` name.
const MAX_DISPOSITION_STEM_BYTES: usize = 64;

/// Reduce a `Content-Disposition` filename to a profile file stem.
///
/// The header is server-controlled, and RFC 6266 §4.3 says recipients must
/// not let it choose a directory: only the final path component is used.
/// Some providers send names such as `"site.example/account"`, which used
/// to abort the whole download in the filename sanitizer instead of just
/// dropping the path part.
///
/// The name is fully percent-decoded first, so an encoded separator
/// (`%2F`, `%5C`, `%252F`) is split on as well. A `.yaml`/`.yml` suffix is
/// removed (ASCII case-insensitively), and so is `.json`: a config served
/// as JSON is saved as YAML, so `name.json` must not become
/// `name.json.yaml`. Also removed are the trailing dots and spaces
/// Windows would drop. Returns `None` when nothing usable is left: an empty
/// name, a bare `.`/`..`, or a stem over 64 bytes. The result still has to
/// pass `sanitize_config_file_name`; callers fall back to another name when
/// it does not.
#[must_use]
pub fn disposition_profile_stem(filename: &str) -> Option<String> {
    let decoded = crate::config::sanitizer::url_decode_complete(filename);
    let last = decoded
        .rsplit(['/', '\\'])
        .map(str::trim)
        .find(|segment| !segment.is_empty())?;

    // Trim the characters Windows drops before looking for the extension,
    // so `sample.yaml.` is not treated as the stem `sample.yaml` (which the
    // caller would then turn into `sample.yaml.yaml`).
    let trimmed = last.trim_end_matches([' ', '.']);
    let lower = trimmed.to_ascii_lowercase();
    let without_ext = if lower.ends_with(".yaml") || lower.ends_with(".json") {
        trimmed.get(..trimmed.len() - 5)?
    } else if lower.ends_with(".yml") {
        trimmed.get(..trimmed.len() - 4)?
    } else {
        trimmed
    };

    let stem = without_ext.trim_end_matches([' ', '.']).trim_start();
    if stem.is_empty() || stem.len() > MAX_DISPOSITION_STEM_BYTES {
        return None;
    }
    Some(stem.to_owned())
}

/// Decode percent-encoded string (e.g. "%E4%B8%AD%E6%96%87" → "中文").
#[must_use]
pub fn percent_decode(input: &str) -> String {
    if !input.contains('%') {
        return input.to_owned();
    }

    let mut result = Vec::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0;
    while let Some(&byte) = bytes.get(i) {
        if byte == b'%' {
            if let (Some(hi), Some(lo)) = (
                bytes.get(i + 1).and_then(|&byte| decode_hex_digit(byte)),
                bytes.get(i + 2).and_then(|&byte| decode_hex_digit(byte)),
            ) {
                result.push((hi << 4) | lo);
                i += 3;
                continue;
            }
        }
        result.push(byte);
        i += 1;
    }
    String::from_utf8(result).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned())
}

/// Attempt to base64-decode content that does not already contain Clash markers.
/// Returns `Some(decoded)` only if the decoded bytes are valid UTF-8, valid YAML,
/// and hold a `proxies` or `proxy-groups` list, the same test a JSON config
/// passes. A Clash config encoded as JSON (see [`parse_json_clash_config`])
/// is returned as YAML text, so it reads the same through any YAML parser.
#[must_use]
pub fn try_decode_base64_content(content: &str) -> Option<String> {
    let mut trimmed = Vec::with_capacity(content.len());
    trimmed.extend(
        content
            .bytes()
            .filter(|&byte| !matches!(byte, b'\r' | b'\n' | b' ' | b'\t')),
    );
    let decoded_bytes = base64::engine::general_purpose::STANDARD
        .decode(&trimmed)
        .ok()?;
    let decoded_str = String::from_utf8(decoded_bytes).ok()?;
    // A JSON config comes back as YAML text: callers read the result with a
    // YAML parser, which rejects some valid JSON (a repeated key).
    if let Some(config) = parse_json_clash_config(&decoded_str) {
        return serde_yaml::to_string(&config).ok();
    }
    let yaml_val: serde_yaml::Value = serde_yaml::from_str(&decoded_str).ok()?;
    let is_list = |key: &str| {
        yaml_val
            .get(key)
            .is_some_and(serde_yaml::Value::is_sequence)
    };
    (is_list("proxies") || is_list("proxy-groups")).then_some(decoded_str)
}

/// Parse a Clash config served as JSON, returning it as a YAML value.
///
/// Some panels (BPB Worker Panel, for one) serve the Clash subscription as
/// `JSON.stringify(config)`. JSON is valid YAML, but its text has no
/// `proxies:` marker (the key is written `"proxies":`), so the marker check
/// used for YAML never matches it. The body is read with a JSON parser, so
/// it is read the way JSON defines it: the YAML parser rejects some valid
/// JSON, such as an object that repeats a key (the last value is kept).
///
/// Returns `Some` only for a JSON object whose `proxies` or `proxy-groups`
/// value is a list, like the config a YAML subscription carries. Any other
/// JSON (a sing-box or Xray config, an API reply such as the controller's
/// `{"proxies": {...}}` map) returns `None`. A leading byte order mark and
/// surrounding whitespace are ignored.
#[must_use]
pub fn parse_json_clash_config(content: &str) -> Option<serde_yaml::Value> {
    let body = content.trim_start_matches('\u{feff}').trim();
    if !body.starts_with('{') {
        return None;
    }
    let json: serde_json::Value = serde_json::from_str(body).ok()?;
    let object = json.as_object()?;
    let is_list = |key: &str| object.get(key).is_some_and(serde_json::Value::is_array);
    if !is_list("proxies") && !is_list("proxy-groups") {
        return None;
    }
    serde_yaml::to_value(&json).ok()
}

#[inline]
#[must_use]
pub fn is_mihomo_fake_ip(ip: IpAddr) -> bool {
    FakeIpRanges::default_ref().contains(ip)
}

/// Synthetic fake-IP address ranges in effect for the active core configuration.
///
/// Defaults to the built-in Mihomo ranges (`dns.fake-ip-range` /
/// `dns.fake-ip-range6` defaults). When the active profile configures custom
/// ranges, [`FakeIpRanges::from_config_yaml`] loads them so classification stays
/// in sync with the core: a synthetic address that the classifier does not
/// recognize would otherwise be pinned and dialed as if it were a verified
/// public destination.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FakeIpRanges {
    /// `(network bits, prefix length)` pairs.
    v4: Vec<(u32, u8)>,
    /// `(network bits, prefix length)` pairs.
    v6: Vec<(u128, u8)>,
}

impl Default for FakeIpRanges {
    fn default() -> Self {
        Self::default_ref().clone()
    }
}

impl FakeIpRanges {
    /// Global singleton reference for default fake-IP ranges.
    ///
    /// Avoids 2 heap vector allocations per check when validating against default ranges.
    #[inline]
    #[must_use]
    pub fn default_ref() -> &'static Self {
        static INSTANCE: std::sync::LazyLock<FakeIpRanges> =
            std::sync::LazyLock::new(|| FakeIpRanges {
                // 198.18.0.0/15
                v4: vec![(0xc612_0000, 15)],
                // fdfe:dcba:9876::/64
                v6: vec![(0xfdfe_dcba_9876_0000_0000_0000_0000_0000, 64)],
            });
        &INSTANCE
    }
    /// Parse the configured ranges from a `run_config.yaml` body.
    ///
    /// Absent, empty, or invalid values fall back to the built-in defaults,
    /// matching Mihomo's own behavior.
    #[must_use]
    pub fn from_config_yaml(content: &str) -> Self {
        let Ok(value) = serde_yaml::from_str::<serde_yaml::Value>(content) else {
            return Self::default();
        };
        let dns = value.get("dns");
        let v4 = dns
            .and_then(|d| d.get("fake-ip-range"))
            .and_then(serde_yaml::Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .and_then(parse_v4_cidr)
            .map(|net| vec![net])
            .unwrap_or_else(|| Self::default().v4);
        let v6 = dns
            .and_then(|d| d.get("fake-ip-range6"))
            .and_then(serde_yaml::Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .and_then(parse_v6_cidr)
            .map(|net| vec![net])
            .unwrap_or_else(|| Self::default().v6);
        Self { v4, v6 }
    }

    /// Whether `host` is an IP literal inside a configured fake-IP range.
    ///
    /// Such a literal is not a destination: it is a synthetic address the core
    /// handed out for some other name. `is_literal_private_host` cannot tell it
    /// from a real private address (the default range is 198.18.0.0/15), so
    /// every caller that exempts private literals must reject these first.
    /// IPv6 literals may keep their URL brackets (`[fdfe:dcba:9876::1]`).
    #[must_use]
    pub fn contains_host_literal(&self, host: &str) -> bool {
        let unbracketed = host
            .strip_prefix('[')
            .and_then(|h| h.strip_suffix(']'))
            .unwrap_or(host);
        unbracketed
            .parse::<IpAddr>()
            .is_ok_and(|ip| self.contains(ip))
    }

    /// Whether `ip` falls inside any configured fake-IP range.
    #[must_use]
    pub fn contains(&self, ip: IpAddr) -> bool {
        match ip {
            IpAddr::V4(ipv4) => {
                let bits = u32::from(ipv4);
                self.v4
                    .iter()
                    .any(|(net, prefix)| v4_in_cidr(bits, *net, *prefix))
            }
            IpAddr::V6(ipv6) => {
                let bits = u128::from(ipv6);
                if self
                    .v6
                    .iter()
                    .any(|(net, prefix)| v6_in_cidr(bits, *net, *prefix))
                {
                    return true;
                }
                // IPv4-mapped IPv6 addresses (::ffff:a.b.c.d) are fake IPs when
                // the mapped address is.
                ipv6.to_ipv4_mapped().is_some_and(|mapped| {
                    let bits = u32::from(mapped);
                    self.v4
                        .iter()
                        .any(|(net, prefix)| v4_in_cidr(bits, *net, *prefix))
                })
            }
        }
    }
}

fn parse_v4_cidr(value: &str) -> Option<(u32, u8)> {
    let (addr_str, prefix_str) = value.split_once('/')?;
    let addr: std::net::Ipv4Addr = addr_str.trim().parse().ok()?;
    let prefix: u8 = prefix_str.trim().parse().ok()?;
    (prefix <= 32).then(|| (u32::from(addr), prefix))
}

fn parse_v6_cidr(value: &str) -> Option<(u128, u8)> {
    let (addr_str, prefix_str) = value.split_once('/')?;
    let addr: std::net::Ipv6Addr = addr_str.trim().parse().ok()?;
    let prefix: u8 = prefix_str.trim().parse().ok()?;
    (prefix <= 128).then(|| (u128::from(addr), prefix))
}

#[must_use]
const fn v4_in_cidr(bits: u32, network: u32, prefix: u8) -> bool {
    if prefix == 0 {
        return true;
    }
    let mask = u32::MAX << (32 - prefix);
    (bits & mask) == (network & mask)
}

#[must_use]
const fn v6_in_cidr(bits: u128, network: u128, prefix: u8) -> bool {
    if prefix == 0 {
        return true;
    }
    let mask = u128::MAX << (128 - prefix);
    (bits & mask) == (network & mask)
}

/// Check if an IP address is private, local, or otherwise not a valid public
/// destination for a direct connection.
///
/// This is the single place that decides "safe to dial as a public host", so it
/// covers reserved space as well as the private ranges, on both address families.
/// Mihomo's default fake-IP range (`198.18.0.0/15`) is included: callers normally
/// recognise those answers as synthetic *before* reaching this check, but under a
/// profile with a custom `dns.fake-ip-range` nothing else would reject one.
#[must_use]
pub fn is_private_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ipv4) => is_unsafe_destination_v4(u32::from(ipv4)),
        IpAddr::V6(ipv6) => is_unsafe_destination_v6(ipv6),
    }
}

/// Whether an IPv6 address is private, local, or not a valid public destination.
fn is_unsafe_destination_v6(ipv6: std::net::Ipv6Addr) -> bool {
    let bits = u128::from(ipv6);

    // Direct properties first. The IPv4-embedding prefixes below include `::/96`,
    // which contains `::` and `::1`; judging those by their embedded address
    // would clear them as `0.0.0.0` / `0.0.0.1` and lose the loopback and
    // unspecified verdicts.
    if ipv6.is_loopback()
        || ipv6.is_unspecified()
        || ipv6.is_multicast()
        // Unique local (fc00::/7) and link-local (fe80::/10).
        || (ipv6.segments()[0] & 0xfe00) == 0xfc00
        || (ipv6.segments()[0] & 0xff00) == 0xfe00
        // Documentation range 2001:db8::/32.
        || v6_in_cidr(bits, 0x2001_0db8_0000_0000_0000_0000_0000_0000, 32)
    {
        return true;
    }

    // Otherwise, for an IPv4-embedding address, decide on the embedded address
    // rather than on the wrapper: `::ffff:169.254.169.254` and
    // `64:ff9b::a9fe:a9fe` are the same destination as the IPv4 address, and
    // must be judged the same way.
    //
    // `to_ipv4()` is deliberately not used: it also folds `::1` into `0.0.0.1`.
    embedded_ipv4(bits)
        .into_iter()
        .flatten()
        .any(is_unsafe_destination_v4)
}

/// The IPv4 destinations an IPv6 address may embed, for every prefix that
/// carries one; empty for any other address. The address is unsafe when any
/// of them is.
///
/// - IPv4-mapped `::ffff:0:0/96`, IPv4-compatible `::/96` and NAT64 well-known
///   `64:ff9b::/96` (RFC 6052): the low 32 bits.
/// - NAT64 local-use `64:ff9b:1::/48` (RFC 8215), deployed either as a /96 inside
///   it or as a /48, and the address alone does not say which. A /48 uses RFC
///   6052's split layout: 16 bits right after the prefix, the reserved `u`
///   octet, the other 16 bits, then a zero suffix. The canonical forms a DNS64
///   synthesizes are unambiguous: a zero `u` octet and suffix is the /48
///   layout, zero bits between the prefix and the low 32 bits is a /96. Any
///   other address could reach either reading depending on the translator, so
///   both are returned.
/// - 6to4 `2002::/16` (RFC 3056): bits 16-47.
/// - Teredo `2001::/32` (RFC 4380): the client address, stored inverted in the
///   low 32 bits.
fn embedded_ipv4(bits: u128) -> [Option<u32>; 2] {
    let low32 = u32::try_from(bits & 0xffff_ffff).unwrap_or(0);
    let field = |shift: u32| u32::try_from((bits >> shift) & 0xffff_ffff).unwrap_or(0);
    if v6_in_cidr(bits, 0x0000_0000_0000_0000_0000_ffff_0000_0000, 96)
        || v6_in_cidr(bits, 0, 96)
        || v6_in_cidr(bits, 0x0064_ff9b_0000_0000_0000_0000_0000_0000, 96)
    {
        return [Some(low32), None];
    }
    if v6_in_cidr(bits, 0x0064_ff9b_0001_0000_0000_0000_0000_0000, 48) {
        let split = ((field(64) & 0xffff) << 16) | (field(40) & 0xffff);
        let split_layout = bits & 0xff00_00ff_ffff_ffff == 0;
        let low_layout = bits & 0xffff_ffff_ffff_0000_0000 == 0;
        return [
            (split_layout || !low_layout).then_some(split),
            (!split_layout).then_some(low32),
        ];
    }
    if v6_in_cidr(bits, 0x2002_0000_0000_0000_0000_0000_0000_0000, 16) {
        return [Some(field(80)), None];
    }
    if v6_in_cidr(bits, 0x2001_0000_0000_0000_0000_0000_0000_0000, 32) {
        return [Some(!low32), None];
    }
    [None, None]
}

/// Whether a raw IPv4 address is private, local, or otherwise not a valid
/// public destination for a direct connection.
///
/// This is the single place that decides "safe to dial as a public host", so it
/// has to cover reserved space as well as the private ranges: a remote
/// subscription server can redirect a download to a *hostname*, and only the
/// resolved addresses are checked. Without the reserved ranges below, a
/// hostname resolving into carrier-grade NAT space is accepted — and that space
/// is where internal tailnets and cloud metadata endpoints live (for example
/// Alibaba Cloud's metadata service at `100.100.100.200`).
fn is_unsafe_destination_v4(bits: u32) -> bool {
    let addr = std::net::Ipv4Addr::from(bits);
    addr.is_private()
        || addr.is_loopback()
        || addr.is_link_local()
        || addr.is_broadcast()
        || addr.is_documentation()
        // "This network" 0.0.0.0/8 (RFC 1122), which includes the unspecified
        // address: never a valid destination, and some stacks route it locally.
        || v4_in_cidr(bits, 0, 8)
        // RFC 2544 benchmarking range 198.18.0.0/15: reserved, never globally
        // routable, and the default Mihomo fake-IP range.
        || v4_in_cidr(bits, 0xc612_0000, 15)
        // RFC 6598 shared address space (carrier-grade NAT): 100.64.0.0/10. Used
        // by Tailscale and cloud metadata services.
        || v4_in_cidr(bits, 0x6440_0000, 10)
        // IETF protocol assignments: 192.0.0.0/24.
        || v4_in_cidr(bits, 0xc000_0000, 24)
        // Multicast: 224.0.0.0/4.
        || v4_in_cidr(bits, 0xe000_0000, 4)
        // Reserved for future use: 240.0.0.0/4 (includes the broadcast address).
        || v4_in_cidr(bits, 0xf000_0000, 4)
}

/// Zero-allocation check whether `s` ends with `suffix` (ASCII case-insensitively).
#[inline]
fn ends_with_ignore_ascii_case(s: &str, suffix: &str) -> bool {
    let s_bytes = s.as_bytes();
    let suffix_bytes = suffix.as_bytes();
    s_bytes
        .len()
        .checked_sub(suffix_bytes.len())
        .and_then(|start| s_bytes.get(start..))
        .is_some_and(|tail| tail.eq_ignore_ascii_case(suffix_bytes))
}

/// Zero-allocation helper to strip `prefix` from `s` (ASCII case-insensitively).
#[inline]
fn strip_prefix_ignore_ascii_case<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    let s_bytes = s.as_bytes();
    let prefix_bytes = prefix.as_bytes();
    let head = s_bytes.get(..prefix_bytes.len())?;
    if head.eq_ignore_ascii_case(prefix_bytes) {
        s.get(prefix_bytes.len()..)
    } else {
        None
    }
}

/// Check if a host is a private or local address (SSRF protection)
///
/// Optimization:
/// - Uses zero-allocation ASCII case-insensitive comparisons instead of allocating `host.to_lowercase()`.
/// - Drops heap allocations on the SSRF validation hot path to zero.
#[must_use]
pub fn is_private_host(host: &str) -> bool {
    let trimmed = host.trim();
    if trimmed.is_empty() {
        return false;
    }
    let normalized = trimmed.trim_end_matches('.');
    if normalized.is_empty() {
        return false;
    }

    if normalized.eq_ignore_ascii_case("localhost")
        || ends_with_ignore_ascii_case(normalized, ".localhost")
        || ends_with_ignore_ascii_case(normalized, ".local")
        || ends_with_ignore_ascii_case(normalized, ".internal")
        || ends_with_ignore_ascii_case(normalized, ".intranet")
        || ends_with_ignore_ascii_case(normalized, ".private")
        || ends_with_ignore_ascii_case(normalized, ".lan")
        || normalized.eq_ignore_ascii_case("home.arpa")
        || ends_with_ignore_ascii_case(normalized, ".home.arpa")
        || ends_with_ignore_ascii_case(normalized, ".home")
        || ends_with_ignore_ascii_case(normalized, ".corp")
    {
        return true;
    }

    let unbracketed = normalized
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(normalized);

    if let Ok(ip) = unbracketed.parse::<IpAddr>() {
        return is_private_ip(ip);
    }

    false
}

/// Check if a host is a single-label non-IP host (e.g. "myhost", "router").
/// Single-label hosts are strictly direct-only to prevent internal SSRF via proxies.
#[must_use]
pub fn is_single_label_host(host: &str) -> bool {
    let trimmed = host.trim();
    let normalized = trimmed.trim_end_matches('.');
    let unbracketed = normalized
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(normalized);
    !unbracketed.contains('.') && unbracketed.parse::<IpAddr>().is_err()
}

/// Check if a host is a literal private IP address or localhost.
/// Unlike `is_private_host`, this returns false for private domain name suffixes
/// (.internal, .lan, etc.) so domain names are still subject to DNS resolution and
/// destination IP validation rather than being treated as pre-trusted addresses.
///
/// Optimization:
/// - Replaces heap allocation `host.to_lowercase()` with zero-allocation ASCII case-insensitive checks.
#[must_use]
pub fn is_literal_private_host(host: &str) -> bool {
    let trimmed = host.trim();
    if trimmed.is_empty() {
        return false;
    }
    let normalized = trimmed.trim_end_matches('.');
    if normalized.is_empty() {
        return false;
    }

    if normalized.eq_ignore_ascii_case("localhost")
        || ends_with_ignore_ascii_case(normalized, ".localhost")
    {
        return true;
    }

    let unbracketed = normalized
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(normalized);

    if let Ok(ip) = unbracketed.parse::<IpAddr>() {
        return is_private_ip(ip);
    }

    false
}

/// Validate and sanitize a subscription name to prevent path traversal and injection attacks.
pub fn validate_subscription_name(name: &str) -> Result<String, crate::error::AppError> {
    if name.is_empty() {
        return Err(crate::error::AppError::ConfigError(
            "Subscription name cannot be empty".to_owned(),
        ));
    }
    crate::config::sanitizer::sanitize_base_filename(name.to_owned())
}

/// Validate User-Agent string length and characters to prevent HTTP header injection and settings bloat.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn validate_user_agent(ua: &str) -> Result<(), crate::error::AppError> {
    if ua.len() > 512 {
        return Err(crate::error::AppError::ConfigError(
            "User-Agent string too long: maximum 512 bytes allowed".to_owned(),
        ));
    }
    if ua.chars().any(char::is_control) {
        return Err(crate::error::AppError::ConfigError(
            "User-Agent contains invalid control characters".to_owned(),
        ));
    }
    Ok(())
}

/// Dedicated error type for public host address validation, distinguishing SSRF policy blocks
/// from transient or empty DNS lookup results.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PublicHostAddrError {
    SsrfBlocked(String),
    NoAddresses(String),
    Other(String),
}

impl std::fmt::Display for PublicHostAddrError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::SsrfBlocked(msg) | Self::NoAddresses(msg) | Self::Other(msg) => {
                write!(f, "{msg}")
            }
        }
    }
}

impl std::error::Error for PublicHostAddrError {}

/// Core validation logic for a public host's resolved addresses.
/// Extracted so tests can inject mock DNS results without real DNS.
pub fn validate_public_host_addrs(
    host: &str,
    addrs: &[std::net::SocketAddr],
) -> Result<(String, Option<std::net::SocketAddr>, bool), PublicHostAddrError> {
    validate_public_host_addrs_with_ranges(host, addrs, FakeIpRanges::default_ref())
}

/// Like [`validate_public_host_addrs`], but classifies synthetic addresses
/// against the active core configuration's fake-IP ranges.
pub fn validate_public_host_addrs_with_ranges(
    host: &str,
    addrs: &[std::net::SocketAddr],
    fake_ip_ranges: &FakeIpRanges,
) -> Result<(String, Option<std::net::SocketAddr>, bool), PublicHostAddrError> {
    let mut resolved_addr = None;
    let mut saw_fake_ip = false;

    for addr in addrs {
        if fake_ip_ranges.contains(addr.ip()) {
            saw_fake_ip = true;
            continue;
        }
        if is_private_ip(addr.ip()) {
            return Err(PublicHostAddrError::SsrfBlocked(format!(
                "SSRF protection: host '{host}' resolved to private IP {} — access to private/local addresses is not allowed. \
                 If this is a trusted internal subscription, enter the private address directly (e.g. http://192.168.x.x) instead of using a domain name.",
                addr.ip()
            )));
        }
        if resolved_addr.is_none() {
            resolved_addr = Some(*addr);
        }
    }

    if resolved_addr.is_none() {
        if saw_fake_ip {
            return Err(PublicHostAddrError::NoAddresses(format!(
                "DNS resolved to synthetic fake-IP address for '{host}', cannot pin for direct connection"
            )));
        }
        return Err(PublicHostAddrError::NoAddresses(
            "Could not resolve any IP address for the host".to_owned(),
        ));
    }

    Ok((host.to_owned(), resolved_addr, false))
}

/// Validate URL scheme, host, and port without DNS resolution.
/// Returns `(host, port, user_entered_private)`.
pub fn validate_subscription_url_basic(url: &str) -> Result<(String, u16, bool), String> {
    let trimmed = url.trim();
    // The WHATWG parser silently drops tab/LF/CR anywhere in the input, so a
    // guard on the raw string would check a different URL than the one parsed
    // (`http://\t/sub` parses as `http:///sub`, host `sub`). No valid
    // subscription link contains control characters: reject them outright.
    if trimmed.chars().any(|c| c.is_ascii_control()) {
        return Err("Invalid URL: must not contain control characters".to_owned());
    }
    // WHATWG parsing of special schemes ignores scheme case and missing or extra
    // slashes (`HTTP:///sub`, `http:/sub` both parse with host `sub`), which
    // would turn a malformed URL into an authorized single-label intranet host.
    // Require exactly `//` followed by an authority.
    //
    // Optimization:
    // - Inspect borrowed string slices directly via `strip_prefix_ignore_ascii_case`
    //   instead of allocating a lowercased `String` (`trimmed.to_ascii_lowercase()`).
    // - Eliminates heap string allocations on this hot URL validation entry path.
    if let Some(rest) = strip_prefix_ignore_ascii_case(trimmed, "http:")
        .or_else(|| strip_prefix_ignore_ascii_case(trimmed, "https:"))
    {
        let mut chars = rest.chars();
        let slashes_ok = matches!((chars.next(), chars.next()), (Some('/'), Some('/')));
        if !slashes_ok || matches!(chars.next(), None | Some('/' | '\\')) {
            return Err("URL must have a host".to_owned());
        }
    }

    let parsed_url = url::Url::parse(trimmed).map_err(|e| format!("Invalid URL: {e}"))?;

    let scheme = parsed_url.scheme();
    if scheme != "http" && scheme != "https" {
        return Err("Only HTTP and HTTPS URLs are allowed".to_owned());
    }

    let host = parsed_url.host_str().ok_or("URL must have a host")?;
    if host.trim().is_empty() {
        return Err("URL must have a host".to_owned());
    }

    // An explicitly entered single-label name (e.g. `nas`, `router`) is an
    // intranet destination like a private-suffix name: direct-only, pinned to a
    // non-synthetic address, and the only private host its redirects may reach.
    let user_entered_private = is_private_host(host) || is_single_label_host(host);

    let default_port = if scheme == "https" { 443 } else { 80 };
    let port = parsed_url.port().unwrap_or(default_port);

    Ok((host.to_owned(), port, user_entered_private))
}

/// Pick the first non-synthetic address for an explicitly entered
/// private-suffix hostname (authorized direct-only LAN destination).
///
/// Extracted from [`validate_subscription_url_with_ip`] so the fake-IP
/// filtering can be tested without DNS. Returns `None` when every address is
/// synthetic or the list is empty.
#[must_use]
pub fn first_non_fake_addr(
    addrs: &[std::net::SocketAddr],
    fake_ip_ranges: &FakeIpRanges,
) -> Option<std::net::SocketAddr> {
    addrs
        .iter()
        .copied()
        .find(|a| !fake_ip_ranges.contains(a.ip()))
}

/// Validate URL and its resolved IPs for SSRF protection.
/// Returns `(host, resolved_addr, user_entered_private)`.
///
/// Uses the built-in default fake-IP ranges. Callers that can read the active
/// core configuration should use [`validate_subscription_url_with_ip_with_ranges`],
/// otherwise a profile with a custom `dns.fake-ip-range` can have a synthetic
/// address mistaken for a real one.
pub fn validate_subscription_url_with_ip(
    url: &str,
) -> Result<(String, Option<std::net::SocketAddr>, bool), String> {
    validate_subscription_url_with_ip_with_ranges(url, FakeIpRanges::default_ref())
}

/// [`validate_subscription_url_with_ip`] with the active fake-IP ranges.
///
/// The ranges must come from the same configuration the destination will be
/// reached through: a synthetic address is only recognizable against the range
/// that produced it, so a custom `dns.fake-ip-range` address passed to the
/// default-range variant would be treated as a real destination and pinned.
pub fn validate_subscription_url_with_ip_with_ranges(
    url: &str,
    fake_ip_ranges: &FakeIpRanges,
) -> Result<(String, Option<std::net::SocketAddr>, bool), String> {
    let (host, port, user_entered_private) = validate_subscription_url_basic(url)?;
    if fake_ip_ranges.contains_host_literal(&host) {
        return Err(format!(
            "Invalid URL: synthetic fake-IP address '{host}' cannot be used as a subscription host"
        ));
    }

    if is_literal_private_host(&host) {
        return Ok((host, None, true));
    }

    let addrs: Vec<std::net::SocketAddr> =
        std::net::ToSocketAddrs::to_socket_addrs(&format!("{host}:{port}"))
            .map_err(|e| format!("DNS resolution failed for '{host}': {e}"))?
            .collect();

    if user_entered_private {
        // Explicitly entered private-suffix hostname (e.g. nas.local, router.lan, svc.internal).
        // It is an authorized direct-only LAN destination.
        // Pin the first non-synthetic address and treat as user_entered_private (direct-only).
        let Some(addr) = first_non_fake_addr(&addrs, fake_ip_ranges) else {
            return Err(format!(
                "Private host '{host}' could not be resolved to a non-synthetic IP address"
            ));
        };
        return Ok((host, Some(addr), true));
    }

    validate_public_host_addrs_with_ranges(&host, &addrs, fake_ip_ranges).map_err(|e| e.to_string())
}

fn contains_http_status(e: &str) -> bool {
    e.match_indices("HTTP ").any(|(i, _)| {
        e.as_bytes()
            .get(i + 5..i + 8)
            .is_some_and(|d| d.iter().all(u8::is_ascii_digit))
    })
}

/// Determine the appropriate error code based on the error message content.
///
/// A message that reports two tiers (`Direct: …; Proxy: …`) carries two
/// failures. Precedence otherwise stays as before — the first matching arm wins,
/// whatever tier it came from — with one exception: a direct-leg SSRF verdict
/// must not mask a proxy-leg failure of a different kind. The download path
/// escalates `Direct DNS returned non-public address` to the proxy *on purpose*
/// (that hop bypasses the direct SSRF check by design), so reporting an ordinary
/// proxy connection failure as `SUB_SSRF_BLOCKED` would tell the user their
/// request was blocked by SSRF protection when it was not.
///
/// When the proxy leg actually ran and failed with text carrying no specific
/// marker — `Download failed: tcp connect error: Connection refused (os error
/// 111)` is the common shape, since none of the markers match a raw transport
/// error — that is still a connection failure rather than a security block, so it
/// is reported as [`SUB_NETWORK_ERROR`].
///
/// Migrated from `src-tauri/src/core/subscription.rs`.
#[cfg_attr(feature = "uniffi", uniffi::export)]
#[must_use]
pub fn classify_sub_error(e: String) -> u16 {
    const TIER_SEPARATOR: &str = "; Proxy: ";
    if let Some(idx) = e.find(TIER_SEPARATOR) {
        let direct_part = &e[..idx];
        let proxy_part = &e[idx + TIER_SEPARATOR.len()..];
        let direct_code = classify_sub_error_message(direct_part);
        let proxy_code = classify_sub_error_message(proxy_part);
        // `skipped` means the proxy leg never issued a request (whatever reason
        // text follows, e.g. a deadline), so the direct leg's diagnosis is still
        // the best answer; a leg that ran and failed did issue one.
        if direct_code == crate::event::codes::SUB_SSRF_BLOCKED
            && proxy_code != crate::event::codes::SUB_SSRF_BLOCKED
            && !proxy_part.trim_start().starts_with("skipped")
        {
            if proxy_code != crate::event::codes::SUB_UPDATE_FAILED {
                return proxy_code;
            }
            return crate::event::codes::SUB_NETWORK_ERROR;
        }
    }
    classify_sub_error_message(&e)
}

#[must_use]
fn classify_sub_error_message(e: &str) -> u16 {
    if e.contains("SSRF protection")
        || e.contains("[SSRF_BLOCKED]")
        || e.contains("SSRF blocked")
        || e.contains("Direct SSRF blocked")
        || e.contains("Proxy SSRF blocked")
        || e.contains("Global-mode SSRF blocked")
        || e.contains("Redirect to private host blocked")
        || e.contains("Redirect to private IP blocked")
        || e.contains("[LOCAL_DNS_SSRF]")
        || e.contains("Direct DNS returned non-public address")
    {
        crate::event::codes::SUB_SSRF_BLOCKED
    } else if e.contains("Invalid URL")
        || e.contains("Only HTTP")
        || e.contains("must have a host")
        || e.contains("URL must not be empty")
    {
        crate::event::codes::SUB_URL_INVALID
    } else if contains_http_status(e) {
        crate::event::codes::SUB_HTTP_ERROR
    } else if e.contains("DNS resolution failed")
        || e.contains("Could not resolve")
        || e.contains("DNS resolution returned no addresses")
        || e.contains("DNS deadline elapsed")
        || e.contains("DNS resolution timed out")
        || e.contains("DNS resolution timeout")
        || e.contains("synthetic fake-IP")
    {
        crate::event::codes::SUB_DNS_FAILED
    } else if e.contains("Subscription name")
        || e.contains("Path traversal detected")
        || e.contains("Invalid character in filename")
        || e.contains("Filename too long")
        || e.contains("Reserved filename")
        || e.contains("reserved name")
        || e.contains("Invalid file type")
    {
        crate::event::codes::SUB_NAME_INVALID
    } else if e.contains("timeout")
        || e.contains("Timeout")
        || e.contains("timed out")
        || e.contains("deadline exceeded")
    {
        crate::event::codes::SUB_UPDATE_TIMEOUT
    } else if e.contains("Response too large") || e.contains("exceeded size limit") {
        crate::event::codes::SUB_RESPONSE_TOO_LARGE
    } else if e.contains("Invalid YAML")
        || e.contains("YAML structure")
        || e.contains("neither a valid Clash YAML")
    {
        crate::event::codes::SUB_YAML_INVALID
    } else if e.contains("Connection failed")
        || e.contains("Network error")
        || e.contains("Request error")
        || e.contains("Direct:")
        || e.contains("Proxy:")
    {
        crate::event::codes::SUB_NETWORK_ERROR
    } else {
        crate::event::codes::SUB_UPDATE_FAILED
    }
}

/// Strip query parameters, username, and password from any http(s) URL in a string.
///
/// This prevents leaking subscription tokens to logs and frontend.
/// Migrated from `src-tauri/src/core/subscription.rs`.
///
/// Optimization:
/// - Streams masked output directly into pre-allocated `result` buffer via `format_masked_url_to`.
/// - Avoids `to_owned()` intermediate heap allocations for URL strings and parts.
/// - Parses the URL slice directly instead of allocating temporary `String`s.
#[cfg_attr(feature = "uniffi", uniffi::export)]
#[must_use]
pub fn redact_url_in_string(s: String) -> String {
    if !s.contains("http") {
        return s;
    }

    let mut result = String::with_capacity(s.len());
    let mut start_idx = 0;
    while start_idx < s.len() {
        let remaining = &s[start_idx..];
        let found_http = remaining.find("http://");
        let found_https = remaining.find("https://");
        let found_offset = found_http.into_iter().chain(found_https).min();
        let Some(offset) = found_offset else {
            result.push_str(remaining);
            break;
        };
        let start = start_idx + offset;
        result.push_str(&s[start_idx..start]);
        // Find end of URL (whitespace or end of string)
        let mut url_end = s[start..]
            .find(|c: char| c.is_whitespace())
            .map(|pos| start + pos)
            .unwrap_or(s.len());
        // Trim trailing punctuation/delimiters that are likely not part of the URL
        while url_end > start {
            let last_char = s[..url_end].chars().next_back();
            if let Some(c) = last_char {
                if matches!(
                    c,
                    ')' | ']' | '}' | '>' | '"' | '\'' | ',' | '.' | ';' | ':'
                ) {
                    url_end -= c.len_utf8();
                } else {
                    break;
                }
            } else {
                break;
            }
        }
        let url_str = &s[start..url_end];
        if url::Url::parse(url_str).is_ok() {
            crate::config::merge::format_masked_url_to(url_str, &mut result);
            start_idx = url_end;
        } else {
            let is_https = s[start..].starts_with("https://");
            let skip_len = if is_https { 5 } else { 4 };
            result.push_str(&s[start..start + skip_len]);
            start_idx = start + skip_len;
        }
    }
    result
}

/// Batch update result for a single subscription.
/// Migrated from `src-tauri/src/core/subscription.rs`.
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
#[derive(Debug, Clone, serde::Serialize)]
pub struct BatchUpdateResult {
    pub name: String,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Input item for batch subscription update.
/// Migrated from `src-tauri/src/core/subscription.rs`.
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
#[derive(Debug, Clone, serde::Deserialize)]
pub struct BatchUpdateItem {
    /// If None, the URL is resolved internally from metadata.
    pub url: Option<String>,
    pub name: String,
}

/// 从 mihomo /proxies 返回的字典中提取全局模式候选节点及当前 GLOBAL 选中项。
/// 纯函数，便于独立单元测试。
pub fn select_global_candidate(
    proxies: &serde_json::Map<String, serde_json::Value>,
) -> Option<(String, Option<String>)> {
    let global_obj = proxies.get("GLOBAL");
    let global_now = global_obj
        .and_then(|g| g.get("now"))
        .and_then(|n| n.as_str())
        .map(std::borrow::ToOwned::to_owned);

    fn is_special_target(s: &str) -> bool {
        matches!(
            s,
            "DIRECT" | "REJECT" | "REJECT-DROP" | "PASS" | "PASS-RULE" | "COMPATIBLE"
        )
    }

    let global_all: Vec<&str> = global_obj
        .and_then(|g| g.get("all"))
        .and_then(|a| a.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str()).collect())
        .unwrap_or_default();

    // Fast O(1) set for candidate checking in `is_valid_global_candidate`.
    let global_all_set: std::collections::HashSet<&str> = global_all.iter().copied().collect();

    // 递归解析候选节点/策略组，确保最终生效的叶子节点存在于 proxies 中且不是 DIRECT / REJECT 等特殊目标。
    // 使用 visited 集合（零内存分配 &'a str）检测当前路径上的循环依赖，使用 memo 共享已完成的验证结果。
    fn check_node_resolves_to_proxy<'a>(
        name: &'a str,
        proxies: &'a serde_json::Map<String, serde_json::Value>,
        visited: &mut std::collections::HashSet<&'a str>,
        memo: &mut std::collections::HashMap<&'a str, bool>,
        depth: usize,
    ) -> (bool, bool) {
        if let Some(&cached) = memo.get(name) {
            return (cached, false);
        }
        if depth > proxies.len().max(16) {
            return (false, true);
        }
        if is_special_target(name) {
            memo.insert(name, false);
            return (false, false);
        }
        if visited.contains(name) {
            return (false, true);
        }
        let Some(p_obj) = proxies.get(name) else {
            memo.insert(name, false);
            return (false, false);
        };
        let p_type = p_obj.get("type").and_then(|t| t.as_str()).unwrap_or("");
        let picks_one_member = p_type.eq_ignore_ascii_case("Selector")
            || p_type.eq_ignore_ascii_case("URLTest")
            || p_type.eq_ignore_ascii_case("Fallback");
        // Classify groups by shape as well as by type: a core fork can report
        // group types this list does not know (e.g. "Smart"), and treating such
        // an entry as a leaf would skip its members, `DIRECT` included.
        let has_members = p_obj.get("all").is_some_and(serde_json::Value::is_array);
        if picks_one_member
            || has_members
            || p_type.eq_ignore_ascii_case("LoadBalance")
            || p_type.eq_ignore_ascii_case("Relay")
        {
            visited.insert(name);
            // Every entry of `all` must resolve, for LoadBalance as well as Relay, even
            // when `now` points at a live member. A Relay's chain is only as
            // strong as its weakest member, and a LoadBalance member that
            // resolves to `DIRECT` or is dead is a path out of the group that
            // bypasses the proxy or drops the traffic — so one healthy `now`
            // says nothing about the rest. Skipping them here would let
            // `select_global_candidate` return a group whose traffic can go
            // direct, which is the one thing this function exists to prevent.
            // Unknown group types follow `now` when they report one (like the
            // selecting groups); without it, every member has to resolve.
            let checks_all_members = !picks_one_member
                && (p_type.eq_ignore_ascii_case("Relay")
                    || p_type.eq_ignore_ascii_case("LoadBalance")
                    || p_obj.get("now").and_then(|n| n.as_str()).is_none());
            if checks_all_members {
                if let Some(all_arr) = p_obj.get("all").and_then(|a| a.as_array()) {
                    let members: Vec<&str> = all_arr.iter().filter_map(|v| v.as_str()).collect();
                    if !members.is_empty() {
                        let mut any_cycle = false;
                        let mut all_ok = true;
                        for member in members {
                            let (ok, cycle) = check_node_resolves_to_proxy(
                                member,
                                proxies,
                                visited,
                                memo,
                                depth + 1,
                            );
                            if cycle {
                                any_cycle = true;
                            }
                            if !ok {
                                all_ok = false;
                                break;
                            }
                        }
                        visited.remove(name);
                        if !any_cycle || all_ok {
                            memo.insert(name, all_ok);
                        }
                        return (all_ok, any_cycle);
                    }
                }
            }
            if let Some(next_now) = p_obj.get("now").and_then(|n| n.as_str()) {
                let (res, cycle) =
                    check_node_resolves_to_proxy(next_now, proxies, visited, memo, depth + 1);
                visited.remove(name);
                if !cycle || res {
                    memo.insert(name, res);
                }
                return (res, cycle);
            }
            visited.remove(name);
            memo.insert(name, false);
            return (false, false);
        }
        if p_type.is_empty()
            || p_type.eq_ignore_ascii_case("Direct")
            || p_type.eq_ignore_ascii_case("Reject")
            || p_type.eq_ignore_ascii_case("RejectDrop")
            || p_type.eq_ignore_ascii_case("Pass")
            || p_type.eq_ignore_ascii_case("Pass-Rule")
            || p_type.eq_ignore_ascii_case("Compatible")
        {
            memo.insert(name, false);
            return (false, false);
        }
        let alive = p_obj.get("alive").and_then(serde_json::Value::as_bool) != Some(false);
        memo.insert(name, alive);
        (alive, false)
    }

    let mut memo = std::collections::HashMap::new();
    let mut resolves_to_effective_proxy = |start_name: &str| -> bool {
        let mut visited = std::collections::HashSet::new();
        // Look up `start_name` in `proxies` to get a slice with lifetime matching `proxies`.
        // If it doesn't exist in `proxies`, `check_node_resolves_to_proxy` would return false anyway.
        if let Some((k, _)) = proxies.get_key_value(start_name) {
            check_node_resolves_to_proxy(k.as_str(), proxies, &mut visited, &mut memo, 0).0
        } else {
            false
        }
    };

    let mut is_valid_global_candidate =
        |s: &str| global_all_set.contains(s) && resolves_to_effective_proxy(s);

    let active_node = global_now
        .as_deref()
        .filter(|n| is_valid_global_candidate(n))
        .map(std::borrow::ToOwned::to_owned)
        .or_else(|| {
            // Priority 1: Walk GLOBAL's `all` member list in order for groups.
            // This preserves the configuration's group order, where the user's primary group comes first.
            for &member_name in &global_all {
                if member_name == "GLOBAL" || is_special_target(member_name) {
                    continue;
                }
                if let Some(proxy_val) = proxies.get(member_name) {
                    let p_type = proxy_val.get("type").and_then(|t| t.as_str()).unwrap_or("");
                    if p_type.eq_ignore_ascii_case("Selector")
                        || p_type.eq_ignore_ascii_case("URLTest")
                        || p_type.eq_ignore_ascii_case("Fallback")
                    {
                        if let Some(now) = proxy_val.get("now").and_then(|n| n.as_str()) {
                            if is_valid_global_candidate(now) {
                                return Some(now.to_owned());
                            }
                        }
                        if is_valid_global_candidate(member_name) {
                            return Some(member_name.to_owned());
                        }
                    }
                }
            }

            // Priority 2: Fall back to scanning all groups in `proxies` map.
            for (name, proxy_val) in proxies {
                if name == "GLOBAL" || is_special_target(name) {
                    continue;
                }
                let p_type = proxy_val.get("type").and_then(|t| t.as_str()).unwrap_or("");
                if p_type.eq_ignore_ascii_case("Selector")
                    || p_type.eq_ignore_ascii_case("URLTest")
                    || p_type.eq_ignore_ascii_case("Fallback")
                {
                    if let Some(now) = proxy_val.get("now").and_then(|n| n.as_str()) {
                        if is_valid_global_candidate(now) {
                            return Some(now.to_owned());
                        }
                    }
                    if is_valid_global_candidate(name) {
                        return Some(name.clone());
                    }
                }
            }

            // Priority 3: Look through GLOBAL's member list `all` for the first valid candidate (leaf node).
            for &member_name in &global_all {
                if is_valid_global_candidate(member_name) {
                    return Some(member_name.to_owned());
                }
            }

            None
        })?;

    Some((active_node, global_now))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_user_agent() {
        // Valid User-Agents
        assert!(validate_user_agent("clash-verge/v2").is_ok());
        assert!(validate_user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)").is_ok());
        assert!(validate_user_agent("Shadowrocket/3082 CFNetwork/3826.600.41").is_ok());

        // Oversized User-Agent (> 512 bytes; the limit counts bytes, not chars)
        let long_ua = "a".repeat(513);
        let err = validate_user_agent(&long_ua).unwrap_err();
        assert!(err.to_string().contains("512 bytes"), "{err}");

        // Multibyte proof of the byte limit: 300 'é' are only 300 chars but
        // 600 bytes, so a chars-counting implementation would wrongly accept
        // this; exactly 512 bytes (256 'é') still passes.
        assert!(validate_user_agent(&"é".repeat(300)).is_err());
        assert!(validate_user_agent(&"é".repeat(256)).is_ok());

        // User-Agent containing control characters (\r, \n, \0)
        assert!(validate_user_agent("clash\r\nHeader: injected").is_err());
        assert!(validate_user_agent("clash\nHeader: injected").is_err());
        assert!(validate_user_agent("clash\0").is_err());
        assert!(validate_user_agent("clash\x1b").is_err());
        // `char::is_control` also covers the non-ASCII C1 controls: an
        // ASCII-only check would still pass the assertions above while
        // accepting these.
        assert!(validate_user_agent("clash\u{85}").is_err());
        assert!(validate_user_agent("clash\u{9f}").is_err());
    }

    #[test]
    fn test_is_private_ip_v4() {
        assert!(is_private_ip("10.0.0.1".parse().unwrap()));
        assert!(is_private_ip("172.16.0.1".parse().unwrap()));
        assert!(is_private_ip("192.168.1.1".parse().unwrap()));
        assert!(is_private_ip("127.0.0.1".parse().unwrap()));
        assert!(is_private_ip("169.254.1.1".parse().unwrap()));
        assert!(is_private_ip("0.0.0.0".parse().unwrap()));
        // RFC 2544 benchmarking range: reserved, never globally routable. It is also
        // Mihomo's default fake-IP range, but `is_private_ip` must reject it on
        // its own so a custom `dns.fake-ip-range` cannot make it look public.
        assert!(is_private_ip("198.18.0.1".parse().unwrap()));
        assert!(is_private_ip("198.19.255.254".parse().unwrap()));
        assert!(is_private_ip("::ffff:198.18.0.1".parse().unwrap()));
        assert!(!is_private_ip("198.17.255.255".parse().unwrap()));
        assert!(!is_private_ip("198.20.0.1".parse().unwrap()));
        // Reserved space that must never be dialled as a public destination.
        // A remote subscription server can redirect to a hostname resolving
        // into these ranges, so only the resolved address is checked.
        for ip in [
            // "This network" 0.0.0.0/8, not only the unspecified address.
            "0.0.0.0",
            "0.1.2.3",
            "0.255.255.255",
            // RFC 6598 carrier-grade NAT (Tailscale, cloud metadata).
            "100.64.0.0",
            "100.100.100.200",
            "100.127.255.255",
            // IETF protocol assignments.
            "192.0.0.1",
            // Multicast.
            "224.0.0.1",
            "239.255.255.250",
            // Reserved for future use.
            "240.0.0.1",
            "255.255.255.255",
        ] {
            assert!(is_private_ip(ip.parse().unwrap()), "{ip} must be blocked");
        }
        // The mapped IPv6 form goes through the same helper.
        assert!(is_private_ip("::ffff:100.100.100.200".parse().unwrap()));
        // Just outside each reserved block stays usable.
        for ip in [
            "100.63.255.255",
            "100.128.0.0",
            "192.0.1.1",
            "223.255.255.255",
        ] {
            assert!(!is_private_ip(ip.parse().unwrap()), "{ip} must stay public");
        }
        assert!(is_mihomo_fake_ip("198.18.0.1".parse().unwrap()));
        assert!(is_mihomo_fake_ip("198.19.255.254".parse().unwrap()));
        assert!(!is_mihomo_fake_ip("8.8.8.8".parse().unwrap()));
        assert!(!is_private_ip("8.8.8.8".parse().unwrap()));
        assert!(!is_private_ip("1.1.1.1".parse().unwrap()));
    }

    #[test]
    fn test_is_private_ip_nat64_local_use() {
        // RFC 6052 /48 layout under the local-use prefix: the IPv4 address is
        // split around the `u` octet, not in the low 32 bits.
        assert!(!is_private_ip("64:ff9b:1:808:8:800::".parse().unwrap()));
        assert!(is_private_ip("64:ff9b:1:a9fe:a9:fe00::".parse().unwrap()));
        // A non-canonical local-use address is judged by both readings: here
        // the low 32 bits say 8.8.8.8, but a /48 translator that ignores the
        // reserved suffix sends it to 10.0.0.1.
        assert!(is_private_ip(
            "64:ff9b:1:a00:0:100:808:808".parse().unwrap()
        ));
        // The canonical /96 form of a public address stays usable.
        assert!(!is_private_ip("64:ff9b:1::808:808".parse().unwrap()));
    }

    #[test]
    fn test_is_private_ip_v6() {
        assert!(is_private_ip("::1".parse().unwrap()));
        assert!(is_private_ip("::".parse().unwrap()));
        assert!(is_private_ip("fc00::1".parse().unwrap()));
        assert!(is_private_ip("fe80::1".parse().unwrap()));
        assert!(!is_private_ip("2001:4860:4860::8888".parse().unwrap()));
        // Multicast and documentation ranges.
        assert!(is_private_ip("ff00::1".parse().unwrap()));
        assert!(is_private_ip("ff02::1".parse().unwrap()));
        assert!(is_private_ip("2001:db8::1".parse().unwrap()));
        // IPv4-embedding prefixes must not walk past the IPv4 rules. Each of
        // these is the same destination as the blocked IPv4 address beside it,
        // so a redirect to any of them reaches the same internal host.
        for ip in [
            // NAT64 well-known prefix: 64:ff9b::a9fe:a9fe == 169.254.169.254,
            // the cloud metadata address.
            "64:ff9b::a9fe:a9fe",
            // NAT64 local-use prefix (RFC 8215), same embedded address.
            "64:ff9b:1::a9fe:a9fe",
            // IPv4-compatible (deprecated) form of the same address.
            "::a9fe:a9fe",
            // A carrier-grade NAT address, which the v4 rules now block.
            "::6440:0001",
        ] {
            assert!(is_private_ip(ip.parse().unwrap()), "{ip} must be blocked");
        }
        // The mapped form of a private v4 address stays blocked.
        assert!(is_private_ip("::ffff:127.0.0.1".parse().unwrap()));
        assert!(is_private_ip("::ffff:10.0.0.1".parse().unwrap()));
        // Embedding prefixes carrying a genuinely public address stay usable,
        // so the rule rejects the destination and not the notation.
        assert!(!is_private_ip("::ffff:8.8.8.8".parse().unwrap()));
        assert!(!is_private_ip("64:ff9b::808:808".parse().unwrap()));
        // 6to4 carries the IPv4 address in bits 16-47; Teredo stores the client
        // address inverted in the low 32 bits.
        assert!(is_private_ip("2002:a9fe:a9fe::".parse().unwrap()));
        assert!(is_private_ip("2002:c0a8:0101::1".parse().unwrap()));
        assert!(!is_private_ip("2002:0808:0808::1".parse().unwrap()));
        assert!(is_private_ip(
            "2001:0:4136:e378:8000:63bf:5601:5efe".parse().unwrap()
        ));
        assert!(!is_private_ip(
            "2001:0:4136:e378:8000:63bf:f7f7:f7f7".parse().unwrap()
        ));
        assert!(!is_private_ip("2606:4700:4700::1111".parse().unwrap()));
        assert!(is_mihomo_fake_ip("::ffff:198.18.0.1".parse().unwrap()));
        assert!(!is_mihomo_fake_ip("::ffff:8.8.8.8".parse().unwrap()));
    }

    #[test]
    fn test_is_private_host() {
        assert!(is_private_host("localhost"));
        assert!(is_private_host("my.localhost"));
        assert!(is_private_host("my.local"));
        assert!(is_private_host("service.internal"));
        assert!(is_private_host("router.lan"));
        assert!(is_private_host("device.home.arpa"));
        assert!(is_private_host("home.arpa"));
        assert!(is_private_host("127.0.0.1"));
        assert!(is_private_host("10.0.0.1"));
        assert!(is_private_host("192.168.1.1"));
        assert!(is_private_host("172.16.0.1"));
        assert!(is_private_host("::1"));
        assert!(is_private_host("[::1]"));
        assert!(is_private_host("[fd00::1]"));
        assert!(is_private_host("[fe80::1]"));
        assert!(is_private_host("nas.corp"));
        assert!(is_private_host("gateway.home"));
        assert!(!is_private_host("router"));
        assert!(!is_private_host("intranet"));
        assert!(!is_private_host("my.test"));
        assert!(!is_private_host("example.com"));
        assert!(!is_private_host("1.1.1.1"));
        assert!(!is_private_host("8.8.8.8"));
        assert!(!is_private_host("[2606:4700:4700::1111]"));
    }

    #[test]
    fn test_is_literal_private_host() {
        assert!(is_literal_private_host("localhost"));
        assert!(is_literal_private_host("my.localhost"));
        assert!(is_literal_private_host("127.0.0.1"));
        assert!(is_literal_private_host("10.0.0.1"));
        assert!(is_literal_private_host("192.168.1.1"));
        assert!(is_literal_private_host("172.16.0.1"));
        assert!(is_literal_private_host("::1"));
        assert!(is_literal_private_host("[::1]"));
        assert!(is_literal_private_host("[fd00::1]"));
        assert!(is_literal_private_host("[fe80::1]"));

        // Domain names must return false so they undergo DNS resolution and destination-IP validation
        assert!(!is_literal_private_host("service.internal"));
        assert!(!is_literal_private_host("router.lan"));
        assert!(!is_literal_private_host("device.home.arpa"));
        assert!(!is_literal_private_host("home.arpa"));
        assert!(!is_literal_private_host("my.local"));
        assert!(!is_literal_private_host("nas.corp"));
        assert!(!is_literal_private_host("gateway.home"));
        assert!(!is_literal_private_host("example.com"));
        assert!(!is_literal_private_host("8.8.8.8"));
    }

    #[test]
    fn test_is_private_host_trailing_dots_and_empty() {
        assert!(is_private_host("service.internal."));
        assert!(is_private_host("service.internal.."));
        assert!(is_private_host("router.lan."));
        assert!(is_private_host("router.lan..."));
        assert!(is_private_host("localhost."));
        assert!(is_private_host("localhost.."));
        assert!(is_private_host("127.0.0.1.."));
        assert!(is_literal_private_host("localhost.."));
        assert!(is_literal_private_host("127.0.0.1.."));
        assert!(is_single_label_host("myhost.."));
        assert!(!is_private_host(""));
        assert!(!is_private_host("   "));
        assert!(!is_private_host("."));
        assert!(!is_private_host(".."));
    }

    #[test]
    fn test_parse_json_clash_config_accepts_clash_json() {
        let json = r#"{
    "mixed-port": 7890,
    "proxies": [
        { "name": "node-a", "type": "trojan", "server": "a.example.com", "port": 443, "password": "p" }
    ],
    "proxy-groups": [
        { "name": "Select", "type": "select", "proxies": ["node-a"] }
    ],
    "rules": ["MATCH,Select"]
}"#;
        let value = parse_json_clash_config(json).unwrap();
        assert_eq!(
            value.get("mixed-port").and_then(serde_yaml::Value::as_u64),
            Some(7890)
        );
        let proxies = value.get("proxies").unwrap().as_sequence().unwrap();
        assert_eq!(proxies.len(), 1);
        assert_eq!(
            proxies.first().unwrap().get("name").unwrap().as_str(),
            Some("node-a")
        );
        assert_eq!(
            value
                .get("rules")
                .unwrap()
                .as_sequence()
                .unwrap()
                .first()
                .unwrap()
                .as_str(),
            Some("MATCH,Select")
        );

        // Key order is kept, so the saved YAML reads in the server's order.
        let keys: Vec<&str> = value
            .as_mapping()
            .unwrap()
            .keys()
            .filter_map(serde_yaml::Value::as_str)
            .collect();
        assert_eq!(keys, ["mixed-port", "proxies", "proxy-groups", "rules"]);

        // A byte order mark, surrounding whitespace and tab indentation are fine.
        let with_bom = format!("\u{feff}\n\t{}\n\n", json.replace("    ", "\t"));
        assert_eq!(parse_json_clash_config(&with_bom), Some(value));

        // A repeated key, which the YAML parser rejects, keeps its last value.
        let repeated = r#"{"mode":"global","mode":"rule","proxies":[]}"#;
        assert!(serde_yaml::from_str::<serde_yaml::Value>(repeated).is_err());
        assert_eq!(
            parse_json_clash_config(repeated)
                .unwrap()
                .get("mode")
                .and_then(serde_yaml::Value::as_str),
            Some("rule")
        );

        // A config with groups but no inline proxies (providers only) counts.
        let groups_only = r#"{"proxy-groups":[{"name":"G","type":"select","use":["p"]}]}"#;
        assert!(parse_json_clash_config(groups_only).is_some());
    }

    #[test]
    fn test_parse_json_clash_config_rejects_other_content() {
        // YAML, node lists and broken JSON are left to the other checks.
        assert!(parse_json_clash_config("proxies:\n  - name: a\n").is_none());
        assert!(parse_json_clash_config("https://example.com/sub").is_none());
        assert!(parse_json_clash_config("{\"proxies\": [").is_none());
        assert!(parse_json_clash_config("").is_none());
        // JSON that is not a Clash config: an array, a sing-box config, and
        // the controller's `/proxies` reply, whose `proxies` is a map.
        assert!(parse_json_clash_config(r#"[{"proxies": []}]"#).is_none());
        assert!(
            parse_json_clash_config(r#"{"outbounds":[{"type":"direct","tag":"direct"}]}"#)
                .is_none()
        );
        assert!(parse_json_clash_config(r#"{"proxies":{"DIRECT":{"type":"Direct"}}}"#).is_none());
        assert!(parse_json_clash_config(r#"{"proxies":null,"proxy-groups":"x"}"#).is_none());
    }

    #[test]
    fn test_try_decode_base64_content_accepts_json_config() {
        let json = r#"{"proxies":[{"name":"a","type":"ss","server":"a.example.com","port":443}]}"#;
        let encoded = base64::engine::general_purpose::STANDARD.encode(json);
        let decoded = try_decode_base64_content(&encoded).unwrap();
        let value: serde_yaml::Value = serde_yaml::from_str(&decoded).unwrap();
        assert_eq!(value, parse_json_clash_config(json).unwrap());

        // A repeated key is valid JSON but not valid YAML; the decoded text
        // must still parse as YAML, keeping the last value like JSON does.
        let repeated = r#"{"port":1,"port":7890,"proxies":[{"name":"a","type":"ss"}]}"#;
        let encoded = base64::engine::general_purpose::STANDARD.encode(repeated);
        let decoded = try_decode_base64_content(&encoded).unwrap();
        let value: serde_yaml::Value = serde_yaml::from_str(&decoded).unwrap();
        assert_eq!(
            value.get("port").and_then(serde_yaml::Value::as_u64),
            Some(7890)
        );

        let sing_box = base64::engine::general_purpose::STANDARD.encode(r#"{"outbounds":[]}"#);
        assert!(try_decode_base64_content(&sing_box).is_none());
    }

    #[test]
    fn test_try_decode_base64_content() {
        let yaml = "proxies:\n  - name: test\n    type: ss\n    port: 443";
        let encoded = base64::engine::general_purpose::STANDARD.encode(yaml);
        let result = try_decode_base64_content(&encoded);
        assert!(result.is_some());
        assert!(result.unwrap().contains("proxies:"));

        assert!(try_decode_base64_content("not base64 at all!!!").is_none());

        let not_yaml = base64::engine::general_purpose::STANDARD.encode("just some random text");
        assert!(try_decode_base64_content(&not_yaml).is_none());

        // A YAML config with only proxy groups passes, like a JSON one.
        let groups = "proxy-groups:\n  - name: Auto\n    type: select\n    proxies: [DIRECT]\n";
        let encoded = base64::engine::general_purpose::STANDARD.encode(groups);
        assert_eq!(try_decode_base64_content(&encoded).as_deref(), Some(groups));
        let map = base64::engine::general_purpose::STANDARD.encode("proxy-groups: {a: 1}\n");
        assert!(try_decode_base64_content(&map).is_none());
    }

    #[test]
    fn test_quote_short_id_values_simple() {
        let yaml = r"short-id: abc123";
        let result = quote_short_id_values(yaml);
        assert_eq!(result, r#"short-id: "abc123""#);
    }

    #[test]
    fn test_quote_short_id_values_hex_like() {
        let yaml = r"short-id: 34010e92";
        let result = quote_short_id_values(yaml);
        assert_eq!(result, r#"short-id: "34010e92""#);
    }

    #[test]
    fn test_quote_short_id_values_already_quoted() {
        let yaml = r#"short-id: "abc123""#;
        let result = quote_short_id_values(yaml);
        assert_eq!(result, r#"short-id: "abc123""#);
    }

    #[test]
    fn test_quote_short_id_values_skips_block_scalar_text() {
        // Text inside a block scalar is not a key and must stay as written.
        let yaml = "proxies:\n  - name: a\n    password: |\n      short-id: abc\n\n      more\n    short-id: 34010e92\n  - name: b\n    note: >-\n      short-id: def\n    reality-opts:\n      short-id: 1e5\n";
        let result = quote_short_id_values(yaml);
        assert_eq!(
            result,
            "proxies:\n  - name: a\n    password: |\n      short-id: abc\n\n      more\n    short-id: \"34010e92\"\n  - name: b\n    note: >-\n      short-id: def\n    reality-opts:\n      short-id: \"1e5\"\n"
        );
        let value: serde_yaml::Value = serde_yaml::from_str(&result).unwrap();
        let proxies = value
            .get("proxies")
            .and_then(serde_yaml::Value::as_sequence)
            .unwrap();
        let first = proxies.first().unwrap();
        assert_eq!(
            first.get("password").and_then(serde_yaml::Value::as_str),
            Some("short-id: abc\n\nmore\n")
        );
        assert_eq!(
            first.get("short-id").and_then(serde_yaml::Value::as_str),
            Some("34010e92")
        );

        // A block scalar that is itself a sequence entry, and one with an
        // anchor and an indentation indicator.
        let yaml =
            "notes:\n  - |\n    short-id: abc\n  - &n |2\n    short-id: def\nshort-id: 34010e92\n";
        assert_eq!(
            quote_short_id_values(yaml),
            "notes:\n  - |\n    short-id: abc\n  - &n |2\n    short-id: def\nshort-id: \"34010e92\"\n"
        );
    }

    #[test]
    fn test_quote_short_id_values_value_on_next_line() {
        // YAML allows the value on a following, more indented line.
        let yaml = "reality-opts:\n  short-id:\n    34010e92\n";
        let result = quote_short_id_values(yaml);
        assert_eq!(result, "reality-opts:\n  short-id:\n    \"34010e92\"\n");
        let value: serde_yaml::Value = serde_yaml::from_str(&result).unwrap();
        assert_eq!(
            value
                .get("reality-opts")
                .and_then(|opts| opts.get("short-id"))
                .and_then(serde_yaml::Value::as_str),
            Some("34010e92")
        );
        // Blank lines and comments may come between; a comment may follow.
        assert_eq!(
            quote_short_id_values("short-id: # id\n\n  # hex\n  1e5 # x\nb: 1\n"),
            "short-id: # id\n\n  # hex\n  \"1e5\" # x\nb: 1\n"
        );
        // A line that is not more indented, or is not one plain scalar, is
        // not the value.
        for yaml in [
            "a:\n  short-id:\n  b: 1e5\n",
            "short-id:\n  - 1e5\n",
            "short-id:\n  'abc'\n",
            "short-id:\n  1e5\n  2e5\n",
            "short-id:\nb: 1\n",
        ] {
            assert_eq!(quote_short_id_values(yaml), yaml, "{yaml}");
        }
    }

    #[test]
    fn test_quote_short_id_values_block_scalar_edge_cases() {
        // A comment that looks like a block scalar key starts nothing.
        let yaml = "reality-opts:\n# sample: |\n  short-id: 34010e92\n";
        let result = quote_short_id_values(yaml);
        assert_eq!(
            result,
            "reality-opts:\n# sample: |\n  short-id: \"34010e92\"\n"
        );
        let value: serde_yaml::Value = serde_yaml::from_str(&result).unwrap();
        assert_eq!(
            value
                .get("reality-opts")
                .and_then(|opts| opts.get("short-id"))
                .and_then(serde_yaml::Value::as_str),
            Some("34010e92")
        );
        // A quoted key holding `: ` still owns its block scalar.
        let yaml = "\"a: b\": |\n  short-id: abc\nshort-id: 34010e92\n";
        assert_eq!(
            quote_short_id_values(yaml),
            "\"a: b\": |\n  short-id: abc\nshort-id: \"34010e92\"\n"
        );
        // `a |` is a plain scalar, so the next line is a key.
        let yaml = "k: a |\nshort-id: 1e5\n";
        assert_eq!(quote_short_id_values(yaml), "k: a |\nshort-id: \"1e5\"\n");
    }

    #[test]
    fn test_quote_short_id_values_whole_plain_scalar() {
        // A plain scalar of several words is quoted whole, keeping the
        // comment after it; quotes and backslashes in it are escaped.
        for (yaml, quoted, value) in [
            (
                "short-id: abc def # c\n",
                "short-id: \"abc def\" # c\n",
                "abc def",
            ),
            (
                "short-id:\n  1e5 2e5\n",
                "short-id:\n  \"1e5 2e5\"\n",
                "1e5 2e5",
            ),
            (r#"short-id: a"b\c"#, r#"short-id: "a\"b\\c""#, r#"a"b\c"#),
        ] {
            let result = quote_short_id_values(yaml);
            assert_eq!(result, quoted, "{yaml}");
            let parsed: serde_yaml::Value = serde_yaml::from_str(&result).unwrap();
            assert_eq!(
                parsed.get("short-id").and_then(serde_yaml::Value::as_str),
                Some(value),
                "{yaml}"
            );
        }
        // A plain scalar that goes on over the next line is left alone.
        let yaml = "short-id: 1e5\n  2e5\nb: 1\n";
        assert_eq!(quote_short_id_values(yaml), yaml);
    }

    #[test]
    fn test_quote_short_id_values_flow_mapping() {
        let yaml = "proxies:\n  - {name: a, reality-opts: {public-key: k, short-id: 34010e92}}\n  - name: b\n    reality-opts: {short-id: 1e5, public-key: k}\n";
        let result = quote_short_id_values(yaml);
        assert_eq!(
            result,
            "proxies:\n  - {name: a, reality-opts: {public-key: k, short-id: \"34010e92\"}}\n  - name: b\n    reality-opts: {short-id: \"1e5\", public-key: k}\n"
        );
        let value: serde_yaml::Value = serde_yaml::from_str(&result).unwrap();
        let short_ids: Vec<_> = value
            .get("proxies")
            .and_then(serde_yaml::Value::as_sequence)
            .unwrap()
            .iter()
            .map(|proxy| {
                proxy
                    .get("reality-opts")
                    .and_then(|opts| opts.get("short-id"))
                    .and_then(serde_yaml::Value::as_str)
            })
            .collect();
        assert_eq!(short_ids, [Some("34010e92"), Some("1e5")]);
        // A closing brace on its own line ends the value too.
        let yaml =
            "reality-opts: {\n  short-id: 34010e92\n}\nb: {\n  short-id: 1e5 # c\n  , x: 1}\n";
        let result = quote_short_id_values(yaml);
        assert_eq!(
            result,
            "reality-opts: {\n  short-id: \"34010e92\"\n}\nb: {\n  short-id: \"1e5\" # c\n  , x: 1}\n"
        );
        let value: serde_yaml::Value = serde_yaml::from_str(&result).unwrap();
        assert_eq!(
            value
                .get("reality-opts")
                .and_then(|opts| opts.get("short-id"))
                .and_then(serde_yaml::Value::as_str),
            Some("34010e92")
        );
        // A flow scalar that goes on over the next line is left alone.
        let yaml = "a: {short-id: 1e5\n  2e5}\n";
        assert_eq!(quote_short_id_values(yaml), yaml);
        // Quoted, flow and other values inside a flow mapping are left alone.
        for yaml in [
            "a: {short-id: 'x', b: 1}\n",
            "a: {short-id: [x]}\n",
            "a: {myshort-id: 1e5}\n",
        ] {
            assert_eq!(quote_short_id_values(yaml), yaml, "{yaml}");
        }
    }

    #[test]
    fn test_quote_short_id_values_quoted_key() {
        // A quoted key is the same key in YAML.
        let yaml = "reality-opts:\n  \"short-id\": 34010e92\nb: {'short-id': 1e5}\n";
        let result = quote_short_id_values(yaml);
        assert_eq!(
            result,
            "reality-opts:\n  \"short-id\": \"34010e92\"\nb: {'short-id': \"1e5\"}\n"
        );
        let value: serde_yaml::Value = serde_yaml::from_str(&result).unwrap();
        assert_eq!(
            value
                .get("reality-opts")
                .and_then(|opts| opts.get("short-id"))
                .and_then(serde_yaml::Value::as_str),
            Some("34010e92")
        );
        // A quoted value that only holds the key's text is not a key.
        for yaml in [
            "a: \"short-id\"\n",
            "a: \"short-id: 1e5\"\n",
            "\"short-ids\": 1e5\n",
        ] {
            assert_eq!(quote_short_id_values(yaml), yaml, "{yaml}");
        }
    }

    #[test]
    fn test_quote_short_id_values_skips_quoted_scalar_text() {
        // A quoted scalar may span lines; its text is not a key.
        for yaml in [
            "password: 'prefix\n  short-id: abc\n  it''s'\nshort-id: 34010e92\n",
            "password: \"prefix \\\" \n  short-id: abc\n  suffix\"\nshort-id: 34010e92\n",
            "a: [\"x\n  short-id: abc\"]\nshort-id: 34010e92\n",
        ] {
            let result = quote_short_id_values(yaml);
            let expected = yaml.replace("short-id: 34010e92", "short-id: \"34010e92\"");
            assert_eq!(result, expected, "{yaml}");
            let value: serde_yaml::Value = serde_yaml::from_str(&result).unwrap();
            assert_eq!(
                value.get("short-id").and_then(serde_yaml::Value::as_str),
                Some("34010e92"),
                "{yaml}"
            );
        }
        // A quote inside a plain scalar opens nothing.
        let yaml = "name: it's\nshort-id: 1e5\n";
        assert_eq!(
            quote_short_id_values(yaml),
            "name: it's\nshort-id: \"1e5\"\n"
        );
    }

    /// Quote `yaml`, check the result, and check that it parses with every
    /// `short-id` value read as the string `id`.
    fn assert_quotes_short_ids(yaml: &str, expected: &str, ids: &[&str]) {
        let result = quote_short_id_values(yaml);
        assert_eq!(result, expected, "{yaml:?}");
        let value: serde_yaml::Value = serde_yaml::from_str(&result).unwrap();
        let mut found = Vec::new();
        collect_short_ids(&value, &mut found);
        assert_eq!(found, ids, "{yaml:?}");
    }

    fn collect_short_ids(value: &serde_yaml::Value, found: &mut Vec<String>) {
        match value {
            serde_yaml::Value::Mapping(map) => {
                for (key, item) in map {
                    if key.as_str() == Some("short-id") {
                        found.push(
                            item.as_str()
                                .map_or_else(|| format!("{item:?}"), str::to_owned),
                        );
                    } else {
                        collect_short_ids(item, found);
                    }
                }
            }
            serde_yaml::Value::Sequence(items) => {
                for item in items {
                    collect_short_ids(item, found);
                }
            }
            serde_yaml::Value::Null
            | serde_yaml::Value::Bool(_)
            | serde_yaml::Value::Number(_)
            | serde_yaml::Value::String(_)
            | serde_yaml::Value::Tagged(_) => {}
        }
    }

    #[test]
    fn test_quote_short_id_values_lone_cr_line_breaks() {
        // YAML reads a lone CR as a line break, like LF.
        assert_quotes_short_ids(
            "a: 1\rshort-id: 34010e92\r",
            "a: 1\rshort-id: \"34010e92\"\r",
            &["34010e92"],
        );
        assert_quotes_short_ids(
            "reality-opts:\r  short-id:\r    1e5\rb: 1\r",
            "reality-opts:\r  short-id:\r    \"1e5\"\rb: 1\r",
            &["1e5"],
        );
        // A block scalar ended by a lone CR does not hide the next key.
        assert_quotes_short_ids(
            "password: |\r  text\rshort-id: 1e5\r",
            "password: |\r  text\rshort-id: \"1e5\"\r",
            &["1e5"],
        );
    }

    #[test]
    fn test_quote_short_id_values_plain_continuation_lines() {
        // A line that goes on with a plain scalar is plain text: a quote at
        // its start opens nothing.
        assert_quotes_short_ids(
            "proxies:\n  - name: Node\n      'West\n    reality-opts:\n      short-id: 34010e92\n",
            "proxies:\n  - name: Node\n      'West\n    reality-opts:\n      short-id: \"34010e92\"\n",
            &["34010e92"],
        );
        // Also when it follows lines read without a quote, and further
        // continuation lines.
        assert_quotes_short_ids(
            "a: 1\nname: Node\n  West\n\n  \"East\n  {x\nshort-id: 1e5\n",
            "a: 1\nname: Node\n  West\n\n  \"East\n  {x\nshort-id: \"1e5\"\n",
            &["1e5"],
        );
        // After a continuation line that has a quote later on.
        assert_quotes_short_ids(
            "name: Node\n  We'st\n  'East\nshort-id: 1e5\n",
            "name: Node\n  We'st\n  'East\nshort-id: \"1e5\"\n",
            &["1e5"],
        );
        // A `- ` entry's scalar goes on past a deeper `- ` line.
        assert_quotes_short_ids(
            "list:\n  - x\n    - 'y\nshort-id: 1e5\n",
            "list:\n  - x\n    - 'y\nshort-id: \"1e5\"\n",
            &["1e5"],
        );
        // A short-id value that goes on is left alone, and so are its lines.
        let yaml = "short-id: abc\n  'def\nb: 1\n";
        assert_eq!(quote_short_id_values(yaml), yaml);
        let yaml = "short-id:\n  abc\n  'def\nb: 1\n";
        assert_eq!(quote_short_id_values(yaml), yaml);
        // A key at the same depth is not a continuation.
        assert_quotes_short_ids(
            "- name: Node\n  'short-id': 1e5\n",
            "- name: Node\n  'short-id': \"1e5\"\n",
            &["1e5"],
        );
        assert_quotes_short_ids(
            "a:\n  b: c\n  'd': e\n  short-id: 1e5\n",
            "a:\n  b: c\n  'd': e\n  short-id: \"1e5\"\n",
            &["1e5"],
        );
        // In a flow collection, a plain scalar going on over the next line
        // keeps a quote there as text.
        assert_quotes_short_ids(
            "a: {name: Node\n  'West, short-id: 1e5}\n",
            "a: {name: Node\n  'West, short-id: \"1e5\"}\n",
            &["1e5"],
        );
    }

    #[test]
    fn test_quote_short_id_values_keeps_null() {
        // A plain null means no short ID and stays null.
        for null in ["null", "Null", "NULL", "~"] {
            let yaml = format!("a:\n  short-id: {null}\nb: {{short-id: {null}}}\n");
            assert_eq!(quote_short_id_values(&yaml), yaml, "{null}");
            let value: serde_yaml::Value = serde_yaml::from_str(&yaml).unwrap();
            let short_id = value.get("a").and_then(|a| a.get("short-id"));
            assert!(short_id.is_some_and(serde_yaml::Value::is_null), "{null}");
        }
        // Other words are still quoted, and a null next to them stays.
        assert_quotes_short_ids(
            "a: {short-id: nil}\nb: {short-id: null}\nc: {short-id: nullx}\n",
            "a: {short-id: \"nil\"}\nb: {short-id: null}\nc: {short-id: \"nullx\"}\n",
            &["nil", "Null", "nullx"],
        );
        // A JSON config read back from YAML keeps its null.
        let json = r#"{"proxies":[{"name":"n","reality-opts":{"short-id":null}}]}"#;
        let yaml = serde_yaml::to_string(&parse_json_clash_config(json).unwrap()).unwrap();
        let value: serde_yaml::Value = serde_yaml::from_str(&quote_short_id_values(&yaml)).unwrap();
        let short_id = value
            .get("proxies")
            .and_then(|p| p.get(0))
            .and_then(|p| p.get("reality-opts"))
            .and_then(|r| r.get("short-id"));
        assert!(short_id.is_some_and(serde_yaml::Value::is_null));
    }

    #[test]
    fn test_quote_short_id_values_unicode_line_breaks() {
        // The YAML parser also ends lines at NEL, LS and PS.
        for line_break in ["\u{85}", "\u{2028}", "\u{2029}"] {
            let yaml = format!("a:\n  short-id: 34010e92{line_break}  public-key: k\n");
            let expected = yaml.replace("34010e92", "\"34010e92\"");
            assert_quotes_short_ids(&yaml, &expected, &["34010e92"]);
            let yaml = format!("a: 1{line_break}short-id: 1e5{line_break}");
            let expected = yaml.replace("1e5", "\"1e5\"");
            assert_quotes_short_ids(&yaml, &expected, &["1e5"]);
        }
        // Other text with the same lead bytes is not a line break.
        assert_quotes_short_ids(
            "name: \u{201c}Node\u{201d} \u{a9}\nshort-id: 1e5\n",
            "name: \u{201c}Node\u{201d} \u{a9}\nshort-id: \"1e5\"\n",
            &["1e5"],
        );
    }

    #[test]
    fn test_quote_short_id_values_blanks_before_colon() {
        // YAML allows blanks between a key and its colon.
        assert_quotes_short_ids(
            "a:\n  short-id : 34010e92\nb:\n  \"short-id\"\t: 1e5\n",
            "a:\n  short-id : \"34010e92\"\nb:\n  \"short-id\"\t: \"1e5\"\n",
            &["34010e92", "1e5"],
        );
        assert_quotes_short_ids(
            "a: {short-id : 1e5, b: {'short-id' :34010e92}}\n",
            "a: {short-id : \"1e5\", b: {'short-id' :\"34010e92\"}}\n",
            &["1e5", "34010e92"],
        );
        // A plain key still needs a blank after the colon.
        let yaml = "a: {short-id :1e5}\n";
        assert_eq!(quote_short_id_values(yaml), yaml);
    }

    #[test]
    fn test_quote_short_id_values_document_markers() {
        // A document marker is not a plain scalar that the indented lines
        // after it go on with.
        for marker in ["---", "--- # doc", "..."] {
            let yaml = format!(
                "{marker}\n  proxies: [\n    {{name: n, reality-opts: {{\n      short-id: 1e5\n    }}}}\n  ]\n"
            );
            let expected = yaml.replace("short-id: 1e5", "short-id: \"1e5\"");
            if marker == "..." {
                // `...` must close a document first; only the quoting is
                // checked here.
                assert_eq!(quote_short_id_values(&yaml), expected, "{marker}");
            } else {
                assert_quotes_short_ids(&yaml, &expected, &["1e5"]);
            }
        }
        // Also when the marker line is read for a quote of its own.
        assert_quotes_short_ids("--- 'doc'\n", "--- 'doc'\n", &[]);
        // The root node may start on the marker's line.
        assert_quotes_short_ids(
            "--- {\"proxies\":[{\"name\":\"n\",\"reality-opts\":{\"short-id\":34010e92}}]}\n",
            "--- {\"proxies\":[{\"name\":\"n\",\"reality-opts\":{\"short-id\":\"34010e92\"}}]}\n",
            &["34010e92"],
        );
        // Between two documents, which serde_yaml does not read as one.
        assert_eq!(
            quote_short_id_values("a: 1\n---\n  b: {short-id: 1e5}\n"),
            "a: 1\n---\n  b: {short-id: \"1e5\"}\n"
        );
    }

    #[test]
    fn test_quote_short_id_values_flow_edge_cases() {
        // After a quoted key in a flow mapping, the value may follow the
        // colon with no space.
        assert_quotes_short_ids(
            "a: {\"short-id\":34010e92}\nb: {'short-id':1e5, c: 1}\n",
            "a: {\"short-id\":\"34010e92\"}\nb: {'short-id':\"1e5\", c: 1}\n",
            &["34010e92", "1e5"],
        );
        // Likewise after any quoted key: the quoted value is not text
        // to search for keys.
        assert_quotes_short_ids(
            "a: {\"k\":'x, short-id: 1', short-id: 1e5}\n",
            "a: {\"k\":'x, short-id: 1', short-id: \"1e5\"}\n",
            &["1e5"],
        );
        // A plain key needs the space: `short-id:1e5` is one scalar.
        let yaml = "a: {short-id:1e5}\n";
        assert_eq!(quote_short_id_values(yaml), yaml);
        // The value of a flow `short-id:` may come on a later line.
        assert_quotes_short_ids(
            "a: {\n  short-id:\n  # note\n\n    34010e92\n}\n",
            "a: {\n  short-id:\n  # note\n\n    \"34010e92\"\n}\n",
            &["34010e92"],
        );
        assert_quotes_short_ids(
            "a: {short-id:\n 1e5, b: 1}\n",
            "a: {short-id:\n \"1e5\", b: 1}\n",
            &["1e5"],
        );
        for yaml in [
            "a: {short-id:\n , b: 1}\n",
            "a: {short-id:\n 'x', b: 1}\n",
            "a: {short-id:\n abc\n def}\n",
        ] {
            assert_eq!(quote_short_id_values(yaml), yaml, "{yaml}");
        }
    }

    #[test]
    fn test_quote_short_id_values_leaves_non_plain_values() {
        for yaml in [
            "short-id: 'abc'",
            "short-id: # no value",
            "short-id: &id 34010e92",
            "short-id: *id",
            "short-id: !!str 34010e92",
            "short-id: [a]",
            "short-id:",
            "short-id:\n  public-key: abc\n",
        ] {
            assert_eq!(quote_short_id_values(yaml), yaml, "{yaml}");
        }
        // A comment after the value and CRLF line endings are kept.
        assert_eq!(
            quote_short_id_values("a: 1\r\nshort-id: 34010e92 # hex\r\n"),
            "a: 1\r\nshort-id: \"34010e92\" # hex\r\n"
        );
    }

    #[test]
    fn test_extract_name_from_rules() {
        // Standard unquoted rules
        let yaml_simple = "rules:\n  - DOMAIN-SUFFIX,example.com,Airport-1\n";
        assert_eq!(
            extract_name_from_rules(yaml_simple),
            Some("Airport-1".to_owned())
        );

        // Quoted rules (double and single quotes)
        let yaml_quoted = "rules:\n  - \"DOMAIN-SUFFIX,example.com,Airport-Double\"\n  - 'DOMAIN-SUFFIX,example.com,Airport-Single'\n";
        assert_eq!(
            extract_name_from_rules(yaml_quoted),
            Some("Airport-Double".to_owned())
        );

        // Generic policy names skipped
        let yaml_generic = "rules:\n  - DOMAIN-SUFFIX,site1.com,DIRECT\n  - DOMAIN-SUFFIX,site2.com,REJECT\n  - DOMAIN-SUFFIX,site3.com,Airport-Custom\n";
        assert_eq!(
            extract_name_from_rules(yaml_generic),
            Some("Airport-Custom".to_owned())
        );

        // Skips invalid characters / names > 64 chars
        let long_name = "A".repeat(65);
        let yaml_long = format!("rules:\n  - DOMAIN-SUFFIX,site1.com,{long_name}\n  - DOMAIN-SUFFIX,site2.com,ValidGroup\n");
        assert_eq!(
            extract_name_from_rules(&yaml_long),
            Some("ValidGroup".to_owned())
        );

        // Empty rules or missing rules section
        assert_eq!(extract_name_from_rules("rules: []"), None);
        assert_eq!(extract_name_from_rules("port: 7890\n"), None);

        // Fallback parity when rules section has unusual layout
        let yaml_unusual = "rules: [ 'DOMAIN-SUFFIX,site1.com,UnusualGroup' ]\n";
        assert_eq!(
            extract_name_from_rules(yaml_unusual),
            Some("UnusualGroup".to_owned())
        );
    }

    #[test]
    fn test_extract_name_from_rules_fast_path_parity() {
        // `#` without preceding whitespace is scalar content, not a comment:
        // `Group#1` fails the safety check, so the next rule wins.
        let yaml_hash =
            "rules:\n  - DOMAIN-SUFFIX,example.com,Group#1\n  - DOMAIN-SUFFIX,example.com,Backup\n";
        assert_eq!(
            extract_name_from_rules(yaml_hash),
            Some("Backup".to_owned())
        );

        // Quoted scalar followed by a comment still decodes to the scalar.
        let yaml_quoted_comment = "rules:\n  - \"DOMAIN-SUFFIX,example.com,Airport-A\" # note\n";
        assert_eq!(
            extract_name_from_rules(yaml_quoted_comment),
            Some("Airport-A".to_owned())
        );

        // Quotes around the third field are part of a plain scalar, so the
        // field is rejected and the next rule wins.
        let yaml_quoted_field =
            "rules:\n  - DOMAIN-SUFFIX,example.com,\"My Group\"\n  - DOMAIN-SUFFIX,example.com,Backup\n";
        assert_eq!(
            extract_name_from_rules(yaml_quoted_field),
            Some("Backup".to_owned())
        );

        // A folded plain scalar continuation belongs to the first rule.
        let yaml_folded = "rules:\n  - DOMAIN-SUFFIX,example.com,Airport\n    Extra\n";
        assert_eq!(
            extract_name_from_rules(yaml_folded),
            Some("Airport Extra".to_owned())
        );

        // A multiline quoted scalar belongs to the first rule.
        let yaml_multiline = "rules:\n  - \"DOMAIN-SUFFIX,example.com,Airport\n    Premium\"\n";
        assert_eq!(
            extract_name_from_rules(yaml_multiline),
            Some("Airport Premium".to_owned())
        );

        // An alias resolves to the anchored scalar, not the next rule.
        let yaml_alias = "anchors:\n  - &main DOMAIN-SUFFIX,example.com,Primary\nrules:\n  - *main\n  - DOMAIN-SUFFIX,example.com,Backup\n";
        assert_eq!(
            extract_name_from_rules(yaml_alias),
            Some("Primary".to_owned())
        );

        // Indentless items (as `serde_yaml::to_string` emits) use the fast path.
        let yaml_indentless = "rules:\n- DOMAIN-SUFFIX,example.com,Airport-1\n";
        assert_eq!(
            extract_name_from_rules(yaml_indentless),
            Some("Airport-1".to_owned())
        );

        // A nested sequence item is not a rule string.
        let yaml_nested = "rules:\n  -\n    - DOMAIN-SUFFIX,example.com,Nested\n";
        assert_eq!(extract_name_from_rules(yaml_nested), None);

        // `-foo` is a plain scalar, not a sequence item, so `rules` is not
        // a sequence at all.
        let yaml_dash = "rules:\n  -DOMAIN-SUFFIX,example.com,Primary\n";
        assert_eq!(extract_name_from_rules(yaml_dash), None);

        // A mapping item is skipped, not split on commas.
        let yaml_mapping = "rules:\n  - name: foo,bar,Baz\n  - DOMAIN-SUFFIX,example.com,Backup\n";
        assert_eq!(
            extract_name_from_rules(yaml_mapping),
            Some("Backup".to_owned())
        );

        // A double-quoted escape decodes via the full parser.
        let yaml_escape = "rules:\n  - \"DOMAIN-SUFFIX,example.com,A\\u0041irport\"\n";
        assert_eq!(
            extract_name_from_rules(yaml_escape),
            Some("AAirport".to_owned())
        );

        // A doubled single quote decodes to one apostrophe, which then fails
        // the safety check.
        let yaml_single_escape = "rules:\n  - 'DOMAIN-SUFFIX,example.com,It''s'\n";
        assert_eq!(extract_name_from_rules(yaml_single_escape), None);

        // Anchors and tags in front of a scalar decode to the scalar.
        let yaml_anchor_quoted =
            "rules:\n  - &a \"DOMAIN-SUFFIX,example.com,First\"\n  - DOMAIN-SUFFIX,example.com,Second\n";
        assert_eq!(
            extract_name_from_rules(yaml_anchor_quoted),
            Some("First".to_owned())
        );
        let yaml_anchor_plain =
            "rules:\n  - &a DOMAIN-SUFFIX,example.com,First\n  - DOMAIN-SUFFIX,example.com,Second\n";
        assert_eq!(
            extract_name_from_rules(yaml_anchor_plain),
            Some("First".to_owned())
        );
        let yaml_tagged =
            "rules:\n  - !!str \"DOMAIN-SUFFIX,example.com,First\"\n  - DOMAIN-SUFFIX,example.com,Second\n";
        assert_eq!(
            extract_name_from_rules(yaml_tagged),
            Some("First".to_owned())
        );

        // A nested sequence item is not a rule string.
        let yaml_nested_item = "rules:\n  - - a,b,Name\n  - DOMAIN-SUFFIX,example.com,Backup\n";
        assert_eq!(
            extract_name_from_rules(yaml_nested_item),
            Some("Backup".to_owned())
        );

        // An explicit-key item is a mapping, not a rule string.
        let yaml_explicit_key =
            "rules:\n  - ? DOMAIN-SUFFIX,example.com,First\n  - DOMAIN-SUFFIX,example.com,Second\n";
        assert_eq!(
            extract_name_from_rules(yaml_explicit_key),
            Some("Second".to_owned())
        );

        // A colon followed by a tab also separates a mapping key.
        let yaml_colon_tab =
            "rules:\n  - name:\tfoo,bar,Baz\n  - DOMAIN-SUFFIX,example.com,Backup\n";
        assert_eq!(
            extract_name_from_rules(yaml_colon_tab),
            Some("Backup".to_owned())
        );

        // A block scalar item still decodes via the full parser.
        let yaml_block_scalar =
            "rules:\n  - |\n    DOMAIN-SUFFIX,example.com,First\n  - DOMAIN-SUFFIX,example.com,Second\n";
        assert_eq!(
            extract_name_from_rules(yaml_block_scalar),
            Some("First".to_owned())
        );

        // `rules:#comment` is not a header at all: the whole line reads as
        // a plain scalar, so there is no rules sequence.
        let yaml_header_comment = "rules:#comment\n  - DOMAIN-SUFFIX,example.com,First\n";
        assert_eq!(extract_name_from_rules(yaml_header_comment), None);
    }

    #[test]
    fn test_extract_name_from_rules_fast_path_counts_and_breaks() {
        // Only the first ten rules are scanned: a valid eleventh rule loses.
        let mut yaml_eleven = String::from("rules:\n");
        for _ in 0..10 {
            yaml_eleven.push_str("  - DOMAIN-SUFFIX,example.com,DIRECT\n");
        }
        yaml_eleven.push_str("  - DOMAIN-SUFFIX,example.com,Eleventh\n");
        assert_eq!(extract_name_from_rules(&yaml_eleven), None);

        // ...while a valid tenth rule still wins.
        let mut yaml_ten = String::from("rules:\n");
        for _ in 0..9 {
            yaml_ten.push_str("  - DOMAIN-SUFFIX,example.com,DIRECT\n");
        }
        yaml_ten.push_str("  - DOMAIN-SUFFIX,example.com,Tenth\n");
        assert_eq!(extract_name_from_rules(&yaml_ten), Some("Tenth".to_owned()));

        // A lone carriage return is a YAML line break: the mixed-indentation
        // items it separates do not parse, so there is no name.
        let yaml_lone_cr =
            "rules:\n  - DOMAIN-SUFFIX,first.example,DIRECT\r- DOMAIN-SUFFIX,second.example,Airport\n";
        assert_eq!(extract_name_from_rules(yaml_lone_cr), None);

        // ...while `\r\n` pairs are ordinary line endings for the scanner.
        let yaml_crlf = "rules:\r\n  - DOMAIN-SUFFIX,example.com,Airport\r\n";
        assert_eq!(
            extract_name_from_rules(yaml_crlf),
            Some("Airport".to_owned())
        );
    }

    #[test]
    fn test_extract_name_from_rules_fast_path_documents() {
        // A second document means single-document parsing rejects the input.
        let yaml_multidoc = "rules:\n  - DOMAIN-SUFFIX,example.com,First\n---\nother: value\n";
        assert_eq!(extract_name_from_rules(yaml_multidoc), None);

        // A lone document end marker is fine.
        let yaml_docend = "rules:\n  - DOMAIN-SUFFIX,example.com,First\n...\n";
        assert_eq!(
            extract_name_from_rules(yaml_docend),
            Some("First".to_owned())
        );

        // ...but content after the end marker is a second document.
        let yaml_docend_more = "rules:\n  - DOMAIN-SUFFIX,example.com,First\n...\nmore: x\n";
        assert_eq!(extract_name_from_rules(yaml_docend_more), None);

        // A leading document start marker is fine.
        let yaml_docstart = "---\nrules:\n  - DOMAIN-SUFFIX,example.com,First\n";
        assert_eq!(
            extract_name_from_rules(yaml_docstart),
            Some("First".to_owned())
        );

        // A stray scalar line after the section is not a section end.
        let yaml_garbage = "rules:\n  - DOMAIN-SUFFIX,example.com,First\ngarbage\n";
        assert_eq!(extract_name_from_rules(yaml_garbage), None);

        // A flow sequence (or a node-list line) before the header means
        // the document root is not a mapping, so there is no rules key.
        let yaml_flow_root = "[unrelated]\nrules:\n  - DOMAIN-SUFFIX,example.com,Airport\n";
        assert_eq!(extract_name_from_rules(yaml_flow_root), None);
        let yaml_node_root = "http://node.example\nrules:\n  - DOMAIN-SUFFIX,example.com,Airport\n";
        assert_eq!(extract_name_from_rules(yaml_node_root), None);

        // A serialized document (indentless sequences, nested mapping
        // content between items) still scans.
        let yaml_serialized = "proxies:\n- name: x\n  type: vmess\n- name: y\nrules:\n- DOMAIN-SUFFIX,example.com,Airport\n";
        assert_eq!(
            extract_name_from_rules(yaml_serialized),
            Some("Airport".to_owned())
        );

        // Mixed sequence indentation before the header does not parse.
        let yaml_mixed_pre =
            "proxies:\n  - name: x\n- not-a-rule\nrules:\n  - DOMAIN-SUFFIX,example.com,Group\n";
        assert_eq!(extract_name_from_rules(yaml_mixed_pre), None);

        // An indented marker-like line folds into the rule scalar instead
        // of ending the document, so the folded name is rejected.
        let yaml_indented_dots = "rules:\n  - DOMAIN-SUFFIX,example.com,Airport\n    ...\n";
        assert_eq!(extract_name_from_rules(yaml_indented_dots), None);
        let yaml_indented_dashes = "rules:\n  - DOMAIN-SUFFIX,example.com,Airport\n  ---\n";
        assert_eq!(extract_name_from_rules(yaml_indented_dashes), None);

        // A duplicate top-level `rules:` key is rejected by the full
        // parser, so the first section's name must not win.
        let yaml_dup_empty = "rules:\n  - DOMAIN-SUFFIX,example.com,Airport\nrules: []\n";
        assert_eq!(extract_name_from_rules(yaml_dup_empty), None);
        let yaml_dup_other =
            "rules:\n  - DOMAIN-SUFFIX,example.com,Airport\nrules:\n  - DOMAIN-SUFFIX,other.com,Second\n";
        assert_eq!(extract_name_from_rules(yaml_dup_other), None);
        let yaml_dup_flow = "rules: [a]\nrules:\n  - DOMAIN-SUFFIX,example.com,Airport\n";
        assert_eq!(extract_name_from_rules(yaml_dup_flow), None);

        // A `rules`-prefixed line that is not a header: a stray scalar
        // line before the header is implausible, while a differently
        // named key (e.g. `rulesx`) is just another top-level key.
        let yaml_rules_scalar = "rulesfoo\nrules:\n  - DOMAIN-SUFFIX,example.com,Airport\n";
        assert_eq!(extract_name_from_rules(yaml_rules_scalar), None);
        let yaml_rules_other_key = "rulesx: y\nrules:\n  - DOMAIN-SUFFIX,example.com,Airport\n";
        assert_eq!(
            extract_name_from_rules(yaml_rules_other_key),
            Some("Airport".to_owned())
        );

        // A Unicode line break ends the first rule's scalar, so the first
        // rule wins over the second one.
        let yaml_unicode_break =
            "rules:\n  - DOMAIN-SUFFIX,example.com,Air\u{2028}\n  - DOMAIN-SUFFIX,example.com,Backup\n";
        assert_eq!(
            extract_name_from_rules(yaml_unicode_break),
            Some("Air".to_owned())
        );

        // ...while a Unicode break inside a field that stays on one
        // physical line does not parse at all.
        let yaml_unicode_mid = "rules:\n  - DOMAIN-SUFFIX,example.com,Air\u{2028}port\n";
        assert_eq!(extract_name_from_rules(yaml_unicode_mid), None);
    }

    #[test]
    fn test_validate_subscription_name() {
        assert!(validate_subscription_name("my-config").is_ok());
        assert!(validate_subscription_name("").is_err());
        assert!(validate_subscription_name("../etc/passwd").is_err());
    }

    #[test]
    fn test_validate_private_ip_allowed() {
        let result = validate_subscription_url_with_ip("http://192.168.1.2/sub");
        assert!(result.is_ok());
        let (_, resolved_addr, user_entered_private) = result.unwrap();
        assert!(resolved_addr.is_none());
        assert!(user_entered_private);

        // The private-suffix fake-IP filtering and pinning decision is covered
        // by `test_first_non_fake_addr` (injected address lists, no live DNS).

        let result_local = validate_subscription_url_basic("http://nas.local:8080/sub");
        assert!(result_local.is_ok());
        let (host, port, user_entered_private) = result_local.unwrap();
        assert_eq!(host, "nas.local");
        assert_eq!(port, 8080);
        assert!(user_entered_private);

        let result_internal = validate_subscription_url_basic("http://service.internal:8080/sub");
        assert!(result_internal.is_ok());
        let (_, _, user_entered_private) = result_internal.unwrap();
        assert!(user_entered_private);

        let (_, _, user_entered_private) =
            validate_subscription_url_basic("http://nas:8080/sub").unwrap();
        assert!(user_entered_private);
    }

    #[test]
    fn test_validate_invalid_schemes_rejected() {
        assert!(validate_subscription_url_with_ip("ftp://192.168.1.1/sub").is_err());
        assert!(validate_subscription_url_with_ip("file:///etc/passwd").is_err());
        assert!(validate_subscription_url_basic("ftp://192.168.1.1/sub").is_err());
        assert!(validate_subscription_url_basic("file:///etc/passwd").is_err());
        assert!(validate_subscription_url_basic("http:///sub").is_err());
        assert!(validate_subscription_url_basic("HTTP:///sub").is_err());
        assert!(validate_subscription_url_basic("Https:///sub").is_err());
        assert!(validate_subscription_url_basic("http:/sub").is_err());
        assert!(validate_subscription_url_basic("http:sub").is_err());
        assert!(validate_subscription_url_basic("HTTP://nas/sub").is_ok());
        assert!(validate_subscription_url_basic("http://\t/sub").is_err());
        assert!(validate_subscription_url_basic("http://\n/sub").is_err());
        assert!(validate_subscription_url_basic("http://example.com/a\rb").is_err());
        assert!(validate_subscription_url_with_ip("http:///sub").is_err());
    }

    #[test]
    fn test_validate_subscription_url_basic_success() {
        let (host, port, private) =
            validate_subscription_url_basic("https://blocked-domain.example.com/sub?token=123")
                .unwrap();
        assert_eq!(host, "blocked-domain.example.com");
        assert_eq!(port, 443);
        assert!(!private);

        let (host, port, private) =
            validate_subscription_url_basic("http://192.168.1.100:8080/sub").unwrap();
        assert_eq!(host, "192.168.1.100");
        assert_eq!(port, 8080);
        assert!(private);

        let (host, port, private) =
            validate_subscription_url_basic("http://localhost:9090/sub").unwrap();
        assert_eq!(host, "localhost");
        assert_eq!(port, 9090);
        assert!(private);

        let (host, port, private) =
            validate_subscription_url_basic("http://[::1]:8080/sub").unwrap();
        assert_eq!(host, "[::1]");
        assert_eq!(port, 8080);
        assert!(private);
    }

    #[test]
    fn test_public_host_with_public_ip_allowed() {
        let addrs: Vec<std::net::SocketAddr> = vec!["1.2.3.4:80".parse().unwrap()];
        let result = validate_public_host_addrs("example.com", &addrs);
        assert!(result.is_ok());
    }

    #[test]
    fn test_public_host_resolving_to_private_ip_rejected() {
        let sinkhole_ips = [
            "192.168.1.1:80",
            "10.0.0.1:80",
            "172.16.0.1:80",
            "127.0.0.1:80",
            "0.0.0.0:80",
            "169.254.169.254:80",
            "[::1]:80",
            "[fc00::1]:80",
            "[fe80::1]:80",
        ];
        for ip in sinkhole_ips {
            let addrs: Vec<std::net::SocketAddr> = vec![ip.parse().unwrap()];
            let result = validate_public_host_addrs("attacker.com", &addrs);
            assert!(
                result.is_err(),
                "Expected sinkhole IP {ip} to be rejected as SSRF"
            );
            assert!(
                matches!(result.unwrap_err(), PublicHostAddrError::SsrfBlocked(_)),
                "Expected SsrfBlocked for sinkhole IP {ip}"
            );
        }
    }

    #[test]
    fn test_first_non_fake_addr() {
        use super::{first_non_fake_addr, FakeIpRanges};

        // Only fake addresses: rejected.
        let only_fake: Vec<std::net::SocketAddr> = vec!["198.18.0.5:80".parse().unwrap()];
        assert_eq!(
            first_non_fake_addr(&only_fake, &FakeIpRanges::default()),
            None
        );

        // Mixed fake and real: the real address wins.
        let mixed: Vec<std::net::SocketAddr> = vec![
            "198.18.0.5:80".parse().unwrap(),
            "192.168.1.10:80".parse().unwrap(),
        ];
        assert_eq!(
            first_non_fake_addr(&mixed, &FakeIpRanges::default()),
            Some("192.168.1.10:80".parse().unwrap())
        );

        // Empty list: rejected.
        let empty: Vec<std::net::SocketAddr> = Vec::new();
        assert_eq!(first_non_fake_addr(&empty, &FakeIpRanges::default()), None);

        // Custom configured ranges are honored.
        let ranges = FakeIpRanges::from_config_yaml("dns:\n  fake-ip-range: 198.20.0.0/16\n");
        let custom: Vec<std::net::SocketAddr> = vec!["198.20.0.5:80".parse().unwrap()];
        assert_eq!(first_non_fake_addr(&custom, &ranges), None);
        let default_view: Vec<std::net::SocketAddr> = vec!["198.18.0.5:80".parse().unwrap()];
        assert_eq!(
            first_non_fake_addr(&default_view, &ranges),
            Some("198.18.0.5:80".parse().unwrap())
        );
    }

    #[test]
    fn test_validate_subscription_url_with_ranges_uses_active_ranges() {
        use super::validate_subscription_url_with_ip_with_ranges;

        // A literal private IP is accepted without any DNS work and never
        // consults the ranges.
        let literal = match validate_subscription_url_with_ip_with_ranges(
            "http://192.168.1.2/sub",
            &FakeIpRanges::default(),
        ) {
            Ok(v) => v,
            Err(e) => panic!("literal private IP should be accepted: {e}"),
        };
        assert_eq!(literal.0, "192.168.1.2");
        assert!(literal.1.is_none());
        assert!(literal.2);

        // A literal inside a fake-IP range is synthetic, not a private host:
        // rejected for the built-in range and for a custom one.
        assert!(validate_subscription_url_with_ip_with_ranges(
            "http://198.18.0.5/sub",
            &FakeIpRanges::default()
        )
        .is_err());
        let custom_range = FakeIpRanges::from_config_yaml("dns:\n  fake-ip-range: 10.200.0.0/16\n");
        assert!(validate_subscription_url_with_ip_with_ranges(
            "http://10.200.0.5/sub",
            &custom_range
        )
        .is_err());
        assert!(FakeIpRanges::default().contains_host_literal("[fdfe:dcba:9876::1]"));
        assert!(!FakeIpRanges::default().contains_host_literal("[fd00::1]"));
        assert!(!FakeIpRanges::default().contains_host_literal("example.com"));

        // The default ranges recognize the built-in synthetic range; a profile
        // with a custom range must not treat those addresses as real. This is
        // the difference between the two entry points.
        let custom = FakeIpRanges::from_config_yaml("dns:\n  fake-ip-range: 198.20.0.0/16\n");
        let default_only = FakeIpRanges::default();

        let public_default = validate_subscription_url_with_ip_with_ranges(
            "http://public.invalid/sub",
            &default_only,
        );
        // Either DNS fails (no resolver in CI) or the host resolves; both are
        // acceptable. What must never happen is a synthetic address being
        // accepted as public.
        if let Ok((_, Some(addr), false)) = &public_default {
            assert!(
                !default_only.contains(addr.ip()),
                "synthetic address accepted as public: {addr}"
            );
        }

        let public_custom =
            validate_subscription_url_with_ip_with_ranges("http://public.invalid/sub", &custom);
        if let Ok((_, Some(addr), false)) = &public_custom {
            assert!(
                !custom.contains(addr.ip()),
                "synthetic address accepted as public: {addr}"
            );
        }
    }

    #[test]
    fn test_public_host_resolving_to_fake_ip_not_pinned_nor_ssrf() {
        let addrs: Vec<std::net::SocketAddr> = vec!["198.18.0.1:80".parse().unwrap()];
        let result = validate_public_host_addrs("blocked.com", &addrs);
        assert!(result.is_err());
        assert!(matches!(
            result.unwrap_err(),
            PublicHostAddrError::NoAddresses(_)
        ));

        // If mixed with a real public IP, pins the real public IP
        let mixed_addrs: Vec<std::net::SocketAddr> = vec![
            "198.18.0.1:80".parse().unwrap(),
            "93.184.216.34:80".parse().unwrap(),
        ];
        let mixed_result = validate_public_host_addrs("example.com", &mixed_addrs);
        assert!(mixed_result.is_ok());
        let (_, pinned, _) = mixed_result.unwrap();
        assert_eq!(pinned, Some("93.184.216.34:80".parse().unwrap()));

        // IPv6 fake-IP range fdfe:dcba:9876::/64
        let ipv6_fake_addr: std::net::IpAddr = "fdfe:dcba:9876::1".parse().unwrap();
        assert!(is_mihomo_fake_ip(ipv6_fake_addr));
        let v6_fake_addrs: Vec<std::net::SocketAddr> =
            vec!["[fdfe:dcba:9876::1]:80".parse().unwrap()];
        let v6_result = validate_public_host_addrs("ipv6-fake.com", &v6_fake_addrs);
        assert!(v6_result.is_err());
        assert!(matches!(
            v6_result.unwrap_err(),
            PublicHostAddrError::NoAddresses(_)
        ));
    }

    #[test]
    fn test_fake_ip_ranges_from_config_yaml() {
        // Custom ranges replace the built-in defaults.
        let ranges = FakeIpRanges::from_config_yaml(
            "dns:\n  enable: true\n  fake-ip-range: 198.20.0.0/16\n  fake-ip-range6: 2001:db8::/32\n",
        );
        assert!(ranges.contains("198.20.1.2".parse().unwrap()));
        assert!(ranges.contains("2001:db8::1".parse().unwrap()));
        assert!(!ranges.contains("198.18.0.1".parse().unwrap()));
        assert!(!ranges.contains("93.184.216.34".parse().unwrap()));

        // Missing / empty / invalid values fall back to the built-in defaults.
        for config in [
            "port: 7890",
            "dns:\n  enable: true",
            "dns:\n  fake-ip-range: ''",
            "dns:\n  fake-ip-range: not-a-cidr",
            "not: valid: yaml: [",
        ] {
            let fallback = FakeIpRanges::from_config_yaml(config);
            assert!(fallback.contains("198.18.0.1".parse().unwrap()));
            assert!(fallback.contains("198.19.255.254".parse().unwrap()));
            assert!(fallback.contains("fdfe:dcba:9876::1".parse().unwrap()));
            assert!(!fallback.contains("8.8.8.8".parse().unwrap()));
        }

        // IPv4-mapped IPv6 addresses follow the mapped v4 range.
        assert!(FakeIpRanges::default().contains("::ffff:198.18.0.1".parse().unwrap()));
        assert!(!FakeIpRanges::default().contains("::ffff:8.8.8.8".parse().unwrap()));
    }

    #[test]
    fn test_validate_public_host_addrs_with_custom_fake_ip_ranges() {
        let ranges = FakeIpRanges::from_config_yaml("dns:\n  fake-ip-range: 198.20.0.0/16\n");

        // A synthetic address from the custom range is not pinned, and a mixed
        // answer still pins the real public address.
        let only_fake: Vec<std::net::SocketAddr> = vec!["198.20.0.5:443".parse().unwrap()];
        let result = validate_public_host_addrs_with_ranges("x.com", &only_fake, &ranges);
        assert!(matches!(
            result.unwrap_err(),
            PublicHostAddrError::NoAddresses(_)
        ));

        let mixed: Vec<std::net::SocketAddr> = vec![
            "198.20.0.5:443".parse().unwrap(),
            "93.184.216.34:443".parse().unwrap(),
        ];
        let (_, pinned, _) =
            validate_public_host_addrs_with_ranges("x.com", &mixed, &ranges).unwrap();
        assert_eq!(pinned, Some("93.184.216.34:443".parse().unwrap()));

        // A default-range synthetic address is no longer treated as a plain
        // public destination once the active ranges are custom: 198.18.0.0/15
        // is the RFC 2544 benchmarking range, which is reserved and never
        // routable, so pinning it would produce a connection that cannot
        // succeed. It is blocked instead of dialed.
        let default_fake: Vec<std::net::SocketAddr> = vec!["198.18.0.5:443".parse().unwrap()];
        assert!(matches!(
            validate_public_host_addrs_with_ranges("x.com", &default_fake, &ranges),
            Err(PublicHostAddrError::SsrfBlocked(_))
        ));
        // The boundaries of the benchmarking range are covered too.
        for ip in ["198.18.0.0", "198.19.255.255"] {
            let addrs: Vec<std::net::SocketAddr> = vec![format!("{ip}:443").parse().unwrap()];
            assert!(
                matches!(
                    validate_public_host_addrs_with_ranges("x.com", &addrs, &ranges),
                    Err(PublicHostAddrError::SsrfBlocked(_))
                ),
                "{ip} should be blocked"
            );
        }
        // Just below the benchmarking range is ordinary public space and stays usable.
        let outside: Vec<std::net::SocketAddr> = vec!["198.17.255.255:443".parse().unwrap()];
        let (_, pinned, _) =
            validate_public_host_addrs_with_ranges("x.com", &outside, &ranges).unwrap();
        assert_eq!(pinned, Some("198.17.255.255:443".parse().unwrap()));
    }

    #[test]
    fn test_disposition_profile_stem_keeps_last_path_component() {
        // Providers may send "<site>/<account>" as the suggested name.
        assert_eq!(
            disposition_profile_stem("provider.example.com/test-user@example.invalid"),
            Some("test-user@example.invalid".to_owned())
        );
        assert_eq!(
            disposition_profile_stem(r"folder\sample-profile.yaml"),
            Some("sample-profile".to_owned())
        );
        // A trailing separator falls back to the last non-empty component.
        assert_eq!(
            disposition_profile_stem("provider.example.com/"),
            Some("provider.example.com".to_owned())
        );
    }

    #[test]
    fn test_disposition_profile_stem_splits_on_encoded_separators() {
        assert_eq!(
            disposition_profile_stem("a%2Fsample.yaml"),
            Some("sample".to_owned())
        );
        assert_eq!(
            disposition_profile_stem("a%5Csample.yml"),
            Some("sample".to_owned())
        );
        // Double encoding is decoded completely before splitting.
        assert_eq!(
            disposition_profile_stem("a%252Fsample"),
            Some("sample".to_owned())
        );
    }

    #[test]
    fn test_disposition_profile_stem_never_yields_traversal() {
        assert_eq!(
            disposition_profile_stem("../../etc/passwd"),
            Some("passwd".to_owned())
        );
        assert_eq!(disposition_profile_stem(".."), None);
        assert_eq!(disposition_profile_stem("sample/.."), None);
        assert_eq!(disposition_profile_stem("."), None);
        for input in ["../x", r"..\x", "a/../../x.yaml", "%2e%2e%2fx"] {
            let stem = disposition_profile_stem(input).unwrap();
            assert!(
                !stem.contains('/') && !stem.contains('\\'),
                "{input} -> {stem}"
            );
            assert_ne!(stem, "..");
        }
    }

    #[test]
    fn test_disposition_profile_stem_extension_and_trimming() {
        assert_eq!(
            disposition_profile_stem("Sample.YAML"),
            Some("Sample".to_owned())
        );
        assert_eq!(
            disposition_profile_stem("sample.Yml"),
            Some("sample".to_owned())
        );
        assert_eq!(
            disposition_profile_stem("sample.txt"),
            Some("sample.txt".to_owned())
        );
        // A config served as JSON is saved as YAML: `.json` goes too.
        assert_eq!(
            disposition_profile_stem("BPB-normal-clash.json"),
            Some("BPB-normal-clash".to_owned())
        );
        assert_eq!(
            disposition_profile_stem("sample.JSON. "),
            Some("sample".to_owned())
        );
        // Trailing dots/spaces Windows would drop are removed.
        assert_eq!(
            disposition_profile_stem("sample. .yaml"),
            Some("sample".to_owned())
        );
        assert_eq!(
            disposition_profile_stem("  sample  "),
            Some("sample".to_owned())
        );
        // A trailing dot or space after the extension must not hide it.
        assert_eq!(
            disposition_profile_stem("sample.yaml."),
            Some("sample".to_owned())
        );
        assert_eq!(
            disposition_profile_stem("sample.yml. "),
            Some("sample".to_owned())
        );
        assert_eq!(
            disposition_profile_stem("folder/sample.YAML . "),
            Some("sample".to_owned())
        );
        assert_eq!(disposition_profile_stem("..."), None);
        assert_eq!(disposition_profile_stem(""), None);
        assert_eq!(disposition_profile_stem(".yaml"), None);
        assert_eq!(disposition_profile_stem("/"), None);
    }

    #[test]
    fn test_disposition_profile_stem_non_ascii_and_length() {
        // Case folding of non-ASCII letters must not shift the slice.
        assert_eq!(disposition_profile_stem("İİ.yaml"), Some("İİ".to_owned()));
        assert_eq!(
            disposition_profile_stem("示例配置.YAML"),
            Some("示例配置".to_owned())
        );
        assert_eq!(
            disposition_profile_stem(&"x".repeat(64)),
            Some("x".repeat(64))
        );
        assert_eq!(disposition_profile_stem(&"x".repeat(65)), None);
        // 22 three-byte characters = 66 bytes.
        assert_eq!(disposition_profile_stem(&"示".repeat(22)), None);
    }

    #[test]
    fn test_parse_content_disposition_filename() {
        assert_eq!(
            parse_content_disposition_filename(r#"attachment; filename="config.yaml""#),
            Some("config.yaml".to_owned())
        );
        assert_eq!(
            parse_content_disposition_filename("attachment; filename*=UTF-8''%E9%85%8D%E7%BD%AE"),
            Some("配置".to_owned())
        );
        assert_eq!(parse_content_disposition_filename("no filename here"), None);
    }

    // -- Snapshot tests for subscription content processing ----------------

    #[test]
    fn snapshot_quote_short_id_simple() {
        insta::assert_snapshot!(quote_short_id_values("short-id: abc123"));
    }

    #[test]
    fn snapshot_quote_short_id_hex_like() {
        insta::assert_snapshot!(quote_short_id_values("short-id: 34010e92"));
    }

    #[test]
    fn snapshot_quote_short_id_multiple() {
        insta::assert_snapshot!(quote_short_id_values(
            "proxies:\n  - name: test-1\n    short-id: abc123\n  - name: test-2\n    short-id: def456"
        ));
    }

    #[test]
    fn snapshot_percent_decode_ascii() {
        insta::assert_snapshot!(percent_decode("hello%20world"));
    }

    #[test]
    fn snapshot_percent_decode_utf8() {
        insta::assert_snapshot!(percent_decode("%E4%B8%AD%E6%96%87"));
    }

    #[test]
    fn snapshot_percent_decode_no_encoding() {
        insta::assert_snapshot!(percent_decode("plain text"));
    }

    #[test]
    fn snapshot_redact_url_in_string_single() {
        insta::assert_snapshot!(redact_url_in_string(
            "Fetching config from https://example.com/sub?token=secret123".to_owned()
        ));
    }

    #[test]
    fn snapshot_redact_url_in_string_multiple() {
        insta::assert_snapshot!(redact_url_in_string(
            "First http://a.com/config then https://b.com/sub2 done".to_owned()
        ));
    }

    #[test]
    fn snapshot_redact_url_in_string_no_url() {
        insta::assert_snapshot!(redact_url_in_string("Just a plain message".to_owned()));
    }

    #[test]
    fn test_select_global_candidate_special_targets_only() {
        let json = serde_json::json!({
            "GLOBAL": {
                "all": ["DIRECT", "REJECT", "REJECT-DROP", "PASS-RULE"],
                "now": "PASS-RULE"
            }
        });
        let proxies = json.as_object().unwrap();
        assert_eq!(select_global_candidate(proxies), None);
    }

    #[test]
    fn test_select_global_candidate_cycle_resolution() {
        let json = serde_json::json!({
            "GLOBAL": {
                "all": ["GroupA"],
                "now": "GroupA"
            },
            "GroupA": {
                "type": "Selector",
                "now": "GroupB"
            },
            "GroupB": {
                "type": "Selector",
                "now": "GroupA"
            }
        });
        let proxies = json.as_object().unwrap();
        assert_eq!(select_global_candidate(proxies), None);
    }

    #[test]
    fn test_select_global_candidate_nested_selector() {
        let json = serde_json::json!({
            "GLOBAL": {
                "all": ["ProxyGroup"],
                "now": "ProxyGroup"
            },
            "ProxyGroup": {
                "type": "Selector",
                "now": "HK-01"
            },
            "HK-01": {
                "type": "Shadowsocks"
            }
        });
        let proxies = json.as_object().unwrap();
        assert_eq!(
            select_global_candidate(proxies),
            Some(("ProxyGroup".to_owned(), Some("ProxyGroup".to_owned())))
        );
    }

    #[test]
    fn test_select_global_candidate_prefers_active_now_if_in_all() {
        let json = serde_json::json!({
            "GLOBAL": {
                "all": ["HK-01", "US-01"],
                "now": "DIRECT"
            },
            "AutoGroup": {
                "type": "Selector",
                "now": "US-01"
            },
            "HK-01": {
                "type": "Vmess"
            },
            "US-01": {
                "type": "Vmess"
            }
        });
        let proxies = json.as_object().unwrap();
        assert_eq!(
            select_global_candidate(proxies),
            Some(("US-01".to_owned(), Some("DIRECT".to_owned())))
        );
    }

    #[test]
    fn test_select_global_candidate_fallback_to_global_all_member() {
        let json = serde_json::json!({
            "GLOBAL": {
                "all": ["DIRECT", "JP-01"],
                "now": "DIRECT"
            },
            "JP-01": {
                "type": "Trojan"
            }
        });
        let proxies = json.as_object().unwrap();
        assert_eq!(
            select_global_candidate(proxies),
            Some(("JP-01".to_owned(), Some("DIRECT".to_owned())))
        );
    }

    #[test]
    fn test_select_global_candidate_empty_global_all() {
        let json = serde_json::json!({
            "GLOBAL": {
                "all": [],
                "now": "DIRECT"
            },
            "CustomSelector": {
                "type": "Selector",
                "now": "Node-A"
            },
            "Node-A": {
                "type": "Shadowsocks"
            }
        });
        let proxies = json.as_object().unwrap();
        assert_eq!(select_global_candidate(proxies), None);
    }

    #[test]
    fn test_select_global_candidate_unknown_leaf_rejected() {
        let json = serde_json::json!({
            "GLOBAL": {
                "all": ["GhostNode"],
                "now": "GhostNode"
            }
        });
        let proxies = json.as_object().unwrap();
        assert_eq!(select_global_candidate(proxies), None);
    }

    #[test]
    fn test_select_global_candidate_rejects_custom_named_non_proxy_types() {
        let json = serde_json::json!({
            "GLOBAL": {
                "all": ["MyDirect", "MyReject", "MyCompatible", "ValidNode"],
                "now": "MyDirect"
            },
            "MyDirect": {
                "type": "Direct"
            },
            "MyReject": {
                "type": "Reject"
            },
            "MyCompatible": {
                "type": "Compatible"
            },
            "ValidNode": {
                "type": "Shadowsocks"
            }
        });
        let proxies = json.as_object().unwrap();
        assert_eq!(
            select_global_candidate(proxies),
            Some(("ValidNode".to_owned(), Some("MyDirect".to_owned())))
        );
    }

    #[test]
    fn test_select_global_candidate_load_balance_and_relay() {
        let json = serde_json::json!({
            "GLOBAL": {
                "all": ["LB-Group", "Relay-Group"],
                "now": "LB-Group"
            },
            "LB-Group": {
                "type": "LoadBalance",
                "now": "DIRECT"
            },
            "Relay-Group": {
                "type": "Relay",
                "now": "Leaf-01"
            },
            "Leaf-01": {
                "type": "Vmess"
            }
        });
        let proxies = json.as_object().unwrap();
        assert_eq!(
            select_global_candidate(proxies),
            Some(("Relay-Group".to_owned(), Some("LB-Group".to_owned())))
        );
    }

    #[test]
    fn test_select_global_candidate_relay_with_all_without_now() {
        // A Relay whose chain is reported under `all` (no `now`) is usable when
        // every chain member resolves to a live proxy.
        let json = serde_json::json!({
            "GLOBAL": {
                "all": ["Relay-Group"]
            },
            "Relay-Group": {
                "type": "Relay",
                "all": ["Leaf-01"]
            },
            "Leaf-01": {
                "type": "Vmess"
            }
        });
        let proxies = json.as_object().unwrap();
        assert_eq!(
            select_global_candidate(proxies),
            Some(("Relay-Group".to_owned(), None))
        );

        // A dead chain member makes the Relay unusable, so no candidate.
        let dead_json = serde_json::json!({
            "GLOBAL": {
                "all": ["Relay-Group"]
            },
            "Relay-Group": {
                "type": "Relay",
                "all": ["DeadLeaf"]
            },
            "DeadLeaf": {
                "type": "Vmess",
                "alive": false
            }
        });
        let dead_proxies = dead_json.as_object().unwrap();
        assert_eq!(select_global_candidate(dead_proxies), None);
    }

    #[test]
    fn test_select_global_candidate_load_balance_with_a_dead_member() {
        // No `DIRECT` here — both members are real proxy types, one of them just
        // down. The group is still rejected, and deliberately so: LoadBalance
        // picks one member at runtime, so a healthy peer says nothing about the
        // dead one, and a group that may route onto it is not certifiable as
        // "always forwards through a working proxy". The all-members rule that
        // applies to Relay therefore applies here too.
        let json = serde_json::json!({
            "GLOBAL": {
                "all": ["LB-Group"]
            },
            "LB-Group": {
                "type": "LoadBalance",
                "all": ["DeadLeaf", "LiveLeaf"]
            },
            "DeadLeaf": { "type": "Vmess", "alive": false },
            "LiveLeaf": { "type": "Vmess", "alive": true }
        });
        let proxies = json.as_object().unwrap();
        assert_eq!(select_global_candidate(proxies), None);

        // Both members healthy: usable. This is the boundary the dead member
        // above is measured against, so it is worth pinning as well.
        let live_json = serde_json::json!({
            "GLOBAL": {
                "all": ["LB-Group"]
            },
            "LB-Group": {
                "type": "LoadBalance",
                "all": ["LiveA", "LiveB"]
            },
            "LiveA": { "type": "Vmess", "alive": true },
            "LiveB": { "type": "Vmess", "alive": true }
        });
        let live_proxies = live_json.as_object().unwrap();
        assert_eq!(
            select_global_candidate(live_proxies),
            Some(("LB-Group".to_owned(), None))
        );
    }

    #[test]
    fn test_select_global_candidate_load_balance_now_still_checks_all_members() {
        // `now` points at a live proxy, so a check that only followed `now`
        // would accept the group. The other member is `DIRECT`, which is a path
        // out of the group that bypasses the proxy entirely — the group must
        // still be rejected. This is the `now`-present counterpart of
        // `test_select_global_candidate_load_balance_with_a_dead_member`: same
        // rule, reached through a different branch.
        let json = serde_json::json!({
            "GLOBAL": {
                "all": ["LB-Group"]
            },
            "LB-Group": {
                "type": "LoadBalance",
                "now": "LiveLeaf",
                "all": ["LiveLeaf", "DIRECT"]
            },
            "LiveLeaf": { "type": "Vmess", "alive": true }
        });
        let proxies = json.as_object().unwrap();
        assert_eq!(select_global_candidate(proxies), None);

        // Both members real proxies: usable.
        let live_json = serde_json::json!({
            "GLOBAL": {
                "all": ["LB-Group"]
            },
            "LB-Group": {
                "type": "LoadBalance",
                "now": "LiveA",
                "all": ["LiveA", "LiveB"]
            },
            "LiveA": { "type": "Vmess", "alive": true },
            "LiveB": { "type": "Vmess", "alive": true }
        });
        let live_proxies = live_json.as_object().unwrap();
        assert_eq!(
            select_global_candidate(live_proxies),
            Some(("LB-Group".to_owned(), None))
        );
    }

    #[test]
    fn test_select_global_candidate_relay_full_chain_must_resolve() {
        // `now` points at a live hop, but another chain member is dead: the
        // Relay is unusable and must not become a candidate.
        let json = serde_json::json!({
            "GLOBAL": {
                "all": ["Relay-Group"]
            },
            "Relay-Group": {
                "type": "Relay",
                "now": "Leaf-01",
                "all": ["Leaf-01", "Leaf-02"]
            },
            "Leaf-01": { "type": "Vmess" },
            "Leaf-02": { "type": "Vmess", "alive": false }
        });
        let proxies = json.as_object().unwrap();
        assert_eq!(select_global_candidate(proxies), None);

        // Both hops live: usable.
        let live_json = serde_json::json!({
            "GLOBAL": {
                "all": ["Relay-Group"]
            },
            "Relay-Group": {
                "type": "Relay",
                "now": "Leaf-01",
                "all": ["Leaf-01", "Leaf-02"]
            },
            "Leaf-01": { "type": "Vmess" },
            "Leaf-02": { "type": "Vmess" }
        });
        let live_proxies = live_json.as_object().unwrap();
        assert_eq!(
            select_global_candidate(live_proxies),
            Some(("Relay-Group".to_owned(), None))
        );
    }

    #[test]
    fn test_select_global_candidate_load_balance_without_now() {
        let mixed_json = serde_json::json!({
            "GLOBAL": {
                "all": ["LB-Group"],
                "now": "LB-Group"
            },
            "LB-Group": {
                "type": "LoadBalance",
                "all": ["DIRECT", "DeadNode", "LiveLeaf"]
            },
            "DeadNode": {
                "type": "Shadowsocks",
                "alive": false
            },
            "LiveLeaf": {
                "type": "Shadowsocks",
                "alive": true
            }
        });
        let mixed_proxies = mixed_json.as_object().unwrap();
        assert_eq!(select_global_candidate(mixed_proxies), None);

        let valid_json = serde_json::json!({
            "GLOBAL": {
                "all": ["LB-Group"],
                "now": "LB-Group"
            },
            "LB-Group": {
                "type": "LoadBalance",
                "all": ["LiveLeaf1", "LiveLeaf2"]
            },
            "LiveLeaf1": {
                "type": "Shadowsocks",
                "alive": true
            },
            "LiveLeaf2": {
                "type": "Shadowsocks",
                "alive": true
            }
        });
        let valid_proxies = valid_json.as_object().unwrap();
        assert_eq!(
            select_global_candidate(valid_proxies),
            Some(("LB-Group".to_owned(), Some("LB-Group".to_owned())))
        );

        // LoadBalance containing a nested Selector that selects DIRECT must be rejected
        let nested_direct_json = serde_json::json!({
            "GLOBAL": {
                "all": ["LB-Group"],
                "now": "LB-Group"
            },
            "LB-Group": {
                "type": "LoadBalance",
                "all": ["NestedSelector", "LiveLeaf"]
            },
            "NestedSelector": {
                "type": "Selector",
                "now": "DIRECT",
                "all": ["DIRECT", "LiveLeaf"]
            },
            "LiveLeaf": {
                "type": "Shadowsocks",
                "alive": true
            }
        });
        let nested_direct_proxies = nested_direct_json.as_object().unwrap();
        assert_eq!(select_global_candidate(nested_direct_proxies), None);

        // LoadBalance containing a nested Selector that selects a live proxy node must succeed
        let nested_valid_json = serde_json::json!({
            "GLOBAL": {
                "all": ["LB-Group"],
                "now": "LB-Group"
            },
            "LB-Group": {
                "type": "LoadBalance",
                "all": ["NestedSelector", "LiveLeaf"]
            },
            "NestedSelector": {
                "type": "Selector",
                "now": "LiveLeaf2",
                "all": ["DIRECT", "LiveLeaf2"]
            },
            "LiveLeaf": {
                "type": "Shadowsocks",
                "alive": true
            },
            "LiveLeaf2": {
                "type": "Shadowsocks",
                "alive": true
            }
        });
        let nested_valid_proxies = nested_valid_json.as_object().unwrap();
        assert_eq!(
            select_global_candidate(nested_valid_proxies),
            Some(("LB-Group".to_owned(), Some("LB-Group".to_owned())))
        );
    }

    #[test]
    fn test_select_global_candidate_checks_unknown_group_types_by_members() {
        // An unrecognised group type with `all` but no `now` must not pass as a
        // leaf: its `DIRECT` member would bypass the proxy.
        let no_now = serde_json::json!({
            "GLOBAL": { "all": ["Smart-Group"], "now": "Smart-Group" },
            "Smart-Group": { "type": "Smart", "all": ["DIRECT", "LiveLeaf"] },
            "LiveLeaf": { "type": "Shadowsocks", "alive": true }
        });
        assert_eq!(select_global_candidate(no_now.as_object().unwrap()), None);

        // With `now`, it is followed like a selecting group.
        let now_direct = serde_json::json!({
            "GLOBAL": { "all": ["Smart-Group"], "now": "Smart-Group" },
            "Smart-Group": { "type": "Smart", "now": "DIRECT", "all": ["DIRECT", "LiveLeaf"] },
            "LiveLeaf": { "type": "Shadowsocks", "alive": true }
        });
        assert_eq!(
            select_global_candidate(now_direct.as_object().unwrap()),
            None
        );

        let now_live = serde_json::json!({
            "GLOBAL": { "all": ["Smart-Group"], "now": "Smart-Group" },
            "Smart-Group": { "type": "Smart", "now": "LiveLeaf", "all": ["DIRECT", "LiveLeaf"] },
            "LiveLeaf": { "type": "Shadowsocks", "alive": true }
        });
        assert_eq!(
            select_global_candidate(now_live.as_object().unwrap()),
            Some(("Smart-Group".to_owned(), Some("Smart-Group".to_owned())))
        );
    }

    #[test]
    fn test_select_global_candidate_prefers_global_all_order_over_alphabetical() {
        let json = serde_json::json!({
            "GLOBAL": {
                "all": ["MainProxy", "AppleProxy"],
                "now": "DIRECT"
            },
            "AppleProxy": {
                "type": "Selector",
                "now": "AppleNode",
                "all": ["AppleNode"]
            },
            "AppleNode": {
                "type": "Shadowsocks",
                "alive": true
            },
            "MainProxy": {
                "type": "Selector",
                "now": "MainNode",
                "all": ["MainNode"]
            },
            "MainNode": {
                "type": "Shadowsocks",
                "alive": true
            }
        });
        let proxies = json.as_object().unwrap();
        // In the JSON map, "AppleProxy" sorts before "MainProxy" alphabetically.
        // But GLOBAL.all lists "MainProxy" first, so "MainProxy" must be chosen over "AppleProxy".
        let candidate = select_global_candidate(proxies);
        assert_eq!(
            candidate,
            Some(("MainProxy".to_owned(), Some("DIRECT".to_owned())))
        );
    }

    #[test]
    fn test_select_global_candidate_ignores_dead_leaf() {
        let json = serde_json::json!({
            "GLOBAL": {
                "all": ["DeadNode", "LiveNode"],
                "now": "DIRECT"
            },
            "DeadNode": {
                "type": "Shadowsocks",
                "alive": false
            },
            "LiveNode": {
                "type": "Shadowsocks",
                "alive": true
            }
        });
        let proxies = json.as_object().unwrap();
        assert_eq!(
            select_global_candidate(proxies),
            Some(("LiveNode".to_owned(), Some("DIRECT".to_owned())))
        );
    }

    #[test]
    fn test_select_global_candidate_deep_acyclic_chain() {
        let mut map = serde_json::Map::new();
        // Create a chain of 10 nested Selectors: S0 -> S1 -> ... -> S9 -> Leaf (> 8 links)
        for i in 0..10 {
            let next = if i == 9 {
                "RealLeaf".to_owned()
            } else {
                format!("S{}", i + 1)
            };
            map.insert(
                format!("S{i}"),
                serde_json::json!({
                    "type": "Selector",
                    "now": next,
                    "all": [next]
                }),
            );
        }
        map.insert(
            "RealLeaf".to_owned(),
            serde_json::json!({
                "type": "Shadowsocks",
                "alive": true
            }),
        );
        map.insert(
            "GLOBAL".to_owned(),
            serde_json::json!({
                "type": "Selector",
                "now": "S0",
                "all": ["S0"]
            }),
        );

        assert_eq!(
            select_global_candidate(&map)
                .as_ref()
                .map(|(c, _)| c.as_str()),
            Some("S0")
        );
    }

    #[test]
    fn test_classify_sub_error() {
        use crate::event::codes::*;
        assert_eq!(
            classify_sub_error("SSRF protection: Direct download blocked".to_owned()),
            SUB_SSRF_BLOCKED
        );
        assert_eq!(
            classify_sub_error("Invalid URL: Only HTTP and HTTPS URLs are allowed".to_owned()),
            SUB_URL_INVALID
        );
        assert_eq!(
            validate_subscription_url_basic("http://\t/sub")
                .err()
                .map(classify_sub_error),
            Some(SUB_URL_INVALID)
        );
        assert_eq!(
            validate_subscription_url_with_ip("http://198.18.0.5/sub")
                .err()
                .map(classify_sub_error),
            Some(SUB_URL_INVALID)
        );
        assert_eq!(
            classify_sub_error(
                "Direct DNS: DNS resolution failed; Proxy: HTTP 404 Not Found".to_owned()
            ),
            SUB_HTTP_ERROR
        );
        assert_eq!(
            classify_sub_error(
                "Direct DNS: DNS resolution failed; Proxy: Connection failed".to_owned()
            ),
            SUB_DNS_FAILED
        );
        assert_eq!(
            classify_sub_error("Subscription name cannot be empty".to_owned()),
            SUB_NAME_INVALID
        );
        // Saving a subscription as the runtime config is a name error.
        assert_eq!(
            classify_sub_error("Cannot use reserved name 'run_config'".to_owned()),
            SUB_NAME_INVALID
        );
        assert_eq!(
            classify_sub_error("Request timed out".to_owned()),
            SUB_UPDATE_TIMEOUT
        );
        assert_eq!(
            classify_sub_error("DNS resolution returned no addresses for host".to_owned()),
            SUB_DNS_FAILED
        );
        assert_eq!(
            classify_sub_error("DNS deadline elapsed while resolving host".to_owned()),
            SUB_DNS_FAILED
        );
        assert_eq!(
            classify_sub_error("Direct DNS: DNS resolution timed out for 'x' (1.5s)".to_owned()),
            SUB_DNS_FAILED
        );
        assert_eq!(
            classify_sub_error("DNS resolution timeout for host".to_owned()),
            SUB_DNS_FAILED
        );
        assert_eq!(
            classify_sub_error(
                "DNS resolved to synthetic fake-IP address for 'example.com', cannot pin for direct connection".to_owned()
            ),
            SUB_DNS_FAILED
        );
        assert_eq!(
            classify_sub_error("Proxy SSRF blocked: [SSRF_BLOCKED] private IP".to_owned()),
            SUB_SSRF_BLOCKED
        );
        assert_eq!(
            classify_sub_error(
                "Direct download failed: [SSRF_BLOCKED] DNS resolved to private IP: cdn.test -> 127.0.0.1".to_owned()
            ),
            SUB_SSRF_BLOCKED
        );
        // Two-tier message: the proxy attempt is the final one, so its error
        // decides the code. The direct leg here is the SSRF failure the download
        // path escalates to the proxy on purpose, so letting it win would report
        // a plain proxy connection failure as an SSRF block.
        assert_eq!(
            classify_sub_error(
                "Direct: Direct DNS returned non-public address: DNS resolved to private IP: cdn.test -> 127.0.0.1; Proxy: Connection failed".to_owned()
            ),
            SUB_NETWORK_ERROR
        );
        // A genuine proxy-side SSRF still reports an SSRF block.
        assert_eq!(
            classify_sub_error(
                "Direct: Direct DNS returned non-public address: 127.0.0.1; Proxy: Proxy SSRF blocked: [SSRF_BLOCKED] private IP".to_owned()
            ),
            SUB_SSRF_BLOCKED
        );
        // The realistic shape of an unmapped transport failure: `try_proxy_download`
        // formats `Download failed: {chain}`, and no classifier arm matches a raw
        // reqwest transport error. Without the ran-vs-skipped distinction this
        // fell through to the whole message and the direct leg's SSRF text won.
        assert_eq!(
            classify_sub_error(
                "Direct: Direct DNS returned non-public address: DNS resolved to private IP: cdn.test -> 127.0.0.1; \
                 Proxy: Download failed: tcp connect error: Connection refused (os error 111)"
                    .to_owned()
            ),
            SUB_NETWORK_ERROR
        );
        assert_eq!(
            classify_sub_error(
                "Direct: Direct DNS returned non-public address: 127.0.0.1; \
                 Proxy: Download failed: connection closed before message completed"
                    .to_owned()
            ),
            SUB_NETWORK_ERROR
        );
        // The deadline form still classifies on its own marker.
        assert_eq!(
            classify_sub_error(
                "Direct: Direct DNS returned non-public address: 127.0.0.1; \
                 Proxy: Request deadline exceeded"
                    .to_owned()
            ),
            SUB_UPDATE_TIMEOUT
        );
        // Skipped proxy tier carrying no specific marker: nothing better to
        // report, so the existing classification stands.
        assert_eq!(
            classify_sub_error(
                "Direct: Direct DNS returned non-public address: 127.0.0.1; Proxy: skipped, destination 'cdn.test' could not be verified as public via DNS".to_owned()
            ),
            SUB_SSRF_BLOCKED
        );
    }

    #[test]
    fn test_select_global_candidate_load_balance_diamond_memoization() {
        let mut map = serde_json::Map::new();
        map.insert(
            "Proxy-Leaf".to_owned(),
            serde_json::json!({ "type": "Shadowsocks", "alive": true }),
        );
        map.insert(
            "LB1".to_owned(),
            serde_json::json!({ "type": "LoadBalance", "all": ["Proxy-Leaf"] }),
        );
        map.insert(
            "LB2".to_owned(),
            serde_json::json!({ "type": "LoadBalance", "all": ["Proxy-Leaf"] }),
        );
        map.insert(
            "Top-LB".to_owned(),
            serde_json::json!({ "type": "LoadBalance", "all": ["LB1", "LB2"] }),
        );
        map.insert(
            "GLOBAL".to_owned(),
            serde_json::json!({ "type": "Selector", "all": ["Top-LB"] }),
        );

        assert_eq!(
            select_global_candidate(&map).map(|(c, _)| c),
            Some("Top-LB".to_owned())
        );
    }

    #[test]
    fn test_ends_with_ignore_ascii_case_multibyte_utf8() {
        assert!(ends_with_ignore_ascii_case("node.LOCAL", ".local"));
        assert!(ends_with_ignore_ascii_case("测试.local", ".LOCAL"));
        assert!(!ends_with_ignore_ascii_case("测试.com", ".local"));
        // Does not panic when byte offset s.len() - suffix.len() lands inside a multi-byte UTF-8 char
        assert!(!ends_with_ignore_ascii_case("中国", ".com"));
        assert!(is_private_host("测试.local"));
        assert!(!is_private_host("测试.com"));
    }

    #[test]
    fn test_rule_policy_name_unicode_generic_folding() {
        // `paß` uppercases to `PASS`, so it is still a generic target even
        // though the ASCII-only comparison would not match it.
        assert_eq!(rule_policy_name("DOMAIN-SUFFIX,example.com,paß"), None);
        // Dotless `ı` uppercases to `I`, so `dırect` is still `DIRECT`.
        assert_eq!(rule_policy_name("DOMAIN-SUFFIX,example.com,dırect"), None);
        assert_eq!(
            rule_policy_name("DOMAIN-SUFFIX,example.com,NodeGroup"),
            Some("NodeGroup")
        );
    }
}

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

/// Whether the byte at `at` can start a YAML plain scalar. Indicator
/// characters never start one, and `-`, `?`, `:` only do so when not
/// followed by a separation space: anything else here (an alias, anchor,
/// tag, flow collection, block scalar, or quoted scalar) is node syntax
/// that quoting would corrupt, so it is left alone.
fn starts_plain_scalar(bytes: &[u8], at: usize) -> bool {
    let Some(&first) = bytes.get(at) else {
        return false;
    };
    match first {
        b'!' | b'&' | b'*' | b'{' | b'}' | b'[' | b']' | b',' | b'#' | b'|' | b'>' | b'"'
        | b'\'' | b'%' | b'@' | b'`' => false,
        b'-' | b'?' | b':' => !matches!(
            bytes.get(at + 1),
            Some(b' ') | Some(b'\t') | Some(b'\n') | Some(b'\r') | None
        ),
        _ => true,
    }
}

/// Find a `short-id` value that continues on a following line.
/// `cur` points at the line break (or inline comment) that ends the key
/// line. In block context a plain scalar counts as the value only when
/// it starts on a line indented more than the key itself (the YAML
/// block rule); in flow context line breaks fold to spaces, so any
/// following line's value counts regardless of indent. Blank and
/// comment lines are skipped. Returns the value start, if any.
fn short_id_continuation_value(
    bytes: &[u8],
    mut cur: usize,
    key_indent: usize,
    in_flow: bool,
) -> Option<usize> {
    loop {
        let &b = bytes.get(cur)?;
        if b == b'#' {
            // Comment: skip to the end of its line, then keep looking.
            while let Some(&c) = bytes.get(cur) {
                if matches!(c, b'\n' | b'\r') {
                    break;
                }
                cur += 1;
            }
        } else if matches!(b, b'\n' | b'\r') {
            if b == b'\r' && bytes.get(cur + 1) == Some(&b'\n') {
                cur += 2;
            } else {
                cur += 1;
            }
            let mut indent = 0;
            while matches!(bytes.get(cur), Some(b' ' | b'\t')) {
                cur += 1;
                indent += 1;
            }
            match bytes.get(cur) {
                // Blank or comment line: loop again for the next line.
                Some(b'\n' | b'\r') | Some(b'#') => {}
                Some(_) if (indent > key_indent || in_flow) && starts_plain_scalar(bytes, cur) => {
                    return Some(cur);
                }
                _ => return None,
            }
        } else {
            return None;
        }
    }
}

/// Index just past the previous non-space byte before `pos` (0 at input
/// start): walking back over spaces/tabs from `pos`.
fn back_over_spaces(bytes: &[u8], mut j: usize) -> usize {
    while j > 0 && matches!(bytes.get(j - 1), Some(b' ') | Some(b'\t')) {
        j -= 1;
    }
    j
}

/// Whether a `-` at `dash` starts a sequence entry: it is followed by
/// a space (or a line break) and is itself at the start of its line,
/// after indentation (possibly nested behind further `- ` entries).
/// A dash glued to what follows (`-short-id`, `-'abc`, `-- x`) is
/// plain scalar text, not a sequence marker.
fn dash_starts_sequence(bytes: &[u8], dash: usize) -> bool {
    if !matches!(
        bytes.get(dash + 1),
        None | Some(b' ') | Some(b'\t') | Some(b'\n') | Some(b'\r')
    ) {
        return false;
    }
    let mut j = dash;
    loop {
        j = back_over_spaces(bytes, j);
        if j == 0 || matches!(bytes.get(j - 1), Some(b'\n') | Some(b'\r')) {
            return true;
        }
        // A further `-` only counts as a sequence marker when it is
        // itself followed by a space (`- - ` nesting, not `-- `).
        if bytes.get(j - 1) == Some(&b'-') && matches!(bytes.get(j), Some(b' ') | Some(b'\t')) {
            j -= 1;
            continue;
        }
        return false;
    }
}

/// Whether a node (a quoted scalar or a flow collection) starts at
/// `pos`: at a line start, after `: `, after a sequence `- `, or after
/// a flow indicator inside flow context. A quote or bracket inside a
/// plain scalar (an apostrophe in `don't`, a `"` in `use " anywhere`,
/// a `[` in `HK [Premium`) does not start one. In block context a
/// `:` only counts when whitespace separates it from the node, since
/// `ab:"cd` is one plain scalar there; in flow context the colon needs
/// no separator (`{a:"b"}`).
fn node_starts_here(bytes: &[u8], pos: usize, in_flow: bool) -> bool {
    let j = back_over_spaces(bytes, pos);
    if j == 0 {
        return true;
    }
    match bytes.get(j - 1).copied() {
        Some(b'\n') | Some(b'\r') => true,
        Some(b',') | Some(b'{') | Some(b'[') => in_flow,
        Some(b':') => in_flow || j < pos,
        Some(b'-') => dash_starts_sequence(bytes, j - 1),
        _ => false,
    }
}

/// Best-effort flow tracking for subscription YAML: enough to tell
/// whether a `short-id:` occurrence sits inside a flow collection, a
/// block scalar, or a quoted scalar or comment (where it is not a key
/// at all). This is not a full YAML lexer: quotes only open a scalar at
/// a scalar start, and block scalar content is skipped by indent, so
/// brackets and quotes inside literal text do not confuse it. Positions
/// only move forward, so tracking stays linear in the input.
#[derive(Default)]
struct FlowTracker {
    /// Bytes already scanned.
    pos: usize,
    /// Start of the current line.
    line_start: usize,
    /// Current flow nesting depth (`{`/`[` minus `}`/`]`).
    depth: usize,
    in_single: bool,
    in_double: bool,
    escaped: bool,
    in_comment: bool,
    /// Minimum indent of block scalar content lines, when inside a block
    /// scalar (`|`/`>` header seen); `None` outside one.
    block_min_indent: Option<usize>,
    /// The current line is block scalar content: skip it wholesale.
    block_content_line: bool,
}

impl FlowTracker {
    /// Advance the scan to `target`.
    fn advance_to(&mut self, bytes: &[u8], target: usize) {
        while self.pos < target {
            let Some(&b) = bytes.get(self.pos) else {
                break;
            };
            // Block scalar content lines are literal text: nothing in
            // them (brackets, quotes, apparent keys) affects tracking.
            if self.block_content_line {
                if matches!(b, b'\n' | b'\r') {
                    self.block_content_line = false;
                } else {
                    self.pos += 1;
                    continue;
                }
            }
            self.step_byte(bytes, b);
            if matches!(b, b'\n' | b'\r') {
                self.step_line_break(bytes);
            }
            self.pos += 1;
        }
    }

    /// One tracked byte: comment, quoted scalar, flow, and block header
    /// state transitions. Line breaks are handled by `step_line_break`.
    fn step_byte(&mut self, bytes: &[u8], b: u8) {
        let prev = if self.pos == 0 {
            None
        } else {
            bytes.get(self.pos - 1).copied()
        };
        if self.in_comment {
            if matches!(b, b'\n' | b'\r') {
                self.in_comment = false;
            }
        } else if self.in_single {
            if b == b'\'' {
                if bytes.get(self.pos + 1) == Some(&b'\'') {
                    // Doubled quote: an escaped quote inside the scalar.
                    self.pos += 1;
                } else {
                    self.in_single = false;
                }
            }
        } else if self.in_double {
            if self.escaped {
                self.escaped = false;
            } else if b == b'\\' {
                self.escaped = true;
            } else if b == b'"' {
                self.in_double = false;
            }
        } else if b == b'#'
            && matches!(
                prev,
                None | Some(b' ') | Some(b'\t') | Some(b'\n') | Some(b'\r')
            )
        {
            self.in_comment = true;
        } else if (b == b'\'' || b == b'"') && node_starts_here(bytes, self.pos, self.depth > 0) {
            if b == b'\'' {
                self.in_single = true;
            } else {
                self.in_double = true;
            }
        } else if (b == b'{' || b == b'[') && node_starts_here(bytes, self.pos, self.depth > 0) {
            self.depth += 1;
        } else if b == b'}' || b == b']' {
            self.depth = self.depth.saturating_sub(1);
        } else if (b == b'|' || b == b'>')
            && self.depth == 0
            && self.block_min_indent.is_none()
            && self.block_header_start(bytes, self.pos)
        {
            self.enter_block_scalar(bytes);
        }
    }

    /// A block scalar header: content lines are those indented past the
    /// header line's entry (or past the explicit indent indicator, when
    /// given). On a sequence-item line the entry is the mapping key
    /// after the `- ` markers, not the `-` itself: a sibling key sits
    /// at the key column, so measuring from the `-` would swallow it.
    /// A bare sequence-item scalar (`- |`) has no key, so it measures
    /// from the line indent instead.
    fn enter_block_scalar(&mut self, bytes: &[u8]) {
        let mut entry = self.line_start;
        while matches!(bytes.get(entry), Some(b' ') | Some(b'\t')) {
            entry += 1;
        }
        let line_indent = entry - self.line_start;
        while entry < self.pos
            && bytes.get(entry) == Some(&b'-')
            && matches!(bytes.get(entry + 1), Some(b' ') | Some(b'\t'))
        {
            entry += 1;
            while matches!(bytes.get(entry), Some(b' ') | Some(b'\t')) {
                entry += 1;
            }
        }
        let header_indent = if entry == self.pos {
            line_indent
        } else {
            entry - self.line_start
        };
        let mut content_min = header_indent + 1;
        if let Some(d) = bytes.get(self.pos + 1).copied().filter(u8::is_ascii_digit) {
            if (b'1'..=b'9').contains(&d) {
                content_min = header_indent + usize::from(d - b'0');
            }
        }
        self.block_min_indent = Some(content_min);
    }

    /// A line break: move the line start, and inside a block scalar
    /// decide whether the next line is still content or ends it.
    fn step_line_break(&mut self, bytes: &[u8]) {
        self.line_start = self.pos + 1;
        if let Some(content_min) = self.block_min_indent {
            let mut next = self.line_start;
            while matches!(bytes.get(next), Some(b' ') | Some(b'\t')) {
                next += 1;
            }
            match bytes.get(next) {
                // Blank lines belong to the scalar.
                Some(b'\n') | Some(b'\r') | None => {
                    self.block_content_line = true;
                }
                Some(_) if next - self.line_start >= content_min => {
                    self.block_content_line = true;
                }
                Some(_) => {
                    self.block_min_indent = None;
                }
            }
        }
    }

    /// Whether `pos` starts a block scalar header: `|`/`>` as a mapping
    /// value (after `: `) or a sequence value (after a line-start `- `).
    /// A bare colon does not count (`name: HK:>` is one plain scalar);
    /// block scalars never appear in flow context, so no flow exception
    /// applies here.
    fn block_header_start(&self, bytes: &[u8], pos: usize) -> bool {
        let j = back_over_spaces(bytes, pos);
        if j == 0 {
            return false;
        }
        match bytes.get(j - 1).copied() {
            Some(b':') => j < pos,
            Some(b'-') => dash_starts_sequence(bytes, j - 1),
            _ => false,
        }
    }

    const fn in_flow(&self) -> bool {
        self.depth > 0
    }

    const fn in_string_or_comment(&self) -> bool {
        self.in_single || self.in_double || self.in_comment
    }

    const fn in_block_scalar(&self) -> bool {
        self.block_min_indent.is_some()
    }
}

/// Whether the line starting at `from` is a mapping entry rather than a
/// plain scalar: it contains a `:` followed by a space, a line break, or
/// the end of input, before any comment starts. A plain scalar cannot
/// contain that combination, so such a line holds a (possibly nested)
/// mapping, not a value to quote.
fn line_is_mapping_entry(bytes: &[u8], mut i: usize) -> bool {
    let mut prev = None;
    while let Some(&b) = bytes.get(i) {
        if matches!(b, b'\n' | b'\r') {
            return false;
        }
        if b == b'#' && matches!(prev, Some(b' ') | Some(b'\t')) {
            return false;
        }
        if b == b':' {
            match bytes.get(i + 1) {
                Some(b' ') | Some(b'\t') | Some(b'\n') | Some(b'\r') | None => return true,
                _ => {}
            }
        }
        prev = Some(b);
        i += 1;
    }
    false
}

/// Indentation of a `short-id:` key at `pos`, when the key is eligible:
/// in block context it must start its line apart from indentation; in
/// flow context it may also follow an opening bracket or a separator;
/// as a sequence entry it may follow `- `. The walk back covers
/// spaces/tabs only, so it stays linear even when many occurrences
/// share one very long line. For a sequence entry the indent returned
/// is the `-` column, so continuation lines compare against it.
fn key_indent_at(bytes: &[u8], pos: usize, in_flow: bool) -> Option<usize> {
    let mut line_pos = pos;
    while line_pos > 0 && matches!(bytes.get(line_pos - 1), Some(b' ' | b'\t')) {
        line_pos -= 1;
    }
    let prev = if line_pos == 0 {
        None
    } else {
        bytes.get(line_pos - 1).copied()
    };
    if line_pos == 0
        || matches!(prev, Some(b'\n') | Some(b'\r'))
        || (in_flow && matches!(prev, Some(b',') | Some(b'{') | Some(b'[')))
    {
        return Some(pos - line_pos);
    }
    // Sequence entry: `- short-id:` (possibly nested `- - short-id:`).
    // The indent is the innermost `-` column, so continuation lines
    // compare against it. This walk runs only on the rare sequence path.
    if prev == Some(b'-') && dash_starts_sequence(bytes, line_pos - 1) {
        let dash = line_pos - 1;
        let mut line_start = dash;
        while line_start > 0 && !matches!(bytes.get(line_start - 1), Some(b'\n') | Some(b'\r')) {
            line_start -= 1;
        }
        return Some(dash - line_start);
    }
    None
}

/// Plain scalar after an anchor at `cursor` (whose byte is `&`): the
/// anchor name is kept, and the scalar after it is quoted, inline or on
/// a continuation line. An empty name, a tag, an alias, or any other
/// node syntax after the name is left alone.
fn anchored_scalar_start(
    bytes: &[u8],
    cursor: usize,
    key_indent: usize,
    in_flow: bool,
) -> Option<usize> {
    let mut cur = cursor + 1;
    while let Some(&b) = bytes.get(cur) {
        if matches!(
            b,
            b' ' | b'\t' | b'\n' | b'\r' | b',' | b'[' | b']' | b'{' | b'}'
        ) {
            break;
        }
        cur += 1;
    }
    if cur == cursor + 1 {
        return None;
    }
    while matches!(bytes.get(cur), Some(b' ') | Some(b'\t')) {
        cur += 1;
    }
    match bytes.get(cur) {
        Some(b'\n' | b'\r') | Some(b'#') => {
            short_id_continuation_value(bytes, cur, key_indent, in_flow)
        }
        Some(_) if starts_plain_scalar(bytes, cur) => Some(cur),
        _ => None,
    }
}

/// Append a plain scalar wrapped in double quotes, escaping `"` and `\`
/// for double-quoted style. Tokens without those bytes take the fast
/// path so the hot path on large documents stays a plain copy.
fn push_quoted(out: &mut String, token: &str) {
    out.push('"');
    if token.bytes().any(|b| b == b'"' || b == b'\\') {
        for c in token.chars() {
            match c {
                '"' => out.push_str("\\\""),
                '\\' => out.push_str("\\\\"),
                _ => out.push(c),
            }
        }
    } else {
        out.push_str(token);
    }
    out.push('"');
}

/// Quote `short-id` values in YAML content before parsing.
/// This prevents YAML from interpreting hex-like values (e.g., "34010e92") as scientific notation.
#[must_use]
pub fn quote_short_id_values(content: &str) -> String {
    // Fast path: if "short-id:" is not present at all, return input immediately.
    if !content.contains("short-id:") {
        return content.to_owned();
    }

    // Fast-path string search to avoid Regex engine overhead.
    let mut out = String::with_capacity(content.len() + 128);
    let mut last_match = 0;

    let all_bytes = content.as_bytes();
    let mut tracker = FlowTracker::default();
    for (pos, _) in content.match_indices("short-id:") {
        if pos < last_match {
            continue;
        }
        tracker.advance_to(all_bytes, pos);
        // Inside a quoted scalar, a comment, or block scalar content,
        // this is not a key at all.
        if tracker.in_string_or_comment() || tracker.in_block_scalar() {
            continue;
        }

        let Some(key_indent) = key_indent_at(all_bytes, pos, tracker.in_flow()) else {
            continue;
        };

        // In block context the colon must be followed by a separation
        // space, a line break, or the end of input; otherwise the whole
        // `short-id:...` is one plain scalar, not a key (e.g. the
        // sequence entry `- short-id:34010e92`). In flow context the
        // colon needs no separator (`{short-id:34010e92}` is a key).
        let after_key = pos + "short-id:".len();
        if !tracker.in_flow()
            && !matches!(
                all_bytes.get(after_key),
                None | Some(b' ') | Some(b'\t') | Some(b'\n') | Some(b'\r')
            )
        {
            continue;
        }

        // Skip spaces and tabs after "short-id:".
        let mut cursor = pos + "short-id:".len();
        while matches!(all_bytes.get(cursor), Some(b' ' | b'\t')) {
            cursor += 1;
        }

        // Find the value start, if this occurrence has a quotable one.
        // A plain scalar may continue on a following line, but only when
        // that line is indented more than the key itself (the YAML block
        // rule): `short-id:\n  34010e92` quotes, while a sibling key at
        // the same or lower indent is left alone. In flow context line
        // breaks fold to spaces, so the indent rule does not apply.
        let candidate = match all_bytes.get(cursor) {
            Some(b'\n' | b'\r') | Some(b'#') => {
                short_id_continuation_value(all_bytes, cursor, key_indent, tracker.in_flow())
            }
            // An anchor keeps its name; quote an eligible plain scalar
            // after it, inline or on a continuation line.
            Some(b'&') => anchored_scalar_start(all_bytes, cursor, key_indent, tracker.in_flow()),
            // Inline value on the same line, when it is a plain scalar.
            Some(_) if starts_plain_scalar(all_bytes, cursor) => Some(cursor),
            // Anything else (quoted, block scalar, alias, tag, flow
            // collection, or nothing after the key) is left alone.
            _ => None,
        };
        let Some(val_start) = candidate else {
            continue;
        };

        let mut val_end = val_start;
        while val_end < content.len() {
            let Some(&b) = content.as_bytes().get(val_end) else {
                break;
            };
            if matches!(b, b' ' | b'\t' | b'\r' | b'\n') {
                break;
            }
            // In flow context a plain scalar also ends at a separator or
            // a closing bracket, so the separator stays outside the quotes.
            if tracker.in_flow() && matches!(b, b',' | b'}' | b']') {
                break;
            }
            val_end += 1;
        }

        // A token containing a flow indicator (`,`, `[`, `]`, `{`, `}`)
        // is left alone: in block context it parses to the same string
        // quoted or not, and in flow context quoting it would swallow
        // the separator (changing the value, or breaking the mapping).
        if content[val_start..val_end]
            .bytes()
            .any(|b| matches!(b, b',' | b'[' | b']' | b'{' | b'}'))
        {
            continue;
        }

        // In block context, a line holding a mapping entry (a token
        // followed by `: `) is a nested mapping, not a scalar value.
        if !tracker.in_flow() && line_is_mapping_entry(all_bytes, val_start) {
            continue;
        }

        // A plain scalar runs to the end of its line: if more
        // non-comment text follows the first token, the value is
        // multi-word, and quoting only its first word would corrupt
        // it (`"34010e92" extra` is invalid YAML). Multi-word values
        // cannot parse as numbers, so leaving them alone is safe.
        let mut rest = val_end;
        while matches!(all_bytes.get(rest), Some(b' ') | Some(b'\t')) {
            rest += 1;
        }
        if let Some(&b) = all_bytes.get(rest) {
            let separator = matches!(b, b'\n' | b'\r' | b'#')
                || (tracker.in_flow() && matches!(b, b',' | b'}' | b']'));
            if !separator {
                continue;
            }
        }

        out.push_str(&content[last_match..val_start]);
        push_quoted(&mut out, &content[val_start..val_end]);
        last_match = val_end;
    }

    out.push_str(&content[last_match..]);
    out
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
    let upper = name.to_uppercase();
    if upper.is_empty()
        || upper == "DIRECT"
        || upper == "REJECT"
        || upper == "MATCH"
        || upper == "PROXY"
        || upper == "PASS"
        || upper == "DROP"
    {
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

/// Decode percent-encoded string (e.g. "%E4%B8%AD%E6%96%87" → "中文").
#[must_use]
pub fn percent_decode(input: &str) -> String {
    if !input.contains('%') {
        return input.to_owned();
    }

    let bytes = input.as_bytes();
    let mut result = Vec::with_capacity(bytes.len());
    let mut i = 0;

    while i < bytes.len() {
        if let Some(&b) = bytes.get(i) {
            if b == b'%' {
                if let (Some(&h), Some(&l)) = (bytes.get(i + 1), bytes.get(i + 2)) {
                    if let (Some(hi), Some(lo)) = (decode_hex_digit(h), decode_hex_digit(l)) {
                        result.push((hi << 4) | lo);
                        i += 3;
                        continue;
                    }
                }
                result.push(b'%');
                i += 1;
            } else {
                let rest = match bytes.get(i..) {
                    Some(r) => r,
                    None => break,
                };
                let next_pct = rest
                    .iter()
                    .position(|&b| b == b'%')
                    .map_or(bytes.len(), |pos| i + pos);
                if let Some(chunk) = bytes.get(i..next_pct) {
                    result.extend_from_slice(chunk);
                }
                i = next_pct;
            }
        } else {
            break;
        }
    }

    String::from_utf8(result).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned())
}

/// Attempt to base64-decode content that does not already contain Clash markers.
/// Returns `Some(decoded)` only if the decoded bytes are valid UTF-8, valid YAML,
/// and contain a `proxies:` key (required for a valid Clash config).
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
    let yaml_val: serde_yaml::Value = serde_yaml::from_str(&decoded_str).ok()?;
    let has_proxies = yaml_val
        .get("proxies")
        .is_some_and(serde_yaml::Value::is_sequence);
    has_proxies.then_some(decoded_str)
}

#[inline]
#[must_use]
pub fn is_mihomo_fake_ip(ip: IpAddr) -> bool {
    FakeIpRanges::default().contains(ip)
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
        Self {
            // 198.18.0.0/15
            v4: vec![(0xc612_0000, 15)],
            // fdfe:dcba:9876::/64
            v6: vec![(0xfdfe_dcba_9876_0000_0000_0000_0000_0000, 64)],
        }
    }
}

impl FakeIpRanges {
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

/// Check if a host is a private or local address (SSRF protection)
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
    let host_lower = normalized.to_lowercase();

    if host_lower == "localhost"
        || host_lower.ends_with(".localhost")
        || host_lower.ends_with(".local")
        || host_lower.ends_with(".internal")
        || host_lower.ends_with(".intranet")
        || host_lower.ends_with(".private")
        || host_lower.ends_with(".lan")
        || host_lower == "home.arpa"
        || host_lower.ends_with(".home.arpa")
        || host_lower.ends_with(".home")
        || host_lower.ends_with(".corp")
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
    let host_lower = normalized.to_lowercase();

    if host_lower == "localhost" || host_lower.ends_with(".localhost") {
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
    validate_public_host_addrs_with_ranges(host, addrs, &FakeIpRanges::default())
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
    let lower = trimmed.to_ascii_lowercase();
    if let Some(rest) = lower
        .strip_prefix("http:")
        .or_else(|| lower.strip_prefix("https:"))
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
    validate_subscription_url_with_ip_with_ranges(url, &FakeIpRanges::default())
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
            let redacted = crate::config::merge::mask_url(url_str.to_owned());
            result.push_str(&redacted);
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
    fn test_try_decode_base64_content() {
        let yaml = "proxies:\n  - name: test\n    type: ss\n    port: 443";
        let encoded = base64::engine::general_purpose::STANDARD.encode(yaml);
        let result = try_decode_base64_content(&encoded);
        assert!(result.is_some());
        assert!(result.unwrap().contains("proxies:"));

        assert!(try_decode_base64_content("not base64 at all!!!").is_none());

        let not_yaml = base64::engine::general_purpose::STANDARD.encode("just some random text");
        assert!(try_decode_base64_content(&not_yaml).is_none());
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
    fn test_quote_short_id_values_multiline_continuation() {
        // A plain scalar on the next, more-indented line is still the value.
        let yaml = "short-id:\n  34010e92";
        let result = quote_short_id_values(yaml);
        assert_eq!(result, "short-id:\n  \"34010e92\"");
    }

    #[test]
    fn test_quote_short_id_values_comment_lines_skipped() {
        // A comment between the key and its value is not the value: the
        // comment stays untouched and the real value still gets quoted.
        let yaml = "short-id:\n  # note\n  34010e92";
        let result = quote_short_id_values(yaml);
        assert_eq!(result, "short-id:\n  # note\n  \"34010e92\"");
    }

    #[test]
    fn test_quote_short_id_values_inline_comment_not_quoted() {
        // A comment after the key means the value is empty, not "#".
        let yaml = "short-id: # note";
        let result = quote_short_id_values(yaml);
        assert_eq!(result, yaml);
    }

    #[test]
    fn test_quote_short_id_values_block_scalar_not_quoted() {
        // A block scalar is already a string: quoting its header would
        // corrupt the document, so both forms stay untouched.
        let yaml = "short-id:\n  |-\n    34010e92";
        assert_eq!(quote_short_id_values(yaml), yaml);
        let yaml = "short-id: |-\n  34010e92";
        assert_eq!(quote_short_id_values(yaml), yaml);
    }

    #[test]
    fn test_quote_short_id_values_cr_only_line_endings() {
        // A carriage return alone is a YAML line break too.
        let yaml = "a: 1\rshort-id: 34010e92\r";
        let result = quote_short_id_values(yaml);
        assert_eq!(result, "a: 1\rshort-id: \"34010e92\"\r");
    }

    #[test]
    fn test_quote_short_id_values_alias_not_quoted() {
        // An alias is a reference, not text: quoting it would stop it
        // from resolving to its anchor.
        let yaml = "sid: &sid 34010e92\nshort-id: # note\n  *sid";
        assert_eq!(quote_short_id_values(yaml), yaml);
    }

    #[test]
    fn test_quote_short_id_values_tag_not_quoted() {
        // A tag is node syntax, not the value itself: quoting it would
        // split the tagged scalar into two tokens.
        let yaml = "short-id: !!str 34010e92";
        assert_eq!(quote_short_id_values(yaml), yaml);
        let yaml = "short-id:\n  !!str 34010e92";
        assert_eq!(quote_short_id_values(yaml), yaml);
    }

    #[test]
    fn test_quote_short_id_values_anchor_and_flow_not_quoted() {
        // An anchor keeps its name and the plain scalar after it gets
        // quoted; a flow collection as the value is left alone.
        let yaml = "short-id: &a 34010e92";
        let result = quote_short_id_values(yaml);
        assert_eq!(result, "short-id: &a \"34010e92\"");
        let yaml = "short-id: {id: 34010e92}";
        assert_eq!(quote_short_id_values(yaml), yaml);
    }

    #[test]
    fn test_quote_short_id_values_flow_context() {
        // In flow context the scalar ends at the separator, so the
        // separator stays outside the quotes, on one line or many.
        let yaml = "{\n  short-id: 34010e92,\n  y: 1\n}";
        let result = quote_short_id_values(yaml);
        assert_eq!(result, "{\n  short-id: \"34010e92\",\n  y: 1\n}");
        let yaml = "{\n  short-id: 34010e92}";
        let result = quote_short_id_values(yaml);
        assert_eq!(result, "{\n  short-id: \"34010e92\"}");
        let yaml = "reality-opts: {short-id: 34010e92}";
        let result = quote_short_id_values(yaml);
        assert_eq!(result, "reality-opts: {short-id: \"34010e92\"}");
        // In block context a token containing a separator parses to the
        // same string quoted or not, so it is left alone.
        let yaml = "short-id: abc,def";
        assert_eq!(quote_short_id_values(yaml), yaml);
    }

    #[test]
    fn test_quote_short_id_values_nested_mapping_not_quoted() {
        // A more-indented line holding a mapping entry is a nested
        // mapping, not a scalar continuation.
        let yaml = "short-id:\n  next: 1";
        assert_eq!(quote_short_id_values(yaml), yaml);
    }

    #[test]
    fn test_quote_short_id_values_interior_quotes_escaped() {
        // A plain scalar may contain quotes and backslashes inside; they
        // must be escaped when the token is wrapped in double quotes.
        let yaml = "short-id: a\"b\\c";
        let result = quote_short_id_values(yaml);
        assert_eq!(result, "short-id: \"a\\\"b\\\\c\"");
    }

    #[test]
    fn test_quote_short_id_values_inside_string_or_comment_not_quoted() {
        // An occurrence inside a quoted scalar or a comment is not a key.
        let yaml = "key: \"foo\n  short-id: 34010e92\"";
        assert_eq!(quote_short_id_values(yaml), yaml);
        let yaml = "# short-id: 34010e92";
        assert_eq!(quote_short_id_values(yaml), yaml);
    }

    #[test]
    fn test_quote_short_id_values_interior_quote_not_a_scalar_start() {
        // A quote inside a plain scalar does not open a quoted scalar,
        // so a later short-id key is still found and quoted.
        let yaml = "note: use \" anywhere\nshort-id: 34010e92";
        let result = quote_short_id_values(yaml);
        assert_eq!(result, "note: use \" anywhere\nshort-id: \"34010e92\"");
        let yaml = "note: don't stop\nshort-id: 34010e92";
        let result = quote_short_id_values(yaml);
        assert_eq!(result, "note: don't stop\nshort-id: \"34010e92\"");
    }

    #[test]
    fn test_quote_short_id_values_block_scalar_content_untouched() {
        // Brackets, braces, and apparent keys inside a block scalar are
        // literal text: they must not affect flow tracking or quoting,
        // neither inside the scalar nor for keys after it ends.
        let yaml = "desc: |\n  text [ bracket\n  more\nshort-id: abc,def";
        assert_eq!(quote_short_id_values(yaml), yaml);
        let yaml = "desc: |\n  something { here\n  x, short-id: 34010e92\nnext: 1";
        assert_eq!(quote_short_id_values(yaml), yaml);
    }

    #[test]
    fn test_quote_short_id_values_sequence_entry() {
        // A mapping entry inside a sequence item is a real key, inline
        // or with a continuation value under the `-` column.
        let yaml = "- short-id: 34010e92";
        let result = quote_short_id_values(yaml);
        assert_eq!(result, "- short-id: \"34010e92\"");
        let yaml = "- short-id:\n  34010e92";
        let result = quote_short_id_values(yaml);
        assert_eq!(result, "- short-id:\n  \"34010e92\"");
    }

    #[test]
    fn test_quote_short_id_values_compact_flow_quoted_value() {
        // A quote directly after `:` in flow context opens a quoted
        // scalar, so a `}` inside it does not close the flow early.
        let yaml = "{x: \"a}b\", short-id: 34010e92}";
        let result = quote_short_id_values(yaml);
        assert_eq!(result, "{x: \"a}b\", short-id: \"34010e92\"}");
    }

    #[test]
    fn test_quote_short_id_values_colon_without_separator() {
        // In block context a colon with no separating space is plain
        // scalar text, not a key; in flow context it is a key.
        let yaml = "- short-id:34010e92";
        assert_eq!(quote_short_id_values(yaml), yaml);
        let yaml = "short-id:34010e92";
        assert_eq!(quote_short_id_values(yaml), yaml);
        let yaml = "{short-id:34010e92}";
        let result = quote_short_id_values(yaml);
        assert_eq!(result, "{short-id:\"34010e92\"}");
    }

    #[test]
    fn test_quote_short_id_values_quote_after_bare_colon_or_comma() {
        // A quote after a bare colon or a comma in block context is
        // plain scalar text, not a quoted scalar start, so a later
        // short-id key is still found and quoted.
        let yaml = "password: ab:\"cd\nshort-id: 34010e92";
        let result = quote_short_id_values(yaml);
        assert_eq!(result, "password: ab:\"cd\nshort-id: \"34010e92\"");
        let yaml = "name: a,'b\nshort-id: 34010e92";
        let result = quote_short_id_values(yaml);
        assert_eq!(result, "name: a,'b\nshort-id: \"34010e92\"");
    }

    #[test]
    fn test_quote_short_id_values_sequence_block_scalar_sibling() {
        // A block scalar on a sequence-item line ends at a sibling key
        // at the key column, not at the `-` column.
        let yaml = "- desc: |\n    text\n  short-id: 34010e92";
        let result = quote_short_id_values(yaml);
        assert_eq!(result, "- desc: |\n    text\n  short-id: \"34010e92\"");
    }

    #[test]
    fn test_quote_short_id_values_bracket_in_plain_scalar() {
        // An unmatched bracket inside a block plain scalar does not
        // open flow context for later keys.
        let yaml = "name: HK [Premium\nshort-id: abc,def";
        assert_eq!(quote_short_id_values(yaml), yaml);
        let yaml = "name: HK [Premium\nshort-id:\n  next: 1";
        assert_eq!(quote_short_id_values(yaml), yaml);
    }

    #[test]
    fn test_quote_short_id_values_dash_without_space_not_sequence() {
        // A dash glued to what follows is plain scalar text, not a
        // sequence entry, so it must not make a key or open a quote.
        let yaml = "-short-id: 34010e92";
        assert_eq!(quote_short_id_values(yaml), yaml);
        let yaml = "-'abc\nshort-id: 34010e92";
        let result = quote_short_id_values(yaml);
        assert_eq!(result, "-'abc\nshort-id: \"34010e92\"");
    }

    #[test]
    fn test_quote_short_id_values_bare_colon_not_block_header() {
        // A `>` after a bare colon is plain scalar text, not a block
        // scalar header, so a sibling key is still quoted.
        let yaml = "- name: HK:>\n  short-id: 34010e92";
        let result = quote_short_id_values(yaml);
        assert_eq!(result, "- name: HK:>\n  short-id: \"34010e92\"");
    }

    #[test]
    fn test_quote_short_id_values_flow_continuation_same_indent() {
        // In flow context a line break folds to a space, so a value on
        // the next line counts even at the same indent as its key.
        let yaml = "{\nshort-id:\n34010e92}";
        let result = quote_short_id_values(yaml);
        assert_eq!(result, "{\nshort-id:\n\"34010e92\"}");
        // In block context the same shape is not a continuation.
        let yaml = "short-id:\n34010e92";
        assert_eq!(quote_short_id_values(yaml), yaml);
    }

    #[test]
    fn test_quote_short_id_values_multi_word_not_quoted() {
        // Quoting only the first word of a multi-word scalar would
        // corrupt it; multi-word values cannot parse as numbers, so
        // they are left alone, inline, on a continuation line, and
        // after an anchor alike.
        let yaml = "short-id: 34010e92 extra";
        assert_eq!(quote_short_id_values(yaml), yaml);
        let yaml = "short-id:\n  34010e92 extra";
        assert_eq!(quote_short_id_values(yaml), yaml);
        let yaml = "short-id: &a 34010e92 extra";
        assert_eq!(quote_short_id_values(yaml), yaml);
    }

    #[test]
    fn test_quote_short_id_values_value_after_inline_comment() {
        // A comment ends the key line, but the value may still follow on
        // a more-indented line, and it still needs quoting.
        let yaml = "short-id: # note\n  34010e92";
        let result = quote_short_id_values(yaml);
        assert_eq!(result, "short-id: # note\n  \"34010e92\"");
    }

    #[test]
    fn test_quote_short_id_values_sibling_key_not_quoted() {
        // A key at the same indent on the next line is a sibling, not the
        // value: quoting it would corrupt the mapping.
        let yaml = "outer:\n  short-id:\n  next: 1";
        let result = quote_short_id_values(yaml);
        assert_eq!(result, yaml);
    }

    #[test]
    fn test_quote_short_id_values_repeated_occurrences_on_one_line() {
        // Occurrences that are not keys (e.g. inside a long comment) must
        // not be quoted, no matter how many share the line.
        let yaml = "# short-id: a short-id: b short-id: c\nshort-id: 34010e92";
        let result = quote_short_id_values(yaml);
        assert_eq!(
            result,
            "# short-id: a short-id: b short-id: c\nshort-id: \"34010e92\""
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
}

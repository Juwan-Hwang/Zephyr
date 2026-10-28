//! TUN configuration pure functions — migrated from `src-tauri/src/core/tun_manager.rs`.
//!
//! Only the pure YAML manipulation functions are migrated.
//! Platform-specific process management (root, osascript, etc.) remains in src-tauri.

use serde_yaml as yaml;

use yaml::Value as YamlValue;

use crate::error::AppError;

/// Whether a line opens a quoted mapping key that could name `key` —
/// literally, or via escapes the line scanner cannot decode. An
/// unterminated quote also counts: only the full parser can decide.
fn quoted_key_could_name(line: &str, key: &str) -> bool {
    if let Some(after_quote) = line.strip_prefix('"') {
        return match after_quote.find('"') {
            Some(close) => {
                let quoted = &after_quote[..close];
                quoted.contains('\\') || quoted == key
            }
            None => true,
        };
    }
    if let Some(after_quote) = line.strip_prefix('\'') {
        // Single-quoted keys: the only escape is '' for a literal quote,
        // so the key can be decoded exactly.
        let mut decoded = String::new();
        let mut chars = after_quote.chars();
        let closed = loop {
            match chars.next() {
                None => break false,
                Some('\'') => {
                    if chars.clone().next() == Some('\'') {
                        chars.next();
                        decoded.push('\'');
                    } else {
                        break true;
                    }
                }
                Some(c) => decoded.push(c),
            }
        };
        return !closed || decoded == key;
    }
    false
}

/// Index of the mapping colon in a single entry body (leading
/// indentation already removed), or `None` when the body has no
/// mapping colon. The separator is a colon followed by a space, a
/// tab, or the end of the line; a colon followed by anything else is
/// part of the plain scalar around it (`a:b: c` is the key `a:b`
/// with value `c`). Colons inside quoted spans do not count either:
/// a quoted key may itself contain one (`"a:#": v`, where the colon
/// after `#` is part of the key, not the separator — reading it as
/// the separator would mistake the value for a comment). A quote
/// only opens a span at the very start of the body, where a key
/// token begins; an interior quote in a plain key (`don't`,
/// `name 'x`) is ordinary text.
fn mapping_colon_index(body: &str) -> Option<usize> {
    let mut quote: Option<u8> = None;
    let mut prev: Option<u8> = None;
    let mut bytes = body.bytes().enumerate().peekable();
    while let Some((i, b)) = bytes.next() {
        match quote {
            Some(b'"') => {
                if b == b'\\' {
                    // Skip the escaped character entirely.
                    if let Some((_, escaped)) = bytes.next() {
                        prev = Some(escaped);
                        continue;
                    }
                } else if b == b'"' {
                    quote = None;
                }
            }
            Some(b'\'') => {
                if b == b'\'' {
                    // '' is an escaped quote inside single-quoted spans;
                    // a lone ' closes the span.
                    if bytes.peek().is_some_and(|&(_, next)| next == b'\'') {
                        bytes.next();
                        prev = Some(b'\'');
                        continue;
                    }
                    quote = None;
                }
            }
            _ => {
                if (b == b'"' || b == b'\'') && i == 0 {
                    quote = Some(b);
                } else if b == b':'
                    && bytes
                        .peek()
                        .is_none_or(|&(_, next)| next == b' ' || next == b'\t')
                {
                    return Some(i);
                } else if b == b'#' && (i == 0 || prev.is_some_and(|p| p == b' ' || p == b'\t')) {
                    // A comment ahead of the separator colon: this body
                    // carries no mapping entry at all.
                    return None;
                }
            }
        }
        prev = Some(b);
    }
    None
}

/// The identity of a mapping key, for duplicate-key detection.
enum KeyIdentity<'a> {
    /// A key whose decoded identity is the contained text slice: the
    /// text before the separator colon, with one layer of
    /// surrounding quotes removed, so a plain key and the same
    /// key quoted (`port` vs `"port"`) count as one — the parser
    /// compares decoded keys and rejects a repeat.
    /// Borrowing directly from the input string avoids heap allocations.
    Key(&'a str),
    /// A key whose identity comparison cannot establish: a
    /// quoted key carrying escape sequences (`\x61` in a
    /// double-quoted key, a doubled `''` in a single-quoted
    /// one), whose decoded form is not its raw text, or a plain
    /// key the parser types as a non-string (`true`, `1`,
    /// `null`), whose equal keys can be spelled several ways
    /// (`true`/`TRUE`, `1`/`+1`). Callers fall back rather
    /// than risk treating two spellings of one key as
    /// distinct.
    Undecidable,
}

/// The identity of the mapping key a line body carries, if the
/// body is a mapping entry at all.
fn mapping_key_identity<'a>(body: &'a str) -> Option<KeyIdentity<'a>> {
    let colon = mapping_colon_index(body)?;
    let segment = body[..colon].trim();
    if let Some(inner) = segment
        .strip_prefix('"')
        .and_then(|rest| rest.strip_suffix('"'))
    {
        if inner.contains('\\') {
            return Some(KeyIdentity::Undecidable);
        }
        return Some(KeyIdentity::Key(inner));
    }
    if let Some(inner) = segment
        .strip_prefix('\'')
        .and_then(|rest| rest.strip_suffix('\''))
    {
        if inner.contains("''") {
            return Some(KeyIdentity::Undecidable);
        }
        return Some(KeyIdentity::Key(inner));
    }
    if !yaml_unquoted_scalar_is_string(segment) {
        return Some(KeyIdentity::Undecidable);
    }
    Some(KeyIdentity::Key(segment))
}

/// Records a top-level line's mapping key in `seen`, returning
/// whether the line forces a fallback: it repeats a key already
/// recorded (a duplicate the parser rejects), or its key is
/// quoted with escapes (see `KeyIdentity::Undecidable`).
/// Sequence entries open a fresh mapping per entry, so their
/// inner keys are not top-level keys.
fn note_top_level_key<'a>(line: &'a str, seen: &mut std::collections::HashSet<&'a str>) -> bool {
    if sequence_entry_body(line).is_some() {
        return false;
    }
    match mapping_key_identity(line) {
        Some(KeyIdentity::Key(identity)) => !seen.insert(identity),
        Some(KeyIdentity::Undecidable) => true,
        None => false,
    }
}

/// Whether the document contains a character the scanners' line
/// and whitespace model cannot represent. Two families: whitespace
/// other than the ASCII separation characters (Rust's `trim`
/// family treats Unicode whitespace — NBSP, ideographic space,
/// vertical tab, … — as whitespace, but YAML separation is only
/// space and tab, and indentation is only spaces), and a carriage
/// return that is not part of a CRLF pair (the parser treats a
/// lone `\r` as a line break, so it can end a comment or a line
/// the scanners still see as one line, while `str::lines` only
/// breaks on `\n` and `\r\n`). Both fast extractors fall back when
/// either is present.
fn has_breaking_characters(content: &str) -> bool {
    let mut chars = content.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\r' {
            if chars.peek() != Some(&'\n') {
                return true;
            }
        } else if c.is_whitespace() && !matches!(c, ' ' | '\t' | '\n') {
            return true;
        } else if matches!(
            c,
            '\u{0}'..='\u{8}'
                | '\u{b}'
                | '\u{c}'
                | '\u{e}'..='\u{1f}'
                | '\u{7f}'
                | '\u{80}'..='\u{84}'
                | '\u{86}'..='\u{9f}'
                | '\u{fffe}'
                | '\u{ffff}'
        ) {
            // Non-printable characters (the YAML spec's
            // printable set is tab/LF/CR, #x20–#x7E, #x85,
            // #xA0–#xD7FF, #xE000–#xFFFD and the supplementary
            // planes): the parser rejects them anywhere in the
            // stream, even inside comments, so a document
            // containing one has no full-parse result the fast
            // path could agree with. (U+0085 is in the
            // whitespace family above.)
            return true;
        }
    }
    false
}

/// The entry text after a sequence dash, when `body` is a sequence
/// entry line. The parser accepts a space, a tab, or end-of-line
/// as the separation after `-`, and every scanner check that
/// unwraps an entry must agree on that (a `-\t…` line is a
/// sequence entry, never a mapping line). Returns `None` for
/// non-entry lines, and an empty string for a bare `-`.
fn sequence_entry_body(body: &str) -> Option<&str> {
    if body == "-" {
        return Some("");
    }
    body.strip_prefix("- ").or_else(|| body.strip_prefix("-\t"))
}

/// A sequence entry's content and its offset within the body: the
/// dash plus however much separation follows it (`-   name: a`
/// puts its first key at offset 4, not 2). The frame builders
/// measure the entry's first key at this offset; when the
/// separation contains a tab the parser's column for the content
/// cannot be stated in spaces, which they treat conservatively.
fn sequence_entry_content(body: &str) -> Option<(usize, &str)> {
    let entry = sequence_entry_body(body)?;
    let content = entry.trim_start_matches([' ', '\t']);
    Some((body.len() - content.len(), content))
}

/// Whether an entry body is a mapping entry carrying an inline value
/// (`key: value`), as opposed to one that opens a nested block
/// (`key:`) or carries only a comment (`key: # …`).
fn key_line_has_inline_value(body: &str) -> bool {
    // A sequence entry is not itself a mapping entry; callers unwrap
    // it (see `content_line_frame`) before asking about its first key.
    if sequence_entry_body(body).is_some() {
        return false;
    }
    let Some(colon) = mapping_colon_index(body) else {
        return false;
    };
    let after = body[colon + 1..].trim();
    !after.is_empty() && !after.starts_with('#')
}

/// Whether the flow collection starting at the beginning of `text`
/// closes on the same line and nothing but whitespace or a comment
/// follows the closing bracket (anything else is an error to the
/// parser: the collection is the whole entry or value). Quoted
/// spans are tracked (their braces are content), each closer must
/// match its opener, and a comment start ends the line's meaningful
/// content: braces after it are comment text, so the collection
/// cannot close there.
fn flow_collection_closes_on_line(text: &str) -> bool {
    // A fixed-size stack: flow nesting in real profiles is shallow,
    // and anything deeper is for the full parser anyway. (A heap
    // allocation per checked line would tax the very path this file
    // exists to keep cheap.)
    let mut closers = [0u8; 16];
    let mut depth = 0usize;
    let mut quote: Option<u8> = None;
    let mut prev: Option<u8> = None;
    let mut bytes = text.bytes().enumerate().peekable();
    while let Some((i, b)) = bytes.next() {
        match quote {
            Some(b'"') => {
                if b == b'\\' {
                    bytes.next();
                } else if b == b'"' {
                    quote = None;
                }
            }
            Some(b'\'') => {
                if b == b'\'' {
                    if bytes.peek().is_some_and(|&(_, next)| next == b'\'') {
                        bytes.next();
                    } else {
                        quote = None;
                    }
                }
            }
            _ => {
                if b == b'#' && prev.is_some_and(|p| matches!(p, b' ' | b'\t' | b'{' | b'[' | b','))
                {
                    return false;
                }
                match b {
                    // A quote opens a span only at a token boundary;
                    // an interior one (the apostrophe in `don't`) is
                    // plain-scalar text.
                    b'"' | b'\''
                        if prev.is_none_or(|p| {
                            matches!(p, b' ' | b'\t' | b'{' | b'[' | b',' | b':')
                        }) =>
                    {
                        quote = Some(b);
                    }
                    b'{' | b'[' => {
                        let closer = if b == b'{' { b'}' } else { b']' };
                        match closers.get_mut(depth) {
                            Some(slot) => *slot = closer,
                            None => return false,
                        }
                        depth += 1;
                    }
                    b'}' | b']' => {
                        if closers.get(depth.wrapping_sub(1)) != Some(&b) {
                            return false;
                        }
                        depth -= 1;
                        if depth == 0 {
                            let rest = text[i + 1..].trim();
                            return rest.is_empty() || rest.starts_with('#');
                        }
                    }
                    _ => {}
                }
            }
        }
        prev = Some(b);
    }
    false
}

/// Whether the flow collection starting at the beginning of
/// `text` contains an entry-level error the bracket scan cannot
/// see: an empty entry — two separators with nothing between
/// them, or a separator right after an opener (`{a: b,,}`,
/// `[, 1]`) — or a second separator colon in one entry, which
/// means two mapping pairs were written without the comma
/// between them (`{a: b c: d}`). The parser rejects both, while a
/// trailing separator before the closer (`{a: b,}`) is legal. A
/// colon only counts as a separator colon when followed by
/// separation or a flow end, mirroring `mapping_colon_index`, so
/// colons inside plain scalars (`http://x`) are content. Quote
/// tracking mirrors `flow_collection_closes_on_line`: separators
/// inside quoted spans are content. Only the text up to the
/// matching closer is judged. Alias tokens are validated against
/// `anchors` (and anchor tokens register into it), in document
/// order, exactly as the block-level check in
/// `plain_value_has_mapping_colon` does: an alias naming an anchor
/// not yet seen is malformed wherever it appears.
fn flow_collection_has_invalid_content(
    text: &str,
    anchors: &mut std::collections::HashSet<String>,
) -> bool {
    let mut scan = FlowContentScan {
        at_token_start: true,
        ..FlowContentScan::default()
    };
    let mut quote: Option<u8> = None;
    let mut prev: Option<u8> = None;
    // Raw bytes of the quoted scalar currently being read, fed
    // to the key capture when it closes in key position.
    let mut quoted: Vec<u8> = Vec::new();
    let mut bytes = text.bytes().peekable();
    while let Some(b) = bytes.next() {
        match quote {
            Some(b'"') => {
                if b == b'\\' {
                    quoted.push(b);
                    if let Some(escaped) = bytes.next() {
                        quoted.push(escaped);
                    }
                } else if b == b'"' {
                    quote = None;
                    // A quoted key written with escapes cannot be
                    // compared raw (see `KeyIdentity`).
                    if scan.in_key_position() && quoted.contains(&b'\\') {
                        return true;
                    }
                    scan.capture_bytes(&quoted);
                    scan.just_completed_node = true;
                } else {
                    quoted.push(b);
                }
            }
            Some(b'\'') => {
                if b == b'\'' {
                    if bytes.peek().is_some_and(|&next| next == b'\'') {
                        quoted.push(b);
                        bytes.next();
                        quoted.push(b'\'');
                    } else {
                        quote = None;
                        if scan.in_key_position() && quoted.windows(2).any(|pair| pair == b"''") {
                            return true;
                        }
                        scan.capture_bytes(&quoted);
                        scan.just_completed_node = true;
                    }
                } else {
                    quoted.push(b);
                }
            }
            _ => {
                if b == b'#' && prev.is_some_and(|p| matches!(p, b' ' | b'\t' | b'{' | b'[' | b','))
                {
                    return false;
                }
                // An anchor or alias token at a token start is
                // read whole: aliases must name an anchor seen so
                // far (in document order, as the parser requires),
                // and anchors register their name for later lines
                // as well as later entries in this collection.
                if (b == b'*' || b == b'&') && scan.at_token_start {
                    // An alias in key position resolves to the
                    // anchored node, not to its anchor name, so
                    // its key identity is not the name: leave it
                    // to the full parser.
                    if b == b'*' && scan.in_key_position() {
                        return true;
                    }
                    let mut name_bytes = Vec::new();
                    let mut last = b;
                    while let Some(&next) = bytes.peek() {
                        if matches!(next, b' ' | b'\t' | b',' | b'}' | b']' | b'{' | b'[') {
                            break;
                        }
                        name_bytes.push(next);
                        last = next;
                        bytes.next();
                    }
                    // An alias is itself the node, so its name is
                    // key text when in key position; an anchor
                    // only prefixes the node that follows and is
                    // not part of the key.
                    if b == b'*' {
                        scan.capture_bytes(&name_bytes);
                    }
                    // The delimiters are all ASCII, so the name
                    // is a whole UTF-8 slice of the input.
                    let name = String::from_utf8(name_bytes).unwrap_or_default();
                    if name.is_empty() {
                        return true;
                    }
                    if b == b'*' {
                        if !anchors.contains(&name) {
                            return true;
                        }
                    } else {
                        anchors.insert(name);
                    }
                    if scan.content_byte() == FlowStep::Invalid {
                        return true;
                    }
                    if b == b'*' {
                        // An alias is a complete node: content
                        // following it without a separator is a
                        // second node in the same entry.
                        scan.just_completed_node = true;
                    } else {
                        // An anchor only prefixes the node that
                        // follows it, whose token has not started
                        // yet — an alias after an anchor
                        // (`[&b *a]`) is still read as an alias.
                        scan.at_token_start = true;
                    }
                    prev = Some(last);
                    continue;
                }
                match scan.step(b, bytes.peek().copied(), prev) {
                    FlowStep::Invalid => return true,
                    FlowStep::Done => return false,
                    FlowStep::OpenQuote => {
                        quote = Some(b);
                        quoted.clear();
                    }
                    FlowStep::Continue => {}
                }
            }
        }
        prev = Some(b);
    }
    false
}

/// The outcome of feeding one byte to `FlowContentScan`.
#[derive(PartialEq)]
enum FlowStep {
    Continue,
    /// The byte proves the collection invalid.
    Invalid,
    /// The scan is finished and nothing invalid was found (the
    /// collection closed, or nesting exceeded the stack budget).
    Done,
    /// The byte opens a quoted span the driver must track.
    OpenQuote,
}

/// Entry-level state for `flow_collection_has_invalid_content`,
/// on the same fixed stack budget as
/// `flow_collection_closes_on_line`. Per depth: whether an entry
/// is expected (nothing seen since the opener or the last comma),
/// whether the current entry already has its separator colon, and
/// whether a node has begun in the current part of the entry.
/// `at_token_start` tracks whether the next content byte opens a
/// new token (after an opener, a comma, or a colon) — the
/// reserved indicators `@` and the backtick are rejected there,
/// though legal inside a plain scalar (`x@y`).
/// `just_completed_node` records that the previous completed
/// token was a quoted scalar or a nested collection: another node
/// beginning before a separator is two nodes in one entry, which
/// the parser rejects (`{a: "x" "y"}`, `[{} {}]`).
#[derive(Default)]
struct FlowContentScan {
    expecting: [bool; 16],
    colon_seen: [bool; 16],
    node_begun: [bool; 16],
    is_mapping: [bool; 16],
    /// Raw bytes of the key currently being read at each depth,
    /// and the keys already completed there: the parser rejects
    /// a repeated key inside one flow mapping, so the scan
    /// captures each entry's key (plain bytes as they stream by,
    /// quoted and alias/anchor tokens via the driver) and
    /// compares it when the entry's separator colon lands.
    key_text: [Vec<u8>; 16],
    seen_keys: [std::collections::HashSet<Vec<u8>>; 16],
    depth: usize,
    at_token_start: bool,
    just_completed_node: bool,
}

impl FlowContentScan {
    fn expecting(&self) -> bool {
        self.expecting.get(self.depth).copied().unwrap_or(false)
    }

    fn is_mapping(&self) -> bool {
        self.is_mapping.get(self.depth).copied().unwrap_or(false)
    }

    /// Whether the scan is currently reading a mapping key at
    /// the current depth (inside a flow mapping, before its
    /// separator colon).
    fn in_key_position(&self) -> bool {
        self.depth >= 1 && self.is_mapping() && !self.colon_seen()
    }

    /// Appends bytes to the current key capture, when in key
    /// position; a no-op for values and sequence entries.
    fn capture_bytes(&mut self, bytes: &[u8]) {
        if self.in_key_position() {
            if let Some(text) = self.key_text.get_mut(self.depth) {
                text.extend_from_slice(bytes);
            }
        }
    }

    fn colon_seen(&self) -> bool {
        self.colon_seen.get(self.depth).copied().unwrap_or(false)
    }

    fn node_begun(&self) -> bool {
        self.node_begun.get(self.depth).copied().unwrap_or(false)
    }

    fn set_expecting(&mut self, value: bool) {
        if let Some(flag) = self.expecting.get_mut(self.depth) {
            *flag = value;
        }
    }

    fn set_colon_seen(&mut self, value: bool) {
        if let Some(flag) = self.colon_seen.get_mut(self.depth) {
            *flag = value;
        }
    }

    fn set_node_begun(&mut self, value: bool) {
        if let Some(flag) = self.node_begun.get_mut(self.depth) {
            *flag = value;
        }
    }

    fn step(&mut self, b: u8, next: Option<u8>, prev: Option<u8>) -> FlowStep {
        match b {
            b'"' | b'\''
                if prev.is_none_or(|p| matches!(p, b' ' | b'\t' | b'{' | b'[' | b',' | b':')) =>
            {
                if self.just_completed_node || self.node_begun() {
                    return FlowStep::Invalid;
                }
                self.set_expecting(false);
                self.set_node_begun(true);
                self.at_token_start = false;
                FlowStep::OpenQuote
            }
            b'{' | b'[' => self.open_collection(b),
            b'}' | b']' => self.close_collection(),
            b',' => self.comma(),
            b':' => self.colon(next),
            // Reserved indicators, and block-scalar indicators
            // (block scalars cannot appear in flow context),
            // where a node begins: all malformed there, though
            // legal inside a plain scalar (`a|b`).
            b'@' | b'`' | b'%' | b'|' | b'>' if self.at_token_start => FlowStep::Invalid,
            // A tag on a flow key makes the key's identity a
            // matter of decoding (the tagged node is the key);
            // leave tagged keys to the full parser.
            b'!' if self.at_token_start && self.in_key_position() => FlowStep::Invalid,
            // An explicit-key indicator at a token start opens the
            // key; it is not itself a node, so it sets no flag (and
            // the key token still follows, so `at_token_start`
            // stands).
            b'?' if self.at_token_start => FlowStep::Continue,
            b' ' | b'\t' => FlowStep::Continue,
            _ => {
                self.capture_bytes(&[b]);
                self.content_byte()
            }
        }
    }

    fn open_collection(&mut self, opener: u8) -> FlowStep {
        if self.just_completed_node || self.node_begun() {
            return FlowStep::Invalid;
        }
        // A collection opening in key position is part of the
        // key being read.
        self.capture_bytes(&[opener]);
        self.set_node_begun(true);
        self.depth += 1;
        if self.expecting.get_mut(self.depth).is_none() {
            // Nesting beyond the stack budget is for the full
            // parser (the caller falls back either way).
            return FlowStep::Done;
        }
        self.set_expecting(true);
        self.set_colon_seen(false);
        self.set_node_begun(false);
        if let Some(slot) = self.is_mapping.get_mut(self.depth) {
            *slot = opener == b'{';
        }
        if let Some(text) = self.key_text.get_mut(self.depth) {
            text.clear();
        }
        if let Some(keys) = self.seen_keys.get_mut(self.depth) {
            keys.clear();
        }
        self.at_token_start = true;
        FlowStep::Continue
    }

    fn close_collection(&mut self) -> FlowStep {
        self.depth = self.depth.saturating_sub(1);
        if self.depth == 0 {
            return FlowStep::Done;
        }
        self.set_expecting(false);
        // The closed collection is a completed node of the level
        // it closes into.
        self.set_node_begun(true);
        self.just_completed_node = true;
        self.at_token_start = false;
        FlowStep::Continue
    }

    fn comma(&mut self) -> FlowStep {
        self.just_completed_node = false;
        if self.expecting() {
            return FlowStep::Invalid;
        }
        self.set_expecting(true);
        self.set_colon_seen(false);
        self.set_node_begun(false);
        if let Some(text) = self.key_text.get_mut(self.depth) {
            text.clear();
        }
        self.at_token_start = true;
        FlowStep::Continue
    }

    fn colon(&mut self, next: Option<u8>) -> FlowStep {
        self.just_completed_node = false;
        // A colon only counts as a separator colon when followed
        // by separation or a flow end; otherwise it is plain
        // scalar content (`http://x`).
        if next.is_none_or(|n| matches!(n, b' ' | b'\t' | b',' | b'}' | b']')) {
            if self.colon_seen() {
                return FlowStep::Invalid;
            }
            self.set_colon_seen(true);
            if self.is_mapping() {
                // The entry's key is complete: a repeat within
                // this collection is a duplicate key.
                let key = self
                    .key_text
                    .get_mut(self.depth)
                    .map(std::mem::take)
                    .unwrap_or_default();
                let start = key
                    .iter()
                    .position(|b| *b != b' ' && *b != b'\t')
                    .unwrap_or(key.len());
                let end = key
                    .iter()
                    .rposition(|b| *b != b' ' && *b != b'\t')
                    .map_or(start, |i| i + 1);
                let trimmed_key = key.get(start..end).unwrap_or(&[]).to_vec();
                // A key the parser types as a non-string can be
                // spelled several ways (`true`/`TRUE`, `1`/`+1`)
                // that raw comparison treats as distinct (see
                // `KeyIdentity::Undecidable`); the capture does
                // not record whether the key was quoted, so this
                // costs a fallback for quoted spellings too.
                if let Ok(text) = std::str::from_utf8(&trimmed_key) {
                    if !text.is_empty() && !yaml_unquoted_scalar_is_string(text) {
                        return FlowStep::Invalid;
                    }
                }
                if let Some(keys) = self.seen_keys.get_mut(self.depth) {
                    if !keys.insert(trimmed_key) {
                        return FlowStep::Invalid;
                    }
                }
            }
            // The value part of the entry begins.
            self.set_node_begun(false);
        }
        self.set_expecting(false);
        self.at_token_start = true;
        FlowStep::Continue
    }

    fn content_byte(&mut self) -> FlowStep {
        if self.just_completed_node {
            return FlowStep::Invalid;
        }
        self.set_expecting(false);
        self.set_node_begun(true);
        self.at_token_start = false;
        FlowStep::Continue
    }
}

/// Whether a line body that opens with a quoted scalar is shaped
/// like a mapping key: the closing quote must be followed (after
/// spaces) by the separator colon. Anything else after the quote
/// (`"other" x: y`) makes the line a quoted scalar followed by
/// junk — the parser rejects it, while a colon inside the junk
/// would otherwise make the line look like an ordinary entry.
/// A quote that never closes is likewise for the full parser.
/// Lines not opening with a quote, and quoted scalars standing
/// alone (nothing after the quote, or only a comment), are left
/// to the other checks.
fn quoted_key_shape_forces_fallback(body: &str) -> bool {
    let entry = sequence_entry_body(body).unwrap_or(body);
    let content = entry.trim_start_matches([' ', '\t']);
    let Some(&first) = content.as_bytes().first() else {
        return false;
    };
    if first != b'"' && first != b'\'' {
        return false;
    }
    let mut bytes = content.bytes().enumerate().peekable();
    bytes.next();
    let close = loop {
        let Some((i, b)) = bytes.next() else {
            return true;
        };
        if first == b'"' && b == b'\\' {
            bytes.next();
            continue;
        }
        if b == first {
            if first == b'\'' && bytes.peek().is_some_and(|&(_, next)| next == b'\'') {
                bytes.next();
                continue;
            }
            break i;
        }
    };
    let rest = content[close + 1..].trim_start_matches([' ', '\t']);
    !rest.is_empty() && !rest.starts_with(':') && !rest.starts_with('#')
}

/// Whether a value that opens with a quote forces a fallback:
/// either non-comment junk follows the closing quote on the same
/// line (`key: "a" b: c`, which the parser rejects), or the quote
/// never closes on the line — the value then continues on following
/// lines, and a continuation can sit at column 0 disguised as a key
/// line (`foo: "start` / `secret: real` / `a: b"` parses with the
/// `secret:` line INSIDE the quoted scalar), which no other scanner
/// rule can tell apart from a real key.
fn quoted_value_forces_fallback(value: &str) -> bool {
    let mut bytes = value.bytes().enumerate().peekable();
    let Some((_, quote)) = bytes.next() else {
        return false;
    };
    while let Some((i, b)) = bytes.next() {
        if quote == b'"' && b == b'\\' {
            bytes.next();
            continue;
        }
        if b == quote {
            if quote == b'\'' && bytes.peek().is_some_and(|&(_, next)| next == b'\'') {
                bytes.next();
                continue;
            }
            let rest = value[i + 1..].trim();
            return !rest.is_empty() && !rest.starts_with('#');
        }
    }
    // The quote never closes on this line.
    true
}

/// Whether a block scalar header (`|`, `>`, with optional chomping
/// and indentation indicators) has anything after it but a comment:
/// `mode: |x` is an error to the parser, unlike `mode: |- # c`.
fn block_scalar_header_has_junk(value: &str) -> bool {
    let mut seen_chomping = false;
    let mut seen_indent = false;
    let mut rest = "";
    for (i, b) in value.bytes().enumerate().skip(1) {
        match b {
            b'+' | b'-' if !seen_chomping => seen_chomping = true,
            b'1'..=b'9' if !seen_indent => seen_indent = true,
            _ => {
                rest = value.get(i..).unwrap_or("");
                break;
            }
        }
    }
    let tail = rest.trim();
    !tail.is_empty() && !tail.starts_with('#')
}

/// Whether an entry body's value is a plain scalar that itself
/// contains a mapping colon (`key: true x: y`), or a flow collection
/// that does not close on the same line. Plain scalars may never
/// contain a colon followed by separation (a space or a tab) or end
/// with one, so the full parser rejects such documents; an
/// unclosed flow collection instead runs onto the following lines,
/// which the scanners would misread as new entries. Either way the
/// scanners must not skip the line and read on. Quoted and
/// block-style values are exempt (their contents follow other
/// rules), as is anything past a ` #` comment start, and so is a
/// flow collection that closes on the same line (its colons are
/// flow syntax, not mapping separators).
fn plain_value_has_mapping_colon(
    body: &str,
    anchors: &mut std::collections::HashSet<String>,
) -> bool {
    let entry = sequence_entry_body(body).unwrap_or(body);
    if entry.starts_with('{') || entry.starts_with('[') {
        return !flow_collection_closes_on_line(entry)
            || flow_collection_has_invalid_content(entry, anchors);
    }
    let Some(colon) = mapping_colon_index(entry) else {
        return false;
    };
    let raw_value = entry[colon + 1..].trim_start();
    if raw_value.is_empty() {
        return false;
    }
    // Anchors and tags precede the actual value; judge what follows
    // them instead. Anchor names are recorded in `anchors` (in
    // document order, matching the parser, which also rejects
    // forward references). An alias is a complete value by itself:
    // an alias naming an anchor not yet seen is malformed, and
    // anything but a comment after a defined alias is junk. A bare
    // anchor or tag means the value itself sits on a later line
    // (nothing to judge here).
    let mut effective = raw_value;
    loop {
        if let Some(alias) = effective.strip_prefix('*') {
            let name = alias.split([' ', '\t']).next().unwrap_or("");
            if !anchors.contains(name) {
                return true;
            }
            let rest = effective
                .split_once([' ', '\t'])
                .map_or("", |(_, r)| r)
                .trim();
            return !rest.is_empty() && !rest.starts_with('#');
        }
        if !effective.starts_with('&') && !effective.starts_with('!') {
            break;
        }
        if effective.starts_with('&') {
            let token = effective.split([' ', '\t']).next().unwrap_or("");
            // A lone `&` has no anchor name at all; the parser
            // rejects it rather than treating it as a bare anchor
            // whose value sits on a later line.
            if token.len() < 2 {
                return true;
            }
            anchors.insert(token[1..].to_owned());
        }
        match effective.split_once([' ', '\t']) {
            Some((_, rest)) => effective = rest.trim_start(),
            None => return false,
        }
        if effective.is_empty() {
            return false;
        }
    }
    let value = effective;
    if value.starts_with('{') || value.starts_with('[') {
        return !flow_collection_closes_on_line(value)
            || flow_collection_has_invalid_content(value, anchors);
    }
    if value.starts_with('"') || value.starts_with('\'') {
        return quoted_value_forces_fallback(value);
    }
    if value.starts_with('|') || value.starts_with('>') {
        return block_scalar_header_has_junk(value);
    }
    // A value opening with a character that cannot start a token is
    // rejected by the parser (see `starts_with_reserved_indicator`).
    if starts_with_reserved_indicator(value) {
        return true;
    }
    // A block-structure indicator cannot open an inline value
    // either: `- x` or `? x` after a mapping colon is a block entry
    // in a place the grammar forbids, and the parser rejects the
    // document ("block sequence entries are not allowed in this
    // context").
    if value == "-"
        || value == "?"
        || value.starts_with("- ")
        || value.starts_with("-\t")
        || value.starts_with("? ")
        || value.starts_with("?\t")
    {
        return true;
    }
    let before_comment = value
        .split_once(" #")
        .map_or(value, |(head, _)| head)
        .trim_end();
    before_comment.contains(": ") || before_comment.contains(":\t") || before_comment.ends_with(':')
}

/// Whether a content line's body (leading indentation removed)
/// starts with a node property (`&anchor`, `!tag`) or an alias
/// (`*alias`), including after a `- ` sequence marker. A property
/// before a key applies to that key — `&a tun:` IS the key `tun` to
/// the parser — while the line scanners match keys literally, so
/// any such line is for the full parser. (A leading `&`, `!`, or
/// `*` is always structural in YAML, never a plain scalar's first
/// character, so this never fires on ordinary values.)
fn starts_with_node_property(body: &str) -> bool {
    let entry = sequence_entry_body(body).unwrap_or(body);
    entry.starts_with(['&', '!', '*'])
}

/// What a column-0 content line is, for the root-kind tracking in
/// the scanners: the document root is exactly one of these, and a
/// line of another kind after it is malformed (the parser rejects
/// the document).
#[derive(Clone, Copy, PartialEq)]
enum RootLineKind {
    Scalar,
    Mapping,
    Sequence,
}

fn root_line_kind(line: &str) -> RootLineKind {
    if sequence_entry_body(line).is_some() {
        RootLineKind::Sequence
    } else if line.starts_with('{') || line.starts_with('[') {
        // A flow collection at the root is a scalar root for this
        // tracking, whatever colons it contains.
        RootLineKind::Scalar
    } else if mapping_colon_index(line).is_some() {
        RootLineKind::Mapping
    } else {
        RootLineKind::Scalar
    }
}

/// Tracks the document root's block kind across the column-0 lines
/// of a document. Column-0 sequence entries are not by themselves a
/// root sequence: they are the (indentless) value of the mapping
/// key above them whenever that key carries no inline value. They
/// make the root a sequence only when they come before any mapping
/// key — and from then on a mapping key is malformed, as is a
/// sequence entry after a scalar-valued key, or after a key that
/// already received an indented block value (see
/// `note_indented_content`).
#[derive(Default)]
struct RootKindTracker {
    kind: Option<RootLineKind>,
    last_key_had_inline_value: bool,
    key_has_block_content: bool,
    sequence_started: bool,
}

impl RootKindTracker {
    /// Records one column-0 content line; returns `false` when the
    /// line proves the document malformed.
    fn observe(&mut self, line: &str) -> bool {
        let kind = root_line_kind(line);
        match self.kind {
            None => {
                self.kind = Some(kind);
                self.last_key_had_inline_value = key_line_has_inline_value(line);
                true
            }
            Some(RootLineKind::Sequence) => kind == RootLineKind::Sequence,
            Some(RootLineKind::Scalar) => kind == RootLineKind::Scalar,
            Some(RootLineKind::Mapping) => match kind {
                RootLineKind::Mapping => {
                    self.last_key_had_inline_value = key_line_has_inline_value(line);
                    self.key_has_block_content = false;
                    self.sequence_started = false;
                    true
                }
                RootLineKind::Sequence => {
                    if self.last_key_had_inline_value
                        || (self.key_has_block_content && !self.sequence_started)
                    {
                        return false;
                    }
                    self.sequence_started = true;
                    true
                }
                RootLineKind::Scalar => false,
            },
        }
    }

    /// Notes an indented content line under the current key: the key
    /// now has a block value, so a column-0 sequence entry can no
    /// longer be its (indentless) sequence value.
    const fn note_indented_content(&mut self) {
        self.key_has_block_content = true;
    }
}

/// One indentation level in `BlockKindTracker`: whether mapping
/// entries have been seen at this level, and the state of the most
/// recent mapping key (the same per-key state `RootKindTracker`
/// keeps for the root, one level down).
struct BlockFrame<'a> {
    indent: usize,
    has_mapping: bool,
    last_key_had_inline_value: bool,
    key_has_block_content: bool,
    in_indentless_sequence: bool,
    /// Identities of the mapping keys already seen at this
    /// level: the parser rejects a repeated key anywhere in a
    /// mapping, not just the one a scanner is extracting, so a
    /// repeat at any tracked level falls back.
    /// Borrowed string slices avoid per-key heap allocations during block scanning.
    keys: std::collections::HashSet<&'a str>,
}

/// Tracks the block kinds of sibling lines while scanning inside
/// blocks. Within one block, a sequence may only appear at a
/// mapping level as the (indentless) value of the key above it —
/// and only when that key carries no inline value and has not
/// already received nested block content; any other mixing of
/// mapping entries and sequence entries at one indentation is
/// malformed (the parser rejects the document). Deeper blocks
/// stack on top; a column-0 line resets the stack, since a new
/// top-level key starts a fresh context whose nested blocks may
/// use either kind.
#[derive(Default)]
struct BlockKindTracker<'a> {
    stack: Vec<BlockFrame<'a>>,
}

impl<'a> BlockKindTracker<'a> {
    fn reset(&mut self) {
        self.stack.clear();
    }

    /// Resets the stack for a new top-level line and records a
    /// sequence entry's first key on it (see
    /// `note_sequence_entry`).
    fn reset_and_note(&mut self, line: &'a str) -> bool {
        self.reset();
        self.note_sequence_entry(line)
    }

    /// Records one content line; returns `false` when the line
    /// mixes kinds with its siblings. A sequence entry whose first
    /// key is a mapping entry (`- name: a`) also opens that key's
    /// mapping level two columns past the dash (see
    /// `note_sequence_entry`), so a later dash at that column is
    /// judged against the key's state rather than slipping through
    /// as a fresh sequence level.
    fn observe(&mut self, line: &'a str) -> bool {
        if !self.observe_kind(line) {
            return false;
        }
        self.note_sequence_entry(line)
    }

    /// Pushes the mapping level a sequence entry's first key sits
    /// at (dash column + 2) when the entry is a mapping entry. The
    /// frame carries whether that key has an inline value: a dash
    /// line at the key's column after an inline-valued key is
    /// malformed (the parser expects another key there), while
    /// after a value-less key it is the key's indentless sequence.
    /// Flow entries and nested sequence entries open no such level.
    /// Returns `false` when the entry's first key is quoted
    /// with escapes (see `KeyIdentity::Undecidable`).
    fn note_sequence_entry(&mut self, line: &'a str) -> bool {
        let indent = line.len() - line.trim_start().len();
        let body = line.trim_start();
        let Some((offset, content)) = sequence_entry_content(body) else {
            return true;
        };
        // A tab in the separation leaves the key's column
        // unstated; the kind checks still guard the line itself.
        if body[..offset].contains('\t') {
            return true;
        }
        if content.starts_with(['{', '[']) || sequence_entry_body(content).is_some() {
            return true;
        }
        if mapping_colon_index(content).is_none() {
            return true;
        }
        let mut keys = std::collections::HashSet::new();
        match mapping_key_identity(content) {
            Some(KeyIdentity::Key(identity)) => {
                keys.insert(identity);
            }
            Some(KeyIdentity::Undecidable) => return false,
            None => {}
        }
        let frame_indent = indent + offset;
        while self
            .stack
            .last()
            .is_some_and(|top| top.indent >= frame_indent)
        {
            self.stack.pop();
        }
        self.stack.push(BlockFrame {
            indent: frame_indent,
            has_mapping: true,
            last_key_had_inline_value: key_line_has_inline_value(content),
            key_has_block_content: false,
            in_indentless_sequence: false,
            keys,
        });
        true
    }

    fn observe_kind(&mut self, line: &'a str) -> bool {
        let indent = line.len() - line.trim_start().len();
        let body = line.trim_start();
        let is_sequence = sequence_entry_body(body).is_some();
        let mut popped = false;
        while self.stack.last().is_some_and(|top| top.indent > indent) {
            self.stack.pop();
            popped = true;
        }
        if self.stack.last().is_none_or(|top| top.indent < indent) {
            // A line that dedents past every open level lands on an
            // indentation no block uses, and a second descent from a
            // key that already received block content would give
            // that key a second, differently-indented block; the
            // parser rejects both shapes.
            if popped && self.stack.is_empty() {
                return false;
            }
            if self
                .stack
                .last()
                .is_some_and(|top| top.key_has_block_content)
            {
                return false;
            }
            // A deeper line opens a new level; the level it descends
            // from receives block content for its current key.
            if let Some(top) = self.stack.last_mut() {
                top.key_has_block_content = true;
            }
            // A level created by a sequence entry is a pure
            // sequence level (`has_mapping` stays false, which the
            // same-indent handling below reads as such).
            let mut frame = BlockFrame {
                indent,
                has_mapping: false,
                last_key_had_inline_value: false,
                key_has_block_content: false,
                in_indentless_sequence: false,
                keys: std::collections::HashSet::new(),
            };
            if !is_sequence {
                frame.has_mapping = true;
                frame.last_key_had_inline_value = key_line_has_inline_value(body);
                match mapping_key_identity(body) {
                    Some(KeyIdentity::Key(identity)) => {
                        frame.keys.insert(identity);
                    }
                    Some(KeyIdentity::Undecidable) => return false,
                    None => {}
                }
            }
            self.stack.push(frame);
            return true;
        }
        let Some(top) = self.stack.last_mut() else {
            return false;
        };
        if is_sequence {
            if top.in_indentless_sequence || !top.has_mapping {
                return true;
            }
            if top.last_key_had_inline_value || top.key_has_block_content {
                return false;
            }
            top.in_indentless_sequence = true;
            return true;
        }
        // A mapping entry line: malformed in a pure sequence level,
        // otherwise it closes any indentless sequence and becomes
        // the level's current key.
        if !top.has_mapping {
            return false;
        }
        match mapping_key_identity(body) {
            Some(KeyIdentity::Key(identity)) => {
                if !top.keys.insert(identity) {
                    return false;
                }
            }
            Some(KeyIdentity::Undecidable) => return false,
            None => {}
        }
        top.in_indentless_sequence = false;
        top.last_key_had_inline_value = key_line_has_inline_value(body);
        top.key_has_block_content = false;
        true
    }
}

/// Whether a content line's body (leading indentation removed) is
/// a bare plain scalar: no mapping colon, not a sequence entry, not
/// a flow collection or block scalar header, not quoted.
fn is_bare_scalar_line(body: &str) -> bool {
    sequence_entry_body(body).is_none()
        && !body.starts_with(['{', '[', '|', '>', '"', '\''])
        && mapping_colon_index(body).is_none()
}

/// Whether a content line's body is a standalone value rather than
/// a mapping entry: not a sequence entry, and either a flow
/// collection or a line with no visible mapping colon (a plain or
/// quoted scalar standing alone, a block scalar header). Such a
/// line begins (or continues) a value whose extent the line
/// scanners cannot judge — an entry line at the same indentation
/// after it is an error to the parser, while a deeper line may be a
/// legal continuation — so the scanners fall back whenever an
/// indented standalone-value line appears.
fn is_standalone_value_line(body: &str) -> bool {
    sequence_entry_body(body).is_none()
        && (body.starts_with('{') || body.starts_with('[') || mapping_colon_index(body).is_none())
}

/// Whether a body (an entry body, or a value within one) starts
/// with a character that cannot start a YAML token in that position
/// (`@` and the backtick are reserved indicators; `%`, `,`, `]`,
/// `}` cannot open a plain scalar either). Such a line or value
/// makes the document unparseable, wherever it appears.
fn starts_with_reserved_indicator(body: &str) -> bool {
    let entry = sequence_entry_body(body).unwrap_or(body);
    // Extra spaces after the dash are separation, not content:
    // `-  @abc` still opens with the reserved indicator.
    let content = entry.trim_start_matches([' ', '\t']);
    content.starts_with(['@', '`', '%', ',', ']', '}'])
}

/// Whether a sequence entry's own content forces a fallback. The
/// line-level checks cannot see either shape: an explicit key
/// (`- ? …`) hides its `?` behind the dash, and a flow collection
/// that does not close on the line may carry no mapping colon to
/// judge (the entry itself, or an explicit key's value). Complete
/// flow entries are fine — they close on the line.
fn sequence_entry_forces_fallback(
    body: &str,
    anchors: &mut std::collections::HashSet<String>,
) -> bool {
    let Some(entry) = sequence_entry_body(body) else {
        return false;
    };
    let content = entry.trim_start_matches([' ', '\t']);
    if content == "?" || content.starts_with("? ") {
        return true;
    }
    (content.starts_with('{') || content.starts_with('['))
        && (!flow_collection_closes_on_line(content)
            || flow_collection_has_invalid_content(content, anchors))
}

/// The frame one content line establishes for the depth tracking in
/// the scanners: the indentation its mapping key effectively sits
/// at, and whether that key carries an inline value. Sequence
/// entries are unwrapped — their first key sits at the entry
/// content's own column (see `sequence_entry_content`), which is
/// also where the entry's own content lines sit, so ordinary
/// sequence content does not look "deeper" than the key.
fn content_line_frame(line: &str) -> (usize, bool) {
    let indent = line.len() - line.trim_start().len();
    let body = line.trim_start();
    if let Some((offset, content)) = sequence_entry_content(body) {
        // An empty entry (`- ` with nothing after it) is an item
        // still awaiting its value: the entry's content sits on the
        // following lines, so frame it like a bare `-`.
        if content.is_empty() {
            return (indent, false);
        }
        // A tab in the separation leaves the content's column
        // unstated; frame the entry as a finished value on the
        // dash line, so deeper following lines fall back.
        if body[..offset].contains('\t') {
            return (indent, true);
        }
        // A flow entry is a self-contained value on the dash line
        // itself: frame it at the dash's indentation, so that any
        // deeper following line falls back (it cannot be content of
        // the entry the way a block entry's lines can).
        if content.starts_with('{') || content.starts_with('[') {
            return (indent, true);
        }
        // A bare-scalar entry frames the same way: a deeper line
        // after it may be a legal continuation of the scalar, but it
        // may also be an entry the parser rejects, and the scanner
        // cannot tell the two apart.
        if is_bare_scalar_line(content) {
            return (indent, true);
        }
        // A complete quoted-scalar entry is likewise a finished
        // value on the dash line. (A quoted entry WITH a mapping
        // colon is a mapping entry, not a scalar: the junk check
        // inside `quoted_value_forces_fallback` tells them apart,
        // since the text after the closing quote is then `: …`.)
        if (content.starts_with('"') || content.starts_with('\''))
            && !quoted_value_forces_fallback(content)
        {
            return (indent, true);
        }
        (indent + offset, key_line_has_inline_value(content))
    } else {
        (indent, key_line_has_inline_value(body))
    }
}

/// Judges one indented line for the scalar scanner below, updating
/// the frame state in `last_content`. Returns `true` when the line
/// forces a fallback to the full parser.
fn indented_line_forces_fallback<'a>(
    line: &'a str,
    saw_unindented_line: bool,
    last_content: &mut Option<(usize, bool)>,
    block_tracker: &mut BlockKindTracker<'a>,
    anchors: &mut std::collections::HashSet<String>,
) -> bool {
    let indent = line.len() - line.trim_start().len();
    let trimmed_start = line.trim_start();
    // An indented explicit mapping key (same rule as the unindented
    // check in the caller).
    if trimmed_start.starts_with('?') {
        return true;
    }
    // A comment line whose indentation OPENS with a tab is rejected
    // by the parser (a tab cannot start indentation, even for a
    // comment); a space first and then a tab is accepted. Judge it
    // before the comment early return below.
    if line.starts_with('\t') && trimmed_start.starts_with('#') {
        return true;
    }
    if trimmed_start.is_empty() || trimmed_start.starts_with('#') {
        return false;
    }
    // A standalone value line begins (or continues) a value whose
    // extent this helper cannot judge (see `is_standalone_value_line`).
    if is_standalone_value_line(trimmed_start) {
        return true;
    }
    // A node property or alias can carry the line's key (see
    // `starts_with_node_property`), and a reserved indicator cannot
    // start a token at all.
    if starts_with_node_property(trimmed_start) || starts_with_reserved_indicator(trimmed_start) {
        return true;
    }
    // A sequence entry can hide an explicit key or an unclosed flow
    // collection behind its dash (see
    // `sequence_entry_forces_fallback`).
    if sequence_entry_forces_fallback(trimmed_start, anchors) {
        return true;
    }
    // A quoted scalar at the key position must be followed by the
    // separator colon, not by junk (see
    // `quoted_key_shape_forces_fallback`).
    if quoted_key_shape_forces_fallback(trimmed_start) {
        return true;
    }
    // A tab anywhere in the indentation prefix is never legal YAML
    // indentation; content ahead of the first top-level key means the
    // root block itself is indented, a frame the caller cannot judge;
    // a line deeper than an inline-valued previous line is the
    // ambiguous shape described at `last_content`; and a plain value
    // containing its own mapping colon is rejected by the parser
    // outright. All four are for the full parser to decide.
    if line[..indent].contains('\t')
        || !saw_unindented_line
        || matches!(*last_content, Some((prev_indent, true)) if indent > prev_indent)
        || plain_value_has_mapping_colon(trimmed_start, anchors)
    {
        return true;
    }
    // Sibling lines within one block are all of one kind (see
    // `BlockKindTracker`).
    if !block_tracker.observe(line) {
        return true;
    }
    *last_content = Some(content_line_frame(line));
    false
}

/// The fallback checks a column-0 content line must pass in the
/// scalar scanner below before its key is read: a bare plain-scalar
/// line (the root is a scalar or the document is malformed), a node
/// property or alias carrying the key, a plain value containing its
/// own mapping colon, or a root-kind switch (see `RootKindTracker`,
/// whose state this updates). Returns `true` when the line forces a
/// fallback to the full parser.
fn unindented_line_forces_fallback<'a>(
    line: &'a str,
    root_tracker: &mut RootKindTracker,
    anchors: &mut std::collections::HashSet<String>,
    seen_keys: &mut std::collections::HashSet<&'a str>,
) -> bool {
    is_standalone_value_line(line)
        || starts_with_node_property(line)
        || starts_with_reserved_indicator(line)
        || sequence_entry_forces_fallback(line, anchors)
        || quoted_key_shape_forces_fallback(line)
        || plain_value_has_mapping_colon(line, anchors)
        || !root_tracker.observe(line)
        || note_top_level_key(line, seen_keys)
}

/// Fast-path extraction for simple top-level scalar YAML values (`key: value`).
///
/// Avoids parsing the full YAML AST (which can take tens of milliseconds for large
/// subscription configs) by performing line scanning for unindented scalar key definitions.
/// Falls back to `serde_yaml::from_str` if complex YAML features (directives, tags,
/// anchors, aliases, multiline block scalars) or ambiguous structures are present.
fn extract_top_level_scalar_fast<'a>(content: &'a str, key: &str) -> Option<&'a str> {
    if !content.contains(key) {
        return None;
    }
    if content.contains("<<") || content.contains("%YAML") {
        return None;
    }
    // A leading BOM hides the first line's key from the scanner
    // (trim does not remove it) while the full parser strips it,
    // and Unicode whitespace is content to the parser but
    // whitespace to `trim` (see `has_breaking_characters`); fall
    // back for both, as the TUN scanner below does.
    if content.starts_with('\u{FEFF}') || has_breaking_characters(content) {
        return None;
    }

    let mut result = None;
    let mut matched = false;
    let mut saw_unindented_line = false;
    let mut root_tracker = RootKindTracker::default();
    let mut block_tracker = BlockKindTracker::default();
    // Anchor names seen so far, for the alias check in
    // `plain_value_has_mapping_colon`.
    let mut anchors = std::collections::HashSet::new();
    // Identities of the top-level keys seen so far: the parser
    // rejects a repeated key anywhere in the mapping, not just a
    // repeat of the one being extracted.
    let mut seen_keys = std::collections::HashSet::new();
    // Frame of the most recent content line, at any depth (see
    // `content_line_frame`): a content line sitting DEEPER than a
    // previous line whose key carried an inline value cannot be
    // judged locally — it may be a legal plain-scalar continuation,
    // but it may also be a nested entry, which a scalar value cannot
    // have, so the parser would reject the document. Rather than
    // tell the two apart, fall back whenever that shape appears.
    let mut last_content: Option<(usize, bool)> = None;

    let mut lines = content.lines();
    while let Some(line) = lines.next() {
        if line.starts_with(' ') || line.starts_with('\t') {
            // Indented lines are nested content this scanner does not
            // read, but they still take part in the frame tracking,
            // and some shapes force the full parser outright.
            if indented_line_forces_fallback(
                line,
                saw_unindented_line,
                &mut last_content,
                &mut block_tracker,
                &mut anchors,
            ) {
                return None;
            }
            let trimmed_start = line.trim_start();
            if !trimmed_start.is_empty() && !trimmed_start.starts_with('#') {
                root_tracker.note_indented_content();
            }
            continue;
        }

        let trimmed_line = line.trim();
        if trimmed_line.is_empty() || trimmed_line.starts_with('#') {
            continue;
        }
        saw_unindented_line = true;

        // Directives or doc start/end markers requiring full parser
        if line.starts_with("---") || line.starts_with("...") {
            return None;
        }

        // Explicit mapping keys (`? key` / `: value`) are legal YAML that
        // this line scanner cannot parse; fall back to the full parser.
        // A line opening a flow collection is likewise outside the
        // block structure this scanner reads: it may span lines, and
        // its later lines would be mistaken for top-level keys.
        if trimmed_line.starts_with('?')
            || trimmed_line.starts_with('{')
            || trimmed_line.starts_with('[')
        {
            return None;
        }

        if unindented_line_forces_fallback(line, &mut root_tracker, &mut anchors, &mut seen_keys)
            || !block_tracker.reset_and_note(line)
        {
            return None;
        }

        // Track this line's frame; the indented branch above consults
        // the state for the lines that follow.
        last_content = Some(content_line_frame(line));

        // Quoted keys are invisible to the strip_prefix match below:
        // fall back when one could name the requested key — the parser
        // would read it as this key (or reject the document for defining
        // it twice), and the scanner cannot tell which.
        if quoted_key_could_name(trimmed_line, key) {
            return None;
        }

        // A spaced twin of the requested key (`secret : x`) is the
        // same key to the parser, so it can be a duplicate the
        // exact-prefix match below would silently skip; fall back,
        // mirroring the TUN scanner's `tun :` check.
        if let Some(rest) = line.strip_prefix(key) {
            if !rest.starts_with(':') && rest.trim_start_matches([' ', '\t']).starts_with(':') {
                return None;
            }
        }

        // Top-level key must have no leading whitespace
        if let Some(rest) = line.strip_prefix(key) {
            if let Some(after_colon) = rest.strip_prefix(':') {
                // YAML spec: key colon must be followed by whitespace, comment, or end-of-line
                if !after_colon.is_empty()
                    && !after_colon.starts_with(' ')
                    && !after_colon.starts_with('\t')
                    && !after_colon.starts_with('#')
                {
                    continue;
                }

                if matched {
                    // serde_yaml rejects duplicate mapping keys; fall back so
                    // the full parser (which errors) decides.
                    return None;
                }
                matched = true;

                let val_raw = after_colon.trim();

                let val_trimmed = if let Some(rest_q) = val_raw.strip_prefix('"') {
                    // Double-quoted string
                    if let Some(close_idx) = rest_q.find('"') {
                        let inner = &rest_q[..close_idx];
                        if inner.contains('\\') {
                            return None;
                        }
                        let trailing = rest_q[close_idx + 1..].trim();
                        if !trailing.is_empty() && !trailing.starts_with('#') {
                            return None;
                        }
                        inner
                    } else {
                        return None;
                    }
                } else if let Some(rest_q) = val_raw.strip_prefix('\'') {
                    // Single-quoted string
                    if let Some(close_idx) = rest_q.find('\'') {
                        let inner = &rest_q[..close_idx];
                        if inner.contains('\'') {
                            return None;
                        }
                        let trailing = rest_q[close_idx + 1..].trim();
                        if !trailing.is_empty() && !trailing.starts_with('#') {
                            return None;
                        }
                        inner
                    } else {
                        return None;
                    }
                } else {
                    // Unquoted scalar
                    let mut val = val_raw;
                    // A tab inside the raw value makes comment/typing
                    // behavior parser-dependent; fall back to the full
                    // parser rather than guess.
                    if val.contains('\t') {
                        return None;
                    }
                    if let Some(comment_pos) = val.find(" #") {
                        val = val[..comment_pos].trim();
                    } else if val.starts_with('#') {
                        val = "";
                    }

                    let val_str = val.trim();
                    // YAML implicitly types unquoted scalars: `null`/`~`,
                    // booleans and numbers are not strings. The full parser
                    // (`as_str`) reads those as non-strings, so fall back
                    // instead of returning e.g. the literal text "null" for
                    // `secret: null`.
                    if !yaml_unquoted_scalar_is_string(val_str) {
                        return None;
                    }
                    val_str
                };

                // Reject empty or complex structures (multiline scalars, maps, arrays, anchors/aliases)
                if val_trimmed.is_empty()
                    || val_trimmed.starts_with('|')
                    || val_trimmed.starts_with('>')
                    || val_trimmed.starts_with('{')
                    || val_trimmed.starts_with('[')
                    || val_trimmed.starts_with('&')
                    || val_trimmed.starts_with('*')
                    || val_trimmed.starts_with('!')
                {
                    return None;
                }

                result = Some(val_trimmed);

                // A more-indented following line continues a multi-line
                // plain scalar (`secret: foo` + `  bar` folds to `foo bar`);
                // the fast path only reads the first line, so fall back.
                for next in lines.clone() {
                    let t = next.trim();
                    if t.is_empty() || t.starts_with('#') {
                        continue;
                    }
                    if next.starts_with(' ') || next.starts_with('\t') {
                        return None;
                    }
                    break;
                }
            }
        }
    }

    result
}

/// Whether an unquoted YAML scalar would parse as a plain string (rather
/// than null/bool/number) under `serde_yaml`'s implicit typing. Used to keep
/// the fast-path scanners behavior-identical to the full parser: when in
/// doubt this returns `false` (fall back), which is always correct.
fn yaml_unquoted_scalar_is_string(val: &str) -> bool {
    if val.is_empty() {
        return false;
    }
    let lower = val.to_ascii_lowercase();
    if matches!(
        lower.as_str(),
        "~" | "null" | "true" | "false" | ".nan" | "+.nan" | "-.nan" | ".inf" | "+.inf" | "-.inf"
    ) {
        return false;
    }
    // serde_yaml tries i64/u64/f64 (and lowercase 0x/0o/0b-prefixed ints,
    // with an optional leading +/-) for numbers.
    if val.parse::<i64>().is_ok() || val.parse::<u64>().is_ok() || val.parse::<f64>().is_ok() {
        return false;
    }
    let unsigned = val.strip_prefix(['+', '-']).unwrap_or(val);
    for (prefix, radix) in [("0x", 16), ("0o", 8), ("0b", 2)] {
        if let Some(rest) = unsigned.strip_prefix(prefix) {
            // Uppercase prefixes (0X/0O/0B) stay strings in serde_yaml, and a
            // sign right after the prefix is not a number either.
            if !rest.is_empty()
                && !rest.starts_with(['+', '-'])
                && u64::from_str_radix(rest, radix).is_ok()
            {
                return false;
            }
        }
    }
    true
}

/// Scans one `tun:` mapping block for the `enable:` value at the block's root
/// indentation. Returns `None` when the block contains anything the scanner
/// cannot handle (fall back to the full parser), otherwise the last `enable`
/// value seen (`None` when the block has no `enable:` key — last duplicate
/// key wins in YAML mappings).
fn scan_tun_block_enable_fast<'a, I>(lines: &mut std::iter::Peekable<I>) -> Option<Option<bool>>
where
    I: Iterator<Item = &'a str>,
{
    let mut expected_indent: Option<usize> = None;
    let mut found: Option<bool> = None;
    let mut last_content: Option<(usize, bool)> = None;
    let mut block_tracker = BlockKindTracker::default();
    // Block-local anchor set for the alias check: the pre-scan in
    // `extract_tun_enabled_fast` has already validated the whole
    // document in order, so an alias to an anchor defined before
    // the block simply falls back here (never a wrong answer).
    let mut anchors = std::collections::HashSet::new();

    while let Some(&next_line) = lines.peek() {
        // YAML forbids tabs in indentation; such a document fails full
        // parsing, so fall back rather than misread it.
        if next_line.starts_with('\t') {
            return None;
        }
        let next_trimmed = next_line.trim();
        if next_trimmed.is_empty() || next_trimmed.starts_with('#') {
            lines.next();
            continue;
        }

        let indent = next_line.len() - next_line.trim_start().len();
        // The same tab rule for the rest of the indentation prefix
        // (a space followed by a tab is still tab indentation).
        if next_line[..indent].contains('\t') {
            return None;
        }

        // Explicit mapping keys (`? key` / `: value`) are legal YAML that
        // this line scanner cannot parse; fall back to the full parser.
        if next_trimmed.starts_with('?') {
            return None;
        }

        // If line is not indented at all, the `tun:` block has ended.
        if indent == 0 {
            break;
        }

        // A standalone value line inside the block begins (or
        // continues) a value whose extent this scanner cannot judge
        // (see `is_standalone_value_line`); fall back.
        if is_standalone_value_line(next_line.trim_start()) {
            return None;
        }

        // A node property or alias can carry the line's key (see
        // `starts_with_node_property`), and a reserved indicator
        // cannot start a token at all; fall back for both.
        if starts_with_node_property(next_line.trim_start())
            || starts_with_reserved_indicator(next_line.trim_start())
            || sequence_entry_forces_fallback(next_line.trim_start(), &mut anchors)
            || quoted_key_shape_forces_fallback(next_line.trim_start())
        {
            return None;
        }

        // Sibling lines within the block are all of one kind (see
        // `BlockKindTracker`).
        if !block_tracker.observe(next_line) {
            return None;
        }

        // Establish the child indentation level of the `tun:` mapping
        let child_indent = *expected_indent.get_or_insert(indent);

        // If this line is indented further than the child level, it's inside a sub-mapping
        if indent > child_indent {
            // …unless a previous line at any depth inside the block
            // carried an inline value: a more-indented line after such
            // an entry may be a nested entry, which a scalar value
            // cannot have (the parser would reject the document); the
            // scanner cannot tell, so fall back instead of skipping
            // the line and reading the rest of the block. A deeper
            // line whose own plain value contains a mapping colon is
            // rejected by the parser for the same reason.
            if matches!(last_content, Some((prev_indent, true)) if indent > prev_indent)
                || plain_value_has_mapping_colon(next_line.trim_start(), &mut anchors)
            {
                return None;
            }
            last_content = Some(content_line_frame(next_line));
            lines.next();
            continue;
        }

        // If this line is less indented than the child level, the `tun:`
        // mapping has ended — but a dedent to a non-zero level below the
        // child level is invalid YAML (the full parser errors → disabled),
        // so fall back instead of returning the value seen so far.
        if indent < child_indent {
            return None;
        }

        let indented = next_line.trim_start();
        // A child whose plain value contains its own mapping colon is
        // rejected by the parser; do not read past it.
        if plain_value_has_mapping_colon(indented, &mut anchors) {
            return None;
        }
        // A quoted key (`"enable": true`) is still the `enable` key in
        // YAML; the fast path cannot match it safely, so fall back to
        // the full parser rather than misreading it as disabled.
        if indented.starts_with('"') || indented.starts_with('\'') {
            return None;
        }
        // `enable : true` (space before the colon) is a valid `enable`
        // key the exact-prefix check below would miss; fall back.
        if let Some(rest) = indented.strip_prefix("enable") {
            if !rest.starts_with(':') && rest.trim_start_matches([' ', '\t']).starts_with(':') {
                return None;
            }
        }
        if let Some(after_enable_raw) = indented.strip_prefix("enable:") {
            if after_enable_raw.is_empty()
                || after_enable_raw.starts_with(' ')
                || after_enable_raw.starts_with('\t')
                || after_enable_raw.starts_with('#')
            {
                let mut val = after_enable_raw.trim();
                // A quoted value (`enable: "true"`) is a YAML string:
                // the full parser (`as_bool`) reads it as false, so
                // fall back to keep parity.
                if val.starts_with('"') || val.starts_with('\'') || val.contains('\t') {
                    return None;
                }
                if let Some(pos) = val.find(" #") {
                    val = val[..pos].trim();
                }
                // YAML 1.2 core schema accepts only these six bool spellings;
                // anything else (`tRuE`, `yes`, `1`, …) is a string to the
                // full parser, so fall back rather than answer differently.
                let b = match val {
                    "true" | "True" | "TRUE" => true,
                    "false" | "False" | "FALSE" => false,
                    _ => return None,
                };
                if found.is_some() {
                    // serde_yaml rejects duplicate mapping keys; fall back
                    // so the full parser (which errors → disabled) decides.
                    return None;
                }
                found = Some(b);
            }
        }

        last_content = Some(content_line_frame(next_line));

        lines.next();
    }

    Some(found)
}

/// Fast-path extraction for `tun.enable` status from YAML config content.
///
/// Scans for top-level `tun:` block and inspects indented `enable:` keys without
/// parsing the full YAML tree. Falls back to `serde_yaml` for complex YAML.
fn extract_tun_enabled_fast(content: &str) -> Option<bool> {
    if content.contains("<<") || content.contains("%YAML") {
        return None;
    }

    // If the document could contain a top-level `tun` key that the line
    // scanner below cannot see, fall back to the full parser instead of
    // wrongly reporting disabled: a quoted key (`"tun":`), a flow-style/JSON
    // document, a leading BOM, a `tun :` key with space before the colon, or
    // a document whose top-level block is indented as a whole.
    // BOM and non-ASCII whitespace guard, as in the scalar scanner
    // above (see `has_breaking_characters`): `trim_start` would
    // count an NBSP as indentation the parser does not see, and
    // `trim` would strip it from values the parser keeps whole.
    if content.starts_with('\u{FEFF}') || has_breaking_characters(content) {
        return None;
    }
    let mut saw_unindented_line = false;
    let mut last_content: Option<(usize, bool)> = None;
    let mut root_tracker = RootKindTracker::default();
    let mut block_tracker = BlockKindTracker::default();
    let mut anchors = std::collections::HashSet::new();
    let mut seen_root_keys = std::collections::HashSet::new();
    for line in content.lines() {
        let indent = line.len() - line.trim_start().len();
        if indent > 0 {
            // The same per-line fallback rules as the scalar scanner
            // (see `indented_line_forces_fallback`), including the
            // frame tracking.
            if indented_line_forces_fallback(
                line,
                saw_unindented_line,
                &mut last_content,
                &mut block_tracker,
                &mut anchors,
            ) {
                return None;
            }
            let trimmed_start = line.trim_start();
            if !trimmed_start.is_empty() && !trimmed_start.starts_with('#') {
                root_tracker.note_indented_content();
            }
            continue;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        saw_unindented_line = true;
        // A quoted key that could decode to `tun` (see
        // `quoted_key_could_name`, shared with the scalar scanner)
        // is invisible to the literal `tun:` match below.
        if trimmed.starts_with('{')
            || trimmed.starts_with('[')
            || quoted_key_could_name(trimmed, "tun")
        {
            return None;
        }
        if let Some(rest) = trimmed.strip_prefix("tun") {
            if !rest.starts_with(':') && rest.trim_start_matches([' ', '\t']).starts_with(':') {
                return None;
            }
        }
        // The remaining per-line fallback rules are the scalar
        // scanner's (see `unindented_line_forces_fallback`).
        if unindented_line_forces_fallback(
            line,
            &mut root_tracker,
            &mut anchors,
            &mut seen_root_keys,
        ) {
            return None;
        }
        if !block_tracker.reset_and_note(line) {
            return None;
        }
        last_content = Some(content_line_frame(line));
    }
    if !saw_unindented_line {
        return None;
    }

    let mut lines = content.lines().peekable();
    // The last `enable:` seen in a `tun:` block wins; a second top-level
    // `tun:` block is a duplicate key (which the full parser rejects), so
    // fall back then.
    let mut found: Option<bool> = None;
    let mut saw_tun_block = false;

    while let Some(line) = lines.next() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        if line.starts_with("---") || line.starts_with("...") {
            return None;
        }

        // Explicit mapping keys (`? key` / `: value`) are legal YAML that
        // this line scanner cannot parse; fall back to the full parser.
        if trimmed.starts_with('?') {
            return None;
        }

        if let Some(after_colon_raw) = line.strip_prefix("tun:") {
            if !after_colon_raw.is_empty()
                && !after_colon_raw.starts_with(' ')
                && !after_colon_raw.starts_with('\t')
                && !after_colon_raw.starts_with('#')
            {
                continue;
            }

            let after_colon = after_colon_raw.trim();
            if !after_colon.is_empty() && !after_colon.starts_with('#') {
                // Inline scalar (`tun: true`). The full parser only looks at
                // `tun.enable`, so a scalar `tun` reads as disabled there;
                // fall back instead of inventing a different answer.
                return None;
            }

            // `tun:` mapping block. Look for indented lines under `tun:`.
            if saw_tun_block {
                // serde_yaml rejects duplicate mapping keys; fall back so the
                // full parser (which errors → disabled) decides.
                return None;
            }
            saw_tun_block = true;
            match scan_tun_block_enable_fast(&mut lines) {
                None => return None,
                Some(block_found) => {
                    if block_found.is_some() {
                        found = block_found;
                    }
                }
            }
        }
    }

    // No `tun:` section, or `tun:` blocks without an `enable:` field: disabled.
    // (In YAML, if `tun:` exists as a mapping block but has no `enable:` field
    // at the root of `tun:`, `tun.enable` is false.)
    Some(found.unwrap_or(false))
}

/// Proxy mode a profile sets at top level (`mode:`), lowercased, when it is one
/// the app supports (`rule`, `global`, `direct`). `None` when the key is missing
/// or invalid, in which case mihomo runs `rule`.
#[must_use]
pub fn extract_mode_from_yaml(content: &str) -> Option<String> {
    if let Some(val) = extract_top_level_scalar_fast(content, "mode") {
        let lower = val.to_ascii_lowercase();
        if matches!(lower.as_str(), "rule" | "global" | "direct") {
            return Some(lower);
        }
    }

    let yaml_val: yaml::Value = yaml::from_str(content).ok()?;
    let mode = yaml_val.get("mode")?.as_str()?.to_ascii_lowercase();
    matches!(mode.as_str(), "rule" | "global" | "direct").then_some(mode)
}

/// Extract secret from YAML config content using the YAML parser.
/// This avoids issues with line-by-line parsing (multi-line strings, comments, etc.).
#[cfg_attr(feature = "uniffi", uniffi::export)]
#[must_use]
pub fn extract_secret_from_yaml(content: &str) -> Option<String> {
    if let Some(val) = extract_top_level_scalar_fast(content, "secret") {
        return Some(val.to_owned());
    }

    let yaml_val: yaml::Value = yaml::from_str(content).ok()?;
    yaml_val
        .get("secret")
        .and_then(|v| v.as_str())
        .map(str::to_owned)
}

/// Ensure dns-hijack list contains both UDP (`any:53`) and TCP (`tcp://any:53`) entries.
/// This prevents DNS leaks by hijacking all DNS traffic to mihomo.
pub fn ensure_dns_hijack_entries(tun_map: &mut yaml::Mapping) {
    const ANY_UDP: &str = "any:53";
    const ANY_TCP: &str = "tcp://any:53";

    let dns_hijack_key = YamlValue::String("dns-hijack".to_owned());
    let any_udp_val = YamlValue::String(ANY_UDP.to_owned());
    let any_tcp_val = YamlValue::String(ANY_TCP.to_owned());

    match tun_map.entry(dns_hijack_key) {
        yaml::mapping::Entry::Occupied(mut entry) => {
            // Existing dns-hijack entry - ensure it contains both entries
            match entry.get_mut() {
                YamlValue::Sequence(seq) => {
                    if !seq.contains(&any_udp_val) {
                        seq.push(any_udp_val);
                    }
                    if !seq.contains(&any_tcp_val) {
                        seq.push(any_tcp_val);
                    }
                }
                // If it's not a sequence (e.g., a string or other type), replace it
                YamlValue::Null
                | YamlValue::Bool(_)
                | YamlValue::Number(_)
                | YamlValue::String(_)
                | YamlValue::Mapping(_)
                | YamlValue::Tagged(_) => {
                    entry.insert(YamlValue::Sequence(vec![any_udp_val, any_tcp_val]));
                }
            }
        }
        yaml::mapping::Entry::Vacant(entry) => {
            // No dns-hijack entry - create new sequence
            entry.insert(YamlValue::Sequence(vec![any_udp_val, any_tcp_val]));
        }
    }
}

/// Update TUN enable setting in YAML config content using `serde_yaml`.
/// Returns updated content with TUN block modified or appended.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn update_tun_in_yaml(content: &str, enable: bool) -> Result<String, AppError> {
    let mut yaml_val = yaml::from_str::<YamlValue>(content)
        .map_err(|e| AppError::ParseError(format!("Failed to parse YAML config: {e}")))?;

    let mapping = yaml_val
        .as_mapping_mut()
        .ok_or_else(|| AppError::ConfigError("YAML root is not a mapping".to_owned()))?;
    // Ensure tun key is a Mapping — replace if it's a non-mapping type (e.g. `tun: false`, `tun: null`)
    let tun_key = YamlValue::String("tun".to_owned());
    if !mapping.get(&tun_key).is_some_and(YamlValue::is_mapping) {
        mapping.insert(tun_key.clone(), YamlValue::Mapping(yaml::Mapping::new()));
    }
    let tun = mapping
        .get_mut(&tun_key)
        .and_then(YamlValue::as_mapping_mut)
        .ok_or_else(|| AppError::ConfigError("Failed to get tun mapping".to_owned()))?;
    tun.insert(
        YamlValue::String("enable".to_owned()),
        YamlValue::Bool(enable),
    );
    // Preserve sensible defaults when enabling TUN
    if enable {
        tun.entry(YamlValue::String("stack".to_owned()))
            .or_insert_with(|| YamlValue::String("system".to_owned()));
        tun.entry(YamlValue::String("auto-route".to_owned()))
            .or_insert_with(|| YamlValue::Bool(true));
        tun.entry(YamlValue::String("auto-detect-interface".to_owned()))
            .or_insert_with(|| YamlValue::Bool(true));
        // Hijack all DNS traffic to prevent leaks (UDP + TCP)
        ensure_dns_hijack_entries(tun);
    }

    yaml::to_string(&yaml_val).map_err(|e| {
        AppError::ConfigError(format!("Failed to serialize YAML after TUN toggle: {e}"))
    })
}

/// Set the top-level controller `secret` in YAML config content.
///
/// Only the root key changes: a nested `secret:` inside a proxy, provider or
/// listener block is left alone, and `serde_yaml` quotes the value as needed.
pub fn set_secret_in_yaml(content: &str, secret: &str) -> Result<String, AppError> {
    let mut yaml_val = yaml::from_str::<YamlValue>(content)
        .map_err(|e| AppError::ParseError(format!("Failed to parse YAML config: {e}")))?;
    yaml_val
        .as_mapping_mut()
        .ok_or_else(|| AppError::ConfigError("YAML root is not a mapping".to_owned()))?
        .insert(
            YamlValue::String("secret".to_owned()),
            YamlValue::String(secret.to_owned()),
        );
    yaml::to_string(&yaml_val)
        .map_err(|e| AppError::ConfigError(format!("Failed to serialize YAML: {e}")))
}

/// Inject TUN file descriptor into YAML config content for Android VPN Service.
///
/// On Android, mihomo cannot create its own TUN device (netlink is banned).
/// Instead, Android `VpnService` creates the TUN interface and passes the fd
/// to mihomo via the `tun.fd` config field. This function reliably injects
/// the fd using `serde_yaml` (not regex), and enables `auto-route` and
/// `auto-detect-interface` since VPN Service requires mihomo to handle routing
/// through the TUN interface.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn inject_tun_fd(content: &str, fd: i32) -> Result<String, AppError> {
    let mut yaml_val = yaml::from_str::<YamlValue>(content)
        .map_err(|e| AppError::ParseError(format!("Failed to parse YAML config: {e}")))?;

    if let Some(mapping) = yaml_val.as_mapping_mut() {
        // Disable process matching on Android — non-root apps cannot read
        // /data/system/packages.xml which mihomo needs for Android package rules.
        // Without this, TUN startup fails with:
        //   "build android rules: read packages list: open /data/system/packages.xml: permission denied"
        mapping.insert(
            YamlValue::String("find-process-mode".to_owned()),
            YamlValue::String("off".to_owned()),
        );

        // Ensure tun key is a Mapping — replace if it's a non-mapping type (e.g. `tun: false`, `tun: null`)
        let tun_key = YamlValue::String("tun".to_owned());
        if !mapping.get(&tun_key).is_some_and(YamlValue::is_mapping) {
            mapping.insert(tun_key.clone(), YamlValue::Mapping(yaml::Mapping::new()));
        }
        if let Some(tun_map) = mapping
            .get_mut(&tun_key)
            .and_then(YamlValue::as_mapping_mut)
        {
            // Inject the VPN Service TUN fd
            tun_map.insert(
                YamlValue::String("fd".to_owned()),
                YamlValue::Number(fd.into()),
            );
            // On Android with VPN Service, mihomo needs auto-route to set up
            // proper routing rules including fwmark-based bypass for its own
            // outbound connections. Without auto-route, mihomo cannot detect
            // the real network interface and all connections will loop back
            // through the VPN tunnel.
            // The netlink error ("netlink socket in Android is banned by Google")
            // is non-fatal — mihomo falls back to alternative methods.
            tun_map
                .entry(YamlValue::String("auto-route".to_owned()))
                .or_insert_with(|| YamlValue::Bool(true));
            tun_map
                .entry(YamlValue::String("auto-detect-interface".to_owned()))
                .or_insert_with(|| YamlValue::Bool(true));
        }
    }

    yaml::to_string(&yaml_val).map_err(|e| {
        AppError::ConfigError(format!("Failed to serialize YAML after fd injection: {e}"))
    })
}

/// Extract TUN enable status from YAML config content using `serde_yaml`.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn extract_tun_enabled_from_yaml(content: &str) -> bool {
    if let Some(enabled) = extract_tun_enabled_fast(content) {
        return enabled;
    }

    let yaml_val = match yaml::from_str::<YamlValue>(content) {
        Ok(v) => v,
        Err(_) => return false,
    };

    yaml_val
        .get("tun")
        .and_then(|t| t.get("enable"))
        .and_then(YamlValue::as_bool)
        .unwrap_or(false)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_mode_from_yaml() {
        assert_eq!(
            extract_mode_from_yaml("mode: Global\n").as_deref(),
            Some("global")
        );
        assert_eq!(
            extract_mode_from_yaml("mode: direct\nport: 1\n").as_deref(),
            Some("direct")
        );
        assert_eq!(extract_mode_from_yaml("port: 1\n"), None);
        assert_eq!(extract_mode_from_yaml("mode: script\n"), None);
        assert_eq!(extract_mode_from_yaml("tun:\n  mode: global\n"), None);
    }

    // Helper to extract dns-hijack values from YAML string
    fn extract_dns_hijack(content: &str) -> Option<Vec<String>> {
        let yaml_val = yaml::from_str::<YamlValue>(content).ok()?;
        let mapping = yaml_val.as_mapping()?;
        let tun = mapping
            .get(YamlValue::String("tun".to_owned()))?
            .as_mapping()?;
        let hijack = tun
            .get(YamlValue::String("dns-hijack".to_owned()))?
            .as_sequence()?;
        hijack
            .iter()
            .map(|v| v.as_str().map(std::borrow::ToOwned::to_owned))
            .collect()
    }

    #[test]
    fn test_set_secret_in_yaml_only_touches_top_level() {
        let content = "secret: old\nproxies:\n  - name: a\n    secret: nested\n";
        let out = set_secret_in_yaml(content, "a#b: c").expect("secret update should succeed");
        assert_eq!(extract_secret_from_yaml(&out).as_deref(), Some("a#b: c"));
        let val: YamlValue = yaml::from_str(&out).expect("output should parse");
        let nested = val
            .get("proxies")
            .and_then(|p| p.get(0))
            .and_then(|p| p.get("secret"))
            .and_then(YamlValue::as_str);
        assert_eq!(nested, Some("nested"));
        let added =
            set_secret_in_yaml("mixed-port: 7890\n", "s1").expect("secret insert should succeed");
        assert_eq!(extract_secret_from_yaml(&added).as_deref(), Some("s1"));
        assert!(set_secret_in_yaml("- a\n", "s").is_err());
    }

    #[test]
    fn test_update_tun_enable_no_tun_section() {
        let content = "proxies:\n  - name: test\n";
        let updated = update_tun_in_yaml(content, true).expect("YAML update should succeed");

        let hijack = extract_dns_hijack(&updated).expect("should have dns-hijack");
        assert!(hijack.contains(&"any:53".to_owned()));
        assert!(hijack.contains(&"tcp://any:53".to_owned()));
    }

    #[test]
    fn test_update_tun_enable_no_dns_hijack() {
        let content = "tun:\n  enable: false\n  stack: system\n";
        let updated = update_tun_in_yaml(content, true).expect("YAML update should succeed");

        let hijack = extract_dns_hijack(&updated).expect("should have dns-hijack");
        assert!(hijack.contains(&"any:53".to_owned()));
        assert!(hijack.contains(&"tcp://any:53".to_owned()));
    }

    #[test]
    fn test_update_tun_enable_empty_dns_hijack() {
        let content = "tun:\n  enable: false\n  dns-hijack: []\n";
        let updated = update_tun_in_yaml(content, true).expect("YAML update should succeed");

        let hijack = extract_dns_hijack(&updated).expect("should have dns-hijack");
        assert!(hijack.contains(&"any:53".to_owned()));
        assert!(hijack.contains(&"tcp://any:53".to_owned()));
    }

    #[test]
    fn test_update_tun_enable_partial_dns_hijack_udp_only() {
        let content = "tun:\n  enable: false\n  dns-hijack:\n    - any:53\n";
        let updated = update_tun_in_yaml(content, true).expect("YAML update should succeed");

        let hijack = extract_dns_hijack(&updated).expect("should have dns-hijack");
        assert!(hijack.contains(&"any:53".to_owned()));
        assert!(hijack.contains(&"tcp://any:53".to_owned()));
    }

    #[test]
    fn test_update_tun_enable_partial_dns_hijack_tcp_only() {
        let content = "tun:\n  enable: false\n  dns-hijack:\n    - tcp://any:53\n";
        let updated = update_tun_in_yaml(content, true).expect("YAML update should succeed");

        let hijack = extract_dns_hijack(&updated).expect("should have dns-hijack");
        assert!(hijack.contains(&"any:53".to_owned()));
        assert!(hijack.contains(&"tcp://any:53".to_owned()));
    }

    #[test]
    fn test_update_tun_enable_complete_dns_hijack_unchanged() {
        let content = "tun:\n  enable: false\n  dns-hijack:\n    - any:53\n    - tcp://any:53\n";
        let updated = update_tun_in_yaml(content, true).expect("YAML update should succeed");

        let hijack = extract_dns_hijack(&updated).expect("should have dns-hijack");
        assert_eq!(hijack.len(), 2);
        assert!(hijack.contains(&"any:53".to_owned()));
        assert!(hijack.contains(&"tcp://any:53".to_owned()));
    }

    #[test]
    fn test_update_tun_enable_dns_hijack_wrong_type() {
        let content = "tun:\n  enable: false\n  dns-hijack: \"any:53\"\n";
        let updated = update_tun_in_yaml(content, true).expect("YAML update should succeed");

        let hijack = extract_dns_hijack(&updated).expect("should have dns-hijack");
        assert!(hijack.contains(&"any:53".to_owned()));
        assert!(hijack.contains(&"tcp://any:53".to_owned()));
    }

    #[test]
    fn test_update_tun_disable_no_dns_hijack_added() {
        let content = "tun:\n  enable: true\n";
        let updated = update_tun_in_yaml(content, false).expect("YAML update should succeed");

        let yaml_val = yaml::from_str::<YamlValue>(&updated).expect("valid yaml");
        let tun = yaml_val
            .as_mapping()
            .and_then(|m| m.get(YamlValue::String("tun".to_owned())))
            .and_then(YamlValue::as_mapping)
            .expect("should have tun mapping");
        assert!(tun
            .get(YamlValue::String("dns-hijack".to_owned()))
            .is_none());
        assert_eq!(
            tun.get(YamlValue::String("enable".to_owned()))
                .and_then(YamlValue::as_bool),
            Some(false)
        );
    }

    #[test]
    fn test_ensure_dns_hijack_entries_directly() {
        let mut tun_map = yaml::Mapping::new();
        ensure_dns_hijack_entries(&mut tun_map);

        let hijack = tun_map
            .get(YamlValue::String("dns-hijack".to_owned()))
            .and_then(YamlValue::as_sequence)
            .expect("should have dns-hijack sequence");
        let values: Vec<String> = hijack
            .iter()
            .map(|v| v.as_str().expect("should be string").to_owned())
            .collect();
        assert!(values.contains(&"any:53".to_owned()));
        assert!(values.contains(&"tcp://any:53".to_owned()));
    }

    #[test]
    fn test_extract_secret_from_yaml() {
        let content = "secret: mysecret\nport: 9090\n";
        assert_eq!(
            extract_secret_from_yaml(content),
            Some("mysecret".to_owned())
        );
    }

    #[test]
    fn test_extract_secret_from_yaml_missing() {
        let content = "port: 9090\n";
        assert_eq!(extract_secret_from_yaml(content), None);
    }

    #[test]
    fn test_extract_tun_enabled_from_yaml() {
        let content = "tun:\n  enable: true\n";
        assert!(extract_tun_enabled_from_yaml(content));
    }

    #[test]
    fn test_extract_tun_disabled_from_yaml() {
        let content = "tun:\n  enable: false\n";
        assert!(!extract_tun_enabled_from_yaml(content));
    }

    #[test]
    fn test_extract_tun_missing_from_yaml() {
        let content = "port: 9090\n";
        assert!(!extract_tun_enabled_from_yaml(content));
    }

    #[test]
    fn test_extract_tun_enabled_escaped_key() {
        // The key decodes to `tun` only after YAML unescaping, so the fast
        // path must defer to the full parser instead of reporting disabled.
        let content = "\"t\\u0075n\":\n  enable: true\n";
        assert!(extract_tun_enabled_from_yaml(content));
    }

    #[test]
    fn test_extract_secret_malformed_indented_explicit_key() {
        // The indented explicit key makes the document malformed; the fast
        // path must defer to the full parser (which rejects it) instead of
        // returning the secret.
        let content = "secret: token\nnested:\n  ? [unterminated\n";
        assert_eq!(extract_secret_from_yaml(content), None);
    }

    #[test]
    fn test_extract_tun_enabled_escaped_key_with_literal_tun_elsewhere() {
        // The escaped key decodes to `tun`; the literal substring showing
        // up in an unrelated value must not let the fast path answer.
        let content = "\"t\\u0075n\":\n  enable: true\nname: tun-test\n";
        assert_eq!(extract_tun_enabled_fast(content), None);
        assert!(extract_tun_enabled_from_yaml(content));
    }

    #[test]
    fn test_extract_tun_fast_path_unrelated_quoted_value() {
        // No tun anywhere and only an unrelated quoted value: the fast
        // path still answers directly instead of invoking the full parser.
        assert_eq!(
            extract_tun_enabled_fast("mode: \"rule\"\nport: 7890\n"),
            Some(false)
        );
    }

    #[test]
    fn test_extract_secret_escaped_duplicate_key() {
        // The escaped key decodes to `secret`, so the parser rejects the
        // document as a duplicate; no secret may be returned from it.
        let content = "secret: real\n\"s\\u0065cret\": other\n";
        assert_eq!(extract_secret_from_yaml(content), None);
    }

    #[test]
    fn test_extract_tun_enabled_explicit_escaped_key() {
        // An explicit key (`? ...`) spelling `tun` with escapes is only
        // decidable by the full parser; the fast path must defer.
        let content = "? \"t\\u0075n\"\n:\n  enable: true\n";
        assert_eq!(extract_tun_enabled_fast(content), None);
        assert!(extract_tun_enabled_from_yaml(content));
    }

    #[test]
    fn test_extract_secret_indented_root_block() {
        // An indented root block followed by a column-0 key is malformed
        // for the parser; the fast path must not answer from it.
        let content = "  secret: x\nsecret: real\n";
        assert_eq!(extract_secret_from_yaml(content), None);
    }

    #[test]
    fn test_extract_tun_enabled_tab_indented_quoted_key() {
        // A tab-indented quoted `tun` line is never legal indentation;
        // the fast path defers and the parser rejects the document.
        let content = "\t\"tun\": x\ntun:\n  enable: true\n";
        assert_eq!(extract_tun_enabled_fast(content), None);
        assert!(!extract_tun_enabled_from_yaml(content));
    }

    #[test]
    fn test_extract_secret_bom_prefixed_duplicate() {
        // The BOM hides the first `secret:` line from the scanner; the
        // parser strips the BOM and rejects the duplicate key.
        let content = "\u{FEFF}secret: a\nsecret: b\n";
        assert_eq!(extract_secret_from_yaml(content), None);
    }

    #[test]
    fn test_extract_secret_single_quoted_keys() {
        // A single-quoted twin is a duplicate for the parser, so no
        // secret may be returned; a sole single-quoted key still reads
        // through the parser fallback.
        assert_eq!(
            extract_secret_from_yaml("secret: real\n'secret': other\n"),
            None
        );
        assert_eq!(
            extract_secret_from_yaml("'secret': real\n"),
            Some("real".to_owned())
        );
    }

    #[test]
    fn test_extract_secret_with_quotes_and_comments() {
        let content_double = "secret: \"my_secret\" # comment\nport: 9090\n";
        assert_eq!(
            extract_secret_from_yaml(content_double),
            Some("my_secret".to_owned())
        );

        let content_single = "secret: 'my_secret' # comment\nport: 9090\n";
        assert_eq!(
            extract_secret_from_yaml(content_single),
            Some("my_secret".to_owned())
        );

        let content_unquoted = "secret: my_secret # comment\nport: 9090\n";
        assert_eq!(
            extract_secret_from_yaml(content_unquoted),
            Some("my_secret".to_owned())
        );
    }

    #[test]
    fn test_extract_mode_spec_colon_space() {
        // `mode:rule` has no space after colon, so in YAML it's a plain scalar "mode:rule" and not key `mode`.
        let content = "mode:rule\n";
        assert_eq!(extract_mode_from_yaml(content), None);
    }

    #[test]
    fn test_extract_tun_enabled_nested_map_override() {
        // `enable: false` under `device` (nested indentation) must be ignored;
        // `enable: true` at root of `tun:` must be matched.
        let content = "tun:\n  device:\n    enable: false\n  enable: true\n";
        assert!(extract_tun_enabled_from_yaml(content));
    }

    #[test]
    fn test_fast_path_yaml_type_parity() {
        // Unquoted `null` secret is not a string: the full parser reads it as
        // None, so the fast path must fall back rather than return "null".
        assert_eq!(extract_secret_from_yaml("secret: null\n"), None);
        assert_eq!(extract_secret_from_yaml("secret: ~\n"), None);
        // Signed radix ints are numbers to the full parser, not strings.
        assert_eq!(extract_secret_from_yaml("secret: -0x1\n"), None);
        assert_eq!(extract_secret_from_yaml("secret: +0o17\n"), None);
        // A quoted string stays a string either way.
        assert_eq!(
            extract_secret_from_yaml("secret: \"null\"\n"),
            Some("null".to_owned())
        );
        // A quoted `tun: "true"` is a YAML string, not a bool: reads as false.
        assert!(!extract_tun_enabled_from_yaml("tun: \"true\"\n"));
        // A quoted key is still the `enable` key: must not be missed.
        assert!(extract_tun_enabled_from_yaml("tun:\n  \"enable\": true\n"));
        // A quoted value is a YAML string: reads as false.
        assert!(!extract_tun_enabled_from_yaml("tun:\n  enable: \"true\"\n"));
        // A top-level `tun` key the line scanner cannot see must fall back to
        // the full parser rather than misreport disabled.
        assert!(extract_tun_enabled_from_yaml("\"tun\":\n  enable: true\n"));
        assert!(extract_tun_enabled_from_yaml(
            "{\"tun\": {\"enable\": true}}\n"
        ));
        assert!(extract_tun_enabled_from_yaml(
            "\u{FEFF}tun:\n  enable: true\n"
        ));
        assert!(extract_tun_enabled_from_yaml("  tun:\n    enable: true\n"));
        assert!(extract_tun_enabled_from_yaml("tun :\n  enable: true\n"));
        // Duplicate keys are rejected by the full parser (→ disabled), so the
        // fast path must fall back instead of picking a winner.
        assert!(!extract_tun_enabled_from_yaml(
            "tun:\n  enable: true\n  enable: false\n"
        ));
        assert!(!extract_tun_enabled_from_yaml(
            "tun:\n  enable: false\n  enable: true\n"
        ));
        assert!(!extract_tun_enabled_from_yaml(
            "tun:\n  enable: true\ntun:\n  enable: false\n"
        ));
        // A tab-indented document is invalid YAML; fall back (→ disabled).
        assert!(!extract_tun_enabled_from_yaml("tun:\n\tenable: true\n"));
        // Duplicate top-level scalar keys: the full parser errors → None.
        assert_eq!(extract_secret_from_yaml("secret: a\nsecret: b\n"), None);
        // YAML 1.2 core schema only accepts six bool spellings; exotic
        // spellings and explicit mapping keys are covered in
        // `test_fast_path_yaml_parity_edge_cases`.
        // A multi-line plain scalar folds continuation lines; the fast path
        // only reads the first line, so it must fall back to the full parser.
        assert_eq!(
            extract_secret_from_yaml("secret: foo\n  bar\n"),
            Some("foo bar".to_owned())
        );
        // A scalar `tun:` is not a mapping: the full parser only reads
        // `tun.enable`, so this is disabled (the fast path must not
        // invent `true` for `tun: true`).
        assert!(!extract_tun_enabled_from_yaml("tun: true\n"));
        assert!(!extract_tun_enabled_from_yaml("tun: false\n"));
        // Ordinary configs keep the fast path: no `tun` key means disabled.
        assert!(!extract_tun_enabled_from_yaml("mode: rule\nport: 7890\n"));
    }

    #[test]
    fn test_fast_path_indented_line_after_inline_value() {
        // An indented content line after a mapping entry that carries an
        // inline scalar value belongs to no legal structure (a scalar
        // value grows no nested mapping): serde_yaml rejects all of
        // these documents, so both fast paths must fall back instead of
        // skipping the indented line and reading on.
        let secret_doc = "mode: rule\n  secret: x\nsecret: real\n";
        assert!(yaml::from_str::<YamlValue>(secret_doc).is_err());
        assert_eq!(extract_top_level_scalar_fast(secret_doc, "secret"), None);
        assert_eq!(extract_secret_from_yaml(secret_doc), None);

        let tun_doc = "mode: rule\n  x: y\ntun:\n  enable: true\n";
        assert!(yaml::from_str::<YamlValue>(tun_doc).is_err());
        assert_eq!(extract_tun_enabled_fast(tun_doc), None);
        assert!(!extract_tun_enabled_from_yaml(tun_doc));

        // Same shape with the indented entry ahead of any top-level key:
        // the root frame itself is broken, which the parser rejects too.
        let root_doc = "  x: y\ntun:\n  enable: true\n";
        assert!(yaml::from_str::<YamlValue>(root_doc).is_err());
        assert_eq!(extract_tun_enabled_fast(root_doc), None);
        assert!(!extract_tun_enabled_from_yaml(root_doc));

        // The same shape inside a `tun:` block: a deeper-indented line
        // after a child entry with an inline value.
        let block_doc = "tun:\n  enable: true\n  stack: system\n    enable: false\n";
        assert!(yaml::from_str::<YamlValue>(block_doc).is_err());
        assert_eq!(extract_tun_enabled_fast(block_doc), None);
        assert!(!extract_tun_enabled_from_yaml(block_doc));

        // Entries that open a nested block (no inline value) keep their
        // indented children: results stay exactly as the parser's.
        assert_eq!(
            extract_secret_from_yaml("proxies:\n  - name: a\nsecret: abc\n").as_deref(),
            Some("abc")
        );
        assert!(extract_tun_enabled_from_yaml(
            "dns:\n  enable: false\ntun:\n  enable: true\n"
        ));
        // A block scalar before the target key still resolves to the
        // parser's answer (via the fallback).
        assert_eq!(
            extract_secret_from_yaml("foo: |\n  text\nsecret: abc\n").as_deref(),
            Some("abc")
        );
    }

    #[test]
    fn test_fast_path_flow_entries_and_colon_keys() {
        // A key may itself contain a colon not followed by a space
        // (`a:b` is one plain scalar); the separator is the colon
        // followed by separation. Such entries keep the fast path.
        let colon_key = "a:b: c\nsecret: real\n";
        assert!(yaml::from_str::<YamlValue>(colon_key).is_ok());
        assert_eq!(
            extract_top_level_scalar_fast(colon_key, "secret"),
            Some("real")
        );

        // A complete flow collection as a sequence entry is a
        // self-contained value; its colons are flow syntax, so the
        // fast path keeps working on flow-style profile entries.
        let flow_entry = "proxies:\n- {name: a, type: ss, server: x}\nsecret: real\n";
        assert!(yaml::from_str::<YamlValue>(flow_entry).is_ok());
        assert_eq!(
            extract_top_level_scalar_fast(flow_entry, "secret"),
            Some("real")
        );
        let flow_entry_tun = "proxies:\n- {name: a, type: ss}\ntun:\n  enable: true\n";
        assert_eq!(extract_tun_enabled_fast(flow_entry_tun), Some(true));

        // The same entry left unclosed runs onto the following
        // lines; the parser rejects the document and neither scanner
        // may read the next line as a top-level entry.
        let unclosed_entry = "proxies:\n- {name: a, type: ss\nsecret: real\n";
        assert!(yaml::from_str::<YamlValue>(unclosed_entry).is_err());
        assert_eq!(
            extract_top_level_scalar_fast(unclosed_entry, "secret"),
            None
        );
        assert_eq!(extract_secret_from_yaml(unclosed_entry), None);

        // An unclosed flow VALUE does the same from a plain key.
        let unclosed_value = "foo: {a: b\nsecret: real\n";
        assert!(yaml::from_str::<YamlValue>(unclosed_value).is_err());
        assert_eq!(
            extract_top_level_scalar_fast(unclosed_value, "secret"),
            None
        );
        assert_eq!(extract_secret_from_yaml(unclosed_value), None);

        // A colon followed by a tab inside a plain value starts a
        // mapping value for the parser, which rejects the document;
        // the fast path must not read past it either.
        let tab_in_value = "mode: foo:\tbar\nsecret: real\n";
        assert!(yaml::from_str::<YamlValue>(tab_in_value).is_err());
        assert_eq!(extract_top_level_scalar_fast(tab_in_value, "secret"), None);
        assert_eq!(extract_secret_from_yaml(tab_in_value), None);
    }

    #[test]
    fn test_fast_path_bare_scalars_trailing_colons_flow_comments() {
        // A bare plain-scalar line inside a block begins a scalar
        // value; an entry line at the same indentation after it is an
        // error to the parser, so neither scanner may read past it.
        let bare_scalar = "foo:\n  bar\n  x: y\nsecret: real\n";
        assert!(yaml::from_str::<YamlValue>(bare_scalar).is_err());
        assert_eq!(extract_top_level_scalar_fast(bare_scalar, "secret"), None);
        assert_eq!(extract_secret_from_yaml(bare_scalar), None);
        let bare_in_tun = "tun:\n  stack:\n    gvisor\n    x: y\n  enable: true\n";
        assert!(yaml::from_str::<YamlValue>(bare_in_tun).is_err());
        assert_eq!(extract_tun_enabled_fast(bare_in_tun), None);
        assert!(!extract_tun_enabled_from_yaml(bare_in_tun));
        // A plain scalar that legally starts on the next line falls
        // back too (its extent cannot be judged locally); the public
        // result stays correct through the full parser.
        let next_line_scalar = "foo:\n  bar baz\nsecret: real\n";
        assert!(yaml::from_str::<YamlValue>(next_line_scalar).is_ok());
        assert_eq!(
            extract_top_level_scalar_fast(next_line_scalar, "secret"),
            None
        );
        assert_eq!(
            extract_secret_from_yaml(next_line_scalar).as_deref(),
            Some("real")
        );

        // A plain value ending with a colon carries a mapping
        // indicator; the parser rejects such documents.
        let trailing_colon = "mode: foo:\nsecret: real\n";
        assert!(yaml::from_str::<YamlValue>(trailing_colon).is_err());
        assert_eq!(
            extract_top_level_scalar_fast(trailing_colon, "secret"),
            None
        );
        assert_eq!(extract_secret_from_yaml(trailing_colon), None);
        let trailing_colon_tun = "tun:\n  stack: a:\n  enable: true\n";
        assert!(yaml::from_str::<YamlValue>(trailing_colon_tun).is_err());
        assert_eq!(extract_tun_enabled_fast(trailing_colon_tun), None);
        assert!(!extract_tun_enabled_from_yaml(trailing_colon_tun));

        // A closing brace inside a flow comment is comment text, not
        // the end of the collection: the collection is unclosed on
        // this line and the document falls back.
        for doc in [
            "proxies:\n- {name: a # }\nsecret: real\n",
            "foo: {a: b # }\nsecret: real\n",
        ] {
            assert!(yaml::from_str::<YamlValue>(doc).is_err());
            assert_eq!(extract_top_level_scalar_fast(doc, "secret"), None);
            assert_eq!(extract_secret_from_yaml(doc), None);
        }
    }

    #[test]
    fn test_fast_path_flow_trailing_junk() {
        // A complete flow collection followed by junk on the same
        // line is an error to the parser (the collection is the
        // whole entry or value); the fast path must not accept the
        // line and read on.
        for doc in [
            "proxies:\n- {name: a} junk\nsecret: real\n",
            "foo: {a: b} junk\nsecret: real\n",
        ] {
            assert!(yaml::from_str::<YamlValue>(doc).is_err());
            assert_eq!(extract_top_level_scalar_fast(doc, "secret"), None);
            assert_eq!(extract_secret_from_yaml(doc), None);
        }
        // A nested flow collection that closes mid-line, and a
        // trailing comment after the outer close, stay on the fast
        // path.
        let nested = "foo: {a: {b: c}, d: e}\nsecret: real\n";
        assert!(yaml::from_str::<YamlValue>(nested).is_ok());
        assert_eq!(
            extract_top_level_scalar_fast(nested, "secret"),
            Some("real")
        );
        let commented = "proxies:\n- {name: a} # first\nsecret: real\n";
        assert!(yaml::from_str::<YamlValue>(commented).is_ok());
        assert_eq!(
            extract_top_level_scalar_fast(commented, "secret"),
            Some("real")
        );
    }

    #[test]
    fn test_fast_path_quoted_value_trailing_junk() {
        // Junk after a quoted scalar on the same line is an error to
        // the parser; neither scanner may read past such a line.
        for doc in [
            "other: \"a\" b: c\nsecret: real\n",
            "other: 'a' b: c\nsecret: real\n",
        ] {
            assert!(yaml::from_str::<YamlValue>(doc).is_err());
            assert_eq!(extract_top_level_scalar_fast(doc, "secret"), None);
            assert_eq!(extract_secret_from_yaml(doc), None);
        }
        let junk_in_tun_block = "tun:\n  note: \"a\" b: c\n  enable: true\n";
        assert!(yaml::from_str::<YamlValue>(junk_in_tun_block).is_err());
        assert_eq!(extract_tun_enabled_fast(junk_in_tun_block), None);
        assert!(!extract_tun_enabled_from_yaml(junk_in_tun_block));
        // A comment after the closing quote is fine and stays fast.
        let commented = "other: \"a\" # c\nsecret: real\n";
        assert!(yaml::from_str::<YamlValue>(commented).is_ok());
        assert_eq!(
            extract_top_level_scalar_fast(commented, "secret"),
            Some("real")
        );
    }

    #[test]
    fn test_fast_path_anchor_and_tag_keys_fall_back() {
        // A node property before a key applies to that key: `&a tun:`
        // IS the key `tun` to the parser, and `tun.enable` reads
        // true. The line scanners match keys literally, so they fall
        // back on any such line. (Measured against direct serde
        // lookups — the public extractors short-circuit through the
        // fast path, so comparing against them would be circular.)
        fn direct_tun(doc: &str) -> Option<bool> {
            yaml::from_str::<YamlValue>(doc).ok().and_then(|v| {
                v.get("tun")
                    .and_then(|t| t.get("enable"))
                    .and_then(YamlValue::as_bool)
            })
        }
        for doc in [
            "&a tun:\n  enable: true\n",
            "!!str tun:\n  enable: true\n",
            "tun:\n  &a enable: true\n",
        ] {
            assert_eq!(direct_tun(doc), Some(true));
            assert_eq!(extract_tun_enabled_fast(doc), None);
            assert!(extract_tun_enabled_from_yaml(doc));
        }
        // The anchored duplicate in the scalar scanner: the parser
        // rejects the document outright.
        let anchored_dup = "secret: a\n&x secret: b\n";
        assert!(yaml::from_str::<YamlValue>(anchored_dup).is_err());
        assert_eq!(extract_top_level_scalar_fast(anchored_dup, "secret"), None);
        assert_eq!(extract_secret_from_yaml(anchored_dup), None);
        // An anchor on the tun VALUE already fell back before.
        let anchored_value = "tun: &a\n  enable: true\n";
        assert_eq!(extract_tun_enabled_fast(anchored_value), None);
        assert!(extract_tun_enabled_from_yaml(anchored_value));
    }

    #[test]
    fn test_fast_path_root_kind_and_unterminated_quotes() {
        // The document root is one kind of block: a column-0 mapping
        // key after a root block sequence (or the reverse) is
        // malformed and the parser rejects the document.
        for doc in [
            "- x\nsecret: y\n",
            "secret: y\n- x\n",
            "- x\ntun:\n  enable: true\n",
        ] {
            assert!(yaml::from_str::<YamlValue>(doc).is_err());
            assert_eq!(extract_top_level_scalar_fast(doc, "secret"), None);
            assert_eq!(extract_secret_from_yaml(doc), None);
            assert_eq!(extract_tun_enabled_fast(doc), None);
            assert!(!extract_tun_enabled_from_yaml(doc));
        }

        // An unterminated quoted value continues on following lines,
        // and a continuation can sit at column 0 disguised as a key
        // line: here the `secret:` line is INSIDE foo's quoted
        // scalar for the parser, so there is no secret to extract.
        let hidden = "foo: \"start\nsecret: real\na: b\"\n";
        assert!(yaml::from_str::<YamlValue>(hidden).is_ok());
        assert_eq!(extract_top_level_scalar_fast(hidden, "secret"), None);
        assert_eq!(extract_secret_from_yaml(hidden), None);
        // The same inside a `tun:` block.
        let hidden_in_block = "tun:\n  note: \"abc\n  enable: true\n";
        assert_eq!(extract_tun_enabled_fast(hidden_in_block), None);
        assert!(!extract_tun_enabled_from_yaml(hidden_in_block));

        // A deeper line after a bare-scalar sequence entry may be a
        // legal scalar continuation or an entry the parser rejects;
        // the scanner cannot tell, so it falls back.
        let bare_entry = "proxies:\n- foo\n  x: y\nsecret: real\n";
        assert!(yaml::from_str::<YamlValue>(bare_entry).is_err());
        assert_eq!(extract_top_level_scalar_fast(bare_entry, "secret"), None);
        assert_eq!(extract_secret_from_yaml(bare_entry), None);

        // An apostrophe inside a plain scalar in a flow collection
        // is text, not a quote opening: the collection still closes
        // on the line and the fast path keeps working.
        let apostrophe = "foo: {name: don't, type: ss}\nsecret: real\n";
        assert!(yaml::from_str::<YamlValue>(apostrophe).is_ok());
        assert_eq!(
            extract_top_level_scalar_fast(apostrophe, "secret"),
            Some("real")
        );
    }

    #[test]
    fn test_fast_path_standalone_values_and_reserved_indicators() {
        // A standalone value line inside a block (plain, quoted, or
        // flow) completes the value above it; an entry line after it
        // at the same indentation is an error to the parser.
        for doc in [
            "foo:\n  \"bar\"\n  x: y\nsecret: real\n",
            "foo:\n  {a: 1}\n  x: y\nsecret: real\n",
        ] {
            assert!(yaml::from_str::<YamlValue>(doc).is_err());
            assert_eq!(extract_top_level_scalar_fast(doc, "secret"), None);
            assert_eq!(extract_secret_from_yaml(doc), None);
        }
        // A complete quoted-scalar sequence entry is a finished
        // value on its line; a deeper entry line after it is
        // malformed for the same reason.
        let quoted_entry = "proxies:\n- \"foo\"\n  x: y\nsecret: real\n";
        assert!(yaml::from_str::<YamlValue>(quoted_entry).is_err());
        assert_eq!(extract_top_level_scalar_fast(quoted_entry, "secret"), None);
        assert_eq!(extract_secret_from_yaml(quoted_entry), None);

        // A root flow sequence is not a block document: the keys
        // after it are not top-level entries.
        let flow_root = "[a: 1]\ntun:\n  enable: true\n";
        assert!(yaml::from_str::<YamlValue>(flow_root).is_err());
        assert_eq!(extract_tun_enabled_fast(flow_root), None);
        assert!(!extract_tun_enabled_from_yaml(flow_root));

        // A value opening with a character that cannot start a
        // token (`@`, backtick, `%`, `,`, `]`, `}`) is rejected by
        // the parser, on the target key and on any other line alike.
        for doc in [
            "secret: @abc\n",
            "secret: `abc\n",
            "secret: %abc\n",
            "secret: ,abc\n",
            "secret: ]abc\n",
            "secret: }abc\n",
            "other: @abc\nsecret: real\n",
        ] {
            assert!(yaml::from_str::<YamlValue>(doc).is_err());
            assert_eq!(extract_top_level_scalar_fast(doc, "secret"), None);
            assert_eq!(extract_secret_from_yaml(doc), None);
        }
    }

    #[test]
    fn test_fast_path_block_kinds_and_block_scalar_headers() {
        // Sibling lines within one block are all of one kind: a
        // sequence entry among mapping entries (or the reverse) is
        // malformed, at the block's own level, after deeper content,
        // and inside a `tun:` block alike.
        for doc in [
            "dns:\n  enable: true\n  - x\nsecret: real\n",
            "dns:\n  enable:\n    x: 1\n  - y\nsecret: real\n",
        ] {
            assert!(yaml::from_str::<YamlValue>(doc).is_err());
            assert_eq!(extract_top_level_scalar_fast(doc, "secret"), None);
            assert_eq!(extract_secret_from_yaml(doc), None);
        }
        let mixed_in_tun = "tun:\n  - x\n  enable: true\n";
        assert!(yaml::from_str::<YamlValue>(mixed_in_tun).is_err());
        assert_eq!(extract_tun_enabled_fast(mixed_in_tun), None);
        assert!(!extract_tun_enabled_from_yaml(mixed_in_tun));
        // Different top-level keys may still nest different kinds.
        let nested_kinds = "dns:\n  enable: true\nproxies:\n  - name: a\nsecret: real\n";
        assert!(yaml::from_str::<YamlValue>(nested_kinds).is_ok());
        assert_eq!(
            extract_top_level_scalar_fast(nested_kinds, "secret"),
            Some("real")
        );

        // A key that already received an indented block value cannot
        // take a column-0 sequence as its value afterwards.
        for doc in [
            "key:\n  nested: v\n- x\nsecret: real\n",
            "key:\n  a: b\n- x\ntun:\n  enable: true\n",
        ] {
            assert!(yaml::from_str::<YamlValue>(doc).is_err());
            assert_eq!(extract_top_level_scalar_fast(doc, "secret"), None);
            assert_eq!(extract_secret_from_yaml(doc), None);
            assert_eq!(extract_tun_enabled_fast(doc), None);
            assert!(!extract_tun_enabled_from_yaml(doc));
        }

        // A block scalar header with junk after it (`|x`) is an
        // error to the parser, as is a plain value behind an anchor
        // that contains a mapping colon.
        let header_junk_tun = "tun:\n  mode: |x\n  enable: true\n";
        assert!(yaml::from_str::<YamlValue>(header_junk_tun).is_err());
        assert_eq!(extract_tun_enabled_fast(header_junk_tun), None);
        assert!(!extract_tun_enabled_from_yaml(header_junk_tun));
        for doc in [
            "other: |x\nsecret: real\n",
            "other: &a b: c\nsecret: real\n",
        ] {
            assert!(yaml::from_str::<YamlValue>(doc).is_err());
            assert_eq!(extract_top_level_scalar_fast(doc, "secret"), None);
            assert_eq!(extract_secret_from_yaml(doc), None);
        }
        // Well-formed headers and anchored values stay valid.
        let anchored = "other: &a plain\nsecret: real\n";
        assert!(yaml::from_str::<YamlValue>(anchored).is_ok());
        assert_eq!(extract_secret_from_yaml(anchored).as_deref(), Some("real"));
    }

    #[test]
    fn test_fast_path_indentless_nested_sequences() {
        // An indentless sequence as the value of a nested key (the
        // layout emitters produce, e.g. under `dns-hijack:`) is a
        // sibling of the block's mapping entries, not a kind mix:
        // the fast paths keep working on it, including the document
        // shape `update_tun_in_yaml` itself emits.
        let hijack = "tun:\n  enable: true\n  dns-hijack:\n  - any:53\nsecret: real\n";
        assert!(yaml::from_str::<YamlValue>(hijack).is_ok());
        assert_eq!(extract_tun_enabled_fast(hijack), Some(true));
        assert_eq!(
            extract_top_level_scalar_fast(hijack, "secret"),
            Some("real")
        );
        let updated = update_tun_in_yaml("tun:\n  enable: false\n", true).unwrap();
        assert_eq!(extract_tun_enabled_fast(&updated), Some(true));
        // A mapping entry after a pure (non-indentless) sequence at
        // the same indentation is still malformed.
        let pure_mix = "proxies:\n  - a\n  x: y\nsecret: real\n";
        assert!(yaml::from_str::<YamlValue>(pure_mix).is_err());
        assert_eq!(extract_top_level_scalar_fast(pure_mix, "secret"), None);
        assert_eq!(extract_secret_from_yaml(pure_mix), None);
    }

    #[test]
    fn test_fast_path_frames_at_any_depth() {
        // A content line deeper than an inline-valued line at ANY
        // nesting level is the same ambiguous shape the top-level
        // tracking guards: the parser rejects such documents.
        let nested_deeper = "dns:\n  enable: true\n   x: y\nsecret: real\n";
        assert!(yaml::from_str::<YamlValue>(nested_deeper).is_err());
        assert_eq!(extract_top_level_scalar_fast(nested_deeper, "secret"), None);
        assert_eq!(extract_secret_from_yaml(nested_deeper), None);
        // The same shape ahead of a `tun:` block.
        let nested_deeper_tun = "dns:\n  enable: true\n   x: y\ntun:\n  enable: true\n";
        assert!(yaml::from_str::<YamlValue>(nested_deeper_tun).is_err());
        assert_eq!(extract_tun_enabled_fast(nested_deeper_tun), None);
        assert!(!extract_tun_enabled_from_yaml(nested_deeper_tun));

        // A plain value that itself contains a mapping colon is
        // rejected by the parser, at any depth and in sequence
        // entries alike; neither scanner may skip the line.
        for doc in [
            "dns:\n  enable: true x: y\nsecret: real\n",
            "proxies:\n- name: a bar: baz\nsecret: real\n",
            "secret: a: b\n",
        ] {
            assert!(yaml::from_str::<YamlValue>(doc).is_err());
            assert_eq!(extract_top_level_scalar_fast(doc, "secret"), None);
            assert_eq!(extract_secret_from_yaml(doc), None);
        }
        let colon_in_tun_block = "tun:\n  stack: a: b\n  enable: true\n";
        assert!(yaml::from_str::<YamlValue>(colon_in_tun_block).is_err());
        assert_eq!(extract_tun_enabled_fast(colon_in_tun_block), None);
        assert!(!extract_tun_enabled_from_yaml(colon_in_tun_block));
    }

    #[test]
    fn test_fast_path_quotes_flow_and_tab_prefixes() {
        // An interior quote in a plain key is ordinary text, not a
        // quoted span: the key still carries an inline value, so an
        // indented line after it falls back like any other.
        let interior_quote = "name 'x: y\n  secret: evil\nsecret: real\n";
        assert!(yaml::from_str::<YamlValue>(interior_quote).is_err());
        assert_eq!(
            extract_top_level_scalar_fast(interior_quote, "secret"),
            None
        );
        assert_eq!(extract_secret_from_yaml(interior_quote), None);

        // A document opening a multi-line flow collection is not a
        // block document: later lines are not top-level keys.
        let flow_doc = "{a: 1,\nsecret: real}\n";
        assert_eq!(
            extract_top_level_scalar_fast(flow_doc, "secret"),
            None,
            "flow documents fall back to the full parser"
        );
        assert_eq!(
            extract_secret_from_yaml(flow_doc).as_deref(),
            Some("real"),
            "the parser reads `secret` inside the flow mapping"
        );

        // A tab later in the indentation prefix (not just in first
        // position) is still tab indentation, which the parser
        // rejects wherever it appears.
        for doc in [
            "foo:\n \tsecret: x\nsecret: real\n",
            "foo:\n \tx: y\ntun:\n  enable: true\n",
            "tun:\n \tenable: true\n",
        ] {
            assert!(yaml::from_str::<YamlValue>(doc).is_err());
            assert_eq!(extract_top_level_scalar_fast(doc, "secret"), None);
            assert_eq!(extract_secret_from_yaml(doc), None);
            assert_eq!(extract_tun_enabled_fast(doc), None);
            assert!(!extract_tun_enabled_from_yaml(doc));
        }

        // Sanity: sequence entries still frame their content, so the
        // fast paths keep working on ordinary profile shapes.
        let ordinary = "proxies:\n- name: a\n  server: x\nsecret: real\ntun:\n  enable: true\n";
        assert_eq!(
            extract_top_level_scalar_fast(ordinary, "secret"),
            Some("real")
        );
        assert_eq!(extract_tun_enabled_fast(ordinary), Some(true));
    }

    #[test]
    fn test_fast_path_spaced_key_and_sequence_frames() {
        // A spaced twin of the requested key (`secret : x`) is the same
        // key to the parser, so the document defines it twice and the
        // parser rejects it; the fast path must fall back instead of
        // returning the first value.
        let spaced = "secret: real\nsecret : other\n";
        assert!(yaml::from_str::<YamlValue>(spaced).is_err());
        assert_eq!(extract_top_level_scalar_fast(spaced, "secret"), None);
        assert_eq!(extract_secret_from_yaml(spaced), None);
        assert_eq!(extract_mode_from_yaml("mode: rule\nmode : global\n"), None);

        // Sequence entries at column 0 (the usual layout under a key)
        // open their own frame: the indented lines that follow are the
        // entries' content, so the fast paths stay in play.
        let seq_secret = "proxies:\n- name: a\n  server: x\nsecret: abc\n";
        assert_eq!(
            extract_top_level_scalar_fast(seq_secret, "secret"),
            Some("abc")
        );
        let seq_tun = "proxies:\n- name: a\n  server: x\ntun:\n  enable: true\n";
        assert_eq!(extract_tun_enabled_fast(seq_tun), Some(true));

        // A double-quoted key split by a backslash line-break is not a
        // hidden `tun` for this parser: serde_yaml rejects such
        // documents outright, and the fast path's "disabled" agrees.
        assert!(yaml::from_str::<YamlValue>("\"tu\\\nn\":\n  enable: true\n").is_err());
        assert!(!extract_tun_enabled_from_yaml(
            "\"tu\\\nn\":\n  enable: true\n"
        ));

        // A colon inside a quoted key is part of the key, not the
        // separator: `"other:#": foo` carries an inline value, so the
        // malformed indented line after it must force the fallback —
        // the parser rejects these documents.
        let quoted_secret = "\"other:#\": foo\n  bar: baz\nsecret: real\n";
        assert!(yaml::from_str::<YamlValue>(quoted_secret).is_err());
        assert_eq!(extract_top_level_scalar_fast(quoted_secret, "secret"), None);
        assert_eq!(extract_secret_from_yaml(quoted_secret), None);
        let quoted_tun = "\"other:#\": foo\n  bar: baz\ntun:\n  enable: true\n";
        assert!(yaml::from_str::<YamlValue>(quoted_tun).is_err());
        assert_eq!(extract_tun_enabled_fast(quoted_tun), None);
        assert!(!extract_tun_enabled_from_yaml(quoted_tun));
        // …while an apostrophe inside a plain key starts no quoted
        // span, so `don't` still counts as an inline-valued key.
        assert!(key_line_has_inline_value("don't: panic"));
        assert!(key_line_has_inline_value("\"a:#\": v"));
        assert!(!key_line_has_inline_value("tun: # comment only"));
    }

    // Direct serde queries are the reference for the fast paths.
    // The public wrappers cannot serve: they try the fast path
    // first, so comparing against them would compare the fast path
    // with itself.
    fn direct_secret(content: &str) -> Option<String> {
        let value: YamlValue = yaml::from_str(content).ok()?;
        value
            .get("secret")
            .and_then(|v| v.as_str())
            .map(str::to_owned)
    }

    fn direct_tun_enabled(content: &str) -> bool {
        let Ok(value) = yaml::from_str::<YamlValue>(content) else {
            return false;
        };
        value
            .get("tun")
            .and_then(|tun| tun.get("enable"))
            .and_then(YamlValue::as_bool)
            .unwrap_or(false)
    }

    #[test]
    fn test_fast_path_sequence_entry_first_key_frames() {
        // A dash at the column of a sequence entry's first key after
        // that key carried an inline value is malformed: the parser
        // expects another key there and rejects the document, so
        // both scanners fall back.
        let doc = "proxies:\n- name: a\n  - x\nsecret: real\n";
        assert_eq!(direct_secret(doc), None);
        assert_eq!(extract_top_level_scalar_fast(doc, "secret"), None);
        let doc_tun = "tun:\n  proxies:\n  - name: a\n    - x\n  enable: true\n";
        assert!(!direct_tun_enabled(doc_tun));
        assert_eq!(extract_tun_enabled_fast(doc_tun), None);

        // The same shapes stay on the fast path when the first key
        // carries no inline value (the dash line is its indentless
        // sequence) or when the column carries another key of the
        // entry's mapping instead of a dash.
        let doc = "proxies:\n- name:\n  - x\nsecret: real\n";
        assert_eq!(direct_secret(doc).as_deref(), Some("real"));
        assert_eq!(extract_top_level_scalar_fast(doc, "secret"), Some("real"));
        let doc = "proxies:\n- name: a\n  port: 1\nsecret: real\n";
        assert_eq!(extract_top_level_scalar_fast(doc, "secret"), Some("real"));

        // Measured parity for two shapes reviewers flagged: a `#`
        // glued to a flow value's closing brace is accepted by the
        // parser (both paths agree), and an explicit key inside a
        // sequence entry already falls back.
        let doc = "mode: {a: b}#junk\nsecret: real\n";
        assert_eq!(direct_secret(doc).as_deref(), Some("real"));
        assert_eq!(extract_top_level_scalar_fast(doc, "secret"), Some("real"));
        assert_eq!(
            extract_top_level_scalar_fast("- ? a: b\nsecret: real\n", "secret"),
            None
        );
    }

    #[test]
    fn test_fast_path_indicator_led_values_and_tab_comments() {
        // A block-structure indicator cannot open an inline value:
        // the parser rejects the document, so both scanners fall
        // back — including when the malformed key is the requested
        // one itself.
        for doc in [
            "other: - x\nsecret: real\n",
            "secret: - x\n",
            "other: ? x\nsecret: real\n",
            "other: : x\nsecret: real\n",
            "other: -\nsecret: real\n",
        ] {
            assert_eq!(direct_secret(doc), None, "{doc:?}");
            assert_eq!(
                extract_top_level_scalar_fast(doc, "secret"),
                None,
                "{doc:?}"
            );
        }
        let doc = "other: - x\ntun:\n  enable: true\n";
        assert!(!direct_tun_enabled(doc));
        assert_eq!(extract_tun_enabled_fast(doc), None);

        // Extra spaces after a sequence dash are separation, not
        // content: a reserved indicator behind them still opens the
        // entry, and the parser rejects it.
        let doc = "proxies:\n-  @abc\nsecret: real\n";
        assert_eq!(direct_secret(doc), None);
        assert_eq!(extract_top_level_scalar_fast(doc, "secret"), None);

        // A comment line whose indentation opens with a tab is
        // rejected by the parser; a space before the tab is fine
        // and stays on the fast path.
        let doc = "mode: rule\n\t# comment\nsecret: real\n";
        assert_eq!(direct_secret(doc), None);
        assert_eq!(extract_top_level_scalar_fast(doc, "secret"), None);
        let doc = "mode: rule\n \t# comment\nsecret: real\n";
        assert_eq!(direct_secret(doc).as_deref(), Some("real"));
        assert_eq!(extract_top_level_scalar_fast(doc, "secret"), Some("real"));
    }

    #[test]
    fn test_fast_path_dedents_and_sequence_entry_content() {
        // A dedent that lands on an indentation no open block uses
        // (or below every open level) is rejected by the parser;
        // the scanners fall back. Legal dedents back to an open
        // level stay on the fast path.
        for doc in [
            "foo:\n    a: 1\n  b: 2\nsecret: real\n",
            "foo:\n  a:\n      x: 1\n    y: 2\nsecret: real\n",
        ] {
            assert_eq!(direct_secret(doc), None, "{doc:?}");
            assert_eq!(
                extract_top_level_scalar_fast(doc, "secret"),
                None,
                "{doc:?}"
            );
        }
        for doc in [
            "foo:\n  a: 1\n  b: 2\nsecret: real\n",
            "foo:\n  a:\n    x: 1\n  b: 2\nsecret: real\n",
        ] {
            assert_eq!(direct_secret(doc).as_deref(), Some("real"), "{doc:?}");
            assert_eq!(
                extract_top_level_scalar_fast(doc, "secret"),
                Some("real"),
                "{doc:?}"
            );
        }

        // An explicit key or an unclosed flow collection hidden
        // behind a sequence dash is for the full parser (which
        // rejects these documents), wherever the entry appears.
        for doc in [
            "- ? [unterminated\nsecret: real\n",
            "- ? a: b\nsecret: real\n",
            "proxies:\n- ? [unterminated\nsecret: real\n",
            "proxies:\n- [unterminated\nsecret: real\n",
        ] {
            assert_eq!(direct_secret(doc), None, "{doc:?}");
            assert_eq!(
                extract_top_level_scalar_fast(doc, "secret"),
                None,
                "{doc:?}"
            );
        }
    }

    #[test]
    fn test_fast_path_flow_empty_entries_and_quoted_key_shapes() {
        // An empty entry inside a flow collection (`{a: b,,}`,
        // `[1,, 2]`) is rejected by the parser, so both scanners
        // fall back even though the brackets balance. A trailing
        // comma, a key without a value, and separators inside
        // quotes are all legal and stay on the fast path.
        for doc in [
            "other: {a: b,, c: d}\nsecret: real\n",
            "other: [1,, 2]\nsecret: real\n",
            "other: {a: b,,}\nsecret: real\n",
        ] {
            assert_eq!(direct_secret(doc), None, "{doc:?}");
            assert_eq!(
                extract_top_level_scalar_fast(doc, "secret"),
                None,
                "{doc:?}"
            );
        }
        for doc in [
            "other: {a: b,}\nsecret: real\n",
            "other: {a b}\nsecret: real\n",
            "other: {a: 'x,,y'}\nsecret: real\n",
        ] {
            assert_eq!(direct_secret(doc).as_deref(), Some("real"), "{doc:?}");
            assert_eq!(
                extract_top_level_scalar_fast(doc, "secret"),
                Some("real"),
                "{doc:?}"
            );
        }
        let doc = "other: {a: b,, c: d}\ntun:\n  enable: true\n";
        assert!(!direct_tun_enabled(doc));
        assert_eq!(extract_tun_enabled_fast(doc), None);

        // A quoted scalar at the key position must be followed by
        // the separator colon; junk in between (`"other" x: y`) is
        // rejected by the parser, at any depth and in both
        // scanners, while a properly formed quoted key is legal.
        for doc in [
            "\"other\" x: y\nsecret: real\n",
            "'other' x: y\nsecret: real\n",
            "foo:\n  \"other\" x: y\nsecret: real\n",
        ] {
            assert_eq!(direct_secret(doc), None, "{doc:?}");
            assert_eq!(
                extract_top_level_scalar_fast(doc, "secret"),
                None,
                "{doc:?}"
            );
        }
        for doc in [
            "\"other\": y\nsecret: real\n",
            "\"other\" : y\nsecret: real\n",
        ] {
            assert_eq!(direct_secret(doc).as_deref(), Some("real"), "{doc:?}");
            assert_eq!(
                extract_top_level_scalar_fast(doc, "secret"),
                Some("real"),
                "{doc:?}"
            );
        }
        let doc = "\"other\" x: y\ntun:\n  enable: true\n";
        assert!(!direct_tun_enabled(doc));
        assert_eq!(extract_tun_enabled_fast(doc), None);
    }

    #[test]
    fn test_fast_path_aliases_dash_tab_and_empty_items() {
        // An alias naming an anchor not yet defined is malformed
        // (the parser rejects undefined and forward references
        // alike), wherever it appears; an alias to an anchor
        // defined earlier is legal and stays on the fast path.
        for doc in [
            "secret: abc\nfoo: *missing\n",
            "secret: abc\nfoo: *a\nbar: &a x\n",
        ] {
            assert_eq!(direct_secret(doc), None, "{doc:?}");
            assert_eq!(
                extract_top_level_scalar_fast(doc, "secret"),
                None,
                "{doc:?}"
            );
        }
        let doc = "secret: abc\nfoo: &a x\nbar: *a\n";
        assert_eq!(direct_secret(doc).as_deref(), Some("abc"));
        assert_eq!(extract_top_level_scalar_fast(doc, "secret"), Some("abc"));
        let doc = "tun:\n  enable: true\n  foo: *missing\n";
        assert!(!direct_tun_enabled(doc));
        assert_eq!(extract_tun_enabled_fast(doc), None);

        // A tab after the dash is separation too: `-\t…` is a
        // sequence entry to the parser, so it cannot appear inside
        // a mapping root.
        let doc = "secret: good\n-\tother: value\n";
        assert_eq!(direct_secret(doc), None);
        assert_eq!(extract_top_level_scalar_fast(doc, "secret"), None);

        // An empty sequence item is still awaiting its value; its
        // indented content is ordinary nested content, so the
        // document stays on the fast path.
        let doc = "items:\n- \n  name: x\nsecret: real\n";
        assert_eq!(direct_secret(doc).as_deref(), Some("real"));
        assert_eq!(extract_top_level_scalar_fast(doc, "secret"), Some("real"));
    }

    #[test]
    fn test_fast_path_dash_tab_entries_and_unicode_whitespace() {
        // A tab after the dash is separation too, at any depth: an
        // indented `-\t…` line is a sequence entry, so it cannot be
        // mixed with mapping entries at one level, and an explicit
        // key behind it is still an explicit key.
        for doc in [
            "foo:\n  -\ta: b\n  c: d\nsecret: real\n",
            "foo:\n  -\t? x\nsecret: real\n",
        ] {
            assert_eq!(direct_secret(doc), None, "{doc:?}");
            assert_eq!(
                extract_top_level_scalar_fast(doc, "secret"),
                None,
                "{doc:?}"
            );
        }

        // Non-ASCII whitespace (NBSP, ideographic space) is content
        // to the parser but whitespace to Rust's `trim` family, so
        // any document containing it leaves the fast paths: the
        // NBSP after `true` makes the value a string (not a bool),
        // an NBSP before `enable:` is not indentation, and an NBSP
        // trailing a secret is part of the secret.
        let doc = "secret: abc\u{a0}\n";
        assert_eq!(
            direct_secret(doc).as_deref(),
            Some("abc\u{a0}"),
            "parser keeps the NBSP in the scalar"
        );
        assert_eq!(extract_top_level_scalar_fast(doc, "secret"), None);
        assert_eq!(
            extract_top_level_scalar_fast("secret: abc\u{3000}\n", "secret"),
            None
        );
        let doc = "tun:\n  enable: true\u{a0}\n";
        assert!(!direct_tun_enabled(doc));
        assert_eq!(extract_tun_enabled_fast(doc), None);
        let doc = "tun:\n\u{a0}enable: true\n";
        assert!(!direct_tun_enabled(doc));
        assert_eq!(extract_tun_enabled_fast(doc), None);
    }

    #[test]
    fn test_fast_path_breaking_characters_and_flow_commas() {
        // A lone carriage return is a line break to the parser: it
        // can end a comment and expose a duplicate key the scanners
        // (which split on `\n`/`\r\n` only) would never see. CRLF
        // pairs are fine and stay on the fast path.
        let doc = "secret: real #c\rsecret: other\n";
        assert_eq!(direct_secret(doc), None);
        assert_eq!(extract_top_level_scalar_fast(doc, "secret"), None);
        let doc = "secret: real\r\nfoo: bar\n";
        assert_eq!(direct_secret(doc).as_deref(), Some("real"));
        assert_eq!(extract_top_level_scalar_fast(doc, "secret"), Some("real"));

        // Two flow mapping pairs without the comma between them
        // are rejected by the parser; comma-separated pairs,
        // single-pair sequence entries, nested collections, and
        // colons inside plain scalars are all legal.
        let doc = "foo: {a: b c: d}\nsecret: real\n";
        assert_eq!(direct_secret(doc), None);
        assert_eq!(extract_top_level_scalar_fast(doc, "secret"), None);
        for doc in [
            "foo: {a: http://x}\nsecret: real\n",
            "foo: {a: b, c: d}\nsecret: real\n",
            "foo: [a: b, c: d]\nsecret: real\n",
            "foo: {a: {b: c}}\nsecret: real\n",
        ] {
            assert_eq!(direct_secret(doc).as_deref(), Some("real"), "{doc:?}");
            assert_eq!(
                extract_top_level_scalar_fast(doc, "secret"),
                Some("real"),
                "{doc:?}"
            );
        }

        // A lone `&` has no anchor name; the parser rejects it
        // rather than treating it as a bare anchor.
        let doc = "foo: &\nsecret: real\n";
        assert_eq!(direct_secret(doc), None);
        assert_eq!(extract_top_level_scalar_fast(doc, "secret"), None);

        // Tabs in the separation after a sequence dash hide
        // nothing: a reserved indicator or an explicit key behind
        // them is still what the parser sees.
        for doc in [
            "items:\n- \t@abc\nsecret: real\n",
            "items:\n- \t? x\nsecret: real\n",
        ] {
            assert_eq!(direct_secret(doc), None, "{doc:?}");
            assert_eq!(
                extract_top_level_scalar_fast(doc, "secret"),
                None,
                "{doc:?}"
            );
        }
    }

    #[test]
    fn test_fast_path_flow_reserved_indicators() {
        // A reserved indicator (`@`, backtick) opening a flow
        // token is rejected by the parser, wherever the collection
        // sits; the same characters inside a plain scalar or a
        // quoted span are ordinary content and stay fast.
        for doc in [
            "foo: {a: [@]}\nsecret: real\n",
            "foo: [@]\nsecret: real\n",
            "foo: {a: `@`}\nsecret: real\n",
        ] {
            assert_eq!(direct_secret(doc), None, "{doc:?}");
            assert_eq!(
                extract_top_level_scalar_fast(doc, "secret"),
                None,
                "{doc:?}"
            );
        }
        for doc in [
            "foo: {a: x@y}\nsecret: real\n",
            "foo: {a: 'x@y'}\nsecret: real\n",
            "foo: {a: 100%}\nsecret: real\n",
        ] {
            assert_eq!(direct_secret(doc).as_deref(), Some("real"), "{doc:?}");
            assert_eq!(
                extract_top_level_scalar_fast(doc, "secret"),
                Some("real"),
                "{doc:?}"
            );
        }
    }

    #[test]
    fn test_fast_path_flow_adjacent_nodes() {
        // Two nodes in one flow entry without a separator
        // (`{a: "x" "y"}`, `["a" "b"]`, `{a: "x" y}`) are rejected
        // by the parser; comma-separated nodes and quoted pairs
        // are legal and stay on the fast path.
        for doc in [
            "secret: good\nother: {a: \"x\" \"y\"}\n",
            "other: [\"a\" \"b\"]\nsecret: real\n",
            "other: {a: \"x\" y}\nsecret: real\n",
        ] {
            assert_eq!(direct_secret(doc), None, "{doc:?}");
            assert_eq!(
                extract_top_level_scalar_fast(doc, "secret"),
                None,
                "{doc:?}"
            );
        }
        for doc in [
            "other: {\"x\": \"y\"}\nsecret: real\n",
            "other: [\"a\", \"b\"]\nsecret: real\n",
            "other: {a: \"x\", b: \"y\"}\nsecret: real\n",
        ] {
            assert_eq!(direct_secret(doc).as_deref(), Some("real"), "{doc:?}");
            assert_eq!(
                extract_top_level_scalar_fast(doc, "secret"),
                Some("real"),
                "{doc:?}"
            );
        }

        // Measured parity, against a review claim: a comment
        // glued to a block-scalar indicator (`|#…`) is accepted by
        // the parser, so both paths read past it.
        let doc = "other: |#bad\nsecret: real\n";
        assert_eq!(direct_secret(doc).as_deref(), Some("real"));
        assert_eq!(extract_top_level_scalar_fast(doc, "secret"), Some("real"));
    }

    #[test]
    fn test_fast_path_flow_adjacent_collections_and_spaced_dashes() {
        // Adjacent nested collections without a comma are two
        // nodes in one entry; the parser rejects them. The
        // comma-separated forms are legal.
        for doc in [
            "other: [{} {}]\nsecret: real\n",
            "other: [[1] [2]]\nsecret: real\n",
            "other: [{a: 1} {b: 2}]\nsecret: real\n",
        ] {
            assert_eq!(direct_secret(doc), None, "{doc:?}");
            assert_eq!(
                extract_top_level_scalar_fast(doc, "secret"),
                None,
                "{doc:?}"
            );
        }
        for doc in [
            "other: [[1], [2]]\nsecret: real\n",
            "other: [{}, {}]\nsecret: real\n",
        ] {
            assert_eq!(direct_secret(doc).as_deref(), Some("real"), "{doc:?}");
            assert_eq!(
                extract_top_level_scalar_fast(doc, "secret"),
                Some("real"),
                "{doc:?}"
            );
        }

        // Extra spaces after a sequence dash move the entry's
        // first key to its actual column: a field aligned with it
        // is ordinary content (and stays on the fast path), while
        // a field back at the dash-plus-one column closes the
        // entry mapping early, which the parser rejects.
        let doc = "proxies:\n-   name: a\n    server: x\nsecret: real\n";
        assert_eq!(direct_secret(doc).as_deref(), Some("real"));
        assert_eq!(extract_top_level_scalar_fast(doc, "secret"), Some("real"));
        let doc = "proxies:\n-   name: a\n  port: 1\nsecret: real\n";
        assert_eq!(direct_secret(doc), None);
        assert_eq!(extract_top_level_scalar_fast(doc, "secret"), None);
    }

    #[test]
    fn test_fast_path_flow_aliases() {
        // Aliases inside flow collections obey the same rule as
        // block values: the anchor must be defined earlier in the
        // document (a definition inside the same collection, or in
        // an earlier block value, counts). Quoted or mid-scalar
        // asterisks are ordinary content.
        for doc in [
            "foo: [*missing]\nsecret: real\n",
            "foo: [*a]\nbar: &a x\nsecret: real\n",
        ] {
            assert_eq!(direct_secret(doc), None, "{doc:?}");
            assert_eq!(
                extract_top_level_scalar_fast(doc, "secret"),
                None,
                "{doc:?}"
            );
        }
        for doc in [
            "foo: &a x\nbar: [*a]\nsecret: real\n",
            "foo: {&a k: v}\nbar: *a\nsecret: real\n",
            "foo: [&a x, *a]\nsecret: real\n",
            "foo: [x*y]\nsecret: real\n",
            "foo: ['*missing']\nsecret: real\n",
        ] {
            assert_eq!(direct_secret(doc).as_deref(), Some("real"), "{doc:?}");
            assert_eq!(
                extract_top_level_scalar_fast(doc, "secret"),
                Some("real"),
                "{doc:?}"
            );
        }
        let doc = "tun:\n  enable: true\n  foo: [*missing]\n";
        assert!(!direct_tun_enabled(doc));
        assert_eq!(extract_tun_enabled_fast(doc), None);
    }

    #[test]
    fn test_fast_path_duplicate_keys_anywhere() {
        // The parser rejects a repeated key anywhere in a
        // mapping — a duplicate of an unrelated key, at any
        // level, in block or flow form, invalidates the whole
        // document, not just a repeat of the extracted key.
        for doc in [
            "secret: x\nport: 1\nport: 2\n",
            "foo:\n  a: 1\n  a: 2\nsecret: real\n",
            "foo: {a: 1, a: 2}\nsecret: real\n",
            "foo: {\"a\": 1, \"a\": 2}\nsecret: real\n",
            // A flow token cannot start with `%`, and content
            // may not follow an alias without a separator.
            "foo: [%abc]\nsecret: real\n",
            "foo: &a x\nbar: [*a x]\nsecret: real\n",
            "bar: [&b *missing]\nsecret: real\n",
        ] {
            assert_eq!(direct_secret(doc), None, "{doc:?}");
            assert_eq!(
                extract_top_level_scalar_fast(doc, "secret"),
                None,
                "{doc:?}"
            );
        }
        // Distinct keys are fine, and single-pair entries in a
        // sequence are separate mappings, not repeats.
        for doc in [
            "foo: {a: 1, b: 2}\nsecret: real\n",
            "foo: [a: 1, a: 2]\nsecret: real\n",
            "foo: [{a: 1}, {a: 2}]\nsecret: real\n",
        ] {
            assert_eq!(direct_secret(doc).as_deref(), Some("real"), "{doc:?}");
            assert_eq!(
                extract_top_level_scalar_fast(doc, "secret"),
                Some("real"),
                "{doc:?}"
            );
        }
        for doc in [
            "tun:\n  enable: true\n  dns: a\n  dns: b\n",
            "port: 1\nport: 2\ntun:\n  enable: true\n",
            "tun:\n  enable: true\n  dns:\n    a: 1\n    a: 2\n",
        ] {
            assert!(!direct_tun_enabled(doc), "{doc:?}");
            assert_eq!(extract_tun_enabled_fast(doc), None, "{doc:?}");
        }
    }

    #[test]
    fn test_fast_path_duplicate_key_spellings() {
        // Duplicate detection compares decoded keys: a quoted
        // key written with escapes (`"b\x61r"`, `'a''b'`, a
        // tagged or anchored flow key) can spell the same key
        // as another entry, and raw comparison would miss the
        // repeat — such keys force the full parser instead.
        for doc in [
            "foo:\n  bar: 1\n  \"b\\x61r\": 2\nsecret: real\n",
            "foo:\n  a'b: 1\n  'a''b': 2\nsecret: real\n",
            "foo: {a: 1, !!str a: 2}\nsecret: real\n",
            "foo: {\"a\": 1, \"\\u0061\": 2}\nsecret: real\n",
            "foo: {&x a: 1, &y a: 2}\nsecret: real\n",
            "foo: {&x a: 1, a: 2}\nsecret: real\n",
        ] {
            assert_eq!(direct_secret(doc), None, "{doc:?}");
            assert_eq!(
                extract_top_level_scalar_fast(doc, "secret"),
                None,
                "{doc:?}"
            );
        }
        // An anchored key with a distinct name is ordinary.
        let doc = "foo: {&x a: 1, b: 2}\nsecret: real\n";
        assert_eq!(direct_secret(doc).as_deref(), Some("real"));
        assert_eq!(extract_top_level_scalar_fast(doc, "secret"), Some("real"));
        let doc = "tun:\n  enable: true\n'a''b': first\n\"a'b\": second\n";
        assert!(!direct_tun_enabled(doc));
        assert_eq!(extract_tun_enabled_fast(doc), None);
    }

    #[test]
    fn test_fast_path_duplicate_keys_typed_and_aliased() {
        // Keys the parser compares as typed values or resolved
        // nodes can repeat under a different spelling: boolean
        // keys in different cases, and a flow key written as an
        // alias of an anchored key. Nested repeats at any depth
        // (inside a block, inside a sequence entry, inside the
        // tun block) are likewise rejected by the parser.
        for doc in [
            "true: a\nTRUE: b\nsecret: real\n",
            "other: {&a k: 1, *a : 2}\nsecret: real\n",
            "other: {&a k: 1, *a: 2}\nsecret: real\n",
            "secret: abc\nproxies:\n  - name: a\n    name: b\n",
            "foo:\n  bar:\n    a: 1\n    a: 2\nsecret: real\n",
            "foo:\n  bar: 1\n  baz:\n    x: 1\n  bar: 2\nsecret: real\n",
        ] {
            assert_eq!(direct_secret(doc), None, "{doc:?}");
            assert_eq!(
                extract_top_level_scalar_fast(doc, "secret"),
                None,
                "{doc:?}"
            );
        }
        for doc in [
            "tun:\n  stack: system\n  stack: gvisor\n  enable: true\n",
            "tun:\n  dns:\n    a: 1\n  dns: b\n  enable: true\n",
        ] {
            assert!(!direct_tun_enabled(doc), "{doc:?}");
            assert_eq!(extract_tun_enabled_fast(doc), None, "{doc:?}");
        }
        // `1` and `01` are different keys to the parser (an
        // integer and a string); the fast path bows out over
        // the typed `1` key and the full parser still answers.
        let doc = "foo:\n  1: a\n  01: b\nsecret: real\n";
        assert_eq!(direct_secret(doc).as_deref(), Some("real"));
        assert_eq!(extract_secret_from_yaml(doc).as_deref(), Some("real"));
    }

    #[test]
    fn test_fast_path_breaking_characters_and_flow_comments() {
        // Non-printable characters are rejected by the parser
        // anywhere in the stream, and a `#` right after a flow
        // opener or comma starts a comment (so the bracket
        // inside it never closes the collection).
        for doc in [
            "secret: abc\u{1}\n",
            "# comment \u{7f}\nsecret: real\n",
            "secret: real\u{fffe}\n",
            "foo: [#x]\nsecret: real\n",
            "foo: {#x}\nsecret: real\n",
        ] {
            assert_eq!(direct_secret(doc), None, "{doc:?}");
            assert_eq!(
                extract_top_level_scalar_fast(doc, "secret"),
                None,
                "{doc:?}"
            );
        }
        // An anchor on an empty flow entry is an anchored null
        // to the parser, in block and flow form alike.
        for doc in [
            "foo: [&a,]\nsecret: real\n",
            "foo: [&a]\nsecret: real\n",
            "foo: &a\nsecret: real\n",
        ] {
            assert_eq!(direct_secret(doc).as_deref(), Some("real"), "{doc:?}");
            assert_eq!(
                extract_top_level_scalar_fast(doc, "secret"),
                Some("real"),
                "{doc:?}"
            );
        }
        let doc = "tun:\n  other: [&a,]\n  enable: true\n";
        assert!(direct_tun_enabled(doc));
        assert_eq!(extract_tun_enabled_fast(doc), Some(true));
    }

    #[test]
    fn test_fast_path_flow_block_scalar_indicators() {
        // Block scalars cannot appear in flow context: an
        // indicator where a flow node begins is malformed,
        // while the same characters inside a plain scalar are
        // ordinary content.
        for doc in [
            "foo: [|]\nsecret: real\n",
            "foo: [>]\nsecret: real\n",
            "foo: {a: |}\nsecret: real\n",
        ] {
            assert_eq!(direct_secret(doc), None, "{doc:?}");
            assert_eq!(
                extract_top_level_scalar_fast(doc, "secret"),
                None,
                "{doc:?}"
            );
        }
        for doc in ["foo: [a|b]\nsecret: real\n", "foo: [a > b]\nsecret: real\n"] {
            assert_eq!(direct_secret(doc).as_deref(), Some("real"), "{doc:?}");
            assert_eq!(
                extract_top_level_scalar_fast(doc, "secret"),
                Some("real"),
                "{doc:?}"
            );
        }
    }

    #[test]
    fn test_fast_path_yaml_parity_edge_cases() {
        // YAML 1.2 core schema accepts only these six bool spellings;
        // mixed-case or 1.1-only spellings are strings to the full
        // parser → disabled.
        assert!(extract_tun_enabled_from_yaml("tun:\n  enable: True\n"));
        assert!(extract_tun_enabled_from_yaml("tun:\n  enable: TRUE\n"));
        assert!(!extract_tun_enabled_from_yaml("tun:\n  enable: FALSE\n"));
        assert!(!extract_tun_enabled_from_yaml("tun:\n  enable: tRuE\n"));
        assert!(!extract_tun_enabled_from_yaml("tun:\n  enable: yes\n"));
        // Explicit mapping keys (`? key` / `: value`) are legal YAML the
        // scanner cannot parse → fall back to the full parser.
        assert!(extract_tun_enabled_from_yaml(
            "tun:\n  ? enable\n  : true\n"
        ));
        assert!(!extract_tun_enabled_from_yaml("? tun\n: enable\n"));
        // Explicit keys in the top-level scalar scanner fall back too.
        assert_eq!(
            extract_secret_from_yaml("? secret\n: xyz\n"),
            Some("xyz".to_owned())
        );
        // A dedent to a level that is neither the top level nor the child
        // level is invalid YAML: the full parser errors → disabled, so the
        // fast path must fall back instead of returning the earlier value.
        assert!(!extract_tun_enabled_from_yaml(
            "tun:\n    enable: true\n  oops: 1\n"
        ));
    }
}

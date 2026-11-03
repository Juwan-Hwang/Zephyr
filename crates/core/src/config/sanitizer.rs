//! Configuration file sanitizer — platform-agnostic security validation.
//!
//! Migrated from `src-tauri/src/core/config_sanitizer.rs` for cross-platform reuse.

use std::path::{Component, Path, PathBuf, Prefix};

/// Maximum recursion depth for YAML processing to prevent stack overflow attacks.
const MAX_YAML_DEPTH: usize = 100;

/// Top-level mihomo keys that open or expose an additional control surface.
///
/// The desktop app manages the controller itself (it pins `external-controller`
/// to loopback and injects its own `secret`), so none of these keys is ever
/// legitimately supplied by a subscription, an imported profile, or a patch:
///
/// - `external-controller-unix` / `external-controller-pipe`: the REST API over a
///   unix socket / named pipe, which mihomo serves **without** checking `secret`.
/// - `external-controller-tls`: a second (TLS) listener for the REST API that can
///   bind to any address.
/// - `external-controller-cors`: relaxes the browser origin checks on the API.
/// - `external-doh-server`: a `DoH` endpoint on the controller that does not check
///   `secret`.
/// - `external-ui`, `external-ui-url`, `external-ui-name`: serve (and download)
///   arbitrary web UI content from the controller origin.
pub const CONTROL_PLANE_KEYS: &[&str] = &[
    "external-controller-unix",
    "external-controller-pipe",
    "external-controller-tls",
    "external-controller-cors",
    "external-doh-server",
    "external-ui",
    "external-ui-url",
    "external-ui-name",
];

/// YAML merge key. `serde_yaml` keeps it as a plain key, but mihomo's YAML
/// decoder resolves it, so keys hidden inside a top-level merge source still
/// land at the top level of the effective config.
const YAML_MERGE_KEY: &str = "<<";

/// The string a mapping key resolves to, looking through explicit YAML tags.
///
/// mihomo's YAML decoder resolves `!!str external-controller-unix` (or a
/// custom-tagged scalar) to the plain key, so a key that `serde_yaml` keeps as
/// [`serde_yaml::Value::Tagged`] must be matched by its inner string too.
#[allow(clippy::wildcard_enum_match_arm)]
pub(crate) fn resolved_key_str(key: &serde_yaml::Value) -> Option<&str> {
    match key {
        serde_yaml::Value::String(s) => Some(s.as_str()),
        serde_yaml::Value::Tagged(tagged) => resolved_key_str(&tagged.value),
        _ => None,
    }
}

/// Remove every entry whose (tag-resolved) key is one of `names`.
pub(crate) fn remove_keys_resolved(map: &mut serde_yaml::Mapping, names: &[&str]) {
    map.retain(|k, _| resolved_key_str(k).is_none_or(|s| !names.contains(&s)));
}

/// Remove [`CONTROL_PLANE_KEYS`] from a top-level mapping, following any
/// `<<` merge sources (which mihomo flattens into the same mapping).
fn strip_control_plane_mapping(map: &mut serde_yaml::Mapping, depth: usize) {
    remove_keys_resolved(map, CONTROL_PLANE_KEYS);
    for (key, merge_source) in map.iter_mut() {
        if resolved_key_str(key) == Some(YAML_MERGE_KEY) {
            strip_control_plane_merge_source(merge_source, depth + 1);
        }
    }
}

#[allow(clippy::wildcard_enum_match_arm)]
fn strip_control_plane_merge_source(value: &mut serde_yaml::Value, depth: usize) {
    if depth > MAX_YAML_DEPTH {
        *value = serde_yaml::Value::Null;
        return;
    }
    match value {
        serde_yaml::Value::Mapping(map) => strip_control_plane_mapping(map, depth),
        serde_yaml::Value::Sequence(seq) => {
            for item in seq.iter_mut() {
                strip_control_plane_merge_source(item, depth + 1);
            }
        }
        serde_yaml::Value::Tagged(tagged) => {
            strip_control_plane_merge_source(&mut tagged.value, depth + 1);
        }
        _ => {}
    }
}

/// Remove keys that open unauthenticated or otherwise unmanaged controller
/// surfaces (see [`CONTROL_PLANE_KEYS`]) from the root of a mihomo config.
///
/// These keys are only meaningful at the top level of a config, so only the
/// root mapping (and any `<<` merge sources attached to it) is touched.
/// `external-controller` and `secret` are intentionally left alone: they are
/// managed by [`crate::config::merge::restore_security_settings`] and the
/// desktop runtime-config preparation.
#[allow(clippy::wildcard_enum_match_arm)]
pub fn remove_control_plane_keys(value: &mut serde_yaml::Value) {
    match value {
        serde_yaml::Value::Mapping(map) => strip_control_plane_mapping(map, 0),
        serde_yaml::Value::Tagged(tagged) => remove_control_plane_keys(&mut tagged.value),
        _ => {}
    }
}

/// JSON counterpart of [`remove_control_plane_keys`]: the Prism pipeline
/// works with `serde_json::Value`, and a script may add an unauthenticated
/// control surface to the running config that the YAML-side strip in
/// `prepare_runtime_config` never sees. Same scope: only the root object
/// (and any `<<` merge sources attached to it) is touched, and
/// `external-controller` / `secret` are left alone.
pub fn remove_control_plane_keys_json(value: &mut serde_json::Value) {
    remove_control_plane_keys_json_inner(value, 0);
}

fn remove_control_plane_keys_json_inner(value: &mut serde_json::Value, depth: usize) {
    if depth > MAX_YAML_DEPTH {
        // Mirror the YAML side (`strip_control_plane_merge_source`):
        // a merge source deeper than the cap is dropped, not left in
        // place — mihomo resolves nested `<<` chains, so keys hiding
        // below the cap would otherwise merge their way up to the root.
        *value = serde_json::Value::Null;
        return;
    }
    #[allow(clippy::wildcard_enum_match_arm)]
    match value {
        serde_json::Value::Object(map) => {
            for key in CONTROL_PLANE_KEYS {
                map.remove(*key);
            }
            // A `<<` merge source is part of this same logical mapping
            // once mihomo resolves it, so a control-plane key hiding
            // there counts as a top-level one.
            if let Some(source) = map.get_mut(YAML_MERGE_KEY) {
                remove_control_plane_keys_json_inner(source, depth + 1);
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                remove_control_plane_keys_json_inner(item, depth + 1);
            }
        }
        _ => {}
    }
}

/// The merged value of `name` in a JSON object once `<<` merge keys are
/// resolved the way mihomo resolves them: a direct key wins over an
/// inherited one, and merge sources may be a single object or an array
/// of objects (earlier sources win), themselves carrying `<<`. Returns
/// `None` when neither the mapping nor its merge sources carry the key.
/// The counterpart of `merged_json_mapping_has_key` for callers that
/// need the value, not just its presence — the Prism restore paths
/// compare a provider's `path` before and after a script ran, and the
/// path may live in a merge source on either side.
#[must_use]
pub fn merged_json_mapping_get<'a>(
    map: &'a serde_json::Map<String, serde_json::Value>,
    name: &str,
    depth: usize,
) -> Option<&'a serde_json::Value> {
    if let Some(value) = map.get(name) {
        return Some(value);
    }
    if depth > MAX_YAML_DEPTH {
        return None;
    }
    match map.get(YAML_MERGE_KEY) {
        Some(source) => merged_json_get(source, name, depth + 1),
        None => None,
    }
}

#[allow(clippy::wildcard_enum_match_arm)]
fn merged_json_get<'a>(
    value: &'a serde_json::Value,
    name: &str,
    depth: usize,
) -> Option<&'a serde_json::Value> {
    if depth > MAX_YAML_DEPTH {
        return None;
    }
    match value {
        serde_json::Value::Object(map) => merged_json_mapping_get(map, name, depth),
        serde_json::Value::Array(items) => items
            .iter()
            .find_map(|item| merged_json_get(item, name, depth + 1)),
        _ => None,
    }
}

/// Whether `name` appears in a JSON object once `<<` merge keys are
/// resolved the way mihomo resolves them: a key inherited through `<<`
/// counts, whether the merge source is a single object or an array of
/// objects, and merge sources may themselves carry `<<`.
fn merged_json_mapping_has_key(
    map: &serde_json::Map<String, serde_json::Value>,
    name: &str,
    depth: usize,
) -> bool {
    if map.contains_key(name) {
        return true;
    }
    if depth > MAX_YAML_DEPTH {
        return false;
    }
    match map.get(YAML_MERGE_KEY) {
        Some(source) => merged_json_has_key(source, name, depth + 1),
        None => false,
    }
}

#[allow(clippy::wildcard_enum_match_arm)]
fn merged_json_has_key(value: &serde_json::Value, name: &str, depth: usize) -> bool {
    if depth > MAX_YAML_DEPTH {
        return false;
    }
    match value {
        serde_json::Value::Object(map) => merged_json_mapping_has_key(map, name, depth),
        serde_json::Value::Array(items) => items
            .iter()
            .any(|item| merged_json_has_key(item, name, depth + 1)),
        _ => false,
    }
}

/// Mutable counterpart of [`merged_json_mapping_get`]: the merged value
/// of `name`, returned where it actually lives — direct, or inside a
/// merge source — so a caller restoring a stripped key writes it back
/// into the mapping the strip removed it from, not a flat copy at the
/// top level. Same resolution as the immutable one: a direct key wins,
/// merge sources may be a single object or an array of objects
/// (earlier sources win), themselves carrying `<<`.
#[must_use]
pub fn merged_json_mapping_get_mut<'a>(
    map: &'a mut serde_json::Map<String, serde_json::Value>,
    name: &str,
    depth: usize,
) -> Option<&'a mut serde_json::Value> {
    if map.contains_key(name) {
        return map.get_mut(name);
    }
    if depth > MAX_YAML_DEPTH {
        return None;
    }
    match map.get_mut(YAML_MERGE_KEY) {
        Some(source) => merged_json_get_mut(source, name, depth + 1),
        None => None,
    }
}

#[allow(clippy::wildcard_enum_match_arm)]
fn merged_json_get_mut<'a>(
    value: &'a mut serde_json::Value,
    name: &str,
    depth: usize,
) -> Option<&'a mut serde_json::Value> {
    if depth > MAX_YAML_DEPTH {
        return None;
    }
    match value {
        serde_json::Value::Object(map) => merged_json_mapping_get_mut(map, name, depth),
        serde_json::Value::Array(items) => items
            .iter_mut()
            .find_map(|item| merged_json_get_mut(item, name, depth + 1)),
        _ => None,
    }
}

/// Effective keys of a JSON mapping once `<<` merge keys are resolved
/// the way mihomo resolves them: direct keys first, then keys inherited
/// through merge sources (a single object or an array of objects,
/// earlier sources first), each key once, `<<` itself excluded. Merge
/// sources may themselves carry `<<`. Use this to enumerate entries
/// (e.g. providers) rather than iterating direct keys, which misses
/// entries that only exist in a merge source.
#[must_use]
pub fn merged_json_mapping_keys(map: &serde_json::Map<String, serde_json::Value>) -> Vec<String> {
    let mut keys = Vec::new();
    collect_json_mapping_keys(map, &mut keys, 0);
    keys
}

fn collect_json_mapping_keys(
    map: &serde_json::Map<String, serde_json::Value>,
    keys: &mut Vec<String>,
    depth: usize,
) {
    if depth > MAX_YAML_DEPTH {
        return;
    }
    for key in map.keys() {
        if key != YAML_MERGE_KEY && !keys.contains(key) {
            keys.push(key.clone());
        }
    }
    if let Some(source) = map.get(YAML_MERGE_KEY) {
        collect_json_value_keys(source, keys, depth + 1);
    }
}

#[allow(clippy::wildcard_enum_match_arm)]
fn collect_json_value_keys(value: &serde_json::Value, keys: &mut Vec<String>, depth: usize) {
    if depth > MAX_YAML_DEPTH {
        return;
    }
    match value {
        // The object is the merge source itself, not a deeper nesting
        // level: keep the depth the caller already accounted for, so
        // this advances exactly like `merged_json_get` (one level per
        // merge hop).
        serde_json::Value::Object(map) => collect_json_mapping_keys(map, keys, depth),
        serde_json::Value::Array(items) => {
            for item in items {
                collect_json_value_keys(item, keys, depth + 1);
            }
        }
        _ => {}
    }
}

/// JSON counterpart of the provider-path strip in
/// [`remove_dangerous_keys_internal`]: the Prism pipeline works with
/// `serde_json::Value`, and a script may add a provider `path` (or a
/// `script` / `script-path`) to the running config that the strip in
/// `prepare_runtime_config` never sees. Same rule as the import
/// sanitizer: `script` and `script-path` are removed everywhere, the
/// six Clash-for-Windows legacy keys are removed from every mapping,
/// and `path` is removed from mappings that look like providers (`type`
/// plus `url` or `path`, counting keys inherited through a `<<` merge
/// source). A `path` anywhere else — a log path, for example — is
/// left alone.
pub fn remove_dangerous_keys_json(value: &mut serde_json::Value) {
    remove_dangerous_keys_json_inner(value, false, 0);
}

#[allow(clippy::wildcard_enum_match_arm)]
fn remove_dangerous_keys_json_inner(
    value: &mut serde_json::Value,
    in_provider_context: bool,
    depth: usize,
) {
    // Prevent stack overflow from deeply nested structures. Clear the
    // value entirely to prevent dangerous keys from surviving at the
    // depth limit.
    if depth > MAX_YAML_DEPTH {
        *value = serde_json::Value::Null;
        return;
    }

    match value {
        serde_json::Value::Object(map) => {
            // Always remove script-related keys globally: `script` can
            // execute arbitrary JavaScript, `script-path` can load
            // external script files.
            map.remove("script");
            map.remove("script-path");

            // Clash-for-Windows legacy keys, same as the YAML side:
            // they have no effect in mihomo, but a script could add
            // them to the running config and the import sanitizer
            // would never see them.
            for key in [
                "cfw-bypass",
                "cfw-bypass-domain",
                "cfw-profiles-path",
                "cfw-conn-break-strategy",
                "prepend-proxy-groups",
                "append-proxy-groups",
            ] {
                map.remove(key);
            }

            // Check if this mapping looks like a provider: providers
            // have `type` and either `url` or `path` fields (keys
            // inherited through a `<<` merge key count too).
            let has_key = |name: &str| merged_json_mapping_has_key(map, name, depth);
            let is_provider = has_key("type") && (has_key("url") || has_key("path"));

            // Remove `path` only in provider context to prevent path
            // traversal while allowing legitimate `path` fields
            // elsewhere.
            if in_provider_context || is_provider {
                map.remove("path");
            }

            // Recursively process all values in the mapping. A `<<`
            // merge source is part of this same logical mapping once
            // mihomo resolves it, so it inherits the provider context
            // this mapping was itself visited with. Any other child
            // is its own logical mapping — a provider's `headers`
            // map, for example — so it starts without provider
            // context and is classified on its own keys: passing
            // `is_provider` down would strip a nested `path` that
            // belongs to the child, not the provider.
            for (k, v) in map.iter_mut() {
                let is_merge_source = k == YAML_MERGE_KEY;
                let child_in_provider_context = if is_merge_source {
                    in_provider_context || is_provider
                } else {
                    false
                };
                remove_dangerous_keys_json_inner(v, child_in_provider_context, depth + 1);
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                remove_dangerous_keys_json_inner(item, in_provider_context, depth + 1);
            }
        }
        _ => {}
    }
}

#[inline]
const fn decode_hex_digit(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// The merged value of `name` in a YAML mapping once `<<` merge keys are
/// resolved the way mihomo resolves them: a direct key wins over an
/// inherited one, and merge sources may be a single mapping, a sequence
/// of mappings, or a tagged version of either, themselves carrying `<<`.
/// Returns `None` when neither the mapping nor its merge sources carry
/// the key. The YAML counterpart of `merged_json_mapping_get`.
#[must_use]
pub fn merged_mapping_get<'a>(
    map: &'a serde_yaml::Mapping,
    name: &str,
    depth: usize,
) -> Option<&'a serde_yaml::Value> {
    for (key, value) in map {
        if resolved_key_str(key) == Some(name) {
            return Some(value);
        }
    }
    if depth > MAX_YAML_DEPTH {
        return None;
    }
    map.iter()
        .filter(|(k, _)| resolved_key_str(k) == Some(YAML_MERGE_KEY))
        .find_map(|(_, source)| merged_value_get(source, name, depth + 1))
}

#[allow(clippy::wildcard_enum_match_arm)]
fn merged_value_get<'a>(
    value: &'a serde_yaml::Value,
    name: &str,
    depth: usize,
) -> Option<&'a serde_yaml::Value> {
    if depth > MAX_YAML_DEPTH {
        return None;
    }
    match value {
        // The mapping is the merge source itself, not a deeper nesting
        // level: keep the depth the caller already accounted for, so this
        // lookup advances exactly like `merged_value_has_key` (one level
        // per merge hop).
        serde_yaml::Value::Mapping(map) => merged_mapping_get(map, name, depth),
        serde_yaml::Value::Sequence(seq) => seq
            .iter()
            .find_map(|item| merged_value_get(item, name, depth + 1)),
        serde_yaml::Value::Tagged(tagged) => merged_value_get(&tagged.value, name, depth + 1),
        _ => None,
    }
}

/// Whether `name` appears in `map` once YAML merge keys are resolved the way
/// mihomo resolves them: a key inherited through `<<` counts, whether the
/// merge source is a single mapping, a sequence of mappings, or a tagged
/// version of either, and merge sources may themselves carry `<<`.
fn merged_mapping_has_key(map: &serde_yaml::Mapping, name: &str, depth: usize) -> bool {
    if map.keys().any(|k| resolved_key_str(k) == Some(name)) {
        return true;
    }
    if depth > MAX_YAML_DEPTH {
        return false;
    }
    map.iter()
        .filter(|(k, _)| resolved_key_str(k) == Some(YAML_MERGE_KEY))
        .any(|(_, source)| merged_value_has_key(source, name, depth + 1))
}

#[allow(clippy::wildcard_enum_match_arm)]
fn merged_value_has_key(value: &serde_yaml::Value, name: &str, depth: usize) -> bool {
    if depth > MAX_YAML_DEPTH {
        return false;
    }
    match value {
        // The mapping is the merge source itself, not a deeper nesting
        // level: keep the depth the caller already accounted for, so this
        // lookup advances exactly like `remove_dangerous_keys_internal`
        // (one level per merge hop). Counting the mapping again would
        // exhaust the depth budget after roughly half as many hops and
        // let a provider hide its `type`/`url` at the end of a long
        // merge chain while its local `path` survives.
        serde_yaml::Value::Mapping(map) => merged_mapping_has_key(map, name, depth),
        serde_yaml::Value::Sequence(seq) => seq
            .iter()
            .any(|item| merged_value_has_key(item, name, depth + 1)),
        serde_yaml::Value::Tagged(tagged) => merged_value_has_key(&tagged.value, name, depth + 1),
        _ => false,
    }
}

/// Mutable counterpart of [`merged_mapping_get`]: the merged value of
/// `name`, returned where it actually lives — direct, or inside a merge
/// source — so a caller restoring a stripped key writes it back into
/// the mapping the strip removed it from, not a flat copy at the top
/// level. Same resolution as the immutable one, tags included.
#[must_use]
pub fn merged_mapping_get_mut<'a>(
    map: &'a mut serde_yaml::Mapping,
    name: &str,
    depth: usize,
) -> Option<&'a mut serde_yaml::Value> {
    // Direct key first — but check immutably, and borrow mutably only
    // inside the branch that returns: a borrow taken before the branch
    // would have to live across the merge scan below, which the borrow
    // checker rejects. Same shape as `merged_json_mapping_get_mut`.
    if map.iter().any(|(k, _)| resolved_key_str(k) == Some(name)) {
        return map
            .iter_mut()
            .find_map(|(key, value)| (resolved_key_str(key) == Some(name)).then_some(value));
    }
    if depth > MAX_YAML_DEPTH {
        return None;
    }
    merge_mapping_get_mut(map, name, depth)
}

/// The merge-source half of [`merged_mapping_get_mut`]: the first
/// `<<` source carrying the key, earliest first like the immutable
/// lookup.
fn merge_mapping_get_mut<'a>(
    map: &'a mut serde_yaml::Mapping,
    name: &str,
    depth: usize,
) -> Option<&'a mut serde_yaml::Value> {
    map.iter_mut().find_map(|(key, source)| {
        if resolved_key_str(key) == Some(YAML_MERGE_KEY) {
            merged_value_get_mut(source, name, depth + 1)
        } else {
            None
        }
    })
}

#[allow(clippy::wildcard_enum_match_arm)]
fn merged_value_get_mut<'a>(
    value: &'a mut serde_yaml::Value,
    name: &str,
    depth: usize,
) -> Option<&'a mut serde_yaml::Value> {
    if depth > MAX_YAML_DEPTH {
        return None;
    }
    match value {
        // The mapping is the merge source itself, not a deeper nesting
        // level: keep the depth the caller already accounted for, so
        // this lookup advances exactly like `merged_value_get`.
        serde_yaml::Value::Mapping(map) => merged_mapping_get_mut(map, name, depth),
        serde_yaml::Value::Sequence(seq) => seq
            .iter_mut()
            .find_map(|item| merged_value_get_mut(item, name, depth + 1)),
        serde_yaml::Value::Tagged(tagged) => {
            merged_value_get_mut(&mut tagged.value, name, depth + 1)
        }
        _ => None,
    }
}

/// YAML counterpart of [`merged_json_mapping_keys`]: effective string
/// keys of a mapping once `<<` merge keys are resolved the way mihomo
/// resolves them — direct keys first, then keys inherited through merge
/// sources (a single mapping, a sequence of mappings, or a tagged
/// version of either), each key once, `<<` itself excluded. Merge
/// sources may themselves carry `<<`. Non-string keys are skipped:
/// provider names are strings.
#[must_use]
pub fn merged_mapping_keys(map: &serde_yaml::Mapping) -> Vec<String> {
    let mut keys = Vec::new();
    collect_mapping_keys(map, &mut keys, 0);
    keys
}

fn collect_mapping_keys(map: &serde_yaml::Mapping, keys: &mut Vec<String>, depth: usize) {
    if depth > MAX_YAML_DEPTH {
        return;
    }
    for key in map.keys() {
        if let Some(key_str) = resolved_key_str(key) {
            if key_str != YAML_MERGE_KEY && !keys.iter().any(|k| k == key_str) {
                keys.push(key_str.to_owned());
            }
        }
    }
    for (key, source) in map {
        if resolved_key_str(key) == Some(YAML_MERGE_KEY) {
            collect_mapping_value_keys(source, keys, depth + 1);
        }
    }
}

#[allow(clippy::wildcard_enum_match_arm)]
fn collect_mapping_value_keys(value: &serde_yaml::Value, keys: &mut Vec<String>, depth: usize) {
    if depth > MAX_YAML_DEPTH {
        return;
    }
    match value {
        // The mapping is the merge source itself, not a deeper nesting
        // level: keep the depth the caller already accounted for, like
        // `merged_value_get` (one level per merge hop).
        serde_yaml::Value::Mapping(map) => collect_mapping_keys(map, keys, depth),
        serde_yaml::Value::Sequence(seq) => {
            for item in seq {
                collect_mapping_value_keys(item, keys, depth + 1);
            }
        }
        serde_yaml::Value::Tagged(tagged) => {
            collect_mapping_value_keys(&tagged.value, keys, depth + 1);
        }
        _ => {}
    }
}

/// Internal implementation with depth tracking.
#[allow(clippy::wildcard_enum_match_arm)]
fn remove_dangerous_keys_internal(
    value: &mut serde_yaml::Value,
    in_provider_context: bool,
    depth: usize,
) {
    // Prevent stack overflow from deeply nested YAML structures (Billion Laughs attack).
    // Clear the value entirely to prevent dangerous keys from surviving at depth limit.
    if depth > MAX_YAML_DEPTH {
        *value = serde_yaml::Value::Null;
        return;
    }

    match value {
        serde_yaml::Value::Mapping(map) => {
            // Always remove script-related keys globally
            // script: can execute arbitrary JavaScript
            // script-path: can load external script files
            remove_keys_resolved(map, &["script", "script-path"]);

            // Remove Clash-for-Windows legacy keys that have no effect in mihomo
            // but could be used to inject unexpected behavior
            remove_keys_resolved(
                map,
                &[
                    "cfw-bypass",
                    "cfw-bypass-domain",
                    "cfw-profiles-path",
                    "cfw-conn-break-strategy",
                    "prepend-proxy-groups",
                    "append-proxy-groups",
                ],
            );

            // Check if this mapping looks like a provider
            // Providers have 'type' and either 'url' or 'path' fields
            // (keys are matched through explicit tags such as `!!str path`,
            // which mihomo resolves to the plain key, and keys inherited
            // through a `<<` merge key count too: a provider that inherits
            // 'type' and 'url' but defines 'path' locally is still a provider).
            let has_key = |name: &str| merged_mapping_has_key(map, name, depth);
            let is_provider = has_key("type") && (has_key("url") || has_key("path"));

            // Remove 'path' only in provider context to prevent path traversal
            // while allowing legitimate 'path' fields elsewhere
            if in_provider_context || is_provider {
                remove_keys_resolved(map, &["path"]);
            }

            // Recursively process all values in the mapping. A `<<` merge
            // source is part of this same logical mapping once mihomo
            // resolves it, so it inherits the provider context this
            // mapping was itself visited with, not just this mapping's
            // own classification: otherwise a merge source nested inside
            // another merge source would drop the context after one hop
            // and keep a `path` the outer provider should have stripped.
            // Any other child is its own logical mapping — a provider's
            // `headers` map, for example — so it starts without provider
            // context and is classified on its own keys: passing
            // `is_provider` down would strip a nested `path` that
            // belongs to the child, not the provider.
            for (k, v) in map.iter_mut() {
                let is_merge_source = resolved_key_str(k) == Some(YAML_MERGE_KEY);
                let child_in_provider_context = if is_merge_source {
                    in_provider_context || is_provider
                } else {
                    false
                };
                remove_dangerous_keys_internal(v, child_in_provider_context, depth + 1);
            }
        }
        serde_yaml::Value::Sequence(seq) => {
            // Recursively process all items in the sequence
            for item in seq.iter_mut() {
                remove_dangerous_keys_internal(item, in_provider_context, depth + 1);
            }
        }
        serde_yaml::Value::Tagged(tagged) => {
            // A tagged value wraps the real node: mihomo's decoder looks
            // through the tag, so a tagged mapping must be sanitised exactly
            // like the mapping it wraps instead of being skipped.
            remove_dangerous_keys_internal(&mut tagged.value, in_provider_context, depth + 1);
        }
        _ => {}
    }
}

/// Recursively remove dangerous keys from YAML structure to prevent code execution.
/// This function is security-critical and used by both production code and tests.
/// Automatically limits recursion depth to prevent Billion Laughs attacks.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn remove_dangerous_keys(value_json: String) -> Result<String, crate::error::AppError> {
    let mut value: serde_yaml::Value = serde_yaml::from_str(&value_json)
        .map_err(|e| crate::error::AppError::ParseError(format!("Invalid YAML: {e}")))?;
    remove_dangerous_keys_internal(&mut value, false, 0);
    remove_control_plane_keys(&mut value);
    serde_yaml::to_string(&value)
        .map_err(|e| crate::error::AppError::ParseError(format!("YAML serialization failed: {e}")))
}

/// Non-FFI version that works directly with `serde_yaml::Value` (for internal use).
///
/// `value` is treated as the root of a config document, so top-level
/// control-plane keys ([`CONTROL_PLANE_KEYS`]) are removed as well.
pub fn remove_dangerous_keys_internal_pub(
    value: &mut serde_yaml::Value,
    in_provider_context: bool,
) {
    remove_dangerous_keys_internal(value, in_provider_context, 0);
    remove_control_plane_keys(value);
}

/// Complete URL decoding for path traversal detection
/// Handles standard percent-encoding, double encoding, and mixed case
#[must_use]
pub fn url_decode_complete(input: &str) -> String {
    if !input.contains('%') {
        return input.to_owned();
    }

    // Performance optimization: Percent-decoding never expands byte length
    // (a 3-byte `%XX` sequence becomes 1 byte, or 1 byte stays 1 byte).
    // Instead of allocating one reusable secondary `Vec<u8>` before the pass
    // loop and swapping the two buffers on each pass, decode in-place in a
    // single vector using a two-pointer read/write traversal (`write <= read`
    // invariant holds at all times).
    let mut current = input.as_bytes().to_vec();

    for _ in 0..5 {
        let mut changed = false;
        let mut read = 0;
        let mut write = 0;
        let len = current.len();

        while read < len {
            if current.get(read) == Some(&b'%') {
                if let (Some(hi), Some(lo)) = (
                    current.get(read + 1).copied().and_then(decode_hex_digit),
                    current.get(read + 2).copied().and_then(decode_hex_digit),
                ) {
                    if let Some(target) = current.get_mut(write) {
                        *target = (hi << 4) | lo;
                    }
                    read += 3;
                    write += 1;
                    changed = true;
                    continue;
                }
            }

            if let Some(&byte) = current.get(read) {
                if let Some(target) = current.get_mut(write) {
                    *target = byte;
                }
            }
            read += 1;
            write += 1;
        }

        current.truncate(write);

        if !changed || !current.contains(&b'%') {
            break;
        }
    }

    String::from_utf8(current)
        .unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned())
}

/// Common base filename sanitization shared by config and prism file handlers.
///
/// Performs URL decoding, null byte removal, control character removal,
/// path traversal rejection, directory separator rejection, and length check.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn sanitize_base_filename(raw: String) -> Result<String, crate::error::AppError> {
    // Step 1: Complete URL decoding to catch all encoded patterns
    let decoded = url_decode_complete(&raw);

    // Trim trailing spaces and dots to prevent Windows canonicalization bypasses (e.g. ".. " or ".. .")
    let trimmed = decoded.trim_end_matches([' ', '.']);

    // Step 1.5: Check the decoded path for traversal BEFORE extracting the filename.
    if trimmed.contains('/') || trimmed.contains('\\') {
        return Err(crate::error::AppError::ConfigError(
            "Path traversal detected: directory separators are not allowed".to_owned(),
        ));
    }
    // Reject bare ".." which is a real parent-directory reference.
    if trimmed == ".." {
        return Err(crate::error::AppError::ConfigError(
            "Path traversal detected: '..' is not allowed".to_owned(),
        ));
    }
    // Reject bare "." which is a special current-directory reference.
    if trimmed == "." || trimmed.is_empty() {
        return Err(crate::error::AppError::ConfigError(
            "'.' is not a valid filename".to_owned(),
        ));
    }

    // Step 2: Extract just the filename
    let filename = Path::new(trimmed)
        .file_name()
        .and_then(|f| f.to_str())
        .unwrap_or(trimmed)
        .to_owned();

    // Step 3: Reject null bytes
    if filename.contains('\0') {
        return Err(crate::error::AppError::ConfigError(
            "Invalid character in filename: null byte detected".to_owned(),
        ));
    }

    // Step 4: Reject control characters
    if filename.chars().any(char::is_control) {
        return Err(crate::error::AppError::ConfigError(
            "Invalid character in filename: control characters not allowed".to_owned(),
        ));
    }

    // Step 5: Length limit
    if filename.len() > 255 {
        return Err(crate::error::AppError::ConfigError(
            "Filename too long: maximum 255 characters allowed".to_owned(),
        ));
    }

    Ok(filename)
}

/// Reserved Windows device names (Microsoft's file-naming documentation):
/// the plain names, COM0/LPT0, the superscript-digit forms (Windows reads
/// ¹, ², ³ as digits in device names), and CONIN$/CONOUT$. Shared by the
/// config-filename check and the plugin-ID validators so the list cannot
/// drift between call sites.
pub const RESERVED_DEVICE_NAMES: &[&str] = &[
    "CON",
    "PRN",
    "AUX",
    "NUL",
    "CONIN$",
    "CONOUT$",
    "COM0",
    "COM1",
    "COM2",
    "COM3",
    "COM4",
    "COM5",
    "COM6",
    "COM7",
    "COM8",
    "COM9",
    "COM\u{b9}",
    "COM\u{b2}",
    "COM\u{b3}",
    "LPT0",
    "LPT1",
    "LPT2",
    "LPT3",
    "LPT4",
    "LPT5",
    "LPT6",
    "LPT7",
    "LPT8",
    "LPT9",
    "LPT\u{b9}",
    "LPT\u{b2}",
    "LPT\u{b3}",
];

/// Sanitize configuration file name with comprehensive security checks
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn sanitize_config_file_name(config_path: String) -> Result<String, crate::error::AppError> {
    let config_file_name = sanitize_base_filename(config_path)?;

    // Validate extension
    let lower_name = config_file_name.to_lowercase();
    if !lower_name.ends_with(".yaml") && !lower_name.ends_with(".yml") {
        return Err(crate::error::AppError::ConfigError(
            "Invalid file type: only .yaml and .yml files are permitted".to_owned(),
        ));
    }

    if config_file_name.len() > 255 {
        return Err(crate::error::AppError::ConfigError(
            "Filename too long: maximum 255 characters allowed".to_owned(),
        ));
    }

    // Check for reserved Windows names (even on other platforms for consistency).
    // Windows treats the stem before the FIRST dot as the device name, so
    // stripping only the final extension is not enough: "NUL.tar.yaml" is
    // still NUL. The list matches the plugin-ID validators, including
    // COM0/LPT0, the superscript-digit forms, and CONIN$/CONOUT$.
    let upper_name = config_file_name.to_uppercase();
    // Windows ignores trailing spaces when matching device names, so
    // "CON .yaml" is still CON: trim the stem before comparing.
    let stem = upper_name.split('.').next().unwrap_or(&upper_name).trim();
    if RESERVED_DEVICE_NAMES.contains(&stem) {
        return Err(crate::error::AppError::ConfigError(format!(
            "Reserved filename: '{config_file_name}' is not allowed"
        )));
    }

    Ok(config_file_name)
}

/// Lexically normalize a path to resolve '.', '..', and separators.
/// A `..` directly under the root is dropped: on a filesystem `/..`
/// resolves to `/`, so keeping it would falsely reject a path that
/// actually points inside the base. A `..` after a drive prefix or at
/// the start of a relative path is kept: it may genuinely escape.
fn normalize_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(..) | Component::RootDir | Component::Normal(..) => {
                normalized.push(component);
            }
            Component::ParentDir => match normalized.components().next_back() {
                Some(Component::Normal(..)) => {
                    normalized.pop();
                }
                Some(Component::RootDir) => {}
                _ => {
                    normalized.push(component);
                }
            },
            Component::CurDir => {}
        }
    }
    normalized
}

/// Expand symlinks component by component, without requiring the path
/// to exist. A dangling link is expanded too, since a later write would
/// follow it. Scanning restarts after each replacement so chained links
/// are followed; the cap stops symlink loops (a looped path cannot be
/// written anyway, and any expansion that already left the base is
/// rejected by the caller).
fn expand_symlinks(path: &Path) -> Result<PathBuf, crate::error::AppError> {
    let mut current = path.to_path_buf();
    for _ in 0..40 {
        let mut prefix = PathBuf::new();
        let mut found: Option<(PathBuf, PathBuf)> = None;
        let mut unreadable_link = false;
        // Components past a missing component cannot be probed through
        // the OS: for `/base/missing/../link` every `symlink_metadata`
        // past `missing` fails, so the `link` symlink is never expanded
        // — yet a later `create_dir_all` on the parent would make the
        // path resolve through it. Track the missing run and cancel it
        // lexically on `..`, so the components after it are probed at
        // the location they will actually have.
        let mut missing_depth: usize = 0;
        let mut components = current.components();
        for component in components.by_ref() {
            // A `..` after missing components cancels the last missing
            // one: the OS cannot resolve `/base/missing/..`, but the
            // resolved location is `/base`, so keep scanning there.
            if missing_depth > 0 && matches!(component, Component::ParentDir) {
                prefix.pop();
                missing_depth -= 1;
                continue;
            }
            prefix.push(component);
            // A lone Prefix is a volume root, never a symlink, so
            // there is nothing to probe here — and probing it can
            // fail: a verbatim Windows prefix (`\\?\C:`) or a UNC
            // root (`\\server\share`) is a bare drive reference, not
            // a file or directory, so the OS may report it as
            // invalid or inaccessible rather than NotFound, which the
            // fail-closed branch below would turn into a rejection
            // of the whole path. The components under the prefix are
            // still probed normally. (A verbatim prefix reaches here
            // when `read_link` or `canonicalize` returns a `\\?\`
            // target and the scan restarts on it.)
            if matches!(component, Component::Prefix(_)) && prefix.components().count() == 1 {
                continue;
            }
            match prefix.symlink_metadata() {
                Ok(meta) => {
                    if meta.file_type().is_symlink() {
                        if let Ok(target) = std::fs::read_link(&prefix) {
                            let target_abs = if target.is_absolute() {
                                target
                            } else {
                                prefix
                                    .parent()
                                    .unwrap_or_else(|| Path::new("/"))
                                    .join(target)
                            };
                            // The suffix is whatever the iterator has not
                            // consumed yet. `prefix` is the link's resolved
                            // location, which need not be a lexical prefix
                            // of `current` once a `..` cancelled a missing
                            // component above, so recovering the suffix with
                            // `strip_prefix` on the raw path can fail and
                            // silently drop it — and a `..` inside the
                            // dropped part would then escape unchecked.
                            // Take it from the iterator instead.
                            found = Some((target_abs, components.as_path().to_path_buf()));
                            break;
                        }
                        // Fail closed: an unreadable link cannot be
                        // proven to stay inside the base.
                        unreadable_link = true;
                        break;
                    }
                }
                Err(err) => {
                    // Only a missing component is "missing": any other
                    // inspection failure (permissions, a loop, a file
                    // where a directory is expected) must fail closed.
                    // Treating it as missing would let a `..` after it
                    // hide a symlink this scan never sees.
                    if err.kind() == std::io::ErrorKind::NotFound {
                        missing_depth += 1;
                    } else {
                        return Err(crate::error::AppError::ConfigError(format!(
                            "Path traversal detected: cannot inspect path component: {err}"
                        )));
                    }
                }
            }
        }
        if unreadable_link {
            return Err(crate::error::AppError::ConfigError(
                "Path traversal detected: unreadable symlink on path".to_owned(),
            ));
        }
        match found {
            None => break,
            Some((target, suffix)) => {
                current = target.join(suffix);
            }
        }
    }
    // The loop stops after 40 replacements: a longer chain still holds
    // an unexpanded link, and returning it unchecked would let a later
    // write follow that link outside the base. Fail closed instead.
    // The same missing-component cancellation as the scan above applies:
    // without it a `missing/../link` tail hides the link from this check,
    // and the path would be returned as if the link did not exist.
    let mut prefix = PathBuf::new();
    let mut missing_depth: usize = 0;
    for component in current.components() {
        if missing_depth > 0 && matches!(component, Component::ParentDir) {
            prefix.pop();
            missing_depth -= 1;
            continue;
        }
        prefix.push(component);
        // Same rule as the scan above: a lone Prefix is a volume
        // root, never a symlink — skip probing it.
        if matches!(component, Component::Prefix(_)) && prefix.components().count() == 1 {
            continue;
        }
        match prefix.symlink_metadata() {
            Ok(meta) => {
                if meta.file_type().is_symlink() {
                    return Err(crate::error::AppError::ConfigError(
                        "Path traversal detected: symlink chain too long".to_owned(),
                    ));
                }
            }
            // Same rule as the scan above: only NotFound is "missing";
            // any other inspection failure fails closed.
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                missing_depth += 1;
            }
            Err(err) => {
                return Err(crate::error::AppError::ConfigError(format!(
                    "Path traversal detected: cannot inspect path component: {err}"
                )));
            }
        }
    }
    Ok(current)
}

/// Component-wise prefix check that folds ASCII case on Windows: the
/// filesystem is case-insensitive there, but `Path::starts_with`
/// compares components exactly, so a symlink target stored as
/// `C:\DATA\sub` would otherwise fail against a `C:\Data\sub` base.
/// Other platforms keep the exact comparison (their filesystems are
/// case-sensitive, and folding there would admit a differently-cased
/// sibling directory).
fn path_starts_with_case_aware(path: &Path, base: &Path) -> bool {
    #[cfg(windows)]
    {
        let mut path_components = path.components();
        base.components().all(|base_component| {
            path_components.next().is_some_and(|component| {
                component
                    .as_os_str()
                    .as_encoded_bytes()
                    .eq_ignore_ascii_case(base_component.as_os_str().as_encoded_bytes())
            })
        })
    }
    #[cfg(not(windows))]
    {
        path.starts_with(base)
    }
}

/// Validates that the resolved path is within the expected base directory
pub fn validate_path_within_dir(
    resolved_path: &Path,
    base_dir: &Path,
) -> Result<(), crate::error::AppError> {
    let traversal_err = || {
        crate::error::AppError::ConfigError(
            "Path traversal detected: resolved path is outside allowed directory".to_owned(),
        )
    };

    // Existing files: canonical comparison is authoritative. It resolves
    // symlinks and spelling differences (macOS /var vs /private/var,
    // Windows \\?\ prefixes) that a lexical check would falsely reject.
    if resolved_path.exists() {
        let canonical_resolved = resolved_path.canonicalize().map_err(|e| {
            crate::error::AppError::IoError(format!("Failed to canonicalize resolved path: {e}"))
        })?;
        let canonical_base = base_dir.canonicalize().map_err(|e| {
            crate::error::AppError::IoError(format!("Failed to canonicalize base directory: {e}"))
        })?;
        if !canonical_resolved.starts_with(&canonical_base) {
            return Err(traversal_err());
        }
        return Ok(());
    }

    // Not (yet) on disk: canonicalization is impossible, so validate
    // lexically on the symlink-expanded path. exists() follows links,
    // so without expansion a dangling leaf symlink would be skipped and
    // a later write would follow it outside the base.
    // Both sides must use the same spelling: expanding only the child
    // rejects every new file under a symlinked base (for example a
    // macOS temp dir below /var, which is a link to /private/var),
    // because the expanded child no longer starts with the raw base.
    let norm_base = normalize_path(&expand_symlinks(base_dir)?);
    let expanded = normalize_path(&expand_symlinks(resolved_path)?);
    // An empty normalized base (base_dir "." or "") matches every
    // path with starts_with, so a traversal target would pass.
    // Fail closed: no current caller passes such a base, and a
    // security validator must not silently accept everything.
    if norm_base.as_os_str().is_empty() {
        return Err(traversal_err());
    }
    // A base that normalizes to a leading `..` (base_dir `..` or
    // `../profiles`) escapes whatever it is relative to: the
    // normalized target `../../outside.yaml` starts with it, so the
    // check would pass an escaping path. Fail closed like the empty
    // base above; no current caller passes a relative base.
    // Skip an optional drive prefix first: `C:..` is a drive-relative
    // base, and a missing `C:..\..\outside.yaml` would otherwise pass
    // the starts_with check against it while resolving outside the
    // base. A bare prefix (`C:`) names no directory at all and would
    // match every path on that drive.
    let first_dir_component = norm_base
        .components()
        .find(|c| !matches!(c, Component::Prefix(_)));
    // A bare UNC root (`\\server\share`) has no non-prefix component —
    // it IS the directory root, not a missing one. A bare drive prefix
    // (`C:`, `\\?\C:`) names no directory and still fails closed.
    let is_unc_root = matches!(
        norm_base.components().next(),
        Some(Component::Prefix(prefix))
            if matches!(prefix.kind(), Prefix::UNC(..) | Prefix::VerbatimUNC(..))
    );
    if matches!(first_dir_component, Some(Component::ParentDir) | None) && !is_unc_root {
        return Err(traversal_err());
    }
    if !path_starts_with_case_aware(&expanded, &norm_base) {
        return Err(traversal_err());
    }
    if let Ok(canonical_base) = base_dir.canonicalize() {
        if let Ok(canonical_expanded) = expanded.canonicalize() {
            if !canonical_expanded.starts_with(&canonical_base) {
                return Err(traversal_err());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn root_keys(value: &serde_yaml::Value) -> Vec<String> {
        value
            .as_mapping()
            .unwrap()
            .keys()
            .filter_map(|k| resolved_key_str(k).map(str::to_owned))
            .collect()
    }

    #[test]
    fn test_control_plane_keys_removed_when_explicitly_tagged() {
        let yaml = "!!str external-controller-unix: /tmp/mihomo.sock\n\
                    !custom external-doh-server: /dns-query\n\
                    !!str script: evil.js\n\
                    port: 7890\n";
        let mut value: serde_yaml::Value = serde_yaml::from_str(yaml).unwrap();
        remove_dangerous_keys_internal_pub(&mut value, false);
        assert_eq!(root_keys(&value), vec!["port".to_owned()]);
    }

    #[test]
    fn test_control_plane_keys_removed_from_tagged_merge_source() {
        let yaml = "base: &base\n  external-controller-pipe: \\\\.\\pipe\\mihomo\n\
                    !!merge <<: *base\n\
                    port: 7890\n";
        let mut value: serde_yaml::Value = serde_yaml::from_str(yaml).unwrap();
        remove_control_plane_keys(&mut value);
        let (_, merge_source) = value
            .as_mapping()
            .unwrap()
            .iter()
            .find(|(k, _)| resolved_key_str(k) == Some(YAML_MERGE_KEY))
            .unwrap();
        let source = if let serde_yaml::Value::Tagged(t) = merge_source {
            &t.value
        } else {
            merge_source
        };
        assert!(!source
            .as_mapping()
            .unwrap()
            .contains_key(serde_yaml::Value::String(
                "external-controller-pipe".to_owned()
            )));
    }

    #[test]
    fn test_sanitize_config_file_name_valid() {
        assert_eq!(
            sanitize_config_file_name("test.yaml".to_owned()).unwrap(),
            "test.yaml"
        );
        assert_eq!(
            sanitize_config_file_name("test.yml".to_owned()).unwrap(),
            "test.yml"
        );
        assert!(sanitize_config_file_name("../test.yaml".to_owned()).is_err());
        assert!(sanitize_config_file_name("foo/test.yaml".to_owned()).is_err());
        assert!(sanitize_config_file_name("foo\\test.yaml".to_owned()).is_err());
        assert!(sanitize_config_file_name("test.txt".to_owned()).is_err());
    }

    #[test]
    fn test_sanitize_config_file_name_rejects_reserved_stems() {
        // Reserved stem with any extensions attached, not just the final one.
        assert!(sanitize_config_file_name("NUL.yaml".to_owned()).is_err());
        assert!(sanitize_config_file_name("NUL.tar.yaml".to_owned()).is_err());
        assert!(sanitize_config_file_name("con.txt.yaml".to_owned()).is_err());
        assert!(sanitize_config_file_name("COM0.yaml".to_owned()).is_err());
        assert!(sanitize_config_file_name("COM\u{b9}.yaml".to_owned()).is_err());
        assert!(sanitize_config_file_name("CONIN$.yaml".to_owned()).is_err());
        // Trailing spaces before the extension do not save a reserved stem.
        assert!(sanitize_config_file_name("CON .yaml".to_owned()).is_err());
        assert!(sanitize_config_file_name("NUL .yml".to_owned()).is_err());
        assert!(sanitize_config_file_name("config.backup.yml".to_owned()).is_ok());
    }

    #[test]
    fn test_sanitize_config_file_name_rejects_path_traversal() {
        assert!(sanitize_config_file_name("..".to_owned()).is_err());
        assert!(sanitize_config_file_name("foo/bar".to_owned()).is_err());
        assert!(sanitize_config_file_name("test\x00.yaml".to_owned()).is_err());
        assert!(sanitize_config_file_name(".test.yaml".to_owned()).is_ok());
        assert!(sanitize_config_file_name("config.backup.yml".to_owned()).is_ok());
    }

    #[test]
    fn test_url_decode_standard() {
        assert_eq!(url_decode_complete("%41"), "A");
        assert_eq!(url_decode_complete("%3a"), ":");
        assert_eq!(url_decode_complete("hello%20world"), "hello world");
    }

    #[test]
    fn test_url_decode_double_encoding() {
        assert_eq!(url_decode_complete("%2541"), "A");
        assert_eq!(url_decode_complete("%252541"), "A");
    }

    #[test]
    fn test_url_decode_boundaries() {
        // Malformed and trailing escapes are passed through untouched.
        assert_eq!(url_decode_complete("abc%"), "abc%");
        assert_eq!(url_decode_complete("abc%2"), "abc%2");
        assert_eq!(url_decode_complete("%zz"), "%zz");
        assert_eq!(url_decode_complete("%2g"), "%2g");
        // Bytes that are not valid UTF-8 become the replacement character.
        assert_eq!(url_decode_complete("%FF"), "\u{FFFD}");
        assert_eq!(url_decode_complete("a%FFb"), "a\u{FFFD}b");
        // Six layers of encoding need six passes; the loop caps at five,
        // so one layer must remain.
        assert_eq!(url_decode_complete("%252525252541"), "%41");
    }

    #[test]
    fn test_remove_dangerous_keys_script() {
        let yaml = "script: test.js\nport: 7890";
        let mut value: serde_yaml::Value = serde_yaml::from_str(yaml).unwrap();
        remove_dangerous_keys_internal_pub(&mut value, false);
        assert!(!value
            .as_mapping()
            .unwrap()
            .contains_key(serde_yaml::Value::String("script".to_owned())));
        assert!(value
            .as_mapping()
            .unwrap()
            .contains_key(serde_yaml::Value::String("port".to_owned())));
    }

    #[test]
    fn test_remove_dangerous_keys_provider_path() {
        let yaml = r"
proxy-providers:
  my-provider:
    type: http
    url: https://example.com/proxies.yaml
    path: /etc/passwd
    interval: 3600
";
        let mut value: serde_yaml::Value = serde_yaml::from_str(yaml).unwrap();
        remove_dangerous_keys_internal_pub(&mut value, false);
        let providers = value.get("proxy-providers").unwrap().as_mapping().unwrap();
        let provider = providers
            .get(serde_yaml::Value::String("my-provider".to_owned()))
            .unwrap()
            .as_mapping()
            .unwrap();
        assert!(!provider.contains_key(serde_yaml::Value::String("path".to_owned())));
        assert!(provider.contains_key(serde_yaml::Value::String("type".to_owned())));
    }

    #[test]
    fn test_provider_nested_headers_path_kept() {
        // A `path` inside a provider's nested `headers` map belongs
        // to the header, not the provider: only the provider's own
        // `path` is stripped.
        let yaml = r"
proxy-providers:
  my-provider:
    type: http
    url: https://example.com/proxies.yaml
    path: /etc/passwd
    headers:
      path: x-custom-path
      Authorization: Bearer token
";
        let mut value: serde_yaml::Value = serde_yaml::from_str(yaml).unwrap();
        remove_dangerous_keys_internal_pub(&mut value, false);
        let providers = value.get("proxy-providers").unwrap().as_mapping().unwrap();
        let provider = providers
            .get(serde_yaml::Value::String("my-provider".to_owned()))
            .unwrap()
            .as_mapping()
            .unwrap();
        assert!(!provider.contains_key(serde_yaml::Value::String("path".to_owned())));
        let headers = provider
            .get(serde_yaml::Value::String("headers".to_owned()))
            .unwrap()
            .as_mapping()
            .unwrap();
        assert_eq!(
            headers
                .get(serde_yaml::Value::String("path".to_owned()))
                .unwrap()
                .as_str()
                .unwrap(),
            "x-custom-path"
        );
    }

    #[test]
    fn test_provider_path_removed_when_type_and_url_inherited_via_merge_key() {
        let yaml = r"
base: &base
  type: http
  url: https://example.com/proxies.yaml
proxy-providers:
  my-provider:
    <<: *base
    path: /etc/passwd
    interval: 3600
";
        let mut value: serde_yaml::Value = serde_yaml::from_str(yaml).unwrap();
        remove_dangerous_keys_internal_pub(&mut value, false);
        let providers = value.get("proxy-providers").unwrap().as_mapping().unwrap();
        let provider = providers
            .get(serde_yaml::Value::String("my-provider".to_owned()))
            .unwrap()
            .as_mapping()
            .unwrap();
        assert!(
            provider.keys().all(|k| resolved_key_str(k) != Some("path")),
            "path survived merge-key provider detection: {provider:?}"
        );
        // Resolving the merge the way mihomo does must not resurface `path`.
        let mut merged_provider = value
            .get("proxy-providers")
            .and_then(|v| v.get("my-provider"))
            .cloned()
            .unwrap();
        resolve_merges(&mut merged_provider);
        let merged = merged_provider.as_mapping().unwrap();
        assert!(merged.keys().all(|k| resolved_key_str(k) != Some("path")));
        assert_eq!(merged.get("type").unwrap().as_str().unwrap(), "http");
        assert_eq!(merged.get("interval").unwrap().as_i64().unwrap(), 3600);
    }

    #[test]
    fn test_provider_path_removed_from_doubly_nested_merge_source() {
        // The `path` sits in a merge source nested inside another merge
        // source. The middle mapping has no `type`/`url` of its own, so
        // the provider context of the outer provider must be carried
        // through both merge hops or the inner `path` survives.
        let yaml = r"
proxy-providers:
  p:
    type: http
    url: https://example.com/p.yaml
    <<:
      <<: {path: /etc/passwd}
";
        let mut value: serde_yaml::Value = serde_yaml::from_str(yaml).unwrap();
        remove_dangerous_keys_internal_pub(&mut value, false);
        let out = serde_yaml::to_string(&value).unwrap();
        assert!(!out.contains("/etc/passwd"), "path survived: {out}");
        // Resolving the merges the way mihomo does must not resurface it.
        let mut provider = value
            .get("proxy-providers")
            .and_then(|v| v.get("p"))
            .cloned()
            .unwrap();
        resolve_merges(&mut provider);
        let merged = provider.as_mapping().unwrap();
        assert!(merged.keys().all(|k| resolved_key_str(k) != Some("path")));
        assert_eq!(merged.get("type").unwrap().as_str().unwrap(), "http");
    }

    #[test]
    fn test_provider_detected_through_long_merge_chain() {
        // `type`/`url` inherited through 60 merge hops must still mark
        // the destination mapping as a provider. Merge-key detection
        // advances one depth level per hop, exactly like the sanitizer
        // traversal; counting each hop twice would give up halfway and
        // leave the local `path` in place.
        use std::fmt::Write as _;
        let mut yaml = String::from("b0: &b0\n  type: http\n  url: https://example.com/p.yaml\n");
        for i in 1..60 {
            let prev = i - 1;
            write!(yaml, "b{i}: &b{i}\n  <<: *b{prev}\n").unwrap();
        }
        yaml.push_str("proxy-providers:\n  p:\n    <<: *b59\n    path: /etc/passwd\n");
        let mut value: serde_yaml::Value = serde_yaml::from_str(&yaml).unwrap();
        remove_dangerous_keys_internal_pub(&mut value, false);
        let provider = value
            .get("proxy-providers")
            .and_then(|v| v.get("p"))
            .and_then(serde_yaml::Value::as_mapping)
            .unwrap();
        assert!(
            provider.keys().all(|k| resolved_key_str(k) != Some("path")),
            "path survived long merge chain: {provider:?}"
        );
    }

    fn top_level_keys(value: &serde_yaml::Value) -> Vec<String> {
        value
            .as_mapping()
            .unwrap()
            .keys()
            .filter_map(|k| k.as_str().map(str::to_owned))
            .collect()
    }

    /// Resolve `<<` merge keys the way mihomo's decoder does, including merge
    /// sources that themselves carry `<<` (`apply_merge` is single-level).
    fn resolve_merges(value: &mut serde_yaml::Value) {
        for _ in 0..16 {
            if value.get(YAML_MERGE_KEY).is_none() {
                break;
            }
            value.apply_merge().unwrap();
        }
        assert!(
            value.get(YAML_MERGE_KEY).is_none(),
            "merge chain did not converge"
        );
    }

    fn assert_control_key_stripped(key: &str, value_yaml: &str) {
        let yaml = format!(
            "external-controller: 127.0.0.1:9090\nsecret: s3cret\nmixed-port: 7890\n{key}: {value_yaml}\n"
        );
        // Internal (desktop) entry point.
        let mut value: serde_yaml::Value = serde_yaml::from_str(&yaml).unwrap();
        remove_dangerous_keys_internal_pub(&mut value, false);
        let keys = top_level_keys(&value);
        assert!(!keys.iter().any(|k| k == key), "{key} survived: {keys:?}");
        assert_eq!(
            value.get("external-controller").unwrap().as_str().unwrap(),
            "127.0.0.1:9090"
        );
        assert_eq!(value.get("secret").unwrap().as_str().unwrap(), "s3cret");
        assert_eq!(value.get("mixed-port").unwrap().as_i64().unwrap(), 7890);

        // FFI entry point.
        let out = remove_dangerous_keys(yaml).unwrap();
        let value: serde_yaml::Value = serde_yaml::from_str(&out).unwrap();
        let keys = top_level_keys(&value);
        assert!(
            !keys.iter().any(|k| k == key),
            "{key} survived FFI: {keys:?}"
        );
        assert_eq!(
            value.get("external-controller").unwrap().as_str().unwrap(),
            "127.0.0.1:9090"
        );
        assert_eq!(value.get("secret").unwrap().as_str().unwrap(), "s3cret");
        assert_eq!(value.get("mixed-port").unwrap().as_i64().unwrap(), 7890);
    }

    #[test]
    fn test_tagged_provider_path_is_removed() {
        let yaml = "proxy-providers:\n  p:\n    type: http\n    url: https://example.com/p.yaml\n    !!str path: ../../etc/evil.yaml\n";
        let mut value: serde_yaml::Value = serde_yaml::from_str(yaml).unwrap();
        remove_dangerous_keys_internal_pub(&mut value, false);
        let provider = value
            .get("proxy-providers")
            .and_then(|v| v.get("p"))
            .and_then(serde_yaml::Value::as_mapping)
            .unwrap();
        assert!(
            provider.keys().all(|k| resolved_key_str(k) != Some("path")),
            "tagged path survived: {provider:?}"
        );
        assert!(provider.contains_key("url"));
    }

    #[test]
    fn test_dangerous_keys_removed_inside_tagged_values() {
        let yaml = "proxy-providers:\n  p: !custom {type: http, url: 'https://example.com/p.yaml', path: /etc/passwd}\nwrapper: !custom {script: evil.js, name: keep}\n";
        let mut value: serde_yaml::Value = serde_yaml::from_str(yaml).unwrap();
        remove_dangerous_keys_internal_pub(&mut value, false);
        let out = serde_yaml::to_string(&value).unwrap();
        assert!(!out.contains("/etc/passwd"), "path survived: {out}");
        assert!(!out.contains("script"), "script survived: {out}");
        assert!(out.contains("example.com"), "provider lost: {out}");
        assert!(out.contains("keep"), "benign value lost: {out}");
    }

    #[test]
    fn test_tagged_type_marks_provider() {
        let yaml = "proxy-providers:\n  p:\n    !!str type: file\n    path: ../../etc/evil.yaml\n";
        let mut value: serde_yaml::Value = serde_yaml::from_str(yaml).unwrap();
        remove_dangerous_keys_internal_pub(&mut value, false);
        let provider = value
            .get("proxy-providers")
            .and_then(|v| v.get("p"))
            .and_then(serde_yaml::Value::as_mapping)
            .unwrap();
        assert!(
            !provider.contains_key("path"),
            "path survived: {provider:?}"
        );
    }

    #[test]
    fn test_strips_external_controller_unix() {
        assert_control_key_stripped("external-controller-unix", "/tmp/mihomo.sock");
    }

    #[test]
    fn test_strips_external_controller_pipe() {
        assert_control_key_stripped("external-controller-pipe", r"'\\.\pipe\mihomo'");
    }

    #[test]
    fn test_strips_external_controller_tls() {
        assert_control_key_stripped("external-controller-tls", "0.0.0.0:9443");
    }

    #[test]
    fn test_strips_external_controller_cors() {
        assert_control_key_stripped(
            "external-controller-cors",
            "{allow-origins: ['*'], allow-private-network: true}",
        );
    }

    #[test]
    fn test_strips_external_doh_server() {
        assert_control_key_stripped("external-doh-server", "/dns-query");
    }

    #[test]
    fn test_strips_external_ui() {
        assert_control_key_stripped("external-ui", "/tmp/ui");
    }

    #[test]
    fn test_strips_external_ui_url() {
        assert_control_key_stripped("external-ui-url", "https://example.com/ui.zip");
    }

    #[test]
    fn test_strips_external_ui_name() {
        assert_control_key_stripped("external-ui-name", "evil");
    }

    #[test]
    fn test_control_plane_key_list_is_covered() {
        // Guard: every blacklisted key has a dedicated regression test above.
        assert_eq!(CONTROL_PLANE_KEYS.len(), 8);
    }

    #[test]
    fn test_strips_control_plane_keys_from_merge_sources() {
        let yaml = r"
base: &base
  external-controller-unix: /tmp/a.sock
  external-doh-server: /dns-query
nested: &nested
  <<: *base
  external-ui: /tmp/ui
<<: [*nested, {external-controller-pipe: '\\.\pipe\x', log-level: info}]
mixed-port: 7890
";
        let mut value: serde_yaml::Value = serde_yaml::from_str(yaml).unwrap();
        // Sanity: without sanitizing, resolving the merge exposes the keys.
        let mut unsanitized = value.clone();
        resolve_merges(&mut unsanitized);
        let unsanitized_keys = top_level_keys(&unsanitized);
        for key in [
            "external-controller-unix",
            "external-controller-pipe",
            "external-doh-server",
        ] {
            assert!(
                unsanitized_keys.iter().any(|k| k == key),
                "fixture lacks {key}"
            );
        }

        remove_dangerous_keys_internal_pub(&mut value, false);
        let out = serde_yaml::to_string(&value).unwrap();
        // Applying the merge (as mihomo does) must not resurface any control key.
        let mut merged: serde_yaml::Value = serde_yaml::from_str(&out).unwrap();
        resolve_merges(&mut merged);
        let keys = top_level_keys(&merged);
        for key in CONTROL_PLANE_KEYS {
            assert!(
                !keys.iter().any(|k| k == key),
                "{key} survived merge: {keys:?}"
            );
        }
        assert!(keys.iter().any(|k| k == "log-level"));
        assert!(keys.iter().any(|k| k == "mixed-port"));
    }

    #[test]
    fn test_control_plane_like_keys_below_root_are_untouched() {
        // Only the root mapping is a mihomo config; nested data is left alone.
        let yaml = r"
proxies:
  - name: p
    type: ss
    server: 1.2.3.4
    port: 8388
    external-ui: keep-me
";
        let mut value: serde_yaml::Value = serde_yaml::from_str(yaml).unwrap();
        remove_dangerous_keys_internal_pub(&mut value, false);
        let proxy = value.get("proxies").unwrap().get(0).unwrap();
        assert_eq!(
            proxy.get("external-ui").unwrap().as_str().unwrap(),
            "keep-me"
        );
    }

    #[test]
    fn test_remove_control_plane_keys_ignores_non_mapping_root() {
        let mut value = serde_yaml::Value::String("external-ui".to_owned());
        remove_control_plane_keys(&mut value);
        assert_eq!(value.as_str().unwrap(), "external-ui");
    }

    #[test]
    fn test_remove_control_plane_keys_json_strips_top_level() {
        let mut value = serde_json::json!({
            "mixed-port": 7890,
            "external-controller-unix": "/tmp/a.sock",
            "external-ui": "/tmp/ui",
            "external-controller": "127.0.0.1:9090",
            "secret": "s3cr3t",
            "proxies": [{ "name": "p", "external-ui": "keep-me" }],
        });
        remove_control_plane_keys_json(&mut value);
        let obj = value.as_object().unwrap();
        assert!(!obj.contains_key("external-controller-unix"));
        assert!(!obj.contains_key("external-ui"));
        assert_eq!(obj.get("mixed-port").unwrap(), 7890);
        assert_eq!(obj.get("external-controller").unwrap(), "127.0.0.1:9090");
        assert_eq!(obj.get("secret").unwrap(), "s3cr3t");
        assert_eq!(
            obj.get("proxies")
                .unwrap()
                .get(0)
                .unwrap()
                .get("external-ui")
                .unwrap(),
            "keep-me"
        );
    }

    #[test]
    fn test_remove_control_plane_keys_json_strips_merge_sources() {
        let mut value = serde_json::json!({
            "mixed-port": 7890,
            "<<": {
                "external-controller-unix": "/tmp/a.sock",
                "log-level": "info",
            },
        });
        remove_control_plane_keys_json(&mut value);
        let merged = value.get("<<").unwrap().as_object().unwrap();
        assert!(!merged.contains_key("external-controller-unix"));
        assert_eq!(merged.get("log-level").unwrap(), "info");
    }

    #[test]
    fn test_remove_control_plane_keys_json_ignores_non_object_root() {
        let mut value = serde_json::json!("external-ui");
        remove_control_plane_keys_json(&mut value);
        assert_eq!(value.as_str().unwrap(), "external-ui");
    }

    #[test]
    fn test_remove_dangerous_keys_json_strips_provider_paths() {
        let mut value = serde_json::json!({
            "mixed-port": 7890,
            "script-path": "/tmp/evil.js",
            "proxy-providers": {
                "rules": { "type": "http", "url": "https://example.com/rules.yaml", "path": "./rules.yaml", "interval": 3600 },
                "local": { "type": "file", "path": "./local.yaml" },
            },
            "rule-providers": {
                "ads": { "type": "http", "url": "https://example.com/ads.yaml", "path": "./ads.yaml", "behavior": "domain" },
            },
        });
        remove_dangerous_keys_json(&mut value);
        let obj = value.as_object().unwrap();
        assert!(!obj.contains_key("script-path"));
        assert_eq!(obj.get("mixed-port").unwrap(), 7890);
        let rules = obj
            .get("proxy-providers")
            .unwrap()
            .get("rules")
            .unwrap()
            .as_object()
            .unwrap();
        assert!(!rules.contains_key("path"));
        assert_eq!(rules.get("url").unwrap(), "https://example.com/rules.yaml");
        assert_eq!(rules.get("interval").unwrap(), 3600);
        let local = obj
            .get("proxy-providers")
            .unwrap()
            .get("local")
            .unwrap()
            .as_object()
            .unwrap();
        assert!(!local.contains_key("path"));
        assert_eq!(local.get("type").unwrap(), "file");
        let ads = obj
            .get("rule-providers")
            .unwrap()
            .get("ads")
            .unwrap()
            .as_object()
            .unwrap();
        assert!(!ads.contains_key("path"));
        assert_eq!(ads.get("behavior").unwrap(), "domain");
    }

    #[test]
    fn test_remove_dangerous_keys_json_keeps_non_provider_paths() {
        // A `path` outside a provider (a log path, for example) is
        // not a provider path and must survive.
        let mut value = serde_json::json!({
            "log": { "path": "/var/log/mihomo.log" },
            "tun": { "enable": true },
            "dns": { "nameserver": ["8.8.8.8"] },
        });
        remove_dangerous_keys_json(&mut value);
        assert_eq!(
            value.get("log").unwrap().get("path").unwrap(),
            "/var/log/mihomo.log"
        );
    }

    #[test]
    fn test_remove_dangerous_keys_json_strips_merge_inherited_provider_path() {
        // The provider's `type` comes from a `<<` merge source while
        // `path` is local: still a provider, still stripped.
        let mut value = serde_json::json!({
            "proxy-providers": {
                "rules": {
                    "<<": { "type": "http", "url": "https://example.com/rules.yaml" },
                    "path": "./rules.yaml",
                    "interval": 3600,
                },
            },
        });
        remove_dangerous_keys_json(&mut value);
        let rules = value
            .get("proxy-providers")
            .unwrap()
            .get("rules")
            .unwrap()
            .as_object()
            .unwrap();
        assert!(!rules.contains_key("path"));
        assert_eq!(rules.get("interval").unwrap(), 3600);
    }

    #[test]
    fn test_remove_dangerous_keys_json_strips_cfw_keys() {
        // The six Clash-for-Windows legacy keys are stripped from
        // every mapping on the JSON side too, matching the YAML side
        // — a script could otherwise add them to the running config
        // where the import sanitizer never sees them.
        let mut value = serde_json::json!({
            "cfw-bypass": ["example.com"],
            "prepend-proxy-groups": ["PROXY"],
            "mixed-port": 7890,
            "tun": { "cfw-conn-break-strategy": "always", "enable": true },
        });
        remove_dangerous_keys_json(&mut value);
        let obj = value.as_object().unwrap();
        assert!(!obj.contains_key("cfw-bypass"));
        assert!(!obj.contains_key("prepend-proxy-groups"));
        assert_eq!(obj.get("mixed-port").unwrap(), 7890);
        let tun = obj.get("tun").unwrap().as_object().unwrap();
        assert!(!tun.contains_key("cfw-conn-break-strategy"));
        assert_eq!(tun.get("enable").unwrap(), true);
    }

    #[test]
    fn test_remove_control_plane_keys_json_drops_over_deep_merge_source() {
        // A `<<` chain nested past MAX_YAML_DEPTH: mihomo resolves nested
        // merges, so a control-plane key at the bottom would merge its way
        // up to the root — the over-deep source is dropped instead of left
        // in place (same rule as the YAML side).
        fn chain(depth: usize) -> serde_json::Value {
            let mut value = serde_json::json!({"external-controller-unix": "/tmp/x"});
            for _ in 0..depth {
                value = serde_json::json!({"<<": value});
            }
            value
        }
        fn walk(mut value: &serde_json::Value, depth: usize) -> &serde_json::Value {
            for _ in 0..depth {
                value = &value["<<"];
            }
            value
        }

        let mut deep = chain(MAX_YAML_DEPTH + 1);
        remove_control_plane_keys_json(&mut deep);
        assert!(
            walk(&deep, MAX_YAML_DEPTH + 1).is_null(),
            "over-deep merge source must be dropped, got: {deep}"
        );
        assert!(!deep.to_string().contains("external-controller-unix"));

        // At the cap itself the key is stripped and the chain stays.
        let mut at_cap = chain(MAX_YAML_DEPTH);
        remove_control_plane_keys_json(&mut at_cap);
        assert!(!at_cap.to_string().contains("external-controller-unix"));
        assert!(walk(&at_cap, MAX_YAML_DEPTH).is_object());
    }

    #[test]
    fn test_validate_path_within_dir_lexical() {
        // Controlled paths only: the old `/var/app` base depended on a
        // system directory being traversable by the test user.
        let unique = format!("zephyr_test_lexical_{}", std::process::id());
        let base = std::env::temp_dir().join(&unique).join("profiles");
        let sibling = |name: &str| base.parent().unwrap().join(name);

        // Valid inside paths
        assert!(validate_path_within_dir(&base.join("profile.yaml"), &base).is_ok());
        assert!(validate_path_within_dir(&base.join("sub/profile.yaml"), &base).is_ok());
        assert!(validate_path_within_dir(&base.join("./profile.yaml"), &base).is_ok());
        assert!(validate_path_within_dir(&base.join("sub/../profile.yaml"), &base).is_ok());

        // Rejection of sibling prefix collision (e.g. profiles_evil or profiles-bak)
        assert!(
            validate_path_within_dir(&sibling("profiles_evil").join("profile.yaml"), &base)
                .is_err()
        );
        assert!(
            validate_path_within_dir(&sibling("profiles-bak").join("profile.yaml"), &base).is_err()
        );

        // Rejection of traversal escaping base
        assert!(validate_path_within_dir(&base.join("../../etc/passwd"), &base).is_err());
        assert!(validate_path_within_dir(&base.join("sub/../../other.yaml"), &base).is_err());
        assert!(validate_path_within_dir(&sibling("other.yaml"), &base).is_err());
    }

    // Windows only: `Path::starts_with` compares components exactly
    // even there, so a symlink target stored with different casing
    // than the base must still match. Runs on the Windows CI job.
    #[test]
    #[cfg(windows)]
    fn test_path_starts_with_case_aware_windows() {
        use std::path::Path;
        // Same path, different case throughout (drive letter included).
        assert!(path_starts_with_case_aware(
            Path::new(r"c:\data\sub\file.yaml"),
            Path::new(r"C:\Data\Sub"),
        ));
        // A differently-cased sibling directory is still outside:
        // the comparison is component-wise, not a string prefix.
        assert!(!path_starts_with_case_aware(
            Path::new(r"C:\Data2\file.yaml"),
            Path::new(r"C:\Data"),
        ));
        assert!(!path_starts_with_case_aware(
            Path::new(r"C:\Other\file.yaml"),
            Path::new(r"C:\Data"),
        ));
        // A shorter path cannot contain the base.
        assert!(!path_starts_with_case_aware(
            Path::new(r"C:\Data"),
            Path::new(r"C:\Data\Sub"),
        ));
    }

    #[test]
    fn test_validate_path_within_dir_filesystem() {
        let unique = format!("zephyr_test_{}", std::process::id());
        let temp_dir = std::env::temp_dir().join(&unique);
        let profiles = temp_dir.join("profiles");
        let profiles_evil = temp_dir.join("profiles_evil");
        std::fs::create_dir_all(&profiles).unwrap();
        std::fs::create_dir_all(&profiles_evil).unwrap();

        let valid_file = profiles.join("valid.yaml");
        std::fs::write(&valid_file, "valid").unwrap();

        let nonexistent_valid = profiles.join("new.yaml");
        let evil_file = profiles_evil.join("evil.yaml");
        // Actually create the outside file: otherwise the assertions
        // below only exercise the missing-target branch, and a broken
        // existing-target branch could still pass.
        std::fs::write(&evil_file, "evil").unwrap();
        let traversal_target = profiles.join("../profiles_evil/evil.yaml");

        assert!(validate_path_within_dir(&valid_file, &profiles).is_ok());
        assert!(validate_path_within_dir(&nonexistent_valid, &profiles).is_ok());
        assert!(validate_path_within_dir(&evil_file, &profiles).is_err());
        assert!(validate_path_within_dir(&traversal_target, &profiles).is_err());

        // Cleanup
        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_validate_path_within_dir_root_parent() {
        // `/..` resolves to `/`, so root-level `..` components must not
        // push a genuinely inside path outside the base. A root-level
        // base keeps this independent of any system directory.
        let base = Path::new("/profiles");
        assert!(validate_path_within_dir(Path::new("/../profiles/profile.yaml"), base).is_ok());
    }

    #[test]
    #[cfg(windows)]
    fn test_validate_path_within_dir_unc_root_base() {
        // A bare UNC root (`\\server\share`) is a directory root, not
        // a missing first component: files under it must validate, and
        // a sibling share must still be refused. A bare drive prefix
        // (`C:`) names no directory and stays rejected.
        let base = Path::new(r"\\server\share");
        assert!(validate_path_within_dir(Path::new(r"\\server\share\profile.yaml"), base).is_ok());
        assert!(validate_path_within_dir(Path::new(r"\\server\other\profile.yaml"), base).is_err());
        assert!(validate_path_within_dir(Path::new(r"C:\profile.yaml"), Path::new("C:")).is_err());
    }

    #[test]
    fn test_validate_path_within_dir_relative_parent_base_rejected() {
        // A base that normalizes to a leading `..` escapes whatever it
        // is relative to: `../../outside.yaml` starts with `..`, so
        // without this check the validator would pass an escaping path.
        assert!(
            validate_path_within_dir(Path::new("../../outside.yaml"), Path::new("..")).is_err()
        );
        assert!(validate_path_within_dir(
            Path::new("../profiles/inside.yaml"),
            Path::new("../profiles")
        )
        .is_err());
    }

    #[test]
    #[cfg(unix)]
    fn test_validate_path_within_dir_dangling_symlinks() {
        use std::os::unix::fs::symlink;
        let unique = format!("zephyr_test_symlink_{}", std::process::id());
        let temp_dir = std::env::temp_dir().join(&unique);
        let profiles = temp_dir.join("profiles");
        std::fs::create_dir_all(&profiles).unwrap();

        // Dangling link pointing outside the base must be rejected even
        // though exists() follows links and reports it as missing.
        let link_out = profiles.join("link_out");
        symlink(temp_dir.join("outside.yaml"), &link_out).unwrap();
        assert!(validate_path_within_dir(&link_out, &profiles).is_err());

        // Dangling link pointing inside the base stays allowed.
        let link_in = profiles.join("link_in");
        symlink(profiles.join("new.yaml"), &link_in).unwrap();
        assert!(validate_path_within_dir(&link_in, &profiles).is_ok());

        // A dangling link whose target is relative to its own directory
        // must resolve against the parent, not the process root.
        assert!(!profiles.join("new.yaml").exists());
        let link_relative = profiles.join("link_relative");
        symlink("new.yaml", &link_relative).unwrap();
        assert!(validate_path_within_dir(&link_relative, &profiles).is_ok());

        // Chained links: an inside link to another link that leaves the
        // base must still be rejected.
        let link_mid = profiles.join("link_mid");
        symlink(&link_out, &link_mid).unwrap();
        assert!(validate_path_within_dir(&link_mid, &profiles).is_err());

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    #[cfg(unix)]
    fn test_validate_path_within_dir_inspection_error_fails_closed() {
        // A path component that is a regular file, not a directory:
        // nothing below it can ever resolve, and the inspection error
        // (ENOTDIR) must fail closed instead of being treated as a
        // missing component that a later `..` could cancel.
        // Unix-only: Windows maps this error to NotFound, so the
        // distinction the validator draws on does not exist there.
        let unique = format!("zephyr_test_notdir_{}", std::process::id());
        let temp_dir = std::env::temp_dir().join(&unique);
        let profiles = temp_dir.join("profiles");
        std::fs::create_dir_all(&profiles).unwrap();
        std::fs::write(profiles.join("blocker"), "not a dir").unwrap();
        assert!(
            validate_path_within_dir(&profiles.join("blocker").join("child.yaml"), &profiles)
                .is_err()
        );
        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    #[cfg(unix)]
    fn test_validate_path_within_dir_symlinked_base_new_file() {
        use std::os::unix::fs::symlink;
        let unique = format!("zephyr_test_symlink_base_{}", std::process::id());
        let temp_dir = std::env::temp_dir().join(&unique);
        let real = temp_dir.join("real_profiles");
        std::fs::create_dir_all(&real).unwrap();
        // The base itself sits behind a symlink, as a macOS temp dir
        // does below /var: a not-yet-existing child must still pass.
        let linked_base = temp_dir.join("linked_profiles");
        symlink(&real, &linked_base).unwrap();
        let new_file = linked_base.join("new.yaml");
        assert!(validate_path_within_dir(&new_file, &linked_base).is_ok());
        assert!(validate_path_within_dir(&real.join("new.yaml"), &linked_base).is_ok());

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    #[cfg(unix)]
    fn test_validate_path_within_dir_long_symlink_chain_rejected() {
        use std::os::unix::fs::symlink;
        let unique = format!("zephyr_test_long_chain_{}", std::process::id());
        // Canonicalize the temp dir first: on macOS it sits below /var,
        // a link to /private/var, and expanding that prefix would eat
        // one of the 40 replacements the test is counting.
        let temp_dir = std::env::temp_dir().canonicalize().unwrap().join(&unique);
        let profiles = temp_dir.join("profiles");
        std::fs::create_dir_all(&profiles).unwrap();
        // 41 links: past the 40-replacement cap, the last link still
        // points outside the base and must not be returned unchecked.
        let outside = temp_dir.join("outside.yaml");
        let mut previous = outside;
        for i in (0..41).rev() {
            let link = profiles.join(format!("link{i}"));
            symlink(&previous, &link).unwrap();
            previous = link;
        }
        assert!(validate_path_within_dir(&previous, &profiles).is_err());

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_validate_path_within_dir_empty_base_rejects_traversal() {
        // "." normalizes to an empty path, and every path starts
        // with an empty prefix: without the fail-closed check above,
        // a missing "../..." target would pass containment.
        assert!(validate_path_within_dir(Path::new("../etc/passwd"), Path::new(".")).is_err());
        assert!(validate_path_within_dir(Path::new("../etc/passwd"), Path::new("")).is_err());
    }

    #[test]
    #[cfg(unix)]
    fn test_validate_path_within_dir_outside_dir_link_missing_child() {
        use std::os::unix::fs::symlink;
        let unique = format!("zephyr_test_dir_link_{}", std::process::id());
        let temp_dir = std::env::temp_dir().join(&unique);
        let profiles = temp_dir.join("profiles");
        let outside = temp_dir.join("outside");
        std::fs::create_dir_all(&profiles).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        // In-base directory link to an outside directory; the child does not exist.
        let link_dir = profiles.join("link_dir");
        symlink(&outside, &link_dir).unwrap();
        assert!(validate_path_within_dir(&link_dir.join("new.yaml"), &profiles).is_err());

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    #[cfg(unix)]
    fn test_validate_path_within_dir_40_link_chain_accepted() {
        use std::os::unix::fs::symlink;
        let unique = format!("zephyr_test_chain_40_{}", std::process::id());
        // Canonicalize the temp dir first: on macOS it sits below /var,
        // a link to /private/var, and expanding that prefix would eat
        // one of the 40 replacements, so a 40-link chain would fail
        // there while passing on Linux.
        let temp_dir = std::env::temp_dir().canonicalize().unwrap().join(&unique);
        let profiles = temp_dir.join("profiles");
        std::fs::create_dir_all(&profiles).unwrap();
        // 40 links: exactly at the 40-replacement cap. The final target is
        // missing and inside the base, so the chain must be accepted.
        let inside = profiles.join("new.yaml");
        let mut previous = inside;
        for i in (0..40).rev() {
            let link = profiles.join(format!("link{i}"));
            symlink(&previous, &link).unwrap();
            previous = link;
        }
        assert!(validate_path_within_dir(&previous, &profiles).is_ok());

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    #[cfg(unix)]
    fn test_validate_path_within_dir_missing_dir_parent_link_escapes() {
        use std::os::unix::fs::symlink;
        let unique = format!("zephyr_test_missing_parent_link_{}", std::process::id());
        let temp_dir = std::env::temp_dir().join(&unique);
        let profiles = temp_dir.join("profiles");
        let outside = temp_dir.join("outside");
        std::fs::create_dir_all(&profiles).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        // The link sits behind a `..` that follows a directory which
        // does not exist yet: probing the raw path can never see it
        // (the OS cannot resolve through the missing directory), but
        // once the directory is created a write would follow the link
        // out of the base. The `..` must cancel the missing component
        // lexically, so the link is probed at its real location.
        let link = profiles.join("link");
        symlink(&outside, &link).unwrap();
        let target = profiles
            .join("missing")
            .join("..")
            .join("link")
            .join("new.yaml");
        assert!(validate_path_within_dir(&target, &profiles).is_err());

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    #[cfg(unix)]
    fn test_validate_path_within_dir_symlink_then_parent_escapes() {
        use std::os::unix::fs::symlink;
        let unique = format!("zephyr_test_link_parent_{}", std::process::id());
        let temp_dir = std::env::temp_dir().join(&unique);
        let profiles = temp_dir.join("profiles");
        let outside_deep = temp_dir.join("outside").join("deep");
        std::fs::create_dir_all(&profiles).unwrap();
        std::fs::create_dir_all(&outside_deep).unwrap();
        // In-base link to an outside directory, followed by `..`.
        // Expanding the link first gives /outside/new.yaml, which leaves the base.
        let link = profiles.join("link");
        symlink(&outside_deep, &link).unwrap();
        assert!(validate_path_within_dir(&link.join("..").join("new.yaml"), &profiles).is_err());

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    #[cfg(unix)]
    fn test_validate_path_within_dir_symlink_then_parent_stays_inside() {
        use std::os::unix::fs::symlink;
        let unique = format!("zephyr_test_link_parent_inside_{}", std::process::id());
        let temp_dir = std::env::temp_dir().join(&unique);
        let profiles = temp_dir.join("profiles");
        let deep = profiles.join("sub").join("deep");
        std::fs::create_dir_all(&deep).unwrap();
        // In-base link to an in-base directory, followed by `..`:
        // following the link first gives profiles/new.yaml, which is
        // inside the base — the same path Windows resolves. Lexically
        // normalizing the `..` first would wrongly reject it.
        let link = profiles.join("link");
        symlink("sub/deep", &link).unwrap();
        assert!(
            validate_path_within_dir(&link.join("..").join("..").join("new.yaml"), &profiles)
                .is_ok()
        );
        // One more `..` escapes the base and must still be rejected.
        assert!(validate_path_within_dir(
            &link.join("..").join("..").join("..").join("new.yaml"),
            &profiles
        )
        .is_err());

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    #[cfg(windows)]
    fn test_validate_path_within_dir_drive_relative_base_rejected() {
        // A drive-relative base (`C:..`) is not anchored: a missing
        // `C:..\..\outside.yaml` would otherwise pass the starts_with
        // check against it while resolving outside the base.
        let base = std::path::Path::new("C:..");
        assert!(validate_path_within_dir(
            std::path::Path::new("C:..\\..\\zephyr-nonexistent-outside.yaml"),
            base
        )
        .is_err());
        // A bare drive prefix names no directory and would match every
        // path on the drive.
        assert!(validate_path_within_dir(
            std::path::Path::new("C:\\zephyr-nonexistent-12345\\foo.yaml"),
            std::path::Path::new("C:")
        )
        .is_err());
    }

    #[test]
    #[cfg(unix)]
    fn test_validate_path_within_dir_missing_parent_link_suffix_escapes() {
        use std::os::unix::fs::symlink;
        let unique = format!("zephyr_test_missing_suffix_{}", std::process::id());
        let temp_dir = std::env::temp_dir().join(&unique);
        let profiles = temp_dir.join("profiles");
        let sub = profiles.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        // In-base link to an in-base directory, reached through a `..`
        // that cancels a directory which does not exist yet. The old
        // expansion recovered the suffix with `strip_prefix` on the raw
        // path, which fails here (the resolved prefix `/base/link` is not
        // a lexical prefix of `/base/missing/../link/...`), so the
        // `../../etc/x` tail was silently dropped and the path accepted —
        // even though creating `missing` first makes it resolve outside
        // the base.
        let link = profiles.join("link");
        symlink(&sub, &link).unwrap();
        let escaping = profiles
            .join("missing")
            .join("..")
            .join("link")
            .join("..")
            .join("..")
            .join("etc")
            .join("x");
        assert!(validate_path_within_dir(&escaping, &profiles).is_err());
        // The same shape with a tail that stays inside must still pass:
        // the fix preserves the suffix instead of rejecting the path.
        let inside = profiles
            .join("missing")
            .join("..")
            .join("link")
            .join("new.yaml");
        assert!(validate_path_within_dir(&inside, &profiles).is_ok());

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    #[cfg(unix)]
    fn test_validate_path_within_dir_long_chain_missing_parent_link_rejected() {
        use std::os::unix::fs::symlink;
        let unique = format!("zephyr_test_chain_missing_{}", std::process::id());
        // Canonicalize like the other chain tests: the temp dir sits below
        // /var on macOS, and expanding that prefix would eat one of the 40
        // replacements the test is counting.
        let temp_dir = std::env::temp_dir().canonicalize().unwrap().join(&unique);
        let profiles = temp_dir.join("profiles");
        let outside = temp_dir.join("outside");
        std::fs::create_dir_all(&profiles).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        // A 40-link chain whose last link points at a path with a link
        // hidden behind `missing/..`: after the 40th replacement the loop
        // stops, and the final scan must still see through the missing
        // component to the link — otherwise the path is accepted and
        // resolves outside once `missing` exists.
        let escape = profiles.join("escape");
        symlink(&outside, &escape).unwrap();
        let tail = profiles
            .join("missing")
            .join("..")
            .join("escape")
            .join("new.yaml");
        let mut previous = tail;
        for i in (0..40).rev() {
            let link = profiles.join(format!("link{i}"));
            symlink(&previous, &link).unwrap();
            previous = link;
        }
        assert!(validate_path_within_dir(&previous, &profiles).is_err());

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn merged_json_mapping_get_mut_writes_into_merge_source() {
        // The value lives in a `<<` merge source: the mutable lookup
        // must return the value where it lives, so writing through it
        // changes the source — not a flat copy at the top level — and
        // a direct key wins over an inherited one.
        let mut root = serde_json::json!({
            "<<": { "proxy-providers": { "local": { "type": "file" } } },
            "port": 7890
        });
        let section =
            merged_json_mapping_get_mut(root.as_object_mut().unwrap(), "proxy-providers", 0)
                .unwrap();
        section
            .as_object_mut()
            .unwrap()
            .insert("extra".to_owned(), serde_json::json!("yes"));
        assert_eq!(
            root.get("<<")
                .and_then(|v| v.get("proxy-providers"))
                .and_then(|v| v.get("extra")),
            Some(&serde_json::json!("yes"))
        );
        assert!(root.get("proxy-providers").is_none());

        // A direct key wins: the lookup returns the direct value, not
        // the merge source's.
        let mut root = serde_json::json!({
            "<<": { "port": 1111 },
            "port": 7890
        });
        let value = merged_json_mapping_get_mut(root.as_object_mut().unwrap(), "port", 0).unwrap();
        assert_eq!(*value, serde_json::json!(7890));
        *value = serde_json::json!(9090);
        assert_eq!(root.get("port"), Some(&serde_json::json!(9090)));
        assert_eq!(
            root.get("<<").and_then(|v| v.get("port")),
            Some(&serde_json::json!(1111))
        );
    }

    #[test]
    fn merged_mapping_get_mut_writes_into_merge_source() {
        // Same rule for YAML mappings: the section lives in a `<<`
        // merge source, and writing through the lookup lands in the
        // source — not flat at the root.
        let mut value: serde_yaml::Value =
            serde_yaml::from_str("<<:\n  proxy-providers:\n    local:\n      type: file\n")
                .unwrap();
        let section =
            merged_mapping_get_mut(value.as_mapping_mut().unwrap(), "proxy-providers", 0).unwrap();
        section.as_mapping_mut().unwrap().insert(
            serde_yaml::Value::String("added".to_owned()),
            serde_yaml::Value::String("yes".to_owned()),
        );
        let merged = merged_mapping_get(value.as_mapping().unwrap(), "proxy-providers", 0).unwrap();
        assert!(merged
            .as_mapping()
            .unwrap()
            .get(serde_yaml::Value::String("added".to_owned()))
            .is_some());
        assert!(value
            .as_mapping()
            .unwrap()
            .get(serde_yaml::Value::String("proxy-providers".to_owned()))
            .is_none());
    }

    #[test]
    fn merged_json_mapping_keys_lists_direct_and_merged_keys() {
        // Direct keys first, then keys inherited through `<<` (a single
        // object or an array of objects, earlier first), each once,
        // `<<` itself excluded; merge sources may themselves carry `<<`.
        let root = serde_json::json!({
            "direct": 1,
            "<<": [
                { "inherited": 2, "direct": 99 },
                { "second": 3, "<<": { "nested": 4 } }
            ]
        });
        assert_eq!(
            merged_json_mapping_keys(root.as_object().unwrap()),
            vec!["direct", "inherited", "second", "nested"]
        );
        // No merge source: just the direct keys.
        let plain = serde_json::json!({ "a": 1, "b": 2 });
        assert_eq!(
            merged_json_mapping_keys(plain.as_object().unwrap()),
            vec!["a", "b"]
        );
    }

    #[test]
    fn merged_mapping_keys_lists_direct_and_merged_keys() {
        // Same rule for YAML mappings, including a sequence merge
        // source and a nested `<<`.
        let value: serde_yaml::Value = serde_yaml::from_str(
            "direct: 1\n<<:\n  - inherited: 2\n    direct: 99\n  - second: 3\n    <<:\n      nested: 4\n",
        )
        .unwrap();
        assert_eq!(
            merged_mapping_keys(value.as_mapping().unwrap()),
            vec!["direct", "inherited", "second", "nested"]
        );
    }
}

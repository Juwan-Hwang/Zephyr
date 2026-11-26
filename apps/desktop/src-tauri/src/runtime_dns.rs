//! Apply the DNS preference as a runtime overlay without changing profile files.

use std::time::{Duration, Instant};

use serde_json::Value as JsonValue;
use serde_yaml::Value as YamlValue;
use tauri::Manager as _;
use zephyr_core::config::sanitizer::{merged_mapping_get, remove_keys_resolved};

const PROXY_SWITCH_UNCONFIRMED: &str = "Proxy switch outcome is unconfirmed";

fn read_controller_json(
    response: reqwest::blocking::Response,
    description: &str,
) -> Result<JsonValue, String> {
    use std::io::Read as _;
    let limit = crate::core_manager::core::MAX_RESPONSE_SIZE;
    let mut bytes = Vec::new();
    response
        .take(u64::try_from(limit + 1).unwrap_or(u64::MAX))
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Failed to read {description}: {error}"))?;
    if bytes.len() > limit {
        return Err(format!("{description} exceeds the size limit"));
    }
    serde_json::from_slice(&bytes).map_err(|error| format!("Invalid {description}: {error}"))
}

/// A full reload replaces selectors even when profile.store-selected is false.
/// Carry their live choices in this overlay only; never alter the saved base.
fn preserve_selector_choices(
    candidate: &mut YamlValue,
    live: &JsonValue,
) -> Result<Vec<(String, String)>, String> {
    let proxies = live
        .get("proxies")
        .and_then(JsonValue::as_object)
        .ok_or("Core returned an invalid proxy snapshot")?;
    let choice = |name: &str| -> Result<Option<&str>, String> {
        let Some(proxy) = proxies.get(name) else {
            return Err(format!("Live proxy group '{name}' is missing"));
        };
        if proxy.get("type").and_then(JsonValue::as_str) != Some("Selector") {
            return Ok(None);
        }
        proxy
            .get("now")
            .and_then(JsonValue::as_str)
            .filter(|selected| !selected.is_empty())
            .map(Some)
            .ok_or_else(|| format!("Live proxy group '{name}' has no selected node"))
    };
    let map = candidate
        .as_mapping_mut()
        .ok_or("Runtime config must be a mapping")?;
    let mut selections = Vec::new();
    if let Some(original_groups) = merged_mapping_get(map, "proxy-groups", 0) {
        let mut groups = original_groups.clone();
        let entries = groups
            .as_sequence_mut()
            .ok_or("Runtime proxy groups must be a sequence")?;
        for entry in entries {
            let group = entry
                .as_mapping_mut()
                .ok_or("Runtime proxy group must be a mapping")?;
            let group_type = merged_mapping_get(group, "type", 0).and_then(YamlValue::as_str);
            if group_type != Some("select") {
                continue;
            }
            let name = merged_mapping_get(group, "name", 0)
                .and_then(YamlValue::as_str)
                .ok_or("Runtime proxy group has no name")?;
            let selected = choice(name)?
                .ok_or_else(|| format!("Live proxy group '{name}' is no longer a selector"))?;
            selections.push((name.to_owned(), selected.to_owned()));
            remove_keys_resolved(group, &["default-selected"]);
            group.insert(
                YamlValue::String("default-selected".to_owned()),
                YamlValue::String(selected.to_owned()),
            );
        }
        remove_keys_resolved(map, &["proxy-groups"]);
        map.insert(YamlValue::String("proxy-groups".to_owned()), groups);
    }
    // The core synthesizes GLOBAL outside proxy-groups, with no configurable
    // default-selected. Restore it after reload while still holding mode lock.
    if !selections.iter().any(|(name, _)| name == "GLOBAL") {
        if let Some(selected) = choice("GLOBAL")? {
            selections.push(("GLOBAL".to_owned(), selected.to_owned()));
        }
    }
    Ok(selections)
}

fn changed_selector_choices<'a>(
    selections: &'a [(String, String)],
    live: &JsonValue,
) -> Result<Vec<(&'a str, &'a str)>, String> {
    let proxies = live
        .get("proxies")
        .and_then(JsonValue::as_object)
        .ok_or("Core returned an invalid proxy snapshot after DNS reload")?;
    let mut changed = Vec::new();
    for (group, selected) in selections {
        let current = proxies
            .get(group)
            .filter(|entry| entry.get("type").and_then(JsonValue::as_str) == Some("Selector"))
            .and_then(|entry| entry.get("now"))
            .and_then(JsonValue::as_str)
            .ok_or_else(|| format!("Proxy group '{group}' is unavailable after DNS reload"))?;
        if current != selected {
            changed.push((group.as_str(), selected.as_str()));
        }
    }
    Ok(changed)
}

fn proxy_group_url(port: u16, group: &str) -> Result<url::Url, String> {
    let mut target = url::Url::parse(&format!("http://127.0.0.1:{port}/proxies/"))
        .map_err(|error| error.to_string())?;
    target
        .path_segments_mut()
        .map_err(|()| "Invalid proxy controller URL".to_owned())?
        .pop_if_empty()
        .push(group);
    Ok(target)
}

fn send_proxy_selection(
    client: &reqwest::blocking::Client,
    port: u16,
    secret: &str,
    group: &str,
    name: &str,
    timeout: Duration,
) -> Result<(), String> {
    match client
        .put(proxy_group_url(port, group)?)
        .bearer_auth(secret)
        .json(&serde_json::json!({ "name": name }))
        .timeout(timeout)
        .send()
    {
        Ok(response) if response.status().is_success() => Ok(()),
        Ok(response) => Err(format!(
            "Core rejected proxy switch with HTTP {}",
            response.status()
        )),
        Err(error) if crate::config_manager::reload_may_still_land(&error) => Err(format!(
            "{PROXY_SWITCH_UNCONFIRMED}: {}",
            error.without_url()
        )),
        Err(error) => Err(format!(
            "Proxy switch did not reach the core: {}",
            error.without_url()
        )),
    }
}

fn restore_selector_choices(
    client: &reqwest::blocking::Client,
    port: u16,
    secret: &str,
    selections: &[(String, String)],
    same_core: impl Fn() -> bool,
) -> Result<(), String> {
    // Old cores ignore default-selected. Verify the actual selection and PUT
    // only differences; cap the entire restore, including all groups, at 5s.
    let deadline = Instant::now() + Duration::from_secs(5);
    let response = client
        .get(format!("http://127.0.0.1:{port}/proxies"))
        .bearer_auth(secret)
        .send()
        .and_then(reqwest::blocking::Response::error_for_status)
        .map_err(|error| error.without_url().to_string())?;
    let live = read_controller_json(response, "proxy snapshot after DNS reload")?;
    for (group, selected) in changed_selector_choices(selections, &live)? {
        if !same_core() {
            return Err("Core changed during selection restore".to_owned());
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("Proxy selection restoration timed out".to_owned());
        }
        send_proxy_selection(client, port, secret, group, selected, remaining)?;
    }
    Ok(())
}

/// Keep ordinary user selections ordered with full runtime overlays. GLOBAL
/// uses its existing mode lock and user-change generation through its command.
#[tauri::command]
pub async fn switch_proxy_node(
    app: tauri::AppHandle,
    group: String,
    name: String,
    generation: u64,
) -> Result<(), String> {
    if group == "GLOBAL" {
        return Err("GLOBAL switches require the global selection command".to_owned());
    }
    if crate::speed_test::speed_test_ready_generation()? != generation {
        return Err("Core configuration changed before the proxy switch".to_owned());
    }
    tokio::task::spawn_blocking(move || {
        let _config = crate::config_manager::lock_run_config_within(Duration::from_secs(5))?;
        if crate::speed_test::speed_test_ready_generation()? != generation {
            return Err("Core configuration changed before the proxy switch".to_owned());
        }
        let state = app.state::<crate::core_manager::MihomoState>();
        let (port, secret, instance) = {
            let core = crate::backend_event::lock_best_effort(&state.0);
            (
                core.last_port().ok_or("Core is stopped")?,
                core.last_secret().to_owned(),
                core.started_at(),
            )
        };
        let client = reqwest::blocking::Client::builder()
            .no_proxy()
            .connect_timeout(Duration::from_secs(1))
            .timeout(Duration::from_secs(5))
            .build()
            .map_err(|error| error.to_string())?;
        send_proxy_selection(
            &client,
            port,
            &secret,
            &group,
            &name,
            Duration::from_secs(5),
        )?;
        let core = crate::backend_event::lock_best_effort(&state.0);
        if core.last_port() != Some(port)
            || core.last_secret() != secret
            || core.started_at() != instance
            || crate::prism::pipeline::core_start_in_progress()
        {
            return Err(format!(
                "{PROXY_SWITCH_UNCONFIRMED}: core changed during the switch"
            ));
        }
        drop(core);
        Ok(())
    })
    .await
    .map_err(|error| format!("{PROXY_SWITCH_UNCONFIRMED}: {error}"))?
}

fn dns_candidate(
    source: &str,
    live: &JsonValue,
    enabled: bool,
    dns: Option<&JsonValue>,
) -> Result<YamlValue, String> {
    let mut candidate: YamlValue =
        serde_yaml::from_str(source).map_err(|error| format!("Invalid runtime config: {error}"))?;
    let map = candidate
        .as_mapping_mut()
        .ok_or("Runtime config must be a mapping")?;
    if !live.is_object() {
        return Err("Core returned an invalid general config".to_owned());
    }
    // GET /configs is only the general section. Preserve its mutable fields,
    // while rules, providers, credentials and DNS come from the confirmed base.
    // Its authentication list contains usernames only, so never copy it over
    // the confirmed user:password records needed by the full-config parser.
    for name in [
        "port",
        "socks-port",
        "redir-port",
        "tproxy-port",
        "mixed-port",
        "tun",
        "tuic-server",
        "ss-config",
        "vmess-config",
        "skip-auth-prefixes",
        "lan-allowed-ips",
        "lan-disallowed-ips",
        "allow-lan",
        "bind-address",
        "mode",
        "log-level",
        "unified-delay",
        "ipv6",
        "tcp-concurrent",
        "find-process-mode",
        "interface-name",
    ] {
        if let Some(value) = live.get(name) {
            remove_keys_resolved(map, &[name]);
            map.insert(
                YamlValue::String(name.to_owned()),
                serde_yaml::to_value(value).map_err(|error| error.to_string())?,
            );
        }
    }
    if enabled {
        let requested = dns
            .filter(|value| value.is_object())
            .ok_or("DNS settings are required")?;
        remove_keys_resolved(map, &["dns"]);
        map.insert(
            YamlValue::String("dns".to_owned()),
            serde_yaml::to_value(requested).map_err(|error| error.to_string())?,
        );
        let mut sniffer = zephyr_core::config::sanitizer::merged_mapping_get(map, "sniffer", 0)
            .and_then(YamlValue::as_mapping)
            .cloned()
            .unwrap_or_default();
        remove_keys_resolved(&mut sniffer, &["enable"]);
        sniffer.insert(
            YamlValue::String("enable".to_owned()),
            YamlValue::Bool(true),
        );
        remove_keys_resolved(map, &["sniffer"]);
        map.insert(
            YamlValue::String("sniffer".to_owned()),
            YamlValue::Mapping(sniffer),
        );
    }
    Ok(candidate)
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri hands commands the handle by value.
pub fn runtime_dns_ready(app: tauri::AppHandle) -> Result<bool, String> {
    let generation = crate::speed_test::speed_test_ready_generation()?;
    let state = app.state::<crate::core_manager::MihomoState>();
    let ready = {
        let core = crate::backend_event::lock_best_effort(&state.0);
        core.last_port().is_some() && core.confirmed_runtime_config().is_some()
    };
    if crate::speed_test::speed_test_ready_generation()? != generation {
        return Err("Core configuration changed during the DNS readiness read".to_owned());
    }
    Ok(ready)
}

#[tauri::command]
pub async fn apply_runtime_dns(
    app: tauri::AppHandle,
    enabled: bool,
    dns: Option<JsonValue>,
) -> Result<(), String> {
    apply_runtime_dns_inner(app, enabled, dns, false).await
}

/// A lightweight-mode reload has no page to restore the saved DNS preference.
pub(crate) async fn restore_saved_dns(app: tauri::AppHandle) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        match restore_saved_dns_once(app.clone()).await {
            Err(error) if retryable_dns_contention(&error) && Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
            result => return result,
        }
    }
}

fn retryable_dns_contention(error: &str) -> bool {
    matches!(
        error,
        "Proxy mode is changing; retry the runtime update"
            | "Subscription fallback is active; retry the runtime update"
            | "DNS update unavailable during core startup or reload"
    ) || error == crate::config_manager::RUN_CONFIG_BUSY
}

async fn restore_saved_dns_once(app: tauri::AppHandle) -> Result<(), String> {
    if app.get_webview_window("main").is_some() {
        return Ok(());
    }
    apply_runtime_dns_inner(app, true, None, true).await
}

// Keep these defaults identical to buildDnsRewritePayload in dns-shared.js.
fn saved_dns_payload(nameservers: Option<&[String]>, fallbacks: Option<&[String]>) -> JsonValue {
    serde_json::json!({
        "enable": true,
        "listen": "0.0.0.0:1053",
        "ipv6": false,
        "enhanced-mode": "fake-ip",
        "fake-ip-range": "198.18.0.0/16",
        "fake-ip-filter": [
            "*.lan", "*.local", "*.localhost", "*.localdomain",
            "localhost.ptlogin2.qq.com", "*.msftncsi.com", "*.srv.nintendo.net",
            "*.stun.playstation.net", "xbox.*.microsoft.com", "*.xboxlive.com",
            "*.stun.steamwire.com", "stun.*",
        ],
        "default-nameserver": ["223.5.5.5", "119.29.29.29", "1.1.1.1", "8.8.8.8"],
        "nameserver": nameservers.map_or_else(
            || serde_json::json!(["https://doh.pub/dns-query", "https://dns.alidns.com/dns-query"]),
            |values| serde_json::json!(values),
        ),
        "fallback": fallbacks.map_or_else(
            || serde_json::json!(["https://dns.cloudflare.com/dns-query", "https://dns.google/dns-query"]),
            |values| serde_json::json!(values),
        ),
    })
}

async fn apply_runtime_dns_inner(
    app: tauri::AppHandle,
    enabled: bool,
    dns: Option<JsonValue>,
    background_only: bool,
) -> Result<(), String> {
    let mode_guard = crate::core_manager::core::subscription::lock_mode_for_overlay().await?;
    tokio::task::spawn_blocking(move || {
        // Mode lock precedes the config lock. Its existing holders never take
        // RUN_CONFIG_LOCK; keep it until the live read and reload both finish.
        let _mode = mode_guard;
        let _config = crate::config_manager::lock_run_config_within(Duration::from_secs(5))?;
        // A newly opened page owns current/unsaved choices. It performs its
        // startup restoration; a previously queued background restore yields.
        if background_only && app.get_webview_window("main").is_some() {
            return Ok(());
        }
        // Read saved intent only after admission. A page may have opened,
        // saved another preference and closed while this worker waited.
        let requested_dns = if background_only {
            let settings_state = app.state::<crate::SettingsState>();
            let settings = crate::backend_event::lock_best_effort(&settings_state.0);
            if settings.dns_rewrite_enabled == Some(false) {
                return Ok(());
            }
            Some(saved_dns_payload(
                settings.dns_nameservers.as_deref(),
                settings.dns_fallbacks.as_deref(),
            ))
        } else {
            dns
        };
        if crate::prism::pipeline::core_start_in_progress() {
            return Err("DNS update unavailable during core startup or reload".to_owned());
        }
        let state = app.state::<crate::core_manager::MihomoState>();
        let (port, secret, instance, source) = {
            let core = crate::backend_event::lock_best_effort(&state.0);
            (
                core.last_port().ok_or("Core is stopped")?,
                core.last_secret().to_owned(),
                core.started_at(),
                core.confirmed_runtime_config()
                    .ok_or(
                        "DNS update requires a confirmed core configuration; reload or restart first",
                    )?
                    .to_owned(),
            )
        };
        let client = reqwest::blocking::Client::builder()
            .no_proxy()
            .connect_timeout(Duration::from_secs(1))
            .timeout(Duration::from_secs(5))
            .build()
            .map_err(|error| error.to_string())?;
        let diagnostics = crate::speed_test::ReloadGuard::acquire();
        let same_core = || {
            let core = crate::backend_event::lock_best_effort(&state.0);
            core.last_port() == Some(port)
                && core.last_secret() == secret
                && core.started_at() == instance
                && !crate::prism::pipeline::core_start_in_progress()
        };
        let general_response = client
            .get(format!("http://127.0.0.1:{port}/configs"))
            .bearer_auth(&secret)
            .send()
            .and_then(reqwest::blocking::Response::error_for_status)
            .map_err(|error| error.without_url().to_string())?;
        let live = read_controller_json(general_response, "live general config")?;
        let proxy_response = client
            .get(format!("http://127.0.0.1:{port}/proxies"))
            .bearer_auth(&secret)
            .send()
            .and_then(reqwest::blocking::Response::error_for_status)
            .map_err(|error| error.without_url().to_string())?;
        let proxies = read_controller_json(proxy_response, "live proxy snapshot")?;
        let mut candidate = dns_candidate(&source, &live, enabled, requested_dns.as_ref())?;
        let selections = preserve_selector_choices(&mut candidate, &proxies)?;
        let payload = serde_yaml::to_string(&candidate).map_err(|error| error.to_string())?;
        crate::speed_test::validate_diagnostic_ports(&payload)?;
        if !same_core() {
            return Err("Core changed during DNS update".to_owned());
        }
        let mut route = crate::speed_test::injected_route(&candidate);
        // DNS is an overlay. Preserve its pre-overlay base for disable/reapply;
        // a save-only disk candidate must never become this reload's source.
        route.confirmed_config = Some(source);
        let sent = client
            .put(format!("http://127.0.0.1:{port}/configs?force=true"))
            .bearer_auth(&secret)
            .json(&serde_json::json!({ "payload": payload }))
            .send();
        match sent {
            Ok(reload_response) if reload_response.status().is_success() => {
                if !same_core() {
                    return Err(
                        "DNS update outcome is unconfirmed; core changed during update".to_owned(),
                    );
                }
                if let Err(error) =
                    restore_selector_choices(&client, port, &secret, &selections, same_core)
                {
                    if same_core() {
                        crate::speed_test::reconcile_unknown_listener(&app, route.group_owned);
                    }
                    drop(diagnostics);
                    crate::speed_test::notify_reloaded(&app);
                    return Err(format!(
                        "DNS update outcome is unconfirmed; proxy selections could not be restored: {error}"
                    ));
                }
                if !same_core() {
                    return Err(
                        "DNS update outcome is unconfirmed; core changed during selection restore"
                            .to_owned(),
                    );
                }
                crate::speed_test::confirm_listener(&app, route);
                drop(diagnostics);
                crate::speed_test::notify_reloaded(&app);
                Ok(())
            }
            Ok(reload_response) => Err(format!(
                "Core rejected DNS update with HTTP {}",
                reload_response.status()
            )),
            Err(error) => {
                if crate::config_manager::reload_may_still_land(&error) {
                    if same_core() {
                        crate::speed_test::reconcile_unknown_listener(&app, route.group_owned);
                    }
                    drop(diagnostics);
                    crate::speed_test::notify_reloaded(&app);
                    return Err(
                        "DNS update outcome is unconfirmed; reload or restart the core, then retry"
                            .to_owned(),
                    );
                }
                Err(format!(
                    "DNS update did not reach the core: {}",
                    error.without_url()
                ))
            }
        }
    })
    .await
    .map_err(|error| format!("DNS update task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dns_preserves_nested_and_tagged_merge_routing() {
        for source in [
            "<<: [{<<: {rules: ['MATCH,DIRECT']}}, {rules: ['MATCH,REJECT']}]\n",
            "<<: !custom {rules: ['MATCH,DIRECT']}\n",
        ] {
            let original: YamlValue = serde_yaml::from_str(source).unwrap();
            for enabled in [true, false] {
                let dns = serde_json::json!({"enable": true});
                let candidate =
                    dns_candidate(source, &serde_json::json!({}), enabled, Some(&dns)).unwrap();
                assert_eq!(candidate["<<"], original["<<"]);
                assert_eq!(
                    crate::prism::host::effective_runtime_rules(&candidate).unwrap(),
                    serde_yaml::from_str::<YamlValue>("['MATCH,DIRECT']").unwrap()
                );
                assert!(candidate.get("rules").is_none());
            }
        }
    }

    #[test]
    fn dns_preserves_live_selector_choices_on_enable_and_disable() {
        let source = "profile: {store-selected: false}\n\
            proxy-groups:\n\
            - {name: manual, type: select, proxies: [a, b], default-selected: a}\n\
            - {name: provider, type: select, use: [remote]}\n\
            - {name: automatic, type: url-test, proxies: [a, b]}\n";
        let proxies = serde_json::json!({ "proxies": {
            "manual": { "type": "Selector", "now": "b" },
            "provider": { "type": "Selector", "now": "downloaded-node" },
            "automatic": { "type": "URLTest", "now": "b" },
            "GLOBAL": { "type": "Selector", "now": "manual" },
        }});
        let dns = serde_json::json!({ "enable": true });
        for enabled in [true, false] {
            let mut candidate =
                dns_candidate(source, &serde_json::json!({}), enabled, Some(&dns)).unwrap();
            assert_eq!(
                preserve_selector_choices(&mut candidate, &proxies).unwrap(),
                vec![
                    ("manual".to_owned(), "b".to_owned()),
                    ("provider".to_owned(), "downloaded-node".to_owned()),
                    ("GLOBAL".to_owned(), "manual".to_owned()),
                ]
            );
            assert_eq!(
                candidate["profile"]["store-selected"].as_bool(),
                Some(false)
            );
            assert_eq!(
                candidate["proxy-groups"][0]["default-selected"].as_str(),
                Some("b")
            );
            assert_eq!(
                candidate["proxy-groups"][1]["default-selected"].as_str(),
                Some("downloaded-node")
            );
            assert!(candidate["proxy-groups"][2]
                .get("default-selected")
                .is_none());
        }
        let baseline: YamlValue = serde_yaml::from_str(source).unwrap();
        assert_eq!(
            baseline["proxy-groups"][0]["default-selected"].as_str(),
            Some("a")
        );
    }

    #[test]
    fn dns_restores_only_selectors_reset_by_the_core() {
        let selections = vec![
            ("manual".to_owned(), "b".to_owned()),
            ("unchanged".to_owned(), "a".to_owned()),
            ("GLOBAL".to_owned(), "manual".to_owned()),
        ];
        let old_core = serde_json::json!({ "proxies": {
            "manual": { "type": "Selector", "now": "a" },
            "unchanged": { "type": "Selector", "now": "a" },
            "GLOBAL": { "type": "Selector", "now": "DIRECT" },
        }});
        assert_eq!(
            changed_selector_choices(&selections, &old_core).unwrap(),
            vec![("manual", "b"), ("GLOBAL", "manual")]
        );
        let missing = serde_json::json!({ "proxies": {} });
        assert!(changed_selector_choices(&selections, &missing).is_err());
    }

    #[test]
    fn background_dns_retries_only_failures_before_any_write() {
        assert!(retryable_dns_contention(
            "Subscription fallback is active; retry the runtime update"
        ));
        assert!(retryable_dns_contention(
            crate::config_manager::RUN_CONFIG_BUSY
        ));
        assert!(!retryable_dns_contention(
            "DNS update outcome is unconfirmed; reload or restart the core, then retry"
        ));
        assert!(!retryable_dns_contention(
            "Core rejected DNS update with HTTP 400"
        ));
    }

    #[test]
    fn dns_selection_snapshot_requires_the_live_groups() {
        let mut candidate: YamlValue =
            serde_yaml::from_str("proxy-groups: [{name: manual, type: select, proxies: [DIRECT]}]")
                .unwrap();
        for proxies in [
            serde_json::json!({}),
            serde_json::json!({ "proxies": {} }),
            serde_json::json!({ "proxies": {
                "manual": { "type": "Selector", "now": "" },
                "GLOBAL": { "type": "Selector", "now": "DIRECT" },
            }}),
        ] {
            assert!(preserve_selector_choices(&mut candidate, &proxies).is_err());
        }
    }

    #[test]
    fn proxy_selection_url_keeps_the_group_in_one_path_segment() {
        let target = proxy_group_url(9090, "group/with ?#雪").unwrap();
        assert_eq!(
            target.as_str(),
            "http://127.0.0.1:9090/proxies/group%2Fwith%20%3F%23%E9%9B%AA"
        );
        assert!(target.query().is_none());
        assert!(target.fragment().is_none());
    }

    #[test]
    fn saved_dns_defaults_match_the_frontend_payload_source() {
        fn quoted_list(source: &str, marker: &str) -> Vec<String> {
            source
                .split_once(marker)
                .unwrap()
                .1
                .split_once('[')
                .unwrap()
                .1
                .split_once(']')
                .unwrap()
                .0
                .lines()
                .filter_map(|line| line.trim().strip_prefix('\''))
                .map(|line| line.split_once('\'').unwrap().0.to_owned())
                .collect()
        }
        let frontend = include_str!("../../src/ui/dns-shared.js");
        let defaults = frontend
            .split_once("export const DEFAULT_DNS_CONFIG")
            .unwrap()
            .1;
        let payload = saved_dns_payload(None, None);
        for (field, source, marker) in [
            ("nameserver", defaults, "nameserver:"),
            ("fallback", defaults, "fallback:"),
            (
                "default-nameserver",
                frontend,
                "const BOOTSTRAP_DNS_SERVERS",
            ),
            ("fake-ip-filter", frontend, "'fake-ip-filter':"),
        ] {
            assert_eq!(
                payload[field],
                serde_json::json!(quoted_list(source, marker))
            );
        }
        assert!(frontend.contains("listen: '0.0.0.0:1053'"));
        assert!(frontend.contains("'enhanced-mode': 'fake-ip'"));
        assert!(frontend.contains("const FAKE_IP_RANGE = '198.18.0.0/16'"));
        let custom = vec!["https://resolver.example/dns-query".to_owned()];
        let custom_payload = saved_dns_payload(Some(&custom), Some(&[]));
        assert_eq!(custom_payload["nameserver"], serde_json::json!(custom));
        assert_eq!(custom_payload["fallback"], serde_json::json!([]));
    }

    #[test]
    fn dns_uses_confirmed_config_after_an_unapplied_disk_save() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("run_config.yaml");
        let confirmed = "rules: ['MATCH,DIRECT']\ndns: {enable: true}\n";
        let mut core = crate::core_manager::core::CoreData::new();
        core.set_last_port(Some(9090));
        core.set_confirmed_runtime_config(Some(confirmed.to_owned()));
        std::fs::write(&path, "rules: ['MATCH,RejectedCandidate']\n").unwrap();
        let dns = serde_json::json!({ "enable": true, "nameserver": ["192.0.2.1"] });
        let candidate = dns_candidate(
            core.confirmed_runtime_config().unwrap(),
            &serde_json::json!({ "mode": "rule" }),
            true,
            Some(&dns),
        )
        .unwrap();
        assert_eq!(candidate["rules"][0].as_str(), Some("MATCH,DIRECT"));
        assert!(std::fs::read_to_string(&path)
            .unwrap()
            .contains("RejectedCandidate"));
        core.set_last_port(None);
        assert!(core.confirmed_runtime_config().is_none());
    }

    #[test]
    fn dns_overlay_keeps_live_general_fields_and_preserves_the_source() {
        let source =
            "mode: rule\nmixed-port: 7890\nunified-delay: false\ntun: {enable: false, stack: mixed}\nsecret: private\n\
            authentication: ['user:private-password']\n\
            dns: {enable: true, nameserver: [192.0.2.1]}\n\
            sniffer: {enable: false, force-dns-mapping: true}\nrules: [MATCH,DIRECT]\n";
        let live = serde_json::json!({
            "mode": "global", "mixed-port": 7891, "unified-delay": true,
            "tun": { "enable": true, "stack": "system", "dns-hijack": ["any:53"] },
            "secret": "must-not-copy", "rules": [],
            "authentication": ["user"],
        });
        let dns = serde_json::json!({ "enable": true, "nameserver": ["198.51.100.1"] });
        let enabled = dns_candidate(source, &live, true, Some(&dns)).unwrap();
        assert_eq!(enabled["mode"].as_str(), Some("global"));
        assert_eq!(enabled["mixed-port"].as_u64(), Some(7891));
        assert_eq!(enabled["unified-delay"].as_bool(), Some(true));
        assert_eq!(enabled["tun"]["enable"].as_bool(), Some(true));
        assert_eq!(enabled["tun"]["stack"].as_str(), Some("system"));
        assert_eq!(enabled["tun"]["dns-hijack"][0].as_str(), Some("any:53"));
        assert_eq!(enabled["secret"].as_str(), Some("private"));
        assert_eq!(
            enabled["authentication"][0].as_str(),
            Some("user:private-password")
        );
        assert_eq!(
            enabled["dns"]["nameserver"][0].as_str(),
            Some("198.51.100.1")
        );
        assert_eq!(enabled["sniffer"]["enable"].as_bool(), Some(true));
        assert_eq!(
            enabled["sniffer"]["force-dns-mapping"].as_bool(),
            Some(true)
        );
        let disabled = dns_candidate(source, &live, false, None).unwrap();
        assert_eq!(disabled["unified-delay"].as_bool(), Some(true));
        let no_live_value = dns_candidate(source, &serde_json::json!({}), false, None).unwrap();
        assert_eq!(no_live_value["unified-delay"].as_bool(), Some(false));
        assert_eq!(disabled["dns"]["nameserver"][0].as_str(), Some("192.0.2.1"));
        assert_eq!(disabled["sniffer"]["enable"].as_bool(), Some(false));
        assert_eq!(disabled["authentication"], enabled["authentication"]);
        assert_eq!(disabled["rules"], enabled["rules"]);
        let unauthenticated = dns_candidate("rules: []\n", &live, false, None).unwrap();
        assert!(unauthenticated.get("authentication").is_none());
    }
}

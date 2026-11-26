//! Apply the DNS preference as a runtime overlay without changing profile files.

use std::time::Duration;

use serde_json::Value as JsonValue;
use serde_yaml::Value as YamlValue;
use tauri::Manager as _;
use zephyr_core::config::sanitizer::remove_keys_resolved;

fn dns_candidate(
    source: &str,
    live: &JsonValue,
    enabled: bool,
    dns: Option<&JsonValue>,
) -> Result<YamlValue, String> {
    let mut candidate: YamlValue =
        serde_yaml::from_str(source).map_err(|error| format!("Invalid runtime config: {error}"))?;
    candidate
        .apply_merge()
        .map_err(|error| format!("Invalid runtime config merge: {error}"))?;
    let map = candidate
        .as_mapping_mut()
        .ok_or("Runtime config must be a mapping")?;
    if !live.is_object() {
        return Err("Core returned an invalid general config".to_owned());
    }
    // GET /configs is only the general section. Preserve its mutable fields,
    // while rules, providers, credentials and DNS come from the confirmed base.
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
        "authentication",
        "skip-auth-prefixes",
        "lan-allowed-ips",
        "lan-disallowed-ips",
        "allow-lan",
        "bind-address",
        "mode",
        "log-level",
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
pub async fn apply_runtime_dns(
    app: tauri::AppHandle,
    enabled: bool,
    dns: Option<JsonValue>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        use std::io::Read as _;
        let _config = crate::config_manager::lock_run_config_within(Duration::from_secs(5))?;
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
        let generation = crate::speed_test::speed_test_generation();
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
        let limit = crate::core_manager::core::MAX_RESPONSE_SIZE;
        let mut bytes = Vec::new();
        general_response
            .take(u64::try_from(limit + 1).unwrap_or(u64::MAX))
            .read_to_end(&mut bytes)
            .map_err(|error| format!("Failed to read live general config: {error}"))?;
        if bytes.len() > limit {
            return Err("Live general config exceeds the size limit".to_owned());
        }
        let live = serde_json::from_slice(&bytes)
            .map_err(|error| format!("Invalid live general config: {error}"))?;
        let candidate = dns_candidate(&source, &live, enabled, dns.as_ref())?;
        let payload = serde_yaml::to_string(&candidate).map_err(|error| error.to_string())?;
        crate::speed_test::validate_diagnostic_ports(&payload)?;
        if !same_core() || crate::speed_test::speed_test_generation() != generation {
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
                    return Err("Core changed during DNS update".to_owned());
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
                        "DNS update outcome is unconfirmed; retry after the core recovers"
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
            "mode: rule\nmixed-port: 7890\ntun: {enable: false, stack: mixed}\nsecret: private\n\
            dns: {enable: true, nameserver: [192.0.2.1]}\n\
            sniffer: {enable: false, force-dns-mapping: true}\nrules: [MATCH,DIRECT]\n";
        let live = serde_json::json!({
            "mode": "global", "mixed-port": 7891,
            "tun": { "enable": true, "stack": "system", "dns-hijack": ["any:53"] },
            "secret": "must-not-copy", "rules": [],
        });
        let dns = serde_json::json!({ "enable": true, "nameserver": ["198.51.100.1"] });
        let enabled = dns_candidate(source, &live, true, Some(&dns)).unwrap();
        assert_eq!(enabled["mode"].as_str(), Some("global"));
        assert_eq!(enabled["mixed-port"].as_u64(), Some(7891));
        assert_eq!(enabled["tun"]["enable"].as_bool(), Some(true));
        assert_eq!(enabled["tun"]["stack"].as_str(), Some("system"));
        assert_eq!(enabled["tun"]["dns-hijack"][0].as_str(), Some("any:53"));
        assert_eq!(enabled["secret"].as_str(), Some("private"));
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
        assert_eq!(disabled["dns"]["nameserver"][0].as_str(), Some("192.0.2.1"));
        assert_eq!(disabled["sniffer"]["enable"].as_bool(), Some(false));
        assert_eq!(disabled["rules"], enabled["rules"]);
    }
}

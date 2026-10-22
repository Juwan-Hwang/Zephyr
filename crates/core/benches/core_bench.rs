//! Benchmarks for the platform-agnostic `zephyr-core` hot paths.
//!
//! Run locally with `cargo bench -p zephyr-core`, or with `CodSpeed` via
//! `cargo codspeed build -p zephyr-core && cargo codspeed run -p zephyr-core`.
//!
//! Fixture setup failures must abort the run loudly (a benchmark that
//! silently measures nothing is worse than a red run), hence `expect` here,
//! mirroring the allows used on the workspace's test modules.
#![allow(clippy::expect_used)]

use std::fmt::Write as _;
use std::net::IpAddr;

use divan::{black_box, Bencher};
use serde_yaml as yaml;
use zephyr_core::config::fetch_util::validate_url_basic;
use zephyr_core::config::merge::{
    extract_security_settings, restore_security_settings, strip_secret_from_yaml,
};
use zephyr_core::config::prism_types::{count_rules, detect_source, normalize_to_prism_yaml};
use zephyr_core::config::proxy_validation::{parse_host_port, validate_proxy_server};
use zephyr_core::config::sanitizer::{remove_control_plane_keys, remove_dangerous_keys};
use zephyr_core::config::subscription::{
    extract_name_from_rules, is_private_host, percent_decode, FakeIpRanges,
};
use zephyr_core::config::tun::{
    extract_mode_from_yaml, extract_secret_from_yaml, extract_tun_enabled_from_yaml, inject_tun_fd,
    set_secret_in_yaml, update_tun_in_yaml,
};
use zephyr_core::config::{
    merge_yaml, quote_short_id_values, redact_url_in_string, try_decode_base64_content,
    url_decode_complete, validate_subscription_url_basic,
};
use zephyr_core::crypto::{deobfuscate_string, obfuscate_string};
use zephyr_core::smart_selector::{
    compute_smart_rank, compute_smart_score, SmartDecayConfig, SmartScoreWeights,
};

fn main() {
    divan::main();
}

const SIZES: &[usize] = &[10, 100, 1000];

/// Build a realistic mihomo/Clash subscription config with `proxies` nodes.
fn clash_config(proxies: usize) -> String {
    let mut out = String::with_capacity(proxies * 160 + 1024);
    out.push_str(
        "mixed-port: 7890\nallow-lan: false\nmode: rule\nlog-level: info\n\
         external-controller: 127.0.0.1:9090\nsecret: s3cr3t\n\
         external-ui: ./ui\nscript: ./patch.js\n\
         dns:\n  enable: true\n  enhanced-mode: fake-ip\n  fake-ip-range: 198.18.0.1/16\n\
         \x20\x20nameserver:\n    - https://1.1.1.1/dns-query\n\
         tun:\n  enable: false\n  stack: mixed\n\
         proxies:\n",
    );
    for i in 0..proxies {
        let _ = writeln!(
            out,
            "  - name: node-{i}\n    type: vless\n    server: s{i}.example.com\n    port: 443\n    \
             uuid: 00000000-0000-0000-0000-{i:012}\n    tls: true\n    reality-opts:\n      \
             public-key: abcdef\n      short-id: 34010e{i:02}"
        );
    }
    // A provider carrying a `path`: the sanitizer must strip that `path`
    // (and the `external-ui` / `script` keys in the header above), so the
    // sanitizer benchmarks exercise the removal paths, not just traversal.
    out.push_str(
        "proxy-providers:\n  provider-1:\n    type: http\n    \
         url: https://example.com/provider.yaml\n    path: ./providers/provider-1.yaml\n",
    );
    out.push_str("proxy-groups:\n  - name: Proxy\n    type: select\n    proxies:\n");
    for i in 0..proxies {
        let _ = writeln!(out, "      - node-{i}");
    }
    out.push_str("rules:\n");
    for i in 0..proxies {
        let _ = writeln!(out, "  - DOMAIN-SUFFIX,site{i}.example.com,Proxy");
    }
    out.push_str("  - MATCH,DIRECT\n");
    out
}

#[divan::bench(args = SIZES)]
fn sanitize_remove_dangerous_keys(bencher: Bencher, proxies: usize) {
    let config = clash_config(proxies);
    // Clone in the input generator so the timed region is the sanitizer only.
    bencher
        .with_inputs(|| config.clone())
        .bench_values(remove_dangerous_keys);
}

#[divan::bench(args = SIZES)]
fn quote_short_ids(bencher: Bencher, proxies: usize) {
    let config = clash_config(proxies);
    // Initialise the lazily compiled regex outside of the measurement.
    let _ = quote_short_id_values("short-id: 0");
    bencher.bench(|| quote_short_id_values(black_box(&config)));
}

#[divan::bench(args = SIZES)]
fn decode_base64_subscription(bencher: Bencher, proxies: usize) {
    use base64::Engine as _;
    let encoded = base64::engine::general_purpose::STANDARD.encode(clash_config(proxies));
    bencher.bench(|| try_decode_base64_content(black_box(&encoded)));
}

#[divan::bench]
fn merge_yaml_patch(bencher: Bencher) {
    let base: yaml::Value =
        yaml::from_str(&clash_config(100)).expect("clash_config fixture must parse as YAML");
    let patch: yaml::Value = yaml::from_str(
        "mixed-port: 7891\nmode: global\ndns:\n  enable: false\n  ipv6: true\ntun:\n  enable: true\n",
    )
    .expect("merge patch fixture must parse as YAML");
    bencher
        .with_inputs(|| base.clone())
        .bench_local_refs(|b| merge_yaml(b, black_box(&patch), 0));
}

#[divan::bench(args = SIZES)]
fn tun_update(bencher: Bencher, proxies: usize) {
    let config = clash_config(proxies);
    bencher.bench(|| update_tun_in_yaml(black_box(&config), true));
}

#[divan::bench(args = SIZES)]
fn tun_extract_enabled(bencher: Bencher, proxies: usize) {
    let config = clash_config(proxies);
    bencher.bench(|| extract_tun_enabled_from_yaml(black_box(&config)));
}

#[divan::bench]
fn url_decode(bencher: Bencher) {
    let input = "%252e%252e%252F..%2F%2e%2e%5cetc%2Fpasswd%20config%2Eyaml";
    bencher.bench(|| url_decode_complete(black_box(input)));
}

#[divan::bench]
fn validate_subscription_url(bencher: Bencher) {
    let url = "https://sub.example.com:8443/api/v1/client/subscribe?token=abcdef0123456789";
    bencher.bench(|| validate_subscription_url_basic(black_box(url)));
}

#[divan::bench]
fn redact_url(bencher: Bencher) {
    let msg = "request to https://user:pass@sub.example.com/link?token=abcdef failed: \
               error sending request for url (https://sub.example.com/link?token=abcdef)"
        .to_owned();
    bencher
        .with_inputs(|| msg.clone())
        .bench_values(redact_url_in_string);
}

const KEY: [u8; 32] = [7; 32];

#[divan::bench(args = [64, 4096])]
fn crypto_encrypt(bencher: Bencher, len: usize) {
    let plaintext = "x".repeat(len);
    bencher.bench(|| obfuscate_string(black_box(&KEY), black_box(&plaintext)));
}

#[divan::bench(args = [64, 4096])]
fn crypto_decrypt(bencher: Bencher, len: usize) {
    let ciphertext =
        obfuscate_string(&KEY, &"x".repeat(len)).expect("benchmark encryption setup must succeed");
    bencher.bench(|| deobfuscate_string(black_box(&KEY), black_box(&ciphertext)));
}

fn latency_history(seed: usize, len: usize) -> (Vec<f64>, Vec<bool>) {
    let latencies = (0..len)
        .map(|i| f64::from(u32::try_from((seed * 31 + i * 17) % 400).unwrap_or(0)) + 20.0)
        .collect();
    let successes = (0..len).map(|i| !(seed + i).is_multiple_of(11)).collect();
    (latencies, successes)
}

#[divan::bench(args = [10, 100, 1000])]
fn smart_score(bencher: Bencher, records: usize) {
    let (latencies, successes) = latency_history(1, records);
    // The scorer consumes its inputs; clone them in the input generator so
    // the timed region is the scoring itself, not Vec allocation and copying.
    bencher
        .with_inputs(|| (latencies.clone(), successes.clone()))
        .bench_values(|(lat, suc)| {
            compute_smart_score(
                SmartScoreWeights::default(),
                SmartDecayConfig::default(),
                lat,
                suc,
            )
        });
}

#[divan::bench(args = [10, 100])]
fn smart_rank(bencher: Bencher, nodes: usize) {
    let names: Vec<String> = (0..nodes).map(|i| format!("node-{i}")).collect();
    let (latencies, successes): (Vec<Vec<f64>>, Vec<Vec<bool>>) =
        (0..nodes).map(|i| latency_history(i, 50)).unzip();
    bencher
        .with_inputs(|| (names.clone(), latencies.clone(), successes.clone()))
        .bench_values(|(node_names, node_lat, node_suc)| {
            compute_smart_rank(
                SmartScoreWeights::default(),
                SmartDecayConfig::default(),
                node_names,
                node_lat,
                node_suc,
            )
        });
}

// ---------------------------------------------------------------------------
// Value-level config operations on the parsed YAML (every config load/save).
// ---------------------------------------------------------------------------

#[divan::bench(args = SIZES)]
fn parse_config_yaml(bencher: Bencher, proxies: usize) {
    let config = clash_config(proxies);
    bencher.bench(|| yaml::from_str::<yaml::Value>(black_box(&config)));
}

#[divan::bench(args = SIZES)]
fn sanitize_remove_control_plane_keys(bencher: Bencher, proxies: usize) {
    let value: yaml::Value =
        yaml::from_str(&clash_config(proxies)).expect("clash_config fixture must parse as YAML");
    bencher
        .with_inputs(|| value.clone())
        .bench_local_refs(remove_control_plane_keys);
}

#[divan::bench(args = SIZES)]
fn merge_extract_security_settings(bencher: Bencher, proxies: usize) {
    let value: yaml::Value =
        yaml::from_str(&clash_config(proxies)).expect("clash_config fixture must parse as YAML");
    bencher.bench(|| extract_security_settings(black_box(&value)));
}

#[divan::bench(args = SIZES)]
fn merge_restore_security_settings(bencher: Bencher, proxies: usize) {
    let value: yaml::Value =
        yaml::from_str(&clash_config(proxies)).expect("clash_config fixture must parse as YAML");
    let settings = extract_security_settings(&value);
    bencher
        .with_inputs(|| value.clone())
        .bench_local_refs(|v| restore_security_settings(v, &settings));
}

#[divan::bench(args = SIZES)]
fn merge_strip_secret(bencher: Bencher, proxies: usize) {
    let value: yaml::Value =
        yaml::from_str(&clash_config(proxies)).expect("clash_config fixture must parse as YAML");
    bencher
        .with_inputs(|| value.clone())
        .bench_local_refs(strip_secret_from_yaml);
}

// ---------------------------------------------------------------------------
// Remaining whole-config YAML extractions and rewrites (TUN family).
// ---------------------------------------------------------------------------

#[divan::bench(args = SIZES)]
fn tun_extract_mode(bencher: Bencher, proxies: usize) {
    let config = clash_config(proxies);
    bencher.bench(|| extract_mode_from_yaml(black_box(&config)));
}

#[divan::bench(args = SIZES)]
fn tun_extract_secret(bencher: Bencher, proxies: usize) {
    let config = clash_config(proxies);
    bencher.bench(|| extract_secret_from_yaml(black_box(&config)));
}

#[divan::bench(args = SIZES)]
fn tun_set_secret(bencher: Bencher, proxies: usize) {
    let config = clash_config(proxies);
    bencher.bench(|| set_secret_in_yaml(black_box(&config), "n3w-s3cret"));
}

#[divan::bench(args = SIZES)]
fn tun_inject_fd(bencher: Bencher, proxies: usize) {
    let config = clash_config(proxies);
    bencher.bench(|| inject_tun_fd(black_box(&config), 42));
}

// ---------------------------------------------------------------------------
// Subscription helpers: name extraction, percent decoding, SSRF host checks,
// fake-IP range matching and global-candidate resolution.
// ---------------------------------------------------------------------------

#[divan::bench(args = SIZES)]
fn subscription_extract_name_from_rules(bencher: Bencher, proxies: usize) {
    let config = clash_config(proxies);
    bencher.bench(|| extract_name_from_rules(black_box(&config)));
}

#[divan::bench(args = [1_000, 100_000])]
fn subscription_percent_decode(bencher: Bencher, chars: usize) {
    let unit = "%E4%B8%AD%E6%96%87%20node-";
    let input = unit.repeat(chars / unit.len() + 1);
    bencher.bench(|| percent_decode(black_box(&input)));
}

#[divan::bench]
fn subscription_fake_ip_contains(bencher: Bencher) {
    let ranges = FakeIpRanges::from_config_yaml(&clash_config(10));
    let ips: Vec<IpAddr> = (0..1000)
        .map(|i| {
            let hi = u8::try_from(i / 256).unwrap_or(0);
            let lo = u8::try_from(i % 256).unwrap_or(0);
            if i % 3 == 0 {
                IpAddr::from([198, 18, hi, lo])
            } else {
                IpAddr::from([8, 8, lo, hi])
            }
        })
        .collect();
    bencher.bench(|| {
        let mut hits = 0u32;
        for ip in black_box(&ips) {
            hits += u32::from(ranges.contains(*ip));
        }
        hits
    });
}

#[divan::bench]
fn subscription_is_private_host_batch(bencher: Bencher) {
    let hosts: Vec<String> = (0..1000)
        .map(|i| match i % 4 {
            0 => format!("node-{i}.example.com"),
            1 => format!("192.168.1.{}", i % 256),
            2 => format!("nas-{i}.local"),
            _ => format!("10.0.{}.{}", i / 256, i % 256),
        })
        .collect();
    bencher.bench(|| {
        let mut hits = 0u32;
        for host in black_box(&hosts) {
            hits += u32::from(is_private_host(host));
        }
        hits
    });
}

#[divan::bench(args = [100, 1000])]
fn subscription_select_global_candidate(bencher: Bencher, nodes: usize) {
    let mut proxies = serde_json::Map::new();
    let all: Vec<serde_json::Value> = (0..nodes)
        .map(|i| serde_json::Value::String(format!("node-{i}")))
        .collect();
    let mut global = serde_json::Map::new();
    global.insert("all".to_owned(), serde_json::Value::Array(all));
    global.insert(
        "now".to_owned(),
        serde_json::Value::String("node-0".to_owned()),
    );
    proxies.insert("GLOBAL".to_owned(), serde_json::Value::Object(global));
    for i in 0..nodes {
        let mut node = serde_json::Map::new();
        node.insert(
            "type".to_owned(),
            serde_json::Value::String("Shadowsocks".to_owned()),
        );
        proxies.insert(format!("node-{i}"), serde_json::Value::Object(node));
    }
    bencher
        .bench(|| zephyr_core::config::subscription::select_global_candidate(black_box(&proxies)));
}

#[divan::bench]
fn fetch_validate_url_basic(bencher: Bencher) {
    let url = "https://sub.example.com:8443/api/v1/client/subscribe?token=abcdef0123456789";
    bencher.bench(|| validate_url_basic(black_box(url.to_owned())));
}

// ---------------------------------------------------------------------------
// Prism rule pipeline: counting, source detection and normalization over
// whole rule files.
// ---------------------------------------------------------------------------

const RULE_SIZES: &[usize] = &[100, 1_000, 10_000];

fn prism_rules(lines: usize) -> String {
    let mut out = String::with_capacity(lines * 40);
    out.push_str("rules:\n");
    for i in 0..lines {
        let _ = writeln!(out, "  - DOMAIN-SUFFIX,site{i}.example.com,Proxy");
    }
    out
}

fn raw_rules(lines: usize) -> String {
    let mut out = String::with_capacity(lines * 38);
    for i in 0..lines {
        let _ = writeln!(out, "DOMAIN-SUFFIX,site{i}.example.com,Proxy");
    }
    out
}

#[divan::bench(args = RULE_SIZES)]
fn prism_count_rules(bencher: Bencher, lines: usize) {
    let content = prism_rules(lines);
    bencher.bench(|| count_rules(black_box(&content)));
}

#[divan::bench(args = RULE_SIZES)]
fn prism_detect_source(bencher: Bencher, lines: usize) {
    let content = raw_rules(lines);
    bencher.bench(|| detect_source(black_box(&content)));
}

#[divan::bench(args = RULE_SIZES)]
fn prism_normalize(bencher: Bencher, lines: usize) {
    let content = raw_rules(lines);
    bencher.bench(|| normalize_to_prism_yaml(black_box(&content)));
}

// ---------------------------------------------------------------------------
// Per-proxy validation, as run over every node of an imported subscription.
// ---------------------------------------------------------------------------

fn validate_batch(servers: &[String]) -> u32 {
    let mut ok = 0u32;
    for server in servers {
        ok += u32::from(validate_proxy_server(server).is_ok());
        ok += u32::from(parse_host_port(server).is_ok());
    }
    ok
}

#[divan::bench(args = [100, 1000])]
fn proxy_validate_batch(bencher: Bencher, nodes: usize) {
    // `validate_proxy_server` guards the system-proxy setting and only
    // accepts loopback targets, so the accepted-path inputs are loopback
    // forms: IPv4, `localhost` and IPv6.
    let servers: Vec<String> = (0..nodes)
        .map(|i| match i % 3 {
            0 => format!("127.0.0.1:{}", 8080 + (i % 64)),
            1 => format!("localhost:{}", 7890 + (i % 64)),
            _ => format!("[::1]:{}", 9090 + (i % 64)),
        })
        .collect();
    bencher.bench(|| validate_batch(black_box(&servers)));
}

#[divan::bench(args = [100, 1000])]
fn proxy_validate_batch_rejected(bencher: Bencher, nodes: usize) {
    // Rejection path of the same guard: public hostnames must be refused.
    let servers: Vec<String> = (0..nodes)
        .map(|i| format!("s{i}.example.com:443"))
        .collect();
    bencher.bench(|| validate_batch(black_box(&servers)));
}

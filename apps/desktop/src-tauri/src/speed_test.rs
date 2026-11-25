//! Download speed test and exit-IP lookup.
//!
//! mihomo's REST API can only measure a node's delay, so a download through one
//! chosen node needs its own way in. Every runtime config gets a hidden select
//! group, [`SPEED_TEST_GROUP`], that holds all the profile's nodes, and a mixed
//! listener on loopback bound to that group. The frontend points the group at
//! the node under test (`PUT /proxies/ZEPHYR-SPEED-TEST`) and the download below
//! goes through the listener, so it never touches the user's own selection and
//! no rule can send it DIRECT.

use std::sync::atomic::{AtomicU16, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use futures_util::StreamExt as _;
use serde::Serialize;
use tauri::Emitter as _;

/// Name of the hidden group the speed-test listener routes through.
pub const SPEED_TEST_GROUP: &str = "ZEPHYR-SPEED-TEST";
/// Name of the injected listener.
pub const SPEED_TEST_LISTENER: &str = "zephyr-speed-test";
/// Event that carries live progress.
pub const PROGRESS_EVENT: &str = "speed-test-progress";

/// Port of the listener in the config that is running now; 0 when none.
static ACTIVE_PORT: AtomicU16 = AtomicU16::new(0);
/// Bumped by [`speed_test_cancel`]; a download stops when it changes.
static CANCEL_GEN: AtomicU64 = AtomicU64::new(0);

const MAX_SECS: u64 = 60;
const MAX_BYTES_CAP: u64 = 1 << 30;

fn key(s: &str) -> serde_yaml::Value {
    serde_yaml::Value::String(s.to_owned())
}

/// A free loopback port, chosen once per app run so a core restart keeps it.
fn listener_port() -> Option<u16> {
    static PORT: std::sync::OnceLock<Option<u16>> = std::sync::OnceLock::new();
    *PORT.get_or_init(|| {
        std::net::TcpListener::bind(("127.0.0.1", 0))
            .and_then(|l| l.local_addr())
            .map(|a| a.port())
            .ok()
    })
}

fn names_in(seq: Option<&serde_yaml::Value>) -> Vec<String> {
    seq.and_then(serde_yaml::Value::as_sequence)
        .map(|items| {
            items
                .iter()
                .filter_map(|v| v.get("name").and_then(serde_yaml::Value::as_str))
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// Add the hidden group and the loopback listener to a runtime config.
///
/// Leaves the config alone, and returns `None`, when the profile already uses
/// either name or when `proxy-groups` / `listeners` is not a list: the user's
/// own config always wins over the speed test.
pub fn inject(yaml: &mut serde_yaml::Value, port: u16) -> Option<u16> {
    let map = yaml.as_mapping_mut()?;
    let groups_key = key("proxy-groups");
    let listeners_key = key("listeners");
    for k in [&groups_key, &listeners_key] {
        if let Some(v) = map.get(k) {
            if !v.is_sequence() && !v.is_null() {
                return None;
            }
        }
    }
    let mut taken = names_in(map.get(&groups_key));
    taken.extend(names_in(map.get(key("proxies"))));
    if taken.iter().any(|n| n == SPEED_TEST_GROUP) {
        return None;
    }
    if names_in(map.get(&listeners_key))
        .iter()
        .any(|n| n == SPEED_TEST_LISTENER)
    {
        return None;
    }

    let mut group = serde_yaml::Mapping::new();
    group.insert(key("name"), key(SPEED_TEST_GROUP));
    group.insert(key("type"), key("select"));
    // Every node, provider nodes included; never another group.
    group.insert(key("include-all"), serde_yaml::Value::Bool(true));
    // DIRECT keeps the group valid for a profile with no nodes.
    group.insert(
        key("proxies"),
        serde_yaml::Value::Sequence(vec![key("DIRECT")]),
    );
    group.insert(key("hidden"), serde_yaml::Value::Bool(true));

    let mut listener = serde_yaml::Mapping::new();
    listener.insert(key("name"), key(SPEED_TEST_LISTENER));
    listener.insert(key("type"), key("mixed"));
    listener.insert(key("listen"), key("127.0.0.1"));
    listener.insert(key("port"), serde_yaml::Value::Number(port.into()));
    listener.insert(key("proxy"), key(SPEED_TEST_GROUP));
    listener.insert(key("udp"), serde_yaml::Value::Bool(false));

    for (k, item) in [
        (groups_key, serde_yaml::Value::Mapping(group)),
        (listeners_key, serde_yaml::Value::Mapping(listener)),
    ] {
        match map.get_mut(&k) {
            Some(serde_yaml::Value::Sequence(seq)) => seq.push(item),
            _ => {
                map.insert(k, serde_yaml::Value::Sequence(vec![item]));
            }
        }
    }
    Some(port)
}

/// [`inject`] with this run's port; records the port the speed test should use.
pub fn inject_for_runtime(yaml: &mut serde_yaml::Value) {
    let port = listener_port().and_then(|p| inject(yaml, p));
    ACTIVE_PORT.store(port.unwrap_or(0), Ordering::SeqCst);
}

/// Port of the speed-test listener, or `None` when the running config has none.
#[tauri::command]
#[must_use]
pub fn speed_test_port() -> Option<u16> {
    match ACTIVE_PORT.load(Ordering::SeqCst) {
        0 => None,
        p => Some(p),
    }
}

/// Stop every download that is running now.
#[tauri::command]
pub fn speed_test_cancel() {
    CANCEL_GEN.fetch_add(1, Ordering::SeqCst);
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SpeedResult {
    pub bytes: u64,
    pub elapsed_ms: u64,
    /// Highest speed over any one second, bytes per second.
    pub peak_bps: u64,
    pub cancelled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress<'a> {
    id: &'a str,
    bytes: u64,
    bps: u64,
}

fn checked_url(url: &str) -> Result<url::Url, String> {
    let parsed = url::Url::parse(url.trim()).map_err(|e| format!("invalid url: {e}"))?;
    match parsed.scheme() {
        "http" | "https" if parsed.host_str().is_some() => Ok(parsed),
        _ => Err("only http and https addresses are supported".to_owned()),
    }
}

/// Bytes per second, rounded down; 0 for an empty span.
fn rate(bytes: u64, span: Duration) -> u64 {
    let micros = span.as_micros();
    if micros == 0 {
        return 0;
    }
    u64::try_from(u128::from(bytes) * 1_000_000 / micros).unwrap_or(u64::MAX)
}

/// Tracks the best one-second window of a download.
#[derive(Debug, Default)]
pub struct PeakMeter {
    window: std::collections::VecDeque<(Duration, u64)>,
    total: u64,
    peak: u64,
}

impl PeakMeter {
    /// Record that `total` bytes had arrived `at` after the start.
    pub fn record(&mut self, at: Duration, total: u64) -> u64 {
        self.total = total;
        self.window.push_back((at, total));
        while let Some(&(t, _)) = self.window.front() {
            if at.saturating_sub(t) > Duration::from_secs(1) && self.window.len() > 1 {
                self.window.pop_front();
            } else {
                break;
            }
        }
        let (t0, b0) = *self.window.front().unwrap_or(&(at, total));
        let span = at.saturating_sub(t0);
        // Only a window close to a full second is a fair speed; a burst in the
        // first few milliseconds would read as an absurd peak.
        if span >= Duration::from_millis(900) {
            let bps = rate(total.saturating_sub(b0), span);
            self.peak = self.peak.max(bps);
            return bps;
        }
        0
    }

    /// Best one-second speed, or the average when the download was too short
    /// to fill a second.
    #[must_use]
    pub fn peak(&self, elapsed: Duration) -> u64 {
        if self.peak > 0 {
            self.peak
        } else {
            rate(self.total, elapsed)
        }
    }
}

/// Download `url` through the speed-test listener for up to `max_secs` or
/// `max_bytes`, sending `speed-test-progress` events tagged with `id`.
#[tauri::command]
pub async fn speed_test_download(
    app: tauri::AppHandle,
    url: String,
    max_secs: u64,
    max_bytes: Option<u64>,
    id: String,
) -> Result<SpeedResult, String> {
    let target = checked_url(&url)?;
    let port = speed_test_port().ok_or("speed test is not available for this profile")?;
    let secs = max_secs.clamp(1, MAX_SECS);
    let byte_cap = max_bytes.unwrap_or(MAX_BYTES_CAP).min(MAX_BYTES_CAP);
    let gen = CANCEL_GEN.load(Ordering::SeqCst);

    let proxy =
        reqwest::Proxy::all(format!("http://127.0.0.1:{port}")).map_err(|e| e.to_string())?;
    let client = reqwest::Client::builder()
        .proxy(proxy)
        .connect_timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;
    let deadline = Duration::from_secs(secs);
    let start = Instant::now();
    let resp = tokio::time::timeout(deadline, client.get(target).send())
        .await
        .map_err(|elapsed| format!("timed out: {elapsed}"))?
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }
    let mut stream = resp.bytes_stream();
    let mut meter = PeakMeter::default();
    let mut bytes = 0u64;
    let mut last_emit = Duration::ZERO;
    let mut cancelled = false;
    loop {
        let left = deadline.saturating_sub(start.elapsed());
        if left.is_zero() || bytes >= byte_cap {
            break;
        }
        if CANCEL_GEN.load(Ordering::SeqCst) != gen {
            cancelled = true;
            break;
        }
        let next = tokio::time::timeout(left.min(Duration::from_millis(500)), stream.next()).await;
        match next {
            Err(_) => {}
            Ok(None) => break,
            Ok(Some(Err(e))) => {
                if bytes == 0 {
                    return Err(e.to_string());
                }
                break;
            }
            Ok(Some(Ok(chunk))) => bytes += chunk.len() as u64,
        }
        let at = start.elapsed();
        let bps = meter.record(at, bytes);
        if at.saturating_sub(last_emit) >= Duration::from_millis(500) {
            last_emit = at;
            let _ = app.emit(
                PROGRESS_EVENT,
                Progress {
                    id: &id,
                    bytes,
                    bps,
                },
            );
        }
    }
    let elapsed = start.elapsed();
    Ok(SpeedResult {
        bytes,
        elapsed_ms: u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX),
        peak_bps: meter.peak(elapsed),
        cancelled,
    })
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, Default)]
pub struct ExitIp {
    pub ip: String,
    /// ISO 3166 country code, upper case; empty when unknown.
    pub country: String,
}

/// Parse Cloudflare's `/cdn-cgi/trace` body.
#[must_use]
pub fn parse_trace(body: &str) -> Option<ExitIp> {
    let mut out = ExitIp::default();
    for line in body.lines() {
        if let Some(ip) = line.strip_prefix("ip=") {
            ip.trim().clone_into(&mut out.ip);
        } else if let Some(loc) = line.strip_prefix("loc=") {
            let code = loc.trim();
            if code.len() == 2 && code.chars().all(|c| c.is_ascii_alphabetic()) && code != "XX" {
                out.country = code.to_ascii_uppercase();
            }
        }
    }
    out.ip.parse::<std::net::IpAddr>().ok().map(|_| out)
}

/// The address sites see for traffic through the local proxy on `port`.
#[tauri::command]
pub async fn lookup_exit_ip(port: u16) -> Result<ExitIp, String> {
    if port == 0 {
        return Err("no proxy port".to_owned());
    }
    let proxy =
        reqwest::Proxy::all(format!("http://127.0.0.1:{port}")).map_err(|e| e.to_string())?;
    let client = reqwest::Client::builder()
        .proxy(proxy)
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;
    let body = client
        .get("https://www.cloudflare.com/cdn-cgi/trace")
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|e| e.to_string())?
        .text()
        .await
        .map_err(|e| e.to_string())?;
    parse_trace(&body).ok_or_else(|| "unexpected response".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn yaml(s: &str) -> serde_yaml::Value {
        serde_yaml::from_str(s).unwrap()
    }

    #[test]
    fn inject_appends_group_and_listener() {
        let mut v = yaml("proxies:\n  - {name: a, type: direct}\nproxy-groups:\n  - {name: P, type: select, proxies: [a]}\nlisteners:\n  - {name: mine, type: socks, port: 1080}\n");
        assert_eq!(inject(&mut v, 4567), Some(4567));
        let groups = v["proxy-groups"].as_sequence().unwrap();
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0]["name"], key("P"));
        let g = &groups[1];
        assert_eq!(g["name"], key(SPEED_TEST_GROUP));
        assert_eq!(g["hidden"], serde_yaml::Value::Bool(true));
        assert_eq!(g["include-all"], serde_yaml::Value::Bool(true));
        let ls = v["listeners"].as_sequence().unwrap();
        assert_eq!(ls.len(), 2);
        assert_eq!(ls[1]["port"], serde_yaml::Value::Number(4567.into()));
        assert_eq!(ls[1]["listen"], key("127.0.0.1"));
        assert_eq!(ls[1]["proxy"], key(SPEED_TEST_GROUP));
    }

    #[test]
    fn inject_creates_missing_lists() {
        let mut v = yaml("mode: rule\n");
        assert!(inject(&mut v, 1).is_some());
        assert_eq!(v["proxy-groups"].as_sequence().unwrap().len(), 1);
        assert_eq!(v["listeners"].as_sequence().unwrap().len(), 1);
    }

    #[test]
    fn inject_leaves_conflicting_profiles_alone() {
        for src in [
            "proxy-groups:\n  - {name: ZEPHYR-SPEED-TEST, type: select, proxies: [DIRECT]}\n",
            "proxies:\n  - {name: ZEPHYR-SPEED-TEST, type: direct}\n",
            "listeners:\n  - {name: zephyr-speed-test, type: mixed, port: 1}\n",
            "listeners: oops\n",
            "proxy-groups: {a: 1}\n",
        ] {
            let mut v = yaml(src);
            let before = v.clone();
            assert_eq!(inject(&mut v, 9), None, "{src}");
            assert_eq!(v, before, "{src}");
        }
    }

    #[test]
    fn peak_meter_ignores_short_bursts_and_takes_best_second() {
        let mut m = PeakMeter::default();
        // 1 MB in the first 10 ms must not count as 100 MB/s.
        assert_eq!(m.record(Duration::from_millis(10), 1_000_000), 0);
        m.record(Duration::from_millis(1010), 2_000_000);
        m.record(Duration::from_millis(2010), 6_000_000);
        m.record(Duration::from_millis(3010), 7_000_000);
        let peak = m.peak(Duration::from_millis(3010));
        assert!((3_900_000..=4_000_000).contains(&peak), "{peak}");
    }

    #[test]
    fn peak_meter_falls_back_to_average() {
        let mut m = PeakMeter::default();
        m.record(Duration::from_millis(100), 500_000);
        assert_eq!(m.peak(Duration::from_millis(500)), 1_000_000);
    }

    #[test]
    fn trace_parsing() {
        let body = "fl=1\nh=www.cloudflare.com\nip=203.0.113.9\nts=1\nloc=jp\ncolo=NRT\n";
        assert_eq!(
            parse_trace(body),
            Some(ExitIp {
                ip: "203.0.113.9".into(),
                country: "JP".into()
            })
        );
        assert_eq!(parse_trace("ip=2001:db8::1\nloc=XX\n").unwrap().country, "");
        assert_eq!(parse_trace("ip=not-an-ip\n"), None);
        assert_eq!(parse_trace(""), None);
    }

    #[test]
    fn url_check() {
        assert!(checked_url("https://speed.cloudflare.com/__down?bytes=1").is_ok());
        assert!(checked_url("file:///etc/passwd").is_err());
        assert!(checked_url("nonsense").is_err());
    }
}

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
    // A top-level merge key may supply the lists; adding our own would hide them.
    if map.contains_key(key("<<")) {
        return None;
    }
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

/// The core stopped: its listener is gone until the next start injects it again.
pub fn clear_active_port() {
    ACTIVE_PORT.store(0, Ordering::SeqCst);
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
        // Keep the newest sample that is at least a second old as the window's
        // start, so uneven sample times still give a span of a full second.
        while self.window.len() > 1
            && self
                .window
                .get(1)
                .is_some_and(|&(t, _)| at.saturating_sub(t) >= Duration::from_secs(1))
        {
            self.window.pop_front();
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

/// Resolves once [`speed_test_cancel`] has been called after `gen` was read.
async fn cancelled_since(gen: u64) {
    while CANCEL_GEN.load(Ordering::SeqCst) == gen {
        tokio::time::sleep(Duration::from_millis(200)).await;
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
    let request = tokio::time::timeout(deadline, client.get(target).send());
    let resp = tokio::select! {
        r = request => r
            .map_err(|elapsed| format!("timed out: {elapsed}"))?
            .map_err(|e| e.to_string())?,
        () = cancelled_since(gen) => {
            return Ok(SpeedResult {
                bytes: 0,
                elapsed_ms: u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX),
                peak_bps: 0,
                cancelled: true,
            });
        }
    };
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

/// What sites see for traffic through the proxy. `ip` and `country` are
/// always set; the rest only come from ip-info.com, never from the
/// Cloudflare fallback, and every one of them may be missing. Kept in memory
/// by the frontend only.
#[derive(Debug, Clone, Serialize, PartialEq, Default)]
pub struct ExitIp {
    pub ip: String,
    /// ISO 3166 country code, upper case; empty when unknown.
    pub country: String,
    /// "ip-info.com" or "cloudflare".
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub country_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub continent_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_eu: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub region_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub city: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub district: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub postal: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latitude: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub longitude: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timezone: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asn: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub as_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub isp: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub org: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection_type: Option<String>,
    /// "hosting", "residential", ... (a classification, not VPN detection).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_anycast: Option<bool>,
}

/// A two-letter country code, upper case; empty for anything else.
fn country_code(raw: &str) -> String {
    let code = raw.trim();
    if code.len() == 2 && code.chars().all(|c| c.is_ascii_alphabetic()) && code != "XX" {
        code.to_ascii_uppercase()
    } else {
        String::new()
    }
}

/// Parse Cloudflare's `/cdn-cgi/trace` body.
#[must_use]
pub fn parse_trace(body: &str) -> Option<ExitIp> {
    let mut out = ExitIp::default();
    for line in body.lines() {
        if let Some(ip) = line.strip_prefix("ip=") {
            ip.trim().clone_into(&mut out.ip);
        } else if let Some(loc) = line.strip_prefix("loc=") {
            out.country = country_code(loc);
        }
    }
    "cloudflare".clone_into(&mut out.source);
    out.ip.parse::<std::net::IpAddr>().ok().map(|_| out)
}

/// Parse ip-info.com's `/json` body. Every field may be null or missing.
#[must_use]
pub fn parse_ip_info(body: &str) -> Option<ExitIp> {
    use serde_json::Value;
    let v: Value = serde_json::from_str(body).ok()?;
    let obj = v.as_object()?;
    let text = |k: &str| {
        obj.get(k)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    let num = |k: &str| match obj.get(k)? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse().ok(),
        Value::Null | Value::Bool(_) | Value::Array(_) | Value::Object(_) => None,
    };
    let flag = |k: &str| obj.get(k).and_then(Value::as_bool);
    let ip = text("ip")?;
    ip.parse::<std::net::IpAddr>().ok()?;
    let asn = match obj.get("asn") {
        Some(Value::Number(n)) => n.as_u64().and_then(|v| u32::try_from(v).ok()),
        Some(Value::String(s)) => s
            .trim()
            .trim_start_matches(['A', 'S', 'a', 's'])
            .parse()
            .ok(),
        _ => None,
    };
    Some(ExitIp {
        ip,
        country: text("country")
            .as_deref()
            .map(country_code)
            .unwrap_or_default(),
        source: "ip-info.com".to_owned(),
        country_name: text("country_name"),
        continent_name: text("continent_name"),
        is_eu: flag("is_eu"),
        region: text("region"),
        region_code: text("region_code"),
        city: text("city"),
        district: text("district"),
        postal: text("postal"),
        latitude: num("latitude"),
        longitude: num("longitude"),
        timezone: text("timezone"),
        asn,
        as_name: text("as_name"),
        isp: text("isp")
            .or_else(|| text("org"))
            .or_else(|| text("as_name")),
        org: text("org"),
        connection_type: text("connection_type"),
        user_type: text("user_type"),
        is_anycast: flag("is_anycast"),
    })
}

/// Whether a failed ip-info.com request is worth another try: a connection
/// failure (`None`) or a 503/504. Any other answer, a 4xx above all, is not.
const fn worth_retrying(status: Option<u16>) -> bool {
    matches!(status, None | Some(503 | 504))
}

/// ip-info.com through `client`, with at most three retries (1 s, 2 s, 4 s apart).
async fn ip_info(client: &reqwest::Client) -> Option<ExitIp> {
    for wait in [1, 2, 4, 0] {
        let status = match client.get("https://ip-info.com/json").send().await {
            Ok(resp) if resp.status().is_success() => {
                return resp.text().await.ok().and_then(|b| parse_ip_info(&b));
            }
            Ok(resp) => Some(resp.status().as_u16()),
            Err(_) => None,
        };
        if wait == 0 || !worth_retrying(status) {
            return None;
        }
        tokio::time::sleep(Duration::from_secs(wait)).await;
    }
    None
}

/// GET `url` and return the body; any non-2xx status is an error.
async fn fetch_text(client: &reqwest::Client, url: &str) -> Result<String, String> {
    client
        .get(url)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|e| e.to_string())?
        .text()
        .await
        .map_err(|e| e.to_string())
}

/// The address sites see for traffic through the local proxy on `port`:
/// ip-info.com first (location, network), Cloudflare's trace (IP and
/// country) when that fails. Always through the proxy: with no port there is
/// no lookup, never a direct request that would show the real address.
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
        .user_agent(concat!("Zephyr/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())?;
    if let Some(found) = ip_info(&client).await {
        return Ok(found);
    }
    let body = fetch_text(&client, "https://www.cloudflare.com/cdn-cgi/trace").await?;
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
    fn peak_meter_handles_uneven_samples() {
        // Chunks every 600 ms at a steady 1 MB/s: the window must still span
        // a full second, so the peak is the speed, not the fallback average.
        let mut m = PeakMeter::default();
        let mut best = 0;
        for i in 1..=10u64 {
            best = best.max(m.record(Duration::from_millis(i * 600), i * 600_000));
        }
        assert!((990_000..=1_010_000).contains(&best), "{best}");
        assert_eq!(m.peak(Duration::from_millis(6000)), best);
    }

    #[test]
    fn inject_skips_a_config_with_a_top_level_merge_key() {
        let mut v: serde_yaml::Value =
            serde_yaml::from_str("base: &b\n  proxy-groups: []\n<<: *b\n").unwrap();
        assert_eq!(inject(&mut v, 17999), None);
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
                country: "JP".into(),
                source: "cloudflare".into(),
                ..ExitIp::default()
            })
        );
        assert_eq!(parse_trace("ip=2001:db8::1\nloc=XX\n").unwrap().country, "");
        assert_eq!(parse_trace("ip=not-an-ip\n"), None);
        assert_eq!(parse_trace(""), None);
    }

    #[test]
    fn ip_info_parsing() {
        let body = r#"{"ip":"203.0.113.9","city":"Osaka","region":"Osaka","country":"jp","country_name":"Japan","timezone":"Asia/Tokyo","asn":2516,"as_name":"KDDI","isp":"KDDI Corporation","org":"KDDI","connection_type":"Residential","user_type":"residential"}"#;
        let got = parse_ip_info(body).unwrap();
        assert_eq!(got.ip, "203.0.113.9");
        assert_eq!(got.country, "JP");
        assert_eq!(got.source, "ip-info.com");
        assert_eq!(got.city.as_deref(), Some("Osaka"));
        assert_eq!(got.isp.as_deref(), Some("KDDI Corporation"));
        assert_eq!(got.asn, Some(2516));
        assert_eq!(got.user_type.as_deref(), Some("residential"));
        assert_eq!(got.latitude, None);
    }

    #[test]
    fn ip_info_every_field() {
        let body = r#"{"ip":"3.5.140.2","city":"Seattle","district":"Downtown","region":"Washington","region_code":"WA","region_geoname_id":5815135,"country":"US","country_name":"United States","country_geoname_id":6252001,"continent_name":"North America","is_eu":false,"latitude":47.6062,"longitude":-122.3321,"postal":"98101","timezone":"America/Los_Angeles","weather_code":"USWA0395","asn":"AS16509","as_name":"AMAZON-02","isp":"Amazon.com, Inc.","org":"AWS","connection_type":"Corporate","user_type":"hosting","is_anycast":true}"#;
        assert_eq!(
            parse_ip_info(body),
            Some(ExitIp {
                ip: "3.5.140.2".into(),
                country: "US".into(),
                source: "ip-info.com".into(),
                country_name: Some("United States".into()),
                continent_name: Some("North America".into()),
                is_eu: Some(false),
                region: Some("Washington".into()),
                region_code: Some("WA".into()),
                city: Some("Seattle".into()),
                district: Some("Downtown".into()),
                postal: Some("98101".into()),
                latitude: Some(47.6062),
                longitude: Some(-122.3321),
                timezone: Some("America/Los_Angeles".into()),
                asn: Some(16509),
                as_name: Some("AMAZON-02".into()),
                isp: Some("Amazon.com, Inc.".into()),
                org: Some("AWS".into()),
                connection_type: Some("Corporate".into()),
                user_type: Some("hosting".into()),
                is_anycast: Some(true),
            })
        );
    }

    #[test]
    fn ip_info_nulls_fall_back() {
        let body = r#"{"ip":"2001:db8::1","city":null,"region":null,"country":"DE","country_name":"Germany","as_name":"Hetzner","isp":null,"org":null,"user_type":null,"latitude":null}"#;
        let got = parse_ip_info(body).unwrap();
        assert_eq!(got.city, None);
        assert_eq!(got.latitude, None);
        assert_eq!(got.country, "DE");
        assert_eq!(got.isp.as_deref(), Some("Hetzner"));
        let body = r#"{"ip":"198.51.100.1","isp":null,"org":"Example Org"}"#;
        assert_eq!(
            parse_ip_info(body).unwrap().isp.as_deref(),
            Some("Example Org")
        );
        assert_eq!(parse_ip_info(r#"{"ip":null}"#), None);
    }

    #[test]
    fn ip_info_retries_only_unavailable() {
        assert!(worth_retrying(None));
        assert!(worth_retrying(Some(503)));
        assert!(worth_retrying(Some(504)));
        assert!(!worth_retrying(Some(429)));
        assert!(!worth_retrying(Some(404)));
        assert!(!worth_retrying(Some(500)));
    }

    #[test]
    fn ip_info_rejects_non_json() {
        assert_eq!(parse_ip_info("<html>429 Too Many Requests</html>"), None);
        assert_eq!(parse_ip_info(""), None);
    }

    #[test]
    fn url_check() {
        assert!(checked_url("https://speed.cloudflare.com/__down?bytes=1").is_ok());
        assert!(checked_url("file:///etc/passwd").is_err());
        assert!(checked_url("nonsense").is_err());
    }
}

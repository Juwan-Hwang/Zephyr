//! Download speed test and exit-IP lookup.
//!
//! mihomo's REST API can only measure a node's delay, so a download through one
//! chosen node needs its own way in. Every runtime config gets a hidden select
//! group, [`SPEED_TEST_GROUP`], that holds all the profile's nodes, and a mixed
//! listener on loopback bound to that group. The frontend points the group at
//! the node under test (`PUT /proxies/ZEPHYR-SPEED-TEST`) and the download below
//! goes through the listener, so it never touches the user's own selection and
//! no rule can send it DIRECT.

use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
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
const INVALIDATED_EVENT: &str = "diagnostics-invalidated";

pub(crate) fn notify_reloaded(app: &tauri::AppHandle) {
    let _ = app.emit(INVALIDATED_EVENT, ());
}

/// Bumped by [`speed_test_cancel`] with no run; every download stops when it changes.
static CANCEL_GEN: AtomicU64 = AtomicU64::new(0);
/// The runs [`speed_test_cancel`] stopped lately (newest last): a download of
/// one of them stops, including one whose request was still on the way when
/// it was cancelled. A newer run is never touched by an older run's cancel.
static CANCELLED_RUNS: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());
const CANCELLED_RUNS_KEPT: usize = 16;
/// Bumped by [`lookup_exit_ip_cancel`]; a lookup sends nothing more once it changes.
static LOOKUP_GEN: AtomicU64 = AtomicU64::new(0);
static RELOADS: AtomicUsize = AtomicUsize::new(0);
static LOOKUP_CANCELLED: tokio::sync::Notify = tokio::sync::Notify::const_new();

const MAX_SECS: u64 = 60;
const MAX_BYTES_CAP: u64 = 1 << 30;

fn key(s: &str) -> serde_yaml::Value {
    serde_yaml::Value::String(s.to_owned())
}

thread_local! {
    /// The port the running core's listener holds, while a config for that
    /// core is being rebuilt on this thread (see [`with_running_port`]).
    static RUNNING_PORT: std::cell::Cell<Option<u16>> = const { std::cell::Cell::new(None) };
}

/// Run `f` (which prepares a config for the core that runs now) keeping the
/// listener on `port`, the one that core holds: a fresh port would leave the
/// config naming a listener the core never opened if its reload fails.
pub fn with_running_port<T>(port: Option<u16>, f: impl FnOnce() -> T) -> T {
    let before = RUNNING_PORT.with(|c| c.replace(port));
    let out = f();
    RUNNING_PORT.with(|c| c.set(before));
    out
}

/// A free loopback port for the listener. The last one is kept while it is
/// still free, so a restart usually reuses it; one another program has taken
/// meanwhile (or the previous core still holds) is replaced by a fresh one.
/// A rebuild for the running core keeps the port that core holds.
fn listener_port() -> Option<u16> {
    static PORT: std::sync::Mutex<Option<u16>> = std::sync::Mutex::new(None);
    if let Some(p) = RUNNING_PORT.with(std::cell::Cell::get) {
        *PORT.lock().ok()? = Some(p);
        return Some(p);
    }
    let free = |p: u16| std::net::TcpListener::bind(("127.0.0.1", p)).is_ok();
    let last = *PORT.lock().ok()?;
    if let Some(p) = last.filter(|&p| free(p)) {
        return Some(p);
    }
    let fresh = std::net::TcpListener::bind(("127.0.0.1", 0))
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .ok()?;
    *PORT.lock().ok()? = Some(fresh);
    Some(fresh)
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

/// Whether a `proxy-groups` entry is the hidden group [`inject`] adds (a
/// profile's own group of that name is not).
#[must_use]
pub fn is_injected_group(item: &serde_yaml::Value) -> bool {
    let s = |k: &str| item.get(k).and_then(serde_yaml::Value::as_str);
    s("name") == Some(SPEED_TEST_GROUP)
        && s("type") == Some("select")
        && item.get("hidden").and_then(serde_yaml::Value::as_bool) == Some(true)
        && item.get("include-all").and_then(serde_yaml::Value::as_bool) == Some(true)
        && s("x-zephyr-owner") == Some(owner_token())
}

fn owner_token() -> &'static str {
    static TOKEN: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    TOKEN.get_or_init(|| uuid::Uuid::new_v4().simple().to_string())
}

/// Whether `item` (an entry of `list` named `name`) is the one [`inject`] adds.
fn app_owned(list: Option<&serde_yaml::Value>, name: &str) -> Option<bool> {
    let item = list?
        .as_sequence()?
        .iter()
        .find(|v| v.get("name").and_then(serde_yaml::Value::as_str) == Some(name))?;
    let s = |k: &str| item.get(k).and_then(serde_yaml::Value::as_str);
    Some(if name == SPEED_TEST_GROUP {
        is_injected_group(item)
    } else {
        s("type") == Some("mixed")
            && s("listen") == Some("127.0.0.1")
            && s("proxy") == Some(SPEED_TEST_GROUP)
            && has_credentials(item)
    })
}

/// A profile's listener with arbitrary credentials is not app-owned.
fn has_credentials(item: &serde_yaml::Value) -> bool {
    item.get("users")
        .and_then(serde_yaml::Value::as_sequence)
        .and_then(|u| u.first())
        .is_some_and(|u| {
            let s = |k: &str| u.get(k).and_then(serde_yaml::Value::as_str);
            let (user, pass) = listener_credentials();
            s("username") == Some(user) && s("password") == Some(pass)
        })
}

/// Add the hidden group and the loopback listener to a runtime config, or
/// put back whichever of the two a script dropped.
///
/// Leaves the config alone, and returns `None`, when the profile has its own
/// group, proxy or listener under either name, or when `proxy-groups` /
/// `listeners` is not a list: the user's own config always wins over the
/// speed test. Returns the listener's port otherwise.
pub fn inject(yaml: &mut serde_yaml::Value, requested_port: u16) -> Option<u16> {
    let port = if RUNNING_PORT.with(std::cell::Cell::get).is_some() {
        requested_port
    } else {
        owned_listener_port(yaml).unwrap_or(requested_port)
    };
    // The profile's main proxy must bind first. A port can be free on the
    // machine yet already reserved by another listener in this candidate.
    if conflicts_with_proxy_port(yaml, port) {
        remove_injected_route(yaml);
        return None;
    }
    let map = yaml.as_mapping_mut()?;
    // A top-level merge key may supply the lists; adding our own would hide them.
    if map.contains_key(key("<<")) {
        return None;
    }
    let groups_key = key("proxy-groups");
    let listeners_key = key("listeners");
    // A tagged key (`!custom proxy-groups`) is the same entry to the core: a
    // plain one beside it would be a duplicate the core refuses.
    if map.keys().any(|k| {
        matches!(k, serde_yaml::Value::Tagged(t)
            if t.value.as_str().is_some_and(|s| s == "proxy-groups" || s == "listeners"))
    }) {
        return None;
    }
    for k in [&groups_key, &listeners_key] {
        if let Some(v) = map.get(k) {
            if !v.is_sequence() && !v.is_null() {
                return None;
            }
        }
    }
    if names_in(map.get(key("proxies")))
        .iter()
        .any(|n| n == SPEED_TEST_GROUP)
    {
        return None;
    }
    // A provider under the group's name would clash with the group in the core.
    if map
        .get(key("proxy-providers"))
        .and_then(serde_yaml::Value::as_mapping)
        .is_some_and(|providers| providers.contains_key(key(SPEED_TEST_GROUP)))
    {
        return None;
    }
    // Ours (from an earlier injection) is kept; a profile's own is a conflict.
    let has_group = match app_owned(map.get(&groups_key), SPEED_TEST_GROUP) {
        Some(false) => return None,
        Some(true) => true,
        None => false,
    };
    let has_listener = match app_owned(map.get(&listeners_key), SPEED_TEST_LISTENER) {
        Some(false) => return None,
        Some(true) => true,
        None => false,
    };

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
    // Shape alone cannot distinguish a user's identically named selector.
    // Mihomo ignores this extension; it survives our YAML/script round trips.
    group.insert(key("x-zephyr-owner"), key(owner_token()));

    let mut listener = serde_yaml::Mapping::new();
    listener.insert(key("name"), key(SPEED_TEST_LISTENER));
    listener.insert(key("type"), key("mixed"));
    listener.insert(key("listen"), key("127.0.0.1"));
    listener.insert(key("port"), serde_yaml::Value::Number(port.into()));
    listener.insert(key("proxy"), key(SPEED_TEST_GROUP));
    listener.insert(key("udp"), serde_yaml::Value::Bool(false));
    // Its own credentials, never the profile's global `authentication`
    // (which the app does not know) and never none: any local program could
    // otherwise proxy through every node without a password.
    let (user, pass) = listener_credentials();
    let mut entry = serde_yaml::Mapping::new();
    entry.insert(key("username"), key(user));
    entry.insert(key("password"), key(pass));
    listener.insert(
        key("users"),
        serde_yaml::Value::Sequence(vec![serde_yaml::Value::Mapping(entry)]),
    );

    for (k, item, present) in [
        (groups_key, serde_yaml::Value::Mapping(group), has_group),
        (
            listeners_key,
            serde_yaml::Value::Mapping(listener),
            has_listener,
        ),
    ] {
        if present {
            // Scripts can edit an existing listener too. A live rebuild must
            // preserve the confirmed port, not merely restore missing entries.
            if k == key("proxy-groups") || RUNNING_PORT.with(std::cell::Cell::get).is_some() {
                let name = item.get("name").and_then(serde_yaml::Value::as_str);
                if let Some(existing) = map
                    .get_mut(&k)
                    .and_then(serde_yaml::Value::as_sequence_mut)
                    .and_then(|list| {
                        list.iter_mut().find(|entry| {
                            entry.get("name").and_then(serde_yaml::Value::as_str) == name
                        })
                    })
                {
                    *existing = item;
                }
            }
            continue;
        }
        // Through a tag (`!groups [...]`) too: replacing the list would drop
        // the profile's own groups or listeners.
        if let Some(seq) = map.get_mut(&k).and_then(serde_yaml::Value::as_sequence_mut) {
            seq.push(item);
        } else {
            map.insert(k, serde_yaml::Value::Sequence(vec![item]));
        }
    }
    injected_port(yaml)
}

fn owned_listener_port(yaml: &serde_yaml::Value) -> Option<u16> {
    let listeners = yaml.get("listeners");
    if app_owned(listeners, SPEED_TEST_LISTENER) != Some(true) {
        return None;
    }
    let listener = listeners?.as_sequence()?.iter().find(|entry| {
        entry.get("name").and_then(serde_yaml::Value::as_str) == Some(SPEED_TEST_LISTENER)
    })?;
    u16::try_from(listener.get("port")?.as_u64()?).ok()
}

fn conflicts_with_proxy_port(yaml: &serde_yaml::Value, port: u16) -> bool {
    let matches_port = |value: &serde_yaml::Value| {
        value
            .as_u64()
            .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
            == Some(u64::from(port))
    };
    let owned_port = owned_listener_port(yaml);
    if yaml
        .get("listeners")
        .and_then(serde_yaml::Value::as_sequence)
        .is_some_and(|listeners| {
            listeners.iter().any(|entry| {
                let owned = owned_port.is_some()
                    && entry.get("name").and_then(serde_yaml::Value::as_str)
                        == Some(SPEED_TEST_LISTENER);
                !owned && entry.get("port").is_some_and(matches_port)
            })
        })
    {
        return true;
    }
    [
        "mixed-port",
        "port",
        "socks-port",
        "redir-port",
        "tproxy-port",
    ]
    .iter()
    .filter_map(|name| yaml.get(*name))
    .any(matches_port)
}

fn remove_injected_route(yaml: &mut serde_yaml::Value) {
    for (list, name) in [
        ("proxy-groups", SPEED_TEST_GROUP),
        ("listeners", SPEED_TEST_LISTENER),
    ] {
        if app_owned(yaml.get(list), name) == Some(true) {
            if let Some(entries) = yaml
                .get_mut(list)
                .and_then(serde_yaml::Value::as_sequence_mut)
            {
                entries.retain(|entry| {
                    entry.get("name").and_then(serde_yaml::Value::as_str) != Some(name)
                });
            }
        }
    }
}

/// Username and password of the listener, random and fixed for this process.
fn listener_credentials() -> (&'static str, &'static str) {
    static PASS: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    (
        "zephyr",
        PASS.get_or_init(|| uuid::Uuid::new_v4().simple().to_string()),
    )
}

/// [`inject`] with this run's port. Nothing is recorded here: a prepared
/// config is not a running one (a start can still fail, a rebuild can run
/// with the core stopped). The start/reload path confirms the listener before
/// publishing it in core state.
pub fn inject_for_runtime(yaml: &mut serde_yaml::Value) {
    if let Some(p) = listener_port() {
        let _ = inject(yaml, p);
    }
}

/// The speed-test listener of a config: its port and the credentials it takes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Listener {
    pub port: u16,
    pub auth: Option<(String, String)>,
}

/// The listener [`inject`] added to `yaml`, if it has one. A profile's own
/// group or listener under the reserved names is never taken for it.
#[must_use]
pub fn injected_listener(yaml: &serde_yaml::Value) -> Option<Listener> {
    if app_owned(yaml.get("proxy-groups"), SPEED_TEST_GROUP) != Some(true)
        || app_owned(yaml.get("listeners"), SPEED_TEST_LISTENER) != Some(true)
    {
        return None;
    }
    let l =
        yaml.get("listeners")?.as_sequence()?.iter().find(|l| {
            l.get("name").and_then(serde_yaml::Value::as_str) == Some(SPEED_TEST_LISTENER)
        })?;
    let port = l
        .get("port")?
        .as_u64()
        .and_then(|p| u16::try_from(p).ok())
        .filter(|&p| p != 0)?;
    let auth = l
        .get("users")
        .and_then(serde_yaml::Value::as_sequence)
        .and_then(|u| u.first())
        .and_then(|u| {
            let s = |k: &str| {
                u.get(k)
                    .and_then(serde_yaml::Value::as_str)
                    .map(str::to_owned)
            };
            Some((s("username")?, s("password")?))
        });
    Some(Listener { port, auth })
}

/// Port of the listener [`inject`] added to `yaml`, if it has one.
#[must_use]
pub fn injected_port(yaml: &serde_yaml::Value) -> Option<u16> {
    injected_listener(yaml).map(|l| l.port)
}

/// Last confirmed bound port, independent of a candidate written to disk.
#[must_use]
pub fn held_port(app: &tauri::AppHandle) -> Option<u16> {
    recorded_listener(app).map(|listener| listener.port)
}

/// Parse the candidate before sending its reload. Parsing alone never makes
/// the candidate authoritative.
#[must_use]
pub fn listener_from_config(config: &str) -> Option<Listener> {
    let yaml = serde_yaml::from_str(config).ok()?;
    injected_listener(&yaml)
}

/// Confirm a local mixed listener without sending any request off-machine.
/// Completing SOCKS negotiation confirms the port accepts the configured
/// credentials. It is a protocol check, not authentication of a hostile local
/// process. No CONNECT request (and therefore no destination) is sent.
fn listener_bound(listener: &Listener) -> Option<()> {
    use std::io::{Read as _, Write as _};
    let (user, pass) = listener.auth.as_ref()?;
    let user_len = u8::try_from(user.len()).ok()?;
    let pass_len = u8::try_from(pass.len()).ok()?;
    let timeout = Duration::from_millis(500);
    let address = std::net::SocketAddr::from(([127, 0, 0, 1], listener.port));
    let mut socket = std::net::TcpStream::connect_timeout(&address, timeout).ok()?;
    socket.set_read_timeout(Some(timeout)).ok()?;
    socket.set_write_timeout(Some(timeout)).ok()?;
    socket.write_all(&[5, 1, 2]).ok()?;
    let mut reply = [0; 2];
    socket.read_exact(&mut reply).ok()?;
    if reply != [5, 2] {
        return None;
    }
    let mut auth = vec![1, user_len];
    auth.extend_from_slice(user.as_bytes());
    auth.push(pass_len);
    auth.extend_from_slice(pass.as_bytes());
    socket.write_all(&auth).ok()?;
    socket.read_exact(&mut reply).ok()?;
    (reply == [1, 0]).then_some(())
}

/// Called off async workers after a successful start/reload. A 2xx reload is
/// not evidence that its listener bound successfully. Keep a previous bound
/// listener only when the candidate still owns the diagnostic route.
pub fn confirm_listener(app: &tauri::AppHandle, candidate: Option<Listener>) {
    use tauri::Manager as _;
    let state = app.state::<crate::core_manager::MihomoState>();
    let Some((port, secret, previous)) = state.0.lock().ok().and_then(|core| {
        core.last_port().map(|port| {
            (
                port,
                core.last_secret().to_owned(),
                core.speed_test_listener().cloned(),
            )
        })
    }) else {
        return;
    };
    let confirmed = candidate.and_then(|listener| {
        if listener_bound(&listener).is_some() {
            Some(listener)
        } else {
            previous.filter(|old| old != &listener && listener_bound(old).is_some())
        }
    });
    if let Ok(mut core) = state.0.lock() {
        if core.last_port() == Some(port) && core.last_secret() == secret {
            core.set_speed_test_listener(confirmed);
        }
    };
}

fn recorded_listener(app: &tauri::AppHandle) -> Option<Listener> {
    use tauri::Manager as _;
    let state = app.state::<crate::core_manager::MihomoState>();
    let core = state.0.lock().ok()?;
    core.last_port()?;
    let listener = core.speed_test_listener().cloned();
    drop(core);
    listener
}

/// A proxy through `listener`, with its credentials.
fn listener_proxy(listener: &Listener) -> Result<reqwest::Proxy, String> {
    let proxy = reqwest::Proxy::all(format!("http://127.0.0.1:{}", listener.port))
        .map_err(|e| e.to_string())?;
    Ok(match &listener.auth {
        Some((user, pass)) => proxy.basic_auth(user, pass),
        None => proxy,
    })
}

/// The listener confirmed by the last successful start or reload. Polling
/// reads memory only; a rejected candidate on disk cannot change this value.
fn running_listener(app: &tauri::AppHandle) -> Option<Listener> {
    if RELOADS.load(Ordering::SeqCst) != 0 || crate::prism::pipeline::core_start_in_progress() {
        return None;
    }
    recorded_listener(app)
}

/// Port of the speed-test listener, or `None` when the running config has none.
#[tauri::command]
#[must_use]
#[allow(clippy::needless_pass_by_value)] // Tauri hands commands the handle by value
pub fn speed_test_port(app: tauri::AppHandle) -> Option<u16> {
    // Ownership queries also filter the hidden group from the UI; preserve
    // that answer while a reload temporarily blocks new diagnostic requests.
    recorded_listener(&app).map(|l| l.port)
}

/// Stop every download of run `run`, running now or started after this; with
/// no run, every download that is running now.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri hands commands their arguments by value
pub fn speed_test_cancel(run: Option<String>) {
    match run.filter(|r| !r.is_empty()) {
        Some(r) => {
            if let Ok(mut runs) = CANCELLED_RUNS.lock() {
                if !runs.contains(&r) {
                    runs.push(r);
                }
                let extra = runs.len().saturating_sub(CANCELLED_RUNS_KEPT);
                runs.drain(..extra);
            }
        }
        None => {
            CANCEL_GEN.fetch_add(1, Ordering::SeqCst);
        }
    }
}

/// Whether run `run` was stopped (an empty or missing id never is).
fn run_cancelled(run: Option<&str>) -> bool {
    run.filter(|r| !r.is_empty()).is_some_and(|r| {
        CANCELLED_RUNS
            .lock()
            .is_ok_and(|runs| runs.iter().any(|x| x == r))
    })
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
    run: Option<&'a str>,
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

/// Tracks one-second windows, interpolating cumulative samples at their edges.
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
        // The download's start (nothing yet) is the first window's start, so
        // bytes that arrive before the first full second still count.
        if self.window.is_empty() {
            self.window.push_back((Duration::ZERO, 0));
        }
        let second = Duration::from_secs(1);
        let previous = *self.window.back().unwrap_or(&(Duration::ZERO, 0));
        self.window.push_back((at, total));
        let cutoff = at.saturating_sub(second);
        // Every maximum in the piecewise-linear measurement has one edge at
        // a sample. Evaluate starts whose one-second endpoint just became
        // available before discarding samples older than the current window.
        let mut between_samples = 0;
        while let Some(&(start, bytes)) = self.window.front() {
            let end = start.saturating_add(second);
            if end > previous.0 && end <= at {
                between_samples = between_samples
                    .max(interpolate_bytes(previous, (at, total), end).saturating_sub(bytes));
            }
            if self.window.get(1).is_none_or(|&(time, _)| time > cutoff) {
                break;
            }
            self.window.pop_front();
        }
        let before = *self.window.front().unwrap_or(&(at, total));
        let after = *self.window.get(1).unwrap_or(&(at, total));
        // A sub-second burst is not a full window. Short transfers still get
        // their average from `peak` once the download ends.
        let bps = if at >= second {
            total.saturating_sub(interpolate_bytes(before, after, cutoff))
        } else {
            0
        }
        .max(between_samples);
        self.peak = self.peak.max(bps);
        bps
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

fn interpolate_bytes(before: (Duration, u64), after: (Duration, u64), at: Duration) -> u64 {
    let span = after.0.saturating_sub(before.0).as_nanos();
    if span == 0 {
        return before.1;
    }
    let offset = at.saturating_sub(before.0).as_nanos().min(span);
    let delta = u128::from(after.1.saturating_sub(before.1)) * offset / span;
    before
        .1
        .saturating_add(u64::try_from(delta).unwrap_or(u64::MAX))
}

/// Resolves once [`speed_test_cancel`] has been called after `gen` was read,
/// or for run `run`.
async fn cancelled_since(gen: u64, run: Option<&str>) {
    while CANCEL_GEN.load(Ordering::SeqCst) == gen && !run_cancelled(run) {
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
    run: Option<String>,
) -> Result<SpeedResult, String> {
    // Capture before setup so a concurrent cancel cannot be adopted as the
    // baseline of a download that was already running.
    let gen = CANCEL_GEN.load(Ordering::SeqCst);
    let target = checked_url(&url)?;
    let listener = running_listener(&app).ok_or("speed test is not available for this profile")?;
    let secs = max_secs.clamp(1, MAX_SECS);
    let byte_cap = max_bytes.unwrap_or(MAX_BYTES_CAP).min(MAX_BYTES_CAP);

    let proxy = listener_proxy(&listener)?;
    // Bytes as they cross the network: a compressed answer must not count
    // as its expanded size.
    let client = reqwest::Client::builder()
        .proxy(proxy)
        .connect_timeout(Duration::from_secs(8))
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .build()
        .map_err(|e| e.to_string())?;
    let deadline = Duration::from_secs(secs);
    let start = Instant::now();
    let stopped = |start: Instant| SpeedResult {
        bytes: 0,
        elapsed_ms: u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX),
        peak_bps: 0,
        cancelled: true,
    };
    // Stopped before this call arrived: send nothing.
    if CANCEL_GEN.load(Ordering::SeqCst) != gen || run_cancelled(run.as_deref()) {
        return Ok(stopped(start));
    }
    let request = tokio::time::timeout(deadline, client.get(target).send());
    let resp = tokio::select! {
        biased;
        () = cancelled_since(gen, run.as_deref()) => return Ok(stopped(start)),
        r = request => r
            .map_err(|elapsed| format!("timed out: {elapsed}"))?
            .map_err(|e| e.without_url().to_string())?,
    };
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }
    let mut stream = resp.bytes_stream();
    // The rate is timed from the answer's arrival: the wait for its headers
    // is the node's latency, and in a short download it would sink the rate.
    // The time limit still counts from the request.
    let body_start = Instant::now();
    let mut meter = PeakMeter::default();
    let mut bytes = 0u64;
    let mut last_emit = Duration::ZERO;
    let mut cancelled = false;
    loop {
        let left = deadline.saturating_sub(start.elapsed());
        if left.is_zero() || bytes >= byte_cap {
            break;
        }
        if CANCEL_GEN.load(Ordering::SeqCst) != gen || run_cancelled(run.as_deref()) {
            cancelled = true;
            break;
        }
        let next = tokio::time::timeout(left.min(Duration::from_millis(500)), stream.next()).await;
        match next {
            Err(_) => {}
            Ok(None) => break,
            // A transfer cut off midway is a failed test, never a result to rank.
            Ok(Some(Err(e))) => return Err(e.without_url().to_string()),
            // Cap the measured body bytes. Protocol overhead and bytes already
            // buffered by the transport can make actual network traffic larger.
            Ok(Some(Ok(chunk))) => bytes += (chunk.len() as u64).min(byte_cap - bytes),
        }
        let at = body_start.elapsed();
        let bps = meter.record(at, bytes);
        if at.saturating_sub(last_emit) >= Duration::from_millis(500) {
            last_emit = at;
            let _ = app.emit(
                PROGRESS_EVENT,
                Progress {
                    id: &id,
                    run: run.as_deref(),
                    bytes,
                    bps,
                },
            );
        }
    }
    let elapsed = start.elapsed();
    cancelled |= CANCEL_GEN.load(Ordering::SeqCst) != gen || run_cancelled(run.as_deref());
    Ok(SpeedResult {
        bytes,
        elapsed_ms: u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX),
        peak_bps: meter.peak(body_start.elapsed()),
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
    if code.len() == 2
        && code.chars().all(|c| c.is_ascii_alphabetic())
        && !code.eq_ignore_ascii_case("XX")
    {
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

/// Stop every exit-IP lookup that is running now (the user turned the setting
/// off, or the core restarted): no retry and no fallback request is sent after.
#[tauri::command]
pub fn lookup_exit_ip_cancel() {
    LOOKUP_GEN.fetch_add(1, Ordering::SeqCst);
    LOOKUP_CANCELLED.notify_waiters();
}

/// Full config reloads can reset the hidden selection. Invalidate before the
/// PUT and refuse new diagnostics until the response and binding confirmation.
pub(crate) struct ReloadGuard;

impl ReloadGuard {
    pub(crate) fn acquire() -> Self {
        RELOADS.fetch_add(1, Ordering::SeqCst);
        lookup_exit_ip_cancel();
        speed_test_cancel(None);
        Self
    }
}

impl Drop for ReloadGuard {
    fn drop(&mut self) {
        RELOADS.fetch_sub(1, Ordering::SeqCst);
    }
}

fn lookup_cancelled(gen: u64) -> bool {
    LOOKUP_GEN.load(Ordering::SeqCst) != gen
}

/// ip-info.com through `client`, with at most three retries (1 s, 2 s, 4 s
/// apart); none once the lookup started at `gen` was cancelled.
async fn ip_info(client: &reqwest::Client, gen: u64) -> Option<ExitIp> {
    for wait in [1, 2, 4, 0] {
        if lookup_cancelled(gen) {
            return None;
        }
        let status = match client.get("https://ip-info.com/json").send().await {
            Ok(resp) if resp.status().is_success() => {
                return read_capped(resp).await.ok().and_then(|b| parse_ip_info(&b));
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

/// Largest exit-IP answer read: both services send well under 2 KiB.
const MAX_LOOKUP_BODY: usize = 64 * 1024;

/// The body of `resp` as text, or an error once it passes [`MAX_LOOKUP_BODY`].
async fn read_capped(resp: reqwest::Response) -> Result<String, String> {
    read_body_up_to(resp, MAX_LOOKUP_BODY).await
}

async fn read_body_up_to(resp: reqwest::Response, limit: usize) -> Result<String, String> {
    let mut stream = resp.bytes_stream();
    let mut body = Vec::new();
    while let Some(next) = stream.next().await {
        let chunk = next.map_err(|e| e.to_string())?;
        if body.len() + chunk.len() > limit {
            return Err("response too large".to_owned());
        }
        body.extend_from_slice(&chunk);
    }
    String::from_utf8(body).map_err(|e| e.to_string())
}

/// GET `url` and return the body; any non-2xx status is an error.
async fn fetch_text(client: &reqwest::Client, url: &str) -> Result<String, String> {
    let resp = client
        .get(url)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|e| e.to_string())?;
    read_capped(resp).await
}

/// The address sites see for traffic through the local proxy on `port`:
/// ip-info.com first (location, network), Cloudflare's trace (IP and
/// country) when that fails. Always through the proxy: with no port there is
/// no lookup, never a direct request that would show the real address.
#[tauri::command]
pub async fn lookup_exit_ip(app: tauri::AppHandle, port: u16, leaf: String) -> Result<ExitIp, String> {
    if port == 0 {
        return Err("no proxy port".to_owned());
    }
    let gen = LOOKUP_GEN.load(Ordering::SeqCst);
    // Only through the listener the caller pinned, as the core runs it now,
    // with its credentials: another port could be anything.
    let listener = running_listener(&app)
        .filter(|l| l.port == port)
        .ok_or("the speed-test listener changed")?;
    confirm_selected_leaf(&app, &leaf, gen).await?;
    let proxy = listener_proxy(&listener)?;
    let client = reqwest::Client::builder()
        .proxy(proxy)
        .timeout(Duration::from_secs(8))
        .user_agent(concat!("Zephyr/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())?;
    let lookup = async {
        if let Some(found) = ip_info(&client, gen).await {
            return Ok(found);
        }
        if lookup_cancelled(gen) {
            return Err("cancelled".to_owned());
        }
        let body = fetch_text(&client, "https://www.cloudflare.com/cdn-cgi/trace").await?;
        parse_trace(&body).ok_or_else(|| "unexpected response".to_owned())
    };
    // A cancel ends the request in flight (and its retry wait) too, so the
    // download queue behind it is not held until a timeout.
    tokio::select! {
        biased;
        () = lookup_cancelled_wait(gen) => Err("cancelled".to_owned()),
        r = lookup => r,
    }
}

/// The port survives a reload but the selector may reset. Check the requested
/// leaf against the authenticated controller after capturing the generation;
/// our own full reload invalidates it before changing any route. Arbitrary
/// concurrent controller writes from other programs are outside this guard.
async fn confirm_selected_leaf(app: &tauri::AppHandle, leaf: &str, gen: u64) -> Result<(), String> {
    use tauri::Manager as _;
    if leaf.is_empty() || matches!(leaf, "DIRECT" | "REJECT" | "PASS" | "COMPATIBLE") {
        return Err("no proxy leaf selected".to_owned());
    }
    let (port, secret) = {
        let state = app.state::<crate::core_manager::MihomoState>();
        let core = state.0.lock().map_err(|_| "core state unavailable")?;
        let endpoint = (
            core.last_port().ok_or("core is stopped")?,
            core.last_secret().to_owned(),
        );
        drop(core);
        endpoint
    };
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(3))
        .build()
        .map_err(|error| error.to_string())?;
    for name in [SPEED_TEST_GROUP, leaf] {
        if lookup_cancelled(gen) {
            return Err("cancelled".to_owned());
        }
        let proxy = controller_proxy(&client, port, &secret, name, gen).await?;
        let valid = if name == SPEED_TEST_GROUP {
            proxy.get("now").and_then(serde_json::Value::as_str) == Some(leaf)
        } else {
            is_proxy_leaf(&proxy)
        };
        if !valid {
            return Err("the selected proxy changed".to_owned());
        }
    }
    if lookup_cancelled(gen) {
        return Err("cancelled".to_owned());
    }
    Ok(())
}

fn is_proxy_leaf(proxy: &serde_json::Value) -> bool {
    let kind = proxy.get("type").and_then(serde_json::Value::as_str);
    proxy.get("all").is_none()
        && kind.is_some_and(|kind| {
            !matches!(
                kind.to_ascii_lowercase().as_str(),
                "direct" | "reject" | "rejectdrop" | "pass" | "compatible" | "dns"
            )
        })
}

async fn controller_proxy(
    client: &reqwest::Client,
    port: u16,
    secret: &str,
    name: &str,
    gen: u64,
) -> Result<serde_json::Value, String> {
    let mut target = url::Url::parse(&format!("http://127.0.0.1:{port}/proxies/"))
        .map_err(|error| error.to_string())?;
    target
        .path_segments_mut()
        .map_err(|()| "invalid controller address")?
        .pop_if_empty()
        .push(name);
    let response = client
        .get(target)
        .bearer_auth(secret)
        .send()
        .await
        .map_err(|error| error.without_url().to_string())?;
    if name != SPEED_TEST_GROUP && response.status() == reqwest::StatusCode::NOT_FOUND {
        if lookup_cancelled(gen) {
            return Err("cancelled".to_owned());
        }
        // Provider leaves are absent from /proxies/:name. The controller's
        // provider records carry the same type data as its individual route.
        let providers = client
            .get(format!("http://127.0.0.1:{port}/providers/proxies"))
            .bearer_auth(secret)
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(|error| error.without_url().to_string())?;
        let body = read_body_up_to(providers, crate::core_manager::core::MAX_RESPONSE_SIZE).await?;
        let data: serde_json::Value =
            serde_json::from_str(&body).map_err(|_| "invalid provider response")?;
        return provider_leaf(&data, name)
            .cloned()
            .ok_or_else(|| "the selected proxy changed".to_owned());
    }
    let accepted = response
        .error_for_status()
        .map_err(|error| error.without_url().to_string())?;
    let body = read_body_up_to(accepted, crate::core_manager::core::MAX_RESPONSE_SIZE).await?;
    serde_json::from_str(&body).map_err(|_| "invalid proxy response".to_owned())
}

fn provider_leaf<'a>(data: &'a serde_json::Value, name: &str) -> Option<&'a serde_json::Value> {
    data.get("providers")?
        .as_object()?
        .values()
        .filter_map(|provider| provider.get("proxies").and_then(serde_json::Value::as_array))
        .flatten()
        .find(|proxy| proxy.get("name").and_then(serde_json::Value::as_str) == Some(name))
}

/// Resolves once the lookup started at `gen` was cancelled.
async fn lookup_cancelled_wait(gen: u64) {
    loop {
        let notified = LOOKUP_CANCELLED.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if lookup_cancelled(gen) {
            return;
        }
        notified.await;
    }
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
        assert_eq!(injected_port(&v), Some(4567));
        let ls = v["listeners"].as_sequence().unwrap();
        assert_eq!(ls.len(), 2);
        assert_eq!(ls[1]["port"], serde_yaml::Value::Number(4567.into()));
        assert_eq!(ls[1]["listen"], key("127.0.0.1"));
        assert_eq!(ls[1]["proxy"], key(SPEED_TEST_GROUP));
    }

    #[test]
    fn a_tagged_list_key_is_left_alone() {
        let mut v = yaml("!custom proxy-groups:\n  - {name: P, type: select, proxies: [DIRECT]}\n");
        assert_eq!(inject(&mut v, 4567), None);
        assert!(v.get("proxy-groups").is_none());
        let mut v = yaml("!custom listeners: []\n");
        assert_eq!(inject(&mut v, 4567), None);
        assert!(v.get("listeners").is_none());
    }

    #[test]
    fn only_the_injected_group_counts_as_ours() {
        let mut v = yaml("mode: rule\n");
        inject(&mut v, 1).unwrap();
        let ours = &v["proxy-groups"][0];
        assert!(is_injected_group(ours));
        let theirs = yaml("{name: ZEPHYR-SPEED-TEST, type: url-test, hidden: true, proxies: [a]}");
        assert!(!is_injected_group(&theirs));
        let lookalike = yaml("{name: ZEPHYR-SPEED-TEST, type: select, hidden: true, include-all: true, proxies: [DIRECT]}");
        assert!(!is_injected_group(&lookalike));
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
            "proxy-groups:\n  - {name: ZEPHYR-SPEED-TEST, type: select, hidden: true, include-all: true, proxies: [DIRECT]}\n",
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
    fn inject_puts_back_the_half_a_script_dropped() {
        let mut full = yaml("proxies:\n  - {name: a, type: direct}\n");
        assert_eq!(inject(&mut full, 4567), Some(4567));
        // Idempotent: a second pass adds nothing.
        let again = full.clone();
        assert_eq!(inject(&mut full, 1111), Some(4567));
        assert_eq!(full, again);

        let mut no_listener = full.clone();
        no_listener["listeners"] = serde_yaml::Value::Sequence(Vec::new());
        assert_eq!(inject(&mut no_listener, 5000), Some(5000));
        assert_eq!(no_listener["proxy-groups"].as_sequence().unwrap().len(), 1);
        assert_eq!(no_listener["listeners"].as_sequence().unwrap().len(), 1);

        let mut no_group = full.clone();
        no_group["proxy-groups"] = serde_yaml::Value::Sequence(Vec::new());
        assert_eq!(inject(&mut no_group, 5000), Some(4567));
        assert_eq!(no_group["proxy-groups"].as_sequence().unwrap().len(), 1);
        assert_eq!(no_group["listeners"].as_sequence().unwrap().len(), 1);
    }

    #[test]
    fn injection_restores_the_owned_selector_after_broad_script_edits() {
        let mut config = yaml("mode: rule\n");
        inject(&mut config, 4567).unwrap();
        let group = config["proxy-groups"][0].clone();
        config["proxy-groups"][0]["filter"] = key("^A$");
        config["proxy-groups"][0]["exclude-filter"] = key("B");
        inject(&mut config, 4567).unwrap();
        assert_eq!(config["proxy-groups"][0], group);
    }

    #[test]
    fn injection_keeps_custom_listeners_when_their_port_conflicts() {
        let mut config = yaml("listeners:\n  - {name: mine, type: mixed, listen: 127.0.0.1, port: 4567}\n");
        let before = config.clone();
        assert_eq!(inject(&mut config, 4567), None);
        assert_eq!(config, before);

        let mut config = yaml("mode: rule\n");
        inject(&mut config, 4567).unwrap();
        config["listeners"]
            .as_sequence_mut()
            .unwrap()
            .push(before["listeners"][0].clone());
        assert_eq!(inject(&mut config, 4567), None);
        assert_eq!(config["listeners"], before["listeners"]);
    }

    #[test]
    fn provider_leaf_validation_rejects_direct_routes_and_selectors() {
        let providers = serde_json::json!({"providers": {"subscription": {"proxies": [
            {"name": "node", "type": "Shadowsocks"},
            {"name": "direct-alias", "type": "Direct"}
        ]}}});
        assert!(is_proxy_leaf(provider_leaf(&providers, "node").unwrap()));
        assert!(!is_proxy_leaf(
            provider_leaf(&providers, "direct-alias").unwrap()
        ));
        assert!(!is_proxy_leaf(
            &serde_json::json!({"type": "Selector", "all": ["node"]})
        ));
        assert!(provider_leaf(&providers, "missing").is_none());
    }

    #[test]
    fn injected_listener_has_its_own_credentials() {
        let mut v = yaml("authentication: ['u:p']\n");
        inject(&mut v, 4567).unwrap();
        let users = v["listeners"][0]["users"].as_sequence().unwrap();
        assert_eq!(users.len(), 1);
        let (user, pass) = listener_credentials();
        assert_eq!(users[0]["username"], key(user));
        assert_eq!(users[0]["password"], key(pass));
        assert!(pass.len() >= 32);
        let found = injected_listener(&v).unwrap();
        assert_eq!(found.port, 4567);
        assert_eq!(found.auth, Some((user.to_owned(), pass.to_owned())));
    }

    #[test]
    fn a_profiles_own_group_is_not_taken_for_the_listener() {
        let v = yaml("proxy-groups:\n  - {name: ZEPHYR-SPEED-TEST, type: select, proxies: [DIRECT]}\nlisteners:\n  - {name: zephyr-speed-test, type: mixed, listen: 127.0.0.1, port: 7000, proxy: ZEPHYR-SPEED-TEST}\n");
        assert_eq!(injected_port(&v), None);
    }

    #[test]
    fn a_listener_without_credentials_is_never_ours() {
        let mut v = yaml("mode: rule\n");
        inject(&mut v, 4567).unwrap();
        v["listeners"][0]
            .as_mapping_mut()
            .unwrap()
            .remove(key("users"));
        assert_eq!(injected_port(&v), None);
        let before = v.clone();
        assert_eq!(inject(&mut v, 4567), None);
        assert_eq!(v, before);
    }

    #[test]
    fn a_listener_with_foreign_credentials_is_never_ours() {
        let mut config = yaml("mode: rule\n");
        inject(&mut config, 4567).unwrap();
        config["listeners"][0]["users"][0]["password"] = key("someone-elses-password");
        assert_eq!(injected_listener(&config), None);
    }

    #[test]
    fn listener_confirmation_authenticates_without_connecting_to_a_destination() {
        use std::io::{Read as _, Write as _};
        let server = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let listener = Listener {
            port: server.local_addr().unwrap().port(),
            auth: Some(("u".to_owned(), "p".to_owned())),
        };
        let thread = std::thread::spawn(move || {
            let (mut socket, _) = server.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut greeting = [0; 3];
            socket.read_exact(&mut greeting).unwrap();
            assert_eq!(greeting, [5, 1, 2]);
            socket.write_all(&[5, 2]).unwrap();
            let mut auth = [0; 5];
            socket.read_exact(&mut auth).unwrap();
            assert_eq!(auth, [1, 1, b'u', 1, b'p']);
            socket.write_all(&[1, 0]).unwrap();
            assert_eq!(socket.read(&mut [0; 1]).unwrap(), 0);
        });
        assert_eq!(listener_bound(&listener), Some(()));
        thread.join().unwrap();
    }

    #[test]
    fn a_provider_under_the_group_name_is_left_alone() {
        let mut v = yaml(
            "proxy-providers:\n  ZEPHYR-SPEED-TEST: {type: http, url: 'https://example.com/a'}\n",
        );
        let before = v.clone();
        assert_eq!(inject(&mut v, 4567), None);
        assert_eq!(v, before);
    }

    #[test]
    fn rebuild_for_running_core_keeps_its_port() {
        let held = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = held.local_addr().unwrap().port();
        let mut v = yaml("mode: rule\n");
        with_running_port(Some(port), || inject_for_runtime(&mut v));
        assert_eq!(injected_port(&v), Some(port));
        v["listeners"][0]["port"] = serde_yaml::Value::Number(1234.into());
        with_running_port(Some(port), || inject_for_runtime(&mut v));
        assert_eq!(injected_port(&v), Some(port));
    }

    #[test]
    fn diagnostic_route_never_steals_a_configured_proxy_port() {
        for main_port in [
            "mixed-port",
            "port",
            "socks-port",
            "redir-port",
            "tproxy-port",
        ] {
            let mut config = yaml(&format!("{main_port}: 4567\n"));
            let before = config.clone();
            assert_eq!(inject(&mut config, 4567), None);
            assert_eq!(config, before);

            let mut config = yaml("mode: rule\n");
            inject(&mut config, 4567).unwrap();
            config[main_port] = serde_yaml::Value::Number(4567.into());
            assert_eq!(inject(&mut config, 9999), None);
            assert_eq!(injected_port(&config), None);
            assert_eq!(config[main_port].as_u64(), Some(4567));
        }
    }

    #[test]
    fn cancel_by_run_reaches_a_download_that_had_not_started() {
        speed_test_cancel(Some("run-test-1".to_owned()));
        assert!(run_cancelled(Some("run-test-1")));
        assert!(!run_cancelled(Some("run-test-2")));
        // Other core lifecycle tests can cancel all downloads concurrently;
        // the run-scoped history itself still leaves unrelated runs alone.
        speed_test_cancel(Some("run-test-3".to_owned()));
        assert!(run_cancelled(Some("run-test-1")));
        assert!(!run_cancelled(None));
        assert!(!run_cancelled(Some("")));
    }

    #[test]
    fn unknown_country_in_any_case_is_empty() {
        assert_eq!(country_code("xx"), "");
        assert_eq!(country_code("XX"), "");
        assert_eq!(country_code("jp"), "JP");
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
    fn peak_meter_does_not_dilute_an_uneven_window() {
        let mut meter = PeakMeter::default();
        meter.record(Duration::from_millis(600), 1);
        meter.record(Duration::from_millis(1200), 1);
        assert_eq!(
            meter.record(Duration::from_millis(1800), 12_000_001),
            12_000_000
        );
    }

    #[test]
    fn peak_meter_includes_windows_ending_between_samples() {
        let mut meter = PeakMeter::default();
        meter.record(Duration::from_millis(600), 0);
        meter.record(Duration::from_millis(1200), 6_000_000);
        meter.record(Duration::from_millis(1800), 9_000_000);
        assert_eq!(meter.peak(Duration::from_millis(1800)), 8_000_000);
    }

    #[test]
    fn inject_skips_a_config_with_a_top_level_merge_key() {
        let mut v: serde_yaml::Value =
            serde_yaml::from_str("base: &b\n  proxy-groups: []\n<<: *b\n").unwrap();
        assert_eq!(inject(&mut v, 17999), None);
    }

    #[test]
    fn peak_meter_counts_a_fast_first_second() {
        // 8 MB in the first 100 ms, then 1 MB/s: the first second is the peak.
        let mut m = PeakMeter::default();
        m.record(Duration::from_millis(100), 8_000_000);
        m.record(Duration::from_millis(600), 8_500_000);
        m.record(Duration::from_millis(1100), 9_000_000);
        m.record(Duration::from_millis(2100), 10_000_000);
        let peak = m.peak(Duration::from_millis(2100));
        assert_eq!(peak, 8_900_000);
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

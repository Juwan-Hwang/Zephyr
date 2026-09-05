use std::time::Duration;
use tauri::{AppHandle, Manager as _, State};

use super::fetch_util::fetch_url_content;
use zephyr_core::config::sanitizer::remove_dangerous_keys_internal_pub as remove_dangerous_keys;
use zephyr_core::config::subscription::{
    classify_sub_error, extract_name_from_rules, is_private_host, is_private_ip,
    parse_content_disposition_filename, quote_short_id_values, redact_url_in_string,
    select_global_candidate, try_decode_base64_content, validate_subscription_name,
    validate_subscription_url_basic,
};

use super::core_process::ensure_app_storage;
use super::crypto::{load_metadata, lock_metadata, save_metadata, write_profile_file};
use super::{CoreData, MihomoState, MAX_RESPONSE_SIZE};
#[allow(unused_imports)]
use crate::emit_warn;

fn build_http_client_with_proxy(
    user_agent: Option<&str>,
    resolve_pin: Option<&(String, std::net::SocketAddr)>,
    proxy_url: Option<String>,
    connect_timeout: Duration,
    timeout: Duration,
) -> Result<reqwest::Client, String> {
    let via_proxy = proxy_url.is_some();
    let redirect_policy = reqwest::redirect::Policy::custom(move |attempt| {
        if attempt.previous().len() > 5 {
            return attempt.error("Too many redirects (max 5)");
        }

        let url = attempt.url().clone();

        let scheme = url.scheme();
        if scheme != "http" && scheme != "https" {
            return attempt.error(format!("Invalid redirect scheme: {scheme}"));
        }

        let host = match url.host_str() {
            Some(h) => h.to_owned(),
            None => return attempt.error("Redirect URL has no host"),
        };

        if is_private_host(&host) {
            return attempt.error(format!("Redirect to private host blocked: {host}"));
        }

        // Validate resolved IP addresses to block redirects to private IPs (SSRF protection).
        // For direct requests without a proxy, local DNS resolution failure is fatal.
        // For requests configured with a proxy, the proxy resolves the target remotely,
        // so local DNS resolution failure is permitted to allow reaching blocked domains.
        let port = url
            .port()
            .unwrap_or(if scheme == "https" { 443 } else { 80 });
        match std::net::ToSocketAddrs::to_socket_addrs(&format!("{host}:{port}")) {
            Ok(addrs) => {
                for addr in addrs {
                    if is_private_ip(addr.ip()) {
                        return attempt.error(format!(
                            "Redirect to private IP blocked: {} -> {}",
                            host,
                            addr.ip()
                        ));
                    }
                }
            }
            Err(e) => {
                let is_same_host = attempt
                    .previous()
                    .last()
                    .and_then(|u| u.host_str())
                    .is_some_and(|h| {
                        let h_norm = h.strip_suffix('.').unwrap_or(h);
                        let host_norm = host.strip_suffix('.').unwrap_or(&host);
                        h_norm.eq_ignore_ascii_case(host_norm)
                    })
                    || attempt
                        .previous()
                        .first()
                        .and_then(|u| u.host_str())
                        .is_some_and(|h| {
                            let h_norm = h.strip_suffix('.').unwrap_or(h);
                            let host_norm = host.strip_suffix('.').unwrap_or(&host);
                            h_norm.eq_ignore_ascii_case(host_norm)
                        });
                // For requests via proxy, local DNS resolution failure is permitted ONLY if
                // redirecting to the same host as originally requested (e.g. http->https or path redirects
                // for domains unresolvable locally). Cross-host redirects must resolve to public IPs to prevent
                // SSRF probing against unresolvable internal hostnames through the proxy.
                if !via_proxy || !is_same_host {
                    return attempt.error(format!("Failed to resolve redirect host {host}: {e}"));
                }
            }
        }

        attempt.follow()
    });

    let mut client_builder = reqwest::Client::builder()
        .timeout(timeout)
        .connect_timeout(connect_timeout)
        .redirect(redirect_policy)
        .no_proxy();

    if let Some(proxy_url_inner) = proxy_url {
        let proxy = reqwest::Proxy::all(proxy_url_inner)
            .map_err(|e| format!("Failed to create proxy: {e}"))?;
        client_builder = client_builder.proxy(proxy);
    }

    if let Some((host, addr)) = resolve_pin {
        client_builder = client_builder.resolve(host, *addr);
    }

    // Determine User-Agent: use provided UA, or default to Zephyr
    let ua_to_use = match user_agent {
        Some(ua) if !ua.trim().is_empty() => ua.trim().to_owned(),
        _ => {
            // Default Zephyr User-Agent with version
            let version = env!("CARGO_PKG_VERSION");
            format!("Zephyr/{version}")
        }
    };

    // Apply User-Agent and headers based on type
    if ua_to_use.contains("Shadowrocket") {
        let full_ua = "Shadowrocket/3082 CFNetwork/3826.600.41 Darwin/24.6.0 iPhone11,6";
        client_builder = client_builder.user_agent(full_ua).default_headers({
            let mut headers = reqwest::header::HeaderMap::new();
            headers.insert("Accept", reqwest::header::HeaderValue::from_static("*/*"));
            headers.insert(
                "Accept-Language",
                reqwest::header::HeaderValue::from_static("zh-CN,zh-Hans;q=0.9"),
            );
            headers.insert(
                "Cache-Control",
                reqwest::header::HeaderValue::from_static("no-cache"),
            );
            headers
        });
    } else {
        client_builder = client_builder
                .user_agent(&ua_to_use)
                .default_headers({
                    let mut headers = reqwest::header::HeaderMap::new();
                    headers.insert("Accept", reqwest::header::HeaderValue::from_static("text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9"));
                    headers
                });
    }

    client_builder.build().map_err(|e| e.to_string())
}

async fn read_response_body(resp: reqwest::Response) -> Result<Vec<u8>, String> {
    if let Some(content_length) = resp.content_length() {
        if usize::try_from(content_length).unwrap_or(0) > MAX_RESPONSE_SIZE {
            return Err(format!(
                "Response too large: {content_length} bytes (max {MAX_RESPONSE_SIZE} bytes)"
            ));
        }
    }

    use futures_util::StreamExt as _;
    let capacity = resp
        .content_length()
        .and_then(|len| usize::try_from(len).ok())
        .unwrap_or(0)
        .min(MAX_RESPONSE_SIZE);
    let mut bytes = Vec::with_capacity(capacity);
    let mut stream = resp.bytes_stream();
    while let Some(chunk_result) = stream.next().await {
        let chunk = chunk_result.map_err(|e| format!("Failed to read chunk: {e}"))?;
        if bytes.len() + chunk.len() > MAX_RESPONSE_SIZE {
            return Err(format!(
                "Response exceeded size limit of {MAX_RESPONSE_SIZE} bytes"
            ));
        }
        bytes.extend_from_slice(&chunk);
    }

    Ok(bytes)
}

/// Resolve the subscription URL: use the provided URL if given, otherwise look up from metadata.
fn resolve_url_from_metadata(
    app: &AppHandle,
    name: &str,
    provided_url: Option<String>,
) -> Result<String, String> {
    if let Some(url) = provided_url {
        let trimmed = url.trim();
        if trimmed.is_empty() {
            return Err("URL must not be empty".to_owned());
        }
        return Ok(trimmed.to_owned());
    }

    // Reuse the existing, sanitized logic from config_manager
    super::config_manager::get_config_url(app, name)
}

/// Check whether the mihomo core is currently active.
///
/// In normal mode, `process` is `Some`. In macOS TUN mode, the core is started externally
/// as root and `process` is `None`, but `started_at` and `last_port` remain active while running.
#[inline]
#[allow(clippy::missing_const_for_fn)]
fn is_core_running_from_guard(guard: &CoreData) -> bool {
    if guard.started_at().is_none() {
        return false;
    }
    if guard.process().is_some() {
        return true;
    }
    #[cfg(target_os = "macos")]
    {
        super::tun_manager::is_tun_mode() && guard.last_port().is_some()
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

/// 获取 mihomo API 的客户端、基础 URL 和 secret。
/// 失败时返回 None（核心未运行或端口未就绪）。
fn mihomo_base_api(app: &AppHandle) -> Option<(reqwest::Client, String, String)> {
    let (api_port, secret) = {
        let state = app.state::<MihomoState>();
        let guard = state
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !is_core_running_from_guard(&guard) {
            return None;
        }
        (guard.last_port()?, guard.last_secret().to_owned())
    };

    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_millis(1000))
        .build()
        .ok()?;
    let base = format!("http://127.0.0.1:{api_port}");
    Some((client, base, secret))
}

/// 获取 mihomo 当前的代理模式（rule / global / direct）。
/// 失败时返回 None，调用方可据此跳过 global 回退。
async fn get_mihomo_mode(app: &AppHandle) -> Option<String> {
    let (client, base, secret) = mihomo_base_api(app)?;
    let url = format!("{base}/configs");
    let mut req = client.get(&url);
    if !secret.is_empty() {
        req = req.bearer_auth(&secret);
    }
    let resp = req.send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body: serde_json::Value = resp.json().await.ok()?;
    body.get("mode")?
        .as_str()
        .map(std::borrow::ToOwned::to_owned)
}

const fn canonicalize_mode(mode: &str) -> Option<&'static str> {
    if mode.eq_ignore_ascii_case("rule") {
        Some("rule")
    } else if mode.eq_ignore_ascii_case("global") {
        Some("global")
    } else if mode.eq_ignore_ascii_case("direct") {
        Some("direct")
    } else {
        None
    }
}

/// 通过 mihomo API 切换代理模式。失败时返回 None。
async fn set_mihomo_mode(app: &AppHandle, mode: &str) -> Option<()> {
    let canonical = canonicalize_mode(mode).unwrap_or(mode);
    let (client, base, secret) = mihomo_base_api(app)?;
    let url = format!("{base}/configs");
    let mut req = client
        .patch(&url)
        .json(&serde_json::json!({ "mode": canonical }));
    if !secret.is_empty() {
        req = req.bearer_auth(&secret);
    }
    let resp = req.send().await.ok()?;
    resp.status().is_success().then_some(())
}

/// 查询 mihomo /proxies，获取主策略组当前激活的代理节点名以及 GLOBAL 组当前的选中项。
async fn get_mihomo_active_node_and_global_now(
    app: &AppHandle,
) -> Option<(String, Option<String>)> {
    let (client, base, secret) = mihomo_base_api(app)?;
    let url = format!("{base}/proxies");
    let mut req = client.get(&url);
    if !secret.is_empty() {
        req = req.bearer_auth(&secret);
    }
    let resp = req.send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body: serde_json::Value = resp.json().await.ok()?;
    let proxies = body.get("proxies")?.as_object()?;
    select_global_candidate(proxies)
}

/// 通过 mihomo REST API 设置策略组的选中项。
async fn set_mihomo_proxy_group(app: &AppHandle, group: &str, name: &str) -> Option<()> {
    let (client, base, secret) = mihomo_base_api(app)?;
    let url = format!("{base}/proxies/{group}");
    let mut req = client.put(&url).json(&serde_json::json!({ "name": name }));
    if !secret.is_empty() {
        req = req.bearer_auth(&secret);
    }
    let resp = req.send().await.ok()?;
    resp.status().is_success().then_some(())
}

/// 全局互斥锁，确保并发的订阅下载任务在尝试临时切换 Mihomo global 模式时不发生竞态。
static GLOBAL_MODE_LOCK: std::sync::LazyLock<std::sync::Arc<tokio::sync::Mutex<()>>> =
    std::sync::LazyLock::new(|| std::sync::Arc::new(tokio::sync::Mutex::new(())));

/// 全局 DNS 信号量，限制并发阻塞式 DNS 解析任务最多为 8 个，防止并发刷新时占满 Tokio 阻塞线程池。
static DNS_SEMAPHORE: std::sync::LazyLock<std::sync::Arc<tokio::sync::Semaphore>> =
    std::sync::LazyLock::new(|| std::sync::Arc::new(tokio::sync::Semaphore::new(8)));

/// 缓存的系统代理探测结果项。
struct SysProxyCacheEntry {
    cached_at: std::time::Instant,
    proxy: Option<String>,
}

/// 系统代理发现互斥锁与缓存，限制全应用同时最多仅有 1 个系统代理发现任务在执行，
/// 避免并发刷新时累积阻塞 worker 或系统子进程，并缓存最近 5 秒内的探测结果。
static SYS_PROXY_DISCOVERY_LOCK: std::sync::LazyLock<std::sync::Arc<tokio::sync::Mutex<()>>> =
    std::sync::LazyLock::new(|| std::sync::Arc::new(tokio::sync::Mutex::new(())));
static SYS_PROXY_CACHE: std::sync::LazyLock<std::sync::RwLock<Option<SysProxyCacheEntry>>> =
    std::sync::LazyLock::new(|| std::sync::RwLock::new(None));

async fn get_bounded_sys_proxy_address(timeout_dur: Duration) -> Option<String> {
    if let Ok(guard) = SYS_PROXY_CACHE.read() {
        if let Some(entry) = guard.as_ref() {
            if entry.cached_at.elapsed() < Duration::from_secs(5) {
                return entry.proxy.clone();
            }
        }
    }

    let overall_deadline = std::time::Instant::now() + timeout_dur;

    let rem_lock = overall_deadline.saturating_duration_since(std::time::Instant::now());
    if rem_lock.is_zero() {
        return None;
    }

    let lock_guard = tokio::time::timeout(rem_lock, SYS_PROXY_DISCOVERY_LOCK.clone().lock_owned())
        .await
        .ok()?;

    if let Ok(guard) = SYS_PROXY_CACHE.read() {
        if let Some(entry) = guard.as_ref() {
            if entry.cached_at.elapsed() < Duration::from_secs(5) {
                return entry.proxy.clone();
            }
        }
    }

    let rem_task = overall_deadline.saturating_duration_since(std::time::Instant::now());
    if rem_task.is_zero() {
        return None;
    }

    let handle = tokio::task::spawn_blocking(move || {
        let _held_lock = lock_guard;
        let res = crate::sys_proxy::get_sys_proxy_address_with_deadline(overall_deadline);
        let completed = res.is_some()
            || (std::time::Instant::now() + Duration::from_millis(100) < overall_deadline);
        if completed {
            if let Ok(mut guard) = SYS_PROXY_CACHE.write() {
                *guard = Some(SysProxyCacheEntry {
                    cached_at: std::time::Instant::now(),
                    proxy: res.clone(),
                });
            }
        }
        res
    });

    tokio::time::timeout(rem_task, handle)
        .await
        .ok()
        .and_then(Result::ok)
        .flatten()
}

/// 执行单项 Mihomo 状态恢复的重试逻辑。
/// 返回 (是否成功, 是否因时间不足且未尝试而 defer 给 drop guard)。
async fn retry_restore_step<F, Fut>(
    deadline: Option<std::time::Instant>,
    mut action: F,
) -> (bool, bool)
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Option<()>>,
{
    let mut ok = false;
    let mut deferred = false;
    for attempt in 0..2 {
        let call_timeout = if let Some(dl) = deadline {
            let rem = dl.saturating_duration_since(std::time::Instant::now());
            if rem < Duration::from_millis(300) {
                if attempt == 0 {
                    deferred = true;
                }
                break;
            }
            Duration::from_millis(1000).min(rem)
        } else {
            Duration::from_millis(1000)
        };

        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }

        if tokio::time::timeout(call_timeout, action())
            .await
            .ok()
            .flatten()
            .is_some()
        {
            ok = true;
            break;
        }
    }
    (ok, deferred)
}

/// 恢复 Mihomo 的原模式和原 GLOBAL 策略组选择。
/// 支持在 inline 流程中受 deadline 约束，若时间耗尽则提前退出，由 `ModeRestoreGuard` 的 `Drop` 实现接管在后台异步完成。
async fn restore_mihomo_state(
    app: &AppHandle,
    orig_global_now: &mut Option<String>,
    orig_mode: &mut Option<String>,
    deadline: Option<std::time::Instant>,
    on_drop: bool,
    core_started_at: Option<std::time::Instant>,
) {
    let check_core_alive = || -> bool {
        if let Some(expected_started_at) = core_started_at {
            let state = app.state::<MihomoState>();
            let guard = state
                .0
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if guard.started_at() != Some(expected_started_at) {
                return false;
            }
        }
        true
    };

    if !check_core_alive() {
        let _ = remove_global_mode_restore_marker(app);
        *orig_mode = None;
        *orig_global_now = None;
        return;
    }

    if mihomo_base_api(app).is_none() {
        return;
    }

    let configured_mode = app.try_state::<crate::SettingsState>().and_then(|st| {
        let s = st.0.lock().ok()?;
        s.mode.clone()
    });
    // Only reconcile a recorded mode restore against the configured mode.
    // When `orig_mode` is None, this flow never switched the mode, so it must not change it.
    let target_mode = orig_mode.clone().map(|recorded| {
        configured_mode
            .as_deref()
            .and_then(canonicalize_mode)
            .map(String::from)
            .or_else(|| canonicalize_mode(&recorded).map(String::from))
            .unwrap_or(recorded)
    });
    let mut mode_is_safe = target_mode.is_none();

    // 1. 先恢复原模式（如 rule），使用户常规流量立即脱离 global 路由
    if let Some(target) = target_mode.as_deref() {
        if target.eq_ignore_ascii_case("global") {
            mode_is_safe = true;
            *orig_mode = None;
        } else {
            let (ok, deferred) = retry_restore_step(deadline, || async {
                if !check_core_alive() {
                    return None;
                }
                set_mihomo_mode(app, target).await
            })
            .await;

            if !check_core_alive() {
                let _ = remove_global_mode_restore_marker(app);
                *orig_mode = None;
                *orig_global_now = None;
                return;
            }

            mode_is_safe = ok;
            if ok {
                *orig_mode = None;
            } else if on_drop {
                crate::emit_warn!(
                    Core,
                    CORE_MODE_RESTORE_DROPPED,
                    "Failed to restore mihomo mode '{target}' on drop"
                );
            } else if !deferred {
                crate::emit_warn!(
                    Core,
                    CORE_MODE_RESTORE_FAILED,
                    "Failed to restore mihomo mode '{target}'"
                );
            }
        }
    }

    // 2. 模式恢复成功后再恢复原 GLOBAL 策略组选择。
    // 注意：若模式恢复未成功（仍停留在 global 模式），则跳过节点恢复，
    // 避免在 global 模式下将节点切换回原节点（如 DIRECT）导致流量直接直连泄露。
    if mode_is_safe && orig_mode.is_none() {
        if let Some(orig_node) = orig_global_now.as_deref() {
            if !check_core_alive() {
                let _ = remove_global_mode_restore_marker(app);
                *orig_mode = None;
                *orig_global_now = None;
                return;
            }

            let (ok, deferred) = retry_restore_step(deadline, || async {
                if !check_core_alive() {
                    return None;
                }
                set_mihomo_proxy_group(app, "GLOBAL", orig_node).await
            })
            .await;

            if !check_core_alive() {
                let _ = remove_global_mode_restore_marker(app);
                *orig_mode = None;
                *orig_global_now = None;
                return;
            }

            if ok {
                *orig_global_now = None;
            } else if on_drop {
                crate::emit_warn!(
                    Core,
                    CORE_GLOBAL_RESTORE_DROPPED,
                    "Failed to restore original GLOBAL proxy group selection '{orig_node}' on drop"
                );
            } else if !deferred {
                crate::emit_warn!(
                    Core,
                    CORE_GLOBAL_RESTORE_FAILED,
                    "Failed to restore original GLOBAL proxy group selection '{orig_node}'"
                );
            }
        }
    }

    // 3. 同步更新或移除持久化恢复标记
    if orig_mode.is_none() && orig_global_now.is_none() {
        let _ = remove_global_mode_restore_marker(app);
    } else if let Err(e) =
        write_global_mode_restore_marker(app, orig_mode.as_deref(), orig_global_now.as_deref())
    {
        crate::emit_warn!(
            Core,
            CORE_MODE_RESTORE_FAILED,
            "Failed to update global mode restore marker during restoration: {e}"
        );
    }
}

/// Name of the global-mode restore marker file (stored in app data dir).
const GLOBAL_MODE_RESTORE_FILE: &str = ".subscription-global-restore";
const GLOBAL_MODE_RESTORE_TMP_FILE: &str = ".subscription-global-restore.tmp";

#[inline]
pub(crate) fn restore_marker_tmp_path(path: &std::path::Path) -> std::path::PathBuf {
    path.with_file_name(GLOBAL_MODE_RESTORE_TMP_FILE)
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct GlobalModeRestoreMarker {
    pub orig_mode: Option<String>,
    pub orig_global_now: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_config: Option<String>,
}

#[must_use]
pub fn global_mode_restore_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    super::resolve_app_paths(app)
        .ok()
        .map(|p| p.app_data_dir.join(GLOBAL_MODE_RESTORE_FILE))
}

pub fn write_global_mode_restore_marker(
    app: &AppHandle,
    orig_mode: Option<&str>,
    orig_global_now: Option<&str>,
) -> Result<(), String> {
    if orig_mode.is_none() && orig_global_now.is_none() {
        let _ = remove_global_mode_restore_marker(app);
        return Ok(());
    }
    let path = global_mode_restore_path(app)
        .ok_or_else(|| "Failed to resolve app data path for restore marker".to_owned())?;
    let active_config = app.try_state::<MihomoState>().and_then(|state| {
        state
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .last_config_path()
            .map(str::to_owned)
    });
    let marker = GlobalModeRestoreMarker {
        orig_mode: orig_mode.map(str::to_owned),
        orig_global_now: orig_global_now.map(str::to_owned),
        active_config,
    };
    let data = serde_json::to_string(&marker)
        .map_err(|e| format!("Failed to serialize restore marker: {e}"))?;
    let tmp_path = restore_marker_tmp_path(&path);
    let mut write_completed = false;
    let persisted = (|| -> std::io::Result<()> {
        let mut file = std::fs::File::create(&tmp_path)?;
        std::io::Write::write_all(&mut file, data.as_bytes())?;
        file.sync_all()?;
        drop(file);
        write_completed = true;
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt as _;
            let wide_from: Vec<u16> = std::ffi::OsStr::new(&tmp_path)
                .encode_wide()
                .chain(std::iter::once(0))
                .collect();
            let wide_to: Vec<u16> = std::ffi::OsStr::new(&path)
                .encode_wide()
                .chain(std::iter::once(0))
                .collect();
            // SAFETY: `wide_from` and `wide_to` are valid null-terminated wide strings
            // allocated in Rust memory, and MoveFileExW is called with valid flags to
            // atomically replace the destination without destroying either file on failure.
            let res = unsafe {
                windows_sys::Win32::Storage::FileSystem::MoveFileExW(
                    wide_from.as_ptr(),
                    wide_to.as_ptr(),
                    windows_sys::Win32::Storage::FileSystem::MOVEFILE_REPLACE_EXISTING
                        | windows_sys::Win32::Storage::FileSystem::MOVEFILE_WRITE_THROUGH,
                )
            };
            if res == 0 {
                return Err(std::io::Error::last_os_error());
            }
        }
        #[cfg(not(windows))]
        std::fs::rename(&tmp_path, &path)?;
        #[cfg(unix)]
        if let Some(parent) = path.parent() {
            if let Ok(dir) = std::fs::File::open(parent) {
                let _ = dir.sync_all();
            }
        }
        Ok(())
    })();
    if let Err(e) = persisted {
        if !write_completed {
            let _ = std::fs::remove_file(&tmp_path);
        }
        crate::emit_warn!(
            Core,
            CORE_MODE_RESTORE_FAILED,
            "Failed to persist mihomo restore marker: {e}"
        );
        return Err(e.to_string());
    }
    Ok(())
}

pub fn remove_global_mode_restore_marker(app: &AppHandle) -> Result<(), String> {
    if let Some(path) = global_mode_restore_path(app) {
        let tmp_path = restore_marker_tmp_path(&path);
        if tmp_path.exists() {
            let _ = std::fs::remove_file(&tmp_path);
        }
        if path.exists() {
            if let Err(e) = std::fs::remove_file(&path) {
                let _ = std::fs::write(&path, b"");
                crate::emit_warn!(
                    Core,
                    CORE_MODE_RESTORE_FAILED,
                    "Failed to remove mihomo restore marker at {}: {e}",
                    path.display()
                );
                return Err(e.to_string());
            }
        }
    }
    Ok(())
}

#[must_use]
pub fn read_global_mode_restore_marker(app: &AppHandle) -> Option<GlobalModeRestoreMarker> {
    let path = global_mode_restore_path(app)?;
    let (data, used_path) = match std::fs::read_to_string(&path) {
        Ok(d) if !d.trim().is_empty() => (d, path.clone()),
        _ => {
            let tmp_path = restore_marker_tmp_path(&path);
            let tmp_data = std::fs::read_to_string(&tmp_path).ok()?;
            if tmp_data.trim().is_empty() {
                let _ = std::fs::remove_file(tmp_path);
                return None;
            }
            (tmp_data, tmp_path)
        }
    };
    let Ok(marker): Result<GlobalModeRestoreMarker, _> = serde_json::from_str(&data) else {
        let _ = std::fs::remove_file(used_path);
        return None;
    };
    if marker.orig_mode.is_none() && marker.orig_global_now.is_none() {
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(restore_marker_tmp_path(&path));
        return None;
    }
    Some(marker)
}

async fn reconcile_global_mode_restore_inner(
    app: &AppHandle,
    deadline: Option<std::time::Instant>,
) {
    let Some(marker) = read_global_mode_restore_marker(app) else {
        return;
    };

    let mut orig_mode = marker.orig_mode;
    let mut orig_global_now = marker.orig_global_now;

    if let Some(marker_cfg) = marker.active_config {
        let current_cfg = app.try_state::<MihomoState>().and_then(|state| {
            state
                .0
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .last_config_path()
                .map(str::to_owned)
        });
        if let Some(curr) = current_cfg {
            if curr != marker_cfg {
                // Active profile changed across restart or core start.
                // The GLOBAL selection is profile-specific, so drop it.
                // The mode is core-wide, so still restore it below.
                orig_global_now = None;
            }
        }
    }

    let configured_mode = app.try_state::<crate::SettingsState>().and_then(|st| {
        let s = st.0.lock().ok()?;
        s.mode.clone()
    });
    if let Some(cfg_mode) = configured_mode {
        if orig_mode.as_ref().is_some_and(|m| {
            let m_norm = canonicalize_mode(m).unwrap_or(m.as_str());
            let cfg_norm = canonicalize_mode(&cfg_mode).unwrap_or(cfg_mode.as_str());
            !m_norm.eq_ignore_ascii_case(cfg_norm)
        }) {
            // The user changed the configured mode after the marker was written.
            // Drop the stale mode restore, but still restore the GLOBAL selection.
            orig_mode = None;
        }
    }

    if orig_mode.is_none() && orig_global_now.is_none() {
        let _ = remove_global_mode_restore_marker(app);
        return;
    }

    let core_started_at = app.try_state::<MihomoState>().and_then(|state| {
        state
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .started_at()
    });

    restore_mihomo_state(
        app,
        &mut orig_global_now,
        &mut orig_mode,
        deadline,
        false,
        core_started_at,
    )
    .await;
}

/// Reconcile and restore any un-restored global mode / GLOBAL selection marker left by an abrupt termination.
/// Returns `true` if reconciliation finished or was not needed, and `false` if acquiring `GLOBAL_MODE_LOCK` timed out.
pub async fn reconcile_global_mode_restore(app: &AppHandle) -> bool {
    reconcile_global_mode_restore_with_deadline(
        app,
        std::time::Instant::now() + Duration::from_secs(5),
    )
    .await
}

/// Reconcile with an explicit cumulative deadline.
pub async fn reconcile_global_mode_restore_with_deadline(
    app: &AppHandle,
    deadline: std::time::Instant,
) -> bool {
    if read_global_mode_restore_marker(app).is_none() {
        return true;
    }

    if mihomo_base_api(app).is_none() {
        return true;
    }

    let remaining = deadline.saturating_duration_since(std::time::Instant::now());
    if remaining.is_zero() {
        return false;
    }

    let Ok(lock_guard) = tokio::time::timeout(
        remaining.min(Duration::from_secs(5)),
        GLOBAL_MODE_LOCK.clone().lock_owned(),
    )
    .await
    else {
        return false;
    };

    reconcile_global_mode_restore_inner(app, Some(deadline)).await;

    drop(lock_guard);
    true
}

/// Drop guard: 在发出 mode 切换前先行构造 guard。
/// 即使后续的 `set_mihomo_mode`、`get_mihomo_active_node_and_global_now`、
/// `set_mihomo_proxy_group`、sleep 或 download 任务被超时取消（Cancel），
/// 也能在 drop 时恢复 core 的原模式和原节点选择，并在恢复执行期间持续持有互斥锁。
struct ModeRestoreGuard {
    app: tauri::AppHandle,
    orig_mode: Option<String>,
    orig_global_now: Option<String>,
    lock_guard: Option<tokio::sync::OwnedMutexGuard<()>>,
    core_started_at: Option<std::time::Instant>,
}

impl Drop for ModeRestoreGuard {
    fn drop(&mut self) {
        let app = self.app.clone();
        let mut orig_mode = self.orig_mode.take();
        let mut orig_global_now = self.orig_global_now.take();
        let lock_guard = self.lock_guard.take();
        let core_started_at = self.core_started_at;
        if orig_mode.is_some() || orig_global_now.is_some() {
            if let Ok(handle) = tokio::runtime::Handle::try_current() {
                handle.spawn(async move {
                    let _held_lock = lock_guard;
                    restore_mihomo_state(
                        &app,
                        &mut orig_global_now,
                        &mut orig_mode,
                        None,
                        true,
                        core_started_at,
                    )
                    .await;
                });
            } else {
                drop(lock_guard);
                crate::emit_warn!(
                    Core,
                    CORE_MODE_RESTORE_DROPPED,
                    "No Tokio runtime available in Drop; mihomo mode '{orig_mode:?}' and GLOBAL selection '{orig_global_now:?}' were not restored"
                );
            }
        }
    }
}

#[derive(serde::Serialize)]
pub struct DownloadSubResult {
    pub name: String,
    pub message: String,
}

fn append_error(acc: &mut String, msg: &str) {
    if !acc.is_empty() {
        acc.push_str(" | ");
    }
    acc.push_str(msg);
}

async fn do_download_stream(
    client: &reqwest::Client,
    url: &str,
) -> Result<(Vec<u8>, String, String, Option<String>), String> {
    let resp = client.get(url).send().await.map_err(|e| {
        if e.is_timeout() {
            format!("Request timeout: {e}")
        } else if e.is_connect() {
            format!("Connection failed: {e}")
        } else if e.is_request() {
            format!("Request error: {e}")
        } else if e.is_body() {
            format!("Body error: {e}")
        } else if e.is_decode() {
            format!("Decode error: {e}")
        } else {
            format!("Network error: {e}")
        }
    })?;

    if !resp.status().is_success() {
        let status = resp.status();
        let url_display = super::config_manager::mask_url(resp.url().as_ref());
        return Err(format!("HTTP {status} from {url_display}"));
    }

    if let Some(content_length) = resp.content_length() {
        if usize::try_from(content_length).unwrap_or(0) > MAX_RESPONSE_SIZE {
            return Err(format!(
                "Response too large: {content_length} bytes (max {MAX_RESPONSE_SIZE} bytes)"
            ));
        }
    }

    let sub_info_header = resp
        .headers()
        .get("subscription-userinfo")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("")
        .to_owned();

    // Persist the requested URL, not `resp.url()`. Redirect targets are often
    // one-time signed URLs that would break later subscription updates.
    let requested_url = url.to_owned();

    let disp_filename = resp
        .headers()
        .get("content-disposition")
        .and_then(|h| h.to_str().ok())
        .and_then(parse_content_disposition_filename);

    let bytes = read_response_body(resp).await?;

    Ok((bytes, sub_info_header, requested_url, disp_filename))
}

async fn try_global_mode_tier(
    app: &AppHandle,
    m_url: &str,
    url: &str,
    user_agent: Option<&str>,
    total_deadline: std::time::Instant,
) -> Result<(Vec<u8>, String, String, Option<String>), String> {
    let remaining = total_deadline.saturating_duration_since(std::time::Instant::now());
    if remaining < Duration::from_millis(3000) {
        return Err("Global-mode: Skipped due to deadline exhaustion".to_owned());
    }

    let lock_wait = remaining.min(Duration::from_millis(1500));
    let lock_guard = tokio::time::timeout(lock_wait, GLOBAL_MODE_LOCK.clone().lock_owned())
        .await
        .map_err(|_timeout| "Global-mode: Skipped due to lock contention".to_owned())?;

    // If an unrestored recovery marker exists from an earlier abnormal termination,
    // reconcile it first under the held mutex before observing current state.
    if read_global_mode_restore_marker(app).is_some() {
        reconcile_global_mode_restore_inner(app, Some(total_deadline)).await;
        if read_global_mode_restore_marker(app).is_some() {
            return Err("Global-mode: Pending recovery marker could not be reconciled".to_owned());
        }
    }

    let orig_mode = get_mihomo_mode(app)
        .await
        .ok_or_else(|| "Global-mode: Failed to get current Mihomo mode".to_owned())?;

    let (active_node, global_now) = get_mihomo_active_node_and_global_now(app)
        .await
        .ok_or_else(|| "Global-mode: No eligible proxy node found in GLOBAL group".to_owned())?;

    let orig_global_now = global_now.ok_or_else(|| {
        "Global-mode: Original GLOBAL proxy group selection is unknown".to_owned()
    })?;

    let need_mode_switch = orig_mode != "global";
    let need_node_switch = orig_global_now != active_node;

    if !need_mode_switch && !need_node_switch {
        return Err("Global-mode: Already in global mode with active node selected".to_owned());
    }

    // Re-check cumulative deadline before mutating any core state
    let rem_before_mutate = total_deadline.saturating_duration_since(std::time::Instant::now());
    if rem_before_mutate < Duration::from_millis(2800) {
        return Err("Global-mode: Skipped due to deadline exhaustion".to_owned());
    }

    let core_started_at = {
        let state = app.state::<MihomoState>();
        let guard = state
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        guard.started_at()
    };

    let mut restore_guard = ModeRestoreGuard {
        app: app.clone(),
        orig_mode: None,
        orig_global_now: None,
        lock_guard: Some(lock_guard),
        core_started_at,
    };

    // 在修改 Mihomo 状态前，先持久化恢复标记至磁盘。
    // 这样即便进程遭遇 SIGKILL、崩溃中止或意外掉电，
    // 下次启动时也能比自动更新更早读到标记并恢复原始模式与节点。
    if let Err(e) = write_global_mode_restore_marker(
        app,
        need_mode_switch.then_some(&orig_mode),
        need_node_switch.then_some(&orig_global_now),
    ) {
        crate::emit_warn!(
            Core,
            CORE_MODE_RESTORE_FAILED,
            "Skipping global-mode fallback: failed to persist recovery marker: {e}"
        );
        return Err(format!(
            "Global-mode: Failed to persist recovery marker: {e}"
        ));
    }

    if need_node_switch {
        // 先在原模式下切换 GLOBAL 策略组的目标节点；
        // 若切换失败，尚未进入 global 模式，用户当前流量不会受到任何影响。
        restore_guard.orig_global_now = Some(orig_global_now);
        if set_mihomo_proxy_group(app, "GLOBAL", &active_node)
            .await
            .is_none()
        {
            crate::emit_warn!(
                Core,
                CORE_GLOBAL_SWITCH_FAILED,
                "Failed to switch GLOBAL proxy group to '{active_node}'"
            );
            return Err(format!(
                "Global-mode: Failed to select node '{active_node}'"
            ));
        }
    }

    if need_mode_switch {
        restore_guard.orig_mode = Some(orig_mode);
        if set_mihomo_mode(app, "global").await.is_none() {
            return Err("Global-mode: Failed to switch Mihomo mode to global".to_owned());
        }
    }

    // 切换后短暂等待 mihomo 生效
    tokio::time::sleep(Duration::from_millis(150)).await;

    let rem_dl = total_deadline.saturating_duration_since(std::time::Instant::now());
    // Reserve at least 2000ms for state restoration and downstream Tier 4 (ambient proxy)
    let downstream_reserve = Duration::from_millis(2000);
    let usable_dl = rem_dl.saturating_sub(downstream_reserve);
    let (conn_to, req_to) = if usable_dl < Duration::from_millis(800) {
        return Err("Global-mode: Skipped due to deadline exhaustion".to_owned());
    } else {
        (
            Duration::from_millis(1500).min(usable_dl),
            Duration::from_millis(5000).min(usable_dl),
        )
    };

    let client =
        build_http_client_with_proxy(user_agent, None, Some(m_url.to_owned()), conn_to, req_to)
            .map_err(|e| format!("Global-mode client build: {e}"))?;

    let download_res = do_download_stream(&client, url).await;

    // 正常流程：尝试恢复原模式和策略组选择。
    // 传递 restore_guard 字段的可变引用，成功恢复的字段会被置为 None；
    // 若在 inline 恢复执行期间任务被取消，guard 内部尚未恢复的字段完好无损，
    // Drop 守卫将在后台继续接管恢复，并在恢复期间继续持有互斥锁。
    restore_mihomo_state(
        app,
        &mut restore_guard.orig_global_now,
        &mut restore_guard.orig_mode,
        Some(total_deadline),
        false,
        core_started_at,
    )
    .await;
    drop(restore_guard);

    download_res.map_err(|e| format!("Global-mode: {e}"))
}

fn is_same_loopback_proxy_endpoint(amb: &str, mihomo: &str) -> bool {
    if amb == mihomo {
        return true;
    }
    if let (Ok(u1), Ok(u2)) = (url::Url::parse(amb), url::Url::parse(mihomo)) {
        let p1 = u1.port_or_known_default();
        let p2 = u2.port_or_known_default();
        if p1 == p2 && p1.is_some() {
            let h1 = u1.host_str().unwrap_or("");
            let h2 = u2.host_str().unwrap_or("");
            let is_loop1 =
                h1.eq_ignore_ascii_case("localhost") || h1 == "127.0.0.1" || h1 == "[::1]";
            let is_loop2 =
                h2.eq_ignore_ascii_case("localhost") || h2 == "127.0.0.1" || h2 == "[::1]";
            if is_loop1 && is_loop2 {
                return true;
            }
        }
    }
    false
}

pub(crate) async fn download_sub_inner(
    app: &AppHandle,
    url: String,
    name: String,
    user_agent: Option<String>,
    overwrite: bool,
) -> Result<DownloadSubResult, String> {
    // Outer scheduler timeout is 15s. We set a cumulative internal budget of 12.0s
    // across reconciliation, all tiers, and DNS resolution to guarantee completion, cleanup,
    // YAML parsing, and transactional file saving before outer scheduler cancellation (leaving a 3.0s margin).
    let total_deadline = std::time::Instant::now() + Duration::from_millis(12000);
    // Cap reconciliation work to 2500ms so lock contention cannot consume the shared budget
    // needed by downstream download tiers.
    let reconcile_deadline = std::time::Instant::now() + Duration::from_millis(2500);
    let _ =
        reconcile_global_mode_restore_with_deadline(app, reconcile_deadline.min(total_deadline))
            .await;
    download_sub_inner_raw(app, url, name, user_agent, overwrite, total_deadline)
        .await
        .map_err(redact_url_in_string)
}

#[allow(clippy::cognitive_complexity)]
async fn download_sub_inner_raw(
    app: &AppHandle,
    url: String,
    name: String,
    user_agent: Option<String>,
    overwrite: bool,
    total_deadline: std::time::Instant,
) -> Result<DownloadSubResult, String> {
    let safe_name = validate_subscription_name(&name).map_err(|e| e.to_string())?;

    let (host, port, user_entered_private) = validate_subscription_url_basic(&url)?;

    let is_single_label_host = {
        let trimmed = host.trim();
        let normalized = trimmed.strip_suffix('.').unwrap_or(trimmed);
        let unbracketed = normalized
            .strip_prefix('[')
            .and_then(|h| h.strip_suffix(']'))
            .unwrap_or(normalized);
        !unbracketed.contains('.') && unbracketed.parse::<std::net::IpAddr>().is_err()
    };

    // For user-entered private addresses, skip DNS pinning (proxy/system handles resolution).
    // For public addresses, resolve and pin DNS to prevent DNS rebinding for direct connections.
    // If DNS resolution fails (e.g. host is blocked by GFW / NXDOMAIN)
    // or times out (unresponsive DNS / packet drop), record the error and bypass direct connection,
    // falling through to proxy. (Note: responses resolving to private/loopback IPs are rejected
    // immediately as SSRF blocks rather than falling through to proxy.)
    let mut direct_dns_error = None;
    let resolve_pin = if user_entered_private {
        None
    } else {
        let remaining = total_deadline.saturating_duration_since(std::time::Instant::now());
        if remaining < Duration::from_millis(1000) {
            if is_single_label_host {
                return Err(format!(
                    "Single-label host '{host}' resolution skipped due to deadline exhaustion"
                ));
            }
            direct_dns_error = Some("Skipped DNS resolution due to deadline exhaustion".to_owned());
            None
        } else {
            let dns_timeout = Duration::from_millis(1500).min(remaining);
            let host_clone = host.clone();
            let resolve_future = async {
                let deadline = tokio::time::Instant::now() + dns_timeout;
                let permit = tokio::time::timeout_at(deadline, DNS_SEMAPHORE.clone().acquire_owned())
                    .await
                    .map_err(|_err| {
                        format!("DNS resolution timed out waiting for permit for '{host}' ({dns_timeout:?})")
                    })?
                    .map_err(|e| e.to_string())?;

                let remaining_dns = deadline.saturating_duration_since(tokio::time::Instant::now());
                if remaining_dns.is_zero() {
                    drop(permit);
                    return Err(format!(
                        "DNS resolution timed out for '{host}' ({dns_timeout:?})"
                    ));
                }

                let (tx, rx) = tokio::sync::oneshot::channel();
                let handle = tokio::task::spawn_blocking(move || {
                    let _permit = permit;
                    let res =
                        std::net::ToSocketAddrs::to_socket_addrs(&format!("{host_clone}:{port}"))
                            .map(std::iter::Iterator::collect::<Vec<_>>);
                    let _ = tx.send(res);
                });
                let abort_handle = handle.abort_handle();
                tokio::select! {
                    res = rx => {
                        match res {
                            Ok(Ok(addrs)) => Ok(addrs),
                            Ok(Err(e)) => Err(format!("DNS resolution failed for '{host}': {e}")),
                            Err(_) => Err(format!("DNS resolution task cancelled for '{host}'")),
                        }
                    },
                    _ = tokio::time::sleep_until(deadline) => {
                        abort_handle.abort();
                        Err(format!("DNS resolution timed out for '{host}' ({dns_timeout:?})"))
                    }
                }
            };

            match resolve_future.await {
                Ok(addrs) => {
                    if addrs.is_empty() {
                        if is_single_label_host {
                            return Err(format!(
                                "Single-label host '{host}' could not be resolved to any public IP address"
                            ));
                        }
                        direct_dns_error =
                            Some("Could not resolve any IP address for host".to_owned());
                        None
                    } else {
                        match zephyr_core::config::subscription::validate_public_host_addrs(
                            &host, &addrs,
                        ) {
                            Ok((_, Some(addr), _)) => Some((host.clone(), addr)),
                            Ok((_, None, _)) => {
                                if is_single_label_host {
                                    return Err(format!(
                                        "Single-label host '{host}' could not be resolved to any public IP address"
                                    ));
                                }
                                direct_dns_error =
                                    Some("Could not resolve any IP address for host".to_owned());
                                None
                            }
                            Err(
                                zephyr_core::config::subscription::PublicHostAddrError::SsrfBlocked(
                                    e,
                                ),
                            ) => {
                                // SSRF rejection is a security policy decision, not a transient transport failure.
                                // Reject immediately instead of retrying through proxy tiers.
                                return Err(e);
                            }
                            Err(e) => {
                                if is_single_label_host {
                                    return Err(format!(
                                        "Single-label host '{host}' failed validation: {e}"
                                    ));
                                }
                                direct_dns_error = Some(e.to_string());
                                None
                            }
                        }
                    }
                }
                Err(e) => {
                    if is_single_label_host {
                        return Err(format!(
                            "Single-label host '{host}' could not be resolved locally: {e}"
                        ));
                    }
                    direct_dns_error = Some(e);
                    None
                }
            }
        }
    };

    let has_mihomo = {
        let state = app.state::<MihomoState>();
        let guard = state
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        is_core_running_from_guard(&guard)
    };

    let get_tier_timeout = |max_total_ms: u64, max_conn_ms: u64| -> Option<(Duration, Duration)> {
        let remaining = total_deadline.saturating_duration_since(std::time::Instant::now());
        if remaining < Duration::from_millis(500) {
            return None;
        }
        let connect_timeout = Duration::from_millis(max_conn_ms).min(remaining);
        let request_timeout = Duration::from_millis(max_total_ms).min(remaining);
        Some((connect_timeout, request_timeout))
    };

    let mut last_error = String::new();
    let mut result: Option<(Vec<u8>, String, String, Option<String>)> = None;

    // Try direct connection first (if DNS resolution didn't fail)
    // 1. For user-entered private/LAN subscriptions, proxy tiers are not attempted, so allocate a full
    //    10000ms request window (4000ms connect timeout).
    // 2. For public subscriptions with Mihomo running, allocate 5500ms request (1500ms connect) so
    //    slow direct endpoints have adequate time to respond while blocked domains fast-fail on connect (1500ms)
    //    and leave ample budget (>= 6000ms) for proxy tiers.
    // 3. For public subscriptions with Mihomo stopped, allocate up to 7500ms (2500ms connect) to allow
    //    direct servers to succeed while still reserving at least 4000ms for ambient proxy fallbacks.
    let (direct_req_ms, direct_conn_ms) = if user_entered_private {
        (10000, 4000)
    } else if has_mihomo {
        (5500, 1500)
    } else {
        (7500, 2500)
    };

    let direct_error = if let Some(dns_err) = direct_dns_error {
        Some(format!("Direct DNS: {dns_err}"))
    } else if let Some((conn_to, req_to)) = get_tier_timeout(direct_req_ms, direct_conn_ms) {
        match build_http_client_with_proxy(
            user_agent.as_deref(),
            resolve_pin.as_ref(),
            None,
            conn_to,
            req_to,
        ) {
            Ok(client) => match do_download_stream(&client, &url).await {
                Ok(data) => {
                    result = Some(data);
                    None
                }
                Err(e) => Some(format!("Direct: {e}")),
            },
            Err(e) => Some(format!("Direct client build: {e}")),
        }
    } else {
        Some("Direct: Skipped due to deadline exhaustion".to_owned())
    };

    if result.is_none() {
        if let Some(de) = direct_error.as_deref() {
            append_error(&mut last_error, de);
        }

        // Only public subscription URLs fall back to proxy tiers.
        // User-entered private/LAN destinations and single-label hosts are strictly direct-only to prevent internal SSRF via proxies.
        if !user_entered_private && !is_single_label_host {
            // Resolve Mihomo mixed-port proxy and ambient (system / environment) proxy as distinct candidates.
            let mihomo_proxy_url = {
                let state = app.state::<MihomoState>();
                let guard = state
                    .0
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                let running = is_core_running_from_guard(&guard);
                let mut proxy_port = guard.last_proxy_port();
                drop(guard);
                let mut proxy_scheme = "http";
                if running {
                    if let Some((p, scheme)) =
                        super::resolve_app_paths(app).ok().and_then(|paths| {
                            let run_config_path = paths.core_dir.join("run_config.yaml");
                            let content = std::fs::read_to_string(&run_config_path).ok()?;
                            super::core_process::extract_configured_proxy_endpoint(&content)
                        })
                    {
                        proxy_port = Some(p);
                        proxy_scheme = scheme;
                    }
                }
                running
                    .then_some(proxy_port)
                    .flatten()
                    .map(|p| format!("{proxy_scheme}://127.0.0.1:{p}"))
            };

            // ── Tier 2: Mihomo proxy (mixed-port) ──────────────────────────────────
            if let Some(m_url) = &mihomo_proxy_url {
                let remaining_tier2 =
                    total_deadline.saturating_duration_since(std::time::Instant::now());
                // Reserve at least 4500ms for Tier 3 (global mode: >=3000ms) and Tier 4 (ambient: >=1500ms)
                let tier2_req_ms = remaining_tier2
                    .as_millis()
                    .saturating_sub(4500)
                    .clamp(1500, 5000) as u64;
                if let Some((conn_to, req_to)) = get_tier_timeout(tier2_req_ms, 1200) {
                    let client_proxy = build_http_client_with_proxy(
                        user_agent.as_deref(),
                        None,
                        Some(m_url.clone()),
                        conn_to,
                        req_to,
                    );
                    match client_proxy {
                        Ok(client) => match do_download_stream(&client, &url).await {
                            Ok(data) => {
                                result = Some(data);
                            }
                            Err(e) => {
                                append_error(&mut last_error, &format!("Proxy: {e}"));
                            }
                        },
                        Err(e) => {
                            append_error(&mut last_error, &format!("Proxy client build: {e}"));
                        }
                    }
                } else {
                    append_error(&mut last_error, "Proxy: Skipped due to deadline exhaustion");
                }

                // ── Tier 3: 临时切换 global 模式并选择可用节点重试 ──────────────────
                // 直连和普通代理（规则分流）都失败后，若使用的是 Mihomo 内核代理，
                // 尝试把 Mihomo 切到 global 模式并确保 GLOBAL 策略组选择当前活跃的代理节点，
                // 让所有流量走代理节点（绕过分流规则可能导致的不可达），
                // 下载完成后或任务中断时自动切回原模式和原策略组选择。
                // 使用全局异步互斥锁防止并发下载任务在全局模式切换和还原期间发生竞态。
                if result.is_none() {
                    match try_global_mode_tier(
                        app,
                        m_url,
                        &url,
                        user_agent.as_deref(),
                        total_deadline,
                    )
                    .await
                    {
                        Ok(data) => {
                            result = Some(data);
                        }
                        Err(err) => {
                            append_error(&mut last_error, &err);
                        }
                    }
                }
            }

            // ── Tier 4: 环境代理 / 系统代理回退 ──────────────────────────────────
            // 4. Ambient Proxy 兜底重试阶段：
            // 若 Mihomo 未启动，或 Mihomo 代理与全局模式均无法拉取订阅，
            // 则在存在且不与 Mihomo 重复的有效本地回环代理（系统代理及环境变量代理）中按优先级依次尝试重试。
            // 当目标主机匹配 NO_PROXY / no_proxy 时，遵循环境配置直接跳过该阶段。
            if result.is_none() {
                let parsed_sub_url = url::Url::parse(&url).ok();
                let sub_scheme = parsed_sub_url
                    .as_ref()
                    .map(|u| u.scheme().to_ascii_lowercase());
                let sub_host = parsed_sub_url.as_ref().and_then(|u| u.host_str());
                let sub_port = parsed_sub_url
                    .as_ref()
                    .and_then(url::Url::port_or_known_default);
                let remaining_override =
                    total_deadline.saturating_duration_since(std::time::Instant::now());
                let override_timeout = Duration::from_millis(400).min(remaining_override / 4);
                let sys_override = tokio::task::spawn_blocking(move || {
                    crate::sys_proxy::get_sys_proxy_override_bounded(override_timeout)
                })
                .await
                .ok()
                .flatten();
                let is_no_proxy = sub_host.is_some_and(|h| {
                    zephyr_core::config::is_destination_in_no_proxy(h, sub_port)
                        || sys_override.as_deref().is_some_and(|ov| {
                            zephyr_core::config::matches_no_proxy_rules_with_port(h, sub_port, ov)
                        })
                        || resolve_pin.as_ref().is_some_and(|(_, sa)| {
                            let ip_str = sa.ip().to_string();
                            zephyr_core::config::is_destination_in_no_proxy(&ip_str, sub_port)
                                || sys_override.as_deref().is_some_and(|ov| {
                                    zephyr_core::config::matches_no_proxy_rules_with_port(
                                        &ip_str, sub_port, ov,
                                    )
                                })
                        })
                });

                let remaining = total_deadline.saturating_duration_since(std::time::Instant::now());
                if !is_no_proxy && remaining >= Duration::from_millis(600) {
                    let sys_proxy_timeout = Duration::from_millis(500).min(remaining / 2);
                    let sys_proxy = get_bounded_sys_proxy_address(sys_proxy_timeout).await;

                    let mut ambient_candidates: Vec<String> = Vec::new();

                    if let Some(raw) = sys_proxy.as_deref() {
                        for sp in
                            zephyr_core::config::subscription::collect_ambient_proxy_urls_for_scheme(
                                raw,
                                sub_scheme.as_deref(),
                            )
                        {
                            if !ambient_candidates.contains(&sp) {
                                ambient_candidates.push(sp);
                            }
                        }
                    }

                    let env_keys: &[&str] = if sub_scheme.as_deref() == Some("https") {
                        &[
                            "HTTPS_PROXY",
                            "https_proxy",
                            "ALL_PROXY",
                            "all_proxy",
                            "HTTP_PROXY",
                            "http_proxy",
                        ]
                    } else {
                        &[
                            "HTTP_PROXY",
                            "http_proxy",
                            "ALL_PROXY",
                            "all_proxy",
                            "HTTPS_PROXY",
                            "https_proxy",
                        ]
                    };

                    for key in env_keys {
                        if let Ok(val) = std::env::var(key) {
                            for candidate in
                                zephyr_core::config::subscription::collect_ambient_proxy_urls_for_scheme(
                                    &val,
                                    sub_scheme.as_deref(),
                                )
                            {
                                if !ambient_candidates.contains(&candidate) {
                                    ambient_candidates.push(candidate);
                                }
                            }
                        }
                    }

                    ambient_candidates.retain(|cand| {
                        !mihomo_proxy_url
                            .as_ref()
                            .is_some_and(|m| is_same_loopback_proxy_endpoint(cand, m))
                    });

                    let total_cands = ambient_candidates.len();
                    for (idx, amb_url) in ambient_candidates.into_iter().enumerate() {
                        if result.is_some() {
                            break;
                        }
                        let cands_left = (total_cands - idx) as u64;
                        let rem =
                            total_deadline.saturating_duration_since(std::time::Instant::now());
                        let rem_ms = u64::try_from(rem.as_millis()).unwrap_or(u64::MAX);
                        let candidate_req_ms = if cands_left > 1 {
                            (rem_ms / cands_left).clamp(800, 5000)
                        } else {
                            rem_ms.min(5000)
                        };
                        let candidate_conn_ms = (candidate_req_ms / 2).clamp(500, 1500);

                        if let Some((conn_to, req_to)) =
                            get_tier_timeout(candidate_req_ms, candidate_conn_ms)
                        {
                            let client_ambient = build_http_client_with_proxy(
                                user_agent.as_deref(),
                                resolve_pin.as_ref(),
                                Some(amb_url),
                                conn_to,
                                req_to,
                            );
                            match client_ambient {
                                Ok(client) => match do_download_stream(&client, &url).await {
                                    Ok(data) => {
                                        result = Some(data);
                                        break;
                                    }
                                    Err(e) => {
                                        append_error(
                                            &mut last_error,
                                            &format!("Ambient Proxy: {e}"),
                                        );
                                    }
                                },
                                Err(e) => {
                                    append_error(
                                        &mut last_error,
                                        &format!("Ambient Proxy client build: {e}"),
                                    );
                                }
                            }
                        } else {
                            append_error(
                                &mut last_error,
                                "Ambient Proxy: Skipped due to deadline exhaustion",
                            );
                            break;
                        }
                    }
                }
            }
        }
    }

    // Multi-tier download strategy:
    // Tier 1: Direct connection with DNS pinning (SSRF protection).
    // Tier 2: Mihomo mixed-port proxy connection.
    // Tier 3: Mihomo global mode with active proxy node selection and auto-restoration.
    // Tier 4: Ambient proxy (system / environment proxy fallback).
    let (bytes, sub_info_header, requested_url, disp_filename) = result.ok_or_else(|| {
        if !last_error.is_empty() {
            last_error
        } else if let Some(de) = direct_error {
            de
        } else {
            "Network error occurred during download".to_owned()
        }
    })?;

    let mut content = String::from_utf8(bytes)
        .unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned());

    // Reject empty responses — typically caused by expired subscriptions,
    // server-side errors, or CDN edge returning an empty 200.
    if content.trim().is_empty() {
        return Err(
            "Subscription returned empty content. The subscription may have expired or the server is unavailable.".to_owned(),
        );
    }

    if !content.contains("proxies:") && !content.contains("port:") {
        if let Some(decoded) = try_decode_base64_content(&content) {
            content = decoded;
        }
    }

    if content.contains("proxies:") || content.contains("proxy-groups:") {
        // Quote short-id values before parsing to prevent scientific notation corruption
        content = quote_short_id_values(&content);

        match serde_yaml::from_str::<serde_yaml::Value>(&content) {
            Ok(mut yaml_val) => {
                // Use module-level function to remove dangerous keys
                remove_dangerous_keys(&mut yaml_val, false);

                content = serde_yaml::to_string(&yaml_val)
                    .map_err(|e| format!("Failed to serialize sanitized subscription: {e}"))?;
            }
            Err(e) => {
                return Err(format!("Invalid YAML structure in subscription: {e}"));
            }
        }
    } else if !content.trim().starts_with("http") && !content.trim().is_empty() {
        return Err(
            "The subscription content is neither a valid Clash YAML nor a supported node list"
                .to_owned(),
        );
    }

    let paths = ensure_app_storage(app)?;

    let mut clean_name = if safe_name.ends_with(".yaml") || safe_name.ends_with(".yml") {
        safe_name.clone()
    } else {
        format!("{safe_name}.yaml")
    };

    // Only apply enhanced naming (Content-Disposition / rules) for new subscriptions.
    // When updating (overwrite == true), always use the frontend-provided name directly.
    if !overwrite {
        let rule_name = extract_name_from_rules(&content);

        // Priority 1: Content-Disposition filename
        if let Some(dfn) = &disp_filename {
            let stem = if dfn.to_lowercase().ends_with(".yaml") {
                &dfn[..dfn.len() - 5]
            } else if dfn.to_lowercase().ends_with(".yml") {
                &dfn[..dfn.len() - 4]
            } else {
                dfn.as_str()
            };
            if !stem.is_empty() && stem.len() <= 64 {
                clean_name = format!("{stem}.yaml");
            }
        }
        // Priority 2: Rule-extracted name
        else if let Some(rn) = &rule_name {
            clean_name = format!("{rn}.yaml");
        }
    }

    clean_name = zephyr_core::config::sanitizer::sanitize_config_file_name(clean_name)
        .map_err(|e| e.to_string())?;

    // When overwrite is true (updating an existing subscription), write directly.
    // When false (adding a new subscription), auto-append numeric suffix to avoid collisions.
    if !overwrite && paths.profiles_dir.join(&clean_name).exists() {
        let stem = clean_name
            .strip_suffix(".yaml")
            .or_else(|| clean_name.strip_suffix(".yml"))
            .unwrap_or(&clean_name);
        let ext = clean_name.strip_prefix(stem).unwrap_or(".yaml");
        let mut max_suffix = 1u32;
        for dir_entry in std::fs::read_dir(&paths.profiles_dir)
            .ok()
            .into_iter()
            .flatten()
        {
            let entry = match dir_entry {
                Ok(e) => e,
                Err(_) => continue,
            };
            if let Some(entry_name) = entry.file_name().to_str() {
                if let Some(suffix_str) = entry_name
                    .strip_prefix(format!("{stem}-").as_str())
                    .and_then(|rest| rest.strip_suffix(ext))
                {
                    if let Ok(n) = suffix_str.parse::<u32>() {
                        max_suffix = max_suffix.max(n + 1);
                    }
                }
            }
        }
        clean_name = format!("{stem}-{max_suffix}{ext}");
    }

    let target_path = paths.profiles_dir.join(&clean_name);
    zephyr_core::config::sanitizer::validate_path_within_dir(&target_path, &paths.profiles_dir)
        .map_err(|e| e.to_string())?;

    let final_content = content;

    // Best-effort atomic config + metadata update (compensating transactions, not ACID):
    //   Overwrite: target -> backup, temp -> target, save_metadata, cleanup backup
    //   New:      temp -> target, save_metadata, remove target on failure
    // Crash between steps may leave .bak.<uuid> residuals — cleaned up at startup.
    //
    // The overwrite decision is made *under* the lock to prevent TOCTOU:
    // a concurrent delete/create between the pre-lock probe and the swap
    // would either abort the update or clobber a new file with no backup.

    // Use UUID suffix to avoid conflicts from concurrent updates or crash residuals
    let unique_id = uuid::Uuid::new_v4().to_string()[..8].to_owned();
    let temp_path = target_path.with_extension(format!("yaml.tmp.{unique_id}"));

    // Write new config to temp file (encrypt if setting is enabled)
    let encrypt = {
        let settings_state = app.state::<crate::SettingsState>();
        let settings = settings_state
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        settings.encrypt_configs
    };
    write_profile_file(&temp_path, &final_content, encrypt)?;

    // File swap + metadata RMW under lock to prevent cleanup_metadata_cache
    // from removing the metadata entry while the file is temporarily absent
    // (e.g. during overwrite, the target is briefly moved to a backup).
    let metadata_result = {
        let _guard = lock_metadata();

        // Decide overwrite-vs-new *under the lock*: the pre-lock probe can
        // be invalidated by a concurrent delete or create.
        let backup_path = if target_path.exists() {
            if !overwrite {
                // A config was created concurrently between the pre-lock
                // collision check and here. Refuse to clobber it.
                let _ = std::fs::remove_file(&temp_path);
                return Err(format!(
                    "A config named '{clean_name}' was created concurrently; please retry"
                ));
            }
            let bp = target_path.with_extension(format!("yaml.bak.{unique_id}"));
            std::fs::rename(&target_path, &bp).map_err(|e| {
                let _ = std::fs::remove_file(&temp_path);
                format!("Failed to backup existing config (update aborted): {e}")
            })?;
            Some(bp)
        } else {
            None
        };

        // Move temp to final path (same directory — rename is always atomic, no copy fallback)
        if let Err(e) = std::fs::rename(&temp_path, &target_path) {
            let _ = std::fs::remove_file(&temp_path);
            if let Some(bp) = backup_path.as_ref() {
                if bp.exists() {
                    let _ = std::fs::rename(bp, &target_path);
                }
            }
            return Err(format!("Failed to apply config file: {e}"));
        }

        let mut metadata = load_metadata(&paths);
        // Preserve existing auto_update_interval, per-subscription user_agent, and
        // URL only when updating an existing subscription — avoids silently
        // resetting user-configured settings if the URL changed mid-download.
        // For new subscriptions, any pre-existing entry under `clean_name` is
        // stale (e.g. an orphaned entry left by a failed delete) and must not
        // leak into the new subscription's metadata.
        let (preserved_interval, preserved_ua, preserved_url, preserved_sub_info) = if overwrite {
            metadata
                .configs
                .get(&clean_name)
                .map(|m| {
                    (
                        m.auto_update_interval,
                        m.user_agent.clone(),
                        m.url.clone(),
                        m.sub_info.clone(),
                    )
                })
                .unwrap_or_default()
        } else {
            (None, None, None, None)
        };
        metadata.configs.insert(
            clean_name.clone(),
            super::crypto::ConfigMetadata {
                url: preserved_url.or(Some(requested_url)),
                sub_info: if sub_info_header.is_empty() {
                    preserved_sub_info
                } else {
                    Some(sub_info_header)
                },
                last_updated: Some(
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_secs())
                        .unwrap_or(0),
                ),
                auto_update_interval: preserved_interval,
                user_agent: preserved_ua,
            },
        );
        match save_metadata(&paths, &metadata) {
            Ok(()) => Ok(()),
            Err(e) => {
                // Rollback under lock to prevent cleanup_metadata_cache
                // from removing the metadata entry while the file is
                // temporarily absent during rollback.
                if let Err(rm_err) = std::fs::remove_file(&target_path) {
                    emit_warn!(
                        Subscription,
                        SUB_UPDATE_FAILED,
                        "Rollback: failed to remove {clean_name}: {rm_err}"
                    );
                }
                if let Some(bp) = backup_path.as_ref() {
                    if bp.exists() {
                        if let Err(rn_err) = std::fs::rename(bp, &target_path) {
                            emit_warn!(
                                Subscription,
                                SUB_UPDATE_FAILED,
                                "Rollback: failed to restore {clean_name} from {:?}: {rn_err}",
                                bp
                            );
                        }
                    }
                }
                Err(e)
            }
        }
    };

    if let Err(e) = metadata_result {
        return Err(format!("Metadata save failed (config rolled back): {e}"));
    }

    // Success — clean up backup
    // (backup_path is derived from unique_id, so we can reconstruct it)
    let backup_path = target_path.with_extension(format!("yaml.bak.{unique_id}"));
    if backup_path.exists() {
        let _ = std::fs::remove_file(&backup_path);
    }

    Ok(DownloadSubResult {
        message: format!("Config saved as {clean_name}"),
        name: clean_name,
    })
}

fn log_sub_update_failure(name: &str, err: &str) {
    let code = classify_sub_error(err.to_owned());
    let redacted_err = redact_url_in_string(err.to_owned());
    crate::backend_event::emit_backend_event(&crate::backend_event::BackendEvent::error(
        crate::backend_event::BackendModule::Subscription,
        code,
        format!("Failed to update '{name}': {redacted_err}"),
    ));
}

/// Tauri command wrapper: single subscription download with rate limiting.
/// If `url` is None, the URL is resolved internally from metadata.
#[tauri::command]
pub async fn download_sub(
    app: AppHandle,
    name: String,
    url: Option<String>,
    user_agent: Option<String>,
    overwrite: Option<bool>,
    rate_limiter: State<'_, crate::RateLimiter>,
) -> Result<DownloadSubResult, String> {
    crate::rate_limit!(rate_limiter, "download_sub", 5000);
    let resolved_url = match resolve_url_from_metadata(&app, &name, url) {
        Ok(u) => u,
        Err(e) => {
            log_sub_update_failure(&name, &e);
            return Err(e);
        }
    };
    let result = download_sub_inner(
        &app,
        resolved_url,
        name.clone(),
        user_agent,
        overwrite.unwrap_or(false),
    )
    .await;

    if let Err(e) = &result {
        log_sub_update_failure(&name, e);
    }

    result
}

/// Batch update result for a single subscription.
#[derive(serde::Serialize)]
pub struct BatchUpdateResult {
    pub name: String,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Tauri command: batch update multiple subscriptions without per-item rate limiting.
/// Per-subscription UA (stored in metadata) takes priority over the provided global `user_agent`.
#[tauri::command]
pub async fn download_sub_batch(
    app: AppHandle,
    items: Vec<BatchUpdateItem>,
    user_agent: Option<String>,
) -> Result<Vec<BatchUpdateResult>, String> {
    // Load metadata once to resolve per-subscription UA overrides
    let paths = ensure_app_storage(&app)?;
    let metadata = load_metadata(&paths);

    let mut results = Vec::with_capacity(items.len());
    for item in items {
        let name = item.name.clone();
        let resolved_url = match resolve_url_from_metadata(&app, &name, item.url) {
            Ok(u) => u,
            Err(e) => {
                log_sub_update_failure(&name, &e);
                results.push(BatchUpdateResult {
                    name,
                    success: false,
                    error: Some(redact_url_in_string(e)),
                });
                continue;
            }
        };
        // Per-subscription UA takes priority over global user_agent
        let ua_for_this = metadata
            .configs
            .get(&name)
            .and_then(|m| m.user_agent.as_ref().filter(|s| !s.is_empty()).cloned())
            .or_else(|| user_agent.clone());
        let result = download_sub_inner(&app, resolved_url, name.clone(), ua_for_this, true).await;
        match result {
            Ok(_) => results.push(BatchUpdateResult {
                name,
                success: true,
                error: None,
            }),
            Err(e) => {
                log_sub_update_failure(&name, &e);
                results.push(BatchUpdateResult {
                    name,
                    success: false,
                    error: Some(e),
                });
            }
        }
    }
    Ok(results)
}

/// Input item for batch subscription update.
#[derive(serde::Deserialize)]
pub struct BatchUpdateItem {
    /// If None, the URL is resolved internally from metadata.
    pub url: Option<String>,
    pub name: String,
}

#[tauri::command]
pub async fn fetch_text(url: String) -> Result<String, String> {
    fetch_url_content(&url, None).await.map_err(|e| {
        crate::emit_error!(
            Subscription,
            SUB_NETWORK_ERROR,
            "fetch_text failed for '{url}': {e}"
        );
        "Network error occurred during fetch".to_owned()
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use zephyr_core::config::subscription::{
        is_private_host, is_private_ip, quote_short_id_values, validate_public_host_addrs,
        validate_subscription_name, validate_subscription_url_with_ip,
    };

    #[test]
    fn test_is_private_ip_v4() {
        assert!(is_private_ip("10.0.0.1".parse().unwrap()));
        assert!(is_private_ip("172.16.0.1".parse().unwrap()));
        assert!(is_private_ip("192.168.1.1".parse().unwrap()));
        assert!(is_private_ip("127.0.0.1".parse().unwrap()));
        assert!(is_private_ip("169.254.1.1".parse().unwrap()));
        assert!(is_private_ip("0.0.0.0".parse().unwrap()));
        assert!(!is_private_ip("8.8.8.8".parse().unwrap()));
        assert!(!is_private_ip("1.1.1.1".parse().unwrap()));
    }

    #[test]
    fn test_is_private_ip_v6() {
        assert!(is_private_ip("::1".parse().unwrap()));
        assert!(is_private_ip("::".parse().unwrap()));
        assert!(is_private_ip("fc00::1".parse().unwrap()));
        assert!(is_private_ip("fe80::1".parse().unwrap()));
        assert!(!is_private_ip("2001:4860:4860::8888".parse().unwrap()));
    }

    #[test]
    fn test_is_private_host() {
        // Allowed local hostname patterns
        assert!(is_private_host("localhost"));
        assert!(is_private_host("my.localhost"));
        assert!(is_private_host("my.local"));
        // Private IPs
        assert!(is_private_host("127.0.0.1"));
        assert!(is_private_host("10.0.0.1"));
        assert!(is_private_host("192.168.1.1"));
        // NOT allowed: IANA reserved domains (stricter policy)
        assert!(!is_private_host("my.test"));
        assert!(!is_private_host("my.example"));
        assert!(!is_private_host("my.invalid"));
        // Public domains
        assert!(!is_private_host("example.com"));
        assert!(!is_private_host("8.8.8.8"));
    }

    #[test]
    fn test_validate_subscription_name() {
        assert!(validate_subscription_name("my-config").is_ok());
        assert!(validate_subscription_name("config.yaml").is_ok());
        assert!(validate_subscription_name("").is_err());
        assert!(validate_subscription_name("../etc/passwd").is_err());
        assert!(validate_subscription_name("foo/bar").is_err());
        assert!(validate_subscription_name("foo\\bar").is_err());
        assert!(validate_subscription_name("a\0b").is_err());
    }

    #[test]
    fn test_validate_private_ip_allowed() {
        let result = validate_subscription_url_with_ip("http://192.168.1.2/sub");
        assert!(result.is_ok());
        let (host, resolved_addr, user_entered_private) = result.unwrap();
        assert_eq!(host, "192.168.1.2");
        assert!(
            resolved_addr.is_none(),
            "private host should not return a resolved addr"
        );
        assert!(user_entered_private);
    }

    #[test]
    fn test_validate_127001_allowed() {
        let result = validate_subscription_url_with_ip("http://127.0.0.1:8080/sub");
        assert!(result.is_ok());
        let (_, resolved_addr, user_entered_private) = result.unwrap();
        assert!(resolved_addr.is_none());
        assert!(user_entered_private);
    }

    #[test]
    fn test_validate_10_x_allowed() {
        let result = validate_subscription_url_with_ip("http://10.0.0.5/sub");
        assert!(result.is_ok());
        let (_, _, user_entered_private) = result.unwrap();
        assert!(user_entered_private);
    }

    #[test]
    fn test_validate_localhost_allowed() {
        let result = validate_subscription_url_with_ip("http://localhost/sub");
        assert!(result.is_ok());
        let (_, resolved_addr, user_entered_private) = result.unwrap();
        assert!(resolved_addr.is_none());
        assert!(user_entered_private);
    }

    #[test]
    fn test_validate_public_ip_returns_pin() {
        let result = validate_subscription_url_with_ip("http://8.8.8.8/sub");
        assert!(result.is_ok());
        let (host, resolved_addr, user_entered_private) = result.unwrap();
        assert_eq!(host, "8.8.8.8");
        assert!(
            resolved_addr.is_some(),
            "public IP should return a resolved addr for pinning"
        );
        assert!(!user_entered_private);
    }

    #[test]
    fn test_validate_invalid_schemes_rejected() {
        assert!(validate_subscription_url_with_ip("ftp://192.168.1.1/sub").is_err());
        assert!(validate_subscription_url_with_ip("file:///etc/passwd").is_err());
        assert!(validate_subscription_url_with_ip("javascript:alert(1)").is_err());
    }

    #[test]
    fn test_validate_no_host_rejected() {
        assert!(validate_subscription_url_with_ip("http:///sub").is_err());
    }

    #[test]
    fn test_public_host_with_public_ip_allowed() {
        let addrs: Vec<std::net::SocketAddr> = vec!["1.2.3.4:80".parse().unwrap()];
        let result = validate_public_host_addrs("example.com", &addrs);
        assert!(result.is_ok());
        let (_, resolved_addr, user_entered_private) = result.unwrap();
        assert!(resolved_addr.is_some());
        assert!(!user_entered_private);
    }

    #[test]
    fn test_public_host_resolving_to_private_ip_rejected() {
        let addrs: Vec<std::net::SocketAddr> = vec!["192.168.1.1:80".parse().unwrap()];
        let result = validate_public_host_addrs("attacker.com", &addrs);
        assert!(result.is_err());
        assert!(matches!(
            result.unwrap_err(),
            zephyr_core::config::PublicHostAddrError::SsrfBlocked(_)
        ));
    }

    #[test]
    fn test_public_host_resolving_to_loopback_rejected() {
        let addrs: Vec<std::net::SocketAddr> = vec!["127.0.0.1:80".parse().unwrap()];
        let result = validate_public_host_addrs("evil.com", &addrs);
        assert!(result.is_err());
    }

    #[test]
    fn test_public_host_resolving_to_link_local_rejected() {
        let addrs: Vec<std::net::SocketAddr> = vec!["169.254.1.1:80".parse().unwrap()];
        let result = validate_public_host_addrs("evil.com", &addrs);
        assert!(result.is_err());
    }

    #[test]
    fn test_public_host_mixed_ips_rejected() {
        let addrs: Vec<std::net::SocketAddr> = vec![
            "1.2.3.4:80".parse().unwrap(),
            "192.168.1.1:80".parse().unwrap(),
        ];
        let result = validate_public_host_addrs("dual-homed.com", &addrs);
        assert!(result.is_err());
    }

    #[test]
    fn test_public_host_empty_addrs_rejected() {
        let addrs: Vec<std::net::SocketAddr> = vec![];
        let result = validate_public_host_addrs("empty.com", &addrs);
        assert!(result.is_err());
        assert!(matches!(
            result.unwrap_err(),
            zephyr_core::config::PublicHostAddrError::NoAddresses(_)
        ));
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
    fn test_quote_short_id_values_nested() {
        let yaml = r#"
proxies:
  - name: "test"
    reality-opts:
      short-id: 34010e92
"#;
        let result = quote_short_id_values(yaml);
        assert!(result.contains(r#"short-id: "34010e92""#));
    }

    #[test]
    fn test_quote_short_id_values_multiple() {
        let yaml = r#"
proxies:
  - name: "p1"
    reality-opts:
      short-id: 03E60665
  - name: "p2"
    reality-opts:
      short-id: 34010e92
"#;
        let result = quote_short_id_values(yaml);
        assert!(result.contains(r#"short-id: "03E60665""#));
        assert!(result.contains(r#"short-id: "34010e92""#));
    }

    #[test]
    fn test_quote_short_id_values_preserves_original() {
        let yaml = r"short-id: 34010e92";
        let quoted = quote_short_id_values(yaml);
        let value: serde_yaml::Value = serde_yaml::from_str(&quoted).unwrap();
        assert_eq!(value.get("short-id").unwrap().as_str(), Some("34010e92"));
    }

    #[test]
    fn test_quote_short_id_values_roundtrip() {
        let yaml = r#"
proxies:
  - name: "test"
    reality-opts:
      short-id: 34010e92
"#;
        let quoted = quote_short_id_values(yaml);
        let value: serde_yaml::Value = serde_yaml::from_str(&quoted).unwrap();
        let serialized = serde_yaml::to_string(&value).unwrap();
        let reparsed: serde_yaml::Value = serde_yaml::from_str(&serialized).unwrap();
        let proxy = reparsed
            .get("proxies")
            .unwrap()
            .as_sequence()
            .unwrap()
            .first()
            .unwrap();
        let short_id = proxy.get("reality-opts").unwrap().get("short-id").unwrap();
        assert_eq!(short_id.as_str(), Some("34010e92"));
    }

    #[test]
    fn test_quote_short_id_values_no_false_match() {
        let yaml = r"not-short-id: 443";
        let result = quote_short_id_values(yaml);
        assert_eq!(result, r"not-short-id: 443");
    }

    #[test]
    fn test_quote_short_id_values_with_indent() {
        let yaml = "    short-id: 34010e92\n";
        let result = quote_short_id_values(yaml);
        assert!(result.contains(r#"short-id: "34010e92""#));
    }

    #[test]
    fn test_global_mode_restore_marker_serde() {
        let marker = super::GlobalModeRestoreMarker {
            orig_mode: Some("rule".to_owned()),
            orig_global_now: Some("Node1".to_owned()),
            active_config: Some("profile.yaml".to_owned()),
        };
        let serialized = serde_json::to_string(&marker).unwrap();
        let deserialized: super::GlobalModeRestoreMarker =
            serde_json::from_str(&serialized).unwrap();
        assert_eq!(marker, deserialized);

        let marker_mode_only = super::GlobalModeRestoreMarker {
            orig_mode: Some("rule".to_owned()),
            orig_global_now: None,
            active_config: None,
        };
        let serialized2 = serde_json::to_string(&marker_mode_only).unwrap();
        let deserialized2: super::GlobalModeRestoreMarker =
            serde_json::from_str(&serialized2).unwrap();
        assert_eq!(marker_mode_only, deserialized2);

        // Verify backward compatibility when active_config is missing in JSON
        let legacy_json = r#"{"orig_mode":"rule","orig_global_now":"Node1"}"#;
        let legacy_deserialized: super::GlobalModeRestoreMarker =
            serde_json::from_str(legacy_json).unwrap();
        assert_eq!(legacy_deserialized.orig_mode.as_deref(), Some("rule"));
        assert_eq!(
            legacy_deserialized.orig_global_now.as_deref(),
            Some("Node1")
        );
        assert_eq!(legacy_deserialized.active_config, None);
    }

    #[test]
    fn test_global_mode_restore_marker_from_tmp_file() {
        let temp_dir = tempfile::tempdir().unwrap();
        let marker_file = temp_dir.path().join(".subscription-global-restore");
        let tmp_file = temp_dir.path().join(".subscription-global-restore.tmp");

        let marker = super::GlobalModeRestoreMarker {
            orig_mode: Some("rule".to_owned()),
            orig_global_now: Some("NodeA".to_owned()),
            active_config: Some("run_config.yaml".to_owned()),
        };
        std::fs::write(&tmp_file, serde_json::to_string(&marker).unwrap()).unwrap();

        // When primary file doesn't exist, reading tmp retains recovery state
        assert!(!marker_file.exists());
        assert!(tmp_file.exists());
        let data = std::fs::read_to_string(&tmp_file).unwrap();
        let recovered: super::GlobalModeRestoreMarker = serde_json::from_str(&data).unwrap();
        assert_eq!(recovered, marker);
    }

    #[test]
    fn test_restore_marker_tmp_path_distinct() {
        let path = std::path::Path::new("/some/dir/.subscription-global-restore");
        let tmp = super::restore_marker_tmp_path(path);
        assert_ne!(path, tmp.as_path());
        assert_eq!(
            tmp.file_name().and_then(|s| s.to_str()),
            Some(".subscription-global-restore.tmp")
        );
    }
}

use std::time::Duration;
use tauri::{AppHandle, Manager as _, State};

use super::fetch_util::fetch_url_content;
use zephyr_core::config::sanitizer::remove_dangerous_keys_internal_pub as remove_dangerous_keys;
use zephyr_core::config::subscription::{
    classify_sub_error, extract_name_from_rules, is_private_host, is_private_ip,
    parse_content_disposition_filename, quote_short_id_values, redact_url_in_string,
    try_decode_base64_content, validate_subscription_name, validate_subscription_url_basic,
};

use super::core_process::ensure_app_storage;
use super::crypto::{load_metadata, lock_metadata, save_metadata, write_profile_file};
use super::{MihomoState, MAX_RESPONSE_SIZE};
#[allow(unused_imports)]
use crate::emit_warn;

fn build_http_client_with_proxy(
    user_agent: Option<&str>,
    resolve_pin: Option<(String, std::net::SocketAddr)>,
    proxy_url: Option<String>,
    connect_timeout: Duration,
    timeout: Duration,
) -> Result<reqwest::Client, String> {
    let is_proxied = proxy_url.is_some();
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
        // For direct connections, resolution failures are fatal.
        // For proxy connections, remote proxy handles resolution for blocked domains, so local
        // DNS resolution failures are tolerated, but if local resolution succeeds and resolves
        // to a private IP, it is strictly blocked.
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
                if !is_proxied {
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
        client_builder = client_builder.resolve(&host, addr);
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

/// 获取 mihomo API 的客户端、基础 URL 和 secret。
/// 失败时返回 None（核心未运行或端口未就绪）。
fn mihomo_base_api(app: &AppHandle) -> Option<(reqwest::Client, String, String)> {
    let (api_port, secret) = {
        let state = app.state::<MihomoState>();
        let guard = state
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        guard.process()?;
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

/// 通过 mihomo API 切换代理模式。失败时返回 None。
async fn set_mihomo_mode(app: &AppHandle, mode: &str) -> Option<()> {
    let (client, base, secret) = mihomo_base_api(app)?;
    let url = format!("{base}/configs");
    let mut req = client
        .patch(&url)
        .json(&serde_json::json!({ "mode": mode }));
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

    let global_obj = proxies.get("GLOBAL");
    let global_now = global_obj
        .and_then(|g| g.get("now"))
        .and_then(|n| n.as_str())
        .map(std::borrow::ToOwned::to_owned);

    let is_special_target = |s: &str| {
        matches!(
            s,
            "DIRECT" | "REJECT" | "REJECT-DROP" | "PASS" | "COMPATIBLE"
        )
    };

    let global_all: Vec<&str> = global_obj
        .and_then(|g| g.get("all"))
        .and_then(|a| a.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str()).collect())
        .unwrap_or_default();

    // 递归解析候选节点/策略组，确保最终生效的叶子节点不是 DIRECT / REJECT 等特殊目标。
    // 递归深度限制为 8 层以防止配置中存在循环依赖。
    let resolves_to_effective_proxy = |start_name: &str| -> bool {
        let mut curr = start_name;
        for _ in 0..8 {
            if is_special_target(curr) {
                return false;
            }
            if let Some(p_obj) = proxies.get(curr) {
                let p_type = p_obj.get("type").and_then(|t| t.as_str()).unwrap_or("");
                if p_type.eq_ignore_ascii_case("Selector")
                    || p_type.eq_ignore_ascii_case("URLTest")
                    || p_type.eq_ignore_ascii_case("Fallback")
                {
                    if let Some(next_now) = p_obj.get("now").and_then(|n| n.as_str()) {
                        curr = next_now;
                        continue;
                    }
                }
            }
            return !is_special_target(curr);
        }
        false
    };

    let is_valid_global_candidate = |s: &str| {
        (global_all.is_empty() || global_all.contains(&s)) && resolves_to_effective_proxy(s)
    };

    let active_node = global_now
        .as_deref()
        .filter(|n| is_valid_global_candidate(n))
        .map(std::borrow::ToOwned::to_owned)
        .or_else(|| {
            // Priority 1: Check active `now` of common selector/urltest/fallback groups.
            // If the group's `now` is in GLOBAL.all and resolves to a real proxy, prefer it.
            // If not, but the group itself is in GLOBAL.all and resolves to a real proxy, use the group name.
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

            // Priority 2: Look through GLOBAL's member list `all` for the first valid candidate.
            // This ensures the chosen node or group is recognized as a valid GLOBAL member
            // by Mihomo's PUT /proxies/GLOBAL API and actually routes through an active proxy.
            for &member_name in &global_all {
                if is_valid_global_candidate(member_name) {
                    return Some(member_name.to_owned());
                }
            }

            None
        })?;

    Some((active_node, global_now))
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

/// 全局 DNS 信号量，限制并发阻塞式 DNS 解析任务最多为 4 个，防止并发刷新时占满 Tokio 阻塞线程池。
static DNS_SEMAPHORE: std::sync::LazyLock<std::sync::Arc<tokio::sync::Semaphore>> =
    std::sync::LazyLock::new(|| std::sync::Arc::new(tokio::sync::Semaphore::new(4)));

#[derive(serde::Serialize)]
pub struct DownloadSubResult {
    pub name: String,
    pub message: String,
}

pub(crate) async fn download_sub_inner(
    app: &AppHandle,
    url: String,
    name: String,
    user_agent: Option<String>,
    overwrite: bool,
) -> Result<DownloadSubResult, String> {
    download_sub_inner_raw(app, url, name, user_agent, overwrite)
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
) -> Result<DownloadSubResult, String> {
    let safe_name = validate_subscription_name(&name).map_err(|e| e.to_string())?;

    let (host, port, user_entered_private) = validate_subscription_url_basic(&url)?;

    // Outer scheduler timeout is 15s. We set a cumulative internal budget of 11.5s
    // across all tiers and DNS resolution to guarantee completion, cleanup, YAML parsing,
    // and transactional file saving before outer scheduler cancellation.
    let total_deadline = std::time::Instant::now() + Duration::from_millis(11500);

    // For user-entered private addresses, skip DNS pinning (proxy/system handles resolution).
    // For public addresses, resolve and pin DNS to prevent DNS rebinding for direct connections.
    // If DNS resolution fails (e.g. host is blocked by GFW or DNS poisoned to private IP)
    // or times out (unresponsive DNS / packet drop), record the error and bypass direct connection,
    // falling through to proxy.
    let mut direct_dns_error = None;
    let resolve_pin = if user_entered_private {
        None
    } else {
        let remaining = total_deadline.saturating_duration_since(std::time::Instant::now());
        if remaining < Duration::from_millis(1000) {
            direct_dns_error = Some("Skipped DNS resolution due to deadline exhaustion".to_owned());
            None
        } else {
            let dns_timeout = Duration::from_millis(1500).min(remaining);
            let host_clone = host.clone();
            let resolve_future = async {
                let permit = DNS_SEMAPHORE
                    .clone()
                    .acquire_owned()
                    .await
                    .map_err(|e| e.to_string())?;
                let handle = tokio::task::spawn_blocking(move || {
                    let _permit = permit;
                    std::net::ToSocketAddrs::to_socket_addrs(&format!("{host_clone}:{port}"))
                        .map(std::iter::Iterator::collect::<Vec<_>>)
                });
                let abort_handle = handle.abort_handle();
                tokio::select! {
                    res = handle => match res {
                        Ok(Ok(addrs)) => Ok(addrs),
                        Ok(Err(e)) => Err(format!("DNS resolution failed for '{host}': {e}")),
                        Err(e) => Err(format!("DNS resolution task join error: {e}")),
                    },
                    _ = tokio::time::sleep(dns_timeout) => {
                        abort_handle.abort();
                        Err(format!("DNS resolution timed out for '{host}' ({dns_timeout:?})"))
                    }
                }
            };

            match resolve_future.await {
                Ok(addrs) => {
                    match zephyr_core::config::subscription::validate_public_host_addrs(
                        &host, &addrs,
                    ) {
                        Ok((_, Some(addr), _)) => Some((host.clone(), addr)),
                        Ok((_, None, _)) => {
                            direct_dns_error =
                                Some("Could not resolve any IP address for host".to_owned());
                            None
                        }
                        Err(e) => {
                            // SSRF rejection is a security policy decision, not a transient transport failure.
                            // Reject immediately instead of retrying through proxy tiers.
                            return Err(e);
                        }
                    }
                }
                Err(e) => {
                    direct_dns_error = Some(e);
                    None
                }
            }
        }
    };

    let do_download = |client: reqwest::Client, url: String| async move {
        let resp = client.get(&url).send().await.map_err(|e| {
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

        // Use original URL for metadata storage, not profile-web-page-url
        // profile-web-page-url often points to HTML pages, not the actual subscription endpoint
        let final_url = url.clone();

        // Try to extract filename from Content-Disposition header
        let disp_filename = resp
            .headers()
            .get("content-disposition")
            .and_then(|h| h.to_str().ok())
            .and_then(parse_content_disposition_filename);

        let bytes = read_response_body(resp).await?;

        Ok::<(Vec<u8>, String, String, Option<String>), String>((
            bytes,
            sub_info_header,
            final_url,
            disp_filename,
        ))
    };

    let get_tier_timeout = |max_total_ms: u64| -> Option<(Duration, Duration)> {
        let remaining = total_deadline.saturating_duration_since(std::time::Instant::now());
        if remaining < Duration::from_millis(800) {
            return None;
        }
        let connect_timeout = Duration::from_millis(1500).min(remaining);
        let request_timeout = Duration::from_millis(max_total_ms).min(remaining);
        Some((connect_timeout, request_timeout))
    };

    let mut last_error = String::new();
    let mut result: Option<(Vec<u8>, String, String, Option<String>)> = None;

    // Try direct connection first (if DNS resolution didn't fail)
    let direct_error = if let Some(dns_err) = direct_dns_error {
        Some(format!("Direct DNS: {dns_err}"))
    } else if let Some((conn_to, req_to)) = get_tier_timeout(2500) {
        match build_http_client_with_proxy(
            user_agent.as_deref(),
            resolve_pin,
            None,
            conn_to,
            req_to,
        ) {
            Ok(client) => match do_download(client, url.clone()).await {
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
        // Resolve Mihomo mixed-port proxy and ambient (system / environment) proxy as distinct candidates.
        let mihomo_proxy_url = {
            let state = app.state::<MihomoState>();
            let guard = state
                .0
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            guard.process().is_some().then(|| {
                format!(
                    "http://127.0.0.1:{}",
                    guard.last_proxy_port().unwrap_or(7890)
                )
            })
        };

        let ambient_proxy_url = crate::sys_proxy::get_sys_proxy_address()
            .as_deref()
            .and_then(zephyr_core::config::subscription::validate_ambient_proxy_url)
            .or_else(|| {
                let get_valid_env_proxy = |key: &str| {
                    std::env::var(key)
                        .ok()
                        .as_deref()
                        .and_then(zephyr_core::config::subscription::validate_ambient_proxy_url)
                };
                get_valid_env_proxy("HTTPS_PROXY")
                    .or_else(|| get_valid_env_proxy("https_proxy"))
                    .or_else(|| get_valid_env_proxy("ALL_PROXY"))
                    .or_else(|| get_valid_env_proxy("all_proxy"))
                    .or_else(|| get_valid_env_proxy("HTTP_PROXY"))
                    .or_else(|| get_valid_env_proxy("http_proxy"))
            });

        // ── Tier 2: Mihomo proxy (mixed-port) ──────────────────────────────────
        if let Some(m_url) = &mihomo_proxy_url {
            if let Some((conn_to, req_to)) = get_tier_timeout(2500) {
                let client_proxy = build_http_client_with_proxy(
                    user_agent.as_deref(),
                    None,
                    Some(m_url.clone()),
                    conn_to,
                    req_to,
                );
                match client_proxy {
                    Ok(client) => match do_download(client, url.clone()).await {
                        Ok(data) => {
                            result = Some(data);
                        }
                        Err(e) => {
                            last_error = match direct_error.as_deref() {
                                Some(de) => format!("{de} | Proxy: {e}"),
                                None => format!("Proxy: {e}"),
                            };
                        }
                    },
                    Err(e) => {
                        last_error = match direct_error.as_deref() {
                            Some(de) => format!("{de} | Proxy client build: {e}"),
                            None => format!("Proxy client build: {e}"),
                        };
                    }
                }
            } else {
                last_error = match direct_error.as_deref() {
                    Some(de) => format!("{de} | Proxy: Skipped due to deadline exhaustion"),
                    None => "Proxy: Skipped due to deadline exhaustion".to_owned(),
                };
            }

            // ── Tier 3: 临时切换 global 模式并选择可用节点重试 ──────────────────
            // 直连和普通代理（规则分流）都失败后，若使用的是 Mihomo 内核代理，
            // 尝试把 Mihomo 切到 global 模式并确保 GLOBAL 策略组选择当前活跃的代理节点，
            // 让所有流量走代理节点（绕过分流规则可能导致的不可达），
            // 下载完成后或任务中断时自动切回原模式和原策略组选择。
            // 使用全局异步互斥锁防止并发下载任务在全局模式切换和还原期间发生竞态。
            if result.is_none() {
                let remaining = total_deadline.saturating_duration_since(std::time::Instant::now());
                if remaining >= Duration::from_millis(3500) {
                    let lock_wait = remaining.min(Duration::from_millis(1500));
                    if let Ok(lock_guard) =
                        tokio::time::timeout(lock_wait, GLOBAL_MODE_LOCK.clone().lock_owned()).await
                    {
                        if let Some(orig_mode) = get_mihomo_mode(app).await {
                            if orig_mode != "global" {
                                // Drop guard: 在发出 mode 切换前先行构造 guard。
                                // 即使后续的 set_mihomo_mode、get_mihomo_active_node_and_global_now、
                                // set_mihomo_proxy_group、sleep 或 download 任务被超时取消（Cancel），
                                // 也能在 drop 时恢复 core 的原模式和原节点选择，并在恢复执行期间持续持有互斥锁。
                                struct ModeRestoreGuard {
                                    app: tauri::AppHandle,
                                    orig_mode: Option<String>,
                                    orig_global_now: Option<String>,
                                    lock_guard: Option<tokio::sync::OwnedMutexGuard<()>>,
                                }
                                impl Drop for ModeRestoreGuard {
                                    fn drop(&mut self) {
                                        let app = self.app.clone();
                                        let orig_mode = self.orig_mode.take();
                                        let orig_global_now = self.orig_global_now.take();
                                        let lock_guard = self.lock_guard.take();
                                        if orig_mode.is_some() || orig_global_now.is_some() {
                                            tokio::spawn(async move {
                                                let _held_lock = lock_guard;
                                                if let Some(orig_node) = orig_global_now {
                                                    let mut ok = false;
                                                    for _ in 0..2 {
                                                        if set_mihomo_proxy_group(
                                                            &app, "GLOBAL", &orig_node,
                                                        )
                                                        .await
                                                        .is_some()
                                                        {
                                                            ok = true;
                                                            break;
                                                        }
                                                        tokio::time::sleep(Duration::from_millis(
                                                            50,
                                                        ))
                                                        .await;
                                                    }
                                                    if !ok {
                                                        crate::emit_warn!(
                                                            Core,
                                                            CORE_GLOBAL_RESTORE_DROPPED,
                                                            "Failed to restore original GLOBAL proxy group selection '{orig_node}' on drop"
                                                        );
                                                    }
                                                }
                                                if let Some(orig) = orig_mode {
                                                    let mut ok = false;
                                                    for _ in 0..2 {
                                                        if set_mihomo_mode(&app, &orig)
                                                            .await
                                                            .is_some()
                                                        {
                                                            ok = true;
                                                            break;
                                                        }
                                                        tokio::time::sleep(Duration::from_millis(
                                                            50,
                                                        ))
                                                        .await;
                                                    }
                                                    if !ok {
                                                        crate::emit_warn!(
                                                            Core,
                                                            CORE_MODE_RESTORE_DROPPED,
                                                            "Failed to restore original mihomo mode '{orig}' on drop"
                                                        );
                                                    }
                                                }
                                            });
                                        }
                                    }
                                }

                                // Query eligible active proxy node first before switching mode.
                                // If no eligible proxy node is available, avoid switching mode to prevent disruptive traffic toggling.
                                if let Some((active_node, global_now)) =
                                    get_mihomo_active_node_and_global_now(app).await
                                {
                                    let mut restore_guard = ModeRestoreGuard {
                                        app: app.clone(),
                                        orig_mode: Some(orig_mode),
                                        orig_global_now: None,
                                        lock_guard: Some(lock_guard),
                                    };

                                    let mode_switched =
                                        set_mihomo_mode(app, "global").await.is_some();
                                    if mode_switched {
                                        let mut node_switch_failed = false;
                                        if let Some(orig_node) = global_now.as_deref() {
                                            if orig_node != active_node.as_str() {
                                                // 在执行切换前预先装载 orig_global_now，即使 PUT 请求在途中被取消也能安全回滚。
                                                // 无论 PUT 返回成功还是连接超时/断连，均保持装载状态（因为服务端可能已处理变更），
                                                // 确保退出时保守地尝试回滚至 orig_node。
                                                restore_guard.orig_global_now = global_now;
                                                if set_mihomo_proxy_group(
                                                    app,
                                                    "GLOBAL",
                                                    &active_node,
                                                )
                                                .await
                                                .is_none()
                                                {
                                                    node_switch_failed = true;
                                                    last_error = if last_error.is_empty() {
                                                        format!("Global-mode: Failed to select node '{active_node}'")
                                                    } else {
                                                        format!("{last_error} | Global-mode: Failed to select node '{active_node}'")
                                                    };
                                                    crate::emit_warn!(
                                                        Core,
                                                        CORE_GLOBAL_SWITCH_FAILED,
                                                        "Failed to switch GLOBAL proxy group to '{active_node}'"
                                                    );
                                                }
                                            }
                                        }

                                        if !node_switch_failed {
                                            // 切换后短暂等待 mihomo 生效
                                            tokio::time::sleep(Duration::from_millis(150)).await;

                                            if let Some((conn_to, req_to)) = get_tier_timeout(2500)
                                            {
                                                let client_global = build_http_client_with_proxy(
                                                    user_agent.as_deref(),
                                                    None,
                                                    Some(m_url.clone()),
                                                    conn_to,
                                                    req_to,
                                                );
                                                match client_global {
                                                    Ok(client) => {
                                                        match do_download(client, url.clone()).await
                                                        {
                                                            Ok(data) => {
                                                                result = Some(data);
                                                            }
                                                            Err(e) => {
                                                                last_error = if last_error
                                                                    .is_empty()
                                                                {
                                                                    format!("Global-mode: {e}")
                                                                } else {
                                                                    format!("{last_error} | Global-mode: {e}")
                                                                };
                                                            }
                                                        }
                                                    }
                                                    Err(e) => {
                                                        last_error = if last_error.is_empty() {
                                                            format!("Global-mode client build: {e}")
                                                        } else {
                                                            format!(
                                                                "{last_error} | Global-mode client build: {e}"
                                                            )
                                                        };
                                                    }
                                                }
                                            }
                                        }
                                    } else {
                                        last_error = if last_error.is_empty() {
                                            "Global-mode: Failed to switch Mihomo mode to global"
                                                .to_owned()
                                        } else {
                                            format!("{last_error} | Global-mode: Failed to switch Mihomo mode to global")
                                        };
                                        restore_guard.orig_mode = None;
                                    }

                                    // 正常流程：尝试恢复原模式和策略组选择。
                                    // 仅在明确恢复成功后才从 restore_guard 中清除对应字段；
                                    // 若恢复请求失败或在 await 期间任务被取消，guard 内部保留原值，
                                    // Drop 守卫将在后台继续重试恢复，并在恢复期间继续持有互斥锁。
                                    if let Some(orig_node) = restore_guard.orig_global_now.clone() {
                                        let mut ok = false;
                                        for _ in 0..2 {
                                            if set_mihomo_proxy_group(app, "GLOBAL", &orig_node)
                                                .await
                                                .is_some()
                                            {
                                                ok = true;
                                                break;
                                            }
                                            tokio::time::sleep(Duration::from_millis(50)).await;
                                        }
                                        if ok {
                                            restore_guard.orig_global_now = None;
                                        } else {
                                            crate::emit_warn!(
                                                Core,
                                                CORE_GLOBAL_RESTORE_FAILED,
                                                "Failed to restore original GLOBAL proxy group selection '{orig_node}'"
                                            );
                                        }
                                    }
                                    if let Some(orig) = restore_guard.orig_mode.clone() {
                                        let mut ok = false;
                                        for _ in 0..2 {
                                            if set_mihomo_mode(app, &orig).await.is_some() {
                                                ok = true;
                                                break;
                                            }
                                            tokio::time::sleep(Duration::from_millis(50)).await;
                                        }
                                        if ok {
                                            restore_guard.orig_mode = None;
                                        } else {
                                            crate::emit_warn!(
                                                Core,
                                                CORE_MODE_RESTORE_FAILED,
                                                "Failed to restore original mihomo mode '{orig}'"
                                            );
                                        }
                                    }
                                    drop(restore_guard);
                                } else {
                                    last_error = if last_error.is_empty() {
                                        "Global-mode: No eligible proxy node found in GLOBAL group"
                                            .to_owned()
                                    } else {
                                        format!("{last_error} | Global-mode: No eligible proxy node found in GLOBAL group")
                                    };
                                }
                            }
                        }
                    }
                } else {
                    last_error = if last_error.is_empty() {
                        "Global-mode: Skipped due to deadline exhaustion".to_owned()
                    } else {
                        format!("{last_error} | Global-mode: Skipped due to deadline exhaustion")
                    };
                }
            }
        }

        // ── Tier 4: 环境代理 / 系统代理回退 ──────────────────────────────────
        // 若 Mihomo 未启动，或 Mihomo 代理与全局模式均无法拉取订阅，
        // 则在存在且不与 Mihomo 重复的有效本地回环代理（如系统代理或环境变量代理）时进行最终重试。
        if result.is_none() {
            if let Some(amb_url) = ambient_proxy_url {
                if Some(&amb_url) != mihomo_proxy_url.as_ref() {
                    if let Some((conn_to, req_to)) = get_tier_timeout(2500) {
                        let client_ambient = build_http_client_with_proxy(
                            user_agent.as_deref(),
                            None,
                            Some(amb_url),
                            conn_to,
                            req_to,
                        );
                        match client_ambient {
                            Ok(client) => match do_download(client, url).await {
                                Ok(data) => {
                                    result = Some(data);
                                }
                                Err(e) => {
                                    last_error = if last_error.is_empty() {
                                        format!("Ambient Proxy: {e}")
                                    } else {
                                        format!("{last_error} | Ambient Proxy: {e}")
                                    };
                                }
                            },
                            Err(e) => {
                                last_error = if last_error.is_empty() {
                                    format!("Ambient Proxy client build: {e}")
                                } else {
                                    format!("{last_error} | Ambient Proxy client build: {e}")
                                };
                            }
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
    let (bytes, sub_info_header, final_url, disp_filename) = result.ok_or_else(|| {
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
                url: preserved_url.or(Some(final_url)),
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
        assert!(result.unwrap_err().contains("SSRF protection"));
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
        assert!(result.unwrap_err().contains("Could not resolve"));
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
}

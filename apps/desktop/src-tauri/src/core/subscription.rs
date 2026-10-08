use std::time::Duration;
use tauri::{AppHandle, Manager as _, State};

use super::fetch_util::fetch_url_content;
use zephyr_core::config::sanitizer::remove_dangerous_keys_internal_pub as remove_dangerous_keys;
use zephyr_core::config::subscription::{
    classify_sub_error, extract_name_from_rules, is_literal_private_host, is_mihomo_fake_ip,
    is_private_host, is_private_ip, parse_content_disposition_filename, quote_short_id_values,
    redact_url_in_string, select_global_candidate, try_decode_base64_content,
    validate_subscription_name, validate_subscription_url_basic,
};

use super::core_process::ensure_app_storage;
use super::crypto::{load_metadata, lock_metadata, save_metadata, write_profile_file};
use super::{MihomoState, MAX_RESPONSE_SIZE};
#[allow(unused_imports)]
use crate::emit_warn;

fn build_http_client_with_proxy(
    user_agent: Option<&str>,
    resolve_pin: Option<&(String, std::net::SocketAddr)>,
    proxy_url: Option<String>,
    allowed_private_host: Option<&str>,
    connect_timeout: Duration,
    timeout: Duration,
) -> Result<reqwest::Client, String> {
    let mut client_builder = reqwest::Client::builder()
        .timeout(timeout)
        .connect_timeout(connect_timeout)
        .redirect(super::fetch_util::safe_redirect_policy(
            allowed_private_host.map(str::to_owned),
        ))
        .no_proxy();

    if proxy_url.is_none() {
        client_builder =
            client_builder.dns_resolver(std::sync::Arc::new(super::fetch_util::SafeDnsResolver {
                allowed_private_host: allowed_private_host.map(str::to_owned),
            }));
    } else {
        // Disable automatic redirects on proxied clients to enforce hop-by-hop destination validation
        client_builder = client_builder.redirect(reqwest::redirect::Policy::none());
    }

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
/// Helper to determine if the core is currently running without holding the `MihomoState` lock
/// during blocking OS process inspections on macOS TUN mode.
pub(crate) fn is_core_running(app: &AppHandle) -> bool {
    let (started, has_process, has_port) = {
        let state = app.state::<MihomoState>();
        let guard = state
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        (
            guard.started_at().is_some(),
            guard.process().is_some(),
            guard.last_port().is_some(),
        )
    };
    if !started {
        return false;
    }
    if has_process {
        return true;
    }
    #[cfg(target_os = "macos")]
    {
        has_port && super::tun_manager::is_tun_mode()
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = has_port;
        false
    }
}

/// 获取 mihomo API 的客户端、基础 URL 和 secret。
/// 失败时返回 None（核心未运行或端口未就绪）。
fn mihomo_base_api(app: &AppHandle) -> Option<(reqwest::Client, String, String)> {
    let (started, has_process, port, secret) = {
        let state = app.state::<MihomoState>();
        let guard = state
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        (
            guard.started_at().is_some(),
            guard.process().is_some(),
            guard.last_port(),
            guard.last_secret().to_owned(),
        )
    };
    if !started {
        return None;
    }
    if !has_process {
        #[cfg(target_os = "macos")]
        {
            if port.is_none() || !super::tun_manager::is_tun_mode() {
                return None;
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            return None;
        }
    }
    let api_port = port?;

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
/// 返回 Ok(()) 表示成功；Err(true) 表示永久性客户端错误（4xx，如目标节点或策略组不存在）；Err(false) 表示暂态错误。
async fn set_mihomo_proxy_group(app: &AppHandle, group: &str, name: &str) -> Result<(), bool> {
    let Some((client, base, secret)) = mihomo_base_api(app) else {
        return Err(false);
    };
    let url = format!("{base}/proxies/{group}");
    let mut req = client.put(&url).json(&serde_json::json!({ "name": name }));
    if !secret.is_empty() {
        req = req.bearer_auth(&secret);
    }
    let Ok(resp) = req.send().await else {
        return Err(false);
    };
    if resp.status().is_success() {
        Ok(())
    } else if matches!(
        resp.status(),
        reqwest::StatusCode::NOT_FOUND | reqwest::StatusCode::BAD_REQUEST
    ) {
        // 404: group missing; 400: selector rejected the node (not a member)
        Err(true)
    } else {
        Err(false)
    }
}

/// 查询指定策略组当前的活动选中项（now）。
async fn get_mihomo_proxy_group_now(app: &AppHandle, group: &str) -> Option<String> {
    let (client, base, secret) = mihomo_base_api(app)?;
    let url = format!("{base}/proxies/{group}");
    let mut req = client.get(&url);
    if !secret.is_empty() {
        req = req.bearer_auth(&secret);
    }
    let resp = req.send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body: serde_json::Value = resp.json().await.ok()?;
    body.get("now").and_then(|v| v.as_str()).map(str::to_owned)
}

/// 检查 Mihomo DNS 解析记录是否包含确认的私网/fake-IP 地址（Some(true)）、
/// 确认为公网地址（Some(false)），或解析结果未决/空/非地址记录（None）。
fn mihomo_dns_answer_is_private(json: &serde_json::Value) -> Option<bool> {
    let answers = json.get("Answer").and_then(|a| a.as_array())?;
    let mut saw_address = false;

    for answer in answers {
        let record_type = answer.get("type");
        let is_address_record = match record_type {
            Some(serde_json::Value::Number(value)) => {
                matches!(value.as_u64(), Some(1 | 28))
            }
            Some(serde_json::Value::String(value)) => {
                value.eq_ignore_ascii_case("A") || value.eq_ignore_ascii_case("AAAA")
            }
            _ => continue,
        };
        if !is_address_record {
            continue;
        }
        let Some(data) = answer.get("data").and_then(|d| d.as_str()) else {
            continue;
        };
        let Ok(ip) = data.parse::<std::net::IpAddr>() else {
            continue;
        };
        if is_mihomo_fake_ip(ip) {
            // Fake-IP is synthetic; it does not confirm a real public or private address.
            continue;
        }
        if is_private_ip(ip) {
            return Some(true);
        }
        saw_address = true;
    }

    saw_address.then_some(false)
}

#[derive(Debug)]
enum MihomoDnsQuery {
    Success(serde_json::Value),
    Unavailable,
    Failed,
}

async fn query_mihomo_dns_type(
    client: &reqwest::Client,
    base: &str,
    secret: &str,
    host: &str,
    qtype: &str,
    timeout_dur: Duration,
) -> MihomoDnsQuery {
    let Ok(mut url) = reqwest::Url::parse(&format!("{base}/dns/query")) else {
        return MihomoDnsQuery::Failed;
    };
    url.query_pairs_mut()
        .append_pair("name", host)
        .append_pair("type", qtype);
    let mut req = client.get(url).timeout(timeout_dur);
    if !secret.is_empty() {
        req = req.bearer_auth(secret);
    }
    let resp = match req.send().await {
        Ok(r) => r,
        Err(_) => return MihomoDnsQuery::Failed,
    };
    if !resp.status().is_success() {
        return MihomoDnsQuery::Unavailable;
    }
    match resp.json::<serde_json::Value>().await {
        Ok(v) => MihomoDnsQuery::Success(v),
        Err(_) => MihomoDnsQuery::Unavailable,
    }
}

/// 查询 Mihomo DNS 解析接口（同时检查 A 与 AAAA 记录）：
/// - Some(true): 确认为私网地址（判定为 SSRF 风险）
/// - Some(false): 确认为公网地址
/// - None: 核心未运行、请求超时/失败、未返回地址记录或仅包含 fake-IP（未决，不误判为 SSRF）
pub(crate) async fn check_mihomo_dns_is_private(
    app: &AppHandle,
    host: &str,
    timeout_dur: Duration,
) -> Option<bool> {
    let clean_host = host.trim_matches(['[', ']'].as_slice());
    if let Ok(ip) = clean_host.parse::<std::net::IpAddr>() {
        if is_mihomo_fake_ip(ip) {
            return None;
        }
        if is_private_ip(ip) {
            return Some(true);
        }
        return Some(false);
    }

    let (client, base, secret) = mihomo_base_api(app)?;
    let (res_a, res_aaaa) = tokio::join!(
        query_mihomo_dns_type(&client, &base, &secret, host, "A", timeout_dur),
        query_mihomo_dns_type(&client, &base, &secret, host, "AAAA", timeout_dur)
    );

    let val_a = match &res_a {
        MihomoDnsQuery::Success(v) => Some(v),
        MihomoDnsQuery::Unavailable | MihomoDnsQuery::Failed => None,
    };
    let val_aaaa = match &res_aaaa {
        MihomoDnsQuery::Success(v) => Some(v),
        MihomoDnsQuery::Unavailable | MihomoDnsQuery::Failed => None,
    };

    let ans_a = val_a.and_then(mihomo_dns_answer_is_private);
    let ans_aaaa = val_aaaa.and_then(mihomo_dns_answer_is_private);

    if ans_a == Some(true) || ans_aaaa == Some(true) {
        return Some(true);
    }

    // Transport failures mean safety cannot be verified (remain unverified)
    if matches!(res_a, MihomoDnsQuery::Failed) || matches!(res_aaaa, MihomoDnsQuery::Failed) {
        return None;
    }

    // A confirmed public address is accepted if the other query either confirmed public
    // or returned an unavailable/unsupported response (e.g. disabled IPv6 resolver operation)
    if ans_a == Some(false)
        && matches!(
            res_aaaa,
            MihomoDnsQuery::Unavailable | MihomoDnsQuery::Success(_)
        )
    {
        return Some(false);
    }
    if ans_aaaa == Some(false)
        && matches!(
            res_a,
            MihomoDnsQuery::Unavailable | MihomoDnsQuery::Success(_)
        )
    {
        return Some(false);
    }

    None
}

/// 全局互斥锁，确保并发的订阅下载任务在尝试临时切换 Mihomo global 模式时不发生竞态。
static GLOBAL_MODE_LOCK: std::sync::LazyLock<std::sync::Arc<tokio::sync::Mutex<()>>> =
    std::sync::LazyLock::new(|| std::sync::Arc::new(tokio::sync::Mutex::new(())));

static USER_MODE_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static USER_NODE_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 记录用户主动切换模式的计数器，用于防止回退逻辑在恢复时覆盖用户在下载期间的主动选择。
pub fn notify_user_mode_changed() {
    USER_MODE_GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
}

/// 记录用户主动切换 GLOBAL 节点的计数器，用于防止回退逻辑在恢复时覆盖用户在下载期间的主动选择。
pub fn notify_user_node_changed() {
    USER_NODE_GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
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
#[allow(clippy::cognitive_complexity, clippy::too_many_arguments)]
async fn restore_mihomo_state(
    app: &AppHandle,
    orig_global_now: &mut Option<String>,
    orig_mode: &mut Option<String>,
    candidate_node: Option<&str>,
    deadline: Option<std::time::Instant>,
    on_drop: bool,
    core_started_at: Option<std::time::Instant>,
    user_mode_generation: Option<u64>,
    user_node_generation: Option<u64>,
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
        // Do not delete the recovery marker from disk: if the core restarted,
        // background/startup reconciliation needs the marker to restore the new core.
        *orig_mode = None;
        *orig_global_now = None;
        return;
    }

    if mihomo_base_api(app).is_none() {
        return;
    }

    // Record whether this fallback tier originally switched the mode before any user change overrides it.
    let fallback_switched_mode = orig_mode.is_some();

    // Check if user changed the mode during download (via settings or UI).
    // If so, preserve their choice and cancel the mode restore.
    let user_changed_mode = user_mode_generation
        .is_some_and(|g| USER_MODE_GENERATION.load(std::sync::atomic::Ordering::SeqCst) != g);

    if user_changed_mode {
        *orig_mode = None;
        let _ = remove_global_mode_restore_marker(app);
    }

    // Restore captured `orig_mode` (the live mode immediately before global fallback was engaged).
    // If this tier never changed the mode (orig_mode is None), mode must not be modified.
    let target_mode = if orig_mode.is_some() {
        orig_mode
            .as_deref()
            .and_then(canonicalize_mode)
            .map(String::from)
            .or_else(|| orig_mode.clone())
    } else {
        None
    };
    let mode_was_switched = orig_mode.is_some();
    let mut mode_is_safe = orig_mode.is_none();

    let is_special_target = |s: &str| {
        matches!(
            s,
            "DIRECT" | "REJECT" | "REJECT-DROP" | "PASS" | "PASS-RULE" | "COMPATIBLE"
        )
    };

    // 1. 先恢复原模式（如 rule），使用户常规流量立即脱离 global 路由
    if let Some(target) = target_mode.as_deref() {
        if target.eq_ignore_ascii_case("global") {
            // Mihomo remains in global mode.
            *orig_mode = None;
            if let Some(orig_node) = orig_global_now.as_deref() {
                if (fallback_switched_mode || mode_was_switched) && is_special_target(orig_node) {
                    // Do not restore a DIRECT/REJECT selection while global mode is active
                    // if this tier was the one that switched the mode to global.
                    *orig_global_now = None;
                    mode_is_safe = false;
                } else {
                    // Restoring a real proxy node in global mode is safe and intended,
                    // as is restoring the user's original selection if the core was already in global mode.
                    mode_is_safe = true;
                }
            } else {
                mode_is_safe = false;
            }
        } else {
            let (ok, deferred) = retry_restore_step(deadline, || async {
                if !check_core_alive() {
                    return None;
                }
                // If user changed Mihomo's mode away from "global" during download, do not overwrite it.
                if let Some(live_mode) = get_mihomo_mode(app).await {
                    if !live_mode.eq_ignore_ascii_case("global") {
                        return Some(());
                    }
                }
                set_mihomo_mode(app, target).await
            })
            .await;

            if !check_core_alive() {
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
        if let Some(orig_node) = orig_global_now.clone() {
            let is_currently_global = get_mihomo_mode(app)
                .await
                .map(|m| m.eq_ignore_ascii_case("global"))
                .unwrap_or(false);
            if is_currently_global
                && (fallback_switched_mode || mode_was_switched)
                && is_special_target(&orig_node)
            {
                *orig_global_now = None;
            }
            if !check_core_alive() {
                *orig_mode = None;
                *orig_global_now = None;
                return;
            }
            // If user selected a new GLOBAL node during download, preserve their choice.
            let user_changed_node = user_node_generation.is_some_and(|g| {
                USER_NODE_GENERATION.load(std::sync::atomic::Ordering::SeqCst) != g
            });
            if user_changed_node {
                *orig_global_now = None;
            } else if let Some(live_now) = get_mihomo_proxy_group_now(app, "GLOBAL").await {
                if let Some(cand) = candidate_node {
                    if live_now != cand {
                        *orig_global_now = None;
                    }
                } else if live_now == orig_node {
                    // Node is already the original selection; nothing to restore.
                    *orig_global_now = None;
                }
            }
            if orig_global_now.is_none() {
                if orig_mode.is_none() {
                    let _ = remove_global_mode_restore_marker(app);
                } else {
                    let _ = write_global_mode_restore_marker(
                        app,
                        orig_mode.as_deref(),
                        None,
                        None,
                        true,
                        false,
                    );
                }
                return;
            }
            let is_missing_flag = std::sync::atomic::AtomicBool::new(false);
            let (ok, deferred) = retry_restore_step(deadline, || async {
                if !check_core_alive() {
                    return None;
                }
                if user_node_generation.is_some_and(|g| {
                    USER_NODE_GENERATION.load(std::sync::atomic::Ordering::SeqCst) != g
                }) {
                    return Some(());
                }
                let current_selection = get_mihomo_proxy_group_now(app, "GLOBAL").await;
                let Some(live_now) = current_selection else {
                    // Failed to read current selection; retry verification rather than blindly issuing PUT
                    return None;
                };
                if let Some(cand) = candidate_node {
                    if live_now != cand {
                        return Some(());
                    }
                } else if live_now == orig_node {
                    return Some(());
                }
                match set_mihomo_proxy_group(app, "GLOBAL", &orig_node).await {
                    Ok(()) => Some(()),
                    Err(true) => {
                        is_missing_flag.store(true, std::sync::atomic::Ordering::Relaxed);
                        None
                    }
                    Err(false) => None,
                }
            })
            .await;
            let is_missing = is_missing_flag.load(std::sync::atomic::Ordering::Relaxed);

            if !check_core_alive() {
                *orig_mode = None;
                *orig_global_now = None;
                return;
            }

            if ok || is_missing {
                if is_missing {
                    crate::emit_warn!(
                        Core,
                        CORE_GLOBAL_RESTORE_FAILED,
                        "Original GLOBAL proxy group selection '{orig_node}' no longer exists in proxies; clearing restore marker"
                    );
                }
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
    } else if let Err(e) = write_global_mode_restore_marker(
        app,
        orig_mode.as_deref(),
        orig_global_now.as_deref(),
        candidate_node,
        orig_mode.is_some(),
        orig_global_now.is_some(),
    ) {
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
    pub candidate_node: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_config: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub mode_switched: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub node_switched: bool,
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
    candidate_node: Option<&str>,
    mode_switched: bool,
    node_switched: bool,
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
        candidate_node: candidate_node.map(str::to_owned),
        active_config,
        mode_switched,
        node_switched,
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

pub async fn write_global_mode_restore_marker_async(
    app: AppHandle,
    orig_mode: Option<String>,
    orig_global_now: Option<String>,
    candidate_node: Option<String>,
    mode_switched: bool,
    node_switched: bool,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        write_global_mode_restore_marker(
            &app,
            orig_mode.as_deref(),
            orig_global_now.as_deref(),
            candidate_node.as_deref(),
            mode_switched,
            node_switched,
        )
    })
    .await
    .map_err(|e| e.to_string())?
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
pub fn read_restore_marker_at(path: &std::path::Path) -> Option<GlobalModeRestoreMarker> {
    let (data, used_path) = match std::fs::read_to_string(path) {
        Ok(d) if !d.trim().is_empty() => (d, path.to_path_buf()),
        _ => {
            let tmp_path = restore_marker_tmp_path(path);
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
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_file(restore_marker_tmp_path(path));
        return None;
    }
    Some(marker)
}

#[must_use]
pub fn read_global_mode_restore_marker(app: &AppHandle) -> Option<GlobalModeRestoreMarker> {
    let path = global_mode_restore_path(app)?;
    read_restore_marker_at(&path)
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
    let candidate_node = marker.candidate_node;

    // Distinguish unstarted operation from completed switch:
    // Only restore mutations confirmed to have occurred.
    if !marker.mode_switched {
        if let Some(dl) = deadline {
            if dl
                .saturating_duration_since(std::time::Instant::now())
                .is_zero()
            {
                return;
            }
        }
        let mode_future = get_mihomo_mode(app);
        let current_mode = if let Some(dl) = deadline {
            let rem = dl.saturating_duration_since(std::time::Instant::now());
            tokio::time::timeout(rem, mode_future).await.ok().flatten()
        } else {
            mode_future.await
        };
        match current_mode.as_deref() {
            Some(m) if !m.eq_ignore_ascii_case("global") => {
                orig_mode = None;
            }
            Some(_) => {}
            None => {
                // Controller query failed or timed out: cannot confirm, retain marker for future reconciliation.
                return;
            }
        }
    }

    if !marker.node_switched {
        if let Some(dl) = deadline {
            if dl
                .saturating_duration_since(std::time::Instant::now())
                .is_zero()
            {
                return;
            }
        }
        let group_future = get_mihomo_proxy_group_now(app, "GLOBAL");
        let current_node = if let Some(dl) = deadline {
            let rem = dl.saturating_duration_since(std::time::Instant::now());
            tokio::time::timeout(rem, group_future).await.ok().flatten()
        } else {
            group_future.await
        };
        match current_node.as_deref() {
            Some(curr) => {
                if let Some(cand) = &candidate_node {
                    if curr != cand {
                        orig_global_now = None;
                    }
                } else {
                    orig_global_now = None;
                }
            }
            None => {
                // Controller query failed or timed out: cannot confirm, retain marker for future reconciliation.
                return;
            }
        }
    }

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
        if cfg_mode.eq_ignore_ascii_case("global") {
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

    if let Some(dl) = deadline {
        if dl
            .saturating_duration_since(std::time::Instant::now())
            .is_zero()
        {
            return;
        }
    }

    restore_mihomo_state(
        app,
        &mut orig_global_now,
        &mut orig_mode,
        candidate_node.as_deref(),
        deadline,
        false,
        core_started_at,
        None,
        None,
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
        return false;
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
    read_global_mode_restore_marker(app).is_none()
}

/// Drop guard: 在发出 mode 切换前先行构造 guard。
/// 即使后续的 `set_mihomo_mode`、`get_mihomo_active_node_and_global_now`、
/// `set_mihomo_proxy_group`、sleep 或 download 任务被超时取消（Cancel），
/// 也能在 drop 时恢复 core 的原模式和原节点选择，并在恢复执行期间持续持有互斥锁。
struct ModeRestoreGuard {
    app: tauri::AppHandle,
    orig_mode: Option<String>,
    orig_global_now: Option<String>,
    candidate_node: Option<String>,
    lock_guard: Option<tokio::sync::OwnedMutexGuard<()>>,
    core_started_at: Option<std::time::Instant>,
    user_mode_generation: Option<u64>,
    user_node_generation: Option<u64>,
}

impl Drop for ModeRestoreGuard {
    fn drop(&mut self) {
        let app = self.app.clone();
        let mut orig_mode = self.orig_mode.take();
        let mut orig_global_now = self.orig_global_now.take();
        let candidate_node = self.candidate_node.take();
        let lock_guard = self.lock_guard.take();
        let core_started_at = self.core_started_at;
        let user_mode_generation = self.user_mode_generation;
        let user_node_generation = self.user_node_generation;
        if orig_mode.is_some() || orig_global_now.is_some() {
            if let Ok(handle) = tokio::runtime::Handle::try_current() {
                handle.spawn(async move {
                    let _held_lock = lock_guard;
                    restore_mihomo_state(
                        &app,
                        &mut orig_global_now,
                        &mut orig_mode,
                        candidate_node.as_deref(),
                        None,
                        true,
                        core_started_at,
                        user_mode_generation,
                        user_node_generation,
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

fn is_deterministic_download_error(err: &str) -> bool {
    err.contains("exceeds maximum size")
        || err.contains("Too many redirects")
        || err.contains("missing Location header")
        || err.contains("Invalid Location header")
        || err.contains("Redirect destination could not be verified")
}

#[derive(Debug)]
enum DownloadStreamError {
    Http(reqwest::StatusCode, String),
    Transport(String),
    Ssrf(String),
}

impl std::fmt::Display for DownloadStreamError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Http(_, msg) | Self::Transport(msg) | Self::Ssrf(msg) => write!(f, "{msg}"),
        }
    }
}

impl std::error::Error for DownloadStreamError {}

async fn do_download_stream(
    client: &reqwest::Client,
    url: &str,
    header_deadline: std::time::Instant,
    tier_deadline: std::time::Instant,
    is_proxied: bool,
    app: Option<&AppHandle>,
    allowed_private_host: Option<&str>,
) -> Result<(Vec<u8>, String, String, Option<String>), DownloadStreamError> {
    let mut current_url = url.to_owned();
    let mut redirect_count = 0;
    let resp = loop {
        let request = client.get(&current_url).send();
        let r = tokio::time::timeout_at(tokio::time::Instant::from_std(header_deadline), request)
            .await
            .map_err(|_elapsed| {
                DownloadStreamError::Transport("Request deadline exceeded".to_owned())
            })?
            .map_err(|e| {
                let chain = super::fetch_util::format_error_chain(&e);
                if super::fetch_util::is_ssrf_error(&chain) {
                    return DownloadStreamError::Ssrf(chain);
                }
                let msg = if e.is_timeout() {
                    format!("Request timeout: {chain}")
                } else if e.is_connect() {
                    format!("Connection failed: {chain}")
                } else if e.is_request() {
                    format!("Request error: {chain}")
                } else if e.is_body() {
                    format!("Body error: {chain}")
                } else if e.is_decode() {
                    format!("Decode error: {chain}")
                } else {
                    format!("Network error: {chain}")
                };
                DownloadStreamError::Transport(msg)
            })?;

        if matches!(r.status().as_u16(), 301 | 302 | 303 | 307 | 308) {
            if redirect_count >= 5 {
                return Err(DownloadStreamError::Transport(
                    "Too many redirects (max 5)".to_owned(),
                ));
            }
            redirect_count += 1;
            let loc = r
                .headers()
                .get(reqwest::header::LOCATION)
                .ok_or_else(|| {
                    DownloadStreamError::Transport("Redirect missing Location header".to_owned())
                })?
                .to_str()
                .map_err(|_err| {
                    DownloadStreamError::Transport("Invalid Location header encoding".to_owned())
                })?;
            let next_url = super::fetch_util::validate_redirect_hop(
                &current_url,
                loc,
                is_proxied,
                app,
                allowed_private_host,
                tokio::time::Instant::from_std(header_deadline),
            )
            .await
            .map_err(|e| match e {
                super::fetch_util::RedirectHopError::Ssrf(msg) => DownloadStreamError::Ssrf(msg),
                super::fetch_util::RedirectHopError::Transport(msg) => {
                    DownloadStreamError::Transport(msg)
                }
            })?;
            current_url = next_url.to_string();
            continue;
        }

        break r;
    };

    if !resp.status().is_success() {
        let status = resp.status();
        let url_display = super::config_manager::mask_url(resp.url().as_ref());
        return Err(DownloadStreamError::Http(
            status,
            format!("HTTP {status} from {url_display}"),
        ));
    }

    if let Some(content_length) = resp.content_length() {
        if usize::try_from(content_length).unwrap_or(0) > MAX_RESPONSE_SIZE {
            return Err(DownloadStreamError::Transport(format!(
                "Response too large: {content_length} bytes (max {MAX_RESPONSE_SIZE} bytes)"
            )));
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

    let remaining = tier_deadline.saturating_duration_since(std::time::Instant::now());
    if remaining.is_zero() {
        return Err(DownloadStreamError::Transport(
            "Response body deadline exceeded".to_owned(),
        ));
    }
    let bytes = tokio::time::timeout(remaining, read_response_body(resp))
        .await
        .map_err(|_elapsed| {
            DownloadStreamError::Transport("Response body deadline exceeded".to_owned())
        })?
        .map_err(DownloadStreamError::Transport)?;

    Ok((bytes, sub_info_header, requested_url, disp_filename))
}

async fn try_global_mode_tier(
    app: &AppHandle,
    m_url: &str,
    url: &str,
    user_agent: Option<&str>,
    total_deadline: std::time::Instant,
) -> Result<(Vec<u8>, String, String, Option<String>), DownloadStreamError> {
    let remaining = total_deadline.saturating_duration_since(std::time::Instant::now());
    if remaining < Duration::from_millis(3000) {
        return Err(DownloadStreamError::Transport(
            "Global-mode: Skipped due to deadline exhaustion".to_owned(),
        ));
    }

    let lock_wait = remaining.min(Duration::from_millis(1500));
    let lock_guard = tokio::time::timeout(lock_wait, GLOBAL_MODE_LOCK.clone().lock_owned())
        .await
        .map_err(|_timeout| {
            DownloadStreamError::Transport("Global-mode: Skipped due to lock contention".to_owned())
        })?;

    // If an unrestored recovery marker exists from an earlier abnormal termination,
    // reconcile it first under the held mutex before observing current state.
    if read_global_mode_restore_marker(app).is_some() {
        reconcile_global_mode_restore_inner(app, Some(total_deadline)).await;
        if read_global_mode_restore_marker(app).is_some() {
            return Err(DownloadStreamError::Transport(
                "Global-mode: Pending recovery marker could not be reconciled".to_owned(),
            ));
        }
    }

    let orig_mode = get_mihomo_mode(app).await.ok_or_else(|| {
        DownloadStreamError::Transport("Global-mode: Failed to get current Mihomo mode".to_owned())
    })?;

    let (active_node, global_now) = get_mihomo_active_node_and_global_now(app)
        .await
        .ok_or_else(|| {
            DownloadStreamError::Transport(
                "Global-mode: No eligible proxy node found in GLOBAL group".to_owned(),
            )
        })?;

    let orig_global_now = global_now.ok_or_else(|| {
        DownloadStreamError::Transport(
            "Global-mode: Original GLOBAL proxy group selection is unknown".to_owned(),
        )
    })?;

    let need_mode_switch = !orig_mode.eq_ignore_ascii_case("global");
    let need_node_switch = orig_global_now != active_node;

    if !need_mode_switch && !need_node_switch {
        return Err(DownloadStreamError::Transport(
            "Global-mode: Already in global mode with active node selected".to_owned(),
        ));
    }

    // Re-check cumulative deadline before mutating any core state.
    // Require enough remaining time for mode/node switching, settle delay (150ms),
    // minimum usable download window (800ms), and downstream restoration reserve (1500ms).
    let rem_before_mutate = total_deadline.saturating_duration_since(std::time::Instant::now());
    let switch_budget_ms =
        (if need_mode_switch { 400 } else { 0 }) + (if need_node_switch { 400 } else { 0 });
    let min_pre_mutate_budget = Duration::from_millis(1500 + 800 + 150 + switch_budget_ms);
    if rem_before_mutate < min_pre_mutate_budget {
        return Err(DownloadStreamError::Transport(
            "Global-mode: Skipped due to deadline exhaustion".to_owned(),
        ));
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
        candidate_node: need_node_switch.then(|| active_node.clone()),
        lock_guard: Some(lock_guard),
        core_started_at,
        user_mode_generation: need_mode_switch
            .then(|| USER_MODE_GENERATION.load(std::sync::atomic::Ordering::SeqCst)),
        user_node_generation: need_node_switch
            .then(|| USER_NODE_GENERATION.load(std::sync::atomic::Ordering::SeqCst)),
    };

    // 在修改 Mihomo 状态前，先持久化恢复标记至磁盘（记录初始未切换状态）。
    // 这样即便进程遭遇 SIGKILL、崩溃中止或意外掉电，
    // 也能保证磁盘具备写入权限并记录预切换上下文。
    if let Err(e) = write_global_mode_restore_marker_async(
        app.clone(),
        need_mode_switch.then_some(orig_mode.clone()),
        need_node_switch.then_some(orig_global_now.clone()),
        need_node_switch.then_some(active_node.clone()),
        false,
        false,
    )
    .await
    {
        crate::emit_warn!(
            Core,
            CORE_MODE_RESTORE_FAILED,
            "Skipping global-mode fallback: failed to persist recovery marker: {e}"
        );
        return Err(DownloadStreamError::Transport(format!(
            "Global-mode: Failed to persist recovery marker: {e}"
        )));
    }

    let check_core_current = || -> bool {
        let state = app.state::<MihomoState>();
        let guard = state
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        guard.started_at() == core_started_at && guard.started_at().is_some()
    };

    let mode_switched = if need_mode_switch {
        if !check_core_current() {
            restore_guard.orig_mode = None;
            return Err(DownloadStreamError::Transport(
                "Global-mode: Core restarted before mode switch".to_owned(),
            ));
        }
        // Arm before the call: the switch may apply even if the response is lost.
        restore_guard.orig_mode = Some(orig_mode.clone());
        if let Err(e) = write_global_mode_restore_marker_async(
            app.clone(),
            Some(orig_mode.clone()),
            need_node_switch.then_some(orig_global_now.clone()),
            need_node_switch.then_some(active_node.clone()),
            true,
            false,
        )
        .await
        {
            restore_guard.orig_mode = None;
            return Err(DownloadStreamError::Transport(format!(
                "Global-mode: Failed to persist mode restore marker: {e}"
            )));
        }
        if restore_guard
            .user_mode_generation
            .is_some_and(|g| USER_MODE_GENERATION.load(std::sync::atomic::Ordering::SeqCst) != g)
        {
            restore_guard.orig_mode = None;
            let _ = remove_global_mode_restore_marker(app);
            return Err(DownloadStreamError::Transport(
                "Global-mode: User changed mode during preparation".to_owned(),
            ));
        }
        if set_mihomo_mode(app, "global").await.is_none() {
            return Err(DownloadStreamError::Transport(
                "Global-mode: Failed to switch Mihomo mode to global".to_owned(),
            ));
        }
        true
    } else {
        false
    };

    if need_node_switch {
        if !check_core_current() {
            return Err(DownloadStreamError::Transport(
                "Global-mode: Core restarted before node switch".to_owned(),
            ));
        }
        // Arm before the call: the switch may apply even if the response is lost.
        restore_guard.orig_global_now = Some(orig_global_now.clone());
        if let Err(e) = write_global_mode_restore_marker_async(
            app.clone(),
            need_mode_switch.then_some(orig_mode.clone()),
            Some(orig_global_now.clone()),
            Some(active_node.clone()),
            mode_switched,
            true,
        )
        .await
        {
            restore_guard.orig_global_now = None;
            return Err(DownloadStreamError::Transport(format!(
                "Global-mode: Failed to persist node restore marker: {e}"
            )));
        }
        if restore_guard
            .user_node_generation
            .is_some_and(|g| USER_NODE_GENERATION.load(std::sync::atomic::Ordering::SeqCst) != g)
        {
            restore_guard.orig_global_now = None;
            return Err(DownloadStreamError::Transport(
                "Global-mode: User changed node during preparation".to_owned(),
            ));
        }
        if set_mihomo_proxy_group(app, "GLOBAL", &active_node)
            .await
            .is_err()
        {
            crate::emit_warn!(
                Core,
                CORE_GLOBAL_SWITCH_FAILED,
                "Failed to switch GLOBAL proxy group to '{active_node}'"
            );
            return Err(DownloadStreamError::Transport(format!(
                "Global-mode: Failed to select node '{active_node}'"
            )));
        }
    }

    // 切换后短暂等待 mihomo 生效
    tokio::time::sleep(Duration::from_millis(150)).await;

    if !check_core_current() {
        return Err(DownloadStreamError::Transport(
            "Global-mode: Core restarted after mode switch".to_owned(),
        ));
    }

    let rem_dl = total_deadline.saturating_duration_since(std::time::Instant::now());
    // Reserve at least 1500ms for state restoration
    let downstream_reserve = Duration::from_millis(1500);
    let usable_dl = rem_dl.saturating_sub(downstream_reserve);
    let (conn_to, req_to) = if usable_dl < Duration::from_millis(800) {
        return Err(DownloadStreamError::Transport(
            "Global-mode: Skipped due to deadline exhaustion".to_owned(),
        ));
    } else {
        (
            Duration::from_millis(1500).min(usable_dl),
            Duration::from_millis(5000).min(usable_dl),
        )
    };

    let client = build_http_client_with_proxy(
        user_agent,
        None,
        Some(m_url.to_owned()),
        None,
        conn_to,
        rem_dl,
    )
    .map_err(|e| DownloadStreamError::Transport(format!("Global-mode client build: {e}")))?;

    let download_deadline = total_deadline
        .checked_sub(downstream_reserve)
        .unwrap_or(total_deadline);
    let header_deadline = (std::time::Instant::now() + req_to).min(download_deadline);
    let download_res = do_download_stream(
        &client,
        url,
        header_deadline,
        download_deadline,
        true,
        Some(app),
        None,
    )
    .await;

    // 正常流程：尝试恢复原模式和策略组选择。
    // 传递 restore_guard 字段的可变引用，成功恢复的字段会被置为 None；
    // 若在 inline 恢复执行期间任务被取消，guard 内部尚未恢复的字段完好无损，
    // Drop 守卫将在后台继续接管恢复，并在恢复期间继续持有互斥锁。
    restore_mihomo_state(
        app,
        &mut restore_guard.orig_global_now,
        &mut restore_guard.orig_mode,
        restore_guard.candidate_node.as_deref(),
        Some(total_deadline),
        false,
        core_started_at,
        restore_guard.user_mode_generation,
        restore_guard.user_node_generation,
    )
    .await;
    drop(restore_guard);

    match download_res {
        Ok(data) => Ok(data),
        Err(DownloadStreamError::Ssrf(e)) => Err(DownloadStreamError::Ssrf(format!(
            "Global-mode SSRF blocked: {e}"
        ))),
        Err(DownloadStreamError::Http(status, e)) => Err(DownloadStreamError::Http(
            status,
            format!("Global-mode: {e}"),
        )),
        Err(DownloadStreamError::Transport(e)) => {
            Err(DownloadStreamError::Transport(format!("Global-mode: {e}")))
        }
    }
}

pub(crate) async fn download_sub_inner(
    app: &AppHandle,
    url: String,
    name: String,
    user_agent: Option<String>,
    overwrite: bool,
) -> Result<DownloadSubResult, String> {
    download_sub_inner_with_budget(
        app,
        url,
        name,
        user_agent,
        overwrite,
        Duration::from_millis(12000),
    )
    .await
}

pub(crate) async fn download_sub_inner_with_budget(
    app: &AppHandle,
    url: String,
    name: String,
    user_agent: Option<String>,
    overwrite: bool,
    budget: Duration,
) -> Result<DownloadSubResult, String> {
    // We set a cumulative internal budget across reconciliation, all tiers, and DNS resolution
    // to guarantee completion, cleanup, YAML parsing, and transactional file saving before caller timeout.
    let total_deadline = std::time::Instant::now() + budget;
    // Cap reconciliation work to 2500ms (or at most half of budget) so lock contention cannot consume
    // the shared budget needed by downstream download tiers.
    let max_reconcile = Duration::from_millis(2500).min(budget / 2);
    let reconcile_deadline = std::time::Instant::now() + max_reconcile;
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
    mut url: String,
    name: String,
    user_agent: Option<String>,
    overwrite: bool,
    total_deadline: std::time::Instant,
) -> Result<DownloadSubResult, String> {
    let trimmed = url.trim();
    if trimmed.len() != url.len() {
        url = trimmed.to_owned();
    }
    let safe_name = validate_subscription_name(&name).map_err(|e| e.to_string())?;

    let (host, port, user_entered_private) = validate_subscription_url_basic(&url)?;
    let trusted_private_literal = is_literal_private_host(&host);
    let private_suffix_host = user_entered_private && !trusted_private_literal;
    let user_entered_private_literal = trusted_private_literal;

    let is_single_label_host = zephyr_core::config::is_single_label_host(&host);
    let has_mihomo = is_core_running(app);

    // Explicit private IPs, localhost, and private-suffix names (.local/.lan/.internal, etc.)
    // retain direct-only behavior without public DNS pinning; private-suffix hosts are treated
    // as user-authorized LAN destinations and pin their resolved address directly.
    // If DNS resolution fails (e.g. host is blocked by GFW / NXDOMAIN)
    // or times out (unresponsive DNS / packet drop), record the error and bypass direct connection,
    // falling through to proxy. (Note: responses resolving to private/loopback IPs skip direct
    // tier and defer to managed core DNS verification before proxy fallback; fail closed if core is stopped.)
    let mut direct_dns_error = None;
    let resolve_pin = if user_entered_private_literal {
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
            let dns_timeout = if has_mihomo {
                Duration::from_millis(1500).min(remaining)
            } else {
                Duration::from_millis(4000).min(remaining)
            };
            match super::fetch_util::resolve_host_addrs_before_deadline(
                &host,
                port,
                tokio::time::Instant::now() + dns_timeout,
            )
            .await
            {
                Ok(addrs) => {
                    if addrs.is_empty() {
                        if is_single_label_host || private_suffix_host {
                            return Err(format!(
                                "Private or single-label host '{host}' could not be resolved to any validated IP address"
                            ));
                        }
                        direct_dns_error =
                            Some("Could not resolve any IP address for host".to_owned());
                        None
                    } else if private_suffix_host {
                        // User-entered private-suffix hostname (.local, .lan, .internal, etc.) is an authorized
                        // direct-only LAN destination. Filter out synthetic fake-IPs before pinning.
                        let valid_addr = addrs
                            .iter()
                            .find(|addr| !zephyr_core::config::is_mihomo_fake_ip(addr.ip()))
                            .copied();
                        if let Some(addr) = valid_addr {
                            Some((host.clone(), addr))
                        } else {
                            return Err(format!(
                                "Private host '{host}' resolved only to synthetic fake-IP addresses"
                            ));
                        }
                    } else {
                        match zephyr_core::config::subscription::validate_public_host_addrs(
                            &host, &addrs,
                        ) {
                            Ok((_, Some(addr), _)) => Some((host.clone(), addr)),
                            Ok((_, None, _)) => {
                                if is_single_label_host {
                                    return Err(format!(
                                        "Private or single-label host '{host}' could not be resolved to any validated IP address"
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
                                if has_mihomo {
                                    direct_dns_error = Some(format!("Direct DNS blocked: {e}"));
                                    None
                                } else {
                                    return Err(e);
                                }
                            }
                            Err(e) => {
                                if is_single_label_host {
                                    return Err(format!(
                                        "Private or single-label host '{host}' failed validation: {e}"
                                    ));
                                }
                                direct_dns_error = Some(e.to_string());
                                None
                            }
                        }
                    }
                }
                Err(e) => {
                    if is_single_label_host || private_suffix_host {
                        return Err(format!(
                            "Private or single-label host '{host}' could not be resolved locally: {e}"
                        ));
                    }
                    direct_dns_error = Some(e);
                    None
                }
            }
        }
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
    // 1. For direct-only private/LAN subscriptions, proxy tiers are not attempted, so allocate a full
    //    10000ms request window (4000ms connect timeout).
    // 2. For public subscriptions with Mihomo running, allocate 5500ms request (1500ms connect) so
    //    slow direct endpoints have adequate time to respond while blocked domains fast-fail on connect (1500ms)
    //    and leave ample budget (>= 6000ms) for proxy tiers.
    // 3. For public subscriptions with Mihomo stopped, no proxy fallback tiers exist (ambient/system proxy
    //    fallback was intentionally removed to eliminate unmanaged SSRF risk), so allocate the full
    //    10000ms request window (4000ms connect timeout) directly.
    let (direct_req_ms, direct_conn_ms) = if user_entered_private || !has_mihomo {
        (10000, 4000)
    } else {
        (5500, 1500)
    };

    let mut is_ssrf_error = false;
    let direct_error = if let Some(dns_err) = direct_dns_error.as_deref() {
        Some(format!("Direct DNS: {dns_err}"))
    } else if let Some((conn_to, req_to)) = get_tier_timeout(direct_req_ms, direct_conn_ms) {
        let allowed_host = user_entered_private.then_some(host.as_str());
        let total_remaining = total_deadline.saturating_duration_since(std::time::Instant::now());
        match build_http_client_with_proxy(
            user_agent.as_deref(),
            resolve_pin.as_ref(),
            None,
            allowed_host,
            conn_to,
            total_remaining,
        ) {
            Ok(client) => {
                let tier1_deadline = (std::time::Instant::now() + req_to).min(total_deadline);
                let body_deadline = if has_mihomo {
                    total_deadline
                        .checked_sub(Duration::from_millis(5000))
                        .unwrap_or(tier1_deadline)
                        .max(tier1_deadline)
                } else {
                    total_deadline
                };
                match do_download_stream(
                    &client,
                    &url,
                    tier1_deadline,
                    body_deadline,
                    false,
                    Some(app),
                    allowed_host,
                )
                .await
                {
                    Ok(data) => {
                        result = Some(data);
                        None
                    }
                    Err(DownloadStreamError::Ssrf(e)) => {
                        is_ssrf_error = true;
                        Some(format!("SSRF protection: Direct download blocked: {e}"))
                    }
                    Err(DownloadStreamError::Http(_status, e)) => Some(format!("Direct: {e}")),
                    Err(e) => Some(format!("Direct: {e}")),
                }
            }
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
        // User-entered private/LAN destinations, private host suffixes (.local, .internal, etc.),
        // single-label hosts, and SSRF-blocked destinations are strictly direct-only to prevent internal SSRF via proxies.
        let mut proxy_destination_unverified = false;
        if !user_entered_private
            && !is_single_label_host
            && !is_private_host(&host)
            && !is_ssrf_error
            && has_mihomo
        {
            let deadline = tokio::time::Instant::from_std(total_deadline);
            if let Err(e) =
                super::fetch_util::verify_proxy_destination(Some(app), &host, port, deadline).await
            {
                match e {
                    super::fetch_util::DownloadError::Ssrf(msg)
                    | super::fetch_util::DownloadError::LocalDnsSsrf(msg) => {
                        is_ssrf_error = true;
                        append_error(&mut last_error, &msg);
                    }
                    super::fetch_util::DownloadError::Transport(msg) => {
                        proxy_destination_unverified = true;
                        append_error(&mut last_error, &format!("Proxy fallback skipped: {msg}"));
                    }
                }
            }
            // Note on proxy-tier DNS rebinding residual risk:
            // Direct connections pin the validated IP address to eliminate DNS rebinding.
            // For Tier 2 and Tier 3 proxied requests through Mihomo's mixed port, standard HTTP/SOCKS
            // proxy semantics delegate resolution to the core to preserve remote DNS routing, virtual
            // hosting, and TLS certificate validation. The pre-connection check above via Mihomo's
            // /dns/query API validates that the domain does not resolve to private/local IP addresses
            // before the request is issued. The residual risk of a fast-flux DNS rebinding race between
            // the pre-check and Mihomo's internal connection is an accepted design trade-off for proxy
            // compatibility, bounded by Mihomo's own routing rule engine and fail-closed public validation.
        }

        if !user_entered_private
            && !is_single_label_host
            && !is_private_host(&host)
            && !is_ssrf_error
            && !proxy_destination_unverified
            && has_mihomo
        {
            // Resolve Mihomo mixed-port proxy candidate endpoint from running config.
            let mihomo_proxy_url = super::fetch_util::managed_proxy_endpoint_async(app)
                .await
                .map(|(p, scheme)| format!("{scheme}://127.0.0.1:{p}"));

            // ── Tier 2: Mihomo proxy (mixed-port) ──────────────────────────────────
            if let Some(m_url) = &mihomo_proxy_url {
                let remaining_tier2 =
                    total_deadline.saturating_duration_since(std::time::Instant::now());
                // Reserve at least 3500ms for Tier 3 (global mode)
                let rem_tier2_ms = u64::try_from(remaining_tier2.as_millis()).unwrap_or(u64::MAX);
                let usable_tier2_ms = rem_tier2_ms.saturating_sub(3500);
                let mut tier2_http_error = false;
                let mut tier2_attempted = false;
                if usable_tier2_ms >= 1000 {
                    let tier2_req_ms = usable_tier2_ms.min(4500);
                    let tier2_conn_ms = (tier2_req_ms / 2).clamp(500, 1500);
                    if let Some((conn_to, req_to)) = get_tier_timeout(tier2_req_ms, tier2_conn_ms) {
                        tier2_attempted = true;
                        let total_remaining =
                            total_deadline.saturating_duration_since(std::time::Instant::now());
                        let client_proxy = build_http_client_with_proxy(
                            user_agent.as_deref(),
                            None,
                            Some(m_url.clone()),
                            None,
                            conn_to,
                            total_remaining,
                        );
                        match client_proxy {
                            Ok(client) => {
                                let tier2_deadline =
                                    (std::time::Instant::now() + req_to).min(total_deadline);
                                match do_download_stream(
                                    &client,
                                    &url,
                                    tier2_deadline,
                                    tier2_deadline,
                                    true,
                                    Some(app),
                                    None,
                                )
                                .await
                                {
                                    Ok(data) => {
                                        result = Some(data);
                                    }
                                    Err(DownloadStreamError::Http(status, e)) => {
                                        if status.is_client_error() {
                                            let live_mode = get_mihomo_mode(app).await;
                                            let is_routable_403 = status.as_u16() == 403
                                                && live_mode
                                                    .as_deref()
                                                    .map(|m| {
                                                        m.eq_ignore_ascii_case("rule")
                                                            || m.eq_ignore_ascii_case("direct")
                                                    })
                                                    .unwrap_or(false);
                                            let is_transient = matches!(status.as_u16(), 408 | 429);
                                            if !is_routable_403 && !is_transient {
                                                tier2_http_error = true;
                                            }
                                        }
                                        append_error(&mut last_error, &format!("Proxy: {e}"));
                                    }
                                    Err(DownloadStreamError::Ssrf(e)) => {
                                        is_ssrf_error = true;
                                        append_error(
                                            &mut last_error,
                                            &format!("Proxy SSRF blocked: {e}"),
                                        );
                                    }
                                    Err(DownloadStreamError::Transport(e)) => {
                                        if is_deterministic_download_error(&e) {
                                            tier2_http_error = true;
                                        }
                                        append_error(&mut last_error, &format!("Proxy: {e}"));
                                    }
                                }
                            }
                            Err(e) => {
                                append_error(&mut last_error, &format!("Proxy client build: {e}"));
                            }
                        }
                    } else {
                        append_error(&mut last_error, "Proxy: Skipped due to deadline exhaustion");
                    }
                } else {
                    append_error(
                        &mut last_error,
                        "Proxy: Skipped to preserve fallback deadline",
                    );
                }

                // ── Tier 3: 临时切换 global 模式并选择可用节点重试 ──────────────────
                // 直连和普通代理（规则分流）都失败后，若使用的是 Mihomo 内核代理，
                // 尝试把 Mihomo 切到 global 模式并确保 GLOBAL 策略组选择当前活跃的代理节点，
                // 让所有流量走代理节点（绕过分流规则可能导致的不可达），
                // 下载完成后或任务中断时自动切回原模式和原策略组选择。
                // 注意：如果代理已返回 4xx 客户端错误（如 400/401/404/405 等确定性错误，或非 rule 模式下的 403 错误），
                // 说明网络已达且属于订阅本身错误，绝不应切换全局模式去打扰用户全局流量；
                // 仅当为 rule 模式下的 403（可能因规则分流直连导致地区限制）或瞬态错误（408/429）时，才允许进入 Tier 3 全局模式重试。
                if result.is_none() && tier2_attempted && !tier2_http_error && !is_ssrf_error {
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
                        Err(DownloadStreamError::Ssrf(err)) => {
                            is_ssrf_error = true;
                            append_error(&mut last_error, &err);
                        }
                        Err(err) => {
                            append_error(&mut last_error, &err.to_string());
                        }
                    }
                }
            }

            // Note on Ambient / System Proxy Fallback:
            // System proxy and environment proxy fallback are intentionally excluded to reduce
            // SSRF attack surface and eliminate untrusted ambient proxy hijacking.
            // The Mihomo proxy path is trusted (user-configured and managed by this application),
            // whereas system or environment proxies can be manipulated by arbitrary local software
            // or malware. Furthermore, users running this application rely on Mihomo itself rather
            // than a separate system proxy.
        }
    }

    // Three-tier download strategy:
    // Tier 1: Direct connection with DNS pinning (SSRF protection).
    // Tier 2: Mihomo mixed-port proxy connection.
    // Tier 3: Mihomo global mode with active proxy node selection and auto-restoration.
    //
    // System proxy fallback is intentionally removed to reduce SSRF attack surface.
    // The Mihomo proxy path is trusted (user-configured), while system proxy
    // could be set by any application/malware on the system.
    let (bytes, sub_info_header, requested_url, disp_filename) = result.ok_or_else(|| {
        if !last_error.is_empty() {
            last_error
        } else if let Some(de) = direct_error {
            de
        } else if is_ssrf_error {
            "Download blocked by security policy (SSRF)".to_owned()
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
    let result = download_sub_inner_with_budget(
        &app,
        resolved_url,
        name.clone(),
        user_agent,
        overwrite.unwrap_or(false),
        Duration::from_millis(25000),
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
        let result = download_sub_inner_with_budget(
            &app,
            resolved_url,
            name.clone(),
            ua_for_this,
            true,
            Duration::from_millis(25000),
        )
        .await;
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
pub async fn fetch_text(app: AppHandle, url: String) -> Result<String, String> {
    fetch_url_content(&url, None, Some(&app))
        .await
        .map_err(|e| {
            let safe_url = redact_url_in_string(url.clone());
            let safe_err = redact_url_in_string(e);
            crate::emit_error!(
                Subscription,
                SUB_NETWORK_ERROR,
                "fetch_text failed for '{safe_url}': {safe_err}"
            );
            "Network error occurred during fetch".to_owned()
        })
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use zephyr_core::config::subscription::{
        is_private_host, is_private_ip, quote_short_id_values, validate_public_host_addrs,
        validate_subscription_name, validate_subscription_url_with_ip,
    };

    #[test]
    fn test_mihomo_dns_answer_requires_verified_public_ip() {
        let public_a = serde_json::json!({
            "Answer": [{"type": 1, "data": "93.184.216.34"}]
        });
        assert_eq!(mihomo_dns_answer_is_private(&public_a), Some(false));

        let public_aaaa = serde_json::json!({
            "Answer": [{"type": 28, "data": "2606:4700:4700::1111"}]
        });
        assert_eq!(mihomo_dns_answer_is_private(&public_aaaa), Some(false));

        for json in [
            serde_json::json!({"Answer": [{"type": 1, "data": "10.0.0.1"}]}),
            serde_json::json!({"Answer": [{"type": 1, "data": "192.168.1.1"}]}),
            serde_json::json!({"Answer": [{"type": 1, "data": "127.0.0.1"}]}),
        ] {
            assert_eq!(mihomo_dns_answer_is_private(&json), Some(true));
        }

        for json in [
            serde_json::json!({"Answer": []}),
            serde_json::json!({"Status": 0}),
            serde_json::json!({"Answer": [{"type": 1, "data": "not-an-ip"}]}),
            serde_json::json!({"Answer": [{"type": 1, "data": "198.18.0.1"}]}),
        ] {
            assert_eq!(mihomo_dns_answer_is_private(&json), None);
        }
    }

    #[test]
    fn test_is_private_ip_v4() {
        assert!(is_private_ip("10.0.0.1".parse().unwrap()));
        assert!(is_private_ip("172.16.0.1".parse().unwrap()));
        assert!(is_private_ip("192.168.1.1".parse().unwrap()));
        assert!(is_private_ip("127.0.0.1".parse().unwrap()));
        assert!(is_private_ip("169.254.1.1".parse().unwrap()));
        assert!(is_private_ip("0.0.0.0".parse().unwrap()));
        assert!(!is_private_ip("198.18.0.1".parse().unwrap()));
        assert!(is_mihomo_fake_ip("198.18.0.1".parse().unwrap()));
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
            candidate_node: Some("CandidateNode".to_owned()),
            active_config: Some("profile.yaml".to_owned()),
            mode_switched: true,
            node_switched: true,
        };
        let serialized = serde_json::to_string(&marker).unwrap();
        let deserialized: super::GlobalModeRestoreMarker =
            serde_json::from_str(&serialized).unwrap();
        assert_eq!(marker, deserialized);

        let marker_mode_only = super::GlobalModeRestoreMarker {
            orig_mode: Some("rule".to_owned()),
            orig_global_now: None,
            candidate_node: None,
            active_config: None,
            mode_switched: true,
            node_switched: false,
        };
        let serialized2 = serde_json::to_string(&marker_mode_only).unwrap();
        let deserialized2: super::GlobalModeRestoreMarker =
            serde_json::from_str(&serialized2).unwrap();
        assert_eq!(marker_mode_only, deserialized2);

        // Verify backward compatibility when active_config and candidate_node are missing in JSON
        let legacy_json = r#"{"orig_mode":"rule","orig_global_now":"Node1"}"#;
        let legacy_deserialized: super::GlobalModeRestoreMarker =
            serde_json::from_str(legacy_json).unwrap();
        assert_eq!(legacy_deserialized.orig_mode.as_deref(), Some("rule"));
        assert_eq!(
            legacy_deserialized.orig_global_now.as_deref(),
            Some("Node1")
        );
        assert_eq!(legacy_deserialized.candidate_node, None);
        assert_eq!(legacy_deserialized.active_config, None);
        assert!(!legacy_deserialized.mode_switched);
        assert!(!legacy_deserialized.node_switched);
    }

    #[test]
    fn test_global_mode_restore_marker_from_tmp_file() {
        let temp_dir = tempfile::tempdir().unwrap();
        let marker_file = temp_dir.path().join(".subscription-global-restore");
        let tmp_file = temp_dir.path().join(".subscription-global-restore.tmp");

        let marker = super::GlobalModeRestoreMarker {
            orig_mode: Some("rule".to_owned()),
            orig_global_now: Some("NodeA".to_owned()),
            candidate_node: Some("CandA".to_owned()),
            active_config: Some("run_config.yaml".to_owned()),
            mode_switched: false,
            node_switched: false,
        };
        std::fs::write(&tmp_file, serde_json::to_string(&marker).unwrap()).unwrap();

        // 1. When primary file doesn't exist, read_restore_marker_at falls back to tmp
        assert!(!marker_file.exists());
        assert!(tmp_file.exists());
        let recovered = super::read_restore_marker_at(&marker_file).unwrap();
        assert_eq!(recovered, marker);

        // 2. When primary file exists but is empty/whitespace, falls back to tmp
        std::fs::write(&marker_file, "  \n").unwrap();
        let recovered_from_empty = super::read_restore_marker_at(&marker_file).unwrap();
        assert_eq!(recovered_from_empty, marker);
        let _ = std::fs::remove_file(&marker_file);

        // 3. When tmp file is malformed, returns None and deletes the malformed tmp file
        std::fs::write(&tmp_file, "{not valid json").unwrap();
        assert!(super::read_restore_marker_at(&marker_file).is_none());
        assert!(!tmp_file.exists());

        // 4. When marker has no restore fields, returns None and cleans up
        let empty_marker = super::GlobalModeRestoreMarker {
            orig_mode: None,
            orig_global_now: None,
            candidate_node: None,
            active_config: None,
            mode_switched: false,
            node_switched: false,
        };
        std::fs::write(&marker_file, serde_json::to_string(&empty_marker).unwrap()).unwrap();
        assert!(super::read_restore_marker_at(&marker_file).is_none());
        assert!(!marker_file.exists());
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

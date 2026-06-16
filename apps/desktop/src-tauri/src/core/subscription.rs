use std::time::Duration;
use tauri::{AppHandle, Manager as _, State};

use super::fetch_util::fetch_url_content;
use zephyr_core::config::sanitizer::remove_dangerous_keys_internal_pub as remove_dangerous_keys;
use zephyr_core::config::subscription::{
    classify_sub_error, extract_name_from_rules, is_private_host, is_private_ip,
    parse_content_disposition_filename, quote_short_id_values, redact_url_in_string,
    try_decode_base64_content, validate_subscription_name, validate_subscription_url_with_ip,
};

use super::core_process::ensure_app_storage;
use super::crypto::{load_metadata, save_metadata, write_profile_file};
use super::{MihomoState, MAX_RESPONSE_SIZE};
#[allow(unused_imports)]
use crate::emit_warn;

fn build_http_client_with_proxy(
    user_agent: Option<&str>,
    resolve_pin: Option<(String, std::net::SocketAddr)>,
    proxy_url: Option<String>,
) -> Result<reqwest::Client, String> {
    let redirect_policy = reqwest::redirect::Policy::custom(|attempt| {
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
            Err(e) => return attempt.error(format!("Failed to resolve redirect host {host}: {e}")),
        }

        attempt.follow()
    });

    let mut client_builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .connect_timeout(Duration::from_secs(5))
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

/// 获取 mihomo API 的客户端、URL 和 secret。
/// 失败时返回 None（核心未运行或端口未就绪）。
fn mihomo_api_client(app: &AppHandle) -> Option<(reqwest::Client, String, String)> {
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
        .timeout(Duration::from_secs(2))
        .build()
        .ok()?;
    let url = format!("http://127.0.0.1:{api_port}/configs");
    Some((client, url, secret))
}

/// 获取 mihomo 当前的代理模式（rule / global / direct）。
/// 失败时返回 None，调用方可据此跳过 global 回退。
async fn get_mihomo_mode(app: &AppHandle) -> Option<String> {
    let (client, url, secret) = mihomo_api_client(app)?;
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
    let (client, url, secret) = mihomo_api_client(app)?;
    let mut req = client
        .patch(&url)
        .json(&serde_json::json!({ "mode": mode }));
    if !secret.is_empty() {
        req = req.bearer_auth(&secret);
    }
    let resp = req.send().await.ok()?;
    resp.status().is_success().then_some(())
}

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

    let (host, resolved_addr, user_entered_private) = validate_subscription_url_with_ip(&url)?;
    // For user-entered private addresses, skip DNS pinning (proxy/system handles resolution).
    // For public addresses, use DNS pinning to prevent DNS rebinding.
    let resolve_pin = if user_entered_private {
        None
    } else {
        resolved_addr.map(|addr| (host.clone(), addr))
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

    let mut last_error = String::new();
    let mut result: Option<(Vec<u8>, String, String, Option<String>)> = None;

    // Try direct connection first
    let direct_error =
        match build_http_client_with_proxy(user_agent.as_deref(), resolve_pin.clone(), None) {
            Ok(client) => match do_download(client, url.clone()).await {
                Ok(data) => {
                    result = Some(data);
                    None
                }
                Err(e) => Some(format!("Direct: {e}")),
            },
            Err(e) => Some(format!("Direct client build: {e}")),
        };

    if result.is_none() {
        // Get proxy port from state, then immediately release the lock
        let proxy_url = {
            let state = app.state::<MihomoState>();
            let guard = state.0.lock().ok();
            guard.and_then(|g| {
                g.process()
                    .is_some()
                    .then(|| format!("http://127.0.0.1:{}", g.last_proxy_port().unwrap_or(7890)))
            })
        };

        if let Some(proxy_url_val) = proxy_url {
            // When using proxy, skip DNS pre-resolve pinning to let the proxy
            // handle DNS resolution (avoids issues with CDN / geo-balanced IPs).
            //
            // SSRF protection coverage for proxy paths:
            // - ✅ Initial URL host validated (private host check before any request)
            // - ✅ Redirect policy blocks redirects to private hosts/IPs
            // - ⚠️  Proxy-side SSRF (proxy resolving to internal IPs) is NOT
            //     preventable client-side — this is inherent to any proxy architecture.
            //     Mitigate by only configuring trusted proxies.
            let client_mihomo = build_http_client_with_proxy(
                user_agent.as_deref(),
                None,
                Some(proxy_url_val.clone()),
            );
            match client_mihomo {
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
                    }
                }
            }

            // ── Tier 3: 临时切换 global 模式重试 ──────────────────────────────
            // 直连和普通代理都失败后，尝试临时把 mihomo 切到 global 模式，
            // 让所有流量走当前选中的代理节点（绕过分流规则可能导致的不可达），
            // 下载完成后切回原模式。
            if result.is_none() {
                // 只有成功获取到当前模式且不是 global 时才切换，
                // 否则切到 global 后无法切回（original_mode 为 None 时跳过恢复）。
                if let Some(orig) = get_mihomo_mode(app).await {
                    if orig != "global" && set_mihomo_mode(app, "global").await.is_some() {
                        // 切换后短暂等待 mihomo 生效
                        tokio::time::sleep(Duration::from_millis(300)).await;

                        let client_global = build_http_client_with_proxy(
                            user_agent.as_deref(),
                            None,
                            Some(proxy_url_val),
                        );
                        match client_global {
                            Ok(client) => match do_download(client, url).await {
                                Ok(data) => {
                                    result = Some(data);
                                }
                                Err(e) => {
                                    last_error = if last_error.is_empty() {
                                        format!("Global-mode: {e}")
                                    } else {
                                        format!("{last_error} | Global-mode: {e}")
                                    };
                                }
                            },
                            Err(e) => {
                                last_error = if last_error.is_empty() {
                                    format!("Global-mode client build: {e}")
                                } else {
                                    format!("{last_error} | Global-mode client build: {e}")
                                };
                            }
                        }

                        // 无论成功失败都切回原模式；失败时记录日志便于诊断
                        // （若不恢复，core 会停留在 global 模式，可能导致意外的流量/路由问题）
                        if set_mihomo_mode(app, &orig).await.is_none() {
                            eprintln!(
                                "[subscription] failed to restore original mihomo mode '{orig}'"
                            );
                        }
                    }
                }
            }
        }
    }

    // Two-tier download strategy: direct → Mihomo proxy.
    // System proxy fallback is intentionally removed to reduce SSRF attack surface.
    // The Mihomo proxy path is trusted (user-configured), while system proxy
    // could be set by any application/malware on the system.
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

    let mut metadata = load_metadata(&paths);
    // Preserve existing auto_update_interval and per-subscription user_agent
    // to avoid silently resetting user-configured settings
    let (preserved_interval, preserved_ua) = metadata
        .configs
        .get(&clean_name)
        .map(|m| (m.auto_update_interval, m.user_agent.clone()))
        .unwrap_or((None, None));
    metadata.configs.insert(
        clean_name.clone(),
        super::crypto::ConfigMetadata {
            url: Some(final_url),
            sub_info: if sub_info_header.is_empty() {
                None
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
    let final_content = content;

    // Best-effort atomic config + metadata update (compensating transactions, not ACID):
    //   Overwrite: target -> backup, temp -> target, save_metadata, cleanup backup
    //   New:      temp -> target, save_metadata, remove target on failure
    // Crash between steps may leave .bak.<uuid> residuals — cleaned up at startup.
    let is_overwrite = target_path.exists();

    // Use UUID suffix to avoid conflicts from concurrent updates or crash residuals
    let unique_id = uuid::Uuid::new_v4().to_string()[..8].to_owned();
    let backup_path =
        is_overwrite.then(|| target_path.with_extension(format!("yaml.bak.{unique_id}")));
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

    // Overwrite: move old config to backup first
    if let Some(bp) = backup_path.as_ref() {
        std::fs::rename(&target_path, bp).map_err(|e| {
            let _ = std::fs::remove_file(&temp_path);
            format!("Failed to backup existing config (update aborted): {e}")
        })?;
    }

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

    // Save metadata — last step so failure can be cleanly rolled back
    if let Err(e) = save_metadata(&paths, &metadata) {
        // Rollback config to previous state
        let _ = std::fs::remove_file(&target_path);
        if let Some(bp) = backup_path.as_ref() {
            if bp.exists() {
                let _ = std::fs::rename(bp, &target_path);
            }
        }
        return Err(format!("Metadata save failed (config rolled back): {e}"));
    }

    // Success — clean up backup
    if let Some(bp) = backup_path.as_ref() {
        let _ = std::fs::remove_file(bp);
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
        println!("Fetch failed: {e}");
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

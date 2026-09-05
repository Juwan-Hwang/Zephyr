use std::net::IpAddr;
use std::path::PathBuf;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::process::Command;
use tauri::command;
use tauri::AppHandle;

#[cfg(target_os = "windows")]
use std::ptr;
#[cfg(target_os = "windows")]
use windows_sys::Win32::Networking::WinInet::{
    InternetSetOptionW, INTERNET_OPTION_REFRESH, INTERNET_OPTION_SETTINGS_CHANGED,
};

#[cfg(target_os = "windows")]
use winreg::enums::HKEY_CURRENT_USER;
#[cfg(target_os = "windows")]
use winreg::RegKey;

// ── System Proxy Ownership Guard ─────────────────────────────────────────
//
// When Zephyr enables the system proxy, it writes an ownership marker file
// (`.sys-proxy-ownership`) to the app data directory containing the server
// address. On every periodic sync (10 s), if the marker exists but the system
// proxy has been disabled by an external program, Zephyr automatically
// re-enables it. On normal exit the marker is deleted together with the proxy.
// If the app crashes, the marker persists and the proxy is restored on next
// launch.

/// Name of the ownership marker file (stored in app data dir).
const OWNERSHIP_FILE: &str = ".sys-proxy-ownership";

/// Return the path to the ownership marker file.
fn ownership_path(app: &AppHandle) -> Option<PathBuf> {
    crate::core_manager::resolve_app_paths(app)
        .ok()
        .map(|p| p.app_data_dir.join(OWNERSHIP_FILE))
}

/// Write the ownership marker with the given server address.
fn write_ownership(app: &AppHandle, server: &str) {
    if let Some(path) = ownership_path(app) {
        if let Err(e) = std::fs::write(&path, server) {
            emit_warn!(
                System,
                SYS_PROXY_FAILED,
                "Failed to write proxy ownership marker: {e}"
            );
        }
    }
}

/// Delete the ownership marker file.
fn remove_ownership(app: &AppHandle) {
    if let Some(path) = ownership_path(app) {
        let _ = std::fs::remove_file(path);
    }
}

/// Read the server address from the ownership marker, if it exists.
#[must_use]
pub fn read_ownership(app: &AppHandle) -> Option<String> {
    let path = ownership_path(app)?;
    std::fs::read_to_string(path)
        .ok()
        .filter(|s| !s.trim().is_empty())
}

/// Check whether Zephyr currently owns the system proxy (marker exists).
#[must_use]
pub fn has_ownership(app: &AppHandle) -> bool {
    read_ownership(app).is_some()
}

/// Restore the system proxy from the ownership marker.
/// Called during startup (crash recovery) and during periodic guard checks.
#[command]
#[allow(clippy::needless_pass_by_value)]
pub fn restore_sys_proxy(app: AppHandle) -> Result<(), String> {
    let server = read_ownership(&app).ok_or("No proxy ownership marker found")?;
    enable_sysproxy(app, server, None)?;
    Ok(())
}

/// Clean up the ownership marker on normal exit.
pub fn cleanup_ownership(app: &AppHandle) {
    remove_ownership(app);
}

// ── Proxy validation ────────────────────────────────────────────────────
/// This prevents proxy hijacking by ensuring only loopback addresses are allowed.
fn validate_proxy_server(server: &str) -> Result<(), String> {
    if server.is_empty() {
        return Err("Proxy server address cannot be empty".to_owned());
    }
    if server.len() > 512 {
        return Err("Proxy server address too long".to_owned());
    }
    if server.contains('\n') || server.contains('\r') || server.contains('\0') {
        return Err("Proxy server address contains invalid characters".to_owned());
    }

    // Parse host and port from server string
    let (host, port_str) = parse_host_port(server)?;

    // Reject port 0 — OS would assign a random port, causing confusion
    if port_str == "0" {
        return Err("Port 0 is not allowed (OS would assign a random port)".to_owned());
    }

    // Validate that host is a loopback address
    // First try to parse as IP address directly
    if let Ok(ip) = host.parse::<IpAddr>() {
        if !ip.is_loopback() {
            return Err(
                "Only loopback addresses (127.0.0.1, ::1) are allowed for security reasons"
                    .to_owned(),
            );
        }
        return Ok(());
    }

    // Handle special hostname cases
    let host_lower = host.to_lowercase();
    if host_lower == "localhost" {
        return Ok(());
    }

    // Reject any other hostname that's not localhost
    // This prevents attacks like "127.0.0.1.evil.com"
    Err(format!(
        "Invalid proxy host '{host}': only localhost, 127.0.0.1, or ::1 are allowed"
    ))
}

/// Parse host and port from a proxy server string.
/// Handles formats: "host:port", "[ipv6]:port", "localhost:port"
fn parse_host_port(server: &str) -> Result<(String, String), String> {
    if server.is_empty() {
        return Err("Proxy server address cannot be empty".to_owned());
    }

    // Handle IPv6 literal with port, e.g. [::1]:8080
    if server.starts_with('[') {
        if let Some(end_bracket) = server.rfind(']') {
            let host = server[1..end_bracket].to_owned();
            let remainder = &server[end_bracket + 1..];
            if let Some(port_str) = remainder.strip_prefix(':') {
                let port = port_str.trim().to_owned();
                if !port.is_empty() {
                    // Validate port is a valid number
                    if port.parse::<u16>().is_err() {
                        return Err(format!("Invalid port number: {port}"));
                    }
                    return Ok((host, port));
                }
            }
        }
        return Err("Invalid IPv6 proxy format, expected [host]:port".to_owned());
    }

    // Handle IPv4 or hostname
    if let Some(last_colon) = server.rfind(':') {
        let host = server[..last_colon].trim().to_owned();
        let port = server[last_colon + 1..].trim().to_owned();
        if !host.is_empty() && !port.is_empty() {
            // Validate port is a valid number
            if port.parse::<u16>().is_err() {
                return Err(format!("Invalid port number: {port}"));
            }
            return Ok((host, port));
        }
    }

    Err("Invalid proxy server format, expected host:port".to_owned())
}

#[cfg(target_os = "macos")]
fn run_networksetup(args: &[&str]) -> Result<(), String> {
    let status = Command::new("networksetup")
        .args(args)
        .status()
        .map_err(|e| format!("Failed to execute networksetup: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("networksetup failed: {:?}", args))
    }
}

/// Dynamically get all network services from macOS with a bounded timeout
#[cfg(target_os = "macos")]
fn get_network_services_bounded(timeout: std::time::Duration) -> Vec<String> {
    let mut cmd = Command::new("networksetup");
    cmd.arg("-listallnetworkservices");
    let output = match run_cmd_bounded(cmd, timeout) {
        Some(out) => out,
        None => return vec!["Wi-Fi".to_owned(), "Ethernet".to_owned()],
    };

    if !output.status.success() {
        return vec!["Wi-Fi".to_owned(), "Ethernet".to_owned()];
    }

    let text = String::from_utf8_lossy(&output.stdout);
    let mut services = Vec::new();

    for (i, line) in text.lines().enumerate() {
        // Skip the first line (it's a comment like "An asterisk (*) denotes...")
        if i == 0 {
            continue;
        }

        let trimmed = line.trim();

        // Skip empty lines and disabled services (marked with *)
        if trimmed.is_empty() || trimmed.starts_with('*') {
            continue;
        }

        services.push(trimmed.to_owned());
    }

    // Fallback to defaults if no services found
    if services.is_empty() {
        return vec!["Wi-Fi".to_owned(), "Ethernet".to_owned()];
    }

    services
}

/// Dynamically get all network services from macOS
#[cfg(target_os = "macos")]
fn get_network_services() -> Vec<String> {
    get_network_services_bounded(std::time::Duration::from_millis(800))
}

#[cfg(target_os = "macos")]
fn apply_networksetup_for_services<F>(mut op: F) -> Result<(), String>
where
    F: FnMut(&str) -> Result<(), String>,
{
    let services = get_network_services();
    let mut last_err: Option<String> = None;
    let mut any_success = false;
    for service in &services {
        match op(service) {
            Ok(_) => any_success = true,
            Err(err) => last_err = Some(err),
        }
    }
    if any_success {
        Ok(())
    } else {
        Err(last_err.unwrap_or_else(|| "No network services available".to_owned()))
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn kill_child_and_descendants(child: &mut std::process::Child) {
    if let Ok(pid) = i32::try_from(child.id()) {
        if pid > 0 {
            // SAFETY: We send SIGKILL to the process group created for this child (pgid == pid).
            // The child was spawned in its own process group via `process_group(0)`, so killing `-pid`
            // cleanly terminates the child and any descendants holding inherited file descriptors.
            unsafe {
                libc::kill(-pid, libc::SIGKILL);
            }
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn run_cmd_bounded(mut cmd: Command, timeout: std::time::Duration) -> Option<std::process::Output> {
    use std::os::unix::process::CommandExt as _;

    cmd.process_group(0);
    let mut child = cmd
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;

    let mut stdout = child.stdout.take()?;
    let (tx, rx) = std::sync::mpsc::channel();
    let reader_handle = std::thread::spawn(move || {
        use std::io::Read as _;
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        let _ = tx.send(buf);
    });

    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                // The child has exited, so the reader thread only drains buffered
                // pipe data. Use a fixed grace window instead of the remaining
                // budget, which can already be zero at the deadline boundary.
                let stdout_bytes = rx
                    .recv_timeout(std::time::Duration::from_millis(200))
                    .unwrap_or_default();
                let _ = reader_handle.join();
                return Some(std::process::Output {
                    status,
                    stdout: stdout_bytes,
                    stderr: Vec::new(),
                });
            }
            Ok(None) => {
                if start.elapsed() >= timeout {
                    kill_child_and_descendants(&mut child);
                    let _ = rx.recv_timeout(std::time::Duration::from_millis(100));
                    let _ = reader_handle.join();
                    return None;
                }
                std::thread::sleep(std::time::Duration::from_millis(15));
            }
            Err(_) => {
                kill_child_and_descendants(&mut child);
                let _ = rx.recv_timeout(std::time::Duration::from_millis(100));
                let _ = reader_handle.join();
                return None;
            }
        }
    }
}

#[cfg(any(test, target_os = "linux"))]
fn push_normalized_proxy_part(parts: &mut Vec<String>, raw: &str, tag: &str) {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "false" {
        return;
    }
    let mut normalized = trimmed.to_owned();
    if let Some(rest) = normalized.strip_prefix("socks://") {
        normalized = format!("socks5://{rest}");
    }
    if normalized.ends_with(":0") {
        return;
    }
    if normalized.contains('=') {
        parts.push(normalized);
    } else {
        parts.push(format!("{tag}={normalized}"));
    }
}

#[cfg(target_os = "linux")]
fn run_cmd_bounded_status(mut cmd: Command, timeout: std::time::Duration) -> bool {
    use std::os::unix::process::CommandExt as _;

    cmd.process_group(0);
    let mut child = match cmd
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) => {
                if start.elapsed() >= timeout {
                    kill_child_and_descendants(&mut child);
                    return false;
                }
                std::thread::sleep(std::time::Duration::from_millis(15));
            }
            Err(_) => {
                kill_child_and_descendants(&mut child);
                return false;
            }
        }
    }
}

#[cfg(target_os = "linux")]
fn is_cmd_available_bounded(cmd: &str, timeout: std::time::Duration) -> bool {
    let mut command = Command::new(cmd);
    command.arg("--help");
    run_cmd_bounded_status(command, timeout)
}

#[cfg(target_os = "linux")]
fn get_kde_cmd_bounded(timeout: std::time::Duration) -> Option<(&'static str, &'static str)> {
    if is_cmd_available_bounded("kwriteconfig6", timeout) {
        Some(("kwriteconfig6", "kreadconfig6"))
    } else if is_cmd_available_bounded("kwriteconfig5", timeout) {
        Some(("kwriteconfig5", "kreadconfig5"))
    } else {
        None
    }
}

#[cfg(target_os = "linux")]
fn get_kde_cmd() -> Option<(&'static str, &'static str)> {
    get_kde_cmd_bounded(std::time::Duration::from_millis(800))
}

#[cfg(target_os = "linux")]
fn has_gnome_bounded(timeout: std::time::Duration) -> bool {
    let mut cmd = Command::new("gsettings");
    cmd.args(["get", "org.gnome.system.proxy", "mode"]);
    run_cmd_bounded_status(cmd, timeout)
}

#[cfg(target_os = "linux")]
fn has_gnome() -> bool {
    has_gnome_bounded(std::time::Duration::from_millis(800))
}

#[cfg(target_os = "linux")]
fn has_xfce_bounded(timeout: std::time::Duration) -> bool {
    is_cmd_available_bounded("xfconf-query", timeout)
}

#[cfg(target_os = "linux")]
fn has_xfce() -> bool {
    has_xfce_bounded(std::time::Duration::from_millis(800))
}

/// Run a gsettings command and return whether it succeeded.
#[cfg(target_os = "linux")]
fn gsettings_set(schema: &str, key: &str, value: &str) -> bool {
    Command::new("gsettings")
        .args(["set", schema, key, value])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Enable system proxy on GNOME desktop environment.
/// Returns true if all settings were applied successfully.
#[cfg(target_os = "linux")]
fn enable_gnome_proxy(host: &str, port: &str, bypass: Option<&str>) -> bool {
    let mut ok = true;

    // Configure all proxy details atomically
    ok &= gsettings_set("org.gnome.system.proxy.http", "host", host);
    if ok {
        ok &= gsettings_set("org.gnome.system.proxy.http", "port", port);
    }
    if ok {
        ok &= gsettings_set("org.gnome.system.proxy.https", "host", host);
    }
    if ok {
        ok &= gsettings_set("org.gnome.system.proxy.https", "port", port);
    }
    if ok {
        ok &= gsettings_set("org.gnome.system.proxy.socks", "host", host);
    }
    if ok {
        ok &= gsettings_set("org.gnome.system.proxy.socks", "port", port);
    }

    // Set bypass list if provided
    if ok {
        if let Some(bp) = bypass {
            let hosts: Vec<String> = bp
                .split(',')
                .map(|h| h.trim().to_owned())
                .filter(|h| !h.is_empty() && !h.contains('\''))
                .map(|h| format!("'{h}'"))
                .collect();

            if !hosts.is_empty() {
                let formatted_bp = format!("[{}]", hosts.join(", "));
                ok &= gsettings_set("org.gnome.system.proxy", "ignore-hosts", &formatted_bp);
            }
        }
    }

    // Only enable the proxy mode if all previous settings succeeded
    if ok {
        if let Ok(status) = Command::new("gsettings")
            .args(["set", "org.gnome.system.proxy", "mode", "manual"])
            .status()
        {
            return status.success();
        }
    } else {
        // Rollback: disable proxy mode if settings failed
        let _ = Command::new("gsettings")
            .args(["set", "org.gnome.system.proxy", "mode", "none"])
            .status();
        emit_warn!(
            System,
            SYS_PROXY_FAILED,
            "Failed to set all GNOME proxy settings, rolling back"
        );
    }
    false
}

/// Enable system proxy on KDE desktop environment.
/// Returns true if all settings were applied successfully.
#[cfg(target_os = "linux")]
fn enable_kde_proxy(kwrite_cmd: &str, host: &str, port: &str) -> bool {
    let mut ok = true;

    ok &= Command::new(kwrite_cmd)
        .args([
            "--file",
            "kioslaverc",
            "--group",
            "Proxy Settings",
            "--key",
            "httpProxy",
            &format!("http://{host}:{port}"),
        ])
        .status()
        .map(|s| s.success())
        .unwrap_or(false);

    if ok {
        ok &= Command::new(kwrite_cmd)
            .args([
                "--file",
                "kioslaverc",
                "--group",
                "Proxy Settings",
                "--key",
                "httpsProxy",
                &format!("http://{host}:{port}"),
            ])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
    }

    if ok {
        ok &= Command::new(kwrite_cmd)
            .args([
                "--file",
                "kioslaverc",
                "--group",
                "Proxy Settings",
                "--key",
                "socksProxy",
                &format!("socks://{host}:{port}"),
            ])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
    }

    if ok {
        if let Ok(status) = Command::new(kwrite_cmd)
            .args([
                "--file",
                "kioslaverc",
                "--group",
                "Proxy Settings",
                "--key",
                "ProxyType",
                "1",
            ])
            .status()
        {
            if status.success() {
                let _ = Command::new("dbus-send")
                    .args([
                        "--type=method_call",
                        "--dest=org.kde.KIODaemon",
                        "/KIODaemon",
                        "org.kde.KIODaemon.update",
                    ])
                    .status();
                let _ = Command::new("dbus-send")
                    .args([
                        "--type=method_call",
                        "--dest=org.kde.KWin",
                        "/KWin",
                        "org.kde.KWin.reconfigure",
                    ])
                    .status();
                return true;
            }
        }
    } else {
        // Rollback: disable proxy
        let _ = Command::new(kwrite_cmd)
            .args([
                "--file",
                "kioslaverc",
                "--group",
                "Proxy Settings",
                "--key",
                "ProxyType",
                "0",
            ])
            .status();
        emit_warn!(
            System,
            SYS_PROXY_FAILED,
            "Failed to set all KDE proxy settings, rolling back"
        );
    }
    false
}

/// Enable system proxy on XFCE desktop environment.
/// Returns true if all settings were applied successfully.
#[cfg(target_os = "linux")]
fn enable_xfce_proxy(host: &str, port: &str) -> bool {
    let proxy_addr = format!("{host}:{port}");
    let mut all_success = true;
    for proxy_type in &["HTTP", "HTTPS", "SOCKS"] {
        if let Ok(status) = Command::new("xfconf-query")
            .args([
                "-c",
                "xfce4-session",
                "-p",
                &format!("/proxies/{proxy_type}"),
                "-s",
                &proxy_addr,
                "-n",
                "-t",
                "string",
            ])
            .status()
        {
            if !status.success() {
                all_success = false;
            }
        } else {
            all_success = false;
        }
    }
    all_success
}

#[command]
#[allow(clippy::needless_pass_by_value)]
pub fn enable_sysproxy(
    app: AppHandle,
    server: String,
    bypass: Option<String>,
) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        validate_proxy_server(&server)?;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let path = "Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
        let (key, _) = hkcu.create_subkey(path).map_err(|e| e.to_string())?;

        // 备份旧值
        let old_enable: u32 = key.get_value("ProxyEnable").unwrap_or(0);
        let old_server: String = key.get_value("ProxyServer").unwrap_or_default();
        let old_override: String = key.get_value("ProxyOverride").unwrap_or_default();

        let proxy_override = bypass.unwrap_or_else(|| "<local>;localhost;127.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;172.30.*;172.31.*;192.168.*".to_owned());

        // 原子性写入（失败时回滚）
        if let Err(e) = (|| -> Result<(), String> {
            key.set_value("ProxyEnable", &1u32)
                .map_err(|e| e.to_string())?;
            key.set_value("ProxyServer", &server)
                .map_err(|e| e.to_string())?;
            key.set_value("ProxyOverride", &proxy_override)
                .map_err(|e| e.to_string())?;
            Ok(())
        })() {
            let _ = key.set_value("ProxyEnable", &old_enable);
            let _ = key.set_value("ProxyServer", &old_server);
            let _ = key.set_value("ProxyOverride", &old_override);
            return Err(format!("Failed to set proxy (rolled back): {e}"));
        }

        // SAFETY: InternetSetOptionW is called with null pointers and zero size for
        // INTERNET_OPTION_SETTINGS_CHANGED and INTERNET_OPTION_REFRESH, which is the
        // documented Microsoft pattern for notifying the system of proxy setting changes.
        #[allow(clippy::multiple_unsafe_ops_per_block)]
        unsafe {
            let res1 = InternetSetOptionW(
                ptr::null_mut(),
                INTERNET_OPTION_SETTINGS_CHANGED,
                ptr::null_mut(),
                0,
            );
            let res2 =
                InternetSetOptionW(ptr::null_mut(), INTERNET_OPTION_REFRESH, ptr::null_mut(), 0);
            if res1 == 0 || res2 == 0 {
                return Err("Failed to refresh system proxy settings".to_owned());
            }
        }

        write_ownership(&app, &server);
        Ok("System proxy enabled".to_owned())
    }

    #[cfg(target_os = "macos")]
    {
        let (host, port) = parse_host_port(&server)?;
        validate_proxy_server(&server)?;
        let bypass_clone = bypass.clone();
        apply_networksetup_for_services(|service| {
            // HTTP 代理
            run_networksetup(&["-setwebproxy", service, &host, &port])?;
            run_networksetup(&["-setwebproxystate", service, "on"])?;
            // HTTPS 代理
            run_networksetup(&["-setsecurewebproxy", service, &host, &port])?;
            run_networksetup(&["-setsecurewebproxystate", service, "on"])?;
            // SOCKS 代理
            run_networksetup(&["-setsocksfirewallproxy", service, &host, &port])?;
            run_networksetup(&["-setsocksfirewallproxystate", service, "on"])?;
            // 代理绕过列表
            if let Some(ref bp) = bypass_clone {
                run_networksetup(&["-setproxybypassdomains", service, bp])?;
            }
            Ok(())
        })?;
        write_ownership(&app, &server);
        Ok(format!("System proxy enabled on macOS (HTTP+HTTPS+SOCKS)"))
    }

    #[cfg(target_os = "linux")]
    {
        let (host, port) = parse_host_port(&server)?;
        validate_proxy_server(&server)?;

        let gnome_ok = has_gnome() && enable_gnome_proxy(&host, &port, bypass.as_deref());
        let kde_ok = get_kde_cmd().is_some_and(|(cmd, _)| enable_kde_proxy(cmd, &host, &port));
        let xfce_ok = has_xfce() && enable_xfce_proxy(&host, &port);
        let success = gnome_ok || kde_ok || xfce_ok;

        if success {
            write_ownership(&app, &server);
            Ok("System proxy enabled on Linux".to_owned())
        } else {
            Err(
                "Failed to enable system proxy on Linux: no supported desktop environment found."
                    .to_owned(),
            )
        }
    }
}

#[command]
#[allow(clippy::needless_pass_by_value)]
pub fn disable_sysproxy(app: AppHandle) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let path = "Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
        let (key, _) = hkcu.create_subkey(path).map_err(|e| e.to_string())?;

        key.set_value("ProxyEnable", &0u32)
            .map_err(|e| e.to_string())?;

        // SAFETY: Same as enable_sysproxy — InternetSetOptionW with null/zero params
        // is the documented pattern for refreshing proxy settings.
        #[allow(clippy::multiple_unsafe_ops_per_block)]
        unsafe {
            let res1 = InternetSetOptionW(
                ptr::null_mut(),
                INTERNET_OPTION_SETTINGS_CHANGED,
                ptr::null_mut(),
                0,
            );
            let res2 =
                InternetSetOptionW(ptr::null_mut(), INTERNET_OPTION_REFRESH, ptr::null_mut(), 0);
            if res1 == 0 || res2 == 0 {
                return Err("Failed to refresh system proxy settings".to_owned());
            }
        }

        remove_ownership(&app);
        Ok("System proxy disabled".to_owned())
    }

    #[cfg(target_os = "macos")]
    {
        apply_networksetup_for_services(|service| {
            run_networksetup(&["-setwebproxystate", service, "off"])?;
            run_networksetup(&["-setsecurewebproxystate", service, "off"])?;
            run_networksetup(&["-setsocksfirewallproxystate", service, "off"])?;
            Ok(())
        })?;
        remove_ownership(&app);
        Ok("System proxy disabled on macOS".to_owned())
    }

    #[cfg(target_os = "linux")]
    {
        let mut success = false;
        if has_gnome() {
            if let Ok(status) = Command::new("gsettings")
                .args(["set", "org.gnome.system.proxy", "mode", "none"])
                .status()
            {
                if status.success() {
                    let _ = Command::new("gsettings")
                        .args([
                            "set",
                            "org.gnome.system.proxy",
                            "ignore-hosts",
                            "['localhost', '127.0.0.0/8', '::1']",
                        ])
                        .status();
                    success = true;
                }
            }
        }

        if let Some((kwrite_cmd, _)) = get_kde_cmd() {
            if let Ok(status) = Command::new(kwrite_cmd)
                .args([
                    "--file",
                    "kioslaverc",
                    "--group",
                    "Proxy Settings",
                    "--key",
                    "ProxyType",
                    "0",
                ])
                .status()
            {
                if status.success() {
                    let _ = Command::new("dbus-send")
                        .args([
                            "--type=method_call",
                            "--dest=org.kde.KIODaemon",
                            "/KIODaemon",
                            "org.kde.KIODaemon.update",
                        ])
                        .status();
                    let _ = Command::new("dbus-send")
                        .args([
                            "--type=method_call",
                            "--dest=org.kde.KWin",
                            "/KWin",
                            "org.kde.KWin.reconfigure",
                        ])
                        .status();
                    success = true;
                }
            }
        }

        if has_xfce() {
            // XFCE - remove all proxy types
            let mut all_success = true;
            for proxy_type in &["HTTP", "HTTPS", "SOCKS"] {
                if let Ok(status) = Command::new("xfconf-query")
                    .args([
                        "-c",
                        "xfce4-session",
                        "-p",
                        &format!("/proxies/{proxy_type}"),
                        "-r",
                    ])
                    .status()
                {
                    if !status.success() {
                        all_success = false;
                    }
                } else {
                    all_success = false;
                }
            }
            if all_success {
                success = true;
            }
        }

        if success {
            remove_ownership(&app);
            Ok("System proxy disabled on Linux".to_owned())
        } else {
            Err(
                "Failed to disable system proxy on Linux: no supported desktop environment found."
                    .to_owned(),
            )
        }
    }
}

// 供内部调用（如退出时清理）
pub fn clear_sys_proxy(app: &AppHandle) -> Result<(), String> {
    let result = disable_sysproxy(app.clone());
    // Always clean up ownership marker even if disable failed,
    // to avoid a stale marker triggering unwanted restore on next launch.
    cleanup_ownership(app);
    result.map(|_| ())
}

/// Check whether Zephyr currently owns the system proxy (for frontend guard).
#[command]
#[must_use]
#[allow(clippy::needless_pass_by_value)]
pub fn has_sysproxy_ownership(app: AppHandle) -> bool {
    has_ownership(&app)
}

#[must_use]
pub fn get_sys_proxy_address() -> Option<String> {
    get_sys_proxy_address_with_deadline(
        std::time::Instant::now() + std::time::Duration::from_millis(1500),
    )
}

#[must_use]
pub fn get_sys_proxy_address_with_deadline(deadline: std::time::Instant) -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        let _ = deadline;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let path = "Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
        if let Ok(key) = hkcu.open_subkey(path) {
            let enable: u32 = key.get_value("ProxyEnable").unwrap_or(0);
            if enable == 1 {
                if let Ok(server) = key.get_value::<String, _>("ProxyServer") {
                    if !server.is_empty() {
                        if server.contains("://") || server.contains('=') {
                            return Some(server);
                        }
                        return Some(format!("http://{server}"));
                    }
                }
            }
        }
        None
    }
    #[cfg(target_os = "macos")]
    {
        let rem = deadline.saturating_duration_since(std::time::Instant::now());
        if rem < std::time::Duration::from_millis(50) {
            return None;
        }
        let services = get_network_services_bounded(std::time::Duration::from_millis(800).min(rem));
        for service in services {
            let rem_loop = deadline.saturating_duration_since(std::time::Instant::now());
            if rem_loop < std::time::Duration::from_millis(50) {
                break;
            }
            let parse_proxy = |proto: &str| -> Option<(String, String)> {
                let rem_cmd = deadline.saturating_duration_since(std::time::Instant::now());
                if rem_cmd < std::time::Duration::from_millis(50) {
                    return None;
                }
                let mut cmd = Command::new("networksetup");
                cmd.args([proto, &service]);
                let output =
                    run_cmd_bounded(cmd, std::time::Duration::from_millis(800).min(rem_cmd))?;
                let text = String::from_utf8_lossy(&output.stdout);
                let mut enabled = false;
                let mut host = String::new();
                let mut port = String::new();

                for line in text.lines() {
                    let trimmed = line.trim();
                    if let Some((key, val)) = trimmed.split_once(':') {
                        let k = key.trim();
                        let v = val.trim();
                        if k.eq_ignore_ascii_case("Enabled") {
                            enabled = v.contains("Yes");
                        } else if k.eq_ignore_ascii_case("Server") {
                            if v.parse::<std::net::Ipv6Addr>().is_ok() {
                                host = format!("[{v}]");
                            } else {
                                host = v.to_owned();
                            }
                        } else if k.eq_ignore_ascii_case("Port") {
                            port = v.to_owned();
                        }
                    }
                }

                if enabled && !host.is_empty() && !port.is_empty() && port != "0" {
                    Some((host, port))
                } else {
                    None
                }
            };

            let mut parts = Vec::new();
            if let Some((h, p)) = parse_proxy("-getwebproxy") {
                parts.push(format!("http={h}:{p}"));
            }
            if let Some((h, p)) = parse_proxy("-getsecurewebproxy") {
                parts.push(format!("https={h}:{p}"));
            }
            if let Some((h, p)) = parse_proxy("-getsocksfirewallproxy") {
                parts.push(format!("socks={h}:{p}"));
            }

            if !parts.is_empty() {
                return Some(parts.join(";"));
            }
        }
        None
    }
    #[cfg(target_os = "linux")]
    {
        let rem_gnome = deadline.saturating_duration_since(std::time::Instant::now());
        if rem_gnome >= std::time::Duration::from_millis(50)
            && has_gnome_bounded(std::time::Duration::from_millis(800).min(rem_gnome))
        {
            let rem_cmd = deadline.saturating_duration_since(std::time::Instant::now());
            if rem_cmd >= std::time::Duration::from_millis(50) {
                let mut m_cmd = Command::new("gsettings");
                m_cmd.args(["get", "org.gnome.system.proxy", "mode"]);
                if let Some(output) =
                    run_cmd_bounded(m_cmd, std::time::Duration::from_millis(800).min(rem_cmd))
                {
                    let mode = String::from_utf8_lossy(&output.stdout).trim().to_owned();
                    if mode == "'manual'" {
                        let mut parts = Vec::new();
                        let mut check_gnome_proxy = |schema: &str, tag: &str| {
                            let rem = deadline.saturating_duration_since(std::time::Instant::now());
                            if rem < std::time::Duration::from_millis(50) {
                                return;
                            }
                            let mut h_cmd = Command::new("gsettings");
                            h_cmd.args(["get", schema, "host"]);
                            if let Some(host_output) = run_cmd_bounded(
                                h_cmd,
                                std::time::Duration::from_millis(800).min(rem),
                            ) {
                                let raw_host = String::from_utf8_lossy(&host_output.stdout)
                                    .trim()
                                    .trim_matches('\'')
                                    .to_owned();
                                if !raw_host.is_empty() {
                                    let host = if raw_host.parse::<std::net::Ipv6Addr>().is_ok() {
                                        format!("[{raw_host}]")
                                    } else {
                                        raw_host
                                    };
                                    let rem_p = deadline
                                        .saturating_duration_since(std::time::Instant::now());
                                    if rem_p < std::time::Duration::from_millis(50) {
                                        return;
                                    }
                                    let mut p_cmd = Command::new("gsettings");
                                    p_cmd.args(["get", schema, "port"]);
                                    if let Some(port_output) = run_cmd_bounded(
                                        p_cmd,
                                        std::time::Duration::from_millis(800).min(rem_p),
                                    ) {
                                        let port = String::from_utf8_lossy(&port_output.stdout)
                                            .trim()
                                            .trim_matches('\'')
                                            .to_owned();
                                        if !port.is_empty() && port != "0" {
                                            parts.push(format!("{tag}={host}:{port}"));
                                        }
                                    }
                                }
                            }
                        };

                        check_gnome_proxy("org.gnome.system.proxy.http", "http");
                        check_gnome_proxy("org.gnome.system.proxy.https", "https");
                        check_gnome_proxy("org.gnome.system.proxy.socks", "socks");

                        if !parts.is_empty() {
                            return Some(parts.join(";"));
                        }
                    }
                }
            }
        }

        let rem_kde = deadline.saturating_duration_since(std::time::Instant::now());
        if rem_kde >= std::time::Duration::from_millis(50) {
            if let Some((_, kread_cmd)) =
                get_kde_cmd_bounded(std::time::Duration::from_millis(800).min(rem_kde))
            {
                let rem_cmd = deadline.saturating_duration_since(std::time::Instant::now());
                if rem_cmd >= std::time::Duration::from_millis(50) {
                    let mut k_cmd = Command::new(kread_cmd);
                    k_cmd.args([
                        "--file",
                        "kioslaverc",
                        "--group",
                        "Proxy Settings",
                        "--key",
                        "ProxyType",
                    ]);
                    if let Some(output) =
                        run_cmd_bounded(k_cmd, std::time::Duration::from_millis(800).min(rem_cmd))
                    {
                        let ptype = String::from_utf8_lossy(&output.stdout).trim().to_owned();
                        if ptype == "1" {
                            let mut parts = Vec::new();
                            let mut check_kde_proxy = |key: &str, tag: &str| {
                                let rem =
                                    deadline.saturating_duration_since(std::time::Instant::now());
                                if rem < std::time::Duration::from_millis(50) {
                                    return;
                                }
                                let mut cmd = Command::new(kread_cmd);
                                cmd.args([
                                    "--file",
                                    "kioslaverc",
                                    "--group",
                                    "Proxy Settings",
                                    "--key",
                                    key,
                                ]);
                                if let Some(proxy_output) = run_cmd_bounded(
                                    cmd,
                                    std::time::Duration::from_millis(800).min(rem),
                                ) {
                                    let raw_proxy = String::from_utf8_lossy(&proxy_output.stdout);
                                    let trimmed = raw_proxy.trim();
                                    let normalized = match trimmed.rsplit_once(' ') {
                                        Some((head, tail))
                                            if tail.parse::<u16>().is_ok() && !head.is_empty() =>
                                        {
                                            format!("{}:{tail}", head.trim_end())
                                        }
                                        _ => trimmed.to_owned(),
                                    };
                                    push_normalized_proxy_part(&mut parts, &normalized, tag);
                                }
                            };

                            check_kde_proxy("httpProxy", "http");
                            check_kde_proxy("httpsProxy", "https");
                            check_kde_proxy("socksProxy", "socks");

                            if !parts.is_empty() {
                                return Some(parts.join(";"));
                            }
                        }
                    }
                }
            }
        }

        let rem_xfce = deadline.saturating_duration_since(std::time::Instant::now());
        if rem_xfce >= std::time::Duration::from_millis(50)
            && has_xfce_bounded(std::time::Duration::from_millis(800).min(rem_xfce))
        {
            let mut parts = Vec::new();
            let mut check_xfce_proxy = |prop: &str, tag: &str| {
                let rem = deadline.saturating_duration_since(std::time::Instant::now());
                if rem < std::time::Duration::from_millis(50) {
                    return;
                }
                let mut cmd = Command::new("xfconf-query");
                cmd.args(["-c", "xfce4-session", "-p", prop]);
                if let Some(output) =
                    run_cmd_bounded(cmd, std::time::Duration::from_millis(800).min(rem))
                {
                    let raw = String::from_utf8_lossy(&output.stdout);
                    push_normalized_proxy_part(&mut parts, &raw, tag);
                }
            };

            check_xfce_proxy("/proxies/HTTP", "http");
            check_xfce_proxy("/proxies/HTTPS", "https");
            check_xfce_proxy("/proxies/SOCKS", "socks");

            if !parts.is_empty() {
                return Some(parts.join(";"));
            }
        }

        None
    }
}

#[command]
pub fn get_sys_proxy() -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let path = "Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
        let key = hkcu.open_subkey(path).map_err(|e| e.to_string())?;
        let enable: u32 = key.get_value("ProxyEnable").unwrap_or(0);
        Ok(enable == 1)
    }
    #[cfg(target_os = "macos")]
    {
        let services = get_network_services();
        for service in services {
            if let Ok(output) = Command::new("networksetup")
                .args(["-getsocksfirewallproxy", &service])
                .output()
            {
                let text = String::from_utf8_lossy(&output.stdout);
                if text
                    .lines()
                    .any(|line| line.trim().eq_ignore_ascii_case("Enabled: Yes"))
                {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }
    #[cfg(target_os = "linux")]
    {
        let mut is_active = false;

        if has_gnome() {
            if let Ok(output) = Command::new("gsettings")
                .arg("get")
                .arg("org.gnome.system.proxy")
                .arg("mode")
                .output()
            {
                let mode = String::from_utf8_lossy(&output.stdout).trim().to_owned();
                if mode == "'manual'" {
                    is_active = true;
                }
            }
        }

        if !is_active {
            if let Some((_, kread_cmd)) = get_kde_cmd() {
                if let Ok(output) = Command::new(kread_cmd)
                    .args([
                        "--file",
                        "kioslaverc",
                        "--group",
                        "Proxy Settings",
                        "--key",
                        "ProxyType",
                    ])
                    .output()
                {
                    let ptype = String::from_utf8_lossy(&output.stdout).trim().to_owned();
                    if ptype == "1" {
                        is_active = true;
                    }
                }
            }
        }

        if !is_active && has_xfce() {
            if let Ok(output) = Command::new("xfconf-query")
                .args(["-c", "xfce4-session", "-p", "/proxies/HTTP"])
                .output()
            {
                let out_str = String::from_utf8_lossy(&output.stdout).trim().to_owned();
                if !out_str.is_empty() && out_str != "false" {
                    is_active = true;
                }
            }
        }

        Ok(is_active)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_proxy_loopback_ipv4() {
        assert!(validate_proxy_server("127.0.0.1:7890").is_ok());
    }

    #[test]
    fn test_validate_proxy_loopback_ipv6() {
        assert!(validate_proxy_server("[::1]:7890").is_ok());
    }

    #[test]
    fn test_validate_proxy_localhost() {
        assert!(validate_proxy_server("localhost:7890").is_ok());
    }

    #[test]
    fn test_validate_proxy_rejects_public_ip() {
        assert!(validate_proxy_server("8.8.8.8:7890").is_err());
        assert!(validate_proxy_server("192.168.1.1:7890").is_err());
        assert!(validate_proxy_server("10.0.0.1:7890").is_err());
    }

    #[test]
    fn test_validate_proxy_rejects_empty() {
        assert!(validate_proxy_server("").is_err());
    }

    #[test]
    fn test_validate_proxy_rejects_too_long() {
        let long_addr = "localhost:".to_owned() + &"a".repeat(600);
        assert!(validate_proxy_server(&long_addr).is_err());
    }

    #[test]
    fn test_validate_proxy_rejects_newlines() {
        assert!(validate_proxy_server("127.0.0.1:7890\nInjected: true").is_err());
        assert!(validate_proxy_server("127.0.0.1:7890\r\nEvil").is_err());
        assert!(validate_proxy_server("127.0.0.1:7890\0null").is_err());
    }

    #[test]
    fn test_validate_proxy_rejects_non_localhost_hostname() {
        assert!(validate_proxy_server("proxy.example.com:7890").is_err());
        assert!(validate_proxy_server("127.0.0.1.evil.com:7890").is_err());
    }

    #[test]
    fn test_validate_proxy_invalid_format() {
        assert!(validate_proxy_server("not-a-valid-address").is_err());
        assert!(validate_proxy_server(":7890").is_err());
        assert!(validate_proxy_server("127.0.0.1:").is_err());
        assert!(validate_proxy_server("127.0.0.1:abc").is_err());
    }

    #[test]
    fn test_parse_host_port_ipv4() {
        let (host, port) = parse_host_port("127.0.0.1:7890").unwrap();
        assert_eq!(host, "127.0.0.1");
        assert_eq!(port, "7890");
    }

    #[test]
    fn test_parse_host_port_ipv6() {
        let (host, port) = parse_host_port("[::1]:8080").unwrap();
        assert_eq!(host, "::1");
        assert_eq!(port, "8080");
    }

    #[test]
    fn test_parse_host_port_with_spaces() {
        let (host, port) = parse_host_port("  localhost : 7890  ").unwrap();
        assert_eq!(host, "localhost");
        assert_eq!(port, "7890");
    }

    #[test]
    fn test_parse_host_port_empty() {
        assert!(parse_host_port("").is_err());
    }

    #[test]
    fn test_parse_host_port_invalid_ipv6() {
        assert!(parse_host_port("[::1]").is_err());
        assert!(parse_host_port("[::1]:").is_err());
        assert!(parse_host_port("[::1]:abc").is_err());
    }

    #[test]
    fn test_push_normalized_proxy_part() {
        let mut parts = Vec::new();
        push_normalized_proxy_part(&mut parts, "127.0.0.1:7890", "http");
        assert_eq!(parts, vec!["http=127.0.0.1:7890"]);

        parts.clear();
        push_normalized_proxy_part(&mut parts, "socks://127.0.0.1:1080", "socks");
        assert_eq!(parts, vec!["socks=socks5://127.0.0.1:1080"]);

        parts.clear();
        push_normalized_proxy_part(&mut parts, "127.0.0.1:0", "http");
        assert!(parts.is_empty());

        parts.clear();
        push_normalized_proxy_part(&mut parts, "false", "http");
        assert!(parts.is_empty());

        parts.clear();
        push_normalized_proxy_part(&mut parts, "http=127.0.0.1:7890", "ignored");
        assert_eq!(parts, vec!["http=127.0.0.1:7890"]);
    }
}

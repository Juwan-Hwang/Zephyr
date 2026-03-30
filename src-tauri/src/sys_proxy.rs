use tauri::command;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::process::Command;
use std::net::IpAddr;

#[cfg(target_os = "windows")]
use std::ptr;
#[cfg(target_os = "windows")]
use windows_sys::Win32::Networking::WinInet::{
    InternetSetOptionW, INTERNET_OPTION_REFRESH, INTERNET_OPTION_SETTINGS_CHANGED,
};

#[cfg(target_os = "windows")]
use winreg::enums::*;
#[cfg(target_os = "windows")]
use winreg::RegKey;

/// Validates that the proxy server address is a valid local address.
/// This prevents proxy hijacking by ensuring only loopback addresses are allowed.
fn validate_proxy_server(server: &str) -> Result<(), String> {
    if server.is_empty() {
        return Err("Proxy server address cannot be empty".to_string());
    }
    if server.len() > 512 {
        return Err("Proxy server address too long".to_string());
    }
    if server.contains('\n') || server.contains('\r') || server.contains('\0') {
        return Err("Proxy server address contains invalid characters".to_string());
    }
    
    // Parse host and port from server string
    let (host, _port) = parse_host_port(server)?;
    
    // Validate that host is a loopback address
    // First try to parse as IP address directly
    if let Ok(ip) = host.parse::<IpAddr>() {
        if !ip.is_loopback() {
            return Err("Only loopback addresses (127.0.0.1, ::1) are allowed for security reasons".to_string());
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
    return Err(format!(
        "Invalid proxy host '{}': only localhost, 127.0.0.1, or ::1 are allowed",
        host
    ));
}

/// Parse host and port from a proxy server string.
/// Handles formats: "host:port", "[ipv6]:port", "localhost:port"
fn parse_host_port(server: &str) -> Result<(String, String), String> {
    if server.is_empty() {
        return Err("Proxy server address cannot be empty".to_string());
    }
    
    // Handle IPv6 literal with port, e.g. [::1]:8080
    if server.starts_with('[') {
        if let Some(end_bracket) = server.rfind(']') {
            let host = server[1..end_bracket].to_string();
            let remainder = &server[end_bracket+1..];
            if remainder.starts_with(':') {
                let port = remainder[1..].trim().to_string();
                if !port.is_empty() {
                    // Validate port is a valid number
                    if port.parse::<u16>().is_err() {
                        return Err(format!("Invalid port number: {}", port));
                    }
                    return Ok((host, port));
                }
            }
        }
        return Err("Invalid IPv6 proxy format, expected [host]:port".to_string());
    }
    
    // Handle IPv4 or hostname
    if let Some(last_colon) = server.rfind(':') {
        let host = server[..last_colon].trim().to_string();
        let port = server[last_colon+1..].trim().to_string();
        if !host.is_empty() && !port.is_empty() {
            // Validate port is a valid number
            if port.parse::<u16>().is_err() {
                return Err(format!("Invalid port number: {}", port));
            }
            return Ok((host, port));
        }
    }
    
    Err("Invalid proxy server format, expected host:port".to_string())
}

#[cfg(target_os = "macos")]
fn run_networksetup(args: &[&str]) -> Result<(), String> {
    let status = Command::new("networksetup")
        .args(args)
        .status()
        .map_err(|e| format!("Failed to execute networksetup: {}", e))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("networksetup failed: {:?}", args))
    }
}

/// Dynamically get all network services from macOS
#[cfg(target_os = "macos")]
fn get_network_services() -> Vec<String> {
    let output = match Command::new("networksetup")
        .arg("-listallnetworkservices")
        .output() {
            Ok(out) => out,
            Err(_) => return vec!["Wi-Fi".to_string(), "Ethernet".to_string()],
        };
    
    if !output.status.success() {
        return vec!["Wi-Fi".to_string(), "Ethernet".to_string()];
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
        
        services.push(trimmed.to_string());
    }
    
    // Fallback to defaults if no services found
    if services.is_empty() {
        return vec!["Wi-Fi".to_string(), "Ethernet".to_string()];
    }
    
    services
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
        Err(last_err.unwrap_or_else(|| "No network services available".to_string()))
    }
}

#[cfg(target_os = "linux")]
fn is_cmd_available(cmd: &str) -> bool {
    Command::new(cmd).arg("--help").output().is_ok()
}

#[cfg(target_os = "linux")]
fn get_kde_cmd() -> Option<(&'static str, &'static str)> {
    if is_cmd_available("kwriteconfig6") {
        Some(("kwriteconfig6", "kreadconfig6"))
    } else if is_cmd_available("kwriteconfig5") {
        Some(("kwriteconfig5", "kreadconfig5"))
    } else {
        None
    }
}

#[cfg(target_os = "linux")]
fn has_gnome() -> bool {
    Command::new("gsettings").arg("get").arg("org.gnome.system.proxy").arg("mode").output().is_ok()
}

#[cfg(target_os = "linux")]
fn has_xfce() -> bool {
    is_cmd_available("xfconf-query")
}

#[command]
pub fn enable_sysproxy(server: String, bypass: Option<String>) -> Result<String, String> {
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

        let proxy_override = bypass.unwrap_or_else(|| "<local>;localhost;127.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;172.30.*;172.31.*;192.168.*".to_string());

        // 原子性写入（失败时回滚）
        if let Err(e) = (|| -> Result<(), String> {
            key.set_value("ProxyEnable", &1u32).map_err(|e| e.to_string())?;
            key.set_value("ProxyServer", &server).map_err(|e| e.to_string())?;
            key.set_value("ProxyOverride", &proxy_override).map_err(|e| e.to_string())?;
            Ok(())
        })() {
            let _ = key.set_value("ProxyEnable", &old_enable);
            let _ = key.set_value("ProxyServer", &old_server);
            let _ = key.set_value("ProxyOverride", &old_override);
            return Err(format!("Failed to set proxy (rolled back): {}", e));
        }

        // 刷新系统设置
        unsafe {
            let res1 = InternetSetOptionW(ptr::null_mut(), INTERNET_OPTION_SETTINGS_CHANGED, ptr::null_mut(), 0);
            let res2 = InternetSetOptionW(ptr::null_mut(), INTERNET_OPTION_REFRESH, ptr::null_mut(), 0);
            if res1 == 0 || res2 == 0 {
                return Err("Failed to refresh system proxy settings".to_string());
            }
        }

        Ok("System proxy enabled".to_string())
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
        Ok(format!("System proxy enabled on macOS (HTTP+HTTPS+SOCKS)"))
    }

    #[cfg(target_os = "linux")]
    {
        let (host, port) = parse_host_port(&server)?;
        validate_proxy_server(&server)?;
        
        let mut success = false;
        
        if has_gnome() {
            if let Ok(status) = Command::new("gsettings").args(["set", "org.gnome.system.proxy", "mode", "'manual'"]).status() {
                if status.success() {
                    let _ = Command::new("gsettings").args(["set", "org.gnome.system.proxy.http", "host", &format!("'{}'", host)]).status();
                    let _ = Command::new("gsettings").args(["set", "org.gnome.system.proxy.http", "port", &port]).status();
                    let _ = Command::new("gsettings").args(["set", "org.gnome.system.proxy.https", "host", &format!("'{}'", host)]).status();
                    let _ = Command::new("gsettings").args(["set", "org.gnome.system.proxy.https", "port", &port]).status();
                    let _ = Command::new("gsettings").args(["set", "org.gnome.system.proxy.socks", "host", &format!("'{}'", host)]).status();
                    let _ = Command::new("gsettings").args(["set", "org.gnome.system.proxy.socks", "port", &port]).status();
                    
                    if let Some(bp) = bypass {
                        let hosts: Vec<&str> = bp.split(',').collect();
                        let formatted_bp = format!("['{}']", hosts.join("', '"));
                        let _ = Command::new("gsettings").args(["set", "org.gnome.system.proxy", "ignore-hosts", &formatted_bp]).status();
                    }
                    success = true;
                }
            }
        }
        
        if let Some((kwrite_cmd, _)) = get_kde_cmd() {
            if let Ok(status) = Command::new(kwrite_cmd).args(["--file", "kioslaverc", "--group", "Proxy Settings", "--key", "ProxyType", "1"]).status() {
                if status.success() {
                    let _ = Command::new(kwrite_cmd).args(["--file", "kioslaverc", "--group", "Proxy Settings", "--key", "httpProxy", &format!("http://{}:{}", host, port)]).status();
                    let _ = Command::new(kwrite_cmd).args(["--file", "kioslaverc", "--group", "Proxy Settings", "--key", "httpsProxy", &format!("http://{}:{}", host, port)]).status();
                    let _ = Command::new(kwrite_cmd).args(["--file", "kioslaverc", "--group", "Proxy Settings", "--key", "socksProxy", &format!("socks://{}:{}", host, port)]).status();
                    
                    let _ = Command::new("dbus-send").args(["--type=method_call", "--dest=org.kde.KIODaemon", "/KIODaemon", "org.kde.KIODaemon.update"]).status();
                    let _ = Command::new("dbus-send").args(["--type=method_call", "--dest=org.kde.KWin", "/KWin", "org.kde.KWin.reconfigure"]).status();
                    success = true;
                }
            }
        }

        if has_xfce() {
            let _ = Command::new("xfconf-query").args(["-c", "xfce4-session", "-p", "/proxies/HTTP", "-s", &format!("{}:{}", host, port), "-n", "-t", "string"]).status();
            success = true;
        }

        if success {
            Ok("System proxy enabled on Linux".to_string())
        } else {
            Err("Failed to enable system proxy on Linux: no supported desktop environment found.".to_string())
        }
    }
}

#[command]
pub fn disable_sysproxy() -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let path = "Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
        let (key, _) = hkcu.create_subkey(path).map_err(|e| e.to_string())?;

        key.set_value("ProxyEnable", &0u32).map_err(|e| e.to_string())?;

        // 刷新系统设置
        unsafe {
            let res1 = InternetSetOptionW(ptr::null_mut(), INTERNET_OPTION_SETTINGS_CHANGED, ptr::null_mut(), 0);
            let res2 = InternetSetOptionW(ptr::null_mut(), INTERNET_OPTION_REFRESH, ptr::null_mut(), 0);
            if res1 == 0 || res2 == 0 {
                return Err("Failed to refresh system proxy settings".to_string());
            }
        }

        Ok("System proxy disabled".to_string())
    }

    #[cfg(target_os = "macos")]
    {
        apply_networksetup_for_services(|service| {
            run_networksetup(&["-setwebproxystate", service, "off"])?;
            run_networksetup(&["-setsecurewebproxystate", service, "off"])?;
            run_networksetup(&["-setsocksfirewallproxystate", service, "off"])?;
            Ok(())
        })?;
        Ok("System proxy disabled on macOS".to_string())
    }

    #[cfg(target_os = "linux")]
    {
        let mut success = false;
        if has_gnome() {
            if let Ok(status) = Command::new("gsettings").args(["set", "org.gnome.system.proxy", "mode", "'none'"]).status() {
                if status.success() {
                    let _ = Command::new("gsettings").args(["set", "org.gnome.system.proxy", "ignore-hosts", "['localhost', '127.0.0.0/8', '::1']"]).status();
                    success = true;
                }
            }
        }
        
        if let Some((kwrite_cmd, _)) = get_kde_cmd() {
            if let Ok(status) = Command::new(kwrite_cmd).args(["--file", "kioslaverc", "--group", "Proxy Settings", "--key", "ProxyType", "0"]).status() {
                if status.success() {
                    let _ = Command::new("dbus-send").args(["--type=method_call", "--dest=org.kde.KIODaemon", "/KIODaemon", "org.kde.KIODaemon.update"]).status();
                    let _ = Command::new("dbus-send").args(["--type=method_call", "--dest=org.kde.KWin", "/KWin", "org.kde.KWin.reconfigure"]).status();
                    success = true;
                }
            }
        }

        if has_xfce() {
            let _ = Command::new("xfconf-query").args(["-c", "xfce4-session", "-p", "/proxies/HTTP", "-r"]).status();
            success = true;
        }
        
        if success {
            Ok("System proxy disabled on Linux".to_string())
        } else {
            Err("Failed to disable system proxy on Linux: no supported desktop environment found.".to_string())
        }
    }
}

// 供内部调用（如退出时清理）
pub fn clear_sys_proxy() -> Result<(), String> {
    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    {
        let _ = disable_sysproxy();
        Ok(())
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
                if text.lines().any(|line| line.trim().eq_ignore_ascii_case("Enabled: Yes")) {
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
            if let Ok(output) = Command::new("gsettings").arg("get").arg("org.gnome.system.proxy").arg("mode").output() {
                let mode = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if mode == "'manual'" {
                    is_active = true;
                }
            }
        }
        
        if !is_active {
            if let Some((_, kread_cmd)) = get_kde_cmd() {
                if let Ok(output) = Command::new(kread_cmd).args(["--file", "kioslaverc", "--group", "Proxy Settings", "--key", "ProxyType"]).output() {
                    let ptype = String::from_utf8_lossy(&output.stdout).trim().to_string();
                    if ptype == "1" {
                        is_active = true;
                    }
                }
            }
        }

        if !is_active && has_xfce() {
            if let Ok(output) = Command::new("xfconf-query").args(["-c", "xfce4-session", "-p", "/proxies/HTTP"]).output() {
                let out_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !out_str.is_empty() && out_str != "false" {
                    is_active = true;
                }
            }
        }

        Ok(is_active)
    }
}

use serde::Serialize;
use tauri::AppHandle;

#[derive(Serialize)]
pub struct NetworkOptimStatus {
    pub applied: bool,
    pub details: String,
}

// ---------------------------------------------------------------------------
// Linux implementation
// ---------------------------------------------------------------------------

#[cfg(target_os = "linux")]
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn apply_network_optimizations(_app: AppHandle) -> Result<(), String> {
    emit_info!(
        System,
        SYS_TUN_FAILED,
        "Applying network optimizations (Linux)..."
    );

    #[allow(clippy::literal_string_with_formatting_args)]
    let script = r#"set -e
export PATH="/usr/sbin:/sbin:$PATH"

# Backup current values before modifying
mkdir -p /etc/sysctl.d 2>/dev/null || true
cat > /etc/sysctl.d/99-zephyr-tcp-backup.conf << BAKEOF
# Zephyr TCP backup (pre-optimization values)
net.ipv4.tcp_fastopen = $(sysctl -n net.ipv4.tcp_fastopen 2>/dev/null || echo 1)
net.ipv4.tcp_ecn = $(sysctl -n net.ipv4.tcp_ecn 2>/dev/null || echo 2)
net.core.rmem_max = $(sysctl -n net.core.rmem_max 2>/dev/null || echo 212992)
net.core.wmem_max = $(sysctl -n net.core.wmem_max 2>/dev/null || echo 212992)
net.ipv4.tcp_rmem = $(sysctl -n net.ipv4.tcp_rmem 2>/dev/null || echo "4096 131072 6291456")
net.ipv4.tcp_wmem = $(sysctl -n net.ipv4.tcp_wmem 2>/dev/null || echo "4096 16384 4194304")
net.ipv4.tcp_notsent_lowat = $(sysctl -n net.ipv4.tcp_notsent_lowat 2>/dev/null || echo 4294967295)
BAKEOF
chmod 644 /etc/sysctl.d/99-zephyr-tcp-backup.conf 2>/dev/null || true

# TCP Fast Open + ECN
sysctl -w net.ipv4.tcp_fastopen=3 2>/dev/null || true
sysctl -w net.ipv4.tcp_ecn=1 2>/dev/null || true

# HyStart: disable ACK train detection, keep RTT delay only
modprobe tcp_cubic 2>/dev/null || true
echo 2 > /sys/module/tcp_cubic/parameters/hystart_detect 2>/dev/null || true

# TCP buffer limits (raise-only)
curr_rmem_max=$(sysctl -n net.core.rmem_max 2>/dev/null | tr -cd '0-9' || echo 0)
curr_rmem_max=${curr_rmem_max:-0}
if [ "$curr_rmem_max" -lt 16777216 ] 2>/dev/null; then
    sysctl -w net.core.rmem_max=16777216 2>/dev/null || true
fi
curr_wmem_max=$(sysctl -n net.core.wmem_max 2>/dev/null | tr -cd '0-9' || echo 0)
curr_wmem_max=${curr_wmem_max:-0}
if [ "$curr_wmem_max" -lt 33554432 ] 2>/dev/null; then
    sysctl -w net.core.wmem_max=33554432 2>/dev/null || true
fi
read -r r_min r_def r_max <<< "$(sysctl -n net.ipv4.tcp_rmem 2>/dev/null || echo "4096 262144 16777216")"
r_min=${r_min:-4096}; r_def=${r_def:-262144}; r_max=${r_max:-16777216}
if [ "$r_def" -lt 262144 ] 2>/dev/null; then r_def=262144; fi
if [ "$r_max" -lt 16777216 ] 2>/dev/null; then r_max=16777216; fi
sysctl -w "net.ipv4.tcp_rmem=$r_min $r_def $r_max" 2>/dev/null || true
read -r w_min w_def w_max <<< "$(sysctl -n net.ipv4.tcp_wmem 2>/dev/null || echo "4096 262144 33554432")"
w_min=${w_min:-4096}; w_def=${w_def:-262144}; w_max=${w_max:-33554432}
if [ "$w_def" -lt 262144 ] 2>/dev/null; then w_def=262144; fi
if [ "$w_max" -lt 33554432 ] 2>/dev/null; then w_max=33554432; fi
sysctl -w "net.ipv4.tcp_wmem=$w_min $w_def $w_max" 2>/dev/null || true
sysctl -w net.ipv4.tcp_notsent_lowat=131072 2>/dev/null || true

# Persist to /etc/sysctl.d so it survives reboot
cat > /etc/sysctl.d/99-zephyr-tcp-tuning.conf << 'SYSEOF'
# Zephyr TCP performance tuning
net.ipv4.tcp_fastopen = 3
net.ipv4.tcp_ecn = 1
net.core.rmem_max = 16777216
net.core.wmem_max = 33554432
net.ipv4.tcp_rmem = 4096 262144 16777216
net.ipv4.tcp_wmem = 4096 262144 33554432
net.ipv4.tcp_notsent_lowat = 131072
SYSEOF
chmod 644 /etc/sysctl.d/99-zephyr-tcp-tuning.conf 2>/dev/null || true"#;

    let output = std::process::Command::new("pkexec")
        .args(["bash", "-c", script, "bash"])
        .output()
        .map_err(|e| format!("Failed to execute pkexec: {e}"))?;

    if output.status.success() {
        emit_info!(
            System,
            SYS_TUN_FAILED,
            "Network optimizations applied successfully (Linux)"
        );
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("Request dismissed")
            || stderr.contains("canceled")
            || stderr.contains("cancelled")
        {
            Err("canceled".to_owned())
        } else {
            Err(format!("Network optimization failed: {stderr}"))
        }
    }
}

#[cfg(target_os = "linux")]
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn revert_network_optimizations(_app: AppHandle) -> Result<(), String> {
    emit_info!(
        System,
        SYS_TUN_FAILED,
        "Reverting network optimizations (Linux)..."
    );

    #[allow(clippy::literal_string_with_formatting_args)]
    let script = r#"export PATH="/usr/sbin:/sbin:$PATH"

# Remove persisted optimization config
rm -f /etc/sysctl.d/99-zephyr-tcp-tuning.conf 2>/dev/null || true

# Restore from backup if it exists (preserves user's pre-optimization values)
if [ -f /etc/sysctl.d/99-zephyr-tcp-backup.conf ]; then
    sysctl -p /etc/sysctl.d/99-zephyr-tcp-backup.conf 2>/dev/null || true
    rm -f /etc/sysctl.d/99-zephyr-tcp-backup.conf 2>/dev/null || true
else
    # No backup: fall back to kernel defaults
    sysctl -w net.ipv4.tcp_fastopen=1 2>/dev/null || true
    sysctl -w net.ipv4.tcp_ecn=2 2>/dev/null || true
    sysctl -w net.ipv4.tcp_notsent_lowat=4294967295 2>/dev/null || true
    sysctl --system 2>/dev/null || true
fi

# Revert HyStart
echo 0 > /sys/module/tcp_cubic/parameters/hystart_detect 2>/dev/null || true"#;

    let output = std::process::Command::new("pkexec")
        .args(["bash", "-c", script, "bash"])
        .output()
        .map_err(|e| format!("Failed to execute pkexec: {e}"))?;

    if output.status.success() {
        emit_info!(
            System,
            SYS_TUN_FAILED,
            "Network optimizations reverted successfully (Linux)"
        );
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("Request dismissed")
            || stderr.contains("canceled")
            || stderr.contains("cancelled")
        {
            Err("canceled".to_owned())
        } else {
            Err(format!("Network optimization revert failed: {stderr}"))
        }
    }
}

#[cfg(target_os = "linux")]
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn check_network_optimizations_status(_app: AppHandle) -> Result<NetworkOptimStatus, String> {
    let value = match std::fs::read_to_string("/proc/sys/net/ipv4/tcp_fastopen") {
        Ok(v) => v.trim().to_owned(),
        Err(_) => {
            // File may be missing on older/custom kernels or restricted environments
            return Ok(NetworkOptimStatus {
                applied: false,
                details: "tcp_fastopen not available".to_owned(),
            });
        }
    };
    let applied = value == "3";

    Ok(NetworkOptimStatus {
        applied,
        details: format!("net.ipv4.tcp_fastopen={value}"),
    })
}

// ---------------------------------------------------------------------------
// macOS implementation
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn apply_network_optimizations(_app: AppHandle) -> Result<(), String> {
    emit_info!(
        System,
        SYS_TUN_FAILED,
        "Applying network optimizations (macOS)..."
    );

    // Backup current values, then apply optimizations
    let script = r#"do shell script "msl=$(sysctl -n net.inet.tcp.msl); fopen=$(sysctl -n net.inet.tcp.fastopen); ecn=$(sysctl -n net.inet.tcp.ecn); mkdir -p /tmp/zephyr; echo \"$msl $fopen $ecn\" > /tmp/zephyr/tcp-backup.txt; sysctl -w net.inet.tcp.msl=1000; sysctl -w net.inet.tcp.fastopen=3; sysctl -w net.inet.tcp.ecn=1" with administrator privileges"#;

    let output = std::process::Command::new("osascript")
        .args(["-e", script])
        .output()
        .map_err(|e| format!("Failed to run osascript: {e}"))?;

    if output.status.success() {
        emit_info!(
            System,
            SYS_TUN_FAILED,
            "Network optimizations applied successfully (macOS)"
        );
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("canceled")
            || stderr.contains("cancelled")
            || stderr.contains("User canceled")
        {
            Err("canceled".to_owned())
        } else {
            Err(format!("Network optimization failed (macOS): {stderr}"))
        }
    }
}

#[cfg(target_os = "macos")]
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn revert_network_optimizations(_app: AppHandle) -> Result<(), String> {
    emit_info!(
        System,
        SYS_TUN_FAILED,
        "Reverting network optimizations (macOS)..."
    );

    // Restore from backup if available, otherwise use system defaults
    let script = r#"do shell script "if [ -f /tmp/zephyr/tcp-backup.txt ]; then read msl fopen ecn < /tmp/zephyr/tcp-backup.txt; sysctl -w net.inet.tcp.msl=$msl; sysctl -w net.inet.tcp.fastopen=$fopen; sysctl -w net.inet.tcp.ecn=$ecn; rm -f /tmp/zephyr/tcp-backup.txt; else sysctl -w net.inet.tcp.msl=15000; sysctl -w net.inet.tcp.fastopen=3; sysctl -w net.inet.tcp.ecn=2; fi" with administrator privileges"#;

    let output = std::process::Command::new("osascript")
        .args(["-e", script])
        .output()
        .map_err(|e| format!("Failed to run osascript: {e}"))?;

    if output.status.success() {
        emit_info!(
            System,
            SYS_TUN_FAILED,
            "Network optimizations reverted successfully (macOS)"
        );
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("canceled")
            || stderr.contains("cancelled")
            || stderr.contains("User canceled")
        {
            Err("canceled".to_owned())
        } else {
            Err(format!(
                "Network optimization revert failed (macOS): {stderr}"
            ))
        }
    }
}

#[cfg(target_os = "macos")]
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn check_network_optimizations_status(_app: AppHandle) -> Result<NetworkOptimStatus, String> {
    let output = match std::process::Command::new("sysctl")
        .args(["-n", "net.inet.tcp.msl"])
        .output()
    {
        Ok(o) => o,
        Err(_) => {
            return Ok(NetworkOptimStatus {
                applied: false,
                details: "sysctl command not available".to_owned(),
            });
        }
    };

    if !output.status.success() {
        return Ok(NetworkOptimStatus {
            applied: false,
            details: "sysctl command failed".to_owned(),
        });
    }

    // Check msl=1000 (optimized) instead of fastopen=3 (which is the macOS default)
    let value = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    let applied = value == "1000";

    Ok(NetworkOptimStatus {
        applied,
        details: format!("net.inet.tcp.msl={value}"),
    })
}

// ---------------------------------------------------------------------------
// Windows implementation
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn apply_network_optimizations(_app: AppHandle) -> Result<(), String> {
    use std::os::windows::process::CommandExt;

    emit_info!(
        System,
        SYS_TUN_FAILED,
        "Applying network optimizations (Windows)..."
    );

    // Backup current values from registry before modifying
    let backup_dir = std::env::temp_dir().join("zephyr");
    let _ = std::fs::create_dir_all(&backup_dir);
    let backup_path = backup_dir.join("tcp-backup.txt");
    let mut backup_lines = Vec::new();

    {
        use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ};
        use winreg::RegKey;
        let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
        if let Ok(key) = hklm.open_subkey_with_flags(
            r"SYSTEM\CurrentControlSet\Services\Tcpip\Parameters",
            KEY_READ,
        ) {
            if let Ok(val) = key.get_value::<u32, _>("TcpFastOpen") {
                backup_lines.push(format!("TcpFastOpen={val}"));
            }
            if let Ok(val) = key.get_value::<u32, _>("TcpInitialRto") {
                backup_lines.push(format!("TcpInitialRto={val}"));
            }
            if let Ok(val) = key.get_value::<u32, _>("EcnCapability") {
                backup_lines.push(format!("EcnCapability={val}"));
            }
        }
        // Also backup autotuninglevel and heuristics via netsh output
        if let Ok(output) = std::process::Command::new("netsh")
            .args(["int", "tcp", "show", "global"])
            .creation_flags(super::CREATE_NO_WINDOW)
            .output()
        {
            let text = String::from_utf8_lossy(&output.stdout);
            for line in text.lines() {
                let lower = line.to_lowercase();
                if lower.contains("auto") && lower.contains("tun") {
                    backup_lines.push(format!("autotuninglevel={line}"));
                } else if lower.contains("heuristics") {
                    backup_lines.push(format!("heuristics={line}"));
                }
            }
        }
    }
    let _ = std::fs::write(&backup_path, backup_lines.join("\n"));

    let optimizations: [(&str, &[&str]); 5] = [
        (
            "autotuninglevel",
            &["int", "tcp", "set", "global", "autotuninglevel=normal"],
        ),
        (
            "heuristics",
            &["int", "tcp", "set", "heuristics", "disabled"],
        ),
        (
            "initialRto",
            &["int", "tcp", "set", "global", "initialRto=300"],
        ),
        (
            "fastopen",
            &["int", "tcp", "set", "global", "fastopen=enabled"],
        ),
        (
            "ecncapability",
            &["int", "tcp", "set", "global", "ecncapability=enabled"],
        ),
    ];

    let mut failed = Vec::new();
    for (name, args) in &optimizations {
        let mut cmd = std::process::Command::new("netsh");
        cmd.args(args);
        cmd.creation_flags(super::CREATE_NO_WINDOW);
        match cmd.output() {
            Ok(output) if output.status.success() => {
                emit_info!(
                    System,
                    SYS_TUN_FAILED,
                    "Windows TCP optimization applied: {name}"
                );
            }
            Ok(output) => {
                // netsh often prints errors to stdout instead of stderr
                let diag = format!("stdout={}", String::from_utf8_lossy(&output.stdout).trim());
                let stderr = String::from_utf8_lossy(&output.stderr);
                let diag = if stderr.trim().is_empty() {
                    diag
                } else {
                    format!("{diag}, stderr={stderr}")
                };
                emit_warn!(
                    System,
                    SYS_TUN_FAILED,
                    "Windows TCP optimization skipped ({name}): {diag}"
                );
                failed.push(*name);
            }
            Err(e) => {
                emit_warn!(
                    System,
                    SYS_TUN_FAILED,
                    "Windows TCP optimization failed ({name}): {e}"
                );
                failed.push(*name);
            }
        }
    }

    if failed.is_empty() {
        emit_info!(
            System,
            SYS_TUN_FAILED,
            "All Windows TCP optimizations applied successfully"
        );
        Ok(())
    } else {
        Err(format!(
            "Some Windows TCP optimizations failed (requires admin): {}",
            failed.join(", ")
        ))
    }
}

#[cfg(target_os = "windows")]
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn revert_network_optimizations(_app: AppHandle) -> Result<(), String> {
    use std::os::windows::process::CommandExt;

    emit_info!(
        System,
        SYS_TUN_FAILED,
        "Reverting network optimizations (Windows)..."
    );

    // Try to restore from backup; fall back to system defaults
    let backup_path = std::env::temp_dir().join("zephyr").join("tcp-backup.txt");
    let reverts: [(&str, &[&str]); 5] = if backup_path.exists() {
        // Parse backup and build revert commands
        // For simplicity, use system defaults for netsh commands
        // and restore registry values from backup
        let _ = std::fs::read_to_string(&backup_path);
        // Restore registry values from backup
        {
            use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_WRITE};
            use winreg::RegKey;
            let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
            if let Ok(key) = hklm.open_subkey_with_flags(
                r"SYSTEM\CurrentControlSet\Services\Tcpip\Parameters",
                KEY_WRITE,
            ) {
                if let Ok(content) = std::fs::read_to_string(&backup_path) {
                    for line in content.lines() {
                        if let Some((k, v)) = line.split_once('=') {
                            if let Ok(val) = v.trim().parse::<u32>() {
                                let _ = key.set_value(k.trim(), &val);
                            }
                        }
                    }
                }
            }
        }
        let _ = std::fs::remove_file(&backup_path);
        [
            (
                "autotuninglevel",
                &["int", "tcp", "set", "global", "autotuninglevel=normal"],
            ),
            ("heuristics", &["int", "tcp", "set", "heuristics", "enabled"]),
            (
                "initialRto",
                &["int", "tcp", "set", "global", "initialRto=1000"],
            ),
            (
                "fastopen",
                &["int", "tcp", "set", "global", "fastopen=disabled"],
            ),
            (
                "ecncapability",
                &["int", "tcp", "set", "global", "ecncapability=disabled"],
            ),
        ]
    } else {
        [
            (
                "autotuninglevel",
                &["int", "tcp", "set", "global", "autotuninglevel=normal"],
            ),
            ("heuristics", &["int", "tcp", "set", "heuristics", "enabled"]),
            (
                "initialRto",
                &["int", "tcp", "set", "global", "initialRto=1000"],
            ),
            (
                "fastopen",
                &["int", "tcp", "set", "global", "fastopen=disabled"],
            ),
            (
                "ecncapability",
                &["int", "tcp", "set", "global", "ecncapability=disabled"],
            ),
        ]
    };

    let mut failed = Vec::new();
    for (name, args) in &reverts {
        let mut cmd = std::process::Command::new("netsh");
        cmd.args(args);
        cmd.creation_flags(super::CREATE_NO_WINDOW);
        match cmd.output() {
            Ok(output) if output.status.success() => {
                emit_info!(
                    System,
                    SYS_TUN_FAILED,
                    "Windows TCP optimization reverted: {name}"
                );
            }
            Ok(output) => {
                // netsh often prints errors to stdout instead of stderr
                let diag = format!("stdout={}", String::from_utf8_lossy(&output.stdout).trim());
                let stderr = String::from_utf8_lossy(&output.stderr);
                let diag = if stderr.trim().is_empty() {
                    diag
                } else {
                    format!("{diag}, stderr={stderr}")
                };
                emit_warn!(
                    System,
                    SYS_TUN_FAILED,
                    "Windows TCP optimization revert skipped ({name}): {diag}"
                );
                failed.push(*name);
            }
            Err(e) => {
                emit_warn!(
                    System,
                    SYS_TUN_FAILED,
                    "Windows TCP optimization revert failed ({name}): {e}"
                );
                failed.push(*name);
            }
        }
    }

    if failed.is_empty() {
        emit_info!(
            System,
            SYS_TUN_FAILED,
            "All Windows TCP optimizations reverted successfully"
        );
        Ok(())
    } else {
        Err(format!(
            "Some Windows TCP optimization reverts failed (requires admin): {}",
            failed.join(", ")
        ))
    }
}

#[cfg(target_os = "windows")]
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn check_network_optimizations_status(_app: AppHandle) -> Result<NetworkOptimStatus, String> {
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ};
    use winreg::RegKey;

    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let key_path = r"SYSTEM\CurrentControlSet\Services\Tcpip\Parameters";

    let applied = match hklm.open_subkey_with_flags(key_path, KEY_READ) {
        Ok(key) => {
            // TCP Fast Open is enabled when TcpFastOpen = 1 (or 3 for client+server)
            match key.get_value::<u32, _>("TcpFastOpen") {
                Ok(val) => val >= 1,
                Err(_) => false,
            }
        }
        Err(_) => false,
    };

    Ok(NetworkOptimStatus {
        applied,
        details: if applied {
            "TCP Fast Open is enabled".to_owned()
        } else {
            "TCP Fast Open is not enabled".to_owned()
        },
    })
}

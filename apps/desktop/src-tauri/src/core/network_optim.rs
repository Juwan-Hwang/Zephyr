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
mkdir -p /etc/sysctl.d 2>/dev/null || true
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

# Remove persisted config
rm -f /etc/sysctl.d/99-zephyr-tcp-tuning.conf 2>/dev/null || true

# Revert core TCP settings
sysctl -w net.ipv4.tcp_fastopen=1 2>/dev/null || true
sysctl -w net.ipv4.tcp_ecn=0 2>/dev/null || true
echo 0 > /sys/module/tcp_cubic/parameters/hystart_detect 2>/dev/null || true

# Revert buffer defaults
sysctl -w net.core.rmem_max=212992 2>/dev/null || true
sysctl -w net.core.wmem_max=212992 2>/dev/null || true
sysctl -w "net.ipv4.tcp_rmem=4096 131072 6291456" 2>/dev/null || true
sysctl -w "net.ipv4.tcp_wmem=4096 16384 4194304" 2>/dev/null || true
sysctl -w net.ipv4.tcp_notsent_lowat=4294967295 2>/dev/null || true"#;

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
    let value = std::fs::read_to_string("/proc/sys/net/ipv4/tcp_fastopen")
        .map_err(|e| format!("Failed to read tcp_fastopen: {e}"))?
        .trim()
        .to_owned();
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

    let script = r#"do shell script "sysctl -w net.inet.tcp.msl=1000; sysctl -w net.inet.tcp.fastopen=3; sysctl -w net.inet.tcp.ecn=1" with administrator privileges"#;

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

    let script = r#"do shell script "sysctl -w net.inet.tcp.msl=15000; sysctl -w net.inet.tcp.fastopen=0; sysctl -w net.inet.tcp.ecn=0" with administrator privileges"#;

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
    let output = std::process::Command::new("sysctl")
        .args(["-n", "net.inet.tcp.fastopen"])
        .output()
        .map_err(|e| format!("Failed to read sysctl: {e}"))?;

    if !output.status.success() {
        return Ok(NetworkOptimStatus {
            applied: false,
            details: "sysctl command failed".to_owned(),
        });
    }

    let value = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    let applied = value == "3";

    Ok(NetworkOptimStatus {
        applied,
        details: format!("net.inet.tcp.fastopen={value}"),
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
                let stderr = String::from_utf8_lossy(&output.stderr);
                emit_warn!(
                    System,
                    SYS_TUN_FAILED,
                    "Windows TCP optimization skipped ({name}): {stderr}"
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

    let reverts: [(&str, &[&str]); 5] = [
        (
            "autotuninglevel",
            &["int", "tcp", "set", "global", "autotuninglevel=restricted"],
        ),
        (
            "heuristics",
            &["int", "tcp", "set", "heuristics", "enabled"],
        ),
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
    ];

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
                let stderr = String::from_utf8_lossy(&output.stderr);
                emit_warn!(
                    System,
                    SYS_TUN_FAILED,
                    "Windows TCP optimization revert skipped ({name}): {stderr}"
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
    use std::os::windows::process::CommandExt;

    let mut cmd = std::process::Command::new("netsh");
    cmd.args(["int", "tcp", "show", "global"]);
    cmd.creation_flags(super::CREATE_NO_WINDOW);

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run netsh: {e}"))?;

    if !output.status.success() {
        return Ok(NetworkOptimStatus {
            applied: false,
            details: "netsh command failed".to_owned(),
        });
    }

    let text = String::from_utf8_lossy(&output.stdout).to_string();
    let lower = text.to_lowercase();
    // netsh output is localized: "enabled" (English) or "已启用"/"启用" (Chinese)
    let applied = lower.contains("fastopen")
        && (lower.contains("enabled") || lower.contains("已启用") || lower.contains("启用"));

    Ok(NetworkOptimStatus {
        applied,
        details: if applied {
            "TCP Fast Open is enabled".to_owned()
        } else {
            "TCP Fast Open is not enabled".to_owned()
        },
    })
}

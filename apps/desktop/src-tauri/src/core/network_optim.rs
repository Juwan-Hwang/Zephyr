use serde::Serialize;
use tauri::AppHandle;
#[allow(unused_imports)] // Manager trait needed for app.path() on macOS/Windows
use tauri::Manager as _;

#[derive(Serialize)]
pub struct NetworkOptimStatus {
    pub applied: bool,
    pub details: String,
}

// ---------------------------------------------------------------------------
// Optimization level & platform config structs
// ---------------------------------------------------------------------------

/// Optimization level preset.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum OptimLevel {
    Conservative,
    #[default]
    Balanced,
    Aggressive,
}

fn get_optim_level() -> OptimLevel {
    if let Ok(level_str) = std::env::var("ZEPHYR_NET_OPTIM_LEVEL") {
        match level_str.to_lowercase().as_str() {
            "conservative" => OptimLevel::Conservative,
            "aggressive" => OptimLevel::Aggressive,
            _ => OptimLevel::Balanced,
        }
    } else {
        OptimLevel::Balanced
    }
}

// -- Linux config --

#[cfg(target_os = "linux")]
#[derive(Debug, Clone)]
struct LinuxTcpOptimConfig {
    tcp_fastopen: u32,
    tcp_ecn: u32,
    rmem_max: u64,
    wmem_max: u64,
    tcp_rmem: (u32, u32, u64),
    tcp_wmem: (u32, u32, u64),
    tcp_notsent_lowat: u64,
}

#[cfg(target_os = "linux")]
impl LinuxTcpOptimConfig {
    const fn conservative() -> Self {
        Self {
            tcp_fastopen: 1,
            tcp_ecn: 2,
            rmem_max: 8_388_608,
            wmem_max: 16_777_216,
            tcp_rmem: (4096, 131_072, 8_388_608),
            tcp_wmem: (4096, 131_072, 16_777_216),
            tcp_notsent_lowat: 65_536,
        }
    }

    const fn balanced() -> Self {
        Self {
            tcp_fastopen: 3,
            tcp_ecn: 1,
            rmem_max: 16_777_216,
            wmem_max: 33_554_432,
            tcp_rmem: (4096, 262_144, 16_777_216),
            tcp_wmem: (4096, 262_144, 33_554_432),
            tcp_notsent_lowat: 131_072,
        }
    }

    const fn aggressive() -> Self {
        Self {
            tcp_fastopen: 3,
            tcp_ecn: 1,
            rmem_max: 33_554_432,
            wmem_max: 67_108_864,
            tcp_rmem: (4096, 524_288, 33_554_432),
            tcp_wmem: (4096, 524_288, 67_108_864),
            tcp_notsent_lowat: 262_144,
        }
    }

    const fn from_level(level: OptimLevel) -> Self {
        match level {
            OptimLevel::Conservative => Self::conservative(),
            OptimLevel::Balanced => Self::balanced(),
            OptimLevel::Aggressive => Self::aggressive(),
        }
    }

    /// sysctl key names used for backup / restore validation.
    const BACKUP_KEYS: &[&str] = &[
        "net.ipv4.tcp_fastopen",
        "net.ipv4.tcp_ecn",
        "net.core.rmem_max",
        "net.core.wmem_max",
        "net.ipv4.tcp_rmem",
        "net.ipv4.tcp_wmem",
        "net.ipv4.tcp_notsent_lowat",
    ];
}

// -- macOS config --

#[cfg(target_os = "macos")]
#[derive(Debug, Clone)]
struct MacosTcpOptimConfig {
    msl: u32,
    fastopen: u32,
    ecn: u32,
}

#[cfg(target_os = "macos")]
impl MacosTcpOptimConfig {
    const fn balanced() -> Self {
        Self {
            msl: 1000,
            fastopen: 3,
            ecn: 1,
        }
    }

    const fn from_level(level: OptimLevel) -> Self {
        match level {
            // macOS only provides balanced for now; other levels map to balanced
            OptimLevel::Conservative | OptimLevel::Balanced | OptimLevel::Aggressive => {
                Self::balanced()
            }
        }
    }
}

// -- Windows config --

#[cfg(target_os = "windows")]
#[derive(Debug, Clone)]
struct WindowsTcpOptimConfig {
    autotuninglevel: &'static str,
    heuristics: &'static str,
    initial_rto: u32,
    fastopen: &'static str,
    ecncapability: &'static str,
}

#[cfg(target_os = "windows")]
impl WindowsTcpOptimConfig {
    const fn balanced() -> Self {
        Self {
            autotuninglevel: "normal",
            heuristics: "disabled",
            initial_rto: 300,
            fastopen: "enabled",
            ecncapability: "enabled",
        }
    }

    const fn from_level(level: OptimLevel) -> Self {
        match level {
            OptimLevel::Conservative | OptimLevel::Balanced | OptimLevel::Aggressive => {
                Self::balanced()
            }
        }
    }

    /// Registry key names used for backup / restore validation.
    const BACKUP_REGISTRY_KEYS: &[&str] = &[
        "TcpFastOpen",
        "TcpInitialRto",
        "EcnCapability",
        "TcpAutoTuningLevel",
        "EnableTCPHeuristics",
    ];

    /// Build the netsh optimization commands from this config.
    fn to_netsh_commands(&self) -> [(&'static str, Vec<String>); 5] {
        [
            (
                "autotuninglevel",
                vec![
                    "int".into(),
                    "tcp".into(),
                    "set".into(),
                    "global".into(),
                    format!("autotuninglevel={}", self.autotuninglevel),
                ],
            ),
            (
                "heuristics",
                vec![
                    "int".into(),
                    "tcp".into(),
                    "set".into(),
                    "heuristics".into(),
                    self.heuristics.into(),
                ],
            ),
            (
                "initialRto",
                vec![
                    "int".into(),
                    "tcp".into(),
                    "set".into(),
                    "global".into(),
                    format!("initialRto={}", self.initial_rto),
                ],
            ),
            (
                "fastopen",
                vec![
                    "int".into(),
                    "tcp".into(),
                    "set".into(),
                    "global".into(),
                    format!("fastopen={}", self.fastopen),
                ],
            ),
            (
                "ecncapability",
                vec![
                    "int".into(),
                    "tcp".into(),
                    "set".into(),
                    "global".into(),
                    format!("ecncapability={}", self.ecncapability),
                ],
            ),
        ]
    }
}

/// Get the backup file path in the app's secure data directory.
fn backup_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    Some(dir.join("tcp-backup.conf"))
}

// ---------------------------------------------------------------------------
// Linux implementation
// ---------------------------------------------------------------------------

#[cfg(target_os = "linux")]
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn apply_network_optimizations(app: AppHandle) -> Result<(), String> {
    emit_info!(
        System,
        SYS_TUN_FAILED,
        "Applying network optimizations (Linux)..."
    );

    let config = LinuxTcpOptimConfig::from_level(get_optim_level());

    // Use app data directory for backup (consistent with macOS/Windows)
    // Read sysctl values in Rust (user space) and write backup as normal user
    let backup =
        backup_path(&app).ok_or_else(|| "Failed to resolve app data directory".to_owned())?;
    if !backup.exists() {
        if let Some(parent) = backup.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create backup directory: {e}"))?;
        }
        let mut backup_lines = Vec::new();
        for key in LinuxTcpOptimConfig::BACKUP_KEYS {
            if let Ok(output) = std::process::Command::new("sysctl")
                .args(["-n", key])
                .output()
            {
                if output.status.success() {
                    let val = String::from_utf8_lossy(&output.stdout).trim().to_owned();
                    backup_lines.push(format!("{key} = {val}"));
                }
            }
        }
        if !backup_lines.is_empty() {
            std::fs::write(&backup, backup_lines.join("\n"))
                .map_err(|e| format!("Failed to write backup file: {e}"))?;
        }
    }

    let script = generate_linux_optim_script(&config);

    let output = std::process::Command::new("pkexec")
        .args(["bash", "-c", &script, "bash"])
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
fn generate_linux_optim_script(cfg: &LinuxTcpOptimConfig) -> String {
    format!(
        r#"set -e
export PATH="/usr/sbin:/sbin:$PATH"

# TCP Fast Open + ECN
sysctl -w net.ipv4.tcp_fastopen={tcp_fastopen} 2>/dev/null || true
sysctl -w net.ipv4.tcp_ecn={tcp_ecn} 2>/dev/null || true

# HyStart: disable ACK train detection, keep RTT delay only
modprobe tcp_cubic 2>/dev/null || true
echo 2 > /sys/module/tcp_cubic/parameters/hystart_detect 2>/dev/null || true

# TCP buffer limits (raise-only)
curr_rmem_max=$(sysctl -n net.core.rmem_max 2>/dev/null | tr -cd '0-9' || echo 0)
curr_rmem_max=${{curr_rmem_max:-0}}
if [ "$curr_rmem_max" -lt {rmem_max} ] 2>/dev/null; then
    sysctl -w net.core.rmem_max={rmem_max} 2>/dev/null || true
fi
curr_wmem_max=$(sysctl -n net.core.wmem_max 2>/dev/null | tr -cd '0-9' || echo 0)
curr_wmem_max=${{curr_wmem_max:-0}}
if [ "$curr_wmem_max" -lt {wmem_max} ] 2>/dev/null; then
    sysctl -w net.core.wmem_max={wmem_max} 2>/dev/null || true
fi
read -r r_min r_def r_max <<< "$(sysctl -n net.ipv4.tcp_rmem 2>/dev/null || echo "{rmem_min} {rmem_def} {rmem_max_val}")"
r_min=${{r_min:-{rmem_min}}}; r_def=${{r_def:-{rmem_def}}}; r_max=${{r_max:-{rmem_max_val}}}
if [ "$r_def" -lt {rmem_def} ] 2>/dev/null; then r_def={rmem_def}; fi
if [ "$r_max" -lt {rmem_max_val} ] 2>/dev/null; then r_max={rmem_max_val}; fi
sysctl -w "net.ipv4.tcp_rmem=$r_min $r_def $r_max" 2>/dev/null || true
read -r w_min w_def w_max <<< "$(sysctl -n net.ipv4.tcp_wmem 2>/dev/null || echo "{wmem_min} {wmem_def} {wmem_max_val}")"
w_min=${{w_min:-{wmem_min}}}; w_def=${{w_def:-{wmem_def}}}; w_max=${{w_max:-{wmem_max_val}}}
if [ "$w_def" -lt {wmem_def} ] 2>/dev/null; then w_def={wmem_def}; fi
if [ "$w_max" -lt {wmem_max_val} ] 2>/dev/null; then w_max={wmem_max_val}; fi
sysctl -w "net.ipv4.tcp_wmem=$w_min $w_def $w_max" 2>/dev/null || true
sysctl -w net.ipv4.tcp_notsent_lowat={notsent_lowat} 2>/dev/null || true

# Persist to /etc/sysctl.d so it survives reboot
cat > /etc/sysctl.d/99-zephyr-tcp-tuning.conf << 'SYSEOF'
# Zephyr TCP performance tuning
net.ipv4.tcp_fastopen = {tcp_fastopen}
net.ipv4.tcp_ecn = {tcp_ecn}
net.core.rmem_max = {rmem_max}
net.core.wmem_max = {wmem_max}
net.ipv4.tcp_rmem = {rmem_min} {rmem_def} {rmem_max_val}
net.ipv4.tcp_wmem = {wmem_min} {wmem_def} {wmem_max_val}
net.ipv4.tcp_notsent_lowat = {notsent_lowat}
SYSEOF
chmod 644 /etc/sysctl.d/99-zephyr-tcp-tuning.conf 2>/dev/null || true"#,
        tcp_fastopen = cfg.tcp_fastopen,
        tcp_ecn = cfg.tcp_ecn,
        rmem_max = cfg.rmem_max,
        wmem_max = cfg.wmem_max,
        rmem_min = cfg.tcp_rmem.0,
        rmem_def = cfg.tcp_rmem.1,
        rmem_max_val = cfg.tcp_rmem.2,
        wmem_min = cfg.tcp_wmem.0,
        wmem_def = cfg.tcp_wmem.1,
        wmem_max_val = cfg.tcp_wmem.2,
        notsent_lowat = cfg.tcp_notsent_lowat,
    )
}

#[cfg(target_os = "linux")]
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn revert_network_optimizations(app: AppHandle) -> Result<(), String> {
    emit_info!(
        System,
        SYS_TUN_FAILED,
        "Reverting network optimizations (Linux)..."
    );

    // Use app data directory for backup (consistent with macOS/Windows)
    // Parse and validate backup in Rust (user space) to prevent privilege escalation
    let backup =
        backup_path(&app).ok_or_else(|| "Failed to resolve app data directory".to_owned())?;

    let mut restore_commands = Vec::new();
    if let Ok(content) = std::fs::read_to_string(&backup) {
        for line in content.lines() {
            if let Some((k, v)) = line.split_once('=') {
                let key = k.trim();
                let val = v.trim();
                if LinuxTcpOptimConfig::BACKUP_KEYS.contains(&key)
                    && !val.is_empty()
                    && val.chars().all(|c| c.is_ascii_digit() || c.is_whitespace())
                {
                    restore_commands.push(format!("sysctl -w {key}=\"{val}\" 2>/dev/null || true"));
                }
            }
        }
    }

    let restore_script = if restore_commands.is_empty() {
        r"sysctl -w net.ipv4.tcp_fastopen=1 2>/dev/null || true
sysctl -w net.ipv4.tcp_ecn=2 2>/dev/null || true
sysctl -w net.ipv4.tcp_notsent_lowat=4294967295 2>/dev/null || true
sysctl --system 2>/dev/null || true"
            .to_owned()
    } else {
        restore_commands.join("\n")
    };

    #[allow(clippy::literal_string_with_formatting_args)]
    let script = format!(
        r#"export PATH="/usr/sbin:/sbin:$PATH"

# Remove persisted optimization config
rm -f /etc/sysctl.d/99-zephyr-tcp-tuning.conf 2>/dev/null || true

# Restore pre-optimization values
{restore_script}

# Revert HyStart
echo 0 > /sys/module/tcp_cubic/parameters/hystart_detect 2>/dev/null || true"#
    );

    let output = std::process::Command::new("pkexec")
        .args(["bash", "-c", &script, "bash"])
        .output()
        .map_err(|e| format!("Failed to execute pkexec: {e}"))?;

    if output.status.success() {
        // Only delete backup after successful revert
        let _ = std::fs::remove_file(&backup);
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
pub fn check_network_optimizations_status(app: AppHandle) -> Result<NetworkOptimStatus, String> {
    // Check if backup exists (indicates optimizations were applied by Zephyr)
    let backup = backup_path(&app);
    let has_backup = backup.as_ref().is_some_and(|p| p.exists());

    let value = match std::fs::read_to_string("/proc/sys/net/ipv4/tcp_fastopen") {
        Ok(v) => v.trim().to_owned(),
        Err(_) => {
            return Ok(NetworkOptimStatus {
                applied: has_backup,
                details: "tcp_fastopen not available".to_owned(),
            });
        }
    };
    let applied = value == "3" || has_backup;

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
pub fn apply_network_optimizations(app: AppHandle) -> Result<(), String> {
    emit_info!(
        System,
        SYS_TUN_FAILED,
        "Applying network optimizations (macOS)..."
    );

    let config = MacosTcpOptimConfig::from_level(get_optim_level());

    // Backup current values to app data directory (secure, not /tmp)
    // Only create backup if one doesn't already exist (prevent overwriting original values)
    let backup =
        backup_path(&app).ok_or_else(|| "Failed to resolve app data directory".to_owned())?;
    if !backup.exists() {
        if let Some(parent) = backup.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create backup directory: {e}"))?;
        }
        let msl = std::process::Command::new("sysctl")
            .args(["-n", "net.inet.tcp.msl"])
            .output()
            .ok()
            .and_then(|o| {
                if o.status.success() {
                    Some(String::from_utf8_lossy(&o.stdout).trim().to_owned())
                } else {
                    None
                }
            })
            .unwrap_or_else(|| "15000".to_owned());
        let fopen = std::process::Command::new("sysctl")
            .args(["-n", "net.inet.tcp.fastopen"])
            .output()
            .ok()
            .and_then(|o| {
                if o.status.success() {
                    Some(String::from_utf8_lossy(&o.stdout).trim().to_owned())
                } else {
                    None
                }
            })
            .unwrap_or_else(|| "3".to_owned());
        let ecn = std::process::Command::new("sysctl")
            .args(["-n", "net.inet.tcp.ecn"])
            .output()
            .ok()
            .and_then(|o| {
                if o.status.success() {
                    Some(String::from_utf8_lossy(&o.stdout).trim().to_owned())
                } else {
                    None
                }
            })
            .unwrap_or_else(|| "2".to_owned());
        std::fs::write(&backup, format!("{msl} {fopen} {ecn}"))
            .map_err(|e| format!("Failed to write backup file: {e}"))?;
    }

    // Apply optimizations via osascript using config values
    let script = format!(
        r#"do shell script "sysctl -w net.inet.tcp.msl={}; sysctl -w net.inet.tcp.fastopen={}; sysctl -w net.inet.tcp.ecn={}" with administrator privileges"#,
        config.msl, config.fastopen, config.ecn
    );

    let output = std::process::Command::new("osascript")
        .args(["-e", &script])
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
pub fn revert_network_optimizations(app: AppHandle) -> Result<(), String> {
    emit_info!(
        System,
        SYS_TUN_FAILED,
        "Reverting network optimizations (macOS)..."
    );

    // Read backup from app data directory and validate values before using them
    let backup =
        backup_path(&app).ok_or_else(|| "Failed to resolve app data directory".to_owned())?;
    let (msl, fopen, ecn) = if let Ok(content) = std::fs::read_to_string(&backup) {
        let parts: Vec<&str> = content.trim().split_whitespace().collect();
        let msl = parts
            .first()
            .and_then(|v| v.parse::<u32>().ok())
            .filter(|&v| (1000..=60000).contains(&v))
            .unwrap_or(15000);
        let fopen = parts
            .get(1)
            .and_then(|v| v.parse::<u32>().ok())
            .filter(|&v| v <= 3)
            .unwrap_or(3);
        let ecn = parts
            .get(2)
            .and_then(|v| v.parse::<u32>().ok())
            .filter(|&v| v <= 2)
            .unwrap_or(2);
        (msl, fopen, ecn)
    } else {
        (15000u32, 3u32, 2u32)
    };

    // Use validated integer values to prevent command injection
    let script = format!(
        r#"do shell script "sysctl -w net.inet.tcp.msl={msl}; sysctl -w net.inet.tcp.fastopen={fopen}; sysctl -w net.inet.tcp.ecn={ecn}" with administrator privileges"#
    );

    let output = std::process::Command::new("osascript")
        .args(["-e", &script])
        .output()
        .map_err(|e| format!("Failed to run osascript: {e}"))?;

    if output.status.success() {
        // Only delete backup after successful revert
        let _ = std::fs::remove_file(&backup);
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
pub fn check_network_optimizations_status(app: AppHandle) -> Result<NetworkOptimStatus, String> {
    // Check if backup exists (indicates optimizations were applied by Zephyr)
    let backup = backup_path(&app);
    let has_backup = backup.as_ref().is_some_and(|p| p.exists());

    let output = match std::process::Command::new("sysctl")
        .args(["-n", "net.inet.tcp.msl"])
        .output()
    {
        Ok(o) => o,
        Err(_) => {
            return Ok(NetworkOptimStatus {
                applied: has_backup,
                details: "sysctl command not available".to_owned(),
            });
        }
    };

    if !output.status.success() {
        return Ok(NetworkOptimStatus {
            applied: has_backup,
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
pub fn apply_network_optimizations(app: AppHandle) -> Result<(), String> {
    use std::os::windows::process::CommandExt;

    emit_info!(
        System,
        SYS_TUN_FAILED,
        "Applying network optimizations (Windows)..."
    );

    let config = WindowsTcpOptimConfig::from_level(get_optim_level());

    // Backup current values from registry before modifying (use app data dir, not temp)
    // Only create backup if one doesn't already exist (prevent overwriting original values)
    let backup =
        backup_path(&app).ok_or_else(|| "Failed to resolve app data directory".to_owned())?;
    if !backup.exists() {
        if let Some(parent) = backup.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create backup directory: {e}"))?;
        }
        let mut backup_lines = Vec::new();

        {
            use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ};
            use winreg::RegKey;
            let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
            if let Ok(key) = hklm.open_subkey_with_flags(
                r"SYSTEM\CurrentControlSet\Services\Tcpip\Parameters",
                KEY_READ,
            ) {
                for &reg_key in WindowsTcpOptimConfig::BACKUP_REGISTRY_KEYS {
                    if let Ok(val) = key.get_value::<u32, _>(reg_key) {
                        backup_lines.push(format!("{reg_key}={val}"));
                    }
                }
            }
        }
        std::fs::write(&backup, backup_lines.join("\n"))
            .map_err(|e| format!("Failed to write backup file: {e}"))?;
    }

    let optimizations = config.to_netsh_commands();

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
pub fn revert_network_optimizations(app: AppHandle) -> Result<(), String> {
    emit_info!(
        System,
        SYS_TUN_FAILED,
        "Reverting network optimizations (Windows)..."
    );

    use std::os::windows::process::CommandExt;

    // Try to restore from backup (app data dir, not temp); fall back to system defaults
    let backup =
        backup_path(&app).ok_or_else(|| "Failed to resolve app data directory".to_owned())?;
    let backup_content = if backup.exists() {
        std::fs::read_to_string(&backup).unwrap_or_default()
    } else {
        String::new()
    };

    // Restore registry values from backup (whitelist-validated to prevent privilege escalation)
    if !backup_content.is_empty() {
        use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_WRITE};
        use winreg::RegKey;
        let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
        if let Ok(key) = hklm.open_subkey_with_flags(
            r"SYSTEM\CurrentControlSet\Services\Tcpip\Parameters",
            KEY_WRITE,
        ) {
            for line in backup_content.lines() {
                if let Some((k, v)) = line.split_once('=') {
                    let key_name = k.trim();
                    if WindowsTcpOptimConfig::BACKUP_REGISTRY_KEYS.contains(&key_name) {
                        if let Ok(val) = v.trim().parse::<u32>() {
                            let _ = key.set_value(key_name, &val);
                        }
                    }
                }
            }
        }
    }

    // Parse backup for netsh values; fall back to system defaults
    let mut auto_level = "normal".to_owned();
    let mut heuristics = "enabled".to_owned();
    let mut fastopen = "disabled";
    let mut ecncapability = "disabled";
    let mut initial_rto: u32 = 3000;
    for line in backup_content.lines() {
        let lower = line.to_lowercase();
        if lower.starts_with("tcpautotuninglevel=") {
            // TcpAutoTuningLevel registry: 0=disabled, 1=restricted,
            // 2=highlyrestricted, 3=normal, 4=experimental
            if let Some(val) = line.split_once('=') {
                auto_level = match val.1.trim().parse::<u32>().unwrap_or(3) {
                    0 => "disabled".to_owned(),
                    1 => "restricted".to_owned(),
                    2 => "highlyrestricted".to_owned(),
                    4 => "experimental".to_owned(),
                    _ => "normal".to_owned(),
                };
            }
        } else if lower.starts_with("enabletcpheuristics=") {
            // EnableTCPHeuristics registry: 0=disabled, 1=enabled
            if let Some(val) = line.split_once('=') {
                heuristics = if val.1.trim().parse::<u32>().unwrap_or(1) == 1 {
                    "enabled".to_owned()
                } else {
                    "disabled".to_owned()
                };
            }
        } else if lower.starts_with("autotuninglevel=") {
            // Legacy format from netsh parsing
            if let Some(val) = line.split_once('=') {
                auto_level = val.1.trim().to_owned();
            }
        } else if lower.starts_with("heuristics=") {
            // Legacy format from netsh parsing
            if let Some(val) = line.split_once('=') {
                heuristics = val.1.trim().to_owned();
            }
        } else if lower.starts_with("tcpfastopen=") {
            // TcpFastOpen registry: 0=disabled, >=1=enabled
            if let Some(val) = line.split_once('=') {
                if val.1.trim().parse::<u32>().unwrap_or(0) >= 1 {
                    fastopen = "enabled";
                }
            }
        } else if lower.starts_with("ecncapability=") {
            // EcnCapability registry: 1=enabled, 0=disabled, 2=default
            if let Some(val) = line.split_once('=') {
                match val.1.trim().parse::<u32>().unwrap_or(0) {
                    1 => ecncapability = "enabled",
                    2 => ecncapability = "default",
                    _ => ecncapability = "disabled",
                }
            }
        } else if lower.starts_with("tcpinitialrto=") {
            if let Some(val) = line.split_once('=') {
                if let Ok(v) = val.1.trim().parse::<u32>() {
                    initial_rto = v;
                }
            }
        }
    }

    // Build revert commands with backed-up or default values
    // Validate auto_level and heuristics against strict whitelists
    const VALID_AUTO_LEVELS: &[&str] = &[
        "normal",
        "restricted",
        "highlyrestricted",
        "experimental",
        "disabled",
    ];
    const VALID_HEURISTICS: &[&str] = &["enabled", "disabled"];
    if !VALID_AUTO_LEVELS.contains(&auto_level.to_lowercase().as_str()) {
        auto_level = "normal".to_owned();
    }
    if !VALID_HEURISTICS.contains(&heuristics.to_lowercase().as_str()) {
        heuristics = "enabled".to_owned();
    }
    let auto_level_arg = format!("autotuninglevel={auto_level}");
    let heuristics_arg = heuristics.to_lowercase();
    let fastopen_arg = format!("fastopen={fastopen}");
    let ecncapability_arg = format!("ecncapability={ecncapability}");
    let initial_rto_arg = format!("initialRto={initial_rto}");
    let reverts: [(&str, Vec<&str>); 5] = [
        (
            "autotuninglevel",
            vec!["int", "tcp", "set", "global", &auto_level_arg],
        ),
        (
            "heuristics",
            vec!["int", "tcp", "set", "heuristics", &heuristics_arg],
        ),
        (
            "initialRto",
            vec!["int", "tcp", "set", "global", &initial_rto_arg],
        ),
        (
            "fastopen",
            vec!["int", "tcp", "set", "global", &fastopen_arg],
        ),
        (
            "ecncapability",
            vec!["int", "tcp", "set", "global", &ecncapability_arg],
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
        // Only delete backup after successful revert
        let _ = std::fs::remove_file(&backup);
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
pub fn check_network_optimizations_status(app: AppHandle) -> Result<NetworkOptimStatus, String> {
    // Check if backup exists (indicates optimizations were applied by Zephyr)
    let backup = backup_path(&app);
    let has_backup = backup.as_ref().is_some_and(|p| p.exists());

    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ};
    use winreg::RegKey;

    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let key_path = r"SYSTEM\CurrentControlSet\Services\Tcpip\Parameters";

    let tcp_fastopen_enabled = match hklm.open_subkey_with_flags(key_path, KEY_READ) {
        Ok(key) => match key.get_value::<u32, _>("TcpFastOpen") {
            Ok(val) => val >= 1,
            Err(_) => false,
        },
        Err(_) => false,
    };

    let applied = tcp_fastopen_enabled || has_backup;

    Ok(NetworkOptimStatus {
        applied,
        details: if applied {
            "TCP optimizations applied".to_owned()
        } else {
            "TCP optimizations not applied".to_owned()
        },
    })
}

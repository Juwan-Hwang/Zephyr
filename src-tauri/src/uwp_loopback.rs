use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

// Rate limiting: Maximum 1 UWP exemption operation per 5 minutes
static LAST_UWP_OPERATION: AtomicU64 = AtomicU64::new(0);
const UWP_OPERATION_COOLDOWN_SECS: u64 = 300; // 5 minutes

/// Check if enough time has passed since last UWP operation (rate limiting)
fn check_rate_limit() -> Result<(), String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| format!("System time error: {}", e))?
        .as_secs();
    
    let last_op = LAST_UWP_OPERATION.load(Ordering::SeqCst);
    
    if last_op > 0 && now < last_op + UWP_OPERATION_COOLDOWN_SECS {
        let remaining = (last_op + UWP_OPERATION_COOLDOWN_SECS) - now;
        return Err(format!(
            "Rate limit: Please wait {} seconds before requesting UWP exemption again",
            remaining
        ));
    }
    
    Ok(())
}

/// Validate that this is a legitimate call by checking various security markers
fn validate_legitimate_call(app: &AppHandle) -> Result<(), String> {
    // Check if the app is in a valid state
    let app_state = app.state::<crate::MihomoState>();
    let core_running = app_state.0.lock()
        .map(|guard| guard.process.is_some())
        .unwrap_or(false);
    
    // Log the security validation
    eprintln!(
        "[Security] UWP exemption request - Core running: {}, Timestamp: {:?}",
        core_running,
        std::time::SystemTime::now()
    );
    
    // Additional check: ensure we have a window (prevents headless calls)
    if app.get_webview_window("main").is_none() {
        return Err("Invalid call source: Main window not found".to_string());
    }
    
    Ok(())
}

#[tauri::command]
pub async fn exempt_uwp_apps(app: AppHandle) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        // Step 1: Rate limiting check
        check_rate_limit()?;
        
        // Step 2: Validate this is a legitimate call
        validate_legitimate_call(&app)?;
        
        // Step 3: Require user confirmation through dialog
        let (tx, rx) = std::sync::mpsc::channel();
        app.dialog()
            .message("An action requires Administrator privileges to exempt UWP loopback restrictions. Do you want to proceed?\n\nThis will allow Windows Store apps to access local proxy services.")
            .title("Security Confirmation")
            .kind(tauri_plugin_dialog::MessageDialogKind::Warning)
            .show(move |result| {
                tx.send(result).unwrap_or(());
            });
            
        let confirmed = rx.recv().unwrap_or(false);
        if !confirmed {
            return Err("Operation cancelled by user".to_string());
        }
        
        // Step 4: Update rate limit timestamp
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        LAST_UWP_OPERATION.store(now, Ordering::SeqCst);

        use std::os::windows::process::CommandExt;
        use base64::{Engine, engine::general_purpose::STANDARD};
        const CREATE_NO_WINDOW: u32 = 0x08000000;

        // Apply loopback exemption to all non-framework Appx packages.
        let inner_script = r#"
Get-AppxPackage | Where-Object { 
    $_.IsFramework -eq $false 
} | ForEach-Object { 
    CheckNetIsolation.exe LoopbackExempt -a -n="$($_.PackageFamilyName)" 
}
"#;
        let utf16: Vec<u8> = inner_script.encode_utf16().flat_map(|c| c.to_le_bytes()).collect();
        let encoded = STANDARD.encode(&utf16);

        let outer_script = format!(
            "Start-Process powershell -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','{}' -Verb RunAs -WindowStyle Hidden -Wait",
            encoded
        );

        let mut cmd = Command::new("powershell");
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.args(&["-NoProfile", "-NonInteractive", "-Command", &outer_script]);

        match cmd.status() {
            Ok(status) if status.success() => {
                eprintln!("[Security] UWP exemption completed successfully");
                Ok("UWP Loopback exemption process started. Please check the UAC prompt.".to_string())
            },
            Ok(status) => {
                eprintln!("[Security] UWP exemption failed with status: {}", status);
                Err(format!("PowerShell exited with status: {}", status))
            },
            Err(e) => {
                eprintln!("[Security] UWP exemption failed with error: {}", e);
                Err(format!("Failed to execute PowerShell: {}", e))
            },
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("UWP Loopback exemption is only available on Windows".to_string())
    }
}

use std::fs::{self, File, OpenOptions};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Manages writing to a daily-rotated log file with size limits.
pub struct LogWriter {
    log_dir: PathBuf,
    max_file_bytes: u64,
    current_file: Mutex<Option<CurrentFile>>,
}

struct CurrentFile {
    file: File,
    date: String,
    written_bytes: u64,
}

impl LogWriter {
    #[must_use]
    pub fn new(log_dir: PathBuf, max_file_mb: u32) -> Self {
        let _ = fs::create_dir_all(&log_dir);
        Self {
            log_dir,
            max_file_bytes: max_file_mb as u64 * 1024 * 1024,
            current_file: Mutex::new(None),
        }
    }

    /// Append a line to today's log file.
    /// Rotates to a new file if date changed or size exceeded.
    pub fn write_line(&self, line: &str) -> Result<(), String> {
        let today = today_string();
        let mut guard = self
            .current_file
            .lock()
            .map_err(|e| format!("LogWriter lock poisoned: {e}"))?;

        let needs_new_file = match guard.as_ref() {
            None => true,
            Some(cf) => cf.date != today || cf.written_bytes >= self.max_file_bytes,
        };

        if needs_new_file {
            let (file, _seq) = self.open_new_file(&today)?;
            *guard = Some(CurrentFile {
                file,
                date: today,
                written_bytes: 0,
            });
        }

        if let Some(cf) = guard.as_mut() {
            let bytes = line.len() as u64 + 1; // +1 for newline
            if let Err(e) = writeln!(cf.file, "{line}") {
                return Err(format!("Failed to write log line: {e}"));
            }
            cf.written_bytes += bytes;
        }

        drop(guard);
        Ok(())
    }

    /// Open a new log file for the given date.
    /// Returns `(File, sequence_number)`.
    /// If `{date}.log` already exceeds max size, tries `{date}-2.log`, etc.
    fn open_new_file(&self, date: &str) -> Result<(File, u32), String> {
        // Try seq=1 first (the primary file for the day)
        let path = self.log_dir.join(format!("{date}.log"));
        if path.exists() {
            if let Ok(meta) = fs::metadata(&path) {
                if meta.len() >= self.max_file_bytes {
                    // Find next available sequence number
                    return self.open_seq_file(date);
                }
            }
            // File exists but under size limit — append to it
            let file = OpenOptions::new()
                .append(true)
                .open(&path)
                .map_err(|e| format!("Failed to open log file {path:?}: {e}"))?;
            return Ok((file, 1));
        }

        // Create new file
        self.create_file_with_permissions(&path)
    }

    /// Open a sequenced file ({date}-2.log, {date}-3.log, ...).
    fn open_seq_file(&self, date: &str) -> Result<(File, u32), String> {
        for seq in 2..100 {
            let path = self.log_dir.join(format!("{date}-{seq}.log"));
            if path.exists() {
                if let Ok(meta) = fs::metadata(&path) {
                    if meta.len() >= self.max_file_bytes {
                        continue;
                    }
                }
                let file = OpenOptions::new()
                    .append(true)
                    .open(&path)
                    .map_err(|e| format!("Failed to open log file {path:?}: {e}"))?;
                return Ok((file, seq));
            }
            return self.create_file_with_permissions(&path);
        }
        Err("Too many log file sequences for one day".to_owned())
    }

    /// Create a new file with restricted permissions (owner-only on Unix).
    fn create_file_with_permissions(&self, path: &Path) -> Result<(File, u32), String> {
        let file =
            File::create(path).map_err(|e| format!("Failed to create log file {path:?}: {e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
        }
        Ok((file, 1))
    }
}

/// Get today's date string in YYYY-MM-DD format.
fn today_string() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

/// Remove log files older than `retention_days` in the given directory.
pub fn cleanup_old_logs(log_dir: &Path, retention_days: u32) {
    if retention_days == 0 || !log_dir.exists() {
        return;
    }
    let cutoff = std::time::SystemTime::now()
        - std::time::Duration::from_secs(retention_days as u64 * 86400);

    if let Ok(entries) = fs::read_dir(log_dir) {
        for entry in entries.flatten() {
            if let Ok(metadata) = entry.metadata() {
                if metadata.is_file() {
                    if let Ok(modified) = metadata.modified() {
                        if modified < cutoff {
                            let _ = fs::remove_file(entry.path());
                        }
                    }
                }
            }
        }
    }
}

/// Collect log files matching a date range `[from_date, to_date]` inclusive.
/// Date format: "YYYY-MM-DD"
#[must_use]
pub fn collect_log_files(log_dir: &Path, from_date: &str, to_date: &str) -> Vec<PathBuf> {
    if !log_dir.exists() {
        return Vec::new();
    }
    let mut result = Vec::new();
    if let Ok(entries) = fs::read_dir(log_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                // Extract date from filename: "2026-06-11.log" or "2026-06-11-2.log"
                let file_date = if let Some(d) = name.get(..10) {
                    d
                } else {
                    continue;
                };
                // Validate date format
                if file_date.len() == 10
                    && file_date.chars().nth(4) == Some('-')
                    && file_date.chars().nth(7) == Some('-')
                    && file_date >= from_date
                    && file_date <= to_date
                {
                    result.push(path);
                }
            }
        }
    }
    result.sort();
    result
}

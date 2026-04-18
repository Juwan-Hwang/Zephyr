use tauri::State;

use super::{MihomoState, ReadLogResult};

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn read_core_log(
    state: State<'_, MihomoState>,
    offset: Option<u64>,
    limit: Option<usize>,
) -> Result<ReadLogResult, String> {
    let lock = state.0.lock().map_err(|e| e.to_string())?;
    let log_path = lock
        .last_log_path
        .as_ref()
        .ok_or("No log file available (core not started)")?;
    let log_path_owned = log_path.clone();
    drop(lock);

    let file = std::fs::File::open(&log_path_owned)
        .map_err(|e| format!("Failed to open log file: {e}"))?;

    let metadata = std::fs::metadata(&log_path_owned)
        .map_err(|e| format!("Failed to read log metadata: {e}"))?;
    let file_size = metadata.len();

    let start_offset = offset.unwrap_or(0);

    // Detect log rotation: if the requested offset exceeds the current file size,
    // the file was likely rotated. Signal the frontend to reset.
    let rotated = start_offset > file_size;

    use std::io::{BufRead as _, Seek as _, SeekFrom};
    let mut reader = std::io::BufReader::new(file);

    if start_offset > 0 && !rotated {
        reader
            .seek(SeekFrom::Start(start_offset))
            .map_err(|e| e.to_string())?;
    }

    let max_lines = limit.unwrap_or(500).min(2000);
    let mut lines = Vec::with_capacity(max_lines);
    let mut bytes_read = if rotated { 0 } else { start_offset };

    for _ in 0..max_lines {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(n) => {
                bytes_read += n as u64;
                lines.push(line);
            }
            Err(e) => return Err(format!("Failed to read log: {e}")),
        }
    }

    Ok(ReadLogResult {
        lines,
        next_offset: bytes_read,
        file_size,
        has_more: bytes_read < file_size,
        rotated,
    })
}

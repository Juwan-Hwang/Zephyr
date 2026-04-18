use tauri::State;

use super::{MihomoState, ReadLogResult};

/// Read lines from a log file starting at `start_offset`, up to `max_lines`.
///
/// This is the pure-logic core of `read_core_log`, extracted for testability.
/// Returns `ReadLogResult` with the read lines, next byte offset, and rotation flag.
#[cfg(test)]
fn read_log_file(
    path: &std::path::Path,
    start_offset: u64,
    max_lines: usize,
) -> Result<ReadLogResult, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("Failed to open log file: {e}"))?;

    let metadata =
        std::fs::metadata(path).map_err(|e| format!("Failed to read log metadata: {e}"))?;
    let file_size = metadata.len();

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

    let capped_max_lines = max_lines.min(2000);
    let mut lines = Vec::with_capacity(capped_max_lines);
    let mut bytes_read = if rotated { 0 } else { start_offset };

    for _ in 0..capped_max_lines {
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

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;
    use std::io::Write as _;

    fn create_temp_log_file(content: &str) -> tempfile::NamedTempFile {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        write!(file, "{content}").unwrap();
        file
    }

    #[test]
    fn test_read_log_from_start() {
        let file = create_temp_log_file("line1\nline2\nline3\n");
        let result = read_log_file(file.path(), 0, 100).unwrap();
        assert_eq!(result.lines.len(), 3);
        assert_eq!(result.lines[0], "line1\n");
        assert_eq!(result.lines[1], "line2\n");
        assert_eq!(result.lines[2], "line3\n");
        assert!(!result.has_more);
        assert!(!result.rotated);
    }

    #[test]
    fn test_read_log_with_offset() {
        let file = create_temp_log_file("line1\nline2\nline3\n");
        let result = read_log_file(file.path(), 6, 100).unwrap();
        assert_eq!(result.lines.len(), 2);
        assert_eq!(result.lines[0], "line2\n");
        assert_eq!(result.lines[1], "line3\n");
    }

    #[test]
    fn test_read_log_limit_lines() {
        let file = create_temp_log_file("a\nb\nc\nd\ne\n");
        let result = read_log_file(file.path(), 0, 2).unwrap();
        assert_eq!(result.lines.len(), 2);
        assert_eq!(result.lines[0], "a\n");
        assert_eq!(result.lines[1], "b\n");
        assert!(result.has_more);
    }

    #[test]
    fn test_read_log_rotation_detected() {
        let file = create_temp_log_file("short\n");
        let file_size = file.path().metadata().unwrap().len();
        let result = read_log_file(file.path(), file_size + 1000, 100).unwrap();
        assert!(result.rotated);
        assert_eq!(result.lines.len(), 1);
    }

    #[test]
    fn test_read_log_empty_file() {
        let file = create_temp_log_file("");
        let result = read_log_file(file.path(), 0, 100).unwrap();
        assert_eq!(result.lines.len(), 0);
        assert!(!result.has_more);
        assert_eq!(result.next_offset, 0);
    }

    #[test]
    fn test_read_log_nonexistent_file() {
        let result = read_log_file(std::path::Path::new("/nonexistent/path/log.txt"), 0, 100);
        assert!(result.is_err());
    }

    #[test]
    fn test_read_log_next_offset_advances() {
        let file = create_temp_log_file("hello\nworld\n");
        let result = read_log_file(file.path(), 0, 100).unwrap();
        assert_eq!(result.next_offset, result.file_size);
    }

    #[test]
    fn test_read_log_max_lines_capped_at_2000() {
        let content: String = (0..3000)
            .map(|i| format!("line{i}\n"))
            .collect::<Vec<_>>()
            .join("");
        let file = create_temp_log_file(&content);
        let result = read_log_file(file.path(), 0, 5000).unwrap();
        assert_eq!(result.lines.len(), 2000);
        assert!(result.has_more);
    }
}

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

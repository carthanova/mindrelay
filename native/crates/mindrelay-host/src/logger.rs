use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::time::SystemTime;

const MAX_LOG_BYTES: u64 = 1_048_576; // 1 MB

pub struct Logger {
    path: PathBuf,
}

impl Logger {
    /// Create a logger that writes to `path`. The parent directory is created
    /// automatically if it does not exist.
    pub fn new(path: PathBuf) -> Self {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        Logger { path }
    }

    pub fn info(&self, msg: &str) {
        self.write_line("INFO", msg);
    }

    pub fn warn(&self, msg: &str) {
        self.write_line("WARN", msg);
    }

    #[allow(dead_code)]
    pub fn error(&self, msg: &str) {
        self.write_line("ERROR", msg);
    }

    fn write_line(&self, level: &str, msg: &str) {
        let ts = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let line = format!("[{ts}] [{level}] {msg}\n");

        // Rotate if the current log file has grown past the threshold.
        // Rename → .log.1 (overwriting the previous backup), then start fresh.
        if let Ok(meta) = fs::metadata(&self.path) {
            if meta.len() >= MAX_LOG_BYTES {
                let backup = self.path.with_extension("log.1");
                let _ = fs::rename(&self.path, &backup);
            }
        }

        // Append — silently drop errors (logger must never panic the host).
        if let Ok(mut file) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
        {
            let _ = file.write_all(line.as_bytes());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn writes_info_line() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("test.log");
        let logger = Logger::new(path.clone());
        logger.info("hello world");
        let contents = fs::read_to_string(&path).unwrap();
        assert!(contents.contains("[INFO] hello world"));
    }

    #[test]
    fn rotates_when_size_exceeded() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("rotate.log");

        // Pre-fill the log file to just above the rotation threshold
        let filler = "x".repeat(MAX_LOG_BYTES as usize);
        fs::write(&path, filler.as_bytes()).unwrap();

        let logger = Logger::new(path.clone());
        logger.info("after rotation");

        // The original file should now contain only the new line
        let contents = fs::read_to_string(&path).unwrap();
        assert!(contents.contains("after rotation"));
        assert!(!contents.contains("x".repeat(100).as_str()));

        // The backup should exist
        let backup = path.with_extension("log.1");
        assert!(backup.exists());
    }
}

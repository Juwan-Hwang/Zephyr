/// Unified error type for Zephyr core library.
/// All FFI boundary errors use this type for cross-platform compatibility.
#[cfg_attr(feature = "uniffi", derive(uniffi::Error))]
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("IO error: {0}")]
    IoError(String),

    #[error("Network error: {0}")]
    NetworkError(String),

    #[error("Config error: {0}")]
    ConfigError(String),

    #[error("Crypto error: {0}")]
    CryptoError(String),

    #[error("Cancelled")]
    Cancelled,

    #[error("Parse error: {0}")]
    ParseError(String),

    #[error("Unknown error: {0}")]
    UnknownError(String),
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::IoError(e.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::ParseError(e.to_string())
    }
}

//! `smart_state.rs` - 异步持久化层，复用 `clash_prism_smart` 数据模型
//!
//! 设计约束:
//! - IPC 命令立即返回 (非阻塞)
//! - 数据可靠持久化 (崩溃可恢复)
//! - 无定时器、无退出 flush
//! - 完全兼容 `clash_prism_smart::NodeHistory`

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use clash_prism_smart::history::NodeHistory;
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

// ═════════════════════════════════════════════════════════════════════════════
// 1. WAL 记录格式
// ═════════════════════════════════════════════════════════════════════════════

/// 变更记录 (WAL 格式)
///
/// timestamp 字段保留用于未来扩展（如 EMA 时间衰减计算）
#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum ChangeRecord {
    Update {
        node_name: String,
        latency_ms: f64,
        success: bool,
        /// 保留用于未来扩展，当前 unused
        #[allow(dead_code)]
        timestamp: i64,
    },
}

// ═════════════════════════════════════════════════════════════════════════════
// 2. 配置
// ═════════════════════════════════════════════════════════════════════════════

#[derive(Clone, Debug)]
pub struct SmartStateConfig {
    /// 触发主文件刷新的变更阈值
    pub flush_threshold: usize,
    /// WAL 文件路径
    pub wal_path: PathBuf,
    /// 主数据文件路径
    pub data_path: PathBuf,
}

impl SmartStateConfig {
    #[must_use]
    pub fn new(prism_dir: &Path) -> Self {
        Self {
            flush_threshold: 10,
            wal_path: prism_dir.join("smart_history.wal"),
            data_path: prism_dir.join("smart_history.json"),
        }
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// 3. 核心状态
// ═════════════════════════════════════════════════════════════════════════════

#[derive(Clone)]
pub struct SmartState {
    /// 无锁并发哈希表，存储 `clash_prism_smart::NodeHistory`
    histories: Arc<DashMap<String, NodeHistory>>,
    /// 变更发送通道 (bounded，背压保护)
    tx: mpsc::Sender<ChangeRecord>,
}

impl SmartState {
    /// 初始化 `SmartState`
    pub async fn init(config: SmartStateConfig) -> Result<Self, String> {
        // 启动恢复
        let recovered = Self::recover(&config).await?;
        let histories = Arc::new(recovered);

        // 创建 bounded 通道 (背压保护)
        let (tx, rx) = mpsc::channel(256);

        // 启动后台写入任务
        let bg_histories = Arc::clone(&histories);
        tokio::spawn(Self::writer_task(config, bg_histories, rx));

        Ok(Self { histories, tx })
    }

    /// 崩溃恢复
    async fn recover(config: &SmartStateConfig) -> Result<DashMap<String, NodeHistory>, String> {
        let histories: DashMap<String, NodeHistory> = DashMap::new();

        // 1. 加载主数据文件 (clash_prism_smart::NodeHistory 格式)
        if config.data_path.exists() {
            let data = tokio::fs::read_to_string(&config.data_path)
                .await
                .map_err(|e| format!("Failed to read data file: {e}"))?;

            let loaded: HashMap<String, NodeHistory> =
                serde_json::from_str(&data).unwrap_or_default();

            #[allow(clippy::iter_over_hash_type)]
            for (k, v) in loaded {
                histories.insert(k, v);
            }
        }

        // 2. 重放 WAL
        if config.wal_path.exists() {
            let wal_data = tokio::fs::read_to_string(&config.wal_path)
                .await
                .unwrap_or_default();

            for line in wal_data.lines().filter(|l| !l.is_empty()) {
                if let Ok(record) = serde_json::from_str::<ChangeRecord>(line) {
                    Self::apply_record(&histories, &record);
                }
            }

            // 重放完成后立即刷新主文件（只有成功才删除 WAL）
            if Self::flush_main(&histories, &config.data_path).await.is_ok() {
                let _ = tokio::fs::remove_file(&config.wal_path).await;
            }
        }

        Ok(histories)
    }

    /// 应用单条记录到内存 (使用 `NodeHistory::add_record`)
    fn apply_record(histories: &DashMap<String, NodeHistory>, record: &ChangeRecord) {
        match record {
            ChangeRecord::Update {
                node_name,
                latency_ms,
                success,
                ..
            } => {
                let mut entry = histories
                    .entry(node_name.clone())
                    .or_insert_with(|| NodeHistory::new(node_name));
                entry.add_record(*latency_ms, *success);
            }
        }
    }

    /// 后台写入任务 (无定时器，纯事件驱动)
    async fn writer_task(
        config: SmartStateConfig,
        histories: Arc<DashMap<String, NodeHistory>>,
        mut rx: mpsc::Receiver<ChangeRecord>,
    ) {
        let mut buffer: Vec<ChangeRecord> = Vec::with_capacity(config.flush_threshold);
        let mut last_node: Option<String> = None;

        // 保持 WAL 文件句柄打开，避免重复打开文件
        let mut wal_file = Self::open_wal_file(&config.wal_path).await.ok();

        while let Some(record) = rx.recv().await {
            let current_node = match &record {
                ChangeRecord::Update { node_name, .. } => Some(node_name.clone()),
            };

            // 1. 立即追加到 WAL (崩溃安全)
            if let Some(ref mut file) = wal_file {
                if let Err(e) = Self::append_wal_to_file(file, &record).await {
                    eprintln!("[smart_state] WAL append failed: {e}");
                }
            }

            // 2. 检测节点切换 (测速顺序进行的天然边界)
            let node_switched = last_node.is_some()
                && current_node.is_some()
                && last_node.as_ref() != current_node.as_ref();

            buffer.push(record);

            // 3. 阈值触发或节点切换触发刷新
            if buffer.len() >= config.flush_threshold || node_switched {
                if Self::flush_main(&histories, &config.data_path).await.is_ok() {
                    // 只有 flush 成功才删除 WAL
                    if let Err(e) = tokio::fs::remove_file(&config.wal_path).await {
                        eprintln!("[smart_state] WAL remove failed: {e}");
                    }
                    // 重新打开 WAL 文件
                    wal_file = Self::open_wal_file(&config.wal_path).await.ok();
                } else {
                    eprintln!("[smart_state] Flush failed, keeping WAL for recovery");
                }
                buffer.clear();
            }

            last_node = current_node;
        }

        // 通道关闭时刷出剩余数据
        if !buffer.is_empty() && Self::flush_main(&histories, &config.data_path).await.is_ok() {
            let _ = tokio::fs::remove_file(&config.wal_path).await;
        }
    }

    /// 打开 WAL 文件（用于保持句柄）
    async fn open_wal_file(wal_path: &Path) -> Result<tokio::fs::File, String> {
        tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(wal_path)
            .await
            .map_err(|e| e.to_string())
    }

    /// 追加记录到已打开的 WAL 文件
    async fn append_wal_to_file(
        file: &mut tokio::fs::File,
        record: &ChangeRecord,
    ) -> Result<(), String> {
        let line = serde_json::to_string(record).map_err(|e| e.to_string())?;

        use tokio::io::AsyncWriteExt as _;
        file.write_all(line.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        file.write_all(b"\n").await.map_err(|e| e.to_string())?;
        file.sync_data().await.map_err(|e| e.to_string())?;

        Ok(())
    }

    /// 刷新主数据文件
    async fn flush_main(
        histories: &DashMap<String, NodeHistory>,
        data_path: &Path,
    ) -> Result<(), String> {
        let snapshot: HashMap<String, NodeHistory> = histories
            .iter()
            .map(|e| (e.key().clone(), e.value().clone()))
            .collect();

        // 使用紧凑格式 (生产环境)
        let json = serde_json::to_string(&snapshot).map_err(|e| e.to_string())?;

        // 原子写入
        let temp_path = data_path.with_extension("tmp");
        tokio::fs::write(&temp_path, json)
            .await
            .map_err(|e| e.to_string())?;
        tokio::fs::rename(&temp_path, data_path)
            .await
            .map_err(|e| e.to_string())?;

        Ok(())
    }

    // ═════════════════════════════════════════════════════════════════════════
    // 4. 公开 API
    // ═════════════════════════════════════════════════════════════════════════

    /// 记录节点评分 (非阻塞，立即返回)
    ///
    /// 只负责记录数据到内存和 WAL，评分计算由调用方使用 `SmartScorer` 完成
    /// 这样可以确保评分时使用最新的 smart.toml 配置（权重等）
    pub fn record(&self, node_name: &str, latency_ms: f64, success: bool) -> Result<(), String> {
        let timestamp = chrono::Utc::now().timestamp_millis();

        // 更新内存 (使用 clash_prism_smart::NodeHistory)
        let mut entry = self
            .histories
            .entry(node_name.to_owned())
            .or_insert_with(|| NodeHistory::new(node_name));
        entry.add_record(latency_ms, success);
        drop(entry);

        // 发送变更到后台 (try_send，背压保护)
        let record = ChangeRecord::Update {
            node_name: node_name.to_owned(),
            latency_ms,
            success,
            timestamp,
        };

        // try_send: 满了就丢弃 (WAL 已保证安全)
        let _ = self.tx.try_send(record);

        Ok(())
    }

    /// 获取节点历史 (返回 `clash_prism_smart::NodeHistory`)
    #[must_use]
    pub fn get_history(&self, node_name: &str) -> Option<NodeHistory> {
        self.histories.get(node_name).map(|e| e.clone())
    }

    /// 获取所有历史 (返回兼容的 `HashMap`)
    #[must_use]
    pub fn get_all_histories(&self) -> HashMap<String, NodeHistory> {
        self.histories
            .iter()
            .map(|e| (e.key().clone(), e.value().clone()))
            .collect()
    }

    /// 清空所有历史数据
    pub fn clear(&self) {
        self.histories.clear();
    }

    /// 裁剪历史数据到指定最大记录数
    pub fn trim(&self, max_records: usize) {
        for mut entry in self.histories.iter_mut() {
            entry.trim(max_records);
        }
    }
}

// Include comprehensive tests
#[cfg(test)]
#[path = "smart_state_tests.rs"]
mod smart_state_tests;

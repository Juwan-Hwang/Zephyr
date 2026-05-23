//! `smart_state.rs` - 异步持久化层，复用 `clash_prism_smart` 数据模型
//!
//! 设计约束:
//! - IPC 命令立即返回 (非阻塞)
//! - 数据可靠持久化 (崩溃可恢复)
//! - 无定时器、无退出 flush
//! - 完全兼容 `clash_prism_smart::NodeHistory`

use std::collections::BTreeMap;
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
/// - `Update`: 记录节点评分
/// - `Clear`: 清空所有历史（不写入 WAL，只用于后台任务信号）
#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum ChangeRecord {
    Update {
        node_name: String,
        latency_ms: f64,
        success: bool,
        /// 用于去重和时序判断
        timestamp: i64,
    },
    /// 清空信号（不序列化到 WAL）
    #[serde(skip)]
    Clear,
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

        // 创建 bounded 通道 (容量 1024，应对高负载突发)
        let (tx, rx) = mpsc::channel(1024);

        // 启动后台写入任务
        let bg_histories = Arc::clone(&histories);
        let bg_config = config.clone();
        tokio::spawn(Self::writer_task(bg_config, bg_histories, rx));

        Ok(Self { histories, tx })
    }

    /// 崩溃恢复
    async fn recover(config: &SmartStateConfig) -> Result<DashMap<String, NodeHistory>, String> {
        let histories: DashMap<String, NodeHistory> = DashMap::new();

        // 1. 加载主数据文件 (clash_prism_smart::NodeHistory 格式)
        let main_file_timestamp = if config.data_path.exists() {
            let data = tokio::fs::read_to_string(&config.data_path)
                .await
                .map_err(|e| format!("Failed to read data file: {e}"))?;

            let loaded: BTreeMap<String, NodeHistory> =
                serde_json::from_str(&data).unwrap_or_else(|e| {
                    emit_warn!(
                        Smart,
                        SMART_SELECT_FAILED,
                        "[smart_state] Failed to parse smart_history.json: {e}, starting fresh"
                    );
                    BTreeMap::new()
                });

            // 找出主文件中最新记录的时间戳，用于 WAL 去重
            // 优化：只检查每个节点的最后一条记录（记录按时间顺序追加）
            let max_ts = loaded
                .values()
                .filter_map(|h| h.latency_records.back())
                .map(|r| r.timestamp.timestamp_millis())
                .max();

            for (k, v) in loaded {
                histories.insert(k, v);
            }
            max_ts
        } else {
            None
        };

        // 2. 重放 WAL (使用 BufReader 逐行读取，避免大文件内存问题)
        // 只重放比主文件更新的记录，避免重复
        if config.wal_path.exists() {
            use tokio::io::AsyncBufReadExt as _;

            let file = tokio::fs::File::open(&config.wal_path)
                .await
                .map_err(|e| format!("Failed to open WAL: {e}"))?;
            let reader = tokio::io::BufReader::new(file);
            let mut lines = reader.lines();

            loop {
                match lines.next_line().await {
                    Ok(Some(l)) if !l.is_empty() => {
                        if let Ok(record) = serde_json::from_str::<ChangeRecord>(&l) {
                            // 去重：只应用比主文件更新的记录
                            if let Some(cutoff_ts) = main_file_timestamp {
                                if let ChangeRecord::Update { timestamp, .. } = &record {
                                    if *timestamp <= cutoff_ts {
                                        continue; // 跳过已存在的记录
                                    }
                                }
                            }
                            Self::apply_record(&histories, &record);
                        }
                    }
                    Ok(Some(_)) => {}
                    Ok(None) => break,
                    Err(e) => {
                        emit_error!(
                            Smart,
                            SMART_SELECT_FAILED,
                            "WAL read error: {e}, stopping replay"
                        );
                        break;
                    }
                }
            }

            // 重放完成后立即刷新主文件（只有成功才删除 WAL）
            if Self::flush_main(&histories, &config.data_path)
                .await
                .is_ok()
            {
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
            ChangeRecord::Clear => {
                // Clear 不会出现在 WAL 中，这里忽略
            }
        }
    }

    /// 后台写入任务 (无定时器，纯事件驱动)
    async fn writer_task(
        config: SmartStateConfig,
        histories: Arc<DashMap<String, NodeHistory>>,
        mut rx: mpsc::Receiver<ChangeRecord>,
    ) {
        let mut pending_count = 0usize;

        // 保持 WAL 文件句柄打开，避免重复打开文件
        let mut wal_file = match Self::open_wal_file(&config.wal_path).await {
            Ok(f) => Some(f),
            Err(e) => {
                emit_warn!(
                    Smart,
                    SMART_SELECT_FAILED,
                    "Failed to open WAL file: {e}, crash recovery disabled"
                );
                None
            }
        };

        while let Some(record) = rx.recv().await {
            match record {
                ChangeRecord::Update { .. } => {
                    // 1. 立即追加到 WAL (崩溃安全)
                    if let Some(ref mut file) = wal_file {
                        if let Err(e) = Self::append_wal_to_file(file, &record).await {
                            emit_warn!(Smart, SMART_SELECT_FAILED, "WAL append failed: {e}");
                        }
                    }

                    pending_count += 1;

                    // 2. 阈值触发刷新
                    if pending_count >= config.flush_threshold {
                        if Self::flush_main(&histories, &config.data_path)
                            .await
                            .is_ok()
                        {
                            // 只有 flush 成功才删除 WAL
                            // Windows 需要先关闭文件句柄才能删除
                            drop(wal_file);
                            if let Err(e) = tokio::fs::remove_file(&config.wal_path).await {
                                emit_warn!(Smart, SMART_SELECT_FAILED, "WAL remove failed: {e}");
                            }
                            // 重新打开 WAL 文件
                            wal_file = Self::open_wal_file(&config.wal_path).await.ok();
                        } else {
                            emit_warn!(
                                Smart,
                                SMART_SELECT_FAILED,
                                "Flush failed, keeping WAL for recovery"
                            );
                        }
                        pending_count = 0;
                    }
                }
                ChangeRecord::Clear => {
                    // 清空内存和磁盘文件（在后台任务中执行，避免竞态）
                    histories.clear();
                    // Windows 需要先关闭文件句柄才能删除
                    drop(wal_file);
                    let _ = tokio::fs::remove_file(&config.wal_path).await;
                    let _ = tokio::fs::remove_file(&config.data_path).await;
                    // 重新打开 WAL 文件
                    wal_file = Self::open_wal_file(&config.wal_path).await.ok();
                    pending_count = 0;
                }
            }
        }

        // 通道关闭时刷出剩余数据
        if pending_count > 0
            && Self::flush_main(&histories, &config.data_path)
                .await
                .is_ok()
        {
            // Windows 需要先关闭文件句柄才能删除
            drop(wal_file);
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
    ///
    /// 注意：不调用 `sync_data()`，依赖 OS 缓冲区和定期 flush 保证持久化
    /// 如需强制同步，可在 `flush_main` 后统一 sync
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
        // 移除每记录的 fsync，避免性能瓶颈
        // file.sync_data().await.map_err(|e| e.to_string())?;

        Ok(())
    }

    /// 刷新主数据文件
    async fn flush_main(
        histories: &DashMap<String, NodeHistory>,
        data_path: &Path,
    ) -> Result<(), String> {
        // 使用 BTreeMap 保证序列化顺序确定性，避免 iter_over_hash_type lint
        let snapshot: BTreeMap<String, NodeHistory> = histories
            .iter()
            .map(|e| (e.key().clone(), e.value().clone()))
            .collect();

        // 使用紧凑格式 (生产环境)
        let json = serde_json::to_string(&snapshot).map_err(|e| e.to_string())?;

        // 原子写入：创建文件 → 写入 → sync → rename
        let temp_path = data_path.with_extension("tmp");
        let mut file = tokio::fs::File::create(&temp_path)
            .await
            .map_err(|e| e.to_string())?;
        use tokio::io::AsyncWriteExt as _;
        file.write_all(json.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        file.sync_all().await.map_err(|e| e.to_string())?;
        drop(file);
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

        // try_send: 满了就丢弃，打印警告
        if let Err(e) = self.tx.try_send(record) {
            emit_error!(
                Smart,
                SMART_SELECT_FAILED,
                "Failed to queue record for persistence: {e}"
            );
        }

        Ok(())
    }

    /// 获取节点历史 (返回 `clash_prism_smart::NodeHistory`)
    #[must_use]
    pub fn get_history(&self, node_name: &str) -> Option<NodeHistory> {
        self.histories.get(node_name).map(|e| e.clone())
    }

    /// 获取所有历史 (返回兼容的 `BTreeMap`)
    #[must_use]
    pub fn get_all_histories(&self) -> BTreeMap<String, NodeHistory> {
        self.histories
            .iter()
            .map(|e| (e.key().clone(), e.value().clone()))
            .collect()
    }

    /// 获取所有历史 (返回 `Vec`，避免 clone key)
    #[must_use]
    pub fn get_histories_vec(&self) -> Vec<NodeHistory> {
        self.histories.iter().map(|e| e.value().clone()).collect()
    }

    /// 清空所有历史数据（同步清空内存，异步删除磁盘文件）
    pub fn clear(&self) {
        // 立即清空内存
        self.histories.clear();
        // 发送 Clear 信号到后台任务删除磁盘文件
        if let Err(e) = self.tx.try_send(ChangeRecord::Clear) {
            emit_error!(
                Smart,
                SMART_SELECT_FAILED,
                "Failed to send clear signal: {e}"
            );
        }
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

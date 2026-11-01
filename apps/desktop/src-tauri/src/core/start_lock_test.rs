//! Tests for the core start lock: a start that waits too long gives up
//! instead of taking the lock from the start still holding it.

use super::{acquire_start_lock, wait_for_start_lock, StartLockWait};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;

const TIMEOUT: Duration = Duration::from_secs(10);

#[tokio::test(start_paused = true)]
async fn waiting_start_runs_once_the_earlier_start_finishes() {
    let lock = Arc::new(Mutex::new(()));
    let first = acquire_start_lock(&lock, TIMEOUT).await;
    assert!(first.is_some());

    let shared = Arc::clone(&lock);
    let waiter = tokio::spawn(async move { acquire_start_lock(&shared, TIMEOUT).await.is_some() });
    tokio::time::sleep(Duration::from_secs(3)).await;
    drop(first);
    assert!(waiter.await.is_ok_and(|acquired| acquired));
}

#[tokio::test(start_paused = true)]
async fn slow_start_keeps_the_lock_past_the_timeout() {
    let lock = Arc::new(Mutex::new(()));
    let slow = acquire_start_lock(&lock, TIMEOUT).await;
    assert!(slow.is_some());

    // A concurrent start gives up after the timeout instead of stealing.
    assert!(acquire_start_lock(&lock, TIMEOUT).await.is_none());
    assert!(
        lock.try_lock().is_err(),
        "slow start must still hold the lock"
    );

    // The slow start ends: a new start gets the lock, and nothing the slow
    // start does on its way out can release the new start's hold.
    drop(slow);
    let third = acquire_start_lock(&lock, TIMEOUT).await;
    assert!(third.is_some());
    assert!(lock.try_lock().is_err(), "new start holds the lock");
    drop(third);
    assert!(lock.try_lock().is_ok());
}

#[tokio::test(start_paused = true)]
async fn concurrent_starts_never_overlap() {
    let lock = Arc::new(Mutex::new(()));
    let running = Arc::new(std::sync::atomic::AtomicU32::new(0));
    let mut tasks = Vec::new();
    for _ in 0..4 {
        let task_lock = Arc::clone(&lock);
        let task_running = Arc::clone(&running);
        tasks.push(tokio::spawn(async move {
            let Some(_guard) = acquire_start_lock(&task_lock, TIMEOUT).await else {
                return false;
            };
            let now = task_running.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
            assert_eq!(now, 1, "two starts ran at once");
            // Each start takes 4 s: two finish within the 10 s wait of the
            // others, the rest give up.
            tokio::time::sleep(Duration::from_secs(4)).await;
            task_running.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
            true
        }));
    }
    let mut ran = 0;
    for task in tasks {
        if task.await.is_ok_and(|ran_start| ran_start) {
            ran += 1;
        }
    }
    assert_eq!(ran, 3);
}

#[tokio::test(start_paused = true)]
async fn background_restart_waits_out_a_slow_start() {
    let lock = Arc::new(Mutex::new(()));
    let slow = acquire_start_lock(&lock, TIMEOUT).await;
    assert!(slow.is_some());

    let shared = Arc::clone(&lock);
    let restart = tokio::spawn(async move {
        wait_for_start_lock(&shared, StartLockWait::UntilFree)
            .await
            .is_some()
    });
    tokio::time::sleep(TIMEOUT * 3).await;
    assert!(
        !restart.is_finished(),
        "background restart must keep waiting"
    );

    // A start the user asked for still gives up meanwhile.
    assert!(wait_for_start_lock(&lock, StartLockWait::Bounded)
        .await
        .is_none());

    drop(slow);
    assert!(restart.await.is_ok_and(|acquired| acquired));
}

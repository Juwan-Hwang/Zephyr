// ===========================================================================
// network_optim_tests.rs — Golden (snapshot) tests for Linux TCP optimization
// ===========================================================================
//
// Tests `generate_linux_optim_script` which produces a 40+ line bash script
// for Linux TCP performance tuning via sysctl. The script is executed with
// root privileges (pkexec) and writes to /etc/sysctl.d/, making correctness
// critical.
//
// Three optimization levels are tested:
//   - Conservative: minimal buffer increases, TFO=1
//   - Balanced (default): moderate buffers, TFO=3
//   - Aggressive: large buffers, TFO=3
//
// This file is included from core/network_optim.rs via:
//   #[cfg(test)]
//   #[path = "network_optim_tests.rs"]
//   mod network_optim_tests;

#[allow(
    clippy::expect_used,
    clippy::unwrap_used,
    clippy::indexing_slicing,
    clippy::panic
)]
mod tests {
    use super::super::{generate_linux_optim_script, LinuxTcpOptimConfig, OptimLevel};

    #[test]
    fn conservative_script() {
        let cfg = LinuxTcpOptimConfig::from_level(OptimLevel::Conservative);
        insta::assert_snapshot!(generate_linux_optim_script(&cfg));
    }

    #[test]
    fn balanced_script() {
        let cfg = LinuxTcpOptimConfig::from_level(OptimLevel::Balanced);
        insta::assert_snapshot!(generate_linux_optim_script(&cfg));
    }

    #[test]
    fn aggressive_script() {
        let cfg = LinuxTcpOptimConfig::from_level(OptimLevel::Aggressive);
        insta::assert_snapshot!(generate_linux_optim_script(&cfg));
    }
}

# Bolt's Journal

## 2026-04-16 - Precomputed Divisors & Threshold Branching for Format Utilities
**Learning:** High-frequency formatting functions like `formatBytes` and `formatFileSize` are called on every poll cycle across real-time traffic charts, connections, and status views. Replacing `Math.log` and `Math.pow` calculations with precomputed divisor lookup tables and fast threshold comparisons improves formatting speed by ~25-30%.
**Action:** When working on formatting or calculation utilities invoked in real-time loops/polls, prefer precomputed constant arrays and threshold comparisons over transcendental math functions.

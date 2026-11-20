# Bolt's Journal

## 2025-05-18 - Canvas 2D Chart Pre-allocated Point Buffers

**Learning:** High-frequency Canvas 2D rendering routines driven by `requestAnimationFrame` or continuous updates (like real-time traffic charts) can generate significant garbage collection (GC) overhead when using Array methods like `.filter()`, `.map()`, or object literals (`{ x, y }`) on every frame. Pre-allocating a reusable point buffer and performing single-pass data validation drops per-frame GC allocations to zero.
**Action:** When working on real-time canvas visualizations or high-frequency render loops, mutate pre-allocated point buffers in-place instead of constructing new arrays or object literals per frame.

## 2026-04-16 - Precomputed Divisors & Threshold Branching for Format Utilities
**Learning:** High-frequency formatting functions like `formatBytes` and `formatFileSize` are called on every poll cycle across real-time traffic charts, connections, and status views. Replacing `Math.log` and `Math.pow` calculations with precomputed divisor lookup tables and fast threshold comparisons improves formatting speed by ~25-30%.
**Action:** When working on formatting or calculation utilities invoked in real-time loops/polls, prefer precomputed constant arrays and threshold comparisons over transcendental math functions.

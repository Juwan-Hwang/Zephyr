# Bolt's Journal

## 2025-05-18 - Canvas 2D Chart Pre-allocated Point Buffers

**Learning:** High-frequency Canvas 2D rendering routines driven by `requestAnimationFrame` or continuous updates (like real-time traffic charts) can generate significant garbage collection (GC) overhead when using Array methods like `.filter()`, `.map()`, or object literals (`{ x, y }`) on every frame. Pre-allocating a reusable point buffer and performing single-pass data validation drops per-frame GC allocations to zero.
**Action:** When working on real-time canvas visualizations or high-frequency render loops, mutate pre-allocated point buffers in-place instead of constructing new arrays or object literals per frame.

## 2026-04-16 - Precomputed Divisors & Threshold Branching for Format Utilities
**Learning:** High-frequency formatting functions like `formatBytes` and `formatFileSize` are called on every poll cycle across real-time traffic charts, connections, and status views. Replacing `Math.log` and `Math.pow` calculations with precomputed divisor lookup tables and fast threshold comparisons improves formatting speed by ~25-30%.
**Action:** When working on formatting or calculation utilities invoked in real-time loops/polls, prefer precomputed constant arrays and threshold comparisons over transcendental math functions.

## 2026-04-16 - Fast-Path Regex Pre-test for HTML Escaping & Log Parsing
**Learning:** High-frequency DOM text escaping utilities like `escapeHtml()` and log parsers like `parseCoreLogLine()` are invoked thousands of times during real-time table reconciliation and virtual scroll rendering. Adding a non-global regex test (`/[&<>"']/`) before `String.prototype.replace()` skips regex replacement engine overhead and unnecessary string allocations for >90% of clean strings. Reusing a module-level `Set` instead of inline array creation (`['debug', 'info', '...'].includes()`) avoids per-log-line GC allocations.
**Action:** In hot text escaping and string parsing routines, pre-test strings with a fast non-global regex before calling `.replace()`, and use module-scoped Sets for lookup validations.

## 2026-04-16 - Bounded Memoization for Log Level Parsing & Query Lowercasing
**Learning:** Real-time stream views (like log viewers) repeatedly execute regex matching (`LEVEL_RE.exec`) and string transformations (`_searchQuery.toLowerCase()`) over thousands of items on every poll tick, virtual scroll mount, or filter change. Bounding memoization of parsed string attributes (e.g. log level) in a Map cache drops string processing time by ~78% (from 336ms to 72ms per 1,000 iterations over 2,000 lines), while pre-lowercasing search queries outside loop iterations avoids redundant string allocations.
**Action:** When filtering or rendering real-time string buffers (e.g., logs or connections), memoize regex attribute parsing in a size-bounded Map and hoist search query transformations outside item iteration loops.

## 2026-04-16 - Zero-Allocation Borrowed String Keys in Traversal & Resolution Memoization
**Learning:** In proxy candidate resolution routines (`select_global_candidate`), traversing multi-branch policy group trees generates heavy heap string allocations when using `HashSet<String>` or `HashMap<String, bool>` for visited tracking and memoization, alongside $O(N)$ linear scans for member validation (`global_all.contains(&s)`). Converting graph traversal lookup structures to borrowed string slices (`&'a str`) from the input map keys and pre-building an $O(1)$ candidate `HashSet<&str>` drops candidate selection latency by ~80% (from ~2.57ms to ~0.52ms for 1000 nodes).
**Action:** When recursing or memoizing over parsed JSON/YAML value maps in Rust, borrow slice references (`&'a str`) directly from the map keys to achieve zero-allocation traversal.

## 2026-04-17 - Fast-Path Top-Level Line Scanning for Scalar YAML Extractions
**Learning:** Parsing full YAML documents with `serde_yaml` to extract simple top-level scalar values (e.g. `mode`, `secret`, `tun.enable`) allocates large ASTs, taking ~17.5ms for 1000-node subscription files. Using an unindented line scanner with strict YAML spec checks (colon followed by space/tab/comment, indentation tracking for mappings, quote/comment handling) drops extraction latency by ~96-99% (down to ~32µs - 590µs for 1000 nodes) while safely falling back to `serde_yaml` for complex YAML syntax (anchors, directives, multiline block scalars).
**Action:** For scalar config attributes repeatedly queried from whole YAML payloads, use an indentation-aware fast-path line scanner that falls back to full parsing for complex YAML.

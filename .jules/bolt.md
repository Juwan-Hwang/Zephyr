## 2025-05-18 - Canvas 2D Chart Pre-allocated Point Buffers

**Learning:** High-frequency Canvas 2D rendering routines driven by `requestAnimationFrame` or continuous updates (like real-time traffic charts) can generate significant garbage collection (GC) overhead when using Array methods like `.filter()`, `.map()`, or object literals (`{ x, y }`) on every frame. Pre-allocating a reusable point buffer and performing single-pass data validation drops per-frame GC allocations to zero.
**Action:** When working on real-time canvas visualizations or high-frequency render loops, mutate pre-allocated point buffers in-place instead of constructing new arrays or object literals per frame.

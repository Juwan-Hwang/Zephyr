## 2026-04-16 - Array Length Truncation in Buffer Reuse

**Learning:** Mutating `array.length = count` on a pre-allocated object buffer truncates array elements beyond `count - 1` in V8, destroying pre-allocated object references and converting those slots into `undefined` holes when length is restored.
**Action:** When reusing static object buffers, pass `buffer.slice(0, count)` (or pass explicit `count` bounds) instead of mutating `buffer.length`, or ensure elements are lazily re-initialized if truncated.

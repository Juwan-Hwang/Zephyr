## 2025-05-18 - Proxy Mode Selector ARIA Pressed State
**Learning:** Segmented mode controls without `aria-pressed` or `role="group"` leave assistive technology users unaware of which proxy mode is currently active.
**Action:** Always ensure segmented button controls carry `role="group"`, an explicit `aria-label`, and update `aria-pressed` dynamically whenever active selection changes.

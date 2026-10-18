## 2025-02-18 - Keyed List Reconciliation Signatures

**Learning:** `reconcileKeyedList()` in polling loops uses `getSignature(item)` on every items list update to detect whether a row structure changed. Generating a full DOM HTML string via HTML escaping and template literals as the signature creates unnecessary string allocation and escaping overhead on every poll cycle (e.g. every 2s for active connections).
**Action:** Always construct lightweight, raw delimiter-separated strings (e.g. `${mode}\0${rule}\0...`) for reconciliation signatures rather than invoking template generator functions like `buildConnectionRow()`.

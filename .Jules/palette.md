## 2025-02-25 - Icon-Only Modal Close and Back Buttons Accessibility
**Learning:** Icon-only buttons rendered dynamically in JS modals (e.g. shortcut settings, log settings, edit subscription) or html overlays (e.g. plugin panel, fullscreen editor, advanced back button) must explicitly carry `aria-label` and `data-i18n-aria-label="dismiss"` or `data-i18n-aria-label="overrideBack"` to ensure screen readers announce their function when focused.
**Action:** When adding or modifying icon-only modal/overlay controls, always include default `aria-label` and `data-i18n-aria-label` attributes.

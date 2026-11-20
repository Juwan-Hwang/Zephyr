# Palette's Journal

## 2025-05-18 - Accessibility Associations for `.ios-switch` Custom Inputs
**Learning:** Custom iOS-style toggle switches (`.ios-switch input[type="checkbox"]`) in this app's design system often sit beside title headings and status paragraphs in separate DOM containers. Without explicit `aria-labelledby` and `aria-describedby` referencing those sibling element IDs, screen readers fail to announce the toggle's function and active state summary.
**Action:** When creating or updating custom `.ios-switch` controls, ensure the checkbox input explicitly links `aria-labelledby` to the control title element and `aria-describedby` to its live status description.

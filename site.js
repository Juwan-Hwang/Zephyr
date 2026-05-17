/**
 * Zephyr — Demo Website Interactions
 * 导航滚动、平滑锚点、导航高亮、揭示动画、计数器、主题切换、
 * 视差、进度条、卡片光晕、下划线动画、启动动画遮罩。
 */

(function () {
  'use strict';

  // ═══════════════════════════════════════
  // i18n Internationalization System
  // ═══════════════════════════════════════/*
 * Zephyr — Demo Website Styles
 * 基于 AETHER 设计系统 (os.css :root 变量)
 * Surpassing Claude Design System & Apple App Store
 */

/* ═══════════════════════════════════════
   0. Base Overrides
═══════════════════════════════════════ */
html {
  scroll-behavior: smooth;
  scroll-padding-top: 56px;
}

body {
  overflow-x: hidden;
  -webkit-user-select: auto;
  user-select: auto;
  background: var(--depth-0-void);
  text-wrap: pretty;
}

/* L-06: Noise texture overlay — replaced heavy SVG feTurbulence with lightweight pre-generated PNG */
body::before {
  content: '';
  position: fixed;
  inset: 0;
  z-index: -1;
  opacity: 0.03;
  pointer-events: none;
  /* Tiny 100x100 noise PNG (~300 bytes) vs ~800 byte SVG feTurbulence — avoids per-pixel filter computation */
  background-image: url("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAN0lEQVQYV2P4z8BQz4AEGBhY/jMwsIJYjEDGfwYGJhANEmAE0UwMDAwMIAVgFSAaZBJYEagYGBkAAANzmH8W0s9xHAAAAAElFTkSuQmCC");
  background-repeat: repeat;
  background-size: 100px 100px;
}

a {
  color: var(--accent);
  text-decoration: none;
  transition: color var(--duration-fast);
}
a:hover {
  color: var(--accent-hover);
}

::selection {
  background: var(--accent-dim);
  color: var(--text-primary);
}

/* Global focus-visible — Claude + Apple pattern */
:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--accent) 60%, transparent);
  outline-offset: 2px;
}

/* ═══════════════════════════════════════
   1. Navigation (.site-nav)
═══════════════════════════════════════ */
.site-nav {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 clamp(24px, 5vw, 64px);
  z-index: 900;
  background: transparent;
  border-bottom: 0.5px solid transparent;
  transition:
    background var(--duration-normal),
    border-color var(--duration-normal),
    backdrop-filter var(--duration-normal);
}

.site-nav.scrolled {
  background: rgba(15, 14, 13, 0.72);
  backdrop-filter: blur(40px) saturate(1.5);
  -webkit-backdrop-filter: blur(40px) saturate(1.5);
  border-bottom-color: var(--border-subtle);
}

[data-theme="light"] .site-nav.scrolled {
  background: rgba(232, 229, 222, 0.72);
}

.nav-left {
  display: flex;
  align-items: center;
  gap: 40px;
}

.nav-logo {
  font-family: var(--font-ui);
  font-size: 18px;
  font-weight: 600;
  color: var(--accent);
  letter-spacing: -0.01em;
}

.nav-links {
  display: flex;
  align-items: center;
  gap: 32px;
}

.nav-links a {
  font-size: 13px;
  color: var(--text-secondary);
  transition:
    color var(--duration-fast),
    background var(--duration-fast);
  position: relative;
  padding: 4px 8px;
  margin: -4px -8px;
  border-radius: var(--radius-sm);
}

.nav-links a:hover,
.nav-links a.active {
  color: var(--text-primary);
  background: var(--accent-subtle);
}

.nav-links a::after {
  content: '';
  position: absolute;
  bottom: -2px;
  left: 8px;
  right: 8px;
  height: 1.5px;
  background: var(--accent);
  border-radius: var(--radius-full);
  transform: scaleX(0);
  transition: transform var(--duration-fast) var(--spring-standard);
}

.nav-links a.active::after,
.nav-links a:hover::after {
  transform: scaleX(1);
}

.nav-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.nav-github {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-inverse);
  background: var(--accent);
  border-radius: var(--radius-md);
  transition:
    background var(--duration-fast),
    transform var(--duration-fast),
    box-shadow var(--duration-fast);
}

.nav-github:hover {
  background: var(--accent-hover);
  color: var(--text-inverse);
  transform: translateY(-1px);
  box-shadow: 0 4px 16px var(--accent-glow);
}

.nav-github svg {
  width: 14px;
  height: 14px;
}

.theme-toggle {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-md);
  color: var(--text-tertiary);
  transition:
    color var(--duration-fast),
    background var(--duration-fast);
}

.theme-toggle:hover {
  color: var(--text-secondary);
  background: var(--accent-dim);
}

.theme-toggle svg {
  width: 16px;
  height: 16px;
}

/* ── Language Toggle Button ── */
.nav-lang-toggle {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  border-radius: var(--radius-md);
  color: var(--text-tertiary);
  cursor: pointer;
  transition:
    color var(--duration-fast),
    background var(--duration-fast);
}

.nav-lang-toggle:hover {
  color: var(--text-secondary);
  background: var(--accent-dim);
}

.nav-lang-toggle svg {
  width: 16px;
  height: 16px;
}

@media (max-width: 1024px) {
  .nav-lang-toggle {
    width: 44px;
    height: 44px;
  }

  .nav-lang-toggle svg {
    width: 20px;
    height: 20px;
  }
}

/* ═══════════════════════════════════════
   2. Hero (.hero)
═══════════════════════════════════════ */
.hero {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: clamp(80px, 12vw, 160px) clamp(24px, 5vw, 64px) 80px;
  position: relative;
  overflow: hidden;
}

/* Gradient mesh background — Claude pattern (enhanced) */
.hero::before {
  content: '';
  position: absolute;
  inset: 0;
  background:
    radial-gradient(ellipse 60% 50% at 25% 15%, rgba(124, 139, 160, 0.07) 0%, transparent 60%),
    radial-gradient(ellipse 40% 35% at 75% 25%, rgba(124, 139, 160, 0.05) 0%, transparent 55%),
    radial-gradient(ellipse 50% 40% at 60% 75%, rgba(124, 139, 160, 0.04) 0%, transparent 55%),
    radial-gradient(ellipse 35% 30% at 15% 65%, rgba(124, 139, 160, 0.03) 0%, transparent 50%);
  pointer-events: none;
}

.hero-content {
  position: relative;
  z-index: 1;
  will-change: transform;
}

.hero-title {
  font-family: var(--font-display);
  font-size: clamp(44px, 5.5vw, 72px);
  font-weight: 300;
  letter-spacing: -0.025em;
  line-height: 1.0;
  color: var(--text-primary);
  max-width: 720px;
  margin: 0 auto;
  text-wrap: balance;
}

.hero-subtitle {
  font-size: clamp(16px, 2.5vw, 22px);
  color: var(--text-secondary);
  margin-top: 20px;
  font-weight: 400;
  text-wrap: balance;
}

.hero-philosophy {
  font-family: var(--font-data, 'SF Mono', 'Cascadia Code', 'Fira Code', monospace);
  font-size: 14px;
  color: var(--text-tertiary);
  margin-top: 16px;
  letter-spacing: 0.05em;
}

.hero-cta {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 40px;
  justify-content: center;
}

.btn-primary {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 24px;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-inverse);
  background: var(--accent);
  border-radius: var(--radius-md);
  transition:
    background var(--duration-fast),
    transform var(--duration-fast),
    box-shadow var(--duration-fast);
}

.btn-primary:hover {
  background: var(--accent-hover);
  color: var(--text-inverse);
  transform: translateY(-1px);
  box-shadow: 0 4px 16px var(--accent-glow);
}

.btn-secondary {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 24px;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-secondary);
  background: transparent;
  border: 0.5px solid var(--border-default);
  border-radius: var(--radius-md);
  transition:
    color var(--duration-fast),
    border-color var(--duration-fast),
    transform var(--duration-fast);
}

.btn-secondary:hover {
  color: var(--text-primary);
  border-color: var(--border-medium);
  transform: translateY(-1px);
}

.btn-primary svg,
.btn-secondary svg {
  width: 16px;
  height: 16px;
}

/* ── Hero Showcase (CSS-only abstract UI) ── */
.hero-showcase {
  position: relative;
  z-index: 1;
  margin-top: 72px;
  max-width: 900px;
  width: 100%;
  aspect-ratio: 16 / 10;
  background: var(--depth-2-deep);
  border: 0.5px solid var(--border-default);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-depth-5);
  overflow: hidden;
}

.hero-showcase::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(
    135deg,
    rgba(124, 139, 160, 0.03) 0%,
    transparent 40%,
    transparent 60%,
    rgba(124, 139, 160, 0.02) 100%
  );
  pointer-events: none;
  z-index: 2;
}

.hero-showcase-inner {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
}

/* Top bar with traffic-light dots */
.hero-showcase-bar {
  height: 28px;
  min-height: 28px;
  background: var(--depth-2-deep);
  border-bottom: 0.5px solid var(--border-subtle);
  display: flex;
  align-items: center;
  padding: 0 12px;
  gap: 6px;
}

.hero-showcase-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.hero-showcase-dot:nth-child(1) { background: #FF5F57; }
.hero-showcase-dot:nth-child(2) { background: #FEBC2E; }
.hero-showcase-dot:nth-child(3) { background: #28C840; }

/* Content area: sidebar + main */
.hero-showcase-body {
  flex: 1;
  display: flex;
  overflow: hidden;
}

/* Left sidebar */
.hero-showcase-sidebar {
  width: 200px;
  min-width: 200px;
  background: var(--depth-2-deep);
  border-right: 0.5px solid var(--border-subtle);
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
}

.hero-showcase-menu-item {
  height: 12px;
  border-radius: var(--radius-xs);
  background: var(--depth-4-raised);
}

.hero-showcase-menu-item:nth-child(1) { width: 70%; }
.hero-showcase-menu-item:nth-child(2) { width: 55%; }
.hero-showcase-menu-item:nth-child(3) { width: 80%; }
.hero-showcase-menu-item:nth-child(4) { width: 45%; }

/* Right main area with abstract chart */
.hero-showcase-main {
  flex: 1;
  background: var(--depth-3-surface);
  position: relative;
  overflow: hidden;
}

.hero-showcase-main canvas {
  display: block;
  width: 100%;
  height: 100%;
}

/* ═══════════════════════════════════════
   3. Philosophy (.philosophy)
═══════════════════════════════════════ */
.philosophy {
  padding: clamp(64px, 8vw, 128px) 0;
}

.philosophy-inner {
  max-width: 1200px;
  margin: 0 auto;
  padding-inline: clamp(24px, 5vw, 64px);
}

.philosophy-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 64px;
  align-items: center;
}

.philosophy-quote {
  font-size: clamp(20px, 3vw, 28px);
  font-weight: 300;
  color: var(--text-primary);
  line-height: 1.6;
  border-left: 2px solid var(--accent);
  padding-left: 24px;
  max-width: 680px;
  text-wrap: balance;
}

.philosophy-author {
  font-size: 14px;
  color: var(--text-tertiary);
  margin-top: 16px;
}

.philosophy-cards {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.philosophy-card {
  background: var(--depth-3-surface);
  border: 0.5px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  padding: 24px;
  transition:
    transform 250ms var(--spring-standard),
    border-color 250ms;
}

.philosophy-card:hover {
  transform: translateY(-1px);
  border-color: var(--border-default);
}

.philosophy-card h4 {
  font-size: 14px;
  font-weight: 600;
  color: var(--accent);
  margin-bottom: 8px;
}

.philosophy-card p {
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.7;
  text-wrap: pretty;
}

.philosophy-body {
  margin-top: 32px;
  font-size: 14px;
  color: var(--text-secondary);
  line-height: 1.8;
  max-width: 420px;
  text-wrap: pretty;
}

/* ═══════════════════════════════════════
   12. Section Common
═══════════════════════════════════════ */
.section {
  padding: clamp(64px, 8vw, 128px) 0;
  position: relative;
}

.section-inner {
  max-width: 1200px;
  margin: 0 auto;
  padding-inline: clamp(24px, 5vw, 64px);
}

.section-header {
  text-align: center;
  margin-bottom: 56px;
}

/* Section label — Claude pattern */
.section-label {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--accent);
  margin-bottom: 12px;
}

.section-title {
  font-family: var(--font-display);
  font-size: clamp(24px, 4vw, 32px);
  font-weight: 600;
  color: var(--text-primary);
  letter-spacing: -0.01em;
  text-wrap: balance;
}

.section-desc {
  font-size: 15px;
  color: var(--text-secondary);
  max-width: 680px;
  margin: 12px auto 0;
  line-height: 1.6;
  text-wrap: pretty;
}

/* Subtle gradient mesh for alternating sections — Claude pattern */
#features::before,
#security::before {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  background:
    radial-gradient(ellipse 50% 40% at 80% 20%, rgba(124, 139, 160, 0.03) 0%, transparent 60%),
    radial-gradient(ellipse 45% 35% at 20% 80%, rgba(124, 139, 160, 0.025) 0%, transparent 55%);
}

[data-theme="light"] #features::before,
[data-theme="light"] #security::before {
  background:
    radial-gradient(ellipse 50% 40% at 80% 20%, rgba(90, 106, 128, 0.025) 0%, transparent 60%),
    radial-gradient(ellipse 45% 35% at 20% 80%, rgba(90, 106, 128, 0.02) 0%, transparent 55%);
}

/* ═══════════════════════════════════════
   4. Features — Bento Grid (.features)
═══════════════════════════════════════ */
.features-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  grid-template-rows: auto auto;
  gap: 20px;
}

.feature-card.large {
  grid-column: span 2;
  grid-row: span 2;
}

.feature-card.wide {
  grid-column: span 2;
}

.feature-card {
  background: var(--depth-3-surface);
  border: 0.5px solid var(--border-subtle);
  border-radius: var(--radius-xl);
  padding: 24px;
  position: relative;
  overflow: hidden;
  transition:
    transform 250ms var(--spring-standard),
    box-shadow 250ms var(--spring-standard),
    border-color 250ms;
  box-shadow: var(--shadow-depth-2);
}

/* Subtle gradient overlay on hover — Apple-inspired */
.feature-card::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  opacity: 0;
  background: linear-gradient(
    135deg,
    rgba(124, 139, 160, 0.04) 0%,
    transparent 50%
  );
  transition: opacity 210ms;
  pointer-events: none;
}

.feature-card:hover {
  transform: translateY(-3px);
  box-shadow: var(--shadow-depth-4);
  border-color: var(--border-default);
}

.feature-card:hover::after {
  opacity: 1;
}

.feature-icon {
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--accent-dim);
  border-radius: var(--radius-lg);
  color: var(--accent);
}

.feature-icon svg {
  width: 20px;
  height: 20px;
}

.feature-card h3 {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  margin-top: 20px;
}

.feature-card p {
  font-size: 13px;
  color: var(--text-secondary);
  margin-top: 8px;
  line-height: 1.6;
  text-wrap: pretty;
}

/* Large card extra padding */
.feature-card.large {
  padding: 32px;
}

/* Chart preview inside the large feature card */
.chart-preview {
  height: 120px;
  background: var(--depth-1-abyss);
  border-radius: var(--radius-md);
  margin-top: 16px;
  overflow: hidden;
  position: relative;
  border: 0.5px solid var(--border-subtle);
}

.chart-preview canvas {
  display: block;
  width: 100%;
  height: 100%;
}

[data-theme="light"] .chart-preview {
  background: var(--depth-1-abyss);
  border-color: var(--border-subtle);
}

/* ═══════════════════════════════════════
   5. Architecture (.architecture)
═══════════════════════════════════════ */
.arch-stack {
  max-width: 680px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
}

.arch-layer {
  background: var(--depth-3-surface);
  border: 0.5px solid var(--border-subtle);
  border-left: 2px solid var(--accent);
  padding: 20px 24px;
  position: relative;
}

.arch-layer:first-child {
  border-radius: var(--radius-lg) var(--radius-lg) 0 0;
}

.arch-layer:last-child {
  border-radius: 0 0 var(--radius-lg) var(--radius-lg);
}

.arch-layer + .arch-layer {
  border-radius: 0;
  margin-top: -1px;
}

.arch-layer-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--accent);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.arch-layer-desc {
  font-size: 13px;
  color: var(--text-secondary);
  margin-top: 4px;
  line-height: 1.6;
}

.arch-arrow {
  text-align: center;
  padding: 4px 0;
  color: var(--text-ghost);
}

.arch-arrow svg {
  width: 16px;
  height: 16px;
}

.arch-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: center;
  margin-top: 32px;
}

.arch-tag {
  display: inline-flex;
  align-items: center;
  padding: 4px 14px;
  background: var(--depth-4-raised);
  border-radius: var(--radius-full);
  font-size: 12px;
  color: var(--text-secondary);
  border: 0.5px solid var(--border-subtle);
}

/* ═══════════════════════════════════════
   6. Security (.security)
═══════════════════════════════════════ */
.security-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 20px;
}

.security-card {
  background: var(--depth-3-surface);
  border: 0.5px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  padding: 24px;
  text-align: center;
  position: relative;
  overflow: hidden;
  transition:
    transform 250ms var(--spring-standard),
    border-color 250ms;
}

/* Subtle gradient overlay on hover — Apple-inspired */
.security-card::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  opacity: 0;
  background: linear-gradient(
    135deg,
    rgba(124, 139, 160, 0.04) 0%,
    transparent 50%
  );
  transition: opacity 210ms;
  pointer-events: none;
}

.security-card:hover {
  transform: translateY(-3px);
  border-color: var(--border-default);
}

.security-card:hover::after {
  opacity: 1;
}

.security-icon {
  width: 44px;
  height: 44px;
  margin: 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--accent);
}

.security-icon svg {
  width: 28px;
  height: 28px;
}

.security-card h3 {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  margin-top: 12px;
}

.security-card p {
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 8px;
  line-height: 1.5;
  text-wrap: pretty;
}

/* ═══════════════════════════════════════
   7. Performance (.performance)
   ═══════════════════════════════════════ */
/* perf-grid, perf-card, perf-unit, perf-label, perf-compare — see Launch Overlay section below */

/* ═══════════════════════════════════════
   8. Demo Section (.demo)
═══════════════════════════════════════ */
.demo-container {
  width: 100%;
  max-width: 820px;
  margin: 0 auto;
  aspect-ratio: 4 / 3;
  background: var(--depth-0-void);
  border: 0.5px solid var(--border-default);
  border-radius: var(--radius-xl);
  overflow: hidden;
  position: relative;
  box-shadow:
    0 0 0 1px var(--border-subtle),
    var(--shadow-depth-5),
    0 0 80px -20px var(--accent-glow);
}

#osContainer {
  width: 100%;
  height: 100%;
  position: relative;
}

#osContainer .os-desktop {
  width: 100%;
  height: 100%;
}

/* ── Demo Expand Button ── */
.demo-expand-btn {
  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 1000;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--depth-4-raised);
  border: 0.5px solid var(--border-default);
  color: var(--text-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all var(--duration-fast);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
}

.demo-expand-btn:hover {
  background: var(--depth-5-float);
  color: var(--text-primary);
  transform: scale(1.1);
}

.demo-container.expanded {
  position: fixed;
  inset: 0;
  width: 100vw;
  height: 100vh;
  min-height: unset;
  border-radius: 0;
  z-index: 9999;
  animation: demo-expand 400ms var(--spring-standard) both;
}

@keyframes demo-expand {
  0% { border-radius: var(--radius-xl); }
  100% { border-radius: 0; }
}

/* ═══════════════════════════════════════
   9. Footer (.site-footer)
═══════════════════════════════════════ */
.site-footer {
  padding: 64px 0 32px;
  border-top: 0.5px solid var(--border-subtle);
  text-align: left;
  min-height: 88px;
  background: var(--depth-1-abyss);
}

[data-theme="light"] .site-footer {
  background: var(--depth-2-deep);
}

.footer-inner {
  max-width: 1200px;
  margin: 0 auto;
  padding-inline: clamp(24px, 5vw, 64px);
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 40px;
}

@media (max-width: 768px) {
  .footer-inner {
    grid-template-columns: 1fr 1fr;
    gap: 32px;
  }
}

/* Default: hide mobile CTA, show desktop CTAs */
.hero-cta-mobile {
  display: none !important;
}

.hero-cta-desktop {
  display: inline-flex !important;
}

@media (max-width: 480px) {
  .footer-inner {
    grid-template-columns: 1fr;
    gap: 24px;
  }

  /* Hide demo section on mobile */
  #demo {
    display: none;
  }

  /* Show mobile-only CTA in hero */
  .hero-cta-mobile {
    display: inline-flex;
  }

  .hero-cta-desktop {
    display: none;
  }

  /* Hide demo link in mobile nav drawer */
  .nav-mobile-drawer a[href="#demo"] {
    display: none;
  }
}

/* footer-col, footer-col h4, footer-col a, footer-bottom — see Launch Overlay section below */

/* ═══════════════════════════════════════
   10. Animations & Reveal System
═══════════════════════════════════════ */
.reveal {
  opacity: 0;
  transform: translateY(24px);
  transition:
    opacity 600ms var(--spring-standard),
    transform 600ms var(--spring-standard);
}

.reveal.revealed {
  opacity: 1;
  transform: translateY(0);
}

/* Direction variants — enhanced reveal system */
.reveal-left {
  opacity: 0;
  transform: translateX(-24px);
  transition:
    opacity 600ms var(--spring-standard),
    transform 600ms var(--spring-standard);
}

.reveal-right {
  opacity: 0;
  transform: translateX(24px);
  transition:
    opacity 600ms var(--spring-standard),
    transform 600ms var(--spring-standard);
}

.reveal-scale {
  opacity: 0;
  transform: scale(0.95);
  transition:
    opacity 600ms var(--spring-standard),
    transform 600ms var(--spring-standard);
}

.reveal-left.revealed,
.reveal-right.revealed {
  opacity: 1;
  transform: translateX(0);
}

.reveal-scale.revealed {
  opacity: 1;
  transform: scale(1);
}

/* Stagger delays — Claude pattern (0/80/160/240/320/400ms) */
.reveal[data-delay="1"] { transition-delay: 80ms; }
.reveal[data-delay="2"] { transition-delay: 160ms; }
.reveal[data-delay="3"] { transition-delay: 240ms; }
.reveal[data-delay="4"] { transition-delay: 320ms; }
.reveal[data-delay="5"] { transition-delay: 400ms; }

.reveal-left[data-delay="1"],
.reveal-right[data-delay="1"],
.reveal-scale[data-delay="1"] { transition-delay: 80ms; }

.reveal-left[data-delay="2"],
.reveal-right[data-delay="2"],
.reveal-scale[data-delay="2"] { transition-delay: 160ms; }

.reveal-left[data-delay="3"],
.reveal-right[data-delay="3"],
.reveal-scale[data-delay="3"] { transition-delay: 240ms; }

.reveal-left[data-delay="4"],
.reveal-right[data-delay="4"],
.reveal-scale[data-delay="4"] { transition-delay: 320ms; }

.reveal-left[data-delay="5"],
.reveal-right[data-delay="5"],
.reveal-scale[data-delay="5"] { transition-delay: 400ms; }

/* Blur variant — Apple-inspired */
.reveal-blur {
  opacity: 0;
  filter: blur(12px);
  transform: translateY(16px);
  transition:
    opacity 600ms var(--spring-standard),
    filter 600ms var(--spring-standard),
    transform 600ms var(--spring-standard);
}

.reveal-blur.revealed {
  opacity: 1;
  filter: blur(0);
  transform: translateY(0);
}

/* Card glow effect — JS sets --mouse-x/--mouse-y */
.feature-card::before,
.security-card::before,
.philosophy-card::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  opacity: 0;
  background: radial-gradient(
    300px circle at var(--mouse-x, 50%) var(--mouse-y, 50%),
    rgba(124, 139, 160, 0.06) 0%,
    transparent 60%
  );
  transition: opacity 300ms;
  pointer-events: none;
  z-index: 0;
}

.feature-card:hover::before,
.security-card:hover::before,
.philosophy-card:hover::before {
  opacity: 1;
}

/* Ensure card content stays above glow */
.feature-card > *,
.security-card > * {
  position: relative;
  z-index: 2;
}

/* ═══════════════════════════════════════
   11. Responsive
═══════════════════════════════════════ */
@media (max-width: 1024px) {
  .features-grid {
    grid-template-columns: repeat(2, 1fr);
  }

  .features-grid .feature-card.large,
  .features-grid .feature-card.wide {
    grid-column: span 2;
  }

  .security-grid {
    grid-template-columns: repeat(2, 1fr);
  }

  .philosophy-grid {
    grid-template-columns: 1fr;
    gap: 40px;
  }

  .nav-links {
    display: none;
  }
}

@media (max-width: 768px) {
  .features-grid {
    grid-template-columns: 1fr;
  }

  .features-grid .feature-card.large,
  .features-grid .feature-card.wide {
    grid-column: span 1;
  }

  .features-grid .feature-card.large {
    grid-row: span 1;
  }

  .security-grid {
    grid-template-columns: 1fr;
  }

  .perf-metrics {
    flex-direction: column;
    gap: 32px;
  }

  .hero {
    padding: clamp(80px, 12vw, 160px) 24px 60px;
  }

  .hero-showcase {
    margin-top: 48px;
  }

  .demo-container {
    border-radius: var(--radius-lg);
  }

  .nav-github span {
    display: none;
  }

  .nav-github {
    padding: 8px;
  }

  .arch-stack {
    max-width: 100%;
  }
}

/* ═══════════════════════════════════════
   12. Reduced Motion — Apple pattern
═══════════════════════════════════════ */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
  .reveal,
  .reveal-left,
  .reveal-right,
  .reveal-scale,
  .reveal-blur {
    opacity: 1;
    transform: none;
    filter: none;
  }
}

/* ═══════════════════════════════════════════════════
   Launch Overlay (Demo Launch)
   ═══════════════════════════════════════════════════ */
.demo-launch-overlay {
  position: absolute;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-xl);
  overflow: hidden;
  background:
    radial-gradient(ellipse 80% 60% at 50% 40%, var(--accent-glow) 0%, transparent 60%),
    radial-gradient(ellipse 60% 50% at 30% 70%, var(--accent-subtle) 0%, transparent 50%),
    var(--depth-0-void);
}

.demo-launch-overlay.launching .demo-launch-content {
  opacity: 0;
  transform: scale(0.9);
}

.demo-launch-overlay.launching .demo-launch-icon {
  transform: scale(0);
  opacity: 0;
}

.demo-launch-overlay.launching .demo-launch-btn {
  transform: scale(0.8);
  opacity: 0;
}

.demo-launch-particles {
  position: absolute;
  inset: 0;
  pointer-events: none;
  overflow: hidden;
}

.demo-launch-particles .launch-particle {
  position: absolute;
  border-radius: 50%;
  background: var(--accent);
  animation: particle-float linear infinite;
}

.demo-launch-content {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  transition: opacity 500ms ease, transform 500ms var(--spring-standard);
}

.demo-launch-content h2 {
  font-family: var(--font-display);
  font-size: clamp(20px, 2.5vw, 28px);
  font-weight: 600;
  color: var(--text-primary);
  letter-spacing: -0.01em;
  margin: 0;
}

.demo-launch-content p {
  font-size: 14px;
  color: var(--text-secondary);
  margin: 0;
}

.demo-launch-icon {
  width: 80px;
  height: 80px;
  border-radius: 20px;
  overflow: hidden;
  box-shadow: 0 0 40px var(--accent-glow), 0 0 80px var(--accent-subtle);
  animation: launch-icon-breathe 3s ease-in-out infinite;
  transition: transform 600ms var(--spring-bouncy), opacity 600ms ease;
}

.demo-launch-icon img {
  width: 100%;
  height: 100%;
  display: block;
}

@keyframes launch-icon-breathe {
  0%, 100% { box-shadow: 0 0 40px var(--accent-glow), 0 0 80px var(--accent-subtle); transform: scale(1); }
  50% { box-shadow: 0 0 60px var(--accent-glow), 0 0 120px var(--accent-dim); transform: scale(1.03); }
}

.demo-launch-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 44px;
  padding: 0 24px;
  background: var(--accent);
  color: var(--text-inverse);
  border: none;
  border-radius: var(--radius-md);
  font-family: var(--font-ui);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  box-shadow: 0 0 20px var(--accent-glow);
  margin-top: 8px;
  transition: transform 600ms var(--spring-bouncy) 200ms, opacity 600ms ease 200ms, background var(--duration-fast);
}

.demo-launch-btn:hover {
  background: var(--accent-hover);
  transform: scale(1.05);
  box-shadow: 0 0 30px var(--accent-glow);
}

.demo-launch-btn:active {
  transform: scale(0.97);
}

.demo-launch-btn svg {
  width: 18px;
  height: 18px;
}

/* ── Demo Frame ── */
.demo-frame-wrapper {
  position: absolute;
  inset: 0;
  display: none;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-xl);
  overflow: hidden;
  background: var(--depth-0-void);
}

.demo-frame {
  width: 100%;
  height: 100%;
  border: none;
  display: block;
}

/* ── Demo Limitations Notice ── */
.demo-limitations {
  margin-top: 24px;
  padding: 16px 24px;
  background: var(--depth-3-surface);
  border: 0.5px solid var(--border-subtle);
  border-radius: var(--radius-md);
  text-align: center;
}

.demo-limitations-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-tertiary);
  margin: 0 0 6px;
  letter-spacing: 0.02em;
}

.demo-limitations p:last-child {
  font-size: 12px;
  color: var(--text-tertiary);
  line-height: 1.7;
  margin: 0;
}

.demo-limitations strong {
  color: var(--text-secondary);
  font-weight: 500;
}

/* ── Security CTA ── */
.security-cta {
  text-align: center;
  margin-top: 40px;
}

/* ── Ghost Button ── */
.btn-ghost {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 24px;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-secondary);
  background: transparent;
  border: none;
  border-radius: var(--radius-md);
  transition:
    color var(--duration-fast),
    background var(--duration-fast),
    transform var(--duration-fast);
}

.btn-ghost:hover {
  color: var(--text-primary);
  background: var(--accent-dim);
  transform: translateY(-1px);
}

.btn-ghost svg {
  width: 16px;
  height: 16px;
}

/* ═══════════════════════════════════════════════════
   Performance Grid (.perf-grid)
   ═══════════════════════════════════════════════════ */
.perf-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 20px;
}

.perf-card {
  background: var(--depth-3-surface);
  border: 0.5px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  padding: 28px 20px;
  text-align: center;
  position: relative;
  overflow: hidden;
  transition:
    transform 250ms var(--spring-standard),
    border-color 250ms;
}

.perf-card::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  opacity: 0;
  background: linear-gradient(
    135deg,
    rgba(124, 139, 160, 0.04) 0%,
    transparent 50%
  );
  transition: opacity 210ms;
  pointer-events: none;
}

.perf-card:hover {
  transform: translateY(-3px);
  border-color: var(--border-default);
}

.perf-card:hover::after {
  opacity: 1;
}

.perf-card > * {
  position: relative;
  z-index: 2;
}

.perf-unit {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-secondary);
  margin-top: 8px;
}

.perf-number {
  font-family: var(--font-display);
  font-size: clamp(28px, 2.5vw, 36px);
  font-weight: 300;
  color: var(--accent);
  font-variant-numeric: tabular-nums;
  line-height: 1;
}

.perf-label {
  font-size: 13px;
  color: var(--text-secondary);
  margin-top: 8px;
}

.perf-compare {
  font-size: 11px;
  color: var(--text-tertiary);
  margin-top: 2px;
  font-style: italic;
}

/* ── Footer Column ── */
.footer-col {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.footer-col h4 {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  margin: 0 0 4px;
}

.footer-col a {
  font-size: 13px;
  color: var(--text-secondary);
  transition: color var(--duration-fast);
  text-decoration: underline transparent;
  text-underline-offset: 3px;
}

.footer-col a:hover {
  color: var(--accent);
  text-decoration-color: var(--accent);
}

.footer-bottom {
  margin-top: 48px;
  padding-top: 20px;
  border-top: 0.5px solid var(--border-subtle);
  font-size: 12px;
  color: var(--text-ghost);
  text-align: center;
}

.footer-bottom p {
  margin: 0;
}

/* ── Responsive: Performance Grid ── */
@media (max-width: 768px) {
  .perf-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (max-width: 480px) {
  .perf-grid {
    grid-template-columns: 1fr;
  }
}

/* ═══════════════════════════════════════
   UX Improvements — All Priorities
   ═══════════════════════════════════════ */

/* ── P0: Hamburger Menu ── */
.nav-hamburger {
  display: none;
  width: 44px;
  height: 44px;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  cursor: pointer;
  transition: color var(--duration-fast), background var(--duration-fast);
}

.nav-hamburger:hover {
  color: var(--text-primary);
  background: var(--accent-dim);
}

/* Mobile nav overlay */
.nav-mobile-overlay {
  display: none;
  position: fixed;
  inset: 0;
  z-index: 899;
  background: rgba(0, 0, 0, 0.5);
  opacity: 0;
  transition: opacity 300ms ease;
  pointer-events: none;
}

.nav-mobile-overlay.open {
  opacity: 1;
  pointer-events: auto;
}

/* Mobile nav drawer */
.nav-mobile-drawer {
  display: none;
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: min(300px, 80vw);
  z-index: 901;
  background: var(--depth-2-deep);
  border-left: 0.5px solid var(--border-subtle);
  padding: 72px 24px 24px;
  transform: translateX(100%);
  transition: transform 350ms var(--spring-standard);
}

.nav-mobile-drawer.open {
  transform: translateX(0);
}

.nav-mobile-drawer a {
  display: block;
  padding: 14px 0;
  font-size: 15px;
  color: var(--text-secondary);
  border-bottom: 0.5px solid var(--border-subtle);
  transition: color var(--duration-fast);
}

.nav-mobile-drawer a:hover,
.nav-mobile-drawer a.active {
  color: var(--accent);
}

@media (max-width: 1024px) {
  .nav-hamburger {
    display: flex;
  }
  .nav-mobile-overlay,
  .nav-mobile-drawer {
    display: block;
  }

  /* Unified icon button sizing on mobile */
  .nav-github {
    width: 32px;
    height: 32px;
    padding: 0;
    justify-content: center;
  }
  .nav-github svg {
    width: 16px;
    height: 16px;
  }
  .theme-toggle {
    width: 32px;
    height: 32px;
  }
  .theme-toggle svg {
    width: 16px;
    height: 16px;
  }
  .nav-hamburger {
    width: 32px;
    height: 32px;
  }
  .nav-hamburger svg {
    width: 16px;
    height: 16px;
  }
  .nav-lang-toggle {
    width: 32px;
    height: 32px;
  }
  .nav-lang-toggle svg {
    width: 16px;
    height: 16px;
  }
}

/* ── P0: Touch Target Sizes ── */
@media (pointer: coarse) {
  .theme-toggle {
    width: 44px;
    height: 44px;
  }
  .demo-expand-btn {
    width: 44px;
    height: 44px;
  }
  .nav-links a {
    padding: 8px 12px;
    margin: -8px -12px;
  }
}

/* ── P1: Security Card Font Sizes ── */
.security-card h3 {
  font-size: 14px;
}

.security-card p {
  font-size: 13px;
  margin-top: 8px;
}

/* ── P1: Demo Limitations Font ── */
.demo-limitations p:last-child {
  font-size: 13px;
}

.demo-limitations-title {
  font-size: 13px;
}

/* ── P1: Demo Launch Hint ── */
.demo-launch-hint {
  font-size: 12px;
  color: var(--text-ghost);
  margin: 0;
  opacity: 0.7;
}

.demo-launch-limitation {
  font-size: 11px;
  color: var(--text-ghost);
  margin: 0;
  opacity: 0.6;
  max-width: 280px;
  text-align: center;
}

/* ── P0: Demo Loading Indicator ── */
.demo-loading {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  background: var(--depth-0-void);
  z-index: 50;
}

.demo-loading p {
  font-size: 13px;
  color: var(--text-tertiary);
  margin: 0;
}

.demo-loading-spinner {
  width: 28px;
  height: 28px;
  border: 2px solid var(--border-subtle);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: demo-spin 0.8s linear infinite;
}

@keyframes demo-spin {
  to { transform: rotate(360deg); }
}

/* ── P1: FAQ Section ── */
.faq-list {
  max-width: 720px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.faq-item {
  background: var(--depth-3-surface);
  border: 0.5px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  overflow: hidden;
  transition: border-color 250ms;
}

.faq-item:hover {
  border-color: var(--border-default);
}

.faq-question {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 20px;
  background: transparent;
  border: none;
  color: var(--text-primary);
  font-size: 14px;
  font-weight: 500;
  font-family: var(--font-ui);
  text-align: left;
  cursor: pointer;
  line-height: 1.5;
  transition: color var(--duration-fast);
}

.faq-question:hover {
  color: var(--accent);
}

.faq-chevron {
  flex-shrink: 0;
  transition: transform 300ms var(--spring-standard);
  color: var(--text-tertiary);
}

.faq-item.open .faq-chevron {
  transform: rotate(180deg);
}

.faq-answer {
  max-height: 0;
  overflow: hidden;
  transition: max-height 400ms var(--spring-standard), padding 300ms ease;
}

.faq-item.open .faq-answer {
  max-height: 300px;
}

.faq-answer p {
  padding: 0 20px 18px;
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.7;
  margin: 0;
  text-wrap: pretty;
}

/* ── P1: CTA Section ── */
.cta-section {
  padding: clamp(64px, 8vw, 128px) 0;
  position: relative;
}

.cta-section::before {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  background:
    radial-gradient(ellipse 60% 50% at 50% 50%, rgba(124, 139, 160, 0.04) 0%, transparent 60%);
}

.cta-inner {
  max-width: 640px;
  margin: 0 auto;
  text-align: center;
  padding-inline: clamp(24px, 5vw, 64px);
}

.cta-title {
  font-family: var(--font-display);
  font-size: clamp(22px, 3.5vw, 30px);
  font-weight: 600;
  color: var(--text-primary);
  letter-spacing: -0.01em;
  text-wrap: balance;
}

.cta-desc {
  font-size: 15px;
  color: var(--text-secondary);
  margin-top: 12px;
  line-height: 1.6;
}

.cta-buttons {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  margin-top: 32px;
  flex-wrap: wrap;
}

/* ── P3: Back to Top ── */
.back-to-top {
  position: fixed;
  bottom: 32px;
  right: 32px;
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--depth-4-raised);
  border: 0.5px solid var(--border-default);
  border-radius: 50%;
  color: var(--text-secondary);
  cursor: pointer;
  z-index: 800;
  opacity: 0;
  transform: translateY(12px);
  pointer-events: none;
  transition:
    opacity 300ms var(--spring-standard),
    transform 300ms var(--spring-standard),
    background var(--duration-fast),
    color var(--duration-fast),
    box-shadow var(--duration-fast);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
}

.back-to-top.visible {
  opacity: 1;
  transform: translateY(0);
  pointer-events: auto;
}

.back-to-top:hover {
  background: var(--depth-5-float);
  color: var(--text-primary);
  box-shadow: var(--shadow-depth-3);
}

/* ── P2: Architecture User-Friendly Description ── */
.arch-layer-user-desc {
  display: block;
  font-size: 12px;
  color: var(--text-tertiary);
  margin-top: 4px;
  font-style: italic;
}

/* ── P2: Perf Card Spacing ── */
.perf-unit {
  margin-top: 8px;
}

.perf-compare {
  margin-top: 2px;
}

/* ── P2: Security card groups ── */
.security-group-label {
  grid-column: 1 / -1;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-ghost);
  padding-top: 8px;
}

.security-group-label:first-child {
  padding-top: 0;
}

  const i18n = {
    currentLang: 'zh',

    dict: {
      zh: {
        // Navigation
        'nav.security': '安全',
        'nav.features': '特性',
        'nav.architecture': '架构',
        'nav.performance': '性能',
        'nav.demo': '在线体验',
        'nav.faq': '常见问题',
        'nav.download': '下载',
        'nav.github': 'View source on GitHub',

        // Hero
        'hero.subtitle': '安全与颜值并重的 Mihomo 客户端',
        'hero.philosophy': '13 层纵深防御 · 零前端框架 · Lite 版仅 8MB',
        'hero.cta.demo': '在线体验',
        'hero.cta.download': '下载',
        'hero.cta.downloadFull': '下载 Zephyr',
        'hero.cta.github': 'GitHub',

        // Philosophy
        'philosophy.title': '设计哲学',
        'philosophy.quote': '"安全不是功能，是底线。\n颜值不是加分，是标准。"',
        'philosophy.author': '— Zephyr 设计哲学',
        'philosophy.body': 'Zephyr 诞生于对现有 Mihomo GUI 的不满：要么臃肿如 Electron 套壳，要么简陋如功能原型。我们选择了第三条路——用 Rust 的安全基因和原生 JavaScript 的极致性能，构建一个既安全又好看的代理客户端。',
        'philosophy.zeroframework.title': '零前端框架',
        'philosophy.zeroframework.desc': '原生 JavaScript + Tailwind CSS v4，无虚拟 DOM，无运行时开销。',
        'philosophy.security.title': '安全优先',
        'philosophy.security.desc': '13 层纵深防御，从 CSP 到 TUN，每一层都经过深思熟虑。',
        'philosophy.lightweight.title': '轻量高效',
        'philosophy.lightweight.desc': 'Lite 版仅 8MB，内存占用 30MB，启动即用。',

        // Security
        'security.label': '安全体系',
        'security.title': '13 层纵深防御，覆盖全攻击面',
        'security.browser.title': '浏览器会话保护',
        'security.browser.desc': 'CSP 禁止内联脚本，禁止 eval，仅允许加载本地资源。Content-Security-Policy 阻止 XSS 攻击。',
        'security.sandbox.title': '应用沙盒隔离',
        'security.sandbox.desc': 'macOS App Sandbox + Windows AppContainer，文件系统、网络、进程隔离。',
        'security.subscription.title': '订阅链接安全',
        'security.subscription.desc': 'SSRF 防护，禁止访问私有 IP，禁止跟随重定向到私有 IP。',
        'security.update.title': '更新包可信验证',
        'security.update.desc': 'SHA256 完整性校验，仅从 GitHub Releases 可信域名下载。',
        'security.encryption.title': '元数据加密存储',
        'security.encryption.desc': 'AES-256-GCM 加密订阅 URL 和流量信息，密钥与设备指纹绑定。',
        'security.filename.title': '文件名安全处理',
        'security.filename.desc': '路径穿越防护，文件名白名单过滤，防止恶意文件名攻击。',
        'security.readmore': '阅读完整安全审计文档 →',

        // Features
        'features.label': '核心特性',
        'features.title': '每一个功能，都经过深思熟虑',
        'features.desc': '不为功能而功能。每一项能力都来自真实的使用场景。',
        'features.traffic.title': '实时流量监控',
        'features.traffic.desc': '零图表库依赖，原生 Canvas 2D 贝塞尔曲线面积图，60fps 流畅渲染，支持 DPR 高清适配。',
        'features.nodes.title': '智能节点选择',
        'features.nodes.desc': '3D 悬浮效果，延迟颜色编码，一键延迟测试，批量测速排序，超时节点自动隐藏。',
        'features.tun.title': 'TUN 虚拟网卡',
        'features.tun.desc': '系统级透明代理，macOS osascript 提权，Windows UWP 豁免，无缝接管全局流量。',
        'features.subscription.title': '订阅管理',
        'features.subscription.desc': '多格式兼容（Clash/Mihomo/Surge），客户端 UA 伪装，三重下载策略，自动更新订阅，拖拽排序。',
        'features.mode.title': '多运行模式',
        'features.mode.desc': 'Rule / Global / Direct 三种模式一键切换，支持快捷键全局操作。',
        'features.rules.title': '规则引擎',
        'features.rules.desc': 'Prism 扩展规则系统，支持规则分组、导入、提取、自动应用。内置代码编辑器，实时预览。',
        'features.crossplatform.title': '跨平台原生体验',
        'features.crossplatform.desc': 'Windows / macOS / Linux 统一代码库。Tauri v2 原生窗口，系统托盘，全局快捷键，开机自启。',

        // Architecture
        'architecture.label': '技术架构',
        'architecture.title': '四层架构，层层分明',
        'architecture.desc': '每一层只做一件事，每一层都做到极致。',
        'architecture.ui.title': '用户界面层',
        'architecture.ui.tech': '原生 JavaScript + Tailwind CSS v4 + Canvas 2D',
        'architecture.ui.userdesc': '你看到和操作的每一个像素',
        'architecture.ipc.title': 'Tauri IPC 层',
        'architecture.ipc.tech': '100+ Commands · 双向异步通信 · Capability 权限模型',
        'architecture.ipc.userdesc': '前端与后端的安全通信桥梁',
        'architecture.rust.title': 'Rust 后端层',
        'architecture.rust.tech': 'Tauri v2 · reqwest · aes-gcm · SSRF 防护 · 内存安全',
        'architecture.rust.userdesc': '零成本抽象，编译期消除 bug',
        'architecture.mihomo.title': 'Mihomo 内核层',
        'architecture.mihomo.tech': 'RESTful API · HTTP Streaming · TUN · 规则引擎',
        'architecture.mihomo.userdesc': '经过实战验证的代理核心',

        // Performance
        'performance.label': '性能指标',
        'performance.title': '轻量到极致',
        'performance.desc': '没有 Electron 的臃肿，没有框架的税。只有原生代码与系统之间的直接对话。',
        'performance.size.number': '8',
        'performance.size.unit': 'MB',
        'performance.size.label': 'Lite 版安装包',
        'performance.size.compare': 'macOS Lite 实测 8.47 MB',
        'performance.memory.number': '~30',
        'performance.memory.unit': 'MB',
        'performance.memory.label': '内存占用',
        'performance.memory.compare': 'Tauri 原生窗口，无 Chromium 开销',
        'performance.startup.number': '0',
        'performance.startup.unit': 'ms',
        'performance.startup.label': '启动延迟',
        'performance.startup.compare': '原生窗口，即时响应',
        'performance.deps.number': '0',
        'performance.deps.unit': '个',
        'performance.deps.label': '框架依赖',
        'performance.deps.compare': '零供应链攻击面',

        // Demo
        'demo.label': '在线体验',
        'demo.title': '在浏览器中体验 Zephyr',
        'demo.desc': '完整的 UI 还原，Mock 数据驱动。无需安装，即开即用。',
        'demo.launch': '启动体验',
        'demo.launchHint': '点击下方按钮启动交互式演示',
        'demo.hint': '试试点击左侧节点列表切换代理，或浏览设置页面',
        'demo.limitation': '在线演示使用 Mock 数据，部分功能需安装桌面版',
        'demo.limitations.title': '⚠ 在线演示限制',
        'demo.limitations.body': '以下功能需要本地安装桌面版才能使用：',
        'demo.limitations.tun': 'TUN 虚拟网卡',
        'demo.limitations.proxy': '系统代理',
        'demo.limitations.subscription': '订阅下载与更新',
        'demo.limitations.rules': '规则库管理',
        'demo.limitations.config': '配置文件读写',
        'demo.limitations.autostart': '开机自启',
        'demo.limitations.logs': '核心日志',
        'demo.limitations.deeplink': 'Deep Link 注册',
        'demo.limitations.mock': '演示中使用 Mock 数据模拟代理节点和流量。',
        'demo.loading': '正在加载 Zephyr...',

        // FAQ
        'faq.label': '常见问题',
        'faq.title': '你可能想知道的',
        'faq.q1': 'Zephyr 和其他客户端有什么区别？',
        'faq.a1': 'Zephyr 基于 Tauri v2 + Rust 构建，Lite 版安装包仅约 8MB，不依赖 React/Vue 等前端框架，零虚拟 DOM 开销。相比 Electron 方案，Zephyr 使用系统原生 WebView，内存占用更低，启动更快。',
        'faq.q2': 'Zephyr 如何保护我的订阅链接安全？',
        'faq.a2': '订阅 URL 和流量信息使用 AES-256-GCM 加密存储在 metadata.json 中，密钥与你的设备指纹绑定。即使元数据文件被复制到其他设备，攻击者也无法解密。此外，SSRF 防护确保订阅服务器无法通过重定向攻击你的内网。',
        'faq.q3': 'Zephyr 支持哪些平台？',
        'faq.a3': 'Windows（x64）、macOS（Apple Silicon 和 Intel）以及 Linux（deb、RPM、AppImage）。提供 Full 版和 Lite 版两种安装包，Lite 版体积仅约 8MB。',
        'faq.q4': 'Full 版和 Lite 版有什么区别？',
        'faq.a4': 'Lite 版仅包含核心功能和必要的 WebView 运行时，体积约 8MB。Full 版包含完整的 Tauri 运行时和所有系统依赖，体积约 28MB，适合没有系统 WebView 的环境。',
        'faq.q5': 'Zephyr 会收集我的数据吗？',
        'faq.a5': '不会。Zephyr 是开源软件，所有代码公开可审计。应用没有遥测、没有数据分析、不会上传任何用户数据。',
        'faq.q6': '如何确保 Zephyr 的更新是安全的？',
        'faq.a6': '每次更新都经过 SHA256 完整性校验，且仅从 GitHub Releases 的可信域名下载。CI/CD 流程使用 cargo audit、npm audit 和 Semgrep 持续扫描依赖漏洞。',

        // CTA
        'cta.title': '准备好体验更安全美观的代理了吗？',
        'cta.desc': '开源、免费、跨平台。几分钟即可上手。',
        'cta.download': '下载 Zephyr',

        // Footer
        'footer.project': '项目',
        'footer.tech': '技术',
        'footer.resources': '资源',
        'footer.license': '许可证',
        'footer.starhistory': 'Star History',
        'footer.copyright': '© 2026 Juwan · Built with Rust + Tauri v2 · Open Source',

        // Architecture Tags
        'arch.tag.encryption': '元数据加密',

        // Misc
        'backtotop': 'Back to top',
        'theme.toggle': 'Toggle dark/light theme',
        'nav.toggle': 'Toggle navigation menu',
      },

      en: {
        // Navigation
        'nav.security': 'Security',
        'nav.features': 'Features',
        'nav.architecture': 'Architecture',
        'nav.performance': 'Performance',
        'nav.demo': 'Live Demo',
        'nav.faq': 'FAQ',
        'nav.download': 'Download',
        'nav.github': 'View source on GitHub',

        // Hero
        'hero.subtitle': 'A Mihomo client that\'s secure and beautiful',
        'hero.philosophy': '13-layer defense · Zero frontend framework · Lite version only 8MB',
        'hero.cta.demo': 'Live Demo',
        'hero.cta.download': 'Download',
        'hero.cta.downloadFull': 'Download Zephyr',
        'hero.cta.github': 'GitHub',

        // Philosophy
        'philosophy.title': 'Design Philosophy',
        'philosophy.quote': '"Security is not a feature, it\'s a baseline.\nBeauty is not a bonus, it\'s a standard."',
        'philosophy.author': '— Zephyr Design Philosophy',
        'philosophy.body': 'Zephyr was born from frustration with existing Mihomo GUIs: either bloated like Electron wrappers, or crude like feature prototypes. We chose a third path—using Rust\'s safety DNA and vanilla JavaScript\'s ultimate performance to build a proxy client that\'s both secure and beautiful.',
        'philosophy.zeroframework.title': 'Zero Frontend Framework',
        'philosophy.zeroframework.desc': 'Vanilla JavaScript + Tailwind CSS v4. No virtual DOM, no runtime overhead.',
        'philosophy.security.title': 'Security First',
        'philosophy.security.desc': '13-layer defense in depth. From CSP to TUN, every layer is carefully designed.',
        'philosophy.lightweight.title': 'Lightweight & Efficient',
        'philosophy.lightweight.desc': 'Lite version only 8MB. 30MB memory footprint. Instant startup.',

        // Security
        'security.label': 'Security',
        'security.title': '13-Layer Defense in Depth',
        'security.browser.title': 'Browser Session Protection',
        'security.browser.desc': 'CSP blocks inline scripts and eval. Only local resources allowed. XSS attacks prevented.',
        'security.sandbox.title': 'Application Sandbox',
        'security.sandbox.desc': 'macOS App Sandbox + Windows AppContainer. File system, network, and process isolation.',
        'security.subscription.title': 'Subscription URL Security',
        'security.subscription.desc': 'SSRF protection. Private IP access blocked. No redirects to private IPs.',
        'security.update.title': 'Update Package Verification',
        'security.update.desc': 'SHA256 integrity check. Downloads only from trusted GitHub Releases domain.',
        'security.encryption.title': 'Encrypted Metadata Storage',
        'security.encryption.desc': 'AES-256-GCM encrypts subscription URLs and traffic info. Key bound to device fingerprint.',
        'security.filename.title': 'Safe Filename Handling',
        'security.filename.desc': 'Path traversal protection. Filename whitelist filtering. Malicious filename attack prevention.',
        'security.readmore': 'Read full security audit →',

        // Features
        'features.label': 'Core Features',
        'features.title': 'Every feature is carefully crafted',
        'features.desc': 'Every capability is driven by real-world use cases. Nothing exists just for the sake of features.',
        'features.traffic.title': 'Real-time Traffic Monitor',
        'features.traffic.desc': 'Zero chart library dependency. Native Canvas 2D Bézier area charts. 60fps smooth rendering. DPR-aware.',
        'features.nodes.title': 'Smart Node Selection',
        'features.nodes.desc': '3D hover effect. Latency color coding. One-click latency test. Batch sorting. Auto-hide timeout nodes.',
        'features.tun.title': 'TUN Virtual Network',
        'features.tun.desc': 'System-level transparent proxy. macOS osascript elevation. Windows UWP bypass. Seamless global traffic capture.',
        'features.subscription.title': 'Subscription Management',
        'features.subscription.desc': 'Multi-format compatible (Clash/Mihomo/Surge). Client UA spoofing. Triple download strategy. Auto-update. Drag to reorder.',
        'features.mode.title': 'Multiple Operation Modes',
        'features.mode.desc': 'Rule / Global / Direct modes. One-click switch. Global hotkey support.',
        'features.rules.title': 'Rule Engine',
        'features.rules.desc': 'Prism extended rule system. Rule grouping, import, extraction, auto-apply. Built-in code editor with live preview.',
        'features.crossplatform.title': 'Cross-Platform Native Experience',
        'features.crossplatform.desc': 'Windows / macOS / Linux unified codebase. Tauri v2 native windows, system tray, global hotkeys, auto-start.',

        // Architecture
        'architecture.label': 'Architecture',
        'architecture.title': 'Four Layers, Clearly Defined',
        'architecture.desc': 'Each layer does one thing. Each layer does it perfectly.',
        'architecture.ui.title': 'User Interface Layer',
        'architecture.ui.tech': 'Vanilla JavaScript + Tailwind CSS v4 + Canvas 2D',
        'architecture.ui.userdesc': 'Every pixel you see and interact with',
        'architecture.ipc.title': 'Tauri IPC Layer',
        'architecture.ipc.tech': '100+ Commands · Bidirectional async · Capability model',
        'architecture.ipc.userdesc': 'Secure bridge between frontend and backend',
        'architecture.rust.title': 'Rust Backend Layer',
        'architecture.rust.tech': 'Tauri v2 · reqwest · aes-gcm · SSRF protection · Memory safe',
        'architecture.rust.userdesc': 'Zero-cost abstraction, bugs eliminated at compile time',
        'architecture.mihomo.title': 'Mihomo Core Layer',
        'architecture.mihomo.tech': 'RESTful API · HTTP Streaming · TUN · Rule engine',
        'architecture.mihomo.userdesc': 'Battle-tested proxy core',

        // Performance
        'performance.label': 'Performance',
        'performance.title': 'Extremely Lightweight',
        'performance.desc': 'No Electron bloat. No framework tax. Just native code talking directly to the system.',
        'performance.size.number': '8',
        'performance.size.unit': 'MB',
        'performance.size.label': 'Lite Installer',
        'performance.size.compare': 'macOS Lite measured 8.47 MB',
        'performance.memory.number': '~30',
        'performance.memory.unit': 'MB',
        'performance.memory.label': 'Memory Usage',
        'performance.memory.compare': 'Tauri native window, no Chromium overhead',
        'performance.startup.number': '0',
        'performance.startup.unit': 'ms',
        'performance.startup.label': 'Startup Delay',
        'performance.startup.compare': 'Native window, instant response',
        'performance.deps.number': '0',
        'performance.deps.unit': '',
        'performance.deps.label': 'Framework Dependencies',
        'performance.deps.compare': 'Zero supply chain attack surface',

        // Demo
        'demo.label': 'Live Demo',
        'demo.title': 'Try Zephyr in Your Browser',
        'demo.desc': 'Full UI recreation with mock data. No installation required.',
        'demo.launch': 'Launch Demo',
        'demo.launchHint': 'Click the button below to start the interactive demo',
        'demo.hint': 'Try clicking the node list to switch proxies, or explore settings',
        'demo.limitation': 'Online demo uses mock data. Some features require desktop installation.',
        'demo.limitations.title': '⚠ Online Demo Limitations',
        'demo.limitations.body': 'The following features require desktop installation:',
        'demo.limitations.tun': 'TUN Virtual Network',
        'demo.limitations.proxy': 'System Proxy',
        'demo.limitations.subscription': 'Subscription Download & Update',
        'demo.limitations.rules': 'Rule Library Management',
        'demo.limitations.config': 'Config File Read/Write',
        'demo.limitations.autostart': 'Auto-start on Boot',
        'demo.limitations.logs': 'Core Logs',
        'demo.limitations.deeplink': 'Deep Link Registration',
        'demo.limitations.mock': 'Mock data is used to simulate proxy nodes and traffic in the demo.',
        'demo.loading': 'Loading Zephyr...',

        // FAQ
        'faq.label': 'FAQ',
        'faq.title': 'You Might Be Wondering',
        'faq.q1': 'What makes Zephyr different from other clients?',
        'faq.a1': 'Zephyr is built on Tauri v2 + Rust. The Lite installer is only ~8MB. It doesn\'t depend on React/Vue or any frontend framework, eliminating virtual DOM overhead. Compared to Electron-based solutions, Zephyr uses the system\'s native WebView for lower memory usage and faster startup.',
        'faq.q2': 'How does Zephyr protect my subscription URLs?',
        'faq.a2': 'Subscription URLs and traffic info are encrypted with AES-256-GCM and stored in metadata.json. The encryption key is bound to your device fingerprint. Even if the metadata file is copied to another device, attackers cannot decrypt it. SSRF protection ensures subscription servers cannot redirect to attack your internal network.',
        'faq.q3': 'Which platforms does Zephyr support?',
        'faq.a3': 'Windows (x64), macOS (Apple Silicon and Intel), and Linux (deb, RPM, AppImage). Both Full and Lite versions are available, with the Lite version at only ~8MB.',
        'faq.q4': 'What\'s the difference between Full and Lite versions?',
        'faq.a4': 'The Lite version includes only core features and the necessary WebView runtime, at about 8MB. The Full version includes the complete Tauri runtime and all system dependencies, at about 28MB, suitable for environments without a system WebView.',
        'faq.q5': 'Does Zephyr collect my data?',
        'faq.a5': 'No. Zephyr is open-source software with all code publicly auditable. The app has no telemetry, no analytics, and never uploads any user data.',
        'faq.q6': 'How can I trust Zephyr updates?',
        'faq.a6': 'Every update is verified with SHA256 integrity check and only downloaded from the trusted GitHub Releases domain. The CI/CD pipeline uses cargo audit, npm audit, and Semgrep to continuously scan for dependency vulnerabilities.',

        // CTA
        'cta.title': 'Ready for a more secure and beautiful proxy?',
        'cta.desc': 'Open source. Free. Cross-platform. Up and running in minutes.',
        'cta.download': 'Download Zephyr',

        // Footer
        'footer.project': 'Project',
        'footer.tech': 'Tech',
        'footer.resources': 'Resources',
        'footer.license': 'License',
        'footer.starhistory': 'Star History',
        'footer.copyright': '© 2026 Juwan · Built with Rust + Tauri v2 · Open Source',

        // Architecture Tags
        'arch.tag.encryption': 'Metadata Encryption',

        // Misc
        'backtotop': 'Back to top',
        'theme.toggle': 'Toggle dark/light theme',
        'nav.toggle': 'Toggle navigation menu',
      }
    },

    init() {
      // Detect browser language or use stored preference
      const stored = localStorage.getItem('zephyr-lang');
      const browserLang = navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
      this.currentLang = stored || browserLang;
      this.apply();
      this.updateButton();
    },

    set(lang) {
      this.currentLang = lang;
      localStorage.setItem('zephyr-lang', lang);
      this.apply();
      this.updateButton();
      // Dispatch event for other components
      window.dispatchEvent(new CustomEvent('langchange', { detail: { lang } }));
    },

    toggle() {
      this.set(this.currentLang === 'zh' ? 'en' : 'zh');
    },

    apply() {
      document.documentElement.lang = this.currentLang === 'zh' ? 'zh-CN' : 'en';
      // Update page title
      document.title = this.currentLang === 'zh'
        ? 'Zephyr — 安全与颜值并重的 Mihomo 客户端'
        : 'Zephyr — A Secure and Beautiful Mihomo Client';
      document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        const text = this.dict[this.currentLang][key];
        if (text) {
          if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
            el.placeholder = text;
          } else {
            el.textContent = text;
          }
        }
      });
    },

    updateButton() {
      const btn = document.getElementById('langToggle');
      if (btn) {
        // Update title to show current language
        const title = this.currentLang === 'zh' ? '当前：中文 - 点击切换到 English' : 'Current: English - Click to switch to 中文';
        btn.setAttribute('title', title);
        btn.setAttribute('aria-label', this.currentLang === 'zh' ? '切换到英文' : 'Switch to Chinese');
      }
    },

    t(key) {
      return this.dict[this.currentLang][key] || key;
    }
  };

  // Initialize i18n on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => i18n.init());
  } else {
    i18n.init();
  }

  // ── L-09: Detect prefers-reduced-motion ─────────────────────────
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ── 全局状态 ──────────────────────────────────────────────────
  const state = {
    heroVisible: false,
    rafTicking: false,
    scrollY: 0,
    navHeight: 56,
  };

  // ── 工具函数 ──────────────────────────────────────────────────

  /** rAF 节流：每帧最多执行一次 — M-09: reset ticking AFTER callback executes */
  function onFrame(fn) {
    return function () {
      if (!state.rafTicking) {
        state.rafTicking = true;
        requestAnimationFrame(() => {
          fn();
          state.rafTicking = false;
        });
      }
    };
  }

  /** easeOutExpo — 末段极度丝滑的指数衰减缓动 */
  function easeOutExpo(t) {
    return t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
  }

  /** Sync theme to Zephyr iframe by directly manipulating its DOM (same-origin) */
  function syncThemeToIframe(theme) {
    const iframe = document.getElementById('zephyrFrame');
    if (!iframe) return;
    try {
      const doc = iframe.contentDocument;
      if (!doc) return;
      const html = doc.documentElement;
      if (theme === 'dark') {
        html.classList.add('dark');
      } else {
        html.classList.remove('dark');
      }
      // Update icon (same logic as Zephyr's applyDarkMode)
      const icon = doc.getElementById('app-title-icon');
      if (icon) icon.src = theme === 'dark' ? 'dark-icon.png' : 'app-icon.png';
      // Clear inline background so CSS :not(.dark) rules take effect
      const mainContainer = doc.getElementById('app-main-container');
      if (mainContainer) mainContainer.style.backgroundColor = '';
      // Notify Zephyr modules (e.g. connections sort indicators)
      iframe.contentWindow.dispatchEvent(new CustomEvent('theme-mode-changed'));
    } catch { /* cross-origin or iframe not ready */ }
  }

  /**
   * Patch iframe's Element.prototype.scrollIntoView so it never
   * scrolls the parent (demo) page.  Zephyr's node-wheel calls
   * scrollIntoView({ block: 'center' }) which bubbles up and
   * shifts the entire demo page to the iframe position.
   */
  function patchIframeScrollIntoView(iframe) {
    try {
      const iwin = iframe.contentWindow;
      if (!iwin) return;
      const orig = iwin.Element.prototype.scrollIntoView;
      iwin.Element.prototype.scrollIntoView = function (...args) {
        // Only scroll within the iframe's own document
        const scrollable = findClosestScrollable(this);
        if (scrollable) {
          const rect = this.getBoundingClientRect();
          const sRect = scrollable.getBoundingClientRect();
          const offset = rect.top - sRect.top - (sRect.height - rect.height) / 2;
          scrollable.scrollTop += offset;
        }
        // Do NOT call orig() — that would bubble to parent
      };

      function findClosestScrollable(el) {
        const doc = el.ownerDocument;
        let parent = el.parentElement;
        while (parent && parent !== doc.body && parent !== doc.documentElement) {
          const style = iwin.getComputedStyle(parent);
          const overflow = style.overflowY || style.overflow;
          if (overflow === 'auto' || overflow === 'scroll') return parent;
          parent = parent.parentElement;
        }
        return null;
      }
    } catch { /* cross-origin or not ready */ }
  }

  // ── 导航滚动 + 进度条（渐变 + 发光前沿）──────────────────────

  function setupNavScroll() {
    const nav = document.querySelector('.site-nav');
    if (!nav) return;

    const bar = document.createElement('div');
    bar.className = 'nav-progress';
    Object.assign(bar.style, {
      position: 'absolute', bottom: '0', left: '0', width: '100%',
      height: '2.5px',
      background: 'linear-gradient(90deg, var(--accent), var(--accent-hover))',
      opacity: '0', transform: 'scaleX(0)', transformOrigin: 'left',
      transition: 'opacity 300ms ease', pointerEvents: 'none',
      boxShadow: '0 0 8px var(--accent), 0 0 3px var(--accent-hover)',
      borderRadius: '0 1px 1px 0',
    });
    // M-01: Do NOT override nav position — CSS already sets it to fixed
    nav.appendChild(bar);

    const update = onFrame(() => {
      state.scrollY = window.scrollY;
      const scrolled = state.scrollY > 100;
      nav.classList.toggle('scrolled', scrolled);
      bar.style.opacity = scrolled ? '0.65' : '0';
      if (scrolled) {
        const max = document.documentElement.scrollHeight - window.innerHeight;
        bar.style.transform = `scaleX(${max > 0 ? state.scrollY / max : 0})`;
      }
    });

    window.addEventListener('scroll', update, { passive: true });
    update();
  }

  // ── 平滑锚点滚动 ─────────────────────────────────────────────

  function setupSmoothScroll() {
    document.querySelectorAll('a[href^="#"]').forEach(link => {
      link.addEventListener('click', (e) => {
        const id = link.getAttribute('href');
        if (id === '#') return;
        const target = document.querySelector(id);
        if (!target) return;
        e.preventDefault();
        const top = target.getBoundingClientRect().top + window.scrollY - state.navHeight;
        window.scrollTo({ top, behavior: 'smooth' });
      });
    });
  }

  // ── 导航高亮 + 下划线动画（IntersectionObserver）───────────────

  function setupActiveNav() {
    const sections = document.querySelectorAll('[data-section]');
    const navLinks = document.querySelectorAll('.nav-links a');
    if (!sections.length || !navLinks.length) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach(entry => {
          if (!entry.isIntersecting) return;
          const id = entry.target.getAttribute('data-section');
          navLinks.forEach(link => {
            link.classList.toggle('active', link.getAttribute('href') === `#${id}`);
          });
        });
      },
      { rootMargin: '-40% 0px -55% 0px', threshold: 0 }
    );

    sections.forEach(s => observer.observe(s));
  }

  // ── 滚动揭示动画（方向变体 + 模糊变体 + 交错延迟）──────────

  function setupReveal() {
    const reveals = document.querySelectorAll(
      '.reveal, .reveal-left, .reveal-right, .reveal-scale, .reveal-blur'
    );
    if (!reveals.length) return;

    // L-09: If user prefers reduced motion, reveal everything immediately
    if (prefersReducedMotion) {
      reveals.forEach(el => el.classList.add('revealed'));
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach(entry => {
          if (!entry.isIntersecting) return;
          const el = entry.target;
          const staggerParent = el.closest('.reveal-stagger');
          if (staggerParent) {
            const idx = Array.from(staggerParent.children).indexOf(el);
            el.style.transitionDelay = `${idx * 80}ms`;
          }
          el.classList.add('revealed');
          observer.unobserve(el);
        });
      },
      { rootMargin: '0px 0px -60px 0px', threshold: 0.1 }
    );

    reveals.forEach(el => observer.observe(el));
  }

  // ── 数字计数器（easeOutExpo + 完成弹跳）──────────────────────

  function setupCounters() {
    const counters = document.querySelectorAll('[data-target]');
    if (!counters.length) return;

    // L-09: Skip counter animation if reduced motion preferred
    if (prefersReducedMotion) {
      counters.forEach(el => {
        const raw = el.getAttribute('data-target');
        const suffix = el.getAttribute('data-suffix') || '';
        el.textContent = raw + suffix;
      });
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            animateCounter(entry.target);
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.5 }
    );
    counters.forEach(el => observer.observe(el));
  }

  /** 解析 data-target：提取前缀（~、<）和数值 */
  function parseCountValue(raw) {
    const str = String(raw).trim();
    const prefix = /^~|^</.test(str) ? str[0] : '';
    const numeric = prefix ? str.slice(1).trim() : str;
    const value = parseFloat(numeric);
    const decimals = numeric.includes('.') ? numeric.split('.')[1].length : 0;
    return { prefix, value, decimals, valid: !isNaN(value) };
  }

  function animateCounter(el) {
    const raw = el.getAttribute('data-target');
    const suffix = el.getAttribute('data-suffix') || '';
    const { prefix, value, decimals, valid } = parseCountValue(raw);
    const duration = 1500;
    const start = performance.now();

    if (!valid) { el.textContent = raw + suffix; return; }

    function tick(now) {
      const progress = Math.min((now - start) / duration, 1);
      const eased = easeOutExpo(progress);
      el.textContent = prefix + (eased * value).toFixed(decimals) + suffix;

      if (progress < 1) {
        requestAnimationFrame(tick);
      } else {
        // 完成弹跳
        el.style.transition = 'transform 300ms cubic-bezier(0.34, 1.56, 0.64, 1)';
        el.style.transform = 'scale(1.08)';
        setTimeout(() => { el.style.transform = 'scale(1)'; }, 300);
        // 性能指标闪烁
        if (el.classList.contains('perf-number')) flashPerfNumber(el);
      }
    }
    requestAnimationFrame(tick);
  }

  /** 性能数字完成后的颜色闪烁 */
  function flashPerfNumber(el) {
    el.style.transition = 'color 200ms ease';
    el.style.color = 'var(--accent)';
    setTimeout(() => { el.style.color = 'var(--text-primary)'; }, 400);
  }

  // ── 主题切换（过渡动画 + 涟漪效果）──────────────────────────

  function setupThemeToggle() {
    const btn = document.querySelector('.theme-toggle');
    if (!btn) return;

    const root = document.documentElement;
    root.style.transition =
      'background-color 300ms ease, color 200ms ease, border-color 300ms ease, box-shadow 300ms ease';

    const icons = {
      dark: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="3.5"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.41 1.41M11.54 11.54l1.41 1.41M3.05 12.95l1.41-1.41M11.54 4.46l1.41-1.41"/></svg>',
      light: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 10.5a6 6 0 1 1-8-8 4.5 4.5 0 0 0 8 8z"/></svg>',
    };

    const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

    /** Resolve effective theme: stored > system preference */
    function getEffectiveTheme() {
      try {
        const stored = localStorage.getItem('aether-theme');
        if (stored === 'dark' || stored === 'light') return stored;
      } catch { /* storage unavailable */ }
      return systemDark.matches ? 'dark' : 'light';
    }

    /** Apply theme to root element */
    function applyTheme(theme) {
      root.setAttribute('data-theme', theme);
    }

    function updateIcon() {
      const isDark = root.getAttribute('data-theme') !== 'light';
      btn.style.opacity = '0';
      setTimeout(() => { btn.innerHTML = icons[isDark ? 'dark' : 'light']; btn.style.opacity = '1'; }, 150);
    }

    function createRipple(e) {
      const rect = btn.getBoundingClientRect();
      const size = Math.max(rect.width, rect.height) * 2;
      const ripple = document.createElement('span');
      Object.assign(ripple.style, {
        position: 'absolute', width: size + 'px', height: size + 'px',
        borderRadius: '50%', background: 'var(--accent)', opacity: '0.25',
        transform: 'scale(0)',
        transition: 'transform 500ms ease-out, opacity 500ms ease-out',
        pointerEvents: 'none',
        left: (e.clientX - rect.left - size / 2) + 'px',
        top: (e.clientY - rect.top - size / 2) + 'px',
      });
      btn.style.position = 'relative';
      btn.style.overflow = 'hidden';
      btn.appendChild(ripple);
      // L-01: Use void operator to force reflow instead of direct offsetWidth access
      void ripple.offsetWidth;
      ripple.style.transform = 'scale(1)';
      setTimeout(() => {
        ripple.style.opacity = '0';
        setTimeout(() => ripple.remove(), 500);
      }, 300);
    }

    // Apply initial theme (respect stored preference, fallback to system)
    applyTheme(getEffectiveTheme());

    // Listen for system theme changes (only if user hasn't explicitly chosen)
    systemDark.addEventListener('change', () => {
      try {
        const stored = localStorage.getItem('aether-theme');
        if (stored === 'dark' || stored === 'light') return; // user explicitly chose, ignore system
      } catch { /* storage unavailable */ }
      applyTheme(systemDark.matches ? 'dark' : 'light');
      updateIcon();
    });

    // Wrap applyTheme to also sync to iframe
    const _origApply = applyTheme;
    applyTheme = (theme) => {
      _origApply(theme);
      syncThemeToIframe(theme);
    };

    btn.style.transition = 'opacity 150ms ease';
    btn.addEventListener('click', (e) => {
      createRipple(e);
      const next = (root.getAttribute('data-theme') || 'dark') === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem('aether-theme', next); } catch { /* storage unavailable */ }
      updateIcon();
    });
    updateIcon();
  }

  // ── Hero 视差（仅 transform，不触发重排）────────────────────

  function setupHeroParallax() {
    if (prefersReducedMotion) return; // L-09: skip parallax if reduced motion

    const hero = document.querySelector('.hero-content');
    if (!hero) return;

    new IntersectionObserver(
      ([e]) => { state.heroVisible = e.isIntersecting; },
      { threshold: 0 }
    ).observe(hero);

    const update = onFrame(() => {
      if (!state.heroVisible) return;
      hero.style.transform = `translateY(${Math.min(state.scrollY * 0.15, 30)}px)`;
    });
    window.addEventListener('scroll', update, { passive: true });
  }

  // ── Chart Preview Animation (Bézier area chart, matching Zephyr style) ──
  function initChartPreview() {
    const canvas = document.getElementById('chartPreviewCanvas');
    if (!canvas) return;
    setupBézierChart(canvas, false);
  }

  // ── Hero Showcase Chart Animation ──
  function initHeroChart() {
    const canvas = document.getElementById('heroChartCanvas');
    if (!canvas) return;
    setupBézierChart(canvas, true);
  }

  /** Shared Bézier area chart renderer */
  function setupBézierChart(canvas, isHero) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    let w, h;

    function resize() {
      const rect = canvas.parentElement.getBoundingClientRect();
      w = rect.width;
      h = rect.height;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    window.addEventListener('resize', resize);

    const POINTS = isHero ? 40 : 60;
    const accentData = [];
    const secondaryData = [];
    for (let i = 0; i < POINTS; i++) {
      accentData.push(0.3 + 0.25 * Math.sin(i * 0.15) + 0.15 * Math.sin(i * 0.08 + 1) + 0.1 * Math.cos(i * 0.22 + 2));
      secondaryData.push(0.2 + 0.2 * Math.sin(i * 0.12 + 0.5) + 0.12 * Math.cos(i * 0.18 + 1.5) + 0.08 * Math.sin(i * 0.25 + 3));
    }

    const accentColor = { r: 139, g: 92, b: 246 };
    const secondaryColor = { r: 59, g: 130, b: 246 };

    function rgba(c, a) { return `rgba(${c.r},${c.g},${c.b},${a})`; }

    function drawWave(data, color) {
      const getX = (i) => (i / (POINTS - 1)) * w;
      const getY = (v) => h - v * (h - 16) - 8;

      ctx.beginPath();
      ctx.moveTo(getX(0), getY(data[0]));
      for (let i = 1; i < data.length; i++) {
        const x1 = getX(i - 1), y1 = getY(data[i - 1]);
        const x2 = getX(i), y2 = getY(data[i]);
        ctx.quadraticCurveTo(x1, y1, (x1 + x2) / 2, (y1 + y2) / 2);
      }

      ctx.strokeStyle = rgba(color, 0.8);
      ctx.lineWidth = isHero ? 1.5 : 2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke();

      const grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, rgba(color, isHero ? 0.15 : 0.25));
      grad.addColorStop(1, rgba(color, 0));
      ctx.lineTo(getX(data.length - 1), h);
      ctx.lineTo(getX(0), h);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
    }

    function drawGrid() {
      const isLight = document.documentElement.getAttribute('data-theme') === 'light';
      if (isLight) {
        ctx.strokeStyle = isHero ? 'rgba(0,0,0,0.04)' : 'rgba(0,0,0,0.06)';
      } else {
        ctx.strokeStyle = isHero ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.06)';
      }
      ctx.lineWidth = 0.5;
      for (let y = 30; y < h; y += 30) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }
    }

    let offset = 0;
    function animate() {
      offset += isHero ? 0.005 : 0.008;
      ctx.clearRect(0, 0, w, h);
      drawGrid();

      const aD = accentData.map((v, i) => v + 0.08 * Math.sin(offset * 2 + i * 0.15) + 0.05 * Math.cos(offset * 1.5 + i * 0.1));
      const sD = secondaryData.map((v, i) => v + 0.06 * Math.sin(offset * 1.8 + i * 0.12 + 1) + 0.04 * Math.cos(offset * 2.2 + i * 0.08 + 2));

      drawWave(sD, secondaryColor);
      drawWave(aD, accentColor);
      requestAnimationFrame(animate);
    }
    animate();
  }

  // ═══ Launch Animation ═══

  function initLaunchOverlay() {
    const overlay = document.getElementById('launchOverlay');
    const btn = document.getElementById('launchBtn');
    const frameWrapper = document.getElementById('demoFrameWrapper');
    const iframe = document.getElementById('zephyrFrame');
    const particles = document.getElementById('launchParticles');

    if (!overlay || !btn) return;

    // Generate floating particles
    if (particles) {
      for (let i = 0; i < 30; i++) {
        const p = document.createElement('div');
        p.className = 'launch-particle';
        p.style.cssText = `
          left: ${Math.random() * 100}%;
          top: ${Math.random() * 100}%;
          width: ${2 + Math.random() * 4}px;
          height: ${2 + Math.random() * 4}px;
          animation-delay: ${Math.random() * 6}s;
          animation-duration: ${4 + Math.random() * 8}s;
          opacity: ${0.1 + Math.random() * 0.3};
        `;
        particles.appendChild(p);
      }
    }

    btn.addEventListener('click', () => {
      // Phase 1: Button pulse
      overlay.classList.add('launching');

      // Phase 2: After icon shrinks, hide overlay and show frame
      setTimeout(() => {
        overlay.style.transition = 'opacity 400ms ease, transform 400ms ease';
        overlay.style.opacity = '0';
        overlay.style.transform = 'scale(1.05)';

        setTimeout(() => {
          overlay.style.display = 'none';
          if (frameWrapper) frameWrapper.style.display = 'flex';
          iframe.src = './app/index.html';

          iframe.addEventListener('load', () => {
            // Hide loading indicator
            const loading = document.getElementById('demoLoading');
            if (loading) {
              loading.style.transition = 'opacity 300ms ease';
              loading.style.opacity = '0';
              setTimeout(() => loading.remove(), 300);
            }
            // Sync current theme to iframe after it loads
            const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
            syncThemeToIframe(currentTheme);
            // Prevent iframe's scrollIntoView from scrolling the parent page
            patchIframeScrollIntoView(iframe);
          }, { once: true });
        }, 400);
      }, 600);
    });
  }

  // ── 卡片光晕追踪（Apple 风格聚光灯）─────────────────────────

  function setupCardGlow() {
    const cards = document.querySelectorAll('.feature-card, .security-card, .philosophy-card');
    if (!cards.length) return;

    cards.forEach(card => {
      card.addEventListener('mousemove', (e) => {
        const r = card.getBoundingClientRect();
        card.style.setProperty('--mouse-x', `${e.clientX - r.left}px`);
        card.style.setProperty('--mouse-y', `${e.clientY - r.top}px`);
      }, { passive: true });
      card.addEventListener('mouseleave', () => {
        card.style.removeProperty('--mouse-x');
        card.style.removeProperty('--mouse-y');
      });
    });
  }

  // ── Demo 全屏切换 ──────────────────────────────────────────────

  function setupDemoExpand() {
    const btn = document.getElementById('demoExpandBtn');
    const container = document.querySelector('.demo-container');
    if (!btn || !container) return; // Gracefully skip if elements don't exist

    btn.addEventListener('click', () => {
      const isExpanded = container.classList.toggle('expanded');
      btn.title = isExpanded ? '退出全屏' : '全屏';
      // Swap icon
      btn.innerHTML = isExpanded
        ? '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 4h8v8H4z"/></svg>'
        : '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 2h5v5H2zM9 2h5v5H9zM2 9h5v5H2zM9 9h5v5H9z"/></svg>';
      document.body.style.overflow = isExpanded ? 'hidden' : '';
    });
  }

  // ── Hamburger Menu (P0) ──────────────────────────────────────
  function setupHamburgerMenu() {
    const btn = document.getElementById('navHamburger');
    const drawer = document.querySelector('.nav-mobile-drawer');
    const overlay = document.querySelector('.nav-mobile-overlay');
    if (!btn || !drawer || !overlay) return;

    function openMenu() {
      drawer.classList.add('open');
      overlay.classList.add('open');
      btn.setAttribute('aria-expanded', 'true');
      document.body.style.overflow = 'hidden';
    }

    function closeMenu() {
      drawer.classList.remove('open');
      overlay.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
      document.body.style.overflow = '';
    }

    btn.addEventListener('click', () => {
      const isOpen = drawer.classList.contains('open');
      isOpen ? closeMenu() : openMenu();
    });

    overlay.addEventListener('click', closeMenu);

    // Close on link click
    drawer.querySelectorAll('a').forEach(link => {
      link.addEventListener('click', closeMenu);
    });

    // Close on Escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && drawer.classList.contains('open')) closeMenu();
    });

    // Sync active state from desktop nav
    const navLinks = document.querySelectorAll('.nav-links a');
    const mobileLinks = drawer.querySelectorAll('a[href^="#"]');
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        const id = entry.target.getAttribute('data-section');
        mobileLinks.forEach(link => {
          link.classList.toggle('active', link.getAttribute('href') === `#${id}`);
        });
      });
    }, { rootMargin: '-40% 0px -55% 0px', threshold: 0 });
    document.querySelectorAll('[data-section]').forEach(s => observer.observe(s));
  }

  // ── FAQ Accordion (P1) ──────────────────────────────────────
  function setupFAQ() {
    const items = document.querySelectorAll('.faq-item');
    if (!items.length) return;

    items.forEach(item => {
      const btn = item.querySelector('.faq-question');
      if (!btn) return;

      btn.addEventListener('click', () => {
        const isOpen = item.classList.contains('open');

        // Close all others
        items.forEach(other => {
          if (other !== item) {
            other.classList.remove('open');
            other.querySelector('.faq-question').setAttribute('aria-expanded', 'false');
          }
        });

        // Toggle current
        item.classList.toggle('open', !isOpen);
        btn.setAttribute('aria-expanded', String(!isOpen));
      });
    });
  }

  // ── Back to Top (P3) ────────────────────────────────────────
  function setupBackToTop() {
    const btn = document.getElementById('backToTop');
    if (!btn) return;

    const update = onFrame(() => {
      btn.classList.toggle('visible', state.scrollY > 600);
    });
    window.addEventListener('scroll', update, { passive: true });

    btn.addEventListener('click', () => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  // ── Perf Card Highlight (P2) ────────────────────────────────
  function setupPerfHighlight() {
    const firstPerfCard = document.querySelector('.perf-card');
    if (firstPerfCard) firstPerfCard.classList.add('highlight');
  }

  // ── Language Toggle ────────────────────────────────────────────
  function setupLangToggle() {
    const btn = document.getElementById('langToggle');
    if (!btn) return;
    btn.addEventListener('click', () => i18n.toggle());
  }

  // ── 初始化 ────────────────────────────────────────────────────

  function init() {
    setupNavScroll();
    setupSmoothScroll();
    setupActiveNav();
    setupReveal();
    setupCounters();
    setupThemeToggle();
    setupLangToggle();
    setupHeroParallax();
    initLaunchOverlay();
    setupCardGlow();
    setupDemoExpand();
    initChartPreview();
    initHeroChart();
    setupHamburgerMenu();
    setupFAQ();
    setupBackToTop();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

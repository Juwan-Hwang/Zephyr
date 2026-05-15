/**
 * Zephyr — Demo Website Interactions
 * 导航滚动、平滑锚点、导航高亮、揭示动画、计数器、主题切换、
 * 视差、进度条、卡片光晕、下划线动画、启动动画遮罩。
 */

(function () {
  'use strict';

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
      ctx.strokeStyle = isHero ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.06)';
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

  // ── 初始化 ────────────────────────────────────────────────────

  function init() {
    setupNavScroll();
    setupSmoothScroll();
    setupActiveNav();
    setupReveal();
    setupCounters();
    setupThemeToggle();
    setupHeroParallax();
    initLaunchOverlay();
    setupCardGlow();
    setupDemoExpand();
    initChartPreview();
    initHeroChart();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

import { translations } from './i18n.js';
import { getProxies, switchProxy, getConfig, patchConfig, testProxy, abortLatencyTests, setSecret, closeAllConnections, reloadConfig, enableAutoStart, disableAutoStart, isAutoStartEnabled, openConfigFolder, setBaseUrl, restartCore } from './api.js';
import { setWsSecret, setWsBaseUrl } from './websocket.js';
import { fetchAndConvertSRRules } from './rules.js';
import { initChart, updateTrafficData, clearTrafficHistory } from './modules/traffic-chart.js';

// Re-export traffic chart functions for external use
export { initChart, updateTrafficData, clearTrafficHistory };

export function switchPage(pageId) {
    const pages = document.querySelectorAll('[data-page]');
    pages.forEach(p => p.classList.add('hidden'));
    const targetPage = document.querySelector(`[data-page="${pageId}"]`);
    if (targetPage) targetPage.classList.remove('hidden');
}

export function sortProxiesByLatency(proxies, data) {
    proxies.sort((a, b) => {
        const getLat = (name) => {
            const p = data.proxies[name];
            const lat = (p && p.history && p.history.length > 0) ? p.history[p.history.length-1].delay : 0;
            return (lat === 0 || lat >= 999999) ? 1000000 : lat;
        };
        return getLat(a) - getLat(b);
    });
}

// --- HTML Escape Utility (XSS Prevention) ---
function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
}

// --- Proxy Groups Fetch Utility ---
/**
 * Fetch proxy groups data and determine the main group based on config mode.
 * @param {Object} options - Optional configuration
 * @param {Object} options.existingData - Pre-fetched proxies data to avoid duplicate API calls
 * @param {Object} options.existingConfig - Pre-fetched config to avoid duplicate API calls
 * @returns {Promise<{data: Object, config: Object, groups: string[], mainGroup: string, proxies: string[], current: string|null}|null>}
 */
async function fetchProxyGroups(options = {}) {
    const data = options.existingData || await getProxies();
    if (!data || !data.proxies) {
        return null;
    }

    const config = options.existingConfig || await getConfig();

    // Filter out selector/select type groups
    const groups = Object.keys(data.proxies).filter(name => {
        const type = data.proxies[name].type?.toLowerCase() || '';
        return type === 'selector' || type === 'select';
    });

    // Determine main group based on mode
    let mainGroup = 'GLOBAL';
    const mode = config?.mode?.toLowerCase();

    if (mode === 'direct') {
        mainGroup = 'DIRECT';
    } else if (mode !== 'global') {
        mainGroup = groups.find(g => g.toLowerCase().includes('proxy')) || groups[0];
    }

    // Fallback if mainGroup is missing
    if (!data.proxies[mainGroup]) {
        mainGroup = groups.find(g => g.toLowerCase().includes('proxy')) || groups[0];
    }

    // Last resort fallback
    if (!data.proxies[mainGroup]) {
        mainGroup = groups[0];
    }

    if (!mainGroup || !data.proxies[mainGroup]) {
        return null;
    }

    const proxies = data.proxies[mainGroup]?.all || [];
    const current = data.proxies[mainGroup]?.now || null;

    return { data, config, groups, mainGroup, proxies, current };
}

// --- i18n System ---

const detectSystemLanguage = () => {
    const language = (navigator.language || navigator.userLanguage || 'en').toLowerCase();
    if (language.startsWith('zh')) return 'zh';
    return 'en';
};

const savedLanguage = localStorage.getItem('lang');
export let currentLang = savedLanguage || detectSystemLanguage();
window._currentLang = currentLang;
if (!savedLanguage) {
    localStorage.setItem('lang', currentLang);
}
let isNetworkUpdating = false;
let isTestingLatency = false;
const latencyLoadingIcon = `<svg class="animate-spin h-3 w-3 text-accent/50 inline-block" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>`;
let latencySortTimer = null;

function applyLatencySortToDom(finalPass = false) {
    if (currentSortMode !== 'latency') return;
    const container = document.getElementById('proxies-list');
    if (!container) return;
    const cards = Array.from(container.children);
    if (cards.length === 0) return;

    cards.sort((a, b) => {
        const baseA = parseInt(a.dataset.baseOrder || '0', 10);
        const baseB = parseInt(b.dataset.baseOrder || '0', 10);
        const selectedA = a.dataset.selected === '1' ? 1 : 0;
        const selectedB = b.dataset.selected === '1' ? 1 : 0;
        if (selectedA !== selectedB) return selectedB - selectedA;

        const pendingA = a.dataset.pending === '1' ? 1 : 0;
        const pendingB = b.dataset.pending === '1' ? 1 : 0;

        if (!finalPass) {
            if (pendingA !== pendingB) return pendingA - pendingB;
            if (pendingA === 1 && pendingB === 1) {
                const estimateA = parseInt(a.dataset.estimate || '1000000', 10);
                const estimateB = parseInt(b.dataset.estimate || '1000000', 10);
                if (estimateA !== estimateB) return estimateA - estimateB;
                return baseA - baseB;
            }
        }

        const latA = parseInt(a.dataset.latency || '1000000', 10);
        const latB = parseInt(b.dataset.latency || '1000000', 10);
        if (latA !== latB) return latA - latB;
        return baseA - baseB;
    });

    cards.forEach((card, idx) => {
        card.style.order = idx;
    });
}

function queueLatencySort() {
    if (currentSortMode !== 'latency') return;
    if (latencySortTimer) clearTimeout(latencySortTimer);
    latencySortTimer = setTimeout(() => {
        applyLatencySortToDom(false);
    }, 220);
}

function buildLatencyPriorityQueue(data, candidates) {
    const withScore = candidates.map((name, idx) => {
        const proxy = data?.proxies?.[name];
        const lastDelay = (proxy?.history && proxy.history.length > 0)
            ? proxy.history[proxy.history.length - 1].delay
            : 0;
        const score = (lastDelay > 0 && lastDelay < 999999) ? lastDelay : 1000000;
        return { name, score, idx };
    });

    withScore.sort((a, b) => {
        if (a.score !== b.score) return a.score - b.score;
        return a.idx - b.idx;
    });

    const queue = [];
    let left = 0;
    let right = withScore.length - 1;
    while (left <= right) {
        queue.push(withScore[left].name);
        if (left !== right) queue.push(withScore[right].name);
        left += 1;
        right -= 1;
    }
    return queue;
}

function showLatencyLoadingForAllCards() {
    const container = document.getElementById('proxies-list');
    if (!container) return;
    const cards = Array.from(container.children);
    cards.forEach((card, index) => {
        const order = parseInt(card.style.order || `${index}`, 10);
        card.dataset.baseOrder = `${Number.isNaN(order) ? index : order}`;
        card.dataset.estimate = card.dataset.latency || '1000000';
        card.dataset.latency = 1000000;
        card.dataset.pending = '1';
        const latVal = card.querySelector('[id^="latency-"]');
        if (latVal) {
            latVal.className = 'text-xs tabular-nums font-semibold text-accent/60';
            latVal.innerHTML = latencyLoadingIcon;
        }
    });
}


export function setLanguage(lang) {
    currentLang = lang;
    window._currentLang = lang;
    localStorage.setItem('lang', lang);
    applyTranslations();
}

export function applyTranslations() {
    const t = translations[currentLang];
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        if (t[key]) el.textContent = t[key];
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        const key = el.getAttribute('data-i18n-placeholder');
        if (t[key]) el.placeholder = t[key];
    });
    
    // Update dynamic elements that don't have data-i18n attributes
    document.querySelectorAll('[data-latency-label]').forEach(el => {
        el.textContent = t.latency || "Latency";
    });
    
    // Update Tray Menu
    if (window.__TAURI__ && window.__TAURI__.core) {
        window.__TAURI__.core.invoke('update_tray_menu', {
            showText: t.trayShow || "Show",
            quitText: t.trayQuit || "Quit"
        }).catch(e => console.warn("Failed to update tray menu:", e));
    }
}

let currentTheme = 'purple';
let coreLoadingUnlisten = null;
let coreLoadingVisible = false;

export function applyTheme(theme) {
    currentTheme = theme;
    // Remove all possible theme classes
    document.body.classList.remove('theme-purple', 'theme-blue', 'theme-green', 'theme-orange', 'theme-pink');
    
    if (theme && theme.startsWith('#')) {
        document.body.style.setProperty('--color-accent', theme);
        // Calculate glow from hex
        const r = parseInt(theme.slice(1, 3), 16) || 139;
        const g = parseInt(theme.slice(3, 5), 16) || 92;
        const b = parseInt(theme.slice(5, 7), 16) || 246;
        document.body.style.setProperty('--color-accent-glow', `rgba(${r}, ${g}, ${b}, 0.2)`);
    } else {
        document.body.style.removeProperty('--color-accent');
        document.body.style.removeProperty('--color-accent-glow');
        const validThemes = ['purple', 'blue', 'green', 'orange', 'pink'];
        const t = validThemes.includes(theme) ? theme : 'purple';
        // Add theme class to body where variables are defined in styles.css
        document.body.classList.add(`theme-${t}`);
        currentTheme = t;
    }
    
    // Ensure the custom color input reflects the current theme if it's a hex
    const customColorInput = document.getElementById('custom-theme-color');
    if (customColorInput && theme && theme.startsWith('#')) {
        customColorInput.value = theme;
    }
}

function setCoreLoadingOverlayState(statusText, progress, failed = false) {
    const overlay = document.getElementById('core-loading-overlay');
    const badge = document.getElementById('core-loading-badge');
    const status = document.getElementById('core-loading-status');
    const percent = document.getElementById('core-loading-percent');
    const progressBar = document.getElementById('core-loading-progress');
    const glow = document.getElementById('core-loading-progress-glow');
    const panel = document.getElementById('core-loading-panel');

    if (!overlay || !status || !percent || !progressBar || !glow) return;

    const safeProgress = Math.max(0, Math.min(100, Number(progress) || 0));
    coreLoadingVisible = true;
    overlay.classList.remove('hidden', 'opacity-0', 'pointer-events-none');
    if (panel) panel.style.pointerEvents = 'auto';
    const t = translations[currentLang] || translations['en'];
    status.textContent = statusText || t.coreInitStatusDefault || 'Preparing core...';
    percent.textContent = `${Math.round(safeProgress)}%`;
    progressBar.style.width = `${safeProgress}%`;
    glow.style.left = `${Math.max(8, safeProgress)}%`;

    if (!badge) return;
    badge.textContent = failed ? (t.coreInitError || 'Error') : (safeProgress >= 100 ? (t.coreInitReady || 'Ready') : (t.coreInitBadge || 'Initializing'));
    badge.className = failed
        ? 'inline-flex items-center rounded-full border border-rose-400/30 bg-rose-500/10 px-3 py-1 text-[10px] font-semibold tracking-[0.3em] text-rose-200 uppercase'
        : 'inline-flex items-center rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[10px] font-semibold tracking-[0.3em] text-zinc-300 uppercase';
}

export async function initCoreLoadingOverlay() {
    const overlay = document.getElementById('core-loading-overlay');
    const panel = document.getElementById('core-loading-panel');
    coreLoadingVisible = false;
    if (overlay) {
        overlay.classList.add('hidden', 'opacity-0', 'pointer-events-none');
    }
    if (panel) panel.style.pointerEvents = '';
    panel?.classList.remove('scale-95');
    
    // Clean up previous event listener if exists
    if (coreLoadingUnlisten) {
        coreLoadingUnlisten();
        coreLoadingUnlisten = null;
    }

    const { listen } = window.__TAURI__.event;
    coreLoadingUnlisten = await listen('core-download-status', (event) => {
        const payload = event.payload || {};
        setCoreLoadingOverlayState(payload.status_text, payload.progress);
    });
}

export function finishCoreLoadingOverlay(statusText = '核心已就绪') {
    const overlay = document.getElementById('core-loading-overlay');
    const panel = document.getElementById('core-loading-panel');
    if (!overlay || !coreLoadingVisible) return;

    setCoreLoadingOverlayState(statusText, 100);
    setTimeout(() => {
        overlay.classList.add('opacity-0', 'pointer-events-none');
        if (panel) panel.style.pointerEvents = '';
        panel?.classList.add('scale-95');
        setTimeout(() => {
            coreLoadingVisible = false;
            overlay.classList.add('hidden', 'pointer-events-none');
            
            // Clean up event listener when overlay is finished
            if (coreLoadingUnlisten) {
                coreLoadingUnlisten();
                coreLoadingUnlisten = null;
            }
        }, 360);
    }, 240);
}

export function failCoreLoadingOverlay(statusText) {
    if (coreLoadingVisible) {
        finishCoreLoadingOverlay();
    }
    showNotification(statusText, 'error');
}

/**
 * Cleanup function to be called when the component is unloaded
 * or the application is shutting down
 */
export function cleanupCoreLoadingOverlay() {
    if (coreLoadingUnlisten) {
        coreLoadingUnlisten();
        coreLoadingUnlisten = null;
    }
    coreLoadingVisible = false;
}

// --- Notification System ---
export function showNotification(message, type = 'info') {
    const container = document.getElementById('notif-container');
    if (!container) return;

    const notif = document.createElement('div');
    notif.className = `glass-card py-3 px-5 border-l-4 flex items-center gap-3 shadow-2xl transition-all duration-500 translate-x-full opacity-0 pointer-events-auto min-w-[200px]`;
    
    const colors = {
        info: 'border-accent text-accent',
        success: 'border-emerald-500 text-emerald-400',
        error: 'border-rose-500 text-rose-400'
    };
    notif.className += ` ${colors[type] || colors.info}`;
    
    const msgDiv = document.createElement('div');
    msgDiv.className = 'text-xs font-bold tracking-tight';
    msgDiv.textContent = message;
    notif.appendChild(msgDiv);

    container.appendChild(notif);

    // Animate in
    requestAnimationFrame(() => {
        notif.classList.remove('translate-x-full', 'opacity-0');
    });

    // Remove after 3s
    setTimeout(() => {
        notif.classList.add('translate-x-full', 'opacity-0');
        setTimeout(() => notif.remove(), 500);
    }, 3000);
}

// --- Custom Modal ---
export function showModal(title, placeholder = '', defaultValue = '', isCustomContent = false, customHtml = '') {
    return new Promise((resolve) => {
        const bg = document.getElementById('modal-bg');
        const container = document.getElementById('modal-container');
        const titleEl = document.getElementById('modal-title');
        const contentArea = document.getElementById('modal-content-area');
        const inputEl = document.getElementById('modal-input');
        const confirmBtn = document.getElementById('modal-confirm');
        const cancelBtn = document.getElementById('modal-cancel');

        titleEl.textContent = title;

        if (isCustomContent) {
            contentArea.innerHTML = '';
            contentArea.insertAdjacentHTML('beforeend', customHtml);
        } else {
            contentArea.innerHTML = '';
            const input = document.createElement('input');
            input.type = 'text';
            input.id = 'modal-input';
            input.placeholder = placeholder;
            input.className = 'w-full bg-black/40 border border-white/5 rounded-2xl px-6 py-4 text-sm text-zinc-200 focus:outline-none focus:border-accent/50 transition-all tracking-wider font-light';
            input.value = defaultValue;
            contentArea.appendChild(input);
        }

        const close = (val) => {
            bg.classList.add('opacity-0');
            container.classList.add('scale-95');
            setTimeout(() => {
                bg.classList.add('hidden');
                resolve(val);
            }, 300);
        };

        bg.classList.remove('hidden');
        requestAnimationFrame(() => {
            bg.classList.remove('opacity-0');
            container.classList.remove('scale-95');
        });

        confirmBtn.onclick = () => {
            if (isCustomContent) {
                // If custom content, return the whole form data as object or let caller handle it 
                // We'll pass back the modal container so caller can query it
                resolve(contentArea);
                close();
            } else {
                const val = document.getElementById('modal-input').value;
                close(val);
            }
        };
        cancelBtn.onclick = () => close(null);
        bg.onclick = (e) => { if (e.target === bg) close(null); };
        
        if (!isCustomContent) {
            const currentInput = document.getElementById('modal-input');
            currentInput.focus();
            currentInput.onkeydown = (e) => {
                if (e.key === 'Enter') close(currentInput.value);
                if (e.key === 'Escape') close(null);
            };
        }
    });
}

export function showConfirmModal(title, message = '') {
    return new Promise((resolve) => {
        const bg = document.getElementById('modal-bg');
        const container = document.getElementById('modal-container');
        const titleEl = document.getElementById('modal-title');
        const contentArea = document.getElementById('modal-content-area');
        const confirmBtn = document.getElementById('modal-confirm');
        const cancelBtn = document.getElementById('modal-cancel');

        titleEl.textContent = title;
        contentArea.innerHTML = '';
        const msgDiv = document.createElement('div');
        msgDiv.className = 'rounded-2xl border border-amber-500/20 bg-amber-500/10 px-5 py-4 text-sm leading-6 text-zinc-200';
        msgDiv.textContent = message;
        contentArea.appendChild(msgDiv);

        const close = (val) => {
            bg.classList.add('opacity-0');
            container.classList.add('scale-95');
            setTimeout(() => {
                bg.classList.add('hidden');
                resolve(val);
            }, 300);
        };

        bg.classList.remove('hidden');
        requestAnimationFrame(() => {
            bg.classList.remove('opacity-0');
            container.classList.remove('scale-95');
        });

        confirmBtn.onclick = () => close(true);
        cancelBtn.onclick = () => close(false);
        bg.onclick = (e) => { if (e.target === bg) close(false); };
        confirmBtn.focus();
        confirmBtn.onkeydown = (e) => {
            if (e.key === 'Enter') close(true);
            if (e.key === 'Escape') close(false);
        };
        cancelBtn.onkeydown = (e) => {
            if (e.key === 'Escape') close(false);
        };
    });
}

// --- 3D Hover Effect ---
export function setup3DEffect(input) {
    const elements = (input instanceof NodeList || Array.isArray(input)) ? input : [input];
    elements.forEach(el => {
        if (!el || !(el instanceof HTMLElement)) return;
        let frameId = null;
        
        const handleMouseMove = (e) => {
            if (frameId) cancelAnimationFrame(frameId);
            frameId = requestAnimationFrame(() => {
                const rect = el.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const y = e.clientY - rect.top;
                
                const centerX = rect.width / 2;
                const centerY = rect.height / 2;
                
                const angleY = (x - centerX) / 40;
                const angleX = (centerY - y) / 40;
                
                el.style.transform = `perspective(1000px) rotateX(${angleX}deg) rotateY(${angleY}deg) translateY(-4px) scale(1.02)`;
                el.style.zIndex = "10";
            });
        };

        const handleMouseLeave = () => {
            if (frameId) cancelAnimationFrame(frameId);
            el.style.transform = 'translateY(0) scale(1)';
            el.style.zIndex = "1";
            setTimeout(() => {
                el.style.transform = '';
            }, 300);
        };

        el.addEventListener('mousemove', handleMouseMove);
        el.addEventListener('mouseleave', handleMouseLeave);
    });
}

// --- Navigation Logic ---
export function initNavigation() {
    const navItems = document.querySelectorAll('[data-nav]');
    const pages = document.querySelectorAll('[data-page]');
    
    // 应用 3D 效果到侧边栏图标
    setup3DEffect(navItems);

    navItems.forEach(item => {
        item.addEventListener('click', () => {
            const targetPage = item.getAttribute('data-nav');
            
            // Update Nav UI
            navItems.forEach(i => {
                i.classList.remove('bg-white/10', 'text-white', 'shadow-lg', 'ring-1', 'ring-white/20');
                i.classList.add('text-zinc-500');
            });
            item.classList.add('bg-white/10', 'text-white', 'shadow-lg', 'ring-1', 'ring-white/20');
            item.classList.remove('text-zinc-500');
            
            // Switch Pages
            switchPage(targetPage);
            if (targetPage === 'proxies') {
                renderProxies();
            } else if (targetPage === 'advanced') {
                renderAdvancedSettings();
            } else if (targetPage === 'home') {
                updateSysProxyUI();
            } else if (targetPage === 'rules') {
                initRulesPage();
            }
        });
    });
}

async function updateSysProxyUI() {
    const statusText = document.getElementById('proxy-status-text');
    const toggle = document.getElementById('sys-proxy-toggle');
    
    try {
        const isActive = await window.__TAURI__.core.invoke('get_sys_proxy');

        if (toggle && toggle.checked !== isActive) {
            toggle.checked = isActive;
        }

        if (!statusText) return;

        // 同步主开关文字
        if (isActive) {
            statusText.textContent = translations[currentLang].proxyStatusActive || 'Proxy Active';
            statusText.classList.remove('text-zinc-500');
            statusText.classList.add('text-accent');
        } else {
            statusText.textContent = translations[currentLang].proxyStatusReady || 'Ready to protect your traffic';
            statusText.classList.remove('text-accent');
            statusText.classList.add('text-zinc-500');
        }
    } catch (err) {
        console.error('Failed to update sys proxy UI:', err);
    }
}

// --- Advanced Settings Logic ---
export async function renderAdvancedSettings() {
    const container = document.getElementById('advanced-settings-container');
    if (!container) return;

    try {
        const config = await getConfig();
        if (!config) throw new Error("Failed to fetch config");

        const fragment = document.createDocumentFragment();
        
        // Render root categories as collapsible cards
        for (const [key, value] of Object.entries(config)) {
            const card = renderConfigSection(key, value, key);
            fragment.appendChild(card);
        }

        container.innerHTML = '';
        container.appendChild(fragment);
    } catch (err) {
        console.error('Advanced settings render error:', err);
        container.innerHTML = '';
        const errDiv = document.createElement('div');
        errDiv.className = 'p-8 text-center text-rose-400 text-xs font-bold';
        errDiv.textContent = err.message;
        container.appendChild(errDiv);
    }
}

// Render a config section (object) as a collapsible card
function renderConfigSection(title, obj, fullKey, depth = 0) {
    const card = document.createElement('div');
    card.className = "glass-card overflow-hidden";
    card.dataset.key = fullKey;
    
    // Header with collapse toggle
    const header = document.createElement('div');
    header.className = "flex items-center justify-between p-4 cursor-pointer hover:bg-white/[0.03] active:bg-white/[0.06] transition-all duration-200 select-none";
    header.innerHTML = `
        <div class="flex items-center gap-2.5">
            <svg class="w-3 h-3 text-zinc-500 transition-transform ease-[cubic-bezier(0.25,1,0.5,1)] collapse-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="m6 9 6 6 6-6"/>
            </svg>
            <h3 class="text-xs font-semibold text-zinc-200 tracking-wide">${title}</h3>
            ${typeof obj === 'object' && obj !== null && !Array.isArray(obj) ? `<span class="text-[9px] text-zinc-600 font-mono">${Object.keys(obj).length}</span>` : ''}
        </div>
        <span class="text-[9px] text-zinc-600 font-mono opacity-60">${fullKey}</span>
    `;
    
    // Content wrapper for smooth animation
    const contentWrapper = document.createElement('div');
    contentWrapper.className = "collapse-content-wrapper";
    contentWrapper.style.cssText = `
        display: grid;
        grid-template-rows: 0fr;
        transition: grid-template-rows 0.35s cubic-bezier(0.25, 1, 0.5, 1);
    `;
    
    const contentInner = document.createElement('div');
    contentInner.className = "overflow-hidden";
    contentInner.style.cssText = `min-height: 0;`;
    
    const content = document.createElement('div');
    content.className = "border-t border-white/5 space-y-1 p-3";
    content.style.cssText = `
        transform: translateY(-8px);
        opacity: 0;
        transition: transform 0.3s cubic-bezier(0.25, 1, 0.5, 1), opacity 0.25s ease;
    `;
    
    contentInner.appendChild(content);
    contentWrapper.appendChild(contentInner);
    
    // Collapse state management
    let isCollapsed = depth > 0;
    const arrow = header.querySelector('.collapse-arrow');
    
    const updateCollapse = (animate = false) => {
        if (isCollapsed) {
            contentWrapper.style.gridTemplateRows = '0fr';
            content.style.transform = 'translateY(-8px)';
            content.style.opacity = '0';
            arrow.style.transform = 'rotate(-90deg)';
        } else {
            contentWrapper.style.gridTemplateRows = '1fr';
            content.style.transform = 'translateY(0)';
            content.style.opacity = '1';
            arrow.style.transform = 'rotate(0deg)';
        }
    };
    
    // Initial state without animation
    if (isCollapsed) {
        arrow.style.transform = 'rotate(-90deg)';
        contentWrapper.style.gridTemplateRows = '0fr';
    } else {
        contentWrapper.style.gridTemplateRows = '1fr';
        content.style.transform = 'translateY(0)';
        content.style.opacity = '1';
    }
    
    header.onclick = () => {
        isCollapsed = !isCollapsed;
        updateCollapse(true);
    };
    
    // Render content based on type
    if (typeof obj === 'object' && obj !== null) {
        if (Array.isArray(obj)) {
            renderArrayContent(content, obj, fullKey, depth);
        } else {
            renderObjectContent(content, obj, fullKey, depth);
        }
    } else {
        const item = renderConfigItem(title, obj, fullKey);
        content.appendChild(item);
    }
    
    card.appendChild(header);
    card.appendChild(contentWrapper);
    return card;
}

// Render object content (nested key-value pairs)
function renderObjectContent(container, obj, parentKey, depth) {
    for (const [key, value] of Object.entries(obj)) {
        const currentKey = `${parentKey}.${key}`;
        
        if (typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length > 0) {
            // Nested object - render as sub-section
            const subSection = renderConfigSection(key, value, currentKey, depth + 1);
            container.appendChild(subSection);
        } else if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'object' && value[0] !== null) {
            // Array of objects - render as special section
            const arraySection = renderArraySection(key, value, currentKey, depth + 1);
            container.appendChild(arraySection);
        } else {
            // Primitive or simple array
            const item = renderConfigItem(key, value, currentKey);
            container.appendChild(item);
        }
    }
}

// Render array content
function renderArrayContent(container, arr, parentKey, depth) {
    if (arr.length === 0) {
        const empty = document.createElement('div');
        empty.className = "text-xs text-zinc-500 italic";
        empty.textContent = "(empty array)";
        container.appendChild(empty);
        return;
    }
    
    // Check if array of objects
    if (typeof arr[0] === 'object' && arr[0] !== null) {
        // Render each object as a mini-card
        arr.forEach((item, index) => {
            const itemCard = document.createElement('div');
            itemCard.className = "bg-black/20 rounded-lg p-3 space-y-2";
            
            // Index header
            const idxHeader = document.createElement('div');
            idxHeader.className = "text-[10px] text-zinc-500 font-mono mb-2";
            idxHeader.textContent = `[${index}]`;
            itemCard.appendChild(idxHeader);
            
            // Render object properties
            if (typeof item === 'object' && !Array.isArray(item)) {
                for (const [k, v] of Object.entries(item)) {
                    const itemRow = renderConfigItem(k, v, `${parentKey}[${index}].${k}`);
                    itemCard.appendChild(itemRow);
                }
            } else {
                // Array or primitive
                const itemRow = renderConfigItem('', item, `${parentKey}[${index}]`);
                itemCard.appendChild(itemRow);
            }
            
            container.appendChild(itemCard);
        });
    } else {
        // Simple array (strings, numbers, etc.)
        renderSimpleArrayEditor(container, arr, parentKey);
    }
}

// Render array section (for arrays of objects at section level)
function renderArraySection(title, arr, fullKey, depth) {
    const card = document.createElement('div');
    card.className = "bg-black/20 rounded-xl overflow-hidden";
    
    // Header
    const header = document.createElement('div');
    header.className = "flex items-center justify-between p-3 cursor-pointer hover:bg-white/[0.03] active:bg-white/[0.06] transition-all duration-200 select-none";
    header.innerHTML = `
        <div class="flex items-center gap-2">
            <svg class="w-2.5 h-2.5 text-zinc-500 transition-transform ease-[cubic-bezier(0.25,1,0.5,1)] collapse-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="m6 9 6 6 6-6"/>
            </svg>
            <span class="text-[11px] font-medium text-zinc-300">${title}</span>
            <span class="text-[9px] text-zinc-600 font-mono">${arr.length}</span>
        </div>
    `;
    
    // Content wrapper for smooth animation
    const contentWrapper = document.createElement('div');
    contentWrapper.className = "collapse-content-wrapper";
    contentWrapper.style.cssText = `
        display: grid;
        grid-template-rows: 0fr;
        transition: grid-template-rows 0.35s cubic-bezier(0.25, 1, 0.5, 1);
    `;
    
    const contentInner = document.createElement('div');
    contentInner.className = "overflow-hidden";
    contentInner.style.cssText = `min-height: 0;`;
    
    const content = document.createElement('div');
    content.className = "border-t border-white/5 space-y-2 p-3";
    content.style.cssText = `
        transform: translateY(-8px);
        opacity: 0;
        transition: transform 0.3s cubic-bezier(0.25, 1, 0.5, 1), opacity 0.25s ease;
    `;
    
    contentInner.appendChild(content);
    contentWrapper.appendChild(contentInner);
    
    let isCollapsed = true;
    const arrow = header.querySelector('.collapse-arrow');
    
    // Set initial state
    arrow.style.transform = 'rotate(-90deg)';
    
    const updateCollapse = () => {
        if (isCollapsed) {
            contentWrapper.style.gridTemplateRows = '0fr';
            content.style.transform = 'translateY(-8px)';
            content.style.opacity = '0';
            arrow.style.transform = 'rotate(-90deg)';
        } else {
            contentWrapper.style.gridTemplateRows = '1fr';
            content.style.transform = 'translateY(0)';
            content.style.opacity = '1';
            arrow.style.transform = 'rotate(0deg)';
        }
    };
    
    header.onclick = () => {
        isCollapsed = !isCollapsed;
        updateCollapse();
    };
    
    // Render array items
    renderArrayContent(content, arr, fullKey, depth);
    
    card.appendChild(header);
    card.appendChild(contentWrapper);
    return card;
}

// Simple array editor (strings, numbers)
function renderSimpleArrayEditor(container, arr, fullKey) {
    const wrapper = document.createElement('div');
    wrapper.className = "space-y-1";
    
    const textarea = document.createElement('textarea');
    textarea.className = "w-full min-h-[60px] bg-black/40 border border-white/5 rounded-lg px-3 py-2 text-[10px] text-zinc-300 focus:outline-none focus:border-accent/50 transition-all font-mono resize-y";
    textarea.value = arr.join('\n');
    textarea.rows = Math.min(arr.length, 10);
    
    textarea.onchange = () => {
        const newValue = textarea.value.split('\n').filter(line => line.trim() !== '');
        handleConfigUpdate(fullKey, newValue);
    };
    
    wrapper.appendChild(textarea);
    container.appendChild(wrapper);
}

// Render a single config item (key-value pair)
function renderConfigItem(key, value, fullKey) {
    const row = document.createElement('div');
    row.className = "flex items-center justify-between w-full gap-4 py-1";
    row.dataset.fullKey = fullKey;

    // Label
    const labelContainer = document.createElement('div');
    labelContainer.className = "shrink-0 min-w-0";
    
    if (key) {
        const label = document.createElement('p');
        label.className = "text-xs font-medium text-zinc-300 capitalize truncate";
        label.textContent = key.replace(/-/g, ' ');
        labelContainer.appendChild(label);
    }
    
    const subLabel = document.createElement('p');
    subLabel.className = "text-[9px] text-zinc-600 font-mono truncate";
    subLabel.textContent = fullKey.split('.').pop();
    labelContainer.appendChild(subLabel);
    
    row.appendChild(labelContainer);

    // Value container
    const valueContainer = document.createElement('div');
    valueContainer.className = "flex-1 max-w-[200px] flex justify-end";
    
    if (typeof value === 'boolean') {
        // Boolean toggle
        const toggleLabel = document.createElement('label');
        toggleLabel.className = "ios-switch";
        
        const input = document.createElement('input');
        input.type = "checkbox";
        input.checked = value;
        input.onchange = () => handleConfigUpdate(fullKey, input.checked);
        
        const slider = document.createElement('span');
        slider.className = "switch-slider";
        
        toggleLabel.appendChild(input);
        toggleLabel.appendChild(slider);
        valueContainer.appendChild(toggleLabel);
    } else if (typeof value === 'number') {
        // Number input
        const input = document.createElement('input');
        input.type = "number";
        input.value = value;
        input.className = "w-full max-w-[100px] bg-black/40 border border-white/5 rounded-lg px-3 py-1 text-xs text-zinc-300 focus:outline-none focus:border-accent/50 transition-all text-right font-mono";
        input.onchange = () => handleConfigUpdate(fullKey, Number(input.value));
        valueContainer.appendChild(input);
    } else if (typeof value === 'string') {
        // String input
        const input = document.createElement('input');
        input.type = "text";
        input.value = value;
        input.className = "w-full bg-black/40 border border-white/5 rounded-lg px-3 py-1 text-xs text-zinc-300 focus:outline-none focus:border-accent/50 transition-all text-right font-mono";
        input.onchange = () => handleConfigUpdate(fullKey, input.value);
        valueContainer.appendChild(input);
    } else if (Array.isArray(value)) {
        // Array indicator - show type preview
        const wrapper = document.createElement('div');
        wrapper.className = "flex items-center gap-1.5";
        
        const badge = document.createElement('span');
        badge.className = "text-[10px] text-zinc-400 px-2 py-0.5 bg-black/30 rounded-md";
        badge.textContent = value.length === 1 ? `1 item` : `${value.length} items`;
        wrapper.appendChild(badge);
        
        // Show preview of first item if simple type
        if (value.length > 0 && typeof value[0] !== 'object') {
            const preview = document.createElement('span');
            preview.className = "text-[9px] text-zinc-600 font-mono truncate max-w-[80px]";
            preview.textContent = String(value[0]);
            wrapper.appendChild(preview);
        }
        
        valueContainer.appendChild(wrapper);
    } else if (typeof value === 'object' && value !== null) {
        // Object indicator
        const badge = document.createElement('span');
        badge.className = "text-[10px] text-zinc-400 px-2 py-0.5 bg-black/30 rounded-md";
        const keyCount = Object.keys(value).length;
        badge.textContent = keyCount === 1 ? `1 field` : `${keyCount} fields`;
        valueContainer.appendChild(badge);
    } else if (value === null || value === undefined) {
        // Null/undefined value - allow setting a value
        const wrapper = document.createElement('div');
        wrapper.className = "flex items-center gap-1";
        
        const badge = document.createElement('span');
        badge.className = "text-[10px] text-zinc-600 italic px-2 py-0.5 bg-black/30 rounded";
        badge.textContent = value === null ? "null" : "undefined";
        wrapper.appendChild(badge);
        
        // Add button to set value
        const setBtn = document.createElement('button');
        setBtn.className = "text-[10px] text-accent hover:text-accent/80 px-1.5 py-0.5 rounded transition-colors";
        setBtn.title = "Set value";
        setBtn.innerHTML = `<svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14m-7-7h14"/></svg>`;
        setBtn.onclick = (e) => {
            e.stopPropagation();
            const input = document.createElement('input');
            input.type = "text";
            input.className = "w-full max-w-[120px] bg-black/40 border border-accent/50 rounded-lg px-2 py-1 text-xs text-zinc-300 focus:outline-none font-mono";
            input.placeholder = "value...";
            input.onkeydown = (ev) => {
                if (ev.key === 'Enter') {
                    const val = input.value.trim();
                    // Try to parse as number, boolean, or keep as string
                    let parsed = val;
                    if (val === 'true') parsed = true;
                    else if (val === 'false') parsed = false;
                    else if (val !== '' && !isNaN(Number(val))) parsed = Number(val);
                    else if (val.startsWith('{') || val.startsWith('[')) {
                        try { parsed = JSON.parse(val); } catch {}
                    }
                    handleConfigUpdate(fullKey, parsed);
                } else if (ev.key === 'Escape') {
                    wrapper.innerHTML = '';
                    wrapper.appendChild(badge);
                    wrapper.appendChild(setBtn);
                }
            };
            wrapper.innerHTML = '';
            wrapper.appendChild(input);
            input.focus();
        };
        wrapper.appendChild(setBtn);
        valueContainer.appendChild(wrapper);
    }
    
    row.appendChild(valueContainer);
    return row;
}

// Handle config update - save to core and persist to file
async function handleConfigUpdate(path, value) {
    // Parse path to handle nested objects and array indices
    // Examples: "dns.enable" -> {dns: {enable: value}}
    //           "proxies[0].name" -> {proxies: [{name: value}]}
    
    const payload = buildNestedPayload(path, value);
    
    try {
        // 1. Patch config to running core (hot reload)
        await patchConfig(payload);
        
        // 2. Persist changes to config file
        await persistConfigChanges(payload);
        
        // 3. Show success notification
        showNotification(translations[currentLang].configSuccess || 'Configuration saved', 'success');
        
        // 4. Sync UI with core state after a short delay
        setTimeout(syncCoreConfig, 500);
    } catch (err) {
        console.error('Failed to update config:', err);
        showNotification(`${translations[currentLang].errorPrefix || 'Error'}: ${err.message || err}`, 'error');
        
        // Refresh UI to show current state
        renderAdvancedSettings();
    }
}

// Build nested payload from path string (supports array indices)
function buildNestedPayload(path, value) {
    const result = {};
    let current = result;
    
    // Parse path segments (handle both dots and array indices)
    // e.g., "proxies[0].name" -> [{type:'key', value:'proxies'}, {type:'index', value:0}, {type:'key', value:'name'}]
    const segments = [];
    const regex = /([^.\[\]]+)|\[(\d+)\]/g;
    let match;
    while ((match = regex.exec(path)) !== null) {
        if (match[1] !== undefined) {
            segments.push({ type: 'key', value: match[1] });
        } else if (match[2] !== undefined) {
            segments.push({ type: 'index', value: parseInt(match[2]) });
        }
    }
    
    // Build nested structure
    for (let i = 0; i < segments.length - 1; i++) {
        const seg = segments[i];
        const nextSeg = segments[i + 1];
        
        if (seg.type === 'key') {
            // Determine if next segment is array or object
            if (nextSeg.type === 'index') {
                current[seg.value] = [];
            } else {
                current[seg.value] = {};
            }
            current = current[seg.value];
        } else {
            // Array index - need to fill array with placeholders
            while (current.length <= seg.value) {
                current.push(nextSeg.type === 'index' ? [] : {});
            }
            current = current[seg.value];
        }
    }
    
    // Set final value
    const lastSeg = segments[segments.length - 1];
    if (lastSeg.type === 'key') {
        current[lastSeg.value] = value;
    } else {
        while (current.length <= lastSeg.value) {
            current.push(null);
        }
        current[lastSeg.value] = value;
    }
    
    return result;
}

let currentConfigRules = [];
let originalConfigRules = [];

// --- Rules Engine Logic ---
export async function initRulesPage() {
    const list = document.getElementById('rules-list');
    if (!list) return;

    // Fetch initial original rules state silently without UI updates
    if (!originalConfigRules || originalConfigRules.length === 0) {
        try {
            const settings = await window.__TAURI__.core.invoke('get_settings');
            const configName = settings.last_config || 'config.yaml';
            const content = await window.__TAURI__.core.invoke('read_config_file', { configPath: configName });
            if (typeof jsyaml !== 'undefined') {
                const config = jsyaml.load(content);
                originalConfigRules = config.rules || [];
                // Only initialize currentConfigRules from original when first loading
                if (currentConfigRules.length === 0) {
                    currentConfigRules = [...originalConfigRules];
                }
            }
        } catch (e) {
            // Silently ignore if fails on first init
        }
    }

    // Add UI Listeners (only once)
    if (!list.dataset.init) {
        list.dataset.init = 'true';
        const form = document.getElementById('add-rule-form');
        const addBtn = document.getElementById('add-rule-btn');
        const cancelBtn = document.getElementById('cancel-add-rule-btn');
        const confirmBtn = document.getElementById('confirm-add-rule-btn');

        addBtn?.addEventListener('click', () => {
            form.classList.remove('hidden');
            document.getElementById('new-rule-value').focus();
        });

        cancelBtn?.addEventListener('click', () => {
            form.classList.add('hidden');
            document.getElementById('new-rule-value').value = '';
        });

        confirmBtn?.addEventListener('click', () => {
            const type = document.getElementById('new-rule-type').value;
            const value = document.getElementById('new-rule-value').value.trim();
            const policy = document.getElementById('new-rule-policy').value;

            if (type !== 'MATCH' && !value) {
                const t = translations[currentLang];
                showNotification(t.valueEmpty || 'Value cannot be empty', 'error');
                return;
            }

            const newRule = type === 'MATCH' ? `${type},${policy}` : `${type},${value},${policy}`;
            currentConfigRules.unshift(newRule);
            renderRulesList();
            updateSaveRulesBtnVisibility();
            
            form.classList.add('hidden');
            document.getElementById('new-rule-value').value = '';
        });

        document.getElementById('save-rules-btn')?.addEventListener('click', saveRules);
        document.getElementById('import-sr-btn')?.addEventListener('click', importSRRules);
        
        // Search functionality
        const searchInput = document.getElementById('rules-search-input');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                renderRulesList(e.target.value);
            });
        }
        
        list.dataset.init = 'true';
    }

    await loadRules();
}

async function getActiveConfigContent() {
    const settings = await window.__TAURI__.core.invoke('get_settings');
    let configName = settings.last_config || 'config.yaml';
    let content = '';
    try {
        content = await window.__TAURI__.core.invoke('read_config_file', { configPath: configName });
        return { configName, content };
    } catch (e) {
        const configs = await window.__TAURI__.core.invoke('list_configs');
        if (configs && configs.length > 0) {
            configName = configs[0].name;
            content = await window.__TAURI__.core.invoke('read_config_file', { configPath: configName });
            return { configName, content };
        } else {
            return null;
        }
    }
}

async function loadRules() {
    try {
        const activeConfig = await getActiveConfigContent();
        if (!activeConfig) {
            currentConfigRules = [];
            originalConfigRules = [];
            renderRulesList();
            return;
        }
        const { content } = activeConfig;
        
        // Use jsyaml from CDN
        if (typeof jsyaml === 'undefined') {
            const t = translations[currentLang];
            showNotification(t.jsYamlError || 'js-yaml is not loaded. Check internet connection.', 'error');
            return;
        }
        const config = jsyaml.load(content);
        currentConfigRules = config.rules || [];
        originalConfigRules = [...currentConfigRules];
        renderRulesList();
        updateSaveRulesBtnVisibility();
    } catch (err) {
        showNotification(translations[currentLang].notifRulesLoadFailed, 'error');
        console.error('Failed to load rules:', err);
    }
}

function renderRulesList(searchQuery = '') {
    const container = document.getElementById('rules-list');
    if (!container) return;
    container.innerHTML = '';
    
    const query = searchQuery.toLowerCase();
    
    currentConfigRules.forEach((rule, index) => {
        if (query && !rule.toLowerCase().includes(query)) return;
        
        const parts = typeof rule === 'string' ? rule.split(',').map(s => s.trim()) : [];
        if (parts.length < 2) return;

        const type = parts[0];
        const value = parts[1];
        const policy = parts[2] || 'Proxy';
        
        const item = document.createElement('div');
        item.className = 'glass-card p-4 flex items-center justify-between group hover:translate-x-1 transition-transform duration-300 cursor-pointer';
        
        item.innerHTML = `
            <div class="flex items-center gap-4 flex-1">
                <div class="px-2 py-0.5 rounded bg-white/5 border border-white/10 text-[9px] font-bold text-zinc-500 uppercase">${escapeHtml(type)}</div>
                <div class="text-xs text-zinc-300 font-mono truncate max-w-[240px]" title="${escapeHtml(value)}">${escapeHtml(value)}</div>
            </div>
            <div class="flex items-center gap-2">
                <div class="text-[10px] font-bold ${getPolicyColor(policy)} uppercase tracking-wider mr-2">${escapeHtml(policy)}</div>
                
                <button class="btn-move-top-rule opacity-0 group-hover:opacity-100 p-1.5 rounded-lg text-zinc-500 hover:text-accent hover:bg-accent/10 transition-all" title="${translations[currentLang].moveToTop || 'Move to Top'}">
                    <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
                </button>
                <button class="btn-move-bottom-rule opacity-0 group-hover:opacity-100 p-1.5 rounded-lg text-zinc-500 hover:text-accent hover:bg-accent/10 transition-all" title="${translations[currentLang].moveToBottom || 'Move to Bottom'}">
                    <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M19 12l-7 7-7-7"/></svg>
                </button>
                <button class="btn-delete-rule opacity-0 group-hover:opacity-100 p-1.5 rounded-lg text-zinc-500 hover:text-rose-500 hover:bg-rose-500/10 transition-all">
                    <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                </button>
            </div>
        `;
        
        // Edit rule on click
        item.addEventListener('click', (e) => {
            if (e.target.closest('.btn-delete-rule') || e.target.closest('.btn-move-top-rule') || e.target.closest('.btn-move-bottom-rule')) return;
            
            const form = document.getElementById('add-rule-form');
            form.classList.remove('hidden');
            
            document.getElementById('new-rule-type').value = type;
            document.getElementById('new-rule-value').value = value || '';
            document.getElementById('new-rule-policy').value = policy;
            
            // Remove the old rule, so saving the form acts as an update
            currentConfigRules.splice(index, 1);
            
            // Scroll to top to see the form
            document.getElementById('rules-list').scrollTop = 0;
            document.getElementById('new-rule-value').focus();
        });
        
        item.querySelector('.btn-move-top-rule').addEventListener('click', (e) => {
            e.stopPropagation();
            if (index > 0) {
                const rule = currentConfigRules.splice(index, 1)[0];
                currentConfigRules.unshift(rule);
                renderRulesList(document.getElementById('rules-search-input')?.value || '');
                updateSaveRulesBtnVisibility();
            }
        });

        item.querySelector('.btn-move-bottom-rule').addEventListener('click', (e) => {
            e.stopPropagation();
            if (index < currentConfigRules.length - 1) {
                const rule = currentConfigRules.splice(index, 1)[0];
                currentConfigRules.push(rule);
                renderRulesList(document.getElementById('rules-search-input')?.value || '');
                updateSaveRulesBtnVisibility();
            }
        });

        item.querySelector('.btn-delete-rule').addEventListener('click', (e) => {
            e.stopPropagation();
            currentConfigRules.splice(index, 1);
            renderRulesList(document.getElementById('rules-search-input')?.value || '');
            updateSaveRulesBtnVisibility();
        });
        
        container.appendChild(item);
    });
}

function getPolicyColor(policy) {
    const p = policy.toUpperCase();
    if (p === 'DIRECT') return 'text-green-400';
    if (p === 'REJECT') return 'text-rose-500';
    return 'text-accent';
}

async function importSRRules() {
    const input = document.getElementById('import-sr-input');
    const url = input?.value.trim();
    if (!url) return;

    const btn = document.getElementById('import-sr-btn');
    const originalText = btn.textContent;
    btn.textContent = '...';
    btn.disabled = true;

    try {
        const newRules = await fetchAndConvertSRRules(url);
        currentConfigRules = [...newRules, ...currentConfigRules];
        renderRulesList();
        updateSaveRulesBtnVisibility();
        showNotification(translations[currentLang].notifSRImportSuccess, 'success');
        input.value = '';
    } catch (err) {
        showNotification(translations[currentLang].notifSRImportFailed, 'error');
    } finally {
        btn.textContent = originalText;
        btn.disabled = false;
    }
}

async function saveRules() {
    const btn = document.getElementById('save-rules-btn');
    if (!btn) return;
    const originalContent = btn.innerHTML;
    btn.innerHTML = '<svg class="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 12a9 9 0 1 1-6.21-8.58"/></svg>';
    btn.disabled = true;

    try {
        const activeConfig = await getActiveConfigContent();
        if (!activeConfig) {
            throw new Error("No valid configuration file found to save rules.");
        }
        const { configName, content } = activeConfig;
        
        if (typeof jsyaml === 'undefined') {
            const t = translations[currentLang];
            showNotification(t.jsYamlSaveError || 'js-yaml is not loaded. Cannot save/load rules.', 'error');
            return;
        }
        const config = jsyaml.load(content);
        
        // Use backend update_config to patch the core rules dynamically to avoid 400 error.
        // It will automatically update run_config.yaml and the original profile.
        const result = await window.__TAURI__.core.invoke('update_config', { patch: { rules: currentConfigRules } });
        await closeAllConnections();
        
        originalConfigRules = [...currentConfigRules];
        updateSaveRulesBtnVisibility();
        
        // Show appropriate notification based on result
        if (result && result.hot_reload_success) {
            showNotification(translations[currentLang].notifRulesSaved, 'success');
        } else {
            showNotification(result?.message || translations[currentLang].notifRulesSaved, 'info');
        }
    } catch (err) {
        showNotification(translations[currentLang].notifRulesParseFailed, 'error');
        console.error('[Rules] Save failed:', err);
    } finally {
        btn.innerHTML = originalContent;
        btn.disabled = false;
    }
}

function updateSaveRulesBtnVisibility() {
    const saveBtn = document.getElementById('save-rules-btn');
    if (!saveBtn) return;
    
    // Check if rules are modified
    const isModified = JSON.stringify(currentConfigRules) !== JSON.stringify(originalConfigRules);
    
    if (isModified) {
        saveBtn.classList.remove('hidden');
    } else {
        saveBtn.classList.add('hidden');
    }
}

let currentSortMode = localStorage.getItem('sortMode') || 'default'; // 'default', 'name', 'latency'

export function initProxyControls() {
    const testBtn = document.getElementById('test-all-btn');
    const sortBtn = document.getElementById('sort-btn');
    const sortLabel = document.getElementById('sort-label');

    // Init sort label
    if (sortLabel) {
        const t = translations[currentLang];
        const labels = {
            default: t.sortDefault,
            name: t.sortName,
            latency: t.sortLatency
        };
        sortLabel.textContent = labels[currentSortMode] || labels['default'];
    }

    if (testBtn) {
        testBtn.onclick = async () => {
            if (isTestingLatency) return;
            isTestingLatency = true;
            
            const icon = document.getElementById('test-icon');
            const t = translations[currentLang];
            
            icon?.classList.add('animate-spin', 'text-purple-400');
            testBtn.classList.add('opacity-50', 'cursor-not-allowed');
            
            try {
                showLatencyLoadingForAllCards();
                await renderProxies();
                
                const proxyGroupsResult = await fetchProxyGroups();
                if (!proxyGroupsResult) {
                    throw new Error('No valid proxy group found for testing');
                }
                const { data, mainGroup, proxies } = proxyGroupsResult;
                // Filter out REJECT and COMPATIBLE nodes from being tested
                const validProxiesToTest = proxies.filter(name => {
                    const node = data.proxies[name];
                    const type = node?.type?.toLowerCase() || '';
                    return type !== 'reject' && type !== 'compatible' && type !== 'pass';
                });
                
                if (validProxiesToTest.length === 0) {
                    showNotification(translations[currentLang].noProxiesToTest || 'No proxies to test in current group', 'info');
                    return;
                }
                
                // Helper function to test and update UI immediately
                const testProxyAndUpdate = async (name) => {
                    const delay = await testProxy(name);
                    
                    // Update wrapper dataset even if inner card is not rendered
                    const container = document.getElementById('proxies-list');
                    if (container) {
                        const wrapper = container.querySelector(`[data-name="${CSS.escape(name)}"]`);
                        if (wrapper) {
                            if (delay > 0) {
                                wrapper.dataset.latency = delay;
                            } else {
                                wrapper.dataset.latency = 1000000;
                            }
                            wrapper.dataset.pending = '0';
                        }
                    }

                    const updatedLatVal = document.getElementById(`latency-${CSS.escape(name)}`);
                    if (updatedLatVal) {
                        const card = updatedLatVal.closest('.glass-card');
                        if (delay > 0) {
                            updatedLatVal.textContent = delay + 'ms';
                            updatedLatVal.className = `text-xs tabular-nums font-semibold ${delay < 200 ? 'text-emerald-400' : (delay < 500 ? 'text-amber-400' : 'text-rose-400')}`;
                            if (card) {
                                card.dataset.latency = delay;
                                card.dataset.pending = '0';
                            }
                        } else {
                            updatedLatVal.textContent = translations[currentLang].timeout || 'Timeout';
                            updatedLatVal.className = 'text-xs tabular-nums font-semibold text-zinc-600';
                            if (card) {
                                card.dataset.latency = 1000000;
                                card.dataset.pending = '0';
                            }
                        }
                    }
                    queueLatencySort();
                };

                const priorityQueue = buildLatencyPriorityQueue(data, validProxiesToTest);
                let queueIndex = 0;
                const concurrency = Math.min(12, priorityQueue.length);
                const workers = Array.from({ length: concurrency }, async () => {
                    while (queueIndex < priorityQueue.length) {
                        const currentIndex = queueIndex;
                        queueIndex += 1;
                        const name = priorityQueue[currentIndex];
                        await testProxyAndUpdate(name);
                    }
                });
                await Promise.all(workers);
            } catch (err) {
                console.error('Latency test error:', err);
                showNotification(`${translations[currentLang].latencyTestFailed || 'Latency test failed'}: ${err.message || err}`, 'error');
            } finally {
                isTestingLatency = false;
                if (latencySortTimer) clearTimeout(latencySortTimer);
                applyLatencySortToDom(true);
                icon?.classList.remove('animate-spin', 'text-purple-400');
                testBtn.classList.remove('opacity-50', 'cursor-not-allowed');
            }
        };
    }

    if (sortBtn) {
        sortBtn.onclick = () => {
            const modes = ['default', 'name', 'latency'];
            const idx = (modes.indexOf(currentSortMode) + 1) % modes.length;
            currentSortMode = modes[idx];
            localStorage.setItem('sortMode', currentSortMode);
            
            const t = translations[currentLang];
            const labels = {
                default: t.sortDefault,
                name: t.sortName,
                latency: t.sortLatency
            };
            if (sortLabel) sortLabel.textContent = labels[currentSortMode];
            renderProxies();
        };
    }
}

async function renderProxies() {
    const container = document.getElementById('proxies-list');
    if (!container) return;
    
    const t = translations[currentLang];
    
    if (container.children.length === 0) {
        container.innerHTML = '';
        const loading = document.createElement('div');
        loading.className = "col-span-full text-center py-10 text-zinc-500 flex flex-col items-center gap-4";
        const span = document.createElement('span');
        span.textContent = t.loadingNodes;
        const spinner = document.createElement('div');
        spinner.className = "w-6 h-6 border-2 border-zinc-500 border-t-transparent rounded-full animate-spin";
        loading.appendChild(span);
        loading.appendChild(spinner);
        container.appendChild(loading);
    }
    
    const data = await getProxies();
    if (!data || !data.proxies) {
        container.innerHTML = '';
        const err = document.createElement('div');
        err.className = "col-span-full text-center py-10 text-rose-400 bg-rose-400/5 rounded-2xl border border-rose-400/20";
        err.textContent = t.failedToConnect;
        container.appendChild(err);
        return;
    }
    
    const config = await getConfig();
    if (config?.mode?.toLowerCase() === 'direct') {
        container.innerHTML = '';
        const prompt = document.createElement('div');
        prompt.className = "col-span-full text-center py-20 text-zinc-500 bg-white/5 rounded-3xl border border-white/5 flex flex-col items-center gap-4";
        prompt.innerHTML = `
            <svg class="w-12 h-12 opacity-20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            <span class="text-sm font-light tracking-widest uppercase opacity-60">${t.directModePrompt}</span>
        `;
        container.appendChild(prompt);
        return;
    }

    const proxyGroupsResult = await fetchProxyGroups({ existingData: data, existingConfig: config });
    if (!proxyGroupsResult) {
        container.innerHTML = '';
        const empty = document.createElement('div');
        empty.className = "col-span-full text-center py-10 text-zinc-500";
        empty.textContent = t.noGroupsFound;
        container.appendChild(empty);
        return;
    }

    let { mainGroup, proxies, current } = proxyGroupsResult;
    proxies = [...proxies]; // Create a mutable copy
    
    if (currentSortMode === 'name') {
        proxies.sort((a, b) => a.localeCompare(b));
    } else if (currentSortMode === 'latency') {
        sortProxiesByLatency(proxies, data);
    }

    container._virtData = { proxies, data, current, isTestingLatency, mainGroup };
    
    const existingWrappers = Array.from(container.children);
    const existingNames = new Set(existingWrappers.map(w => w.dataset.name));
    const newNames = new Set(proxies);
    const canUpdateInPlace = existingWrappers.length > 0 && 
        existingWrappers.length === proxies.length && 
        [...existingNames].every(name => newNames.has(name));

    if (canUpdateInPlace) {
        const wrapperMap = new Map();
        existingWrappers.forEach(w => wrapperMap.set(w.dataset.name, w));

        proxies.forEach((name, index) => {
            const wrapper = wrapperMap.get(name);
            const proxy = data.proxies[name];
            const isSelected = name === current;
            
            wrapper.dataset.index = index;
            wrapper.dataset.baseOrder = `${index}`;
            wrapper.style.order = index;
            wrapper.dataset.selected = isSelected ? '1' : '0';
            const lastDelay = (proxy.history && proxy.history.length > 0) ? proxy.history[proxy.history.length-1].delay : null;
            if (wrapper.dataset.pending !== '1') {
                 wrapper.dataset.latency = (lastDelay === null || lastDelay === 0 || lastDelay >= 999999) ? 1000000 : lastDelay;
                 wrapper.dataset.estimate = wrapper.dataset.latency;
            }
            
            const card = wrapper.firstElementChild;
            if (card) {
                card.dataset.baseOrder = `${index}`;
                card.dataset.selected = isSelected ? '1' : '0';
                
                const delayColor = lastDelay === null ? 'text-zinc-600' : (lastDelay === 0 || lastDelay >= 999999 ? 'text-zinc-600' : (lastDelay < 200 ? 'text-emerald-400' : (lastDelay < 500 ? 'text-amber-400' : 'text-rose-400')));
                const latVal = card.querySelector(`[id^="latency-"]`);
                if (latVal && wrapper.dataset.pending !== '1') {
                    latVal.className = `text-xs tabular-nums font-semibold ${delayColor}`;
                    latVal.textContent = (lastDelay && lastDelay > 0 && lastDelay < 999999) ? lastDelay + 'ms' : 'Timeout';
                }

                if (isSelected) {
                    card.classList.add('bg-white/15', 'border-accent/40', 'shadow-accent/20', 'ring-1', 'ring-accent/30');
                    card.classList.remove('hover:bg-white/5');
                    if (!card.querySelector('.active-dot')) {
                        const activeDot = document.createElement('div');
                        activeDot.className = "active-dot absolute top-2 right-2 w-2.5 h-2.5 bg-accent rounded-full border-2 border-zinc-900 shadow-lg animate-pulse";
                        card.appendChild(activeDot);
                    }
                } else {
                    card.classList.remove('bg-white/15', 'border-accent/40', 'shadow-accent/20', 'ring-1', 'ring-accent/30');
                    card.classList.add('hover:bg-white/5');
                    const activeDot = card.querySelector('.active-dot');
                    if (activeDot) activeDot.remove();
                }
            }
        });
        
        applyLatencySortToDom(true);
        return;
    }

    const fragment = document.createDocumentFragment();
    
    // We no longer use IntersectionObserver to destroy DOM elements
    // to prevent GC pressure and scroll jank.
    // CSS content-visibility handles performance natively.
    
    const createCard = (wrapper) => {
        const { proxies, data, current, isTestingLatency, mainGroup } = container._virtData;
        const index = parseInt(wrapper.dataset.index, 10);
        const name = proxies[index];
        const proxy = data.proxies[name];
        const isSelected = name === current;
        
        let latFromWrapper = null;
        let pendingFromWrapper = isTestingLatency ? '1' : '0';
        if (wrapper.dataset.latency) latFromWrapper = parseInt(wrapper.dataset.latency, 10);
        if (wrapper.dataset.pending) pendingFromWrapper = wrapper.dataset.pending;

        const card = document.createElement('div');
        card.dataset.baseOrder = `${index}`;
        card.dataset.selected = isSelected ? '1' : '0';
        card.dataset.pending = pendingFromWrapper;
        card.className = `p-4 glass-card movie-card-base cursor-pointer flex flex-col gap-3 relative transition-all duration-300 group h-full w-full
            ${isSelected ? 'bg-white/15 border-accent/40 shadow-accent/20 ring-1 ring-accent/30' : 'hover:bg-white/5'}`;
        
        let lastDelay = (proxy.history && proxy.history.length > 0) ? proxy.history[proxy.history.length-1].delay : null;
        if (latFromWrapper !== null) {
            lastDelay = latFromWrapper === 1000000 ? 0 : latFromWrapper;
        }
        
        const delayColor = lastDelay === null ? 'text-zinc-600' : (lastDelay === 0 || lastDelay >= 999999 ? 'text-zinc-600' : (lastDelay < 200 ? 'text-emerald-400' : (lastDelay < 500 ? 'text-amber-400' : 'text-rose-400')));
        
        card.dataset.latency = (lastDelay === null || lastDelay === 0 || lastDelay >= 999999) ? 1000000 : lastDelay;
        card.dataset.estimate = card.dataset.latency;

        const top = document.createElement('div');
        top.className = "flex items-center justify-between pointer-events-none w-full gap-2";
        
        const nameContainer = document.createElement('div');
        const isScrollingEnabled = localStorage.getItem('nodeScroll') === 'true';
        nameContainer.className = `flex-1 text-sm font-semibold text-zinc-100 tracking-tight transition-all duration-300 ${isScrollingEnabled && name.length > 12 ? 'scrolling-text-container' : 'overflow-hidden'}`;
        
        const nameSpan = document.createElement('span');
        if (isScrollingEnabled && name.length > 12) {
             nameSpan.classList.add('scrolling-text');
        } else {
             nameSpan.classList.add('truncate', 'block');
        }
        nameSpan.textContent = name;
        nameContainer.appendChild(nameSpan);
        
        const typeSpan = document.createElement('span');
        typeSpan.className = "text-[9px] font-bold px-1.5 py-0.5 rounded-md bg-black/40 text-zinc-400 border border-white/5 uppercase shrink-0";
        typeSpan.textContent = proxy.type;
        
        top.appendChild(nameContainer);
        top.appendChild(typeSpan);

        const bottom = document.createElement('div');
        bottom.className = "flex items-end justify-between mt-auto pointer-events-none";
        const left = document.createElement('div');
        left.className = "flex items-center gap-2";
        const dot = document.createElement('div');
        dot.className = `w-1.5 h-1.5 rounded-full shadow-[0_0_8px_rgba(34,197,94,0.4)] ${proxy.udp ? 'bg-green-500' : 'bg-zinc-600'}`;
        const udpText = document.createElement('span');
        udpText.className = "text-[10px] text-zinc-500 font-medium";
        udpText.textContent = "UDP";
        left.appendChild(dot);
        left.appendChild(udpText);
        const right = document.createElement('div');
        right.className = "flex flex-col items-end";
        const latLabel = document.createElement('span');
        latLabel.className = "text-[10px] text-zinc-500 font-medium uppercase tracking-wider mb-0.5";
        latLabel.setAttribute('data-latency-label', 'true');
        latLabel.textContent = translations[currentLang].latency || "Latency";
        const latVal = document.createElement('span');
        latVal.id = `latency-${CSS.escape(name)}`;
        if (pendingFromWrapper === '1') {
            latVal.className = 'text-xs tabular-nums font-semibold text-accent/60';
            latVal.innerHTML = latencyLoadingIcon;
            card.dataset.latency = 1000000;
        } else {
            latVal.className = `text-xs tabular-nums font-semibold ${delayColor}`;
            latVal.textContent = (lastDelay && lastDelay > 0 && lastDelay < 999999) ? lastDelay + 'ms' : (translations[currentLang].timeout || 'Timeout');
        }
        right.appendChild(latLabel);
        right.appendChild(latVal);
        bottom.appendChild(left);
        bottom.appendChild(right);

        if (isSelected) {
            const activeDot = document.createElement('div');
            activeDot.className = "active-dot absolute top-2 right-2 w-2.5 h-2.5 bg-accent rounded-full border-2 border-zinc-900 shadow-lg animate-pulse";
            card.appendChild(activeDot);
        }

        card.appendChild(top);
        card.appendChild(bottom);
        card.onclick = async () => {
            // Abort latency tests to free up connection pool immediately
            abortLatencyTests();

            // Provide visual feedback that we are switching
            card.classList.add('opacity-50', 'pointer-events-none');
            const originalLatContent = latVal ? latVal.innerHTML : '';
            if (latVal) {
                latVal.innerHTML = '<svg class="w-3 h-3 animate-spin text-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>';
            }

            const success = await switchProxy(mainGroup, name);
            
            card.classList.remove('opacity-50', 'pointer-events-none');
            if (latVal) {
                latVal.innerHTML = originalLatContent;
            }

            if (success) {
                // Update UI state
                container.querySelectorAll('.glass-card').forEach(c => {
                    if (c.classList) {
                        c.classList.remove('bg-white/15', 'border-accent/40', 'shadow-accent/20', 'ring-1', 'ring-accent/30');
                        c.classList.add('hover:bg-white/5');
                    }
                    const dot = c.querySelector('.active-dot');
                    if (dot) dot.remove();
                });
                container.querySelectorAll('div[data-name]').forEach(w => {
                    w.dataset.selected = w.dataset.name === name ? '1' : '0';
                });
                
                card.classList.add('bg-white/15', 'border-accent/40', 'shadow-accent/20', 'ring-1', 'ring-accent/30');
                card.classList.remove('hover:bg-white/5');
                if (!card.querySelector('.active-dot')) {
                    const activeDot = document.createElement('div');
                    activeDot.className = "active-dot absolute top-2 right-2 w-2.5 h-2.5 bg-accent rounded-full border-2 border-zinc-900 shadow-lg animate-pulse";
                    card.appendChild(activeDot);
                }
                
                // Immediately apply sort if needed
                if (typeof applyLatencySortToDom === 'function') {
                    applyLatencySortToDom();
                }

                closeAllConnections().then(() => {
                    syncCoreConfig();
                });
            }
        };
        return card;
    };

    proxies.forEach((name, index) => {
        const wrapper = document.createElement('div');
        wrapper.style.order = index;
        wrapper.dataset.baseOrder = `${index}`;
        wrapper.dataset.index = index;
        wrapper.dataset.name = name;
        
        const proxy = data.proxies[name];
        const isSelected = name === current;
        wrapper.dataset.selected = isSelected ? '1' : '0';
        wrapper.dataset.pending = isTestingLatency ? '1' : '0';
        const lastDelay = (proxy.history && proxy.history.length > 0) ? proxy.history[proxy.history.length-1].delay : null;
        wrapper.dataset.latency = (lastDelay === null || lastDelay === 0 || lastDelay >= 999999) ? 1000000 : lastDelay;
        wrapper.dataset.estimate = wrapper.dataset.latency;
        
        wrapper.style.height = '96px'; 
        wrapper.style.contentVisibility = 'auto';
        wrapper.style.containIntrinsicSize = '96px';
        wrapper.className = 'w-full';
        
        // Directly append the card
        const card = createCard(wrapper);
        wrapper.appendChild(card);
        setup3DEffect(card);
        
        // Prevent clipping by disabling content-visibility on hover
        let leaveTimeout;
        wrapper.addEventListener('mouseenter', () => {
            clearTimeout(leaveTimeout);
            wrapper.style.contentVisibility = 'visible';
            wrapper.style.zIndex = '10';
            wrapper.style.position = 'relative';
        });
        wrapper.addEventListener('mouseleave', () => {
            // Wait for the 300ms transition to finish before restoring clipping
            leaveTimeout = setTimeout(() => {
                wrapper.style.contentVisibility = 'auto';
                wrapper.style.zIndex = '';
                wrapper.style.position = '';
            }, 300);
        });
        
        fragment.appendChild(wrapper);
    });

    if (container._virtObserver) {
        container._virtObserver.disconnect();
    }

    container.innerHTML = '';
    container.appendChild(fragment);
}

export function initUwpExemption() {
    const exemptBtn = document.getElementById('exempt-uwp-btn');
    const spinner = document.getElementById('uwp-spinner');
    
    if (exemptBtn) {
        if (!navigator.userAgent.includes('Windows')) {
            const container = document.getElementById('uwp-loopback-item');
            if (container) container.style.display = 'none';
        }
        
        exemptBtn.onclick = async () => {
            if (isNetworkUpdating) return;
            
            const t = translations[currentLang];
            const confirmed = await showConfirmModal(t.uwpExemptTitle || "UWP Loopback Exemption", t.uwpExemptDesc || "This will apply loopback exemption to all UWP apps, which requires Administrator privileges. Do you want to continue?");
            if (!confirmed) return;

            isNetworkUpdating = true;
            exemptBtn.classList.add('opacity-50', 'cursor-not-allowed');
            spinner?.classList.remove('hidden');
            
            try {
                const result = await window.__TAURI__.core.invoke('exempt_uwp_apps');
                showNotification(translations[currentLang].notifUwpSuccess || 'UWP Loopback exemption process started. Please check the UAC prompt.', 'success');
                // Removed debug log
            } catch (err) {
                showNotification((translations[currentLang].notifUwpFailed || 'Failed') + ': ' + err, 'error');
            } finally {
                isNetworkUpdating = false;
                exemptBtn.classList.remove('opacity-50', 'cursor-not-allowed');
                spinner?.classList.add('hidden');
            }
        };
    }
}

// --- Settings Logic ---
export async function initSettings() {
    const langSelect = document.getElementById('setting-lang');
    const langTrigger = document.getElementById('setting-lang-trigger');
    const langMenu = document.getElementById('setting-lang-menu');
    const langLabel = document.getElementById('setting-lang-label');
    const langArrow = document.getElementById('setting-lang-arrow');
    const closeTrayToggle = document.getElementById('setting-close-tray');
    const autoUpdateToggle = document.getElementById('setting-auto-update');
    const autostartToggle = document.getElementById('setting-autostart');
    const unifiedDelayToggle = document.getElementById('setting-unified-delay');
    const ipv6Toggle = document.getElementById('setting-ipv6');
    const allowLanToggle = document.getElementById('setting-allow-lan');
    const updateGeoBtn = document.getElementById('update-geo-btn');
    const addTunnelBtn = document.getElementById('add-tunnel-btn');
    const tunnelsList = document.getElementById('tunnels-list');
    const tunnelsEmpty = document.getElementById('tunnels-empty');
    const themeCircles = document.querySelectorAll('[data-theme]');
    const checkUpdateBtn = document.getElementById('check-update-btn');
    const nodeScrollToggle = document.getElementById('setting-node-scroll');
    const versionText = document.getElementById('core-version-text');
    const configsList = document.getElementById('configs-list');
    const customArgsInput = document.getElementById('custom-args-input');
    const applyArgsBtn = document.getElementById('apply-args-btn');
    const gotoAdvancedBtn = document.getElementById('btn-goto-advanced');
    const backSettingsBtn = document.getElementById('btn-back-settings');
    const customColorInput = document.getElementById('custom-theme-color');
    const opacitySlider = document.getElementById('setting-opacity');
    const opacityValText = document.getElementById('opacity-val-text');
    const restoreDefaultsBtn = document.getElementById('btn-restore-defaults');
    const openConfigFolderBtn = document.getElementById('open-config-folder-btn');
    const appMainContainer = document.getElementById('app-main-container');
    const themeModeContainer = document.getElementById('setting-theme-mode-container');
    const themeModeSlider = document.getElementById('setting-theme-mode-slider');
    const themeModeButtons = Array.from(document.querySelectorAll('[data-theme-mode]'));
    const appTitleIcon = document.getElementById('app-title-icon');

    if (gotoAdvancedBtn) {
        gotoAdvancedBtn.onclick = () => {
            switchPage('advanced');
            renderAdvancedSettings();
        };
    }

    const gotoGithubBtn = document.getElementById('btn-goto-github');
    if (gotoGithubBtn) {
        gotoGithubBtn.onclick = () => {
            window.__TAURI__.opener.openUrl('https://github.com/Juwan-Hwang/Zephyr');
        };
    }

    if (backSettingsBtn) {
        backSettingsBtn.onclick = () => {
            switchPage('settings');
        };
    }

    if (applyArgsBtn) {
        applyArgsBtn.onclick = async () => {
            const argsStr = customArgsInput.value.trim();
            const settings = await window.__TAURI__.core.invoke('get_settings');
            const configPath = settings.last_config || 'config.yaml';
            const customArgs = argsStr.split('\n').filter(a => a.trim() !== '');
            
            showNotification(translations[currentLang].notifSavingAndRestarting || "Saving and restarting core...");
            try {
                // Save settings first
                await save();

                const coreResult = await restartCore(configPath, customArgs);
                showNotification(translations[currentLang].notifRestartSuccess || "Core restarted successfully", 'success');
                syncCoreConfig();
            } catch (err) {
                showNotification(err.toString(), 'error');
            }
        };
    }

    if (langSelect) {
        const syncLanguageUI = () => {
            const selectedOption = langSelect.querySelector(`option[value="${langSelect.value}"]`);
            if (langLabel && selectedOption) {
                langLabel.textContent = selectedOption.textContent || selectedOption.value;
            }
            if (langMenu) {
                langMenu.querySelectorAll('[data-lang-value]').forEach((item) => {
                    const value = item.getAttribute('data-lang-value');
                    item.classList.toggle('bg-accent/20', value === langSelect.value);
                    item.classList.toggle('text-accent', value === langSelect.value);
                    item.classList.toggle('text-zinc-200', value !== langSelect.value);
                });
            }
        };

        const closeLanguageMenu = () => {
            if (langMenu) langMenu.classList.add('hidden');
            if (langArrow) langArrow.classList.remove('rotate-180');
            if (langTrigger) langTrigger.classList.remove('border-accent/50');
        };

        const openLanguageMenu = () => {
            if (langMenu) langMenu.classList.remove('hidden');
            if (langArrow) langArrow.classList.add('rotate-180');
            if (langTrigger) langTrigger.classList.add('border-accent/50');
        };

        langSelect.value = currentLang;
        syncLanguageUI();

        if (langTrigger && langMenu) {
            langTrigger.onclick = () => {
                if (langMenu.classList.contains('hidden')) {
                    openLanguageMenu();
                } else {
                    closeLanguageMenu();
                }
            };

            langMenu.querySelectorAll('[data-lang-value]').forEach((item) => {
                item.onclick = () => {
                    const value = item.getAttribute('data-lang-value');
                    if (!value || value === langSelect.value) {
                        closeLanguageMenu();
                        return;
                    }
                    langSelect.value = value;
                    setLanguage(value);
                    renderConfigs();
                    syncLanguageUI();
                    closeLanguageMenu();
                };
            });

            if (!langMenu.dataset.boundOutside) {
                langMenu.dataset.boundOutside = '1';
                document.addEventListener('click', (event) => {
                    const target = event.target;
                    if (!(target instanceof Element)) return;
                    if (!target.closest('#setting-lang-wrap')) {
                        closeLanguageMenu();
                    }
                });
                document.addEventListener('keydown', (event) => {
                    if (event.key === 'Escape') closeLanguageMenu();
                });
            }
        } else {
            langSelect.onchange = () => {
                setLanguage(langSelect.value);
                renderConfigs();
                syncLanguageUI();
            };
        }
    }

    // Load current settings
    const settings = await window.__TAURI__.core.invoke('get_settings');
    if (closeTrayToggle) closeTrayToggle.checked = settings.close_to_tray;
    if (autoUpdateToggle) autoUpdateToggle.checked = settings.auto_update;
    if (autostartToggle) autostartToggle.checked = await isAutoStartEnabled();
    if (nodeScrollToggle) nodeScrollToggle.checked = localStorage.getItem('nodeScroll') === 'true';
    if (customArgsInput) customArgsInput.value = (settings.custom_args || []).join('\n');

    const savedOpacity = localStorage.getItem('appOpacity') || '100';
    if (opacitySlider) {
        opacitySlider.value = savedOpacity;
        if (opacityValText) opacityValText.textContent = `${savedOpacity}%`;
        document.documentElement.style.setProperty('--app-opacity', savedOpacity / 100);
        
        opacitySlider.addEventListener('input', (e) => {
            const val = e.target.value;
            if (opacityValText) opacityValText.textContent = `${val}%`;
            document.documentElement.style.setProperty('--app-opacity', val / 100);
            localStorage.setItem('appOpacity', val);
        });
    }

    if (restoreDefaultsBtn) {
        restoreDefaultsBtn.onclick = async () => {
            const t = translations[currentLang];

            // Show confirmation dialog first
            const confirmed = await showConfirmModal(
                t.restoreDefaultsTitle || "Restore Defaults",
                t.restoreDefaultsConfirm || "Are you sure you want to restore all settings to default values?"
            );
            if (!confirmed) return;

            const errors = [];
            const successItems = [];

            // Helper function to track operation result
            const trackResult = async (name, operation) => {
                try {
                    await operation();
                    successItems.push(name);
                    return true;
                } catch (err) {
                    console.error(`Failed to reset ${name}:`, err);
                    errors.push(`${name}: ${err.message || err}`);
                    return false;
                }
            };

            try {
                // 1. Reset UI-only settings (localStorage)
                if (closeTrayToggle) {
                    closeTrayToggle.checked = true;
                    settings.close_to_tray = true;
                }
                if (autoUpdateToggle) {
                    autoUpdateToggle.checked = false;
                    settings.auto_update = false;
                }
                if (nodeScrollToggle) {
                    nodeScrollToggle.checked = false;
                    localStorage.setItem('nodeScroll', 'false');
                    successItems.push('nodeScroll');
                }
                if (customArgsInput) {
                    customArgsInput.value = '';
                    settings.custom_args = [];
                }

                // 2. Reset autostart (requires system integration)
                if (autostartToggle) {
                    autostartToggle.checked = false;
                    settings.autostart = false;
                    await trackResult('autostart', async () => {
                        await disableAutoStart();
                    });
                }

                // 3. Reset core settings (unified-delay, ipv6, allow-lan)
                if (unifiedDelayToggle) unifiedDelayToggle.checked = true;
                if (ipv6Toggle) ipv6Toggle.checked = false;
                if (allowLanToggle) allowLanToggle.checked = false;

                // 4. Reset DNS rewrite
                const dnsToggle = document.getElementById('dns-rewrite-toggle');
                if (dnsToggle) {
                    dnsToggle.checked = true;
                    localStorage.setItem('dnsRewrite', 'true');
                    await trackResult('dnsRewrite', async () => {
                        await applyDnsRewrite();
                    });
                }

                // 5. Reset opacity
                if (opacitySlider) {
                    opacitySlider.value = '100';
                    localStorage.setItem('appOpacity', '100');
                    if (opacityValText) opacityValText.textContent = '100%';
                    document.documentElement.style.setProperty('--app-opacity', 1);
                    if (appMainContainer) appMainContainer.style.backgroundColor = '';
                    successItems.push('opacity');
                }

                // 6. Clear tunnels
                currentTunnels = [];
                renderTunnels();

                // 7. Save core config (unified-delay, ipv6, allow-lan, tunnels)
                await trackResult('coreConfig', async () => {
                    const result = await saveConfigToCore({
                        'unified-delay': true,
                        ipv6: false,
                        'allow-lan': false,
                        tunnels: []
                    });
                    if (!result) {
                        throw new Error(t.failedSaveSettings || 'Failed to save core settings');
                    }
                });

                // 8. Reset fake client
                const fakeClientToggle = document.getElementById('setting-fake-client');
                if (fakeClientToggle) {
                    fakeClientToggle.checked = true;
                    localStorage.setItem('fakeClientEnabled', _obfuscate('true'));
                    localStorage.removeItem('fakeClientType');
                    localStorage.removeItem('fakeClientCustom');
                    const fakeClientSelect = document.getElementById('fake-client-select');
                    if (fakeClientSelect) fakeClientSelect.value = 'clash-verge/1.6.0';
                    const optionsContainer = document.getElementById('fake-client-options');
                    if (optionsContainer) {
                        optionsContainer.classList.remove('max-h-0', 'opacity-0');
                        optionsContainer.classList.add('max-h-40', 'opacity-100');
                    }
                    successItems.push('fakeClient');
                }

                // 9. Save app settings to disk
                await trackResult('appSettings', async () => {
                    await window.__TAURI__.core.invoke('save_settings', { settings });
                });

                // 10. Reset theme mode
                localStorage.setItem('themeMode', 'auto');
                setThemeMode('auto', false);
                successItems.push('themeMode');

                // 11. Reset theme color
                localStorage.removeItem('appTheme');
                currentTheme = 'zinc';
                applyTheme('zinc');
                document.querySelectorAll('.theme-btn').forEach(b => b.classList.remove('ring-2', 'ring-offset-2', 'ring-offset-zinc-900'));
                const defaultThemeBtn = document.querySelector('.theme-btn[data-theme="zinc"]');
                if (defaultThemeBtn) {
                    defaultThemeBtn.classList.add('ring-2', 'ring-offset-2', 'ring-offset-zinc-900', `ring-zinc-500`);
                }
                successItems.push('themeColor');

                // Show result notification
                if (errors.length === 0) {
                    showNotification(t.settingsRestored || t.restoreDefaultsDesc || "Settings restored to default", "success");
                } else {
                    showNotification(`${t.partialRestore || 'Some settings failed to restore'}: ${errors.join(', ')}`, "warning");
                }
            } catch (err) {
                showNotification(`${t.restoreFailed || 'Failed to restore defaults'}: ${err.message || err}`, 'error');
            }
        };
    }

    // Theme Color Handling
    const applyColorTheme = (themeStr) => {
        applyTheme(themeStr);
    };

    // Theme Mode Handling
    const applyDarkMode = (isDark) => {
        if (isDark) {
            document.documentElement.classList.add('dark');
            if (appTitleIcon) appTitleIcon.src = 'dark-icon.png';
        } else {
            document.documentElement.classList.remove('dark');
            if (appTitleIcon) appTitleIcon.src = 'app-icon.png';
        }
        // Clear possible inline styles from older versions (we now rely on CSS + variables)
        if (appMainContainer) appMainContainer.style.backgroundColor = '';
    };

    const themeModeMap = ['light', 'auto', 'dark'];
    let currentThemeMode = 'auto';
    const systemThemeMedia = window.matchMedia('(prefers-color-scheme: dark)');
    const getStoredThemeMode = () => {
        const savedThemeMode = localStorage.getItem('themeMode');
        if (savedThemeMode && themeModeMap.includes(savedThemeMode)) return savedThemeMode;
        const legacyDarkMode = localStorage.getItem('darkMode');
        if (legacyDarkMode === 'true') return 'dark';
        if (legacyDarkMode === 'false') return 'light';
        return 'auto';
    };
    const resolveThemeModeToDark = (mode) => {
        if (mode === 'dark') return true;
        if (mode === 'light') return false;
        return systemThemeMedia.matches;
    };
    const updateThemeModeUI = (mode) => {
        const idx = themeModeMap.indexOf(mode);
        if (themeModeSlider && idx !== -1) {
            themeModeSlider.style.transform = `translateX(${idx * 100}%)`;
        }
        themeModeButtons.forEach((btn, btnIdx) => {
            if (btnIdx === idx) {
                btn.classList.add('text-zinc-100');
                btn.classList.remove('text-zinc-400');
            } else {
                btn.classList.remove('text-zinc-100');
                btn.classList.add('text-zinc-400');
            }
        });
    };
    const setThemeMode = (mode, persist = true) => {
        if (!themeModeMap.includes(mode)) return;
        currentThemeMode = mode;
        if (persist) {
            localStorage.setItem('themeMode', mode);
            localStorage.removeItem('darkMode');
        }
        updateThemeModeUI(mode);
        applyDarkMode(resolveThemeModeToDark(mode));
    };

    setThemeMode(getStoredThemeMode(), false);

    if (!themeModeContainer?.dataset.bound) {
        if (themeModeContainer) themeModeContainer.dataset.bound = '1';
        themeModeButtons.forEach((btn) => {
            btn.onclick = () => {
                const mode = btn.getAttribute('data-theme-mode');
                if (!mode) return;
                setThemeMode(mode, true);
            };
        });
    }

    const systemThemeListener = (event) => {
        if (currentThemeMode === 'auto') {
            applyDarkMode(event.matches);
        }
    };
    if (typeof systemThemeMedia.addEventListener === 'function') {
        systemThemeMedia.addEventListener('change', systemThemeListener);
    } else if (typeof systemThemeMedia.addListener === 'function') {
        systemThemeMedia.addListener(systemThemeListener);
    }

    applyColorTheme(settings.theme);

    if (customColorInput) {
        customColorInput.onchange = () => {
            const color = customColorInput.value;
            applyColorTheme(color);
            save();
        };
    }

    const save = async () => {
        try {
            const currentSettings = await window.__TAURI__.core.invoke('get_settings');
            currentSettings.close_to_tray = closeTrayToggle.checked;
            currentSettings.auto_update = autoUpdateToggle.checked;
            currentSettings.autostart = autostartToggle.checked;
            currentSettings.theme = currentTheme;
            currentSettings.custom_args = customArgsInput.value.split('\n').filter(a => a.trim() !== '');
            await window.__TAURI__.core.invoke('save_settings', { settings: currentSettings });
        } catch (err) {
            console.error('Failed to save settings:', err);
        }
    };

    closeTrayToggle?.addEventListener('change', save);
    autoUpdateToggle?.addEventListener('change', async () => {
        await save();
        showNotification(translations[currentLang].requireAppRestart || "更改已保存，需重启应用生效", "info");
    });
    autostartToggle?.addEventListener('change', async () => {
        const enabled = autostartToggle.checked;
        try {
            if (enabled) {
                await enableAutoStart();
            } else {
                await disableAutoStart();
            }
            await save();
        } catch (err) {
            autostartToggle.checked = !enabled;
            showNotification(err.toString(), 'error');
        }
    });

    const saveConfigToCore = async (patch) => {
        try {
            const result = await window.__TAURI__.core.invoke('update_config', { patch });
            await syncCoreConfig();
            
            // Show appropriate notification based on hot reload success
            if (result && !result.hot_reload_success) {
                showNotification(result.message || translations[currentLang].requireRestart || "更改已保存，需重启核心生效", "info");
            }
            return true;
        } catch (err) {
            console.error('Failed to save config to core:', err);
            const t = translations[currentLang];
            showNotification(err.toString() || t.failedSaveSettings || 'Failed to save settings to core', 'error');
            return false;
        }
    };

    unifiedDelayToggle?.addEventListener('change', () => {
        saveConfigToCore({ 'unified-delay': unifiedDelayToggle.checked });
        showNotification(translations[currentLang].requireRestart || "更改已保存，需重启核心生效", "info");
    });

    ipv6Toggle?.addEventListener('change', () => {
        saveConfigToCore({ ipv6: ipv6Toggle.checked });
        showNotification(translations[currentLang].requireRestart || "更改已保存，需重启核心生效", "info");
    });

    allowLanToggle?.addEventListener('change', () => {
        saveConfigToCore({ 'allow-lan': allowLanToggle.checked });
        showNotification(translations[currentLang].requireRestart || "更改已保存，需重启核心生效", "info");
    });

    updateGeoBtn?.addEventListener('click', async () => {
        if (isNetworkUpdating) return;
        isNetworkUpdating = true;
        
        const spinner = document.getElementById('geo-spinner');
        spinner?.classList.remove('hidden');
        updateGeoBtn.classList.add('opacity-50', 'pointer-events-none');
        
        showNotification(translations[currentLang].notifGeoUpdating || "Updating Geo databases...");
        
        try {
            await window.__TAURI__.core.invoke('update_geo_data');
            showNotification(translations[currentLang].notifGeoUpdateSuccess || "Geo databases updated and core restarted!", 'success');
            
            const settings = await window.__TAURI__.core.invoke('get_settings');
            const configPath = settings.last_config || 'config.yaml';
            const customArgs = settings.custom_args || [];
            await restartCore(configPath, customArgs);
        } catch (err) {
            showNotification(err.toString(), 'error');
        } finally {
            isNetworkUpdating = false;
            spinner?.classList.add('hidden');
            updateGeoBtn.classList.remove('opacity-50', 'pointer-events-none');
        }
    });

    let currentTunnels = [];

    const renderTunnels = () => {
        if (!tunnelsList) return;
        
        if (!currentTunnels || currentTunnels.length === 0) {
            tunnelsList.innerHTML = '';
            if (tunnelsEmpty) tunnelsList.appendChild(tunnelsEmpty);
            tunnelsEmpty.style.display = 'block';
            return;
        }

        if (tunnelsEmpty) tunnelsEmpty.style.display = 'none';
        tunnelsList.innerHTML = '';

        currentTunnels.forEach((tunnel, index) => {
            const item = document.createElement('div');
            item.className = 'flex items-center justify-between bg-black/20 border border-white/5 rounded-xl p-3 hover:border-white/10 transition-all';
            
            const info = document.createElement('div');
            info.className = 'flex flex-col gap-1';
            
            const topRow = document.createElement('div');
            topRow.className = 'flex items-center gap-2';
            
            const protocolBadge = document.createElement('span');
            protocolBadge.className = 'px-1.5 py-0.5 rounded bg-white/10 text-[9px] font-bold text-zinc-300 uppercase';
            protocolBadge.textContent = tunnel.network.join(', ');
            
            const target = document.createElement('span');
            target.className = 'text-xs font-medium text-zinc-200';
            target.textContent = tunnel.target;
            
            topRow.appendChild(protocolBadge);
            topRow.appendChild(target);
            
            const listen = document.createElement('span');
            listen.className = 'text-[10px] text-zinc-500 font-mono';
            const t = translations[currentLang];
            listen.textContent = `${t.listen || 'Listen'}: ${tunnel.address}`;
            
            info.appendChild(topRow);
            info.appendChild(listen);
            
            const delBtn = document.createElement('button');
            delBtn.className = 'p-1.5 rounded-lg text-zinc-500 hover:text-rose-400 hover:bg-rose-500/10 transition-all';
            delBtn.innerHTML = `<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;
            delBtn.onclick = () => {
                currentTunnels.splice(index, 1);
                saveConfigToCore({ tunnels: currentTunnels });
                renderTunnels();
            };
            
            item.appendChild(info);
            item.appendChild(delBtn);
            tunnelsList.appendChild(item);
        });
    };

    addTunnelBtn?.addEventListener('click', async () => {
        const t = translations[currentLang];
        const customHtml = `
            <div class="space-y-4">
                <div>
                    <label class="block text-[10px] text-zinc-500 uppercase tracking-widest mb-1.5">${t.tunnelProtocol || 'Protocol'}</label>
                    <input type="text" id="tunnel-protocol-input" placeholder="tcp, udp, or tcp,udp" value="tcp,udp" class="w-full bg-black/40 border border-white/5 rounded-xl px-4 py-3 text-xs text-zinc-200 focus:outline-none focus:border-accent/50 transition-all font-mono">
                </div>
                <div>
                    <label class="block text-[10px] text-zinc-500 uppercase tracking-widest mb-1.5">${t.tunnelNetwork || 'Listen Address'}</label>
                    <input type="text" id="tunnel-address-input" placeholder="e.g., 127.0.0.1:6553" class="w-full bg-black/40 border border-white/5 rounded-xl px-4 py-3 text-xs text-zinc-200 focus:outline-none focus:border-accent/50 transition-all font-mono">
                </div>
                <div>
                    <label class="block text-[10px] text-zinc-500 uppercase tracking-widest mb-1.5">${t.tunnelTarget || 'Target Address'}</label>
                    <input type="text" id="tunnel-target-input" placeholder="e.g., 8.8.8.8:53" class="w-full bg-black/40 border border-white/5 rounded-xl px-4 py-3 text-xs text-zinc-200 focus:outline-none focus:border-accent/50 transition-all font-mono">
                </div>
            </div>
        `;

        const contentArea = await showModal(t.addPortForwarding || "Add Port Forwarding", "", "", true, customHtml);
        if (!contentArea) return; // Cancelled

        const protocolStr = contentArea.querySelector('#tunnel-protocol-input').value;
        const address = contentArea.querySelector('#tunnel-address-input').value;
        const target = contentArea.querySelector('#tunnel-target-input').value;

        if (!protocolStr || !address || !target) {
            showNotification(t.valueEmpty || 'Value cannot be empty', 'error');
            return;
        }

        const network = protocolStr.split(',').map(s => s.trim().toLowerCase());
        currentTunnels.push({ network, address, target });
        saveConfigToCore({ tunnels: currentTunnels });
        renderTunnels();
    });

    const loadSettingsFromCore = async () => {
        try {
            const config = await window.__TAURI__.core.invoke('read_config');
            if (unifiedDelayToggle) unifiedDelayToggle.checked = config['unified-delay'] !== false; // Default true as requested
            if (ipv6Toggle) ipv6Toggle.checked = !!config.ipv6;
            if (allowLanToggle) allowLanToggle.checked = !!config['allow-lan'];
            
            if (config.tunnels && Array.isArray(config.tunnels)) {
                currentTunnels = config.tunnels;
            } else {
                currentTunnels = [];
            }
            renderTunnels();
        } catch (err) {
            console.error('Failed to load core config into settings:', err);
        }
    };

    openConfigFolderBtn?.addEventListener('click', async () => {
        try {
            await openConfigFolder();
        } catch (err) {
            showNotification(err.toString(), 'error');
        }
    });

    // Handle Drag and Drop import via Rust backend event
    if (window._dropUnlisten) {
        window._dropUnlisten();
    }
    if (window.__TAURI__ && window.__TAURI__.event) {
        window.__TAURI__.event.listen('profiles-imported', (event) => {
            const importedCount = event.payload;
            if (importedCount > 0) {
                showNotification(`${t.profilesImported?.replace('{count}', importedCount) || `Successfully imported ${importedCount} profile(s)`}`, 'success');
                if (typeof window.refreshConfigs === 'function') {
                    window.refreshConfigs();
                }
                renderConfigs();
            }
        }).then(unlisten => {
            window._dropUnlisten = unlisten;
        }).catch(e => console.warn('Failed to listen for profiles-imported event:', e));
    }

    themeCircles.forEach(circle => {
        circle.onclick = () => {
            const theme = circle.getAttribute('data-theme');
            applyTheme(theme);
            save();
        };
    });
    nodeScrollToggle?.addEventListener('change', () => {
        localStorage.setItem('nodeScroll', nodeScrollToggle.checked);
        renderProxies(); // Re-render to apply/remove scrolling
    });

    // Load current core version
    let currentCoreVersion = "";
    
    // Bind Add Sub Button
    const subAddBtn = document.getElementById('add-sub-btn');
    if (subAddBtn) {
        subAddBtn.onclick = async () => {
            const url = await showModal(translations[currentLang].addSubscription, translations[currentLang].urlPlaceholder || "Subscription URL");
            if (!url) return;
            showNotification(translations[currentLang].notifDownloadingSub || "Downloading subscription...");
            try {
                const userAgent = getSubscriptionUserAgent();
                const name = extractNameFromUrl(url) || 'subscription';
                const invokeArgs = { url, name };
                if (userAgent) {
                    invokeArgs.userAgent = userAgent;
                }
                await window.__TAURI__.core.invoke('download_sub', invokeArgs);
                
                const settings = await window.__TAURI__.core.invoke('get_settings');
                const currentConfig = settings.last_config || 'config.yaml';
                if (name === currentConfig || name === currentConfig + '.yaml') {
                    await reloadConfig();
                }
                
                showNotification(translations[currentLang].notifSubSuccess, 'success');
                renderConfigs();
            } catch (err) {
                showNotification(`${translations[currentLang].notifSubFailed}: ${err}`, 'error');
            }
        };
    }

    // Bind Update All Sub Button
    const updateAllSubBtn = document.getElementById('update-all-sub-btn');
    if (updateAllSubBtn) {
        updateAllSubBtn.onclick = async () => {
            const t = translations[currentLang];
            const configs = await window.__TAURI__.core.invoke('list_configs');
            const subConfigs = configs.filter(c => c.url); // Only those with URL
            
            if (subConfigs.length === 0) {
                showNotification(t.notifNoSubToUpdate, 'info');
                return;
            }

            const icon = updateAllSubBtn.querySelector('svg');
            if (icon) icon.classList.add('animate-spin');
            updateAllSubBtn.classList.add('opacity-50', 'pointer-events-none');
            
            let successCount = 0;
            let failCount = 0;
            showNotification(t.notifUpdateCount.replace('{count}', subConfigs.length));

            for (const config of subConfigs) {
                try {
                    const userAgent = getSubscriptionUserAgent();
                    await window.__TAURI__.core.invoke('download_sub', { url: config.url, name: config.name, userAgent });
                    successCount++;
                } catch (err) {
                    failCount++;
                    console.error(`Failed to update ${config.name}:`, err);
                }
            }

            // Reload once if current config was updated
            const settings = await window.__TAURI__.core.invoke('get_settings');
            const currentConfig = settings.last_config || 'config.yaml';
            const wasCurrentUpdated = subConfigs.some(c => c.name === currentConfig);
            
            if (wasCurrentUpdated && successCount > 0) {
                const customArgs = settings.custom_args || [];
                await restartCore(currentConfig, customArgs);
            }

            if (icon) icon.classList.remove('animate-spin');
            updateAllSubBtn.classList.remove('opacity-50', 'pointer-events-none');
            renderConfigs();

            if (failCount === 0) {
                showNotification(t.notifUpdateAllComplete.replace('{success}', successCount).replace('{fail}', failCount), 'success');
            } else {
                showNotification(t.notifUpdateAllComplete.replace('{success}', successCount).replace('{fail}', failCount), 'info');
            }
        };
    }

    const loadCoreVersion = async () => {
        try {
            currentCoreVersion = await window.__TAURI__.core.invoke('get_core_version');
            if (versionText) versionText.textContent = currentCoreVersion.startsWith('v') ? currentCoreVersion : `v${currentCoreVersion}`;
        } catch (err) {
            console.error('Failed to get core version:', err);
            if (versionText) versionText.textContent = translations[currentLang].unknown || 'Unknown';
        }
    };
    loadCoreVersion();
    loadSettingsFromCore();

    const performCoreUpdate = async (latestVersion, downloadUrl) => {
        const t = translations[currentLang];
        const confirmed = await showConfirmModal(t.notifUpdateFound, latestVersion);
        if (confirmed) {
            showNotification(t.notifUpdating);
            const coreResult = await window.__TAURI__.core.invoke('update_core', { 
                url: downloadUrl
            });
            setBaseUrl(`http://127.0.0.1:${coreResult.port}`);
            setWsBaseUrl(`ws://127.0.0.1:${coreResult.port}`);
            setSecret(coreResult.secret);
            setWsSecret(coreResult.secret);
            
            // Reconnect traffic monitor
            if (window._trafficWsHandle) {
                window._trafficWsHandle.reconnect();
            }

            showNotification(t.notifUpdateSuccess, 'success');
            await loadCoreVersion();
            await syncCoreConfig();
        }
    };

    // Update check
    if (checkUpdateBtn) {
        checkUpdateBtn.onclick = async () => {
            const t = translations[currentLang];
            showNotification(t.notifUpdateCheck);
            try {
                const latest = await window.__TAURI__.core.invoke('get_latest_version');
                const latestVersion = latest.version;
                
                // Compare versions (simple string compare for now as both should be like v1.2.3)
                if (latestVersion === currentCoreVersion) {
                    showNotification(t.notifNoUpdate, 'success');
                    return;
                }

                await performCoreUpdate(latestVersion, latest.download_url);
            } catch (err) {
                showNotification(err.toString(), 'error');
            }
        };
    }

    // Subscriptions
    function extractNameFromUrl(url) {
        try {
            const u = new URL(url);
            // 1. Try name or remark in search params
            const name = u.searchParams.get('name') || u.searchParams.get('remark');
            if (name) return decodeURIComponent(name);
            
            // 2. Try hash
            if (u.hash) {
                const hash = u.hash.substring(1);
                if (hash.includes('remark=')) {
                    return decodeURIComponent(hash.split('remark=')[1].split('&')[0]);
                }
                if (hash.length > 2 && !hash.includes('/')) return decodeURIComponent(hash);
            }
            
            // 3. Try path
            const pathParts = u.pathname.split('/').filter(p => p.length > 0);
            if (pathParts.length > 0) {
                const last = pathParts[pathParts.length - 1];
                const base = last.split('.')[0];
                if (base.length > 2 && base !== 'config' && base !== 'clash') return base;
            }
            
            return u.hostname;
        } catch (e) {
            return null;
        }
    };

    const renderConfigs = async () => {
        if (!configsList) return;
        const configs = await window.__TAURI__.core.invoke('list_configs');
        const settings = await window.__TAURI__.core.invoke('get_settings');
        const currentConfig = settings.last_config || 'config.yaml';
        const customArgs = settings.custom_args || [];
        const t = translations[currentLang];

        configsList.innerHTML = '';
        configs.forEach(configInfo => {
            const name = configInfo.name;
            const isCurrent = name === currentConfig;
            
            const item = document.createElement('div');
            item.className = `glass-card flex flex-col p-4 transition-all group cursor-pointer relative ${isCurrent ? 'ring-1 ring-accent/50 shadow-[0_0_20px_rgba(var(--color-accent-rgb),0.2)]' : 'hover:shadow-lg'}`;
            
            const row = document.createElement('div');
            row.className = "flex items-center justify-between";

            const left = document.createElement('div');
            left.className = 'flex items-center gap-3 pointer-events-none';
            
            const dot = document.createElement('div');
            dot.className = `w-2 h-2 rounded-full ${isCurrent ? 'bg-accent shadow-[0_0_8px_var(--color-accent-glow)]' : 'bg-zinc-700'}`;
            
            const label = document.createElement('span');
            label.className = `text-xs transition-colors ${isCurrent ? 'font-bold text-zinc-100' : 'text-zinc-400'}`;
            label.textContent = name;
            
            left.appendChild(dot);
            left.appendChild(label);
            
            const actions = document.createElement('div');
            actions.className = 'flex items-center gap-2 transition-all opacity-0 group-hover:opacity-100';
            
            // Delete button
            const delBtn = document.createElement('button');
            delBtn.className = 'p-1.5 rounded-md hover:bg-rose-500/20 text-zinc-500 hover:text-rose-400 transition-all';
            delBtn.innerHTML = `<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;
            delBtn.title = t.delete;
            delBtn.onclick = async (e) => {
                e.stopPropagation();
                e.preventDefault();
                
                // Prevent deleting current config
                if (isCurrent) {
                    showNotification(t.cannotDeleteActive || 'Cannot delete the active configuration', 'warning');
                    return;
                }
                
                // Confirm deletion using custom modal
                const confirmed = await showConfirmModal(
                    t.delete || 'Delete',
                    t.confirmDelete || `Are you sure you want to delete "${name}"?`
                );
                if (!confirmed) return;
                
                try {
                    await window.__TAURI__.core.invoke('delete_config', { name });
                    showNotification(t.notifDeleteSuccess, 'success');
                    renderConfigs(); // Immediate refresh, no delay needed
                } catch (err) {
                    showNotification(`${t.notifDeleteFailed}: ${err}`, 'error');
                }
            };

            // Update button (only if has URL)
            if (configInfo.url) {
                const updateBtn = document.createElement('button');
                updateBtn.className = 'p-1.5 rounded-md hover:bg-accent/20 text-zinc-500 hover:text-accent transition-all';
                updateBtn.innerHTML = `<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>`;
                updateBtn.title = t.update;
                updateBtn.onclick = async (e) => {
                    e.stopPropagation();
                    updateBtn.classList.add('animate-spin');
                    try {
                        const userAgent = getSubscriptionUserAgent();
                        await window.__TAURI__.core.invoke('download_sub', { url: configInfo.url, name: configInfo.name, userAgent });
                        if (isCurrent) {
                            // If current config is updated, restart core or dynamically reload
                            const customArgs = settings.custom_args || [];
                            await restartCore(configInfo.name, customArgs);
                        }
                        showNotification(t.notifSubSuccess, 'success');
                        renderConfigs();
                    } catch (err) {
                        showNotification(`${t.notifSubFailed}: ${err}`, 'error');
                    } finally {
                        updateBtn.classList.remove('animate-spin');
                    }
                };
                actions.appendChild(updateBtn);
            }

            actions.appendChild(delBtn);
            
            const switchConfig = async () => {
                if (isCurrent || isNetworkUpdating) return;
                
                isNetworkUpdating = true;
                item.classList.add('opacity-50', 'pointer-events-none');
                
                try {
                    const coreResult = await restartCore(name, customArgs);
                    if (coreResult && coreResult.secret) {
                        showNotification(t.configSuccess, 'success');
                        
                        // Save last_config to settings
                        const s = await window.__TAURI__.core.invoke('get_settings');
                        s.last_config = name;
                        await window.__TAURI__.core.invoke('save_settings', { settings: s });

                        await new Promise(r => setTimeout(r, 1000));
                        await renderConfigs();
                        await renderProxies();
                        await syncCoreConfig();
                        await closeAllConnections();
                    }
                } catch (err) {
                    showNotification(err.toString(), 'error');
                } finally {
                    isNetworkUpdating = false;
                    item.classList.remove('opacity-50', 'pointer-events-none');
                }
            };

            item.onclick = switchConfig;
            
            row.appendChild(left);
            row.appendChild(actions);
            item.appendChild(row);

            // SubInfo (Traffic usage)
            if (configInfo.sub_info) {
                // Parse sub_info string like: upload=245802131; download=1766028122; total=5368709120; expire=1667055411
                const parts = configInfo.sub_info.split(';').map(s => s.trim());
                let upload = 0, download = 0, total = 0;
                parts.forEach(p => {
                    if (p.startsWith('upload=')) upload = parseInt(p.split('=')[1]) || 0;
                    if (p.startsWith('download=')) download = parseInt(p.split('=')[1]) || 0;
                    if (p.startsWith('total=')) total = parseInt(p.split('=')[1]) || 0;
                });
                
                if (total > 0) {
                    const used = upload + download;
                    const percentage = Math.min(100, Math.max(0, (used / total) * 100));
                    
                    const formatBytes = (bytes) => {
                        if (bytes === 0) return '0 B';
                        const k = 1024;
                        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
                        const i = Math.floor(Math.log(bytes) / Math.log(k));
                        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
                    };

                    const usageContainer = document.createElement('div');
                    usageContainer.className = 'mt-3 mb-1 w-full';
                    
                    const textRow = document.createElement('div');
                    textRow.className = 'flex justify-between text-[9px] text-zinc-500 mb-1.5 px-0.5 uppercase tracking-wider font-bold';
                    const t = translations[currentLang];
                    textRow.innerHTML = `<span>${formatBytes(used)} ${t.usedSpace || 'used'}</span><span>${formatBytes(total)} ${t.totalSpace || 'total'}</span>`;
                    
                    const barBg = document.createElement('div');
                    barBg.className = 'h-1.5 w-full bg-black/40 rounded-full overflow-hidden border border-white/5';
                    
                    const barFill = document.createElement('div');
                    barFill.className = `h-full rounded-full transition-all duration-1000 ${percentage > 90 ? 'bg-rose-500' : 'bg-accent'}`;
                    barFill.style.width = `${percentage}%`;
                    
                    barBg.appendChild(barFill);
                    usageContainer.appendChild(textRow);
                    usageContainer.appendChild(barBg);
                    item.appendChild(usageContainer);
                }
            }

            if (configInfo.url) {
                const urlLabel = document.createElement('div');
                urlLabel.className = 'text-[9px] text-zinc-600 truncate mt-1 w-full';
                urlLabel.textContent = configInfo.url;
                item.appendChild(urlLabel);
            }

            configsList.appendChild(item);
        });
    };


    renderConfigs();

    // Auto update check if enabled
    if (settings.auto_update) {
        setTimeout(async () => {
            try {
                const latest = await window.__TAURI__.core.invoke('get_latest_version');
                const latestVersion = latest.version;
                if (latestVersion && currentCoreVersion && latestVersion !== currentCoreVersion) {
                    await performCoreUpdate(latestVersion, latest.download_url);
                }
            } catch (e) {
                console.warn('Auto update check failed:', e);
            }
        }, 5000); // Check 5 seconds after startup to not block UI
    }
    
    initFakeClient();
}

// Simple obfuscation for localStorage sensitive data
const _obfKey = 'Zephyr2024';
function _obfuscate(str) {
    if (!str) return str;
    try {
        const encoded = Array.from(str).map((c, i) => 
            String.fromCharCode(c.charCodeAt(0) ^ _obfKey.charCodeAt(i % _obfKey.length))
        ).join('');
        return 'obf:' + btoa(encoded);
    } catch { return str; }
}
function _deobfuscate(str) {
    if (!str) return str;
    if (!str.startsWith('obf:')) return str; // backward compatible with plain text
    try {
        const decoded = atob(str.slice(4));
        return Array.from(decoded).map((c, i) =>
            String.fromCharCode(c.charCodeAt(0) ^ _obfKey.charCodeAt(i % _obfKey.length))
        ).join('');
    } catch { return str; }
}

function initFakeClient() {
    const toggle = document.getElementById('setting-fake-client');
    const optionsContainer = document.getElementById('fake-client-options');
    const select = document.getElementById('fake-client-select');
    const customContainer = document.getElementById('fake-client-custom-container');
    const customInput = document.getElementById('fake-client-custom');
    const spinner = document.getElementById('fake-client-spinner');

    if (!toggle || !optionsContainer || !select || !customInput) return;

    let isFetching = false;
    let versionsFetched = false;

    // Load from local storage with deobfuscation
    const storedEnabled = localStorage.getItem('fakeClientEnabled');
    const savedEnabled = storedEnabled === null ? true : _deobfuscate(storedEnabled) === 'true';
    
    // Ensure initial state is persisted if not exists
    if (storedEnabled === null) {
        localStorage.setItem('fakeClientEnabled', _obfuscate('true'));
    }
    
    // Set default value if not set
    if (!localStorage.getItem('fakeClientType')) {
        localStorage.setItem('fakeClientType', _obfuscate('clash-verge/1.6.0'));
    }
    
    const savedType = _deobfuscate(localStorage.getItem('fakeClientType')) || 'clash-verge/1.6.0';
    const savedCustom = _deobfuscate(localStorage.getItem('fakeClientCustom')) || '';

    toggle.checked = savedEnabled;
    select.value = savedType;
    if (!select.value) select.value = 'custom'; // fallback if option not found
    customInput.value = savedCustom;

    const updateVisibility = () => {
        if (toggle.checked) {
            optionsContainer.classList.remove('max-h-0', 'opacity-0');
            optionsContainer.classList.add('max-h-40', 'opacity-100');
            if (select.value === 'custom') {
                customContainer.classList.remove('hidden');
            } else {
                customContainer.classList.add('hidden');
            }
            if (!versionsFetched) {
                fetchLatestVersions();
            }
        } else {
            optionsContainer.classList.remove('max-h-40', 'opacity-100');
            optionsContainer.classList.add('max-h-0', 'opacity-0');
            setTimeout(() => customContainer.classList.add('hidden'), 300);
        }
    };

    const fetchLatestVersions = async () => {
        if (isFetching || versionsFetched) return;
        isFetching = true;
        select.disabled = true;
        spinner.classList.remove('hidden');

        try {
            const versions = await window.__TAURI__.core.invoke('get_latest_client_versions');
            
            // Update options
            select.querySelector('option[value^="clash-verge"]').value = versions.verge;
            select.querySelector('option[value^="clash-verge"]').textContent = `Clash Verge Rev (${versions.verge})`;
            
            select.querySelector('option[value^="mihomo-party"]').value = versions.mihomo_party;
            select.querySelector('option[value^="mihomo-party"]').textContent = `mihomo-party (${versions.mihomo_party})`;
            
            select.querySelector('option[value^="Flclash"]').value = versions.flclash;
            select.querySelector('option[value^="Flclash"]').textContent = `Flclash (${versions.flclash})`;

            // Reselect based on previous choice if possible
            if (savedType && savedType.startsWith('clash-verge')) select.value = versions.verge;
            else if (savedType && savedType.startsWith('mihomo-party')) select.value = versions.mihomo_party;
            else if (savedType && savedType.startsWith('Flclash')) select.value = versions.flclash;
            else select.value = savedType;

            versionsFetched = true;
        } catch (err) {
            console.error('Failed to fetch latest client versions:', err);
        } finally {
            isFetching = false;
            select.disabled = false;
            spinner.classList.add('hidden');
            
            // Re-check visibility in case it was changed during fetch
            updateVisibility();
        }
    };

    toggle.addEventListener('change', () => {
        localStorage.setItem('fakeClientEnabled', _obfuscate(toggle.checked.toString()));
        updateVisibility();
        if (!toggle.checked) {
            const t = translations[currentLang];
            showNotification(t.fakeClientWarning || "Warning: Disabling this may cause incorrect config format from subscriptions.", "warning");
        }
    });

    select.addEventListener('change', () => {
        localStorage.setItem('fakeClientType', _obfuscate(select.value));
        updateVisibility();
    });

    customInput.addEventListener('input', () => {
        localStorage.setItem('fakeClientCustom', _obfuscate(customInput.value));
    });

    // Initial setup
    if (savedEnabled) {
        optionsContainer.style.transition = 'none'; // skip animation on load
        updateVisibility();
        setTimeout(() => optionsContainer.style.transition = '', 50);
    }
}

function getFakeClientUA() {
    const storedEnabled = localStorage.getItem('fakeClientEnabled');
    const enabled = _deobfuscate(storedEnabled) === 'true';
    if (!enabled) return null;
    
    const type = _deobfuscate(localStorage.getItem('fakeClientType'));
    if (type === 'custom') {
        const custom = _deobfuscate(localStorage.getItem('fakeClientCustom'));
        return custom ? custom : null;
    }
    return type || null;
}

function getSubscriptionUserAgent() {
    // Return null when fake client is disabled, so backend will use default Zephyr UA
    return getFakeClientUA();
}

// --- Window Controls ---
export function initWindowControls() {
    const closeBtn = document.getElementById('close-btn');
    if (closeBtn) {
        closeBtn.addEventListener('click', () => {
            window.__TAURI__.window.getCurrentWindow().close();
        });
    }

    // 图片加载失败后的 fallback 处理（替代 HTML 内联 onerror）
    const coreLoadingIcon = document.getElementById('core-loading-icon');
    if (coreLoadingIcon) {
        coreLoadingIcon.addEventListener('error', function() {
            this.src = 'dark-icon.png';
        }, { once: true });
    }

    const appTitleIcon = document.getElementById('app-title-icon');
    if (appTitleIcon) {
        appTitleIcon.addEventListener('error', function() {
            this.src = 'app-icon.png';
        }, { once: true });
    }
}

// --- System Proxy Logic ---
let _traySyncInterval = null;
let _trayEventListener = null;

export async function updateTrayStatus() {
    const tunToggle = document.getElementById('tun-proxy-toggle');
    const sysProxyToggle = document.getElementById('sys-proxy-toggle');

    const mode = tunToggle?.checked ? 'tun' : (sysProxyToggle?.checked ? 'sysproxy' : 'default');

    try {
        await window.__TAURI__.core.invoke('change_tray_icon', { mode });
    } catch (err) {
        console.error('Failed to update tray icon:', err);
    }
}

/// Update the full tray menu with current state
export async function updateTrayMenu() {
    console.log('[Tray] updateTrayMenu called');
    const t = translations[currentLang];
    const tunToggle = document.getElementById('tun-proxy-toggle');
    const sysProxyToggle = document.getElementById('sys-proxy-toggle');
    
    const sysProxyEnabled = sysProxyToggle?.checked || false;
    const tunEnabled = tunToggle?.checked || false;
    
    console.log('[Tray] sysProxyEnabled:', sysProxyEnabled, 'tunEnabled:', tunEnabled);
    
    // Get current mode
    const config = await getConfig();
    const currentMode = config?.mode || 'rule';
    console.log('[Tray] currentMode:', currentMode);
    
    // Get subscription list
    let configs = [];
    try {
        configs = await window.__TAURI__.core.invoke('list_configs');
        const settings = await window.__TAURI__.core.invoke('get_settings');
        const activeConfig = settings.last_config || 'config.yaml';
        configs = configs.map(c => ({
            name: c.name,
            is_active: c.name === activeConfig
        }));
        console.log('[Tray] configs:', configs);
    } catch (e) {
        console.warn('Failed to get configs for tray menu:', e);
    }
    
    // Get proxy groups
    let proxyGroups = [];
    try {
        const data = await getProxies();
        if (data && data.proxies) {
            // Find selector/select type groups
            const groupNames = Object.keys(data.proxies).filter(name => {
                const type = data.proxies[name].type?.toLowerCase() || '';
                return type === 'selector' || type === 'select';
            });
            
            proxyGroups = groupNames.slice(0, 5).map(groupName => {
                const group = data.proxies[groupName];
                return {
                    name: groupName,
                    type: group.type,  // Use 'type' to match Rust struct
                    now: group.now || '',
                    proxies: (group.all || []).slice(0, 20).map(proxyName => ({
                        name: proxyName,
                        alive: data.proxies[proxyName]?.alive
                    }))
                };
            });
            console.log('[Tray] proxyGroups:', proxyGroups);
        }
    } catch (e) {
        console.warn('Failed to get proxy groups for tray menu:', e);
    }
    
    try {
        console.log('[Tray] Calling update_tray_full_menu...');
        await window.__TAURI__.core.invoke('update_tray_full_menu', {
            showText: t.trayShow || "Show Zephyr",
            quitText: t.trayQuit || "Quit",
            sysProxyText: t.traySysProxy || "System Proxy",
            tunText: t.trayTunMode || "TUN Mode",
            ruleText: t.rule || "Rule",
            globalText: t.global || "Global",
            directText: t.direct || "Direct",
            subscriptionsText: t.traySubscriptions || "Subscriptions",
            proxiesText: t.trayProxies || "Proxies",
            sysProxyEnabled,
            tunEnabled,
            configs,
            proxyGroups,
            currentMode
        });
        console.log('[Tray] update_tray_full_menu completed successfully');
    } catch (err) {
        console.error('Failed to update tray menu:', err);
    }
}

/// Initialize tray event listeners
export function initTrayEventListeners() {
    if (_trayEventListener) return; // Already initialized
    
    const { listen } = window.__TAURI__.event;
    
    // Listen for sys proxy toggle from tray
    listen('tray-sysproxy-changed', async (event) => {
        const enabled = event.payload;
        const toggle = document.getElementById('sys-proxy-toggle');
        const statusText = document.getElementById('proxy-status-text');
        
        if (toggle) {
            toggle.checked = enabled;
        }
        
        try {
            const currentConfig = await getConfig();
            const currentPort = currentConfig?.['mixed-port'] || currentConfig?.port || currentConfig?.['socks-port'] || 7890;
            
            if (enabled) {
                await window.__TAURI__.core.invoke('enable_sysproxy', { 
                    server: `127.0.0.1:${currentPort}`,
                    bypass: null 
                });
            } else {
                await window.__TAURI__.core.invoke('disable_sysproxy');
            }
            
            updateSysProxyUI();
            await updateTrayMenu();
        } catch (err) {
            console.error('Failed to toggle sys proxy from tray:', err);
            if (toggle) toggle.checked = !enabled;
        }
    });
    
    // Listen for TUN toggle from tray
    listen('tray-tun-changed', async (event) => {
        const enabled = event.payload;
        const toggle = document.getElementById('tun-proxy-toggle');
        
        if (toggle) {
            toggle.checked = enabled;
            // Trigger the change handler
            toggle.dispatchEvent(new Event('change'));
        }
    });
    
    // Listen for mode change from tray
    listen('tray-mode-changed', async (event) => {
        const mode = event.payload;
        const buttons = document.querySelectorAll('[data-mode]');
        
        buttons.forEach(btn => {
            if (btn.getAttribute('data-mode') === mode) {
                btn.click();
            }
        });
    });
    
    // Listen for subscription change from tray
    listen('tray-subscription-changed', async (event) => {
        const subName = event.payload;
        const t = translations[currentLang];
        
        try {
            showNotification(`${t.notifSwitchTo || 'Switched to'} ${subName}`, 'info');
            
            // Get current custom args
            const settings = await window.__TAURI__.core.invoke('get_settings');
            const customArgs = settings.custom_args || [];
            
            // Restart core with new config
            const coreResult = await restartCore(subName, customArgs);
            if (coreResult && coreResult.secret) {
                // Save last_config to settings
                settings.last_config = subName;
                await window.__TAURI__.core.invoke('save_settings', { settings });
                
                await new Promise(r => setTimeout(r, 500));
                await syncCoreConfig();
                await closeAllConnections();
                await updateTrayMenu();
            }
        } catch (err) {
            console.error('Failed to switch subscription from tray:', err);
            showNotification(err.toString(), 'error');
        }
    });
    
    // Listen for proxy change from tray
    listen('tray-proxy-changed', async (event) => {
        const { group, proxy } = event.payload;
        
        try {
            const success = await switchProxy(group, proxy);
            if (success) {
                await closeAllConnections();
                await syncCoreConfig();
                
                const currentNodeEl = document.getElementById('current-node-name');
                if (currentNodeEl) currentNodeEl.textContent = proxy;
                
                if (document.querySelector('[data-page="proxies"]').classList.contains('hidden') === false) {
                    renderProxies();
                }
            }
        } catch (err) {
            console.error('Failed to switch proxy from tray:', err);
        }
    });
    
    _trayEventListener = true;
}

/// Start periodic tray status synchronization to ensure UI and tray stay in sync
export function startTraySync() {
    // Clear any existing interval
    if (_traySyncInterval) {
        clearInterval(_traySyncInterval);
    }
    
    // Sync every 10 seconds
    _traySyncInterval = setInterval(async () => {
        try {
            const actualMode = await window.__TAURI__.core.invoke('get_tray_status');
            const tunToggle = document.getElementById('tun-proxy-toggle');
            const sysProxyToggle = document.getElementById('sys-proxy-toggle');
            
            const expectedMode = tunToggle?.checked ? 'tun' : (sysProxyToggle?.checked ? 'sysproxy' : 'default');
            
            // If modes don't match, update the tray
            if (actualMode !== expectedMode) {
                await updateTrayStatus();
            }
        } catch (e) {
            console.error('Tray sync error:', e);
        }
    }, 10000); // 10 second interval
}

export async function initProxyToggle() {
    const toggle = document.getElementById('sys-proxy-toggle');
    const statusText = document.getElementById('proxy-status-text');
    
    if (!toggle || !statusText) return;

    // Fetch initial status
    try {
        const isEnabled = await window.__TAURI__.core.invoke('get_sys_proxy');
        toggle.checked = isEnabled;
        updateSysProxyUI();
        await updateTrayStatus();
        
        // Poll for real sys proxy state periodically
        if (window._sysProxyPollInterval) {
            clearInterval(window._sysProxyPollInterval);
        }
        window._sysProxyPollInterval = setInterval(async () => {
            try {
                const realState = await window.__TAURI__.core.invoke('get_sys_proxy');
                if (toggle.checked !== realState) {
                    toggle.checked = realState;
                    updateSysProxyUI();
                    await updateTrayStatus();
                }
            } catch(e) {}
        }, 10000); // Check every 10 seconds instead of 5
    } catch (err) {
        console.error('Failed to get initial sys proxy status:', err);
    }
    
    toggle.addEventListener('change', async (e) => {
        const enabled = e.target.checked;
        
        try {
            const currentConfig = await getConfig();
            const currentPort = currentConfig?.['mixed-port'] || currentConfig?.port || currentConfig?.['socks-port'] || 7890;

            if (enabled) {
                await window.__TAURI__.core.invoke('enable_sysproxy', { 
                    server: `127.0.0.1:${currentPort}`,
                    bypass: null 
                });
            } else {
                await window.__TAURI__.core.invoke('disable_sysproxy');
            }
            
            updateSysProxyUI();
            await updateTrayStatus();
        } catch (err) {
            console.error('Failed to set sys proxy:', err);
            showNotification(`${translations[currentLang].errorPrefix || 'Error'}: ${err}`, 'error');
            toggle.checked = !enabled;
            await updateTrayStatus();
        }
    });
}

// --- Mode & TUN Logic ---
const DNS_REWRITE_PAYLOAD = {
  "sniffing": true,
  "dns": {
    "enable": true,
    "listen": "0.0.0.0:1053",
    "ipv6": false,
    "enhanced-mode": "fake-ip",
    "fake-ip-range": "198.18.0.1/16",
    "fake-ip-filter":["*.lan", "localhost.ptlogin2.qq.com"],
    "nameserver":[
      "https://doh.pub/dns-query",
      "https://dns.alidns.com/dns-query"
    ],
    "fallback":[
      "https://dns.cloudflare.com/dns-query",
      "https://dns.google/dns-query"
    ]
  }
};

let wheelHoverTimer = null;
let isWheelOpen = false;

export function initNodeWheel() {
    const trigger = document.getElementById('node-wheel-trigger');
    const dropdown = document.getElementById('node-wheel-dropdown');
    const scrollContainer = document.getElementById('node-wheel-scroll');
    const list = document.getElementById('node-wheel-list');
    const container = document.getElementById('node-wheel-container');

    if (!trigger || !dropdown || !list || !container) return;

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let defaultActiveItem = null;
    let hoveredItem = null;

    const getCurrentNodeForGroup = async (groupName) => {
        const data = await getProxies();
        return data?.proxies?.[groupName]?.now || null;
    };

    const waitForCurrentNode = async (groupName, expectedName, maxRetries = 10, intervalMs = 250) => {
        for (let i = 0; i < maxRetries; i++) {
            const current = await getCurrentNodeForGroup(groupName);
            if (!expectedName) return current;
            if (current === expectedName) return current;
            await sleep(intervalMs);
        }
        // Fallback: return whatever the core reports finally (or expected).
        const finalCurrent = await getCurrentNodeForGroup(groupName);
        return finalCurrent || expectedName;
    };

    const getWheelItems = () => Array.from(list.children);

    const findCenterItem = () => {
        const items = getWheelItems();
        if (!items.length || !scrollContainer) return null;
        const rect = scrollContainer.getBoundingClientRect();
        const centerY = rect.top + rect.height / 2;
        let nearest = items[0];
        let minDistance = Number.MAX_SAFE_INTEGER;
        items.forEach((item) => {
            const itemRect = item.getBoundingClientRect();
            const itemCenterY = itemRect.top + itemRect.height / 2;
            const distance = Math.abs(itemCenterY - centerY);
            if (distance < minDistance) {
                minDistance = distance;
                nearest = item;
            }
        });
        return nearest;
    };

    const updateWheelVisualState = (activeItem, animateFromCenter = false) => {
        const items = getWheelItems();
        if (!items.length || !activeItem) return;
        const activeIndex = Math.max(0, items.indexOf(activeItem));
        items.forEach((item, index) => {
            const distance = index - activeIndex;
            const absDistance = Math.abs(distance);
            const scale = absDistance === 0 ? 1.1 : Math.max(0.85, 0.98 - absDistance * 0.05);
            const translateY = distance * 8;
            const opacity = absDistance > 4 ? 0.3 : 1 - Math.min(absDistance * 0.15, 0.6);
            item.style.zIndex = `${100 - absDistance}`;
            if (animateFromCenter) {
                item.style.transform = 'translateY(0px) scale(0.86)';
                item.style.opacity = '0';
                requestAnimationFrame(() => {
                    setTimeout(() => {
                        item.style.transform = `translateY(${translateY}px) scale(${scale})`;
                        item.style.opacity = `${opacity}`;
                    }, absDistance * 12);
                });
                return;
            }
            item.style.transform = `translateY(${translateY}px) scale(${scale})`;
            item.style.opacity = `${opacity}`;
            const textSpan = item.querySelector('span');
            if (textSpan) {
                textSpan.style.fontSize = `${12 / scale}px`;
            }
        });
    };

    const resetToCenterFocus = () => {
        defaultActiveItem = findCenterItem() || defaultActiveItem || list.firstElementChild;
        hoveredItem = null;
        if (defaultActiveItem) {
            updateWheelVisualState(defaultActiveItem, false);
        }
    };

    const openWheel = async () => {
        if (isWheelOpen) return;
        isWheelOpen = true;

        // Fetch and render nodes
        try {
            const proxyGroupsResult = await fetchProxyGroups();
            if (!proxyGroupsResult) return;

            const { data, mainGroup, current } = proxyGroupsResult;
            let proxies = [...proxyGroupsResult.proxies];

            // Sort by latency
            sortProxiesByLatency(proxies, data);

            const fragment = document.createDocumentFragment();
            let currentEl = null;

            // Use content-visibility instead of IntersectionObserver
            const createWheelItem = (idxStr, wrapper) => {
                const index = parseInt(idxStr, 10);
                const name = proxies[index];
                const proxy = data.proxies[name];
                const isSelected = name === current;
                
                const item = document.createElement('div');
                item.className = `px-3 py-1.5 rounded-full border flex items-center justify-center gap-2 cursor-pointer transition-all duration-200 w-full h-full
                    ${isSelected ? 'bg-white/20 border-accent shadow-[0_0_15px_rgba(255,255,255,0.15)] text-white' : 'bg-black/40 border-white/5 text-zinc-400 hover:bg-white/10 hover:text-white'}`;
                
                const dot = document.createElement('div');
                dot.className = `w-1.5 h-1.5 rounded-full ${isSelected ? 'bg-accent animate-pulse' : (proxy.udp ? 'bg-green-500' : 'bg-zinc-600')}`;
                
                const nameSpan = document.createElement('span');
                nameSpan.className = "text-xs font-semibold tracking-wide truncate max-w-[180px]";
                nameSpan.textContent = name;

                item.appendChild(dot);
                item.appendChild(nameSpan);

                item.addEventListener('mouseenter', () => {
                    hoveredItem = wrapper; // use wrapper for visuals
                    updateWheelVisualState(wrapper, false);
                });
                item.addEventListener('mouseleave', () => {
                    hoveredItem = null;
                    resetToCenterFocus();
                });

                item.onclick = async () => {
                    if (isSelected) {
                        closeWheel();
                        return;
                    }
                    trigger.querySelector('#current-node-name').textContent = translations[currentLang].switching || "Switching...";
                    closeWheel();
                    abortLatencyTests();
                    const success = await switchProxy(mainGroup, name);
                    if (success) {
                        await closeAllConnections();
                        const updatedNode = await waitForCurrentNode(mainGroup, name);

                        await syncCoreConfig().catch(() => {});

                        const currentNodeEl = document.getElementById('current-node-name');
                        if (currentNodeEl) currentNodeEl.textContent = updatedNode || name;

                        if (document.querySelector('[data-page="proxies"]').classList.contains('hidden') === false) {
                            renderProxies();
                        }
                    } else {
                        await syncCoreConfig();
                        const revertedNode = await waitForCurrentNode(mainGroup, null);
                        const currentNodeEl = document.getElementById('current-node-name');
                        if (currentNodeEl && revertedNode) currentNodeEl.textContent = revertedNode;
                    }
                };
                return item;
            };

            proxies.forEach((name, index) => {
                const isSelected = name === current;
                const wrapper = document.createElement('div');
                wrapper.dataset.index = index;
                wrapper.className = 'w-full shrink-0 flex items-center justify-center';
                wrapper.style.height = '32px';
                wrapper.style.scrollSnapAlign = 'center';
                wrapper.style.transformOrigin = 'center center';
                wrapper.style.transition = 'transform 220ms cubic-bezier(0.23, 1, 0.32, 1), opacity 220ms ease, box-shadow 220ms ease';
                wrapper.style.contentVisibility = 'auto';
                wrapper.style.containIntrinsicSize = '32px';
                
                const item = createWheelItem(index.toString(), wrapper);
                wrapper.appendChild(item);
                
                fragment.appendChild(wrapper);
                if (isSelected) currentEl = wrapper;
            });

            if (list._virtObserver) {
                list._virtObserver.disconnect();
            }

            list.innerHTML = '';
            list.appendChild(fragment);

            // Show dropdown
            dropdown.classList.remove('opacity-0', 'pointer-events-none');
            dropdown.style.transform = 'translateY(0) scale(1)';
            trigger.style.opacity = '0';
            trigger.style.pointerEvents = 'none';

            // Scroll to current
            if (currentEl) {
                // Remove smooth scroll temporarily for instant jump
                scrollContainer.style.scrollBehavior = 'auto';
                currentEl.scrollIntoView({ block: 'center' });
                // Restore smooth scroll
                setTimeout(() => { scrollContainer.style.scrollBehavior = 'smooth'; }, 50);
            }
            defaultActiveItem = currentEl || list.firstElementChild;
            hoveredItem = null;
            if (defaultActiveItem) {
                updateWheelVisualState(defaultActiveItem, true);
            }
        } catch (err) {
            console.error('Failed to load wheel nodes:', err);
        }
    };

    const closeWheel = () => {
        if (!isWheelOpen) return;
        isWheelOpen = false;
        dropdown.classList.add('opacity-0', 'pointer-events-none');
        dropdown.style.transform = 'translateY(0) scale(0.92)';
        trigger.style.opacity = '1';
        trigger.style.pointerEvents = 'auto';
        hoveredItem = null;
        clearTimeout(wheelHoverTimer);
    };

    trigger.addEventListener('mouseenter', () => {
        clearTimeout(wheelHoverTimer);
        wheelHoverTimer = setTimeout(() => {
            openWheel();
        }, 300);
    });

    trigger.addEventListener('click', () => {
        clearTimeout(wheelHoverTimer);
        openWheel();
    });

    if (scrollContainer) {
        let scrollFocusTimer = null;
        scrollContainer.addEventListener('scroll', () => {
            if (hoveredItem) return;
            clearTimeout(scrollFocusTimer);
            scrollFocusTimer = setTimeout(() => {
                resetToCenterFocus();
            }, 60);
        });
    }

    // When wheel dropdown is open, prevent underlying pages from scrolling.
    if (!window._wheelListenerAdded) {
        document.addEventListener('wheel', (e) => {
            if (!isWheelOpen) return;
            e.preventDefault();
            e.stopPropagation();

            if (scrollContainer && scrollContainer.contains(e.target)) {
                scrollContainer.scrollTop += e.deltaY;
            }
        }, { passive: false });
        window._wheelListenerAdded = true;
    }

    container.addEventListener('mouseleave', () => {
        clearTimeout(wheelHoverTimer);
        closeWheel();
    });
}

export async function applyDnsRewrite() {
    try {
        await patchConfig(DNS_REWRITE_PAYLOAD);
        await persistConfigChanges(DNS_REWRITE_PAYLOAD);
        return true;
    } catch (err) {
        console.error('[Core] Failed to apply DNS rewrite:', err);
        throw err;
    }
}

function deepMerge(target, source) {
    if (typeof target !== 'object' || target === null) return source;
    if (typeof source !== 'object' || source === null) return source;
    if (Array.isArray(target) && Array.isArray(source)) return source; // Or merge arrays if needed

    for (const key in source) {
        if (Object.prototype.hasOwnProperty.call(source, key)) {
            if (typeof source[key] === 'object' && source[key] !== null && !Array.isArray(source[key])) {
                target[key] = deepMerge(target[key] || {}, source[key]);
            } else {
                target[key] = source[key];
            }
        }
    }
    return target;
}

export async function persistConfigChanges(payload) {
    try {
        const activeConfig = await getActiveConfigContent();
        if (!activeConfig) return false;
        const { configName, content } = activeConfig;
        
        if (typeof jsyaml === 'undefined') return false;
        
        const config = jsyaml.load(content) || {};
        
        deepMerge(config, payload);
        
        const newYaml = jsyaml.dump(config, { indent: 2, lineWidth: -1 });
        await window.__TAURI__.core.invoke('write_config_file', { configPath: configName, content: newYaml });
        return true;
    } catch (err) {
        console.error('[Core] Failed to persist config:', err);
        throw err;
    }
}

export async function initDnsRewriteToggle() {
    const toggle = document.getElementById('dns-rewrite-toggle');
    if (!toggle) return;

    try {
        const config = await getConfig();
        const isEnabled = config?.dns?.enable === true;
        toggle.checked = isEnabled;
    } catch (e) {
        const savedState = localStorage.getItem('dnsRewrite');
        toggle.checked = savedState === null ? true : savedState === 'true';
    }

    toggle.addEventListener('change', async (e) => {
        const enabled = e.target.checked;
        const t = translations[currentLang];
        
        if (enabled) {
            try {
                await applyDnsRewrite();
                await closeAllConnections();
                localStorage.setItem('dnsRewrite', 'true');
                showNotification(t.notifDnsEnabled, 'success');
            } catch (err) {
                const t = translations[currentLang];
                showNotification(t.dnsEnableFailed || 'Failed to enable DNS Rewrite', 'error');
                toggle.checked = false;
            }
        } else {
            try {
                const payload = { dns: { enable: false }, sniffing: false };
                await patchConfig(payload);
                await persistConfigChanges(payload);
                await closeAllConnections();
                localStorage.setItem('dnsRewrite', 'false');
                showNotification(t.notifDnsDisabled, 'info');
            } catch (err) {
                console.error('[Core] Failed to disable DNS rewrite:', err);
                const t = translations[currentLang];
                showNotification(t.dnsDisableFailed || 'Failed to disable DNS Rewrite', 'error');
                toggle.checked = true;
            }
        }
    });
}

export function initModeSelector() {
    const buttons = document.querySelectorAll('[data-mode]');
    const container = document.getElementById('mode-selector-container');

    buttons.forEach((btn) => {
        btn.onclick = async () => {
            if (isNetworkUpdating) return;
            
            const mode = btn.getAttribute('data-mode');
            const t = translations[currentLang];
            
            isNetworkUpdating = true;
            if (container) container.classList.add('opacity-50', 'cursor-not-allowed');
            showNotification(t.configuring);

            try {
                // 1. 获取切换前的节点 (为了继承)
                let nodeToInherit = null;
                try {
                    const resultBefore = await fetchProxyGroups();
                    if (resultBefore) {
                        nodeToInherit = resultBefore.current;
                    }
                } catch (e) { console.warn("Failed to capture node for inheritance", e); }

                // 2. 切换模式
                await patchConfig({ mode });
                await persistConfigChanges({ mode });
                updateModeUI(mode);
                await closeAllConnections();

                // 3. 尝试在目标模式中继承节点
                if (nodeToInherit && mode !== 'direct') {
                    const resultAfter = await fetchProxyGroups();
                    if (resultAfter && resultAfter.proxies.includes(nodeToInherit)) {
                        await switchProxy(resultAfter.mainGroup, nodeToInherit);
                    }
                }

                await renderProxies();
                showNotification(t.configSuccess, 'success');

                isNetworkUpdating = false;
                if (container) container.classList.remove('opacity-50', 'cursor-not-allowed');
            } catch (err) {
                showNotification(err.toString(), 'error');
                isNetworkUpdating = false;
                if (container) container.classList.remove('opacity-50', 'cursor-not-allowed');
            }
        };
    });
}

function updateModeUI(mode) {
    const buttons = document.querySelectorAll('[data-mode]');
    const slider = document.getElementById('mode-slider');
    const modes = ['rule', 'global', 'direct'];
    const idx = modes.indexOf(mode.toLowerCase());

    if (idx !== -1 && slider) {
        slider.style.transform = `translateX(${idx * 100}%)`;
        buttons.forEach((b, i) => {
            if (i === idx) {
                b.classList.add('text-zinc-100');
                b.classList.remove('text-zinc-400');
            } else {
                b.classList.remove('text-zinc-100');
                b.classList.add('text-zinc-400');
            }
        });
    }
}

export function initTunToggle() {
    const toggle = document.getElementById('tun-proxy-toggle');
    const statusText = document.getElementById('tun-status-text');
    const spinner = document.getElementById('tun-spinner');
    if (!toggle) return;

    toggle.onchange = async () => {
        if (isNetworkUpdating) {
            toggle.checked = !toggle.checked;
            return;
        }

        const enable = toggle.checked;
        const t = translations[currentLang];
        const isMac = navigator.platform.toLowerCase().includes('mac');
        isNetworkUpdating = true;

        // Show loading state
        if (spinner) spinner.classList.remove('hidden');
        if (statusText) {
            statusText.textContent = t.configuringTun;
            statusText.classList.add('text-purple-400');
        }

        try {
            // On macOS, handle TUN mode with root privileges
            if (isMac) {
                if (enable) {
                    // Enable TUN: restart core with root (backend will update config)
                    console.log('[TUN] starting mac tun flow');
                    try {
                        console.log('[TUN] calling restart_core_as_root_cmd with enableTun=true');
                        await window.__TAURI__.core.invoke('restart_core_as_root_cmd', { enableTun: true });
                        console.log('[TUN] restart success');
                    } catch (authErr) {
                        console.error('[TUN] authErr:', authErr);
                        if (authErr === 'canceled') {
                            showNotification(t.tunAuthCanceled || 'Authorization canceled', 'error');
                        } else if (authErr === 'root_start_failed') {
                            // Root process failed to start, recover with regular user
                            showNotification(t.tunStartFailed || 'TUN failed to start, recovering...', 'error');
                            try {
                                const settings = await window.__TAURI__.core.invoke('get_settings');
                                const currentConfig = settings.last_config || 'config.yaml';
                                const customArgs = settings.custom_args || [];
                                await restartCore(currentConfig, customArgs);
                            } catch (recoverErr) {
                                console.error('[TUN] recovery failed:', recoverErr);
                            }
                        } else {
                            showNotification(t.tunAuthFailed || 'Authorization failed', 'error');
                        }
                        toggle.checked = false;
                        if (spinner) spinner.classList.add('hidden');
                        if (statusText) {
                            statusText.textContent = t.virtualAdapter;
                            statusText.classList.remove('text-purple-400');
                        }
                        isNetworkUpdating = false;
                        return;
                    }
                } else {
                    // Disable TUN: write config then restart as regular user (no root needed)
                    console.log('[TUN] disabling TUN on mac');
                    try {
                        // Write TUN disabled to config file
                        await window.__TAURI__.core.invoke('set_tun_enabled', { enable: false });
                        // Restart as regular user
                        const settings = await window.__TAURI__.core.invoke('get_settings');
                        const currentConfig = settings.last_config || 'config.yaml';
                        const customArgs = settings.custom_args || [];
                        await restartCore(currentConfig, customArgs);
                    } catch (restartErr) {
                        console.error('[TUN] failed to disable TUN:', restartErr);
                    }
                }
            } else {
                // Non-macOS: use API to update config
                await patchConfig({ tun: { enable } });
                await persistConfigChanges({ tun: { enable } });
            }
            
            // Verify actual state from core
            const coreConfig = await getConfig();
            if (coreConfig?.tun?.enable !== enable) {
                throw new Error(t.tunRejected || "Core rejected TUN mode change (possible missing admin rights or driver issues)");
            }

            await closeAllConnections(); // Flush connections on TUN switch
            
            showNotification(t.configSuccess, 'success');
            
            // Apply status immediately, no artificial delay
            if (statusText) {
                statusText.textContent = enable ? t.proxyActive : t.virtualAdapter;
                if (!enable) statusText.classList.remove('text-purple-400');
            }
            if (spinner) spinner.classList.add('hidden');
            isNetworkUpdating = false;
            await updateTrayStatus();
        } catch (err) {
            // Rollback
            toggle.checked = !enable;
            if (statusText) {
                statusText.textContent = t.virtualAdapter;
                statusText.classList.remove('text-purple-400');
            }
            if (spinner) spinner.classList.add('hidden');
            // Show platform-specific error message
            showNotification(isMac ? t.tunFailedMac : t.tunFailed, 'error');
            isNetworkUpdating = false;
            await updateTrayStatus();
        }
    };
}

export async function syncCoreConfig() {
    const config = await getConfig();
    if (!config) return;

    // Sync Mode
    if (config.mode) {
        updateModeUI(config.mode);
    }

    // Sync TUN
    const tunToggle = document.getElementById('tun-proxy-toggle');
    if (tunToggle && config.tun) {
        tunToggle.checked = config.tun.enable;
        const statusText = document.getElementById('tun-status-text');
        if (statusText) {
            const t = translations[currentLang];
            statusText.textContent = config.tun.enable ? t.proxyActive : t.proxyInactive || "Virtual Adapter";
        }
        updateTrayStatus();
    }

    // Update current node display
    try {
        const proxyGroupsResult = await fetchProxyGroups({ existingConfig: config });
        let currentNode = 'Direct';
        
        if (proxyGroupsResult) {
            currentNode = proxyGroupsResult.current || 'Direct';
        }
        
        const currentNodeEl = document.getElementById('current-node-name');
        if (currentNodeEl) {
            currentNodeEl.textContent = currentNode;
        }
    } catch (e) {
        console.warn("Failed to sync current node display", e);
    }
}

/**
 * HTML Templates Module
 * Contains reusable HTML template strings for dynamic rendering
 * This helps reduce the main index.html size and centralize UI components
 */

// Navigation Icons
export const NAV_ICONS = {
    home: `<svg class="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`,
    proxies: `<svg class="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>`,
    subscriptions: `<svg class="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 22h14a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v4"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="m3 15 2 2 4-4"/></svg>`,
    rules: `<svg class="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M7 8h10"/><path d="M7 12h10"/><path d="M7 16h10"/></svg>`,
    settings: `<svg class="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
    close: `<svg class="w-2 h-2 text-black/60" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`,
    back: `<svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg>`,
    github: `<svg class="w-5 h-5" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>`,
    advanced: `<svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>`
};

// Common UI Components
export const TEMPLATES = {
    // Loading spinner
    loadingSpinner: `<div class="flex flex-col items-center justify-center py-20">
        <div class="w-12 h-12 border-4 border-accent/20 border-t-accent rounded-full animate-spin"></div>
    </div>`,
    
    // Empty state placeholder
    emptyState: (message, icon = '📁') => `
        <div class="text-center text-xs text-zinc-600 py-4">
            <span class="text-2xl block mb-2">${icon}</span>
            ${message}
        </div>`,
    
    // Glass card wrapper
    glassCard: (content, extraClasses = '') => `
        <div class="glass-card p-5 space-y-4 ${extraClasses}">
            ${content}
        </div>`,
    
    // iOS-style switch
    iosSwitch: (id, checked = false) => `
        <label class="ios-switch">
            <input type="checkbox" id="${id}" ${checked ? 'checked' : ''}>
            <span class="switch-slider"></span>
        </label>`,
    
    // Section header
    sectionHeader: (title, extra = '') => `
        <h3 class="text-[10px] font-bold text-zinc-500 uppercase tracking-[0.2em] mb-4 ml-1" data-i18n="${title}">${extra || title}</h3>`,
    
    // Divider line
    divider: `<div class="h-px bg-white/5"></div>`,
    
    // Button with icon
    iconButton: (id, icon, label, extraClasses = '') => `
        <button id="${id}" class="w-12 h-12 flex items-center justify-center rounded-2xl cursor-pointer transition-all duration-300 ${extraClasses}" title="${label}">
            ${icon}
            <span class="sr-only" data-i18n="${label}">${label}</span>
        </button>`,
    
    // Menu card for settings
    menuCard: (id, icon, title, subtitle, extraClasses = '') => `
        <div id="${id}" class="glass-card p-5 cursor-pointer group hover:translate-y-[-2px] transition-all duration-300 ${extraClasses}">
            <div class="flex items-center gap-4">
                <div class="w-10 h-10 rounded-xl bg-accent/10 border border-accent/20 flex items-center justify-center text-accent group-hover:bg-accent/20 transition-all">
                    ${icon}
                </div>
                <div>
                    <p class="text-sm font-semibold text-zinc-200" data-i18n="${title}">${title}</p>
                    <p class="text-[10px] text-zinc-500" data-i18n="${subtitle}">${subtitle}</p>
                </div>
            </div>
        </div>`
};

// Settings row template generator
export function settingsRow(icon, title, description, control) {
    return `
        <div class="flex items-center justify-between">
            <div class="flex items-center gap-4">
                <div class="text-zinc-400">${icon}</div>
                <div>
                    <p class="text-sm font-semibold text-zinc-200" data-i18n="${title}">${title}</p>
                    <p class="text-[10px] text-zinc-500" data-i18n="${description}">${description}</p>
                </div>
            </div>
            ${control}
        </div>`;
}

// Dropdown menu template
export function dropdownMenu(triggerId, menuId, labelId, options) {
    const optionsHtml = options.map(opt => 
        `<button type="button" data-value="${opt.value}" class="dropdown-option w-full text-left px-3 py-2 rounded-lg text-[11px] text-zinc-200 hover:bg-white/10 transition-all">${opt.label}</button>`
    ).join('\n');
    
    return `
        <div class="relative w-40">
            <button id="${triggerId}" type="button" class="w-full bg-black/40 border border-white/5 rounded-lg px-3 py-1.5 text-[11px] text-zinc-300 focus:outline-none focus:border-purple-500/50 transition-all cursor-pointer flex items-center justify-between">
                <span id="${labelId}">Select...</span>
                <svg class="w-3.5 h-3.5 text-zinc-500 transition-transform duration-200" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="m6 9 6 6 6-6"></path>
                </svg>
            </button>
            <div id="${menuId}" class="hidden absolute right-0 top-[calc(100%+8px)] w-full rounded-xl border border-white/10 bg-zinc-900/95 backdrop-blur-xl shadow-[0_10px_40px_rgba(0,0,0,0.35)] p-1 z-30">
                ${optionsHtml}
            </div>
        </div>`;
}

// Notification toast template
export function notificationToast(message, type = 'info') {
    const colors = {
        success: 'from-green-500/20 to-emerald-500/10 border-green-500/30',
        error: 'from-red-500/20 to-rose-500/10 border-red-500/30',
        warning: 'from-yellow-500/20 to-amber-500/10 border-yellow-500/30',
        info: 'from-blue-500/20 to-cyan-500/10 border-blue-500/30'
    };
    
    return `
        <div class="notification-toast pointer-events-auto px-4 py-3 rounded-xl bg-gradient-to-r ${colors[type]} backdrop-blur-xl border shadow-lg transform translate-x-full opacity-0 transition-all duration-300">
            <p class="text-xs font-medium text-zinc-100">${message}</p>
        </div>`;
}

// Proxy card template (for dynamic rendering)
export function proxyCard(proxy, latency) {
    const latencyClass = latency > 0 
        ? (latency < 200 ? 'text-green-400' : latency < 500 ? 'text-yellow-400' : 'text-red-400')
        : 'text-zinc-500';
    
    const latencyText = latency > 0 ? `${latency}ms` : '--';
    
    return `
        <div class="proxy-card glass-card p-4 cursor-pointer group hover:translate-y-[-2px] transition-all duration-300" data-proxy-name="${proxy.name}">
            <div class="flex items-center justify-between">
                <div class="flex items-center gap-3">
                    <div class="w-2 h-2 rounded-full bg-accent animate-pulse"></div>
                    <span class="text-sm font-medium text-zinc-200 truncate max-w-[150px]">${proxy.name}</span>
                </div>
                <span class="text-[10px] font-mono ${latencyClass}">${latencyText}</span>
            </div>
            <div class="mt-2 text-[9px] text-zinc-500 font-mono truncate">${proxy.server}:${proxy.port}</div>
        </div>`;
}

// Rule item template
export function ruleItem(type, value, policy, index) {
    const policyColors = {
        'DIRECT': 'text-green-400',
        'REJECT': 'text-rose-500',
        'PROXY': 'text-accent'
    };
    
    return `
        <div class="rule-item glass-card p-4 flex items-center justify-between group hover:translate-x-1 transition-transform duration-300 cursor-pointer" data-rule-index="${index}">
            <div class="flex items-center gap-4 flex-1">
                <div class="px-2 py-0.5 rounded bg-white/5 border border-white/10 text-[9px] font-bold text-zinc-500 uppercase">${type}</div>
                <div class="text-xs text-zinc-300 font-mono truncate max-w-[240px]" title="${value}">${value}</div>
            </div>
            <div class="flex items-center gap-2">
                <div class="text-[10px] font-bold ${policyColors[policy] || 'text-accent'} uppercase tracking-wider mr-2">${policy}</div>
                <button class="btn-delete-rule opacity-0 group-hover:opacity-100 p-1.5 rounded-lg text-zinc-500 hover:text-rose-500 hover:bg-rose-500/10 transition-all">
                    <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                </button>
            </div>
        </div>`;
}

// Subscription card template
export function subscriptionCard(sub, isActive) {
    return `
        <div class="subscription-card glass-card p-4 cursor-pointer group hover:translate-y-[-2px] transition-all duration-300 ${isActive ? 'border-accent/30' : ''}" data-sub-url="${sub.url || ''}">
            <div class="flex items-center justify-between">
                <div class="flex items-center gap-3">
                    <div class="w-3 h-3 rounded-full ${isActive ? 'bg-accent' : 'bg-zinc-600'}"></div>
                    <span class="text-sm font-medium text-zinc-200">${sub.name}</span>
                </div>
                ${isActive ? '<span class="text-[9px] text-accent uppercase tracking-wider">Active</span>' : ''}
            </div>
            ${sub.url ? `<div class="mt-2 text-[9px] text-zinc-500 font-mono truncate">${sub.url}</div>` : ''}
        </div>`;
}

// @ts-check
/**
 * Lightweight Markdown → HTML converter (subset).
 *
 * Supports: headings, bold, italic, strikethrough, code blocks, inline code,
 * blockquotes, unordered/ordered lists, links, horizontal rules, images.
 *
 * Inspired by a CLI markdown renderer but adapted for browser HTML output.
 * Zero external dependencies.
 */

import { escapeHtml, escapeAttr, sanitizeHtml } from './sanitize.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert a subset of Markdown to safe HTML.
 * Automatically strips the "📦 下载说明" / "Download" section.
 * @param {string} md - Raw Markdown text
 * @returns {string} HTML string
 */
export function markdownToHtml(md) {
    // --- Pre-processing: strip unwanted sections ---

    // Remove "📦 下载说明" / "Download" section and everything after it
    let processed = md.replace(/(?:^|\n)##\s*📦?\s*下载说明[\s\S]*$/i, '');
    processed = processed.replace(/(?:^|\n)##\s*📦?\s*Download[\s\S]*$/i, '');

    // --- Token-level processing (order matters) ---

    let html = processed;

    // Use placeholders for code blocks and inline code so that escapeHtml
    // in subsequent steps doesn't double-escape the generated HTML tags.
    /** @type {string[]} */
    const placeholders = [];

    // 1. Code blocks (```...```) — must be first to prevent inner content from being parsed
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, _lang, code) => {
        const idx = placeholders.length;
        placeholders.push(`<pre class="bg-[var(--zephyr-bg-input)] rounded-lg p-3 my-3 text-xs overflow-x-auto leading-relaxed"><code>${escapeHtml(code.trimEnd())}</code></pre>`);
        return `\x00CODEBLOCK_${idx}\x00`;
    });

    // 2. Inline code — before bold/italic to avoid matching inside code
    html = html.replace(/`([^`]+)`/g, (_, code) => {
        const idx = placeholders.length;
        placeholders.push(`<code class="bg-[var(--zephyr-bg-input)] px-2 py-0.5 rounded text-xs align-middle">${escapeHtml(code)}</code>`);
        return `\x00INLINECODE_${idx}\x00`;
    });

    // 3. Headings (h1 > h2 > h3 to avoid h3 regex matching h2/h1)
    html = html.replace(/^### (.+)$/gm, (_, t) => `<h4 class="text-sm font-semibold text-[var(--text-primary)] mt-4 mb-1">${escapeHtml(t)}</h4>`);
    html = html.replace(/^## (.+)$/gm, (_, t) => `<h3 class="text-base font-semibold text-[var(--text-primary)] mt-5 mb-2">${escapeHtml(t)}</h3>`);
    html = html.replace(/^# (.+)$/gm, (_, t) => `<h2 class="text-lg font-bold text-[var(--text-primary)] mt-5 mb-2">${escapeHtml(t)}</h2>`);

    // 4. Blockquotes
    html = html.replace(/^> (.+)$/gm, (_, t) => `<blockquote class="border-l-2 border-accent/40 pl-3 my-2 text-xs text-[var(--text-secondary)] italic">${escapeHtml(t)}</blockquote>`);

    // 5. Bold (before italic to avoid ** being partially consumed)
    html = html.replace(/\*\*(.+?)\*\*/g, (_, t) => `<strong class="font-semibold text-[var(--text-primary)]">${escapeHtml(t)}</strong>`);

    // 6. Italic
    html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, (_, t) => `<em>${escapeHtml(t)}</em>`);

    // 7. Strikethrough (~~text~~)
    html = html.replace(/~~(.+?)~~/g, (_, t) => `<del class="line-through text-[var(--text-muted)]">${escapeHtml(t)}</del>`);

    // 8. Horizontal rules
    html = html.replace(/^---$/gm, '<hr class="border-[var(--zephyr-border-default)] my-4">');

    // 9. Images — show alt text only (no actual img tag for security)
    html = html.replace(/!\[([^\]]*)\]\([^)]+\)/g, (_, alt) => `<span class="text-xs text-[var(--text-muted)]">[${escapeHtml(alt)}]</span>`);

    // 10. Links
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, href) => {
        // Block dangerous URI schemes
        if (/^\s*(javascript|vbscript|data)\s*:/i.test(href)) {
            return `<span class="text-xs text-[var(--text-secondary)]">${escapeHtml(text)}</span>`;
        }
        // Skip mailto links — show email as plain text
        if (href.startsWith('mailto:')) {
            return `<span class="text-xs text-[var(--text-secondary)]">${escapeHtml(href.replace(/^mailto:/, ''))}</span>`;
        }
        return `<a href="${escapeAttr(href)}" class="text-accent underline" target="_blank" rel="noopener">${escapeHtml(text)}</a>`;
    });

    // 11. Unordered lists
    html = html.replace(/^(\s*)[-*] (.+)$/gm, (_, indent, t) => `${indent}<li class="ml-4 list-disc text-xs text-[var(--text-secondary)] leading-relaxed py-0.5">${t}</li>`);
    html = html.replace(/((?:<li[^>]*>.*<\/li>\n?)+)/g, '<ul class="my-3 space-y-2">$1</ul>');

    // 12. Ordered lists
    html = html.replace(/^\d+\. (.+)$/gm, (_, t) => `<li class="ml-4 list-decimal text-xs text-[var(--text-secondary)] leading-relaxed py-0.5">${t}</li>`);

    // 13. Paragraphs: wrap remaining loose lines that aren't already HTML tags or code block placeholders
    html = html.replace(/^(?!<[a-z/]|\x00CODEBLOCK)(.*\S.*)$/gm, (_, t) => `<p class="text-xs text-[var(--text-secondary)] leading-relaxed my-2">${t}</p>`);

    // --- Restore placeholders (before sanitizeHtml) ---
    html = html.replace(/\x00(?:CODEBLOCK|INLINECODE)_(\d+)\x00/g, (_, idx) => placeholders[parseInt(idx, 10)]);

    // --- Post-processing ---
    html = html.replace(/\n{3,}/g, '\n\n');

    return sanitizeHtml(html.trim());
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

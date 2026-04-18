// @ts-check
/**
 * Lightweight Markdown → HTML converter (subset).
 *
 * Supports: headings, bold, italic, strikethrough, code blocks, inline code,
 * blockquotes, unordered/ordered lists, links, horizontal rules, images.
 *
 * Zero external dependencies.
 */

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
    md = md.replace(/(?:^|\n)##\s*📦?\s*下载说明[\s\S]*$/i, '');
    md = md.replace(/(?:^|\n)##\s*📦?\s*Download[\s\S]*$/i, '');

    // --- Token-level processing (order matters) ---

    let html = md;

    // 1. Code blocks (```...```) — must be first to prevent inner content from being parsed
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, _lang, code) => {
        return `<pre class="bg-black/30 rounded-lg p-3 my-3 text-xs overflow-x-auto leading-relaxed"><code>${escapeHtml(code.trimEnd())}</code></pre>`;
    });

    // 2. Inline code — before bold/italic to avoid matching inside code
    html = html.replace(/`([^`]+)`/g, (_, code) => {
        return `<code class="bg-black/20 px-2 py-0.5 rounded text-xs align-middle">${escapeHtml(code)}</code>`;
    });

    // 3. Headings (h1 > h2 > h3 to avoid h3 regex matching h2/h1)
    html = html.replace(/^### (.+)$/gm, (_, t) => `<h4 class="text-sm font-semibold text-zinc-200 mt-4 mb-1">${escapeHtml(t)}</h4>`);
    html = html.replace(/^## (.+)$/gm, (_, t) => `<h3 class="text-base font-semibold text-zinc-100 mt-5 mb-2">${escapeHtml(t)}</h3>`);
    html = html.replace(/^# (.+)$/gm, (_, t) => `<h2 class="text-lg font-bold text-zinc-100 mt-5 mb-2">${escapeHtml(t)}</h2>`);

    // 4. Blockquotes
    html = html.replace(/^> (.+)$/gm, (_, t) => `<blockquote class="border-l-2 border-accent/40 pl-3 my-2 text-xs text-zinc-400 italic">${escapeHtml(t)}</blockquote>`);

    // 5. Bold (before italic to avoid ** being partially consumed)
    html = html.replace(/\*\*(.+?)\*\*/g, (_, t) => `<strong class="font-semibold text-zinc-100">${escapeHtml(t)}</strong>`);

    // 6. Italic
    html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, (_, t) => `<em>${escapeHtml(t)}</em>`);

    // 7. Strikethrough (~~text~~)
    html = html.replace(/~~(.+?)~~/g, (_, t) => `<del class="line-through text-zinc-500">${escapeHtml(t)}</del>`);

    // 8. Horizontal rules
    html = html.replace(/^---$/gm, '<hr class="border-white/10 my-4">');

    // 9. Images — show alt text only (no actual img tag for security)
    html = html.replace(/!\[([^\]]*)\]\([^)]+\)/g, (_, alt) => `<span class="text-xs text-zinc-500">[${escapeHtml(alt)}]</span>`);

    // 10. Links
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, href) => {
        // Block dangerous URI schemes
        if (/^\s*(javascript|vbscript|data)\s*:/i.test(href)) {
            return `<span class="text-xs text-zinc-300">${escapeHtml(text)}</span>`;
        }
        // Skip mailto links — show email as plain text
        if (href.startsWith('mailto:')) {
            return `<span class="text-xs text-zinc-300">${escapeHtml(href.replace(/^mailto:/, ''))}</span>`;
        }
        return `<a href="${escapeHtml(href)}" class="text-accent underline" target="_blank" rel="noopener">${escapeHtml(text)}</a>`;
    });

    // 11. Unordered lists
    // NOTE: Do NOT escapeHtml the list item content — it already contains HTML from steps 1-10
    html = html.replace(/^(\s*)[-*] (.+)$/gm, (_, indent, t) => `${indent}<li class="ml-4 list-disc text-xs text-zinc-300 leading-relaxed py-0.5">${t}</li>`);
    html = html.replace(/((?:<li[^>]*>.*<\/li>\n?)+)/g, '<ul class="my-3 space-y-2">$1</ul>');

    // 12. Ordered lists
    html = html.replace(/^\d+\. (.+)$/gm, (_, t) => `<li class="ml-4 list-decimal text-xs text-zinc-300 leading-relaxed py-0.5">${t}</li>`);

    // 13. Paragraphs: wrap remaining loose lines that aren't already HTML tags
    // NOTE: Do NOT escapeHtml — content may already contain HTML from earlier steps
    html = html.replace(/^(?!<[a-z/])(.*\S.*)$/gm, (_, t) => `<p class="text-xs text-zinc-300 leading-relaxed my-2">${t}</p>`);

    // --- Post-processing ---
    html = html.replace(/\n{3,}/g, '\n\n');

    return html.trim();
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Minimal HTML entity escaping.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

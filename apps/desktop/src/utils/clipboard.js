// @ts-check
import { createLogger } from './logger.js';
import { SVG_ICONS } from '../ui/icons.js';
import { escapeAttr } from './sanitize.js';

const clipboardLogger = createLogger('Clipboard', 'info');

/**
 * Renders HTML string for an inline paste button.
 * @param {string} id
 * @param {string} [label='Paste']
 * @param {boolean} [isTextarea=false]
 * @param {string|null} [i18nKey='paste']
 * @returns {string}
 */
export function renderPasteButtonHtml(id, label = 'Paste', isTextarea = false, i18nKey = 'paste') {
    const btnClass = isTextarea ? 'btn-paste-base btn-textarea-paste' : 'btn-paste-base btn-input-paste';
    const escapedLabel = escapeAttr(label);
    const i18nAttrs = i18nKey ? ` data-i18n-title="${escapeAttr(i18nKey)}" data-i18n-aria-label="${escapeAttr(i18nKey)}"` : '';
    return `<button type="button" id="${escapeAttr(id)}" class="${btnClass}" title="${escapedLabel}" aria-label="${escapedLabel}"${i18nAttrs}>${SVG_ICONS.clipboard}</button>`;
}

/**
 * Normalizes pasted text based on target element type.
 * For single-line inputs (`<input>`), multiline text is normalized by extracting
 * the first non-empty line to avoid creating malformed concatenated values.
 * For multi-line textareas (`<textarea>`), all lines are preserved.
 *
 * @param {HTMLInputElement | HTMLTextAreaElement} targetInput
 * @param {string} rawText
 * @param {boolean} [trim=true]
 * @returns {string}
 */
export function normalizePastedText(targetInput, rawText, trim = true) {
    if (targetInput.tagName === 'INPUT') {
        const lines = rawText.split(/\r\n?|\n/);
        const chosenLine = lines.find((l) => l.trim().length > 0) ?? lines[0] ?? '';
        return trim ? chosenLine.trim() : chosenLine;
    }
    const normalized = rawText.replace(/\r\n?/g, '\n');
    return trim ? normalized.trim() : normalized;
}

/**
 * Inserts or sets pasted text into target element.
 * @param {HTMLInputElement | HTMLTextAreaElement} targetInput
 * @param {string} valToInsert
 * @param {number|null} [selStart]
 * @param {number|null} [selEnd]
 */
function applyPastedText(targetInput, valToInsert, selStart = null, selEnd = null) {
    if (!valToInsert) return;

    const start = selStart ?? targetInput.selectionStart;
    const end = selEnd ?? targetInput.selectionEnd;
    const hasSelection = typeof start === 'number'
        && typeof end === 'number'
        && start !== end;

    if (hasSelection && typeof targetInput.setRangeText === 'function') {
        targetInput.setRangeText(valToInsert, /** @type {number} */ (start), /** @type {number} */ (end), 'end');
        return;
    }

    if (targetInput.tagName === 'TEXTAREA' && targetInput.value.length > 0) {
        const existing = targetInput.value;
        const separator = (existing.length > 0 && !existing.endsWith('\n')) ? '\n' : '';
        targetInput.value = existing + separator + valToInsert;
        return;
    }

    targetInput.value = valToInsert;
}

/**
 * Reads text from system clipboard and sets/inserts it into the target input/textarea.
 * - If the target input has a selected text range, replaces the selected range.
 * - If the target is a multi-line textarea with existing content and no selection, appends on a new line.
 * - Otherwise (single-line input or empty textarea), replaces/sets the entire field value.
 * Automatically trims whitespace by default and dispatches 'input' and 'change' events.
 * If clipboard content normalizes to empty, no mutation occurs and returns false.
 *
 * @param {HTMLInputElement | HTMLTextAreaElement} targetInput
 * @param {boolean} [trim=true]
 * @param {((error: Error | string) => void) | null} [onError=null]
 * @returns {Promise<boolean>}
 */
export async function pasteToElement(targetInput, trim = true, onError = null) {
    if (!targetInput) return false;

    // Capture snapshot of value and selection before async clipboard read
    const initialValue = targetInput.value;
    const selStart = typeof targetInput.selectionStart === 'number' ? targetInput.selectionStart : null;
    const selEnd = typeof targetInput.selectionEnd === 'number' ? targetInput.selectionEnd : null;

    // Track paste invocation version on element to prevent out-of-order race conditions
    const targetWithMeta = /** @type {HTMLInputElement & { _pasteVersion?: number }} */ (targetInput);
    const pasteVersion = (targetWithMeta._pasteVersion || 0) + 1;
    targetWithMeta._pasteVersion = pasteVersion;

    try {
        if (typeof navigator === 'undefined' || !navigator?.clipboard?.readText) {
            clipboardLogger.warn('Clipboard API not supported or unavailable in current environment');
            if (typeof onError === 'function') onError(new Error('Clipboard API not supported'));
            return false;
        }
        const text = await navigator.clipboard.readText();
        if (text === undefined || text === null) {
            clipboardLogger.warn('Clipboard content is null or undefined');
            return false;
        }

        // If a newer paste was initiated while this one was pending, abort this stale request
        if (targetWithMeta._pasteVersion !== pasteVersion) {
            return false;
        }

        // If the user edited the field while clipboard access was pending, abort to avoid clobbering edits
        if (targetInput.value !== initialValue) {
            clipboardLogger.warn('Target value changed while reading clipboard; paste aborted to prevent overwriting edits');
            return false;
        }

        const valToInsert = normalizePastedText(targetInput, text, trim);
        if (valToInsert.length === 0) {
            return false;
        }

        applyPastedText(targetInput, valToInsert, selStart, selEnd);

        targetInput.focus();
        targetInput.dispatchEvent(new Event('input', { bubbles: true }));
        targetInput.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    } catch (err) {
        clipboardLogger.warn('Failed to read from clipboard', err);
        if (typeof onError === 'function') onError(/** @type {Error} */ (err));
        return false;
    }
}

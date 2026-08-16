// @ts-check
import { createLogger } from './logger.js';

const clipboardLogger = createLogger('Clipboard', 'info');

/**
 * Reads text from system clipboard and sets/inserts it into the target input/textarea.
 * - If the target input has a selected text range, replaces the selected range.
 * - Otherwise (standard button click or no selection), replaces the entire field value.
 * Automatically trims whitespace by default and dispatches 'input' and 'change' events.
 *
 * @param {HTMLInputElement | HTMLTextAreaElement} targetInput
 * @param {boolean} [trim=true]
 * @returns {Promise<boolean>}
 */
export async function pasteToElement(targetInput, trim = true) {
    if (!targetInput) return false;
    try {
        if (typeof navigator === 'undefined' || !navigator?.clipboard?.readText) {
            clipboardLogger.warn('Clipboard API not supported or unavailable in current environment');
            return false;
        }
        const text = await navigator.clipboard.readText();
        if (text === undefined || text === null) {
            clipboardLogger.warn('Clipboard content is null or undefined');
            return false;
        }

        const valToInsert = trim ? text.trim() : text;

        const hasSelection = typeof targetInput.selectionStart === 'number'
            && typeof targetInput.selectionEnd === 'number'
            && targetInput.selectionStart !== targetInput.selectionEnd;

        if (hasSelection && typeof targetInput.setRangeText === 'function') {
            targetInput.setRangeText(valToInsert, /** @type {number} */ (targetInput.selectionStart), /** @type {number} */ (targetInput.selectionEnd), 'end');
        } else if (targetInput.tagName === 'TEXTAREA' && targetInput.value.length > 0) {
            const existing = trim ? targetInput.value.trimEnd() : targetInput.value;
            const needsNewline = existing.length > 0 && !existing.endsWith('\n');
            targetInput.value = existing + (needsNewline ? '\n' : '') + valToInsert;
        } else {
            targetInput.value = valToInsert;
        }

        targetInput.focus();
        targetInput.dispatchEvent(new Event('input', { bubbles: true }));
        targetInput.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    } catch (err) {
        clipboardLogger.warn('Failed to read from clipboard', err);
        return false;
    }
}

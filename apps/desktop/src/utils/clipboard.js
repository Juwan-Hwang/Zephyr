// @ts-check
import { createLogger } from './logger.js';

const clipboardLogger = createLogger('Clipboard', 'info');

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
        const lines = rawText.split(/\r?\n/);
        const chosenLine = lines.find((l) => l.trim().length > 0) ?? lines[0] ?? '';
        return trim ? chosenLine.trim() : chosenLine;
    }
    return trim ? rawText.trim() : rawText;
}

/**
 * Inserts or sets pasted text into target element.
 * @param {HTMLInputElement | HTMLTextAreaElement} targetInput
 * @param {string} valToInsert
 * @param {boolean} trim
 */
function applyPastedText(targetInput, valToInsert, trim) {
    if (!valToInsert) return;

    const hasSelection = typeof targetInput.selectionStart === 'number'
        && typeof targetInput.selectionEnd === 'number'
        && targetInput.selectionStart !== targetInput.selectionEnd;

    if (hasSelection && typeof targetInput.setRangeText === 'function') {
        targetInput.setRangeText(valToInsert, /** @type {number} */ (targetInput.selectionStart), /** @type {number} */ (targetInput.selectionEnd), 'end');
        return;
    }

    if (targetInput.tagName === 'TEXTAREA' && targetInput.value.length > 0) {
        const existing = trim ? targetInput.value.trimEnd() : targetInput.value;
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

        const valToInsert = normalizePastedText(targetInput, text, trim);
        if (valToInsert.length === 0) {
            return false;
        }

        applyPastedText(targetInput, valToInsert, trim);

        targetInput.focus();
        targetInput.dispatchEvent(new Event('input', { bubbles: true }));
        targetInput.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    } catch (err) {
        clipboardLogger.warn('Failed to read from clipboard', err);
        return false;
    }
}

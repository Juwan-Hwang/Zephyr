// @ts-check

/**
 * Reads text from system clipboard and sets it as the value of the target input/textarea.
 * Automatically trims whitespace and dispatches 'input' and 'change' events.
 *
 * @param {HTMLInputElement | HTMLTextAreaElement} targetInput
 * @param {boolean} [trim=true]
 * @returns {Promise<boolean>}
 */
export async function pasteToElement(targetInput, trim = true) {
    if (!targetInput) return false;
    try {
        if (typeof navigator === 'undefined' || !navigator.clipboard || !navigator.clipboard.readText) {
            return false;
        }
        const text = await navigator.clipboard.readText();
        if (text === undefined || text === null) return false;

        const valToInsert = trim ? text.trim() : text;

        if (typeof targetInput.selectionStart === 'number' && typeof targetInput.selectionEnd === 'number' && targetInput.value) {
            targetInput.setRangeText(valToInsert, targetInput.selectionStart, targetInput.selectionEnd, 'end');
        } else {
            targetInput.value = valToInsert;
        }

        targetInput.focus();
        targetInput.dispatchEvent(new Event('input', { bubbles: true }));
        targetInput.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    } catch {
        return false;
    }
}

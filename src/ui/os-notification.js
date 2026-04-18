// @ts-check
/**
 * OS Notification module.
 *
 * Provides a thin wrapper around the Tauri notification plugin
 * to send native OS-level notifications from the frontend.
 */

import { invoke } from '../api.js';

/**
 * Send an OS-level notification using the Tauri notification plugin.
 *
 * @param {string} title - Notification title
 * @param {string} body - Notification body text
 * @returns {Promise<void>}
 */
export async function sendOSNotification(title, body) {
    try {
        await invoke('rate_limited_send_notification', { title, body });
    } catch (err) {
        // Silently fall back — OS notifications are non-critical
        console.warn('[OSNotification] Failed to send notification:', err);
    }
}

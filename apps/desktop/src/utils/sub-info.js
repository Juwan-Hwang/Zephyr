// @ts-check
/**
 * Subscription usage as providers report it (the `subscription-userinfo`
 * header kept on a profile as `sub_info`).
 */

/**
 * A finite positive header count rounded down to a whole number; 0 for invalid,
 * negative or oversized values (`123junk` included, which parseInt reads as 123).
 * @param {string} v
 */
function toCount(v) {
    const t = v.trim();
    const n = t ? Number(t) : Number.NaN;
    return Number.isFinite(n) && n > 0 && n <= Number.MAX_SAFE_INTEGER ? Math.floor(n) : 0;
}

/**
 * Parse a subscription info string into { upload, download, total, expire }.
 * @param {string | undefined | null} subInfo
 * @returns {{ upload: number, download: number, total: number, expire: number }}
 */
export function parseSubInfo(subInfo) {
    if (!subInfo) return { upload: 0, download: 0, total: 0, expire: 0 };
    let upload = 0, download = 0, total = 0, expire = 0;
    for (const p of String(subInfo).split(';')) {
        const s = p.trim();
        if (s.startsWith('upload=')) upload = toCount(s.slice(7));
        else if (s.startsWith('download=')) download = toCount(s.slice(9));
        else if (s.startsWith('total=')) total = toCount(s.slice(6));
        else if (s.startsWith('expire=')) expire = toCount(s.slice(7));
    }
    // Past the last date a Date can hold: formatting it would throw, so treat as none.
    if (!(expire > 0 && expire * 1000 <= 8.64e15)) expire = 0;
    return { upload, download, total, expire };
}

/**
 * Bytes as GB with at most one decimal ("61.8 GB", "200 GB"); under 1 GB as
 * MB ("512 MB"), so a small quota or use does not read "0 GB".
 * @param {number} bytes
 */
export function gb(bytes) {
    const v = Math.round((bytes / 1073741824) * 10) / 10;
    if (bytes > 0 && bytes < 1073741824) {
        const mb = bytes / 1048576;
        const m = mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10;
        // Some use, too little to show: not the "0 MB" of none at all.
        if (m === 0) return '< 0.1 MB';
        return `${Number.isInteger(m) ? m : m.toFixed(1)} MB`;
    }
    return `${Number.isInteger(v) ? v : v.toFixed(1)} GB`;
}

/**
 * "61.8 GB / 200 GB · 23 days left", or null when the profile reports no usage.
 * @param {string | undefined | null} subInfo
 * @param {(days: number) => string} daysLeft localized "N days left"
 * @param {number} [nowMs]
 * @returns {string | null}
 */
export function formatSubUsage(subInfo, daysLeft, nowMs = Date.now()) {
    const { upload, download, total, expire } = parseSubInfo(subInfo);
    if (!(total > 0)) return null;
    const parts = [`${gb(upload + download)} / ${gb(total)}`];
    if (expire > 0) {
        // Rounded up, as the subscription list shows it: hours left are "1 day".
        const days = Math.ceil((expire - nowMs / 1000) / 86400);
        if (days > 0) parts.push(daysLeft(days));
    }
    return parts.join(' · ');
}

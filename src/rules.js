/**
 * Shadowrocket to Clash Rule Converter
 */
export async function fetchAndConvertSRRules(url, targetProxy = 'Proxy') {
    try {
        // Validate URL format - only allow http/https
        let parsedUrl;
        try {
            parsedUrl = new URL(url);
        } catch {
            throw new Error('Invalid URL format');
        }
        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
            throw new Error('Only HTTP/HTTPS URLs are allowed');
        }

        // Use Tauri command to bypass CSP and reuse SSRF protection
        const text = await window.__TAURI__.core.invoke('fetch_text', { url });
        
        return convertSRToClash(text, targetProxy);
    } catch (error) {
        console.error('[Rules] Failed to fetch SR rules:', error);
        throw error;
    }
}

export function convertSRToClash(srText, targetProxy = 'Proxy') {
    const lines = srText.split('\n');
    const clashRules = [];
    let inRuleSection = false;

    for (let line of lines) {
        line = line.trim();
        if (!line || line.startsWith('#') || line.startsWith(';')) continue;

        // Shadowrocket usually has [Rule] section
        if (line.startsWith('[') && line.endsWith(']')) {
            inRuleSection = line.toLowerCase() === '[rule]';
            continue;
        }

        // Skip lines if we are outside of the [Rule] section (assuming a standard SR conf)
        // Some users just paste raw rules without [Rule], so if we never hit any section, we parse anyway.
        // But if we hit other sections like [General], we should skip.
        if (line.includes('=') && !line.includes(',')) {
            // Likely a key=value pair in General section
            continue;
        }

        // Basic parser for type,value,policy
        const parts = line.split(',').map(p => p.trim());
        if (parts.length >= 2) {
            const type = parts[0].toUpperCase();
            const value = parts[1];
            let policy = parts[2] || targetProxy;

            // Normalize policy
            const upperPolicy = policy.toUpperCase();
            if (upperPolicy === 'PROXY') policy = targetProxy;
            else if (upperPolicy === 'DIRECT') policy = 'DIRECT';
            else if (upperPolicy === 'REJECT') policy = 'REJECT';

            // Supported types mapping
            const supportedTypes = ['DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD', 'IP-CIDR', 'IP-CIDR6', 'GEOIP', 'USER-AGENT', 'PROCESS-NAME', 'DST-PORT', 'SRC-PORT', 'SRC-IP-CIDR', 'GEOSITE', 'RULE-SET', 'MATCH'];
            
            // Map SR specific types to Clash
            let clashType = type;
            if (type === 'FINAL') clashType = 'MATCH';
            if (type === 'IP-CIDR' && value.includes(':')) clashType = 'IP-CIDR6';

            if (supportedTypes.includes(clashType)) {
                // Remove trailing options like ,no-resolve that might be in SR but clash doesn't strictly need in simple rule
                const extraArgs = parts.slice(3).join(',');
                if (extraArgs.includes('no-resolve')) {
                    clashRules.push(`${clashType},${value},${policy},no-resolve`);
                } else {
                    clashRules.push(`${clashType},${value},${policy}`);
                }
            }
        }
    }

    return clashRules;
}

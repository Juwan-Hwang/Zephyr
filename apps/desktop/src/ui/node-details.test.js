import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../i18n.js', () => ({ t: (/** @type {string} */ k) => k, currentLang: 'en' }));
vi.mock('./exit-ip.js', () => ({ exitIpFor: vi.fn(), refreshExitIp: vi.fn() }));
vi.mock('./tray.js', () => ({ copyToClipboard: vi.fn(async () => true) }));
vi.mock('./notifications.js', () => ({ showNotification: vi.fn() }));

const { buildDetailRows, exitIpSummary, typeLabel, openNodeDetails, closeNodeDetails } = await import('./node-details.js');
const exitIp = await import('./exit-ip.js');

const FULL = {
    ip: '3.5.140.2', country: 'US', source: 'ip-info.com', country_name: 'United States',
    continent_name: 'North America', is_eu: false, region: 'Washington', region_code: 'WA',
    city: 'Seattle', district: 'Downtown', postal: '98101', latitude: 47.6062, longitude: -122.3321,
    timezone: 'America/Los_Angeles', asn: 16509, as_name: 'Amazon.com, Inc.', isp: 'Amazon.com, Inc.',
    org: 'AWS', connection_type: 'Corporate', user_type: 'hosting', is_anycast: true,
};

describe('node details rows', () => {
    it('lists every known value in order', () => {
        const rows = buildDetailRows(FULL, { now: Date.UTC(2026, 10, 26, 6, 0), lang: 'en' });
        expect(rows.map((r) => r.id)).toEqual(['ip', 'location', 'continent', 'postal', 'coords', 'timezone', 'isp', 'org', 'asn', 'connection', 'iptype', 'anycast']);
        const v = Object.fromEntries(rows.map((r) => [r.id, r.value]));
        expect(v.location).toBe('Downtown, Seattle, Washington, United States');
        expect(v.coords).toBe('47.6062, -122.3321');
        expect(v.timezone).toMatch(/^America\/Los_Angeles · 10:00/);
        expect(v.asn).toBe('AS16509 · Amazon.com, Inc.');
        expect(v.connection).toBe('ndTypeBusiness');
        expect(v.iptype).toBe('ndTypeHosting');
        expect(v.anycast).toBe('ndYes');
        expect(rows.find((r) => r.id === 'ip')?.label).toBe('ndIp');
    });

    it('hides missing values, false flags and an organization equal to the ISP', () => {
        const rows = buildDetailRows({ ip: '198.51.100.1', country: 'DE', source: 'cloudflare', isp: 'X', org: 'X', is_eu: true, is_anycast: false });
        expect(rows.map((r) => r.id)).toEqual(['ip', 'location', 'isp', 'eu']);
        expect(rows[1].value).toBe('Germany');
    });

    it('keeps unknown types as given and drops repeated place names', () => {
        expect(typeLabel('Satellite')).toBe('Satellite');
        expect(typeLabel('residential')).toBe('ndTypeResidential');
        const rows = buildDetailRows({ ip: '203.0.113.9', country: 'JP', source: 'ip-info.com', city: 'Osaka', region: 'Osaka', timezone: 'Not/AZone' });
        const v = Object.fromEntries(rows.map((r) => [r.id, r.value]));
        expect(v.location).toBe('Osaka, Japan');
        expect(v.timezone).toBe('Not/AZone');
    });

    it('summarises as IP · city, country with the ISP as tooltip', () => {
        expect(exitIpSummary(FULL, 'en')).toEqual({ ip: 'IP 3.5.140.2', place: 'Seattle, United States', title: 'Amazon.com, Inc.' });
        expect(exitIpSummary({ ip: '1.1.1.1', country: 'AU', source: 'cloudflare' }, 'en')).toEqual({ ip: 'IP 1.1.1.1', place: 'Australia', title: '' });
        expect(exitIpSummary({ ip: '1.1.1.1', country: 'SG', source: 'ip-info.com', city: 'Singapore', country_name: 'Singapore' }, 'en').place).toBe('Singapore');
    });
});

describe('node details card', () => {
    beforeEach(() => { document.body.innerHTML = '<button id="a" aria-expanded="false">IP</button>'; });

    it('opens as a dialog with the source note, refreshes, and closes on Escape', async () => {
        /** @type {any} */ (exitIp.exitIpFor).mockResolvedValue(FULL);
        /** @type {any} */ (exitIp.refreshExitIp).mockResolvedValue(null);
        const a = /** @type {HTMLElement} */ (document.getElementById('a'));
        await openNodeDetails(a, 'US 01');
        const pop = /** @type {HTMLElement} */ (document.querySelector('[role="dialog"]'));
        expect(pop).not.toBeNull();
        expect(a.getAttribute('aria-expanded')).toBe('true');
        expect(pop.querySelector('.nd-foot')?.textContent).toBe('ndSourceIpInfo');
        expect(pop.querySelectorAll('dt')).toHaveLength(12);
        /** @type {HTMLElement} */ (pop.querySelector('.nd-head button')).click();
        await Promise.resolve(); await Promise.resolve();
        expect(exitIp.refreshExitIp).toHaveBeenCalledWith('US 01');
        expect(pop.querySelector('.nd-empty')?.textContent).toBe('ndUnavailable');
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        expect(a.getAttribute('aria-expanded')).toBe('false');
        expect(document.activeElement).toBe(a);
    });

    it('closes on a click outside', async () => {
        /** @type {any} */ (exitIp.exitIpFor).mockResolvedValue({ ip: '1.1.1.1', country: '', source: 'cloudflare' });
        await openNodeDetails(/** @type {HTMLElement} */ (document.getElementById('a')), 'x');
        expect(document.querySelector('.nd-foot')?.textContent).toBe('ndSourceCloudflare');
        document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        closeNodeDetails();
    });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../i18n.js', () => ({ t: (/** @type {string} */ k) => k, currentLang: 'en' }));
vi.mock('./exit-ip.js', () => ({ exitIpFor: vi.fn(), refreshExitIp: vi.fn() }));
vi.mock('./tray.js', () => ({ copyToClipboard: vi.fn(async () => true) }));
vi.mock('./notifications.js', () => ({ showNotification: vi.fn() }));

const { buildDetailRows, exitIpSummary, typeLabel, openNodeDetails, closeNodeDetails, dropOrphanedNodeDetails } = await import('./node-details.js');
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
        expect(v.timezone.replace(/\s+/g, ' ')).toBe('America/Los_Angeles · 10:00 PM');
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
        // No country_name: the city still is the country.
        expect(exitIpSummary({ ip: '1.1.1.1', country: 'SG', source: 'ip-info.com', city: 'Singapore' }, 'en').place).toBe('Singapore');
        expect(exitIpSummary({ ip: '1.1.1.1', country: 'SG', source: 'ip-info.com', city: 'Singapore' }, 'zh').place).toBe('新加坡');
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

    it('closes when its page is hidden without moving focus from the new page', async () => {
        document.body.innerHTML = '<section data-page="home"><button id="a">IP</button></section><button id="outside">Other page</button>';
        vi.mocked(exitIp.exitIpFor).mockResolvedValue(FULL);
        await openNodeDetails(/** @type {HTMLElement} */ (document.getElementById('a')), 'x');
        const outside = /** @type {HTMLElement} */ (document.getElementById('outside'));
        outside.focus();
        document.querySelector('[data-page="home"]')?.classList.add('hidden');
        await Promise.resolve();
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        expect(document.getElementById('a')?.getAttribute('aria-expanded')).toBe('false');
        expect(document.activeElement).toBe(outside);
    });

    it('closes when an anchor ancestor scrolls, but keeps scrolling within the details available', async () => {
        document.body.innerHTML = '<div id="scroller"><button id="a">IP</button></div>';
        /** @type {any} */ (exitIp.exitIpFor).mockResolvedValue(FULL);
        await openNodeDetails(/** @type {HTMLElement} */ (document.getElementById('a')), 'x');
        const pop = /** @type {HTMLElement} */ (document.querySelector('[role="dialog"]'));
        pop.dispatchEvent(new Event('scroll'));
        expect(document.querySelector('[role="dialog"]')).toBe(pop);
        document.getElementById('scroller')?.dispatchEvent(new Event('scroll'));
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        expect(document.getElementById('a')?.getAttribute('aria-expanded')).toBe('false');
        expect(document.activeElement).toBe(document.getElementById('a'));
    });

    it('leaves unrelated focus in place when a refreshed address removes the anchor', async () => {
        document.body.innerHTML = '<div id="home-node"><button id="a">IP</button><button id="fallback">Node</button></div><button id="outside">Other</button>';
        /** @type {any} */ (exitIp.exitIpFor).mockResolvedValue(FULL);
        await openNodeDetails(/** @type {HTMLElement} */ (document.getElementById('a')), 'x');
        const outside = /** @type {HTMLElement} */ (document.getElementById('outside'));
        outside.focus();
        document.getElementById('a')?.remove();
        dropOrphanedNodeDetails();
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        expect(document.activeElement).toBe(outside);
    });

    it('returns focused dialog controls to the IP button on resize', async () => {
        /** @type {any} */ (exitIp.exitIpFor).mockResolvedValue(FULL);
        const anchor = /** @type {HTMLElement} */ (document.getElementById('a'));
        await openNodeDetails(anchor, 'x');
        window.dispatchEvent(new Event('resize'));
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        expect(document.activeElement).toBe(anchor);
    });

    it('keeps Copy focus when a pending refresh replaces the details', async () => {
        /** @type {any} */ (exitIp.exitIpFor).mockResolvedValue(FULL);
        /** @type {(value: any) => void} */
        let finish = () => {};
        /** @type {any} */ (exitIp.refreshExitIp).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
        await openNodeDetails(/** @type {HTMLElement} */ (document.getElementById('a')), 'x');
        /** @type {HTMLButtonElement} */ (document.querySelector('.nd-head button')).click();
        const previousCopyButton = /** @type {HTMLElement} */ (document.querySelector('.nd-body button'));
        previousCopyButton.focus();
        finish({ ...FULL, ip: '192.0.2.44' });
        await Promise.resolve(); await Promise.resolve();
        expect(document.querySelector('.nd-body')?.textContent).toContain('192.0.2.44');
        const copyButton = document.querySelector('.nd-body button');
        expect(copyButton).not.toBe(previousCopyButton);
        expect(document.activeElement).toBe(copyButton);
        closeNodeDetails();
    });
});

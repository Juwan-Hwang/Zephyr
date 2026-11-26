import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn(), notify: vi.fn() }));
vi.mock('../../api.js', () => ({ setLatencyTestUrl: vi.fn() }));
vi.mock('../../i18n.js', () => ({ t: (key) => key }));
vi.mock('../../utils/focus-trap.js', () => ({ createFocusTrap: () => ({ activate() {}, deactivate() {} }) }));
vi.mock('../cache.js', () => ({ getSettingsCached: mocks.read }));
vi.mock('../settings-helpers.js', () => ({ saveSettingsChecked: mocks.save }));
vi.mock('../notifications.js', () => ({ showNotification: mocks.notify }));
vi.mock('../exit-ip.js', () => ({ resetExitIp: vi.fn() }));
vi.mock('../speed-test.js', () => ({
    SPEED_TEST_FILES: [], SPEED_TEST_SECS: [10], DEFAULT_SPEED_TEST_URL: 'https://download.example/file',
    speedTestSettingsOf: () => ({ url: 'https://download.example/file', maxSecs: 10, file: null }),
    saveSpeedTestSettings: vi.fn(), isValidSpeedTestUrl: () => true,
}));

const settings = await import('./speed-settings.js');
const { resetExitIp } = await import('../exit-ip.js');
let cleanup = () => {};

beforeEach(() => {
    vi.clearAllMocks();
    mocks.read.mockResolvedValue({ latency_test_url: 'https://old.example/' });
    mocks.save.mockResolvedValue(undefined);
    document.body.innerHTML = '<div data-page="settings"><button id="btn-latency-test-url"><span></span></button><button id="btn-speed-test-setting"><span></span></button></div>';
});
afterEach(() => {
    cleanup();
    cleanup = () => {};
    document.body.innerHTML = '';
});

describe('speed settings editor lifecycle', () => {
    it.each(['not-a-url', '', 'ftp://old.example/file'])('shows the effective default for invalid saved latency address: %s', async (value) => {
        mocks.read.mockResolvedValue({ latency_test_url: value });
        await settings.renderSpeedSettingRows();
        expect(document.querySelector('#btn-latency-test-url > span').textContent).toBe('latencyPresetGoogle');
    });

    it('clears pending exit-address work when the saved setting is turned off', async () => {
        document.body.innerHTML = '<input id="setting-show-exit-ip" type="checkbox">';
        mocks.read.mockResolvedValue({ show_exit_ip: true });
        cleanup = settings.initExitIpToggle();
        const toggle = document.getElementById('setting-show-exit-ip');
        await vi.waitFor(() => expect(toggle.disabled).toBe(false));
        expect(toggle.checked).toBe(true);
        toggle.checked = false;
        toggle.dispatchEvent(new Event('change'));
        await vi.waitFor(() => expect(resetExitIp).toHaveBeenCalledOnce());
        expect(mocks.save).toHaveBeenCalledWith({ show_exit_ip: false });
    });
    it('shows unavailable values when saved settings cannot be read', async () => {
        mocks.read.mockRejectedValueOnce(new Error('settings unavailable'));
        await settings.renderSpeedSettingRows();
        expect(document.querySelector('#btn-latency-test-url > span').textContent).toBe('—');
        expect(document.querySelector('#btn-speed-test-setting > span').textContent).toBe('—');
    });
    it('discards a pending open after leaving settings, even after returning', async () => {
        cleanup = settings.initSpeedSettings();
        await Promise.resolve();
        let finishRead;
        mocks.read.mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; }));
        const opening = settings.openLatencyUrlDialog();
        await vi.waitFor(() => expect(finishRead).toBeTypeOf('function'));
        const page = document.querySelector('[data-page="settings"]');
        page.classList.add('hidden');
        await new Promise((resolve) => setTimeout(resolve, 0));
        page.classList.remove('hidden');
        finishRead({ latency_test_url: 'https://old.example/' });
        await opening;
        expect(document.getElementById('latency-url-modal')).toBeNull();
    });

    it('reopens on the accepted value after a dismissed editor finishes saving', async () => {
        await settings.openLatencyUrlDialog();
        document.getElementById('latency-url-modal-input').value = 'https://new.example/';
        let finishSave;
        mocks.save.mockImplementationOnce(() => new Promise((resolve) => { finishSave = resolve; }));
        document.querySelector('[data-act="save"]').click();
        await vi.waitFor(() => expect(finishSave).toBeTypeOf('function'));
        document.querySelector('[data-act="cancel"]').click();
        mocks.read.mockClear();
        const reopening = settings.openLatencyUrlDialog();
        await Promise.resolve();
        expect(mocks.read).not.toHaveBeenCalled();
        mocks.read.mockResolvedValue({ latency_test_url: 'https://new.example/' });
        finishSave();
        await reopening;
        expect(document.getElementById('latency-url-modal-input').value).toBe('https://new.example/');
        document.querySelector('[data-act="cancel"]').click();
    });
});

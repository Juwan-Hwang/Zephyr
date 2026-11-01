import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../notifications.js', () => ({ showModal: vi.fn(), showNotification: vi.fn() }));
vi.mock('../../utils/clipboard.js', () => ({ pasteWithFeedback: vi.fn(), renderPasteButtonHtml: vi.fn(() => '') }));

const { initTunnelSettings } = await import('./tunnels.js');

const tunnelA = { network: ['tcp'], address: '127.0.0.1:7001', target: 'a.example.com:80' };
const tunnelB = { network: ['udp'], address: '127.0.0.1:7002', target: 'b.example.com:53' };

/** Tunnel list with two entries, saving through `saveConfigToCore`. */
function mount(saveConfigToCore) {
    document.body.innerHTML = '<div id="list"></div><div id="empty"></div>';
    const tunnelsList = document.getElementById('list');
    const api = initTunnelSettings({
        addTunnelBtn: null,
        tunnelsList,
        tunnelsEmpty: document.getElementById('empty'),
        initialTunnels: [{ ...tunnelA }, { ...tunnelB }],
        saveConfigToCore,
    });
    return { tunnelsList, api };
}

const unsavedRow = (list) => list.querySelector('[data-tunnels-unsaved]');
const deleteButtons = (list) => list.querySelectorAll('.btn-delete-icon');


describe('tunnel list saves', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('a full save shows no retry', async () => {
        const save = vi.fn(async () => true);
        const { tunnelsList } = mount(save);
        await deleteButtons(tunnelsList)[0].onclick();
        expect(save).toHaveBeenCalledWith({ tunnels: [tunnelB] });
        expect(deleteButtons(tunnelsList)).toHaveLength(1);
        expect(unsavedRow(tunnelsList)).toBeNull();
    });

    it('a partial save keeps the change the core runs but offers a retry', async () => {
        const save = vi.fn(async () => 'partial');
        const { tunnelsList } = mount(save);
        await deleteButtons(tunnelsList)[0].onclick();
        expect(deleteButtons(tunnelsList)).toHaveLength(1);
        const row = unsavedRow(tunnelsList);
        expect(row).not.toBeNull();

        // Retry still partial: the row stays.
        await row.querySelector('button').onclick();
        expect(save).toHaveBeenLastCalledWith({ tunnels: [tunnelB] });
        expect(unsavedRow(tunnelsList)).not.toBeNull();

        // Retry reaches the profile: the row goes.
        save.mockResolvedValue(true);
        await unsavedRow(tunnelsList).querySelector('button').onclick();
        expect(save).toHaveBeenLastCalledWith({ tunnels: [tunnelB] });
        expect(unsavedRow(tunnelsList)).toBeNull();
    });

    it('saves go to the core one at a time, in the order they were started', async () => {
        /** @type {Array<(v: any) => void>} */
        const answers = [];
        const save = vi.fn(() => new Promise((resolve) => { answers.push(resolve); }));
        const { tunnelsList } = mount(save);
        const first = deleteButtons(tunnelsList)[0].onclick();
        const second = deleteButtons(tunnelsList)[0].onclick();
        await vi.waitFor(() => expect(answers).toHaveLength(1));
        await Promise.resolve();
        expect(save).toHaveBeenCalledTimes(1);
        expect(save).toHaveBeenLastCalledWith({ tunnels: [tunnelB] });
        answers[0]('partial');
        await first;
        await vi.waitFor(() => expect(answers).toHaveLength(2));
        expect(save).toHaveBeenLastCalledWith({ tunnels: [] });
        answers[1](true);
        await second;
        expect(unsavedRow(tunnelsList)).toBeNull();
    });

    it('a newer save that failed does not hide an older partial save', async () => {
        /** @type {Array<(v: any) => void>} */
        const answers = [];
        const save = vi.fn(() => new Promise((resolve) => { answers.push(resolve); }));
        const { tunnelsList } = mount(save);
        const first = deleteButtons(tunnelsList)[0].onclick();
        const second = deleteButtons(tunnelsList)[0].onclick();
        await vi.waitFor(() => expect(answers).toHaveLength(1));
        answers[0]('partial');
        await first;
        await vi.waitFor(() => expect(answers).toHaveLength(2));
        answers[1](false);
        await second;
        expect(unsavedRow(tunnelsList)).not.toBeNull();
    });

    it('a failed delete is not put back once a later save sent the list without it', async () => {
        /** @type {Array<(v: any) => void>} */
        const answers = [];
        const save = vi.fn(() => new Promise((resolve) => { answers.push(resolve); }));
        const { tunnelsList } = mount(save);
        const first = deleteButtons(tunnelsList)[0].onclick(); // tunnelA
        const second = deleteButtons(tunnelsList)[0].onclick(); // then tunnelB
        await vi.waitFor(() => expect(answers).toHaveLength(1));
        answers[0](false);
        await first;
        await vi.waitFor(() => expect(answers).toHaveLength(2));
        expect(save).toHaveBeenLastCalledWith({ tunnels: [] });
        answers[1](true);
        await second;
        expect(deleteButtons(tunnelsList)).toHaveLength(0);
    });

    it('a reset waits for the save in flight, and that save cannot clear the reset\'s retry', async () => {
        /** @type {Array<(v: any) => void>} */
        const answers = [];
        const save = vi.fn(() => new Promise((resolve) => { answers.push(resolve); }));
        const { tunnelsList, api } = mount(save);
        const del = deleteButtons(tunnelsList)[0].onclick();
        const resetSave = vi.fn(async () => 'partial');
        const reset = api.saveAfterPending(resetSave);
        await vi.waitFor(() => expect(answers).toHaveLength(1));
        expect(resetSave).not.toHaveBeenCalled();
        answers[0](true);
        await del;
        expect(api.resetAfterSave(await reset)).toBe(true);
        expect(resetSave).toHaveBeenCalledTimes(1);
        expect(deleteButtons(tunnelsList)).toHaveLength(0);
        expect(unsavedRow(tunnelsList)).not.toBeNull();
    });

    it('a save started during a reset decides the list after it', async () => {
        /** @type {Array<(v: any) => void>} */
        const answers = [];
        const save = vi.fn(() => new Promise((resolve) => { answers.push(resolve); }));
        const { tunnelsList, api } = mount(save);
        /** @type {(v: any) => void} */
        let answerReset = () => {};
        const reset = api.saveAfterPending(() => new Promise((resolve) => { answerReset = resolve; }));
        const del = deleteButtons(tunnelsList)[0].onclick();
        await Promise.resolve();
        expect(save).not.toHaveBeenCalled();
        answerReset(true);
        expect(api.resetAfterSave(await reset)).toBe(false);
        await vi.waitFor(() => expect(answers).toHaveLength(1));
        answers[0](true);
        await del;
        expect(deleteButtons(tunnelsList)).toHaveLength(1);
    });

    it('a read that started before or during a save does not replace its list', async () => {
        /** @type {(v: any) => void} */
        let answer = () => {};
        const save = vi.fn(() => new Promise((resolve) => { answer = resolve; }));
        const { tunnelsList, api } = mount(save);
        const before = api.readMark();
        const del = deleteButtons(tunnelsList)[0].onclick();
        const during = api.readMark();
        expect(api.setTunnels([{ ...tunnelA }, { ...tunnelB }], during)).toBe(false);
        await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
        answer('partial');
        await del;
        expect(api.setTunnels([{ ...tunnelA }, { ...tunnelB }], before)).toBe(false);
        expect(deleteButtons(tunnelsList)).toHaveLength(1);
        expect(unsavedRow(tunnelsList)).not.toBeNull();
        // A read started after the save is taken.
        expect(api.setTunnels([{ ...tunnelB }], api.readMark())).toBe(true);
        expect(unsavedRow(tunnelsList)).not.toBeNull();
    });

    it('a failed save puts the tunnel back and changes nothing else', async () => {
        const save = vi.fn(async () => false);
        const { tunnelsList } = mount(save);
        await deleteButtons(tunnelsList)[0].onclick();
        expect(save).toHaveBeenCalledTimes(1);
        // Not re-rendered, and the list model still holds both.
        save.mockResolvedValue(true);
        await deleteButtons(tunnelsList)[1].onclick();
        expect(save).toHaveBeenLastCalledWith({ tunnels: [tunnelA] });
        expect(unsavedRow(tunnelsList)).toBeNull();
    });

    it('a reset whose save was partial offers a retry of the empty list', async () => {
        const save = vi.fn(async () => true);
        const { tunnelsList, api } = mount(save);
        expect(api.resetAfterSave('partial')).toBe(true);
        expect(deleteButtons(tunnelsList)).toHaveLength(0);
        const row = unsavedRow(tunnelsList);
        expect(row).not.toBeNull();
        await row.querySelector('button').onclick();
        expect(save).toHaveBeenLastCalledWith({ tunnels: [] });
        expect(unsavedRow(tunnelsList)).toBeNull();
    });

    it('a reset whose save failed keeps the list the core still runs', () => {
        const { tunnelsList, api } = mount(vi.fn(async () => true));
        expect(api.resetAfterSave(false)).toBe(false);
        expect(deleteButtons(tunnelsList)).toHaveLength(2);
        expect(unsavedRow(tunnelsList)).toBeNull();
        expect(api.resetAfterSave(true)).toBe(true);
        expect(deleteButtons(tunnelsList)).toHaveLength(0);
        expect(unsavedRow(tunnelsList)).toBeNull();
    });

    it('reading the same list back keeps the retry; another list clears it', async () => {
        const save = vi.fn(async () => 'partial');
        const { tunnelsList, api } = mount(save);
        await deleteButtons(tunnelsList)[0].onclick();
        api.setTunnels([{ ...tunnelB }]);
        expect(unsavedRow(tunnelsList)).not.toBeNull();
        api.setTunnels([{ ...tunnelA }]);
        expect(unsavedRow(tunnelsList)).toBeNull();
    });
});

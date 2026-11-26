import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../notifications.js', () => ({ showModal: vi.fn(), showConfirmModal: vi.fn(async () => true), showNotification: vi.fn() }));
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
        initialTunnels: [],
        initialKnown: false,
        saveConfigToCore,
    });
    // Read from the core while a.yaml runs.
    api.setTunnels([{ ...tunnelA }, { ...tunnelB }], undefined, 'a.yaml');
    return { tunnelsList, api };
}

const unsavedRow = (list) => list.querySelector('[data-tunnels-unsaved]');
const deleteButtons = (list) => list.querySelectorAll('.btn-delete-icon');
/** Let a delete's confirmation resolve, so its row is gone before the next step. */
const confirmed = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Saves that wait for the test: answers[i](result) settles the i-th save. */
function heldSaves() {
    /** @type {Array<(v: any) => void>} */
    const answers = [];
    const save = vi.fn(() => new Promise((resolve) => { answers.push(resolve); }));
    return { answers, save };
}

/** Deletes tunnelA, then tunnelB, with held saves; returns once the first save is sent. */
async function twoHeldDeletes() {
    const { answers, save } = heldSaves();
    const { tunnelsList, api } = mount(save);
    const first = deleteButtons(tunnelsList)[0].onclick();
    await confirmed();
    const second = deleteButtons(tunnelsList)[0].onclick();
    await confirmed();
    await vi.waitFor(() => expect(answers).toHaveLength(1));
    return { answers, save, tunnelsList, api, first, second };
}


describe('tunnel list saves', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('a full save shows no retry', async () => {
        const save = vi.fn(async () => true);
        const { tunnelsList } = mount(save);
        await deleteButtons(tunnelsList)[0].onclick();
        expect(save).toHaveBeenCalledWith({ tunnels: [tunnelB] }, 'a.yaml');
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
        expect(save).toHaveBeenLastCalledWith({ tunnels: [tunnelB] }, 'a.yaml');
        expect(unsavedRow(tunnelsList)).not.toBeNull();

        // Retry reaches the profile: the row goes.
        save.mockResolvedValue(true);
        await unsavedRow(tunnelsList).querySelector('button').onclick();
        expect(save).toHaveBeenLastCalledWith({ tunnels: [tunnelB] }, 'a.yaml');
        expect(unsavedRow(tunnelsList)).toBeNull();
    });

    it('a queued save is not sent once the core was replaced; the list is read again', async () => {
        document.body.innerHTML = '<div id="list"></div><div id="empty"></div>';
        const tunnelsList = document.getElementById('list');
        const { answers, save } = heldSaves();
        let generation = 1;
        const readFromCore = vi.fn(async () => {});
        const api = initTunnelSettings({
            addTunnelBtn: null,
            tunnelsList,
            tunnelsEmpty: document.getElementById('empty'),
            initialTunnels: [],
            initialKnown: false,
            saveConfigToCore: save,
            readFromCore,
            readProfile: async () => 'a.yaml',
            coreGeneration: () => generation,
        });
        api.setTunnels([{ ...tunnelA }, { ...tunnelB }], undefined, 'a.yaml');
        const first = deleteButtons(tunnelsList)[0].onclick();
        await confirmed();
        const second = deleteButtons(tunnelsList)[0].onclick();
        await confirmed();
        await vi.waitFor(() => expect(answers).toHaveLength(1));
        // A core replaces the one both lists were read from.
        generation = 2;
        answers[0](true);
        await first;
        await second;
        expect(save).toHaveBeenCalledTimes(1);
        expect(readFromCore).toHaveBeenCalled();
    });

    it('an edit not sent to a replaced core is taken back when the list cannot be read again', async () => {
        document.body.innerHTML = '<div id="list"></div><div id="empty"></div>';
        const tunnelsList = document.getElementById('list');
        const { answers, save } = heldSaves();
        let generation = 1;
        const readFromCore = vi.fn(async () => { throw new Error('core not ready'); });
        const api = initTunnelSettings({
            addTunnelBtn: null,
            tunnelsList,
            tunnelsEmpty: document.getElementById('empty'),
            initialTunnels: [],
            initialKnown: false,
            saveConfigToCore: save,
            readFromCore,
            readProfile: async () => 'a.yaml',
            coreGeneration: () => generation,
        });
        api.setTunnels([{ ...tunnelA }, { ...tunnelB }], undefined, 'a.yaml');
        const first = deleteButtons(tunnelsList)[0].onclick();
        await confirmed();
        const second = deleteButtons(tunnelsList)[0].onclick();
        await confirmed();
        await vi.waitFor(() => expect(answers).toHaveLength(1));
        generation = 2;
        answers[0](true);
        await first;
        await second;
        // The first delete reached the old core; the second was never sent,
        // so its row is shown again.
        expect(save).toHaveBeenCalledTimes(1);
        expect(deleteButtons(tunnelsList)).toHaveLength(1);
    });

    it('a retry does not save another profile\'s list read during it', async () => {
        document.body.innerHTML = '<div id="list"></div><div id="empty"></div>';
        const tunnelsList = document.getElementById('list');
        const save = vi.fn(async () => 'partial');
        let running = 'a.yaml';
        /** @type {any} */
        let api = null;
        const readFromCore = vi.fn(async () => { api.setTunnels([{ ...tunnelA }], undefined, running); });
        api = initTunnelSettings({
            addTunnelBtn: null,
            tunnelsList,
            tunnelsEmpty: document.getElementById('empty'),
            initialTunnels: [],
            initialKnown: false,
            saveConfigToCore: save,
            readFromCore,
            readProfile: async () => running,
        });
        api.setTunnels([{ ...tunnelA }, { ...tunnelB }], undefined, 'a.yaml');
        await deleteButtons(tunnelsList)[0].onclick();
        expect(save).toHaveBeenCalledTimes(1);
        const row = unsavedRow(tunnelsList);
        expect(row).not.toBeNull();
        // The core runs b.yaml by the time the retry is clicked.
        running = 'b.yaml';
        await row.querySelector('button').onclick();
        expect(readFromCore).toHaveBeenCalled();
        expect(save).toHaveBeenCalledTimes(1);
    });

    it('saves go to the core one at a time, in the order they were started', async () => {
        const { answers, save, tunnelsList, first, second } = await twoHeldDeletes();
        await Promise.resolve();
        expect(save).toHaveBeenCalledTimes(1);
        expect(save).toHaveBeenLastCalledWith({ tunnels: [tunnelB] }, 'a.yaml');
        answers[0]('partial');
        await first;
        await vi.waitFor(() => expect(answers).toHaveLength(2));
        expect(save).toHaveBeenLastCalledWith({ tunnels: [] }, 'a.yaml');
        answers[1](true);
        await second;
        expect(unsavedRow(tunnelsList)).toBeNull();
    });

    it('a newer save that failed does not hide an older partial save', async () => {
        const { answers, tunnelsList, first, second } = await twoHeldDeletes();
        answers[0]('partial');
        await first;
        await vi.waitFor(() => expect(answers).toHaveLength(2));
        answers[1](false);
        await second;
        expect(unsavedRow(tunnelsList)).not.toBeNull();
    });

    it('a failed delete is not put back once a later save sent the list without it', async () => {
        const { answers, save, tunnelsList, first, second } = await twoHeldDeletes();
        answers[0](false);
        await first;
        await vi.waitFor(() => expect(answers).toHaveLength(2));
        expect(save).toHaveBeenLastCalledWith({ tunnels: [] }, 'a.yaml');
        answers[1](true);
        await second;
        expect(deleteButtons(tunnelsList)).toHaveLength(0);
    });

    it('a reset waits for the save in flight, and that save cannot clear the reset\'s retry', async () => {
        const { answers, save } = heldSaves();
        const { tunnelsList, api } = mount(save);
        const del = deleteButtons(tunnelsList)[0].onclick();
        await confirmed();
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

    it('a reset whose save throws counts as failed and leaves editing open', async () => {
        const save = vi.fn(async () => true);
        const { tunnelsList, api } = mount(save);
        const result = await api.saveAfterPending(async () => { throw new Error('ipc down'); }, 'a.yaml');
        expect(result).toBe(false);
        expect(api.resetAfterSave(result)).toBe(false);
        await deleteButtons(tunnelsList)[0].onclick();
        await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    });

    it('a read that started before or during a save does not replace its list', async () => {
        /** @type {(v: any) => void} */
        let answer = () => {};
        const save = vi.fn(() => new Promise((resolve) => { answer = resolve; }));
        const { tunnelsList, api } = mount(save);
        const before = api.readMark();
        const del = deleteButtons(tunnelsList)[0].onclick();
        await confirmed();
        const during = api.readMark();
        expect(api.setTunnels([{ ...tunnelA }, { ...tunnelB }], during)).toBe(false);
        await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
        answer('partial');
        await del;
        expect(api.setTunnels([{ ...tunnelA }, { ...tunnelB }], before)).toBe(false);
        expect(deleteButtons(tunnelsList)).toHaveLength(1);
        expect(unsavedRow(tunnelsList)).not.toBeNull();
        // A read started after the save is taken.
        expect(api.setTunnels([{ ...tunnelB }], api.readMark(), 'a.yaml')).toBe(true);
        expect(unsavedRow(tunnelsList)).not.toBeNull();
    });

    it('a failed save puts the tunnel back and changes nothing else', async () => {
        const save = vi.fn(async () => false);
        const { tunnelsList } = mount(save);
        await deleteButtons(tunnelsList)[0].onclick();
        expect(save).toHaveBeenCalledTimes(1);
        // Both rows are back, and the list model still holds both.
        expect(deleteButtons(tunnelsList)).toHaveLength(2);
        save.mockResolvedValue(true);
        await deleteButtons(tunnelsList)[1].onclick();
        expect(save).toHaveBeenLastCalledWith({ tunnels: [tunnelA] }, 'a.yaml');
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
        expect(save).toHaveBeenLastCalledWith({ tunnels: [] }, 'a.yaml');
        expect(unsavedRow(tunnelsList)).toBeNull();
    });

    it('retains an unconfirmed reset as the retry intent after a failed retry', async () => {
        const save = vi.fn(async () => false);
        const { tunnelsList, api } = mount(save);
        const result = await api.saveAfterPending(async () => 'unconfirmed', 'a.yaml');
        expect(api.resetAfterSave(result)).toBe(true);
        expect(deleteButtons(tunnelsList)).toHaveLength(0);
        api.setTunnels([{ ...tunnelA }, { ...tunnelB }], api.readMark(), 'a.yaml');
        expect(deleteButtons(tunnelsList)).toHaveLength(0);
        const row = unsavedRow(tunnelsList);
        expect(row).not.toBeNull();
        await row.querySelector('button').onclick();
        expect(deleteButtons(tunnelsList)).toHaveLength(0);
        expect(unsavedRow(tunnelsList)).not.toBeNull();
        save.mockResolvedValue(true);
        await unsavedRow(tunnelsList).querySelector('button').onclick();
        expect(save).toHaveBeenLastCalledWith({ tunnels: [] }, 'a.yaml');
        expect(unsavedRow(tunnelsList)).toBeNull();
    });

    it.each(['a.yaml', 'b.yaml'])('keeps an initially unread unconfirmed reset only for its target profile: %s', async (readProfile) => {
        document.body.innerHTML = '<div id="list"></div><div id="empty"></div>';
        const tunnelsList = document.getElementById('list');
        const save = vi.fn(async () => true);
        const api = initTunnelSettings({
            addTunnelBtn: null,
            tunnelsList,
            tunnelsEmpty: document.getElementById('empty'),
            initialTunnels: [], initialKnown: false,
            saveConfigToCore: save,
            coreGeneration: () => 1,
        });
        api.resetAfterSave(await api.saveAfterPending(async () => 'unconfirmed', 'a.yaml'));
        api.setTunnels([{ ...tunnelA }], api.readMark(), readProfile);
        if (readProfile === 'a.yaml') {
            expect(deleteButtons(tunnelsList)).toHaveLength(0);
            expect(unsavedRow(tunnelsList)).not.toBeNull();
            await unsavedRow(tunnelsList).querySelector('button').onclick();
            expect(save).toHaveBeenCalledWith({ tunnels: [] }, 'a.yaml');
        } else {
            expect(deleteButtons(tunnelsList)).toHaveLength(1);
            expect(unsavedRow(tunnelsList)).toBeNull();
            expect(save).not.toHaveBeenCalled();
        }
    });

    it('does not retry an unconfirmed edit over a replacement core list for the same profile', async () => {
        document.body.innerHTML = '<div id="list"></div><div id="empty"></div>';
        const tunnelsList = document.getElementById('list');
        const save = vi.fn(async () => 'unconfirmed');
        const newer = { network: ['tcp'], address: '127.0.0.1:7003', target: 'new.example.com:80' };
        let generation = 1;
        const readFromCore = vi.fn(async () => { api.setTunnels([{ ...tunnelA }, { ...tunnelB }, newer], api.readMark(), 'a.yaml'); });
        const api = initTunnelSettings({
            addTunnelBtn: null,
            tunnelsList,
            tunnelsEmpty: document.getElementById('empty'),
            initialTunnels: [], initialKnown: false,
            saveConfigToCore: save,
            readFromCore,
            readProfile: async () => 'a.yaml',
            coreGeneration: () => generation,
        });
        api.setTunnels([{ ...tunnelA }, { ...tunnelB }], undefined, 'a.yaml');
        await deleteButtons(tunnelsList)[0].onclick();
        const retry = unsavedRow(tunnelsList).querySelector('button');
        generation = 2;
        await retry.onclick();
        expect(readFromCore).toHaveBeenCalledOnce();
        expect(save).toHaveBeenCalledOnce();
        expect(deleteButtons(tunnelsList)).toHaveLength(3);
        expect(tunnelsList.textContent).toContain(newer.address);
        expect(unsavedRow(tunnelsList)).toBeNull();
    });

    it('restores the last pending list when a subsequent edit fails', async () => {
        const save = vi.fn().mockResolvedValueOnce('unconfirmed').mockResolvedValueOnce(false).mockResolvedValue(true);
        const { tunnelsList } = mount(save);
        await deleteButtons(tunnelsList)[0].onclick();
        expect(deleteButtons(tunnelsList)).toHaveLength(1);
        await deleteButtons(tunnelsList)[0].onclick();
        expect(deleteButtons(tunnelsList)).toHaveLength(1);
        expect(tunnelsList.textContent).toContain(tunnelB.address);
        await unsavedRow(tunnelsList).querySelector('button').onclick();
        expect(save).toHaveBeenLastCalledWith({ tunnels: [tunnelB] }, 'a.yaml');
        expect(unsavedRow(tunnelsList)).toBeNull();
    });

    it('saves of a list read from one profile go out checked against that profile', async () => {
        const save = vi.fn(async () => true);
        const { tunnelsList, api } = mount(save);
        expect(api.setTunnels([{ ...tunnelA }, { ...tunnelB }], api.readMark(), 'a.yaml')).toBe(true);
        await deleteButtons(tunnelsList)[0].onclick();
        expect(save).toHaveBeenLastCalledWith({ tunnels: [tunnelB] }, 'a.yaml');
    });

    it('a delete or retry during a reset is refused, so no list from before it lands after it', async () => {
        const notifications = await import('../notifications.js');
        const save = vi.fn(async () => true);
        const { tunnelsList, api } = mount(save);
        /** @type {Array<(v: any) => void>} */
        const resets = [];
        const first = api.saveAfterPending(() => new Promise((resolve) => { resets.push(resolve); }), 'a.yaml');
        const second = api.saveAfterPending(() => new Promise((resolve) => { resets.push(resolve); }), 'a.yaml');
        await deleteButtons(tunnelsList)[0].onclick();
        expect(notifications.showNotification).toHaveBeenCalledWith(expect.any(String), 'warning');
        expect(save).not.toHaveBeenCalled();
        expect(deleteButtons(tunnelsList)).toHaveLength(2);
        await vi.waitFor(() => expect(resets).toHaveLength(1));
        resets[0]('partial');
        expect(api.resetAfterSave(await first)).toBe(false);
        // The retry the first reset offers waits for the second as well.
        await unsavedRow(tunnelsList).querySelector('button').onclick();
        expect(save).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(resets).toHaveLength(2));
        resets[1](true);
        expect(api.resetAfterSave(await second)).toBe(true);
        expect(deleteButtons(tunnelsList)).toHaveLength(0);
        expect(unsavedRow(tunnelsList)).toBeNull();
    });

    it('a save files its list under the profile the list had when it started', async () => {
        const { answers, save } = heldSaves();
        const { tunnelsList, api } = mount(save);
        const first = deleteButtons(tunnelsList)[0].onclick();
        await confirmed();
        // b.yaml's list is read while the first save waits; a delete of it follows.
        api.setTunnels([{ ...tunnelB }], undefined, 'b.yaml');
        const second = deleteButtons(tunnelsList)[0].onclick();
        await vi.waitFor(() => expect(answers).toHaveLength(1));
        answers[0](true);
        await first;
        await vi.waitFor(() => expect(answers).toHaveLength(2));
        answers[1](true);
        await second;
        expect(save.mock.calls[0]).toEqual([{ tunnels: [tunnelB] }, 'a.yaml']);
        expect(save.mock.calls[1]).toEqual([{ tunnels: [] }, 'b.yaml']);
    });

    it('a partial reset checked against no known profile offers no retry that could reach any profile', async () => {
        const notifications = await import('../notifications.js');
        const save = vi.fn(async () => true);
        const { tunnelsList, api } = mount(save);
        expect(api.resetAfterSave(await api.saveAfterPending(async () => 'partial', null))).toBe(true);
        await unsavedRow(tunnelsList).querySelector('button').onclick();
        expect(notifications.showNotification).toHaveBeenCalledWith(expect.any(String), 'error');
        expect(save).not.toHaveBeenCalled();
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

    it('two deletes whose saves both failed bring both tunnels back', async () => {
        const { answers, tunnelsList, first, second } = await twoHeldDeletes();
        answers[0](false);
        await first;
        await vi.waitFor(() => expect(answers).toHaveLength(2));
        answers[1](false);
        await second;
        // Neither reached the core: it still runs both.
        expect(deleteButtons(tunnelsList)).toHaveLength(2);
    });

    it('a delete that failed while a reset waited comes back when the reset fails too', async () => {
        const { answers, save } = heldSaves();
        const { tunnelsList, api } = mount(save);
        const del = deleteButtons(tunnelsList)[0].onclick();
        await confirmed();
        const reset = api.saveAfterPending(async () => false);
        await vi.waitFor(() => expect(answers).toHaveLength(1));
        answers[0](false);
        await del;
        expect(api.resetAfterSave(await reset)).toBe(false);
        // Neither reached the core: it still runs both tunnels.
        expect(deleteButtons(tunnelsList)).toHaveLength(2);
    });

    it('a reset the core took makes the list known, so tunnels can be added', async () => {
        const notifications = await import('../notifications.js');
        document.body.innerHTML = '<button id="add"></button><div id="list"></div><div id="empty"></div>';
        const api = initTunnelSettings({
            addTunnelBtn: document.getElementById('add'),
            tunnelsList: document.getElementById('list'),
            tunnelsEmpty: document.getElementById('empty'),
            initialTunnels: [],
            initialKnown: false,
            saveConfigToCore: vi.fn(async () => true),
        });
        expect(api.resetAfterSave(await api.saveAfterPending(async () => true, 'a.yaml'))).toBe(true);
        document.getElementById('add').click();
        await vi.waitFor(() => expect(notifications.showModal).toHaveBeenCalled());
        expect(notifications.showNotification).not.toHaveBeenCalledWith(expect.any(String), 'error');
    });

    it('Add reads the core list again when the first read failed, instead of staying blocked', async () => {
        const notifications = await import('../notifications.js');
        vi.mocked(notifications.showModal).mockClear();
        vi.mocked(notifications.showNotification).mockClear();
        document.body.innerHTML = '<button id="add"></button><div id="list"></div><div id="empty"></div>';
        /** @type {any} */
        let api = null;
        const readFromCore = vi.fn(async () => {
            api.setTunnels([{ ...tunnelA }], api.readMark(), 'a.yaml');
        });
        api = initTunnelSettings({
            addTunnelBtn: document.getElementById('add'),
            tunnelsList: document.getElementById('list'),
            tunnelsEmpty: document.getElementById('empty'),
            initialTunnels: [],
            initialKnown: false,
            saveConfigToCore: vi.fn(async () => true),
            readFromCore,
        });
        document.getElementById('add').click();
        await vi.waitFor(() => expect(notifications.showModal).toHaveBeenCalled());
        expect(readFromCore).toHaveBeenCalledTimes(1);
        expect(notifications.showNotification).not.toHaveBeenCalledWith(expect.any(String), 'error');
    });

    it('a reset the core took files the empty list under the profile it was checked against', async () => {
        const save = vi.fn(async () => true);
        const { tunnelsList, api } = mount(save);
        expect(api.setTunnels([{ ...tunnelA }], api.readMark(), 'a.yaml')).toBe(true);
        expect(api.resetAfterSave(await api.saveAfterPending(async () => true, 'b.yaml'))).toBe(true);
        expect(api.setTunnels([{ ...tunnelB }], api.readMark(), 'b.yaml')).toBe(true);
        await deleteButtons(tunnelsList)[0].onclick();
        expect(save).toHaveBeenLastCalledWith({ tunnels: [] }, 'b.yaml');
    });

    it('a reset checked against no known profile leaves the list to be read again', async () => {
        const notifications = await import('../notifications.js');
        vi.mocked(notifications.showModal).mockClear();
        vi.mocked(notifications.showNotification).mockClear();
        document.body.innerHTML = '<button id="add"></button><div id="list"></div><div id="empty"></div>';
        const api = initTunnelSettings({
            addTunnelBtn: document.getElementById('add'),
            tunnelsList: document.getElementById('list'),
            tunnelsEmpty: document.getElementById('empty'),
            initialTunnels: [],
            initialKnown: true,
            saveConfigToCore: vi.fn(async () => true),
        });
        expect(api.resetAfterSave(await api.saveAfterPending(async () => true, null))).toBe(true);
        document.getElementById('add')?.click();
        await vi.waitFor(() => expect(notifications.showNotification).toHaveBeenCalledWith(expect.any(String), 'error'));
        expect(notifications.showModal).not.toHaveBeenCalled();
    });

    it('a delete button drawn before an earlier delete removes its own tunnel', async () => {
        const save = vi.fn(async () => true);
        const { tunnelsList } = mount(save);
        const [delA, delB] = deleteButtons(tunnelsList);
        const first = delA.onclick();
        await confirmed();
        const second = delB.onclick();
        await confirmed();
        await first;
        await second;
        expect(save.mock.calls.map(([patch]) => patch)).toEqual([
            { tunnels: [tunnelB] }, { tunnels: [] },
        ]);
        expect(deleteButtons(tunnelsList)).toHaveLength(0);
    });

    it('adds nothing until the core\'s list was read', async () => {
        const notifications = await import('../notifications.js');
        document.body.innerHTML = '<button id="add"></button><div id="list"></div><div id="empty"></div>';
        const api = initTunnelSettings({
            addTunnelBtn: document.getElementById('add'),
            tunnelsList: document.getElementById('list'),
            tunnelsEmpty: document.getElementById('empty'),
            initialTunnels: [],
            initialKnown: false,
            saveConfigToCore: vi.fn(async () => true),
        });
        document.getElementById('add').click();
        await vi.waitFor(() => expect(notifications.showNotification).toHaveBeenCalledWith(expect.any(String), 'error'));
        expect(notifications.showModal).not.toHaveBeenCalled();
        api.setTunnels([{ ...tunnelA }], api.readMark(), 'a.yaml');
        document.getElementById('add').click();
        await vi.waitFor(() => expect(notifications.showModal).toHaveBeenCalled());
    });

    it('reading the same list back keeps the retry; one of another profile clears it', async () => {
        const save = vi.fn(async () => 'partial');
        const { tunnelsList, api } = mount(save);
        await deleteButtons(tunnelsList)[0].onclick();
        api.setTunnels([{ ...tunnelB }], undefined, 'a.yaml');
        expect(unsavedRow(tunnelsList)).not.toBeNull();
        // Its properties read back in another order: still the same list.
        api.setTunnels([{ target: tunnelB.target, address: tunnelB.address, network: ['udp'] }], undefined, 'a.yaml');
        expect(unsavedRow(tunnelsList)).not.toBeNull();
        // The same list read from another profile: nothing of a.yaml's to retry there.
        api.setTunnels([{ ...tunnelB }], undefined, 'b.yaml');
        expect(unsavedRow(tunnelsList)).toBeNull();
    });

    it('a delete confirmed after another profile\'s list replaced the shown one is dropped', async () => {
        const notifications = await import('../notifications.js');
        /** @type {(v: boolean) => void} */
        let confirm = () => {};
        notifications.showConfirmModal.mockImplementationOnce(() => new Promise((resolve) => { confirm = resolve; }));
        const save = vi.fn(async () => true);
        const { tunnelsList, api } = mount(save);
        const del = deleteButtons(tunnelsList)[0].onclick();
        // b.yaml runs now and holds the same rule.
        api.setTunnels([{ ...tunnelA }], undefined, 'b.yaml');
        confirm(true);
        await del;
        expect(save).not.toHaveBeenCalled();
    });
    it('a list of a profile the core no longer runs is read again before an edit', async () => {
        const notifications = await import('../notifications.js');
        vi.mocked(notifications.showModal).mockClear();
        document.body.innerHTML = '<button id="add"></button><div id="list"></div><div id="empty"></div>';
        /** @type {any} */
        let api = null;
        let running = 'a.yaml';
        const readFromCore = vi.fn(async () => {
            api.setTunnels([{ ...tunnelB }], api.readMark(), running);
        });
        const save = vi.fn(async () => true);
        api = initTunnelSettings({
            addTunnelBtn: document.getElementById('add'),
            tunnelsList: document.getElementById('list'),
            tunnelsEmpty: document.getElementById('empty'),
            initialTunnels: [],
            initialKnown: false,
            saveConfigToCore: save,
            readFromCore,
            readProfile: async () => running,
        });
        api.setTunnels([{ ...tunnelA }], undefined, 'a.yaml');
        // Same profile: nothing is read again.
        document.getElementById('add').click();
        await vi.waitFor(() => expect(notifications.showModal).toHaveBeenCalledTimes(1));
        expect(readFromCore).not.toHaveBeenCalled();
        // The core switched to b.yaml while Settings stayed open: a delete
        // of a.yaml's row reads b.yaml's list and is dropped.
        running = 'b.yaml';
        await deleteButtons(document.getElementById('list'))[0].onclick();
        expect(readFromCore).toHaveBeenCalledTimes(1);
        expect(save).not.toHaveBeenCalled();
        // The next delete removes b.yaml's row and saves it under b.yaml.
        await deleteButtons(document.getElementById('list'))[0].onclick();
        expect(save).toHaveBeenLastCalledWith({ tunnels: [] }, 'b.yaml');
    });
    it('a list of a profile the core no longer runs is not edited when reading it again fails', async () => {
        const notifications = await import('../notifications.js');
        vi.mocked(notifications.showNotification).mockClear();
        document.body.innerHTML = '<button id="add"></button><div id="list"></div><div id="empty"></div>';
        let running = 'a.yaml';
        const readFromCore = vi.fn(async () => { throw new Error('core busy'); });
        const save = vi.fn(async () => true);
        const api = initTunnelSettings({
            addTunnelBtn: document.getElementById('add'),
            tunnelsList: document.getElementById('list'),
            tunnelsEmpty: document.getElementById('empty'),
            initialTunnels: [],
            initialKnown: false,
            saveConfigToCore: save,
            readFromCore,
            readProfile: async () => running,
        });
        api.setTunnels([{ ...tunnelA }], undefined, 'a.yaml');
        running = 'b.yaml';
        // b.yaml's list could not be read: a.yaml's row is not deleted from b.yaml.
        await deleteButtons(document.getElementById('list'))[0].onclick();
        expect(readFromCore).toHaveBeenCalledTimes(1);
        expect(save).not.toHaveBeenCalled();
        expect(notifications.showNotification).toHaveBeenCalledWith(expect.any(String), 'error');
    });
});

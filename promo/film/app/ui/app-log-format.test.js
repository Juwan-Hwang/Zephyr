// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { translations } from '../i18n.js';
import { appLogLabel, formatAppLogMessage, appLogLevel } from './app-log-format.js';

const zh = /** @type {Record<string, string>} */ (/** @type {any} */ (translations).zh);
const en = /** @type {Record<string, string>} */ (/** @type {any} */ (translations).en);

describe('app log formatting', () => {
    it('localizes badges for Prism events and backend levels', () => {
        expect(appLogLabel({ type: 'PatchApplied', message: '', timestamp: '' }, zh)).toBe('补丁已应用');
        expect(appLogLabel({ type: 'warn', message: '', timestamp: '', source: 'backend' }, zh)).toBe('警告');
        expect(appLogLabel({ type: 'Mystery', message: '', timestamp: '' }, zh)).toBe('Mystery');
    });

    it('formats event payloads in the UI language', () => {
        const watcher = { type: 'WatcherStatus', message: 'Watching 1 dir(s)', timestamp: '', data: { running: true, watching_count: 3 } };
        // watching_count is a directory count, so no file count is shown
        expect(formatAppLogMessage(watcher, en).text).toBe('Watcher');
        const files = { ...watcher, data: { running: true, file_count: 3 } };
        expect(formatAppLogMessage(files, zh).text).toBe('正在监听 3 个文件');

        const rules = { type: 'RulesChanged', message: '', timestamp: '', data: { added: 2, removed: 1 } };
        expect(formatAppLogMessage(rules, zh).text).toBe('新增 2, 删除 1');
        expect(formatAppLogMessage({ ...rules, data: {} }, zh).text).toBe('无变更');

        const applied = { type: 'PatchApplied', message: '', timestamp: '', data: { patch_id: 'ai', added: 3, duration: '4ms' } };
        expect(formatAppLogMessage(applied, zh).text).toBe('ai [+3] 耗时 4ms');

        const change = { type: 'WatcherEvent', message: '', timestamp: '', data: { file: 'a.prism.yaml', change_type: 'modified' } };
        expect(formatAppLogMessage(change, zh).text).toBe('修改 a.prism.yaml');

        const reload = { type: 'ConfigReloaded', message: '', timestamp: '', data: { success: false } };
        expect(formatAppLogMessage(reload, zh).text).toBe('失败');
    });

    it('escapes payload text and falls back to the raw message', () => {
        const failed = { type: 'PatchFailed', message: '', timestamp: '', data: { patch_id: '<x>', error: '<b>bad</b>' } };
        expect(formatAppLogMessage(failed, zh).html).not.toContain('<b>bad');
        expect(formatAppLogMessage({ type: 'Other', message: 'plain', timestamp: '' }, zh).text).toBe('plain');
        const backend = { type: 'info', message: '[core] started', timestamp: '', source: 'backend' };
        expect(formatAppLogMessage(backend, zh).text).toBe('[core] started');
    });
});

describe('appLogLevel', () => {
    it('keeps plain levels and counts Prism failures as errors', () => {
        expect(appLogLevel({ type: 'warn', message: '', timestamp: '' })).toBe('warn');
        expect(appLogLevel({ type: 'PatchFailed', message: '', timestamp: '' })).toBe('error');
        expect(appLogLevel({ type: 'ConfigReloaded', message: '', timestamp: '', data: { success: false } })).toBe('error');
        expect(appLogLevel({ type: 'ConfigReloaded', message: '', timestamp: '', data: { success: true } })).toBe('info');
        expect(appLogLevel({ type: 'WatcherEvent', message: '', timestamp: '' })).toBe('info');
    });
});

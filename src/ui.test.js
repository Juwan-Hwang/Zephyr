import { describe, it, expect, vi } from 'vitest';
import { translations } from './i18n.js';

describe('i18n tests', () => {
  it('should have translations for both en and zh', () => {
    expect(translations).toBeDefined();
    expect(translations.en).toBeDefined();
    expect(translations.zh).toBeDefined();
  });
  
  it('should have settings translation in both languages', () => {
    expect(translations.en.settings).toBeDefined();
    expect(translations.zh.settings).toBeDefined();
  });
});
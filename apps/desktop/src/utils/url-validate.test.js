import { describe, it, expect } from 'vitest';
import { validateHttpUrl } from './url-validate.js';

describe('validateHttpUrl', () => {
    it('accepts http and https links', () => {
        expect(validateHttpUrl('https://sub.example.com/api/v1?token=abc')).toBe('');
        expect(validateHttpUrl('  http://1.2.3.4:8080/x  ')).toBe('');
        // The backend percent-encodes spaces in the path and query.
        expect(validateHttpUrl('https://host/sub?name=My Sub')).toBe('');
    });
    it('flags empty input', () => {
        expect(validateHttpUrl('')).toBe('empty');
        expect(validateHttpUrl('   ')).toBe('empty');
        expect(validateHttpUrl(null)).toBe('empty');
    });
    it('flags links without http(s)', () => {
        expect(validateHttpUrl('ftp://example.com/a')).toBe('scheme');
        expect(validateHttpUrl('vmess://abc')).toBe('scheme');
        expect(validateHttpUrl('example.com/sub')).toBe('scheme');
    });
    it('flags text that is not a link', () => {
        expect(validateHttpUrl('hello')).toBe('invalid');
        expect(validateHttpUrl('https://exa mple.com')).toBe('invalid');
        expect(validateHttpUrl('https://')).toBe('invalid');
    });
});

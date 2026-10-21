// @ts-check
/**
 * @module utils/version-utils
 *
 * SemVer 2.0.0 compliant version comparison utilities.
 * Extracted from main.js so both automatic and manual update
 * checks share the same normalization and comparison logic.
 */

/**
 * Normalize a version string: trim whitespace and strip leading 'v'/'V' prefix.
 * @param {string} v
 * @returns {string}
 */
export function normalizeVersion(v) {
  if (v == null) return '';
  return String(v).trim().replace(/^[vV]/, '');
}

/**
 * Parse a version string into main segments and optional prerelease identifiers.
 * Build metadata (after +) is stripped per SemVer 10.
 * @param {string} s
 * @returns {{ main: number[], prerelease: string[] }}
 */
export function parseSemVer(s) {
  const plusIdx = s.indexOf('+');
  const cleaned = plusIdx === -1 ? s : s.slice(0, plusIdx);
  const dashIdx = cleaned.indexOf('-');
  const main = dashIdx === -1 ? cleaned : cleaned.slice(0, dashIdx);
  const pre = dashIdx === -1 ? '' : cleaned.slice(dashIdx + 1);
  return {
    main: main.split('.').map(n => Number.parseInt(n, 10) || 0),
    prerelease: pre ? pre.split('.') : [],
  };
}

/**
 * Compare two prerelease identifier strings per SemVer 11.4.
 * Returns positive if a > b, negative if a < b, 0 if equal.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function comparePrereleaseIds(a, b) {
  const aNum = /^\d+$/.test(a) ? Number.parseInt(a, 10) : null;
  const bNum = /^\d+$/.test(b) ? Number.parseInt(b, 10) : null;
  if (aNum !== null && bNum !== null) return aNum - bNum;
  if (aNum !== null) return -1; // numeric < non-numeric (SemVer 11.4.3)
  if (bNum !== null) return 1;  // non-numeric > numeric
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Compare main version segments (e.g. [1,2,3] vs [1,2,4]).
 * Returns positive if a > b, negative if a < b, 0 if equal.
 * @param {number[]} aMain
 * @param {number[]} bMain
 * @returns {number}
 */
function compareMainSegments(aMain, bMain) {
  const len = Math.max(aMain.length, bMain.length);
  for (let i = 0; i < len; i++) {
    const av = aMain[i] || 0;
    const bv = bMain[i] || 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

/**
 * Compare prerelease identifier arrays per SemVer 11.4.
 * Returns positive if a > b, negative if a < b, 0 if equal.
 * @param {string[]} aPre
 * @param {string[]} bPre
 * @returns {number}
 */
function comparePrerelease(aPre, bPre) {
  const len = Math.max(aPre.length, bPre.length);
  for (let i = 0; i < len; i++) {
    const av = aPre[i];
    const bv = bPre[i];
    if (av === undefined) return -1; // shorter prerelease has lower precedence
    if (bv === undefined) return 1;
    const cmp = comparePrereleaseIds(av, bv);
    if (cmp !== 0) return cmp;
  }
  return 0;
}

/**
 * Check whether the remote version is strictly newer than the local version
 * following SemVer 2.0.0 precedence rules.
 * @param {string} remote
 * @param {string} local
 * @returns {boolean}
 */
export function isRemoteNewer(remote, local) {
  const r = parseSemVer(remote);
  const l = parseSemVer(local);

  const mainCmp = compareMainSegments(r.main, l.main);
  if (mainCmp !== 0) return mainCmp > 0;

  // Main equal: release (no prerelease) > prerelease
  const rHasPre = r.prerelease.length > 0;
  const lHasPre = l.prerelease.length > 0;
  if (!rHasPre && lHasPre) return true;
  if (rHasPre && !lHasPre) return false;
  if (!rHasPre) return false; // both are releases — equal

  // Both have prerelease: compare identifiers
  return comparePrerelease(r.prerelease, l.prerelease) > 0;
}

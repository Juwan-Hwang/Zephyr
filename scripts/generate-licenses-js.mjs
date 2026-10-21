#!/usr/bin/env node
/**
 * Generates the JavaScript section of THIRD-PARTY-LICENSES.txt.
 *
 * The component set is the production dependency tree of the desktop app,
 * as reported by `pnpm licenses list --prod --json` (run in apps/desktop).
 * License texts are read verbatim from each installed package's own
 * LICENSE/COPYING/NOTICE files. SPDX metadata files (LICENSE.spdx) do
 * not count: they declare a package's licenses but carry no license
 * text. Generation fails if a package ships no license text file, so
 * an incomplete notices file can never be produced silently — resolve
 * such a package by adding its text to
 * scripts/third-party-assets-licenses.txt with a note instead.
 *
 * Usage: node scripts/generate-licenses-js.mjs <output-file>
 * Requires: pnpm install has been run for the workspace.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const outPath = process.argv[2];
if (!outPath) {
    console.error('usage: generate-licenses-js.mjs <output-file>');
    process.exit(2);
}

// fileURLToPath, not URL.pathname: on Windows the pathname is not a
// filesystem path ("/D:/a/..." with a leading slash, percent-escapes
// left in), which breaks both the cwd below and the store lookups.
const desktopDir = fileURLToPath(new URL('../apps/desktop/', import.meta.url));

const raw = execFileSync(
    'pnpm',
    ['licenses', 'list', '--prod', '--json'],
    {
        cwd: desktopDir,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        // pnpm is a .cmd shim on Windows, and Node cannot spawn .cmd/.bat
        // files without a shell (EINVAL since the CVE-2024-27980 fix).
        // The arguments are fixed literals, so a shell is safe here.
        shell: process.platform === 'win32',
    },
);
const byLicense = JSON.parse(raw);

/** @type {Map<string, {name: string, version: string, license: string, paths: string[]}>} */
const packages = new Map();
for (const [license, entries] of Object.entries(byLicense)) {
    for (const e of entries) {
        for (const version of e.versions) {
            const key = `${e.name}@${version}`;
            if (!packages.has(key)) {
                packages.set(key, { name: e.name, version, license, paths: e.paths ?? [] });
            }
        }
    }
}

const LICENSE_FILE = /^(LICEN[CS]E|COPYING|NOTICE)([._-].*)?$/i;
// SPDX metadata declares a package's licenses but is not license text.
const SPDX_METADATA = /\.spdx$/i;

// Packages whose license texts are maintained by hand in
// scripts/third-party-assets-licenses.txt (Part 3) instead of being
// picked up here — currently those whose npm tarball ships no license
// text files at all. The map value pins the version the hand-written
// entry covers: if the lockfile moves to another version, generation
// fails until the Part 3 entry is updated. Remove a package from this
// map if it starts shipping its texts.
const TEXT_IN_ASSETS_FILE = new Map([['@tauri-apps/plugin-autostart', '2.7.0']]);

// `pnpm licenses list` reports the paths a package is referenced from, which
// do not always exist on disk (no symlink is created for purely transitive
// dependencies). The pnpm store layout is the reliable location:
// node_modules/.pnpm/<name with "/" as "+">@<version>[_peer-suffix]/
// node_modules/<name>. Resolve both.
const storeRoots = [
    join(desktopDir, 'node_modules', '.pnpm'),
    join(desktopDir, '..', '..', 'node_modules', '.pnpm'),
].filter((d) => existsSync(d));

function candidateDirs(pkg) {
    const dirs = [];
    const encoded = `${pkg.name.replace('/', '+')}@${pkg.version}`;
    for (const root of storeRoots) {
        const exact = join(root, encoded, 'node_modules', pkg.name);
        if (existsSync(exact)) {
            dirs.push(exact);
            continue;
        }
        const withPeerSuffix = readdirSync(root).find(
            (e) => e === encoded || e.startsWith(`${encoded}_`),
        );
        if (withPeerSuffix) dirs.push(join(root, withPeerSuffix, 'node_modules', pkg.name));
    }
    // The paths reported by `pnpm licenses list` are only a fallback:
    // they are grouped by package name, not by version, so for a
    // package installed at two versions they can point at the other
    // version's directory. licenseTextsFor verifies each directory's
    // package.json before reading license files from it.
    dirs.push(...pkg.paths);
    return dirs;
}

// A candidate directory only counts if it really holds this package at
// this version; a directory without a package.json cannot be checked
// and is left to the caller's fallback order.
function dirMatchesPackage(dir, pkg) {
    const manifestPath = join(dir, 'package.json');
    if (!existsSync(manifestPath)) return true;
    try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        return manifest.name === pkg.name && manifest.version === pkg.version;
    } catch {
        return false;
    }
}

function licenseTextsFor(pkg) {
    for (const dir of candidateDirs(pkg)) {
        if (!existsSync(dir)) continue;
        if (!dirMatchesPackage(dir, pkg)) continue;
        const files = readdirSync(dir)
            .filter((f) => LICENSE_FILE.test(f) && !SPDX_METADATA.test(f))
            .sort();
        if (files.length > 0) {
            return files.map((f) => readFileSync(join(dir, f), 'utf8').trimEnd());
        }
    }
    return [];
}

// Pin the comparison locale: with the machine's default locale, the
// section order (and thus the generated file) could differ between
// machines and trip the CI drift check.
const sorted = [...packages.values()].sort((a, b) =>
    `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, 'en'),
);

const missing = [];
const sections = [];
for (const pkg of sorted) {
    const manualVersion = TEXT_IN_ASSETS_FILE.get(pkg.name);
    if (manualVersion !== undefined) {
        if (pkg.version !== manualVersion) {
            missing.push(
                `${pkg.name}@${pkg.version} (hand-written text in Part 3 covers ${manualVersion}; update scripts/third-party-assets-licenses.txt)`,
            );
        }
        continue;
    }
    const texts = licenseTextsFor(pkg);
    if (texts.length === 0) {
        missing.push(`${pkg.name}@${pkg.version} (${pkg.license})`);
        continue;
    }
    sections.push(
        `----------------------------------------------------------------------\n` +
        `${pkg.name} ${pkg.version} — License: ${pkg.license}\n` +
        `----------------------------------------------------------------------\n\n` +
        texts.join('\n\n'),
    );
}

if (missing.length > 0) {
    console.error('Packages without a license file (resolve manually, see header):');
    for (const m of missing) console.error(`  - ${m}`);
    process.exit(1);
}

const header = `======================================================================
PART 2 — JAVASCRIPT COMPONENTS
======================================================================

The following JavaScript packages are included in Zephyr's distributed
binaries (production dependencies of the desktop app). License texts are
reproduced verbatim from each package's own license files.

`;

writeFileSync(outPath, header + sections.join('\n\n') + '\n');
console.log(`Wrote ${sections.length} JavaScript components to ${outPath}`);

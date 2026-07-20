#!/usr/bin/env python3
"""Merge CycloneDX SBOM files from Rust (cargo-cyclonedx) and NPM (cdxgen).

Usage:
    python3 scripts/merge-sboms.py [--output sbom/bom.cdx.json]

Scans ``sbom/rust/*.cdx.json`` and ``sbom/npm/*.cdx.json`` for CycloneDX BOM
files, deduplicates components by ``bom-ref``, merges dependencies, and writes
a single combined BOM to the output path (default: ``sbom/bom.cdx.json``).
"""
import argparse
import glob
import json
import os
import sys

# Allowed base directory for all file I/O — prevents path traversal.
_BASE_DIR = os.path.abspath(".")


def _safe_path(path: str) -> str:
    """Resolve *path* and verify it is contained within ``_BASE_DIR``.

    Raises ``ValueError`` if the resolved path escapes the working directory.
    """
    resolved = os.path.abspath(path)
    if os.path.commonpath([_BASE_DIR, resolved]) != _BASE_DIR:
        raise ValueError(f"Path escapes working directory: {path!r}")
    return resolved


def _merge_metadata_tools(merged_meta: dict, new_tools: object) -> None:
    """Merge ``metadata.tools`` from a source BOM into the merged metadata.

    CycloneDX 1.4 uses a flat list of tool objects, while 1.5 uses an object
    with ``components`` and ``services`` arrays.  Both forms are handled.
    ``None`` values (from explicit JSON ``null``) are treated as empty.
    """
    if new_tools is None:
        return
    if isinstance(new_tools, list):
        bucket = merged_meta.setdefault("tools", [])
        if isinstance(bucket, dict):
            # Up-convert: existing was 1.5-style dict, new is 1.4-style list.
            bucket = {"components": bucket.get("components", []), "services": bucket.get("services", [])}
            merged_meta["tools"] = bucket
            _dedup_extend(bucket.setdefault("components", []), new_tools)
        else:
            _dedup_extend(bucket, new_tools)
    elif isinstance(new_tools, dict):
        existing = merged_meta.setdefault("tools", {})
        if isinstance(existing, list):
            # Up-convert: existing was 1.4-style list, new is 1.5-style dict.
            merged_meta["tools"] = {"components": existing, "services": []}
            existing = merged_meta["tools"]
        for key in ("components", "services"):
            items = new_tools.get(key) or []
            if isinstance(items, list):
                _dedup_extend(existing.setdefault(key, []), items)


def _dedup_extend(target: list, source: list) -> None:
    """Extend *target* with items from *source*, skipping duplicates.

    Deduplicates by ``name`` + ``version`` (or ``bom-ref`` if present) so that
    the same tool (e.g. ``cargo-cyclonedx``) appearing in multiple SBOMs is
    only recorded once.
    """
    seen = set()
    for item in target:
        if isinstance(item, dict):
            key = item.get("bom-ref") or (item.get("name"), item.get("version"))
            seen.add(key)
    for item in source:
        if isinstance(item, dict):
            key = item.get("bom-ref") or (item.get("name"), item.get("version"))
            if key not in seen:
                seen.add(key)
                target.append(item)
        elif item not in target:
            target.append(item)


def merge_sboms(output_path: str) -> None:
    # Validate output path before any file I/O (SonarCloud S9315).
    safe_output = _safe_path(output_path)

    merged = {
        "bomFormat": "CycloneDX",
        "specVersion": "1.5",
        "components": [],
        "dependencies": [],
    }
    seen_components: set[str] = set()
    dep_map: dict[str, set[str]] = {}
    files_processed = 0

    for pattern in ["sbom/rust/*.cdx.json", "sbom/npm/*.cdx.json"]:
        for f in sorted(glob.glob(pattern)):
            safe_input = _safe_path(f)
            files_processed += 1
            with open(safe_input, encoding="utf-8") as fh:
                bom = json.load(fh)
            for comp in bom.get("components") or []:
                ref = comp.get("bom-ref")
                if ref and ref not in seen_components:
                    seen_components.add(ref)
                    merged["components"].append(comp)
                elif not ref:
                    merged["components"].append(comp)
            for dep in bom.get("dependencies") or []:
                ref = dep.get("ref")
                if ref:
                    dep_map.setdefault(ref, set()).update(dep.get("dependsOn") or [])
                else:
                    merged["dependencies"].append(dep)
            # Merge metadata: keep the first SBOM's metadata as base, then
            # accumulate tools entries from subsequent SBOMs so that tool
            # attribution from all ecosystems is preserved.
            bom_meta = bom.get("metadata")
            if isinstance(bom_meta, dict):
                if "metadata" not in merged:
                    merged["metadata"] = bom_meta
                else:
                    _merge_metadata_tools(
                        merged["metadata"], bom_meta.get("tools")
                    )

    if files_processed == 0:
        print(
            "ERROR: No input SBOM files found matching sbom/rust/*.cdx.json"
            " or sbom/npm/*.cdx.json",
            file=sys.stderr,
        )
        sys.exit(1)

    # Reconstruct dependencies from dep_map
    for ref, deps in dep_map.items():
        merged["dependencies"].append({"ref": ref, "dependsOn": sorted(deps)})

    # Ensure output directory exists (path already validated above).
    out_dir = os.path.dirname(safe_output)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)

    with open(safe_output, "w", encoding="utf-8") as out:
        json.dump(merged, out, indent=2)

    comps = merged.get("components") or []
    print("=== Merged SBOM ===")
    print(f"Output: {safe_output}")
    print(f"Input files: {files_processed}")
    print(f"Total components: {len(comps)}")

    types: dict[str, int] = {}
    for c in comps:
        t = c.get("type", "unknown")
        types[t] = types.get(t, 0) + 1

    for t, n in sorted(types.items()):
        print(f"  {t}: {n}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Merge CycloneDX SBOM files")
    parser.add_argument(
        "--output",
        default="sbom/bom.cdx.json",
        help="Output path for merged BOM (default: sbom/bom.cdx.json)",
    )
    args = parser.parse_args()
    merge_sboms(args.output)

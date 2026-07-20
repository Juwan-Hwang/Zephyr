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


def _validate_output_path(output_path: str) -> str:
    """Ensure the resolved output path stays within the working directory.

    Prevents path traversal via CLI arguments (SonarCloud S9315).
    """
    cwd = os.path.abspath(".")
    resolved = os.path.abspath(output_path)
    if os.path.commonpath([cwd, resolved]) != cwd:
        raise ValueError(f"Output path escapes working directory: {output_path!r}")
    return resolved


def merge_sboms(output_path: str) -> None:
    validated_path = _validate_output_path(output_path)

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
            files_processed += 1
            with open(f, encoding="utf-8") as fh:
                bom = json.load(fh)
            for comp in bom.get("components", []):
                ref = comp.get("bom-ref")
                if ref and ref not in seen_components:
                    seen_components.add(ref)
                    merged["components"].append(comp)
                elif not ref:
                    merged["components"].append(comp)
            for dep in bom.get("dependencies", []):
                ref = dep.get("ref")
                if ref:
                    dep_map.setdefault(ref, set()).update(dep.get("dependsOn", []))
                else:
                    merged["dependencies"].append(dep)
            # Merge metadata: keep the first SBOM's metadata as base, then
            # accumulate tools entries from subsequent SBOMs so that tool
            # attribution from all ecosystems is preserved.
            if "metadata" in bom:
                if "metadata" not in merged:
                    merged["metadata"] = bom["metadata"]
                else:
                    bt = bom["metadata"].get("tools")
                    if bt:
                        mt = merged["metadata"].setdefault("tools", [])
                        if isinstance(bt, list):
                            mt.extend(bt)
                        elif isinstance(bt, dict):
                            mt.append(bt)

    if files_processed == 0:
        print("ERROR: No input SBOM files found matching sbom/rust/*.cdx.json"
              " or sbom/npm/*.cdx.json", file=sys.stderr)
        sys.exit(1)

    # Reconstruct dependencies from dep_map
    for ref, deps in dep_map.items():
        merged["dependencies"].append({"ref": ref, "dependsOn": sorted(deps)})

    # Ensure output directory exists
    os.makedirs(os.path.dirname(validated_path) or ".", exist_ok=True)

    with open(validated_path, "w", encoding="utf-8") as out:
        json.dump(merged, out, indent=2)

    comps = merged.get("components", [])
    print("=== Merged SBOM ===")
    print(f"Output: {validated_path}")
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

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


def merge_sboms(output_path: str) -> None:
    merged = {
        "bomFormat": "CycloneDX",
        "specVersion": "1.5",
        "components": [],
        "dependencies": [],
    }
    seen_components: set[str] = set()
    dep_map: dict[str, set[str]] = {}

    for pattern in ["sbom/rust/*.cdx.json", "sbom/npm/*.cdx.json"]:
        for f in sorted(glob.glob(pattern)):
            with open(f) as fh:
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
            if "metadata" not in merged and "metadata" in bom:
                merged["metadata"] = bom["metadata"]

    # Reconstruct dependencies from dep_map
    for ref, deps in dep_map.items():
        merged["dependencies"].append({"ref": ref, "dependsOn": sorted(deps)})

    # Ensure output directory exists
    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)

    with open(output_path, "w") as out:
        json.dump(merged, out, indent=2)

    comps = merged.get("components", [])
    print("=== Merged SBOM ===")
    print(f"Output: {output_path}")
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

#!/usr/bin/env python3
"""
Zephyr Demo Injection Script (v2)

Injects demo bootstrap code into Zephyr's index.html and main.js
to enable browser-based mock functionality.
Also patches subscriptions.js for cache-busting renderConfigs(true).
"""

import sys
import re
from pathlib import Path

DEMO_BOOTSTRAP = '''
<!-- Demo Bootstrap -->
<script>
// Create mutable target for demo API injection
var _demoTarget = {
  invoke: function(cmd, args) { return Promise.resolve(null); },
  transformCallback: function(fn) { return 'mock-cb'; },
  metadata: { currentWindow: { label: 'main' } },
};
window.__TAURI_INTERNALS__ = new Proxy(_demoTarget, {
  get: function(target, prop) { return target[prop]; },
  set: function(target, prop, value) { target[prop] = value; return true; }
});
window.__DEMO_INTERNALS_TARGET__ = _demoTarget;
window.__AETHER_DEMO__ = true;
</script>
<!-- End Demo Bootstrap -->
'''

MAIN_JS_INJECTION = '''
// Demo API loader
await import('./demo/mock-api.js');
'''

def inject_index_html(app_dir: Path):
    """Inject demo bootstrap into index.html"""
    index_path = app_dir / 'index.html'
    if not index_path.exists():
        print(f"Error: {index_path} not found")
        return False

    content = index_path.read_text(encoding='utf-8')

    if 'DEMO_INTERNALS_TARGET' in content:
        print("index.html already has demo bootstrap")
        return True

    if '</head>' in content:
        content = content.replace('</head>', DEMO_BOOTSTRAP + '</head>')
    else:
        content = content.replace('<body>', '<body>' + DEMO_BOOTSTRAP)

    index_path.write_text(content, encoding='utf-8')
    print("Injected demo bootstrap into index.html")
    return True

def inject_main_js(app_dir: Path):
    """Inject mock-api loader into main.js"""
    main_path = app_dir / 'main.js'
    if not main_path.exists():
        print(f"Warning: {main_path} not found")
        return False

    content = main_path.read_text(encoding='utf-8')

    if 'mock-api.js' in content:
        print("main.js already has mock-api loader")
        return True

    patterns = [
        r'(async function initApp\(\)\s*\{)',
        r'(function initApp\(\)\s*\{)',
        r'(const initApp\s*=\s*async\s*\(\)\s*=>\s*\{)',
        r'(const initApp\s*=\s*\(\)\s*=>\s*\{)',
    ]

    for pattern in patterns:
        match = re.search(pattern, content)
        if match:
            insert_pos = match.end()
            content = content[:insert_pos] + MAIN_JS_INJECTION + content[insert_pos:]
            main_path.write_text(content, encoding='utf-8')
            print("Injected mock-api loader into main.js")
            return True

    content = MAIN_JS_INJECTION + content
    main_path.write_text(content, encoding='utf-8')
    print("Injected mock-api loader at beginning of main.js")
    return True

def patch_subscriptions_js(app_dir: Path):
    """
    Patch subscriptions.js to force fresh render after config switch.
    Changes renderConfigs() to renderConfigs(true) after invalidateSettingsCache().
    """
    subs_path = app_dir / 'ui' / 'settings' / 'subscriptions.js'
    if not subs_path.exists():
        print(f"Warning: {subs_path} not found, skipping patch")
        return True

    content = subs_path.read_text(encoding='utf-8')

    # Pattern: renderConfigs() called after invalidateSettingsCache()
    # We need to find renderConfigs() calls that follow invalidateSettingsCache()
    # and change them to renderConfigs(true) to bypass cache
    patched = False

    # Patch 1: After invalidateSettingsCache(), the next renderConfigs() should use true
    # This handles the subscription switch case
    pattern = r'(invalidateSettingsCache\(\);[\s\S]*?)renderConfigs\(\)'
    if re.search(pattern, content):
        content = re.sub(pattern, r'\1renderConfigs(true)', content)
        patched = True
        print("Patched subscriptions.js: renderConfigs() -> renderConfigs(true)")
    else:
        # Simpler patch: just replace all standalone renderConfigs() with renderConfigs(true)
        # in the context of subscription management
        content = content.replace('renderConfigs()', 'renderConfigs(true)')
        patched = True
        print("Patched subscriptions.js: all renderConfigs() -> renderConfigs(true)")

    if patched:
        subs_path.write_text(content, encoding='utf-8')

    return True

def copy_demo_files(app_dir: Path, demo_dir: Path):
    """Copy demo files to app directory"""
    import shutil

    demo_target = app_dir / 'demo'
    demo_target.mkdir(exist_ok=True)

    files_to_copy = ['mock-api.js', 'mock-data.js']
    for filename in files_to_copy:
        src = demo_dir / filename
        if src.exists():
            shutil.copy2(src, demo_target / filename)
            print(f"Copied {filename} to app/demo/")

    return True

def main():
    if len(sys.argv) < 2:
        print("Usage: inject-demo.py <app_directory> [demo_directory]")
        print("  app_directory: Path to Zephyr app directory (contains index.html)")
        print("  demo_directory: Path to demo files (contains mock-api.js)")
        sys.exit(1)

    app_dir = Path(sys.argv[1]).resolve()
    demo_dir = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else Path(__file__).parent

    if not app_dir.exists():
        print(f"Error: App directory {app_dir} does not exist")
        sys.exit(1)

    print(f"App directory: {app_dir}")
    print(f"Demo directory: {demo_dir}")
    print()

    copy_demo_files(app_dir, demo_dir)

    success = True
    success = inject_index_html(app_dir) and success
    success = inject_main_js(app_dir) and success
    success = patch_subscriptions_js(app_dir) and success

    if success:
        print("\nDemo injection completed successfully!")
    else:
        print("\nDemo injection completed with warnings")
        sys.exit(1)

if __name__ == '__main__':
    main()

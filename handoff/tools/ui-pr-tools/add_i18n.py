#!/usr/bin/env python3
"""Insert new keys at the top of every locale block in i18n.js.

Usage: add_i18n.py strings.json path/to/i18n.js
strings.json: {"key": {"en": "...", "zh": "...", ...}, ...}
Keys already present in a locale are replaced in place.
"""
import json, re, sys

LOCALES = ['en', 'zh', 'ja', 'ko', 'ru', 'es', 'fa', 'tk', 'my', 'ar', 'ur', 'sw', 'tr', 'vi']

strings = json.load(open(sys.argv[1], encoding='utf-8'))
path = sys.argv[2]
lines = open(path, encoding='utf-8').read().split('\n')

starts = {}
for i, l in enumerate(lines):
    m = re.match(r"^    '?([a-zA-Z-]+)'?: \{$", l)
    if m and m.group(1) in LOCALES and m.group(1) not in starts:
        starts[m.group(1)] = i

missing = [(k, loc) for k, v in strings.items() for loc in LOCALES if loc not in v]
if missing:
    sys.exit(f'missing translations: {missing}')

# Work from the last block upward so earlier indexes stay valid.
for loc in sorted(starts, key=lambda x: -starts[x]):
    s = starts[loc]
    # block end: next line that is exactly '    },'
    e = s + 1
    while lines[e] != '    },':
        e += 1
    new = []
    for key, vals in strings.items():
        lit = '        ' + key + ': ' + json.dumps(vals[loc], ensure_ascii=False) + ','
        found = None
        for j in range(s + 1, e):
            if re.match(r'^        ' + re.escape(key) + r':', lines[j]):
                found = j
                break
        if found is not None:
            lines[found] = lit
        else:
            new.append(lit)
    lines[s + 1:s + 1] = new

open(path, 'w', encoding='utf-8').write('\n'.join(lines))
print('ok', len(strings), 'keys x', len(starts), 'locales')

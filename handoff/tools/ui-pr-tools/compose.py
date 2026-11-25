import os
#!/usr/bin/env python3
"""Side-by-side before/after images: compose.py <outdir>"""
import sys
from PIL import Image, ImageDraw, ImageFont

out = sys.argv[1]
pairs = [
    ('home-930-light', 'sidebar-light'),
    ('home-930-dark', 'sidebar-dark'),
    ('home-720-light', 'narrow-720'),
    ('subedit-930-light', 'auto-update'),
    ('proxies-930-light', 'proxies-light'),
]
try:
    font = ImageFont.truetype(os.environ.get('WORK', '.') + '/ui-pr-tools/site/proto/fonts/PingFangSF.ttf', 44)
except Exception:
    font = ImageFont.load_default()

for src, name in pairs:
    a = Image.open(f'{out}/old-{src}.png').convert('RGB')
    b = Image.open(f'{out}/new-{src}.png').convert('RGB')
    gap, head = 40, 90
    w = a.width + b.width + gap
    h = max(a.height, b.height) + head
    img = Image.new('RGB', (w, h), (246, 246, 248))
    d = ImageDraw.Draw(img)
    d.text((20, 20), '改动前', fill=(60, 60, 67), font=font)
    d.text((a.width + gap + 20, 20), '改动后', fill=(60, 60, 67), font=font)
    img.paste(a, (0, head))
    img.paste(b, (a.width + gap, head))
    img = img.resize((w // 2, h // 2), Image.LANCZOS)
    img.save(f'{out}/cmp-{name}.png', optimize=True)
    print(name, img.size)

for src in ['collapsed-930-light', 'collapsed-930-dark']:
    im = Image.open(f'{out}/new-{src}.png').convert('RGB')
    im.resize((im.width // 2, im.height // 2), Image.LANCZOS).save(f'{out}/one-{src}.png', optimize=True)
m = Image.open(f'{out}/new-menu-930-light.png').convert('RGB')
m.save(f'{out}/one-menu.png', optimize=True)

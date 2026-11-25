# Before/after crops for the "looked at the screenshots" section.
from PIL import Image
B = 'out-before-look/'
A = 'out/'
crops = {
    'lk-hero': ('f-home.png', (400, 280, 1780, 1160)),
    'lk-cards': ('f-speed-done.png', (400, 240, 1860, 700)),
    'lk-side-dark': ('f-home-dark.png', (0, 60, 420, 900)),
    'lk-side': ('f-home.png', (0, 60, 420, 900)),
    'lk-alts-big': ('f-home-big.png', (380, 1600, 2880, 1800)),
    'lk-close': ('f-home.png', (1500, 0, 1860, 90)),
}
for name, (src, box) in crops.items():
    for tag, d in (('before', B), ('after', A)):
        im = Image.open(d + src).convert('RGB').crop(box)
        if im.width > 1500:
            im = im.resize((round(im.width * 0.6), round(im.height * 0.6)), Image.LANCZOS)
        im.save(f'web/{name}-{tag}.webp', 'WEBP', quality=80, method=6)
print('ok', len(crops) * 2)

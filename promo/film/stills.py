import asyncio, sys
from PIL import Image
from playwright.async_api import async_playwright

async def main(times, out):
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page(viewport={'width': 1920, 'height': 1080})
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
        await pg.goto('http://localhost:8766/' + (sys.argv[3] if len(sys.argv) > 3 else 'comp.html') + '')
        await pg.wait_for_function('window.__ready', timeout=120000)
        await pg.evaluate('window.__ready')
        ims = []
        for t in times:
            await pg.evaluate(f'window.__seek({t})')
            path = f'/tmp/st_{t:.2f}.png'
            await pg.screenshot(path=path)
            ims.append(Image.open(path).convert('RGB').resize((960, 540)))
        cols = 2
        rows = (len(ims) + cols - 1) // cols
        S = Image.new('RGB', (960 * cols, 540 * rows), 'black')
        for i, im in enumerate(ims):
            S.paste(im, ((i % cols) * 960, (i // cols) * 540))
        S.save(out)
        print('errors', [e for e in errs if 'Failed to load resource' not in e][:6])

asyncio.run(main([float(x) for x in sys.argv[1].split(',')], sys.argv[2]))

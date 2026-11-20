import asyncio, sys, time, base64
from playwright.async_api import async_playwright
async def main(shot, times, out, w=1920, h=1080):
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'])
        pg = await b.new_page(viewport={'width':w,'height':h})
        errs=[]; pg.on('pageerror', lambda e: errs.append(str(e))); pg.on('console', lambda m: errs.append(m.text) if m.type=='error' else None)
        await pg.goto(f'http://localhost:8766/z3d.html?shot={shot}&w={w}&h={h}')
        await pg.wait_for_function('window.__ready===true', timeout=60000)
        for t in times:
            t0=time.time()
            await pg.evaluate(f'window.__seek({t})')
            await pg.screenshot(path=f'{out}_{t:05.2f}.png')
            print(t, round(time.time()-t0,2))
        print(errs[:5])
shot=sys.argv[1]; times=[float(x) for x in sys.argv[2].split(',')]
asyncio.run(main(shot, times, sys.argv[3]))

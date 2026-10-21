"""Render the 3D shots as frame sequences with real shutter blur (n sub-frames over a 180° shutter, linear-light mean).
usage: python3 r3d_seq.py <shot> <dur> <outdir> [--sub 3] [--fps 30] [--from F] [--to F]
"""
import argparse, asyncio, io, os, time
import numpy as np
from PIL import Image
from playwright.async_api import async_playwright

_u = np.arange(256) / 255.0
S2L = np.where(_u <= 0.04045, _u / 12.92, ((_u + 0.055) / 1.055) ** 2.4).astype(np.float32)


def l2s(x):
    x = np.clip(x, 0, 1)
    return np.clip(np.rint(np.where(x <= 0.0031308, x * 12.92, 1.055 * np.power(x, 1 / 2.4) - 0.055) * 255), 0, 255).astype(np.uint8)


async def main(a):
    os.makedirs(a.outdir, exist_ok=True)
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
        pg = await b.new_page(viewport={'width': 1920, 'height': 1080})
        await pg.goto(f'http://localhost:8766/z3d.html?shot={a.shot}')
        await pg.wait_for_function('window.__ready===true', timeout=60000)
        n = int(round(a.dur * a.fps))
        f1 = n if a.to is None else min(n, a.to)
        t0 = time.time()
        for f in range(a.frm, f1):
            path = f'{a.outdir}/{f:04d}.jpg'
            if os.path.exists(path):
                continue
            t = f / a.fps
            acc = None
            offs = [0.0] if a.sub <= 1 else [((k / (a.sub - 1)) - 0.5) * (0.5 / a.fps) for k in range(a.sub)]
            for o in offs:
                await pg.evaluate(f'window.__seek({max(0, t + o)})')
                png = await pg.screenshot(type='png')
                lin = S2L[np.asarray(Image.open(io.BytesIO(png)).convert('RGB'))]
                acc = lin if acc is None else acc + lin
            Image.fromarray(l2s(acc / len(offs))).save(path, quality=95)
            if f % 30 == 0:
                print(a.shot, f, '/', f1, round(time.time() - t0, 1), 's', flush=True)
        await b.close()

ap = argparse.ArgumentParser()
ap.add_argument('shot'); ap.add_argument('dur', type=float); ap.add_argument('outdir')
ap.add_argument('--sub', type=int, default=3); ap.add_argument('--fps', type=int, default=30)
ap.add_argument('--from', dest='frm', type=int, default=0); ap.add_argument('--to', type=int, default=None)
asyncio.run(main(ap.parse_args()))

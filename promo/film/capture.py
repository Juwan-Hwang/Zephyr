"""Record the REAL Zephyr UI (brand branch + demo mock API) frame by frame under
Chrome virtual time, so CSS transitions, timers and the traffic chart all advance
exactly 1/30 s per frame. Window viewport 1080x690, DPR 2, transparent background.

usage: python3 capture.py <scene> [<scene> ...]
"""
import asyncio, base64, io, json, math, os, sys, time
from concurrent.futures import ThreadPoolExecutor
from PIL import Image
from playwright.async_api import async_playwright

FPS = 30
SYNTH_HOVER = False
JS_MOVE = '''([x,y])=>{const e=document.elementFromPoint(x,y); const prev=window.__hov||null; const o={bubbles:true,cancelable:true,clientX:x,clientY:y,view:window,pointerType:'mouse',isPrimary:true};
 if(prev!==e){ const pa=[];for(let n=prev;n;n=n.parentElement)pa.push(n); const ea=[];for(let n=e;n;n=n.parentElement)ea.push(n);
   for(const n of pa){ if(!ea.includes(n)){ n.dispatchEvent(new MouseEvent('mouseleave',{...o,bubbles:false})); n.dispatchEvent(new PointerEvent('pointerleave',{...o,bubbles:false})); } }
   if(prev){prev.dispatchEvent(new MouseEvent('mouseout',o));}
   if(e){e.dispatchEvent(new MouseEvent('mouseover',o)); for(const n of ea.reverse()){ if(!pa.includes(n)){ n.dispatchEvent(new PointerEvent('pointerenter',{...o,bubbles:false})); n.dispatchEvent(new MouseEvent('mouseenter',{...o,bubbles:false})); } } }
   window.__hov=e; }
 if(e){ e.dispatchEvent(new PointerEvent('pointermove',o)); e.dispatchEvent(new MouseEvent('mousemove',o)); } }'''
JS_DOWN = '''([x,y])=>{const e=document.elementFromPoint(x,y); if(!e) return; window.__pressEl=e; const o={bubbles:true,cancelable:true,clientX:x,clientY:y,button:0,buttons:1,view:window,pointerId:1,pointerType:'mouse',isPrimary:true}; e.dispatchEvent(new PointerEvent('pointerdown',o)); e.dispatchEvent(new MouseEvent('mousedown',o));}'''
JS_UP = '''([x,y])=>{const e=window.__pressEl||document.elementFromPoint(x,y); if(!e) return; const o={bubbles:true,cancelable:true,clientX:x,clientY:y,button:0,buttons:0,view:window,pointerId:1,pointerType:'mouse',isPrimary:true}; e.dispatchEvent(new PointerEvent('pointerup',o)); e.dispatchEvent(new MouseEvent('mouseup',o)); e.dispatchEvent(new MouseEvent('click',o));}'''
W, H, DPR = 1080, 690, 2
URL = 'http://localhost:8765/index.html'
OUT = 'footage'
pool = ThreadPoolExecutor(2)


def save_webp(data, path):
    im = Image.open(io.BytesIO(data))
    im.save(path, 'WEBP', quality=94, method=4)


def smooth(a):
    a = max(0.0, min(1.0, a))
    return a * a * a * (a * (a * 6 - 15) + 10)


def mouse_at(keys, t):
    """keys: [(t, x, y)] -> eased position (quintic smootherstep per segment)."""
    if t <= keys[0][0]:
        return keys[0][1], keys[0][2]
    for (t0, x0, y0), (t1, x1, y1) in zip(keys, keys[1:]):
        if t <= t1:
            a = smooth((t - t0) / max(1e-6, t1 - t0))
            return x0 + (x1 - x0) * a, y0 + (y1 - y0) * a
    return keys[-1][1], keys[-1][2]


async def center(pg, sel, dx=0, dy=0):
    r = await pg.evaluate("""(s)=>{const e=document.querySelector(s); if(!e) return null; const b=e.getBoundingClientRect(); return [b.x+b.width/2,b.y+b.height/2,b.width,b.height]}""", sel)
    if r is None:
        raise RuntimeError('no element ' + sel)
    return [r[0] + dx, r[1] + dy]


async def text_center(pg, text, within='body'):
    r = await pg.evaluate("""([t,w])=>{const root=document.querySelector(w)||document.body; let best=null, ba=1e12; for(const e of root.querySelectorAll('*')){ if(!(e.textContent||'').includes(t)) continue; const b=e.getBoundingClientRect(); if(b.width<=0||b.height<=0) continue; const a=b.width*b.height; if(a<ba){ba=a;best=[b.x+b.width/2,b.y+b.height/2];} } return best}""", [text, within])
    if r is None:
        raise RuntimeError('no text ' + text)
    return r


async def advance(cdp, ms):
    fut = asyncio.get_event_loop().create_future()
    cdp.once('Emulation.virtualTimeBudgetExpired', lambda e: (not fut.done()) and fut.set_result(1))
    await cdp.send('Emulation.setVirtualTimePolicy', {'policy': 'advance', 'budget': ms})
    await asyncio.wait_for(fut, 20)


async def record(name, scheme, setup, plan, dur, warm=60000):
    """setup(pg) runs in real time; plan(pg) -> dict(mouse=[(t,x,y)], clicks=[t], acts=[(t, coro_fn)])"""
    os.makedirs(f'{OUT}/{name}', exist_ok=True)
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': W, 'height': H}, device_scale_factor=DPR,
                                  locale='zh-CN', color_scheme=scheme, reduced_motion='no-preference')
        pg = await ctx.new_page()
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.on('dialog', lambda d: (print('DIALOG', d.message, flush=True), asyncio.ensure_future(d.dismiss())))
        pg.on('crash', lambda *a: print('CRASH', flush=True))
        await pg.goto(URL)
        await pg.wait_for_timeout(2500)
        await pg.evaluate("document.fonts.ready")
        await pg.mouse.move(W - 2, H - 2)
        cdp = await ctx.new_cdp_session(pg)
        if setup:
            await setup(pg, cdp)
        await cdp.send('Emulation.setVirtualTimePolicy', {'policy': 'pause'})
        await advance(cdp, warm)                       # let traffic chart / counters fill in virtual time
        spec = await plan(pg, cdp)
        mouse = spec.get('mouse') or [(0, W * 0.62, H * 0.86)]
        clicks = sorted(spec.get('clicks', []))
        acts = sorted(spec.get('acts', []), key=lambda a: a[0])
        n = int(round(dur * FPS))
        path, futs = [], []
        down = False
        t0 = time.time()
        for f in range(n):
            t = f / FPS
            x, y = mouse_at(mouse, t)
            if SYNTH_HOVER:
                mv = None   # no pointer input on this page: its 3D-tilt hover stalls the compositor under virtual time
            else:
                mv = asyncio.ensure_future(pg.mouse.move(x, y))
            done = True if mv is None else (await asyncio.wait([mv], timeout=1.5))[0]
            if not done:
                # the input ack needs the renderer to tick; nudge virtual time until it lands
                for _k in range(40):
                    await advance(cdp, 1)
                    done, _ = await asyncio.wait([mv], timeout=0.3)
                    if done: break
                if not done: print('move stuck', name, f, flush=True)
            for c in clicks:
                if not down and abs(t - c) < 0.5 / FPS:
                    await pg.evaluate(JS_DOWN, [x, y]); down = True; downat = t
            if down and t - downat >= 0.06:
                await pg.evaluate(JS_UP, [x, y]); down = False
            while acts and acts[0][0] <= t + 1e-6:
                _, fn = acts.pop(0)
                await fn(pg, cdp)
            await advance(cdp, 1000 / FPS)
            r = None
            for attempt in range(6):
                try:
                    r = await asyncio.wait_for(cdp.send('Page.captureScreenshot', {'format': 'png', 'clip': {'x': 0, 'y': 0, 'width': W, 'height': H, 'scale': DPR}}), 8)
                    break
                except asyncio.TimeoutError:
                    print('screenshot timeout', name, f, attempt, flush=True)
                    await cdp.send('Emulation.setVirtualTimePolicy', {'policy': 'advance', 'budget': 1})
                    await asyncio.sleep(0.5)
            if r is None:
                raise RuntimeError('screenshot failed')
            futs.append(pool.submit(save_webp, base64.b64decode(r['data']), f'{OUT}/{name}/{f:04d}.webp'))
            path.append([round(x, 2), round(y, 2)])
            if f % 15 == 0: print(name, f, round(time.time() - t0, 1), flush=True)
        for fu in futs:
            fu.result()
        json.dump({'n': n, 'fps': FPS, 'w': W, 'h': H, 'dpr': DPR, 'mouse': path, 'clicks': clicks}, open(f'{OUT}/{name}/info.json', 'w'))
        print(name, n, 'frames', round(time.time() - t0, 1), 's', 'errors:', errs[:3])
        await b.close()


async def transparent(pg, cdp):
    await cdp.send('Emulation.setDefaultBackgroundColorOverride', {'color': {'r': 0, 'g': 0, 'b': 0, 'a': 0}})


# ─────────────────────────────── scenes ───────────────────────────────

async def s_home_setup(pg, cdp):
    await transparent(pg, cdp)


async def s_home_plan(pg, cdp):
    tg = await center(pg, '#sys-proxy-toggle + .switch-slider')
    return {'mouse': [(0, 640, 610), (0.9, 640, 610), (1.75, tg[0] - 6, tg[1] + 2), (4.0, tg[0] - 4, tg[1] + 3), (5.4, tg[0] - 60, tg[1] + 70)],
            'clicks': [1.95]}


async def s_proxies_plan(pg, cdp):
    nav = await center(pg, '[data-nav="proxies"]')
    return {'mouse': [(0, 300, 420), (0.25, 300, 420), (0.85, nav[0] + 2, nav[1] + 2), (1.25, nav[0] + 2, nav[1] + 2)],
            'clicks': [1.0], 'acts': [(1.6, s_proxies_phase2)]}

PROX = {}
async def s_proxies_phase2(pg, cdp):
    pass


async def run_proxies():
    global SYNTH_HOVER
    SYNTH_HOVER = True
    async def setup(pg, cdp):
        await transparent(pg, cdp)
        await pg.click('#sys-proxy-toggle + .switch-slider'); await pg.wait_for_timeout(600)
        await pg.click('[data-nav="proxies"]'); await pg.wait_for_timeout(1500)
        await pg.click('#test-all-btn'); await pg.wait_for_timeout(4500)

    async def plan(pg, cdp):
        jp = await text_center(pg, '日本 东京 01')
        sg = await text_center(pg, '新加坡 01')
        return {'mouse': [(0, 860, 600), (0.4, 860, 600), (1.5, sg[0] + 30, sg[1] + 16), (2.0, sg[0] + 30, sg[1] + 16),
                          (2.9, jp[0] + 30, jp[1] + 16), (3.3, jp[0] + 30, jp[1] + 16), (5.2, jp[0] + 110, jp[1] + 140)],
                'clicks': [3.05]}
    await record_rt('proxies', 'light', setup, plan, 5.2)
    SYNTH_HOVER = False


async def run_mode_tun():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': W, 'height': H}, locale='zh-CN')
        pg = await ctx.new_page()
        await pg.goto(URL); await pg.wait_for_timeout(2500)
        glob = await center(pg, '[data-mode="global"]')
        rule = await center(pg, '[data-mode="rule"]')
        tun = await center(pg, '#tun-proxy-toggle + .switch-slider')
        await b.close()

    async def setup(pg, cdp):
        await transparent(pg, cdp)
        await pg.click('#sys-proxy-toggle + .switch-slider'); await pg.wait_for_timeout(600)

    async def plan(pg, cdp):
        return {'mouse': [(0, 520, 470), (0.2, 520, 470), (0.85, glob[0], glob[1] + 2), (1.4, glob[0], glob[1] + 2),
                          (2.1, rule[0] + 4, rule[1] + 2), (2.6, rule[0] + 4, rule[1] + 2),
                          (3.5, tun[0] - 4, tun[1] + 2), (5.2, tun[0] - 4, tun[1] + 2), (6.0, tun[0] - 70, tun[1] - 40)],
                'clicks': [1.0, 2.25, 3.7]}
    await record('mode_tun', 'light', setup, plan, 6.0)


async def run_prism():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': W, 'height': H}, locale='zh-CN')
        pg = await ctx.new_page()
        await pg.goto(URL); await pg.wait_for_timeout(2500)
        await pg.click('[data-nav="subscriptions"]'); await pg.wait_for_timeout(1000)
        btn = await center(pg, '#open-plugins-btn')
        await pg.click('#open-plugins-btn'); await pg.wait_for_timeout(1200)
        item = await text_center(pg, '分流增强')
        await b.close()

    async def setup(pg, cdp):
        await transparent(pg, cdp)
        await pg.click('[data-nav="subscriptions"]'); await pg.wait_for_timeout(1000)

    async def plan(pg, cdp):
        return {'mouse': [(0, 760, 300), (0.2, 760, 300), (0.85, btn[0], btn[1] + 2), (1.3, btn[0], btn[1] + 2),
                          (2.2, item[0] + 10, item[1] + 3), (2.7, item[0] + 10, item[1] + 3), (4.6, 900, 640)],
                'clicks': [1.0, 2.4]}
    await record_rt('prism', 'light', setup, plan, 6.5, rate=0.018)


async def run_theme():
    """console home in light, then the OS flips to dark: the app's own theme transition."""
    async def setup(pg, cdp):
        await transparent(pg, cdp)
        await pg.click('#sys-proxy-toggle + .switch-slider'); await pg.wait_for_timeout(500)
        await pg.click('[data-nav="settings"]'); await pg.wait_for_timeout(700)
        await pg.click('[data-home-mode="console"]'); await pg.wait_for_timeout(500)
        await pg.click('[data-nav="home"]'); await pg.wait_for_timeout(1500)

    async def to_dark(pg, cdp):
        await pg.emulate_media(color_scheme='dark')

    async def plan(pg, cdp):
        return {'mouse': [(0, 1200, 900)], 'acts': [(1.2, to_dark)]}
    await record('theme', 'light', setup, plan, 4.0)


async def run_dark_conn():
    async def setup(pg, cdp):
        await transparent(pg, cdp)
        await pg.click('#sys-proxy-toggle + .switch-slider'); await pg.wait_for_timeout(500)
        await pg.click('[data-nav="connections"]'); await pg.wait_for_timeout(1200)

    async def plan(pg, cdp):
        return {'mouse': [(0, 1200, 900)]}
    await record('dark_conn', 'dark', setup, plan, 3.0)


async def run_home():
    await record('home', 'light', s_home_setup, s_home_plan, 5.4)


async def run_dark_home():
    async def setup(pg, cdp):
        await transparent(pg, cdp)
        await pg.click('#sys-proxy-toggle + .switch-slider'); await pg.wait_for_timeout(400)
        await pg.wait_for_timeout(1500)

    async def plan(pg, cdp):
        cl = await center(pg, '#close-btn') if await pg.query_selector('#close-btn') else [1029, 32]
        return {'mouse': [(0, 860, 300), (0.4, 860, 300), (1.4, cl[0] - 1, cl[1] + 1), (2.6, cl[0] - 1, cl[1] + 1)], 'clicks': [1.9]}
    await record('dark_home', 'dark', setup, plan, 2.6)


SCENES = {'home': run_home, 'proxies': run_proxies, 'mode_tun': run_mode_tun, 'prism': run_prism,
          'theme': run_theme, 'dark_conn': run_dark_conn, 'dark_home': run_dark_home}

async def record_rt(name, scheme, setup, plan, dur, rate=0.05, probe=None):
    """real-time capture with CSS animations slowed by `rate` (for pages that stall under virtual time)."""
    os.makedirs(f'{OUT}/{name}', exist_ok=True)
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': W, 'height': H}, device_scale_factor=DPR, locale='zh-CN', color_scheme=scheme)
        pg = await ctx.new_page()
        await pg.goto(URL); await pg.wait_for_timeout(2500)
        await pg.mouse.move(W - 2, H - 2)
        cdp = await ctx.new_cdp_session(pg)
        if setup:
            await setup(pg, cdp)
        spec = await plan(pg, cdp)
        mouse = spec.get('mouse'); clicks = sorted(spec.get('clicks', []))
        acts = sorted(spec.get('acts', []), key=lambda a: a[0])
        await cdp.send('Animation.enable'); await cdp.send('Animation.setPlaybackRate', {'playbackRate': rate})
        n = int(round(dur * FPS)); path = []; futs = []; down = False
        t_start = time.time()
        for f in range(n):
            t = f / FPS
            x, y = mouse_at(mouse, t)
            for c in clicks:
                if not down and abs(t - c) < 0.5 / FPS:
                    await pg.evaluate(JS_DOWN, [x, y]); down = True; downat = t
            if down and t - downat >= 0.06:
                await pg.evaluate(JS_UP, [x, y]); down = False
            while acts and acts[0][0] <= t + 1e-6:
                _, fn = acts.pop(0)
                await fn(pg, cdp)
            target = t_start + t / rate
            now = time.time()
            if target > now:
                await asyncio.sleep(target - now)
            r = await cdp.send('Page.captureScreenshot', {'format': 'png', 'clip': {'x': 0, 'y': 0, 'width': W, 'height': H, 'scale': DPR}})
            futs.append(pool.submit(save_webp, base64.b64decode(r['data']), f'{OUT}/{name}/{f:04d}.webp'))
            path.append([round(x, 2), round(y, 2)])
            if f % 15 == 0: print(name, f, round(time.time() - t_start, 1), 'late', round(time.time() - target, 2), flush=True)
        for fu in futs: fu.result()
        extra = {}
        if probe:
            extra = await pg.evaluate(probe)
        json.dump({'n': n, 'fps': FPS, 'w': W, 'h': H, 'dpr': DPR, 'mouse': path, 'clicks': clicks, 'probe': extra}, open(f'{OUT}/{name}/info.json', 'w'))
        await b.close()


if __name__ == '__main__':
    names = sys.argv[1:] or list(SCENES)
    for nm in names:
        try:
            asyncio.run(SCENES[nm]())
        except Exception as ex:
            print('FAILED', nm, ex, flush=True)


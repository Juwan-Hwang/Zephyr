"""v2 footage: every window 1082x691 (the minimal home would be 930x680; not used in this cut)."""
import asyncio, json, sys
import capture as C
from playwright.async_api import async_playwright

C.W, C.H = 1082, 691
C.OUT = 'footage2'
URL = C.URL


async def probe(fn):
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page(viewport={'width': C.W, 'height': C.H}, locale='zh-CN')
        await pg.goto(URL); await pg.wait_for_timeout(2500)
        r = await fn(pg)
        await b.close()
        return r


async def to_console(pg):
    await pg.click('[data-nav="settings"]'); await pg.wait_for_timeout(700)
    await pg.click('[data-home-mode="console"]'); await pg.wait_for_timeout(400)
    await pg.click('[data-nav="home"]'); await pg.wait_for_timeout(2500)


def sw_of(rowtext):
    return f"""(()=>{{const r=[...document.querySelectorAll('.dz-quick-row')].find(e=>e.textContent.includes('{rowtext}'));const b=r.getBoundingClientRect();return [b.right-34,b.y+b.height/2]}})()"""


async def run_console():
    async def meas(pg):
        await to_console(pg)
        out = {}
        out['sys'] = await pg.evaluate(sw_of('系统代理'))
        out['tun'] = await pg.evaluate(sw_of('TUN'))
        out['test'] = await C.center(pg, '#dz-test-btn')
        out['glob'] = await C.text_center(pg, '全局代理', '[data-page=console]')
        out['rule'] = await C.text_center(pg, '分流规则', '[data-page=console]')
        out['title'] = await pg.evaluate("(()=>{const r=document.getElementById('app-title-icon').getBoundingClientRect();return [r.x,r.y,r.width,r.height]})()")
        out['node'] = await C.text_center(pg, '香港 03 IPLC', '[data-page=console]')
        return out
    M = await probe(meas)
    print('console measure', M, flush=True)

    async def setup(pg, cdp):
        await C.transparent(pg, cdp)
        await to_console(pg)

    async def plan(pg, cdp):
        s, tn, te, g, r = M['sys'], M['tun'], M['test'], M['glob'], M['rule']
        return {'mouse': [(0, 600, 520), (0.5, 640, 520), (1.25, s[0], s[1] + 2), (1.7, s[0], s[1] + 2),
                          (2.45, te[0] + 4, te[1] + 3), (2.85, te[0] + 4, te[1] + 3),
                          (3.5, g[0], g[1] + 2), (3.85, g[0], g[1] + 2), (4.35, r[0] + 4, r[1] + 2), (4.7, r[0] + 4, r[1] + 2),
                          (5.4, tn[0], tn[1] + 2), (6.2, tn[0] - 10, tn[1] + 8), (7.2, tn[0] - 60, tn[1] - 40)],
                'clicks': [1.4, 2.6, 3.65, 4.5, 5.55]}
    await C.record('console', 'light', setup, plan, 7.2, warm=60000)
    json.dump(M, open('footage2/console/measure.json', 'w'))


async def run_proxies():
    async def setup(pg, cdp):
        await C.transparent(pg, cdp)
        await pg.click('#sys-proxy-toggle + .switch-slider'); await pg.wait_for_timeout(600)
        await pg.click('[data-nav="proxies"]'); await pg.wait_for_timeout(1500)
        await pg.click('#test-all-btn'); await pg.wait_for_timeout(4500)

    async def plan(pg, cdp):
        jp = await C.text_center(pg, '日本 东京 01')
        hk = await C.text_center(pg, '香港 03 IPLC', '[data-page=proxies]')
        json.dump({'jp': jp, 'hk': hk}, open('/tmp/px_meas.json', 'w'))
        return {'mouse': [(0, hk[0] + 40, hk[1] + 60), (0.3, hk[0] + 40, hk[1] + 60), (1.4, jp[0] + 30, jp[1] + 16), (1.8, jp[0] + 30, jp[1] + 16), (3.8, jp[0] + 70, jp[1] + 90)],
                'clicks': [1.6]}
    C.SYNTH_HOVER = True
    await C.record_rt('proxies', 'light', setup, plan, 3.8)
    C.SYNTH_HOVER = False
    info = json.load(open('footage2/proxies/info.json')); info['probe'] = json.load(open('/tmp/px_meas.json'))
    json.dump(info, open('footage2/proxies/info.json', 'w'))


PROBE_CM = """(()=>{const L=[...document.querySelectorAll('.cm-line')].map(l=>{const r=l.getBoundingClientRect();return [l.textContent,r.x,r.y,r.width,r.height]});
const tip=document.querySelector('.cm-tooltip-autocomplete');const tr=tip?tip.getBoundingClientRect():null;
const ed=document.querySelector('.cm-editor').getBoundingClientRect();
return {lines:L, tip: tr?[tr.x,tr.y,tr.width,tr.height]:null, editor:[ed.x,ed.y,ed.width,ed.height]}})()"""


async def run_prism():
    async def setup(pg, cdp):
        await C.transparent(pg, cdp)
        await pg.click('#sys-proxy-toggle + .switch-slider'); await pg.wait_for_timeout(500)
        await pg.click('[data-nav="subscriptions"]'); await pg.wait_for_timeout(900)
        await pg.click('#open-plugins-btn'); await pg.wait_for_timeout(1200)
        await pg.get_by_text('分流增强').first.click(); await pg.wait_for_timeout(1800)
        await pg.focus('.cm-content'); await pg.wait_for_timeout(300)

    tipbox = {}

    def key(k):
        async def f(pg, cdp):
            await pg.keyboard.press(k)
        return f

    def typ(ch):
        async def f(pg, cdp):
            await pg.keyboard.type(ch)
        return f

    async def snap_tip(pg, cdp):
        tipbox['v'] = await pg.evaluate(PROBE_CM)

    async def plan(pg, cdp):
        m = await pg.evaluate(PROBE_CM)
        ln = m['lines'][4]
        x0, y0 = ln[1] + 330, ln[2] + 60
        acts = [(0.25, key('Control+Home')), (0.4, key('ArrowDown')), (0.45, key('ArrowDown')), (0.5, key('ArrowDown')), (0.55, key('ArrowDown')),
                (1.0, typ('p')), (1.2, typ('r')), (1.4, typ('o')), (1.75, typ('x')), (1.95, typ('y')), (2.4, snap_tip),
                (2.75, key('Enter')), (3.1, typ(':')), (3.35, key('Escape'))]
        return {'mouse': [(0, x0, y0), (4.6, x0 + 30, y0 + 20)], 'clicks': [], 'acts': acts}
    C.SYNTH_HOVER = True
    await C.record_rt('prism', 'light', setup, plan, 4.6, rate=0.018, probe=PROBE_CM)
    C.SYNTH_HOVER = False
    info = json.load(open('footage2/prism/info.json')); info['tip'] = tipbox.get('v')
    json.dump(info, open('footage2/prism/info.json', 'w'))


async def run_theme():
    async def setup(pg, cdp):
        await C.transparent(pg, cdp)
        await to_console(pg)
        sxy = await pg.evaluate(sw_of('系统代理')); await pg.mouse.click(*sxy); await pg.mouse.move(C.W - 2, C.H - 2); await pg.wait_for_timeout(800)

    async def to_dark(pg, cdp):
        await pg.emulate_media(color_scheme='dark')

    async def plan(pg, cdp):
        return {'mouse': [(0, C.W - 2, C.H - 2)], 'acts': [(1.2, to_dark)]}
    await C.record('theme', 'light', setup, plan, 4.0, warm=30000)


async def run_close():
    async def setup(pg, cdp):
        await C.transparent(pg, cdp)
        await to_console(pg)
        sxy = await pg.evaluate(sw_of('系统代理')); await pg.mouse.click(*sxy); await pg.mouse.move(C.W - 2, C.H - 2); await pg.wait_for_timeout(800)

    async def plan(pg, cdp):
        cl = await C.center(pg, '#close-btn')
        return {'mouse': [(0, 860, 300), (0.25, 860, 300), (1.0, cl[0] - 1, cl[1] + 1), (2.2, cl[0] - 1, cl[1] + 1)], 'clicks': [1.3]}
    await C.record('close', 'dark', setup, plan, 2.2, warm=30000)


SC = {'console': run_console, 'proxies': run_proxies, 'prism': run_prism, 'theme': run_theme, 'close': run_close}

LANGS = ['en', 'ja', 'ko', 'my', 'vi', 'ru', 'es', 'tr', 'tk', 'sw', 'fa', 'ar', 'ur', 'zh']
LANG_T0, LANG_DT = 0.45, 60 / 124 / 2


async def run_lang():
    async def setup(pg, cdp):
        await C.transparent(pg, cdp)
        await to_console(pg)
        for row in ('系统代理', 'TUN'):
            xy = await pg.evaluate(sw_of(row)); await pg.mouse.click(*xy); await pg.wait_for_timeout(700)
        await pg.mouse.move(C.W - 2, C.H - 2); await pg.wait_for_timeout(1500)

    def lang(l):
        async def f(pg, cdp):
            # the same path as picking it in Settings → Appearance → Language
            await pg.evaluate(f"document.querySelector('[data-lang-value={l}]').click()")
        return f

    async def plan(pg, cdp):
        acts = [(LANG_T0 + i * LANG_DT, lang(l)) for i, l in enumerate(LANGS)]
        return {'mouse': [(0, C.W - 2, C.H - 2)], 'clicks': [], 'acts': acts}
    await C.record_rt('lang', 'light', setup, plan, LANG_T0 + len(LANGS) * LANG_DT + 0.6, rate=0.05)


async def run_minimal():
    C.W, C.H = 930, 680   # the minimal home is recorded at 930x680
    async def setup(pg, cdp):
        await C.transparent(pg, cdp)
        await pg.click('#sys-proxy-toggle + .switch-slider'); await pg.wait_for_timeout(700)
        await pg.click('#tun-proxy-toggle + .switch-slider'); await pg.wait_for_timeout(1500)

    async def plan(pg, cdp):
        chip = await pg.evaluate("""(()=>{let best=null,ba=1e9;for(const e of document.querySelectorAll('[data-page=home] *')){if(!(e.textContent||'').includes('香港 03 IPLC'))continue;const r=e.getBoundingClientRect();if(r.width<=0)continue;const a=r.width*r.height;if(a<ba){ba=a;best=[r.x+r.width/2,r.y+r.height/2,r.width,r.height]}}return best})()""")
        json.dump({'chip': chip}, open('/tmp/min_meas.json', 'w'))
        return {'mouse': [(0, 700, 560), (3.6, 690, 540)], 'clicks': []}
    await C.record('minimal', 'light', setup, plan, 3.6, warm=30000)
    info = json.load(open('footage2/minimal/info.json')); info['probe'] = json.load(open('/tmp/min_meas.json'))
    json.dump(info, open('footage2/minimal/info.json', 'w'))
    C.W, C.H = 1082, 691

SC.update({'lang': run_lang, 'minimal': run_minimal})

if __name__ == '__main__':
    for n in sys.argv[1:]:
        try:
            asyncio.run(SC[n]())
        except Exception as ex:
            import traceback; traceback.print_exc()
            print('FAILED', n, ex, flush=True)

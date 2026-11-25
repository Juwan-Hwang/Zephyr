// 列出对比度不到 4.5:1 的小字：类名、颜色、实际背景。
(() => {
  const cv = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const rgb = (s) => { if (/^rgba?\(/.test(s)) return (s.match(/[\d.]+/g) || []).map(Number); cv.clearRect(0, 0, 1, 1); cv.fillStyle = s; cv.fillRect(0, 0, 1, 1); const d = cv.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
  const lum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const dark = document.documentElement.classList.contains('dark');
  const bgOf = (el) => { let e = el; const L = []; while (e && e.nodeType === 1) { const c = rgb(getComputedStyle(e).backgroundColor); if ((c[3] ?? 1) > 0) { L.push(c); if ((c[3] ?? 1) >= 0.95) break; } e = e.parentElement; } let b = dark ? [24, 24, 27] : [245, 245, 247]; for (const c of L.reverse()) { const a = c[3] ?? 1; b = b.map((v, i) => v * (1 - a) + c[i] * a); } return b; };
  const out = new Map();
  for (const el of document.querySelectorAll('body *')) {
    const t = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join('').trim();
    if (!t) continue;
    const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
    if (cs.visibility === 'hidden' || r.width < 2 || r.bottom < 0 || r.top > innerHeight) continue;
    let o = 1, e = el; while (e) { o *= +getComputedStyle(e).opacity; e = e.parentElement; } if (o < 0.6) continue;
    if (el.closest('[aria-disabled=true],:disabled')) continue;
    const fg = rgb(cs.color); const bg = bgOf(el); const a = fg[3] ?? 1; const f = fg.slice(0, 3).map((v, i) => v * a + bg[i] * (1 - a));
    const L1 = lum(f), L2 = lum(bg); const c = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const big = parseFloat(cs.fontSize) >= 18.66 || (parseFloat(cs.fontSize) >= 14 && +cs.fontWeight >= 700);
    if (c >= (big ? 3 : 4.5)) continue;
    const k = `${el.tagName.toLowerCase()}.${String(el.className).split(/\s+/).slice(0, 4).join('.')} < ${String(el.parentElement.className).split(/\s+/).slice(0, 2).join('.')}`;
    if (!out.has(k)) out.set(k, `${c.toFixed(1)} "${t.slice(0, 18)}" fg=${cs.color} bg=rgb(${bg.map(Math.round)})`);
  }
  return [...out].map(([k, v]) => `${v}  ${k}`).join('\n') || 'all ok';
})()

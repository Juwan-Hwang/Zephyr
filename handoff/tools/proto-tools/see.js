// 把当前视口里看得见的东西按层级列出来：卡片/块的框、文字叶子（字号、字重、颜色、对比度）。
(() => {
  const out = [];
  const W = innerWidth, H = innerHeight;
  const cv = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const rgb = (s) => { if (/^rgba?\(/.test(s)) return (s.match(/[\d.]+/g) || []).map(Number); if (s === 'transparent') return [0, 0, 0, 0]; cv.clearRect(0, 0, 1, 1); cv.fillStyle = s; cv.fillRect(0, 0, 1, 1); const d = cv.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
  const lum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const bgOf = (el) => { let e = el; const layers = []; while (e && e.nodeType === 1) { const c = rgb(getComputedStyle(e).backgroundColor); if (c.length >= 3 && (c[3] ?? 1) > 0) { layers.push(c); if ((c[3] ?? 1) >= 0.95) break; } e = e.parentElement; } let base = document.documentElement.classList.contains('dark') || matchMedia('(prefers-color-scheme: dark)').matches && !document.documentElement.classList.contains('light') ? [24, 24, 27] : [245, 245, 247]; for (const c of layers.reverse()) { const a = c[3] ?? 1; base = base.map((v, i) => v * (1 - a) + c[i] * a); } return base; };
  const contrast = (fg, bg) => { const a = fg[3] ?? 1; const f = fg.slice(0, 3).map((v, i) => v * a + bg[i] * (1 - a)); const L1 = lum(f), L2 = lum(bg); return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05); };
  const vis = (el) => { const cs = getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) return false; const r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1 && r.bottom > 0 && r.right > 0 && r.top < H && r.left < W; };
  const box = (r) => `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`;
  const sel = process => 0;
  const isBlock = (el) => { const cs = getComputedStyle(el); return el.matches('.glass-card,[class*=card],[role=dialog],[role=menu],aside,nav,header,section,button,.ios-switch,input,select,[role=tab],[role=menuitem],[role=menuitemradio]') || (cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent') || cs.borderTopWidth !== '0px' && cs.borderTopStyle !== 'none'; };
  const walk = (el, depth) => {
    if (!vis(el)) return;
    const tag = el.tagName.toLowerCase();
    if (tag === 'svg' || tag === 'script' || tag === 'style') return;
    const direct = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(' ').trim();
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    let line = null;
    if (direct) {
      const fg = rgb(cs.color); const c = contrast(fg, bgOf(el));
      const clip = el.scrollWidth > el.clientWidth + 1 && /hidden|clip/.test(cs.overflow + cs.textOverflow) ? ' CLIPPED' : '';
      line = `${'  '.repeat(depth)}"${direct.slice(0, 60)}" ${box(r)} ${cs.fontSize}/${cs.fontWeight} c${c.toFixed(1)}${c < 4.5 && parseFloat(cs.fontSize) < 18 ? '!' : ''}${clip}`;
    } else if (isBlock(el) && r.width > 24 && r.height > 14) {
      const id = el.id ? '#' + el.id : '';
      const cls = (typeof el.className === 'string' ? el.className : '').split(/\s+/).filter((c) => c && !/^(w-|h-|p[xytblr]?-|m[xytblr]?-|text-|flex|items|justify|gap|rounded|relative|absolute|min-|max-|shrink|grow|overflow|z-|inset|top|left|right|bottom|transition|duration|hidden)/.test(c)).slice(0, 2).join('.');
      line = `${'  '.repeat(depth)}[${tag}${id}${cls ? '.' + cls : ''}] ${box(r)} r${cs.borderRadius.split(' ')[0]}`;
    }
    if (line) out.push(line);
    for (const ch of el.children) walk(ch, line ? depth + 1 : depth);
  };
  walk(document.body, 0);
  return out.join('\n');
})()

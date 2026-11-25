(() => {
  const out = [];
  const vw = innerWidth, vh = innerHeight;
  const els = [...document.querySelectorAll('[class*="proto-"], .proto-new, [id^="proto-"]')].filter((e) => !e.closest('.proto-annot') || e.classList.contains('proto-annot'));
  for (const e of els.slice(0, 40)) {
    const r = e.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) { out.push(`ZERO ${e.className}`); continue; }
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    let cov = '';
    if (cx >= 0 && cy >= 0 && cx < vw && cy < vh) {
      const t = document.elementFromPoint(cx, cy);
      if (t && !(t === e || e.contains(t) || t.contains(e))) cov = ` COVERED-BY ${(t.id || t.className || t.tagName).toString().slice(0, 40)}`;
    } else cov = ' OFFSCREEN';
    const clip = e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflow !== 'visible' ? ' CLIPPED' : '';
    const txt = (e.innerText || '').replace(/\s+/g, ' ').slice(0, 50);
    out.push(`${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)} .${String(e.className).split(' ').filter((c) => c.startsWith('proto')).join('.') || e.id}${cov}${clip} "${txt}"`);
  }
  // any text that overflows its box horizontally in the viewport
  const over = [];
  for (const e of document.querySelectorAll('p, span, button, h3, label')) {
    const r = e.getBoundingClientRect();
    if (r.width < 4 || r.bottom < 0 || r.top > vh) continue;
    if (r.right > vw + 1 || r.left < -1) over.push(`OUT-OF-VIEW ${e.tagName} "${(e.innerText || '').slice(0, 30)}" ${Math.round(r.left)}-${Math.round(r.right)}`);
  }
  return out.concat(over.slice(0, 6)).join('\n');
})()

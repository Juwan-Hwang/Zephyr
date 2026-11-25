// Evaluate in page: returns visible text blocks with rects (reading order)
(() => {
  const out = [];
  const vw = innerWidth, vh = innerHeight;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  let el;
  while ((el = walker.nextNode())) {
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
    let own = '';
    for (const n of el.childNodes) if (n.nodeType === 3) own += n.textContent;
    own = own.trim().replace(/\s+/g, ' ');
    const tag = el.tagName.toLowerCase();
    if (!own && !['input', 'select', 'textarea', 'canvas', 'svg'].includes(tag)) continue;
    if (tag === 'svg' && el.closest('svg') !== el) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.right < 0 || r.bottom < 0 || r.left > vw || r.top > vh) continue;
    // check not covered / clipped by hidden ancestor overflow: approximate with elementFromPoint
    const cx = Math.min(vw - 1, Math.max(0, r.left + r.width / 2)), cy = Math.min(vh - 1, Math.max(0, r.top + r.height / 2));
    const top = document.elementFromPoint(cx, cy);
    const vis = top && (top === el || el.contains(top) || top.contains(el)) ? '' : ' [covered]';
    let label = own;
    if (tag === 'input' || tag === 'textarea') label = `<${tag} ${el.type || ''} value="${el.value}" ph="${el.placeholder || ''}" ${el.checked ? 'checked' : ''}>`;
    if (tag === 'select') label = `<select value="${el.value}">`;
    if (tag === 'canvas' || tag === 'svg') { if (r.width < 30) continue; label = `<${tag}>`; }
    out.push([Math.round(r.top), Math.round(r.left), Math.round(r.width), Math.round(r.height), (el.id ? '#' + el.id + ' ' : '') + label.slice(0, 80) + vis]);
  }
  out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return out.map((o) => `${o[0]},${o[1]} ${o[2]}x${o[3]}  ${o[4]}`).join('\n');
})()

// Evaluate in page: list visible content boxes (text, controls, icons) that
// overlap each other or spill outside the viewport. Empty result = clean.
(() => {
  const vw = innerWidth, vh = innerHeight;
  const items = [];
  // An open modal covers the page: only check what is inside it.
  let scope = null;
  for (const e of document.body.querySelectorAll('*')) {
    const cs = getComputedStyle(e);
    if (cs.position !== 'fixed' || cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.5) continue;
    const r = e.getBoundingClientRect();
    if (r.width >= vw * 0.95 && r.height >= vh * 0.95 && e.querySelector('button, input')) scope = e;
  }
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  let el;
  const visible = (e) => {
    for (let n = e; n && n !== document.body; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.05) return false;
    }
    return true;
  };
  while ((el = walker.nextNode())) {
    const tag = el.tagName.toLowerCase();
    if (scope && !scope.contains(el)) continue;
    if (el.closest('[aria-hidden="true"]:not(svg)') && tag !== 'canvas') continue;
    if (el.closest('.proto-annot, .sr-only, #node-wheel-dropdown, .dz-node-picker.dz-hidden')) continue;
    let own = '';
    for (const n of el.childNodes) if (n.nodeType === 3) own += n.textContent;
    own = own.trim();
    const ctl = ['input', 'select', 'textarea'].includes(tag) || (tag === 'svg' && el.closest('svg') === el) || el.classList.contains('ios-switch');
    if (!own && !ctl) continue;
    if (tag === 'input' && (el.type === 'checkbox' || el.type === 'hidden')) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 3 || r.height < 3) continue;
    if (r.bottom <= 0 || r.top >= vh) continue;
    if (!visible(el)) continue;
    // clip by overflow ancestors
    let L = r.left, T = r.top, R = r.right, B = r.bottom, clippedAway = false;
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (/(hidden|auto|scroll|clip)/.test(cs.overflow + cs.overflowX + cs.overflowY)) {
        const pr = n.getBoundingClientRect();
        L = Math.max(L, pr.left); T = Math.max(T, pr.top); R = Math.min(R, pr.right); B = Math.min(B, pr.bottom);
        if (R - L < 2 || B - T < 2) { clippedAway = true; break; }
      }
    }
    if (clippedAway) continue;
    items.push({ el, L, T, R, B, label: (el.id ? '#' + el.id + ' ' : '') + (own || '<' + tag + '>').slice(0, 40) });
  }
  const out = [];
  const covers = [];
  const POP = '[role=menu],[role=tooltip],[role=listbox]';
  for (const it of items) {
    if (it.R > vw + 1 || it.L < -1) out.push(`OUT-X ${it.label} [${Math.round(it.L)}..${Math.round(it.R)}]`);
  }
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const a = items[i], b = items[j];
    if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
    const w = Math.min(a.R, b.R) - Math.max(a.L, b.L), h = Math.min(a.B, b.B) - Math.max(a.T, b.T);
    // 弹出层（菜单、提示）本来就浮在内容上方：只报告弹出层内部的重叠，盖住下面内容单独记一笔
    const pa = a.el.closest(POP), pb = b.el.closest(POP);
    if (w > 2 && h > 2 && pa !== pb) { covers.push(`${(pa ? a : b).label} 盖住 ${(pa ? b : a).label}`); continue; }
    if (w > 2 && h > 2) out.push(`OVERLAP ${a.label} × ${b.label} (${Math.round(w)}x${Math.round(h)} at ${Math.round(Math.max(a.L, b.L))},${Math.round(Math.max(a.T, b.T))})`);
  }
  return (out.length ? out.join('\n') : 'no overlaps') + (covers.length ? `\n(弹出层盖住内容 ${covers.length} 处，按设计允许：${covers.slice(0, 3).join('；')})` : '');
})()

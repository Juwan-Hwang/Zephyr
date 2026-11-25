(() => {
  const o = [];
  const b = (el) => { if (!el) return 'none'; const r = el.getBoundingClientRect(); return `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`; };
  const cls = (el) => el ? (el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + '.' + String(typeof el.className === 'string' ? el.className : el.className.baseVal).split(/\s+/).slice(0, 5).join('.')) : 'none';
  const nav = document.querySelector('#sidebar-nav');
  if (nav) {
    const btns = [...nav.querySelectorAll('button, a')].slice(0, 3);
    btns.forEach((x) => { o.push('NAV ' + cls(x) + ' ' + b(x) + ' color ' + getComputedStyle(x).color + ' bg ' + getComputedStyle(x).backgroundColor); [...x.querySelectorAll('*')].forEach((c) => { const cs = getComputedStyle(c); o.push('   ' + cls(c) + ' ' + b(c) + ' col ' + cs.color + ' bg ' + cs.backgroundColor + ' bd ' + cs.borderTopWidth + ' ' + cs.borderTopColor + ' sh ' + (cs.boxShadow === 'none' ? '-' : 'Y') + ' op ' + cs.opacity); }); });
    let p = nav; while (p) { const c = getComputedStyle(p).backgroundColor; if (c !== 'rgba(0, 0, 0, 0)') { o.push('nav bg from ' + cls(p) + ' ' + c); break; } p = p.parentElement; }
  }
  const card = [...document.querySelectorAll('.proxy-card')].find((c) => c.textContent.includes('自动选择'));
  if (card) { o.push('CARD ' + b(card)); const walk = (e, d) => { [...e.children].forEach((c) => { const cs = getComputedStyle(c); if (cs.display === 'none') return; o.push('  '.repeat(d) + cls(c) + ' ' + b(c) + ' "' + ([...c.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join('').slice(0, 25)) + '" ' + cs.display + ' fl' + cs.flex); if (d < 5) walk(c, d + 1); }); }; walk(card, 1); }
  return o.join('\n');
})()

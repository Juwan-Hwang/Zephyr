// Check the issues found by looking at the screenshots.
(() => {
  const o = [];
  const b = (el) => { if (!el) return 'none'; const r = el.getBoundingClientRect(); return `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`; };
  const cls = (el) => el ? (el.tagName.toLowerCase() + '.' + String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className).split(/\s+/).slice(0, 4).join('.')) : 'none';
  document.querySelectorAll('#mode-selector-container button, .dz-mode-seg button').forEach((x) => o.push(`mode "${x.textContent.trim()}" ${b(x)} sw${x.scrollWidth} cw${x.clientWidth}`));
  const hero = document.querySelector('.fh-hero, .home-hero');
  if (hero) {
    o.push('hero ' + b(hero) + ' ' + cls(hero));
    hero.querySelectorAll('svg, canvas').forEach((s) => { const r = s.getBoundingClientRect(); if (r.width > 100) o.push('  graph ' + cls(s) + ' ' + b(s) + ' parent ' + cls(s.parentElement) + ' ' + b(s.parentElement)); });
    hero.querySelectorAll('.home-speed').forEach((s) => o.push('  speed ' + b(s) + ' ' + s.textContent.replace(/\s+/g, ' ').trim().slice(0, 60)));
  }
  // small red/colored dots in the top bar
  [...document.querySelectorAll('header *, [data-tauri-drag-region] *, .titlebar *')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 4 && r.width < 16 && r.height < 16 && r.top < 60; }).slice(0, 6).forEach((e) => o.push('topdot ' + cls(e) + ' ' + b(e) + ' bg ' + getComputedStyle(e).backgroundColor + ' title=' + (e.getAttribute('title') || e.parentElement?.getAttribute('title') || e.getAttribute('aria-label') || '')));
  const act = document.querySelector('#sidebar-nav .nav-btn.active');
  if (act) { o.push('nav active ' + b(act) + ' bg ' + getComputedStyle(act).backgroundColor); [...act.querySelectorAll('*')].forEach((c) => { const cs = getComputedStyle(c); if (cs.backgroundColor !== 'rgba(0, 0, 0, 0)') o.push('  child ' + cls(c) + ' ' + b(c) + ' bg ' + cs.backgroundColor + ' r' + cs.borderRadius); }); }
  const nonact = document.querySelector('#sidebar-nav .nav-btn:not(.active)');
  if (nonact) [...nonact.querySelectorAll('*')].forEach((c) => { const cs = getComputedStyle(c); if (cs.backgroundColor !== 'rgba(0, 0, 0, 0)') o.push('  nonact child ' + cls(c) + ' bg ' + cs.backgroundColor); });
  // clipped text anywhere visible
  [...document.querySelectorAll('body *')].forEach((e) => { const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden') return; const r = e.getBoundingClientRect(); if (r.width < 2 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return; const t = [...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(''); if (!t) return; if (e.scrollWidth > e.clientWidth + 1 && /hidden|clip/.test(cs.overflow + cs.overflowX + cs.textOverflow)) o.push(`CLIP "${t.slice(0, 30)}" ${b(e)} sw${e.scrollWidth} cw${e.clientWidth}`); let p = e.parentElement; while (p && p !== document.body) { const pc = getComputedStyle(p); if (/hidden|clip/.test(pc.overflow + pc.overflowY)) { const pr = p.getBoundingClientRect(); if (r.bottom > pr.bottom + 1 || r.top < pr.top - 1) { o.push(`VCUT "${t.slice(0, 30)}" ${b(e)} by ${cls(p)} ${b(p)}`); } break; } p = p.parentElement; } });
  const alts = document.querySelector('.fh-alts');
  if (alts) { o.push('alts ' + b(alts) + ' label ' + b(alts.querySelector('.fh-alts-label')) + ' list ' + b(alts.querySelector('.fh-alts-list')) + ' current ' + b(document.querySelector('.fh-current'))); }
  return o.join('\n');
})()

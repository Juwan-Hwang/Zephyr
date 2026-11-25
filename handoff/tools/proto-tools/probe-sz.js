(() => {
  const r = (s) => { const e = document.querySelector(s); if (!e) return s + ':none'; const b = e.getBoundingClientRect(); return `${s}: x${Math.round(b.x)} y${Math.round(b.y)} w${Math.round(b.width)} h${Math.round(b.height)}`; };
  const out = [r('#sidebar-nav'), r('#sidebar-nav .nav-btn.is-active'), r('#sidebar-nav [data-nav=settings]'), r('.fh-strip'), r('.fh-hero'), r('.fh-node'), r('[data-page=home]')];
  const v = document.querySelector('#speed-down-val'); if (v) out.push('num ' + getComputedStyle(v).fontSize);
  const h = document.querySelector('#test-all-btn')?.closest('header');
  if (h && h.clientWidth) { out.push('hdr ' + h.className.split(' ').filter(c => /compact|fs-/.test(c)).join(',') + ' sw' + h.scrollWidth + ' cw' + h.clientWidth); out.push('order ' + [...h.querySelectorAll('button')].map(b => (b.id || b.className.split(' ')[0]) + ':' + Math.round(b.getBoundingClientRect().width)).join(' ')); }
  return out.join('\n');
})()

(() => {
  const r = (e) => { const b = e.getBoundingClientRect(); return `x${Math.round(b.x)}-${Math.round(b.right)} y${Math.round(b.y)}-${Math.round(b.bottom)}`; };
  const o = [];
  const sel = ['.dz-kpis > *', '#dz-traffic-card', '.dz-node-wrap', '.dz-grid-bottom > *', '.fh-hero', '.fh-hero .home-hero-speeds', '.fh-hero .home-hero-chart', '.fh-hero .fh-total'];
  for (const s of sel) for (const e of document.querySelectorAll(s)) if (e.offsetParent) o.push(s + ' ' + r(e));
  return o.join('\n');
})()

(() => {
  const r = (e) => { const b = e.getBoundingClientRect(); return `y${Math.round(b.y)} h${Math.round(b.height)}`; };
  const o = [];
  const sub = [...document.querySelectorAll('.dz-side > .glass-card')].pop();
  const node = document.querySelector('.dz-node-wrap .glass-card');
  const tr = document.querySelector('#dz-traffic-card');
  for (const [n, c] of [['sub', sub], ['node', node], ['traffic', tr]]) { o.push(n + ' ' + r(c) + ' ' + getComputedStyle(c).padding); for (const k of c.children) o.push('  ' + (k.id || k.className.split(' ').slice(0, 2).join('.')) + ' ' + r(k) + ' ' + (k.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 50)); }
  const bot = document.querySelector('.dz-grid-bottom'); for (const k of bot.children) o.push('bottom ' + (k.querySelector('.dz-card-title')?.textContent || '').trim());
  return o.join('\n');
})()

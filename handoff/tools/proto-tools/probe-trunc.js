(() => {
  const c = document.querySelector('.dz-content') || document.querySelector('[data-page=home]');
  const o = [];
  if (document.querySelector('.dz-content')) { const d = document.querySelector('.dz-content'); o.push(`content sh${d.scrollHeight} ch${d.clientHeight}`); for (const ch of d.children) { const b = ch.getBoundingClientRect(); if (b.height) o.push(`${ch.className.split(' ').slice(0,2).join('.')} x${Math.round(b.x)} y${Math.round(b.y)} w${Math.round(b.width)} h${Math.round(b.height)}`); } }
  const bad = [];
  for (const e of document.querySelectorAll('.dz-content *, .fh-page *')) {
    if (!e.offsetParent || e.children.length > 2) continue;
    const cs = getComputedStyle(e);
    if (e.scrollWidth > e.clientWidth + 1 && (cs.textOverflow === 'ellipsis' || cs.overflow === 'hidden') && e.textContent.trim()) bad.push('W:' + e.textContent.trim().slice(0, 30));
  }
  for (const card of document.querySelectorAll('.dz-content .glass-card, .fh-page .glass-card')) { if (card.offsetParent && card.scrollHeight > card.clientHeight + 2) bad.push('H:' + (card.querySelector('.dz-card-title')?.textContent || card.className).trim().slice(0, 30) + ` ${card.scrollHeight}/${card.clientHeight}`); }
  o.push('trunc ' + (bad.join(' | ') || 'none'));
  return o.join('\n');
})()

(() => {
  const o = [];
  document.querySelectorAll('.proto-force-hover').forEach((c) => {
    o.push('FORCED ' + c.tagName + ' ' + c.className.slice(0, 120));
    c.querySelectorAll('.node-retest-btn').forEach((b) => { const r = b.getBoundingClientRect(); const cs = getComputedStyle(b); o.push('  btn ' + b.className + ' ' + Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + ' pos ' + cs.position + ' op ' + cs.opacity + ' parent ' + b.parentElement.className); });
  });
  return o.join('\n');
})()

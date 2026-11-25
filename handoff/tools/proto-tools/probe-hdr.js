(() => {
  const h = document.querySelector('#test-all-btn').closest('header');
  const o = [];
  const dump = () => [...h.querySelectorAll(':scope > *, :scope > * > *')].map(e => (e.id || e.tagName + '.' + (e.className.baseVal ?? e.className).split(' ')[0]) + ':' + Math.round(e.getBoundingClientRect().width)).join(' ');
  o.push('full ' + h.className + ' sw' + h.scrollWidth + ' cw' + h.clientWidth + '\n' + dump());
  h.classList.remove('fs-lat-icon');
  o.push('nolat sw' + h.scrollWidth + ' cw' + h.clientWidth + '\n' + dump());
  return o.join('\n');
})()

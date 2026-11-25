(() => { const bad = [];
 for (const e of document.querySelectorAll('.fh-page *, #sidebar-nav *')) { if (!e.offsetParent) continue; if (e.children.length) continue; const t = e.textContent.trim(); if (!t) continue; if (e.scrollWidth > e.clientWidth + 1) bad.push('W:' + t.slice(0, 30) + ` ${e.scrollWidth}/${e.clientWidth}`); }
 const nodes = [...document.querySelectorAll('.fh-page *')].filter(e => e.offsetParent && !e.children.length && e.textContent.trim());
 for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) { const a = nodes[i].getBoundingClientRect(), b = nodes[j].getBoundingClientRect(); if (a.width && b.width && a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1 && !nodes[i].contains(nodes[j])) bad.push('O:' + nodes[i].textContent.trim().slice(0, 15) + '~' + nodes[j].textContent.trim().slice(0, 15)); }
 return 'trunc ' + (bad.join(' | ') || 'none'); })()

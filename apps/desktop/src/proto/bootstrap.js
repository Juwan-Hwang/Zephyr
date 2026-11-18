// Classic (sync) script: Tauri IPC target the promo mock layer plugs into.
(function () {
  var target = {
    invoke: function () { return Promise.resolve(null); },
    transformCallback: function () { return 'mock-cb'; },
    unregisterCallback: function () {},
    convertFileSrc: function (p) { return p; },
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main', windowLabel: 'main' } },
  };
  window.__TAURI_INTERNALS__ = new Proxy(target, {
    get: function (t, p) { return t[p]; },
    set: function (t, p, v) { t[p] = v; return true; },
  });
  window.__DEMO_INTERNALS_TARGET__ = target;
  window.__AETHER_DEMO__ = true;
  var q = new URLSearchParams(location.search);
  window.__PROTO__ = window.__PROTO__ || q.get('proto') || '';
  if (q.get('theme')) localStorage.setItem('proto-theme', q.get('theme'));
})();

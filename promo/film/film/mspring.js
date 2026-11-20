// Ported from motiondivision/motion (MIT): motion-dom/src/animation/generators/spring.ts and
// motion-utils/src/easing/*. Pure functions of time, so they work inside a seekable composition.
(function () {
  const minDamping = 0.05;
  const bounceToDampingRatio = (b) => (b < 0 ? 1 / Math.max(1 + b, minDamping) : Math.max(1 - b, minDamping));
  function approximateRoot(env, der, guess) { let r = guess; for (let i = 1; i < 12; i++) r = r - env(r) / der(r); return r; }
  function overdampedFreqScale(z, critT) {
    if (!(z > 1)) return 1;
    const root = Math.sqrt(z * z - 1), slow = z - root, fast = z + root;
    const target = 2 * root * Math.exp(-critT) * (1 + critT);
    return approximateRoot((ft) => fast * Math.exp(-slow * ft) - slow * Math.exp(-fast * ft) - target,
      (ft) => Math.exp(-fast * ft) - Math.exp(-slow * ft), critT) / critT;
  }
  // spring(visualDuration s, bounce) → f(t seconds) giving progress 0→1 (overshoots when bounce>0)
  function spring(visualDuration = 0.3, bounce = 0.3, velocity = 0) {
    const z0 = bounceToDampingRatio(bounce);
    const root = ((2 * Math.PI) / (visualDuration * 1.2)) * overdampedFreqScale(z0, (2 * Math.PI) / 1.2);
    const stiffness = root * root, mass = 1, damping = 2 * z0 * Math.sqrt(stiffness);
    const z = damping / (2 * Math.sqrt(stiffness * mass));
    const w0 = Math.sqrt(stiffness / mass);            // rad/s
    const decay = z * w0, delta = 1, v = -velocity;     // motion's sign convention
    let f;
    if (z < 1) {
      const wd = w0 * Math.sqrt(1 - z * z);
      const A = (v + decay * delta) / wd;
      f = (t) => 1 - Math.exp(-decay * t) * (A * Math.sin(wd * t) + delta * Math.cos(wd * t));
    } else if (z === 1) {
      f = (t) => 1 - Math.exp(-w0 * t) * (delta + (v + w0 * delta) * t);
    } else {
      const dw = w0 * Math.sqrt(z * z - 1);
      f = (t) => {
        const env = Math.exp(-z * w0 * t), fw = Math.min(dw * t, 300);
        return 1 - (env * ((v + z * w0 * delta) * Math.sinh(fw) + dw * delta * Math.cosh(fw))) / dw;
      };
    }
    return (t) => (t <= 0 ? 0 : f(t));
  }
  // cubic-bezier, as motion-utils implements it (binary subdivision)
  function cubicBezier(x1, y1, x2, y2) {
    if (x1 === y1 && x2 === y2) return (p) => p;
    const calc = (t, a1, a2) => (((1 - 3 * a2 + 3 * a1) * t + (3 * a2 - 6 * a1)) * t + 3 * a1) * t;
    const getT = (x) => { let lo = 0, hi = 1, cur, t, i = 0; do { t = lo + (hi - lo) / 2; cur = calc(t, x1, x2) - x; if (cur > 0) hi = t; else lo = t; } while (Math.abs(cur) > 1e-7 && ++i < 12); return t; };
    return (p) => (p <= 0 ? 0 : p >= 1 ? 1 : calc(getT(p), y1, y2));
  }
  const reverse = (e) => (p) => 1 - e(1 - p);
  const mirror = (e) => (p) => (p <= 0.5 ? e(2 * p) / 2 : (2 - e(2 * (1 - p))) / 2);
  const easeIn = cubicBezier(0.42, 0, 1, 1), easeOut = cubicBezier(0, 0, 0.58, 1), easeInOut = cubicBezier(0.42, 0, 0.58, 1);
  const backOut = cubicBezier(0.33, 1.53, 0.69, 0.99), backIn = reverse(backOut), backInOut = mirror(backIn);
  const anticipate = (p) => (p >= 1 ? 1 : (p *= 2) < 1 ? 0.5 * backIn(p) : 0.5 * (2 - Math.pow(2, -10 * (p - 1))));
  const circIn = (p) => 1 - Math.sin(Math.acos(Math.min(1, Math.max(0, p)))), circOut = reverse(circIn), circInOut = mirror(circIn);
  // "Apple" curves commonly used in product films
  const appleOut = cubicBezier(0.16, 1, 0.3, 1), appleInOut = cubicBezier(0.65, 0, 0.35, 1), whip = cubicBezier(0.7, 0, 0.2, 1);
  window.MO = { spring, cubicBezier, easeIn, easeOut, easeInOut, backIn, backOut, backInOut, anticipate, circIn, circOut, circInOut, appleOut, appleInOut, whip, mirror, reverse };
})();

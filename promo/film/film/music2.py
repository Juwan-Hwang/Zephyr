"""Original score for the Zephyr film, synthesised in numpy (no samples, no licences).
112 BPM, 26 bars + tail. D minor: Dm – B♭ – F – C.
Writes audio/music.wav (48 kHz stereo float) and audio/music_stems/*.wav
"""
import json, os
import numpy as np
import soundfile as sf
from scipy.signal import butter, sosfilt, fftconvolve

SR = 48000
BPM = 124
BEAT = 60 / BPM
BAR = BEAT * 4
NBARS = 24.5
DUR = NBARS * BAR + 2.4
N = int(DUR * SR)
rng = np.random.default_rng(7)
os.makedirs('audio/music2_stems', exist_ok=True)


def tb(bar, beat=0.0):
    return bar * BAR + beat * BEAT


def buf():
    return np.zeros((N, 2), np.float32)


def add(dst, sig, t, gain=1.0, pan=0.0):
    i = int(round(t * SR))
    if sig.ndim == 1:
        l = np.cos((pan + 1) * np.pi / 4); r = np.sin((pan + 1) * np.pi / 4)
        sig = np.stack([sig * l * 1.414, sig * r * 1.414], 1)
    j = min(N, i + len(sig))
    if i < 0 or i >= N:
        return
    dst[i:j] += sig[: j - i] * gain


def lp(x, f, order=2):
    return sosfilt(butter(order, min(f, SR / 2 - 100), 'low', fs=SR, output='sos'), x, axis=0)


def hp(x, f, order=2):
    return sosfilt(butter(order, f, 'high', fs=SR, output='sos'), x, axis=0)


def bp(x, f0, f1, order=2):
    return sosfilt(butter(order, [f0, f1], 'band', fs=SR, output='sos'), x, axis=0)


def env_adsr(n, a, d, s, r, total=None):
    a, d, r = int(a * SR), int(d * SR), int(r * SR)
    total = n if total is None else total
    e = np.ones(total) * s
    e[:a] = np.linspace(0, 1, a, endpoint=False) if a else e[:a]
    e[a:a + d] = np.linspace(1, s, max(1, len(e[a:a + d])))
    rel = np.linspace(1, 0, r) ** 2 if r else np.array([])
    tail_start = max(0, total - r)
    e[tail_start:] *= rel[: total - tail_start]
    return e


def midi(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def saw(f, n, phase=0.0):
    t = np.arange(n) / SR
    ph = (f * t + phase) % 1.0
    # polyBLEP-light: soften by slight lowpass later
    return 2 * ph - 1


def reverb_ir(sec=2.6, damp=3.2, pre=0.012):
    n = int(sec * SR)
    t = np.arange(n) / SR
    ir = rng.standard_normal((n, 2)) * np.exp(-damp * t)[:, None]
    ir = lp(ir, 7500)
    ir[: int(pre * SR)] = 0
    ir /= np.sqrt((ir ** 2).sum(0, keepdims=True))
    return ir.astype(np.float32)


IR_HALL = reverb_ir(3.4, 2.1)
IR_ROOM = reverb_ir(1.1, 5.5)


def verb(x, ir, wet):
    y = np.stack([fftconvolve(x[:, c], ir[:, c])[: len(x)] for c in range(2)], 1)
    return x + y * wet


# ───────────────────────── instruments ─────────────────────────

def kick(gain=1.0):
    n = int(0.55 * SR); t = np.arange(n) / SR
    f = 46 + 110 * np.exp(-t * 32)
    ph = 2 * np.pi * np.cumsum(f) / SR
    body = np.sin(ph) * np.exp(-t * 6.5)
    click = hp(rng.standard_normal(n) * np.exp(-t * 300), 2500) * 0.25
    sig = np.tanh((body + click) * 1.6) * gain
    return sig


def sub_drop(f0=82, f1=31, sec=2.2):
    n = int(sec * SR); t = np.arange(n) / SR
    f = f1 + (f0 - f1) * np.exp(-t * 2.4)
    s = np.sin(2 * np.pi * np.cumsum(f) / SR)
    s = s + 0.18 * np.sin(2 * 2 * np.pi * np.cumsum(f) / SR)
    return np.tanh(s * 1.4) * np.exp(-t * 1.7) * np.minimum(1, t * 400)


def snap():
    n = int(0.32 * SR); t = np.arange(n) / SR
    x = rng.standard_normal(n)
    e = np.exp(-t * 38) + 0.5 * np.exp(-np.maximum(0, t - 0.011) * 45) * (t > 0.011)
    s = bp(x * e, 900, 5200)
    return s * 0.9


def hat(open_=False):
    n = int((0.22 if open_ else 0.06) * SR); t = np.arange(n) / SR
    x = rng.standard_normal(n)
    s = hp(x, 7800, 3) * np.exp(-t * (14 if open_ else 75))
    return s * 0.5


def pluck(m, sec=0.9, bright=1.0):
    """FM glass pluck."""
    n = int(sec * SR); t = np.arange(n) / SR
    f = midi(m)
    idx = (2.2 * bright) * np.exp(-t * 9)
    mod = np.sin(2 * np.pi * f * 3.0 * t) * idx
    car = np.sin(2 * np.pi * f * t + mod)
    car += 0.35 * np.sin(2 * np.pi * f * 2.0 * t + mod * 0.5)
    e = np.exp(-t * 5.2) * np.minimum(1, t * 900)
    return car * e * 0.5


def bell(m, sec=4.5):
    n = int(sec * SR); t = np.arange(n) / SR
    f = midi(m)
    s = (np.sin(2 * np.pi * f * t + 1.4 * np.exp(-t * 2) * np.sin(2 * np.pi * f * 3.5 * t))
         + 0.4 * np.sin(2 * np.pi * f * 2.76 * t) * np.exp(-t * 2.5)
         + 0.2 * np.sin(2 * np.pi * f * 5.4 * t) * np.exp(-t * 4))
    return s * np.exp(-t * 0.9) * np.minimum(1, t * 600) * 0.4


def bass(m, sec, cutoff=520):
    n = int(sec * SR); t = np.arange(n) / SR
    f = midi(m)
    s = 0.6 * saw(f, n) + 0.4 * saw(f * 1.004, n, 0.3) + 0.5 * np.sin(2 * np.pi * f * t)
    s = lp(s, cutoff, 3)
    e = env_adsr(n, 0.006, 0.18, 0.62, 0.08)
    return np.tanh(s * e * 1.3) * 0.55


def pad(notes, sec, cutoff=1800, attack=0.9, release=1.6):
    n = int(sec * SR)
    out = np.zeros((n, 2))
    for m in notes:
        for k, det in enumerate([-0.11, -0.05, 0.0, 0.05, 0.11]):
            f = midi(m) * 2 ** (det / 12)
            v = saw(f, n, rng.random())
            pan = (k - 2) / 2.2
            out[:, 0] += v * np.cos((pan + 1) * np.pi / 4)
            out[:, 1] += v * np.sin((pan + 1) * np.pi / 4)
    out = lp(out, cutoff, 2)
    e = env_adsr(n, attack, 0.5, 0.85, release)
    return out * e[:, None] * (0.075 / max(1, len(notes) ** 0.5))


def riser(sec, f0=300, f1=6000):
    n = int(sec * SR); t = np.arange(n) / SR
    x = rng.standard_normal(n)
    out = np.zeros(n)
    k = 24
    seglen = n // k
    for i in range(k):
        a = i * seglen; b = n if i == k - 1 else (i + 1) * seglen
        fc = f0 * (f1 / f0) ** (i / (k - 1))
        out[a:b] = bp(x[max(0, a - 2000):b], fc * 0.7, min(fc * 1.4, SR / 2 - 200))[-(b - a):]
    e = (t / sec) ** 2.2
    tone = np.sin(2 * np.pi * np.cumsum(220 * 2 ** (2.0 * t / sec)) / SR) * 0.15
    return (out * 0.8 + tone) * e


def swell(sec):
    """reverse-cymbal style swell into a hit."""
    n = int(sec * SR); t = np.arange(n) / SR
    x = hp(rng.standard_normal(n), 3000)
    return x * (t / sec) ** 3 * 0.5


def air(sec):
    n = int(sec * SR)
    x = rng.standard_normal((n, 2))
    x = bp(x, 400, 3200)
    t = np.arange(n) / SR
    return x * (0.5 + 0.5 * np.sin(2 * np.pi * t / 7.0))[:, None] * 0.06


# ───────────────────────── arrangement (v2, 124 BPM) ─────────────────────────
CH = {'Dm': [50, 57, 62, 65], 'Bb': [46, 53, 58, 62], 'F': [53, 57, 60, 65], 'C': [48, 55, 60, 64]}
ROOT = {'Dm': 38, 'Bb': 34, 'F': 41, 'C': 36}
ARP = {'Dm': [74, 69, 77, 72, 74, 81, 77, 69], 'Bb': [74, 70, 77, 72, 74, 82, 77, 70],
       'F': [72, 69, 77, 72, 76, 81, 77, 69], 'C': [72, 67, 76, 72, 74, 79, 76, 67]}
PROG = ['Dm', 'Bb', 'F', 'C']
def chord_at(bar):
    return PROG[(int(bar) // 1) % 4]
drums, bassb, padb, keys, fx = buf(), buf(), buf(), buf(), buf()

def groove_bar(b, c, kick_g=0.95, hats=True, bass_on=True, arp_oct=0, arp_g=0.2, half=False):
    for q in range(4):
        if q in (0, 2) or (q == 3 and int(b) % 2 == 1):
            add(drums, kick(kick_g if q != 3 else 0.6), tb(b, q if q != 3 else 3.5))
        if q in (1, 3):
            add(drums, snap(), tb(b, q), 0.42, 0.05)
    if hats:
        for s16 in range(16):
            add(drums, hat(s16 % 8 == 6), tb(b, s16 * 0.25), 0.18 if s16 % 4 == 2 else 0.08, 0.35)
    if bass_on:
        for e8 in range(8):
            if half and e8 % 2: continue
            m = ROOT[c] + (12 if e8 == 7 else 0)
            add(bassb, bass(m, BEAT * 0.48, 420 + 260 * (e8 % 2 == 0)), tb(b, e8 * 0.5), 0.9 if e8 % 2 == 0 else 0.6)
    for i in range(8):
        add(keys, pluck(ARP[c][i] + arp_oct, 0.5, 0.9), tb(b, i * 0.5), arp_g, (-0.45 if i % 2 else 0.45))

# intro 0–3: line, lock on bar 1, the turn, carry hit on bar 3
add(fx, air(7.0), 0.0, 1.0)
add(fx, swell(1.1), tb(1) - 1.1, 0.8)
add(drums, kick(1.2), tb(1)); add(drums, sub_drop(), tb(1), 0.9)
add(keys, bell(74, 4.5), tb(1), 0.35, 0.15); add(keys, bell(62, 4.5), tb(1), 0.3, -0.2)
add(padb, pad(CH['Dm'], BAR * 2 + 1.0, 1000, 0.6), tb(1))
for b in (1, 2):
    for i in range(8):
        if b == 1 and i < 2: continue
        add(keys, pluck(ARP[chord_at(b)][i] - 12, 0.6, 0.7), tb(b, i * 0.5), 0.3, (-0.4 if i % 2 else 0.4))
add(fx, riser(BAR * 0.75, 300, 7000), tb(2, 1), 0.6)
add(drums, kick(1.1), tb(3)); add(drums, sub_drop(72, 34, 1.4), tb(3), 0.7)

# 3–10.75 groove (console, proxies, prism)
for b in range(3, 13):
    c = chord_at(b)
    groove_bar(b, c, arp_g=0.2 if b < 11 else 0.24, arp_oct=0 if b < 11 else 12)
    if b % 2 == 1:
        add(padb, pad(CH[c], BAR * 2 + 0.8, 1500 if b < 11 else 2400, 0.25, 0.8), tb(b), 0.9)
# half bar 13: kick + snare, then the roll bar
add(drums, kick(0.9), tb(13)); add(drums, snap(), tb(13, 1), 0.42)
# bar 10: two beats of groove, a snare roll, then the burst on 10.75
add(drums, kick(0.9), tb(13.5)); add(drums, snap(), tb(13.5, 1), 0.42)
for i in range(4):
    add(drums, snap(), tb(13.5, 2 + i * 0.25), 0.08 + 0.3 * (i / 3) ** 2, 0.0)
add(fx, riser(BAR * 0.75, 400, 9000), tb(13.5), 0.6)
add(padb, pad(CH['C'], BAR * 0.75, 2600, 0.1, 0.3), tb(13.5), 0.7)
B0 = tb(14.25) + 0.12
for i in range(11):
    t = B0 + i * BEAT * 0.5
    c = 'Dm' if i < 6 else 'Bb'
    for m in CH[c]:
        add(keys, pluck(m + 12, 0.28, 1.4), t, 0.11, 0.0)
    add(drums, kick(0.55), t, 0.6); add(drums, hat(), t + BEAT * 0.25, 0.12, 0.4)
add(keys, bell(74, 3.0), B0 + 11 * BEAT * 0.5, 0.25, 0.0)
add(fx, swell(BEAT * 2.0), tb(16.25) - BEAT * 2.0, 0.6)
# 12.75 theme (dark groove), 14.5 lightweight (thin), 16 build, 17.5 reprise
add(drums, kick(1.1), tb(16.25)); add(drums, sub_drop(75, 32, 1.6), tb(16.25), 0.7)
for b in (16.25, 17.25):
    c = chord_at(b)
    groove_bar(b, c, arp_g=0.22)
    add(padb, pad(CH[c], BAR + 0.6, 2600, 0.2, 0.8), tb(b), 0.9)
for b in (18.0, 18.5, 19.0):
    c = chord_at(b)
    for q in (0, 1):
        add(drums, kick(0.6), tb(b, q * 2)); add(drums, snap(), tb(b, q * 2 + 1), 0.22)
    for i in range(4):
        add(keys, pluck(ARP[c][i] + 12, 0.5, 0.9), tb(b, i * 0.5), 0.16, (-0.45 if i % 2 else 0.45))
add(padb, pad(CH['F'], BAR * 1.5 + 0.6, 1200, 0.2, 0.6), tb(18), 0.8)
add(fx, riser(BAR * 1.5, 250, 9000), tb(19.5), 0.75)
for i in range(24):
    add(drums, snap(), tb(19.5, i * 0.25), 0.04 + 0.24 * (i / 23) ** 2, 0.0)
add(padb, pad(CH['C'], BAR * 1.5 + 0.3, 3000, 0.2, 0.3), tb(19.5), 0.8)
HIT = tb(21) + 0.86
add(fx, swell(0.86), tb(21), 0.7)
add(drums, kick(1.3), HIT); add(drums, sub_drop(86, 29, 3.0), HIT, 1.0)
add(padb, pad([38, 50, 57, 62, 65, 69], BAR * 2.5 + 2.0, 2200, 0.05, 2.4), HIT, 1.2)
for m, g, p in [(74, 0.35, 0.2), (81, 0.22, -0.25), (62, 0.3, 0.0)]:
    add(keys, bell(m, 6.0), HIT, g, p)
add(keys, bell(86, 4.5), tb(21) + 2.95, 0.16, 0.3)
add(keys, bell(81, 4.5), tb(21) + 3.8, 0.12, -0.3)

# ───────────────────────── mix ─────────────────────────
drums = verb(drums, IR_ROOM, 0.18)
keys = verb(keys, IR_HALL, 0.42)
padb = verb(padb, IR_HALL, 0.35)
fx = verb(fx, IR_HALL, 0.3)
bassb = lp(bassb, 3000)
drums = hp(drums, 38)
stems = {'drums': drums * 0.55, 'bass': hp(bassb, 45) * 0.42, 'pad': padb * 2.2, 'keys': keys * 2.3, 'fx': fx * 1.3}
mix = sum(stems.values())
mix = hp(mix, 28)
peak = np.abs(mix).max()
mix = mix / peak * 0.7
for k, v in stems.items():
    sf.write(f'audio/music2_stems/{k}.wav', (v / peak * 0.7).astype(np.float32), SR, subtype='FLOAT')
sf.write('audio/music2.wav', mix.astype(np.float32), SR, subtype='FLOAT')
json.dump({'bpm': BPM, 'beat': BEAT, 'bar': BAR, 'nbars': NBARS, 'dur': DUR}, open('audio/music2.json', 'w'))
print('music', round(DUR, 2), 's peak', round(float(peak), 2))

"""Music and sound design for the film, synthesized with numpy, locked to the 120 BPM grid in timeline.js.
Writes out/score.wav (music + sound design) and out/sfx.wav (sound design only, for laying a licensed track)."""
import numpy as np, wave, os

SR = 48000
DUR = 28.0
N = int(SR * DUR)
BEAT = 0.5
rng = np.random.default_rng(7)


def T(n):
    return np.arange(n) / SR


def filt(x, lo=None, hi=None, order=2):
    """Zero-phase band filter in the frequency domain."""
    X = np.fft.rfft(x, axis=0)
    f = np.fft.rfftfreq(x.shape[0], 1 / SR)
    h = np.ones_like(f)
    if hi: h /= np.sqrt(1 + (f / hi) ** (2 * order))
    if lo: h /= np.sqrt(1 + (lo / np.maximum(f, 1e-3)) ** (2 * order))
    return np.fft.irfft(X * (h[:, None] if x.ndim == 2 else h), n=x.shape[0], axis=0)


class Bus:
    def __init__(self):
        self.x = np.zeros((N, 2))

    def add(self, s, at, gain=1.0, pan=0.0):
        i = int(round(at * SR))
        if i >= N: return
        if s.ndim == 1:
            s = np.stack([s * np.cos((pan + 1) * np.pi / 4), s * np.sin((pan + 1) * np.pi / 4)], 1) * np.sqrt(2)
        if i < 0: s, i = s[-i:], 0
        j = min(N, i + len(s))
        self.x[i:j] += s[: j - i] * gain


def hz(n):
    names = dict(C=-9, Cs=-8, D=-7, Ds=-6, E=-5, F=-4, Fs=-3, G=-2, Gs=-1, A=0, As=1, B=2)
    return 440 * 2 ** ((names[n[:-1]] + (int(n[-1]) - 4) * 12) / 12)


# ---------- instruments ----------
def kick(gain=1.0, length=0.45):
    n = int(length * SR); t = T(n)
    f = 44 + 110 * np.exp(-t * 38)
    s = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 7.5)
    click = filt(rng.standard_normal(n) * np.exp(-t * 900), lo=2000) * 0.25
    return np.tanh((s + click) * 1.6) * gain


def hat(gain=1.0, decay=55):
    n = int(0.12 * SR); t = T(n)
    return filt(rng.standard_normal(n), lo=7500) * np.exp(-t * decay) * gain


def clap(gain=1.0):
    n = int(0.3 * SR); t = T(n)
    env = sum(np.exp(-np.maximum(t - d, 0) * 140) * (t >= d) for d in (0, 0.011, 0.022)) + 0.6 * np.exp(-t * 18)
    return filt(rng.standard_normal(n), lo=900, hi=5000) * env * gain


def tick(f=3000, gain=1.0):
    n = int(0.05 * SR); t = T(n)
    return (np.sin(2 * np.pi * f * t) * np.exp(-t * 120) + filt(rng.standard_normal(n), lo=3000) * np.exp(-t * 600) * 0.5) * gain


def impact(gain=1.0, length=2.2, sub=48):
    n = int(length * SR); t = T(n)
    body = np.sin(2 * np.pi * np.cumsum(sub + 60 * np.exp(-t * 20)) / SR) * np.exp(-t * 2.2)
    crack = filt(rng.standard_normal(n), lo=600, hi=9000) * np.exp(-t * 26)
    return np.tanh((body * 1.2 + crack * 0.7) * 1.3) * gain


def whoosh(length, rise=True, lo=200, hi=7000, gain=1.0):
    n = int(length * SR); s = rng.standard_normal(n); out = np.zeros(n)
    w = np.linspace(0, 1, n) if rise else np.linspace(1, 0, n)
    bands = np.geomspace(lo, hi, 7)
    for i, fc in enumerate(bands):
        g = np.clip(1 - abs(w - i / 6) * 6, 0, 1)
        out += filt(s, lo=fc * 0.6, hi=fc * 1.6) * g
    env = w ** 2.2 if rise else (1 - np.linspace(0, 1, n)) ** 2
    return out * env * gain


def bass(note, length, gain=1.0):
    n = int(length * SR); t = T(n); f = hz(note)
    s = sum(np.sin(2 * np.pi * f * k * t) / k for k in range(1, 8))
    env = np.minimum(1, t / 0.005) * np.exp(-t * 3.0) * np.minimum(1, (length - t) / 0.02)
    return filt(s * env, hi=520) * gain


def chord(notes, length, gain=1.0, attack=0.02, decay=1.2, hi=3000):
    n = int(length * SR); t = T(n); s = np.zeros((n, 2))
    for i, nt in enumerate(notes):
        for det, ch in ((-0.06, 0), (0.06, 1)):
            f = hz(nt) * 2 ** (det / 12)
            s[:, ch] += sum(np.sin(2 * np.pi * f * k * t + rng.random() * 6) / k ** 1.4 for k in range(1, 6))
    env = np.minimum(1, t / attack) * np.exp(-t * decay)
    return filt(s * env[:, None], hi=hi) * gain / len(notes)


def reverb(x, secs=2.2, wet=0.22):
    n = int(secs * SR); t = T(n)
    ir = rng.standard_normal((n, 2)) * np.exp(-t * 6.9 / secs)[:, None]
    ir = filt(ir, lo=250, hi=6000); ir[: int(0.015 * SR)] = 0
    ir /= np.sqrt((ir ** 2).sum(0))
    size = 1 << (x.shape[0] + n - 1).bit_length()
    w = np.fft.irfft(np.fft.rfft(x, size, axis=0) * np.fft.rfft(ir, size, axis=0), size, axis=0)[: x.shape[0]]
    return x + w * wet


music, sfx = Bus(), Bus()

# ---------- music ----------
# cold open: pulse only, then silence before the reveal
for b in range(11):
    at = b * BEAT
    if b % 2 == 0: music.add(kick(0.55, 0.3), at)
    music.add(hat(0.25), at + BEAT / 2, 1.0, 0.3)
for at in np.arange(1.5, 5.5, BEAT / 2):
    music.add(hat(0.18, 80), at, 1.0, -0.3)
music.add(bass("D2", 4.0, 0.5), 1.5)

# groove from the positioning line to the end card
prog = ["D2", "D2", "B1", "B1", "G1", "G1", "A1", "A1"]  # one bar (2 s) each, two bars per chord
roots = {"D2": ["D3", "Fs3", "A3", "E4"], "B1": ["B2", "D3", "Fs3", "A3"], "G1": ["G2", "B2", "D3", "Fs3"], "A1": ["A2", "Cs3", "E3", "B3"]}
duck = np.ones(N)
for b in np.arange(8.5, 24.0, BEAT):
    i = int((b - 8.5) / BEAT)
    if b >= 9.5 or i % 2 == 0:
        music.add(kick(0.9), b)
        k0 = int(b * SR); kn = min(N, k0 + int(0.32 * SR))
        duck[k0:kn] = np.minimum(duck[k0:kn], 1 - 0.55 * np.exp(-T(kn - k0) * 9))
    music.add(hat(0.32), b + BEAT / 2, 1.0, 0.25)
    if b >= 11.0: music.add(hat(0.12, 90), b + BEAT / 4, 1.0, -0.35); music.add(hat(0.12, 90), b + 3 * BEAT / 4, 1.0, -0.35)
    if b >= 11.0 and i % 2 == 1: music.add(clap(0.32), b, 1.0)
bassbus, padbus = Bus(), Bus()
for bar in range(8):
    start = 8.5 + bar * 2.0
    if start >= 24.0: break
    note = prog[bar % 8]
    for e in range(8):
        at = start + e * BEAT / 2
        if at >= 24.0: break
        bassbus.add(bass(note if e % 4 != 3 else note[:-1] + str(int(note[-1]) + 1), BEAT / 2 * 0.9, 0.55 if e % 2 == 0 else 0.4), at)
    if bar % 2 == 0:
        padbus.add(chord(roots[note], 4.2, 0.22, attack=0.4, decay=0.35, hi=2200), start)
music.x += (bassbus.x + padbus.x) * duck[:, None]

# reveal and end card chords
music.add(chord(["D3", "A3", "Fs4", "E5"], 2.2, 0.32, attack=0.01, decay=1.4, hi=5000), 7.5)
music.add(chord(["D3", "A3", "Fs4", "A4", "E5"], 4.0, 0.36, attack=0.01, decay=0.9, hi=5000), 24.0)
music.add(bass("D2", 3.5, 0.6), 24.0)

# ---------- sound design ----------
sfx.add(tick(2400, 0.5), 0.06); sfx.add(tick(2800, 0.5), 0.75)
sfx.add(whoosh(0.35, True, 400, 6000, 0.25), 1.18)
sfx.add(tick(2000, 0.5), 1.62, pan=-0.5); sfx.add(tick(2200, 0.5), 1.82, pan=-0.5)
sfx.add(impact(0.85, 1.6, 52), 2.75)                          # one overwrote the other
for i, at in enumerate((4.0, 4.5, 5.0)): sfx.add(impact(0.45 + i * 0.1, 0.5, 60 + i * 8), at)
sfx.add(whoosh(1.0, True, 300, 8000, 0.22), 5.85)              # strokes draw
sfx.add(tick(3200, 0.6), 6.3)
sfx.add(whoosh(0.5, True, 150, 9000, 0.6), 7.0)                # core floods the frame
sfx.add(impact(1.0, 2.4, 44), 7.5)
sfx.add(impact(0.5, 0.8, 56), 8.5)                             # hard cut back to navy
sfx.add(whoosh(0.3, False, 300, 6000, 0.25), 10.6)
for el_t, pan in [(11.30, -.5), (11.62, -.5), (11.95, -.5), (12.27, -.5), (12.70, .5), (13.85, .5), (15.55, -.5), (15.85, -.5), (16.30, .5), (16.60, .5)]:
    sfx.add(tick(2600, 0.35), el_t, pan=pan)
sfx.add(whoosh(0.4, True, 250, 6000, 0.3), 12.45)              # camera push
sfx.add(impact(0.55, 0.9, 40), 13.0, pan=0.3)                  # blocked
sfx.add(whoosh(0.4, False, 250, 6000, 0.3), 14.2)              # pull back
sfx.add(whoosh(0.52, True, 500, 9000, 0.35), 14.6, pan=-0.2)   # message in flight
sfx.add(tick(1800, 0.8), 15.12, pan=-0.5); sfx.add(tick(3600, 0.4), 15.14, pan=-0.5)
for at in (17.5, 18.5, 19.5): sfx.add(impact(0.4, 0.5, 64), at)
sfx.add(whoosh(1.3, False, 200, 7000, 0.35), 20.5)             # dashboard pull out
sfx.add(whoosh(0.4, True, 200, 9000, 0.3), 23.6)
sfx.add(impact(1.0, 3.0, 42), 24.0)
sfx.add(tick(3000, 0.5), 25.0)


def master(x, target_peak=0.89):
    x = filt(x, lo=25)
    fade = np.ones(N); fn = int(1.2 * SR); fade[-fn:] = np.cos(np.linspace(0, np.pi / 2, fn)) ** 2
    x = x * fade[:, None]
    x = np.tanh(x / np.abs(x).max() * 1.6) / np.tanh(1.6)
    return x * target_peak


def write(path, x):
    with wave.open(path, "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((x * 32767).astype("<i2").tobytes())


os.makedirs("out", exist_ok=True)
full = reverb(music.x * 0.8 + sfx.x)
write("out/score.wav", master(full))
write("out/sfx.wav", master(reverb(sfx.x)))
print("done")

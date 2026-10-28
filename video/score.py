"""Score and sound design for the film, synthesized with numpy and synced to timeline.js.
Writes out/score.wav (48 kHz stereo)."""
import numpy as np, wave, os

SR = 48000
DUR = 49.0
N = int(SR * DUR)
rng = np.random.default_rng(4)
mix = np.zeros((N, 2))


def t_axis(n):
    return np.arange(n) / SR


def lowpass(x, fc, order=2):
    X = np.fft.rfft(x, axis=0)
    f = np.fft.rfftfreq(x.shape[0], 1 / SR)
    h = 1 / np.sqrt(1 + (f / fc) ** (2 * order))
    return np.fft.irfft(X * (h[:, None] if x.ndim == 2 else h), n=x.shape[0], axis=0)


def highpass(x, fc, order=2):
    X = np.fft.rfft(x, axis=0)
    f = np.fft.rfftfreq(x.shape[0], 1 / SR)
    h = 1 / np.sqrt(1 + (fc / np.maximum(f, 1e-3)) ** (2 * order))
    return np.fft.irfft(X * (h[:, None] if x.ndim == 2 else h), n=x.shape[0], axis=0)


def add(sig, at, gain=1.0, pan=0.0):
    i = int(at * SR)
    if sig.ndim == 1:
        l, r = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
        sig = np.stack([sig * l, sig * r], 1) * np.sqrt(2)
    j = min(N, i + len(sig))
    mix[i:j] += sig[: j - i] * gain


def hz(note):
    names = {"C": -9, "C#": -8, "D": -7, "D#": -6, "E": -5, "F": -4, "F#": -3, "G": -2, "G#": -1, "A": 0, "A#": 1, "B": 2}
    n, o = note[:-1], int(note[-1])
    return 440 * 2 ** ((names[n] + (o - 4) * 12) / 12)


def envelope(n, a, r):
    e = np.ones(n)
    na, nr = int(a * SR), int(r * SR)
    e[:na] = np.sin(np.linspace(0, np.pi / 2, na)) ** 2
    e[n - nr:] *= np.cos(np.linspace(0, np.pi / 2, nr)) ** 2
    return e


# ---------- pad: soft, detuned, band-limited ----------
def pad_voice(f, dur, bright=1.0):
    n = int(dur * SR); t = t_axis(n); s = np.zeros(n)
    for det in (-0.07, 0.0, 0.06):
        ff = f * 2 ** (det / 12)
        ph = rng.random() * 2 * np.pi
        for k in range(1, 10):
            s += np.sin(2 * np.pi * ff * k * t + ph * k) / k ** (1.6 / bright)
    s *= 1 + 0.08 * np.sin(2 * np.pi * 0.17 * t + rng.random() * 6)
    return s


def chord(notes, start, dur, gain, a=1.6, r=2.2, cutoff=1400, bright=1.0, tail=1.6):
    dur += tail  # let each chord ring under the next one
    n = int(dur * SR); st = np.zeros((n, 2))
    for i, nt in enumerate(notes):
        v = pad_voice(hz(nt), dur, bright)
        pan = (i / max(1, len(notes) - 1) - 0.5) * 0.7
        st[:, 0] += v * np.cos((pan + 1) * np.pi / 4); st[:, 1] += v * np.sin((pan + 1) * np.pi / 4)
    st = lowpass(st, cutoff, 2) * envelope(n, a, r)[:, None]
    add(st / len(notes), start, gain)


# progression in D: open, tension at the collision, release at the reveal
chord(["D2", "A2", "E3", "A3"], 0.0, 8.6, 0.16, a=2.5, cutoff=900)
chord(["B1", "F#2", "D3", "C#4"], 7.8, 7.0, 0.16, a=1.4, cutoff=1000)
chord(["G2", "D3", "F#3", "B3", "E4"], 14.3, 5.6, 0.15, a=0.4, cutoff=1800, bright=1.2)
chord(["D2", "A2", "F#3", "C#4", "E4"], 19.0, 6.4, 0.14, cutoff=1500)
chord(["B1", "F#2", "D3", "A3", "E4"], 25.1, 6.4, 0.14, cutoff=1500)
chord(["G2", "D3", "B3", "F#4"], 31.2, 6.3, 0.14, cutoff=1700)
chord(["A2", "E3", "C#4", "E4"], 37.3, 6.2, 0.14, cutoff=1700)
chord(["D2", "A2", "F#3", "A3", "E4", "A4"], 43.2, 5.8, 0.17, a=0.6, r=3.2, cutoff=2200, bright=1.2, tail=0)


# ---------- pulse: muted plucks under the product sections ----------
def pluck(f, dur=0.5, decay=7.0):
    n = int(dur * SR); t = t_axis(n)
    s = np.sin(2 * np.pi * f * t) + 0.35 * np.sin(2 * np.pi * 2 * f * t) + 0.1 * np.sin(2 * np.pi * 3 * f * t)
    return s * np.exp(-decay * t) * envelope(n, 0.003, 0.05)


arps = [(19.6, 25.1, ["D4", "A4", "F#4", "E4"]), (25.1, 31.0, ["B3", "F#4", "D4", "E4"]),
        (31.4, 37.3, ["G3", "D4", "B3", "F#4"]), (37.3, 42.9, ["A3", "E4", "C#4", "E4"])]
step = 60 / 112 / 2  # eighths at 112 bpm
for a, b, ns in arps:
    k = 0; tt = a
    while tt < b:
        fade = min(1, (tt - 19.6) / 2.5) * min(1, (b - tt) / 0.8 + 0.5)
        add(pluck(hz(ns[k % 4])), tt, 0.055 * fade * (1.0 if k % 2 == 0 else 0.7), pan=0.25 if k % 2 else -0.25)
        k += 1; tt += step


# ---------- sound design ----------
def tick(gain=1.0, f=2600):
    n = int(0.06 * SR); t = t_axis(n)
    s = np.sin(2 * np.pi * f * t) * np.exp(-70 * t) + 0.4 * rng.standard_normal(n) * np.exp(-400 * t)
    return highpass(s, 900) * gain


def swell(dur, f_lo=300, f_hi=4000, rise=True):
    n = int(dur * SR)
    s = rng.standard_normal(n)
    # crude sweep: crossfade a few band-limited copies
    out = np.zeros(n); bands = np.geomspace(f_lo, f_hi, 6)
    w = np.linspace(0, 1, n) if rise else np.linspace(1, 0, n)
    for i, fc in enumerate(bands):
        c = i / (len(bands) - 1)
        g = np.clip(1 - abs(w - c) * (len(bands) - 1), 0, 1)
        out += lowpass(s, fc, 2) * g
    e = (w ** 2) if rise else (1 - np.linspace(0, 1, n)) ** 2
    return out * e


def boom(f0=70, f1=38, dur=1.6, gain=1.0):
    n = int(dur * SR); t = t_axis(n)
    f = f1 + (f0 - f1) * np.exp(-6 * t)
    ph = 2 * np.pi * np.cumsum(f) / SR
    return np.sin(ph) * np.exp(-2.6 * t) * envelope(n, 0.004, 0.3) * gain


def shimmer(notes, dur=3.0, gain=1.0):
    n = int(dur * SR); t = t_axis(n); s = np.zeros(n)
    for nt in notes:
        f = hz(nt)
        s += (np.sin(2 * np.pi * f * t) + 0.2 * np.sin(2 * np.pi * 2.01 * f * t)) * np.exp(-1.8 * t)
    return s * envelope(n, 0.01, 0.6) * gain / len(notes)


# logo: hexagon strokes draw in, the core lands
add(swell(1.6, 400, 5000), 0.2, 0.05)
add(boom(80, 42, 2.0), 1.5, 0.30)
add(shimmer(["A4", "E5", "F#5"], 3.0), 1.5, 0.12)
add(tick(0.6, 1800), 2.45, 0.6)
# problem lines
add(tick(0.4, 2200), 4.45, 0.5, -0.2); add(tick(0.4, 2000), 5.35, 0.5, 0.2)
# collision: cards slide in, connectors travel, conflict lands
add(tick(0.55, 2400), 8.25, 0.6, -0.5); add(tick(0.55, 2600), 8.4, 0.6, 0.5); add(tick(0.45, 2000), 8.65, 0.6)
add(swell(1.2, 300, 2500), 9.4, 0.035)
cl = boom(62, 34, 1.4, 1.0) + 0.25 * lowpass(rng.standard_normal(int(1.4 * SR)) * np.exp(-9 * t_axis(int(1.4 * SR))), 1800)
add(cl, 10.6, 0.34)
add(shimmer(["C4", "C#4", "G4"], 1.6), 10.6, 0.06)
for i in range(3):
    add(tick(0.35, 1700), 11.2 + i * 0.25, 0.55, (i - 1) * 0.4)
# reveal
add(swell(1.6, 200, 6000), 12.95, 0.06)
add(boom(90, 40, 2.4), 14.55, 0.32)
add(shimmer(["D5", "A5", "F#5", "E6"], 3.6), 14.55, 0.10)
# demo steps, matching demoSteps in timeline.js
for at, pan in [(20.6, -0.45), (21.7, -0.45), (22.9, 0.45), (25.3, 0.45), (26.6, -0.45), (27.9, -0.45), (29.0, 0.45)]:
    add(tick(0.5, 2500), at, 0.6, pan)
add(boom(55, 38, 0.6, 0.6), 23.9, 0.28, 0.45)  # blocked edit
add(tick(0.5, 1300), 23.9, 0.6, 0.45)
# features, dashboard, end
for i in range(3):
    add(tick(0.45, 2300 + i * 200), 31.6 + i * 0.28, 0.55, (i - 1) * 0.5)
add(swell(1.2, 300, 3000), 37.0, 0.035)
add(boom(70, 40, 1.4), 38.0, 0.18)
add(swell(1.4, 200, 6000), 41.9, 0.05)
add(boom(85, 38, 2.6), 43.35, 0.30)
add(shimmer(["D5", "A5", "E6", "F#6"], 4.5), 43.35, 0.10)


# ---------- space and master ----------
def reverb(x, secs=2.8, mixamt=0.28):
    n = int(secs * SR); t = t_axis(n)
    ir = rng.standard_normal((n, 2)) * np.exp(-3.2 * t / secs * 3)[:, None]
    ir = lowpass(ir, 5000); ir[: int(0.012 * SR)] = 0
    ir /= np.sqrt((ir ** 2).sum(0))
    L = x.shape[0] + n
    size = 1 << (L - 1).bit_length()
    wet = np.fft.irfft(np.fft.rfft(x, size, axis=0) * np.fft.rfft(ir, size, axis=0), size, axis=0)[: x.shape[0]]
    return x * (1 - mixamt) + wet * mixamt * 2.2


mix = reverb(highpass(mix, 28))
mix *= envelope(N, 0.05, 0.9)[:, None]
peak = np.abs(mix).max()
mix = np.tanh(mix / peak * 1.25) / np.tanh(1.25) * 0.79  # gentle soft clip, about -2 dBFS peak

os.makedirs("out", exist_ok=True)
with wave.open("out/score.wav", "wb") as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes((mix * 32767).astype("<i2").tobytes())
print("rms dBFS", 20 * np.log10(np.sqrt((mix ** 2).mean())))

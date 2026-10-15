"""Soundtrack for the 15 s Twitter cut (Twitter.tsx), synthesized so it is ours to publish.

120 BPM, so one beat = 0.5 s = 15 frames at 30 fps; every cut in the video sits on this grid.
    python3 beat.py public/music/beat.wav
"""
import sys
import wave

import numpy as np

SR = 48000
BPM = 120
BEAT = 60 / BPM
DUR = 15.0
N = int(SR * DUR)
L = np.zeros(N)
R = np.zeros(N)
rng = np.random.default_rng(11)
b = lambda x: x * BEAT  # beats -> seconds


def add(sig, at, gain=1.0, pan=0.0):
    i = int(at * SR)
    if i >= N or i < 0:
        return
    sig = sig[: N - i] * gain
    L[i:i + len(sig)] += sig * (1 - max(pan, 0))
    R[i:i + len(sig)] += sig * (1 + min(pan, 0))


def env(n, a=0.002, d=0.2):
    t = np.arange(n) / SR
    return np.minimum(t / a, 1) * np.exp(-t / d)


def lowpass(x, cut):
    """one-pole low-pass; cut may be a scalar or an array (for sweeps)"""
    cut = np.broadcast_to(np.asarray(cut, dtype=float), x.shape)
    a = 1 - np.exp(-2 * np.pi * cut / SR)
    y = np.empty_like(x)
    acc = 0.0
    for i in range(len(x)):
        acc += a[i] * (x[i] - acc)
        y[i] = acc
    return y


def kick(gain=1.0):
    n = int(SR * 0.45)
    t = np.arange(n) / SR
    f = 42 + 140 * np.exp(-t * 38)
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * env(n, 0.0005, 0.2)
    click = rng.standard_normal(n) * env(n, 0.0002, 0.003) * 0.4
    return np.tanh(2.2 * (body + click)) * gain


def clap():
    n = int(SR * 0.35)
    s = rng.standard_normal(n)
    s = s - lowpass(s, 900)  # high-pass
    e = sum(env(n, 0.0005, 0.012) * (np.arange(n) >= int(SR * k * 0.011)) for k in range(3)) + env(n, 0.001, 0.09)
    return s * e * 0.5


def hat(open_=False):
    n = int(SR * (0.25 if open_ else 0.06))
    s = rng.standard_normal(n)
    s = s - lowpass(s, 7000)
    return s * env(n, 0.0005, 0.08 if open_ else 0.014) * 0.35


def saw(freq, dur):
    n = int(SR * dur)
    t = np.arange(n) / SR
    ph = (freq * t) % 1
    ph2 = (freq * 1.006 * t) % 1
    return (2 * ph - 1) * 0.5 + (2 * ph2 - 1) * 0.5


def bass(freq, dur):
    s = saw(freq, dur) + np.sin(2 * np.pi * freq / 2 * np.arange(int(SR * dur)) / SR) * 0.8
    return lowpass(s, 420) * env(len(s), 0.003, dur * 0.55)


def pluck(freq, dur=0.35, bright=2500):
    s = saw(freq, dur)
    n = len(s)
    return lowpass(s, bright * np.exp(-np.arange(n) / SR / 0.08) + 200) * env(n, 0.001, 0.12)


def pad(freqs, dur, attack=0.6, release=1.2, cut=1400):
    n = int(SR * dur)
    t = np.arange(n) / SR
    s = sum(saw(f, dur) for f in freqs) / len(freqs)
    s = lowpass(s, cut)
    return s * np.minimum(t / attack, 1) * np.clip((dur - t) / release, 0, 1)


def riser(dur, f0=300, f1=6000):
    n = int(SR * dur)
    t = np.arange(n) / SR
    s = rng.standard_normal(n)
    s = lowpass(s, f0 * (f1 / f0) ** (t / dur))
    tone = np.sin(2 * np.pi * np.cumsum(200 * 4 ** (t / dur)) / SR) * 0.25
    return (s * 0.8 + tone) * (t / dur) ** 2


def impact(dur=3.0):
    n = int(SR * dur)
    t = np.arange(n) / SR
    f = 30 + 90 * np.exp(-t * 9)
    sub = np.tanh(2.5 * np.sin(2 * np.pi * np.cumsum(f) / SR)) * env(n, 0.001, 0.9)
    nz = lowpass(rng.standard_normal(n), 3000) * env(n, 0.001, 0.35) * 0.6
    return sub + nz


def thud():
    n = int(SR * 0.6)
    t = np.arange(n) / SR
    f = 38 + 70 * np.exp(-t * 20)
    s = np.sin(2 * np.pi * np.cumsum(f) / SR) * env(n, 0.001, 0.22)
    h = hat()
    s[: len(h)] += h * 0.6
    return s


def reverb(x, secs=1.6, wet=0.25):
    n = int(SR * secs)
    ir = rng.standard_normal(n) * np.exp(-np.arange(n) / SR / (secs / 5))
    ir = lowpass(ir, 5000)
    y = np.convolve(x, ir)[: len(x)]
    return x + wet * y / (np.abs(y).max() + 1e-9) * np.abs(x).max()


# A minor: A1 55, C2 65.4, E2 82.4, F2 87.3, G2 98
A1, C2, E2, F2, G2 = 55, 65.41, 82.41, 87.31, 98.0
ARP = [440, 523.25, 659.25, 880, 659.25, 523.25, 987.77, 880]
CHORDS = [(A1, [220, 261.63, 329.63]), (F2, [174.61, 220, 261.63]), (C2, [196, 261.63, 329.63]), (G2, [196, 246.94, 293.66])]

# ---- 0-4 beats (0-2 s): hook. ticking 16ths, a thud on each text slam, a riser into the drop
for i in range(16):
    add(hat(), b(i / 4), 0.5 if i % 4 else 0.8, pan=0.3 if i % 2 else -0.3)
for k in range(4):
    add(thud(), b(k), 0.9)
add(pluck(ARP[0] / 2, 0.6, 1200), b(0), 0.25)
add(riser(b(2)), b(2), 0.5)

# ---- 4-16 beats (2-8 s): the drop. four on the floor, pumping bass, arp, plucks on each link
add(impact(2.0), b(4), 0.9)
pump = np.ones(N)
for k in range(4, 16):
    add(kick(), b(k), 1.0)
    i = int(b(k) * SR)
    m = min(N - i, int(SR * 0.22))
    pump[i:i + m] *= 0.25 + 0.75 * (np.arange(m) / m) ** 0.6
    if k % 2:
        add(clap(), b(k), 0.8)
    add(hat(open_=True), b(k + 0.5), 0.6, pan=0.2)
    for q in (0.25, 0.75):
        add(hat(), b(k + q), 0.45, pan=-0.25)
bassline = np.zeros(N)
for k in range(4, 16):
    root = CHORDS[((k - 4) // 4) % 4][0]
    for off in (0.5,):
        sig = bass(root, b(0.45))
        i = int(b(k + off) * SR)
        bassline[i:i + len(sig)] += sig[: N - i]
for j in range(48):  # 16th arp over the groove
    at = b(4 + j / 4)
    add(pluck(ARP[j % len(ARP)], 0.25, 3200 if j % 4 == 0 else 1800), at, 0.16, pan=np.sin(j * 0.7) * 0.5)
for k, at in enumerate([6, 7, 8, 9]):  # the four links drawing
    add(pluck(880 * [1, 1.189, 1.335, 1.498][k], 0.6, 5000), b(at), 0.35)
add(pad(CHORDS[0][1], b(12), 0.4, 1.0), b(4), 0.18)

# ---- 16-20 beats (8-10 s): build. kick drops out at 18, snare roll accelerates, big riser
for k in range(16, 18):
    add(kick(), b(k), 0.9)
roll = [16 + i / 2 for i in range(4)] + [18 + i / 4 for i in range(4)] + [19 + i / 8 for i in range(8)]
for i, at in enumerate(roll):
    add(clap(), b(at), 0.25 + 0.6 * i / len(roll))
add(riser(b(4), 200, 9000), b(16), 0.7)

# ---- 20-30 beats (10-15 s): the title. impact, wide chord, half-time kick, last hit on 25
add(impact(4.0), b(20), 1.2)
add(pad([110, 220, 261.63, 329.63, 440], b(10), 0.05, 2.5, 2200), b(20), 0.3)
for k in (22, 24, 26, 28):
    add(kick(0.8), b(k), 0.8)
for k in (23, 27):
    add(clap(), b(k), 0.5)
for j in range(16):
    add(pluck(ARP[(j * 3) % len(ARP)] * 2, 0.3, 2400), b(21 + j / 2), 0.07, pan=np.sin(j) * 0.6)
add(impact(2.5), b(25), 0.55)
add(pluck(440, 2.5, 3000), b(25), 0.3)
add(pluck(659.25, 2.5, 3000), b(25), 0.2)

# ---- master
L = reverb(L * pump, 1.4, 0.18) + bassline * pump * 0.9
R = reverb(R * pump, 1.6, 0.18) + bassline * pump * 0.9
mix = np.stack([L, R], axis=1)
mix = np.tanh(mix * 1.3)
mix /= np.abs(mix).max() + 1e-9
mix *= 0.89
fade = int(0.8 * SR)
mix[-fade:] *= np.linspace(1, 0, fade)[:, None] ** 1.5

out = sys.argv[1] if len(sys.argv) > 1 else "public/music/beat.wav"
with wave.open(out, "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes((mix * 32767).astype(np.int16).tobytes())
print(out)

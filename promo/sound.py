"""Synthesize the promo soundtrack, beat-synced to the Remotion timeline (30 fps).

python3 sound.py out/sound.wav
"""
import sys
import wave

import numpy as np

SR = 48000
FPS = 30
DUR = 15.5
N = int(SR * DUR)
L = np.zeros(N)
R = np.zeros(N)
rng = np.random.default_rng(7)


def t_of(frame):
    return frame / FPS


def add(sig, at, gain=1.0, pan=0.0):
    i = int(at * SR)
    if i >= N:
        return
    sig = sig[: N - i] * gain
    L[i:i + len(sig)] += sig * (1 - max(pan, 0))
    R[i:i + len(sig)] += sig * (1 + min(pan, 0))


def env(n, a=0.005, d=0.2):
    t = np.arange(n) / SR
    return np.minimum(t / a, 1) * np.exp(-t / d)


def pluck(freq, dur=0.5, d=0.12):
    n = int(SR * dur)
    t = np.arange(n) / SR
    s = np.sin(2 * np.pi * freq * t) + 0.35 * np.sin(2 * np.pi * freq * 2 * t) + 0.12 * np.sin(2 * np.pi * freq * 3 * t)
    return s * env(n, 0.002, d)


def tick(dur=0.05):
    n = int(SR * dur)
    s = rng.standard_normal(n)
    s = np.diff(s, prepend=0)  # crude high-pass
    return s * env(n, 0.0005, 0.008)


def boom(f0=70, f1=32, dur=1.6):
    n = int(SR * dur)
    t = np.arange(n) / SR
    f = f1 + (f0 - f1) * np.exp(-t * 6)
    ph = 2 * np.pi * np.cumsum(f) / SR
    return np.tanh(1.8 * np.sin(ph)) * env(n, 0.002, 0.45)


def kick(dur=0.5):
    n = int(SR * dur)
    t = np.arange(n) / SR
    f = 45 + 110 * np.exp(-t * 30)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * env(n, 0.001, 0.16)


def noise_burst(dur=0.9, d=0.25, lp=0.15):
    n = int(SR * dur)
    s = rng.standard_normal(n)
    out = np.zeros(n)
    acc = 0.0
    for i in range(n):  # one-pole low-pass
        acc += lp * (s[i] - acc)
        out[i] = acc
    return out / (np.abs(out).max() + 1e-9) * env(n, 0.002, d)


def riser(dur, f0=200, f1=1800):
    n = int(SR * dur)
    t = np.arange(n) / SR
    f = f0 * (f1 / f0) ** (t / dur)
    s = np.sin(2 * np.pi * np.cumsum(f) / SR) * 0.4
    nz = rng.standard_normal(n) * np.linspace(0, 1, n) ** 2 * 0.5
    return (s + nz) * np.linspace(0, 1, n) ** 1.5


def pad(freqs, dur, attack=1.5, release=1.0, wobble=0.15):
    n = int(SR * dur)
    t = np.arange(n) / SR
    s = sum(np.sin(2 * np.pi * f * t + i) + 0.3 * np.sin(2 * np.pi * f * 1.003 * t) for i, f in enumerate(freqs))
    s *= 1 + wobble * np.sin(2 * np.pi * 0.25 * t)
    shape = np.minimum(t / attack, 1) * np.minimum((dur - t) / release, 1)
    return s / len(freqs) * shape


# A minor-ish palette
A2, C3, E3, G3, A3, C4, E4, G4, A4, C5, E5 = 110, 130.81, 164.81, 196, 220, 261.63, 329.63, 392, 440, 523.25, 659.25
SCALE = [A3, C4, E4, G4, A4, C5, E5, G4 * 2, A4 * 2]

# --- scene 1-4: the mesh (frames 0-300)
add(pad([A2, E3, A3], 9.9, attack=2.5, release=0.6), 0.0, 0.22)
add(pluck(A4, 1.2, 0.35), t_of(4), 0.5)  # first node
for i, f in enumerate(range(52, 93, 4)):  # agents multiply
    add(pluck(SCALE[i % len(SCALE)], 0.5, 0.12), t_of(f), 0.32, pan=(-0.6 if i % 2 else 0.6))
for i, f in enumerate([118, 122, 126, 130, 134, 138, 142, 146, 150, 154, 158, 162, 166]):  # links draw
    add(tick(), t_of(f), 0.35, pan=np.sin(i))
    add(pluck(SCALE[(i * 2) % len(SCALE)] * 2, 0.25, 0.05), t_of(f + 2), 0.12)
add(pad([C3, G3, E4], 5.5, attack=1.0, release=1.2, wobble=0.25), t_of(118), 0.12)  # "shared brain" lift
for i, f in enumerate(range(206, 226, 3)):  # friend's cluster
    add(pluck(SCALE[(i + 3) % len(SCALE)] * 1.5, 0.45, 0.1), t_of(f), 0.28, pan=0.7)
for f in range(226, 245, 3):
    add(tick(), t_of(f), 0.25, pan=0.6)
add(riser(t_of(268 - 240), 180, 2200), t_of(240), 0.35)  # bridge drag
add(boom(), t_of(268), 0.9)  # bridge lands
add(noise_burst(0.8, 0.18, 0.3), t_of(268), 0.35)
add(noise_burst(1.4, 0.5, 0.05), t_of(272), 0.4)  # shockwave whoosh

# --- finale (frames 300-465)
F0 = 300
for i in range(11):  # letters drop
    add(tick(0.04), t_of(F0 + 4 + i * 2 + 6), 0.4, pan=(i - 5) / 6)
LAND = F0 + 32
add(boom(90, 35, 2.2), t_of(LAND), 1.0)
add(noise_burst(1.0, 0.3, 0.25), t_of(LAND), 0.3)
add(pad([A2, E3, A3, C4, E4], DUR - t_of(LAND), attack=0.05, release=1.5, wobble=0.3), t_of(LAND), 0.3)
for k in range(1, 3):  # pulse rings every 60 frames
    add(kick(), t_of(LAND + 60 * k), 0.75)
for i in range(11):  # "coming soon" typing
    add(tick(0.03), t_of(F0 + 44 + i * 2.2), 0.3)
    add(pluck(SCALE[i % 5 + 2] * 2, 0.15, 0.03), t_of(F0 + 44 + i * 2.2), 0.06)
add(pluck(A4, 2.0, 0.6), t_of(F0 + 80), 0.3)  # logo
add(pluck(E5, 2.0, 0.6), t_of(F0 + 80), 0.18)

# --- master: soft clip, normalize, fade out
mix = np.stack([L, R], axis=1)
mix = np.tanh(mix * 1.2)
mix /= np.abs(mix).max() + 1e-9
mix *= 0.79
fade = int(0.45 * SR)
mix[-fade:] *= np.linspace(1, 0, fade)[:, None]

with wave.open(sys.argv[1] if len(sys.argv) > 1 else "out/sound.wav", "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes((mix * 32767).astype(np.int16).tobytes())
print("ok")

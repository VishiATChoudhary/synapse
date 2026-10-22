// Short synthesized cues, after bencho.dev/sounds: an agent is done (bubbleTap or perk, picked in Settings) and
// something went wrong (purr). Each tone is one oscillator: pitch in hz (gliding to `to`), length in ms, peak gain,
// attack in ms, an optional lowpass `cut`, and `at` ms after the start.
export const SOUNDS = {
  bubbleTap: [
    { hz: 480, to: 300, glide: 18, ms: 23, gain: 0.064, atk: 1 },
    { hz: 600, to: 900, glide: 40, ms: 61, gain: 0.015, atk: 12 },
    { hz: 960, to: 600, glide: 18, ms: 18, gain: 0.016, atk: 1 },
  ],
  perk: [{ hz: 330, ms: 360, gain: 0.053, wave: 'sine', cut: 560, atk: 90 }],
  purr: [{ hz: 92, ms: 350, gain: 0.046, wave: 'triangle', cut: 1100, atk: 32 }],
};
export const DONE_SOUNDS = { bubbleTap: 'Bubble tap', perk: 'Perk', off: 'None' };

let ctx = null, last = 0;
// louder than the page they come from: a cue in a busy room, not a click under your finger
export function playSound(name, { gain = 2.5 } = {}) {
  const tones = SOUNDS[name];
  if (!tones || Date.now() - last < 120) return false;
  last = Date.now();
  try {
    ctx ||= new AudioContext();
    if (ctx.state === 'suspended') ctx.resume();
    const start = ctx.currentTime + 0.01;
    for (const t of tones) {
      const t0 = start + (t.at || 0) / 1000, t1 = t0 + t.ms / 1000, glideEnd = t.glide ? t0 + t.glide / 1000 : t1;
      const osc = ctx.createOscillator();
      osc.type = t.wave || 'sine';
      osc.frequency.setValueAtTime(t.hz, t0);
      if (t.to) osc.frequency.exponentialRampToValueAtTime(t.to, glideEnd);
      const env = ctx.createGain(), attack = Math.min((t.atk ?? 4) / 1000, (t.ms / 1000) * 0.6);
      env.gain.setValueAtTime(1e-4, t0);
      env.gain.exponentialRampToValueAtTime((t.gain ?? 0.05) * gain, t0 + attack);
      env.gain.exponentialRampToValueAtTime(1e-4, t1);
      let out = osc;
      if (t.cut) { const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = t.cut; osc.connect(lp); out = lp; }
      out.connect(env).connect(ctx.destination);
      osc.start(t0); osc.stop(t1 + 0.02);
    }
    return true;
  } catch { return false; }
}

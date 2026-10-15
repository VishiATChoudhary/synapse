import React from "react";
import { AbsoluteFill, Sequence, interpolate, staticFile, useCurrentFrame } from "remotion";
import { Audio, Video } from "@remotion/media";
import { Canvas, End, Flash, Grain, Hud, Slam, useFonts } from "./Twitter";

// "Intelligence is collaborative": 15 s square meme-edit for the feed.
// Soundtrack and B-roll come from broll.sh (git-ignored). The beat is 90 BPM, so one beat = 20 frames,
// and the music starts 21.03 s in so its drop lands on frame 90, the first cut after Selfridge's line.
const S = 1080;
const BEAT = 20;
const DROP = 90;
const b = (n: number) => DROP + n * BEAT; // frame of beat n after the drop
export const COLLAB_FRAMES = 450;

const BG = "#0B0B0B";
const INK = "#EDEDEA";
const SIG = "#FF5A1F";
const MONO = "'Fragment Mono', ui-monospace, monospace";
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

const Clip: React.FC<{ name: string; trim?: number; muted?: boolean; volume?: number; zoom?: [number, number] }> = ({ name, trim = 0, muted = true, volume = 1, zoom = [1, 1.06] }) => {
  const f = useCurrentFrame();
  const k = interpolate(f, [0, 60], zoom, clamp);
  return (
    <AbsoluteFill style={{ background: "#000", overflow: "hidden" }}>
      <Video src={staticFile(`broll/cuts/${name}.mp4`)} trimBefore={trim} muted={muted} volume={volume} style={{ width: S, height: S, transform: `scale(${k})` }} />
    </AbsoluteFill>
  );
};

// TV-style subtitle, words appear as they are spoken (times in frames from the clip start)
const Sub: React.FC<{ words: [string, number][] }> = ({ words }) => {
  const f = useCurrentFrame();
  const shown = words.filter(([, t]) => f >= t);
  if (!shown.length) return null;
  return (
    <div style={{ position: "absolute", left: 70, right: 70, bottom: 92, textAlign: "center" }}>
      <span style={{ background: "rgba(0,0,0,.82)", color: INK, font: `400 36px/1.55 ${MONO}`, padding: "4px 14px", boxDecorationBreak: "clone", WebkitBoxDecorationBreak: "clone" }}>
        {shown.map(([w]) => w).join(" ")}
      </span>
    </div>
  );
};

const LowerThird: React.FC<{ text: string }> = ({ text }) => {
  const f = useCurrentFrame();
  const o = interpolate(f, [4, 12], [0, 1], clamp);
  return (
    <div style={{ position: "absolute", left: 52, top: 104, opacity: o, font: `400 17px ${MONO}`, letterSpacing: "0.14em", color: INK, textTransform: "uppercase", display: "flex", gap: 10, alignItems: "center" }}>
      <span style={{ width: 10, height: 10, background: SIG, display: "inline-block" }} />
      {text}
    </div>
  );
};

// a mono tag in the corner of a shot, like a lab label on archive film
const Tag: React.FC<{ text: string; color?: string }> = ({ text, color = INK }) => (
  <div style={{ position: "absolute", left: 52, bottom: 50, font: `400 17px ${MONO}`, letterSpacing: "0.14em", color, textTransform: "uppercase", background: "rgba(0,0,0,.7)", padding: "6px 10px" }}>{text}</div>
);

// the card's own text stays; ours sits under it as a translation
const Translate: React.FC<{ text: string }> = ({ text }) => {
  const f = useCurrentFrame();
  const o = interpolate(f, [8, 12], [0, 1], clamp);
  return (
    <div style={{ position: "absolute", left: 0, right: 0, bottom: 150, textAlign: "center", opacity: o }}>
      <span style={{ background: BG, color: INK, font: `400 30px ${MONO}`, letterSpacing: "0.1em", padding: "10px 18px", textTransform: "uppercase" }}>{text}</span>
    </div>
  );
};

// darkens the top of busy footage so the headline reads
const Shade: React.FC = () => <AbsoluteFill style={{ background: "linear-gradient(180deg, rgba(0,0,0,.75) 0%, rgba(0,0,0,.35) 30%, rgba(0,0,0,0) 50%)" }} />;

const Seg: React.FC<{ from: number; to: number; children: React.ReactNode }> = ({ from, to, children }) => (
  <Sequence from={from} durationInFrames={to - from} layout="none">{children}</Sequence>
);

// music sits under the voices: full on the drop, ducked while a clip speaks
const musicVolume = (f: number) => {
  const duck = (a: number, z: number, v: number) => (f >= a && f < z ? v : 1);
  const base = interpolate(f, [0, 6, COLLAB_FRAMES - 24, COLLAB_FRAMES], [0, 0.55, 0.9, 0], clamp);
  const lift = f >= DROP ? 0.9 / 0.55 : 1;
  return Math.min(1, base * lift) * duck(b(7), b(9.5), 0.3) * duck(b(9.5), b(12), 0.22) * duck(b(12), b(13), 0.3);
};

export const Collab: React.FC = () => {
  useFonts();
  return (
    <AbsoluteFill style={{ background: BG, overflow: "hidden" }}>
      <Audio src={staticFile("music/soundtrack.mp3")} trimBefore={Math.round(24.03 * 30) - DROP} volume={musicVolume} />

      {/* 0:00 cold open. A 1961 MIT film: the machines will think */}
      <Seg from={0} to={DROP}>
        <Clip name="selfridge" muted={false} volume={1.6} zoom={[1.0, 1.12]} />
        <LowerThird text="Oliver Selfridge · The Thinking Machine · 1961" />
        <Sub words={[["“I'm", 6], ["convinced", 9], ["that", 16], ["machines", 22], ["can", 29], ["and", 33], ["will", 37], ["think", 40], ["in", 48], ["our", 54], ["lifetime.”", 60]]} />
      </Seg>
      <Sequence from={DROP} durationInFrames={8} layout="none"><Clip name="selfridge" trim={DROP} muted={false} volume={1.6} /></Sequence>

      {/* the drop: neurons, they do, but never alone */}
      <Seg from={b(0)} to={b(2)}>
        <Clip name="neurons" zoom={[1.1, 1.35]} />
        <Seg from={0} to={BEAT}><Slam text="They do." size={230} /><Flash strength={0.7} /></Seg>
        <Seg from={BEAT} to={BEAT * 2}><Slam text="But never alone." size={150} color={SIG} /><Flash strength={0.2} /></Seg>
      </Seg>

      {/* football: three cuts of the 26-pass goal, the last one hits the net */}
      <Seg from={b(2)} to={b(5)}>
        <Seg from={0} to={15}><Clip name="ball-a" /><Flash strength={0.25} /></Seg>
        <Seg from={15} to={30}><Clip name="ball-b" /><Flash strength={0.15} /></Seg>
        <Seg from={30} to={60}><Clip name="ball-c" trim={7} zoom={[1, 1.15]} /></Seg>
        <Shade />
        <Slam text="Nobody scores alone." size={118} y={118} />
        <Seg from={30} to={60}><Tag text="Argentina v Serbia · 2006 · 26 passes, 1 goal" color={SIG} /></Seg>
      </Seg>

      {/* cypher: pass the mic */}
      <Seg from={b(5)} to={b(7)}>
        <Clip name="cypher" zoom={[1.05, 1.18]} />
        <Seg from={0} to={BEAT}><Slam text="Pass the mic." size={170} /><Flash strength={0.3} /></Seg>
        <Seg from={BEAT} to={BEAT * 2}><Slam text="Pass the context." size={150} color={SIG} /></Seg>
      </Seg>

      {/* cartoon run: time card, the plan, ka-chow */}
      <Seg from={b(7)} to={b(9.5)}>
        <Clip name="later" muted={false} volume={1.2} zoom={[1, 1]} />
        <Translate text="one context window later" />
      </Seg>
      <Seg from={b(9.5)} to={b(12)}>
        <Clip name="phineas" muted={false} volume={1.8} zoom={[1, 1.08]} />
        <Sub words={[["Codex,", 0], ["I", 4], ["know", 13], ["what", 18], ["we're", 22], ["gonna", 27], ["do", 34], ["today!", 41]]} />
      </Seg>
      <Seg from={b(12)} to={b(13)}>
        <Clip name="kachow" muted={false} volume={1.8} zoom={[1.0, 1.25]} />
        <Shade />
        <Flash strength={0.5} />
        <Slam text="Context loaded." size={140} y={120} color={INK} />
      </Seg>

      {/* our canvas: everyone linked */}
      <Seg from={b(13)} to={b(16)}>
        <Canvas offset={22} />
        <Flash strength={0.6} />
        <Slam text="Intelligence is collaborative." size={96} y={108} />
        <Seg from={BEAT * 1.5} to={BEAT * 3}><Slam text="So are your agents." size={56} y={985} color={SIG} /></Seg>
      </Seg>

      <Seg from={b(16)} to={COLLAB_FRAMES}>
        <End />
        <Flash strength={0.4} />
      </Seg>

      <Hud />
      <Grain />
    </AbsoluteFill>
  );
};

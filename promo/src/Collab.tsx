import React from "react";
import { AbsoluteFill, Easing, Sequence, interpolate, staticFile, useCurrentFrame } from "remotion";
import { Audio, Video } from "@remotion/media";
import { Canvas, End, Flash, Grain, Hud, Slam, useFonts } from "./Twitter";

// "Unleash intelligence. Connection drives innovation.": a square cut for the feed that walks from the
// 1950s labs to today. The instrumental plays from its first bar: the 20.4 s build-up carries the
// archive era (black and white, then the faded 80s), the drop lands on the present in colour.
// Footage, voices and music come from broll.sh (git-ignored). Every cut sits on the beat grid b(n),
// counted from the drop (negative n = the build-up).
const S = 1080;
const DROP = 612; // 20.40 s into the track
const BEAT = (60 / 95.83) * 30; // 18.78 frames
const b = (n: number) => Math.round(DROP + n * BEAT);
export const COLLAB_FRAMES = b(24) + 72;

const BG = "#0B0B0B";
const INK = "#EDEDEA";
const SIG = "#FF5A1F";
const MONO = "'Fragment Mono', ui-monospace, monospace";
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

const Shot: React.FC<{ name: string; zoom?: [number, number] }> = ({ name, zoom = [1, 1.08] }) => {
  const f = useCurrentFrame();
  const k = interpolate(f, [0, 90], zoom, clamp);
  return (
    <AbsoluteFill style={{ background: "#000", overflow: "hidden" }}>
      <Video src={staticFile(`broll/cuts/${name}.mp4`)} muted style={{ width: S, height: S, transform: `scale(${k})` }} />
    </AbsoluteFill>
  );
};

// documentary subtitle: words appear as they are spoken (frames from the voice line's start)
type Words = [string, number][];
const Sub: React.FC<{ words: Words }> = ({ words }) => {
  const f = useCurrentFrame();
  const shown = words.filter(([, t]) => f >= t);
  if (!shown.length) return null;
  return (
    <div style={{ position: "absolute", left: 80, right: 80, bottom: 92, textAlign: "center" }}>
      <span style={{ background: "rgba(0,0,0,.82)", color: INK, font: `400 34px/1.6 ${MONO}`, padding: "4px 14px", boxDecorationBreak: "clone", WebkitBoxDecorationBreak: "clone" }}>
        {shown.map(([w]) => w).join(" ")}
      </span>
    </div>
  );
};

// who or what, and when: an archive label in the corner
const Who: React.FC<{ text: string }> = ({ text }) => {
  const f = useCurrentFrame();
  const o = interpolate(f, [2, 8], [0, 1], clamp);
  return (
    <div style={{ position: "absolute", left: 52, top: 104, opacity: o, font: `400 17px ${MONO}`, letterSpacing: "0.14em", color: INK, textTransform: "uppercase", display: "flex", gap: 10, alignItems: "center", background: "rgba(0,0,0,.55)", padding: "5px 10px 5px 8px" }}>
      <span style={{ width: 10, height: 10, background: SIG, display: "inline-block" }} />
      {text}
    </div>
  );
};

const Seg: React.FC<{ from: number; to: number; children?: React.ReactNode }> = ({ from, to, children }) => (
  <Sequence from={from} durationInFrames={to - from} layout="none">{children}</Sequence>
);

// a shot between two beats, with its label
const At: React.FC<{ from: number; to: number; name: string; who?: string; zoom?: [number, number]; flash?: number; children?: React.ReactNode }> = ({ from, to, name, who, zoom, flash, children }) => (
  <Seg from={b(from)} to={b(to)}>
    <Shot name={name} zoom={zoom} />
    {flash ? <Flash strength={flash} /> : null}
    {who ? <Who text={who} /> : null}
    {children}
  </Seg>
);

// voices sit on top of the music; the music is never ducked under them
const VOICES: { name: string; from: number; len: number; words: Words; gain?: number }[] = [
  { name: "selfridge", from: 4, len: 98, words: [["“I'm", 6], ["convinced", 9], ["that", 16], ["machines", 22], ["can", 29], ["and", 33], ["will", 37], ["think", 40], ["in", 48], ["our", 54], ["lifetime.”", 60]] },
  { name: "wiesner", from: b(-27) + 4, len: 115, words: [["I", 2], ["suspect", 3], ["if", 12], ["you", 19], ["come", 22], ["back", 26], ["in", 32], ["four", 37], ["or", 46], ["five", 50], ["years,", 55], ["I'll", 63], ["say", 68], ["sure,", 73], ["they", 85], ["really", 88], ["do", 95], ["think.", 103]] },
  { name: "organism", from: b(-20) + 4, len: 130, words: [["We", 2], ["must", 12], ["look", 16], ["to", 23], ["the", 28], ["whole", 31], ["brain", 39], ["functioning", 52], ["as", 75], ["a", 89], ["unified", 93], ["organism.", 108]] },
  { name: "bicycle", from: b(-13) + 6, len: 78, words: [["It's", 2], ["the", 9], ["equivalent", 14], ["of", 23], ["a", 31], ["bicycle", 34], ["for", 45], ["our", 55], ["minds.", 60]] },
  { name: "breakthrough", from: b(4) + 2, len: 122, words: [["It", 3], ["had", 11], ["to", 18], ["wait", 23], ["until", 32], ["the", 46], ["year", 52], ["2020", 56], ["for", 73], ["the", 88], ["real", 92], ["breakthrough.", 99]], gain: 2.8 },
  { name: "emerge", from: b(20) + 4, len: 51, words: [["Something", 3], ["will", 8], ["emerge", 13], ["from", 22], ["the", 29], ["laboratories.", 33]], gain: 2.8 },
];

const Vo: React.FC<{ name: string; from: number; len: number; words: Words; gain?: number }> = ({ name, from, len, words, gain = 1.6 }) => (
  <Sequence from={from} layout="none">
    <Audio src={staticFile(`broll/vo/${name}.wav`)} volume={gain} />
    <Sequence durationInFrames={len + 6} layout="none"><Sub words={words} /></Sequence>
  </Sequence>
);

// the music starts in the back and keeps climbing through the build-up, then holds
const musicVolume = (f: number) =>
  interpolate(f, [0, DROP], [0.1, 0.6], { ...clamp, easing: Easing.in(Easing.quad) }) *
  interpolate(f, [COLLAB_FRAMES - 36, COLLAB_FRAMES], [1, 0], clamp);

export const Collab: React.FC = () => {
  useFonts();
  return (
    <AbsoluteFill style={{ background: BG, overflow: "hidden" }}>
      <Audio src={staticFile("music/instrumental.mp3")} volume={musicVolume} />

      {/* the build-up. 1950s and 60s: the first people who believed machines could think */}
      <Seg from={0} to={b(-27)}>
        <Shot name="selfridge" zoom={[1, 1.12]} />
        <Who text="Oliver Selfridge · MIT · 1961" />
      </Seg>
      <At from={-27} to={-25} name="checkers" who="The Thinking Machine · 1961" />
      <At from={-25} to={-23} name="tapes" />
      <At from={-23} to={-20} name="wiesner" who="Jerome Wiesner · MIT · 1961" zoom={[1.04, 1.14]} />
      <At from={-20} to={-15} name="diagram" who="The Human Brain · 1955" zoom={[1, 1.15]} />
      <At from={-15} to={-13} name="dot" who="Hubel & Wiesel · 1959" />

      {/* the 80s: the personal computer */}
      <At from={-13} to={-11} name="mac" who="Macintosh · 1984" />
      <At from={-11} to={-8} name="jobs" who="Steve Jobs · 1990" zoom={[1.02, 1.12]} />
      <At from={-8} to={-6} name="great" />

      {/* silicon and factories, cutting faster into the drop */}
      <At from={-6} to={-5} name="board" who="Silicon" />
      <At from={-5} to={-4} name="wafer" />
      <At from={-4} to={-3.5} name="cleanroom" />
      <At from={-3.5} to={-3} name="shannon" />
      <At from={-3} to={-2.5} name="chips" />
      <At from={-2.5} to={-2} name="fab" />
      <At from={-2} to={-1.5} name="foxconn" />
      <At from={-1.5} to={-1} name="line" />
      <Seg from={b(-1)} to={b(0)}><Slam text="Unleash" size={260} /></Seg>

      {/* the drop: today, in colour */}
      <At from={0} to={2} name="nn" who="2012 · Deep learning" flash={0.8}>
        <Slam text="Intelligence." size={200} />
      </At>
      <At from={2} to={4} name="alphago" who="2016 · AlphaGo" flash={0.3} />
      <At from={4} to={5} name="neurons" zoom={[1.2, 1.35]} flash={0.3} />
      <At from={5} to={9} name="alphafold" who="2020 · AlphaFold" flash={0.3} />
      <At from={9} to={10} name="maze" flash={0.3} />
      <At from={10} to={12} name="chatgpt" who="2022 · ChatGPT" flash={0.3} />
      <At from={12} to={13} name="devday" who="2023 · OpenAI DevDay" />
      <At from={13} to={16} name="nobel" who="2024 · Nobel Prize, Demis Hassabis" flash={0.3} zoom={[1, 1.1]} />

      {/* connection drives innovation */}
      <At from={16} to={18} name="plugs" flash={0.6}>
        <Slam text="Connection" size={200} />
      </At>
      <At from={18} to={20} name="neurons" zoom={[1, 1.2]} flash={0.3}>
        <Slam text="drives innovation." size={150} color={SIG} />
      </At>
      <Seg from={b(20)} to={b(24)}>
        <Canvas offset={10} />
        <Flash strength={0.6} />
        <Slam text="Connect your agents." size={100} y={108} />
      </Seg>
      <Seg from={b(24)} to={COLLAB_FRAMES}>
        <End />
        <Flash strength={0.4} />
      </Seg>

      {VOICES.map((v) => <Vo key={v.name} {...v} />)}

      <Hud />
      <Grain />
    </AbsoluteFill>
  );
};

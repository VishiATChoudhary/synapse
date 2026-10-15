import React from "react";
import { AbsoluteFill, Sequence, interpolate, staticFile, useCurrentFrame } from "remotion";
import { Audio, Video } from "@remotion/media";
import { Canvas, End, Flash, Grain, Hud, Slam, useFonts } from "./Twitter";

// "Intelligence is collaborative": 30 s square cut for the feed, told by the scientists who started it.
// Footage, voices and the instrumental come from broll.sh (git-ignored). The beat is 95.7 BPM and its
// drop sits at 20.50 s, so the track starts 17.50 s in and the drop lands on frame 90, right after
// Selfridge's line. Every cut sits on the beat grid b(n).
const S = 1080;
const DROP = 90;
const BEAT = (60 / 95.7) * 30; // 18.78 frames
const b = (n: number) => Math.round(DROP + n * BEAT);
export const COLLAB_FRAMES = 900;

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

// a voice line from the archive, with its subtitle
const Vo: React.FC<{ name: string; from: number; len: number; words: Words }> = ({ name, from, len, words }) => (
  <Sequence from={from} layout="none">
    <Audio src={staticFile(`broll/vo/${name}.wav`)} volume={1.5} />
    <Sequence durationInFrames={len + 6} layout="none"><Sub words={words} /></Sequence>
  </Sequence>
);

// who is speaking, archive-label style
const Who: React.FC<{ text: string }> = ({ text }) => {
  const f = useCurrentFrame();
  const o = interpolate(f, [3, 10], [0, 1], clamp);
  return (
    <div style={{ position: "absolute", left: 52, top: 104, opacity: o, font: `400 17px ${MONO}`, letterSpacing: "0.14em", color: INK, textTransform: "uppercase", display: "flex", gap: 10, alignItems: "center" }}>
      <span style={{ width: 10, height: 10, background: SIG, display: "inline-block" }} />
      {text}
    </div>
  );
};

const Seg: React.FC<{ from: number; to: number; children: React.ReactNode }> = ({ from, to, children }) => (
  <Sequence from={from} durationInFrames={to - from} layout="none">{children}</Sequence>
);

// every voice line: where it starts, how long it runs (for ducking), word timings (for the subtitle)
const VOICES: { name: string; from: number; len: number; words: Words }[] = [
  { name: "selfridge", from: 0, len: 97, words: [["“I'm", 6], ["convinced", 9], ["that", 16], ["machines", 22], ["can", 29], ["and", 33], ["will", 37], ["think", 40], ["in", 48], ["our", 54], ["lifetime.”", 60]] },
  { name: "wiesner", from: b(1), len: 115, words: [["I", 2], ["suspect", 3], ["if", 12], ["you", 19], ["come", 22], ["back", 26], ["in", 32], ["four", 37], ["or", 46], ["five", 50], ["years,", 55], ["I'll", 63], ["say", 68], ["sure,", 73], ["they", 85], ["really", 88], ["do", 95], ["think.", 103]] },
  { name: "hello", from: b(8) - 6, len: 75, words: [["Hello,", 2], ["I'm", 41], ["Claude", 55], ["Shannon.", 61]] },
  { name: "learn", from: b(11) + 15, len: 54, words: [["He", 3], ["can", 6], ["learn", 10], ["from", 27], ["experience.", 34]] },
  { name: "response", from: b(17) - 4, len: 66, words: [["And", 3], ["every", 7], ["time", 13], ["we", 18], ["did", 23], ["that,", 28], ["we'd", 38], ["get", 43], ["a", 46], ["response.", 49]] },
  { name: "organism", from: b(20) + 4, len: 130, words: [["We", 2], ["must", 12], ["look", 16], ["to", 23], ["the", 28], ["whole", 31], ["brain", 39], ["functioning", 52], ["as", 75], ["a", 89], ["unified", 93], ["organism.", 108]] },
  { name: "maze", from: b(30) + 6, len: 77, words: [["Then", 2], ["guide", 8], ["your", 17], ["call", 23], ["through", 32], ["the", 40], ["maze", 45], ["of", 53], ["connections.", 59]] },
  { name: "billions", from: b(35) + 8, len: 59, words: [["Billions", 2], ["of", 12], ["circuits", 18], ["may", 29], ["be", 36], ["set", 41], ["up.", 46]] },
  { name: "emerge", from: b(40) + 4, len: 51, words: [["Something", 3], ["will", 8], ["emerge", 13], ["from", 22], ["the", 29], ["laboratories.", 33]] },
];

// the beat carries the gaps and sits low under every voice
const musicVolume = (f: number) => {
  const speaking = VOICES.some(({ from, len }) => f >= from - 3 && f < from + len + 3);
  const level = f < DROP ? 0.35 : speaking ? 0.32 : 0.95;
  return level * interpolate(f, [0, 8, COLLAB_FRAMES - 30, COLLAB_FRAMES], [0, 1, 1, 0], clamp);
};

export const Collab: React.FC = () => {
  useFonts();
  return (
    <AbsoluteFill style={{ background: BG, overflow: "hidden" }}>
      <Audio src={staticFile("music/instrumental.mp3")} trimBefore={Math.round(17.5 * 30)} volume={musicVolume} />

      {/* I. 1961: the machines will think */}
      <Seg from={0} to={b(0)}>
        <Shot name="selfridge" zoom={[1, 1.12]} />
        <Who text="Oliver Selfridge · The Thinking Machine · 1961" />
      </Seg>
      <Seg from={b(0)} to={b(2)}><Shot name="checkers" /><Flash strength={0.6} /></Seg>
      <Seg from={b(2)} to={b(4)}><Shot name="tapes" /></Seg>
      <Seg from={b(4)} to={b(7)}>
        <Shot name="wiesner" zoom={[1.05, 1.15]} />
        <Who text="Jerome Wiesner · MIT · 1961" />
      </Seg>
      <Seg from={b(7)} to={b(8)}>
        <Shot name="neurons" zoom={[1.2, 1.35]} />
        <Slam text="They do." size={230} />
        <Flash strength={0.7} />
      </Seg>

      {/* II. Shannon's mouse learns */}
      <Seg from={b(8)} to={b(11)}>
        <Shot name="shannon" zoom={[1, 1.1]} />
        <Who text="Claude Shannon · Bell Labs · 1952" />
      </Seg>
      <Seg from={b(11)} to={b(15)}><Shot name="maze" zoom={[1, 1.12]} /></Seg>

      {/* III. one cell fires */}
      <Seg from={b(15)} to={b(17)}>
        <Shot name="cat" />
        <Who text="Hubel & Wiesel · visual cortex · 1959" />
        <Slam text="One cell fires." size={130} y={170} />
        <Flash strength={0.3} />
      </Seg>
      <Seg from={b(17)} to={b(20)}><Shot name="dot" zoom={[1.05, 1]} /></Seg>

      {/* IV. but the mind is the whole network */}
      <Seg from={b(20)} to={b(27)}>
        <Shot name="diagram" zoom={[1, 1.15]} />
        <Who text="The Human Brain · Encyclopaedia Britannica · 1955" />
      </Seg>
      <Seg from={b(27)} to={b(30)}>
        <Shot name="neurons" zoom={[1, 1.2]} />
        <Slam text="Intelligence is collaborative." size={150} />
        <Flash strength={0.6} />
      </Seg>

      {/* V. connect them */}
      <Seg from={b(30)} to={b(32)}>
        <Shot name="operators" />
        <Flash strength={0.3} />
      </Seg>
      <Seg from={b(32)} to={b(35)}>
        <Shot name="plugs" zoom={[1, 1.12]} />
        <Seg from={b(33) - b(32)} to={b(35) - b(32)}><Slam text="Connect them." size={150} y={150} color={SIG} /></Seg>
      </Seg>

      {/* VI. today: your agents, one nervous system */}
      <Seg from={b(35)} to={b(40)}>
        <Canvas offset={10} />
        <Flash strength={0.6} />
        <Seg from={0} to={b(37) - b(35)}><Slam text="Your agents." size={110} y={108} /></Seg>
        <Seg from={b(37) - b(35)} to={b(40) - b(35)}><Slam text="One nervous system." size={110} y={108} color={SIG} /></Seg>
      </Seg>
      <Seg from={b(40)} to={COLLAB_FRAMES}>
        <End />
        <Flash strength={0.4} />
        <Who text="Claude Shannon · 1961" />
      </Seg>

      {VOICES.map((v) => <Vo key={v.name} {...v} />)}

      <Hud />
      <Grain />
    </AbsoluteFill>
  );
};

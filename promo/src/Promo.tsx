import React from "react";
import {
  AbsoluteFill,
  Easing,
  Sequence,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { loadFont as loadGrotesk } from "@remotion/google-fonts/SpaceGrotesk";
import { loadFont as loadMono } from "@remotion/google-fonts/JetBrainsMono";

const { fontFamily: SANS } = loadGrotesk("normal", { weights: ["500", "700"], subsets: ["latin"] });
const { fontFamily: MONO } = loadMono("normal", { weights: ["400", "500"], subsets: ["latin"] });

const BG = "#07080c";
const C = ["#6C7CFF", "#F2B33D", "#2EC4A0", "#FF5C7A", "#A3D33C", "#D65FE0", "#3FB8F5", "#FF8552"];
const W = 1920;
const H = 1080;

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
const ease = Easing.bezier(0.22, 1, 0.36, 1);

// ------------------------------------------------------------------ world layout

type N = { x: number; y: number; c: string; born: number; r?: number };

// cluster A: "my" agents, grows out of one node
const A: N[] = [
  { x: 0, y: 0, c: C[0], born: 4, r: 30 },
  { x: -250, y: -120, c: C[0], born: 52 },
  { x: 230, y: -150, c: C[1], born: 56 },
  { x: 330, y: 70, c: C[2], born: 60 },
  { x: -330, y: 110, c: C[3], born: 64 },
  { x: -60, y: 230, c: C[2], born: 68 },
  { x: 120, y: -290, c: C[4], born: 72 },
  { x: -440, y: -100, c: C[1], born: 76 },
  { x: 190, y: 260, c: C[3], born: 80 },
  { x: -170, y: -300, c: C[5], born: 84 },
  { x: 480, y: -60, c: C[0], born: 88 },
  { x: -250, y: 300, c: C[4], born: 92 },
];
const AE: [number, number, number][] = [
  // [from, to, start frame]
  [0, 1, 118], [2, 0, 122], [0, 3, 126], [4, 0, 130], [0, 5, 134], [6, 2, 138],
  [1, 7, 142], [3, 8, 146], [9, 1, 150], [10, 3, 154], [5, 11, 158], [8, 5, 162], [9, 6, 166],
];

// cluster B: a friend's agents, slides in from the right
const BX = 1500;
const B: N[] = [
  { x: BX, y: 0, c: C[6], born: 206, r: 28 },
  { x: BX + 230, y: -130, c: C[7], born: 210 },
  { x: BX + 260, y: 140, c: C[5], born: 213 },
  { x: BX - 40, y: 250, c: C[7], born: 216 },
  { x: BX + 60, y: -260, c: C[6], born: 219 },
  { x: BX + 430, y: 10, c: C[4], born: 222 },
  { x: BX - 200, y: -170, c: C[5], born: 225 },
];
const BE: [number, number, number][] = [
  [0, 1, 226], [2, 0, 229], [0, 3, 232], [4, 0, 235], [1, 5, 238], [6, 0, 241], [2, 5, 244],
];
// the multiplayer bridge: friend's node 6 -> my node 10
const BRIDGE = { from: B[6], to: A[10], start: 246, end: 268 };

// ------------------------------------------------------------------ geometry

function quad(a: N, b: N) {
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
  const bend = Math.min(70, len * 0.14);
  return { cx: (a.x + b.x) / 2 - (dy / len) * bend, cy: (a.y + b.y) / 2 + (dx / len) * bend, len };
}
function qpt(a: N, b: N, t: number) {
  const { cx, cy } = quad(a, b);
  const u = 1 - t;
  return { x: u * u * a.x + 2 * u * t * cx + t * t * b.x, y: u * u * a.y + 2 * u * t * cy + t * t * b.y };
}

// ------------------------------------------------------------------ pieces

const Node: React.FC<{ n: N; frame: number; fps: number; busy?: boolean }> = ({ n, frame, fps, busy }) => {
  const local = frame - n.born;
  if (local < 0) return null;
  const s = spring({ frame: local, fps, config: { damping: 11, stiffness: 160 } });
  const r = (n.r ?? 22) * s;
  const period = busy ? 36 : 70;
  const rings = [0, 0.5].slice(0, busy ? 2 : 1);
  return (
    <g transform={`translate(${n.x} ${n.y})`}>
      {rings.map((off, i) => {
        const p = (((local / period) + off + n.x * 0.001) % 1 + 1) % 1;
        return (
          <circle key={i} r={r + 6 + Easing.out(Easing.cubic)(p) * (busy ? 46 : 30)} fill="none"
            stroke={n.c} strokeOpacity={(1 - p) * (busy ? 0.6 : 0.3)} strokeWidth={busy ? 3 : 2} />
        );
      })}
      {busy && (
        <path d={arc(r + 9, local / 6, local / 6 + 1.2)} stroke={n.c} strokeWidth={4} strokeLinecap="round" fill="none" />
      )}
      <circle r={r} fill={n.c} />
      <circle r={r * 0.6} fill="#fff" fillOpacity={0.14} />
    </g>
  );
};

function arc(r: number, a0: number, a1: number) {
  const p0 = { x: r * Math.cos(a0), y: r * Math.sin(a0) }, p1 = { x: r * Math.cos(a1), y: r * Math.sin(a1) };
  return `M ${p0.x} ${p0.y} A ${r} ${r} 0 0 1 ${p1.x} ${p1.y}`;
}

const Link: React.FC<{ a: N; b: N; start: number; frame: number; dur?: number; width?: number; packets?: number }> = ({
  a, b, start, frame, dur = 16, width = 3, packets = 2,
}) => {
  const p = interpolate(frame, [start, start + dur], [0, 1], { ...clamp, easing: ease });
  if (p <= 0) return null;
  const { cx, cy, len } = quad(a, b);
  const L = len * 1.05;
  const t0 = (a.r ?? 22) / len + 0.02, t1 = 1 - ((b.r ?? 22) + 12) / len;
  const pts = Array.from({ length: 41 }, (_, i) => qpt(a, b, t0 + (t1 - t0) * (i / 40)));
  const d = `M ${pts.map((q) => `${q.x} ${q.y}`).join(" L ")}`;
  const end = pts[40], pre = pts[38];
  const ang = (Math.atan2(end.y - pre.y, end.x - pre.x) * 180) / Math.PI;
  const id = `g${a.x}_${a.y}_${b.x}_${b.y}`.replace(/[-.]/g, "m");
  const flow = frame - start - dur;
  return (
    <g>
      <defs>
        <linearGradient id={id} gradientUnits="userSpaceOnUse" x1={a.x} y1={a.y} x2={b.x} y2={b.y}>
          <stop offset="0" stopColor={a.c} />
          <stop offset="1" stopColor={b.c} />
        </linearGradient>
      </defs>
      <path d={d} stroke={`url(#${id})`} strokeOpacity={0.75} strokeWidth={width} fill="none" strokeLinecap="round"
        strokeDasharray={L} strokeDashoffset={L * (1 - p)} />
      {p >= 1 && (
        <path d="M 4 0 L -10 -6.5 L -7 0 L -10 6.5 Z" fill={b.c} transform={`translate(${end.x} ${end.y}) rotate(${ang})`} />
      )}
      {flow > 0 && Array.from({ length: packets }, (_, i) => {
        const u = ((flow / 45 + i / packets) % 1);
        const q = qpt(a, b, t0 + (t1 - t0) * u);
        return (
          <g key={i} opacity={Math.sin(u * Math.PI)}>
            <circle cx={q.x} cy={q.y} r={7} fill={BG} />
            <circle cx={q.x} cy={q.y} r={4.5} fill={u < 0.5 ? a.c : b.c} />
          </g>
        );
      })}
    </g>
  );
};

const Cursor: React.FC<{ x: number; y: number; color: string; label: string; scale: number; opacity: number }> = ({
  x, y, color, label, scale, opacity,
}) => (
  <g transform={`translate(${x} ${y}) scale(${scale})`} opacity={opacity}>
    <path d="M0 0 L0 30 L8 22 L14 36 L20 33 L14 20 L25 20 Z" fill={color} stroke={BG} strokeWidth={2.5} strokeLinejoin="round" />
    <rect x={20} y={34} rx={10} width={label.length * 13 + 26} height={30} fill={color} />
    <text x={33} y={55} fontFamily={MONO} fontWeight={500} fontSize={18} fill={BG}>{label}</text>
  </g>
);

// Word-by-word slide-up caption
const Caption: React.FC<{ text: string; from: number; to: number; frame: number; fps: number; kicker?: string }> = ({
  text, from, to, frame, fps, kicker,
}) => {
  if (frame < from - 2 || frame > to + 12) return null;
  const out = interpolate(frame, [to, to + 10], [0, 1], { ...clamp, easing: Easing.in(Easing.cubic) });
  const words = text.split(" ");
  return (
    <div style={{ position: "absolute", left: 0, right: 0, bottom: 120, textAlign: "center", opacity: 1 - out, transform: `translateY(${-out * 20}px)` }}>
      {kicker && (
        <div style={{ fontFamily: MONO, fontSize: 20, letterSpacing: "0.35em", color: "#7d8496", marginBottom: 18, textTransform: "uppercase",
          opacity: interpolate(frame, [from, from + 10], [0, 1], clamp) }}>{kicker}</div>
      )}
      <div style={{ fontFamily: SANS, fontWeight: 700, fontSize: 76, color: "#eef0f6", letterSpacing: "-0.03em" }}>
        {words.map((w, i) => {
          const s = spring({ frame: frame - from - i * 4, fps, config: { damping: 200 }, durationInFrames: 18 });
          return (
            <span key={i} style={{ display: "inline-block", overflow: "hidden", verticalAlign: "bottom", paddingBottom: 8 }}>
              <span style={{ display: "inline-block", transform: `translateY(${(1 - s) * 100}%)`, opacity: s }}>
                {w}&nbsp;
              </span>
            </span>
          );
        })}
      </div>
    </div>
  );
};

// ------------------------------------------------------------------ scenes

const Mesh: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // camera: close on one node -> whole cluster -> pull back to reveal the friend's cluster
  const k1 = interpolate(frame, [0, 40, 120], [1.9, 1.7, 0.86], { ...clamp, easing: Easing.inOut(Easing.cubic) });
  const k2 = interpolate(frame, [196, 250], [1, 0.76], { ...clamp, easing: Easing.inOut(Easing.cubic) });
  const camX = interpolate(frame, [196, 250], [0, 760], { ...clamp, easing: Easing.inOut(Easing.cubic) });
  const drift = Math.sin(frame / 40) * 6;
  // bridge impact punch
  const punch = interpolate(frame, [268, 272, 284], [0, 1, 0], clamp);
  const k = k1 * k2 * (1 + punch * 0.03);
  // final shockwave + blackout
  const shock = interpolate(frame, [272, 296], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) });
  const fadeOut = interpolate(frame, [286, 298], [1, 0], clamp);

  // friend cursor: enters, lands on B[6], drags the bridge to A[10]
  const enter = interpolate(frame, [226, 246], [0, 1], { ...clamp, easing: ease });
  const drag = interpolate(frame, [BRIDGE.start, BRIDGE.end], [0, 1], { ...clamp, easing: Easing.inOut(Easing.cubic) });
  const fx = interpolate(enter, [0, 1], [BX + 700, BRIDGE.from.x + 20]) + (BRIDGE.to.x + 24 - (BRIDGE.from.x + 20)) * drag;
  const fy = interpolate(enter, [0, 1], [420, BRIDGE.from.y + 14]) + (BRIDGE.to.y + 14 - (BRIDGE.from.y + 14)) * drag;
  const fromB = BRIDGE.from;
  const bridgeTip: N = { x: fx - 20, y: fy - 14, c: C[5], born: 0, r: 0 };
  const bridgeLen = quad(fromB, BRIDGE.to).len;

  const meCursor = interpolate(frame, [200, 214], [0, 1], { ...clamp, easing: ease });
  const meX = -380 + Math.sin(frame / 18) * 30, meY = 200 + Math.cos(frame / 23) * 20;

  return (
    <AbsoluteFill style={{ opacity: fadeOut }}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
        <defs>
          <pattern id="dots" width={44 * k} height={44 * k} patternUnits="userSpaceOnUse"
            x={(W / 2 - camX * k) % (44 * k)} y={(H / 2 - 70 + drift * k) % (44 * k)}>
            <circle cx={1.5} cy={1.5} r={1.4} fill="#fff" fillOpacity={0.06} />
          </pattern>
        </defs>
        <rect width={W} height={H} fill={BG} />
        <rect width={W} height={H} fill="url(#dots)" />
        <g transform={`translate(${W / 2} ${H / 2 - 70 + drift}) scale(${k}) translate(${-camX} 0)`}>
          {AE.map(([a, b, s], i) => <Link key={`a${i}`} a={A[a]} b={A[b]} start={s} frame={frame} />)}
          {BE.map(([a, b, s], i) => <Link key={`b${i}`} a={B[a]} b={B[b]} start={s} frame={frame} dur={12} />)}
          {/* bridge being dragged, then the real link with a burst of packets */}
          {frame >= BRIDGE.start && frame < BRIDGE.end && (
            <path d={`M ${fromB.x} ${fromB.y} L ${bridgeTip.x} ${bridgeTip.y}`} stroke={C[5]} strokeWidth={5}
              strokeDasharray="14 12" strokeDashoffset={-frame * 3} strokeLinecap="round" />
          )}
          {frame >= BRIDGE.end && (
            <Link a={fromB} b={BRIDGE.to} start={BRIDGE.end - 6} frame={frame} dur={6} width={6} packets={5} />
          )}
          {frame >= BRIDGE.end && (() => {
            const p = interpolate(frame, [BRIDGE.end, BRIDGE.end + 22], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) });
            return <circle cx={BRIDGE.to.x} cy={BRIDGE.to.y} r={30 + p * bridgeLen * 0.35} fill="none" stroke={C[5]}
              strokeWidth={8 * (1 - p) + 1} strokeOpacity={1 - p} />;
          })()}
          {A.map((n, i) => <Node key={`n${i}`} n={n} frame={frame} fps={fps} busy={i === 0 || (frame > 160 && i % 3 === 0)} />)}
          {B.map((n, i) => <Node key={`m${i}`} n={n} frame={frame} fps={fps} busy={i % 2 === 0} />)}
          <Cursor x={meX} y={meY} color={C[0]} label="vishi" scale={2.6 * meCursor} opacity={meCursor} />
          {enter > 0 && <Cursor x={fx} y={fy} color={C[5]} label="you" scale={2.6} opacity={enter} />}
        </g>
        {/* shockwave */}
        {shock > 0 && (
          <circle cx={W / 2} cy={H / 2} r={shock * 1400} fill="none" stroke="#fff" strokeOpacity={1 - shock} strokeWidth={30 * (1 - shock) + 2} />
        )}
      </svg>
      <Caption text="one agent." from={14} to={52} frame={frame} fps={fps} />
      <Caption text="many agents." from={62} to={110} frame={frame} fps={fps} />
      <Caption text="one shared brain." from={124} to={190} frame={frame} fps={fps} kicker="synapse" />
      <Caption text="now bring your friends." from={214} to={262} frame={frame} fps={fps} />
    </AbsoluteFill>
  );
};

const WORD = "MULTIPLAYER";

const Finale: React.FC = () => {
  const frame = useCurrentFrame(); // local, starts at 0
  const { fps } = useVideoConfig();
  const land = 4 + (WORD.length - 1) * 2 + 8;
  const punch = interpolate(frame, [land, land + 3, land + 14], [1, 1.035, 1], clamp);
  const sub = "coming soon";
  const typed = Math.floor(interpolate(frame, [44, 44 + sub.length * 2.2], [0, sub.length], clamp));
  const caret = frame > 40 && Math.floor(frame / 8) % 2 === 0;
  const logo = spring({ frame: frame - 80, fps, config: { damping: 200 } });
  const end = interpolate(frame, [FINALE_FRAMES - 12, FINALE_FRAMES - 1], [1, 0], clamp);
  const underline = interpolate(frame, [land, land + 18], [0, 1], { ...clamp, easing: ease });

  return (
    <AbsoluteFill style={{ background: BG, opacity: end }}>
      {/* background pulse rings, like a giant busy node */}
      <svg width={W} height={H} style={{ position: "absolute" }}>
        {[0, 1, 2].map((i) => {
          const p = (((frame - land) / 60 + i / 3) % 1 + 1) % 1;
          if (frame < land) return null;
          return <circle key={i} cx={W / 2} cy={H / 2 - 20} r={180 + p * 760} fill="none" stroke={C[i * 2]} strokeOpacity={(1 - p) * 0.35} strokeWidth={3} />;
        })}
      </svg>
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", transform: `scale(${punch})` }}>
        <div style={{ display: "flex", fontFamily: SANS, fontWeight: 700, fontSize: 210, letterSpacing: "-0.04em", lineHeight: 1 }}>
          {WORD.split("").map((ch, i) => {
            const s = spring({ frame: frame - 4 - i * 2, fps, config: { damping: 13, stiffness: 180 } });
            const colorMix = interpolate(frame, [land + 6, land + 30], [0, 1], clamp);
            return (
              <span key={i} style={{
                display: "inline-block", position: "relative",
                transform: `translateY(${(1 - s) * 160}px) rotate(${(1 - s) * (i % 2 ? 8 : -8)}deg)`,
                opacity: Math.min(1, s * 1.4),
              }}>
                <span style={{ color: "#eef0f6", opacity: colorMix }}>{ch}</span>
                <span style={{ color: C[i % C.length], opacity: 1 - colorMix, position: "absolute", left: 0, top: 0 }}>{ch}</span>
              </span>
            );
          })}
        </div>
        {/* link underline with flowing packets */}
        <svg width={1300} height={40} style={{ marginTop: 18 }}>
          <line x1={20} y1={20} x2={20 + 1260 * underline} y2={20} stroke={C[0]} strokeWidth={4} strokeLinecap="round" />
          {underline >= 1 && [0, 1, 2, 3].map((i) => {
            const u = ((frame - land - 18) / 50 + i / 4) % 1;
            return (
              <g key={i} opacity={Math.sin(u * Math.PI)}>
                <circle cx={20 + 1260 * u} cy={20} r={10} fill={BG} />
                <circle cx={20 + 1260 * u} cy={20} r={7} fill={C[(i * 3 + 1) % C.length]} />
              </g>
            );
          })}
          {underline > 0 && <circle cx={20} cy={20} r={10} fill={C[0]} />}
          {underline > 0 && <circle cx={20 + 1260 * underline} cy={20} r={10} fill={C[5]} />}
        </svg>
        <div style={{ marginTop: 34, fontFamily: MONO, fontWeight: 500, fontSize: 46, letterSpacing: "0.42em", color: "#c9cdd8", textTransform: "uppercase", height: 60 }}>
          {sub.slice(0, typed)}
          <span style={{ opacity: caret ? 1 : 0, color: C[2] }}>_</span>
        </div>
      </AbsoluteFill>
      {/* sign-off */}
      <div style={{ position: "absolute", bottom: 70, left: 0, right: 0, display: "flex", justifyContent: "center", alignItems: "center", gap: 18,
        opacity: logo, transform: `translateY(${(1 - logo) * 20}px)` }}>
        <svg width={34} height={34}>
          <circle cx={17} cy={17} r={11} fill={C[0]} />
          <circle cx={17} cy={17} r={11 + ((frame / 40) % 1) * 6} fill="none" stroke={C[0]} strokeOpacity={1 - ((frame / 40) % 1)} strokeWidth={2} />
        </svg>
        <span style={{ fontFamily: SANS, fontWeight: 500, fontSize: 34, color: "#eef0f6", letterSpacing: "-0.01em" }}>synapse</span>
        <span style={{ fontFamily: MONO, fontSize: 20, color: "#7d8496", marginLeft: 6 }}>agent context mesh</span>
      </div>
    </AbsoluteFill>
  );
};

export const MESH_FRAMES = 300;
export const FINALE_FRAMES = 165;

export const Promo: React.FC = () => (
  <AbsoluteFill style={{ background: BG }}>
    <Sequence durationInFrames={MESH_FRAMES}>
      <Mesh />
    </Sequence>
    <Sequence from={MESH_FRAMES} durationInFrames={FINALE_FRAMES}>
      <Finale />
    </Sequence>
  </AbsoluteFill>
);

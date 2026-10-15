import React, { useLayoutEffect, useRef, useState } from "react";
import {
  AbsoluteFill,
  Easing,
  Sequence,
  continueRender,
  delayRender,
  interpolate,
  random,
  staticFile,
  useCurrentFrame,
} from "remotion";
import { Audio, Video } from "@remotion/media";

// 15 s square cut for the feed. 120 BPM: one beat = 15 frames, and every cut lands on a beat
// of the synthesized track (beat.py). Night palette: one ink on black, orange = live signal.
const S = 1080;
const BEAT = 15;
const at = (beat: number) => Math.round(beat * BEAT);
export const TWITTER_FRAMES = at(30);

const BG = "#0B0B0B";
const INK = "#EDEDEA";
const SIG = "#FF5A1F";
const ink = (a: number) => `rgba(237,237,234,${a})`;
const DISPLAY = "'Big Shoulders Display', 'Arial Narrow', sans-serif";
const MONO = "'Fragment Mono', ui-monospace, monospace";
const SERIF = "'Newsreader', Georgia, serif";

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
const out = Easing.bezier(0.16, 1, 0.3, 1);
const inOut = Easing.bezier(0.65, 0, 0.35, 1);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

const FONTS: [string, string, FontFaceDescriptors][] = [
  ["Big Shoulders Display", "fonts/big-shoulders-display.woff2", { weight: "200 500" }],
  ["Fragment Mono", "fonts/fragment-mono.woff2", { weight: "400" }],
  ["Newsreader", "fonts/newsreader-italic.woff2", { weight: "200 400", style: "italic" }],
];
function useFonts() {
  useState(() => {
    const h = delayRender("fonts");
    Promise.all(FONTS.map(([fam, file, d]) => new FontFace(fam, `url(${staticFile(file)})`, d).load().then((f) => document.fonts.add(f))))
      .then(() => continueRender(h)).catch(() => continueRender(h));
    return null;
  });
}

// ---------------------------------------------------------------- agents
type Agent = { id: string; name: string; kind: string; proj: number; x: number; y: number; busy?: boolean };
const PROJECTS = ["ACME-API", "ACME-WEB", "ACME-DOCS", "INFRA"];
const AGENTS: Agent[] = [
  { id: "f", name: "WEB-TESTS", kind: "codex", proj: 1, x: 270, y: 330 },
  { id: "b", name: "CODEX-API", kind: "codex", proj: 0, x: 740, y: 330, busy: true },
  { id: "a", name: "CLAUDE-WEB", kind: "claude", proj: 1, x: 270, y: 560, busy: true },
  { id: "c", name: "API-REVIEW", kind: "claude", proj: 0, x: 790, y: 570 },
  { id: "e", name: "OPENCODE-INFRA", kind: "opencode", proj: 3, x: 270, y: 815, busy: true },
  { id: "d", name: "GEMINI-DOCS", kind: "gemini", proj: 2, x: 740, y: 815 },
];
const byId = Object.fromEntries(AGENTS.map((a) => [a.id, a]));
// links draw on beats 6, 7, 8, 9 (3.0 to 4.5 s), the pluck hits in beat.py
const LINKS: [string, string, number][] = [["b", "a", 6], ["c", "b", 7], ["d", "a", 8], ["e", "d", 9]];

const Patterns: React.FC = () => (
  <defs>
    <pattern id="tp0" width="8" height="8" patternUnits="userSpaceOnUse"><rect width="8" height="8" fill={INK} /></pattern>
    <pattern id="tp1" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="7" height="7" fill={BG} /><rect width="1.8" height="7" fill={INK} /></pattern>
    <pattern id="tp2" width="6" height="6" patternUnits="userSpaceOnUse"><rect width="6" height="6" fill={BG} /><rect x="1" y="1" width="2.2" height="2.2" fill={INK} /></pattern>
    <pattern id="tp3" width="8" height="8" patternUnits="userSpaceOnUse"><rect width="8" height="8" fill={BG} /><rect width="8" height="1.5" fill={INK} /><rect width="1.5" height="8" fill={INK} /></pattern>
  </defs>
);

function curve(a: { x: number; y: number }, b: { x: number; y: number }, r = 34) {
  const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy), ux = dx / L, uy = dy / L;
  const cx = (a.x + b.x) / 2 - uy * L * 0.14, cy = (a.y + b.y) / 2 + ux * L * 0.14;
  return { sx: a.x + ux * r, sy: a.y + uy * r, cx, cy, ex: b.x - ux * (r + 10), ey: b.y - uy * (r + 10) };
}
const qp = (c: ReturnType<typeof curve>, t: number) => ({
  x: (1 - t) ** 2 * c.sx + 2 * (1 - t) * t * c.cx + t * t * c.ex,
  y: (1 - t) ** 2 * c.sy + 2 * (1 - t) * t * c.cy + t * t * c.ey,
});

const NodeBox: React.FC<{ a: Agent; f: number; on: number; R?: number; label?: boolean }> = ({ a, f, on, R = 30, label = true }) => {
  const ph = ((f + a.x) % (a.busy ? 30 : 60)) / (a.busy ? 30 : 60), e = R + 4 + ph * 26;
  const d = ((f / 30 + a.y / 400) % 1) * 8 * R;
  const pt = d < 2 * R ? [-R + d, -R] : d < 4 * R ? [R, -R + d - 2 * R] : d < 6 * R ? [R - (d - 4 * R), R] : [-R, R - (d - 6 * R)];
  return (
    <g transform={`translate(${a.x} ${a.y}) scale(${lerp(0.4, 1, on)})`} opacity={on}>
      <rect x={-e} y={-e} width={e * 2} height={e * 2} fill="none" stroke={INK} strokeOpacity={(1 - ph) * 0.5} />
      <rect x={-R} y={-R} width={R * 2} height={R * 2} fill={`url(#tp${a.proj})`} stroke={INK} strokeWidth={1.5} />
      {a.busy ? <rect x={pt[0] - 5} y={pt[1] - 5} width={10} height={10} fill={SIG} /> : null}
      {label ? <text y={R + 34} textAnchor="middle" fill={INK} style={{ font: `400 19px ${MONO}`, letterSpacing: "0.05em" }}>{a.name}</text> : null}
    </g>
  );
};

// ---------------------------------------------------------------- frame furniture
const Hud: React.FC = () => {
  const f = useCurrentFrame();
  const t = f / 30, ss = Math.floor(t), cs = Math.floor((t - ss) * 100);
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div style={{ position: "absolute", inset: 28, border: `1px solid ${ink(0.18)}` }} />
      <div style={{ position: "absolute", top: 44, left: 52, font: `500 30px/1 ${DISPLAY}`, letterSpacing: "0.04em", color: INK, display: "flex", alignItems: "center", gap: 12 }}>
        <svg width={24} height={24} viewBox="0 0 22 22" fill="none" stroke={INK} strokeWidth={1.4}><rect x="1.8" y="12.8" width="6.4" height="6.4" /><rect x="13.8" y="2.8" width="6.4" height="6.4" fill={SIG} stroke={SIG} /><path d="M8.2 12.8 13.8 9.2" /></svg>
        SYNAPSE
      </div>
      <div style={{ position: "absolute", top: 50, right: 52, font: `400 17px ${MONO}`, letterSpacing: "0.1em", color: ink(0.55), fontVariantNumeric: "tabular-nums" }}>
        {`00:${String(ss).padStart(2, "0")}.${String(cs).padStart(2, "0")}`}
      </div>
    </AbsoluteFill>
  );
};
const Grain: React.FC = () => {
  const seed = useCurrentFrame() % 6;
  return (
    <AbsoluteFill style={{ pointerEvents: "none", mixBlendMode: "overlay", opacity: 0.2 }}>
      <svg width={S} height={S}>
        <filter id={`tg${seed}`}><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves={2} seed={seed} stitchTiles="stitch" /><feColorMatrix values="0 0 0 0 .5 0 0 0 0 .5 0 0 0 0 .5 0 0 0 1.4 -.2" /></filter>
        <rect width={S} height={S} filter={`url(#tg${seed})`} />
      </svg>
    </AbsoluteFill>
  );
};
const Flash: React.FC<{ strength?: number }> = ({ strength = 0.5 }) => {
  const f = useCurrentFrame();
  return <AbsoluteFill style={{ background: INK, opacity: interpolate(f, [0, 4], [strength, 0], clamp), pointerEvents: "none" }} />;
};
// bottom caption: big compressed type that slams in on the beat
const Slam: React.FC<{ text: string; size?: number; y?: number; color?: string; sub?: string }> = ({ text, size = 150, y, color = INK, sub }) => {
  const f = useCurrentFrame();
  const k = interpolate(f, [0, 5], [1.18, 1], { ...clamp, easing: out });
  const o = interpolate(f, [0, 2], [0, 1], clamp);
  return (
    <div style={{ position: "absolute", left: 0, right: 0, top: y ?? "50%", transform: `${y === undefined ? "translateY(-50%) " : ""}scale(${k})`, textAlign: "center", opacity: o }}>
      <div style={{ font: `300 ${size}px/0.86 ${DISPLAY}`, textTransform: "uppercase", color, letterSpacing: "0.005em" }}>{text}</div>
      {sub ? <div style={{ marginTop: 18, font: `400 18px ${MONO}`, letterSpacing: "0.14em", textTransform: "uppercase", color: ink(0.6) }}>{sub}</div> : null}
    </div>
  );
};
const Caption: React.FC<{ text: string }> = ({ text }) => {
  const f = useCurrentFrame();
  const n = Math.floor(interpolate(f, [0, text.length * 0.6], [0, text.length], clamp));
  return <div style={{ position: "absolute", left: 52, bottom: 50, font: `400 17px ${MONO}`, letterSpacing: "0.12em", color: ink(0.6), textTransform: "uppercase" }}>{text.slice(0, n)}</div>;
};

// ---------------------------------------------------------------- scenes
// I. hook (beats 0-4): six agents typing blind; one slam per beat
const PANES = [
  ["CLAUDE", "> wire rate limiter", "? can't see the API"],
  ["CODEX", "> add RateLimitError", "✓ landed a41f9c2"],
  ["GEMINI", "> document the 429", "? unit of retryAfter"],
  ["OPENCODE", "> raise gateway limit", "? which limit"],
  ["CURSOR", "> restyle error banner", "? which error codes"],
  ["AMP", "> audit session.ts", "? did refresh move"],
];
const PANE = { w: 300, h: 210, gx: 24, gy: 24 };
const paneXY = (i: number) => ({
  x: (S - (PANE.w * 3 + PANE.gx * 2)) / 2 + (i % 3) * (PANE.w + PANE.gx) + PANE.w / 2,
  y: 300 + Math.floor(i / 3) * (PANE.h + PANE.gy) + PANE.h / 2,
});
const Hook: React.FC = () => {
  const f = useCurrentFrame();
  const slams = ["6 agents.", "6 terminals.", "zero", "shared context."];
  const k = Math.min(3, Math.floor(f / BEAT));
  return (
    <AbsoluteFill>
      {PANES.map(([name, a, q], i) => {
        const { x, y } = paneXY(i);
        const on = interpolate(f, [i * 2, i * 2 + 8], [0, 1], { ...clamp, easing: out });
        const t1 = Math.floor(interpolate(f, [6 + i * 2, 24 + i * 2], [0, a.length], clamp));
        const t2 = Math.floor(interpolate(f, [26 + i * 3, 44 + i * 3], [0, q.length], clamp));
        const blink = q.startsWith("?") && f > 44 + i * 3 && Math.floor(f / 4) % 2 === 0;
        return (
          <div key={i} style={{ position: "absolute", left: x - PANE.w / 2, top: y - PANE.h / 2, width: PANE.w, height: PANE.h, border: `1px solid ${ink(0.45)}`, background: BG, opacity: on, transform: `scale(${lerp(0.9, 1, on)})` }}>
            <div style={{ padding: "8px 12px", borderBottom: `1px solid ${ink(0.15)}`, font: `400 13px ${MONO}`, letterSpacing: "0.12em", color: ink(0.55) }}>{name}</div>
            <div style={{ padding: "12px 12px", font: `400 15px/1.8 ${MONO}`, whiteSpace: "pre" }}>
              <div style={{ color: ink(0.6) }}>{a.slice(0, t1)}</div>
              <div style={{ color: q.startsWith("?") ? SIG : INK, opacity: blink ? 0.35 : 1 }}>{q.slice(0, t2)}</div>
            </div>
          </div>
        );
      })}
      <AbsoluteFill style={{ background: "rgba(11,11,11,.3)" }} />
      <Sequence from={k * BEAT} durationInFrames={BEAT} layout="none" key={k}>
        <Slam text={slams[k]} size={k === 2 ? 260 : 170} color={k >= 2 ? SIG : INK} />
        <Flash strength={0.18} />
      </Sequence>
    </AbsoluteFill>
  );
};

// II. drop (beats 4-10): panes snap into nodes, frames appear, four links draw on the beat
const Canvas: React.FC<{ zoom?: number; focus?: { x: number; y: number }; offset?: number }> = ({ zoom = 1, focus, offset = 0 }) => {
  const f = useCurrentFrame() + offset; // offset: start part-way through, already settled
  const collapse = interpolate(f, [0, 10], [0, 1], { ...clamp, easing: inOut });
  const shake = f < 8 ? (random(`sx${f}`) - 0.5) * 16 * (1 - f / 8) : 0;
  const framesOn = interpolate(f, [10, 18], [0, 1], clamp);
  const groups = PROJECTS.map((_, p) => AGENTS.filter((a) => a.proj === p));
  const fx = focus?.x ?? S / 2, fy = focus?.y ?? S / 2;
  return (
    <AbsoluteFill style={{ transform: `translate(${shake}px, ${shake * 0.6}px)` }}>
      <svg width={S} height={S}>
        <Patterns />
        <g transform={`translate(${S / 2} ${S / 2}) scale(${zoom}) translate(${-fx} ${-fy})`}>
          {Array.from({ length: 23 }, (_, i) => Array.from({ length: 23 }, (_, j) => (
            <rect key={`${i}-${j}`} x={i * 48 + 12} y={j * 48 + 12} width={2} height={2} fill={ink(0.12)} />
          )))}
          {groups.map((g, p) => {
            const x0 = Math.min(...g.map((a) => a.x)) - 130, x1 = Math.max(...g.map((a) => a.x)) + 130;
            const y0 = Math.min(...g.map((a) => a.y)) - 70, y1 = Math.max(...g.map((a) => a.y)) + 80;
            return (
              <g key={p} opacity={framesOn}>
                <rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} fill={ink(0.03)} stroke={ink(0.3)} />
                <rect x={x0} y={y0 - 30} width={PROJECTS[p].length * 11.5 + 66} height={30} fill={BG} stroke={ink(0.3)} />
                <rect x={x0 + 11} y={y0 - 20} width={11} height={11} fill={`url(#tp${p})`} stroke={INK} />
                <text x={x0 + 32} y={y0 - 9} fill={INK} style={{ font: `400 16px ${MONO}`, letterSpacing: "0.06em" }}>{`${PROJECTS[p]}  ${g.length}`}</text>
              </g>
            );
          })}
          {LINKS.map(([a, b, beat], i) => {
            const c = curve(byId[a], byId[b]), t0 = at(beat) - at(4), g = interpolate(f, [t0, t0 + 7], [0, 1], { ...clamp, easing: out });
            if (g <= 0) return null;
            const hot = interpolate(f, [t0 + 7, t0 + 30], [1, 0], clamp);
            const end = qp(c, 1), pre = qp(c, 0.96), ang = (Math.atan2(end.y - pre.y, end.x - pre.x) * 180) / Math.PI;
            const col = hot > 0.08 ? SIG : INK;
            return (
              <g key={i}>
                <path d={`M${c.sx} ${c.sy}Q${c.cx} ${c.cy} ${c.ex} ${c.ey}`} fill="none" stroke={col} strokeWidth={2 + hot * 2} pathLength={1} strokeDasharray="1 1" strokeDashoffset={1 - g} />
                {g >= 1 ? <path d="M4 0 L-11 -7 L-11 7 Z" fill={col} transform={`translate(${end.x} ${end.y}) rotate(${ang})`} /> : null}
                {g >= 1 ? [0, 1, 2].map((k) => {
                  const u = ((f - t0) / 36 + k / 3) % 1, p = qp(c, u);
                  return <rect key={k} x={p.x - 5} y={p.y - 5} width={10} height={10} fill={INK} stroke={BG} strokeWidth={2.5} opacity={Math.sin(u * Math.PI)} />;
                }) : null}
              </g>
            );
          })}
          {AGENTS.map((a, i) => {
            const from = paneXY(i);
            const x = lerp(from.x, a.x, collapse), y = lerp(from.y, a.y, collapse);
            return <NodeBox key={a.id} a={{ ...a, x, y }} f={f} on={collapse} />;
          })}
        </g>
      </svg>
    </AbsoluteFill>
  );
};

// III. agents talk (beats 10-14): close-up card over the canvas
const Talk: React.FC = () => {
  const f = useCurrentFrame();
  const rows: [string, string][] = [
    ["~/acme-web $ claude", ink(0.5)],
    ["synapse ⇢ pulled codex-api", SIG],
    ["", INK],
  ];
  const chars = Math.round(interpolate(f, [8, 26], [0, 3400], { ...clamp, easing: out }));
  const msgs = [
    { at: 30, who: "CLAUDE-WEB → CODEX-API", text: "Did the rate limiter land?", right: false },
    { at: 45, who: "CODEX-API → CLAUDE-WEB", text: "Landed in a41f9c2. Hold off on session.ts.", right: true },
  ];
  const on = interpolate(f, [0, 6], [0, 1], { ...clamp, easing: out });
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", background: "rgba(11,11,11,.7)", opacity: on }}>
      <div style={{ width: 860, border: `1px solid ${ink(0.4)}`, background: BG, transform: `translateY(${(1 - on) * 30}px)` }}>
        <div style={{ padding: "12px 18px", borderBottom: `1px solid ${ink(0.18)}`, font: `400 14px ${MONO}`, letterSpacing: "0.12em", color: ink(0.5) }}>CLAUDE CODE · ACME-WEB</div>
        <div style={{ padding: "22px 24px 8px", font: `400 24px/1.7 ${MONO}`, whiteSpace: "pre" }}>
          {rows.map(([t, c], i) => {
            const n = Math.floor(interpolate(f, [2 + i * 5, 8 + i * 5], [0, t.length], clamp));
            return <div key={i} style={{ color: c, minHeight: "1.7em" }}>{t.slice(0, n)}</div>;
          })}
          <div style={{ display: "flex", gap: 40, marginTop: -40, font: `200 92px/1 ${DISPLAY}`, color: INK, opacity: f > 8 ? 1 : 0 }}>
            <span style={{ fontVariantNumeric: "tabular-nums" }}>{(chars / 1000).toFixed(1)}K</span>
            <span style={{ alignSelf: "flex-end", font: `400 16px ${MONO}`, letterSpacing: "0.12em", color: ink(0.55), paddingBottom: 12 }}>CHARS OF CONTEXT, 13 MESSAGES</span>
          </div>
        </div>
        <div style={{ padding: "18px 24px 24px", display: "flex", flexDirection: "column", gap: 10 }}>
          {msgs.map((m, i) => {
            const o = interpolate(f, [m.at, m.at + 5], [0, 1], { ...clamp, easing: out });
            return (
              <div key={i} style={{ alignSelf: m.right ? "flex-end" : "flex-start", maxWidth: "82%", border: `1px solid ${m.right ? INK : ink(0.35)}`, padding: "10px 14px", opacity: o, transform: `translateY(${(1 - o) * 14}px)` }}>
                <div style={{ font: `400 13px ${MONO}`, letterSpacing: "0.1em", color: ink(0.5), marginBottom: 4 }}>{`✉ ${m.who}`}</div>
                <div style={{ font: `400 22px/1.4 ${MONO}`, color: INK }}>{m.text}</div>
              </div>
            );
          })}
        </div>
      </div>
    </AbsoluteFill>
  );
};

// IV. scale (beats 14-16): zoom out, the canvas tiles into many projects
const Swarm: React.FC = () => {
  const f = useCurrentFrame();
  const zoom = interpolate(f, [0, 30], [1, 0.32], { ...clamp, easing: inOut });
  const tiles = [];
  for (let i = -3; i <= 3; i++) for (let j = -3; j <= 3; j++) {
    if (i === 0 && j === 0) continue;
    const d = Math.hypot(i, j), on = interpolate(f, [d * 3, d * 3 + 8], [0, 1], clamp);
    tiles.push({ i, j, on, p: Math.abs(i * 7 + j * 3) % 4, n: 2 + (Math.abs(i * 5 + j * 11) % 4) });
  }
  return (
    <AbsoluteFill>
      <svg width={S} height={S}>
        <Patterns />
        <g transform={`translate(${S / 2} ${S / 2}) scale(${zoom})`}>
          {tiles.map((t, k) => (
            <g key={k} transform={`translate(${t.i * 1150} ${t.j * 1150})`} opacity={t.on}>
              <rect x={-470} y={-420} width={940} height={840} fill={ink(0.03)} stroke={ink(0.35)} strokeWidth={3} />
              {Array.from({ length: t.n }, (_, q) => {
                const x = -300 + (q % 2) * 600, y = -240 + Math.floor(q / 2) * 480;
                const busy = (k + q) % 3 === 0;
                const ph = ((f + k * 7 + q * 5) % 30) / 30;
                return (
                  <g key={q}>
                    <rect x={x - 90} y={y - 90} width={180} height={180} fill={`url(#tp${(t.p + q) % 4})`} stroke={INK} strokeWidth={4} />
                    <rect x={x - 90 - ph * 60} y={y - 90 - ph * 60} width={180 + ph * 120} height={180 + ph * 120} fill="none" stroke={INK} strokeOpacity={(1 - ph) * 0.5} strokeWidth={4} />
                    {busy ? <rect x={x + 70} y={y - 110} width={40} height={40} fill={SIG} /> : null}
                  </g>
                );
              })}
            </g>
          ))}
        </g>
      </svg>
      <div style={{ position: "absolute", inset: 0, transform: `scale(${zoom})`, transformOrigin: "50% 50%" }}>
        <Canvas zoom={1} offset={at(10)} />
      </div>
    </AbsoluteFill>
  );
};

// V. the entity (beats 16-20): MRI flashes on the half-beats, then the network becomes a brain
type Dot = { x: number; y: number; b: number; sx: number; sy: number; d: number };
function useBrainDots(step: number, width: number) {
  const [dots, setDots] = useState<Dot[] | null>(null);
  const [handle] = useState(() => delayRender("brain"));
  useLayoutEffect(() => {
    const img = new Image();
    img.onload = () => {
      const cw = width, ch = Math.round((img.height / img.width) * cw);
      const c = document.createElement("canvas"); c.width = cw; c.height = ch;
      const x = c.getContext("2d")!; x.drawImage(img, 0, 0, cw, ch);
      const px = x.getImageData(0, 0, cw, ch).data, res: Dot[] = [];
      const ox = (S - cw) / 2, oy = (S - ch) / 2;
      for (let j = 0; j < ch; j += step) for (let i = 0; i < cw; i += step) {
        const b = px[(j * cw + i) * 4] / 255;
        if (b < 0.16) continue;
        const k = res.length, src = AGENTS[k % AGENTS.length];
        res.push({ x: ox + i, y: oy + j, b, sx: src.x + (random(`x${k}`) - 0.5) * 70, sy: src.y + (random(`y${k}`) - 0.5) * 70, d: random(`d${k}`) });
      }
      setDots(res); continueRender(handle);
    };
    img.onerror = () => continueRender(handle);
    img.src = staticFile("footage/brain-sagittal.png");
  }, [handle, step, width]);
  return dots;
}
const Brain: React.FC<{ assemble?: number; dim?: number; hold?: boolean }> = ({ assemble = 30, dim = 1, hold }) => {
  const f = useCurrentFrame();
  const ref = useRef<HTMLCanvasElement>(null);
  const dots = useBrainDots(7, 1500);
  useLayoutEffect(() => {
    const cv = ref.current; if (!cv || !dots) return;
    const ctx = cv.getContext("2d")!; ctx.clearRect(0, 0, S, S);
    const waves = [0, 1].map((k) => ({ cx: S * (0.35 + 0.3 * k), cy: S * 0.45, r: (f * 11 + k * 380) % 900 }));
    for (const d of dots) {
      const t = hold ? 1 : interpolate(f, [d.d * assemble * 0.5, d.d * assemble * 0.5 + assemble * 0.5], [0, 1], { ...clamp, easing: inOut });
      const x = lerp(d.sx, d.x, t), y = lerp(d.sy, d.y, t);
      let w = 0;
      for (const v of waves) { const dd = Math.abs(Math.hypot(x - v.cx, y - v.cy) - v.r); if (dd < 14) w = Math.max(w, (1 - dd / 14) * (1 - v.r / 900)); }
      const size = Math.max(1, Math.round(d.b * 4) * 1.4) * (1 + w * 0.5);
      ctx.fillStyle = w > 0.3 && t > 0.98 ? `rgba(255,90,31,${Math.min(1, w * 1.5) * dim})` : ink((0.3 + d.b * 0.65) * dim);
      ctx.fillRect(x - size / 2, y - size / 2, size, size);
    }
  }, [f, dots, assemble, dim, hold]);
  return <AbsoluteFill><canvas ref={ref} width={S} height={S} style={{ width: S, height: S }} /></AbsoluteFill>;
};
// the clips are 16:9; size them to the square's height and centre them, slightly zoomed
const Mri: React.FC<{ src: string; trim: number }> = ({ src, trim }) => (
  <AbsoluteFill style={{ background: "#000", overflow: "hidden" }}>
    <div style={{ position: "absolute", top: 0, left: (S - (S * 16) / 9) / 2, width: (S * 16) / 9, height: S, transform: "scale(1.15)" }}>
      <Video src={staticFile(`footage/${src}`)} trimBefore={trim} muted style={{ width: "100%", height: "100%" }} />
    </div>
  </AbsoluteFill>
);

// VI. title (beats 20-25) and end card (25-30)
const Title: React.FC = () => {
  const f = useCurrentFrame();
  const sub = interpolate(f, [12, 22], [0, 1], clamp);
  const cli = interpolate(f, [30, 40], [0, 1], clamp);
  return (
    <AbsoluteFill>
      <div style={{ position: "absolute", top: 300, left: 0, right: 0, textAlign: "center", font: `200 300px/0.8 ${DISPLAY}`, color: INK }}>
        {"SYNAPSE".split("").map((l, i) => {
          const t = interpolate(f, [i * 1.5, i * 1.5 + 9], [0, 1], { ...clamp, easing: out });
          return <span key={i} style={{ display: "inline-block", clipPath: `inset(${(1 - t) * 100}% 0 0 0)`, transform: `translateY(${(1 - t) * 50}px)` }}>{l}</span>;
        })}
      </div>
      <div style={{ position: "absolute", top: 590, left: 0, right: 0, textAlign: "center", font: `italic 300 46px ${SERIF}`, color: INK, opacity: sub, filter: `blur(${(1 - sub) * 6}px)` }}>A nervous system for your agents.</div>
      <div style={{ position: "absolute", top: 680, left: 60, right: 60, textAlign: "center", font: `400 17px/1.9 ${MONO}`, letterSpacing: "0.14em", color: ink(0.6), opacity: cli }}>
        CLAUDE CODE · CODEX · GEMINI · OPENCODE<br />CURSOR · AMP · COPILOT
      </div>
    </AbsoluteFill>
  );
};
const End: React.FC = () => {
  const f = useCurrentFrame();
  const rows = [
    { t: 0, el: <div style={{ font: `200 210px/0.8 ${DISPLAY}`, color: INK }}>SYNAPSE</div> },
    { t: 4, el: <div style={{ font: `400 20px ${MONO}`, letterSpacing: "0.16em", color: ink(0.6) }}>OPEN SOURCE · ZERO DEPENDENCIES · MIT</div> },
    { t: 10, el: <div style={{ font: `400 40px ${MONO}`, color: INK, border: `1px solid ${INK}`, padding: "14px 26px" }}>heysynapse.vercel.app</div> },
    { t: 18, el: <div style={{ font: `400 20px ${MONO}`, letterSpacing: "0.16em", color: SIG }}>■ MULTIPLAYER, COMING SOON</div> },
  ];
  const fadeOut = interpolate(f, [at(5) - 10, at(5)], [1, 0], clamp);
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", flexDirection: "column", gap: 34, opacity: fadeOut }}>
      {rows.map((r, i) => {
        const o = interpolate(f, [r.t, r.t + 6], [0, 1], { ...clamp, easing: out });
        return <div key={i} style={{ opacity: o, transform: `translateY(${(1 - o) * 16}px)` }}>{r.el}</div>;
      })}
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------- timeline (in beats)
const B: React.FC<{ from: number; to: number; children: React.ReactNode }> = ({ from, to, children }) => (
  <Sequence from={at(from)} durationInFrames={at(to) - at(from)} layout="none">{children}</Sequence>
);

export const Twitter: React.FC = () => {
  useFonts();
  return (
    <AbsoluteFill style={{ background: BG, overflow: "hidden" }}>
      <Audio src={staticFile("music/beat.wav")} />

      <B from={0} to={4}><Hook /></B>

      <B from={4} to={14}>
        <Canvas />
        <B from={0} to={1}><Flash strength={0.6} /></B>
        <B from={2} to={4}><Slam text="Draw a line." size={120} y={104} /></B>
        <B from={4} to={6}><Slam text="Context flows." size={120} y={104} color={SIG} /></B>
        <B from={0} to={6}><Caption text="Fig.1  Synapse canvas, live" /></B>
        <B from={6} to={10}><Talk /></B>
        <B from={8} to={10}><Slam text="Agents talk." size={120} y={104} /></B>
      </B>

      <B from={14} to={16}>
        <Swarm />
        <Slam text="Every agent. One canvas." size={96} y={104} />
      </B>

      <B from={16} to={16.5}><Mri src="mri-axial.mp4" trim={60} /><Flash /></B>
      <B from={16.5} to={17}><Brain hold /></B>
      <B from={17} to={17.5}><Mri src="mri-coronal.mp4" trim={90} /><Flash /></B>
      <B from={17.5} to={18}><Brain hold /></B>
      <B from={18} to={18.5}><Mri src="mri-sagittal.mp4" trim={60} /><Flash /></B>
      <B from={18.5} to={20}>
        <Brain assemble={20} />
        <Slam text="A nervous system" size={92} y={104} />
      </B>

      <B from={20} to={25}>
        <Brain hold dim={0.22} />
        <Title />
        <B from={0} to={1}><Flash strength={0.8} /></B>
      </B>
      <B from={25} to={30}>
        <End />
        <B from={0} to={1}><Flash strength={0.4} /></B>
      </B>

      <Hud />
      <Grain />
    </AbsoluteFill>
  );
};

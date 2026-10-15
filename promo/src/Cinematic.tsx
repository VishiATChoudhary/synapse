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

// ---------------------------------------------------------------- system
// Night palette from the Synapse canvas: one ink on black, orange for live signal.
const BG = "#0B0B0B";
const INK = "#EDEDEA";
const SIG = "#FF5A1F";
const W = 1920;
const H = 1080;
const FPS = 30;
const BAR = 138; // 2.39:1 letterbox
const s = (sec: number) => Math.round(sec * FPS);

export const CINEMATIC_FRAMES = s(84);

const DISPLAY = "'Big Shoulders Display', 'Arial Narrow', sans-serif";
const MONO = "'Fragment Mono', ui-monospace, monospace";
const SANS = "'Geist', system-ui, sans-serif";
const SERIF = "'Newsreader', Georgia, serif";

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
const easeOut = Easing.bezier(0.16, 1, 0.3, 1);
const easeInOut = Easing.bezier(0.65, 0, 0.35, 1);
const ink = (a: number) => `rgba(237,237,234,${a})`;

const FONTS: [string, string, FontFaceDescriptors][] = [
  ["Big Shoulders Display", "fonts/big-shoulders-display.woff2", { weight: "200 500" }],
  ["Fragment Mono", "fonts/fragment-mono.woff2", { weight: "400" }],
  ["Geist", "fonts/geist.woff2", { weight: "400" }],
  ["Newsreader", "fonts/newsreader-italic.woff2", { weight: "200 400", style: "italic" }],
];
function useFonts() {
  useState(() => {
    const h = delayRender("fonts");
    Promise.all(FONTS.map(([fam, file, d]) => new FontFace(fam, `url(${staticFile(file)})`, d).load().then((f) => document.fonts.add(f))))
      .then(() => continueRender(h))
      .catch(() => continueRender(h));
    return null;
  });
}

// fade a scene in and out over its own local frames
function useFade(len: number, fin = 12, fout = 12) {
  const f = useCurrentFrame();
  return interpolate(f, [0, fin, len - fout, len], [0, 1, 1, 0], clamp);
}

// ---------------------------------------------------------------- shared pieces
const Caption: React.FC<{ fig: string; text: string; delay?: number }> = ({ fig, text, delay = 10 }) => {
  const f = useCurrentFrame();
  const o = interpolate(f, [delay, delay + 14], [0, 1], clamp);
  return (
    <div style={{ position: "absolute", left: 96, bottom: BAR + 40, display: "flex", gap: 22, font: `400 17px ${MONO}`, letterSpacing: "0.08em", textTransform: "uppercase", color: ink(0.75), opacity: o }}>
      <span style={{ color: ink(0.4) }}>{fig}</span>
      <span>{text}</span>
    </div>
  );
};

// big thin number that counts up, with a mono label
const Count: React.FC<{ to: number; label: string; from?: number; delay?: number; dur?: number; right?: boolean }> = ({ to, label, from = 0, delay = 8, dur = 70, right }) => {
  const f = useCurrentFrame();
  const t = interpolate(f, [delay, delay + dur], [0, 1], { ...clamp, easing: easeOut });
  const v = Math.round(from + (to - from) * t);
  const o = interpolate(f, [delay - 6, delay + 10], [0, 1], clamp);
  return (
    <div style={{ position: "absolute", top: BAR + 70, [right ? "right" : "left"]: 96, textAlign: right ? "right" : "left", opacity: o }}>
      <div style={{ font: `200 150px/0.85 ${DISPLAY}`, color: INK, fontVariantNumeric: "tabular-nums", letterSpacing: "-0.01em" }}>{v.toLocaleString("en-US")}</div>
      <div style={{ marginTop: 14, font: `400 17px ${MONO}`, letterSpacing: "0.12em", textTransform: "uppercase", color: SIG }}>{label}</div>
    </div>
  );
};

// a serif line revealed word by word
const Quote: React.FC<{ lines: string[]; by?: string; delay?: number; size?: number; stagger?: number; y?: number }> = ({ lines, by, delay = 8, size = 64, stagger = 4, y }) => {
  const f = useCurrentFrame();
  let k = 0;
  return (
    <div style={{ position: "absolute", left: 0, right: 0, top: y ?? "50%", transform: y === undefined ? "translateY(-50%)" : undefined, textAlign: "center" }}>
      {lines.map((line, i) => (
        <div key={i} style={{ font: `italic 300 ${size}px/1.18 ${SERIF}`, color: INK, letterSpacing: "-0.01em" }}>
          {line.split(" ").map((w, j) => {
            const at = delay + k++ * stagger;
            const o = interpolate(f, [at, at + 16], [0, 1], clamp);
            const b = interpolate(f, [at, at + 16], [8, 0], clamp);
            return <span key={j} style={{ opacity: o, filter: `blur(${b}px)`, display: "inline-block", marginRight: "0.26em" }}>{w}</span>;
          })}
        </div>
      ))}
      {by ? (
        <div style={{ marginTop: 34, font: `400 17px ${MONO}`, letterSpacing: "0.14em", textTransform: "uppercase", color: ink(0.55), opacity: interpolate(f, [delay + k * stagger + 6, delay + k * stagger + 24], [0, 1], clamp) }}>
          {by}
        </div>
      ) : null}
    </div>
  );
};

// graded footage with a slow push-in
const Footage: React.FC<{ src: string; len: number; from?: number; to?: number; trim?: number; tint?: boolean; x?: number }> = ({ src, len, from = 1, to = 1.08, trim = 0, tint, x = 0 }) => {
  const f = useCurrentFrame();
  const k = interpolate(f, [0, len], [from, to]);
  return (
    <AbsoluteFill style={{ transform: `scale(${k}) translateX(${x}px)`, opacity: useFade(len, 14, 14) }}>
      <Video src={staticFile(`footage/${src}`)} trimBefore={trim} muted style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      {tint ? <AbsoluteFill style={{ background: SIG, mixBlendMode: "multiply", opacity: 0.55 }} /> : null}
    </AbsoluteFill>
  );
};

// registration marks in the corners of the frame, like a technical plate
const Plate: React.FC<{ label?: string }> = ({ label }) => {
  const m = 64, L = 22, c = ink(0.35);
  const corner = (x: number, y: number, sx: number, sy: number) => (
    <path d={`M${x} ${y + sy * L}V${y}H${x + sx * L}`} stroke={c} strokeWidth={1.5} fill="none" />
  );
  return (
    <AbsoluteFill>
      <svg width={W} height={H} style={{ position: "absolute" }}>
        {corner(m, BAR + 28, 1, 1)}{corner(W - m, BAR + 28, -1, 1)}{corner(m, H - BAR - 28, 1, -1)}{corner(W - m, H - BAR - 28, -1, -1)}
      </svg>
      {label ? <div style={{ position: "absolute", top: BAR + 34, right: 96, font: `400 15px ${MONO}`, letterSpacing: "0.12em", color: ink(0.4), textTransform: "uppercase" }}>{label}</div> : null}
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------- agents & synapses (platform graphics)
type Agent = { id: string; name: string; kind: string; proj: number; x: number; y: number; busy?: boolean };
const PROJECTS = ["ACME-API", "ACME-WEB", "ACME-DOCS", "RESEARCH"];
const AGENTS: Agent[] = [
  { id: "a", name: "CLAUDE-WEB", kind: "claude", proj: 1, x: 640, y: 470, busy: true },
  { id: "b", name: "CODEX-API", kind: "codex", proj: 0, x: 1170, y: 400, busy: true },
  { id: "c", name: "API-REVIEW", kind: "claude", proj: 0, x: 1390, y: 560 },
  { id: "d", name: "GEMINI-DOCS", kind: "gemini", proj: 2, x: 980, y: 760 },
  { id: "e", name: "OPENCODE-INFRA", kind: "opencode", proj: 3, x: 420, y: 760, busy: true },
  { id: "f", name: "WEB-TESTS", kind: "codex", proj: 1, x: 430, y: 390 },
];
const byId = Object.fromEntries(AGENTS.map((a) => [a.id, a]));
const EDGES: [string, string, number][] = [["b", "a", 0], ["c", "b", 22], ["a", "f", 40], ["e", "d", 58], ["d", "a", 76], ["b", "c", 94]];

const Patterns: React.FC = () => (
  <defs>
    <pattern id="p0" width="8" height="8" patternUnits="userSpaceOnUse"><rect width="8" height="8" fill={INK} /></pattern>
    <pattern id="p1" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="7" height="7" fill={BG} /><rect width="1.6" height="7" fill={INK} /></pattern>
    <pattern id="p2" width="6" height="6" patternUnits="userSpaceOnUse"><rect width="6" height="6" fill={BG} /><rect x="1" y="1" width="2" height="2" fill={INK} /></pattern>
    <pattern id="p3" width="8" height="8" patternUnits="userSpaceOnUse"><rect width="8" height="8" fill={BG} /><rect width="8" height="1.4" fill={INK} /><rect width="1.4" height="8" fill={INK} /></pattern>
  </defs>
);

function curve(a: Agent, b: Agent) {
  const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy), ux = dx / L, uy = dy / L, bend = 0.12;
  const cx = (a.x + b.x) / 2 - uy * L * bend, cy = (a.y + b.y) / 2 + ux * L * bend;
  const r = 30;
  return { sx: a.x + ux * r, sy: a.y + uy * r, cx, cy, ex: b.x - ux * (r + 8), ey: b.y - uy * (r + 8), L };
}
const qp = (c: ReturnType<typeof curve>, t: number) => ({
  x: (1 - t) ** 2 * c.sx + 2 * (1 - t) * t * c.cx + t * t * c.ex,
  y: (1 - t) ** 2 * c.sy + 2 * (1 - t) * t * c.cy + t * t * c.ey,
});

// node: square body in its project's shading, outline pulse, orange tick while working
const Node: React.FC<{ a: Agent; f: number; on: number; label?: boolean }> = ({ a, f, on, label = true }) => {
  const R = 24, busy = a.busy;
  const ph = ((f + a.x) % (busy ? 45 : 110)) / (busy ? 45 : 110), e = R + 4 + ph * (busy ? 30 : 18);
  const d = ((f / 48 + a.y / 300) % 1) * 8 * R;
  const pt = d < 2 * R ? [-R + d, -R] : d < 4 * R ? [R, -R + d - 2 * R] : d < 6 * R ? [R - (d - 4 * R), R] : [-R, R - (d - 6 * R)];
  return (
    <g transform={`translate(${a.x} ${a.y}) scale(${0.6 + 0.4 * on})`} opacity={on}>
      <rect x={-e} y={-e} width={e * 2} height={e * 2} fill="none" stroke={INK} strokeOpacity={(1 - ph) * 0.45} />
      <rect x={-R} y={-R} width={R * 2} height={R * 2} fill={`url(#p${a.proj})`} stroke={INK} strokeWidth={1.2} />
      {busy ? <rect x={pt[0] - 4} y={pt[1] - 4} width={8} height={8} fill={SIG} /> : null}
      {label ? (
        <>
          <text y={R + 30} textAnchor="middle" fill={INK} style={{ font: `400 16px ${MONO}`, letterSpacing: "0.06em" }}>{a.name}</text>
          <text y={R + 52} textAnchor="middle" fill={busy ? SIG : ink(0.45)} style={{ font: `400 13px ${MONO}`, letterSpacing: "0.08em" }}>{`${busy ? "■" : "□"} ${a.kind.toUpperCase()} · ${PROJECTS[a.proj]}`}</text>
        </>
      ) : null}
    </g>
  );
};

// isolated terminals: each agent busy in its own pane
const PANE_LINES: Record<string, string[]> = {
  claude: ["> wire the rate limiter into checkout", "● Reading src/checkout/form.tsx", "● I can't see the API changes.", "  Asking you to paste them."],
  codex: ["> add RateLimitError to the client", "• edited api/limits.ts (+48 -3)", "• tests: 14 passed", "  retryAfter is in seconds."],
  gemini: ["> document the new 429 response", "✦ What unit is retryAfter?", "✦ I'll assume milliseconds."],
  opencode: ["> raise the gateway limit", "◆ editing infra/gateway.tf", "◆ plan: 1 to change"],
  cursor: ["> restyle the error banner", "⋯ which error codes exist?", "⋯ guessing 400 and 500"],
  amp: ["> audit auth/session.ts", "∴ token refresh moved?", "∴ unsure, re-reading"],
};
const Terminals: React.FC<{ len: number }> = ({ len }) => {
  const f = useCurrentFrame();
  const kinds = Object.keys(PANE_LINES);
  const collapse = interpolate(f, [len - 40, len - 4], [0, 1], { ...clamp, easing: easeInOut });
  const pw = 520, ph = 250, gx = 40, gy = 40, ox = (W - (pw * 3 + gx * 2)) / 2, oy = (H - (ph * 2 + gy)) / 2;
  return (
    <AbsoluteFill style={{ opacity: useFade(len, 10, 2) }}>
      {kinds.map((k, i) => {
        const x = ox + (i % 3) * (pw + gx), y = oy + Math.floor(i / 3) * (ph + gy);
        const target = AGENTS[i % AGENTS.length];
        const appear = interpolate(f, [i * 5, i * 5 + 16], [0, 1], { ...clamp, easing: easeOut });
        const cw = pw - (pw - 48) * collapse, chh = ph - (ph - 48) * collapse;
        const cx = x + pw / 2 + (target.x - (x + pw / 2)) * collapse, cy = y + ph / 2 + (target.y - (y + ph / 2)) * collapse;
        const lines = PANE_LINES[k];
        return (
          <div key={k} style={{ position: "absolute", left: cx - cw / 2, top: cy - chh / 2, width: cw, height: chh, border: `1px solid ${ink(0.35)}`, background: BG, opacity: appear, overflow: "hidden" }}>
            <div style={{ display: "flex", justifyContent: "space-between", padding: "10px 14px", borderBottom: `1px solid ${ink(0.18)}`, font: `400 13px ${MONO}`, letterSpacing: "0.1em", color: ink(0.6), opacity: 1 - collapse }}>
              <span>{k.toUpperCase()}</span><span style={{ color: ink(0.35) }}>{`PID ${4120 + i * 37}`}</span>
            </div>
            <div style={{ padding: "14px 16px", font: `400 15px/1.75 ${MONO}`, color: INK, opacity: 1 - collapse, whiteSpace: "pre" }}>
              {lines.map((l, j) => {
                const start = 14 + i * 6 + j * 26, n = Math.floor(interpolate(f, [start, start + l.length * 1.1], [0, l.length], clamp));
                return <div key={j} style={{ color: j === 0 ? ink(0.55) : l.includes("?") || l.includes("assume") || l.includes("guess") || l.includes("unsure") || l.includes("can't") ? SIG : INK }}>{l.slice(0, n)}</div>;
              })}
            </div>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};

// the canvas: nodes appear, synapses draw, context travels, projects get frames
const Mesh: React.FC<{ len: number; linkStart: number; framesAt: number }> = ({ len, linkStart, framesAt }) => {
  const f = useCurrentFrame();
  const fade = useFade(len, 2, 18);
  const groups = PROJECTS.map((_, p) => AGENTS.filter((a) => a.proj === p));
  const fo = interpolate(f, [framesAt, framesAt + 20], [0, 1], clamp);
  return (
    <AbsoluteFill style={{ opacity: fade }}>
      <svg width={W} height={H}>
        <Patterns />
        {/* dot grid */}
        {Array.from({ length: 40 }, (_, i) => Array.from({ length: 22 }, (_, j) => (
          <rect key={`${i}-${j}`} x={i * 48 + 24} y={j * 48 + 24} width={1.6} height={1.6} fill={ink(0.12)} />
        )))}
        {/* project frames */}
        {groups.map((g, p) => {
          if (!g.length) return null;
          const x0 = Math.min(...g.map((a) => a.x)) - 120, x1 = Math.max(...g.map((a) => a.x)) + 120;
          const y0 = Math.min(...g.map((a) => a.y)) - 70, y1 = Math.max(...g.map((a) => a.y)) + 92;
          return (
            <g key={p} opacity={fo}>
              <rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} fill={ink(0.025)} stroke={ink(0.28)} />
              <rect x={x0} y={y0 - 28} width={PROJECTS[p].length * 10.5 + 64} height={28} fill={BG} stroke={ink(0.28)} />
              <rect x={x0 + 10} y={y0 - 19} width={10} height={10} fill={`url(#p${p})`} stroke={INK} />
              <text x={x0 + 30} y={y0 - 9} fill={INK} style={{ font: `400 14px ${MONO}`, letterSpacing: "0.06em" }}>{`${PROJECTS[p]}  ${g.length}`}</text>
            </g>
          );
        })}
        {/* synapses */}
        {EDGES.map(([fa, ta, at], i) => {
          const c = curve(byId[fa], byId[ta]), t0 = linkStart + at, g = interpolate(f, [t0, t0 + 22], [0, 1], { ...clamp, easing: easeInOut });
          if (g <= 0) return null;
          const path = `M${c.sx} ${c.sy}Q${c.cx} ${c.cy} ${c.ex} ${c.ey}`;
          const hot = interpolate(f, [t0 + 22, t0 + 50], [1, 0], clamp);
          const end = qp(c, 1), pre = qp(c, 0.97), ang = Math.atan2(end.y - pre.y, end.x - pre.x) * 180 / Math.PI;
          return (
            <g key={i}>
              <path d={path} fill="none" stroke={hot > 0.05 ? SIG : INK} strokeOpacity={0.5 + hot * 0.5} strokeWidth={1.5 + hot} pathLength={1} strokeDasharray="1 1" strokeDashoffset={1 - g} />
              {g >= 1 ? <path d="M3 0 L-9 -6 L-9 6 Z" fill={hot > 0.05 ? SIG : INK} transform={`translate(${end.x} ${end.y}) rotate(${ang})`} /> : null}
              {g >= 1 ? [0, 1, 2].map((k) => {
                const u = ((f - t0) / 70 + k / 3) % 1, p = qp(c, u);
                return <rect key={k} x={p.x - 4} y={p.y - 4} width={8} height={8} fill={INK} stroke={BG} strokeWidth={2} opacity={Math.sin(u * Math.PI)} />;
              }) : null}
            </g>
          );
        })}
        {AGENTS.map((a, i) => <Node key={a.id} a={a} f={f} on={interpolate(f, [i * 4, i * 4 + 14], [0, 1], { ...clamp, easing: easeOut })} />)}
      </svg>
    </AbsoluteFill>
  );
};

// the terminal line Claude Code prints when context arrives
const TermLine: React.FC<{ len: number }> = ({ len }) => {
  const f = useCurrentFrame();
  const rows: [string, string][] = [
    ["~/acme-web $ claude", ink(0.5)],
    ["synapse  ⇠ reads codex-api  ·  ⇢ shares with web-tests", SIG],
    ["", INK],
    ["> wire the rate limiter into checkout", INK],
    ["synapse  ⇢ pulled context from codex-api (13 msgs, 3.4k chars)", SIG],
    ["✉ 1 message from api-review", SIG],
    ["", INK],
    ["● Codex already landed RateLimitError with retryAfter in seconds.", INK],
    ["  Surfacing it in the form instead of a generic error.", INK],
  ];
  return (
    <AbsoluteFill style={{ opacity: useFade(len, 10, 12), justifyContent: "center", alignItems: "center" }}>
      <div style={{ width: 1240, border: `1px solid ${ink(0.35)}`, background: BG, transform: `scale(${interpolate(f, [0, len], [1, 1.04])})` }}>
        <div style={{ padding: "12px 18px", borderBottom: `1px solid ${ink(0.18)}`, font: `400 14px ${MONO}`, letterSpacing: "0.1em", color: ink(0.5) }}>CLAUDE CODE · ACME-WEB</div>
        <div style={{ padding: "22px 26px", font: `400 22px/1.7 ${MONO}`, whiteSpace: "pre" }}>
          {rows.map(([t, c], i) => {
            const st = 4 + i * 9, n = Math.floor(interpolate(f, [st, st + Math.max(4, t.length * 0.45)], [0, t.length], clamp));
            return <div key={i} style={{ color: c, minHeight: "1.7em" }}>{t.slice(0, n)}{i === rows.length - 1 && n === t.length && Math.floor(f / 15) % 2 ? "▍" : ""}</div>;
          })}
        </div>
      </div>
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------- the entity
// The sagittal MRI slice resampled into a halftone of square dots. The dots fly in from the
// agents' positions, so the network literally assembles into a brain; orange signal waves
// then travel through it.
type Dot = { x: number; y: number; b: number; sx: number; sy: number; d: number };
function useBrainDots(step: number) {
  const [dots, setDots] = useState<Dot[] | null>(null);
  const [handle] = useState(() => delayRender("brain dots"));
  useLayoutEffect(() => {
    const img = new Image();
    img.onload = () => {
      const cw = 1560, ch = Math.round((img.height / img.width) * cw);
      const c = document.createElement("canvas"); c.width = cw; c.height = ch;
      const x = c.getContext("2d")!; x.drawImage(img, 0, 0, cw, ch);
      const px = x.getImageData(0, 0, cw, ch).data, out: Dot[] = [];
      const ox = (W - cw) / 2, oy = (H - ch) / 2 - 50;
      for (let j = 0; j < ch; j += step) for (let i = 0; i < cw; i += step) {
        const b = px[(j * cw + i) * 4] / 255;
        if (b < 0.16) continue;
        const k = out.length, src = AGENTS[k % AGENTS.length];
        out.push({ x: ox + i, y: oy + j, b, sx: src.x + (random(`x${k}`) - 0.5) * 60, sy: src.y + (random(`y${k}`) - 0.5) * 60, d: random(`d${k}`) });
      }
      setDots(out); continueRender(handle);
    };
    img.onerror = () => continueRender(handle);
    img.src = staticFile("footage/brain-sagittal.png");
  }, [handle, step]);
  return dots;
}
const Entity: React.FC<{ len: number; assemble?: number; hold?: boolean; dim?: number; waves?: boolean }> = ({ len, assemble = 90, hold, dim = 1, waves: showWaves = true }) => {
  const f = useCurrentFrame();
  const ref = useRef<HTMLCanvasElement>(null);
  const dots = useBrainDots(8);
  const fade = useFade(len, hold ? 1 : 14, 16);
  useLayoutEffect(() => {
    const cv = ref.current; if (!cv || !dots) return;
    const ctx = cv.getContext("2d")!; ctx.clearRect(0, 0, W, H);
    // thin signal fronts spreading from three points, like action potentials crossing the cortex
    const waves = showWaves ? [0, 1, 2].map((k) => ({ cx: W * (0.38 + 0.12 * k), cy: H * (0.4 + 0.07 * Math.sin(k * 2)), r: ((f * 7 + k * 420) % 1100) })) : [];
    for (const d of dots) {
      const t = hold ? 1 : interpolate(f, [d.d * assemble * 0.6, d.d * assemble * 0.6 + assemble * 0.4], [0, 1], { ...clamp, easing: easeInOut });
      const x = d.sx + (d.x - d.sx) * t, y = d.sy + (d.y - d.sy) * t;
      let wave = 0;
      for (const w of waves) { const dd = Math.abs(Math.hypot(x - w.cx, y - w.cy) - w.r); if (dd < 16) wave = Math.max(wave, (1 - dd / 16) * (1 - w.r / 1100)); }
      const size = Math.max(1, Math.round(d.b * 4) * 1.6) * (1 + wave * 0.4);
      ctx.fillStyle = wave > 0.3 && t > 0.98 ? `rgba(255,90,31,${Math.min(1, wave * 1.4) * dim})` : ink((0.3 + d.b * 0.6) * dim);
      ctx.fillRect(x - size / 2, y - size / 2, size, size);
    }
  }, [f, dots, assemble, hold, dim, showWaves]);
  return <AbsoluteFill style={{ opacity: fade }}><canvas ref={ref} width={W} height={H} style={{ width: W, height: H }} /></AbsoluteFill>;
};

// ---------------------------------------------------------------- finale
const Title: React.FC<{ len: number }> = ({ len }) => {
  const f = useCurrentFrame();
  const letters = "SYNAPSE".split("");
  const sub = interpolate(f, [60, 80], [0, 1], clamp);
  const kinds = interpolate(f, [120, 140], [0, 1], clamp);
  const soon = interpolate(f, [175, 190], [0, 1], clamp);
  const url = interpolate(f, [235, 255], [0, 1], clamp);
  const out = interpolate(f, [len - 30, len], [1, 0], clamp);
  return (
    <AbsoluteFill style={{ opacity: out }}>
      <div style={{ position: "absolute", top: BAR + 60, left: 0, right: 0, textAlign: "center", font: `200 360px/0.8 ${DISPLAY}`, color: INK, letterSpacing: "0.01em" }}>
        {letters.map((l, i) => {
          const t = interpolate(f, [i * 3, i * 3 + 26], [0, 1], { ...clamp, easing: easeOut });
          return <span key={i} style={{ display: "inline-block", clipPath: `inset(${(1 - t) * 100}% 0 0 0)`, transform: `translateY(${(1 - t) * 60}px)` }}>{l}</span>;
        })}
      </div>
      <div style={{ position: "absolute", top: BAR + 400, left: 0, right: 0, textAlign: "center" }}>
        <div style={{ font: `italic 300 48px ${SERIF}`, color: INK, opacity: sub, filter: `blur(${(1 - sub) * 6}px)` }}>A nervous system for your agents.</div>
        <div style={{ marginTop: 28, font: `400 17px ${MONO}`, letterSpacing: "0.16em", color: ink(0.55), opacity: kinds }}>CLAUDE CODE · CODEX · GEMINI · OPENCODE · CURSOR · AMP · COPILOT</div>
        <div style={{ marginTop: 22, font: `400 17px ${MONO}`, letterSpacing: "0.16em", color: SIG, opacity: soon }}>■ MULTIPLAYER, COMING SOON</div>
        <div style={{ marginTop: 34, font: `400 22px ${MONO}`, letterSpacing: "0.08em", color: INK, opacity: url }}>heysynapse.vercel.app</div>
      </div>
    </AbsoluteFill>
  );
};

const Credits: React.FC<{ len: number }> = ({ len }) => {
  const rows: [string, string][] = [
    ["MUSIC", "Antonio Vivaldi, Winter (Allegro non molto). Performed by the United States Air Force Band. Public domain."],
    ["MRI", "Edlow B.L. et al., Massachusetts General Hospital: 7 Tesla MRI of the ex vivo human brain at 100 µm. CC0."],
    ["TRACTOGRAPHY", "jgmarcelino: Axonal nerve fibers in a brain. CC BY 2.0."],
    ["CONNECTOME", "Gong H. et al., Nature Communications (2016): brain-wide connectome imaging. CC BY 4.0."],
    ["INNERVATION", "Doerr J. et al., Nature Communications (2017): whole-brain mapping of neural transplant innervation. CC BY 4.0."],
    ["", "Footage via Wikimedia Commons; graded to monochrome, cropped and retimed."],
  ];
  return (
    <AbsoluteFill style={{ opacity: useFade(len, 12, 14), justifyContent: "center", alignItems: "center" }}>
      <div style={{ width: 1300 }}>
        {rows.map(([k, v], i) => (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "200px 1fr", gap: 24, padding: "11px 0", borderTop: i ? `1px solid ${ink(0.14)}` : "none", font: `400 16px/1.5 ${MONO}`, color: ink(0.7) }}>
            <span style={{ color: ink(0.4), letterSpacing: "0.12em" }}>{k}</span><span>{v}</span>
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------- frame furniture
const Grain: React.FC = () => {
  const f = useCurrentFrame();
  const seed = f % 8;
  return (
    <AbsoluteFill style={{ pointerEvents: "none", mixBlendMode: "overlay", opacity: 0.22 }}>
      <svg width={W} height={H}>
        <filter id={`g${seed}`}><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves={2} seed={seed} stitchTiles="stitch" /><feColorMatrix values="0 0 0 0 .5 0 0 0 0 .5 0 0 0 0 .5 0 0 0 1.4 -.2" /></filter>
        <rect width={W} height={H} filter={`url(#g${seed})`} />
      </svg>
    </AbsoluteFill>
  );
};
const Letterbox: React.FC = () => (
  <AbsoluteFill style={{ pointerEvents: "none" }}>
    <div style={{ position: "absolute", left: 0, right: 0, top: 0, height: BAR, background: "#000" }} />
    <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: BAR, background: "#000" }} />
    <AbsoluteFill style={{ background: "radial-gradient(ellipse 75% 70% at 50% 50%, transparent 55%, rgba(0,0,0,.55))" }} />
  </AbsoluteFill>
);
// a one-frame white flash on hard cuts during the tutti
const Flash: React.FC = () => {
  const f = useCurrentFrame();
  return <AbsoluteFill style={{ background: INK, opacity: interpolate(f, [0, 3], [0.35, 0], clamp) }} />;
};

// ---------------------------------------------------------------- timeline (seconds, timed to the music)
// 0-52 the long build in the strings, 53-60 the quiet dip, 61-76 the tutti, then out.
const Seq: React.FC<{ at: number; to: number; children: React.ReactNode }> = ({ at, to, children }) => (
  <Sequence from={s(at)} durationInFrames={s(to) - s(at)} layout="none">{children}</Sequence>
);
const len = (a: number, b: number) => s(b) - s(a);

export const Cinematic: React.FC = () => {
  useFonts();
  const cuts = [61, 62.4, 63.6, 64.8];
  return (
    <AbsoluteFill style={{ background: BG }}>
      <Audio src={staticFile("music/winter-usaf.mp3")} volume={(f) => interpolate(f, [0, 12, s(76), s(81)], [0, 1, 1, 0], clamp)} />

      {/* I. the brain */}
      <Seq at={0} to={6.6}>
        <Plate label="Synapse · a study in connection" />
        <Quote delay={22} stagger={5} size={60} lines={["“The brain is a world consisting of a number", "of unexplored continents and great stretches", "of unknown territory.”"]} by="Santiago Ramón y Cajal" />
      </Seq>
      <Seq at={6.6} to={13.2}>
        <Footage src="mri-axial.mp4" len={len(6.6, 13.2)} from={1.02} to={1.1} trim={30} />
        <Count to={86_000_000_000} label="Neurons in a human brain" delay={14} dur={80} />
        <Caption fig="Fig.1" text="Human brain, 7 Tesla MRI, 100 microns" />
      </Seq>
      <Seq at={13.2} to={19.6}>
        <Footage src="axons.mp4" len={len(13.2, 19.6)} from={1.05} to={1.14} />
        <Count to={100} label="Trillion synapses between them" delay={10} dur={60} right />
        <Caption fig="Fig.2" text="White matter tractography" />
      </Seq>
      <Seq at={19.6} to={25.6}>
        <Footage src="connectome.mp4" len={len(19.6, 25.6)} from={1.0} to={1.1} trim={90} />
        <AbsoluteFill style={{ background: "rgba(0,0,0,.35)" }} />
        <Quote delay={20} lines={["No neuron thinks alone."]} size={84} />
        <Caption fig="Fig.3" text="Mouse cortex, single-neuron resolution" delay={4} />
      </Seq>

      {/* II. the problem */}
      <Seq at={25.6} to={33.2}>
        <Terminals len={len(25.6, 33.2)} />
        <Sequence from={s(1.8)} durationInFrames={s(3.6)} layout="none">
          <Dim />
          <Quote delay={2} lines={["Your agents still do."]} size={84} />
        </Sequence>
        <Caption fig="Fig.4" text="Six agents, six terminals, no shared context" delay={6} />
      </Seq>

      {/* III. synapse */}
      <Seq at={33.2} to={48.2}>
        <Mesh len={len(33.2, 48.2)} linkStart={s(5.6)} framesAt={s(10)} />
        <Sequence from={0} durationInFrames={s(5.4)} layout="none">
          <Quote delay={8} lines={["“Neurons that fire together, wire together.”"]} by="After Donald Hebb, 1949" size={60} y={BAR + 60} />
        </Sequence>
        <Plate label="Fig.5 · Synapse canvas · live" />
      </Seq>
      <Seq at={48.2} to={53.2}>
        <TermLine len={len(48.2, 53.2)} />
      </Seq>

      {/* IV. the entity, in the quiet dip */}
      <Seq at={53.2} to={61}>
        <Entity len={len(53.2, 61)} assemble={s(4.2)} />
        <Quote delay={s(3.6)} lines={["We are building a nervous system", "for machines."]} size={56} y={H - BAR - 165} />
      </Seq>

      {/* V. the tutti: hard cuts, then the title */}
      <Seq at={cuts[0]} to={cuts[1]}><Footage src="mri-coronal.mp4" len={len(cuts[0], cuts[1])} from={1.15} to={1.22} trim={40} /><Flash /></Seq>
      <Seq at={cuts[1]} to={cuts[2]}><Mesh len={len(cuts[1], cuts[2])} linkStart={-200} framesAt={-100} /><Flash /></Seq>
      <Seq at={cuts[2]} to={cuts[3]}><Footage src="glow.mp4" len={len(cuts[2], cuts[3])} from={1.1} to={1.2} tint /><Flash /></Seq>
      <Seq at={cuts[3]} to={66}><Footage src="axons.mp4" len={len(cuts[3], 66)} from={1.3} to={1.45} trim={200} /><Flash /></Seq>
      <Seq at={66} to={79}>
        <Entity len={len(66, 79)} hold dim={0.22} />
        <Title len={len(66, 79)} />
        <Flash />
      </Seq>

      <Seq at={79.4} to={84}><Credits len={len(79.4, 84)} /></Seq>

      <Letterbox />
      <Grain />
    </AbsoluteFill>
  );
};

// darkens whatever is behind a nested quote, fading in over 6 frames
const Dim: React.FC = () => {
  const f = useCurrentFrame();
  return <AbsoluteFill style={{ background: "rgba(11,11,11,.72)", opacity: interpolate(f, [0, 6], [0, 1], clamp) }} />;
};

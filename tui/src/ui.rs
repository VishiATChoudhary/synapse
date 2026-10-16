// Rendering. One ink on paper, orange for live state, project colours for frames.

use ratatui::{
    buffer::Buffer,
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph},
    Frame,
};

use crate::app::{App, Overlay, PromptKind, PROFILES};
use crate::model::{Row, Status, CARD_H};

pub const INK: Color = Color::Rgb(0x16, 0x13, 0x0F);
pub const PAPER: Color = Color::Rgb(0xF1, 0xEF, 0xE9);
pub const MUTED: Color = Color::Rgb(0x8A, 0x86, 0x7E);
pub const ORANGE: Color = Color::Rgb(0xFF, 0x44, 0x00);
pub const CARD: Color = Color::Rgb(0xFF, 0xF2, 0xB3); // the sticky-note yellow from the sketch

fn status_style(s: Status) -> Style {
    match s {
        Status::Working => Style::default().fg(ORANGE).add_modifier(Modifier::BOLD),
        Status::Waiting => Style::default().fg(ORANGE),
        Status::Idle => Style::default().fg(MUTED),
        Status::Shell => Style::default().fg(MUTED),
        Status::Exited => Style::default().fg(MUTED).add_modifier(Modifier::DIM),
    }
}

pub fn draw(f: &mut Frame, app: &mut App) {
    let area = f.area();
    app.hits = Default::default();
    let small = area.width < 80 || area.height < 24;
    let show_sidebar = app.sidebar && !small;

    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(5), Constraint::Length(1)])
        .split(area);
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints(if show_sidebar { [Constraint::Length(24), Constraint::Min(30)] } else { [Constraint::Length(0), Constraint::Min(30)] })
        .split(rows[0]);

    if show_sidebar {
        sidebar(f, app, cols[0]);
    }
    let main = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(if small { 1 } else { CARD_H }), Constraint::Min(3)])
        .split(cols[1]);
    header(f, app, main[0], small);
    pane(f, app, main[1]);
    status_line(f, app, rows[1]);

    match &app.overlay {
        Overlay::None => {}
        Overlay::FanOut { .. } => fan_out(f, app, main[1]),
        Overlay::Picker { .. } => picker(f, app, area),
        Overlay::Prompt { .. } => prompt(f, app, area),
        Overlay::Help => help(f, area),
        Overlay::Quit => quit(f, app, area),
        Overlay::Synapse => synapse(f, app, area),
    }
}

fn sidebar(f: &mut Frame, app: &mut App, area: Rect) {
    let block = Block::default().borders(Borders::RIGHT).border_style(Style::default().fg(MUTED));
    let inner = block.inner(area);
    f.render_widget(block, area);

    let mut lines: Vec<Line> = vec![Line::from(Span::styled(" projects", Style::default().fg(MUTED)))];
    let mut hits = Vec::new();
    let rows = app.model.rows();
    let mut slot_n = 0;
    for row in rows {
        let y = inner.y + lines.len() as u16;
        if y >= inner.y + inner.height - 4 { break; }
        let line = match row {
            Row::Project(id) => {
                let p = app.model.project(id).unwrap();
                Line::from(vec![
                    Span::styled(if p.open { " ▾ " } else { " ▸ " }, Style::default().fg(MUTED)),
                    Span::styled("▮ ", Style::default().fg(p.color)),
                    Span::styled(p.label.clone(), Style::default().add_modifier(Modifier::BOLD)),
                ])
            }
            Row::Worktree(id) => {
                let w = app.model.worktree(id).unwrap();
                Line::from(vec![Span::styled("   ⎇ ", Style::default().fg(MUTED)), Span::raw(w.name.clone())])
            }
            Row::Slot(id) => {
                slot_n += 1;
                let s = app.model.slot(id).unwrap();
                let top = s.top();
                let (glyph, st, title) = top.map(|t| (t.status.glyph(), t.status, t.kind.clone())).unwrap_or(("✗", Status::Exited, "gone".into()));
                let focused = id == app.model.focused;
                let depth = if s.depth() > 1 { format!(" ⑂{}", s.depth()) } else { String::new() };
                let mut spans = vec![
                    Span::styled(format!("{slot_n:>2} "), Style::default().fg(MUTED)),
                    Span::styled(format!("{glyph} "), status_style(st)),
                    Span::styled(title, if focused { Style::default().add_modifier(Modifier::BOLD | Modifier::REVERSED) } else { Style::default() }),
                    Span::styled(depth, Style::default().fg(ORANGE)),
                ];
                if focused { spans.insert(0, Span::styled("▍", Style::default().fg(ORANGE))); } else { spans.insert(0, Span::raw(" ")); }
                Line::from(spans)
            }
        };
        hits.push((Rect::new(inner.x, y, inner.width, 1), row));
        lines.push(line);
    }
    app.hits.sidebar_rows = hits;
    f.render_widget(Paragraph::new(lines), inner);

    // synapse strip for the focused slot
    let strip = Rect::new(inner.x, inner.y + inner.height - 4, inner.width, 4);
    let kind = app.model.focused_slot().and_then(|s| s.top()).map(|t| t.kind.clone()).unwrap_or_default();
    let strip_lines = if kind == "shell" {
        vec![Line::from(Span::styled(" ◉ synapse", Style::default().fg(MUTED))), Line::from(Span::styled("   shells have no peers", Style::default().fg(MUTED)))]
    } else {
        vec![
            Line::from(Span::styled(" ◉ synapse", Style::default().fg(MUTED))),
            Line::from(vec![Span::styled("   ⇠ ", Style::default().fg(MUTED)), Span::raw("codex-promo")]),
            Line::from(vec![Span::styled("   ⇢ ", Style::default().fg(MUTED)), Span::raw("claude-main")]),
            Line::from(vec![Span::styled("   ✉ ", Style::default().fg(ORANGE)), Span::styled("1 from codex-promo", Style::default().fg(ORANGE))]),
        ]
    };
    f.render_widget(Paragraph::new(strip_lines), strip);
}

// The stack of the focused slot as cards. Top of stack rightmost and raised.
fn header(f: &mut Frame, app: &mut App, area: Rect, small: bool) {
    app.hits.header = area;
    let slot = match app.model.focused_slot() { Some(s) => s, None => return };
    let color = app.model.project_of_slot(slot.id).map(|p| p.color).unwrap_or(MUTED);
    let path = slot.path.clone();
    let mut x = area.x + 1;
    let mut hits = Vec::new();
    let buf = f.buffer_mut();
    for (i, id) in path.iter().enumerate() {
        let s = match slot.session(*id) { Some(s) => s, None => continue };
        let is_top = i + 1 == path.len();
        let label = if i == 0 { format!(" {} {} ", s.status.glyph(), s.title) } else { format!(" {} {} ", s.status.glyph(), slot.label(*id)) };
        let w = (label.chars().count() as u16 + 2).min(area.width.saturating_sub(x - area.x + 1));
        if w < 4 { break; }
        let r = if small { Rect::new(x, area.y, w, 1) } else { Rect::new(x, area.y, w, CARD_H) };
        card(buf, r, &label, is_top, color, s.status, small);
        hits.push((r, *id));
        if i + 1 < path.len() {
            buf.set_string(x + w, area.y + if small { 0 } else { 1 }, "›", Style::default().fg(MUTED));
        }
        x += w + 1;
    }
    if path.len() > 1 {
        let tag = format!(" ⑂ {} deep · hover or ⌃Space f to fan out ", path.len());
        let tw = tag.chars().count() as u16;
        if x + tw < area.x + area.width {
            buf.set_string(area.x + area.width - tw, area.y + if small { 0 } else { 1 }, tag, Style::default().fg(MUTED));
        }
    }
    app.hits.header_cards = hits;
}

fn card(buf: &mut Buffer, r: Rect, label: &str, top: bool, color: Color, st: Status, small: bool) {
    let style = if top { Style::default().fg(INK).bg(CARD).add_modifier(Modifier::BOLD) } else { Style::default().fg(MUTED).bg(PAPER) };
    if small {
        buf.set_string(r.x, r.y, format!("[{label}]"), style);
        return;
    }
    let border = Style::default().fg(if top { color } else { MUTED });
    buf.set_string(r.x, r.y, format!("╭{}╮", "─".repeat(r.width as usize - 2)), border);
    buf.set_string(r.x, r.y + 1, "│", border);
    let text: String = label.chars().take(r.width as usize - 2).collect();
    buf.set_string(r.x + 1, r.y + 1, &text, style);
    let g = st.glyph();
    buf.set_string(r.x + 2, r.y + 1, g, status_style(st).bg(if top { CARD } else { PAPER }));
    buf.set_string(r.x + r.width - 1, r.y + 1, "│", border);
    buf.set_string(r.x, r.y + 2, format!("╰{}╯", "─".repeat(r.width as usize - 2)), border);
}

fn pane(f: &mut Frame, app: &mut App, area: Rect) {
    app.hits.pane = area;
    let slot = match app.model.focused_slot() { Some(s) => s, None => return };
    let color = app.model.project_of_slot(slot.id).map(|p| p.color).unwrap_or(MUTED);
    let block = Block::default().borders(Borders::ALL).border_style(Style::default().fg(color));
    let inner = block.inner(area);
    f.render_widget(block, area);
    let s = match slot.top() { Some(s) => s, None => return };

    let h = inner.height as usize;
    let input_h = if s.status == Status::Shell { 0 } else { 3 };
    let body_h = h.saturating_sub(input_h);
    let start = s.lines.len().saturating_sub(body_h);
    let mut lines: Vec<Line> = s.lines[start..].iter().map(|l| {
        let st = if l.starts_with("synapse") { Style::default().fg(ORANGE) } else if l.starts_with('>') || l.starts_with('›') { Style::default().add_modifier(Modifier::BOLD) } else { Style::default() };
        Line::from(Span::styled(l.clone(), st))
    }).collect();
    if s.status == Status::Shell {
        if let Some(last) = lines.last_mut() {
            last.spans.push(Span::raw(s.input.clone()));
            last.spans.push(Span::styled("▍", Style::default().fg(ORANGE)));
        }
    }
    f.render_widget(Paragraph::new(lines), Rect::new(inner.x, inner.y, inner.width, body_h as u16));

    if input_h > 0 {
        let r = Rect::new(inner.x, inner.y + body_h as u16, inner.width, 3);
        let b = Block::default().borders(Borders::ALL).border_style(Style::default().fg(MUTED));
        let ir = b.inner(r);
        f.render_widget(b, r);
        let hint = if s.input.is_empty() { Span::styled("  type here · /sfork <question> forks this session", Style::default().fg(MUTED)) } else { Span::raw(format!(" {}", s.input)) };
        f.render_widget(Paragraph::new(Line::from(vec![Span::styled(">", Style::default().fg(ORANGE)), hint, Span::styled("▍", Style::default().fg(ORANGE))])), ir);
    }
}

fn status_line(f: &mut Frame, app: &App, area: Rect) {
    let line = if let Some((msg, _)) = &app.flash {
        Line::from(Span::styled(format!(" {msg}"), Style::default().fg(ORANGE)))
    } else if app.leader {
        Line::from(vec![
            Span::styled(" ⌃Space ", Style::default().fg(PAPER).bg(ORANGE).add_modifier(Modifier::BOLD)),
            Span::styled("  n new agent  t shell  w worktree  F fork  f fan-out  ⌫ pop  g synapse  j/k move  1-9 jump  x close  b sidebar  ? help  q quit", Style::default()),
        ])
    } else {
        Line::from(vec![
            Span::styled(" ⌃Space ", Style::default().fg(MUTED).add_modifier(Modifier::BOLD)),
            Span::styled("leader   keys go to the session   mouse: click sidebar or cards, hover cards to fan out", Style::default().fg(MUTED)),
        ])
    };
    f.render_widget(Paragraph::new(line), area);
}

fn centered(area: Rect, w: u16, h: u16) -> Rect {
    let w = w.min(area.width);
    let h = h.min(area.height);
    Rect::new(area.x + (area.width - w) / 2, area.y + (area.height - h) / 2, w, h)
}

fn modal(f: &mut Frame, area: Rect, title: &str) -> Rect {
    f.render_widget(Clear, area);
    let b = Block::default().borders(Borders::ALL).border_style(Style::default().fg(ORANGE)).title(format!(" {title} "));
    let inner = b.inner(area);
    f.render_widget(b, area);
    inner
}

fn fan_out(f: &mut Frame, app: &mut App, area: Rect) {
    let sel = if let Overlay::FanOut { sel } = app.overlay { sel } else { return };
    let slot = match app.model.focused_slot() { Some(s) => s, None => return };
    let color = app.model.project_of_slot(slot.id).map(|p| p.color).unwrap_or(MUTED);
    let (nodes, tw, th) = slot.layout();
    let inner = modal(f, area, "⑂ fork tree · ←↑↓→ move · Enter bring to front · d close · Esc");
    let ox = inner.x + inner.width.saturating_sub(tw) / 2;
    let oy = inner.y + inner.height.saturating_sub(th) / 2;
    let buf = f.buffer_mut();
    let mut hits = Vec::new();
    // connectors first, cards on top: one bar per parent spanning its children
    let line = Style::default().fg(MUTED);
    let put = |buf: &mut Buffer, x: u16, y: u16, ch: &str| {
        if x < inner.x + inner.width && y < inner.y + inner.height { buf.set_string(x, y, ch, line); }
    };
    for p in &nodes {
        let kids: Vec<&crate::model::Placed> = nodes.iter().filter(|n| slot.session(n.id).and_then(|s| s.parent) == Some(p.id)).collect();
        if kids.is_empty() { continue; }
        let px = ox + p.x + p.w / 2;
        let y = oy + p.y + CARD_H; // the gap row under the parent
        let centres: Vec<u16> = kids.iter().map(|k| ox + k.x + k.w / 2).collect();
        let (lo, hi) = (*centres.iter().min().unwrap(), *centres.iter().max().unwrap());
        for x in lo..=hi { put(buf, x, y, "─"); }
        for (i, cx) in centres.iter().enumerate() {
            let ch = if centres.len() == 1 { "│" } else if i == 0 { "╭" } else if i + 1 == centres.len() { "╮" } else { "┬" };
            put(buf, *cx, y, ch);
            put(buf, *cx, y + 1, "┴"); // into the child's top border
        }
        if centres.len() > 1 {
            put(buf, px, y, if centres.contains(&px) { "┼" } else { "┴" });
        }
        put(buf, px, y - 1, "┬"); // out of the parent's bottom border
    }
    for n in &nodes {
        let r = Rect::new(ox + n.x, oy + n.y, n.w, CARD_H);
        if r.x + r.width > inner.x + inner.width || r.y + r.height > inner.y + inner.height { continue; }
        let s = slot.session(n.id).unwrap();
        let on_path = slot.path.contains(&n.id);
        let label = format!(" {} {}", s.status.glyph(), slot.label(n.id));
        card(buf, r, &label, n.id == sel, if on_path { color } else { MUTED }, s.status, false);
        if n.id == sel {
            buf.set_string(r.x, r.y + 2, format!("╰{}╯", "─".repeat(r.width as usize - 2)), Style::default().fg(ORANGE));
            buf.set_string(r.x, r.y, format!("╭{}╮", "─".repeat(r.width as usize - 2)), Style::default().fg(ORANGE));
        }
        let cx = r.x + r.width / 2;
        if s.parent.is_some() { buf.set_string(cx, r.y, "┴", Style::default().fg(MUTED)); }
        if !slot.children(n.id).is_empty() { buf.set_string(cx, r.y + 2, "┬", Style::default().fg(MUTED)); }
        hits.push((r, n.id));
    }
    app.hits.fan_nodes = hits;
    if let Some(s) = slot.session(sel) {
        let info = format!(" {} · {} · {} ", s.kind, s.status.glyph(), s.question.as_deref().unwrap_or("root session"));
        buf.set_string(inner.x + 1, inner.y + inner.height - 1, info, Style::default().fg(MUTED));
    }
}

fn picker(f: &mut Frame, app: &App, area: Rect) {
    let sel = if let Overlay::Picker { sel } = app.overlay { sel } else { return };
    let r = centered(area, 60, PROFILES.len() as u16 + 4);
    let inner = modal(f, r, "new session · profiles from ~/.synapse/tui.json");
    let wt = app.model.focused_worktree().and_then(|w| app.model.worktree(w)).map(|w| w.name.clone()).unwrap_or_default();
    let mut lines = vec![Line::from(Span::styled(format!(" in worktree {wt}"), Style::default().fg(MUTED)))];
    for (i, (name, cmd)) in PROFILES.iter().enumerate() {
        let st = if i == sel { Style::default().fg(INK).bg(CARD).add_modifier(Modifier::BOLD) } else { Style::default() };
        lines.push(Line::from(vec![Span::styled(format!(" {name:<13}"), st), Span::styled(format!(" {cmd}"), Style::default().fg(MUTED))]));
    }
    f.render_widget(Paragraph::new(lines), inner);
}

fn prompt(f: &mut Frame, app: &App, area: Rect) {
    let (kind, buf) = if let Overlay::Prompt { kind, buf } = &app.overlay { (*kind, buf) } else { return };
    let title = match kind {
        PromptKind::Fork => "⑂ fork: what do you want to dig into?",
        PromptKind::Worktree => "new worktree: branch name",
        PromptKind::Project => "add project: path",
    };
    let r = centered(area, 70, 3);
    let inner = modal(f, r, title);
    f.render_widget(Paragraph::new(Line::from(vec![Span::raw(format!(" {buf}")), Span::styled("▍", Style::default().fg(ORANGE))])), inner);
}

fn help(f: &mut Frame, area: Rect) {
    let r = centered(area, 66, 20);
    let inner = modal(f, r, "help");
    let rows = [
        ("⌃Space", "leader. Everything else goes straight to the session"),
        ("n / t", "new agent (profile picker) / new shell in this worktree"),
        ("w / W", "new worktree / remove worktree"),
        ("p", "add a project"),
        ("F", "fork the focused session with a question"),
        ("f", "fan out the fork tree (also: hover the cards)"),
        ("⌫", "pop the top card, parent comes back"),
        ("g", "synapse view: peers, links, messages"),
        ("j k 1-9", "move focus / jump to slot"),
        ("x", "close focused slot"),
        ("b", "toggle sidebar"),
        ("q", "quit (confirms if sessions run)"),
        ("", ""),
        ("in session", "/sfork <question> forks without touching the parent's context"),
        ("in fork", "say \"send back\": child summarises to parent via synapse send"),
    ];
    let lines: Vec<Line> = rows.iter().map(|(k, v)| Line::from(vec![Span::styled(format!(" {k:<11}"), Style::default().fg(ORANGE).add_modifier(Modifier::BOLD)), Span::raw(*v)])).collect();
    f.render_widget(Paragraph::new(lines), inner);
}

fn quit(f: &mut Frame, app: &App, area: Rect) {
    let running = app.model.slots.iter().flat_map(|s| s.sessions.iter()).filter(|s| s.status == Status::Working).count();
    let r = centered(area, 50, 4);
    let inner = modal(f, r, "quit?");
    let lines = vec![
        Line::from(format!(" {running} session(s) still working. They end with the TUI.")),
        Line::from(Span::styled(" y / Enter quit · anything else stays", Style::default().fg(MUTED))),
    ];
    f.render_widget(Paragraph::new(lines), inner);
}

fn synapse(f: &mut Frame, app: &App, area: Rect) {
    let r = centered(area, 78, 18);
    let inner = modal(f, r, "◉ synapse · l link · i in · o out · u unlink · s send · Esc");
    let cols = Layout::default().direction(Direction::Horizontal).constraints([Constraint::Length(34), Constraint::Min(20)]).split(inner);
    let mut left = vec![Line::from(Span::styled(" live agents", Style::default().fg(MUTED)))];
    for p in &app.model.projects {
        left.push(Line::from(vec![Span::styled(" ▮ ", Style::default().fg(p.color)), Span::styled(p.label.clone(), Style::default().add_modifier(Modifier::BOLD))]));
        for s in app.model.slots.iter().filter(|s| app.model.worktree(s.worktree).map(|w| w.project) == Some(p.id)) {
            if let Some(t) = s.top() {
                if t.status == Status::Shell { continue; }
                let wt = app.model.worktree(s.worktree).map(|w| w.name.clone()).unwrap_or_default();
                left.push(Line::from(vec![Span::styled(format!("   {} ", t.status.glyph()), status_style(t.status)), Span::raw(format!("{}-{wt}", t.kind)), Span::styled("  tui", Style::default().fg(MUTED))]));
            }
        }
    }
    left.push(Line::from(vec![Span::styled("   ○ ", Style::default().fg(MUTED)), Span::raw("gemini-docs"), Span::styled("  outside", Style::default().fg(MUTED))]));
    f.render_widget(Paragraph::new(left), cols[0]);
    let right = vec![
        Line::from(Span::styled(" focused: claude-auth-fix", Style::default().add_modifier(Modifier::BOLD))),
        Line::from(""),
        Line::from(vec![Span::styled(" ⇠ reads   ", Style::default().fg(MUTED)), Span::raw("codex-promo")]),
        Line::from(vec![Span::styled(" ⇢ shares  ", Style::default().fg(MUTED)), Span::raw("claude-main")]),
        Line::from(""),
        Line::from(Span::styled(" messages", Style::default().fg(MUTED))),
        Line::from(" codex-promo → you  12:41"),
        Line::from("   Rate limiter fix landed, touches src/auth too. Heads up."),
        Line::from(" you → claude-main  12:38"),
        Line::from("   Point 1 confirmed, keep `<`. Details in the fork."),
    ];
    f.render_widget(Paragraph::new(right), cols[1]);
}

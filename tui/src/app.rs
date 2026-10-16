// App state on top of the model: leader key, overlays, mouse hover, hit areas.

use std::time::Instant;

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
use ratatui::layout::Rect;

use crate::model::{Id, Model, Row, Status};

pub const PROFILES: &[(&str, &str)] = &[
    ("claude", "claude --dangerously-skip-permissions"),
    ("codex", "codex --dangerously-bypass-approvals-and-sandbox"),
    ("gemini", "gemini --approval-mode=auto_edit"),
    ("opencode", "opencode"),
    ("cursor-agent", "cursor-agent"),
    ("copilot", "copilot --allow-tool=write"),
    ("amp", "amp"),
    ("shell", "$SHELL -l"),
];

#[derive(Clone, Copy, PartialEq)]
pub enum PromptKind {
    Fork,
    Worktree,
    Project,
}

pub enum Overlay {
    None,
    FanOut { sel: Id },
    Picker { sel: usize },
    Prompt { kind: PromptKind, buf: String },
    Help,
    Quit,
    Synapse,
}

// Where things were drawn last frame, for mouse hits.
#[derive(Default)]
pub struct Hits {
    pub sidebar_rows: Vec<(Rect, Row)>,
    pub header_cards: Vec<(Rect, Id)>,
    pub header: Rect,
    pub pane: Rect,
    pub fan_nodes: Vec<(Rect, Id)>,
}

pub struct App {
    pub model: Model,
    pub leader: bool,
    pub overlay: Overlay,
    pub sidebar: bool,
    pub hits: Hits,
    pub hover: Option<(Id, Instant)>,
    pub flash: Option<(String, Instant)>,
    pub quit: bool,
    pub ticks: u64,
}

impl App {
    pub fn new(model: Model) -> Self {
        App { model, leader: false, overlay: Overlay::None, sidebar: true, hits: Hits::default(), hover: None, flash: None, quit: false, ticks: 0 }
    }

    pub fn flash(&mut self, s: impl Into<String>) {
        self.flash = Some((s.into(), Instant::now()));
    }

    pub fn tick(&mut self) {
        self.ticks += 1;
        self.model.tick(self.ticks);
        if let Some((_, t)) = self.flash {
            if t.elapsed().as_secs() >= 5 {
                self.flash = None;
            }
        }
        if let (Some((id, t)), Overlay::None) = (self.hover, &self.overlay) {
            if t.elapsed().as_millis() >= 300 {
                let _ = id;
                let sel = self.model.focused_slot().and_then(|s| s.path.last().copied()).unwrap_or(0);
                self.overlay = Overlay::FanOut { sel };
                self.hover = None;
            }
        }
    }

    pub fn key(&mut self, k: KeyEvent) {
        if k.code == KeyCode::Char(' ') && k.modifiers.contains(KeyModifiers::CONTROL) {
            self.leader = !self.leader;
            return;
        }
        if !matches!(self.overlay, Overlay::None) {
            self.overlay_key(k);
            return;
        }
        if self.leader {
            self.leader = false;
            self.leader_key(k);
            return;
        }
        // everything else goes to the "PTY": the prototype echoes into a fake input line
        if let Some(s) = self.model.focused_slot_mut().and_then(|s| s.top_mut()) {
            match k.code {
                KeyCode::Char(c) => s.input.push(c),
                KeyCode::Backspace => { s.input.pop(); }
                KeyCode::Enter => {
                    let line = std::mem::take(&mut s.input);
                    if line.trim_start().starts_with("/sfork ") {
                        let q = line.trim_start()[7..].trim().to_string();
                        s.lines.push("synapse  ⑂ forked → new card on this slot".into());
                        self.fork(&q);
                        return;
                    }
                    s.lines.push(format!("> {line}"));
                    if s.status != Status::Shell {
                        s.status = Status::Working;
                    }
                }
                _ => {}
            }
        }
    }

    fn fork(&mut self, q: &str) {
        match self.model.fork(q) {
            Some(_) => self.flash(format!("⑂ forked: {q}")),
            None => self.flash("cannot fork a shell: no transcript"),
        }
    }

    fn leader_key(&mut self, k: KeyEvent) {
        match k.code {
            KeyCode::Char('n') => self.overlay = Overlay::Picker { sel: 0 },
            KeyCode::Char('t') => {
                if let Some(wt) = self.model.focused_worktree() {
                    let name = self.model.worktree(wt).map(|w| w.name.clone()).unwrap_or_default();
                    self.model.new_session(wt, "shell", &name);
                }
            }
            KeyCode::Char('w') => self.overlay = Overlay::Prompt { kind: PromptKind::Worktree, buf: String::new() },
            KeyCode::Char('p') => self.overlay = Overlay::Prompt { kind: PromptKind::Project, buf: String::new() },
            KeyCode::Char('F') => self.overlay = Overlay::Prompt { kind: PromptKind::Fork, buf: String::new() },
            KeyCode::Char('f') => {
                let sel = self.model.focused_slot().and_then(|s| s.path.last().copied()).unwrap_or(0);
                self.overlay = Overlay::FanOut { sel };
            }
            KeyCode::Backspace => {
                let depth = self.model.focused_slot().map(|s| s.depth()).unwrap_or(0);
                if depth > 1 { self.model.pop(); self.flash("popped, parent on top"); } else { self.flash("nothing to pop"); }
            }
            KeyCode::Char('j') | KeyCode::Down => self.model.move_focus(1),
            KeyCode::Char('k') | KeyCode::Up => self.model.move_focus(-1),
            KeyCode::Char(c) if c.is_ascii_digit() && c != '0' => {
                let n = c as usize - '1' as usize;
                let slots: Vec<Id> = self.model.rows().iter().filter_map(|r| if let Row::Slot(id) = r { Some(*id) } else { None }).collect();
                if let Some(id) = slots.get(n) { self.model.focused = *id; }
            }
            KeyCode::Char('x') => {
                let id = self.model.focused;
                let pos = self.model.slots.iter().position(|s| s.id == id);
                if let Some(p) = pos {
                    self.model.slots.remove(p);
                    self.model.move_focus(0);
                    if let Some(s) = self.model.slots.get(p.saturating_sub(1)) { self.model.focused = s.id; }
                }
            }
            KeyCode::Char('b') => self.sidebar = !self.sidebar,
            KeyCode::Char('g') => self.overlay = Overlay::Synapse,
            KeyCode::Char('q') => self.overlay = Overlay::Quit,
            KeyCode::Char('?') => self.overlay = Overlay::Help,
            KeyCode::Esc => {}
            _ => self.flash("unknown leader key, ? for help"),
        }
    }

    fn overlay_key(&mut self, k: KeyEvent) {
        match &mut self.overlay {
            Overlay::None => {}
            Overlay::Help | Overlay::Synapse => {
                if matches!(k.code, KeyCode::Esc | KeyCode::Enter | KeyCode::Char('q') | KeyCode::Char('?') | KeyCode::Char('g')) {
                    self.overlay = Overlay::None;
                }
            }
            Overlay::Quit => match k.code {
                KeyCode::Char('y') | KeyCode::Enter => self.quit = true,
                _ => self.overlay = Overlay::None,
            },
            Overlay::Picker { sel } => match k.code {
                KeyCode::Esc => self.overlay = Overlay::None,
                KeyCode::Up | KeyCode::Char('k') => *sel = (*sel + PROFILES.len() - 1) % PROFILES.len(),
                KeyCode::Down | KeyCode::Char('j') => *sel = (*sel + 1) % PROFILES.len(),
                KeyCode::Enter => {
                    let kind = PROFILES[*sel].0;
                    self.overlay = Overlay::None;
                    if let Some(wt) = self.model.focused_worktree() {
                        let name = self.model.worktree(wt).map(|w| w.name.clone()).unwrap_or_default();
                        self.model.new_session(wt, kind, &name);
                        self.flash(format!("spawned {kind} in {name}"));
                    }
                }
                _ => {}
            },
            Overlay::Prompt { kind, buf } => match k.code {
                KeyCode::Esc => self.overlay = Overlay::None,
                KeyCode::Char(c) => buf.push(c),
                KeyCode::Backspace => { buf.pop(); }
                KeyCode::Enter => {
                    let text = buf.trim().to_string();
                    let kind = *kind;
                    self.overlay = Overlay::None;
                    if text.is_empty() { return; }
                    match kind {
                        PromptKind::Fork => self.fork(&text),
                        PromptKind::Worktree => {
                            if let Some(p) = self.model.project_of_slot(self.model.focused).map(|p| p.id) {
                                self.model.new_worktree(p, &text);
                                self.flash(format!("git worktree add -b {text} ~/.synapse/worktrees/…/{text}"));
                            }
                        }
                        PromptKind::Project => self.flash(format!("would register {text} (prototype)")),
                    }
                }
                _ => {}
            },
            Overlay::FanOut { sel } => {
                let slot = match self.model.focused_slot() { Some(s) => s, None => { self.overlay = Overlay::None; return; } };
                let (nodes, _, _) = slot.layout();
                let cur = nodes.iter().find(|n| n.id == *sel).cloned();
                let pick = |pred: &dyn Fn(&crate::model::Placed) -> bool| {
                    let c = cur.as_ref()?;
                    nodes.iter().filter(|n| pred(n)).min_by_key(|n| (n.x as i32 - c.x as i32).abs() + (n.y as i32 - c.y as i32).abs() * 4).map(|n| n.id)
                };
                match k.code {
                    KeyCode::Esc | KeyCode::Char('f') => self.overlay = Overlay::None,
                    KeyCode::Left | KeyCode::Char('h') => { if let Some(c) = &cur { if let Some(id) = pick(&|n| n.depth == c.depth && n.x < c.x) { *sel = id; } } }
                    KeyCode::Right | KeyCode::Char('l') => { if let Some(c) = &cur { if let Some(id) = pick(&|n| n.depth == c.depth && n.x > c.x) { *sel = id; } } }
                    KeyCode::Up | KeyCode::Char('k') => { if let Some(c) = &cur { if let Some(id) = pick(&|n| n.depth + 1 == c.depth) { *sel = id; } } }
                    KeyCode::Down | KeyCode::Char('j') => { if let Some(c) = &cur { if let Some(id) = pick(&|n| n.depth == c.depth + 1) { *sel = id; } } }
                    KeyCode::Enter => {
                        let id = *sel;
                        self.overlay = Overlay::None;
                        if let Some(s) = self.model.focused_slot_mut() { s.focus(id); }
                    }
                    KeyCode::Char('d') => {
                        let id = *sel;
                        if let Some(s) = self.model.focused_slot_mut() {
                            if s.root() == Some(id) { self.flash("close the root with leader x"); return; }
                            s.close(id);
                            let top = s.path.last().copied().unwrap_or(0);
                            self.overlay = Overlay::FanOut { sel: top };
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    pub fn mouse(&mut self, m: MouseEvent) {
        let at = |r: Rect| r.x <= m.column && m.column < r.x + r.width && r.y <= m.row && m.row < r.y + r.height;
        match m.kind {
            MouseEventKind::Moved => {
                if let Overlay::None = self.overlay {
                    let over = self.hits.header_cards.iter().find(|(r, _)| at(*r)).map(|(_, id)| *id);
                    match (over, self.hover) {
                        (Some(id), Some((h, _))) if h == id => {}
                        (Some(id), _) => self.hover = Some((id, Instant::now())),
                        (None, _) => self.hover = None,
                    }
                }
            }
            MouseEventKind::Down(MouseButton::Left) => {
                self.hover = None;
                if let Overlay::FanOut { .. } = self.overlay {
                    if let Some((_, id)) = self.hits.fan_nodes.iter().find(|(r, _)| at(*r)) {
                        let id = *id;
                        self.overlay = Overlay::None;
                        if let Some(s) = self.model.focused_slot_mut() { s.focus(id); }
                    } else {
                        self.overlay = Overlay::None;
                    }
                    return;
                }
                if !matches!(self.overlay, Overlay::None) { return; }
                if let Some((_, row)) = self.hits.sidebar_rows.iter().find(|(r, _)| at(*r)) {
                    match *row {
                        Row::Slot(id) => self.model.focused = id,
                        Row::Project(id) => { if let Some(p) = self.model.projects.iter_mut().find(|p| p.id == id) { p.open = !p.open; } }
                        Row::Worktree(id) => { if let Some(s) = self.model.slots.iter().find(|s| s.worktree == id) { self.model.focused = s.id; } }
                    }
                } else if let Some((_, id)) = self.hits.header_cards.iter().find(|(r, _)| at(*r)) {
                    let id = *id;
                    if let Some(s) = self.model.focused_slot_mut() { s.focus(id); }
                }
            }
            _ => {}
        }
    }
}

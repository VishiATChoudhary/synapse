// Data model for the TUI. Pure data, no terminal code, so it can be unit tested.
// Prototype: sessions hold fake screen lines instead of a PTY.

use ratatui::style::Color;

pub type Id = usize;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Status {
    Working,
    Waiting,
    Idle,
    Shell,
    Exited,
}

impl Status {
    pub fn glyph(self) -> &'static str {
        match self {
            Status::Working => "●",
            Status::Waiting => "◐",
            Status::Idle => "○",
            Status::Shell => "$",
            Status::Exited => "✗",
        }
    }
}

pub struct Session {
    pub id: Id,
    pub kind: String,
    pub title: String,
    pub status: Status,
    pub parent: Option<Id>,
    pub question: Option<String>,
    pub injected: bool, // fallback fork: context injected, not inherited
    pub lines: Vec<String>,
    pub input: String,
}

pub struct Slot {
    pub id: Id,
    pub worktree: Id,
    pub sessions: Vec<Session>,
    pub path: Vec<Id>, // root .. focused session, the visible stack
}

pub struct Worktree {
    pub id: Id,
    pub project: Id,
    pub name: String,
    pub branch: String,
}

pub struct Project {
    pub id: Id,
    pub label: String,
    pub path: String,
    pub color: Color,
    pub open: bool,
}

pub struct Model {
    pub projects: Vec<Project>,
    pub worktrees: Vec<Worktree>,
    pub slots: Vec<Slot>,
    pub focused: Id, // slot id
    next_id: Id,
}

// One row of the sidebar, in display order.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Row {
    Project(Id),
    Worktree(Id),
    Slot(Id),
}

// A node placed by the fan-out layout, in overlay cells.
#[derive(Clone, Debug)]
pub struct Placed {
    pub id: Id,
    pub x: u16,
    pub y: u16,
    pub w: u16,
    pub depth: u16,
}

pub const CARD_H: u16 = 3;
pub const CARD_GAP: u16 = 2;
pub const ROW_GAP: u16 = 1;

impl Slot {
    pub fn session(&self, id: Id) -> Option<&Session> {
        self.sessions.iter().find(|s| s.id == id)
    }
    pub fn session_mut(&mut self, id: Id) -> Option<&mut Session> {
        self.sessions.iter_mut().find(|s| s.id == id)
    }
    pub fn top(&self) -> Option<&Session> {
        self.path.last().and_then(|id| self.session(*id))
    }
    pub fn top_mut(&mut self) -> Option<&mut Session> {
        let id = *self.path.last()?;
        self.session_mut(id)
    }
    pub fn root(&self) -> Option<Id> {
        self.sessions.iter().find(|s| s.parent.is_none()).map(|s| s.id)
    }
    pub fn children(&self, id: Id) -> Vec<Id> {
        self.sessions.iter().filter(|s| s.parent == Some(id)).map(|s| s.id).collect()
    }
    pub fn depth(&self) -> usize {
        self.path.len()
    }

    // Make `id` the focused session: the path becomes root .. id.
    pub fn focus(&mut self, id: Id) {
        let mut path = vec![id];
        let mut cur = id;
        while let Some(p) = self.session(cur).and_then(|s| s.parent) {
            path.push(p);
            cur = p;
        }
        path.reverse();
        self.path = path;
    }

    // Close a session and its descendants. Focus moves to its parent.
    pub fn close(&mut self, id: Id) {
        let mut doomed = vec![id];
        let mut i = 0;
        while i < doomed.len() {
            doomed.extend(self.children(doomed[i]));
            i += 1;
        }
        let parent = self.session(id).and_then(|s| s.parent);
        self.sessions.retain(|s| !doomed.contains(&s.id));
        match parent {
            Some(p) => self.focus(p),
            None => self.path.clear(),
        }
    }

    // Width needed by a subtree, in cells.
    fn subtree_w(&self, id: Id) -> u16 {
        let own = self.label(id).chars().count() as u16 + 6;
        let kids = self.children(id);
        if kids.is_empty() {
            return own;
        }
        let kids_w: u16 = kids.iter().map(|k| self.subtree_w(*k)).sum::<u16>() + CARD_GAP * (kids.len() as u16 - 1);
        own.max(kids_w)
    }

    pub fn label(&self, id: Id) -> String {
        let s = match self.session(id) {
            Some(s) => s,
            None => return String::new(),
        };
        let base = s.question.clone().unwrap_or_else(|| s.title.clone());
        let mut out: String = base.chars().take(22).collect();
        if base.chars().count() > 22 {
            out.push('…');
        }
        if s.injected {
            out = format!("≈ {out}");
        }
        out
    }

    // Layered layout: each parent centred over its children. Returns nodes and the total size.
    pub fn layout(&self) -> (Vec<Placed>, u16, u16) {
        let mut out = Vec::new();
        let root = match self.root() {
            Some(r) => r,
            None => return (out, 0, 0),
        };
        let total_w = self.subtree_w(root);
        let mut max_depth = 0;
        self.place(root, 0, 0, &mut out, &mut max_depth);
        let total_h = (max_depth + 1) * (CARD_H + ROW_GAP);
        (out, total_w, total_h)
    }

    fn place(&self, id: Id, x0: u16, depth: u16, out: &mut Vec<Placed>, max_depth: &mut u16) {
        *max_depth = (*max_depth).max(depth);
        let span = self.subtree_w(id);
        let w = self.label(id).chars().count() as u16 + 6;
        out.push(Placed { id, x: x0 + (span - w) / 2, y: depth * (CARD_H + ROW_GAP), w, depth });
        let mut x = x0;
        for k in self.children(id) {
            self.place(k, x, depth + 1, out, max_depth);
            x += self.subtree_w(k) + CARD_GAP;
        }
    }
}

impl Model {
    pub fn id(&mut self) -> Id {
        self.next_id += 1;
        self.next_id
    }

    pub fn slot(&self, id: Id) -> Option<&Slot> {
        self.slots.iter().find(|s| s.id == id)
    }
    pub fn slot_mut(&mut self, id: Id) -> Option<&mut Slot> {
        self.slots.iter_mut().find(|s| s.id == id)
    }
    pub fn focused_slot(&self) -> Option<&Slot> {
        self.slot(self.focused)
    }
    pub fn focused_slot_mut(&mut self) -> Option<&mut Slot> {
        let id = self.focused;
        self.slot_mut(id)
    }
    pub fn worktree(&self, id: Id) -> Option<&Worktree> {
        self.worktrees.iter().find(|w| w.id == id)
    }
    pub fn project(&self, id: Id) -> Option<&Project> {
        self.projects.iter().find(|p| p.id == id)
    }
    pub fn project_of_slot(&self, slot: Id) -> Option<&Project> {
        let wt = self.slot(slot)?.worktree;
        self.project(self.worktree(wt)?.project)
    }
    pub fn focused_worktree(&self) -> Option<Id> {
        self.focused_slot().map(|s| s.worktree)
    }

    pub fn rows(&self) -> Vec<Row> {
        let mut out = Vec::new();
        for p in &self.projects {
            out.push(Row::Project(p.id));
            if !p.open {
                continue;
            }
            for w in self.worktrees.iter().filter(|w| w.project == p.id) {
                out.push(Row::Worktree(w.id));
                for s in self.slots.iter().filter(|s| s.worktree == w.id) {
                    out.push(Row::Slot(s.id));
                }
            }
        }
        out
    }

    pub fn move_focus(&mut self, delta: i32) {
        let rows = self.rows();
        let slots: Vec<Id> = rows.iter().filter_map(|r| if let Row::Slot(id) = r { Some(*id) } else { None }).collect();
        if slots.is_empty() {
            return;
        }
        let cur = slots.iter().position(|id| *id == self.focused).unwrap_or(0) as i32;
        let next = (cur + delta).rem_euclid(slots.len() as i32) as usize;
        self.focused = slots[next];
    }

    pub fn new_session(&mut self, worktree: Id, kind: &str, title: &str) -> Id {
        let (status, lines) = fake_screen(kind, title);
        let sid = self.id();
        let slot_id = self.id();
        let session = Session {
            id: sid, kind: kind.to_string(), title: title.to_string(), status, parent: None,
            question: None, injected: false, lines, input: String::new(),
        };
        self.slots.push(Slot { id: slot_id, worktree, sessions: vec![session], path: vec![sid] });
        self.focused = slot_id;
        slot_id
    }

    // Fork the focused session of the focused slot. Pushes a child on the stack.
    pub fn fork(&mut self, question: &str) -> Option<Id> {
        let sid = self.id();
        let slot = self.focused_slot_mut()?;
        let parent = slot.top()?;
        if parent.status == Status::Shell {
            return None;
        }
        let kind = parent.kind.clone();
        let injected = !matches!(kind.as_str(), "claude" | "codex" | "opencode" | "gemini");
        let pid = parent.id;
        let mut lines = vec![
            format!("synapse  ⑂ fork of \"{}\"", parent.title),
            String::new(),
            format!("> {question}"),
            String::new(),
            "⏺ Looking at that point in the parent's reply. Give me a moment.".to_string(),
        ];
        if injected {
            lines.insert(1, "synapse  ≈ context injected from parent (no native fork for this agent)".to_string());
        }
        slot.sessions.push(Session {
            id: sid, kind, title: question.to_string(), status: Status::Working, parent: Some(pid),
            question: Some(question.to_string()), injected, lines, input: String::new(),
        });
        slot.focus(sid);
        Some(sid)
    }

    pub fn pop(&mut self) {
        if let Some(slot) = self.focused_slot_mut() {
            if slot.path.len() > 1 {
                let top = *slot.path.last().unwrap();
                slot.close(top);
            }
        }
    }

    pub fn new_worktree(&mut self, project: Id, name: &str) -> Id {
        let id = self.id();
        self.worktrees.push(Worktree { id, project, name: name.to_string(), branch: name.to_string() });
        self.new_session(id, "shell", "shell");
        id
    }

    // Simulate life: working sessions emit a line now and then.
    pub fn tick(&mut self, n: u64) {
        let fake = [
            "⏺ Read(src/auth/middleware.ts)",
            "⏺ Grep(pattern: \"expiresAt\", path: \"src\")",
            "⏺ Bash(npm test -- auth)",
            "  ⎿  12 passed, 0 failed",
            "⏺ Edit(src/auth/middleware.ts)",
            "⏺ The expiry check used < where <= was needed. Fixed and tests pass.",
        ];
        for slot in &mut self.slots {
            for (i, s) in slot.sessions.iter_mut().enumerate() {
                if s.status == Status::Working && (n + i as u64 + s.id as u64) % 7 == 0 {
                    let line = fake[((n / 7) as usize + s.id) % fake.len()];
                    s.lines.push(line.to_string());
                    if s.lines.len() > 400 {
                        s.lines.drain(0..100);
                    }
                    if line.starts_with("⏺ The expiry") && s.id % 3 == 0 {
                        s.status = Status::Idle;
                    }
                }
            }
        }
    }
}

fn fake_screen(kind: &str, title: &str) -> (Status, Vec<String>) {
    match kind {
        "shell" => (
            Status::Shell,
            vec![
                "Last login: Wed Oct 15 21:14:02 on ttys007".into(),
                format!("~/.synapse/worktrees/{title} % git status"),
                "On branch main".into(),
                "nothing to commit, working tree clean".into(),
                format!("~/.synapse/worktrees/{title} % "),
            ],
        ),
        "codex" => (
            Status::Idle,
            vec![
                "╭──────────────────────────────────────────╮".into(),
                "│  OpenAI Codex (v0.63)  model: gpt-5-codex │".into(),
                "╰──────────────────────────────────────────╯".into(),
                "".into(),
                "› Investigate why the rate limiter lets bursts through".into(),
                "".into(),
                "• Reading src/ratelimit.ts".into(),
                "• The token bucket refills on every call, including rejected ones.".into(),
                "  Moving the refill before the check fixes it. Want me to apply it?".into(),
            ],
        ),
        _ => (
            Status::Working,
            vec![
                " ▐▛███▜▌   Claude Code v2.1.301".into(),
                "▝▜█████▛▘  Fable 5.1 · claude-fable-5-1".into(),
                "  ▘▘ ▝▝    ~/.synapse/worktrees/synapse/".to_string() + title,
                "".into(),
                "> Why does the auth middleware let expired tokens through?".into(),
                "".into(),
                "⏺ Three candidates:".into(),
                "".into(),
                "  1. Expiry check uses `<` where `<=` is needed".into(),
                "  2. Clock skew: server time is behind the issuer".into(),
                "  3. Refresh path skips validation entirely".into(),
                "".into(),
                "  Checking each in order.".into(),
            ],
        ),
    }
}

pub fn demo() -> Model {
    let mut m = Model { projects: vec![], worktrees: vec![], slots: vec![], focused: 0, next_id: 0 };
    let p1 = m.id();
    m.projects.push(Project { id: p1, label: "synapse".into(), path: "~/shennies/synapse".into(), color: Color::Rgb(0x2F, 0x5B, 0xEA), open: true });
    let p2 = m.id();
    m.projects.push(Project { id: p2, label: "toffee-web".into(), path: "~/toffee/sandbox/toffee-sandbox-web".into(), color: Color::Rgb(0x00, 0xA3, 0x6C), open: true });

    let w_main = m.id();
    m.worktrees.push(Worktree { id: w_main, project: p1, name: "main".into(), branch: "main".into() });
    let w_auth = m.id();
    m.worktrees.push(Worktree { id: w_auth, project: p1, name: "auth-fix".into(), branch: "auth-fix".into() });
    let w_promo = m.id();
    m.worktrees.push(Worktree { id: w_promo, project: p1, name: "promo".into(), branch: "promo-video".into() });
    let w_news = m.id();
    m.worktrees.push(Worktree { id: w_news, project: p2, name: "news-updates".into(), branch: "news-updates".into() });

    m.new_session(w_main, "claude", "main");
    m.new_session(w_main, "shell", "main");
    let auth = m.new_session(w_auth, "claude", "auth-fix");
    m.new_session(w_promo, "codex", "promo");
    m.new_session(w_news, "claude", "news-updates");
    m.new_session(w_news, "shell", "news-updates");

    // a ready-made fork tree on auth-fix: parent → 3 children, one with a grandchild
    m.focused = auth;
    let root = m.slot(auth).unwrap().root().unwrap();
    let c1 = m.fork("why not just <= ?").unwrap();
    m.focused_slot_mut().unwrap().focus(root);
    let _c2 = m.fork("how big is the skew in prod?").unwrap();
    m.focused_slot_mut().unwrap().focus(root);
    let c3 = m.fork("does refresh really skip validation?").unwrap();
    let _g = m.fork("where is the refresh handler?").unwrap();
    if let Some(s) = m.focused_slot_mut().unwrap().session_mut(c1) {
        s.status = Status::Idle;
        s.lines.push("⏺ `<` rejects a token at the exact expiry second, `<=` accepts it. Spec says reject. Keep `<`.".into());
    }
    if let Some(s) = m.focused_slot_mut().unwrap().session_mut(c3) {
        s.status = Status::Waiting;
    }
    m.focused_slot_mut().unwrap().focus(c3);
    m.focused = auth;
    m
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fork_pushes_and_pop_returns_to_parent() {
        let mut m = demo();
        m.focused = m.slots[0].id;
        assert_eq!(m.focused_slot().unwrap().depth(), 1);
        m.fork("q1").unwrap();
        assert_eq!(m.focused_slot().unwrap().depth(), 2);
        m.pop();
        assert_eq!(m.focused_slot().unwrap().depth(), 1);
        assert_eq!(m.focused_slot().unwrap().sessions.len(), 1);
    }

    #[test]
    fn shell_cannot_fork() {
        let mut m = demo();
        m.focused = m.slots[1].id;
        assert!(m.fork("q").is_none());
    }

    #[test]
    fn layout_centres_parent_over_children() {
        let m = demo();
        let slot = m.slots.iter().find(|s| s.sessions.len() > 1).unwrap();
        let (nodes, w, h) = slot.layout();
        assert_eq!(nodes.len(), 5);
        let root = nodes.iter().find(|n| n.depth == 0).unwrap();
        assert!(root.x + root.w / 2 >= w / 2 - 1 && root.x + root.w / 2 <= w / 2 + 1);
        assert_eq!(h, 3 * (CARD_H + ROW_GAP));
        let kids: Vec<_> = nodes.iter().filter(|n| n.depth == 1).collect();
        for pair in kids.windows(2) {
            assert!(pair[0].x + pair[0].w <= pair[1].x);
        }
    }

    #[test]
    fn close_removes_descendants() {
        let mut m = demo();
        let slot = m.slots.iter_mut().find(|s| s.sessions.len() > 1).unwrap();
        let root = slot.root().unwrap();
        let kids = slot.children(root);
        let with_grandchild = *kids.iter().find(|k| !slot.children(**k).is_empty()).unwrap();
        slot.close(with_grandchild);
        assert_eq!(slot.sessions.len(), 3);
        assert_eq!(slot.path, vec![root]);
    }
}

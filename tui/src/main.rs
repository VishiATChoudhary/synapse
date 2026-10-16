// synapse-tui prototype: look and feel only. Sessions are fake, no PTYs yet.
mod app;
mod model;
mod ui;

use std::io::{self, stdout};
use std::time::Duration;

use crossterm::{
    event::{self, DisableMouseCapture, EnableMouseCapture, Event, KeyEventKind},
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use ratatui::{backend::CrosstermBackend, Terminal};

fn dump() -> io::Result<()> {
    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
    use ratatui::backend::TestBackend;
    let mut term = Terminal::new(TestBackend::new(120, 34))?;
    let mut app = app::App::new(model::demo());
    let leader = KeyEvent::new(KeyCode::Char(' '), KeyModifiers::CONTROL);
    let key = |c: char| KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE);
    let shots: [(&str, Vec<KeyEvent>); 4] = [
        ("main view, auth-fix slot with a 3-deep stack", vec![]),
        ("fan-out overlay (leader f)", vec![leader, key('f')]),
        ("profile picker (leader n)", vec![KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE), leader, key('n')]),
        ("synapse view (leader g)", vec![KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE), leader, key('g')]),
    ];
    for (title, keys) in shots {
        for k in keys { app.key(k); }
        term.draw(|f| ui::draw(f, &mut app))?;
        println!("── {title} ──");
        let buf = term.backend().buffer();
        for y in 0..buf.area.height {
            let line: String = (0..buf.area.width).map(|x| buf[(x, y)].symbol().to_string()).collect();
            println!("{}", line.trim_end());
        }
        println!();
    }
    Ok(())
}

fn main() -> io::Result<()> {
    if std::env::args().any(|a| a == "--dump") { return dump(); }
    enable_raw_mode()?;
    execute!(stdout(), EnterAlternateScreen, EnableMouseCapture)?;
    let hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let _ = disable_raw_mode();
        let _ = execute!(stdout(), LeaveAlternateScreen, DisableMouseCapture);
        hook(info);
    }));
    let mut term = Terminal::new(CrosstermBackend::new(stdout()))?;
    let mut app = app::App::new(model::demo());

    while !app.quit {
        term.draw(|f| ui::draw(f, &mut app))?;
        if event::poll(Duration::from_millis(120))? {
            match event::read()? {
                Event::Key(k) if k.kind == KeyEventKind::Press => app.key(k),
                Event::Mouse(m) => app.mouse(m),
                _ => {}
            }
        } else {
            app.tick();
        }
    }

    disable_raw_mode()?;
    execute!(stdout(), LeaveAlternateScreen, DisableMouseCapture)?;
    Ok(())
}

//! Real tmux control-mode session through the Rust parser and model. Uses a
//! private socket, no configuration file and a plain /bin/sh; skipped when
//! tmux is not installed.
use new_windterm_desktop::tmux_control::{Event, Model, Parser};
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    process::{ChildStdin, Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};

const TMUX: [&str; 2] = ["/opt/homebrew/bin/tmux", "/usr/bin/tmux"];
type Panes = BTreeMap<u32, Vec<u8>>;

/// Kills the private server and removes its socket directory even if an
/// assertion fails.
struct Server(String, std::path::PathBuf);
impl Drop for Server {
    fn drop(&mut self) {
        let socket = self.1.join("socket");
        let _ = Command::new(&self.0)
            .arg("-S")
            .arg(&socket)
            .arg("kill-server")
            .output();
        let _ = std::fs::remove_dir_all(&self.1);
    }
}

struct Session {
    stdin: ChildStdin,
    chunks: mpsc::Receiver<Vec<u8>>,
    parser: Parser,
    model: Model,
    seen: Vec<Event>,
    output: Panes,
}

impl Session {
    fn send(&mut self, command: &str) {
        self.stdin.write_all(command.as_bytes()).unwrap();
        self.stdin.write_all(b"\n").unwrap();
    }

    fn wait(&mut self, done: impl Fn(&[Event], &Panes) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !done(&self.seen, &self.output) {
            let left = deadline
                .checked_duration_since(Instant::now())
                .unwrap_or_else(|| panic!("tmux deadline: {:?}", self.seen));
            let chunk = self
                .chunks
                .recv_timeout(left)
                .unwrap_or_else(|_| panic!("tmux stream ended: {:?}", self.seen));
            for event in self.parser.push(&chunk).unwrap() {
                self.model.apply(&event);
                if let Event::Output { pane, data } = &event {
                    self.output
                        .entry(*pane)
                        .or_default()
                        .extend_from_slice(data);
                }
                self.seen.push(event);
            }
        }
    }
}

fn client_replies(seen: &[Event]) -> Vec<(bool, Vec<String>)> {
    seen.iter()
        .filter_map(|event| match event {
            Event::Reply {
                from_client: true,
                ok,
                lines,
                ..
            } => Some((*ok, lines.clone())),
            _ => None,
        })
        .collect()
}

fn contains(output: &Panes, pane: u32, text: &str) -> bool {
    output
        .get(&pane)
        .is_some_and(|bytes| String::from_utf8_lossy(bytes).contains(text))
}

#[test]
fn real_tmux_control_mode_session() {
    let Some(tmux) = TMUX.iter().find(|path| std::path::Path::new(path).exists()) else {
        eprintln!("skipped: tmux is not installed");
        return;
    };
    let directory = std::env::temp_dir().join(format!("p0-tmux-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&directory).unwrap();
    let socket = directory.join("socket");
    let _server = Server(tmux.to_string(), directory.clone());
    let mut child = Command::new(tmux)
        .arg("-S")
        .arg(&socket)
        .args([
            "-f",
            "/dev/null",
            "-C",
            "new-session",
            "-x",
            "80",
            "-y",
            "24",
        ])
        .args(["env", "-i", "PATH=/usr/bin:/bin", "PS1=P0$ ", "/bin/sh"])
        .env("TERM", "xterm-256color")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut stdout = child.stdout.take().unwrap();
    let (sender, chunks) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buffer = [0; 4096];
        while let Ok(n) = stdout.read(&mut buffer) {
            if n == 0 || sender.send(buffer[..n].to_vec()).is_err() {
                break;
            }
        }
    });
    let mut session = Session {
        stdin: child.stdin.take().unwrap(),
        chunks,
        parser: Parser::default(),
        model: Model::default(),
        seen: Vec::new(),
        output: Panes::default(),
    };

    session.wait(|seen, _| {
        seen.iter()
            .any(|e| matches!(e, Event::SessionChanged { .. }))
    });
    session.send("rename-window -t @0 中文窗口");
    // Octal escapes make the new pane print TAB, a backslash and UTF-8 bytes
    // regardless of locale; no keyboard input is involved.
    session.send(r#"split-window -h -t @0 "printf 'P0_TMUX\\t\\134\\344\\270\\255\\n'; exec cat""#);
    session.send("display-message -p '#{window_layout}'");
    session.send("no-such-command");
    session.wait(|seen, _| client_replies(seen).len() >= 4);

    let window = session.model.windows.get(&0).expect("window @0").clone();
    assert_eq!(window.name, "中文窗口");
    let panes = window.layout.expect("layout after split").panes();
    assert_eq!(panes.len(), 2, "{panes:?}");
    let (first, second) = (panes[0].0, panes[1].0);
    assert_eq!(session.model.window_of(second), Some(0));
    let replies = client_replies(&session.seen);
    assert!(replies[..3].iter().all(|(ok, _)| *ok), "{replies:?}");
    assert!(
        replies[2].1[0].contains('{'),
        "layout reply: {:?}",
        replies[2].1
    );
    assert!(!replies[3].0 && replies[3].1[0].contains("unknown command"));

    session.wait(|_, output| contains(output, second, "P0_TMUX\t\\中"));
    // Keyboard input into the first pane; only the shell's result contains 42.
    session.send(&format!("send-keys -t %{first} -l 'echo P0_IN_$((6*7))'"));
    session.send(&format!("send-keys -t %{first} Enter"));
    session.wait(|_, output| contains(output, first, "P0_IN_42"));

    session.send("kill-server");
    session.wait(|seen, _| seen.iter().any(|e| matches!(e, Event::Exit { .. })));
    assert!(session.model.exited.is_some());
    let _ = child.wait();
}

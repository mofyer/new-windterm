//! Release-bundle guard. Tauri CLI copies every `src/bin` executable into the
//! `.app` unless its `[[bin]]` entry has `required-features` that were not
//! passed to `tauri build`. Every binary under `src/bin` is a test or probe
//! tool, so each one must declare an explicit `[[bin]]` gated on `dev-tools`.
//!
//! This reads `Cargo.toml` as text, not as TOML: an unusual layout (a
//! multi-line array, an inline `bin = [...]`) fails the guard rather than
//! slipping past it.
use std::{fs, path::Path};

const GATE: &str = "\"dev-tools\"";

fn manifest() -> String {
    fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml"))
        .expect("read Cargo.toml")
}

/// Body of each `[[bin]]` table, up to the next table header. Headers are
/// matched on whole lines, so a comment that mentions `[[bin]]` is ignored.
fn bin_tables(manifest: &str) -> Vec<String> {
    let mut tables = Vec::new();
    let mut current: Option<Vec<&str>> = None;
    for line in manifest.lines().map(str::trim) {
        let code = line.split('#').next().unwrap_or_default().trim();
        if code.starts_with('[') {
            tables.extend(current.take().map(|body| body.join("\n")));
            if code == "[[bin]]" {
                current = Some(Vec::new());
            }
        } else if let Some(body) = current.as_mut() {
            body.push(line);
        }
    }
    tables.extend(current.map(|body| body.join("\n")));
    tables
}

fn value_line<'a>(table: &'a str, key: &str) -> Option<&'a str> {
    table.lines().map(str::trim).find(|line| {
        line.strip_prefix(key)
            .is_some_and(|rest| rest.trim_start().starts_with('='))
    })
}

fn assert_gated(table: &str, what: &str) {
    let required = value_line(table, "required-features")
        .unwrap_or_else(|| panic!("{what} must set required-features"));
    assert!(
        required.contains(GATE),
        "{what} must require {GATE} so the release .app excludes it: {required}"
    );
}

/// The app itself is the auto-discovered `src/main.rs`, so every explicit
/// `[[bin]]`, wherever its source lives, is a tool that Tauri would bundle.
#[test]
fn every_explicit_bin_table_requires_dev_tools() {
    let tables = bin_tables(&manifest());
    assert!(
        !tables.is_empty(),
        "Cargo.toml is expected to gate the probes"
    );
    for table in &tables {
        let name = value_line(table, "name").unwrap_or("[[bin]] without a name");
        assert_gated(table, name);
    }
}

#[test]
fn every_src_bin_target_requires_dev_tools() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let tables = bin_tables(&manifest());
    let mut entries: Vec<(String, bool)> = fs::read_dir(root.join("src/bin"))
        .expect("read src/bin")
        .map(|entry| {
            let entry = entry.expect("src/bin entry");
            let is_dir = entry.file_type().expect("src/bin entry type").is_dir();
            (entry.file_name().to_string_lossy().into_owned(), is_dir)
        })
        .collect();
    entries.sort();
    assert!(
        !entries.is_empty(),
        "src/bin is expected to hold the probes"
    );

    for (name, is_dir) in entries {
        // A directory target is `src/bin/<name>/main.rs`; a file is the path itself.
        let wanted = if is_dir {
            format!("\"src/bin/{name}/")
        } else {
            format!("\"src/bin/{name}\"")
        };
        let table = tables
            .iter()
            .find(|table| value_line(table, "path").is_some_and(|line| line.contains(&wanted)))
            .unwrap_or_else(|| panic!("src/bin/{name} needs an explicit [[bin]] entry"));
        assert_gated(table, &format!("src/bin/{name}"));
    }
}

#[test]
fn header_matching_ignores_comments_and_stops_at_next_table() {
    let manifest = "[features]\n# a [[bin]] mention\ndev-tools = []\n\n\
        [[bin]] # tool\nname = \"a\"\nrequired-features = [\"dev-tools\"]\n\n\
        [[bin]]\nname = \"b\"\n\n[dependencies]\nrequired-features = [\"dev-tools\"]\n";
    let tables = bin_tables(manifest);
    assert_eq!(tables.len(), 2);
    assert_eq!(value_line(&tables[0], "name"), Some("name = \"a\""));
    assert!(value_line(&tables[0], "required-features").is_some());
    assert_eq!(value_line(&tables[1], "name"), Some("name = \"b\""));
    assert_eq!(value_line(&tables[1], "required-features"), None);
}

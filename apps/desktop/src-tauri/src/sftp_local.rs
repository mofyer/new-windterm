//! Downloads one remote regular file into a local folder (WindTerm F02
//! prototype).
//!
//! The local name is the remote name after [`sanitize_file_name`]. The file
//! is created with `create_new` (`O_CREAT | O_EXCL`, plus `O_NOFOLLOW` on
//! Unix), so whatever already exists at the final path, including a symbolic
//! link, is never opened, truncated or followed; a collision picks
//! "name (n).ext" instead. Until the size is verified and synced, dropping the
//! target (a failure, or cancellation dropping the operation) removes the
//! partial file. The local file is committed before the remote handle is
//! closed, so a complete download is never discarded while waiting for the
//! server.
//!
//! Local file work is synchronous `std::fs`, run through [`blocking`] so a
//! slow disk or network-mounted download folder does not stall the other
//! tasks of the multi-threaded runtime.

use super::{
    base_name, is_eof, validate_path,
    write::{batch, describe, Meter, Progress, PIPELINE},
    ReadOnlySftp,
};
use russh_sftp::{
    client::RawSftpSession,
    protocol::{FileAttributes, FileType, OpenFlags},
};
use serde::Serialize;
use std::{
    fs::File,
    io::Write,
    path::{Path, PathBuf},
};

/// Downloads stream to disk, so this bounds disk use and transfer time.
pub const MAX_DOWNLOAD_BYTES: u64 = 64 * 1024 * 1024;
const READ_CHUNK: u64 = 32 * 1024;
/// Leaves room for a " (999)" suffix under the common 255-byte name limit.
const MAX_LOCAL_NAME_BYTES: usize = 200;
const MAX_COLLISIONS: u32 = 999;
const FALLBACK_NAME: &str = "download";
/// Windows device names (including the superscript-digit ports Windows also
/// reserves); refused everywhere so a name means the same file on every
/// platform.
const RESERVED: [&str; 30] = [
    "CON",
    "PRN",
    "AUX",
    "NUL",
    "CONIN$",
    "CONOUT$",
    "COM1",
    "COM2",
    "COM3",
    "COM4",
    "COM5",
    "COM6",
    "COM7",
    "COM8",
    "COM9",
    "COM\u{B9}",
    "COM\u{B2}",
    "COM\u{B3}",
    "LPT1",
    "LPT2",
    "LPT3",
    "LPT4",
    "LPT5",
    "LPT6",
    "LPT7",
    "LPT8",
    "LPT9",
    "LPT\u{B9}",
    "LPT\u{B2}",
    "LPT\u{B3}",
];

/// Runs local file work without stalling the other tasks on this worker.
/// Tauri's runtime is multi-threaded; a current-thread runtime (unit tests)
/// cannot hand the worker over, so the work then runs inline.
fn blocking<T>(work: impl FnOnce() -> T) -> T {
    use tokio::runtime::{Handle, RuntimeFlavor};
    match Handle::try_current() {
        Ok(handle) if handle.runtime_flavor() == RuntimeFlavor::MultiThread => {
            tokio::task::block_in_place(work)
        }
        _ => work(),
    }
}

/// Where a download was saved. `path` is for display only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Downloaded {
    pub path: String,
    pub bytes: u64,
}

fn unsafe_char(c: char) -> bool {
    c.is_control()
        || matches!(c, '/' | '\\' | '<' | '>' | ':' | '"' | '|' | '?' | '*')
        // Invisible and direction-changing marks can disguise an extension.
        || matches!(
            c,
            '\u{061C}'
                | '\u{200B}'..='\u{200F}'
                | '\u{202A}'..='\u{202E}'
                | '\u{2060}'..='\u{2069}'
                | '\u{FEFF}'
        )
}

/// `("archive.tar", ".gz")`; a leading dot alone (".profile") is no extension.
fn split_extension(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(index) if index > 0 => name.split_at(index),
        _ => (name, ""),
    }
}

fn is_reserved(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or(name).trim_end();
    RESERVED
        .iter()
        .any(|reserved| stem.eq_ignore_ascii_case(reserved))
}

/// Windows drops trailing dots and spaces; trim them on every platform.
fn trim(name: &str) -> &str {
    name.trim_start_matches(' ').trim_end_matches(['.', ' '])
}

fn truncate(name: &str, max: usize) -> String {
    if name.len() <= max {
        return name.to_string();
    }
    let (stem, extension) = match split_extension(name) {
        (stem, extension) if extension.len() <= max / 4 => (stem, extension),
        _ => (name, ""),
    };
    let mut end = (max - extension.len()).min(stem.len());
    while !stem.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{extension}", trim(&stem[..end]))
}

/// A local file name for a remote one: separators, Windows-reserved and
/// control characters become `_`, trailing dots and spaces are dropped,
/// device names get a `_` prefix, and the result is at most 200 bytes.
pub fn sanitize_file_name(remote: &str) -> String {
    let replaced: String = remote
        .chars()
        .map(|c| if unsafe_char(c) { '_' } else { c })
        .collect();
    let mut name = truncate(trim(&replaced), MAX_LOCAL_NAME_BYTES);
    if trim(&name).is_empty() {
        name = FALLBACK_NAME.into();
    }
    if is_reserved(&name) {
        name.insert(0, '_');
    }
    name
}

/// `"name (n).ext"` for the n-th collision.
fn with_suffix(name: &str, attempt: u32) -> String {
    let (stem, extension) = split_extension(name);
    format!("{stem} ({attempt}){extension}")
}

/// The download folder must be an existing absolute directory.
pub fn check_directory(directory: &Path) -> Result<(), String> {
    let usable = directory.is_absolute()
        && std::fs::metadata(directory).is_ok_and(|metadata| metadata.is_dir());
    if !usable {
        return Err("The download folder is unavailable".into());
    }
    Ok(())
}

fn open_new(path: &Path) -> std::io::Result<File> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    options.open(path)
}

/// A new local file that is removed on drop unless committed.
pub(crate) struct LocalTarget {
    path: PathBuf,
    file: Option<File>,
    keep: bool,
}

impl LocalTarget {
    pub(crate) fn create(directory: &Path, name: &str) -> Result<Self, String> {
        check_directory(directory)?;
        for attempt in 0..=MAX_COLLISIONS {
            let candidate = match attempt {
                0 => name.to_string(),
                _ => with_suffix(name, attempt),
            };
            let path = directory.join(candidate);
            match open_new(&path) {
                Ok(file) => {
                    return Ok(Self {
                        path,
                        file: Some(file),
                        keep: false,
                    })
                }
                // Anything already there, even a dangling symbolic link, is
                // left untouched: try the next suffix.
                Err(_) if std::fs::symlink_metadata(&path).is_ok() => continue,
                Err(_) => return Err("Cannot create the download file".into()),
            }
        }
        Err("Too many files with this name in the download folder".into())
    }

    fn write(&mut self, bytes: &[u8]) -> Result<(), String> {
        let file = self.file.as_mut().ok_or("The download file is closed")?;
        blocking(|| file.write_all(bytes)).map_err(|_| "Cannot write the download file".into())
    }

    /// Syncs the file, checks its length on disk and keeps it.
    pub(crate) fn commit(mut self, expected: u64) -> Result<PathBuf, String> {
        let file = self.file.take().ok_or("The download file is closed")?;
        let length = blocking(|| file.sync_all().and_then(|()| file.metadata()))
            .map_err(|_| "Cannot write the download file")?
            .len();
        if length != expected {
            return Err("Downloaded size does not match the remote file".into());
        }
        drop(file);
        self.keep = true;
        Ok(self.path.clone())
    }
}

impl Drop for LocalTarget {
    fn drop(&mut self) {
        if !self.keep {
            // Close first: Windows cannot remove a file that is still open.
            drop(self.file.take());
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

/// Streams one remote regular file (symbolic links followed) of at most
/// [`MAX_DOWNLOAD_BYTES`] into a new file in `directory`. The byte count must
/// equal the size `stat` reported before the transfer.
pub async fn download(
    sftp: &ReadOnlySftp,
    remote: &str,
    directory: &Path,
    progress: Option<&Progress>,
) -> Result<Downloaded, String> {
    validate_path(remote)?;
    let session = &sftp.session;
    let attrs = session
        .stat(remote)
        .await
        .map_err(|error| describe("metadata request", &error))?
        .attrs;
    if attrs.file_type() != FileType::File {
        return Err("SFTP download requires a regular file".into());
    }
    let size = attrs.len();
    if size > MAX_DOWNLOAD_BYTES {
        return Err("SFTP file exceeds the 64 MiB download limit".into());
    }
    let handle = session
        .open(remote, OpenFlags::READ, FileAttributes::empty())
        .await
        .map_err(|error| describe("open", &error))?
        .handle;
    // The local file exists only once the remote one is open, and is kept
    // before the remote close so a slow close cannot discard a whole file.
    let name = sanitize_file_name(base_name(remote));
    let saved = match blocking(|| LocalTarget::create(directory, &name)) {
        Ok(mut target) => match copy(session, &handle, size, &mut target, progress).await {
            Ok(()) => target.commit(size),
            Err(error) => Err(error),
        },
        Err(error) => Err(error),
    };
    // The whole SFTP session is closed right after this operation.
    let _ = session.close(handle).await;
    let path = saved?;
    Ok(Downloaded {
        path: path.to_string_lossy().into_owned(),
        bytes: size,
    })
}

/// Reads in batches of [`PIPELINE`] requests. A short reply leaves a gap after
/// it, so the rest of that batch is dropped and requested again from the new
/// offset, with chunks no larger than what the server just returned.
async fn copy(
    session: &RawSftpSession,
    handle: &str,
    size: u64,
    target: &mut LocalTarget,
    progress: Option<&Progress>,
) -> Result<(), String> {
    let mut meter = Meter::new(progress, size);
    let mut offset = 0u64;
    let mut chunk = READ_CHUNK;
    // Ask for one byte past `size` so growth after `stat` is caught.
    let end = size + 1;
    'transfer: loop {
        let mut wanted = Vec::with_capacity(PIPELINE);
        let mut at = offset;
        while at < end && wanted.len() < PIPELINE {
            let length = (end - at).min(chunk);
            wanted.push((at, length as u32));
            at += length;
        }
        let requests = wanted
            .iter()
            .map(|&(at, length)| session.read(handle, at, length))
            .collect();
        for ((_, length), result) in wanted.iter().zip(batch(requests).await) {
            let data = match result {
                Ok(data) => data.data,
                Err(error) if is_eof(&error) => break 'transfer,
                Err(error) => return Err(describe("read", &error)),
            };
            if data.len() > *length as usize {
                return Err("SFTP server returned more data than requested".into());
            }
            offset += data.len() as u64;
            if offset > size {
                return Err("SFTP file changed during download; retry".into());
            }
            target.write(&data)?;
            meter.update(offset);
            if data.is_empty() {
                break 'transfer;
            }
            if data.len() < *length as usize {
                chunk = data.len() as u64;
                continue 'transfer;
            }
        }
    }
    if offset != size {
        return Err("SFTP file changed during download; retry".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        let root = std::env::temp_dir().join(format!("nwt-download-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        root
    }

    fn names(root: &Path) -> Vec<String> {
        let mut names: Vec<_> = std::fs::read_dir(root)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn names_lose_separators_controls_and_disguises() {
        assert_eq!(sanitize_file_name("报告 2026.txt"), "报告 2026.txt");
        assert_eq!(sanitize_file_name("../../etc/passwd"), ".._.._etc_passwd");
        assert_eq!(
            sanitize_file_name("a\\b:c*d?e\"f<g>h|i"),
            "a_b_c_d_e_f_g_h_i"
        );
        assert_eq!(sanitize_file_name("line\nbreak\u{7f}"), "line_break_");
        assert_eq!(sanitize_file_name("evil\u{202E}txt.exe"), "evil_txt.exe");
        assert_eq!(sanitize_file_name("zero\u{200B}width"), "zero_width");
        assert_eq!(sanitize_file_name(".profile"), ".profile");
    }

    #[test]
    fn names_are_never_empty_dots_or_device_names() {
        for name in ["", ".", "..", "...", "   ", " . "] {
            assert_eq!(sanitize_file_name(name), FALLBACK_NAME, "{name:?}");
        }
        assert_eq!(sanitize_file_name("trailing. . "), "trailing");
        assert_eq!(sanitize_file_name(" lead"), "lead");
        assert_eq!(sanitize_file_name("CON"), "_CON");
        assert_eq!(sanitize_file_name("nul.txt"), "_nul.txt");
        assert_eq!(sanitize_file_name("Com1.tar.gz"), "_Com1.tar.gz");
        assert_eq!(sanitize_file_name("console"), "console");
        assert_eq!(sanitize_file_name("com\u{B9}.txt"), "_com\u{B9}.txt");
        assert_eq!(sanitize_file_name("LPT\u{B3}"), "_LPT\u{B3}");
    }

    #[test]
    fn long_names_keep_utf8_boundaries_and_short_extensions() {
        let long = format!("{}.txt", "文".repeat(100));
        let name = sanitize_file_name(&long);
        assert!(name.len() <= MAX_LOCAL_NAME_BYTES);
        assert!(name.ends_with(".txt"));
        assert!(name.starts_with('文'));
        let no_extension = sanitize_file_name(&"x".repeat(300));
        assert_eq!(no_extension.len(), MAX_LOCAL_NAME_BYTES);
        let long_extension = format!("a.{}", "e".repeat(300));
        assert_eq!(
            sanitize_file_name(&long_extension).len(),
            MAX_LOCAL_NAME_BYTES
        );
        // Truncation never leaves a trailing dot or space behind.
        let dotted = format!(
            "{}.{}",
            "a".repeat(MAX_LOCAL_NAME_BYTES - 1),
            "b".repeat(60)
        );
        assert_eq!(
            sanitize_file_name(&dotted),
            "a".repeat(MAX_LOCAL_NAME_BYTES - 1)
        );
    }

    #[test]
    fn suffixes_go_before_the_extension() {
        assert_eq!(with_suffix("a.txt", 1), "a (1).txt");
        assert_eq!(with_suffix("archive.tar.gz", 2), "archive.tar (2).gz");
        assert_eq!(with_suffix(".profile", 3), ".profile (3)");
        assert_eq!(with_suffix("README", 4), "README (4)");
    }

    #[test]
    fn collisions_never_touch_existing_files_or_links() {
        let root = scratch();
        let outside = root.join("outside.txt");
        std::fs::write(&outside, b"keep").unwrap();
        std::fs::write(root.join("a.txt"), b"existing").unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, root.join("a (1).txt")).unwrap();
            std::os::unix::fs::symlink(root.join("missing"), root.join("a (2).txt")).unwrap();
        }
        let mut target = LocalTarget::create(&root, "a.txt").unwrap();
        target.write(b"new").unwrap();
        let saved = target.commit(3).unwrap();
        #[cfg(unix)]
        assert_eq!(saved, root.join("a (3).txt"));
        assert_eq!(std::fs::read(&saved).unwrap(), b"new");
        assert_eq!(std::fs::read(root.join("a.txt")).unwrap(), b"existing");
        assert_eq!(std::fs::read(&outside).unwrap(), b"keep");
        #[cfg(unix)]
        assert!(!root.join("missing").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn uncommitted_or_mismatched_targets_are_removed() {
        let root = scratch();
        let mut dropped = LocalTarget::create(&root, "partial.bin").unwrap();
        dropped.write(b"half").unwrap();
        assert_eq!(names(&root), ["partial.bin"]);
        drop(dropped);
        assert!(names(&root).is_empty());
        let mut short = LocalTarget::create(&root, "short.bin").unwrap();
        short.write(b"abc").unwrap();
        assert_eq!(
            short.commit(4).unwrap_err(),
            "Downloaded size does not match the remote file"
        );
        assert!(names(&root).is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn the_download_folder_must_be_an_existing_absolute_directory() {
        let root = scratch();
        assert!(check_directory(&root).is_ok());
        assert!(check_directory(Path::new("relative")).is_err());
        assert!(check_directory(&root.join("missing")).is_err());
        let file = root.join("file");
        std::fs::write(&file, b"").unwrap();
        assert!(check_directory(&file).is_err());
        assert!(LocalTarget::create(&file, "a").is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}

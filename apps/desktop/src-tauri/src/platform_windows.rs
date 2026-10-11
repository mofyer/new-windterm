//! Windows-only ConPTY lifecycle helpers. ConPTY output pipes are read with
//! blocking `ReadFile`; the session ends them by closing the pseudoconsole after
//! the shell exits, and this module owns the kill-on-close Job Object that
//! bounds the shell's whole process tree.
use std::os::windows::io::{AsRawHandle, BorrowedHandle, FromRawHandle, OwnedHandle, RawHandle};
use windows_sys::Win32::{
    Foundation::HANDLE,
    Storage::FileSystem::{GetFileType, FILE_TYPE_DISK},
    System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
        JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
        TerminateJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    },
};

fn os_error(context: &str) -> String {
    format!("{context}: {}", std::io::Error::last_os_error())
}

/// The shell and every process it starts. Dropping or terminating the job
/// ends all of them, including detached `start /B` children. The shell's own
/// handle is kept as a fallback if job termination fails.
pub(crate) struct ProcessTree {
    job: OwnedHandle,
    shell: OwnedHandle,
}

impl ProcessTree {
    /// Creates a kill-on-close job and assigns `process` to it. The shell is
    /// assigned before it receives input, so its later children inherit the job.
    pub(crate) fn adopt(process: RawHandle) -> Result<Self, String> {
        // SAFETY: null attributes and name create an anonymous, non-inheritable job.
        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job.is_null() {
            return Err(os_error("Windows Job Object creation failed"));
        }
        // SAFETY: CreateJobObjectW returned a new handle, owned exactly once here.
        let job = unsafe { OwnedHandle::from_raw_handle(job as RawHandle) };
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: the pointer and size describe one live, correctly typed structure.
        let configured = unsafe {
            SetInformationJobObject(
                job.as_raw_handle() as HANDLE,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if configured == 0 {
            return Err(os_error("Windows Job Object configuration failed"));
        }
        // SAFETY: both handles are live for the call; the job does not take
        // ownership of the process handle.
        if unsafe { AssignProcessToJobObject(job.as_raw_handle() as HANDLE, process as HANDLE) }
            == 0
        {
            return Err(os_error("Windows shell could not join its Job Object"));
        }
        // SAFETY: `process` is the live child handle owned by portable-pty for
        // this call; duplicating it gives this tree its own owned handle.
        let shell = unsafe { BorrowedHandle::borrow_raw(process) }
            .try_clone_to_owned()
            .map_err(|_| "Windows shell handle could not be duplicated")?;
        Ok(Self { job, shell })
    }

    /// Terminates every process in the tree. Idempotent. If the job cannot be
    /// terminated, the shell itself is terminated so its waiter still wakes.
    pub(crate) fn terminate(&self) {
        // SAFETY: both handles are owned by self and live.
        unsafe {
            if TerminateJobObject(self.job.as_raw_handle() as HANDLE, 1) == 0 {
                windows_sys::Win32::System::Threading::TerminateProcess(
                    self.shell.as_raw_handle() as HANDLE,
                    1,
                );
            }
        }
    }

    /// Live processes still assigned to the job.
    pub(crate) fn active_processes(&self) -> Result<u32, String> {
        let mut info = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        // SAFETY: the pointer and size describe one live, correctly typed structure.
        let queried = unsafe {
            QueryInformationJobObject(
                self.job.as_raw_handle() as HANDLE,
                JobObjectBasicAccountingInformation,
                (&mut info as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                std::ptr::null_mut(),
            )
        };
        if queried == 0 {
            return Err(os_error("Windows Job Object query failed"));
        }
        Ok(info.ActiveProcesses)
    }
}

/// Whether Ctrl+C is ignored is inherited by child processes: if this app
/// (or a test runner) was started in a new process group, every shell it
/// spawns would ignore the Ctrl+C that ConPTY generates for 0x03. Restore
/// normal processing before spawning. A GUI process has no console of its
/// own, so this only affects what children inherit.
///
/// This is process-wide and also undoes an ignore the launcher set on purpose,
/// so it runs once, before the first shell.
pub(crate) fn restore_ctrl_c_processing() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    // SAFETY: a null handler with FALSE only clears the inherited ignore flag.
    ONCE.call_once(|| unsafe {
        windows_sys::Win32::System::Console::SetConsoleCtrlHandler(None, 0);
    });
}

/// Open handles of this process, for leak checks in Windows tests.
#[cfg(test)]
pub(crate) fn handle_count() -> u32 {
    let mut count = 0;
    // SAFETY: the pseudo-handle of the current process is always valid.
    unsafe {
        windows_sys::Win32::System::Threading::GetProcessHandleCount(
            windows_sys::Win32::System::Threading::GetCurrentProcess(),
            &mut count,
        )
    };
    count
}

/// Open handles of this process counted by object type (pipes and other
/// files split by `GetFileType`), for leak diagnostics in Windows tests.
#[cfg(test)]
pub(crate) fn handle_types() -> std::collections::BTreeMap<String, u32> {
    use windows_sys::Wdk::Foundation::{NtQueryObject, ObjectTypeInformation};
    use windows_sys::Win32::Foundation::{GetHandleInformation, UNICODE_STRING};
    let mut types = std::collections::BTreeMap::new();
    for value in (4..0x10000usize).step_by(4) {
        let handle = value as HANDLE;
        let mut flags = 0;
        // SAFETY: probing a handle value only reads its flags.
        if unsafe { GetHandleInformation(handle, &mut flags) } == 0 {
            continue;
        }
        // 8-byte aligned buffer for PUBLIC_OBJECT_TYPE_INFORMATION.
        let mut buffer = [0u64; 128];
        let mut length = 0;
        // SAFETY: the buffer is writable for its full size and suitably aligned.
        let status = unsafe {
            NtQueryObject(
                handle,
                ObjectTypeInformation,
                buffer.as_mut_ptr().cast(),
                std::mem::size_of_val(&buffer) as u32,
                &mut length,
            )
        };
        let mut name = if status >= 0 {
            // SAFETY: on success the buffer starts with a UNICODE_STRING whose
            // characters lie inside the buffer.
            unsafe {
                let text = &*(buffer.as_ptr() as *const UNICODE_STRING);
                String::from_utf16_lossy(std::slice::from_raw_parts(
                    text.Buffer,
                    text.Length as usize / 2,
                ))
            }
        } else {
            format!("status {status:#x}")
        };
        if name == "File" {
            // SAFETY: the handle was just validated; GetFileType does not block.
            name = match unsafe { GetFileType(handle) } {
                FILE_TYPE_DISK => "File/disk".into(),
                windows_sys::Win32::Storage::FileSystem::FILE_TYPE_PIPE => "File/pipe".into(),
                windows_sys::Win32::Storage::FileSystem::FILE_TYPE_CHAR => "File/char".into(),
                _ => "File/other".into(),
            };
        }
        *types.entry(name).or_insert(0) += 1;
    }
    types
}

/// True only for on-disk files. `std` reports pipes, consoles and character
/// devices as "files" on Windows, and a blocking read from one would hold a
/// private-key reader permit indefinitely.
pub(crate) fn is_disk_file(file: &std::fs::File) -> bool {
    // SAFETY: the handle is owned by `file` and live for the call.
    unsafe { GetFileType(file.as_raw_handle() as HANDLE) == FILE_TYPE_DISK }
}

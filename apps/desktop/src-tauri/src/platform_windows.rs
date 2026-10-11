//! Windows-only ConPTY lifecycle helpers. ConPTY output pipes are read with
//! blocking `ReadFile`; the session ends them by closing the pseudoconsole after
//! the shell exits, and this module owns the kill-on-close Job Object that
//! bounds the shell's whole process tree.
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};
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
/// ends all of them, including detached `start /B` children.
pub(crate) struct ProcessTree(OwnedHandle);

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
        Ok(Self(job))
    }

    /// Terminates every process in the tree. Idempotent; an already empty job
    /// is not an error worth reporting during teardown.
    pub(crate) fn terminate(&self) {
        // SAFETY: the job handle is owned by self and live.
        unsafe { TerminateJobObject(self.0.as_raw_handle() as HANDLE, 1) };
    }

    /// Live processes still assigned to the job.
    pub(crate) fn active_processes(&self) -> Result<u32, String> {
        let mut info = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        // SAFETY: the pointer and size describe one live, correctly typed structure.
        let queried = unsafe {
            QueryInformationJobObject(
                self.0.as_raw_handle() as HANDLE,
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
pub(crate) fn restore_ctrl_c_processing() {
    // SAFETY: a null handler with FALSE only clears the inherited ignore flag.
    unsafe { windows_sys::Win32::System::Console::SetConsoleCtrlHandler(None, 0) };
}

/// True only for on-disk files. `std` reports pipes, consoles and character
/// devices as "files" on Windows, and a blocking read from one would hold a
/// private-key reader permit indefinitely.
pub(crate) fn is_disk_file(file: &std::fs::File) -> bool {
    // SAFETY: the handle is owned by `file` and live for the call.
    unsafe { GetFileType(file.as_raw_handle() as HANDLE) == FILE_TYPE_DISK }
}

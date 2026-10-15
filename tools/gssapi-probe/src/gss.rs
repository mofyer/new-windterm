//! Minimal RFC 2744 ABI, only used by the isolated Linux test executable.
//! Buffers, names and contexts belong to GSS and are released by their RAII owner.
use std::{ffi::c_void, future::Future, ptr};

use russh::{GssapiAuthenticator, GssapiStep};

pub type Error = Box<dyn std::error::Error + Send + Sync>;
pub const KERBEROS_DER: &[u8] = &[
    0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x12, 0x01, 0x02, 0x02,
];
const KERBEROS_OID: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x12, 0x01, 0x02, 0x02];
// GSS_C_NT_HOSTBASED_SERVICE, 1.2.840.113554.1.2.1.4 (RFC 2744 section 3.10).
const HOST_SERVICE_OID: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x12, 0x01, 0x02, 0x01, 0x04];
const MUTUAL: u32 = 2;
const INTEG: u32 = 32;
const CONTINUE: u32 = 1;
const DELEG: u32 = 1;

#[repr(C)]
struct Buffer {
    length: usize,
    value: *mut c_void,
}

impl Buffer {
    fn empty() -> Self {
        Self {
            length: 0,
            value: ptr::null_mut(),
        }
    }

    fn input(data: &[u8]) -> Self {
        // GSS specifies input buffers as const despite the historical mutable field.
        Self {
            length: data.len(),
            value: data.as_ptr().cast_mut().cast(),
        }
    }
}

#[repr(C)]
struct Oid {
    length: u32,
    elements: *mut c_void,
}

impl Oid {
    fn new(bytes: &[u8]) -> Self {
        Self {
            length: bytes.len() as u32,
            elements: bytes.as_ptr().cast_mut().cast(),
        }
    }
}

// OM_uint32 is uint32_t; gss_buffer_desc.length is size_t; gss_OID_desc.length
// is OM_uint32. Opaque handles are pointers. All functions use the C ABI.
#[cfg_attr(target_os = "linux", link(name = "gssapi_krb5"))]
#[cfg_attr(target_os = "macos", link(name = "GSS", kind = "framework"))]
unsafe extern "C" {
    fn gss_import_name(
        minor: *mut u32,
        input: *const Buffer,
        kind: *const Oid,
        name: *mut *mut c_void,
    ) -> u32;
    fn gss_release_name(minor: *mut u32, name: *mut *mut c_void) -> u32;
    fn gss_init_sec_context(
        minor: *mut u32,
        cred: *mut c_void,
        ctx: *mut *mut c_void,
        target: *mut c_void,
        mech: *const Oid,
        flags: u32,
        time: u32,
        bindings: *mut c_void,
        input: *const Buffer,
        actual: *mut *mut Oid,
        output: *mut Buffer,
        flags_out: *mut u32,
        time_out: *mut u32,
    ) -> u32;
    fn gss_delete_sec_context(minor: *mut u32, ctx: *mut *mut c_void, output: *mut Buffer) -> u32;
    fn gss_get_mic(
        minor: *mut u32,
        ctx: *mut c_void,
        qop: u32,
        message: *const Buffer,
        token: *mut Buffer,
    ) -> u32;
    fn gss_release_buffer(minor: *mut u32, buffer: *mut Buffer) -> u32;
}

struct Output(Buffer);
impl Output {
    fn new() -> Self {
        Self(Buffer::empty())
    }
    fn bytes(&self) -> Result<Vec<u8>, Error> {
        // Bound even trusted-library output before making a Rust slice.
        if self.0.length > 1024 * 1024 || (self.0.length > 0 && self.0.value.is_null()) {
            return Err("invalid GSS output buffer".into());
        }
        if self.0.length == 0 {
            return Ok(Vec::new());
        }
        // SAFETY: GSS allocated length readable bytes, valid until release in Drop.
        Ok(
            unsafe { std::slice::from_raw_parts(self.0.value.cast::<u8>(), self.0.length) }
                .to_vec(),
        )
    }
}
impl Drop for Output {
    fn drop(&mut self) {
        // SAFETY: this owner alone releases the GSS-allocated buffer, including
        // error-path outputs. An empty buffer is explicitly allowed by GSS.
        unsafe {
            gss_release_buffer(&mut 0, &mut self.0);
        }
    }
}

pub struct Kerberos {
    name: *mut c_void,
    context: *mut c_void,
    selected: bool,
}

#[derive(Debug)]
pub struct GssFailure {
    operation: &'static str,
    major: u32,
    minor: u32,
}

impl std::fmt::Display for GssFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Numeric status only; never tokens, ticket bytes or credential paths.
        write!(
            f,
            "{} failed: major={:#x} minor={:#x}",
            self.operation, self.major, self.minor
        )
    }
}
impl std::error::Error for GssFailure {}

fn status(operation: &'static str, major: u32, minor: u32) -> Error {
    Box::new(GssFailure {
        operation,
        major,
        minor,
    })
}

fn mechanism_ok(selected: &[u8]) -> Result<(), Error> {
    if selected != KERBEROS_DER {
        return Err("server selected an unoffered mechanism".into());
    }
    Ok(())
}

impl Kerberos {
    pub fn new(service: &str) -> Result<Self, Error> {
        let mut this = Self {
            name: ptr::null_mut(),
            context: ptr::null_mut(),
            selected: false,
        };
        let input = Buffer::input(service.as_bytes());
        let oid = Oid::new(HOST_SERVICE_OID);
        let mut minor = 0;
        // SAFETY: descriptors and backing bytes live through the synchronous call;
        // GSS creates an independently owned name released by Self::drop.
        let major = unsafe { gss_import_name(&mut minor, &input, &oid, &mut this.name) };
        if major != 0 {
            return Err(status("import-name", major, minor));
        }
        Ok(this)
    }

    fn step(
        &mut self,
        mechanism: Option<Vec<u8>>,
        input: Option<Vec<u8>>,
        mic: Vec<u8>,
    ) -> Result<GssapiStep, Error> {
        if !self.selected {
            mechanism_ok(mechanism.as_deref().ok_or("missing selected mechanism")?)?;
            self.selected = true;
        } else if mechanism.is_some() {
            return Err("repeated mechanism selection".into());
        }
        let oid = Oid::new(KERBEROS_OID);
        let input_buffer = input.as_deref().map(Buffer::input);
        let mut output = Output::new();
        let mut minor = 0;
        let mut flags = 0;
        let mut actual = ptr::null_mut();
        // SAFETY: all descriptors/backing bytes live for the call; context/name
        // are owned by self. Null credentials select only the fixture's private
        // KRB5CCNAME. No delegation requested; no channel bindings for RFC 4462.
        let major = unsafe {
            gss_init_sec_context(
                &mut minor,
                ptr::null_mut(),
                &mut self.context,
                self.name,
                &oid,
                MUTUAL | INTEG,
                0,
                ptr::null_mut(),
                input_buffer.as_ref().map_or(ptr::null(), |b| b),
                &mut actual,
                &mut output.0,
                &mut flags,
                ptr::null_mut(),
            )
        };
        if major != 0 && major != CONTINUE {
            return Err(status("init-context", major, minor));
        }
        let token = output.bytes()?;
        if major == CONTINUE {
            return Ok(GssapiStep::Continue { token });
        }
        if flags & (MUTUAL | INTEG) != MUTUAL | INTEG || flags & DELEG != 0 {
            return Err("GSS context lacks mutual/integrity or unexpectedly delegates".into());
        }
        // SAFETY: actual is a GSS-owned static mechanism OID; never release it.
        // Only dereference after success and checking pointer and length.
        let actual_ok = unsafe {
            !actual.is_null()
                && (*actual).length as usize == KERBEROS_OID.len()
                && !(*actual).elements.is_null()
                && std::slice::from_raw_parts((*actual).elements.cast::<u8>(), KERBEROS_OID.len())
                    == KERBEROS_OID
        };
        if !actual_ok {
            return Err("GSS established a non-Kerberos mechanism".into());
        }
        let message = Buffer::input(&mic);
        let mut signed = Output::new();
        // SAFETY: established context and message are alive; signed owns output.
        let major = unsafe { gss_get_mic(&mut minor, self.context, 0, &message, &mut signed.0) };
        if major != 0 {
            return Err(status("get-mic", major, minor));
        }
        let signed = signed.bytes()?;
        if signed.is_empty() {
            return Err("GSS produced an empty MIC".into());
        }
        Ok(GssapiStep::Complete {
            token: (!token.is_empty()).then_some(token),
            mic: Some(signed),
        })
    }
}

impl GssapiAuthenticator for Kerberos {
    type Error = Error;
    fn gssapi_step(
        &mut self,
        mechanism: Option<Vec<u8>>,
        input: Option<Vec<u8>>,
        mic: Vec<u8>,
    ) -> impl Future<Output = Result<GssapiStep, Error>> + Send {
        // Evaluate synchronously, then return a Send future. Raw GSS handles are
        // never marked Send/Sync and never used concurrently or moved to a worker.
        std::future::ready(self.step(mechanism, input, mic))
    }
}

impl Drop for Kerberos {
    fn drop(&mut self) {
        // SAFETY: unique owned handles, initialized to GSS_C_NO_* (null). Delete
        // also releases partially initialized contexts after errors. No output
        // token is requested on deletion. GSS sets released handles to null.
        unsafe {
            if !self.context.is_null() {
                gss_delete_sec_context(&mut 0, &mut self.context, ptr::null_mut());
            }
            if !self.name.is_null() {
                gss_release_name(&mut 0, &mut self.name);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_advertised_kerberos_mechanism_is_allowed() {
        assert!(mechanism_ok(KERBEROS_DER).is_ok());
        assert!(mechanism_ok(&[0x06, 0x06, 0x2b, 0x06, 0x01, 0x05, 0x05, 0x02]).is_err());
        assert!(mechanism_ok(&[]).is_err());
    }
    #[test]
    fn c_abi_layout_has_pointer_alignment_and_uint32_oid_length() {
        assert_eq!(
            std::mem::size_of::<Buffer>(),
            2 * std::mem::size_of::<usize>()
        );
        assert_eq!(
            std::mem::offset_of!(Oid, elements),
            std::mem::size_of::<usize>()
        );
        assert_eq!(
            std::mem::align_of::<Oid>(),
            std::mem::align_of::<*mut c_void>()
        );
    }
}

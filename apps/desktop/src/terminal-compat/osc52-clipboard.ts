/**
 * OSC 52 (`OSC 52 ; Pc ; Pd ST`) policy for untrusted terminal output.
 *
 * - `Pd = ?` (read the clipboard) is always denied in P0 and never answered.
 * - Writes need an explicit per-session opt-in; without it nothing is decoded.
 * - Opted-in writes accept at most OSC52_MAX_BASE64 characters of canonical
 *   base64 that decode to UTF-8 text without control characters other than
 *   TAB/CR/LF, so a host cannot plant escape sequences for a later paste.
 * Content is never logged or included in notices.
 */

/** Upper bound of the base64 payload (1 MiB of characters, at most 768 KiB decoded). */
export const OSC52_MAX_BASE64 = 1024 * 1024;
/** Longest accepted selection-target list (`Pc`). */
const MAX_TARGETS = 16;
/** Selection targets defined by xterm: clipboard, primary, secondary, select, cut buffers 0–7. */
const TARGETS = /^[cpqs0-7]*$/;
/** Base64 alphabet with at most two trailing pads; the length is checked separately. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
// C0 controls except HT, LF and CR; DEL; C1 controls.
const UNSAFE_TEXT = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/;

export type Osc52Request =
  | { readonly kind: "query" }
  | { readonly kind: "write"; readonly payload: string }
  | { readonly kind: "invalid" };

export type Osc52Decoded =
  | { readonly kind: "text"; readonly text: string; readonly bytes: number }
  | { readonly kind: "rejected"; readonly reason: "too-large" | "invalid" };

/** Cheap classification that never decodes the payload. */
export function classifyOsc52(data: string): Osc52Request {
  const separator = data.indexOf(";");
  if (separator < 0 || separator > MAX_TARGETS || !TARGETS.test(data.slice(0, separator))) return { kind: "invalid" };
  const payload = data.slice(separator + 1);
  return payload === "?" ? { kind: "query" } : { kind: "write", payload };
}

/** Validate and decode an opted-in write payload. */
export function decodeOsc52(payload: string): Osc52Decoded {
  if (payload.length > OSC52_MAX_BASE64) return { kind: "rejected", reason: "too-large" };
  // An empty payload asks xterm to clear the selection; clearing is not offered.
  if (!payload || payload.length % 4 !== 0 || !BASE64.test(payload)) return { kind: "rejected", reason: "invalid" };
  let binary: string;
  try {
    binary = atob(payload);
  } catch {
    return { kind: "rejected", reason: "invalid" };
  }
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { kind: "rejected", reason: "invalid" };
  }
  if (UNSAFE_TEXT.test(text)) return { kind: "rejected", reason: "invalid" };
  return { kind: "text", text, bytes: bytes.length };
}

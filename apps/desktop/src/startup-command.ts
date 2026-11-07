/**
 * "Execute command after start" for local shells (T34). A configured command is typed into a newly
 * opened shell once: its UTF-8 bytes plus one CR, through the session's ordinary input queue. Nothing
 * here waits for a prompt, first output or a delay, and nothing decides whether the command ran or
 * succeeded; the shell's own output and exit code are that feedback.
 *
 * The command value lives only in the session's in-memory launch snapshot. It is never part of a
 * status text, notice, error message, log, storage or URL; validation messages never echo it.
 */

import { DEFAULT_ENCODING, encodeText, encodingLabel, type EncodingId } from "./text-encoding";

/**
 * Bytes in the session encoding (UTF-8 by default), without the CR that submits the line. Below
 * macOS's 1024-byte canonical line limit.
 */
export const STARTUP_COMMAND_MAX_BYTES = 1000;

/**
 * One-shot delivery state of a session's startup command. It only moves forward:
 * `pending` → `queued` → `submitted` | `not-sent` | `unconfirmed`, or `pending` → `not-sent`.
 * `none` means the session has no command.
 */
export type StartupState = "none" | "pending" | "queued" | "submitted" | "not-sent" | "unconfirmed";

const NEXT: Readonly<Record<StartupState, readonly StartupState[]>> = Object.freeze({
  none: [],
  pending: ["queued", "not-sent"],
  queued: ["submitted", "not-sent", "unconfirmed"],
  submitted: [],
  "not-sent": [],
  unconfirmed: [],
});

/** The state after `to` was reported; a step backwards or out of a final state is ignored. */
export function advanceStartup(from: StartupState, to: StartupState): StartupState {
  return NEXT[from].includes(to) ? to : from;
}

/** What the status bar shows next to the lifecycle status. Never contains the command. */
export function startupNotice(state: StartupState): string {
  switch (state) {
    case "submitted":
      return "启动命令已提交";
    case "not-sent":
      return "启动命令未发送";
    case "unconfirmed":
      return "启动命令发送未确认";
    default:
      return "";
  }
}

/** The text typed into the shell: the command as written, then CR (the Return key). */
export function startupCommandLine(command: string): string {
  return `${command}\r`;
}

/** Its UTF-8 bytes; a session encodes the line with its own encoding, identical for UTF-8. */
export function startupCommandBytes(command: string): Uint8Array {
  return new TextEncoder().encode(startupCommandLine(command));
}

/**
 * The byte limit in the session encoding, where the shell's line limit applies. For an encoding
 * other than UTF-8 the command must also be representable in it. Never echoes the value.
 */
function validateEncodedLength(value: string, encoding: EncodingId): string | null {
  const encoded = encodeText(encoding, value);
  if (!encoded.ok)
    return `启动后执行命令中有 ${encoded.unencodable} 个字符无法用 ${encodingLabel(encoding)} 表示；请修改命令或选择其他字符编码。`;
  const bytes = encoded.bytes.length;
  if (bytes <= STARTUP_COMMAND_MAX_BYTES) return null;
  return encoding === DEFAULT_ENCODING
    ? `启动后执行命令最多 ${STARTUP_COMMAND_MAX_BYTES} UTF-8 字节，当前为 ${bytes.toLocaleString()} 字节。`
    : `启动后执行命令按 ${encodingLabel(encoding)} 编码后最多 ${STARTUP_COMMAND_MAX_BYTES} 字节，当前为 ${bytes.toLocaleString()} 字节。`;
}

const LINE_BREAK = /[\r\n]/;
const TAB = /\t/;
// C0 controls, DEL and C1 controls (including NEL U+0085).
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
// Embedding/override (U+202A–U+202E) and isolate (U+2066–U+2069) controls reorder what is shown.
const BIDI = /[‪-‮⁦-⁩]/;

function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++;
      else return true;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}

/**
 * Checks the form value for a session in `encoding` (UTF-8 unless given). Empty means "no
 * command". Returns a message that never contains the value, or null when it may be used exactly
 * as written (no trimming, quoting or expansion).
 */
export function validateStartupCommand(value: string, encoding: EncodingId = DEFAULT_ENCODING): string | null {
  if (value === "") return null;
  if (LINE_BREAK.test(value))
    return "启动后执行命令只能是一行，不能包含换行（粘贴的多行文本也会被拒绝）；多条命令请用所选 Shell 的连接语法写在一行。";
  if (TAB.test(value)) return "启动后执行命令不能包含制表符。";
  if (CONTROL.test(value)) return "启动后执行命令不能包含控制字符（U+0000–U+001F、U+007F–U+009F）。";
  if (hasLoneSurrogate(value)) return "启动后执行命令包含无法编码的字符（孤立的代理项）。";
  if (BIDI.test(value)) return "启动后执行命令不能包含双向文本控制字符（U+202A–U+202E、U+2066–U+2069）。";
  if (/^\s+$/u.test(value)) return "启动后执行命令不能只包含空白；留空表示不发送命令。";
  return validateEncodedLength(value, encoding);
}

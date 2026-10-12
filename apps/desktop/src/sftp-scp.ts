// Legacy SCP transfers from the SFTP file panel (WindTerm F08/F09 prototype).
// The panel's grant carries them: every transfer reconnects, pins the host
// key and authenticates again in Rust. These helpers only shape the IPC call
// and the wording; the backend re-validates everything.
import { hexUtf8, type IpcChannel } from "./sftp-write";

export const SCP_OPTION_LABEL = "用旧版 SCP 协议传输单个文件";
export const SCP_NOTE =
  "SCP 是旧协议，与 SFTP 分开实现：一次一个普通文件，不支持目录。上传直接写入目标文件名，同名文件会被替换，没有临时文件；下载与 SFTP 相同，保存到“下载”文件夹、不覆盖已有文件。";
export const SCP_UPLOAD_CANCELLED = "已取消；SCP 直接写入目标文件名，远端可能留下不完整的文件，请刷新核对。";

export interface ScpUploadArgs {
  grantToken: string;
  scopeToken: string;
  operationId: string;
  path: string;
  onAuth?: IpcChannel;
  onProgress?: IpcChannel;
}

/**
 * Header contract of `ssh_scp_upload`: that of `ssh_sftp_upload` without
 * `x-sftp-overwrite`, because SCP cannot refuse to replace a file. The body
 * is the raw file bytes.
 */
export function scpUploadHeaders(args: ScpUploadArgs): Record<string, string> {
  const headers: Record<string, string> = {
    "x-sftp-grant": args.grantToken,
    "x-sftp-scope": args.scopeToken,
    "x-sftp-operation": args.operationId,
    "x-sftp-path": hexUtf8(args.path),
  };
  if (args.onAuth) headers["x-sftp-on-auth"] = args.onAuth.toJSON();
  if (args.onProgress) headers["x-sftp-on-progress"] = args.onProgress.toJSON();
  return headers;
}

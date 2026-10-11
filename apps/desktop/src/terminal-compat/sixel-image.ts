/**
 * Isolated P0 experiment for T09 (VT340 SIXEL). Not wired into production
 * terminals.
 *
 * Loads the official @xterm/addon-image 0.9.0 (published from the same commit
 * as @xterm/xterm 6.0.0) with SIXEL only and limits tighter than the addon
 * defaults. The constructor is injected so this module stays type-only, like
 * the other terminal-compat experiments; the caller decides where the runtime
 * comes from. Findings are recorded in docs/p0/TERMINAL_CORE_ADR.zh-CN.md.
 */
import type { Terminal } from "@xterm/xterm";
import type { IImageAddonOptions, ImageAddon } from "@xterm/addon-image";

export type ImageAddonConstructor = new (options?: Partial<IImageAddonOptions>) => ImageAddon;

/** Prototype limits. Every value is a decision to revisit before production. */
export const SIXEL_LIMITS: Readonly<IImageAddonOptions> = Object.freeze({
  // Keep XTWINOPS pixel/char size reports closed unless a policy opens them (VT matrix D08).
  enableSizeReports: false,
  // 2048 x 2048 RGBA = 16 MiB per decoded image (addon default 4096 x 4096 = 64 MiB).
  pixelLimit: 2048 * 2048,
  // Raw SIXEL bytes accepted per DCS sequence (addon default 25,000,000).
  sixelSizeLimit: 4 * 1024 * 1024,
  sixelPaletteLimit: 256,
  sixelScrolling: true,
  sixelSupport: true,
  // FIFO image cache per terminal in MB (addon default 128).
  storageLimit: 32,
  showPlaceholder: true,
  // OSC 1337 hands PNG/JPEG/GIF bytes to the WebView's native image decoders; off until needed.
  iipSupport: false,
});

export type SixelAttachResult =
  | { status: "ready"; addon: ImageAddon }
  | { status: "wasm-blocked"; reason: string }
  | { status: "decoder-timeout" };

// The smallest valid module: magic number plus version 1.
const EMPTY_WASM_MODULE = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
const DECODER_POLL_MS = 5;

/** The SIXEL decoder is WebAssembly; a CSP without 'wasm-unsafe-eval' refuses to compile it. */
export async function wasmCompileAllowed(): Promise<{ allowed: boolean; reason: string }> {
  try {
    await WebAssembly.compile(EMPTY_WASM_MODULE);
    return { allowed: true, reason: "" };
  } catch (error) {
    return { allowed: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Loads the addon only when its decoder can actually run, so DA1 never
 * advertises SIXEL (parameter 4) for a terminal that would silently drop images.
 * A decoder that is not ready in time unloads the addon, which also removes its
 * DA1 and XTSMGRAPHICS handlers.
 */
export async function attachSixel(
  terminal: Terminal,
  Addon: ImageAddonConstructor,
  overrides: Partial<IImageAddonOptions> = {},
  timeoutMs = 2000,
): Promise<SixelAttachResult> {
  const wasm = await wasmCompileAllowed();
  if (!wasm.allowed) return { status: "wasm-blocked", reason: wasm.reason };
  const addon = new Addon({ ...SIXEL_LIMITS, ...overrides });
  terminal.loadAddon(addon);
  if (await waitForDecoder(addon, timeoutMs)) return { status: "ready", addon };
  addon.dispose();
  return { status: "decoder-timeout" };
}

/**
 * addon-image 0.9.0 instantiates its decoder asynchronously and silently drops
 * any SIXEL that arrives first. It exposes no readiness signal, so the
 * prototype polls a private field; production code must not rely on this.
 */
export async function waitForDecoder(addon: ImageAddon, timeoutMs: number): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (!decoderLoaded(addon)) {
    if (performance.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, DECODER_POLL_MS));
  }
  return true;
}

export function decoderLoaded(addon: ImageAddon): boolean {
  const handlers = (addon as unknown as { _handlers?: Map<string, { _dec?: unknown }> })._handlers;
  return handlers?.get("sixel")?._dec !== undefined;
}

import { Terminal, type ITheme } from "@xterm/xterm";
import { Unicode11Addon } from "@xterm/addon-unicode11";

/** Keep every workspace terminal on the same tested character-width provider. */
export function createWorkspaceTerminal(theme?: ITheme): Terminal {
  const terminal = new Terminal({
    cursorBlink: true,
    fontFamily: '"SFMono-Regular", Menlo, Monaco, "Cascadia Code", monospace',
    fontSize: 14,
    lineHeight: 1.45,
    scrollback: 5000,
    theme,
    // The official Unicode provider API is still marked experimental in xterm 6.
    allowProposedApi: true,
    screenReaderMode: true,
  });
  terminal.loadAddon(new Unicode11Addon());
  terminal.unicode.activeVersion = "11";
  return terminal;
}

/** Isolated P0 experiment; deliberately not connected to a production terminal. */
export interface Vt52Diagnostic {
  code: 'clean-state-required' | 'unsupported' | 'cancelled' | 'invalid-coordinate' | 'csi-limit' | 'truncated';
  byteOffset: number;
  detail: string;
}

export interface Vt52Result {
  output: Uint8Array;
  /** Original bytes consumed, never the translated output length. */
  inputBytes: number;
  diagnostics: Vt52Diagnostic[];
}

export class Vt52Stream {
  private mode: 'ansi' | 'vt52' = 'ansi';
  private ansiState: 'ground' | 'escape' | 'intermediate' | 'csi' | 'osc' | 'string' = 'ground';
  private csi = '';
  private csiOverflow = false;
  private pending: number[] = [];
  private offset = 0;

  reset(): void {
    this.mode = 'ansi';
    this.ansiState = 'ground';
    this.csi = '';
    this.csiOverflow = false;
    this.pending = [];
    this.offset = 0;
  }

  push(input: Uint8Array): Vt52Result {
    const output: number[] = [];
    const diagnostics: Vt52Diagnostic[] = [];
    for (const byte of input) {
      if (this.mode === 'ansi') {
        // ANSI bytes are emitted immediately: pending recognition never withholds a PTY chunk.
        output.push(byte);
        this.trackAnsi(byte, diagnostics);
      } else {
        this.translateVt52(byte, output, diagnostics);
      }
      this.offset++;
    }
    return { output: Uint8Array.from(output), inputBytes: input.length, diagnostics };
  }

  finish(): Vt52Result {
    const diagnostics: Vt52Diagnostic[] = [];
    if (this.pending.length || this.ansiState !== 'ground') {
      diagnostics.push({ code: 'truncated', byteOffset: this.offset, detail: 'End of input inside a control sequence; untranslated VT52 bytes are flushed.' });
    }
    const output = Uint8Array.from(this.pending);
    this.reset();
    return { output, inputBytes: 0, diagnostics };
  }

  private trackAnsi(byte: number, diagnostics: Vt52Diagnostic[]): void {
    if (byte === 0x1b) {
      this.ansiState = 'escape';
      this.csi = '';
      return;
    }
    if (byte === 0x18 || byte === 0x1a) {
      this.ansiState = 'ground';
      this.csi = '';
      return;
    }
    if (this.ansiState === 'osc' || this.ansiState === 'string') {
      if (this.ansiState === 'osc' && byte === 0x07) this.ansiState = 'ground';
      return;
    }
    if (this.ansiState === 'escape') {
      if (byte < 0x20 || byte === 0x7f) return;
      if (byte === 0x5b) {
        this.ansiState = 'csi'; this.csi = ''; this.csiOverflow = false;
      } else if (byte === 0x5d) {
        this.ansiState = 'osc';
      } else if ([0x50, 0x58, 0x5e, 0x5f].includes(byte)) {
        this.ansiState = 'string';
      } else {
        this.ansiState = byte >= 0x20 && byte <= 0x2f ? 'intermediate' : 'ground';
      }
      return;
    }
    if (this.ansiState === 'intermediate') {
      if (byte >= 0x30 && byte !== 0x7f) this.ansiState = 'ground';
      return;
    }
    if (this.ansiState !== 'csi') return;
    if (!this.csiOverflow) {
      if (this.csi.length === 128) {
        this.csiOverflow = true;
        this.csi = '';
        diagnostics.push({ code: 'csi-limit', byteOffset: this.offset, detail: 'CSI recognition exceeded 128 bytes; bytes remain untouched.' });
      } else {
        this.csi += String.fromCharCode(byte);
      }
    }
    if (byte >= 0x40 && byte <= 0x7e) {
      if (!this.csiOverflow && this.csi === '?2l') {
        this.mode = 'vt52';
        diagnostics.push({ code: 'clean-state-required', byteOffset: this.offset, detail: 'PoC assumes default ANSI origin, margins, insert, wrap and charset state; inherited modes are not normalized.' });
      }
      this.ansiState = 'ground';
      this.csi = '';
    } else if (byte >= 0x80) {
      this.ansiState = 'ground';
      this.csi = '';
    }
  }

  private translateVt52(byte: number, output: number[], diagnostics: Vt52Diagnostic[]): void {
    if (byte === 0x1b || byte === 0x18 || byte === 0x1a) {
      if (this.pending.length) {
        diagnostics.push({ code: 'cancelled', byteOffset: this.offset, detail: 'Incomplete VT52 control cancelled by ESC, CAN or SUB.' });
      }
      this.pending = byte === 0x1b ? [byte] : [];
      if (byte !== 0x1b) output.push(byte);
      return;
    }
    if (!this.pending.length) { output.push(byte); return; }
    if (byte < 0x20) { output.push(byte); return; }
    if (this.pending.length === 1) {
      if (byte === 0x59) { this.pending.push(byte); return; }
      const command = String.fromCharCode(byte);
      const controls: Record<string, string> = { A: '\x1b[A', B: '\x1b[B', C: '\x1b[C', D: '\x1b[D', H: '\x1b[H', I: '\x1bM', J: '\x1b[J', K: '\x1b[K' };
      if (command === '<') {
        this.mode = 'ansi';
      } else if (controls[command]) {
        for (const char of controls[command]) output.push(char.charCodeAt(0));
      } else {
        diagnostics.push({ code: 'unsupported', byteOffset: this.offset, detail: `VT52 ESC ${command} is not implemented; no device response or mode change is synthesized.` });
        // Do not send known unsupported commands to xterm: ESC Z would produce a false identity.
        if (!['F', 'G', '=', '>', 'Z'].includes(command)) output.push(...this.pending, byte);
      }
      this.pending = [];
      return;
    }
    if (byte > 0x7f) {
      diagnostics.push({ code: 'invalid-coordinate', byteOffset: this.offset, detail: 'PoC accepts 7-bit VT52 coordinates only; untranslated bytes are flushed.' });
      output.push(...this.pending, byte);
      this.pending = [];
      return;
    }
    this.pending.push(byte);
    if (this.pending.length === 4) {
      const address = `\x1b[${this.pending[2] - 0x1f};${this.pending[3] - 0x1f}H`;
      for (const char of address) output.push(char.charCodeAt(0));
      this.pending = [];
    }
  }
}

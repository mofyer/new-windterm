/**
 * The bell's sound style: one short tone synthesised with Web Audio. No audio file is loaded,
 * bundled or fetched, and the system alert sound is not used, so the volume does not follow the
 * system alert volume. The AudioContext is created lazily, only once the sound style is in use.
 *
 * A WebView may keep a new AudioContext suspended until the page sees a user gesture. A tone is
 * played only if the context runs now or within {@link BELL_RESUME_WAIT_MS}; a suspended bell is
 * dropped rather than queued, because a late tone would belong to no visible event.
 */

/** Tone shape; chosen for this project, not taken from upstream. */
const TONE_HZ = 880;
const TONE_SECONDS = 0.12;
const TONE_PEAK_GAIN = 0.12;
const SILENT_GAIN = 0.0001;
/** At most one tone in this window across all sessions: one speaker, no chorus of tabs. */
export const BELL_SOUND_FLOOR_MS = 400;
/** How long a bell waits for a suspended context to resume before it is dropped. */
export const BELL_RESUME_WAIT_MS = 250;

export type SoundBlock = "unsupported" | "suspended";

export interface BellSound {
  /** One tone unless another started within the floor; `blocked` reports a dropped tone. */
  play(): void;
  /** Called from a user gesture: creates or resumes the context so later bells can sound. */
  unlock(): void;
  /** Whether a gesture could still help: the context is missing or not running. */
  readonly locked: boolean;
}

type AudioContextClass = new () => AudioContext;

export function createBellSound(
  blocked: (reason: SoundBlock) => void,
  now: () => number = () => performance.now(),
): BellSound {
  let context: AudioContext | undefined;
  let unsupported = false;
  let lastTone = -Infinity;

  function ensure(): AudioContext | undefined {
    if (context?.state === "closed") context = undefined;
    if (context || unsupported) return context;
    const Context = (globalThis as { AudioContext?: AudioContextClass }).AudioContext;
    if (typeof Context !== "function") {
      unsupported = true;
      return undefined;
    }
    try {
      context = new Context();
    } catch {
      unsupported = true;
    }
    return context;
  }
  function tone(ctx: AudioContext) {
    const at = ctx.currentTime;
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(TONE_HZ, at);
    gain.gain.setValueAtTime(SILENT_GAIN, at);
    gain.gain.exponentialRampToValueAtTime(TONE_PEAK_GAIN, at + 0.005);
    gain.gain.exponentialRampToValueAtTime(SILENT_GAIN, at + TONE_SECONDS);
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.onended = () => {
      oscillator.disconnect();
      gain.disconnect();
    };
    oscillator.start(at);
    oscillator.stop(at + TONE_SECONDS + 0.01);
  }
  /** Resolves once the context resumed or the wait ran out; never rejects. */
  function resume(ctx: AudioContext): Promise<void> {
    return Promise.race([
      ctx.resume().catch(() => undefined),
      new Promise<void>((resolve) => window.setTimeout(resolve, BELL_RESUME_WAIT_MS)),
    ]);
  }
  function play() {
    const asked = now();
    if (asked - lastTone < BELL_SOUND_FLOOR_MS) return;
    // Counted even if the tone is dropped below, so a blocked context is not retried per BEL.
    lastTone = asked;
    const ctx = ensure();
    if (!ctx) {
      blocked("unsupported");
      return;
    }
    if (ctx.state === "running") {
      tone(ctx);
      return;
    }
    void resume(ctx).then(() => {
      if (ctx.state === "running" && now() - asked <= BELL_RESUME_WAIT_MS) tone(ctx);
      else blocked("suspended");
    });
  }
  function unlock() {
    const ctx = ensure();
    if (ctx && ctx.state !== "running") void ctx.resume().catch(() => undefined);
  }
  return {
    play: () => {
      try {
        play();
      } catch {
        blocked("unsupported");
      }
    },
    unlock: () => {
      try {
        unlock();
      } catch {
        /* A context that cannot resume reports itself on the next bell. */
      }
    },
    get locked() {
      return !unsupported && context?.state !== "running";
    },
  };
}

// Minimal W3C WebDriver client on Node's built-in fetch. It talks to
// tauri-driver, which forwards to WebKitWebDriver (Linux) or msedgedriver
// (Windows). No npm dependency; only the commands the native smoke needs.

/** W3C web element identifier key. */
export const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';

/** WebDriver key codes (W3C "Keys" table) used by the smoke. */
export const Keys = Object.freeze({ ENTER: '', BACKSPACE: '', TAB: '', ESCAPE: '' });

const DEFAULT_TIMEOUT_MS = 60_000;

/** A WebDriver error response (`{ value: { error, message } }`) or a transport failure. */
export class WebDriverError extends Error {
  constructor({ status = 0, error = 'unknown error', message = '', command = '' } = {}) {
    super(`${command ? `${command}: ` : ''}${error}${message ? ` — ${message}` : ''}`);
    this.name = 'WebDriverError';
    this.status = status;
    this.error = error;
    this.command = command;
  }
}

/** Reads the element reference from a W3C (or legacy JSONWP) element object. */
export function elementId(value) {
  const id = value?.[ELEMENT_KEY] ?? value?.ELEMENT;
  if (typeof id !== 'string' || !id) throw new WebDriverError({ error: 'no such element', message: 'response has no element reference' });
  return id;
}

/**
 * Polls `probe` until it returns a truthy value; throws with `description` on timeout.
 * A thrown error is retried (the page may be mid-navigation) unless it has `fatal: true`.
 */
export async function waitFor(probe, { timeoutMs = 20_000, intervalMs = 200, description = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  for (;;) {
    try {
      const result = await probe();
      if (result) return result;
      lastError = undefined;
    } catch (error) {
      if (error?.fatal) throw error;
      lastError = error;
    }
    if (Date.now() >= deadline) {
      const detail = lastError ? `; last error: ${lastError.message}` : '';
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${description}${detail}`);
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

/** One key action sequence that types `text` (each code point down then up). */
export function keyActions(text) {
  const actions = [];
  for (const key of text) actions.push({ type: 'keyDown', value: key }, { type: 'keyUp', value: key });
  return { actions: [{ type: 'key', id: 'p0-keyboard', actions }] };
}

/**
 * Creates a client for one remote end, e.g. `createWebDriver('http://127.0.0.1:4444')`.
 * `fetchImpl` is injectable for tests; `timeoutMs` bounds every HTTP request.
 */
export function createWebDriver(baseUrl, { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = globalThis.fetch } = {}) {
  const root = String(baseUrl).replace(/\/+$/, '');

  async function command(method, path, body, { timeout = timeoutMs } = {}) {
    const label = `${method} ${path}`;
    let response;
    try {
      response = await fetchImpl(`${root}${path}`, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json; charset=utf-8' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (error) {
      throw new WebDriverError({ error: error?.name === 'TimeoutError' ? 'timeout' : 'transport error', message: String(error?.message ?? error), command: label });
    }
    const text = await response.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      throw new WebDriverError({ status: response.status, error: 'invalid response', message: text.slice(0, 200), command: label });
    }
    const value = payload?.value;
    // W3C errors use 4xx/5xx; a legacy JSON Wire remote end answers 200 with a non-zero status.
    const legacyFailure = typeof payload?.status === 'number' && payload.status !== 0;
    if (!response.ok || legacyFailure) {
      throw new WebDriverError({ status: response.status, error: value?.error ?? `HTTP ${response.status}`, message: value?.message ?? '', command: label });
    }
    return value === undefined ? null : value;
  }

  const session = (id) => {
    const at = (suffix) => `/session/${encodeURIComponent(id)}${suffix}`;
    const element = (eid, suffix) => at(`/element/${encodeURIComponent(eid)}${suffix}`);
    return Object.freeze({
      id,
      findElement: async (css) => elementId(await command('POST', at('/element'), { using: 'css selector', value: css })),
      findElements: async (css) => (await command('POST', at('/elements'), { using: 'css selector', value: css })).map(elementId),
      click: (eid) => command('POST', element(eid, '/click'), {}),
      clear: (eid) => command('POST', element(eid, '/clear'), {}),
      sendKeys: (eid, text) => command('POST', element(eid, '/value'), { text }),
      getText: (eid) => command('GET', element(eid, '/text')),
      execute: (script, args = []) => command('POST', at('/execute/sync'), { script, args }),
      performKeys: (text) => command('POST', at('/actions'), keyActions(text)),
      releaseActions: () => command('DELETE', at('/actions')),
      setTimeouts: (timeouts) => command('POST', at('/timeouts'), timeouts),
      title: () => command('GET', at('/title')),
      screenshot: async () => Buffer.from(await command('GET', at('/screenshot')), 'base64'),
      delete: () => command('DELETE', at('')),
    });
  };

  return Object.freeze({
    status: () => command('GET', '/status'),
    /** Starts a session; resolves to `{ session, capabilities }`. */
    async newSession(capabilities, { timeout = 120_000 } = {}) {
      const value = await command('POST', '/session', { capabilities }, { timeout });
      if (typeof value?.sessionId !== 'string' || !value.sessionId)
        throw new WebDriverError({ error: 'session not created', message: 'response has no sessionId', command: 'POST /session' });
      return { session: session(value.sessionId), capabilities: value.capabilities ?? {} };
    },
  });
}

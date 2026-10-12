// Child processes for the native smoke: tauri-driver and the loopback russh
// SSH fixture. Every process started here is stopped by the caller's cleanup.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createWriteStream, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { extname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/** Resolves to `value` after `ms` without keeping the event loop alive (for races). */
const timeout = (ms, value) => delay(ms, value, { ref: false });

/** Resolves a binary path; on Windows a missing `.exe` suffix is added when that file exists. */
export function resolveExecutable(path, platform = process.platform, exists = existsSync) {
  const absolute = resolve(path);
  if (platform === 'win32' && !extname(absolute) && exists(`${absolute}.exe`)) return `${absolute}.exe`;
  return absolute;
}

/** An unused loopback TCP port (released before it is returned). */
export async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  server.close();
  await once(server, 'close');
  return port;
}

/**
 * Parses the `key=value` banner the `ssh_terminal_fixture` binary prints.
 * Returns undefined until every required field has arrived.
 */
export function parseFixtureBanner(text) {
  const fields = {};
  const output = String(text);
  // Only newline-terminated lines: a pipe read can end in the middle of the fingerprint.
  for (const line of output.slice(0, output.lastIndexOf('\n') + 1).split(/\r?\n/)) {
    const match = /^([A-Za-z]+)=(.*)$/.exec(line);
    if (match) fields[match[1]] = match[2].trim();
  }
  const port = Number(fields.port);
  const complete = fields.host && Number.isInteger(port) && port > 0 && port < 65536
    && fields.username && fields.privateKeyPath && /^SHA256:\S+$/.test(fields.fingerprint ?? '');
  return complete
    ? Object.freeze({ host: fields.host, port, username: fields.username, privateKeyPath: fields.privateKeyPath, fingerprint: fields.fingerprint })
    : undefined;
}

/** Spawns `command` with stdout/stderr appended to `logPath`; keeps a bounded in-memory tail. */
export function spawnLogged(command, args, logPath, { stdin = 'ignore', ...options } = {}) {
  const log = createWriteStream(logPath, { flags: 'a' });
  const child = spawn(command, args, { ...options, stdio: [stdin, 'pipe', 'pipe'] });
  let tail = '';
  let logOpen = true;
  const keep = (chunk) => {
    if (logOpen) log.write(chunk);
    tail = (tail + String(chunk)).slice(-16_384);
  };
  // A failed spawn may never emit 'close', so whichever ends first closes the log once.
  const closeLog = (text) => {
    if (logOpen) log.end(text);
    logOpen = false;
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  let finish;
  let spawnError;
  const exited = new Promise(resolveExit => { finish = resolveExit; });
  child.on('error', (error) => {
    spawnError = error;
    tail = `${tail}\n[spawn error] ${error.message}\n`.slice(-16_384);
    closeLog(`\n[spawn error] ${error.message}\n`);
    finish({ code: null, signal: null, error: error.message });
  });
  child.on('close', (code, signal) => {
    closeLog(`\n[exit] code=${code} signal=${signal}\n`);
    finish({ code, signal });
  });
  const running = () => !spawnError && child.exitCode === null && child.signalCode === null;
  return { child, exited, running, tail: () => tail };
}

/** Stops a spawned process (its whole process group on Unix when it leads one). */
export async function stopProcess(handle, { graceMs = 5_000 } = {}) {
  if (!handle) return undefined;
  const { child, exited } = handle;
  if (!handle.running()) return exited;
  const signal = (name) => {
    try {
      if (process.platform !== 'win32' && handle.group) process.kill(-child.pid, name);
      else child.kill(name);
    } catch {
      /* Already gone. */
    }
  };
  signal('SIGTERM');
  const result = await Promise.race([exited, timeout(graceMs, undefined)]);
  if (result) return result;
  signal('SIGKILL');
  return Promise.race([exited, timeout(graceMs, { code: null, signal: 'unreaped' })]);
}

/**
 * Starts tauri-driver on loopback. On Unix it leads its own process group, so
 * cleanup also reaches WebKitWebDriver and the app it launched; on Windows
 * tauri-driver puts itself in a kill-on-close Job Object.
 */
export function startTauriDriver({ binary, port, nativePort, nativeDriver, logPath }) {
  const args = ['--port', String(port), '--native-port', String(nativePort)];
  if (nativeDriver) args.push('--native-driver', nativeDriver);
  const group = process.platform !== 'win32';
  return { ...spawnLogged(binary, args, logPath, { detached: group }), group };
}

/** Starts the loopback russh fixture and waits for its connection banner. */
export async function startSshFixture({ binary, args = [], logPath, timeoutMs = 30_000 }) {
  const handle = spawnLogged(binary, args, logPath, { stdin: 'pipe' });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const info = parseFixtureBanner(handle.tail());
    if (info) return { ...handle, info };
    if (!handle.running())
      throw new Error(`SSH fixture exited before its banner:\n${handle.tail()}`);
    if (Date.now() >= deadline) {
      await stopProcess(handle);
      throw new Error(`SSH fixture banner deadline exceeded:\n${handle.tail()}`);
    }
    await delay(100);
  }
}

/** Asks the fixture to stop (a newline on stdin), then falls back to a signal. */
export async function stopSshFixture(fixture) {
  if (!fixture) return undefined;
  if (fixture.running()) {
    try {
      fixture.child.stdin.end('\n');
    } catch {
      /* stdin already closed */
    }
    const result = await Promise.race([fixture.exited, timeout(15_000, undefined)]);
    if (result) return { ...result, report: /Stopped;[^\n]*/.exec(fixture.tail())?.[0] ?? '' };
  }
  const result = await stopProcess(fixture);
  return { ...result, report: /Stopped;[^\n]*/.exec(fixture.tail())?.[0] ?? '' };
}

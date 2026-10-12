import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

// Drives the Rust X11 forwarding probe (`Ssh::open_with_x11`) against system
// OpenSSH with X11Forwarding and a private Xvfb that requires a generated
// cookie: the remote `xdpyinfo` must reach Xvfb through the forwarded
// display. Linux only. P0_X11_REQUIRED=1 (CI) turns a skip into a failure.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const XVFB = '/usr/bin/Xvfb';
const XAUTH = '/usr/bin/xauth';
const XDPYINFO = '/usr/bin/xdpyinfo';
const DIMENSIONS = '1234x567';
const tools = ['/usr/sbin/sshd', '/usr/bin/ssh', '/usr/bin/ssh-keygen', XVFB, XAUTH, XDPYINFO];
const available = process.platform === 'linux' && process.getuid?.() !== 0 && tools.every(existsSync);
const required = process.env.P0_X11_REQUIRED === '1';
const skip = available || required ? undefined : 'requires non-root Linux with OpenSSH sshd, Xvfb, xauth and xdpyinfo';

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return child?.exitCode;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  const [code] = await exited;
  clearTimeout(timer);
  return code;
}

test('Rust X11 forwarding: OpenSSH X11Forwarding, xdpyinfo reaches a cookie-protected Xvfb', { skip, timeout: 300_000 }, async () => {
  assert.ok(available, `X11 prerequisites missing on ${process.platform}: ${tools.filter(tool => !existsSync(tool)).join(', ')}`);
  const cargo = existsSync(join(process.env.HOME, '.cargo/bin/cargo')) ? join(process.env.HOME, '.cargo/bin/cargo') : 'cargo';
  // Same features as the CI test step, so its build is reused.
  const build = spawnSync(cargo, ['test', '--locked', '--all-features', '--manifest-path', join(root, 'apps/desktop/src-tauri/Cargo.toml'),
    '--lib', '--no-run', '--message-format=json'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  assert.equal(build.status, 0, build.stderr);
  const testBinary = build.stdout.split('\n').filter(Boolean).map(line => JSON.parse(line))
    .find(receipt => receipt.reason === 'compiler-artifact' && receipt.profile.test && receipt.executable)?.executable;
  assert.ok(testBinary, 'Cargo did not provide a Rust test executable');

  const directory = await mkdtemp(join(tmpdir(), 'p0-x11-'));
  const env = { PATH: '/usr/bin:/bin', HOME: directory, LANG: 'C', LC_ALL: 'C' };
  const xauth = (file, ...args) => spawnSync(XAUTH, ['-q', '-f', file, ...args], { env, encoding: 'utf8', timeout: 10_000 });
  const xdpyinfo = (display, authority) => spawnSync(XDPYINFO, ['-display', display],
    { env: { ...env, XAUTHORITY: authority }, encoding: 'utf8', timeout: 10_000 });
  const cookie = randomBytes(16).toString('hex');
  const serverAuthority = join(directory, 'server.xauth');
  const clientAuthority = join(directory, 'client.xauth');
  let xvfb;
  let fixture;
  let metadata;
  let fixtureErrors = '';
  try {
    // The X server loads every cookie in its -auth file, whatever display it names.
    assert.equal(xauth(serverAuthority, 'add', ':0', '.', cookie).status, 0);
    xvfb = spawn(XVFB, ['-displayfd', '3', '-screen', '0', `${DIMENSIONS}x24`, '-auth', serverAuthority, '-nolisten', 'tcp'],
      { cwd: directory, env, stdio: ['ignore', 'ignore', 'pipe', 'pipe'] });
    let xvfbErrors = '';
    let reported = '';
    xvfb.stderr.on('data', data => { xvfbErrors += String(data); });
    xvfb.stdio[3].on('data', data => { reported += String(data); });
    for (let attempt = 0; attempt < 200 && !/^\d+\n/.test(reported); attempt++) {
      assert.equal(xvfb.exitCode, null, `Xvfb exited: ${xvfbErrors}`);
      await delay(50);
    }
    const number = reported.match(/^(\d+)\n/)?.[1];
    assert.ok(number, `Xvfb did not report its display: ${xvfbErrors}`);
    const display = `:${number}`;
    assert.equal(xauth(clientAuthority, 'add', display, '.', cookie).status, 0);
    // Xvfb enforces the cookie, so only a substituted real cookie can pass.
    assert.notEqual(xdpyinfo(display, join(directory, 'missing.xauth')).status, 0, 'Xvfb accepted a client without the cookie');
    const local = xdpyinfo(display, clientAuthority);
    assert.equal(local.status, 0, local.stderr);
    assert.match(local.stdout, new RegExp(`dimensions:\\s+${DIMENSIONS} pixels`));

    fixture = spawn(process.execPath, [fileURLToPath(new URL('./fixture.mjs', import.meta.url)), '--serve', '--x11'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let fixtureOutput = '';
    fixture.stdout.on('data', data => { fixtureOutput += String(data); });
    fixture.stderr.on('data', data => { fixtureErrors += String(data); });
    let metadataPath;
    for (let attempt = 0; attempt < 200 && !metadataPath; attempt++) {
      metadataPath = fixtureOutput.match(/connection metadata: (.+)/)?.[1];
      if (!metadataPath) { assert.equal(fixture.exitCode, null, fixtureErrors); await delay(50); }
    }
    assert.ok(metadataPath, `fixture readiness deadline exceeded: ${fixtureErrors}`);
    metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    assert.equal(metadata.x11, true);

    const result = spawnSync(testBinary, ['ssh::x11::tests::real_openssh_x11_forwarding', '--ignored', '--exact', '--nocapture'], {
      encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, DISPLAY: display, XAUTHORITY: clientAuthority,
        P0_SSH_FIXTURE_HOST: metadata.host, P0_SSH_FIXTURE_PORT: String(metadata.port),
        P0_SSH_FIXTURE_USER: metadata.username, P0_SSH_FIXTURE_KEY: metadata.privateKeyPath,
        P0_SSH_FIXTURE_FINGERPRINT: metadata.fingerprint, P0_X11_REAL_COOKIE: cookie, P0_X11_DIMENSIONS: DIMENSIONS },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /1 passed/);
    // The remote client used sshd's proxy display, not Xvfb's directly.
    const evidence = result.stdout.match(/P0_X11_OK .*/)?.[0];
    assert.match(evidence ?? '', new RegExp(`^P0_X11_OK localhost:\\d+\\.0 dimensions: ${DIMENSIONS} pixels`));
    console.log(evidence);
  } finally {
    if (fixture) assert.equal(await stop(fixture), 0, fixtureErrors);
    await stop(xvfb);
    if (metadata) await assert.rejects(access(metadata.rootDirectory), { code: 'ENOENT' });
    await rm(directory, { recursive: true, force: true });
  }
});

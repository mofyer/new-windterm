import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

// Drives the Rust `Ssh` service (probe, explicit trust, `ssh_open`, write,
// resize, ACK, exit) against the system OpenSSH PTY fixture. Not a WebView test.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const available = ['darwin', 'linux'].includes(process.platform)
  && process.getuid?.() !== 0
  && ['/usr/sbin/sshd', '/usr/bin/ssh', '/usr/bin/ssh-keygen'].every(existsSync);

test('Rust ssh_open: real OpenSSH shell, saved trust, UTF-8, window-change, Ctrl-C, exit 7', { skip: available ? undefined : 'requires non-root macOS/Linux with system OpenSSH', timeout: 120_000 }, async () => {
  const cargo = existsSync(join(process.env.HOME, '.cargo/bin/cargo')) ? join(process.env.HOME, '.cargo/bin/cargo') : 'cargo';
  // Compile before starting the fixture so a cold build is not a protocol timeout.
  const build = spawnSync(cargo, ['test', '--locked', '--manifest-path', join(root, 'apps/desktop/src-tauri/Cargo.toml'),
    '--lib', '--no-run', '--message-format=json'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  assert.equal(build.status, 0, build.stderr);
  const testBinary = build.stdout.split('\n').filter(Boolean).map(line => JSON.parse(line))
    .find(receipt => receipt.reason === 'compiler-artifact' && receipt.profile.test && receipt.executable)?.executable;
  assert.ok(testBinary, 'Cargo did not provide a Rust test executable');

  const fixture = spawn(process.execPath, [fileURLToPath(new URL('./fixture.mjs', import.meta.url)), '--serve'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  fixture.stdout.on('data', data => { stdout += String(data); });
  fixture.stderr.on('data', data => { stderr += String(data); });
  let metadata;
  const trustDirectory = await mkdtemp(join(tmpdir(), 'p0-trust-'));
  const store = join(trustDirectory, 'known_hosts');
  try {
    let metadataPath;
    for (let attempt = 0; attempt < 200 && !metadataPath; attempt++) {
      metadataPath = stdout.match(/connection metadata: (.+)/)?.[1];
      if (!metadataPath) { assert.equal(fixture.exitCode, null, stderr); await delay(50); }
    }
    assert.ok(metadataPath, `fixture readiness deadline exceeded: ${stderr}`);
    metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    const result = spawnSync(testBinary, ['ssh::terminal::tests::real_openssh_interactive_shell', '--ignored', '--exact', '--nocapture'], {
      encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, P0_SSH_FIXTURE_HOST: metadata.host, P0_SSH_FIXTURE_PORT: String(metadata.port),
        P0_SSH_FIXTURE_USER: metadata.username, P0_SSH_FIXTURE_KEY: metadata.privateKeyPath,
        P0_SSH_FIXTURE_FINGERPRINT: metadata.fingerprint, P0_SSH_TRUST_STORE: store },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /1 passed/);
    // System OpenSSH must accept the file the app saved, with strict checking
    // and no other trust source. The fixture then denies the remote command.
    const saved = await readFile(store, 'utf8');
    assert.match(saved, /^\[127\.0\.0\.1\]:\d+ ssh-ed25519 \S+\n$/);
    const openssh = spawnSync('/usr/bin/ssh', ['-F', '/dev/null', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
      '-o', 'IdentityAgent=none', '-o', 'GlobalKnownHostsFile=/dev/null', '-o', `UserKnownHostsFile=${store}`,
      '-o', 'StrictHostKeyChecking=yes', '-o', 'UpdateHostKeys=no', '-o', 'ConnectTimeout=3', '-o', 'LogLevel=ERROR',
      '-i', metadata.privateKeyPath, '-p', String(metadata.port), `${metadata.username}@127.0.0.1`, 'not-allowed'],
    { encoding: 'utf8', timeout: 15_000 });
    assert.doesNotMatch(openssh.stderr, /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/, openssh.stderr);
    assert.equal(openssh.status, 126, openssh.stderr);
  } finally {
    if (fixture.exitCode === null && fixture.signalCode === null) {
      const exited = once(fixture, 'exit');
      fixture.kill('SIGTERM');
      const [code] = await exited;
      assert.equal(code, 0, stderr);
    }
    if (metadata) await assert.rejects(access(metadata.rootDirectory), { code: 'ENOENT' });
    await rm(trustDirectory, { recursive: true, force: true });
  }
});

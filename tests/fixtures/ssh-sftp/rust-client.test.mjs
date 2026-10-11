import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { access, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

// Build first: cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml --bin ssh_probe
const root = fileURLToPath(new URL('../../../', import.meta.url));
// Compile outside the server lifecycle and protocol deadlines. Parse Cargo's
// artifact receipt so a cold build never masquerades as a connection timeout.
const build = spawnSync(join(process.env.HOME, '.cargo/bin/cargo'), [
  'test', '--manifest-path', join(root, 'apps/desktop/src-tauri/Cargo.toml'),
  '--lib', '--no-run', '--message-format=json',
], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
assert.equal(build.status, 0, build.stderr);
const testBinary = build.stdout.split('\n').filter(Boolean).map(line => JSON.parse(line))
  .find(receipt => receipt.reason === 'compiler-artifact' && receipt.profile.test && receipt.executable)?.executable;
assert.ok(testBinary, 'Cargo did not provide a Rust test executable');
// Separate server instances keep intentional pre-auth rejections from accumulating
// OpenSSH PerSourcePenalties. Server policy remains unchanged; no client retries.
for (const mismatchOnly of [false, true]) {
test(`Rust client: ${mismatchOnly ? 'reconnect host-key mismatch' : 'explicit trust, UTF-8, wrong client key'}`, { timeout: 45_000 }, async () => {
  const binary = join(root, 'apps/desktop/src-tauri/target/debug/ssh_probe');
  await access(binary);
  const fixture = spawn(process.execPath, [fileURLToPath(new URL('./fixture.mjs', import.meta.url)), '--serve'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let errors = '';
  fixture.stdout.on('data', data => { output += data; });
  fixture.stderr.on('data', data => { errors += data; });
  let metadataPath;
  try {
    for (let attempt = 0; attempt < 100 && !output.includes('connection metadata:'); attempt++) {
      assert.equal(fixture.exitCode, null, errors);
      await delay(100);
    }
    metadataPath = output.match(/connection metadata: (.+)/)?.[1];
    assert.ok(metadataPath, 'Fixture readiness deadline exceeded');
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    const fingerprintResult = spawnSync('/usr/bin/ssh-keygen', ['-lf', metadata.knownHostsPath, '-E', 'sha256'], { encoding: 'utf8', timeout: 2000 });
    assert.equal(fingerprintResult.status, 0);
    const fingerprint = fingerprintResult.stdout.trim().split(/\s+/)[1];
    assert.match(fingerprint, /^SHA256:/);
    function run(key, pin) {
      return spawnSync(binary, [metadata.host, String(metadata.port), metadata.username, key, pin], { encoding: 'utf8', timeout: 20_000, maxBuffer: 64 * 1024 });
    }
    if (!mismatchOnly) {
    const good = run(metadata.privateKeyPath, fingerprint);
    assert.equal(good.status, 0, good.stderr);
    assert.match(good.stdout, /UTF-8 output, exit 7/);
    const wrongPin = run(join(dirname(metadataPath), 'key-must-not-be-read'), 'SHA256:deliberately-wrong');
    assert.equal(wrongPin.status, 1);
    assert.match(wrongPin.stderr, /fingerprint does not match/);
    assert.doesNotMatch(wrongPin.stderr, /private key/);
    const wrongKey = run(join(dirname(metadataPath), 'wrong-client'), fingerprint);
    assert.equal(wrongKey.status, 1);
    assert.match(wrongKey.stderr, /public key authentication rejected/);
    } else {
    // Dedicated Rust integration test also replaces the saved raw host-key pin
    // before reconnect: it must fail before reading a nonexistent private key.
    const mutation = spawnSync(testBinary, [
      'ssh::tests::real_fixture_reconnect_mismatch', '--ignored', '--exact',
    ], { encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, P0_SSH_FIXTURE_HOST: metadata.host, P0_SSH_FIXTURE_PORT: String(metadata.port), P0_SSH_FIXTURE_USER: metadata.username } });
    assert.equal(mutation.status, 0, mutation.stdout + mutation.stderr);
    assert.match(mutation.stdout, /1 passed/);
    }
  } finally {
    if (fixture.exitCode === null) {
      const closed = once(fixture, 'exit');
      fixture.kill('SIGTERM');
      const [code] = await closed;
      assert.equal(code, 0, errors);
    }
    if (metadataPath) await assert.rejects(access(metadataPath), { code: 'ENOENT' });
  }
});
}

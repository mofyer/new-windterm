import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
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
function runIgnored(name, metadata, extra = {}) {
  return spawnSync(testBinary, [name, '--ignored', '--exact'], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
    env: { ...process.env, P0_SSH_FIXTURE_HOST: metadata.host, P0_SSH_FIXTURE_PORT: String(metadata.port), P0_SSH_FIXTURE_USER: metadata.username, ...extra },
  });
}
// Remote tree for the read-only SFTP acceptance. The fixture's own self-check
// already left a 1 MiB+ `中文-🌏.bin`, which must exceed the 64 KiB read limit.
async function populateRemote(remote) {
  await writeFile(join(remote, 'small-中文.txt'), 'P0 SFTP read-only 中文 🌏\n');
  await symlink('small-中文.txt', join(remote, 'link-to-small'));
  await mkdir(join(remote, 'nested'));
  await writeFile(join(remote, 'nested', 'inner.txt'), 'inner\n');
  await mkdir(join(remote, 'many'));
  for (let index = 0; index <= 4096; index++) await writeFile(join(remote, 'many', `f${index}`), '');
}
const titles = {
  client: 'explicit trust, UTF-8, wrong client key',
  mismatch: 'reconnect host-key mismatch',
  sftp: 'read-only SFTP grant: list, metadata, bounded read, truncation, close',
};
// Separate server instances keep intentional pre-auth rejections from accumulating
// OpenSSH PerSourcePenalties. Server policy remains unchanged; no client retries.
for (const mode of ['client', 'mismatch', 'sftp']) {
test(`Rust client: ${titles[mode]}`, { timeout: 45_000 }, async () => {
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
    if (mode === 'client') {
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
    } else if (mode === 'mismatch') {
    // Dedicated Rust integration test also replaces the saved raw host-key pin
    // before reconnect: it must fail before reading a nonexistent private key.
    const mutation = runIgnored('ssh::tests::real_fixture_reconnect_mismatch', metadata);
    assert.equal(mutation.status, 0, mutation.stdout + mutation.stderr);
    assert.match(mutation.stdout, /1 passed/);
    } else {
    // The Rust service probes, consumes the challenge once, then reuses only the
    // in-memory grant; every operation reconnects and pins the confirmed key.
    await populateRemote(metadata.remoteDirectory);
    const browse = runIgnored('ssh::tests::real_fixture_sftp_read_only_browse', metadata, {
      P0_SSH_FIXTURE_KEY: metadata.privateKeyPath,
      P0_SSH_FIXTURE_REMOTE: await realpath(metadata.remoteDirectory),
    });
    assert.equal(browse.status, 0, browse.stdout + browse.stderr);
    assert.match(browse.stdout, /1 passed/);
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

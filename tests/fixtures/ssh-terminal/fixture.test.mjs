import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

const fixture = fileURLToPath(new URL('./fixture.mjs', import.meta.url));
const available = ['darwin', 'linux'].includes(process.platform)
  && process.getuid?.() !== 0
  && ['/usr/sbin/sshd', '/usr/bin/ssh', '/usr/bin/ssh-keygen'].every(existsSync);
const skipReason = available ? undefined : 'requires non-root macOS/Linux with system OpenSSH';

async function runFixture(args = []) {
  const child = spawn(process.execPath, [fixture, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', data => { stdout += String(data); });
  child.stderr.on('data', data => { stderr += String(data); });
  const [code, signal] = await once(child, 'exit');
  return { child, code, signal, stdout, stderr };
}

test('OpenSSH PTY fixture self-test covers allowlist, UTF-8, dimensions, interrupt, and exit 7', { skip: skipReason, timeout: 45_000 }, async () => {
  const result = await runFixture();
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.scope, 'system-openssh-pty-fixture-only');
  assert.deepEqual(report.checks, {
    command: true,
    utf8: true,
    ptySize: true,
    boundedGeneratorInterrupt: true,
    exit7: true,
    interruptedBytes: report.checks.interruptedBytes,
  });
  assert.ok(report.checks.interruptedBytes > 0 && report.checks.interruptedBytes < 2 * 1024 * 1024);
});

test('OpenSSH PTY fixture --serve publishes private metadata and removes it on shutdown', { skip: skipReason, timeout: 15_000 }, async () => {
  const child = spawn(process.execPath, [fixture, '--serve'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', data => { stdout += String(data); });
  child.stderr.on('data', data => { stderr += String(data); });
  let metadataPath;
  try {
    for (let attempt = 0; attempt < 100 && !metadataPath; attempt++) {
      metadataPath = stdout.match(/connection metadata: (.+)/)?.[1];
      if (!metadataPath) {
        assert.equal(child.exitCode, null, stderr);
        await delay(50);
      }
    }
    assert.ok(metadataPath, `serve readiness deadline exceeded: ${stderr}`);
    const metadata = JSON.parse(await readFile(metadataPath));
    assert.equal(metadata.scope, 'system-openssh-pty-fixture-only');
    assert.equal(metadata.host, '127.0.0.1');
    assert.ok(metadata.port > 1023);
    assert.match(metadata.fingerprint, /^SHA256:/);
    assert.deepEqual(metadata.allowedCommands, ['printf', 'stty size', 'generate', 'exit']);
    assert.equal((await stat(metadata.rootDirectory)).mode & 0o777, 0o700);
    assert.equal((await stat(metadata.privateKeyPath)).mode & 0o777, 0o600);
    assert.equal((await stat(metadata.knownHostsPath)).mode & 0o777, 0o600);
    child.kill('SIGTERM');
    const [code, signal] = await once(child, 'exit');
    assert.equal(signal, null, stderr);
    assert.equal(code, 0, stderr);
    await assert.rejects(access(metadataPath), { code: 'ENOENT' });
    await assert.rejects(access(metadata.rootDirectory), { code: 'ENOENT' });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { access, readFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

for (const listenerFailure of [false, true]) {
test(`real SSH/SFTP cleanup after ${listenerFailure ? 'listener failure (SFTP, ssh -N, pending auth)' : 'normal shutdown'}`, { timeout: 25_000 }, async () => {
  const fixture = spawn(process.execPath, [fileURLToPath(new URL('./fixture.mjs', import.meta.url)), '--serve'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let errors = '';
  fixture.stdout.on('data', data => { output += data; });
  fixture.stderr.on('data', data => { errors += data; });
  let client;
  let idleClient;
  let pendingAuth;
  try {
    for (let attempt = 0; attempt < 100 && !output.includes('connection metadata:'); attempt++) {
      assert.equal(fixture.exitCode, null, errors);
      await delay(100);
    }
    const metadataPath = output.match(/connection metadata: (.+)/)?.[1];
    assert.ok(metadataPath, 'Fixture readiness deadline exceeded');
    const report = JSON.parse(output.slice(0, output.indexOf('\nFixture ready')));
    assert.equal(report.scope, 'system-openssh-fixture-only');
    assert.equal(Object.values(report.checks).filter(Boolean).length, 6);
    assert.equal(report.bytes, 1048596);
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    client = spawn('/usr/bin/sftp', [
      '-F', '/dev/null', '-o', 'BatchMode=yes', '-o', 'IdentityAgent=none', '-o', 'IdentitiesOnly=yes',
      '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${metadata.knownHostsPath}`,
      '-o', 'GlobalKnownHostsFile=/dev/null', '-i', metadata.privateKeyPath,
      '-P', String(metadata.port), '-b', '-', `${metadata.username}@127.0.0.1`,
    ], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', HOME: metadata.remoteDirectory, LANG: 'C' } });
    let clientOutput = '';
    client.stdout.on('data', data => { clientOutput += data; });
    client.stderr.resume();
    client.stdin.write('pwd\n');
    for (let attempt = 0; attempt < 40 && !clientOutput.includes('Remote working directory:'); attempt++) await delay(50);
    assert.match(clientOutput, /Remote working directory:/, 'SFTP session did not authenticate before shutdown');
    if (listenerFailure) {
      idleClient = spawn('/usr/bin/ssh', [
        '-N', '-v', '-F', '/dev/null', '-o', 'BatchMode=yes', '-o', 'IdentityAgent=none', '-o', 'IdentitiesOnly=yes',
        '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${metadata.knownHostsPath}`,
        '-o', 'GlobalKnownHostsFile=/dev/null', '-i', metadata.privateKeyPath,
        '-p', String(metadata.port), `${metadata.username}@127.0.0.1`,
      ], { stdio: ['ignore', 'ignore', 'pipe'], env: { PATH: '/usr/bin:/bin', HOME: metadata.remoteDirectory, LANG: 'C' } });
      let authOutput = '';
      idleClient.stderr.on('data', data => { authOutput += data; });
      for (let attempt = 0; attempt < 40 && !authOutput.includes('Authenticated to'); attempt++) await delay(25);
      assert.ok(authOutput.includes('Authenticated to'), 'ssh -N did not authenticate before listener failure');
      pendingAuth = createConnection({ host: '127.0.0.1', port: metadata.port });
      pendingAuth.on('error', () => {});
      pendingAuth.resume();
      await once(pendingAuth, 'connect');
      await delay(100);
    }
    const listener = Number(await readFile(new URL('./sshd.pid', `file://${metadataPath}`), 'utf8'));
    const rows = spawnSync('/bin/ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', timeout: 2000 }).stdout
      .trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
    assert.ok(rows.some(([pid, parent]) => pid === listener && parent === fixture.pid), 'Listener no longer belongs to the test fixture');
    const serverPids = new Set([listener]);
    for (let pass = 0; pass < 5; pass++) {
      for (const [pid, parent] of rows) if (serverPids.has(parent)) serverPids.add(pid);
    }
    assert.ok(serverPids.size > 1, 'No authenticated child process observed');
    const fixtureClosed = once(fixture, 'exit');
    const clientClosed = once(client, 'exit');
    if (listenerFailure) process.kill(listener, 'SIGTERM');
    else fixture.kill('SIGTERM');
    assert.deepEqual(await Promise.race([fixtureClosed, delay(listenerFailure ? 16_000 : 4000).then(() => { throw new Error('Fixture shutdown deadline exceeded'); })]), [listenerFailure ? 1 : 0, null], errors);
    for (const pid of serverPids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'Fixture server child survived shutdown');
    if (listenerFailure) {
      assert.match(errors, /Temporary sshd exited during serve/);
      assert.notEqual(idleClient.exitCode, null, 'Authenticated channel-less SSH client survived');
      assert.equal(pendingAuth.destroyed, true, 'Unauthenticated connection survived');
    }
    // An idle batch client may still wait on its local stdin after socket loss.
    // Issue a new operation to observe disconnection, then close that stdin.
    client.stdin.end('pwd\n');
    await Promise.race([clientClosed, delay(2000).then(() => { throw new Error('Active SFTP session survived fixture shutdown'); })]);
    await assert.rejects(access(metadataPath), { code: 'ENOENT' });
    const portIsOpen = await new Promise(resolve => {
      const connection = createConnection({ host: '127.0.0.1', port: metadata.port });
      connection.once('connect', () => { connection.destroy(); resolve(true); });
      connection.once('error', () => resolve(false));
      connection.setTimeout(1000, () => { connection.destroy(); resolve(true); });
    });
    assert.equal(portIsOpen, false, 'Fixture port still accepting connections');
  } finally {
    pendingAuth?.destroy();
    idleClient?.kill('SIGTERM');
    client?.kill('SIGTERM');
    fixture.kill('SIGTERM');
    await delay(250);
    if (client && client.exitCode === null && client.signalCode === null) client.kill('SIGKILL');
    if (fixture.exitCode === null && fixture.signalCode === null) fixture.kill('SIGKILL');
  }
});
}

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { access, lstat, mkdtemp, readFile, rm, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

// Drives agent forwarding (C10) through the Rust `Ssh::open_with_agent` (what
// `ssh_open` with `agentForwarding` calls) against system OpenSSH with
// AllowAgentForwarding. The forwarded agent is a private, temporary
// `ssh-agent -D -a <socket>` holding one generated key, stopped by PID; the
// user's agent and ~/.ssh keys are never used. Remote `ssh-add -l` must list
// that key only on the connection that opted in. P0_AGENT_REQUIRED=1 (CI)
// turns a skip into a failure. On OpenSSH 10.1+ sshd itself binds the
// forwarded listener under the account's ~/.ssh/agent, so the fixture needs
// P0_AGENT_HOME_SOCKET=1 there (see fixture.mjs).
const root = fileURLToPath(new URL('../../../', import.meta.url));
const SSH_AGENT = '/usr/bin/ssh-agent';
const SSH_ADD = '/usr/bin/ssh-add';
const KEYGEN = '/usr/bin/ssh-keygen';
const tools = ['/usr/sbin/sshd', '/usr/bin/ssh', KEYGEN, SSH_AGENT, SSH_ADD];
const available = ['darwin', 'linux'].includes(process.platform) && process.getuid?.() !== 0 && tools.every(existsSync);
const required = process.env.P0_AGENT_REQUIRED === '1';
const skip = available || required ? undefined : 'requires non-root macOS/Linux with OpenSSH sshd, ssh-agent and ssh-add';

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return child?.exitCode;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  const [code] = await exited;
  clearTimeout(timer);
  return code;
}

async function gone(path, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (existsSync(path) && Date.now() < deadline) await delay(25);
  return !existsSync(path);
}

/** Builds the ignored Rust test with the CI test step's features, so its build is reused. */
function testBinary() {
  const cargo = existsSync(join(process.env.HOME, '.cargo/bin/cargo')) ? join(process.env.HOME, '.cargo/bin/cargo') : 'cargo';
  const build = spawnSync(cargo, ['test', '--locked', '--all-features', '--manifest-path', join(root, 'apps/desktop/src-tauri/Cargo.toml'),
    '--test', 'ssh_agent_openssh', '--no-run', '--message-format=json'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  assert.equal(build.status, 0, build.stderr);
  const binary = build.stdout.split('\n').filter(Boolean).map(line => JSON.parse(line))
    .find(receipt => receipt.reason === 'compiler-artifact' && receipt.target?.name === 'ssh_agent_openssh'
      && receipt.profile.test && receipt.executable)?.executable;
  assert.ok(binary, 'Cargo did not provide the ssh_agent_openssh test executable');
  return binary;
}

test('Rust agent forwarding: remote ssh-add -l lists the private agent key only when opted in', { skip, timeout: 300_000 }, async t => {
  assert.ok(available, `agent prerequisites missing on ${process.platform}: ${tools.filter(tool => !existsSync(tool)).join(', ')}`);
  const binary = testBinary();

  const directory = await mkdtemp(join(tmpdir(), 'p0-agent-'));
  // ssh-agent and ssh-add see only this directory as HOME.
  const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: directory, LANG: 'C', LC_ALL: 'C' };
  const key = join(directory, 'agent_key');
  const socket = join(directory, 'agent.sock');
  let fixture;
  let agent;
  let metadata;
  let remoteSocket;
  let skipped = false;
  let completed = false;
  let fixtureErrors = '';
  try {
    // The fixture first: it refuses (exit 2, SKIP) where sshd may not run.
    fixture = spawn(process.execPath, [fileURLToPath(new URL('./fixture.mjs', import.meta.url)), '--serve', '--agent'], { stdio: ['ignore', 'pipe', 'pipe'] });
    // Settles once stderr is fully read; a spawn error is reported below.
    const closed = once(fixture, 'close').catch(() => {});
    let fixtureOutput = '';
    fixture.stdout.on('data', data => { fixtureOutput += String(data); });
    fixture.stderr.on('data', data => { fixtureErrors += String(data); });
    let metadataPath;
    for (let attempt = 0; attempt < 200 && !metadataPath && fixture.exitCode === null; attempt++) {
      metadataPath = fixtureOutput.match(/connection metadata: (.+)/)?.[1];
      if (!metadataPath) await delay(50);
    }
    if (!metadataPath && fixture.exitCode !== null) await closed;
    if (fixture.exitCode === 2 && /^SKIP: /m.test(fixtureErrors)) {
      assert.ok(!required, `P0_AGENT_REQUIRED is set, but ${fixtureErrors.trim()}`);
      skipped = true;
      completed = true;
      t.skip(fixtureErrors.trim());
      return;
    }
    assert.ok(metadataPath, `fixture readiness deadline exceeded: ${fixtureErrors}`);
    metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    assert.equal(metadata.agent, true);
    assert.ok(metadata.allowedCommands.includes('agent-list'));

    assert.equal(spawnSync(KEYGEN, ['-q', '-t', 'ed25519', '-N', '', '-C', 'p0-agent-forward', '-f', key],
      { env, encoding: 'utf8', timeout: 15_000 }).status, 0, 'key generation failed');
    const fingerprint = spawnSync(KEYGEN, ['-lf', `${key}.pub`, '-E', 'sha256'], { env, encoding: 'utf8', timeout: 15_000 })
      .stdout.trim().split(/\s+/)[1];
    assert.match(fingerprint ?? '', /^SHA256:/);

    agent = spawn(SSH_AGENT, ['-D', '-a', socket], { cwd: directory, env, stdio: ['ignore', 'ignore', 'pipe'] });
    let agentErrors = '';
    agent.stderr.on('data', data => { agentErrors += String(data); });
    for (let attempt = 0; attempt < 200 && !existsSync(socket); attempt++) {
      assert.equal(agent.exitCode, null, `ssh-agent exited: ${agentErrors}`);
      await delay(25);
    }
    assert.ok((await lstat(socket)).isSocket(), `ssh-agent did not bind ${socket}: ${agentErrors}`);
    const agentEnv = { ...env, SSH_AUTH_SOCK: socket };
    const added = spawnSync(SSH_ADD, [key], { env: agentEnv, encoding: 'utf8', timeout: 15_000 });
    assert.equal(added.status, 0, added.stderr);
    const local = spawnSync(SSH_ADD, ['-l', '-E', 'sha256'], { env: agentEnv, encoding: 'utf8', timeout: 15_000 });
    assert.equal(local.status, 0, local.stderr);
    assert.equal(local.stdout.trim().split('\n').length, 1, local.stdout);
    assert.ok(local.stdout.includes(fingerprint), local.stdout);

    // Only the test process sees the private agent as SSH_AUTH_SOCK.
    const result = spawnSync(binary, ['real_openssh_agent_forwarding_is_opt_in', '--ignored', '--exact', '--nocapture'], {
      encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, SSH_AUTH_SOCK: socket,
        P0_SSH_FIXTURE_HOST: metadata.host, P0_SSH_FIXTURE_PORT: String(metadata.port),
        P0_SSH_FIXTURE_USER: metadata.username, P0_SSH_FIXTURE_KEY: metadata.privateKeyPath,
        P0_SSH_FIXTURE_FINGERPRINT: metadata.fingerprint, P0_AGENT_FINGERPRINT: fingerprint },
    });
    remoteSocket = result.stdout.match(/^P0_AGENT_SOCKET (\/.+)$/m)?.[1];
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /1 passed/);
    // sshd bound the listener where the fixture said, and removed it when
    // the forwarded connection ended.
    assert.ok(remoteSocket?.startsWith(`${metadata.forwardedAgentDirectory}/`), `remote socket ${remoteSocket} is outside ${metadata.forwardedAgentDirectory}`);
    assert.ok(await gone(remoteSocket), `sshd kept ${remoteSocket} after the session ended`);
    // Before 10.1 sshd also made (and must remove) a private /tmp/ssh-* directory.
    if (metadata.forwardedAgentDirectory === '/tmp') {
      assert.match(remoteSocket, /^\/tmp\/ssh-[^/]+\/agent\.\d+$/);
      assert.ok(await gone(dirname(remoteSocket)), `sshd kept ${dirname(remoteSocket)}`);
    }
    for (const line of result.stdout.match(/^P0_AGENT_(EVIDENCE|SOCKET) .*$/gm) ?? []) console.log(line);
    completed = true;
  } finally {
    // Cleanup never throws over an earlier failure; its problems are listed.
    const problems = [];
    if (fixture) {
      const code = await stop(fixture);
      if (code !== (skipped ? 2 : 0)) problems.push(`fixture exited ${code}: ${fixtureErrors}`);
    }
    // A socket sshd could not remove (it was killed) is ours: remove exactly it.
    if (remoteSocket && existsSync(remoteSocket)) {
      try {
        const info = await lstat(remoteSocket);
        const ours = info.isSocket() && info.uid === process.getuid();
        if (ours) await unlink(remoteSocket);
        problems.push(`sshd left ${remoteSocket}${ours ? '; removed it' : ', not a socket we own; left in place'}`);
      } catch (error) {
        if (error.code !== 'ENOENT') problems.push(`could not remove ${remoteSocket}: ${error.message}`);
      }
    }
    const agentPid = agent?.pid;
    await stop(agent);
    if (agentPid && !(await gone(socket))) problems.push(`ssh-agent ${agentPid} left ${socket}`);
    if (metadata) {
      const removed = await access(metadata.rootDirectory).then(() => false, error => error.code === 'ENOENT');
      if (!removed) problems.push(`fixture root ${metadata.rootDirectory} remains`);
    }
    await rm(directory, { recursive: true, force: true });
    if (problems.length && completed) assert.fail(problems.join('\n'));
    if (problems.length) console.error(`cleanup after the failure: ${problems.join('\n')}`);
  }
});

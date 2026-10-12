#!/usr/bin/env node
// Standalone OpenSSH fixture. No application dependencies or personal SSH state.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile, open } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer, createConnection } from 'node:net';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

// Accepts exactly `scp -f|-t|-t -d -- '<path>'` (sh single-quoting, `'\''` for a
// quote) whose resolved path stays inside `base`; anything else is denied.
function scpTarget(command, base) {
  const match = /^scp (-t -d|-t|-f) -- '((?:[^']|'\\'')*)'$/.exec(command);
  if (!match) return null;
  const target = resolve(match[2].replaceAll("'\\''", "'"));
  if (target !== base && !target.startsWith(`${base}/`)) return null;
  return { flags: match[1].split(' '), target };
}

// Internal ForceCommand mode. The private lifetime socket owns the session even
// if sshd's listener dies and the authenticated processes are reparented.
if (process.argv.length === 4 && process.argv[2] === '--session') {
  const root = process.argv[3];
  let child;
  let finishing = false;
  const control = createConnection({ path: `${root}/control.sock`, allowHalfOpen: true });
  function finish(code) {
    if (finishing) return;
    finishing = true;
    const exit = () => { control.destroy(); process.exit(code); };
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return exit();
    child.once('exit', exit);
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 150).unref();
  }
  control.setTimeout(1000, () => finish(1));
  control.on('error', () => finish(1));
  control.on('end', () => finish(1));
  control.on('close', () => finish(1));
  control.on('data', () => finish(1));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => finish(1));
  control.once('connect', () => {
    control.setTimeout(0);
    if (process.env.SSH_ORIGINAL_COMMAND === 'fixture-check') {
      process.stdout.write('P0_SSH_OK 中文 🌏\n', () => finish(7));
    } else if (process.env.SSH_ORIGINAL_COMMAND === 'internal-sftp') {
      const server = ['/usr/libexec/sftp-server', '/usr/lib/openssh/sftp-server', '/usr/lib/ssh/sftp-server']
        .find(path => existsSync(path));
      if (!server) return finish(1);
      child = spawn(server, ['-d', `${root}/remote`], { stdio: 'inherit' });
      child.once('error', () => finish(1));
      child.once('exit', code => finish(code ?? 1));
    } else if (scpTarget(process.env.SSH_ORIGINAL_COMMAND ?? '', `${root}/remote`)) {
      // Legacy SCP server mode, confined to the fixture's remote directory.
      const { flags, target } = scpTarget(process.env.SSH_ORIGINAL_COMMAND, `${root}/remote`);
      child = spawn('/usr/bin/scp', [...flags, '--', target], { stdio: 'inherit' });
      child.once('error', () => finish(1));
      child.once('exit', code => finish(code ?? 1));
    } else {
      process.stderr.write('Fixture command denied\n', () => finish(126));
    }
  });
  // Keep normal fixture setup out of this internal subprocess.
  await new Promise(() => {});
}

const serve = process.argv.length === 3 && process.argv[2] === '--serve';
if (process.argv.length > 2 && !serve) {
  console.error('Usage: node tests/fixtures/ssh-sftp/fixture.mjs [--serve]');
  process.exit(2);
}
if (!['darwin', 'linux'].includes(process.platform) || process.getuid() === 0) {
  console.error('Requires a non-root macOS/Linux account; Windows is not verified.');
  process.exit(2);
}

const sshd = '/usr/sbin/sshd';
const sftpServer = ['/usr/libexec/sftp-server', '/usr/lib/openssh/sftp-server', '/usr/lib/ssh/sftp-server']
  .find(path => existsSync(path));
if (!existsSync(sshd) || !sftpServer) {
  console.error('System OpenSSH server and sftp-server are required. No service will be installed or enabled.');
  process.exit(2);
}
for (const tool of ['/usr/bin/ssh', '/usr/bin/sftp', '/usr/bin/ssh-keygen']) {
  if (!existsSync(tool)) throw new Error(`Missing system tool: ${tool}`);
}

process.umask(0o077);
// StrictModes rejects world-writable ancestors such as /tmp. macOS provides a
// private per-user temp root; Linux uses a temporary directory under the home.
let directory;
let environment;
let daemon;
let log;
let cleaning;
let timeout;
let controlServer;
const sessions = new Set();

async function cleanup() {
  if (cleaning) return cleaning;
  cleaning = (async () => {
    clearTimeout(timeout);
    const descendants = new Set();
    function signal(id, value) {
      if (!Number.isInteger(id) || id <= 1) throw new Error('Refusing an invalid fixture process ID');
      try { process.kill(id, value); return true; } catch (error) { if (error.code !== 'ESRCH') throw error; return false; }
    }
    try {
      if (!daemon?.pid) return;
      // Guarded sessions shut down over private IPC. While the listener is
      // still live, freeze its remaining descendants to include auth forks.
      const listenerLost = daemon.exitCode !== null || daemon.signalCode !== null || !signal(daemon.pid, 'SIGSTOP');
      if (!listenerLost) {
        descendants.add(daemon.pid);
      }
      await Promise.all([...sessions].map(socket => new Promise(resolve => {
        const deadline = setTimeout(() => { socket.destroy(); resolve(); }, 1000);
        socket.once('close', () => { clearTimeout(deadline); resolve(); });
        socket.write('stop\n');
      })));
      // Connections with no ForceCommand have no guard: OpenSSH bounds pending
      // auth at 10 seconds and authenticated channel-less connections at 2s.
      // If ancestry was lost, wait out both bounds before declaring cleanup.
      if (listenerLost) { await delay(12_250); return; }
      for (let pass = 0; pass < 8; pass++) {
        const before = descendants.size;
        const listing = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,uid=,stat='], {
          encoding: 'utf8', timeout: 2000, maxBuffer: 1024 * 1024,
        });
        if (listing.status !== 0) throw new Error('Cannot enumerate fixture children for cleanup');
        const rows = listing.stdout.trim().split('\n').map(line => line.trim().split(/\s+/));
        let changed = true;
        while (changed) {
          changed = false;
          for (const [rawPid, rawParent, rawUid, state] of rows) {
            const [pid, parent, uid] = [rawPid, rawParent, rawUid].map(Number);
            // macOS may reject signals to zombies with EPERM. They cannot run
            // or fork; terminating their live parent below permits reaping.
            if (state.startsWith('Z')) continue;
            if (descendants.has(parent) && !descendants.has(pid)) {
              if (uid !== process.getuid()) throw new Error('Refusing to signal a fixture descendant with an unexpected UID');
              if (signal(pid, 'SIGSTOP')) {
                descendants.add(pid);
                changed = true;
              }
            }
          }
        }
        if (descendants.size === before) break;
        if (pass === 7) throw new Error('Fixture process tree did not settle during cleanup');
      }
    } finally {
      try {
        // Only live, frozen descendants are signalled, once each. Never target
        // stale process groups after guarded sessions have already exited.
        for (const pid of [...descendants].reverse()) signal(pid, 'SIGKILL');
        await delay(150);
      } finally {
        for (const socket of sessions) socket.destroy();
        if (controlServer?.listening) await new Promise(resolve => controlServer.close(resolve));
        await log?.close();
        if (directory) await rm(directory, { recursive: true, force: true });
      }
    }
  })();
  return cleaning;
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { void cleanup().then(() => process.exit(0), error => {
    console.error(`Fixture cleanup failed: ${error.message}`);
    process.exit(1);
  }); });
}

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    env: environment, cwd: directory, encoding: 'utf8', timeout: 15_000,
    maxBuffer: 1024 * 1024, ...options,
  });
  if (result.error) throw new Error(`${executable.split('/').at(-1)} failed: ${result.error.code}`);
  return result;
}
function assert(condition, description) {
  if (!condition) throw new Error(description);
}
function hash(data) { return createHash('sha256').update(data).digest('hex'); }

try {
  const account = userInfo();
  assert(account.shell === '/bin/zsh', 'Fixture currently requires the verified /bin/zsh login shell; other shells are not enabled');
  directory = await mkdtemp(join(process.platform === 'darwin' ? tmpdir() : homedir(), '.new-windterm-ssh-'));
  await chmod(directory, 0o700);
  environment = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: directory, LANG: 'C', LC_ALL: 'C' };
  assert(/^[a-zA-Z0-9_./-]+$/.test(directory), 'Fixture root must not contain shell/config metacharacters');
  await mkdir(`${directory}/remote`);
  controlServer = createServer(socket => {
    if (cleaning) { socket.destroy(); return; }
    sessions.add(socket);
    socket.once('close', () => sessions.delete(socket));
    socket.on('error', () => {}); // Socket close removes it; no payload is logged.
  });
  await new Promise((resolve, reject) => {
    controlServer.once('error', reject);
    controlServer.listen(`${directory}/control.sock`, resolve);
  });
  for (const key of ['host', 'client', 'wrong-client']) {
    assert(run('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'p0-fixture', '-f', `${directory}/${key}`]).status === 0,
      'Temporary key generation failed');
  }
  await writeFile(`${directory}/authorized_keys`, `restrict ${await readFile(`${directory}/client.pub`, 'utf8')}`);

  // Ask the kernel for a free loopback port. The sshd bind remains authoritative:
  // if another process wins the release/bind race, readiness fails closed.
  const reservation = createServer();
  await new Promise((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const port = reservation.address().port;
  assert(port > 1023, 'Kernel selected a privileged port');
  await new Promise(resolve => reservation.close(resolve));

  const username = account.username;
  assert(/^[a-zA-Z0-9_.-]+$/.test(username), 'Unsupported fixture username');
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(`${directory}/dispatch.sh`, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fileURLToPath(import.meta.url))} --session ${quote(directory)}\n`);
  const configuration = `AddressFamily inet
ListenAddress 127.0.0.1
Port ${port}
HostKey ${directory}/host
PidFile ${directory}/sshd.pid
AuthorizedKeysFile ${directory}/authorized_keys
AllowUsers ${username}@127.0.0.1
PubkeyAuthentication yes
AuthenticationMethods publickey
PasswordAuthentication no
KbdInteractiveAuthentication no
HostbasedAuthentication no
PermitEmptyPasswords no
UsePAM no
PermitRootLogin no
PermitUserEnvironment no
PermitUserRC no
PermitTTY no
DisableForwarding yes
X11Forwarding no
StrictModes yes
UseDNS no
LoginGraceTime 10
UnusedConnectionTimeout 2
MaxAuthTries 2
MaxSessions 2
MaxStartups 3
LogLevel ERROR
SetEnv ZDOTDIR=${directory} BASH_ENV=/dev/null ENV=/dev/null
ForceCommand /bin/sh ${directory}/dispatch.sh
Subsystem sftp internal-sftp
`;
  await writeFile(`${directory}/sshd_config`, configuration);
  assert(run(sshd, ['-t', '-f', `${directory}/sshd_config`]).status === 0,
    'Non-root sshd configuration preflight failed; system policy may prohibit this fixture');

  const hostPublicKey = (await readFile(`${directory}/host.pub`, 'utf8')).trim();
  await writeFile(`${directory}/known_hosts`, `[127.0.0.1]:${port} ${hostPublicKey}\n`);
  await writeFile(`${directory}/empty_known_hosts`, '');
  const clientOptions = [
    '-F', '/dev/null', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none',
    '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'StrictHostKeyChecking=yes', '-o', 'UpdateHostKeys=no',
    '-o', 'ConnectTimeout=3', '-o', 'ConnectionAttempts=1', '-o', 'LogLevel=ERROR',
    '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no',
    '-o', 'UserKnownHostsFile=' + directory + '/known_hosts', '-i', directory + '/client',
  ];
  const ssh = (command, options = clientOptions) => run('/usr/bin/ssh', [
    ...options, '-p', String(port), '-l', username, '127.0.0.1', command,
  ]);

  log = await open(`${directory}/sshd.log`, 'w', 0o600);
  daemon = spawn(sshd, ['-D', '-e', '-f', `${directory}/sshd_config`], {
    detached: true, env: environment, cwd: directory, stdio: ['ignore', 'ignore', log.fd],
  });
  let spawnError;
  daemon.once('error', error => { spawnError = error; });
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    await delay(100);
    assert(!spawnError && daemon.exitCode === null && daemon.signalCode === null, 'Temporary sshd exited before readiness');
    ready = await new Promise(resolve => {
      const connection = createConnection({ host: '127.0.0.1', port });
      connection.setTimeout(200);
      connection.once('connect', () => { connection.destroy(); resolve(true); });
      connection.once('error', () => resolve(false));
      connection.once('timeout', () => { connection.destroy(); resolve(false); });
    });
    if (ready) break;
  }
  assert(ready, 'Temporary sshd did not bind loopback in time');

  const missingTrust = ssh('fixture-check', clientOptions.map(value => value === `UserKnownHostsFile=${directory}/known_hosts`
    ? `UserKnownHostsFile=${directory}/empty_known_hosts` : value));
  assert(missingTrust.status === 255 && missingTrust.stderr.includes('Host key verification failed'), 'Unknown host was not rejected');
  const wrongKey = ssh('fixture-check', clientOptions.map(value => value === `${directory}/client` ? `${directory}/wrong-client` : value));
  assert(wrongKey.status === 255 && wrongKey.stderr.includes('Permission denied'), 'Wrong client key was not rejected');
  const command = ssh('fixture-check');
  assert(command.status === 7 && command.stdout === 'P0_SSH_OK 中文 🌏\n', 'SSH UTF-8 command/exit verification failed');
  const denied = ssh('not-allowed');
  assert(denied.status === 126 && denied.stderr.includes('Fixture command denied'), 'Command allowlist did not reject unknown command');

  const payload = Buffer.concat([Buffer.from('P0 SFTP 中文 🌏\n'), randomBytes(1024 * 1024)]);
  await writeFile(`${directory}/upload.bin`, payload);
  const batch = `put "${directory}/upload.bin" "中文-🌏.bin"\nget "中文-🌏.bin" "${directory}/download.bin"\nbye\n`;
  const transfer = run('/usr/bin/sftp', [...clientOptions, '-P', String(port), '-b', '-', `${username}@127.0.0.1`], { input: batch });
  assert(transfer.status === 0, 'SFTP upload/download failed');
  const remote = await readFile(`${directory}/remote/中文-🌏.bin`);
  const download = await readFile(`${directory}/download.bin`);
  assert(hash(payload) === hash(remote) && hash(remote) === hash(download), 'SFTP SHA-256 mismatch');

  // Use a deliberately wrong trusted host key to test strict changed-key rejection.
  await writeFile(`${directory}/changed_known_hosts`, `[127.0.0.1]:${port} ${await readFile(`${directory}/wrong-client.pub`, 'utf8')}`);
  const changedHost = ssh('fixture-check', clientOptions.map(value => value === `UserKnownHostsFile=${directory}/known_hosts`
    ? `UserKnownHostsFile=${directory}/changed_known_hosts` : value));
  assert(changedHost.status === 255 && changedHost.stderr.includes('REMOTE HOST IDENTIFICATION HAS CHANGED'), 'Changed trusted host key was not rejected');

  console.log(JSON.stringify({
    scope: 'system-openssh-fixture-only', platform: process.platform,
    openssh: run('/usr/bin/ssh', ['-V']).stderr.trim(),
    checks: { unknownHostRejected: true, wrongKeyRejected: true, sshUtf8AndExit7: true,
      commandAllowlist: true, sftpRoundTrip: true, changedHostRejected: true },
    bytes: payload.length, sha256: hash(payload),
  }, null, 2));
  if (serve) {
    const metadata = { host: '127.0.0.1', port, username, privateKeyPath: `${directory}/client`,
      knownHostsPath: `${directory}/known_hosts`, remoteDirectory: `${directory}/remote`,
      allowedCommand: 'fixture-check', lifetimeSeconds: 600 };
    await writeFile(`${directory}/connection.json`, JSON.stringify(metadata, null, 2));
    console.log(`Fixture ready for 600 seconds; connection metadata: ${directory}/connection.json`);
    console.log('Ctrl-C stops this fixture and removes its temporary credentials and files.');
    await new Promise((resolve, reject) => {
      timeout = setTimeout(resolve, 600_000);
      daemon.once('exit', () => {
        if (!cleaning) reject(new Error('Temporary sshd exited during serve'));
      });
    });
  }
} catch (error) {
  console.error(`Fixture failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}

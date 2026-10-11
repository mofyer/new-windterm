#!/usr/bin/env node
// Independent OpenSSH PTY fixture for the P0 terminal contract.
// It never reads the user's SSH config, agent, keys, or system sshd settings.
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const SSHD = '/usr/sbin/sshd';
const SSH = '/usr/bin/ssh';
const KEYGEN = '/usr/bin/ssh-keygen';
const SERVE = process.argv[2] === '--serve';
if (process.argv.length > 2 && !SERVE) {
  console.error('Usage: node tests/fixtures/ssh-terminal/fixture.mjs [--serve]');
  process.exit(2);
}

function unsupported(message) {
  console.error(`SKIP: ${message}`);
  process.exit(2);
}
if (!['darwin', 'linux'].includes(process.platform) || process.getuid?.() === 0) {
  unsupported('requires a non-root macOS/Linux account; Windows is skipped');
}
if (![SSHD, SSH, KEYGEN].every(existsSync)) unsupported('OpenSSH sshd, ssh, and ssh-keygen are required');

const shell = userInfo().shell;
if (!['/bin/zsh', '/bin/bash', '/usr/bin/zsh', '/usr/bin/bash'].includes(shell)) {
  unsupported(`login shell ${shell} is not enabled for this fixture`);
}
process.umask(0o077);

let root;
let daemon;
let daemonError;
let cleaning;
let signalHandlerInstalled = false;
let activeClient;

function assert(condition, message) { if (!condition) throw new Error(message); }
function quote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }
function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: root,
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: root, LANG: 'C', LC_ALL: 'C', ...options.env },
    encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024, ...options,
  });
  if (result.error) throw new Error(`${executable.split('/').at(-1)} failed: ${result.error.code}`);
  return result;
}

async function cleanup() {
  if (cleaning) return cleaning;
  cleaning = (async () => {
    const descendants = new Set();
    const signal = (pid, value) => {
      if (!Number.isInteger(pid) || pid <= 1) return;
      try { process.kill(pid, value); } catch (error) {
        if (!['ESRCH', 'EPERM'].includes(error.code)) throw error;
      }
    };
    if (activeClient && activeClient.exitCode === null && activeClient.signalCode === null) {
      activeClient.kill('SIGTERM');
      await Promise.race([new Promise(resolve => activeClient.once('exit', resolve)), delay(1000)]);
      if (activeClient.exitCode === null && activeClient.signalCode === null) activeClient.kill('SIGKILL');
    }
    const daemonCommand = daemon?.pid
      ? spawnSync('/bin/ps', ['-p', String(daemon.pid), '-o', 'command='], { encoding: 'utf8', timeout: 2000 }).stdout.trim()
      : '';
    const daemonIsOwned = daemon?.pid
      && daemon.exitCode === null
      && daemon.signalCode === null
      && daemonCommand.includes(join(root, 'sshd_config'));
    if (daemonIsOwned) {
      // The listener is detached and OpenSSH forks one process per channel. Kill
      // its process group first, then walk the same-UID tree for children that
      // changed process groups after authentication.
      try { process.kill(-daemon.pid, 'SIGTERM'); } catch (error) {
        if (!['ESRCH', 'EPERM'].includes(error.code)) throw error;
      }
      descendants.add(daemon.pid);
      for (let pass = 0; pass < 8; pass++) {
        const listing = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,uid=,stat='], {
          encoding: 'utf8', timeout: 2000, maxBuffer: 1024 * 1024,
        });
        if (listing.status !== 0) break;
        let changed = false;
        for (const line of listing.stdout.trim().split('\n')) {
          const fields = line.trim().split(/\s+/);
          if (fields.length < 3) continue;
          const [pid, parent, uid] = fields.slice(0, 3).map(Number);
          if (!descendants.has(parent) || descendants.has(pid) || uid !== process.getuid?.()) continue;
          descendants.add(pid);
          signal(pid, 'SIGTERM');
          changed = true;
        }
        if (!changed) break;
        await delay(25);
      }
      for (const pid of [...descendants].reverse()) signal(pid, 'SIGKILL');
      // A channel process can be reparented by sshd before the tree walk. Its
      // command line still contains only this private fixture root, so reap
      // those exact wrapper/generator/config matches without broad UID kills.
      const ownedMarkers = [join(root, 'interactive.sh'), join(root, 'generator.mjs'), join(root, 'dispatch.sh'), join(root, 'sshd_config')];
      const ownedListing = spawnSync('/bin/ps', ['-axo', 'pid=,uid=,command='], { encoding: 'utf8', timeout: 2000, maxBuffer: 1024 * 1024 });
      if (ownedListing.status === 0) {
        for (const line of ownedListing.stdout.split('\n')) {
          const fields = line.trim().split(/\s+/);
          const pid = Number(fields.shift());
          const uid = Number(fields.shift());
          const command = fields.join(' ');
          if (pid > 1 && pid !== process.pid && uid === process.getuid?.() && ownedMarkers.some(marker => command.includes(marker))) signal(pid, 'SIGKILL');
        }
      }
      const deadline = Date.now() + 2500;
      while (daemon.exitCode === null && daemon.signalCode === null && Date.now() < deadline) await delay(25);
      if (daemon.exitCode === null && daemon.signalCode === null) signal(daemon.pid, 'SIGKILL');
    }
    if (root) await rm(root, { recursive: true, force: true });
  })();
  return cleaning;
}
function installSignalHandlers() {
  if (signalHandlerInstalled) return;
  signalHandlerInstalled = true;
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    void cleanup().then(() => process.exit(0), error => { console.error(`Fixture cleanup failed: ${error.message}`); process.exit(1); });
  });
}

async function choosePort() {
  const reservation = createServer();
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  const address = reservation.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise(resolve => reservation.close(resolve));
  assert(port > 1023, 'kernel selected a privileged port');
  return port;
}

async function waitForPort(port) {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (daemonError || daemon?.exitCode !== null || daemon?.signalCode !== null) throw new Error('temporary sshd exited before readiness');
    const ready = await new Promise(resolve => {
      const socket = createConnection({ host: '127.0.0.1', port });
      socket.setTimeout(200);
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
      socket.once('timeout', () => { socket.destroy(); resolve(false); });
    });
    if (ready) return;
    await delay(100);
  }
  throw new Error('temporary sshd did not bind loopback in time');
}

async function setup() {
  root = await mkdtemp(join(process.platform === 'darwin' ? tmpdir() : homedir(), '.new-windterm-ssh-terminal-'));
  await chmod(root, 0o700);
  const port = await choosePort();
  const account = userInfo();
  assert(/^[a-zA-Z0-9_.-]+$/.test(account.username), 'unsupported fixture username');
  assert(/^[a-zA-Z0-9_./-]+$/.test(root), 'fixture root contains shell metacharacters');
  for (const key of ['host', 'client', 'wrong-client']) {
    const result = run(KEYGEN, ['-q', '-t', 'ed25519', '-N', '', '-C', 'p0-ssh-terminal', '-f', join(root, key)]);
    assert(result.status === 0, `temporary ${key} key generation failed`);
    await chmod(join(root, key), 0o600);
    await chmod(join(root, `${key}.pub`), 0o600);
  }
  await writeFile(join(root, 'authorized_keys'), `no-agent-forwarding,no-port-forwarding,no-X11-forwarding,no-user-rc ${await readFile(join(root, 'client.pub'), 'utf8')}`, { mode: 0o600 });
  await writeFile(join(root, 'empty_known_hosts'), '', { mode: 0o600 });

  const generator = `import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
let stopped = false;
function stop() {
  if (stopped) return;
  stopped = true;
  process.exit(130);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
const chunk = Buffer.alloc(4096, 'X');
for (let index = 0; index < 512 && !stopped; index += 1) {
  if (!process.stdout.write(chunk)) await once(process.stdout, 'drain');
  await delay(1);
}

`;
  await writeFile(join(root, 'generator.mjs'), generator, { mode: 0o600 });
  const interactive = `#!/bin/sh
set -eu
export PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME=${quote(root)} ZDOTDIR=${quote(root)} HISTFILE=/dev/null LANG=C.UTF-8 LC_ALL=C.UTF-8
stty rows 24 cols 80 2>/dev/null || true
printf 'P0_INTERACTIVE_READY\\r\\nfixture> '
interrupted=0
trap 'interrupted=1' INT
while IFS= read -r command; do
  case "$command" in
    printf) printf 'P0_SSH_TERM_OK 中文 🌏\\r\\n' ;;
    'stty size') /bin/stty size ;;
    generate)
      interrupted=0
      printf 'P0_GENERATOR_BEGIN\\r\\n'
      generator_status=0
      ${quote(process.execPath)} ${quote(join(root, 'generator.mjs'))} || generator_status=$?
      if [ "$interrupted" -eq 1 ] || [ "$generator_status" -eq 130 ]; then printf '\\r\\nP0_SSH_INTERRUPTED\\r\\n'; else printf '\\r\\nP0_GENERATOR_END\\r\\n'; fi
      ;;
    exit) printf 'P0_SSH_EXIT_7\\r\\n'; exit 7 ;;
    '') ;;
    *) printf 'P0_COMMAND_DENIED\\r\\n' >&2; exit 126 ;;
  esac
  printf 'fixture> '
done
exit 0
`;
  await writeFile(join(root, 'interactive.sh'), interactive, { mode: 0o700 });
  const dispatch = `#!/bin/sh
set -eu
if [ -n "${'${SSH_ORIGINAL_COMMAND-}'}" ]; then
  printf 'P0_COMMAND_DENIED\\n' >&2
  exit 126
fi
exec /bin/sh ${quote(join(root, 'interactive.sh'))}
`;
  await writeFile(join(root, 'dispatch.sh'), dispatch, { mode: 0o700 });

  const configuration = `AddressFamily inet
ListenAddress 127.0.0.1
Port ${port}
HostKey ${join(root, 'host')}
PidFile ${join(root, 'sshd.pid')}
AuthorizedKeysFile ${join(root, 'authorized_keys')}
AllowUsers ${account.username}@127.0.0.1
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
PermitTTY yes
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
SetEnv ZDOTDIR=${root} BASH_ENV=/dev/null ENV=/dev/null
ForceCommand /bin/sh ${join(root, 'dispatch.sh')}
`;
  await writeFile(join(root, 'sshd_config'), configuration, { mode: 0o600 });
  const check = run(SSHD, ['-t', '-f', join(root, 'sshd_config')]);
  assert(check.status === 0, `sshd configuration preflight failed: ${check.stderr}`);
  const hostPublicKey = (await readFile(join(root, 'host.pub'), 'utf8')).trim();
  const knownHosts = `[127.0.0.1]:${port} ${hostPublicKey}\n`;
  await writeFile(join(root, 'known_hosts'), knownHosts, { mode: 0o600 });
  const fingerprintResult = run(KEYGEN, ['-lf', join(root, 'host.pub'), '-E', 'sha256']);
  assert(fingerprintResult.status === 0, 'host fingerprint calculation failed');
  const fingerprint = fingerprintResult.stdout.trim().split(/\s+/)[1];
  assert(/^SHA256:/.test(fingerprint), 'host fingerprint format is invalid');

  daemon = spawn(SSHD, ['-D', '-e', '-f', join(root, 'sshd_config')], {
    cwd: root, detached: true, stdio: ['ignore', 'ignore', 'pipe'],
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: root, LANG: 'C', LC_ALL: 'C' },
  });
  daemon.stderr.on('data', data => { daemonError = String(data); });
  daemon.once('error', error => { daemonError = error.message; });
  await waitForPort(port);
  const metadata = {
    scope: 'system-openssh-pty-fixture-only', host: '127.0.0.1', port,
    username: account.username, privateKeyPath: join(root, 'client'), wrongKeyPath: join(root, 'wrong-client'),
    knownHostsPath: join(root, 'known_hosts'), emptyKnownHostsPath: join(root, 'empty_known_hosts'),
    fingerprint, rootDirectory: root, serverConfigPath: join(root, 'sshd_config'),
    allowedCommands: ['printf', 'stty size', 'generate', 'exit'],
    exitCode: 7, maxGeneratorBytes: 2 * 1024 * 1024,
  };
  await writeFile(join(root, 'connection.json'), JSON.stringify(metadata, null, 2), { mode: 0o600 });
  return { metadata, metadataPath: join(root, 'connection.json') };
}

function clientOptions(metadata, overrides = {}) {
  return [
    '-tt', '-F', '/dev/null', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none',
    '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'StrictHostKeyChecking=yes', '-o', 'UpdateHostKeys=no',
    '-o', 'ConnectTimeout=3', '-o', 'ConnectionAttempts=1', '-o', 'LogLevel=ERROR', '-o', 'PasswordAuthentication=no',
    '-o', 'KbdInteractiveAuthentication=no', '-o', 'ClearAllForwardings=yes', '-o', 'PermitLocalCommand=no',
    '-o', `UserKnownHostsFile=${overrides.knownHostsPath ?? metadata.knownHostsPath}`, '-i', overrides.keyPath ?? metadata.privateKeyPath,
    '-p', String(metadata.port), `${metadata.username}@127.0.0.1`,
  ];
}

async function selfTest(metadata) {
  const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: metadata.rootDirectory, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' };
  const nonPtyOptions = clientOptions(metadata).filter(value => value !== '-tt');
  const denied = run(SSH, [...nonPtyOptions, 'fixture-check'], { env });
  assert(denied.status === 126 && (denied.stderr + denied.stdout).includes('P0_COMMAND_DENIED'), 'non-empty SSH_ORIGINAL_COMMAND was not rejected');
  const unknown = run(SSH, [...clientOptions(metadata, { knownHostsPath: metadata.emptyKnownHostsPath })], { env });
  assert(unknown.status === 255 && /Host key verification failed/.test(unknown.stderr), 'unknown host was not rejected');
  const wrongKey = run(SSH, [...clientOptions(metadata, { keyPath: metadata.wrongKeyPath }).filter(value => value !== '-tt')], { env });
  assert(wrongKey.status === 255 && /Permission denied/.test(wrongKey.stderr), 'wrong client key was not rejected');

  let ssh;
  try {
    ssh = spawn(SSH, clientOptions(metadata), { cwd: metadata.rootDirectory, env, stdio: ['pipe', 'pipe', 'pipe'] });
    activeClient = ssh;
    let output = '';
    let error = '';
    ssh.stdout.on('data', data => { output += String(data); });
    ssh.stderr.on('data', data => { error += String(data); });
    const waitFor = async (needle, timeout = 5000) => {
      const deadline = Date.now() + timeout;
      while (!output.includes(needle) && Date.now() < deadline) {
        if (ssh.exitCode !== null) throw new Error(`SSH exited before ${needle}: ${error}`);
        await delay(10);
      }
      assert(output.includes(needle), `SSH output did not contain ${needle}: ${JSON.stringify(output.slice(-5000))}`);
    };
    await waitFor('P0_INTERACTIVE_READY');
    ssh.stdin.write('printf\n');
    await waitFor('P0_SSH_TERM_OK 中文 🌏');
    ssh.stdin.write('stty size\n');
    const dimensionsDeadline = Date.now() + 5000;
    while (!/\b\d+ \d+\r/.test(output) && Date.now() < dimensionsDeadline) await delay(10);
    assert(/\b\d+ \d+\r/.test(output), `PTY dimensions were not reported: ${JSON.stringify(output)}`);
    ssh.stdin.write('generate\n');
    await waitFor('P0_GENERATOR_BEGIN');
    await delay(35);
    ssh.stdin.write('\u0003');
    await waitFor('P0_SSH_INTERRUPTED');
    const interruptedBytes = Buffer.byteLength(output.split('P0_GENERATOR_BEGIN')[1].split('P0_SSH_INTERRUPTED')[0], 'utf8');
    assert(interruptedBytes > 0 && interruptedBytes < metadata.maxGeneratorBytes, 'generator was not interrupted within finite output budget');
    ssh.stdin.write('exit\n');
    const [code] = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`SSH exit deadline exceeded: ${error}`)), 5000);
      ssh.once('exit', (status, signal) => { clearTimeout(timer); resolve([status, signal]); });
    });
    assert(code === metadata.exitCode, `interactive exit code was ${code}, expected ${metadata.exitCode}`);
    return { command: true, utf8: true, ptySize: true, boundedGeneratorInterrupt: true, exit7: true, interruptedBytes };
  } finally {
    if (ssh && ssh.exitCode === null && ssh.signalCode === null) {
      ssh.kill('SIGTERM');
      await Promise.race([new Promise(resolve => ssh.once('exit', resolve)), delay(1000)]);
      if (ssh.exitCode === null && ssh.signalCode === null) ssh.kill('SIGKILL');
    }
    activeClient = undefined;
  }
}

try {
  installSignalHandlers();
  const { metadata, metadataPath } = await setup();
  if (!SERVE) {
    const checks = await selfTest(metadata);
    console.log(JSON.stringify({ scope: 'system-openssh-pty-fixture-only', platform: process.platform, checks }, null, 2));
  } else {
    console.log(`connection metadata: ${metadataPath}`);
    console.log(`Fixture ready for 600 seconds; metadata fingerprint: ${metadata.fingerprint}`);
    await delay(600_000);
  }
} catch (error) {
  console.error(`Fixture failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}

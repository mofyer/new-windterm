import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { findNpmCli, freshDist, readyDist, PREPARATION_TIMEOUT_MS, runDiagnostic } from './conpty-framed-prepared-report.mjs';

const processResult = (overrides = {}) => ({ exitCode: 0, failure: null, outputBytes: 100,
  cleanup: { termination: 'observed', treeKill: 'not-requested', localResources: 'released' }, ...overrides });
const nested = (diagnosticPassed = true) => ({ version: 1, mode: 'startup-framed', diagnosticPassed,
  failure: diagnosticPassed ? null : 'tests-failed', tests: processResult(), build: null, samples: [] });
const dependencies = overrides => ({ npmCli: async () => '/private/npm-cli.js', beforeBuild: async () => true,
  afterBuild: async () => true, execute: async () => processResult(), framed: async () => nested(), ...overrides });

test('preparation uses node and real fixed npm commands before the unchanged nested runner', async () => {
  const calls = [];
  const updates = [];
  const result = await runDiagnostic(dependencies({ execute: async (command, args, options) => {
    calls.push({ command, args, timeout: options.timeoutMs });
    return processResult();
  }, framed: async options => {
    assert.equal(calls.length, 2);
    const value = nested();
    await options.onUpdate(value);
    return value;
  }, onUpdate: async value => updates.push(structuredClone(value)) }));
  assert.deepEqual(calls.map(call => [call.command, call.args]), [
    [process.execPath, ['/private/npm-cli.js', '--logs-max=0', '--prefix', 'apps/desktop', 'ci']],
    [process.execPath, ['/private/npm-cli.js', '--logs-max=0', '--prefix', 'apps/desktop', 'run', 'build']],
  ]);
  assert.ok(calls[0].timeout <= PREPARATION_TIMEOUT_MS);
  assert.ok(calls[1].timeout <= calls[0].timeout);
  assert.equal(result.status, 'pass');
  assert.equal(result.phase, 'done');
  assert.equal(result.failure, null);
  assert.deepEqual(result.diagnostic, nested());
  assert.equal(result.preparation.distReady, true);
  assert.ok(updates.some(update => update.phase === 'diagnostic' && update.diagnostic === null));
  assert.equal(JSON.stringify(result).includes('/private/'), false);
});

for (const [name, options, expectedFailure] of [
  ['existing dist', { beforeBuild: async () => false }, 'dist-not-fresh'],
  ['missing npm', { npmCli: async () => null }, 'npm-unavailable'],
  ['exhausted budget', { preparationTimeoutMs: 0 }, 'preparation-timeout'],
]) test(`${name} stops before npm or cargo`, async () => {
  const result = await runDiagnostic(dependencies({ execute: async () => assert.fail('no process'),
    framed: async () => assert.fail('no diagnostic'), ...options }));
  assert.equal(result.failure, expectedFailure);
  assert.equal(result.diagnostic, null);
  assert.equal(result.preparation.dependencyInstall, null);
  assert.equal(result.status, 'fail');
});

for (const [name, failureResult] of [
  ['exit', processResult({ exitCode: 1, failure: 'process-exit' })],
  ['timeout', processResult({ exitCode: null, failure: 'timeout' })],
  ['unobserved cleanup', processResult({ cleanup: { termination: 'unconfirmed', treeKill: 'requested', localResources: 'released' } })],
  ['resource failure', processResult({ cleanup: { termination: 'observed', treeKill: 'not-requested', localResources: 'release-failed' } })],
]) for (const failAt of [1, 2]) test(`npm step ${failAt} ${name} retains evidence and never starts cargo`, async () => {
  let count = 0;
  const result = await runDiagnostic(dependencies({ execute: async () => ++count === failAt ? failureResult : processResult(),
    framed: async () => assert.fail('no diagnostic') }));
  assert.equal(count, failAt);
  assert.equal(result.failure, failAt === 1 ? 'dependency-install-failed' : 'frontend-build-failed');
  assert.equal(result.diagnostic, null);
  assert.equal(result.preparation.distReady, false);
});

test('successful npm with absent build output still stops before cargo', async () => {
  const result = await runDiagnostic(dependencies({ afterBuild: async () => false,
    framed: async () => assert.fail('no diagnostic') }));
  assert.equal(result.failure, 'dist-missing');
  assert.equal(result.diagnostic, null);
});

test('nested failure preserves exact original report and cannot become prepared success', async () => {
  const diagnostic = nested(false);
  const result = await runDiagnostic(dependencies({ framed: async () => diagnostic }));
  assert.strictEqual(result.diagnostic, diagnostic);
  assert.equal(result.failure, 'diagnostic-failed');
  assert.equal(result.diagnosticPassed, false);
  assert.equal(result.phase, 'diagnostic');
});

test('preparation deadline includes both successful processes and post-build validation', async () => {
  let calls = 0;
  let elapsed = 0;
  const result = await runDiagnostic(dependencies({ preparationTimeoutMs: 10, now: () => elapsed,
    execute: async () => { calls++; return processResult(); },
    afterBuild: async () => { elapsed = 10; return true; },
    framed: async () => assert.fail('no diagnostic') }));
  assert.equal(calls, 2);
  assert.equal(result.failure, 'preparation-timeout');
});

test('npm discovery rejects a foreign package and an escaped CLI symlink', async () => {
  const root = await mkdtemp(join(tmpdir(), 'p1-npm-discovery-'));
  try {
    const node = join(root, 'bin/node');
    const npm = join(root, 'bin/node_modules/npm');
    await mkdir(join(npm, 'bin'), { recursive: true });
    await writeFile(node, 'node-fixture');
    await writeFile(join(npm, 'bin/npm-cli.js'), 'fixture');
    await writeFile(join(npm, 'package.json'), JSON.stringify({ name: 'foreign', bin: { npm: 'bin/npm-cli.js' } }));
    assert.equal(await findNpmCli(node), null);
    await writeFile(join(npm, 'package.json'), JSON.stringify({ name: 'npm', bin: { npm: 'bin/npm-cli.js' } }));
    assert.equal(await findNpmCli(node), await realpath(join(npm, 'bin/npm-cli.js')));
    await rm(join(npm, 'bin'), { recursive: true });
    await mkdir(join(root, 'foreign-bin'));
    await writeFile(join(root, 'foreign-bin/npm-cli.js'), 'fixture');
    await symlink(join(root, 'foreign-bin'), join(npm, 'bin'), 'junction');
    assert.equal(await findNpmCli(node), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('fresh and ready checks reject old directories, absent/empty outputs and symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'p1-dist-check-'));
  const dist = join(root, 'dist');
  try {
    assert.equal(await freshDist(dist), true);
    assert.equal(await readyDist(dist), false);
    await mkdir(dist);
    assert.equal(await freshDist(dist), false);
    await writeFile(join(dist, 'index.html'), '');
    assert.equal(await readyDist(dist), false);
    await writeFile(join(dist, 'index.html'), '<!doctype html>');
    assert.equal(await readyDist(dist), true);
    if (process.platform !== 'win32') {
      await rm(join(dist, 'index.html'));
      await writeFile(join(root, 'foreign.html'), '<!doctype html>');
      await symlink(join(root, 'foreign.html'), join(dist, 'index.html'));
      assert.equal(await readyDist(dist), false);
    }
    await rm(dist, { recursive: true });
    await symlink(root, dist, 'junction');
    assert.equal(await readyDist(dist), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('npm steps consume one shared preparation budget without resetting it', async () => {
  let elapsed = 0;
  const budgets = [];
  const result = await runDiagnostic(dependencies({ preparationTimeoutMs: 100, now: () => elapsed,
    execute: async (_command, _args, options) => { budgets.push(options.timeoutMs); elapsed += 60; return processResult(); },
    framed: async () => assert.fail('no diagnostic') }));
  assert.deepEqual(budgets, [100, 40]);
  assert.equal(result.failure, 'preparation-timeout');
});

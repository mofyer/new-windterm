import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseShellRepeats, scenarioCounts, scenarioPlan } from './runner-config.mjs';
import { SCENARIOS } from './scenarios.mjs';

test('shell repeat count defaults to zero and accepts only bounded integers', () => {
  assert.equal(parseShellRepeats(undefined), 0);
  for (let count = 0; count <= 10; count++) assert.equal(parseShellRepeats(String(count)), count);
  for (const invalid of ['', ' ', '-1', '11', '1.5', '1e1', '0x1', '+1', '01', 'NaN', 'Infinity', ' 1', '1\n', 1, null]) {
    assert.throws(() => parseShellRepeats(invalid), /integer from 0 to 10/);
  }
});

test('default plan preserves all seven original scenarios in order and without prefixes', () => {
  for (const platform of ['win32', 'linux', 'darwin']) {
    const plan = scenarioPlan(SCENARIOS, 0, platform);
    assert.equal(plan.length, 7);
    plan.forEach((scenario, index) => {
      assert.equal(scenario.name, SCENARIOS[index].name);
      assert.equal(scenario.run, SCENARIOS[index].run);
      assert.equal(scenario.kind, 'base');
      assert.equal(scenario.artifactPrefix, '');
    });
  }
});

test('Windows diagnostics append the exact shell function with unique names and artifact prefixes', () => {
  const plan = scenarioPlan(SCENARIOS, 10, 'win32');
  assert.equal(plan.length, 17);
  assert.deepEqual(plan.slice(0, 7), scenarioPlan(SCENARIOS, 0, 'win32'));
  assert.equal(new Set(plan.map(scenario => scenario.name)).size, 17);
  const repeated = plan.slice(7);
  assert.equal(new Set(repeated.map(scenario => scenario.artifactPrefix)).size, 10);
  repeated.forEach((scenario, index) => {
    const suffix = String(index + 1).padStart(2, '0');
    assert.equal(scenario.name, `diagnostic-shell-${suffix}`);
    assert.equal(scenario.artifactPrefix, `diag-shell-${suffix}-`);
    assert.equal(scenario.kind, 'diagnostic');
    assert.equal(scenario.run, SCENARIOS.find(item => item.name === 'local-terminal-shell').run);
  });
});

test('invalid plans and non-Windows diagnostics fail before running any scenario', () => {
  for (const count of [-1, 11, 1.5, NaN, '1']) {
    assert.throws(() => scenarioPlan(SCENARIOS, count, 'win32'), /integer from 0 to 10/);
  }
  for (const platform of ['linux', 'darwin']) {
    assert.throws(() => scenarioPlan(SCENARIOS, 1, platform), /only on Windows/);
  }
  assert.throws(() => scenarioPlan([], 1, 'win32'), /scenario is required/);
});

test('summary counts separate base results from diagnostics and retain prior failures', () => {
  const plan = scenarioPlan(SCENARIOS, 2, 'win32');
  const results = [
    ...plan.slice(0, 7).map(scenario => ({ kind: scenario.kind, status: 'passed' })),
    { kind: 'diagnostic', status: 'failed' },
    { kind: 'diagnostic', status: 'passed' },
  ];
  assert.deepEqual(scenarioCounts(plan, results), {
    base: { planned: 7, attempted: 7, passed: 7, failed: 0, skipped: 0 },
    diagnostic: { planned: 2, attempted: 2, passed: 1, failed: 1, skipped: 0 },
  });
  assert.deepEqual(scenarioCounts(plan, []).diagnostic, {
    planned: 2, attempted: 0, passed: 0, failed: 0, skipped: 0,
  });
});

test('runner rejects invalid input before platform skip or executable discovery', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./run.mjs', import.meta.url))], {
    env: { ...process.env, P1_NATIVE_SHELL_REPEATS: '11', P0_NATIVE_APP: '/nonexistent/native-app' },
    encoding: 'utf8', timeout: 5_000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /P1_NATIVE_SHELL_REPEATS must be an integer from 0 to 10/);
  assert.doesNotMatch(result.stdout, /skipped|new session|tauri-driver/);
});

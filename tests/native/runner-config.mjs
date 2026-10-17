// Diagnostic repetition is opt-in and bounded; it never replaces the base suite.
export function parseShellRepeats(value) {
  if (value === undefined) return 0;
  if (typeof value !== 'string' || !/^(?:[0-9]|10)$/.test(value)) {
    throw new Error('P1_NATIVE_SHELL_REPEATS must be an integer from 0 to 10');
  }
  return Number(value);
}

export function scenarioPlan(scenarios, repeats, platform) {
  if (!Number.isInteger(repeats) || repeats < 0 || repeats > 10) {
    throw new Error('shell repeats must be an integer from 0 to 10');
  }
  if (repeats > 0 && platform !== 'win32') {
    throw new Error('shell diagnostic repeats are supported only on Windows');
  }
  const plan = scenarios.map(scenario => ({ ...scenario, kind: 'base', artifactPrefix: '' }));
  const shell = scenarios.find(scenario => scenario.name === 'local-terminal-shell');
  if (repeats > 0 && !shell) throw new Error('local-terminal-shell scenario is required for diagnostic repeats');
  for (let index = 1; index <= repeats; index++) {
    const suffix = String(index).padStart(2, '0');
    plan.push({
      name: `diagnostic-shell-${suffix}`, run: shell.run,
      kind: 'diagnostic', artifactPrefix: `diag-shell-${suffix}-`,
    });
  }
  return plan;
}

export function scenarioCounts(plan, results) {
  return Object.fromEntries(['base', 'diagnostic'].map(kind => [kind, {
    planned: plan.filter(scenario => scenario.kind === kind).length,
    attempted: results.filter(result => result.kind === kind).length,
    ...Object.fromEntries(['passed', 'failed', 'skipped'].map(status => [status,
      results.filter(result => result.kind === kind && result.status === status).length,
    ])),
  }]));
}

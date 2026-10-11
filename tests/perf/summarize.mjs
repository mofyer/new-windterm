#!/usr/bin/env node
// Summarize P0 performance-baseline raw outputs as median [min, max].
// No npm dependencies. Usage:
//   node tests/perf/summarize.mjs rust  <rust-output-dir>
//   node tests/perf/summarize.mjs jsonl <file.jsonl> [...]
// JSONL lines must be {"group": "...", "metrics": {"name": number, ...}}.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const PAYLOAD_MIB = 2; // pty_diagnose / pty_probe payload: exactly 2 MiB

export function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return { n: sorted.length, median, min: sorted[0], max: sorted[sorted.length - 1] };
}

function format(value) {
  if (Number.isInteger(value) && Math.abs(value) >= 1000) return value.toLocaleString('en-US');
  if (Math.abs(value) >= 100) return value.toFixed(1);
  if (Math.abs(value) >= 1) return value.toFixed(2);
  return value.toFixed(3);
}

function number(text, pattern, label) {
  const match = text.match(pattern);
  if (!match) throw new Error(`missing ${label}`);
  return Number(match[1]);
}

function parseTime(text) {
  const match = text.match(/([\d.]+) real\s+([\d.]+) user\s+([\d.]+) sys/);
  if (!match) throw new Error('missing /usr/bin/time -l summary');
  return {
    real_s: Number(match[1]),
    user_s: Number(match[2]),
    sys_s: Number(match[3]),
    max_rss_mib: number(text, /(\d+)\s+maximum resident set size/, 'max RSS') / 1024 / 1024,
  };
}

function rustRecords(dir) {
  const runs = join(dir, 'runs');
  const records = [];
  for (const name of readdirSync(runs).filter((file) => file.endsWith('.out')).sort()) {
    const match = name.match(/^(pty_diagnose|pty_probe)-(default|readiness)-(\d+)\.out$/);
    if (!match) continue;
    const [, bin, variant] = match;
    const base = join(runs, name.slice(0, -4));
    const out = readFileSync(`${base}.out`, 'utf8');
    const time = parseTime(readFileSync(`${base}.time`, 'utf8'));
    if (!/^PASS/m.test(out)) throw new Error(`${name} has no PASS line`);
    let metrics;
    if (bin === 'pty_diagnose') {
      const loadMs = number(out, /load_ms=([\d.]+)/, 'load_ms');
      metrics = {
        load_ms: loadMs,
        load_mib_s_incl_pause: PAYLOAD_MIB / (loadMs / 1000),
        first_marker_ms: number(out, /first_marker_ms=([\d.]+)/, 'first_marker_ms'),
        ctrl_c_ms: number(out, /cancel_ms=([\d.]+)/, 'cancel_ms'),
        idle_reads_1s_window: number(out, /idle_reads=(\d+)/, 'idle_reads'),
        interrupt_read_bytes: number(out, /interrupt_read_bytes=(\d+)/, 'interrupt_read_bytes'),
        peak_unacked_bytes: number(out, /peak_bytes=(\d+)/, 'peak_bytes'),
        ...time,
      };
    } else {
      if (!/PASS 12 real PTY open\/write\/close cycles/.test(out)) throw new Error(`${name} missing cycle PASS`);
      metrics = {
        load_s_incl_pause: number(out, /bytes in ([\d.]+)s including ACK pause/, 'load seconds'),
        load_kib_s_incl_pause: number(out, /([\d.]+) KiB\/s observed/, 'KiB/s'),
        peak_unacked_bytes: number(out, /peak unacknowledged=(\d+)/, 'peak unacknowledged'),
        ...time,
      };
    }
    if (existsSync(`${base}.load`)) {
      const load = readFileSync(`${base}.load`, 'utf8').match(/load averages?: ([\d.]+)/);
      if (load) metrics.system_load1 = Number(load[1]);
    }
    records.push({ group: `${bin} ${variant}`, metrics });
  }
  return records;
}

function jsonlRecords(files) {
  return files.flatMap((file) =>
    readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line)),
  );
}

function print(records) {
  const groups = new Map();
  for (const { group, metrics } of records) {
    const metricMap = groups.get(group) ?? new Map();
    for (const [name, value] of Object.entries(metrics)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      metricMap.set(name, [...(metricMap.get(name) ?? []), value]);
    }
    groups.set(group, metricMap);
  }
  console.log('| group | metric | n | median | min | max |');
  console.log('| --- | --- | ---: | ---: | ---: | ---: |');
  for (const [group, metricMap] of groups) {
    for (const [name, values] of metricMap) {
      const s = stats(values);
      console.log(`| ${group} | ${name} | ${s.n} | ${format(s.median)} | ${format(s.min)} | ${format(s.max)} |`);
    }
  }
}

const [mode, ...inputs] = process.argv.slice(2);
try {
  if (mode === 'rust' && inputs.length === 1) print(rustRecords(inputs[0]));
  else if (mode === 'jsonl' && inputs.length > 0) print(jsonlRecords(inputs));
  else {
    console.error('Usage: summarize.mjs rust <dir> | jsonl <file.jsonl> [...]');
    process.exit(2);
  }
} catch (error) {
  console.error(`summarize failed: ${error.message}`);
  process.exit(1);
}

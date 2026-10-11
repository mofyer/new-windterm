#!/bin/sh
# Optional P0 baseline: whole-test wall time of the existing 2 MiB loopback
# russh tests (apps/desktop/src-tauri/tests/ssh_terminal.rs). The test server is
# an in-process loopback russh fixture, not OpenSSH or a real remote shell.
#
# Usage (repository root): tests/perf/ssh-loopback-baseline.sh [runs]
# Output: .artifacts/p0/perf-baseline/ssh-loopback/ (ignored by Git)
set -eu

RUNS=${1:-3}
case "$RUNS" in
  ''|*[!0-9]*) echo "runs must be a positive integer" >&2; exit 2 ;;
esac
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
MANIFEST="$ROOT/apps/desktop/src-tauri/Cargo.toml"
OUT=${PERF_OUT:-"$ROOT/.artifacts/p0/perf-baseline"}/ssh-loopback
mkdir -p "$OUT"
rm -f "$OUT"/*.out "$OUT"/*.time "$OUT"/*.load

# Build once and run the produced test executable directly, so compilation is
# never inside the timed region.
BIN=$(cargo test --locked --manifest-path "$MANIFEST" --test ssh_terminal --all-features \
  --no-run --message-format=json 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const e=s.split("\n").filter(Boolean).map(JSON.parse).filter(m=>m.reason==="compiler-artifact"&&m.target.name==="ssh_terminal"&&m.executable);if(!e.length)process.exit(1);console.log(e.at(-1).executable)})')
echo "test executable: $BIN"

for test in bounded_two_mib_output_recovers_after_ack_pause_and_interrupts burst_with_prompt_ack_is_not_false_overload; do
  i=1
  while [ "$i" -le "$RUNS" ]; do
    uptime > "$OUT/$test-$i.load"
    /usr/bin/time -l "$BIN" --exact "$test" --test-threads=1 > "$OUT/$test-$i.out" 2> "$OUT/$test-$i.time"
    grep -q '^test result: ok. 1 passed' "$OUT/$test-$i.out" || { echo "$test run $i did not pass" >&2; exit 1; }
    echo "$test run $i: $(grep -Eo '[0-9.]+ real' "$OUT/$test-$i.time")"
    i=$((i + 1))
  done
done

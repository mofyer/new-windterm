#!/bin/sh
# P0 performance baseline: Rust PTY throughput and Ctrl-C latency.
# Reuses the existing pty_probe / pty_diagnose binaries; it never changes
# production code and never prints terminal contents (the binaries only
# print counters and PASS/FAIL lines).
#
# Usage (repository root):
#   tests/perf/rust-pty-baseline.sh [debug|release] [runs]
# Output: .artifacts/p0/perf-baseline/rust-<profile>/ (ignored by Git)
# Summary: node tests/perf/summarize.mjs rust .artifacts/p0/perf-baseline/rust-<profile>
set -eu

PROFILE=${1:-debug}
RUNS=${2:-3}
case "$PROFILE" in
  debug) PROFILE_FLAG="" ;;
  release) PROFILE_FLAG="--release" ;;
  *) echo "profile must be debug or release" >&2; exit 2 ;;
esac
case "$RUNS" in
  ''|*[!0-9]*) echo "runs must be a positive integer" >&2; exit 2 ;;
esac
[ "$RUNS" -ge 1 ] || { echo "runs must be >= 1" >&2; exit 2; }

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
MANIFEST="$ROOT/apps/desktop/src-tauri/Cargo.toml"
TARGET_DIR=${CARGO_TARGET_DIR:-"$ROOT/apps/desktop/src-tauri/target"}
OUT=${PERF_OUT:-"$ROOT/.artifacts/p0/perf-baseline"}/rust-$PROFILE
mkdir -p "$OUT/bin/default" "$OUT/bin/readiness" "$OUT/runs"
rm -f "$OUT"/runs/*

# Build each feature set, then copy it so a later build cannot overwrite it.
build() {
  features=$1 bin=$2 variant=$3
  # shellcheck disable=SC2086 # PROFILE_FLAG is intentionally empty or one flag.
  cargo build --locked $PROFILE_FLAG --manifest-path "$MANIFEST" \
    ${features:+--features "$features"} --bin "$bin"
  cp "$TARGET_DIR/$PROFILE/$bin" "$OUT/bin/$variant/$bin"
}
build "" pty_probe default
build pty-readiness pty_probe readiness
build pty-diagnostics pty_diagnose default
build pty-diagnostics,pty-readiness pty_diagnose readiness

{
  echo "date=$(date '+%Y-%m-%dT%H:%M:%S%z')"
  echo "commit=$(git -C "$ROOT" rev-parse HEAD)"
  echo "profile=$PROFILE runs=$RUNS"
  echo "uptime_start=$(uptime)"
} > "$OUT/meta.txt"

# Alternate the order (default/readiness, readiness/default, ...) to reduce a
# fixed position bias. Each run is a fresh process and a fresh PTY session.
i=1
while [ "$i" -le "$RUNS" ]; do
  if [ $((i % 2)) -eq 1 ]; then order="default readiness"; else order="readiness default"; fi
  for variant in $order; do
    for bin in pty_diagnose pty_probe; do
      args=""
      [ "$bin" = pty_diagnose ] && args="--sample"
      log="$OUT/runs/$bin-$variant-$i"
      # Other work on the machine changes timings; keep the load next to each run.
      uptime > "$log.load"
      # shellcheck disable=SC2086
      /usr/bin/time -l "$OUT/bin/$variant/$bin" $args > "$log.out" 2> "$log.time"
      echo "$bin $variant run $i: $(grep -c '^PASS' "$log.out") PASS line(s)"
    done
  done
  i=$((i + 1))
done
echo "uptime_end=$(uptime)" >> "$OUT/meta.txt"
echo "Raw logs: $OUT"

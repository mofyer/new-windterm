#!/bin/sh
# P0 performance baseline: desktop bundle size/architecture, launch-to-window,
# idle and one-local-terminal RSS/CPU. macOS only; needs Accessibility
# permission for the calling terminal (used to find/press the "本地终端" button).
#
# Usage (repository root, after building the bundle):
#   (cd apps/desktop && npm run tauri build -- --bundles app)
#   tests/perf/app-baseline.sh [path/to/New WindTerm P0.app] [runs]
# Output: .artifacts/p0/perf-baseline/app-<release|debug>/ (ignored by Git)
# Summary: node tests/perf/summarize.mjs jsonl <out>/app.jsonl
set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
APP=${1:-"$ROOT/apps/desktop/src-tauri/target/release/bundle/macos/New WindTerm P0.app"}
RUNS=${2:-3}
case "$RUNS" in
  ''|*[!0-9]*) echo "runs must be a positive integer" >&2; exit 2 ;;
esac
[ "$(uname -s)" = Darwin ] || { echo "macOS only" >&2; exit 2; }
[ -d "$APP" ] || { echo "missing app bundle: $APP" >&2; exit 2; }
case "$APP" in
  */release/*) FLAVOR=release ;;
  *) FLAVOR=debug ;;
esac
OUT=${PERF_OUT:-"$ROOT/.artifacts/p0/perf-baseline"}/app-$FLAVOR
mkdir -p "$OUT"
EXE="$APP/Contents/MacOS/$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Contents/Info.plist")"

{
  echo "date=$(date '+%Y-%m-%dT%H:%M:%S%z') commit=$(git -C "$ROOT" rev-parse HEAD)"
  echo "bundle_kib=$(du -sk "$APP" | cut -f1)"
  find "$APP" -type f -exec stat -f '%z %N' {} +
  find "$APP/Contents/MacOS" -type f -exec file {} +
  find "$APP/Contents/MacOS" -type f -exec lipo -info {} +
  codesign -dv "$APP" 2>&1 | grep -E '^(Format|CodeDirectory|Signature)=' || true
} > "$OUT/bundle.txt"
cat "$OUT/bundle.txt"

# Compile the helper once so swift compilation is not part of any timing.
HELPER="$OUT/app-launch"
swiftc -O -o "$HELPER" "$ROOT/tests/perf/app-launch.swift"

: > "$OUT/app.jsonl"
for mode in startup resources; do
  i=1
  while [ "$i" -le "$RUNS" ]; do
    if pgrep -f "$EXE" > /dev/null; then
      echo "an instance of this bundle is already running; quit it first" >&2
      exit 1
    fi
    if ! line=$("$HELPER" "$APP" "$mode"); then
      echo "$mode run $i failed; see the app-launch message above" >&2
      exit 1
    fi
    echo "$line" | tee -a "$OUT/app.jsonl"
    sleep 3 # let the previous instance's helpers exit before the next launch
    i=$((i + 1))
  done
done
echo "Raw results: $OUT/app.jsonl"

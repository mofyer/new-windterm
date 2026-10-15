#!/bin/sh
# Local Windows type-check and clippy for the desktop crate on macOS/Linux.
# No linking and no runnable artifacts: C dependencies compile against stub
# headers, and the archiver and resource compiler are stand-ins. Windows tests
# still only run on CI.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
export PATH="$HOME/.cargo/bin:$PATH"
export CFLAGS_x86_64_pc_windows_msvc="-I$HERE/include"
export AR_x86_64_pc_windows_msvc="$HERE/fake-lib.sh"
export RC_x86_64_pc_windows_msvc="$HERE/fake-rc.sh"
rustup target list --installed | grep -qx x86_64-pc-windows-msvc || rustup target add x86_64-pc-windows-msvc
cd "$ROOT"
cargo clippy --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --target x86_64-pc-windows-msvc \
  --all-targets --all-features --target-dir apps/desktop/src-tauri/target/wincheck -- -D warnings "$@"

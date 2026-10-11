import { defineConfig } from "vite";

export default defineConfig({
  build: {
    // Pinned to Vite 8.3.4's full "baseline-widely-available" list so an upgrade
    // cannot silently raise it. safari16.4 is the WebKit built into macOS 13.3,
    // the bundle's minimumSystemVersion (docs/p0/RELEASE.zh-CN.md); change both together.
    target: ["chrome111", "edge111", "firefox114", "safari16.4", "ios16.4"],
  },
  server: {
    watch: {
      // Cargo/Tauri generates HTML under target; it must not reload live PTYs.
      ignored: ["**/src-tauri/**"],
    },
  },
});

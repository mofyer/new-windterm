import { defineConfig } from "vite";

export default defineConfig({
  server: {
    watch: {
      // Cargo/Tauri generates HTML under target; it must not reload live PTYs.
      ignored: ["**/src-tauri/**"],
    },
  },
});

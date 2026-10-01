import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ command, isPreview }) => ({
  base: command === "build" || isPreview === true ? "/jasytata/" : "/",
  plugins: [react()],
  server: {
    port: 5173,
  },
}));

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ command }) => ({
  base: command === "serve" ? "/" : "/jasytata/",
  plugins: [react()],
  server: {
    port: 5173,
  },
}));

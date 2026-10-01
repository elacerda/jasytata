// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { ConfigEnv, UserConfig } from "vite";
import viteConfig from "../vite.config";

const configFor = viteConfig as (env: ConfigEnv) => UserConfig;
const baseCases: Array<{ environment: string; env: ConfigEnv; expectedBase: string }> = [
  {
    environment: "development server",
    env: { command: "serve", mode: "development", isSsrBuild: false },
    expectedBase: "/",
  },
  {
    environment: "production build",
    env: { command: "build", mode: "production", isSsrBuild: false },
    expectedBase: "/jasytata/",
  },
  {
    environment: "production preview",
    env: { command: "serve", mode: "production", isSsrBuild: false, isPreview: true },
    expectedBase: "/jasytata/",
  },
];

describe("Vite asset base", () => {
  it.each(baseCases)("uses $expectedBase for the $environment", ({ env, expectedBase }) => {
    expect(configFor(env).base).toBe(expectedBase);
  });
});

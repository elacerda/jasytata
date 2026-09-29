import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync("src/styles.css", "utf8");

function getRuleZIndex(rule) {
  const declarations = stylesheet.match(rule)?.[1] ?? "";
  return Number(declarations.match(/z-index:\s*(\d+)/)?.[1]);
}

describe("Aladin fullscreen stacking", () => {
  it("places the fullscreen map above the Jasytata header", () => {
    const topbarZIndex = getRuleZIndex(/\.topbar\s*\{([^}]*)\}/s);
    const fullscreenZIndex = getRuleZIndex(/\.aladin-fullscreen\s*\{([^}]*)\}/s);

    expect(fullscreenZIndex).toBeGreaterThan(topbarZIndex);
  });
});

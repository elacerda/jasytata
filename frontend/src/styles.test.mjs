import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync("src/styles.css", "utf8");
const narrowDesktopRules = stylesheet.match(/@media \(max-width: 1180px\) \{([\s\S]*?)\n\}/)?.[1] ?? "";

function getRule(rule) {
  return stylesheet.match(rule)?.[1] ?? "";
}

function getRuleZIndex(rule) {
  const declarations = getRule(rule);
  return Number(declarations.match(/z-index:\s*(\d+)/)?.[1]);
}

describe("Aladin fullscreen stacking", () => {
  it("places the fullscreen map above the Jasytata header", () => {
    const topbarZIndex = getRuleZIndex(/\.topbar\s*\{([^}]*)\}/s);
    const fullscreenZIndex = getRuleZIndex(/\.aladin-fullscreen\s*\{([^}]*)\}/s);

    expect(fullscreenZIndex).toBeGreaterThan(topbarZIndex);
  });
});

describe("desktop workspace containment", () => {
  it("contains the clipped paste label inside its independently scrolling section", () => {
    expect(getRule(/\.import-section\s*\{([^}]*)\}/s)).toMatch(/position:\s*relative/);
  });

  it("constrains catalogue selects and stacks their controls within the panel", () => {
    expect(getRule(/\.catalogue-settings\s*\{([^}]*)\}/s)).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    const selectRule = getRule(/\.catalogue-settings select\s*\{([^}]*)\}/s);
    expect(selectRule).toMatch(/min-width:\s*0/);
    expect(selectRule).toMatch(/max-width:\s*100%/);
    expect(selectRule).toMatch(/width:\s*100%/);
    expect(selectRule).toMatch(/background:\s*#fff/);
    expect(selectRule).toMatch(/color:\s*var\(--ink\)/);
    expect(getRule(/\.catalogue-settings option\s*\{([^}]*)\}/s)).toMatch(/background:\s*#fff/);
    const darkControlRule = getRule(/\.app-shell\[data-theme="dark"\] \.catalogue-settings select,\s*\.app-shell\[data-theme="dark"\] \.catalogue-settings option\s*\{([^}]*)\}/s);
    expect(darkControlRule).toMatch(/background:\s*#0a1b35/);
    expect(darkControlRule).toMatch(/border-color:\s*#344c69/);
    expect(stylesheet).toMatch(/\.app-shell\[data-theme="dark"\] \.catalogue-settings select,[\s\S]*?color:\s*#bfcee0\s*!important/);
  });

  it("stacks export fields and aligns proposal actions with narrow panel padding", () => {
    expect(narrowDesktopRules).toMatch(/\.export-fields\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
    expect(narrowDesktopRules).toMatch(/\.proposal-actions\s*\{[^}]*margin:\s*10px -12px -18px;\s*padding:\s*10px 12px 14px;/s);
  });

  it("clips only top-bar status text so the ready-dot halo stays visible", () => {
    expect(getRule(/\.topbar-state\s*\{([^}]*)\}/s)).not.toMatch(/overflow\s*:/);
    expect(getRule(/\.topbar-state-label\s*\{([^}]*)\}/s)).toMatch(/overflow:\s*hidden/);
    expect(getRule(/\.status-dot\.is-ready\s*\{([^}]*)\}/s)).toMatch(/box-shadow:/);
  });
});

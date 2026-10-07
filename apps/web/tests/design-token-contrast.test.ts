import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

type Palette = Readonly<Record<string, string>>;
type Pair = readonly [foreground: string, background: string];

function channel(value: number): number {
  const normalized = value / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) throw new Error(`invalid hex color: ${hex}`);
  const value = match[1]!;
  const red = channel(Number.parseInt(value.slice(0, 2), 16));
  const green = channel(Number.parseInt(value.slice(2, 4), 16));
  const blue = channel(Number.parseInt(value.slice(4, 6), 16));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(foreground: string, background: string): number {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter! + 0.05) / (darker! + 0.05);
}

function tokens(block: string): Palette {
  const result: Record<string, string> = {};
  for (const match of block.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6})\s*;/gi)) result[match[1]!] = match[2]!.toUpperCase();
  return result;
}

function block(source: string, pattern: RegExp, label: string): string {
  const value = pattern.exec(source)?.[1];
  if (!value) throw new Error(`missing ${label} token block`);
  return value;
}

function mixHex(foreground: string, background: string, foregroundWeight: number): string {
  const parts = (hex: string) => [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
  const mixed = parts(foreground).map((value, index) => Math.round(value * foregroundWeight + parts(background)[index]! * (1 - foregroundWeight)));
  return `#${mixed.map((value) => value.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

const bodyTextPairs: readonly Pair[] = [
  ["text", "page"], ["text", "card"], ["text", "sidebar"], ["text", "accent-tint"],
  ["secondary-text", "page"], ["secondary-text", "card"], ["secondary-text", "sidebar"], ["secondary-text", "accent-tint"],
  ["accent", "page"], ["accent", "card"], ["accent", "sidebar"], ["accent", "accent-tint"],
  ["success", "page"], ["success", "card"], ["success", "sidebar"], ["success", "accent-tint"],
  ["warning", "page"], ["warning", "card"], ["warning", "sidebar"], ["warning", "accent-tint"],
  ["danger", "page"], ["danger", "card"], ["danger", "sidebar"], ["danger", "accent-tint"],
  ["accent-foreground", "accent"], ["accent-foreground", "accent-hover"],
] as const;

const largeTextPairs: readonly Pair[] = [
  ["text", "page"], ["text", "card"], ["text", "sidebar"],
  ["accent", "page"], ["accent", "card"], ["accent", "sidebar"],
] as const;

const controlBorderPairs: readonly Pair[] = [
  ["border-control", "page"], ["border-control", "card"], ["border-control", "sidebar"],
] as const;

describe("Dhara design-token contrast", () => {
  it("checks the documented WCAG pair matrix for light and dark themes", async () => {
    const css = await readFile("apps/web/app/globals.css", "utf8");
    const light = tokens(block(css, /:root\s*\{([\s\S]*?)\n\}/, "light"));
    const dark = tokens(block(css, /:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/, "dark"));

    // --border is decorative (cards, dividers, sidebar edge, table rules) and intentionally exempt.
    // Checked body-text pairs (>= 4.5:1): text, secondary-text, accent, success, warning and danger
    // on page/card/sidebar/accent-tint, plus accent-foreground on accent and accent-hover.
    // Checked large-text pairs (>= 3:1): text and accent on page/card/sidebar.
    // Checked control pairs (>= 3:1): border-control on page/card/sidebar; the focus ring uses this token too.
    for (const [theme, palette] of [["light", light], ["dark", dark]] as const) {
      for (const [foreground, background] of bodyTextPairs) {
        expect(contrast(palette[foreground]!, palette[background]!), `${theme}: --${foreground} on --${background}`).toBeGreaterThanOrEqual(4.5);
      }
      for (const [foreground, background] of largeTextPairs) {
        expect(contrast(palette[foreground]!, palette[background]!), `${theme}: large --${foreground} on --${background}`).toBeGreaterThanOrEqual(3);
      }
      for (const [foreground, background] of controlBorderPairs) {
        expect(contrast(palette[foreground]!, palette[background]!), `${theme}: --${foreground} on --${background}`).toBeGreaterThanOrEqual(3);
      }
      expect(palette.page).not.toMatch(/^#(?:000000|FFFFFF)$/i);
      for (const textToken of ["text", "secondary-text", "accent-foreground"]) expect(palette[textToken]).not.toMatch(/^#(?:000000|FFFFFF)$/i);
    }

    expect(light.border).toBe("#E4E2DC");
    expect(dark.border).toBe("#2C3238");
    expect(light["border-control"]).toBe("#8D8C88");
    expect(dark["border-control"]).toBe("#666A6E");
    expect(light.success).toBe("#1A7E4A");
    expect(light.warning).toBe("#B35209");
    expect(light["accent-foreground"]).toBe("#FAFAF7");
    expect(dark["accent-hover"]).toBe(mixHex(dark.accent!, dark.page!, 0.88));
  });
});

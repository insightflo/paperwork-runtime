import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const uiRoot = new URL("../", import.meta.url);
const html = readFileSync(new URL("index.html", uiRoot), "utf8");
const head = html.match(/<head>([\s\S]*?)<\/head>/)?.[1] ?? "";
const description = "Paperwork — AI agent operations workspace for teams, workflows, and personal endpoint bots.";

function attributes(tag: string): Record<string, string> {
  return Object.fromEntries(
    [...tag.matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/g)].map((match) => [match[1], match[2]]),
  );
}

function meta(attribute: "name" | "property", value: string): string {
  const tags = [...head.matchAll(/<meta\b[^>]*>/g)]
    .map(([tag]) => attributes(tag))
    .filter((tag) => tag[attribute] === value);
  expect(tags).toHaveLength(1);
  return tags[0].content;
}

function bootstrapTheme(values: Record<string, string> = {}, storageBlocked = false) {
  const scripts = [...head.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  expect(scripts).toHaveLength(1);
  const classes = new Set(["dark"]);
  const style = { colorScheme: "" };
  const reads: string[] = [];
  let themeColor = meta("name", "theme-color");
  runInNewContext(scripts[0][1], {
    window: {
      localStorage: {
        getItem(key: string) {
          reads.push(key);
          if (storageBlocked) throw new Error("Storage unavailable");
          return values[key] ?? null;
        },
      },
    },
    document: {
      documentElement: {
        classList: {
          toggle(name: string, enabled: boolean) {
            if (enabled) classes.add(name);
            else classes.delete(name);
          },
          add: (name: string) => classes.add(name),
        },
        style,
      },
      querySelector(selector: string) {
        expect(selector).toBe('meta[name="theme-color"]');
        return { setAttribute: (_name: string, value: string) => { themeColor = value; } };
      },
    },
  });
  return { dark: classes.has("dark"), colorScheme: style.colorScheme, themeColor, reads };
}

describe("Front-End Checklist head and accessibility contracts", () => {
  it("declares language, UTF-8, title, and a viewport that allows zoom", () => {
    expect(html).toMatch(/<html\b[^>]*\blang="en"/);
    expect(head).toMatch(/<meta charset="UTF-8"\s*\/>/);
    expect(head).toContain("<title>Paperwork</title>");
    expect(meta("name", "viewport")).toBe("width=device-width, initial-scale=1.0, viewport-fit=cover");
    expect(head).not.toMatch(/maximum-scale|user-scalable/);
  });

  it("provides consistent descriptions and social sharing metadata", () => {
    expect(meta("name", "description")).toBe(description);
    expect(meta("property", "og:type")).toBe("website");
    expect(meta("property", "og:title")).toBe("Paperwork");
    expect(meta("property", "og:description")).toBe(description);
    expect(meta("name", "twitter:card")).toBe("summary");
    expect(meta("name", "twitter:title")).toBe("Paperwork");
    expect(meta("name", "twitter:description")).toBe(description);
  });

  it("preserves branding and favicon marker pairs in order", () => {
    for (const marker of ["PAPERCLIP_RUNTIME_BRANDING", "PAPERCLIP_FAVICON"]) {
      const start = `<!-- ${marker}_START -->`;
      const end = `<!-- ${marker}_END -->`;
      expect(head.split(start)).toHaveLength(2);
      expect(head.split(end)).toHaveLength(2);
      expect(head.indexOf(start)).toBeLessThan(head.indexOf(end));
    }
  });

  it("provides readable JavaScript-disabled guidance before the app root", () => {
    const body = html.match(/<body>([\s\S]*?)<\/body>/)?.[1] ?? "";
    const fallback = body.match(/<noscript>([\s\S]*?)<\/noscript>/);
    expect(fallback).not.toBeNull();
    expect(fallback![1]).toMatch(/Paperwork[\s\S]*JavaScript[\s\S]*enable/i);
    expect(fallback![1]).not.toMatch(/hidden|aria-hidden|display:\s*none/i);
    expect(body.indexOf("</noscript>")).toBeLessThan(body.indexOf('<div id="root">'));
  });

  it("keeps a focus-visible skip link connected to the focusable main content", () => {
    const layout = readFileSync(new URL("src/components/Layout.tsx", uiRoot), "utf8");
    expect(layout).toMatch(/<a\b[^>]*href="#main-content"[^>]*className="sr-only focus:not-sr-only[^>]*>\s*Skip to main content\s*<\/a>/i);
    expect(layout).toMatch(/<main\b[^>]*id="main-content"[^>]*tabIndex=\{-1\}/);
  });

  it.each([
    ["light", "dark", false, "#f3eee4"],
    ["dark", "light", true, "#171412"],
  ] as const)("prefers paperwork.theme=%s over legacy %s", (primary, legacy, dark, themeColor) => {
    expect(bootstrapTheme({ "paperwork.theme": primary, "paperclip.theme": legacy })).toEqual({
      dark, colorScheme: primary, themeColor, reads: ["paperwork.theme"],
    });
  });

  it.each(["light", "dark"])("uses legacy %s when the new key is absent", (theme) => {
    expect(bootstrapTheme({ "paperclip.theme": theme })).toMatchObject({
      dark: theme === "dark", colorScheme: theme, reads: ["paperwork.theme", "paperclip.theme"],
    });
  });

  it("defaults to dark for absent, invalid, or inaccessible storage", () => {
    for (const result of [bootstrapTheme(), bootstrapTheme({ "paperwork.theme": "invalid" }), bootstrapTheme({}, true)]) {
      expect(result).toMatchObject({ dark: true, colorScheme: "dark", themeColor: "#171412" });
    }
  });
});

describe("Front-End Checklist SEO and web app manifest contracts", () => {
  it("disallows API crawling", () => {
    expect(readFileSync(new URL("public/robots.txt", uiRoot), "utf8")).toBe("User-agent: *\nDisallow: /api/\n");
  });

  it("links a valid Paperwork manifest with working install icons", () => {
    expect(head).toMatch(/<link rel="manifest" href="\/site.webmanifest"\s*\/>/);
    const raw = readFileSync(new URL("public/site.webmanifest", uiRoot), "utf8");
    const manifest = JSON.parse(raw);
    expect(raw).not.toMatch(/paperclip/i);
    expect(manifest.name).toBe("Paperwork");
    expect(manifest.short_name).toBe("Paperwork");
    expect(manifest.display).toBe("standalone");
    for (const color of [manifest.theme_color, manifest.background_color]) {
      expect(color).toMatch(/^#[\da-f]{6}$/i);
    }
    expect(manifest.start_url).toBe("/");
    expect(manifest.scope).toBe("/");
    expect(manifest.icons).toEqual(expect.arrayContaining([
      expect.objectContaining({ sizes: "192x192", type: "image/png" }),
      expect.objectContaining({ sizes: "512x512", type: "image/png" }),
    ]));
    for (const icon of manifest.icons) {
      expect(icon.src).toMatch(/^\/[\w.-]+\.png$/);
      expect(icon.type).toBe("image/png");
      expect(icon.purpose ?? "any").toMatch(/^(any|maskable|monochrome)( (any|maskable|monochrome))*$/);
      const png = readFileSync(new URL(`public${icon.src}`, uiRoot));
      expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect(png.toString("ascii", 12, 16)).toBe("IHDR");
      expect(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`).toBe(icon.sizes);
    }
  });
});

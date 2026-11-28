#!/usr/bin/env node
// Front-End-Checklist audit (high-priority rules from thedaviddias/Front-End-Checklist).
// Zero external dependencies. Exit 0 = pass, exit 1 = violations found.
//
// Checks
//   HTML/Head (ui/index.html): <!DOCTYPE html>, <html lang>, <meta charset="UTF-8">,
//     viewport without user-scalable=no / maximum-scale=1, <title>, description meta,
//     og:title / og:description, favicon + site.webmanifest link, <noscript> fallback,
//     and zero inline onclick= / onerror= attributes.
//   SEO/Static: ui/public/robots.txt exists and is non-empty; ui/public/site.webmanifest
//     is valid JSON with a non-empty "name" and a non-empty "icons" array.
//   Security: ui/src/**/*.{ts,tsx} (excluding *.test.*) — every <a target="_blank"> must
//     carry a rel attribute containing noopener.
//   Accessibility: same file set — every <img> must carry an alt attribute (alt="" is
//     allowed for decorative images).
//   CSS (opt-in): ui/src/index.css must include reduced-motion, print, and
//     :focus-visible rules. Enable after integrating the stage-37 CSS additions.
//
// Modes
//   (default)   run all checks. While stage-36 workers run in parallel, ui/index.html and
//               ui/public/* are owned by the w5 head/a11y task, so gaps there are
//               WARNINGS. ui/src violations are always errors.
//   --strict    every violation is an error (use in CI / post-integration).
//   --src-only  run only the ui/src security + accessibility checks (errors).
//   --head-only run only HTML/Head + SEO/Static checks.
//   --with-css  also check CSS (errors); ignored by --head-only / --src-only.
//
// Fixture testing: set FE_CHECKLIST_UI_DIR to a directory shaped like ui/
// (index.html, public/, src/).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("Usage: node scripts/check-frontend-checklist.mjs [--src-only | --head-only] [--strict] [--with-css]");
  process.exit(0);
}
const srcOnly = args.includes("--src-only");
const headOnly = args.includes("--head-only");
const strict = args.includes("--strict");
const withCss = args.includes("--with-css") && !srcOnly && !headOnly;
if (srcOnly && headOnly) {
  console.error("--src-only and --head-only cannot be combined.");
  process.exit(1);
}

const uiDir = process.env.FE_CHECKLIST_UI_DIR
  || join(dirname(fileURLToPath(import.meta.url)), "..", "ui");

const findings = [];
function add(level, file, line, rule, problem, fix) {
  findings.push({ level, file, line, rule, problem, fix });
}
function lineOf(source, index) {
  return index === -1 ? 1 : source.slice(0, index).split("\n").length;
}

// --- JSX/HTML tag scanning (quote- and brace-aware, multi-line safe) ---------

function findTags(source, tag) {
  const tags = [];
  const open = `<${tag}`;
  let start = source.indexOf(open);
  while (start !== -1) {
    const after = source[start + open.length];
    if (after === undefined || /[\s/>]/.test(after)) {
      let i = start + open.length;
      let quote = null;
      let braceDepth = 0;
      while (i < source.length) {
        const ch = source[i];
        if (quote) {
          if (ch === quote) quote = null;
        } else if (ch === '"' || ch === "'") {
          quote = ch;
        } else if (ch === "{") {
          braceDepth += 1;
        } else if (ch === "}") {
          braceDepth = Math.max(0, braceDepth - 1);
        } else if (ch === ">" && braceDepth === 0) {
          break;
        }
        i += 1;
      }
      tags.push({ raw: source.slice(start, i + 1), index: start });
      start = source.indexOf(open, i + 1);
    } else {
      start = source.indexOf(open, start + 1);
    }
  }
  return tags;
}

function attrValue(rawTag, name) {
  const quoted = rawTag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|\\{([^}]*)\\})`));
  if (quoted) return quoted[2] ?? quoted[3] ?? quoted[4] ?? "";
  if (new RegExp(`\\s${name}\\s*[\\s/>]`).test(rawTag)) return ""; // bare attribute
  return null; // attribute absent
}

// --- ui/src checks -----------------------------------------------------------

function collectSrcFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...collectSrcFiles(full));
    else if ((entry.endsWith(".ts") || entry.endsWith(".tsx")) && !entry.includes(".test.")) {
      files.push(full);
    }
  }
  return files.sort();
}

function checkSrc() {
  const srcDir = join(uiDir, "src");
  if (!existsSync(srcDir)) {
    add("error", "ui/src", 1, "src/missing", "ui/src directory not found", "run against a ui workspace that contains src/");
    return;
  }
  for (const file of collectSrcFiles(srcDir)) {
    const displayPath = `ui/src/${relative(srcDir, file).split(sep).join("/")}`;
    const source = readFileSync(file, "utf8");
    for (const { raw, index } of findTags(source, "a")) {
      const target = attrValue(raw, "target");
      if (target === null || !target.includes("_blank")) continue;
      const rel = attrValue(raw, "rel");
      if (rel === null || !/\bnoopener\b/.test(rel)) {
        add("error", displayPath, lineOf(source, index), "security/ext-links",
          '<a target="_blank"> without a rel containing noopener',
          'add rel="noopener noreferrer" to this <a> tag');
      }
    }
    for (const { raw, index } of findTags(source, "img")) {
      if (attrValue(raw, "alt") === null) {
        add("error", displayPath, lineOf(source, index), "a11y/img-alt",
          "<img> without an alt attribute",
          'add a descriptive alt, or alt="" for decorative images');
      }
    }
  }
}

// --- HTML/Head checks (ui/index.html; w5-owned → warnings until --strict) ----

function checkHtmlHead() {
  const displayPath = "ui/index.html";
  const file = join(uiDir, "index.html");
  if (!existsSync(file)) {
    add("warning", displayPath, 1, "html/file", "ui/index.html not found", "restore the SPA entry document");
    return;
  }
  const html = readFileSync(file, "utf8");
  const want = (re, rule, problem, fix) => {
    if (!re.test(html)) add("warning", displayPath, 1, rule, problem, fix);
  };
  want(/^\s*<!doctype html>/i, "html/doctype", "missing <!DOCTYPE html>", 'start the file with "<!DOCTYPE html>"');
  want(/<html[^>]*?\slang\s*=/i, "html/lang", "<html> without a lang attribute", 'add lang="en" to the <html> tag');
  want(/<meta[^>]*charset\s*=\s*["']?\s*utf-8/i, "html/charset", 'missing <meta charset="UTF-8">', 'add <meta charset="UTF-8" /> inside <head>');
  want(/<meta[^>]*name=["']description["']/i, "html/description", 'missing <meta name="description">', "add a page description meta tag");
  want(/<meta[^>]*property=["']og:title["']/i, "html/og-title", "missing Open Graph og:title meta", 'add <meta property="og:title" ...>');
  want(/<meta[^>]*property=["']og:description["']/i, "html/og-description", "missing Open Graph og:description meta", 'add <meta property="og:description" ...>');
  want(/<link[^>]*rel=["'][^"']*icon[^"']*["']/i, "html/favicon", "missing favicon link (rel icon / apple-touch-icon)", "add favicon <link> tags pointing at ui/public icons");
  want(/<link[^>]*rel=["']manifest["'][^>]*href=["'][^"']*site\.webmanifest/i, "html/manifest", 'missing <link rel="manifest" href="...site.webmanifest">', "link the web app manifest from <head>");
  want(/<noscript[\s>]/i, "html/noscript", "missing <noscript> fallback", "add a <noscript> message for JS-disabled clients");
  want(/<title>[^<]*\S[^<]*<\/title>/i, "html/title", "missing or empty <title>", "add a non-empty <title> in <head>");

  const viewport = html.match(/<meta[^>]*name=["']viewport["'][^>]*>/i);
  if (!viewport) {
    add("warning", displayPath, 1, "html/viewport", "missing <meta name=\"viewport\">", "add a viewport meta with width=device-width, initial-scale=1");
  } else if (
    /\buser-scalable\s*=\s*(?:no|0)\b/i.test(viewport[0])
    || /\bmaximum-scale\s*=\s*1(?:\.0+)?(?![\d.])/i.test(viewport[0])
  ) {
    add("warning", displayPath, lineOf(html, viewport.index), "html/viewport-zoom",
      "viewport disables zooming (user-scalable=no or maximum-scale=1)",
      "allow zoom: drop user-scalable=no and maximum-scale from the viewport meta");
  }
  const inlineHandler = html.match(/\son(?:click|error)\s*=/i);
  if (inlineHandler) {
    add("warning", displayPath, lineOf(html, inlineHandler.index), "html/inline-handlers",
      "inline onclick=/onerror= handler found in index.html",
      "attach handlers from JS instead of inline attributes");
  }
}

// --- SEO/Static checks (ui/public/*; w5-owned → warnings until --strict) -----

function checkStatic() {
  const robotsDisplay = "ui/public/robots.txt";
  const robotsPath = join(uiDir, "public", "robots.txt");
  if (!existsSync(robotsPath)) {
    add("warning", robotsDisplay, 1, "seo/robots", "ui/public/robots.txt is missing", "add a robots.txt allowing crawlers to fetch /");
  } else if (!readFileSync(robotsPath, "utf8").trim()) {
    add("warning", robotsDisplay, 1, "seo/robots", "ui/public/robots.txt is empty", "add at least 'User-agent: *' plus 'Allow: /' rules");
  }
  const manifestDisplay = "ui/public/site.webmanifest";
  const manifestPath = join(uiDir, "public", "site.webmanifest");
  if (!existsSync(manifestPath)) {
    add("warning", manifestDisplay, 1, "seo/webmanifest", "ui/public/site.webmanifest is missing", "add a valid web app manifest and link it from index.html");
    return;
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    add("warning", manifestDisplay, 1, "seo/webmanifest", `site.webmanifest is not valid JSON (${err.message})`, "fix the JSON syntax");
    return;
  }
  if (typeof manifest.name !== "string" || manifest.name.length === 0) {
    add("warning", manifestDisplay, 1, "seo/webmanifest", 'site.webmanifest lacks a non-empty "name"', 'set "name" to the app title');
  }
  if (!Array.isArray(manifest.icons) || manifest.icons.length === 0) {
    add("warning", manifestDisplay, 1, "seo/webmanifest", 'site.webmanifest lacks a non-empty "icons" array', "add at least one {src, sizes, type} icon entry");
  }
}

// --- CSS checks (opt-in until the stage-37 CSS rules are integrated) -----------

function checkCss() {
  const displayPath = "ui/src/index.css";
  const file = join(uiDir, "src", "index.css");
  if (!existsSync(file)) {
    add("error", displayPath, 1, "css/file", "ui/src/index.css not found", "restore the UI stylesheet");
    return;
  }
  const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const [pattern, rule, required] of [
    [/@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/i, "css/reduced-motion", "@media (prefers-reduced-motion: reduce)"],
    [/@media\s+print\b/i, "css/print", "@media print"],
    [/:focus-visible\b/i, "css/focus-visible", ":focus-visible"],
  ]) {
    if (!pattern.test(css)) {
      add("error", displayPath, 1, rule, `missing ${required} rule`, `add a ${required} rule to the stylesheet`);
    }
  }
}

// --- Report ------------------------------------------------------------------

function report() {
  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const mode = [srcOnly ? "--src-only" : headOnly ? "--head-only" : "", strict ? "--strict" : "", withCss ? "--with-css" : ""].filter(Boolean).join(" ") || "default";
  console.log(`Front-End-Checklist audit (mode: ${mode}, ui root: ${uiDir})`);
  if (findings.length === 0) {
    console.log("All checks passed.");
    return 0;
  }
  for (const f of findings) {
    console.log(`\n[${f.level.toUpperCase()}] ${f.file}:${f.line} (${f.rule})`);
    console.log(`  problem: ${f.problem}`);
    console.log(`  fix:     ${f.fix}`);
  }
  const errors = findings.filter((f) => f.level === "error" || (strict && f.level === "warning")).length;
  console.log(`\nSummary: ${errors} error(s), ${findings.length - errors} warning(s)`);
  return errors > 0 ? 1 : 0;
}

try {
  if (!srcOnly) {
    checkHtmlHead();
    checkStatic();
  }
  if (!headOnly) checkSrc();
  if (withCss) checkCss();
  process.exit(report());
} catch (err) {
  console.error(`check-frontend-checklist failed: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
}

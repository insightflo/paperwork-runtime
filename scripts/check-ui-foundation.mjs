#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const TOKENS_CSS = "ui/src/styles/paperwork-tokens.css";
const TARGET_FILES = [
  "ui/src/styles/paperwork-tokens.css",
  "ui/src/components/ErrorReferenceChip.tsx",
  "ui/src/components/ProviderUsageRings.tsx",
  "ui/src/components/CompanyRailItem.tsx",
  "ui/src/components/CompanyRail.tsx",
  "ui/src/components/LayoutChrome.tsx",
  "ui/src/components/Layout.tsx",
  "ui/src/components/TraceWaterfall.tsx",
  "ui/src/components/agent-detail/RunSessionAndIssues.tsx",
  "ui/src/components/agent-detail/RunViews.tsx",
  "ui/src/components/LiveRunWidget.tsx",
  "ui/src/components/ToastViewport.tsx",
  "ui/src/components/BoundaryDragHandle.tsx",
  "ui/src/components/SidebarWaitChip.tsx",
  "ui/src/components/SidebarAgents.tsx",
  "ui/src/components/InspectorSidePanel.tsx",
  "ui/src/components/PropertiesPanel.tsx",
  "ui/src/components/QueuePanel.tsx",
  "ui/src/components/SubagentDockAndSteps.tsx",
  "ui/src/components/DashboardCommandHeader.tsx",
  "ui/src/components/ChannelCollaborationBoard.tsx",
  "ui/src/components/HermitGateAndOpsPanel.tsx",
  "ui/src/pages/Activity.tsx",
];

function collectDeclaredOpenbotTokens(cssPath) {
  const css = readFileSync(path.join(ROOT, cssPath), "utf8");
  const declared = new Set();
  for (const match of css.matchAll(/(--openbot-[a-z0-9-]+)\s*:/g)) {
    declared.add(match[1]);
  }
  return declared;
}

function main() {
  const failures = [];
  if (!existsSync(path.join(ROOT, TOKENS_CSS))) {
    failures.push(`Missing token file: ${TOKENS_CSS}`);
  }
  const declaredTokens = existsSync(path.join(ROOT, TOKENS_CSS))
    ? collectDeclaredOpenbotTokens(TOKENS_CSS)
    : new Set();

  for (const relPath of TARGET_FILES) {
    const absPath = path.join(ROOT, relPath);
    if (!existsSync(absPath)) {
      failures.push(`Missing UI file: ${relPath}`);
      continue;
    }
    const content = readFileSync(absPath, "utf8");
    const lineCount = content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
    if (lineCount >= 300) {
      failures.push(`${relPath}: exceeds <300 line limit (${lineCount} lines)`);
    }
    if (relPath.endsWith(".tsx")) {
      const hexMatches = content.match(/(?<![\w-])#[0-9a-fA-F]{3,8}\b/g);
      if (hexMatches && hexMatches.length > 0) {
        failures.push(`${relPath}: raw hex color literal(s) found (${hexMatches.join(", ")})`);
      }
      for (const refMatch of content.matchAll(/var\((--openbot-[a-z0-9-]+)\)/g)) {
        if (!declaredTokens.has(refMatch[1])) {
          failures.push(`${relPath}: undeclared token ${refMatch[1]}`);
        }
      }
    }
  }

  if (failures.length > 0) {
    console.error("UI foundation check FAILED:\n" + failures.map((f) => ` - ${f}`).join("\n"));
    process.exit(1);
  }
  console.log(`UI foundation OK (${TARGET_FILES.length} files verified, ${declaredTokens.size} tokens declared).`);
}

main();

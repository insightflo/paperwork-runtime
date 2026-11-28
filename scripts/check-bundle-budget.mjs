#!/usr/bin/env node
/**
 * check-bundle-budget.mjs
 *
 * [Front-End-Checklist Performance & Bundle Budget 자동 가드] ui/dist/assets
 * 산출물의 단일 청크 크기가 예산 이내인지 검증한다.
 * 근거: thedaviddias/Front-End-Checklist Performance 항목의 번들 크기 예산 관리.
 *
 * 예산 (strict less-than — 한도와 같으면 위반):
 *   - 단일 JS 청크: 512 kB 미만 (512 x 1024 = 524,288 bytes)
 *   - 단일 CSS 청크: 550 kB 미만 (550 x 1024 = 563,200 bytes; Tailwind+KaTeX+CodeMirror 현행 기준선 499.2 kB)
 *
 * 사용:
 *   node scripts/check-bundle-budget.mjs                # ui/dist 검사
 *   node scripts/check-bundle-budget.mjs --dist <dir>   # 검사 대상 dist 지정(테스트용)
 *
 * 종료 코드: 통과 exit 0, 예산 위반 또는 dist/assets 누락 exit 1.
 * package.json 등록("check:bundle-budget")은 Stage 38 PR #1099 소유라 하지 않는다.
 * 100% additive 유지: 수동/CI에서 위 명령을 직접 실행한다.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const JS_LIMIT_BYTES = 512 * 1024; // 524,288 bytes
const CSS_LIMIT_BYTES = 550 * 1024; // 563,200 bytes (baseline 499.2 kB + ~10% headroom)
const TOP_N = 5;

function parseDistDir(argv) {
  const defaultDir = path.resolve(import.meta.dirname, "../ui/dist");
  const flagIndex = argv.indexOf("--dist");
  if (flagIndex === -1) return defaultDir;
  const value = argv[flagIndex + 1];
  if (!value || value.startsWith("--")) {
    console.error("오류: --dist 플래그에는 디렉터리 경로가 필요합니다. 예: --dist ui/dist");
    process.exit(1);
  }
  return path.resolve(value);
}

/** kB 표기는 1024 bytes 기준이다. */
function formatBytes(bytes) {
  return `${(bytes / 1024).toFixed(1)} kB`;
}

function collectAssets(assetsDir) {
  return readdirSync(assetsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const filePath = path.join(assetsDir, entry.name);
      return { name: entry.name, bytes: statSync(filePath).size };
    })
    .filter((asset) => asset.name.endsWith(".js") || asset.name.endsWith(".css"))
    .sort((a, b) => b.bytes - a.bytes);
}

function main() {
  const distDir = parseDistDir(process.argv.slice(2));
  const assetsDir = path.join(distDir, "assets");

  if (!existsSync(distDir)) {
    console.error(`오류: dist 디렉터리가 없습니다: ${distDir}`);
    console.error("먼저 UI를 빌드하세요: pnpm --filter @paperclipai/ui build");
    process.exit(1);
  }
  if (!existsSync(assetsDir)) {
    console.error(`오류: assets 디렉터리가 없습니다: ${assetsDir}`);
    console.error("빌드 산출물이 비정상입니다. pnpm --filter @paperclipai/ui build 를 다시 실행하세요.");
    process.exit(1);
  }

  const assets = collectAssets(assetsDir);
  if (assets.length === 0) {
    console.error(`오류: ${assetsDir} 에 .js/.css assets 이 없습니다. 빌드 산출물을 확인하세요.`);
    process.exit(1);
  }

  const limitOf = (name) => (name.endsWith(".js") ? JS_LIMIT_BYTES : CSS_LIMIT_BYTES);
  const violations = assets.filter((asset) => asset.bytes >= limitOf(asset.name));

  console.log(`Bundle budget 검사: ${assetsDir} (${assets.length}개 에셋)`);
  console.log(
    `예산: 단일 JS 청크 < ${formatBytes(JS_LIMIT_BYTES)}, 단일 CSS 청크 < ${formatBytes(CSS_LIMIT_BYTES)}`,
  );

  console.log(`\n가장 큰 에셋 상위 ${Math.min(TOP_N, assets.length)}개:`);
  for (const asset of assets.slice(0, TOP_N)) {
    console.log(`  ${formatBytes(asset.bytes).padStart(10)}  ${asset.name}`);
  }

  if (violations.length > 0) {
    console.error("\nFAIL: 번들 예산 위반이 있습니다.");
    for (const violation of violations) {
      const limit = limitOf(violation.name);
      const over = violation.bytes - limit;
      console.error(
        `  ${violation.name}: ${formatBytes(violation.bytes)} — 한도 ${formatBytes(limit)} 초과(+${formatBytes(over)})`,
      );
    }
    console.error("\n조치 방법:");
    console.error("  1) 무거운 의존성을 동적 import(비동기 청크)로 옮기세요.");
    console.error("  2) ui/vite.config.ts 의 vendorManualChunks 로 vendor 청크를 분리하세요.");
    console.error("  3) 예산 상향이 정당하면 이 스크립트의 상수와 근거 주석을 함께 상향하세요.");
    process.exit(1);
  }

  const minMargin = Math.min(...assets.map((asset) => limitOf(asset.name) - asset.bytes));
  console.log(`\nPASS: 모든 청크가 예산 이내입니다. (최소 여유 ${formatBytes(minMargin)})`);
  process.exit(0);
}

main();

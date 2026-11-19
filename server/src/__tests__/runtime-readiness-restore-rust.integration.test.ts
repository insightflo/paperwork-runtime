// @vitest-environment node
// Runtime-readiness restore parity through the Rust `paperclip-db-backup`
// helper: snapshot() and runDatabaseRestore both delegate while
// PAPERCLIP_DB_BACKUP_BIN points at the freshly built release binary.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, issueWorkProducts, issues, missions, runDatabaseRestore, workflowRuns } from "@paperclipai/db";
import { missionService } from "../services/missions.js";
import { startRuntimeReadinessRestoreFixture } from "./helpers/runtime-readiness-restore-fixture.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

describe("runtime readiness rust backup restore", () => {
  let fixture: Awaited<ReturnType<typeof startRuntimeReadinessRestoreFixture>>;
  let savedBin: string | undefined;

  beforeAll(async () => {
    const build = spawnSync("cargo", ["build", "--release", "--manifest-path", join(repoRoot, "crates", "db-backup", "Cargo.toml")], { encoding: "utf8" });
    if (build.status !== 0) throw new Error(`cargo build failed: ${build.stderr}`);
    const bin = [join(repoRoot, "crates", "db-backup", "target", "release", "paperclip-db-backup"), join(repoRoot, "target", "release", "paperclip-db-backup")].find(existsSync);
    if (!bin) throw new Error("paperclip-db-backup release binary missing after cargo build");
    savedBin = process.env.PAPERCLIP_DB_BACKUP_BIN;
    process.env.PAPERCLIP_DB_BACKUP_BIN = bin;
    fixture = await startRuntimeReadinessRestoreFixture();
  }, 240_000);

  afterAll(async () => {
    if (savedBin === undefined) delete process.env.PAPERCLIP_DB_BACKUP_BIN;
    else process.env.PAPERCLIP_DB_BACKUP_BIN = savedBin;
    await fixture?.cleanup();
  });

  it("restores mission rows and exact artifact bytes via rust, then finishes through the canonical consumer", async () => {
    const seeded = await fixture.seedMission();
    const backup = await fixture.snapshot();
    const targetUrl = await fixture.createEmptyDatabase("rust-complete");

    await fixture.restoreFilesToOriginalMount();
    await runDatabaseRestore({ connectionString: targetUrl, backupFile: backup.backupFile });
    const restored = createDb(targetUrl);
    try {
      const [mission] = await restored.select().from(missions).where(eq(missions.id, seeded.missionId));
      const [issue] = await restored.select().from(issues).where(eq(issues.id, seeded.issueId));
      const [run] = await restored.select().from(workflowRuns).where(eq(workflowRuns.missionId, seeded.missionId));
      const [product] = await restored.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, seeded.productId));
      expect(mission).toMatchObject({ companyId: seeded.companyId, status: "active" });
      expect(issue).toMatchObject({ missionId: seeded.missionId, status: "done" });
      expect(run).toMatchObject({ missionId: seeded.missionId, status: "completed" });
      expect(product).toMatchObject({ issueId: seeded.issueId, createdByRunId: seeded.heartbeatRunId,
        metadata: { path: seeded.artifactPath, sha256: seeded.sha256 } });

      const restoredBytes = await fixture.readArtifact(seeded.artifactPath);
      expect(restoredBytes).toEqual(seeded.bytes);
      expect(createHash("sha256").update(restoredBytes).digest("hex")).toBe(seeded.sha256);

      const result = await missionService(restored).runActiveMissionOwnerSupervision({
        companyId: seeded.companyId, missionIds: [seeded.missionId], applySafeActions: true,
      });
      expect(result.missionIds).toEqual([seeded.missionId]);
      expect((await restored.select().from(missions).where(eq(missions.id, seeded.missionId)))[0])
        .toMatchObject({ status: "completed", completedAt: expect.any(Date) });
      expect((await restored.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, seeded.productId)))[0])
        .toEqual(product);
    } finally {
      await restored.$client.end({ timeout: 5 });
    }
  }, 120_000);
});

import { execFileSync, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  buildClarificationRequest,
  extractUnitRoles,
  reviewPlanAgainstIntent,
} from "../services/missions/mission-plan-qa.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const rustBin = path.join(repoRoot, "crates/mission-core/target/release/paperclip-mission-core");

beforeAll(() => {
  const which = String(spawnSync("which", ["cargo"], { encoding: "utf8" }).stdout ?? "").trim();
  const cargoBin = process.env.CARGO || which || path.join(homedir(), ".cargo/bin/cargo");
  execFileSync(cargoBin,
    ["build", "--release", "--manifest-path", path.join(repoRoot, "crates/mission-core/Cargo.toml")],
    { stdio: "inherit" });
}, 240_000);

type Outcome = { threw: false; value: unknown } | { threw: true; error: string };
function ts(fn: () => unknown): Outcome {
  try {
    const v = fn();
    // JSON round-trip models what the Rust binary can emit (deep undefined→null,
    // dropped undefined object keys) so toEqual compares like-for-like.
    return { threw: false, value: v === undefined ? null : JSON.parse(JSON.stringify(v)) };
  } catch (err) {
    return { threw: true, error: err instanceof Error ? err.message : String(err) };
  }
}
function rust(subcommand: string, payload: unknown): Outcome {
  const res = spawnSync(rustBin, [subcommand], {
    input: JSON.stringify(payload), encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
  });
  if (res.error || res.status !== 0) {
    return { threw: true, error: String(res.error ?? res.stderr).trim() };
  }
  return { threw: false, value: JSON.parse(String(res.stdout)) };
}
function expectParity(t: Outcome, r: Outcome, exactError = false): void {
  if (r.threw !== t.threw) {
    throw new Error(`throw parity mismatch: ts=${JSON.stringify(t)} rust=${JSON.stringify(r)}`);
  }
  if (!t.threw) {
    expect(r.value).toEqual(t.value);
  } else if (exactError) {
    expect(r.error).toBe(t.error);
  }
}

const callTs = {
  "review-plan-against-intent": (p: never) => reviewPlanAgainstIntent(p),
  "build-clarification-request": (p: never) => buildClarificationRequest(p),
  "extract-unit-roles": (p: { unit?: unknown; tools?: unknown }) =>
    extractUnitRoles(p.unit as Record<string, unknown>, p.tools as never),
} as const;
type Sub = keyof typeof callTs;
const parity = (sub: Sub, payload: unknown, exact = false) =>
  expectParity(ts(() => callTs[sub](payload as never)), rust(sub, payload), exact);

const PUB_CONTRACT = { role: "publication", resultFileName: "out.json", resultSchemaVersion: "1",
  resultAdapter: "generic", inputParams: {}, deploymentFiles: ["a.txt"], inputEnvelopeVersion: "1",
  publication: { identity: { param: "slug" },
    publishedAt: { resultPointer: "/publishedAt", dateParam: "d" },
    bindings: [{ resultPointer: "/date", parameter: "d" }] } };
const VERIFY_CONTRACT = { role: "publication-verify", resultFileName: "v.json",
  resultSchemaVersion: "1", resultAdapter: "generic", inputParams: {},
  consumerParams: { receipt: "receipt" }, deploymentFiles: ["v.txt"], inputEnvelopeVersion: "1" };
const QA_CONTRACT = { ...VERIFY_CONTRACT, role: "qa" };
const PUB = { name: "deploy", enabled: true, adapterConfig: { artifactContract: PUB_CONTRACT } };
const VER = { name: "verify", enabled: true, adapterConfig: { artifactContract: VERIFY_CONTRACT } };
const QAT = { name: "qatool", enabled: true, adapterConfig: { artifactContract: QA_CONTRACT } };

const intent = (o: Record<string, unknown> = {}) => ({ publish: false, audienceSplit: false,
  scenario: false, audiences: [], beneficiary: [], matchedSignals: [], ...o });
const PUB_INTENT = intent({ publish: true, matchedSignals: [{ category: "publish", token: "publication" }] });
const pubU = { id: "pub", toolName: "deploy" };
const verU = (receipt = "{$steps.pub.workProductPath}") => ({ id: "ver", toolName: "verify",
  toolArgs: { receipt }, dependsOn: ["pub"] });
const qaU = { id: "qa", type: "qa", dependsOn: ["pub"] };
const prodU = { id: "prod", type: "action", graphWorkProductRequired: true };
const tools = [PUB, VER];

const E = "extract-unit-roles";
const cases: Array<{ sub: Sub; name: string; payload: unknown; exact?: boolean }> = [
  { sub: E, name: "publication contract grants publish", payload: { unit: { toolName: "deploy" }, tools } },
  { sub: E, name: "publication-verify contract grants readbackQa", payload: { unit: { toolName: "verify" }, tools } },
  { sub: E, name: "qa-role contract grants neither publish nor readbackQa", payload: { unit: { toolName: "qatool" }, tools: [QAT] } },
  { sub: E, name: "type qa grants readbackQa without tools", payload: { unit: { type: "qa" } } },
  { sub: E, name: "type QA lowercases to qa", payload: { unit: { type: " QA " } } },
  { sub: E, name: "type validation/validator grant readbackQa", payload: { unit: { type: "validator" } } },
  { sub: E, name: "qaType builtin contract grants readbackQa", payload: { unit: { qaType: "delivery" } } },
  { sub: E, name: "qaType custom contract grants readbackQa", payload: { unit: { qaType: "my_check-1" } } },
  { sub: E, name: "invalid qaType falls back to type", payload: { unit: { qaType: "1bad", type: "action" } } },
  { sub: E, name: "approval/oversight types grant nothing", payload: { unit: { type: "approval" } } },
  { sub: E, name: "audiences>1 splits; single/empty/string do not", payload: { unit: { audiences: ["a", "b"] } } },
  { sub: E, name: "audiences string is not a split", payload: { unit: { audiences: "ab" } } },
  { sub: E, name: "scenarios non-empty array grants scenario", payload: { unit: { scenarios: ["s"] } } },
  { sub: E, name: "scenarios empty/string do not", payload: { unit: { scenarios: [] } } },
  { sub: E, name: "enabled:false tool grants no role", payload: { unit: { toolName: "deploy" }, tools: [{ ...PUB, enabled: false }] } },
  { sub: E, name: "tool name mismatch grants no role", payload: { unit: { toolName: "other" }, tools } },
  { sub: E, name: "toolName+toolNames+tools arrays merge deduped", payload: { unit: { toolName: "deploy", toolNames: ["verify"], tools: ["deploy"] }, tools } },
  { sub: E, name: "blank toolName filtered before match", payload: { unit: { toolName: "  " }, tools } },
  { sub: E, name: "invalid contract role grants nothing", payload: { unit: { toolName: "deploy" }, tools: [{ ...PUB, adapterConfig: { artifactContract: { ...PUB_CONTRACT, role: "bogus" } } }] } },
  { sub: E, name: "unknown contract key rejected by strict schema", payload: { unit: { toolName: "deploy" }, tools: [{ ...PUB, adapterConfig: { artifactContract: { ...PUB_CONTRACT, extra: 1 } } }] } },
  { sub: E, name: "non-object unit reads null", payload: { unit: "x", tools: [] } },
  { sub: E, name: "absent tools defaults to []", payload: { unit: { toolName: "deploy" } } },
  { sub: E, name: "matched tool missing adapterConfig throws V8 text", payload: { unit: { toolName: "deploy" }, tools: [{ name: "deploy", enabled: true }] }, exact: true },
  { sub: E, name: "matched tool null adapterConfig throws V8 text", payload: { unit: { toolName: "deploy" }, tools: [{ name: "deploy", adapterConfig: null }] }, exact: true },
  { sub: E, name: "tools null throws V8 text", payload: { unit: {}, tools: null }, exact: true },
  { sub: E, name: "tools non-array throws V8 text", payload: { unit: {}, tools: {} }, exact: true },
  { sub: E, name: "null unit throws V8 text", payload: { unit: null, tools: [] }, exact: true },
  { sub: E, name: "missing unit throws V8 text", payload: { tools: [] }, exact: true },
  { sub: E, name: "null payload throws V8 unit text", payload: null, exact: true },
];

const R = "review-plan-against-intent";
const happy = { intent: PUB_INTENT, tools,
  selectedExecutionUnits: [prodU, { ...qaU, dependsOn: ["prod"] },
    { ...pubU, dependsOn: ["qa"] }, { ...verU(), dependsOn: ["pub"], id: "ver" }] };
const reviewCases: Array<{ sub: Sub; name: string; payload: unknown; exact?: boolean }> = [
  { sub: R, name: "empty units and no intent yields no diagnostics", payload: { intent: intent(), selectedExecutionUnits: [] } },
  { sub: R, name: "full happy path producer→qa→publish→verify", payload: happy },
  { sub: R, name: "publish intent no units flags missing_publish_unit", payload: { intent: PUB_INTENT, selectedExecutionUnits: [] } },
  { sub: R, name: "publish intent empty signals uses contract-needed wording", payload: { intent: intent({ publish: true }), selectedExecutionUnits: [] } },
  { sub: R, name: "publish unit without verify consumer flags topology+readback", payload: { intent: PUB_INTENT, tools, selectedExecutionUnits: [pubU] } },
  { sub: R, name: "verify receipt binding mismatch flags topology", payload: { intent: PUB_INTENT, tools, selectedExecutionUnits: [pubU, verU("{$steps.other.workProductPath}")] } },
  { sub: R, name: "verify consumer without dependsOn flags topology", payload: { intent: PUB_INTENT, tools, selectedExecutionUnits: [pubU, { ...verU(), dependsOn: [] }] } },
  { sub: R, name: "verify receipt on different arg key flags topology", payload: { intent: PUB_INTENT, tools, selectedExecutionUnits: [pubU, { ...verU(), toolArgs: { other: "{$steps.pub.workProductPath}" } }] } },
  { sub: R, name: "producer depends on qa flags reversed delivery order", payload: { intent: PUB_INTENT, tools,
    selectedExecutionUnits: [{ ...prodU, dependsOn: ["qa"] }, { id: "qa", type: "qa" }, { ...pubU, dependsOn: ["qa"] }, { ...verU(), dependsOn: ["pub"] }] } },
  { sub: R, name: "delivery before artifact qa flags missing qa", payload: { intent: PUB_INTENT, tools,
    selectedExecutionUnits: [prodU, { ...pubU, dependsOn: ["prod"] }, verU()] } },
  { sub: R, name: "delivery without producer skips order check", payload: { intent: PUB_INTENT, tools, selectedExecutionUnits: [pubU, verU()] } },
  { sub: R, name: "audienceSplit without split unit flags clarification", payload: { intent: intent({ audienceSplit: true, audiences: ["kids", "adults"] }), selectedExecutionUnits: [] } },
  { sub: R, name: "audienceSplit satisfied by unit audiences", payload: { intent: intent({ audienceSplit: true, audiences: ["a", "b"] }), selectedExecutionUnits: [{ id: "u", audiences: ["a", "b"] }] } },
  { sub: R, name: "audienceSplit with empty audiences uses fallback noun", payload: { intent: intent({ audienceSplit: true, audiences: [] }), selectedExecutionUnits: [] } },
  { sub: R, name: "scenario without taxonomy unit flags clarification", payload: { intent: intent({ scenario: true }), selectedExecutionUnits: [] } },
  { sub: R, name: "scenario satisfied by unit scenarios", payload: { intent: intent({ scenario: true }), selectedExecutionUnits: [{ id: "u", scenarios: ["x"] }] } },
  { sub: R, name: "all intents missing emit in fixed order", payload: { intent: intent({ publish: true, audienceSplit: true, scenario: true, audiences: ["a", "b"], matchedSignals: [{ category: "scenario", token: "s1" }] }), selectedExecutionUnits: [] } },
  { sub: R, name: "workproduct opt-out on publication unit flags marker+topology", payload: { intent: intent(), tools, selectedExecutionUnits: [{ ...pubU, graphWorkProductRequired: false }] } },
  { sub: R, name: "null intent throws V8 publish text", payload: { intent: null, selectedExecutionUnits: [] }, exact: true },
  { sub: R, name: "missing intent throws V8 publish text", payload: { selectedExecutionUnits: [] }, exact: true },
  { sub: R, name: "null payload throws destructure text", payload: null, exact: true },
  { sub: R, name: "missing units throws V8 flatMap text", payload: { intent: intent() }, exact: true },
  { sub: R, name: "null units throws V8 flatMap text", payload: { intent: intent(), selectedExecutionUnits: null }, exact: true },
  { sub: R, name: "string units throws flatMap not-function text", payload: { intent: intent(), selectedExecutionUnits: "x" }, exact: true },
  { sub: R, name: "null unit element throws V8 toolName text", payload: { intent: intent(), selectedExecutionUnits: [null] }, exact: true },
  { sub: R, name: "non-array tools throws flatMap text on first unit", payload: { intent: intent(), selectedExecutionUnits: [{}], tools: {} }, exact: true },
  { sub: R, name: "object matchedSignals throws filter text", payload: { intent: intent({ publish: true, matchedSignals: {} }), selectedExecutionUnits: [] }, exact: true },
  { sub: R, name: "null matchedSignals throws filter text", payload: { intent: intent({ publish: true, matchedSignals: null }), selectedExecutionUnits: [] }, exact: true },
  { sub: R, name: "string audiences throws join text", payload: { intent: intent({ audienceSplit: true, audiences: "a,b" }), selectedExecutionUnits: [] }, exact: true },
  { sub: R, name: "object audiences length>0 throws join text", payload: { intent: intent({ audienceSplit: true, audiences: { length: 2 } }), selectedExecutionUnits: [] }, exact: true },
  { sub: R, name: "object audiences length 0 uses fallback noun", payload: { intent: intent({ audienceSplit: true, audiences: { length: 0 } }), selectedExecutionUnits: [] } },
  { sub: R, name: "mixed undefined+null signal tokens both join", payload: { intent: intent({ publish: true, matchedSignals: [{ category: "publish" }, { category: "publish", token: null }] }), selectedExecutionUnits: [] } },
  { sub: R, name: "dependency cycle throws normalizer error", payload: { intent: intent(), selectedExecutionUnits: [{ id: "a", dependsOn: ["b"] }, { id: "b", dependsOn: ["a"] }] } },
];

const B = "build-clarification-request";
const buildCases: Array<{ sub: Sub; name: string; payload: unknown; exact?: boolean }> = [
  { sub: B, name: "empty diagnostics yields no questions", payload: { diagnostics: [], intent: intent() } },
  { sub: B, name: "invalid severity diagnostics are skipped", payload: { diagnostics: [{ code: "missing_publish_unit", severity: "invalid" }], intent: intent() } },
  { sub: B, name: "audience code maps audiences context and join", payload: { diagnostics: [{ code: "missing_audience_split", severity: "needs_clarification" }], intent: intent({ audiences: ["a", "b"] }) } },
  { sub: B, name: "scenario code maps signal tokens", payload: { diagnostics: [{ code: "missing_scenario_taxonomy", severity: "needs_clarification" }], intent: intent({ matchedSignals: [{ category: "scenario", token: "s1" }, { category: "publish", token: "p" }, { category: "scenario", token: "s1" }] }) } },
  { sub: B, name: "publish codes map publish tokens", payload: { diagnostics: [{ code: "missing_publish_unit", severity: "needs_clarification" }, { code: "missing_publish_readback_qa", severity: "needs_clarification" }], intent: intent({ matchedSignals: [{ category: "publish", token: "pub" }] }) } },
  { sub: B, name: "unknown code gets empty context and default question", payload: { diagnostics: [{ code: "bogus", severity: "needs_clarification" }], intent: intent() } },
  { sub: B, name: "missing code drops key, default question", payload: { diagnostics: [{ severity: "needs_clarification" }], intent: intent() } },
  { sub: B, name: "non-string code emits raw code, default question", payload: { diagnostics: [{ code: 5, severity: "needs_clarification" }], intent: intent() } },
  { sub: B, name: "diagnostic order preserved across mixed codes", payload: { diagnostics: [{ code: "missing_scenario_taxonomy", severity: "needs_clarification" }, { code: "bogus", severity: "needs_clarification" }, { code: "missing_audience_split", severity: "needs_clarification" }], intent: intent({ audiences: ["x"], matchedSignals: [] }) } },
  { sub: B, name: "extra diagnostic fields not carried to question", payload: { diagnostics: [{ code: "missing_publish_unit", severity: "needs_clarification", message: "m", extra: 1 }], intent: intent({ matchedSignals: [] }) } },
  { sub: B, name: "number diagnostics throws iterable text", payload: { diagnostics: 5, intent: intent() }, exact: true },
  { sub: B, name: "null diagnostics throws iterable text", payload: { diagnostics: null, intent: intent() }, exact: true },
  { sub: B, name: "missing diagnostics throws iterable text", payload: { intent: intent() }, exact: true },
  { sub: B, name: "string diagnostics iterates chars then skips all", payload: { diagnostics: "ab", intent: intent() } },
  { sub: B, name: "null diagnostic element throws severity text", payload: { diagnostics: [null], intent: intent() }, exact: true },
  { sub: B, name: "null payload throws destructure text", payload: null, exact: true },
  { sub: B, name: "audience code missing intent throws audiences text", payload: { diagnostics: [{ code: "missing_audience_split", severity: "needs_clarification" }] }, exact: true },
  { sub: B, name: "audience code missing audiences throws join text", payload: { diagnostics: [{ code: "missing_audience_split", severity: "needs_clarification" }], intent: {} }, exact: true },
  { sub: B, name: "audience code string audiences throws join text", payload: { diagnostics: [{ code: "missing_audience_split", severity: "needs_clarification" }], intent: intent({ audiences: "x,y" }) }, exact: true },
  { sub: B, name: "scenario code missing matchedSignals throws filter text", payload: { diagnostics: [{ code: "missing_scenario_taxonomy", severity: "needs_clarification" }], intent: intent({ matchedSignals: undefined }) }, exact: true },
];

describe("mission-plan-qa: TS vs paperclip-mission-core", () => {
  for (const c of [...cases, ...reviewCases, ...buildCases]) {
    it(`parity ${c.sub}: ${c.name}`, () => parity(c.sub, c.payload, c.exact));
  }
});

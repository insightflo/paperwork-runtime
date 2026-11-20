//! Verbatim constants and static line builders ported from
//! server/src/services/missions/mission-quality-contract.ts.
//! No dynamic reads: every returned string is a literal rendering.

pub const EVIDENCE_CHAIN_FORMAT: &str =
    "source content -> observation -> interpretation -> conclusion";
pub const EVIDENCE_CHAIN_DELIVERABLE_PLANNING_LINE: &str = "For written/report/manual/analysis deliverables, plan and write evidence as source content -> observation -> interpretation -> conclusion; treat storage paths, evidence repositories, and workProducts as traceability, not the proof itself.";
pub const MISSION_QUALITY_PURPOSE_FITNESS_SENTENCE: &str = "This QA is purpose-fitness first. Do not pass a deliverable merely because it is well-structured, published, or source-backed if it does not solve the original mission goal.";
pub const EVIDENCE_EXPLANATION_QUALITY_MARKER: &str = "## Evidence explanation quality";
pub const VERIFICATION_BEFORE_COMPLETION_MARKER: &str = "## Verification Before Completion";
pub const STRUCTURAL_GATE_ALREADY_RUN_MARKER: &str = "## Structural validation already performed";
pub const EVALUATION_AXES: [&str; 5] = [
    "intentFidelity",
    "outcomeUsefulness",
    "executionFeasibility",
    "verificationStrength",
    "integrationCompleteness",
];
pub const CLARIFY_NOTE: &str = "Quality requirements are underspecified in the mission goal. The owner should clarify the target audience, depth, and what 'done well' means before this contract can fully judge purpose-fitness.";

pub fn adaptive_quality_profile_lines() -> Vec<String> {
    vec![
        "## Adaptive quality profile".into(),
        "".into(),
        "Infer the mission's work type, user context, risk, and final use from the original request. Select only the relevant quality dimensions:".into(),
        "- Research / opportunity discovery: source authority, freshness, coverage, eligibility, deduplication, and selection rationale.".into(),
        "- Proposal / business plan: requirement compliance, evaluator alignment, evidence, numerical consistency, feasibility, and submission readiness.".into(),
        "- Software delivery: requirement behavior, tests, security, deployment, regression risk, and observed runtime behavior.".into(),
        "- Operations / maintenance: reproducibility, root cause, recovery, control evidence, and service continuity.".into(),
        "- Manual / beginner-facing guidance: audience comprehension, procedural reproducibility, examples only where useful, and result accuracy.".into(),
        "- General business output: decision usefulness, factual accuracy, completeness, and fitness for the receiving work system.".into(),
        "- Add or combine dimensions when the mission does not fit these examples.".into(),
        "- Do not apply a profile merely because its terms appear in this guidance. Derive it from the mission itself.".into(),
        "".into(),
    ]
}

pub fn mission_quality_review_lines() -> Vec<String> {
    vec![
        "## Outcome review standard".into(),
        "- Use only the dimensions relevant to this action, its mission-specific quality profile, and its declared acceptance criteria.".into(),
        "- Judge observable fitness for use, factual or behavioral correctness, evidence strength, integration with downstream work, and material risk.".into(),
        "- REQUEST_CHANGES only for an observed blocking defect that prevents safe or useful use, downstream consumption, or verification.".into(),
        "- Keep optional improvements separate from the verdict so they do not create a rework loop.".into(),
        "".into(),
    ]
}

pub fn evidence_writing_lines() -> Vec<String> {
    vec![
        EVIDENCE_EXPLANATION_QUALITY_MARKER.into(),
        "".into(),
        "Write evidence chains, not source-container pointers.".into(),
        format!("- For each important conclusion, write: {EVIDENCE_CHAIN_FORMAT}."),
        "- Source content is the reader-visible material behind the claim: provider, dataset/source material, URL when available, metric/event/text excerpt, timestamp/freshness, and limitation.".into(),
        "- If a table is useful, make its columns match that chain: source content, observation, interpretation, conclusion, confidence/gap.".into(),
        "- Keep storage details such as `source_name`, `path_or_url`, internal filenames, manifests, and workProduct paths as private traceability, not public evidence.".into(),
        "- If the evidence is weak, indirect, or only partially relevant, state that limitation instead of strengthening the conclusion.".into(),
        "".into(),
    ]
}

pub fn evidence_qa_lines() -> Vec<String> {
    vec![
        EVIDENCE_EXPLANATION_QUALITY_MARKER.into(),
        "".into(),
        "Verify evidence chains before PASS.".into(),
        format!("- Each important conclusion should show: {EVIDENCE_CHAIN_FORMAT}."),
        "- PASS when public prose, references, and evidence tables name the reader-visible material and connect it to the report's observation, interpretation, and conclusion.".into(),
        "- REQUEST_CHANGES when the artifact mostly lists source containers, storage fields, internal filenames, manifests, or workProduct paths instead of that chain.".into(),
        "".into(),
    ]
}

pub fn verification_gate_lines(intermediate_qa: bool) -> Vec<String> {
    let claim = if intermediate_qa {
        "- Identify only the claims this step must judge: its direct dependency workProducts and this step's own acceptance criteria. Do not require proof of outputs owned by a future publish or verification step, even if the mission goal mentions final publication."
    } else {
        "- Identify every completion claim from the mission goal, success criteria, dependency workProducts, delivery manifests, and final user-visible or machine-consumed output contract."
    };
    let mut lines = vec![
        VERIFICATION_BEFORE_COMPLETION_MARKER.into(),
        "".into(),
        "No PASS is allowed without fresh evidence gathered in this QA run.".into(),
        claim.into(),
        "- For each claim, name the proof surface and probe: browser/API/CLI/database/file/hash/content check, as appropriate to the declared output path.".into(),
        "- Run the probe now. Do not rely on upstream agent reports, issue status, registered workProducts, or earlier QA comments as completion proof.".into(),
        "- Read the full result: exit code, HTTP status, response body/HTML marker, database row, file metadata, object key, hash, or other objective output.".into(),
        "- Verify the evidence supports the exact claim. Mark partial, stale, ambiguous, missing, or adjacent-surface evidence as notVerified.".into(),
        "- If the proof surface is missing or ambiguous, REQUEST_CHANGES and state which claim cannot be verified. Do not infer a provider or substitute a nearby surface.".into(),
        "- PASS only when every required claim has fresh supporting evidence. Otherwise REQUEST_CHANGES with the exact missing or failed claim.".into(),
        "".into(),
    ];
    lines.extend(evidence_qa_lines());
    lines.extend([
        "Verdict evidence shape:".into(),
        "- verified: concrete claims with evidence and source/probe used.".into(),
        "- notVerified: required claims that failed, were stale, or had only adjacent evidence.".into(),
        "- unresolved: claims that could not be checked because the destination contract or access path is missing.".into(),
        "- finalVerdict: PASS or REQUEST_CHANGES.".into(),
        "".into(),
    ]);
    lines
}

pub fn structural_gate_lines() -> Vec<String> {
    vec![
        STRUCTURAL_GATE_ALREADY_RUN_MARKER.into(),
        "".into(),
        "Upstream structural (deterministic) tool gates have already validated the specific machine contracts they were declared to cover (e.g. IDs, schema keys, URL patterns, selectors, roles, status, hashes).".into(),
        "- Only the exact machine-contract checks explicitly delegated to a structural gate are authoritative. Do not repeat those specific checks.".into(),
        "- You MUST still verify any completion claim or machine contract that was NOT explicitly delegated to a structural gate — for example probes, delivery readback, or output-contract checks the gate does not cover.".into(),
        "- Focus your semantic evaluation on coherence, tone and manner, factual accuracy, argument consistency, audience fitness, and purpose-fitness for the mission goal.".into(),
        "- Do not invent generic wording rules, prose style rules, or generic HTML structure rules. Those are not machine contracts.".into(),
        "- You MAY verify an exact literal string when the user request or a real interface contract explicitly requires that exact value (e.g. a required label, a compliance field, a configured brand name). In that case the literal is a machine contract, not a style preference.".into(),
        "- If a structural gate failed, it was already reported to the producer for rework. Semantic QA runs only when the gate passes.".into(),
        "".into(),
    ]
}

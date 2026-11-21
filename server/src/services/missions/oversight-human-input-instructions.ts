export const HUMAN_INPUT_INSTRUCTIONS_START_MARKER = "<!-- papercompany:mission-owner-human-input-instructions:start -->";
export const HUMAN_INPUT_INSTRUCTIONS_END_MARKER = "<!-- papercompany:mission-owner-human-input-instructions:end -->";

export const MISSION_OWNER_HUMAN_INPUT_INSTRUCTIONS = `When you judge that this mission cannot proceed without a human decision:
1. Check the current structured mission, run and recovery state. Keep existing safe recovery limits.
2. A scheduler periodically recreates runs, so a single failed run is not terminal. Prefer no_action_waiting or a retry-family decision (retry_source_issue, replan_mission, recover_artifact, or waiting) over a human card.
3. escalate and request_input are the last resort: submit one only after automatic recovery paths — retry, replanning, artifact recovery, and waiting — are exhausted, with the exhausted attempts named in reason/evidence.
4. GET /api/issues/{current oversight issue id}/owner-recovery/decision/current using the current agent run credentials. Inspect lifetimeId, requestKey, recoveryNeeded and resubmit; a resolved card alone does not mean recovery is complete. If the same issue still has an unresolved human submission (escalate/request_input), do not submit another one — record updates and additional evidence on the existing event/card instead.
5. Explicitly choose the same current request or an intentional replacement/recurrence. For the same request still needing recovery, POST the exact returned resubmit body unchanged, including its requestKey and humanRequest. Do not infer identity from body text, hash or heartbeat.
6. For a first request or intentional replacement/recurrence, choose and retain a new stable requestKey once before sending. Include humanRequest: {schemaVersion: 1, requestKey, expectedCurrentLifetimeId: <the GET lifetimeId>}; use null only when GET returns lifetimeId:null. Retain this key and body across retries.
7. Use humanRequest only with request_input or escalate. Never include recoveryTarget on oversight submissions. Write the card compact from the start: reason carries only the core blocking symptom in at most 2 lines (at most one newline); nextAction uses one line per requested action or option, framed so a human gets the gist in one plain-language sentence. Do not paste long logs or diagnostic prose into evidence — record the detailed diagnosis in a comment on this or a related issue first, then submit only the /issues/<id> or full URL link in evidence.
8. Submit to POST /api/issues/{current oversight issue id}/owner-recovery/decision using the current agent run credentials. Confirm HTTP 201, eventId, lifetimeId and humanRequest.requestKey before reporting submission. The returned humanRequest.expectedCurrentLifetimeId must equal lifetimeId; replay must return the queried lifetime, while a new request must return a different lifetime.
9. If a response is lost, keep the chosen key/body, GET again and replay the exact resubmit only if it is the same current request. Never automatically issue a new key after response loss. On 409 or a different current request, re-read and explicitly reconsider; do not blindly overwrite expectedCurrentLifetimeId or reuse a past key.
10. If submission fails or the same request has no resubmit, report that failure; a comment alone does not notify the human. On HTTP 422 duplicate (mission_owner_duplicate_human_submission), an unresolved human submission already exists on this issue — update the existing card or wait for it instead of submitting a new one.
This guidance is display only, not execution authority or a natural-language control contract.
Do not resume or modify a cancelled mission. Do not put credentials in comments or evidence.`;

const markedInstructions = [
  HUMAN_INPUT_INSTRUCTIONS_START_MARKER,
  MISSION_OWNER_HUMAN_INPUT_INSTRUCTIONS,
  HUMAN_INPUT_INSTRUCTIONS_END_MARKER,
].join("\n");

export function appendOrRefreshMissionOwnerHumanInputInstructions(description: string): string {
  const startIndex = description.indexOf(HUMAN_INPUT_INSTRUCTIONS_START_MARKER);
  const endIndex = startIndex < 0
    ? -1
    : description.indexOf(HUMAN_INPUT_INSTRUCTIONS_END_MARKER, startIndex + HUMAN_INPUT_INSTRUCTIONS_START_MARKER.length);

  if (startIndex >= 0 && endIndex >= 0) {
    const afterEndIndex = endIndex + HUMAN_INPUT_INSTRUCTIONS_END_MARKER.length;
    return `${description.slice(0, startIndex)}${markedInstructions}${description.slice(afterEndIndex)}`;
  }
  if (startIndex >= 0 || description.includes(HUMAN_INPUT_INSTRUCTIONS_END_MARKER)) return description;

  const separator = description.length === 0 ? "" : description.endsWith("\n") ? "\n" : "\n\n";
  return `${description}${separator}${markedInstructions}`;
}

export function buildMainExecutorOversightDescription(input: {
  missionTitle: string;
  workflowName: string;
}): string {
  return appendOrRefreshMissionOwnerHumanInputInstructions([
    "Monitor this mission and keep execution moving.",
    "",
    `Mission: ${input.missionTitle}`,
    `Scope: ${input.workflowName}`,
    "",
    "Main executor duties:",
    "- Watch step progress and comments.",
    "- Comment on failed, stale, undispatched, or blocked steps with the current judgement.",
    "- Retry failed workflow steps when retry is safe and within the retry limit.",
    "- Recover/replan toward completion, or escalate/report impossible states with evidence.",
    "- When every non-oversight issue of the mission is done, verify the work products and complete this oversight issue — completing it closes the mission. If completion evidence is missing, wake the responsible step agent instead of waiting silently.",
  ].join("\n"));
}

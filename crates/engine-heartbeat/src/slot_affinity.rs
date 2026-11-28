#![forbid(unsafe_code)]
//! Deterministic warm-cache worker slot affinity selection.

use serde::{Deserialize, Serialize};

/// Snapshot of one worker slot's idle and warm-cache state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkerSlotState {
    pub slot_id: String,
    pub is_idle: bool,
    pub warm_mission_id: Option<String>,
    pub warm_workspace_key: Option<String>,
}

/// Result of affinity-aware worker slot selection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SlotAffinityMatch {
    pub selected_slot_id: Option<String>,
    pub cache_warm: bool,
    pub reason: String,
}

fn affinity_match(
    selected_slot_id: Option<String>,
    cache_warm: bool,
    reason: &str,
) -> SlotAffinityMatch {
    SlotAffinityMatch { selected_slot_id, cache_warm, reason: reason.to_owned() }
}

/// Selects an idle worker slot, preferring exact then workspace-only warm cache affinity.
pub fn select_affinity_slot(
    slots: &[WorkerSlotState],
    mission_id: &str,
    workspace_key: &str,
) -> SlotAffinityMatch {
    let mut idle_slots: Vec<&WorkerSlotState> =
        slots.iter().filter(|slot| slot.is_idle).collect();
    if idle_slots.is_empty() {
        return affinity_match(None, false, "no_idle_slot");
    }
    idle_slots.sort_by(|left, right| left.slot_id.cmp(&right.slot_id));

    if let Some(slot) = idle_slots.iter().copied().find(|slot| {
        slot.warm_mission_id.as_deref() == Some(mission_id)
            && slot.warm_workspace_key.as_deref() == Some(workspace_key)
    }) {
        return affinity_match(
            Some(slot.slot_id.clone()),
            true,
            "exact_mission_workspace_warm",
        );
    }

    if let Some(slot) = idle_slots
        .iter()
        .copied()
        .find(|slot| slot.warm_workspace_key.as_deref() == Some(workspace_key))
    {
        return affinity_match(Some(slot.slot_id.clone()), true, "workspace_warm");
    }

    affinity_match(Some(idle_slots[0].slot_id.clone()), false, "cold_slot_fallback")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slot(
        slot_id: &str,
        is_idle: bool,
        warm_mission_id: Option<&str>,
        warm_workspace_key: Option<&str>,
    ) -> WorkerSlotState {
        WorkerSlotState {
            slot_id: slot_id.to_owned(),
            is_idle,
            warm_mission_id: warm_mission_id.map(str::to_owned),
            warm_workspace_key: warm_workspace_key.map(str::to_owned),
        }
    }

    fn assert_match(
        result: &SlotAffinityMatch,
        selected_slot_id: Option<&str>,
        cache_warm: bool,
        reason: &str,
    ) {
        assert_eq!(result.selected_slot_id.as_deref(), selected_slot_id);
        assert_eq!(result.cache_warm, cache_warm);
        assert_eq!(result.reason.as_str(), reason);
    }

    #[test]
    fn no_idle_slots_return_none() {
        let slots = [slot("slot-a", false, Some("mission"), Some("workspace"))];
        let result = select_affinity_slot(&slots, "mission", "workspace");
        assert_match(&result, None, false, "no_idle_slot");
    }

    #[test]
    fn exact_mission_workspace_warm_hit_uses_slot_id_tie_break() {
        let slots = [
            slot("slot-z", true, Some("mission"), Some("workspace")),
            slot("slot-a", true, Some("mission"), Some("workspace")),
        ];
        let result = select_affinity_slot(&slots, "mission", "workspace");
        assert_match(&result, Some("slot-a"), true, "exact_mission_workspace_warm");
    }

    #[test]
    fn workspace_only_warm_hit_prefers_workspace_over_cold_slot() {
        let slots = [
            slot("slot-a", true, None, None),
            slot("slot-z", true, Some("other"), Some("workspace")),
            slot("slot-b", true, Some("other"), Some("workspace")),
        ];
        let result = select_affinity_slot(&slots, "mission", "workspace");
        assert_match(&result, Some("slot-b"), true, "workspace_warm");
    }

    #[test]
    fn cold_fallback_is_deterministic_slot_id_tie_break() {
        let slots = [slot("slot-z", true, None, None), slot("slot-a", true, None, None)];
        let result = select_affinity_slot(&slots, "mission", "workspace");
        assert_match(&result, Some("slot-a"), false, "cold_slot_fallback");
    }

    #[test]
    fn busy_warm_slot_is_skipped() {
        let slots = [
            slot("slot-z", false, Some("mission"), Some("workspace")),
            slot("slot-a", true, None, None),
        ];
        let result = select_affinity_slot(&slots, "mission", "workspace");
        assert_match(&result, Some("slot-a"), false, "cold_slot_fallback");
    }

    #[test]
    fn serde_round_trip_preserves_state_and_match() {
        let state = slot("slot-a", true, Some("mission"), Some("workspace"));
        let state_json = serde_json::to_string(&state).unwrap();
        assert_eq!(serde_json::from_str::<WorkerSlotState>(&state_json).unwrap(), state);

        let selected = SlotAffinityMatch {
            selected_slot_id: Some("slot-a".to_owned()),
            cache_warm: true,
            reason: "workspace_warm".to_owned(),
        };
        let selected_json = serde_json::to_string(&selected).unwrap();
        assert_eq!(serde_json::from_str::<SlotAffinityMatch>(&selected_json).unwrap(), selected);
    }
}

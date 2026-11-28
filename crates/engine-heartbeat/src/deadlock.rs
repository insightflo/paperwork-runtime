use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WaitEdge {
    pub waiter_id: String,
    pub target_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub waited_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeadlockCycle {
    pub nodes: Vec<String>,
    pub edges: Vec<WaitEdge>,
    pub recommended_break_target: WaitEdge,
}

pub fn detect_wait_deadlocks(edges: &[WaitEdge]) -> Vec<DeadlockCycle> {
    let mut endpoints: BTreeMap<(String, String), WaitEdge> = BTreeMap::new();
    for edge in edges {
        let key = (edge.waiter_id.clone(), edge.target_id.clone());
        if endpoints.get(&key).is_none_or(|old| compare_break(edge, old) == Ordering::Less) {
            endpoints.insert(key, edge.clone());
        }
    }
    let mut nodes = BTreeSet::new();
    let mut adjacency: BTreeMap<String, Vec<WaitEdge>> = BTreeMap::new();
    for edge in endpoints.values() {
        nodes.insert(edge.waiter_id.clone());
        nodes.insert(edge.target_id.clone());
        adjacency.entry(edge.waiter_id.clone()).or_default().push(edge.clone());
    }
    let mut cycles = BTreeMap::new();
    for start in nodes {
        let mut visited = BTreeSet::new();
        visited.insert(start.clone());
        let mut path = vec![start.clone()];
        let mut path_edges = Vec::new();
        walk(&start, &start, &adjacency, &mut path, &mut path_edges, &mut visited, &mut cycles);
    }
    cycles.into_iter().map(|(nodes, edges)| {
        let recommended_break_target = choose_break_target(&edges);
        DeadlockCycle { nodes, edges, recommended_break_target }
    }).collect()
}

fn walk(
    start: &str, current: &str, adjacency: &BTreeMap<String, Vec<WaitEdge>>,
    path: &mut Vec<String>, path_edges: &mut Vec<WaitEdge>, visited: &mut BTreeSet<String>,
    cycles: &mut BTreeMap<Vec<String>, Vec<WaitEdge>>,
) {
    let Some(targets) = adjacency.get(current) else { return };
    for edge in targets {
        let next = &edge.target_id;
        if next.as_str() < start { continue; }
        if next.as_str() == start {
            let mut cycle = path_edges.clone();
            cycle.push(edge.clone());
            cycles.entry(path.clone()).or_insert(cycle);
            continue;
        }
        if visited.contains(next) { continue; }
        visited.insert(next.clone());
        path.push(next.clone());
        path_edges.push(edge.clone());
        walk(start, next, adjacency, path, path_edges, visited, cycles);
        path_edges.pop();
        path.pop();
        visited.remove(next);
    }
}

fn choose_break_target(edges: &[WaitEdge]) -> WaitEdge {
    edges[1..].iter().fold(edges[0].clone(), |best, edge| {
        if compare_break(edge, &best) == Ordering::Less { edge.clone() } else { best }
    })
}

fn compare_break(left: &WaitEdge, right: &WaitEdge) -> Ordering {
    left.waited_ms.unwrap_or(0).cmp(&right.waited_ms.unwrap_or(0))
        .then_with(|| left.waiter_id.cmp(&right.waiter_id))
        .then_with(|| left.target_id.cmp(&right.target_id))
        .then_with(|| run_id(left).cmp(run_id(right)))
}

fn run_id(edge: &WaitEdge) -> &str { edge.run_id.as_deref().unwrap_or("") }

#[cfg(test)]
mod tests {
    use super::*;

    fn edge(waiter: &str, target: &str, run_id: Option<&str>, waited_ms: Option<u64>) -> WaitEdge {
        WaitEdge { waiter_id: waiter.into(), target_id: target.into(), run_id: run_id.map(String::from), waited_ms }
    }
    fn ids(values: &[&str]) -> Vec<String> { values.iter().map(|value| (*value).to_string()).collect() }

    #[test]
    fn empty_graph_and_disconnected_dag_have_no_cycles() {
        assert!(detect_wait_deadlocks(&[]).is_empty());
        let dag = [edge("a", "b", None, None), edge("b", "c", None, None), edge("d", "e", None, None)];
        assert!(detect_wait_deadlocks(&dag).is_empty());
    }

    #[test]
    fn self_loop_is_reported() {
        let cycles = detect_wait_deadlocks(&[edge("a", "a", Some("r1"), Some(7))]);
        assert_eq!(cycles.len(), 1);
        assert_eq!(cycles[0].nodes, ids(&["a"]));
        assert_eq!(cycles[0].edges.len(), 1);
        assert_eq!(cycles[0].recommended_break_target.run_id.as_deref(), Some("r1"));
    }

    #[test]
    fn two_and_three_node_cycles_are_canonical() {
        let two = detect_wait_deadlocks(&[edge("b", "a", None, None), edge("a", "b", None, None)]);
        assert_eq!(two.len(), 1);
        assert_eq!(two[0].nodes, ids(&["a", "b"]));
        assert_eq!(two[0].edges[0].waiter_id, "a");
        let three_input = [edge("c", "a", None, None), edge("b", "c", None, None), edge("a", "b", None, None)];
        let three = detect_wait_deadlocks(&three_input);
        assert_eq!(three.len(), 1);
        assert_eq!(three[0].nodes, ids(&["a", "b", "c"]));
        assert_eq!(three[0].edges.len(), 3);
    }

    #[test]
    fn duplicate_edges_are_deduped_by_break_preference() {
        let cycles = detect_wait_deadlocks(&[
            edge("a", "b", Some("old"), Some(20)),
            edge("a", "b", Some("new"), Some(5)),
            edge("b", "a", Some("other"), Some(30)),
        ]);
        assert_eq!(cycles.len(), 1);
        assert_eq!(cycles[0].edges.len(), 2);
        assert_eq!(cycles[0].recommended_break_target.run_id.as_deref(), Some("new"));
    }

    #[test]
    fn cycles_are_deterministically_ordered() {
        let input = vec![
            edge("z", "y", None, None), edge("y", "z", None, None), edge("m", "m", None, None),
            edge("c", "a", None, None), edge("b", "c", None, None), edge("a", "b", None, None),
        ];
        let mut reversed = input.clone();
        reversed.reverse();
        let forward = detect_wait_deadlocks(&input);
        assert_eq!(forward, detect_wait_deadlocks(&reversed));
        let nodes = forward.iter().map(|cycle| cycle.nodes.clone()).collect::<Vec<_>>();
        assert_eq!(nodes, vec![ids(&["a", "b", "c"]), ids(&["m"]), ids(&["y", "z"])]);
    }
}

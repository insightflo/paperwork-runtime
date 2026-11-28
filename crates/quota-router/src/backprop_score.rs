use serde::{Deserialize, Serialize};

/// One observed adapter/model outcome used as backpropagation telemetry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutcomeSample {
    pub passed: bool,
    pub stalled: bool,
}

/// Deterministic reliability score derived from ordered outcome samples.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BackpropScoreReport {
    pub ewma_pass_rate: f64,
    pub stall_rate: f64,
    pub sample_count: usize,
    pub demote_recommended: bool,
}

/// Compute an EWMA pass rate plus raw stall rate for a candidate adapter/model.
pub fn compute_backprop_reliability(samples: &[OutcomeSample], alpha: f64) -> BackpropScoreReport {
    if samples.is_empty() {
        return BackpropScoreReport {
            ewma_pass_rate: 1.0,
            stall_rate: 0.0,
            sample_count: 0,
            demote_recommended: false,
        };
    }

    let a = if alpha.is_finite() { alpha.clamp(0.05, 0.95) } else { 0.30 };
    let mut ewma = if samples[0].passed { 1.0 } else { 0.0 };
    for s in &samples[1..] {
        let outcome = if s.passed { 1.0 } else { 0.0 };
        ewma = a * outcome + (1.0 - a) * ewma;
    }

    let stall_count = samples.iter().filter(|s| s.stalled).count();
    let stall_rate = stall_count as f64 / samples.len() as f64;
    let demote_recommended = samples.len() >= 3 && (ewma < 0.50 || stall_rate >= 0.40);

    BackpropScoreReport {
        ewma_pass_rate: ewma,
        stall_rate,
        sample_count: samples.len(),
        demote_recommended,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(passed: bool, stalled: bool) -> OutcomeSample {
        OutcomeSample { passed, stalled }
    }

    fn assert_close(actual: f64, expected: f64) {
        assert!((actual - expected).abs() < 1e-12, "expected {actual} ≈ {expected}");
    }

    #[test]
    fn empty_samples_return_perfect_neutral_score() {
        let report = compute_backprop_reliability(&[], 0.30);
        assert_close(report.ewma_pass_rate, 1.0);
        assert_close(report.stall_rate, 0.0);
        assert_eq!(report.sample_count, 0);
        assert!(!report.demote_recommended);
    }

    #[test]
    fn all_pass_samples_keep_ewma_at_one() {
        let samples = vec![sample(true, false), sample(true, false), sample(true, false)];
        let report = compute_backprop_reliability(&samples, 0.30);
        assert_close(report.ewma_pass_rate, 1.0);
        assert_close(report.stall_rate, 0.0);
        assert_eq!(report.sample_count, 3);
        assert!(!report.demote_recommended);
    }

    #[test]
    fn recent_failures_drag_ewma_below_half_and_recommend_demote() {
        let samples = vec![
            sample(true, false),
            sample(true, false),
            sample(false, false),
            sample(false, false),
        ];
        let report = compute_backprop_reliability(&samples, 0.50);
        assert_close(report.ewma_pass_rate, 0.25);
        assert!(report.ewma_pass_rate < 0.50);
        assert!(report.demote_recommended);
    }

    #[test]
    fn high_stall_rate_recommends_demote_even_with_passes() {
        let samples = vec![
            sample(true, true),
            sample(true, false),
            sample(true, true),
            sample(true, false),
            sample(true, false),
        ];
        let report = compute_backprop_reliability(&samples, 0.30);
        assert_close(report.ewma_pass_rate, 1.0);
        assert_close(report.stall_rate, 0.40);
        assert!(report.demote_recommended);
    }

    #[test]
    fn fewer_than_three_samples_have_grace_period() {
        let samples = vec![sample(false, true), sample(false, true)];
        let report = compute_backprop_reliability(&samples, 0.95);
        assert_eq!(report.sample_count, 2);
        assert_close(report.ewma_pass_rate, 0.0);
        assert_close(report.stall_rate, 1.0);
        assert!(!report.demote_recommended);
    }

    #[test]
    fn serde_round_trip_preserves_input_and_report() {
        let samples = vec![sample(true, false), sample(false, true), sample(true, false)];
        let report = compute_backprop_reliability(&samples, f64::NAN);
        let report_json = serde_json::to_string(&report).expect("serialize report");
        let decoded_report: BackpropScoreReport =
            serde_json::from_str(&report_json).expect("deserialize report");
        assert_eq!(decoded_report, report);

        let sample_json = serde_json::to_string(&samples[0]).expect("serialize sample");
        let decoded_sample: OutcomeSample =
            serde_json::from_str(&sample_json).expect("deserialize sample");
        assert!(decoded_sample.passed);
        assert!(!decoded_sample.stalled);
    }
}

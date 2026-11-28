use serde::{Deserialize, Serialize};

pub const DEFAULT_MIN_BASELINE_SAMPLES: usize = 5;
pub const DEFAULT_MULTIPLIER_THRESHOLD: f64 = 3.0;
pub const DEFAULT_MIN_ABSOLUTE_DELTA_USD: f64 = 0.5;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CostAnomalyInput {
    pub current_cost_usd: f64,
    pub historical_costs_usd: Vec<f64>,
    pub min_baseline_samples: Option<usize>,
    pub multiplier_threshold: Option<f64>,
    pub min_absolute_delta_usd: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CostAnomalyResult {
    pub is_anomaly: bool,
    pub baseline_median_usd: f64,
    pub ratio_to_median: f64,
    pub reason: String,
}

pub fn compute_median(values: &[f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let middle = sorted.len() / 2;
    if sorted.len() % 2 == 1 {
        sorted[middle]
    } else {
        (sorted[middle - 1] + sorted[middle]) / 2.0
    }
}

fn round_two_decimals(value: f64) -> f64 {
    ((value * 100.0) + 0.5).floor() / 100.0
}

pub fn detect_run_cost_anomaly(input: &CostAnomalyInput) -> CostAnomalyResult {
    let min_baseline_samples = input
        .min_baseline_samples
        .unwrap_or(DEFAULT_MIN_BASELINE_SAMPLES);
    let multiplier_threshold = input
        .multiplier_threshold
        .unwrap_or(DEFAULT_MULTIPLIER_THRESHOLD);
    let min_absolute_delta_usd = input
        .min_absolute_delta_usd
        .unwrap_or(DEFAULT_MIN_ABSOLUTE_DELTA_USD);
    let valid_history: Vec<f64> = input
        .historical_costs_usd
        .iter()
        .copied()
        .filter(|cost| cost.is_finite() && *cost >= 0.0)
        .collect();
    let baseline_median_usd = compute_median(&valid_history);
    let ratio_to_median = if baseline_median_usd > 0.0 {
        round_two_decimals(input.current_cost_usd / baseline_median_usd)
    } else if input.current_cost_usd >= min_absolute_delta_usd {
        f64::INFINITY
    } else {
        1.0
    };
    let exceeds_absolute_delta =
        input.current_cost_usd - baseline_median_usd >= min_absolute_delta_usd;
    let exceeds_multiplier = if baseline_median_usd == 0.0 {
        input.current_cost_usd >= min_absolute_delta_usd
    } else {
        input.current_cost_usd >= baseline_median_usd * multiplier_threshold
    };
    let detected = exceeds_absolute_delta && exceeds_multiplier;
    let (is_anomaly, reason) = if valid_history.len() < min_baseline_samples {
        (false, "Insufficient baseline samples")
    } else if detected {
        (true, "Cost exceeds baseline multiplier and minimum delta")
    } else if exceeds_absolute_delta {
        (false, "Cost within baseline multiplier threshold")
    } else {
        (false, "Cost delta below minimum absolute threshold")
    };

    CostAnomalyResult {
        is_anomaly,
        baseline_median_usd,
        ratio_to_median,
        reason: reason.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(current_cost_usd: f64, historical_costs_usd: &[f64]) -> CostAnomalyInput {
        CostAnomalyInput {
            current_cost_usd,
            historical_costs_usd: historical_costs_usd.to_vec(),
            min_baseline_samples: None,
            multiplier_threshold: None,
            min_absolute_delta_usd: None,
        }
    }

    #[test]
    fn median_handles_empty_odd_and_even_inputs() {
        assert_eq!(compute_median(&[]), 0.0);
        assert_eq!(compute_median(&[0.3, 0.1, 0.2]), 0.2);
        assert_eq!(compute_median(&[0.4, 0.1, 0.3, 0.2]), 0.25);
    }

    #[test]
    fn insufficient_baseline_never_flags() {
        let result = detect_run_cost_anomaly(&input(2.5, &[0.5, 0.5, 0.5, 0.5]));
        assert!(!result.is_anomaly);
        assert_eq!(result.baseline_median_usd, 0.5);
        assert_eq!(result.reason, "Insufficient baseline samples");
    }

    #[test]
    fn normal_run_within_multiplier_is_not_flagged() {
        let result = detect_run_cost_anomaly(&input(1.4, &[0.5; 5]));
        assert!(!result.is_anomaly);
        assert_eq!(result.ratio_to_median, 2.8);
        assert_eq!(result.reason, "Cost within baseline multiplier threshold");
    }

    #[test]
    fn tiny_absolute_delta_is_suppressed() {
        let result = detect_run_cost_anomaly(&input(0.05, &[0.01; 5]));
        assert!(!result.is_anomaly);
        assert_eq!(result.ratio_to_median, 5.0);
        assert_eq!(result.reason, "Cost delta below minimum absolute threshold");
    }

    #[test]
    fn true_spike_is_flagged() {
        let result = detect_run_cost_anomaly(&input(2.5, &[0.5; 5]));
        assert!(result.is_anomaly);
        assert_eq!(result.baseline_median_usd, 0.5);
        assert_eq!(result.ratio_to_median, 5.0);
        assert_eq!(result.reason, "Cost exceeds baseline multiplier and minimum delta");
    }

    #[test]
    fn zero_baseline_free_tier_spike_uses_absolute_floor() {
        let result = detect_run_cost_anomaly(&input(0.5, &[0.0; 5]));
        assert!(result.is_anomaly);
        assert!(result.ratio_to_median.is_infinite());
        assert!(result.ratio_to_median.is_sign_positive());
    }

    #[test]
    fn zero_baseline_below_floor_is_not_flagged() {
        let result = detect_run_cost_anomaly(&input(0.49, &[0.0; 5]));
        assert!(!result.is_anomaly);
        assert_eq!(result.ratio_to_median, 1.0);
        assert_eq!(result.reason, "Cost delta below minimum absolute threshold");
    }

    #[test]
    fn invalid_history_samples_are_ignored() {
        let result = detect_run_cost_anomaly(&input(
            2.5,
            &[0.5, 0.5, 0.5, 0.5, 0.5, f64::NAN, f64::INFINITY, -1.0],
        ));
        assert!(result.is_anomaly);
        assert_eq!(result.baseline_median_usd, 0.5);
    }

    #[test]
    fn custom_thresholds_are_respected() {
        let mut request = input(1.2, &[0.5; 3]);
        request.min_baseline_samples = Some(3);
        request.multiplier_threshold = Some(2.5);
        request.min_absolute_delta_usd = Some(0.5);
        let result = detect_run_cost_anomaly(&request);
        assert!(!result.is_anomaly);
        assert_eq!(result.reason, "Cost within baseline multiplier threshold");
    }
}

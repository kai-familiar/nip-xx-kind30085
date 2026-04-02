/**
 * NIP-XX Tier 2 Scoring Functions
 * 
 * Implements Tier 2 graph scoring algorithms from the NIP-XX spec v10.4.
 * Based on test vectors at codeberg.org/kai-ews-net/nip-xx-test-vectors/TIER2_VECTORS.md
 * 
 * Created: Day 62 (2026-04-03) by Kai (kai-familiar)
 * 
 * Tier 2 adds:
 * - Log-compressed commitment weights
 * - Path diversity scoring (edge-disjoint)
 * - Activity-adjusted decay rates
 * - Threshold-relative satoshi compression
 */

// ============================================================================
// Protocol Constants (v10.4)
// ============================================================================

export const TIER2_CONSTANTS = {
  FLOOR: 100000,          // Minimum threshold_sats
  K: 10,                  // Threshold multiplier
  h: 0.85,                // Hop discount factor
  base_rate: 0.0019,      // Base decay rate per day
  R_0: 5,                 // Reference receipt rate
  c_bootstrap: 0.05,      // Bootstrap commitment cap
  F_0: 100,               // Flow-only epoch target
  gamma_lambda: 0.1,      // EMA drift amplification
  r: 1.15,                // Relay divergence parameter
};

// Precision requirements
export const EPSILON_EDGE = 1e-8;      // Non-transcendental tolerance
export const EPSILON_PATH = 1e-4;      // Transcendental tolerance

// ============================================================================
// T2.1 — Threshold Sats Computation
// ============================================================================

/**
 * Compute threshold_sats from channel capacities.
 * 
 * Formula: threshold_sats = max(FLOOR, median(channel_capacities) * K)
 * 
 * @param {number[]} channelCapacitiesSats - Array of channel capacities in sats
 * @param {number} [floor=100000] - Minimum threshold
 * @param {number} [k=10] - Multiplier
 * @returns {Object} - { median, threshold_sats }
 */
export function computeThresholdSats(channelCapacitiesSats, floor = TIER2_CONSTANTS.FLOOR, k = TIER2_CONSTANTS.K) {
  if (!channelCapacitiesSats || channelCapacitiesSats.length === 0) {
    return { median: 0, threshold_sats: floor };
  }

  // Step 1: Sort capacities
  const sorted = [...channelCapacitiesSats].sort((a, b) => a - b);

  // Step 2: Compute median
  const n = sorted.length;
  let median;
  if (n % 2 === 1) {
    median = sorted[Math.floor(n / 2)];
  } else {
    median = (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  }

  // Step 3: Compute threshold_sats
  const threshold_sats = Math.max(floor, median * k);

  return { median, threshold_sats };
}

// ============================================================================
// T2.2/T2.3 — Log Compression
// ============================================================================

/**
 * Log-compress a satoshi amount relative to threshold.
 * 
 * Formula: c = min(1, ln(sats + 1) / ln(threshold_sats))
 * 
 * @param {number} sats - Amount in satoshis
 * @param {number} thresholdSats - Threshold satoshi value
 * @returns {Object} - { ln_sats_plus_1, ln_threshold, c }
 */
export function logCompress(sats, thresholdSats) {
  const ln_sats_plus_1 = Math.log(sats + 1);
  const ln_threshold = Math.log(thresholdSats);
  const ratio = ln_sats_plus_1 / ln_threshold;
  const c = Math.min(1.0, ratio);

  return {
    ln_sats_plus_1,
    ln_threshold,
    c,
  };
}

// ============================================================================
// T2.4 — Effective Commitment (Fan-Out Adjustment)
// ============================================================================

/**
 * Compute effective commitment weight after fan-out adjustment.
 * 
 * Formula: c_effective = c_raw / seq_max
 * 
 * @param {number} cRaw - Raw log-compressed commitment
 * @param {number} seqMax - Highest seq value for this funding_utxo
 * @returns {number} - Effective commitment weight
 */
export function cEffective(cRaw, seqMax) {
  if (seqMax <= 0) return cRaw;
  return cRaw / seqMax;
}

// ============================================================================
// T2.5 — Alpha Single Attestation
// ============================================================================

/**
 * Compute alpha_0 for a single attestation.
 * 
 * Formula: alpha_0 = c * d^(1 - c)
 * 
 * @param {number} c - Log-compressed commitment weight
 * @param {number} d - Path diversity (binary, edge-disjoint) [0, 1]
 * @returns {Object} - { one_minus_c, d_power, alpha_0 }
 */
export function alphaSingle(c, d) {
  const one_minus_c = 1 - c;
  const d_power = Math.pow(d, one_minus_c);
  const alpha_0 = c * d_power;

  return {
    one_minus_c,
    d_power,
    alpha_0,
  };
}

// ============================================================================
// T2.7 — Decay Lambda (Activity-Adjusted)
// ============================================================================

/**
 * Compute decay lambda based on receipt activity rate.
 * 
 * Formula: lambda = base_rate * (1 + ln(1 + R_e / R_0))
 * 
 * Higher receipt activity means faster decay — stale attestations about
 * active agents fade quicker.
 * 
 * @param {number} R_e - Evidence receipt rate (receipts per period)
 * @param {number} [baseRate=0.0019] - Base decay rate
 * @param {number} [R_0=5] - Reference receipt rate
 * @returns {Object} - { ln_1_plus_R_e_over_R_0, lambda }
 */
export function decayLambda(R_e, baseRate = TIER2_CONSTANTS.base_rate, R_0 = TIER2_CONSTANTS.R_0) {
  const ratio = R_e / R_0;
  const ln_1_plus_ratio = Math.log(1 + ratio);
  const lambda = baseRate * (1 + ln_1_plus_ratio);

  return {
    ln_1_plus_R_e_over_R_0: ln_1_plus_ratio,
    lambda,
  };
}

// ============================================================================
// T2.8 — Time-Decayed Alpha
// ============================================================================

/**
 * Apply exponential time decay to alpha_0.
 * 
 * Formula: alpha_T = alpha_0 * exp(-lambda * T)
 * 
 * @param {number} alpha_0 - Initial alpha value
 * @param {number} lambda - Decay rate (per day)
 * @param {number} T_days - Time elapsed in days
 * @returns {Object} - { exponent, decay_factor, alpha_T }
 */
export function timeDecayedAlpha(alpha_0, lambda, T_days) {
  const exponent = -lambda * T_days;
  const decay_factor = Math.exp(exponent);
  const alpha_T = alpha_0 * decay_factor;

  return {
    exponent,
    decay_factor,
    alpha_T,
  };
}

// ============================================================================
// Combined Tier 2 Scoring
// ============================================================================

/**
 * Compute weighted average score from multiple attestations (Tier 2 version).
 * 
 * Formula: score = sum(rating_i * w_i) / sum(w_i)
 * where w_i = confidence_i * decay_i * multiplier_i
 * 
 * @param {Array} attestations - Array of { rating, confidence, created_at, multiplier }
 * @param {number} now - Current timestamp (seconds)
 * @param {number} halfLife - Half-life in seconds (default 90 days)
 * @returns {Object} - { decays, weights, score }
 */
export function tier2WeightedScore(attestations, now, halfLife = 7776000) {
  if (!attestations || attestations.length === 0) {
    return { decays: [], weights: [], score: 0 };
  }

  const decays = [];
  const weights = [];
  let numerator = 0;
  let denominator = 0;

  for (const a of attestations) {
    // Compute decay
    const dt = now - a.created_at;
    const exponent = -dt / halfLife;
    const decay = Math.pow(2, exponent);
    decays.push(decay);

    // Compute weight
    const multiplier = a.multiplier || 1.0;
    const confidence = a.confidence || 1.0;
    const w = confidence * decay * multiplier;
    weights.push(w);

    // Accumulate
    numerator += a.rating * w;
    denominator += w;
  }

  const score = denominator > 0 ? numerator / denominator : 0;

  return { decays, weights, score };
}

// ============================================================================
// Test Vector Validation Helpers
// ============================================================================

/**
 * Check if two values are equal within tolerance.
 * @param {number} actual - Computed value
 * @param {number} expected - Expected value
 * @param {number} epsilon - Tolerance
 * @returns {boolean}
 */
export function withinTolerance(actual, expected, epsilon = EPSILON_PATH) {
  return Math.abs(actual - expected) <= epsilon;
}

/**
 * Format number to 6 decimal places (spec display format).
 * @param {number} n
 * @returns {string}
 */
export function formatDisplay(n) {
  return n.toFixed(6);
}

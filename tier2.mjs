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
// T2.9 — Revocation (Instant Zero)
// ============================================================================

/**
 * Apply revocation check. If status is "revoked", alpha = 0 immediately.
 * 
 * @param {number} alpha_0 - Computed alpha before revocation check
 * @param {string} status - Attestation status ("active" | "revoked")
 * @returns {number} - Alpha value (0 if revoked)
 */
export function applyRevocation(alpha_0, status) {
  if (status === 'revoked') {
    return 0.0;
  }
  return alpha_0;
}

// ============================================================================
// T2.10 — Fraud Proof Penalty
// ============================================================================

/**
 * Apply fraud proof penalty. Zeros alpha for attestations using matching UTXO.
 * 
 * @param {Object} attestation - { pubkey, funding_utxo, alpha }
 * @param {Object} fraudProof - { accused_pubkey, funding_utxo, fraud_type }
 * @returns {Object} - { alpha, affected }
 */
export function applyFraudProof(attestation, fraudProof) {
  const matchesUtxo = attestation.funding_utxo === fraudProof.funding_utxo;
  
  if (matchesUtxo) {
    return { alpha: 0.0, affected: true };
  }
  return { alpha: attestation.alpha, affected: false };
}

// ============================================================================
// T2.11 — Unverifiable UTXO Degradation
// ============================================================================

/**
 * Apply bootstrap cap for unverifiable UTXOs.
 * 
 * @param {number} c_raw - Raw commitment if verified
 * @param {boolean} utxo_verifiable - Whether UTXO can be verified on-chain
 * @param {number} [c_bootstrap=0.05] - Bootstrap cap
 * @returns {number} - c_effective (capped if unverifiable)
 */
export function applyUtxoVerification(c_raw, utxo_verifiable, c_bootstrap = TIER2_CONSTANTS.c_bootstrap) {
  if (!utxo_verifiable) {
    return c_bootstrap;
  }
  return c_raw;
}

// ============================================================================
// T2.12 — Bootstrap Commitment (Flow-Only)
// ============================================================================

/**
 * Compute bootstrap commitment for flow-only agents.
 * 
 * Formula: c_bootstrap = min(c_max, c_max * ln(1 + epoch_count) / ln(1 + F_0))
 * 
 * @param {number} epoch_count - Number of flow-only epochs
 * @param {number} [F_0=100] - Target epoch count for full bootstrap
 * @param {number} [c_max=0.05] - Maximum bootstrap commitment
 * @returns {Object} - { ln_1_plus_epoch, ln_1_plus_F_0, ratio, c_bootstrap }
 */
export function computeBootstrapCommitment(epoch_count, F_0 = TIER2_CONSTANTS.F_0, c_max = TIER2_CONSTANTS.c_bootstrap) {
  const ln_1_plus_epoch = Math.log(1 + epoch_count);
  const ln_1_plus_F_0 = Math.log(1 + F_0);
  const ratio = ln_1_plus_epoch / ln_1_plus_F_0;
  const raw = c_max * ratio;
  const c_bootstrap = Math.min(c_max, raw);

  return {
    ln_1_plus_epoch,
    ln_1_plus_F_0,
    ratio,
    c_bootstrap,
  };
}

// ============================================================================
// T2.13 — Closed UTXO Recap
// ============================================================================

/**
 * Apply recap for spent (closed) UTXO.
 * Drops to c_bootstrap, keeps original decay clock.
 * 
 * @param {number} c_raw - Original commitment before close
 * @param {string} utxo_status - "unspent" | "spent"
 * @param {number} original_created_at - Original attestation timestamp
 * @param {number} [c_bootstrap=0.05] - Bootstrap cap
 * @returns {Object} - { c_effective, decay_clock_start }
 */
export function applyClosedUtxo(c_raw, utxo_status, original_created_at, c_bootstrap = TIER2_CONSTANTS.c_bootstrap) {
  if (utxo_status === 'spent') {
    return {
      c_effective: c_bootstrap,
      decay_clock_start: original_created_at,
    };
  }
  return {
    c_effective: c_raw,
    decay_clock_start: original_created_at,
  };
}

// ============================================================================
// T2.14 — Reattestation Renewal
// ============================================================================

/**
 * Handle NIP-33 replacement (reattestation).
 * Discards old alpha, computes fresh alpha_0 from new parameters.
 * 
 * @param {Object} newAttestation - { c, d, created_at }
 * @returns {Object} - { new_alpha_0, old_alpha_discarded }
 */
export function applyReattestation(newAttestation) {
  const { one_minus_c, d_power, alpha_0 } = alphaSingle(newAttestation.c, newAttestation.d);
  
  return {
    new_alpha_0: alpha_0,
    old_alpha_discarded: true,
  };
}

// ============================================================================
// T2.15 — EMA Drift Consolidation (REC)
// ============================================================================

/**
 * Compute effective lambda with EMA drift amplification.
 * 
 * Formula: lambda_eff = lambda_base * (1 + gamma_lambda * max(0, EMA_k_dT_dt))
 * 
 * @param {number} lambda_base - Base decay rate
 * @param {number} EMA_k_dT_dt - EMA of network change rate
 * @param {number} [gamma=0.1] - Drift amplification factor
 * @returns {Object} - { amplification_factor, lambda_eff }
 */
export function computeLambdaWithDrift(lambda_base, EMA_k_dT_dt, gamma = TIER2_CONSTANTS.gamma_lambda) {
  const amplification_factor = 1 + gamma * Math.max(0, EMA_k_dT_dt);
  const lambda_eff = lambda_base * amplification_factor;

  return {
    lambda_base,
    amplification_factor,
    lambda_eff,
  };
}

// ============================================================================
// T2.16 — Threshold Effective Bidirectional (REC)
// ============================================================================

/**
 * Compute effective threshold with EMA-based adjustment.
 * 
 * Formula: threshold_eff = threshold_sats * exp(-delta * EMA_k_dT_dt)
 * 
 * @param {number} threshold_sats - Base threshold
 * @param {number} EMA_k_dT_dt - EMA of network change rate
 * @param {number} [delta=0.115] - Sensitivity parameter
 * @returns {Object} - { exponent, threshold_eff }
 */
export function computeThresholdEffective(threshold_sats, EMA_k_dT_dt, delta = 0.115) {
  const exponent = -delta * EMA_k_dT_dt;
  const threshold_eff = threshold_sats * Math.exp(exponent);

  return {
    exponent,
    threshold_eff,
  };
}

// ============================================================================
// T2.17 — Log Compression Edge Case (threshold <= 1)
// ============================================================================

/**
 * Safe log compression with threshold guard.
 * If threshold <= 1, returns c = 0 to avoid division by zero.
 * 
 * @param {number} sats - Amount in satoshis
 * @param {number} threshold_sats - Threshold value
 * @returns {Object} - { c, guarded }
 */
export function logCompressSafe(sats, threshold_sats) {
  if (threshold_sats <= 1) {
    return { c: 0.0, guarded: true };
  }
  
  const result = logCompress(sats, threshold_sats);
  return { ...result, guarded: false };
}

// ============================================================================
// T2.18 — R_e from Raw Data
// ============================================================================

/**
 * Compute receipt rate R_e from raw L402 timestamps.
 * 
 * Formula: R_e = distinct_active_days / window_size_days
 * 
 * @param {number[]} timestamps - Array of L402 receipt timestamps
 * @param {number} window_start - Window start timestamp
 * @param {number} window_end - Window end timestamp
 * @returns {Object} - { distinct_days, R_e, lambda }
 */
export function computeReFromTimestamps(timestamps, window_start, window_end, baseRate = TIER2_CONSTANTS.base_rate, R_0 = TIER2_CONSTANTS.R_0) {
  const window_size_seconds = window_end - window_start;
  const window_size_days = window_size_seconds / 86400;

  // Map each timestamp to a day index and collect unique days
  const uniqueDays = new Set();
  for (const ts of timestamps) {
    if (ts >= window_start && ts <= window_end) {
      const dayIndex = Math.floor((ts - window_start) / 86400);
      uniqueDays.add(dayIndex);
    }
  }

  const distinct_days = uniqueDays.size;
  const R_e = distinct_days / window_size_days;

  // Also compute lambda for convenience
  const { lambda } = decayLambda(R_e, baseRate, R_0);

  return {
    distinct_days,
    R_e,
    lambda,
  };
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

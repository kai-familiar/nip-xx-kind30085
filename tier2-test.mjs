#!/usr/bin/env node
/**
 * Tier 2 Test Vector Validation
 * 
 * Tests against codeberg.org/kai-ews-net/nip-xx-test-vectors/TIER2_VECTORS.md
 */

import {
  computeThresholdSats,
  logCompress,
  cEffective,
  alphaSingle,
  decayLambda,
  timeDecayedAlpha,
  tier2WeightedScore,
  withinTolerance,
  EPSILON_PATH,
  EPSILON_EDGE,
  // T2.9-T2.18
  applyRevocation,
  applyFraudProof,
  applyUtxoVerification,
  computeBootstrapCommitment,
  applyClosedUtxo,
  applyReattestation,
  computeLambdaWithDrift,
  computeThresholdEffective,
  logCompressSafe,
  computeReFromTimestamps,
} from './tier2.mjs';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
    passed++;
  } catch (e) {
    console.log(`❌ ${name}`);
    console.log(`   ${e.message}`);
    failed++;
  }
}

function assertEqual(actual, expected, msg, epsilon = EPSILON_PATH) {
  if (!withinTolerance(actual, expected, epsilon)) {
    throw new Error(`${msg}: expected ${expected}, got ${actual}`);
  }
}

console.log('NIP-XX Tier 2 Test Vectors\n');
console.log('Reference: codeberg.org/kai-ews-net/nip-xx-test-vectors/TIER2_VECTORS.md\n');

// T2.1 — threshold_sats computation
test('T2.1 threshold_sats_computation', () => {
  const capacities = [100000, 500000, 2000000, 3000000, 10000000];
  const result = computeThresholdSats(capacities);
  assertEqual(result.median, 2000000, 'median', EPSILON_EDGE);
  assertEqual(result.threshold_sats, 20000000, 'threshold_sats', EPSILON_EDGE);
});

// T2.2 — log compression near floor
test('T2.2 log_compression_near_floor', () => {
  const result = logCompress(150000, 20000000);
  assertEqual(result.ln_sats_plus_1, 11.918397, 'ln_sats_plus_1');
  assertEqual(result.ln_threshold, 16.811243, 'ln_threshold');
  assertEqual(result.c, 0.708954, 'c');
});

// T2.3 — log compression above floor
test('T2.3 log_compression_above_floor', () => {
  const result = logCompress(5000000, 20000000);
  assertEqual(result.ln_sats_plus_1, 15.424949, 'ln_sats_plus_1');
  assertEqual(result.ln_threshold, 16.811243, 'ln_threshold');
  assertEqual(result.c, 0.917538, 'c');
});

// T2.4 — c_effective fan out
test('T2.4 c_effective_fan_out', () => {
  const result = cEffective(0.708954, 3);
  assertEqual(result, 0.236318, 'c_effective');
});

// T2.5 — alpha single attestation
test('T2.5 alpha_single_attestation', () => {
  const result = alphaSingle(0.708954, 0.75);
  assertEqual(result.one_minus_c, 0.291046, 'one_minus_c');
  assertEqual(result.d_power, 0.919681, 'd_power');
  assertEqual(result.alpha_0, 0.652011, 'alpha_0');
});

// T2.6 — weighted average three attestations
test('T2.6 weighted_average_three_attestations', () => {
  const now = 1774800000;
  const halfLife = 7776000;
  
  const attestations = [
    { rating: 5, confidence: 0.9, created_at: 1772208000, multiplier: 1.2 },
    { rating: 3, confidence: 0.7, created_at: 1769616000, multiplier: 1.0 },
    { rating: 4, confidence: 0.85, created_at: 1773936000, multiplier: 1.1 },
  ];
  
  const result = tier2WeightedScore(attestations, now, halfLife);
  
  assertEqual(result.decays[0], 0.793701, 'decay[0]');
  assertEqual(result.decays[1], 0.629961, 'decay[1]');
  assertEqual(result.decays[2], 0.925875, 'decay[2]');
  assertEqual(result.weights[0], 0.857197, 'weight[0]');
  assertEqual(result.weights[1], 0.440972, 'weight[1]');
  assertEqual(result.weights[2], 0.865693, 'weight[2]');
  assertEqual(result.score, 4.192352, 'score');
});

// T2.7 — decay lambda (scenario 1: R_e = 2)
test('T2.7 decay_lambda_R_e_2', () => {
  const result = decayLambda(2);
  assertEqual(result.ln_1_plus_R_e_over_R_0, 0.336472, 'ln_1_plus_R_e_over_R_0');
  assertEqual(result.lambda, 0.002539, 'lambda');
});

// T2.7 — decay lambda (scenario 2: R_e = 20)
test('T2.7 decay_lambda_R_e_20', () => {
  const result = decayLambda(20);
  assertEqual(result.ln_1_plus_R_e_over_R_0, 1.609438, 'ln_1_plus_R_e_over_R_0');
  assertEqual(result.lambda, 0.004958, 'lambda');
});

// T2.8 — time decayed alpha
test('T2.8 time_decayed_alpha', () => {
  const result = timeDecayedAlpha(0.652011, 0.002539, 90);
  // Note: test vector uses 0.228537 due to rounding of lambda
  assertEqual(result.exponent, -0.22851, 'exponent', 0.001);
  assertEqual(result.decay_factor, 0.795697, 'decay_factor', 0.001);
  assertEqual(result.alpha_T, 0.518803, 'alpha_T', 0.001);
});

// T2.9 — revocation instant zero
test('T2.9 revocation_instant_zero', () => {
  const alpha_0 = 0.652011;
  
  // Active status preserves alpha
  const active = applyRevocation(alpha_0, 'active');
  assertEqual(active, 0.652011, 'active preserves alpha', EPSILON_EDGE);
  
  // Revoked status zeros alpha immediately
  const revoked = applyRevocation(alpha_0, 'revoked');
  assertEqual(revoked, 0.0, 'revoked zeros alpha', EPSILON_EDGE);
});

// T2.10 — fraud proof penalty
test('T2.10 fraud_proof_penalty', () => {
  const affected = {
    pubkey: 'a1b2a1b2',
    funding_utxo: 'aaaaaaaa:0',
    alpha: 0.652011,
  };
  
  const unaffected = {
    pubkey: 'a1b2a1b2',
    funding_utxo: 'bbbbbbbb:1',
    alpha: 0.55,
  };
  
  const fraudProof = {
    accused_pubkey: 'a1b2a1b2',
    funding_utxo: 'aaaaaaaa:0',
    fraud_type: 'seq_reuse',
  };
  
  const resultAffected = applyFraudProof(affected, fraudProof);
  assertEqual(resultAffected.alpha, 0.0, 'affected alpha zeroed', EPSILON_EDGE);
  
  const resultUnaffected = applyFraudProof(unaffected, fraudProof);
  assertEqual(resultUnaffected.alpha, 0.55, 'unaffected alpha unchanged', EPSILON_EDGE);
});

// T2.11 — unverifiable UTXO degradation
test('T2.11 unverifiable_utxo_degradation', () => {
  const c_raw = 0.708954;
  
  // Verifiable preserves c
  const verified = applyUtxoVerification(c_raw, true);
  assertEqual(verified, 0.708954, 'verified preserves c', EPSILON_EDGE);
  
  // Unverifiable caps to c_bootstrap
  const unverified = applyUtxoVerification(c_raw, false);
  assertEqual(unverified, 0.05, 'unverified caps to c_bootstrap', EPSILON_EDGE);
});

// T2.12 — c_bootstrap flow only
test('T2.12 c_bootstrap_flow_only', () => {
  const result = computeBootstrapCommitment(15, 100, 0.05);
  assertEqual(result.ln_1_plus_epoch, 2.772589, 'ln_1_plus_epoch');
  assertEqual(result.ln_1_plus_F_0, 4.615121, 'ln_1_plus_F_0');
  assertEqual(result.ratio, 0.600762, 'ratio');
  assertEqual(result.c_bootstrap, 0.030038, 'c_bootstrap');
});

// T2.13 — closed UTXO recap
test('T2.13 closed_utxo_recap', () => {
  const result = applyClosedUtxo(0.708954, 'spent', 1769616000);
  assertEqual(result.c_effective, 0.05, 'c_effective after close', EPSILON_EDGE);
  assertEqual(result.decay_clock_start, 1769616000, 'decay clock unchanged', EPSILON_EDGE);
});

// T2.14 — reattestation renewal
test('T2.14 reattestation_renewal', () => {
  const newAttestation = {
    created_at: 1774800000,
    c: 0.917538,
    d: 0.8,
  };
  
  const result = applyReattestation(newAttestation);
  assertEqual(result.new_alpha_0, 0.900809, 'new_alpha_0');
  if (!result.old_alpha_discarded) {
    throw new Error('old_alpha_discarded should be true');
  }
});

// T2.15 — EMA drift consolidation (REC)
test('T2.15 ema_drift_consolidation (REC)', () => {
  const lambda_base = 0.002539;
  const EMA_k_dT_dt = 500;
  
  const result = computeLambdaWithDrift(lambda_base, EMA_k_dT_dt);
  assertEqual(result.amplification_factor, 51.0, 'amplification_factor', EPSILON_EDGE);
  assertEqual(result.lambda_eff, 0.129504, 'lambda_eff', 0.0001);
});

// T2.16 — threshold effective bidirectional (REC)
test('T2.16 threshold_eff_bidirectional (REC)', () => {
  const threshold_sats = 20000000;
  const EMA_k_dT_dt = 500;
  
  const result = computeThresholdEffective(threshold_sats, EMA_k_dT_dt);
  assertEqual(result.exponent, -57.5, 'exponent', EPSILON_EDGE);
  // Effectively zero (extremely small)
  if (result.threshold_eff > 1e-10) {
    throw new Error(`threshold_eff should be ~0, got ${result.threshold_eff}`);
  }
});

// T2.17 — log compression threshold <= 1
test('T2.17 log_compression_threshold_lte_1', () => {
  const result = logCompressSafe(150000, 1);
  assertEqual(result.c, 0.0, 'c should be 0 when threshold<=1', EPSILON_EDGE);
  if (!result.guarded) {
    throw new Error('guarded should be true');
  }
});

// T2.18 — R_e from raw data
test('T2.18 R_e_from_raw_data', () => {
  const timestamps = [
    1772211600, 1772215200, 1772468200, 1772817800,
    1773246800, 1773772200, 1774285600, 1774714100
  ];
  const window_start = 1772208000;
  const window_end = 1774800000;
  
  const result = computeReFromTimestamps(timestamps, window_start, window_end);
  assertEqual(result.distinct_days, 7, 'distinct_days', EPSILON_EDGE);
  assertEqual(result.R_e, 0.233333, 'R_e');
  assertEqual(result.lambda, 0.001987, 'lambda');
});

console.log('\n' + '─'.repeat(40));
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`Coverage: ${passed}/${passed + failed} test vectors (${Math.round(passed / (passed + failed) * 100)}%)`);

if (failed > 0) {
  process.exit(1);
}

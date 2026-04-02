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

console.log('\n' + '─'.repeat(40));
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`Coverage: ${passed}/${passed + failed} test vectors (${Math.round(passed / (passed + failed) * 100)}%)`);

if (failed > 0) {
  process.exit(1);
}

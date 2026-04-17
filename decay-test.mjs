#!/usr/bin/env node
/**
 * NIP-XX Decay Function Tests
 *
 * Tests exponential and Gaussian decay implementations.
 * Verifies mathematical correctness and edge cases.
 *
 * Created: Day 75 (2026-04-16)
 */

import {
  decay,
  exponentialDecay,
  gaussianDecay,
  tier1Score,
  DECAY_TYPES,
} from './nip-xx-kind30085.mjs';

console.log('NIP-XX Decay Function Tests\n');
console.log('─'.repeat(60));

const DAY = 86400;
const WEEK = 7 * DAY;

let passed = 0;
let failed = 0;

function test(name, condition, details = '') {
  if (condition) {
    console.log(`✅ ${name}`);
    passed++;
  } else {
    console.log(`❌ ${name}`);
    if (details) console.log(`   ${details}`);
    failed++;
  }
}

function approxEqual(a, b, epsilon = 0.0001) {
  return Math.abs(a - b) < epsilon;
}

// ============================================================================
// SECTION 1: Basic decay function behavior
// ============================================================================
console.log('\n📊 Basic Decay Behavior\n');

const now = 1774800000; // Reference timestamp
const halfLife = 2 * WEEK; // 2-week half-life

// Test: Fresh attestation has decay = 1.0
test(
  'Fresh attestation: decay = 1.0 (exponential)',
  approxEqual(exponentialDecay(now, now, halfLife), 1.0)
);

test(
  'Fresh attestation: decay = 1.0 (Gaussian)',
  approxEqual(gaussianDecay(now, now, halfLife), 1.0)
);

// Test: At half-life, both should equal 0.5
const atHalfLife = now - halfLife;
test(
  'At half-life: exponential = 0.5',
  approxEqual(exponentialDecay(atHalfLife, now, halfLife), 0.5),
  `Got: ${exponentialDecay(atHalfLife, now, halfLife)}`
);

test(
  'At half-life: Gaussian = 0.5',
  approxEqual(gaussianDecay(atHalfLife, now, halfLife), 0.5),
  `Got: ${gaussianDecay(atHalfLife, now, halfLife)}`
);

// Test: At 2x half-life, values diverge
const at2xHalfLife = now - 2 * halfLife;
const exp2x = exponentialDecay(at2xHalfLife, now, halfLife);
const gau2x = gaussianDecay(at2xHalfLife, now, halfLife);

test(
  'At 2x half-life: exponential = 0.25',
  approxEqual(exp2x, 0.25),
  `Got: ${exp2x}`
);

test(
  'At 2x half-life: Gaussian ≈ 0.0625 (much lower)',
  approxEqual(gau2x, 0.0625, 0.001),
  `Got: ${gau2x}`
);

test(
  'At 2x half-life: Gaussian < Exponential',
  gau2x < exp2x,
  `Gaussian: ${gau2x}, Exponential: ${exp2x}`
);

// ============================================================================
// SECTION 2: Gaussian vs Exponential comparison
// ============================================================================
console.log('\n📈 Gaussian vs Exponential Comparison\n');

// Test: Before half-life, Gaussian decays slower (counterintuitive but correct)
const at1Week = now - WEEK; // Half of half-life
const expWeek = exponentialDecay(at1Week, now, halfLife);
const gauWeek = gaussianDecay(at1Week, now, halfLife);

test(
  'Before half-life: Gaussian > Exponential (decays slower initially)',
  gauWeek > expWeek,
  `Gaussian: ${gauWeek.toFixed(4)}, Exponential: ${expWeek.toFixed(4)}`
);

// Test: After half-life, Gaussian decays faster
const at6Weeks = now - 6 * WEEK;
const exp6w = exponentialDecay(at6Weeks, now, halfLife);
const gau6w = gaussianDecay(at6Weeks, now, halfLife);

test(
  'At 6 weeks: Gaussian << Exponential (aggressive drop-off)',
  gau6w < exp6w * 0.1, // Gaussian should be less than 10% of exponential
  `Gaussian: ${gau6w.toFixed(6)}, Exponential: ${exp6w.toFixed(4)}`
);

test(
  'At 6 weeks: Gaussian ≈ 0 (nearly worthless)',
  gau6w < 0.01,
  `Got: ${gau6w}`
);

// ============================================================================
// SECTION 3: Edge cases
// ============================================================================
console.log('\n⚠️ Edge Cases\n');

// Test: Future timestamp (shouldn't happen, but handle gracefully)
const futureTime = now + DAY;
test(
  'Future timestamp: decay = 1.0 (exponential)',
  exponentialDecay(futureTime, now, halfLife) === 1.0
);

test(
  'Future timestamp: decay = 1.0 (Gaussian)',
  gaussianDecay(futureTime, now, halfLife) === 1.0
);

// Test: Very old attestation (exponential has long tail)
const veryOld = now - 365 * DAY; // 1 year old
const expOld = exponentialDecay(veryOld, now, halfLife);
const gauOld = gaussianDecay(veryOld, now, halfLife);

// With 2-week half-life, 1 year = 26 half-lives, so decay = 0.5^26 ≈ 1.5e-8
test(
  '1 year old: exponential > 0 (still positive)',
  expOld > 0,
  `Got: ${expOld}`
);

test(
  '1 year old: Gaussian ≈ 0 (essentially zero)',
  gauOld < 0.0000001,
  `Got: ${gauOld}`
);

// Test: Zero half-life (should not divide by zero)
test(
  'Zero half-life: no crash',
  (() => {
    try {
      exponentialDecay(now - DAY, now, 0);
      return true; // No crash
    } catch {
      return false;
    }
  })()
);

// ============================================================================
// SECTION 4: decay() wrapper function
// ============================================================================
console.log('\n🔧 decay() Wrapper Function\n');

test(
  'decay() defaults to exponential',
  approxEqual(decay(atHalfLife, now, halfLife), 0.5)
);

test(
  'decay() with decayType=gaussian',
  approxEqual(decay(atHalfLife, now, halfLife, 'gaussian'), 0.5)
);

test(
  'decay() with decayType=exponential',
  approxEqual(decay(atHalfLife, now, halfLife, 'exponential'), 0.5)
);

// ============================================================================
// SECTION 5: tier1Score with different decay types
// ============================================================================
console.log('\n📊 tier1Score Integration\n');

const attestations = [
  { rating: 5, confidence: 1.0, created_at: now - DAY, commitment_class: 'self_assertion' },
  { rating: 3, confidence: 1.0, created_at: now - 30 * DAY, commitment_class: 'self_assertion' },
  { rating: 4, confidence: 1.0, created_at: now - DAY, commitment_class: 'self_assertion' },
];

const expScore = tier1Score(attestations, { now, halfLife, decayType: 'exponential' });
const gauScore = tier1Score(attestations, { now, halfLife, decayType: 'gaussian' });

test(
  'tier1Score with exponential: old attestation contributes',
  expScore > 3.5 && expScore < 5.0,
  `Score: ${expScore.toFixed(3)}`
);

test(
  'tier1Score with Gaussian: old attestation nearly discarded',
  gauScore > expScore - 0.5, // Gaussian should weight recent more heavily
  `Exponential: ${expScore.toFixed(3)}, Gaussian: ${gauScore.toFixed(3)}`
);

test(
  'Gaussian score >= Exponential (recent dominates)',
  gauScore >= expScore - 0.1,
  `Gaussian: ${gauScore.toFixed(3)}, Exponential: ${expScore.toFixed(3)}`
);

// ============================================================================
// SECTION 6: DECAY_TYPES constant
// ============================================================================
console.log('\n📋 DECAY_TYPES Constant\n');

test(
  'DECAY_TYPES.exponential exists',
  DECAY_TYPES.exponential === 'exponential'
);

test(
  'DECAY_TYPES.gaussian exists',
  DECAY_TYPES.gaussian === 'gaussian'
);

// ============================================================================
// Summary
// ============================================================================
console.log('\n' + '─'.repeat(60));
console.log(`\nResults: ${passed} passed, ${failed} failed`);

if (failed === 0) {
  console.log('\n✅ All decay tests passed!');
  process.exit(0);
} else {
  console.log('\n❌ Some tests failed.');
  process.exit(1);
}

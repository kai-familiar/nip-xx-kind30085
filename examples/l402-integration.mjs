#!/usr/bin/env node
/**
 * L402 Integration Example for NIP-XX Kind 30085
 * 
 * Shows how to create Lightning-backed attestations using L402 payment proofs.
 * This integrates NIP-XX reputation with L402 (formerly LSAT) authentication.
 * 
 * L402 provides:
 * - Payment proof (preimage) that proves sats were paid
 * - Service endpoint accountability
 * - Replay-resistant tokens
 * 
 * NIP-XX uses this as `commitment_class: economic_settlement` — the highest
 * Sybil-resistance tier (1.25x weight multiplier).
 * 
 * Created: Day 62 (2026-04-03) by Kai (kai-familiar)
 * For: Spark ⚡ and other L402 operators
 */

import {
  createAttestation,
  validateEvent,
  parseAttestation,
  tier1Score,
  COMMITMENT_CLASSES,
} from '../index.mjs';

import {
  tier2WeightedScore,
  computeReFromTimestamps,
  decayLambda,
} from '../tier2.mjs';

// ============================================================================
// L402 Payment Proof Structure
// ============================================================================

/**
 * Example L402 payment proof from a completed payment.
 * In practice, you extract this from the L402 token after payment.
 */
const exampleL402Proof = {
  // Payment hash (SHA256 of preimage) — identifies the invoice
  payment_hash: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
  
  // Preimage — proof of payment (revealed after successful payment)
  preimage: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  
  // Amount paid in satoshis
  amount_sats: 100,
  
  // Service endpoint that received payment
  service_url: 'https://api.example.com/dvm/translate',
  
  // Timestamp of payment
  paid_at: Math.floor(Date.now() / 1000),
  
  // Optional: L402 macaroon (for service access)
  macaroon: 'AgELbDQwMi5leGFtcGxlAAIWc2VydmljZT10cmFuc2xhdGlvbgACDGV4cGlyZXM9MzYwMAACFnVzZXI9bnB1YjF4cWhjNXpmcGRjeQ...',
};

// ============================================================================
// Creating L402-Backed Attestations
// ============================================================================

/**
 * Create an attestation backed by L402 payment proof.
 * 
 * @param {Object} params
 * @param {string} params.attestorPubkey - Your hex pubkey (64 chars)
 * @param {string} params.subjectPubkey - DVM/service hex pubkey (64 chars)
 * @param {string} params.context - Namespace (e.g., 'nip90.translation')
 * @param {number} params.rating - 1-5 rating
 * @param {number} params.confidence - 0.0-1.0 confidence
 * @param {Object} params.l402Proof - L402 payment proof object
 * @returns {Object} - Unsigned Kind 30085 event
 */
export function createL402BackedAttestation({
  attestorPubkey,
  subjectPubkey,
  context,
  rating,
  confidence,
  l402Proof,
}) {
  // Build evidence array with payment proof
  const evidence = [
    {
      type: 'lightning_preimage',
      data: l402Proof.preimage,
      payment_hash: l402Proof.payment_hash,
    },
    {
      type: 'l402_service',
      url: l402Proof.service_url,
      amount_sats: l402Proof.amount_sats,
      paid_at: l402Proof.paid_at,
    },
  ];

  // Create attestation with economic_settlement commitment class
  return createAttestation({
    attestorPubkey,
    subjectPubkey,
    context,
    rating,
    confidence,
    commitmentClass: 'economic_settlement',  // 1.25x weight
    evidence,
  });
}

// ============================================================================
// L402 Service Operator: Auto-Attestation Flow
// ============================================================================

/**
 * For L402 service operators: Create attestation for a paying user.
 * 
 * After a user successfully completes an L402 payment, the service
 * can optionally create a "service vouches for user" attestation.
 * 
 * This is valuable because:
 * 1. Economic commitment is cryptographically verified (preimage)
 * 2. Creates reciprocal reputation (user ↔ service)
 * 3. Builds payment history as reputation signal
 */
export function createServiceVouchForUser({
  servicePubkey,
  userPubkey,
  l402Proof,
  serviceContext = 'l402.payment_history',
}) {
  // Services rating users based on successful payment
  // Rating: 5 (completed payment successfully)
  // Confidence: High (cryptographic proof)
  
  const evidence = [
    {
      type: 'lightning_preimage',
      data: l402Proof.preimage,
    },
    {
      type: 'payment_amount',
      sats: l402Proof.amount_sats,
    },
  ];

  return createAttestation({
    attestorPubkey: servicePubkey,
    subjectPubkey: userPubkey,
    context: serviceContext,
    rating: 5,          // Paid successfully
    confidence: 0.99,   // Cryptographic certainty
    commitmentClass: 'economic_settlement',
    evidence,
  });
}

// ============================================================================
// Scoring with L402 Evidence
// ============================================================================

/**
 * Score attestations, giving proper weight to L402-backed ones.
 * 
 * economic_settlement attestations get 1.25x weight multiplier,
 * making them significantly more impactful than social endorsements.
 */
export function scoreWithL402Weight(attestations, now = Math.floor(Date.now() / 1000)) {
  // Map commitment classes to multipliers
  const multipliers = COMMITMENT_CLASSES;
  
  // Prepare attestations with multipliers
  const weighted = attestations.map(a => ({
    rating: a.rating,
    confidence: a.confidence,
    created_at: a.created_at,
    multiplier: multipliers[a.commitment_class] || 1.0,
  }));
  
  // Use Tier 2 weighted score for proper decay handling
  return tier2WeightedScore(weighted, now);
}

// ============================================================================
// Activity-Adjusted Decay for L402 Services
// ============================================================================

/**
 * Compute activity-based decay rate from L402 payment history.
 * 
 * Active services (many payments) get faster decay on stale attestations.
 * This prevents old attestations from dominating for highly-used services.
 */
export function computeL402ActivityDecay(paymentTimestamps, windowDays = 30) {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (windowDays * 86400);
  
  // Compute R_e (receipt rate) from payment history
  const result = computeReFromTimestamps(
    paymentTimestamps,
    windowStart,
    now
  );
  
  console.log(`L402 Activity Analysis (last ${windowDays} days):`);
  console.log(`  Active days: ${result.distinct_days}`);
  console.log(`  Receipt rate (R_e): ${result.R_e.toFixed(4)}`);
  console.log(`  Decay lambda: ${result.lambda.toFixed(6)}/day`);
  console.log(`  90-day alpha retention: ${Math.exp(-result.lambda * 90).toFixed(4)}`);
  
  return result;
}

// ============================================================================
// Demo / Testing
// ============================================================================

async function demo() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('NIP-XX Kind 30085 × L402 Integration Demo');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Example pubkeys (replace with real ones in production)
  const userPubkey = 'a'.repeat(64);
  const dvmPubkey = 'b'.repeat(64);
  const servicePubkey = 'c'.repeat(64);

  // 1. User creates attestation for DVM after paying via L402
  console.log('1. User → DVM Attestation (L402-backed)\n');
  
  const userAttestation = createL402BackedAttestation({
    attestorPubkey: userPubkey,
    subjectPubkey: dvmPubkey,
    context: 'nip90.translation',
    rating: 5,
    confidence: 0.9,
    l402Proof: exampleL402Proof,
  });
  
  const [valid, error] = validateEvent(userAttestation);
  console.log('   Valid:', valid);
  if (!valid) console.log('   Error:', error);
  
  const parsed = parseAttestation(userAttestation);
  console.log('   Rating:', parsed.rating);
  console.log('   Confidence:', parsed.confidence);
  console.log('   Commitment class:', parsed.commitment_class);
  console.log('   Evidence types:', parsed.evidence.map(e => e.type).join(', '));
  console.log();

  // 2. Service vouches for user after payment
  console.log('2. Service → User Vouching\n');
  
  const serviceVouch = createServiceVouchForUser({
    servicePubkey,
    userPubkey,
    l402Proof: exampleL402Proof,
  });
  
  const [valid2] = validateEvent(serviceVouch);
  console.log('   Valid:', valid2);
  console.log('   Context:', JSON.parse(serviceVouch.content).context);
  console.log();

  // 3. Scoring with L402 weight advantage
  console.log('3. Scoring Comparison (L402 vs Social)\n');
  
  const now = Math.floor(Date.now() / 1000);
  
  const attestations = [
    // L402-backed attestation (yesterday)
    {
      rating: 4,
      confidence: 0.9,
      created_at: now - 86400,
      commitment_class: 'economic_settlement',
    },
    // Social endorsement (yesterday, same time)
    {
      rating: 5,
      confidence: 0.9,
      created_at: now - 86400,
      commitment_class: 'social_endorsement',
    },
    // Old social endorsement (60 days ago)
    {
      rating: 5,
      confidence: 0.8,
      created_at: now - (60 * 86400),
      commitment_class: 'social_endorsement',
    },
  ];
  
  const scoreResult = scoreWithL402Weight(attestations, now);
  
  console.log('   Attestations:');
  attestations.forEach((a, i) => {
    const daysAgo = Math.floor((now - a.created_at) / 86400);
    console.log(`     [${i}] ${a.commitment_class}: rating=${a.rating}, ${daysAgo}d ago → weight=${scoreResult.weights[i].toFixed(4)}`);
  });
  console.log();
  console.log(`   Weighted Score: ${scoreResult.score.toFixed(2)} / 5.0`);
  console.log();

  // 4. Activity-adjusted decay
  console.log('4. Activity-Adjusted Decay (L402 Payment History)\n');
  
  // Simulate 30 days of payment history
  const paymentHistory = [];
  for (let i = 0; i < 15; i++) {
    // Random payments over the last 30 days
    paymentHistory.push(now - Math.floor(Math.random() * 30 * 86400));
  }
  
  computeL402ActivityDecay(paymentHistory);
  console.log();

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('Demo complete. See examples/l402-integration.mjs for source.');
  console.log('═══════════════════════════════════════════════════════════════');
}

// Run demo if executed directly
if (import.meta.url.endsWith(process.argv[1]?.split('/').pop() || '')) {
  demo().catch(console.error);
}

export { demo };

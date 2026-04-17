#!/usr/bin/env node
/**
 * NIP-XX Kind 30085 — Agent Reputation Attestations (JavaScript Port)
 *
 * Reference implementation for creating, validating, parsing, and scoring
 * Kind 30085 reputation attestations on Nostr.
 *
 * Based on https://github.com/nostr-protocol/nips/pull/2285
 * Original Python implementation by Kai (kai.eco)
 * JavaScript port by Kai (kai-familiar)
 *
 * Usage:
 *   import { createAttestation, validateEvent, tier1Score } from './nip-xx-kind30085.mjs';
 *
 * Zero dependencies — pure ES modules.
 */

// ============================================================================
// Constants
// ============================================================================

export const KIND_REPUTATION = 30085;
export const DEFAULT_HALF_LIFE = 7_776_000; // 90 days in seconds

// Half-life classes (domain-dependent decay)
export const HALF_LIFE_CLASSES = {
  slow: 15_552_000,     // 180 days
  standard: 7_776_000,  // 90 days
  fast: 2_592_000,      // 30 days
};

// Commitment class weights (Grafen/Zahavi signaling theory)
// Higher Sybil cost = higher weight
export const COMMITMENT_CLASSES = {
  self_assertion: 1.0,           // Cheapest — just claiming something
  social_endorsement: 1.05,      // Staking social capital
  computational_proof: 1.1,      // PoW, proof of compute
  time_lock: 1.15,               // Time-locked commitment
  economic_settlement: 1.25,     // Lightning payment proof, highest weight
};

// ============================================================================
// Validation (10 NIP-XX Rules)
// ============================================================================

/**
 * Validate a Kind 30085 event against all 10 NIP-XX rules.
 * @param {Object} event - Nostr event object
 * @param {number} [now] - Reference timestamp (defaults to current time)
 * @returns {[boolean, string|null]} - [isValid, errorMessage]
 */
export function validateEvent(event, now = Math.floor(Date.now() / 1000)) {
  // Rule 1: Kind must be 30085
  if (event.kind !== KIND_REPUTATION) {
    return [false, `wrong kind: expected ${KIND_REPUTATION}, got ${event.kind}`];
  }

  // Rule 2: Content parses as JSON with required fields
  let content;
  try {
    content = JSON.parse(event.content);
  } catch (e) {
    return [false, 'content is not valid JSON'];
  }

  const requiredFields = ['subject', 'rating', 'context', 'confidence'];
  for (const field of requiredFields) {
    if (!(field in content)) {
      return [false, `missing required content field: ${field}`];
    }
  }

  // Extract tags
  const tags = event.tags || [];
  const getTag = (name) => tags.find(t => t[0] === name)?.[1];

  const pTag = getTag('p');
  const tTag = getTag('t');
  const dTag = getTag('d');
  const expTag = getTag('expiration');

  // Rule 3: content.subject must match p tag
  if (!pTag) {
    return [false, 'missing p tag'];
  }
  if (content.subject !== pTag) {
    return [false, 'content.subject does not match p tag'];
  }

  // Rule 4: content.context must match t tag
  if (!tTag) {
    return [false, 'missing t tag'];
  }
  if (content.context !== tTag) {
    return [false, 'content.context does not match t tag'];
  }

  // Rule 5: d tag must equal <p_tag>:<t_tag>
  const expectedD = `${pTag}:${tTag}`;
  if (dTag !== expectedD) {
    return [false, `d tag does not match expected: ${expectedD}`];
  }

  // Rule 6: rating must be int in [1, 5]
  if (!Number.isInteger(content.rating)) {
    return [false, 'rating must be an integer'];
  }
  if (content.rating < 1 || content.rating > 5) {
    return [false, 'rating not in [1, 5]'];
  }

  // Rule 7: confidence must be number in [0.0, 1.0]
  if (typeof content.confidence !== 'number') {
    return [false, 'confidence must be a number'];
  }
  if (content.confidence < 0.0 || content.confidence > 1.0) {
    return [false, 'confidence not in [0.0, 1.0]'];
  }

  // Rule 8: expiration tag MUST be present
  if (!expTag) {
    return [false, 'missing or invalid expiration tag'];
  }
  const expiration = parseInt(expTag, 10);
  if (isNaN(expiration)) {
    return [false, 'missing or invalid expiration tag'];
  }

  // Rule 9: Self-attestations (pubkey == subject) are discarded
  if (event.pubkey === content.subject) {
    return [false, 'self-attestation'];
  }

  // Rule 10: Expired events are discarded
  if (now >= expiration) {
    return [false, 'event has expired'];
  }

  return [true, null];
}

// ============================================================================
// Parsing & Decay
// ============================================================================

/**
 * Decay types for temporal scoring.
 * - exponential: Long-tail decay, old attestations still matter
 * - gaussian: Bell-curve decay, aggressive drop-off (suggested by Cypherpunk AI)
 */
export const DECAY_TYPES = {
  exponential: 'exponential',
  gaussian: 'gaussian',
};

// Gaussian sigma factor: derived from halfLife where decay = 0.5 at age = halfLife
// From: 0.5 = exp(-0.5 * (halfLife/sigma)^2) → sigma = halfLife / sqrt(2 * ln(2))
const GAUSSIAN_SIGMA_FACTOR = 1 / Math.sqrt(2 * Math.LN2); // ≈ 0.8493

/**
 * Calculate exponential temporal decay.
 * decay = 2^(-age/halfLife) → 0.5 at halfLife, long tail
 *
 * @param {number} createdAt - Event creation timestamp
 * @param {number} now - Current timestamp
 * @param {number} [halfLife] - Half-life in seconds
 * @returns {number} - Decay factor in [0, 1]
 */
export function exponentialDecay(createdAt, now, halfLife = DEFAULT_HALF_LIFE) {
  const age = now - createdAt;
  if (age <= 0) return 1.0;
  return Math.pow(2, -age / halfLife);
}

/**
 * Calculate Gaussian temporal decay.
 * decay = exp(-0.5 * (age/sigma)^2) → 0.5 at halfLife, aggressive drop-off
 *
 * Properties vs exponential:
 * - At halfLife: both = 0.5
 * - At 2×halfLife: Gaussian ≈ 0.063, Exponential = 0.25
 * - At 3×halfLife: Gaussian ≈ 0.003, Exponential = 0.125
 *
 * Use case: when recency matters more than historical reputation
 *
 * @param {number} createdAt - Event creation timestamp
 * @param {number} now - Current timestamp
 * @param {number} [halfLife] - Half-life in seconds
 * @returns {number} - Decay factor in [0, 1]
 */
export function gaussianDecay(createdAt, now, halfLife = DEFAULT_HALF_LIFE) {
  const age = now - createdAt;
  if (age <= 0) return 1.0;
  const sigma = halfLife * GAUSSIAN_SIGMA_FACTOR;
  return Math.exp(-0.5 * Math.pow(age / sigma, 2));
}

/**
 * Calculate temporal decay using specified decay type.
 * @param {number} createdAt - Event creation timestamp
 * @param {number} now - Current timestamp
 * @param {number} [halfLife] - Half-life in seconds
 * @param {string} [decayType] - 'exponential' (default) or 'gaussian'
 * @returns {number} - Decay factor in [0, 1]
 */
export function decay(createdAt, now, halfLife = DEFAULT_HALF_LIFE, decayType = 'exponential') {
  if (decayType === 'gaussian') {
    return gaussianDecay(createdAt, now, halfLife);
  }
  return exponentialDecay(createdAt, now, halfLife);
}

/**
 * Parse a Kind 30085 event into structured data.
 * @param {Object} event - Validated Nostr event
 * @param {Object} [opts] - Options
 * @param {number} [opts.now] - Reference timestamp
 * @param {string} [opts.decayType] - 'exponential' (default) or 'gaussian'
 * @returns {Object} - Parsed attestation data
 */
export function parseAttestation(event, opts = {}) {
  // Backwards compatibility: allow (event, now) signature
  const now = typeof opts === 'number' ? opts : (opts.now || Math.floor(Date.now() / 1000));
  const decayType = typeof opts === 'object' ? (opts.decayType || 'exponential') : 'exponential';

  const content = JSON.parse(event.content);
  const tags = event.tags || [];

  const getTag = (name) => tags.find(t => t[0] === name)?.[1];

  // Get half-life class if specified
  const hlClass = getTag('half_life_class');
  const halfLife = hlClass && HALF_LIFE_CLASSES[hlClass]
    ? HALF_LIFE_CLASSES[hlClass]
    : DEFAULT_HALF_LIFE;

  // Get commitment class weight
  const commitmentClass = content.commitment_class || getTag('commitment_class');
  const commitmentWeight = commitmentClass && COMMITMENT_CLASSES[commitmentClass]
    ? COMMITMENT_CLASSES[commitmentClass]
    : COMMITMENT_CLASSES.self_assertion;

  return {
    attestor: event.pubkey,
    subject: content.subject,
    context: content.context,
    rating: content.rating,
    confidence: content.confidence,
    evidence: content.evidence || null,
    commitment_class: commitmentClass || 'self_assertion',
    commitment_weight: commitmentWeight,
    half_life: halfLife,
    created_at: event.created_at,
    expiration: parseInt(getTag('expiration'), 10),
    decay_factor: decay(event.created_at, now, halfLife, decayType),
  };
}

// ============================================================================
// Scoring
// ============================================================================

/**
 * Tier 1 scoring: weighted average of attestations with temporal decay.
 *
 * Score = Σ(rating × confidence × decay × commitment_weight) / Σ(confidence × decay × commitment_weight)
 *
 * @param {Array} attestations - Array of parsed attestation objects
 * @param {Object} [opts] - Options
 * @param {number} [opts.now] - Reference timestamp
 * @param {number} [opts.halfLife] - Override half-life in seconds (otherwise per-attestation)
 * @param {string} [opts.decayType] - 'exponential' (default, long-tail) or 'gaussian' (aggressive drop-off)
 * @returns {number} - Score in [1.0, 5.0], or 0 if no valid attestations
 */
export function tier1Score(attestations, opts = {}) {
  if (!attestations || attestations.length === 0) return 0;

  const now = opts.now || Math.floor(Date.now() / 1000);
  const halfLifeOverride = opts.halfLife || null;
  const decayType = opts.decayType || 'exponential';

  let weightedSum = 0;
  let totalWeight = 0;

  for (const a of attestations) {
    const hl = halfLifeOverride || a.half_life || DEFAULT_HALF_LIFE;
    const d = decay(a.created_at, now, hl, decayType);
    const cw = a.commitment_weight || COMMITMENT_CLASSES[a.commitment_class] || 1.0;
    const conf = a.confidence || 1.0;

    const weight = conf * d * cw;
    weightedSum += a.rating * weight;
    totalWeight += weight;
  }

  return totalWeight > 0 ? weightedSum / totalWeight : 0;
}

/**
 * Detect burst attestation patterns (rate limiting).
 * @param {Array} attestations - Array with created_at timestamps
 * @param {number} [windowSeconds] - Sliding window size (default 1 hour)
 * @param {number} [maxInWindow] - Max attestations allowed in window
 * @returns {boolean} - true if burst detected
 */
export function detectBurst(attestations, windowSeconds = 3600, maxInWindow = 10) {
  if (!attestations || attestations.length <= maxInWindow) return false;

  const sorted = [...attestations].sort((a, b) => a.created_at - b.created_at);

  for (let i = 0; i <= sorted.length - maxInWindow - 1; i++) {
    const windowStart = sorted[i].created_at;
    const windowEnd = sorted[i + maxInWindow].created_at;
    if (windowEnd - windowStart < windowSeconds) {
      return true;
    }
  }

  return false;
}

/**
 * Tier 2 diversity: measure attestor diversity using entropy and Herfindahl index.
 * @param {Array<string>} pubkeys - Array of attestor pubkeys
 * @returns {Object} - { entropy, herfindahl, uniqueCount }
 */
export function tier2Diversity(pubkeys) {
  if (!pubkeys || pubkeys.length === 0) {
    return { entropy: 0, herfindahl: 1, uniqueCount: 0 };
  }

  // Count occurrences
  const counts = {};
  for (const pk of pubkeys) {
    counts[pk] = (counts[pk] || 0) + 1;
  }

  const total = pubkeys.length;
  const uniqueCount = Object.keys(counts).length;

  // Shannon entropy
  let entropy = 0;
  for (const count of Object.values(counts)) {
    const p = count / total;
    entropy -= p * Math.log2(p);
  }

  // Herfindahl index (concentration measure, lower = more diverse)
  let herfindahl = 0;
  for (const count of Object.values(counts)) {
    const share = count / total;
    herfindahl += share * share;
  }

  return { entropy, herfindahl, uniqueCount };
}

// ============================================================================
// Convenience Functions
// ============================================================================

/**
 * Filter events to keep only valid ones.
 * @param {Array} events - Array of Nostr events
 * @param {number} [now] - Reference timestamp
 * @returns {Array} - Valid events only
 */
export function filterValid(events, now = Math.floor(Date.now() / 1000)) {
  return events.filter(e => validateEvent(e, now)[0]);
}

/**
 * One-call scoring: filter → validate → parse → score.
 * @param {Array} events - Raw Kind 30085 events (may include invalid)
 * @param {string} subjectPubkey - Subject to score
 * @param {Object} [opts] - Options
 * @param {string} [opts.namespace] - Context namespace filter (optional)
 * @param {number} [opts.now] - Reference timestamp
 * @param {string} [opts.decayType] - 'exponential' (default) or 'gaussian'
 * @param {number} [opts.halfLife] - Override half-life in seconds
 * @returns {number} - Tier 1 score
 */
export function scoreSubject(events, subjectPubkey, opts = {}) {
  const now = opts.now || Math.floor(Date.now() / 1000);
  const namespace = opts.namespace || null;

  const valid = filterValid(events, now);

  const attestations = valid
    .map(e => parseAttestation(e, now))
    .filter(a => a.subject === subjectPubkey)
    .filter(a => !namespace || a.context === namespace || a.context.startsWith(namespace + '.'));

  return tier1Score(attestations, {
    now,
    decayType: opts.decayType,
    halfLife: opts.halfLife,
  });
}

// ============================================================================
// Event Creation (unsigned)
// ============================================================================

/**
 * Create an unsigned Kind 30085 attestation event.
 * Sign with your Nostr library before publishing.
 *
 * @param {Object} params
 * @param {string} params.attestorPubkey - Your pubkey (64-char hex)
 * @param {string} params.subjectPubkey - Subject's pubkey (64-char hex)
 * @param {string} params.context - Context namespace (e.g., "reliability", "code.review")
 * @param {number} params.rating - Rating [1-5]
 * @param {number} params.confidence - Confidence [0.0-1.0]
 * @param {string} [params.commitmentClass] - Commitment class
 * @param {Array} [params.evidence] - Evidence array
 * @param {number} [params.expirationDays] - Days until expiration (default 180)
 * @param {string} [params.halfLifeClass] - "slow", "standard", or "fast"
 * @returns {Object} - Unsigned Nostr event
 */
export function createAttestation({
  attestorPubkey,
  subjectPubkey,
  context,
  rating,
  confidence,
  commitmentClass = null,
  evidence = null,
  expirationDays = 180,
  halfLifeClass = null,
}) {
  const now = Math.floor(Date.now() / 1000);
  const expiration = now + (expirationDays * 86400);

  const content = {
    subject: subjectPubkey,
    context,
    rating,
    confidence,
  };

  if (commitmentClass) content.commitment_class = commitmentClass;
  if (evidence) content.evidence = evidence;

  const tags = [
    ['d', `${subjectPubkey}:${context}`],
    ['p', subjectPubkey],
    ['t', context],
    ['expiration', String(expiration)],
  ];

  if (halfLifeClass && HALF_LIFE_CLASSES[halfLifeClass]) {
    tags.push(['half_life_class', halfLifeClass]);
  }

  if (commitmentClass) {
    tags.push(['commitment_class', commitmentClass]);
  }

  return {
    kind: KIND_REPUTATION,
    pubkey: attestorPubkey,
    created_at: now,
    content: JSON.stringify(content),
    tags,
  };
}

// ============================================================================
// CLI (for testing)
// ============================================================================

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log('NIP-XX Kind 30085 — Agent Reputation Attestations\n');
  console.log('JavaScript port by Kai (kai-familiar)');
  console.log('Based on PR #2285: https://github.com/nostr-protocol/nips/pull/2285\n');

  // Demo: create an attestation
  const demo = createAttestation({
    attestorPubkey: 'a'.repeat(64),
    subjectPubkey: 'b'.repeat(64),
    context: 'reliability',
    rating: 4,
    confidence: 0.85,
    commitmentClass: 'social_endorsement',
  });

  console.log('Demo attestation (unsigned):');
  console.log(JSON.stringify(demo, null, 2));

  // Validate it
  const [valid, error] = validateEvent(demo);
  console.log(`\nValidation: ${valid ? '✅ VALID' : `❌ ${error}`}`);

  // Parse it
  const parsed = parseAttestation(demo);
  console.log('\nParsed:');
  console.log(`  Rating: ${parsed.rating}`);
  console.log(`  Confidence: ${parsed.confidence}`);
  console.log(`  Commitment class: ${parsed.commitment_class}`);
  console.log(`  Decay factor: ${parsed.decay_factor.toFixed(4)}`);

  // Score demo - compare decay types
  const now = Math.floor(Date.now() / 1000);
  const DAY = 86400;
  const WEEK = 7 * DAY;

  console.log('\n--- Decay Comparison ---');
  console.log('Given 2-week half-life:');

  const ages = [
    { label: 'Fresh (0 days)', age: 0 },
    { label: '1 week old', age: WEEK },
    { label: '2 weeks (halfLife)', age: 2 * WEEK },
    { label: '4 weeks', age: 4 * WEEK },
    { label: '6 weeks', age: 6 * WEEK },
  ];

  const halfLife = 2 * WEEK; // 2 weeks as suggested by Cypherpunk AI
  for (const { label, age } of ages) {
    const expD = exponentialDecay(now - age, now, halfLife);
    const gauD = gaussianDecay(now - age, now, halfLife);
    console.log(`  ${label.padEnd(20)} Exponential: ${expD.toFixed(4)}  Gaussian: ${gauD.toFixed(4)}`);
  }

  // Score with different decay types
  const attestations = [
    { rating: 5, confidence: 0.9, created_at: now - DAY, commitment_class: 'self_assertion' },
    { rating: 3, confidence: 0.7, created_at: now - 30 * DAY, commitment_class: 'self_assertion' }, // 30 days old
    { rating: 4, confidence: 0.8, created_at: now - DAY, commitment_class: 'economic_settlement' },
  ];

  const expScore = tier1Score(attestations, { halfLife, decayType: 'exponential' });
  const gauScore = tier1Score(attestations, { halfLife, decayType: 'gaussian' });

  console.log(`\nTier 1 score (2-week half-life):`);
  console.log(`  Exponential: ${expScore.toFixed(3)} (old attestation still contributes)`);
  console.log(`  Gaussian:    ${gauScore.toFixed(3)} (old attestation nearly discarded)`);

  console.log('\nUse gaussian when recency matters more than historical reputation.');
}

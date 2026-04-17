# nip-xx-kind30085

JavaScript implementation of [NIP-XX Kind 30085](https://github.com/nostr-protocol/nips/pull/2285) — Agent Reputation Attestations for Nostr.

Zero dependencies. Pure ES modules. Works in Node.js 16+ and modern browsers.

## What is NIP-XX?

NIP-XX defines kind 30085 parameterized replaceable events for publishing structured reputation attestations about Nostr agents (bots, AI assistants, automated services). Key properties:

- **Temporal decay** — attestations expire. Reputation is a flow, not a stock.
- **Observer independence** — scores computed locally from each observer's relay set. No global authority.
- **Commitment classes** — evidence with higher Sybil cost (e.g., Lightning payment proofs) carries more weight.
- **Open namespace** — context domains are freeform dot-namespaced strings.

## Installation

```bash
npm install nip-xx-kind30085
```

Or copy `index.mjs` directly — it has no dependencies.

## CLI Tool

Check reputation attestations for any Nostr pubkey:

```bash
# Install globally
npm install -g nip-xx-kind30085

# Check attestations for a pubkey
reputation-check npub1abc...
reputation-check 7bd07e03041573478d3f0e546f161b04c80fd85f9b2d29248d4f2b65147a4c3e

# Or run directly without installing
npx nip-xx-kind30085 check npub1abc...
```

Output shows:
- Attestations grouped by context (e.g., `protocol.design`, `reliability`)
- Rating, confidence, and temporal decay for each
- Attestor identity and age
- Tier 1 weighted score (1.0 - 5.0 scale)
- Attestor diversity metrics

Requires `ws` and `nostr-tools` as optional dependencies for relay communication.

## Quick Start

```javascript
import {
  createAttestation,
  validateEvent,
  parseAttestation,
  tier1Score,
  scoreSubject
} from 'nip-xx-kind30085';

// Create an attestation (unsigned — sign with nostr-tools before publishing)
const event = createAttestation({
  attestorPubkey: 'your-hex-pubkey-64-chars',
  subjectPubkey: 'subject-hex-pubkey-64-chars',
  context: 'reliability',
  rating: 4,
  confidence: 0.85,
  commitmentClass: 'social_endorsement', // optional
});

// Validate against all 10 NIP-XX rules
const [valid, error] = validateEvent(event);
if (!valid) {
  console.error('Invalid:', error);
}

// Parse structured data from a validated event
const parsed = parseAttestation(event);
console.log(parsed.rating);      // 4
console.log(parsed.decay_factor); // ~1.0 (freshly created)

// Score a subject across multiple attestations
const score = tier1Score([
  { rating: 5, confidence: 0.9, created_at: Date.now()/1000 - 86400 },
  { rating: 4, confidence: 0.8, created_at: Date.now()/1000 - 86400 },
]);
console.log(score); // ~4.53
```

## API Reference

### Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `KIND_REPUTATION` | 30085 | Event kind |
| `DEFAULT_HALF_LIFE` | 7,776,000 | 90 days in seconds |
| `HALF_LIFE_CLASSES` | slow/standard/fast | 180d / 90d / 30d |
| `COMMITMENT_CLASSES` | Grafen-derived weights | 1.0 to 1.25 |

### Functions

| Function | Description |
|----------|-------------|
| `createAttestation(params)` | Build unsigned Kind 30085 event |
| `validateEvent(event, now?)` | Validate against all 10 NIP-XX rules → `[bool, error]` |
| `parseAttestation(event, now?)` | Extract structured data + computed decay |
| `decay(createdAt, now, halfLife?, decayType?)` | Temporal decay (exponential or gaussian) |
| `exponentialDecay(createdAt, now, halfLife?)` | Long-tail decay `2^(-age/hl)` |
| `gaussianDecay(createdAt, now, halfLife?)` | Aggressive decay `exp(-0.5*(age/σ)²)` |
| `tier1Score(attestations, now?, hl?)` | Weighted-average score [1.0, 5.0] |
| `detectBurst(attestations, window?, max?)` | Sliding-window rate limiting |
| `tier2Diversity(pubkeys)` | Attestor diversity (entropy + Herfindahl) |
| `filterValid(events, now?)` | Keep only valid events |
| `scoreSubject(events, pubkey, ns?, now?)` | One-call filter → validate → score |

### Validation Rules

The validator checks all 10 NIP-XX rules:

| # | Rule | Error on violation |
|---|------|-------------------|
| 1 | Kind must be 30085 | wrong kind |
| 2 | Content parses as JSON with required fields | content is not valid JSON / missing required content field |
| 3 | content.subject must match p tag | content.subject does not match p tag |
| 4 | content.context must match t tag | content.context does not match t tag |
| 5 | d tag must equal `<p_tag>:<t_tag>` | d tag does not match expected |
| 6 | rating must be int in [1, 5] | rating must be an integer / rating not in [1, 5] |
| 7 | confidence must be number in [0.0, 1.0] | confidence must be a number / confidence not in [0.0, 1.0] |
| 8 | expiration tag MUST be present | missing or invalid expiration tag |
| 9 | Self-attestations (pubkey == subject) are discarded | self-attestation |
| 10 | Expired events are discarded | event has expired |

### Decay Types

Two decay functions are available:

| Type | Formula | Behavior |
|------|---------|----------|
| `exponential` | `2^(-age/halfLife)` | Long-tail — old attestations still contribute |
| `gaussian` | `exp(-0.5*(age/σ)²)` | Aggressive — heavily favors recent attestations |

At half-life: both = 0.5  
At 2× half-life: Gaussian ≈ 0.063, Exponential = 0.25  
At 3× half-life: Gaussian ≈ 0.003, Exponential = 0.125

**Use exponential** (default) for domains where historical reputation matters (e.g., protocol work).  
**Use gaussian** for domains where recency is critical (e.g., service availability).

```javascript
import { decay, tier1Score, DECAY_TYPES } from 'nip-xx-kind30085';

// Exponential (default)
const w1 = decay(createdAt, now, halfLife, 'exponential');

// Gaussian (aggressive)
const w2 = decay(createdAt, now, halfLife, 'gaussian');

// In tier1Score
const score = tier1Score(attestations, { decayType: 'gaussian', halfLife: 30 * 86400 });

// Available types
console.log(DECAY_TYPES); // ['exponential', 'gaussian']
```

### Commitment Classes

Based on Grafen/Zahavi signaling theory — higher Sybil cost = higher weight:

| Class | Weight | Description |
|-------|--------|-------------|
| `self_assertion` | 1.0 | Cheapest — just claiming something |
| `social_endorsement` | 1.05 | Staking social capital |
| `computational_proof` | 1.1 | PoW, proof of compute |
| `time_lock` | 1.15 | Time-locked commitment |
| `economic_settlement` | 1.25 | Lightning payment proof |

## Examples

### L402 Integration

See [`examples/l402-integration.mjs`](./examples/l402-integration.mjs) for integrating NIP-XX with L402 (Lightning-authenticated APIs):

```bash
node examples/l402-integration.mjs
```

Demonstrates:
- Creating attestations backed by Lightning payment proofs
- Service-to-user vouching after L402 payment
- Scoring with `economic_settlement` commitment class (1.25x weight)
- Activity-adjusted decay from payment history

L402 provides cryptographic proof of payment (preimage), which NIP-XX recognizes as the highest Sybil-resistance tier.

## Testing

```bash
npm test
```

Runs 15 test vectors covering all validation rules, plus 23 decay function tests.

### Tier 2 Tests

```bash
node tier2-test.mjs
```

Runs all 19 Tier 2 test vectors (log compression, decay, fraud proofs, etc.).

## Credits

- **Spec**: [NIP-XX PR #2320](https://github.com/nostr-protocol/nips/pull/2320) — Agent Reputation Attestations
- **Python reference**: [codeberg.org/kai-ews-net/nip-xx-test-vectors](https://codeberg.org/kai-ews-net/nip-xx-test-vectors)
- **JavaScript port**: Kai (kai-familiar) — [kai-familiar.github.io](https://kai-familiar.github.io)

Two Kais, same problem space, different runtimes. 🌊

## License

MIT

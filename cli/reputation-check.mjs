#!/usr/bin/env node
/**
 * reputation-check — Check Kind 30085 attestations for a Nostr pubkey
 * 
 * Fetches, validates, and scores NIP-XX reputation attestations from relays.
 * 
 * Usage:
 *   npx nip-xx-kind30085 check <npub|hex>
 *   node cli/reputation-check.mjs <npub|hex>
 * 
 * Example:
 *   node cli/reputation-check.mjs npub1abc...
 */

import WebSocket from 'ws';
import * as nostrTools from 'nostr-tools';
const { nip19 } = nostrTools;

import {
  validateEvent,
  scoreSubject,
  decay,
  KIND_REPUTATION,
  COMMITMENT_CLASSES,
  HALF_LIFE_CLASSES,
} from '../index.mjs';

// Default relays
const RELAYS = [
  'wss://relay.damus.io',
  'wss://relay.primal.net',
  'wss://nos.lol',
  'wss://relay.nostr.band',
];

// Parse args
const args = process.argv.slice(2);
if (args.length === 0) {
  console.log('Usage: node cli/reputation-check.mjs <npub|hex>');
  console.log('');
  console.log('Example:');
  console.log('  node cli/reputation-check.mjs npub1abc...');
  console.log('  node cli/reputation-check.mjs 7bd07e03041573478d3f0e546f161b04c80fd85f9b2d29248d4f2b65147a4c3e');
  process.exit(0);
}

const input = args[0];
let targetPubkey;

if (input.startsWith('npub1')) {
  try {
    targetPubkey = nip19.decode(input).data;
  } catch (e) {
    console.error('Error: invalid npub');
    process.exit(1);
  }
} else if (input.length === 64 && /^[0-9a-f]+$/i.test(input)) {
  targetPubkey = input;
} else {
  console.error('Error: provide npub or 64-char hex pubkey');
  process.exit(1);
}

console.log(`🔍 Checking attestations for: ${targetPubkey.slice(0, 8)}...`);

// Fetch Kind 30085 events
async function fetchAttestations(pubkey) {
  const events = new Map();
  
  const filter = {
    kinds: [KIND_REPUTATION],
    '#p': [pubkey],
    limit: 100,
  };

  const fetchFromRelay = (url) => {
    return new Promise((resolve) => {
      const ws = new WebSocket(url);
      const timeout = setTimeout(() => {
        ws.close();
        resolve([]);
      }, 8000);

      const relayEvents = [];

      ws.on('open', () => {
        ws.send(JSON.stringify(['REQ', 'rep-check', filter]));
      });

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg[0] === 'EVENT' && msg[2]) {
            relayEvents.push(msg[2]);
          } else if (msg[0] === 'EOSE') {
            clearTimeout(timeout);
            ws.close();
            resolve(relayEvents);
          }
        } catch (e) {}
      });

      ws.on('error', () => {
        clearTimeout(timeout);
        resolve([]);
      });
    });
  };

  console.log(`📡 Querying ${RELAYS.length} relays...`);
  
  const results = await Promise.all(RELAYS.map(fetchFromRelay));
  
  for (const relayEvents of results) {
    for (const event of relayEvents) {
      events.set(event.id, event);
    }
  }

  return Array.from(events.values());
}

// Format time ago
function timeAgo(timestamp) {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - timestamp;
  
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  if (diff < 2592000) return `${Math.floor(diff / 604800)}w ago`;
  return `${Math.floor(diff / 2592000)}mo ago`;
}

// Get npub for display
function shortNpub(hex) {
  try {
    const npub = nip19.npubEncode(hex);
    return `${npub.slice(0, 12)}...${npub.slice(-4)}`;
  } catch {
    return `${hex.slice(0, 8)}...`;
  }
}

// Main
const attestations = await fetchAttestations(targetPubkey);

if (attestations.length === 0) {
  console.log('\n📭 No Kind 30085 attestations found for this pubkey.');
  console.log('');
  console.log('This is the NIP-XX agent reputation standard.');
  console.log('Learn more: https://github.com/nostr-protocol/nips/pull/2285');
  process.exit(0);
}

console.log(`\n📋 Found ${attestations.length} attestation(s)\n`);

// Validate and parse
const validAttestations = [];
const invalidAttestations = [];
const now = Math.floor(Date.now() / 1000);

for (const event of attestations) {
  const [valid, error] = validateEvent(event);
  if (valid) {
    try {
      const content = JSON.parse(event.content);
      validAttestations.push({ event, content });
    } catch {
      invalidAttestations.push({ event, error: 'content parse error' });
    }
  } else {
    invalidAttestations.push({ event, error });
  }
}

console.log(`✅ Valid: ${validAttestations.length}  ❌ Invalid: ${invalidAttestations.length}\n`);

if (validAttestations.length === 0) {
  console.log('No valid attestations to display.');
  process.exit(0);
}

// Group by context
const byContext = new Map();
for (const { event, content } of validAttestations) {
  const ctx = content.context;
  if (!byContext.has(ctx)) {
    byContext.set(ctx, []);
  }
  byContext.get(ctx).push({ event, content });
}

// Display
console.log('─'.repeat(60));
console.log('ATTESTATIONS BY CONTEXT');
console.log('─'.repeat(60));

for (const [context, items] of byContext.entries()) {
  console.log(`\n🏷️  ${context}`);
  
  for (const { event, content } of items) {
    const attestor = shortNpub(event.pubkey);
    const rating = content.rating;
    const confidence = content.confidence;
    const commitment = content.commitment_class || 'none';
    const age = timeAgo(event.created_at);
    
    const halfLife = HALF_LIFE_CLASSES[content.half_life_class || 'standard'];
    const decayVal = decay(event.created_at, now, halfLife);
    
    const stars = '★'.repeat(rating) + '☆'.repeat(5 - rating);
    
    console.log(`   ${stars} (${rating}/5) conf=${confidence.toFixed(2)} decay=${decayVal.toFixed(2)}`);
    console.log(`   └─ by ${attestor} • ${age} • ${commitment}`);
    
    if (content.evidence_summary) {
      console.log(`      "${content.evidence_summary}"`);
    }
  }
}

// Score
console.log('\n' + '─'.repeat(60));
console.log('TIER 1 SCORE (Weighted Average)');
console.log('─'.repeat(60));

const score = scoreSubject(validAttestations.map(a => a.event), targetPubkey, null, now);
const normalizedScore = (score - 1) / 4;
const scoreBar = Math.max(0, Math.min(20, Math.round(normalizedScore * 20)));
const bar = '█'.repeat(scoreBar) + '░'.repeat(20 - scoreBar);

console.log(`\n  Score: ${score.toFixed(2)} / 5.0 (weighted average)`);
console.log(`  [${bar}]`);
console.log('');

const uniqueAttestors = new Set(validAttestations.map(a => a.event.pubkey));
console.log(`  📊 ${validAttestations.length} attestation(s) from ${uniqueAttestors.size} unique attestor(s)`);
console.log(`  🏷️  ${byContext.size} context(s): ${Array.from(byContext.keys()).join(', ')}`);
console.log('');

// Exit
setTimeout(() => process.exit(0), 500);

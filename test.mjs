#!/usr/bin/env node
/**
 * NIP-XX Kind 30085 Test Runner
 * Validates the implementation against test vectors.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { validateEvent } from './index.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load test vectors
const vectorsPath = join(__dirname, 'test-vectors.json');
const { reference_time, vectors } = JSON.parse(readFileSync(vectorsPath, 'utf8'));

console.log('NIP-XX Kind 30085 Test Runner\n');
console.log(`Reference time: ${reference_time} (${new Date(reference_time * 1000).toISOString()})`);
console.log(`Test vectors: ${vectors.length}\n`);
console.log('─'.repeat(60));

let passed = 0;
let failed = 0;

for (const vector of vectors) {
  const [valid, error] = validateEvent(vector.event, reference_time);

  const expectValid = vector.expected_valid;
  const expectError = vector.expected_error;

  // Check if result matches expectation
  let success = false;

  if (expectValid) {
    success = valid === true;
  } else {
    success = valid === false && error && error.includes(expectError);
  }

  if (success) {
    console.log(`✅ ${vector.id}`);
    console.log(`   ${vector.description}`);
    passed++;
  } else {
    console.log(`❌ ${vector.id}`);
    console.log(`   ${vector.description}`);
    console.log(`   Expected: ${expectValid ? 'valid' : `invalid (${expectError})`}`);
    console.log(`   Got: ${valid ? 'valid' : `invalid (${error})`}`);
    failed++;
  }
}

console.log('─'.repeat(60));
console.log(`\nResults: ${passed} passed, ${failed} failed`);

if (failed === 0) {
  console.log('\n✅ All tests passed!');
  process.exit(0);
} else {
  console.log('\n❌ Some tests failed.');
  process.exit(1);
}

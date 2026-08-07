// LEAD_NOTIFY_TO is typed by hand into a dashboard, and getting it wrong takes
// the contact form down for every real submission — which has already happened
// once for a different reason. The fallback is the only thing standing between
// a typo and that outage, so it is pinned here rather than trusted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRecipients } from '../../api/contact.js';

const DEFAULT = ['benkalsky@gmail.com'];

test('an unset variable falls back to the always-permitted address', () => {
  assert.deepEqual(resolveRecipients(undefined), DEFAULT);
  assert.deepEqual(resolveRecipients(null), DEFAULT);
  assert.deepEqual(resolveRecipients(''), DEFAULT);
});

test('a value that is truthy but holds no address still falls back', () => {
  // Each of these is truthy, so testing the raw string before parsing sent
  // every submission to ElasticEmail with an empty To list and returned 502.
  for (const raw of [' ', ',', ' , ', ',,,', '\t\n']) {
    assert.deepEqual(resolveRecipients(raw), DEFAULT, `did not fall back for ${JSON.stringify(raw)}`);
  }
});

test('real values are parsed and trimmed', () => {
  assert.deepEqual(resolveRecipients('a@example.com'), ['a@example.com']);
  assert.deepEqual(
    resolveRecipients(' a@example.com , b@example.com '),
    ['a@example.com', 'b@example.com']
  );
  // A trailing comma is a common hand-edit and must not produce an empty slot.
  assert.deepEqual(resolveRecipients('a@example.com,'), ['a@example.com']);
});

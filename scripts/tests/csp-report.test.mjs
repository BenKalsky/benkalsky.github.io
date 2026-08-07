// The api/ handlers had no tests at all, and a Codex review found four defects
// in this one — every one of them a case where hostile input reaches a log a
// human reads, or a 500 where a 204 was promised. Those are the cases pinned
// here. Sanitisation that is only asserted in a comment is not asserted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import handler from '../../api/csp-report.js';

// Minimal stand-ins for the Vercel request and response objects. The handler
// touches method, body, status(), json() and end() and nothing else.
function call(body, method = 'POST') {
  const lines = [];
  const warn = console.warn;
  console.warn = (...args) => lines.push(args.join(' '));
  let status = 0;
  const res = {
    status(s) { status = s; return res; },
    json() { return res; },
    end() { return res; },
  };
  try {
    handler({ method, body }, res);
  } finally {
    console.warn = warn;
  }
  const reports = lines
    .filter((l) => l.startsWith('csp violation {'))
    .map((l) => JSON.parse(l.slice('csp violation '.length)));
  return { status, lines, reports };
}

test('an uppercase scheme does not smuggle a path and query into the log', () => {
  const { reports } = call({
    'csp-report': {
      'effective-directive': 'connect-src',
      'blocked-uri': 'HTTPS://example.com/path?token=secret',
      'document-uri': 'https://www.benkalsky.co.il/?utm_content=lead',
    },
  });
  assert.equal(reports.length, 1);
  assert.equal(reports[0].blocked, 'https://example.com');
  assert.equal(reports[0].onPage, 'https://www.benkalsky.co.il');
  for (const v of Object.values(reports[0])) {
    assert.ok(!String(v).includes('secret'), `leaked: ${v}`);
    assert.ok(!String(v).includes('utm_content'), `leaked: ${v}`);
  }
});

test('a non-http scheme is reduced to the scheme alone', () => {
  const { reports } = call({
    'csp-report': { 'blocked-uri': 'chrome-extension://abcdef/inject.js?u=x' },
  });
  assert.equal(reports[0].blocked, 'chrome-extension:');
});

test('CSP keywords survive intact, arbitrary strings do not', () => {
  assert.equal(call({ 'csp-report': { 'blocked-uri': 'inline' } }).reports[0].blocked, 'inline');
  assert.equal(call({ 'csp-report': { 'blocked-uri': 'eval' } }).reports[0].blocked, 'eval');
  assert.equal(
    call({ 'csp-report': { 'blocked-uri': 'name=Ben Kalsky phone=0528816959' } }).reports[0].blocked,
    '(other)'
  );
});

test('the directive is drawn from a closed vocabulary, not copied through', () => {
  assert.equal(
    call({ 'csp-report': { 'effective-directive': 'script-src' } }).reports[0].directive,
    'script-src'
  );
  // The whole matched policy trails violated-directive; only the name is kept.
  assert.equal(
    call({ 'csp-report': { 'violated-directive': "script-src 'self' 'unsafe-inline'" } }).reports[0].directive,
    'script-src'
  );
  // A log-injection attempt, a plausible-looking token that is not a
  // directive, and a nested object.
  assert.equal(
    call({ 'csp-report': { 'effective-directive': 'x\ncsp violation {"directive":"forged"}' } }).reports[0].directive,
    '(unknown)'
  );
  assert.equal(
    call({ 'csp-report': { 'effective-directive': 'benkalsky' } }).reports[0].directive,
    '(unknown)'
  );
  // Matching the -src shape rather than the vocabulary let an attacker write
  // a line that reads as a genuine browser finding.
  assert.equal(
    call({ 'csp-report': { 'effective-directive': 'password-leaked-src' } }).reports[0].directive,
    '(unknown)'
  );
  assert.equal(
    call({ 'csp-report': { 'effective-directive': { evil: true } } }).reports[0].directive,
    '(unknown)'
  );
});

test('disposition accepts only the two values the spec defines', () => {
  assert.equal(call({ 'csp-report': { disposition: 'report' } }).reports[0].disposition, 'report');
  assert.equal(call({ 'csp-report': { disposition: 'enforce' } }).reports[0].disposition, 'enforce');
  assert.equal(
    call({ 'csp-report': { disposition: 'enforce\nsomething else entirely' } }).reports[0].disposition,
    '(unknown)'
  );
});

test('a malformed batch element answers 204 instead of throwing', () => {
  const { status, reports } = call([null, 'a string', 42, { type: 'csp-violation' }]);
  assert.equal(status, 204);
  assert.equal(reports.length, 4);
  for (const r of reports) assert.equal(r.blocked, '(none)');
});

test('a batch cannot outrun the log cap by carrying its reports in one request', () => {
  const huge = Array.from({ length: 5000 }, () => ({
    type: 'csp-violation',
    body: { effectiveDirective: 'img-src', blockedURL: 'https://evil.example/x' },
  }));
  const { status, reports } = call(huge);
  assert.equal(status, 204);
  assert.ok(reports.length <= 10, `emitted ${reports.length} reports from one request`);
});

test('an unbounded origin never reaches the log', () => {
  // Node's URL parser accepts a hostname of any length and .origin keeps all
  // of it, so the line caps bound how many lines are written and nothing at
  // all about how large one can be.
  const host = 'a'.repeat(200000);
  const { lines, reports } = call({
    'csp-report': { 'blocked-uri': `https://${host}/`, 'document-uri': `https://${host}.example/` },
  });
  assert.equal(reports[0].blocked, '(oversized)');
  assert.equal(reports[0].onPage, '(oversized)');
  for (const l of lines) assert.ok(l.length < 500, `log line was ${l.length} bytes`);
});

test('an unbounded scheme never reaches the log either', () => {
  const { reports } = call({ 'csp-report': { 'blocked-uri': 'x'.repeat(50000) + '://y' } });
  assert.equal(reports[0].blocked, '(oversized)');
});

test('a non-POST is rejected without logging anything', () => {
  const { status, reports } = call({ 'csp-report': { 'blocked-uri': 'https://a.example/' } }, 'GET');
  assert.equal(status, 405);
  assert.equal(reports.length, 0);
});

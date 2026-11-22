/**
 * The Netlify function answers with the same middleware the dev server runs,
 * so its adapter is what carries the request across: the mounted path is
 * stripped, the edge's forwarding headers are removed before the same-site
 * gate sees them, and what a handler writes becomes the response.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handle } from '../functions/api.mjs';

/** A same-origin browser request to the deployed site. */
function browserRequest(path, headers = {}) {
  const host = 'gods-eye-view-console.netlify.app';
  return new Request(`https://${host}${path}`, {
    method: 'GET',
    headers: {
      host,
      origin: `https://${host}`,
      'sec-fetch-site': 'same-origin',
      ...headers,
    },
  });
}

test('a keyless route answers with the provider JSON', async () => {
  const response = await handle(browserRequest('/api/tomtom/status'));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.hasKey, false, 'no TomTom key is configured');
  assert.equal(typeof body.date, 'string');
});

test('the edge forwarding headers do not trip the same-site gate', async () => {
  const response = await handle(
    browserRequest('/api/tomtom/status', { 'x-forwarded-proto': 'https' }),
  );
  assert.equal(response.status, 200);
});

test('a cross-site request is refused', async () => {
  const response = await handle(
    browserRequest('/api/tomtom/status', {
      origin: 'https://elsewhere.example',
      'sec-fetch-site': 'cross-site',
    }),
  );
  assert.equal(response.status, 403);
});

test('an unknown API route answers with the not-found JSON', async () => {
  const response = await handle(browserRequest('/api/does-not-exist'));
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'Unknown API route' });
});

test('the mounted path is stripped before the handler runs', async () => {
  // /api/tomtom/status mounts under /api/tomtom, so the handler reads
  // /status; a route that did not see the stripped path would answer 404.
  const response = await handle(browserRequest('/api/tomtom/status'));
  assert.equal(response.status, 200);
});

test('the mount point Netlify used does not change the route', async () => {
  // Netlify can hand the function the rewritten path
  // (/.netlify/functions/api/...) or the path it matched by configuration
  // (/api/...); both have to reach the same provider route.
  for (const path of [
    '/.netlify/functions/api/tomtom/status',
    '/api/tomtom/status',
    '/tomtom/status',
  ]) {
    const response = await handle(browserRequest(path));
    assert.equal(response.status, 200, path);
  }
});

test('work that outlasts the deadline answers with the app’s error shape', async (t) => {
  // A fresh module reads the deadline from the environment, so the function
  // under test gives up almost at once. The provider it asks never answers.
  process.env.GEV_FUNCTION_DEADLINE_MS = '50';
  t.mock.method(globalThis, 'fetch', () => new Promise(() => {}));
  const { handle: impatient } = await import(`../functions/api.mjs?deadline=1`);
  const response = await impatient(browserRequest('/api/celestrak/stations'));
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.code, 'provider_timeout');
  delete process.env.GEV_FUNCTION_DEADLINE_MS;
});

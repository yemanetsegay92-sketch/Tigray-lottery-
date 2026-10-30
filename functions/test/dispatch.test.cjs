'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { dispatchQueuedCbePayment, PRODUCTION_URL } = require('../dispatch');

const requestId = 'a'.repeat(40);
const secret = 'secret_not_real_'.repeat(3);

test('new queue event dispatches only its own ID to the canonical production endpoint', async () => {
  let count = 0;
  const result = await dispatchQueuedCbePayment(requestId, secret, async (url, options) => {
    count++;
    assert.equal(url, PRODUCTION_URL);
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, 'Bearer ' + secret);
    assert.deepEqual(JSON.parse(options.body), {action:'cbe-auto-worker-one',requestId});
    return {ok: true, json: async () => ({ok:true,processed:1,approved:1,manual_review:0})};
  });
  assert.equal(count, 1);
  assert.deepEqual(result, {processed:1,approved:1,manual_review:0,retry:0});
});
test('invalid request IDs and missing secrets never dispatch', async () => {
  let calls = 0;
  const fetchMock = async () => { calls++; throw new Error('must not call network'); };
  await assert.rejects(dispatchQueuedCbePayment('../foo', secret, fetchMock), /Invalid queue/);
  await assert.rejects(dispatchQueuedCbePayment(requestId, 'short', fetchMock), /Missing CBE/);
  assert.equal(calls, 0);
});
test('concurrent worker already holding the lease is a harmless no-op', async () => {
  const result = await dispatchQueuedCbePayment(requestId, secret, async () => ({
    ok:true, json:async () => ({ok:true,processed:0,approved:0,manual_review:0})
  }));
  assert.equal(result.processed, 0);
});
test('upstream HTTP error or invalid worker confirmation never counts as approval', async () => {
  await assert.rejects(dispatchQueuedCbePayment(requestId,secret, async () => ({
    ok:false,status:401
  })), /HTTP 401/);
  await assert.rejects(dispatchQueuedCbePayment(requestId,secret, async () => ({
    ok:true,json:async () => ({ok:false,approved:1})
  })), /did not confirm success/);
});

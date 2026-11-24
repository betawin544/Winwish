const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createNexusPay, phoneNumber } = require('../nexuspay');

const deposit = {
  id: 7,
  amount: 100,
  payer_phone: '254712345678',
  external_reference: 'INTERNAL-7',
  account_reference: 'WINB-7',
  mpesa_checkout_request_id: 'ws_CO_test',
};

const env = { NEXUSPAY_API_KEY: 'test-secret' };

test('Nexus Pay submits the documented request and optional settlement routing without a customer callback URL', async () => {
  const requests = [];
  const nexuspay = createNexusPay({
    env: { ...env, NEXUSPAY_SETTLEMENT_ACCOUNT_ID: '4', NEXUSPAY_TENANT_CODE: 'tnnt_test' },
    http: {
      post: async (...args) => {
        requests.push(args);
        return { data: { checkoutRequestId: 'ws_CO_test', responseCode: '0', transactionId: 42 } };
      },
    },
  });
  assert.deepEqual(await nexuspay.initiate(deposit), { checkoutRequestId: 'ws_CO_test', providerReference: '42' });
  assert.equal(requests[0][0], 'https://makamescopay.com/api/payments/stkpush');
  assert.deepEqual(requests[0][1], {
    phoneNumber: '254712345678',
    amount: 100,
    accountReference: 'WINB-7',
    transactionDesc: 'M-Pesa deposit',
    settlementAccountId: 4,
    tenantCode: 'tnnt_test',
  });
  assert.equal(requests[0][2].headers['X-API-Key'], 'test-secret');
  assert.equal(requests[0][2].headers.Authorization, undefined);
});

test('Nexus Pay confirms matching checkout, amount, phone and receipt, and rejects mismatches', async () => {
  let body = { checkoutRequestId: 'ws_CO_test', status: 'completed', amount: '100.00', phoneNumber: '254712345678', mpesaReceiptNumber: 'RBK71G1234' };
  const calls = [];
  const nexuspay = createNexusPay({
    env,
    http: { get: async (...args) => { calls.push(args); return { data: body }; } },
  });
  const result = await nexuspay.check(deposit);
  assert.equal(result.status, 'completed');
  assert.equal(result.receipt, 'RBK71G1234');
  assert.equal(calls[0][0], 'https://makamescopay.com/api/payments/status/ws_CO_test');
  assert.equal(calls[0][1].headers['X-API-Key'], 'test-secret');
  const original = { ...body };
  for (const patch of [
    { checkoutRequestId: 'another-payment' },
    { amount: '99.00' },
    { amount: '100junk' },
    { phoneNumber: '254711112222' },
    { phoneNumber: undefined },
    { mpesaReceiptNumber: '' },
    { status: 'success' },
  ]) {
    body = { ...original, ...patch };
    await assert.rejects(nexuspay.check(deposit));
  }
  for (const status of ['pending', 'failed', 'cancelled']) {
    body = { checkoutRequestId: 'ws_CO_test', status };
    assert.equal((await nexuspay.check(deposit)).status, status);
  }
});

test('Nexus live responses without an echoed checkout ID retain the documented payment status', async () => {
  let body = { status: 'completed', amount: '100', phoneNumber: '254712345678', mpesaReceiptNumber: 'RBK71G1234', createdAt: '2026-04-24T14:01:05Z' };
  const nexuspay = createNexusPay({ env, http: { get: async () => ({ data: body }) } });
  const original = { ...body };
  assert.equal((await nexuspay.check(deposit)).status, 'completed');
  for (const patch of [
    { amount: '99' },
    { phoneNumber: '254711112222' },
    { phoneNumber: undefined },
    { mpesaReceiptNumber: null },
    { checkoutRequestId: 'different-payment' },
    { checkoutRequestId: null },
  ]) {
    body = { ...original, ...patch };
    await assert.rejects(nexuspay.check(deposit));
  }
  for (const status of ['pending', 'failed', 'cancelled']) {
    body = { status, amount: '100', phoneNumber: '254712345678', mpesaReceiptNumber: null };
    assert.equal((await nexuspay.check(deposit)).status, status);
  }
});

test('unconfigured Nexus Pay cannot send requests and transport timeouts are distinguished from rejections', async () => {
  let calls = 0;
  const unconfigured = createNexusPay({ env: {}, http: { post: async () => { calls++; } } });
  await assert.rejects(unconfigured.initiate(deposit), { status: 503, definitive: true });
  assert.equal(calls, 0);
  assert.equal(unconfigured.isConfigured(), false);
  const timeout = createNexusPay({ env, http: { post: async () => { throw new Error('timeout with test-secret'); } } });
  await assert.rejects(timeout.initiate(deposit), (cause) => cause.definitive === false && !cause.message.includes('test-secret'));
  const rejected = createNexusPay({ env, http: { post: async () => ({ data: { responseCode: '1' } }) } });
  await assert.rejects(rejected.initiate(deposit), { definitive: true });
  assert.equal(phoneNumber('0712 345 678'), '254712345678');
  assert.equal(phoneNumber('+254712345678'), '254712345678');
  assert.throws(() => phoneNumber('199'));
});

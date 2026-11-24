const error = (message, status = 502, definitive = false) => Object.assign(new Error(message), { status, definitive });

function phoneNumber(value) {
  let digits = String(value || '').replace(/[\s+().-]/g, '');
  if (/^0[17]\d{8}$/.test(digits)) digits = '254' + digits.slice(1);
  if (/^[17]\d{8}$/.test(digits)) digits = '254' + digits;
  if (!/^254[17]\d{8}$/.test(digits)) throw error('Enter a valid M-Pesa phone number.', 400, true);
  return digits;
}

function money(value) {
  if (!['number', 'string'].includes(typeof value) || !/^\d+(?:\.\d{1,2})?$/.test(String(value))) return NaN;
  return Math.round(Number(value) * 100) / 100;
}

const defaultHttp = {
  async post(url, body, { headers = {}, timeout = 15000 } = {}) {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      throw Object.assign(new Error(`HTTP ${res.status}`), { response: { status: res.status, data } });
    }
    return { data };
  },
  async get(url, { headers = {}, timeout = 8000 } = {}) {
    const res = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(timeout),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      throw Object.assign(new Error(`HTTP ${res.status}`), { response: { status: res.status, data } });
    }
    return { data };
  },
};

function createNexusPay({ http = defaultHttp, env = process.env } = {}) {
  const base = () => String(env.NEXUSPAY_BASE_URL || 'https://makamescopay.com/api').replace(/\/+$/, '');

  function configuration() {
    const url = new URL(base());
    if (url.protocol !== 'https:' || url.username || url.password) {
      throw error('Payment gateway requires a valid HTTPS server URL.', 503, true);
    }
    if (!env.NEXUSPAY_API_KEY?.trim()) {
      throw error('Nexus Pay has not been configured on the server.', 503, true);
    }
    if (
      env.NEXUSPAY_SETTLEMENT_ACCOUNT_ID &&
      (!Number.isSafeInteger(Number(env.NEXUSPAY_SETTLEMENT_ACCOUNT_ID)) || Number(env.NEXUSPAY_SETTLEMENT_ACCOUNT_ID) <= 0)
    ) {
      throw error('Nexus Pay settlement account is invalid.', 503, true);
    }
    return { baseURL: base() };
  }

  function isConfigured() {
    try {
      configuration();
      return true;
    } catch {
      return false;
    }
  }

  function verified(deposit, result) {
    if (result.status !== 'completed') return result;
    if (!Number.isFinite(money(result.amount)) || money(result.amount) !== money(deposit.amount)) {
      throw error('Payment amount could not be verified.');
    }
    if (result.phone && phoneNumber(result.phone) !== phoneNumber(deposit.payer_phone)) {
      throw error('Payment phone could not be verified.');
    }
    if (typeof result.receipt !== 'string' || !/^[A-Za-z0-9]{6,64}$/.test(result.receipt.trim())) {
      throw error('Payment receipt could not be verified.');
    }
    return { ...result, amount: money(result.amount), receipt: result.receipt.trim().toUpperCase() };
  }

  async function initiate(deposit) {
    const { baseURL } = configuration();
    try {
      const response = await http.post(`${baseURL}/payments/stkpush`, {
        phoneNumber: phoneNumber(deposit.payer_phone),
        amount: money(deposit.amount),
        accountReference: deposit.account_reference,
        transactionDesc: 'M-Pesa deposit',
        ...(env.NEXUSPAY_SETTLEMENT_ACCOUNT_ID ? { settlementAccountId: Number(env.NEXUSPAY_SETTLEMENT_ACCOUNT_ID) } : {}),
        ...(env.NEXUSPAY_TENANT_CODE?.trim() ? { tenantCode: env.NEXUSPAY_TENANT_CODE.trim() } : {}),
      }, { headers: { 'X-API-Key': env.NEXUSPAY_API_KEY.trim(), 'Content-Type': 'application/json' }, timeout: 15000 });
      const data = response.data;
      if (data?.responseCode !== undefined && String(data.responseCode) !== '0') {
        throw error('The payment prompt was rejected. Please try again later.', 502, true);
      }
      if (typeof data?.checkoutRequestId !== 'string' || !data.checkoutRequestId.trim()) {
        throw error('The payment request could not be confirmed. Check with support before retrying.');
      }
      return {
        checkoutRequestId: data.checkoutRequestId,
        providerReference: String(data.transactionId ?? data.merchantRequestId ?? ''),
      };
    } catch (cause) {
      if (cause.definitive !== undefined) throw cause;
      const rejected = cause.response?.status >= 400 && cause.response.status < 500 && cause.response.status !== 408;
      throw error(
        rejected
          ? 'The payment prompt was rejected. Please try again later.'
          : 'The payment request could not be confirmed. Check with support before retrying.',
        502,
        rejected
      );
    }
  }

  async function check(deposit) {
    const { baseURL } = configuration();
    if (!deposit.mpesa_checkout_request_id) return { status: 'pending' };
    const { data } = await http.get(`${baseURL}/payments/status/${encodeURIComponent(deposit.mpesa_checkout_request_id)}`, {
      headers: { 'X-API-Key': env.NEXUSPAY_API_KEY.trim() },
      timeout: 8000,
    });
    // The live API can omit the checkout ID despite the documented example.
    // The authenticated, request-specific URL identifies the payment; any
    // ID explicitly returned by the provider must still match that request.
    if (data?.checkoutRequestId !== undefined && data.checkoutRequestId !== deposit.mpesa_checkout_request_id) {
      throw error('Payment request identity could not be verified.');
    }
    if (!['pending', 'completed', 'failed', 'cancelled'].includes(data.status)) {
      throw error('Payment status could not be verified.');
    }
    if (data.status === 'completed' && !data.phoneNumber) {
      throw error('Payment phone could not be verified.');
    }
    return verified(deposit, {
      status: data.status,
      amount: data.amount,
      phone: data.phoneNumber,
      receipt: data.mpesaReceiptNumber,
      reason: data.status === 'cancelled' ? 'Payment cancelled on the phone.' : 'Payment failed on the phone.',
      raw: data,
    });
  }

  return { configuration, isConfigured, initiate, check, verified };
}

module.exports = { createNexusPay, phoneNumber, money, error };

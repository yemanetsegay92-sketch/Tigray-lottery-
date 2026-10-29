'use strict';

// Read-only Check.et verification for the general-admin testing dashboard.
// Never approve tickets or persist receipt details from this helper.
const API_URL = 'https://api.check.et/api/v1/verify';
const BANKS = new Set(['cbe','telebirr','dashen','awash','boa','zemen','cbebirr','mpesa','sinqee','amhara']);
function clientError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

async function verifyCheckEtPayment(input, deps = {}) {
  const bank = String(input.bank || '').trim().toLowerCase();
  const transactionNumber = String(input.transactionNumber || '').trim().toUpperCase();
  const accountNumber = String(input.accountNumber || '').trim().replace(/\s+/g, '');
  if (!BANKS.has(bank)) throw clientError('Choose a supported bank.');
  if (!/^[A-Z0-9_-]{5,80}$/.test(transactionNumber)) {
    throw clientError('Enter a valid bank transaction reference (5–80 characters).');
  }
  if (accountNumber && !/^[0-9]{8,30}$/.test(accountNumber)) {
    throw clientError('Receiving account must contain 8–30 digits.');
  }
  if (['cbe','boa','cbebirr'].includes(bank) && !accountNumber) {
    throw clientError('Account number is required for this bank.');
  }
  const key = deps.apiKey || process.env.CHECK_ET_API_KEY;
  if (!key) throw clientError('Check.et is not configured for this environment.', 503);
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  let response;
  try {
    const payload = {bank, transaction_number: transactionNumber};
    if (accountNumber) payload.account_number = accountNumber;
    response = await fetchImpl(API_URL, {
      method: 'POST',
      headers: {'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'},
      body: JSON.stringify(payload),
      signal: controller.signal
    });
  } catch (error) {
    throw clientError(error?.name === 'AbortError'
      ? 'Check.et did not respond in time.'
      : 'Could not contact Check.et. Try again later.', 503);
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 401) throw clientError('Check.et rejected the API key. Check the Preview environment configuration.', 502);
  if (response.status === 402) throw clientError('Check.et verification quota or subscription limit reached.', 503);
  if (response.status === 429) throw clientError('Check.et rate limit reached. Try later.', 429);
  if (response.status === 400 || response.status === 422) {
    throw clientError('Check.et rejected the bank/reference details.', 400);
  }
  if (response.status >= 500) throw clientError('Check.et is temporarily unavailable.', 503);
  if (response.status !== 200 && response.status !== 404) {
    throw clientError('Unexpected response from Check.et.', 502);
  }
  let json;
  try { json = await response.json(); }
  catch { throw clientError('Check.et sent an unreadable response.', 502); }
  if (!json || typeof json !== 'object') throw clientError('Check.et sent an invalid response.', 502);
  const info = json.data || {};
  const receipt = info.receipt && typeof info.receipt === 'object' ? info.receipt : {};
  const completed = String(receipt.status || '').toLowerCase() === 'completed';
  const confirmed = response.status === 200 && json.success === true && json.exists === true && completed;
  const rawReturnedAccount = String(receipt.receiver_account || '').trim();
  // Providers may show masked CBE accounts (e.g. 1********4278).
  // Visible suffix digits are useful diagnostically, but NEVER prove an exact match.
  const returnedHasMask = /[*xX•]/.test(rawReturnedAccount);
  const returnedAccount = rawReturnedAccount.replace(/\D/g, '');
  const expectedAccount = accountNumber.replace(/\D/g, '');
  const receiverAccountMatches = !rawReturnedAccount || !expectedAccount || returnedHasMask
    ? null
    : returnedAccount === expectedAccount;
  const receiverAccountStatus = !rawReturnedAccount ? 'not_returned'
    : returnedHasMask ? 'masked_unverifiable'
    : receiverAccountMatches ? 'exact_match' : 'mismatch';
  return {
    verified: confirmed, exists: json.exists === true,
    providerDuplicate: json.duplicate === true,
    bank, transactionNumber: String(info.transaction_number || transactionNumber).slice(0,80),
    verificationMethod: String(info.verification_method || 'unknown').slice(0,30),
    status: String(receipt.status || 'unknown').slice(0,30),
    amount: Number.isFinite(Number(receipt.amount)) && receipt.amount != null ? Number(receipt.amount) : null,
    currency: String(receipt.currency || '').slice(0,6),
    payerName: String(receipt.payer_name || '').slice(0,150),
    receiverName: String(receipt.receiver_name || '').slice(0,150),
    receiverAccountMatches, receiverAccountStatus,
    receiverAccountReturned: Boolean(rawReturnedAccount),
    // Check.et duplicate is branch-scoped; it is NOT our own replay protection.
    note: 'Read-only test. No tickets approved and no transaction claim recorded.'
  };
}

module.exports = { verifyCheckEtPayment };

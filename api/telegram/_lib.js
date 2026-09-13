const { getApps, initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const crypto = require('crypto');

function adminDb() {
  if (!getApps().length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not configured.');
    let serviceAccount;
    try { serviceAccount = JSON.parse(raw); }
    catch { throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON.'); }
    initializeApp({ credential: cert(serviceAccount) });
  }
  return getFirestore();
}

function botToken() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured.');
  return token;
}

function botUsername() {
  const username = String(process.env.TELEGRAM_BOT_USERNAME || '').replace(/^@/, '');
  if (!username) throw new Error('TELEGRAM_BOT_USERNAME is not configured.');
  return username;
}

async function telegram(method, body) {
  const response = await fetch(`https://api.telegram.org/bot${botToken()}/${method}`, {
    method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.description || `Telegram ${method} failed.`);
  return data.result;
}

function telegramMiniAppUrl() {
  return process.env.TELEGRAM_MINI_APP_URL || 'https://tigraylottery.com/telegram.html';
}

function botLink(startParam='') {
  const q = startParam ? `?start=${encodeURIComponent(startParam)}` : '';
  return `https://t.me/${botUsername()}${q}`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function normalizeTelegramInitData(initData) {
  return String(initData || '');
}

function validateTelegramInitData(initData, maxAgeSeconds = 86400) {
  const data = normalizeTelegramInitData(initData);
  if (!data) throw new Error('Missing Telegram initialization data.');
  const params = new URLSearchParams(data);
  const hash = params.get('hash');
  if (!hash) throw new Error('Invalid Telegram initialization data.');
  params.delete('hash');
  const pairs = [...params.entries()].sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${k}=${v}`);
  const dataCheckString = pairs.join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken()).digest();
  const calculated = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  if (calculated !== hash) throw new Error('Telegram initialization data signature is invalid.');
  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate || Math.floor(Date.now()/1000) - authDate > maxAgeSeconds) throw new Error('Telegram session has expired. Please reopen the Mini App.');
  let user = null;
  try { user = params.get('user') ? JSON.parse(params.get('user')) : null; } catch {}
  if (!user?.id) throw new Error('Telegram user information is missing.');
  return { user, authDate };
}

function htmlLink(label, url) {
  return `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
}

module.exports = {
  adminDb, telegram, botLink, botUsername, telegramMiniAppUrl, escapeHtml, validateTelegramInitData, FieldValue, Timestamp, htmlLink
};

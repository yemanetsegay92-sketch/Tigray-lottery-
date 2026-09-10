import { db, auth } from '../firebase.js';
import { onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js';
import { collection, getDocs, doc, getDoc, addDoc, updateDoc, serverTimestamp, query, where, runTransaction } from 'https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js';

const $ = (id) => document.getElementById(id);
const message = $('message');
const createPanel = $('createPanel');
const lotForm = $('lotForm');
const lotsEl = $('lotteries');
const requestsEl = $('requests');
let me = null, profile = null, lots = [];

$('logoutBtn').addEventListener('click', async () => { await signOut(auth); location.href = 'login.html'; });
$('showCreateBtn').addEventListener('click', () => { createPanel.style.display = createPanel.style.display === 'none' ? 'block' : 'none'; });
$('refreshBtn').addEventListener('click', render);

onAuthStateChanged(auth, async (u) => {
  if (!u) { location.href = 'login.html'; return; }
  me = u;
  try {
    const p = await getDoc(doc(db, 'users', u.uid));
    if (!p.exists()) {
      message.innerHTML = '<p class="error">Your Firebase account is authenticated, but no admin profile exists yet. Create users/' + u.uid + ' in Firestore with role and lotteryIds.</p>';
      lotsEl.innerHTML = '';
      requestsEl.innerHTML = '';
      return;
    }
    profile = p.data();
    await render();
  } catch (e) {
    console.error(e);
    message.innerHTML = '<p class="error">Could not load your admin profile. Check Firestore rules.</p>';
  }
});

lotForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!profile || profile.role !== 'generalAdmin') return alert('Only General Admin can create lotteries.');
  const min = Number($('min').value), max = Number($('max').value), price = Number($('price').value);
  if (min > max || price <= 0) return alert('Check the lottery values.');
  try {
    await addDoc(collection(db, 'lotteries'), { name: $('lotName').value.trim(), price, min, max, status: $('status').value, adminIds: [], createdAt: serverTimestamp() });
    lotForm.reset(); createPanel.style.display = 'none'; await render();
  } catch (e) { console.error(e); alert('Could not create lottery: ' + e.message); }
});

function allowed(l) { return profile.role === 'generalAdmin' || (profile.role === 'lotteryAdmin' && (profile.lotteryIds || []).includes(l.id)); }

async function render() {
  if (!profile) return;
  const s = await getDocs(collection(db, 'lotteries'));
  lots = s.docs.map(d => ({ id: d.id, ...d.data() })).filter(allowed);
  lotsEl.innerHTML = lots.length ? lots.map(x => `<div class="lot-row"><b>${escapeHtml(x.name)}</b> (${x.id})<br>${x.price} Birr · ${x.min}-${x.max} · <span class="${x.status}">${x.status}</span></div>`).join('') : 'No assigned lotteries.';

  if (profile.role === 'generalAdmin') {
    const rs = await getDocs(collection(db, 'ticketRequests'));
    renderRequests(rs);
  } else if (lots.length) {
    const ids = lots.map(x => x.id).slice(0, 10);
    const rs = await getDocs(query(collection(db, 'ticketRequests'), where('lotteryId', 'in', ids)));
    renderRequests(rs);
  } else requestsEl.innerHTML = 'No requests.';
}

function renderRequests(rs) {
  requestsEl.innerHTML = rs.docs.map(d => {
    const x = d.data(), lot = lots.find(l => l.id === x.lotteryId);
    return `<div class="lot-row"><b>${escapeHtml(x.name)}</b> · ${escapeHtml(x.phone)}<br>Lottery: ${escapeHtml(lot?.name || x.lotteryId)}<br>Tickets requested: ${x.quantity || 1}<br>Total: ${x.total || x.price || 0} Birr<br>Reference: ${escapeHtml(x.reference || '')}<br>Status: <b>${escapeHtml(x.status)}</b>${x.ticketNumbers?.length ? '<br>🎟️ ' + x.ticketNumbers.join(', ') : ''}${x.status === 'pending' ? `<div class="actions"><button data-action="approve" data-id="${d.id}">✓ Approve</button><button class="danger" data-action="reject" data-id="${d.id}">✕ Reject</button></div>` : ''}</div>`;
  }).join('') || 'No requests.';
  requestsEl.querySelectorAll('[data-action="reject"]').forEach(b => b.addEventListener('click', () => rejectRequest(b.dataset.id)));
  requestsEl.querySelectorAll('[data-action="approve"]').forEach(b => b.addEventListener('click', () => approveRequest(b.dataset.id)));
}

async function rejectRequest(id) {
  try { await updateDoc(doc(db, 'ticketRequests', id), { status: 'rejected', reviewedBy: me.uid, reviewedAt: serverTimestamp() }); await render(); }
  catch (e) { alert(e.message); }
}

async function approveRequest(id) {
  try {
    await runTransaction(db, async tx => {
      const r = doc(db, 'ticketRequests', id), rs = await tx.get(r);
      if (!rs.exists() || rs.data().status !== 'pending') throw Error('This request has already been reviewed.');
      const x = rs.data(), lot = lots.find(l => l.id === x.lotteryId);
      if (!lot) throw Error('You are not authorized for this lottery.');
      const all = await getDocs(query(collection(db, 'ticketRequests'), where('lotteryId', '==', lot.id), where('status', '==', 'approved')));
      const used = new Set(all.docs.flatMap(d => d.data().ticketNumbers || []).map(Number));
      const count = Number(x.quantity || 1), range = lot.max - lot.min + 1;
      if (used.size + count > range) throw Error('Not enough ticket numbers left.');
      const out = [];
      while (out.length < count) { const n = Math.floor(Math.random() * range) + lot.min; if (!used.has(n) && !out.includes(n)) { used.add(n); out.push(n); } }
      tx.update(r, { status: 'approved', ticketNumbers: out, reviewedBy: me.uid, reviewedAt: serverTimestamp() });
    });
    await render();
  } catch (e) { alert(e.message); console.error(e); }
}

function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

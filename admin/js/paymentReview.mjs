const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function attemptMarkup(attempt, title) {
  const result = attempt.result || {};
  const fields = [
    ['Submitted reference', attempt.reference || 'Unavailable in saved record'],
    ['Provider HTTP status',result.providerHttpStatus], ['Provider code',result.providerCode], ['Failure reason',result.failureReason], ['Outcome', attempt.state], ['Bank status', result.status], ['Bank reference', result.reportedTransactionNumber],
    ['Verification method',result.verificationMethod || result.verificationMethodValue], ['Verified', result.verified], ['Amount', result.amount == null ? null : result.amount+' '+(result.currency || '')],
    ['Bank date',result.transactionDate], ['Receiver', result.receiverName], ['Receiving account check', result.receiverAccountStatus],
    ['Account confirmed by provider',result.providerCbeAccountCheck], ['Provider duplicate', result.providerDuplicate], ['Administrator',attempt.adminId], ['Detail',attempt.message]
  ];
  return '<section><strong>'+esc(title)+'</strong><dl>'+fields.filter(([,v])=>v!=null && v!=='')
    .map(([k,v])=>'<dt>'+esc(k)+'</dt><dd>'+esc(v)+'</dd>').join('')+'</dl></section>';
}

export async function openReview(panel, item, accounts, send, approve, reject) {
  panel.textContent = 'Loading payment evidence…';
  let data;
  try { data = await send('review-details',{}); }
  catch (error) { panel.textContent = error.message; return; }
  const history = [...(data.automatic ? [data.automatic] : []), ...data.attempts];
  panel.innerHTML = `<div class="payment-review">
    <p>Customer reference <b>${esc(item.originalCustomerReference ?? item.reference ?? '') || 'None supplied'}</b></p>
    <label>OCR-extracted reference <output>${esc(data.ocr?.reference || ((item.proofPath || item.screenshotData)?'Unavailable':'No uploaded receipt'))}</output></label>
    <p>Original OCR reference: <b>${esc(data.ocr?.originalReference || 'Unavailable')}</b></p>
    <p>Recognized candidates in OCR text order: ${esc((data.ocr?.candidates||[]).map(c=>c.original).join(' · ') || 'Unavailable')}</p>
    <label>Bank <select data-bank><option value="cbe">CBE</option><option value="other">Other</option></select></label>
    <label data-account-label>CBE receiving account <select data-account>${accounts.map(a=>'<option value="'+a.index+'">'+esc(a.label)+'</option>').join('')}</select></label>
    <label>Corrected transaction reference <input data-ref maxlength="80" autocomplete="off" spellcheck="false"></label>
    <div class="payment-results">${history.map((a,i)=>attemptMarkup(a,i?'Verification '+(i+1):'Original Check.et verification')).join('') || 'No recorded Check.et attempt.'}</div>
    <div class="actions"><button type="button" data-act="review-save">Save correction</button><button type="button" data-act="review-duplicate">Duplicate check</button>
    <button type="button" data-act="review-verify">Verify Again (CBE)</button></div>
    <label><input type="checkbox" data-paid> I confirmed the payment reached the receiving account for the required amount.</label>
    <div class="actions"><button type="button" data-act="approve">Approve &amp; Assign</button><button type="button" class="danger" data-act="reject">Reject</button></div>
    <p role="status" data-status></p></div>`;
  const el = selector => panel.querySelector(selector);
  const bank = el('[data-bank]'), ref = el('[data-ref]'), paid = el('[data-paid]'), status = el('[data-status]');
  bank.value = data.correction?.bank || (accounts.length?'cbe':'other');
  ref.value = data.correction?.reference || data.ocr?.reference || item.reference || '';
  const sync = () => {
    paid.checked = false;
    status.textContent = '';
    el('[data-account-label]').hidden = bank.value !== 'cbe';
    el('[data-act="review-verify"]').hidden = bank.value !== 'cbe';
    el('[data-act="review-verify"]').disabled = !accounts.length;
  };
  sync();
  bank.onchange = ref.oninput = el('[data-account]').onchange = sync;
  for (const button of panel.querySelectorAll('[data-act]')) button.onclick = async () => {
    if (panel.dataset.busy) return;
    const action = button.dataset.act;
    const input = {bank:bank.value,correctedReference:ref.value.trim(),revision:data.revision,
      accountIndex:Number(el('[data-account]').value),paymentConfirmed:paid.checked};
    if (action !== 'reject' && !input.correctedReference) {status.textContent='Enter the transaction reference.';return;}
    if (action === 'approve' && !paid.checked) {status.textContent='Confirm receipt of payment first.';return;}
    if (action === 'review-verify') {
      if (!confirm('Send '+input.correctedReference+' to Check.et? This may use one verification credit.')) return;
      input.confirmCharge = true;
    }
    panel.dataset.busy = '1';
    const controls = [...panel.querySelectorAll('button,input,select')];
    const disabled = controls.map(c=>c.disabled);
    controls.forEach(c=>c.disabled=true);
    try {
      if (action === 'approve') await approve(input);
      else if (action === 'reject') await reject(input);
      else {
        const response = await send(action,input);
        if (action === 'review-verify') await openReview(panel,item,accounts,send,approve,reject);
        else {
          if (response.revision != null) data.revision = response.revision;
          status.textContent = action === 'review-save' ? 'Correction saved.' :
            response.used ? 'Already used for an approved purchase.' : 'No permanent claim found for this reference.';
        }
      }
    } catch (error) { status.textContent = error.message; }
    finally { controls.forEach((c,i)=>c.disabled=disabled[i]); delete panel.dataset.busy; }
  };
}

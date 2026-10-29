// Safe, read-only rendering of payment matching diagnostics.
// A possible match is NOT a permission to approve tickets automatically.
const esc = v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function renderChecketMatch(data) {
  const assessment = data?.assessment || {};
  const payment = data?.payment || {};
  const request = data?.request || {};
  const checks = assessment.checks || {};
  const matched = assessment.recommendation === 'MATCHED_FOR_REVIEW';
  const messages = Array.isArray(assessment.concerns) ? assessment.concerns : [];
  const amount = payment.amount === null || payment.amount === undefined
    ? 'Not returned' : Number(payment.amount).toLocaleString('en-US')+' '+esc(payment.currency || 'ETB');
  const expected = Number(request.total || 0).toLocaleString('en-US')+' ETB';
  const title = matched ? 'POSSIBLE MATCH — ADMIN REVIEW STILL REQUIRED' : 'MANUAL REVIEW REQUIRED';
  return `<div class="${matched?'success':'error'}">
    <strong>${esc(title)}</strong>
    <p>Pending request: ${esc(request.id || '')}</p>
    <p>Verification input: ${esc(data.verificationInput==='receipt'?'Private PDF/image sent directly to Check.et':'Bank reference')}</p>
    ${data.verificationInput==='receipt' ? `<p>Reference extracted by Check.et:
      <strong>${esc(request.extractedReference||'Not returned')}</strong>
      ${!request.reference?'(buyer did not enter one)':''}</p>` : ''}
    <p>Expected: <strong>${esc(expected)}</strong> · Bank reports: <strong>${amount}</strong></p>
    <p>Bank status: ${esc(payment.status||'unknown')} · Date: ${esc(payment.transactionDate||'not returned')}</p>
    <p>Sender: ${esc(payment.payerName||'not returned')}</p>
    <p>Receiver: ${esc(payment.receiverName||'not returned')}</p>
    <p>Receiver account: ${esc(payment.receiverAccountStatus||'not_returned')}
      (a masked account is NOT an independently confirmed full match)</p>
    <p>CBE account verification by provider: ${checks.providerCbeAccountCheck
      ? 'Check.et reports an official CBE confirmation using the full configured account.'
      : 'Not established.'}</p>
    <p><strong>Safety note:</strong> A masked account is not independently a full account match.
      We have experimentally checked the provider using correct and incorrect CBE recipients;
      production activation still requires independent security and historical-claims review.</p>
    <p>Our permanent payment claim: ${esc(checks.referenceClaimStatus||'not_checked')}
      · Prior approved requests using exact reference: ${esc(checks.otherApprovedRequestsWithReference??0)}</p>
    <p>Exact-reference occurrences in other ticket requests: ${esc(checks.otherRequestsWithExactReference??0)}
      (not a complete duplicate guarantee)</p>
    <p>Timing: ${esc(checks.dateStatus||'missing')}
      · Transaction reference: ${esc(checks.referenceMatch===true?'matches provider':checks.referenceMatch===false?'does not match':(data.verificationInput==='receipt' && request.extractedReference?'extracted from receipt (review)':'not independently returned'))}</p>
    ${messages.length?'<p><strong>Issues requiring attention:</strong></p><ul>'+messages.map(x=>'<li>'+esc(x)+'</li>').join('')+'</ul>':'<p>No mismatch found in available data. Verify the actual receiving account before approving.</p>'}
    <hr>
    <p><strong>CBE automatic-approval eligibility — PREVIEW SIMULATION</strong></p>
    <p>${data.autoEligibility?.eligible
      ? '✅ PASS: Payment meets the current strict automatic checks, but automation is disabled in Preview.'
      : '🟡 HOLD: This purchase needs manual review or further configuration.'}</p>
    ${Array.isArray(data.autoEligibility?.reasons) && data.autoEligibility.reasons.length
      ? '<p>Automatic approval blocked by:</p><ul>'+data.autoEligibility.reasons.map(r=>'<li>'+esc(r)+'</li>').join('')+'</ul>'
      : ''}
    <p><strong>READ-ONLY: No ticket approved. Manual approval is separate.</strong></p>
  </div>`;
}

export function cbeAccounts(lottery) {
  return (Array.isArray(lottery?.paymentAccounts) ? lottery.paymentAccounts : [])
    .map((x, i)=>({index:i,bank:String(x.bank||'').trim(),number:String(x.number||'').replace(/\s+/g,'')}))
    .filter(x=>/^(cbe|commercial bank of ethiopia)$/i.test(x.bank)
      && /^\d{8,30}$/.test(x.number) && x.number!=='1000000000000')
    .map(x=>({index:x.index,label:'CBE account ending '+x.number.slice(-4)}));
}

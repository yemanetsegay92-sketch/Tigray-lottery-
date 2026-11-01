'use strict';
// Creation UI/source contract tests. These make no cloud or bank calls.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const html=readFileSync('admin/general.html','utf8');
const js=readFileSync('admin/js/general.js','utf8');
const customer=readFileSync('api/customer/create-request.js','utf8');
const approvals=readFileSync('api/admin/approvals.js','utf8');

test('General Admin creation form defaults to manual and offers automatic CBE approval',()=>{
  assert.match(html,/<select id="approvalMode" required>/);
  assert.match(html,/<option value="manual" selected>Manual approval \(default\)<\/option>/);
  assert.match(html,/<option value="automatic">Automatic CBE approval<\/option>/);
  assert.match(html,/This choice is permanent/);
});

test('new lottery and its audit log persist the General Admin creation-time choice',()=>{
  assert.match(js,/const approvalMode=\$\('approvalMode'\)\.value/);
  assert.match(js,/\['manual','automatic'\]\.includes\(approvalMode\)/);
  assert.match(js,/batch\.set\(newLottery,\{name:/);
  assert.match(js,/status:\$\('status'\)\.value,approvalMode,description/);
  assert.match(js,/action:'createLottery',lotteryId:newLottery\.id,approvalMode/);
  assert.match(js,/await batch\.commit\(\)/);
});

test('queue creation and final automatic issuance independently require automatic mode',()=>{
  assert.match(customer,/usesAutomaticApproval\(currentLottery\.data\(\)\) &&/);
  assert.match(customer,/enabledFor\(currentLottery\.data\(\),activationSnap/);
  assert.match(approvals,/usesAutomaticApproval\(lottery\) &&/);
  assert.match(approvals,/enabledFor\(lottery,activationSnap/);
});

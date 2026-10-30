'use strict';
// DOM contract regression tests; no live user accounts or cloud writes.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const html=readFileSync('admin/general.html','utf8');
const js=readFileSync('admin/js/general.js','utf8');
const rules=readFileSync('firestore.rules','utf8');

test('assign form contains a real submit button, a required existing admin selector, and inline status',()=>{
  assert.match(html,/<form id="assignForm">/);
  assert.match(html,/<select id="assignAdminSelect" required/);
  assert.match(html,/<select id="assignLottery" required/);
  assert.match(html,/<button type="submit" id="assignLotteryBtn">Assign Lottery<\/button>/);
  assert.match(html,/<div id="assignMessage" role="status" aria-live="polite"/);
});
test('assign handler reports progress and errors near the button',()=>{
  assert.match(js,/\$\('assignForm'\)\.addEventListener\('submit'/);
  assert.match(js,/e\.preventDefault\(\)/);
  assert.match(js,/btn\.textContent='Assigning…'/);
  assert.match(js,/msg\.innerHTML='<div class="error">/);
});
test('assignments use the selected existing admin ID, server reads and an atomic audit',()=>{
  assert.match(js,/const adminId=adminSelect\.value/);
  assert.match(js,/profileSnap\.data\(\)\.role!=='lotteryAdmin'/);
  assert.match(js,/const batch=writeBatch\(db\)/);
  assert.match(js,/batch\.update\(doc\(db,'users',adminId\)/);
  assert.match(js,/batch\.set\(doc\(collection\(db,'auditLogs'\)\)/);
  assert.match(js,/await batch\.commit\(\)/);
});
test('General Admin can update user profiles and create audit records via rules',()=>{
  assert.match(rules,/match \/users\/\{userId\} \{[\s\S]*?allow update, delete: if isGeneral\(\)/);
  assert.match(rules,/match \/auditLogs\/\{logId\} \{[\s\S]*?allow create: if signed\(\)/);
});

#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const api = fs.readFileSync('api/admin/approvals.js','utf8');
const checkout = fs.readFileSync('api/customer/create-request.js','utf8');
const ui = fs.readFileSync('admin/js/general.js','utf8');
function includes(text, pattern, description) {
  assert.match(text, pattern, description);
}
includes(api, /profile\.role !== 'generalAdmin'/, 'Only general admin may clean up');
includes(api, /body\.confirm !== 'DELETE ' \+ lotteryId/, 'Exact lottery ID required');
includes(api, /body\.acceptIrreversible !== true/, 'Irreversible deletion confirmation required');
includes(api, /cleanupInProgress:true, cleanupPhase:'requests', status:'closed'/, 'Close the lottery before deleting');
includes(api, /cleanupDatePacific\(\)/, 'Timezone-aware daily quota');
includes(api, /CLEANUP_DAILY_DELETE_LIMIT = 5000/, 'Conservative quota cap');
includes(api, /db\.runTransaction\(async tx => \{[\s\S]*?tx\.set\(dailyRef,/, 'Atomic quota and deletes');
includes(api, /where\('lotteryId','==',lotteryId\)/, 'Scope deletions to selected lottery');
includes(api, /db\.collection\('publicStatus'\)\.doc\(phoneHash\)\.collection\('requests'\)\.doc\(item\.id\)/, 'Remove linked public request');
includes(api, /phase === 'finalProofs' \|\| phase === 'incomingProofs'/, 'Sweep finalized and incoming Storage files');
includes(api, /FieldValue\.arrayRemove\(lotteryId\)/, 'Remove lottery from admin assignments');
includes(api, /action:'fullLotteryCleanup'/, 'Keep an audit entry for deletion');
includes(api, /if \(lottery\.cleanupInProgress === true\)/, 'Block approval during cleanup');
includes(api, /selectedLottery\.data\(\)\.cleanupInProgress === true/, 'Block rejection during cleanup');
includes(checkout, /currentLottery\.data\(\)\.cleanupInProgress === true/, 'Prevent late checkouts from creating data');
includes(ui, /'lottery-cleanup-preview'/, 'Show confirmation preview');
includes(ui, /'lottery-cleanup-start'/, 'Start confirmed cleanup');
includes(ui, /'lottery-cleanup-step'/, 'Support resumable cleanup');
assert.doesNotMatch(ui, /await deleteDoc\(doc\(db,'lotteries',id\)\)/, 'Old orphan-producing deletion removed');
console.log('Cleanup authorization, lifecycle and safety checks passed');

'use strict';

// A General Admin controls CBE auto approval through a server-owned Firestore
// activation record, not a Vercel environment allowlist. Client rules deny
// access to autoApprovalActivations; only the authenticated server writes it.
const {cbeAccounts,nameKey}=require('./cbe-auto-eligibility');
const {usesAutomaticApproval}=require('./lottery-approval-mode');
const {cutoverMs}=require('./cbe-auto-cutover');

function activationRef(db,lotteryId) {
  return db.collection('autoApprovalActivations').doc(String(lotteryId));
}
function configuredCbe(lottery) {
  const accounts=cbeAccounts(lottery);
  if(accounts.length!==1 || !nameKey(accounts[0].holderName))return null;
  return {account:String(accounts[0].number).replace(/\s/g,''),holderKey:nameKey(accounts[0].holderName)};
}
function activationMatches(lottery,activation) {
  const configured=configuredCbe(lottery);
  return Boolean(configured && usesAutomaticApproval(lottery) &&
    activation && activation.version===1 && activation.enabled===true &&
    activation.account===configured.account && activation.holderKey===configured.holderKey);
}
function globallyEnabled(env=process.env) {
  return env.VERCEL_ENV==='production' &&
    env.LOTTERY_CBE_AUTO_APPROVAL_ENABLED==='true' &&
    Number.isFinite(cutoverMs(env)) && Date.now()>=cutoverMs(env) &&
    Boolean(env.CHECK_ET_API_KEY) &&
    Buffer.byteLength(String(env.LOTTERY_CBE_AUTO_APPROVAL_CRON_SECRET||''))>=32;
}
function enabledFor(lottery,activation,env=process.env) {
  return globallyEnabled(env) && lottery?.status==='active' &&
    lottery?.cleanupInProgress!==true && activationMatches(lottery,activation);
}
module.exports={activationRef,configuredCbe,activationMatches,globallyEnabled,enabledFor};

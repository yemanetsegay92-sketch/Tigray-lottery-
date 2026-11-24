'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {assertWalletMutationAllowed,isolatedTarget,walletCapabilities}=require('../lib/wallet-runtime-policy');
test('Preview cannot mutate a production Firebase project even when feature flags are set',()=>{
 const env={VERCEL_ENV:'preview',GCLOUD_PROJECT:'tigray-production',WALLET_PRODUCTION_MUTATIONS_ENABLED:'true',WALLET_DEPOSITS_ENABLED:'true'};
 assert.throws(()=>assertWalletMutationAllowed('deposit',env),/disabled in Preview/);
});
test('production wallet mutations are disabled by default and require both explicit flags',()=>{
 assert.throws(()=>assertWalletMutationAllowed('refund',{VERCEL_ENV:'production',GCLOUD_PROJECT:'prod'}),/not authorized/);
 assert.throws(()=>assertWalletMutationAllowed('refund',{VERCEL_ENV:'production',GCLOUD_PROJECT:'prod',WALLET_PRODUCTION_MUTATIONS_ENABLED:'true'}),/not authorized/);
 assert.equal(assertWalletMutationAllowed('refund',{VERCEL_ENV:'production',GCLOUD_PROJECT:'prod',WALLET_PRODUCTION_MUTATIONS_ENABLED:'true',WALLET_REFUNDS_ENABLED:'true'}).target,'production');
});
test('testing is allowed only on a demo emulator or explicitly named staging project',()=>{
 const demo={VERCEL_ENV:'preview',GCLOUD_PROJECT:'demo-wallet',FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080'};
 assert.equal(isolatedTarget(demo),'emulator');
 assert.equal(assertWalletMutationAllowed('purchase',demo).target,'emulator');
 const staging={VERCEL_ENV:'preview',GCLOUD_PROJECT:'wallet-staging',WALLET_STAGING_PROJECT_ID:'wallet-staging',WALLET_STAGING_MUTATIONS_ENABLED:'true'};
 assert.equal(assertWalletMutationAllowed('settlement',staging).target,'staging');
 assert.throws(()=>assertWalletMutationAllowed('settlement',{...staging,GCLOUD_PROJECT:'production'}),/disabled in Preview/);
});
test('public capability status fails closed and mirrors only authorized server flags',()=>{
 assert.deepEqual(walletCapabilities({VERCEL_ENV:'production'}),{registration:false,deposit:false,purchase:false,refund:false,settlement:false});
 assert.deepEqual(walletCapabilities({VERCEL_ENV:'production',WALLET_PRODUCTION_MUTATIONS_ENABLED:'true',WALLET_REGISTRATION_ENABLED:'true'}),{registration:true,deposit:false,purchase:false,refund:false,settlement:false});
 assert.deepEqual(walletCapabilities({FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080',GCLOUD_PROJECT:'demo-wallet'}),{registration:true,deposit:true,purchase:true,refund:true,settlement:true});
});

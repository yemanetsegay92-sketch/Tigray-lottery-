'use strict';
const {test,expect}=require('@playwright/test');

// This suite uses the localhost-only browser E2E runner. Firebase Auth is mocked
// at the module import boundary; no production credentials or real SMS are used.
if(process.env.LOCAL_EMULATOR_ONLY!=='true'||process.env.GCLOUD_PROJECT!=='demo-tigray-wallet'||
 process.env.FIREBASE_AUTH_EMULATOR_HOST!=='127.0.0.1:9099')
 throw new Error('Phone auth browser test must use only demo-tigray-wallet localhost emulators.');

test('customer sees safe Firebase SMS and captcha errors in the actual account form, without sending SMS',async({page})=>{
 const external=[];
 page.on('request',request=>{
  if(!['127.0.0.1','localhost'].includes(new URL(request.url()).hostname))external.push(request.url());
 });

 // Preserve production's account.js and replace only its Firebase SDK import
 // within this browser session. The page, event handler and message renderer
 // remain real application code.
 await page.route('**/js/account.js',async route=>{
  const response=await route.fetch();
  const original=await response.text();
  // The localhost E2E server rewrites CDN imports to an isolated SDK shim.
  const sdk=['https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js','/__local/firebase-auth.js']
   .find(path=>original.includes(path));
  expect(sdk,'Expected browser Firebase Auth import').toBeTruthy();
  await route.fulfill({status:200,contentType:'text/javascript',
   body:original.replace(sdk,'/mock-firebase-auth.mjs')});
 });
 await page.route('**/firebase.js',route=>route.fulfill({
  status:200,contentType:'text/javascript',
  body:'export const auth = {currentUser:null,useDeviceLanguage(){}};'
 }));
 await page.route('**/mock-firebase-auth.mjs',route=>route.fulfill({
  status:200,contentType:'text/javascript',
  body:`
   export class RecaptchaVerifier {
    constructor() {}
    clear() {}
   }
   export async function signInWithPhoneNumber(_auth,number) {
    (window.__mockPhoneRequests ||= []).push(number);
    const detail=window.__mockAuthFailure || {
     code:'auth/error-code:-39',message:'Firebase: Error (auth/error-code:-39).'
    };
    throw Object.assign(new Error(detail.message),{code:detail.code});
   }
   export function onAuthStateChanged(_auth,handler) {handler(null);return ()=>{};}
   export async function signInWithCustomToken() { throw new Error('Not used in Firebase error test'); }
   export async function signOut() {}
  `
 }));

 await page.goto('/account.html');
 await expect(page.locator('#signedOut')).toBeVisible();
 await page.locator('#walletPhone').fill('0791234567');
 await page.locator('#sendCode').click();
 await expect(page.locator('#walletMessage .error')).toContainText('Verification SMS is temporarily unavailable');
 await expect(page.locator('#walletMessage')).not.toContainText(/error-code:-39|backendError/i);
 await expect(page.locator('#confirmCode')).toBeDisabled();

 // Also verify an authorized-hostname/reCAPTCHA error is explained separately.
 await page.evaluate(()=>{window.__mockAuthFailure={
  code:'auth/captcha-check-failed',message:'CAPTCHA_CHECK_FAILED : Hostname match not found'
 };});
 await page.locator('#walletPhone').fill('0912345678');
 await page.locator('#sendCode').click();
 await expect(page.locator('#walletMessage .error')).toContainText('The security check expired or failed');
 expect(await page.evaluate(()=>window.__mockPhoneRequests)).toEqual(['+251791234567','+251912345678']);
 expect(external,'No real Firebase or SMS request should occur').toEqual([]);
});


test('pilot OTP mock signs a new customer into Firebase with phone claim and opens a zero-balance wallet',async({page})=>{
 const external=[];
 let challengeId;
 page.on('request',request=>{
  const url=new URL(request.url());
  if(!['127.0.0.1','localhost'].includes(url.hostname))external.push(request.url());
  if(url.pathname==='/api/customer/create-request'&&request.method()==='POST'){
   const data=request.postDataJSON();
   if(data?.action==='afro-otp-verify')challengeId=data.challengeId;
  }
 });

 // Only localhost emulators run this test; the provider is an isolated fake.
 await page.goto('/account.html');
 await expect(page.locator('#afroOtpOption')).toBeVisible();
 await expect(page.locator('#sendAfroCode')).toBeEnabled();
 await page.locator('#walletPhone').fill('0911000707');
 await page.locator('#sendAfroCode').click();
 await expect(page.locator('#walletMessage')).toContainText('SMS request accepted');
 await expect(page.locator('#verifyAfroCode')).toBeEnabled();

 // The local-only fake sends no SMS. Its static test code is never valid live.
 await page.locator('#verificationCode').fill('123456');
 await page.locator('#verifyAfroCode').click();
 await expect(page.locator('#registration')).toBeVisible();
 const first=await page.evaluate(async()=>{
  const {auth}=await import('/firebase.js');
  const user=auth.currentUser;
  const token=await user.getIdTokenResult(true);
  return {uid:user.uid,phone:user.phoneNumber,claim:token.claims.phone_number};
 });
 expect(first.uid).toMatch(/^[a-zA-Z0-9_-]+$/);
 expect(first.phone).toBe('+251911000707');
 expect(first.claim).toBe('+251911000707');
 expect(challengeId).toMatch(/^[a-f0-9]{32}$/);

 // A valid OTP can be redeemed exactly once, including after Firebase sign-in.
 const reused=await page.evaluate(async challengeId=>{
  const result=await fetch('/api/customer/create-request',{
   method:'POST',headers:{'content-type':'application/json'},
   body:JSON.stringify({action:'afro-otp-verify',challengeId,code:'123456'})
  });
  return {status:result.status,ok:(await result.json()).ok};
 },challengeId);
 expect(reused.ok).toBe(false);
 expect(reused.status).toBeGreaterThanOrEqual(400);

 await page.locator('#walletName').fill('Synthetic OTP Customer');
 await page.locator('#registerWallet').click();
 await expect(page.locator('#walletDashboard')).toBeVisible();
 await expect(page.locator('#walletBalance')).toHaveText('0.00 ETB');
 expect(await page.locator('#submitDeposit').isDisabled()).toBe(true);

 // Second sign-in with the same phone must reuse its UID and wallet.
 await page.locator('#walletSignOut').click();
 await expect(page.locator('#signedOut')).toBeVisible();
 await page.locator('#walletPhone').fill('0911000707');
 await page.locator('#sendAfroCode').click();
 await expect(page.locator('#walletMessage')).toContainText('SMS request accepted');
 await page.locator('#verificationCode').fill('123456');
 await page.locator('#verifyAfroCode').click();
 await expect(page.locator('#walletDashboard')).toBeVisible();
 const second=await page.evaluate(async()=>{
  const {auth}=await import('/firebase.js');
  return {uid:auth.currentUser.uid,phone:auth.currentUser.phoneNumber};
 });
 expect(second.uid).toBe(first.uid);
 expect(second.phone).toBe(first.phone);
 expect(await page.locator('#walletBalance').textContent()).toBe('0.00 ETB');
 expect(external,'The browser must not call live SMS/Firebase endpoints').toEqual([]);
});

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

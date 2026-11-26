'use strict';
const {test,expect}=require('@playwright/test');

const PROJECT='demo-tigray-wallet';
const EMAIL='email.wallet.customer@tigray.test';
const PASSWORD='VerifiedEmail!2026';
const UNVERIFIED_EMAIL='unverified.wallet.customer@tigray.test';
const externalRequests=new WeakMap();

async function oobCodes(request){
 const response=await request.get(`http://127.0.0.1:9099/emulator/v1/projects/${PROJECT}/oobCodes`);
 expect(response.ok()).toBeTruthy();
 return (await response.json()).oobCodes||[];
}
async function latestCode(request,email,mode){
 await expect.poll(async()=>{
  const codes=await oobCodes(request);
  return codes.some(item=>item.email===email&&(item.requestType===mode||item.mode===mode));
 }).toBe(true);
 const codes=await oobCodes(request);
 return [...codes].reverse().find(item=>item.email===email&&(item.requestType===mode||item.mode===mode));
}
async function followEmulatorAction(page,item){
 expect(item?.oobLink).toMatch(/^http:\/\/(?:127\.0\.0\.1|localhost):9099\//);
 await page.goto(item.oobLink);
 const button=page.getByRole('button',{name:/continue|verify|confirm/i}).first();
 if(await button.isVisible().catch(()=>false))await button.click();
}

test.describe.serial('verified email customer wallet authentication',()=>{
 test.beforeEach(async({page})=>{
  const external=[];
  externalRequests.set(page,external);
  page.on('request',request=>{
   const host=new URL(request.url()).hostname;
   if(!['127.0.0.1','localhost'].includes(host))external.push(request.url());
  });
 });
 test.afterEach(async({page})=>expect(externalRequests.get(page),'browser made an external request').toEqual([]));

 test('unverified email cannot call wallet registration',async({page})=>{
  await page.goto('/account.html');
  await expect(page.locator('#walletLoginPanel')).toBeVisible();
  await expect(page.locator('#walletRegisterPanel')).toBeHidden();
  await expect(page.locator('#walletResetPanel')).toBeHidden();
  await page.getByRole('button',{name:'Register now'}).click();
  await page.locator('#emailFullName').fill('Unverified Wallet Customer');
  await page.locator('#registerEmail').fill(UNVERIFIED_EMAIL);
  await page.locator('#registerPassword').fill(PASSWORD);
  await page.locator('#emailContactPhone').fill('0711000201');
  await page.getByRole('button',{name:'Create account'}).click();
  await expect(page.locator('#verifyEmail')).toBeVisible();
  const result=await page.evaluate(async()=>{
   const {auth}=await import('/firebase.js');
   const token=await auth.currentUser.getIdToken();
   const response=await fetch('/api/customer/create-request',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({action:'wallet-register',name:'Unverified Wallet Customer',contactPhone:'0711000201'})});
   return {status:response.status,body:await response.json()};
  });
  expect(result.status).toBe(403);
  expect(result.body.error).toMatch(/verify/i);
  await page.locator('#verificationSignOut').click();
 });

 test('registration link verification creates exactly one zero-balance wallet',async({page,request})=>{
  await page.goto('/account.html');
  await page.getByRole('button',{name:'Register now'}).click();
  await page.locator('#emailFullName').fill('Verified Email Customer');
  await page.locator('#registerEmail').fill(EMAIL);
  await page.locator('#registerPassword').fill(PASSWORD);
  await page.locator('#emailContactPhone').fill('0911000202');
  await page.getByRole('button',{name:'Create account'}).click();
  await expect(page.locator('#verifyEmail')).toBeVisible();
  const verification=await latestCode(request,EMAIL,'VERIFY_EMAIL');
  await followEmulatorAction(page,verification);
  await page.goto('/account.html');
  await page.getByRole('button',{name:'I verified my email'}).click();
  await expect(page.locator('#registration')).toBeVisible();
  await page.locator('#registerWallet').click();
  await expect(page.locator('#walletDashboard')).toBeVisible();
  await expect(page.locator('#walletBalance')).toHaveText('0.00 ETB');
  const repeat=await page.evaluate(async()=>{
   const {auth}=await import('/firebase.js');
   const token=await auth.currentUser.getIdToken();
   const response=await fetch('/api/customer/create-request',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({action:'wallet-register',name:'Verified Email Customer',contactPhone:'0911000202'})});
   return {status:response.status,body:await response.json()};
  });
  expect(repeat.status).toBe(200);
  expect(repeat.body.customer.balanceSantim).toBe(0);
 });

 test('email logout, login, reset and duplicate registration are handled clearly',async({page,request})=>{
  await page.goto('/account.html');
  await page.locator('#loginEmail').fill(EMAIL);
  await page.locator('#loginPassword').fill(PASSWORD);
  await page.getByRole('button',{name:'Sign in'}).click();
  await expect(page.locator('#walletDashboard')).toBeVisible();
  await page.locator('#walletSignOut').click();
  await expect(page.locator('#signedOut')).toBeVisible();

  await page.locator('#loginEmail').fill(EMAIL);
  await page.locator('#forgotPassword').click();
  await expect(page.locator('#resetEmail')).toHaveValue(EMAIL);
  const codes=await oobCodes(request);
  expect(codes.some(item=>item.email===EMAIL&&(item.requestType==='PASSWORD_RESET'||item.mode==='PASSWORD_RESET'))).toBe(false);
  await page.getByRole('button',{name:'Send reset link'}).click();
  await expect(page.locator('#walletMessage')).toContainText(/password reset link will be sent/i);
  expect(await latestCode(request,EMAIL,'PASSWORD_RESET')).toBeTruthy();

  await page.getByRole('button',{name:'Back to sign in'}).click();
  await page.getByRole('button',{name:'Register now'}).click();
  await page.locator('#emailFullName').fill('Duplicate Customer');
  await page.locator('#registerEmail').fill(EMAIL);
  await page.locator('#registerPassword').fill(PASSWORD);
  await page.locator('#emailContactPhone').fill('0911000203');
  await page.getByRole('button',{name:'Create account'}).click();
  await expect(page.locator('#walletMessage')).toContainText(/already exists/i);
 });
});

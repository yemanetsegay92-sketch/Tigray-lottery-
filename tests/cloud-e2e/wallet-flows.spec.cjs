'use strict';
process.env.METADATA_SERVER_DETECTION='none';
const {test,expect}=require('@playwright/test');
const {getApps,initializeApp,deleteApp}=require('firebase-admin/app');
const {getFirestore,FieldValue}=require('firebase-admin/firestore');

if(process.env.LOCAL_EMULATOR_ONLY!=='true'||process.env.GCLOUD_PROJECT!=='demo-tigray-wallet'||
 process.env.FIRESTORE_EMULATOR_HOST!=='127.0.0.1:8080'||process.env.FIREBASE_AUTH_EMULATOR_HOST!=='127.0.0.1:9099')
 throw new Error('Cloud E2E refuses to run outside the demo-tigray-wallet localhost emulators.');

const adminApp=initializeApp({projectId:'demo-tigray-wallet'},'playwright-cloud-e2e');
const db=getFirestore(adminApp);
const externalRequests=new WeakMap();
let rfRequestId='';
let standardRequestId='';

async function signIn(page,email,target){
 await page.goto('/local-login');
 await page.getByRole('button',{name:new RegExp(email.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'i')}).click();
 await page.waitForURL(url=>url.pathname===target);
}
async function openGmWallet(page){
 await signIn(page,'gm.local@tigray.test','/admin/general.html');
 await expect(page.locator('html')).toHaveClass(/admin-verified/);
 await page.locator('#workspaceNav [data-view="wallet"]').click();
 await expect(page.locator('#walletFinance')).not.toContainText('Loading');
}
async function dialogs(page,prompts,action){
 let index=0,finish;
 const completed=new Promise(resolve=>{finish=resolve});
 const handler=async dialog=>{
  if(dialog.type()==='prompt')await dialog.accept(String(prompts[index++]));
  else if(dialog.type()==='confirm'){await dialog.accept();finish();}
  else await dialog.dismiss();
 };
 page.on('dialog',handler);
 try{await action();await completed;expect(index).toBe(prompts.length);}
 finally{page.off('dialog',handler);}
}
async function walletRequests(){
 const snapshot=await db.collection('ticketRequests').where('uid','==','customer-local-2').get();
 return snapshot.docs.map(doc=>({id:doc.id,...doc.data()})).filter(item=>item.paymentMethod==='wallet');
}

test.describe.serial('demo wallet browser flows',()=>{
 test.beforeEach(async({page})=>{
  const blocked=[];externalRequests.set(page,blocked);
  page.on('request',request=>{
   const url=new URL(request.url());
   if(!['127.0.0.1','localhost'].includes(url.hostname))blocked.push(request.url());
  });
 });
 test.afterEach(async({page})=>expect(externalRequests.get(page),'browser made an external request').toEqual([]));
 test.afterAll(async()=>deleteApp(adminApp));

 test('customer registers a phone-verified wallet through the real account screen',async({page})=>{
  await signIn(page,'customer2.local@tigray.test','/account.html');
  await expect(page.locator('#registration')).toBeVisible();
  await page.locator('#walletName').fill('Local Customer Two');
  await page.locator('#registerWallet').click();
  await expect(page.locator('#walletDashboard')).toBeVisible();
  await expect(page.locator('#walletBalance')).toHaveText('0.00 ETB');
 });

 test('deposit minimum, duplicate RF protection, mock provider and GM approval work end to end',async({page})=>{
  await signIn(page,'customer2.local@tigray.test','/account.html');
  await page.locator('#walletName').evaluate(element=>{element.value='Local Customer Two'});
  await page.locator('#depositAmount').fill('99.99');
  await page.locator('#depositReference').fill('FTLOCALTOOLOW01');
  await page.locator('#submitDeposit').click();
  await expect(page.locator('#walletMessage')).toContainText(/minimum|100 ETB/i);

  await page.locator('#depositAmount').fill('100');
  await page.locator('#depositReference').fill('FTLOCALDEPOSIT02');
  await page.locator('#submitDeposit').click();
  await expect(page.locator('#walletActivity')).toContainText('FTLOCALDEPOSIT02');
  await page.locator('#submitDeposit').click();
  await expect(page.locator('#walletActivity').getByText(/Deposit FTLOCALDEPOSIT02/)).toHaveCount(1);

  await signIn(page,'customer1.local@tigray.test','/account.html');
  await page.locator('#walletName').evaluate(element=>{element.value='Local Customer One'});
  await page.locator('#depositAmount').fill('100');
  await page.locator('#depositReference').fill('FTLOCALDEPOSIT02');
  await page.locator('#submitDeposit').click();
  await expect(page.locator('#walletMessage')).toContainText(/already|reference/i);

  await openGmWallet(page);
  const row=page.locator('#walletFinance tr').filter({hasText:'FTLOCALDEPOSIT02'});
  await expect(row).toBeVisible();
  await dialogs(page,[
   'Local Customer Two',new Date().toISOString(),'1000000000001','Tigray Lottery Local',
   'Synthetic independent review of receiver amount status date and payer ownership'
  ],()=>row.locator('[data-deposit]').click());
  await expect(page.locator('#walletFinance')).not.toContainText('FTLOCALDEPOSIT02');

  await signIn(page,'customer2.local@tigray.test','/account.html');
  await expect(page.locator('#walletBalance')).toHaveText('100.00 ETB');
 });

 test('RF-only checkout rejects uploads, submits a reference, rejects insufficient funds and assigns wallet tickets',async({page})=>{
  await signIn(page,'customer2.local@tigray.test','/account.html');
  await page.goto('/buy.html?lot=local-rf-lottery');
  await expect(page.locator('#lotteryInfo')).toContainText('Local RF-only Lottery');
  await expect(page.locator('#screenshot')).toBeDisabled();
  await page.locator('#name').fill('Local Customer Two');
  await page.locator('#phone').fill('0911000102');
  await page.locator('#submitBtn').click();
  expect(await page.locator('#reference').evaluate(element=>element.validity.valueMissing)).toBe(true);
  await page.locator('#reference').fill('FTRFONLYE2E01');
  await page.locator('#submitBtn').click();
  await expect(page.locator('#message .success')).toBeVisible();
  await expect(page.locator('#buyForm')).toBeHidden();

  await page.goto('/buy.html?lot=local-rf-lottery');
  await expect(page.locator('#lotteryInfo')).toContainText('Local RF-only Lottery');
  await expect(page.locator('#walletBuyBtn')).toBeVisible();
  await page.locator('#quantity').fill('5');
  await page.locator('#walletBuyBtn').click();
  await expect(page.locator('#message')).toContainText(/Insufficient wallet balance/i);
  await page.locator('#quantity').fill('2');
  await page.locator('#walletBuyBtn').click();
  await expect(page.locator('#message')).toContainText('Tickets assigned instantly');

  await page.goto('/buy.html?lot=local-standard-lottery');
  await expect(page.locator('#lotteryInfo')).toContainText('Local Standard Lottery');
  await expect(page.locator('#walletBuyBtn')).toBeVisible();
  await page.locator('#walletBuyBtn').click();
  await expect(page.locator('#message')).toContainText('Tickets assigned instantly');
  const requests=await walletRequests();
  rfRequestId=requests.find(item=>item.lotteryId==='local-rf-lottery'&&item.status==='approved')?.id||'';
  standardRequestId=requests.find(item=>item.lotteryId==='local-standard-lottery'&&item.status==='approved')?.id||'';
  expect(rfRequestId).toBeTruthy();expect(standardRequestId).toBeTruthy();
 });

 test('Lottery Admin dashboards isolate assigned lotteries and reject financial mutations',async({page})=>{
  await signIn(page,'rf.admin.local@tigray.test','/admin/lottery.html');
  await expect(page.locator('html')).toHaveClass(/admin-verified/);
  await page.locator('#workspaceNav [data-view="wallet"]').click();
  await expect(page.locator('#walletFinance')).toContainText(rfRequestId);
  await expect(page.locator('#walletFinance')).not.toContainText(standardRequestId);

  await signIn(page,'standard.admin.local@tigray.test','/admin/lottery.html');
  await expect(page.locator('html')).toHaveClass(/admin-verified/);
  await page.locator('#workspaceNav [data-view="wallet"]').click();
  await expect(page.locator('#walletFinance')).toContainText(standardRequestId);
  await expect(page.locator('#walletFinance')).not.toContainText(rfRequestId);
  const denied=await page.evaluate(async obligationId=>{
   const {auth}=await import('/firebase.js');
   const token=await auth.currentUser.getIdToken();
   const response=await fetch('/api/admin/approvals',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({action:'wallet-settle',obligationId,amountSantim:1000})});
   return {status:response.status,body:await response.json()};
  },standardRequestId);
  expect(denied.status).toBe(403);
  expect(denied.body.error).toMatch(/General Manager/i);
 });

 test('GM records a partial settlement; duplicate transfer and post-settlement refund are blocked',async({page})=>{
  await openGmWallet(page);
  const rfRow=page.locator(`#walletFinance tr:has([data-settle="${rfRequestId}"])`);
  await dialogs(page,['10','SETTLEE2E0001','1000000000099','Local RF Owner',new Date().toISOString(),'Synthetic completed transfer independently reviewed'],()=>rfRow.locator('[data-settle]').click());
  await expect(page.locator('#walletFinance')).toContainText('SETTLEE2E0001');
  await expect(page.locator(`#walletFinance tr:has([data-settle="${rfRequestId}"])`)).toContainText('40.00 ETB');

  const standardRow=page.locator(`#walletFinance tr:has([data-settle="${standardRequestId}"])`);
  await dialogs(page,['10','SETTLEE2E0001','1000000000088','Local Standard Owner',new Date().toISOString(),'Synthetic duplicate transfer reference review'],()=>standardRow.locator('[data-settle]').click());
  await expect(page.locator('#walletFinanceMessage')).toContainText(/already been used/i);

  await dialogs(page,['Attempt refund after partial settlement'],()=>rfRow.locator('[data-refund]').click());
  await expect(page.locator('#walletFinanceMessage')).toContainText(/settled owner obligation cannot be refunded/i);
 });

 test('GM refunds an unsettled purchase while preserving its ticket and audit history',async({page})=>{
  await openGmWallet(page);
  const row=page.locator(`#walletFinance tr:has([data-refund="${standardRequestId}"])`);
  await dialogs(page,['Synthetic customer cancellation'],()=>row.locator('[data-refund]').click());
  await expect.poll(async()=>(await db.collection('ticketRequests').doc(standardRequestId).get()).data()?.status).toBe('cancelled');
  await expect(page.locator(`[data-refund="${standardRequestId}"]`)).toHaveCount(0);
  const request=(await db.collection('ticketRequests').doc(standardRequestId).get()).data();
  expect(request.status).toBe('cancelled');
  const ticket=(await db.collection('tickets').doc('local-standard-lottery_'+request.ticketNumbers[0]).get()).data();
  expect(ticket.status).toBe('cancelled');
  expect((await db.collection('walletFinancialAudits').doc('refund_'+standardRequestId).get()).exists).toBe(true);
 });

 test('drawn lottery blocks refunds without corrupting ticket history',async({page})=>{
  await signIn(page,'customer2.local@tigray.test','/account.html');
  await page.goto('/buy.html?lot=local-standard-lottery');
  await expect(page.locator('#lotteryInfo')).toContainText('Local Standard Lottery');
  await expect(page.locator('#walletBuyBtn')).toBeVisible();
  await page.locator('#walletBuyBtn').click();
  await expect(page.locator('#message')).toContainText('Tickets assigned instantly');
  const requests=await walletRequests();
  const drawn=requests.find(item=>item.lotteryId==='local-standard-lottery'&&item.status==='approved');
  expect(drawn?.id).toBeTruthy();
  await db.collection('lotteries').doc('local-standard-lottery').update({status:'drawn',drawnNumber:'2001',drawnAt:FieldValue.serverTimestamp()});

  await openGmWallet(page);
  const row=page.locator(`#walletFinance tr:has([data-refund="${drawn.id}"])`);
  await dialogs(page,['Attempt refund after finalized draw'],()=>row.locator('[data-refund]').click());
  await expect(page.locator('#walletFinanceMessage')).toContainText(/Drawn or finalized/i);
  const unchanged=(await db.collection('ticketRequests').doc(drawn.id).get()).data();
  expect(unchanged.status).toBe('approved');
  const ticket=(await db.collection('tickets').doc('local-standard-lottery_'+unchanged.ticketNumbers[0]).get()).data();
  expect(ticket.status).not.toBe('cancelled');
 });
 test('existing non-phone admin login shows phone sign-in instead of blank wallet page',async({page})=>{
  await signIn(page,'gm.local@tigray.test','/admin/general.html');
  await page.goto('/account.html');
  await expect(page.locator('#signedOut')).toBeVisible();
  await expect(page.locator('#walletPhone')).toBeVisible();
  await expect(page.locator('#walletMessage')).toContainText(/not phone-verified/i);
 });
});

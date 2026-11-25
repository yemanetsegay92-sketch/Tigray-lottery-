'use strict';
const {getApps,initializeApp}=require('firebase-admin/app');
const {getAuth}=require('firebase-admin/auth');
const {getFirestore,FieldValue}=require('firebase-admin/firestore');
const {LOCAL_PROJECT_ID,assertLocalEmulatorEnvironment}=require('../../lib/local-emulator-guard');
assertLocalEmulatorEnvironment();
if(!getApps().length)initializeApp({projectId:LOCAL_PROJECT_ID});
const auth=getAuth(),db=getFirestore(),PASSWORD='LocalTest!2026';
const accounts=[
 {uid:'gm-local',email:'gm.local@tigray.test',displayName:'Local General Manager'},
 {uid:'lottery-admin-rf',email:'rf.admin.local@tigray.test',displayName:'Local RF Admin'},
 {uid:'lottery-admin-standard',email:'standard.admin.local@tigray.test',displayName:'Local Standard Admin'},
 {uid:'customer-local-1',email:'customer1.local@tigray.test',phoneNumber:'+251911000101',displayName:'Local Customer One'},
 {uid:'customer-local-2',email:'customer2.local@tigray.test',phoneNumber:'+251911000102',displayName:'Local Customer Two'}
];
async function upsertUser(user){
 const data={email:user.email,password:PASSWORD,displayName:user.displayName,emailVerified:true,
  disabled:false,...(user.phoneNumber?{phoneNumber:user.phoneNumber}:{})};
 try{await auth.getUser(user.uid);await auth.updateUser(user.uid,data);}catch(error){if(error.code!=='auth/user-not-found')throw error;await auth.createUser({uid:user.uid,...data});}
}
async function createIfMissing(ref,data){if(!(await ref.get()).exists)await ref.create(data);}
(async()=>{
 for(const account of accounts)await upsertUser(account);
 await db.collection('users').doc('gm-local').set({role:'generalAdmin',displayName:'Local General Manager',email:'gm.local@tigray.test',lotteryIds:[],localSynthetic:true},{merge:true});
 await db.collection('users').doc('lottery-admin-rf').set({role:'lotteryAdmin',displayName:'Local RF Admin',email:'rf.admin.local@tigray.test',lotteryIds:['local-rf-lottery'],localSynthetic:true},{merge:true});
 await db.collection('users').doc('lottery-admin-standard').set({role:'lotteryAdmin',displayName:'Local Standard Admin',email:'standard.admin.local@tigray.test',lotteryIds:['local-standard-lottery'],localSynthetic:true},{merge:true});
 const now=FieldValue.serverTimestamp();
 await db.collection('companyWalletConfig').doc('tigray-lottery').set({companyId:'tigray-lottery',bank:'CBE',
  receivingAccount:'1000000000001',receivingHolderName:'Tigray Lottery Local',localSynthetic:true,
  createdAt:now,updatedAt:now,updatedBy:'gm-local'},{merge:true});
 await createIfMissing(db.collection('lotteries').doc('local-rf-lottery'),{
  companyId:'tigray-lottery',name:'Local RF-only Lottery',description:'Synthetic RF-only local test lottery',
  price:25,min:1000,max:1099,nextTicketNumber:1000,status:'active',approvalMode:'manual',
  paymentEvidenceMode:'reference_only',adminIds:['lottery-admin-rf'],awards:['Synthetic first prize'],
  paymentAccounts:[{bank:'CBE',number:'1000000000001',holderName:'Tigray Lottery Local'}],createdAt:now
 });
 await createIfMissing(db.collection('lotteries').doc('local-standard-lottery'),{
  companyId:'tigray-lottery',name:'Local Standard Lottery',description:'Synthetic standard local test lottery',
  price:50,min:2000,max:2099,nextTicketNumber:2000,status:'active',approvalMode:'manual',
  paymentEvidenceMode:'standard',adminIds:['lottery-admin-standard'],awards:['Synthetic first prize'],
  paymentAccounts:[{bank:'CBE',number:'1000000000002',holderName:'Local Standard Owner'}],createdAt:now
 });
 await createIfMissing(db.collection('customerProfiles').doc('customer-local-1'),{
  uid:'customer-local-1',companyId:'tigray-lottery',phone:'0911000101',phoneVerified:true,
  name:'Local Customer One',localSynthetic:true,createdAt:now,updatedAt:now
 });
 await createIfMissing(db.collection('walletAccounts').doc('tigray-lottery_customer-local-1'),{
  uid:'customer-local-1',companyId:'tigray-lottery',balanceSantim:20000,localSynthetic:true,createdAt:now,updatedAt:now
 });
 await createIfMissing(db.collection('depositRequests').doc('local-deposit-customer-1'),{
  uid:'customer-local-1',companyId:'tigray-lottery',amountSantim:10000,reference:'FTLOCALDEPOSIT01',
  status:'pending',phoneLast4:'0101',legalName:'Local Customer One',localSynthetic:true,
  createdAt:now,createdAtMs:Date.now()
 });
 console.log('Synthetic Auth and Firestore data are ready.');
 console.log('Password for every local email account: '+PASSWORD);
 console.log('Customer Two intentionally has no wallet profile yet so registration can be tested.');
})().catch(error=>{console.error(error);process.exitCode=1;});

'use strict';
const crypto=require('node:crypto');
const {FieldValue}=require('firebase-admin/firestore');
const {fail,normalizePhone,keyedHash,assertEligible,validCode,validChallengeId,
 verifiedProviderResponse,getClientIp}=require('./afro-otp-core');
const liveProvider=require('./afro-otp-provider');
const TTL_MS=5*60*1000,WINDOW_MS=30*60*1000,MAX_ATTEMPTS=5;

function rate(ref,doc,maximum){
 const count=doc.exists?Number(doc.data()?.count):0;
 if(!Number.isInteger(count)||count<0||count>=maximum)
  throw fail('Too many verification requests. Please try later.',429);
 return {ref,count:count+1};
}
function dayKey(ms){return new Date(ms).toISOString().slice(0,10).replace(/-/g,'');}
function dailyCap(env){
 const n=Number(env.AFROMESSAGE_DAILY_SMS_CAP||10);
 // Published beta accounts have a 100 SMS/day ceiling. Keep a lower local cap.
 if(!Number.isInteger(n)||n<1||n>100)throw fail('OTP spending limit is misconfigured.',503);
 return n;
}
async function findOrCreateCustomer(db,auth,phone){
 let user;
 try{user=await auth.getUserByPhoneNumber(phone)}
 catch(error){
  if(error?.code!=='auth/user-not-found')throw error;
  try{user=await auth.createUser({phoneNumber:phone,disabled:false})}
  catch(createError){
   if(createError?.code!=='auth/phone-number-already-exists')throw createError;
   user=await auth.getUserByPhoneNumber(phone);
  }
 }
 if(user.disabled)throw fail('Account is not available. Contact support.',403);
 // A customer OTP must never become a shortcut into an admin account.
 const profile=await db.collection('users').doc(user.uid).get();
 if(['generalAdmin','lotteryAdmin'].includes(profile.data()?.role)||user.customClaims?.admin||
    ['generalAdmin','lotteryAdmin'].includes(user.customClaims?.role))
  throw fail('This account cannot use customer SMS sign-in.',403);
 return user;
}
function createOtpService({db,auth,provider=liveProvider,env=process.env,clock=Date.now}){
 if(!db||!auth)throw new Error('Database and Firebase Auth are required.');
 async function start({phone:raw,ip='unknown'}){
  const phone=normalizePhone(raw);
  assertEligible(phone,env);
  const ms=clock(),pHash=keyedHash(phone,env),ipHash=keyedHash(String(ip),env);
  const bucket=Math.floor(ms/WINDOW_MS);
  const challengeId=crypto.randomBytes(16).toString('hex');
  const challengeRef=db.collection('afroOtpChallenges').doc(challengeId);
  const rateRefs=[
   {ref:db.collection('afroOtpRates').doc('phone_'+pHash+'_'+bucket),max:3},
   {ref:db.collection('afroOtpRates').doc('ip_'+ipHash+'_'+bucket),max:8},
   {ref:db.collection('afroOtpRates').doc('global_'+dayKey(ms)),max:dailyCap(env)}
  ];
  await db.runTransaction(async tx=>{
   const docs=await Promise.all(rateRefs.map(x=>tx.get(x.ref)));
   const counts=rateRefs.map((x,i)=>rate(x.ref,docs[i],x.max));
   // SMS cost is reserved atomically before the external provider is called.
   tx.create(challengeRef,{phone,phoneHash:pHash,state:'sending',createdAtMs:ms,
    expiresAtMs:ms+TTL_MS,expiresAt:new Date(ms+TTL_MS),attempts:0});
   counts.forEach(x=>tx.set(x.ref,{count:x.count,updatedAt:FieldValue.serverTimestamp(),
    expiresAt:new Date(ms+3*86400000)},{merge:true}));
  });
  try{
   const result=await provider.sendOtp(phone,{env});
   await db.runTransaction(async tx=>{
    const snap=await tx.get(challengeRef);
    if(!snap.exists||snap.data()?.state!=='sending')throw fail('OTP request was interrupted.',503);
    tx.update(challengeRef,{state:'sent',verificationId:result.verificationId,
     updatedAt:FieldValue.serverTimestamp()});
   });
  }catch(error){
   await challengeRef.update({state:'failed',updatedAt:FieldValue.serverTimestamp()}).catch(()=>{});
   if(error?.statusCode===429)throw error;
   throw fail('SMS could not be sent. Please try later.',503);
  }
  return {challengeId,expiresInSeconds:300};
 }
 async function verify({challengeId,code}){
  if(!validChallengeId(challengeId)||!validCode(code))throw fail('Invalid verification request.');
  // This also blocks verification after the commercial/pilot permission is revoked.
  const ref=db.collection('afroOtpChallenges').doc(challengeId),ms=clock();
  const claim=crypto.randomBytes(12).toString('hex');
  let saved;
  await db.runTransaction(async tx=>{
   const snap=await tx.get(ref);
   if(!snap.exists)throw fail('Code is invalid or expired.',400);
   const d=snap.data();
   assertEligible(d.phone,env);
   if(d.expiresAtMs<=ms)throw fail('Code is invalid or expired.',400);
   if(d.state==='verifying' && d.leaseUntilMs>ms)throw fail('Verification is already in progress.',409);
   if(!['sent','verifying'].includes(d.state)||d.attempts>=MAX_ATTEMPTS)
    throw fail('Code is invalid or expired.',400);
   saved={phone:d.phone,verificationId:d.verificationId};
   if(!/^[-a-zA-Z0-9]{10,120}$/.test(String(saved.verificationId||'')))
    throw fail('Verification cannot continue.',503);
   tx.update(ref,{state:'verifying',claim,leaseUntilMs:ms+20000,
    attempts:d.attempts+1,updatedAt:FieldValue.serverTimestamp()});
  });
  let result;
  try{result=await provider.verifyOtp(saved.phone,saved.verificationId,code,{env})}
  catch{result=null}
  if(!verifiedProviderResponse(result,saved.phone,saved.verificationId,code)){
   await db.runTransaction(async tx=>{
    const snap=await tx.get(ref);
    if(snap.exists&&snap.data()?.claim===claim&&snap.data()?.state==='verifying'){
     tx.update(ref,{state:snap.data().attempts>=MAX_ATTEMPTS?'failed':'sent',
      claim:null,leaseUntilMs:0,updatedAt:FieldValue.serverTimestamp()});
    }
   });
   throw fail('Incorrect or expired verification code.',400);
  }
  // Consume exactly once before minting credentials. Provider success alone is
  // not enough; the original phone, verificationId and code must all match.
  await db.runTransaction(async tx=>{
   const snap=await tx.get(ref),d=snap.data();
   if(!snap.exists||d.state!=='verifying'||d.claim!==claim||
     d.expiresAtMs<=clock())throw fail('Code is invalid or already used.',409);
   tx.update(ref,{state:'consumed',claim:null,leaseUntilMs:0,consumedAtMs:clock(),
    updatedAt:FieldValue.serverTimestamp()});
  });
  const user=await findOrCreateCustomer(db,auth,saved.phone);
  const customToken=await auth.createCustomToken(user.uid);
  return {customToken};
 }
 return {start,verify};
}
module.exports={createOtpService,findOrCreateCustomer,dailyCap};

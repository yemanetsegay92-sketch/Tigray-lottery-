'use strict';
const crypto=require('node:crypto');

function fail(message,statusCode=400){return Object.assign(new Error(message),{statusCode});}
function normalizePhone(value){
 const digits=String(value||'').replace(/[\s()-]/g,'');
 if(/^0[79]\d{8}$/.test(digits))return '+251'+digits.slice(1);
 if(/^\+251[79]\d{8}$/.test(digits))return digits;
 if(/^251[79]\d{8}$/.test(digits))return '+'+digits;
 throw fail('Enter a valid Ethiopian mobile number beginning with 09 or 07.');
}
function keyedHash(value,env=process.env){
 const secret=String(env.AFROMESSAGE_PHONE_HASH_KEY||'');
 if(secret.length<32)throw fail('OTP service is not configured.',503);
 return crypto.createHmac('sha256',secret).update(String(value)).digest('hex');
}
function isDemo(env=process.env){
 return env.LOCAL_EMULATOR_ONLY==='true'&&
  env.GCLOUD_PROJECT==='demo-tigray-wallet'&&
  env.FIRESTORE_EMULATOR_HOST==='127.0.0.1:8080'&&
  env.FIREBASE_AUTH_EMULATOR_HOST==='127.0.0.1:9099'&&
  env.AFROMESSAGE_MOCK_PROVIDER==='true';
}
function enabled(env=process.env){
 if(env.AFROMESSAGE_OTP_ENABLED!=='true')return false;
 if(isDemo(env))return true;
 return env.VERCEL_ENV==='production'&&
   Boolean(env.AFROMESSAGE_API_TOKEN)&&
   String(env.AFROMESSAGE_PHONE_HASH_KEY||'').length>=32;
}
function assertEligible(phone,env=process.env){
 if(!enabled(env))throw fail('Alternative SMS verification is not available.',503);
 if(isDemo(env))return;
 // Public registration deliberately remains unavailable in this pilot PR.
 // A separate security review must implement a commercial abuse-control flow.
 // During beta, permit only specific preverified test contacts. These are
 // HMAC digests, not telephone numbers. The official provider may impose
 // additional restrictions that our app cannot bypass.
 const allowed=String(env.AFROMESSAGE_PILOT_PHONE_HASHES||'').split(',').map(x=>x.trim().toLowerCase());
 if(!allowed.includes(keyedHash(phone,env)))throw fail('SMS pilot is not available for this number.',403);
}
function verifiedProviderResponse(payload,phone,verificationId,code){
 const r=payload?.response;
 return payload?.acknowledge==='success'&&r&&
  r.phone===phone&&r.verificationId===verificationId&&r.code===code;
}
function validChallengeId(value){return typeof value==='string'&&/^[a-f0-9]{32}$/.test(value);}
function validCode(value){return typeof value==='string'&&/^\d{6}$/.test(value);}
function getClientIp(req,env=process.env){
 if(isDemo(env))return '127.0.0.1';
 // Only the platform-controlled, single-hop Vercel address can drive limits.
 // Do not allow a caller-supplied x-real-ip or comma-separated chain.
 const ip=require('./public-purchase-guard').readVercelClientIp(req);
 if(!ip)throw fail('Could not verify request connection.',503);
 return ip;
}
module.exports={fail,normalizePhone,keyedHash,isDemo,enabled,assertEligible,
 verifiedProviderResponse,validChallengeId,validCode,getClientIp};

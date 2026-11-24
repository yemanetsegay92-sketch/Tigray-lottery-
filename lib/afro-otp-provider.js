'use strict';
// Only server-side code may import this module. AfroMessage's /challenge
// response includes the OTP itself, so never log or return raw responses.
const {fail,isDemo}=require('./afro-otp-core');
async function providerCall(endpoint,params,{env=process.env,fetchImpl=globalThis.fetch}={}){
 if(isDemo(env))throw fail('Test OTP provider must be explicitly injected.',503);
 const token=String(env.AFROMESSAGE_API_TOKEN||'');
 if(!token)throw fail('OTP service is not configured.',503);
 const url=new URL('https://api.afromessage.com/api/'+endpoint);
 for(const [key,value] of Object.entries(params))url.searchParams.set(key,String(value));
 const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),8000);
 try{
  const response=await fetchImpl(url.toString(),{
   method:'GET',headers:{Authorization:'Bearer '+token,Accept:'application/json'},
   signal:controller.signal,redirect:'error',cache:'no-store'
  });
  if(!response.ok)throw fail('SMS provider is temporarily unavailable.',503);
  const raw=await response.text();
  if(raw.length>8192)throw fail('Invalid SMS provider response.',503);
  let result;try{result=JSON.parse(raw)}catch{throw fail('Invalid SMS provider response.',503)}
  // Do not surface or log provider errors; they may contain numbers or codes.
  return result;
 }catch(error){
  if(error?.statusCode)throw error;
  throw fail('SMS provider is temporarily unavailable.',503);
 }finally{clearTimeout(timeout)}
}
async function sendOtp(phone,options={}){
 const result=await providerCall('challenge',{to:phone,ttl:300,len:6,t:0,pr:'Tigray Lottery code: '},options);
 if(result?.acknowledge!=='success'||!/^[-a-zA-Z0-9]{10,120}$/.test(String(result.response?.verificationId||'')))
  throw fail('SMS could not be sent. Please try later.',503);
 return {verificationId:String(result.response.verificationId)};
}
async function verifyOtp(phone,verificationId,code,options={}){
 return providerCall('verify',{to:phone,vc:verificationId,code},options);
}
module.exports={sendOtp,verifyOtp};

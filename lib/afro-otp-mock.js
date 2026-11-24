'use strict';
// Synthetic OTP adapter. NEVER used outside the fully isolated demo emulators.
const {isDemo}=require('./afro-otp-core');
function guard(){if(!isDemo(process.env))throw new Error('Mock OTP provider blocked outside demo emulators.')}
async function sendOtp(phone){
 guard();
 return {verificationId:'local-mock-'+Buffer.from(phone).toString('hex')};
}
async function verifyOtp(phone,verificationId,code){
 guard();
 if(code!=='123456')return {acknowledge:'error',response:{errors:['Invalid synthetic code']}};
 return {acknowledge:'success',response:{phone,verificationId,code}};
}
module.exports={sendOtp,verifyOtp};

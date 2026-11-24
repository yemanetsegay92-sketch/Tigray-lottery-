'use strict';

const LOCAL_PROJECT_ID='demo-tigray-wallet';
function localHostPort(value,port){
 return ['127.0.0.1:'+port,'localhost:'+port].includes(String(value||''));
}
function assertLocalEmulatorEnvironment(env=process.env){
 if(env.LOCAL_EMULATOR_ONLY!=='true')throw new Error('LOCAL_EMULATOR_ONLY must be true.');
 if(String(env.GCLOUD_PROJECT||'')!==LOCAL_PROJECT_ID||String(env.GOOGLE_CLOUD_PROJECT||LOCAL_PROJECT_ID)!==LOCAL_PROJECT_ID)
  throw new Error('Local testing requires the synthetic '+LOCAL_PROJECT_ID+' project.');
 if(!localHostPort(env.FIRESTORE_EMULATOR_HOST,8080)||!localHostPort(env.FIREBASE_AUTH_EMULATOR_HOST,9099))
  throw new Error('Both Firebase emulators must use their localhost-only ports.');
 if(env.FIREBASE_SERVICE_ACCOUNT_JSON||env.GOOGLE_APPLICATION_CREDENTIALS)
  throw new Error('Production/service-account credentials are forbidden in local emulator mode.');
 return {projectId:LOCAL_PROJECT_ID,firestoreHost:env.FIRESTORE_EMULATOR_HOST,authHost:env.FIREBASE_AUTH_EMULATOR_HOST};
}
function assertLocalUrl(value){
 let url;try{url=new URL(String(value));}catch{throw new Error('Invalid local URL.');}
 if(url.protocol!=='http:'||!['127.0.0.1','localhost'].includes(url.hostname))
  throw new Error('Local testing blocked a non-local network request: '+url.hostname);
 return url;
}
module.exports={LOCAL_PROJECT_ID,assertLocalEmulatorEnvironment,assertLocalUrl};

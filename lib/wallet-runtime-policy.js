'use strict';

const FLAGS=Object.freeze({
 registration:'WALLET_REGISTRATION_ENABLED',deposit:'WALLET_DEPOSITS_ENABLED',
 purchase:'WALLET_PURCHASES_ENABLED',refund:'WALLET_REFUNDS_ENABLED',
 settlement:'WALLET_SETTLEMENTS_ENABLED'
});
function projectId(env){
 if(env.GCLOUD_PROJECT)return String(env.GCLOUD_PROJECT);
 if(env.GOOGLE_CLOUD_PROJECT)return String(env.GOOGLE_CLOUD_PROJECT);
 try{return String(JSON.parse(env.FIREBASE_CONFIG||'{}').projectId||'');}catch{return '';}
}
function isolatedTarget(env=process.env){
 const project=projectId(env);
 if(env.FIRESTORE_EMULATOR_HOST&&/^demo-[a-z0-9-]+$/i.test(project))return 'emulator';
 if(env.WALLET_STAGING_MUTATIONS_ENABLED==='true'&&env.WALLET_STAGING_PROJECT_ID&&
    project===env.WALLET_STAGING_PROJECT_ID)return 'staging';
 return '';
}
function assertWalletMutationAllowed(capability,env=process.env){
 const flag=FLAGS[capability];
 if(!flag)throw new Error('Unknown wallet mutation capability.');
 const isolated=isolatedTarget(env);
 if(isolated)return {target:isolated};
 if(env.VERCEL_ENV==='preview')throw Object.assign(new Error('Wallet mutations are disabled in Preview.'),{statusCode:403});
 if(env.VERCEL_ENV!=='production')throw Object.assign(new Error('Wallet mutations require an isolated emulator or staging project.'),{statusCode:403});
 if(env.WALLET_PRODUCTION_MUTATIONS_ENABLED!=='true'||env[flag]!=='true')
  throw Object.assign(new Error('This wallet operation is not authorized in production.'),{statusCode:503});
 return {target:'production'};
}
function walletCapabilities(env=process.env){
 const isolated=!!isolatedTarget(env);
 const production=env.VERCEL_ENV==='production'&&env.WALLET_PRODUCTION_MUTATIONS_ENABLED==='true';
 return Object.fromEntries(Object.entries(FLAGS).map(([capability,flag])=>[
  capability,isolated||(production&&env[flag]==='true')
 ]));
}
module.exports={FLAGS,projectId,isolatedTarget,assertWalletMutationAllowed,walletCapabilities};

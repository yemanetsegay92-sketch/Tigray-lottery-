'use strict';
const {FieldValue}=require('firebase-admin/firestore');
const {COMPANY_ID}=require('./wallet-core');

function problem(message,statusCode=400){return Object.assign(new Error(message),{statusCode});}
function normalizeReceivingAccount(value){
 const number=String(value||'').replace(/\D/g,'');
 if(!/^\d{8,30}$/.test(number))throw problem('Enter a valid CBE account number containing 8 to 30 digits.');
 return number;
}
function normalizeHolderName(value){
 const name=String(value||'').normalize('NFKC').trim().replace(/\s+/g,' ');
 if(name.length<2||name.length>120)throw problem('Enter the CBE account-holder name.');
 return name;
}
function configRef(db){return db.collection('companyWalletConfig').doc(COMPANY_ID);}
function publicReceiver(data={}){
 const account=String(data.receivingAccount||'').replace(/\D/g,''),holderName=String(data.receivingHolderName||'').trim();
 return {configured:/^\d{8,30}$/.test(account)&&holderName.length>=2,bank:'CBE',account,holderName};
}
async function readReceiver(db){const snap=await configRef(db).get();return publicReceiver(snap.exists?snap.data():{});}
async function setReceiver(db,{account,holderName,actorId}){
 if(!actorId)throw problem('Administrator identity is required.',403);
 const receivingAccount=normalizeReceivingAccount(account),receivingHolderName=normalizeHolderName(holderName);
 const ref=configRef(db),audit=db.collection('walletFinancialAudits').doc();
 await db.runTransaction(async tx=>{
  const previous=await tx.get(ref),now=FieldValue.serverTimestamp();
  tx.set(ref,{companyId:COMPANY_ID,bank:'CBE',receivingAccount,receivingHolderName,
    updatedBy:actorId,updatedAt:now,...(previous.exists?{}:{createdAt:now})},{merge:true});
  tx.create(audit,{companyId:COMPANY_ID,operation:'wallet_receiving_account_updated',actorId,
    previousAccountLast4:String(previous.data()?.receivingAccount||'').slice(-4),
    receivingAccountLast4:receivingAccount.slice(-4),receivingHolderName,createdAt:now});
 });
 return publicReceiver({receivingAccount,receivingHolderName});
}
module.exports={configRef,publicReceiver,readReceiver,setReceiver,normalizeReceivingAccount,normalizeHolderName};

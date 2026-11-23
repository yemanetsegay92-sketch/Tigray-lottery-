'use strict';
const http=require('node:http');
const net=require('node:net');
const fs=require('node:fs');
const path=require('node:path');
const {LOCAL_PROJECT_ID,assertLocalEmulatorEnvironment,assertLocalUrl}=require('../../lib/local-emulator-guard');
const ROOT=path.resolve(__dirname,'../..');
const HOST='127.0.0.1',PORT=4174;

delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
Object.assign(process.env,{
 LOCAL_EMULATOR_ONLY:'true',GCLOUD_PROJECT:LOCAL_PROJECT_ID,GOOGLE_CLOUD_PROJECT:LOCAL_PROJECT_ID,
 FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080',FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:9099',
 FIREBASE_CONFIG:JSON.stringify({projectId:LOCAL_PROJECT_ID}),VERCEL_ENV:'preview',
 WALLET_PRODUCTION_MUTATIONS_ENABLED:'false',WALLET_REGISTRATION_ENABLED:'false',
 WALLET_DEPOSITS_ENABLED:'false',WALLET_PURCHASES_ENABLED:'false',WALLET_REFUNDS_ENABLED:'false',
 WALLET_SETTLEMENTS_ENABLED:'false',WALLET_AUTO_DEPOSITS_ENABLED:'false',
 WALLET_STAGING_MUTATIONS_ENABLED:'false',CBE_WALLET_RECEIVING_ACCOUNT:'1000000000001',
 CBE_WALLET_RECEIVER_NAME:'Tigray Lottery Local',CHECK_ET_API_KEY:'local-mock-no-charge',
 CHECK_ET_API_URL:`http://${HOST}:${PORT}/mock/checket`
});
assertLocalEmulatorEnvironment();

const nativeFetch=globalThis.fetch;
globalThis.fetch=(input,options)=>{
 const raw=typeof input==='string'||input instanceof URL?input:input?.url;
 assertLocalUrl(raw);
 return nativeFetch(input,options);
};
// Initialize the Admin SDK only after emulator-only environment validation.
require('../../api/telegram/_lib').adminDb();

function portOpen(port){return new Promise(resolve=>{
 const socket=net.createConnection({host:HOST,port});
 const done=value=>{socket.destroy();resolve(value)};
 socket.setTimeout(800);socket.once('connect',()=>done(true));socket.once('timeout',()=>done(false));socket.once('error',()=>done(false));
});}
async function emulatorHealth(){
 const [firestore,auth]=await Promise.all([portOpen(8080),portOpen(9099)]);
 return {ok:firestore&&auth,projectId:LOCAL_PROJECT_ID,firestore,auth};
}
function json(res,status,data){res.statusCode=status;res.setHeader('content-type','application/json; charset=utf-8');res.end(JSON.stringify(data));}
async function body(req){
 const parts=[];let size=0;
 for await(const chunk of req){size+=chunk.length;if(size>1024*1024)throw Object.assign(new Error('Request too large.'),{statusCode:413});parts.push(chunk);}
 if(!parts.length)return {};
 try{return JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{throw Object.assign(new Error('Invalid JSON.'),{statusCode:400});}
}
function adapt(res){
 res.status=code=>{res.statusCode=code;return res};
 res.json=value=>{res.setHeader('content-type','application/json; charset=utf-8');res.end(JSON.stringify(value));return res};
 res.send=value=>{res.end(value);return res};
 return res;
}
async function api(req,res,modulePath){
 req.body=await body(req);return require(modulePath)(req,adapt(res));
}
async function mockCheckEt(req,res){
 const input=await body(req),reference=String(input.transaction_number||'').toUpperCase();
 const fixtures={
  FTLOCALDEPOSIT01:{amount:100,payer:'Local Customer One'},
  FTLOCALDEPOSIT02:{amount:100,payer:'Local Customer Two'},
  FTLOCALSTANDARD01:{amount:50,payer:'Local Customer One'}
 };
 const fixture=fixtures[reference];
 if(!fixture)return json(res,404,{success:false,exists:false,duplicate:false,code:'not_found',data:{bank:'cbe',transaction_number:reference}});
 return json(res,200,{success:true,exists:true,duplicate:false,code:'verified',data:{
  bank:'cbe',transaction_number:reference,verification_method:'official',receipt:{status:'completed',
   amount:fixture.amount,currency:'ETB',payer_name:fixture.payer,receiver_name:'Tigray Lottery Local',
   receiver_account:'1000000000001',transaction_date:new Date().toISOString()}
 }});
}
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8',
 '.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.webp':'image/webp','.ico':'image/x-icon'};
function staticPath(urlPath){
 if(urlPath==='/firebase.js')return path.join(ROOT,'firebase.local.js');
 if(urlPath==='/local-login'||urlPath==='/local-login.html')return path.join(ROOT,'tools/local/local-login.html');
 let relative=urlPath==='/'?'index.html':decodeURIComponent(urlPath).replace(/^\/+/, '');
 if(!path.extname(relative))relative+='.html';
 const resolved=path.resolve(ROOT,relative);
 return resolved.startsWith(ROOT+path.sep)?resolved:null;
}
const server=http.createServer(async(req,res)=>{
 try{
  const host=String(req.headers.host||'').split(':')[0];
  if(!['127.0.0.1','localhost'].includes(host))return json(res,403,{ok:false,error:'Local server rejects non-local hosts.'});
  const url=new URL(req.url,`http://${HOST}:${PORT}`);
  if(url.pathname==='/__local/health'){
   const health=await emulatorHealth();return json(res,health.ok?200:503,health);
  }
  if(url.pathname==='/mock/checket'&&req.method==='POST')return await mockCheckEt(req,res);
  if(url.pathname==='/api/customer/create-request'&&req.method==='POST')return await api(req,res,'../../api/customer/create-request');
  if(url.pathname==='/api/admin/approvals'&&req.method==='POST')return await api(req,res,'../../api/admin/approvals');
  if(!['GET','HEAD'].includes(req.method))return json(res,405,{ok:false,error:'Local route not enabled.'});
  const file=staticPath(url.pathname);
  if(!file||!fs.existsSync(file)||!fs.statSync(file).isFile())return json(res,404,{ok:false,error:'Not found.'});
  res.statusCode=200;res.setHeader('cache-control','no-store');res.setHeader('content-type',MIME[path.extname(file).toLowerCase()]||'application/octet-stream');
  if(req.method==='HEAD')return res.end();
  fs.createReadStream(file).pipe(res);
 }catch(error){console.error('local server request failed',{message:error?.message,statusCode:error?.statusCode});if(!res.headersSent)json(res,Number(error?.statusCode)||500,{ok:false,error:String(error?.message||'Local request failed.')});else res.end();}
});
server.listen(PORT,HOST,()=>console.log(`Local Tigray Lottery: http://${HOST}:${PORT}`));

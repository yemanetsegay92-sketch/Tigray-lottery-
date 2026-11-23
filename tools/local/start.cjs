'use strict';
const {spawn,spawnSync}=require('node:child_process');
const net=require('node:net');
const path=require('node:path');
const {LOCAL_PROJECT_ID,assertLocalEmulatorEnvironment}=require('../../lib/local-emulator-guard');
assertLocalEmulatorEnvironment();
const ROOT=path.resolve(__dirname,'../..');
const children=[];
let stopping=false;
function waitPort(port,timeoutMs=90000){return new Promise((resolve,reject)=>{
 const started=Date.now();
 const tryOnce=()=>{const socket=net.createConnection({host:'127.0.0.1',port});
  const retry=()=>{socket.destroy();if(Date.now()-started>timeoutMs)reject(new Error('Timed out waiting for localhost:'+port));else setTimeout(tryOnce,300)};
  socket.setTimeout(500);socket.once('connect',()=>{socket.destroy();resolve()});socket.once('error',retry);socket.once('timeout',retry);};tryOnce();
});}
function start(command,args){const child=spawn(command,args,{cwd:ROOT,env:process.env,stdio:'inherit',windowsHide:false});children.push(child);return child;}
function killTree(child){if(!child||child.exitCode!==null)return; if(process.platform==='win32')spawnSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore'});else child.kill('SIGTERM');}
function stop(code=0){if(stopping)return;stopping=true;for(const child of [...children].reverse())killTree(child);process.exit(code);}
process.on('SIGINT',()=>stop(0));process.on('SIGTERM',()=>stop(0));
(async()=>{
 const cli=path.join(ROOT,'node_modules/firebase-tools/lib/bin/firebase.js');
 const emulator=start(process.execPath,[cli,'emulators:start','--config','firebase.local.json','--project',LOCAL_PROJECT_ID,'--only','auth,firestore']);
 emulator.once('exit',code=>{if(!stopping){console.error('Firebase emulators stopped unexpectedly.');stop(code||1);}});
 await Promise.all([waitPort(8080),waitPort(9099),waitPort(4000)]);
 const seeded=spawnSync(process.execPath,['tools/local/seed.cjs'],{cwd:ROOT,env:process.env,stdio:'inherit'});
 if(seeded.status!==0)throw new Error('Synthetic seed failed.');
 const server=start(process.execPath,['tools/local/local-server.cjs'],{cwd:ROOT,env:process.env,stdio:'inherit'});
 server.once('exit',code=>{if(!stopping){console.error('Local API server stopped unexpectedly.');stop(code||1);}});
 await waitPort(4174,30000);
 console.log('\nLocal test environment is ready:');
 console.log('  App and APIs:  http://127.0.0.1:4174');
 console.log('  Test sign-in:  http://127.0.0.1:4174/local-login');
 console.log('  Emulator UI:   http://127.0.0.1:4000');
 console.log('  Firestore:     127.0.0.1:8080');
 console.log('  Auth:          127.0.0.1:9099');
 console.log('Press Ctrl+C once to stop. Data is in-memory and resets on the next start.\n');
})().catch(error=>{console.error(error);stop(1);});

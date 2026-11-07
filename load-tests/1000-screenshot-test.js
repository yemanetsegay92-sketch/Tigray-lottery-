#!/usr/bin/env node
const fs=require('fs'),path=require('path');
function arg(name,fallback=''){const p='--'+name+'=';const x=process.argv.find(v=>v.startsWith(p));return x?x.slice(p.length):fallback}
function die(m){console.error('\nERROR: '+m);process.exit(1)}
const BASE=arg('base','https://www.tigraylottery.com').replace(/\/$/,'');
const LOTTERY=arg('lottery'),IMAGE=arg('image');
const COUNT=Math.max(1,Number(arg('count','1000'))),CONCURRENCY=Math.max(1,Math.min(25,Number(arg('concurrency','10')))),START=Math.max(1,Number(arg('start','1')));
if(!LOTTERY)die('Missing --lottery=LOTTERY_ID');if(!IMAGE)die('Missing --image=PATH_TO_SCREENSHOT');
if(!fs.existsSync(IMAGE))die('Screenshot file not found: '+IMAGE);
if(!Number.isInteger(COUNT)||!Number.isInteger(CONCURRENCY)||!Number.isInteger(START))die('count, concurrency and start must be integers.');
if(COUNT>1000)die('This test is capped at 1,000 requests.');
const imagePath=path.resolve(IMAGE),imageBytes=fs.readFileSync(imagePath);
if(!imageBytes.length)die('Screenshot file is empty.');
const ext=path.extname(imagePath).toLowerCase();
const mime=ext==='.png'?'image/png':ext==='.webp'?'image/webp':'image/jpeg';
const screenshotData='data:'+mime+';base64,'+imageBytes.toString('base64'),screenshotChars=screenshotData.length;
console.log('Tigray Lottery — 1,000 screenshot request test');
console.log('Endpoint: '+BASE+'/api/customer/create-request');
console.log('Lottery: '+LOTTERY);console.log('Requests: '+COUNT);console.log('Concurrency: '+CONCURRENCY);
console.log('Image bytes: '+imageBytes.length.toLocaleString());console.log('Data URL chars: '+screenshotChars.toLocaleString());
if(screenshotChars>500000)die('Screenshot data URL is too large; use a smaller/compressed image.');
if(imageBytes.length>380*1024)console.warn('WARNING: image exceeds the current customer compressor target (~380 KB).');
async function submit(i){
 const n=START+i,reference='LOAD1000-'+Date.now()+'-'+n,phone='09'+String(70000000+(n%9999999)).padStart(8,'0');
 const body={lotteryId:LOTTERY,name:'Load Test Buyer '+n,phone,reference,quantity:1,screenshotData,screenshotBytes:imageBytes.length,screenshotOriginalBytes:imageBytes.length,screenshotMime:mime};
 const started=Date.now();
 try{const r=await fetch(BASE+'/api/customer/create-request',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const tx=await r.text();let j={};try{j=JSON.parse(tx)}catch{}return{n,ok:r.ok&&j.ok===true,status:r.status,ms:Date.now()-started,requestId:j.requestId||'',error:j.error||(r.ok?'':tx.slice(0,200))}}catch(e){return{n,ok:false,status:0,ms:Date.now()-started,error:String(e.message||e)}}
}
const results=[];let next=0;const allStarted=Date.now();
async function worker(){while(true){const i=next++;if(i>=COUNT)return;results.push(await submit(i));if(results.length%50===0||results.length===COUNT){const ok=results.filter(x=>x.ok).length;console.log('Progress '+results.length+'/'+COUNT+' | accepted '+ok+' | failed '+(results.length-ok))}}}
await Promise.all(Array.from({length:CONCURRENCY},worker));
const accepted=results.filter(x=>x.ok),failed=results.filter(x=>!x.ok),times=results.map(x=>x.ms).sort((a,b)=>a-b);
const pct=p=>times[Math.min(times.length-1,Math.floor(times.length*p))]||0,avg=times.reduce((a,b)=>a+b,0)/Math.max(1,times.length);
console.log('\nRESULT');console.log('Accepted: '+accepted.length+'/'+COUNT);console.log('Failed: '+failed.length);
console.log('Elapsed: '+((Date.now()-allStarted)/1000).toFixed(1)+' s');console.log('Average: '+avg.toFixed(0)+' ms');console.log('p50: '+pct(.5)+' ms');console.log('p95: '+pct(.95)+' ms');console.log('p99: '+pct(.99)+' ms');
if(failed.length){const c={};for(const x of failed){const k=x.status+': '+(x.error||'unknown');c[k]=(c[k]||0)+1}console.log('\nFAILURES');for(const[k,v]of Object.entries(c))console.log(v+' × '+k)}
const report={test:'1000-screenshot-load',base:BASE,lotteryId:LOTTERY,count:COUNT,concurrency:CONCURRENCY,imageBytes:imageBytes.length,screenshotDataChars:screenshotChars,accepted:accepted.length,failed:failed.length,elapsedSeconds:(Date.now()-allStarted)/1000,averageMs:avg,p50Ms:pct(.5),p95Ms:pct(.95),p99Ms:pct(.99),failures:failed.map(x=>({n:x.n,status:x.status,error:x.error}))};
fs.writeFileSync('load-tests/1000-screenshot-result.json',JSON.stringify(report,null,2));console.log('Saved: load-tests/1000-screenshot-result.json');

#!/usr/bin/env node
'use strict';
// GitHub-hosted load testing of Tigray Lottery's existing purchase endpoint.
// Real Firestore / Storage writes. No Telegram init data; no auto-retries.
const fs=require('node:fs');
const crypto=require('node:crypto');
const {performance}=require('node:perf_hooks');
const BASE='https://www.tigraylottery.com';
const LOTTERY='SmHhy38Cn6mnEHjjtPZl';
const RUN_ID='direct-e2a4b4894e0afbba';
const start=Number(process.env.LOAD_START);
const count=Number(process.env.LOAD_COUNT);
const parallel=Number(process.env.LOAD_CONCURRENCY);
const confirm=String(process.env.LOAD_CONFIRM||'');
function check(ok,msg){if(!ok)throw new Error(msg)}
const pct=(a,p)=>{const b=[...a].sort((x,y)=>x-y);return b.length?b[Math.min(b.length-1,Math.ceil(p*b.length)-1)]:0};
function n2(v){return Math.round(v*100)/100}
async function main(){
  check(confirm==='RUN','Missing explicit RUN confirmation');
  check(Number.isInteger(start)&&start>=1,'Invalid start');
  check(Number.isInteger(count)&&count>=1&&start+count-1<=20000,'Invalid count or range');
  check(Number.isInteger(parallel)&&parallel>=1&&parallel<=16,'Concurrency must be 1..16');
  check(start>=68,'Sequences 1..67 were already attempted on the HP computer; refusing duplicate');
  const bytes=fs.readFileSync('synthetic-receipt.jpg');
  check(bytes.length>=100*1024&&bytes.length<=420*1024&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255,'Invalid synthetic JPEG');
  const proof='data:image/jpeg;base64,'+bytes.toString('base64');
  const stats={runId:RUN_ID,lotteryId:LOTTERY,base:BASE,start,count,parallel,receiptBytes:bytes.length,startedAt:new Date().toISOString(),
    sent:0,success:0,failed:0,statuses:{},failures:[],durations:[],stopReason:''};
  let stopped=false,next=start;
  const active=new Set(), t0=performance.now();
  function log(entry){fs.appendFileSync('cloud-attempts.ndjson',JSON.stringify(entry)+'\n')}
  function stop(why){if(!stopped){stopped=true;stats.stopReason=why;console.error('STOP: '+why)}}
  async function send(seq){
    log({kind:'start',seq,runId:RUN_ID,time:new Date().toISOString()});
    const t=performance.now();
    let status='NETWORK', ok=false,err='',requestId='';
    try{
      const response=await fetch(BASE+'/api/customer/create-request',{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({lotteryId:LOTTERY,name:'LOAD TEST BUYER '+seq,phone:'0999999999',
          reference:'LOADTEST-'+RUN_ID+'-'+seq,quantity:1,telegramInitData:'',
          paymentProofData:proof,paymentProofOriginalBytes:bytes.length}),
        signal:AbortSignal.timeout(60000),redirect:'error'});
      status=String(response.status);
      const body=await response.json().catch(()=>({}));
      ok=response.status===200&&body.ok===true&&body.created===true&&/^[a-f0-9]{40}$/.test(String(body.requestId||''));
      if(ok)requestId=body.requestId;
      else err=String(body.error||('HTTP '+status)).slice(0,240);
    }catch(e){err=String(e?.message||e).slice(0,240)}
    const ms=n2(performance.now()-t);
    stats.sent++; if(ok)stats.success++;else{stats.failed++;stats.failures.push({seq,status,error:err})}
    stats.durations.push(ms);stats.statuses[status]=(stats.statuses[status]||0)+1;
    log({kind:'result',seq,runId:RUN_ID,ok,status,error:err,requestId,ms});
    if(!ok)stop('Sequence '+seq+' returned '+status+': '+err);
    if(stats.sent%10===0||stats.sent===count)console.log(stats.sent+'/'+count+' completed, success='+stats.success+', failed='+stats.failed+', elapsed='+n2((performance.now()-t0)/1000)+'s');
  }
  try{
    while(!stopped&&(next<start+count||active.size)){
      while(!stopped&&next<start+count&&active.size<parallel){
        const seq=next++;
        const promise=send(seq).finally(()=>active.delete(promise));active.add(promise);
      }
      if(active.size)await Promise.race(active);
    }
  }finally{
    await Promise.allSettled(active);
    const seconds=(performance.now()-t0)/1000;
    const d=stats.durations;
    const result={...stats,durations:undefined,finishedAt:new Date().toISOString(),
      elapsedSeconds:n2(seconds),p50Ms:n2(pct(d,0.5)),p95Ms:n2(pct(d,0.95)),
      p99Ms:n2(pct(d,0.99)),purchasesPerSecond:n2(stats.success/Math.max(seconds,0.1)),
      storedReceiptMiB:n2(stats.success*bytes.length/1048576),expectedFirestoreWrites:stats.success*2,
      cost:'Check Firebase and Vercel billing dashboards; this script does not know actual charges',
      complete:stats.success===count&&stats.sent===count};
    fs.writeFileSync('cloud-report.json',JSON.stringify(result,null,2));
    console.log('CLOUD RESULT '+JSON.stringify(result,null,2));
    if(!result.complete)process.exitCode=1;
  }
}
main().catch(e=>{console.error('CLOUD TEST ERROR: '+e.message);process.exitCode=1});

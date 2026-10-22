#!/usr/bin/env node
'use strict';
// Final, explicitly authorized synthetic load test for ONE specified test lottery.
// This script creates real pending requests. Never reuse it for actual customers.
// All requests use either a reference only or the new DIRECT Storage upload flow.
const fs = require('node:fs');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');

const BASE = 'https://www.tigraylottery.com';
const LOTTERY_ID = 'LtTVT4tx2pN5x7y6OwbF';
const RUN_PREFIX = 'SYNTHETIC-FINAL-20261022-' + LOTTERY_ID;
const start = Number(process.env.LOAD_START);
const count = Number(process.env.LOAD_COUNT);
const concurrency = Number(process.env.LOAD_CONCURRENCY);
const confirmation = process.env.LOAD_CONFIRM;

function must(ok, message) { if (!ok) throw new Error(message); }
function shortError(value) { return String(value || 'Unknown error').slice(0, 240); }
function percentile(numbers, p) {
  if (!numbers.length) return 0;
  const sorted = [...numbers].sort((a,b) => a-b);
  return sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*p)-1)];
}
function now() { return new Date().toISOString(); }
function referenceFor(seq) { return RUN_PREFIX+'-'+String(seq).padStart(5,'0'); }

async function apiPost(payload) {
  const response = await fetch(BASE+'/api/customer/create-request',{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify(payload),signal:AbortSignal.timeout(60000),redirect:'error'
  });
  const data = await response.json().catch(()=>({}));
  if (!response.ok || !data.ok) {
    throw new Error('HTTP '+response.status+' '+shortError(data.error));
  }
  return data;
}
async function uploadSyntheticJpeg(imageBytes) {
  const policy = await apiPost({
    action:'authorize-receipt-upload',
    lotteryId:LOTTERY_ID,
    mime:'image/jpeg',
    bytes:imageBytes.length
  });
  must(policy.uploadUrl && policy.fields && policy.proofUploadToken,
    'Server did not return a signed direct Storage upload policy.');
  const form = new FormData();
  for (const [key,value] of Object.entries(policy.fields)) form.append(key,String(value));
  // File MUST be the final field for GCS signed POST.
  form.append('file',new Blob([imageBytes],{type:'image/jpeg'}),'synthetic-receipt.jpg');
  const result = await fetch(policy.uploadUrl,{
    method:'POST',body:form,signal:AbortSignal.timeout(120000),redirect:'error'
  });
  if (!result.ok) throw new Error('Direct Firebase Storage upload HTTP '+result.status);
  return policy.proofUploadToken;
}
async function main() {
  must(confirmation==='RUN', 'Confirmation is not RUN; no writes performed.');
  must(Number.isInteger(start)&&start>=1, 'Invalid first sequence.');
  must(Number.isInteger(count)&&count>0&&count<=10000, 'Invalid request count.');
  must(start+count-1<=10000, 'This fixed test permits only sequence 1..10000.');
  must(Number.isInteger(concurrency)&&concurrency>=1&&concurrency<=12,
    'Concurrency must be within 1..12 to protect test lottery.');
  const jpeg = fs.readFileSync('synthetic-receipt.jpg');
  must(jpeg.length>1000&&jpeg.length<=380*1024&&jpeg[0]===255&&jpeg[1]===216,
    'Expected a valid synthetic JPEG below 380 KiB');
  const report={
    lotteryId: LOTTERY_ID, runPrefix: RUN_PREFIX, base:BASE, start,count,concurrency,
    receiptMode:'One direct synthetic JPEG for every 100th purchase; others reference only',
    startedAt:now(),sent:0,success:0,failed:0,directReceiptSuccess:0,
    httpStatus:{},failures:[],latencies:[],stopReason:null
  };
  const t0=performance.now();
  let stopped=false,next=start;
  const active=new Set();
  function log(item) { fs.appendFileSync('final-load-attempts.ndjson',JSON.stringify(item)+'\n'); }
  function stop(reason) {
    if (!stopped) {stopped=true;report.stopReason=reason;console.error('STOP: '+reason);}
  }
  async function send(seq) {
    const ref=referenceFor(seq),t=performance.now(),hasReceipt=seq%100===0;
    const requestId=crypto.createHash('sha256').update('REF:'+ref.toUpperCase())
      .digest('hex').slice(0,40);
    log({event:'start',seq,reference:ref,requestId,hasReceipt,at:now()});
    let status='ERROR',message='',completed=false;
    try {
      const proofToken=hasReceipt?await uploadSyntheticJpeg(jpeg):'';
      const payload={
        lotteryId:LOTTERY_ID,
        name:'SYNTHETIC TEST BUYER '+String(seq).padStart(5,'0'),
        phone:'0999999999',
        reference:ref,
        quantity:1,
        telegramInitData:''
      };
      if(proofToken) {
        payload.proofUploadToken=proofToken;
        payload.paymentProofOriginalBytes=jpeg.length;
      }
      const result=await apiPost(payload);
      must(result.created===true && result.requestId===requestId,
        'Unexpected create response or request ID');
      completed=true;status='200';
      if(hasReceipt)report.directReceiptSuccess++;
    } catch(error) { message=shortError(error?.message); }
    const ms=Math.round(performance.now()-t);
    report.sent++;
    if(completed)report.success++;
    else {
      report.failed++;
      report.failures.push({seq,reference:ref,requestId,error:message});
      stop('Sequence '+seq+' failed: '+message+'. Do NOT blindly retry: submission may have succeeded.');
    }
    report.latencies.push(ms);
    report.httpStatus[status]=(report.httpStatus[status]||0)+1;
    log({event:'result',seq,reference:ref,requestId,hasReceipt,ok:completed,status,error:message,ms,at:now()});
    if(report.sent%10===0||report.sent===count)
      console.log(report.sent+'/'+count+' completed; ok='+report.success+
        '; errors='+report.failed+'; direct receipts='+report.directReceiptSuccess+
        '; elapsed='+(Math.round((performance.now()-t0)/1000))+' seconds');
  }
  try {
    while(!stopped && (next<start+count || active.size)){
      while(!stopped && next<start+count && active.size<concurrency) {
        const seq=next++;
        const job=send(seq).finally(()=>active.delete(job));
        active.add(job);
      }
      if(active.size) await Promise.race(active);
    }
  } finally {
    await Promise.allSettled([...active]);
    const seconds=(performance.now()-t0)/1000;
    const result={...report,latencies:undefined,endedAt:now(),elapsedSeconds:+seconds.toFixed(2),
      p50Ms:percentile(report.latencies,0.5),p95Ms:percentile(report.latencies,0.95),
      p99Ms:percentile(report.latencies,0.99),
      requestsPerSecond:+(report.success/Math.max(seconds,0.1)).toFixed(2),
      plannedFirestoreCreationWrites:report.success*2,
      complete:report.sent===count&&report.success===count,
      warning:'Real Firebase/Vercel quota use and potential charges. This does NOT approve payments.'};
    fs.writeFileSync('final-load-report.json',JSON.stringify(result,null,2));
    console.log('FINAL TEST SUMMARY '+JSON.stringify(result,null,2));
    if(!result.complete)process.exitCode=1;
  }
}
main().catch(error=>{console.error('Final test configuration failed:',error.message);process.exitCode=1;});

'use strict';
// Build artifact validation only. Does not invoke Vercel deploy or any handler.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const source=path.resolve(process.argv[2]||'');
if(!process.argv[2])throw Error('Usage: node tools/verify-vercel-build.cjs <isolated Vercel build source>');
const functions=path.join(source,'.vercel/output/functions');
function walk(root){return fs.readdirSync(root,{withFileTypes:true}).flatMap(e=>{const f=path.join(root,e.name);return e.isDirectory()?walk(f):[f]});}
const configs=walk(functions).filter(f=>path.basename(f)==='.vc-config.json');assert.equal(configs.length,12,'Hobby function count must remain 12');
const work=fs.mkdtempSync('/tmp/tigray-vercel-artifacts-');const results=[];
try{
 for(const cfg of configs){
  const dir=path.dirname(cfg),config=JSON.parse(fs.readFileSync(cfg));assert.equal(config.runtime,'nodejs24.x');
  assert.ok(!config.maxDuration || config.maxDuration<=300);
  const files=new Map(walk(dir).map(f=>[path.relative(dir,f),f]));
  // The CLI records explicit includeFiles in filePathMap, relative to source.
  for(const [target,relative] of Object.entries(config.filePathMap||{})){
   assert.ok(!path.isAbsolute(relative)&&!relative.split('/').includes('..'));const f=path.join(source,relative);assert.ok(fs.statSync(f).isFile(),relative);files.set(target,f);
  }
  const bytes=[...files.values()].reduce((sum,f)=>sum+fs.statSync(f).size,0);assert.ok(bytes<250*1024*1024,'Function exceeds 250 MiB');
  results.push({function:path.relative(functions,dir),runtime:config.runtime,MiB:+(bytes/1024**2).toFixed(1)});
  if(!['api/admin/approvals.func','api/customer/create-request.func'].includes(path.relative(functions,dir)))continue;
  const bundle=path.join(work,path.basename(dir));fs.mkdirSync(bundle,{recursive:true});
  for(const [relative,f] of files){const to=path.join(bundle,relative);assert.ok(to.startsWith(bundle+path.sep));fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(f,to);}
  const fixture=fs.readFileSync(path.join(__dirname,'fixtures/synthetic-cbe-scan.pdf')).toString('base64');
  const textPdf=require('./fixtures/text-pdf.cjs')('FT26318BTKTO FT26318BTKTO').toString('base64');
  const script=`const assert=require('node:assert/strict');global.fetch=()=>{throw Error('NETWORK FORBIDDEN')};
   require('./'+${JSON.stringify(config.handler)});
   const {extractReferenceFromReceipt:extract}=require('./lib/cbe-receipt-reference');
   (async()=>{const start=Date.now();
    const scan=await extract({buffer:Buffer.from(${JSON.stringify(fixture)},'base64'),mime:'application/pdf',bank:'cbe'});assert.equal(scan.reference,'FT26316BDP1Q');
    const text=await extract({buffer:Buffer.from(${JSON.stringify(textPdf)},'base64'),mime:'application/pdf',bank:'cbe'});assert.equal(text.reference,'FT26318BTKTO');
    const sharp=require('sharp'),svg=Buffer.from('<svg width="1200" height="240"><rect width="100%" height="100%" fill="white"/><text x="40" y="130" font-family="DejaVu Sans" font-size="50">Reference FT263194G9Q5</text></svg>');
    for(const [format,mime] of [['png','image/png'],['jpeg','image/jpeg'],['webp','image/webp']]){const image=await extract({buffer:await sharp(svg)[format]().toBuffer(),mime,bank:'cbe'});assert.equal(image.reference,'FT263194G9Q5');}
    console.log(JSON.stringify({OCR:'PASS',elapsedMs:Date.now()-start,maxRSSMiB:Math.round(process.resourceUsage().maxRSS/1024)}));
   })().catch(e=>{console.error(e);process.exitCode=1});`;
  const smoke=spawnSync(process.execPath,['-e',script],{cwd:bundle,encoding:'utf8',timeout:60000,
   env:{PATH:process.env.PATH,HOME:work,VERCEL_ENV:'production'}});
  assert.equal(smoke.status,0,smoke.stdout+smoke.stderr);results.at(-1).smoke=JSON.parse(smoke.stdout.trim().split('\n').at(-1));
 }
 console.log(JSON.stringify({functions:configs.length,results},null,2));
}finally{fs.rmSync(work,{recursive:true,force:true});}

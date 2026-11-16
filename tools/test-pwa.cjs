'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');
const read=path=>fs.readFileSync(path,'utf8');
test('manifest and PNG icons are consistent',()=>{
 const m=JSON.parse(read('manifest.webmanifest'));
 assert.equal(m.display,'standalone');assert.equal(m.scope,'/');assert.ok(m.id);
 for(const size of [192,512]){
  const i=m.icons.find(x=>x.sizes===size+'x'+size);assert.ok(i);assert.equal(i.type,'image/png');
  const b=fs.readFileSync('icons/tigray-icon-'+size+'.png');
  assert.equal(b.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  assert.equal(b.readUInt32BE(16),size);assert.equal(b.readUInt32BE(20),size);
 }
});
test('public pages link manifest and installation help',()=>{
 for(const p of ['index.html','buy.html','check.html']){
  assert.match(read(p),/manifest\.webmanifest/);assert.match(read(p),/js\/pwa\.js/);
 }
 assert.match(read('js/pwa.js'),/beforeinstallprompt/);
 assert.match(read('js/pwa.js'),/appinstalled/);
});
test('offline handler does not intercept sensitive API or cache purchases',()=>{
 const sw=read('service-worker.js');
 assert.match(sw,/request\.method!==['"]GET['"]/);
 assert.match(sw,/request\.mode!==['"]navigate['"]/);
 assert.match(sw,/PUBLIC_ROUTES\.has\(url\.pathname\)/);
 assert.match(sw,/cache\.add\(OFFLINE\)/);
 assert.doesNotMatch(sw,/caches\.match\(request\)|cache\.addAll\(|cache\.put\(/);
});
test('checkout retains signed upload and has mobile fallback',()=>{
 const js=read('js/buy.js');
 assert.match(js,/createImageBitmap/);assert.match(js,/URL\.createObjectURL/);
 assert.match(js,/receiptSelection/);assert.match(js,/if\(submitting\)return/);
 assert.match(js,/authorize-receipt-upload/);assert.match(js,/proofUploadToken/);
 assert.match(read('buy.html'),/mobile-upload-help/);
});

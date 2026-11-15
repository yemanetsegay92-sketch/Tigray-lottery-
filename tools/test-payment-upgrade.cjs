'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');
const {extractReferenceFromReceipt:extract,extractReferenceFromText:parse}=require('../lib/cbe-receipt-reference');
const {normalizePaymentReference}=require('../lib/payment-claims');
const image=(text,bank='cbe')=>extract({buffer:Buffer.from('fixture'),mime:'image/png',bank,recognizeImage:async()=>text});
test('CBE OCR selects first in text order, preserves all originals, then changes O to zero',async()=>{
 const r=await image('FT26318BTKTO\nFT2631946905');assert.equal(r.reference,'FT26318BTKT0');
 assert.equal(r.originalReference,'FT26318BTKTO');assert.deepEqual(r.candidates.map(c=>c.reference),['FT26318BTKTO','FT2631946905']);
 const reverse=await image('FT2631946905 FT26318BTKTO');assert.equal(reverse.reference,'FT2631946905');
});
test('single, absent, unreadable, other bank and customer values retain correct semantics',async()=>{
 assert.equal((await image('FT263194G9Q5')).reference,'FT263194G9Q5');
 assert.equal((await image('unreadable')).ok,false);
 assert.equal((await image('FT26318BTKTO','other')).reference,'FT26318BTKTO');
 assert.equal((await image('FT26318BTKTO FT2631946905','other')).reason,'ambiguous_reference');
 assert.equal(normalizePaymentReference('FT26318BTKTO'),'FT26318BTKTO');
 assert.equal(parse('FT26318BTKTO').reference,'FT26318BTKTO');
});
test('embedded PDF text preserves O without image OCR',async()=>{
 const r=await extract({buffer:Buffer.from('fixture'),mime:'application/pdf',bank:'cbe',parsePdf:async()=>({text:'FT26318BTKTO'}),recognizeImage:()=>{throw Error('must not OCR')}});
 assert.equal(r.reference,'FT26318BTKTO');
});
test('real scanned PDF renders and uses first OCR candidate',async()=>{
 const buffer=fs.readFileSync(__dirname+'/fixtures/synthetic-cbe-scan.pdf');let renders=0;
 const r=await extract({buffer,mime:'application/pdf',bank:'cbe',recognizeImage:async bytes=>{renders++;assert.equal(bytes.subarray(1,4).toString(),'PNG');return 'FT26318BTKTO FT2631946905';}});
 assert.equal(r.reference,'FT26318BTKT0');assert.equal(renders,1);
});
test('PDF page budget fails closed',async()=>{
 const r=await extract({buffer:Buffer.from('fixture'),mime:'application/pdf',parsePdf:async()=>({text:'',pages:Array.from({length:5},(_,i)=>({num:i+1,text:''}))})});assert.equal(r.reason,'scan_page_limit');
});
const vm=require('node:vm');
for(const [page,role,other] of [['general','generalAdmin','lottery.html'],['lottery','lotteryAdmin','general.html']]){
 test(page+' hides dashboard during auth, wrong-role, missing profile, logout and stale multi-tab callbacks',async()=>{
  const html=fs.readFileSync(__dirname+'/../admin/'+page+'.html','utf8');assert.match(html,/html:not\(\.admin-verified\)/);assert.match(html,/Verifying administrator access/);
  const source=fs.readFileSync(__dirname+'/../admin/js/'+page+'.js','utf8');const a=source.indexOf('let accessGeneration=0;');const b=source.indexOf('\n});',a)+4;
  const classes=new Set();let callback;let resolveProfile;const nodes={};let redirected;
  const u={uid:'one'};const auth={currentUser:u};
  const ctx={auth,console,document:{documentElement:{classList:{add:x=>classes.add(x),remove:x=>classes.delete(x)}}},$:id=>nodes[id]||=( {textContent:'',innerHTML:''}),location:{replace:x=>redirected=x},onAuthStateChanged:(_,fn)=>callback=fn,getDoc:()=>new Promise(r=>resolveProfile=r),doc:()=>{},db:{},renderLotteries:async()=>{},renderSummaryOverview:async()=>{},loadContactSettings:async()=>{},renderCreatePaymentAccountsEditor:()=>{},setupDraw:()=>{},autoResumeCleanupOnLoad:()=>{},refreshTelegramStatus:()=>{}};
  vm.runInNewContext(source.slice(a,b),ctx);const pending=callback(u);assert.equal(classes.size,0);
  resolveProfile({exists:()=>true,data:()=>({role:role==='generalAdmin'?'lotteryAdmin':'generalAdmin'})});await pending;assert.equal(redirected,other);assert.equal(classes.size,0);
  const stale=callback(u);auth.currentUser=null;await callback(null);resolveProfile({exists:()=>true,data:()=>({role})});await stale;assert.equal(classes.size,0);
  auth.currentUser=u;const missing=callback(u);resolveProfile({exists:()=>false});await missing;assert.equal(classes.size,0);
 });
}
test('real local Tesseract reads JPG, PNG and WebP without remote OCR or provider calls',async()=>{
 const sharp=require('sharp');const svg=Buffer.from('<svg width="1200" height="240"><rect width="100%" height="100%" fill="white"/><text x="40" y="130" font-family="DejaVu Sans" font-size="50" fill="black">Reference FT263194G9Q5</text></svg>');
 for(const [format,mime] of [['png','image/png'],['jpeg','image/jpeg'],['webp','image/webp']]){
  const buffer=await sharp(svg)[format]().toBuffer();const result=await extract({buffer,mime,bank:'cbe'});assert.equal(result.reference,'FT263194G9Q5');
 }
});
test('real scanned PDF runs local OCR end to end',async()=>{
 const r=await extract({buffer:fs.readFileSync(__dirname+'/fixtures/synthetic-cbe-scan.pdf'),mime:'application/pdf',bank:'cbe'});assert.equal(r.reference,'FT26316BDP1Q');
});
test('real text PDF parses without invoking image OCR',async()=>{
 const stream='BT /F1 24 Tf 40 100 Td (Reference FT26318BTKTO) Tj ET';
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>','<< /Length '+stream.length+' >>\nstream\n'+stream+'\nendstream'];
 let pdf='%PDF-1.4\n';const offsets=[0];objects.forEach((obj,i)=>{offsets.push(Buffer.byteLength(pdf));pdf+=(i+1)+' 0 obj\n'+obj+'\nendobj\n';});const start=Buffer.byteLength(pdf);pdf+='xref\n0 6\n0000000000 65535 f \n'+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n'+start+'\n%%EOF';
 const r=await extract({buffer:Buffer.from(pdf),mime:'application/pdf',bank:'cbe',recognizeImage:()=>{throw Error('text PDF must not OCR')}});assert.equal(r.reference,'FT26318BTKTO');
});
for(const [text,expected,reason] of [
 ['FT26318BTKTO FT26318BTKTO','FT26318BTKTO',undefined],
 ['FT263194G9Q5 FT2631946905',undefined,'ambiguous_reference'],
 ['FT26318BTKTO FT26318BTKT0',undefined,'ambiguous_reference']
])test('real text PDF preserves repeated embedded references safely: '+text,async()=>{
 const r=await extract({buffer:require('./fixtures/text-pdf.cjs')(text),mime:'application/pdf',bank:'cbe',recognizeImage:()=>{throw Error('must not OCR embedded text')}});
 assert.equal(r.reference,expected);assert.equal(r.reason,reason);assert.equal(r.ok,!reason);assert.equal(r.candidates.length,2);
});

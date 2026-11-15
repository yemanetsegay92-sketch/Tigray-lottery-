'use strict';

const MIN_REFERENCE_TAIL = 8;
const MAX_REFERENCE_TAIL = 30;

function normalizeReference(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// CBE receipts show the same FT reference in the PDF table, SMS notification,
// and transfer success screen. OCR sometimes inserts spaces or punctuation
// after FT. Preserve recognized candidates in text order for administrator review.
// Generic/other-bank parsing keeps ambiguity; CBE OCR selects the first.
function extractReferenceFromText(text) {
  const candidates = new Set();
  const originals = [];
  const source = String(text || '');
  const pattern = /\bFT[\s:.-]*([A-Z0-9]{8,30})\b/gi;
  for (const match of source.matchAll(pattern)) {
    const reference = normalizeReference('FT' + match[1]);
    const tailLength = reference.length - 2;
    if (/^FT[A-Z0-9]+$/.test(reference) &&
        tailLength >= MIN_REFERENCE_TAIL && tailLength <= MAX_REFERENCE_TAIL) {
      candidates.add(reference);
      originals.push({original:match[0],reference});
    }
  }
  if (candidates.size !== 1) {
    return { ok: false, reason: candidates.size ? 'ambiguous_reference' : 'reference_not_found', candidates:originals };
  }
  return { ok: true, reference: [...candidates][0], originalReference:[...candidates][0], candidates:originals };
}

// CBE web receipts repeat the same FT reference above and below the payment
// details. A stamp can distort the lower copy. If OCR reads conflicting FT
// values, use the FIRST recognized one in OCR text order (not necessarily
// visual top-to-bottom order). Single-reference screenshots use the normal
// extraction path. This is an OCR candidate, never bank verification.
function extractReferenceFromOcrText(text, bank) {
  const initial=extractReferenceFromText(text);
  if(bank!=='cbe' || initial.reason!=='ambiguous_reference')return initial;
  const source=String(text||'');
  const pattern=/\bFT[\s:.-]*([A-Z0-9]{8,30})\b/gi;
  for(const match of source.matchAll(pattern)){
    const first=extractReferenceFromText(match[0]);
    if(first.ok)return {...first,candidates:initial.candidates,selection:'first_in_ocr_text_order'};
  }
  return initial;
}

// Render sequentially so a scan never holds several page canvases at once.
const MAX_SCAN_PAGES = 4;
const MAX_RENDER_EDGE = 2048;

function experimentalCbeOcrCandidate(result, bank) {
  // CBE-specific OCR correction. This is
  // candidate normalization, not improved recognition or proof of payment.
  // Require explicit CBE context; keep generic parsing and other banks intact.
  if (bank !== 'cbe' || !result.ok || !/^FT[A-Z0-9]{8,30}$/.test(result.reference) ||
      !result.reference.includes('O')) return result;
  return { ...result, reference: result.reference.replace(/O/g, '0') };
}

let activeExtraction=false;
async function extractReferenceFromReceipt({ buffer, mime, bank, parsePdf, recognizeImage } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return { ok:false, reason:'receipt_unavailable' };
  if(activeExtraction)return {ok:false,reason:'ocr_busy_manual_review'};
  activeExtraction=true;
  let parser, worker, timer;
  const deadline=Date.now()+45000;
  const expired=()=>Date.now()>deadline;
  timer=setTimeout(()=>{if(worker)void worker.terminate();},45000);
  async function recognize(bytes) {
    if(expired())throw Error('OCR deadline');
    let result;
    if (recognizeImage) result = await recognizeImage(bytes);
    else {
      if (!worker) worker = await require('tesseract.js').createWorker('eng', undefined, {
        langPath: require('node:path').dirname(require.resolve('@tesseract.js-data/eng/4.0.0/eng.traineddata.gz')),
        cachePath: '/tmp/tigray-tesseract', cacheMethod: 'none'
      });
      const image=await require('sharp')(bytes,{limitInputPixels:16*1024*1024}).resize({width:2048,height:2048,fit:'inside',withoutEnlargement:true}).png().toBuffer();
      result = await worker.recognize(image);
    }
    return typeof result === 'string' ? result : result?.data?.text || '';
  }
  try {
    if (['image/jpeg','image/png','image/webp'].includes(mime)) {
      return experimentalCbeOcrCandidate(extractReferenceFromOcrText(await recognize(buffer),bank), bank);
    }
    if (mime !== 'application/pdf') return {ok:false, reason:'unsupported_receipt_type'};

    // pdf.js can transfer ownership of the input bytes to its worker.
    if (!parsePdf) parser = new (require('pdf-parse').PDFParse)({data:Uint8Array.from(buffer)});
    if(parser){const info=await parser.getInfo();if(info.total>4)return {ok:false,reason:'scan_page_limit'};}
    const parsed = parsePdf ? await parsePdf(buffer) : await parser.getText({pageJoiner:''});
    const text = typeof parsed === 'string' ? parsed : parsed.text;
    const embedded = extractReferenceFromText(text);
    if (embedded.reason === 'ambiguous_reference') return embedded;
    const pages = parsed.pages || [];
    const scan = pages.filter(page => !embedded.ok || !page.text.trim()).map(page => page.num);
    if (!scan.length) return embedded;
    if (scan.length > MAX_SCAN_PAGES) return {ok:false,reason:'scan_page_limit'};

    const info = await parser.getInfo({partial:scan,parsePageInfo:true});
    if (info.pages.length !== scan.length) return {ok:false,reason:'receipt_extraction_failed'};
    const transcriptions = [text];
    for (const page of info.pages) {
      if (![page.width,page.height].every(n=>Number.isFinite(n) && n>0)) {
        return {ok:false,reason:'receipt_extraction_failed'};
      }
      const shot = await parser.getScreenshot({partial:[page.pageNumber],
        scale:Math.min(3, MAX_RENDER_EDGE/Math.max(page.width,page.height)),
        imageBuffer:true,imageDataUrl:false});
      transcriptions.push(await recognize(Buffer.from(shot.pages[0].data)));
    }
    const result = embedded.ok ? extractReferenceFromText(transcriptions.join('\n'))
      : extractReferenceFromOcrText(transcriptions.join('\n'),bank);
    // Embedded PDF text is not OCR. Preserve its exact reference and all
    // pre-existing ambiguity checks, including conflicts across scan pages.
    return embedded.ok ? result : experimentalCbeOcrCandidate(result, bank);
  } catch {
    return {ok:false,reason:'receipt_extraction_failed'};
  } finally {
    clearTimeout(timer);activeExtraction=false;
    try { if (worker) await worker.terminate(); } catch {}
    try { if (parser) await parser.destroy(); } catch {}
  }
}

module.exports = { normalizeReference, extractReferenceFromText, extractReferenceFromOcrText, extractReferenceFromReceipt };

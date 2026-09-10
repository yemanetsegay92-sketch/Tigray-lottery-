export async function normalizePhone(phone){ return String(phone||'').replace(/[^0-9+]/g,'').replace(/^\+251/,'0').trim(); }
export async function phoneHash(phone){
  const normalized=await normalizePhone(phone);
  const data=new TextEncoder().encode(normalized);
  const digest=await crypto.subtle.digest('SHA-256',data);
  return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');
}

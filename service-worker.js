/* Cache only the offline notice; never cache payments, receipts, API responses or admin pages. */
const CACHE='tigray-pwa-offline-v1';
const OFFLINE='/offline.html';
const PUBLIC_ROUTES=new Set(['/','/index.html','/buy.html','/check.html']);
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.add(OFFLINE)));self.skipWaiting();});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(names=>Promise.all(names.filter(name=>name.startsWith('tigray-pwa-offline-')&&name!==CACHE).map(name=>caches.delete(name)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',event=>{
 const request=event.request;
 if(request.method!=='GET'||request.mode!=='navigate')return;
 const url=new URL(request.url);
 if(url.origin!==self.location.origin||!PUBLIC_ROUTES.has(url.pathname))return;
 event.respondWith(fetch(request).catch(()=>caches.match(OFFLINE)));
});

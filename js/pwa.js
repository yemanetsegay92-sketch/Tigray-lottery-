/* PWA install + honest webview fallback. No checkout/auth logic. */
(()=>{
 'use strict';
 const nav=document.querySelector('.site-header nav');
 if(!window.isSecureContext||!nav)return;
 const isStandalone=()=>!!(window.matchMedia?.('(display-mode: standalone)')?.matches||navigator.standalone===true);
 const ti=(()=>{try{return localStorage.getItem('tl_lang')!=='en';}catch{return true;}})();
 const words=ti?{
  install:'ኣፕ ጽዓን',title:'Tigray Lottery ናብ ስልክኻ ወስኽ',
  browser:'ኣብ Chrome ወይ Samsung Internet፡ ካብ ምርጫ ⋮ «Add to Home screen» ወይ «Install app» ምረጽ።',
  webview:'እዚ ኣፕ ክትጽዕኖ እንተዘይክኢልካ፡ ካብ ምርጫ እቲ ኣፕ «Open in browser» ምረጽ፤ ድሕሪኡ ኣብ Chrome ወይ Samsung Internet ወስኾ።',
  ios:'ኣብ iPhone ካብ Share «Add to Home Screen» ምረጽ።',close:'ዕጸው'
 }:{
  install:'Install app',title:'Add Tigray Lottery to your phone',
  browser:'In Chrome or Samsung Internet, open the menu (⋮) and choose Add to Home screen or Install app.',
  webview:'If this app cannot install websites, use its menu to choose Open in browser. Then install from Chrome or Samsung Internet. You can still use the website without installing.',
  ios:'On iPhone, use Share → Add to Home Screen.',close:'Close'
 };
 let deferredPrompt=null;
 const button=document.createElement('button');button.type='button';button.className='pwa-install';button.textContent=words.install;button.setAttribute('aria-label',words.title);
 if(isStandalone())button.hidden=true;
 nav.append(button);
 const dialog=document.createElement('dialog');dialog.className='pwa-install-dialog';
 const title=document.createElement('h2');title.textContent=words.title;
 const message=document.createElement('p');const close=document.createElement('button');
 close.type='button';close.className='pwa-help-close';close.textContent=words.close;close.addEventListener('click',()=>dialog.close?.());
 dialog.append(title,message,close);document.body.append(dialog);
 dialog.addEventListener('click',event=>{if(event.target===dialog)dialog.close?.();});
 function guidance(){
  const ua=navigator.userAgent||'';
  const embedded=/FBAN|FBAV|FB_IAB|Instagram|Messenger|WhatsApp|TikTok|Bytedance|musical_ly|imo\//i.test(ua);
  const ios=/iPhone|iPad|iPod/i.test(ua);
  message.textContent=ios?words.ios:embedded?words.webview:words.browser;
  if(typeof dialog.showModal==='function')dialog.showModal();else alert(words.title+'\n\n'+message.textContent);
 }
 window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();deferredPrompt=event;button.hidden=isStandalone();});
 window.addEventListener('appinstalled',()=>{deferredPrompt=null;button.hidden=true;});
 button.addEventListener('click',()=>{
  if(isStandalone()){button.hidden=true;return;}
  if(!deferredPrompt){guidance();return;}
  const prompt=deferredPrompt;deferredPrompt=null;
  try{prompt.prompt();Promise.resolve(prompt.userChoice).catch(()=>{});}catch{guidance();}
 });
 if('serviceWorker' in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('/service-worker.js',{scope:'/'}).catch(()=>{}),{once:true});
})();

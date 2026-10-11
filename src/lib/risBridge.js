// Mode "page RIS" : quand RIS refuse la lecture directe du flux (CORS / 403), on lit le flux
// que la page RIS reçoit déjà pour son propre affichage et on le transmet à PitBoard.
//
// 1. PitBoard (poste Admin) ouvre la page RIS avec window.open : la page RIS peut ainsi lui
//    répondre via window.opener.
// 2. L'utilisateur clique une fois sur le favori « PitBoard ↔ RIS » (code ci-dessous) : il écoute
//    les réponses que la page RIS reçoit déjà (aucune requête supplémentaire vers RIS).
// 3. Chaque réponse du flux est envoyée à PitBoard par postMessage ; PitBoard n'accepte que les
//    messages venant de RIS (RIS_ORIGIN) et valide le contenu avant de s'en servir.

export const RIS_ORIGIN = "https://live.ris-timing.be";

// code du favori (bookmarklet). origin = adresse de PitBoard, seule destinataire autorisée.
export function buildBookmarkletCode(origin) {
  return `(function(){
if(window.__pitboardRis){var b0=document.getElementById("pitboard-ris-box");if(b0)b0.textContent="PitBoard : déjà actif";return;}
window.__pitboardRis=1;
var O=${JSON.stringify(origin)};
var box=document.createElement("div");
box.id="pitboard-ris-box";
box.style.cssText="position:fixed;left:8px;bottom:8px;z-index:2147483647;background:#111;color:#fff;font:12px/1.3 sans-serif;padding:6px 10px;border-radius:6px;opacity:.92";
box.textContent="PitBoard : en attente du flux…";
document.body.appendChild(box);
function say(t){box.textContent="PitBoard : "+t;}
function send(u,t){
try{
var raw=JSON.parse(t);
if(!raw||!Array.isArray(raw.cars))return;
var m=/[?&]uuid=([0-9a-fA-F-]{36})/.exec(u);
if(!window.opener||window.opener.closed){say("fenêtre PitBoard introuvable : rouvrez cette page avec le bouton « Ouvrir la page RIS » de PitBoard");return;}
window.opener.postMessage({pitboardRis:1,uuid:m?m[1]:"",raw:raw},O);
say("flux transmis à "+new Date().toLocaleTimeString());
}catch(e){}
}
var of=window.fetch;
if(of){window.fetch=function(){
var a=arguments,u=typeof a[0]==="string"?a[0]:(a[0]&&a[0].url)||"";
var p=of.apply(this,a);
if(/live-timing\\?/.test(u)){p.then(function(r){return r.clone().text();}).then(function(t){send(u,t);}).catch(function(){});}
return p;
};}
var xo=XMLHttpRequest.prototype.open,xs=XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.open=function(m,u){this.__pbu=String(u);return xo.apply(this,arguments);};
XMLHttpRequest.prototype.send=function(){
var x=this;
if(/live-timing\\?/.test(x.__pbu||"")){x.addEventListener("load",function(){send(x.__pbu,x.responseText);});}
return xs.apply(this,arguments);
};
})();`;
}

// adresse "javascript:" à glisser dans la barre de favoris
export function buildBookmarklet(origin) {
  return "javascript:" + encodeURIComponent(buildBookmarkletCode(origin));
}

const UUID_RE = /^[0-9a-fA-F-]{36}$/;

// message reçu de la page RIS ? -> { raw, uuid } ou null (origine ou format incorrects)
export function readRisMessage(event) {
  if (!event || event.origin !== RIS_ORIGIN) return null;
  const d = event.data;
  if (!d || d.pitboardRis !== 1 || !d.raw || typeof d.raw !== "object") return null;
  return { raw: d.raw, uuid: typeof d.uuid === "string" && UUID_RE.test(d.uuid) ? d.uuid : "" };
}

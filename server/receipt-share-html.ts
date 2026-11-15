/**
 * Le fichier qu'on envoie : UN reçu Oathrion, lisible par n'importe qui, qui se vérifie lui-même
 * dans le navigateur (WebCrypto, Ed25519) — sans réseau, sans Oathrion, sans rien installer.
 *
 * C'est l'objet que verra d'abord quelqu'un qui ne connaît pas Oathrion : il doit être beau et
 * se comprendre en une seconde. Une carte de reçu (un sceau qui se pose à la vérification, une
 * phrase en langage courant, l'action, une ligne de découpe, la preuve), la police du système,
 * clair et sombre, imprimable, aucune ressource extérieure.
 *
 * Le vérificateur est DANS le fichier : quelqu'un qui forgerait le fichier pourrait aussi le
 * remplacer. Le fichier le dit, et donne la vérification indépendante
 * (`npx oathrion receipt verify <fichier>`) et l'empreinte à comparer avec celle que l'émetteur a
 * publiée. Toute valeur de la déclaration (une commande d'agent peut contenir n'importe quoi)
 * est posée en TEXTE (`textContent`), jamais en HTML.
 */
import { REPOSITORY_URL, contactReady } from "@shared/contact";
import { embedShared, type SharedReceipt } from "@shared/receipt-share";

const STYLE = `
:root{
  --page:#f5f5f7;--card:#fff;--ink:#1d1d1f;--soft:#6e6e73;--faint:#86868b;--hair:rgba(0,0,0,.08);--well:#f5f5f7;
  --ok:#1f8a3f;--ok-tint:rgba(52,199,89,.12);--bad:#d70015;--bad-tint:rgba(255,59,48,.10);--wait:#86868b;--accent:#5856d6;
  --shadow:0 1px 1px rgba(0,0,0,.02),0 8px 24px rgba(0,0,0,.06),0 24px 64px rgba(0,0,0,.06)
}
@media (prefers-color-scheme:dark){:root{
  --page:#000;--card:#1c1c1e;--ink:#f5f5f7;--soft:#a1a1a6;--faint:#8e8e93;--hair:rgba(255,255,255,.10);--well:#2c2c2e;
  --ok:#30d158;--ok-tint:rgba(48,209,88,.16);--bad:#ff453a;--bad-tint:rgba(255,69,58,.16);--wait:#8e8e93;--accent:#7d7aff;
  --shadow:0 0 0 1px rgba(255,255,255,.06),0 24px 64px rgba(0,0,0,.5)
}}
*{box-sizing:border-box;margin:0}
html{-webkit-text-size-adjust:100%}
body{background:var(--page);color:var(--ink);font:15px/1.47 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI Variable Text","Segoe UI",Roboto,"Helvetica Neue",sans-serif;-webkit-font-smoothing:antialiased;letter-spacing:-.01em;padding:48px 16px 64px}
.mono{font-family:ui-monospace,"SF Mono",SFMono-Regular,Menlo,"Cascadia Mono",Consolas,monospace;letter-spacing:0}
.pass{max-width:460px;margin:0 auto;background:var(--card);border-radius:24px;box-shadow:var(--shadow);overflow:hidden}
.head{padding:28px 28px 0;display:flex;justify-content:space-between;align-items:center;color:var(--soft);font-size:13px;font-weight:500}
.brand{display:flex;align-items:center;gap:8px;color:var(--ink);font-weight:600;letter-spacing:-.01em}
.brand svg{color:var(--accent)}
.hero{padding:28px 28px 8px;text-align:center}
.seal{width:76px;height:76px;margin:0 auto 18px;border-radius:50%;display:grid;place-items:center;background:var(--well);color:var(--wait);transition:background .4s,color .4s}
.seal svg{width:36px;height:36px}
.seal .ring{animation:spin 1.1s linear infinite;transform-origin:50% 50%}
.seal.ok{background:var(--ok-tint);color:var(--ok);animation:pop .5s cubic-bezier(.2,1.4,.4,1)}
.seal.bad{background:var(--bad-tint);color:var(--bad);animation:pop .5s cubic-bezier(.2,1.4,.4,1)}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes pop{0%{transform:scale(.6);opacity:0}100%{transform:scale(1);opacity:1}}
.verdict{font-size:13px;font-weight:600;letter-spacing:.02em;text-transform:uppercase;color:var(--wait)}
.verdict.ok{color:var(--ok)}.verdict.bad{color:var(--bad)}
.vtext{color:var(--soft);font-size:13px;max-width:340px;margin:4px auto 0}
h1{font-size:24px;line-height:1.2;font-weight:700;letter-spacing:-.025em;margin:10px auto 6px;max-width:360px}
.sub{color:var(--soft);font-size:15px;max-width:360px;margin:0 auto}
.command{margin:22px 28px 0;background:var(--well);border-radius:14px;padding:14px 16px;font-size:13.5px;line-height:1.5;overflow-wrap:anywhere;white-space:pre-wrap}
.spared{margin:12px 28px 0;border-radius:14px;padding:12px 16px;background:var(--bad-tint);color:var(--bad);font-weight:600;font-size:14px;display:flex;gap:10px;align-items:center}
.spared[hidden]{display:none}
.list{margin:20px 28px 0}
.row{display:flex;justify-content:space-between;gap:16px;padding:12px 0;border-top:1px solid var(--hair);font-size:14px}
.row:first-child{border-top:0}
.row dt{color:var(--soft);flex:none}
.row dd{text-align:right;min-width:0;overflow-wrap:anywhere}
.tear{position:relative;height:40px;margin-top:20px}
.tear:before{content:"";position:absolute;left:24px;right:24px;top:50%;border-top:2px dashed var(--hair)}
.tear span{position:absolute;top:50%;width:28px;height:28px;margin-top:-14px;border-radius:50%;background:var(--page)}
.tear span:first-child{left:-14px}.tear span:last-child{right:-14px}
.proof{padding:0 28px 28px}
.label{color:var(--soft);font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;margin-bottom:10px}
.fp{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:6px}
.fp span{background:var(--well);border-radius:8px;padding:7px 0;text-align:center;font-size:14px;font-weight:600}
.fine{color:var(--faint);font-size:12.5px;line-height:1.5;margin-top:14px}
.verify{margin-top:18px;display:flex;align-items:center;gap:8px;background:var(--well);border-radius:12px;padding:10px 10px 10px 14px;font-size:12.5px}
.verify code{flex:1;min-width:0;overflow-x:auto;white-space:nowrap}
.verify button{flex:none;border:0;border-radius:8px;padding:6px 12px;font-family:inherit;font-weight:600;font-size:12.5px;background:var(--card);color:var(--ink);cursor:pointer;box-shadow:0 0 0 1px var(--hair)}
.pass.untrusted .command,.pass.untrusted .spared,.pass.untrusted .list,.pass.untrusted h1,.pass.untrusted #sub{opacity:.45;text-decoration:line-through;text-decoration-thickness:1px}
.foot{max-width:460px;margin:20px auto 0;text-align:center;color:var(--faint);font-size:12px}
@media (max-width:420px){body{padding:16px 12px 40px}.head,.hero{padding-left:20px;padding-right:20px}.command,.spared,.list{margin-left:20px;margin-right:20px}.proof{padding:0 20px 24px}h1{font-size:21px}}
@media print{body{background:#fff;padding:0}.pass{box-shadow:none;border:1px solid #ddd}.verify button{display:none}.tear span{background:#fff}}
`;

const LOGO = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 2.5 4.5 5.6v6.1c0 4.6 3.1 8.5 7.5 9.8 4.4-1.3 7.5-5.2 7.5-9.8V5.6L12 2.5Z" fill="currentColor" opacity=".18"/><path d="M12 2.5 4.5 5.6v6.1c0 4.6 3.1 8.5 7.5 9.8 4.4-1.3 7.5-5.2 7.5-9.8V5.6L12 2.5Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="m8.6 12.2 2.4 2.4 4.6-4.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/* Le vérificateur du navigateur : la même forme canonique que `shared/receipt-share.ts`. */
const SCRIPT = `
(function(){
  var shared = JSON.parse(document.getElementById("oathrion-receipt").textContent);
  var s = shared.statement, a = s.action, e = s.evidence;
  function $(id){ return document.getElementById(id); }
  function set(id, text){ var el = $(id); if (el) el.textContent = text == null || text === "" ? "\\u2014" : String(text); }
  function canonical(v){
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
    return "{" + Object.keys(v).filter(function(k){ return v[k] !== undefined; }).sort().map(function(k){ return JSON.stringify(k) + ":" + canonical(v[k]); }).join(",") + "}";
  }
  function bytes(b64){ var bin = atob(b64), out = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
  function when(iso){ try { return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }); } catch (x) { return iso; } }
  /* Une phrase en langage courant, tirée de l'issue enregistrée ; rien de plus que ce qu'elle dit. */
  var HEADLINES = {
    "refused": ["Oathrion stopped this action.", "It never ran."],
    "refused-by-person": ["A person refused this action.", "It never ran."],
    "approved-done": ["A person approved this action.", "It ran, and succeeded."],
    "approved-failed": ["A person approved this action.", "It ran, and failed."],
    "approved-not-run": ["A person approved this action.", "It had not run yet when this receipt was issued."],
    "asked-done": ["A person was asked, and allowed it.", "It ran, and succeeded."],
    "asked-failed": ["A person was asked, and allowed it.", "It ran, and failed."],
    "asked-not-run": ["A person was asked.", "It did not run."],
    "waiting": ["This action is waiting for a person.", "Nothing has run yet."],
    "done": ["This action went through, within the rules.", "It ran, and succeeded."],
    "failed": ["This action went through, within the rules.", "It ran, and failed."],
    "not-run": ["Oathrion let this action through.", "It did not run."],
    "running": ["This action was running.", "Its outcome was not known yet."]
  };
  var head = HEADLINES[a.outcome] || [a.outcomeLabel, ""];
  set("headline", head[0]); set("sub", a.agent + " \\u00b7 " + head[1]);
  set("what", a.what); set("agent", a.agent); set("via", a.via); set("at", when(a.at)); set("outcome", a.outcomeLabel);
  set("detail", a.detail); set("ref", a.ref);
  if (a.impact) { set("impact", "Would have deleted " + a.impact); $("spared").hidden = false; }
  set("issuer", s.issuer.name); set("issued", when(s.issuedAt));
  set("chain", (e.chainIntact ? "Intact" : "NOT intact") + " \\u00b7 " + e.chainEntries + " entries");
  var fp = $("fp"); s.issuer.fingerprint.split(" ").forEach(function(group){ var span = document.createElement("span"); span.className = "mono"; span.textContent = group; fp.appendChild(span); });
  var command = "npx oathrion receipt verify " + (decodeURIComponent(location.pathname.split("/").pop() || "") || "<this file>");
  set("cmd", command);
  $("copy").addEventListener("click", function(){ if (navigator.clipboard) navigator.clipboard.writeText(command).then(function(){ $("copy").textContent = "Copied"; setTimeout(function(){ $("copy").textContent = "Copy"; }, 1500); }); });
  var OK = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var BAD = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';
  function verdict(ok, title, body){
    var seal = $("seal"); seal.className = "seal " + (ok ? "ok" : "bad"); seal.innerHTML = ok ? OK : BAD;
    var v = $("verdict"); v.className = "verdict " + (ok ? "ok" : "bad"); v.textContent = title;
    set("verdict-text", body);
  }
  var UNABLE = ["Cannot check here", "This browser cannot check the signature. Run the command below."];
  if (!window.crypto || !crypto.subtle) { verdict(false, UNABLE[0], UNABLE[1]); return; }
  var raw = bytes(s.issuer.publicKey);
  crypto.subtle.digest("SHA-256", raw).then(function(d){
    var hex = Array.prototype.map.call(new Uint8Array(d), function(b){ return ("0" + b.toString(16)).slice(-2); }).join("").slice(0, 32).match(/.{4}/g).join(" ");
    if (hex !== s.issuer.fingerprint) { verdict(false, "Not valid", "The fingerprint shown does not match the key that signed this receipt."); return null; }
    return crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]).then(function(key){
      return crypto.subtle.verify({ name: "Ed25519" }, key, bytes(shared.signature), new TextEncoder().encode(canonical(s)));
    }).then(function(ok){
      if (ok) verdict(true, "Verified", "Not a single character has changed since it was signed by the key below. Compare its fingerprint with the one the sender published.");
      else { verdict(false, "Altered", "This receipt was changed after it was signed. Do not trust what it says."); document.querySelector(".pass").classList.add("untrusted"); }
    });
  }).catch(function(){ verdict(false, UNABLE[0], UNABLE[1]); });
})();
`;

export function receiptHtml(shared: SharedReceipt): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Oathrion receipt</title>
<style>${STYLE}</style>
</head>
<body>
<article class="pass">
  <header class="head"><span class="brand">${LOGO}Oathrion</span><span>Receipt</span></header>
  <section class="hero">
    <div class="seal" id="seal"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle class="ring" cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="2.2" stroke-dasharray="40 14" stroke-linecap="round"/></svg></div>
    <div class="verdict" id="verdict">Checking the signature…</div>
    <p class="vtext" id="verdict-text"></p>
    <h1 id="headline">…</h1>
    <p class="sub" id="sub"></p>
  </section>
  <div class="command mono" id="what"></div>
  <div class="spared" id="spared" hidden><svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3 2.5 20h19L12 3Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M12 10v4.5M12 17.2v.1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><span id="impact"></span></div>
  <dl class="list">
    <div class="row"><dt>Agent</dt><dd id="agent"></dd></div>
    <div class="row"><dt>Outcome</dt><dd id="outcome"></dd></div>
    <div class="row"><dt>When</dt><dd id="at"></dd></div>
    <div class="row"><dt>Why</dt><dd id="detail"></dd></div>
    <div class="row"><dt>How</dt><dd id="via"></dd></div>
    <div class="row"><dt>Reference</dt><dd class="mono" id="ref"></dd></div>
  </dl>
  <div class="tear" aria-hidden="true"><span></span><span></span></div>
  <section class="proof">
    <div class="label">Signed by <span id="issuer"></span></div>
    <div class="fp" id="fp" aria-label="Fingerprint"></div>
    <dl class="list" style="margin:8px 0 0">
      <div class="row"><dt>Issued</dt><dd id="issued"></dd></div>
      <div class="row"><dt>Oathrion's record</dt><dd id="chain"></dd></div>
    </dl>
    <div class="verify"><code class="mono" id="cmd"></code><button type="button" id="copy">Copy</button></div>
    <p class="fine">The signature proves this receipt has not changed since it was issued, by the Oathrion holding the key with the fingerprint above. Compare it with the one the sender published. It proves what Oathrion recorded, nothing more. The check above runs inside this page; the command checks it without trusting the page.</p>
  </section>
</article>
<p class="foot">No receipt, no action. · Made with Oathrion, open source${contactReady() ? ` — ${REPOSITORY_URL}` : ""}.</p>
${embedShared(shared)}
<script>${SCRIPT}</script>
</body>
</html>
`;
}

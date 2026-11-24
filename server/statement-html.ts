/**
 * LES PAGES QUI SE VÉRIFIENT SEULES, pour un relevé de client (le rapport d'une période,
 * `server/local-report.ts`) et pour le passeport d'un agent (`server/local-passport.ts`) — le
 * lot 1 de `notes/CONCEPTION-SAINT-GRAAL-RECUS.md`.
 *
 * Elles s'écrivent pour quelqu'un qui n'est pas développeur et n'utilise pas Oathrion : le client
 * d'une agence, une direction. D'abord le sceau et une phrase ; puis les décisions des personnes,
 * chacune avec l'accord signé par son téléphone, revérifié dans la page ; puis ce qu'Oathrion a
 * arrêté ; puis la preuve et les limites.
 *
 * Comme le reçu (`server/receipt-share-html.ts`) : aucune ressource extérieure, clair et sombre,
 * imprimable ; le vérificateur est dans le fichier, qui le dit, et donne la vérification
 * indépendante (`npx oathrion receipt verify <fichier>`). Toute valeur de la déclaration est posée
 * en TEXTE (`textContent`), jamais en HTML.
 */
import { REPOSITORY_URL, contactReady } from "@shared/contact";
import { embedShared, type Signed, type SignedDocument } from "@shared/receipt-share";

import type { PassportStatement } from "./local-passport";
import { PHONE_CHECK_JS } from "./phone-approval-page";
import type { ReportStatement } from "./local-report";

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
.pass{max-width:640px;margin:0 auto;background:var(--card);border-radius:24px;box-shadow:var(--shadow);overflow:hidden}
.head{padding:28px 28px 0;display:flex;justify-content:space-between;align-items:center;color:var(--soft);font-size:13px;font-weight:500}
.brand{display:flex;align-items:center;gap:8px;color:var(--ink);font-weight:600}
.brand svg{color:var(--accent)}
.hero{padding:28px 28px 8px;text-align:center}
.seal{width:76px;height:76px;margin:0 auto 18px;border-radius:50%;display:grid;place-items:center;background:var(--well);color:var(--wait)}
.seal svg{width:36px;height:36px}
.seal .ring{animation:spin 1.1s linear infinite;transform-origin:50% 50%}
.seal.ok{background:var(--ok-tint);color:var(--ok);animation:pop .5s cubic-bezier(.2,1.4,.4,1)}
.seal.bad{background:var(--bad-tint);color:var(--bad);animation:pop .5s cubic-bezier(.2,1.4,.4,1)}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes pop{0%{transform:scale(.6);opacity:0}100%{transform:scale(1);opacity:1}}
.verdict{font-size:13px;font-weight:600;letter-spacing:.02em;text-transform:uppercase;color:var(--wait)}
.verdict.ok{color:var(--ok)}.verdict.bad{color:var(--bad)}
.vtext{color:var(--soft);font-size:13px;max-width:420px;margin:4px auto 0}
.for{color:var(--accent);font-weight:600;font-size:14px;margin-top:18px}
h1{font-size:26px;line-height:1.2;font-weight:700;letter-spacing:-.025em;margin:6px auto 6px;max-width:480px}
.sub{color:var(--soft);font-size:15px;max-width:480px;margin:0 auto}
.tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:22px 28px 0}
.tile{background:var(--well);border-radius:14px;padding:12px 10px;text-align:center}
.tile b{display:block;font-size:22px;letter-spacing:-.02em}
.tile span{color:var(--soft);font-size:12px}
.tile.bad b{color:var(--bad)}.tile.ok b{color:var(--ok)}
section.part{margin:26px 28px 0}
.label{color:var(--soft);font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;margin-bottom:10px}
.item{border-top:1px solid var(--hair);padding:12px 0;font-size:14px}
.item:first-of-type{border-top:0}
.item .top{display:flex;justify-content:space-between;gap:12px}
.item .top b{font-weight:600}
.item .top span{color:var(--soft);font-size:13px;flex:none}
.item .what{margin-top:6px;background:var(--well);border-radius:10px;padding:8px 10px;font-size:12.5px;overflow-wrap:anywhere;white-space:pre-wrap}
.item .phone{margin-top:6px;font-size:13px;color:var(--wait);font-weight:600}
.item .phone.ok{color:var(--ok)}.item .phone.bad{color:var(--bad)}.item .phone.here{color:var(--soft);font-weight:500}
.item .shown{color:var(--soft);font-size:12.5px;margin-top:2px;overflow-wrap:anywhere}
.item .impact{color:var(--bad);font-weight:600;font-size:13px;margin-top:4px}
.empty{color:var(--soft);font-size:14px}
.row{display:flex;justify-content:space-between;gap:16px;padding:10px 0;border-top:1px solid var(--hair);font-size:14px}
.row:first-child{border-top:0}
.row dt{color:var(--soft);flex:none}
.row dd{text-align:right;min-width:0;overflow-wrap:anywhere}
.tear{position:relative;height:40px;margin-top:24px}
.tear:before{content:"";position:absolute;left:24px;right:24px;top:50%;border-top:2px dashed var(--hair)}
.tear span{position:absolute;top:50%;width:28px;height:28px;margin-top:-14px;border-radius:50%;background:var(--page)}
.tear span:first-child{left:-14px}.tear span:last-child{right:-14px}
.proof{padding:0 28px 28px}
.fp{display:grid;grid-template-columns:repeat(8,1fr);gap:6px;margin-bottom:6px}
.fp span{background:var(--well);border-radius:8px;padding:7px 0;text-align:center;font-size:13px;font-weight:600}
.fine{color:var(--faint);font-size:12.5px;line-height:1.5;margin-top:14px}
.fine li{margin:4px 0 0 18px}
.verify{margin-top:18px;display:flex;align-items:center;gap:8px;background:var(--well);border-radius:12px;padding:10px 10px 10px 14px;font-size:12.5px}
.verify code{flex:1;min-width:0;overflow-x:auto;white-space:nowrap}
.verify button{flex:none;border:0;border-radius:8px;padding:6px 12px;font-family:inherit;font-weight:600;font-size:12.5px;background:var(--card);color:var(--ink);cursor:pointer;box-shadow:0 0 0 1px var(--hair)}
.pass.untrusted .body{opacity:.45;text-decoration:line-through;text-decoration-thickness:1px}
.foot{max-width:640px;margin:20px auto 0;text-align:center;color:var(--faint);font-size:12px}
@media (max-width:520px){body{padding:16px 12px 40px}.head,.hero{padding-left:20px;padding-right:20px}.tiles,section.part{margin-left:20px;margin-right:20px}.tiles{grid-template-columns:repeat(2,1fr)}.proof{padding:0 20px 24px}.fp{grid-template-columns:repeat(4,1fr)}h1{font-size:22px}}
@media print{.seal{animation:none!important}}
@media print{body{background:#fff;padding:0}.pass{box-shadow:none;border:1px solid #ddd}.verify button{display:none}.tear span{background:#fff}}
`;

const LOGO = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 2.5 4.5 5.6v6.1c0 4.6 3.1 8.5 7.5 9.8 4.4-1.3 7.5-5.2 7.5-9.8V5.6L12 2.5Z" fill="currentColor" opacity=".18"/><path d="M12 2.5 4.5 5.6v6.1c0 4.6 3.1 8.5 7.5 9.8 4.4-1.3 7.5-5.2 7.5-9.8V5.6L12 2.5Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="m8.6 12.2 2.4 2.4 4.6-4.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/* Le socle commun : lire la déclaration, la vérifier (Ed25519), écrire du texte, construire des éléments. */
const BASE_JS = `
  var shared = JSON.parse(document.getElementById("oathrion-receipt").textContent);
  var s = shared.statement;
  function $(id){ return document.getElementById(id); }
  function set(id, text){ var el = $(id); if (el) el.textContent = text == null || text === "" ? "\\u2014" : String(text); }
  function el(tag, cls, text){ var node = document.createElement(tag); if (cls) node.className = cls; if (text != null) node.textContent = String(text); return node; }
  function canonical(v){
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
    return "{" + Object.keys(v).filter(function(k){ return v[k] !== undefined; }).sort().map(function(k){ return JSON.stringify(k) + ":" + canonical(v[k]); }).join(",") + "}";
  }
  function bytes(b64){ var bin = atob(b64), out = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
  function when(iso){ try { return new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }); } catch (x) { return iso; } }
  function day(iso){ try { return new Date(iso).toLocaleDateString("en-GB", { dateStyle: "medium" }); } catch (x) { return iso; } }
  ${PHONE_CHECK_JS}
  var OK = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var BAD = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';
  function verdict(ok, title, body){
    var seal = $("seal"); seal.className = "seal " + (ok ? "ok" : "bad"); seal.innerHTML = ok ? OK : BAD;
    var v = $("verdict"); v.className = "verdict " + (ok ? "ok" : "bad"); v.textContent = title;
    set("verdict-text", body);
    if (!ok) document.querySelector(".pass").classList.add("untrusted");
  }
  function proof(){
    set("issuer", s.issuer.name); set("issued", when(s.issuedAt));
    var ev = s.evidence;
    set("chains", ev.intact ? "Both intact \\u00b7 " + ev.receipts.entries + " receipts, " + ev.journal.entries + " journal lines" : "NOT intact when signed");
    var fp = $("fp"); s.issuer.fingerprint.split(" ").forEach(function(group){ fp.appendChild(el("span", "mono", group)); });
    var list = $("limits"); (s.limits || []).forEach(function(limit){ list.appendChild(el("li", null, limit)); });
    var command = "npx oathrion receipt verify " + (decodeURIComponent(location.pathname.split("/").pop() || "") || "<this file>");
    set("cmd", command);
    $("copy").addEventListener("click", function(){ if (navigator.clipboard) navigator.clipboard.writeText(command).then(function(){ $("copy").textContent = "Copied"; setTimeout(function(){ $("copy").textContent = "Copy"; }, 1500); }); });
  }
  /* La signature de la machine, puis celle de chaque téléphone : un seul accord faux, et la page dit « Not valid ». */
  function check(phones, done){
    var UNABLE = ["Cannot check here", "This browser cannot check the signature. Run the command below."];
    if (!window.crypto || !crypto.subtle) { verdict(false, UNABLE[0], UNABLE[1]); return; }
    var raw = bytes(s.issuer.publicKey);
    crypto.subtle.digest("SHA-256", raw).then(function(d){
      if (groups(d) !== s.issuer.fingerprint) { verdict(false, "Not valid", "The fingerprint shown does not match the key that signed this document."); return null; }
      return crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]).then(function(key){
        return crypto.subtle.verify({ name: "Ed25519" }, key, bytes(shared.signature), new TextEncoder().encode(canonical(s)));
      }).then(function(ok){
        if (!ok) { verdict(false, "Altered", "This document was changed after it was signed. Do not trust what it says."); return; }
        return Promise.all(phones.map(function(p){ return checkPhone(p.approval).then(function(good){ p.show(good); return good; }); })).then(function(results){
          var bad = results.filter(function(r){ return !r; }).length;
          if (bad > 0) verdict(false, "Not valid", "It is signed, but " + bad + " phone approval(s) inside it do not check. Do not trust it.");
          else verdict(true, "Verified", "Not a single character has changed since it was signed by the key below" + (phones.length ? ", and each phone's own signature checks" : "") + ". Compare the fingerprint with the one the sender published.");
          if (done) done();
        });
      });
    }).catch(function(){ verdict(false, UNABLE[0], UNABLE[1]); });
  }
  /* Une décision, avec l'accord de son téléphone, revérifié ; ou « no phone signature », dit tel quel. */
  function decisionItem(d, phones){
    var item = el("div", "item");
    var top = el("div", "top"); top.appendChild(el("b", null, d.outcomeLabel)); top.appendChild(el("span", null, when(d.at)));
    item.appendChild(top);
    item.appendChild(el("div", "what mono", d.what));
    if (d.approval) {
      var line = el("div", "phone", "Signed on " + (d.approval.device.label || "a paired phone") + " \\u00b7 checking\\u2026");
      item.appendChild(line);
      item.appendChild(el("div", "shown", "The phone showed: \\u201c" + d.approval.shown.title + "\\u201d"));
      phones.push({ approval: d.approval, show: function(good){
        line.className = "phone " + (good ? "ok" : "bad");
        line.textContent = good ? choiceLabel(d.approval.choice) + " on " + (d.approval.device.label || "a paired phone") + " \\u00b7 the phone's own signature checks \\u00b7 key " + d.approval.device.fingerprint.slice(0, 9) + "\\u2026" : "The phone's signature does NOT check";
      } });
    } else item.appendChild(el("div", "phone here", "No phone signature: decided on this computer, or before the phone signed its answers"));
    return item;
  }
`;

/*
 * LE RELEVÉ, COMME L'ÉCRAN DE CLAUDE CODE (23 novembre, vidéo du fondateur) : une phrase de
 * résumé ; les étapes groupées par semaine (ou par jour sur une courte période), repliées, chacune
 * en mots simples avec sa commande exacte repliée dessous ; les décisions des personnes et les
 * arrêts d'Oathrion jamais repliés, à leur place dans le temps ; la preuve repliée en bas.
 */
const REPORT_JS = `
(function(){
  ${BASE_JS}
  var sum = s.summary, decisions = s.decisions || [], saves = s.saves || [], steps = s.steps || [], phones = [];
  if (s.subject) set("for", "For " + s.subject);
  var scope = s.scope;
  var where = scope ? (scope.project ? scope.project : "") + (scope.servers && scope.servers.length ? (scope.project ? " + " : "") + scope.servers.join(", ") : "") : "this machine";
  var agents = (s.agents || []).map(function(a){ return a.agent; });
  var decided = decisions.length + (s.decisionsTruncated || 0), signed = sum.signedByPhone || 0;
  var plural = function(n, one, many){ return n + " " + (n === 1 ? one : many); };
  function dayOnly(iso){ try { return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long" }); } catch (x) { return iso; } }
  var headline = "Your agents did " + plural(sum.total, "thing", "things") + " " + (scope && scope.project ? "in this project" : "on " + where) + ", from " + dayOnly(s.period.since) + " to " + dayOnly(s.period.until) + ".";
  if (decided > 0) headline += " A person decided " + plural(decided, "time", "times") + (signed > 0 ? (signed === decided ? ", each on their phone" : ", " + signed + " on their phone") : "") + ".";
  if (sum.blocked > 0) headline += " Oathrion stopped " + plural(sum.blocked, "action", "actions") + ".";
  set("headline", headline);
  set("sub", where + (agents.length ? " \\u00b7 " + agents.join(", ") : ""));

  /* Les moments qui ne se replient jamais : décisions et arrêts, à leur place dans le temps. */
  var moments = [];
  decisions.forEach(function(d){ moments.push({ at: d.at, kind: "decision", d: d }); });
  saves.forEach(function(x){ moments.push({ at: x.at, kind: "stop", x: x }); });
  moments.sort(function(a, b){ return a.at < b.at ? -1 : a.at > b.at ? 1 : 0; });
  var momentRefs = {}; decisions.forEach(function(d){ momentRefs[d.ref] = true; }); saves.forEach(function(x){ momentRefs[x.ref] = true; });

  function exact(command){
    var d = el("details", "exact"); d.appendChild(el("summary", null, "Show the exact command"));
    d.appendChild(el("div", "code mono", command)); return d;
  }
  function momentNode(m){
    var box = el("div", "moment");
    if (m.kind === "stop") {
      var x = m.x; box.className = "moment stop";
      box.appendChild(el("div", "t", "Oathrion stopped: " + (x.todo || "an action")));
      box.appendChild(el("div", "s", when(x.at) + " \\u00b7 it never ran" + (x.impact ? " \\u00b7 it would have deleted " + x.impact : "")));
      box.appendChild(exact(x.what));
      return box;
    }
    var d = m.d, yes = /^approved|^asked-done|^asked-failed/.test(d.outcome);
    box.className = "moment " + (yes ? "ok" : "no");
    box.appendChild(el("div", "t", (yes ? "Approved: " : d.outcome === "refused-by-person" ? "Refused: " : "Asked: ") + (d.todo || "an action")));
    var said = d.approval ? " \\u00b7 the agent asked \\u201c" + d.approval.shown.title + "\\u201d" : "";
    box.appendChild(el("div", "s", when(d.at) + said + " \\u00b7 " + d.outcomeLabel));
    if (d.approval) {
      var line = el("div", "sig wait", "Signed on " + (d.approval.device.label || "a paired phone") + " \\u00b7 checking\\u2026");
      box.appendChild(line);
      phones.push({ approval: d.approval, show: function(good){
        line.className = "sig " + (good ? "ok" : "bad");
        line.textContent = good ? "Signed on " + (d.approval.device.label || "a paired phone") + " \\u00b7 the phone's own signature checks" : "The phone's signature does NOT check";
      } });
    } else box.appendChild(el("div", "sig here", "No phone signature"));
    box.appendChild(exact(d.what));
    return box;
  }
  var RESULT = { done: "It worked", "approved-done": "It worked", "asked-done": "It worked", failed: "It failed", "approved-failed": "It failed", "asked-failed": "It failed", "not-run": "It did not run", "asked-not-run": "It did not run", "approved-not-run": "Not run yet", running: "Running", waiting: "Waiting for a person", refused: "Stopped by Oathrion", "refused-by-person": "Refused by a person" };
  var COUNT = { tests: ["ran the tests", 1], build: ["built the project", 1], lint: ["checked the code", 1], save: ["saved the work", 1], publish: ["published", 1], deploy: ["put the site live", 1], install: ["installed packages", 1], look: ["looked at files", 1], history: ["looked at the code history", 1], files: ["changed", 2], "delete": ["deleted", 1], internet: ["reached the internet", 1], database: ["used the database", 1], remote: ["connected to another computer", 1], outside: ["read content from outside", 1], tool: ["used a tool", 1], other: ["ran", 3] };
  function times(n){ return n === 1 ? "once" : n === 2 ? "twice" : n + " times"; }
  function summaryOf(list){
    var counts = {}, order = [];
    list.forEach(function(st){ if (!counts[st.key]) { counts[st.key] = 0; order.push(st.key); } counts[st.key]++; });
    order.sort(function(a, b){ return a === "other" ? 1 : b === "other" ? -1 : counts[b] - counts[a]; });
    var parts = order.slice(0, 4).map(function(k){
      var c = COUNT[k] || ["ran", 3], n = counts[k];
      return c[1] === 2 ? c[0] + " " + plural(n, "file", "files") : c[1] === 3 ? c[0] + " " + plural(n, "other command", "other commands") : c[0] + " " + times(n);
    });
    var rest = order.slice(4).reduce(function(t, k){ return t + counts[k]; }, 0);
    if (rest) parts.push("and " + rest + " more");
    return parts.join(", ");
  }
  /* Par semaine (du lundi), ou par jour quand la période tient en une semaine. */
  var span = (Date.parse(s.period.until) - Date.parse(s.period.since)) / 86400000;
  function groupKey(iso){
    var d = new Date(iso); d.setHours(0, 0, 0, 0);
    if (span > 8) d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return d.getTime();
  }
  var buckets = [], byKey = {};
  steps.forEach(function(st){
    if (momentRefs[st.ref]) return;
    var k = groupKey(st.at);
    if (!byKey[k]) { byKey[k] = { key: k, steps: [] }; buckets.push(byKey[k]); }
    byKey[k].steps.push(st);
  });
  moments.forEach(function(m){ var k = groupKey(m.at); if (!byKey[k]) { byKey[k] = { key: k, steps: [] }; buckets.push(byKey[k]); } });
  buckets.sort(function(a, b){ return a.key - b.key; });
  function shortDay(iso){ try { return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" }); } catch (x) { return iso; } }
  var thread = $("thread");
  if (s.steps === undefined) thread.appendChild(el("p", "say", s.decisions === null ? "This statement keeps numbers only." : "This statement lists the decisions and what Oathrion stopped; the other actions are counted above."));
  var placed = {};
  buckets.forEach(function(g){
    if (g.steps.length) {
      var first = g.steps[0].at, last = g.steps[g.steps.length - 1].at;
      var label = shortDay(first) === shortDay(last) ? shortDay(first) : shortDay(first) + " \\u2013 " + shortDay(last);
      var box = el("details", "group");
      var head = el("summary"); head.appendChild(el("span", "when", label)); head.appendChild(el("span", "what", " \\u00b7 " + summaryOf(g.steps)));
      box.appendChild(head);
      /* Les étapes identiques ensemble, comme l'écran de Claude Code : « Ran the tests · 5 times », dépliable sur chaque commande. */
      var list = el("div", "steps"), kinds = [], byDone = {};
      g.steps.forEach(function(st){ if (!byDone[st.done]) { byDone[st.done] = []; kinds.push(st.done); } byDone[st.done].push(st); });
      kinds.forEach(function(done){
        var same = byDone[done], d = el("details", "step"), sm = el("summary");
        sm.appendChild(el("span", "verb", done));
        if (same.length > 1) sm.appendChild(el("span", "detail", " \u00b7 " + (same[0].key === "files" ? plural(same.length, "file", "files") : times(same.length))));
        else if (same[0].detail) sm.appendChild(el("span", "detail", " \u00b7 " + same[0].detail));
        d.appendChild(sm);
        same.slice(0, 30).forEach(function(st){
          d.appendChild(el("div", "code mono", st.what));
          d.appendChild(el("p", "result", (RESULT[st.outcome] || st.outcome) + " \u00b7 " + when(st.at)));
        });
        if (same.length > 30) d.appendChild(el("p", "result", "\u2026 and " + (same.length - 30) + " more"));
        list.appendChild(d);
      });
      box.appendChild(list);
      thread.appendChild(box);
    }
    moments.forEach(function(m, i){ if (!placed[i] && groupKey(m.at) === g.key) { placed[i] = true; thread.appendChild(momentNode(m)); } });
  });
  moments.forEach(function(m, i){ if (!placed[i]) thread.appendChild(momentNode(m)); });
  if (s.stepsTruncated) thread.insertBefore(el("p", "say", "The " + s.stepsTruncated + " oldest steps are counted above, not listed."), thread.firstChild);
  if (s.decisionsTruncated) thread.appendChild(el("p", "say", "And " + s.decisionsTruncated + " older decision(s), counted above."));
  proof();
  check(phones);
})();
`;

const PASSPORT_JS = `
(function(){
  ${BASE_JS}
  var a = s.agent, r = s.record;
  if (s.subject) set("for", "For " + s.subject);
  set("headline", a.name);
  set("sub", "Agent passport \\u00b7 " + day(s.period.since) + " \\u2013 " + day(s.period.until));
  set("t-total", r.total); set("t-passed", r.passed); set("t-decided", r.approvedByPerson + r.refusedByPerson); set("t-blocked", r.blocked);
  set("decided-sum", (r.signedByPhone || 0) + " decision(s) signed on a person's own phone.");
  var id = $("identity");
  function row(k, v){ var line = el("div", "row"); line.appendChild(el("dt", null, k)); line.appendChild(el("dd", "mono", v)); id.appendChild(line); }
  row("First seen", a.firstSeen ? when(a.firstSeen) : "\\u2014");
  row("Last seen", a.lastSeen ? when(a.lastSeen) : "\\u2014");
  if (a.program) { row("Program", a.program.executable); row("Fingerprint", a.program.sha256.slice(0, 16) + "\\u2026"); row("Admitted", a.program.admittedAt ? when(a.program.admittedAt) : "\\u2014"); }
  else row("Program", "Not read by Oathrion");
  if (s.hookRules) row("Rules in force", s.hookRules.inForce.length + " \\u00b7 " + s.hookRules.off.length + " turned off");
  var tools = $("tools");
  (s.tools || []).forEach(function(t){ var line = el("div", "row"); line.appendChild(el("dt", null, t.tool)); line.appendChild(el("dd", null, t.total + " actions \\u00b7 " + t.asked + " asked \\u00b7 " + t.blocked + " stopped")); tools.appendChild(line); });
  if (!s.tools || s.tools.length === 0) tools.appendChild(el("p", "empty", "Nothing in this period."));
  var last = $("last");
  if (s.lastStopped) {
    var item = el("div", "item");
    var top = el("div", "top"); top.appendChild(el("b", null, "Last stopped")); top.appendChild(el("span", null, when(s.lastStopped.at)));
    item.appendChild(top); item.appendChild(el("div", "what mono", s.lastStopped.what));
    if (s.lastStopped.impact) item.appendChild(el("div", "impact", "Would have deleted " + s.lastStopped.impact));
    last.appendChild(item);
  } else last.appendChild(el("p", "empty", "Nothing had to be stopped."));
  proof();
  check([]);
})();
`;

function page(title: string, kind: string, shared: Signed<SignedDocument>, sections: string, script: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${title}</title>
<style>${STYLE}</style>
</head>
<body>
<article class="pass">
  <header class="head"><span class="brand">${LOGO}Oathrion</span><span>${kind}</span></header>
  <section class="hero">
    <div class="seal" id="seal"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle class="ring" cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="2.2" stroke-dasharray="40 14" stroke-linecap="round"/></svg></div>
    <div class="verdict" id="verdict">Checking the signatures…</div>
    <p class="vtext" id="verdict-text"></p>
    <p class="for" id="for"></p>
    <h1 id="headline">…</h1>
    <p class="sub" id="sub"></p>
  </section>
  <div class="body">
  <div class="tiles">
    <div class="tile"><b id="t-total"></b><span>Actions</span></div>
    <div class="tile"><b id="t-passed"></b><span>Within the rules</span></div>
    <div class="tile ok"><b id="t-decided"></b><span>Decided by a person</span></div>
    <div class="tile bad"><b id="t-blocked"></b><span>Stopped by Oathrion</span></div>
  </div>
  ${sections}
  </div>
  <div class="tear" aria-hidden="true"><span></span><span></span></div>
  <section class="proof">
    <div class="label">Signed by <span id="issuer"></span></div>
    <div class="fp" id="fp" aria-label="Fingerprint"></div>
    <dl style="margin:8px 0 0">
      <div class="row"><dt>Issued</dt><dd id="issued"></dd></div>
      <div class="row"><dt>Oathrion's records</dt><dd id="chains"></dd></div>
    </dl>
    <div class="verify"><code class="mono" id="cmd"></code><button type="button" id="copy">Copy</button></div>
    <div class="fine">The signature proves this document has not changed since it was issued, by the Oathrion holding the key with the fingerprint above: compare it with the one the sender published. It proves what Oathrion recorded, nothing more. The check above runs inside this page; the command checks it without trusting the page.<ul id="limits"></ul></div>
  </section>
</article>
<p class="foot">No receipt, no action. · Made with Oathrion, open source${contactReady() ? ` — ${REPOSITORY_URL}` : ""}.</p>
${embedShared(shared)}
<script>${script}</script>
</body>
</html>
`;
}

/* La mise en page du relevé : le fil d'abord, la preuve repliée en bas. */
const STATEMENT_STYLE = `
.pass{max-width:720px}
.top{padding:24px 28px 0}
.pill{display:inline-flex;align-items:center;gap:8px;border-radius:999px;padding:5px 12px 5px 6px;background:var(--well);font-size:13px}
.pill .seal{width:24px;height:24px;margin:0}
.pill .seal svg{width:14px;height:14px}
.pill .verdict{font-size:12.5px}
.top .vtext{margin:6px 0 0;max-width:none;text-align:left}
.top .for{margin-top:16px}
.top h1{font-size:21px;line-height:1.35;margin:4px 0 6px;max-width:none;text-align:left}
.top .sub{margin:0;max-width:none;text-align:left;font-size:14px}
.thread{margin:22px 28px 0;border-left:2px solid var(--hair);padding-left:16px}
.say{color:var(--soft);font-size:14px;margin:10px 0}
details>summary{list-style:none;cursor:pointer}
details>summary::-webkit-details-marker{display:none}
details>summary::after{content:" ›";color:var(--faint);display:inline-block;transition:transform .15s}
details[open]>summary::after{transform:rotate(90deg)}
.group>summary{padding:6px 0;font-size:14.5px;color:var(--soft)}
.group>summary .when{color:var(--ink);font-weight:600}
.steps{margin:2px 0 8px 12px}
.step>summary{font-size:14px;padding:3px 0}
.step .verb{color:var(--ink)}
.step .detail{color:var(--soft);overflow-wrap:anywhere}
.code{background:var(--well);border-radius:8px;padding:8px 10px;margin:4px 0;font-size:12.5px;white-space:pre-wrap;overflow-wrap:anywhere}
.result{color:var(--faint);font-size:12.5px;margin:2px 0 6px}
.moment{border-radius:12px;padding:12px 14px;margin:10px 0;background:var(--well)}
.moment .t{font-weight:600;overflow-wrap:anywhere}
.moment .s{color:var(--soft);font-size:13px;margin-top:2px;overflow-wrap:anywhere}
.moment.ok{box-shadow:inset 3px 0 0 var(--ok)}
.moment.no{box-shadow:inset 3px 0 0 var(--accent)}
.moment.stop{box-shadow:inset 3px 0 0 var(--bad)}
.moment .sig{font-size:12.5px;font-weight:600;margin-top:4px;color:var(--wait)}
.moment .sig.ok{color:var(--ok)}.moment .sig.bad{color:var(--bad)}.moment .sig.here{color:var(--soft);font-weight:500}
.exact>summary{font-size:12.5px;color:var(--soft);padding:4px 0 0}
details.proofbox{margin:26px 28px 0;border-top:1px dashed var(--hair);padding:14px 0 26px}
details.proofbox>summary{color:var(--soft);font-size:14px}
details.proofbox .label{margin-top:14px}
.pass.untrusted .thread,.pass.untrusted .top h1{opacity:.45;text-decoration:line-through;text-decoration-thickness:1px}
@media (max-width:520px){.top{padding:20px 20px 0}.thread{margin-left:20px;margin-right:20px}details.proofbox{margin-left:20px;margin-right:20px}}
@media print{details>summary::after{display:none}}
`;

/** Le relevé d'un client : ce que les agents ont fait chez lui, comme l'écran de Claude Code, et les décisions signées par un téléphone. */
export function statementHtml(shared: Signed<ReportStatement>): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Oathrion statement</title>
<style>${STYLE}${STATEMENT_STYLE}</style>
</head>
<body>
<article class="pass">
  <header class="head"><span class="brand">${LOGO}Oathrion</span><span>Statement</span></header>
  <section class="top">
    <span class="pill"><span class="seal" id="seal"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle class="ring" cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="2.2" stroke-dasharray="40 14" stroke-linecap="round"/></svg></span><span class="verdict" id="verdict">Checking the signatures…</span></span>
    <p class="vtext" id="verdict-text"></p>
    <p class="for" id="for"></p>
    <h1 id="headline">…</h1>
    <p class="sub" id="sub"></p>
  </section>
  <div class="thread" id="thread"></div>
  <details class="proofbox">
    <summary>How do I know this is true?</summary>
    <div class="label">Signed by <span id="issuer"></span></div>
    <div class="fp" id="fp" aria-label="Fingerprint"></div>
    <dl style="margin:8px 0 0">
      <div class="row"><dt>Issued</dt><dd id="issued"></dd></div>
      <div class="row"><dt>Oathrion's records</dt><dd id="chains"></dd></div>
    </dl>
    <div class="verify"><code class="mono" id="cmd"></code><button type="button" id="copy">Copy</button></div>
    <div class="fine">This page checked its own signature when you opened it: not a single character has changed since it was issued by the Oathrion holding the key with the fingerprint above. Compare it with the one the sender published. Each decision signed on a phone carries that phone's own signature, checked too. It proves what Oathrion recorded, nothing more. The command checks it without trusting this page.<ul id="limits"></ul></div>
  </details>
</article>
<p class="foot">No receipt, no action. · Made with Oathrion, open source${contactReady() ? ` — ${REPOSITORY_URL}` : ""}.</p>
${embedShared(shared)}
<script>${REPORT_JS}</script>
</body>
</html>
`;
}

/** Le passeport d'un agent : qui il est, ce qu'il a fait, ce qu'Oathrion a arrêté. */
export function passportHtml(shared: Signed<PassportStatement>): string {
  return page(
    "Oathrion agent passport",
    "Agent passport",
    shared,
    `<section class="part"><div class="label">Identity</div><dl id="identity"></dl><p class="sub" style="margin:10px 0 0;font-size:14px;text-align:left" id="decided-sum"></p></section>
  <section class="part"><div class="label">What it reached</div><dl id="tools"></dl></section>
  <section class="part"><div class="label">What Oathrion stopped</div><div id="last"></div></section>`,
    PASSPORT_JS,
  );
}

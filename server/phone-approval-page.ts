/**
 * Le vérificateur de l'accord d'un téléphone, DANS les pages partagées (le reçu, le relevé, le
 * passeport) : la même vérification que `shared/phone-approval.ts`, en WebCrypto (ECDSA P-256,
 * SHA-256), sans réseau.
 *
 * Une chaîne de JavaScript à placer dans le script de la page, où `canonical(valeur)` et
 * `bytes(base64)` existent déjà. Elle définit `checkPhone(accord)`, une promesse de vrai ou faux.
 */
export const PHONE_CHECK_JS = `
  function b64uBytes(text){ text = String(text).replace(/-/g, "+").replace(/_/g, "/"); while (text.length % 4) text += "="; return bytes(text); }
  function toB64u(buffer){ var out = ""; new Uint8Array(buffer).forEach(function(b){ out += String.fromCharCode(b); }); return btoa(out).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, ""); }
  function groups(buffer){ return Array.prototype.map.call(new Uint8Array(buffer), function(b){ return ("0" + b.toString(16)).slice(-2); }).join("").slice(0, 32).match(/.{4}/g).join(" "); }
  function checkPhone(a){
    try {
      var sh = a.shown || {}, t = function(v){ return typeof v === "string" ? v : ""; };
      var shown = { route: t(sh.route), agent: t(sh.agent), computer: t(sh.computer), title: t(sh.title), body: t(sh.body), at: typeof sh.at === "number" && isFinite(sh.at) ? sh.at : 0 };
      var raw = b64uBytes(a.device.publicKey);
      return crypto.subtle.digest("SHA-256", raw).then(function(d){
        if (groups(d) !== a.device.fingerprint) return false;
        return crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(shown))).then(function(digest){
          var data = "oathrion-phone-v1|approval|" + shown.route + "|" + a.nonce + "|" + a.choice + "|" + String(a.at) + "|" + toB64u(digest);
          return crypto.subtle.importKey("raw", raw, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]).then(function(key){
            return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, b64uBytes(a.signature), new TextEncoder().encode(data));
          });
        });
      }).catch(function(){ return false; });
    } catch (x) { return Promise.resolve(false); }
  }
  function choiceLabel(choice){ return choice === "approve" ? "Approved" : choice === "reject" ? "Rejected" : choice === "allow-hour" ? "Allowed for 1 hour" : choice; }
`;

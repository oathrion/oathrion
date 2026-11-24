/*
 * La clé de CET appareil (ECDSA P-256, non exportable), gardée par le navigateur du téléphone :
 * chaque appui la signe ; le relais puis l'ordinateur vérifient la signature. Partagé par les
 * pages et par le service worker (`importScripts`). `notes/CONCEPTION-RELAIS-TELEPHONE.md`.
 */
const OATH = (() => {
  const open = () =>
    new Promise((resolve, reject) => {
      const request = indexedDB.open("oathrion", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("keys");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  const get = async (key) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const request = db.transaction("keys").objectStore("keys").get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  };
  const put = async (key, value) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("keys", "readwrite");
      tx.objectStore("keys").put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  };
  const b64u = (bytes) => {
    let text = "";
    for (const byte of new Uint8Array(bytes)) text += String.fromCharCode(byte);
    return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  const unb64u = (text) => {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  };
  const deviceKey = async () => {
    let pair = await get("device");
    if (!pair) {
      pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
      await put("device", pair);
    }
    return pair;
  };
  const devicePublic = async () => b64u(await crypto.subtle.exportKey("raw", (await deviceKey()).publicKey));
  const sign = async (data) => b64u(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, (await deviceKey()).privateKey, new TextEncoder().encode(`oathrion-phone-v1|${data}`)));
  const post = async (path, body) => {
    const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { ok: response.ok, ...(await response.json().catch(() => ({}))) };
  };
  /*
   * Ce que CETTE page a montré, ramené à la même forme que l'ordinateur (`shared/phone-approval.ts`) :
   * clés triées, JSON compact, puis SHA-256. C'est sur cette empreinte que le téléphone signe son accord.
   */
  const shownDigest = async (data) => {
    const text = (value) => (typeof value === "string" ? value : "");
    const shown = { agent: text(data.agent), at: typeof data.at === "number" && Number.isFinite(data.at) ? data.at : 0, body: text(data.body), computer: text(data.computer), route: text(data.route), title: text(data.title) };
    const canonical = `{${Object.keys(shown).sort().map((key) => `${JSON.stringify(key)}:${JSON.stringify(shown[key])}`).join(",")}}`;
    return b64u(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)));
  };
  /*
   * Un bouton : la route de la machine, le nonce de CETTE notification, le choix, l'heure, signés.
   * Et l'accord : les mêmes, plus l'empreinte de ce qui a été montré — la preuve que l'ordinateur
   * garde dans ses reçus, et qu'il ne peut pas fabriquer sans ce téléphone.
   */
  const press = async (data, choice) => {
    const at = Date.now();
    const device = await devicePublic();
    const sig = await sign(`press|${data.route}|${data.nonce}|${choice}|${at}`);
    const approval = await sign(`approval|${data.route}|${data.nonce}|${choice}|${at}|${await shownDigest(data)}`);
    return post("/v1/web/press", { route: data.route, nonce: data.nonce, choice, at, device, sig, approval });
  };
  const unpair = async () => {
    const at = Date.now();
    const device = await devicePublic();
    return post("/v1/web/unpair", { device, at, sig: await sign(`unpair|${device}|${at}`) });
  };
  /*
   * Les boutons dans la notification : éteints par défaut. Le filtre anti-spam de Chrome sur
   * Android juge le texte des boutons (essai réel du 23 novembre : les notifications avec boutons
   * signalées, celles sans boutons non). Toucher la notification ouvre la page de la demande.
   */
  const quick = async () => (await get("quick")) === true;
  const setQuick = (on) => put("quick", on === true);
  return { b64u, unb64u, devicePublic, shownDigest, post, press, unpair, quick, setQuick };
})();

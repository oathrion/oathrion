/*
 * Le service worker d'Oathrion sur le téléphone : il montre chaque demande (déchiffrée par le
 * navigateur, chiffrée par l'ordinateur — le relais ne la lit pas), avec le visage de l'agent, et
 * envoie le bouton touché, signé par la clé de cet appareil.
 */
importScripts("/common.js");

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

const asked = (data) => Array.isArray(data.actions) && data.actions.length > 0;

const show = async (data, body) => {
  /* Les boutons, seulement si la personne les a demandés (`OATH.quick`) ; sinon, toucher ouvre la demande. */
  const quick = await OATH.quick().catch(() => false);
  const hint = asked(data) && !quick ? "\nTouch to answer." : "";
  /*
   * Une demande dite comme un ami (`style: "friendly"`) : comme un message, le nom de l'agent en
   * titre, sa question et ce que ça change dessous ; le code exact est sur la page de la demande.
   */
  const friendly = data.style === "friendly" && body === undefined;
  const title = friendly ? data.agent || "Oathrion" : data.title || "Oathrion";
  const text = friendly ? [data.title, String(data.body || "").split("\n\n")[0]].filter(Boolean).join("\n") : (body ?? data.body ?? "");
  return self.registration.showNotification(title, {
    /* Qui, quoi (le titre), pourquoi, et sur quel ordinateur. */
    body: `${text}${data.computer ? `\n${data.computer}` : ""}${hint}`,
    tag: data.tag,
    renotify: data.renotify === true,
    requireInteraction: asked(data),
    silent: data.silent === true,
    /* Une vibration à elle (courte, courte) : une demande d'Oathrion se reconnaît sans regarder. */
    vibrate: data.silent === true ? undefined : [120, 80, 120],
    icon: /^[a-z]{2,20}$/.test(data.mascot || "") ? `/mascots/${data.mascot}.png` : "/icon.png",
    /* La petite icône de la barre d'état : une silhouette blanche (Android la dessine en masque). */
    badge: "/badge.png",
    timestamp: typeof data.at === "number" ? data.at : Date.now(),
    /* Deux boutons au plus sur Android : les autres sont sur la page qu'ouvre la notification. */
    actions: quick ? (data.actions || []).filter((a) => a.choice !== "allow-hour").slice(0, 2).map((a) => ({ action: a.choice, title: a.label })) : [],
    data,
  });
};

self.addEventListener("push", (event) => {
  let data;
  try {
    data = event.data.json();
  } catch {
    data = { title: "Oathrion", body: "" };
  }
  event.waitUntil(show(data));
});

self.addEventListener("notificationclick", (event) => {
  const data = event.notification.data || {};
  event.notification.close();
  if (event.action && data.route && data.nonce) {
    const failed = (error) => show({ ...data, actions: [] }, `Not sent: ${error || "your phone is offline"}. Decide in Oathrion's console.`);
    event.waitUntil(
      OATH.press(data, event.action)
        .then((reply) => (reply.ok ? undefined : failed(reply.error)))
        .catch(() => failed()),
    );
    return;
  }
  /* iPhone (pas de boutons), ou toucher le texte : la page de la demande, ses boutons. Le texte reste dans le fragment. */
  event.waitUntil(self.clients.openWindow(`/decide#${OATH.b64u(new TextEncoder().encode(JSON.stringify(data)))}`));
});

/* La page d'appairage du téléphone (`/pair#<code>`) : le code reste dans le fragment. */
(() => {
  const $ = (id) => document.getElementById(id);
  const code = /^[A-Za-z0-9_-]{33}$/.test(location.hash.slice(1)) ? location.hash.slice(1) : "";
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const android = /Android/.test(navigator.userAgent);
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const status = (text, bad) => {
    $("status").textContent = text;
    $("status").className = `${bad ? "bad" : "muted"} center`;
  };
  const only = (id) => {
    for (const step of ["step-allow", "step-ios", "step-scan", "step-paired"]) $(step).hidden = step !== id;
  };
  const heading = (before, strong) => {
    $("heading").textContent = before;
    const span = document.createElement("span");
    span.className = "grad";
    span.textContent = strong;
    $("heading").append(span);
  };
  /* Ajoutée à l'écran d'accueil (iPhone), la page s'ouvre avec son code. */
  if (code) $("manifest").href = `/manifest.webmanifest?c=${code}`;
  $("label").value = ios ? "iPhone" : android ? "Android phone" : "This browser";

  /* Android : Oathrion sur l'écran d'accueil, comme une application, une fois appairé. */
  let installer = null;
  addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    installer = event;
    if (!$("step-paired").hidden) $("install").hidden = false;
  });
  $("install").addEventListener("click", async () => {
    if (!installer) return;
    installer.prompt();
    await installer.userChoice;
    installer = null;
    $("install").hidden = true;
  });

  const showPaired = (computer) => {
    only("step-paired");
    $("steps").hidden = false;
    $("step1").className = "";
    $("step2").className = "on";
    heading("Paired with ", computer);
    $("what").hidden = true;
    $("paired-text").textContent = "✓ This phone approves for that computer";
    $("ring").classList.remove("glow");
    $("ring").classList.add("pop");
    if (!$("ring").querySelector(".check")) {
      const check = document.createElement("span");
      check.className = "check";
      check.textContent = "✓";
      $("ring").append(check);
    }
    if (installer) $("install").hidden = false;
  };

  const capable = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const paired = localStorage.getItem("oathrion.paired");
  if (!capable) {
    if (ios && !standalone) only("step-ios");
    else status("This browser cannot receive notifications. Open this page in Chrome (Android) or Safari (iPhone).", true);
  } else if (code) {
    /* Les deux écrans se répondent : la console voit la page ouverte ; la page dit à quel ordinateur elle se lie. */
    OATH.post("/v1/web/seen", { code })
      .then((reply) => {
        if (reply.ok) {
          heading("Pair with ", reply.computer);
          $("steps").hidden = false;
          only("step-allow");
        } else {
          only("step-scan");
          status(reply.error || "This code has expired: show a new one in the console.", true);
        }
      })
      .catch(() => status("No connection: check this phone's internet, then reload the page.", true));
  } else if (paired) {
    showPaired(paired);
  } else {
    only("step-scan");
  }

  $("allow").addEventListener("click", async () => {
    $("allow").disabled = true;
    status("Pairing…");
    try {
      const registration = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      if ((await Notification.requestPermission()) !== "granted") {
        status("Notifications are blocked for this page. Allow them in your browser's settings (the lock next to the address), then tap again.", true);
        $("allow").disabled = false;
        return;
      }
      const { key } = await (await fetch("/v1/web/key")).json();
      const old = await registration.pushManager.getSubscription();
      if (old) await old.unsubscribe();
      const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: OATH.unb64u(key) });
      const label = $("label").value.trim().slice(0, 40) || "My phone";
      const reply = await OATH.post("/v1/web/pair", { code, subscription: subscription.toJSON(), device: await OATH.devicePublic(), label });
      if (!reply.ok) {
        status(reply.error || "Pairing failed: show a new code in the console.", true);
        $("allow").disabled = false;
        return;
      }
      localStorage.setItem("oathrion.paired", reply.computer);
      history.replaceState(null, "", "/pair");
      status("");
      showPaired(reply.computer);
    } catch (error) {
      /* Une fenêtre privée, ou un navigateur qui ne garde pas de service worker : le dire simplement. */
      const detail = error && error.message ? error.message : String(error);
      status(/ServiceWorker|service worker/i.test(detail) ? "This browser cannot show Oathrion's notifications here (a private window?). Open this page in Chrome (Android) or Safari (iPhone), in a normal window." : `Pairing failed: ${detail}`, true);
      $("allow").disabled = false;
    }
  });

  $("unpair").addEventListener("click", async () => {
    $("unpair").disabled = true;
    try {
      await OATH.unpair();
      const registration = await navigator.serviceWorker.getRegistration();
      const subscription = registration && (await registration.pushManager.getSubscription());
      if (subscription) await subscription.unsubscribe();
      localStorage.removeItem("oathrion.paired");
      $("step-paired").hidden = true;
      $("steps").hidden = true;
      heading("This phone is ", "unpaired");
      status("No more requests will arrive here.");
    } catch {
      status("Not unpaired: check your connection, then try again.", true);
      $("unpair").disabled = false;
    }
  });
})();

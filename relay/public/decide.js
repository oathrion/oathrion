/*
 * La page d'une demande (iPhone, ou le texte de la notification touché) : qui demande, quoi, sur
 * quel ordinateur, et les boutons — signés comme ceux de la notification. Bilan design du 23
 * novembre : la mascotte de l'agent, la commande à part, Approve en premier, Reject franc,
 * « Allow 1 hour » en lien discret, puis un écran de résultat et « Was this right? ».
 */
(() => {
  const $ = (id) => document.getElementById(id);
  let data = {};
  try {
    data = JSON.parse(new TextDecoder().decode(OATH.unb64u(location.hash.slice(1))));
  } catch {
    /* Pas de demande dans l'adresse. */
  }
  history.replaceState(null, "", "/decide");

  if (/^[a-z]{2,20}$/.test(data.mascot || "")) $("face").src = `/mascots/${data.mascot}.png`;
  $("agent").textContent = data.agent || "Oathrion";
  const minutes = typeof data.at === "number" ? Math.max(0, Math.round((Date.now() - data.at) / 60000)) : null;
  $("where").textContent = [data.computer ? `on ${data.computer}` : "", minutes === null ? "" : minutes < 1 ? "just now" : `${minutes} min ago`].filter(Boolean).join(" · ");
  if (data.danger) $("card").classList.add("danger");

  const title = String(data.title || "Oathrion");
  const friendly = data.style === "friendly";
  if (friendly) {
    /* L'agent écrit comme un ami : sa question en grand, ce que ça change, puis son code exact en petit. */
    const [why, ...code] = String(data.body || "").split("\n\n");
    $("title").textContent = title;
    $("body").textContent = why || "";
    /* Ce que ça change, juste sous la question ; le code en dernier. */
    $("cmd").before($("body"));
    if (code.join("\n\n").trim()) {
      $("cmd").textContent = code.join("\n\n");
      $("cmd").hidden = false;
    }
  } else {
    /* « Claude Code wants to run: rm -rf dist/ » : la phrase en titre, la commande à part, en chasse fixe. */
    const split = title.indexOf(": ");
    if (split > 0 && split < title.length - 2 && /wants to|asks to/.test(title.slice(0, split))) {
      $("title").textContent = title.slice(0, split);
      $("cmd").textContent = title.slice(split + 2);
      $("cmd").hidden = false;
    } else {
      $("title").textContent = title;
    }
    $("body").textContent = data.body || "";
  }

  const send = async (choice, buttons) => {
    for (const b of buttons) b.disabled = true;
    $("status").textContent = "Sending…";
    $("status").className = "muted center";
    try {
      const reply = await OATH.press(data, choice);
      if (!reply.ok) throw new Error(reply.error || "Not sent.");
      $("status").textContent = "";
      return true;
    } catch (error) {
      $("status").textContent = error && error.message ? error.message : "Not sent: check your connection, then try again.";
      $("status").className = "bad center";
      for (const b of buttons) b.disabled = false;
      return false;
    }
  };

  const actions = Array.isArray(data.actions) ? data.actions : [];
  /* Ce qui décide en premier ; « Allow 1 hour » en lien ; ce qui arrête, franc. */
  const ordered = [...actions.filter((a) => a.choice !== "allow-hour"), ...actions.filter((a) => a.choice === "allow-hour")];
  const buttons = [];
  ordered.forEach((action, index) => {
    const button = document.createElement("button");
    button.textContent = action.label;
    if (action.choice === "allow-hour") button.className = "link";
    else if (index > 0) button.className = /reject|stop/.test(action.choice) ? "stop" : "ghost";
    button.addEventListener("click", async () => {
      if (!(await send(action.choice, buttons))) return;
      $("card").hidden = true;
      $("done").hidden = false;
      if (friendly) {
        $("done-title").textContent = action.choice === "reject" ? "You said no." : "You said yes.";
        $("done-text").textContent = `${data.agent || "Your agent"} has your answer.`;
      } else {
        $("done-title").textContent = `${action.label}: sent`;
        $("done-text").textContent = data.computer ? `${data.computer} has your answer.` : "Your computer has your answer.";
      }
      /* Une décision : « Was this right? », comme dans la notification. */
      if (action.choice !== "right" && action.choice !== "wrong") $("feedback").hidden = false;
    });
    buttons.push(button);
    $("buttons").append(button);
  });

  /* Les boutons dans la notification : un choix de la personne, gardé par ce téléphone. */
  OATH.quick().then((on) => ($("quick").checked = on)).catch(() => undefined);
  $("quick").addEventListener("change", () => void OATH.setQuick($("quick").checked));

  const feedback = [...document.querySelectorAll("#feedback button")];
  for (const button of feedback) {
    button.addEventListener("click", async () => {
      if (!(await send(button.dataset.choice, feedback))) return;
      $("feedback").hidden = true;
      $("done-text").textContent = "Thanks: kept on your computer, for your next feedback.";
    });
  }
})();

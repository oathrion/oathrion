/**
 * Un worker d'identité qui parle le protocole de `sync-postgres-worker.cjs` sans
 * PostgreSQL, et qui se comporte MAL de deux façons, à la demande du SQL reçu :
 *
 *   « spurious »  : notifie le thread principal SANS publier de réponse, puis répond
 *                   pour de vrai 30 ms plus tard — la notification tardive qui
 *                   produisait `JSON.parse("")` et une 500 (STRESS-TEST-LOG §2.2) ;
 *   « slow »      : ne répond qu'après 800 ms, donc après le délai du test (600 ms) : sa
 *                   réponse arrive ORPHELINE ;
 *   « lent-frais » : répond après 400 ms — la réponse orpheline de « slow » arrive donc
 *                   PENDANT que le thread principal attend celle-ci.
 *
 * Toute autre requête reçoit `[{ echo: <sql> }]` immédiatement.
 */
"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const control = new Int32Array(workerData.shared, 0, 4);
const data = new Uint8Array(workerData.shared, 16);

function reply(id, payload) {
  const buffer = Buffer.from(JSON.stringify(payload), "utf8");
  data.set(buffer);
  control[1] = buffer.byteLength;
  Atomics.store(control, 3, 1);
  Atomics.store(control, 2, id);
  Atomics.add(control, 0, 1);
  Atomics.notify(control, 0);
}

parentPort.on("message", (message) => {
  const answer = { ok: true, rows: [{ echo: message.sql }], rowCount: 1 };
  if (message.sql === "spurious") {
    Atomics.notify(control, 0);
    setTimeout(() => reply(message.id, answer), 30);
  } else if (message.sql === "slow") {
    setTimeout(() => reply(message.id, answer), 800);
  } else if (message.sql === "lent-frais") {
    setTimeout(() => reply(message.id, answer), 400);
  } else {
    reply(message.id, answer);
  }
});

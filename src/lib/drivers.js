// Pilotes d'une voiture : liste (2 à 6), ordre de passage, pilote de chaque relais, temps de roulage.
//
// Tout est stocké dans les réglages partagés (app_settings.data.drivers), aucune table à créer :
//   drivers = {
//     [idVoiture]: {
//       list:   [{ id, prenom, nom, absent }]   // l'ordre de la liste = l'ordre de passage
//       relays: { "1": { d: idPilote, ok: true|false } }   // pilote retenu pour le relais n
//       ,best:    { [idPilote]: { s1, s2, s3, lap } }  // meilleurs temps en ms (flux live)
//       ,endLaps: { "1": 28, "2": 50 }               // tour atteint à la fin de chaque relais
//       ,laps:    { [idPilote]: [[n, total, s1, s2, s3], ...] }  // chaque tour terminé (ms), pour l'export
//     }
//   }
// "ok: true" = confirmé par le team manager ; "ok: false" = pilote seulement prévu.
//
// Règle du pilote prévu : c'est le pilote qui suit, dans la liste, celui du relais précédent
// (en sautant les pilotes indisponibles). Un double relais = le team manager choisit le même
// pilote deux fois de suite ; la rotation reprend ensuite à partir de lui.

export const MAX_DRIVERS = 6;
export const MIN_DRIVERS = 2;

export function getCfg(drivers, carId) {
  const c = drivers && drivers[carId];
  return {
    list: c && Array.isArray(c.list) ? c.list : [],
    relays: c && c.relays && typeof c.relays === "object" ? c.relays : {},
    best: c && c.best && typeof c.best === "object" ? c.best : {}, // meilleurs temps par pilote (ms)
    endLaps: c && c.endLaps && typeof c.endLaps === "object" ? c.endLaps : {}, // n° de tour à la fin de chaque relais
    laps: c && c.laps && typeof c.laps === "object" ? c.laps : {}, // tours enregistrés par pilote
  };
}

export function driverName(d) {
  if (!d) return "";
  return [d.prenom, d.nom]
    .map((s) => String(s || "").trim())
    .filter(Boolean)
    .join(" ");
}

function newDriverId() {
  return "d" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
}

// ajoute un pilote vierge (6 maximum)
export function addDriver(cfg) {
  if (cfg.list.length >= MAX_DRIVERS) return cfg;
  return { ...cfg, list: [...cfg.list, { id: newDriverId(), prenom: "", nom: "", absent: false }] };
}

export function updateDriver(cfg, id, patch) {
  return { ...cfg, list: cfg.list.map((d) => (d.id === id ? { ...d, ...patch } : d)) };
}

// dir = -1 (monter) ou +1 (descendre)
export function moveDriver(cfg, id, dir) {
  const i = cfg.list.findIndex((d) => d.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= cfg.list.length) return cfg;
  const list = [...cfg.list];
  [list[i], list[j]] = [list[j], list[i]];
  return { ...cfg, list };
}

// pilote suivant dans l'ordre, après prevId, en sautant les indisponibles
function nextAfter(list, prevId) {
  const avail = list.filter((d) => !d.absent);
  if (avail.length === 0) return null;
  const idx = list.findIndex((d) => d.id === prevId);
  if (idx === -1) return avail[0].id;
  for (let k = 1; k <= list.length; k++) {
    const d = list[(idx + k) % list.length];
    if (!d.absent) return d.id;
  }
  return null;
}

// pilote du relais n : { id, confirmed } (id = null si aucun pilote n'est disponible)
export function resolveRelay(cfg, n) {
  let prev = null;
  let res = { id: null, confirmed: false };
  for (let k = 1; k <= n; k++) {
    const r = cfg.relays[k];
    if (r && r.d && cfg.list.some((d) => d.id === r.d)) {
      res = { id: r.d, confirmed: !!r.ok };
    } else {
      res = { id: nextAfter(cfg.list, prev), confirmed: false };
    }
    prev = res.id;
  }
  return res;
}

// fixe (et confirme) le pilote du relais n
export function setRelayDriver(cfg, n, driverId) {
  return { ...cfg, relays: { ...cfg.relays, [n]: { d: driverId, ok: true } } };
}

// à la fin d'un relais : fige le pilote prévu (non confirmé) pour qu'une modification ultérieure
// de l'ordre ne réécrive pas l'historique
export function freezeRelay(cfg, n) {
  if (cfg.list.length === 0 || cfg.relays[n]) return cfg;
  const r = resolveRelay(cfg, n);
  if (!r.id) return cfg;
  return { ...cfg, relays: { ...cfg.relays, [n]: { d: r.id, ok: false } } };
}

// un pilote ayant déjà roulé (jusqu'au relais upToN) ne peut pas être supprimé : il garde son temps
export function driverHasRelays(cfg, upToN, id) {
  for (let n = 1; n <= upToN; n++) {
    if (resolveRelay(cfg, n).id === id) return true;
  }
  return false;
}

// temps de roulage par pilote. log = relais terminés [{n, durationSec, vertSec, jauneSec}],
// current = relais en cours { n, durationSec, vertSec, jauneSec } ou null.
// -> { [idPilote]: { total, vert, jaune, rouge, relays } } (secondes)
export function driverTotals(cfg, log, current) {
  const t = {};
  cfg.list.forEach((d) => {
    t[d.id] = { total: 0, vert: 0, jaune: 0, rouge: 0, relays: 0, laps: 0 };
  });
  const add = (r) => {
    const id = resolveRelay(cfg, r.n).id;
    if (!id || !t[id]) return;
    t[id].total += Number(r.durationSec) || 0;
    t[id].vert += Number(r.vertSec) || 0;
    t[id].jaune += Number(r.jauneSec) || 0;
    t[id].relays += 1;
    t[id].laps += Number(r.laps) || 0;
  };
  (log || []).forEach(add);
  if (current) add(current);
  Object.values(t).forEach((x) => {
    x.rouge = Math.max(0, x.total - x.vert - x.jaune);
  });
  return t;
}

// remise à zéro de la course : on garde les pilotes et l'ordre, on efface les relais
export function resetDriverRelays(drivers) {
  const out = {};
  Object.keys(drivers || {}).forEach((carId) => {
    out[carId] = { ...drivers[carId], relays: {}, best: {}, endLaps: {}, laps: {} };
  });
  return out;
}

// ---- tours par relais (flux live) ----
// à la fin du relais n, on note le tour atteint ; tours du relais = fin n - fin (n-1)
export function setEndLap(cfg, n, lap) {
  return { ...cfg, endLaps: { ...cfg.endLaps, [n]: lap } };
}
export function endLapOf(cfg, n) {
  if (n <= 0) return 0;
  const v = cfg.endLaps[n];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
// tours du relais n (terminé) ; null si une des deux bornes est inconnue
export function relayLapsFromEnds(cfg, n) {
  const end = endLapOf(cfg, n);
  const prev = endLapOf(cfg, n - 1);
  if (end == null || prev == null || end < prev) return null;
  return end - prev;
}

// ---- meilleurs temps par pilote ----
// seen = dernières valeurs vues pour la voiture ({s1,s2,s3,last}) ; c = voiture du flux.
// -> { seen, obs } où obs contient les valeurs NOUVELLES (apparues depuis le dernier flux).
export function observeLap(seen, c) {
  const prev = seen || { s1: null, s2: null, s3: null, last: null };
  const next = { ...prev };
  const obs = {};
  [
    ["s1", "s1"],
    ["s2", "s2"],
    ["s3", "s3"],
    ["last", "lap"],
  ].forEach(([from, to]) => {
    const v = c[from];
    if (v == null) return;
    if (v !== prev[from]) obs[to] = v;
    next[from] = v;
  });
  return { seen: next, obs };
}

// garde le meilleur : renvoie le même objet s'il n'y a aucune amélioration
export function mergeBest(best, obs) {
  const cur = best || {};
  let out = cur;
  ["s1", "s2", "s3", "lap"].forEach((k) => {
    const v = obs[k];
    if (typeof v !== "number" || !(v > 0)) return;
    if (cur[k] == null || v < cur[k]) {
      if (out === cur) out = { ...cur };
      out[k] = v;
    }
  });
  return out;
}

// ---- tours enregistrés par pilote (S1, S2, S3, total) ----
export const MAX_LAPS_PER_DRIVER = 700;

// ajoute un tour terminé au pilote (n = numéro du tour ; ignoré si déjà noté). Renvoie la même cfg si rien ne change.
export function recordLap(cfg, driverId, lap) {
  if (!driverId || !lap || !(lap.n > 0) || !(lap.total > 0)) return cfg;
  const list = cfg.laps[driverId] || [];
  if (list.some((r) => r[0] === lap.n)) return cfg;
  const row = [lap.n, lap.total, lap.s1 ?? null, lap.s2 ?? null, lap.s3 ?? null, lap.at ?? null, lap.temp ?? null, lap.pic ?? null]; // 6e valeur : heure du passage (ms) ; 7e : température extérieure (°C) ; 8e : position dans la classe (PIC)
  const next = [...list, row].slice(-MAX_LAPS_PER_DRIVER);
  return { ...cfg, laps: { ...cfg.laps, [driverId]: next } };
}

// tours enregistrés répartis selon le relais auquel ils appartiennent : le relais k couvre les tours (fin du relais k-1 ; fin du relais k],
// le relais en cours (curN) tout ce qui suit. Le pilote du relais vient de resolveRelay. Si la fin d'un relais est inconnue,
// le tour reste chez le pilote auquel il a été enregistré. -> { [idPilote]: [ligne brute, ...] } (dans l'ordre des tours)
export function lapsByDriver(cfg, curN) {
  const out = {};
  const seen = new Set();
  const all = [];
  Object.keys(cfg.laps || {}).forEach((id) => (cfg.laps[id] || []).forEach((r) => {
    if (seen.has(r[0])) return;
    seen.add(r[0]);
    all.push({ r, owner: id });
  }));
  all.sort((x, y) => x.r[0] - y.r[0]);
  const ids = [];
  const ends = [];
  for (let k = 1; k <= curN; k++) {
    ids[k] = resolveRelay(cfg, k).id;
    ends[k] = k < curN ? endLapOf(cfg, k) : Infinity;
  }
  all.forEach(({ r, owner }) => {
    let target = ids[curN] || owner;
    for (let k = 1; k < curN; k++) {
      if (ends[k] == null) { target = owner; break; }
      if (r[0] <= ends[k]) { target = ids[k] || owner; break; }
    }
    (out[target] = out[target] || []).push(r);
  });
  return out;
}

// lignes d'un pilote [{ n, total, s1, s2, s3, at }] dans l'ordre des tours (at = heure du passage, absente des anciens tours)
// curN (n° du relais en cours) : les tours sont rattachés au pilote du relais dans lequel ils ont été roulés
export function driverLapRows(cfg, driverId, curN) {
  const rows = curN >= 1 ? lapsByDriver(cfg, curN)[driverId] || [] : cfg.laps[driverId] || [];
  return rows.map((r) => ({ n: r[0], total: r[1], s1: r[2], s2: r[3], s3: r[4], at: r[5] ?? null, temp: r[6] ?? null, pic: r[7] ?? null }));
}

// meilleurs temps (ms) parmi les tours enregistrés : { total, s1, s2, s3 } (null si aucun)
export function lapBests(rows) {
  const out = { total: null, s1: null, s2: null, s3: null };
  rows.forEach((r) => {
    ["total", "s1", "s2", "s3"].forEach((k) => {
      const v = r[k];
      if (typeof v === "number" && v > 0 && (out[k] == null || v < out[k])) out[k] = v;
    });
  });
  return out;
}

const fmtLapMs = (ms) => {
  if (typeof ms !== "number" || !(ms > 0)) return "";
  const m = Math.floor(ms / 60000);
  const s = (ms - m * 60000) / 1000;
  return m > 0 ? `${m}:${s.toFixed(3).padStart(6, "0")}` : s.toFixed(3);
};

// CSV (séparateur « ; », ouvrable dans Excel) de tous les pilotes d'une voiture
export function lapsToCsv(cfg, carNumero, nameOf, curN) {
  const esc = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
  const rows = [["Voiture", "Pilote", "Tour", "Heure", "PIC", "Température (°C)", "S1", "S2", "S3", "Temps du tour", "Meilleur total", "Meilleur S1", "Meilleur S2", "Meilleur S3"]];
  cfg.list.forEach((d) => {
    const lr = driverLapRows(cfg, d.id, curN);
    const b = lapBests(lr);
    lr.forEach((r) => {
      rows.push([
        carNumero,
        nameOf(d),
        r.n,
        r.at ? new Date(r.at).toLocaleTimeString("fr-BE") : "",
        r.pic != null ? r.pic : "",
        r.temp != null ? String(r.temp).replace(".", ",") : "",
        fmtLapMs(r.s1),
        fmtLapMs(r.s2),
        fmtLapMs(r.s3),
        fmtLapMs(r.total),
        r.total === b.total ? "oui" : "",
        r.s1 != null && r.s1 === b.s1 ? "oui" : "",
        r.s2 != null && r.s2 === b.s2 ? "oui" : "",
        r.s3 != null && r.s3 === b.s3 ? "oui" : "",
      ]);
    });
  });
  return "\ufeff" + rows.map((r) => r.map(esc).join(";")).join("\r\n");
}

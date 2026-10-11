// Pilotes d'une voiture : liste (2 à 6), ordre de passage, pilote de chaque relais, temps de roulage.
//
// Tout est stocké dans les réglages partagés (app_settings.data.drivers), aucune table à créer :
//   drivers = {
//     [idVoiture]: {
//       list:   [{ id, prenom, nom, absent }]   // l'ordre de la liste = l'ordre de passage
//       relays: { "1": { d: idPilote, ok: true|false } }   // pilote retenu pour le relais n
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
    t[d.id] = { total: 0, vert: 0, jaune: 0, rouge: 0, relays: 0 };
  });
  const add = (r) => {
    const id = resolveRelay(cfg, r.n).id;
    if (!id || !t[id]) return;
    t[id].total += Number(r.durationSec) || 0;
    t[id].vert += Number(r.vertSec) || 0;
    t[id].jaune += Number(r.jauneSec) || 0;
    t[id].relays += 1;
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
    out[carId] = { ...drivers[carId], relays: {} };
  });
  return out;
}

// Affichage des données live d'une voiture : temps, écarts avec les voitures voisines, horloge course.

// 112137 -> "1:52.137" ; 35631 -> "35.631"
export function fmtMs(ms) {
  if (ms == null || !Number.isFinite(ms)) return "–";
  const total = Math.max(0, Math.round(ms));
  const m = Math.floor(total / 60000);
  const sec = ((total % 60000) / 1000).toFixed(3);
  return m > 0 ? `${m}:${sec.padStart(6, "0")}` : sec;
}

// secteur court : 35631 -> "35.6" ; au-delà d'une minute : 155000 -> "2:35.0"
export function fmtSec1(ms) {
  if (ms == null || !Number.isFinite(ms)) return "–";
  const t = Math.round(Math.max(0, ms) / 100); // dixièmes de seconde
  const m = Math.floor(t / 600);
  const sec = ((t % 600) / 10).toFixed(1);
  return m > 0 ? `${m}:${sec.padStart(4, "0")}` : sec;
}

// écart : 21309 -> "21.3 s", 65200 -> "1:05.2"
export function fmtGapMs(ms) {
  if (ms == null || !Number.isFinite(ms)) return "–";
  const s = Math.abs(ms) / 1000;
  if (s >= 60) {
    const m = Math.floor(s / 60);
    return `${m}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
  }
  return `${s.toFixed(1)} s`;
}

// écart entre ma voiture (me) et une autre : { ms } ou { laps } ou null si inconnu.
// "ahead" : l'autre est devant moi ; sinon derrière.
function gapBetween(me, other, ahead) {
  const lapsDiff = ahead ? (me.gll || 0) - (other.gll || 0) : (other.gll || 0) - (me.gll || 0);
  if (lapsDiff > 0) return { laps: lapsDiff };
  if (me.gl != null && other.gl != null) {
    const ms = ahead ? me.gl - other.gl : other.gl - me.gl;
    return { ms: Math.max(0, ms) };
  }
  return null;
}

// voisins au classement : n voitures devant (de la plus éloignée à la plus proche), moi, n derrière
// cars = { "514": {pos, ...} } ; renvoie null si ma voiture n'a pas de position
export function neighborsOf(cars, num, n = 3) {
  const list = Object.keys(cars || {})
    .map((k) => ({ num: k, ...cars[k] }))
    .filter((c) => c.pos)
    .sort((a, b) => a.pos - b.pos);
  const idx = list.findIndex((c) => c.num === num);
  if (idx < 0) return null;
  const me = list[idx];
  const row = (c, ahead) => ({ ...c, ahead, gap: gapBetween(me, c, ahead) });
  const above = [];
  for (let j = Math.min(n, idx); j >= 1; j--) above.push(row(list[idx - j], true));
  // devant immédiat : si l'écart au leader manque, on utilise l'écart "voiture devant" du flux
  const nearest = above[above.length - 1];
  if (nearest && !nearest.gap && me.ia != null) nearest.gap = { ms: me.ia };
  const below = [];
  for (let j = 1; j <= n && idx + j < list.length; j++) below.push(row(list[idx + j], false));
  return { me, above, below, total: list.length };
}

// horloge de course extrapolée depuis la dernière donnée du flux
export function clockNow(info, nowMs) {
  if (!info || (info.elapsedMs == null && info.remainingMs == null)) return null;
  const running = info.status === "RUNNING";
  const dt = running ? Math.max(0, (nowMs - info.generatedAt) / 1000) : 0;
  return {
    elapsedSec: info.elapsedMs != null ? info.elapsedMs / 1000 + dt : null,
    remainingSec: info.remainingMs != null ? Math.max(0, info.remainingMs / 1000 - dt) : null,
  };
}

// numéros de voiture cités dans un message RC : "N°439 - ...", "N 292 30 SECONDES...", "#12", "N292"
export function carNumbersIn(message) {
  const out = [];
  const re = /(?:^|[^A-Za-z0-9])(?:N\s*[°º]?|#)\s*(\d{1,4})(?!\d)/gi;
  let m;
  while ((m = re.exec(String(message || ""))) !== null) {
    const n = String(Number(m[1]));
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

// messages RC à afficher à ce poste.
//  - sans numéro de voiture : information générale, visible par tous ;
//  - avec numéro(s) : seulement si l'un d'eux fait partie de nos voitures (wanted = ["446", ...]).
// Un message reste affiché maxAgeMs après sa première apparition ; les très anciens sont ignorés.
// seen = { clé: instant de première apparition } (objet conservé par l'appelant).
export function visibleRcMessages(rc, wanted, nowMs, seen, dismissed, generatedAt, maxAgeMs = 180000) {
  const want = new Set(wanted || []);
  const out = [];
  (rc || []).forEach((e) => {
    if (generatedAt && e.at && generatedAt - e.at > 10 * 60000) return; // message ancien
    const key = `${e.id}|${e.message}`;
    if (seen[key] == null) seen[key] = nowMs;
    if (dismissed && dismissed.has(key)) return;
    if (nowMs - seen[key] > maxAgeMs) return;
    const nums = carNumbersIn(e.message);
    if (nums.length > 0 && !nums.some((n) => want.has(n))) return;
    out.push({ key, message: e.message, nums: nums.filter((n) => want.has(n)), at: e.at, seenAt: seen[key] });
  });
  return out;
}

// ---------- Estimation des dépassements (rythme des voitures voisines) ----------
// mémoire des derniers temps au tour de chaque voiture, alimentée à chaque nouvelle donnée du flux
const paceStore = {};

// enregistre le dernier tour de chaque voiture (une seule fois par numéro de tour)
export function updatePace(cars, store = paceStore) {
  for (const num of Object.keys(cars || {})) {
    const c = cars[num];
    if (!c || c.last == null || c.laps == null) continue;
    const e = store[num] || (store[num] = { lastLap: null, times: [] });
    if (e.lastLap === c.laps) continue;
    e.lastLap = c.laps;
    e.times.push(c.last);
    if (e.times.length > 8) e.times.shift();
  }
}

// rythme (ms/tour) = médiane des derniers tours "normaux" (on écarte les tours > 115 % du meilleur : stand, neutralisation)
export function paceOf(num, car, store = paceStore) {
  const times = (store[num] && store[num].times) || [];
  const ref = car && car.best;
  const ok = ref ? times.filter((t) => t <= ref * 1.15) : times;
  if (ok.length >= 2) {
    const s = ok.slice(-5).sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }
  if (car && car.last != null) {
    return ref && car.last > ref * 1.15 ? Math.round(ref * 1.02) : car.last;
  }
  return ref ? Math.round(ref * 1.02) : null;
}

// construit une estimation de contact (null si pas de rapprochement fiable)
function buildDuel(r, gapMs, closing, myPace, remainingMs) {
  if (gapMs == null || closing < 50) return null; // moins de 0,05 s/tour : pas de rapprochement fiable
  const laps = gapMs / closing;
  const etaMs = laps * myPace;
  if (laps > 30) return null;
  if (remainingMs != null && etaMs > remainingMs) return null; // n'arrivera pas avant la fin
  return {
    num: r.num,
    team: r.team,
    pos: r.pos,
    gapMs,
    closingMs: closing,
    laps,
    etaMs,
    level: laps <= 2 ? "high" : laps <= 5 ? "mid" : "low",
  };
}

// Qui peut nous dépasser, et qui pouvons-nous rattraper ?  (version "classement" : repli si le flux n'a pas les heures de passage)
// nb = neighborsOf(...) ; remainingMs = temps de course restant (facultatif)
export function duelEstimates(nb, remainingMs, store = paceStore) {
  if (!nb || !nb.me) return null;
  const myPace = paceOf(nb.me.num, nb.me, store);
  if (!myPace) return { threats: [], chases: [] };
  const threats = [];
  for (const r of nb.below) {
    const p = paceOf(r.num, r, store);
    const t = p && r.gap ? buildDuel(r, r.gap.ms, myPace - p, myPace, remainingMs) : null;
    if (t) threats.push(t);
  }
  const chases = [];
  for (const r of [...nb.above].reverse()) {
    const p = paceOf(r.num, r, store);
    const t = p && r.gap ? buildDuel(r, r.gap.ms, p - myPace, myPace, remainingMs) : null;
    if (t) chases.push(t);
  }
  return { threats, chases };
}

// ---------- Voisins SUR LA PISTE (indépendants du classement) ----------
// Heure (ms, horloge RIS) à laquelle la voiture franchirait la ligne si elle roulait au rythme de référence
// depuis son dernier point de chronométrage connu (ligne, S1 ou S2). Sert à situer chaque voiture sur le tour.
export function linePhase(c, ref) {
  if (!c || c.lapEnd == null) return null;
  let T = c.lapEnd;
  const s1ok = c.s1 != null && ref.s1b != null && c.s1 <= ref.s1b * 1.6; // un S1 énorme = tour de stand : on l'ignore
  if (s1ok) {
    T = c.lapEnd + c.s1;
    const o1 = ref.s1b;
    const s2ok = c.s2 != null && ref.s2b != null && c.s2 <= ref.s2b * 1.6;
    if (s2ok) return c.lapEnd + c.s1 + c.s2 - (o1 + ref.s2b);
    return T - o1;
  }
  return T;
}

const OFF_TRACK = /FUEL|PIT|STOP|OUT|GARAGE|BOX|STAND|ENTR|PARK/i; // voiture au stand (ou qui y entre / en sort) : pas une voiture "de piste"

// médiane des derniers tours de toutes les voitures : sert à repérer un tour de stand (très long par rapport aux autres),
// sans éliminer tout le monde pendant une neutralisation où tous roulent lentement
function medianLast(cars) {
  const v = Object.values(cars || {}).map((c) => c && c.last).filter((x) => x != null && x > 0).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : null;
}

// toutes les voitures proches de nous sur la piste, quel que soit leur classement.
// renvoie [{ num, team, pos, d }] avec d en ms : d > 0 = derrière nous sur la piste, d < 0 = devant nous. null si les heures de passage manquent.
export function onTrackNeighbors(cars, myNum, myPace, windowMs = 90000) {
  const me = cars && cars[myNum];
  if (!me || !myPace) return null;
  const myPhase = linePhase(me, me);
  if (myPhase == null) return null;
  const out = [];
  let seen = 0;
  const med = medianLast(cars);
  for (const num of Object.keys(cars)) {
    if (num === myNum) continue;
    const c = cars[num];
    if (!c || OFF_TRACK.test(c.state || "")) continue;
    if (med && c.last != null && c.last > med * 1.35 && (c.pits || 0) > 0) continue; // tour d'entrée / de sortie des stands : on l'écarte
    const ph = linePhase(c, me);
    if (ph == null) continue;
    seen++;
    let d = (((ph - myPhase) % myPace) + myPace) % myPace; // retard (ms) de l'autre au passage de la ligne
    if (d > myPace / 2) d -= myPace;
    if (Math.abs(d) <= windowMs) out.push({ num, team: c.team, pos: c.pos, d, car: c });
  }
  return seen ? out : null;
}

// Estimation des contacts avec TOUTES les voitures proches sur la piste (devant et derrière), du plus rapide à venir au plus lent.
// renvoie { threats, chases, onTrack: true } ou null si le flux ne contient pas les heures de passage (-> repli classement)
export function duelEstimatesTrack(cars, myNum, remainingMs, store = paceStore, windowMs = 90000) {
  const me = cars && cars[myNum];
  if (!me) return null;
  const myPace = paceOf(myNum, me, store);
  if (!myPace) return null;
  const near = onTrackNeighbors(cars, myNum, myPace, windowMs);
  if (!near) return null;
  const threats = [];
  const chases = [];
  for (const r of near) {
    const p = paceOf(r.num, r.car, store);
    if (!p) continue;
    if (r.d > 0) {
      const t = buildDuel(r, r.d, myPace - p, myPace, remainingMs); // derrière nous et plus rapide
      if (t) threats.push(t);
    } else if (r.d < 0) {
      const t = buildDuel(r, -r.d, p - myPace, myPace, remainingMs); // devant nous et plus lent
      if (t) chases.push(t);
    }
  }
  return { threats, chases, onTrack: true };
}

// ---------- Compte à rebours ----------
// L'heure estimée du contact (etaAt) est recalée chaque fois que l'écart change (franchissement d'un intermédiaire / de la ligne),
// puis le compte à rebours s'écoule seconde par seconde jusqu'à la prochaine mise à jour.
const anchorStore = {};
export function anchorEta(key, sig, etaMs, nowMs, store = anchorStore) {
  const a = store[key];
  if (!a || a.sig !== sig) {
    store[key] = { sig, etaAt: nowMs + etaMs };
  }
  return store[key].etaAt;
}

// 125000 -> "2:05" ; 3725000 -> "1:02:05"
export function fmtCountdown(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

// liste unique, la plus proche en premier : { dir: "threat" | "chase", ..., etaAt, remainingMs }
export function prioritizedDuels(duel, nowMs, store = anchorStore) {
  if (!duel) return [];
  const all = [
    ...duel.threats.map((d) => ({ ...d, dir: "threat" })),
    ...duel.chases.map((d) => ({ ...d, dir: "chase" })),
  ].map((d) => {
    const etaAt = anchorEta(d.dir + d.num, Math.round(d.gapMs) + "|" + Math.round(d.closingMs / 10), d.etaMs, nowMs, store);
    return { ...d, etaAt, remainingMs: Math.max(0, etaAt - nowMs) };
  });
  return all.sort((a, b) => a.remainingMs - b.remainingMs);
}

// ---------- Zones "3 devant / 3 derrière au classement" ----------
// Pour chacune des 3 voitures devant et des 3 derrière nous au général : écart, différence de rythme, compte à rebours.
// renvoie { ahead: [...], behind: [...] } ; chaque ligne : { num, team, pos, gapMs | gapLaps, diffMs, laps, etaAt, remainingMs, kind }
// kind : "closing" (le contact approche) | "away" (l'écart grandit) | "lapped" (un tour ou plus d'écart) | "unknown"
export function classDuels(nb, remainingMs, nowMs, store = paceStore, anchors = anchorStore) {
  if (!nb || !nb.me) return null;
  const myPace = paceOf(nb.me.num, nb.me, store);
  const row = (r, dir) => {
    const base = { num: r.num, team: r.team, pos: r.pos, dir };
    if (!r.gap) return { ...base, kind: "unknown" };
    if (r.gap.laps) return { ...base, kind: "lapped", gapLaps: r.gap.laps };
    const p = paceOf(r.num, r, store);
    if (!myPace || !p || r.gap.ms == null) return { ...base, kind: "unknown", gapMs: r.gap.ms };
    // diffMs > 0 : le contact se rapproche (derrière : l'autre est plus rapide ; devant : nous sommes plus rapides)
    const diffMs = dir === "behind" ? myPace - p : p - myPace;
    if (diffMs < 50) return { ...base, kind: "away", gapMs: r.gap.ms, diffMs };
    const laps = r.gap.ms / diffMs;
    const etaMs = laps * myPace;
    if (laps > 500 || (remainingMs != null && etaMs > remainingMs)) return { ...base, kind: "away", gapMs: r.gap.ms, diffMs, farOff: true };
    const etaAt = anchorEta("z" + dir + r.num, Math.round(r.gap.ms) + "|" + Math.round(diffMs / 10), etaMs, nowMs, anchors);
    return {
      ...base,
      kind: "closing",
      gapMs: r.gap.ms,
      diffMs,
      laps,
      etaAt,
      remainingMs: Math.max(0, etaAt - nowMs),
      level: laps <= 2 ? "high" : laps <= 5 ? "mid" : "low",
    };
  };
  return {
    ahead: [...nb.above].reverse().map((r) => row(r, "ahead")), // la plus proche d'abord
    behind: nb.below.map((r) => row(r, "behind")),
  };
}

// ---------- Règles d'affichage du trafic sur la piste ----------
// prio = prioritizedDuels(...) ; myPos = notre position au général. Renvoie uniquement les lignes à afficher, avec un "kind" :
//   Voitures que nous allons dépasser (estimation = temps avant le dépassement, recalée à chaque split) :
//     "slow"  : plus lente de 20 s/tour ou plus -> orange « SLOW CAR », dans les 20 s
//     "soon"  : plus lente de 5 à 20 s/tour -> jaune, dans les 15 s
//     "calm"  : plus lente de 0 à 5 s/tour -> vert, dans les 10 s
//   Voitures qui vont nous dépasser, dans la minute (affichage normal jusqu'à 30 s, plus petit entre 30 s et 1 min) :
//     "fast"   : au moins 10 s/tour plus rapide -> bande rouge « FAST CAR »
//     "direct" : classée derrière nous au général et moins de 2 s/tour plus rapide -> bande rouge « CONCURRENT DIRECT »
//     "threat" : les autres -> orange, sans mention
export function trackAlertRows(prio, myPos = null) {
  const out = [];
  for (const d of prio || []) {
    let kind = null;
    if (d.dir === "chase") {
      if (d.closingMs >= 20000) kind = d.remainingMs <= 20000 ? "slow" : null;
      else if (d.closingMs >= 5000) kind = d.remainingMs <= 15000 ? "soon" : null;
      else kind = d.remainingMs <= 10000 ? "calm" : null;
    } else if (d.remainingMs <= 60000) {
      if (d.closingMs >= 10000) kind = "fast";
      else if (myPos != null && d.pos != null && d.pos > myPos && d.closingMs < 2000) kind = "direct";
      else kind = "threat";
    }
    if (kind) out.push({ ...d, kind, small: d.dir === "threat" && d.remainingMs > 30000 });
  }
  return out;
}

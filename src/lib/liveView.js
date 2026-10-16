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
export function updatePace(cars, store = paceStore, hist = lapStore, nowMs = Date.now(), outs = outStore) {
  const cls = classPositions(cars); // position dans la classe (PIC) de chaque voiture, notée avec chaque tour
  for (const num of Object.keys(cars || {})) {
    const c = cars[num];
    if (c) {
      // sorties des stands : passage d'un état stand / « OUT » à un état piste (heure du client)
      const st = c.state || "";
      const o = outs[num] || (outs[num] = { off: false, out: false, at: null, seen: false });
      const isOut = /OUT/i.test(st);
      const isOff = OFF_TRACK.test(st);
      if (o.seen && ((isOut && !o.out) || (o.off && !isOff)) && (o.at == null || nowMs - o.at > 120000)) o.at = nowMs;
      // entrée aux stands : on note la durée du relais qui vient de se terminer (sortie précédente -> entrée)
      const inPit = isOff && !isOut;
      if (o.seen && inPit && !o.inPit && o.at != null && nowMs - o.at > 300000) {
        (o.stints || (o.stints = [])).push(nowMs - o.at);
        if (o.stints.length > 5) o.stints.shift();
      }
      o.inPit = inPit;
      o.off = isOff;
      o.out = isOut;
      o.seen = true;
    }
    if (!c || c.last == null || c.laps == null) continue;
    const e = store[num] || (store[num] = { lastLap: null, times: [] });
    if (e.lastLap === c.laps) continue;
    e.lastLap = c.laps;
    e.times.push(c.last);
    if (e.times.length > 8) e.times.shift();
    // historique des derniers tours avec leurs secteurs (pour les heures de passage aux intermédiaires)
    if (c.lapEnd != null) {
      const h = hist[num] || (hist[num] = []);
      const sOk = c.s1 != null && c.s2 != null && c.s3 != null && Math.abs(c.s1 + c.s2 + c.s3 - c.last) <= 0.03 * c.last;
      h.push({ end: c.lapEnd, lt: c.last, s: sOk ? [c.s1, c.s2, c.s3] : null, d: c.driver || null, n: c.laps, tp: liveTemp, pc: (cls[num] || {}).pic ?? null });
      if (h.length > 500) h.shift();
    }
  }
}
// derniers tours terminés de chaque voiture : { end (heure du passage de la ligne), lt (temps du tour), s ([S1,S2,S3] ou null) }
const lapStore = {};
// température extérieure du moment (°C), fournie par l'application : notée avec chaque tour vu
let liveTemp = null;
export function setLiveTemperature(t, nowMs = Date.now()) {
  const prev = liveTemp;
  liveTemp = typeof t === "number" && Number.isFinite(t) ? Math.round(t * 10) / 10 : null;
  // première température reçue (ouverture de la page, circuit choisi à l'instant) : les tours des 15 dernières minutes vus sans température la reçoivent
  if (liveTemp != null && prev == null) {
    Object.keys(lapStore).forEach((n) => lapStore[n].forEach((h) => { if (h.tp == null && h.end >= nowMs - 15 * 60000) h.tp = liveTemp; }));
  }
}
export function getLiveTemperature() {
  return liveTemp;
}
const outStore = {}; // { num: { off, out, at (heure de la dernière sortie des stands), seen } }

// temps moyen sur les 10 derniers tours, en écartant les tours plus de 5 % plus lents que la médiane (stand, neutralisation, incident) : { ms, n } ou null
// la médiane résiste aux tours lents : 2 tours propres suffisent pour afficher un rythme
export function lapAverage(num, hist = lapStore) {
  const laps = (hist[num] || []).slice(-10).map((h) => h.lt).filter((v) => v > 0);
  if (laps.length < 2) return null;
  const s = [...laps].sort((x, y) => x - y);
  const med = s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  const kept = laps.filter((v) => v <= 1.05 * med);
  if (kept.length < 2) return null;
  return { ms: kept.reduce((x, y) => x + y, 0) / kept.length, n: kept.length };
}

// voitures apparues en « out » des stands depuis sinceMs (la plus récente d'abord) : [{ num, team, pos, cat, pic, at, avgMs }]
export function pitOutCars(cars, myNum, sinceMs, outs = outStore, hist = lapStore) {
  const cls = classPositions(cars);
  const res = [];
  for (const num of Object.keys(outs)) {
    const o = outs[num];
    const c = cars && cars[num];
    if (num === myNum || !c || o.at == null || o.at < sinceMs) continue;
    if (OFF_TRACK.test(c.state || "") && !/OUT/i.test(c.state || "")) continue; // revenue aux stands entre-temps
    const a = lapAverage(num, hist);
    res.push({ num, team: c.team, pos: c.pos, cat: (cls[num] || {}).cat || "", pic: (cls[num] || {}).pic ?? null, at: o.at, avgMs: a ? a.ms : null });
  }
  return res.sort((x, y) => y.at - x.at);
}

// sortie des stands d'une voiture et estimation de son prochain retour aux stands :
// { at (heure de la dernière sortie vue), inPit, stintMs (durée de relais estimée), basis ("car" = ses propres relais vus, "field" = médiane des autres voitures, null), estIn (heure de retour estimée) }
export function pitExitInfo(num, outs = outStore) {
  const o = outs[num];
  if (!o || o.at == null) return null;
  let stintMs = null;
  let basis = null;
  if (o.stints && o.stints.length) {
    stintMs = o.stints.reduce((s, v) => s + v, 0) / o.stints.length;
    basis = "car";
  } else {
    const all = [];
    Object.keys(outs).forEach((k) => (outs[k].stints || []).forEach((v) => all.push(v)));
    if (all.length >= 3) {
      all.sort((x, y) => x - y);
      stintMs = all[Math.floor(all.length / 2)];
      basis = "field";
    }
  }
  return { at: o.at, inPit: !!o.inPit, stintMs, basis, estIn: stintMs != null && !o.inPit ? o.at + stintMs : null };
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

const OFF_TRACK = /FUEL|PIT|STOP|OUT|GARAGE|BOX|STAND|ENTR|PARK|(^|[^A-Za-z])IN([^A-Za-z]|$)/i; // voiture au stand (ou qui y entre / en sort) : pas une voiture "de piste"

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

// Position estimée de chaque voiture SUR LA PISTE à l'instant nowMs (en tours, partie fractionnaire = avancement dans le tour).
// On repart du dernier passage de la ligne (lap_end, exact) et on fait avancer la voiture avec les temps d'intermédiaires de son tour en cours
// (ou, à défaut, avec son rythme habituel), en répartissant le tour comme le fait notre meilleur tour (S1 / S2 / S3).
// Contrairement à linePhase (photo figée à chaque intermédiaire), cette position continue d'avancer seconde après seconde,
// ce qui permet de voir une voiture se rapprocher entre deux intermédiaires.
export function trackProgress(num, c, ref, nowMs, store = paceStore) {
  if (!c || c.lapEnd == null || c.laps == null || !ref || ref.s1b == null || ref.s2b == null || ref.s3b == null) return null;
  const tot = ref.s1b + ref.s2b + ref.s3b;
  const pace = paceOf(num, c, store) || tot;
  const k = pace / tot; // échelle de cette voiture par rapport à notre meilleur tour
  const e = Math.max(0, nowMs - c.lapEnd);
  if (e > pace * 1.4) return null; // plus de nouvelle donnée depuis très longtemps : voiture probablement arrêtée / aux stands
  const ok = (v, b) => v != null && v >= 0.6 * b * k && v <= 1.6 * b * k;
  const a1 = ok(c.s1, ref.s1b) ? c.s1 : ref.s1b * k;
  const a2 = ok(c.s2, ref.s2b) ? c.s2 : ref.s2b * k;
  const a3 = ok(c.s3, ref.s3b) ? c.s3 : ref.s3b * k;
  const F1 = ref.s1b / tot;
  const F2 = (ref.s1b + ref.s2b) / tot;
  let fr;
  if (e < a1) fr = (e / a1) * F1;
  else if (e < a1 + a2) fr = F1 + ((e - a1) / a2) * (F2 - F1);
  else fr = F2 + Math.min(1, (e - a1 - a2) / a3) * (1 - F2);
  return c.laps + fr;
}

// mémoire de l'écart (ms) avec chaque voiture proche, pour mesurer à quelle vitesse il se réduit réellement
const gapStore = {};
function observedClosingRate(num, nowMs, d, store = gapStore) {
  const h = store[num] || (store[num] = []);
  if (h.length && Math.sign(h[h.length - 1].d) !== Math.sign(d)) h.length = 0; // dépassement : on repart de zéro
  if (!h.length || nowMs - h[h.length - 1].t >= 2500) h.push({ t: nowMs, d });
  while (h.length && nowMs - h[0].t > 150000) h.shift();
  if (h.length < 4 || h[h.length - 1].t - h[0].t < 25000) return null;
  const n = h.length;
  let st = 0, sd = 0, stt = 0, std = 0;
  for (const p of h) {
    st += p.t - h[0].t;
    sd += p.d;
    stt += (p.t - h[0].t) * (p.t - h[0].t);
    std += (p.t - h[0].t) * p.d;
  }
  const den = n * stt - st * st;
  if (Math.abs(den) < 1e-6) return null;
  const slope = (n * std - st * sd) / den; // variation de d (ms) par ms
  return -Math.sign(d) * slope; // > 0 : l'écart diminue
}

// Estimation des contacts avec TOUTES les voitures proches sur la piste, positions continues (nowMs requis).
function duelEstimatesTrackLive(cars, myNum, remainingMs, store, windowMs, nowMs) {
  const me = cars && cars[myNum];
  if (!me) return null;
  const myPace = paceOf(myNum, me, store);
  if (!myPace) return null;
  if (OFF_TRACK.test(me.state || "")) return { threats: [], chases: [], onTrack: true }; // nous sommes aux stands
  const myProg = trackProgress(myNum, me, me, nowMs, store);
  if (myProg == null) return null;
  const threats = [];
  const chases = [];
  let seen = 0;
  for (const num of Object.keys(cars)) {
    if (num === myNum) continue;
    const c = cars[num];
    if (!c || OFF_TRACK.test(c.state || "")) continue;
    const p = paceOf(num, c, store);
    if (!p) continue;
    if (c.last != null && c.last > p * 1.6) continue; // vient de rouler un tour extrêmement lent (arrêt prolongé, incident) : position peu fiable
    const pr = trackProgress(num, c, me, nowMs, store);
    if (pr == null) continue;
    seen++;
    let dd = pr - myProg;
    dd -= Math.round(dd);
    const d = -dd * myPace; // > 0 : derrière nous sur la piste ; < 0 : devant nous
    if (Math.abs(d) > windowMs) {
      delete gapStore[num];
      continue;
    }
    const gap = Math.abs(d);
    const ratePace = (d > 0 ? myPace - p : p - myPace) / myPace;
    const rateObs = observedClosingRate(num, nowMs, d);
    // on croit le rythme moyen, sauf si l'écart mesuré se réduit nettement moins vite que prévu
    const rate = rateObs != null ? (rateObs < 0.5 * ratePace ? rateObs : ratePace) : ratePace;
    const row = { num, team: c.team, pos: c.pos };
    const t = buildDuel(row, gap, rate * myPace, myPace, remainingMs);
    if (!t) continue;
    if (d > 0) threats.push(t);
    else chases.push(t);
  }
  return seen ? { threats, chases, onTrack: true } : null;
}

// ---------- Méthode "gap au dernier point commun" ----------
// Chaque voiture franchit des points de chronométrage (S1, S2, ligne) dont le flux donne l'heure exacte. Pour une autre voiture X :
//  1. on prend le dernier point que nous ET X avons franchi : l'écart exact = heure de X - notre heure à ce même point ;
//  2. on avance point par point avec le temps de secteur habituel de chacune (médiane de ses derniers tours) ;
//  3. le premier point où l'ordre s'inverse donne le dépassement, et l'heure estimée (interpolée) donne le compte à rebours.
// Seules les heures du flux sont utilisées pour l'écart : pas de position estimée en continu, pas de dérive entre deux points.
const med5 = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s[s.length >> 1];
};

// temps de secteur attendus [S1,S2,S3] : médiane des 3 derniers tours normaux ; à défaut, le rythme de la voiture réparti comme notre meilleur tour
function expectedSectors(num, c, ref, store, hist) {
  const pace = paceOf(num, c, store);
  if (!pace) return null;
  const hs = (hist[num] || []).filter((h) => h.s && h.lt <= pace * 1.1).slice(-3);
  if (hs.length >= 2) return [0, 1, 2].map((k) => med5(hs.map((h) => h.s[k])));
  if (!ref || ref.s1b == null || ref.s2b == null || ref.s3b == null) return null;
  const tot = ref.s1b + ref.s2b + ref.s3b;
  return [ref.s1b, ref.s2b, ref.s3b].map((b) => (b * pace) / tot);
}

// points de chronométrage connus de la voiture jusqu'à l'instant T : [{ t, k (0=S1, 1=S2, 2=ligne), bad }]
function pointTimeline(num, c, T, exp, hist) {
  const pts = [];
  const lap = exp[0] + exp[1] + exp[2];
  const hs = (hist[num] || []).slice(-4);
  let lastEnd = null;
  for (const h of hs) {
    if (lastEnd != null && h.end <= lastEnd) continue;
    const s = h.s || exp.map((v) => (v * h.lt) / lap);
    const st = h.end - h.lt;
    const bad = h.lt > lap * 1.25 || h.lt < lap * 0.6;
    pts.push({ t: st + s[0], k: 0, bad }, { t: Math.min(h.end, st + s[0] + s[1]), k: 1, bad }, { t: h.end, k: 2, bad });
    lastEnd = h.end;
  }
  if (c.lapEnd == null) return pts;
  if (lastEnd == null || c.lapEnd > lastEnd) pts.push({ t: c.lapEnd, k: 2, bad: false }); // dernier passage de la ligne
  const e = T - c.lapEnd;
  const off = OFF_TRACK.test(c.state || "") || e > lap * 1.5;
  const plaus = (v, b) => v != null && v >= 0.6 * b && v <= 1.6 * b;
  const a1 = plaus(c.s1, exp[0]) ? c.s1 : exp[0];
  const a2 = plaus(c.s2, exp[1]) ? c.s2 : exp[1];
  if (e >= a1) pts.push({ t: c.lapEnd + a1, k: 0, bad: off });
  if (e >= a1 + a2) pts.push({ t: c.lapEnd + a1 + a2, k: 1, bad: off });
  return pts.filter((p) => p.t <= T);
}

// la voiture devrait déjà avoir franchi son prochain point (avec une marge) : sa position n'est plus fiable
function isOverdue(lastPt, sec, nowMs) {
  const next = sec[(lastPt.k + 1) % 3];
  return nowMs > lastPt.t + next + Math.max(5000, 0.1 * next);
}

function nearestSame(pts, k, t, maxDiff) {
  let best = -1;
  let bd = maxDiff;
  for (let i = 0; i < pts.length; i++) {
    if (pts[i].k !== k) continue;
    const d = Math.abs(pts[i].t - t);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

// dernier point de chronométrage franchi à la fois par nous (myPts, dernier index a) et par X : { ai, bi } ou null
function lastCommonPoint(myPts, a, xPts, myLap, allowBad = false) {
  for (let j = 0; j < 3 && a - j >= 0; j++) {
    const q = myPts[a - j];
    const xi = nearestSame(xPts, q.k, q.t, 0.45 * myLap);
    if (xi >= 0 && (allowBad || (!q.bad && !xPts[xi].bad))) return { ai: a - j, bi: xi };
  }
  return null;
}

// position dans la classe (PIC) de chaque voiture, calculée depuis le classement général : { num: { cat, pic } }
export function classPositions(cars) {
  const by = {};
  for (const n of Object.keys(cars || {})) {
    const c = cars[n];
    if (!c || !c.pos) continue;
    (by[c.cat || ""] = by[c.cat || ""] || []).push(n);
  }
  const out = {};
  for (const k of Object.keys(by)) by[k].sort((a, b) => cars[a].pos - cars[b].pos).forEach((n, i) => (out[n] = { cat: k, pic: i + 1 }));
  return out;
}

// Les voitures autour de nous SUR LA PISTE, avec l'écart mesuré au dernier point commun (S1, S2 ou ligne).
// renvoie { ahead: [...], behind: [...], me: { cat, pic }, ref: { point, at } (notre dernier point de chronométrage et son heure) } : ahead = jusqu'à nAhead voitures devant (la plus éloignée d'abord), behind = jusqu'à nBehind derrière (la plus proche d'abord).
// ligne : { num, team, pos, cat (classe), pic (position dans la classe), gapMs (> 0 : derrière nous), point ("S1" | "S2" | "Ligne"), trendMs (variation de |écart| depuis le point précédent : < 0 = se rapproche, null si inconnu) }
export function aroundOnTrack(cars, myNum, nowMs, store = paceStore, hist = lapStore, nAhead = 25, nBehind = 15, mode = "piste") {
  const me = cars && cars[myNum];
  if (!me || me.lapEnd == null || OFF_TRACK.test(me.state || "")) return null;
  const mySec = expectedSectors(myNum, me, me, store, hist);
  if (!mySec) return null;
  const myLap = mySec[0] + mySec[1] + mySec[2];
  const myPts = pointTimeline(myNum, me, nowMs, mySec, hist);
  const a = myPts.length - 1;
  if (a < 1) return null; // les écarts déjà mesurés restent exacts même si nous sommes un peu en retard sur notre prochain point
  const cls = classPositions(cars);
  const myAvg = lapAverage(myNum, hist);
  const byClass = mode === "general" || mode === "pic"; // voisins du classement (général ou dans la classe) au lieu des voisins sur la piste
  const rows = [];
  for (const num of Object.keys(cars)) {
    if (num === myNum) continue;
    const c = cars[num];
    if (!c) continue;
    const base = { num, team: c.team, pos: c.pos, cat: (cls[num] || {}).cat || "", pic: (cls[num] || {}).pic ?? null, lapsDiff: c.laps != null && me.laps != null ? c.laps - me.laps : null, gapMs: null, point: null, trendMs: null, gainMs: null, lapGainMs: null, avgMs: null, deltaMs: null, pit: false };
    const xAvg = lapAverage(num, hist);
    base.avgMs = xAvg ? xAvg.ms : null;
    base.deltaMs = xAvg && myAvg ? xAvg.ms - myAvg.ms : null;
    const noMeas = (pit) => {
      if (byClass && c.pos != null) rows.push({ ...base, pit });
    };
    if (c.lapEnd == null || OFF_TRACK.test(c.state || "")) { noMeas(true); continue; }
    const xSec = expectedSectors(num, c, me, store, hist);
    if (!xSec) { noMeas(false); continue; }
    const xPts = pointTimeline(num, c, nowMs, xSec, hist);
    const b = xPts.length - 1;
    if (b < 0) { noMeas(false); continue; }
    // tableau d'affichage : l'écart déjà mesuré reste exact même si la voiture est en retard (drapeau jaune, neutralisation) ; on n'écarte que les voitures sans nouvelles depuis 4 tours
    if (nowMs - xPts[b].t > 4 * (xSec[0] + xSec[1] + xSec[2])) { noMeas(false); continue; }
    const cp = lastCommonPoint(myPts, a, xPts, myLap, true); // l'écart mesuré entre deux heures de passage reste exact même sur un tour de stand
    if (!cp) { noMeas(false); continue; }
    const g0 = xPts[cp.bi].t - myPts[cp.ai].t;
    if (g0 === 0 && !byClass) continue;
    let trendMs = null;
    for (let j = cp.ai - 1; j >= 0 && j >= cp.ai - 2; j--) {
      const xi = nearestSame(xPts, myPts[j].k, myPts[j].t, 0.45 * myLap);
      if (xi < 0 || myPts[j].bad || xPts[xi].bad) continue;
      const gp = xPts[xi].t - myPts[j].t;
      if (Math.sign(gp) === Math.sign(g0)) trendMs = Math.abs(g0) - Math.abs(gp);
      break;
    }
    // gain / perte sur le dernier tronçon (entre le point précédent et le dernier point commun) : > 0 = nous avons été plus rapides que cette voiture
    let gainMs = null;
    if (cp.ai >= 1 && cp.bi >= 1) {
      const pj = myPts[cp.ai - 1];
      const xi = nearestSame(xPts, pj.k, pj.t, 0.45 * myLap);
      if (xi === cp.bi - 1 && !pj.bad && !myPts[cp.ai].bad && !xPts[xi].bad && !xPts[cp.bi].bad) {
        gainMs = g0 - (xPts[xi].t - pj.t);
        if (Math.abs(gainMs) > 20000) gainMs = null; // tronçons non comparables (tours différents) : pas d'affichage
      }
    }
    // cumul S1 + S2 + S3 en direct : gain / perte depuis le dernier passage de la ligne commun (tour complet une fois la ligne franchie)
    let lapGainMs = null;
    {
      const k = myPts[cp.ai].k;
      const r = k === 2 ? cp.ai - 3 : k === 1 ? cp.ai - 2 : cp.ai - 1; // point « ligne » qui sert de départ
      if (r >= 0 && myPts[r].k === 2 && !myPts[r].bad && !myPts[cp.ai].bad && !xPts[cp.bi].bad) {
        const xr = nearestSame(xPts, 2, myPts[r].t, 0.45 * myLap);
        if (xr >= 0 && !xPts[xr].bad) {
          const v = g0 - (xPts[xr].t - myPts[r].t);
          if (Math.abs(v) <= 40000) lapGainMs = v; // au-delà : tours non comparables
        }
      }
    }
    rows.push({ ...base, gapMs: g0, point: ["S1", "S2", "Ligne"][myPts[cp.ai].k], trendMs, gainMs, lapGainMs });
  }
  let ahead, behind;
  if (byClass) {
    const key = mode === "pic" ? "pic" : "pos";
    const myKey = mode === "pic" ? (cls[myNum] || {}).pic : me.pos;
    const myCat = (cls[myNum] || {}).cat;
    const pool = rows.filter((r) => r[key] != null && (mode !== "pic" || r.cat === myCat));
    ahead = pool.filter((r) => r[key] < myKey).sort((x, y) => y[key] - x[key]).slice(0, nAhead).reverse();
    behind = pool.filter((r) => r[key] > myKey).sort((x, y) => x[key] - y[key]).slice(0, nBehind);
  } else {
    ahead = rows.filter((r) => r.gapMs < 0).sort((x, y) => Math.abs(x.gapMs) - Math.abs(y.gapMs)).slice(0, nAhead).reverse();
    behind = rows.filter((r) => r.gapMs > 0).sort((x, y) => x.gapMs - y.gapMs).slice(0, nBehind);
  }
  if (!ahead.length && !behind.length) return null; // rien de mesurable (voiture à l'arrêt, flux interrompu) : l'écran garde le dernier tableau valide
  return { ahead, behind, mode, me: cls[myNum] || null, myAvg, ref: { point: ["S1", "S2", "Ligne"][myPts[a].k], at: myPts[a].t } };
}

function duelEstimatesPoints(cars, myNum, remainingMs, store, nowMs, hist = lapStore) {
  const me = cars && cars[myNum];
  if (!me || me.lapEnd == null) return null;
  if (OFF_TRACK.test(me.state || "")) return { threats: [], chases: [], onTrack: true }; // nous sommes aux stands
  const mySec = expectedSectors(myNum, me, me, store, hist);
  if (!mySec) return null;
  const myLap = mySec[0] + mySec[1] + mySec[2];
  const myPts = pointTimeline(myNum, me, nowMs, mySec, hist);
  const a = myPts.length - 1;
  if (a < 1 || myPts[a].bad) return { threats: [], chases: [], onTrack: true };
  if (isOverdue(myPts[a], mySec, nowMs)) return { threats: [], chases: [], onTrack: true }; // nous sommes en retard sur notre prochain point (entrée aux stands, ralentissement) : tout serait faux
  const threats = [];
  const chases = [];
  const H = 7; // on regarde jusqu'à 7 points (≈ 2 tours) en avant
  for (const num of Object.keys(cars)) {
    if (num === myNum) continue;
    const c = cars[num];
    if (!c || c.lapEnd == null || OFF_TRACK.test(c.state || "")) continue;
    const xSec = expectedSectors(num, c, me, store, hist);
    if (!xSec) continue;
    const xPts = pointTimeline(num, c, nowMs, xSec, hist);
    const b = xPts.length - 1;
    if (b < 0 || xPts[b].bad) continue;
    if (nowMs - xPts[b].t > 1.5 * (xSec[0] + xSec[1] + xSec[2])) continue; // plus de nouvelle donnée : voiture arrêtée
    if (isOverdue(xPts[b], xSec, nowMs)) continue; // en retard sur son prochain point : probablement ralentie ou aux stands
    // dernier point commun (en partant de notre point le plus récent)
    const cp = lastCommonPoint(myPts, a, xPts, myLap);
    if (!cp) continue;
    const { ai, bi } = cp;
    const g0 = xPts[bi].t - myPts[ai].t; // > 0 : X est derrière nous
    if (g0 === 0 || Math.abs(g0) > 120000) continue;
    const sg = Math.sign(g0);
    let tm = myPts[ai].t;
    let tx = xPts[bi].t;
    let gPrev = g0;
    let tmPrev = tm;
    let etaAt = null;
    for (let s = 1; s <= H; s++) {
      const km = (myPts[ai].k + s) % 3;
      const ntm = ai + s <= a ? myPts[ai + s].t : Math.max(nowMs + 500, tm + mySec[km]);
      const ntx = bi + s <= b ? xPts[bi + s].t : Math.max(nowMs + 500, tx + xSec[km]);
      const g = ntx - ntm;
      if (Math.sign(g) !== sg) {
        const f = Math.abs(gPrev) / (Math.abs(gPrev) + Math.abs(g));
        etaAt = tmPrev + f * (ntm - tmPrev);
        break;
      }
      gPrev = g;
      tm = ntm;
      tx = ntx;
      tmPrev = ntm;
    }
    if (etaAt == null) continue;
    const etaMs = etaAt - nowMs;
    if (etaMs < 0 || etaMs > 300000) continue;
    if (remainingMs != null && etaMs > remainingMs) continue;
    const xLap = xSec[0] + xSec[1] + xSec[2];
    const threat = sg > 0;
    const t = { exact: true, num, team: c.team, pos: c.pos, gapMs: Math.abs(g0), closingMs: threat ? myLap - xLap : xLap - myLap, laps: etaMs / myLap, etaMs };
    t.level = t.laps <= 2 ? "high" : t.laps <= 5 ? "mid" : "low";
    (threat ? threats : chases).push(t);
  }
  return { threats, chases, onTrack: true };
}

// Estimation des contacts avec TOUTES les voitures proches sur la piste (devant et derrière), du plus rapide à venir au plus lent.
// renvoie { threats, chases, onTrack: true } ou null si le flux ne contient pas les heures de passage (-> repli classement)
export function duelEstimatesTrack(cars, myNum, remainingMs, store = paceStore, windowMs = 90000, nowMs = null, hist = lapStore) {
  if (nowMs != null) return duelEstimatesPoints(cars, myNum, remainingMs, store, nowMs, hist) || duelEstimatesTrackLive(cars, myNum, remainingMs, store, windowMs, nowMs);
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

// Voitures dont l'ordre SUR LA PISTE contredit le classement officiel (mis à jour seulement à la ligne) :
//   "passedUs"   : classée derrière nous, mais déjà devant nous sur la piste (elle nous a dépassés depuis la ligne)
//   "passedByUs" : classée devant nous, mais déjà derrière nous sur la piste (nous l'avons dépassée depuis la ligne)
// Seules les voitures du même tour que nous (écart de piste < 1/2 tour) sont concernées : une voiture à un tour n'est pas un dépassement.
export function trackSwaps(cars, myNum, myPos, nowMs, store = paceStore, windowMs = 60000) {
  const out = {};
  const me = cars && cars[myNum];
  if (!me || myPos == null || nowMs == null) return out;
  const myPace = paceOf(myNum, me, store);
  if (!myPace || OFF_TRACK.test(me.state || "")) return out;
  const myProg = trackProgress(myNum, me, me, nowMs, store);
  if (myProg == null) return out;
  for (const num of Object.keys(cars)) {
    if (num === myNum) continue;
    const c = cars[num];
    if (!c || c.pos == null || OFF_TRACK.test(c.state || "")) continue;
    const pr = trackProgress(num, c, me, nowMs, store);
    if (pr == null) continue;
    const raw = pr - myProg; // > 0 : devant nous sur la piste
    if (Math.abs(raw) >= 0.5 || Math.abs(raw) * myPace > windowMs) continue;
    if (raw > 0 && c.pos > myPos) out[num] = "passedUs";
    else if (raw < 0 && c.pos < myPos) out[num] = "passedByUs";
  }
  return out;
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
    // moteur par points : l'heure est déjà calculée depuis les heures du flux (pas d'ancrage) ; sinon on la fige jusqu'au prochain recalage
    const etaAt = d.exact ? nowMs + d.etaMs : anchorEta(d.dir + d.num, Math.round(d.gapMs) + "|" + Math.round(d.closingMs / 10), d.etaMs, nowMs, store);
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

// Full course yellow / safety car annoncé par la direction de course : true = en cours, false = terminé, null = inconnu.
// Le message le plus récent décide ; un début vieux de plus de maxAgeMs sans message de fin est ignoré (le drapeau du flux reprend la main).
export function fcyFromRc(rc, refMs, maxAgeMs = 30 * 60000) {
  let state = null;
  let at = -1;
  (rc || []).forEach((e) => {
    const msg = String((e && e.message) || "");
    if (carNumbersIn(msg).length > 0) return; // message visant une voiture précise : pas une neutralisation générale
    let s = null;
    if (/(END|ENDING|TERMIN|GREEN|RESUM)/i.test(msg) && /(FULL\s*COURSE|GREEN\s*FLAG|SAFETY\s*CAR|CODE\s*60)/i.test(msg)) s = false;
    else if (/GREEN\s*FLAG/i.test(msg)) s = false;
    else if (/FULL\s*COURSE\s*YELLOW|\bFCY\b|SAFETY\s*CAR|CODE\s*60/i.test(msg)) s = true;
    if (s == null) return;
    const t = (e && e.at) || 0;
    if (t >= at) {
      at = t;
      state = s;
    }
  });
  if (state === true && refMs && at > 0 && refMs - at > maxAgeMs) return null;
  return state;
}

// derniers tours enregistrés d'une voiture (depuis l'ouverture de la page, 500 maximum), du plus récent au plus ancien : [{ end (heure de passage), lt (temps du tour), s ([S1,S2,S3] ou null) }]
export function carLaps(num, hist = lapStore) {
  return [...(hist[num] || [])].reverse();
}

// ---------- mémoire de l'écran conservée dans le navigateur (survit au F5) ----------
// rythmes, tours vus et sorties des stands de cet écran : sans cela, un F5 repart de zéro (rythme, chrono depuis la sortie, tours vus)
const MEM_MAX_AGE_MS = 36 * 3600 * 1000;
export function saveLiveMemory(key, fullNums = [], maxFull = 300, maxOther = 30) {
  try {
    const laps = {};
    Object.keys(lapStore).forEach((n) => {
      laps[n] = lapStore[n].slice(-(fullNums.includes(n) ? maxFull : maxOther));
    });
    localStorage.setItem(key, JSON.stringify({ t: Date.now(), pace: paceStore, laps, outs: outStore }));
  } catch {
    /* stockage indisponible ou plein */
  }
}
export function loadLiveMemory(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return false;
    const m = JSON.parse(raw);
    if (!m || !(Date.now() - m.t < MEM_MAX_AGE_MS)) return false;
    Object.keys(m.laps || {}).forEach((n) => {
      if (!lapStore[n] || lapStore[n].length < m.laps[n].length) lapStore[n] = m.laps[n];
    });
    Object.keys(m.pace || {}).forEach((n) => {
      if (!paceStore[n] || (paceStore[n].times || []).length < (m.pace[n].times || []).length) paceStore[n] = m.pace[n];
    });
    Object.keys(m.outs || {}).forEach((n) => {
      const o = m.outs[n];
      const c = outStore[n];
      if (!c || (o.at != null && (c.at == null || o.at > c.at)) || ((o.stints || []).length > ((c.stints || []).length))) outStore[n] = { ...o, ...(c && c.seen ? { off: c.off, out: c.out, inPit: c.inPit, seen: true } : {}) };
    });
    return true;
  } catch {
    return false;
  }
}

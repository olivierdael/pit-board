// SIMULATEUR DE COURSE POUR PITBOARD — rejoue la course 24 Heures 2CV / C1 de Spa 2025 (115 voitures)
// en écrivant, comme le ferait le poste Admin, le flux dans la table Supabase "live_timing".
// L'application n'est pas modifiée : elle croit recevoir le vrai chronométrage RIS.
//
// Utilisation (voir LISEZMOI_SIMULATEUR.md) :
//   node simulateur/simulateur.mjs --voitures 260,53,40,331,499,415 --depart 3h
//   node simulateur/simulateur.mjs --arret        (efface le flux simulé)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// ---------- arguments ----------
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) {
    const k = a.slice(2);
    const v = process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[++i] : "1";
    args[k] = v;
  }
}
function parseDuration(s, def) {
  if (s == null) return def;
  const m = String(s).trim().match(/^(\d+(?:[.,]\d+)?)\s*(h|m|min|s)?$/i);
  if (!m) return def;
  const n = Number(m[1].replace(",", "."));
  const u = (m[2] || "h").toLowerCase();
  return Math.round(n * (u === "h" ? 3600000 : u === "s" ? 1000 : 60000));
}
const SPEED = Math.max(0.1, Number(args.vitesse || 1));
const START_MS = parseDuration(args.depart, 0);
const UUID = args.uuid || "00000000-0000-4000-8000-000000000001"; // à recopier dans la configuration de PitBoard
const MINE = (args.voitures || "").split(",").map((s) => s.trim().replace(/^#/, "")).filter(Boolean);
const TICK_MS = 3000;

// ---------- connexion Supabase (même fichier .env que l'application) ----------
function readEnv() {
  const files = [path.join(process.cwd(), ".env"), path.join(here, "..", ".env"), path.join(here, ".env")];
  const env = {};
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
    break;
  }
  return env;
}
const env = readEnv();
// on cherche les valeurs par leur forme (adresse https://….supabase.co / clé sb_… ou eyJ…), quel que soit le nom de la variable
const vals = [...Object.values(env), process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY, args.url, args.cle].filter(Boolean);
let SB_URL = (args.url || vals.find((v) => /^https?:\/\/[^\s]+/i.test(v)) || "").replace(/\/(rest|auth)\/v1.*$/, "").replace(/\/$/, "");
let SB_KEY = args.cle || vals.find((v) => /^(sb_|eyJ)/.test(v)) || "";
if (!/^https?:\/\//i.test(SB_URL)) SB_URL = "";
const DRY = !!args.essai; // --essai : n'écrit rien, affiche seulement

async function writeRow(data) {
  if (DRY) return { ok: true };
  const res = await fetch(`${SB_URL}/rest/v1/live_timing?id=eq.1`, {
    method: "PATCH",
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ data, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) return { ok: false, error: `HTTP ${res.status} ${await res.text()}` };
  return { ok: true };
}

if (args.arret) {
  if (!DRY && (!SB_URL || !SB_KEY)) {
    console.error("Adresse ou clé Supabase introuvables dans .env (adresse en https://…supabase.co et clé commençant par sb_ ou eyJ). Vous pouvez aussi les donner : --url https://xxxx.supabase.co --cle votre_cle");
    process.exit(1);
  }
  const r = await writeRow({});
  console.log(r.ok ? "Flux simulé effacé." : "Erreur : " + r.error);
  process.exit(r.ok ? 0 : 1);
}
if (!DRY && (!SB_URL || !SB_KEY)) {
  console.error("Adresse ou clé Supabase introuvables dans .env (lancez la commande depuis le dossier du projet, là où se trouve .env). Vous pouvez aussi les donner : --url https://xxxx.supabase.co --cle votre_cle");
  process.exit(1);
}

// ---------- données de la course ----------
const D = JSON.parse(fs.readFileSync(path.join(here, "data.json"), "utf8"));
const RACE_MS = D.raceMs;
const cars = D.cars.map((c) => {
  const n = c.laps.length;
  const cross = new Float64Array(n); // heure (ms de course) de chaque passage de la ligne
  const bestLap = new Float64Array(n);
  const b1 = new Float64Array(n), b2 = new Float64Array(n), b3 = new Float64Array(n);
  const pits = new Int32Array(n);
  const sorted = c.laps.map((l) => l[0]).sort((x, y) => x - y);
  const normal = (sorted[sorted.length >> 1] || 1) * 1.15; // tours "normaux" : pour les meilleurs temps
  let t = 0, bl = Infinity, x1 = Infinity, x2 = Infinity, x3 = Infinity, p = 0;
  for (let i = 0; i < n; i++) {
    const [lt, s1, s2, s3, pit] = c.laps[i];
    t += lt;
    cross[i] = t;
    if (!pit && lt <= normal) bl = Math.min(bl, lt);
    if (i > 0 && !pit && lt <= normal) { x1 = Math.min(x1, s1); x2 = Math.min(x2, s2); x3 = Math.min(x3, s3); }
    if (pit) p++;
    bestLap[i] = Number.isFinite(bl) ? bl : lt;
    b1[i] = x1; b2[i] = x2; b3[i] = x3; pits[i] = p;
  }
  return { ...c, num: String(c.num), cross, bestLap, b1, b2, b3, pits, n };
});

// mes voitures : remplacent les voitures classées à ces rangs au moment du départ de la simulation
const MY_RANKS = [10, 26, 27, 28, 29, 46, 12, 33];
function lapsDone(c, T) {
  // nombre de passages de la ligne <= T (recherche dichotomique)
  let lo = 0, hi = c.n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (c.cross[mid] <= T) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
function ranking(T) {
  return cars
    .map((c) => ({ c, n: lapsDone(c, T) }))
    .sort((a, b) => b.n - a.n || (a.n ? a.c.cross[a.n - 1] - b.c.cross[b.n - 1] : a.c.num - b.c.num));
}
const assigned = [];
if (MINE.length) {
  const rk = ranking(Math.max(START_MS, 180000));
  let slotIdx = 0;
  const used = new Set(MINE.map((m) => cars.find((c) => c.num === m)).filter(Boolean));
  MINE.forEach((mine) => {
    // un numéro qui existe dans la course 2025 (ex. 265, 271, 276) garde sa vraie voiture et ses vrais temps
    const real = cars.find((c) => c.num === mine);
    if (real) {
      assigned.push(`#${mine} = ${real.team} (vraie voiture 2025, classée P${rk.findIndex((r) => r.c === real) + 1} au départ de la simulation)`);
      return;
    }
    // voiture du peloton la plus proche du rang souhaité, jamais une voiture déjà prise
    let pos = Math.min(MY_RANKS[slotIdx++] - 1, rk.length - 1);
    while (pos < rk.length - 1 && used.has(rk[pos].c)) pos++;
    const slot = rk[pos].c;
    used.add(slot);
    const clash = cars.find((c) => c.num === mine && c !== slot);
    if (clash) clash.num = slot.num; // échange des numéros pour éviter un doublon
    assigned.push(`#${mine} = ${slot.team} (classée P${rk.findIndex((r) => r.c === slot) + 1} au départ de la simulation)`);
    slot.num = mine;
  });
}

// ---------- messages de la direction de course ----------
const rcScript = [];
D.yellow.forEach(([a, b], i) => {
  rcScript.push({ at: a + 120000, text: "FULL COURSE YELLOW" });
  rcScript.push({ at: b, text: "GREEN FLAG" });
});
rcScript.push({ at: 600000, text: "PIT WINDOW OPEN" });
const pen = ["DRIVE THROUGH PENALTY - SPEEDING IN PIT LANE", "STOP & GO 30s - IGNORING YELLOW FLAGS", "WARNING - TRACK LIMITS", "BLACK AND WHITE FLAG - UNSPORTING BEHAVIOUR"];
const pool = cars.map((c) => c.num);
let seed = 12345;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
for (let t = 900000; t < RACE_MS; t += 1500000 + Math.floor(rnd() * 1500000)) {
  rcScript.push({ at: t, text: `N°${pool[Math.floor(rnd() * pool.length)]} ${pen[Math.floor(rnd() * pen.length)]}` });
}
MINE.forEach((m, i) => rcScript.push({ at: START_MS + 240000 + i * 420000, text: `N°${m} DRIVE THROUGH PENALTY - SPEEDING IN PIT LANE` }));
rcScript.sort((a, b) => a.at - b.at);

// ---------- construction d'une image du flux à l'instant T (ms de course) ----------
const realStart = Date.now();
function snapshot(T, nowReal) {
  const rk = ranking(T);
  const leader = rk[0];
  const leaderLapsAt = (t) => lapsDone(leader.c, t);
  const toReal = (tc) => nowReal - (T - tc) / SPEED; // heure réelle correspondant à un instant de course
  const out = {};
  rk.forEach((r, idx) => {
    const { c, n } = r;
    const finished = n >= c.n;
    const inProg = n; // tour en cours (index)
    const prevCross = n > 0 ? c.cross[n - 1] : 0;
    const lap = !finished ? c.laps[inProg] : null;
    let s1 = null, s2 = null, s3 = null;
    if (lap) {
      const e1 = prevCross + lap[1], e2 = e1 + lap[2];
      if (T >= e1) s1 = lap[1];
      if (T >= e2) s2 = lap[2];
    }
    if (s1 == null && n > 0) {
      const l = c.laps[n - 1];
      s1 = l[1]; s2 = l[2]; s3 = l[3];
    }
    const lastIdx = n - 1;
    // écarts : au leader et à la voiture devant, mesurés au dernier passage de la ligne
    let gl = { ms: 0, laps: 0 }, ia = { ms: null, laps: 0 };
    if (idx > 0 && n > 0) {
      const tc = c.cross[n - 1];
      const ld = leaderLapsAt(tc);
      const lapsDown = Math.max(0, ld - n);
      const ref = leader.c.cross[Math.min(n + lapsDown, leader.c.n) - 1];
      gl = { ms: Math.max(0, tc - ref), laps: lapsDown };
      const ahead = rk[idx - 1];
      if (ahead.n > 0) {
        const ld2 = lapsDone(ahead.c, tc);
        const lapsA = Math.max(0, ld2 - n);
        const refA = ahead.c.cross[Math.min(n + lapsA, ahead.c.n) - 1];
        ia = { ms: Math.max(0, tc - refA), laps: lapsA };
      }
    }
    const pitsNow = n > 0 ? c.pits[Math.min(n, c.n) - 1] : 0;
    const inPit = !!(lap && lap[4] && T >= prevCross + lap[1] + lap[2]);
    const drv = c.drivers.length ? c.drivers[pitsNow % c.drivers.length] : "";
    out[c.num] = {
      car_number: c.num,
      position: idx + 1,
      team: c.team,
      driver: drv,
      category: c.cat,
      lap: {
        lap_number: n,
        lap_time_ms: n > 0 ? c.laps[lastIdx][0] : null,
        best_lap_ms: n > 0 ? c.bestLap[lastIdx] : null,
        s1_ms: s1, s2_ms: s2, s3_ms: s3,
        s1_best_ms: n > 1 ? c.b1[lastIdx] : null,
        s2_best_ms: n > 1 ? c.b2[lastIdx] : null,
        s3_best_ms: n > 1 ? c.b3[lastIdx] : null,
        lap_end: n > 0 ? new Date(toReal(c.cross[n - 1])).toISOString() : null,
        car_state: finished ? "FIN" : inPit ? "IN" : "RUN",
      },
      gaps: { toLeader: gl },
      ints: { toAhead: ia },
      stops: { count: pitsNow },
    };
  });
  return out;
}

function inYellow(T) {
  return D.yellow.some(([a, b]) => T >= a + 120000 && T < b);
}

// ---------- boucle principale : une image toutes les 3 s ----------
// on écrit le flux dans le format "déjà converti" que le poste Admin enregistre habituellement
// (même contenu que lit PitBoard), afin de ne rien changer à l'application.
import { parseLiveTiming } from "../src/lib/risLive.js";

console.log("PitBoard — simulateur de course (Spa 24 Heures 2CV/C1 2025, 115 voitures)");
console.log(`Départ de la simulation : ${(START_MS / 3600000).toFixed(2)} h de course · vitesse x${SPEED}`);
console.log(`Identifiant du flux (uuid) à saisir dans la configuration de PitBoard : ${UUID}`);
if (assigned.length) assigned.forEach((a) => console.log("  " + a));
if (SPEED !== 1) console.log("ATTENTION : à une vitesse différente de 1, les comptes à rebours de dépassement ne sont pas fidèles (le temps de course est accéléré).");
console.log("Ctrl+C pour arrêter.\n");

let seq = 1;
let lastLog = 0;
async function tick() {
  const nowReal = Date.now();
  const T = Math.min(RACE_MS, START_MS + (nowReal - realStart) * SPEED);
  const carsObj = snapshot(T, nowReal);
  const finished = T >= RACE_MS;
  const rcEvents = rcScript
    .filter((e) => e.at <= T && e.at > T - 600000)
    .slice(-20)
    .map((e, i) => ({ id: "sim" + e.at, kind: "RC_MESSAGE", at: new Date(nowReal - (T - e.at) / SPEED).toISOString(), message: e.text }));
  const raw = {
    seq: seq++,
    generated_at: new Date(nowReal).toISOString(),
    context: { session: { status: finished ? "FINISHED" : "RUNNING", track_state: inYellow(T) ? "YELLOW" : "GREEN", clock: { elapsed_ms: Math.round(T), remaining_ms: Math.round(RACE_MS - T) } } },
    events: rcEvents,
    cars: Object.values(carsObj),
  };
  const live = parseLiveTiming(raw);
  const payload = {
    uuid: UUID,
    seq: live.seq,
    generatedAt: live.generatedAt,
    fetchedAt: nowReal,
    status: live.status,
    trackStateRaw: live.trackStateRaw,
    elapsedMs: live.elapsedMs,
    remainingMs: live.remainingMs,
    rc: live.rc,
    cars: live.cars,
  };
  if (args.dump) fs.writeFileSync(path.join(here, "dernier_flux.json"), JSON.stringify(payload));
  const r = await writeRow(payload);
  if (nowReal - lastLog > 15000 || !r.ok) {
    lastLog = nowReal;
    const h = T / 3600000;
    const top = Object.values(carsObj).filter((c) => c.position <= 3).sort((a, b) => a.position - b.position).map((c) => `P${c.position} #${c.car_number}`).join("  ");
    console.log(`${new Date().toLocaleTimeString()}  course ${Math.floor(h)}h${String(Math.floor((h % 1) * 60)).padStart(2, "0")}  ${inYellow(T) ? "JAUNE" : "vert "}  ${top}  ${r.ok ? "écrit" : "ERREUR : " + r.error}`);
  }
  if (finished) {
    console.log("Course terminée.");
    process.exit(0);
  }
}
await tick();
setInterval(() => tick().catch((e) => console.log("erreur :", e.message)), TICK_MS);

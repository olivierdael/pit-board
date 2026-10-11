// Lecture du flux RIS Live Timing et conversion en données utilisables par PitBoard.
//
// Flux : https://live.ris-timing.be/api/live-timing?uuid=<uuid>
//  - classement général : cars[].position
//  - tours              : cars[].lap.lap_number
//  - drapeau            : context.session.track_state ("green" | "yellow" en direct)
//
// Le navigateur essaie d'abord le flux directement. Si le site refuse (CORS), on bascule
// sur le relais /api/live-timing hébergé avec l'application (voir api/live-timing.js).

const DIRECT_URL = (uuid) => `https://live.ris-timing.be/api/live-timing?uuid=${encodeURIComponent(uuid)}`;
const PROXY_URL = (uuid) => `/api/live-timing?uuid=${encodeURIComponent(uuid)}`;

let preferProxy = false; // mémorise le mode qui a fonctionné en dernier

async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal, cache: "no-store", headers: { Accept: "application/json" } });
  } finally {
    clearTimeout(timer);
  }
}

// retourne { raw, via: "direct" | "proxy" } ou lève une erreur qui explique les deux échecs
export async function fetchLiveTiming(uuid) {
  const errors = [];
  const order = preferProxy ? ["proxy", "direct"] : ["direct", "proxy"];
  for (const mode of order) {
    try {
      const res = await fetchWithTimeout(mode === "direct" ? DIRECT_URL(uuid) : PROXY_URL(uuid), 8000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = await res.json();
      preferProxy = mode === "proxy";
      return { raw, via: mode };
    } catch (e) {
      const msg = e && e.name === "AbortError" ? "délai dépassé" : (e && e.message) || String(e);
      errors.push(`${mode === "direct" ? "lecture directe" : "relais Vercel"} : ${msg}`);
    }
  }
  throw new Error(errors.join(" | "));
}

// état de piste du flux -> drapeau PitBoard : "vert" | "jaune" | "rouge" ; null si inconnu / vide
// (alors l'application ne change rien toute seule). Valeurs vues en direct : "GREEN".
// Jaune : yellow, FCY, safety car, SC, VSC. Rouge : red.
export function normalizeTrackState(v) {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase().replace(/[\s_-]+/g, " ");
  if (!s) return null;
  if (s === "green" || s === "vert") return "vert";
  if (s.includes("red") || s.includes("rouge")) return "rouge";
  if (s.includes("yellow") || s.includes("jaune") || s.includes("fcy") || s.includes("safety") || s === "sc" || s === "vsc")
    return "jaune";
  return null;
}

// numéro de voiture comparable : "#446", " 446 ", "0446" -> "446"
export function normalizeCarNumber(v) {
  return String(v == null ? "" : v)
    .trim()
    .replace(/^#/, "")
    .replace(/^0+(?=\d)/, "");
}

function asPositiveInt(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}
// durée en millisecondes : nombre fini >= 0, sinon null
function asMs(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
function asNonNegativeInt(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

// raw = JSON du flux. Lève une erreur si le format n'est pas celui attendu.
export function parseLiveTiming(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.cars)) {
    throw new Error("format de flux inattendu (pas de liste cars)");
  }
  const cars = {};
  raw.cars.forEach((c) => {
    const num = normalizeCarNumber(c && c.car_number);
    if (!num) return;
    const lap = (c && c.lap) || {};
    const gl = (c.gaps && c.gaps.toLeader) || {};
    const ia = (c.ints && c.ints.toAhead) || {};
    const stops = c.stops || {};
    cars[num] = {
      pos: asPositiveInt(c.position),
      laps: asNonNegativeInt(lap.lap_number),
      // détails (tous optionnels : null si absents du flux)
      team: typeof c.team === "string" ? c.team : "",
      driver: typeof c.driver === "string" ? c.driver : "",
      cat: typeof c.category === "string" ? c.category : "",
      state: typeof lap.car_state === "string" ? lap.car_state : "",
      s1: asMs(lap.s1_ms),
      s2: asMs(lap.s2_ms),
      s3: asMs(lap.s3_ms),
      s1b: asMs(lap.s1_best_ms),
      s2b: asMs(lap.s2_best_ms),
      s3b: asMs(lap.s3_best_ms),
      best: asMs(lap.best_lap_ms),
      last: asMs(lap.lap_time_ms),
      gl: asMs(gl.ms), // écart au leader (ms)
      gll: asNonNegativeInt(gl.laps), // tours de retard sur le leader
      ia: asMs(ia.ms), // écart avec la voiture devant (ms)
      ial: asNonNegativeInt(ia.laps),
      pits: asNonNegativeInt(stops.count),
    };
  });

  // messages de la direction de course (RC) : [{ id, at (ms), message }]
  const rc = (Array.isArray(raw.events) ? raw.events : [])
    .filter((e) => e && e.kind === "RC_MESSAGE" && typeof e.message === "string" && e.message.trim())
    .slice(-20)
    .map((e) => ({ id: String(e.id == null ? "" : e.id), at: Date.parse(e.at) || 0, message: e.message.trim() }));

  const session = (raw.context && raw.context.session) || {};
  const clock = session.clock || {};
  let generatedAt = Date.parse(raw.generated_at);
  if (!Number.isFinite(generatedAt)) generatedAt = Number.isFinite(Number(raw.seq)) ? Number(raw.seq) : 0;

  return {
    seq: raw.seq != null ? raw.seq : generatedAt,
    generatedAt, // heure de génération du flux côté RIS (ms)
    status: typeof session.status === "string" ? session.status : "",
    trackStateRaw: typeof session.track_state === "string" ? session.track_state : null,
    flag: normalizeTrackState(session.track_state),
    elapsedMs: asMs(clock.elapsed_ms),
    remainingMs: asMs(clock.remaining_ms),
    rc,
    cars,
  };
}

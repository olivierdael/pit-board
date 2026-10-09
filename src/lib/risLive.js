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

// "green"/"yellow" (ou vert/jaune) -> "vert"/"jaune". Tout le reste (rouge, safety car,
// null...) -> null : l'application ne change alors rien toute seule.
export function normalizeTrackState(v) {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  if (s === "green" || s === "vert") return "vert";
  if (s === "yellow" || s === "jaune") return "jaune";
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
    cars[num] = {
      pos: asPositiveInt(c.position),
      laps: asNonNegativeInt(c.lap && c.lap.lap_number),
    };
  });

  const session = (raw.context && raw.context.session) || {};
  let generatedAt = Date.parse(raw.generated_at);
  if (!Number.isFinite(generatedAt)) generatedAt = Number.isFinite(Number(raw.seq)) ? Number(raw.seq) : 0;

  return {
    seq: raw.seq != null ? raw.seq : generatedAt,
    generatedAt, // heure de génération du flux côté RIS (ms)
    status: typeof session.status === "string" ? session.status : "",
    trackStateRaw: typeof session.track_state === "string" ? session.track_state : null,
    flag: normalizeTrackState(session.track_state),
    cars,
  };
}

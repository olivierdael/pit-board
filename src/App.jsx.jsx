import React, { useState, useEffect, useLayoutEffect, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { supabase } from "./lib/supabase";
import { fetchLiveTiming, parseLiveTiming, normalizeCarNumber, normalizeTrackState } from "./lib/risLive";
import { RIS_ORIGIN, buildBookmarklet, readRisMessage } from "./lib/risBridge";
import { fetchWeather, geocode, buildBulletin, weatherLabel, lonLatToWorld, worldToLonLat, TILE } from "./lib/weather";
import {
  MAX_DRIVERS,
  MIN_DRIVERS,
  getCfg,
  driverName,
  addDriver,
  updateDriver,
  moveDriver,
  resolveRelay,
  setRelayDriver,
  freezeRelay,
  driverHasRelays,
  driverTotals,
  resetDriverRelays,
  setEndLap,
  endLapOf,
  relayLapsFromEnds,
  observeLap,
  mergeBest,
  recordLap,
  driverLapRows,
  lapBests,
  lapsToCsv,
} from "./lib/drivers";
import { fmtMs, fmtSec1, fmtGapMs, neighborsOf, clockNow, carNumbersIn, visibleRcMessages, updatePace, duelEstimates, duelEstimatesTrack, prioritizedDuels, fmtCountdown, fcyFromRc, trackAlertRows, aroundOnTrack, lastLapGain, pitOutCars, carLaps, classPositions, isPitIn, aroundWhyNot, pitExitInfo, saveLiveMemory, loadLiveMemory, setLiveTemperature, getLiveTemperature } from "./lib/liveView";
import {
  Flag,
  Plus,
  Timer,
  CheckCircle2,
  AlertTriangle,
  Settings2,
  X,
  PlayCircle,
  MessageSquare,
  Clock,
} from "lucide-react";

const FLAGS = {
  vert: { label: "VERT", bg: "#00b140", bg2: "#008a30" },
  jaune: { label: "JAUNE", bg: "#ffd400", bg2: "#ffb800" },
  rouge: { label: "ROUGE", bg: "#e2001a", bg2: "#b8000f" },
};

const DEFAULT_PAIRS = [
  ["#ff2d55", "#ffffff"],
  ["#0a84ff", "#ffffff"],
  ["#ffcc00", "#111111"],
  ["#30d158", "#111111"],
  ["#bf5af2", "#ffffff"],
  ["#ff9500", "#111111"],
];

function emptyCars() {
  return Array.from({ length: 6 }, (_, i) => ({
    id: i + 1,
    numero: "",
    pilote: "",
    team: "",
    couleur1: DEFAULT_PAIRS[i][0],
    couleur2: DEFAULT_PAIRS[i][1],
    classement: i + 1,
    initialConsoL100: "",
  }));
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function fmtTime(totalSeconds) {
  const neg = totalSeconds < 0;
  const s = Math.abs(Math.round(totalSeconds));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${neg ? "-" : ""}${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function fmtTimeHMS(totalSeconds) {
  const neg = totalSeconds < 0;
  const s = Math.abs(Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${neg ? "-" : ""}${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function fmtClock(ms) {
  const d = new Date(ms);
  return d.toLocaleTimeString("fr-BE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// programme des séances : types, libellés, séance en cours
const SESSION_TYPES = [
  ["essais1", "Essais libres 1"],
  ["essais2", "Essais libres 2"],
  ["essais3", "Essais libres 3"],
  ["qualification", "Qualification"],
  ["course", "Course"],
];
// séance à appliquer à l'instant now : la dernière dont l'heure de début est passée (null si aucune n'a commencé)
function currentSession(schedule, nowMs) {
  let cur = null;
  (schedule || []).forEach((s) => {
    const t = new Date(s.startAt).getTime();
    if (!isNaN(t) && t <= nowMs && (!cur || t >= cur.t)) cur = { s, t };
  });
  return cur ? cur.s : null;
}

// fusionne deux historiques de drapeaux (jaune ou rouge de l'un OU de l'autre l'emporte sur le vert)
function mergeFlagHist(a, b) {
  if (!b || b.length === 0) return a;
  const at = (h, t) => {
    let f = "vert";
    h.forEach((e) => {
      if (e.ts <= t) f = e.flag;
    });
    return f;
  };
  const sa = [...a].sort((x, y) => x.ts - y.ts);
  const sb = [...b].sort((x, y) => x.ts - y.ts);
  const ts = [...new Set([...sa, ...sb].map((e) => e.ts))].sort((x, y) => x - y);
  const out = [];
  ts.forEach((t) => {
    const fa = at(sa, t);
    const fb = at(sb, t);
    const f = fa === "rouge" || fb === "rouge" ? "rouge" : fa === "jaune" || fb === "jaune" ? "jaune" : "vert";
    if (!out.length || out[out.length - 1].flag !== f) out.push({ flag: f, ts: t });
  });
  return out;
}

// calcule l'état du décompte de l'événement (avant départ / en cours / terminé)
function getEventStatus(settings, now) {
  if (!settings.eventStartAt) return null;
  const startMs = new Date(settings.eventStartAt).getTime();
  if (isNaN(startMs)) return null;
  const durationMs = (settings.eventDurationSec || 0) * 1000;
  const endMs = startMs + durationMs;
  if (now < startMs) {
    return { label: "Départ dans", seconds: (startMs - now) / 1000, phase: "before" };
  }
  if (durationMs > 0 && now < endMs) {
    return { label: "Fin dans", seconds: (endMs - now) / 1000, phase: "during" };
  }
  if (durationMs > 0) {
    return { label: "Événement terminé", seconds: 0, phase: "after" };
  }
  return { label: "Départ donné", seconds: 0, phase: "started" };
}

// calcule l'état affiché d'un arrêt à l'instant "now" (ms), sans jamais
// modifier les données stockées -> pas de conflit d'écriture entre PC
const AUTO_REMOVE_AFTER_PIT_SEC = 300; // 5 min au stand -> disparition automatique de l'annonce

function deriveCall(c, now) {
  if (c.phase === "countdown") {
    const remaining = Math.round((c.arrivalAt - now) / 1000);
    if (remaining <= 0) {
      // transition automatique et locale vers "au stand", identique sur tous les écrans
      const pitElapsed = Math.round((now - c.arrivalAt) / 1000);
      return { phase: "instand", remaining: 0, pitElapsed };
    }
    return { phase: "countdown", remaining, pitElapsed: 0 };
  }
  const pitElapsed = Math.round((now - c.pitStartAt) / 1000);
  return { phase: "instand", remaining: 0, pitElapsed };
}

function sortKey(c, now) {
  const d = deriveCall(c, now);
  if (d.phase === "instand") return -1000000 - d.pitElapsed; // le plus longtemps au stand sort en premier
  return d.remaining;
}

// points de piste (secteurs) permettant d'ajuster précisément le chrono d'une annonce
const TRACK_POINTS = [
  { name: "Source", sec: 3 * 60 + 30 },
  { name: "Kemmel", sec: 2 * 60 + 55 },
  { name: "Les Combes", sec: 2 * 60 + 35 },
  { name: "Bruxelles", sec: 2 * 60 + 5 },
  { name: "Double Gauche", sec: 1 * 60 + 35 },
  { name: "Campus", sec: 55 },
];

// formule "dans X minutes Y secondes" pour l'annonce vocale
function describeDelay(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  if (m > 0 && sec > 0) return `dans ${m} minute${m > 1 ? "s" : ""} ${sec} seconde${sec > 1 ? "s" : ""}`;
  if (m > 0) return `dans ${m} minute${m > 1 ? "s" : ""}`;
  return `dans ${sec} seconde${sec > 1 ? "s" : ""}`;
}

// formule "X minutes Y secondes" (sans "dans"), pour l'annonce des points de piste
function describeDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  if (m > 0 && sec > 0) return `${m} minute${m > 1 ? "s" : ""} ${sec} seconde${sec > 1 ? "s" : ""}`;
  if (m > 0) return `${m} minute${m > 1 ? "s" : ""}`;
  return `${sec} seconde${sec > 1 ? "s" : ""}`;
}

const MALE_VOICE_HINTS = ["thomas", "daniel", "paul", "nicolas", "male", "homme", "guillaume", "antoine", "yannick", "fred", "henri", "pierre"];
const FEMALE_VOICE_HINTS = ["female", "femme", "amelie", "amélie", "julie", "virginie", "audrey", "celine", "céline", "chantal", "marie"];
const BELGIAN_HINTS = ["belg", "wallon", "(belgium)", "be-fr", "fr-be"];

function pickMaleVoice(voices) {
  const belgianVoices = voices.filter((v) => {
    const lang = (v.lang || "").toLowerCase();
    const n = (v.name || "").toLowerCase();
    return lang.startsWith("fr-be") || lang === "fr_be" || BELGIAN_HINTS.some((h) => n.includes(h) || lang.includes(h));
  });

  const searchPool = (pool) =>
    pool.find((v) => {
      const n = v.name.toLowerCase();
      return MALE_VOICE_HINTS.some((h) => n.includes(h)) && !FEMALE_VOICE_HINTS.some((h) => n.includes(h));
    }) ||
    pool.find((v) => !FEMALE_VOICE_HINTS.some((h) => v.name.toLowerCase().includes(h))) ||
    pool[0] ||
    null;

  if (belgianVoices.length > 0) {
    const male = searchPool(belgianVoices);
    if (male) return male;
  }

  const frVoices = voices.filter((v) => v.lang && v.lang.toLowerCase().startsWith("fr"));
  const pool = frVoices.length > 0 ? frVoices : voices;
  return searchPool(pool);
}

function hasBelgianVoice(voices) {
  return voices.some((v) => {
    const lang = (v.lang || "").toLowerCase();
    const n = (v.name || "").toLowerCase();
    return lang.startsWith("fr-be") || BELGIAN_HINTS.some((h) => n.includes(h) || lang.includes(h));
  });
}

function getAudioCtx(ref) {
  if (typeof window === "undefined") return null;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  if (!ref.current) ref.current = new Ctx();
  if (ref.current.state === "suspended") ref.current.resume();
  return ref.current;
}

// file d'attente vocale : chaque annonce (bip + voix) doit se terminer avant que la suivante démarre
let ttsChain = Promise.resolve();
function queueSpeechJob(jobFn) {
  ttsChain = ttsChain.then(jobFn).catch(() => {});
}

// attend que les voix soient chargées, avec un filet de sécurité si le navigateur
// ne déclenche jamais "onvoiceschanged" (sinon la file d'attente resterait bloquée pour toujours)
function waitForVoicesThenRun(fn) {
  if (typeof window === "undefined" || !window.speechSynthesis) {
    fn();
    return;
  }
  if (window.speechSynthesis.getVoices().length > 0) {
    fn();
    return;
  }
  let done = false;
  const runOnce = () => {
    if (done) return;
    done = true;
    fn();
  };
  window.speechSynthesis.onvoiceschanged = runOnce;
  setTimeout(runOnce, 800);
}

// prononce l'utterance avec un filet de sécurité : si "onend"/"onerror" ne se déclenchent
// jamais (bug navigateur), on libère quand même la file d'attente après un délai raisonnable
function speakWithSafety(utter, resolve) {
  let resolved = false;
  const finish = () => {
    if (resolved) return;
    resolved = true;
    resolve();
  };
  utter.onend = finish;
  utter.onerror = finish;
  try {
    window.speechSynthesis.resume();
    window.speechSynthesis.speak(utter);
  } catch (e) {
    finish();
    return;
  }
  const estimatedMs = Math.max(4000, (utter.text || "").length * 90);
  setTimeout(finish, estimatedMs);
}

// carillon doux façon annonce de gare, avant l'annonce vocale (quatre notes descendantes chaleureuses)
function playBeep(ref) {
  const ctx = getAudioCtx(ref);
  if (!ctx) return;
  try {
    const now = ctx.currentTime;
    // motif classique d'annonce en gare : sol-mi-do-sol (timbre doux, sinusoïdal)
    const notes = [
      { freq: 784.0, start: 0.0 }, // sol5
      { freq: 659.25, start: 0.22 }, // mi5
      { freq: 523.25, start: 0.44 }, // do5
      { freq: 392.0, start: 0.66 }, // sol4
    ];
    notes.forEach(({ freq, start }) => {
      const t = now + start;
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, t);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.35, t + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.6);
    });
  } catch (e) {}
}

// squelette commun des annonces vocales : carillon, puis (après 400 ms) voix choisie et lecture
// build() -> utterance ; pick(utter, voices) choisit la voix / la langue
function speakJob(chime, build, pick) {
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  queueSpeechJob(
    () =>
      new Promise((resolve) => {
        try {
          chime();
          const utter = build();
          utter.volume = 1;
          const go = () => {
            pick(utter, window.speechSynthesis.getVoices());
            speakWithSafety(utter, resolve);
          };
          setTimeout(() => waitForVoicesThenRun(go), 400);
        } catch (e) {
          resolve();
        }
      })
  );
}
// voix grave "annonce de gare" (accent belge si une voix fr-BE existe)
function pickStationVoice(utter, voices) {
  const voice = pickMaleVoice(voices);
  if (voice) utter.voice = voice;
  utter.lang = hasBelgianVoice(voices) ? "fr-BE" : "fr-FR";
}
function stationUtter(text) {
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 0.92;
  u.pitch = 0.45; // voix grave, masculine et synthétique
  return u;
}

// annonce vocale électronique, voix masculine à accent belge si disponible, précédée d'un bip
function speakAnnouncement(audioRef, numero, seconds, isReminder) {
  const prefix = isReminder ? "Rappel." : "Attention.";
  const text = `${prefix} La voiture numéro ${numero} va rentrer au stand ${describeDelay(seconds)}.`;
  speakJob(() => playBeep(audioRef), () => stationUtter(text), pickStationVoice);
}

// annonce vocale (voix homme) quand un manager clique sur un onglet de point de piste ("Entrée", "Source", "Kemmel", etc.)
function speakTrackPoint(audioRef, numero, pointName, sec) {
  const timePart =
    typeof sec === "number" && sec > 0 ? ` Le temps estimé avant l'entrée au stand est de ${describeDuration(sec)}.` : "";
  const text = `Attention. La voiture numéro ${numero} est à ${pointName}.${timePart}`;
  speakJob(() => playBeep(audioRef), () => stationUtter(text), pickStationVoice);
}

// ne retombe JAMAIS sur une voix d'une autre langue : mieux vaut laisser le navigateur
// choisir automatiquement (via utter.lang) que de faire prononcer un texte anglais
// avec une voix française (mauvaise prononciation)
const HIGH_QUALITY_VOICE_HINTS = [
  "google",
  "microsoft",
  "natural",
  "neural",
  "premium",
  "enhanced",
  "samantha",
  "daniel",
  "alex",
  "guy",
];
function pickVoiceForLangStrict(voices, langPrefix, preferFemale) {
  const pool = voices.filter((v) => v.lang && v.lang.toLowerCase().startsWith(langPrefix));
  if (pool.length === 0) return null;
  const genderHints = preferFemale ? FEMALE_VOICE_HINTS : MALE_VOICE_HINTS;
  const oppositeHints = preferFemale ? MALE_VOICE_HINTS : FEMALE_VOICE_HINTS;
  // priorité 1 : voix de bonne qualité connue, du genre demandé si possible
  const hqPreferred = pool.find((v) => {
    const n = v.name.toLowerCase();
    return (
      HIGH_QUALITY_VOICE_HINTS.some((h) => n.includes(h)) &&
      genderHints.some((h) => n.includes(h)) &&
      !oppositeHints.some((h) => n.includes(h))
    );
  });
  if (hqPreferred) return hqPreferred;
  // priorité 2 : voix de bonne qualité connue (peu importe le genre)
  const hq = pool.find((v) => HIGH_QUALITY_VOICE_HINTS.some((h) => v.name.toLowerCase().includes(h)));
  if (hq) return hq;
  // priorité 3 : voix du genre demandé
  const preferred = pool.find((v) => {
    const n = v.name.toLowerCase();
    return genderHints.some((h) => n.includes(h)) && !oppositeHints.some((h) => n.includes(h));
  });
  return preferred || pool.find((v) => !oppositeHints.some((h) => v.name.toLowerCase().includes(h))) || pool[0];
}

// carillon d'alerte doux mais distinctif, avant l'annonce de drapeau (deux notes montantes, timbre chaleureux)
function playAlertSiren(ref) {
  const ctx = getAudioCtx(ref);
  if (!ctx) return;
  try {
    const now = ctx.currentTime;
    const notes = [
      { freq: 523.25, start: 0.0 }, // do5
      { freq: 698.46, start: 0.18 }, // fa5
      { freq: 880.0, start: 0.36 }, // la5
    ];
    notes.forEach(({ freq, start }) => {
      const t = now + start;
      const osc = ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(freq, t);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.45, t + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.5);
    });
  } catch (e) {}
}

// alerte "full course yellow" : sirène puis annonce vocale rapide et agressive
function speakYellowAlert(audioRef, text) {
  speakJob(
    () => playAlertSiren(audioRef),
    () => {
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.0; // débit normal, posé
      u.pitch = 0.95;
      return u;
    },
    (utter, voices) => {
      // n'assigne une voix que si elle est vraiment anglaise (sinon le navigateur choisit via utter.lang)
      const voice = pickVoiceForLangStrict(voices, "en", false);
      if (voice) utter.voice = voice;
      utter.lang = "en-US";
    }
  );
}

// lecture d'un message d'équipe : bip de début puis voix agréable et naturelle
function speakMessage(audioRef, numero, managerName, text) {
  const who = managerName ? `de ${managerName}, ` : "";
  speakJob(
    () => playBeep(audioRef),
    () => {
      const u = new SpeechSynthesisUtterance(`Message ${who}pour la voiture numéro ${numero}. ${text}`);
      u.rate = 1.0;
      u.pitch = 1.05; // ton naturel et chaleureux
      u.lang = "fr-FR";
      return u;
    },
    (utter, voices) => {
      const fr = voices.filter((v) => v.lang && v.lang.toLowerCase().startsWith("fr"));
      if (fr.length > 0) {
        utter.voice = fr[0];
        utter.lang = fr[0].lang;
      }
    }
  );
}

// détermine les annonces vocales à jouer pour une transition de drapeau donnée
function flagAnnouncementTexts(prevFlag, nextFlag) {
  const texts = [];
  if (nextFlag === "jaune") {
    texts.push("Full course yellow! Full course yellow!");
  } else {
    if (prevFlag === "jaune") {
      texts.push("Full course yellow terminé! Full course yellow terminé!");
    }
    if (nextFlag === "rouge") {
      texts.push("Red Flag! Red Flag!");
    }
  }
  return texts;
}

// joue plusieurs annonces à la suite (sirène + voix pour chacune)
function speakFlagSequence(audioRef, texts) {
  texts.forEach((t, i) => {
    setTimeout(() => speakYellowAlert(audioRef, t), i * 3200);
  });
}

// -- mappage lignes Supabase -> forme utilisée par le reste de l'app (inchangée) --
// fonctions de niveau module : réutilisées à la fois par la synchronisation Realtime
// et par les actions locales (annoncer, message) pour éviter tout ID temporaire
// qui ne correspondrait pas au véritable ID généré par Supabase.
function carRowToApp(r) {
  return {
    id: r.id,
    numero: r.numero || "",
    pilote: r.pilote || "",
    team: r.team || "",
    couleur1: r.couleur1,
    couleur2: r.couleur2,
    classement: r.classement,
    initialConsoL100: r.initial_conso_l100 ?? "",
  };
}
function callRowToApp(r) {
  return {
    id: r.id,
    carId: r.car_id,
    numero: r.numero || "",
    pilote: r.pilote || "",
    couleur1: r.couleur1,
    couleur2: r.couleur2,
    tasks: r.tasks || [],
    fuel: r.fuel,
    phase: r.phase,
    arrivalAt: r.arrival_at ? new Date(r.arrival_at).getTime() : null,
    pitStartAt: r.pit_start_at ? new Date(r.pit_start_at).getTime() : null,
  };
}
function messageRowToApp(r) {
  return {
    id: r.id,
    carId: r.car_id,
    numero: r.numero || "",
    pilote: r.pilote || "",
    couleur1: r.couleur1,
    couleur2: r.couleur2,
    text: r.text,
    postedAt: new Date(r.posted_at).getTime(),
  };
}
// ravitaillement (litres ajoutés à un arrêt) : une ligne par arrêt, table technical_checks (seule la colonne fuel_l sert)
function techRowToApp(r) {
  return {
    id: r.id,
    ts: new Date(r.ts).getTime(),
    fuelL: r.fuel_l ?? "",
  };
}

// -- relais : conversions et fusion (clé naturelle d'un relais = numéro de voiture + n) --
// les colonnes de durée de Supabase sont des entiers : une valeur à virgule (ex. 123.456)
// est refusée par la base, il faut donc toujours arrondir avant d'écrire.
function toInt(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : 0;
}
function toIntOrNull(v) {
  if (v === "" || v == null) return null;
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : null;
}
function stintRowToApp(r) {
  return {
    n: r.n,
    durationSec: r.duration_sec,
    laps: r.laps ?? "",
    vertSec: r.vert_sec || 0,
    jauneSec: r.jaune_sec || 0,
    idleSec: r.idle_sec || 0,
    refueled: !!r.refueled,
    _dbId: r.id,
  };
}
// fusionne une ligne reçue de Supabase dans le journal local : si le relais existe déjà
// (ajouté localement avant l'écho Realtime), on le met à jour au lieu de le dupliquer
function mergeStintEntry(log, entry) {
  const idx = log.findIndex((x) => x.n === entry.n);
  if (idx === -1) return [...log, entry].sort((a, b) => a.n - b.n);
  const local = log[idx];
  const merged = {
    ...entry,
    idleSec: Math.max(entry.idleSec || 0, local.idleSec || 0),
    laps: entry.laps !== "" ? entry.laps : local.laps,
  };
  return log.map((x, i) => (i === idx ? merged : x));
}

// champ texte qui n'enregistre qu'en quittant le champ (ou sur Entrée) : pas d'aller-retour
// avec les autres postes pendant la frappe
// Team manager : ajuste automatiquement la taille de l'écran pour que tout tienne dans la fenêtre (16/9), sans défilement.
// Le contenu est réduit uniquement si nécessaire (jamais agrandi) ; sur téléphone / petite largeur, rien n'est modifié.
function FitToScreen({ children, reserve = 150, min = 0.45 }) {
  const outer = useRef(null);
  const inner = useRef(null);
  const [fit, setFit] = useState({ s: 1, h: null });
  useLayoutEffect(() => {
    function recompute(force) {
      const o = outer.current;
      const i = inner.current;
      if (!o || !i) return;
      if (window.innerWidth < 1024) {
        setFit((f) => (f.s === 1 && f.h === null ? f : { s: 1, h: null }));
        return;
      }
      const natural = i.offsetHeight; // hauteur réelle du contenu (non affectée par la réduction)
      if (!natural) return;
      const top = o.getBoundingClientRect().top + window.scrollY;
      const avail = window.innerHeight - top - reserve;
      let s = Math.max(min, Math.min(1, avail / natural));
      s = Math.floor(s * 50) / 50; // pas de 2 % : évite les oscillations
      setFit((f) => {
        if (f.h === null) return { s, h: Math.ceil(natural * s) };
        // Anti-tremblement : réduire est immédiat (sinon le contenu déborde), mais
        // ré-agrandir exige un vrai gain (≥ 6 %), sauf si la fenêtre elle-même change.
        // Sinon le changement de largeur dû à l'échelle modifie le retour à la ligne,
        // donc la hauteur, donc l'échelle... et l'image oscille en boucle.
        const es = force || s < f.s || s - f.s >= 0.06 ? s : f.s;
        const h = Math.ceil(natural * es);
        if (es !== f.s) return { s: es, h };
        // même échelle : la hauteur réservée ne bouge que si elle augmente ou baisse nettement
        return h > f.h || f.h - h >= 14 ? { s: es, h } : f;
      });
    }
    const onResize = () => recompute(true);
    recompute(true);
    window.addEventListener("resize", onResize);
    let ro = null;
    if (typeof ResizeObserver !== "undefined" && inner.current) {
      ro = new ResizeObserver(() => recompute(false));
      ro.observe(inner.current);
    }
    return () => {
      window.removeEventListener("resize", onResize);
      if (ro) ro.disconnect();
    };
  }, [reserve, min]);
  return (
    <div ref={outer} className="w-full" style={fit.h != null && fit.s < 1 ? { height: fit.h, overflow: "hidden" } : undefined}>
      <div
        ref={inner}
        style={fit.s < 1 ? { transform: `scale(${fit.s})`, transformOrigin: "top left", width: `${100 / fit.s}%` } : undefined}
      >
        {children}
      </div>
    </div>
  );
}

// Fenêtre (team manager) : la fenêtre s'ouvre en grand par-dessus l'écran ; pour les autres rôles le panneau reste affiché en place.
function PanelHost({ modal, open, onClose, title, children }) {
  if (!modal) return children;
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/75 p-3 sm:p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-4xl my-auto rounded-xl bg-neutral-900 border border-white/25 shadow-2xl">
        <div className="flex items-center justify-between px-4 py-2 border-b border-white/10">
          <div className="text-white font-black uppercase tracking-wide text-sm">{title}</div>
          <button onClick={onClose} className="text-white/70 hover:text-white" title="Fermer">
            <X size={20} />
          </button>
        </div>
        <div className="p-3 [&>div]:mb-0">{children}</div>
      </div>
    </div>
  );
}

const BLUE = "#4da3ff"; // meilleurs temps

// télécharge un fichier texte (CSV) depuis le navigateur
function downloadText(filename, text) {
  try {
    const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const el = document.createElement("a");
    el.href = url;
    el.download = filename;
    document.body.appendChild(el);
    el.click();
    el.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  } catch (e) {}
}

// tours d'un pilote : S1, S2, S3 et temps total ; les meilleurs en bleu
// tours vus sur CET écran pour une voiture (secours quand le poste Admin n'a encore rien enregistré pour le pilote)
function localLapRows(num) {
  return carLaps(normalizeCarNumber(num))
    .slice()
    .reverse()
    .map((h) => ({ n: h.n ?? null, temp: h.tp ?? null, pic: h.pc ?? null, at: h.end, end: h.end, total: h.lt, s1: h.s ? h.s[0] : null, s2: h.s ? h.s[1] : null, s3: h.s ? h.s[2] : null }));
}
function DriverLapsTable({ rows }) {
  const b = lapBests(rows);
  const cell = (v, best) => (
    <td className="px-1.5 py-0.5 text-right" style={v != null && v === best ? { color: BLUE, fontWeight: 800 } : undefined}>
      {v != null ? fmtMs(v) : "–"}
    </td>
  );
  if (rows.length === 0) return <div className="text-white/40 text-[10px] pl-2 py-1">Aucun tour enregistré pour ce pilote.</div>;
  return (
    <div className="max-h-56 overflow-y-auto rounded bg-black/40 mt-1">
      <table className="w-full font-mono text-[11px] text-white/85">
        <thead className="sticky top-0 bg-neutral-900 text-white/50">
          <tr>
            <th className="px-1.5 py-0.5 text-left">Tour · heure</th>
            <th className="px-1.5 py-0.5 text-right">S1</th>
            <th className="px-1.5 py-0.5 text-right">S2</th>
            <th className="px-1.5 py-0.5 text-right">S3</th>
            <th className="px-1.5 py-0.5 text-right">Total</th>
            <th className="px-1.5 py-0.5 text-right" title="Position dans la classe (PIC) à la fin du tour">PIC</th>
            <th className="px-1.5 py-0.5 text-right" title="Température extérieure au moment du tour">°C</th>
          </tr>
        </thead>
        <tbody>
          {[...rows].reverse().map((r) => (
            <tr key={(r.n != null ? r.n : "") + "_" + (r.at || r.end || "")} className="border-t border-white/10">
              <td className="px-1.5 py-0.5 whitespace-nowrap">{r.n != null ? `tr ${r.n}` : ""}{r.at ? ` · ${new Date(r.at).toLocaleTimeString("fr-BE")}` : ""}</td>
              {cell(r.s1, b.s1)}
              {cell(r.s2, b.s2)}
              {cell(r.s3, b.s3)}
              {cell(r.total, b.total)}
              <td className="px-1.5 py-0.5 text-right font-bold">{r.pic != null ? `${r.pic}e` : "–"}</td>
              <td className="px-1.5 py-0.5 text-right text-white/60">{r.temp != null ? r.temp.toFixed(1) : "–"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// temps de roulage, meilleurs temps et tours (S1 S2 S3, total) de tous les pilotes d'une voiture (menu déroulant côté team manager)
function DriversTimes({ ds, hasLive, carNum }) {
  const [openId, setOpenId] = useState(null);
  const nbLaps = ds.cfg.list.reduce((s, p) => s + (ds.cfg.laps[p.id] || []).length, 0);
  return (
    <div className="text-[10px] text-white/70 flex flex-col gap-1">
      {ds.cfg.list.map((p) => {
        const t = ds.totals[p.id];
        const isCur = ds.curDriver && ds.curDriver.id === p.id;
        const bst = ds.cfg.best[p.id];
        const recorded = driverLapRows(ds.cfg, p.id, ds.n);
        const useLocal = recorded.length === 0 && isCur;
        const rows = useLocal ? localLapRows(carNum) : recorded;
        const open = openId === p.id;
        return (
          <div key={p.id} className="flex flex-col">
            <div className={`flex items-center justify-between gap-2 font-mono ${isCur ? "text-white font-bold" : ""} ${p.absent ? "opacity-50" : ""}`}>
              <span className="truncate font-sans">
                {driverName(p) || "Pilote sans nom"}
                {p.absent ? " (indisp.)" : ""}
              </span>
              <span className="whitespace-nowrap">
                {fmtTimeHMS(t.total)}{" "}
                <span className="text-white/50">
                  🟢{fmtTimeHMS(t.vert)} 🟡{fmtTimeHMS(t.jaune)} · {t.relays} rel. · {t.laps} tr
                </span>
              </span>
            </div>
            {hasLive && (
              <div className="font-mono text-[9px] pl-2" style={{ color: BLUE }}>
                {bst && (bst.lap || bst.s1 || bst.s2 || bst.s3)
                  ? `Meilleur tour ${fmtMs(bst.lap)} · S1 ${fmtMs(bst.s1)} · S2 ${fmtMs(bst.s2)} · S3 ${fmtMs(bst.s3)}`
                  : <span className="text-white/35">Meilleurs temps : pas encore enregistrés</span>}
              </div>
            )}
            {hasLive && (
              <div className="pl-2">
                <button
                  type="button"
                  onClick={() => setOpenId(open ? null : p.id)}
                  className="text-[10px] font-bold text-white/70 hover:text-white underline-offset-2 hover:underline"
                >
                  {open ? "▾" : "▸"} Tours S1 · S2 · S3 · total ({rows.length})
                </button>
                {open && useLocal && rows.length > 0 && (
                  <div className="text-white/40 text-[9px] pl-1 pt-0.5">Le poste Admin n'a encore rien enregistré : voici les tours vus sur cet écran depuis son ouverture.</div>
                )}
                {open && <DriverLapsTable rows={rows} />}
              </div>
            )}
          </div>
        );
      })}
      {hasLive && (
        <button
          type="button"
          disabled={nbLaps === 0}
          onClick={() => downloadText(`pitboard_tours_${carNum || "voiture"}.csv`, lapsToCsv(ds.cfg, carNum || "", driverName, ds.n))}
          className="self-start mt-1 rounded bg-white/15 hover:bg-white/25 disabled:opacity-40 px-2 py-1 text-[10px] font-black uppercase tracking-wide text-white"
        >
          ⬇ Exporter les tours (CSV)
        </button>
      )}
    </div>
  );
}

// carte simple (tuiles OpenStreetMap) : glisser pour déplacer, + / − pour zoomer, cliquer pour poser le repère du circuit
function CircuitMap({ lat, lon, onPick }) {
  const box = useRef(null);
  const [size, setSize] = useState({ w: 600, h: 300 });
  const [view, setView] = useState(() => ({ lat: Number.isFinite(lat) ? lat : 50.5, lon: Number.isFinite(lon) ? lon : 4.5, z: Number.isFinite(lat) ? 14 : 7 }));
  const drag = useRef(null);
  useLayoutEffect(() => {
    const measure = () => box.current && setSize({ w: box.current.offsetWidth || 600, h: 300 });
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  // nouveau lieu choisi ailleurs (recherche par nom) : on recentre la carte
  useEffect(() => {
    if (Number.isFinite(lat) && Number.isFinite(lon)) setView((v) => ({ ...v, lat, lon, z: Math.max(v.z, 13) }));
  }, [lat, lon]);
  const c = lonLatToWorld(view.lon, view.lat, view.z);
  const tlx = c.x - size.w / 2;
  const tly = c.y - size.h / 2;
  const n = Math.pow(2, view.z);
  const tiles = [];
  for (let ty = Math.floor(tly / TILE); ty <= Math.floor((tly + size.h) / TILE); ty++) {
    for (let tx = Math.floor(tlx / TILE); tx <= Math.floor((tlx + size.w) / TILE); tx++) {
      if (ty < 0 || ty >= n) continue;
      const wx = ((tx % n) + n) % n;
      tiles.push(
        <img key={view.z + "_" + tx + "_" + ty} alt="" draggable={false} src={`https://tile.openstreetmap.org/${view.z}/${wx}/${ty}.png`} style={{ position: "absolute", left: Math.round(tx * TILE - tlx), top: Math.round(ty * TILE - tly), width: TILE, height: TILE, userSelect: "none", pointerEvents: "none" }} />
      );
    }
  }
  const pin = Number.isFinite(lat) && Number.isFinite(lon) ? lonLatToWorld(lon, lat, view.z) : null;
  const down = (e) => {
    drag.current = { x: e.clientX, y: e.clientY, cx: c.x, cy: c.y, moved: false };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* non pris en charge */
    }
  };
  const move = (e) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
    if (d.moved) {
      const p = worldToLonLat(d.cx - dx, d.cy - dy, view.z);
      setView((v) => ({ ...v, lat: p.lat, lon: p.lon }));
    }
  };
  const up = (e) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.moved) return;
    const r = e.currentTarget.getBoundingClientRect();
    const p = worldToLonLat(tlx + (e.clientX - r.left), tly + (e.clientY - r.top), view.z);
    onPick(Math.round(p.lat * 1e5) / 1e5, Math.round(p.lon * 1e5) / 1e5);
  };
  const zbtn = "w-8 h-8 rounded bg-white text-black font-black text-lg shadow";
  return (
    <div ref={box} className="relative w-full overflow-hidden rounded border border-white/30 bg-neutral-700 select-none" style={{ height: 300, touchAction: "none", cursor: "crosshair" }} onPointerDown={down} onPointerMove={move} onPointerUp={up}>
      {tiles}
      {pin && <div style={{ position: "absolute", left: pin.x - tlx, top: pin.y - tly, transform: "translate(-50%,-100%)", fontSize: 28, lineHeight: 1, pointerEvents: "none" }}>📍</div>}
      <div className="absolute top-2 right-2 flex flex-col gap-1" onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => e.stopPropagation()}>
        <button type="button" className={zbtn} onClick={() => setView((v) => ({ ...v, z: Math.min(18, v.z + 1) }))}>+</button>
        <button type="button" className={zbtn} onClick={() => setView((v) => ({ ...v, z: Math.max(3, v.z - 1) }))}>−</button>
      </div>
      <div className="absolute bottom-0 right-0 bg-white/80 text-black text-[10px] px-1">© OpenStreetMap</div>
    </div>
  );
}

// réglages météo (circuit : recherche par nom, carte, coordonnées) — dans la configuration
function WeatherSettings({ settings, pushSettings, weather }) {
  const [q, setQ] = useState("");
  const [res, setRes] = useState([]);
  const [msg, setMsg] = useState("");
  const set = (lat, lon) => pushSettings({ ...settings, circuitLat: lat, circuitLon: lon });
  const search = async () => {
    setMsg("Recherche…");
    try {
      const r = await geocode(q);
      setRes(r);
      setMsg(r.length ? "" : "Aucun résultat : essayez le nom de la ville, ou cliquez sur la carte.");
    } catch {
      setMsg("Recherche impossible pour le moment : cliquez sur la carte.");
    }
  };
  const inp = "px-2 py-1.5 text-sm rounded bg-black/50 text-white border border-white/20 focus:outline-none focus:border-white";
  return (
    <div className="flex flex-col gap-2 p-2 rounded border border-white/15 bg-black/30">
      <div className="text-white text-xs font-bold uppercase tracking-wide">Météo du circuit</div>
      <p className="text-white/50 text-[10px]">
        Choisis l'emplacement du circuit : la température est notée avec chaque tour et un bulletin météo (maintenant + 2 heures suivantes) s'affiche toutes les 30 minutes (à H:00 et H:30).
      </p>
      <div className="flex gap-1.5">
        <input type="text" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && search()} placeholder="Nom du circuit ou de la ville (ex. Spa-Francorchamps)" className={inp + " flex-1 min-w-0"} />
        <button type="button" onClick={search} className="px-3 rounded bg-white/15 text-white text-xs font-black">Chercher</button>
      </div>
      {msg && <div className="text-white/60 text-xs">{msg}</div>}
      {res.length > 0 && (
        <div className="flex flex-col gap-1">
          {res.map((r, i) => (
            <button key={i} type="button" onClick={() => { set(Math.round(r.lat * 1e5) / 1e5, Math.round(r.lon * 1e5) / 1e5); setRes([]); }} className="text-left text-xs rounded bg-white/10 hover:bg-white/20 px-2 py-1 text-white">
              {r.name} <span className="text-white/50">· {r.place}</span>
            </button>
          ))}
        </div>
      )}
      <CircuitMap lat={settings.circuitLat} lon={settings.circuitLon} onPick={set} />
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1 text-white text-xs">
          Latitude
          <input type="number" step="0.00001" value={Number.isFinite(settings.circuitLat) ? settings.circuitLat : ""} onChange={(e) => pushSettings({ ...settings, circuitLat: e.target.value === "" ? null : Number(e.target.value) })} className={inp} />
        </label>
        <label className="flex flex-col gap-1 text-white text-xs">
          Longitude
          <input type="number" step="0.00001" value={Number.isFinite(settings.circuitLon) ? settings.circuitLon : ""} onChange={(e) => pushSettings({ ...settings, circuitLon: e.target.value === "" ? null : Number(e.target.value) })} className={inp} />
        </label>
      </div>
      <label className="flex items-center gap-2 text-white text-xs">
        <input type="checkbox" checked={settings.weatherBulletin !== false} onChange={(e) => pushSettings({ ...settings, weatherBulletin: e.target.checked })} />
        Bulletin météo toutes les 30 minutes (dans les messages d'alerte)
      </label>
      <div className="text-white/70 text-xs">
        {weather ? <>Actuellement : <b className="text-white">{weather.tempC.toFixed(1)} °C</b>{weather.windKmh != null ? ` · vent ${Math.round(weather.windKmh)} km/h` : ""} · {weatherLabel(weather.code).icon} {weatherLabel(weather.code).text}</> : Number.isFinite(settings.circuitLat) && Number.isFinite(settings.circuitLon) ? "Lecture de la météo…" : "Aucun emplacement choisi : pas de météo."}
      </div>
    </div>
  );
}

// historique des alertes RC : celles qui citent le numéro de la voiture sont en évidence et restent « à acquitter » jusqu'au clic sur « Vu »
function RcHistory({ entries, num, acks, onAck, big, showEmpty }) {
  const [onlyMine, setOnlyMine] = useState(false);
  const mine = (l) => !!num && carNumbersIn(l.m).includes(num);
  const key = (l) => l.t + "|" + l.m;
  const list = onlyMine ? entries.filter(mine) : entries;
  const pending = entries.filter((l) => mine(l) && !acks.has(key(l))).length;
  if (entries.length === 0 && !showEmpty) return null;
  return (
    <div className="flex flex-col gap-1 pt-1 border-t border-white/10">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-white font-black uppercase tracking-wide text-xs">🚨 Historique des alertes RC ({entries.length})</span>
        {pending > 0 && <span className="rounded bg-red-600 text-white text-[11px] font-black px-1.5 animate-pulse">{pending} à acquitter</span>}
        <button type="button" onClick={() => setOnlyMine((v) => !v)} className="ml-auto rounded bg-white/15 hover:bg-white/25 px-2 py-0.5 text-white text-[10px] font-black uppercase">
          {onlyMine ? "Voir toutes les alertes" : `Seulement #${num || "?"}`}
        </button>
      </div>
      <div className="flex flex-col gap-1 overflow-y-auto" style={{ maxHeight: big ? 260 : 110 }}>
        {list.length === 0 && <div className="text-white/50 text-xs py-1">{entries.length === 0 ? "Aucune alerte reçue pour l'instant." : `Aucune alerte ne cite #${num}.`}</div>}
        {list.map((l, i) => {
          const isMine = mine(l);
          const done = acks.has(key(l));
          return (
            <div
              key={l.t + "-" + i}
              className={`rounded px-2 py-1 flex items-start gap-2 leading-snug ${isMine && !done ? "animate-pulse" : ""}`}
              style={isMine ? { backgroundColor: done ? "#5a1414" : "#c40000", border: "2px solid #ff4040", fontSize: big ? 15 : 12 } : { color: "#ff7a7a", fontSize: big ? 13 : 11 }}
            >
              <span className="font-mono whitespace-nowrap font-bold">{new Date(l.t).toLocaleTimeString("fr-BE")}{l.local ? "*" : ""}</span>
              <span className={`flex-1 min-w-0 break-words ${isMine ? "text-white font-black" : "font-semibold"}`}>
                {isMine ? `⚠ #${num} · ` : ""}RC : {l.m}
              </span>
              {isMine && !done && (
                <button type="button" onClick={() => onAck(key(l))} className="rounded bg-white text-red-700 font-black text-xs px-2 py-0.5 flex-shrink-0">✓ Vu</button>
              )}
            </div>
          );
        })}
      </div>
      {entries.some((l) => l.local) && <div className="text-white/40 text-[10px]">* heure d'arrivée sur cet écran (le poste Admin n'a pas noté l'heure exacte).</div>}
    </div>
  );
}

function DraftInput({ value, onCommit, placeholder, className, disabled }) {
  const [draft, setDraft] = useState(value || "");
  const focusedRef = useRef(false);
  useEffect(() => {
    if (!focusedRef.current) setDraft(value || "");
  }, [value]);
  return (
    <input
      type="text"
      value={draft}
      placeholder={placeholder}
      disabled={disabled}
      className={className}
      onFocus={() => (focusedRef.current = true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        focusedRef.current = false;
        if (draft !== (value || "")) onCommit(draft);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
    />
  );
}

// Essais : encart "consommation". Le réservoir est plein au départ ; à la fin on remet du carburant et on saisit les litres :
// consommation = litres / distance parcourue (temps de roulage vert et jaune, vitesses moyennes des réglages).
function EssaisConsoCard({ run, tankL, lapsKm, savedValue, onSave, running, canCancel, onStart, onCancel, auto }) {
  const [added, setAdded] = useState("");
  const [saved, setSaved] = useState(false);
  const litres = parseFloat(String(added).replace(",", "."));
  const okL = Number.isFinite(litres) && litres > 0;
  const consTime = okL && run.distance > 0 ? (litres / run.distance) * 100 : null;
  const consLaps = okL && lapsKm > 0 ? (litres / lapsKm) * 100 : null;
  return (
    <div className="rounded-xl bg-black/80 border-2 border-[#ffd400] px-3 py-1.5 flex flex-col gap-1">
      <div className="flex items-center gap-3 flex-wrap text-white">
        <span className="text-sm font-black uppercase tracking-wide whitespace-nowrap">⛽ Essais · plein de {tankL} L au départ</span>
        {!running && auto ? (
          <span className="px-3 py-1 rounded text-xs font-black uppercase bg-green-600 text-white">🏁 Départ automatique : dès que la voiture franchit S1 (RIS)</span>
        ) : !running ? (
          <button type="button" onClick={onStart} className="px-6 py-3 rounded-lg font-black uppercase text-2xl leading-tight shadow-lg" style={{ animation: "pbblink 0.8s infinite" }}>
            🏁 Voiture sur la piste : lancer le calcul
          </button>
        ) : (
          canCancel && (
            <button type="button" onClick={onCancel} className="px-2 py-0.5 rounded font-bold text-[11px] bg-white/15 text-white hover:bg-white/25" title="Annuler si le lancement était une erreur">
              ↺ Pas encore partie
            </button>
          )
        )}
        <span className="font-mono text-sm font-bold whitespace-nowrap">
          Roulage {fmtTimeHMS(run.vertSec + run.jauneSec)} 🟢{fmtTimeHMS(run.vertSec)} 🟡{fmtTimeHMS(run.jauneSec)}
        </span>
        <span className="font-mono text-sm font-bold whitespace-nowrap">≈ {run.distance.toFixed(1)} km</span>
        {lapsKm > 0 && <span className="font-mono text-xs text-white/70 whitespace-nowrap">({lapsKm.toFixed(1)} km en tours × circuit)</span>}
      </div>
      <div className="flex items-center gap-2 flex-wrap text-white">
        <label className="flex items-center gap-2 text-sm font-bold">
          Litres remis au plein final
          <input
            type="text"
            inputMode="decimal"
            value={added}
            onChange={(e) => {
              setAdded(e.target.value);
              setSaved(false);
            }}
            placeholder="ex. 12,5"
            className="w-24 px-2 py-1 rounded bg-white text-black font-mono font-bold text-base"
          />
          L
        </label>
        <span className="font-mono text-lg font-black whitespace-nowrap" style={{ color: "#ffd400" }}>
          {consTime != null ? `${consTime.toFixed(1)} L/100 km` : "– L/100 km"}
        </span>
        {consLaps != null && <span className="font-mono text-xs text-white/70 whitespace-nowrap">({consLaps.toFixed(1)} avec les tours)</span>}
        <button
          type="button"
          disabled={consTime == null || consTime < 3 || consTime > 80}
          onClick={() => {
            onSave(consTime.toFixed(1));
            setSaved(true);
          }}
          className="px-3 py-1 rounded font-black uppercase text-xs bg-[#ffd400] text-black disabled:opacity-35"
        >
          Enregistrer dans la voiture
        </button>
        {saved && <span className="text-xs font-bold text-green-400">✓ enregistré</span>}
        {!saved && savedValue ? <span className="text-xs text-white/60">config actuelle : {savedValue} L/100 km</span> : null}
      </div>
    </div>
  );
}

// style des alertes de la piste selon leur catégorie (voir trackAlertRows)
const TRACK_STYLE = {
  slow: { bg: "#ff8a00", fg: "#000", blink: true, label: "🐌 !!SLOW CAR!!" },
  soon: { bg: "#ffe600", fg: "#000", label: "On le dépasse" },
  calm: { bg: "#22c55e", fg: "#000", label: "On le dépasse" },
  fast: { bg: "#ff1f1f", fg: "#fff", label: "🚀 !!FAST CAR!!" },
  direct: { bg: "#ff1f1f", fg: "#fff", label: "⚔ CONCURRENT DIRECT" },
  threat: { bg: "#ff8a00", fg: "#000", label: "Il nous dépasse" },
};
function AlertPill({ d }) {
  const st = TRACK_STYLE[d.kind];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 font-sans font-black whitespace-nowrap ${st.blink ? "animate-pulse" : ""}`} style={{ backgroundColor: st.bg, color: st.fg, fontSize: 13 }}>
      {st.label}
      <span className="font-mono tabular-nums">{d.remainingMs <= 1000 ? "MAINTENANT" : fmtCountdown(d.remainingMs)}</span>
    </span>
  );
}

// Contenu du tableau « autour de nous sur la piste » : les voitures devant et derrière nous SUR LA PISTE, avec l'écart exact mesuré au dernier point commun
const fmtAvgMs = (ms) => (ms == null ? "–" : `${Math.floor(ms / 60000)}:${((ms % 60000) / 1000).toFixed(1).padStart(4, "0")}`);
function AroundTable({ data, prio, alerts, myPos, myNum, myTeam, pilot, now, stale, nA, nB, setNA, setNB, cars }) {
  const [openNum, setOpenNum] = useState(null); // voiture dont on affiche le détail des tours (clic sur son équipe)
  const held = useRef({});
  // garde 10 minutes la dernière valeur connue (grisée) quand la mesure disparaît (arrêt, neutralisation…)
  const hold = (id, v) => {
    const h = held.current;
    if (v != null) {
      h[id] = { v, t: now };
      return { v, stale: false };
    }
    const x = h[id];
    return x && now - x.t < 120000 ? { v: x.v, stale: true } : { v: null, stale: false };
  };
  const hasCls = !!data && [...data.ahead, ...data.behind].some((r) => r.cat);
  const cols = { gridTemplateColumns: hasCls ? "2.6rem 3.2rem 4.2rem 2.6rem minmax(7rem,1fr) 6.2rem 8rem 4.6rem 9rem 11rem" : "2.6rem 3.2rem minmax(7rem,1fr) 6.2rem 8rem 4.6rem 9rem 11rem" };
  const fmtAvg = (ms) => (ms == null ? "–" : `${Math.floor(ms / 60000)}:${((ms % 60000) / 1000).toFixed(1).padStart(4, "0")}`);
  // alerte de la piste (règles de trackAlertRows) sur la ligne de la voiture concernée ; sinon simple compte à rebours
  const eta = (n) => {
    const al = (alerts || []).find((x) => x.num === n);
    if (al) return <AlertPill d={al} />;
    const d = (prio || []).find((x) => x.num === n);
    return d ? fmtCountdown(d.remainingMs) : "";
  };
  const gray = { opacity: 0.55, fontStyle: "italic" };
  const trend = (r, tinted) => {
    const { v, stale } = hold(r.num + "t", r.trendMs);
    if (v == null) return <span className={tinted ? "" : "text-white/40"}>–</span>;
    const st = stale ? gray : {};
    if (v < -300) return <span style={{ ...(tinted ? {} : { color: "#38bdf8" }), ...st }}>↘ se rapproche {fmtGapMs(-v)}</span>;
    if (v > 300) return <span className={tinted ? "" : "text-white/60"} style={st}>↗ s'éloigne {fmtGapMs(v)}</span>;
    return <span className={tinted ? "" : "text-white/60"} style={st}>= stable</span>;
  };
  const pace = (r, tinted) => {
    const { v, stale } = hold(r.num + "d", r.deltaMs);
    if (v == null) return <span className={tinted ? "" : "text-white/40"}>–</span>;
    const st = stale ? gray : {};
    const d = v / 1000;
    if (Math.abs(d) < 0.05) return <span style={st}>= même rythme</span>;
    return d < 0 ? <span style={{ ...(tinted ? {} : { color: "#f87171" }), ...st }}>{Math.abs(d).toFixed(1)} s/tr plus vite</span> : <span style={{ ...(tinted ? {} : { color: "#4ade80" }), ...st }}>{d.toFixed(1)} s/tr plus lent</span>;
  };
  // devant nous sur la piste mais derrière au général = vert fluo ; derrière nous sur la piste mais devant au général = rouge
  const tint = (r, key) => (myPos == null ? null : key === "a" && r.pos > myPos ? "green" : key === "b" && r.pos < myPos ? "red" : null);
  const row = (r, key) => {
    const t = tint(r, key);
    const cls = t === "green" ? "text-black bg-[#39ff14] font-bold" : t === "red" ? "text-white bg-red-600 font-bold" : "text-white";
    const sub = t === "green" ? "text-black/70" : "text-white/60";
    return (
      <React.Fragment key={key + r.num}>
      <div className={`grid items-center gap-2 px-2 py-0.5 font-sans border-b border-white/10 ${cls}`} style={{ ...cols, fontSize: 13 }}>
        <span className={sub}>P{r.pos}</span>
        <span className="font-black">#{r.num}</span>
        {hasCls && <span className={`truncate ${t ? "" : "text-white/80"}`}>{r.cat}</span>}
        {hasCls && <span className="font-mono tabular-nums font-black">{r.pic != null ? `${r.pic}e` : ""}</span>}
        <span className="truncate cursor-pointer underline decoration-dotted underline-offset-2" title="Cliquer pour voir ses tours et ses meilleurs temps (S1, S2, S3)" onClick={() => setOpenNum(openNum === r.num ? null : r.num)}>{r.team}</span>
        <span className="font-mono tabular-nums font-black text-right">
          {fmtGapMs(Math.abs(r.gapMs))} <span className={`font-sans font-normal ${t ? "opacity-70" : "text-white/50"}`}>{r.point}</span>
        </span>
        <span>{trend(r, !!t)}</span>
        <span className="font-mono tabular-nums text-right">{fmtAvg(r.avgMs)}</span>
        <span>{pace(r, !!t)}</span>
        <span className="font-mono tabular-nums font-black text-right">{eta(r.num)}</span>
      </div>
      {openNum === r.num && cars && cars[r.num] && <CarLapsDetail c={cars[r.num]} num={r.num} />}
      </React.Fragment>
    );
  };
  const band = (txt, extra) => <div className={`px-2 py-0.5 font-black uppercase tracking-wide text-xs ${extra}`}>{txt}</div>;
  if (!data) return <div className="text-white/70 font-sans text-sm p-2">Pas encore de données : {cars && myNum ? aroundWhyNot(cars, myNum, now) : "il faut quelques tours de notre voiture."}</div>;
  // alertes dont la voiture n'est pas dans les listes affichées
  const shownNums = new Set([...data.ahead, ...data.behind].map((r) => r.num));
  const hidden = (alerts || []).filter((d) => !shownNums.has(d.num));
  const ref = data.ref;
  const refAge = ref ? Math.max(0, Math.round((now - ref.at) / 1000)) : null;
  return (
    <div>
      {hidden.length > 0 && (
        <div className="rounded border border-white/30 bg-black/50 px-2 py-1 mb-1 flex flex-wrap items-center gap-2 text-white font-sans" style={{ fontSize: 13 }}>
          <span className="font-black uppercase">Alertes hors liste</span>
          {hidden.map((d) => (
            <span key={d.num} className="flex items-center gap-1.5">
              <b>P{d.pos} #{d.num}</b>
              <AlertPill d={d} />
            </span>
          ))}
        </div>
      )}
      {ref && (
        <div className="rounded border border-yellow-400/70 bg-black/50 px-2 py-1 mb-1 text-white font-sans text-xs">
          <span className="font-black uppercase text-yellow-300">Chrono pris {ref.point === "Ligne" ? "à la ligne" : `au ${ref.point}`}</span>
          {" · "}notre passage à <b className="font-mono">{new Date(ref.at).toLocaleTimeString("fr-BE")}</b>
          <span className="text-white/60"> (il y a {refAge} s)</span>
        </div>
      )}
      {stale > 0 && (
        <div className="rounded bg-orange-500/20 border border-orange-400/60 px-2 py-1 mb-1 text-orange-200 font-sans text-xs">
          ⚠ Données figées depuis {stale} s (notre voiture est aux stands ou à l'arrêt, ou le flux est interrompu) : le tableau reprend dès le prochain point.
        </div>
      )}
      <div className="px-2 pb-1 text-white font-sans text-xs">
        <span className="font-black uppercase">Notre moyenne</span> : <b className="font-mono">{data.myAvg ? fmtAvg(data.myAvg.ms) : "pas encore calculable"}</b>
        <span className="text-white/60">{data.myAvg ? ` sur ${data.myAvg.n} tours (hors tours > 5 % plus lents que la moyenne)` : " (il faut au moins 3 tours enregistrés depuis l'ouverture de la page)"}</span>
      </div>
      <div className="flex flex-wrap items-center gap-3 px-2 pb-1 text-white font-sans text-xs">
        {[["Devant", nA, setNA], ["Derrière", nB, setNB]].map(([lbl, v, set]) => (
          <label key={lbl} className="flex items-center gap-1">
            <span className="font-black uppercase">{lbl}</span>
            <select value={v} onChange={(e) => set(Number(e.target.value))} className="rounded bg-black/60 border border-white/30 px-1 py-0.5 text-white">
              {[3, 5, 10, 15, 25, 40, 60].map((n) => (
                <option key={n} value={n}>{n} voitures</option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <div className="text-white/60 font-sans text-xs px-2 pb-1">
        Écart mesuré au dernier point (S1, S2 ou ligne) franchi par la voiture et par nous. Estimation = compte à rebours avant le dépassement quand il est prévu.
      </div>
      <div className="grid gap-2 px-2 pb-0.5 text-white/60 font-sans font-black uppercase" style={{ ...cols, fontSize: 12 }}>
        <span>Pos</span><span>N°</span>{hasCls && <span>Classe</span>}{hasCls && <span>PIC</span>}<span>Équipe</span><span className="text-right">Écart</span><span>Tendance</span><span className="text-right">Moy. 10 t.</span><span>Rythme vs nous</span><span className="text-right">Alerte / estim.</span>
      </div>
      {band(`↗ Devant nous (${data.ahead.length})`, "bg-white/10 text-white")}
      {data.ahead.length === 0 && <div className="px-2 py-1 text-white/50 text-xs">Aucune voiture devant sur ce tour</div>}
      {data.ahead.map((r) => row(r, "a"))}
      <div className="grid items-center gap-2 px-2 py-1 font-sans font-black bg-blue-600 text-white" style={{ ...cols, fontSize: 14 }}>
        <span>P{myPos ?? "?"}</span>
        <span>#{myNum}</span>
        {hasCls && <span className="truncate">{data.me ? data.me.cat : ""}</span>}
        {hasCls && <span className="font-mono tabular-nums">{data.me && data.me.pic != null ? `${data.me.pic}e` : ""}</span>}
        <span className="truncate">{pilot || "NOUS"}{pilot && myTeam ? <span className="font-normal opacity-80"> · {myTeam}</span> : null}</span>
        <span />
        <span />
        <span className="font-mono tabular-nums text-right">{data.myAvg ? fmtAvg(data.myAvg.ms) : "–"}</span>
        <span />
        <span />
      </div>
      {band(`↘ Derrière nous (${data.behind.length})`, "bg-white/10 text-white")}
      {data.behind.length === 0 && <div className="px-2 py-1 text-white/50 text-xs">Aucune voiture derrière sur ce tour</div>}
      {data.behind.map((r) => row(r, "b"))}
    </div>
  );
}

// Fenêtre flottante, déplaçable à la souris (barre de titre) ou avec ◀ ▶ : le reste de l'écran reste visible et utilisable derrière
let Z_TOP = 50;
function FloatingPanel({ title, onClose, onPopout, wide, storeKey = "around", startPos, children }) {
  const KEY = "pitboard_win_" + storeKey;
  const [z, setZ] = useState(() => ++Z_TOP);
  const box = useRef(null);
  const drag = useRef(null);
  const [pos, setPos] = useState(() => {
    try {
      const v = JSON.parse(localStorage.getItem(KEY) || "null");
      if (v && Number.isFinite(v.x) && Number.isFinite(v.y)) return v;
    } catch {
      /* stockage indisponible */
    }
    return startPos || { x: 16, y: 72 };
  });
  const save = (p) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(p));
    } catch {
      /* stockage indisponible */
    }
  };
  const clamp = (p) => ({ x: Math.min(Math.max(0, p.x), Math.max(0, window.innerWidth - 140)), y: Math.min(Math.max(0, p.y), Math.max(0, window.innerHeight - 40)) });
  const snap = (side) => {
    const w = box.current ? box.current.offsetWidth : 1000;
    const p = clamp({ x: side === "left" ? 8 : window.innerWidth - w - 8, y: pos.y });
    setPos(p);
    save(p);
  };
  const onDown = (e) => {
    if (e.target.closest("button")) return;
    drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e) => {
    if (drag.current) setPos(clamp({ x: e.clientX - drag.current.dx, y: e.clientY - drag.current.dy }));
  };
  const onUp = () => {
    if (drag.current) save(pos);
    drag.current = null;
  };
  const btn = "rounded border border-white/30 bg-black/40 hover:bg-black/70 px-2 py-0.5 text-white text-xs font-black";
  return (
    <div
      ref={box}
      className="fixed flex flex-col rounded-xl border border-white/30 bg-neutral-900/95 shadow-2xl"
      onPointerDownCapture={() => setZ(++Z_TOP)}
      style={{ zIndex: z, left: pos.x, top: pos.y, width: wide ? "min(1700px, calc(100vw - 100px))" : "min(1000px, calc(100vw - 150px))", maxHeight: "calc(100vh - 16px)", minWidth: wide ? 700 : 420, resize: "both", overflow: "hidden" }}
    >
      <div
        className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-white/10 cursor-move select-none touch-none"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        <span className="text-white font-black uppercase tracking-wide text-sm">{title}</span>
        <span className="flex items-center gap-1">
          <button type="button" className={btn} onClick={() => snap("left")} title="Placer à gauche">◀</button>
          <button type="button" className={btn} onClick={() => snap("right")} title="Placer à droite">▶</button>
          <button type="button" className={btn} onClick={onPopout} title="Ouvrir dans une autre fenêtre du navigateur">↗ Fenêtre séparée</button>
          <button type="button" className={btn} onClick={onClose} title="Fermer">✕</button>
        </span>
      </div>
      <div className="overflow-auto p-2">{children}</div>
    </div>
  );
}

// Fenêtre flottante déplaçable, ou fenêtre séparée du navigateur (par exemple sur un autre écran) : contenu fourni par l'appelant
// filet de sécurité : si un tableau plante, on affiche l'erreur dans la fenêtre au lieu de vider toute l'application
class PanelBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { err: null };
  }
  static getDerivedStateFromError(err) {
    return { err };
  }
  componentDidUpdate(prev) {
    if (this.state.err && prev.stamp !== this.props.stamp && Math.floor(this.props.stamp / 5000) !== Math.floor(prev.stamp / 5000)) this.setState({ err: null }); // nouvel essai toutes les 5 s
  }
  render() {
    if (this.state.err) return <div className="rounded bg-red-500/20 border border-red-400/60 px-2 py-1 text-red-200 font-sans text-xs">Ce tableau a rencontré une erreur ({String(this.state.err && this.state.err.message)}). Nouvel essai automatique dans quelques secondes.</div>;
    return this.props.children;
  }
}

function WindowHost({ title, onClose, wide, storeKey, startPos, children }) {
  const [popup, setPopup] = useState(null); // { w, root } quand la fenêtre séparée est ouverte
  const [msg, setMsg] = useState("");
  useEffect(() => {
    if (!popup) return undefined;
    const id = setInterval(() => {
      if (popup.w.closed) setPopup(null);
    }, 800);
    return () => {
      clearInterval(id);
      try {
        if (!popup.w.closed) popup.w.close();
      } catch {
        /* déjà fermée */
      }
    };
  }, [popup]);
  const openPopup = () => {
    const w = window.open("", "pitboard_" + title.replace(/\W+/g, "_"), `popup=yes,width=${wide ? Math.min(1700, (window.screen && window.screen.availWidth) || 1700) : 1100},height=900,left=0,top=40`);
    if (!w) {
      setMsg("La fenêtre séparée a été bloquée par le navigateur : autorisez les pop-ups pour ce site, puis réessayez.");
      return;
    }
    setMsg("");
    w.document.title = "PitBoard · " + title;
    w.document.head.innerHTML = '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">';
    // styles : adresse de base de l'application (sinon les liens relatifs d'une fenêtre vide ne chargent rien -> page blanche), règles copiées
    // en texte (indépendantes du réseau et du moment du chargement) et liens absolus en renfort pour les feuilles illisibles
    try {
      const base = w.document.createElement("base");
      base.href = document.baseURI;
      w.document.head.appendChild(base);
      let css = "";
      Array.from(document.styleSheets).forEach((sh) => {
        try {
          Array.from(sh.cssRules).forEach((r) => {
            css += r.cssText + "\n";
          });
        } catch {
          /* feuille d'un autre site : on la charge par son lien */
        }
      });
      if (css) {
        const st = w.document.createElement("style");
        st.textContent = css;
        w.document.head.appendChild(st);
      }
      document.querySelectorAll('link[rel="stylesheet"]').forEach((n) => {
        const l = w.document.createElement("link");
        l.rel = "stylesheet";
        l.href = n.href;
        w.document.head.appendChild(l);
      });
    } catch {
      /* au pire, le repli sombre ci-dessous reste lisible */
    }
    w.document.documentElement.style.background = "#171717";
    w.document.body.innerHTML = "";
    w.document.body.className = "bg-neutral-900";
    w.document.body.style.cssText = "margin:0;background:#171717;color:#fff;font-family:'Barlow Condensed','Arial Narrow',Helvetica,Arial,sans-serif";
    const root = w.document.createElement("div");
    w.document.body.appendChild(root);
    setPopup({ w, root });
  };
  if (popup) return createPortal(<div className="bg-neutral-900 p-2 min-h-screen"><PanelBoundary stamp={Date.now()}>{children}</PanelBoundary></div>, popup.root);
  return (
    <FloatingPanel title={title} onClose={onClose} onPopout={openPopup} wide={wide} storeKey={storeKey} startPos={startPos}>
      {msg && <div className="rounded bg-red-500/20 border border-red-400/60 px-2 py-1 mb-1 text-red-200 font-sans text-xs">{msg}</div>}
      <PanelBoundary stamp={Date.now()}>{children}</PanelBoundary>
    </FloatingPanel>
  );
}

// « Autour de nous sur la piste » : les voitures devant et derrière nous sur la piste (contenu, sans fenêtre)
function getLS(k, d) {
  try {
    const v = localStorage.getItem(k);
    return v == null ? d : v;
  } catch {
    return d;
  }
}
function putLS(k, v) {
  try {
    localStorage.setItem(k, String(v));
  } catch {
    /* stockage indisponible */
  }
}
function AroundPane({ compute, prio, alerts, myPos, myNum, myTeam, pilot, now, cars }) {
  const [nA, setNAraw] = useState(() => Number(getLS("pitboard_around_ahead", 25)) || 25);
  const [nB, setNBraw] = useState(() => Number(getLS("pitboard_around_behind", 15)) || 15);
  const setNA = (v) => { setNAraw(v); putLS("pitboard_around_ahead", v); };
  const setNB = (v) => { setNBraw(v); putLS("pitboard_around_behind", v); };
  const data = compute(nA, nB);
  const last = useRef(null);
  if (data) last.current = { data, at: now };
  const shown = data || (last.current && last.current.data) || null; // on garde le dernier tableau valide si le calcul est momentanément impossible
  const stale = !data && last.current ? Math.round((now - last.current.at) / 1000) : 0;
  return <AroundTable data={shown} prio={prio} alerts={alerts} myPos={myPos} myNum={myNum} myTeam={myTeam} pilot={pilot} now={now} stale={stale} nA={nA} nB={nB} setNA={setNA} setNB={setNB} cars={cars} />;
}

// « Sortis des stands » : voitures apparues en « out » des stands, relevées N secondes après notre passage de la ligne
function OutsPane({ getOuts, lapEnd, now }) {
  const [outDelay, setOutDelayRaw] = useState(() => {
    const v = Number(getLS("pitboard_around_outdelay", 15));
    return Number.isFinite(v) && v >= 0 ? v : 15;
  });
  const setOutDelay = (v) => { setOutDelayRaw(v); putLS("pitboard_around_outdelay", v); };
  const outSnap = useRef(null);
  const sinceLine = lapEnd != null ? now - lapEnd : null;
  if (lapEnd != null && sinceLine >= outDelay * 1000 && (!outSnap.current || outSnap.current.lapEnd !== lapEnd || outSnap.current.delay !== outDelay)) outSnap.current = { lapEnd, delay: outDelay, at: now, list: getOuts(lapEnd - 30000) };
  const outs = outSnap.current ? { ...outSnap.current, wait: outSnap.current.lapEnd === lapEnd ? 0 : Math.max(0, Math.ceil((outDelay * 1000 - (sinceLine ?? 0)) / 1000)) } : null;
  return (
    <div className="text-white font-sans" style={{ fontSize: 13 }}>
      <label className="flex flex-wrap items-center gap-1 pb-2 text-white/80">
        Relevé
        <input type="number" min={0} max={120} value={outDelay} onChange={(e) => setOutDelay(Math.max(0, Math.min(120, Number(e.target.value) || 0)))} className="w-16 rounded bg-black/60 border border-white/30 px-1 py-0.5 text-white" />
        s après notre passage de la ligne
      </label>
      {!outs ? (
        <div className="text-white/60">En attente de notre prochain passage de la ligne…</div>
      ) : (
        <>
          <div className="pb-1 flex flex-wrap items-center gap-x-3">
            <span className="font-black uppercase text-sky-300">Sortis des stands {outs.list.length ? `(${outs.list.length})` : ""}</span>
            {outs.wait > 0 && <span className="text-white/60">liste précédente, mise à jour dans {outs.wait} s</span>}
          </div>
          {outs.list.length === 0 && <div className="text-white/60">Aucune voiture sortie des stands</div>}
          {outs.list.map((r) => (
            <div key={r.num} className="flex flex-wrap gap-x-3 py-1 border-t border-white/10">
              <b>#{r.num}</b>
              <span className="text-white/70">P{r.pos}{r.cat ? ` · ${r.cat} ${r.pic}e` : ""}</span>
              <span className="truncate">{r.team}</span>
              <span className="text-white/70">sortie il y a {Math.max(0, Math.round((outs.at - r.at) / 1000))} s</span>
              {r.avgMs != null && <span className="font-mono">moy. {fmtAvgMs(r.avgMs)}</span>}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

// détail d'une voiture (clic sur son nom) : meilleurs temps et derniers tours avec S1 S2 S3, les meilleurs en bleu
function CarLapsDetail({ c, num }) {
  const BLUE = "#5cc8ff";
  const [openDrv, setOpenDrv] = useState(null);
  const laps = carLaps(num); // du plus récent au plus ancien
  // regroupement par pilote (nom donné par le flux au moment du tour)
  const groups = [];
  laps.forEach((h) => {
    const name = h.d || "Pilote ?";
    let g = groups.find((x) => x.name === name);
    if (!g) groups.push((g = { name, laps: [] }));
    g.laps.push(h);
  });
  const mn = (arr) => arr.reduce((m, v) => (v != null && (m == null || v < m) ? v : m), null);
  const best = (lbl, v) => (
    <span>
      {lbl} <b style={{ color: BLUE }}>{v != null ? fmtMs(v) : "–"}</b>
    </span>
  );
  const drvTable = (g) => {
    const bt = mn(g.laps.map((h) => h.lt));
    const b1 = mn(g.laps.map((h) => (h.s ? h.s[0] : null)));
    const b2 = mn(g.laps.map((h) => (h.s ? h.s[1] : null)));
    const b3 = mn(g.laps.map((h) => (h.s ? h.s[2] : null)));
    const bl = (v, bst) => (v != null && bst != null && v <= bst ? { color: BLUE, fontWeight: 800 } : undefined);
    return (
      <div style={{ maxHeight: 240, overflowY: "auto" }}>
        <table className="font-mono tabular-nums">
          <thead className="text-white/50" style={{ position: "sticky", top: 0, background: "#0b0f14" }}>
            <tr>
              <th className="pr-4 text-left font-normal">Tour · passage</th>
              <th className="pr-4 text-right font-normal">S1</th>
              <th className="pr-4 text-right font-normal">S2</th>
              <th className="pr-4 text-right font-normal">S3</th>
              <th className="pr-4 text-right font-normal">Tour</th>
              <th className="pr-4 text-right font-normal" title="Position dans la classe (PIC) à la fin du tour">PIC</th>
              <th className="text-right font-normal" title="Température extérieure">°C</th>
            </tr>
          </thead>
          <tbody>
            {g.laps.map((h, i) => (
              <tr key={h.end + "_" + i}>
                <td className="pr-4 text-white/70 whitespace-nowrap">{h.n != null ? `tr ${h.n} · ` : ""}{new Date(h.end).toLocaleTimeString("fr-BE")}</td>
                <td className="pr-4 text-right" style={h.s ? bl(h.s[0], b1) : undefined}>{h.s ? fmtMs(h.s[0]) : "–"}</td>
                <td className="pr-4 text-right" style={h.s ? bl(h.s[1], b2) : undefined}>{h.s ? fmtMs(h.s[1]) : "–"}</td>
                <td className="pr-4 text-right" style={h.s ? bl(h.s[2], b3) : undefined}>{h.s ? fmtMs(h.s[2]) : "–"}</td>
                <td className="pr-4 text-right" style={bl(h.lt, bt)}>{fmtMs(h.lt)}</td>
                <td className="pr-4 text-right font-bold">{h.pc != null ? `${h.pc}e` : "–"}</td>
                <td className="text-right text-white/60">{h.tp != null ? h.tp.toFixed(1) : "–"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };
  return (
    <div className="rounded bg-black/60 border border-white/20 px-2 py-1.5 my-0.5 font-sans text-[13px] text-white">
      <div className="flex flex-wrap gap-x-4 gap-y-0.5 pb-1">
        <b>#{num} {c.team}</b>
        {best("Meilleur tour", c.best)}
        {best("S1", c.s1b)}
        {best("S2", c.s2b)}
        {best("S3", c.s3b)}
      </div>
      {groups.length === 0 ? (
        <div className="text-white/60">Aucun tour enregistré depuis l'ouverture de la page (il faut attendre le passage de la voiture).</div>
      ) : (
        groups.map((g, gi) => {
          const open = openDrv === g.name || (openDrv == null && gi === 0);
          const bt = mn(g.laps.map((h) => h.lt));
          return (
            <div key={g.name} className="border-t border-white/10 py-0.5">
              <button type="button" onClick={() => setOpenDrv(open ? "__none__" : g.name)} className="w-full flex flex-wrap items-center gap-x-3 text-left font-bold">
                <span>{open ? "▾" : "▸"} {g.name}</span>
                <span className="text-white/60 font-normal">{g.laps.length} tour{g.laps.length > 1 ? "s" : ""}</span>
                <span className="font-normal">meilleur <b style={{ color: BLUE }}>{fmtMs(bt)}</b></span>
              </button>
              {open && drvTable(g)}
            </div>
          );
        })
      )}
      <div className="text-white/50 text-xs pt-1">Bleu = meilleur temps du pilote (tour ou secteur). Tous les tours réalisés depuis l'ouverture de la page, regroupés par pilote.</div>
    </div>
  );
}

// « Classement » : voisins au classement général ou dans la classe, écarts mesurés à chaque point (S1, S2, ligne), gain/perte sur le dernier tronçon
const CL_KEY = "pitboard_classement";
function loadClassement() {
  const d = { mode: "general", nA: 25, nB: 15 };
  try {
    const v = JSON.parse(localStorage.getItem(CL_KEY) || "null");
    if (v) return { mode: v.mode === "cat" ? "cat" : "general", nA: Number(v.nA) > 0 ? Number(v.nA) : 25, nB: Number(v.nB) > 0 ? Number(v.nB) : 15 };
  } catch {
    /* stockage indisponible */
  }
  return d;
}
function ClassementPanel({ cars, num, now, st, setSt, big, inWindow, onWindow, quali, teamNums, bands }) {
  const BLUE = "#5cc8ff";
  const [openNum, setOpenNum] = useState(null); // voiture dont on affiche le détail des tours (clic sur son nom)
  const tcls = "text-[13px]"; // jamais moins de 12 px
  const me = cars[num];
  const cat = st.mode === "cat";
  const eng = me ? aroundOnTrack(cars, num, now, undefined, undefined, st.nA, st.nB, cat ? "pic" : "general") : null;
  let ahead, behind;
  if (eng) {
    ahead = eng.ahead;
    behind = eng.behind;
  } else {
    // repli (notre voiture aux stands, pas assez de tours) : classement du flux, écarts du flux
    const all = neighborsOf(cars, num, 115);
    const cls = classPositions(cars);
    const keep = (r) => !cat || ((cls[r.num] || {}).cat || "") === ((cls[num] || {}).cat || "");
    const mkf = (r) => ({ num: r.num, pos: r.pos, pic: (cls[r.num] || {}).pic ?? null, gapMs: null, point: null, gainMs: null, lapGainMs: lastLapGain(num, r.num) });
    ahead = all ? all.above.filter(keep).slice(-st.nA).map(mkf) : [];
    behind = all ? all.below.filter(keep).slice(0, st.nB).map(mkf) : [];
  }
  const myCls = classPositions(cars)[num] || {};
  const isBest = (v, b) => v != null && b != null && v <= b;
  const hl = (v, b, onMe) => (isBest(v, b) ? { color: onMe ? "#0033cc" : BLUE, fontWeight: 800 } : undefined);
  const colList = [[inWindow ? "2.4rem" : "2rem", cat ? "PIC" : "Pos"], [inWindow ? "minmax(6rem,1fr)" : "minmax(1.5rem,1fr)", "Voiture"]];
  colList.push([inWindow ? "3rem" : "1.7rem", "Tours"]);
  colList.push([inWindow ? "4.2rem" : "3.6rem", "Tour"], [inWindow ? "3rem" : "2.3rem", "S1"], [inWindow ? "3rem" : "2.3rem", "S2"], [inWindow ? "3rem" : "2.3rem", "S3"], [inWindow ? "5.2rem" : "3.4rem", "Écart"], [inWindow ? "3.4rem" : "2.5rem", "Gain"], [inWindow ? "4.4rem" : "3rem", "Σ tour"], [inWindow ? "6rem" : "4.6rem", "Sortie stand"]);
  const cols = { gridTemplateColumns: colList.map((c) => c[0]).join(" ") };
  const rowCls = `grid items-center gap-x-1.5 font-mono whitespace-nowrap ${tcls}`;
  const gapCell = (r, isAhead) => {
    const c = cars[r.num] || {};
    const laps = isAhead ? (me.gll || 0) - (c.gll || 0) : (c.gll || 0) - (me.gll || 0);
    if (laps > 0) return `${laps} tr`;
    if (r.gapMs != null) return (
      <>
        {fmtGapMs(Math.abs(r.gapMs))} <span className="text-white/40 font-sans">{r.point === "Ligne" ? "L" : r.point}</span>
      </>
    );
    if (me.gl != null && c.gl != null) return fmtGapMs(Math.max(0, isAhead ? me.gl - c.gl : c.gl - me.gl));
    return "–";
  };
  const held = useRef({});
  const hold = (id, v) => {
    const h = held.current;
    if (v != null) {
      h[id] = { v, t: now };
      return { v, stale: false };
    }
    const x = h[id];
    return x && now - x.t < 600000 ? { v: x.v, stale: true } : { v: null, stale: false };
  };
  const gainCell = (r, key = "gainMs") => {
    const { v, stale } = hold(r.num + key, r[key]);
    if (v == null) return <span className="text-white/30">–</span>;
    const g = v / 1000;
    const sty = stale ? { opacity: 0.5, fontStyle: "italic" } : undefined;
    if (Math.abs(g) < 0.05) return <span className="rounded px-1 bg-white/20 text-white font-black" style={sty}>0.0</span>;
    return g > 0 ? <span className="rounded px-1 bg-green-600 text-white font-black" style={sty}>+{g.toFixed(1)}</span> : <span className="rounded px-1 bg-red-600 text-white font-black" style={sty}>−{Math.abs(g).toFixed(1)}</span>;
  };
  const line = (r, isAhead, isMe) => {
    const c = isMe ? me : cars[r.num] || {};
    const id = isMe ? num : r.num;
    const isTeam = !isMe && Array.isArray(teamNums) && teamNums.includes(normalizeCarNumber(r.num)); // autre voiture de la team : écriture orange
    // poste Admin : chaque voiture de la team a un bandeau à ses couleurs (le team manager garde bandeau jaune + écriture orange)
    const band = bands ? bands[normalizeCarNumber(isMe ? num : r.num)] : null;
    const lightBg = band ? band.fg === "#111" : isMe;
    const rowStyle = band
      ? { ...cols, color: band.fg, backgroundColor: band.bg, borderLeft: `6px solid ${band.edge}`, borderRadius: 4, ...(isMe ? { boxShadow: "inset 0 0 0 2px #fff" } : {}) }
      : isMe ? { ...cols, color: "#000", backgroundColor: "#ffe600" } : isTeam ? { ...cols, color: "#ff9500" } : cols;
    return (
      <React.Fragment key={id}>
      <div className={`${rowCls} px-1 py-0.5 ${isMe || band ? "rounded font-black" : isTeam ? "font-black" : "text-white"}`} style={rowStyle}>
        <span>{cat ? (r.pic != null ? `${r.pic}e` : "") : `P${c.pos}`}</span>
        <span className="truncate font-sans cursor-pointer underline decoration-dotted underline-offset-2" title="Cliquer pour voir ses tours et ses meilleurs temps (S1, S2, S3)" onClick={() => setOpenNum(openNum === id ? null : id)}>
          #{isMe ? num : r.num} {c.team}
          {cat ? ` · P${c.pos}` : ""}
        </span>
        <span>{c.laps ?? "–"}</span>
        <span style={hl(c.last, c.best, lightBg)}>{fmtMs(c.last)}</span>
        <span style={hl(c.s1, c.s1b, lightBg)}>{fmtSec1(c.s1)}</span>
        <span style={hl(c.s2, c.s2b, lightBg)}>{fmtSec1(c.s2)}</span>
        <span style={hl(c.s3, c.s3b, lightBg)}>{fmtSec1(c.s3)}</span>
        <span className="text-right">{isMe ? "" : <>{isAhead ? "▲ " : "▼ "}{gapCell(r, isAhead)}</>}</span>
        <span className="text-right">{isMe ? (quali ? gainBadge(selfSectorGaps(me).last) : "") : gainCell(r)}</span>
        <span className="text-right border-l-2 border-white/50 pl-1.5">{isMe ? (quali ? gainBadge(selfSectorGaps(me).sum) : "") : gainCell(r, "lapGainMs")}</span>
        <span className="text-right border-l-2 border-white/50 pl-1.5" title="Temps écoulé depuis la dernière sortie des stands (chronomètre)">
          {(() => {
            const pi = pitExitInfo(isMe ? num : r.num);
            if (!pi) return <span className="text-white/30">–</span>;
            if (pi.inPit) return <span className="text-white/40 font-sans">au stand</span>;
            return fmtTimeHMS(Math.max(0, Math.round((now - pi.at) / 1000)));
          })()}
        </span>
      </div>
      {openNum === id && <CarLapsDetail c={c} num={id} cols={cols} />}
      </React.Fragment>
    );
  };
  const chip = (id, label) => (
    <button key={id} type="button" onClick={() => setSt({ mode: id })} className={`rounded px-1.5 py-0.5 font-black border ${st.mode === id ? "bg-yellow-400 text-black border-yellow-400" : "bg-black/40 text-white border-white/30"}`}>
      {label}
    </button>
  );
  const sel = (lbl, v, key) => (
    <label key={key} className="flex items-center gap-1">
      <span className="uppercase text-white/60">{lbl}</span>
      <select value={v} onChange={(e) => setSt({ [key]: Number(e.target.value) })} className="rounded bg-black/60 border border-white/30 px-0.5 py-0 text-white">
        {[3, 5, 10, 15, 25, 40, 60, 80, 115].map((n) => (
          <option key={n} value={n}>{n}</option>
        ))}
      </select>
    </label>
  );
  return (
    <div className="flex flex-col gap-0.5 pt-1 border-t border-white/10">
      <div className={`flex flex-wrap items-center gap-x-2 gap-y-1 pb-1 font-sans ${tcls}`}>
        {chip("general", "Général")}
        {chip("cat", `Catégorie${myCls.cat ? " " + myCls.cat : ""}`)}
        {sel("Devant", st.nA, "nA")}
        {sel("Derrière", st.nB, "nB")}
      </div>
      <div className={`${rowCls} px-1 text-white/60 uppercase`} style={cols}>
        {colList.map((c, i) => (
          <span key={i} className={c[1] === "Écart" || c[1] === "Gain" ? "text-right" : c[1] === "Σ tour" || c[1] === "Sortie stand" ? "text-right border-l-2 border-white/50 pl-1.5" : ""} title={c[1] === "Σ tour" ? "Gain ou perte cumulé S1 + S2 + S3 sur le tour en cours (tour complet une fois la ligne franchie)" : c[1] === "Sortie stand" ? "Chronomètre : temps écoulé depuis la dernière sortie des stands" : undefined}>{c[1]}</span>
        ))}
      </div>
      {ahead.map((r) => line(r, true, false))}
      {me && line({ num, pic: myCls.pic }, false, true)}
      {behind.map((r) => line(r, false, false))}
      {inWindow && (
        <div className="text-white/50 font-sans text-xs pt-1">
          Écart mesuré à chaque point (S1, S2, L = ligne) franchi par la voiture et par nous. Gain : temps pris (vert +) ou perdu (rouge −) sur la voiture dans le dernier tronçon. Σ tour : cumul S1 + S2 + S3 en direct, donc le total sur le tour complet une fois la ligne franchie. Sortie stand : chronomètre depuis la dernière sortie des stands (le relais en cours de la voiture).
        </div>
      )}
    </div>
  );
}

// bandeau aux couleurs d'une voiture de la team : fond = couleur 1, texte noir ou blanc selon la clarté, liseré = couleur 2
function carBand(car) {
  const hex = (/^#[0-9a-f]{6}$/i.test(car.couleur1 || "") ? car.couleur1 : "#444444").slice(1);
  const lum = (parseInt(hex.slice(0, 2), 16) * 299 + parseInt(hex.slice(2, 4), 16) * 587 + parseInt(hex.slice(4, 6), 16) * 114) / 1000;
  return { bg: "#" + hex, fg: lum > 150 ? "#111" : "#fff", edge: /^#[0-9a-f]{6}$/i.test(car.couleur2 || "") ? car.couleur2 : "#ffffff" };
}
// « Classement » du poste Admin : une voiture en particulier (même tableau que le team manager, avec Gain et Σ tour),
// toutes les voitures de la team, ou toutes les voitures de la course (sans Gain ni Σ : il n'y a pas de voiture de référence)
const ADMCL_KEY = "pitboard_adminclass";
function loadAdminCl() {
  const d = { sel: "team", mode: "general", nA: 10, nB: 10 };
  try {
    const v = JSON.parse(localStorage.getItem(ADMCL_KEY) || "null");
    if (v) return { sel: typeof v.sel === "string" && v.sel ? v.sel : "team", mode: v.mode === "cat" ? "cat" : "general", nA: Number(v.nA) > 0 ? Number(v.nA) : 10, nB: Number(v.nB) > 0 ? Number(v.nB) : 10 };
  } catch {
    /* stockage indisponible */
  }
  return d;
}
function AdminClassement({ cars, now, teamCars, st, setSt, quali }) {
  const BLUE = "#5cc8ff";
  const [openNum, setOpenNum] = useState(null);
  const bands = useMemo(() => {
    const m = {};
    teamCars.forEach((c) => {
      m[normalizeCarNumber(c.numero)] = carBand(c);
    });
    return m;
  }, [teamCars]);
  const cls = classPositions(cars);
  const selNum = st.sel.startsWith("car:") ? st.sel.slice(4) : null;
  const teamKeys = teamCars.map((c) => normalizeCarNumber(c.numero));
  const others = Object.keys(cars)
    .filter((n) => !teamKeys.includes(n))
    .sort((a, b) => (cars[a].pos || 9999) - (cars[b].pos || 9999));
  const select = (
    <select value={st.sel} onChange={(e) => setSt({ sel: e.target.value })} className="rounded bg-black/60 border border-white/30 px-1 py-0.5 text-white font-black" title="Voiture(s) à afficher">
      <option value="team">Toutes les voitures de la team</option>
      <option value="all">Toutes les voitures de la course</option>
      <optgroup label="Une voiture de la team en particulier">
        {teamCars.map((c) => (
          <option key={c.id} value={"car:" + normalizeCarNumber(c.numero)}>#{c.numero} {c.team || c.pilote || ""}</option>
        ))}
      </optgroup>
      {others.length > 0 && (
        <optgroup label="Une autre voiture en particulier">
          {others.map((n) => (
            <option key={n} value={"car:" + n}>#{n} {cars[n].team || ""}</option>
          ))}
        </optgroup>
      )}
    </select>
  );
  if (selNum) {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2 font-sans text-[13px] text-white">{select}</div>
        {cars[selNum] ? (
          <ClassementPanel cars={cars} num={selNum} now={now} st={st} setSt={setSt} big inWindow quali={quali} teamNums={teamKeys} bands={bands} />
        ) : (
          <div className="text-white/60 font-sans text-sm p-2">La voiture #{selNum} n'est pas (ou plus) dans le flux RIS.</div>
        )}
      </div>
    );
  }
  const cat = st.mode === "cat";
  const rows = Object.keys(cars)
    .filter((n) => st.sel === "all" || bands[n])
    .map((n) => ({ n, c: cars[n], k: cls[n] || {} }));
  rows.sort(cat
    ? (a, b) => String(a.k.cat || "").localeCompare(String(b.k.cat || "")) || (a.k.pic ?? 9999) - (b.k.pic ?? 9999)
    : (a, b) => (a.c.pos || 9999) - (b.c.pos || 9999));
  const colList = [["2.6rem", "Pos"], ["3.6rem", "PIC"], ["minmax(6rem,1fr)", "Voiture"], ["3rem", "Tours"], ["4.2rem", "Tour"], ["3rem", "S1"], ["3rem", "S2"], ["3rem", "S3"], ["6rem", "Sortie stand"]];
  const cols = { gridTemplateColumns: colList.map((c) => c[0]).join(" ") };
  const rowCls = "grid items-center gap-x-1.5 font-mono whitespace-nowrap text-[13px]";
  const isBest = (v, b) => v != null && b != null && v <= b;
  const hl = (v, b, light) => (isBest(v, b) ? { color: light ? "#0033cc" : BLUE, fontWeight: 800 } : undefined);
  const chip = (id, label) => (
    <button key={id} type="button" onClick={() => setSt({ mode: id })} className={`rounded px-1.5 py-0.5 font-black border ${st.mode === id ? "bg-yellow-400 text-black border-yellow-400" : "bg-black/40 text-white border-white/30"}`}>
      {label}
    </button>
  );
  let lastCat = null;
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pb-1 font-sans text-[13px] text-white">
        {select}
        {chip("general", "Général")}
        {chip("cat", "Catégorie (PIC)")}
        <span className="text-white/50 text-xs">Gain et somme du tour : choisir une voiture en particulier.</span>
      </div>
      <div className={`${rowCls} px-1 text-white/60 uppercase`} style={cols}>
        {colList.map((c, i) => (
          <span key={i} className={c[1] === "Sortie stand" ? "text-right border-l-2 border-white/50 pl-1.5" : ""}>{c[1]}</span>
        ))}
      </div>
      {rows.length === 0 && <div className="text-white/60 font-sans text-sm p-2">Aucune voiture à afficher dans le flux RIS.</div>}
      {rows.map(({ n, c, k }) => {
        const band = bands[n];
        const light = band ? band.fg === "#111" : false;
        const head = cat && k.cat !== lastCat ? (lastCat = k.cat, <div key={"h" + n} className="font-sans text-xs uppercase text-white/60 pt-1">Catégorie {k.cat || "?"}</div>) : null;
        const pi = pitExitInfo(n);
        return (
          <React.Fragment key={n}>
            {head}
            <div className={`${rowCls} px-1 py-0.5 ${band ? "rounded font-black" : "text-white"}`} style={band ? { ...cols, color: band.fg, backgroundColor: band.bg, borderLeft: `6px solid ${band.edge}`, borderRadius: 4 } : cols}>
              <span>P{c.pos ?? "–"}</span>
              <span>{k.pic != null ? `${k.pic}e` : ""}{k.cat ? <span className="font-sans text-[10px] opacity-70"> {k.cat}</span> : null}</span>
              <span className="truncate font-sans cursor-pointer underline decoration-dotted underline-offset-2" title="Cliquer pour voir ses tours et ses meilleurs temps (S1, S2, S3)" onClick={() => setOpenNum(openNum === n ? null : n)}>#{n} {c.team}</span>
              <span>{c.laps ?? "–"}</span>
              <span style={hl(c.last, c.best, light)}>{fmtMs(c.last)}</span>
              <span style={hl(c.s1, c.s1b, light)}>{fmtSec1(c.s1)}</span>
              <span style={hl(c.s2, c.s2b, light)}>{fmtSec1(c.s2)}</span>
              <span style={hl(c.s3, c.s3b, light)}>{fmtSec1(c.s3)}</span>
              <span className="text-right border-l-2 border-white/50 pl-1.5">
                {!pi ? <span className="opacity-40">–</span> : pi.inPit ? <span className="opacity-60 font-sans">au stand</span> : fmtTimeHMS(Math.max(0, Math.round((now - pi.at) / 1000)))}
              </span>
            </div>
            {openNum === n && <CarLapsDetail c={c} num={n} cols={cols} />}
          </React.Fragment>
        );
      })}
    </div>
  );
}

// bloc "live" d'une tuile : temps de course, tour, intermédiaires, puis (si showTable) le classement
// avec les 3 voitures devant et les 3 derrière, leurs intermédiaires et leur écart avec nous
// qualification / essais : écart de notre voiture à ses meilleurs secteurs de la séance (flux RIS) : gain = meilleur - actuel (> 0 : plus rapide)
function selfSectorGaps(c) {
  const g = [1, 2, 3].map((k) => (c && c["s" + k] != null && c["s" + k + "b"] != null ? c["s" + k + "b"] - c["s" + k] : null));
  const have = g.filter((v) => v != null);
  const sum = have.length ? have.reduce((x, y) => x + y, 0) : null;
  let last = null;
  for (let i = 2; i >= 0; i--) if (g[i] != null) { last = g[i]; break; }
  return { g, sum, last };
}
// pastille verte (plus rapide que notre meilleur) / rouge (plus lent), comme la colonne Gain
function gainBadge(ms) {
  if (ms == null) return <span className="text-white/30">–</span>;
  const v = ms / 1000;
  if (Math.abs(v) < 0.05) return <span className="rounded px-1 bg-white/20 text-white font-black">0.0</span>;
  return v > 0 ? <span className="rounded px-1 bg-green-600 text-white font-black">+{v.toFixed(1)}</span> : <span className="rounded px-1 bg-red-600 text-white font-black">−{Math.abs(v).toFixed(1)}</span>;
}

function LiveBlock({ info, live, num, now, showTable, driverBest, pilot = "", part = "all", big = false }) {
  const [wins, setWins] = useState({ cl: false, ar: false, ou: false }); // 3 fenêtres flottantes indépendantes
  const [cl, setClRaw] = useState(loadClassement); // réglages du tableau « Classement » (mémorisés sur l'appareil)
  const setCl = (patch) =>
    setClRaw((p) => {
      const n = { ...p, ...patch };
      try {
        localStorage.setItem(CL_KEY, JSON.stringify(n));
      } catch {
        /* stockage indisponible */
      }
      return n;
    });
  if (!live) return null;
  const clock = clockNow(info, now);
  const nb = showTable && part !== "main" && part !== "alerts" ? neighborsOf(info.cars, num, 3) : null;
  // estimation des dépassements : voisins calculés même si le tableau est replié
  updatePace(info.cars);
  const remMs = clock && clock.remainingSec != null ? clock.remainingSec * 1000 : null;
  // priorité : toutes les voitures proches SUR LA PISTE (heures de passage du flux) ; repli : voisins du classement
  const duel = duelEstimatesTrack(info.cars, num, remMs, undefined, undefined, now) || duelEstimates(nb || neighborsOf(info.cars, num, 3), remMs);
  const prio = duel && duel.onTrack ? prioritizedDuels(duel, now) : [];
  const trackRows = trackAlertRows(prio, live.pos);
  const BLUE = "#5cc8ff"; // meilleurs temps et intermédiaires (bleu clair, bien distinct du fond)
  const tcls = big ? "text-[11px]" : "text-[10px]";
  const isBest = (v, b) => v != null && b != null && v <= b;
  const sec = (v, b) => (
    <span style={isBest(v, b) ? { color: BLUE, fontWeight: 800 } : undefined} className={isBest(v, b) ? "" : "text-white"}>
      {fmtMs(v)}
    </span>
  );
  const toggleWin = (k) => setWins((w) => ({ ...w, [k]: !w[k] }));
  const winBtn = "rounded border border-white/40 bg-black/40 hover:bg-black/60 px-2 py-1 text-white font-black uppercase tracking-wide whitespace-nowrap font-sans";
  const myCarLive = info.cars[num];
  const closeWin = (k) => () => setWins((w) => ({ ...w, [k]: false }));
  const windowsEl = createPortal(
    <>
      {wins.cl && (
        <WindowHost title="Classement" storeKey="cl" wide startPos={{ x: 16, y: 72 }} onClose={closeWin("cl")}>
          <ClassementPanel cars={info.cars} num={num} now={now} st={cl} setSt={setCl} big inWindow quali={!!info.quali} teamNums={info.teamNums} />
        </WindowHost>
      )}
      {wins.ar && (
        <WindowHost title="Autour de nous sur la piste" storeKey="ar" startPos={{ x: 70, y: 110 }} wide onClose={closeWin("ar")}>
          <AroundPane
            compute={(na, nb2) => aroundOnTrack(info.cars, num, now, undefined, undefined, na, nb2)}
            prio={prio}
            alerts={trackRows}
            myPos={live.pos}
            myNum={num}
            myTeam={myCarLive ? myCarLive.team : ""}
            pilot={pilot}
            now={now}
            cars={info.cars}
          />
        </WindowHost>
      )}
      {wins.ou && (
        <WindowHost title="Sortis des stands" storeKey="ou" startPos={{ x: 120, y: 150 }} onClose={closeWin("ou")}>
          <OutsPane getOuts={(since) => pitOutCars(info.cars, num, since)} lapEnd={myCarLive ? myCarLive.lapEnd : null} now={now} />
        </WindowHost>
      )}
    </>,
    document.body
  );
  const tableEl = nb ? (
    <>
      <div className="flex flex-wrap gap-1.5">
        <button type="button" onClick={() => toggleWin("cl")} className={winBtn} title="Classement général ou par catégorie, dans une fenêtre déplaçable ou séparée">☰ Classement</button>
        <button type="button" onClick={() => toggleWin("ar")} className={winBtn} title="Voitures autour de nous sur la piste, dans une fenêtre déplaçable ou séparée">☰ Autour de nous</button>
        <button type="button" onClick={() => toggleWin("ou")} className={winBtn} title="Voitures sorties des stands, dans une fenêtre déplaçable ou séparée">☰ Sortis des stands</button>
        <button type="button" onClick={() => setWins({ cl: true, ar: true, ou: true })} className={winBtn} title="Ouvrir les 3 fenêtres">▦ Les 3</button>
      </div>
      {windowsEl}
    </>
  ) : null;
  if (part === "alerts") return null; // les alertes sont dans « Autour de nous sur la piste »
  if (part === "table")
    return nb ? (
      <div className={`rounded bg-black/80 px-2 py-1.5 flex flex-col gap-1 font-mono text-white ${tcls}`}>
        {tableEl}
      </div>
    ) : null;
  return (
    <div className="rounded bg-black/40 px-2 py-1.5 flex flex-col gap-1 text-[10px] font-mono text-white/80">
      {part !== "alerts" && (
        <>
      {clock && (
        <div className="flex items-center justify-between gap-2">
          <span>
            ⏱ Écoulé <b className="text-white">{clock.elapsedSec != null ? fmtTimeHMS(clock.elapsedSec) : "–"}</b>
          </span>
          <span>
            Restant <b className="text-white">{clock.remainingSec != null ? fmtTimeHMS(clock.remainingSec) : "–"}</b>
          </span>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
        <span>
          P<b className="text-white">{live.pos || "-"}</b>
          {nb ? `/${nb.total}` : ""}
        </span>
        {live.laps != null && (
          <span>
            Tour <b className="text-white">{live.laps}</b>
          </span>
        )}
        <span>Dernier {fmtMs(live.last)}</span>
        <span>
          Meilleur <b style={{ color: BLUE }}>{fmtMs(live.best)}</b>
        </span>
        {live.pits != null && <span>Arrêts {live.pits}</span>}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
        <span>
          S1 {sec(live.s1, live.s1b)} <span style={{ color: BLUE }}>({fmtMs(live.s1b)})</span>
        </span>
        <span>
          S2 {sec(live.s2, live.s2b)} <span style={{ color: BLUE }}>({fmtMs(live.s2b)})</span>
        </span>
        <span>
          S3 {sec(live.s3, live.s3b)} <span style={{ color: BLUE }}>({fmtMs(live.s3b)})</span>
        </span>
      </div>
      {info.quali && (() => {
        const sg = selfSectorGaps(live);
        return (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5" title="Écart de chaque secteur de notre voiture à son meilleur secteur de la séance : vert = plus rapide, rouge = plus lent">
            <span className="text-white/60">vs meilleur</span>
            <span>S1 {gainBadge(sg.g[0])}</span>
            <span>S2 {gainBadge(sg.g[1])}</span>
            <span>S3 {gainBadge(sg.g[2])}</span>
            <span>Σ {gainBadge(sg.sum)}</span>
          </div>
        );
      })()}
      {driverBest && (() => {
        // secours : si le poste Admin n'a rien enregistré, meilleurs temps des tours vus sur cet écran
        let bestShown = driverBest.best && (driverBest.best.lap || driverBest.best.s1 || driverBest.best.s2 || driverBest.best.s3) ? driverBest.best : null;
        let localNote = false;
        if (!bestShown) {
          const lr = localLapRows(num);
          const mn = (k) => lr.reduce((m, r) => (r[k] != null && (m == null || r[k] < m) ? r[k] : m), null);
          if (lr.length > 0) {
            bestShown = { lap: mn("total"), s1: mn("s1"), s2: mn("s2"), s3: mn("s3") };
            localNote = true;
          }
        }
        driverBest = { ...driverBest, best: bestShown, localNote };
        return null;
      })()}
      {driverBest && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-t border-white/10 pt-1">
          <span className="text-white">Pilote {driverBest.name || "?"} :{driverBest.localNote && <span className="text-white/40 text-[9px]"> (vu sur cet écran)</span>}</span>
          {driverBest.best && (driverBest.best.lap || driverBest.best.s1 || driverBest.best.s2 || driverBest.best.s3) ? (
            <>
              <span>
                Meilleur tour <b style={{ color: BLUE }}>{fmtMs(driverBest.best.lap)}</b>
              </span>
              <span>
                S1 <b style={{ color: BLUE }}>{fmtMs(driverBest.best.s1)}</b>
              </span>
              <span>
                S2 <b style={{ color: BLUE }}>{fmtMs(driverBest.best.s2)}</b>
              </span>
              <span>
                S3 <b style={{ color: BLUE }}>{fmtMs(driverBest.best.s3)}</b>
              </span>
            </>
          ) : (
            <span className="text-white/40">pas encore de temps enregistré</span>
          )}
        </div>
      )}
        </>
      )}
      {nb && part === "all" && tableEl}
    </div>
  );
}

// bandeau de la tuile : pilote du relais, confirmation, temps de roulage cumulé (vert / jaune)
function DriverStrip({ ds, canEdit, onSet, hideTotals }) {
  const [changing, setChanging] = useState(false);
  const { cfg, n, onTrack, cur, curDriver, prevId, totals } = ds;
  const tot = curDriver ? totals[curDriver.id] : null;
  const choices = cfg.list.filter((d) => !d.absent || d.id === cur.id);
  const btn = "px-2 py-0.5 rounded font-bold text-[10px]";
  return (
    <div className="rounded bg-white/5 px-2 py-1.5 flex flex-col gap-1 text-[11px]">
      <div className="flex items-center justify-between gap-2">
        <span className="font-black text-white truncate rounded px-1" style={curDriver && !cur.confirmed ? { animation: "pbblink 1s infinite" } : undefined}>
          {curDriver ? driverName(curDriver) || "Pilote sans nom" : "Aucun pilote disponible"}
        </span>
        <span className="text-white/50 text-[10px] whitespace-nowrap">
          Relais {n} {onTrack ? "en cours" : "à venir"}
        </span>
      </div>
      {tot && !hideTotals && (
        <div className="font-mono text-white/80">
          Roulage {fmtTimeHMS(tot.total)}{" "}
          <span className="text-white/50">
            🟢{fmtTimeHMS(tot.vert)} 🟡{fmtTimeHMS(tot.jaune)}
            {tot.rouge >= 5 && <> 🔴{fmtTimeHMS(tot.rouge)}</>}
          </span>
          <span className="text-white/40"> · {tot.relays} relais</span>
        </div>
      )}
      {curDriver && !changing && (
        <div className="flex items-center gap-1.5 flex-wrap">
          {cur.confirmed ? (
            <span className="text-green-400 font-bold">✓ Confirmé</span>
          ) : (
            <span className="text-amber-400 font-bold rounded px-1" style={{ animation: "pbblink 1s infinite" }}>Pilote prévu, à confirmer</span>
          )}
          {canEdit && !cur.confirmed && (
            <button
              type="button"
              onClick={() => onSet(n, cur.id)}
              className={`${btn} bg-green-600 text-white`}
            >
              Confirmer
            </button>
          )}
          {canEdit && (
            <button type="button" onClick={() => setChanging(true)} className={`${btn} bg-white/15 text-white`}>
              Changer
            </button>
          )}
        </div>
      )}
      {changing && (
        <div className="flex items-center gap-1.5">
          <select
            autoFocus
            value=""
            onChange={(e) => {
              if (e.target.value) onSet(n, e.target.value);
              setChanging(false);
            }}
            className="flex-1 min-w-0 px-1 py-0.5 text-[11px] rounded bg-black/60 text-white border border-white/30"
          >
            <option value="">Pilote du relais {n}…</option>
            {choices.map((d) => (
              <option key={d.id} value={d.id}>
                {driverName(d) || "Pilote sans nom"}
                {d.id === prevId ? " (double relais)" : ""}
              </option>
            ))}
          </select>
          <button type="button" onClick={() => setChanging(false)} className={`${btn} bg-white/15 text-white`}>
            Annuler
          </button>
        </div>
      )}
    </div>
  );
}

// configuration des pilotes d'une voiture (carte "Configuration des voitures")
function DriversEditor({ cfg, currentN, drivenN, canEdit, onChange }) {
  const inputCls =
    "min-w-0 flex-1 px-2 py-1 text-sm rounded bg-black/50 text-white placeholder-white/40 border border-white/20 focus:outline-none focus:border-white disabled:opacity-50";
  const smallBtn =
    "px-1.5 py-0.5 rounded text-[11px] font-bold bg-white/15 text-white disabled:opacity-30";
  const relayNumbers = Array.from({ length: currentN }, (_, i) => currentN - i); // le plus récent en haut
  return (
    <div className="flex flex-col gap-1.5 border-t border-white/15 pt-1.5">
      <div className="text-white/60 text-[10px] uppercase tracking-widest font-semibold">
        Pilotes ({cfg.list.length}/{MAX_DRIVERS}) — dans l'ordre de passage
      </div>
      {cfg.list.length === 1 && (
        <div className="text-amber-400 text-[10px]">Renseignez au moins {MIN_DRIVERS} pilotes.</div>
      )}
      {cfg.list.map((d, i) => {
        const locked = driverHasRelays(cfg, drivenN, d.id);
        return (
          <div key={d.id} className="flex flex-col gap-1 rounded bg-white/5 p-1.5">
            <div className="flex items-center gap-1">
              <span className="text-white/50 text-[11px] w-4 text-right">{i + 1}</span>
              <DraftInput
                value={d.prenom}
                placeholder="Prénom"
                disabled={!canEdit}
                className={inputCls}
                onCommit={(v) => onChange(updateDriver(cfg, d.id, { prenom: v.trim() }))}
              />
              <DraftInput
                value={d.nom}
                placeholder="Nom"
                disabled={!canEdit}
                className={inputCls}
                onCommit={(v) => onChange(updateDriver(cfg, d.id, { nom: v.trim() }))}
              />
            </div>
            <div className="flex items-center gap-1.5 pl-5 flex-wrap">
              <button
                type="button"
                disabled={!canEdit || i === 0}
                onClick={() => onChange(moveDriver(cfg, d.id, -1))}
                className={smallBtn}
                title="Passer plus tôt dans l'ordre"
              >
                ↑
              </button>
              <button
                type="button"
                disabled={!canEdit || i === cfg.list.length - 1}
                onClick={() => onChange(moveDriver(cfg, d.id, 1))}
                className={smallBtn}
                title="Passer plus tard dans l'ordre"
              >
                ↓
              </button>
              <label
                className="flex items-center gap-1 text-white/70 text-[11px]"
                title="Malade, blessé… : il est sauté dans l'ordre de passage"
              >
                <input
                  type="checkbox"
                  disabled={!canEdit}
                  checked={!!d.absent}
                  onChange={(e) => onChange(updateDriver(cfg, d.id, { absent: e.target.checked }))}
                />
                Indisponible
              </label>
              <button
                type="button"
                disabled={!canEdit || locked}
                onClick={() => onChange({ ...cfg, list: cfg.list.filter((x) => x.id !== d.id) })}
                className={`${smallBtn} ml-auto`}
                title={locked ? "A déjà roulé : marquez-le indisponible plutôt que le supprimer" : "Supprimer ce pilote"}
              >
                <X size={11} />
              </button>
            </div>
          </div>
        );
      })}
      {cfg.list.length < MAX_DRIVERS && (
        <button
          type="button"
          disabled={!canEdit}
          onClick={() => onChange(addDriver(cfg))}
          className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-bold bg-white/15 text-white self-start disabled:opacity-40"
        >
          <Plus size={11} /> Ajouter un pilote
        </button>
      )}
      {cfg.list.length > 0 && (
        <>
          <div className="text-white/60 text-[10px] uppercase tracking-widest font-semibold mt-1">
            Pilote de chaque relais
          </div>
          <div className="flex flex-col gap-1 max-h-40 overflow-y-auto pr-1">
            {relayNumbers.map((n) => {
              const r = resolveRelay(cfg, n);
              return (
                <div key={n} className="flex items-center gap-1.5 text-[11px] text-white/80">
                  <span className="w-14 shrink-0">Relais {n}</span>
                  <select
                    disabled={!canEdit}
                    value={r.id || ""}
                    onChange={(e) => e.target.value && onChange(setRelayDriver(cfg, n, e.target.value))}
                    className="flex-1 min-w-0 px-1 py-0.5 rounded bg-black/60 text-white border border-white/30 disabled:opacity-50"
                  >
                    {!r.id && <option value="">—</option>}
                    {cfg.list.map((d) => (
                      <option key={d.id} value={d.id}>
                        {driverName(d) || "Pilote sans nom"}
                        {d.absent ? " (indisp.)" : ""}
                      </option>
                    ))}
                  </select>
                  <span className={r.confirmed ? "text-green-400" : "text-amber-400"} title={r.confirmed ? "Confirmé" : "Prévu, à confirmer"}>
                    {r.confirmed ? "✓" : "?"}
                  </span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

export default function PitBoard() {
  // code d'accès partagé (avant même le choix du rôle) : empêche qu'une personne tombe
  // sur le lien "par hasard" ou le partage sans réfléchir. Configuré via VITE_ACCESS_CODE
  // dans .env — pas une vraie sécurité (le code source reste lisible sur GitHub), mais
  // suffisant pour un usage interne d'équipe comme convenu.
  const ACCESS_CODE = import.meta.env.VITE_ACCESS_CODE || "";
  const [accessGranted, setAccessGranted] = useState(() => {
    if (!ACCESS_CODE) return true; // si aucun code n'est configuré, l'écran est simplement désactivé
    try {
      return localStorage.getItem("pitboard_access_ok") === "1";
    } catch (e) {
      return false;
    }
  });
  const [accessInput, setAccessInput] = useState("");
  const [accessError, setAccessError] = useState("");
  function checkAccessCode() {
    if (accessInput.trim() === ACCESS_CODE) {
      try {
        localStorage.setItem("pitboard_access_ok", "1");
      } catch (e) {}
      setAccessGranted(true);
      setAccessError("");
    } else {
      setAccessError("Code incorrect.");
    }
  }

  // rôle choisi une fois par appareil, stocké localement (pas d'authentification réelle,
  // conforme au choix "usage interne d'équipe" — appliqué uniquement côté interface)
  const [role, setRole] = useState(() => {
    try {
      return localStorage.getItem("pitboard_role") || null;
    } catch (e) {
      return null;
    }
  });
  function chooseRole(r) {
    try {
      localStorage.setItem("pitboard_role", r);
    } catch (e) {}
    setRole(r);
  }
  const canEdit = role !== "readonly";
  const isAdmin = role === "admin";

  // Team Manager : il choisit son numéro de voiture une fois par appareil et ne voit ensuite que
  // sa voiture (comme pour le rôle, c'est un réglage d'interface, pas une vraie sécurité)
  const [myCarId, setMyCarId] = useState(() => {
    try {
      const v = localStorage.getItem("pitboard_car");
      return v ? Number(v) : null;
    } catch (e) {
      return null;
    }
  });
  function chooseMyCar(id) {
    try {
      localStorage.setItem("pitboard_car", String(id));
    } catch (e) {}
    setMyCarId(id);
  }
  function resetRoleAndCar() {
    try {
      localStorage.removeItem("pitboard_role");
      localStorage.removeItem("pitboard_car");
    } catch (e) {}
    setMyCarId(null);
    setRole(null);
  }
  // Admin : tableau récapitulatif compact (toutes les tuiles fermées, sur un seul écran)
  const [recap, setRecap] = useState(() => {
    try {
      return localStorage.getItem("pitboard_recap") !== "0";
    } catch (e) {
      return true;
    }
  });
  function toggleRecap() {
    setRecap((prev) => {
      try {
        localStorage.setItem("pitboard_recap", prev ? "0" : "1");
      } catch (e) {}
      return !prev;
    });
  }
  const recapView = isAdmin && recap;

  const [flag, setFlag] = useState("vert");
  const [flash, setFlash] = useState(false);
  const [cars, setCars] = useState(emptyCars());
  const [showSetup, setShowSetup] = useState(false);
  const [showMessageForm, setShowMessageForm] = useState(true);
  const [modal, setModal] = useState(null); // team manager : "announce" | "message" | "tech"
  const [driversOpen, setDriversOpen] = useState(false); // menu déroulant "autres pilotes"
  // formulaire "Annoncer un arrêt" : l'admin / pit wall peut le masquer (mémorisé sur l'appareil)
  const [announceHidden, setAnnounceHidden] = useState(() => {
    try {
      return localStorage.getItem("pitboard_announce_hidden") === "1";
    } catch (e) {
      return false;
    }
  });
  function toggleAnnounce() {
    setAnnounceHidden((v) => {
      try {
        localStorage.setItem("pitboard_announce_hidden", v ? "0" : "1");
      } catch (e) {}
      return !v;
    });
  }
  const hideAnnounce = announceHidden && role !== "manager";
  const [techAck, setTechAck] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("pitboard_techack") || "{}") || {};
    } catch (e) {
      return {};
    }
  }); // { [carId]: id de la dernière saisie de litres envoyée }
  const [calls, setCalls] = useState([]);
  const [messages, setMessages] = useState([]);
  const [flagHistory, setFlagHistory] = useState([{ flag: "vert", ts: Date.now() }]);
  const flagHistoryRef = useRef([]);
  // drapeaux annoncés par le flux RIS (état de piste, full course yellow du RC) tels que CET écran les a vus :
  // ils comptent dans les temps vert/jaune des relais même si le drapeau n'a pas été changé sur le poste Admin
  // conservé dans le navigateur de CET écran : un F5 ne perd plus le temps jaune, même si aucun poste Admin ne relaie le flux
  const FEEDFLAG_KEY = "pitboard_feedflag";
  const [feedFlagHist, setFeedFlagHist] = useState(() => {
    try {
      const v = JSON.parse(localStorage.getItem(FEEDFLAG_KEY) || "[]");
      return Array.isArray(v) ? v.filter((e) => e && typeof e.ts === "number" && typeof e.flag === "string" && Date.now() - e.ts < 36 * 3600 * 1000) : [];
    } catch {
      return [];
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(FEEDFLAG_KEY, JSON.stringify(feedFlagHist.slice(-200)));
    } catch {
      /* stockage indisponible */
    }
  }, [feedFlagHist]);
  const [annWin, setAnnWin] = useState(false); // fenêtre des annonces détachée (team manager)
  useEffect(() => {
    flagHistoryRef.current = flagHistory;
  }, [flagHistory]);
  const [stints, setStints] = useState({}); // { [carId]: { lastExitAt: number|null, log: [{n, durationSec, laps, vertSec, jauneSec}] } }
  const stintsRef = useRef({});
  useEffect(() => {
    stintsRef.current = stints;
  }, [stints]);
  // ravitaillements par voiture : { [carId]: [ {id, ts, fuelL} ] } (litres ajoutés à chaque arrêt)
  const [techChecks, setTechChecks] = useState({});
  const techChecksRef = useRef({});
  useEffect(() => {
    techChecksRef.current = techChecks;
  }, [techChecks]);
  const [techCarId, setTechCarId] = useState("");
  const [now, setNow] = useState(Date.now());
  // statut de connexion Supabase Realtime : "connected" | "reconnecting" | "offline"
  const [connectionStatus, setConnectionStatus] = useState("reconnecting");
  const [settings, setSettings] = useState({
    maxFuelSimultaneous: 3,
    waitOnTrackSec: 60,
    noFuelLimitOnYellow: false,
    eventStartAt: "", // valeur du champ datetime-local
    eventDurationSec: 0,
    tankCapacityL: 35,
    greenSpeedKmh: 120,
    yellowSpeedKmh: 60,
    fuelWarnPct: 20,
    fuelCritPct: 10,
    eventType: "course", // "essais1" | "essais2" | "essais3" | "qualification" | "course"
    schedule: [], // programme des séances [{ id, type, startAt, durationSec, uuid }]
    scheduleAppliedId: "", // séance déjà appliquée aux réglages de l'événement
    idleConsoLh: 3, // consommation au ralenti (L/h) pendant que la voiture est à l'arrêt au stand (0 km/h)
    circuitName: "",
    circuitLengthKm: 0,
    circuitLat: null, // emplacement du circuit (météo)
    circuitLon: null,
    weatherBulletin: true, // bulletin météo toutes les 30 min
    liveEnabled: false, // flux RIS Live Timing (classement, tours) relayé par un poste Admin
    liveUuid: "", // uuid du flux RIS (change à chaque événement)
    liveSource: "direct", // "direct" : le poste Admin lit le flux ; "page" : il le reçoit de la page RIS ouverte (favori)
    rcLog: [], // historique des messages RC [{ t (ms), m }]
    liveRisUrl: "", // adresse de la page RIS à ouvrir pour le mode "page" (ex. https://live.ris-timing.be/funbe)
    liveFlagAuto: false, // drapeaux vert/jaune pilotés par le flux (le rouge reste manuel)
    feedFlagLog: [], // changements de drapeau annoncés par le flux (état de piste, full course yellow), notés par le poste Admin : [{ flag, ts }] ; survit au F5
    drivers: {}, // pilotes par voiture : { [idVoiture]: { list, relays } } (voir lib/drivers.js)
  });
  const [showSettings, setShowSettings] = useState(false);
  const [openDriverCars, setOpenDriverCars] = useState(() => new Set()); // voitures dont l'éditeur de pilotes est ouvert
  // dernier flux reçu via Supabase (écrit par le poste Admin relais) et état du relais local
  const [liveRow, setLiveRow] = useState(null); // { seq, generatedAt, fetchedAt, uuid, status, trackStateRaw, cars }
  const [relayStatus, setRelayStatus] = useState(null);
  const liveRowRef = useRef(null); // dernière ligne live_timing reçue (lue par le relais pour savoir si le script Python est vivant)
  liveRowRef.current = liveRow;
  const scriptIngestRef = useRef(null);
  const lastRawRef = useRef(null); // dernier flux brut reçu (poste Admin), pour l'échantillon de diagnostic
  const [sampleText, setSampleText] = useState(""); // seulement sur le poste Admin qui relaie
  const pushFlagRef = useRef(null);
  const autoPitRef = useRef(null); // forceArrival / removeCall à jour, pour le relais RIS (entrée et sortie des stands automatiques)
  const lastFeedFlagRef = useRef(null);
  const lastSeenFlagRef = useRef(null);
  const autoPushedFlagRef = useRef(null);
  const manualOverrideRef = useRef(null);
  const [advancedMode, setAdvancedMode] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [exportCsvText, setExportCsvText] = useState(null); // null = modale fermée
  const [exportCopyStatus, setExportCopyStatus] = useState("");
  const audioCtxRef = useRef(null);
  const justAddedLocallyRef = useRef(new Set());
  const justAddedMessageLocallyRef = useRef(new Set());
  const [soundOn, setSoundOn] = useState(true);
  const soundOnRef = useRef(true);
  useEffect(() => {
    soundOnRef.current = soundOn;
  }, [soundOn]);
  // après un F5, le navigateur bloque la voix tant qu'on n'a pas cliqué dans la page : le premier clic (n'importe où) la débloque
  const [voiceReady, setVoiceReady] = useState(() => (typeof navigator !== "undefined" && navigator.userActivation ? !!navigator.userActivation.hasBeenActive : false));
  useEffect(() => {
    if (voiceReady) return;
    const unlock = () => {
      try {
        getAudioCtx(audioCtxRef);
        if (window.speechSynthesis) {
          const u = new SpeechSynthesisUtterance(".");
          u.volume = 0;
          window.speechSynthesis.speak(u);
        }
      } catch (e) {}
      setVoiceReady(true);
    };
    document.addEventListener("pointerdown", unlock, true);
    document.addEventListener("keydown", unlock, true);
    return () => {
      document.removeEventListener("pointerdown", unlock, true);
      document.removeEventListener("keydown", unlock, true);
    };
  }, [voiceReady]);
  const editingSetupRef = useRef(false);
  const callsRef = useRef([]);
  const messagesRef = useRef([]);
  const carsRef = useRef([]);
  const flagHistoryEff = useMemo(
    () => mergeFlagHist(mergeFlagHist(flagHistory, Array.isArray(settings.feedFlagLog) ? settings.feedFlagLog : []), feedFlagHist),
    [flagHistory, settings.feedFlagLog, feedFlagHist]
  );
  const flagHistoryRef2 = useRef([]);
  flagHistoryRef2.current = flagHistoryEff;
  const settingsRef = useRef(settings);
  const ownSettingsWritesRef = useRef([]); // horodatages de nos propres écritures : leur écho temps réel est ignoré (il pourrait écraser une version plus récente)
  const lastKnownFlagRef = useRef(null);
  const flagTsRef = useRef(0);
  useEffect(() => {
    callsRef.current = calls;
  }, [calls]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  useEffect(() => {
    carsRef.current = cars;
  }, [cars]);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  // form state message d'équipe
  const [mCar, setMCar] = useState("");
  const [mText, setMText] = useState("");
  const [mError, setMError] = useState("");

  // formulaire fixe d'annonce d'un arrêt (fenêtre unique, choix de la voiture)
  const [fCar, setFCar] = useState("");
  const [fMin, setFMin] = useState("");
  const [fSec, setFSec] = useState("");
  const [fFuel, setFFuel] = useState("");
  const [fTasks, setFTasks] = useState("");
  const [fError, setFError] = useState("");

  const [expandedTiles, setExpandedTiles] = useState(() => new Set());
  const [confirmExitId, setConfirmExitId] = useState(null); // id de l'annonce en attente de confirmation "quitte les stands"
  useEffect(() => {
    if (confirmExitId !== null && !calls.some((c) => c.id === confirmExitId)) {
      setConfirmExitId(null);
    }
  }, [calls, confirmExitId]);

  const allConfiguredCars = useMemo(
    () => cars.filter((c) => c.numero.trim() !== ""),
    [cars]
  );
  // voiture du team manager connecté (null pour les autres rôles ou tant qu'il n'a pas choisi)
  const myCar = role === "manager" ? allConfiguredCars.find((c) => c.id === myCarId) || null : null;
  // voitures visibles sur cet écran : toutes, sauf pour un team manager qui ne voit que la sienne
  const configuredCars = useMemo(
    () => (role === "manager" ? (myCar ? [myCar] : []) : allConfiguredCars),
    [allConfiguredCars, role, myCar]
  );
  // annonces vocales : un team manager n'entend que celles de sa propre voiture
  const myCarIdRef = useRef(null);
  useEffect(() => {
    myCarIdRef.current = myCar ? myCar.id : null;
  }, [myCar]);
  function speaksFor(carId) {
    return myCarIdRef.current == null || myCarIdRef.current === carId;
  }
  // formulaires d'annonce et de message : la voiture du team manager est présélectionnée
  useEffect(() => {
    if (myCar) {
      setFCar(String(myCar.id));
      setMCar(String(myCar.id));
      setTechCarId(String(myCar.id));
    }
  }, [myCar && myCar.id]);

  // flux live (RIS) tel que reçu par cet écran. Le classement et les tours sont utilisés
  // tant que le relais Admin est vivant ; si le flux lui-même n'évolue plus (feedFresh = false),
  // les valeurs restent affichées mais un avertissement apparaît dans l'en-tête.
  const liveInfo = useMemo(() => {
    if (!settings.liveEnabled || !liveRow || !liveRow.cars) return null;
    if ((liveRow.uuid || "") !== (settings.liveUuid || "").trim()) return null; // flux d'un autre événement
    const relayAgeSec = Math.max(0, Math.round((now - liveRow.fetchedAt) / 1000));
    const feedAgeSec = Math.max(0, Math.round((liveRow.fetchedAt - liveRow.generatedAt) / 1000));
    return {
      cars: liveRow.cars,
      // lecture directe : une donnée toutes les 3 s ; mode page RIS : la page RIS rafraîchit à son rythme
      relayAlive: relayAgeSec <= (settings.liveSource === "page" ? 120 : 25),
      relayAgeSec,
      feedFresh: feedAgeSec <= 90 && liveRow.status !== "FINISHED",
      feedAgeSec,
      teamNums: allConfiguredCars.map((c) => normalizeCarNumber(c.numero)), // numéros des voitures de la team (affichés en orange dans le classement)
      quali: (settings.eventType || "course") !== "course", // qualification / essais : écarts de notre voiture à ses meilleurs secteurs
      status: liveRow.status || "",
      trackStateRaw: liveRow.trackStateRaw,
      generatedAt: liveRow.generatedAt,
      rc: Array.isArray(liveRow.rc) ? liveRow.rc : [],
      elapsedMs: liveRow.elapsedMs == null ? null : liveRow.elapsedMs,
      remainingMs: liveRow.remainingMs == null ? null : liveRow.remainingMs,
    };
  }, [settings.liveEnabled, settings.liveUuid, settings.liveSource, settings.eventType, allConfiguredCars, liveRow, now]);

  // alertes RC : mémoire locale de cet écran (en plus de l'historique noté par le poste Admin), pour qu'aucune alerte ne soit ratée
  const rcLocalKey = "pitboard_rclocal_" + ((settings.liveUuid || "").trim() || "x");
  const [rcLocal, setRcLocal] = useState([]); // [{ k (id|message), t, m }]
  useEffect(() => {
    try {
      const v = JSON.parse(localStorage.getItem(rcLocalKey) || "[]");
      if (Array.isArray(v) && v.length) setRcLocal((prev) => [...v.filter((x) => !prev.some((p) => p.k === x.k)), ...prev]);
    } catch {
      /* stockage indisponible */
    }
  }, [rcLocalKey]);
  useEffect(() => {
    if (!liveInfo || !Array.isArray(liveInfo.rc) || liveInfo.rc.length === 0) return;
    setRcLocal((prev) => {
      const seen = new Set(prev.map((x) => x.k));
      const add = [];
      liveInfo.rc.forEach((e) => {
        const k = e.id + "|" + e.message;
        if (!seen.has(k)) {
          seen.add(k);
          add.push({ k, t: Date.now(), m: e.message });
        }
      });
      return add.length ? [...prev, ...add].slice(-300) : prev;
    });
  }, [liveInfo]);
  useEffect(() => {
    if (rcLocal.length === 0) return;
    try {
      localStorage.setItem(rcLocalKey, JSON.stringify(rcLocal));
    } catch {
      /* stockage indisponible */
    }
  }, [rcLocal, rcLocalKey]);
  // historique complet : celui du poste Admin (heures exactes) + ce que cet écran a vu en plus
  const rcLogAll = useMemo(() => {
    const admin = Array.isArray(settings.rcLog) ? settings.rcLog : [];
    const cnt = {};
    admin.forEach((x) => {
      cnt[x.m] = (cnt[x.m] || 0) + 1;
    });
    const lc = {};
    const extra = [];
    rcLocal.forEach((x) => {
      lc[x.m] = (lc[x.m] || 0) + 1;
      if (lc[x.m] > (cnt[x.m] || 0)) extra.push({ t: x.t, m: x.m, local: true });
    });
    return [...admin, ...extra].sort((a, b) => a.t - b.t);
  }, [settings.rcLog, rcLocal]);
  // alertes acquittées (« Vu ») sur cet écran
  const [rcAcks, setRcAcks] = useState(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem("pitboard_rcacks") || "[]"));
    } catch {
      return new Set();
    }
  });
  const ackRc = (k) =>
    setRcAcks((prev) => {
      const n = new Set(prev).add(k);
      try {
        localStorage.setItem("pitboard_rcacks", JSON.stringify([...n].slice(-500)));
      } catch {
        /* stockage indisponible */
      }
      return n;
    });

  // météo du circuit : lue toutes les 10 minutes par chaque écran ; la température est notée avec chaque tour
  const [weather, setWeather] = useState(null);
  const [bulletin, setBulletin] = useState(null); // { w, until } : bulletin affiché à H:00 et H:30
  const wxLat = Number.isFinite(settings.circuitLat) ? settings.circuitLat : null;
  const wxLon = Number.isFinite(settings.circuitLon) ? settings.circuitLon : null;
  const wxOn = wxLat != null && wxLon != null;
  useEffect(() => {
    if (!wxOn) {
      setWeather(null);
      setLiveTemperature(null);
      return undefined;
    }
    let stop = false;
    const load = () =>
      fetchWeather(wxLat, wxLon)
        .then((w) => {
          if (stop || !w) return;
          setWeather(w);
          setLiveTemperature(w.tempC);
        })
        .catch(() => {});
    load();
    const t = setInterval(load, 10 * 60000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [wxOn, wxLat, wxLon]);
  const wxSlot = Math.floor(now / 1800000);
  const wxSlotRef = useRef(null);
  useEffect(() => {
    if (!wxOn || settings.weatherBulletin === false) return;
    if (wxSlotRef.current === null) {
      wxSlotRef.current = wxSlot; // pas de bulletin à l'ouverture de la page : le prochain tombe à H:00 ou H:30
      return;
    }
    if (wxSlotRef.current === wxSlot) return;
    wxSlotRef.current = wxSlot;
    fetchWeather(wxLat, wxLon)
      .then((w) => {
        if (!w) return;
        setWeather(w);
        setLiveTemperature(w.tempC);
        setBulletin({ w, until: Date.now() + 150000 });
      })
      .catch(() => {});
  }, [wxSlot, wxOn, wxLat, wxLon, settings.weatherBulletin]);

  // mémoire de l'écran (rythmes, tours vus, sorties des stands) conservée dans le navigateur : un F5 ne la perd plus
  const memKey = "pitboard_livemem_" + ((settings.liveUuid || "").trim() || "x");
  const memLoadedRef = useRef("");
  if (settings.liveUuid && memLoadedRef.current !== memKey) {
    memLoadedRef.current = memKey;
    loadLiveMemory(memKey);
  }
  useEffect(() => {
    if (!settings.liveEnabled || !settings.liveUuid) return undefined;
    const save = () => saveLiveMemory(memKey, (carsRef.current || []).map((c) => normalizeCarNumber(c.numero)));
    const t = setInterval(save, 10000);
    window.addEventListener("pagehide", save);
    document.addEventListener("visibilitychange", save);
    return () => {
      clearInterval(t);
      window.removeEventListener("pagehide", save);
      document.removeEventListener("visibilitychange", save);
      save();
    };
  }, [memKey, settings.liveEnabled, settings.liveUuid]);

  // enregistre les changements de drapeau annoncés par le flux (état de piste ou full course yellow du RC)
  const feedFlagLastRef = useRef(null);
  useEffect(() => {
    if (!liveInfo || !liveInfo.feedFresh) return;
    let eff = normalizeTrackState(liveInfo.trackStateRaw);
    if ((!eff || eff === "vert") && fcyFromRc(liveInfo.rc, liveInfo.generatedAt) === true) eff = "jaune";
    if (!eff) return;
    if (feedFlagLastRef.current === eff) return;
    feedFlagLastRef.current = eff;
    // on ne note que les changements par rapport au dernier état connu (y compris celui d'avant le F5)
    setFeedFlagHist((h) => {
      const last = h.length ? h[h.length - 1].flag : "vert";
      return last === eff ? h : [...h, { flag: eff, ts: Date.now() }].slice(-200);
    });
  }, [liveInfo]);

  // données live d'une voiture (null si pas de flux, relais arrêté ou voiture absente du flux)
  // connexion au chronométrage RIS perdue : grosse alerte plein écran (après avoir été connecté pendant cette session de la page)
  const risEverLiveRef = useRef(false);
  const risUuidRef = useRef("");
  if (risUuidRef.current !== (settings.liveUuid || "")) {
    risUuidRef.current = settings.liveUuid || "";
    risEverLiveRef.current = false; // autre événement : on repart de zéro
  }
  const risOk = !!(liveInfo && liveInfo.relayAlive && liveInfo.feedFresh);
  if (risOk) risEverLiveRef.current = true;
  const risLost = !!settings.liveEnabled && risEverLiveRef.current && !risOk && !(liveInfo && liveInfo.status === "FINISHED");
  const [risDismissed, setRisDismissed] = useState(false);
  useEffect(() => {
    if (!risLost) {
      setRisDismissed(false);
      return;
    }
    if (soundOnRef.current) speakYellowAlert(audioCtxRef, "Attention! Connexion au chronométrage perdue!");
  }, [risLost]);
  const risLostMsg = !liveInfo
    ? "Plus aucune donnée reçue du chronométrage."
    : !liveInfo.relayAlive
    ? `Le poste Admin qui relaie le flux n'a rien envoyé depuis ${liveInfo.relayAgeSec} s.`
    : `Le flux RIS n'évolue plus (dernière donnée il y a ${liveInfo.feedAgeSec} s).`;

  // flux figé : le relais Admin est vivant mais le contenu (chrono de course, tours, intermédiaires) n'a pas bougé depuis un moment.
  // Normal pendant la préparation de la course côté RIS ; anormal une fois la course lancée (ou si le flux avait déjà bougé) : alerte pour relancer vite.
  const FROZEN_LIMIT_SEC = 25;
  const frozenRef = useRef({ sig: "", since: Date.now(), moved: false });
  const relayKickRef = useRef(null);
  let frozenFor = 0;
  let raceLaunched = false;
  if (liveInfo && liveInfo.relayAlive) {
    const fr = frozenRef.current;
    let acc = 0;
    let n = 0;
    for (const k in liveInfo.cars) {
      const c = liveInfo.cars[k];
      n++;
      acc += (c.laps || 0) * 3 + ((c.lapEnd || 0) % 1000003) + (c.last || 0) + (c.s1 || 0) + (c.s2 || 0) + (c.s3 || 0) + (c.pits || 0) * 11;
    }
    const sig = n + "|" + liveInfo.elapsedMs + "|" + acc;
    if (fr.sig !== sig) {
      if (fr.sig) fr.moved = true;
      fr.sig = sig;
      fr.since = Date.now();
    }
    const startMs = settings.eventStartAt ? new Date(settings.eventStartAt).getTime() : NaN;
    raceLaunched = (settings.eventType || "course") === "course" && !isNaN(startMs) && Date.now() >= startMs;
    frozenFor = Math.round((Date.now() - Math.max(fr.since, raceLaunched ? startMs : 0)) / 1000);
  } else {
    frozenRef.current.sig = ""; // relais coupé : on repartira d'une mesure neuve au retour du flux
  }
  const feedRed = !!liveInfo && normalizeTrackState(liveInfo.trackStateRaw) === "rouge"; // drapeau rouge : chrono et voitures peuvent légitimement s'arrêter
  const feedFrozen = !!liveInfo && liveInfo.relayAlive && liveInfo.status !== "FINISHED" && !risLost && !feedRed && (raceLaunched || frozenRef.current.moved) && frozenFor >= FROZEN_LIMIT_SEC;
  const feedPrep = !!liveInfo && liveInfo.relayAlive && liveInfo.status !== "FINISHED" && !feedFrozen && !frozenRef.current.moved && !raceLaunched && frozenFor >= 10;
  const [frozenDismissed, setFrozenDismissed] = useState(false);
  useEffect(() => {
    if (!feedFrozen) {
      setFrozenDismissed(false);
      return undefined;
    }
    const say = () => {
      if (soundOnRef.current) speakYellowAlert(audioCtxRef, "Attention! Le flux du chronométrage est figé! Relancer!");
    };
    say();
    const t = setInterval(say, 30000);
    return () => clearInterval(t);
  }, [feedFrozen]);
  const kickFeed = () => {
    if (relayKickRef.current) relayKickRef.current(); // poste Admin : relit tout de suite le flux RIS
    else window.location.reload(); // autres postes : rechargement de la page
  };

  // classement du poste Admin : s'ouvre seul quand toutes les voitures sont en piste sans aucune annonce, se ferme à la première nouvelle annonce
  const [admCl, setAdmClRaw] = useState(loadAdminCl);
  const setAdmCl = (patch) =>
    setAdmClRaw((p) => {
      const n = { ...p, ...patch };
      try {
        localStorage.setItem(ADMCL_KEY, JSON.stringify(n));
      } catch {
        /* stockage indisponible */
      }
      return n;
    });
  const [admClOpen, setAdmClOpen] = useState(false);
  const admCallIdsRef = useRef(null);
  const admAllTrackRef = useRef(false);
  useEffect(() => {
    if (!isAdmin) return;
    const ids = new Set(calls.map((c) => c.id));
    const prev = admCallIdsRef.current;
    admCallIdsRef.current = ids;
    if (prev && calls.some((c) => !prev.has(c.id))) setAdmClOpen(false); // nouvelle annonce : retour à la vision des tuiles
  }, [calls, isAdmin]);
  const admAllOnTrack = isAdmin && !!liveInfo && allConfiguredCars.length > 0 && calls.length === 0 && allConfiguredCars.every((c) => !!(stints[c.id] && stints[c.id].lastExitAt));
  useEffect(() => {
    if (admAllOnTrack && !admAllTrackRef.current) setAdmClOpen(true); // toutes en piste, aucune annonce : le classement revient au premier plan
    admAllTrackRef.current = admAllOnTrack;
  }, [admAllOnTrack]);

  function liveFor(car) {
    if (!liveInfo || !liveInfo.relayAlive) return null;
    return liveInfo.cars[normalizeCarNumber(car.numero)] || null;
  }
  // classement affiché : celui du flux s'il existe, sinon le classement saisi à la main
  function rankOf(car) {
    const l = liveFor(car);
    return (l && l.pos) || car.classement || 0;
  }

  // messages de la direction de course (RC) : généraux pour tous, ou filtrés sur nos numéros de voiture
  const rcSeenRef = useRef({});
  const [rcDismissed, setRcDismissed] = useState(() => new Set());
  const rcMessages = useMemo(() => {
    if (!settings.liveEnabled || !liveInfo || !liveInfo.rc || liveInfo.rc.length === 0) return [];
    const wanted = (role === "manager" ? (myCar ? [myCar] : []) : allConfiguredCars).map((c) =>
      String(Number(normalizeCarNumber(c.numero)))
    );
    return visibleRcMessages(liveInfo.rc, wanted, now, rcSeenRef.current, rcDismissed, liveInfo.generatedAt);
  }, [settings.liveEnabled, liveInfo, role, myCar, allConfiguredCars, now, rcDismissed]);
  // alerte "Full course yellow" annoncée par la direction de course (message RC) : écran jaune/noir qui clignote + annonce vocale,
  // même si le drapeau jaune n'a pas été activé à la main. Les messages déjà présents au chargement ne déclenchent rien.
  const rcAlertSeenRef = useRef(null);
  const rcFcyOnRef = useRef(false);
  const [rcFcyUntil, setRcFcyUntil] = useState(0);
  const fcyActive = now < rcFcyUntil;
  useEffect(() => {
    if (!settings.liveEnabled || !liveInfo) return;
    const list = liveInfo.rc || [];
    const keyOf = (e) => `${e.id}|${e.message}`;
    if (rcAlertSeenRef.current === null) {
      rcAlertSeenRef.current = new Set(list.map(keyOf));
      return;
    }
    list.forEach((e) => {
      const k = keyOf(e);
      if (rcAlertSeenRef.current.has(k)) return;
      rcAlertSeenRef.current.add(k);
      const msg = String(e.message || "");
      const flagYellow = lastKnownFlagRef.current === "jaune";
      if (/(END|ENDING|TERMIN|GREEN|RESUM)/i.test(msg) && /(FULL\s*COURSE|GREEN\s*FLAG|SAFETY\s*CAR|CODE\s*60)/i.test(msg)) {
        if (rcFcyOnRef.current && soundOnRef.current && !flagYellow) speakYellowAlert(audioCtxRef, "Full course yellow terminé! Full course yellow terminé!");
        rcFcyOnRef.current = false;
      } else if (/GREEN\s*FLAG/i.test(msg)) {
        if (rcFcyOnRef.current && soundOnRef.current && !flagYellow) speakYellowAlert(audioCtxRef, "Full course yellow terminé! Full course yellow terminé!");
        rcFcyOnRef.current = false;
      } else if (/FULL\s*COURSE\s*YELLOW|\bFCY\b|SAFETY\s*CAR|CODE\s*60/i.test(msg)) {
        rcFcyOnRef.current = true;
        setRcFcyUntil(Date.now() + 12000);
        if (soundOnRef.current && !flagYellow) speakYellowAlert(audioCtxRef, "Full course yellow! Full course yellow!");
      } else if (/RED\s*FLAG/i.test(msg)) {
        if (soundOnRef.current && lastKnownFlagRef.current !== "rouge") speakYellowAlert(audioCtxRef, "Red Flag! Red Flag!");
      }
    });
  }, [liveInfo, settings.liveEnabled]);
  // message RC visé par numéro de voiture (pour la tuile de cette voiture)
  function rcForCar(car) {
    const n = String(Number(normalizeCarNumber(car.numero)));
    return rcMessages.filter((m) => m.nums.includes(n));
  }

  // historique conservé des messages RC pour une voiture : ceux qui la citent + les messages généraux,
  // du plus récent au plus ancien (heure = première apparition dans le flux, enregistrée par le poste Admin)
  function rcLogForCar(car) {
    const log = rcLogAll;
    if (log.length === 0) return [];
    const n = String(Number(normalizeCarNumber(car.numero)));
    return log
      .filter((l) => {
        const nums = carNumbersIn(l.m);
        return nums.length === 0 || nums.includes(n);
      })
      .slice()
      .reverse();
  }

  // diagnostic automatique minimal : détecte les incohérences de données courantes
  const diagnostics = useMemo(() => {
    const issues = [];
    const numeros = allConfiguredCars.map((c) => c.numero.trim());
    const dupes = numeros.filter((n, i) => numeros.indexOf(n) !== i);
    [...new Set(dupes)].forEach((n) => issues.push(`Numéro de voiture en double : #${n}`));

    const carIds = new Set(cars.map((c) => c.id));
    calls.forEach((c) => {
      if (!carIds.has(c.carId)) issues.push(`Annonce orpheline (voiture #${c.numero} non configurée)`);
    });
    Object.keys(stints).forEach((carId) => {
      if (!carIds.has(Number(carId))) issues.push(`Relais enregistrés pour une voiture supprimée (id ${carId})`);
    });
    Object.keys(techChecks).forEach((carId) => {
      if (!carIds.has(Number(carId))) issues.push(`Ravitaillements pour une voiture supprimée (id ${carId})`);
    });
    if (settings.tankCapacityL <= 0) issues.push("Capacité du réservoir invalide (≤ 0 L)");
    if (settings.greenSpeedKmh <= 0) issues.push("Vitesse drapeau vert invalide (≤ 0 km/h)");
    if (settings.yellowSpeedKmh <= 0) issues.push("Vitesse drapeau jaune invalide (≤ 0 km/h)");
    if (settings.maxFuelSimultaneous <= 0) issues.push("Nombre de pompes invalide (≤ 0)");
    return issues;
  }, [cars, allConfiguredCars, calls, stints, techChecks, settings]);

  function toggleExpand(carId) {
    setExpandedTiles((prev) => {
      const next = new Set(prev);
      if (next.has(carId)) next.delete(carId);
      else next.add(carId);
      return next;
    });
  }

  // horloge locale : rafraîchit l'affichage chaque seconde, sans toucher au stockage
  // + retire une annonce si le stand dépasse la durée maximale au stand
  useEffect(() => {
    const t = setInterval(() => {
      const nowMs = Date.now();
      setNow(nowMs);

      const toRemove = callsRef.current
        .filter((c) => {
          const d = deriveCall(c, nowMs);
          return d.phase === "instand" && d.pitElapsed >= AUTO_REMOVE_AFTER_PIT_SEC;
        })
        .map((c) => c.id);
      if (toRemove.length > 0) {
        pushCalls(callsRef.current.filter((c) => !toRemove.includes(c.id)));
      }

      const msgsToRemove = messagesRef.current
        .filter((m) => nowMs - m.postedAt >= 60000)
        .map((m) => m.id);
      if (msgsToRemove.length > 0) {
        pushMessages(messagesRef.current.filter((m) => !msgsToRemove.includes(m.id)));
      }

      // démarre le tout premier relais de chaque voiture dès que l'heure de l'événement est atteinte
      // (revérifié à chaque seconde, pas seulement une fois, pour couvrir les voitures configurées après le départ)
      // essais / qualification : la voiture ne part pas forcément au départ du chrono ; le team manager lance le roulage lui-même
      if (settingsRef.current.eventStartAt && (settingsRef.current.eventType || "course") === "course") {
        const startMs = new Date(settingsRef.current.eventStartAt).getTime();
        if (!isNaN(startMs) && nowMs >= startMs) {
          const configured = carsRef.current.filter((c) => c.numero && c.numero.trim() !== "");
          let changed = false;
          const nextStints = { ...stintsRef.current };
          configured.forEach((car) => {
            const existing = nextStints[car.id];
            if (!existing || ((!existing.lastExitAt || existing.lastExitAt < startMs) && (!existing.log || existing.log.length === 0))) {
              nextStints[car.id] = { lastExitAt: startMs, log: existing ? existing.log || [] : [] };
              changed = true;
            }
          });
          if (changed) pushStints(nextStints);
        }
      }
    }, 1000);
    return () => clearInterval(t);
  }, []);

  // programme des séances : le poste Admin applique automatiquement la séance dont l'heure de début est passée
  useEffect(() => {
    if (!isAdmin) return;
    const t = setInterval(() => {
      const cur = settingsRef.current;
      const s = currentSession(cur.schedule, Date.now());
      if (s && s.id !== cur.scheduleAppliedId) applySession(s);
    }, 5000);
    return () => clearInterval(t);
  }, [isAdmin]);

  // clignotement du drapeau jaune
  useEffect(() => {
    if (flag !== "jaune" && !fcyActive) {
      setFlash(false);
      return;
    }
    const t = setInterval(() => setFlash((f) => !f), 450);
    return () => clearInterval(t);
  }, [flag, fcyActive]);

  // --- SYNCHRONISATION SUPABASE (chargement initial + Realtime) ---
  useEffect(() => {
    let cancelled = false;

    // -- mappage lignes Supabase -> forme app (fonctions de niveau module, voir plus haut) --

    async function fetchAll() {
      try {
        const [
          carsRes,
          callsRes,
          messagesRes,
          settingsRes,
          flagRes,
          flagHistRes,
          stintsRes,
          stintCurrentRes,
          techRes,
        ] = await Promise.all([
          supabase.from("cars").select("*").order("id"),
          supabase.from("pit_calls").select("*").eq("status", "active"),
          supabase.from("team_messages").select("*"),
          supabase.from("app_settings").select("*").eq("id", 1).single(),
          supabase.from("race_flag").select("*").eq("id", 1).single(),
          supabase.from("flag_history").select("*").order("ts"),
          supabase.from("stints").select("*").order("n"),
          supabase.from("stint_current").select("*"),
          supabase.from("technical_checks").select("*").order("ts"),
        ]);
        if (cancelled) return;

        if (carsRes.data) setCars(carsRes.data.map(carRowToApp));
        if (callsRes.data) setCalls(callsRes.data.map(callRowToApp));
        if (messagesRes.data) setMessages(messagesRes.data.map(messageRowToApp));
        if (settingsRes.data) setSettings((local) => ({ ...local, ...settingsRes.data.data }));
        if (flagRes.data) {
          setFlag(flagRes.data.value);
          lastKnownFlagRef.current = flagRes.data.value;
          flagTsRef.current = new Date(flagRes.data.updated_at).getTime();
        }
        if (flagHistRes.data) {
          setFlagHistory(flagHistRes.data.map((r) => ({ flag: r.flag, ts: new Date(r.ts).getTime() })));
        }
        if (stintsRes.data && stintCurrentRes.data) {
          const grouped = {};
          stintsRes.data.forEach((r) => {
            if (!grouped[r.car_id]) grouped[r.car_id] = { lastExitAt: null, log: [] };
            grouped[r.car_id].log.push(stintRowToApp(r));
          });
          stintCurrentRes.data.forEach((r) => {
            if (!grouped[r.car_id]) grouped[r.car_id] = { lastExitAt: null, log: [] };
            grouped[r.car_id].lastExitAt = r.last_exit_at ? new Date(r.last_exit_at).getTime() : null;
          });
          setStints(grouped);
        }
        if (techRes.data) {
          const grouped = {};
          techRes.data.forEach((r) => {
            if (!grouped[r.car_id]) grouped[r.car_id] = [];
            grouped[r.car_id].push(techRowToApp(r));
          });
          setTechChecks(grouped);
        }
      } catch (e) {
        // une erreur ponctuelle de chargement initial n'empêche pas Realtime de continuer
      }
    }

    fetchAll();

    // -- abonnements Realtime : un canal par table, mise à jour ciblée du state --
    const channel = supabase
      .channel("pitboard-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "cars" }, (payload) => {
        setCars((prev) => {
          if (payload.eventType === "DELETE") return prev.filter((c) => c.id !== payload.old.id);
          const row = carRowToApp(payload.new);
          const exists = prev.some((c) => c.id === row.id);
          return exists ? prev.map((c) => (c.id === row.id ? row : c)) : [...prev, row];
        });
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "pit_calls" }, (payload) => {
        if (payload.eventType === "DELETE") {
          setCalls((prev) => prev.filter((c) => c.id !== payload.old.id));
          return;
        }
        const row = payload.new;
        if (row.status !== "active") {
          // l'annonce vient d'être clôturée (terminée/annulée) -> elle sort de la liste active
          setCalls((prev) => prev.filter((c) => c.id !== row.id));
          return;
        }
        const call = callRowToApp(row);
        if (payload.eventType === "INSERT" && soundOnRef.current && speaksFor(call.carId) && !justAddedLocallyRef.current.has(call.id)) {
          const secs = (call.arrivalAt - Date.now()) / 1000;
          speakAnnouncement(audioCtxRef, call.numero, secs);
        }
        // un autre poste vient de cliquer "Entrée" (countdown -> instand) : on annonce aussi ici.
        // Sur le poste qui a cliqué, l'état local est déjà "instand" quand l'écho arrive,
        // donc cette condition est fausse et la phrase n'est pas rejouée une 2e fois.
        if (payload.eventType === "UPDATE" && soundOnRef.current) {
          const before = callsRef.current.find((c) => c.id === call.id);
          if (before && before.phase === "countdown" && call.phase === "instand" && speaksFor(call.carId)) {
            speakTrackPoint(audioCtxRef, call.numero, "Entrée");
          }
        }
        setCalls((prev) => {
          const exists = prev.some((c) => c.id === call.id);
          return exists ? prev.map((c) => (c.id === call.id ? call : c)) : [...prev, call];
        });
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "team_messages" }, (payload) => {
        if (payload.eventType === "DELETE") {
          setMessages((prev) => prev.filter((m) => m.id !== payload.old.id));
          return;
        }
        const msg = messageRowToApp(payload.new);
        if (payload.eventType === "INSERT" && soundOnRef.current && speaksFor(msg.carId) && !justAddedMessageLocallyRef.current.has(msg.id)) {
          speakMessage(audioCtxRef, msg.numero, msg.pilote, msg.text);
        }
        setMessages((prev) => {
          const exists = prev.some((m) => m.id === msg.id);
          return exists ? prev.map((m) => (m.id === msg.id ? msg : m)) : [...prev, msg];
        });
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "app_settings" }, (payload) => {
        const t = new Date(payload.new.updated_at).getTime();
        if (Number.isFinite(t) && ownSettingsWritesRef.current.includes(t)) return; // écho de notre propre écriture : déjà appliquée localement
        const merged = { ...settingsRef.current, ...payload.new.data };
        settingsRef.current = merged; // à jour tout de suite : la prochaine écriture part de la bonne version
        setSettings(merged);
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "race_flag" }, (payload) => {
        const remoteFlag = payload.new.value;
        const remoteTs = new Date(payload.new.updated_at).getTime();
        if (remoteTs < flagTsRef.current) return; // écriture en retard -> ignorée
        if (remoteFlag !== lastKnownFlagRef.current && soundOnRef.current) {
          if (remoteFlag === "jaune") {
            speakYellowAlert(audioCtxRef, "Full course yellow! Full course yellow!");
          } else {
            if (lastKnownFlagRef.current === "jaune") {
              speakYellowAlert(audioCtxRef, "Full course yellow terminé! Full course yellow terminé!");
            }
            if (remoteFlag === "rouge") speakYellowAlert(audioCtxRef, "Red Flag! Red Flag!");
          }
        }
        lastKnownFlagRef.current = remoteFlag;
        flagTsRef.current = remoteTs;
        setFlag(remoteFlag);
      })
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "flag_history" }, (payload) => {
        setFlagHistory((prev) => [...prev, { flag: payload.new.flag, ts: new Date(payload.new.ts).getTime() }]);
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "stints" }, (payload) => {
        setStints((prev) => {
          if (payload.eventType === "DELETE") {
            // sur un DELETE, Supabase ne renvoie que l'id : on le retire de toutes les voitures
            const delId = payload.old && payload.old.id;
            const next = {};
            Object.keys(prev).forEach((k) => {
              next[k] = { ...prev[k], log: (prev[k].log || []).filter((r) => r._dbId !== delId) };
            });
            return next;
          }
          const r = payload.new;
          const st = prev[r.car_id] || { lastExitAt: null, log: [] };
          return { ...prev, [r.car_id]: { ...st, log: mergeStintEntry(st.log, stintRowToApp(r)) } };
        });
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "stint_current" }, (payload) => {
        // sur un DELETE, payload.new est un objet vide : l'ancienne ligne est dans payload.old
        const rec = payload.eventType === "DELETE" ? payload.old : payload.new;
        if (!rec || rec.car_id == null) return;
        setStints((prev) => {
          const st = prev[rec.car_id] || { lastExitAt: null, log: [] };
          const lastExitAt =
            payload.eventType !== "DELETE" && rec.last_exit_at ? new Date(rec.last_exit_at).getTime() : null;
          return { ...prev, [rec.car_id]: { ...st, lastExitAt } };
        });
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "technical_checks" }, (payload) => {
        setTechChecks((prev) => {
          if (payload.eventType === "DELETE") {
            const delId = payload.old && payload.old.id;
            const next = {};
            Object.keys(prev).forEach((k) => {
              next[k] = (prev[k] || []).filter((r) => r.id !== delId);
            });
            return next;
          }
          const carId = payload.new.car_id;
          const rec = techRowToApp(payload.new);
          const list = prev[carId] || [];
          const exists = list.some((r) => r.id === rec.id);
          return { ...prev, [carId]: exists ? list.map((r) => (r.id === rec.id ? rec : r)) : [...list, rec] };
        });
      })
      .subscribe((status) => {
        if (cancelled) return;
        if (status === "SUBSCRIBED") setConnectionStatus("connected");
        else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") setConnectionStatus("reconnecting");
        else if (status === "CLOSED") setConnectionStatus("offline");
      });

    // filet de sécurité réseau : bascule "hors ligne" si le navigateur perd la connexion,
    // et relance un chargement complet au retour (rattrape ce que Realtime aurait pu manquer)
    function handleOffline() {
      setConnectionStatus("offline");
    }
    function handleOnline() {
      setConnectionStatus("reconnecting");
      fetchAll();
    }
    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);

    return () => {
      cancelled = true;
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
      supabase.removeChannel(channel);
    };
  }, []);

  // --- FLUX LIVE : lecture partagée (tous les postes) ---
  // canal séparé du canal principal : si la table live_timing n'existe pas encore, le reste
  // de l'application n'est pas affecté.
  useEffect(() => {
    let cancelled = false;
    const rowToLive = (row) => (row && row.data && row.data.cars ? row.data : null);

    async function loadLive() {
      try {
        const { data } = await supabase.from("live_timing").select("*").eq("id", 1).maybeSingle();
        if (!cancelled) setLiveRow(rowToLive(data));
      } catch (e) {}
    }
    loadLive();

    const liveChannel = supabase
      .channel("pitboard-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "live_timing" }, (payload) => {
        if (payload.eventType === "DELETE") setLiveRow(null);
        else setLiveRow(rowToLive(payload.new));
      })
      .subscribe();

    const onOnline = () => loadLive();
    window.addEventListener("online", onOnline);
    return () => {
      cancelled = true;
      window.removeEventListener("online", onOnline);
      supabase.removeChannel(liveChannel);
    };
  }, []);

  // --- FLUX LIVE : relais (poste Admin uniquement) ---
  // Un seul poste lit le flux RIS toutes les 3 s et l'écrit dans Supabase ; les autres le
  // reçoivent par Realtime. Les drapeaux vert/jaune sont appliqués ici si l'option est active.
  useEffect(() => {
    const uuid = (settings.liveUuid || "").trim();
    const pageMode = settings.liveSource === "page";
    // en lecture directe, on ne démarre que sur un uuid complet : pendant la saisie, aucune
    // requête partielle n'est envoyée. En mode "page", l'uuid vient de la page RIS elle-même.
    if (!isAdmin || !settings.liveEnabled || (!pageMode && !/^[0-9a-fA-F-]{36}$/.test(uuid))) {
      setRelayStatus(null);
      return;
    }
    setRelayStatus(null); // efface l'ancien message (ex. erreur de la lecture directe) à chaque changement de mode
    let stopped = false;
    let busy = false;
    let lastSeq = null;
    let lastWriteAt = 0;

    function applyAutoFlag(live, nowMs) {
      const cur = lastKnownFlagRef.current;

      // changement de drapeau fait par quelqu'un d'autre que le relais (n'importe quel poste) :
      // c'est une commande manuelle, elle reste prioritaire tant que le flux ne change pas lui-même
      if (lastSeenFlagRef.current === null) {
        lastSeenFlagRef.current = cur;
      } else if (cur !== lastSeenFlagRef.current) {
        if (cur !== autoPushedFlagRef.current) {
          manualOverrideRef.current = { feedFlag: lastFeedFlagRef.current };
        }
        lastSeenFlagRef.current = cur;
      }
      // un full course yellow / safety car annoncé par la direction de course compte comme drapeau jaune
      // (même si l'état de piste du flux reste vert) : les temps de relais le comptent alors en jaune
      let eff = live.flag;
      if ((!eff || eff === "vert") && fcyFromRc(live.rc, live.generatedAt) === true) eff = "jaune";
      lastFeedFlagRef.current = eff;

      // le poste Admin note chaque changement de drapeau du flux dans les réglages partagés (indépendamment des drapeaux auto) :
      // les temps jaune des relais restent alors justes après un F5 et sont identiques sur tous les écrans
      if (eff && nowMs - live.generatedAt <= 90000) {
        const fl = Array.isArray(settingsRef.current.feedFlagLog) ? settingsRef.current.feedFlagLog : [];
        const lastF = fl.length ? fl[fl.length - 1].flag : "vert";
        if (eff !== lastF) pushSettings({ ...settingsRef.current, feedFlagLog: [...fl, { flag: eff, ts: nowMs }].slice(-200) });
      }

      if (!settingsRef.current.liveFlagAuto) return;
      if (!eff) return; // état de piste vide ou inconnu : pas de changement automatique
      if (live.status === "FINISHED") return;
      if (nowMs - live.generatedAt > 90000) return; // flux ancien : on ne touche pas au drapeau
      const ov = manualOverrideRef.current;
      if (ov) {
        if (ov.feedFlag === eff) return;
        manualOverrideRef.current = null;
      }
      // un rouge posé à la main se lève à la main ; un rouge venu du flux se lève avec lui
      if (cur === "rouge" && autoPushedFlagRef.current !== "rouge") return;
      if (cur === eff) return;
      autoPushedFlagRef.current = eff;
      lastSeenFlagRef.current = eff;
      if (pushFlagRef.current) pushFlagRef.current(eff);
    }

    // meilleurs intermédiaires / meilleur tour PAR PILOTE : chaque valeur nouvelle du flux est
    // attribuée au pilote du relais en cours (le pilote prévu ou confirmé dans PitBoard).
    // Seul le poste Admin qui relaie le flux les enregistre (une écriture seulement si un record tombe).
    const seenByCar = {};
    const lapNoByCar = {};
    function recordBests(live) {
      const clsAll = classPositions(live.cars);
      let drivers = settingsRef.current.drivers || {};
      let changed = false;
      carsRef.current.forEach((car) => {
        const lc = live.cars[normalizeCarNumber(car.numero)];
        if (!lc) return;
        const cfg = getCfg(drivers, car.id);
        if (cfg.list.length === 0) return;
        const st = stintsRef.current[car.id] || { lastExitAt: null, log: [] };
        const logN = (st.log || []).length;
        // en piste : relais en cours ; au stand : le relais qui vient de se terminer
        const relayN = st.lastExitAt ? logN + 1 : logN;
        const driverId = relayN >= 1 ? resolveRelay(cfg, relayN).id : null;
        const first = !seenByCar[car.id];
        const { seen, obs } = observeLap(seenByCar[car.id], lc);
        seenByCar[car.id] = seen;
        const prevLapNo = lapNoByCar[car.id];
        lapNoByCar[car.id] = lc.laps;
        if (first || !driverId) return; // premier flux : on mémorise seulement
        let nc = cfg;
        const cur = cfg.best[driverId];
        const nb = mergeBest(cur, obs);
        if (nb !== cur) nc = { ...nc, best: { ...nc.best, [driverId]: nb } };
        // tour terminé : on note S1, S2, S3 et le temps total au nom du pilote du relais
        if (prevLapNo != null && lc.laps != null && lc.laps > prevLapNo && lc.last > 0) {
          const sOk = lc.s1 != null && lc.s2 != null && lc.s3 != null && Math.abs(lc.s1 + lc.s2 + lc.s3 - lc.last) <= 0.03 * lc.last;
          nc = recordLap(nc, driverId, {
            n: lc.laps,
            total: lc.last,
            s1: sOk ? lc.s1 : null,
            s2: sOk ? lc.s2 : null,
            s3: sOk ? lc.s3 : null,
            at: lc.lapEnd || Date.now(),
            temp: getLiveTemperature(),
            pic: (clsAll[normalizeCarNumber(car.numero)] || {}).pic ?? null,
          });
        }
        if (nc !== cfg) {
          drivers = { ...drivers, [car.id]: nc };
          changed = true;
        }
      });
      if (changed) pushSettings({ ...settingsRef.current, drivers });
    }

    // entrée / sortie des stands pilotées par le flux RIS (poste Admin qui relaie) : l'état « pit » du flux déclenche l'entrée
    // de l'annonce, le retour en piste (OUT) la sortie ; l'entrée est immédiate, la sortie exige deux lectures consécutives pour éviter un faux départ
    const pitCount = {}; // { idAnnonce: { in: n, out: n, seen: bool } }
    function autoPit(live, nowMs) {
      if (nowMs - live.generatedAt > 90000) return;
      const api = autoPitRef.current;
      if (!api) return;
      // essais / qualification : le roulage démarre seul dès que le flux montre la voiture en piste (S1 franchi, plus aux stands)
      if ((settingsRef.current.eventType || "course") !== "course") {
        carsRef.current.forEach((car) => {
          const lc = live.cars[normalizeCarNumber(car.numero)];
          const st0 = stintsRef.current[car.id];
          if (!lc || (st0 && (st0.lastExitAt || (st0.log || []).length > 0))) {
            delete pitCount["run" + car.id];
            return;
          }
          const onTrack = !isPitIn(lc.state) && lc.s1 != null;
          const n = onTrack ? (pitCount["run" + car.id] || 0) + 1 : 0;
          pitCount["run" + car.id] = n;
          if (n >= 2) {
            // le départ réel = passage constaté de S1 moins le temps de S1 : on ajoute ce temps au début du relais
            api.startRun(car.id, nowMs - (lc.s1 > 0 && lc.s1 < 600000 ? lc.s1 : 0));
            delete pitCount["run" + car.id];
          }
        });
      }
      carsRef.current.forEach((car) => {
        const lc = live.cars[normalizeCarNumber(car.numero)];
        if (!lc) return;
        const call = callsRef.current.find((c) => c.carId === car.id);
        if (!call) {
          // entrée aux stands NON annoncée : la voix prévient dès que RIS voit la voiture rentrer (course uniquement, une seule fois par passage)
          const key = "free" + car.id;
          const f = pitCount[key] || (pitCount[key] = { in: 0, out: 0, wasOut: false, said: false });
          const inP = isPitIn(lc.state);
          f.in = inP ? f.in + 1 : 0;
          f.out = inP ? 0 : f.out + 1;
          if (f.out >= 2) { f.wasOut = true; f.said = false; }
          if ((settingsRef.current.eventType || "course") === "course" && f.in >= 2 && f.wasOut && !f.said) {
            f.said = true;
            api.speakUnannounced(car.numero);
          }
          return;
        }
        const st = pitCount[call.id] || (pitCount[call.id] = { in: 0, out: 0, seen: false });
        const inPit = isPitIn(lc.state);
        st.in = inPit ? st.in + 1 : 0;
        st.out = inPit ? 0 : st.out + 1;
        if (call.phase === "countdown") {
          if (st.in >= 1) {
            api.forceArrival(call.id);
            api.speakEntry(call.numero);
            st.seen = true;
          }
        } else if (call.phase === "instand") {
          if (inPit) st.seen = true;
          else if (st.seen && st.out >= 2) {
            delete pitCount[call.id];
            api.removeCall(call.id);
          }
        }
      });
    }

    // historique des messages RC : le poste Admin qui relaie note chaque nouveau message avec l'heure
    // à laquelle il apparaît (l'heure "at" du flux est celle de la génération du flux, pas de la parution)
    let rcPrev = null;
    function recordRc(live, nowMs) {
      const msgs = live.rc || [];
      const log = Array.isArray(settingsRef.current.rcLog) ? settingsRef.current.rcLog : [];
      const added = [];
      msgs.forEach((e) => {
        const isNew = rcPrev ? !rcPrev.has(e.id + "|" + e.message) : !log.some((l) => l.m === e.message);
        if (isNew) added.push({ t: nowMs, m: e.message });
      });
      rcPrev = new Set(msgs.map((e) => e.id + "|" + e.message));
      if (added.length > 0) pushSettings({ ...settingsRef.current, rcLog: [...log, ...added].slice(-300) });
    }

    // traite un flux reçu (lecture directe ou page RIS) : l'écrit dans Supabase pour tous les
    // postes, applique les drapeaux automatiques et met à jour l'état du relais
    async function ingest(raw, via, srcUuid) {
      {
        lastRawRef.current = raw;
        const live = parseLiveTiming(raw);
        const nowMs = Date.now();
        let writeError = "";
        if (live.seq !== lastSeq || nowMs - lastWriteAt >= 10000) {
          const payload = {
            uuid: srcUuid,
            seq: live.seq,
            generatedAt: live.generatedAt,
            fetchedAt: nowMs,
            status: live.status,
            trackStateRaw: live.trackStateRaw,
            elapsedMs: live.elapsedMs,
            remainingMs: live.remainingMs,
            rc: live.rc,
            cars: live.cars,
          };
          const { error } = await supabase
            .from("live_timing")
            .upsert({ id: 1, data: payload, updated_at: new Date(nowMs).toISOString() });
          if (error) writeError = error.message || "écriture Supabase refusée";
          else {
            lastSeq = live.seq;
            lastWriteAt = nowMs;
          }
        }
        applyAutoFlag(live, nowMs);
        try {
          recordBests(live);
          recordRc(live, nowMs);
          autoPit(live, nowMs);
        } catch (e) {}
        if (!stopped) {
          setRelayStatus({
            ok: !writeError,
            error: writeError ? `Supabase : ${writeError} (la table live_timing existe-t-elle ?)` : "",
            via,
            at: nowMs,
            generatedAt: live.generatedAt,
            nCars: Object.keys(live.cars).length,
            trackStateRaw: live.trackStateRaw,
            status: live.status,
          });
        }
        // mode "page" : l'uuid vient de la page RIS, on le mémorise pour que tous les postes
        // reconnaissent le flux (changer l'uuid redémarre ce relais, sans conséquence)
        if (pageMode && srcUuid && srcUuid !== (settingsRef.current.liveUuid || "").trim()) {
          pushSettings({ ...settingsRef.current, liveUuid: srcUuid });
        }
      }
    }

    const showError = (e) => {
      if (!stopped) setRelayStatus({ ok: false, error: (e && e.message) || String(e), at: Date.now() });
    };

    // un script Python (ris_relais.py) alimente déjà live_timing : le navigateur ne lit plus le flux (il n'est ni ralenti ni mis en pause),
    // il se contente d'appliquer drapeaux, records et entrées/sorties de stand sur ce que le script écrit. Si le script s'arrête, le navigateur reprend seul.
    const scriptAlive = () => {
      const r = liveRowRef.current;
      return !!(r && r.src === "script" && Date.now() - r.fetchedAt < 12000);
    };
    scriptIngestRef.current = (row) => {
      if (stopped || !row || row.src !== "script" || Date.now() - row.fetchedAt >= 12000) return;
      if (!pageMode && row.uuid !== uuid) return;
      const nowMs = Date.now();
      const live = { ...row, flag: normalizeTrackState(row.trackStateRaw) };
      applyAutoFlag(live, nowMs);
      try {
        recordBests(live);
        recordRc(live, nowMs);
        autoPit(live, nowMs);
      } catch (e) {}
      setRelayStatus({ ok: true, error: "", via: "script", at: nowMs, generatedAt: live.generatedAt, nCars: Object.keys(live.cars).length, trackStateRaw: live.trackStateRaw, status: live.status });
    };

    async function tick(quiet) {
      if (busy || stopped || scriptAlive()) return;
      busy = true;
      try {
        const { raw, via } = await fetchLiveTiming(uuid);
        if (stopped) return;
        await ingest(raw, via, uuid);
      } catch (e) {
        if (!quiet) showError(e);
      } finally {
        busy = false;
      }
    }

    if (pageMode) {
      // flux transmis par la page RIS (favori) : seuls les messages venant de RIS sont acceptés
      const onMessage = (event) => {
        const msg = readRisMessage(event);
        if (!msg || scriptAlive()) return;
        ingest(msg.raw, "page", msg.uuid || uuid).catch(showError);
      };
      let lastPageMsgAt = Date.now();
      relayKickRef.current = () => {
        lastSeq = null;
        busy = false;
        if (/^[0-9a-fA-F-]{36}$/.test(uuid)) tick();
      };
      const onPageMessage = (event) => {
        if (readRisMessage(event)) lastPageMsgAt = Date.now();
        onMessage(event);
      };
      window.addEventListener("message", onPageMessage);
      // reconnexion automatique : si la page RIS ne transmet plus rien (page rechargée, favori perdu, onglet fermé),
      // PitBoard lit lui-même le flux (lecture directe, puis relais Vercel) tant que la page ne reprend pas la main
      // en parallèle, lecture directe toutes les 3 s : la page RIS ne rafraîchit pas assez vite pour l'entrée / sortie des stands
      // (erreurs silencieuses tant que la page transmet : la lecture directe n'est qu'un renfort)
      const fallback = setInterval(() => {
        if (/^[0-9a-fA-F-]{36}$/.test(uuid)) tick(Date.now() - lastPageMsgAt <= 15000);
      }, 3000);
      return () => {
        stopped = true;
        relayKickRef.current = null;
        scriptIngestRef.current = null;
        clearInterval(fallback);
        window.removeEventListener("message", onPageMessage);
      };
    }

    relayKickRef.current = () => {
      lastSeq = null; // force une nouvelle écriture dans Supabase
      busy = false;
      tick();
    };
    tick();
    const timer = setInterval(tick, 3000);
    return () => {
      stopped = true;
      relayKickRef.current = null;
      scriptIngestRef.current = null;
      clearInterval(timer);
    };
  }, [isAdmin, settings.liveEnabled, settings.liveUuid, settings.liveSource]);

  // données écrites par le script Python : appliquées dès leur arrivée (événement Realtime, pas de minuterie du navigateur)
  useEffect(() => {
    if (isAdmin && liveRow && liveRow.src === "script" && scriptIngestRef.current) scriptIngestRef.current(liveRow);
  }, [liveRow, isAdmin]);

  // quand on (dés)active les drapeaux auto, on repart de zéro : plus de commande manuelle en attente
  useEffect(() => {
    manualOverrideRef.current = null;
  }, [settings.liveFlagAuto, settings.liveUuid]);

  // -- helpers de mappage app -> lignes Supabase --
  function carToRow(c) {
    return {
      id: c.id,
      numero: c.numero || "",
      pilote: c.pilote || "",
      team: c.team || "",
      couleur1: c.couleur1,
      couleur2: c.couleur2,
      classement: c.classement || null,
      initial_conso_l100: c.initialConsoL100 === "" || c.initialConsoL100 == null ? null : Number(c.initialConsoL100),
    };
  }

  // met à jour uniquement les voitures qui ont réellement changé (pas de réécriture globale)
  async function pushCars(next) {
    const prev = cars;
    setCars(next);
    try {
      const prevById = new Map(prev.map((c) => [c.id, c]));
      const nextIds = new Set(next.map((c) => c.id));
      const toUpsert = next.filter((c) => JSON.stringify(prevById.get(c.id)) !== JSON.stringify(c));
      const toDelete = prev.filter((c) => !nextIds.has(c.id));
      if (toUpsert.length > 0) {
        await supabase.from("cars").upsert(toUpsert.map(carToRow));
      }
      for (const c of toDelete) {
        await supabase.from("cars").delete().eq("id", c.id);
      }
    } catch (e) {}
  }

  // annonces : nouvelle -> insert ; modifiée -> update ciblé ; retirée -> clôturée (jamais supprimée)
  async function pushCalls(next) {
    // on compare avec la ref (toujours à jour) et non avec le state de la fermeture : la
    // minuterie d'une seconde est créée une seule fois et verrait sinon un état périmé
    const prev = callsRef.current;
    callsRef.current = next;
    setCalls(next);
    try {
      const prevById = new Map(prev.map((c) => [c.id, c]));
      const nextIds = new Set(next.map((c) => c.id));
      for (const c of next) {
        const old = prevById.get(c.id);
        if (!old) {
          await supabase.from("pit_calls").insert({
            car_id: c.carId,
            numero: c.numero,
            pilote: c.pilote,
            couleur1: c.couleur1,
            couleur2: c.couleur2,
            tasks: c.tasks,
            fuel: c.fuel,
            phase: c.phase,
            arrival_at: c.arrivalAt ? new Date(c.arrivalAt).toISOString() : null,
            pit_start_at: c.pitStartAt ? new Date(c.pitStartAt).toISOString() : null,
            status: "active",
          });
        } else if (JSON.stringify(old) !== JSON.stringify(c)) {
          await supabase
            .from("pit_calls")
            .update({
              phase: c.phase,
              arrival_at: c.arrivalAt ? new Date(c.arrivalAt).toISOString() : null,
              pit_start_at: c.pitStartAt ? new Date(c.pitStartAt).toISOString() : null,
              tasks: c.tasks,
              fuel: c.fuel,
            })
            .eq("id", c.id);
        }
      }
      // annonces disparues de la liste active -> clôturées, jamais supprimées
      for (const c of prev) {
        if (!nextIds.has(c.id)) {
          const status = c.phase === "instand" ? "completed" : "cancelled";
          await supabase
            .from("pit_calls")
            .update({ status, ended_at: new Date().toISOString() })
            .eq("id", c.id);
        }
      }
    } catch (e) {}
  }

  // messages : éphémères -> nouveau = insert, disparu (expiré ou retiré) = delete
  async function pushMessages(next) {
    const prev = messagesRef.current;
    messagesRef.current = next;
    setMessages(next);
    try {
      const prevIds = new Set(prev.map((m) => m.id));
      const nextIds = new Set(next.map((m) => m.id));
      for (const m of next) {
        if (!prevIds.has(m.id)) {
          await supabase.from("team_messages").insert({
            car_id: m.carId,
            numero: m.numero,
            pilote: m.pilote,
            couleur1: m.couleur1,
            couleur2: m.couleur2,
            text: m.text,
          });
        }
      }
      for (const m of prev) {
        if (!nextIds.has(m.id)) {
          await supabase.from("team_messages").delete().eq("id", m.id);
        }
      }
    } catch (e) {}
  }

  // applique une séance du programme aux réglages de l'événement (type, début, durée, uuid RIS)
  function applySession(s) {
    const cur = settingsRef.current;
    pushSettings({
      ...cur,
      eventType: s.type,
      eventStartAt: s.startAt || "",
      eventDurationSec: s.durationSec || 0,
      ...(s.uuid ? { liveUuid: s.uuid } : {}),
      scheduleAppliedId: s.id,
    });
  }

  // réglages globaux : une seule ligne, simple update
  async function pushSettings(next) {
    settingsRef.current = next; // à jour tout de suite, avant même le prochain rendu
    setSettings(next);
    const stamp = Date.now();
    ownSettingsWritesRef.current = [...ownSettingsWritesRef.current, stamp].slice(-40);
    try {
      await supabase.from("app_settings").update({ data: next, updated_at: new Date(stamp).toISOString() }).eq("id", 1);
    } catch (e) {}
  }

  // relais : nouveau relais -> insert ; relais modifié (tours, temps à l'arrêt) -> update ciblé
  // par (voiture, n) ; relais en cours (lastExitAt) -> upsert dans stint_current
  async function pushStints(next) {
    const prev = stintsRef.current;
    stintsRef.current = next;
    setStints(next);
    try {
      for (const carIdStr of Object.keys(next)) {
        const carId = Number(carIdStr);
        if (!Number.isFinite(carId)) continue;
        const nextSt = next[carIdStr] || { lastExitAt: null, log: [] };
        const prevSt = prev[carIdStr] || { lastExitAt: null, log: [] };

        if (nextSt.lastExitAt !== prevSt.lastExitAt) {
          await supabase.from("stint_current").upsert({
            car_id: carId,
            last_exit_at: nextSt.lastExitAt ? new Date(nextSt.lastExitAt).toISOString() : null,
          });
        }

        const prevByN = new Map((prevSt.log || []).map((r) => [r.n, r]));
        for (const entry of nextSt.log || []) {
          const old = prevByN.get(entry.n);
          if (!old) {
            await supabase.from("stints").insert({
              car_id: carId,
              n: entry.n,
              duration_sec: toInt(entry.durationSec),
              laps: toIntOrNull(entry.laps),
              vert_sec: toInt(entry.vertSec),
              jaune_sec: toInt(entry.jauneSec),
              idle_sec: toInt(entry.idleSec),
              refueled: !!entry.refueled,
            });
          } else if (
            old.laps !== entry.laps ||
            (old.idleSec || 0) !== (entry.idleSec || 0) ||
            !!old.refueled !== !!entry.refueled
          ) {
            await supabase
              .from("stints")
              .update({
                laps: toIntOrNull(entry.laps),
                idle_sec: toInt(entry.idleSec),
                refueled: !!entry.refueled,
              })
              .eq("car_id", carId)
              .eq("n", entry.n);
          }
        }
      }
    } catch (e) {}
  }

  // historique des drapeaux : uniquement des ajouts en fin de liste (ou reset complet)
  async function pushFlagHistory(next) {
    const prevLen = flagHistory.length;
    setFlagHistory(next);
    try {
      if (next.length <= 1 && prevLen > 1) {
        // réinitialisation de la course : on repart d'un historique vierge
        await supabase.from("flag_history").delete().gte("id", 0);
        if (next.length === 1) {
          await supabase
            .from("flag_history")
            .insert({ flag: next[0].flag, ts: new Date(next[0].ts).toISOString() });
        }
      } else if (next.length > prevLen) {
        const added = next.slice(prevLen);
        await supabase
          .from("flag_history")
          .insert(added.map((e) => ({ flag: e.flag, ts: new Date(e.ts).toISOString() })));
      }
    } catch (e) {}
  }

  // remet à zéro toutes les données de course (annonces, messages, relais, fiches
  // techniques, historique des drapeaux, drapeau, dates de l'événement), en conservant
  // la configuration des voitures et les réglages techniques (pompes, réservoir, limites...)
  async function resetEvent() {
    const nowMs = Date.now();
    try {
      // les annonces actives en cours sont clôturées en "cancelled" (course réinitialisée)
      await supabase
        .from("pit_calls")
        .update({ status: "cancelled", ended_at: new Date().toISOString() })
        .eq("status", "active");
      await supabase.from("team_messages").delete().gte("id", 0);
      await supabase.from("stints").delete().gte("id", 0);
      await supabase.from("stint_current").delete().gte("car_id", 0);
      await supabase.from("technical_checks").delete().gte("id", 0);
      await supabase.from("flag_history").delete().gte("id", 0);
      await supabase
        .from("flag_history")
        .insert({ flag: "vert", ts: new Date(nowMs).toISOString() });
      await supabase
        .from("race_flag")
        .update({ value: "vert", updated_at: new Date(nowMs).toISOString() })
        .eq("id", 1);
    } catch (e) {}
    setCalls([]);
    setMessages([]);
    setStints({});
    setTechChecks({});
    setFlagHistory([{ flag: "vert", ts: nowMs }]);
    setFeedFlagHist(feedFlagLastRef.current && feedFlagLastRef.current !== "vert" ? [{ flag: feedFlagLastRef.current, ts: nowMs }] : []);
    setFlag("vert");
    lastKnownFlagRef.current = "vert";
    flagTsRef.current = nowMs;
    // les pilotes et leur ordre sont conservés, seuls les relais confirmés sont effacés
    pushSettings({
      ...settings,
      eventStartAt: "",
      eventDurationSec: 0,
      drivers: resetDriverRelays(settings.drivers),
      rcLog: [],
      feedFlagLog: [],
    });
    setRcLocal([]);
    try {
      localStorage.removeItem(rcLocalKey);
    } catch {
      /* stockage indisponible */
    }
    setExpandedTiles(new Set());
    setConfirmExitId(null);
    setTechCarId("");
    setConfirmReset(false);
  }

  // exporte un résumé CSV complet de l'événement (relais, carburant) par voiture
  function exportEventSummary() {
    const csvEscape = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
    const rows = [
      [
        "Voiture",
        "Team",
        "Team manager",
        "Classement",
        "Relais n°",
        "Pilote du relais",
        "Durée relais",
        "Tours",
        "Temps vert",
        "Temps jaune",
        "Essence ajoutée (L)",
      ],
    ];
    configuredCars.forEach((car) => {
      const log = (stints[car.id] && stints[car.id].log) || [];
      const tech = techChecks[car.id] || [];
      if (log.length === 0) {
        rows.push([
          car.numero,
          car.team || "",
          car.pilote || "",
          rankOf(car) || "",
          "", "", "", "", "", "", "",
        ]);
        return;
      }
      const dcfg = getCfg(settings.drivers, car.id);
      log.forEach((r, i) => {
        const t = tech[i] || {};
        const rd = dcfg.list.find((d) => d.id === resolveRelay(dcfg, r.n).id);
        rows.push([
          car.numero,
          car.team || "",
          car.pilote || "",
          rankOf(car) || "",
          r.n,
          driverName(rd),
          fmtTimeHMS(r.durationSec),
          r.laps || "",
          fmtTimeHMS(r.vertSec || 0),
          fmtTimeHMS(r.jauneSec || 0),
          t.fuelL || "",
        ]);
      });
    });
    const csv = rows.map((r) => r.map(csvEscape).join(";")).join("\n");
    // le déclenchement automatique d'un téléchargement de fichier est souvent bloqué par le
    // bac à sable de l'artifact (comme window.confirm plus tôt) : on affiche plutôt le
    // résultat dans l'app, avec un bouton "Copier" fiable dans tous les environnements
    setExportCopyStatus("");
    setExportCsvText(csv);
  }

  // calcule le temps passé sous chaque drapeau entre deux instants, à partir de l'historique
  function computeFlagSplit(startMs, endMs, history) {
    const sorted = [...history].sort((a, b) => a.ts - b.ts);
    let currentFlag = "vert";
    let cursor = startMs;
    let vertSec = 0;
    let jauneSec = 0;
    let rougeSec = 0;
    sorted.forEach((h) => {
      if (h.ts <= startMs) {
        currentFlag = h.flag;
        return;
      }
      if (h.ts >= endMs) return;
      const dur = Math.max(0, (h.ts - cursor) / 1000);
      if (currentFlag === "vert") vertSec += dur;
      else if (currentFlag === "jaune") jauneSec += dur;
      else if (currentFlag === "rouge") rougeSec += dur;
      cursor = h.ts;
      currentFlag = h.flag;
    });
    const dur = Math.max(0, (endMs - cursor) / 1000);
    if (currentFlag === "vert") vertSec += dur;
    else if (currentFlag === "jaune") jauneSec += dur;
    else if (currentFlag === "rouge") rougeSec += dur;
    return { vertSec, jauneSec, rougeSec };
  }

  // --- MOTEUR CARBURANT (estimation) ---
  // calibre la consommation d'une voiture à partir de ses relais terminés (temps vert/jaune)
  // et de l'essence réellement ajoutée à l'arrêt suivant (litres ajoutés, même index que le relais)
  function computeCarFuelModel(carId) {
    const log = (stints[carId] && stints[carId].log) || [];
    const tech = techChecks[carId] || [];
    const samples = [];
    // un échantillon de calibration ne se clôt qu'au relais dont l'arrêt suivant a réellement
    // fait le plein (fuel = Oui) ; si "Non" est coché, la consommation continue de s'accumuler
    // sur les relais suivants sans réinitialiser le cycle
    let runDistGreen = 0;
    let runDistYellow = 0;
    let runIdleSec = 0;
    log.forEach((r, i) => {
      runDistGreen += (r.vertSec / 3600) * settings.greenSpeedKmh;
      runDistYellow += (r.jauneSec / 3600) * settings.yellowSpeedKmh;
      runIdleSec += r.idleSec || 0;
      if (r.refueled) {
        const rec = tech[i];
        const litres = rec ? Number(rec.fuelL) : NaN;
        if (!isNaN(litres) && litres > 0) {
          // le temps passé à l'arrêt au stand (0 km/h) consomme aussi du carburant (ralenti) :
          // on le déduit du litrage ajouté avant de l'attribuer à la distance parcourue,
          // pour ne pas fausser la calibration vert/jaune
          const idleLitres = (runIdleSec / 3600) * settings.idleConsoLh;
          const litresForDistance = Math.max(0, litres - idleLitres);
          // garde-fou : une consommation hors 3–80 L/100 km vient d'une saisie ou d'un relais incohérent -> ignorée
          const dKm = runDistGreen + runDistYellow;
          const c100 = dKm > 0 ? (litresForDistance / dKm) * 100 : 0;
          if (dKm > 0 && c100 >= 3 && c100 <= 80) {
            samples.push({ distGreen: runDistGreen, distYellow: runDistYellow, litres: litresForDistance });
          }
        }
        runDistGreen = 0;
        runDistYellow = 0;
        runIdleSec = 0;
      }
    });
    if (samples.length === 0) {
      // course en cours et aucune donnée de relais encore calibrée : on démarre avec la
      // consommation initiale propre à cette voiture, dès le relais 1
      {
        const car = cars.find((c) => c.id === carId);
        const initial = car ? Number(car.initialConsoL100) : NaN;
        if (!isNaN(initial) && initial > 0) {
          return {
            calibrated: true,
            hasSplit: false,
            Csimple: initial / 100,
            Cgreen: null,
            Cyellow: null,
            n: 0,
          };
        }
      }
      return { calibrated: false, hasSplit: false, Csimple: null, Cgreen: null, Cyellow: null, n: 0 };
    }
    const totalLitres = samples.reduce((s, x) => s + x.litres, 0);
    const totalDist = samples.reduce((s, x) => s + x.distGreen + x.distYellow, 0);
    const Csimple = totalDist > 0 ? totalLitres / totalDist : null;

    let Cgreen = null;
    let Cyellow = null;
    let hasSplit = false;
    if (samples.length >= 2) {
      // régression aux moindres carrés à 2 inconnues (équations normales)
      let a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0;
      samples.forEach((s) => {
        a11 += s.distGreen * s.distGreen;
        a12 += s.distGreen * s.distYellow;
        a22 += s.distYellow * s.distYellow;
        b1 += s.distGreen * s.litres;
        b2 += s.distYellow * s.litres;
      });
      const det = a11 * a22 - a12 * a12;
      if (Math.abs(det) > 1e-6) {
        Cgreen = (b1 * a22 - a12 * b2) / det;
        Cyellow = (a11 * b2 - a12 * b1) / det;
        if (Cgreen >= 0 && Cyellow >= 0) hasSplit = true;
      }
    }
    return { calibrated: true, hasSplit, Csimple, Cgreen, Cyellow, n: samples.length };
  }

  // estimation live du carburant pour la voiture actuellement en piste (entre 2 arrêts)
  function computeLiveFuelEstimate(carId, nowMs) {
    const st = stints[carId];
    if (!st || !st.lastExitAt) return null;

    // cumule les relais depuis le dernier vrai ravitaillement (fuel = Oui) : si un arrêt
    // précédent avait "Non" coché, sa consommation reste comptabilisée sans réinitialisation
    const log = st.log || [];
    let startIdx = 0;
    for (let i = log.length - 1; i >= 0; i--) {
      if (log[i].refueled) {
        startIdx = i + 1;
        break;
      }
    }
    let carriedDistGreen = 0;
    let carriedDistYellow = 0;
    for (let i = startIdx; i < log.length; i++) {
      carriedDistGreen += (log[i].vertSec / 3600) * settings.greenSpeedKmh;
      carriedDistYellow += (log[i].jauneSec / 3600) * settings.yellowSpeedKmh;
    }

    const split = computeFlagSplit(st.lastExitAt, nowMs, flagHistoryEff);
    const distGreen = carriedDistGreen + (split.vertSec / 3600) * settings.greenSpeedKmh;
    const distYellow = carriedDistYellow + (split.jauneSec / 3600) * settings.yellowSpeedKmh;
    const distance = distGreen + distYellow;
    const model = computeCarFuelModel(carId);

    let litresConsumed = null;
    if (model.hasSplit) {
      litresConsumed = distGreen * model.Cgreen + distYellow * model.Cyellow;
    } else if (model.Csimple !== null) {
      litresConsumed = distance * model.Csimple;
    }

    if (litresConsumed === null) {
      return { calibrated: false, distance, n: model.n };
    }

    const fuelRemaining = settings.tankCapacityL - litresConsumed;
    const pct = settings.tankCapacityL > 0 ? (fuelRemaining / settings.tankCapacityL) * 100 : null;
    const consumptionL100 = distance > 0 ? (litresConsumed / distance) * 100 : null;
    const totalFlagSec = split.vertSec + split.jauneSec;
    const weightedSpeed =
      totalFlagSec > 0
        ? (split.vertSec * settings.greenSpeedKmh + split.jauneSec * settings.yellowSpeedKmh) / totalFlagSec
        : settings.greenSpeedKmh;
    const autonomyKm = consumptionL100 && consumptionL100 > 0 ? fuelRemaining / (consumptionL100 / 100) : null;
    const autonomyMin = autonomyKm !== null && weightedSpeed > 0 ? (autonomyKm / weightedSpeed) * 60 : null;
    let status = "OK";
    if (pct !== null) {
      if (pct < settings.fuelCritPct) status = "CRITICAL";
      else if (pct < settings.fuelWarnPct) status = "WARNING";
    }
    return {
      calibrated: true,
      distance,
      litresConsumed,
      fuelRemaining,
      pct,
      consumptionL100,
      autonomyKm,
      autonomyMin,
      status,
      n: model.n,
    };
  }

  // essais : distance et temps de roulage cumulés depuis le plein de départ (ou le dernier ravitaillement enregistré)
  function computeEssaisRun(carId, nowMs) {
    const st = stints[carId];
    const log = (st && st.log) || [];
    let startIdx = 0;
    for (let i = log.length - 1; i >= 0; i--) {
      if (log[i].refueled) {
        startIdx = i + 1;
        break;
      }
    }
    let vertSec = 0;
    let jauneSec = 0;
    for (let i = startIdx; i < log.length; i++) {
      vertSec += log[i].vertSec || 0;
      jauneSec += log[i].jauneSec || 0;
    }
    if (st && st.lastExitAt) {
      const split = computeFlagSplit(st.lastExitAt, nowMs, flagHistoryEff);
      vertSec += split.vertSec;
      jauneSec += split.jauneSec;
    }
    const distance = (vertSec / 3600) * settings.greenSpeedKmh + (jauneSec / 3600) * settings.yellowSpeedKmh;
    return { vertSec, jauneSec, distance };
  }

  function logStintEnd(carId, refueled) {
    const st = stintsRef.current[carId] || { lastExitAt: null, log: [] };
    if (st.lastExitAt) {
      const nowMs = Date.now();
      const durationSec = Math.round((nowMs - st.lastExitAt) / 1000);
      const { vertSec, jauneSec } = computeFlagSplit(st.lastExitAt, nowMs, flagHistoryRef2.current);
      // tours du relais = tour atteint maintenant - tour atteint à la fin du relais précédent (flux live)
      const relayN = st.log.length + 1;
      const carObj = carsRef.current.find((c) => c.id === carId);
      const lv = carObj ? liveFor(carObj) : null;
      const cfgOrig = getCfg(settingsRef.current.drivers, carId);
      let cfg0 = cfgOrig;
      let autoLaps = null;
      if (lv && lv.laps != null) {
        cfg0 = setEndLap(cfg0, relayN, lv.laps);
        autoLaps = relayLapsFromEnds(cfg0, relayN);
      }
      const newLog = [
        ...st.log,
        {
          n: relayN,
          durationSec,
          laps: autoLaps != null ? autoLaps : "",
          vertSec: Math.round(vertSec),
          jauneSec: Math.round(jauneSec),
          refueled: !!refueled,
        },
      ];
      pushStints({ ...stintsRef.current, [carId]: { lastExitAt: null, log: newLog } });
      // fige le pilote (prévu ou confirmé) du relais qui vient de se terminer
      const frozen = freezeRelay(cfg0, relayN);
      if (frozen !== cfgOrig) pushDriversCfg(carId, frozen);
    }
  }

  // pilotes : une seule écriture dans les réglages partagés (pas de table supplémentaire)
  function pushDriversCfg(carId, cfg) {
    const cur = settingsRef.current;
    pushSettings({ ...cur, drivers: { ...(cur.drivers || {}), [carId]: cfg } });
  }

  function confirmRelayDriver(carId, n, driverId) {
    pushDriversCfg(carId, setRelayDriver(getCfg(settingsRef.current.drivers, carId), n, driverId));
  }

  // état des pilotes d'une voiture à l'instant "now" : pilote du relais en cours (ou à venir) et
  // temps de roulage cumulé par pilote ; null si aucun pilote n'est encodé pour cette voiture
  function driverStatsFor(car) {
    const cfg = getCfg(settings.drivers, car.id);
    if (cfg.list.length === 0) return null;
    const st = stints[car.id] || { lastExitAt: null, log: [] };
    const log = st.log || [];
    const n = log.length + 1;
    let current = null;
    if (st.lastExitAt) {
      const split = computeFlagSplit(st.lastExitAt, now, flagHistoryEff);
      const lvNow = liveFor(car);
      const prevEnd = endLapOf(cfg, n - 1);
      current = {
        n,
        durationSec: Math.max(0, (now - st.lastExitAt) / 1000),
        vertSec: split.vertSec,
        jauneSec: split.jauneSec,
        laps: lvNow && lvNow.laps != null && prevEnd != null ? Math.max(0, lvNow.laps - prevEnd) : 0,
      };
    }
    const cur = resolveRelay(cfg, n);
    return {
      cfg,
      n,
      onTrack: !!st.lastExitAt,
      drivenN: log.length + (st.lastExitAt ? 1 : 0),
      cur,
      curDriver: cfg.list.find((d) => d.id === cur.id) || null,
      prevId: n > 1 ? resolveRelay(cfg, n - 1).id : null,
      totals: driverTotals(cfg, log, current),
    };
  }

  // essais : le team manager (ou l'admin) indique que la voiture est partie sur la piste ; la consommation démarre à ce moment
  function startRun(carId, startAt) {
    const st = stintsRef.current[carId] || { lastExitAt: null, log: [] };
    if (st.lastExitAt) return;
    pushStints({ ...stintsRef.current, [carId]: { ...st, lastExitAt: typeof startAt === "number" && startAt > 0 ? startAt : Date.now() } });
  }
  // essais : annule un lancement fait par erreur (seulement avant le premier arrêt)
  function cancelRun(carId) {
    const st = stintsRef.current[carId] || { lastExitAt: null, log: [] };
    if (!st.lastExitAt || (st.log || []).length > 0) return;
    pushStints({ ...stintsRef.current, [carId]: { ...st, lastExitAt: null } });
  }

  function logStintExit(carId, idleSec) {
    const st = stintsRef.current[carId] || { lastExitAt: null, log: [] };
    // le temps passé au stand (vitesse 0 km/h) est rattaché au relais qui vient de se
    // terminer, pour que la consommation au ralenti soit prise en compte dans le calcul
    const newLog =
      idleSec > 0 && st.log.length > 0
        ? st.log.map((r, i) => (i === st.log.length - 1 ? { ...r, idleSec } : r))
        : st.log;
    pushStints({ ...stintsRef.current, [carId]: { lastExitAt: Date.now(), log: newLog } });
  }

  function updateStintLaps(carId, n, laps) {
    const st = stintsRef.current[carId] || { lastExitAt: null, log: [] };
    const newLog = st.log.map((r) => (r.n === n ? { ...r, laps } : r));
    pushStints({ ...stintsRef.current, [carId]: { ...st, log: newLog } });
  }

  // crée automatiquement une nouvelle ligne de ravitaillement vierge pour la voiture, dès son entrée au
  // stand ; insert direct (l'id réel vient de Supabase, plus d'id temporaire local)
  async function createTechRecord(carId) {
    try {
      const { data, error } = await supabase
        .from("technical_checks")
        .insert({ car_id: carId })
        .select()
        .single();
      if (error || !data) return;
      const newRecord = {
        id: data.id,
        ts: new Date(data.ts).getTime(),
        fuelL: "",
      };
      setTechChecks((prev) => {
        const list = prev[carId] || [];
        if (list.some((r) => r.id === newRecord.id)) return prev;
        return { ...prev, [carId]: [...list, newRecord] };
      });
      setTechCarId(String(carId));
    } catch (e) {}
  }

  // met à jour les litres d'un ravitaillement : update Supabase ciblé par id
  async function updateTechRecord(carId, recordId, patch) {
    setTechChecks((prev) => {
      const list = prev[carId] || [];
      return { ...prev, [carId]: list.map((r) => (r.id === recordId ? { ...r, ...patch } : r)) };
    });
    const fieldMap = { fuelL: "fuel_l" };
    const numericFields = new Set(["fuelL"]);
    const dbPatch = {};
    for (const key of Object.keys(patch)) {
      const col = fieldMap[key];
      if (!col) continue;
      const v = patch[key];
      dbPatch[col] = v === "" ? null : numericFields.has(key) ? Number(v) : v;
    }
    try {
      await supabase.from("technical_checks").update(dbPatch).eq("id", recordId);
    } catch (e) {}
  }

  async function addMessage() {
    setMError("");
    if (!mCar) {
      setMError("Sélectionnez une voiture.");
      return;
    }
    const car = configuredCars.find((c) => c.id === Number(mCar));
    if (!car) {
      setMError("Voiture introuvable — vérifiez la configuration.");
      return;
    }
    const text = mText.trim();
    if (!text) {
      setMError("Écrivez un message.");
      return;
    }

    // insertion directe : l'ID réel vient de Supabase (même correctif que pour les
    // annonces — un ID temporaire local ne pouvait jamais être supprimé correctement
    // de la base, d'où la répétition du message au lieu de sa disparition après 1 min)
    let data, error;
    try {
      ({ data, error } = await supabase
        .from("team_messages")
        .insert({
          car_id: car.id,
          numero: car.numero,
          pilote: car.pilote,
          couleur1: car.couleur1,
          couleur2: car.couleur2,
          text,
        })
        .select()
        .single());
    } catch (e) {
      setMError("Erreur réseau lors de l'envoi — réessayez.");
      return;
    }
    if (error || !data) {
      setMError("Erreur lors de l'enregistrement du message — réessayez.");
      return;
    }

    const newMsg = messageRowToApp(data);
    setMessages((prev) => (prev.some((m) => m.id === newMsg.id) ? prev : [...prev, newMsg]));
    if (soundOnRef.current) speakMessage(audioCtxRef, newMsg.numero, newMsg.pilote, newMsg.text);
    justAddedMessageLocallyRef.current.add(newMsg.id);
    setTimeout(() => justAddedMessageLocallyRef.current.delete(newMsg.id), 4000);
    setMText("");
    setMCar(myCarIdRef.current != null ? String(myCarIdRef.current) : "");
    if (myCarIdRef.current != null) setModal(null); // team manager : la fenêtre se ferme après l'envoi
  }

  // litres envoyés : plus de clignotement, la fenêtre se ferme
  function ackTech(carId, recordId) {
    setTechAck((prev) => {
      const next = { ...prev, [carId]: recordId };
      try {
        localStorage.setItem("pitboard_techack", JSON.stringify(next));
      } catch (e) {}
      return next;
    });
    setModal(null);
  }

  function removeMessage(id) {
    pushMessages(messages.filter((m) => m.id !== id));
  }

  async function pushFlag(next) {
    const prev = flag;
    const nowMs = Date.now();

    // sous drapeau jaune, les voitures ralentissent : le temps restant avant l'arrêt double
    // au retour du drapeau vert, il revient à la normale (divisé par 2)
    if (next === "jaune" && prev !== "jaune") {
      const adjusted = calls.map((c) => {
        if (c.phase !== "countdown") return c;
        const remaining = Math.round((c.arrivalAt - nowMs) / 1000);
        if (remaining <= 0) return c;
        return { ...c, arrivalAt: nowMs + remaining * 2 * 1000 };
      });
      pushCalls(adjusted);
    } else if (prev === "jaune" && next === "vert") {
      const adjusted = calls.map((c) => {
        if (c.phase !== "countdown") return c;
        const remaining = Math.round((c.arrivalAt - nowMs) / 1000);
        if (remaining <= 0) return c;
        return { ...c, arrivalAt: nowMs + Math.round(remaining / 2) * 1000 };
      });
      pushCalls(adjusted);
    }

    const ts = Date.now();
    setFlag(next);
    // on connaît déjà la valeur et l'horodatage qu'on vient de définir localement :
    // toute écriture plus ancienne reçue plus tard (d'un autre poste) sera ignorée
    lastKnownFlagRef.current = next;
    flagTsRef.current = ts;
    pushFlagHistory([...flagHistoryRef.current, { flag: next, ts }]);
    if (soundOnRef.current) {
      const texts = flagAnnouncementTexts(prev, next);
      if (texts.length > 0) speakFlagSequence(audioCtxRef, texts);
    }
    try {
      await supabase
        .from("race_flag")
        .update({ value: next, updated_at: new Date(ts).toISOString() })
        .eq("id", 1);
    } catch (e) {}
  }
  // le relais live tourne dans une minuterie créée une seule fois : il doit toujours appeler
  // la version la plus récente de pushFlag (état `flag` et `calls` à jour)
  pushFlagRef.current = pushFlag;
  autoPitRef.current = { forceArrival, removeCall, startRun, speakEntry: (num) => { if (soundOnRef.current) speakTrackPoint(audioCtxRef, num, "Entrée"); }, speakUnannounced: (num) => { if (soundOnRef.current) speakJob(() => playBeep(audioCtxRef), () => stationUtter(`Attention. La voiture numéro ${num} rentre aux stands. Entrée non annoncée.`), pickStationVoice); } };

  const theme = FLAGS[flag];
  const bgStyle =
    flag === "jaune" || fcyActive
      ? flash
        ? { backgroundColor: "#111111", backgroundImage: "none" }
        : { backgroundColor: "#ffd400", backgroundImage: "none" }
      : {
          backgroundColor: theme.bg,
          backgroundImage: `linear-gradient(160deg, ${theme.bg} 0%, ${theme.bg2} 100%)`,
        };

  // grille de départ : chaque voiture configurée = un encart permanent.
  // priorité 1 : voitures avec une annonce active, triées par temps restant (le plus urgent en premier)
  // priorité 2 : voitures sans annonce, triées par classement général (manuel)
  const carTiles = useMemo(() => {
    const withCall = [];
    const idle = [];
    configuredCars.forEach((car) => {
      const call = calls.find((c) => c.carId === car.id);
      if (call) withCall.push({ car, call });
      else idle.push({ car, call: null });
    });
    withCall.sort((a, b) => sortKey(a.call, now) - sortKey(b.call, now));
    // classement du flux live si disponible ; les voitures absentes du flux passent après
    const liveActive = !!(liveInfo && liveInfo.relayAlive);
    const sortKeyIdle = (car) => {
      const l = liveFor(car);
      if (l && l.pos) return l.pos;
      return (liveActive ? 1000 : 0) + (car.classement || car.id);
    };
    idle.sort((a, b) => sortKeyIdle(a.car) - sortKeyIdle(b.car));
    return [...withCall, ...idle];
  }, [configuredCars, calls, now, liveInfo]);

  // animation FLIP : quand l'ordre des encarts change (ex. après "voiture quitte les
  // stands"), on les fait glisser lentement (~2,5s) vers leur nouvelle position au lieu
  // d'un repositionnement instantané
  const tileNodesRef = useRef({});
  const prevTileRectsRef = useRef({});
  const tileOrderSignature = carTiles.map((t) => t.car.id).join(",");
  useLayoutEffect(() => {
    const nodes = tileNodesRef.current;
    const newRects = {};
    Object.keys(nodes).forEach((id) => {
      const node = nodes[id];
      if (node) newRects[id] = node.getBoundingClientRect();
    });
    const prevRects = prevTileRectsRef.current;
    Object.keys(newRects).forEach((id) => {
      const prev = prevRects[id];
      const next = newRects[id];
      if (!prev) return;
      const dx = prev.left - next.left;
      const dy = prev.top - next.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      const node = nodes[id];
      if (!node) return;
      node.style.transition = "none";
      node.style.transform = `translate(${dx}px, ${dy}px)`;
      // force le navigateur à appliquer la position de départ avant d'animer vers 0
      node.getBoundingClientRect();
      requestAnimationFrame(() => {
        node.style.transition = "transform 2.5s ease-in-out";
        node.style.transform = "translate(0px, 0px)";
      });
    });
    prevTileRectsRef.current = newRects;
  }, [tileOrderSignature]);

  function updateCar(id, field, value) {
    const next = cars.map((c) => (c.id === id ? { ...c, [field]: value } : c));
    pushCars(next);
  }

  function addCarRow() {
    const nextId = cars.length > 0 ? Math.max(...cars.map((c) => c.id)) + 1 : 1;
    const pair = DEFAULT_PAIRS[(nextId - 1) % DEFAULT_PAIRS.length];
    const newCar = {
      id: nextId,
      numero: "",
      pilote: "",
      team: "",
      couleur1: pair[0],
      couleur2: pair[1],
      classement: nextId,
      initialConsoL100: "",
    };
    pushCars([...cars, newCar]);
  }

  function removeCarRow(id) {
    // les 6 voitures de base restent toujours présentes ; seules les voitures ajoutées peuvent être retirées
    if (id <= 6) return;
    pushCars(cars.filter((c) => c.id !== id));
  }

  async function submitAnnounce() {
    setFError("");
    if (!fCar) {
      setFError("Sélectionnez une voiture.");
      return;
    }
    const car = configuredCars.find((c) => c.id === Number(fCar));
    if (!car) {
      setFError("Voiture introuvable — vérifiez la configuration.");
      return;
    }

    if (fFuel !== "oui" && fFuel !== "non") {
      setFError("Précisez si la voiture doit faire le fuel (Oui ou Non).");
      return;
    }

    const mins = Number(fMin) || 0;
    const secs = Number(fSec) || 0;
    const estimatedSeconds = mins * 60 + secs;
    if (estimatedSeconds <= 0) {
      setFError("Indiquez le temps estimé avant l'arrêt.");
      return;
    }

    // limite du nombre de voitures pouvant faire le fuel en même temps (pompes disponibles)
    // désactivable sous drapeau jaune si le réglage correspondant est activé
    if (fFuel === "oui" && !(flag === "jaune" && settings.noFuelLimitOnYellow)) {
      const nowMs = Date.now();
      const activeFuelCalls = calls.filter((c) => c.fuel === "oui");
      if (activeFuelCalls.length >= settings.maxFuelSimultaneous) {
        const countdownRemainings = activeFuelCalls
          .map((c) => deriveCall(c, nowMs))
          .filter((d) => d.phase === "countdown")
          .map((d) => d.remaining);
        const lowest = countdownRemainings.length > 0 ? Math.min(...countdownRemainings) : 0;
        const requiredMinEntry = lowest + settings.waitOnTrackSec;
        if (estimatedSeconds < requiredMinEntry) {
          setFError(
            `Refus : temps d'attente en piste requis. Le temps estimé doit être d'au moins ${fmtTime(requiredMinEntry)} (chrono le plus bas actuel ${fmtTime(lowest)} + délai minimum ${fmtTime(settings.waitOnTrackSec)}).`
          );
          return;
        }
      }
    }

    const tasks = fTasks
      .split("\n")
      .map((t) => t.trim())
      .filter(Boolean);

    // insertion directe dans Supabase : l'ID réel vient de la base, plus d'ID temporaire
    // local qui ne correspondait jamais à l'ID généré par Supabase (c'était la cause des
    // annonces vocales dédoublées et du comptage de pompes faussé)
    let data, error;
    try {
      ({ data, error } = await supabase
        .from("pit_calls")
        .insert({
          car_id: car.id,
          numero: car.numero,
          pilote: car.pilote,
          couleur1: car.couleur1,
          couleur2: car.couleur2,
          tasks,
          fuel: fFuel,
          phase: "countdown",
          arrival_at: new Date(Date.now() + estimatedSeconds * 1000).toISOString(),
          status: "active",
        })
        .select()
        .single());
    } catch (e) {
      setFError("Erreur réseau lors de l'annonce — réessayez.");
      return;
    }
    if (error || !data) {
      setFError("Erreur lors de l'enregistrement de l'annonce — réessayez.");
      return;
    }

    const newCall = callRowToApp(data);
    setCalls((prev) => (prev.some((c) => c.id === newCall.id) ? prev : [...prev, newCall]));
    if (soundOnRef.current) {
      const secsLeft = (newCall.arrivalAt - Date.now()) / 1000;
      speakAnnouncement(audioCtxRef, newCall.numero, secsLeft);
    }
    // marque cet ID (le vrai, celui de Supabase) comme "déjà annoncé ici" pour que
    // l'écho Realtime de cette même insertion ne redéclenche pas la voix
    justAddedLocallyRef.current.add(newCall.id);
    setTimeout(() => justAddedLocallyRef.current.delete(newCall.id), 4000);
    setFCar(myCarIdRef.current != null ? String(myCarIdRef.current) : "");
    setFMin("");
    setFSec("");
    setFFuel("");
    setFTasks("");
    if (myCarIdRef.current != null) setModal(null); // team manager : la fenêtre se ferme après l'annonce
  }

  function removeCall(id) {
    const call = calls.find((c) => c.id === id);
    pushCalls(calls.filter((c) => c.id !== id));
    // si la voiture était bien au stand, sa sortie démarre le chrono du relais suivant,
    // et le temps passé à l'arrêt (0 km/h) est enregistré pour la consommation au ralenti
    if (call && call.phase === "instand") {
      const idleSec = call.pitStartAt ? Math.round((Date.now() - call.pitStartAt) / 1000) : 0;
      logStintExit(call.carId, idleSec);
    }
  }

  function forceArrival(id) {
    const call = calls.find((c) => c.id === id);
    const next = calls.map((c) =>
      c.id === id ? { ...c, phase: "instand", pitStartAt: Date.now() } : c
    );
    pushCalls(next);
    if (call) {
      logStintEnd(call.carId, call.fuel === "oui");
      createTechRecord(call.carId);
    }
  }

  function adjustCallTime(id, sec) {
    // sous drapeau jaune, le temps réglé via un point de piste est doublé
    // (comme pour toute annonce sous jaune), et sera divisé par 2 au retour du vert
    const effectiveSec = flag === "jaune" ? sec * 2 : sec;
    const next = calls.map((c) =>
      c.id === id ? { ...c, phase: "countdown", arrivalAt: Date.now() + effectiveSec * 1000 } : c
    );
    pushCalls(next);
  }

  // écran de code d'accès partagé, affiché avant tout le reste (mémorisé localement une
  // fois validé sur cet appareil)
  if (!accessGranted) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-neutral-900 px-4">
        <div className="max-w-sm w-full bg-black/60 border border-white/20 rounded-2xl p-6 flex flex-col gap-3">
          <h1 className="text-white text-xl font-black text-center mb-2">
            Tableau des arrêts — Accès équipe
          </h1>
          <p className="text-white/60 text-xs text-center mb-2">
            Entrez le code d'accès communiqué par votre équipe.
          </p>
          <input
            type="password"
            value={accessInput}
            onChange={(e) => setAccessInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && checkAccessCode()}
            placeholder="Code d'accès"
            autoFocus
            className="px-3 py-2 text-sm rounded-lg bg-black/50 text-white placeholder-white/40 border border-white/20 focus:outline-none focus:border-white"
          />
          {accessError && <p className="text-red-400 text-xs text-center">{accessError}</p>}
          <button
            onClick={checkAccessCode}
            className="w-full px-4 py-2 rounded-lg bg-white text-black font-bold text-sm hover:bg-white/90 transition-colors"
          >
            Entrer
          </button>
        </div>
      </div>
    );
  }

  // écran de sélection du rôle, affiché une seule fois par appareil (mémorisé localement)
  if (!role) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-neutral-900 px-4">
        <div className="max-w-sm w-full bg-black/60 border border-white/20 rounded-2xl p-6 flex flex-col gap-3">
          <h1 className="text-white text-xl font-black text-center mb-2">
            Tableau des arrêts — Choix du rôle
          </h1>
          <p className="text-white/60 text-xs text-center mb-2">
            À choisir une seule fois sur cet appareil. Read Only ne permet aucune modification.
          </p>
          {[
            { id: "admin", label: "Admin", desc: "Accès complet, réglages et réinitialisation" },
            { id: "manager", label: "Team Manager", desc: "Annonces, litres ajoutés, drapeaux" },
            { id: "pitwall", label: "Pit Wall", desc: "Annonces, litres ajoutés, drapeaux" },
            { id: "readonly", label: "Read Only", desc: "Consultation uniquement, aucune modification" },
          ].map((r) => (
            <button
              key={r.id}
              onClick={() => chooseRole(r.id)}
              className="w-full text-left px-4 py-2.5 rounded-lg bg-white/10 hover:bg-white/20 border border-white/20 transition-colors"
            >
              <div className="text-white font-bold text-sm">{r.label}</div>
              <div className="text-white/50 text-xs">{r.desc}</div>
            </button>
          ))}
        </div>
      </div>
    );
  }

  // team manager : choix de sa voiture (une seule fois par appareil), parmi celles que l'admin a encodées
  if (role === "manager" && !myCar) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-neutral-900 px-4">
        <div className="max-w-sm w-full bg-black/60 border border-white/20 rounded-2xl p-6 flex flex-col gap-3">
          <h1 className="text-white text-xl font-black text-center mb-2">Votre voiture</h1>
          {allConfiguredCars.length === 0 ? (
            <p className="text-white/70 text-sm text-center">
              Aucune voiture n'est encore encodée. L'admin doit d'abord saisir les numéros de voiture dans la
              configuration ; cette liste se mettra à jour toute seule.
            </p>
          ) : (
            <>
              <p className="text-white/60 text-xs text-center mb-2">
                Choisissez votre numéro : vous ne verrez ensuite que votre voiture.
              </p>
              {allConfiguredCars.map((c) => (
                <button
                  key={c.id}
                  onClick={() => chooseMyCar(c.id)}
                  className="w-full text-left px-4 py-2.5 rounded-lg bg-white/10 hover:bg-white/20 border border-white/20 transition-colors flex items-center gap-3"
                >
                  <span
                    className="w-3 h-8 rounded-sm flex-shrink-0"
                    style={{ background: `linear-gradient(${c.couleur1} 50%, ${c.couleur2} 50%)` }}
                  />
                  <span>
                    <span className="block text-white font-bold text-sm">#{c.numero}</span>
                    {c.team && <span className="block text-white/50 text-xs">{c.team}</span>}
                  </span>
                </button>
              ))}
            </>
          )}
          <button
            onClick={resetRoleAndCar}
            className="text-white/50 text-xs underline self-center mt-1 hover:text-white"
          >
            Changer de rôle
          </button>
        </div>
      </div>
    );
  }

  // bandeau rouge de la direction de course (RC), sur toute la largeur
  // bulletin météo (toutes les 30 min) : maintenant + prévisions des 2 heures suivantes
  const wxData = bulletin && now < bulletin.until ? buildBulletin(bulletin.w, now) : null;
  const wxBanner = wxData ? (
    <div className="mb-3 w-full rounded-xl px-4 py-3 flex items-start gap-3 shadow-lg" style={{ backgroundColor: wxData.rain ? "#7a3b00" : "#0b4a8f", border: `3px solid ${wxData.rain ? "#ffb020" : "#5cc8ff"}` }}>
      <div className="flex-1 min-w-0 text-white">
        <div className="text-white/80 text-[11px] font-bold uppercase tracking-widest">Bulletin météo · mis à jour à {fmtClock(now).slice(0, 5)}</div>
        <div className="text-xl sm:text-2xl font-black leading-snug">
          {wxData.now.text} · {wxData.now.temp.toFixed(1)} °C{wxData.now.wind != null ? ` · vent ${Math.round(wxData.now.wind)} km/h` : ""}
        </div>
        <div className="text-base sm:text-lg font-bold">{wxData.summary}</div>
        <div className="flex flex-wrap gap-x-5 gap-y-0.5 font-mono text-sm sm:text-base">
          {wxData.lines.map((l) => (
            <span key={l.time} style={l.wet ? { color: "#ffd27a", fontWeight: 800 } : undefined}>
              {l.time} · {l.temp != null ? l.temp.toFixed(0) + " °C" : "–"} · {l.text}{l.rain ? ` · ${l.rain}` : ""}
            </span>
          ))}
        </div>
      </div>
      <button onClick={() => setBulletin(null)} className="text-white/80 hover:text-white flex-shrink-0" title="Masquer le bulletin">
        <X size={20} />
      </button>
    </div>
  ) : null;
  const rcBanner =
    rcMessages.length > 0 ? (
      <div className="mb-3 flex flex-col gap-2 w-full">
        {rcMessages.map((m) => (
          <div
            key={m.key}
            className="rounded-xl px-4 py-3 flex items-start gap-3 shadow-lg animate-pulse"
            style={{ backgroundColor: "#c40000", border: "3px solid #ff4040", animationIterationCount: 3 }}
          >
            <AlertTriangle size={30} color="#fff" className="flex-shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="text-white/80 text-[11px] font-bold uppercase tracking-widest">
                Direction de course (RC)
                {m.nums.length > 0 && <> · voiture{m.nums.length > 1 ? "s" : ""} {m.nums.map((n) => "#" + n).join(" ")}</>}
              </div>
              <div className="text-white text-xl sm:text-2xl font-black leading-snug break-words">⚠ RC : {m.message}</div>
            </div>
            <button
              onClick={() => setRcDismissed((prev) => new Set(prev).add(m.key))}
              className="text-white/80 hover:text-white flex-shrink-0"
              title="Masquer ce message"
            >
              <X size={20} />
            </button>
          </div>
        ))}
      </div>
    ) : null;
  const visibleMessages = myCar ? messages.filter((m) => m.carId === myCar.id || m.numero === myCar.numero) : messages;

  return (
    <div
      className="min-h-screen w-full transition-colors duration-500 ease-in-out"
      style={{
        ...bgStyle,
        fontFamily: "'Barlow Condensed', 'Arial Narrow', Helvetica, Arial, sans-serif",
      }}
    >
      {risLost && !risDismissed &&
        createPortal(
          <div
            role="alert"
            className="fixed inset-0 flex flex-col items-center justify-center gap-6 text-center px-6"
            style={{ zIndex: 100000, backgroundColor: Math.floor(now / 1000) % 2 ? "#b00000" : "#ff1a1a", color: "#fff", fontFamily: "'Barlow Condensed', 'Arial Narrow', Helvetica, Arial, sans-serif" }}
          >
            <div style={{ fontSize: "min(22vw, 26vh)", lineHeight: 1 }}>⚠</div>
            <div className="font-black uppercase" style={{ fontSize: "min(9vw, 14vh)", lineHeight: 1.05 }}>Connexion RIS perdue</div>
            <div className="font-bold" style={{ fontSize: "min(4vw, 6vh)" }}>{risLostMsg}</div>
            <div className="font-semibold opacity-90" style={{ fontSize: "min(3vw, 4.5vh)" }}>Classement, écarts et tours ne sont plus mis à jour. Cette alerte disparaît toute seule dès que le flux revient.</div>
            <button type="button" onClick={() => setRisDismissed(true)} className="mt-2 rounded-lg bg-black/40 hover:bg-black/60 px-6 py-3 text-lg font-black uppercase tracking-wide">
              Masquer jusqu'à la prochaine perte
            </button>
          </div>,
          document.body
        )}
      {feedFrozen && !frozenDismissed && !risLost &&
        createPortal(
          <div
            role="alert"
            className="fixed inset-0 flex flex-col items-center justify-center gap-6 text-center px-6"
            style={{ zIndex: 99999, backgroundColor: Math.floor(now / 1000) % 2 ? "#c25a00" : "#ff8a00", color: "#000", fontFamily: "'Barlow Condensed', 'Arial Narrow', Helvetica, Arial, sans-serif" }}
          >
            <div style={{ fontSize: "min(20vw, 24vh)", lineHeight: 1 }}>❄</div>
            <div className="font-black uppercase" style={{ fontSize: "min(9vw, 14vh)", lineHeight: 1.05 }}>Flux RIS figé</div>
            <div className="font-bold" style={{ fontSize: "min(4vw, 6vh)" }}>
              {raceLaunched ? "La course est lancée" : "Le flux bougeait avant"} mais rien ne change depuis {frozenFor} s (chrono, tours et intermédiaires).
            </div>
            <div className="font-semibold" style={{ fontSize: "min(3vw, 4.5vh)" }}>
              Vérifier que le statut est bien au vert dans RIS, puis relancer. Cette alerte disparaît toute seule dès que le flux repart.
            </div>
            <div className="flex flex-wrap gap-3 justify-center">
              <button type="button" onClick={kickFeed} className="rounded-lg bg-black text-white hover:bg-black/80 px-8 py-4 text-2xl font-black uppercase tracking-wide">
                {relayKickRef.current ? "↻ Relancer la lecture du flux" : "↻ Recharger la page"}
              </button>
              {relayKickRef.current && (
                <button type="button" onClick={() => window.location.reload()} className="rounded-lg bg-black/40 hover:bg-black/60 text-black px-6 py-4 text-lg font-black uppercase tracking-wide">
                  Recharger la page (F5)
                </button>
              )}
              <button type="button" onClick={() => setFrozenDismissed(true)} className="rounded-lg bg-black/40 hover:bg-black/60 text-black px-6 py-4 text-lg font-black uppercase tracking-wide">
                Masquer
              </button>
            </div>
          </div>,
          document.body
        )}
      {isAdmin && admClOpen &&
        createPortal(
          <WindowHost title="Classement" storeKey="admcl" wide startPos={{ x: 16, y: 72 }} onClose={() => setAdmClOpen(false)}>
            {liveInfo ? (
              <AdminClassement cars={liveInfo.cars} now={now} teamCars={allConfiguredCars} st={admCl} setSt={setAdmCl} quali={!!liveInfo.quali} />
            ) : (
              <div className="text-white/70 font-sans text-sm p-2">Pas de flux RIS pour le moment.</div>
            )}
          </WindowHost>,
          document.body
        )}
      <div className={`max-w-7xl mx-auto px-3 pb-20 ${myCar ? "py-2" : "py-4"}`}>
        <style>{"@keyframes pbblink{0%,100%{background:#ff1f1f;color:#fff}50%{background:#ffe600;color:#000}}"}</style>
        {fcyActive && (
          <div
            className="fixed inset-x-0 top-0 z-[60] pointer-events-none flex items-center justify-center py-3 text-3xl font-black uppercase tracking-widest"
            style={{
              backgroundImage: "repeating-linear-gradient(45deg,#ffd400 0px,#ffd400 26px,#000 26px,#000 52px)",
              color: flash ? "#000" : "#fff",
              textShadow: flash ? "0 0 0 #fff" : "0 0 6px #000, 2px 2px 0 #000",
              opacity: flash ? 1 : 0.85,
            }}
          >
            <span className="bg-black text-[#ffd400] px-6 py-1 rounded">⚠ FULL COURSE YELLOW</span>
          </div>
        )}
        {/* EN-TÊTE + HORLOGE + DÉCOMPTE + BOUTONS (une seule ligne) */}
        <div className={`flex items-center justify-between gap-x-3 gap-y-1 flex-wrap ${myCar ? "mb-2" : "mb-4"} relative overflow-hidden rounded-lg pl-6 pr-3 py-1.5 border-b-4 border-[#e10600]`} style={{ background: "linear-gradient(100deg,#050505 0%,#141414 55%,#2a0505 100%)" }}>
          <div
            aria-hidden="true"
            className="absolute left-0 top-0 bottom-0 w-3.5"
            style={{ backgroundImage: "conic-gradient(#fff 25%, #000 0 50%, #fff 0 75%, #000 0)", backgroundSize: "14px 14px" }}
          />
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-md flex items-center justify-center border-2 bg-white/15 border-white/60 text-white flex-shrink-0">
              <Flag size={16} />
            </div>
            <div>
              <h1 className="text-white text-[15px] tracking-wide font-black italic uppercase leading-none whitespace-nowrap" style={{ textShadow: "2px 2px 0 #e10600" }}>
                Gestion Team manager by JFP racing
              </h1>
              <p className={`text-white/70 text-[10px] tracking-widest uppercase font-semibold whitespace-nowrap ${myCar ? "hidden" : ""}`}>
                Gestion des arrêts au stand
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5 text-white font-mono font-bold text-base">
            <Clock size={15} className="text-white/70" />
            {fmtClock(now)}
          </div>
          {weather && (
            <div className="flex items-center gap-1 text-white font-mono font-bold text-sm" title={`Température au circuit · ${weatherLabel(weather.code).text}`}>
              🌡 {weather.tempC.toFixed(1)}°C
            </div>
          )}

          {(() => {
            const evt = getEventStatus(settings, now);
            if (!evt) return null;
            return (
              <div className="flex items-center gap-1.5 text-white text-xs font-semibold">
                <span className="text-white/70 text-[10px] uppercase tracking-widest">{evt.label}</span>
                {evt.seconds > 0 && (
                  <span className="font-mono font-black text-sm">{fmtTimeHMS(evt.seconds)}</span>
                )}
              </div>
            );
          })()}

          <div className="flex items-center gap-2">
            <button
              onClick={() => setAdvancedMode((s) => !s)}
              className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wide bg-white/15 text-white"
              title="Affiche/masque les messages d'équipe"
            >
              {advancedMode ? "🔧 Mode avancé" : "⚡ Mode simple"}
            </button>
            {isAdmin && (
              <button
                onClick={toggleRecap}
                className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wide bg-white/15 text-white"
                title="Vue récapitulative compacte (toutes les tuiles fermées sur un seul écran) ou vue détaillée"
              >
                {recap ? "▦ Vue récap" : "▤ Vue détaillée"}
              </button>
            )}
            {isAdmin && (
              <button
                onClick={() => setShowSettings((s) => !s)}
                className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wide bg-white/15 text-white"
                title="Réglages fuel (pompes / délai)"
              >
                <Settings2 size={12} /> Réglages
              </button>
            )}
            <button
              onClick={() => {
                const next = !soundOn;
                setSoundOn(next);
                if (next && typeof window !== "undefined" && window.speechSynthesis) {
                  // débloque la synthèse vocale de façon fiable : appel direct et synchrone,
                  // déclenché par le clic (pas de file d'attente ni de délai qui pourrait
                  // faire perdre l'autorisation du navigateur liée au geste utilisateur)
                  try {
                    window.speechSynthesis.cancel();
                    const test = new SpeechSynthesisUtterance("Voix activée.");
                    test.lang = "fr-FR";
                    test.volume = 1;
                    const voices = window.speechSynthesis.getVoices();
                    if (voices.length > 0) {
                      const voice = pickMaleVoice(voices);
                      if (voice) test.voice = voice;
                    }
                    window.speechSynthesis.speak(test);
                  } catch (e) {}
                }
              }}
              className={"flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wide text-white " + (soundOn && !voiceReady ? "bg-amber-600 animate-pulse" : "bg-white/15")}
              title="Activer/couper l'annonce vocale — cliquez pour tester"
            >
              {soundOn ? (voiceReady ? "🔊 Voix ON" : "🔈 Voix bloquée : cliquer") : "🔇 Voix OFF"}
            </button>
            <div
              className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wide bg-white/15 text-white"
              title={
                connectionStatus === "connected"
                  ? "Connecté"
                  : connectionStatus === "reconnecting"
                  ? "Reconnexion en cours..."
                  : "Hors ligne"
              }
            >
              {connectionStatus === "connected" && <>🟢 Connecté</>}
              {connectionStatus === "reconnecting" && <>🟠 Reconnexion</>}
              {connectionStatus === "offline" && <>🔴 Hors ligne</>}
            </div>
            {settings.liveEnabled && (
              <div
                className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wide bg-white/15 text-white"
                title={
                  !liveInfo
                    ? "Aucune donnée reçue pour cet uuid. Un poste Admin doit être ouvert pour relayer le flux."
                    : !liveInfo.relayAlive
                    ? `Le poste Admin qui relaie le flux n'a rien envoyé depuis ${liveInfo.relayAgeSec} s : classement et tours ne sont plus mis à jour (classement manuel utilisé).`
                    : liveInfo.status === "FINISHED"
                    ? "Session terminée côté chronométrage."
                    : !liveInfo.feedFresh
                    ? `Le flux RIS n'évolue plus (dernière donnée il y a ${liveInfo.feedAgeSec} s).`
                    : `Flux RIS à jour. Retard affiché = âge de la donnée RIS : ${Math.max(0, Math.round((now - liveInfo.generatedAt) / 1000))} s (si ce chiffre est élevé, le retard vient de RIS lui-même).`
                }
              >
                {!liveInfo && <>⚪ Live : en attente</>}
                {liveInfo && !liveInfo.relayAlive && <>🟠 Live : relais arrêté</>}
                {liveInfo && liveInfo.relayAlive && liveInfo.status === "FINISHED" && <>🏁 Live : terminé</>}
                {liveInfo && liveInfo.relayAlive && liveInfo.status !== "FINISHED" && !liveInfo.feedFresh && (
                  <>🟠 Live : flux figé</>
                )}
                {liveInfo && liveInfo.relayAlive && liveInfo.status !== "FINISHED" && liveInfo.feedFresh && feedFrozen && (
                  <>❄ Live : flux figé depuis {frozenFor} s</>
                )}
                {liveInfo && liveInfo.relayAlive && liveInfo.status !== "FINISHED" && liveInfo.feedFresh && feedPrep && (
                  <>⏳ RIS en préparation : attente du vert</>
                )}
                {liveInfo && liveInfo.relayAlive && liveInfo.status !== "FINISHED" && liveInfo.feedFresh && !feedFrozen && !feedPrep && (
                  <>🟢 Live{settings.liveFlagAuto ? " · drapeaux auto" : ""}{liveInfo.trackStateRaw ? ` · ${liveInfo.trackStateRaw}` : ""} · {Math.max(0, Math.round((now - liveInfo.generatedAt) / 1000))} s</>
                )}
              </div>
            )}
            <button
              onClick={resetRoleAndCar}
              title="Changer de rôle"
              className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wide bg-white/15 text-white"
            >
              👤{" "}
              {role === "admin"
                ? "Admin"
                : role === "manager"
                ? `Team Manager${myCar ? " #" + myCar.numero : ""}`
                : role === "pitwall"
                ? "Pit Wall"
                : "Read Only"}
            </button>
            {diagnostics.length > 0 && (
              <button
                onClick={() => setShowDiagnostics((s) => !s)}
                className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wide bg-red-600 text-white"
              >
                <AlertTriangle size={12} /> {diagnostics.length} anomalie{diagnostics.length > 1 ? "s" : ""}
              </button>
            )}
          </div>
        </div>

        {showDiagnostics && diagnostics.length > 0 && (
          <div className="rounded-lg border-2 border-red-500/50 mb-4 p-3 bg-red-950/40">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-white font-bold tracking-wide uppercase text-xs flex items-center gap-2">
                <AlertTriangle size={14} /> Anomalies détectées
              </h2>
              <button
                onClick={() => setShowDiagnostics(false)}
                className="text-white/60 hover:text-white"
                title="Fermer"
              >
                <X size={16} />
              </button>
            </div>
            <ul className="list-disc list-inside text-white text-xs flex flex-col gap-1">
              {diagnostics.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          </div>
        )}

        {showSettings && isAdmin && (
          <div className="rounded-lg border-2 border-black/30 mb-4 p-3 bg-black/40">
            <div className="flex items-center justify-between gap-2 mb-2">
              <h2 className="text-white font-bold tracking-wide uppercase text-xs flex items-center gap-2">
                <Settings2 size={14} /> Réglages fuel
              </h2>
              <button
                type="button"
                onClick={() => setShowSettings(false)}
                className="px-3 py-1 rounded-md text-xs font-bold uppercase bg-white text-black hover:bg-white/80"
              >
                ✕ Fermer
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="flex flex-col gap-1 text-white text-xs">
                Nombre de pompes (voitures au fuel en même temps)
                <input
                  type="number"
                  min="1"
                  max={cars.length}
                  value={settings.maxFuelSimultaneous}
                  onChange={(e) =>
                    pushSettings({
                      ...settings,
                      maxFuelSimultaneous: Math.max(1, Number(e.target.value) || 1),
                    })
                  }
                  className="px-2 py-1.5 text-sm rounded bg-black/50 text-white border border-white/20 focus:outline-none focus:border-white"
                />
              </label>
              <label className="flex flex-col gap-1 text-white text-xs">
                Temps minimum estimé avant l'arrêt si pompes complètes (secondes)
                <input
                  type="number"
                  min="0"
                  value={settings.waitOnTrackSec}
                  onChange={(e) =>
                    pushSettings({
                      ...settings,
                      waitOnTrackSec: Math.max(0, Number(e.target.value) || 0),
                    })
                  }
                  className="px-2 py-1.5 text-sm rounded bg-black/50 text-white border border-white/20 focus:outline-none focus:border-white"
                />
              </label>
              <div className="flex flex-col gap-1 text-white text-xs">
                <span>Sous drapeau jaune, ignorer la limite fuel (pompes / temps)</span>
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="radio"
                      name="noFuelLimitOnYellow"
                      checked={settings.noFuelLimitOnYellow === true}
                      onChange={() => pushSettings({ ...settings, noFuelLimitOnYellow: true })}
                    />
                    Oui
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="radio"
                      name="noFuelLimitOnYellow"
                      checked={settings.noFuelLimitOnYellow === false}
                      onChange={() => pushSettings({ ...settings, noFuelLimitOnYellow: false })}
                    />
                    Non
                  </label>
                </div>
              </div>
              <label className="flex flex-col gap-1 text-white text-xs">
                Date et heure de l'événement
                <input
                  type="datetime-local"
                  value={settings.eventStartAt}
                  onChange={(e) => pushSettings({ ...settings, eventStartAt: e.target.value })}
                  className="px-2 py-1.5 text-sm rounded bg-black/50 text-white border border-white/20 focus:outline-none focus:border-white"
                />
              </label>
              <div className="flex flex-col gap-1 text-white text-xs">
                Durée de l'événement
                <div className="flex gap-1.5 items-center">
                  <input
                    type="number"
                    min="0"
                    placeholder="h"
                    value={Math.floor((settings.eventDurationSec || 0) / 3600)}
                    onChange={(e) => {
                      const h = Math.max(0, Number(e.target.value) || 0);
                      const rest = (settings.eventDurationSec || 0) % 3600;
                      pushSettings({ ...settings, eventDurationSec: h * 3600 + rest });
                    }}
                    className="w-full px-2 py-1.5 text-sm rounded bg-black/50 text-white placeholder-white/40 border border-white/20 focus:outline-none focus:border-white"
                  />
                  <span className="text-white/50">:</span>
                  <input
                    type="number"
                    min="0"
                    max="59"
                    placeholder="min"
                    value={Math.floor(((settings.eventDurationSec || 0) % 3600) / 60)}
                    onChange={(e) => {
                      const m = Math.min(59, Math.max(0, Number(e.target.value) || 0));
                      const h = Math.floor((settings.eventDurationSec || 0) / 3600);
                      const s = (settings.eventDurationSec || 0) % 60;
                      pushSettings({ ...settings, eventDurationSec: h * 3600 + m * 60 + s });
                    }}
                    className="w-full px-2 py-1.5 text-sm rounded bg-black/50 text-white placeholder-white/40 border border-white/20 focus:outline-none focus:border-white"
                  />
                  <span className="text-white/50">:</span>
                  <input
                    type="number"
                    min="0"
                    max="59"
                    placeholder="sec"
                    value={(settings.eventDurationSec || 0) % 60}
                    onChange={(e) => {
                      const s = Math.min(59, Math.max(0, Number(e.target.value) || 0));
                      const h = Math.floor((settings.eventDurationSec || 0) / 3600);
                      const m = Math.floor(((settings.eventDurationSec || 0) % 3600) / 60);
                      pushSettings({ ...settings, eventDurationSec: h * 3600 + m * 60 + s });
                    }}
                    className="w-full px-2 py-1.5 text-sm rounded bg-black/50 text-white placeholder-white/40 border border-white/20 focus:outline-none focus:border-white"
                  />
                </div>
              </div>
              <label className="flex flex-col gap-1 text-white text-xs">
                Type d'événement
                <select
                  value={settings.eventType}
                  onChange={(e) => pushSettings({ ...settings, eventType: e.target.value })}
                  className="px-2 py-1.5 text-sm rounded bg-black/50 text-white border border-white/20 focus:outline-none focus:border-white"
                >
                  {SESSION_TYPES.map(([v, l]) => (
                    <option key={v} value={v}>{l}</option>
                  ))}
                </select>
              </label>
              {/* PROGRAMME DES SÉANCES */}
              <div className="flex flex-col gap-2 p-2 rounded border border-white/15 bg-black/30">
                <div className="text-white text-xs font-bold uppercase tracking-wide">Programme des séances</div>
                <p className="text-white/50 text-[10px]">
                  Encode à l'avance toutes les séances. À l'heure de début de chacune, l'appli applique toute seule le type,
                  l'heure, la durée (et l'uuid RIS si tu l'as renseigné). Les relais déjà enregistrés ne sont pas effacés :
                  utilise « Réinitialiser » entre deux séances si tu veux repartir de zéro.
                </p>
                {(settings.schedule || []).map((s) => {
                  const upd = (patch) =>
                    pushSettings({ ...settings, schedule: settings.schedule.map((x) => (x.id === s.id ? { ...x, ...patch } : x)) });
                  const d = s.durationSec || 0;
                  const active = settings.scheduleAppliedId === s.id;
                  return (
                    <div key={s.id} className={`grid gap-1.5 items-end p-1.5 rounded ${active ? "bg-green-500/20 border border-green-400/50" : "bg-black/30"}`} style={{ gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))" }}>
                      <label className="flex flex-col gap-0.5 text-white text-[10px]">
                        Séance
                        <select value={s.type} onChange={(e) => upd({ type: e.target.value })} className="px-1.5 py-1 text-xs rounded bg-black/50 text-white border border-white/20">
                          {SESSION_TYPES.map(([v, l]) => (
                            <option key={v} value={v}>{l}</option>
                          ))}
                        </select>
                      </label>
                      <label className="flex flex-col gap-0.5 text-white text-[10px]">
                        Début
                        <input type="datetime-local" value={s.startAt || ""} onChange={(e) => upd({ startAt: e.target.value })} className="px-1.5 py-1 text-xs rounded bg-black/50 text-white border border-white/20" />
                      </label>
                      <label className="flex flex-col gap-0.5 text-white text-[10px]">
                        Durée (h : min)
                        <span className="flex items-center gap-1">
                          <input type="number" min="0" value={Math.floor(d / 3600)} onChange={(e) => upd({ durationSec: Math.max(0, Number(e.target.value) || 0) * 3600 + (d % 3600) })} className="w-full px-1.5 py-1 text-xs rounded bg-black/50 text-white border border-white/20" />
                          :
                          <input type="number" min="0" max="59" value={Math.floor((d % 3600) / 60)} onChange={(e) => upd({ durationSec: Math.floor(d / 3600) * 3600 + Math.min(59, Math.max(0, Number(e.target.value) || 0)) * 60 })} className="w-full px-1.5 py-1 text-xs rounded bg-black/50 text-white border border-white/20" />
                        </span>
                      </label>
                      <label className="flex flex-col gap-0.5 text-white text-[10px]">
                        uuid RIS (facultatif)
                        <input type="text" value={s.uuid || ""} onChange={(e) => upd({ uuid: e.target.value.trim() })} className="px-1.5 py-1 text-xs rounded bg-black/50 text-white border border-white/20" />
                      </label>
                      <div className="flex gap-1 items-center">
                        {active && <span className="text-green-300 text-[10px] font-bold">● EN COURS</span>}
                        <button onClick={() => applySession(s)} className="px-2 py-1 text-[10px] font-bold rounded bg-white/15 text-white" title="Applique cette séance tout de suite">Activer</button>
                        <button onClick={() => pushSettings({ ...settings, schedule: settings.schedule.filter((x) => x.id !== s.id) })} className="px-2 py-1 text-[10px] font-bold rounded bg-red-500/30 text-white" title="Supprimer cette séance">✕</button>
                      </div>
                    </div>
                  );
                })}
                <button
                  onClick={() => {
                    const used = new Set((settings.schedule || []).map((x) => x.type));
                    const nextType = (SESSION_TYPES.find(([v]) => !used.has(v)) || SESSION_TYPES[0])[0];
                    pushSettings({
                      ...settings,
                      schedule: [...(settings.schedule || []), { id: "s" + Date.now(), type: nextType, startAt: "", durationSec: nextType === "course" ? 0 : 3600, uuid: "" }],
                    });
                  }}
                  className="self-start px-2.5 py-1 text-xs font-bold rounded bg-white/15 text-white"
                >
                  + Ajouter une séance
                </button>
              </div>
              {settings.eventType === "course" && (
                <p className="text-white/50 text-[10px]">
                  Type "Course" actif — la consommation initiale (L/100km) de chaque voiture,
                  encodée dans sa configuration, sera utilisée dès le relais 1.
                </p>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <label className="flex flex-col gap-1 text-white text-xs">
                  Nom du circuit
                  <input
                    type="text"
                    value={settings.circuitName}
                    onChange={(e) => pushSettings({ ...settings, circuitName: e.target.value })}
                    className="px-2 py-1.5 text-sm rounded bg-black/50 text-white border border-white/20 focus:outline-none focus:border-white"
                  />
                </label>
                <label className="flex flex-col gap-1 text-white text-xs">
                  Longueur du circuit (km)
                  <input
                    type="number"
                    min="0"
                    step="0.001"
                    value={settings.circuitLengthKm}
                    onChange={(e) =>
                      pushSettings({ ...settings, circuitLengthKm: Math.max(0, Number(e.target.value) || 0) })
                    }
                    className="px-2 py-1.5 text-sm rounded bg-black/50 text-white border border-white/20 focus:outline-none focus:border-white"
                  />
                </label>
              </div>
              <WeatherSettings settings={settings} pushSettings={pushSettings} weather={weather} />
              {/* CHRONOMÉTRAGE LIVE (RIS) */}
              <div className="flex flex-col gap-2 p-2 rounded border border-white/15 bg-black/30">
                <div className="text-white text-xs font-bold uppercase tracking-wide">
                  Chronométrage live (RIS)
                </div>
                <label className="flex items-center gap-2 text-white text-xs">
                  <input
                    type="checkbox"
                    checked={!!settings.liveEnabled}
                    disabled={!canEdit}
                    onChange={(e) => pushSettings({ ...settings, liveEnabled: e.target.checked })}
                  />
                  Utiliser le flux live (classement général et tours dans les encarts)
                </label>
                <div className="flex flex-col gap-1 text-white text-xs">
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="liveSource"
                      checked={settings.liveSource !== "page"}
                      disabled={!canEdit}
                      onChange={() => pushSettings({ ...settings, liveSource: "direct" })}
                    />
                    Lecture directe du flux (nécessite l'autorisation de RIS)
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="liveSource"
                      checked={settings.liveSource === "page"}
                      disabled={!canEdit}
                      onChange={() => pushSettings({ ...settings, liveSource: "page" })}
                    />
                    Depuis la page RIS ouverte dans ce navigateur (favori)
                  </label>
                </div>
                {settings.liveSource === "page" && (
                  <div className="flex flex-col gap-1.5 p-2 rounded bg-white/5 text-white text-xs">
                    <label className="flex flex-col gap-1">
                      Adresse de la page RIS
                      <input
                        type="text"
                        value={settings.liveRisUrl || ""}
                        disabled={!canEdit}
                        placeholder="https://live.ris-timing.be/funbe"
                        onChange={(e) => pushSettings({ ...settings, liveRisUrl: e.target.value.trim() })}
                        className="px-2 py-1.5 text-sm font-mono rounded bg-black/50 text-white placeholder-white/30 border border-white/20 focus:outline-none focus:border-white"
                      />
                    </label>
                    <div className="text-white/70 text-[11px] leading-snug">
                      <b>Une seule fois :</b> faites glisser le bouton bleu ci-dessous dans votre barre de
                      favoris (Ctrl+Maj+B pour l'afficher).
                      <br />
                      <b>À chaque session :</b> cliquez « Ouvrir la page RIS », puis, dans l'onglet RIS qui
                      s'ouvre, cliquez sur le favori « PitBoard ↔ RIS ». Un petit message « flux transmis »
                      apparaît en bas à gauche de la page RIS. Laissez les deux onglets ouverts.
                      <br />
                      <b>Reconnexion automatique :</b> si la page RIS ne transmet plus rien pendant 15 s (page
                      rechargée, favori perdu), PitBoard lit le flux tout seul (à condition que l'uuid du flux
                      ci-dessous soit renseigné) et reprend la page dès qu'elle retransmet.
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <button
                        type="button"
                        disabled={!canEdit || !(settings.liveRisUrl || "").startsWith(RIS_ORIGIN)}
                        onClick={() => window.open(settings.liveRisUrl, "pitboard-ris")}
                        className="px-3 py-1 rounded font-bold text-xs bg-white text-black disabled:opacity-40"
                        title={`L'adresse doit commencer par ${RIS_ORIGIN}`}
                      >
                        Ouvrir la page RIS
                      </button>
                      <a
                        ref={(el) => {
                          if (el) el.setAttribute("href", buildBookmarklet(window.location.origin));
                        }}
                        onClick={(e) => e.preventDefault()}
                        draggable
                        className="px-3 py-1 rounded font-bold text-xs bg-blue-600 text-white cursor-grab"
                        title="Glissez ce bouton dans la barre de favoris"
                      >
                        PitBoard ↔ RIS
                      </a>
                    </div>
                  </div>
                )}
                <label className="flex flex-col gap-1 text-white text-xs">
                  uuid du flux{settings.liveSource === "page" ? " (rempli automatiquement)" : ""}
                  <input
                    type="text"
                    value={settings.liveUuid || ""}
                    disabled={!canEdit}
                    placeholder="00000000-0000-0000-0000-000000000004"
                    onChange={(e) => pushSettings({ ...settings, liveUuid: e.target.value.trim() })}
                    className="px-2 py-1.5 text-sm font-mono rounded bg-black/50 text-white placeholder-white/30 border border-white/20 focus:outline-none focus:border-white"
                  />
                </label>
                <label className="flex items-center gap-2 text-white text-xs">
                  <input
                    type="checkbox"
                    checked={!!settings.liveFlagAuto}
                    disabled={!canEdit}
                    onChange={(e) => pushSettings({ ...settings, liveFlagAuto: e.target.checked })}
                  />
                  Drapeaux automatiques (vert / jaune)
                </label>
                <p className="text-white/50 text-[10px]">
                  Un poste Admin doit rester ouvert : il lit le flux toutes les 3 s et le partage aux autres
                  postes. Le rouge reste manuel. Un drapeau changé à la main reste prioritaire jusqu'à ce que
                  le flux change lui-même.
                </p>
                {isAdmin && settings.liveEnabled && (
                  <div className="text-[10px] font-mono">
                    {!relayStatus && settings.liveSource === "page" && (
                      <span className="text-white/60">
                        En attente de la page RIS : ouvrez-la avec le bouton, puis cliquez sur le favori
                        « PitBoard ↔ RIS ».
                      </span>
                    )}
                    {!relayStatus && settings.liveSource !== "page" && (
                      <span className="text-white/60">Relais : démarrage…</span>
                    )}
                    {relayStatus && relayStatus.ok && (
                      <span className="text-green-400">
                        Relais OK (
                        {relayStatus.via === "script"
                          ? "via le script Python"
                          : relayStatus.via === "page"
                          ? "via la page RIS"
                          : relayStatus.via === "proxy"
                          ? "via relais Vercel"
                          : "lecture directe"}
                        ) —{" "}
                        {relayStatus.nCars} voitures · statut {relayStatus.status || "?"} · piste{" "}
                        {relayStatus.trackStateRaw || "(vide)"} · dernière donnée il y a{" "}
                        {Math.max(0, Math.round((now - relayStatus.generatedAt) / 1000))} s
                      </span>
                    )}
                    {relayStatus && !relayStatus.ok && (
                      <span className="text-red-400">Relais en erreur : {relayStatus.error}</span>
                    )}
                  </div>
                )}
                {isAdmin && settings.liveEnabled && (
                  <div className="flex flex-col gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        const raw = lastRawRef.current;
                        if (!raw) {
                          setSampleText("Aucun flux reçu pour l'instant sur ce poste.");
                          return;
                        }
                        const cut = (v, d) => {
                          if (Array.isArray(v)) return v.slice(0, d === 0 ? 3 : 2).map((x) => cut(x, d + 1));
                          if (v && typeof v === "object") {
                            const o = {};
                            Object.keys(v).forEach((k) => (o[k] = cut(v[k], d + 1)));
                            return o;
                          }
                          return v;
                        };
                        const txt = JSON.stringify(cut(raw, 0), null, 1).slice(0, 12000);
                        setSampleText(txt);
                        try {
                          navigator.clipboard && navigator.clipboard.writeText(txt);
                        } catch (e) {}
                      }}
                      className="self-start px-2 py-1 rounded bg-black/50 text-white text-[10px] border border-white/20 hover:bg-black/70"
                    >
                      Copier un échantillon du flux (diagnostic)
                    </button>
                    {sampleText && (
                      <textarea
                        readOnly
                        value={sampleText}
                        rows={6}
                        onFocus={(e) => e.target.select()}
                        className="w-full text-[10px] font-mono rounded bg-black/60 text-white border border-white/20 p-1"
                      />
                    )}
                  </div>
                )}
                {!isAdmin && settings.liveEnabled && (
                  <div className="text-[10px] text-white/60 font-mono">
                    {!liveInfo
                      ? "Aucune donnée reçue : ouvrez l'application sur un poste Admin."
                      : liveInfo.relayAlive
                      ? `Relais Admin actif (dernier envoi il y a ${liveInfo.relayAgeSec} s).`
                      : `Relais Admin arrêté (dernier envoi il y a ${liveInfo.relayAgeSec} s).`}
                  </div>
                )}
              </div>
              <label className="flex flex-col gap-1 text-white text-xs">
                Capacité réservoir (litres)
                <input
                  type="number"
                  min="0"
                  step="0.5"
                  value={settings.tankCapacityL}
                  onChange={(e) =>
                    pushSettings({ ...settings, tankCapacityL: Math.max(0, Number(e.target.value) || 0) })
                  }
                  className="px-2 py-1.5 text-sm rounded bg-black/50 text-white border border-white/20 focus:outline-none focus:border-white"
                />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="flex flex-col gap-1 text-white text-xs">
                  Vitesse moy. drapeau vert (km/h)
                  <input
                    type="number"
                    min="0"
                    value={settings.greenSpeedKmh}
                    onChange={(e) =>
                      pushSettings({ ...settings, greenSpeedKmh: Math.max(0, Number(e.target.value) || 0) })
                    }
                    className="px-2 py-1.5 text-sm rounded bg-black/50 text-white border border-white/20 focus:outline-none focus:border-white"
                  />
                </label>
                <label className="flex flex-col gap-1 text-white text-xs">
                  Vitesse moy. drapeau jaune (km/h)
                  <input
                    type="number"
                    min="0"
                    value={settings.yellowSpeedKmh}
                    onChange={(e) =>
                      pushSettings({ ...settings, yellowSpeedKmh: Math.max(0, Number(e.target.value) || 0) })
                    }
                    className="px-2 py-1.5 text-sm rounded bg-black/50 text-white border border-white/20 focus:outline-none focus:border-white"
                  />
                </label>
              </div>
              <label className="flex flex-col gap-1 text-white text-xs">
                Consommation au ralenti au stand (L/h, à 0 km/h)
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  value={settings.idleConsoLh}
                  onChange={(e) =>
                    pushSettings({ ...settings, idleConsoLh: Math.max(0, Number(e.target.value) || 0) })
                  }
                  className="px-2 py-1.5 text-sm rounded bg-black/50 text-white border border-white/20 focus:outline-none focus:border-white"
                />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="flex flex-col gap-1 text-white text-xs">
                  Seuil alerte (%)
                  <input
                    type="number"
                    min="0"
                    max="100"
                    value={settings.fuelWarnPct}
                    onChange={(e) =>
                      pushSettings({ ...settings, fuelWarnPct: Math.max(0, Number(e.target.value) || 0) })
                    }
                    className="px-2 py-1.5 text-sm rounded bg-black/50 text-white border border-white/20 focus:outline-none focus:border-white"
                  />
                </label>
                <label className="flex flex-col gap-1 text-white text-xs">
                  Seuil critique (%)
                  <input
                    type="number"
                    min="0"
                    max="100"
                    value={settings.fuelCritPct}
                    onChange={(e) =>
                      pushSettings({ ...settings, fuelCritPct: Math.max(0, Number(e.target.value) || 0) })
                    }
                    className="px-2 py-1.5 text-sm rounded bg-black/50 text-white border border-white/20 focus:outline-none focus:border-white"
                  />
                </label>
              </div>
            </div>
            <p className="text-white/50 text-[10px] mt-2">
              Ex : 3 pompes pour 6 voitures — une fois les 3 pompes annoncées, une nouvelle annonce fuel n'est acceptée que si son temps estimé dépasse le chrono le plus bas des annonces fuel en cours, augmenté de ce délai. Si "Oui" est sélectionné ci-dessus, cette limite est totalement désactivée tant que le drapeau jaune est actif.
            </p>

            <div className="mt-4 pt-3 border-t border-white/20 flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={exportEventSummary}
                className="px-3 py-1.5 rounded font-bold uppercase tracking-wide text-xs bg-black text-white"
              >
                📄 Exporter le résumé (CSV)
              </button>
              {!confirmReset ? (
                <button
                  type="button"
                  onClick={() => setConfirmReset(true)}
                  className="px-3 py-1.5 rounded font-bold uppercase tracking-wide text-xs bg-red-900/60 text-white border border-red-500/50 hover:bg-red-800/70"
                >
                  Réinitialiser la course
                </button>
              ) : (
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-white text-xs font-bold">
                    Confirmer ? Toutes les annonces, messages, relais, ravitaillements et
                    l'heure de l'événement seront effacés (les voitures configurées et les
                    réglages sont conservés).
                  </span>
                  <button
                    type="button"
                    onClick={resetEvent}
                    className="px-3 py-1.5 rounded font-black uppercase tracking-wide text-xs bg-red-600 text-white hover:bg-red-500"
                  >
                    Oui, réinitialiser
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmReset(false)}
                    className="px-3 py-1.5 rounded font-bold uppercase tracking-wide text-xs bg-white/10 text-white border border-white/20 hover:bg-white/20"
                  >
                    Annuler
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {exportCsvText !== null && (
          <div className="rounded-lg border-2 border-black/30 mb-4 p-3 bg-black/40">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-white font-bold tracking-wide uppercase text-xs flex items-center gap-2">
                📄 Résumé de l'événement (CSV)
              </h2>
              <button
                onClick={() => setExportCsvText(null)}
                className="text-white/60 hover:text-white"
                title="Fermer"
              >
                <X size={16} />
              </button>
            </div>
            <p className="text-white/60 text-[11px] mb-2">
              Copiez ce texte et collez-le dans un fichier .csv (Bloc-notes, Excel, Google
              Sheets...) — le téléchargement automatique n'est pas fiable dans cet
              environnement, cette méthode fonctionne partout.
            </p>
            <textarea
              readOnly
              value={exportCsvText}
              onFocus={(e) => e.target.select()}
              rows={8}
              className="w-full px-2 py-2 text-xs font-mono rounded bg-black/60 text-white border border-white/20 focus:outline-none focus:border-white resize-y"
            />
            <div className="flex items-center gap-2 mt-2">
              <button
                type="button"
                onClick={async () => {
                  try {
                    if (navigator.clipboard && navigator.clipboard.writeText) {
                      await navigator.clipboard.writeText(exportCsvText);
                      setExportCopyStatus("Copié !");
                    } else {
                      throw new Error("clipboard API indisponible");
                    }
                  } catch (e) {
                    setExportCopyStatus("Échec — sélectionnez le texte ci-dessus et copiez avec Ctrl+C (Cmd+C sur Mac).");
                  }
                }}
                className="px-3 py-1.5 rounded font-bold uppercase tracking-wide text-xs bg-black text-white"
              >
                📋 Copier
              </button>
              {exportCopyStatus && (
                <span className="text-white/70 text-[11px]">{exportCopyStatus}</span>
              )}
            </div>
          </div>
        )}

        {connectionStatus !== "connected" && (
          <div className="mb-4 text-xs text-white bg-black/50 border border-white/30 rounded px-3 py-2">
            {connectionStatus === "reconnecting"
              ? "Connexion à Supabase en cours... vérifiez votre fichier .env (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY)."
              : "Hors ligne — connexion Internet perdue. Reconnexion automatique dès son retour."}
          </div>
        )}

        {/* DIRECTION DE COURSE (RC) : grand, en rouge, sur toute la largeur (team manager : juste sous la jauge, voir plus bas) */}
        {!myCar && <>{wxBanner}{rcBanner}</>}

        {/* GRILLE DE DÉPART */}
        <div className="mb-4">
          {isAdmin && !myCar && (
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setAdmClOpen((o) => !o)}
                className="rounded border border-white/40 bg-black/40 hover:bg-black/60 px-3 py-1.5 text-white text-xs font-black uppercase tracking-wide"
                title="Classement de la course : une voiture, les voitures de la team ou toutes les voitures"
              >
                ☰ Classement {admClOpen ? "(ouvert)" : ""}
              </button>
              <span className="text-white/60 text-[11px]">S'ouvre seul quand toutes les voitures sont en piste sans annonce, se ferme seul dès qu'une annonce arrive.</span>
            </div>
          )}
          <h2 className={`text-white font-bold tracking-wide uppercase text-xs mb-2 items-center gap-2 ${myCar ? "hidden" : "flex"}`}>
            <Timer size={14} /> Grille des annonces ({carTiles.filter((t) => t.call).length} active
            {carTiles.filter((t) => t.call).length > 1 ? "s" : ""})
          </h2>

          {carTiles.length === 0 ? (
            <div className="rounded-lg border-2 border-black/30 p-4 text-center text-white/70 bg-black/30 text-sm">
              Encodez au moins une voiture dans la configuration ci-dessous pour commencer.
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {(() => {
                const renderTile = ({ car, call }) => {
                    const expanded = expandedTiles.has(car.id);
                    // vue récap (admin) : tuile compacte tant qu'elle n'est pas ouverte
                    const compact = recapView && !expanded;
                    const ds = driverStatsFor(car);
                    const d = call ? deriveCall(call, now) : null;
                    const overMax = d && d.phase === "instand" && d.pitElapsed >= AUTO_REMOVE_AFTER_PIT_SEC - 30;
                    const nearEnd = d && d.phase === "countdown" && d.remaining <= 30 && d.remaining > 0;
                    const ringColor = overMax ? "#ff3b3b" : nearEnd ? "#ffd400" : "rgba(0,0,0,0.35)";
                    const autoCar = risOk && !!liveFor(car); // flux RIS en ligne pour cette voiture : entrée et sortie des stands automatiques
                    const risLc = autoCar ? liveFor(car) : null;
                    const risInPit = !!risLc && isPitIn(risLc.state); // RIS confirme : voiture aux stands -> plus de bouton « rentrée »
                    const risBackOnTrack = !!risLc && !isPitIn(risLc.state) && risLc.s1 != null; // RIS fournit le premier S1 : voiture repartie -> plus de bouton « sortie »
                    const callControls = call ? (
                                <>
                                  {d.phase === "countdown" ? (
                                    <>
                                      <div className="flex gap-1.5 flex-wrap">
                                        {autoCar && d.remaining > 30 && <span className="text-[11px] font-bold text-white/70">Entrée automatique (RIS)</span>}
                                        {/* échappatoire : l'heure annoncée approche ou est passée et RIS n'a pas encore signalé l'entrée : le team manager peut la confirmer lui-même */}
                                        {autoCar && d.remaining <= 30 && !risInPit && (
                                          <button
                                            onClick={() => {
                                              if (!canEdit) return;
                                              forceArrival(call.id);
                                              if (soundOnRef.current) speakTrackPoint(audioCtxRef, call.numero, "Entrée");
                                            }}
                                            disabled={!canEdit}
                                            className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-black disabled:opacity-40"
                                            style={{ backgroundColor: car.couleur1, color: "#111" }}
                                            title="RIS n'a pas encore signalé l'entrée aux stands : cliquer si la voiture est bien rentrée"
                                          >
                                            <PlayCircle size={16} /> Entrée manuelle
                                          </button>
                                        )}
                                        {!autoCar && <button
                                          onClick={() => {
                                            if (!canEdit) return;
                                            forceArrival(call.id);
                                            if (soundOnRef.current) {
                                              speakTrackPoint(audioCtxRef, call.numero, "Entrée");
                                            }
                                          }}
                                          disabled={!canEdit}
                                          className="flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold disabled:opacity-40 disabled:cursor-not-allowed"
                                          style={{ backgroundColor: car.couleur1, color: "#111" }}
                                        >
                                          <PlayCircle size={13} /> Entrée
                                        </button>}
                                      </div>
                                      <div className="flex gap-1 flex-wrap">
                                        {TRACK_POINTS.map((p) => (
                                          <button
                                            key={p.name}
                                            onClick={() => {
                                              adjustCallTime(call.id, p.sec);
                                              if (soundOnRef.current) {
                                                speakTrackPoint(audioCtxRef, call.numero, p.name, p.sec);
                                              }
                                            }}
                                            title={`Ajuster à ${fmtTime(p.sec)}`}
                                            className="px-2 py-0.5 rounded-full text-[10px] font-semibold text-white/80 bg-white/5 border border-white/15 hover:bg-white/15 hover:text-white transition-colors"
                                          >
                                            {p.name} <span className="text-white/45">{fmtTime(p.sec)}</span>
                                          </button>
                                        ))}
                                      </div>
                                    </>
                                  ) : autoCar && call.phase === "countdown" && risInPit ? (
                                    <span className="text-[11px] font-bold text-white/70">RIS : voiture aux stands</span>
                                  ) : autoCar && call.phase === "countdown" ? (
                                    // l'heure annoncée est passée (l'appli affiche « au stand ») mais RIS n'a pas encore vu la voiture rentrer
                                    <div className="flex flex-col gap-1.5">
                                      <span className="text-[11px] font-bold text-white/70">Entrée non confirmée par RIS</span>
                                      <button
                                        onClick={() => {
                                          if (!canEdit) return;
                                          forceArrival(call.id);
                                          if (soundOnRef.current) speakTrackPoint(audioCtxRef, call.numero, "Entrée");
                                        }}
                                        disabled={!canEdit}
                                        className="self-start flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-black disabled:opacity-40"
                                        style={{ animation: "pbblink 1s infinite" }}
                                        title="L'heure annoncée est passée et RIS n'a pas vu la voiture rentrer : cliquer quand elle est bien rentrée (le chrono au stand repart de zéro)"
                                      >
                                        <PlayCircle size={16} /> La voiture est-elle rentrée ? Oui
                                      </button>
                                    </div>
                                  ) : autoCar && confirmExitId !== call.id ? (
                                    <div className="flex flex-col gap-1.5">
                                      <span className="text-[11px] font-bold text-white/70">Sortie automatique (RIS) : détectée dès que la voiture repart</span>
                                      {/* échappatoire : la sortie n'a pas été détectée (arrêt long ou RIS en retard) */}
                                      {d.pitElapsed >= 20 && !risBackOnTrack && (
                                        <button
                                          onClick={() => canEdit && setConfirmExitId(call.id)}
                                          disabled={!canEdit}
                                          className="self-start flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-black disabled:opacity-40"
                                          style={d.pitElapsed >= 150 ? { animation: "pbblink 1s infinite" } : { backgroundColor: "rgba(255,255,255,0.15)", color: "#fff", border: "1px solid rgba(255,255,255,0.35)" }}
                                          title="RIS n'a pas encore signalé la sortie des stands : cliquer si la voiture est bien repartie"
                                        >
                                          <CheckCircle2 size={16} /> La voiture est-elle sortie ?
                                        </button>
                                      )}
                                    </div>
                                  ) : confirmExitId === call.id ? (
                                    <div className="flex items-center gap-2">
                                      <span className="text-white text-xs font-bold">Confirmer ?</span>
                                      <button
                                        onClick={() => {
                                          removeCall(call.id);
                                          setConfirmExitId(null);
                                        }}
                                        className="flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold text-white bg-red-600 hover:bg-red-500 transition-colors"
                                      >
                                        <CheckCircle2 size={13} /> Oui, elle sort
                                      </button>
                                      <button
                                        onClick={() => setConfirmExitId(null)}
                                        className="flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold text-white/80 bg-white/5 border border-white/15 hover:bg-white/15 hover:text-white transition-colors"
                                      >
                                        Annuler
                                      </button>
                                    </div>
                                  ) : (
                                    <button
                                      onClick={() => canEdit && setConfirmExitId(call.id)}
                                      disabled={!canEdit}
                                      className="self-start flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold text-white/85 bg-white/5 border border-white/15 hover:bg-white/15 hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                                    >
                                      <CheckCircle2 size={13} /> Voiture quitte les stands
                                    </button>
                                  )}
                                  {call.tasks && call.tasks.length > 0 && (
                                    <div className="flex flex-wrap gap-1">
                                      {call.tasks.slice(0, 6).map((t, i) => (
                                        <span
                                          key={i}
                                          className="text-[11px] font-semibold text-white bg-white/10 rounded-full px-2 py-0.5"
                                        >
                                          {t}
                                        </span>
                                      ))}
                                    </div>
                                  )}
                                  <button
                                    onClick={() => removeCall(call.id)}
                                    className="self-start flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold text-white/50 hover:text-white"
                                  >
                                    <X size={11} /> Annuler l'annonce
                                  </button>
                                </>
                    ) : null;
                    const recsT = techChecks[car.id] || [];
                    const lastRecT = recsT[recsT.length - 1];
                    const stT = stints[car.id];
                    // litres ajoutés à saisir : la voiture a quitté les stands et la saisie n'est pas encore "envoyée"
                    const techPending = !!(myCar && lastRecT && stT && stT.lastExitAt && stT.lastExitAt > lastRecT.ts && techAck[car.id] !== lastRecT.id);
                    return (
                      <div
                        key={car.id}
                        ref={(el) => {
                          if (el) tileNodesRef.current[car.id] = el;
                        }}
                        className={`rounded-2xl shadow-lg transition-shadow ${compact ? "p-1.5" : "p-2"}${myCar ? " pb-bigtext" : ""}`}
                        style={{
                          backgroundColor: "#0a0a0a",
                          backgroundImage: `repeating-linear-gradient(45deg, ${car.couleur1} 0px, ${car.couleur1} 14px, ${car.couleur2 || "#0a0a0a"} 14px, ${car.couleur2 || "#0a0a0a"} 28px)`,
                          boxShadow: `0 0 0 2.5px ${ringColor}, 0 6px 16px rgba(0,0,0,0.35)`,
                          gridColumn: recapView && expanded ? "span 2" : undefined,
                        }}
                      >
                        <div
                          className={`rounded-[13px] bg-neutral-900/95 backdrop-blur-sm flex flex-col ${
                            compact ? "p-2 gap-1" : "p-3 gap-2"
                          }`}
                        >
                          {/* ALERTES RC : tout en haut de la tuile, entre le bord et le nom du pilote */}
                          {(myCar ? [] : rcForCar(car)).map((m) => (
                            <div
                              key={m.key}
                              className="rounded px-2 py-1 text-white font-black text-xs leading-snug flex items-start justify-between gap-2"
                              style={{ backgroundColor: "#c40000", border: "1px solid #ff4040" }}
                            >
                              <span>⚠ RC : {m.message}</span>
                              {myCar && (
                                <button
                                  onClick={() => setRcDismissed((prev) => new Set(prev).add(m.key))}
                                  className="text-white/80 hover:text-white flex-shrink-0"
                                  title="Masquer ce message"
                                >
                                  <X size={14} />
                                </button>
                              )}
                            </div>
                          ))}

                          {/* EN-TÊTE cliquable : agrandit / réduit l'encart */}
                          <button
                            onClick={() => toggleExpand(car.id)}
                            className="flex items-start justify-between text-left w-full"
                          >
                            <div>
                              <div className="flex items-baseline gap-2">
                                <div className="text-xl font-black leading-none text-white tracking-tight">
                                  #{car.numero}
                                </div>
                                {car.team && (
                                  <div className="text-lg font-black leading-none text-white truncate">
                                    {car.team}
                                  </div>
                                )}
                              </div>
                              {car.pilote && (
                                <div className="text-white/50 text-[11px] mt-0.5 truncate">{car.pilote}</div>
                              )}
                              {ds && ds.curDriver && (
                                <div className="text-sm font-black text-white mt-0.5 truncate">
                                  {driverName(ds.curDriver) || "Pilote sans nom"}
                                  {!ds.cur.confirmed && (
                                    <span className="text-amber-400" title="Pilote prévu, à confirmer">
                                      {" "}?
                                    </span>
                                  )}
                                </div>
                              )}
                              {(() => {
                                const live = liveFor(car);
                                if (!live || (!live.pos && live.laps == null)) return null;
                                return (
                                  <div className="text-[11px] font-black font-mono text-white/80 mt-0.5">
                                    P{live.pos || "-"}
                                    {live.laps != null && (
                                      <span className="text-white/50 font-semibold"> · {live.laps} tours</span>
                                    )}
                                  </div>
                                );
                              })()}
                            </div>
                            {call && call.fuel && (
                              <span
                                className="text-[10px] font-black uppercase tracking-wide px-2 py-0.5 rounded-full"
                                style={{
                                  backgroundColor: call.fuel === "oui" ? "rgba(34,197,94,0.18)" : "rgba(107,114,128,0.25)",
                                  color: call.fuel === "oui" ? "#4ade80" : "#9ca3af",
                                  border: `1px solid ${call.fuel === "oui" ? "#22c55e" : "#6b7280"}`,
                                }}
                              >
                                ⛽ {call.fuel === "oui" ? "Oui" : "Non"}
                              </span>
                            )}
                            {!call && !liveFor(car) && (
                              <span className="text-white/40 text-[10px] font-bold">P{car.classement || "-"}</span>
                            )}
                          </button>

                          {/* team manager : boutons raccourcis (fenêtres) */}
                          {myCar && !compact && (
                            <div className="grid grid-cols-3 gap-1.5">
                              <button
                                type="button"
                                onClick={() => setModal("announce")}
                                className="rounded-lg px-2 py-2 text-[11px] font-black uppercase tracking-wide bg-white text-black hover:bg-white/90"
                              >
                                📣 Annoncer un arrêt
                              </button>
                              <button
                                type="button"
                                onClick={() => setModal("message")}
                                className="rounded-lg px-2 py-2 text-[11px] font-black uppercase tracking-wide bg-white/15 text-white hover:bg-white/25"
                              >
                                ✉ Message
                              </button>
                              <button
                                type="button"
                                onClick={() => setModal("tech")}
                                className="rounded-lg px-2 py-2 text-[11px] font-black uppercase tracking-wide bg-white/15 text-white hover:bg-white/25"
                                style={techPending ? { animation: "pbblink 0.9s infinite" } : undefined}
                              >
                                ⛽ Litres ajoutés{techPending ? " !" : ""}
                              </button>
                            </div>
                          )}

                          {/* APERÇU toujours visible */}
                          {call ? (
                            <div className="text-center py-0.5">
                              <div className="text-white/40 text-[9px] uppercase tracking-widest font-semibold flex items-center justify-center gap-1">
                                {d.phase === "countdown" ? "Temps estimé avant l'arrêt" : "Temps au stand"}
                                {overMax && <AlertTriangle size={11} color="#ff3b3b" />}
                              </div>
                              <div
                                className="text-3xl font-mono font-black leading-tight"
                                style={{ color: overMax ? "#ff3b3b" : nearEnd ? "#ffd400" : "white" }}
                              >
                                {d.phase === "countdown" ? fmtTime(d.remaining) : fmtTime(d.pitElapsed)}
                              </div>
                            </div>
                          ) : (
                            !expanded &&
                            !recapView &&
                            !myCar && (
                              <div className="text-center text-white/40 text-xs py-2">
                                Cliquer pour annoncer un arrêt
                              </div>
                            )
                          )}

                          {/* team manager : Entrée / points sur le circuit / quitte les stands, sans ouvrir la tuile */}
                          {myCar && !compact && callControls && (
                            <div className="flex flex-col gap-1.5 rounded bg-white/5 px-2 py-1.5">{callControls}</div>
                          )}

                          {/* PILOTE DU RELAIS + temps de roulage cumulé (toujours visible, sauf en vue récap) */}
                          {ds && !compact && (
                            <DriverStrip
                              ds={ds}
                              canEdit={canEdit}
                              onSet={(n, driverId) => confirmRelayDriver(car.id, n, driverId)}
                              hideTotals={!!myCar}
                            />
                          )}

                          {/* team manager : informations de tous les pilotes dans un menu déroulant */}
                          {myCar && ds && !compact && (
                            <div className="flex flex-col gap-1">
                              <button
                                type="button"
                                onClick={() => setDriversOpen((o) => !o)}
                                className="flex items-center justify-between rounded bg-white/10 hover:bg-white/15 px-2 py-1 text-left text-[10px] font-black uppercase tracking-wide text-white/80"
                              >
                                <span>{driversOpen ? "▾" : "▸"} Pilotes : temps de roulage, tours S1 S2 S3 et meilleurs temps ({ds.cfg.list.length})</span>
                              </button>
                              {driversOpen && <DriversTimes ds={ds} hasLive={!!liveFor(car)} carNum={car.numero} />}
                            </div>
                          )}

                          {/* LIVE RIS : temps de course, intermédiaires, voisins au classement */}
                          {!compact && liveInfo && liveInfo.relayAlive && liveFor(car) && (
                            <>
                              <LiveBlock
                                info={liveInfo}
                                live={liveFor(car)}
                                num={normalizeCarNumber(car.numero)}
                                now={now}
                                showTable={expanded || !!myCar}
                                part={myCar ? "stats" : "all"}
                                pilot={ds && ds.curDriver ? driverName(ds.curDriver) : ""}
                                driverBest={
                                  ds && ds.curDriver
                                    ? { name: driverName(ds.curDriver), best: ds.cfg.best[ds.curDriver.id] }
                                    : null
                                }
                              />
                            </>
                          )}

                          {/* CONTENU AGRANDI */}
                          {expanded && (
                            <div className="flex flex-col gap-2 pt-1 border-t border-white/10">
                              {/* TEMPS DE ROULAGE PAR PILOTE */}
                              {ds && !myCar && (
                                <div className="flex flex-col gap-0.5">
                                  <div className="text-white/50 uppercase tracking-widest font-bold text-[9px]">
                                    Temps de roulage par pilote
                                  </div>
                                  <DriversTimes ds={ds} hasLive={!!liveFor(car)} carNum={car.numero} />
                                </div>
                              )}
                              {/* CLASSEMENT GÉNÉRAL : éditable directement dans l'encart */}
                              <div className={`items-center gap-2 ${myCar && liveFor(car) && liveFor(car).pos ? "hidden" : "flex"}`}>
                                <label className="text-white/60 text-[10px] uppercase tracking-widest whitespace-nowrap">
                                  Classement général
                                </label>
                                {liveFor(car) && liveFor(car).pos ? (
                                  <span className="text-sm font-black font-mono text-white">
                                    P{liveFor(car).pos}{" "}
                                    <span className="text-white/50 text-[10px] font-semibold">(live)</span>
                                  </span>
                                ) : (
                                  <input
                                    type="number"
                                    min="1"
                                    value={car.classement || ""}
                                    onClick={(e) => e.stopPropagation()}
                                    onChange={(e) =>
                                      updateCar(car.id, "classement", Number(e.target.value) || 0)
                                    }
                                    className="w-16 px-2 py-0.5 text-sm rounded bg-black/50 text-white border border-white/20 focus:outline-none focus:border-white"
                                  />
                                )}
                              </div>
                              {/* RELAIS : chrono en cours + historique */}
                              {(() => {
                                const st = stints[car.id];
                                if (!st) return null;
                                const totalLaps = (st.log || []).reduce(
                                  (sum, r) => sum + (Number(r.laps) || 0),
                                  0
                                );
                                return (
                                  <div className="text-[10px] text-white/70 flex flex-col gap-1">
                                    {!st.lastExitAt && !call && !myCar && settings.eventType !== "course" && (st.log || []).length === 0 && (
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          startRun(car.id);
                                        }}
                                        className="self-start px-2 py-1 rounded font-black uppercase text-[10px] bg-green-500 text-black hover:bg-green-400"
                                      >
                                        🏁 Voiture sur la piste
                                      </button>
                                    )}
                                    {st.lastExitAt && !call && !myCar && (
                                      <div className="font-mono font-bold text-white">
                                        Durée du relais : {fmtTimeHMS((now - st.lastExitAt) / 1000)}
                                      </div>
                                    )}
                                    {st.lastExitAt && !call && !myCar && (() => {
                                      const fuel = computeLiveFuelEstimate(car.id, now);
                                      if (!fuel) return null;
                                      if (!fuel.calibrated) {
                                        return (
                                          <div className="text-white/40 italic">
                                            ⛽ Calibration insuffisante (saisissez les litres ajoutés au
                                            prochain arrêt)
                                          </div>
                                        );
                                      }
                                      const color =
                                        fuel.status === "CRITICAL"
                                          ? "#ff3b3b"
                                          : fuel.status === "WARNING"
                                          ? "#ffd400"
                                          : "#4ade80";
                                      return (
                                        <div
                                          className="rounded px-2 py-1.5 flex flex-col gap-0.5"
                                          style={{ backgroundColor: "rgba(255,255,255,0.05)", border: `1px solid ${color}55` }}
                                        >
                                          <div className="flex items-center justify-between">
                                            <span className="font-bold" style={{ color }}>
                                              ⛽ {fuel.fuelRemaining.toFixed(1)} L estimés ({fuel.pct.toFixed(0)}%)
                                            </span>
                                            <span className="font-bold text-[9px]" style={{ color }}>
                                              {fuel.status}
                                            </span>
                                          </div>
                                          <div className="text-white/60">
                                            {fuel.consumptionL100 ? fuel.consumptionL100.toFixed(2) : "?"} L/100km
                                            {" — Autonomie : "}
                                            {settings.circuitLengthKm > 0 && fuel.autonomyKm ? (
                                              <span
                                                className={fuel.status === "CRITICAL" ? "font-bold animate-pulse" : "font-bold"}
                                                style={{
                                                  color:
                                                    fuel.status === "CRITICAL"
                                                      ? "#ff3b3b"
                                                      : fuel.status === "WARNING"
                                                      ? "#ff9500"
                                                      : "#ffffff",
                                                }}
                                              >
                                                {(fuel.autonomyKm / settings.circuitLengthKm).toFixed(1)} tours
                                              </span>
                                            ) : fuel.autonomyKm ? (
                                              `${fuel.autonomyKm.toFixed(0)} km`
                                            ) : (
                                              "?"
                                            )}
                                            {" / "}
                                            {fuel.autonomyMin ? fmtTimeHMS(fuel.autonomyMin * 60) : "?"}
                                          </div>
                                          <div className="text-white/35 text-[9px] italic">
                                            Estimation (
                                            {fuel.n > 0
                                              ? `${fuel.n} relais utilisés pour la calibration`
                                              : "basée sur la consommation initiale renseignée"}
                                            )
                                          </div>
                                        </div>
                                      );
                                    })()}
                                    {st.log && st.log.length > 0 && (
                                      <div className="flex flex-col gap-1 max-h-32 overflow-y-auto pr-1">
                                        {st.log.map((r) => (
                                          <div key={r.n} className="flex items-center gap-1.5 flex-wrap">
                                            <span className="font-mono">
                                              Relais {r.n} : {fmtTimeHMS(r.durationSec)}
                                            </span>
                                            <span className="text-white/50">Tours</span>
                                            <input
                                              type="number"
                                              min="0"
                                              value={r.laps}
                                              onClick={(e) => e.stopPropagation()}
                                              onChange={(e) =>
                                                updateStintLaps(car.id, r.n, e.target.value)
                                              }
                                              className="w-12 px-1 py-0.5 text-[10px] rounded bg-black/50 text-white border border-white/20 focus:outline-none focus:border-white"
                                            />
                                            {(r.vertSec > 0 || r.jauneSec > 0) && (
                                              <span className="text-white/50">
                                                🟢{fmtTimeHMS(r.vertSec)} 🟡{fmtTimeHMS(r.jauneSec)}
                                                {r.idleSec > 0 && <> ⏸️{fmtTimeHMS(r.idleSec)}</>}
                                              </span>
                                            )}
                                          </div>
                                        ))}
                                        {totalLaps > 0 && (
                                          <div className="font-bold text-white pt-0.5 border-t border-white/10">
                                            Total tours : {totalLaps}
                                          </div>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                );
                              })()}

                              {/* DERNIER RAVITAILLEMENT */}
                              {(() => {
                                const records = techChecks[car.id] || [];
                                const last = records[records.length - 1];
                                if (!last || !last.fuelL) return null;
                                return <div className="text-[10px] text-white/70 bg-white/5 rounded px-2 py-1">⛽ Dernier ajout : {last.fuelL} L</div>;
                              })()}
                              {call ? (
                                myCar ? null : callControls
                              ) : myCar ? null : (
                                <div className="text-center text-white/50 text-xs py-2">
                                  Utilisez le formulaire "Annoncer un arrêt" ci-dessus pour cette voiture.
                                </div>
                              )}
                            </div>
                          )}

                          {/* HISTORIQUE RC de cette voiture (+ messages généraux) ; les alertes qui citent le numéro restent à acquitter */}
                          {(() => {
                            const log = rcLogForCar(car);
                            if (compact) {
                              if (log.length === 0) return null;
                              const l = log[0];
                              return (
                                <div className="flex flex-col gap-0.5 pt-1 border-t border-white/10">
                                  <div className="text-[10px] leading-snug font-semibold" style={{ color: "#ff5a5a" }}>
                                    <span className="font-mono">{new Date(l.t).toLocaleTimeString("fr-BE")}</span> · RC : {l.m}
                                  </div>
                                </div>
                              );
                            }
                            return (
                              <RcHistory
                                entries={log}
                                num={String(Number(normalizeCarNumber(car.numero)))}
                                acks={rcAcks}
                                onAck={ackRc}
                                big={!!myCar}
                                showEmpty={!!myCar}
                              />
                            );
                          })()}
                        </div>
                      </div>
                    );
                };
                // admin : tableau récapitulatif, toutes les tuiles sur une seule grille compacte
                if (recapView) {
                  return (
                    <div
                      className="grid gap-2"
                      style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}
                    >
                      {carTiles.map((t) => renderTile(t))}
                    </div>
                  );
                }
                // team manager : une seule tuile, centrée
                if (myCar) {
                  const myLive = liveInfo && liveInfo.relayAlive ? liveFor(myCar) : null;
                  // jauge d'essence (tours restants) et temps du relais du pilote, en évidence au-dessus de la tuile
                  const stM = stints[myCar.id];
                  const callM = (carTiles[0] && carTiles[0].call) || null;
                  const onTrackM = !!(stM && stM.lastExitAt && !(callM && callM.phase === "instand"));
                  const fuelM = onTrackM ? computeLiveFuelEstimate(myCar.id, now) : null;
                  const dsM = driverStatsFor(myCar);
                  const relaySec = onTrackM ? (now - stM.lastExitAt) / 1000 : null;
                  const fuelColor = fuelM && fuelM.calibrated ? (fuelM.status === "CRITICAL" ? "#ff3b3b" : fuelM.status === "WARNING" ? "#ffd400" : "#4ade80") : "#9ca3af";
                  const lapsLeft = fuelM && fuelM.calibrated && settings.circuitLengthKm > 0 && fuelM.autonomyKm ? fuelM.autonomyKm / settings.circuitLengthKm : null;
                  const dsT = dsM && dsM.curDriver ? dsM.totals[dsM.curDriver.id] : null;
                  const essaisM = settings.eventType !== "course";
                  // seuils d'essence : message clignotant dans la ligne rouge sous la jauge (alerte, puis PIT IN urgent)
                  // alertes RC qui citent notre numéro et pas encore acquittées : bandeau fixe jusqu'au clic sur « Vu »
                  const myNumStr = String(Number(normalizeCarNumber(myCar.numero)));
                  const pendingAlerts = rcLogForCar(myCar).filter((l) => carNumbersIn(l.m).includes(myNumStr) && !rcAcks.has(l.t + "|" + l.m));
                  const ackBanner = pendingAlerts.length > 0 ? (
                    <div key="ackalert" className="rounded-xl px-4 py-3 shadow-lg animate-pulse" style={{ backgroundColor: "#c40000", border: "3px solid #ff4040" }} role="alert">
                      <div className="text-white/80 text-[11px] font-bold uppercase tracking-widest">Alerte(s) de la direction de course concernant #{myNumStr} · à acquitter</div>
                      {pendingAlerts.slice(0, 3).map((l) => (
                        <div key={l.t + l.m} className="flex items-start gap-3 text-white">
                          <span className="font-mono font-bold">{new Date(l.t).toLocaleTimeString("fr-BE")}</span>
                          <span className="flex-1 min-w-0 text-xl sm:text-2xl font-black leading-snug break-words">⚠ RC : {l.m}</span>
                          <button type="button" onClick={() => ackRc(l.t + "|" + l.m)} className="rounded bg-white text-red-700 font-black px-3 py-1 flex-shrink-0">✓ Vu</button>
                        </div>
                      ))}
                      {pendingAlerts.length > 3 && <div className="text-white/80 text-sm">+ {pendingAlerts.length - 3} autre(s) dans l'historique en bas de la tuile</div>}
                    </div>
                  ) : null;
                  const fuelBanner = fuelM && fuelM.calibrated && fuelM.status !== "OK" ? (
                    <div
                      key="fuelalert"
                      className="rounded-xl px-4 py-3 flex items-center gap-3 shadow-lg"
                      style={{
                        backgroundColor: "#c40000",
                        border: "3px solid #ff4040",
                        animation: `pbblink ${fuelM.status === "CRITICAL" ? "0.5s" : "1.4s"} infinite`,
                      }}
                      role="alert"
                    >
                      <AlertTriangle size={30} className="flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="text-[11px] font-bold uppercase tracking-widest opacity-80">
                          {fuelM.status === "CRITICAL" ? "Seuil critique d'essence atteint" : "Seuil d'alerte d'essence atteint"}
                        </div>
                        <div className="text-2xl sm:text-3xl font-black leading-snug">
                          {fuelM.status === "CRITICAL" ? "🛑 URGENT — PIT IN ! PIT IN !" : "⚠ ESSENCE BASSE — préparer le pit in"}
                          <span className="ml-3 font-mono text-lg sm:text-xl">
                            {fuelM.fuelRemaining.toFixed(1)} L · {fuelM.pct.toFixed(0)} %
                            {lapsLeft != null ? ` · ≈ ${lapsLeft.toFixed(1)} tr` : ""}
                          </span>
                        </div>
                      </div>
                    </div>
                  ) : null;
                  const topBar = (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mb-2">
                      {essaisM ? (
                        <EssaisConsoCard
                          run={computeEssaisRun(myCar.id, now)}
                          tankL={settings.tankCapacityL}
                          lapsKm={myLive && myLive.laps != null && settings.circuitLengthKm > 0 ? myLive.laps * settings.circuitLengthKm : 0}
                          savedValue={myCar.initialConsoL100}
                          onSave={(v) => updateCar(myCar.id, "initialConsoL100", v)}
                          running={!!(stM && stM.lastExitAt)}
                          canCancel={!!(stM && stM.lastExitAt && (stM.log || []).length === 0)}
                          onStart={() => startRun(myCar.id)}
                          onCancel={() => cancelRun(myCar.id)}
                          auto={risOk && !!myLive}
                        />
                      ) : (
                      <div className="rounded-xl bg-black/80 border-2 px-3 py-1.5 flex items-center gap-3" style={{ borderColor: fuelColor }}>
                        <span className="text-white text-sm font-black uppercase tracking-wide whitespace-nowrap">⛽ Essence</span>
                        {fuelM && fuelM.calibrated ? (
                          <>
                            <span className="font-mono text-base font-black whitespace-nowrap text-white">
                              {fuelM.fuelRemaining.toFixed(1)} L · {fuelM.pct.toFixed(0)} %
                            </span>
                            <div className="flex-1 min-w-[60px] h-3.5 rounded-full bg-white/20 border border-white/70 overflow-hidden">
                              <div className="h-full" style={{ width: `${Math.max(2, Math.min(100, fuelM.pct))}%`, backgroundColor: fuelColor }} />
                            </div>
                            <span className="font-black leading-none whitespace-nowrap" style={{ fontSize: 24, color: fuelColor }}>
                              {lapsLeft != null ? lapsLeft.toFixed(1) : fuelM.autonomyKm ? fuelM.autonomyKm.toFixed(0) : "?"}
                              <span className="text-sm font-bold text-white ml-1">{lapsLeft != null ? "tours" : "km"}</span>
                            </span>
                            <span className="font-mono text-base font-bold text-white whitespace-nowrap">{fuelM.autonomyMin ? fmtTimeHMS(fuelM.autonomyMin * 60) : ""}</span>
                          </>
                        ) : (
                          <span className="text-white/70 text-sm font-semibold">
                            {onTrackM ? "Calibration insuffisante : saisissez les litres ajoutés à l'arrêt." : "Voiture au stand : la jauge repart à la sortie."}
                          </span>
                        )}
                      </div>
                      )}
                      <div className="rounded-xl bg-black/80 border-2 border-white/50 px-3 py-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5">
                        <span className="text-white text-sm font-black uppercase tracking-wide whitespace-nowrap">⏱ Relais {((stM && stM.log) || []).length + 1}</span>
                        <span className="font-mono font-black leading-none text-white whitespace-nowrap" style={{ fontSize: 24 }}>
                          {relaySec != null ? fmtTimeHMS(relaySec) : "--:--:--"}
                        </span>
                        <span className="text-lg font-black text-white truncate min-w-0 max-w-full">
                          {dsM && dsM.curDriver ? driverName(dsM.curDriver) || "Pilote sans nom" : ""}
                        </span>
                        {dsT && (
                          <span className="ml-auto flex flex-wrap items-center gap-x-3 text-white text-[17px] font-mono font-bold" title="Temps de roulage total, sous drapeau vert / jaune / rouge">
                            <span className="whitespace-nowrap">Σ {fmtTimeHMS(dsT.total)}</span>
                            <span className="whitespace-nowrap">🟢{fmtTimeHMS(dsT.vert)}</span>
                            <span className="whitespace-nowrap">🟡{fmtTimeHMS(dsT.jaune)}</span>
                            {dsT.rouge >= 5 && <span className="whitespace-nowrap">🔴{fmtTimeHMS(dsT.rouge)}</span>}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                  return (
                    <FitToScreen>
                    {topBar}
                    {(ackBanner || fuelBanner || wxBanner || rcBanner) && <div className="mt-2 flex flex-col gap-2">{ackBanner}{fuelBanner}{wxBanner}{rcBanner}</div>}
                    <div className="w-full grid gap-2 items-start rounded-2xl bg-black/65 p-2 grid-cols-1 lg:grid-cols-[58%_minmax(0,1fr)] xl:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
                      <div className="w-full order-2 lg:order-1">
                        <div className="flex justify-end mb-1">
                          <button
                            type="button"
                            onClick={() => setAnnWin((v) => !v)}
                            className="rounded bg-white/15 hover:bg-white/25 px-2 py-0.5 text-white text-[11px] font-black uppercase tracking-wide"
                            title="Détacher les annonces dans une fenêtre déplaçable, redimensionnable, ou sur un autre écran"
                          >
                            {annWin ? "⤓ Remettre dans la page" : "⧉ Détacher en fenêtre"}
                          </button>
                        </div>
                        {annWin ? (
                          <>
                            <div className="rounded-xl border border-dashed border-white/30 p-3 text-white/60 text-xs text-center">
                              Les annonces sont dans une fenêtre séparée.
                            </div>
                            {createPortal(
                              <WindowHost title="Annonces" storeKey="ann" startPos={{ x: 16, y: 72 }} onClose={() => setAnnWin(false)}>
                                {carTiles.map((t) => renderTile(t))}
                              </WindowHost>,
                              document.body
                            )}
                          </>
                        ) : (
                          carTiles.map((t) => renderTile(t))
                        )}
                      </div>
                      <div className="order-1 lg:order-3 max-lg:contents lg:sticky lg:top-0 lg:flex lg:flex-col lg:gap-2">
                        {myLive && (
                          <div className="w-full max-lg:order-3">
                            <LiveBlock
                              info={liveInfo}
                              live={myLive}
                              num={normalizeCarNumber(myCar.numero)}
                              now={now}
                              showTable
                              part="table"
                              big
                              pilot={dsM && dsM.curDriver ? driverName(dsM.curDriver) : ""}
                            />
                          </div>
                        )}
                      </div>
                    </div>
                    </FitToScreen>
                  );
                }

                return chunkArray(carTiles, 3).map((row, rowIdx) => (
                  <div
                    key={rowIdx}
                    className="grid grid-cols-3 gap-3"
                    style={{ transform: rowIdx % 2 === 1 ? "translateX(22px)" : "none" }}
                  >
                    {row.map((t) => renderTile(t))}
                  </div>
                ));
              })()}
            </div>
          )}

          {visibleMessages.length > 0 && (
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 mt-3">
              {visibleMessages.map((m) => (
                <div
                  key={`msg-${m.id}`}
                  className="rounded-2xl p-2 shadow-lg"
                  style={{
                    backgroundColor: "#0a0a0a",
                    backgroundImage: `repeating-linear-gradient(45deg, ${m.couleur1} 0px, ${m.couleur1} 14px, ${m.couleur2 || "#0a0a0a"} 14px, ${m.couleur2 || "#0a0a0a"} 28px)`,
                    boxShadow: "0 0 0 2.5px rgba(255,255,255,0.4), 0 6px 16px rgba(0,0,0,0.35)",
                  }}
                >
                  <div className="rounded-[13px] bg-neutral-900/95 backdrop-blur-sm p-3 flex flex-col gap-2 relative">
                    <button
                      onClick={() => removeMessage(m.id)}
                      className="absolute top-2 right-2 text-white/35 hover:text-white transition-colors"
                      title="Retirer"
                    >
                      <X size={14} />
                    </button>
                    <div className="flex items-start justify-between pr-5">
                      <div>
                        <div className="text-xl font-black leading-none text-white tracking-tight">
                          #{m.numero}
                        </div>
                        {m.pilote && (
                          <div className="text-white/50 text-[11px] mt-0.5 truncate">{m.pilote}</div>
                        )}
                      </div>
                      <span className="text-[10px] font-black uppercase tracking-wide px-2 py-0.5 rounded-full bg-white/10 text-white/70 border border-white/20 flex items-center gap-1">
                        <MessageSquare size={11} /> Message
                      </span>
                    </div>
                    <div className="text-base font-bold text-white leading-snug break-words py-1">
                      {m.text}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>


        {/* ANNONCER UN ARRÊT (fenêtre fixe) */}
        <PanelHost modal={!!myCar} open={modal === "announce"} onClose={() => setModal(null)} title="Annoncer un arrêt">
        <div className="rounded-lg border-2 border-black/30 mb-4 p-3 bg-black/40">
          <h2
            className={`text-white font-bold tracking-wide uppercase text-xs flex items-center gap-2 ${hideAnnounce ? "" : "mb-2"} ${myCar ? "" : "cursor-pointer select-none"}`}
            onClick={myCar ? undefined : toggleAnnounce}
            title={myCar ? undefined : hideAnnounce ? "Afficher le formulaire" : "Masquer le formulaire"}
          >
            <Plus size={14} /> Annoncer un arrêt
            {!myCar && <span className="ml-auto text-white/60 normal-case font-semibold">{hideAnnounce ? "▸ Afficher" : "▾ Masquer"}</span>}
          </h2>
          {hideAnnounce ? null : configuredCars.length === 0 ? (
            <p className="text-white/70 text-sm">
              Encodez au moins une voiture ci-dessous pour créer une annonce.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
                <select
                  value={fCar}
                  onChange={(e) => setFCar(e.target.value)}
                  className="px-2 py-1.5 text-sm rounded bg-black/50 text-white border border-white/20 focus:outline-none focus:border-white"
                >
                  <option value="">Voiture</option>
                  {configuredCars.map((c) => (
                    <option key={c.id} value={c.id}>
                      #{c.numero} {c.pilote ? `— ${c.pilote}` : ""}
                    </option>
                  ))}
                </select>

                <div className="flex gap-1.5 items-center md:col-span-2">
                  <span className="text-white/60 text-[11px] whitespace-nowrap">
                    Temps estimé avant l'arrêt
                  </span>
                  <input
                    type="number"
                    min="0"
                    placeholder="min"
                    value={fMin}
                    onChange={(e) => setFMin(e.target.value)}
                    className="w-full px-2 py-1.5 text-sm rounded bg-black/50 text-white placeholder-white/40 border border-white/20 focus:outline-none focus:border-white"
                  />
                  <span className="text-white/50">:</span>
                  <input
                    type="number"
                    min="0"
                    max="59"
                    placeholder="sec"
                    value={fSec}
                    onChange={(e) => setFSec(e.target.value)}
                    className="w-full px-2 py-1.5 text-sm rounded bg-black/50 text-white placeholder-white/40 border border-white/20 focus:outline-none focus:border-white"
                  />
                </div>

                <div className="flex items-center gap-3">
                  <span className="text-white/70 text-xs uppercase tracking-widest font-bold">
                    Fuel <span className="text-red-300">*</span>
                  </span>
                  <label className="flex items-center gap-1.5 text-white text-sm cursor-pointer">
                    <input
                      type="radio"
                      name="fFuel"
                      checked={fFuel === "oui"}
                      onChange={() => setFFuel("oui")}
                    />
                    Oui
                  </label>
                  <label className="flex items-center gap-1.5 text-white text-sm cursor-pointer">
                    <input
                      type="radio"
                      name="fFuel"
                      checked={fFuel === "non"}
                      onChange={() => setFFuel("non")}
                    />
                    Non
                  </label>
                </div>

                <div className="md:col-span-4 flex gap-1 flex-wrap -mt-1">
                  {TRACK_POINTS.map((p) => (
                    <button
                      key={p.name}
                      type="button"
                      onClick={() => {
                        setFMin(String(Math.floor(p.sec / 60)));
                        setFSec(String(p.sec % 60));
                      }}
                      title={`Régler à ${fmtTime(p.sec)}`}
                      className="px-2 py-0.5 rounded-full text-[10px] font-semibold text-white/80 bg-white/5 border border-white/15 hover:bg-white/15 hover:text-white transition-colors"
                    >
                      {p.name} <span className="text-white/45">{fmtTime(p.sec)}</span>
                    </button>
                  ))}
                </div>
              </div>

              <textarea
                placeholder={"Tâches à accomplir (une par ligne)\nex: Pneus\nEssence\nAileron"}
                value={fTasks}
                onChange={(e) => setFTasks(e.target.value)}
                rows={2}
                className="w-full px-2 py-1.5 text-sm rounded bg-black/50 text-white placeholder-white/40 border border-white/20 focus:outline-none focus:border-white resize-none"
              />

              {fError && (
                <div className="text-sm font-semibold text-white bg-black/40 border border-white/30 rounded px-3 py-1.5">
                  {fError}
                </div>
              )}

              <button
                type="button"
                onClick={submitAnnounce}
                disabled={!canEdit}
                className="self-start px-4 py-1.5 rounded font-black uppercase tracking-wide text-sm bg-black text-white disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Annoncer
              </button>
            </div>
          )}
        </div>
        </PanelHost>

        {(advancedMode || !!myCar) && (
        <>
        {/* LITRES AJOUTÉS (fenêtre fixe, reste modifiable même après le départ de la voiture) : sert à calculer la consommation moyenne */}
        <PanelHost modal={!!myCar} open={modal === "tech"} onClose={() => setModal(null)} title="Litres ajoutés">
        <div className="rounded-lg border-2 border-black/30 mb-4 p-3 bg-black/40">
          {(() => {
            if (configuredCars.length === 0) {
              return (
                <p className="text-white/60 text-sm">
                  Encodez au moins une voiture dans la configuration pour saisir les litres ajoutés.
                </p>
              );
            }
            const selectedId = techCarId && configuredCars.some((c) => String(c.id) === techCarId)
              ? techCarId
              : String(configuredCars[0].id);
            const car = configuredCars.find((c) => String(c.id) === selectedId);
            const records = techChecks[car.id] || [];
            const record = records[records.length - 1];
            return (
              <div className="flex flex-col gap-2">
                <select
                  value={selectedId}
                  onChange={(e) => setTechCarId(e.target.value)}
                  className="px-2 py-1.5 text-sm rounded bg-black/50 text-white border border-white/20 focus:outline-none focus:border-white w-full sm:w-64"
                >
                  {configuredCars.map((c) => (
                    <option key={c.id} value={c.id}>
                      #{c.numero} {c.pilote ? `— ${c.pilote}` : ""}
                    </option>
                  ))}
                </select>

                {!record ? (
                  <div className="flex flex-col gap-2">
                    <p className="text-white/60 text-xs">
                      Aucune saisie pour cette voiture. Une ligne se crée automatiquement à chaque
                      "Entrée" au stand, ou créez-en une manuellement :
                    </p>
                    <button
                      type="button"
                      onClick={() => createTechRecord(car.id)}
                      className="self-start px-3 py-1.5 rounded font-black uppercase tracking-wide text-xs bg-black text-white"
                    >
                      + Nouvel arrêt
                    </button>
                  </div>
                ) : (
                  <label className="flex flex-col gap-1 text-white text-sm max-w-xs">
                    ⛽ Essence ajoutée à cet arrêt (litres)
                    <input
                      type="number"
                      inputMode="decimal"
                      min="0"
                      step="0.1"
                      autoFocus
                      value={record.fuelL}
                      onChange={(e) => updateTechRecord(car.id, record.id, { fuelL: e.target.value })}
                      className="px-3 py-2 text-lg rounded bg-black/50 text-white border border-white/20 focus:outline-none focus:border-white"
                    />
                  </label>
                )}

                {records.length > 1 && (
                  <p className="text-white/40 text-[10px]">
                    {records.length} arrêts enregistrés pour cette voiture depuis le début de l'événement.
                  </p>
                )}
                {myCar && (
                  <button
                    type="button"
                    onClick={() => ackTech(car.id, record ? record.id : 0)}
                    className="self-start px-5 py-2 rounded font-black uppercase tracking-wide text-sm bg-green-500 text-black hover:bg-green-400"
                  >
                    ✔ Envoyé
                  </button>
                )}
              </div>
            );
          })()}
        </div>
        </PanelHost>

        {/* MESSAGE À L'ÉQUIPE */}
        <PanelHost modal={!!myCar} open={modal === "message"} onClose={() => setModal(null)} title="Message à l'équipe">
        <div className="rounded-lg border-2 border-black/30 mb-4 p-3 bg-black/40">
          <button
            onClick={() => setShowMessageForm((s) => !s)}
            className="w-full flex items-center justify-between text-white font-bold tracking-wide uppercase text-xs mb-2"
          >
            <span className="flex items-center gap-2">
              <MessageSquare size={14} /> Message à l'équipe
            </span>
            <span className="text-white/60 text-[10px] normal-case font-semibold">
              {showMessageForm ? "Masquer" : "Afficher"}
            </span>
          </button>
          {showMessageForm && (
          <>
          {configuredCars.length === 0 ? (
            <p className="text-white/70 text-sm">
              Encodez au moins une voiture ci-dessus pour envoyer un message.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
                <select
                  value={mCar}
                  onChange={(e) => setMCar(e.target.value)}
                  className="px-2 py-1.5 text-sm rounded bg-black/50 text-white border border-white/20 focus:outline-none focus:border-white"
                >
                  <option value="">Voiture</option>
                  {configuredCars.map((c) => (
                    <option key={c.id} value={c.id}>
                      #{c.numero} {c.pilote ? `— ${c.pilote}` : ""}
                    </option>
                  ))}
                </select>
                <input
                  type="text"
                  placeholder="Message (ex: merci l'équipe !)"
                  value={mText}
                  onChange={(e) => setMText(e.target.value)}
                  className="md:col-span-2 px-2 py-1.5 text-sm rounded bg-black/50 text-white placeholder-white/40 border border-white/20 focus:outline-none focus:border-white"
                />
                <button
                  type="button"
                  onClick={addMessage}
                  className="px-4 py-1.5 rounded font-black uppercase tracking-wide text-sm bg-black text-white"
                >
                  Envoyer
                </button>
              </div>
              {mError && (
                <div className="text-sm font-semibold text-white bg-black/40 border border-white/30 rounded px-3 py-1.5">
                  {mError}
                </div>
              )}
              <p className="text-white/50 text-[10px]">
                Le message s'affiche avec les annonces d'arrêt ci-dessus, puis disparaît
                automatiquement après 1 minute.
              </p>
            </div>
          )}
          </>
          )}
        </div>
        </PanelHost>
        </>
        )}

        {/* SETUP PANEL */}
        <div className="rounded-lg border-2 border-black/30 mb-4 overflow-hidden bg-black/40">
          <button
            onClick={() => setShowSetup((s) => !s)}
            className="w-full flex items-center justify-between px-3 py-2 text-white hover:bg-white/10"
          >
            <span className="flex items-center gap-2 font-bold tracking-wide uppercase text-xs">
              <Settings2 size={14} /> Configuration des voitures ({cars.length})
            </span>
            <span className="text-white/70 text-xs">{showSetup ? "Masquer" : "Afficher"}</span>
          </button>
          {showSetup && (
            <div className="px-3 pb-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                {cars.filter((c) => role !== "manager" || c.id === myCarId).map((c) => (
                  <div
                    key={c.id}
                    className="rounded-md p-2 border border-white/20"
                    style={{
                      background: `linear-gradient(120deg, ${c.couleur1} 0 50%, ${c.couleur2} 50% 100%)`,
                    }}
                  >
                    <div className="bg-black/60 rounded p-2 flex flex-col gap-1.5 relative">
                      {c.id > 6 && role !== "manager" && (
                        <button
                          onClick={() => removeCarRow(c.id)}
                          className="absolute top-1 right-1 text-white/40 hover:text-white"
                          title="Retirer cette voiture"
                        >
                          <X size={13} />
                        </button>
                      )}
                      <div className="text-white/60 text-[10px] uppercase tracking-widest font-semibold">
                        Voiture {c.id}
                      </div>
                      <input
                        type="text"
                        placeholder="N° voiture"
                        value={c.numero}
                        disabled={role === "manager"}
                        onFocus={() => (editingSetupRef.current = true)}
                        onBlur={() => (editingSetupRef.current = false)}
                        onChange={(e) => updateCar(c.id, "numero", e.target.value)}
                        className="w-full px-2 py-1 text-sm rounded bg-black/50 text-white placeholder-white/40 border border-white/20 focus:outline-none focus:border-white"
                      />
                      <input
                        type="text"
                        placeholder="Prénom du team manager"
                        value={c.pilote}
                        onFocus={() => (editingSetupRef.current = true)}
                        onBlur={() => (editingSetupRef.current = false)}
                        onChange={(e) => updateCar(c.id, "pilote", e.target.value)}
                        className="w-full px-2 py-1 text-sm rounded bg-black/50 text-white placeholder-white/40 border border-white/20 focus:outline-none focus:border-white"
                      />
                      <input
                        type="text"
                        placeholder="Nom de la team"
                        value={c.team || ""}
                        onFocus={() => (editingSetupRef.current = true)}
                        onBlur={() => (editingSetupRef.current = false)}
                        onChange={(e) => updateCar(c.id, "team", e.target.value)}
                        className="w-full px-2 py-1 text-sm rounded bg-black/50 text-white placeholder-white/40 border border-white/20 focus:outline-none focus:border-white"
                      />
                      {(() => {
                        const dcfg = getCfg(settings.drivers, c.id);
                        const st = stints[c.id] || { lastExitAt: null, log: [] };
                        const open = openDriverCars.has(c.id);
                        return (
                          <>
                            <button
                              type="button"
                              onClick={() =>
                                setOpenDriverCars((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(c.id)) next.delete(c.id);
                                  else next.add(c.id);
                                  return next;
                                })
                              }
                              className="flex items-center justify-between px-2 py-1 rounded bg-white/10 hover:bg-white/20 text-white text-xs font-bold"
                            >
                              <span>
                                Pilotes et ordre des relais ({dcfg.list.length}/{MAX_DRIVERS})
                              </span>
                              <span className="text-white/60">{open ? "▲" : "▼"}</span>
                            </button>
                            {open && (
                              <DriversEditor
                                cfg={dcfg}
                                currentN={(st.log || []).length + 1}
                                drivenN={(st.log || []).length + (st.lastExitAt ? 1 : 0)}
                                canEdit={canEdit}
                                onChange={(next) => pushDriversCfg(c.id, next)}
                              />
                            )}
                          </>
                        );
                      })()}
                      {settings.eventType === "course" && (
                        <div className="flex items-center gap-2">
                          <label className="text-white/60 text-[10px] uppercase tracking-widest whitespace-nowrap">
                            Conso. initiale (L/100km)
                          </label>
                          <input
                            type="number"
                            min="0"
                            step="0.1"
                            value={c.initialConsoL100 || ""}
                            onFocus={() => (editingSetupRef.current = true)}
                            onBlur={() => (editingSetupRef.current = false)}
                            onChange={(e) => updateCar(c.id, "initialConsoL100", e.target.value)}
                            className="w-20 px-2 py-0.5 text-sm rounded bg-black/50 text-white border border-white/20 focus:outline-none focus:border-white"
                          />
                        </div>
                      )}
                      <div className="flex items-center gap-2">
                        <label className="text-white/60 text-[10px] uppercase tracking-widest">
                          Couleur 1
                        </label>
                        <input
                          type="color"
                          value={c.couleur1}
                          onChange={(e) => updateCar(c.id, "couleur1", e.target.value)}
                          className="w-8 h-6 rounded cursor-pointer border border-white/30"
                        />
                        <label className="text-white/60 text-[10px] uppercase tracking-widest ml-2">
                          Couleur 2
                        </label>
                        <input
                          type="color"
                          value={c.couleur2}
                          onChange={(e) => updateCar(c.id, "couleur2", e.target.value)}
                          className="w-8 h-6 rounded cursor-pointer border border-white/30"
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              {role !== "manager" && (
              <button
                type="button"
                onClick={addCarRow}
                className="mt-2 flex items-center gap-1.5 px-3 py-1.5 rounded font-bold uppercase tracking-wide text-xs bg-black text-white"
              >
                <Plus size={13} /> Ajouter une voiture
              </button>
              )}
              <p className="text-white/50 text-[10px] mt-2">
                Astuce : chaque team manager peut renseigner uniquement la ligne de sa propre
                voiture — les autres restent gérées par leurs collègues, tout se synchronise
                automatiquement.
              </p>
            </div>
          )}
        </div>

      </div>

      {/* BARRE DE DRAPEAUX EN BAS D'ÉCRAN */}
      <div className="fixed bottom-0 left-0 right-0 z-50 border-t-4 border-black bg-black/80 backdrop-blur-sm">
        <div className="max-w-7xl mx-auto px-3 py-2 flex items-center justify-center gap-3">
          {Object.entries(FLAGS).map(([key, val]) => (
            <button
              key={key}
              onClick={() => canEdit && pushFlag(key)}
              disabled={!canEdit}
              className="flex items-center gap-2 px-6 py-2 rounded-md text-sm font-black tracking-widest uppercase border-2 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              style={{
                borderColor: val.bg,
                color: flag === key ? "#111" : "#fff",
                backgroundColor: flag === key ? val.bg : "transparent",
              }}
            >
              <Flag size={16} />
              {val.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

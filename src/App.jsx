import React, { useState, useEffect, useLayoutEffect, useRef, useMemo } from "react";
import { supabase } from "./lib/supabase";
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

// annonce vocale électronique, voix masculine à accent belge si disponible, précédée d'un bip
function speakAnnouncement(audioRef, numero, seconds, isReminder) {
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  queueSpeechJob(
    () =>
      new Promise((resolve) => {
        try {
          playBeep(audioRef);

          const delay = describeDelay(seconds);
          const prefix = isReminder ? "Rappel." : "Attention.";
          const text = `${prefix} La voiture numéro ${numero} va rentrer au stand ${delay}.`;
          const utter = new SpeechSynthesisUtterance(text);
          utter.rate = 0.92;
          utter.pitch = 0.45; // voix grave, masculine et synthétique
          utter.volume = 1;

          const applyVoiceAndSpeak = () => {
            const voices = window.speechSynthesis.getVoices();
            const voice = pickMaleVoice(voices);
            if (voice) utter.voice = voice;
            // utilise l'accent belge si une voix fr-BE existe, sinon repli sur le français standard
            utter.lang = hasBelgianVoice(voices) ? "fr-BE" : "fr-FR";
            speakWithSafety(utter, resolve);
          };

          // laisse le carillon se terminer avant de parler
          setTimeout(() => waitForVoicesThenRun(applyVoiceAndSpeak), 400);
        } catch (e) {
          resolve();
        }
      })
  );
}

// annonce vocale (voix homme) quand un manager clique sur un onglet de point de piste ("Entrée", "Source", "Kemmel", etc.)
function speakTrackPoint(audioRef, numero, pointName, sec) {
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  queueSpeechJob(
    () =>
      new Promise((resolve) => {
        try {
          playBeep(audioRef);

          const timePart =
            typeof sec === "number" && sec > 0
              ? ` Le temps estimé avant l'entrée au stand est de ${describeDuration(sec)}.`
              : "";
          const text = `Attention. La voiture numéro ${numero} est à ${pointName}.${timePart}`;
          const utter = new SpeechSynthesisUtterance(text);
          utter.rate = 0.92;
          utter.pitch = 0.45; // voix grave, masculine et synthétique
          utter.volume = 1;

          const applyVoiceAndSpeak = () => {
            const voices = window.speechSynthesis.getVoices();
            const voice = pickMaleVoice(voices);
            if (voice) utter.voice = voice;
            utter.lang = hasBelgianVoice(voices) ? "fr-BE" : "fr-FR";
            speakWithSafety(utter, resolve);
          };

          setTimeout(() => waitForVoicesThenRun(applyVoiceAndSpeak), 400);
        } catch (e) {
          resolve();
        }
      })
  );
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
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  queueSpeechJob(
    () =>
      new Promise((resolve) => {
        try {
          playAlertSiren(audioRef);

          const utter = new SpeechSynthesisUtterance(text);
          utter.rate = 1.0; // débit normal, posé, pas précipité
          utter.pitch = 0.95; // voix d'homme naturelle, quasi neutre, très intelligible
          utter.volume = 1;

          const applyVoiceAndSpeak = () => {
            const voices = window.speechSynthesis.getVoices();
            const voice = pickVoiceForLangStrict(voices, "en", false);
            // n'assigne une voix que si elle est vraiment anglaise ; sinon on laisse le
            // navigateur choisir via utter.lang plutôt que de forcer une voix française
            // qui prononcerait mal le texte anglais
            if (voice) utter.voice = voice;
            utter.lang = "en-US";
            speakWithSafety(utter, resolve);
          };

          setTimeout(() => waitForVoicesThenRun(applyVoiceAndSpeak), 400);
        } catch (e) {
          resolve();
        }
      })
  );
}

// lecture d'un message d'équipe : bip de début puis voix agréable et naturelle
function speakMessage(audioRef, numero, managerName, text) {
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  queueSpeechJob(
    () =>
      new Promise((resolve) => {
        try {
          playBeep(audioRef);

          const who = managerName ? `de ${managerName}, ` : "";
          const spoken = `Message ${who}pour la voiture numéro ${numero}. ${text}`;
          const utter = new SpeechSynthesisUtterance(spoken);
          utter.rate = 1.0;
          utter.pitch = 1.05; // ton naturel et chaleureux, pas de voix électronique
          utter.volume = 1;
          utter.lang = "fr-FR";

          const applyVoiceAndSpeak = () => {
            const voices = window.speechSynthesis.getVoices();
            const frVoices = voices.filter((v) => v.lang && v.lang.toLowerCase().startsWith("fr"));
            if (frVoices.length > 0) {
              utter.voice = frVoices[0];
              utter.lang = frVoices[0].lang;
            }
            speakWithSafety(utter, resolve);
          };

          setTimeout(() => waitForVoicesThenRun(applyVoiceAndSpeak), 400);
        } catch (e) {
          resolve();
        }
      })
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
function techRowToApp(r) {
  return {
    id: r.id,
    ts: new Date(r.ts).getTime(),
    fuelL: r.fuel_l ?? "",
    oilOk: r.oil_ok || "",
    oilAddedL: r.oil_added_l ?? "",
    coolantOk: r.coolant_ok || "",
    coolantAddedL: r.coolant_added_l ?? "",
    tireFL: r.tire_fl ?? "",
    tireFR: r.tire_fr ?? "",
    tireRL: r.tire_rl ?? "",
    tireRR: r.tire_rr ?? "",
    brakeFront: r.brake_front || "",
    engineTemp: r.engine_temp ?? "",
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

  const [flag, setFlag] = useState("vert");
  const [flash, setFlash] = useState(false);
  const [cars, setCars] = useState(emptyCars());
  const [showSetup, setShowSetup] = useState(false);
  const [showMessageForm, setShowMessageForm] = useState(true);
  const [calls, setCalls] = useState([]);
  const [messages, setMessages] = useState([]);
  const [flagHistory, setFlagHistory] = useState([{ flag: "vert", ts: Date.now() }]);
  const flagHistoryRef = useRef([]);
  useEffect(() => {
    flagHistoryRef.current = flagHistory;
  }, [flagHistory]);
  const [stints, setStints] = useState({}); // { [carId]: { lastExitAt: number|null, log: [{n, durationSec, laps, vertSec, jauneSec}] } }
  const stintsRef = useRef({});
  useEffect(() => {
    stintsRef.current = stints;
  }, [stints]);
  // fiche technique par voiture : { [carId]: [ {id, ts, fuelL, oilOk, oilAddedL, coolantOk, coolantAddedL, tireFL, tireFR, tireRL, tireRR, brakeFront} ] }
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
    tireWearLimitMm: 3,
    eventType: "course", // "essais1" | "essais2" | "qualification" | "course"
    idleConsoLh: 3, // consommation au ralenti (L/h) pendant que la voiture est à l'arrêt au stand (0 km/h)
    circuitName: "",
    circuitLengthKm: 0,
  });
  const [showSettings, setShowSettings] = useState(false);
  const [advancedMode, setAdvancedMode] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [exportCsvText, setExportCsvText] = useState(null); // null = modale fermée
  const [exportCopyStatus, setExportCopyStatus] = useState("");
  const audioCtxRef = useRef(null);
  const knownCallIdsRef = useRef(null); // null = pas encore initialisé (1er chargement)
  const justAddedLocallyRef = useRef(new Set());
  const justAddedMessageLocallyRef = useRef(new Set());
  const [soundOn, setSoundOn] = useState(true);
  const soundOnRef = useRef(true);
  useEffect(() => {
    soundOnRef.current = soundOn;
  }, [soundOn]);
  const editingSetupRef = useRef(false);
  const callsRef = useRef([]);
  const messagesRef = useRef([]);
  const carsRef = useRef([]);
  const settingsRef = useRef(settings);
  const knownMessageIdsRef = useRef(null);
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

  const configuredCars = useMemo(
    () => cars.filter((c) => c.numero.trim() !== ""),
    [cars]
  );

  // diagnostic automatique minimal : détecte les incohérences de données courantes
  const diagnostics = useMemo(() => {
    const issues = [];
    const numeros = configuredCars.map((c) => c.numero.trim());
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
      if (!carIds.has(Number(carId))) issues.push(`Fiches techniques pour une voiture supprimée (id ${carId})`);
    });
    if (settings.tankCapacityL <= 0) issues.push("Capacité du réservoir invalide (≤ 0 L)");
    if (settings.greenSpeedKmh <= 0) issues.push("Vitesse drapeau vert invalide (≤ 0 km/h)");
    if (settings.yellowSpeedKmh <= 0) issues.push("Vitesse drapeau jaune invalide (≤ 0 km/h)");
    if (settings.maxFuelSimultaneous <= 0) issues.push("Nombre de pompes invalide (≤ 0)");
    return issues;
  }, [cars, configuredCars, calls, stints, techChecks, settings]);

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
      if (settingsRef.current.eventStartAt) {
        const startMs = new Date(settingsRef.current.eventStartAt).getTime();
        if (!isNaN(startMs) && nowMs >= startMs) {
          const configured = carsRef.current.filter((c) => c.numero && c.numero.trim() !== "");
          let changed = false;
          const nextStints = { ...stintsRef.current };
          configured.forEach((car) => {
            const existing = nextStints[car.id];
            if (!existing || (!existing.lastExitAt && (!existing.log || existing.log.length === 0))) {
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

  // clignotement du drapeau jaune
  useEffect(() => {
    if (flag !== "jaune") {
      setFlash(false);
      return;
    }
    const t = setInterval(() => setFlash((f) => !f), 450);
    return () => clearInterval(t);
  }, [flag]);

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
        if (payload.eventType === "INSERT" && soundOnRef.current && !justAddedLocallyRef.current.has(call.id)) {
          const secs = (call.arrivalAt - Date.now()) / 1000;
          speakAnnouncement(audioCtxRef, call.numero, secs);
        }
        // un autre poste vient de cliquer "Entrée" (countdown -> instand) : on annonce aussi ici.
        // Sur le poste qui a cliqué, l'état local est déjà "instand" quand l'écho arrive,
        // donc cette condition est fausse et la phrase n'est pas rejouée une 2e fois.
        if (payload.eventType === "UPDATE" && soundOnRef.current) {
          const before = callsRef.current.find((c) => c.id === call.id);
          if (before && before.phase === "countdown" && call.phase === "instand") {
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
        if (payload.eventType === "INSERT" && soundOnRef.current && !justAddedMessageLocallyRef.current.has(msg.id)) {
          speakMessage(audioCtxRef, msg.numero, msg.pilote, msg.text);
        }
        setMessages((prev) => {
          const exists = prev.some((m) => m.id === msg.id);
          return exists ? prev.map((m) => (m.id === msg.id ? msg : m)) : [...prev, msg];
        });
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "app_settings" }, (payload) => {
        setSettings((local) => ({ ...local, ...payload.new.data }));
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

  // réglages globaux : une seule ligne, simple update
  async function pushSettings(next) {
    setSettings(next);
    try {
      await supabase.from("app_settings").update({ data: next, updated_at: new Date().toISOString() }).eq("id", 1);
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
    setFlag("vert");
    lastKnownFlagRef.current = "vert";
    flagTsRef.current = nowMs;
    pushSettings({ ...settings, eventStartAt: "", eventDurationSec: 0 });
    setExpandedTiles(new Set());
    setConfirmExitId(null);
    setTechCarId("");
    setConfirmReset(false);
  }

  // exporte un résumé CSV complet de l'événement (relais, carburant, usures) par voiture
  function exportEventSummary() {
    const csvEscape = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
    const rows = [
      [
        "Voiture",
        "Team",
        "Team manager",
        "Classement",
        "Relais n°",
        "Durée relais",
        "Tours",
        "Temps vert",
        "Temps jaune",
        "Essence ajoutée (L)",
        "Huile OK",
        "Huile ajoutée (L)",
        "Vase expansion OK",
        "Vase expansion ajouté (L)",
        "Température moteur (°C)",
        "Pneu AVG (mm)",
        "Pneu AVD (mm)",
        "Pneu ARG (mm)",
        "Pneu ARD (mm)",
        "Plaquettes avant (état)",
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
          car.classement || "",
          "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "",
        ]);
        return;
      }
      log.forEach((r, i) => {
        const t = tech[i] || {};
        rows.push([
          car.numero,
          car.team || "",
          car.pilote || "",
          car.classement || "",
          r.n,
          fmtTimeHMS(r.durationSec),
          r.laps || "",
          fmtTimeHMS(r.vertSec || 0),
          fmtTimeHMS(r.jauneSec || 0),
          t.fuelL || "",
          t.oilOk || "",
          t.oilAddedL || "",
          t.coolantOk || "",
          t.coolantAddedL || "",
          t.engineTemp || "",
          t.tireFL || "",
          t.tireFR || "",
          t.tireRL || "",
          t.tireRR || "",
          t.brakeFront || "",
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
  // et de l'essence réellement ajoutée à l'arrêt suivant (fiche technique, même index que le relais)
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
          if (runDistGreen + runDistYellow > 0) {
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
      if (settings.eventType === "course") {
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

    const split = computeFlagSplit(st.lastExitAt, nowMs, flagHistory);
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

  function logStintEnd(carId, refueled) {
    const st = stintsRef.current[carId] || { lastExitAt: null, log: [] };
    if (st.lastExitAt) {
      const nowMs = Date.now();
      const durationSec = Math.round((nowMs - st.lastExitAt) / 1000);
      const { vertSec, jauneSec } = computeFlagSplit(st.lastExitAt, nowMs, flagHistoryRef.current);
      const newLog = [
        ...st.log,
        {
          n: st.log.length + 1,
          durationSec,
          laps: "",
          vertSec: Math.round(vertSec),
          jauneSec: Math.round(jauneSec),
          refueled: !!refueled,
        },
      ];
      pushStints({ ...stintsRef.current, [carId]: { lastExitAt: null, log: newLog } });
    }
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

  // crée automatiquement une nouvelle fiche technique vierge pour la voiture, dès son entrée au
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
        oilOk: "",
        oilAddedL: "",
        coolantOk: "",
        coolantAddedL: "",
        tireFL: "",
        tireFR: "",
        tireRL: "",
        tireRR: "",
        brakeFront: "",
        engineTemp: "",
      };
      setTechChecks((prev) => {
        const list = prev[carId] || [];
        if (list.some((r) => r.id === newRecord.id)) return prev;
        return { ...prev, [carId]: [...list, newRecord] };
      });
      setTechCarId(String(carId));
    } catch (e) {}
  }

  // met à jour un seul champ d'une fiche technique : update Supabase ciblé par id
  async function updateTechRecord(carId, recordId, patch) {
    setTechChecks((prev) => {
      const list = prev[carId] || [];
      return { ...prev, [carId]: list.map((r) => (r.id === recordId ? { ...r, ...patch } : r)) };
    });
    const fieldMap = {
      fuelL: "fuel_l",
      oilOk: "oil_ok",
      oilAddedL: "oil_added_l",
      coolantOk: "coolant_ok",
      coolantAddedL: "coolant_added_l",
      tireFL: "tire_fl",
      tireFR: "tire_fr",
      tireRL: "tire_rl",
      tireRR: "tire_rr",
      brakeFront: "brake_front",
      engineTemp: "engine_temp",
    };
    const numericFields = new Set([
      "fuelL", "oilAddedL", "coolantAddedL", "tireFL", "tireFR", "tireRL", "tireRR", "engineTemp",
    ]);
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
    setMCar("");
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

  const theme = FLAGS[flag];
  const bgStyle =
    flag === "jaune"
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
    idle.sort((a, b) => (a.car.classement || a.car.id) - (b.car.classement || b.car.id));
    return [...withCall, ...idle];
  }, [configuredCars, calls, now]);

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
    setFCar("");
    setFMin("");
    setFSec("");
    setFFuel("");
    setFTasks("");
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
            { id: "manager", label: "Team Manager", desc: "Annonces, contrôle technique, drapeaux" },
            { id: "pitwall", label: "Pit Wall", desc: "Annonces, contrôle technique, drapeaux" },
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

  return (
    <div
      className="min-h-screen w-full transition-colors duration-500 ease-in-out"
      style={{
        ...bgStyle,
        fontFamily: "'Barlow Condensed', 'Arial Narrow', Helvetica, Arial, sans-serif",
      }}
    >
      <div className="max-w-7xl mx-auto px-3 py-4 pb-20">
        {/* EN-TÊTE + HORLOGE + DÉCOMPTE + BOUTONS (une seule ligne) */}
        <div className="flex items-center justify-between gap-3 flex-wrap mb-4 bg-black/20 rounded-lg px-3 py-2">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-md flex items-center justify-center border-2 bg-black/20 border-black text-black flex-shrink-0">
              <Flag size={16} />
            </div>
            <div>
              <h1 className="text-black text-lg tracking-wide font-black leading-none whitespace-nowrap">
                TABLEAU DES ARRÊTS
              </h1>
              <p className="text-black/60 text-[10px] tracking-widest uppercase font-semibold whitespace-nowrap">
                Gestion des arrêts au stand
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5 text-black font-mono font-bold text-base">
            <Clock size={15} className="text-black/60" />
            {fmtClock(now)}
          </div>

          {(() => {
            const evt = getEventStatus(settings, now);
            if (!evt) return null;
            return (
              <div className="flex items-center gap-1.5 text-black/90 text-xs font-semibold">
                <span className="text-black/50 text-[10px] uppercase tracking-widest">{evt.label}</span>
                {evt.seconds > 0 && (
                  <span className="font-mono font-black text-sm">{fmtTimeHMS(evt.seconds)}</span>
                )}
              </div>
            );
          })()}

          <div className="flex items-center gap-2">
            <button
              onClick={() => setAdvancedMode((s) => !s)}
              className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wide bg-black/20 text-black"
              title="Affiche/masque le contrôle technique et les messages d'équipe"
            >
              {advancedMode ? "🔧 Mode avancé" : "⚡ Mode simple"}
            </button>
            {isAdmin && (
              <button
                onClick={() => setShowSettings((s) => !s)}
                className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wide bg-black/20 text-black"
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
              className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wide bg-black/20 text-black"
              title="Activer/couper l'annonce vocale — cliquez pour tester"
            >
              {soundOn ? "🔊 Voix ON" : "🔇 Voix OFF"}
            </button>
            <div
              className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wide bg-black/20 text-black"
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
            <button
              onClick={() => {
                try {
                  localStorage.removeItem("pitboard_role");
                } catch (e) {}
                setRole(null);
              }}
              title="Changer de rôle"
              className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wide bg-black/20 text-black"
            >
              👤{" "}
              {role === "admin"
                ? "Admin"
                : role === "manager"
                ? "Team Manager"
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

        {showSettings && (
          <div className="rounded-lg border-2 border-black/30 mb-4 p-3 bg-black/40">
            <h2 className="text-white font-bold tracking-wide uppercase text-xs mb-2 flex items-center gap-2">
              <Settings2 size={14} /> Réglages fuel
            </h2>
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
                  <option value="essais1">Essais libres 1</option>
                  <option value="essais2">Essais libres 2</option>
                  <option value="qualification">Qualification</option>
                  <option value="course">Course</option>
                </select>
              </label>
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
              <label className="flex flex-col gap-1 text-white text-xs">
                Limite usure pneus (mm)
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  value={settings.tireWearLimitMm}
                  onChange={(e) =>
                    pushSettings({ ...settings, tireWearLimitMm: Math.max(0, Number(e.target.value) || 0) })
                  }
                  className="px-2 py-1.5 text-sm rounded bg-black/50 text-white border border-white/20 focus:outline-none focus:border-white"
                />
              </label>
            </div>
            <p className="text-white/50 text-[10px] mt-2">
              Ex : 3 pompes pour 6 voitures — une fois les 3 pompes annoncées, une nouvelle annonce fuel n'est acceptée que si son temps estimé dépasse le chrono le plus bas des annonces fuel en cours, augmenté de ce délai. Si "Oui" est sélectionné ci-dessus, cette limite est totalement désactivée tant que le drapeau jaune est actif. Au-delà de la limite d'usure pneus, ou à l'état "Critique" pour les plaquettes, la valeur s'affiche en rouge dans l'encart.
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
                    Confirmer ? Toutes les annonces, messages, relais, fiches techniques et
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

        {/* GRILLE DE DÉPART */}
        <div className="mb-4">
          <h2 className="text-white font-bold tracking-wide uppercase text-xs mb-2 flex items-center gap-2">
            <Timer size={14} /> Grille des annonces ({carTiles.filter((t) => t.call).length} active
            {carTiles.filter((t) => t.call).length > 1 ? "s" : ""})
          </h2>

          {carTiles.length === 0 ? (
            <div className="rounded-lg border-2 border-black/30 p-4 text-center text-white/70 bg-black/30 text-sm">
              Encodez au moins une voiture dans la configuration ci-dessous pour commencer.
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {chunkArray(carTiles, 3).map((row, rowIdx) => (
                <div
                  key={rowIdx}
                  className="grid grid-cols-3 gap-3"
                  style={{ transform: rowIdx % 2 === 1 ? "translateX(22px)" : "none" }}
                >
                  {row.map(({ car, call }) => {
                    const expanded = expandedTiles.has(car.id);
                    const d = call ? deriveCall(call, now) : null;
                    const overMax = d && d.phase === "instand" && d.pitElapsed >= AUTO_REMOVE_AFTER_PIT_SEC - 30;
                    const nearEnd = d && d.phase === "countdown" && d.remaining <= 30 && d.remaining > 0;
                    const ringColor = overMax ? "#ff3b3b" : nearEnd ? "#ffd400" : "rgba(0,0,0,0.35)";
                    return (
                      <div
                        key={car.id}
                        ref={(el) => {
                          if (el) tileNodesRef.current[car.id] = el;
                        }}
                        className="rounded-2xl p-2 shadow-lg transition-shadow"
                        style={{
                          backgroundColor: "#0a0a0a",
                          backgroundImage: `repeating-linear-gradient(45deg, ${car.couleur1} 0px, ${car.couleur1} 14px, rgba(10,10,10,1) 14px, rgba(10,10,10,1) 28px)`,
                          boxShadow: `0 0 0 2.5px ${ringColor}, 0 6px 16px rgba(0,0,0,0.35)`,
                        }}
                      >
                        <div className="rounded-[13px] bg-neutral-900/95 backdrop-blur-sm p-3 flex flex-col gap-2">
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
                            {!call && (
                              <span className="text-white/40 text-[10px] font-bold">P{car.classement || "-"}</span>
                            )}
                          </button>

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
                            !expanded && (
                              <div className="text-center text-white/40 text-xs py-2">
                                Cliquer pour annoncer un arrêt
                              </div>
                            )
                          )}

                          {/* CONTENU AGRANDI */}
                          {expanded && (
                            <div className="flex flex-col gap-2 pt-1 border-t border-white/10">
                              {/* CLASSEMENT GÉNÉRAL : éditable directement dans l'encart */}
                              <div className="flex items-center gap-2">
                                <label className="text-white/60 text-[10px] uppercase tracking-widest whitespace-nowrap">
                                  Classement général
                                </label>
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
                                    {st.lastExitAt && !call && (
                                      <div className="font-mono font-bold text-white">
                                        Durée du relais : {fmtTimeHMS((now - st.lastExitAt) / 1000)}
                                      </div>
                                    )}
                                    {st.lastExitAt && !call && (() => {
                                      const fuel = computeLiveFuelEstimate(car.id, now);
                                      if (!fuel) return null;
                                      if (!fuel.calibrated) {
                                        return (
                                          <div className="text-white/40 italic">
                                            ⛽ Calibration insuffisante (ravitaillement à enregistrer via le
                                            Contrôle technique)
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

                              {/* DERNIER CONTRÔLE TECHNIQUE : pour préparer le relais suivant */}
                              {(() => {
                                const records = techChecks[car.id] || [];
                                const last = records[records.length - 1];
                                if (!last) return null;
                                const hasAny =
                                  last.fuelL || last.oilOk || last.coolantOk ||
                                  last.tireFL || last.tireFR || last.tireRL || last.tireRR ||
                                  last.brakeFront || last.engineTemp;
                                if (!hasAny) return null;
                                const tireOver = (v) => v !== "" && v != null && Number(v) <= settings.tireWearLimitMm;
                                const tireStyle = (v) => (tireOver(v) ? { color: "#ff3b3b", fontWeight: "bold" } : {});
                                return (
                                  <div className="text-[10px] text-white/70 flex flex-col gap-1 bg-white/5 rounded px-2 py-1.5">
                                    <div className="text-white/50 uppercase tracking-widest font-bold text-[9px]">
                                      Dernier contrôle technique
                                    </div>
                                    <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
                                      {last.fuelL && <div>⛽ {last.fuelL} L</div>}
                                      {last.oilOk && (
                                        <div>
                                          🛢️ {last.oilOk === "ok" ? "OK" : `Non OK (+${last.oilAddedL || "?"}L)`}
                                        </div>
                                      )}
                                      {last.coolantOk && (
                                        <div>
                                          💧 {last.coolantOk === "ok" ? "OK" : `Non OK (+${last.coolantAddedL || "?"}L)`}
                                        </div>
                                      )}
                                      {last.engineTemp && <div>🌡️ {last.engineTemp} °C</div>}
                                      {last.brakeFront && (
                                        <div
                                          style={
                                            last.brakeFront === "critique"
                                              ? { color: "#ff3b3b", fontWeight: "bold" }
                                              : last.brakeFront === "moyen"
                                              ? { color: "#ffd400", fontWeight: "bold" }
                                              : {}
                                          }
                                        >
                                          🛑{" "}
                                          {last.brakeFront === "bon"
                                            ? "Bon"
                                            : last.brakeFront === "moyen"
                                            ? "Moyen"
                                            : last.brakeFront === "critique"
                                            ? "Critique"
                                            : last.brakeFront}
                                        </div>
                                      )}
                                    </div>
                                    {(last.tireFL || last.tireFR || last.tireRL || last.tireRR) && (
                                      <div>
                                        <div className="text-white/50 text-[9px] uppercase tracking-wide mb-0.5">
                                          🛞 Usure pneus (mm)
                                        </div>
                                        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
                                          <div className="flex justify-between gap-2">
                                            <span className="text-white/50">AVG</span>
                                            <span className="text-white font-semibold" style={tireStyle(last.tireFL)}>{last.tireFL || "?"}</span>
                                          </div>
                                          <div className="flex justify-between gap-2">
                                            <span className="text-white/50">AVD</span>
                                            <span className="text-white font-semibold" style={tireStyle(last.tireFR)}>{last.tireFR || "?"}</span>
                                          </div>
                                          <div className="flex justify-between gap-2">
                                            <span className="text-white/50">ARG</span>
                                            <span className="text-white font-semibold" style={tireStyle(last.tireRL)}>{last.tireRL || "?"}</span>
                                          </div>
                                          <div className="flex justify-between gap-2">
                                            <span className="text-white/50">ARD</span>
                                            <span className="text-white font-semibold" style={tireStyle(last.tireRR)}>{last.tireRR || "?"}</span>
                                          </div>
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                );
                              })()}
                              {call ? (
                                <>
                                  {d.phase === "countdown" ? (
                                    <>
                                      <div className="flex gap-1.5 flex-wrap">
                                        <button
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
                                        </button>
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
                              ) : (
                                <div className="text-center text-white/50 text-xs py-2">
                                  Utilisez le formulaire "Annoncer un arrêt" ci-dessus pour cette voiture.
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          )}

          {messages.length > 0 && (
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 mt-3">
              {messages.map((m) => (
                <div
                  key={`msg-${m.id}`}
                  className="rounded-2xl p-2 shadow-lg"
                  style={{
                    backgroundColor: "#0a0a0a",
                    backgroundImage: `repeating-linear-gradient(45deg, ${m.couleur1} 0px, ${m.couleur1} 14px, rgba(10,10,10,1) 14px, rgba(10,10,10,1) 28px)`,
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
        <div className="rounded-lg border-2 border-black/30 mb-4 p-3 bg-black/40">
          <h2 className="text-white font-bold tracking-wide uppercase text-xs mb-2 flex items-center gap-2">
            <Plus size={14} /> Annoncer un arrêt
          </h2>
          {configuredCars.length === 0 ? (
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

        {advancedMode && (
        <>
        {/* CONTRÔLE TECHNIQUE (fenêtre fixe, reste modifiable même après le départ de la voiture) */}
        <div className="rounded-lg border-2 border-black/30 mb-4 p-3 bg-black/40">
          <h2 className="text-white font-bold tracking-wide uppercase text-xs mb-2 flex items-center gap-2">
            <Settings2 size={14} /> Contrôle technique
          </h2>
          {(() => {
            if (configuredCars.length === 0) {
              return (
                <p className="text-white/60 text-sm">
                  Encodez au moins une voiture dans la configuration pour utiliser le contrôle
                  technique.
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
                      Aucune fiche pour cette voiture. Une fiche se crée automatiquement à chaque
                      "Entrée" au stand, ou créez-en une manuellement :
                    </p>
                    <button
                      type="button"
                      onClick={() => createTechRecord(car.id)}
                      className="self-start px-3 py-1.5 rounded font-black uppercase tracking-wide text-xs bg-black text-white"
                    >
                      + Nouvelle fiche
                    </button>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {/* SECTION FLUIDES */}
                    <div className="bg-white/5 rounded-md p-2.5 flex flex-col gap-2 md:col-span-2">
                      <div className="text-white/50 text-[10px] uppercase tracking-widest font-bold">
                        Fluides
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <label className="flex flex-col gap-1 text-white text-xs">
                          ⛽ Essence ajoutée (litres)
                          <input
                            type="number"
                            min="0"
                            step="0.1"
                            value={record.fuelL}
                            onChange={(e) => updateTechRecord(car.id, record.id, { fuelL: e.target.value })}
                            className="px-2 py-1.5 text-sm rounded bg-black/50 text-white border border-white/20 focus:outline-none focus:border-white"
                          />
                        </label>

                        <div className="flex flex-col gap-1 text-white text-xs">
                          🛢️ Niveau d'huile
                          <div className="flex items-center gap-3">
                            <label className="flex items-center gap-1.5 cursor-pointer">
                              <input
                                type="radio"
                                name={`oil-${car.id}-${record.id}`}
                                checked={record.oilOk === "ok"}
                                onChange={() => updateTechRecord(car.id, record.id, { oilOk: "ok", oilAddedL: "" })}
                              />
                              OK
                            </label>
                            <label className="flex items-center gap-1.5 cursor-pointer">
                              <input
                                type="radio"
                                name={`oil-${car.id}-${record.id}`}
                                checked={record.oilOk === "non"}
                                onChange={() => updateTechRecord(car.id, record.id, { oilOk: "non" })}
                              />
                              Non OK
                            </label>
                          </div>
                          {record.oilOk === "non" && (
                            <input
                              type="number"
                              min="0"
                              step="0.1"
                              placeholder="Litres ajoutés"
                              value={record.oilAddedL}
                              onChange={(e) => updateTechRecord(car.id, record.id, { oilAddedL: e.target.value })}
                              className="px-2 py-1.5 text-sm rounded bg-black/50 text-white placeholder-white/40 border border-white/20 focus:outline-none focus:border-white"
                            />
                          )}
                        </div>

                        <div className="flex flex-col gap-1 text-white text-xs">
                          💧 Vase d'expansion
                          <div className="flex items-center gap-3">
                            <label className="flex items-center gap-1.5 cursor-pointer">
                              <input
                                type="radio"
                                name={`coolant-${car.id}-${record.id}`}
                                checked={record.coolantOk === "ok"}
                                onChange={() =>
                                  updateTechRecord(car.id, record.id, { coolantOk: "ok", coolantAddedL: "" })
                                }
                              />
                              OK
                            </label>
                            <label className="flex items-center gap-1.5 cursor-pointer">
                              <input
                                type="radio"
                                name={`coolant-${car.id}-${record.id}`}
                                checked={record.coolantOk === "non"}
                                onChange={() => updateTechRecord(car.id, record.id, { coolantOk: "non" })}
                              />
                              Non OK
                            </label>
                          </div>
                          {record.coolantOk === "non" && (
                            <input
                              type="number"
                              min="0"
                              step="0.1"
                              placeholder="Litres ajoutés"
                              value={record.coolantAddedL}
                              onChange={(e) =>
                                updateTechRecord(car.id, record.id, { coolantAddedL: e.target.value })
                              }
                              className="px-2 py-1.5 text-sm rounded bg-black/50 text-white placeholder-white/40 border border-white/20 focus:outline-none focus:border-white"
                            />
                          )}
                        </div>
                      </div>
                    </div>

                    {/* SECTION FREINS & MOTEUR */}
                    <div className="bg-white/5 rounded-md p-2.5 flex flex-col gap-2">
                      <div className="text-white/50 text-[10px] uppercase tracking-widest font-bold">
                        Freins & moteur
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <label className="flex flex-col gap-1 text-white text-xs">
                          🛑 Plaquettes avant (état)
                          <select
                            value={record.brakeFront}
                            onChange={(e) =>
                              updateTechRecord(car.id, record.id, { brakeFront: e.target.value })
                            }
                            className="px-2 py-1.5 text-sm rounded bg-black/50 text-white border border-white/20 focus:outline-none focus:border-white"
                          >
                            <option value="">—</option>
                            <option value="bon">Bon</option>
                            <option value="moyen">Moyen</option>
                            <option value="critique">Critique</option>
                          </select>
                        </label>

                        <label className="flex flex-col gap-1 text-white text-xs">
                          🌡️ Température moteur (°C)
                          <input
                            type="number"
                            min="0"
                            step="1"
                            value={record.engineTemp}
                            onChange={(e) =>
                              updateTechRecord(car.id, record.id, { engineTemp: e.target.value })
                            }
                            className="px-2 py-1.5 text-sm rounded bg-black/50 text-white border border-white/20 focus:outline-none focus:border-white"
                          />
                        </label>
                      </div>
                    </div>

                    {/* SECTION PNEUS */}
                    <div className="bg-white/5 rounded-md p-2.5 flex flex-col gap-2">
                      <div className="text-white/50 text-[10px] uppercase tracking-widest font-bold">
                        🛞 Usure des pneus (mm)
                      </div>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                        <label className="flex flex-col gap-1 text-white text-xs">
                          Avant gauche
                          <input
                            type="number"
                            min="0"
                            step="0.1"
                            value={record.tireFL}
                            onChange={(e) =>
                              updateTechRecord(car.id, record.id, { tireFL: e.target.value })
                            }
                            className="px-2 py-1.5 text-sm rounded bg-black/50 text-white border border-white/20 focus:outline-none focus:border-white"
                          />
                        </label>
                        <label className="flex flex-col gap-1 text-white text-xs">
                          Avant droit
                          <input
                            type="number"
                            min="0"
                            step="0.1"
                            value={record.tireFR}
                            onChange={(e) =>
                              updateTechRecord(car.id, record.id, { tireFR: e.target.value })
                            }
                            className="px-2 py-1.5 text-sm rounded bg-black/50 text-white border border-white/20 focus:outline-none focus:border-white"
                          />
                        </label>
                        <label className="flex flex-col gap-1 text-white text-xs">
                          Arrière gauche
                          <input
                            type="number"
                            min="0"
                            step="0.1"
                            value={record.tireRL}
                            onChange={(e) =>
                              updateTechRecord(car.id, record.id, { tireRL: e.target.value })
                            }
                            className="px-2 py-1.5 text-sm rounded bg-black/50 text-white border border-white/20 focus:outline-none focus:border-white"
                          />
                        </label>
                        <label className="flex flex-col gap-1 text-white text-xs">
                          Arrière droit
                          <input
                            type="number"
                            min="0"
                            step="0.1"
                            value={record.tireRR}
                            onChange={(e) =>
                              updateTechRecord(car.id, record.id, { tireRR: e.target.value })
                            }
                            className="px-2 py-1.5 text-sm rounded bg-black/50 text-white border border-white/20 focus:outline-none focus:border-white"
                          />
                        </label>
                      </div>
                    </div>
                  </div>
                )}

                {records.length > 1 && (
                  <p className="text-white/40 text-[10px]">
                    {records.length} fiches enregistrées pour cette voiture depuis le début de l'événement.
                  </p>
                )}
              </div>
            );
          })()}
        </div>

        {/* MESSAGE À L'ÉQUIPE */}
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
                {cars.map((c) => (
                  <div
                    key={c.id}
                    className="rounded-md p-2 border border-white/20"
                    style={{
                      background: `linear-gradient(120deg, ${c.couleur1} 0 50%, ${c.couleur2} 50% 100%)`,
                    }}
                  >
                    <div className="bg-black/60 rounded p-2 flex flex-col gap-1.5 relative">
                      {c.id > 6 && (
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
              <button
                type="button"
                onClick={addCarRow}
                className="mt-2 flex items-center gap-1.5 px-3 py-1.5 rounded font-bold uppercase tracking-wide text-xs bg-black text-white"
              >
                <Plus size={13} /> Ajouter une voiture
              </button>
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

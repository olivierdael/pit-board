// Affichage des données live d'une voiture : temps, écarts avec les voitures voisines, horloge course.

// 112137 -> "1:52.137" ; 35631 -> "35.631"
export function fmtMs(ms) {
  if (ms == null || !Number.isFinite(ms)) return "–";
  const total = Math.max(0, Math.round(ms));
  const m = Math.floor(total / 60000);
  const sec = ((total % 60000) / 1000).toFixed(3);
  return m > 0 ? `${m}:${sec.padStart(6, "0")}` : sec;
}

// secteur court : 35631 -> "35.6"
export function fmtSec1(ms) {
  if (ms == null || !Number.isFinite(ms)) return "–";
  return (ms / 1000).toFixed(1);
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

// Météo du circuit (Open-Meteo : gratuit, sans clé) + petites fonctions de carte (projection Web Mercator, tuiles OpenStreetMap)

// ---------- libellés des codes météo (WMO) ----------
export function weatherLabel(code) {
  const c = Number(code);
  if (c === 0) return { icon: "☀️", text: "ciel dégagé" };
  if (c === 1 || c === 2) return { icon: "🌤️", text: "peu nuageux" };
  if (c === 3) return { icon: "☁️", text: "couvert" };
  if (c === 45 || c === 48) return { icon: "🌫️", text: "brouillard" };
  if (c >= 51 && c <= 57) return { icon: "🌦️", text: "bruine" };
  if (c >= 61 && c <= 67) return { icon: "🌧️", text: "pluie" };
  if (c >= 71 && c <= 77) return { icon: "🌨️", text: "neige" };
  if (c >= 80 && c <= 82) return { icon: "🌦️", text: "averses" };
  if (c === 85 || c === 86) return { icon: "🌨️", text: "averses de neige" };
  if (c >= 95) return { icon: "⛈️", text: "orage" };
  return { icon: "", text: "" };
}

// ---------- lecture de la météo ----------
export function weatherUrl(lat, lon) {
  return (
    "https://api.open-meteo.com/v1/forecast?latitude=" + encodeURIComponent(lat) + "&longitude=" + encodeURIComponent(lon) +
    "&current=temperature_2m,precipitation,weather_code,wind_speed_10m&hourly=temperature_2m,precipitation_probability,precipitation,weather_code" +
    "&forecast_hours=4&timezone=auto&timeformat=unixtime&wind_speed_unit=kmh"
  );
}

// transforme la réponse d'Open-Meteo : { at, tempC, windKmh, precipMm, code, hours: [{ t (ms), temp, pop (%), mm, code }] }
export function parseWeather(j, nowMs = Date.now()) {
  if (!j || !j.current || typeof j.current.temperature_2m !== "number") return null;
  const h = j.hourly || {};
  const times = Array.isArray(h.time) ? h.time : [];
  const hours = times.map((ts, i) => ({
    t: ts * 1000,
    temp: Array.isArray(h.temperature_2m) ? h.temperature_2m[i] : null,
    pop: Array.isArray(h.precipitation_probability) ? h.precipitation_probability[i] : null,
    mm: Array.isArray(h.precipitation) ? h.precipitation[i] : null,
    code: Array.isArray(h.weather_code) ? h.weather_code[i] : null,
  }));
  return {
    at: nowMs,
    tempC: j.current.temperature_2m,
    windKmh: typeof j.current.wind_speed_10m === "number" ? j.current.wind_speed_10m : null,
    precipMm: typeof j.current.precipitation === "number" ? j.current.precipitation : 0,
    code: j.current.weather_code,
    hours,
  };
}

export async function fetchWeather(lat, lon, fetchFn = (typeof fetch !== "undefined" ? fetch : null)) {
  if (!fetchFn || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const r = await fetchFn(weatherUrl(lat, lon));
  if (!r || !r.ok) throw new Error("météo indisponible");
  return parseWeather(await r.json());
}

// recherche d'un lieu par son nom (circuit, ville) : [{ name, place, lat, lon }]
export async function geocode(name, fetchFn = (typeof fetch !== "undefined" ? fetch : null)) {
  const q = String(name || "").trim();
  if (!fetchFn || q.length < 2) return [];
  const r = await fetchFn("https://geocoding-api.open-meteo.com/v1/search?count=6&language=fr&name=" + encodeURIComponent(q));
  if (!r || !r.ok) throw new Error("recherche indisponible");
  const j = await r.json();
  return (j.results || []).map((x) => ({
    name: x.name,
    place: [x.admin1, x.country].filter(Boolean).join(", "),
    lat: x.latitude,
    lon: x.longitude,
  }));
}

// ---------- bulletin : maintenant + prévisions des 2 heures suivantes ----------
export function buildBulletin(w, nowMs = Date.now()) {
  if (!w) return null;
  const cur = weatherLabel(w.code);
  const fmtH = (t) => new Date(t).toLocaleTimeString("fr-BE", { hour: "2-digit", minute: "2-digit" });
  const next = (w.hours || []).filter((x) => x.t > nowMs - 5 * 60000 && x.t <= nowMs + 2 * 3600000 + 5 * 60000).slice(0, 3);
  const rainy = (x) => (x.mm != null && x.mm >= 0.2) || (x.pop != null && x.pop >= 50);
  const firstRain = next.find(rainy);
  const temps = next.map((x) => x.temp).filter((v) => typeof v === "number");
  const trend = temps.length >= 2 ? temps[temps.length - 1] - temps[0] : null;
  const lines = next.map((x) => {
    const l = weatherLabel(x.code);
    return {
      time: fmtH(x.t),
      temp: x.temp,
      text: `${l.icon} ${l.text}`.trim(),
      rain: x.pop != null || x.mm != null ? `${x.pop != null ? x.pop + " %" : ""}${x.pop != null && x.mm != null ? " · " : ""}${x.mm != null ? x.mm.toFixed(1) + " mm" : ""}` : "",
      wet: rainy(x),
    };
  });
  let summary;
  if (w.precipMm >= 0.2) summary = "🌧 Il pleut actuellement.";
  else if (firstRain) summary = `🌧 Pluie probable vers ${fmtH(firstRain.t)}.`;
  else summary = "Pas de pluie prévue dans les 2 heures.";
  if (trend != null && Math.abs(trend) >= 2) summary += trend > 0 ? ` Température en hausse (+${trend.toFixed(0)} °C).` : ` Température en baisse (${trend.toFixed(0)} °C).`;
  return {
    now: { temp: w.tempC, wind: w.windKmh, text: `${cur.icon} ${cur.text}`.trim() },
    lines,
    summary,
    rain: !!(w.precipMm >= 0.2 || firstRain),
  };
}

// ---------- carte : Web Mercator (tuiles de 256 px) ----------
export const TILE = 256;
export function lonLatToWorld(lon, lat, z) {
  const s = TILE * Math.pow(2, z);
  const x = ((lon + 180) / 360) * s;
  const r = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * s;
  return { x, y };
}
export function worldToLonLat(x, y, z) {
  const s = TILE * Math.pow(2, z);
  const lon = (x / s) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / s;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return { lon, lat };
}

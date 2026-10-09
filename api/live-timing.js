// Relais Vercel (secours) pour le flux RIS Live Timing.
// Utilisé uniquement si le navigateur n'a pas le droit de lire le flux directement (CORS).
// Adresse fixe, uuid validé : ce n'est pas un proxy ouvert.
// Si le site RIS refuse aussi les requêtes venant de Vercel, ce relais ne pourra pas aider.

export default async function handler(req, res) {
  const uuid = String((req.query && req.query.uuid) || "");
  if (!/^[0-9a-fA-F-]{36}$/.test(uuid)) {
    res.status(400).json({ error: "uuid invalide" });
    return;
  }
  try {
    const upstream = await fetch(`https://live.ris-timing.be/api/live-timing?uuid=${uuid}`, {
      headers: { Accept: "application/json", "User-Agent": "PitBoard-relay" },
    });
    const body = await upstream.text();
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");
    res.status(upstream.status).send(body);
  } catch (e) {
    res.status(502).json({ error: "flux RIS injoignable" });
  }
}

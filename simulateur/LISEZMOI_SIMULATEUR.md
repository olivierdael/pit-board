# Simulateur de course PitBoard

Rejoue la vraie course **24 Heures 2CV / C1 de Spa 2025** (115 voitures, temps au tour et intermédiaires S1/S2/S3 de chaque voiture, arrêts au stand, neutralisations) et l'envoie à PitBoard comme si c'était le chronométrage RIS en direct. L'application n'est pas modifiée.

## Une seule fois : installer

1. Copiez le dossier `simulateur` (avec `simulateur.mjs` et `data.json`) dans `pitboard-propre`, à côté de `src` et `package.json`.
2. Dans PitBoard, rôle **Admin** → Configuration → *Chronométrage live (RIS)* :
   - activez le live ;
   - mode « lecture directe » ;
   - uuid : `00000000-0000-4000-8000-000000000001`
3. Encodez vos voitures dans la configuration comme d'habitude (numéros 260, 53, 40, 331, 499, 415…).

## Lancer la simulation

Terminal ouvert dans `pitboard-propre` :

```
node simulateur\simulateur.mjs --voitures 260,53,40,331,499,415 --depart 3h
```

- `--voitures` : vos numéros. Si le numéro existait en 2025 (par exemple 265, 271, 276 = EBRT 2, 1 et 3), vous gardez cette vraie voiture avec ses vrais temps. Sinon, le numéro prend la place d'une voiture du peloton aux rangs P10, P26, P27, P28, P29 et P46 au moment du départ.
- `--depart 3h` : la simulation démarre à 3 h de course (aussi `90m`, `0`, `12h`…). Par défaut : 0 (départ).
- `--vitesse 1` : temps réel (défaut). Une vitesse plus grande accélère la course, mais les comptes à rebours de dépassement ne sont alors plus fidèles : gardez 1 pour tester les estimations.

Laissez la fenêtre ouverte : elle affiche une ligne toutes les 15 s. **Ctrl+C** pour arrêter.

## Arrêter proprement (important)

La simulation écrit dans la **même base Supabase** que votre application : tous les postes (managers compris) voient la simulation. Après vos essais :

```
node simulateur\simulateur.mjs --arret
```

puis dans la configuration Admin, remettez le vrai uuid RIS (ou désactivez le live), et faites « Réinitialiser la course » avant la vraie course.

## Ce qui est simulé / ce qui ne l'est pas

- Simulé : classement, tours, temps au tour, S1/S2/S3, meilleurs temps, écarts, arrêts, drapeau vert/jaune du flux, messages de la direction de course (dont des pénalités visant vos voitures), horloge de course.
- Non simulé : les drapeaux automatiques et l'enregistrement des meilleurs temps par pilote sont faits par le poste Admin lorsqu'il lit le vrai flux RIS ; avec le simulateur, vous les testez à la main.
- Les neutralisations (jaune) sont déduites des données : quand le peloton ralentit en même temps.
- Le format du vrai flux RIS n'a été vu qu'en partie : cette simulation teste vos écrans et les estimations, pas la connexion à RIS elle-même.

Option `--essai` : n'écrit rien dans Supabase (test à blanc). Option `--dump` : enregistre la dernière image dans `dernier_flux.json`.

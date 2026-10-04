# Guide de déploiement — PitBoard (Supabase + Vercel/Netlify)

## 1. Créer le projet Supabase (gratuit, sans carte bancaire)

1. Allez sur https://supabase.com et créez un compte.
2. Cliquez "New project", choisissez un nom (ex. `pitboard`), un mot de passe de base de données (à noter, pas besoin de le réutiliser ailleurs), et une région proche de vous.
3. Attendez ~2 minutes que le projet soit provisionné.

## 2. Configurer les tables

1. Dans le menu de gauche, ouvrez **SQL Editor**.
2. Collez l'intégralité du contenu de `supabase_schema.sql` (fourni séparément) et cliquez **Run**.
3. Vérifiez dans **Table Editor** que les 9 tables sont bien créées, et que `cars` contient déjà 6 lignes.

## 3. Activer Realtime

Le script SQL active déjà la réplication (`alter publication supabase_realtime add table ...`). Pour confirmer :

1. Allez dans **Database → Replication**.
2. Vérifiez que les 9 tables du projet apparaissent bien comme "activées" pour Realtime. Si l'une d'elles ne l'est pas, cochez-la manuellement.

## 4. Récupérer les clés

1. Allez dans **Project Settings → API**.
2. Notez :
   - **Project URL** → deviendra `VITE_SUPABASE_URL`
   - **anon public key** → deviendra `VITE_SUPABASE_ANON_KEY`
3. **Ne prenez jamais la clé `service_role`** — elle ne doit jamais aller dans le frontend.

## 5. Configurer les rôles (pas d'authentification réelle)

Comme convenu, il n'y a pas de vrais comptes utilisateurs. Au premier lancement, chaque poste choisit son rôle (Admin / Team Manager / Pit Wall / Read Only) dans un écran dédié — ce choix est mémorisé sur cet appareil (bouton "👤" dans l'en-tête pour en changer). Cette restriction est appliquée **uniquement côté interface** : un utilisateur qui ouvrirait les outils développeur de son navigateur pourrait techniquement la contourner. C'est le compromis "usage interne d'équipe" validé ensemble.

## 6. Tester en local avant de déployer

```bash
cd pitboard
npm install
cp .env.example .env
# éditez .env et collez vos deux valeurs Supabase
npm run dev
```

Ouvrez l'URL affichée (ex. `http://localhost:5173`) dans deux fenêtres/navigateurs différents et suivez la procédure de test multi-PC ci-dessous **avant** de déployer.

## 7. Déployer gratuitement (Vercel)

1. Créez un compte sur https://vercel.com (gratuit, connexion possible via GitHub).
2. Poussez ce dossier de projet sur un dépôt GitHub (créez-en un si besoin : `git init`, `git add .`, `git commit -m "pitboard"`, puis suivez GitHub pour créer le dépôt et pousser).
3. Sur Vercel : **Add New → Project**, importez ce dépôt GitHub.
4. Dans les réglages du projet Vercel, section **Environment Variables**, ajoutez :
   - `VITE_SUPABASE_URL` = votre URL Supabase
   - `VITE_SUPABASE_ANON_KEY` = votre clé anonyme
5. Cliquez **Deploy**. Après ~1 minute, Vercel vous donne une URL du type `https://pitboard-xxxx.vercel.app`.

### Alternative : Netlify
Même principe : compte gratuit sur https://netlify.com, "Add new site → Import an existing project", même dépôt GitHub, mêmes deux variables d'environnement dans **Site settings → Environment variables**, commande de build `npm run build`, dossier de publication `dist`.

## 8. Ouvrir l'application sur plusieurs PC

Chaque poste (les 6 team managers + l'écran central) ouvre simplement l'URL Vercel/Netlify obtenue à l'étape 7, dans un navigateur normal. Aucune installation, aucun compte Claude, aucun abonnement payant requis.

## 9. Procédure de test multi-PC

À faire une fois avant la course, avec au moins 2 postes ouverts sur la même URL :

| # | Test | Résultat attendu |
|---|---|---|
| 1 | PC 1 modifie le numéro d'une voiture | PC 2 le voit apparaître en quelques secondes |
| 2 | PC 2 modifie un réglage (ex. capacité réservoir) | PC 1 voit la nouvelle valeur immédiatement |
| 3 | PC 1 ajoute un message d'équipe | Tous les autres PC le voient, avec l'annonce vocale si activée |
| 4 | PC 1 clique un drapeau | Tous les PC changent de couleur et entendent l'annonce en même temps |
| 5 | Fermez complètement le navigateur sur un PC, rouvrez l'URL | Toutes les données (voitures, annonces, relais) sont toujours là |
| 6 | Redémarrez l'ordinateur, rouvrez l'URL | Idem, rien n'est perdu |
| 7 | Coupez le Wi-Fi/Internet sur un PC quelques secondes | L'indicateur passe à 🔴 Hors ligne, puis 🟢 Connecté au retour, sans doublon de données |

## 10. Sauvegarde et restauration des données

**Sauvegarde manuelle** (recommandé avant chaque événement) :
1. Dans Supabase : **Database → Backups** (les projets gratuits ont une sauvegarde automatique quotidienne conservée quelques jours).
2. Pour une sauvegarde manuelle immédiate exportable : **SQL Editor**, exécutez `select * from cars;` (et pareil pour chaque table), puis **Export → CSV** sur le résultat. Répétez pour les 9 tables si vous voulez une sauvegarde complète hors Supabase.
3. Alternative simple : utilisez le bouton **"📄 Exporter le résumé (CSV)"** déjà présent dans l'application (Réglages) pour garder une trace lisible de chaque course.

**Restauration** :
- Si une sauvegarde automatique Supabase existe : **Database → Backups → Restore**.
- Sinon, réimportez vos CSV exportés manuellement via **Table Editor → Insert → Import data from CSV** sur chaque table concernée.

**Repartir sur une base propre pour un nouvel événement** : utilisez le bouton **"Réinitialiser la course"** (réservé au rôle Admin) directement dans l'application — il efface les annonces, relais, fiches techniques et messages, mais conserve la configuration des voitures et les réglages.

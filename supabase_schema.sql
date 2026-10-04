-- ============================================================
-- PITBOARD — SCHÉMA SUPABASE COMPLET
-- Usage interne d'équipe : rôles gérés côté interface uniquement,
-- pas d'authentification Supabase. La clé "anon" a un accès complet.
-- ============================================================

-- ============================================================
-- CARS — configuration des voitures (mise à jour ciblée par ligne)
-- ============================================================
create table cars (
  id integer primary key,
  numero text not null default '',
  pilote text default '',
  team text default '',
  couleur1 text not null,
  couleur2 text not null,
  classement integer,
  initial_conso_l100 numeric
);

-- ============================================================
-- APP_SETTINGS — réglages globaux (une seule ligne, id fixe = 1)
-- ============================================================
create table app_settings (
  id integer primary key default 1 check (id = 1),
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ============================================================
-- RACE_FLAG — drapeau courant (une seule ligne, id fixe = 1)
-- ============================================================
create table race_flag (
  id integer primary key default 1 check (id = 1),
  value text not null default 'vert' check (value in ('vert','jaune','rouge')),
  updated_at timestamptz not null default now()
);

create table flag_history (
  id bigint generated always as identity primary key,
  flag text not null check (flag in ('vert','jaune','rouge')),
  ts timestamptz not null default now()
);

-- ============================================================
-- PIT_CALLS — annonces d'arrêt, historisées (jamais supprimées)
-- ============================================================
create table pit_calls (
  id bigint generated always as identity primary key,
  car_id integer not null references cars(id) on delete cascade,
  tasks text[] default '{}',
  fuel text check (fuel in ('oui','non')),
  phase text not null check (phase in ('countdown','instand')),
  arrival_at timestamptz,
  pit_start_at timestamptz,
  status text not null default 'active' check (status in ('active','completed','cancelled')),
  ended_at timestamptz,
  created_at timestamptz not null default now()
);

-- une seule annonce "active" par voiture à la fois
create unique index one_active_call_per_car
  on pit_calls (car_id)
  where status = 'active';

-- ============================================================
-- TEAM_MESSAGES — messages d'équipe (expirent après 1 min côté client)
-- ============================================================
create table team_messages (
  id bigint generated always as identity primary key,
  car_id integer references cars(id) on delete cascade,
  text text not null,
  posted_at timestamptz not null default now()
);

-- ============================================================
-- STINTS — relais terminés (historique en lecture seule après coup)
-- ============================================================
create table stints (
  id bigint generated always as identity primary key,
  car_id integer not null references cars(id) on delete cascade,
  n integer not null,
  duration_sec integer,
  laps integer,
  vert_sec integer default 0,
  jaune_sec integer default 0,
  idle_sec integer default 0,
  refueled boolean default false,
  created_at timestamptz not null default now(),
  unique (car_id, n)
);

-- relais en cours (ouvert), une ligne par voiture, mise à jour fréquente
create table stint_current (
  car_id integer primary key references cars(id) on delete cascade,
  last_exit_at timestamptz
);

-- ============================================================
-- TECHNICAL_CHECKS — fiches techniques par arrêt
-- ============================================================
create table technical_checks (
  id bigint generated always as identity primary key,
  car_id integer not null references cars(id) on delete cascade,
  ts timestamptz not null default now(),
  fuel_l numeric,
  oil_ok text check (oil_ok in ('ok','non')),
  oil_added_l numeric,
  coolant_ok text check (coolant_ok in ('ok','non')),
  coolant_added_l numeric,
  tire_fl numeric,
  tire_fr numeric,
  tire_rl numeric,
  tire_rr numeric,
  brake_front text check (brake_front in ('bon','moyen','critique')),
  engine_temp numeric
);

-- ============================================================
-- ROW LEVEL SECURITY
-- Pas d'authentification réelle : accès complet pour la clé "anon".
-- RLS reste activé (bonne pratique, permet de durcir plus tard sans
-- tout réécrire) mais les policies autorisent tout pour l'instant.
-- ============================================================
alter table cars enable row level security;
alter table app_settings enable row level security;
alter table race_flag enable row level security;
alter table flag_history enable row level security;
alter table pit_calls enable row level security;
alter table team_messages enable row level security;
alter table stints enable row level security;
alter table stint_current enable row level security;
alter table technical_checks enable row level security;

create policy "accès complet anon" on cars for all using (true) with check (true);
create policy "accès complet anon" on app_settings for all using (true) with check (true);
create policy "accès complet anon" on race_flag for all using (true) with check (true);
create policy "accès complet anon" on flag_history for all using (true) with check (true);
create policy "accès complet anon" on pit_calls for all using (true) with check (true);
create policy "accès complet anon" on team_messages for all using (true) with check (true);
create policy "accès complet anon" on stints for all using (true) with check (true);
create policy "accès complet anon" on stint_current for all using (true) with check (true);
create policy "accès complet anon" on technical_checks for all using (true) with check (true);

-- ============================================================
-- REALTIME — active la réplication sur toutes les tables mutables
-- ============================================================
alter publication supabase_realtime add table
  cars, app_settings, race_flag, flag_history,
  pit_calls, team_messages, stints, stint_current, technical_checks;

-- ============================================================
-- DONNÉES INITIALES — les 6 voitures de base avec leurs couleurs par défaut
-- ============================================================
insert into cars (id, couleur1, couleur2, classement) values
  (1, '#ff2d55', '#ffffff', 1),
  (2, '#0a84ff', '#ffffff', 2),
  (3, '#ffcc00', '#111111', 3),
  (4, '#30d158', '#111111', 4),
  (5, '#bf5af2', '#ffffff', 5),
  (6, '#ff9500', '#111111', 6);

insert into app_settings (id, data) values (1, '{}'::jsonb);
insert into race_flag (id, value) values (1, 'vert');

-- ============================================================
-- CORRECTIF : conserver un instantané (numéro/pilote/couleurs) au moment
-- de l'annonce ou du message, comme le fait l'application actuelle —
-- si la configuration de la voiture change ensuite, l'annonce/message
-- déjà publiés ne doivent pas changer rétroactivement.
-- ============================================================
alter table pit_calls add column numero text;
alter table pit_calls add column pilote text;
alter table pit_calls add column couleur1 text;
alter table pit_calls add column couleur2 text;

alter table team_messages add column numero text;
alter table team_messages add column pilote text;
alter table team_messages add column couleur1 text;
alter table team_messages add column couleur2 text;

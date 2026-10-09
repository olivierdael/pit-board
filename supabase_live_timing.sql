-- ============================================================
-- PITBOARD — AJOUT : FLUX LIVE TIMING (RIS)
-- À exécuter une seule fois dans Supabase -> SQL Editor.
-- Une seule ligne (id = 1) : le poste Admin y écrit le dernier flux lu,
-- tous les postes la reçoivent en temps réel.
-- ============================================================
create table if not exists live_timing (
  id integer primary key default 1 check (id = 1),
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table live_timing enable row level security;

drop policy if exists "accès complet anon" on live_timing;
create policy "accès complet anon" on live_timing for all using (true) with check (true);

do $$
begin
  alter publication supabase_realtime add table live_timing;
exception when duplicate_object then null;
end $$;

insert into live_timing (id, data) values (1, '{}'::jsonb)
on conflict (id) do nothing;

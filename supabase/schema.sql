-- Archivio di "NYC in compagnia": una riga per chiave (state, snapshots, admins, secret, fails, usage).
-- Il server la usa solo con la chiave di servizio. RLS attiva e senza regole:
-- le chiavi pubbliche (anon) non leggono né scrivono nulla.
create table if not exists public.nyc_kv (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.nyc_kv enable row level security;
revoke all on public.nyc_kv from anon, authenticated;

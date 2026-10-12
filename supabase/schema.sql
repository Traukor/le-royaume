-- Schéma de l'espace guilde (lot 1 : sorties Raid-Helper, calendrier, appel).
-- À exécuter une fois dans Supabase > SQL Editor. Ré-exécutable sans perte : rien n'est supprimé.
--
-- Sécurité : le navigateur ne lit/écrit qu'à travers ces règles (RLS). Les droits viennent de la table
-- acces, remplie uniquement par l'Edge Function verifier-role après lecture des rôles Discord par le bot.

-- Qui est qui : une ligne par compte connecté, rafraîchie à chaque ouverture de l'espace.
create table if not exists public.acces (
  user_id    uuid primary key references auth.users on delete cascade,
  discord_id text not null,
  pseudo     text,
  membre     boolean not null,
  officier   boolean not null,
  maj        timestamptz not null default now()
);

-- Sorties importées de Raid-Helper (id = identifiant de l'événement Raid-Helper).
create table if not exists public.sorties (
  id          text primary key,
  titre       text,
  description text,
  debut       timestamptz not null,
  fin         timestamptz,
  chef        text,
  maj         timestamptz not null default now()
);

-- Inscriptions Raid-Helper, remplacées à chaque synchronisation de la sortie.
-- classe vaut aussi Absence, Late, Tentative ou Bench selon le bouton choisi dans Discord.
create table if not exists public.inscriptions (
  sortie_id  text references public.sorties on delete cascade,
  discord_id text,
  nom        text,
  classe     text,
  spe        text,
  role       text,
  position   int,
  inscrit_le timestamptz,
  primary key (sortie_id, discord_id)
);

-- Appel d'une soirée. joueur = identifiant Discord, ou le nom tapé pour un joueur non inscrit.
create table if not exists public.appel (
  sortie_id  text references public.sorties on delete cascade,
  joueur     text,
  nom        text not null,
  etat       text not null check (etat in ('present', 'retard', 'absent_prevenu', 'absent', 'banc')),
  retard_min int check (retard_min >= 0),
  modifie_par text,
  modifie_le  timestamptz,
  primary key (sortie_id, joueur)
);

-- Trace de chaque saisie ou correction de l'appel.
create table if not exists public.appel_journal (
  id          bigint generated always as identity primary key,
  sortie_id   text,
  joueur      text,
  etat        text,
  retard_min  int,
  modifie_par text,
  modifie_le  timestamptz
);

-- Droits : un rôle vérifié il y a plus d'un jour ne compte plus (l'ouverture de l'espace le revérifie).
create or replace function public.est_membre() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select membre from public.acces where user_id = auth.uid() and maj > now() - interval '1 day'), false)
$$;
create or replace function public.est_officier() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select officier from public.acces where user_id = auth.uid() and maj > now() - interval '1 day'), false)
$$;

-- L'auteur d'une saisie est fixé par la base (impossible à falsifier), puis la saisie est journalisée.
create or replace function public.tracer_appel() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.modifie_par := (select pseudo from public.acces where user_id = auth.uid());
  new.modifie_le := now();
  insert into public.appel_journal (sortie_id, joueur, etat, retard_min, modifie_par, modifie_le)
  values (new.sortie_id, new.joueur, new.etat, new.retard_min, new.modifie_par, new.modifie_le);
  return new;
end $$;
drop trigger if exists tracer_appel on public.appel;
create trigger tracer_appel before insert or update on public.appel
  for each row execute function public.tracer_appel();

alter table public.acces         enable row level security;
alter table public.sorties       enable row level security;
alter table public.inscriptions  enable row level security;
alter table public.appel         enable row level security;
alter table public.appel_journal enable row level security;

-- acces : aucune règle, seul le serveur (clé service) y touche.
drop policy if exists lire on public.sorties;
create policy lire on public.sorties for select using (public.est_membre());
drop policy if exists lire on public.inscriptions;
create policy lire on public.inscriptions for select using (public.est_membre());
drop policy if exists lire on public.appel;
create policy lire on public.appel for select using (public.est_officier());
drop policy if exists saisir on public.appel;
create policy saisir on public.appel for insert with check (public.est_officier());
drop policy if exists corriger on public.appel;
create policy corriger on public.appel for update using (public.est_officier());
drop policy if exists lire on public.appel_journal;
create policy lire on public.appel_journal for select using (public.est_officier());

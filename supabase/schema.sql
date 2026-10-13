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

-- Retrait d'un joueur de l'appel (non inscrit ajouté par erreur) : journalisé avec l'état « retire ».
create or replace function public.tracer_retrait() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.appel_journal (sortie_id, joueur, etat, retard_min, modifie_par, modifie_le)
  values (old.sortie_id, old.joueur, 'retire', null, (select pseudo from public.acces where user_id = auth.uid()), now());
  return old;
end $$;
drop trigger if exists tracer_retrait on public.appel;
create trigger tracer_retrait after delete on public.appel
  for each row execute function public.tracer_retrait();

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
drop policy if exists retirer on public.appel;
create policy retirer on public.appel for delete using (public.est_officier());
drop policy if exists lire on public.appel_journal;
create policy lire on public.appel_journal for select using (public.est_officier());

-- ===== Lot 2 : préparer la soirée =====

-- Identifiant Discord du compte connecté (pour les règles « mes lignes »).
create or replace function public.mon_discord() returns text
language sql stable security definer set search_path = '' as $$
  select discord_id from public.acces where user_id = auth.uid()
$$;

-- Composition : un officier valide un inscrit ou le met en liste d'attente.
create table if not exists public.composition (
  sortie_id   text references public.sorties on delete cascade,
  joueur      text,
  statut      text not null check (statut in ('valide', 'attente')),
  modifie_par text,
  modifie_le  timestamptz,
  primary key (sortie_id, joueur)
);
create or replace function public.signer() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.modifie_par := (select pseudo from public.acces where user_id = auth.uid());
  new.modifie_le := now();
  return new;
end $$;
drop trigger if exists signer on public.composition;
create trigger signer before insert or update on public.composition
  for each row execute function public.signer();

-- Absences longues : chaque membre déclare les siennes ; joueur et nom fixés par la base.
create table if not exists public.absences (
  id     bigint generated always as identity primary key,
  joueur text not null,
  nom    text,
  du     date not null,
  au     date not null check (au >= du),
  motif  text
);
create or replace function public.proprietaire_absence() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  select discord_id, pseudo into new.joueur, new.nom from public.acces where user_id = auth.uid();
  return new;
end $$;
drop trigger if exists proprietaire_absence on public.absences;
create trigger proprietaire_absence before insert or update on public.absences
  for each row execute function public.proprietaire_absence();

alter table public.composition enable row level security;
alter table public.absences    enable row level security;

drop policy if exists lire on public.composition;
create policy lire on public.composition for select using (public.est_membre());
drop policy if exists ecrire on public.composition;
create policy ecrire on public.composition for all using (public.est_officier()) with check (public.est_officier());

drop policy if exists lire on public.absences;
create policy lire on public.absences for select using (public.est_officier() or joueur = public.mon_discord());
drop policy if exists ecrire on public.absences;
create policy ecrire on public.absences for all
  using (public.est_membre() and joueur = public.mon_discord())
  with check (public.est_membre() and joueur = public.mon_discord());

-- Joueurs absents un jour donné, pour tous les membres (sans le motif, qui reste privé).
create or replace function public.absents(jour date) returns setof text
language sql stable security definer set search_path = '' as $$
  select joueur from public.absences where jour between du and au and public.est_membre()
$$;

-- Cibles de composition par sortie (sans ligne : valeurs par défaut de la page, 2 / 5 / 12).
create table if not exists public.cibles (
  sortie_id text primary key references public.sorties on delete cascade,
  tanks     int check (tanks >= 0),
  soigneurs int check (soigneurs >= 0),
  dps       int check (dps >= 0)
);
alter table public.cibles enable row level security;
drop policy if exists lire on public.cibles;
create policy lire on public.cibles for select using (public.est_membre());
drop policy if exists ecrire on public.cibles;
create policy ecrire on public.cibles for all using (public.est_officier()) with check (public.est_officier());

-- Statistiques d'appel par joueur (lot 1 bis), depuis une date ou depuis le début (null).
-- Exécutée avec les droits de l'appelant : les règles d'accès de appel la réservent aux officiers.
-- Le banc n'est ni une présence ni une absence : exclu des soirées, compté à part (« mis au banc »).
-- Inscrit = inscription Raid-Helper autre que « Absence ». Seules comptent les sorties dont l'appel a été fait.
drop function if exists public.stats_joueurs(timestamptz); -- colonnes de retour modifiées
create function public.stats_joueurs(depuis timestamptz default null)
returns table (joueur text, nom text, soirees int, presents int, retards int, retard_moyen int,
               absents_prevenus int, absents int, bancs int,
               inscrits int, inscrits_valides int, inscrits_presents int, inscrits_bancs int)
language sql stable set search_path = '' as $$
  with a as (select * from public.appel),
       i as (select sortie_id, discord_id as joueur, nom from public.inscriptions where classe is distinct from 'Absence'),
       l as (select coalesce(a.sortie_id, i.sortie_id) as sortie_id, coalesce(a.joueur, i.joueur) as joueur,
                    coalesce(a.nom, i.nom) as nom, a.etat, a.retard_min, i.joueur is not null as inscrit, c.statut
             from a full join i on i.sortie_id = a.sortie_id and i.joueur = a.joueur
             left join public.composition c on c.sortie_id = coalesce(a.sortie_id, i.sortie_id)
                                           and c.joueur = coalesce(a.joueur, i.joueur))
  select l.joueur,
         (array_agg(l.nom order by s.debut desc))[1], -- nom le plus récent
         (count(*) filter (where l.etat <> 'banc'))::int,
         (count(*) filter (where l.etat in ('present', 'retard')))::int,
         (count(*) filter (where l.etat = 'retard'))::int,
         round(avg(l.retard_min) filter (where l.etat = 'retard'))::int,
         (count(*) filter (where l.etat = 'absent_prevenu'))::int,
         (count(*) filter (where l.etat = 'absent'))::int,
         (count(*) filter (where l.etat = 'banc'))::int,
         (count(*) filter (where l.inscrit))::int,
         (count(*) filter (where l.inscrit and l.statut = 'valide'))::int,
         (count(*) filter (where l.inscrit and l.etat in ('present', 'retard')))::int,
         (count(*) filter (where l.inscrit and l.etat = 'banc'))::int
  from l join public.sorties s on s.id = l.sortie_id
  where (depuis is null or s.debut >= depuis)
    and exists (select 1 from public.appel x where x.sortie_id = s.id)
  group by l.joueur
$$;

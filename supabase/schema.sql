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
-- serveur : présent sur le Discord, même sans rôle (invité : peut seulement signer la charte) ;
-- gestion : rôle de gestion du site
alter table public.acces add column if not exists serveur boolean not null default false;
alter table public.acces add column if not exists gestion boolean not null default false;

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
create or replace function public.sur_serveur() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select serveur from public.acces where user_id = auth.uid() and maj > now() - interval '1 day'), false)
$$;
create or replace function public.est_gestion() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select gestion from public.acces where user_id = auth.uid() and maj > now() - interval '1 day'), false)
$$;
create or replace function public.est_officier() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select officier from public.acces where user_id = auth.uid() and maj > now() - interval '1 day'), false)
$$;

-- Identifiant Discord du compte connecté (pour les règles « mes lignes »).
create or replace function public.mon_discord() returns text
language sql stable security definer set search_path = '' as $$
  select discord_id from public.acces where user_id = auth.uid()
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

-- Date de la dernière synchronisation Raid-Helper réussie (délai de 5 minutes entre deux synchronisations).
create table if not exists public.synchro (
  id int primary key check (id = 1),
  le timestamptz not null
);
alter table public.synchro enable row level security;

-- acces et synchro : aucune règle, seul le serveur (clé service) y touche.
-- (select …) autour des fonctions de droits : évaluées une fois par requête et non pour chaque ligne.
drop policy if exists lire on public.sorties;
create policy lire on public.sorties for select using ((select public.est_membre()));
drop policy if exists lire on public.inscriptions;
create policy lire on public.inscriptions for select using ((select public.est_membre()));
drop policy if exists lire on public.appel;
-- lot 4 : chaque membre lit aussi ses propres lignes d'appel (« Mon suivi »)
create policy lire on public.appel for select
  using ((select public.est_officier()) or ((select public.est_membre()) and joueur = (select public.mon_discord())));
drop policy if exists saisir on public.appel;
create policy saisir on public.appel for insert with check ((select public.est_officier()));
drop policy if exists corriger on public.appel;
create policy corriger on public.appel for update using ((select public.est_officier()));
drop policy if exists retirer on public.appel;
create policy retirer on public.appel for delete using ((select public.est_officier()));
drop policy if exists lire on public.appel_journal;
create policy lire on public.appel_journal for select using ((select public.est_officier()));

-- ===== Lot 2 : préparer la soirée =====

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
create policy lire on public.composition for select using ((select public.est_membre()));
drop policy if exists ecrire on public.composition;
create policy ecrire on public.composition for all using ((select public.est_officier())) with check ((select public.est_officier()));

drop policy if exists lire on public.absences;
create policy lire on public.absences for select using ((select public.est_officier()) or joueur = (select public.mon_discord()));
drop policy if exists ecrire on public.absences;
create policy ecrire on public.absences for all
  using ((select public.est_membre()) and joueur = (select public.mon_discord()))
  with check ((select public.est_membre()) and joueur = (select public.mon_discord()));

-- Joueurs absents un jour donné, pour tous les membres (sans le motif, qui reste privé).
create or replace function public.absents(jour date) returns setof text
language sql stable security definer set search_path = '' as $$
  select joueur from public.absences where jour between du and au and public.est_membre()
$$;

-- Cibles de composition par sortie (sans ligne : valeurs par défaut de la page, 2 / 5 / 13).
create table if not exists public.cibles (
  sortie_id text primary key references public.sorties on delete cascade,
  tanks     int check (tanks >= 0),
  soigneurs int check (soigneurs >= 0),
  dps       int check (dps >= 0)
);
alter table public.cibles enable row level security;
drop policy if exists lire on public.cibles;
create policy lire on public.cibles for select using ((select public.est_membre()));
drop policy if exists ecrire on public.cibles;
create policy ecrire on public.cibles for all using ((select public.est_officier())) with check ((select public.est_officier()));

-- ===== Lot 3 : personnages et loots =====

-- Personnages : chaque membre gère les siens ; joueur et propriétaire fixés par la base.
create table if not exists public.personnages (
  id           bigint generated always as identity primary key,
  joueur       text not null,
  proprietaire text,
  nom          text not null,
  classe       text,
  spe          text,
  principal    boolean not null default false,
  unique (joueur, nom)
);
create unique index if not exists un_principal on public.personnages (joueur) where principal;
create or replace function public.proprietaire_personnage() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- sans utilisateur : création automatique par la synchronisation Raid-Helper (clé service), valeurs gardées
  if auth.uid() is null then return new; end if;
  select discord_id, pseudo into new.joueur, new.proprietaire from public.acces where user_id = auth.uid();
  return new;
end $$;
drop trigger if exists proprietaire_personnage on public.personnages;
create trigger proprietaire_personnage before insert or update on public.personnages
  for each row execute function public.proprietaire_personnage();

-- Loots : saisis par les officiers. Destination joueur (avec type +1/+2/+3), désenchanté ou banque.
create table if not exists public.loots (
  id            bigint generated always as identity primary key,
  sortie_id     text references public.sorties on delete set null,
  le            timestamptz not null default now(),
  objet         text not null,
  boss          text,
  destination   text not null default 'joueur' check (destination in ('joueur', 'desenchante', 'banque')),
  personnage_id bigint references public.personnages on delete set null,
  joueur        text,
  nom           text,
  personnage    text,
  type          text check (type in ('+1', '+2', '+3')),
  modifie_par   text,
  modifie_le    timestamptz,
  check (destination <> 'joueur' or joueur is not null)
);
-- auteur et date fixés par la base ; joueur et noms recopiés du personnage (gardés s'il est supprimé)
create or replace function public.preparer_loot() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- mise à null de personnage_id par la base (personnage ou sortie supprimés) : rien d'autre ne change
  -- (de même pour un rattachement : l'auteur et la date du loot restent ceux d'origine)
  if pg_trigger_depth() > 1 or current_setting('royaume.rattachement', true) = 'oui' then return new; end if;
  new.modifie_par := (select pseudo from public.acces where user_id = auth.uid());
  new.modifie_le := now();
  if new.destination <> 'joueur' then
    new.personnage_id := null; new.joueur := null; new.nom := null; new.personnage := null; new.type := null;
  elsif new.personnage_id is not null then
    select joueur, proprietaire, nom into new.joueur, new.nom, new.personnage from public.personnages where id = new.personnage_id;
  end if;
  return new;
end $$;
drop trigger if exists preparer_loot on public.loots;
create trigger preparer_loot before insert or update on public.loots
  for each row execute function public.preparer_loot();

alter table public.personnages enable row level security;
alter table public.loots       enable row level security;

drop policy if exists lire on public.personnages;
create policy lire on public.personnages for select using ((select public.est_membre()));
drop policy if exists ecrire on public.personnages;
create policy ecrire on public.personnages for all
  using ((select public.est_membre()) and joueur = (select public.mon_discord()))
  with check ((select public.est_membre()) and joueur = (select public.mon_discord()));

drop policy if exists lire on public.loots;
-- un membre lit ses loots et le butin des soirées où il était en raid (Présent ou Retard ; le banc ne compte pas)
create policy lire on public.loots for select using ((select public.est_officier()) or ((select public.est_membre()) and (
  joueur = (select public.mon_discord()) or exists (select 1 from public.appel a where a.sortie_id = loots.sortie_id
    and a.joueur = (select public.mon_discord()) and a.etat in ('present', 'retard')))));
drop policy if exists ecrire on public.loots;
create policy ecrire on public.loots for all using ((select public.est_officier())) with check ((select public.est_officier()));

-- Statistiques d'appel par joueur (lot 1 bis), depuis une date ou depuis le début (null).
-- Exécutée avec les droits de l'appelant : un officier voit tout ; un membre ne lit que ses lignes d'appel,
-- donc seuls ses chiffres sont justes (la page filtre sur son identifiant).
-- Le banc n'est ni une présence ni une absence : exclu des soirées, compté à part (« mis au banc »).
-- Inscrit = inscription Raid-Helper autre que « Absence ». Seules comptent les sorties dont l'appel a été fait.
drop function if exists public.stats_joueurs(timestamptz); -- colonnes de retour modifiées
create function public.stats_joueurs(depuis timestamptz default null)
returns table (joueur text, nom text, soirees int, presents int, retards int, retard_moyen int,
               absents_prevenus int, absents int, bancs int,
               inscrits int, inscrits_valides int, inscrits_presents int, inscrits_bancs int,
               loots int, dernier_loot text, dernier_loot_le timestamptz)
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
         (count(*) filter (where l.inscrit and l.etat = 'banc'))::int,
         -- loots reçus sur la période ; dernier loot depuis toujours
         (select count(*)::int from public.loots o where o.joueur = l.joueur and (depuis is null or o.le >= depuis)),
         (select o.objet from public.loots o where o.joueur = l.joueur order by o.le desc limit 1),
         (select max(o.le) from public.loots o where o.joueur = l.joueur)
  from l join public.sorties s on s.id = l.sortie_id
  where (depuis is null or s.debut >= depuis)
    and exists (select 1 from public.appel x where x.sortie_id = s.id)
  group by l.joueur
$$;

-- ===== Lot 4 : signature de la charte =====

-- Une signature par joueur ; joueur, nom et date fixés par la base.
create table if not exists public.signatures (
  joueur  text primary key,
  nom     text,
  le      timestamptz not null default now()
);
-- ancienne colonne version (signature par version de la charte) : la charte n'a qu'une version
alter table public.signatures drop column if exists version;
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.signatures'::regclass and contype = 'p') then
    alter table public.signatures add primary key (joueur);
  end if;
end $$;
create or replace function public.signer_charte() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  select discord_id, pseudo into new.joueur, new.nom from public.acces where user_id = auth.uid();
  new.le := now();
  new.annoncee := false;
  return new;
end $$;
drop trigger if exists signer_charte on public.signatures;
create trigger signer_charte before insert on public.signatures
  for each row execute function public.signer_charte();

-- annoncee : annonce faite dans le salon des officiers (Edge Function annoncer-signature) ;
-- les signatures antérieures à l'annonce sont considérées comme annoncées
alter table public.signatures add column if not exists annoncee boolean not null default true;
alter table public.signatures alter column annoncee set default false;
alter table public.signatures enable row level security;
-- tout compte présent sur le Discord (membre ou invité sans rôle) signe ; une signature ne se modifie pas,
-- seule la gestion du site la retire (signature indésirable : le Discord a une invitation publique)
drop policy if exists lire on public.signatures;
create policy lire on public.signatures for select
  using ((select public.est_officier()) or (select public.est_gestion()) or ((select public.sur_serveur()) and joueur = (select public.mon_discord())));
drop policy if exists signer on public.signatures;
create policy signer on public.signatures for insert with check ((select public.sur_serveur()));
drop policy if exists retirer on public.signatures;
create policy retirer on public.signatures for delete using ((select public.est_gestion()));

-- Signataires, affichés publiquement sous la charte (charte.html, sans connexion).
create or replace function public.signataires() returns setof text
language sql stable security definer set search_path = '' as $$
  select nom from public.signatures order by lower(nom)
$$;
grant execute on function public.signataires() to anon;

-- Comptes connus de l'espace (onglet Gestion du site).
create or replace function public.comptes()
returns table (pseudo text, serveur boolean, membre boolean, officier boolean, gestion boolean, maj timestamptz)
language sql stable security definer set search_path = '' as $$
  select pseudo, serveur, membre, officier, gestion, maj from public.acces where public.est_gestion() order by maj desc
$$;

-- Membres pas encore signataires (gestion du site). Limité aux comptes déjà connectés à l'espace :
-- la liste complète viendra du roster (lot 5).
drop function if exists public.non_signataires(text);
create or replace function public.non_signataires() returns setof text
language sql stable security definer set search_path = '' as $$
  select a.pseudo from public.acces a
  where public.est_gestion() and a.membre
    and not exists (select 1 from public.signatures s where s.joueur = a.discord_id)
  order by a.pseudo
$$;

-- ===== Rattachement d'un joueur ajouté à la main (« nom:… ») à son compte Discord (officiers) =====
-- Son appel et ses loots passent sous l'identifiant Discord ; une soirée où les deux figurent garde la ligne Discord.
-- Les changements d'appel sont journalisés (auteur = l'officier) ; les loots gardent leur auteur et leur date.
create or replace function public.rattacher(ancien text, nouveau text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  n text := (select nom from public.inscriptions where discord_id = nouveau order by inscrit_le desc nulls last limit 1);
begin
  if not public.est_officier() then raise exception 'réservé aux officiers'; end if;
  if ancien not like 'nom:%' or n is null then raise exception 'rattachement impossible'; end if;
  delete from public.appel a where a.joueur = ancien
    and exists (select 1 from public.appel b where b.sortie_id = a.sortie_id and b.joueur = nouveau);
  update public.appel set joueur = nouveau, nom = n where joueur = ancien;
  perform set_config('royaume.rattachement', 'oui', true);
  update public.loots set joueur = nouveau, nom = n where joueur = ancien;
  perform set_config('royaume.rattachement', '', true);
end $$;

-- ===== Personnages créés automatiquement (pseudo + classe + spé + rôle de l'inscription Raid-Helper) =====
-- La synchronisation crée ceux des nouvelles inscriptions ; ici, rattrapage des inscriptions déjà importées
-- (même nom que dans synchro-raidhelper : rôle omis s'il redit la classe).
insert into public.personnages (joueur, proprietaire, nom, classe, spe)
select discord_id, nom,
       concat_ws(' ', nom, classe, spe, case when regexp_replace(role, 's$', '') = classe then null else role end), classe, spe
from public.inscriptions
where discord_id is not null and nom is not null and classe is not null
  and classe not in ('Absence', 'Late', 'Tentative', 'Bench')
on conflict (joueur, nom) do nothing;

-- ===== Réglages du site (onglet Gestion du site) =====
-- annonce_signature : modèle du message du bot à chaque signature de la charte (sobre, proclamation, recrue, minimal)
create table if not exists public.reglages (
  cle    text primary key,
  valeur text not null
);
alter table public.reglages enable row level security;
drop policy if exists gerer on public.reglages;
create policy gerer on public.reglages for all using ((select public.est_gestion())) with check ((select public.est_gestion()));

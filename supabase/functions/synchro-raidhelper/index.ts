// Edge Function Supabase « synchro-raidhelper »
// Copie les sorties Raid-Helper du serveur Discord (et leurs inscriptions) dans les tables sorties et inscriptions.
// Appelée par l'espace guilde à chaque ouverture ; au plus une synchronisation toutes les 5 minutes.
// Les sorties supprimées de Raid-Helper restent sur le site (historique des appels).
//
// Secrets à définir dans Supabase (Edge Functions > Secrets) :
//   RAIDHELPER_API_KEY  la clé du serveur, obtenue avec la commande /apikey de Raid-Helper dans Discord
//   DISCORD_GUILD_ID    déjà défini pour verifier-role
import { createClient } from "jsr:@supabase/supabase-js@2";

const ORIGINES = ["https://le-royaume.fr"];
const RH = "https://raid-helper.dev/api/v4"; // v2 et v3 ont été retirées
const BOUTONS = ["Absence", "Late", "Tentative", "Bench"]; // boutons Raid-Helper, pas des classes
const FENETRE_JOURS = 14; // sorties passées encore resynchronisées (inscriptions modifiées après coup)

Deno.serve(async (req) => {
  const origin = req.headers.get("Origin") ?? "";
  const cors = {
    "Access-Control-Allow-Origin": ORIGINES.includes(origin) ? origin : ORIGINES[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Vary": "Origin",
  };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

  // Réservé aux membres de la guilde (droits vérifiés par verifier-role).
  const utilisateur = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: membre } = await utilisateur.rpc("est_membre");
  if (!membre) return json({ erreur: "réservé aux membres" }, 403);

  // { forcer: true } (bouton « Actualiser », officiers seulement) ignore le délai de 5 minutes
  const { forcer } = (await req.json().catch(() => null)) ?? {};
  const { data: officier } = forcer ? await utilisateur.rpc("est_officier") : { data: false };

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  // date de la dernière synchronisation réussie (table synchro, une seule ligne)
  const { data: derniere } = await admin.from("synchro").select("le").maybeSingle();
  if (!officier && derniere && Date.now() - Date.parse(derniere.le) < 5 * 60_000) return json({ synchro: false });

  const cle = Deno.env.get("RAIDHELPER_API_KEY")!;
  const depuis = Math.floor(Date.now() / 1000) - FENETRE_JOURS * 86400;
  const evenements = [];
  for (let page = 1, pages = 1; page <= pages; page++) {
    const r = await fetch(`${RH}/servers/${Deno.env.get("DISCORD_GUILD_ID")}/events`, {
      headers: { Authorization: cle, StartTimeFilter: String(depuis), Page: String(page), IncludeSignUps: "true" },
    });
    if (!r.ok) return json({ erreur: `Raid-Helper a répondu ${r.status}` }, 502);
    const d = await r.json();
    pages = d.pages ?? 1;
    evenements.push(...(d.postedEvents ?? []));
  }

  const maj = new Date().toISOString();
  const personnages = new Map(); // créés automatiquement : pseudo + classe + spé + rôle de l'inscription
  for (const ev of evenements) {
    // inscrits fournis par la liste (IncludeSignUps) ; sinon, lecture de l'événement seul
    let signUps = ev.signUps;
    if (!signUps) {
      const r = await fetch(`${RH}/events/${ev.id}`, { headers: { Authorization: cle } });
      if (!r.ok) return json({ erreur: `Raid-Helper a répondu ${r.status} pour ${ev.id}` }, 502);
      signUps = (await r.json()).signUps;
    }

    const { error: e1 } = await admin.from("sorties").upsert({
      id: ev.id, titre: ev.title, description: ev.description, chef: ev.leaderName, maj,
      debut: new Date(ev.startTime * 1000).toISOString(),
      fin: ev.endTime ? new Date(ev.endTime * 1000).toISOString() : null,
    });
    if (e1) return json({ erreur: e1.message }, 500);

    // une ligne par joueur (la dernière inscription l'emporte)
    const parJoueur = new Map();
    for (const s of signUps ?? []) {
      if (!s.userId) continue; // inscription ajoutée à la main sans compte Discord : pas de joueur à rattacher
      if (s.name && s.className && !BOUTONS.includes(s.className)) {
        // rôle omis s'il redit la classe (classe « Tank », rôle « Tanks »)
        const role = s.roleName && s.roleName.replace(/s$/, "") !== s.className ? s.roleName : null;
        const nom = [s.name, s.className, s.specName, role].filter(Boolean).join(" ");
        personnages.set(s.userId + "|" + nom, { joueur: s.userId, proprietaire: s.name, nom, classe: s.className, spe: s.specName });
      }
      parJoueur.set(s.userId, {
        sortie_id: ev.id, discord_id: s.userId, nom: s.name, classe: s.className, spe: s.specName,
        role: s.roleName, position: s.position, inscrit_le: s.entryTime ? new Date(s.entryTime * 1000).toISOString() : null,
      });
    }
    // upsert puis suppression des désinscrits : deux synchronisations simultanées ne se gênent pas
    const { error: e2 } = await admin.from("inscriptions").upsert([...parJoueur.values()]);
    if (e2) return json({ erreur: e2.message }, 500);
    const { error: e3 } = await admin.from("inscriptions").delete().eq("sortie_id", ev.id)
      .not("discord_id", "in", `(${[...parJoueur.keys(), "0"].join(",")})`);
    if (e3) return json({ erreur: e3.message }, 500);
  }
  // un personnage existant n'est pas modifié (renommage d'un pseudo Discord : nouveau personnage)
  const { error: e5 } = await admin.from("personnages").upsert([...personnages.values()], { onConflict: "joueur,nom", ignoreDuplicates: true });
  if (e5) return json({ erreur: e5.message }, 500);
  const { error: e4 } = await admin.from("synchro").upsert({ id: 1, le: maj });
  if (e4) return json({ erreur: e4.message }, 500);
  return json({ synchro: true, sorties: evenements.length });
});

// Edge Function Supabase « synchro-roster »
// Copie dans la table roster les membres du serveur Discord qui ont un rôle de la guilde, avec leur grade.
// Appelée par l'espace guilde à chaque ouverture, comme synchro-raidhelper ; au plus une fois toutes les 5 minutes.
// Un joueur qui n'a plus de rôle de la guilde (ou a quitté le serveur) sort du roster.
//
// Prérequis : intent privilégié « Server Members » activé pour le bot (portail développeur Discord > Bot).
// Secrets (déjà définis) : DISCORD_BOT_TOKEN, DISCORD_GUILD_ID, DISCORD_GM_ROLE_IDS, DISCORD_GESTION_ROLE_IDS,
// DISCORD_ROLE_IDS (officiers), DISCORD_POSTULANT_ROLE_IDS, DISCORD_MEMBRE_ROLE_IDS.
import { createClient } from "jsr:@supabase/supabase-js@2";

const ORIGINES = ["https://le-royaume.fr"];

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
  // ligne 2 de la table synchro : dernière synchronisation du roster réussie
  const { data: derniere } = await admin.from("synchro").select("le").eq("id", 2).maybeSingle();
  if (!officier && derniere && Date.now() - Date.parse(derniere.le) < 5 * 60_000) return json({ synchro: false });

  // grade : le plus élevé des rôles du joueur (le rôle de gestion du site compte comme officier)
  const roles = (secret: string) => (Deno.env.get(secret) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const GRADES: [string, string[]][] = [
    ["gm", roles("DISCORD_GM_ROLE_IDS")],
    ["officier", [...roles("DISCORD_ROLE_IDS"), ...roles("DISCORD_GESTION_ROLE_IDS")]],
    ["postulant", roles("DISCORD_POSTULANT_ROLE_IDS")], // avant membre : la liste des rôles membres peut l'inclure
    ["membre", roles("DISCORD_MEMBRE_ROLE_IDS")],
  ];

  const maj = new Date().toISOString();
  const lignes = [];
  // 1000 membres au plus par page, dans l'ordre des identifiants
  for (let apres = "0"; ;) {
    const r = await fetch(`https://discord.com/api/v10/guilds/${Deno.env.get("DISCORD_GUILD_ID")}/members?limit=1000&after=${apres}`, {
      headers: { Authorization: `Bot ${Deno.env.get("DISCORD_BOT_TOKEN")}` },
    });
    // 403 : intent « Server Members » pas activé
    if (!r.ok) return json({ erreur: `Discord a répondu ${r.status}` }, 502);
    const page = await r.json();
    for (const m of page) {
      const grade = !m.user.bot && GRADES.find(([, ids]) => m.roles.some((id: string) => ids.includes(id)))?.[0];
      if (grade) {
        lignes.push({
          joueur: m.user.id, pseudo: m.nick ?? m.user.global_name ?? m.user.username, grade,
          arrivee: m.joined_at, maj,
        });
      }
    }
    if (page.length < 1000) break;
    apres = page.at(-1).user.id;
  }

  // aucun joueur : secrets de rôles vides ou réponse anormale, le roster n'est pas vidé
  if (!lignes.length) return json({ erreur: "aucun membre avec un rôle de la guilde" }, 502);
  const { error: e1 } = await admin.from("roster").upsert(lignes);
  if (e1) return json({ erreur: e1.message }, 500);
  // pas revu lors de cette synchronisation : plus de rôle de la guilde, ou parti du serveur
  const { error: e2 } = await admin.from("roster").delete().lt("maj", maj);
  if (e2) return json({ erreur: e2.message }, 500);
  const { error: e3 } = await admin.from("synchro").upsert({ id: 2, le: maj });
  if (e3) return json({ erreur: e3.message }, 500);
  return json({ synchro: true, joueurs: lignes.length });
});

// Edge Function Supabase « verifier-role »
// Dit si l'utilisateur connecté (via Discord) possède un des rôles autorisés sur le serveur Discord de la guilde.
// La vérification se fait ici, côté serveur, avec le bot de la guilde : impossible à falsifier depuis le navigateur.
//
// Secrets à définir dans Supabase (Edge Functions > Secrets) :
//   DISCORD_BOT_TOKEN  le jeton du bot de l'application Discord
//   DISCORD_GUILD_ID   l'identifiant du serveur Discord de la guilde
//   DISCORD_ROLE_IDS   les identifiants des rôles officiers (accès officier), séparés par des virgules
//   DISCORD_MEMBRE_ROLE_IDS  les identifiants des rôles membres (accès membre : membres, postulants…), séparés par des virgules
// Le résultat est aussi inscrit dans la table acces, sur laquelle reposent les droits de la base (supabase/schema.sql).
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

  // Qui appelle ? Supabase a déjà validé le jeton de session ; on récupère l'utilisateur qui va avec.
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return json({ erreur: "non connecté" }, 401);

  const identite = user.identities?.find((i) => i.provider === "discord");
  const discordId = identite?.identity_data?.provider_id ?? identite?.identity_data?.sub;
  if (!discordId) return json({ erreur: "compte non lié à Discord" }, 400);

  // Le bot lit le profil du membre sur le serveur de la guilde (rôles, surnom).
  const r = await fetch(
    `https://discord.com/api/v10/guilds/${Deno.env.get("DISCORD_GUILD_ID")}/members/${discordId}`,
    { headers: { Authorization: `Bot ${Deno.env.get("DISCORD_BOT_TOKEN")}` } },
  );
  if (!r.ok && r.status !== 404) return json({ erreur: `Discord a répondu ${r.status}` }, 502);

  const membre = r.ok ? await r.json() : null;
  const roles = (secret: string) => (Deno.env.get(secret) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const aUnRole = (ids: string[]) => !!membre?.roles.some((id: string) => ids.includes(id));
  const autorise = aUnRole(roles("DISCORD_ROLE_IDS"));
  const resultat = {
    autorise,
    // être sur le serveur ne suffit pas (invitation publique) : il faut un rôle de la guilde
    membre: autorise || aUnRole(roles("DISCORD_MEMBRE_ROLE_IDS")),
    pseudo: membre ? membre.nick ?? membre.user.global_name ?? membre.user.username : null,
  };

  // clé service : la table acces n'est modifiable que d'ici
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { error: e } = await admin.from("acces").upsert({
    user_id: user.id, discord_id: discordId, pseudo: resultat.pseudo,
    membre: resultat.membre, officier: resultat.autorise, maj: new Date().toISOString(),
  });
  if (e) return json({ erreur: `enregistrement des droits : ${e.message}` }, 500);
  return json(resultat);
});

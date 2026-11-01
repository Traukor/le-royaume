// Edge Function Supabase « communication » : message envoyé en MP par le bot aux membres, officiers et chef de guilde
// du roster (gestion du site).
// { titre, texte, apercu: true } : renvoie le message tel qu'il sera envoyé et le nombre de destinataires (rien n'est envoyé).
// { titre, texte, essai: true }  : l'envoie au seul compte connecté.
// { titre, texte }               : l'envoie à tous ; renvoie le nombre d'envois et les pseudos en échec (MP fermés).
//
// Secrets : DISCORD_BOT_TOKEN (déjà défini).
import { createClient } from "jsr:@supabase/supabase-js@2";

const ORIGINES = ["https://le-royaume.fr"];
const SITE = "https://le-royaume.fr";
const LOGO = `${SITE}/img/logo-360.png`;
const OR = 0xd4af37;

// texte en Markdown Discord, écrit par la gestion du site ; la mise en forme autour est fixe
const message = (joueur: string, titre: string, texte: string) => ({
  content: `Bonjour <@${joueur}> !`,
  embeds: [{
    color: OR, author: { name: "Le Royaume · Guilde WoW Forever", icon_url: LOGO }, title: titre, url: SITE,
    description: texte, image: { url: `${SITE}/img/wow-forever.jpg` },
    footer: { text: "Le Royaume · Message de la guilde", icon_url: LOGO },
  }],
  components: [{
    type: 1, components: [
      { type: 2, style: 5, label: "Le site", emoji: { name: "🏰" }, url: SITE },
      { type: 2, style: 5, label: "Espace membre", emoji: { name: "🗡️" }, url: `${SITE}/espace.html` },
      { type: 2, style: 5, label: "La charte", emoji: { name: "📜" }, url: `${SITE}/charte.html` },
    ],
  }],
  allowed_mentions: { parse: [] },
});

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

  const utilisateur = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: gestion } = await utilisateur.rpc("est_gestion");
  if (!gestion) return json({ erreur: "réservé à la gestion du site" }, 403);
  const { data: { user } } = await utilisateur.auth.getUser();
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: compte } = await admin.from("acces").select("discord_id").eq("user_id", user!.id).single();

  const { titre, texte, apercu, essai } = (await req.json().catch(() => null)) ?? {};
  if (typeof titre !== "string" || !titre.trim() || titre.length > 256) return json({ erreur: "titre requis (256 caractères au plus)" }, 400);
  if (typeof texte !== "string" || !texte.trim() || texte.length > 4000) return json({ erreur: "texte requis (4000 caractères au plus)" }, 400);
  const { data: roster, error } = await admin.from("roster").select("joueur, pseudo").in("grade", ["gm", "officier", "membre"]);
  if (error) return json({ erreur: error.message }, 500);
  if (apercu) return json({ message: message(compte!.discord_id, titre, texte), destinataires: roster.length });

  const bot = { Authorization: `Bot ${Deno.env.get("DISCORD_BOT_TOKEN")}`, "Content-Type": "application/json" };
  // appel à Discord ; limite de débit (429) : une nouvelle tentative après le délai indiqué
  const discord = async (chemin: string, body: unknown): Promise<Response> => {
    const appel = () => fetch(`https://discord.com/api/v10${chemin}`, { method: "POST", headers: bot, body: JSON.stringify(body) })
      .catch(() => new Response(null, { status: 503 }));
    const r = await appel();
    if (r.status !== 429) return r;
    const { retry_after = 1 } = await r.json().catch(() => ({}));
    await new Promise((f) => setTimeout(f, retry_after * 1000));
    return appel();
  };

  let envoyes = 0;
  const echecs = [];
  for (const { joueur, pseudo } of essai ? [{ joueur: compte!.discord_id, pseudo: "vous" }] : roster) {
    // MP fermés aux membres du serveur : 403 (code 50007)
    const salon = await discord("/users/@me/channels", { recipient_id: joueur }).then((r) => r.ok ? r.json() : null);
    const ok = salon && (await discord(`/channels/${salon.id}/messages`, message(joueur, titre, texte))).ok;
    if (ok) envoyes++;
    else echecs.push(pseudo);
  }
  return json({ envoyes, echecs });
});

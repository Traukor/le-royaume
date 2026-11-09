// Edge Function Supabase « demander-passage » : un postulant demande son passage membre (fonction SQL demander_passage,
// qui vérifie la charte signée et le grade), puis le bot prévient les officiers dans le salon de suivi des candidatures.
// Une seule annonce par demande : une demande déjà faite ne repart pas.
//
// Secrets : DISCORD_BOT_TOKEN (déjà défini).
import { createClient } from "jsr:@supabase/supabase-js@2";

const ORIGINES = ["https://le-royaume.fr"];
const SALON = "996869802096336967"; // suivi des candidatures
const SITE = "https://le-royaume.fr";
const LOGO = `${SITE}/img/logo-360.png`;
const OR = 0xd4af37;
const echapper = (t: string) => t.replace(/[\\*_~`|>\[\]()<#:-]/g, "\\$&");

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
  const { data: { user } } = await utilisateur.auth.getUser();
  if (!user) return json({ erreur: "non connecté" }, 401);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: compte } = await admin.from("acces").select("discord_id").eq("user_id", user.id).single();
  if (!compte) return json({ erreur: "compte inconnu" }, 403);
  const { data: avant } = await admin.from("roster").select("pseudo, arrivee, demande_passage").eq("joueur", compte.discord_id).maybeSingle();

  // la base vérifie la charte et le grade
  const { data: le, error } = await utilisateur.rpc("demander_passage");
  if (error) return json({ erreur: error.message }, 400);
  if (avant?.demande_passage) return json({ le, annonce: false }); // déjà demandée : déjà annoncée

  const bot = { Authorization: `Bot ${Deno.env.get("DISCORD_BOT_TOKEN")}`, "Content-Type": "application/json" };
  const [profil, { data: signature }] = await Promise.all([
    fetch(`https://discord.com/api/v10/users/${compte.discord_id}`, { headers: bot }).then((r) => r.ok ? r.json() : null).catch(() => null),
    admin.from("signatures").select("le").eq("joueur", compte.discord_id).maybeSingle(),
  ]);
  const ts = (d: string) => `<t:${Math.floor(Date.parse(d) / 1000)}:D>`;
  const nom = echapper(avant?.pseudo ?? "?");
  const r = await fetch(`https://discord.com/api/v10/channels/${SALON}/messages`, {
    method: "POST", headers: bot,
    body: JSON.stringify({
      embeds: [{
        color: OR, title: "📨 Demande de passage membre", url: `${SITE}/espace.html`,
        description: `**${nom}** (<@${compte.discord_id}>) demande son passage membre.\nOfficiers : espace membre, vue Officier, bouton **Recrues** pour ouvrir le vote.`,
        thumbnail: { url: profil?.avatar ? `https://cdn.discordapp.com/avatars/${compte.discord_id}/${profil.avatar}.png` : LOGO },
        fields: [
          { name: "Sur le Discord depuis", value: avant?.arrivee ? ts(avant.arrivee) : "–", inline: true },
          { name: "Charte", value: signature ? `Signée le ${ts(signature.le)}` : "–", inline: true },
          { name: "Demande faite le", value: `<t:${Math.floor(Date.parse(le) / 1000)}:f>`, inline: true },
        ],
        footer: { text: "Le Royaume · Suivi des candidatures", icon_url: LOGO },
      }],
      allowed_mentions: { parse: [] },
    }),
  }).catch(() => null);
  return json({ le, annonce: !!r?.ok });
});

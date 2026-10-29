// Edge Function Supabase « annoncer-signature »
// Annonce dans le salon des officiers (bot Discord, @here) la signature de la charte par le compte connecté.
// Appelée par l'espace juste après la signature ; seule une signature pas encore annoncée part (pas de doublon).
// Gestion du site : { apercu: true } renvoie les messages des 4 modèles (sans rien envoyer),
//                   { essai: "modele" } envoie le modèle choisi sans @here.
// Le modèle utilisé se règle dans l'onglet Gestion du site (table reglages, clé annonce_signature).
//
// Secrets : DISCORD_BOT_TOKEN (déjà défini). Le bot doit pouvoir, dans le salon : voir le salon, envoyer des
// messages, intégrer des liens, mentionner @everyone/@here.
import { createClient } from "jsr:@supabase/supabase-js@2";

const ORIGINES = ["https://le-royaume.fr"];
const SALON = "1565173682467250247"; // salon des officiers
const SITE = "https://le-royaume.fr";
const LOGO = `${SITE}/img/logo-360.png`;
const OR = 0xd4af37, VERT = 0x57f287;

type Signature = { id: string; pseudo: string; avatar: string; ts: number; version: string; invite: boolean };

// les 4 modèles : contenu (avec @here, hors embed : un @here dans un embed ne notifie personne) et embed
const MODELES: Record<string, (s: Signature) => { content: string; embeds: unknown[] }> = {
  sobre: (s) => ({
    content: "@here Nouvelle signature de la charte !",
    embeds: [{
      color: OR, author: { name: s.pseudo, icon_url: s.avatar }, title: "📜 Charte signée", url: `${SITE}/charte.html`,
      description: `**${s.pseudo}** vient de lire et d'approuver la charte du Royaume.`,
      fields: [{ name: "Joueur", value: `<@${s.id}>`, inline: true }, { name: "Signée le", value: `<t:${s.ts}:F>`, inline: true }],
      footer: { text: "Le Royaume · Espace membre", icon_url: LOGO },
    }],
  }),
  proclamation: (s) => ({
    content: "@here Oyez, oyez !",
    embeds: [{
      color: OR, title: "👑 Proclamation royale", thumbnail: { url: LOGO },
      description: `Par la présente, **${s.pseudo}** (<@${s.id}>) a apposé son sceau sur la Charte du Royaume.\n\n` +
        (s.invite ? "Officiers, un nouvel aspirant attend votre accueil !" : "Que son engagement soit salué !"),
      fields: [{ name: "🖋️ Sceau apposé le", value: `<t:${s.ts}:F>` }],
      footer: { text: `Le Royaume · Charte (version du ${s.version})` },
    }],
  }),
  recrue: (s) => ({
    content: s.invite ? "@here Charte signée : action requise" : "@here Charte signée",
    embeds: [{
      color: s.invite ? VERT : OR, title: "✅ Nouvelle signature", thumbnail: { url: s.avatar },
      fields: [
        { name: "Joueur", value: `**${s.pseudo}** (<@${s.id}>)` },
        { name: "Signée le", value: `<t:${s.ts}:f> (<t:${s.ts}:R>)` },
        { name: "Statut", value: s.invite ? "Invité (aucun rôle de la guilde)" : "Déjà membre de la guilde" },
        ...(s.invite ? [{ name: "➡️ À faire", value: "Donner le rôle Postulant et inviter en guilde." }] : []),
      ],
      footer: { text: "Le Royaume · Espace membre", icon_url: LOGO },
    }],
  }),
  minimal: (s) => ({
    content: "@here",
    embeds: [{ color: OR, description: `📜 **${s.pseudo}** (<@${s.id}>) a signé la charte le <t:${s.ts}:F>.` }],
  }),
};

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
  const { apercu, essai } = await req.json().catch(() => ({}));
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: compte } = await admin.from("acces").select("discord_id, pseudo, membre").eq("user_id", user.id).single();
  if (!compte) return json({ erreur: "compte inconnu" }, 403);

  const bot = { Authorization: `Bot ${Deno.env.get("DISCORD_BOT_TOKEN")}` };
  const profil = await fetch(`https://discord.com/api/v10/users/${compte.discord_id}`, { headers: bot }).then((r) => r.ok ? r.json() : null);
  const avatar = profil?.avatar
    ? `https://cdn.discordapp.com/avatars/${compte.discord_id}/${profil.avatar}.png`
    : "https://cdn.discordapp.com/embed/avatars/0.png";
  const signature = (le: string, version: string): Signature => ({
    id: compte.discord_id, pseudo: compte.pseudo ?? "?", avatar, ts: Math.floor(Date.parse(le) / 1000), version, invite: !compte.membre,
  });
  const envoyer = (message: unknown) => fetch(`https://discord.com/api/v10/channels/${SALON}/messages`, {
    method: "POST", headers: { ...bot, "Content-Type": "application/json" }, body: JSON.stringify(message),
  });

  if (apercu || essai) {
    const { data: gestion } = await utilisateur.rpc("est_gestion");
    if (!gestion) return json({ erreur: "réservé à la gestion du site" }, 403);
    const exemple = { ...signature(new Date().toISOString(), "exemple"), invite: true }; // le cas qui demande une action
    if (apercu) return json(Object.fromEntries(Object.entries(MODELES).map(([k, f]) => [k, f(exemple)])));
    if (!MODELES[essai]) return json({ erreur: "modèle inconnu" }, 400);
    const m = MODELES[essai](exemple);
    const r = await envoyer({ ...m, content: "Essai du modèle (sans notification)", allowed_mentions: { parse: [] } });
    return r.ok ? json({ envoye: true }) : json({ erreur: `Discord a répondu ${r.status}` }, 502);
  }

  // signature pas encore annoncée, marquée annoncée en une seule opération (deux appels simultanés : un seul message)
  const { data: lignes } = await admin.from("signatures").update({ annoncee: true })
    .eq("joueur", compte.discord_id).eq("annoncee", false).select("le, version");
  if (!lignes?.length) return json({ envoye: false });
  const derniere = lignes.sort((a, b) => b.le.localeCompare(a.le))[0];
  const { data: reglage } = await admin.from("reglages").select("valeur").eq("cle", "annonce_signature").maybeSingle();
  const modele = MODELES[reglage?.valeur ?? "sobre"] ?? MODELES.sobre;
  const r = await envoyer({ ...modele(signature(derniere.le, derniere.version)), allowed_mentions: { parse: ["everyone"] } });
  if (!r.ok) { // échec : la signature redevient « non annoncée », un nouvel appel la renverra
    await admin.from("signatures").update({ annoncee: false }).eq("joueur", compte.discord_id).eq("version", derniere.version);
    return json({ erreur: `Discord a répondu ${r.status}` }, 502);
  }
  return json({ envoye: true });
});

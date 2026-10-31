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

// nom : pseudo échappé pour le Markdown Discord (un pseudo choisi par le joueur ne devient ni lien ni mise en forme)
type Signature = { id: string; pseudo: string; nom: string; avatar: string; ts: number; invite: boolean };
const echapper = (t: string) => t.replace(/[\\*_~`|>\[\]()<#:-]/g, "\\$&");

// les 4 modèles : contenu (avec @here, hors embed : un @here dans un embed ne notifie personne) et embed
const MODELES: Record<string, (s: Signature) => { content: string; embeds: unknown[] }> = {
  sobre: (s) => ({
    content: "@here Nouvelle signature de la charte !",
    embeds: [{
      color: OR, author: { name: s.pseudo, icon_url: s.avatar }, title: "📜 Charte signée", url: `${SITE}/charte.html`,
      description: `**${s.nom}** vient de lire et d'approuver la charte du Royaume.`,
      fields: [{ name: "Joueur", value: `<@${s.id}>`, inline: true }, { name: "Signée le", value: `<t:${s.ts}:F>`, inline: true }],
      footer: { text: "Le Royaume · Espace membre", icon_url: LOGO },
    }],
  }),
  proclamation: (s) => ({
    content: "@here Oyez, oyez !",
    embeds: [{
      color: OR, title: "👑 Proclamation royale", thumbnail: { url: LOGO },
      description: `Par la présente, **${s.nom}** (<@${s.id}>) a apposé son sceau sur la Charte du Royaume.\n\n` +
        (s.invite ? "Officiers, un nouvel aspirant attend votre accueil !" : "Que son engagement soit salué !"),
      fields: [{ name: "🖋️ Sceau apposé le", value: `<t:${s.ts}:F>` }],
      footer: { text: "Le Royaume · Charte de la guilde", icon_url: LOGO },
    }],
  }),
  recrue: (s) => ({
    content: s.invite ? "@here Charte signée : action requise" : "@here Charte signée",
    embeds: [{
      color: s.invite ? VERT : OR, title: "✅ Nouvelle signature", thumbnail: { url: s.avatar },
      fields: [
        { name: "Joueur", value: `**${s.nom}** (<@${s.id}>)` },
        { name: "Signée le", value: `<t:${s.ts}:f> (<t:${s.ts}:R>)` },
        { name: "Statut", value: s.invite ? "Invité (aucun rôle de la guilde)" : "Déjà membre de la guilde" },
        ...(s.invite ? [{ name: "➡️ À faire", value: "Donner le rôle Postulant et inviter en guilde." }] : []),
      ],
      footer: { text: "Le Royaume · Espace membre", icon_url: LOGO },
    }],
  }),
  minimal: (s) => ({
    content: "@here",
    embeds: [{ color: OR, description: `📜 **${s.nom}** (<@${s.id}>) a signé la charte le <t:${s.ts}:F>.` }],
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
  const { apercu, essai } = (await req.json().catch(() => null)) ?? {};
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: compte } = await admin.from("acces").select("discord_id, pseudo, membre").eq("user_id", user.id).single();
  if (!compte) return json({ erreur: "compte inconnu" }, 403);

  const bot = { Authorization: `Bot ${Deno.env.get("DISCORD_BOT_TOKEN")}` };
  // profil Discord (avatar) lu seulement quand un message est vraiment construit
  const signature = async (le: string): Promise<Signature> => {
    const profil = await fetch(`https://discord.com/api/v10/users/${compte.discord_id}`, { headers: bot }).then((r) => r.ok ? r.json() : null);
    const avatar = profil?.avatar
      ? `https://cdn.discordapp.com/avatars/${compte.discord_id}/${profil.avatar}.png`
      : "https://cdn.discordapp.com/embed/avatars/0.png";
    const pseudo = compte.pseudo ?? "?";
    return { id: compte.discord_id, pseudo, nom: echapper(pseudo), avatar, ts: Math.floor(Date.parse(le) / 1000), invite: !compte.membre };
  };
  const connu = (k: unknown): k is string => typeof k === "string" && Object.hasOwn(MODELES, k); // pas « toString », « __proto__ »…
  const envoyer = (message: unknown) => fetch(`https://discord.com/api/v10/channels/${SALON}/messages`, {
    method: "POST", headers: { ...bot, "Content-Type": "application/json" }, body: JSON.stringify(message),
  });

  if (apercu || essai) {
    const { data: gestion } = await utilisateur.rpc("est_gestion");
    if (!gestion) return json({ erreur: "réservé à la gestion du site" }, 403);
    if (!apercu && !connu(essai)) return json({ erreur: "modèle inconnu" }, 400);
    const exemple = { ...await signature(new Date().toISOString()), invite: true }; // le cas qui demande une action
    if (apercu) return json(Object.fromEntries(Object.entries(MODELES).map(([k, f]) => [k, f(exemple)])));
    const m = MODELES[essai](exemple);
    const r = await envoyer({ ...m, content: "Essai du modèle (sans notification)", allowed_mentions: { parse: [] } });
    return r.ok ? json({ envoye: true }) : json({ erreur: `Discord a répondu ${r.status}` }, 502);
  }

  // signature pas encore annoncée, marquée annoncée en une seule opération (deux appels simultanés : un seul message)
  const { data: ligne } = await admin.from("signatures").update({ annoncee: true })
    .eq("joueur", compte.discord_id).eq("annoncee", false).select("le").maybeSingle();
  if (!ligne) return json({ envoye: false });
  const { data: reglage } = await admin.from("reglages").select("valeur").eq("cle", "annonce_signature").maybeSingle();
  const choisi = reglage?.valeur;
  const modele = connu(choisi) ? MODELES[choisi] : MODELES.sobre;
  // une panne réseau lève une exception au lieu d'une réponse en erreur : même traitement
  const r = await signature(ligne.le).then((s) => envoyer({ ...modele(s), allowed_mentions: { parse: ["everyone"] } }))
    .catch(() => ({ ok: false, status: "injoignable" }));
  if (!r.ok) { // échec : la signature redevient « non annoncée », un nouvel appel la renverra
    await admin.from("signatures").update({ annoncee: false }).eq("joueur", compte.discord_id);
    return json({ erreur: `Discord a répondu ${r.status}` }, 502);
  }
  return json({ envoye: true });
});

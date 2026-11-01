// Edge Function Supabase « scrutin » : vote de passage membre d'un postulant (officiers).
// { ouvrir: "<id Discord du postulant>" } : ouvre le vote et envoie à chaque votant (membres, officiers, chef de guilde
//   du roster) un MP du bot avec les boutons Pour / Contre / Ne se prononce pas / Commentaire (clics reçus par
//   l'Edge Function interactions-discord).
// { clore: <id du vote> } : fige le décompte, ferme les MP (« Vote clos », plus de boutons) et poste le résultat dans
//   le salon de suivi des candidatures.
// Le rôle Discord du postulant reste à changer à la main.
//
// Secrets : DISCORD_BOT_TOKEN (déjà défini).
import { createClient } from "jsr:@supabase/supabase-js@2";

const ORIGINES = ["https://le-royaume.fr"];
const SALON = "996869802096336967"; // suivi des candidatures
const SITE = "https://le-royaume.fr";
const LOGO = `${SITE}/img/logo-360.png`;
const OR = 0xd4af37, GRIS = 0x99aab5;
const echapper = (t: string) => t.replace(/[\\*_~`|>\[\]()<#:-]/g, "\\$&");

// boutons du MP ; custom_id lu par interactions-discord
const boutons = (id: number) => [{
  type: 1, components: [
    { type: 2, style: 3, label: "Pour", emoji: { name: "✅" }, custom_id: `vote:${id}:pour` },
    { type: 2, style: 4, label: "Contre", emoji: { name: "❌" }, custom_id: `vote:${id}:contre` },
    { type: 2, style: 2, label: "Ne se prononce pas", emoji: { name: "➖" }, custom_id: `vote:${id}:abstention` },
    { type: 2, style: 1, label: "Commentaire", emoji: { name: "💬" }, custom_id: `com:${id}` },
  ],
}];

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
  const { data: officier } = await utilisateur.rpc("est_officier");
  if (!officier) return json({ erreur: "réservé aux officiers" }, 403);
  const { data: { user } } = await utilisateur.auth.getUser();
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: compte } = await admin.from("acces").select("pseudo").eq("user_id", user!.id).single();
  const par = compte?.pseudo ?? "?";
  const { ouvrir, clore } = (await req.json().catch(() => null)) ?? {};
  // mode essai (réglage vote_test : identifiants Discord séparés par des virgules) : MP envoyés à ces seuls comptes,
  // résultat marqué « Essai » ; réglage supprimé = fonctionnement normal
  const { data: essai } = await admin.from("reglages").select("valeur").eq("cle", "vote_test").maybeSingle();
  const testeurs = essai?.valeur.split(",").map((s: string) => s.trim()).filter(Boolean);
  const marque = testeurs ? "🧪 Essai · " : "";

  const bot = { Authorization: `Bot ${Deno.env.get("DISCORD_BOT_TOKEN")}`, "Content-Type": "application/json" };
  // appel à Discord ; limite de débit (429) : une nouvelle tentative après le délai indiqué
  const discord = async (chemin: string, method: string, body?: unknown): Promise<Response> => {
    const r = await fetch(`https://discord.com/api/v10${chemin}`, { method, headers: bot, body: body && JSON.stringify(body) })
      .catch(() => new Response(null, { status: 503 }));
    if (r.status !== 429) return r;
    const { retry_after = 1 } = await r.json().catch(() => ({}));
    await new Promise((f) => setTimeout(f, retry_after * 1000));
    return fetch(`https://discord.com/api/v10${chemin}`, { method, headers: bot, body: body && JSON.stringify(body) })
      .catch(() => new Response(null, { status: 503 }));
  };

  if (typeof ouvrir === "string") {
    const { data: candidat } = await admin.from("roster").select("joueur, pseudo, arrivee").eq("joueur", ouvrir).eq("grade", "postulant").maybeSingle();
    if (!candidat) return json({ erreur: "ce joueur n'est pas postulant" }, 400);
    const { data: scrutin, error } = await admin.from("scrutins").insert({ candidat: candidat.joueur, pseudo: candidat.pseudo, ouvert_par: par })
      .select("id").single();
    if (error) return json({ erreur: error.code === "23505" ? "un vote est déjà ouvert pour ce postulant" : error.message }, 409);

    // fiche du postulant dans le MP : avatar, arrivée, charte, présence en raid
    const [profil, { data: signature }, { data: stats }, { data: votants }] = await Promise.all([
      discord(`/users/${candidat.joueur}`, "GET").then((r) => r.ok ? r.json() : null),
      admin.from("signatures").select("le").eq("joueur", candidat.joueur).maybeSingle(),
      utilisateur.rpc("stats_joueurs", { depuis: null }).eq("joueur", candidat.joueur).maybeSingle(),
      admin.from("roster").select("joueur").in("grade", ["gm", "officier", "membre"]).neq("joueur", candidat.joueur),
    ]);
    const ts = (d: string) => `<t:${Math.floor(Date.parse(d) / 1000)}:D>`;
    const dispo = (stats?.presents ?? 0) + (stats?.bancs ?? 0);
    const embed = {
      color: OR, title: `${marque}🗳️ Passage membre : ${echapper(candidat.pseudo)}`, url: `${SITE}/espace.html`,
      description: `Bonjour ! Les officiers ouvrent le vote pour le passage membre de **${echapper(candidat.pseudo)}** (<@${candidat.joueur}>).\n` +
        "Votre avis compte : votez avec les boutons ci-dessous. Le vote est anonyme et vous pouvez changer d'avis jusqu'à la clôture.",
      thumbnail: profil?.avatar ? { url: `https://cdn.discordapp.com/avatars/${candidat.joueur}/${profil.avatar}.png` } : { url: LOGO },
      fields: [
        { name: "Sur le Discord depuis", value: candidat.arrivee ? ts(candidat.arrivee) : "–", inline: true },
        { name: "Charte", value: signature ? `Signée le ${ts(signature.le)}` : "Non signée", inline: true },
        { name: "Présence en raid", value: dispo ? `${stats.presents} soirée(s) · ${Math.round(100 * stats.presents / dispo)} %` : "Aucune soirée", inline: true },
      ],
      footer: { text: "Le Royaume · Vote de passage membre", icon_url: LOGO },
    };

    let echecs = 0;
    const lignes = [];
    for (const { joueur } of (votants ?? []).filter((v) => !testeurs || testeurs.includes(v.joueur))) {
      // MP fermés aux membres du serveur : 403 (code 50007), le joueur vote alors sur le site
      const salon = await discord("/users/@me/channels", "POST", { recipient_id: joueur }).then((r) => r.ok ? r.json() : null);
      const m = salon && await discord(`/channels/${salon.id}/messages`, "POST", { embeds: [embed], components: boutons(scrutin.id) })
        .then((r) => r.ok ? r.json() : null);
      if (m) lignes.push({ scrutin: scrutin.id, votant: joueur, salon: salon.id, message: m.id });
      else echecs++;
    }
    await admin.from("votes").upsert(lignes);
    await admin.from("scrutins").update({ mp_echecs: echecs }).eq("id", scrutin.id);
    return json({ id: scrutin.id, envoyes: lignes.length, echecs });
  }

  if (typeof clore === "number") {
    const { data: s, error } = await admin.rpc("clore", { s: clore, par }).maybeSingle();
    if (error) return json({ erreur: error.message }, 500);
    if (!s) return json({ erreur: "vote introuvable ou déjà clos" }, 409);
    // MP fermés : « Vote clos », sans les boutons ni le résultat
    const { data: mps } = await admin.from("votes").select("salon, message").eq("scrutin", s.id).not("message", "is", null);
    await Promise.all((mps ?? []).map((v) => discord(`/channels/${v.salon}/messages/${v.message}`, "PATCH", {
      embeds: [{
        color: GRIS, title: `${marque}🗳️ Passage membre : ${echapper(s.pseudo)}`,
        description: "🔒 **Vote clos.** Merci pour votre participation !", footer: { text: "Le Royaume · Vote de passage membre", icon_url: LOGO },
      }],
      components: [],
    })));
    const { count: electeurs } = await admin.from("roster").select("*", { count: "exact", head: true }).in("grade", ["gm", "officier", "membre"]);
    const r = await discord(`/channels/${SALON}/messages`, "POST", {
      embeds: [{
        color: s.pour > s.contre ? 0x57f287 : s.pour < s.contre ? 0xed4245 : GRIS,
        title: `${marque}🗳️ Vote clos : passage membre de ${echapper(s.pseudo)}`,
        description: `<@${s.candidat}>`,
        fields: [
          { name: "✅ Pour", value: String(s.pour), inline: true },
          { name: "❌ Contre", value: String(s.contre), inline: true },
          { name: "➖ Ne se prononce pas", value: String(s.abstention), inline: true },
          { name: "Participation", value: `${s.pour + s.contre + s.abstention} votant(s) sur ${electeurs ?? "?"}` },
          { name: "Ouvert le", value: `<t:${Math.floor(Date.parse(s.ouvert_le) / 1000)}:f> par ${echapper(s.ouvert_par)}`, inline: true },
          { name: "Clos le", value: `<t:${Math.floor(Date.parse(s.clos_le) / 1000)}:f> par ${echapper(par)}`, inline: true },
        ],
        footer: { text: "Le Royaume · Rôle Discord à changer à la main", icon_url: LOGO },
      }],
      allowed_mentions: { parse: [] },
    });
    return json({ ...s, annonce: r.ok });
  }
  return json({ erreur: "requête inconnue" }, 400);
});

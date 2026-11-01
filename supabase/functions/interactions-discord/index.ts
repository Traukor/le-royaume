// Edge Function Supabase « interactions-discord » : reçoit les clics sur les boutons des MP de vote (Edge Function scrutin).
// Discord l'appelle directement : à déployer SANS vérification du JWT (la signature Discord fait foi), et son adresse
// est à renseigner dans le portail développeur Discord > General Information > Interactions Endpoint URL.
// Boutons : vote:<id>:<choix> enregistre le vote ; com:<id> ouvre la fenêtre de commentaire (comtxt:<id> à l'envoi).
//
// Secrets : DISCORD_PUBLIC_KEY (portail développeur > General Information > Public Key).
import { createClient } from "jsr:@supabase/supabase-js@2";

const CHOIX: Record<string, string> = { pour: "✅ Pour", contre: "❌ Contre", abstention: "➖ Ne se prononce pas" };
const hex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16));
const cle = crypto.subtle.importKey("raw", hex(Deno.env.get("DISCORD_PUBLIC_KEY") ?? ""), { name: "Ed25519" }, false, ["verify"]);

Deno.serve(async (req) => {
  const corps = await req.text();
  const signature = req.headers.get("X-Signature-Ed25519") ?? "";
  const horodatage = req.headers.get("X-Signature-Timestamp") ?? "";
  const valide = await crypto.subtle.verify("Ed25519", await cle, hex(signature), new TextEncoder().encode(horodatage + corps)).catch(() => false);
  if (!valide) return new Response("signature invalide", { status: 401 });
  const reponse = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  const prive = (texte: string) => reponse({ type: 4, data: { content: texte, flags: 64 } }); // visible du seul votant

  const i = JSON.parse(corps);
  if (i.type === 1) return reponse({ type: 1 }); // PING de vérification de l'adresse
  const qui = i.user?.id ?? i.member?.user?.id;
  const [action, id, choix] = String(i.data?.custom_id ?? "").split(":");
  const scrutin = Number(id);
  if (!qui || !scrutin) return prive("Action inconnue.");
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // MP mis à jour : le champ « Votre vote » ou « Votre commentaire » ajouté ou remplacé, boutons conservés
  const majMP = (nom: string, valeur: string) => {
    const [embed] = i.message.embeds;
    const fields = (embed.fields ?? []).filter((f: { name: string }) => f.name !== nom);
    return reponse({ type: 7, data: { embeds: [{ ...embed, fields: [...fields, { name: nom, value: valeur }] }], components: i.message.components } });
  };

  if (i.type === 3 && action === "vote" && CHOIX[choix]) {
    const { error } = await admin.rpc("enregistrer_vote", { s: scrutin, qui, c: choix, com: null });
    return error ? prive(`Vote refusé : ${error.message}.`) : majMP("Votre vote", CHOIX[choix]);
  }
  if (i.type === 3 && action === "com") {
    const { data: v } = await admin.from("votes").select("commentaire").eq("scrutin", scrutin).eq("votant", qui).maybeSingle();
    return reponse({
      type: 9, data: {
        custom_id: `comtxt:${scrutin}`, title: "Commentaire (anonyme)",
        components: [{ type: 1, components: [{
          type: 4, custom_id: "texte", style: 2, label: "Votre commentaire pour les officiers", max_length: 1000, required: false,
          value: v?.commentaire ?? undefined, placeholder: "Laisser vide pour effacer votre commentaire",
        }] }],
      },
    });
  }
  if (i.type === 5 && action === "comtxt") {
    const texte = String(i.data.components?.[0]?.components?.[0]?.value ?? "");
    const { error } = await admin.rpc("enregistrer_vote", { s: scrutin, qui, c: null, com: texte });
    return error ? prive(`Commentaire refusé : ${error.message}.`) : majMP("Votre commentaire", texte.trim() ? "Enregistré (anonyme)" : "Aucun");
  }
  return prive("Action inconnue.");
});

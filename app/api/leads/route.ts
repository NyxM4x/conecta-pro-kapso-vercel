// Recibe los formularios de las páginas y los manda al grupo de asesores en Telegram:
//   - /paquetes: el lead de un paquete o de una promo vigente (lib/lead-form.ts, lib/promos.ts).
//   - /oficina:  el pedido de reunión en la oficina (lib/office-form.ts), form = "oficina".
// Es pública a propósito (la abre cualquier cliente desde WhatsApp): la protegen el campo
// trampa para bots y la validación contra el catálogo.
//
// El contacto es el WhatsApp de quien tocó el botón del bot (?wa=<número>&t=<firma>, ver
// lib/site-links.ts): los formularios no piden número. Con la firma válida, el lead se
// cierra también en su conversación (lib/web-leads.ts). Al cliente no se le manda nada por
// WhatsApp: la página le muestra el check de "listo".

import { VIDEO_PACKAGES } from "../../../lib/packages";
import { buildLeadTelegramMessage, validateLead } from "../../../lib/lead-form";
import { buildOfficeVisitTelegramMessage, validateOfficeVisit } from "../../../lib/office-form";
import { findActivePromo } from "../../../lib/promos";
import { getLeadLinkSecret, packageSlug, verifyLeadPhone } from "../../../lib/site-links";
import { sendTelegramNotification } from "../../../lib/telegram";
import {
  closeWebLead,
  findConversation,
  getSupabase,
  type ConversationRow,
} from "../../../lib/web-leads";

export async function POST(request: Request) {
  const raw = await request.json().catch(() => null);
  if (!raw || typeof raw !== "object") {
    return Response.json({ ok: false, error: "Solicitud inválida" }, { status: 400 });
  }

  // Campo oculto que una persona nunca llena: si viene con algo, es un bot. Se responde
  // "ok" para que no reintente con otra estrategia.
  if (typeof raw.website === "string" && raw.website.trim()) {
    return Response.json({ ok: true });
  }

  const office = raw.form === "oficina";
  const result = office ? validateOfficeVisit(raw) : validateLead(raw);
  if ("errors" in result) {
    return Response.json({ ok: false, errors: result.errors }, { status: 422 });
  }

  const pkg =
    "lead" in result ? VIDEO_PACKAGES.find((item) => item.name === result.lead.packageName) : null;
  // Si no es un paquete del catálogo, puede ser una promo VIGENTE (lib/promos.ts). Vencida no
  // se acepta: quien dejó la página abierta no se queda con un precio que ya no existe.
  const promo = "lead" in result && !pkg ? findActivePromo(result.lead.packageName, new Date()) : null;
  if ("lead" in result && !pkg && !promo) {
    return Response.json(
      { ok: false, errors: [/^promo/i.test(result.lead.packageName) ? "la promoción ya no está vigente" : "Paquete"] },
      { status: 422 },
    );
  }
  if ("lead" in result && promo?.presenterPrice && !result.lead.presenter) {
    return Response.json({ ok: false, errors: ["¿Quién sale en los videos?"] }, { status: 422 });
  }

  const originPhone = "lead" in result ? result.lead.originPhone : result.visit.originPhone;

  // ¿El número del link es de verdad el del chat que recibió el botón?
  const secret = getLeadLinkSecret();
  const token = typeof raw.originToken === "string" ? raw.originToken : "";
  const verified = Boolean(originPhone && secret && verifyLeadPhone(originPhone, token, secret));

  const supabase = getSupabase();
  let conversation: ConversationRow | null = null;

  if (verified && supabase && originPhone) {
    try {
      conversation = await findConversation(supabase, originPhone);
    } catch (error) {
      console.error("lead web: no se pudo buscar la conversación", error);
    }
  }

  const options = { verified, alreadyLeadInChat: Boolean(conversation?.advisor_notified_at) };
  const message =
    "lead" in result && pkg
      ? buildLeadTelegramMessage(result.lead, `${pkg.name} — ${pkg.videos} videos — ${pkg.price} Bs`, options)
      : "lead" in result && promo
        ? buildLeadTelegramMessage(
            result.lead,
            `${promo.shortName} — ${promo.videoCount} videos — ${promo.price} Bs`,
            { ...options, promo: { presenterPrice: promo.presenterPrice } },
          )
      : "visit" in result
        ? buildOfficeVisitTelegramMessage(result.visit, options)
        : "";

  const sent = await sendTelegramNotification(message);

  if (!sent) {
    console.error("lead web: no se pudo enviar a Telegram", office ? "oficina" : "paquetes");
    return Response.json({ ok: false, error: "No pudimos enviar tus datos" }, { status: 502 });
  }

  // El lead ya llegó al asesor: lo que sigue nunca hace fallar el envío.
  if (conversation && supabase && originPhone) {
    try {
      await closeWebLead(supabase, conversation, {
        phone: originPhone,
        page: office ? "oficina" : "paquetes",
        selectedPackage: pkg ? packageSlug(pkg.name) : promo ? promo.slug : null,
        detail: pkg
          ? { package: pkg.name }
          : promo && "lead" in result
            ? { package: promo.shortName, promo_id: promo.id, presenter: result.lead.presenter ?? null }
            : "visit" in result
              ? { visit_type: result.visit.type }
              : {},
      });
    } catch (error) {
      console.error("lead web: no se pudo cerrar en la conversación", error);
    }
  }

  return Response.json({ ok: true });
}

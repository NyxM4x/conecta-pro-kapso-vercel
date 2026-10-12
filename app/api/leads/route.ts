// Recibe el formulario de la página /paquetes y lo manda al grupo de asesores en Telegram.
// Es pública a propósito (la abre cualquier cliente desde WhatsApp): la protegen el campo
// trampa para bots y la validación del paquete contra el catálogo.

import { VIDEO_PACKAGES } from "../../../lib/packages";
import { buildLeadTelegramMessage, validateLead } from "../../../lib/lead-form";
import { sendTelegramNotification } from "../../../lib/telegram";

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

  const result = validateLead(raw);
  if ("errors" in result) {
    return Response.json({ ok: false, errors: result.errors }, { status: 422 });
  }

  const pkg = VIDEO_PACKAGES.find((item) => item.name === result.lead.packageName);
  if (!pkg) {
    return Response.json({ ok: false, errors: ["Paquete"] }, { status: 422 });
  }

  const sent = await sendTelegramNotification(
    buildLeadTelegramMessage(result.lead, `${pkg.name} — ${pkg.videos} videos — ${pkg.price} Bs`),
  );

  if (!sent) {
    console.error("lead web: no se pudo enviar a Telegram", result.lead.packageName);
    return Response.json({ ok: false, error: "No pudimos enviar tus datos" }, { status: 502 });
  }

  return Response.json({ ok: true });
}

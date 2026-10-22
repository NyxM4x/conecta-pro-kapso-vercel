// La página avisa que el cliente la abrió desde el botón del bot. Queda una marca en su
// conversación ([SITE_VISIT:<página>], ver lib/web-leads.ts) para saber si de verdad entró
// aunque no haya enviado nada: lo usan el bot (si dice "ya lo envié") y el comando
// /cliente del grupo de Telegram.
//
// Solo con el número firmado del link: sin firma no se toca ninguna conversación.

import { getLeadLinkSecret, verifyLeadPhone, type SitePage } from "../../../lib/site-links";
import { findConversation, getSupabase, recordSiteVisit } from "../../../lib/web-leads";

const PAGES: SitePage[] = ["paquetes", "promocion", "cursos", "oficina"];

export async function POST(request: Request) {
  const raw = await request.json().catch(() => null);
  const page = raw?.page as SitePage;
  const phone = typeof raw?.wa === "string" ? raw.wa.replace(/\D/g, "") : "";
  const token = typeof raw?.t === "string" ? raw.t : "";

  const secret = getLeadLinkSecret();
  if (!PAGES.includes(page) || !phone || !secret || !verifyLeadPhone(phone, token, secret)) {
    // Respuesta vacía igual: la página no espera nada y no hay que dar pistas.
    return new Response(null, { status: 204 });
  }

  const supabase = getSupabase();
  if (!supabase) return new Response(null, { status: 204 });

  try {
    const conversation = await findConversation(supabase, phone);
    if (conversation) await recordSiteVisit(supabase, conversation, phone, page);
  } catch (error) {
    console.error("site-visit: no se pudo registrar", error);
  }

  return new Response(null, { status: 204 });
}

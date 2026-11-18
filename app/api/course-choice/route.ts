// El cliente tocó un botón de pago en /cursos ("Pagar combo", "Pagar este curso"). Queda una marca
// en su conversación ([COURSE_PAY_CLICK:<opción>], ver lib/web-leads.ts) para saber CUÁL eligió: el
// webhook la cruza con el monto del comprobante y la alerta de Telegram dice si coincide.
//
// Solo con el número firmado del link, igual que /api/site-visit. Nunca se manda nada por WhatsApp.
// El monto NO viene del navegador: se calcula acá con el catálogo (lib/courses.ts).

import { COURSES, getActiveBundle } from "../../../lib/courses";
import { getLeadLinkSecret, verifyLeadPhone } from "../../../lib/site-links";
import { findConversation, getSupabase, recordCoursePayClick } from "../../../lib/web-leads";

export async function POST(request: Request) {
  const raw = await request.json().catch(() => null);
  const option = typeof raw?.option === "string" ? raw.option : "";
  const phone = typeof raw?.wa === "string" ? raw.wa.replace(/\D/g, "") : "";
  const token = typeof raw?.t === "string" ? raw.t : "";

  const secret = getLeadLinkSecret();
  if (!option || !phone || !secret || !verifyLeadPhone(phone, token, secret)) {
    return new Response(null, { status: 204 });
  }

  const now = new Date();
  let amount: number | null = null;

  if (option === "combo") {
    amount = getActiveBundle(now)?.price ?? null;
  } else {
    amount = COURSES.find((course) => course.id === option)?.pricePreventa ?? null;
  }
  // Una opción que no existe (o un combo ya cerrado) no deja marca.
  if (amount === null) return new Response(null, { status: 204 });

  const supabase = getSupabase();
  if (!supabase) return new Response(null, { status: 204 });

  try {
    const conversation = await findConversation(supabase, phone);
    if (conversation) await recordCoursePayClick(supabase, conversation, phone, option, amount);
  } catch (error) {
    console.error("course-choice: no se pudo registrar", error);
  }

  return new Response(null, { status: 204 });
}

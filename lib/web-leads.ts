// Lo que pasa en las páginas, cruzado con la conversación de WhatsApp del cliente.
//
// Los links del bot llevan el WhatsApp del cliente firmado (?wa=&t=, ver lib/site-links.ts).
// Con eso, las rutas de la página dejan rastro en su conversación:
//   - recordSiteVisit: abrió una página (para saber si de verdad entró, aunque no envíe nada).
//   - closeWebLead:   envió un formulario. Queda igual que un lead cerrado por chat:
//                     [TELEGRAM_LEAD_SENT] (el bot no vuelve a pedirle los datos ni avisa dos
//                     veces), etapa advisor_notified (entra a las alertas de leads sin atender)
//                     y el bot apagado 12 h para que lo tome el asesor.
// NUNCA se le manda nada por WhatsApp: la página ya le mostró el check de "listo", y cada
// mensaje cuesta.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { siteVisitMarker, webLeadMarker, type LeadPage, type SitePage } from "./site-links.ts";

// Lo mismo que HUMAN_HANDOFF_PAUSE_MINUTES del webhook: el asesor puede tomar el lead
// recién a la mañana siguiente.
const LEAD_CLOSED_PAUSE_MINUTES = 12 * 60;

// Una visita por página cada tanto: recargar la página no llena la conversación de marcas.
const SITE_VISIT_DEDUP_MINUTES = 15;

// Mismo marcador que guarda el webhook cuando el cliente pide reunirse en la oficina
// (OFFICE_VISIT_MARKER allá): así el bot sabe que la reunión ya está pedida.
const OFFICE_VISIT_MARKER = "[OFFICE_VISIT_REQUESTED]";

type ConversationRow = {
  kapso_conversation_id: string;
  bot_paused: boolean | null;
  advisor_notified_at: string | null;
};

function getSupabase(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? createClient(url, key) : null;
}

// La conversación más reciente de ese WhatsApp (contact_phone se guarda solo con dígitos y
// código de país, igual que viaja en ?wa=).
async function findConversation(
  supabase: SupabaseClient,
  phone: string,
): Promise<ConversationRow | null> {
  const { data, error } = await supabase
    .from("kapso_conversations")
    .select("kapso_conversation_id, bot_paused, advisor_notified_at")
    .eq("contact_phone", phone)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) console.error("web: no se encontró la conversación", error.message);
  return (data as ConversationRow | null) ?? null;
}

async function saveMarker(
  supabase: SupabaseClient,
  conversationId: string,
  phone: string,
  content: string,
  rawPayload: Record<string, unknown>,
) {
  const { error } = await supabase.from("kapso_messages").insert({
    kapso_message_id: null,
    kapso_conversation_id: conversationId,
    contact_phone: phone,
    direction: "outbound",
    role: "assistant",
    content,
    message_timestamp: new Date().toISOString(),
    batch_index: null,
    raw_payload: rawPayload,
  });

  if (error) console.error("web: no se pudo guardar el marcador", content, error.message);
}

// Abrió una página desde el botón del bot.
async function recordSiteVisit(
  supabase: SupabaseClient,
  conversation: ConversationRow,
  phone: string,
  page: SitePage,
): Promise<void> {
  const conversationId = conversation.kapso_conversation_id;
  const since = new Date(Date.now() - SITE_VISIT_DEDUP_MINUTES * 60_000).toISOString();

  const { data } = await supabase
    .from("kapso_messages")
    .select("id")
    .eq("kapso_conversation_id", conversationId)
    .eq("content", siteVisitMarker(page))
    .gte("created_at", since)
    .limit(1);

  if ((data ?? []).length > 0) return;

  await saveMarker(supabase, conversationId, phone, siteVisitMarker(page), {
    type: "site_visit",
    page,
  });
}

// Envió un formulario de la página: el lead queda cerrado en su conversación.
async function closeWebLead(
  supabase: SupabaseClient,
  conversation: ConversationRow,
  params: {
    phone: string;
    page: LeadPage;
    selectedPackage?: string | null;
    detail: Record<string, unknown>;
  },
): Promise<void> {
  const conversationId = conversation.kapso_conversation_id;
  const nowIso = new Date().toISOString();

  await saveMarker(supabase, conversationId, params.phone, webLeadMarker(params.page), {
    type: "telegram_notification",
    event: "lead",
    kind: params.page === "oficina" ? "office_visit" : "intake",
    trigger: "web_form",
    ...params.detail,
  });

  if (params.page === "oficina") {
    await saveMarker(
      supabase,
      conversationId,
      params.phone,
      `${OFFICE_VISIT_MARKER} el cliente pidió reunirse en la oficina desde la página (se coordina por llamada)`,
      { type: "office_visit_request", source: "web_form", ...params.detail },
    );
  }

  // advisor_notified es la última etapa: no hay forma de retroceder a nadie.
  const patch: Record<string, unknown> = {
    flow_stage: "advisor_notified",
    lead_captured_at: nowIso,
    advisor_notified_at: nowIso,
    updated_at: nowIso,
  };
  if (params.selectedPackage) patch.selected_package = params.selectedPackage;

  // Mismo apagado que el cierre de lead por chat. Si un humano ya lo había pausado, se
  // respeta su pausa (puede ser indefinida).
  if (!conversation.bot_paused) {
    Object.assign(patch, {
      bot_paused: true,
      bot_paused_at: nowIso,
      bot_pause_expires_at: new Date(Date.now() + LEAD_CLOSED_PAUSE_MINUTES * 60_000).toISOString(),
      bot_paused_reason: "human_handoff:lead_closed_web",
      bot_pause_mode: "auto",
      bot_pause_duration_minutes: LEAD_CLOSED_PAUSE_MINUTES,
    });
  }

  const { error } = await supabase
    .from("kapso_conversations")
    .update(patch)
    .eq("kapso_conversation_id", conversationId);

  if (error) console.error("web: no se pudo actualizar la conversación", error.message);
}

export { closeWebLead, findConversation, getSupabase, recordSiteVisit };
export type { ConversationRow };

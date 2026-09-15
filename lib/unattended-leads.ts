// LEADS SIN ATENDER — escalación a Telegram.
//
// Un lead ya notificado (🟢 Nuevo lead) al que ningún humano le escribió por WhatsApp recibe
// dos avisos, y nunca más:
//   1. 🚨 a los THRESHOLD_MINUTES (30 min por defecto).
//   2. ⏰ ÚLTIMO AVISO a las FINAL_ALERT_HOURS (20 h por defecto): a tiempo para escribirle
//      antes de que se cierre la ventana de 24 h de WhatsApp.
// "Atendido" = un humano le escribió desde WhatsApp Business (advisor_replied_at, o un
// mensaje business_app_manual guardado después del aviso).
//
// Por qué vive aquí y no solo en el cron: el job de pg_cron que debía llamar a
// /api/cron/unattended-leads nunca corrió (al 15 sep 2026: 151 leads avisados, 46 sin
// respuesta humana y 0 alertas). Ahora también lo dispara el webhook de Kapso con cada
// evento que llega, como máximo una vez cada CHECK_EVERY_MINUTES, así funciona aunque el
// cron de Supabase siga caído.

import {
  notifyUnattendedLeadFinalToTelegram,
  notifyUnattendedLeadToTelegram,
} from "./telegram.ts";

type SupabaseLike = { from: (table: string) => any };

const BATCH_SIZE = 20;
const THRESHOLD_MINUTES = Number(process.env.UNATTENDED_LEAD_THRESHOLD_MINUTES ?? 30);
const LOOKBACK_HOURS = Number(process.env.UNATTENDED_LEAD_LOOKBACK_HOURS ?? 24);
const FINAL_ALERT_HOURS = Number(process.env.UNATTENDED_LEAD_FINAL_ALERT_HOURS ?? 20);
// Límite hacia atrás del último aviso: evita que el primer despliegue le mande un "último
// aviso" a leads viejos que ya no tiene sentido perseguir.
const FINAL_ALERT_LOOKBACK_HOURS = 26;
const WHATSAPP_WINDOW_HOURS = 24;
const CHECK_EVERY_MINUTES = 10;
// Marcador en kapso_messages (no una columna nueva): el último aviso no depende de correr
// ninguna migración en Supabase.
const FINAL_ALERT_MARKER = "[TELEGRAM_UNATTENDED_FINAL_SENT]";

// Primer aviso. La fila se RECLAMA antes de enviar (update condicionado a que la columna siga
// en null): si dos procesos corren a la vez, solo uno gana y el aviso no sale duplicado.
async function processFirstAlerts(supabase: SupabaseLike, now: number) {
  const thresholdCutoff = new Date(now - THRESHOLD_MINUTES * 60_000).toISOString();
  const lookbackCutoff = new Date(now - LOOKBACK_HOURS * 3600_000).toISOString();

  const { data: candidates, error } = await supabase
    .from("kapso_conversations")
    .select("kapso_conversation_id, contact_phone, advisor_notified_at")
    .eq("flow_stage", "advisor_notified")
    .is("advisor_replied_at", null)
    .is("unattended_alert_sent_at", null)
    .lte("advisor_notified_at", thresholdCutoff)
    .gte("advisor_notified_at", lookbackCutoff)
    .order("advisor_notified_at", { ascending: true })
    .limit(BATCH_SIZE);

  if (error) return { processed: 0, alerted: 0, error: error.message as string };

  let alerted = 0;

  for (const row of candidates ?? []) {
    const conversationId = row.kapso_conversation_id as string;

    const { data: claimed } = await supabase
      .from("kapso_conversations")
      .update({ unattended_alert_sent_at: new Date().toISOString() })
      .eq("kapso_conversation_id", conversationId)
      .is("unattended_alert_sent_at", null)
      .select("kapso_conversation_id");

    if (!claimed || claimed.length === 0) continue;

    const minutesWaiting = Math.round((now - new Date(row.advisor_notified_at).getTime()) / 60_000);
    const sent = await notifyUnattendedLeadToTelegram({
      phone: row.contact_phone as string,
      minutesWaiting,
    }).catch(() => false);

    if (sent) {
      alerted += 1;
    } else {
      // No salió: se libera para reintentar en la próxima corrida.
      await supabase
        .from("kapso_conversations")
        .update({ unattended_alert_sent_at: null })
        .eq("kapso_conversation_id", conversationId);
    }
  }

  return { processed: (candidates ?? []).length, alerted };
}

// Segundo y último aviso. Antes de mandarlo se vuelve a mirar kapso_messages: si un humano
// le escribió después del aviso del lead (y advisor_replied_at no quedó guardado), se corrige
// la columna y no se alerta.
async function processFinalAlerts(supabase: SupabaseLike, now: number) {
  const finalCutoff = new Date(now - FINAL_ALERT_HOURS * 3600_000).toISOString();
  const lookbackCutoff = new Date(now - FINAL_ALERT_LOOKBACK_HOURS * 3600_000).toISOString();

  const { data: candidates, error } = await supabase
    .from("kapso_conversations")
    .select("kapso_conversation_id, contact_phone, advisor_notified_at")
    .eq("flow_stage", "advisor_notified")
    .is("advisor_replied_at", null)
    .lte("advisor_notified_at", finalCutoff)
    .gte("advisor_notified_at", lookbackCutoff)
    .order("advisor_notified_at", { ascending: true })
    .limit(BATCH_SIZE);

  if (error) return { processed: 0, alerted: 0, error: error.message as string };

  let alerted = 0;

  for (const row of candidates ?? []) {
    const conversationId = row.kapso_conversation_id as string;
    const notifiedAt = row.advisor_notified_at as string;

    const [{ data: finalSent }, { data: humanReplies }, { data: lastInbound }] = await Promise.all([
      supabase
        .from("kapso_messages")
        .select("id")
        .eq("kapso_conversation_id", conversationId)
        .like("content", `${FINAL_ALERT_MARKER}%`)
        .limit(1),
      supabase
        .from("kapso_messages")
        .select("created_at")
        .eq("kapso_conversation_id", conversationId)
        .eq("direction", "outbound")
        .eq("raw_payload->>source", "business_app_manual")
        .gte("created_at", notifiedAt)
        .order("created_at", { ascending: true })
        .limit(1),
      supabase
        .from("kapso_messages")
        .select("created_at")
        .eq("kapso_conversation_id", conversationId)
        .eq("direction", "inbound")
        .order("created_at", { ascending: false })
        .limit(1),
    ]);

    if ((finalSent ?? []).length > 0) continue;

    if ((humanReplies ?? []).length > 0) {
      await supabase
        .from("kapso_conversations")
        .update({ advisor_replied_at: humanReplies[0].created_at })
        .eq("kapso_conversation_id", conversationId)
        .is("advisor_replied_at", null);
      continue;
    }

    const lastInboundAt = lastInbound?.[0]?.created_at as string | undefined;
    const sent = await notifyUnattendedLeadFinalToTelegram({
      phone: row.contact_phone as string,
      hoursWaiting: (now - new Date(notifiedAt).getTime()) / 3600_000,
      windowHoursLeft: lastInboundAt
        ? WHATSAPP_WINDOW_HOURS - (now - new Date(lastInboundAt).getTime()) / 3600_000
        : null,
    }).catch(() => false);

    if (sent) {
      await supabase.from("kapso_messages").insert({
        kapso_message_id: null,
        kapso_conversation_id: conversationId,
        contact_phone: row.contact_phone,
        direction: "outbound",
        role: "assistant",
        content: `${FINAL_ALERT_MARKER} último aviso de lead sin atender enviado a Telegram`,
        message_timestamp: new Date().toISOString(),
        batch_index: null,
        raw_payload: { type: "telegram_notification", event: "unattended_lead_final" },
      });
      alerted += 1;
    }
  }

  return { processed: (candidates ?? []).length, alerted };
}

// ¿Le toca correr a este proceso? Un candado por franja de 10 minutos en
// kapso_response_locks (la clave es única): el primero que lo inserta corre, el resto no.
// Si la tabla rechaza el candado por otro motivo, se usa system_logs como respaldo.
async function claimCheckSlot(supabase: SupabaseLike, now: number): Promise<boolean> {
  const bucket = Math.floor(now / (CHECK_EVERY_MINUTES * 60_000));

  const { error } = await supabase.from("kapso_response_locks").insert({
    kapso_conversation_id: "system:unattended-leads",
    last_kapso_message_id: `system:unattended-leads:${bucket}`,
    batch_size: 0,
    status: "sent",
  });

  if (!error) return true;
  if (error.code === "23505") return false;

  const since = new Date(now - CHECK_EVERY_MINUTES * 60_000).toISOString();
  const { data } = await supabase
    .from("system_logs")
    .select("id")
    .eq("event_type", "unattended_leads_check_ran")
    .gte("created_at", since)
    .limit(1);

  if ((data ?? []).length > 0) return false;

  await supabase.from("system_logs").insert({
    level: "info",
    event_type: "unattended_leads_check_ran",
    source: "kapso-vercel",
    business: "conecta-pro",
    metadata: { lock_error: error.message ?? null },
  });
  return true;
}

// Punto de entrada único (cron y webhook). `force` salta el candado de franja (invocación
// manual del cron para probar).
async function runUnattendedLeadChecks(
  supabase: SupabaseLike,
  options: { force?: boolean } = {},
): Promise<{ skipped: boolean; first?: unknown; final?: unknown }> {
  const now = Date.now();
  if (!options.force && !(await claimCheckSlot(supabase, now))) return { skipped: true };

  const first = await processFirstAlerts(supabase, now);
  const final = await processFinalAlerts(supabase, now);
  return { skipped: false, first, final };
}

export { runUnattendedLeadChecks };

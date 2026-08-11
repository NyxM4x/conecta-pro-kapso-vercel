import { WhatsAppClient } from "@kapso/whatsapp-cloud-api";
import { createClient } from "@supabase/supabase-js";

// Consumidor de kapso_followups: reactiva a los clientes que recibieron el
// formulario de datos pero no lo completaron (ataca la caída del funnel
// intake_sent -> asesor). Invocado cada 10 min por pg_cron desde Supabase (ver
// supabase/migrations/20260811_pg_cron_schedulers.sql) o manualmente, siempre con
// el header X-Followup-Secret.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_ATTEMPTS = 3;
const BATCH_SIZE = 20;

const FOLLOWUP_MESSAGE = `¡Hola! 👋 Vi que te interesaban nuestros paquetes de contenido pero quedó pendiente coordinar. ¿Te ayudo a avanzar? 😊

Con tu *nombre*, *empresa*, *número de contacto* y *rubro*, un asesor te contacta enseguida.`;

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function getSupabaseClient() {
  return createClient(
    getRequiredEnv("SUPABASE_URL"),
    getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
  );
}

function getKapsoClient() {
  return new WhatsAppClient({
    baseUrl: "https://api.kapso.ai/meta/whatsapp",
    kapsoApiKey: getRequiredEnv("KAPSO_API_KEY"),
  });
}

function isAuthorized(request: Request): boolean {
  const followupSecret = process.env.FOLLOWUP_SECRET;
  const cronSecret = process.env.CRON_SECRET;

  const headerSecret = request.headers.get("X-Followup-Secret");
  const authHeader = request.headers.get("Authorization");

  if (followupSecret && headerSecret === followupSecret) return true;
  // Vercel Cron envía "Authorization: Bearer <CRON_SECRET>".
  if (cronSecret && authHeader === `Bearer ${cronSecret}`) return true;

  return false;
}

async function processFollowups() {
  const supabase = getSupabaseClient();
  const nowIso = new Date().toISOString();

  const { data: due, error } = await supabase
    .from("kapso_followups")
    .select("id, kapso_conversation_id, contact_phone, attempts")
    .eq("status", "pending")
    .lte("scheduled_at", nowIso)
    .order("scheduled_at", { ascending: true })
    .limit(BATCH_SIZE);

  if (error) {
    console.error("supabase select due followups failed", error);
    return { processed: 0, sent: 0, skipped: 0, error: error.message };
  }

  const rows = due ?? [];
  let sent = 0;
  let skipped = 0;

  if (rows.length === 0) return { processed: 0, sent, skipped };

  const kapso = getKapsoClient();
  const phoneNumberId = getRequiredEnv("KAPSO_PHONE_NUMBER_ID");

  for (const row of rows) {
    const conversationId = row.kapso_conversation_id as string;

    // Estado actual de la conversación: no reactivar si el bot está pausado (un
    // humano tomó el chat) o si el lead ya fue derivado al asesor.
    const { data: conv } = await supabase
      .from("kapso_conversations")
      .select("flow_stage, advisor_notified_at, bot_paused, bot_pause_expires_at")
      .eq("kapso_conversation_id", conversationId)
      .maybeSingle();

    const botPaused =
      conv?.bot_paused === true &&
      (!conv?.bot_pause_expires_at ||
        new Date(conv.bot_pause_expires_at).getTime() > Date.now());
    const alreadyNotified =
      Boolean(conv?.advisor_notified_at) ||
      conv?.flow_stage === "advisor_notified" ||
      conv?.flow_stage === "lead_captured";

    if (botPaused || alreadyNotified || (row.attempts ?? 0) >= MAX_ATTEMPTS) {
      await supabase
        .from("kapso_followups")
        .update({
          status: "skipped",
          skip_reason: botPaused
            ? "bot_paused"
            : alreadyNotified
              ? "lead_captured"
              : "max_attempts",
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id);
      skipped += 1;
      continue;
    }

    try {
      await kapso.messages.sendText({
        phoneNumberId,
        to: row.contact_phone as string,
        body: FOLLOWUP_MESSAGE,
      });

      // Registrar en el historial para que el bot vea el recordatorio ya enviado.
      await supabase.from("kapso_messages").insert({
        kapso_message_id: null,
        kapso_conversation_id: conversationId,
        contact_phone: row.contact_phone,
        direction: "outbound",
        role: "assistant",
        content: FOLLOWUP_MESSAGE,
        message_timestamp: new Date().toISOString(),
        batch_index: null,
        raw_payload: { type: "followup", source: "followups_cron" },
      });

      await supabase
        .from("kapso_followups")
        .update({
          status: "sent",
          sent_at: new Date().toISOString(),
          attempts: (row.attempts ?? 0) + 1,
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id);

      sent += 1;
    } catch (sendError) {
      console.error("followup send failed", sendError);
      await supabase
        .from("kapso_followups")
        .update({
          attempts: (row.attempts ?? 0) + 1,
          error_message:
            sendError instanceof Error ? sendError.message : String(sendError),
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id);
      skipped += 1;
    }
  }

  return { processed: rows.length, sent, skipped };
}

async function handle(request: Request) {
  if (!isAuthorized(request)) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await processFollowups();
    return Response.json({ ok: true, ...result });
  } catch (error) {
    return Response.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}

// GET para Vercel Cron; POST para invocación manual con secret.
export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}

import { createClient } from "@supabase/supabase-js";
import { notifyUnattendedLeadToTelegram } from "../../../../lib/telegram";

// Consumidor de kapso_conversations: escala a Telegram con 🚨 los leads que ya
// fueron notificados (🟢 Nuevo lead) pero que ningún asesor humano atendió dentro
// del umbral configurado. Complementa la alerta ⚪ genérica de "Requiere asesor",
// que el equipo suele pasar por alto. Invocado cada 10 min por pg_cron desde
// Supabase (ver supabase/migrations/20260811_pg_cron_schedulers.sql) o manualmente,
// siempre con el header X-Followup-Secret.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BATCH_SIZE = 20;
const THRESHOLD_MINUTES = Number(process.env.UNATTENDED_LEAD_THRESHOLD_MINUTES ?? 30);
const LOOKBACK_HOURS = Number(process.env.UNATTENDED_LEAD_LOOKBACK_HOURS ?? 24);

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

async function processUnattendedLeads() {
  const supabase = getSupabaseClient();
  const now = Date.now();
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

  if (error) {
    console.error("supabase select unattended leads failed", error);
    return { processed: 0, alerted: 0, error: error.message };
  }

  const rows = candidates ?? [];
  let alerted = 0;

  for (const row of rows) {
    const minutesWaiting = Math.round(
      (now - new Date(row.advisor_notified_at as string).getTime()) / 60_000,
    );

    try {
      const sent = await notifyUnattendedLeadToTelegram({
        phone: row.contact_phone as string,
        minutesWaiting,
      });

      if (sent) {
        await supabase
          .from("kapso_conversations")
          .update({ unattended_alert_sent_at: new Date().toISOString() })
          .eq("kapso_conversation_id", row.kapso_conversation_id as string)
          .is("unattended_alert_sent_at", null);
        alerted += 1;
      }
    } catch (sendError) {
      console.error("unattended lead alert failed", sendError);
    }
  }

  return { processed: rows.length, alerted };
}

async function handle(request: Request) {
  if (!isAuthorized(request)) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await processUnattendedLeads();
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

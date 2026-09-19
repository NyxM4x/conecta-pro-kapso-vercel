import { createClient } from "@supabase/supabase-js";
import { runUnattendedLeadChecks } from "../../../../lib/unattended-leads";
import { runPendingPaymentAlertSweep } from "../../../../lib/payment-alerts";

// Disparo manual o programado de la escalación de leads sin atender (🚨 a los 30 min y
// ⏰ último aviso a las 20 h). Toda la lógica vive en lib/unattended-leads.ts; el webhook de
// Kapso la dispara también en cada evento, porque el job de pg_cron que debía llamar a esta
// ruta (supabase/migrations/20260811_pg_cron_schedulers.sql) nunca llegó a correr.
// Siempre con el header X-Followup-Secret (o Authorization: Bearer <CRON_SECRET>).
// `?force=1` corre la revisión aunque ya se haya hecho en los últimos 10 minutos.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

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

async function handle(request: Request) {
  if (!isAuthorized(request)) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const force = new URL(request.url).searchParams.get("force") === "1";
    const supabase = getSupabaseClient();
    const result = await runUnattendedLeadChecks(supabase, { force });
    // Mismo disparo para las alertas 💰 que esperaban los datos del cliente (20 min).
    const payments = await runPendingPaymentAlertSweep(supabase, { force });
    return Response.json({ ok: true, ...result, payments });
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

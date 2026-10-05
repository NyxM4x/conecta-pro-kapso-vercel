import { createClient } from "@supabase/supabase-js";
import { resolveAiProvider, resolveTranscriptionTargets } from "../../../lib/ai-provider";

function envExists(name: string): boolean {
  return Boolean(process.env[name]);
}

function checkEnv() {
  const required = [
    "KAPSO_API_KEY",
    "KAPSO_PHONE_NUMBER_ID",
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    // La clave que hace falta depende de AI_PROVIDER: con openrouter, exigir
    // OPENAI_API_KEY dejaría el health en rojo estando todo bien.
    resolveAiProvider().apiKeyVar,
  ];

  const missing = required.filter((name) => !envExists(name));

  return {
    ok: missing.length === 0,
    missing,
  };
}

async function checkSupabase() {
  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      return {
        ok: false,
        error: "Supabase env vars missing",
      };
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    const { error } = await supabase
      .from("system_logs")
      .select("id", { head: true, count: "exact" });

    if (error) {
      return {
        ok: false,
        error: error.message,
      };
    }

    return {
      ok: true,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function GET() {
  const env = checkEnv();
  const supabase = await checkSupabase();
  const ai = resolveAiProvider();
  const [transcription, transcriptionFallback] = resolveTranscriptionTargets();

  const status =
    env.ok && supabase.ok
      ? "ok"
      : "error";

  const body = {
    status,
    service: "conecta-pro-kapso-vercel",
    timestamp: new Date().toISOString(),
    checks: {
      env: {
        ok: env.ok,
        missing: env.missing,
      },
      supabase,
      kapso: {
        ok: envExists("KAPSO_API_KEY") && envExists("KAPSO_PHONE_NUMBER_ID"),
        apiKeyConfigured: envExists("KAPSO_API_KEY"),
        phoneNumberIdConfigured: envExists("KAPSO_PHONE_NUMBER_ID"),
      },
      ai: {
        ok: ai.apiKeyConfigured,
        provider: ai.provider,
        model: ai.model,
        apiKeyVar: ai.apiKeyVar,
        // Si AI_PROVIDER trae un typo se cae a OpenAI en silencio; acá se ve.
        unknownProviderValue: ai.unknownValue,
        // Los audios tienen su propio orden, use el proveedor que use el bot: Groq si hay
        // GROQ_API_KEY, y OpenAI de respaldo.
        transcription: {
          provider: transcription.provider,
          model: transcription.model,
          apiKeyConfigured: transcription.apiKeyConfigured,
          fallback: transcriptionFallback
            ? {
                provider: transcriptionFallback.provider,
                model: transcriptionFallback.model,
                apiKeyConfigured: transcriptionFallback.apiKeyConfigured,
              }
            : null,
        },
      },
    },
  };

  return Response.json(body, {
    status: status === "ok" ? 200 : 503,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
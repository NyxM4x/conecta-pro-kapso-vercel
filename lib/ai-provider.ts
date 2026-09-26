// QUÉ PROVEEDOR DE IA USA EL BOT — un solo lugar, cambiable sin tocar código.
//
// El 26 de septiembre de 2026 la cuenta de OpenAI se quedó sin crédito y el bot pasó a
// responder el texto de respaldo a todo el mundo (ver FALLBACK_ASSISTANT_TURN en el webhook).
// Para poder seguir operando mientras se recarga, el proveedor se elige por variable de
// entorno y se vuelve a OpenAI cambiando solo esa variable:
//
//   AI_PROVIDER=openai      -> OPENAI_API_KEY     + OPENAI_MODEL     (por defecto gpt-4o-mini)
//   AI_PROVIDER=openrouter  -> OPENROUTER_API_KEY + OPENROUTER_MODEL (por defecto openrouter/free)
//
// OJO CON EL ENDPOINT. `openai(id)` del SDK construye un OpenAIResponsesLanguageModel, que
// llama a /responses. OpenRouter NO implementa ese endpoint: solo /chat/completions. Por eso
// la rama de OpenRouter usa `.chat()` explícitamente. Cambiar únicamente el baseURL haría
// fallar TODAS las llamadas, y el síntoma sería el mismo que el de quedarse sin saldo.

import { createOpenAI, openai } from "@ai-sdk/openai";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
const DEFAULT_OPENROUTER_MODEL = "openrouter/free";
const DEFAULT_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";

type AiProvider = "openai" | "openrouter";
type ProviderEnv = Record<string, string | undefined>;

type AiProviderConfig = {
  provider: AiProvider;
  model: string;
  apiKeyVar: "OPENAI_API_KEY" | "OPENROUTER_API_KEY";
  apiKeyConfigured: boolean;
  baseUrl: string | null;
  // Valor de AI_PROVIDER que no se reconoció. Un typo ("openroutter") cae en OpenAI y sin
  // esto el bot se quedaría mudo sin explicación; /api/health lo expone para verlo.
  unknownValue: string | null;
};

// Pura y sin red: no construye modelos ni toca el SDK, para poder testearla.
function resolveAiProvider(env: ProviderEnv = process.env): AiProviderConfig {
  const raw = (env.AI_PROVIDER ?? "").trim().toLowerCase();
  const provider: AiProvider = raw === "openrouter" ? "openrouter" : "openai";
  const recognized = raw === "" || raw === "openai" || raw === "openrouter";

  if (provider === "openrouter") {
    return {
      provider,
      model: env.OPENROUTER_MODEL?.trim() || DEFAULT_OPENROUTER_MODEL,
      apiKeyVar: "OPENROUTER_API_KEY",
      apiKeyConfigured: Boolean(env.OPENROUTER_API_KEY),
      baseUrl: OPENROUTER_BASE_URL,
      unknownValue: null,
    };
  }

  return {
    provider,
    model: env.OPENAI_MODEL?.trim() || DEFAULT_OPENAI_MODEL,
    apiKeyVar: "OPENAI_API_KEY",
    apiKeyConfigured: Boolean(env.OPENAI_API_KEY),
    baseUrl: null,
    unknownValue: recognized ? null : raw,
  };
}

// El modelo con el que el bot genera respuestas y lee comprobantes.
function getChatModel(env: ProviderEnv = process.env) {
  const config = resolveAiProvider(env);

  if (config.provider === "openrouter") {
    return createOpenAI({
      apiKey: env.OPENROUTER_API_KEY,
      baseURL: OPENROUTER_BASE_URL,
    }).chat(config.model);
  }

  // Idéntico a lo que había antes de existir este módulo: no se cambia el comportamiento
  // de OpenAI al volver a él.
  return openai(config.model);
}

// La transcripción de audios va SIEMPRE por OpenAI, sin importar AI_PROVIDER: OpenRouter no
// tiene endpoint de transcripción (su API es solo chat-completions). Si OpenAI no tiene
// saldo, el webhook ya sabe pedirle al cliente que escriba el mensaje.
function getTranscriptionModel(env: ProviderEnv = process.env) {
  return openai.transcription(env.OPENAI_TRANSCRIBE_MODEL?.trim() || DEFAULT_TRANSCRIPTION_MODEL);
}

// Se queda sin servicio por dos motivos distintos que para el equipo son el mismo problema:
// no hay crédito, o se alcanzó el cupo diario del tier gratuito. Ambos dejan al bot
// respondiendo el texto de respaldo, así que ambos merecen la alerta a Telegram.
const AI_QUOTA_ERROR_REGEX =
  /insufficient_quota|insufficient credits|no credits remaining|more credits are required|exceeded your current quota|billing_hard_limit|billing hard limit|check your plan and billing|free-models-per-day|rate limit exceeded/i;

function isQuotaError(message: string): boolean {
  return AI_QUOTA_ERROR_REGEX.test(message);
}

// A dónde mandar al equipo a recargar, según el proveedor activo.
function getTopUpUrl(env: ProviderEnv = process.env): string {
  return resolveAiProvider(env).provider === "openrouter"
    ? "https://openrouter.ai/settings/credits"
    : "https://platform.openai.com/settings/organization/billing";
}

export {
  AI_QUOTA_ERROR_REGEX,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_OPENROUTER_MODEL,
  DEFAULT_TRANSCRIPTION_MODEL,
  OPENROUTER_BASE_URL,
  getChatModel,
  getTopUpUrl,
  getTranscriptionModel,
  isQuotaError,
  resolveAiProvider,
};
export type { AiProvider, AiProviderConfig };

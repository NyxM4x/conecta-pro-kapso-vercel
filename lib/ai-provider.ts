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

import { groq } from "@ai-sdk/groq";
import { createOpenAI, openai } from "@ai-sdk/openai";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
const DEFAULT_OPENROUTER_MODEL = "openrouter/free";
const DEFAULT_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";
const DEFAULT_GROQ_TRANSCRIPTION_MODEL = "whisper-large-v3-turbo";

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

// LA TRANSCRIPCIÓN DE AUDIOS NO DEPENDE DE AI_PROVIDER: OpenRouter no tiene endpoint de
// transcripción (su API es solo chat-completions). Tiene su propio orden de intento:
//
//   1. Groq (Whisper, cuota gratuita)  -> solo si hay GROQ_API_KEY. Modelo: GROQ_TRANSCRIBE_MODEL.
//   2. OpenAI, siempre de respaldo     -> OPENAI_API_KEY. Modelo: OPENAI_TRANSCRIBE_MODEL.
//
// Si Groq falla o se queda sin cuota, el mismo audio pasa a OpenAI. Si OpenAI tampoco puede
// (por ejemplo, sin saldo), el webhook ya sabe pedirle al cliente que escriba el mensaje.
type TranscriptionTarget = {
  provider: "groq" | "openai";
  model: string;
  apiKeyVar: "GROQ_API_KEY" | "OPENAI_API_KEY";
  apiKeyConfigured: boolean;
};

// Pura y sin red, igual que resolveAiProvider.
function resolveTranscriptionTargets(env: ProviderEnv = process.env): TranscriptionTarget[] {
  const targets: TranscriptionTarget[] = [];

  if (env.GROQ_API_KEY?.trim()) {
    targets.push({
      provider: "groq",
      model: env.GROQ_TRANSCRIBE_MODEL?.trim() || DEFAULT_GROQ_TRANSCRIPTION_MODEL,
      apiKeyVar: "GROQ_API_KEY",
      apiKeyConfigured: true,
    });
  }

  targets.push({
    provider: "openai",
    model: env.OPENAI_TRANSCRIBE_MODEL?.trim() || DEFAULT_TRANSCRIPTION_MODEL,
    apiKeyVar: "OPENAI_API_KEY",
    apiKeyConfigured: Boolean(env.OPENAI_API_KEY),
  });

  return targets;
}

function getTranscriptionModel(target: TranscriptionTarget) {
  return target.provider === "groq"
    ? groq.transcription(target.model)
    : openai.transcription(target.model);
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
  DEFAULT_GROQ_TRANSCRIPTION_MODEL,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_OPENROUTER_MODEL,
  DEFAULT_TRANSCRIPTION_MODEL,
  OPENROUTER_BASE_URL,
  getChatModel,
  getTopUpUrl,
  getTranscriptionModel,
  isQuotaError,
  resolveAiProvider,
  resolveTranscriptionTargets,
};
export type { AiProvider, AiProviderConfig, TranscriptionTarget };

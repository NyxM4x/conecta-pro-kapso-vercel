// Pruebas de la selección de proveedor de IA.
//
//   npm test            (usa el type-stripping nativo de Node, sin dependencias)
//
// Lo que se protege, por orden de gravedad si se rompe:
//
//  1. Que la rama de OpenRouter use /chat/completions y NO /responses. OpenRouter no
//     implementa /responses, así que ese error deja al bot mudo con el texto de respaldo,
//     que es exactamente el síntoma más difícil de diagnosticar (parece que el bot saluda
//     y deja de contestar).
//  2. Que volver a OpenAI sea cambiar AI_PROVIDER y nada más.
//  3. Que un typo en AI_PROVIDER no pase desapercibido.
//
// No se llama a ninguna API: construir el modelo es offline, la red recién se toca al usarlo.

import assert from "node:assert/strict";
import {
  DEFAULT_GROQ_TRANSCRIPTION_MODEL,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_OPENROUTER_MODEL,
  OPENROUTER_BASE_URL,
  getChatModel,
  getTopUpUrl,
  getTranscriptionModel,
  isQuotaError,
  resolveAiProvider,
  resolveTranscriptionTargets,
} from "./ai-provider.ts";

let passed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
  } catch (error) {
    failures.push(`${name}\n    ${(error as Error).message.split("\n")[0]}`);
  }
}

const CLAVES = { OPENAI_API_KEY: "sk-prueba", OPENROUTER_API_KEY: "sk-or-prueba" };

// --- selección ---

test("sin AI_PROVIDER usa OpenAI (el comportamiento de siempre)", () => {
  const config = resolveAiProvider({ ...CLAVES });
  assert.equal(config.provider, "openai");
  assert.equal(config.model, DEFAULT_OPENAI_MODEL);
  assert.equal(config.baseUrl, null);
});

test("AI_PROVIDER=openai usa OpenAI", () => {
  assert.equal(resolveAiProvider({ ...CLAVES, AI_PROVIDER: "openai" }).provider, "openai");
});

test("AI_PROVIDER=openrouter usa OpenRouter con su baseUrl", () => {
  const config = resolveAiProvider({ ...CLAVES, AI_PROVIDER: "openrouter" });
  assert.equal(config.provider, "openrouter");
  assert.equal(config.model, DEFAULT_OPENROUTER_MODEL);
  assert.equal(config.baseUrl, OPENROUTER_BASE_URL);
  assert.equal(config.apiKeyVar, "OPENROUTER_API_KEY");
});

test("ignora mayúsculas y espacios en AI_PROVIDER", () => {
  assert.equal(resolveAiProvider({ ...CLAVES, AI_PROVIDER: "  OpenRouter " }).provider, "openrouter");
});

test("cada proveedor toma su propia variable de modelo", () => {
  const env = { ...CLAVES, OPENAI_MODEL: "gpt-4o", OPENROUTER_MODEL: "deepseek/deepseek-chat" };
  assert.equal(resolveAiProvider({ ...env, AI_PROVIDER: "openai" }).model, "gpt-4o");
  assert.equal(resolveAiProvider({ ...env, AI_PROVIDER: "openrouter" }).model, "deepseek/deepseek-chat");
});

test("una variable de modelo vacía cae en el modelo por defecto", () => {
  assert.equal(resolveAiProvider({ ...CLAVES, OPENAI_MODEL: "   " }).model, DEFAULT_OPENAI_MODEL);
});

test("un typo en AI_PROVIDER cae en OpenAI pero queda señalado", () => {
  const config = resolveAiProvider({ ...CLAVES, AI_PROVIDER: "openroutter" });
  assert.equal(config.provider, "openai");
  assert.equal(config.unknownValue, "openroutter");
});

test("avisa si falta la clave del proveedor elegido", () => {
  const config = resolveAiProvider({ OPENAI_API_KEY: "sk-prueba", AI_PROVIDER: "openrouter" });
  assert.equal(config.apiKeyConfigured, false);
  assert.equal(config.apiKeyVar, "OPENROUTER_API_KEY");
});

// --- endpoint: la protección más importante ---

test("OpenRouter habla por /chat/completions, no por /responses", () => {
  const model = getChatModel({ ...CLAVES, AI_PROVIDER: "openrouter" });
  assert.equal(model.constructor.name, "OpenAIChatLanguageModel");
  assert.equal(model.modelId, DEFAULT_OPENROUTER_MODEL);
});

test("OpenAI sigue usando el mismo modelo que antes de este módulo", () => {
  const model = getChatModel({ ...CLAVES, AI_PROVIDER: "openai" });
  assert.equal(model.constructor.name, "OpenAIResponsesLanguageModel");
  assert.equal(model.modelId, DEFAULT_OPENAI_MODEL);
});

// --- transcripción de audios ---

test("sin clave de Groq los audios se transcriben con OpenAI aunque el proveedor sea OpenRouter", () => {
  // OpenRouter no tiene endpoint de transcripción: su API es solo chat-completions.
  const targets = resolveTranscriptionTargets({ ...CLAVES, AI_PROVIDER: "openrouter" });
  assert.deepEqual(
    targets.map((target) => target.provider),
    ["openai"],
  );
  assert.equal(getTranscriptionModel(targets[0]).provider, "openai.transcription");
});

test("con clave de Groq los audios van primero por Groq y OpenAI queda de respaldo", () => {
  const targets = resolveTranscriptionTargets({ ...CLAVES, GROQ_API_KEY: "gsk-test" });
  assert.deepEqual(
    targets.map((target) => target.provider),
    ["groq", "openai"],
  );
  assert.equal(targets[0].model, DEFAULT_GROQ_TRANSCRIPTION_MODEL);
  assert.equal(getTranscriptionModel(targets[0]).provider, "groq.transcription");
  assert.equal(getTranscriptionModel(targets[1]).provider, "openai.transcription");
});

test("una clave de Groq vacía no activa Groq", () => {
  const targets = resolveTranscriptionTargets({ ...CLAVES, GROQ_API_KEY: "   " });
  assert.deepEqual(
    targets.map((target) => target.provider),
    ["openai"],
  );
});

test("los modelos de transcripción se cambian por variable de entorno", () => {
  const targets = resolveTranscriptionTargets({
    ...CLAVES,
    GROQ_API_KEY: "gsk-test",
    GROQ_TRANSCRIBE_MODEL: " whisper-large-v3 ",
    OPENAI_TRANSCRIBE_MODEL: "gpt-4o-transcribe",
  });
  assert.deepEqual(
    targets.map((target) => target.model),
    ["whisper-large-v3", "gpt-4o-transcribe"],
  );
});

// --- errores de saldo ---

test("reconoce el error de saldo de OpenAI", () => {
  assert.equal(
    isQuotaError(
      "Failed after 3 attempts. Last error: You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.",
    ),
    true,
  );
});

test("reconoce el error de saldo de OpenRouter", () => {
  assert.equal(isQuotaError("402 Insufficient credits. More credits are required to run this request."), true);
});

test("reconoce el cupo diario agotado del tier gratuito", () => {
  assert.equal(isQuotaError("429 Rate limit exceeded: free-models-per-day"), true);
});

test("no confunde un error cualquiera con falta de saldo", () => {
  assert.equal(isQuotaError("The server had an error while processing your request"), false);
});

test("manda a recargar al proveedor que está activo", () => {
  assert.match(getTopUpUrl({ ...CLAVES, AI_PROVIDER: "openrouter" }), /openrouter\.ai/);
  assert.match(getTopUpUrl({ ...CLAVES, AI_PROVIDER: "openai" }), /platform\.openai\.com/);
});

console.log(`${passed} pruebas de proveedor de IA OK`);

if (failures.length > 0) {
  console.error(`\n${failures.length} FALLARON:`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}

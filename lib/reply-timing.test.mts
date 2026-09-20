// Pruebas de la espera antes de responder y de la guarda de repetidos.
//
//   npm test            (usa el type-stripping nativo de Node, sin dependencias)
//
// Lo que se protege: que la espera se cuente desde el mensaje del cliente (y no desde que
// arranca la función), y que solo se considere repetido un texto realmente idéntico.

import assert from "node:assert/strict";
import { canSkipAsDuplicate, computeReplyWaitMs, isSameReply, REPLY_WAIT_MS } from "./reply-timing.ts";

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

const NOW = new Date("2026-09-20T12:00:30Z");

test("descuenta el tiempo que el mensaje ya lleva esperando", () => {
  // El cliente escribió hace 30 s y la ventana es de 120 s: faltan 90 s.
  const waitMs = computeReplyWaitMs({ lastMessageAt: "2026-09-20T12:00:00Z", now: NOW, waitMs: 120_000 });
  assert.equal(waitMs, 90_000);
});

test("un mensaje viejo (reintento de Kapso) se responde sin esperar", () => {
  const waitMs = computeReplyWaitMs({ lastMessageAt: "2026-09-20T11:55:00Z", now: NOW, waitMs: 120_000 });
  assert.equal(waitMs, 0);
});

test("sin fecha, o con una fecha inválida, se espera la ventana completa", () => {
  assert.equal(computeReplyWaitMs({ lastMessageAt: null, now: NOW, waitMs: 120_000 }), 120_000);
  assert.equal(computeReplyWaitMs({ lastMessageAt: "no es una fecha", now: NOW, waitMs: 120_000 }), 120_000);
});

test("un reloj adelantado no alarga la espera", () => {
  const waitMs = computeReplyWaitMs({ lastMessageAt: "2026-09-20T12:01:00Z", now: NOW, waitMs: 120_000 });
  assert.equal(waitMs, 120_000);
});

test("la ventana por defecto son 2 minutos y nunca pasa del tope", () => {
  assert.equal(REPLY_WAIT_MS, 120_000);
  assert.ok(REPLY_WAIT_MS <= 150_000);
});

test("repetido es solo el texto idéntico (espacios y mayúsculas no cuentan)", () => {
  assert.equal(isSameReply("¡Hola! Somos ConectaPro 😊", "¡hola!  Somos ConectaPro 😊\n"), true);
  assert.equal(isSameReply("¡Hola! ¿En qué te ayudo?", "¡Hola! ¿En qué te ayudo? Tenemos cursos"), false);
  assert.equal(isSameReply("", ""), false);
  assert.equal(isSameReply("   ", "algo"), false);
});

test("solo se callan los bloques largos; una respuesta corta siempre sale", () => {
  assert.equal(canSkipAsDuplicate("¡Con gusto! 😊"), false);
  assert.equal(canSkipAsDuplicate("Sí, el curso es presencial."), false);
  assert.equal(
    canSkipAsDuplicate(
      "¡Claro! En Conecta Pro ofrecemos paquetes de grabación y edición de video para negocios 😊",
    ),
    true,
  );
});

console.log(`${passed} pruebas de tiempos de respuesta OK`);

if (failures.length > 0) {
  console.error(`\n${failures.length} FALLARON:`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}

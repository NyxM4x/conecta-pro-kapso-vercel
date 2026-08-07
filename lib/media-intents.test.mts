// Pruebas de las guardas de selección de material (lib/media-intents.ts).
//
//   npm test
//
// Cada caso simula lo que el webhook ya tiene resuelto al llegar a la guarda: el
// conjunto de intents candidatos (clasificación del LLM + redes deterministas previas)
// y el último mensaje del cliente. La guarda decide qué material sale de verdad.

import assert from "node:assert/strict";
import { asksForActivePromo, isCourseQuery, resolvePromoIntents } from "./media-intents.ts";

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

// Momentos de referencia (hora de Bolivia).
const DURANTE = new Date("2026-08-06T15:00:00-04:00");
const ULTIMO_MINUTO = new Date("2026-08-07T23:59:00-04:00");
const VENCIDA = new Date("2026-08-08T00:00:00-04:00");

const PROMO = "service_packages_promo";
const PAQUETES = "service_packages";

// Atajo: resuelve y devuelve solo los intents finales.
function resolve(
  intents: string[],
  message: string,
  now: Date,
  marks: { course?: boolean; ai?: boolean } = {},
): string[] {
  return resolvePromoIntents({
    intents,
    message,
    now,
    courseFlyerMarked: marks.course ?? false,
    aiAgentFlyerMarked: marks.ai ?? false,
  }).intents;
}

// ---------------------------------------------------------------------------
// Las siete consultas de verificación, durante la vigencia
// ---------------------------------------------------------------------------

test('"¿Tienen alguna promoción?" → solo la promo', () => {
  const message = "¿Tienen alguna promoción?";
  // El LLM marca la promo:
  assert.deepEqual(resolve([PROMO], message, DURANTE), [PROMO]);
  // El LLM marca los dos: gana la promo.
  assert.deepEqual(resolve([PAQUETES, PROMO], message, DURANTE), [PROMO]);
  // El LLM se equivoca y marca solo paquetes: se cambia por la promo.
  assert.deepEqual(resolve([PAQUETES], message, DURANTE), [PROMO]);
  // El LLM no marca nada (o falla y cae al turno de fallback): igual sale la promo.
  assert.deepEqual(resolve([], message, DURANTE), [PROMO]);
});

test('"Quiero la promo de 1000" → solo la promo', () => {
  const message = "Quiero la promo de 1000";
  assert.deepEqual(resolve([PROMO], message, DURANTE), [PROMO]);
  assert.deepEqual(resolve([PAQUETES], message, DURANTE), [PROMO]);
  assert.deepEqual(resolve([PAQUETES, PROMO], message, DURANTE), [PROMO]);
  assert.deepEqual(resolve([], message, DURANTE), [PROMO]);
});

test('"Quiero los 4 videos" → solo la promo (no es cantidad fuera de catálogo)', () => {
  const message = "Quiero los 4 videos";
  assert.deepEqual(resolve([PROMO], message, DURANTE), [PROMO]);
  // Caso real: la red de intake fuerza paquetes cuando ya se presentaron. Igual sale
  // la imagen de la promo, que es lo que el cliente pidió.
  assert.deepEqual(resolve([PAQUETES], message, DURANTE), [PROMO]);
  assert.deepEqual(resolve([], message, DURANTE), [PROMO]);
});

test("pedir la promo dentro de un flujo de otra línea no agrega la promo", () => {
  // "¿tienen promo?" con el QR del curso ya en juego: manda el flujo de pago.
  assert.deepEqual(resolve(["payment_qr"], "¿tienen promo?", DURANTE), ["payment_qr"]);
  assert.deepEqual(resolve(["course_flyer"], "¿tienen promo?", DURANTE, { course: true }), [
    "course_flyer",
  ]);
});

test('"¿Qué paquetes tienen?" → solo el flyer normal de paquetes', () => {
  const message = "¿Qué paquetes tienen?";
  assert.deepEqual(resolve([PAQUETES], message, DURANTE), [PAQUETES]);
  // Aunque el LLM marque los dos, gana el embudo principal: la promo no lo reemplaza.
  assert.deepEqual(resolve([PAQUETES, PROMO], message, DURANTE), [PAQUETES]);
});

test('"Quiero creación de contenido" → flyer normal de paquetes, no la promo', () => {
  const message = "Quiero creación de contenido";
  assert.deepEqual(resolve([PAQUETES], message, DURANTE), [PAQUETES]);
  assert.deepEqual(resolve([PAQUETES, PROMO], message, DURANTE), [PAQUETES]);
});

test('"Quiero pagar el curso de creación de contenido" → QR intacto, sin promo', () => {
  const message = "Quiero pagar el curso de creación de contenido";
  assert.deepEqual(resolve(["payment_qr"], message, DURANTE), ["payment_qr"]);
  // Si el LLM colara la promo en un turno de curso, se descarta y el QR sobrevive.
  assert.deepEqual(resolve(["payment_qr", PROMO], message, DURANTE), ["payment_qr"]);
});

test('"¿Tienen alguna promoción de cursos?" → nunca la promo de servicios', () => {
  const message = "¿Tienen alguna promoción de cursos?";
  assert.deepEqual(resolve([PROMO], message, DURANTE), []);
  assert.deepEqual(resolve(["course_flyer", PROMO], message, DURANTE), ["course_flyer"]);
  // Y no se cambia el flyer de paquetes por la promo en una consulta de cursos.
  assert.deepEqual(resolve([PAQUETES], message, DURANTE), [PAQUETES]);
});

// ---------------------------------------------------------------------------
// Vencimiento: desde el 8 de agosto ninguna consulta manda la promo
// ---------------------------------------------------------------------------

test("vencida: ninguna de las consultas de promo la envía", () => {
  for (const message of [
    "¿Tienen alguna promoción?",
    "Quiero la promo de 1000",
    "Quiero los 4 videos",
    "quiero la promo por bolivia",
  ]) {
    assert.deepEqual(resolve([PROMO], message, VENCIDA), [], message);
    assert.deepEqual(resolve([PAQUETES], message, VENCIDA), [PAQUETES], message);
    assert.deepEqual(resolve([PAQUETES, PROMO], message, VENCIDA), [PAQUETES], message);
    // Y tampoco se agrega desde cero.
    assert.deepEqual(resolve([], message, VENCIDA), [], message);
  }
});

test('"¿Qué paquetes tienen?" nunca agrega la promo desde cero', () => {
  assert.deepEqual(resolve([], "¿Qué paquetes tienen?", DURANTE), []);
  assert.deepEqual(resolve([], "Quiero creación de contenido", DURANTE), []);
});

test("último minuto de vigencia: la promo todavía sale", () => {
  assert.deepEqual(resolve([PROMO], "¿tienen promoción?", ULTIMO_MINUTO), [PROMO]);
});

test("vencida: el flyer de paquetes nunca se cambia por la promo", () => {
  assert.deepEqual(resolve([PAQUETES], "¿tienen alguna oferta?", VENCIDA), [PAQUETES]);
});

// ---------------------------------------------------------------------------
// Exclusividad con las otras dos líneas
// ---------------------------------------------------------------------------

test("la promo no sale si el turno también trae flyer de cursos", () => {
  assert.deepEqual(
    resolve([PROMO, "course_flyer"], "quiero promo", DURANTE, { course: true }),
    ["course_flyer"],
  );
});

test("la promo no sale si el turno también trae el flyer del agente de IA", () => {
  assert.deepEqual(
    resolve([PROMO, "ai_agent_flyer"], "quiero promo", DURANTE, { ai: true }),
    ["ai_agent_flyer"],
  );
});

test("promo y paquetes nunca conviven, elija quien elija", () => {
  for (const message of ["¿tienen promo?", "¿qué paquetes tienen?", "hola"]) {
    const result = resolve([PAQUETES, PROMO], message, DURANTE);
    assert.equal(result.length, 1, message);
  }
});

// ---------------------------------------------------------------------------
// Materiales ajenos: la guarda no toca nada más
// ---------------------------------------------------------------------------

test("sin promo en juego, el conjunto de intents queda idéntico", () => {
  const intents = ["course_flyer", "location_video", "payment_qr"];
  assert.deepEqual(resolve(intents, "¿dónde es el curso?", DURANTE), intents);
  assert.deepEqual(resolve(intents, "¿dónde es el curso?", VENCIDA), intents);
});

test("el QR y el video de ubicación sobreviven a un turno de promo", () => {
  assert.deepEqual(resolve([PROMO, "location_video"], "quiero la promo", DURANTE), [
    PROMO,
    "location_video",
  ]);
});

// ---------------------------------------------------------------------------
// Detectores auxiliares
// ---------------------------------------------------------------------------

test("asksForActivePromo reconoce las tres formas de pedir la promo", () => {
  assert.equal(asksForActivePromo("¿hay alguna oferta?", DURANTE), true);
  assert.equal(asksForActivePromo("dame el descuento", DURANTE), true);
  assert.equal(asksForActivePromo("el paquete de 1.000 bs", DURANTE), true);
  assert.equal(asksForActivePromo("quiero 4 videos", DURANTE), true);
});

test("asksForActivePromo NO se dispara con un 4 suelto ni con precios de paquetes", () => {
  assert.equal(asksForActivePromo("puedo a las 4", DURANTE), false);
  assert.equal(asksForActivePromo("tengo 4 sucursales", DURANTE), false);
  assert.equal(asksForActivePromo("el de 2500", DURANTE), false);
  assert.equal(asksForActivePromo("quiero 6 videos", DURANTE), false);
});

test("asksForActivePromo es false fuera de la ventana", () => {
  assert.equal(asksForActivePromo("¿tienen promoción?", VENCIDA), false);
  assert.equal(asksForActivePromo("quiero 4 videos", VENCIDA), false);
});

test("isCourseQuery distingue cursos de servicios", () => {
  assert.equal(isCourseQuery("¿tienen promoción de cursos?"), true);
  assert.equal(isCourseQuery("¿hay promo del curso de capcut?"), true);
  // Menciona "contenido" (palabra de servicios) pero es un curso: manda la línea A.
  assert.equal(isCourseQuery("quiero pagar el curso de creación de contenido"), true);
  assert.equal(isCourseQuery("¿tienen promoción?"), false);
  assert.equal(isCourseQuery("quiero grabación de videos"), false);
});

console.log(`${passed} pruebas de guardas OK`);

if (failures.length > 0) {
  console.error(`\n${failures.length} FALLARON:`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}

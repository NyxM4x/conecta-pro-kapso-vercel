// Pruebas de las guardas de selección de material (lib/media-intents.ts).
//
//   npm test
//
// Cada caso simula lo que el webhook ya tiene resuelto al llegar a la guarda: el
// conjunto de intents candidatos (clasificación del LLM + redes deterministas previas)
// y el último mensaje del cliente. La guarda decide qué material sale de verdad.

import assert from "node:assert/strict";
import {
  MEDIA_RESEND_WINDOW_HOURS,
  asksForActivePromo,
  isCourseQuery,
  resolvePromoIntents,
  shouldResendMedia,
} from "./media-intents.ts";
import {
  COURSE_KEYWORDS,
  SERVICE_PACKAGES_KEYWORDS,
  containsExactNumber,
  normalizeForMatch,
} from "./keywords.ts";

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

// ---------------------------------------------------------------------------
// Ventana de reenvío del flyer de paquetes (anti-spam)
// ---------------------------------------------------------------------------

const AHORA = new Date("2026-08-14T13:44:00-04:00");
const horasAntes = (hours: number) =>
  new Date(AHORA.getTime() - hours * 3_600_000);

test("nunca enviado: el flyer de paquetes sale", () => {
  const decision = shouldResendMedia({ intent: PAQUETES, lastSentAt: null, now: AHORA });
  assert.equal(decision.send, true);
  assert.equal(decision.reason, "never_sent");
});

test("dentro de las 24h: no se reenvía (caso del formulario)", () => {
  // El cliente recibió el flyer a las 13:42 y a las 13:43 manda sus datos.
  const reciente = shouldResendMedia({
    intent: PAQUETES,
    lastSentAt: horasAntes(1 / 60),
    now: AHORA,
  });
  assert.equal(reciente.send, false);
  assert.equal(reciente.reason, "within_window");

  assert.equal(
    shouldResendMedia({ intent: PAQUETES, lastSentAt: horasAntes(1), now: AHORA }).send,
    false,
  );
  // Justo en el borde: 23:59h todavía dentro.
  assert.equal(
    shouldResendMedia({ intent: PAQUETES, lastSentAt: horasAntes(23.9), now: AHORA }).send,
    false,
  );
});

test("pasadas 24h: el flyer vuelve a salir (precios nuevos)", () => {
  const exacto = shouldResendMedia({
    intent: PAQUETES,
    lastSentAt: horasAntes(24),
    now: AHORA,
  });
  assert.equal(exacto.send, true);
  assert.equal(exacto.reason, "window_expired");

  // Vuelve a la semana: igual lo recibe.
  assert.equal(
    shouldResendMedia({ intent: PAQUETES, lastSentAt: horasAntes(24 * 7), now: AHORA }).send,
    true,
  );
});

test("force (reenvío pedido explícitamente) ignora la ventana", () => {
  const decision = shouldResendMedia({
    intent: PAQUETES,
    lastSentAt: horasAntes(0.5),
    now: AHORA,
    force: true,
  });
  assert.equal(decision.send, true);
  assert.equal(decision.reason, "forced");
});

test("intents sin ventana conservan el dedup permanente", () => {
  for (const intent of ["payment_qr", "course_flyer", PROMO, "ai_agent_flyer"]) {
    assert.equal(MEDIA_RESEND_WINDOW_HOURS[intent], undefined, intent);
    const decision = shouldResendMedia({
      intent,
      lastSentAt: horasAntes(24 * 30),
      now: AHORA,
    });
    assert.equal(decision.send, false, intent);
    assert.equal(decision.reason, "already_sent", intent);
    // Pero nunca enviado sí sale.
    assert.equal(
      shouldResendMedia({ intent, lastSentAt: null, now: AHORA }).send,
      true,
      intent,
    );
  }
});

test("timestamp futuro (reloj corrido) se trata como envío reciente", () => {
  assert.equal(
    shouldResendMedia({ intent: PAQUETES, lastSentAt: horasAntes(-5), now: AHORA }).send,
    false,
  );
});

// --- Solapamiento de keywords entre cursos y paquetes -----------------------
//
// Origen del bug real: los dos cursos se llaman "creación de CONTENIDO" y "EDICIÓN en
// CapCut", y esas tres palabras (CONTENIDO, EDICION, VIDEOS) están en
// SERVICE_PACKAGES_KEYWORDS. Por eso "quiero el curso de creación de contenido" pasaba
// por intención explícita de paquetes y le llegaba el formulario de datos de empresa.
// hasExplicitPackageIntent (en el webhook) exige ahora una señal FUERTE de paquete
// cuando el mensaje nombra un curso; estas pruebas fijan el solapamiento que lo motiva
// y qué señales son las fuertes.

test("las palabras de los nombres de los cursos SÍ están en las de paquetes", () => {
  // Si esto deja de ser cierto, la guarda de cursos de hasExplicitPackageIntent podría
  // ya no hacer falta — pero mientras siga siendo cierto, es imprescindible.
  for (const palabra of ["contenido", "edicion", "videos"]) {
    assert.equal(SERVICE_PACKAGES_KEYWORDS.test(normalizeForMatch(palabra)), true, palabra);
  }
});

test("los mensajes de cursos que disparaban el bug se reconocen como cursos", () => {
  for (const mensaje of [
    "quiero el curso de creación de contenido",
    "me interesa el de edición en CapCut",
    "info del taller de contenido",
  ]) {
    assert.equal(COURSE_KEYWORDS.test(normalizeForMatch(mensaje)), true, mensaje);
    // Y son justo los que la regex de paquetes también atrapaba.
    assert.equal(
      SERVICE_PACKAGES_KEYWORDS.test(normalizeForMatch(mensaje)),
      true,
      mensaje,
    );
  }
});

test("señal fuerte de paquete: 'paquete', 6/12/18 y 2500/3500/5500", () => {
  const fuerte = (texto: string) => {
    const normalizado = normalizeForMatch(texto);
    return (
      /\bPAQUETE(S)?\b/.test(normalizado) ||
      containsExactNumber(normalizado, [6, 12, 18]) ||
      containsExactNumber(normalizado, [2500, 3500, 5500])
    );
  };

  // Un cliente de cursos no produce estas por accidente.
  assert.equal(fuerte("hice el curso, ahora quiero un paquete"), true);
  assert.equal(fuerte("quiero el paquete de 12"), true);
  assert.equal(fuerte("el de 3500"), true);

  // Estas son las que antes bastaban y ya no deben bastar.
  assert.equal(fuerte("quiero el curso de creación de contenido"), false);
  assert.equal(fuerte("me interesa el de edición en CapCut"), false);
});

console.log(`${passed} pruebas de guardas OK`);

if (failures.length > 0) {
  console.error(`\n${failures.length} FALLARON:`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}

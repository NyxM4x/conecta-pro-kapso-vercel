// Pruebas de los detectores deterministas de vocabulario.
//
//   npm test            (usa el type-stripping nativo de Node, sin dependencias)
//
// Cubre los dos detectores cuyo falso positivo tiene costo real para el cliente:
// la promo VENCIDA de edición por 50 Bs (confirmar ese precio es prometer algo que
// no existe) y los enlaces entrantes (pedir contexto cuando el mensaje ya era claro
// gasta un mensaje de Meta y molesta al cliente).

import assert from "node:assert/strict";
import {
  containsIncomingLink,
  mentionsExpiredEditPromo,
  mentionsPriorAgreement,
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

// --- Acuerdo previo con el equipo -------------------------------------------
//
// Cada falso positivo aquí apaga el bot durante horas en un chat que quizá solo pedía
// información, así que el detector tiene que ser estrecho: los "no" importan tanto
// como los "sí".

test("reconoce al cliente que dice tener algo ya acordado con el equipo", () => {
  const frases = [
    "Ayer quedamos en 80 bolivianos por video",
    "quedamos en 2000 al mes",
    "ya hablé con el asesor",
    "hablé con su asesor la semana pasada",
    "me dio el ok",
    "me dieron el ok ayer",
    "ya está acordado con ustedes",
    "me dijeron que el precio era otro",
    "me pasaron un precio de 1500",
    "coordiné con el encargado",
  ];

  for (const frase of frases) {
    assert.equal(mentionsPriorAgreement(frase), true, frase);
  }
});

test("no confunde una conversación normal con un acuerdo previo", () => {
  const frases = [
    "quedamos en que me escribes mañana",
    "quedamos el martes",
    "hablé con mi socio y queremos el de 12",
    "hola, quiero información de los paquetes",
    "quiero 12 videos",
    "cuánto cuesta el curso",
    "me interesa el básico",
    "necesito hablar con alguien",
  ];

  for (const frase of frases) {
    assert.equal(mentionsPriorAgreement(frase), false, frase);
  }
});

test("un acuerdo sin cifra no alcanza para apagar el bot", () => {
  assert.equal(mentionsPriorAgreement("quedamos en eso entonces"), false);
  assert.equal(mentionsPriorAgreement("quedamos en 80 bs por video"), true);
});

// --- Promo de edición por 50 Bs (vencida) -----------------------------------

test("reconoce al cliente que llega por el video de la promo de 50", () => {
  const frases = [
    "¿siguen con la promo de 50?",
    "vi el video de edición a 50 bs",
    "la oferta de 50 bolivianos todavía está?",
    "hola, es cierto lo de la promoción de 50?",
    "edicion 50",
    "PROMO DE 50 BS SIGUE?",
    "vi tu publicación de los 50 Bs",
  ];

  for (const frase of frases) {
    assert.equal(mentionsExpiredEditPromo(frase), true, frase);
  }
});

test("los acentos no cambian la detección", () => {
  assert.equal(mentionsExpiredEditPromo("la promoción de edición a 50 Bs"), true);
  assert.equal(mentionsExpiredEditPromo("la promocion de edicion a 50 Bs"), true);
});

test("los precios de los paquetes NO son la promo de 50", () => {
  // containsExactNumber evita que el 50 de 2500/3500/5500 dispare el flujo.
  assert.equal(mentionsExpiredEditPromo("el paquete de 2500 Bs"), false);
  assert.equal(mentionsExpiredEditPromo("cuánto es, 3500 o 5500?"), false);
  assert.equal(mentionsExpiredEditPromo("promo de videos por 2500"), false);
});

test("un descuento del 50% no es la promo de edición", () => {
  assert.equal(mentionsExpiredEditPromo("me dijeron que hay 50% de descuento"), false);
  assert.equal(mentionsExpiredEditPromo("la promo del 50%"), false);
});

test("un 50 que es cantidad, no monto, no dispara el flujo", () => {
  assert.equal(mentionsExpiredEditPromo("quiero 50 videos para mi tienda"), false);
  assert.equal(mentionsExpiredEditPromo("tenemos 50 clientes al día"), false);
});

test("un 50 sin ningún contexto de promo ni edición no dispara el flujo", () => {
  assert.equal(mentionsExpiredEditPromo("mi local está en el km 50"), false);
  assert.equal(mentionsExpiredEditPromo("somos 50"), false);
});

test("un mensaje sin el número 50 nunca es esta promo", () => {
  assert.equal(mentionsExpiredEditPromo("me pueden editar un video?"), false);
  assert.equal(mentionsExpiredEditPromo("hola"), false);
  assert.equal(mentionsExpiredEditPromo(""), false);
});

// --- Enlaces entrantes ------------------------------------------------------

test("detecta los enlaces que el cliente manda de verdad", () => {
  const enlaces = [
    "https://www.tiktok.com/@marketero7",
    "http://ejemplo.bo/catalogo",
    "mira esto www.mitienda.com",
    "te paso mi perfil: instagram.com/mi_negocio",
    "HTTPS://EJEMPLO.COM/ALGO",
    "esto https://vm.tiktok.com/ZM123/ es mi video",
  ];

  for (const enlace of enlaces) {
    assert.equal(containsIncomingLink(enlace), true, enlace);
  }
});

test("un punto de puntuación no se confunde con un dominio", () => {
  assert.equal(containsIncomingLink("listo. ok gracias"), false);
  assert.equal(containsIncomingLink("perfecto.entonces mañana"), false);
  assert.equal(containsIncomingLink("quiero el paquete de 12 videos."), false);
});

test("un texto normal no trae enlaces", () => {
  assert.equal(containsIncomingLink("hola, cuánto cuesta el curso?"), false);
  assert.equal(containsIncomingLink("mi correo es juan arroba gmail"), false);
  assert.equal(containsIncomingLink(""), false);
});

console.log(`${passed} pruebas OK`);

if (failures.length > 0) {
  console.error(`\n${failures.length} FALLARON:`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}

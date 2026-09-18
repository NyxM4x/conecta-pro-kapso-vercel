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
  detectEditingRequest,
  hasBusinessVocabulary,
  mentionsExpiredEditPromo,
  mentionsOfficeVisit,
  detectOfficeVisit,
  mentionsRecruitment,
  mentionsPriorAgreement,
  normalizeForMatch,
  COURSE_KEYWORDS,
  SERVICE_PACKAGES_KEYWORDS,
  detectCoursePaymentRequest,
  mentionsCourse,
  isClosingThanksOnly,
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

// --- Publicidad y manejo de redes son paquetes -----------------------------
//
// Frases tomadas tal cual de chats reales (ago–sep 2026) que el bot dejó sin flyer o sin
// respuesta.

test("la publicidad, el marketing y el manejo de redes cuentan como paquetes", () => {
  const frases = [
    "Buenas noches disculpe una consulta cuanto cobran por publicidad??",
    "Servicios de marketing",
    "Me puede enviar los planes de publicidad",
    "Realizan Manejo de Redes Sociales para negocios",
    "Quisiera q me puedan promocionar mi negocio",
    "Necesito una empresa de marketing para mi negocio",
    "busco un community manager",
    "que manejen mis redes",
    "Quería saber los precios de marketing, publicidad, para una venta de repuesto",
  ];

  for (const frase of frases) {
    assert.equal(SERVICE_PACKAGES_KEYWORDS.test(normalizeForMatch(frase)), true, frase);
  }
});

test("'vi su anuncio' no dice de qué línea viene", () => {
  assert.equal(SERVICE_PACKAGES_KEYWORDS.test(normalizeForMatch("Vi un anuncio en tik tok")), false);
});

test("pedir capacitación en marketing sigue siendo un curso", () => {
  const frase = "Quiero capacitarme sobre como realizar marketing en tiktok";
  assert.equal(COURSE_KEYWORDS.test(normalizeForMatch(frase)), true);
});

// --- Visita a la oficina ----------------------------------------------------

test("reconoce al cliente que quiere visitarnos o reunirse en persona", () => {
  const frases = [
    "Mañana ire a visitarlos",
    "Quiero reunirme con usted para ver sobre las propuesta",
    "Quiero hacer una cita",
    "puedo pasar por su oficina mañana?",
    "me gustaría una reunión presencial",
    "a donde me puedo apersonar",
    "voy a ir a la oficina el lunes",
  ];

  for (const frase of frases) {
    assert.equal(mentionsOfficeVisit(frase), true, frase);
  }
});

test("preguntar solo dónde queda la oficina no es pedir una reunión", () => {
  assert.equal(mentionsOfficeVisit("¿dónde queda su oficina?"), false);
  assert.equal(mentionsOfficeVisit("pásame la ubicación de la oficina"), false);
  assert.equal(mentionsOfficeVisit("qué horario tienen"), false);
});

test("negar la visita, pedirla virtual o buscar trabajo no es una visita", () => {
  assert.equal(mentionsOfficeVisit("No, no puedo ir yo a su oficina"), false);
  assert.equal(mentionsOfficeVisit("a las 16:00 podríamos reunirnos de forma virtual o por llamada"), false);
  assert.equal(mentionsOfficeVisit("cómo puedo formar parte de su equipo o a donde me puedo apersonar"), false);
  // Un cliente empresa que habla de SUS propias oficinas.
  assert.equal(mentionsOfficeVisit("le escribo para coordinar una reunión en nuestras oficinas"), false);
});

test("la ubicación del curso nunca es una visita a la oficina", () => {
  assert.equal(mentionsOfficeVisit("voy a ir al curso, ¿es en la oficina?"), false);
  assert.equal(detectOfficeVisit("¿dónde es el curso? ¿puedo ir a su oficina?"), null);
});

test("quien quiere visitarnos por un curso no recibe el formulario de negocio", () => {
  assert.equal(detectOfficeVisit("¿puedo pasar por su oficina a pagar el curso?"), "course");
  assert.equal(detectOfficeVisit("quiero visitarlos para ver lo del curso de capcut"), "course");
  assert.equal(detectOfficeVisit("quiero visitarlos para ver lo de la publicidad"), "business");
});

// --- Reclutamiento ----------------------------------------------------------

test("reconoce a quien busca trabajo (frases reales)", () => {
  const frases = [
    "Buenas tardes me salió un video que estaban buscando modelos para crear contenido",
    "Siguen buscando chica",
    "Holaa Sigue disponible el trabajo",
    "Muy Buenos días cómo puedo formar parte de su equipo",
    "Hola buenos días quisiera saber, cuáles son los requisitos para ser modelo",
    "Aun están buscando personas?",
    "Buenas tardes de casualidad necesitan azafata para la fexpocruz?",
    "Quería preguntarle si sigue disponible para que yo pueda trabajar como influencer",
    "Hay dice que hay vacantes disponibles",
  ];

  for (const frase of frases) {
    assert.equal(mentionsRecruitment(frase), true, frase);
  }
});

test("un cliente que pregunta por modelos en SUS videos no es reclutamiento", () => {
  assert.equal(mentionsRecruitment("¿sale un modelo en los videos o tengo que salir yo?"), false);
  assert.equal(mentionsRecruitment("Quiero trabajar con ustedes"), false);
  // Cliente que quiere un video para SU convocatoria de personal.
  assert.equal(
    mentionsRecruitment("quisiera comenzar un video buscando personal y luego el otro para la inaguracion"),
    false,
  );
  assert.equal(mentionsRecruitment("quiero publicidad para mi negocio"), false);
});

// --- Edición ambigua --------------------------------------------------------

test("edición sin más contexto es ambigua: hay que preguntar", () => {
  const frases = [
    "Edición de video",
    "Edición !!",
    "Buenas tardes Disculpe precio de la edición de video",
    "Necesito edición para tik tok",
    "Editan videos vi su publicación en tik tok",
    "Me interesa su edición",
    "Cuánto me cobra editar un vídeo",
  ];

  for (const frase of frases) {
    assert.equal(detectEditingRequest(frase), "ambiguous", frase);
  }
});

test("quien ya tiene sus videos quiere solo edición", () => {
  const frases = [
    "Quiero que me editen mis videos",
    "solo necesito edición",
    "ya tengo los videos grabados, solo quiero que me los editen",
    "Solo necesito edicion soy del interior",
    "tengo un video que quiero editar, me ayudan?",
    "no necesito grabación, solo edición",
    "Imagino que solo es enviar un vídeo en bruto, para que solo le hagan edición",
    "Lo q me interesa es solamente la edición",
    "Y solo ediciones",
    "Si yo me grabo en mi casa solo hablando cualquier cosa y edición quiero nomás",
    "Quería saber si editan clip de free fire",
  ];

  for (const frase of frases) {
    assert.equal(detectEditingRequest(frase), "editing_only", frase);
  }
});

test("grabación + edición o publicidad es un paquete", () => {
  assert.equal(detectEditingRequest("Los paquetes de edición y grabación desde que precios tiene?"), "packages");
  assert.equal(detectEditingRequest("Queria informacion servicio de grabacion y edicion de video para mi negocio"), "packages");
  assert.equal(detectEditingRequest("Busco alguien q me grave los videos y me los edite"), "packages");
});

test("'paquetes de edición' sigue sin decir si ya tiene los videos", () => {
  assert.equal(detectEditingRequest("Me interesa saber paquetes de edición"), "ambiguous");
});

test("el curso de edición en CapCut no pasa por este detector", () => {
  assert.equal(detectEditingRequest("cuando tendra de nuevo el curso de edicion de capcut"), null);
  assert.equal(detectEditingRequest("hola, quiero información"), null);
});

test("'edición persuasiva' es el curso de CapCut aunque no diga curso", () => {
  assert.equal(detectEditingRequest("quiero info de la edición persuasiva"), null);
  assert.equal(COURSE_KEYWORDS.test(normalizeForMatch("info de la edición persuasiva")), true);
});

// --- Vocabulario del negocio contra el silencio por "fuera de tema" --------

test("una consulta del negocio nunca se silencia como fuera de tema", () => {
  const frases = [
    "Me puede brindar más información sobre los precio de publicidad",
    "Qeria saber información",
    "Que servicio brindan?",
    "Mas información sobre los cursos de editar videos",
    "Le escribo por las ediciones de video",
    "Buen di yo pague no estoy en el curso",
    "Ya Ise mi cancelación",
  ];

  for (const frase of frases) {
    assert.equal(hasBusinessVocabulary(frase), true, frase);
  }
});

test("reclutamiento, charla y difusiones largas no fuerzan respuesta", () => {
  assert.equal(hasBusinessVocabulary("Quería saber sobre las modelos para sus redes sociales"), false);
  assert.equal(hasBusinessVocabulary("Siguen buscando personas para crear contenido?"), false);
  assert.equal(hasBusinessVocabulary("Mielda toy viendo las imgs en el gym"), false);
  const difusion =
    "🐾 Hola somos HuelliHogar, queremos contarte de nuestros servicios de guardería para tu mascota con juegos, baño, corte de pelo, transporte puerta a puerta, veterinario de confianza y muchas sorpresas más para que tu perrito la pase increíble mientras tú trabajas tranquilo todo el día";
  assert.equal(hasBusinessVocabulary(difusion), false);
});

// --- Pedido de pago de un curso (red del QR) ---------------------------------
//
// Mensajes reales de septiembre 2026 que no recibieron el QR.

test("pide el QR con todas las letras → qr_request", () => {
  for (const mensaje of [
    "Me pasa su QR por favor",
    "Si esta bien me pasa su qr",
    "Claro que si me puede facilitar su QR x favor",
    "Qr por favor",
    "El qr porfavor",
    "Mande Qr",
    "Páseme QR para los cursos de edición de video",
    "pásame el QR",
    "QR",
    "Buenas\nel qr?",
    "no me llegó el QR",
  ]) {
    assert.equal(detectCoursePaymentRequest(mensaje), "qr_request", mensaje);
  }
});

test("quiere pagar o reservar → pay_intent", () => {
  for (const mensaje of [
    "Quiero comprar mi entrada",
    "quiero pagar mi entrada",
    "quiero pagar mi boleto",
    "quiero pagar mi curso",
    "quiero reservar mi curso",
    "reservar mi curso",
    "Quiero dos cupo para el curso",
    "Me quiero inscribir",
    "quiero inscribirme",
    "Quiero pagar",
    "cómo hago para pagar la preventa",
    "¿cómo pago?",
    "quiero asegurar mi cupo",
  ]) {
    assert.equal(detectCoursePaymentRequest(mensaje), "pay_intent", mensaje);
  }
});

test("ya pagó, paga en la puerta o solo pregunta → sin pedido", () => {
  for (const mensaje of [
    "ya pagué mi entrada",
    "Buen di yo pague no estoy en el curso",
    "te mando el comprobante",
    "ya te mandé el qr pagado",
    "voy a pagar en la puerta",
    "¿aceptan QR?",
    "¿Se puede pagar por qr?",
    "¿cuánto cuesta el curso?",
    "me interesa el paquete de 12 videos",
  ]) {
    assert.equal(detectCoursePaymentRequest(mensaje), null, mensaje);
  }
});

test("'pásame el QR para que te pague' sigue siendo un pedido", () => {
  assert.equal(detectCoursePaymentRequest("pásame el QR para que te pague"), "qr_request");
});

test("mentionsCourse: el curso o la compra de su entrada", () => {
  assert.equal(mentionsCourse("Quiero comprar mi entrada"), true);
  assert.equal(mentionsCourse("Me interesa curso"), true);
  assert.equal(mentionsCourse("Quiero dos cupo"), true);
  assert.equal(mentionsCourse("me interesa el paquete pro"), false);
  assert.equal(mentionsCourse("quiero publicidad para mi negocio"), false);
});

test("isClosingThanksOnly: un cierre seco no puede leerse como primer contacto", () => {
  for (const mensaje of [
    "ya, gracias",
    "Ya gracias",
    "ok gracias",
    "listo, gracias",
    "muchas gracias",
    "muchas gracias por la información",
    "aya gracias",
    "gracias 🙏",
    "Gracias!!",
    "mil gracias, muy amable",
    "ok listo gracias bendiciones",
  ]) {
    assert.equal(isClosingThanksOnly(mensaje), true, mensaje);
  }
});

test("isClosingThanksOnly: si trae cualquier otra cosa, NO es un cierre", () => {
  for (const mensaje of [
    "gracias, ¿pueden venir hasta el trópico?",
    "gracias pero yo soy del trópico",
    "gracias, quiero el paquete de 12",
    "gracias, me pasas el QR",
    "hola",
    "ya",
    "ok",
    "listo",
    "gracias por el dato, cuándo es el curso",
    "",
  ]) {
    assert.equal(isClosingThanksOnly(mensaje), false, mensaje);
  }
});

console.log(`${passed} pruebas OK`);

if (failures.length > 0) {
  console.error(`\n${failures.length} FALLARON:`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}

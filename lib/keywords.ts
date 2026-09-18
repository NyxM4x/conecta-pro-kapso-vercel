// Normalización de texto y vocabulario de cada línea de negocio.
//
// Vivían dentro del route handler del webhook, que no es importable desde una prueba
// (arrastra el SDK de Kapso, Supabase y OpenAI). Se movieron aquí SIN cambiar su
// comportamiento, para que la resolución de intents (lib/media-intents.ts) pueda
// probarse en aislamiento. route.ts las sigue usando exactamente igual.

// Quita acentos/diacríticos y pasa a mayúsculas, para que las regex de
// detección no dependan de cómo el usuario tildó las palabras (é/e, ó/o, etc.).
function normalizeForMatch(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase();
}

// Devuelve true si el texto contiene alguno de los números EXACTOS buscados como
// grupo de dígitos completo (no como subcadena de otro número). Ej: buscar 2500 en
// "25000" o "14000" da false; en "2500bs" o "2.500 bs" da true. Tolera separadores
// de miles (2.500 / 2,500) quitándolos antes de tokenizar.
function containsExactNumber(text: string, values: number[]): boolean {
  const cleaned = text.replace(/(\d)[.,](\d)/g, "$1$2");
  const groups: string[] = cleaned.match(/\d+/g) ?? [];
  return values.some((value) => groups.includes(String(value)));
}

// Palabras que denotan intención de cada línea, para suprimir el saludo genérico
// cuando el primer mensaje ya trae contexto claro (ahorro de mensajes).
//
// Los paquetes incluyen también el vocabulario con el que los clientes piden
// "publicidad": en un mes de conversaciones reales (ago–sep 2026) llegaron "¿cuánto
// cobran por publicidad?", "servicios de marketing", "planes de publicidad", "manejo de
// redes sociales para negocios" o "quisiera que me promocionen mi negocio", y el bot los
// dejaba sin respuesta. Conecta Pro los atiende con los paquetes (grabación, guiones,
// edición y publicación), así que cuentan como intención de paquetes.
// "Anuncio" NO está a propósito: casi siempre es "vi su anuncio", que no dice de qué línea.
const SERVICE_PACKAGES_KEYWORDS =
  /\b(PAQUETE|PAQUETES|GRABACION|GRABACIONES|EDICION|SERVICIO|SERVICIOS|VIDEOS|PRODUCCION|CONTENIDO|DRON|PUBLICIDAD|PUBLICIDADES|PUBLICITAR|PUBLICITARIO|PUBLICITARIOS|PUBLICITARIA|PUBLICITARIAS|MARKETING|MERCADEO|PROMOCIONAR|PROMOCIONEN|PROMOCIONE|COMMUNITY|SPOT|SPOTS|MANEJO\s+DE\s+(MIS\s+|LAS\s+)?REDES|MANEJEN\s+(MIS|LAS)\s+REDES|ADMINISTR\w*\s+(DE\s+)?(MIS\s+|LAS\s+)?REDES)\b/;
// PERSUASIVA: el curso de CapCut se anuncia como "Edición Persuasiva", y sin esta palabra
// "info de la edición persuasiva" caía en la pregunta de paquetes o solo edición.
const COURSE_KEYWORDS =
  /\b(CURSO|CURSOS|TALLER|TALLERES|CAPACITACION|CAPACITARME|FORMACION|APRENDER|CAPCUT|CLASE|CLASES|PERSUASIVA)\b/;
// Todo lo que gira en torno a la OFICINA: ubicación, horario, visitas y reuniones. Ya no
// existe un flujo de "cita" con día y hora (ver mentionsOfficeVisit), pero estas palabras
// siguen sirviendo para separar la oficina del lugar de los cursos.
const APPOINTMENT_KEYWORDS =
  /\b(CITA|VISITA|VISITAR|VISITARLOS|VISITARLES|OFICINA|OFICINAS|AGENDAR|UBICACION|DIRECCION|HORARIO|REUNION|REUNIRNOS|REUNIRME)\b/;
// LÍNEA C — agente de IA. Se evalúa ANTES que los paquetes de video (ver
// detectExplicitIntent): frases como "el servicio de agente de IA" o "edición
// automatizada con bot" contienen palabras de SERVICE_PACKAGES_KEYWORDS y sin esta
// prioridad los leads del video promocional caerían en el embudo equivocado.
const AI_AGENT_KEYWORDS =
  /\b(AGENTE|AGENTES|IA|CHAT ?BOT|CHAT ?BOTS|BOT|BOTS|INTELIGENCIA ARTIFICIAL|AUTOMATIZAR|AUTOMATIZACION|AUTOMATIZADO|AUTOMATIZADA|ASISTENTE|ASISTENTES|RESPOND[EA] SOLO|CONTEST[AE] SOLO)\b/;

// Cliente preguntando por una promoción/oferta.
const PROMO_REQUEST_KEYWORDS =
  /\b(PROMO|PROMOS|PROMOCION|PROMOCIONES|OFERTA|OFERTAS|DESCUENTO|DESCUENTOS|REBAJA|REBAJAS)\b/;

// Palabra "video/videos". Acompaña a la cantidad de una promo ("4 videos") para no
// confundirla con cualquier otro 4 suelto del mensaje ("a las 4", "4 sucursales").
const VIDEO_WORD_KEYWORDS = /\bVIDEOS?\b/;

// PROMO DE EDICIÓN POR 50 Bs — VENCIDA.
//
// Se publicó un video ofreciendo edición de video a 50 Bs y siguen llegando clientes
// por esa publicación aunque la promoción ya no está vigente. No se puede confirmar
// ese precio, pero tampoco se puede ignorar la pregunta: sin explicación el cliente
// siente que la oferta fue un engaño. Este detector solo identifica que el cliente
// viene por ahí; el guion de respuesta (explicar el vencimiento + derivar al editor)
// vive en el prompt y en el contexto del turno.
//
// El 50 tiene que venir acompañado de contexto de promo/edición: un "50" suelto en
// "a las 50 cuadras" o un "50%" de descuento no son esta promo.
const EDIT_PROMO_50_MONEY = /\b50\s*(BS|BOB|BOLIVIANOS?)\b/;
const EDIT_PROMO_50_CONTEXT =
  /\b(PROMO|PROMOS|PROMOCION|PROMOCIONES|OFERTA|OFERTAS|DESCUENTO|VIDEO|VIDEOS|PUBLICACION|ANUNCIO|REEL|REELS|TIKTOK|EDICION|EDITAR|EDITEN|EDITAN)\b/;
// "50%" es descuento, no precio. "50 videos" es una cantidad, no un monto.
const EDIT_PROMO_50_EXCLUSIONS = /\b50\s*%|\b50\s*(VIDEOS?|CLIENTES?|PERSONAS?)\b/;

// True si el cliente pregunta por la promoción de edición de video por 50 Bs.
function mentionsExpiredEditPromo(text: string): boolean {
  if (!text) return false;

  const normalized = normalizeForMatch(text);

  if (EDIT_PROMO_50_EXCLUSIONS.test(normalized)) return false;
  // El 50 debe ser un número propio: descarta 2500/3500/5500 (precios de paquetes).
  if (!containsExactNumber(normalized, [50])) return false;

  // "50 bs" es inequívoco por sí solo; un "50" pelado necesita contexto de promo.
  return EDIT_PROMO_50_MONEY.test(normalized) || EDIT_PROMO_50_CONTEXT.test(normalized);
}

// ACUERDO PREVIO CON UNA PERSONA DEL EQUIPO.
//
// El caso que motivó este detector: un cliente que ya había cerrado condiciones con un
// asesor ("ayer quedamos en 80 Bs por video") escribió para coordinar, y el bot le
// respondió con el catálogo — contradiciendo a su propio equipo delante del cliente, que
// se fue y dijo que no volvería. Cuando alguien dice que YA acordó algo, el bot no tiene
// forma de saber qué se acordó: no puede confirmarlo, y negarlo es peor. Lo único válido
// es callarse y devolver la conversación a la persona que la venía llevando.
//
// El detector es deliberadamente ESTRECHO: cada falso positivo apaga el bot durante horas
// en un chat que quizá solo quería información. Solo dispara con las tres formas
// inequívocas; el resto (ej. "ya hablé con José", con un nombre propio que el código no
// conoce) lo resuelve el prompt, que sí entiende el contexto.

// (a) Un acuerdo cerrado, ACOMPAÑADO de una cifra: "ayer quedamos en 80 bs",
//     "acordamos 2000 por el mes". Sin cifra no cuenta ("quedamos en que me escribes").
const PRIOR_AGREEMENT_DEAL =
  /\b(QUEDAMOS|QUEDE|QUEDAMO|ACORDAMOS|ACORDE|CONVINIMOS|CERRAMOS|PACTAMOS)\b/;

// (b) Confirmaciones explícitas de que alguien del equipo ya dio el visto bueno o el precio.
const PRIOR_AGREEMENT_CONFIRMATION =
  /\bME\s+(DIO|DIERON)\s+EL\s+OK\b|\bME\s+(DIJERON|DIJO|CONFIRMARON|CONFIRMO|PASARON|COTIZARON|OFRECIERON)\b(?:\s+\S+){0,4}?\s+(PRECIO|COSTO|MONTO|DESCUENTO|OK|SI)\b|\bYA\s+(ESTA|ESTABA|QUEDO)\s+(ACORDADO|CERRADO|HABLADO|COORDINADO|CONFIRMADO)\b/;

// (c) Habló con alguien del EQUIPO, nombrado como tal (no "hablé con mi socio").
const PRIOR_AGREEMENT_TEAM =
  /\b(HABLE|HABLAMOS|CONVERSE|CONVERSAMOS|COORDINE|COORDINAMOS|TRATE|TRATAMOS|ESCRIBI)\b(?:\s+\S+){0,4}?\s+(EL\s+ASESOR|LA\s+ASESORA|UN\s+ASESOR|SU\s+ASESOR|TU\s+ASESOR|EL\s+ENCARGADO|LA\s+ENCARGADA|TU\s+COMPANERO|SU\s+COMPANERO|EL\s+DUENO|LA\s+DUENA|EL\s+JEFE|USTEDES)\b/;

// True si el cliente afirma tener algo YA acordado o hablado con el equipo. El bot no
// puede confirmarlo ni negarlo: deriva a la persona que lo atendió y guarda silencio.
function mentionsPriorAgreement(text: string): boolean {
  if (!text) return false;

  const normalized = normalizeForMatch(text);

  // El acuerdo con cifra necesita las dos mitades: verbo de acuerdo + un número que no
  // sea parte de una fecha suelta. Un "quedamos en el martes" no es un precio cerrado.
  const hasNumber = /\b\d{2,5}\b/.test(normalized.replace(/(\d)[.,](\d)/g, "$1$2"));
  if (PRIOR_AGREEMENT_DEAL.test(normalized) && hasNumber) return true;

  if (PRIOR_AGREEMENT_CONFIRMATION.test(normalized)) return true;

  return PRIOR_AGREEMENT_TEAM.test(normalized);
}

// ENLACES ENTRANTES.
//
// Un link que manda el cliente no dice nada por sí solo: puede ser su TikTok, su
// catálogo, la publicación de una promo o algo sin relación. El bot no puede abrirlo
// ni debe inventar qué contiene, así que se pide contexto en vez de adivinar el flujo.
//
// Se exige protocolo, "www." o una barra después del dominio para no confundir un
// punto final de oración ("listo. ok") con un dominio.
const INCOMING_LINK_REGEX =
  /(?:https?:\/\/\S+)|(?:\bwww\.[a-z0-9-]+\.[a-z]{2,}\S*)|(?:\b[a-z0-9-]+\.(?:com|bo|net|org|app|link|me|tv|io|co)\/\S*)/i;

// True si el mensaje del cliente contiene un enlace.
function containsIncomingLink(text: string): boolean {
  if (!text) return false;
  return INCOMING_LINK_REGEX.test(text);
}

// VISITA A LA OFICINA / REUNIÓN PRESENCIAL.
//
// El bot ya no invita a nadie a pasar por la oficina ni da horario ni anota un día y una
// hora: no sabe si habrá alguien para atender. Antes de cualquier visita un asesor llama al
// cliente y le indica la hora. Hay dos casos:
//   - "business": viene por los servicios → se le pide el formulario de datos del negocio.
//   - "course":   viene por un curso → NO se le pide el formulario de negocio; se le
//                 pregunta qué dudas tiene del curso y se avisa al asesor para que llame.
// Este detector es la mitad determinista de esa decisión (la otra es el flag del modelo).
//
// Exige una forma de "ir / reunirse / visitar": preguntar solo DÓNDE queda la oficina no
// es pedir una reunión (ese caso da la ubicación y ofrece coordinar, sin formulario).
const OFFICE_VISIT_REGEX =
  /\b(VISITARLOS|VISITARLES|VISITARLAS|VISITAR\s+(SU|SUS|LA|LAS)\s+OFICINAS?|VISITAR\s+CONECTA|IRE\s+A\s+VISITAR\w*|PASAR\s+A\s+VISITAR\w*|UNA\s+VISITA|HACER\s+UNA\s+CITA|AGENDAR\s+UNA\s+CITA|QUIERO\s+UNA\s+CITA|REUNION\s+PRESENCIAL|REUNIRNOS|REUNIRME\s+CON|APERSONAR\w*)\b|\b(IR|PASAR|PASO|IRE|VOY|LLEGAR|ACERCARME|APERSONARME)\b(?:\s+\S+){0,3}?\s+(SU|SUS|LA|LAS)\s+OFICINAS?\b|\bREUNION\b(?:\s+\S+){0,3}?\s+(SU|SUS|LA|LAS)\s+OFICINAS?\b/;

// Lo que NO es pedir venir: negarlo ("no puedo ir a su oficina"), pedir la reunión a
// distancia ("reunirnos de forma virtual o por llamada") o buscar trabajo.
const OFFICE_VISIT_EXCLUSIONS =
  /\bNO\s+(PUEDO|PODRE|VOY\s+A\s+PODER)\s+(IR|PASAR|VISITAR\w*)\b|\b(VIRTUAL|VIRTUALMENTE|ZOOM|MEET|VIDEOLLAMADA|POR\s+LLAMADA)\b|\bFORMAR\s+PARTE\s+DE\s+SU\s+EQUIPO\b|\bTRABAJAR\s+CON\s+USTEDES\s+COMO\b/;

// Preguntar DÓNDE es el curso es su ubicación (otro flujo), no una visita a la oficina.
const COURSE_LOCATION_QUESTION = /\b(DONDE|UBICACION|DIRECCION|COMO\s+LLEGO|COMO\s+LLEGAR)\b/;

type OfficeVisitKind = "business" | "course";

// ¿El cliente quiere venir a la oficina o reunirse en persona? ¿Por un curso o por los
// servicios? null = no está pidiendo una visita.
function detectOfficeVisit(text: string): OfficeVisitKind | null {
  if (!text) return null;
  const normalized = normalizeForMatch(text);
  if (OFFICE_VISIT_EXCLUSIONS.test(normalized)) return null;
  if (!OFFICE_VISIT_REGEX.test(normalized)) return null;

  if (COURSE_KEYWORDS.test(normalized)) {
    return COURSE_LOCATION_QUESTION.test(normalized) ? null : "course";
  }
  return "business";
}

function mentionsOfficeVisit(text: string): boolean {
  return detectOfficeVisit(text) !== null;
}

// RECLUTAMIENTO. Gente que busca TRABAJO (modelos, editores, azafatas) por los videos donde
// Conecta Pro buscaba personal. El bot no tiene nada que decirles: se calla y se deriva a
// una persona del equipo. Estrecho a propósito — "¿sale un modelo en los videos?" es una
// pregunta de un cliente de paquetes, no reclutamiento.
const RECRUITMENT_REQUEST =
  /\b(VACANTE|VACANTES|POSTULAR\w*|EMPLEO|CURRICULUM|CURRICULO|HOJA\s+DE\s+VIDA|AZAFATA|AZAFATAS|FORMAR\s+PARTE\s+DE\s+SU\s+EQUIPO|TRABAJAR\s+COMO|TRABAJAR\s+CON\s+USTEDES\s+COMO|OPORTUNIDAD\s+LABORAL|SER\s+MODELO|COMO\s+MODELO|REQUISITOS\s+PARA\s+SER|MI\s+BOOK|SIGUE\s+DISPONIBLE\s+EL\s+TRABAJO|SIGUEN\s+BUSCANDO|(BUSCAN|ESTAN\s+BUSCANDO|ESTABAN\s+BUSCANDO|NECESITAN)\s+(PERSONAL|PERSONAS|GENTE|MODELOS?|CHICAS?|EDITOR\w*|CAMAROGRAF\w*|CREADOR\w*))\b/;

function mentionsRecruitment(text: string): boolean {
  if (!text) return false;
  return RECRUITMENT_REQUEST.test(normalizeForMatch(text));
}

// EDICIÓN AMBIGUA.
//
// "Edición de video" puede ser dos servicios muy distintos: los paquetes de Conecta Pro
// (guiones + grabación + edición + publicación) o la edición neta que hace el editor
// externo con videos que el cliente ya grabó. En un mes de chats reales el bot mandó los
// paquetes a quien solo quería editar su video (un asesor tuvo que corregir 47 veces) y
// el número del editor a quien quizá buscaba un paquete. Cuando el mensaje no deja claro
// cuál de los dos es, lo correcto es preguntar antes de mandar nada.
type EditingRequest = "editing_only" | "packages" | "ambiguous";

const EDITING_WORDS =
  /\b(EDICION|EDICIONES|EDITAR|EDITEN|EDITAN|EDITE|EDITES|EDITA|EDITARME|EDITARLO|EDITARLOS|EDITARLA|EDITADO|EDITADOS|EDITOR|EDITORES)\b/;

// Pide que se lo GRABEN (con o sin edición): eso es un paquete, aunque diga "me los edite".
// "Grave/graven" es la falta de ortografía más común en los chats.
const EDITING_RECORDING_REQUEST =
  /\b(QUE|QUIEN|ALGUIEN\s+(QUE|Q))\s+(ME|NOS)\s+(GRABE|GRABEN|GRAVE|GRAVEN)\b|\b(GRABENME|GRABARME|GRABARNOS)\b|\bVENGAN\s+A\s+GRABAR\b/;

// Señales de que el cliente YA tiene el material y solo quiere la edición.
const EDITING_ONLY_SIGNALS =
  /\b(SOLO|SOLAMENTE|UNICAMENTE)\s+((NECESITO|QUIERO|QUISIERA|BUSCO|REQUIERO|ES|ME\s+INTERESA)\s+)?(LA\s+|DE\s+|PARA\s+|UNA\s+|LAS\s+)?(EDICION|EDICIONES|EDITAR|EDITEN|EDITES|QUE\s+(ME\s+)?(LO\s+|LOS\s+)?EDIT\w*)\b|\bEDICION(ES)?\s+(QUIERO\s+)?NOMAS\b|\bEDICION\s+NETA\b|\b(YO|YA)\s+(ME\s+)?(GRABO|GRAVO|FILMO|GRABAMOS|FILMAMOS)\b|\bEDIT\w*\s+(CLIPS?|MIS|MI)\b|\b(YA\s+)?TENGO\s+(LOS\s+|MIS\s+|UNOS\s+|UN\s+|EL\s+|ESTE\s+)?VIDEOS?\b|\bVIDEOS?\s+(YA\s+)?GRABADOS?\b|\bYA\s+(LOS\s+|LO\s+)?GRABE\b|\bGRABE\s+(UN|UNOS|MIS|LOS|CON)\b|\bCRUDOS?\b|\bEN\s+BRUTO\b|\b(NO\s+NECESITO|SIN)\s+(LA\s+)?GRABACION\b|\bME\s+(LO\s+|LOS\s+|LA\s+)?EDIT(EN|ES|E|AS|AN)\b|\b(EDITAR|EDITEN|EDITES|EDITARME)\s+(MI|MIS|ESTE|ESTOS|ESE|ESOS)\s+VIDEOS?\b/;

// Señales de que busca el servicio completo (que se le grabe o se le haga la publicidad).
// "Paquete" solo NO alcanza: "paquetes de edición" sigue sin decir si ya tiene los videos.
const EDITING_PACKAGE_SIGNALS =
  /\b(GRABACION|GRABACIONES|GRABAR|GRABEN|GRABARME|GRABARNOS|GRABAN|PRODUCCION|GUION|GUIONES|FILMACION|FILMAR|PUBLICIDAD|MARKETING|COMMUNITY)\b|\bMANEJO\s+DE\s+REDES\b/;

// Clasifica un mensaje que habla de edición. null = no habla de edición, o habla de un
// CURSO (el curso de CapCut también dice "edición" y va por su propio flujo).
function detectEditingRequest(text: string): EditingRequest | null {
  if (!text) return null;
  const normalized = normalizeForMatch(text);

  if (!EDITING_WORDS.test(normalized)) return null;
  if (COURSE_KEYWORDS.test(normalized)) return null;

  if (EDITING_RECORDING_REQUEST.test(normalized)) return "packages";
  if (EDITING_ONLY_SIGNALS.test(normalized)) return "editing_only";
  if (EDITING_PACKAGE_SIGNALS.test(normalized)) return "packages";
  return "ambiguous";
}

// COMPRA DE UN CURSO.
//
// Palabras que solo aparecen cuando alguien quiere pagar un curso: la entrada, el boleto,
// el cupo, la inscripción, la preventa. Los paquetes no tienen nada de eso (se cierran con
// el formulario y un asesor), así que un mensaje con estas palabras o con las del curso
// nunca debe recibir el formulario de datos de empresa. En septiembre 2026, "quiero comprar
// mi entrada", "quiero dos cupo para el curso" o "me interesa curso" lo recibieron.
const COURSE_PURCHASE_KEYWORDS =
  /\b(ENTRADA|ENTRADAS|BOLETO|BOLETOS|TICKET|TICKETS|CUPO|CUPOS|INSCRIPCION|INSCRIPCIONES|INSCRIBIR\w*|INSCRIBO|INSCRIBE|INSCRITO|INSCRITA|PREVENTA)\b/;

// ¿El mensaje habla de un curso o de comprar su entrada?
function mentionsCourse(text: string): boolean {
  if (!text) return false;
  const normalized = normalizeForMatch(text);
  return COURSE_KEYWORDS.test(normalized) || COURSE_PURCHASE_KEYWORDS.test(normalized);
}

// PEDIDO DE PAGO DE UN CURSO (red determinista del QR).
//
// Dos niveles, porque no piden lo mismo:
//   - "qr_request": pide el QR con todas las letras ("me pasa su QR", "el qr porfavor",
//     "mande QR", "no me llegó el QR"). El QR sale aunque ya se le haya enviado antes.
//   - "pay_intent": quiere pagar o reservar ("quiero pagar mi entrada", "reservar mi
//     curso", "me quiero inscribir"). El QR sale si no lo recibió hace poco; si lo tiene
//     arriba en el chat, el bot se lo recuerda en vez de mandarlo otra vez.
type CoursePaymentRequest = "qr_request" | "pay_intent";

const QR_REQUEST_VERBS =
  "PASA|PASAS|PASE|PASEME|PASAME|PASAR|PASARME|PASARIA|PASARIAS|MANDA|MANDAS|MANDE|MANDEME|MANDAME|MANDAR|MANDARME|MANDARIA|ENVIA|ENVIAS|ENVIE|ENVIEME|ENVIAME|ENVIAR|ENVIARME|ENVIARIA|FACILITA|FACILITAS|FACILITE|FACILITEME|FACILITAME|FACILITAR|FACILITARME|REGALA|REGALAME|REGALE|REGALEME|COMPARTE|COMPARTEME|COMPARTIME|COMPARTA|COMPARTAME|COMPARTIR|COMPARTIRME|DAME|DEME|QUIERO|QUISIERA|NECESITO";

const QR_REQUEST_REGEX = new RegExp(
  // "pásame el QR", "me pasa su QR", "mande Qr", "quiero pagar con QR"
  `\\b(${QR_REQUEST_VERBS})\\b(?:\\s+\\S+){0,3}?\\s+(CODIGO\\s+)?QR\\b` +
    // "me da su QR", "me puede dar el QR"
    `|\\bME\\s+(DA|DAS|DE|PUEDE\\s+DAR|PUEDES\\s+DAR|PODRIA\\s+DAR)\\b(?:\\s+\\S+){0,2}?\\s+QR\\b` +
    // "Qr por favor", "El qr porfavor"
    `|\\bQR\\s+(POR\\s*FAVOR|PORFA\\w*|PLIS|PLS|PLEASE)\\b` +
    // "no me llegó el QR", "no me carga el QR"
    `|\\bNO\\s+(ME\\s+)?(LLEGO|APARECE|CARGA|ABRE|SALE|VEO)\\b(?:\\s+\\S+){0,2}?\\s+QR\\b` +
    // Un mensaje (o una línea de la ráfaga) que es solo "QR" o "el QR?"
    `|^\\W*(EL\\s+|SU\\s+|UN\\s+)?QR\\W*$`,
  "m",
);

// Lo que se compra al pagar un curso.
const COURSE_TICKET_NOUNS =
  "ENTRADA|ENTRADAS|BOLETO|BOLETOS|TICKET|TICKETS|CUPO|CUPOS|LUGAR|LUGARES|CURSO|CURSOS|INSCRIPCION|PREVENTA|CLASE|CLASES|TALLER";

const PAY_INTENT_REGEX = new RegExp(
  // "pagar mi entrada", "comprar dos entradas", "reservar mi curso", "asegurar mi cupo"
  `\\b(PAGAR|COMPRAR|RESERVAR|ADQUIRIR|ASEGURAR|SEPARAR|APARTAR)\\s+((MI|MIS|LA|LAS|EL|LOS|UN|UNA|UNOS|UNAS|DOS|TRES|\\d+)\\s+)?(${COURSE_TICKET_NOUNS})\\b` +
    // "quiero pagar", "cómo hago para inscribirme", "quisiera reservar"
    `|\\b(QUIERO|QUISIERA|QUERIA|DESEO|NECESITO|COMO\\s+HAGO\\s+PARA|COMO\\s+PUEDO|DONDE\\s+PUEDO)\\s+(PAGAR|INSCRIBIRME|ANOTARME|RESERVAR)\\b` +
    // "me quiero inscribir", "quiero inscribirme"
    `|\\b(ME\\s+QUIERO|QUIERO|QUISIERA|QUERIA|DESEO)\\s+(INSCRIBIR|ANOTAR)\\w*` +
    // "quiero dos cupos", "quiero mi entrada", "quiero el cupo"
    `|\\bQUIERO\\s+((UN|UNA|MI|MIS|EL|LA|DOS|TRES|\\d+)\\s+)?(CUPO|CUPOS|LUGAR|LUGARES|ENTRADA|ENTRADAS|BOLETO|BOLETOS)\\b` +
    // "cómo pago", "dónde pago", "me inscribo", "anótame", "quiero la preventa"
    `|\\b(COMO|DONDE)\\s+(PAGO|RESERVO|APARTO|COMPRO|ME\\s+INSCRIBO)\\b|\\bME\\s+INSCRIBO\\b|\\bANOTAME\\b|\\bQUIERO\\s+LA\\s+PREVENTA\\b`,
);

// Ya pagó o va a pagar en la puerta: no hay QR que mandar. "Pagué" va con sujeto ("ya
// pagué", "yo pagué") porque "pásame el QR para que te pague" SÍ es un pedido.
const PAYMENT_REQUEST_EXCLUSIONS =
  /\bCOMPROBANTE\b|\b(DEPOSITE|TRANSFERI)\b|\b(YA|YO)\s+(TE\s+|LE\s+|LES\s+)?(PAGUE|CANCELE)\b|\bYA\s+(TE\s+|LE\s+|LES\s+)?(MANDE|ENVIE|PASE)\b|\bEN\s+(LA\s+)?PUERTA\b/;

// ¿El cliente pide pagar un curso? null = no lo pide (o ya pagó, o pagará en la puerta).
// No decide la LÍNEA: en una conversación de paquetes el webhook descarta un "quiero pagar"
// genérico, que ahí se refiere al paquete.
function detectCoursePaymentRequest(text: string): CoursePaymentRequest | null {
  if (!text) return null;
  const normalized = normalizeForMatch(text).trim();

  if (PAYMENT_REQUEST_EXCLUSIONS.test(normalized)) return null;
  if (QR_REQUEST_REGEX.test(normalized)) return "qr_request";
  if (PAY_INTENT_REGEX.test(normalized)) return "pay_intent";
  return null;
}

// VOCABULARIO DEL NEGOCIO (red contra el silencio por "fuera de tema").
//
// El modelo marca off_topic y el bot guarda silencio total. En un mes, 71 de esos 159
// silencios eran clientes preguntando por servicios ("¿cuánto cobran por publicidad?",
// "más información", "¿qué servicio brindan?"). Si el mensaje trae vocabulario del
// negocio, NO se acepta el silencio. Quedan fuera los mensajes largos (difusiones y
// publicidad de otros negocios que llegan al número) y los de reclutamiento.
// ── CIERRE SECO: "ya, gracias" ───────────────────────────────────────────────
//
// Un cliente que cierra con "ya, gracias" recibía el saludo completo de bienvenida
// ("¡Hola! Somos ConectaPro... tenemos cursos, servicios y agentes de IA"): el modelo lo
// leía como un primer contacto sin intención concreta. Pasó 9 veces en 3 semanas
// (verificado en la base, sep 2026) y es un mensaje de Meta pagado para volver a
// presentarse a alguien que se está despidiendo.
//
// El detector es a propósito ESTRECHO: exige un agradecimiento explícito y que TODO lo
// demás del mensaje sean muletillas de cierre. "Gracias, ¿pueden venir hasta el trópico?"
// tiene que seguir recibiendo su respuesta real, así que cualquier palabra fuera de la
// lista —o un signo de pregunta— lo descarta.
const THANKS_WORDS = /^(GRACIAS|GRACIA|GRACIAAA*S?|GRASIAS|GRACS|THANKS|THANK|THX)$/;

// Muletillas que pueden acompañar al agradecimiento sin cambiar que es un cierre.
const CLOSING_FILLER_WORDS = new Set([
  "YA", "OK", "OKA", "OKI", "OKEY", "OKAY", "LISTO", "LISTA", "BUENO", "BUENA",
  "PERFECTO", "PERFECTA", "EXCELENTE", "GENIAL", "VALE", "DALE", "AH", "AHH", "AYA",
  "AYAA", "AA", "MUCHAS", "MUCHISIMAS", "MIL", "DE", "NADA", "MUY", "AMABLE", "IGUALMENTE",
  "SALUDOS", "BENDICIONES", "CHAU", "ADIOS", "HASTA", "LUEGO", "PRONTO", "SI", "SIP",
  "ENTIENDO", "ENTENDIDO", "CLARO", "TODO", "POR", "SU", "TU", "LA", "EL", "INFO",
  "INFORMACION", "AYUDA", "ATENCION", "TIEMPO", "APOYO",
]);

// ¿El mensaje es EXCLUSIVAMENTE un agradecimiento o despedida? Se usa para que el cierre
// de conversación no se confunda nunca con un primer contacto.
function isClosingThanksOnly(text: string): boolean {
  if (!text || text.includes("?") || text.includes("¿")) return false;

  const words = normalizeForMatch(text)
    // Fuera puntuación y emojis: solo importan las palabras.
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

  if (words.length === 0 || words.length > 8) return false;
  if (!words.some((word) => THANKS_WORDS.test(word))) return false;

  return words.every(
    (word) => THANKS_WORDS.test(word) || CLOSING_FILLER_WORDS.has(word),
  );
}

const BUSINESS_VOCABULARY =
  /\b(PUBLICIDAD|PUBLICITAR|PUBLICITARIO|MARKETING|MERCADEO|PROMOCIONAR|PROMOCIONEN|COMMUNITY|REDES\s+SOCIALES|SERVICIO|SERVICIOS|PAQUETE|PAQUETES|PLANES|PRECIO|PRECIOS|COSTO|COSTOS|COBRAN|COBRA|COTIZACION|COTIZAR|INFORMACION|INFORMACIONES|INFO|DETALLES|CURSO|CURSOS|CLASE|CLASES|TALLER|INSCRIBIR\w*|CUPO|EDICION|EDITAR|EDITEN|GRABACION|GRABAR|VIDEO|VIDEOS|CONTENIDO|UBICACION|DIRECCION|OFICINA|VISITARLOS|AGENTE|CHATBOT|QR|PAGO|PAGUE|PAGADO|COMPROBANTE|DEPOSITE|TRANSFERI|CANCELE|CANCELACION|CONECTA\s*PRO|ASESOR)\b/;

const RECRUITMENT_VOCABULARY =
  /\b(MODELO|MODELOS|VACANTE|VACANTES|POSTULAR\w*|EMPLEO|CURRICULUM|HOJA\s+DE\s+VIDA|AZAFATA|FORMAR\s+PARTE\s+DE\s+SU\s+EQUIPO|BUSCAN\s+PERSONAL|SIGUEN\s+BUSCANDO|BUSCANDO\s+PERSONAS)\b/;

const MAX_WORDS_FOR_BUSINESS_OVERRIDE = 40;

// True si el mensaje es, con claridad, una consulta sobre Conecta Pro.
function hasBusinessVocabulary(text: string): boolean {
  if (!text) return false;
  const normalized = normalizeForMatch(text);
  if (normalized.trim().split(/\s+/).length > MAX_WORDS_FOR_BUSINESS_OVERRIDE) return false;
  if (RECRUITMENT_VOCABULARY.test(normalized)) return false;
  return BUSINESS_VOCABULARY.test(normalized);
}

export {
  normalizeForMatch,
  containsExactNumber,
  SERVICE_PACKAGES_KEYWORDS,
  COURSE_KEYWORDS,
  APPOINTMENT_KEYWORDS,
  AI_AGENT_KEYWORDS,
  PROMO_REQUEST_KEYWORDS,
  VIDEO_WORD_KEYWORDS,
  mentionsExpiredEditPromo,
  mentionsPriorAgreement,
  containsIncomingLink,
  mentionsOfficeVisit,
  detectOfficeVisit,
  mentionsRecruitment,
  detectEditingRequest,
  hasBusinessVocabulary,
  isClosingThanksOnly,
  COURSE_PURCHASE_KEYWORDS,
  mentionsCourse,
  detectCoursePaymentRequest,
};
export type { CoursePaymentRequest, EditingRequest, OfficeVisitKind };

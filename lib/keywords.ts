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
const SERVICE_PACKAGES_KEYWORDS =
  /\b(PAQUETE|PAQUETES|GRABACION|GRABACIONES|EDICION|SERVICIO|SERVICIOS|VIDEOS|PRODUCCION|CONTENIDO|DRON)\b/;
const COURSE_KEYWORDS =
  /\b(CURSO|CURSOS|TALLER|TALLERES|CAPACITACION|FORMACION|APRENDER|CAPCUT|CLASE|CLASES)\b/;
const APPOINTMENT_KEYWORDS =
  /\b(CITA|VISITA|OFICINA|AGENDAR|UBICACION|DIRECCION|HORARIO)\b/;
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
};

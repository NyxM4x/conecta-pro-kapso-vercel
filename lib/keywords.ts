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

export {
  normalizeForMatch,
  containsExactNumber,
  SERVICE_PACKAGES_KEYWORDS,
  COURSE_KEYWORDS,
  APPOINTMENT_KEYWORDS,
  AI_AGENT_KEYWORDS,
  PROMO_REQUEST_KEYWORDS,
  VIDEO_WORD_KEYWORDS,
};

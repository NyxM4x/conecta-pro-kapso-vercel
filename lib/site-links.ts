// Botones del bot que abren las páginas /paquetes, /cursos y /oficina.
//
// WhatsApp los muestra como un mensaje con un botón (interactive "cta_url"). Qué botón sale
// en cada turno lo decide decideLinkButton, función PURA (sin red, sin base, sin reloj
// propio) para poder probar cada disparador:
//
//   LÍNEA A — cursos:   información de un curso → "Ver cursos" (/cursos, o
//                       /cursos#capcut-pro si el cliente nombró UN curso).
//   LÍNEA B — paquetes: consulta general → "Ver paquetes";
//                       intención clara (quiere contratar) → "Llenar mis datos", con el
//                       paquete elegido ya abierto en el formulario (&p=pro&f=1).
//   Visita a la oficina: → "Agendar visita" (/oficina, según a qué viene).
//   Pagos, derivaciones a un asesor y cierres de lead: sin botón.
//
// El botón ES la información: no salen flyers ni el texto largo. El mensaje lleva un texto
// corto fijo (PACKAGES_BUTTON_TEXT y compañía) y el botón; lo demás está en la página.
// Sin dependencias de Next para que lo usen el webhook, la página y las pruebas con Node.

import { createHmac, timingSafeEqual } from "node:crypto";
import { hasSellableCourse } from "./courses.ts";
import { normalizeForMatch } from "./keywords.ts";
import type { OfficeVisitType } from "./office-form.ts";
import { VIDEO_PACKAGES } from "./packages.ts";

type LinkButtonKind = "packages" | "packages_form" | "courses" | "office";

// Páginas a las que llevan los botones.
type SitePage = "paquetes" | "cursos" | "oficina";

type LinkButton = {
  kind: LinkButtonKind;
  url: string;
  // Texto del botón. WhatsApp corta en 20 caracteres.
  displayText: string;
  // Cuerpo del mensaje cuando el botón sale aparte de la respuesta.
  bodyText: string;
  // Pie (máx. 60) cuando el botón viaja pegado a la respuesta del bot.
  footerText: string;
  // El cliente lo pidió: sale aunque ya lo tenga arriba en el chat.
  forced: boolean;
};

// Límites de WhatsApp para un mensaje interactivo.
const CTA_BODY_MAX_CHARS = 1024;
const CTA_DISPLAY_MAX_CHARS = 20;
const CTA_FOOTER_MAX_CHARS = 60;

// Un mismo botón no se repite dentro de este lapso: quien sigue la conversación ya lo
// tiene arriba. Pasado un día vuelve a salir, igual que el flyer de paquetes.
const LINK_BUTTON_RESEND_HOURS = 24;

// ---------------------------------------------------------------------------
// Marcadores en kapso_messages
// ---------------------------------------------------------------------------
//
// Todos empiezan con "[" y el webhook los excluye del historial del modelo.

// Botón enviado.
const LINK_SENT_MARKER_PREFIX = "[LINK_SENT:";
const linkSentMarker = (kind: LinkButtonKind) => `${LINK_SENT_MARKER_PREFIX}${kind}]`;

// El cliente abrió una página desde el botón (lo guarda /api/site-visit). Con esto se sabe
// si de verdad entró, aunque no haya enviado nada.
const SITE_VISIT_MARKER_PREFIX = "[SITE_VISIT:";
const siteVisitMarker = (page: SitePage) => `${SITE_VISIT_MARKER_PREFIX}${page}]`;

// Lead que llegó por un formulario de la página (lo guarda /api/leads en la conversación).
// Empieza como el del lead por chat para que todo lo que ya busca [TELEGRAM_LEAD_SENT] lo
// cuente; el webhook usa el prefijo completo para saber que vino de la web.
const WEB_LEAD_MARKER_PREFIX = "[TELEGRAM_LEAD_SENT] lead recibido desde la página";
const webLeadMarker = (page: "paquetes" | "oficina") => `${WEB_LEAD_MARKER_PREFIX} /${page}`;

// ---------------------------------------------------------------------------
// URL del sitio
// ---------------------------------------------------------------------------

// Dominio de producción en Vercel. Es el último recurso: los textos del bot dicen "dentro de
// este botón", así que el botón tiene que salir siempre, también en pruebas locales.
const DEFAULT_SITE_URL = "https://conecta-pro-kapso-vercel-seven.vercel.app";

// CONECTA_PRO_SITE_URL manda (un dominio propio, si algún día lo hay). Sin ella se usa el
// dominio de producción que Vercel expone solo (VERCEL_PROJECT_PRODUCTION_URL, sin https).
// null solo si alguna de las dos trae algo que no es una URL.
function getSiteBaseUrl(env: Record<string, string | undefined> = process.env): string | null {
  const raw = (
    env.CONECTA_PRO_SITE_URL ||
    env.VERCEL_PROJECT_PRODUCTION_URL ||
    DEFAULT_SITE_URL
  ).trim();

  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;

  try {
    const url = new URL(withProtocol);
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

// Mismos slugs que usan las páginas: "Básico" → "basico", "capcut_pro" → "capcut-pro".
const packageSlug = (name: string) => normalizeForMatch(name).toLowerCase();
const courseSlug = (courseId: string) => courseId.replace(/_/g, "-");

// ---------------------------------------------------------------------------
// Textos fijos de los mensajes con botón
// ---------------------------------------------------------------------------
//
// Son la respuesta entera del bot en esos turnos: corta, sin precios ni catálogo (están en
// la página). El webhook los usa también para reemplazar el texto largo o el formulario
// si el modelo los escribe igual.

// FLUJO B, consulta general (incluye "¿cómo trabajan?" y los precios en general).
const PACKAGES_BUTTON_TEXT = `Puedes ver nuestros ${VIDEO_PACKAGES.length} paquetes dentro de este botón 👇 Si te interesa uno, llena tus datos y un asesor te hablará pronto 😊`;

// FLUJO B, intención clara: eligió un paquete o quiere contratar.
const PACKAGES_FORM_BUTTON_TEXT =
  "¡Perfecto! 🙌 Elige tu paquete y llena tus datos dentro de este botón 👇 Un asesor te hablará pronto 😊";

// Visita a la oficina por los servicios o por el agente de IA.
const OFFICE_BUTTON_TEXT =
  "¡Con gusto te recibimos! 😊 Antes de la reunión en nuestra oficina, un asesor te llamará para coordinarla y conocer tu negocio. Deja tus datos dentro de este botón para agendar tu visita 👇";

// Visita a la oficina por un curso: no hay datos de negocio, solo sus dudas.
const OFFICE_COURSE_BUTTON_TEXT =
  "¡Con gusto! 😊 Para visitarnos en la oficina, un asesor te llamará y te indicará la hora. Cuéntanos tus dudas del curso dentro de este botón para agendar tu visita 👇";

// FLUJO A, consulta general o información de un curso. Depende de si hay un curso a la
// venta: sin fecha vigente no se invita a pagar.
function renderCoursesButtonText(now: Date): string {
  return hasSellableCourse(now)
    ? "Puedes ver nuestros cursos dentro de este botón 👇 Ahí está lo que vas a aprender, la fecha y el precio. Si te interesa, escríbenos por aquí y te pasamos el QR para reservar tu cupo 😊"
    : "Puedes ver nuestros cursos dentro de este botón 👇 Por ahora no tenemos una fecha confirmada: la anunciamos en TikTok (@marketero7) apenas salga 😊";
}

// ¿A qué página apunta un texto de botón? Reconoce los textos fijos de arriba (aunque el
// modelo les cambie un emoji o una coma) para saber qué botón tiene que acompañarlos y,
// en el historial, qué línea se le presentó al cliente.
function detectButtonTextKind(text: string): LinkButtonKind | null {
  if (!text) return null;
  const normalized = normalizeForMatch(text);
  if (!/\bBOTON\b/.test(normalized)) return null;

  if (/\bAGENDAR\s+TU\s+VISITA\b/.test(normalized)) return "office";
  if (/\bLLEN\w*\s+TUS\s+DATOS\s+DENTRO\b|\bELIGE\s+TU\s+PAQUETE\b/.test(normalized)) {
    return "packages_form";
  }
  if (/\bPAQUETES\s+DENTRO\b/.test(normalized)) return "packages";
  if (/\bCURSOS?\s+DENTRO\b/.test(normalized)) return "courses";
  return null;
}

// ¿La respuesta le habla al cliente de un botón ("dentro de este botón", "abajo tienes el
// botón")? Entonces el botón tiene que salir sí o sí, aunque ya lo haya recibido hace poco:
// sin él, el mensaje apunta a la nada.
function replyMentionsButton(reply: string): boolean {
  if (!reply) return false;
  return /\b(ESTE|EL|DEL|AL)\s+BOTON\b/.test(normalizeForMatch(reply));
}

// ---------------------------------------------------------------------------
// Firma del número en los links
// ---------------------------------------------------------------------------
//
// El link lleva el WhatsApp del cliente (?wa=): es el contacto del lead (los formularios no
// piden número) y cruza lo que hace en la página con su conversación. Como cualquiera
// puede escribir otro número en la URL, el link va firmado (&t=) y la página solo toca la
// conversación si la firma es válida. Sin firma el lead igual llega a Telegram, marcado
// "sin verificar".

function getLeadLinkSecret(env: Record<string, string | undefined> = process.env): string | null {
  return env.LEAD_LINK_SECRET || env.KAPSO_API_KEY || null;
}

function signLeadPhone(phone: string, secret: string): string {
  const digits = phone.replace(/\D/g, "");
  return createHmac("sha256", secret).update(`lead-link:${digits}`).digest("hex").slice(0, 16);
}

function verifyLeadPhone(phone: string, token: string, secret: string): boolean {
  if (!phone || !token || !/^[0-9a-f]{16}$/.test(token)) return false;
  const expected = Buffer.from(signLeadPhone(phone, secret));
  return timingSafeEqual(expected, Buffer.from(token));
}

function setSignedPhone(url: URL, phone?: string, secret?: string | null) {
  const digits = (phone ?? "").replace(/\D/g, "");
  if (!digits) return;
  url.searchParams.set("wa", digits);
  if (secret) url.searchParams.set("t", signLeadPhone(digits, secret));
}

function buildPackagesUrl(params: {
  baseUrl: string;
  phone?: string;
  packageName?: string | null;
  secret?: string | null;
  form?: boolean;
}): string {
  const url = new URL("/paquetes", params.baseUrl);
  setSignedPhone(url, params.phone, params.secret);
  if (params.packageName) url.searchParams.set("p", packageSlug(params.packageName));
  // Con un paquete elegido, la hoja se abre directo en el formulario.
  if (params.form && params.packageName) url.searchParams.set("f", "1");

  return url.toString();
}

function buildCoursesUrl(params: {
  baseUrl: string;
  courseId?: string | null;
  phone?: string;
  secret?: string | null;
}): string {
  const url = new URL("/cursos", params.baseUrl);
  // El número firmado solo sirve para saber que abrió la página (ver /api/site-visit).
  setSignedPhone(url, params.phone, params.secret);
  url.hash = params.courseId ? courseSlug(params.courseId) : "cursos";
  return url.toString();
}

function buildOfficeUrl(params: {
  baseUrl: string;
  visitType: OfficeVisitType;
  phone?: string;
  secret?: string | null;
}): string {
  const url = new URL("/oficina", params.baseUrl);
  setSignedPhone(url, params.phone, params.secret);
  url.searchParams.set("tipo", params.visitType);
  return url.toString();
}

// ---------------------------------------------------------------------------
// Pedido explícito del link
// ---------------------------------------------------------------------------

const LINK_WORDS = /\b(LINK|LINKS|ENLACE|ENLACES|PAGINA|PAGINAS|WEB|SITIO|URL)\b/;
const LINK_PACKAGES_WORDS =
  /\b(PAQUETE|PAQUETES|PLAN|PLANES|SERVICIO|SERVICIOS|FORMULARIO|PRECIOS)\b/;
const LINK_COURSES_WORDS = /\b(CURSO|CURSOS|TALLER|CLASES|CAPCUT)\b/;
// "No me abre el link", "el link no funciona": también es pedirlo de nuevo.
const LINK_REQUEST_VERBS =
  /\b(PASA\w*|MANDA\w*|ENVIA\w*|COMPART\w*|DAME|DEME|REENVIA\w*|QUIERO|QUISIERA|NECESITO|TIENEN|TIENES|HAY|CUAL|ABRE|FUNCIONA|CARGA|LLEGO)\b/;

// ¿El cliente pide el link de una de las páginas? null = no lo pide, o no dice cuál.
function detectSiteLinkRequest(text: string): "packages" | "courses" | null {
  if (!text) return null;
  const normalized = normalizeForMatch(text);

  if (!LINK_WORDS.test(normalized) || !LINK_REQUEST_VERBS.test(normalized)) return null;

  const packages = LINK_PACKAGES_WORDS.test(normalized);
  const courses = LINK_COURSES_WORDS.test(normalized);
  if (packages === courses) return null;
  return packages ? "packages" : "courses";
}

// Mensajes que ya vienen escritos desde los botones de WhatsApp de las páginas
// (app/cursos/page.tsx). Quien los manda viene DE la página: devolverle un botón a esa
// misma página no le sirve de nada.
const SITE_PREFILLED_MESSAGE =
  /^HOLA, (QUIERO RESERVAR MI CUPO PARA EL|QUIERO SABER CUANDO ES LA PROXIMA FECHA DEL) CURSO\b|^HOLA, YA ENVIE MIS DATOS PARA EL PAQUETE\b/;

function isSitePrefilledMessage(text: string): boolean {
  if (!text) return false;
  return SITE_PREFILLED_MESSAGE.test(normalizeForMatch(text).trim());
}

// ---------------------------------------------------------------------------
// Qué botón sale en este turno
// ---------------------------------------------------------------------------

type LinkButtonParams = {
  baseUrl: string | null;
  phone: string;
  secret: string | null;
  // Materiales que salen este turno, ya pasados por todas las guardas del webhook.
  intents: ReadonlySet<string>;
  // Se le pidió el formulario de datos de paquetes en este turno.
  serviceIntakeRequested: boolean;
  // Paquete que eligió, si se sabe (nombre tal cual en VIDEO_PACKAGES).
  packageName: string | null;
  // Cursos que nombra el mensaje (ids de lib/courses.ts).
  mentionedCourseIds: string[];
  // Pidió el link con todas las letras.
  linkRequest: "packages" | "courses" | null;
  // La respuesta del bot le habla de un botón (ver replyMentionsButton): entonces el botón
  // sale sí o sí, y si el texto es uno de los fijos, es el de esa página (detectButtonTextKind).
  replyMentionsButton?: boolean;
  replyButtonKind?: LinkButtonKind | null;
  // A qué viene, si pide una visita a la oficina (decide el formulario de /oficina).
  officeVisitType?: OfficeVisitType | null;
  // Turnos donde un botón estorba: pago, derivación a un asesor, cierre del lead, agente
  // de IA. Lo decide el webhook.
  blocked: boolean;
  // Último envío de cada botón a este cliente.
  lastSentAt: Partial<Record<LinkButtonKind, Date | null>>;
  now: Date;
};

const sentRecently = (lastSentAt: Date | null | undefined, now: Date) =>
  Boolean(lastSentAt) &&
  (now.getTime() - (lastSentAt as Date).getTime()) / 3_600_000 < LINK_BUTTON_RESEND_HOURS;

function decideLinkButton(params: LinkButtonParams): LinkButton | null {
  if (!params.baseUrl) return null;

  // Un texto fijo de botón manda: el mensaje le dice "dentro de este botón", así que el botón
  // de ESA página sale aunque el turno estuviera bloqueado o las guardas de línea hubieran
  // quitado el material. Si no, un mensaje apuntaría a la nada.
  const textKind = params.replyButtonKind ?? null;
  if (params.blocked && !textKind) return null;
  const forcedByText = Boolean(params.replyMentionsButton) || textKind !== null;

  if (textKind === "office") {
    const visitType = params.officeVisitType ?? "negocio";
    return {
      kind: "office",
      url: buildOfficeUrl({
        baseUrl: params.baseUrl,
        visitType,
        phone: params.phone,
        secret: params.secret,
      }),
      displayText: "Agendar visita",
      bodyText: visitType === "curso" ? OFFICE_COURSE_BUTTON_TEXT : OFFICE_BUTTON_TEXT,
      footerText: "Agenda tu visita dentro de este botón 👇",
      forced: true,
    };
  }

  const packagesTurn = textKind
    ? textKind !== "courses"
    : params.serviceIntakeRequested ||
      params.intents.has("service_packages") ||
      params.linkRequest === "packages";
  const coursesTurn = textKind
    ? textKind === "courses"
    : params.intents.has("course_flyer") || params.linkRequest === "courses";

  // Las dos líneas a la vez no deberían pasar (el webhook las separa); si pasa, no se
  // adivina a cuál página mandarlo.
  if (packagesTurn && coursesTurn && !params.linkRequest) return null;

  let button: LinkButton | null = null;

  if (packagesTurn && (textKind || params.linkRequest !== "courses")) {
    const form = textKind ? textKind === "packages_form" : params.serviceIntakeRequested;
    const url = buildPackagesUrl({
      baseUrl: params.baseUrl,
      phone: params.phone,
      packageName: params.packageName,
      secret: params.secret,
      form,
    });

    button = form
      ? {
          kind: "packages_form",
          url,
          displayText: "Llenar mis datos",
          bodyText: PACKAGES_FORM_BUTTON_TEXT,
          footerText: "Llena tus datos dentro de este botón 👇",
          forced: params.linkRequest === "packages" || forcedByText,
        }
      : {
          kind: "packages",
          url,
          displayText: "Ver paquetes",
          bodyText: PACKAGES_BUTTON_TEXT,
          footerText: "Mira nuestros paquetes dentro de este botón 👇",
          forced: params.linkRequest === "packages" || forcedByText,
        };
  } else if (coursesTurn) {
    // Un solo curso nombrado: el link baja directo a su ficha.
    const courseId =
      params.mentionedCourseIds.length === 1 ? params.mentionedCourseIds[0] : null;

    button = {
      kind: "courses",
      url: buildCoursesUrl({
        baseUrl: params.baseUrl,
        courseId,
        phone: params.phone,
        secret: params.secret,
      }),
      displayText: courseId ? "Ver el curso" : "Ver cursos",
      bodyText: renderCoursesButtonText(params.now),
      footerText: courseId ? "Mira el detalle del curso 👇" : "Mira nuestros cursos 👇",
      forced: params.linkRequest === "courses" || forcedByText,
    };
  }

  if (!button) return null;
  if (!button.forced && sentRecently(params.lastSentAt[button.kind], params.now)) return null;

  return button;
}

// ¿La respuesta del bot puede viajar como cuerpo del mensaje con botón? Así el botón no
// cuesta un mensaje aparte. No si es larga (WhatsApp corta en 1024), si trae un link (el
// de Maps tiene que verse y abrirse tal cual) o si después de ella sale más material: el
// botón tiene que quedar al final.
function canAttachButtonToReply(reply: string, mediaAfterReply: boolean): boolean {
  const text = reply.trim();
  if (!text || mediaAfterReply) return false;
  if (text.length > CTA_BODY_MAX_CHARS) return false;
  return !/https?:\/\/|www\./i.test(text);
}

export {
  CTA_BODY_MAX_CHARS,
  CTA_DISPLAY_MAX_CHARS,
  CTA_FOOTER_MAX_CHARS,
  LINK_BUTTON_RESEND_HOURS,
  LINK_SENT_MARKER_PREFIX,
  OFFICE_BUTTON_TEXT,
  OFFICE_COURSE_BUTTON_TEXT,
  PACKAGES_BUTTON_TEXT,
  PACKAGES_FORM_BUTTON_TEXT,
  SITE_VISIT_MARKER_PREFIX,
  WEB_LEAD_MARKER_PREFIX,
  buildCoursesUrl,
  buildOfficeUrl,
  buildPackagesUrl,
  canAttachButtonToReply,
  courseSlug,
  decideLinkButton,
  detectButtonTextKind,
  detectSiteLinkRequest,
  getLeadLinkSecret,
  getSiteBaseUrl,
  isSitePrefilledMessage,
  linkSentMarker,
  packageSlug,
  renderCoursesButtonText,
  replyMentionsButton,
  signLeadPhone,
  siteVisitMarker,
  verifyLeadPhone,
  webLeadMarker,
};
export type { LinkButton, LinkButtonKind, LinkButtonParams, SitePage };

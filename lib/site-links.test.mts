// Pruebas de los botones que abren /paquetes y /cursos (lib/site-links.ts).
//
//   npm test            (usa el type-stripping nativo de Node, sin dependencias)
//
// Se protege qué botón sale con cada disparador: un cliente de cursos nunca recibe el
// link de paquetes y al revés, y los turnos de pago o de derivación no llevan botón.

import assert from "node:assert/strict";
import {
  CTA_BODY_MAX_CHARS,
  CTA_DISPLAY_MAX_CHARS,
  CTA_FOOTER_MAX_CHARS,
  buildCoursesUrl,
  buildPackagesUrl,
  buildPromoFormButton,
  OFFICE_BUTTON_TEXT,
  OFFICE_COURSE_BUTTON_TEXT,
  PACKAGES_BUTTON_TEXT,
  PACKAGES_FORM_BUTTON_TEXT,
  PROMO_FORM_BUTTON_TEXT,
  WEB_LEAD_MARKER_PREFIX,
  canAttachButtonToReply,
  siteVisitMarker,
  webLeadMarker,
  decideLinkButton,
  detectButtonTextKind,
  renderCoursesButtonText,
  renderNoCourseDatesText,
  replyMentionsButton,
  detectSiteLinkRequest,
  getSiteBaseUrl,
  isSitePrefilledMessage,
  signLeadPhone,
  verifyLeadPhone,
  type LinkButtonParams,
} from "./site-links.ts";
import { VIDEO_PACKAGES } from "./packages.ts";
import { COURSES } from "./courses.ts";

let passed = 0;
const test = (name: string, fn: () => void) => {
  try {
    fn();
    passed++;
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
};

const BASE = "https://conecta-pro-kapso-vercel.vercel.app";
const PHONE = "59171234567";
const SECRET = "secreto-de-prueba";
// Con el Curso de Creación de Contenido (13 de septiembre) a la venta: el botón de cursos
// solo sale si hay un curso con fecha cargada.
const NOW = new Date("2026-09-10T15:00:00-04:00");
// Sin ningún curso con fecha cargada.
const NO_DATES = new Date("2030-01-01T09:00:00-04:00");

const turn = (overrides: Partial<LinkButtonParams> = {}): LinkButtonParams => ({
  baseUrl: BASE,
  phone: PHONE,
  secret: SECRET,
  intents: new Set<string>(),
  serviceIntakeRequested: false,
  packageName: null,
  mentionedCourseIds: [],
  linkRequest: null,
  blocked: false,
  lastSentAt: {},
  now: NOW,
  ...overrides,
});

// --- URL del sitio -------------------------------------------------------------------

test("sin variables usa el dominio de producción: el botón no puede faltar", () => {
  assert.equal(getSiteBaseUrl({}), "https://conecta-pro-kapso-vercel-seven.vercel.app");
});

test("el dominio de Vercel llega sin https y se completa", () => {
  assert.equal(
    getSiteBaseUrl({ VERCEL_PROJECT_PRODUCTION_URL: "conecta-pro-kapso-vercel.vercel.app" }),
    BASE,
  );
});

test("CONECTA_PRO_SITE_URL gana y pierde la barra final", () => {
  assert.equal(
    getSiteBaseUrl({
      CONECTA_PRO_SITE_URL: "https://conectapro.bo/",
      VERCEL_PROJECT_PRODUCTION_URL: "x.vercel.app",
    }),
    "https://conectapro.bo",
  );
});

// --- Links ---------------------------------------------------------------------------

test("el link de paquetes lleva el número firmado", () => {
  const url = new URL(buildPackagesUrl({ baseUrl: BASE, phone: PHONE, secret: SECRET }));
  assert.equal(url.pathname, "/paquetes");
  assert.equal(url.searchParams.get("wa"), PHONE);
  assert.ok(verifyLeadPhone(PHONE, url.searchParams.get("t") ?? "", SECRET));
  assert.equal(url.searchParams.get("p"), null);
});

test("el paquete elegido viaja con el mismo slug que usa la página", () => {
  for (const pkg of VIDEO_PACKAGES) {
    const url = new URL(
      buildPackagesUrl({ baseUrl: BASE, phone: PHONE, packageName: pkg.name, form: true }),
    );
    assert.match(url.searchParams.get("p") ?? "", /^[a-z]+$/);
    assert.equal(url.searchParams.get("f"), "1");
  }
});

test("la firma no sirve para otro número ni con otro secreto", () => {
  const token = signLeadPhone(PHONE, SECRET);
  assert.ok(verifyLeadPhone(PHONE, token, SECRET));
  assert.ok(!verifyLeadPhone("59170000000", token, SECRET));
  assert.ok(!verifyLeadPhone(PHONE, token, "otro"));
  assert.ok(!verifyLeadPhone(PHONE, "", SECRET));
  assert.ok(!verifyLeadPhone(PHONE, "no-hex", SECRET));
});

test("cada curso tiene su ancla en /cursos", () => {
  for (const course of COURSES) {
    const url = new URL(buildCoursesUrl({ baseUrl: BASE, courseId: course.id }));
    assert.equal(url.pathname, "/cursos");
    assert.equal(url.hash, `#${course.id.replace(/_/g, "-")}`);
  }
  assert.equal(new URL(buildCoursesUrl({ baseUrl: BASE })).hash, "#cursos");
});

// --- Disparadores --------------------------------------------------------------------

test("FLUJO B consulta general → Ver paquetes", () => {
  const button = decideLinkButton(turn({ intents: new Set(["service_packages"]) }));
  assert.equal(button?.kind, "packages");
  assert.equal(button?.displayText, "Ver paquetes");
  assert.equal(new URL(button!.url).pathname, "/paquetes");
});

test("FLUJO B intención clara (formulario) → Llenar mis datos con el paquete", () => {
  const pkg = VIDEO_PACKAGES[VIDEO_PACKAGES.length - 1];
  const button = decideLinkButton(
    turn({
      intents: new Set(["service_packages"]),
      serviceIntakeRequested: true,
      packageName: pkg.name,
    }),
  );
  assert.equal(button?.kind, "packages_form");
  assert.equal(button?.displayText, "Llenar mis datos");
  assert.ok(new URL(button!.url).searchParams.get("p"));
});

test("formulario sin paquete elegido → abre la lista de paquetes", () => {
  const button = decideLinkButton(turn({ serviceIntakeRequested: true }));
  assert.equal(button?.kind, "packages_form");
  assert.equal(new URL(button!.url).searchParams.get("p"), null);
});

test("FLUJO A cursos → Ver cursos, nunca paquetes", () => {
  const button = decideLinkButton(turn({ intents: new Set(["course_flyer", "location_video"]) }));
  assert.equal(button?.kind, "courses");
  assert.equal(button?.displayText, "Ver cursos");
  assert.equal(new URL(button!.url).pathname, "/cursos");
});

test("un curso nombrado → link directo a su ficha", () => {
  const button = decideLinkButton(
    turn({ intents: new Set(["course_flyer"]), mentionedCourseIds: ["capcut_pro"] }),
  );
  assert.equal(button?.displayText, "Ver el curso");
  assert.equal(new URL(button!.url).hash, "#capcut-pro");
});

test("dos cursos nombrados → la lista completa", () => {
  const button = decideLinkButton(
    turn({
      intents: new Set(["course_flyer"]),
      mentionedCourseIds: ["capcut_pro", "creacion_contenido"],
    }),
  );
  assert.equal(new URL(button!.url).hash, "#cursos");
});

test("agente de IA, QR y promo sueltos no llevan botón", () => {
  for (const intent of ["ai_agent_flyer", "payment_qr", "location_video", "service_packages_promo"]) {
    assert.equal(decideLinkButton(turn({ intents: new Set([intent]) })), null, intent);
  }
});

test("turno bloqueado (pago, derivación, cierre) → sin botón", () => {
  assert.equal(
    decideLinkButton(turn({ intents: new Set(["course_flyer"]), blocked: true })),
    null,
  );
  assert.equal(
    decideLinkButton(turn({ serviceIntakeRequested: true, blocked: true })),
    null,
  );
});

test("sin URL válida del sitio → sin botón", () => {
  assert.equal(decideLinkButton(turn({ baseUrl: null, intents: new Set(["service_packages"]) })), null);
});

test("cursos y paquetes a la vez sin pedido explícito → no se adivina", () => {
  assert.equal(
    decideLinkButton(turn({ intents: new Set(["service_packages", "course_flyer"]) })),
    null,
  );
});

test("no se repite dentro de 24 h, sí después", () => {
  const intents = new Set(["service_packages"]);
  const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);

  assert.equal(decideLinkButton(turn({ intents, lastSentAt: { packages: hoursAgo(2) } })), null);
  assert.equal(
    decideLinkButton(turn({ intents, lastSentAt: { packages: hoursAgo(25) } }))?.kind,
    "packages",
  );
});

test("haber visto los paquetes no bloquea el botón del formulario", () => {
  const button = decideLinkButton(
    turn({
      intents: new Set(["service_packages"]),
      serviceIntakeRequested: true,
      lastSentAt: { packages: new Date(NOW.getTime() - 600_000) },
    }),
  );
  assert.equal(button?.kind, "packages_form");
});

test("pedir el link lo manda aunque ya lo tenga", () => {
  const button = decideLinkButton(
    turn({ linkRequest: "courses", lastSentAt: { courses: new Date(NOW.getTime() - 60_000) } }),
  );
  assert.equal(button?.kind, "courses");
  assert.equal(button?.forced, true);
});

test("los textos respetan los límites de WhatsApp", () => {
  const cases = [
    turn({ intents: new Set(["service_packages"]) }),
    turn({ serviceIntakeRequested: true }),
    turn({ intents: new Set(["course_flyer"]) }),
    turn({ intents: new Set(["course_flyer"]), mentionedCourseIds: ["capcut_pro"] }),
  ];
  for (const params of cases) {
    const button = decideLinkButton(params)!;
    assert.ok(button.displayText.length <= CTA_DISPLAY_MAX_CHARS, button.displayText);
    assert.ok(button.footerText.length <= CTA_FOOTER_MAX_CHARS, button.footerText);
    assert.ok(button.bodyText.length <= CTA_BODY_MAX_CHARS);
  }
});

// --- Pedido explícito del link -------------------------------------------------------

test("detecta el pedido del link de cada página", () => {
  assert.equal(detectSiteLinkRequest("me pasas el link de los paquetes?"), "packages");
  assert.equal(detectSiteLinkRequest("tienen página web de los cursos"), "courses");
  assert.equal(detectSiteLinkRequest("no me abre el link del formulario"), "packages");
  assert.equal(detectSiteLinkRequest("mándame el enlace del curso de capcut"), "courses");
});

test("no confunde menciones sueltas con un pedido", () => {
  assert.equal(detectSiteLinkRequest("quiero info de los paquetes"), null);
  assert.equal(detectSiteLinkRequest("pásame el link"), null);
  assert.equal(detectSiteLinkRequest("link de cursos y paquetes"), null);
  assert.equal(detectSiteLinkRequest("hacen páginas web para negocios?"), null);
});

test("reconoce los mensajes prellenados de las páginas", () => {
  assert.ok(isSitePrefilledMessage("Hola, quiero reservar mi cupo para el Curso de Edición Persuasiva en CapCut Pro"));
  assert.ok(isSitePrefilledMessage("Hola, quiero saber cuándo es la próxima fecha del Curso de Creación de Contenido"));
  assert.ok(isSitePrefilledMessage("Hola, ya envié mis datos para el paquete Pro 🙌"));
  assert.ok(!isSitePrefilledMessage("Hola, quiero info del curso"));
});

// --- Botón pegado a la respuesta -----------------------------------------------------

test("la respuesta corta sin links lleva el botón pegado", () => {
  assert.ok(canAttachButtonToReply("¡Perfecto! 🙌 Necesitamos estos datos...", false));
});

test("respuesta larga, con link de Maps o con material después → botón aparte", () => {
  assert.ok(!canAttachButtonToReply("a".repeat(CTA_BODY_MAX_CHARS + 1), false));
  assert.ok(!canAttachButtonToReply("Ubicación: https://maps.app.goo.gl/abc", false));
  assert.ok(!canAttachButtonToReply("Texto corto", true));
  assert.ok(!canAttachButtonToReply("   ", false));
});

// --- Textos fijos de los botones -----------------------------------------------------

test("cada texto fijo se reconoce como el de su página", () => {
  assert.equal(detectButtonTextKind(PACKAGES_BUTTON_TEXT), "packages");
  assert.equal(detectButtonTextKind(PACKAGES_FORM_BUTTON_TEXT), "packages_form");
  assert.equal(detectButtonTextKind(renderCoursesButtonText(NOW)), "courses");
  assert.equal(
    detectButtonTextKind("¡Genial! 🙌 Para avanzar solo falta que llenes tus datos dentro de este botón 👇"),
    "packages_form",
  );
  assert.equal(detectButtonTextKind("Te paso el QR para pagar tu cupo"), null);
});

test("el texto de paquetes nombra la cantidad real de paquetes", () => {
  assert.ok(PACKAGES_BUTTON_TEXT.includes(`${VIDEO_PACKAGES.length} paquetes`));
  assert.ok(PACKAGES_BUTTON_TEXT.length <= CTA_BODY_MAX_CHARS);
});

test("sin ningún curso con fecha cargada no sale el botón de cursos, pase lo que pase", () => {
  const cases = [
    turn({ now: NO_DATES, intents: new Set(["course_flyer"]) }),
    turn({ now: NO_DATES, linkRequest: "courses" }),
    turn({ now: NO_DATES, replyMentionsButton: true, replyButtonKind: "courses" }),
  ];
  for (const params of cases) assert.equal(decideLinkButton(params), null);
});

test("sin fechas, el texto es el de 'no hay fechas confirmadas' con saludo según la hora", () => {
  assert.equal(
    renderNoCourseDatesText(NO_DATES),
    "¡Buenos días! 😊 Sobre los cursos, por ahora no tenemos fechas oficiales confirmadas. Puedes seguirnos como ConectaPro o @marketero7 en TikTok, ahí anunciamos las nuevas fechas apenas salen.",
  );
  assert.match(renderNoCourseDatesText(new Date("2030-01-01T15:00:00-04:00")), /^¡Buenas tardes!/);
  assert.match(renderNoCourseDatesText(new Date("2030-01-01T21:00:00-04:00")), /^¡Buenas noches!/);
  // No le habla de ningún botón: si no, el bot buscaría uno que no sale.
  assert.equal(detectButtonTextKind(renderNoCourseDatesText(NO_DATES)), null);
  assert.ok(!replyMentionsButton(renderNoCourseDatesText(NO_DATES)));
});

test("con la preventa cerrada el texto del botón no invita a pedir el QR", () => {
  // Curso de CapCut: 20 de septiembre a las 16:00; la preventa cierra 10 minutos antes.
  const doorOnly = new Date("2026-09-20T15:55:00-04:00");
  assert.doesNotMatch(renderCoursesButtonText(doorOnly), /QR/);
  assert.match(renderCoursesButtonText(NOW), /QR/);
});

test("el texto fijo trae su botón aunque ya lo tenga o el turno esté bloqueado", () => {
  const button = decideLinkButton(
    turn({
      blocked: true,
      replyMentionsButton: true,
      replyButtonKind: "packages",
      lastSentAt: { packages: new Date(NOW.getTime() - 60_000) },
    }),
  );
  assert.equal(button?.kind, "packages");
  assert.equal(button?.forced, true);
});

test("el texto del formulario trae el botón del formulario aunque el modelo no marcara nada", () => {
  const button = decideLinkButton(
    turn({ replyMentionsButton: true, replyButtonKind: "packages_form", packageName: "Pro" }),
  );
  assert.equal(button?.kind, "packages_form");
  assert.equal(new URL(button!.url).searchParams.get("p"), "pro");
});

test("el texto de cursos trae el botón de cursos aunque una guarda quitara el intent", () => {
  assert.equal(
    decideLinkButton(turn({ replyMentionsButton: true, replyButtonKind: "courses" }))?.kind,
    "courses",
  );
});

test("reconoce cuándo la respuesta habla de un botón", () => {
  assert.ok(replyMentionsButton(PACKAGES_BUTTON_TEXT));
  assert.ok(replyMentionsButton("abajo tienes el botón para abrirla 👇"));
  assert.ok(!replyMentionsButton("¡Sí! El Pro trae dron 🚁"));
});

// --- Visita a la oficina -------------------------------------------------------------

test("los textos de visita traen el botón Agendar visita al formulario que toca", () => {
  assert.equal(detectButtonTextKind(OFFICE_BUTTON_TEXT), "office");
  assert.equal(detectButtonTextKind(OFFICE_COURSE_BUTTON_TEXT), "office");

  for (const visitType of ["negocio", "agente", "curso"] as const) {
    const button = decideLinkButton(
      turn({ replyMentionsButton: true, replyButtonKind: "office", officeVisitType: visitType, blocked: true }),
    );
    assert.equal(button?.kind, "office");
    assert.equal(button?.displayText, "Agendar visita");
    const url = new URL(button!.url);
    assert.equal(url.pathname, "/oficina");
    assert.equal(url.searchParams.get("tipo"), visitType);
    assert.ok(verifyLeadPhone(PHONE, url.searchParams.get("t") ?? "", SECRET));
  }
});

test("el link de cursos también lleva el número firmado (para saber si abrió la página)", () => {
  const url = new URL(buildCoursesUrl({ baseUrl: BASE, phone: PHONE, secret: SECRET }));
  assert.equal(url.searchParams.get("wa"), PHONE);
  assert.ok(verifyLeadPhone(PHONE, url.searchParams.get("t") ?? "", SECRET));
});

test("las marcas de la web tienen el prefijo que buscan el webhook y /cliente", () => {
  assert.equal(webLeadMarker("paquetes"), "[TELEGRAM_LEAD_SENT] lead recibido desde la página /paquetes");
  assert.ok(webLeadMarker("oficina").startsWith(WEB_LEAD_MARKER_PREFIX));
  assert.equal(siteVisitMarker("cursos"), "[SITE_VISIT:cursos]");
});

test("quien acepta la promo recibe el formulario de la promo, no el de los paquetes", () => {
  const button = decideLinkButton(turn({ serviceIntakeRequested: true, promoSlug: "promo-4-videos" }));
  assert.equal(button?.kind, "packages_form");
  assert.equal(button?.bodyText, PROMO_FORM_BUTTON_TEXT);
  const url = new URL(button!.url);
  assert.equal(url.searchParams.get("p"), "promo-4-videos");
  assert.equal(url.searchParams.get("f"), "1");
});

test("la promo gana sobre un paquete viejo guardado en la conversación", () => {
  const url = new URL(
    buildPackagesUrl({ baseUrl: BASE, packageName: "Pro", promoSlug: "promo-4-videos", form: true }),
  );
  assert.equal(url.searchParams.get("p"), "promo-4-videos");
});

test("con la promo vigente, 'Ver paquetes' sigue abriendo la página entera", () => {
  const button = decideLinkButton(
    turn({ intents: new Set(["service_packages"]), promoSlug: "promo-4-videos" }),
  );
  assert.equal(button?.kind, "packages");
  assert.equal(new URL(button!.url).searchParams.get("p"), null);
});

test("el texto del formulario de la promo se reconoce como botón de formulario", () => {
  assert.equal(detectButtonTextKind(PROMO_FORM_BUTTON_TEXT), "packages_form");
  assert.ok(replyMentionsButton(PROMO_FORM_BUTTON_TEXT));
  assert.ok(PROMO_FORM_BUTTON_TEXT.length <= CTA_BODY_MAX_CHARS);
});

test("el botón de la promo abre directo su formulario, con el número firmado", () => {
  const button = buildPromoFormButton({ baseUrl: BASE, phone: PHONE, secret: SECRET, promoSlug: "promo-4-videos" });
  const url = new URL(button.url);
  assert.equal(url.pathname, "/paquetes");
  assert.equal(url.searchParams.get("p"), "promo-4-videos");
  assert.equal(url.searchParams.get("f"), "1");
  assert.ok(verifyLeadPhone(PHONE, url.searchParams.get("t") ?? "", SECRET));
  assert.ok(button.forced);
  assert.ok(button.displayText.length <= CTA_DISPLAY_MAX_CHARS);
  assert.ok([...button.footerText].length <= CTA_FOOTER_MAX_CHARS);
});

console.log(`${passed} pruebas de botones a las páginas OK`);

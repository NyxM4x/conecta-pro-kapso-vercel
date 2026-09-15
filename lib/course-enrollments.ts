// INSCRITOS DEL CURSO — botón "🎓 Inscritos del curso" del grupo de Telegram.
//
// Reemplaza a la lista general de pagos: lo que el equipo necesitaba era saber quiénes
// pagaron cada fecha del curso y con qué nombre agregarlos al grupo. Hoy eso se arma leyendo
// chat por chat ("me pasa el nombre de la otra persona").
//
// Cómo se arma, todo desde la base de datos y sin depender de que el bot haya etiquetado bien:
//   1. Los pagos del rango de la fecha (ver lib/payments-report.ts), solo los de CURSO.
//   2. Por cliente: pago confirmado (visión o alerta 💰) o por revisar (el bot no lo confirmó).
//   3. El nombre completo y el celular que el alumno escribió alrededor del comprobante
//      (pueden ser varios: "2 cupos"). Si no escribió nada, su nombre de perfil de WhatsApp.
//
// Funciones puras: el route handler consulta Supabase y les pasa las filas.

import {
  COURSES,
  COURSE_INFO_MINUTES_AFTER_START,
  getCourseStatus,
  formatCourseDate,
} from "./courses.ts";
import type { Course } from "./courses.ts";
import type { PaymentEntry } from "./payments-report.ts";

type ClientText = { phone: string; content: string; createdAt: string };

type Enrollment = {
  phone: string;
  status: "confirmed" | "review";
  paidAt: string;
  alerted: boolean;
  names: string[];
  phones: string[];
  profileName: string | null;
  evidence: string;
};

// Pagos que se cuentan para una fecha: desde 35 días antes (la preventa) hasta 2 días después
// (quien paga en la puerta y manda su nombre más tarde). Si otro curso se dictó dentro de esos
// 35 días, la ventana arranca cuando terminó ese curso: sus pagos no son de esta fecha.
const ENROLLMENT_DAYS_BEFORE = 35;
const ENROLLMENT_DAYS_AFTER = 2;
// Cursos que se ofrecen en el botón: próximos, en marcha o dictados hace poco.
const RECENT_COURSE_DAYS = 14;
// Mensajes del alumno que se miran para buscar su nombre: los de la misma ráfaga del
// comprobante y las horas siguientes (el nombre se pide justo después del pago). Una ventana
// más amplia metía frases de otras conversaciones ("vengo del live", "nadie me contactó").
const NAME_LOOKBACK_MINUTES = 10;
const NAME_LOOKAHEAD_HOURS = 12;

const DAY = 24 * 60 * 60_000;

function getEnrollmentWindow(
  course: Course,
  catalog: Course[] = COURSES,
): { sinceIso: string; untilIso: string } {
  const start = new Date(course.startsAt).getTime();
  const previousEnd = catalog
    .map((other) => new Date(other.startsAt).getTime() + COURSE_INFO_MINUTES_AFTER_START * 60_000)
    .filter((end) => end < start)
    .reduce((latest, end) => Math.max(latest, end), 0);

  return {
    sinceIso: new Date(Math.max(start - ENROLLMENT_DAYS_BEFORE * DAY, previousEnd)).toISOString(),
    untilIso: new Date(start + ENROLLMENT_DAYS_AFTER * DAY).toISOString(),
  };
}

// Cursos para los que tiene sentido pedir la lista, del más reciente al más lejano.
function listReportableCourses(now: Date): Course[] {
  return COURSES.filter((course) => {
    if (getCourseStatus(course, now) !== "finished") return true;
    return now.getTime() - new Date(course.startsAt).getTime() <= RECENT_COURSE_DAYS * DAY;
  }).sort((a, b) => b.startsAt.localeCompare(a.startsAt));
}

const normalize = (text: string) =>
  String(text ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase();

// ¿Este pago es de un curso? "yes" / "no" / "maybe". Paquetes y agente de IA quedan fuera.
// "maybe" = material mandado a mano por el equipo y pago sin confirmar: el equipo manda
// capturas en muchos chats que no son de cursos, así que entra solo si el cliente escribió un
// nombre de inscrito (ver buildCourseEnrollments).
function classifyCoursePayment(entry: PaymentEntry): "yes" | "no" | "maybe" {
  if (entry.category === "discarded" || entry.category === "unrelated") return "no";
  if (entry.context.startsWith("🎬") || entry.context.startsWith("🤖")) return "no";
  if (entry.context.includes("Curso")) return "yes";

  const mentionsCourse = /\b(CURSO|CURSOS|CLASE|CLASES|INSCRI\w*|CUPO)\b/.test(normalize(entry.detail));
  if (mentionsCourse) return "yes";
  if (entry.context.startsWith("❔ Material enviado a mano")) {
    return entry.category === "confirmed" ? "yes" : "maybe";
  }
  return "no";
}

// Celular boliviano: 8 dígitos que empiezan con 6 o 7, con o sin +591 y separadores.
const BOLIVIAN_MOBILE = /(?:\+?\s*591[\s-]*)?\b([67](?:[\s-]?\d){7})\b/g;

// Prefijos que la gente escribe antes del dato ("Nombre completo:", "Mi número es").
const FIELD_PREFIX =
  /^\s*(?:📌\s*)?(?:(?:MI\s+)?NOMBRE(?:\s+COMPLETO)?(?:\s+ES)?|NOMBRES?|SOY|(?:MI\s+)?(?:NUMERO|NRO|CELULAR|CEL|TELEFONO|TEL|WHATSAPP)(?:\s+DE\s+(?:CELULAR|TELEFONO))?(?:\s+ES)?)\s*[:.\-]?\s*/;

// Palabras que delatan una frase de conversación, no un nombre: saludos, pronombres, verbos
// y vocabulario del chat que aparecieron en los mensajes reales alrededor de los pagos.
const NOT_A_NAME = new RegExp(
  `\\b(${[
    "HOLA", "BUENAS", "BUENOS", "BUEN", "DIA", "DIAS", "TARDES", "NOCHES", "GRACIAS", "GRAC", "OKI", "OK", "OKEY", "LISTO", "SALUDOS",
    "CURSO", "CURSOS", "CLASE", "CLASES", "CREACION", "CONTENIDO", "EDICION", "CAPCUT", "LIVE", "PROMO", "TALLER",
    "QR", "PAGO", "PAGAR", "PAGUE", "PAGADO", "COMPROBANTE", "PRECIO", "DEVOLUCION", "CUPO", "CUPOS", "INSCRIBIR", "INSCRIPCION",
    "QUIERO", "QUISIERA", "QUERIA", "GUSTARIA", "SABER", "PUEDE", "PUEDO", "PUEDES", "PODRIA", "HACE", "HACER", "HICIERON", "ISIERON",
    "TENGO", "TIENE", "VOY", "VENGO", "VA", "ESTA", "ESTOY", "ESTAN", "ES", "SON", "ERA", "FUE", "SERA", "HAY",
    "ENVIO", "ENVIE", "MANDO", "MANDE", "PASO", "PASE", "LLEGO", "ESCRIBO", "ESPERO", "AVISA", "DIJE", "DICE", "SALE", "INTENTE",
    "CONTACTO", "CONMIGO", "CONTIGO", "NADIE", "ALGUIEN", "TODO", "TODOS", "NADA", "MAS", "MENOS", "AHORRA", "AHORA", "AUN", "RECIEN",
    "COMO", "CUANDO", "DONDE", "QUE", "QUIEN", "CUAL", "PORFA", "PORF", "FAVOR", "DISCULPE", "ESTIMADO", "ESTIMADA", "JOVEN", "SENORITA",
    "AHI", "AQUI", "ALLA", "ESO", "ESE", "ESA", "ESTE", "SOLO", "TAMBIEN", "PERO", "YA", "SI", "NO", "TE", "SE", "ME", "NOS",
    "EL", "MI", "MIS", "TU", "SU", "SUS", "USTED", "USTEDES", "YO", "PARA", "CON", "SIN", "UNA", "UN", "UNO", "POR", "EN", "AL", "LO", "LE",
    "MANANA", "HOY", "AYER", "HORA", "HORAS", "LUGAR", "UBICACION", "GRUPO", "AGREGAR", "NOMBRE", "NUMERO", "CELULAR", "TELEFONO",
    "HIJA", "HIJO", "AMIGA", "AMIGO", "OTRA", "OTRO", "PERSONA", "PERSONAS", "VIDEO", "VIDEOS", "IMAGEN", "RECIBIDA", "AUDIO", "DOCUMENTO",
    "WHATSAPP", "WHASTAPP", "WPP", "FACEBOOK", "TIKTOK", "INSTAGRAM", "META", "PANTALLA", "FOTO", "CONTRASENA", "CONFIGURACION",
    "PAQUETE", "PAQUETES", "MENSUALES", "GUION", "GRABAR", "ENTREVISTAS", "SUBIR", "OCULTARLO", "PORTAFOLIO", "ROJO", "ENVANO",
    "DEBE", "DEBO", "SALIR", "ENTRAR", "INGRESAR", "CUENTA", "CODIGO", "CORREO", "LINK", "ENLACE", "CHINA",
  ].join("|")})\\b`,
);

// Muletillas al inicio que no invalidan el nombre que sigue ("Si, Maria Estefani").
const LEADING_FILLER = /^\s*(?:SI|OK|YA|LISTO|AQUI|AHI|ES|SOY)\b[\s,.:]*/;

// Nombre y celular que aparecen en un mensaje. Un mensaje puede traer varios nombres, uno
// por línea ("Joryelina Palma ⏎ Susana Galean").
function extractContactLines(text: string): { names: string[]; phones: string[] } {
  const names: string[] = [];
  const phones: string[] = [];

  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line) continue;

    for (const match of line.matchAll(BOLIVIAN_MOBILE)) {
      phones.push(match[1].replace(/\D/g, ""));
    }

    // Se trabaja sobre la versión normalizada para detectar, pero se muestra lo que escribió.
    line = line.replace(BOLIVIAN_MOBILE, " ").replace(/\s+/g, " ").trim();
    let normalized = normalize(line);

    const prefix = normalized.match(FIELD_PREFIX);
    if (prefix && prefix[0].length > 0) {
      line = line.slice(prefix[0].length).trim();
      normalized = normalize(line);
    }

    const filler = normalized.match(LEADING_FILLER);
    if (filler && filler[0].length > 0) {
      line = line.slice(filler[0].length).trim();
      normalized = normalize(line);
    }

    // Un nombre: 2 a 6 palabras solo de letras, sin iniciales sueltas ("O la china", "Drjara d")
    // salvo partículas (de, la, y), con al menos dos palabras de 3+ letras.
    const tokens = normalized.split(/\s+/).filter(Boolean);
    const particles = new Set(["DE", "DEL", "LA", "LAS", "LOS", "Y"]);
    const looksLikeName =
      tokens.length >= 2 &&
      tokens.length <= 6 &&
      tokens.every((token) => /^[A-Z]+$/.test(token)) &&
      tokens.every((token) => token.length >= 2 || particles.has(token)) &&
      tokens.filter((token) => token.length >= 3 && !particles.has(token)).length >= 2 &&
      !NOT_A_NAME.test(normalized);

    if (looksLikeName) names.push(line.replace(/[.,;]+$/, ""));
  }

  return { names, phones };
}

const unique = (values: string[]) => {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = normalize(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

function buildCourseEnrollments(params: {
  payments: PaymentEntry[];
  texts: ClientText[];
  profileNames: Map<string, string>;
}): Enrollment[] {
  const byPhone = new Map<string, { entries: PaymentEntry[]; onlyMaybe: boolean }>();
  for (const entry of params.payments) {
    const kind = classifyCoursePayment(entry);
    if (kind === "no") continue;
    const current = byPhone.get(entry.phone) ?? { entries: [], onlyMaybe: true };
    current.entries.push(entry);
    current.onlyMaybe &&= kind === "maybe";
    byPhone.set(entry.phone, current);
  }

  const enrollments: Enrollment[] = [];

  for (const [phone, { entries, onlyMaybe }] of byPhone) {
    const sorted = [...entries].sort((a, b) => a.firstAt.localeCompare(b.firstAt));
    const confirmed = sorted.some((e) => e.category === "confirmed");
    const from = new Date(sorted[0].firstAt).getTime() - NAME_LOOKBACK_MINUTES * 60_000;
    const until = new Date(sorted[sorted.length - 1].lastAt).getTime() + NAME_LOOKAHEAD_HOURS * 3600_000;

    const names: string[] = [];
    const phones: string[] = [];
    for (const text of params.texts) {
      if (text.phone !== phone) continue;
      const t = new Date(text.createdAt).getTime();
      if (t < from || t > until) continue;
      const found = extractContactLines(text.content);
      names.push(...found.names);
      phones.push(...found.phones);
    }

    // Pago dudoso sin ningún nombre de inscrito: no hay señal de que sea del curso.
    if (onlyMaybe && names.length === 0) continue;

    const evidenceEntry = sorted.find((e) => e.category === "confirmed") ?? sorted[0];

    enrollments.push({
      phone,
      status: confirmed ? "confirmed" : "review",
      paidAt: evidenceEntry.firstAt,
      alerted: sorted.some((e) => e.alerted),
      names: unique(names),
      phones: [...new Set(phones)],
      profileName: params.profileNames.get(phone) ?? null,
      evidence: evidenceEntry.detail,
    });
  }

  return enrollments.sort((a, b) => a.paidAt.localeCompare(b.paidAt));
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function formatBoliviaShort(iso: string): string {
  const parts = new Intl.DateTimeFormat("es-BO", {
    timeZone: "America/La_Paz",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("day")}/${get("month")} ${get("hour")}:${get("minute")}`;
}

function renderEnrollment(enrollment: Enrollment, index: number): string {
  const digits = enrollment.phone.replace(/\D/g, "");
  const localPhone = digits.startsWith("591") ? digits.slice(3) : digits;
  const [firstName, ...otherNames] = enrollment.names;

  const lines = [
    firstName
      ? `<b>${index}.</b> 👤 ${escapeHtml(firstName)}`
      : `<b>${index}.</b> 👤 <i>(no escribió su nombre${enrollment.profileName ? ` — perfil: ${escapeHtml(enrollment.profileName)}` : ""})</i>`,
    ...otherNames.map((name) => `     ➕ ${escapeHtml(name)}`),
    `     📱 ${[...new Set([localPhone, ...enrollment.phones])].join(" · ")} · <a href="https://wa.me/${digits}">abrir chat</a>`,
    `     💰 ${formatBoliviaShort(enrollment.paidAt)}${enrollment.alerted ? " · 🔔 alerta" : ""}${enrollment.status === "review" && enrollment.evidence ? ` · ${escapeHtml(enrollment.evidence)}` : ""}`,
  ];

  return lines.join("\n");
}

function renderCourseEnrollments(params: { course: Course; enrollments: Enrollment[] }): string[] {
  const confirmed = params.enrollments.filter((e) => e.status === "confirmed");
  const review = params.enrollments.filter((e) => e.status === "review");
  const people = confirmed.reduce((total, e) => total + Math.max(1, e.names.length), 0);

  const blocks = [
    [
      `🎓 <b>Inscritos — ${escapeHtml(params.course.name)}</b>`,
      `📅 ${formatCourseDate(params.course.startsAt)}`,
      `✅ ${confirmed.length} con pago confirmado (~${people} personas) · ❓ ${review.length} por revisar`,
    ].join("\n"),
  ];

  if (confirmed.length > 0) {
    blocks.push("\n✅ <b>Pago confirmado</b>");
    confirmed.forEach((e, i) => blocks.push(renderEnrollment(e, i + 1)));
  }

  if (review.length > 0) {
    blocks.push("\n❓ <b>Por revisar</b> — mandaron algo que parece pago pero el bot no lo confirmó");
    review.forEach((e, i) => blocks.push(renderEnrollment(e, i + 1)));
  }

  if (params.enrollments.length === 0) {
    blocks.push("\nTodavía no hay pagos registrados para esta fecha.");
  }

  return blocks;
}

export {
  getEnrollmentWindow,
  listReportableCourses,
  extractContactLines,
  buildCourseEnrollments,
  renderCourseEnrollments,
};
export type { ClientText, Enrollment };

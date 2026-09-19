// PAGOS — botón "💰 Pagos" (/pagos) del grupo de Telegram. Antes se llamaba "Inscritos".
//
// Lo que el equipo necesita es saber quiénes pagaron cada fecha del curso y con qué nombre
// agregarlos al grupo, y aparte los pagos de paquetes y otros motivos.
//
// Cómo se arma, todo desde la base de datos:
//   1. Los pagos del rango de la fecha (ver lib/payments-report.ts).
//   2. A qué curso corresponde cada uno: lo dice la ETIQUETA de su alerta 💰 (el cliente
//      indicó el curso o el motivo, ver lib/payment-alerts.ts). Sin etiqueta —pagos viejos o
//      sin alerta— se decide como antes, por contexto y por fecha, y se marca 📅.
//   3. Por cliente: pago confirmado (visión o alerta 💰) o por revisar (el bot no lo confirmó).
//   4. El nombre completo y el celular que el alumno mandó (en la alerta o alrededor del
//      comprobante; pueden ser varios: "2 cupos"). Si no escribió nada, su perfil de WhatsApp.
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
import { renderTagLabel } from "./payment-alerts.ts";
import type { PaymentTag } from "./payment-alerts.ts";
import { extractContactLines } from "./contact-lines.ts";

type ClientText = { phone: string; content: string; createdAt: string };

// Cómo se decidió que el pago es de este curso.
//   tagged         = la alerta lo etiquetó con este curso.
//   course_unknown = pagó un curso pero no dijo cuál (había más de una fecha a la venta).
//   by_date        = sin etiqueta: por contexto y fecha, como antes.
type EnrollmentSource = "tagged" | "course_unknown" | "by_date";

type Enrollment = {
  phone: string;
  status: "confirmed" | "review";
  paidAt: string;
  alerted: boolean;
  names: string[];
  phones: string[];
  profileName: string | null;
  evidence: string;
  source: EnrollmentSource;
};

// Pagos que se cuentan para una fecha: desde 35 días antes (la preventa) hasta 2 días después
// (quien paga en la puerta y manda su nombre más tarde). Si otro curso se dictó dentro de esos
// 35 días, los pagos SIN etiqueta de antes de que terminara son de ese curso; los etiquetados
// con esta fecha cuentan igual (con dos fechas a la venta a la vez, la fecha del pago no dice
// de qué curso es: ese era el error que la etiqueta corrige).
const ENROLLMENT_DAYS_BEFORE = 35;
const ENROLLMENT_DAYS_AFTER = 2;
// Si el curso se reprogramó, la etiqueta guarda la fecha vieja: se acepta hasta esta
// diferencia. Una edición nueva del mismo curso suele estar a más de un mes.
const RESCHEDULE_TOLERANCE_DAYS = 14;
// Cursos que se ofrecen en el botón: próximos, en marcha o dictados hace poco.
const RECENT_COURSE_DAYS = 14;
// Mensajes del alumno que se miran para buscar su nombre: los de la misma ráfaga del
// comprobante y las horas siguientes (el nombre se pide justo después del pago). Una ventana
// más amplia metía frases de otras conversaciones ("vengo del live", "nadie me contactó").
const NAME_LOOKBACK_MINUTES = 10;
const NAME_LOOKAHEAD_HOURS = 12;

const DAY = 24 * 60 * 60_000;

// sinceIso     = desde cuándo cuentan los pagos SIN etiqueta.
// loadSinceIso = desde cuándo se leen los pagos (incluye los etiquetados de antes de que
//                terminara el curso anterior).
function getEnrollmentWindow(
  course: Course,
  catalog: Course[] = COURSES,
): { sinceIso: string; untilIso: string; loadSinceIso: string } {
  const start = new Date(course.startsAt).getTime();
  const previousEnd = catalog
    .map((other) => new Date(other.startsAt).getTime() + COURSE_INFO_MINUTES_AFTER_START * 60_000)
    .filter((end) => end < start)
    .reduce((latest, end) => Math.max(latest, end), 0);

  return {
    sinceIso: new Date(Math.max(start - ENROLLMENT_DAYS_BEFORE * DAY, previousEnd)).toISOString(),
    untilIso: new Date(start + ENROLLMENT_DAYS_AFTER * DAY).toISOString(),
    loadSinceIso: new Date(start - ENROLLMENT_DAYS_BEFORE * DAY).toISOString(),
  };
}

// ¿Esta etiqueta es de este curso? Mismo curso y misma fecha (o una reprogramación cercana).
function tagMatchesCourse(tag: PaymentTag, course: Course): boolean {
  if (tag.kind !== "course" || tag.courseId !== course.id) return false;
  const diff = Math.abs(new Date(tag.courseStartsAt).getTime() - new Date(course.startsAt).getTime());
  return diff <= RESCHEDULE_TOLERANCE_DAYS * DAY;
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

// El extractor de nombre y celular vive en lib/contact-lines.ts (lo usa también la alerta 💰).

const unique = (values: string[]) => {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = normalize(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

// Nombres y celulares de un cliente: los que mandó para la alerta 💰 y los que escribió
// alrededor de sus pagos.
function collectContactData(
  phone: string,
  entries: PaymentEntry[],
  texts: ClientText[],
): { names: string[]; phones: string[] } {
  const from = new Date(entries[0].firstAt).getTime() - NAME_LOOKBACK_MINUTES * 60_000;
  const until = new Date(entries[entries.length - 1].lastAt).getTime() + NAME_LOOKAHEAD_HOURS * 3600_000;

  const names: string[] = entries.flatMap((e) => e.taggedNames ?? []);
  const phones: string[] = [];
  for (const text of texts) {
    if (text.phone !== phone) continue;
    const t = new Date(text.createdAt).getTime();
    if (t < from || t > until) continue;
    const found = extractContactLines(text.content);
    names.push(...found.names);
    phones.push(...found.phones);
  }

  return { names: unique(names), phones: [...new Set(phones)] };
}

// ¿Este pago va en la lista de este curso? Primero la etiqueta; sin etiqueta, como antes.
function classifyForCourse(
  entry: PaymentEntry,
  course: Course | undefined,
  untaggedSinceIso: string | undefined,
): { kind: "yes" | "no" | "maybe"; source: EnrollmentSource } {
  const tag = entry.tag ?? null;

  if (tag?.kind === "course") {
    return { kind: !course || tagMatchesCourse(tag, course) ? "yes" : "no", source: "tagged" };
  }
  // Paquete, otro motivo, o un pago que el cliente nunca dijo de qué era: van a "Paquetes y
  // otros" (este último en su sección "Sin etiqueta"), no a un curso.
  if (tag?.kind === "packages" || tag?.kind === "other" || tag?.kind === "unknown") {
    return { kind: "no", source: "tagged" };
  }

  if (untaggedSinceIso && entry.firstAt < untaggedSinceIso) return { kind: "no", source: "by_date" };
  // Pagó un curso sin decir cuál: entra en cada curso posible, marcado para revisar.
  if (tag?.kind === "course_unknown") {
    const isOption =
      !course || tag.options.length === 0 || tag.options.some((option) => option.id === course.id);
    return { kind: isOption ? "yes" : "no", source: "course_unknown" };
  }
  return { kind: classifyCoursePayment(entry), source: "by_date" };
}

function buildCourseEnrollments(params: {
  payments: PaymentEntry[];
  texts: ClientText[];
  profileNames: Map<string, string>;
  // Con curso, la etiqueta de cada pago decide si entra; sin él, entra todo pago de curso.
  course?: Course;
  // Desde cuándo cuentan los pagos sin etiqueta (ver getEnrollmentWindow).
  untaggedSinceIso?: string;
}): Enrollment[] {
  const byPhone = new Map<
    string,
    { entries: PaymentEntry[]; onlyMaybe: boolean; sources: EnrollmentSource[] }
  >();
  for (const entry of params.payments) {
    const { kind, source } = classifyForCourse(entry, params.course, params.untaggedSinceIso);
    if (kind === "no") continue;
    const current = byPhone.get(entry.phone) ?? { entries: [], onlyMaybe: true, sources: [] };
    current.entries.push(entry);
    current.onlyMaybe &&= kind === "maybe";
    current.sources.push(source);
    byPhone.set(entry.phone, current);
  }

  const enrollments: Enrollment[] = [];

  for (const [phone, { entries, onlyMaybe, sources }] of byPhone) {
    const sorted = [...entries].sort((a, b) => a.firstAt.localeCompare(b.firstAt));
    const confirmed = sorted.some((e) => e.category === "confirmed");
    const { names, phones } = collectContactData(phone, sorted, params.texts);

    // Pago dudoso sin ningún nombre de inscrito: no hay señal de que sea del curso.
    if (onlyMaybe && names.length === 0) continue;

    const evidenceEntry = sorted.find((e) => e.category === "confirmed") ?? sorted[0];

    enrollments.push({
      phone,
      status: confirmed ? "confirmed" : "review",
      paidAt: evidenceEntry.firstAt,
      alerted: sorted.some((e) => e.alerted),
      names,
      phones,
      profileName: params.profileNames.get(phone) ?? null,
      evidence: evidenceEntry.detail,
      source: sources.includes("tagged")
        ? "tagged"
        : sources.includes("course_unknown")
          ? "course_unknown"
          : "by_date",
    });
  }

  return enrollments.sort((a, b) => a.paidAt.localeCompare(b.paidAt));
}

// PAQUETES Y OTROS PAGOS — la otra mitad de /pagos: todo pago que no es de un curso.
type OtherPayment = {
  phone: string;
  status: "confirmed" | "review";
  paidAt: string;
  alerted: boolean;
  names: string[];
  phones: string[];
  profileName: string | null;
  // Etiqueta de la alerta; null = sin etiqueta (se muestra el contexto que se detectó).
  tag: PaymentTag | null;
  motive: string | null;
  context: string;
  evidence: string;
};

const OTHER_PAYMENTS_DAYS = 30;

function buildOtherPayments(params: {
  payments: PaymentEntry[];
  texts: ClientText[];
  profileNames: Map<string, string>;
}): OtherPayment[] {
  const others = params.payments.filter((entry) => {
    if (entry.category === "discarded" || entry.category === "unrelated") return false;
    const tag = entry.tag ?? null;
    if (tag) return tag.kind === "packages" || tag.kind === "other" || tag.kind === "unknown";
    // Sin etiqueta solo entra lo confirmado (alerta o visión): los textos sueltos con "pago"
    // en chats sin curso eran casi siempre preguntas o publicidad de otros negocios.
    return entry.category === "confirmed" && classifyCoursePayment(entry) === "no";
  });

  return others
    .map((entry) => {
      const { names, phones } = collectContactData(entry.phone, [entry], params.texts);
      return {
        phone: entry.phone,
        status: entry.category === "confirmed" ? ("confirmed" as const) : ("review" as const),
        paidAt: entry.firstAt,
        alerted: entry.alerted,
        names,
        phones,
        profileName: params.profileNames.get(entry.phone) ?? null,
        tag: entry.tag ?? null,
        motive: entry.taggedMotive ?? null,
        context: entry.context,
        evidence: entry.detail,
      };
    })
    // Los más recientes arriba: son 30 días y lo que importa es lo último que llegó.
    .sort((a, b) => b.paidAt.localeCompare(a.paidAt));
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
    `     💰 ${formatBoliviaShort(enrollment.paidAt)}${enrollment.alerted ? " · 🔔 alerta" : ""}${SOURCE_MARK[enrollment.source]}${enrollment.status === "review" && enrollment.evidence ? ` · ${escapeHtml(enrollment.evidence)}` : ""}`,
  ];

  return lines.join("\n");
}

// Cómo se asignó el pago a este curso (ver EnrollmentSource). Con etiqueta no se marca nada.
const SOURCE_MARK: Record<EnrollmentSource, string> = {
  tagged: "",
  course_unknown: " · ⚠️ no dijo de qué curso",
  by_date: " · 📅 sin etiqueta",
};

function renderCourseEnrollments(params: { course: Course; enrollments: Enrollment[] }): string[] {
  const confirmed = params.enrollments.filter((e) => e.status === "confirmed");
  const review = params.enrollments.filter((e) => e.status === "review");
  const people = confirmed.reduce((total, e) => total + Math.max(1, e.names.length), 0);
  const unsure = params.enrollments.filter((e) => e.source !== "tagged").length;

  const blocks = [
    [
      `💰 <b>Pagos — ${escapeHtml(params.course.name)}</b>`,
      `📅 ${formatCourseDate(params.course.startsAt)}`,
      `✅ ${confirmed.length} con pago confirmado (~${people} personas) · ❓ ${review.length} por revisar`,
      ...(unsure > 0
        ? [`📅/⚠️ ${unsure} sin etiqueta de curso: se asignaron por la fecha del pago, revisa que sean de esta fecha.`]
        : []),
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

function renderOtherPayment(payment: OtherPayment, index: number): string {
  const digits = payment.phone.replace(/\D/g, "");
  const localPhone = digits.startsWith("591") ? digits.slice(3) : digits;
  const [firstName, ...otherNames] = payment.names;
  const label = payment.tag ? renderTagLabel(payment.tag) : `${payment.context} · 📅 sin etiqueta`;

  return [
    firstName
      ? `<b>${index}.</b> 👤 ${escapeHtml(firstName)}`
      : `<b>${index}.</b> 👤 <i>(sin nombre${payment.profileName ? ` — perfil: ${escapeHtml(payment.profileName)}` : ""})</i>`,
    ...otherNames.map((name) => `     ➕ ${escapeHtml(name)}`),
    `     🏷️ ${escapeHtml(label)}`,
    ...(payment.motive ? [`     📝 ${escapeHtml(payment.motive)}`] : []),
    `     📱 ${[...new Set([localPhone, ...payment.phones])].join(" · ")} · <a href="https://wa.me/${digits}">abrir chat</a>`,
    `     💰 ${formatBoliviaShort(payment.paidAt)}${payment.alerted ? " · 🔔 alerta" : ""}${payment.status === "review" && payment.evidence ? ` · ${escapeHtml(payment.evidence)}` : ""}`,
  ].join("\n");
}

function renderOtherPayments(params: { payments: OtherPayment[] }): string[] {
  // Pagos con motivo (paquete u otro) arriba; los que nadie sabe de qué son, al final.
  const known = params.payments.filter((p) => p.tag && p.tag.kind !== "unknown");
  const unknown = params.payments.filter((p) => !p.tag || p.tag.kind === "unknown");

  const blocks = [
    [
      `🎬 <b>Paquetes y otros pagos</b> — últimos ${OTHER_PAYMENTS_DAYS} días`,
      `🏷️ ${known.length} con motivo · ❔ ${unknown.length} sin etiqueta`,
    ].join("\n"),
  ];

  if (known.length > 0) {
    blocks.push("\n🏷️ <b>Con motivo</b>");
    known.forEach((p, i) => blocks.push(renderOtherPayment(p, i + 1)));
  }

  if (unknown.length > 0) {
    blocks.push("\n❔ <b>Sin etiqueta</b> — el cliente no dijo el motivo (o son de antes del etiquetado): revisa el chat");
    unknown.forEach((p, i) => blocks.push(renderOtherPayment(p, i + 1)));
  }

  if (params.payments.length === 0) {
    blocks.push("\nNo hay pagos de paquetes ni de otros motivos en este período.");
  }

  return blocks;
}

export {
  OTHER_PAYMENTS_DAYS,
  getEnrollmentWindow,
  listReportableCourses,
  extractContactLines,
  buildCourseEnrollments,
  renderCourseEnrollments,
  buildOtherPayments,
  renderOtherPayments,
};
export type { ClientText, Enrollment, EnrollmentSource, OtherPayment };

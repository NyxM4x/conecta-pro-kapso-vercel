// ALERTA 💰 DE PAGO — una sola vez, etiquetada y con los datos del cliente.
//
// Antes la alerta salía apenas llegaba el comprobante, con un contexto genérico ("Curso
// (Creación de Contenido o Edición CapCut — revisar chat)") y sin nombre: el equipo tenía
// que abrir cada chat, y con dos fechas a la venta la lista de pagos ponía el pago en el
// curso equivocado (lo decidía la fecha del pago, no el curso).
//
// Ahora, cuando llega el comprobante:
//   1. Si el contexto ya dice a qué corresponde (un solo curso a la venta, el curso que se
//      nombró en el chat, o paquetes con el formulario lleno) NO se le pregunta el motivo.
//   2. El bot le pide al cliente solo lo que falta: nombre y celular, más el curso (si hay
//      dos fechas y no se sabe cuál) o el motivo del pago (si el chat no dice nada).
//   3. La alerta espera hasta PAYMENT_ALERT_WAIT_MINUTES a que el cliente responda y sale UNA
//      vez, con la etiqueta, el nombre, el celular y el link al chat. Si no responde, sale
//      igual con su nombre de perfil de WhatsApp.
//
// La etiqueta queda guardada en el marcador [TELEGRAM_PAYMENT_SENT] (raw_payload.tag) y la
// lista global de /pagos la muestra junto a cada comprobante (lib/payments-ledger.ts).

import { extractContactLines } from "./contact-lines.ts";
import { COURSES, detectMentionedCourses, formatCourseShortDate } from "./courses.ts";
import type { Course } from "./courses.ts";
import { COURSE_KEYWORDS, COURSE_PURCHASE_KEYWORDS, normalizeForMatch } from "./keywords.ts";
import { escapeTelegramHtml, sendTelegramNotification } from "./telegram.ts";

type SupabaseLike = { from: (table: string) => any };

// Cuánto se espera a que el cliente mande sus datos antes de avisar igual.
const PAYMENT_ALERT_WAIT_MINUTES = 20;
// Mensajes del cliente de justo antes del comprobante que también cuentan: a veces manda
// el nombre y después la foto.
const PAYER_DATA_LOOKBACK_MINUTES = 10;
// Alertas pendientes más viejas que esto ya no se envían (evita avisar pagos de hace días
// si el barrido estuvo caído).
const PENDING_LOOKBACK_HOURS = 48;
// El barrido general corre como máximo una vez por esta franja entre todos los procesos.
const SWEEP_EVERY_MINUTES = 5;

const PAYMENT_PENDING_MARKER = "[PAYMENT_ALERT_PENDING";
const PAYMENT_SENT_MARKER = "[TELEGRAM_PAYMENT_SENT";

type CourseRef = { id: string; name: string; startsAt: string };

const toCourseRef = (course: Course): CourseRef => ({
  id: course.id,
  name: course.name,
  startsAt: course.startsAt,
});

// Por qué pagó, según lo que el bot sabe al recibir el comprobante.
type PaymentReason =
  | { kind: "course"; course: CourseRef }
  // Pagó un curso, pero hay más de una fecha a la venta y el chat no dice cuál.
  | { kind: "course_unknown"; options: CourseRef[] }
  | { kind: "packages" }
  // El chat no dice nada: puede ser un curso, un paquete u otra cosa.
  | { kind: "unknown"; options: CourseRef[] };

// Etiqueta final que viaja con la alerta y ordena la lista de pagos.
type PaymentTag =
  | { kind: "course"; courseId: string; courseName: string; courseStartsAt: string }
  | { kind: "course_unknown"; options: CourseRef[] }
  | { kind: "packages" }
  | { kind: "other" }
  | { kind: "unknown" };

type PayerData = {
  names: string[];
  phones: string[];
  // Lo que el cliente escribió como motivo, tal cual (para el equipo).
  motive: string | null;
  tag: PaymentTag;
};

type ChatMessage = { role: "user" | "assistant"; content: string };

// Curso del que se está hablando: primero lo que dijo el cliente (del más reciente al más
// viejo), después lo que dijo el bot. Solo cuenta un mensaje que nombra UN curso: el bot
// suele listar las dos fechas juntas cuando le preguntan "¿qué cursos tienen?".
function findDiscussedCourse(messages: ChatMessage[], options: Course[]): Course | null {
  for (const role of ["user", "assistant"] as const) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role !== role) continue;
      const mentioned = detectMentionedCourses(messages[i].content, options);
      if (mentioned.length === 1) return mentioned[0];
    }
  }
  return null;
}

function resolvePaymentReason(params: {
  // La conversación está en cursos (último mensaje del bot de una línea = curso).
  courseContext: boolean;
  // Se le envió el QR del curso (por el bot o a mano) o vino por la promo del live.
  courseMaterialSent: boolean;
  intakeFormSent: boolean;
  // Cursos a la venta ahora mismo.
  activeCourses: Course[];
  recentMessages: ChatMessage[];
}): PaymentReason {
  const options = params.activeCourses.map(toCourseRef);

  // La conversación en cursos manda; si no, el formulario de paquetes; si no, el QR del curso.
  if (!params.courseContext) {
    if (params.intakeFormSent) return { kind: "packages" };
    if (!params.courseMaterialSent) return { kind: "unknown", options };
  }

  if (params.activeCourses.length === 1) {
    return { kind: "course", course: options[0] };
  }

  const discussed = findDiscussedCourse(params.recentMessages, params.activeCourses);
  if (discussed) return { kind: "course", course: toCourseRef(discussed) };

  return { kind: "course_unknown", options };
}

// Los cursos de la etiqueta vuelven al catálogo para usar sus alias (la etiqueta solo guarda
// id, nombre y fecha). La fecha es la de la opción que se le ofreció, no la que tenga hoy el
// catálogo: si el curso se reprogramó mientras tanto, el pago sigue siendo de esa fecha.
const toCatalog = (refs: CourseRef[]): Course[] =>
  refs.flatMap((ref) => {
    const course = COURSES.find((candidate) => candidate.id === ref.id);
    return course ? [{ ...course, name: ref.name, startsAt: ref.startsAt }] : [];
  });

const courseTag = (course: CourseRef): PaymentTag => ({
  kind: "course",
  courseId: course.id,
  courseName: course.name,
  courseStartsAt: course.startsAt,
});

const PACKAGES_MOTIVE =
  /\b(PAQUETE|PAQUETES|VIDEOS|GRABACION|GRABACIONES|PUBLICIDAD|MARKETING|MENSUALIDAD|MENSUAL|AGENTE)\b/;

// Palabras que no dicen nada del motivo: "aquí el comprobante", "listo", "gracias", los
// rótulos del nombre y el celular.
const FILLER_WORDS = new Set([
  "HOLA", "BUENAS", "BUENOS", "BUEN", "DIA", "DIAS", "TARDES", "NOCHES", "GRACIAS", "OK", "OKEY",
  "OKI", "LISTO", "LISTA", "YA", "SI", "AQUI", "AHI", "ESTA", "ES", "EL", "LA", "LOS", "LAS", "UN",
  "UNA", "DE", "DEL", "MI", "SU", "TE", "LE", "LO", "ENVIO", "MANDO", "PASO", "ADJUNTO", "COMPROBANTE",
  "PAGO", "PAGUE", "YO", "NOMBRE", "COMPLETO", "NUMERO", "NRO", "CELULAR", "CEL", "TELEFONO", "TEL",
  "WHATSAPP", "SALUDOS", "PORFA", "FAVOR", "POR", "PERFECTO", "VALE", "BIEN",
]);

const QUESTION_START =
  /^\W*(DONDE|CUANDO|COMO|QUE|CUAL|CUANTO|CUANTA|CUANTOS|A\s+QUE|POR\s+QUE|PUEDO|PUEDE|PODRIA|HAY|TIENEN|SE\s+PUEDE)\b/;

// Líneas del cliente que pueden ser el motivo: no son su nombre, ni su celular, ni relleno.
function extractMotiveLines(text: string): string[] {
  const lines: string[] = [];

  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^[📷📄🎙️]/u.test(line)) continue;
    if (extractContactLines(line).names.length > 0) continue;
    // Una pregunta no es el motivo del pago ("¿dónde queda?", "a qué hora empieza").
    if (line.includes("?") || QUESTION_START.test(normalizeForMatch(line))) continue;

    const words = normalizeForMatch(line)
      .replace(/\d+/g, " ")
      .replace(/[^A-Z\s]/g, " ")
      .split(/\s+/)
      .filter(Boolean);

    if (words.length === 0 || words.every((word) => FILLER_WORDS.has(word))) continue;
    lines.push(line);
  }

  return lines;
}

const unique = (values: string[]) => {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = normalizeForMatch(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

function resolveTag(reason: PaymentReason, text: string, motive: string | null): PaymentTag {
  if (reason.kind === "course") return courseTag(reason.course);
  if (reason.kind === "packages") return { kind: "packages" };

  const options = toCatalog(reason.options);
  const mentioned = detectMentionedCourses(text, options);
  if (mentioned.length === 1) return courseTag(toCourseRef(mentioned[0]));

  if (reason.kind === "course_unknown") return { kind: "course_unknown", options: reason.options };

  // Motivo desconocido: se clasifica lo que escribió el cliente.
  const normalized = normalizeForMatch(text);
  if (COURSE_KEYWORDS.test(normalized) || COURSE_PURCHASE_KEYWORDS.test(normalized)) {
    return reason.options.length === 1
      ? courseTag(reason.options[0])
      : { kind: "course_unknown", options: reason.options };
  }
  if (PACKAGES_MOTIVE.test(normalized)) return { kind: "packages" };
  return motive ? { kind: "other" } : { kind: "unknown" };
}

// Nombre, celular y motivo que el cliente escribió alrededor del comprobante.
function extractPayerData(clientTexts: string[], reason: PaymentReason): PayerData {
  const names: string[] = [];
  const phones: string[] = [];
  const motiveLines: string[] = [];

  for (const text of clientTexts) {
    const found = extractContactLines(text);
    names.push(...found.names);
    phones.push(...found.phones);
    motiveLines.push(...extractMotiveLines(text));
  }

  const motive = unique(motiveLines).join(" · ").slice(0, 200) || null;

  return {
    names: unique(names),
    phones: [...new Set(phones)],
    motive,
    tag: resolveTag(reason, clientTexts.join("\n"), motive),
  };
}

// ¿Ya está todo lo que el equipo necesita? El celular no hace falta: si no lo escribe, se usa
// el de su WhatsApp.
function isPayerDataComplete(reason: PaymentReason, data: PayerData): boolean {
  if (reason.kind === "packages") return true;
  if (data.names.length === 0) return false;
  if (reason.kind === "course") return true;
  if (reason.kind === "course_unknown") return data.tag.kind === "course";
  return data.tag.kind !== "unknown";
}

// "Edición Persuasiva en CapCut Pro (20/09)"
const courseOptionLabel = (course: CourseRef) =>
  `${course.name.replace(/^Curso de\s+/i, "")} (${formatCourseShortDate(course.startsAt)})`;

const RECEIPT_THANKS = "¡Gracias por el comprobante! 😊";

// Lo que el bot le responde al cliente al recibir el comprobante. Pide solo lo que falta.
function renderReceiptReply(reason: PaymentReason, dataComplete: boolean): string {
  if (reason.kind === "packages") {
    return `${RECEIPT_THANKS} Nuestro equipo va a validar el pago y en breve un asesor se comunicará contigo.`;
  }

  const courseIntro = `${RECEIPT_THANKS} Nuestro equipo va a validar el pago y, una vez verificado, te confirmamos tu cupo.`;

  if (dataComplete) {
    return reason.kind === "unknown"
      ? `${RECEIPT_THANKS} Nuestro equipo va a validar el pago y te escribimos en breve 🙌`
      : courseIntro;
  }

  if (reason.kind === "course") {
    return `${courseIntro} Para agregarte al grupo de participantes del curso, indícame tu nombre completo (verifica que esté bien escrito) y tu número de teléfono.`;
  }

  if (reason.kind === "course_unknown") {
    return [
      `${courseIntro} Para registrarte bien, indícame:`,
      "📌 Tu nombre completo (verifica que esté bien escrito)",
      "📌 Tu número de celular",
      `📌 ¿Para cuál curso es? ${reason.options.map(courseOptionLabel).join(" o ")}`,
    ].join("\n");
  }

  const courseExamples =
    reason.options.length > 0
      ? `el ${reason.options.map((o) => o.name.replace(/^Curso de\s+/i, "curso de ")).join(" o el ")}, `
      : "un curso, ";

  return [
    `${RECEIPT_THANKS} Para registrar tu pago correctamente, ayúdanos con estos datos:`,
    "📌 Tu nombre completo",
    "📌 Tu número de celular",
    `📌 El motivo del pago (por ejemplo: ${courseExamples}un paquete de videos u otro)`,
  ].join("\n");
}

// Lo que todavía falta de los datos del pago, en palabras para el cliente.
function describeMissingPayerData(reason: PaymentReason, data: PayerData): string[] {
  const missing: string[] = [];
  if (reason.kind === "packages") return missing;
  if (data.names.length === 0) missing.push("tu nombre completo");
  if (reason.kind === "course_unknown" && data.tag.kind !== "course") {
    missing.push(`para cuál curso es: ${reason.options.map(courseOptionLabel).join(" o ")}`);
  }
  if (reason.kind === "unknown" && data.tag.kind === "unknown") missing.push("el motivo del pago");
  return missing;
}

// Cuando mandó parte de los datos: pide solo lo que falta, en una línea.
function renderMissingPayerDataReply(reason: PaymentReason, data: PayerData): string {
  const missing = describeMissingPayerData(reason, data);
  const list =
    missing.length > 1 ? `${missing.slice(0, -1).join(", ")} y ${missing.at(-1)}` : missing[0] ?? "";
  return `¡Gracias! 🙌 Para registrar tu pago solo me falta ${list} 😊`;
}

// Cuando el cliente ya mandó sus datos.
function renderPayerDataReceivedReply(tag: PaymentTag): string {
  return tag.kind === "course"
    ? "¡Gracias! 🙌 Ya tenemos tus datos. Nuestro equipo valida tu pago y te agrega al grupo del curso 😊"
    : "¡Gracias! 🙌 Ya tenemos tus datos. Nuestro equipo valida tu pago y te escribe en breve 😊";
}

function renderTagLabel(tag: PaymentTag): string {
  switch (tag.kind) {
    case "course":
      return `🎓 ${tag.courseName} — ${formatCourseShortDate(tag.courseStartsAt)}`;
    case "course_unknown":
      return tag.options.length > 0
        ? `🎓 Curso — ⚠️ no se sabe cuál (${tag.options.map(courseOptionLabel).join(" o ")})`
        : "🎓 Curso — ⚠️ sin fecha vigente, revisar chat";
    case "packages":
      return "🎬 Paquete de videos";
    case "other":
      return "❔ Otro motivo";
    default:
      return "❔ Motivo desconocido — revisar chat";
  }
}

const localPhone = (phone: string) => {
  const digits = String(phone ?? "").replace(/\D/g, "");
  return digits.startsWith("591") ? digits.slice(3) : digits;
};

function buildPaymentAlertText(params: {
  phone: string;
  tag: PaymentTag;
  names: string[];
  phones: string[];
  motive: string | null;
  profileName: string | null;
  clientMessage: string;
  verification?: string;
  note?: string;
  // El cliente no mandó sus datos a tiempo: se avisa con lo que hay.
  timedOut: boolean;
}): string {
  const digits = String(params.phone ?? "").replace(/\D/g, "");
  const [firstName, ...otherNames] = params.names;
  const phones = [...new Set([...params.phones, localPhone(params.phone)])];

  const lines = [
    "💰 <b>Pago confirmado — Conecta Pro</b>",
    `🏷️ <b>${escapeTelegramHtml(renderTagLabel(params.tag))}</b>`,
  ];

  if (params.motive && params.tag.kind !== "course") {
    lines.push(`📝 Motivo que escribió: ${escapeTelegramHtml(params.motive)}`);
  }

  lines.push(
    "",
    firstName
      ? `👤 ${escapeTelegramHtml(firstName)}`
      : `👤 ${params.profileName ? `${escapeTelegramHtml(params.profileName)} <i>(nombre de WhatsApp)</i>` : "<i>sin nombre</i>"}`,
    ...otherNames.map((name) => `➕ ${escapeTelegramHtml(name)}`),
    `📱 ${phones.join(" · ")}`,
    `👉 Abrir chat: https://wa.me/${digits}`,
  );

  if (params.timedOut) {
    lines.push(`⏱️ No mandó sus datos en ${PAYMENT_ALERT_WAIT_MINUTES} min: se avisa con lo que hay.`);
  }
  if (params.note) lines.push(escapeTelegramHtml(params.note));
  if (params.verification) {
    lines.push(`🧾 Verificación: ${escapeTelegramHtml(params.verification.slice(0, 200))}`);
  }

  const clientMessage = params.clientMessage.trim();
  if (clientMessage) {
    lines.push("", `👤 Cliente:\n${escapeTelegramHtml(clientMessage.slice(0, 500))}`);
  }

  return lines.join("\n");
}

type PaymentAlertParams = {
  phone: string;
  conversationId?: string | null;
  receiptMessageId: string;
  tag: PaymentTag;
  names: string[];
  phones: string[];
  motive: string | null;
  profileName: string | null;
  clientMessage: string;
  verification?: string;
  note?: string;
  timedOut: boolean;
};

// Envía la alerta y deja el marcador [TELEGRAM_PAYMENT_SENT:<id>] con la etiqueta. Es el único
// lugar que manda una alerta de pago: el webhook y el barrido de pendientes pasan por aquí.
async function sendPaymentAlert(supabase: SupabaseLike, params: PaymentAlertParams): Promise<boolean> {
  const sent = await sendTelegramNotification(buildPaymentAlertText(params));
  if (!sent) return false;

  const { error } = await supabase.from("kapso_messages").insert({
    kapso_message_id: null,
    kapso_conversation_id: params.conversationId ?? null,
    contact_phone: params.phone,
    direction: "outbound",
    role: "assistant",
    content: `${PAYMENT_SENT_MARKER}:${params.receiptMessageId}] notificación de pago enviada a Telegram`,
    message_timestamp: new Date().toISOString(),
    batch_index: null,
    raw_payload: {
      type: "telegram_notification",
      event: "payment",
      receipt_message_id: params.receiptMessageId,
      tag: params.tag,
      names: params.names,
      phones: params.phones,
      motive: params.motive,
      timed_out: params.timedOut,
    },
  });

  if (error) console.error("payment alert marker insert failed", error);
  return true;
}

// Payload del marcador [PAYMENT_ALERT_PENDING:<id>]: todo lo que hace falta para mandar la
// alerta después, desde otro proceso.
type PendingPaymentPayload = {
  type: "payment_alert_pending";
  receipt_message_id: string;
  reason: PaymentReason;
  client_message: string;
  verification?: string;
  note?: string;
};

async function savePendingPaymentAlert(
  supabase: SupabaseLike,
  params: {
    phone: string;
    conversationId?: string | null;
    receiptMessageId: string;
    reason: PaymentReason;
    clientMessage: string;
    verification?: string;
    note?: string;
  },
): Promise<boolean> {
  const payload: PendingPaymentPayload = {
    type: "payment_alert_pending",
    receipt_message_id: params.receiptMessageId,
    reason: params.reason,
    client_message: params.clientMessage.slice(0, 1000),
    verification: params.verification,
    note: params.note,
  };

  const { error } = await supabase.from("kapso_messages").insert({
    kapso_message_id: null,
    kapso_conversation_id: params.conversationId ?? null,
    contact_phone: params.phone,
    direction: "outbound",
    role: "assistant",
    content: `${PAYMENT_PENDING_MARKER}:${params.receiptMessageId}] alerta de pago esperando los datos del cliente`,
    message_timestamp: new Date().toISOString(),
    batch_index: null,
    raw_payload: payload,
  });

  if (error) {
    console.error("pending payment alert insert failed", error);
    return false;
  }
  return true;
}

type PendingRow = {
  kapso_conversation_id: string | null;
  contact_phone: string;
  content: string;
  created_at: string;
  raw_payload: PendingPaymentPayload | null;
};

const receiptIdOf = (content: string) => content.match(/^\[[A-Z_]+:([^\]]*)\]/)?.[1] ?? "";

// Alertas pendientes (sin enviar) de las últimas PENDING_LOOKBACK_HOURS.
async function loadOpenPendingAlerts(
  supabase: SupabaseLike,
  options: { conversationId?: string; now: number },
): Promise<PendingRow[]> {
  const since = new Date(options.now - PENDING_LOOKBACK_HOURS * 3600_000).toISOString();

  let pendingQuery = supabase
    .from("kapso_messages")
    .select("kapso_conversation_id, contact_phone, content, created_at, raw_payload")
    .eq("direction", "outbound")
    .like("content", `${PAYMENT_PENDING_MARKER}%`)
    .gte("created_at", since)
    .order("created_at", { ascending: true })
    .limit(50);
  if (options.conversationId) {
    pendingQuery = pendingQuery.eq("kapso_conversation_id", options.conversationId);
  }

  const { data: pending, error } = await pendingQuery;
  if (error || !pending || pending.length === 0) return [];

  const phones = [...new Set((pending as PendingRow[]).map((row) => row.contact_phone))];
  const { data: sent } = await supabase
    .from("kapso_messages")
    .select("content")
    .eq("direction", "outbound")
    .in("contact_phone", phones)
    .like("content", `${PAYMENT_SENT_MARKER}%`)
    .gte("created_at", since);

  const sentIds = new Set((sent ?? []).map((row: { content: string }) => receiptIdOf(row.content)));
  return (pending as PendingRow[]).filter((row) => !sentIds.has(receiptIdOf(row.content)));
}

// ¿Hay una alerta de pago esperando los datos del cliente en esta conversación? La usa el
// webhook para no abrir otra con el segundo comprobante y para tratar lo que escriba el
// cliente como sus datos de pago (no como un lead).
async function getOpenPendingPaymentAlert(
  supabase: SupabaseLike,
  conversationId: string | undefined,
  now = Date.now(),
): Promise<{ reason: PaymentReason; createdAt: string } | null> {
  if (!conversationId) return null;
  const rows = await loadOpenPendingAlerts(supabase, { conversationId, now });
  const last = rows.at(-1);
  if (!last?.raw_payload?.reason) return null;
  return { reason: last.raw_payload.reason, createdAt: last.created_at };
}

// Candado por alerta: si el webhook y el barrido la toman a la vez, solo uno la manda.
async function claimPendingAlert(supabase: SupabaseLike, receiptId: string): Promise<boolean> {
  const { error } = await supabase.from("kapso_response_locks").insert({
    kapso_conversation_id: "system:payment-alert",
    last_kapso_message_id: `payment-alert:${receiptId}`,
    batch_size: 0,
    status: "sent",
  });
  if (!error) return true;
  if (error.code === "23505") return false;
  // La tabla rechazó el candado por otro motivo: mejor avisar dos veces que ninguna.
  console.error("payment alert claim failed", error);
  return true;
}

async function releasePendingAlert(supabase: SupabaseLike, receiptId: string) {
  await supabase
    .from("kapso_response_locks")
    .delete()
    .eq("last_kapso_message_id", `payment-alert:${receiptId}`);
}

async function loadProfileName(supabase: SupabaseLike, phone: string): Promise<string | null> {
  const { data } = await supabase.from("kapso_contacts").select("name").eq("phone", phone).limit(1);
  return (data?.[0]?.name as string | undefined) ?? null;
}

// Manda las alertas pendientes que ya tienen los datos del cliente o que cumplieron su
// espera. Con conversationId revisa solo esa conversación (lo llama el webhook cada vez que
// el cliente escribe); sin él, todas (el barrido).
async function processPendingPaymentAlerts(
  supabase: SupabaseLike,
  options: { conversationId?: string; now?: number } = {},
): Promise<{ sent: number; waiting: number }> {
  const now = options.now ?? Date.now();
  const pending = await loadOpenPendingAlerts(supabase, { conversationId: options.conversationId, now });

  let sent = 0;
  let waiting = 0;

  for (const row of pending) {
    const payload = row.raw_payload;
    if (!payload?.reason) continue;
    const receiptId = payload.receipt_message_id || receiptIdOf(row.content);

    const from = new Date(new Date(row.created_at).getTime() - PAYER_DATA_LOOKBACK_MINUTES * 60_000).toISOString();
    let textQuery = supabase
      .from("kapso_messages")
      .select("content")
      .eq("direction", "inbound")
      .eq("contact_phone", row.contact_phone)
      .gte("created_at", from)
      .order("created_at", { ascending: true });
    if (row.kapso_conversation_id) textQuery = textQuery.eq("kapso_conversation_id", row.kapso_conversation_id);
    const { data: texts } = await textQuery;
    const clientTexts = (texts ?? []).map((t: { content: string | null }) => String(t.content ?? ""));

    const data = extractPayerData(clientTexts, payload.reason);
    const complete = isPayerDataComplete(payload.reason, data);
    const timedOut = now - new Date(row.created_at).getTime() >= PAYMENT_ALERT_WAIT_MINUTES * 60_000;

    if (!complete && !timedOut) {
      waiting += 1;
      continue;
    }

    if (!(await claimPendingAlert(supabase, receiptId))) continue;

    const ok = await sendPaymentAlert(supabase, {
      phone: row.contact_phone,
      conversationId: row.kapso_conversation_id,
      receiptMessageId: receiptId,
      tag: data.tag,
      names: data.names,
      phones: data.phones,
      motive: data.motive,
      profileName: data.names.length === 0 ? await loadProfileName(supabase, row.contact_phone) : null,
      // Lo que escribió desde el comprobante (incluye sus datos), no solo la foto.
      clientMessage: clientTexts.join("\n").slice(-500) || payload.client_message || "",
      verification: payload.verification,
      note: payload.note,
      timedOut: !complete,
    }).catch(() => false);

    if (ok) sent += 1;
    else await releasePendingAlert(supabase, receiptId);
  }

  return { sent, waiting };
}

// Barrido general, colgado del tráfico del webhook (como los leads sin atender): como máximo
// una vez cada SWEEP_EVERY_MINUTES entre todos los procesos.
async function runPendingPaymentAlertSweep(
  supabase: SupabaseLike,
  options: { force?: boolean } = {},
): Promise<{ skipped: boolean; sent?: number; waiting?: number }> {
  const now = Date.now();

  if (!options.force) {
    const bucket = Math.floor(now / (SWEEP_EVERY_MINUTES * 60_000));
    const { error } = await supabase.from("kapso_response_locks").insert({
      kapso_conversation_id: "system:payment-alerts",
      last_kapso_message_id: `system:payment-alerts:${bucket}`,
      batch_size: 0,
      status: "sent",
    });
    if (error?.code === "23505") return { skipped: true };
  }

  const result = await processPendingPaymentAlerts(supabase, { now });
  return { skipped: false, ...result };
}

export {
  PAYMENT_ALERT_WAIT_MINUTES,
  PAYMENT_PENDING_MARKER,
  toCourseRef,
  resolvePaymentReason,
  extractPayerData,
  isPayerDataComplete,
  renderReceiptReply,
  renderPayerDataReceivedReply,
  renderMissingPayerDataReply,
  describeMissingPayerData,
  renderTagLabel,
  buildPaymentAlertText,
  sendPaymentAlert,
  savePendingPaymentAlert,
  getOpenPendingPaymentAlert,
  processPendingPaymentAlerts,
  runPendingPaymentAlertSweep,
};
export type { CourseRef, PaymentReason, PaymentTag, PayerData, ChatMessage };

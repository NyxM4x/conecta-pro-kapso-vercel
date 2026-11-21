// INSCRITOS (/inscritos), POR COBRAR (/porcobrar) y LISTA DE ESPERA (/espera) del grupo de
// Telegram.
//
// La lista guía del día del curso: cuántos inscritos hay en cada curso con fecha, quiénes son
// y qué falta revisar. No hay una tabla de inscritos: se arma con los mismos comprobantes de
// /pagos (lib/payments-ledger.ts), la etiqueta que dejó la alerta 💰 y lo que el equipo
// corrigió con los botones.
//
//   1. Cada comprobante con etiqueta de curso (o combo) suma sus cupos a ese curso. Los cupos
//      salen del monto: 1000 Bs de combo son 2 personas. Sin monto, cuentan los nombres.
//   2. Lo que el bot no supo asignar (no se sabe qué curso, un monto raro, un archivo sin
//      verificar en un chat de cursos) va a "Por asignar", cada uno con botones para que el
//      equipo diga de qué es: un curso, el combo, un paquete o nada. La respuesta queda
//      guardada (marcador [COURSE_ROSTER_SET:<id>], con una nota opcional del contexto) y manda
//      sobre la etiqueta automática. Caso real que lo pide (13–20 nov 2026): los tres pagos
//      "de curso" de esas semanas llegaron como "no se sabe cuál": uno era de dos combos, otro
//      el saldo de un paquete y el tercero ni siquiera era un pago.
//   3. Quien tocó "pagar" en la página o recibió el QR y no mandó comprobante va en /porcobrar:
//      son a los que hay que escribir antes del curso.
//
// Cómo se ve: primero un RESUMEN (cuántos inscritos por curso y qué falta), después UN mensaje
// por curso con su lista, y al final un mensaje por cada pago por asignar con sus botones.
// Cada persona ocupa pocas líneas: nombre, qué pagó, contacto y, si hace falta, una nota.
//
// Funciones puras: el route handler de Telegram consulta Supabase y les pasa las filas.

import { createHash } from "node:crypto";
import { renderTagLabel } from "./payment-alerts.ts";
import type { LedgerEntry } from "./payments-ledger.ts";

const BOLIVIA_TZ = "America/La_Paz";
const DAY = 24 * 60 * 60_000;

// Días hacia atrás en los que se buscan pagos de los cursos vigentes (la preventa abre cerca de
// un mes antes del curso).
const ROSTER_LOOKBACK_DAYS = 35;
// Un pago SIN etiqueta de curso entra a "Por asignar" solo si es así de reciente: los más
// viejos son de cursos ya dictados y solo meterían ruido.
const UNTAGGED_LOOKBACK_DAYS = 21;
// Quien tocó pagar o recibió el QR en estos días y no mandó comprobante.
const PENDING_LOOKBACK_DAYS = 14;
// Un pago que llega hasta esto ANTES del clic también cuenta (el cliente paga y después abre la
// página para ver el QR otra vez).
const PAID_BEFORE_INTENT_MINUTES = 30;
// Un curso se sigue mostrando estos días después de dictado, para cerrar cuentas.
const FINISHED_VISIBLE_DAYS = 3;
// Cada pago por asignar es un mensaje con sus botones: más que esto satura el grupo.
const MAX_UNASSIGNED_MESSAGES = 15;
// La lista de espera mira hasta aquí hacia atrás.
const WAITLIST_LOOKBACK_DAYS = 180;

const ROSTER_SET_MARKER = "[COURSE_ROSTER_SET";
// Marcadores de la lista de espera: el actual y el de antes (solo se guardaba si la alerta de
// Telegram salía bien, por eso nunca juntó a nadie).
const WAITLIST_MARKERS = ["[COURSE_WAITLIST_JOINED", "[TELEGRAM_COURSE_WAITLIST_SENT"];

const COURSE_EMOJIS = ["📘", "📗", "📙", "📕"];
const DIVIDER = "━━━━━━━━━━━━━━";

type RosterCourse = {
  id: string;
  name: string;
  startsAt: string;
  pricePreventa: number;
  pricePresencial: number;
};

type RosterBundle = { price: number; courseIds: readonly string[] };

// Lo que el equipo eligió: el id de un curso, "combo", "paquetes" o "no" (no es pago de curso).
type RosterChoice = string;

type RosterCorrection = {
  // Id del mensaje de WhatsApp del comprobante.
  key: string;
  choice: RosterChoice;
  createdAt: string;
  by: string | null;
  // Contexto que dejó quien revisó el chat ("pagó de dos, mandó tres nombres").
  note?: string | null;
};

type CourseIntent = {
  phone: string;
  // pay_click = tocó pagar en /cursos; qr = el bot le mandó el QR.
  kind: "pay_click" | "qr";
  option: string | null;
  amount: number | null;
  createdAt: string;
};

type RosterRow = {
  key: string;
  // Lo que viaja en los botones (callback_data tiene 64 bytes como máximo).
  shortKey: string;
  phone: string;
  names: string[];
  phones: string[];
  profileName: string | null;
  paidAt: string;
  confirmed: boolean;
  amount: number | null;
  // Lo que escribió el cliente junto al pago (motivo o leyenda), si escribió algo.
  quote: string | null;
  // Etiqueta de la alerta o, sin alerta, el contexto que se detectó.
  label: string;
  // Cursos a los que suma. Vacío = por asignar u oculto.
  courseIds: string[];
  combo: boolean;
  seats: number;
  // auto = la etiqueta del bot; team = lo eligió el equipo.
  source: "auto" | "team" | null;
  // Nota del equipo sobre el pago.
  note: string | null;
  // El equipo dijo que es de un paquete o que no es un pago de curso.
  hiddenReason: "paquetes" | "no" | null;
  // Avisos automáticos (monto raro, faltan nombres...).
  warnings: string[];
  hint: string | null;
};

type PendingIntent = CourseIntent & { profileName: string | null };

type CourseRoster = {
  courses: { course: RosterCourse; rows: RosterRow[]; seats: number }[];
  unassigned: RosterRow[];
  hidden: RosterRow[];
  pending: PendingIntent[];
  // Todas las filas por clave corta, para resolver un botón.
  byShortKey: Map<string, RosterRow>;
};

type InlineButton = { text: string; callback_data: string };
type InlineKeyboard = { inline_keyboard: InlineButton[][] };
// Un mensaje de Telegram armado en bloques (el route los corta si pasan el límite).
type RosterMessage = { blocks: string[]; keyboard?: InlineKeyboard };

const shortKeyOf = (key: string) => createHash("sha1").update(key).digest("hex").slice(0, 10);

const courseShortName = (course: RosterCourse) => course.name.replace(/^Curso de\s+/i, "");

// "2026-11-22" en hora de Bolivia.
const boliviaDateKey = (date: Date) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: BOLIVIA_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);

function formatShortDay(iso: string): string {
  const [, month, day] = boliviaDateKey(new Date(iso)).split("-");
  return `${day}/${month}`;
}

function formatTime(iso: string): string {
  return new Intl.DateTimeFormat("es-BO", { timeZone: BOLIVIA_TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
}

// "vie 20/11 10:20"
function formatStamp(iso: string): string {
  const weekday = new Intl.DateTimeFormat("es-BO", { timeZone: BOLIVIA_TZ, weekday: "short" })
    .format(new Date(iso))
    .replace(".", "");
  return `${weekday} ${formatShortDay(iso)} ${formatTime(iso)}`;
}

const escapeHtml = (text: string) => String(text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const digitsOf = (phone: string) => String(phone ?? "").replace(/\D/g, "");
const localPhone = (phone: string) => {
  const digits = digitsOf(phone);
  return digits.startsWith("591") ? digits.slice(3) : digits;
};
const chatLink = (phone: string) => `<a href="https://wa.me/${digitsOf(phone)}">💬 chat</a>`;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// Cursos que se muestran: los que vienen, el que está en marcha y los dictados hace poco.
function visibleCourses(courses: RosterCourse[], now: Date): RosterCourse[] {
  return courses
    .filter((course) => new Date(course.startsAt).getTime() + FINISHED_VISIBLE_DAYS * DAY > now.getTime())
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

const courseEmoji = (course: RosterCourse, courses: RosterCourse[]) =>
  COURSE_EMOJIS[Math.max(0, courses.findIndex((c) => c.id === course.id)) % COURSE_EMOJIS.length];

type Assignment =
  | { courseIds: string[]; combo: boolean; source: "auto" | "team" }
  | { hidden: "paquetes" | "no" }
  | "unassigned"
  | null;

type RosterContext = {
  shown: RosterCourse[];
  listed: Map<string, RosterCourse>;
  bundle: RosterBundle;
  corrections: RosterCorrection[];
  now: Date;
};

// Correcciones del equipo para este comprobante (cualquiera de sus mensajes), de la más vieja
// a la más nueva: manda la última elección y la última nota escrita.
function correctionsFor(entry: LedgerEntry, corrections: RosterCorrection[]): RosterCorrection[] {
  const ids = new Set(entry.messageIds);
  return corrections.filter((c) => ids.has(c.key)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function assign(entry: LedgerEntry, team: RosterCorrection | null, ctx: RosterContext): Assignment {
  const auto = autoAssign(entry, ctx);
  if (!team) return auto;

  // "Es de paquete" o "no es de curso" solo sacan algo que /inscritos iba a mostrar. Sobre un pago
  // que ya era de paquetes, la elección solo deja su nota en /pagos.
  if (team.choice === "no" || team.choice === "paquetes") return auto === null ? null : { hidden: team.choice };
  if (team.choice === "combo") {
    const ids = ctx.bundle.courseIds.filter((id) => ctx.listed.has(id));
    if (ids.length > 0) return { courseIds: ids, combo: true, source: "team" };
  }
  if (ctx.listed.has(team.choice)) return { courseIds: [team.choice], combo: false, source: "team" };
  // Una corrección hacia un curso que ya no se muestra: el pago es de esa edición.
  return null;
}

// Lo que dice la etiqueta del bot, sin ninguna corrección del equipo.
function autoAssign(entry: LedgerEntry, ctx: RosterContext): Assignment {
  // La etiqueta solo vale para la MISMA fecha: un pago del curso de septiembre no es de este.
  const sameEdition = (id: string, startsAt: string) => ctx.listed.get(id)?.startsAt === startsAt;
  const tag = entry.tag;

  if (tag?.kind === "course") {
    return sameEdition(tag.courseId, tag.courseStartsAt)
      ? { courseIds: [tag.courseId], combo: false, source: "auto" }
      : null;
  }
  if (tag?.kind === "course_bundle") {
    const ids = tag.options.filter((o) => sameEdition(o.id, o.startsAt)).map((o) => o.id);
    return ids.length > 0 ? { courseIds: ids, combo: true, source: "auto" } : null;
  }
  if (tag?.kind === "course_unknown") {
    return tag.options.some((o) => sameEdition(o.id, o.startsAt)) ? "unassigned" : null;
  }
  if (tag?.kind === "packages") return null;

  // Sin etiqueta (o "otro motivo"): solo si el chat estaba en cursos y es reciente.
  const recent = new Date(entry.paidAt).getTime() >= ctx.now.getTime() - UNTAGGED_LOOKBACK_DAYS * DAY;
  return recent && entry.context.startsWith("🎓") ? "unassigned" : null;
}

// Cupos del comprobante según el monto y lo que se pagó.
function seatsFor(
  entry: LedgerEntry,
  courseIds: string[],
  combo: boolean,
  ctx: RosterContext,
): { seats: number; warnings: string[] } {
  const warnings: string[] = [];
  const names = entry.names.length;
  const course = ctx.listed.get(courseIds[0]);
  const unit = combo ? ctx.bundle.price : (course?.pricePreventa ?? null);
  const amount = entry.amount;
  let seats: number;

  if (amount && unit) {
    if (amount % unit === 0) {
      seats = amount / unit;
    } else if (!combo && course && amount % course.pricePresencial === 0) {
      // Precio en puerta.
      seats = amount / course.pricePresencial;
    } else if (amount < unit) {
      seats = 1;
      warnings.push(`💸 Abonó ${amount} de ${unit} Bs`);
    } else {
      seats = Math.max(1, names);
      warnings.push(`⚠️ ${amount} Bs no es múltiplo de ${unit} Bs — revisar`);
    }
  } else {
    seats = Math.max(1, names);
    warnings.push("🔎 Monto no leído — revisar el comprobante");
  }

  if (names > seats) warnings.push(`⚠️ ${names} nombres para ${plural(seats, "cupo", "cupos")} — confirmar`);
  if (names === 0) warnings.push("✍️ Falta el nombre completo");
  return { seats, warnings };
}

// Pista para el equipo: qué podría ser ese monto.
function hintFor(amount: number | null, ctx: RosterContext): string | null {
  if (!amount) return null;
  const parts: string[] = [];
  const bundleIds = ctx.bundle.courseIds.filter((id) => ctx.listed.has(id));
  if (bundleIds.length >= 2 && amount % ctx.bundle.price === 0) {
    const n = amount / ctx.bundle.price;
    parts.push(n === 1 ? "1 combo" : `${n} combos`);
  }
  const singlePrices = [...new Set([...ctx.listed.values()].map((c) => c.pricePreventa))];
  for (const price of singlePrices) {
    if (amount % price !== 0) continue;
    const n = amount / price;
    parts.push(n === 1 ? "1 curso suelto" : `${n} cursos sueltos`);
  }
  return parts.length > 0
    ? `💡 ${amount} Bs = ${parts.join(" o ")}`
    : `💡 ${amount} Bs no coincide con los precios de los cursos`;
}

// Lo que escribió el cliente junto al pago, sin las comillas que le pone la lista de pagos.
function quoteOf(entry: LedgerEntry): string | null {
  if (entry.motive) return entry.motive;
  const caption = entry.evidence.match(/^💬 "([\s\S]*)"$/)?.[1];
  return caption ?? null;
}

function buildCourseRoster(params: {
  entries: LedgerEntry[];
  corrections: RosterCorrection[];
  intents: CourseIntent[];
  profileNames: Map<string, string>;
  courses: RosterCourse[];
  bundle: RosterBundle;
  now: Date;
}): CourseRoster {
  const shown = visibleCourses(params.courses, params.now);
  const ctx: RosterContext = {
    shown,
    listed: new Map(shown.map((course) => [course.id, course])),
    bundle: params.bundle,
    corrections: params.corrections,
    now: params.now,
  };

  const byCourse = new Map<string, RosterRow[]>(shown.map((course) => [course.id, []]));
  const unassigned: RosterRow[] = [];
  const hidden: RosterRow[] = [];
  const byShortKey = new Map<string, RosterRow>();

  for (const entry of params.entries) {
    const key = entry.messageIds[0];
    if (!key) continue;
    const team = correctionsFor(entry, params.corrections);
    const latest = team.at(-1) ?? null;
    const note = [...team].reverse().find((c) => c.note?.trim())?.note?.trim() ?? null;
    const assignment = assign(entry, latest, ctx);
    if (assignment === null) continue;

    const base: RosterRow = {
      key,
      shortKey: shortKeyOf(key),
      phone: entry.phone,
      names: entry.names,
      phones: entry.phones,
      profileName: entry.profileName,
      paidAt: entry.paidAt,
      confirmed: entry.status === "confirmed",
      amount: entry.amount,
      quote: quoteOf(entry),
      label: entry.tag ? renderTagLabel(entry.tag) : entry.context,
      courseIds: [],
      combo: false,
      seats: 0,
      source: null,
      note,
      hiddenReason: null,
      warnings: [],
      hint: null,
    };

    let row: RosterRow;
    if (assignment === "unassigned") {
      row = { ...base, hint: hintFor(entry.amount, ctx) };
      unassigned.push(row);
    } else if ("hidden" in assignment) {
      row = { ...base, source: "team", hiddenReason: assignment.hidden };
      hidden.push(row);
    } else {
      const { seats, warnings } = seatsFor(entry, assignment.courseIds, assignment.combo, ctx);
      row = { ...base, courseIds: assignment.courseIds, combo: assignment.combo, seats, warnings, source: assignment.source };
      for (const id of assignment.courseIds) byCourse.get(id)?.push(row);
    }
    byShortKey.set(row.shortKey, row);
  }

  // Lo más viejo arriba: es el orden en que se inscribieron.
  const byPaidAt = (a: RosterRow, b: RosterRow) => a.paidAt.localeCompare(b.paidAt);

  const courses = shown.map((course) => {
    const rows = (byCourse.get(course.id) ?? []).sort(byPaidAt);
    return { course, rows, seats: rows.reduce((sum, row) => sum + row.seats, 0) };
  });

  return {
    courses,
    unassigned: unassigned.sort(byPaidAt),
    hidden: hidden.sort(byPaidAt),
    pending: buildPending(params),
    byShortKey,
  };
}

// Tocaron pagar o recibieron el QR, y después no llegó ningún comprobante de ese número. El QR
// también sale para pagos de paquetes, pero casi nunca (una vez en todo nov 2026): se muestra
// igual, con su rótulo, antes que perder a alguien de un curso.
function buildPending(params: {
  entries: LedgerEntry[];
  intents: CourseIntent[];
  profileNames: Map<string, string>;
  now: Date;
}): PendingIntent[] {
  const since = params.now.getTime() - PENDING_LOOKBACK_DAYS * DAY;
  const byPhone = new Map<string, CourseIntent[]>();

  for (const intent of params.intents) {
    if (new Date(intent.createdAt).getTime() < since) continue;
    const list = byPhone.get(intent.phone) ?? [];
    list.push(intent);
    byPhone.set(intent.phone, list);
  }

  const pending: PendingIntent[] = [];
  for (const [phone, intents] of byPhone) {
    intents.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const firstAt = new Date(intents[0].createdAt).getTime() - PAID_BEFORE_INTENT_MINUTES * 60_000;
    const paid = params.entries.some((entry) => entry.phone === phone && new Date(entry.paidAt).getTime() >= firstAt);
    if (paid) continue;

    // Se muestra lo que eligió en la página si lo hay (dice cuánto iba a pagar).
    const shown = [...intents].reverse().find((i) => i.kind === "pay_click") ?? intents[intents.length - 1];
    pending.push({ ...shown, profileName: params.profileNames.get(phone) ?? null });
  }

  return pending.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// --------------------------------------------------------------------------------------------
// Lo que se ve en Telegram
// --------------------------------------------------------------------------------------------

function courseStatusLabel(course: RosterCourse, now: Date): string {
  const start = new Date(course.startsAt).getTime();
  const today = boliviaDateKey(now);
  const courseDay = boliviaDateKey(new Date(course.startsAt));
  if (now.getTime() >= start + 6 * 3600_000) return "✔️ ya se dictó";
  if (now.getTime() >= start) return "🟢 en marcha";
  if (courseDay === today) return "🔴 ES HOY";
  const days = Math.round((new Date(`${courseDay}T00:00:00-04:00`).getTime() - new Date(`${today}T00:00:00-04:00`).getTime()) / DAY);
  return days === 1 ? "⏳ es mañana" : `⏳ faltan ${days} días`;
}

function choiceLabel(choice: RosterChoice, courses: RosterCourse[]): string {
  if (choice === "combo") return "🎓 Combo (los dos cursos)";
  if (choice === "paquetes") return "🎬 Paquete de videos";
  if (choice === "no") return "🚫 Otro / no es un pago";
  const course = courses.find((c) => c.id === choice);
  return course ? `${courseEmoji(course, courses)} ${courseShortName(course)} · ${formatShortDay(course.startsAt)}` : choice;
}

function renderNameLines(row: RosterRow, index: number | null): string[] {
  const prefix = index === null ? "" : `<b>${index}.</b> `;
  const [first, ...others] = row.names;
  return [
    first
      ? `${prefix}👤 <b>${escapeHtml(first)}</b>`
      : `${prefix}👤 ${row.profileName ? `${escapeHtml(row.profileName)} <i>(perfil, sin nombre)</i>` : "<i>(sin nombre)</i>"}`,
    ...others.map((name) => `     ➕ ${escapeHtml(name)}`),
  ];
}

function renderPhoneLine(row: { phone: string; phones?: string[] }): string {
  return `📱 ${[...new Set([localPhone(row.phone), ...(row.phones ?? [])])].join(" · ")} · ${chatLink(row.phone)}`;
}

// Qué pagó, en una línea: "🎟️ Combo × 2 · 💵 1000 Bs · ✅".
function renderPaidLine(row: RosterRow): string {
  const what = row.combo
    ? row.seats > 1
      ? `Combo × ${row.seats}`
      : "Combo (los dos cursos)"
    : plural(row.seats, "cupo", "cupos");
  return [
    `🎟️ ${what}`,
    row.amount ? `💵 ${row.amount} Bs` : null,
    row.confirmed ? "✅" : "❓ sin verificar",
    row.source === "team" ? "✍️ revisado" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

// Contexto del pago: la nota del equipo manda; sin nota, lo que escribió el cliente y los avisos.
function renderContextLines(row: RosterRow): string[] {
  if (row.note) return [`📝 ${escapeHtml(row.note)}`];
  return [
    ...(row.quote ? [`💬 "${escapeHtml(row.quote.replace(/\s+/g, " ").slice(0, 100))}"`] : []),
    ...row.warnings.map((warning) => escapeHtml(warning)),
  ];
}

function renderRosterRow(row: RosterRow, index: number): string {
  return [
    ...renderNameLines(row, index),
    `     ${renderPaidLine(row)}`,
    `     ${renderPhoneLine(row)}`,
    ...renderContextLines(row).map((line) => `     ${line}`),
  ].join("\n");
}

const inscritos = (n: number) => plural(n, "inscrito", "inscritos");

function renderSummary(roster: CourseRoster, now: Date): RosterMessage {
  const paquetes = roster.hidden.filter((row) => row.hiddenReason === "paquetes").length;
  const otros = roster.hidden.length - paquetes;
  const allCourses = roster.courses.map((c) => c.course);

  const lines = [
    `🎓 <b>INSCRITOS</b> · al ${formatStamp(now.toISOString())}`,
    DIVIDER,
    ...roster.courses.map(
      ({ course, seats }) =>
        `${courseEmoji(course, allCourses)} ${escapeHtml(courseShortName(course))} (${formatShortDay(course.startsAt)}): <b>${inscritos(seats)}</b>`,
    ),
    "",
    roster.unassigned.length > 0
      ? `⚠️ Pagos por asignar: <b>${roster.unassigned.length}</b> → abajo, con botones`
      : "⚠️ Pagos por asignar: 0",
    `🛒 Por cobrar: <b>${roster.pending.length}</b> (tocaron pagar y no mandaron comprobante)`,
    ...(roster.hidden.length > 0
      ? [`🚫 No son de curso: ${[paquetes ? `🎬 ${paquetes} de paquete` : null, otros ? `${otros} otro${otros === 1 ? "" : "s"}` : null].filter(Boolean).join(" · ")}`]
      : []),
  ];

  return {
    blocks: [lines.join("\n")],
    keyboard: {
      inline_keyboard: [
        [
          { text: "🛒 Ver por cobrar", callback_data: "menu:porcobrar" },
          { text: "🔄 Actualizar", callback_data: "menu:inscritos" },
        ],
      ],
    },
  };
}

function renderCourseMessage(
  entry: CourseRoster["courses"][number],
  allCourses: RosterCourse[],
  now: Date,
): RosterMessage {
  const { course, rows, seats } = entry;
  const header = [
    `${courseEmoji(course, allCourses)} <b>${escapeHtml(courseShortName(course).toUpperCase())}</b>`,
    `🗓️ ${formatStamp(course.startsAt)} · ${courseStatusLabel(course, now)}`,
    `👥 <b>${inscritos(seats)}</b> · ${plural(rows.length, "pago", "pagos")}`,
    DIVIDER,
  ].join("\n");

  return {
    blocks: [header, ...(rows.length === 0 ? ["<i>Todavía no hay inscritos.</i>"] : rows.map((row, i) => renderRosterRow(row, i + 1)))],
  };
}

// Botones para decir de qué es un pago: un curso, el combo, un paquete o nada.
function assignmentKeyboard(shortKey: string, courses: RosterCourse[], bundle: RosterBundle, now: Date): InlineKeyboard {
  const shown = visibleCourses(courses, now);
  const button = (choice: RosterChoice): InlineButton => ({ text: choiceLabel(choice, shown), callback_data: `ins:${shortKey}:${choice}` });
  const rows: InlineButton[][] = shown.map((course) => [button(course.id)]);
  const bundleShown = bundle.courseIds.filter((id) => shown.some((c) => c.id === id));
  rows.push(bundleShown.length >= 2 ? [button("combo"), button("paquetes")] : [button("paquetes")]);
  rows.push([button("no")]);
  return { inline_keyboard: rows };
}

function renderUnassignedRow(row: RosterRow, position: number, total: number): string {
  return [
    `⚠️ <b>PAGO POR ASIGNAR</b> (${position} de ${total})`,
    ...renderNameLines(row, null),
    `💵 ${row.amount ? `${row.amount} Bs` : "monto no leído"} · ${row.confirmed ? "✅ comprobante" : "❓ sin verificar"} · ${formatStamp(row.paidAt)}`,
    ...(row.quote ? [`💬 "${escapeHtml(row.quote.replace(/\s+/g, " ").slice(0, 100))}"`] : []),
    ...(row.hint ? [escapeHtml(row.hint)] : []),
    renderPhoneLine(row),
    "👇 <b>¿De qué es este pago?</b>",
  ].join("\n");
}

function renderCourseRoster(
  roster: CourseRoster,
  params: { courses: RosterCourse[]; bundle: RosterBundle; now: Date },
): RosterMessage[] {
  const { now } = params;

  if (roster.courses.length === 0) {
    return [
      {
        blocks: [
          `🎓 <b>INSCRITOS</b> · al ${formatStamp(now.toISOString())}\n\nNo hay ningún curso con fecha cargada. Las fechas se cargan en <code>lib/courses.ts</code>.`,
        ],
      },
    ];
  }

  const allCourses = roster.courses.map((c) => c.course);
  const shownUnassigned = roster.unassigned.slice(0, MAX_UNASSIGNED_MESSAGES);
  const summary = renderSummary(roster, now);
  if (roster.unassigned.length > shownUnassigned.length) {
    summary.blocks.push(
      `ℹ️ Van los primeros ${shownUnassigned.length} por asignar: asígnalos y toca 🔄 para ver el resto.`,
    );
  }

  return [
    summary,
    ...roster.courses.map((entry) => renderCourseMessage(entry, allCourses, now)),
    ...shownUnassigned.map((row, i) => ({
      blocks: [renderUnassignedRow(row, i + 1, roster.unassigned.length)],
      keyboard: assignmentKeyboard(row.shortKey, params.courses, params.bundle, now),
    })),
  ];
}

function intentLabel(intent: PendingIntent, courses: RosterCourse[]): string {
  if (intent.kind === "qr") return `📲 Recibió el QR (curso u otro pago) · ${formatStamp(intent.createdAt)}`;
  const option =
    intent.option === "combo"
      ? "Combo"
      : (courses.find((c) => c.id === intent.option)?.name.replace(/^Curso de\s+/i, "") ?? intent.option ?? "un curso");
  return `🌐 Eligió ${option}${intent.amount ? ` · ${intent.amount} Bs` : ""} · ${formatStamp(intent.createdAt)}`;
}

// /porcobrar: quienes tocaron pagar o recibieron el QR y no mandaron comprobante.
function renderPendingPayments(roster: CourseRoster, params: { courses: RosterCourse[]; now: Date }): RosterMessage {
  const header = [
    `🛒 <b>POR COBRAR</b> · ${plural(roster.pending.length, "persona", "personas")}`,
    "Tocaron pagar o recibieron el QR y no mandaron comprobante. Escríbeles antes del curso 👇",
    DIVIDER,
  ].join("\n");

  if (roster.pending.length === 0) {
    return { blocks: [header, "<i>Nadie pendiente: todos los que tocaron pagar mandaron su comprobante 🙌</i>"] };
  }

  return {
    blocks: [
      header,
      ...roster.pending.map((intent, i) =>
        [
          `<b>${i + 1}.</b> 👤 ${intent.profileName ? escapeHtml(intent.profileName) : "<i>(sin nombre)</i>"}`,
          `     ${intentLabel(intent, params.courses)}`,
          `     ${renderPhoneLine(intent)}`,
        ].join("\n"),
      ),
    ],
  };
}

// Mensaje que reemplaza al del pago después de tocar un botón. Lleva los mismos botones por si
// se equivocaron.
function renderAssignmentResult(
  row: RosterRow,
  choice: RosterChoice,
  params: { courses: RosterCourse[]; bundle: RosterBundle; now: Date; by: string | null },
): { text: string; keyboard: InlineKeyboard } {
  const shown = visibleCourses(params.courses, params.now);
  const counted = choice !== "no" && choice !== "paquetes";
  return {
    text: [
      `✅ <b>Guardado</b> · ${escapeHtml(choiceLabel(choice, shown))}${params.by ? ` · por ${escapeHtml(params.by)}` : ""}`,
      ...renderNameLines(row, null),
      counted ? renderPaidLine(row) : `💵 ${row.amount ? `${row.amount} Bs` : "monto no leído"} · no suma inscritos`,
      ...(counted ? row.warnings.map((warning) => escapeHtml(warning)) : []),
      renderPhoneLine(row),
      "<i>¿Te equivocaste? Toca otra opción. 🔄 en /inscritos muestra la lista al día.</i>",
    ].join("\n"),
    keyboard: assignmentKeyboard(row.shortKey, params.courses, params.bundle, params.now),
  };
}

// "ins:<clave corta>:<opción>" → partes, o null si no es un botón de inscritos.
function parseRosterCallback(data: string): { shortKey: string; choice: RosterChoice } | null {
  const match = String(data ?? "").match(/^ins:([0-9a-f]{10}):([a-z0-9_]+)$/);
  return match ? { shortKey: match[1], choice: match[2] } : null;
}

// ¿Es una opción válida para estos cursos?
function isValidChoice(choice: RosterChoice, courses: RosterCourse[], now: Date): boolean {
  if (choice === "no" || choice === "combo" || choice === "paquetes") return true;
  return visibleCourses(courses, now).some((course) => course.id === choice);
}

// Lo que el equipo decidió sobre cada comprobante, para mostrarlo también en /pagos.
function applyTeamCorrections(
  entries: LedgerEntry[],
  corrections: RosterCorrection[],
  courses: RosterCourse[],
): LedgerEntry[] {
  return entries.map((entry) => {
    const team = correctionsFor(entry, corrections);
    const latest = team.at(-1);
    if (!latest) return entry;
    const note = [...team].reverse().find((c) => c.note?.trim())?.note?.trim() ?? null;
    return { ...entry, teamLabel: choiceLabel(latest.choice, courses), teamNote: note };
  });
}

// --------------------------------------------------------------------------------------------
// LISTA DE ESPERA
// --------------------------------------------------------------------------------------------

type WaitlistEntry = {
  phone: string;
  createdAt: string;
  clientMessage: string | null;
  profileName: string | null;
};

function renderCourseWaitlist(entries: WaitlistEntry[], now: Date, enrolledPhones: Set<string> = new Set()): string[] {
  // Una persona una sola vez (lo más reciente).
  const byPhone = new Map<string, WaitlistEntry>();
  for (const entry of entries) {
    const current = byPhone.get(entry.phone);
    if (!current || entry.createdAt > current.createdAt) byPhone.set(entry.phone, entry);
  }
  const list = [...byPhone.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const enrolled = list.filter((entry) => enrolledPhones.has(entry.phone)).length;

  const blocks = [
    [
      `📋 <b>LISTA DE ESPERA</b> · ${plural(list.length, "persona", "personas")}`,
      "Preguntaron por un curso cuando no había fecha. Avísales cuando abra una nueva 📣",
      ...(enrolled > 0 ? [`✅ = ya se inscribió (${enrolled})`] : []),
      DIVIDER,
    ].join("\n"),
  ];

  if (list.length === 0) {
    blocks.push("<i>Todavía no hay nadie. Se llena sola: el bot anota a quien pregunta por un curso sin fecha.</i>");
    return blocks;
  }

  list.forEach((entry, i) => {
    const name = entry.profileName ? escapeHtml(entry.profileName) : "<i>(sin nombre)</i>";
    const done = enrolledPhones.has(entry.phone) ? " ✅" : "";
    blocks.push(
      [
        `<b>${i + 1}.</b> 👤 ${name}${done} · 🗓️ ${formatShortDay(entry.createdAt)}`,
        ...(entry.clientMessage ? [`     💬 "${escapeHtml(entry.clientMessage.replace(/\s+/g, " ").slice(0, 80))}"`] : []),
        `     ${renderPhoneLine(entry)}`,
      ].join("\n"),
    );
  });

  const toNotify = list.filter((entry) => !enrolledPhones.has(entry.phone));
  if (toNotify.length > 0) {
    blocks.push(
      `\n📲 <b>Para difusión</b> (copiar y pegar):\n<code>${toNotify.map((entry) => localPhone(entry.phone)).join(", ")}</code>`,
    );
  }
  return blocks;
}

export {
  ROSTER_LOOKBACK_DAYS,
  PENDING_LOOKBACK_DAYS,
  WAITLIST_LOOKBACK_DAYS,
  ROSTER_SET_MARKER,
  WAITLIST_MARKERS,
  shortKeyOf,
  buildCourseRoster,
  renderCourseRoster,
  renderPendingPayments,
  renderAssignmentResult,
  parseRosterCallback,
  isValidChoice,
  applyTeamCorrections,
  renderCourseWaitlist,
};
export type {
  RosterCourse,
  RosterBundle,
  RosterChoice,
  RosterCorrection,
  CourseIntent,
  RosterRow,
  CourseRoster,
  RosterMessage,
  WaitlistEntry,
  InlineKeyboard,
};

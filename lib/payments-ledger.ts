// PAGOS — botón "💰 Pagos" (/pagos) del grupo de Telegram.
//
// Una lista GLOBAL de todos los comprobantes de un rango de fechas, cada uno con su etiqueta
// (curso y fecha, paquete, otro motivo o sin etiqueta). No se reparte por curso a propósito:
// sirve para revisar chat por chat que no falte ninguno, y la etiqueta ya dice de qué es
// cada pago (ver lib/payment-alerts.ts). Reemplaza a las listas por curso ("Inscritos").
//
// Cómo se arma, todo desde la base de datos:
//   1. Los pagos del rango (lib/payments-report.ts): toda imagen o PDF de cliente y todo
//      texto que afirma un pago, agrupados por envío.
//   2. Confirmados (visión o alerta 💰) y por revisar (el bot no lo confirmó). Lo que la
//      visión descartó, o un texto suelto con "pago" en un chat sin curso, no entra.
//   3. Nombre y celular: los que el cliente mandó para la alerta o escribió alrededor del
//      comprobante; si no escribió nada, su perfil de WhatsApp.
//
// Funciones puras: el route handler de Telegram consulta Supabase y les pasa las filas.

import type { PaymentEntry } from "./payments-report.ts";
import { renderTagLabel } from "./payment-alerts.ts";
import type { PaymentTag } from "./payment-alerts.ts";
import { extractContactLines } from "./contact-lines.ts";

type ClientText = { phone: string; content: string; createdAt: string };

type LedgerEntry = {
  phone: string;
  status: "confirmed" | "review";
  paidAt: string;
  alerted: boolean;
  names: string[];
  phones: string[];
  profileName: string | null;
  // Etiqueta de la alerta 💰; null = sin etiqueta (pagos anteriores o sin alerta).
  tag: PaymentTag | null;
  motive: string | null;
  // Contexto detectado (QR enviado, formulario...), útil cuando no hay etiqueta.
  context: string;
  evidence: string;
};

type LedgerRange = { fromIso: string; toIso: string; label: string };

// Mensajes del cliente que se miran para buscar su nombre: los de la misma ráfaga del
// comprobante y las horas siguientes (el nombre se pide justo después del pago). Una ventana
// más amplia metía frases de otras conversaciones ("vengo del live", "nadie me contactó").
const NAME_LOOKBACK_MINUTES = 10;
const NAME_LOOKAHEAD_HOURS = 12;
// Rango máximo que se puede pedir: más que esto es una lista inmanejable en Telegram.
const MAX_RANGE_DAYS = 62;

const DAY = 24 * 60 * 60_000;
const BOLIVIA_TZ = "America/La_Paz";
// Bolivia no tiene horario de verano: siempre UTC-4.
const BOLIVIA_OFFSET = "-04:00";

const RANGE_PRESETS = [
  { id: "hoy", label: "Hoy" },
  { id: "ayer", label: "Ayer" },
  { id: "7", label: "Últimos 7 días" },
  { id: "15", label: "Últimos 15 días" },
  { id: "30", label: "Últimos 30 días" },
] as const;

const normalize = (text: string) =>
  String(text ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase();

const unique = (values: string[]) => {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = normalize(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

// "2026-09-18" en hora de Bolivia.
const boliviaDateKey = (date: Date) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: BOLIVIA_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);

const startOfBoliviaDay = (key: string) => new Date(`${key}T00:00:00${BOLIVIA_OFFSET}`).getTime();

// "18/09"
function formatShortDay(iso: string): string {
  const [, month, day] = boliviaDateKey(new Date(iso)).split("-");
  return `${day}/${month}`;
}

// Rango de un botón (Hoy, Ayer, últimos N días), en días de calendario de Bolivia.
function resolvePresetRange(presetId: string, now: Date): LedgerRange | null {
  const preset = RANGE_PRESETS.find((p) => p.id === presetId);
  if (!preset) return null;

  const today = startOfBoliviaDay(boliviaDateKey(now));

  if (preset.id === "ayer") {
    return { fromIso: new Date(today - DAY).toISOString(), toIso: new Date(today).toISOString(), label: preset.label };
  }

  const days = preset.id === "hoy" ? 1 : Number(preset.id);
  return {
    fromIso: new Date(today - (days - 1) * DAY).toISOString(),
    toIso: now.toISOString(),
    label: preset.label,
  };
}

// Rango escrito a mano: "/pagos 10/09 18/09" (o una sola fecha, o con año "10/09/2026").
// Sin año se toma el más reciente que no quede en el futuro. null si no se entiende.
function parseCustomRange(text: string, now: Date): LedgerRange | null {
  const dates = [...String(text ?? "").matchAll(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/g)];
  if (dates.length === 0 || dates.length > 2) return null;

  const currentYear = Number(boliviaDateKey(now).slice(0, 4));
  const toKey = (match: RegExpMatchArray): string | null => {
    const day = Number(match[1]);
    const month = Number(match[2]);
    if (day < 1 || day > 31 || month < 1 || month > 12) return null;

    let year = match[3] ? Number(match[3].length === 2 ? `20${match[3]}` : match[3]) : currentYear;
    const key = (y: number) => `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (!match[3] && startOfBoliviaDay(key(year)) > now.getTime()) year -= 1;

    const result = key(year);
    // Descarta fechas imposibles ("31/02"): o no se pueden leer, o caen en otro día.
    const start = startOfBoliviaDay(result);
    if (Number.isNaN(start)) return null;
    return boliviaDateKey(new Date(start + 12 * 3600_000)) === result ? result : null;
  };

  const fromKey = toKey(dates[0]);
  const toKeyValue = dates[1] ? toKey(dates[1]) : fromKey;
  if (!fromKey || !toKeyValue) return null;

  const from = startOfBoliviaDay(fromKey);
  const to = Math.min(startOfBoliviaDay(toKeyValue) + DAY, now.getTime());
  if (to <= from || to - from > MAX_RANGE_DAYS * DAY) return null;

  const fromIso = new Date(from).toISOString();
  return {
    fromIso,
    toIso: new Date(to).toISOString(),
    label: fromKey === toKeyValue ? formatShortDay(fromIso) : `${formatShortDay(fromIso)} al ${formatShortDay(new Date(to - 1).toISOString())}`,
  };
}

// Nombres y celulares de un cliente: los que mandó para la alerta 💰 y los que escribió
// alrededor de su pago.
function collectContactData(
  entry: PaymentEntry,
  texts: ClientText[],
): { names: string[]; phones: string[] } {
  const from = new Date(entry.firstAt).getTime() - NAME_LOOKBACK_MINUTES * 60_000;
  const until = new Date(entry.lastAt).getTime() + NAME_LOOKAHEAD_HOURS * 3600_000;

  const names: string[] = [...(entry.taggedNames ?? [])];
  const phones: string[] = [];
  for (const text of texts) {
    if (text.phone !== entry.phone) continue;
    const t = new Date(text.createdAt).getTime();
    if (t < from || t > until) continue;
    const found = extractContactLines(text.content);
    names.push(...found.names);
    phones.push(...found.phones);
  }

  return { names: unique(names), phones: [...new Set(phones)] };
}

// ¿Entra en la lista? Lo confirmado siempre. Lo que el bot no confirmó entra si hay un
// archivo, o si es un texto de pago en un chat de curso: los textos sueltos con "pago" en
// otros chats eran casi siempre preguntas ("¿incluye publicidad pagada?") o publicidad de
// otros negocios.
function isLedgerPayment(entry: PaymentEntry): boolean {
  if (entry.category === "confirmed") return true;
  if (entry.category !== "review") return false;
  if (entry.kinds.images + entry.kinds.documents > 0) return true;
  return entry.context.startsWith("🎓");
}

function buildPaymentsLedger(params: {
  payments: PaymentEntry[];
  texts: ClientText[];
  profileNames: Map<string, string>;
}): LedgerEntry[] {
  return params.payments
    .filter(isLedgerPayment)
    .map((entry): LedgerEntry => {
      const { names, phones } = collectContactData(entry, params.texts);
      return {
        phone: entry.phone,
        status: entry.category === "confirmed" ? "confirmed" : "review",
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
    // Lo más reciente arriba: es lo primero que se revisa.
    .sort((a, b) => b.paidAt.localeCompare(a.paidAt));
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const tagLabel = (entry: LedgerEntry) =>
  entry.tag ? renderTagLabel(entry.tag) : "❔ Sin etiqueta";

function formatBoliviaTime(iso: string): string {
  return new Intl.DateTimeFormat("es-BO", {
    timeZone: BOLIVIA_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

// "jueves 18/09"
function formatDayHeader(iso: string): string {
  const weekday = new Intl.DateTimeFormat("es-BO", { timeZone: BOLIVIA_TZ, weekday: "long" }).format(new Date(iso));
  return `${weekday} ${formatShortDay(iso)}`;
}

function renderLedgerEntry(entry: LedgerEntry, index: number): string {
  const digits = entry.phone.replace(/\D/g, "");
  const localPhone = digits.startsWith("591") ? digits.slice(3) : digits;
  const [firstName, ...otherNames] = entry.names;
  // Sin etiqueta se muestra el contexto que se detectó, para saber por dónde empezar.
  const label = entry.tag ? tagLabel(entry) : `${tagLabel(entry)} · ${entry.context}`;

  return [
    firstName
      ? `<b>${index}.</b> 👤 ${escapeHtml(firstName)}`
      : `<b>${index}.</b> 👤 <i>(no escribió su nombre${entry.profileName ? ` — perfil: ${escapeHtml(entry.profileName)}` : ""})</i>`,
    ...otherNames.map((name) => `     ➕ ${escapeHtml(name)}`),
    `     🏷️ ${escapeHtml(label)}`,
    ...(entry.motive && entry.tag?.kind !== "course" ? [`     📝 ${escapeHtml(entry.motive)}`] : []),
    `     📱 ${[...new Set([localPhone, ...entry.phones])].join(" · ")} · <a href="https://wa.me/${digits}">abrir chat</a>`,
    `     🕐 ${formatBoliviaTime(entry.paidAt)} · ${entry.status === "confirmed" ? "✅ confirmado" : "❓ por revisar"}${entry.alerted ? " · 🔔 alerta" : ""}${entry.status === "review" && entry.evidence ? ` · ${escapeHtml(entry.evidence)}` : ""}`,
  ].join("\n");
}

function renderPaymentsLedger(params: { entries: LedgerEntry[]; range: LedgerRange }): string[] {
  const { entries, range } = params;
  const confirmed = entries.filter((e) => e.status === "confirmed").length;

  // Cuántos hay de cada etiqueta, de la más frecuente a la menos.
  const byTag = new Map<string, number>();
  for (const entry of entries) byTag.set(tagLabel(entry), (byTag.get(tagLabel(entry)) ?? 0) + 1);
  const tagLines = [...byTag.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, count]) => `   ${escapeHtml(label)}: ${count}`);

  const blocks = [
    [
      `💰 <b>Pagos — ${escapeHtml(range.label)}</b>`,
      `🗓️ ${formatShortDay(range.fromIso)} al ${formatShortDay(new Date(new Date(range.toIso).getTime() - 1).toISOString())}`,
      `🧾 ${entries.length} comprobantes · ✅ ${confirmed} confirmados · ❓ ${entries.length - confirmed} por revisar`,
      ...(tagLines.length > 0 ? ["🏷️ Por etiqueta:", ...tagLines] : []),
    ].join("\n"),
  ];

  if (entries.length === 0) {
    blocks.push("\nNo hay comprobantes en estas fechas.");
    return blocks;
  }

  let currentDay = "";
  entries.forEach((entry, i) => {
    const day = boliviaDateKey(new Date(entry.paidAt));
    if (day !== currentDay) {
      currentDay = day;
      blocks.push(`\n📅 <b>${formatDayHeader(entry.paidAt)}</b>`);
    }
    blocks.push(renderLedgerEntry(entry, i + 1));
  });

  return blocks;
}

export {
  NAME_LOOKBACK_MINUTES,
  NAME_LOOKAHEAD_HOURS,
  RANGE_PRESETS,
  resolvePresetRange,
  parseCustomRange,
  buildPaymentsLedger,
  renderPaymentsLedger,
};
export type { ClientText, LedgerEntry, LedgerRange };

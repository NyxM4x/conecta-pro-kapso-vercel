// Consultas de Supabase para los botones del grupo de Telegram (💰 Pagos y
// 📞 Llamadas y visitas). Recibe el cliente ya creado para no acoplar este archivo a las
// variables de entorno; toda la lógica de negocio vive en funciones puras aparte
// (lib/payments-report.ts, lib/payments-ledger.ts, lib/pending-contacts.ts).

import { buildPaymentsReport } from "./payments-report.ts";
import type { InboundCandidate, OutboundMarker, VisionVerdict } from "./payments-report.ts";
import { NAME_LOOKAHEAD_HOURS, NAME_LOOKBACK_MINUTES, buildPaymentsLedger } from "./payments-ledger.ts";
import type { ClientText, LedgerEntry } from "./payments-ledger.ts";
import { REQUEST_MARKERS, requestTypeOf } from "./pending-contacts.ts";
import type { PendingContactsData } from "./pending-contacts.ts";
import {
  PENDING_LOOKBACK_DAYS,
  ROSTER_LOOKBACK_DAYS,
  ROSTER_SET_MARKER,
  WAITLIST_LOOKBACK_DAYS,
  WAITLIST_MARKERS,
} from "./course-roster.ts";
import type { CourseIntent, RosterChoice, RosterCorrection, WaitlistEntry } from "./course-roster.ts";

// Cliente de Supabase (tipado laxo a propósito: evita importar supabase-js aquí).
type SupabaseLike = { from: (table: string) => any };

const PAGE = 1000;
const IN_CHUNK = 80;

async function fetchAllPages<T>(build: () => any): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if ((data ?? []).length < PAGE) break;
  }
  return rows;
}

// `.in()` con listas largas arma URLs enormes: se consulta de a trozos.
async function fetchInChunks<T>(values: string[], build: (slice: string[]) => any): Promise<T[]> {
  const rows: T[] = [];
  for (let i = 0; i < values.length; i += IN_CHUNK) {
    rows.push(...(await fetchAllPages<T>(() => build(values.slice(i, i + IN_CHUNK)))));
  }
  return rows;
}

type RawInbound = {
  kapso_message_id: string | null;
  kapso_conversation_id: string | null;
  contact_phone: string | null;
  content: string | null;
  created_at: string;
  message_type: string | null;
};

const toCandidate = (row: RawInbound): InboundCandidate => ({
  messageId: row.kapso_message_id ?? "",
  conversationId: row.kapso_conversation_id,
  phone: row.contact_phone ?? "",
  content: String(row.content ?? ""),
  createdAt: row.created_at,
  type: row.message_type,
});

// Pagos (imágenes, PDF y textos que afirman un pago) entre dos fechas, con el material que
// cada cliente ya había recibido y el veredicto de la verificación por visión.
async function loadPaymentReportData(
  supabase: SupabaseLike,
  sinceIso: string,
  untilIso: string,
): Promise<{
  candidates: InboundCandidate[];
  markers: OutboundMarker[];
  vision: Map<string, VisionVerdict>;
}> {
  const select =
    "kapso_message_id, kapso_conversation_id, contact_phone, content, created_at, message_type:raw_payload->message->>type";

  const media = await fetchAllPages<RawInbound>(() =>
    supabase
      .from("kapso_messages")
      .select(select)
      .eq("direction", "inbound")
      .gte("created_at", sinceIso)
      .lte("created_at", untilIso)
      .or("content.like.📷%,content.like.📄%,raw_payload->message->>type.in.(image,document)")
      .order("created_at", { ascending: true }),
  );

  const texts = await fetchAllPages<RawInbound>(() =>
    supabase
      .from("kapso_messages")
      .select(select)
      .eq("direction", "inbound")
      .gte("created_at", sinceIso)
      .lte("created_at", untilIso)
      .or(
        "content.ilike.%comprobante%,content.ilike.%pagu%,content.ilike.%pagad%,content.ilike.%cancel%,content.ilike.%deposit%,content.ilike.%transfer%,content.ilike.%pago%",
      )
      .order("created_at", { ascending: true }),
  );

  const byId = new Map<string, InboundCandidate>();
  for (const row of [...media, ...texts]) {
    const candidate = toCandidate(row);
    byId.set(candidate.messageId || `${candidate.phone}:${candidate.createdAt}`, candidate);
  }
  const candidates = [...byId.values()];

  // Sin límite inferior de fecha: el QR pudo enviarse antes del rango.
  const phones = [...new Set(candidates.map((c) => c.phone).filter(Boolean))];
  const markerRows = await fetchInChunks<{
    kapso_conversation_id: string | null;
    contact_phone: string;
    content: string;
    created_at: string;
    raw_payload: OutboundMarker["rawPayload"];
  }>(phones, (slice) =>
    supabase
      .from("kapso_messages")
      .select("kapso_conversation_id, contact_phone, content, created_at, raw_payload")
      .eq("direction", "outbound")
      .in("contact_phone", slice)
      .or("content.like.[MEDIA_SENT%,content.like.[INTAKE_FORM_SENT%,content.like.[TELEGRAM_PAYMENT_SENT%"),
  );

  const markers: OutboundMarker[] = markerRows.map((row) => ({
    conversationId: row.kapso_conversation_id,
    phone: row.contact_phone,
    content: row.content,
    createdAt: row.created_at,
    // Solo la alerta 💰 lleva datos útiles (etiqueta, nombres); el resto se descarta.
    rawPayload: row.content.startsWith("[TELEGRAM_PAYMENT_SENT") ? row.raw_payload : null,
  }));

  const visionRows = await fetchAllPages<{ kapso_message_id: string | null; metadata: any }>(() =>
    supabase
      .from("system_logs")
      .select("kapso_message_id, metadata")
      .eq("event_type", "receipt_vision_check")
      .gte("created_at", sinceIso),
  );

  const vision = new Map<string, VisionVerdict>();
  for (const row of visionRows) {
    if (!row.kapso_message_id || row.metadata?.detection_source !== "vision") continue;
    const amount = Number(row.metadata?.amount);
    vision.set(row.kapso_message_id, {
      isReceipt: Boolean(row.metadata?.is_receipt),
      reason: String(row.metadata?.reason ?? ""),
      amount: Number.isFinite(amount) && amount > 0 ? amount : null,
    });
  }

  return { candidates, markers, vision };
}

// Comprobantes de un rango con nombre y celular: lo que muestran /pagos y /inscritos.
async function loadPaymentsLedgerEntries(
  supabase: SupabaseLike,
  fromIso: string,
  toIso: string,
): Promise<LedgerEntry[]> {
  const payments = buildPaymentsReport(await loadPaymentReportData(supabase, fromIso, toIso));
  const phones = [...new Set(payments.map((p) => p.phone))];

  // El nombre llega en la ráfaga del comprobante o en las horas siguientes.
  const textsFrom = new Date(new Date(fromIso).getTime() - NAME_LOOKBACK_MINUTES * 60_000).toISOString();
  const textsUntil = new Date(new Date(toIso).getTime() + NAME_LOOKAHEAD_HOURS * 3600_000).toISOString();
  const [texts, profileNames] = await Promise.all([
    loadClientTexts(supabase, phones, textsFrom, textsUntil),
    loadContactNames(supabase, phones),
  ]);

  return buildPaymentsLedger({ payments, texts, profileNames });
}

const DAY = 24 * 3600_000;

// Todo lo que necesita /inscritos: los comprobantes de las últimas semanas, lo que corrigió el
// equipo con los botones y quiénes tocaron pagar o recibieron el QR.
async function loadCourseRosterData(
  supabase: SupabaseLike,
  now: Date,
): Promise<{
  entries: LedgerEntry[];
  corrections: RosterCorrection[];
  intents: CourseIntent[];
  profileNames: Map<string, string>;
}> {
  const fromIso = new Date(now.getTime() - ROSTER_LOOKBACK_DAYS * DAY).toISOString();
  const intentsFrom = new Date(now.getTime() - PENDING_LOOKBACK_DAYS * DAY).toISOString();

  const [entries, corrections, intentRows] = await Promise.all([
    loadPaymentsLedgerEntries(supabase, fromIso, now.toISOString()),
    loadRosterCorrections(supabase, fromIso),
    fetchAllPages<{ contact_phone: string; content: string; created_at: string; raw_payload: any }>(() =>
      supabase
        .from("kapso_messages")
        .select("contact_phone, content, created_at, raw_payload")
        .eq("direction", "outbound")
        .gte("created_at", intentsFrom)
        .or('content.like."[COURSE_PAY_CLICK%",content.like."[MEDIA_SENT:payment_qr%"')
        .order("created_at", { ascending: true }),
    ),
  ]);

  const intents: CourseIntent[] = intentRows.map((row) => {
    if (!row.content.startsWith("[COURSE_PAY_CLICK")) {
      return { phone: row.contact_phone, kind: "qr", option: null, amount: null, createdAt: row.created_at };
    }
    const amount = Number(row.raw_payload?.amount);
    return {
      phone: row.contact_phone,
      kind: "pay_click",
      option: row.raw_payload?.option ?? null,
      amount: Number.isFinite(amount) ? amount : null,
      createdAt: row.created_at,
    };
  });

  const profileNames = await loadContactNames(supabase, [...new Set(intents.map((i) => i.phone))]);
  return { entries, corrections, intents, profileNames };
}

// Lo que el equipo decidió sobre cada comprobante (botones de /inscritos o registro manual).
async function loadRosterCorrections(supabase: SupabaseLike, sinceIso: string): Promise<RosterCorrection[]> {
  const rows = await fetchAllPages<{ created_at: string; raw_payload: any }>(() =>
    supabase
      .from("kapso_messages")
      .select("created_at, raw_payload")
      .eq("direction", "outbound")
      .like("content", `${ROSTER_SET_MARKER}%`)
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: true }),
  );

  return rows.flatMap((row) => {
    const key = String(row.raw_payload?.key ?? "");
    const choice = String(row.raw_payload?.choice ?? "");
    const note = typeof row.raw_payload?.note === "string" ? row.raw_payload.note : null;
    return key && choice ? [{ key, choice, createdAt: row.created_at, by: row.raw_payload?.by ?? null, note }] : [];
  });
}

// Lo que eligió el equipo con un botón de /inscritos. Va SIN conversación a propósito: así nunca
// entra al historial que lee el bot ni cuenta como el último mensaje del asistente.
async function saveRosterCorrection(
  supabase: SupabaseLike,
  params: { key: string; phone: string; choice: RosterChoice; by: string | null; note?: string | null },
): Promise<boolean> {
  const { error } = await supabase.from("kapso_messages").insert({
    kapso_message_id: null,
    kapso_conversation_id: null,
    contact_phone: params.phone,
    direction: "outbound",
    role: "assistant",
    content: `${ROSTER_SET_MARKER}:${params.key}] ${params.choice}`,
    message_timestamp: new Date().toISOString(),
    batch_index: null,
    raw_payload: {
      type: "course_roster_set",
      key: params.key,
      choice: params.choice,
      by: params.by,
      ...(params.note ? { note: params.note } : {}),
    },
  });
  if (error) console.error("roster correction insert failed", error);
  return !error;
}

// Lista de espera de cursos (/espera), con el nombre de perfil de cada uno.
async function loadCourseWaitlist(supabase: SupabaseLike, now: Date): Promise<WaitlistEntry[]> {
  const since = new Date(now.getTime() - WAITLIST_LOOKBACK_DAYS * DAY).toISOString();
  const rows = await fetchAllPages<{ contact_phone: string; created_at: string; raw_payload: any }>(() =>
    supabase
      .from("kapso_messages")
      .select("contact_phone, created_at, raw_payload")
      .eq("direction", "outbound")
      .gte("created_at", since)
      .or(WAITLIST_MARKERS.map((marker) => `content.like.${marker}%`).join(","))
      .order("created_at", { ascending: true }),
  );

  const names = await loadContactNames(supabase, [...new Set(rows.map((row) => row.contact_phone))]);
  return rows.map((row) => ({
    phone: row.contact_phone,
    createdAt: row.created_at,
    clientMessage: row.raw_payload?.client_message ?? null,
    profileName: names.get(row.contact_phone) ?? null,
  }));
}

// Todo lo que escribieron estos clientes en el rango (para sacar el nombre y el celular que
// mandan después del comprobante).
async function loadClientTexts(
  supabase: SupabaseLike,
  phones: string[],
  sinceIso: string,
  untilIso: string,
): Promise<ClientText[]> {
  const rows = await fetchInChunks<{ contact_phone: string; content: string | null; created_at: string }>(
    phones,
    (slice) =>
      supabase
        .from("kapso_messages")
        .select("contact_phone, content, created_at")
        .eq("direction", "inbound")
        .in("contact_phone", slice)
        .gte("created_at", sinceIso)
        .lte("created_at", untilIso)
        .order("created_at", { ascending: true }),
  );

  return rows.map((row) => ({ phone: row.contact_phone, content: String(row.content ?? ""), createdAt: row.created_at }));
}

// Nombre de perfil de WhatsApp de cada cliente (respaldo cuando no escribió su nombre).
async function loadContactNames(supabase: SupabaseLike, phones: string[]): Promise<Map<string, string>> {
  const rows = await fetchInChunks<{ phone: string; name: string | null }>(phones, (slice) =>
    supabase.from("kapso_contacts").select("phone, name").in("phone", slice),
  );

  const names = new Map<string, string>();
  for (const row of rows) if (row.name) names.set(row.phone, row.name);
  return names;
}

// Pedidos de llamada y de visita a la oficina desde una fecha, con lo necesario para saber
// si alguien del equipo ya le escribió y si dejó sus datos.
async function loadPendingContactsData(supabase: SupabaseLike, sinceIso: string): Promise<PendingContactsData> {
  const markers = await fetchAllPages<{
    kapso_conversation_id: string;
    contact_phone: string;
    content: string;
    created_at: string;
    kind: string | null;
    trigger: string | null;
  }>(() =>
    supabase
      .from("kapso_messages")
      .select("kapso_conversation_id, contact_phone, content, created_at, kind:raw_payload->>kind, trigger:raw_payload->>trigger")
      .eq("direction", "outbound")
      .gte("created_at", sinceIso)
      .or(REQUEST_MARKERS.map((marker) => `content.like.${marker}%`).join(","))
      .order("created_at", { ascending: true }),
  );

  // Los leads de quien solo llenó el formulario se descartan acá, antes de traer sus chats.
  const requests = markers.filter((m) => requestTypeOf(m) !== null);
  const conversationIds = [...new Set(requests.map((r) => r.kapso_conversation_id).filter(Boolean))];

  const followups = await fetchInChunks<{
    kapso_conversation_id: string;
    direction: string;
    content: string | null;
    created_at: string;
    source: string | null;
    kind: string | null;
  }>(conversationIds, (slice) =>
    supabase
      .from("kapso_messages")
      .select("kapso_conversation_id, direction, content, created_at, source:raw_payload->>source, kind:raw_payload->>kind")
      .in("kapso_conversation_id", slice)
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: true }),
  );

  const phones = [...new Set(requests.map((r) => r.contact_phone).filter(Boolean))];
  const profileNames = await loadContactNames(supabase, phones);

  return {
    requests: requests.map((r) => ({
      conversationId: r.kapso_conversation_id,
      phone: r.contact_phone,
      content: r.content,
      createdAt: r.created_at,
      kind: r.kind ?? null,
      trigger: r.trigger ?? null,
    })),
    messages: followups.map((m) => {
      const content = String(m.content ?? "");
      return {
        conversationId: m.kapso_conversation_id,
        direction: m.direction === "inbound" ? "inbound" : "outbound",
        content,
        createdAt: m.created_at,
        byHuman: m.source === "business_app_manual",
        leadKind: content.startsWith("[TELEGRAM_LEAD_SENT]") ? (m.kind ?? null) : null,
      };
    }),
    profileNames,
  };
}

export {
  loadPaymentReportData,
  loadPaymentsLedgerEntries,
  loadClientTexts,
  loadContactNames,
  loadPendingContactsData,
  loadCourseRosterData,
  loadRosterCorrections,
  saveRosterCorrection,
  loadCourseWaitlist,
};

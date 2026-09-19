// Consultas de Supabase para los botones del grupo de Telegram (💰 Pagos y
// 📞 Llamadas y visitas). Recibe el cliente ya creado para no acoplar este archivo a las
// variables de entorno; toda la lógica de negocio vive en funciones puras aparte
// (lib/payments-report.ts, lib/payments-ledger.ts, lib/pending-contacts.ts).

import type { InboundCandidate, OutboundMarker, VisionVerdict } from "./payments-report.ts";
import type { ClientText } from "./payments-ledger.ts";
import { REQUEST_MARKERS, requestTypeOf } from "./pending-contacts.ts";
import type { PendingContactsData } from "./pending-contacts.ts";

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
    vision.set(row.kapso_message_id, {
      isReceipt: Boolean(row.metadata?.is_receipt),
      reason: String(row.metadata?.reason ?? ""),
    });
  }

  return { candidates, markers, vision };
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

export { loadPaymentReportData, loadClientTexts, loadContactNames, loadPendingContactsData };

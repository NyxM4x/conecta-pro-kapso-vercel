// Consultas de Supabase para la lista de pagos de Telegram (ver lib/payments-report.ts).
// Recibe el cliente ya creado para no acoplar este archivo a las variables de entorno.

import type { InboundCandidate, OutboundMarker, VisionVerdict } from "./payments-report.ts";

// Cliente de Supabase (tipado laxo a propósito: evita importar supabase-js aquí).
type SupabaseLike = { from: (table: string) => any };

const PAGE = 1000;

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

async function loadPaymentReportData(
  supabase: SupabaseLike,
  sinceIso: string,
): Promise<{
  candidates: InboundCandidate[];
  markers: OutboundMarker[];
  vision: Map<string, VisionVerdict>;
}> {
  const select =
    "kapso_message_id, kapso_conversation_id, contact_phone, content, created_at, message_type:raw_payload->message->>type";

  // 1) Toda imagen o PDF que mandó un cliente en el rango.
  const media = await fetchAllPages<RawInbound>(() =>
    supabase
      .from("kapso_messages")
      .select(select)
      .eq("direction", "inbound")
      .gte("created_at", sinceIso)
      .or("content.like.📷%,content.like.📄%,raw_payload->message->>type.in.(image,document)")
      .order("created_at", { ascending: true }),
  );

  // 2) Textos que podrían afirmar un pago; el filtro fino lo hace isPaymentClaim.
  const texts = await fetchAllPages<RawInbound>(() =>
    supabase
      .from("kapso_messages")
      .select(select)
      .eq("direction", "inbound")
      .gte("created_at", sinceIso)
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

  // 3) Material que ya había recibido cada cliente (define el contexto) y alertas 💰. Sin
  // límite inferior de fecha: el QR pudo enviarse antes del rango del reporte.
  const phones = [...new Set(candidates.map((c) => c.phone).filter(Boolean))];
  const markers: OutboundMarker[] = [];

  for (let i = 0; i < phones.length; i += 80) {
    const slice = phones.slice(i, i + 80);
    const rows = await fetchAllPages<{
      kapso_conversation_id: string | null;
      contact_phone: string;
      content: string;
      created_at: string;
    }>(() =>
      supabase
        .from("kapso_messages")
        .select("kapso_conversation_id, contact_phone, content, created_at")
        .eq("direction", "outbound")
        .in("contact_phone", slice)
        .or("content.like.[MEDIA_SENT%,content.like.[INTAKE_FORM_SENT%,content.like.[TELEGRAM_PAYMENT_SENT%"),
    );

    for (const row of rows) {
      markers.push({
        conversationId: row.kapso_conversation_id,
        phone: row.contact_phone,
        content: row.content,
        createdAt: row.created_at,
      });
    }
  }

  // 4) Veredicto de la verificación por visión de cada imagen.
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

export { loadPaymentReportData };

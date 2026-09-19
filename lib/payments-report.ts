// Detección de pagos a partir de la base de datos (la usa el botón "💰 Pagos", /pagos).
//
// Por qué existe: la alerta 💰 depende de que el bot etiquete bien cada comprobante, y en
// un mes real se perdieron varios — el cliente mandaba la foto junto con un "Listo" o un
// "Gracias" y solo se revisaba el último mensaje; otros llegaron con el bot apagado o sin
// QR previo. Esta detección NO depende de ese etiquetado: toma TODA imagen o PDF que mandó
// un cliente y todo texto que afirma un pago, y los clasifica por qué tan seguro es que
// sean un comprobante. Así ningún pago se pierde aunque el agente falle, y un humano decide
// lo que el sistema no pudo.
//
// Funciones puras: el route handler de Telegram consulta Supabase y les pasa las filas.

import type { PaymentTag } from "./payment-alerts.ts";

// Varias imágenes del mismo cliente en este lapso son un solo envío (ej. dos comprobantes
// de dos inscritos, o la foto + el PDF).
const SAME_SUBMISSION_MINUTES = 10;

type InboundCandidate = {
  messageId: string;
  conversationId: string | null;
  phone: string;
  content: string;
  createdAt: string;
  // Tipo de mensaje de WhatsApp (image, document, text...), leído del payload crudo.
  type: string | null;
};

type OutboundMarker = {
  conversationId: string | null;
  phone: string;
  content: string;
  createdAt: string;
  // La alerta 💰 guarda aquí la etiqueta del pago y los datos del cliente (ver
  // lib/payment-alerts.ts). Las alertas anteriores a sep 2026 no la tienen.
  rawPayload?: {
    tag?: PaymentTag;
    names?: string[];
    phones?: string[];
    motive?: string | null;
  } | null;
};

type VisionVerdict = { isReceipt: boolean; reason: string };

// confirmed = verificado por visión o con alerta 💰 enviada.
// review    = puede ser un pago real y nadie lo confirmó (texto de pago, o archivo sin
//             verificar de un cliente con QR, curso o formulario).
// discarded = la verificación dijo que no era un comprobante.
// unrelated = archivo sin verificar de un chat sin ningún contexto de pago.
type PaymentCategory = "confirmed" | "review" | "discarded" | "unrelated";

type PaymentEntry = {
  category: PaymentCategory;
  phone: string;
  firstAt: string;
  lastAt: string;
  kinds: { images: number; documents: number; texts: number };
  context: string;
  alerted: boolean;
  detail: string;
  // Etiqueta que dejó la alerta 💰 (curso y cuál, paquete, otro). null = sin etiqueta: la
  // lista muestra el contexto detectado (pagos anteriores al etiquetado o sin alerta).
  tag?: PaymentTag | null;
  // Nombres y motivo que el cliente mandó para la alerta.
  taggedNames?: string[];
  taggedMotive?: string | null;
};

// Texto del cliente que AFIRMA haber pagado. En Bolivia "cancelar" es pagar ("ya cancelé").
// Pedir el QR ("pásame el QR") no es un pago y no entra.
const PAYMENT_CLAIM_REGEX =
  /\b(COMPROBANTE|PAGUE|PAGADO|PAGADA|YA\s+CANCELE|CANCELE|CANCELACION|DEPOSITE|DEPOSITADO|TRANSFERI|TRANSFERIDO|HICE\s+EL\s+PAGO|REALICE\s+EL\s+PAGO|PAGO\s+REALIZADO)\b/;

const normalize = (text: string) =>
  String(text ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase();

function isPaymentClaim(text: string): boolean {
  return PAYMENT_CLAIM_REGEX.test(normalize(text));
}

function isMediaCandidate(row: InboundCandidate): "image" | "document" | null {
  if (row.type === "image" || row.content.startsWith("📷")) return "image";
  if (row.type === "document" || row.content.startsWith("📄")) return "document";
  return null;
}

// Contexto comercial del cliente al momento de mandar el archivo, según el material que
// ya había recibido. Se mira por TELÉFONO: el QR pudo salir en una conversación anterior.
function describeContext(markers: OutboundMarker[], phone: string, at: string): string {
  const before = markers.filter((m) => m.phone === phone && m.createdAt <= at);
  const has = (prefix: string) => before.some((m) => m.content.startsWith(prefix));

  const qr = has("[MEDIA_SENT:payment_qr");
  const courseFlyer = has("[MEDIA_SENT:course_flyer");
  const manual = has("[MEDIA_SENT:manual_human");
  const intake = has("[INTAKE_FORM_SENT");
  const aiAgent = has("[MEDIA_SENT:ai_agent_flyer");

  if (qr && intake) return "🎓/🎬 Curso o paquetes (recibió QR y formulario)";
  if (qr) return "🎓 Curso (se le envió el QR)";
  if (manual && courseFlyer) return "🎓 Curso (material enviado a mano)";
  if (courseFlyer && intake) return "🎓/🎬 Curso o paquetes";
  if (courseFlyer) return "🎓 Curso (sin QR enviado)";
  if (intake) return "🎬 Paquetes (llenó/recibió formulario)";
  if (manual) return "❔ Material enviado a mano (revisar)";
  if (aiAgent) return "🤖 Agente de IA";
  return "❔ Sin contexto";
}

// ¿Salió la alerta 💰 por este envío? Se acepta el marcador del propio mensaje o uno de la
// misma conversación en los minutos siguientes: en una ráfaga la alerta puede quedar
// asociada al texto que acompañaba a la foto.
// La alerta puede salir hasta 20 minutos después del comprobante (espera los datos del
// cliente, ver lib/payment-alerts.ts), así que la ventana de la misma conversación es esa.
const ALERT_AFTER_RECEIPT_MINUTES = 25;

function findAlertMarker(markers: OutboundMarker[], row: InboundCandidate): OutboundMarker | null {
  const t = new Date(row.createdAt).getTime();
  const alerts = markers.filter((m) => m.content.startsWith("[TELEGRAM_PAYMENT_SENT"));

  const exact = alerts.find((m) => row.messageId && m.content.includes(`:${row.messageId}]`));
  if (exact) return exact;

  return (
    alerts.find((m) => {
      if (!row.conversationId || m.conversationId !== row.conversationId) return false;
      const dt = new Date(m.createdAt).getTime() - t;
      return dt >= 0 && dt <= ALERT_AFTER_RECEIPT_MINUTES * 60_000;
    }) ?? null
  );
}

function wasAlerted(markers: OutboundMarker[], row: InboundCandidate): boolean {
  return findAlertMarker(markers, row) !== null;
}

function buildPaymentsReport(params: {
  candidates: InboundCandidate[];
  markers: OutboundMarker[];
  vision: Map<string, VisionVerdict>;
}): PaymentEntry[] {
  const relevant = params.candidates
    .filter((row) => isMediaCandidate(row) !== null || isPaymentClaim(row.content))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  // Agrupa por cliente los mensajes que llegaron juntos.
  const groups: InboundCandidate[][] = [];
  for (const row of relevant) {
    const last = groups.at(-1);
    const lastRow = last?.at(-1);
    const sameSubmission =
      lastRow &&
      lastRow.phone === row.phone &&
      new Date(row.createdAt).getTime() - new Date(lastRow.createdAt).getTime() <=
        SAME_SUBMISSION_MINUTES * 60_000;

    if (last && sameSubmission) last.push(row);
    else groups.push([row]);
  }

  return groups.map((group) => {
    const first = group[0];
    const kinds = { images: 0, documents: 0, texts: 0 };
    let anyReceipt = false;
    let anyUnverifiedMedia = false;
    let allMediaDiscarded = true;
    let reason = "";
    let claimText = "";
    let caption = "";

    for (const row of group) {
      const media = isMediaCandidate(row);
      if (media === "image") kinds.images++;
      else if (media === "document") kinds.documents++;
      else kinds.texts++;

      if (!media) {
        claimText ||= row.content;
        allMediaDiscarded = false;
        continue;
      }

      // Leyenda de la imagen/PDF: cuenta como afirmación de pago solo si lo dice
      // ("comprobante", "ya pagué"); si no, se muestra pero no decide la categoría.
      const hasCaption = !row.content.startsWith("📷") && !row.content.startsWith("📄");
      if (hasCaption && isPaymentClaim(row.content)) claimText ||= row.content;
      else if (hasCaption) caption ||= row.content;

      const verdict = params.vision.get(row.messageId);
      if (verdict?.isReceipt) {
        anyReceipt = true;
        allMediaDiscarded = false;
      } else if (verdict) {
        reason ||= verdict.reason;
      } else {
        anyUnverifiedMedia = true;
        allMediaDiscarded = false;
      }
    }

    const alertMarker =
      group.map((row) => findAlertMarker(params.markers, row)).find(Boolean) ?? null;
    const alerted = alertMarker !== null;
    const onlyTexts = kinds.images + kinds.documents === 0;
    const context = describeContext(params.markers, first.phone, first.createdAt);
    const hasPaymentContext = !context.startsWith("❔ Sin contexto");

    const category: PaymentCategory =
      alerted || anyReceipt
        ? "confirmed"
        : claimText
          ? "review"
          : !onlyTexts && allMediaDiscarded
            ? "discarded"
            : hasPaymentContext
              ? "review"
              : "unrelated";

    const detail = claimText
      ? `💬 "${claimText.slice(0, 90)}"`
      : category === "discarded"
        ? `🧾 ${reason.slice(0, 90)}`
        : caption
          ? `💬 "${caption.slice(0, 90)}"`
          : anyUnverifiedMedia && category === "review"
            ? "🧾 Sin verificar (el bot no revisó este archivo)"
            : "";

    return {
      category,
      phone: first.phone,
      firstAt: first.createdAt,
      lastAt: group[group.length - 1].createdAt,
      kinds,
      context,
      alerted,
      detail,
      tag: alertMarker?.rawPayload?.tag ?? null,
      taggedNames: alertMarker?.rawPayload?.names ?? [],
      taggedMotive: alertMarker?.rawPayload?.motive ?? null,
    };
  });
}

export { isPaymentClaim, buildPaymentsReport };
export type { InboundCandidate, OutboundMarker, VisionVerdict, PaymentEntry, PaymentCategory };

// Lista de pagos para el grupo de Telegram (botón "💰 Pagos").
//
// Por qué existe: la alerta 💰 depende de que el bot etiquete bien cada comprobante, y en
// un mes real se perdieron varios — el cliente mandaba la foto junto con un "Listo" o un
// "Gracias" y solo se revisaba el último mensaje; otros llegaron con el bot apagado o sin
// QR previo. Esta lista NO depende de ese etiquetado: toma de la base de datos TODA
// imagen o PDF que mandó un cliente y todo texto que afirma un pago, y los ordena por
// qué tan seguro es que sean un comprobante. Así ningún pago se pierde aunque el agente
// falle, y un humano decide lo que el sistema no pudo.
//
// Funciones puras: el route handler de Telegram consulta Supabase y les pasa las filas.

const BOLIVIA_TZ = "America/La_Paz";
const MAX_REPORT_DAYS = 30;
const TELEGRAM_CHUNK_LIMIT = 3800;
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
  kinds: { images: number; documents: number; texts: number };
  context: string;
  alerted: boolean;
  detail: string;
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

function clampReportDays(days: number): number {
  if (!Number.isFinite(days)) return 7;
  return Math.min(MAX_REPORT_DAYS, Math.max(1, Math.round(days)));
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
function wasAlerted(markers: OutboundMarker[], row: InboundCandidate): boolean {
  const t = new Date(row.createdAt).getTime();
  return markers.some((m) => {
    if (!m.content.startsWith("[TELEGRAM_PAYMENT_SENT")) return false;
    if (m.content.includes(`:${row.messageId}]`)) return true;
    if (!row.conversationId || m.conversationId !== row.conversationId) return false;
    const dt = new Date(m.createdAt).getTime() - t;
    return dt >= 0 && dt <= SAME_SUBMISSION_MINUTES * 60_000;
  });
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

    const alerted = group.some((row) => wasAlerted(params.markers, row));
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
      kinds,
      context,
      alerted,
      detail,
    };
  });
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function formatBoliviaShort(iso: string): string {
  const parts = new Intl.DateTimeFormat("es-BO", {
    timeZone: BOLIVIA_TZ,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("day")}/${get("month")} ${get("hour")}:${get("minute")}`;
}

function describeKinds(kinds: PaymentEntry["kinds"]): string {
  const out: string[] = [];
  if (kinds.images) out.push(kinds.images > 1 ? `📷×${kinds.images}` : "📷");
  if (kinds.documents) out.push(kinds.documents > 1 ? `📄×${kinds.documents}` : "📄");
  if (kinds.texts) out.push("💬");
  return out.join(" ");
}

function renderEntry(entry: PaymentEntry, compact: boolean): string {
  const digits = entry.phone.replace(/\D/g, "");
  const head = `• ${formatBoliviaShort(entry.firstAt)} · ${describeKinds(entry.kinds)} · <a href="https://wa.me/${digits}">${digits}</a>`;

  if (compact) return `${head}${entry.detail ? ` — ${escapeHtml(entry.detail)}` : ""}`;

  const lines = [head, `   ${escapeHtml(entry.context)}${entry.alerted ? " · 🔔 alerta enviada" : ""}`];
  if (entry.detail) lines.push(`   ${escapeHtml(entry.detail)}`);
  return lines.join("\n");
}

// Arma los mensajes de Telegram (HTML), partidos para no pasar el límite de 4096
// caracteres y sin cortar nunca una entrada por la mitad.
function renderPaymentsReport(params: {
  entries: PaymentEntry[];
  days: number;
  now: Date;
}): string[] {
  const newestFirst = (a: PaymentEntry, b: PaymentEntry) => b.firstAt.localeCompare(a.firstAt);
  const confirmed = params.entries.filter((e) => e.category === "confirmed").sort(newestFirst);
  const review = params.entries.filter((e) => e.category === "review").sort(newestFirst);
  const discarded = params.entries.filter((e) => e.category === "discarded").sort(newestFirst);
  const unrelated = params.entries.filter((e) => e.category === "unrelated").sort(newestFirst);

  const since = new Date(params.now.getTime() - params.days * 24 * 60 * 60_000);
  const header = [
    `💰 <b>Pagos — últimos ${params.days} días</b> (desde ${formatBoliviaShort(since.toISOString())})`,
    `✅ ${confirmed.length} comprobantes · ❓ ${review.length} por revisar · 🚫 ${discarded.length} descartados · 📎 ${unrelated.length} otros archivos`,
  ].join("\n");

  const blocks: string[] = [header];

  const section = (title: string, list: PaymentEntry[], compact: boolean) => {
    if (list.length === 0) return;
    blocks.push(title);
    for (const entry of list) blocks.push(renderEntry(entry, compact));
  };

  section("\n✅ <b>Comprobantes (verificados o con alerta)</b>", confirmed, false);
  section("\n❓ <b>Por revisar</b> — el bot no pudo confirmarlos; pueden ser pagos reales", review, false);
  section("\n🚫 <b>Descartados por la verificación</b> — no parecían comprobantes, revisa si hay dudas", discarded, true);
  section("\n📎 <b>Otros archivos</b> — de chats sin QR, curso ni formulario; no se verificaron", unrelated, true);

  if (params.entries.length === 0) blocks.push("\nNo llegó ninguna imagen, PDF ni mensaje de pago en este rango.");

  const chunks: string[] = [];
  let current = "";
  for (const block of blocks) {
    const next = current ? `${current}\n${block}` : block;
    if (next.length > TELEGRAM_CHUNK_LIMIT && current) {
      chunks.push(current);
      current = block;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);

  return chunks;
}

export {
  MAX_REPORT_DAYS,
  clampReportDays,
  isPaymentClaim,
  buildPaymentsReport,
  renderPaymentsReport,
};
export type { InboundCandidate, OutboundMarker, VisionVerdict, PaymentEntry, PaymentCategory };

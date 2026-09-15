// Notificaciones a Telegram compartidas entre el webhook (app/api/webhooks/kapso),
// los cron jobs (app/api/cron/*) y el webhook del propio bot de Telegram
// (app/api/telegram/*), que corren como route handlers independientes.

// Llamada genérica a la Bot API. Devuelve null si falta el token o la llamada falla.
async function callTelegramApi(method: string, body: Record<string, unknown>): Promise<any | null> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const json = await response.json().catch(() => null);

    if (!response.ok || !json?.ok) {
      console.error(`telegram ${method} failed`, response.status, JSON.stringify(json));
      return null;
    }

    return json;
  } catch (error) {
    console.error(`telegram ${method} threw`, error);
    return null;
  }
}

// Mensaje a un chat concreto, con botones opcionales (inline_keyboard).
async function sendTelegramMessage(params: {
  chatId: string | number;
  text: string;
  replyMarkup?: Record<string, unknown>;
  // Las listas llevan decenas de links a wa.me: sin esto Telegram arma una vista previa.
  disablePreview?: boolean;
}): Promise<boolean> {
  const result = await callTelegramApi("sendMessage", {
    chat_id: params.chatId,
    text: params.text,
    parse_mode: "HTML",
    ...(params.disablePreview ? { disable_web_page_preview: true } : {}),
    ...(params.replyMarkup ? { reply_markup: params.replyMarkup } : {}),
  });

  return result !== null;
}

async function sendTelegramNotification(text: string): Promise<boolean> {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId) return false;
  return sendTelegramMessage({ chatId, text });
}

// Alertas TÉCNICAS para el desarrollador (ej. OpenAI sin saldo), separadas del grupo de
// asesores. Van al chat de TELEGRAM_DEV_CHAT_ID (el chat personal del desarrollador con el
// bot; el id se obtiene escribiéndole /id al bot). Sin esa variable caen en el grupo del
// equipo para que la alerta no se pierda.
async function sendDeveloperAlert(text: string): Promise<boolean> {
  const chatId = process.env.TELEGRAM_DEV_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
  if (!chatId) return false;
  return sendTelegramMessage({ chatId, text });
}

// Escapa los caracteres que Telegram interpreta como HTML (parse_mode: "HTML"),
// para que el texto libre del cliente o el resumen no rompa el formato.
function escapeTelegramHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Formato ÚNICO de los mensajes a Telegram: título propio (se conserva por tipo de
// aviso) + teléfono + link directo al chat + último mensaje del cliente + resumen de
// la IA (opcional). A propósito NO incluye el ID de conversación ni el nombre del
// contacto: el asesor abre el chat con el link y ve todo el contexto ahí.
function buildTelegramBody(params: {
  headline: string;
  phone: string;
  clientMessage?: string;
  summary?: string;
  contextLabel?: string;
  verification?: string;
  note?: string;
}): string {
  const digits = String(params.phone ?? "").replace(/\D/g, "");
  const clientMessage = (params.clientMessage ?? "").trim();
  const summary = (params.summary ?? "").trim();
  const contextLabel = (params.contextLabel ?? "").trim();
  const verification = (params.verification ?? "").trim();

  const lines = [
    params.headline,
    "",
    `📱 ${digits}`,
    `👉 Abrir chat: https://wa.me/${digits}`,
  ];

  if (contextLabel) {
    lines.push(`🗂️ Contexto: ${contextLabel}`);
  }

  // Aviso corto de estado cruzado entre flujos (ej. el lead ya tiene cita agendada),
  // para que el asesor no trate dos alertas del mismo cliente como casos separados.
  const note = (params.note ?? "").trim();
  if (note) {
    lines.push(escapeTelegramHtml(note));
  }

  // Qué vio el verificador de imágenes. El "👤 Cliente" de un comprobante sin
  // caption es solo el centinela "📷 Imagen recibida", así que esta línea es la
  // única pista real de qué llegó.
  if (verification) {
    lines.push(`🧾 Verificación: ${escapeTelegramHtml(verification.slice(0, 200))}`);
  }

  if (clientMessage) {
    lines.push("", `👤 Cliente:\n${escapeTelegramHtml(clientMessage.slice(0, 500))}`);
  }

  if (summary) {
    lines.push("", `🤖 IA:\n${escapeTelegramHtml(summary.slice(0, 500))}`);
  }

  return lines.join("\n");
}

// Alerta de escalación: un lead ya fue notificado (🟢 Nuevo lead) pero ningún asesor
// le respondió dentro del umbral configurado. Emoji distinto (🚨) a propósito: el
// aviso ⚪ genérico de "Requiere asesor" pasa desapercibido casi siempre.
async function notifyUnattendedLeadToTelegram(params: {
  phone: string;
  minutesWaiting: number;
}): Promise<boolean> {
  const waitingLabel =
    params.minutesWaiting >= 60
      ? `${Math.floor(params.minutesWaiting / 60)}h ${params.minutesWaiting % 60}min`
      : `${params.minutesWaiting} min`;

  return sendTelegramNotification(
    buildTelegramBody({
      headline: "🚨 <b>Lead SIN ATENDER — Conecta Pro</b>",
      phone: params.phone,
      note: `⏱️ Sin respuesta de un asesor hace ${waitingLabel}`,
    }),
  );
}

// SEGUNDA Y ÚLTIMA alerta de un lead que sigue sin respuesta humana horas después. Se manda
// antes de que se cierre la ventana de 24 h de WhatsApp (contada desde el último mensaje
// del cliente): pasada esa ventana ya no se le puede escribir un mensaje libre.
async function notifyUnattendedLeadFinalToTelegram(params: {
  phone: string;
  hoursWaiting: number;
  // Horas que le quedan a la ventana de 24 h de WhatsApp; <= 0 si ya se cerró.
  windowHoursLeft: number | null;
}): Promise<boolean> {
  const windowNote =
    params.windowHoursLeft === null
      ? null
      : params.windowHoursLeft > 0
        ? `⏳ Quedan ~${Math.max(1, Math.floor(params.windowHoursLeft))} h para escribirle por WhatsApp (ventana de 24 h)`
        : "⛔ La ventana de 24 h de WhatsApp ya se cerró: hay que llamarlo o usar una plantilla";

  return sendTelegramNotification(
    buildTelegramBody({
      headline: "⏰ <b>ÚLTIMO AVISO — Lead sin atender</b>",
      phone: params.phone,
      note: [
        `⏱️ Nadie del equipo le escribió en ${Math.floor(params.hoursWaiting)} h desde que llegó el lead`,
        windowNote,
        "No habrá más avisos de este lead.",
      ]
        .filter(Boolean)
        .join("\n"),
    }),
  );
}

// Parte una lista de bloques de texto en mensajes que Telegram acepta (límite de 4096
// caracteres), sin cortar nunca un bloque por la mitad.
const TELEGRAM_CHUNK_LIMIT = 3800;

function chunkTelegramBlocks(blocks: string[], limit = TELEGRAM_CHUNK_LIMIT): string[] {
  const chunks: string[] = [];
  let current = "";

  for (const block of blocks) {
    const next = current ? `${current}\n${block}` : block;
    if (next.length > limit && current) {
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
  callTelegramApi,
  sendTelegramMessage,
  sendTelegramNotification,
  sendDeveloperAlert,
  escapeTelegramHtml,
  buildTelegramBody,
  chunkTelegramBlocks,
  notifyUnattendedLeadToTelegram,
  notifyUnattendedLeadFinalToTelegram,
};

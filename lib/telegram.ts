// Notificaciones a Telegram compartidas entre el webhook (app/api/webhooks/kapso)
// y los cron jobs (app/api/cron/*), que corren como route handlers independientes.

async function sendTelegramNotification(text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) return false;

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    });

    if (!response.ok) {
      console.error("sendTelegramNotification failed", response.status, await response.text());
      return false;
    }

    return true;
  } catch (error) {
    console.error("sendTelegramNotification threw", error);
    return false;
  }
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

export {
  sendTelegramNotification,
  escapeTelegramHtml,
  buildTelegramBody,
  notifyUnattendedLeadToTelegram,
};

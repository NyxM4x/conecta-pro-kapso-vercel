// Webhook del bot de Telegram: botones del grupo del equipo.
//
// Hoy tiene un solo botón, la lista de pagos: /pagos muestra los rangos y cada botón arma
// la lista de ese rango directo desde la base de datos (ver lib/payments-report.ts).
//
// Seguridad: Telegram firma cada llamada con el header X-Telegram-Bot-Api-Secret-Token
// (el valor se registra con /api/telegram/setup), y solo se responde al chat configurado
// en TELEGRAM_CHAT_ID — la lista trae teléfonos de clientes.

import { createClient } from "@supabase/supabase-js";
import { callTelegramApi, sendTelegramMessage } from "../../../../lib/telegram";
import { loadPaymentReportData } from "../../../../lib/payments-data";
import {
  MAX_REPORT_DAYS,
  buildPaymentsReport,
  clampReportDays,
  renderPaymentsReport,
} from "../../../../lib/payments-report";

export const maxDuration = 60;

// Rangos ofrecidos. El máximo es un mes: más atrás la lista deja de servir para revisar.
const RANGE_BUTTONS = [
  { days: 7, label: "💰 Última semana" },
  { days: 21, label: "💰 Últimas 3 semanas" },
  { days: MAX_REPORT_DAYS, label: "💰 Último mes" },
];

const PAYMENTS_MENU = {
  inline_keyboard: RANGE_BUTTONS.map((range) => [
    { text: range.label, callback_data: `pagos:${range.days}` },
  ]),
};

function getSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key);
}

const isAllowedChat = (chatId: unknown) =>
  Boolean(process.env.TELEGRAM_CHAT_ID) && String(chatId) === String(process.env.TELEGRAM_CHAT_ID);

async function sendPaymentsReport(chatId: string | number, days: number): Promise<void> {
  const now = new Date();
  const sinceIso = new Date(now.getTime() - days * 24 * 60 * 60_000).toISOString();

  try {
    const data = await loadPaymentReportData(getSupabaseClient(), sinceIso);
    const entries = buildPaymentsReport(data);
    const chunks = renderPaymentsReport({ entries, days, now });

    for (const text of chunks) {
      await sendTelegramMessage({ chatId, text, disablePreview: true });
    }
  } catch (error) {
    console.error("payments report failed", error);
    await sendTelegramMessage({
      chatId,
      text: "⚠️ No se pudo armar la lista de pagos. Intenta de nuevo en un momento.",
    });
  }
}

export async function POST(request: Request) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret || request.headers.get("x-telegram-bot-api-secret-token") !== secret) {
    return new Response("unauthorized", { status: 401 });
  }

  let update: Record<string, any>;
  try {
    update = await request.json();
  } catch {
    return new Response("ok", { status: 200 });
  }

  // Botón apretado.
  const callback = update.callback_query;
  if (callback) {
    const chatId = callback.message?.chat?.id;
    const match = String(callback.data ?? "").match(/^pagos:(\d+)$/);

    if (!isAllowedChat(chatId) || !match) {
      await callTelegramApi("answerCallbackQuery", { callback_query_id: callback.id });
      return new Response("ok", { status: 200 });
    }

    const days = clampReportDays(Number(match[1]));
    await callTelegramApi("answerCallbackQuery", {
      callback_query_id: callback.id,
      text: `Armando la lista de los últimos ${days} días…`,
    });
    await sendPaymentsReport(chatId, days);
    return new Response("ok", { status: 200 });
  }

  // Comando escrito: /pagos (en grupos llega como /pagos@NombreDelBot).
  const message = update.message;
  const text = String(message?.text ?? "").trim();

  // /id responde en CUALQUIER chat su propio id: así el desarrollador obtiene el valor de
  // TELEGRAM_DEV_CHAT_ID escribiéndole /id al bot por privado. No expone nada más.
  if (message && /^\/id(@\w+)?\b/i.test(text)) {
    await sendTelegramMessage({
      chatId: message.chat.id,
      text: `🆔 El id de este chat es: <code>${message.chat.id}</code>`,
    });
    return new Response("ok", { status: 200 });
  }
  if (message && isAllowedChat(message.chat?.id) && /^\/(pagos|start|menu)(@\w+)?\b/i.test(text)) {
    await sendTelegramMessage({
      chatId: message.chat.id,
      text: "💰 <b>Lista de pagos</b>\nElige el rango. Incluye TODAS las imágenes, PDF y mensajes de pago de clientes, aunque el bot no los haya confirmado.",
      replyMarkup: PAYMENTS_MENU,
    });
  }

  // Telegram reintenta cualquier respuesta distinta de 200: se responde siempre ok.
  return new Response("ok", { status: 200 });
}

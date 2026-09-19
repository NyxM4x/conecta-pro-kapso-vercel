// Webhook del bot de Telegram: botones del grupo del equipo.
//
//   /menu (o /start)  → muestra los botones.
//   💰 Pagos (/pagos) → elige un rango de fechas (hoy, ayer, últimos 7, 15 o 30 días) y
//                       recibe la lista GLOBAL de comprobantes de ese rango, cada uno con su
//                       etiqueta (curso, paquete, otro o sin etiqueta), el nombre, el celular y
//                       el link al chat (lib/payments-ledger.ts). Sirve para revisar chat por
//                       chat que no falte ninguno. Rango exacto: "/pagos 10/09 18/09".
//                       /inscritos, el nombre anterior, abre el mismo menú.
//   📞 Llamadas y visitas (/llamadas o /visitas) → una sola lista de quienes pidieron que los
//                              llamen o venir a la oficina, con los que nadie contactó primero
//                              (lib/pending-contacts.ts).
//   /id → responde el id del chat (sirve para configurar TELEGRAM_DEV_CHAT_ID).
//
// Seguridad: Telegram firma cada llamada con el header X-Telegram-Bot-Api-Secret-Token
// (registrado con /api/telegram/setup), y los botones solo responden en el chat de
// TELEGRAM_CHAT_ID — las listas traen teléfonos de clientes.

import { createClient } from "@supabase/supabase-js";
import { callTelegramApi, chunkTelegramBlocks, sendTelegramMessage } from "../../../../lib/telegram";
import {
  loadClientTexts,
  loadContactNames,
  loadPaymentReportData,
  loadPendingContactsData,
} from "../../../../lib/telegram-reports-data";
import { buildPaymentsReport } from "../../../../lib/payments-report";
import {
  NAME_LOOKAHEAD_HOURS,
  NAME_LOOKBACK_MINUTES,
  RANGE_PRESETS,
  buildPaymentsLedger,
  parseCustomRange,
  renderPaymentsLedger,
  resolvePresetRange,
} from "../../../../lib/payments-ledger";
import type { LedgerRange } from "../../../../lib/payments-ledger";
import {
  PENDING_CONTACTS_REPORT_DAYS,
  buildPendingContacts,
  renderPendingContacts,
} from "../../../../lib/pending-contacts";

export const maxDuration = 60;

const MAIN_MENU = {
  inline_keyboard: [
    [{ text: "💰 Pagos", callback_data: "menu:pagos" }],
    // callback_data sigue siendo "menu:visitas": los menús viejos del chat siguen andando.
    [{ text: "📞 Llamadas y visitas", callback_data: "menu:visitas" }],
  ],
};

// Comandos que muestra el menú de Telegram. Se publican solos una vez por arranque del
// servidor, así un cambio de botones no requiere volver a correr /api/telegram/setup.
const BOT_COMMANDS = [
  { command: "menu", description: "Botones del equipo" },
  { command: "pagos", description: "Lista de comprobantes por rango de fechas" },
  { command: "llamadas", description: "Llamadas y visitas por coordinar" },
  { command: "visitas", description: "Llamadas y visitas por coordinar" },
];
let commandsPublished = false;

function getSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key);
}

const isAllowedChat = (chatId: unknown) =>
  Boolean(process.env.TELEGRAM_CHAT_ID) && String(chatId) === String(process.env.TELEGRAM_CHAT_ID);

async function sendBlocks(chatId: string | number, blocks: string[]) {
  for (const text of chunkTelegramBlocks(blocks)) {
    await sendTelegramMessage({ chatId, text, disablePreview: true });
  }
}

// /pagos: solo el rango de fechas.
async function sendPaymentsRangeMenu(chatId: string | number, notice?: string) {
  const buttons = RANGE_PRESETS.map((preset) => ({ text: preset.label, callback_data: `pagos:rango:${preset.id}` }));

  await sendTelegramMessage({
    chatId,
    text: [
      ...(notice ? [notice, ""] : []),
      "💰 <b>Pagos</b> — ¿de qué fechas?",
      "",
      "Para un rango exacto escribe, por ejemplo: <code>/pagos 10/09 18/09</code>",
    ].join("\n"),
    replyMarkup: {
      // De a dos por fila: Hoy · Ayer / 7 · 15 días / 30 días.
      inline_keyboard: buttons.reduce<{ text: string; callback_data: string }[][]>((rows, button, i) => {
        if (i % 2 === 0) rows.push([button]);
        else rows[rows.length - 1].push(button);
        return rows;
      }, []),
    },
  });
}

async function sendPaymentsLedger(chatId: string | number, range: LedgerRange) {
  try {
    const supabase = getSupabaseClient();
    const paymentData = await loadPaymentReportData(supabase, range.fromIso, range.toIso);
    const payments = buildPaymentsReport(paymentData);
    const phones = [...new Set(payments.map((p) => p.phone))];

    // El nombre llega en la ráfaga del comprobante o en las horas siguientes.
    const textsFrom = new Date(new Date(range.fromIso).getTime() - NAME_LOOKBACK_MINUTES * 60_000).toISOString();
    const textsUntil = new Date(new Date(range.toIso).getTime() + NAME_LOOKAHEAD_HOURS * 3600_000).toISOString();
    const [texts, profileNames] = await Promise.all([
      loadClientTexts(supabase, phones, textsFrom, textsUntil),
      loadContactNames(supabase, phones),
    ]);

    const entries = buildPaymentsLedger({ payments, texts, profileNames });
    await sendBlocks(chatId, renderPaymentsLedger({ entries, range }));
  } catch (error) {
    console.error("payments ledger report failed", error);
    await sendTelegramMessage({
      chatId,
      text: "⚠️ No se pudo armar la lista de pagos. Intenta de nuevo en un momento.",
    });
  }
}

async function sendPendingContacts(chatId: string | number) {
  try {
    const now = new Date();
    const sinceIso = new Date(now.getTime() - PENDING_CONTACTS_REPORT_DAYS * 24 * 3600_000).toISOString();
    const data = await loadPendingContactsData(getSupabaseClient(), sinceIso);
    await sendBlocks(chatId, renderPendingContacts({ contacts: buildPendingContacts(data), now }));
  } catch (error) {
    console.error("pending contacts report failed", error);
    await sendTelegramMessage({
      chatId,
      text: "⚠️ No se pudo armar la lista de llamadas y visitas. Intenta de nuevo en un momento.",
    });
  }
}

export async function POST(request: Request) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret || request.headers.get("x-telegram-bot-api-secret-token") !== secret) {
    return new Response("unauthorized", { status: 401 });
  }

  if (!commandsPublished) {
    commandsPublished = true;
    await callTelegramApi("setMyCommands", { commands: BOT_COMMANDS });
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
    const data = String(callback.data ?? "");

    if (!isAllowedChat(chatId)) {
      await callTelegramApi("answerCallbackQuery", { callback_query_id: callback.id });
      return new Response("ok", { status: 200 });
    }

    await callTelegramApi("answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "Armando la lista…",
    });

    const range = data.startsWith("pagos:rango:")
      ? resolvePresetRange(data.slice("pagos:rango:".length), new Date())
      : null;

    if (range) await sendPaymentsLedger(chatId, range);
    else if (data === "menu:visitas") await sendPendingContacts(chatId);
    // Cualquier otro botón de pagos —incluidos los viejos por curso ("pagos:<curso>",
    // "inscritos:<curso>") que siguen en el chat— abre el menú de fechas.
    else if (data.startsWith("pagos") || data.startsWith("inscritos") || data.startsWith("menu:")) {
      await sendPaymentsRangeMenu(chatId);
    }

    return new Response("ok", { status: 200 });
  }

  // Comando escrito (en grupos llega como /comando@NombreDelBot).
  const message = update.message;
  const text = String(message?.text ?? "").trim();
  const commandMatch = text.match(/^\/(\w+)(?:@\w+)?\b/);
  const command = commandMatch?.[1]?.toLowerCase();
  const args = commandMatch ? text.slice(commandMatch[0].length).trim() : "";

  // /id responde en CUALQUIER chat su propio id: así el desarrollador obtiene el valor de
  // TELEGRAM_DEV_CHAT_ID escribiéndole /id al bot por privado. No expone nada más.
  if (message && command === "id") {
    await sendTelegramMessage({
      chatId: message.chat.id,
      text: `🆔 El id de este chat es: <code>${message.chat.id}</code>`,
    });
    return new Response("ok", { status: 200 });
  }

  if (message && command && isAllowedChat(message.chat?.id)) {
    if (command === "pagos" || command === "inscritos") {
      // "/pagos 10/09 18/09" va directo a la lista; sin fechas (o mal escritas), el menú.
      const range = args ? parseCustomRange(args, new Date()) : null;
      if (range) await sendPaymentsLedger(message.chat.id, range);
      else {
        await sendPaymentsRangeMenu(
          message.chat.id,
          args ? "⚠️ No entendí esas fechas (máximo 62 días). Usa por ejemplo /pagos 10/09 18/09." : undefined,
        );
      }
    } else if (command === "llamadas" || command === "visitas") await sendPendingContacts(message.chat.id);
    else if (command === "menu" || command === "start") {
      await sendTelegramMessage({
        chatId: message.chat.id,
        text: "📋 <b>Botones del equipo</b>",
        replyMarkup: MAIN_MENU,
      });
    }
  }

  // Telegram reintenta cualquier respuesta distinta de 200: se responde siempre ok.
  return new Response("ok", { status: 200 });
}

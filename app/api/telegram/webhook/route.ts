// Webhook del bot de Telegram: botones del grupo del equipo.
//
//   /menu (o /start)  → muestra los botones.
//   💰 Pagos (/pagos) → elige la fecha del curso y recibe quiénes pagaron, con el nombre y el
//                       celular para agregarlos al grupo; o "🎬 Paquetes y otros" para los
//                       pagos que no son de un curso (lib/course-enrollments.ts). Cada pago va
//                       en su lista según la etiqueta de su alerta 💰 (lib/payment-alerts.ts).
//                       /inscritos, el nombre anterior, sigue funcionando.
//   🏢 Visitas por coordinar → quiénes pidieron venir a la oficina y a quién todavía no llamó
//                              nadie (lib/office-visits.ts).
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
  loadOfficeVisitData,
  loadPaymentReportData,
} from "../../../../lib/telegram-reports-data";
import { buildPaymentsReport } from "../../../../lib/payments-report";
import {
  OTHER_PAYMENTS_DAYS,
  buildCourseEnrollments,
  buildOtherPayments,
  getEnrollmentWindow,
  listReportableCourses,
  renderCourseEnrollments,
  renderOtherPayments,
} from "../../../../lib/course-enrollments";
import {
  OFFICE_VISIT_REPORT_DAYS,
  buildOfficeVisits,
  renderOfficeVisits,
} from "../../../../lib/office-visits";
import { COURSES, formatCourseDate } from "../../../../lib/courses";

export const maxDuration = 60;

const MAIN_MENU = {
  inline_keyboard: [
    [{ text: "💰 Pagos", callback_data: "menu:pagos" }],
    [{ text: "🏢 Visitas por coordinar", callback_data: "menu:visitas" }],
  ],
};

// Comandos que muestra el menú de Telegram. Se publican solos una vez por arranque del
// servidor, así un cambio de botones no requiere volver a correr /api/telegram/setup.
const BOT_COMMANDS = [
  { command: "menu", description: "Botones del equipo" },
  { command: "pagos", description: "Pagos por curso, paquetes y otros" },
  { command: "visitas", description: "Visitas a la oficina por coordinar" },
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

// Paso 1 de pagos: elegir la fecha del curso, o los pagos de paquetes y otros.
async function sendPaymentsMenu(chatId: string | number) {
  const courses = listReportableCourses(new Date());

  await sendTelegramMessage({
    chatId,
    text: "💰 <b>Pagos</b>\n¿Qué lista quieres?",
    replyMarkup: {
      inline_keyboard: [
        ...courses.map((course) => [
          { text: `🎓 ${course.name} — ${formatCourseDate(course.startsAt)}`, callback_data: `pagos:${course.id}` },
        ]),
        [{ text: "🎬 Paquetes y otros pagos", callback_data: "pagos:otros" }],
      ],
    },
  });
}

async function loadPaymentsWithContacts(sinceIso: string, untilIso: string) {
  const supabase = getSupabaseClient();
  const paymentData = await loadPaymentReportData(supabase, sinceIso, untilIso);
  const payments = buildPaymentsReport(paymentData);
  const phones = [...new Set(payments.map((p) => p.phone))];

  const [texts, profileNames] = await Promise.all([
    loadClientTexts(supabase, phones, sinceIso, untilIso),
    loadContactNames(supabase, phones),
  ]);

  return { payments, texts, profileNames };
}

async function sendCourseEnrollments(chatId: string | number, courseId: string) {
  const course = COURSES.find((c) => c.id === courseId);
  if (!course) {
    await sendTelegramMessage({ chatId, text: "⚠️ Ese curso ya no está en el catálogo." });
    return;
  }

  try {
    // Se leen también los pagos de antes de que terminara el curso anterior: los que el
    // cliente etiquetó con ESTA fecha cuentan aunque se hayan pagado antes.
    const { sinceIso, untilIso, loadSinceIso } = getEnrollmentWindow(course);
    const { payments, texts, profileNames } = await loadPaymentsWithContacts(loadSinceIso, untilIso);

    const enrollments = buildCourseEnrollments({
      payments,
      texts,
      profileNames,
      course,
      untaggedSinceIso: sinceIso,
    });
    await sendBlocks(chatId, renderCourseEnrollments({ course, enrollments }));
  } catch (error) {
    console.error("course enrollments report failed", error);
    await sendTelegramMessage({
      chatId,
      text: "⚠️ No se pudo armar la lista de pagos. Intenta de nuevo en un momento.",
    });
  }
}

async function sendOtherPayments(chatId: string | number) {
  try {
    const now = Date.now();
    const sinceIso = new Date(now - OTHER_PAYMENTS_DAYS * 24 * 3600_000).toISOString();
    const { payments, texts, profileNames } = await loadPaymentsWithContacts(
      sinceIso,
      new Date(now).toISOString(),
    );
    await sendBlocks(chatId, renderOtherPayments({ payments: buildOtherPayments({ payments, texts, profileNames }) }));
  } catch (error) {
    console.error("other payments report failed", error);
    await sendTelegramMessage({
      chatId,
      text: "⚠️ No se pudo armar la lista de pagos. Intenta de nuevo en un momento.",
    });
  }
}

async function sendOfficeVisits(chatId: string | number) {
  try {
    const now = new Date();
    const sinceIso = new Date(now.getTime() - OFFICE_VISIT_REPORT_DAYS * 24 * 3600_000).toISOString();
    const data = await loadOfficeVisitData(getSupabaseClient(), sinceIso);
    await sendBlocks(chatId, renderOfficeVisits({ visits: buildOfficeVisits(data), now }));
  } catch (error) {
    console.error("office visits report failed", error);
    await sendTelegramMessage({
      chatId,
      text: "⚠️ No se pudo armar la lista de visitas. Intenta de nuevo en un momento.",
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

    // "inscritos" = botones viejos que quedaron en el chat antes del cambio de nombre.
    if (data === "menu:pagos" || data === "menu:inscritos") await sendPaymentsMenu(chatId);
    else if (data === "menu:visitas") await sendOfficeVisits(chatId);
    else if (data === "pagos:otros") await sendOtherPayments(chatId);
    else if (data.startsWith("pagos:")) await sendCourseEnrollments(chatId, data.slice("pagos:".length));
    else if (data.startsWith("inscritos:")) await sendCourseEnrollments(chatId, data.slice("inscritos:".length));

    return new Response("ok", { status: 200 });
  }

  // Comando escrito (en grupos llega como /comando@NombreDelBot).
  const message = update.message;
  const text = String(message?.text ?? "").trim();
  const command = text.match(/^\/(\w+)(?:@\w+)?\b/)?.[1]?.toLowerCase();

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
    if (command === "pagos" || command === "inscritos") await sendPaymentsMenu(message.chat.id);
    else if (command === "visitas") await sendOfficeVisits(message.chat.id);
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

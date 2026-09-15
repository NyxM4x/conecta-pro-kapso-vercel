// Webhook del bot de Telegram: botones del grupo del equipo.
//
//   /menu (o /start)  → muestra los botones.
//   🎓 Inscritos del curso → elige la fecha del curso y recibe quiénes pagaron, con el nombre
//                            y el celular para agregarlos al grupo (lib/course-enrollments.ts).
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
  buildCourseEnrollments,
  getEnrollmentWindow,
  listReportableCourses,
  renderCourseEnrollments,
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
    [{ text: "🎓 Inscritos del curso", callback_data: "menu:inscritos" }],
    [{ text: "🏢 Visitas por coordinar", callback_data: "menu:visitas" }],
  ],
};

// Comandos que muestra el menú de Telegram. Se publican solos una vez por arranque del
// servidor, así un cambio de botones no requiere volver a correr /api/telegram/setup.
const BOT_COMMANDS = [
  { command: "menu", description: "Botones del equipo" },
  { command: "inscritos", description: "Inscritos del curso (con nombre y celular)" },
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

// Paso 1 de inscritos: elegir la fecha (si hay una sola, se arma directo).
async function sendCourseMenu(chatId: string | number) {
  const courses = listReportableCourses(new Date());

  if (courses.length === 0) {
    await sendTelegramMessage({
      chatId,
      text: "🎓 No hay ningún curso próximo ni dictado en las últimas 2 semanas.",
    });
    return;
  }

  if (courses.length === 1) {
    await sendCourseEnrollments(chatId, courses[0].id);
    return;
  }

  await sendTelegramMessage({
    chatId,
    text: "🎓 <b>Inscritos del curso</b>\n¿De qué fecha?",
    replyMarkup: {
      inline_keyboard: courses.map((course) => [
        { text: `${course.name} — ${formatCourseDate(course.startsAt)}`, callback_data: `inscritos:${course.id}` },
      ]),
    },
  });
}

async function sendCourseEnrollments(chatId: string | number, courseId: string) {
  const course = COURSES.find((c) => c.id === courseId);
  if (!course) {
    await sendTelegramMessage({ chatId, text: "⚠️ Ese curso ya no está en el catálogo." });
    return;
  }

  try {
    const supabase = getSupabaseClient();
    const { sinceIso, untilIso } = getEnrollmentWindow(course);
    const paymentData = await loadPaymentReportData(supabase, sinceIso, untilIso);
    const payments = buildPaymentsReport(paymentData);
    const phones = [...new Set(payments.map((p) => p.phone))];

    const [texts, profileNames] = await Promise.all([
      loadClientTexts(supabase, phones, sinceIso, untilIso),
      loadContactNames(supabase, phones),
    ]);

    const enrollments = buildCourseEnrollments({ payments, texts, profileNames });
    await sendBlocks(chatId, renderCourseEnrollments({ course, enrollments }));
  } catch (error) {
    console.error("course enrollments report failed", error);
    await sendTelegramMessage({
      chatId,
      text: "⚠️ No se pudo armar la lista de inscritos. Intenta de nuevo en un momento.",
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

    if (data === "menu:inscritos") await sendCourseMenu(chatId);
    else if (data === "menu:visitas") await sendOfficeVisits(chatId);
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
    if (command === "inscritos") await sendCourseMenu(message.chat.id);
    else if (command === "visitas") await sendOfficeVisits(message.chat.id);
    else if (command === "menu" || command === "start" || command === "pagos") {
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

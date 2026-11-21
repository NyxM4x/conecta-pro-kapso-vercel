// Webhook del bot de Telegram: botones del grupo del equipo.
//
//   /menu (o /start)  → muestra los botones.
//   💰 Pagos (/pagos) → elige un rango de fechas (hoy, ayer, últimos 7, 15 o 30 días) y
//                       recibe la lista GLOBAL de comprobantes de ese rango, cada uno con su
//                       etiqueta (curso, paquete, otro o sin etiqueta), el nombre, el celular y
//                       el link al chat (lib/payments-ledger.ts). Sirve para revisar chat por
//                       chat que no falte ninguno. Rango exacto: "/pagos 10/09 18/09".
//   🎓 Inscritos (/inscritos) → la lista guía de cada curso con fecha: cupos pagados, nombres,
//                       celular y monto; los pagos que el bot no supo asignar, con botones para
//                       decir de qué son (curso, combo, paquete o nada) (lib/course-roster.ts).
//   🛒 Por cobrar (/porcobrar) → quienes tocaron pagar en la página o recibieron el QR y no
//                       mandaron comprobante.
//   📋 Lista de espera (/espera) → quienes preguntaron por un curso cuando no había fecha, para
//                       avisarles cuando abra una nueva.
//   📞 Llamadas y visitas (/llamadas o /visitas) → una sola lista de quienes pidieron que los
//                              llamen o venir a la oficina, con los que nadie contactó primero
//                              (lib/pending-contacts.ts).
//   /cliente <número> → qué pasó de verdad con ese cliente: botones que recibió, si abrió la
//                       página y si sus datos llegaron (lib/client-status.ts).
//   /id → responde el id del chat (sirve para configurar TELEGRAM_DEV_CHAT_ID).
//
// Seguridad: Telegram firma cada llamada con el header X-Telegram-Bot-Api-Secret-Token
// (registrado con /api/telegram/setup), y los botones solo responden en el chat de
// TELEGRAM_CHAT_ID — las listas traen teléfonos de clientes.

import { createClient } from "@supabase/supabase-js";
import { callTelegramApi, chunkTelegramBlocks, sendTelegramMessage } from "../../../../lib/telegram";
import {
  loadCourseRosterData,
  loadCourseWaitlist,
  loadPaymentsLedgerEntries,
  loadPendingContactsData,
  loadRosterCorrections,
  saveRosterCorrection,
} from "../../../../lib/telegram-reports-data";
import {
  RANGE_PRESETS,
  parseCustomRange,
  renderPaymentsLedger,
  resolvePresetRange,
} from "../../../../lib/payments-ledger";
import {
  applyTeamCorrections,
  buildCourseRoster,
  isValidChoice,
  parseRosterCallback,
  renderAssignmentResult,
  renderCourseRoster,
  renderCourseWaitlist,
  renderPendingPayments,
} from "../../../../lib/course-roster";
import type { RosterCourse, RosterMessage } from "../../../../lib/course-roster";
import { COURSES, COURSE_BUNDLE } from "../../../../lib/courses";
import type { LedgerRange } from "../../../../lib/payments-ledger";
import { loadClientStatus, normalizeClientPhone, renderClientStatus } from "../../../../lib/client-status";
import {
  PENDING_CONTACTS_REPORT_DAYS,
  buildPendingContacts,
  renderPendingContacts,
} from "../../../../lib/pending-contacts";

export const maxDuration = 60;

// Panel del equipo: cursos arriba (lo que más se usa la semana del curso), después pagos y
// contactos. De a dos por fila para que se lea de un vistazo.
const MAIN_MENU = {
  inline_keyboard: [
    [
      { text: "🎓 Inscritos", callback_data: "menu:inscritos" },
      { text: "🛒 Por cobrar", callback_data: "menu:porcobrar" },
    ],
    [
      { text: "💰 Pagos", callback_data: "menu:pagos" },
      { text: "📋 Lista de espera", callback_data: "menu:espera" },
    ],
    // callback_data sigue siendo "menu:visitas": los menús viejos del chat siguen andando.
    [{ text: "📞 Llamadas y visitas", callback_data: "menu:visitas" }],
  ],
};

const MAIN_MENU_TEXT = [
  "📋 <b>Panel de Conecta Pro</b>",
  "",
  "🎓 <b>Inscritos</b> — quiénes pagaron cada curso",
  "🛒 <b>Por cobrar</b> — tocaron pagar y no mandaron comprobante",
  "💰 <b>Pagos</b> — todos los comprobantes por fecha",
  "📋 <b>Lista de espera</b> — interesados en próximos cursos",
  "📞 <b>Llamadas y visitas</b> — por coordinar",
].join("\n");

// Comandos que muestra el menú de Telegram. Se publican solos una vez por arranque del
// servidor, así un cambio de botones no requiere volver a correr /api/telegram/setup.
const BOT_COMMANDS = [
  { command: "menu", description: "Panel con todos los botones" },
  { command: "inscritos", description: "Inscritos de cada curso con fecha" },
  { command: "porcobrar", description: "Tocaron pagar y no mandaron comprobante" },
  { command: "pagos", description: "Lista de comprobantes por rango de fechas" },
  { command: "espera", description: "Lista de espera para próximos cursos" },
  { command: "llamadas", description: "Llamadas y visitas por coordinar" },
  { command: "visitas", description: "Llamadas y visitas por coordinar" },
  { command: "cliente", description: "Estado de un cliente: /cliente 71234567" },
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

// Un mensaje armado (lib/course-roster.ts): si es largo se corta, y los botones van en el último
// pedazo para que queden al final de lo que se lee.
async function sendRosterMessage(chatId: string | number, message: RosterMessage) {
  const chunks = chunkTelegramBlocks(message.blocks);
  for (const [i, text] of chunks.entries()) {
    const last = i === chunks.length - 1;
    await sendTelegramMessage({
      chatId,
      text,
      disablePreview: true,
      ...(last && message.keyboard ? { replyMarkup: message.keyboard } : {}),
    });
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
    const [entries, corrections] = await Promise.all([
      loadPaymentsLedgerEntries(supabase, range.fromIso, range.toIso),
      loadRosterCorrections(supabase, range.fromIso),
    ]);
    // Lo que el equipo revisó en /inscritos (curso, combo, paquete) se ve también aquí.
    const reviewed = applyTeamCorrections(entries, corrections, rosterCourses());
    await sendBlocks(chatId, renderPaymentsLedger({ entries: reviewed, range }));
  } catch (error) {
    console.error("payments ledger report failed", error);
    await sendTelegramMessage({
      chatId,
      text: "⚠️ No se pudo armar la lista de pagos. Intenta de nuevo en un momento.",
    });
  }
}

async function sendClientStatus(chatId: string | number, args: string) {
  const phone = normalizeClientPhone(args);
  if (!phone) {
    await sendTelegramMessage({
      chatId,
      text: "Escribe el celular del cliente, por ejemplo: <code>/cliente 71234567</code>",
    });
    return;
  }

  try {
    const data = await loadClientStatus(getSupabaseClient(), phone);
    await sendTelegramMessage({ chatId, text: renderClientStatus(data, new Date()), disablePreview: true });
  } catch (error) {
    console.error("client status failed", error);
    await sendTelegramMessage({
      chatId,
      text: "⚠️ No se pudo revisar ese cliente. Intenta de nuevo en un momento.",
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

const rosterCourses = (): RosterCourse[] =>
  COURSES.map((course) => ({
    id: course.id,
    name: course.name,
    startsAt: course.startsAt,
    pricePreventa: course.pricePreventa,
    pricePresencial: course.pricePresencial,
  }));

async function buildRosterNow(now: Date) {
  const supabase = getSupabaseClient();
  const data = await loadCourseRosterData(supabase, now);
  const params = { courses: rosterCourses(), bundle: COURSE_BUNDLE, now };
  return { supabase, data, params, roster: buildCourseRoster({ ...data, ...params }) };
}

// /inscritos: el resumen, un mensaje por curso y uno con botones por cada pago por asignar.
async function sendCourseRoster(chatId: string | number) {
  try {
    const { roster, params } = await buildRosterNow(new Date());
    for (const message of renderCourseRoster(roster, params)) await sendRosterMessage(chatId, message);
  } catch (error) {
    console.error("course roster failed", error);
    await sendTelegramMessage({
      chatId,
      text: "⚠️ No se pudo armar la lista de inscritos. Intenta de nuevo en un momento.",
    });
  }
}

// /porcobrar: tocaron pagar o recibieron el QR y no mandaron comprobante.
async function sendPendingPayments(chatId: string | number) {
  try {
    const { roster, params } = await buildRosterNow(new Date());
    await sendRosterMessage(chatId, renderPendingPayments(roster, params));
  } catch (error) {
    console.error("pending payments failed", error);
    await sendTelegramMessage({
      chatId,
      text: "⚠️ No se pudo armar la lista de por cobrar. Intenta de nuevo en un momento.",
    });
  }
}

// Botón de un pago por asignar: guarda lo que eligió el equipo y reemplaza ese mensaje por el
// resultado (con los mismos botones, por si se equivocaron).
async function handleRosterAssignment(callback: Record<string, any>, shortKey: string, choice: string) {
  const chatId = callback.message?.chat?.id;
  const messageId = callback.message?.message_id;
  const by = [callback.from?.first_name, callback.from?.last_name].filter(Boolean).join(" ") || null;

  try {
    const now = new Date();
    const { supabase, data, params, roster } = await buildRosterNow(now);
    const row = roster.byShortKey.get(shortKey);

    if (!row || !isValidChoice(choice, params.courses, now)) {
      await sendTelegramMessage({
        chatId,
        text: "⚠️ Ese pago ya no está en la lista (o el curso ya pasó). Abre /inscritos de nuevo.",
      });
      return;
    }

    if (!(await saveRosterCorrection(supabase, { key: row.key, phone: row.phone, choice, by }))) {
      await sendTelegramMessage({ chatId, text: "⚠️ No se pudo guardar. Intenta de nuevo en un momento." });
      return;
    }

    // Se vuelve a armar con la corrección nueva para mostrar los cupos que quedaron.
    const updated = buildCourseRoster({
      ...data,
      corrections: [...data.corrections, { key: row.key, choice, createdAt: now.toISOString(), by }],
      ...params,
    }).byShortKey.get(shortKey) ?? row;

    const { text, keyboard } = renderAssignmentResult(updated, choice, { ...params, by });
    const edited = messageId
      ? await callTelegramApi("editMessageText", {
          chat_id: chatId,
          message_id: messageId,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: true,
          reply_markup: keyboard,
        })
      : null;
    if (!edited) await sendTelegramMessage({ chatId, text, replyMarkup: keyboard, disablePreview: true });
  } catch (error) {
    console.error("roster assignment failed", error);
    await sendTelegramMessage({ chatId, text: "⚠️ No se pudo guardar. Intenta de nuevo en un momento." });
  }
}

async function sendCourseWaitlist(chatId: string | number) {
  try {
    const now = new Date();
    const [entries, { roster }] = await Promise.all([loadCourseWaitlist(getSupabaseClient(), now), buildRosterNow(now)]);
    // Quien ya se inscribió en un curso vigente sale con ✅ y no entra en los números para difusión.
    const enrolled = new Set(roster.courses.flatMap((course) => course.rows.map((row) => row.phone)));
    await sendBlocks(chatId, renderCourseWaitlist(entries, now, enrolled));
  } catch (error) {
    console.error("course waitlist failed", error);
    await sendTelegramMessage({
      chatId,
      text: "⚠️ No se pudo armar la lista de espera. Intenta de nuevo en un momento.",
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

    const rosterButton = parseRosterCallback(data);

    await callTelegramApi("answerCallbackQuery", {
      callback_query_id: callback.id,
      text: rosterButton ? "Guardando…" : "Armando la lista…",
    });

    const range = data.startsWith("pagos:rango:")
      ? resolvePresetRange(data.slice("pagos:rango:".length), new Date())
      : null;

    if (rosterButton) await handleRosterAssignment(callback, rosterButton.shortKey, rosterButton.choice);
    else if (range) await sendPaymentsLedger(chatId, range);
    else if (data === "menu:visitas") await sendPendingContacts(chatId);
    else if (data === "menu:espera") await sendCourseWaitlist(chatId);
    else if (data === "menu:porcobrar") await sendPendingPayments(chatId);
    // "menu:inscritos" y los botones viejos por curso ("inscritos:<curso>") que siguen en el chat.
    else if (data.startsWith("menu:inscritos") || data.startsWith("inscritos")) await sendCourseRoster(chatId);
    // Cualquier otro botón de pagos —incluidos los viejos por curso ("pagos:<curso>")— abre el
    // menú de fechas.
    else if (data.startsWith("pagos") || data.startsWith("menu:")) {
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
    if (command === "inscritos") await sendCourseRoster(message.chat.id);
    else if (command === "espera") await sendCourseWaitlist(message.chat.id);
    else if (command === "porcobrar") await sendPendingPayments(message.chat.id);
    else if (command === "pagos") {
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
    else if (command === "cliente") await sendClientStatus(message.chat.id, args);
    else if (command === "menu" || command === "start") {
      await sendTelegramMessage({
        chatId: message.chat.id,
        text: MAIN_MENU_TEXT,
        replyMarkup: MAIN_MENU,
      });
    }
  }

  // Telegram reintenta cualquier respuesta distinta de 200: se responde siempre ok.
  return new Response("ok", { status: 200 });
}

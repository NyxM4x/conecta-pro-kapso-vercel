// LLAMADAS Y VISITAS — botón "📞 Llamadas y visitas" del grupo de Telegram.
//
// Una sola lista, con la misma prioridad, de la gente a la que un asesor tiene que llamar:
//   - 📞 Llamada: pidió que lo llamen (el lead 🔴 "Solicita llamada", o un lead cuyo
//     disparador fue el pedido de llamada aunque en el mismo turno dejara sus datos).
//   - 🏢 Visita · Negocio: quiere venir a la oficina por los servicios (se le pidió el
//     formulario; se marca si ya lo llenó).
//   - 🏢 Visita · Curso: quiere venir por un curso (no hay formulario; hay que llamarlo igual).
//   - 📅 Cita del flujo anterior: pedidos hechos antes del 15 sep, por si alguno quedó colgado.
// Cada persona aparece una sola vez aunque haya pedido visita y llamada. Queda "por contactar"
// si nadie del equipo le escribió desde WhatsApp Business después de su ÚLTIMO pedido. Una
// llamada telefónica no deja rastro: si el asesor lo llamó sin escribirle, sigue en la lista.
//
// Formato híbrido: los que faltan contactar van con ficha completa (el más antiguo primero);
// los ya contactados, en una línea cada uno (el más reciente primero).
//
// Funciones puras: el route handler consulta Supabase y les pasa las filas.

type ContactRequestRow = {
  conversationId: string;
  phone: string;
  content: string;
  createdAt: string;
  // raw_payload.kind y raw_payload.trigger de la marca.
  kind: string | null;
  trigger: string | null;
};

type PendingContactsData = {
  requests: ContactRequestRow[];
  messages: {
    conversationId: string;
    direction: "inbound" | "outbound";
    content: string;
    createdAt: string;
    byHuman: boolean;
    // raw_payload.kind de las marcas [TELEGRAM_LEAD_SENT]; null en el resto.
    leadKind: string | null;
  }[];
  profileNames: Map<string, string>;
};

type RequestType = "business" | "course" | "legacy" | "call";

type PendingContact = {
  conversationId: string;
  phone: string;
  types: RequestType[];
  // El último pedido: es el que tiene que tener respuesta del equipo.
  requestedAt: string;
  requestText: string;
  profileName: string | null;
  teamRepliedAt: string | null;
  leftData: boolean;
};

const PENDING_CONTACTS_REPORT_DAYS = 14;

// Marcas de kapso_messages que pueden ser un pedido (para la consulta de Supabase).
const REQUEST_MARKERS = [
  "[OFFICE_VISIT_REQUESTED]",
  "[TELEGRAM_COURSE_OFFICE_VISIT_SENT]",
  "[TELEGRAM_APPOINTMENT_SENT]",
  "[TELEGRAM_LEAD_SENT]",
];

// Qué pide cada marca. null = no es un pedido de llamada ni de visita (por ejemplo, el lead
// de alguien que solo llenó el formulario).
function requestTypeOf(row: Pick<ContactRequestRow, "content" | "kind" | "trigger">): RequestType | null {
  if (row.content.startsWith("[TELEGRAM_APPOINTMENT_SENT]")) return "legacy";
  if (row.content.startsWith("[TELEGRAM_COURSE_OFFICE_VISIT_SENT]")) return "course";
  if (row.content.startsWith("[OFFICE_VISIT_REQUESTED]")) return row.kind === "course" ? "course" : "business";
  if (row.content.startsWith("[TELEGRAM_LEAD_SENT]")) {
    return row.kind === "call_request" || String(row.trigger ?? "").startsWith("call_request") ? "call" : null;
  }
  return null;
}

const isPlaceholder = (text: string) => /^(\[|📷|📄)/.test(text.trim());

function buildPendingContacts(data: PendingContactsData): PendingContact[] {
  const byConversation = new Map<string, { phone: string; requests: { type: RequestType; createdAt: string }[] }>();

  for (const row of data.requests) {
    const type = requestTypeOf(row);
    if (!type) continue;
    const entry = byConversation.get(row.conversationId) ?? { phone: row.phone, requests: [] };
    entry.requests.push({ type, createdAt: row.createdAt });
    byConversation.set(row.conversationId, entry);
  }

  return [...byConversation].map(([conversationId, entry]) => {
    const conversation = data.messages.filter((m) => m.conversationId === conversationId);
    const requestedAt = entry.requests.map((r) => r.createdAt).sort().at(-1)!;

    // Un pedido por curso deja dos marcas (el pedido y la alerta): el tipo más específico
    // es "curso".
    const found = new Set(entry.requests.map((r) => r.type));
    if (found.has("course")) found.delete("business");
    const types = (["business", "course", "legacy", "call"] as const).filter((t) => found.has(t));

    const requestText =
      conversation
        .filter((m) => m.direction === "inbound" && m.createdAt <= requestedAt && !isPlaceholder(m.content))
        .at(-1)?.content ?? "";

    const teamReply = conversation.find((m) => m.byHuman && m.createdAt > requestedAt);
    const leftData = conversation.some(
      (m) => m.content.startsWith("[TELEGRAM_LEAD_SENT]") && m.leadKind !== "call_request",
    );

    return {
      conversationId,
      phone: entry.phone,
      types,
      requestedAt,
      requestText,
      profileName: data.profileNames.get(entry.phone) ?? null,
      teamRepliedAt: teamReply?.createdAt ?? null,
      leftData,
    };
  });
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// "08/09 14:17" en hora de Bolivia (es-BO no respeta el mes a dos dígitos: se rellena a mano).
function formatBoliviaShort(iso: string): string {
  const parts = new Intl.DateTimeFormat("es-BO", {
    timeZone: "America/La_Paz",
    day: "numeric",
    month: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(iso));
  const get = (type: string) => (parts.find((p) => p.type === type)?.value ?? "").padStart(2, "0");
  return `${get("day")}/${get("month")} ${get("hour")}:${get("minute")}`;
}

function formatAgo(iso: string, now: Date): string {
  const hours = Math.max(0, (now.getTime() - new Date(iso).getTime()) / 3600_000);
  if (hours < 1) return "hace menos de 1 h";
  if (hours < 48) return `hace ${Math.floor(hours)} h`;
  return `hace ${Math.floor(hours / 24)} días`;
}

const TYPE_LABEL: Record<RequestType, string> = {
  business: "🏢 Visita · Negocio",
  course: "🏢 Visita · Curso",
  legacy: "📅 Cita (flujo anterior)",
  call: "📞 Llamada",
};

const TYPE_ICON: Record<RequestType, string> = { business: "🏢", course: "🏢", legacy: "📅", call: "📞" };

function contactBits(contact: PendingContact) {
  const digits = contact.phone.replace(/\D/g, "");
  return {
    name: contact.profileName ? escapeHtml(contact.profileName) : "<i>sin nombre</i>",
    localPhone: digits.startsWith("591") ? digits.slice(3) : digits,
    chatUrl: `https://wa.me/${digits}`,
  };
}

// Ficha completa: para los que todavía nadie contactó.
function renderCard(contact: PendingContact, index: number, now: Date): string {
  const { name, localPhone, chatUrl } = contactBits(contact);
  const dataLabel = contact.types.includes("business")
    ? contact.leftData
      ? " · 📋 dejó datos"
      : " · ⏳ sin datos"
    : "";

  const lines = [
    `\n<b>${index}. ${contact.types.map((t) => TYPE_LABEL[t]).join(" + ")}</b>${dataLabel}`,
    `     👤 ${name} · 📱 ${localPhone} · <a href="${chatUrl}">abrir chat</a>`,
    `     🕒 ${formatBoliviaShort(contact.requestedAt)} (${formatAgo(contact.requestedAt, now)})`,
  ];
  if (contact.requestText) {
    // Audio transcrito: "🎙️ Audio recibido\n\nTranscripción: …" queda como "🎙️ …".
    const text = contact.requestText
      .replace(/^🎙️ Audio recibido\s+Transcripción:\s*/, "🎙️ ")
      .replace(/\s+/g, " ")
      .slice(0, 120);
    lines.push(`     🗨️ "${escapeHtml(text)}"`);
  }

  return lines.join("\n");
}

// Una línea: para los que el equipo ya contactó (solo falta confirmar que quedó coordinado).
function renderLine(contact: PendingContact, index: number): string {
  const { name, localPhone, chatUrl } = contactBits(contact);
  const icons = [...new Set(contact.types.map((t) => TYPE_ICON[t]))].join("");
  return `<b>${index}.</b> ${icons} ${name} · ${localPhone} · 💬 ${formatBoliviaShort(contact.teamRepliedAt!)} · <a href="${chatUrl}">chat</a>`;
}

function renderPendingContacts(params: { contacts: PendingContact[]; now: Date }): string[] {
  const pending = params.contacts
    .filter((c) => !c.teamRepliedAt)
    .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
  const contacted = params.contacts
    .filter((c) => c.teamRepliedAt)
    .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));

  const blocks = [
    [
      `📞 <b>Llamadas y visitas</b> — últimos ${PENDING_CONTACTS_REPORT_DAYS} días`,
      `🔴 ${pending.length} por contactar · ✅ ${contacted.length} ya contactados`,
    ].join("\n"),
  ];

  if (pending.length > 0) {
    blocks.push("\n━━ 🔴 <b>POR CONTACTAR</b> ━━\n<i>el más antiguo primero</i>");
    pending.forEach((c, i) => blocks.push(renderCard(c, i + 1, params.now)));
  }

  if (contacted.length > 0) {
    blocks.push("\n━━ ✅ <b>YA CONTACTADOS</b> ━━\n<i>confirmar que quedó coordinado</i>\n");
    contacted.forEach((c, i) => blocks.push(renderLine(c, pending.length + i + 1)));
  }

  if (params.contacts.length === 0) {
    blocks.push("\nNadie pidió una llamada ni visitar la oficina en este período.");
  }

  return blocks;
}

export {
  PENDING_CONTACTS_REPORT_DAYS,
  REQUEST_MARKERS,
  buildPendingContacts,
  renderPendingContacts,
  requestTypeOf,
};
export type { PendingContactsData, PendingContact };

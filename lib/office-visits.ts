// VISITAS POR COORDINAR — botón "🏢 Visitas por coordinar" del grupo de Telegram.
//
// El bot ya no agenda visitas: a quien quiere venir a la oficina le dice que un asesor lo
// llama y le indica la hora. Esta lista es la agenda de esas llamadas pendientes:
//   - 🎬 Negocio: vino por los servicios (se le pidió el formulario; se marca si ya lo llenó).
//   - 🎓 Curso: vino por un curso (no hay formulario; hay que llamarlo igual).
//   - 📅 Cita del flujo anterior: pedidos hechos antes del cambio, por si alguno quedó colgado.
// Se separa en "nadie del equipo le escribió" y "el equipo ya le escribió" mirando los
// mensajes enviados desde WhatsApp Business después del pedido.
//
// Funciones puras: el route handler consulta Supabase y les pasa las filas.

type OfficeVisitData = {
  requests: {
    conversationId: string;
    phone: string;
    content: string;
    createdAt: string;
    kind: string | null;
  }[];
  messages: {
    conversationId: string;
    direction: "inbound" | "outbound";
    content: string;
    createdAt: string;
    byHuman: boolean;
  }[];
  profileNames: Map<string, string>;
};

type OfficeVisitKind = "business" | "course" | "legacy";

type OfficeVisit = {
  conversationId: string;
  phone: string;
  kind: OfficeVisitKind;
  requestedAt: string;
  requestText: string;
  profileName: string | null;
  teamRepliedAt: string | null;
  leftData: boolean;
};

const OFFICE_VISIT_REPORT_DAYS = 14;

function kindOf(request: OfficeVisitData["requests"][number]): OfficeVisitKind {
  if (request.content.startsWith("[TELEGRAM_APPOINTMENT_SENT]")) return "legacy";
  if (request.content.startsWith("[TELEGRAM_COURSE_OFFICE_VISIT_SENT]")) return "course";
  return request.kind === "course" ? "course" : "business";
}

const isPlaceholder = (text: string) => /^(\[|📷|📄)/.test(text.trim());

function buildOfficeVisits(data: OfficeVisitData): OfficeVisit[] {
  const byConversation = new Map<string, OfficeVisit>();

  for (const request of [...data.requests].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const existing = byConversation.get(request.conversationId);
    const kind = kindOf(request);

    // Un mismo pedido deja dos marcas (el pedido y la alerta de curso): se queda la primera
    // fecha y el tipo más específico.
    if (existing) {
      if (kind === "course" && existing.kind !== "course") existing.kind = "course";
      continue;
    }

    const conversation = data.messages.filter((m) => m.conversationId === request.conversationId);

    const requestText =
      conversation
        .filter((m) => m.direction === "inbound" && m.createdAt <= request.createdAt && !isPlaceholder(m.content))
        .at(-1)?.content ?? "";

    const teamReply = conversation.find((m) => m.byHuman && m.createdAt > request.createdAt);
    const leftData = conversation.some(
      (m) => m.direction === "outbound" && m.content.startsWith("[TELEGRAM_LEAD_SENT]") && m.createdAt >= request.createdAt,
    );

    byConversation.set(request.conversationId, {
      conversationId: request.conversationId,
      phone: request.phone,
      kind,
      requestedAt: request.createdAt,
      requestText,
      profileName: data.profileNames.get(request.phone) ?? null,
      teamRepliedAt: teamReply?.createdAt ?? null,
      leftData,
    });
  }

  return [...byConversation.values()];
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function formatBoliviaShort(iso: string): string {
  const parts = new Intl.DateTimeFormat("es-BO", {
    timeZone: "America/La_Paz",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("day")}/${get("month")} ${get("hour")}:${get("minute")}`;
}

function formatAgo(iso: string, now: Date): string {
  const hours = Math.max(0, (now.getTime() - new Date(iso).getTime()) / 3600_000);
  if (hours < 1) return "hace menos de 1 h";
  if (hours < 48) return `hace ${Math.floor(hours)} h`;
  return `hace ${Math.floor(hours / 24)} días`;
}

const KIND_LABEL: Record<OfficeVisitKind, string> = {
  business: "🎬 Negocio",
  course: "🎓 Curso",
  legacy: "📅 Cita (flujo anterior)",
};

function renderVisit(visit: OfficeVisit, index: number, now: Date): string {
  const digits = visit.phone.replace(/\D/g, "");
  const localPhone = digits.startsWith("591") ? digits.slice(3) : digits;
  const dataLabel =
    visit.kind === "business" ? (visit.leftData ? " · 📋 dejó sus datos" : " · ⏳ aún no dejó sus datos") : "";

  const lines = [
    `<b>${index}.</b> ${KIND_LABEL[visit.kind]}${dataLabel}`,
    `     👤 ${visit.profileName ? escapeHtml(visit.profileName) : "<i>sin nombre de perfil</i>"} · 📱 ${localPhone} · <a href="https://wa.me/${digits}">abrir chat</a>`,
    `     🕒 Pidió visita: ${formatBoliviaShort(visit.requestedAt)} (${formatAgo(visit.requestedAt, now)})`,
  ];

  if (visit.teamRepliedAt) {
    lines.push(`     💬 El equipo le escribió: ${formatBoliviaShort(visit.teamRepliedAt)}`);
  }
  if (visit.requestText) {
    lines.push(`     🗨️ "${escapeHtml(visit.requestText.replace(/\s+/g, " ").slice(0, 120))}"`);
  }

  return lines.join("\n");
}

function renderOfficeVisits(params: { visits: OfficeVisit[]; now: Date }): string[] {
  const pending = params.visits
    .filter((v) => !v.teamRepliedAt)
    .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
  const contacted = params.visits
    .filter((v) => v.teamRepliedAt)
    .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));

  const blocks = [
    [
      `🏢 <b>Visitas por coordinar</b> — últimos ${OFFICE_VISIT_REPORT_DAYS} días`,
      `📞 ${pending.length} sin contactar · 💬 ${contacted.length} ya contactados por WhatsApp`,
    ].join("\n"),
  ];

  if (pending.length > 0) {
    blocks.push("\n📞 <b>Nadie del equipo le escribió</b> — llamar e indicarle la hora (el más antiguo primero)");
    pending.forEach((v, i) => blocks.push(renderVisit(v, i + 1, params.now)));
  }

  if (contacted.length > 0) {
    blocks.push("\n💬 <b>El equipo ya le escribió</b> — confirmar que la visita quedó coordinada");
    contacted.forEach((v, i) => blocks.push(renderVisit(v, i + 1, params.now)));
  }

  if (params.visits.length === 0) {
    blocks.push("\nNadie pidió visitar la oficina en este período.");
  }

  return blocks;
}

export { OFFICE_VISIT_REPORT_DAYS, buildOfficeVisits, renderOfficeVisits };
export type { OfficeVisitData, OfficeVisit };

// /cliente <número> en el grupo de Telegram: qué pasó de verdad con un cliente en el chat y
// en las páginas. Sirve para el caso "ya llené el formulario" sin que llegara nada: se ve si
// recibió el botón, si abrió la página y si envió sus datos.
//
// Todo sale de las marcas que ya quedan en kapso_messages (botones, visitas a la página,
// leads) y del estado de kapso_conversations. renderClientStatus es PURA para probarla.

import { escapeTelegramHtml } from "./telegram.ts";

type SupabaseLike = { from: (table: string) => any };

type ClientEvent = { content: string; createdAt: string };

type ClientStatusData = {
  phone: string;
  conversation: {
    flowStage: string | null;
    botPaused: boolean;
    botPauseExpiresAt: string | null;
    advisorNotifiedAt: string | null;
  } | null;
  // Marcas de los últimos días, de la más nueva a la más vieja.
  events: ClientEvent[];
};

const STATUS_LOOKBACK_DAYS = 14;

const BUTTON_LABELS: Record<string, string> = {
  packages: "Ver paquetes",
  packages_form: "Llenar mis datos (paquetes)",
  courses: "Ver cursos",
  office: "Agendar visita",
};

const PAGE_LABELS: Record<string, string> = {
  paquetes: "/paquetes",
  promocion: "/promocion",
  cursos: "/cursos",
  oficina: "/oficina",
};

// El equipo escribe el celular como lo ve: "71234567", "+591 7123 4567"…
function normalizeClientPhone(input: string): string | null {
  const digits = input.replace(/\D/g, "");
  if (digits.length === 8 && /^[67]/.test(digits)) return `591${digits}`;
  return digits.length >= 10 && digits.length <= 15 ? digits : null;
}

function formatWhen(iso: string, now: Date): string {
  const date = new Date(iso);
  const minutes = Math.round((now.getTime() - date.getTime()) / 60_000);
  const ago =
    minutes < 60
      ? `hace ${Math.max(minutes, 0)} min`
      : minutes < 48 * 60
        ? `hace ${Math.round(minutes / 60)} h`
        : `hace ${Math.round(minutes / (24 * 60))} días`;
  const clock = new Intl.DateTimeFormat("es-BO", {
    timeZone: "America/La_Paz",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
  return `${clock} (${ago})`;
}

// Una línea por marca que importa, en orden de la más vieja a la más nueva.
function describeEvent(event: ClientEvent, now: Date): string | null {
  const when = formatWhen(event.createdAt, now);
  const content = event.content;

  const button = /^\[LINK_SENT:(\w+)\]/.exec(content)?.[1];
  if (button) return `📩 Recibió el botón «${BUTTON_LABELS[button] ?? button}» — ${when}`;

  const page = /^\[SITE_VISIT:(\w+)\]/.exec(content)?.[1];
  if (page) return `👀 Abrió la página ${PAGE_LABELS[page] ?? page} — ${when}`;

  if (content.startsWith("[TELEGRAM_LEAD_SENT] lead recibido desde la página")) {
    const where = content.includes("/oficina")
      ? "/oficina (visita)"
      : content.includes("/promocion")
        ? "/promocion"
        : "/paquetes";
    return `✅ Envió sus datos en ${where} — ${when}`;
  }
  if (content.startsWith("[TELEGRAM_LEAD_SENT]")) return `✅ Dejó sus datos por el chat — ${when}`;
  if (content.startsWith("[INTAKE_FORM_SENT]")) return `📝 Se le pidieron sus datos — ${when}`;
  return null;
}

function renderClientStatus(data: ClientStatusData, now: Date): string {
  const lines = [`👤 <b>Cliente +${escapeTelegramHtml(data.phone)}</b>`, `👉 https://wa.me/${data.phone}`, ""];

  if (!data.conversation) {
    lines.push("No hay ninguna conversación con este número.");
    return lines.join("\n");
  }

  const timeline = [...data.events]
    .reverse()
    .map((event) => describeEvent(event, now))
    .filter((line): line is string => line !== null);

  if (timeline.length === 0) {
    lines.push(`Sin botones, visitas ni datos en los últimos ${STATUS_LOOKBACK_DAYS} días.`);
  } else {
    lines.push(...timeline);
  }

  // Lo que el equipo quiere saber de un vistazo.
  const sentButton = data.events.some((event) => event.content.startsWith("[LINK_SENT:"));
  const visited = data.events.some((event) => event.content.startsWith("[SITE_VISIT:"));
  const leadSent = Boolean(data.conversation.advisorNotifiedAt);

  lines.push("");
  if (leadSent) lines.push("➡️ Sus datos ya llegaron al asesor.");
  else if (visited) lines.push("➡️ Abrió la página pero sus datos NO llegaron.");
  else if (sentButton) lines.push("➡️ Recibió el botón pero no abrió la página.");

  if (data.conversation.botPaused) {
    lines.push(
      data.conversation.botPauseExpiresAt
        ? `🤖 Bot apagado hasta ${formatWhen(data.conversation.botPauseExpiresAt, now).split(" (")[0]}`
        : "🤖 Bot apagado (hasta que alguien lo reactive)",
    );
  } else {
    lines.push("🤖 Bot activo");
  }

  return lines.join("\n");
}

async function loadClientStatus(supabase: SupabaseLike, phone: string): Promise<ClientStatusData> {
  const { data: conversation } = await supabase
    .from("kapso_conversations")
    .select("kapso_conversation_id, flow_stage, bot_paused, bot_pause_expires_at, advisor_notified_at")
    .eq("contact_phone", phone)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!conversation) return { phone, conversation: null, events: [] };

  const since = new Date(Date.now() - STATUS_LOOKBACK_DAYS * 24 * 3600_000).toISOString();
  const { data: rows } = await supabase
    .from("kapso_messages")
    .select("content, created_at")
    .eq("kapso_conversation_id", conversation.kapso_conversation_id)
    .eq("direction", "outbound")
    .or('content.like."[LINK_SENT:%",content.like."[SITE_VISIT:%",content.like."[TELEGRAM_LEAD_SENT]%",content.like."[INTAKE_FORM_SENT]%"')
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(30);

  return {
    phone,
    conversation: {
      flowStage: conversation.flow_stage ?? null,
      botPaused: Boolean(conversation.bot_paused),
      botPauseExpiresAt: conversation.bot_pause_expires_at ?? null,
      advisorNotifiedAt: conversation.advisor_notified_at ?? null,
    },
    events: (rows ?? []).map((row: { content: string; created_at: string }) => ({
      content: String(row.content ?? ""),
      createdAt: row.created_at,
    })),
  };
}

export { loadClientStatus, normalizeClientPhone, renderClientStatus };
export type { ClientStatusData };

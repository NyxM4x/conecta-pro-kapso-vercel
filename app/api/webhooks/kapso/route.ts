import { WhatsAppClient } from "@kapso/whatsapp-cloud-api";
import { createClient } from "@supabase/supabase-js";
import { openai } from "@ai-sdk/openai";
import { generateText } from "ai";

type IncomingMessage = {
  from: string;
  text: string;
  messageId?: string;
  conversationId?: string;
  contactName?: string | null;
  messageTimestamp?: string | null;
  batchIndex?: number | null;
  raw: Record<string, any>;
};

type HistoryMessage = {
  role: "user" | "assistant";
  content: string;
};

type MediaAsset = {
  title: string;
  url: string;
};

type SystemLogLevel = "info" | "warning" | "error" | "critical";

const SYSTEM_PROMPT = `
Eres el asistente de WhatsApp de Conecta Pro.

Tu tarea es responder dudas sobre los cursos de Conecta Pro de forma breve, clara, amable y natural.

Información conocida:
- Curso principal: "Creación de contenido que vende sin tener muchos seguidores".
- Precio preventa: 350 Bs.
- Precio en puerta: 450 Bs.
- Ubicación: 2do anillo entre Grigotá y Piraí, oficinas de Conecta Pro.
- El curso enseña tipos de videos, algoritmo de TikTok, cómo convertir vistas en ventas, guiones y estrategias prácticas.

Reglas:
- Responde como WhatsApp, no como email.
- Sé breve. Máximo 2 o 3 bloques cortos.
- No inventes información.
- Si no sabes algo, di que el equipo puede ayudar con ese detalle.
- No repitas todo si el usuario solo hace una pregunta puntual.
- Si el usuario saluda, responde amable y ofrece ayuda.
- Si el usuario pregunta precio, responde precio directo.
- Si el usuario quiere inscribirse o comprar, dile que una persona del equipo puede ayudarle a confirmar su cupo.
`;

const LOCATION_KEYWORDS = [
  "ubicacion",
  "ubicame",
  "direccion",
  "como llegar",
  "como llego",
  "como llegamos",
  "donde estan",
  "donde estas",
  "donde queda",
  "donde quedan",
  "donde se encuentran",
  "mapa",
  "google maps",
];

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim();
}

function detectLocationIntent(text: string): boolean {
  if (!text) return false;
  const normalized = normalizeText(text);
  return LOCATION_KEYWORDS.some((keyword) => normalized.includes(keyword));
}

type LocationResponse = {
  text: string;
  mapsUrl: string | null;
  videoUrl: string | null;
};

function buildLocationResponse(): LocationResponse {
  const mapsUrl = (process.env.CONECTA_PRO_MAPS_URL ?? "").trim();
  const videoUrl = (process.env.CONECTA_PRO_LOCATION_VIDEO_URL ?? "").trim();
  const fullyConfigured = mapsUrl.length > 0 && videoUrl.length > 0;

  if (fullyConfigured) {
    return {
      text:
        "Claro 😊 estamos en el 2do anillo entre Grigotá y Piraí, oficinas de Conecta Pro. " +
        "Te comparto la ubicación y un videito para que llegues fácil.",
      mapsUrl,
      videoUrl,
    };
  }

  return {
    text:
      "Claro 😊 estamos en el 2do anillo entre Grigotá y Piraí, oficinas de Conecta Pro. " +
      "Si necesitas la ubicación exacta o una referencia para llegar, el equipo puede compartírtela enseguida.",
    mapsUrl: null,
    videoUrl: null,
  };
}

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function getKapsoClient() {
  return new WhatsAppClient({
    baseUrl: "https://api.kapso.ai/meta/whatsapp",
    kapsoApiKey: getRequiredEnv("KAPSO_API_KEY"),
  });
}

function getSupabaseClient() {
  return createClient(
    getRequiredEnv("SUPABASE_URL"),
    getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
  );
}

function maskPhone(phone?: string | null): string | null {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, "");
  if (digits.length <= 4) return "****";
  return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
}

function getTestPhoneDigits(): string | null {
  const digits = (process.env.TEST_PHONE ?? "").replace(/\D/g, "");
  return digits.length > 0 ? digits : null;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function cleanMetadata(metadata?: Record<string, any>): Record<string, any> {
  try {
    return JSON.parse(JSON.stringify(metadata ?? {}));
  } catch {
    return {};
  }
}

async function sendSlackAlert(params: {
  level: SystemLogLevel;
  eventType: string;
  business?: string;
  conversationId?: string;
  messageId?: string;
  contactPhone?: string;
  errorMessage?: string;
}) {
  const webhookUrl = process.env.SLACK_ALERT_WEBHOOK_URL;

  if (!webhookUrl) return;
  if (!["error", "critical"].includes(params.level)) return;

  try {
    const emoji = params.level === "critical" ? "🚨" : "⚠️";

    const text = [
      `${emoji} *${params.level.toUpperCase()} - Kapso/Vercel*`,
      `*Evento:* ${params.eventType}`,
      `*Negocio:* ${params.business ?? "conecta-pro"}`,
      `*Conversación:* ${params.conversationId ?? "N/A"}`,
      `*Mensaje:* ${params.messageId ?? "N/A"}`,
      `*Teléfono:* ${maskPhone(params.contactPhone) ?? "N/A"}`,
      `*Error:* ${params.errorMessage ?? "Sin detalle"}`,
      `*Hora:* ${new Date().toISOString()}`,
    ].join("\n");

    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (error) {
    console.error("sendSlackAlert failed", error);
  }
}

async function logSystemEvent(params: {
  level?: SystemLogLevel;
  eventType: string;
  business?: string;
  clientId?: string | null;
  conversationId?: string;
  messageId?: string;
  contactPhone?: string;
  statusCode?: number;
  errorMessage?: string;
  metadata?: Record<string, any>;
}) {
  try {
    const supabase = getSupabaseClient();

    const { error } = await supabase.from("system_logs").insert({
      level: params.level ?? "info",
      event_type: params.eventType,
      source: "kapso-vercel",
      business: params.business ?? "conecta-pro",
      client_id: params.clientId ?? null,
      kapso_conversation_id: params.conversationId ?? null,
      kapso_message_id: params.messageId ?? null,
      contact_phone_masked: maskPhone(params.contactPhone),
      status_code: params.statusCode ?? null,
      error_message: params.errorMessage ?? null,
      metadata: cleanMetadata(params.metadata),
    });

    if (error) {
      console.error("system_logs insert failed", error);
    }

    await sendSlackAlert({
      level: params.level ?? "info",
      eventType: params.eventType,
      business: params.business ?? "conecta-pro",
      conversationId: params.conversationId,
      messageId: params.messageId,
      contactPhone: params.contactPhone,
      errorMessage: params.errorMessage,
    });
  } catch (error) {
    console.error("logSystemEvent threw", error);
  }
}

function parseKapsoTimestamp(timestamp?: string | number | null): string | null {
  if (!timestamp) return null;
  const numericTimestamp = Number(timestamp);
  if (!Number.isFinite(numericTimestamp)) return null;
  return new Date(numericTimestamp * 1000).toISOString();
}

function getWebhookEvents(payload: Record<string, any>, request: Request): Record<string, any>[] {
  const isBatch =
    payload.batch === true ||
    request.headers.get("x-webhook-batch") === "true";

  if (isBatch && Array.isArray(payload.data)) return payload.data;
  return [payload];
}

function extractMessageText(
  message?: Record<string, any> | null,
  conversation?: Record<string, any> | null,
): string {
  const textBody = message?.text?.body;
  if (typeof textBody === "string" && textBody.trim()) return textBody.trim();

  const transcriptText = message?.kapso?.transcript?.text;
  if (typeof transcriptText === "string" && transcriptText.trim()) return transcriptText.trim();

  const buttonText = message?.button?.text;
  if (typeof buttonText === "string" && buttonText.trim()) return buttonText.trim();

  const interactiveButtonText =
    message?.interactive?.button_reply?.title ??
    message?.interactive?.list_reply?.title;

  if (typeof interactiveButtonText === "string" && interactiveButtonText.trim()) {
    return interactiveButtonText.trim();
  }

  const kapsoContent = message?.kapso?.content;
  if (typeof kapsoContent === "string" && kapsoContent.trim()) {
    const transcriptMatch = kapsoContent.match(/Transcript:\s*([\s\S]*)$/i);
    if (transcriptMatch?.[1]?.trim()) {
      return `🎙️ Audio recibido\n\nTranscripción: ${transcriptMatch[1].trim()}`;
    }

    return "🎙️ Audio recibido";
  }


const lastMessageText = conversation?.kapso?.last_message_text;
if (typeof lastMessageText === "string" && lastMessageText.trim()) {
  const transcriptMatch = lastMessageText.match(/Transcript:\s*([\s\S]*)$/i);
  if (transcriptMatch?.[1]?.trim()) {
    return `🎙️ Audio recibido\n\nTranscripción: ${transcriptMatch[1].trim()}`;
  }

  return "🎙️ Audio recibido";
}

return "";
}

async function extractIncomingFromEvent(
  event: Record<string, any>,
): Promise<IncomingMessage | null> {
  const kapsoDirection = event.message?.kapso?.direction;

  if (kapsoDirection && kapsoDirection !== "inbound") {
    const origin = event.message?.kapso?.origin ?? null;
    const conversationId = event.conversation?.id ?? null;
    const phone = event.conversation?.phone_number ?? event.message?.to ?? null;
    const messageId = event.message?.id ?? null;

    console.log("outbound message detected", {
      direction: kapsoDirection,
      origin,
      messageId,
      conversationId,
      status: event.message?.kapso?.status ?? null,
    });

    // Respuesta humana desde la app de WhatsApp Business: apaga el bot
    // para esta conversación hasta que se reanude manualmente (/resume).
    if (origin === "business_app" && conversationId) {
      const supabase = getSupabaseClient();
      const nowIso = new Date().toISOString();

      const { error } = await supabase
        .from("kapso_conversations")
        .update({
          bot_paused: true,
          bot_paused_at: nowIso,
          bot_pause_expires_at: null,
          bot_paused_reason: "human_whatsapp_business_app",
          bot_pause_mode: "auto",
          bot_pause_duration_minutes: null,
          updated_at: nowIso,
        })
        .eq("kapso_conversation_id", conversationId);

      if (error) {
        console.error("auto pause from business_app failed", error);
      } else {
        console.log("bot auto-paused from business_app", {
          conversationId,
          phone,
        });
      }
    }

    return null;
  }

  const from = event.message?.from ?? "";
  const text = extractMessageText(event.message, event.conversation);
  const messageId = event.message?.id;
  const conversationId = event.conversation?.id ?? from;
  const contactName = event.conversation?.contact_name ?? null;
  const messageTimestamp = parseKapsoTimestamp(event.message?.timestamp);

  if (!from || !text) return null;

  return {
    from,
    text,
    messageId,
    conversationId,
    contactName,
    messageTimestamp,
    raw: event,
  };
}

async function normalizeIncomingMessages(
  payload: Record<string, any>,
  request: Request,
): Promise<IncomingMessage[]> {
  const events = getWebhookEvents(payload, request);
  const incomingMessages: IncomingMessage[] = [];

  for (const [index, event] of events.entries()) {
    const incoming = await extractIncomingFromEvent(event);
    if (!incoming) continue;

    incomingMessages.push({
      ...incoming,
      batchIndex: index,
    });
  }

  return incomingMessages;
}

async function saveContactAndConversation(message: IncomingMessage) {
  const supabase = getSupabaseClient();
  const nowIso = new Date().toISOString();

  const { error: contactError } = await supabase
    .from("kapso_contacts")
    .upsert(
      {
        phone: message.from,
        name: message.contactName,
        updated_at: nowIso,
      },
      { onConflict: "phone" },
    );

  if (contactError) {
    console.error("supabase upsert kapso_contacts failed", contactError);

    await logSystemEvent({
      level: "error",
      eventType: "supabase_contact_upsert_failed",
      conversationId: message.conversationId,
      messageId: message.messageId,
      contactPhone: message.from,
      errorMessage: contactError.message,
      metadata: {
        code: contactError.code,
        details: contactError.details,
      },
    });
  }

  const { error: conversationError } = await supabase
    .from("kapso_conversations")
    .upsert(
      {
        kapso_conversation_id: message.conversationId,
        contact_phone: message.from,
        updated_at: nowIso,
      },
      { onConflict: "kapso_conversation_id" },
    );

  if (conversationError) {
    console.error("supabase upsert kapso_conversations failed", conversationError);

    await logSystemEvent({
      level: "error",
      eventType: "supabase_conversation_upsert_failed",
      conversationId: message.conversationId,
      messageId: message.messageId,
      contactPhone: message.from,
      errorMessage: conversationError.message,
      metadata: {
        code: conversationError.code,
        details: conversationError.details,
      },
    });
  }
}

async function saveInboundMessage(message: IncomingMessage): Promise<boolean> {
  const supabase = getSupabaseClient();

  const { error: messageError } = await supabase
    .from("kapso_messages")
    .insert({
      kapso_message_id: message.messageId,
      kapso_conversation_id: message.conversationId,
      contact_phone: message.from,
      direction: "inbound",
      role: "user",
      content: message.text,
      message_timestamp: message.messageTimestamp,
      batch_index: message.batchIndex ?? null,
      raw_payload: message.raw,
    });

  if (messageError) {
    if (messageError.code === "23505") {
      console.log("duplicate inbound message ignored", message.messageId);
      return false;
    }

    console.error("supabase insert kapso_messages inbound failed", messageError);

    await logSystemEvent({
      level: "error",
      eventType: "supabase_inbound_insert_failed",
      conversationId: message.conversationId,
      messageId: message.messageId,
      contactPhone: message.from,
      errorMessage: messageError.message,
      metadata: {
        code: messageError.code,
        details: messageError.details,
        batch_index: message.batchIndex ?? null,
      },
    });

    return false;
  }

  return true;
}

async function saveOutboundMessage(params: {
  conversationId?: string;
  phone: string;
  content: string;
  rawPayload?: Record<string, any> | null;
}) {
  const supabase = getSupabaseClient();

  const { error } = await supabase.from("kapso_messages").insert({
    kapso_message_id: null,
    kapso_conversation_id: params.conversationId,
    contact_phone: params.phone,
    direction: "outbound",
    role: "assistant",
    content: params.content,
    message_timestamp: new Date().toISOString(),
    batch_index: null,
    raw_payload: params.rawPayload ?? null,
  });

  if (error) {
    console.error("supabase insert kapso_messages outbound failed", error);

    await logSystemEvent({
      level: "error",
      eventType: "supabase_outbound_insert_failed",
      conversationId: params.conversationId,
      contactPhone: params.phone,
      errorMessage: error.message,
      metadata: {
        code: error.code,
        details: error.details,
      },
    });
  }
}

async function acquireReplyLock(params: {
  conversationId?: string;
  lastMessageId?: string;
  phone?: string;
  batchSize: number;
}): Promise<boolean> {
  if (!params.lastMessageId) return true;

  const supabase = getSupabaseClient();

  const { error } = await supabase.from("kapso_response_locks").insert({
    kapso_conversation_id: params.conversationId,
    last_kapso_message_id: params.lastMessageId,
    batch_size: params.batchSize,
    status: "processing",
  });

  if (!error) return true;

  if (error.code === "23505") {
    console.log("reply lock already exists, skipping reply", params.lastMessageId);
    return false;
  }

  console.error("supabase insert kapso_response_locks failed", error);

  await logSystemEvent({
    level: "error",
    eventType: "reply_lock_insert_failed",
    conversationId: params.conversationId,
    messageId: params.lastMessageId,
    contactPhone: params.phone,
    errorMessage: error.message,
    metadata: {
      code: error.code,
      details: error.details,
      batch_size: params.batchSize,
    },
  });

  return false;
}

async function markReplyLockSent(params: {
  lastMessageId?: string;
  conversationId?: string;
  phone?: string;
  responseText: string;
}) {
  if (!params.lastMessageId) return;

  const supabase = getSupabaseClient();

  const { error } = await supabase
    .from("kapso_response_locks")
    .update({
      status: "sent",
      response_text: params.responseText,
      updated_at: new Date().toISOString(),
    })
    .eq("last_kapso_message_id", params.lastMessageId);

  if (error) {
    console.error("supabase update kapso_response_locks failed", error);

    await logSystemEvent({
      level: "error",
      eventType: "reply_lock_update_failed",
      conversationId: params.conversationId,
      messageId: params.lastMessageId,
      contactPhone: params.phone,
      errorMessage: error.message,
      metadata: {
        code: error.code,
        details: error.details,
      },
    });
  }
}

type BotPauseState = {
  paused: boolean;
  expired: boolean;
  reason?: string | null;
  expiresAt?: string | null;
};

async function getBotPauseState(conversationId?: string): Promise<BotPauseState> {
  if (!conversationId) {
    return { paused: false, expired: false };
  }

  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("kapso_conversations")
    .select("bot_paused, bot_pause_expires_at, bot_paused_reason")
    .eq("kapso_conversation_id", conversationId)
    .maybeSingle();

  if (error) {
    console.error("supabase select bot pause state failed", error);

    await logSystemEvent({
      level: "error",
      eventType: "bot_pause_state_select_failed",
      conversationId,
      errorMessage: error.message,
      metadata: {
        code: error.code,
        details: error.details,
      },
    });

    return { paused: false, expired: false };
  }

  if (!data?.bot_paused) {
    return { paused: false, expired: false };
  }

  const expiresAt = data.bot_pause_expires_at
    ? new Date(data.bot_pause_expires_at).getTime()
    : null;

  const expired = expiresAt ? expiresAt <= Date.now() : false;

  return {
    paused: true,
    expired,
    reason: data.bot_paused_reason,
    expiresAt: data.bot_pause_expires_at,
  };
}

async function resumeBotIfPauseExpired(conversationId?: string) {
  if (!conversationId) return;

  const supabase = getSupabaseClient();

  const { error } = await supabase
    .from("kapso_conversations")
    .update({
      bot_paused: false,
      bot_resumed_at: new Date().toISOString(),
      bot_pause_expires_at: null,
      bot_paused_reason: "auto_resume_expired",
      updated_at: new Date().toISOString(),
    })
    .eq("kapso_conversation_id", conversationId);

  if (error) {
    console.error("supabase auto resume bot failed", error);

    await logSystemEvent({
      level: "error",
      eventType: "bot_auto_resume_failed",
      conversationId,
      errorMessage: error.message,
      metadata: {
        code: error.code,
        details: error.details,
      },
    });
  }
}

async function getRecentConversationHistory(
  conversationId?: string,
  limit = 12,
): Promise<HistoryMessage[]> {
  if (!conversationId) return [];

  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("kapso_messages")
    .select("role, content, message_timestamp, batch_index, created_at")
    .eq("kapso_conversation_id", conversationId)
    .order("message_timestamp", { ascending: false, nullsFirst: false })
    .order("batch_index", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("supabase select recent history failed", error);

    await logSystemEvent({
      level: "error",
      eventType: "supabase_history_select_failed",
      conversationId,
      errorMessage: error.message,
      metadata: {
        code: error.code,
        details: error.details,
      },
    });

    return [];
  }

  return (data ?? [])
    .reverse()
    .map((row): HistoryMessage => ({
      role: row.role === "assistant" ? "assistant" : "user",
      content: String(row.content ?? ""),
    }))
    .filter((message) => message.content.trim().length > 0);
}

async function generateAssistantReply(params: {
  history: HistoryMessage[];
  conversationId?: string;
  messageId?: string;
  phone?: string;
}): Promise<string> {
  try {
    const { text } = await generateText({
      model: openai(process.env.OPENAI_MODEL ?? "gpt-4o-mini"),
      system: SYSTEM_PROMPT,
      messages: params.history.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      temperature: 0.4,
    });

    return text.trim();
  } catch (error) {
    console.error("openai generateText failed", error);

    await logSystemEvent({
      level: "critical",
      eventType: "openai_generate_failed",
      conversationId: params.conversationId,
      messageId: params.messageId,
      contactPhone: params.phone,
      errorMessage: getErrorMessage(error),
      metadata: {
        fallback_used: true,
        model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
      },
    });

    return "Gracias por escribirnos 😊 En este momento puedo ayudarte con información del curso. ¿Quieres saber el precio, ubicación o detalles del contenido?";
  }
}

async function hasMediaAlreadySent(conversationId?: string): Promise<boolean> {
  if (!conversationId) return false;

  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("kapso_messages")
    .select("id")
    .eq("kapso_conversation_id", conversationId)
    .ilike("content", "[MEDIA_SENT]%")
    .limit(1);

  if (error) {
    console.error("supabase check media already sent failed", error);

    await logSystemEvent({
      level: "error",
      eventType: "supabase_media_check_failed",
      conversationId,
      errorMessage: error.message,
      metadata: {
        code: error.code,
        details: error.details,
      },
    });

    return false;
  }

  return (data ?? []).length > 0;
}

async function getActiveMediaAssets(): Promise<MediaAsset[]> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("kapso_media_assets")
    .select("title, url")
    .eq("business", "conecta-pro")
    .eq("intent", "course_flyer")
    .eq("media_type", "image")
    .eq("is_active", true)
    .order("sort_order", { ascending: true });

  if (error) {
    console.error("supabase select kapso_media_assets failed", error);

    await logSystemEvent({
      level: "error",
      eventType: "supabase_media_assets_select_failed",
      errorMessage: error.message,
      metadata: {
        code: error.code,
        details: error.details,
      },
    });

    return [];
  }

  return (data ?? [])
    .map((asset): MediaAsset => ({
      title: String(asset.title ?? "Imagen enviada"),
      url: String(asset.url ?? ""),
    }))
    .filter((asset) => asset.url.trim().length > 0);
}

async function sendKapsoImage(params: {
  phoneNumberId: string;
  to: string;
  imageUrl: string;
  caption?: string;
}) {
  const response = await fetch(
    `https://api.kapso.ai/meta/whatsapp/v24.0/${params.phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": getRequiredEnv("KAPSO_API_KEY"),
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: params.to,
        type: "image",
        image: {
          link: params.imageUrl,
          ...(params.caption ? { caption: params.caption } : {}),
        },
      }),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Kapso image send failed ${response.status}: ${body}`);
  }
}

async function sendMediaAssetsIfNeeded(params: {
  conversationId?: string;
  phone: string;
  phoneNumberId: string;
}) {
  const alreadySent = await hasMediaAlreadySent(params.conversationId);

  if (alreadySent) {
    console.log("media already sent for conversation", params.conversationId);
    return;
  }

  const assets = await getActiveMediaAssets();

  if (assets.length === 0) {
    console.log("no active media assets found");
    return;
  }

  for (const asset of assets) {
    try {
      await sendKapsoImage({
        phoneNumberId: params.phoneNumberId,
        to: params.phone,
        imageUrl: asset.url,
      });

      await saveOutboundMessage({
        conversationId: params.conversationId,
        phone: params.phone,
        content: `[MEDIA_SENT] ${asset.title}`,
        rawPayload: {
          type: "image",
          title: asset.title,
          url: asset.url,
          source: "kapso_media_assets",
        },
      });

      console.log("Kapso image sent successfully", asset.title);
    } catch (error) {
      console.error("kapso image send/save failed", asset.title, error);

      await logSystemEvent({
        level: "error",
        eventType: "media_send_failed",
        conversationId: params.conversationId,
        contactPhone: params.phone,
        errorMessage: getErrorMessage(error),
        metadata: {
          asset_title: asset.title,
          asset_url_present: Boolean(asset.url),
        },
      });
    }
  }
}

export async function POST(request: Request) {
  let payload: Record<string, any>;

  try {
    payload = await request.json();
  } catch (error) {
    console.error("invalid json", error);

    await logSystemEvent({
      level: "warning",
      eventType: "invalid_json",
      statusCode: 400,
      errorMessage: getErrorMessage(error),
    });

    return new Response("invalid json", { status: 400 });
  }

  const events = getWebhookEvents(payload, request);
  const incomingMessages = await normalizeIncomingMessages(payload, request);

  const firstMessage = incomingMessages[0];
  const lastMessage = incomingMessages[incomingMessages.length - 1];

  console.log("Kapso webhook received", {
    payloadType: payload.type ?? null,
    batch: payload.batch === true,
    batchSize: Array.isArray(payload.data) ? payload.data.length : 1,
    incomingCount: incomingMessages.length,
    messageTypes: events.map((event) => event?.message?.type ?? "unknown"),
    conversationId: lastMessage?.conversationId ?? null,
    phone: maskPhone(lastMessage?.from),
  });

  await logSystemEvent({
    level: "info",
    eventType: "webhook_received",
    conversationId: lastMessage?.conversationId,
    messageId: lastMessage?.messageId,
    contactPhone: lastMessage?.from,
    metadata: {
      payload_type: payload.type ?? null,
      batch: payload.batch === true,
      batch_size: Array.isArray(payload.data) ? payload.data.length : 1,
      incoming_count: incomingMessages.length,
      message_types: events.map((event) => event?.message?.type ?? "unknown"),
    },
  });

  if (incomingMessages.length === 0) {
    await logSystemEvent({
      level: "warning",
      eventType: "payload_ignored_no_incoming_messages",
      metadata: {
        payload_type: payload.type ?? null,
        batch: payload.batch === true,
        event_count: events.length,
        message_types: events.map((event) => event?.message?.type ?? "unknown"),
      },
    });

    return new Response("ignored", { status: 200 });
  }

  const testPhoneDigits = getTestPhoneDigits();

  if (
    testPhoneDigits &&
    String(lastMessage.from).replace(/\D/g, "") !== testPhoneDigits
  ) {
    console.log("test mode active, message from non-test number ignored", {
      conversationId: lastMessage.conversationId,
      phone: maskPhone(lastMessage.from),
    });

    await logSystemEvent({
      level: "info",
      eventType: "test_mode_ignored",
      conversationId: lastMessage.conversationId,
      messageId: lastMessage.messageId,
      contactPhone: lastMessage.from,
      metadata: {
        test_phone_masked: maskPhone(testPhoneDigits),
        incoming_count: incomingMessages.length,
      },
    });

    return new Response("ignored (test mode)", { status: 200 });
  }

  try {
    await saveContactAndConversation(lastMessage);
  } catch (error) {
    console.error("supabase save contact/conversation threw", error);

    await logSystemEvent({
      level: "error",
      eventType: "supabase_save_contact_conversation_threw",
      conversationId: lastMessage.conversationId,
      messageId: lastMessage.messageId,
      contactPhone: lastMessage.from,
      errorMessage: getErrorMessage(error),
    });
  }

  const newMessages: IncomingMessage[] = [];

  for (const message of incomingMessages) {
    try {
      const saved = await saveInboundMessage(message);
      if (saved) newMessages.push(message);
    } catch (error) {
      console.error("supabase save inbound threw", error);

      await logSystemEvent({
        level: "error",
        eventType: "supabase_save_inbound_threw",
        conversationId: message.conversationId,
        messageId: message.messageId,
        contactPhone: message.from,
        errorMessage: getErrorMessage(error),
        metadata: {
          batch_index: message.batchIndex ?? null,
        },
      });
    }
  }

  if (newMessages.length === 0) {
    console.log("all inbound messages were duplicates, no reply sent");
    return new Response("duplicate ignored", { status: 200 });
  }

  const canReply = await acquireReplyLock({
    conversationId: lastMessage.conversationId,
    lastMessageId: lastMessage.messageId,
    phone: lastMessage.from,
    batchSize: incomingMessages.length,
  });

  if (!canReply) {
    return new Response("reply already processed", { status: 200 });
  }

  const pauseState = await getBotPauseState(lastMessage.conversationId);

  if (pauseState.paused && !pauseState.expired) {
    console.log("bot paused, inbound saved but no reply sent", {
      conversationId: lastMessage.conversationId,
      reason: pauseState.reason ?? null,
      expiresAt: pauseState.expiresAt ?? null,
    });

    await logSystemEvent({
      level: "info",
      eventType: "bot_reply_skipped_paused",
      conversationId: lastMessage.conversationId,
      messageId: lastMessage.messageId,
      contactPhone: lastMessage.from,
      metadata: {
        reason: pauseState.reason ?? null,
        expires_at: pauseState.expiresAt ?? null,
      },
    });

    return new Response("bot paused", { status: 200 });
  }

  if (pauseState.paused && pauseState.expired) {
    await resumeBotIfPauseExpired(lastMessage.conversationId);

    await logSystemEvent({
      level: "info",
      eventType: "bot_auto_resumed_pause_expired",
      conversationId: lastMessage.conversationId,
      messageId: lastMessage.messageId,
      contactPhone: lastMessage.from,
      metadata: {
        previous_reason: pauseState.reason ?? null,
        expired_at: pauseState.expiresAt ?? null,
      },
    });
  }

  const kapso = getKapsoClient();
  const phoneNumberId = getRequiredEnv("KAPSO_PHONE_NUMBER_ID");

  if (lastMessage.messageId) {
    try {
      await kapso.messages.markRead({
        phoneNumberId,
        messageId: lastMessage.messageId,
        typingIndicator: { type: "text" },
      });

      console.log("Kapso last message marked as read with typing");
    } catch (error) {
      console.error("kapso markRead failed", error);

      await logSystemEvent({
        level: "warning",
        eventType: "kapso_mark_read_failed",
        conversationId: lastMessage.conversationId,
        messageId: lastMessage.messageId,
        contactPhone: lastMessage.from,
        errorMessage: getErrorMessage(error),
      });
    }
  }

  const history = await getRecentConversationHistory(lastMessage.conversationId, 12);

  const locationResponse = detectLocationIntent(lastMessage.text)
    ? buildLocationResponse()
    : null;

  const replyText = locationResponse
    ? locationResponse.text
    : await generateAssistantReply({
        history,
        conversationId: lastMessage.conversationId,
        messageId: lastMessage.messageId,
        phone: lastMessage.from,
      });

  try {
    await kapso.messages.sendText({
      phoneNumberId,
      to: lastMessage.from,
      body: replyText,
    });

    console.log("Kapso SDK text sent successfully");
  } catch (error) {
    console.error("kapso sendText failed", error);

    await logSystemEvent({
      level: "critical",
      eventType: "kapso_send_text_failed",
      conversationId: lastMessage.conversationId,
      messageId: lastMessage.messageId,
      contactPhone: lastMessage.from,
      statusCode: 502,
      errorMessage: getErrorMessage(error),
      metadata: {
        response_not_sent: true,
      },
    });

    return new Response("send failed", { status: 502 });
  }

  if (locationResponse && locationResponse.mapsUrl && locationResponse.videoUrl) {
    try {
      await kapso.messages.sendText({
        phoneNumberId,
        to: lastMessage.from,
        body: locationResponse.mapsUrl,
      });

      await saveOutboundMessage({
        conversationId: lastMessage.conversationId ?? firstMessage.conversationId,
        phone: lastMessage.from,
        content: `[LOCATION_MAPS] ${locationResponse.mapsUrl}`,
        rawPayload: { type: "location_maps", url: locationResponse.mapsUrl },
      });

      await kapso.messages.sendVideo({
        phoneNumberId,
        to: lastMessage.from,
        video: {
          link: locationResponse.videoUrl,
          caption: "Referencia para llegar a Conecta Pro 📍",
        },
      });

      await saveOutboundMessage({
        conversationId: lastMessage.conversationId ?? firstMessage.conversationId,
        phone: lastMessage.from,
        content: `[LOCATION_VIDEO] ${locationResponse.videoUrl}`,
        rawPayload: { type: "location_video", url: locationResponse.videoUrl },
      });

      console.log("Kapso location maps + video sent successfully");
    } catch (error) {
      console.error("kapso location media send failed", error);

      await logSystemEvent({
        level: "error",
        eventType: "location_media_send_failed",
        conversationId: lastMessage.conversationId,
        messageId: lastMessage.messageId,
        contactPhone: lastMessage.from,
        errorMessage: getErrorMessage(error),
      });
    }
  }

  try {
    await saveOutboundMessage({
      conversationId: lastMessage.conversationId ?? firstMessage.conversationId,
      phone: lastMessage.from,
      content: replyText,
    });

    await markReplyLockSent({
      lastMessageId: lastMessage.messageId,
      conversationId: lastMessage.conversationId,
      phone: lastMessage.from,
      responseText: replyText,
    });

    if (!locationResponse) {
      await sendMediaAssetsIfNeeded({
        conversationId: lastMessage.conversationId ?? firstMessage.conversationId,
        phone: lastMessage.from,
        phoneNumberId,
      });
    }
  } catch (error) {
    console.error("supabase save outbound/lock/media threw", error);

    await logSystemEvent({
      level: "error",
      eventType: "post_send_persistence_or_media_threw",
      conversationId: lastMessage.conversationId,
      messageId: lastMessage.messageId,
      contactPhone: lastMessage.from,
      errorMessage: getErrorMessage(error),
    });
  }

  await logSystemEvent({
    level: "info",
    eventType: "webhook_processed",
    conversationId: lastMessage.conversationId,
    messageId: lastMessage.messageId,
    contactPhone: lastMessage.from,
    metadata: {
      new_messages_count: newMessages.length,
      incoming_messages_count: incomingMessages.length,
      reply_sent: true,
      media_check_done: true,
    },
  });

  return new Response("ok", { status: 200 });
}
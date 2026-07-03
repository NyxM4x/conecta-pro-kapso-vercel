import { WhatsAppClient } from "@kapso/whatsapp-cloud-api";
import { createClient } from "@supabase/supabase-js";
import { openai } from "@ai-sdk/openai";
import { generateText, Output } from "ai";
import { z } from "zod";

type IncomingMessage = {
  from: string;
  text: string;
  isImage?: boolean;
  isDocument?: boolean;
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

type MediaIntent =
  | "course_flyer"
  | "location_video"
  | "payment_qr"
  | "service_packages";

type MediaAsset = {
  title: string;
  url: string;
  mediaType: "image" | "video";
};

// Orden en que se envían los intents cuando aplica más de uno en un mismo turno.
const MEDIA_SEND_ORDER: MediaIntent[] = [
  "course_flyer",
  "service_packages",
  "location_video",
  "payment_qr",
];

type SystemLogLevel = "info" | "warning" | "error" | "critical";

const SYSTEM_PROMPT = `
Eres la asistente de WhatsApp de Conecta Pro. Hablas en nombre del equipo, en un tono cercano, entusiasta
y natural — como alguien del equipo respondiendo por WhatsApp, no como un bot formal. Trata al usuario de "tú".

═══════════════════════════════════════
INFORMACIÓN CONOCIDA
═══════════════════════════════════════

Conecta Pro tiene TRES líneas activas:

LÍNEA A — Cursos (próximamente):
- Conecta Pro dictará dos cursos presenciales en Santa Cruz de la Sierra, Bolivia, en julio:
  1. Curso de Creación de Contenido
  2. Curso de Edición en CapCut Pro
- Las fechas exactas aún no están confirmadas. Pronto se anunciarán las nuevas fechas.
- Para estar al tanto: seguir la cuenta de TikTok de Conecta Pro: @marketero7
- No hay precios confirmados todavía. NUNCA inventes fechas ni precios.
- Este flujo activa intents.course_flyer = true para que el sistema envíe los flyers de ambos cursos.

LÍNEA B — Paquetes de producción (servicio principal / embudo principal):
- Conecta Pro ofrece paquetes de grabación y edición de video para negocios y marcas personales.
- Paquetes disponibles: 6 o 14 videos. Para otras cantidades, un asesor prepara cotización.
- Incluye producción profesional (grabación + edición) orientada a redes sociales (TikTok, Instagram).
- También se trabaja con dron según el paquete.
- Los precios los confirma el equipo asesor — no los inventes. Si preguntan, di que un asesor
  les confirmará según su caso.
- Este flujo activa intents.service_packages = true.

SERVICIO DESCONTINUADO — Promo de edición de un video por 50 Bs:
- Este servicio ya NO está disponible. Los cupos eran limitados y se agotaron.
- NUNCA lo ofrezcas ni lo menciones de forma proactiva en ningún mensaje.
- SOLO si el cliente lo menciona explícitamente ("edición de 50 Bs", "editan un video por 50",
  "la promo de edición", "el editor externo", etc.), responde que ese servicio ya no está disponible
  porque los cupos eran limitados y se agotaron. No des el número del editor ni menciones al editor.
- NO lo confundas con los paquetes de producción.

SOBRE QUIÉN SALE EN LOS VIDEOS (paquetes):
- Si preguntan si sale el dueño o un modelo, responde con tono asesor (ver guía abajo).

REDES SOCIALES:
- TikTok: @marketero7. NUNCA inventes URLs. Si piden el link, da solo el nombre de usuario.
- Para otras redes (Instagram, Facebook, etc.): di que están en TikTok como @marketero7.

UBICACIÓN OFICINA:
- Google Maps (texto plano, nunca markdown):
  https://maps.app.goo.gl/zUxkMk9nRupxX6jq6?g_st=ic

═══════════════════════════════════════
REGLAS DE TONO Y FORMATO (campo "reply")
═══════════════════════════════════════

- Escribe como WhatsApp: frases cortas, máximo 2-3 bloques, sin firmas ni encabezados.
- Usa emojis con naturalidad (2-3 por mensaje, ej. 👋🎬✅📋🎓), sin saturar.
- No inventes información. Si no sabes algo, dilo con naturalidad y ofrece que el equipo lo confirma.
- Links de Maps: texto plano (URL completa), NUNCA formato Markdown [texto](url).
- El envío de flyers lo decide el sistema, no tú. NUNCA prometas "te envío un flyer/imagen ahora".
  Usa frases neutras: "hay información disponible sobre los cursos", "te compartimos los paquetes".
- Si la intención ya es clara, afirma el siguiente paso directamente. Sin preguntas intermedias.

═══════════════════════════════════════
GUÍA POR SITUACIÓN
═══════════════════════════════════════

▸ SALUDO / PRIMER CONTACTO
  Cuando el usuario envía un saludo o su primer mensaje sin pregunta concreta, responde ÚNICA y
  EXACTAMENTE con el siguiente texto — sin modificarlo, sin agregar emojis extra, sin parafrasear,
  sin inventar variaciones:

  ¡Hola! Somos ConectaPro😊 ¿En qué puedo ayudarte hoy? Si te interesa, tenemos cursos (disponibles nuevas fechas de julio pronto) *servicios de grabación y edición de video para negocios o tu marca personal*

  RESTRICCIONES ABSOLUTAS para el saludo:
  - Copia el texto anterior LITERALMENTE, carácter por carácter. NO lo parafrasees.
  - NO agregues saludos adicionales, preguntas extra ni emojis que no estén ahí.
  - NO menciones la promo de edición de 50 Bs (ya no está disponible y no se ofrece proactivamente).
  - NO menciones precios ni fechas exactas.
  - NO marques intents.course_flyer ni intents.service_packages — el usuario aún no ha pedido
    información específica. Espera su respuesta para saber a qué flujo dirigirlo.

▸ FLUJO A — CURSOS
  Aplica cuando el usuario pregunta por los cursos, por aprender edición, por capacitación,
  por las clases, etc. (ej. "¿qué cursos tienen?", "¿cuándo es el curso?", "¿tienen clases de CapCut?").

  - Menciona los dos cursos próximos: Creación de Contenido y Edición en CapCut Pro.
  - Explica que las fechas exactas se anunciarán pronto — en julio aproximadamente.
  - Invita a seguir @marketero7 en TikTok para estar al tanto del anuncio.
  - NO menciones precios (no están confirmados). NO menciones paquetes de producción en este flujo.
  - Marca intents.course_flyer = true para que el sistema envíe los flyers de cursos.

▸ FLUJO B — PAQUETES DE PRODUCCIÓN (consulta general)
  Aplica cuando preguntan por servicios, grabación, edición para su negocio, paquetes, planes,
  contenido para redes, dron, etc. — sin intención clara de contratar todavía.

  Responde ÚNICA y EXACTAMENTE con este texto, sin modificarlo:

  ¡Claro! En Conecta Pro ofrecemos paquetes de grabación y edición de video para negocios y marcas personales. Puedes elegir entre 6 o 14 videos, todos con producción profesional orientada a redes sociales como TikTok e Instagram. También trabajamos con dron según el paquete que elijas.

  Si deseas elegir un paquete avísanos para pedirte tus datos y así un asesor te contactará y te dará toda la información que necesites.

  - Marca intents.service_packages = true.

▸ FLUJO B — PAQUETES DE PRODUCCIÓN (intención clara de contratar)
  Aplica cuando dice "quiero contratar", "quiero el paquete de X videos", "cuándo empezamos",
  "cómo contrato", "quiero empezar", "quiero los servicios de grabación y edición" (NO los cursos,
  NO la promo de 50 Bs).

  Incluye el formulario de leads EXACTAMENTE como aparece abajo, con intro antes
  (ej. "¡Con gusto! Para coordinar todo, necesito algunos datos 📋"):

  📌 Nombre:
  📌 Nombre de tu empresa o emprendimiento:
  📌 Cargo dentro de la empresa:
  📌 Número de contacto personal:
  📌 Rubro o sector: (Ej. gastronomía, belleza, moda, salud, etc.)
  📌 Instagram o redes sociales:
  📌 ¿Qué tipo de contenido te interesa? (Fotos, videos, contenido con creadores, etc.)
  📌 ¿Tienes alguna referencia de contenido que te guste? (Opcional)

  - Marca service_intake_requested = true.
  - Marca intents.service_packages = true.
  - Una vez que el cliente envíe sus datos, agradece y avísale que un asesor se comunicará.
  - Si los datos llegan en partes, guíalo para completar solo los campos que falten.
  - Si el contexto indica que el formulario ya fue enviado, NO lo repitas (salvo que lo pida).

▸ FLUJO B — CANTIDAD DE VIDEOS QUE NO ES 6, 12 NI 30
  Si pide una cantidad que no coincide con los paquetes estándar (ej. 2, 3, 5, 7, 8, 10, 15, 20):

  "Entendido. Nuestros paquetes estándar son de 6 o 14 videos. Para una cantidad diferente,
  podemos hacerte una cotización a medida 📋 ¿Te gustaría que un asesor te contacte para analizar
  tu caso y darte un precio personalizado?"

  - Marca intents.service_packages = true para que el sistema envíe el flyer de paquetes.
  - NO incluyas el formulario hasta que el usuario confirme interés.

▸ CLIENTE PREGUNTA POR LA PROMO DE EDICIÓN DE 50 BS
  Si el cliente menciona explícitamente la edición de 50 Bs, la promo de edición puntual o
  algo similar (ej. "¿siguen con la promo de 50?", "quiero el video de 50 Bs", "edición de 50",
  "cuánto cuesta editar un video", "me pueden editar mi video"):

  Responde ÚNICA y EXACTAMENTE con este texto, sin modificarlo:

  Ese servicio ya no está disponible 😊 Los cupos eran limitados y se agotaron. Sin embargo, si necesitas contenido de video para tu negocio, tenemos paquetes de grabación y edición de 6 o 14 videos con producción profesional. ¿Te gustaría saber más?

  - NO des el número del editor externo ni lo menciones.
  - NO marques intents.service_packages todavía — espera a que el cliente confirme interés.

▸ ¿QUIÉN SALE EN LOS VIDEOS? (dueño o modelo)
  Si el usuario pregunta si sale él mismo, el dueño o un modelo:

  "Para que tu marca despegue y conecte con tu audiencia, siempre recomendamos que el emprendedor
  o dueño del negocio sea el protagonista de los videos 🎬 Es la mejor forma de darle cara a tu
  negocio. Sin embargo, si prefieres no salir, podemos gestionar un modelo sin problema.
  ¿Tú qué prefieres?"

  Si confirma que quiere salir él:
  "¡Perfecto! Justo eso es lo que recomendamos en ConectaPro para potenciar tu marca personal ✅"

▸ PREGUNTA EXPLÍCITA POR LA OFICINA
  Responde SIEMPRE con este formato exacto, texto plano sin markdown:

  La oficina de Conecta Pro está aquí 📍

  Google Maps:
  https://maps.app.goo.gl/zUxkMk9nRupxX6jq6?g_st=ic

▸ PREGUNTA POR TIKTOK O REDES SOCIALES
  - TikTok: da solo el nombre: @marketero7. NUNCA inventes una URL.
  - Otras redes: di que están en TikTok como @marketero7. No des links no confirmados.

═══════════════════════════════════════
CLASIFICACIÓN (campos booleanos)
═══════════════════════════════════════

Marca solo lo que corresponda al ÚLTIMO mensaje del usuario:

- is_greeting: true solo si el mensaje es un saludo o primer contacto sin pregunta concreta.
- explicit_resend_request: true si pide explícitamente reenviar material ("mándame de nuevo",
  "no me llegó", "no puedo verlo", "reenvíame el flyer", "pásame otra vez la imagen").
- payment_confirmation: false siempre — no hay proceso de pago activo.
- intents.course_flyer: true SOLO si el usuario pregunta explícitamente por los cursos (fechas,
  contenido, capacitación, clases de CapCut, "¿qué cursos tienen?", etc.).
  FALSE en el saludo inicial — el cliente aún no ha pedido info de cursos.
  FALSE si el usuario pregunta solo por paquetes de producción.
- intents.location_video: false siempre — no aplica actualmente.
- intents.payment_qr: false siempre — no hay proceso de pago activo.
- intents.service_packages: true cuando pregunta por servicios, paquetes de producción, grabación,
  edición para su negocio, dron, o cantidad no estándar de videos.
  FALSE si el flujo es exclusivamente de cursos.
- service_intake_requested: true SOLO cuando incluyas el formulario de leads en tu respuesta
  (intención clara de contratar paquetes). NO lo marques para consultas generales ni cursos.

REGLA DE ORO — SEPARACIÓN DE FLUJOS:
  Los dos flujos activos (cursos, paquetes de producción) son canales independientes.
  NUNCA los mezcles en el mismo mensaje.
  course_flyer solo para cursos.
  service_packages solo para paquetes de producción.
  La promo de 50 Bs ya NO existe — nunca la ofrezcas. Solo si el cliente la menciona
  explícitamente, informa que ya no está disponible (cupos agotados).
`;

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

  // Imagen entrante (posible comprobante de pago): usar el caption si viene,
  // o un texto centinela para que el mensaje no se descarte aguas abajo.
  if (message?.image || message?.type === "image") {
    const caption = message?.image?.caption;
    if (typeof caption === "string" && caption.trim()) return caption.trim();
    return "📷 Imagen recibida";
  }

  // Documento/PDF entrante (posible comprobante de pago): mismo tratamiento
  // que la imagen, usando el caption del documento si viene.
  if (message?.document || message?.type === "document") {
    const caption = message?.document?.caption;
    if (typeof caption === "string" && caption.trim()) return caption.trim();
    return "📄 Documento recibido";
  }

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

  // Reacciones de WhatsApp (emoji sobre un mensaje): no son un mensaje del
  // usuario. Se ignoran para que el bot no responda repitiendo el contexto.
  const messageType = event.message?.type;
  if (messageType === "reaction" || event.message?.reaction) {
    console.log("reaction message ignored", {
      conversationId: event.conversation?.id ?? null,
      messageId: event.message?.id ?? null,
      emoji: event.message?.reaction?.emoji ?? null,
    });
    return null;
  }

  const from = event.message?.from ?? "";
  const text = extractMessageText(event.message, event.conversation);
  const isImage = Boolean(event.message?.image) || event.message?.type === "image";
  const isDocument =
    Boolean(event.message?.document) || event.message?.type === "document";
  const messageId = event.message?.id;
  const conversationId = event.conversation?.id ?? from;
  const contactName = event.conversation?.contact_name ?? null;
  const messageTimestamp = parseKapsoTimestamp(event.message?.timestamp);

  if (!from || !text) return null;

  return {
    from,
    text,
    isImage,
    isDocument,
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

async function saveInboundMessage(
  message: IncomingMessage,
): Promise<{ saved: boolean; createdAt: string | null }> {
  const supabase = getSupabaseClient();

  const { data, error: messageError } = await supabase
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
    })
    .select("created_at")
    .single();

  if (messageError) {
    if (messageError.code === "23505") {
      console.log("duplicate inbound message ignored", message.messageId);
      return { saved: false, createdAt: null };
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

    return { saved: false, createdAt: null };
  }

  return { saved: true, createdAt: data?.created_at ?? null };
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
  failed?: boolean;
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

    // Falla cerrada: si no se puede confirmar el estado real de pausa, se
    // trata como pausado para no arriesgar responder durante una pausa real.
    return {
      paused: true,
      expired: false,
      failed: true,
      reason: "pause_state_check_failed",
    };
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
    .filter((message) => message.content.trim().length > 0)
    // Excluir marcadores internos ([MEDIA_SENT...], [LOCATION_...]) para no
    // ensuciar el contexto del LLM; el estado de "ya enviado" lo resuelve el dedup.
    .filter((message) => !/^\[(MEDIA_SENT|LOCATION_)/.test(message.content.trim()));
}

async function getNewestInboundMessage(
  conversationId: string | undefined,
  excludeMessageId: string | undefined,
  afterCreatedAt: string | null,
): Promise<{ kapso_message_id: string | null; created_at: string | null } | null> {
  if (!conversationId) return null;

  const supabase = getSupabaseClient();

  let query = supabase
    .from("kapso_messages")
    .select("kapso_message_id, created_at")
    .eq("kapso_conversation_id", conversationId)
    .eq("direction", "inbound")
    .order("created_at", { ascending: false })
    .limit(1);

  if (excludeMessageId) {
    query = query.neq("kapso_message_id", excludeMessageId);
  }
  if (afterCreatedAt) {
    query = query.gt("created_at", afterCreatedAt);
  }

  const { data, error } = await query.maybeSingle();

  if (error) {
    console.error("supabase select newest inbound failed", error);
    return null;
  }

  return data ?? null;
}

const AssistantTurnSchema = z.object({
  reply: z.string(),
  is_greeting: z.boolean(),
  explicit_resend_request: z.boolean(),
  payment_confirmation: z.boolean(),
  service_intake_requested: z.boolean(),
  intents: z.object({
    course_flyer: z.boolean(),
    location_video: z.boolean(),
    payment_qr: z.boolean(),
    service_packages: z.boolean(),
  }),
});

type AssistantTurn = z.infer<typeof AssistantTurnSchema>;

const FALLBACK_ASSISTANT_TURN: AssistantTurn = {
  reply:
    "¡Hola! Somos ConectaPro😊 ¿En qué puedo ayudarte hoy? Si te interesa, tenemos cursos (disponibles nuevas fechas de julio pronto) *servicios de grabación y edición de video para negocios o tu marca personal*",
  is_greeting: false,
  explicit_resend_request: false,
  payment_confirmation: false,
  service_intake_requested: false,
  intents: {
    course_flyer: false,
    location_video: false,
    payment_qr: false,
    service_packages: false,
  },
};

async function generateAssistantTurn(params: {
  history: HistoryMessage[];
  extraContext?: string;
  conversationId?: string;
  messageId?: string;
  phone?: string;
}): Promise<AssistantTurn> {
  try {
    const result = await generateText({
      model: openai(process.env.OPENAI_MODEL ?? "gpt-4o-mini"),
      system: params.extraContext
        ? `${SYSTEM_PROMPT}\n\nContexto adicional para este mensaje:\n${params.extraContext}`
        : SYSTEM_PROMPT,
      messages: params.history.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      temperature: 0.4,
      output: Output.object({ schema: AssistantTurnSchema }),
    });

    const turn = result.output;
    const reply = turn.reply.trim();

    return {
      ...turn,
      reply: reply.length > 0 ? reply : FALLBACK_ASSISTANT_TURN.reply,
    };
  } catch (error) {
    console.error("openai generate turn failed", error);

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

    return FALLBACK_ASSISTANT_TURN;
  }
}

async function hasMediaIntentBeenSent(
  phone: string,
  intent: MediaIntent,
): Promise<boolean> {
  if (!phone) return false;

  const supabase = getSupabaseClient();

  let query = supabase
    .from("kapso_messages")
    .select("id")
    .eq("contact_phone", phone)
    .eq("direction", "outbound");

  // Dedup por teléfono + intent. Para course_flyer también contamos el marcador
  // legacy "[MEDIA_SENT] ..." (sin intent) para no reenviar a quienes ya lo recibieron.
  if (intent === "course_flyer") {
    query = query.or(
      'content.ilike."[MEDIA_SENT:course_flyer]%",content.ilike."[MEDIA_SENT] %"',
    );
  } else {
    query = query.ilike("content", `[MEDIA_SENT:${intent}]%`);
  }

  const { data, error } = await query.limit(1);

  if (error) {
    console.error("supabase check media intent sent failed", error);

    await logSystemEvent({
      level: "error",
      eventType: "supabase_media_check_failed",
      contactPhone: phone,
      errorMessage: error.message,
      metadata: {
        code: error.code,
        details: error.details,
        intent,
      },
    });

    return false;
  }

  return (data ?? []).length > 0;
}

async function getMediaSentStatus(
  phone: string,
): Promise<Record<MediaIntent, boolean>> {
  const status: Record<MediaIntent, boolean> = {
    course_flyer: false,
    location_video: false,
    payment_qr: false,
    service_packages: false,
  };

  if (!phone) return status;

  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("kapso_messages")
    .select("content")
    .eq("contact_phone", phone)
    .eq("direction", "outbound")
    .or('content.ilike."[MEDIA_SENT:%",content.ilike."[MEDIA_SENT] %"');

  if (error) {
    console.error("supabase check media sent status failed", error);

    await logSystemEvent({
      level: "error",
      eventType: "supabase_media_status_check_failed",
      contactPhone: phone,
      errorMessage: error.message,
      metadata: {
        code: error.code,
        details: error.details,
      },
    });

    return status;
  }

  for (const row of data ?? []) {
    const content = String(row.content ?? "");
    const match = content.match(/^\[MEDIA_SENT:([a-z_]+)\]/);

    if (match && match[1] in status) {
      status[match[1] as MediaIntent] = true;
    } else if (content.startsWith("[MEDIA_SENT] ")) {
      // Marcador legacy sin intent: solo existía para course_flyer.
      status.course_flyer = true;
    }
  }

  return status;
}

// Quita acentos/diacríticos y pasa a mayúsculas, para que las regex de
// detección no dependan de cómo el usuario tildó las palabras (é/e, ó/o, etc.).
function normalizeForMatch(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase();
}

// Distancia de edición clásica (Levenshtein), sin dependencias externas.
function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }

  return dp[m][n];
}

// Palabra candidata (solo letras) pegada o seguida de "DE"/espacios y un
// número de 2-4 dígitos. Ej: "PROMO300", "PROMO 300", "PROMO DE 300",
// "PRMO350", "PROMOO350".
const PROMO_CANDIDATE_REGEX = /\b([A-Z]{4,10})\s*(?:DE\s*)?(\d{2,4})(?!\d)/;

const PROMO_KEYWORD_MAX_DISTANCE = 1; // tolerancia contra "PROMO" (5 letras)
const PROMOCION_KEYWORD_MAX_DISTANCE = 2; // tolerancia contra "PROMOCION" (9 letras)

// Detecta si el usuario escribió la palabra clave de promoción (tolerando
// typos comunes) seguida de un número. El número detectado NUNCA se usa
// como precio — solo dispara la detección (ver PRECIO_PROMO_LIVE).
function detectPromoKeyword(text: string): boolean {
  if (!text) return false;

  const match = normalizeForMatch(text).match(PROMO_CANDIDATE_REGEX);
  if (!match) return false;

  const word = match[1];
  return (
    levenshteinDistance(word, "PROMO") <= PROMO_KEYWORD_MAX_DISTANCE ||
    levenshteinDistance(word, "PROMOCION") <= PROMOCION_KEYWORD_MAX_DISTANCE
  );
}

// --- Toggle manual de la promo del live ---------------------------------
// Valores fijos en código a propósito (sin env var, sin columna en BD): el
// equipo los cambia a mano aquí antes/durante cada transmisión live.
// PROMO_LIVE_ACTIVA: false desactiva la promo aunque se detecte la palabra clave.
// PRECIO_PROMO_LIVE: monto oficial (Bs) cuando la promo está activa — ignora
// el número que haya escrito el usuario.
const PROMO_LIVE_ACTIVA = false;
const PRECIO_PROMO_LIVE = 350;

const EXPLICIT_PAYMENT_PHRASES =
  /\b(COMPROBANTE|YA PAGUE|REALICE EL PAGO|HICE EL PAGO|PAGO REALIZADO)\b/;
const VAGUE_SEND_PHRASES = /\b(YA MANDE|YA PASE|YA ENVIE)\b/;

async function hasIntakeFormBeenSent(conversationId?: string): Promise<boolean> {
  if (!conversationId) return false;

  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("kapso_messages")
    .select("id")
    .eq("kapso_conversation_id", conversationId)
    .eq("direction", "outbound")
    .ilike("content", "[INTAKE_FORM_SENT]%")
    .limit(1);

  if (error) {
    console.error("supabase check intake form sent failed", error);

    await logSystemEvent({
      level: "error",
      eventType: "supabase_intake_form_check_failed",
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

async function hasPaymentBeenAcknowledged(conversationId?: string): Promise<boolean> {
  if (!conversationId) return false;

  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("kapso_messages")
    .select("id")
    .eq("kapso_conversation_id", conversationId)
    .eq("direction", "outbound")
    .ilike("content", "%Gracias por el comprobante%")
    .limit(1);

  if (error) {
    console.error("supabase check payment acknowledged failed", error);

    await logSystemEvent({
      level: "error",
      eventType: "supabase_payment_ack_check_failed",
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

async function getActiveMediaAssets(intent: MediaIntent): Promise<MediaAsset[]> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("kapso_media_assets")
    .select("title, url, media_type")
    .eq("business", "conecta-pro")
    .eq("intent", intent)
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
        intent,
      },
    });

    return [];
  }

  return (data ?? [])
    .map((asset): MediaAsset => ({
      title: String(asset.title ?? "Material enviado"),
      url: String(asset.url ?? ""),
      mediaType: asset.media_type === "video" ? "video" : "image",
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

async function sendKapsoVideo(params: {
  phoneNumberId: string;
  to: string;
  videoUrl: string;
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
        type: "video",
        video: {
          link: params.videoUrl,
          ...(params.caption ? { caption: params.caption } : {}),
        },
      }),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Kapso video send failed ${response.status}: ${body}`);
  }
}

async function sendMediaForIntent(params: {
  intent: MediaIntent;
  conversationId?: string;
  phone: string;
  phoneNumberId: string;
  force?: boolean;
}): Promise<boolean> {
  if (!params.force) {
    const alreadySent = await hasMediaIntentBeenSent(params.phone, params.intent);
    if (alreadySent) {
      console.log(
        "media intent already sent, skipping",
        params.intent,
        maskPhone(params.phone),
      );
      return false;
    }
  }

  const assets = await getActiveMediaAssets(params.intent);

  if (assets.length === 0) {
    console.log("no active media assets found for intent", params.intent);
    return false;
  }

  let sentAny = false;

  for (const asset of assets) {
    try {
      if (asset.mediaType === "video") {
        await sendKapsoVideo({
          phoneNumberId: params.phoneNumberId,
          to: params.phone,
          videoUrl: asset.url,
          caption: asset.title,
        });
      } else {
        await sendKapsoImage({
          phoneNumberId: params.phoneNumberId,
          to: params.phone,
          imageUrl: asset.url,
        });
      }

      await saveOutboundMessage({
        conversationId: params.conversationId,
        phone: params.phone,
        content: `[MEDIA_SENT:${params.intent}] ${asset.title}`,
        rawPayload: {
          type: asset.mediaType,
          intent: params.intent,
          title: asset.title,
          url: asset.url,
          source: "kapso_media_assets",
        },
      });

      sentAny = true;
      console.log("Kapso media sent successfully", params.intent, asset.title);
    } catch (error) {
      console.error("kapso media send/save failed", params.intent, asset.title, error);

      await logSystemEvent({
        level: "error",
        eventType: "media_send_failed",
        conversationId: params.conversationId,
        contactPhone: params.phone,
        errorMessage: getErrorMessage(error),
        metadata: {
          intent: params.intent,
          asset_title: asset.title,
          asset_url_present: Boolean(asset.url),
        },
      });
    }
  }

  return sentAny;
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
  let lastMessageCreatedAt: string | null = null;

  for (const message of incomingMessages) {
    try {
      const { saved, createdAt } = await saveInboundMessage(message);
      if (saved) {
        newMessages.push(message);
        if (message === lastMessage) lastMessageCreatedAt = createdAt;
      }
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

  if (pauseState.failed) {
    console.log("bot pause state check failed, skipping reply (fail-closed)", {
      conversationId: lastMessage.conversationId,
    });

    await logSystemEvent({
      level: "warning",
      eventType: "bot_reply_skipped_pause_check_failed",
      conversationId: lastMessage.conversationId,
      messageId: lastMessage.messageId,
      contactPhone: lastMessage.from,
      metadata: {
        reason: "pause_state_check_failed",
      },
    });

    return new Response("pause state check failed, skipping reply", {
      status: 200,
    });
  }

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

  const [history, mediaStatus, paymentAcknowledged, intakeFormSent] = await Promise.all([
    getRecentConversationHistory(lastMessage.conversationId, 12),
    getMediaSentStatus(lastMessage.from),
    hasPaymentBeenAcknowledged(lastMessage.conversationId),
    hasIntakeFormBeenSent(lastMessage.conversationId),
  ]);

  // Palabra clave de promoción del live (PROMO[monto]/PROMOCION[monto], con
  // tolerancia a typos): primero se revisa el mensaje actual; si no hay
  // match, se busca la mención más reciente dentro de la ventana de
  // historial ya cargada (sin queries adicionales). El monto que escriba el
  // usuario NUNCA define el precio final — solo dispara la detección; el
  // precio oficial sale de PRECIO_PROMO_LIVE cuando PROMO_LIVE_ACTIVA = true.
  let promoKeywordDetected = detectPromoKeyword(lastMessage.text);
  if (!promoKeywordDetected) {
    for (let i = history.length - 1; i >= 0; i--) {
      const candidate = history[i];
      if (candidate.role !== "user") continue;
      if (detectPromoKeyword(candidate.content)) {
        promoKeywordDetected = true;
        break;
      }
    }
  }

  const normalizedLastMessageText = normalizeForMatch(lastMessage.text);
  const hasExplicitPaymentPhrase = EXPLICIT_PAYMENT_PHRASES.test(normalizedLastMessageText);
  const hasVagueSendPhraseOnly =
    VAGUE_SEND_PHRASES.test(normalizedLastMessageText) &&
    !lastMessage.isImage &&
    !lastMessage.isDocument &&
    !hasExplicitPaymentPhrase;

  // Estado real (ground truth del backend) de qué ya se envió a este teléfono.
  // Reemplaza la inferencia del LLM sobre el historial de texto.
  const contextParts: string[] = [
    [
      "Estado real (ground truth del backend) de materiales ya enviados a este usuario:",
      `- course_flyer: ${mediaStatus.course_flyer ? "YA enviado antes" : "NUNCA enviado"}`,
      `- service_packages: ${mediaStatus.service_packages ? "YA enviado antes" : "NUNCA enviado"}`,
      "Confía en este estado (no en lo que infieras del historial de mensajes) para saber si algo ya se envió.",
      ...(mediaStatus.course_flyer
        ? ["Como course_flyer YA fue enviado: no anuncies los flyers de cursos como si fuera la primera vez. Asume que ya se compartieron, salvo que el usuario los pida explícitamente de nuevo."]
        : []),
      ...(mediaStatus.service_packages
        ? ["Como service_packages YA fue enviado: no presentes los paquetes como si fuera la primera vez. Responde asumiendo que ese material ya fue compartido antes, salvo que el usuario lo pida explícitamente de nuevo."]
        : []),
    ].join("\n"),
  ];

  // Comprobante de pago: solo se trata como confirmación válida si (a) es
  // imagen/PDF y ya se envió el QR antes, o (b) el texto usa una frase
  // explícita de pago. Frases vagas ("ya mandé/pasé/envié") sin archivo NO
  // cuentan como comprobante.
  if (lastMessage.isImage || lastMessage.isDocument) {
    const mediaLabel = lastMessage.isDocument ? "un DOCUMENTO/PDF" : "una IMAGEN";
    contextParts.push(
      mediaStatus.payment_qr
        ? `El último mensaje del usuario es ${mediaLabel} y ya se le envió antes el QR de pago. Trátalo como un posible comprobante: marca payment_confirmation=true y responde exactamente: "¡Gracias por el comprobante! 😊 Vamos a verificar el pago y te confirmaremos tu cupo pronto." No lo trates como pedido de otro material.`
        : `El último mensaje del usuario es ${mediaLabel} y todavía NO se le ha enviado el QR de pago. No asumas que es un comprobante: pídele contexto con amabilidad sobre en qué puede ayudarle ese archivo y no marques payment_confirmation.`,
    );
  } else if (hasExplicitPaymentPhrase) {
    contextParts.push(
      'El último mensaje del usuario usa una frase explícita de confirmación de pago ("comprobante", "ya pagué", "realicé el pago" o similar). Puedes marcar payment_confirmation=true si corresponde según el resto de la conversación.',
    );
  } else if (hasVagueSendPhraseOnly) {
    contextParts.push(
      'El último mensaje del usuario dice algo como "ya mandé"/"ya mande"/"ya pasé"/"ya pase"/"ya envié"/"ya envie" pero SIN adjuntar imagen/PDF/documento y SIN una frase explícita de pago ("comprobante", "ya pagué", "realicé el pago", "hice el pago"). Esto NO es un comprobante. NO marques payment_confirmation y NO digas "gracias por el comprobante" ni nada que suene a que ya recibiste o verificaste un archivo. Responde pidiendo con amabilidad que envíe la imagen o el PDF del comprobante, por ejemplo: "Para confirmar tu pago necesito que me envíes la imagen o el PDF de tu comprobante 😊."',
    );
  }

  if (paymentAcknowledged) {
    contextParts.push(
      'Ya se le agradeció el comprobante de pago anteriormente en esta conversación (el backend ya tiene una respuesta con "Gracias por el comprobante" guardada). NO repitas esa plantilla de agradecimiento; si insiste, responde algo breve como "Ya lo tenemos en revisión, en breve te confirmamos tu cupo 😊".',
    );
  }

  if (intakeFormSent) {
    contextParts.push(
      'El formulario de recopilación de datos para planes de producción/grabación YA fue enviado en esta conversación. NO lo repitas (a menos que el cliente lo pida explícitamente de nuevo). Si el cliente ya envió todos los campos, agradece y confirma que un asesor se comunicará. Si aún faltan campos, guíalo amablemente para completarlos sin repetir el formulario completo.',
    );
  }

  const extraContext = contextParts.join("\n\n");

  const newerInbound = await getNewestInboundMessage(
    lastMessage.conversationId,
    lastMessage.messageId,
    lastMessageCreatedAt,
  );

  if (newerInbound) {
    await logSystemEvent({
      level: "info",
      eventType: "bot_reply_skipped_newer_inbound",
      conversationId: lastMessage.conversationId,
      messageId: lastMessage.messageId,
      contactPhone: lastMessage.from,
      metadata: {
        current_kapso_message_id: lastMessage.messageId ?? null,
        current_created_at: lastMessageCreatedAt,
        newer_kapso_message_id: newerInbound.kapso_message_id,
        newer_created_at: newerInbound.created_at,
      },
    });

    return new Response("newer inbound message exists, skipping stale reply", {
      status: 200,
    });
  }

  await logSystemEvent({
    level: "info",
    eventType: "assistant_generation_started",
    conversationId: lastMessage.conversationId,
    messageId: lastMessage.messageId,
    contactPhone: lastMessage.from,
  });

  const generationStartedAt = Date.now();

  const turn = await generateAssistantTurn({
    history,
    extraContext,
    conversationId: lastMessage.conversationId,
    messageId: lastMessage.messageId,
    phone: lastMessage.from,
  });

  const replyText = turn.reply;

  try {
    await kapso.messages.sendText({
      phoneNumberId,
      to: lastMessage.from,
      body: replyText,
    });

    console.log("Kapso SDK text sent successfully");

    await logSystemEvent({
      level: "info",
      eventType: "reply_sent",
      conversationId: lastMessage.conversationId,
      messageId: lastMessage.messageId,
      contactPhone: lastMessage.from,
      metadata: {
        duration_ms: Date.now() - generationStartedAt,
      },
    });
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

  const mediaConversationId =
    lastMessage.conversationId ?? firstMessage.conversationId;

  // Conjunto de intents a enviar este turno, combinando la clasificación del LLM
  // con reglas deterministas (primer contacto y reenvío explícito).
  const intentsToSend = new Set<MediaIntent>();
  const forcedIntents = new Set<MediaIntent>();

  if (turn.intents.course_flyer) intentsToSend.add("course_flyer");
  if (turn.intents.location_video) intentsToSend.add("location_video");
  if (turn.intents.payment_qr) intentsToSend.add("payment_qr");
  if (turn.intents.service_packages) intentsToSend.add("service_packages");

  // Reenvío explícito: forzar (anular dedup) los intents detectados este turno.
  if (turn.explicit_resend_request) {
    for (const intent of intentsToSend) forcedIntents.add(intent);
  }

  const sentIntents: MediaIntent[] = [];

  try {
    await saveOutboundMessage({
      conversationId: mediaConversationId,
      phone: lastMessage.from,
      content: replyText,
    });

    await markReplyLockSent({
      lastMessageId: lastMessage.messageId,
      conversationId: lastMessage.conversationId,
      phone: lastMessage.from,
      responseText: replyText,
    });

    if (turn.service_intake_requested) {
      await saveOutboundMessage({
        conversationId: mediaConversationId,
        phone: lastMessage.from,
        content: "[INTAKE_FORM_SENT] formulario de datos para paquetes de producción",
        rawPayload: { type: "intake_form", source: "service_packages_intake" },
      });
    }

    for (const intent of MEDIA_SEND_ORDER) {
      if (!intentsToSend.has(intent)) continue;

      const sent = await sendMediaForIntent({
        intent,
        conversationId: mediaConversationId,
        phone: lastMessage.from,
        phoneNumberId,
        force: forcedIntents.has(intent),
      });

      if (sent) sentIntents.push(intent);
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
      is_greeting: turn.is_greeting,
      explicit_resend_request: turn.explicit_resend_request,
      payment_confirmation: turn.payment_confirmation,
      service_intake_requested: turn.service_intake_requested,
      detected_intents: turn.intents,
      sent_intents: sentIntents,
    },
  });

  return new Response("ok", { status: 200 });
}
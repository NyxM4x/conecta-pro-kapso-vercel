import { WhatsAppClient } from "@kapso/whatsapp-cloud-api";
import { createClient } from "@supabase/supabase-js";
import { after } from "next/server";
import { runUnattendedLeadChecks } from "../../../../lib/unattended-leads";
import {
  DUPLICATE_REPLY_WINDOW_MS,
  canSkipAsDuplicate,
  computeReplyWaitMs,
  isSameReply,
} from "../../../../lib/reply-timing";
import {
  extractPayerData,
  getOpenPendingPaymentAlert,
  isPayerDataComplete,
  processPendingPaymentAlerts,
  renderMissingPayerDataReply,
  renderPayerDataReceivedReply,
  renderReceiptReply,
  resolvePaymentReason,
  runPendingPaymentAlertSweep,
  savePendingPaymentAlert,
  sendPaymentAlert,
} from "../../../../lib/payment-alerts";
import type { PayerData, PaymentReason } from "../../../../lib/payment-alerts";
import {
  getChatModel,
  getTopUpUrl,
  getTranscriptionModel,
  isQuotaError,
  resolveAiProvider,
  resolveTranscriptionTargets,
} from "../../../../lib/ai-provider";
import type { TranscriptionTarget } from "../../../../lib/ai-provider";
import { isCoursePaymentContext } from "../../../../lib/payment-context";
import { generateText, Output, experimental_transcribe as transcribe } from "ai";
import { z } from "zod";
import {
  sendTelegramNotification,
  sendDeveloperAlert,
  escapeTelegramHtml,
  buildTelegramBody,
} from "../../../../lib/telegram";
import {
  renderCourseContext,
  hasActiveLocationOverride,
  hasSellableCourse,
  getInProgressCourses,
  getDoorSaleCourses,
  getActiveCourses,
  formatCourseDate,
  renderCourseDayDoorReply,
  COURSES,
  detectMentionedCourses,
  formatNowInBolivia,
  hasCourseWithDate,
} from "../../../../lib/courses";
import {
  LINK_BUTTON_RESEND_HOURS,
  LINK_SENT_MARKER_PREFIX,
  PACKAGES_BUTTON_TEXT,
  PACKAGES_FORM_BUTTON_TEXT,
  OFFICE_BUTTON_TEXT,
  OFFICE_COURSE_BUTTON_TEXT,
  SITE_VISIT_MARKER_PREFIX,
  WEB_LEAD_MARKER_PREFIX,
  canAttachButtonToReply,
  decideLinkButton,
  detectButtonTextKind,
  detectSiteLinkRequest,
  getLeadLinkSecret,
  getSiteBaseUrl,
  isSitePrefilledMessage,
  linkSentMarker,
  packageSlug,
  renderCoursesButtonText,
  renderNoCourseDatesText,
  replyMentionsButton,
} from "../../../../lib/site-links";
import type { LinkButton, LinkButtonKind } from "../../../../lib/site-links";
import { MAPS_OFICINA } from "../../../../lib/locations";
import {
  getActivePromoAmounts,
  getActivePromoVideoCounts,
  renderPromoContext,
  renderReliefContext,
  mentionsReliefCampaign,
  getReliefClosedReply,
  getExpiredPromoAmounts,
  mentionsExpiredVideoPromo,
  acknowledgesExpiredVideoPromo,
  renderExpiredVideoPromoContext,
  EXPIRED_VIDEO_PROMO_REPLY,
} from "../../../../lib/promos";
import {
  MEDIA_RESEND_WINDOW_HOURS,
  resolvePromoIntents,
  shouldResendMedia,
} from "../../../../lib/media-intents";
import { isMediaAssetInWindow } from "../../../../lib/media-assets";
import {
  getIncomingAudioMediaUrl,
  isIncomingAudioMessage,
} from "../../../../lib/incoming-audio";
import {
  VIDEO_PACKAGES,
  PACKAGE_SIZES,
  PACKAGE_PRICES,
  PACKAGE_NAME_MATCH_REGEX,
  MIN_PACKAGE_VIDEOS,
  MAX_PACKAGE_VIDEOS,
  classifyVideoQuantity,
  detectDroneRequest,
  detectRequestedVideoCount,
  findPackageByName,
  renderDroneRule,
  renderPackagesWithDrone,
  renderPackageCatalog,
  joinList,
  renderPackageIncludes,
  SOCIAL_NETWORKS,
  renderSocialNetworksRule,
  renderPackageNameExamples,
  renderPackageNamesList,
  renderPackageNameMap,
  renderPackagePriceMap,
  renderPackagePrices,
  renderPackageSizes,
  renderQuantityExamples,
} from "../../../../lib/packages";
import {
  normalizeForMatch,
  containsExactNumber,
  SERVICE_PACKAGES_KEYWORDS,
  COURSE_KEYWORDS,
  APPOINTMENT_KEYWORDS,
  AI_AGENT_KEYWORDS,
  mentionsExpiredEditPromo,
  mentionsPriorAgreement,
  containsIncomingLink,
  detectOfficeVisit,
  mentionsRecruitment,
  detectEditingRequest,
  hasBusinessVocabulary,
  isClosingThanksOnly,
  mentionsCourse,
  detectCoursePaymentRequest,
} from "../../../../lib/keywords";
import type { CoursePaymentRequest } from "../../../../lib/keywords";

type IncomingMessage = {
  from: string;
  text: string;
  isImage?: boolean;
  isDocument?: boolean;
  isAudio?: boolean;
  // true si el audio NO se pudo transcribir: el bot no sabe qué dijo el cliente.
  audioUnreadable?: boolean;
  // Referencia al archivo adjunto, para poder descargarlo y verificar con visión
  // si una imagen es realmente un comprobante de pago.
  mediaId?: string | null;
  mediaUrl?: string | null;
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
  | "service_packages"
  | "service_packages_promo"
  | "ai_agent_flyer";

type MediaAsset = {
  title: string;
  url: string;
  mediaType: "image" | "video";
};

// Orden en que se envían los intents cuando aplica más de uno en un mismo turno.
const MEDIA_SEND_ORDER: MediaIntent[] = [
  "course_flyer",
  "service_packages_promo",
  "service_packages",
  "ai_agent_flyer",
  "location_video",
  "payment_qr",
];

// Materiales que salen ANTES del texto de la respuesta. Las 2 imágenes de los paquetes
// muestran precios, videos y lo que incluye cada uno; el texto que las sigue ("¿Cómo
// trabajamos...?", el formulario) ya no repite el catálogo. El resto sale después.
const MEDIA_BEFORE_REPLY: MediaIntent[] = ["service_packages"];

// Materiales que pertenecen a la misma LÍNEA de negocio. La promo temporal de video no
// es una cuarta línea: es material de la LÍNEA B, así que abre y hereda las reglas de
// service_packages (continuidad de contexto, cambio de línea) en vez de esquivarlas.
const LINE_MEDIA_INTENTS: Record<
  "course_flyer" | "service_packages" | "ai_agent_flyer",
  MediaIntent[]
> = {
  course_flyer: ["course_flyer"],
  service_packages: ["service_packages", "service_packages_promo"],
  ai_agent_flyer: ["ai_agent_flyer"],
};

// Ventana de agrupación: al recibir un mensaje se espera a que el cliente termine de
// escribir antes de generar la respuesta (REPLY_WAIT_SECONDS, 120 s por defecto; ver
// lib/reply-timing.ts). Si en ese lapso manda otro mensaje, este turno se descarta y
// responde el webhook del mensaje más nuevo — con todos los mensajes ya en el historial.
// Evita la doble respuesta cuando el cliente escribe en ráfaga y, sobre todo, ahorra
// mensajes de WhatsApp: desde octubre de 2026 Meta cobra por cada uno.

// La espera (hasta 120 s) vive dentro de la función, pero DESPUÉS de responderle a Kapso
// (ver POST y `after`), así que el webhook nunca queda colgado. Con fluid compute el tope
// de Vercel es de 300 s en cualquier plan; 180 deja aire para la espera + OpenAI + envío.
export const maxDuration = 180;

type SystemLogLevel = "info" | "warning" | "error" | "critical";

// Las dos ubicaciones viven en lib/locations.ts. Aquí solo se usa la de la OFICINA:
// la del curso ya no se interpola en el prompt, la trae el contexto de cursos vigentes
// (lib/courses.ts), porque una fecha puntual puede dictarse excepcionalmente en otro lado.

// Editor externo que atiende la EDICIÓN NETA (el cliente trae sus videos crudos).
// Es un servicio distinto de los paquetes de producción: aparece en varios puntos del
// prompt, así que vive aquí para que un cambio de número sea de una sola línea.
const EDITOR_PHONE = "74271406";

// Campos del formulario de leads (LÍNEA B). Los usan el prompt, el formulario completo y
// la respuesta a quien quiere visitarnos, que pide exactamente los mismos datos. No se pide
// el número: el contacto es el WhatsApp desde el que escribe, que Kapso ya conoce.
const LEAD_INTAKE_FIELDS = `📌 Nombre:
📌 Nombre de tu empresa o emprendimiento:
📌 Cargo dentro de la empresa:
📌 Rubro o sector: (Ej. gastronomía, belleza, moda, salud, etc.)
📌 Instagram o redes sociales:
📌 ¿Qué tipo de contenido te interesa? (Fotos, videos, contenido con creadores, etc.)
📌 ¿Tienes alguna referencia de contenido que te guste? (Opcional)`;

// Introducción del formulario de leads cuando el cliente ya mostró interés en un paquete.
const LEAD_INTAKE_INTRO = `¡Perfecto! 🙌 Necesitamos estos datos para que un asesor pueda darte una atención personalizada, estudiando el contenido para ti 📋`;

// Respuesta a la consulta general de paquetes (FLUJO B). Sale DESPUÉS de las 2 imágenes de
// los paquetes, que ya muestran precios, cantidades y lo que incluye cada uno: por eso este
// texto no repite el catálogo (ver MEDIA_BEFORE_REPLY). Texto del cliente, sin cambios
// salvo las negritas de WhatsApp. El backend lo normaliza a esta versión exacta si el
// modelo lo copia con cambios (ver applyExactHowWeWorkText).
const HOW_WE_WORK_INFO = `*¿Cómo trabajamos con nuestros clientes?*

En nuestra agencia de marketing trabajamos con una metodología organizada y estratégica para garantizar contenido constante, profesional y con mejores resultados en TikTok.

*1. Forma de pago*

Para iniciar el trabajo solicitamos el 50% de adelanto y el 50% restante al finalizar el servicio acordado.
Esto nos permite organizar la planificación, producción y edición de contenido de manera eficiente.

*2. Días de grabación*

Realizamos grabaciones una vez por semana.
En cada sesión grabamos un mínimo de 4 videos, aunque en muchas ocasiones logramos grabar más contenido dependiendo de la organización y disponibilidad.

La sesión tiene una duración aproximada de 2 a 3 horas, tiempo en el que trabajamos de forma estratégica para aprovechar al máximo cada grabación.

*3. Guiones y planificación*

Nosotros asistimos con los guiones previamente preparados, ideas estructuradas y contenido pensado específicamente para la marca y el tipo de cliente que queremos atraer.

Nuestro objetivo es que el día de grabación sea dinámico, organizado y productivo.

*4. Importancia de la organización*

Es muy importante que el cliente pueda priorizar el horario de grabación y ayudarnos con la organización previa.

Con la experiencia que tenemos trabajando con diferentes negocios, sabemos que muchas veces ocurren situaciones como:

- Productos no disponibles
- Personal ocupado
- Atención a clientes durante la grabación
- Falta de preparación del espacio

Por eso, antes de cada sesión realizamos una coordinación previa para prever todos estos detalles y así evitar retrasos o pérdida de tiempo.

*5. Publicación del contenido*

El paquete incluye que nosotros mismos realizamos la publicación de los videos en TikTok.

Esto es importante porque analizamos:

- Horarios estratégicos
- Rendimiento del contenido
- Optimización de publicaciones
- Puntos clave para maximizar resultados

Además, trabajamos con herramientas como TikTok Ads, que nos ayudan a impulsar el alcance y llegar a más personas de manera más efectiva.

*6. Comunicación y revisión de videos*

Creamos un grupo de trabajo con cada cliente para mantener una comunicación rápida y organizada.

En ese grupo:

- Enviamos los videos grabados
- Compartimos avances
- Mandamos los videos antes de publicar
- Revisamos posibles correcciones

Si el cliente desea realizar algún ajuste, lo corregimos antes de subir el contenido.

*Nuestro objetivo*

Más que solo grabar videos, buscamos convertirnos en un equipo estratégico para la marca, creando contenido constante, organizado y enfocado en generar resultados reales.

Si deseas elegir un paquete, avísanos y te tomamos los datos para que un asesor se comunique contigo 😊`;

// Primera línea de HOW_WE_WORK_INFO, ya normalizada: marca que el texto salió en la
// conversación (ver detectPackagesPresented y applyExactHowWeWorkText).
const HOW_WE_WORK_MARKER = "COMO TRABAJAMOS CON NUESTROS CLIENTES";

// Campos del formulario de la LÍNEA C (agente de IA).
const AI_AGENT_INTAKE_FIELDS = `📌 Nombre:
📌 Nombre de tu negocio y rubro:
📌 ¿Cuántos mensajes reciben al día aproximadamente?
📌 ¿Tienen una sola sucursal o varias?`;

// VISITA A LA OFICINA. El bot ya no invita a pasar ni anota un día y una hora: no sabe si
// habrá alguien para atender. Ahora tampoco pide los datos por chat: manda el botón "Agendar
// visita" a la página /oficina, que tiene el mismo texto y el formulario de cada caso
// (lib/office-form.ts). El asesor se entera cuando el cliente envía sus datos ahí.
const OFFICE_VISIT_INTAKE_REPLY = OFFICE_BUTTON_TEXT;

// Mismo texto para un cliente del agente de IA: la página le pide los datos de la LÍNEA C.
const OFFICE_VISIT_AI_AGENT_REPLY = OFFICE_BUTTON_TEXT;

// Visita por un CURSO: la página no pide datos de negocio, solo su nombre y sus dudas.
const OFFICE_VISIT_COURSE_REPLY = OFFICE_COURSE_BUTTON_TEXT;

// Cuando ya dejó sus datos (o ya se le pidieron) y vuelve a hablar de venir a la oficina.
const OFFICE_VISIT_PENDING_CALL_REPLY = `Antes de reunirnos en la oficina, un asesor te llamará para coordinar el día y la hora y conocer más de tu negocio 📞 Así nos aseguramos de que alguien esté disponible para atenderte 😊`;

// Texto EXACTO del Flujo C — consulta general del agente de IA. Centralizado para que la
// red de seguridad pueda enviarlo textual cuando el LLM devuelve el saludo genérico pese a
// haber intención clara de agente de IA. Ya no ofrece Zoom: el siguiente paso es una
// llamada del asesor por WhatsApp, y el bot junta los datos para esa llamada.
// NUNCA incluir un precio aquí: la cotización es personalizada y el flyer muestra el estimado.
const AI_AGENT_INFO = `¡Claro! 🤖 En Conecta Pro implementamos agentes de IA para negocios: un asistente que atiende tu WhatsApp las 24 horas, responde las consultas de tus clientes, envía tu información y captura los datos de clientes potenciales automáticamente. Es el mismo tipo de agente que te está atendiendo ahora 😊

La cotización es personalizada, porque depende de tu negocio. Los precios que ves en el flyer son un estimado para negocios con alto flujo de mensajes (por ejemplo con varias sucursales), así que en tu caso puede variar.

Un asesor te llama por WhatsApp para conocer cómo atiendes hoy los mensajes de tu negocio y explicarte cómo se aplicaría el agente en tu caso 📞 Para que te llame con todo listo, déjame estos datos 📋

${AI_AGENT_INTAKE_FIELDS}`;


// EDICIÓN AMBIGUA: pregunta antes de mandar paquetes o el número del editor.
const EDITING_CLARIFY_REPLY = `¡Claro! 😊 Para orientarte bien, cuéntame qué necesitas:

🎬 *Un paquete completo:* nosotros preparamos los guiones, grabamos, editamos y publicamos tus videos.
✂️ *Solo edición:* ya tienes tus videos grabados y solo quieres que te los editemos.

¿Cuál de las dos buscas?`;

const SYSTEM_PROMPT = `
Eres la asistente de WhatsApp de Conecta Pro. Hablas en nombre del equipo, en un tono cercano, entusiasta
y natural — como alguien del equipo respondiendo por WhatsApp, no como un bot formal. Trata al usuario de "tú".

═══════════════════════════════════════
PARA QUÉ EXISTES (tu objetivo)
═══════════════════════════════════════

Existes para CONCRETAR clientes de grabación y edición de video: llevar a quien escribe desde el
primer "hola" hasta que deja sus datos para que un asesor cierre la venta. Todo lo demás (cursos,
agente de IA, ubicación, horarios) lo atiendes bien, pero el embudo que justifica tu existencia es
este, y tiene cuatro pasos:

  1. INFORMAR: precios, paquetes, qué incluye, cómo se trabaja, dron, zona de cobertura.
  2. GUIAR: resolver sus dudas y llevarlo a elegir — sin fricción y sin preguntas de relleno.
  3. PEDIR LOS DATOS: enviar el formulario de leads en cuanto haya intención suficiente (una
     elección de paquete, un "me interesa", un "quiero contratar", una cantidad a coordinar).
  4. CERRAR: cuando el cliente manda sus datos, confirmarle que un asesor ya los tiene y se
     comunicará con él lo antes posible. Ese es el LEAD CERRADO: tu trabajo bien hecho.

Hasta el paso 4 NO abandonas la conversación. Aunque un aviso interno ya haya salido al asesor,
aunque el cliente pida algo fuera del catálogo, aunque haya que explicarle lo mismo otra vez: sigues
acompañándolo hasta que deja sus datos o hasta que él mismo pide hablar con una persona. Un chat
que se enfría sin llegar al paso 3 es un lead perdido, y perder leads es exactamente lo que no
puede pasar.

Cuando SÍ te detienes (y solo entonces) está explicado en "CUANDO EL CASO PASA A UNA PERSONA".

═══════════════════════════════════════
INFORMACIÓN CONOCIDA
═══════════════════════════════════════

Conecta Pro tiene TRES líneas activas:

LÍNEA A — Cursos:
- Conecta Pro dicta cursos presenciales en Santa Cruz de la Sierra, Bolivia: Curso de Creación de
  Contenido y Curso de Edición Persuasiva en CapCut Pro (también le dicen "curso de CapCut" o "de
  edición en CapCut": es el mismo).
- ⚠️ FECHAS, PRECIOS Y UBICACIÓN: NUNCA los recites de memoria. Llegan en el contexto adicional de
  cada mensaje bajo "CURSOS — FECHAS Y PRECIOS VIGENTES" — esa es la ÚNICA fuente de verdad, se
  actualiza sola y solo incluye los cursos con fecha vigente. Si un curso no aparece ahí como
  vigente, no lo anuncies, no des su fecha, ni su precio, ni su ubicación, ni prometas una fecha
  que no esté confirmada en ese bloque.
- ⚠️ REGLA CRÍTICA — LA UBICACIÓN DEL CURSO NUNCA LA ELIGES TÚ: cada curso vigente trae su propia
  línea "Ubicación de ESTE curso" en ese bloque. Copia ESE link tal cual (texto plano, NUNCA
  markdown), siempre. NUNCA lo deduzcas, NUNCA lo recites de memoria y NUNCA uses el link de la
  oficina por tu cuenta para un curso: el link de la oficina es la sede de Conecta Pro (reuniones
  que coordina un asesor), y son flujos distintos. Por defecto los cursos NO se dictan en la oficina; si por excepción
  alguna fecha sí lo fuera, el propio bloque de cursos vigentes te lo dirá con todas las letras —
  no lo asumas nunca por tu cuenta. NUNCA escribas un link de Maps que no venga de ese bloque o de
  la sección UBICACIÓN OFICINA.
  Al dar la ubicación de un curso marca intents.location_video = true para que el sistema envíe el
  video de cómo llegar, SALVO que el bloque de cursos vigentes indique lo contrario para ese curso.
- CONTENIDO del Curso de Creación de Contenido (temas CONFIRMADOS, puedes afirmarlos con
  seguridad):
  • ALGORITMO DE TIKTOK, incluido el algoritmo de TIKTOK LIVE (transmisiones en vivo): cómo
    funciona y cómo aprovecharlo para que el contenido y los lives lleguen a más gente.
  • Creación de contenido para redes sociales en general: cómo planificar y grabar contenido que
    funcione en TikTok e Instagram.
  Si el cliente pregunta si se enseña el algoritmo de TikTok o de TikTok LIVE, la respuesta es SÍ.
  Confírmalo de forma breve y con entusiasmo, agregando una frase corta de valor (por ejemplo que
  se ve cómo funciona el algoritmo y cómo usarlo a favor en los lives). NO te extiendas en un
  temario largo ni inventes módulos, horarios por tema, certificados ni materiales.
- Curso de Edición Persuasiva en CapCut Pro (datos CONFIRMADOS, puedes afirmarlos con seguridad):
  • De qué se trata: edición persuasiva DESDE EL CELULAR con CapCut, para crear videos más
    profesionales y dinámicos que ayuden a VENDER en redes sociales.
  • Modalidad: 100% PRESENCIAL y PRÁCTICA. No es para sentarse solo a mirar: cada alumno edita en
    su propio celular y aplica las herramientas mientras aprende.
  • Duración: unas 5 horas (entre 4 y 5 horas aproximadamente), en un solo día.
  • Qué traer: su celular con CapCut instalado y su cuenta iniciada. Se RECOMIENDA tener CapCut
    Pro activo para poder usar todas las funciones que se enseñan. Si preguntan si es obligatorio,
    responde que es lo recomendado para aprovechar todas las funciones; no digas que sin Pro no
    puede asistir.
  • Temario: cortes precisos y dinámicos; subtítulos que llamen la atención; textos persuasivos
    dentro del video; animaciones y efectos; efectos de sonido; uso correcto de la música;
    transiciones profesionales; cómo darle ritmo a los videos; técnicas para mantener la atención
    del espectador; cómo estructurar una edición enfocada en vender.
  • BONUS de edición avanzada: poner texto detrás de una persona; eliminar fondos; poner
    imágenes, videos y elementos detrás del sujeto; trucos para una edición más profesional y
    llamativa.
  • Resultado: salir sabiendo transformar un video sencillo en un contenido dinámico, persuasivo y
    listo para redes sociales.
  NO inventes certificados, materiales, cupos ni temas fuera de esta lista.
- REGLA CRÍTICA SOBRE TEMAS DEL CURSO — NUNCA NIEGUES UN TEMA: si el cliente pregunta por un tema
  que NO está en la lista confirmada de ESE curso (ej. monetización, fotografía, Instagram Reels,
  publicidad paga), NUNCA respondas que el curso "no lo incluye" ni que "no tiene un enfoque
  específico" en eso — negar un tema hace perder la venta y además no lo sabes con certeza.
  En ese caso responde en POSITIVO y breve con el enfoque de ESE curso (Creación de Contenido:
  creación de contenido y el algoritmo de TikTok; CapCut: edición persuasiva desde el celular para
  vender en redes), y que un asesor le confirma el detalle del temario. Ejemplo de tono:

  "El curso se enfoca en creación de contenido y en el algoritmo de TikTok 🎯 Un asesor te confirma el detalle del temario. Si quieres asegurar tu cupo, te paso el QR de pago 😊"

  Marca advisor_handoff = true con advisor_handoff_reason = "course_topic_unconfirmed" para que el
  asesor confirme el detalle real (el bot SÍ responde en este mismo turno, no se queda en
  silencio: esta notificación no bloquea la respuesta, solo avisa al equipo).
  Afirmar de más y negar de más son AMBOS errores: afirma con seguridad SOLO los temas de la lista
  confirmada, y para el resto usa la respuesta en positivo de arriba sin comprometerte.
- MODALIDAD de los dos cursos: son ÚNICAMENTE PRESENCIALES. NO existen clases virtuales/online y
  NUNCA habrá una fecha en modalidad virtual, aunque el cliente insista o pregunte varias veces.
  Sé claro y amable al respecto, sin prometer una futura versión virtual.
- Hay un QR de pago disponible (almacenado en el sistema) para que el cliente reserve/pague la
  preventa de cualquiera de los dos cursos (el que tenga fecha vigente). El sistema lo envía
  automáticamente cuando corresponde — nunca prometas "te lo mando ahora", usa frases neutras
  ("el QR está disponible para reservar tu cupo").
- Este flujo activa intents.course_flyer = true para que el sistema adjunte el BOTÓN que abre la
  página de cursos (ya no se envían flyers).
- ⚠️ REGLA ABSOLUTA — LOS CURSOS NUNCA USAN EL FORMULARIO DE DATOS: un curso se cierra con el QR de
  pago y, después de pagar, el comprobante + nombre completo + número de celular escritos por el
  chat. Eso es TODO lo que se necesita. El formulario de leads (📌 Nombre, empresa, cargo dentro de
  la empresa, rubro, Instagram, tipo de contenido...) es EXCLUSIVO de los paquetes de grabación y
  edición de la LÍNEA B y NUNCA sale por un curso, en ningún flujo, por ninguna razón. Tampoco le
  pidas su empresa ni su rubro por un curso: no hacen falta y solo estorban. Esta regla vale
  también cuando el cliente dice "me interesa", "quiero ese", "el primero" o "el más económico"
  refiriéndose a un CURSO: eso NO es elegir un paquete, y en ese caso service_intake_requested se
  queda en false.
- Ojo con los NOMBRES de los cursos: "creación de contenido" y "edición en CapCut" contienen las
  palabras "contenido", "edición" y "video", que también aparecen en la LÍNEA B. Que el cliente las
  use NO convierte su mensaje en interés por paquetes: si dice "curso", "taller" o "clase", está en
  la LÍNEA A.

LÍNEA B — Paquetes de producción (servicio principal / embudo principal):
- Conecta Pro ofrece paquetes de grabación y edición de video para negocios y marcas personales.
- Paquetes disponibles (los ÚNICOS con precio cerrado): ${renderPackageCatalog()}.
- RANGO DEL SERVICIO: el paquete más chico es de ${MIN_PACKAGE_VIDEOS} videos y el más grande de
  ${MAX_PACKAGE_VIDEOS}. Que una cantidad no esté en el flyer NO significa que no se pueda hacer:
  de ${MIN_PACKAGE_VIDEOS} videos en adelante — incluidas las cantidades intermedias y las
  MAYORES a ${MAX_PACKAGE_VIDEOS} — el trabajo SÍ se coordina, solo que el precio lo arma un
  asesor humano, no tú (ver flujo "CANTIDAD FUERA DE LOS PAQUETES" más abajo).
- NUNCA inventes ni calcules un precio para una cantidad que no esté en el catálogo, y NUNCA
  respondas que "solo existen" esas cantidades como si no hubiera nada más que conversar: eso
  cierra la puerta a un cliente que ya te dijo cuánto quiere comprar.
- Los paquetes tienen NOMBRE en el flyer: ${renderPackageNameMap()}. Si el cliente menciona un
  nombre (${renderPackageNameExamples()}), está eligiendo ese paquete → es intención clara de
  contratar (enviar el formulario de datos).
- Incluye producción profesional (grabación + edición) orientada a redes sociales (TikTok, Instagram).
- ⚠️ LOS PAQUETES YA NO SE EXPLICAN EN TEXTO POR DEFECTO: al presentar los paquetes, el sistema
  adjunta a tu respuesta corta un BOTÓN que abre la página de paquetes (precios, cantidad de
  videos, lo que incluye cada uno, cómo trabajamos y el formulario de datos). Ya no se envían
  flyers ni el texto largo de "¿Cómo trabajamos con nuestros clientes?". Pero TÚ SIEMPRE CONOCES
  estos datos: si el cliente pregunta cuánto cuesta un paquete, cuántos videos
  trae, cuál tiene dron, qué incluye o cuál le conviene, respóndelo en texto con los datos de esta
  sección, sin mandarlo a "ver la imagen".
- QUÉ MUESTRA CADA FLYER (esto es lo que el cliente ve; responde igual que el flyer):
${renderPackageIncludes("  ")}
  ${renderSocialNetworksRule()}
  Las campañas en Ads con Bs 500 de presupuesto publicitario vienen en el Pro. En el Básico y el
  Normal no figuran: si las pide, un asesor le cotiza cómo sumarlas.
  "Resultados garantizados" es una línea del flyer del Pro: puedes mencionarla, pero NUNCA
  prometas una cifra de ventas, seguidores o vistas.
- CÓMO TRABAJAMOS (datos confirmados, son los del texto "¿Cómo trabajamos con nuestros clientes?"):
  • Forma de pago: 50% de adelanto para iniciar y 50% al finalizar el servicio acordado.
  • Grabación una vez por semana; mínimo 4 videos por sesión (muchas veces más, según la
    organización y disponibilidad); cada sesión dura de 2 a 3 horas.
  • Llegamos con los guiones preparados, ideas estructuradas y contenido pensado para la marca y
    el tipo de cliente que quiere atraer.
  • Antes de cada sesión hay una coordinación previa: el cliente prioriza el horario de grabación
    y deja listo lo necesario (productos disponibles, personal, espacio preparado).
  • Nosotros publicamos los videos en TikTok, analizando horarios estratégicos, rendimiento,
    optimización y puntos clave, con herramientas que ayudan a impulsar el alcance.
  • Grupo de trabajo con cada cliente: ahí van los videos grabados, los avances y los videos
    antes de publicar; si pide un ajuste, se corrige antes de subirlo.
- PUBLICIDAD, MARKETING, MANEJO DE REDES Y COMMUNITY MANAGER = ESTA LÍNEA. Los clientes casi nunca
  dicen "paquete de grabación": piden "publicidad para mi negocio", "¿cuánto cobran por
  publicidad?", "servicios de marketing", "planes de publicidad", "que me promocionen mi negocio",
  "manejo de redes sociales", "un community manager", "que me manejen las redes". TODO eso es
  interés en los paquetes: respóndelo con el FLUJO B (marca intents.service_packages = true), NUNCA
  lo trates como fuera de tema ni lo dejes sin respuesta.
  Lo que SÍ puedes afirmar del manejo de redes: trabajamos ${joinList(SOCIAL_NETWORKS, "y")} en
  CUALQUIER paquete. Llegamos con guiones e ideas, grabamos,
  editamos y publicamos los videos cuidando horarios y rendimiento, con un grupo de trabajo para
  revisar avances. Cualquier otro detalle (responder comentarios o mensajes, diseño, otras redes,
  pauta fuera de lo que dice el flyer del Pro) NO está confirmado: no lo afirmes ni lo niegues —
  di que un asesor le confirma el alcance exacto cuando lo contacte, y sigue llevándolo a elegir
  un paquete / dejar sus datos. NO marques advisor_handoff por esto.
- ⚠️ QUÉ INCLUYE CADA PAQUETE — DATO CERRADO, NO SE DEDUCE:
  ${renderDroneRule()}
  Esta línea es la ÚNICA fuente de verdad sobre el dron. NUNCA digas que un paquete lo
  incluye si aquí no figura, NUNCA digas que "se incluye sin costo adicional" y NUNCA
  afirmes que el precio del paquete se mantiene igual con dron: el precio con dron en un
  paquete que no lo trae NO existe todavía, lo arma un asesor.
- ⚠️ POLÍTICA DE EXTRAS (dron, locución, actores/modelos, fotos, locaciones adicionales,
  más revisiones, cualquier otra cosa que no esté escrita arriba):
  • Si el cliente hace una PREGUNTA GENERAL sobre el equipo o las capacidades de Conecta
    Pro ("¿graban en interiores?", "¿trabajan con marcas?"), respóndele con naturalidad.
  • PERO si el cliente PIDE o CONDICIONA agregar un elemento, servicio o atributo que no
    está explícitamente listado en su paquete, NUNCA confirmes que está incluido ni
    apruebes el costo. Usa el flujo "EL CLIENTE PIDE AGREGAR ALGO AL PAQUETE" de abajo y
    marca advisor_handoff con advisor_handoff_reason = "package_addon" para que se cotice
    esa modificación.
  Inventar aquí no es un detalle: el cliente se queda con una promesa que el asesor
  después tiene que romper delante de él.
- Los precios SÍ pueden recitarse en texto (son estos tres, fijos) cuando el cliente pregunta por
  ellos, los pide en letras o no le quedó claro tras ver los flyers. Por defecto NO los repites al
  presentar los paquetes: ya van en las imágenes. Cualquier duda que no esté en esta sección
  (plazos de entrega, fechas de inicio) la confirma el asesor.
- PERÍODO DE CADA PAQUETE: ${renderPackageCatalog()}. Ojo: NO todos son mensuales; di el
  período de cada uno tal cual (nunca digas que el ${VIDEO_PACKAGES[0].name} es "al mes" si no lo es).
- DISPARADORES POR PRECIO: los montos ${renderPackagePrices()} (Bs) son los precios
  conocidos de los paquetes (${renderPackagePriceMap()}). Si el cliente menciona uno de esos
  montos (ej. "vengo del anuncio de los ${PACKAGE_PRICES[0]}"), viene interesado en paquetes →
  activa este flujo. NO trates estos montos como una cantidad de videos fuera del catálogo (son
  precios, no cantidades).
- Este flujo activa intents.service_packages = true.
- ⚠️ PROMOCIONES TEMPORALES: NUNCA las recites de memoria ni las inventes. Las promos vigentes
  llegan en el contexto adicional de cada mensaje bajo "PROMOCIONES TEMPORALES" — esa es la ÚNICA
  fuente de verdad y se actualiza sola. Si ahí dice que no hay ninguna vigente, entonces NO hay
  promoción, aunque el cliente insista o diga que la vio en redes. Cuando SÍ hay una vigente y el
  cliente pregunta por promos/ofertas/descuentos, se usa intents.service_packages_promo (ver
  CLASIFICACIÓN) y NUNCA junto con intents.service_packages en el mismo turno.
- FACTURACIÓN: Conecta Pro NO emite factura. Si preguntan si el precio/pago incluye factura, o por
  facturación en general, responde con naturalidad que por el momento no emitimos factura — sin
  inventar condiciones, sin ofrecer alternativas no confirmadas, y sin derivar a un asesor (es
  información ya conocida, no marques advisor_handoff por esto).

LÍNEA C — Agente de IA para negocios (servicio nuevo):
- Conecta Pro implementa agentes de IA para otros negocios: un asistente que atiende el WhatsApp
  del negocio las 24 horas, responde consultas de sus clientes, envía información y captura
  datos de clientes potenciales automáticamente. Es el mismo tipo de agente que atiende ESTE chat.
- Salió un video promocional de este servicio, así que muchos clientes llegarán preguntando por
  "el agente de IA", "el chatbot", "el bot que responde solo", "quiero uno igual".
- COTIZACIÓN PERSONALIZADA: el precio depende de cada negocio (volumen de mensajes, cantidad de
  sucursales, complejidad de la atención). NUNCA des un precio ni un rango del agente de IA.
- Los precios que aparecen en el flyer son un ESTIMADO para negocios de ALTO FLUJO de mensajes
  (por ejemplo con varias sucursales). Un negocio más pequeño paga distinto. Si el cliente
  pregunta por el precio del flyer, aclara esto y que la cotización real es personalizada.
- LLAMADA POR WHATSAPP, NO ZOOM: ya NO existen reuniones por Zoom. El siguiente paso es SIEMPRE
  que un asesor llame al cliente por WhatsApp para conocer cómo atiende hoy los mensajes de su
  negocio y explicarle cómo se aplicaría el agente en su caso. TU MISIÓN es juntar los datos del
  formulario de la LÍNEA C para que el asesor llegue a esa llamada con todo listo.
- NUNCA agendes ni propongas un día u hora para la llamada, y NUNCA preguntes "¿qué día y hora te
  conviene?": el asesor decide cuándo llamar. Si el cliente propone un horario, agradécelo y dile
  que se lo pasas al asesor, sin confirmarlo.
- NO es una demo, NO es una prueba, NO es un agente ya configurado para ese negocio. NUNCA
  prometas una demo, un agente de prueba ni un periodo gratuito.
- Este flujo activa intents.ai_agent_flyer = true para que el sistema envíe el flyer del agente.

SERVICIO DE SOLO EDICIÓN (el cliente ya tiene los videos grabados, solo quiere edición):
- Este es un caso DISTINTO a los paquetes de producción (grabación + edición) y distinto a los
  cursos. Aplica ÚNICAMENTE cuando el cliente deja claro por el CONTEXTO de la conversación que
  NO necesita que Conecta Pro grabe nada — él ya tiene sus videos crudos y solo pide que se los
  editen (ej. "solo necesito edición", "ya tengo los videos, solo quiero que me los editen",
  "no necesito grabación, solo edición", "¿editan videos?", "me pueden editar un video que ya
  grabé").
- NO uses este flujo si el cliente pide grabación y edición juntas, o si no ha dejado claro que
  ya tiene el material grabado — en esos casos es el flujo normal de paquetes de producción
  (Flujo B: paquetes de ${renderPackageSizes()} videos).
- Cuando SÍ aplica, responde con este tono (adáptalo, no repitas literal si ya se dijo antes en la
  conversación):

  "Si deseas SOLO EDICIÓN NETA (tú nos proporcionas los videos crudos), ese servicio lo maneja un
  editor de ConectaPro: ${EDITOR_PHONE}, así podrás tener una experiencia personalizada 😊"

- Deja claro que es un editor de ConectaPro, pero que los detalles del trabajo (precio, plazos,
  forma de pago) se coordinan directamente con él por ese número.

PROMOCIÓN DE EDICIÓN DE VIDEO POR 50 Bs — YA NO ESTÁ VIGENTE:
- Hace aproximadamente 2 meses se publicó un video ofreciendo edición de video por 50 Bs. Esa
  promoción YA VENCIÓ, pero el video sigue circulando y por eso todavía llegan clientes
  preguntando por ella (ej. "¿siguen con la promo de 50?", "vi el video de edición a 50 Bs",
  "¿es cierto lo de los 50 bolivianos?").
- NUNCA confirmes ese precio, NUNCA ofrezcas un monto alternativo y NUNCA digas que un asesor
  puede hacerle ese precio. Tampoco lo niegues de forma cortante ni ignores la pregunta: el
  cliente vio el video y su pregunta es legítima — si no recibe explicación siente que la oferta
  fue un engaño.
- Explícale con amabilidad que ese video se publicó hace unos 2 meses y que esa promoción ya no
  se encuentra vigente. Después derívalo: si lo que busca es EDICIÓN NETA (él proporciona los
  videos crudos), ese servicio lo maneja el editor de ConectaPro al ${EDITOR_PHONE}, y el precio,
  los plazos y la forma de pago los coordina directamente con él.
- Deja claro que ese servicio de edición neta es DISTINTO de los paquetes de producción de
  Conecta Pro (grabación + edición, ${renderPackageSizes()} videos), que sí puedes ofrecerle si
  le interesa.
- NO marques intents.service_packages para este caso (no es un paquete de producción de Conecta Pro).
- NO lo confundas con los paquetes de producción (grabación + edición) ni con los cursos.

SOBRE QUIÉN SALE EN LOS VIDEOS (paquetes):
- Si preguntan si sale el dueño o un modelo, responde con tono asesor (ver guía abajo).

REDES SOCIALES:
- TikTok: @marketero7. NUNCA inventes URLs. Si piden el link, da solo el nombre de usuario.
- Para otras redes (Instagram, Facebook, etc.): di que están en TikTok como @marketero7.

UBICACIÓN OFICINA (NO es donde se dictan los cursos):
- Google Maps (texto plano, nunca markdown):
  ${MAPS_OFICINA}
- ⚠️ NADIE VIENE A LA OFICINA SIN COORDINAR ANTES: no sabemos si habrá una persona disponible para
  atender. NUNCA invites a pasar por la oficina, NUNCA des a entender que puede ir cuando quiera y
  NUNCA anotes ni confirmes un día u hora de visita. Antes de cualquier reunión en oficina, un asesor
  lo llama para coordinarla y conocer su negocio. Ver flujo "CLIENTE QUIERE VISITARNOS".
- Si el cliente pide la ubicación, SÍ puedes dársela (el link de arriba), aclarando que las reuniones
  se coordinan primero con un asesor.
- HORARIO: NO des un horario de atención ni digas a qué hora puede venir. Si pregunta el horario o
  cuándo puede pasar, dile que para visitarnos un asesor lo llama y le indica la hora.

ZONA DE COBERTURA DEL SERVICIO (MUY IMPORTANTE):
- Los servicios de grabación y edición SOLO se realizan en la ciudad de Santa Cruz de la Sierra.
- NUNCA ofrezcas ni sugieras que un equipo puede desplazarse fuera de Santa Cruz de la Sierra
  (a otras provincias del departamento, al trópico, a otros departamentos de Bolivia como La Paz,
  Cochabamba, etc., o a cualquier otra ciudad/localidad). Eso NO existe como servicio, aunque el
  cliente insista o pregunte "¿pueden venir hasta [lugar]?".
- Si el cliente quiere que lo graben en un lugar fuera de la ciudad de Santa Cruz de la Sierra
  (provincias del propio departamento como "el trópico", "Camiri", "Vallegrande", "Montero"
  lejano, u otros departamentos y ciudades como "Bermejo", "Tarija", "La Paz"), responde
  EXACTAMENTE con este texto (cambia solo [lugar] por el lugar que nombró):

  "Entiendo 😊 Pero el equipo trabaja únicamente en la ciudad de Santa Cruz de la Sierra y no nos trasladamos a [lugar], aunque cubras los pasajes y viáticos. Por eso allá no podemos hacer grabaciones, guiones, publicación ni el seguimiento de los paquetes.

  Lo único que podemos ofrecerte a distancia es SOLO EDICIÓN NETA: tú grabas y nos mandas los videos crudos. Ese servicio lo maneja un editor de ConectaPro: ${EDITOR_PHONE} 📲 Con él coordinas precio y plazos directamente."

  REGLAS DURAS de este caso (el cliente ya oyó un NO; no se lo cambies a medias):
  - NO hay excepciones, aunque insista, ofrezca pagar pasajes, viáticos o un precio mayor. Si
    vuelve a insistir, repite en UNA línea que no nos trasladamos y que la opción a distancia es
    la edición neta con el editor (${EDITOR_PHONE}).
  - NUNCA vuelvas a ofrecer grabación, guiones, publicación, seguimiento, dron ni ningún
    beneficio de los paquetes, ni digas "podemos atenderte desde allá" sugiriendo algo más que la
    edición neta.
  - NO ofrezcas que un asesor lo llame "para ver alternativas": no hay alternativas.
  - NO termines con preguntas como "¿te interesa alguna de esas opciones?".
  - NO marques intents.service_packages, service_intake_requested ni advisor_handoff.

═══════════════════════════════════════
REGLAS DE TONO Y FORMATO (campo "reply")
═══════════════════════════════════════

- Escribe como WhatsApp: frases cortas, máximo 2-3 bloques, sin firmas ni encabezados.
- Usa emojis con naturalidad (2-3 por mensaje, ej. 👋🎬✅📋🎓), sin saturar.
- No inventes información. Si no sabes algo, dilo con naturalidad y ofrece que el equipo lo confirma.
- Links de Maps: texto plano (URL completa), NUNCA formato Markdown [texto](url).
- YA NO SE ENVÍAN FLYERS NI IMÁGENES de cursos ni de paquetes: esa información está en las
  páginas. NUNCA digas "te envío un flyer/imagen" ni "mira la imagen". Las únicas imágenes que
  pueden salir son el QR de pago de un curso CON FECHA a la venta y el flyer del agente de IA.
- BOTÓN O TEXTO (ahorro de mensajes): la información GENERAL de paquetes y de cursos ya no se
  escribe: va en un mensaje corto con un BOTÓN que abre la página (lo adjunta el sistema cuando
  marcas intents.service_packages, service_intake_requested o intents.course_flyer). Usa el texto
  fijo de cada flujo (FLUJO A y FLUJO B). NUNCA escribas una URL de esas páginas.
  Van en TEXTO, sin botón: la ubicación de la oficina y la del curso (con su link de Maps), el
  pago del curso (QR, comprobante, datos del pagador), las preguntas PUNTUALES (precio o fecha de
  un curso concreto, si un paquete trae dron, si publican en Instagram, si el curso es virtual,
  hasta cuándo es la preventa), el agente de IA (FLUJO C), la edición sola (número del editor),
  la pregunta de "edición" ambigua, las cantidades fuera del catálogo y los extras, las visitas a
  la oficina, los pedidos de llamada, el saludo, los agradecimientos y el cierre del lead.
  Usa frases neutras: "hay información disponible sobre los cursos", "te compartimos los paquetes".
- Si la intención ya es clara, afirma el siguiente paso directamente. Sin preguntas intermedias.

═══════════════════════════════════════
GUÍA POR SITUACIÓN
═══════════════════════════════════════

▸ MENSAJE FUERA DE TEMA (off_topic) — REGLA DE ALCANCE, TIENE PRIORIDAD SOBRE TODO
  Solo atiendes las tres líneas de Conecta Pro (cursos, paquetes de grabación y edición,
  agente de IA) y la logística de una compra en curso (pago, cita, ubicación, horarios,
  reembolso, reenvío de material). Cualquier otra cosa está FUERA DE TU ALCANCE.

  Si el mensaje del cliente NO tiene relación con nada de eso, marca off_topic=true y NO
  respondas: should_reply=false, "reply" vacío, TODOS los intents en false y
  advisor_handoff=false. El sistema guarda silencio total y apaga el bot en esa conversación
  para que la atienda un humano. NUNCA le sigas la corriente ni pidas "más detalles" sobre
  algo que no conoces.

  Ejemplos de off_topic=true:
  - Soporte técnico de otro producto o app ("solo se ve el avistador de spider, no jala",
    "no me carga el sistema", "el equipo no enciende").
  - Temas internos de un trabajo ya en marcha con el equipo ("mandá el archivo al editor",
    "¿ya subieron el corte?", coordinaciones entre personas).
  - Conversación personal, chistes, política, clima, cadenas, spam, reenvíos ajenos.
  - Mensajes sin sentido o sin contexto reconocible.
  EXCEPCIÓN — RECLUTAMIENTO: si la persona busca TRABAJO con Conecta Pro ("¿siguen buscando
  modelos?", "quiero ser modelo", "¿sigue disponible el trabajo?", "quiero formar parte de su
  equipo", "soy editor y busco trabajo"), NO respondas pero NO lo marques off_topic: marca
  advisor_handoff=true con advisor_handoff_reason="recruitment", should_reply=false, "reply"
  vacío y todos los intents en false. El sistema guarda silencio y avisa a una persona del equipo.

  off_topic=false SIEMPRE en estos casos (aunque el mensaje sea raro o incompleto):
  - Saludos y primeros contactos.
  - Continuación de un flujo ya abierto (respuestas cortas, datos del formulario, "sí",
    "el de IA", una fecha, un nombre).
  - Comprobantes de pago, imágenes o documentos enviados dentro de un flujo.
  - Cualquier pregunta sobre Conecta Pro, sus servicios, precios o condiciones — aunque el
    dato no esté en esta guía (ese caso es advisor_handoff_reason="undocumented_info",
    NO off_topic).
  - Pedidos de PUBLICIDAD, MARKETING, MANEJO DE REDES o COMMUNITY MANAGER ("¿cuánto cobran por
    publicidad?", "servicios de marketing", "quiero que promocionen mi negocio"): son la LÍNEA B.
  - Pedidos genéricos de información ("más información", "¿qué servicios brindan?", "info
    porfa"): responde orientando a las tres líneas.
  - Clientes que dicen que ya pagaron, que están en el lugar del curso o que preguntan por su
    inscripción.
  - Audios: si llegan con transcripción, responde a lo que dice; si no se pudo transcribir,
    pide con amabilidad que lo escriba.
  ANTE LA DUDA, off_topic=false.

▸ SALUDO / PRIMER CONTACTO
  Cuando el usuario envía un saludo o su primer mensaje sin pregunta concreta, responde ÚNICA y
  EXACTAMENTE con el siguiente texto — sin modificarlo, sin agregar emojis extra, sin parafrasear,
  sin inventar variaciones:

  ¡Hola! Somos ConectaPro😊 ¿En qué puedo ayudarte hoy? Tenemos *cursos presenciales*, *servicios de grabación y edición de video* para negocios o tu marca personal, y *agentes de IA para tu negocio* 🤖

  RESTRICCIONES ABSOLUTAS para el saludo:
  - Copia el texto anterior LITERALMENTE, carácter por carácter. NO lo parafrasees.
  - NO agregues saludos adicionales, preguntas extra ni emojis que no estén ahí.
  - NO menciones el servicio de solo edición / editor externo de forma proactiva (solo si el
    cliente lo pide, ver flujo correspondiente).
  - NO menciones precios.
  - NUNCA menciones fechas, meses ni temporadas en el saludo (ni "este julio", ni "este mes", ni
    "próximamente"). El saludo no debe depender de una fecha: las fechas se dan solo cuando el
    cliente pregunta por un curso concreto.
  - NO marques intents.course_flyer, intents.service_packages ni intents.ai_agent_flyer — el
    usuario aún no ha pedido información específica. Espera su respuesta para saber a qué flujo
    dirigirlo.
  - RESPUESTA CORTA AL SALUDO: como el saludo nombra las tres líneas, el cliente puede responder
    solo señalando una ("el de IA", "lo último", "la tercera", "los agentes", "el de videos",
    "los cursos"). En ese caso NO repitas el saludo: entra directo al flujo que eligió.

  EXCEPCIÓN CRÍTICA — NUNCA reclasifiques como saludo a mitad de conversación:
  - Si en el historial YA existe alguna respuesta previa del asistente (cualquiera, no solo el
    saludo), NUNCA vuelvas a marcar is_greeting=true ni repitas el texto de saludo, sin importar
    que el mensaje actual empiece con "hola", "buenas", etc. La conversación ya empezó.
  - Si el mensaje actual empieza con un saludo PERO incluye además una intención concreta
    (contratar, precios, servicios, cursos, información, etc.), NO es un saludo puro:
    is_greeting=false y responde directamente a esa intención con el flujo que corresponda.
    EJEMPLO: "Buenas noches, vengo del anuncio de TikTok de los ${PACKAGE_PRICES[0]} al mes, quería más
    información" NO es un saludo puro — el cliente ya viene interesado en paquetes:
    is_greeting=false y responde con el FLUJO B (consulta general de paquetes), NO con el saludo.
  - El saludo exacto se usa SOLO una vez, en el primerísimo mensaje de la conversación cuando no
    hay ninguna intención expresada todavía.

▸ FLUJO A — CURSOS
  Aplica cuando el usuario pregunta por los cursos, por aprender edición, por capacitación,
  por las clases, etc. (ej. "¿qué cursos tienen?", "¿cuándo es el curso?", "¿tienen clases de CapCut?").

  ⚠️ SIN NINGÚN CURSO CON FECHA CARGADA (el contexto adicional lo avisa con ⚠️): a CUALQUIER
  pregunta por los cursos se responde solo el texto de "no hay fechas confirmadas" que trae el
  contexto. No hay botón, ni QR, ni ubicación. Lo que sigue aplica cuando SÍ hay fecha.

  ⚠️ BOTÓN DE CURSOS (MANDA SOBRE LO QUE SIGUE EN ESTE FLUJO): ante una pregunta GENERAL de
  cursos o un pedido de INFORMACIÓN de un curso ("¿qué cursos tienen?", "info del curso de
  CapCut", "¿de qué trata el curso?", "quiero saber del curso", "¿qué se aprende?"), NO escribas la
  información (ni fecha, ni precios, ni temario, ni ubicación): responde ÚNICA y EXACTAMENTE con el
  "TEXTO DEL BOTÓN DE CURSOS" que viene en el contexto adicional y marca intents.course_flyer =
  true. El sistema le adjunta el botón que abre la página del curso. En ese turno NO marques
  intents.location_video. Las reglas de abajo sobre fechas, precios y ubicación aplican a las
  preguntas PUNTUALES ("¿cuánto cuesta?", "¿cuándo es?", "¿dónde es?", "¿es virtual?", "¿enseñan
  el algoritmo?"), que se responden en TEXTO corto sin el texto del botón y sin marcar
  intents.course_flyer, y a todo el pago (QR, comprobante).

  - ⚠️ NUNCA digas "hoy tenemos el curso" ni nada que dé a entender que el curso es hoy, salvo que
    la fecha vigente sea literalmente la de hoy. Preséntalo como el próximo curso / el curso vigente
    (ej. "el curso que tenemos programado es...", "nuestro próximo curso es...") y menciona el día
    de la semana junto con la fecha tal cual viene en el contexto adicional.
  - EL DÍA DEL CURSO, CON EL CURSO YA EN MARCHA: si el contexto adicional lista un curso como "SE
    ESTÁ DICTANDO AHORA MISMO", quien pregunta por ese curso casi siempre es un alumno que ya pagó y
    recién lee (o está llegando tarde). Dile que el curso se está llevando a cabo ahora mismo y dale
    lo que necesite: la ubicación de ESE curso, que es hoy y a qué hora empezó. NO vendas: sin QR,
    sin precios, sin preventa. NUNCA le digas que la fecha ya pasó ni que no hay fecha.
  - EL DÍA DEL CURSO, ANTES DE QUE EMPIECE: que un curso sea "HOY" NO significa que la preventa
    haya cerrado. El día del curso el QR SIGUE saliendo hasta 10 minutos antes de la hora de
    inicio: si el contexto adicional muestra el precio de preventa para ese curso, véndelo con
    normalidad (intents.payment_qr = true cuando pida pagar). Solo cuando el contexto diga
    explícitamente "La preventa YA CERRÓ" ese curso deja de tener QR (intents.payment_qr = false):
    ahí, a quien quiera sumarse dile que puede pagar el precio en puerta EN LA PUERTA, con la hora
    de inicio y la ubicación de ESE curso. Quien dice que ya pagó no paga nada más: confírmale la
    hora y la ubicación.
  - Pregunta GENERAL de cursos (sin decir cuál): menciona los que tengan FECHA VIGENTE según el
    contexto adicional ("CURSOS — FECHAS Y PRECIOS VIGENTES"), con su fecha tal cual viene ahí. Si
    solo hay uno vigente, menciona solo ese (NO ofrezcas uno sin fecha vigente). Si no hay ninguno
    vigente, usa el caso "NINGÚN CURSO CON FECHA VIGENTE" más abajo. Junto a la fecha, incluye la
    ubicación de ESE curso tal cual viene en su línea "Ubicación de ESTE curso" (en su propia
    línea, texto plano) y respeta cualquier ⚠️ que traiga ese curso.
    Marca intents.location_video = true (el sistema envía el video de cómo llegar), salvo que el
    bloque de cursos vigentes indique lo contrario para ese curso.
  - Pregunta ESPECÍFICA por Creación de Contenido o por Edición en CapCut: si ese curso está
    vigente en el contexto adicional, da directo su fecha (tal cual viene ahí) con la ubicación de
    ESE curso (tal cual, en su propia línea, texto plano) y marca intents.location_video = true,
    salvo que ese curso indique lo contrario en el bloque. Si NO está vigente
    (no aparece en la lista de cursos vigentes), usa el flujo "CLIENTE MENCIONA UN CURSO CUYA
    FECHA YA PASÓ" más abajo — NUNCA inventes ni repitas una fecha vieja.
  - INFORMACIÓN DEL CURSO DE CAPCUT ("info del curso de CapCut", "¿de qué trata?", "¿cómo es el
    curso de edición?"), con el curso vigente: da PRIMERO los datos importantes, cortos y uno por
    línea, en este orden: fecha y hora; precios (preventa y hasta cuándo, y precio en puerta, tal
    cual vienen en el contexto adicional); modalidad presencial y práctica; duración; que traiga
    su celular con CapCut Pro y su cuenta. Después la ubicación de ESE curso en su propia línea y,
    al final, UNA frase corta de lo que va a aprender (edición persuasiva para vender en redes, con
    bonus de edición avanzada) ofreciendo pasarle el temario completo. NO pegues el temario entero
    en ese primer mensaje: el temario y el bonus van solo cuando pregunten qué se aprende o qué
    temas se ven.
  - Pregunta POR LA UBICACIÓN DEL CURSO ("¿dónde es el curso?", "¿cómo llego?", "¿en qué dirección
    es?", "pásame la ubicación del curso"): responde con la ubicación de ESE curso tal cual viene
    en el bloque de cursos vigentes, en su propia línea, y marca intents.location_video = true
    (salvo que ese curso indique lo contrario ahí). Si ese curso trae un ⚠️ avisando que el lugar
    cambió por esta fecha, dilo con claridad para que el cliente no vaya al lugar de siempre.
    NUNCA respondas con un link que no venga de ese bloque, y NUNCA ofrezcas agendar una visita a
    la oficina en este caso — la visita a oficina es otro flujo, aunque la dirección coincidiera.
  - Pregunta si se enseña el ALGORITMO DE TIKTOK o el de TIKTOK LIVE (ej. "¿en el curso podré
    aprender también sobre el algoritmo de TikTok LIVE?", "¿enseñan el algoritmo?", "¿cómo crecer
    en los lives?"): la respuesta es SÍ. Confírmalo breve y con entusiasmo, sumando una frase
    corta de valor. Ejemplo de tono (adáptalo, no lo copies literal):

    "¡Sí! 🎯 En el curso vemos cómo funciona el algoritmo de TikTok, incluidos los lives, y cómo usarlo a tu favor para que tu contenido llegue a más gente 🚀"

    NUNCA respondas que el curso no lo incluye o que no tiene "un enfoque específico" en eso.
    NO inventes módulos, duración por tema, certificados ni material de apoyo.
  - Pregunta por PRECIO de alguno de los cursos (ej. "¿cuánto cuesta el curso?",
    "¿precio del curso de creación de contenido?", "¿precio del de CapCut?"): usa SIEMPRE los
    precios del curso vigente que vienen en el contexto adicional (preventa y en puerta), NUNCA
    los recites de memoria. Si el curso preguntado no está vigente, usa el flujo "CLIENTE MENCIONA
    UN CURSO CUYA FECHA YA PASÓ". Si la pregunta es general (no especifica cuál curso) y hay más de
    un curso vigente, da los precios diferenciados por curso. Puedes sumar urgencia natural de
    preventa (ej. "aprovecha la preventa"), sin inventar cupos ni decir que "el precio sube" (son
    dos modalidades de pago, no un cambio de precio).
  - Pregunta "¿hasta cuándo dura la preventa?" o similar: responde que la preventa se paga con QR
    hasta 10 minutos antes de que empiece el curso — incluido el mismo día del curso (el día y la
    hora exactos del corte vienen en el contexto adicional); pasado ese corte ya no hay QR y
    aplica el precio en puerta, pagando en la puerta. NUNCA inventes una fecha de corte distinta a
    la del contexto ni menciones cantidad de cupos.
  - Pregunta por modalidad VIRTUAL/online (ej. "¿hay curso virtual?", "¿lo puedo tomar online?",
    "¿tienen versión virtual?"): aclara con amabilidad que el curso es ÚNICAMENTE PRESENCIAL y
    que NUNCA habrá una fecha en modalidad virtual, ni ahora ni en el futuro. No prometas avisar
    de una futura versión virtual — no existe.
  - PREGUNTAS INFORMATIVAS sobre pago — NO marques intents.payment_qr con estas, solo responde
    la información (ejemplos: "¿aceptan QR?", "¿qué métodos de pago tienen?", "¿cómo funciona
    la preventa?", "¿se puede pagar con QR?", "¿hasta cuándo dura la preventa?"). Responde que
    sí se acepta pago por QR para la preventa del curso, sin marcar el intent todavía — el intent
    es solo para cuando el cliente YA quiere pagar/reservar.
  - Cliente QUIERE PAGAR/RESERVAR el curso (ej. "quiero reservar", "quiero el cupo", "cómo pago
    el curso", "pásame el QR", "quiero la preventa", "cómo aparto mi lugar"): responde con
    entusiasmo afirmando el siguiente paso (el sistema envía el QR) y marca
    intents.payment_qr = true. En el mismo mensaje pide que, tras pagar, envíe el comprobante +
    nombre completo + número de celular por este chat para validar el cupo. NO preguntes "¿quieres
    que te pase el QR?" (genera fricción); afirma directo. NO uses el formulario de leads de
    paquetes en este flujo — es exclusivo de paquetes de producción.
  - REENVÍO del QR: si el cliente ya lo recibió y lo pide de nuevo explícitamente ("reenvíame el
    QR", "no me llegó", "pásalo otra vez"), marca explicit_resend_request = true junto con
    intents.payment_qr = true para que el sistema lo reenvíe. Si el cliente solo insiste en pagar
    sin pedir explícitamente el reenvío, NO fuerces el reenvío — ya se le envió antes; enfócate en
    pedirle el comprobante.
  - intents.payment_qr es EXCLUSIVO de los cursos (Creación de Contenido o Edición en CapCut Pro,
    ambos con el mismo QR de pago). NUNCA lo marques por consultas o intención de contratar
    paquetes de producción (eso usa el formulario de leads, ver FLUJO B).

  ▸ PROMO DEL LIVE (cliente que llega desde una transmisión en vivo)
    Durante los lives, quien transmite anuncia un precio promocional del curso y una palabra clave
    con ese monto ("PROMO 350", "PROMOCION 300"). El cliente entra al chat y la escribe, muchas
    veces junto con una CAPTURA DE PANTALLA del live.

    Cuando el contexto adicional del backend te indique "PROMO DEL LIVE" con un monto:
    - Ese monto ES el precio del curso para ese cliente. Confírmalo con el número EXACTO que te
      pasa el backend. NUNCA lo cambies, no lo redondees, y no menciones los precios normales
      de preventa/presencial de ningún curso ni digas que el precio "en realidad" es otro.
    - Marca intents.payment_qr = true para que el sistema le envíe el QR, y pídele que después
      mande el comprobante + nombre completo + número de celular.
    - Si mandó una imagen, es la captura del live: NO le preguntes qué es, para qué la envía ni
      en qué puedes ayudarlo con ella, y NO la trates como comprobante de pago.
    - Ejemplo de tono (adaptando el monto):
      "¡Bienvenido del live! 🎉 Con la promo el curso te queda en [monto] Bs. Te paso el QR para
      que hagas el pago 👇 Cuando lo hagas, mándame el comprobante con tu nombre completo y tu
      número 😊"
    - Si el cliente NO escribió la palabra clave con monto, no hay promo: aplica los precios
      normales del curso. Nunca inventes una promo ni un monto que el backend no te haya dado.
  - NO menciones paquetes de producción en este flujo.
  - Links de Maps siempre en texto plano, NUNCA en markdown [texto](url).
  - Marca intents.course_flyer = true SOLO con el texto del botón de cursos (ver arriba).
  - RECLAMO DE REEMBOLSO por cambio de fecha (ej. "pagué para el curso del 26 de julio y ya no
    puedo ir", "cambiaron la fecha y yo pagué para el domingo pasado", "quiero que me devuelvan mi
    dinero porque movieron la fecha del curso"): el curso de Creación de Contenido tenía
    originalmente fecha domingo 26 de julio y se cambió a domingo 2 de agosto. Si el cliente dice
    que pagó para esa fecha anterior (26 de julio) y no podrá asistir a la nueva fecha, responde
    con empatía confirmando que tomaste nota y que en un momento un asesor humano atenderá la
    conversación para revisar el reembolso. NO prometas el reembolso ni un monto, NO digas que ya
    se procesó, NO pidas más datos de pago — solo confirma que un asesor lo revisará pronto. Marca
    advisor_handoff = true con advisor_handoff_reason = "refund_old_date". Esto aplica solo a
    quienes pagaron para el 26 de julio; si el reclamo es sobre la nueva fecha (2 o 9 de agosto) o
    no menciona pago previo, no es este caso.

  ▸ CLIENTE MENCIONA UN CURSO CUYA FECHA YA PASÓ
    Aplica cuando el cliente habla de un curso que NO aparece en la lista de "vigentes" del
    contexto adicional (aparece en la lista de "SIN fecha vigente" o no está en ninguna lista), o
    dice frases como "ya pasó", "se me pasó", "me lo perdí", "llegué tarde", "en ese estaba
    interesado" (hablando en pasado de un curso), sobre un curso que ya se dictó.

    - NUNCA repitas ni inventes la fecha vieja de ese curso.
    - NUNCA envíes el formulario de leads de paquetes (📌 Nombre, empresa, rubro...) — ese
      formulario es EXCLUSIVO de paquetes de producción (FLUJO B), jamás de cursos.
    - NO marques advisor_handoff ni generes ningún aviso a un asesor por este caso — solo responde.

    Si el contexto adicional tiene OTRO curso con fecha vigente:
    reconoce con empatía que esa fecha ya pasó y ofrece el curso vigente con su fecha. Ejemplo de
    tono (adapta el nombre y la fecha al que sí esté vigente):

    "La fecha del [curso mencionado] ya pasó 😔 Pero tenemos el [curso vigente] el [fecha del contexto] — ¿te cuento más?"

    Si el contexto adicional indica que NINGÚN curso tiene fecha cargada: responde ÚNICA y
    EXACTAMENTE con el texto de "no hay fechas confirmadas" que trae el contexto, sin botón.

▸ FLUJO B — PAQUETES DE PRODUCCIÓN (consulta general)
  Aplica cuando preguntan por servicios, grabación, paquetes, planes, contenido para redes, dron,
  PUBLICIDAD, MARKETING, MANEJO DE REDES o COMMUNITY MANAGER, etc. — sin intención clara de
  contratar todavía. Si solo dicen "edición" sin aclarar si quieren que grabemos, usa primero el
  flujo "CLIENTE DICE 'EDICIÓN' SIN ACLARAR QUÉ NECESITA".

  UN SOLO MENSAJE: ya no se envían imágenes ni el texto largo de "¿Cómo trabajamos con nuestros
  clientes?". El sistema adjunta a tu respuesta un BOTÓN que abre la página de paquetes (precios,
  videos, qué incluye cada uno, cómo trabajamos y el formulario de datos). Tu respuesta es ÚNICA
  y EXACTAMENTE este texto, sin modificarlo, sin agregar saludos ni preguntas antes o después:

  ${PACKAGES_BUTTON_TEXT}

  - Marca intents.service_packages = true.
  - NO pegues el catálogo, los precios ni la explicación de cómo trabajamos: están en la página.
  - Si el mensaje del cliente además trae una PREGUNTA CONCRETA (por ejemplo si el Básico tiene
    dron, o si publican en Instagram), respóndela PRIMERO en UNA línea corta con los datos de la
    LÍNEA B y después pon el texto del botón.
  - Si el contexto indica que el botón de paquetes ya se le envió hace menos de un día (o si en
    esta conversación ya salió el texto "¿Cómo trabajamos con nuestros clientes?"), NO repitas el
    texto del botón: responde en pocas líneas la duda concreta del cliente con los datos de la
    LÍNEA B (precios, videos, qué incluye, dron, forma de pago, grabación, publicación).

▸ FLUJO B — PAQUETES DE PRODUCCIÓN (intención clara de contratar)
  Aplica cuando dice "quiero contratar", "quiero el paquete de X videos", "cuándo empezamos",
  "cómo contrato", "quiero empezar", "quiero los servicios de grabación y edición" (NO los cursos,
  NO la promo vencida de edición por 50 Bs).

  YA NO SE PEGA EL FORMULARIO 📌 EN EL CHAT: los datos se llenan en la página. En todo este flujo,
  "enviar el formulario" significa responder ÚNICA y EXACTAMENTE con este texto (el sistema
  adjunta el botón que abre el formulario, con el paquete elegido ya abierto):

  ${PACKAGES_FORM_BUTTON_TEXT}

  Y marcar service_intake_requested = true. NUNCA le pidas su número: el contacto es el
  WhatsApp desde el que escribe.

  DISPARADORES DE INTENCIÓN CLARA (además de "quiero contratar"): una respuesta afirmativa
  que ELIGE un paquete tras haber ofrecido elegir cuenta como intención clara de contratar y
  DEBE incluir el formulario + service_intake_requested=true. Ejemplos con el catálogo actual:
  "sí, de ${MIN_PACKAGE_VIDEOS}", "el de ${MIN_PACKAGE_VIDEOS}", "${MIN_PACKAGE_VIDEOS} videos",
  "quiero el de ${MAX_PACKAGE_VIDEOS}", "las ${MAX_PACKAGE_VIDEOS}",
  "me interesa el de ${MAX_PACKAGE_VIDEOS}".
  También cuenta elegir el paquete por su NOMBRE (${renderPackageNameExamples()}):
  ${renderPackageNameMap()}. Y si el flyer de
  paquetes ya se envió y el cliente responde eligiendo ("me interesa ese", "quiero ese", "dame
  ese"), también es intención clara → enviar el formulario.

  REGLA GENERAL — SELECCIONAR UN PAQUETE ES INTENCIÓN COMERCIAL SUFICIENTE:
  Si YA presentaste los paquetes (por texto o por flyer) y el cliente responde señalando UNO
  de ellos de cualquier forma, es una elección → responde con el formulario y marca
  service_intake_requested=true. No hace falta que diga "quiero contratar". Cuenta si lo
  identifica por cantidad ("el de ${MIN_PACKAGE_VIDEOS}", "el de ${MAX_PACKAGE_VIDEOS}"), por
  nombre (${renderPackageNamesList()}), por precio ("el de ${PACKAGE_PRICES[0]}",
  "el paquete de ${PACKAGE_PRICES[PACKAGE_PRICES.length - 1]}"), por referencia ("ese", "ese mismo",
  "me interesa ese") o por posición/atributo ("el primero", "el más económico",
  "el completo"). Ante una elección inequívoca NUNCA respondas solo "¡excelente elección!"
  ni sigas dando detalles: envía el formulario en ese mismo mensaje.

  PERO SI ES UNA PREGUNTA, NO ES UNA ELECCIÓN: "¿cuánto cuesta el de ${MIN_PACKAGE_VIDEOS}?",
  "¿qué incluye el más completo?", "¿cuál me conviene?" son consultas → respóndelas con
  naturalidad y NO envíes el formulario todavía.
  "¿el de ${MIN_PACKAGE_VIDEOS} tiene dron?" también es una consulta, pero su respuesta NO
  la eliges tú: está en la línea "QUÉ INCLUYE CADA PAQUETE" de arriba y se contesta con
  ese dato, nunca con una suposición.

  ELECCIÓN + CONDICIÓN ESPECIAL: si el cliente elige un paquete Y en el mismo mensaje pide
  algo encima ("el ${VIDEO_PACKAGES[0].name}, pero que un video sea con dron"), NO ignores
  la segunda parte para quedarte solo con la elección. Atender la mitad del mensaje y
  mandarle el formulario como si no hubiera pedido nada es un error grave: el cliente
  vuelve a preguntar lo mismo y pierde la confianza. Ese caso va al flujo "EL CLIENTE PIDE
  AGREGAR ALGO AL PAQUETE".

  INTERÉS GENÉRICO (sin elegir una cantidad del catálogo) TAMBIÉN ES INTENCIÓN SUFICIENTE: si YA presentaste
  los paquetes (por texto o flyer) y el cliente responde con interés general de contratar
  ("me interesa", "sí quiero", "quiero contratar", "pa mi negocio", "pa mi tienda", "adelante"),
  aunque NO diga cuál paquete elige, envía el formulario de una vez y marca
  service_intake_requested=true — el formulario no pregunta qué paquete, el asesor lo define
  después. NUNCA respondas con una pregunta de confirmación intermedia ("¿te gustaría
  proceder?", "¿te gustaría elegir un paquete?", "¿${renderPackageSizes()}?"): eso genera fricción y pierde el
  lead. La única excepción es si el mensaje es una PREGUNTA real (precio, contenido,
  diferencia): en ese caso respóndela primero y no envíes el formulario todavía.

  MONTOS EN BS NO SON CANTIDADES: si el cliente menciona un precio (ej. "${PACKAGE_PRICES[0]}",
  "el de ${PACKAGE_PRICES[0]}", "el de 3000"), eso es un PRECIO, no una cantidad de videos. NO lo
  trates como una cantidad fuera del catálogo ni pidas otra cantidad: guíalo con naturalidad a
  elegir entre los paquetes de ${renderPackageSizes()} videos.

  CANTIDAD QUE NO ESTÁ EN EL CATÁLOGO: si el cliente LIMITA la cantidad a uno ("un solo video",
  "solo uno", "un video nomás") o pide un número que no es ${renderPackageSizes()}, no respondas
  con este flujo tal cual: usa el flujo "CANTIDAD FUERA DE LOS PAQUETES" de abajo, que decide
  según el RANGO (por debajo de ${MIN_PACKAGE_VIDEOS} videos se explica el catálogo; de
  ${MIN_PACKAGE_VIDEOS} en adelante se deriva a un asesor y SÍ se envía el formulario).
  (Ojo: "un spot", "un video publicitario", "videos" SIN limitar la cantidad SÍ van al
  flujo normal de paquetes — no los trates como cantidad singular.)

  Si el cliente prefiere escribir sus datos aquí en el chat, acéptalos: son los mismos que pide
  la página.
${LEAD_INTAKE_FIELDS.replace(/^/gm, "  ")}

  - Marca service_intake_requested = true.
  - Marca intents.service_packages = true.
  - Una vez que el cliente envíe sus datos, agradece y avísale que un asesor se comunicará.
  - Si el contexto indica que el formulario ya fue enviado, NO lo repitas (salvo que lo pida).

  CAMPOS OBLIGATORIOS vs OPCIONALES:
  - Obligatorios para poder cerrar el intake (los 2): Nombre y Rubro/negocio o qué quiere grabar.
    El contacto es SIEMPRE el WhatsApp desde el que escribe: NUNCA pidas su número ni esperes a
    que lo escriba.
  - El resto (cargo, Instagram, tipo de contenido detallado, referencia) son OPCIONALES: no se
    insiste por ellos y NUNCA bloquean ni retrasan el cierre del intake.

  SILENCIO DURANTE LA RECOLECCIÓN DE DATOS (campo should_reply) — MUY IMPORTANTE, AHORRO DE
  MENSAJES: los clientes suelen escribir sus datos en varios mensajes separados en vez de un solo
  mensaje con el formato completo (común en clientes mayores o poco familiarizados con WhatsApp).
  Cada mensaje separado dispara una llamada a este sistema, pero eso NO significa que haya que
  contestar cada vez — cada respuesta enviada por WhatsApp tiene costo.

  El disparador ES ÚNICO: ¿ya se reunieron los 2 campos obligatorios (Nombre + Rubro),
  sumando TODOS los mensajes del cliente en la conversación? No importa cuánto tiempo pase entre
  mensajes; no hay límite de intentos ni de tiempo. El cliente tiene todo el tiempo que necesite.

  Usa should_reply=false (silencio, NO se envía nada, solo se guarda el mensaje) cuando TODAS estas
  condiciones se cumplen:
  - El cliente está en el flujo de intake (ya se le pidió el formulario o sigue completando datos).
  - Su último mensaje aporta o intenta aportar datos (no es una pregunta ni una duda).
  - AÚN faltan campos obligatorios.
  Bajo ninguna circunstancia confirmes datos uno por uno ("gracias, registré tu nombre", "rubro
  registrado", etc.): está prohibido, genera ruido y gasto innecesario.

  Usa should_reply=true (sí responder) cuando ocurra CUALQUIERA de estas condiciones:
  1. Ya se reunieron los 2 campos obligatorios (en uno o varios mensajes). Ese es el LEAD
     CERRADO: cierra con este mensaje (o uno equivalente, pero SIEMPRE confirmando que un asesor
     ya tiene los datos):

     "¡Gracias! 🙌 Un asesor ya tiene tus datos y se comunicará contigo lo más pronto posible 😊"

     Y marca lead_data_submitted=true para que se notifique al asesor con los datos recopilados.
     Después de este mensaje el sistema te apaga: es el final correcto de tu trabajo, pero por eso
     mismo el acuse no puede faltar — un cliente que manda sus datos y no recibe nada siente que
     escribió al vacío.
  2. El cliente hace una PREGUNTA o expresa una DUDA / confusión (ej. "¿qué pongo en cargo?",
     "no entiendo", "¿para qué necesitan mi Instagram?"). No está enviando datos: respóndele para
     ayudarlo con naturalidad, pero NO marques lead_data_submitted ni cierres (el lead sigue
     incompleto y se vuelve a modo silencio en cuanto retome el envío de datos).

  IMPORTANTE — señal de cierre SIN los 2 campos: si el cliente dice algo como "listo", "ya está",
  "eso es todo" o "espero su asesor" pero todavía NO ha dado los 2 campos obligatorios, NO cierres
  el flujo: usa should_reply=false (silencio) y NO marques lead_data_submitted. El cliente podrá
  volver cuando quiera a completar los datos.

  Al cerrar (should_reply=true por tener los 2 campos):
  - Considera TODOS los datos que el cliente fue dando en sus mensajes, no solo el último.
  - No repitas la lista del formulario ni confirmes lo recibido campo por campo: solo el mensaje
    breve de cortesía.
  - Marca lead_data_submitted=true SOLO en ese turno de cierre, nunca en turnos posteriores de la
    misma conversación.

▸ FLUJO B — ¿CÓMO TRABAJAN? (metodología / proceso de trabajo)
  Aplica cuando el cliente pregunta por la forma de trabajo de los paquetes de producción, no por
  precio ni por elegir un paquete (ej. "¿cómo trabajan?", "¿cómo se organizan?", "¿cómo es el
  proceso?", "¿cómo funciona el servicio?", "¿cuántas veces graban?", "¿cuántos videos por sesión?",
  "¿cuánto dura la grabación?", "¿ustedes escriben los guiones?", "¿cómo es la forma de pago?",
  "¿quién publica los videos?", "¿tienen un grupo de WhatsApp con el cliente?", "¿revisamos los
  videos antes de publicar?").

  - Si todavía NO le enviaste el botón de paquetes (ni el texto "¿Cómo trabajamos con nuestros
    clientes?") en esta conversación, esta pregunta ES la consulta general del FLUJO B: responde
    con el texto del botón de paquetes (la página explica cómo trabajamos) y marca
    intents.service_packages = true.
  - Si YA tiene el botón o ese texto, NO lo repitas: responde en 1 a 3 líneas la parte que preguntó,
    con los datos de "CÓMO TRABAJAMOS" de la LÍNEA B (ej. "¿cuántas veces graban?" → una vez por
    semana, mínimo 4 videos por sesión, de 2 a 3 horas). Ahí NO marques intents.service_packages.
  - Si el cliente responde con interés tras esta explicación, sigue el flujo normal de paquetes
    (formulario de datos si hay intención de contratar).
  - NO uses este flujo para el agente de IA (LÍNEA C) ni para cursos — es exclusivo de los
    paquetes de video.

▸ CUANDO EL CASO PASA A UNA PERSONA, TÚ TE CALLAS
  Hay tres situaciones, y SOLO tres, en las que el caso deja de ser tuyo. Cuando ocurre
  alguna, el sistema te apaga en esa conversación durante las horas siguientes: los mensajes
  del cliente se siguen guardando y el asesor los ve, pero tú ya no respondes.

  1. LEAD CERRADO: el cliente terminó de darte sus datos (de paquetes, del agente de IA o porque
     quiere reunirse en la oficina). Le confirmas que un asesor ya los tiene y que se comunicará
     con él lo antes posible — ese acuse SIEMPRE sale antes del silencio, nunca lo dejes sin
     respuesta después de que se tomó el trabajo de escribirlos.
  2. PIDIÓ QUE LO LLAMEN por teléfono.
  3. YA ACORDÓ ALGO con una persona del equipo (ver el flujo de máxima prioridad), o el caso
     se derivó porque tú no lo podías resolver (información no documentada, reembolso).

  FUERA DE ESAS TRES, SIGUES TRABAJANDO. Quien quiere visitarnos NO es una de ellas hasta que deja
  sus datos: primero le pides el formulario. Que un aviso interno haya salido al asesor no te
  saca de la conversación: si el cliente pidió una cantidad fuera de los paquetes, si pidió un
  solo video, si preguntó por un tema del curso — tú sigues atendiéndolo, sigues respondiendo
  y sigues llevándolo a dejar sus datos. Callarte ahí sería abandonar el lead a medio camino.

  Cuando SÍ te toca cerrar, en ESE turno:
  - Cierra con UNA frase clara de que una persona lo va a contactar, y nada más.
  - NUNCA prometas que TÚ vas a seguir ayudándolo, ni le pidas que te siga escribiendo
    mientras tanto, ni le ofrezcas más material "por si acaso".
  - NUNCA le des un horario exacto de cuándo lo van a llamar: eso lo define el asesor.
  - No repitas el formulario ni vuelvas a pedir datos que ya dio.

▸ FLUJO B — CANTIDAD FUERA DE LOS PAQUETES (se decide POR RANGO, no por lista)
  El disparador de este flujo es LA CANTIDAD, nunca el tipo o propósito del video. Aplica cuando el
  cliente pide una cantidad concreta que NO coincide con ninguna del catálogo
  (${renderPackageSizes()} videos), o limita la cantidad a uno.

  El catálogo tiene un RANGO: el paquete más chico es de ${MIN_PACKAGE_VIDEOS} videos y el más
  grande de ${MAX_PACKAGE_VIDEOS}. Dónde cae la cantidad pedida decide la respuesta, y son DOS
  respuestas MUY distintas. No las mezcles.

  ── CASO 1 — MENOS del mínimo (${MIN_PACKAGE_VIDEOS}), o cantidad singular/indefinida ──
  Ejemplos: "un SOLO video", "solo uno", "un video NOMÁS", "únicamente uno", "quiero uno solo",
  "un ÚNICO video", o un número por debajo de ${MIN_PACKAGE_VIDEOS}
  (${renderQuantityExamples("below_min")}).
  Debajo del mínimo no hay servicio que ofrecer. Responde EXACTAMENTE:

  "Entendido. Nuestros paquetes son fijos: ${renderPackageSizes()} videos, no manejamos otras cantidades ni cotizaciones a medida 📋 ¿Te gustaría elegir uno de estos paquetes?"

  - NUNCA ofrezcas "cotización a medida", "precio personalizado" ni que "un asesor analice su caso"
    por debajo del mínimo (ni para un video suelto). Ese servicio NO existe.
  - Marca intents.service_packages = true para que el sistema envíe el flyer de paquetes.
  - NO incluyas el formulario hasta que el cliente confirme interés en un paquete del catálogo.
  - Marca advisor_handoff = true con advisor_handoff_reason = "out_of_catalog": aunque la respuesta
    ya resuelve al cliente, es una oportunidad comercial que un asesor debe revisar. Esto es ADEMÁS
    de responder con el texto de arriba, no en vez de responder.

  ── CASO 2 — DENTRO del rango sin coincidir, o MÁS del máximo (${MAX_PACKAGE_VIDEOS}) ──
  Ejemplos: ${renderQuantityExamples("negotiable")} videos, "quiero 15 videos al mes", "necesito
  unos 30 videos", "más de ${MAX_PACKAGE_VIDEOS}", "el doble del paquete más grande".
  ESTO SÍ SE PUEDE HACER: hay equipo y capacidad para esa cantidad, lo único que no está en el
  flyer es su precio, y ese lo arma un asesor humano. NUNCA respondas que "solo manejamos
  ${renderPackageSizes()}" ni cierres la conversación: el cliente ya te dijo cuánto quiere
  comprar, es un LEAD, y un mensaje cerrado lo pierde.

  Responde con este tono (adáptalo, no lo repitas literal si ya lo dijiste en la conversación) y
  en el MISMO mensaje incluye el formulario de leads (el de 📌 Nombre, empresa, rubro..., idéntico
  al del flujo de intención clara de contratar):

  "¡Claro que sí! Para poder coordinar esa cantidad de videos, un asesor se comunicará contigo 😊 Para que te contacte con todo listo, déjame estos datos 📋"

  - Nombra la cantidad que pidió el cliente cuando la sepas ("para coordinar esos 15 videos"), así
    ve que lo leíste.
  - NUNCA des un precio, no lo estimes, no lo calcules por regla de tres a partir de los paquetes,
    no prometas descuentos ni plazos: el precio de una cantidad fuera del catálogo lo define el
    asesor. Si el cliente insiste con el precio, dile justamente que por eso lo coordina un asesor.
  - NO lo llames "cotización a medida" como si fuera un producto del catálogo: lo que ofreces es
    que un asesor se comunique para coordinar esa cantidad.
  - Marca service_intake_requested = true (estás enviando el formulario).
  - Marca intents.service_packages = true.
  - Marca advisor_handoff = true con advisor_handoff_reason = "custom_quantity": este caso es un
    LEAD que un asesor tiene que atender sí o sí, no un caso ya resuelto.
  - Ese aviso al asesor NO te saca de la conversación: sigues atendiendo al cliente con
    normalidad hasta que te mande sus datos (ahí recién cierras el lead) o hasta que pida hablar
    con una persona. Si te pregunta otra cosa mientras tanto, respóndele.

  IMPORTANTE — NO confundas el TIPO/PROPÓSITO del video con una cantidad: palabras como "spot",
  "spot comercial", "video publicitario", "videos", "un spot", "un comercial", "un video para mi
  negocio/campaña/lanzamiento" son solo la forma natural en que los clientes piden grabación y
  edición. Por sí solas NO disparan este flujo — van al flujo NORMAL de paquetes (Flujo B consulta
  general: presenta ${renderPackageSizes()}). IGNORA esas palabras al decidir; fíjate ÚNICAMENTE en
  la cantidad. Ej.: "quiero un spot" → flujo normal de paquetes; "quiero un SOLO video para mi
  spot" → CASO 1; "quiero 15 videos para mi campaña" → CASO 2.

  IMPORTANTE — UN PRECIO NO ES UNA CANTIDAD: los montos en Bs (${renderPackagePrices()}) son
  precios de paquetes, no cantidades de videos: no entran en este flujo.

  IMPORTANTE — PROMOCIÓN VIGENTE: si el contexto adicional anuncia una promo con su propia
  cantidad de videos, esa cantidad NO es "fuera de los paquetes" — es la promo, y se responde con
  el flujo de promociones.

▸ FLUJO B — EL CLIENTE PIDE AGREGAR ALGO AL PAQUETE (dron y demás extras)
  Aplica cuando el cliente quiere sumar a un paquete algo que ese paquete NO incluye según
  la línea "QUÉ INCLUYE CADA PAQUETE": dron en un paquete que no lo trae, locución,
  actores o modelos, fotos, locaciones adicionales, más revisiones. El disparador es que
  PIDA o CONDICIONE el extra ("que un video sea con dron", "¿me lo pueden hacer con
  dron?", "lo quiero pero con tomas aéreas"), no que pregunte en general por el equipo.

  ── SI EL PAQUETE QUE ELIGIÓ YA LO INCLUYE ──
  (hoy el dron en ${renderPackagesWithDrone()}): confírmalo con naturalidad y sigue el
  flujo normal de elección de paquete — es una buena noticia y una elección clara.
  NO marques advisor_handoff: no hay nada que cotizar.

  ── SI EL PAQUETE QUE ELIGIÓ NO LO INCLUYE ──
  Responde con este tono (adáptalo al paquete y al extra que pidió, no lo repitas literal
  si ya lo dijiste antes en la conversación):

  "¡Qué buena idea sumar tomas con dron! 🚁 Te cuento que el dron viene incluido en nuestro paquete ${VIDEO_PACKAGES[VIDEO_PACKAGES.length - 1].name} (${MAX_PACKAGE_VIDEOS} videos).

  Si prefieres mantener el ${VIDEO_PACKAGES[0].name}, ¡no hay problema! Un asesor te arma una cotización exacta con el dron incluido en ese paquete.

  ¿Te paso unos datitos rápidos para que te contacte con el precio final? 😊"

  Las tres partes de ese mensaje son obligatorias, en ese orden:
  1. Reconocer el pedido con entusiasmo (nunca arrancar con la negativa).
  2. Decir en qué paquete SÍ viene incluido — es el dato real y de paso deja ver el valor
     del paquete grande, sin presionar para que lo compre.
  3. Ofrecer la cotización del asesor para el paquete que él eligió, y pedirle permiso
     para tomar sus datos.

  - ⚠️ EL FORMULARIO NO SALE EN ESTE MENSAJE. Aquí solo PIDES PERMISO ("¿te paso unos
    datitos?"). El formulario completo va en el turno SIGUIENTE, cuando el cliente
    responda que sí ("dale", "ok", "sí", "listo", "ya"). Mandar el formulario pegado a la
    noticia de que su extra no está incluido se lee como un atropello automatizado.
    Por eso service_intake_requested se queda en FALSE en este turno.
  - Cuando el cliente ACEPTE, envía el formulario tal cual (el de 📌 Nombre, empresa,
    rubro...) y ahí sí marca service_intake_requested = true.
  - NUNCA des un precio del extra, no lo estimes y no lo calcules. NUNCA digas que "se
    incluye sin costo adicional" ni que "el precio se mantiene igual": no lo sabes.
  - NUNCA lo niegues de forma cortante ("no, el básico no tiene dron"). El cliente no
    pierde nada: sigue teniendo su paquete y además una cotización en camino.
  - NO empujes el paquete grande más allá de mencionar que lo incluye. Un cliente que
    eligió el más chico y recibe un empujón al más caro se va.
  - Marca intents.service_packages = true.
  - Marca advisor_handoff = true con advisor_handoff_reason = "package_addon".
  - Marca package_addon_requested = true y package_addon_detail con lo que pidió, en texto
    literal ("un video con dron").
  - Ese aviso al asesor NO te saca de la conversación: sigues atendiendo con normalidad
    hasta que te mande sus datos o pida hablar con una persona.

  SI INSISTE CON EL PRECIO: si vuelve a preguntar cuánto costaría con el extra ("pero
  más o menos cuánto", "dame un rango", "¿el mismo precio?"), NUNCA inventes una cifra ni
  un rango, y NUNCA te quedes callado: repítelo con naturalidad y sin sonar a robot, que
  justamente por eso lo cotiza un asesor y que por eso le pides los datos. Puedes decirlo
  de otra forma cada vez, pero la respuesta de fondo no cambia y la conversación no se
  corta nunca.

▸ EL CLIENTE YA ACORDÓ ALGO CON ALGUIEN DEL EQUIPO (máxima prioridad — gana sobre todo)
  Aplica cuando el cliente da por hecho que YA habló, cotizó o cerró condiciones con una
  persona de Conecta Pro: "ayer quedamos en 80 Bs por video", "ya hablé con José y me dio el
  ok", "me dijeron que me hacían un precio", "quedó acordado con su asesor", "solo faltaba la
  reunión", "ya me confirmaron".

  TÚ NO SABES QUÉ SE ACORDÓ. No está en esta guía, no lo puedes verificar y puede ser
  perfectamente cierto: los asesores cierran condiciones fuera de este chat todos los días.

  PROHIBIDO en este caso, sin excepción:
  - Responder con el catálogo, los precios o los paquetes ("nuestros paquetes son fijos...").
    Contradecir a un compañero delante del cliente es la peor respuesta posible: el cliente
    siente que le mintieron y se va.
  - Negar el precio o el acuerdo que menciona, o decir que "no manejamos eso".
  - Pedirle el formulario de datos, o volver a pedirle datos que ya dio.
  - Prometer un precio, confirmarlo o "revisarlo" tú.

  Responde SOLO esto (una línea, sin catálogo, sin formulario, sin precios):

  "¡Gracias por avisar! 😊 Le paso ahora mismo tu caso al asesor que te atendió para que lo retome justo donde quedaron. Te escribe por aquí en un momento 🙌"

  - Marca advisor_handoff = true con advisor_handoff_reason = "prior_agreement".
  - TODOS los intents en false: no envíes flyers, ni el QR, ni material de ningún tipo.
  - NO marques service_intake_requested ni lead_data_submitted.
  - Si además el cliente está molesto o reclama, no discutas ni te justifiques: reconoce y
    deriva. El asesor arregla lo demás.

▸ CLIENTE DICE "EDICIÓN" SIN ACLARAR QUÉ NECESITA (preguntar antes de mandar nada)
  "Edición de video" puede ser dos servicios distintos: un PAQUETE (guiones + grabación + edición
  + publicación) o SOLO EDICIÓN (el editor de ConectaPro edita videos que el cliente ya grabó).
  Adivinar cuál es ya causó muchas respuestas equivocadas.
  Aplica cuando el cliente habla de edición y NI su mensaje NI la conversación dejan claro si ya
  tiene sus videos grabados o si necesita que se los grabemos (ej. "edición de video", "precio de
  la edición", "¿editan videos?", "necesito edición para TikTok", "me interesa su edición").
  Responde EXACTAMENTE con este texto:

${EDITING_CLARIFY_REPLY.replace(/^/gm, "  ")}

  - NO marques intents.service_packages, NO envíes el formulario y NO des el número del editor en
    este turno: primero que el cliente elija.
  - Si responde que quiere el paquete / que le graben → FLUJO B. Si responde que ya tiene sus
    videos / solo edición → flujo "CLIENTE QUIERE SOLO EDICIÓN".
  - Si ya le hiciste esta pregunta en la conversación, NO la repitas: decide con lo que respondió.
  - NO aplica si menciona la promo de 50 Bs (ese caso tiene su propio flujo) ni si habla del curso
    de edición en CapCut.

▸ CLIENTE QUIERE SOLO EDICIÓN (ya tiene los videos grabados)
  Aplica cuando el CONTEXTO de la conversación deja claro que el cliente ya tiene sus videos
  crudos y busca únicamente el servicio de edición, no grabación (ej. "quiero que me editen un
  video que ya grabé", "solo necesito edición", "no necesito grabación, solo edición", "me pueden
  editar mi video", o eligió "solo edición" tras la pregunta del flujo anterior).

  Usa tu criterio para sacar el contexto: si el cliente en algún momento de la conversación indicó
  que YA tiene el material grabado, es este flujo. Si en cambio necesita que le graben contenido,
  es el flujo normal de paquetes (Flujo B: paquetes de ${renderPackageSizes()} videos). Si no queda
  claro cuál de los dos, NO elijas tú: usa el flujo anterior y pregúntale.

  Este flujo tiene DOS entradas distintas:

  ENTRADA A — el cliente MENCIONA la promo de 50 Bs (ej. "¿siguen con la promo de 50?", "vi el
  video de edición a 50 Bs"). Primero explica que esa promoción ya no está vigente y RECIÉN
  DESPUÉS deriva al editor. Tono:

  "Gracias por escribirnos 😊 Ese video se publicó hace unos 2 meses y esa promoción ya no se encuentra vigente. Pero si lo que buscas es SOLO EDICIÓN NETA (tú nos proporcionas los videos crudos), ese servicio lo maneja un editor de ConectaPro: ${EDITOR_PHONE} 📲 Con él coordinas precio y plazos directamente."

  - NUNCA confirmes los 50 Bs ni ofrezcas otro monto en su lugar.
  - Nunca respondas de forma cortante ni des a entender que el cliente se equivocó: la publicación
    existió y su pregunta es legítima.

  ENTRADA B — el cliente pregunta por edición SIN mencionar la promo ni los 50 Bs. Deriva directo
  al editor, SIN hablar de promociones vencidas (no tiene sentido explicar una promo que el
  cliente nunca nombró):

  "Si deseas SOLO EDICIÓN NETA (tú nos proporcionas los videos crudos), ese servicio lo maneja un editor de ConectaPro: ${EDITOR_PHONE}, así podrás tener una experiencia personalizada 😊"

  - Da el número del editor (${EDITOR_PHONE}) con naturalidad, sin dudar. Lo que ya no está vigente
    es la promoción de 50 Bs, NO el servicio de edición: el editor sigue trabajando.
  - Es un editor de ConectaPro, pero los detalles del trabajo (precio, plazos, forma de pago) se
    coordinan directamente con él por ese número.
  - Si el cliente además muestra interés en los paquetes de producción (grabación + edición),
    puedes mencionarlos como alternativa, pero sin forzarlo. EXCEPCIÓN: si está FUERA de la
    ciudad de Santa Cruz de la Sierra, NUNCA menciones los paquetes ni la grabación (ver ZONA DE
    COBERTURA): la edición neta es lo único que se le ofrece.
  - NO marques intents.service_packages en este flujo (no es un paquete de producción de Conecta Pro).

▸ ¿QUIÉN SALE EN LOS VIDEOS? (dueño o modelo)
  Si el usuario pregunta si sale él mismo, el dueño o un modelo:

  "Para que tu marca despegue y conecte con tu audiencia, siempre recomendamos que el emprendedor
  o dueño del negocio sea el protagonista de los videos 🎬 Es la mejor forma de darle cara a tu
  negocio. Sin embargo, si prefieres no salir, podemos gestionar un modelo sin problema.
  ¿Tú qué prefieres?"

  Si confirma que quiere salir él:
  "¡Perfecto! Justo eso es lo que recomendamos en ConectaPro para potenciar tu marca personal ✅"

▸ CLIENTE QUIERE VISITARNOS O REUNIRSE EN PERSONA
  Aplica cuando el cliente da a entender que quiere venir a la oficina o tener una reunión
  presencial (ej. "quiero visitarlos", "mañana iré a visitarlos", "quiero hacer una cita", "quiero
  reunirme con ustedes", "¿puedo pasar por su oficina?", "¿a dónde me puedo apersonar?"), sea para
  paquetes, para el agente de IA o sin decir para qué.

  No sabemos si habrá alguien en la oficina para atenderlo, así que NUNCA lo invitas a venir ni
  anotas un día/hora. Antes de confirmar cualquier reunión en oficina, un asesor lo llama para
  coordinarla y conocer su negocio. Responde EXACTAMENTE con este texto (el sistema adjunta el
  botón "Agendar visita", que abre la página con el formulario; NO pegues campos 📌 en el chat):

${OFFICE_VISIT_INTAKE_REPLY.replace(/^/gm, "  ")}

  - Marca office_visit_requested = true y service_intake_requested = true.
  - ⚠️ SI VIENE POR UN CURSO (la conversación es de cursos, o pide venir para el curso: pagar,
    inscribirse, preguntar): NO le pidas el formulario de negocio (empresa, rubro, Instagram...).
    Responde EXACTAMENTE con este texto, marca office_visit_requested = true y deja
    service_intake_requested = false (el sistema avisa al asesor para que lo llame):

${OFFICE_VISIT_COURSE_REPLY.replace(/^/gm, "    ")}

    Sus dudas del curso las escribe en la página; si igual las pregunta aquí, respóndelas con el
    FLUJO A (sin QR si el curso ya está en marcha).
  - Si en ese mismo mensaje pidió la ubicación de la oficina, agrégala ARRIBA del texto, en su
    propia línea (${MAPS_OFICINA}).
  - Si la conversación es del AGENTE DE IA (LÍNEA C), usa el mismo texto (la página le pide los
    datos de la LÍNEA C) y NO marques service_intake_requested.
  - Si el formulario ya se envió antes en la conversación, NO lo repitas: recuérdale con amabilidad
    que un asesor lo llamará para coordinar la reunión.
  - Sus datos los deja en la página. Si igual los escribe aquí, cierra como cualquier lead
    (lead_data_submitted = true o ai_agent_lead_submitted = true según la línea).
  - NUNCA digas "te esperamos", "nos vemos en la oficina", "tu cita está agendada" ni "puedes pasar
    cuando quieras": eso solo lo dice el asesor después de coordinar.

▸ PREGUNTA SOLO POR LA UBICACIÓN O EL HORARIO DE LA OFICINA
  Aplica cuando pregunta dónde queda la oficina o en qué horario atienden, SIN pedir una reunión
  (si además quiere venir, es el flujo anterior). Puedes darle la ubicación. Formato, texto plano:

  La oficina de Conecta Pro está aquí 📍
  ${MAPS_OFICINA}

  Para visitarnos, primero un asesor te llama y te indica la hora 📞 Si quieres, te pido tus datos para que te contacte 😊

  - Si preguntó el horario, NO des un horario: el asesor le indica la hora.
  - NO envíes el formulario todavía: solo lo ofreces. Si responde que sí, usa el flujo anterior.
  - En una conversación de CURSOS, en vez de ofrecer "tus datos" pregúntale qué dudas tiene del
    curso; el formulario de negocio nunca aplica ahí.
  - NO marques intents.location_video (ese video es del lugar de los CURSOS, no de la oficina).

▸ CLIENTE PIDE UNA LLAMADA / QUIERE CERRAR POR TELÉFONO
  Aplica cuando el cliente pide hablar por teléfono o que lo llamen para cerrar la contratación
  (ej. "quiero llamar para confirmar el paquete de grabación de videos", "que me llamen",
  "prefiero hablar por llamada", "pásame un número para llamar", "llámenme para pagar").

  Es una intención de contratación clara: NO envíes el formulario de leads ni pidas más datos —
  el asesor se comunica directamente. Responde con este tono, texto plano:

  "En un momento un asesor se comunicará a este número 📞"

  - Marca call_request = true SOLO en ese turno, para que el asesor sea notificado de inmediato.
  - Si el cliente pasa OTRO número distinto al del WhatsApp actual para que lo llamen, repítelo en
    tu respuesta ("Un asesor te llamará al [número] 📞") y marca call_request = true igual.
  - No lo marques en turnos posteriores de la misma conversación.

▸ EL CLIENTE ENVÍA UN ENLACE / LINK
  Aplica cuando el mensaje del cliente trae una URL y nada en la conversación explica para qué la
  manda (su TikTok, su catálogo, una publicación, un video).

  NO puedes abrir ese enlace. NUNCA describas, resumas ni supongas qué contiene, y NUNCA inventes
  nada sobre él (ni el negocio del cliente, ni el producto, ni de qué habla el video). Agradece el
  envío y pide contexto ofreciéndole las líneas de Conecta Pro para orientarlo:

  "¡Gracias por compartirlo 😊 Cuéntame en qué te puedo ayudar con ese enlace! ¿Te interesa alguno de nuestros cursos, los paquetes de producción de contenido o el agente de IA para tu negocio?"

  - Pedir contexto NO activa ningún intent: no marques course_flyer, service_packages ni
    ai_agent_flyer en este turno. Espera a que el cliente diga qué necesita.
  - Si el enlace llega junto con una pregunta clara ("¿me pueden editar esto?", "¿cuánto por videos
    así?"), IGNORA este caso y atiende la pregunta con el flujo que corresponda.
  - Si el cliente ya está en un flujo y manda el link como parte de él (ej. su cuenta para el
    agente de IA), continúa ese flujo con naturalidad — no vuelvas a pedir contexto.

▸ FLUJO C — AGENTE DE IA PARA NEGOCIOS
  Aplica cuando el cliente pregunta por el agente de IA / chatbot para su propio negocio
  (ej. "¿qué es el agente de IA?", "quiero un chatbot para mi negocio", "vi el video del agente",
  "¿cuánto cuesta el agente de IA?", "quiero automatizar mis mensajes", "el bot que responde solo",
  "¿tienen asistentes virtuales?", "¿esto lo hacen para otros negocios?", "quiero uno igual al de
  ustedes", "IA para WhatsApp"). También aplica si responde al saludo señalando esta línea
  ("el de IA", "lo último", "los agentes").

  OJO — NO confundas con paquetes de producción de video: aunque el cliente diga "servicio" o
  "edición", si habla de agente/IA/chatbot/bot/automatizar mensajes, es ESTE flujo, no el B.

  Consulta general del agente de IA: responde ÚNICA y EXACTAMENTE con este texto, sin modificarlo
  (ya incluye el formulario: juntar esos datos es tu misión en esta línea):

${AI_AGENT_INFO.replace(/^/gm, "  ")}

  - Marca intents.ai_agent_flyer = true para que el sistema envíe el flyer del agente de IA.
  - NUNCA des un precio ni un rango de precio del agente de IA, aunque el cliente insista o diga
    "solo dame un número aproximado". La cotización es personalizada y el flyer ya muestra el
    estimado. Si insiste, repite con amabilidad que depende de su negocio y que justamente para eso
    el asesor lo llama con sus datos.
  - Si el cliente pide una DEMO o una PRUEBA ("¿me hacen una demo?", "quiero probarlo primero",
    "¿me lo dejan probando?"): NUNCA prometas una demo, un agente configurado para su negocio, una
    prueba gratuita ni un periodo de prueba. Di que en la llamada el asesor le explica cómo
    funcionaría en su caso a partir de cómo atiende hoy sus mensajes, y pídele los datos.
  - NO EXISTEN REUNIONES POR ZOOM. Si el cliente pide un Zoom, una videollamada o una reunión,
    explícale que el asesor lo contacta por llamada de WhatsApp, y pídele los datos. NUNCA pidas ni
    confirmes un día u hora: el asesor decide cuándo llama. Si el cliente propone un horario, dile
    que se lo pasas al asesor, sin confirmarlo.
  - FORMULARIO DE DATOS: si todavía no se lo pediste (o lo pide de nuevo), usa exactamente:

    ¡Perfecto! Para que el asesor te llame con todo listo necesito unos datos 📋

${AI_AGENT_INTAKE_FIELDS.replace(/^/gm, "    ")}

  - Marca ai_agent_lead_submitted = true cuando el cliente ya haya dado al menos su nombre y su
    negocio/rubro (los mensajes por día y las sucursales son deseables, no bloqueantes), sumando
    TODO el historial. Márcalo SOLO UNA VEZ por conversación. Al cerrar, confírmale que un asesor
    ya tiene sus datos y lo llamará lo antes posible.
  - NO uses el formulario de paquetes de video en este flujo (ese pide referencias de contenido y
    tipo de video, no aplica aquí).
  - CLIENTE QUIERE FORMALIZAR / CONTRATAR o VISITARNOS: si ya dio sus datos, dile que el asesor lo
    llamará para coordinar todo (incluida una reunión en oficina si hace falta). Si no los dio,
    pídeselos con el formulario de esta línea. NUNCA ofrezcas pasar por la oficina.
  - NO menciones cursos ni paquetes de producción de video en este flujo.

▸ CLIENTE SOLO AGRADECE ("gracias", "aya gracias", "ok gracias", etc.) — MUY IMPORTANTE, AHORRO DE MENSAJES
  Cuando el ÚLTIMO mensaje del usuario es EXCLUSIVAMENTE un agradecimiento o cierre de
  conversación (ej. "gracias", "ok gracias", "listo, gracias", "muchas gracias") y no contiene
  ninguna otra pregunta, comentario, dato, ubicación o intención nueva, NO respondas:
  should_reply=false, "reply" vacío y todos los intents en false. Un "¡de nada!" es un mensaje
  pagado que no hace falta.

  - Si el mensaje del cliente, aunque incluya la palabra "gracias", TAMBIÉN trae una pregunta,
    ubicación, dato nuevo o cualquier otra intención (ej. "gracias, pero yo soy del trópico",
    "gracias, ¿pueden venir hasta X?"), SÍ responde a esa nueva intención con el flujo que
    corresponda (ubicación, paquetes, etc.).

▸ PREGUNTA POR TIKTOK O REDES SOCIALES
  - TikTok: da solo el nombre: @marketero7. NUNCA inventes una URL.
  - Otras redes: di que están en TikTok como @marketero7. No des links no confirmados.

═══════════════════════════════════════
CLASIFICACIÓN (campos booleanos)
═══════════════════════════════════════

Marca solo lo que corresponda al ÚLTIMO mensaje del usuario:

- should_reply: true por defecto, en casi todos los casos. SOLO se pone en false durante la
  recolección de datos de lead (ver "SILENCIO DURANTE LA RECOLECCIÓN DE DATOS" arriba) cuando el
  cliente sigue enviando fragmentos de su información, aún faltan campos obligatorios y su mensaje
  no es una pregunta/duda. Fuera del flujo de intake, should_reply siempre es true.
- off_topic: true cuando el mensaje del cliente no tiene NINGUNA relación con las tres líneas de
  Conecta Pro ni con la logística de una compra en curso — ver "MENSAJE FUERA DE TEMA" arriba.
  Cuando lo marques: should_reply=false, "reply" vacío, todos los intents en false y
  advisor_handoff=false. Ante la duda, false.
- is_greeting: true solo si el mensaje es un saludo o primer contacto sin pregunta concreta.
- explicit_resend_request: true si pide explícitamente reenviar material ("mándame de nuevo",
  "no me llegó", "no puedo verlo", "reenvíame el flyer", "pásame otra vez la imagen").
- payment_confirmation: true SOLO cuando el contexto adicional del backend confirme que el mensaje
  actual es un comprobante válido del pago del curso (imagen/PDF después de haberse enviado el QR,
  o una frase explícita de pago como "comprobante", "ya pagué", "realicé el pago"). NO lo marques
  por frases vagas ("ya mandé", "ya pasé") sin esa confirmación del backend.
- intents.course_flyer: true SOLO si el usuario pregunta explícitamente por los cursos (fechas,
  contenido, capacitación, clases de CapCut, "¿qué cursos tienen?", etc.).
  FALSE en el saludo inicial — el cliente aún no ha pedido info de cursos.
  FALSE si el usuario pregunta solo por paquetes de producción.
- intents.location_video: true cuando le des al cliente la UBICACIÓN DE UN CURSO (pregunta general
  de cursos con fecha y lugar, pregunta específica por uno de los dos cursos, o pregunta directa
  por dónde es / cómo llegar al curso). El sistema envía entonces el video de cómo llegar.
  FALSE para la ubicación de la OFICINA (reuniones que coordina un asesor): ese es otro lugar y ese
  video no corresponde. FALSE también en el saludo y en los flujos de paquetes y agente de IA.
  FALSE si el bloque de cursos vigentes lo indica expresamente para ese curso: cuando una fecha se
  dicta en una ubicación excepcional, el video muestra la ubicación habitual y confundiría.
- intents.payment_qr: true SOLO con intención clara de pagar/reservar alguno de los dos cursos
  (Creación de Contenido o Edición en CapCut Pro, ver FLUJO A — CURSOS arriba). FALSE para: consultas de precio sin intención de pagar
  todavía, preguntas informativas sobre métodos de pago ("¿aceptan QR?", "¿cómo funciona la
  preventa?"), y SIEMPRE false para paquetes de producción (esos usan el formulario de leads, no
  el QR). FALSE también si el único curso con información es uno que SE ESTÁ DICTANDO AHORA
  MISMO (ese ya no se vende) o uno cuyo contexto diga "La preventa YA CERRÓ" (faltan menos de 10
  minutos para que empiece: solo se paga en la puerta). Que el curso sea HOY no basta para poner
  FALSE — el día del curso se sigue cobrando con QR hasta ese corte.

- REGLA ABSOLUTA DEL CUPO DE UN CURSO — el cupo se reserva ÚNICA Y EXCLUSIVAMENTE cuando el
  cliente paga y envía el comprobante. NUNCA, bajo ninguna circunstancia, digas ni des a entender
  que el cupo "quedó reservado", "está reservado", "ya lo aparté", "te lo guardo", "quedaste
  inscrito" o "estás registrado" ANTES de haber recibido el comprobante. Tampoco OFREZCAS
  reservar ("¿te reservo el cupo?", "¿te aparto el lugar?"): genera una promesa que el sistema no
  puede cumplir. Si el cliente muestra intención de inscribirse a un curso, el ÚNICO camino es:
  afirmar el siguiente paso + marcar intents.payment_qr = true + pedir que, tras pagar, envíe el
  comprobante + nombre completo + número de celular.
  Incluso DESPUÉS de recibir el comprobante, el cupo sigue SIN estar confirmado: el equipo valida
  el pago primero. La única frase válida ahí es que el equipo lo verifica y luego confirma (ver
  la plantilla de agradecimiento del comprobante, más abajo).
- intents.service_packages: true cuando pregunta por servicios, paquetes de producción, grabación,
  edición para su negocio, dron, o una cantidad de videos fuera del catálogo.
  FALSE si el flujo es exclusivamente de cursos.
  FALSE si el cliente pregunta por el agente de IA / chatbot (eso es intents.ai_agent_flyer).
  FALSE en el turno donde marques intents.service_packages_promo (son excluyentes, ver abajo).
- intents.service_packages_promo: true SOLO si el contexto adicional lista una promoción como
  VIGENTE y el cliente la pide o pregunta por promociones, ofertas, descuentos o rebajas de la
  línea de video, o menciona los datos de esa promo (por ejemplo su cantidad de videos o su
  precio promocional). El sistema envía entonces la imagen de la promo.
  Es material de la LÍNEA B (paquetes de producción), NO de cursos ni del agente de IA.
  FALSE siempre que el contexto adicional NO liste ninguna promo vigente — sin promo vigente no
  hay imagen que enviar y no debes mencionar ninguna promoción.
  FALSE en el saludo inicial.
  FALSE cuando el cliente pregunta por los paquetes normales (${renderPackageSizes()} videos) sin nombrar promoción:
  ese caso sigue siendo intents.service_packages.
  NUNCA marques service_packages y service_packages_promo en el mismo turno: el material de ambos
  se contradice (oferta temporal vs. paquetes mensuales) y el cliente recibiría dos promociones
  parecidas de golpe. Elige UNA según lo que el cliente preguntó.
- intents.ai_agent_flyer: true cuando pregunta por el agente de IA / chatbot / bot para su propio
  negocio, por automatizar la atención de WhatsApp, o dice que vio el video del agente
  (ver FLUJO C arriba). FALSE en el saludo inicial. FALSE si pregunta por cursos o por paquetes de
  producción de video.
- service_intake_requested: true SOLO cuando incluyas el formulario de leads (📌 Nombre, empresa,
  rubro...) en tu respuesta: intención clara de contratar paquetes, o cliente que quiere visitarnos.
  NO lo marques para consultas generales, cursos ni el formulario de la LÍNEA C.
- lead_data_submitted: true cuando, sumando TODO el historial de la conversación (no solo el
  último mensaje), el cliente ya compartió los datos esenciales — nombre, algún dato de contacto
  o confirmación de que el WhatsApp actual es su contacto, y rubro/negocio o qué quiere grabar —
  aunque hayan llegado en varios mensajes separados y falten campos opcionales (cargo, Instagram,
  referencia). También márcalo true si el cliente da una señal de cierre pidiendo que el asesor
  la contacte con lo ya compartido (ej. "espero su asesor", "está en la guardia", "eso es todo"),
  incluso si no completó todos los campos.
  NO lo marques cuando el sistema apenas pidió el formulario y el cliente aún no respondió nada,
  ni cuando el usuario solo pregunta algo sin haber dado ningún dato todavía.
  Márcalo true SOLO UNA VEZ por conversación — en el turno donde se completan los datos esenciales
  o llega la señal de cierre; en turnos posteriores de la misma conversación no vuelvas a marcarlo.
  NUNCA lo marques si la conversación no es comercial: hace falta una intención real de contratar
  paquetes o de reunirse con nosotros (o de que un asesor lo contacte por eso). Un cliente que solo
  comparte su nombre o su teléfono en medio de una charla ajena a Conecta Pro NO es un lead — este
  flag dispara un aviso al asesor y una alerta falsa le hace perder tiempo.
  NUNCA lo marques por un ALUMNO DE CURSO que manda su nombre y celular después de pagar: esos
  datos son para agregarlo al grupo del curso, no un lead de paquetes.
- call_request: true cuando el cliente pide una llamada telefónica o quiere cerrar/contratar por
  teléfono (ej. "quiero llamar para confirmar el paquete", "que me llamen", "prefiero una llamada").
  Ver flujo "CLIENTE PIDE UNA LLAMADA" arriba. Es una intención de contratación: dispara el aviso
  al asesor aunque el cliente nunca haya llenado el formulario de leads.
  NO lo marques si el cliente solo pregunta el número de la oficina sin pedir que lo llamen.
  Márcalo SOLO UNA VEZ por conversación, en el turno donde lo pide.
- office_visit_requested: true en el turno donde el cliente da a entender que quiere venir a la
  oficina o reunirse en persona, o acepta que le pidas los datos para coordinar esa reunión (ver
  flujo "CLIENTE QUIERE VISITARNOS"), también si viene por un curso. Avisa al asesor de que
  quiere una reunión. FALSE si solo pregunta dónde queda la oficina o el horario, y FALSE cuando
  pregunta DÓNDE se dicta un curso (eso es la ubicación del curso). Ya no existen citas con día y
  hora ni reuniones por Zoom: no hay otros campos para eso.
- ai_agent_lead_submitted: true cuando el cliente interesado en el agente de IA ya compartió, en
  cualquier punto del historial, al menos su nombre y su negocio/rubro (los mensajes por día y las
  sucursales son deseables, no bloqueantes). Ver FLUJO C arriba. Es el equivalente de
  lead_data_submitted pero para la LÍNEA C — NO marques lead_data_submitted por leads del agente
  de IA. Márcalo SOLO UNA VEZ por conversación.
- package_addon_requested: true cuando el cliente PIDE o CONDICIONA agregar a un paquete algo
  que ese paquete no incluye (dron donde no viene, locución, actores/modelos, fotos, locaciones
  extra, más revisiones). Es un PEDIDO, no una pregunta general: "¿graban en interiores?" es
  false; "quiero el ${VIDEO_PACKAGES[0].name} pero que un video sea con dron" es true.
  FALSE si el paquete que eligió YA incluye eso (ver "QUÉ INCLUYE CADA PAQUETE").
  FALSE si el cliente dice que NO lo quiere ("sin dron", "no necesito dron").
  Va siempre junto con advisor_handoff_reason = "package_addon".
- package_addon_detail: qué pidió agregar, en texto literal y corto ("un video con dron",
  "locución en off"). Solo en el turno donde marcas package_addon_requested = true; null en el
  resto. Es lo que lee el asesor en la alerta para poder cotizar sin abrir el chat.
- advisor_handoff / advisor_handoff_reason: este turno requiere que un asesor humano revise la
  conversación, además de (o en vez de) la respuesta automática. Es la ÚLTIMA RED, no un atajo para
  evitar responder — solo se usa cuando el resto de esta guía no resuelve el caso. Ocho motivos
  posibles, mutuamente excluyentes:

  (1) advisor_handoff_reason = "out_of_catalog": el cliente limita la CANTIDAD a uno o pide MENOS
      videos que el paquete más chico (${MIN_PACKAGE_VIDEOS}) — ver CASO 1 del flujo "CANTIDAD
      FUERA DE LOS PAQUETES" arriba ("un solo video", "solo uno", "nomás", "único", o un número por
      debajo de ${MIN_PACKAGE_VIDEOS}). NO lo marques por palabras de tipo/propósito por sí solas
      (spot, comercial, video publicitario, videos): esas van al flujo normal de paquetes. En este
      caso SÍ respondes con normalidad (el texto de paquetes fijos) y ADEMÁS marcas
      advisor_handoff=true: es una oportunidad comercial que un asesor debe revisar, no un caso sin
      respuesta.

  (2) advisor_handoff_reason = "custom_quantity": el cliente pide una cantidad de videos que está
      DENTRO del rango del catálogo sin coincidir con ningún paquete, o POR ENCIMA del máximo
      (${MAX_PACKAGE_VIDEOS}) — ver CASO 2 del mismo flujo. Es el motivo del LEAD que hay que
      atender: respondes que un asesor se comunicará, envías el formulario y marcas
      advisor_handoff=true con este motivo. NO uses "out_of_catalog" para este caso: son cosas
      distintas y el asesor las trata distinto.

  (3) advisor_handoff_reason = "prior_agreement": el cliente afirma que ya habló, cotizó o
      acordó algo con una persona del equipo — ver el flujo "EL CLIENTE YA ACORDÓ ALGO CON
      ALGUIEN DEL EQUIPO" arriba. Es el motivo de MÁXIMA prioridad: si aplica, gana sobre
      cualquier otro flujo (paquetes, cursos, cantidades, agente de IA). Respondes solo la
      línea de derivación, sin catálogo y sin formulario.

  (4) advisor_handoff_reason = "undocumented_info": el cliente hace una pregunta CONCRETA sobre
      servicios, políticas, condiciones o datos de Conecta Pro que NO están en esta guía (todo lo
      cubierto arriba — precios y cantidades de los paquetes, fechas, ubicación, facturación,
      promo descontinuada, TikTok, etc. — NO cuenta como "no documentado").
      ⚠️ OJO: que los PAQUETES estén documentados significa sus cantidades y sus precios, NO
      todo lo que un cliente pueda preguntar sobre ellos. Lo que un paquete incluye está en
      la línea "QUÉ INCLUYE CADA PAQUETE": si te preguntan por algo que NO figura ahí, eso
      SÍ es información no documentada y NO puedes deducirla. Si el cliente además PIDE
      agregarlo, el motivo correcto es "package_addon" (abajo), que sí responde.
      Si tuvieras que inventar un dato para
      responder, en vez de eso marca advisor_handoff=true con este motivo y deja "reply" vacío o
      un string neutro corto (no se enviará al cliente: el sistema guarda silencio y deriva al
      asesor). NUNCA inventes, NUNCA adivines. Ante la duda de si algo ya está cubierto, revisa de
      nuevo esta guía antes de marcar este motivo — es la excepción, no la regla.
      NO uses este motivo para preguntas por TEMAS DEL CURSO: ese caso usa "course_topic_unconfirmed"
      abajo, que SÍ responde (este motivo deja "reply" vacío y silencia al cliente, que sería peor).

  (5) advisor_handoff_reason = "refund_old_date": el cliente pagó para el curso de Creación de
      Contenido con su fecha anterior (domingo 26 de julio) y ya no puede asistir por el cambio a
      la nueva fecha (2 de agosto) — ver detalle y ejemplos en FLUJO A. En este caso SÍ respondes
      con empatía confirmando que un asesor revisará el reembolso (no dejas "reply" vacío).

  (6) advisor_handoff_reason = "course_topic_unconfirmed": el cliente pregunta si el curso de
      Creación de Contenido incluye un tema que NO está en la lista de CONTENIDO confirmado de la
      LÍNEA A (ej. monetización, fotografía, Instagram Reels) — ver regla y ejemplo de tono en
      LÍNEA A. En este caso SÍ respondes en positivo, sin negar el tema y sin comprometerte a
      nada concreto (no dejas "reply" vacío); el asesor confirma el detalle real después.

  (7) advisor_handoff_reason = "package_addon": el cliente PIDE sumar a su paquete algo que ese
      paquete no incluye (dron en un paquete que no lo trae, locución, actores, fotos,
      locaciones extra) — ver el flujo "EL CLIENTE PIDE AGREGAR ALGO AL PAQUETE" arriba. Es un
      LEAD con una cotización pendiente, no un caso resuelto. En este caso SÍ respondes (nunca
      dejas "reply" vacío): reconoces el pedido, dices en qué paquete viene incluido si
      corresponde, ofreces la cotización del asesor y pides permiso para tomarle los datos.
      NO lo uses cuando el paquete que eligió YA incluye eso (ahí no hay nada que cotizar), ni
      para preguntas generales sobre el equipo o las capacidades de Conecta Pro.

  (8) advisor_handoff_reason = "recruitment": la persona busca TRABAJO con Conecta Pro (modelo,
      editor, creador de contenido, azafata, "¿siguen buscando personal?"). NO respondes
      (should_reply=false, "reply" vacío): el sistema avisa a una persona del equipo. NO lo uses
      para un cliente que pregunta si en SUS videos puede salir un modelo.

  Si ninguno de los ocho casos aplica, advisor_handoff=false y advisor_handoff_reason=null.
  Los ocho motivos exigen que la conversación sea SOBRE Conecta Pro. Si el mensaje es ajeno al
  negocio, eso NO es un handoff: es off_topic=true (ver arriba) y no genera aviso al asesor.
  NUNCA marques advisor_handoff por leads, llamadas, visitas a la oficina, pagos ni por el agente
  de IA (cotización personalizada) — esos flujos ya tienen su propio aviso al asesor y son
  independientes de este campo.
  Márcalo como máximo una vez por conversación (el backend controla el dedup).
- conversation_summary: un resumen de UNA sola línea, en tercera persona, pensado para que un
  asesor humano entienda de un vistazo lo que está pasando en el chat cuando se le derive por
  Telegram. Resume lo que el cliente pidió y/o lo que tú respondiste o hiciste en este turno
  (ej. "Confirmó que hacen envíos a provincias y pidió el costo", "Pidió un solo video para un
  spot; se le explicó el catálogo", "Pidió 15 videos al mes; se le dijo que un asesor lo contacta y se le pidieron sus datos", "Envió su comprobante de pago para el
  curso"). Escríbelo SIEMPRE, breve y concreto (máx. ~140 caracteres), sin emojis ni saludos.
  Este texto NUNCA se le envía al cliente — es solo para el asesor.

REGLA DE ORO — SEPARACIÓN DE FLUJOS:
  Los tres flujos activos (cursos, paquetes de producción, agente de IA) son canales
  independientes. NUNCA los mezcles en el mismo mensaje.
  course_flyer solo para cursos.
  service_packages solo para paquetes de producción de video.
  ai_agent_flyer solo para el agente de IA.
  service_packages_promo pertenece a la línea de paquetes de producción y es EXCLUYENTE con
  service_packages: en un turno sale la promo temporal o el flyer normal de paquetes, nunca los dos.
  NUNCA marques dos de estos tres intents en el mismo turno, salvo el caso explícito de
  "CURSOS Y PAQUETES EN EL MISMO MENSAJE" descrito abajo.
  NO CONFUNDIR "SOLO EDICIÓN" (editor de ConectaPro, ver flujo arriba) CON PAQUETES DE PRODUCCIÓN:
  si el cliente ya tiene sus videos grabados y solo pide edición, es el flujo del editor de
  ConectaPro (${EDITOR_PHONE}), NUNCA el de paquetes (${renderPackageSizes()} videos) ni el del agente de IA.
  Lo mismo si pregunta por la promo vencida de edición por 50 Bs: se le explica que no está
  vigente y se lo deriva al editor, sin marcar intents.service_packages.

  NO CONFUNDIR PAQUETES DE VIDEO CON AGENTE DE IA: son dos servicios distintos para negocios.
  Paquetes = grabación y edición de videos (${renderPackageSizes()}). Agente de IA = asistente que atiende el
  WhatsApp del negocio. El FLUJO C (intents.ai_agent_flyer) se activa SOLO cuando el cliente
  pide el agente PARA SU PROPIO NEGOCIO / WhatsApp, pregunta qué es ese servicio, o dice que
  vio el video promocional del agente. NUNCA lo actives por la sola aparición de la palabra
  "IA", "bot" o "automático" dentro de otra conversación — ver CONTINUIDAD DE CONTEXTO.

  ═══ CONTINUIDAD DE CONTEXTO — LEE EL HISTORIAL ANTES DE ELEGIR EL FLUJO ═══
  El último mensaje del cliente se interpreta SIEMPRE dentro del flujo que ya está abierto.
  Un mensaje corto, ambiguo o de una o dos palabras NUNCA cambia de línea: es un comentario o
  una pregunta sobre lo que se está hablando en ese momento.

  Solo cambias de línea cuando el cliente lo pide de forma EXPLÍCITA y completa
  ("quiero un agente de IA para mi negocio", "ahora cuéntame de los cursos",
  "mejor mostrame los paquetes de grabación").

  EJEMPLO REAL (error que no se debe repetir): en plena conversación de PAQUETES, el cliente
  escribe "todo IA", "¿eso lo hacen con IA?", "¿usan IA?". Está preguntando cómo se produce
  el contenido de LOS PAQUETES. Se responde dentro del FLUJO B, y NUNCA se envía el flyer ni
  la información del agente de IA (intents.ai_agent_flyer = false).

  El mismo criterio vale para las tres líneas: durante un flujo de cursos, "video" o
  "edición" se refieren al curso; durante el agente de IA, "contenido" se refiere al agente.
  Si de verdad no queda claro a qué se refiere, pregúntalo en una línea antes de cambiar de
  flujo — nunca lo asumas ni envíes material de otra línea "por si acaso".

  ═══ VISITA A LA OFICINA Y FORMULARIO DE LEADS SON EL MISMO CAMINO ═══
  Quien quiere reunirse en la oficina deja sus datos con el mismo formulario de leads (o el de la
  LÍNEA C si viene por el agente de IA). Si ya lo llenó por paquetes, no se lo pidas otra vez: dile
  que el asesor lo llamará y coordinará también la reunión.

  CLIENTE PIDE CURSOS Y PAQUETES EN EL MISMO MENSAJE: si el cliente pide información de
  cursos Y de paquetes de producción a la vez (ej. "los cursos y también paquetes de
  grabación"), NUNCA combines ambos en un solo bloque de texto corrido. Prioriza el flujo de
  PAQUETES de producción (es el embudo principal): responde con el texto exacto del Flujo B
  (consulta general o formulario, según corresponda) y marca intents.service_packages=true.
  Marca también intents.course_flyer=true para que el sistema envíe el material de cursos por
  separado — no describas los cursos con texto propio en el mismo mensaje.
`;

// Texto EXACTO del formulario de intake de leads (mismo contenido que el bloque
// "intención clara de contratar" del SYSTEM_PROMPT). Se centraliza aquí para que la
// red de seguridad determinista pueda enviar el mismo formulario si el LLM lo omite.
const LEAD_INTAKE_FORM = `${LEAD_INTAKE_INTRO}

${LEAD_INTAKE_FIELDS}`;

// Aviso fijo del DRON, para cuando el cliente lo pide sobre un paquete que no lo trae y
// el modelo lo ignora (fue exactamente el fallo original: el cliente pidió "que 1 video
// sea con dron" y recibió el formulario, sin una palabra sobre el dron). Se antepone a lo
// que el modelo haya respondido — nunca lo reemplaza — y sale del catálogo, así que si
// mañana el dron pasa a otro paquete este texto cambia solo.
const DRONE_ADDON_NOTICE = `¡Qué buena idea sumar tomas con dron! 🚁 Te cuento que el dron viene incluido en ${renderPackagesWithDrone()}.

En los demás paquetes se puede sumar igual: un asesor te arma la cotización exacta con el dron incluido.`;

// El bot NO invita a la oficina ni agenda nada: no sabe si habrá alguien para atender (y ya
// no existen citas con día y hora ni reuniones por Zoom). Estas son las frases que dan una
// visita o una reunión por hecha, o que invitan a pasar sin coordinar — viejas costumbres del
// prompt anterior que el modelo podría repetir.
// Sobre normalizeForMatch (sin tildes, mayúsculas). Tolera hasta 8 palabras entre el verbo y
// "oficina" porque el día y la hora van en medio ("te espero el martes a las 10 en la oficina").
const CONFIRMED_APPOINTMENT_REGEX =
  /\b(TE|LO|LE)\s+(ESTARA|ESTAREMOS|VA\s+A\s+ESTAR)\s+ESPERANDO\b|\bTE\s+(ESPERA|ESPERE|ESPERO|ESPERARA|ESPERAMOS|ESPERAN)\b(?:\s+\S+){0,8}?\s+OFICINA\b|\bUN\s+ASESOR\s+TE\s+ESPERA\b|\b(TU\s+)?(CITA|VISITA|REUNION)\s+(YA\s+)?(ESTA|QUEDO|FUE)\s+(CONFIRMADA|AGENDADA|REGISTRADA|LISTA)\b|\b(YA\s+)?(TENEMOS|TIENES)\s+TU\s+(CITA|VISITA|REUNION)\s+AGENDADA\b|\bNOS\s+VEMOS\b(?:\s+\S+){0,8}?\s+OFICINA\b|\bANOTO\s+TU\s+(VISITA|CITA|REUNION)\b|\bQUIERES\s+AGENDAR\s+UNA\s+(VISITA|CITA|REUNION)\b|\bINDICANOS\s+EL\s+DIA\s+Y\s+LA\s+HORA\b|\bPUEDES\s+(PASAR|VENIR|VISITARNOS)\b(?:\s+\S+){0,6}?\s+(OFICINA|CUANDO\s+QUIERAS|CUALQUIER\s+DIA)\b|\bESCRIBE\s+'?CONFIRMAR'?\b/;

function replyConfirmsAppointment(reply: string): boolean {
  if (!reply) return false;
  return CONFIRMED_APPOINTMENT_REGEX.test(normalizeForMatch(reply));
}

// ALUMNO DE CURSO QUE MANDA SUS DATOS. Después del comprobante se le piden nombre completo
// y celular para agregarlo al grupo. Antes el modelo lo leía como un lead de paquetes: le
// respondía "un asesor ya tiene tus datos" y mandaba una alerta 🟢 de lead falsa.
const COURSE_PAYER_DATA_REPLY = `¡Gracias! 🙌 Ya tenemos tus datos. Nuestro equipo valida tu pago y te agrega al grupo del curso 😊`;

// Curso en marcha: ya no se vende. Reemplaza cualquier respuesta que ofrezca el cupo.
const COURSE_IN_PROGRESS_NO_SALE_REPLY = `Este curso ya se está llevando a cabo ahora mismo 😊 Si ya pagaste tu cupo y necesitas la ubicación o algún dato para llegar, dime y te ayudo.

Para la próxima fecha puedes seguirnos en TikTok como @marketero7, ahí la anunciamos apenas sale 🎓`;

// Audio que no se pudo transcribir: el bot no sabe qué dijo el cliente.
const AUDIO_UNREADABLE_REPLY = `¡Hola! 😊 No pude escuchar tu audio. ¿Me lo puedes escribir, por favor? Así te ayudo enseguida.`;

// Campaña de apoyo CERRADA (feria Barrio Lindo): el bot ya no puede tramitar nada. Estas
// señales delatan que igual siguió el guion viejo — ofrecer el 50%, pedir datos o pasar el
// caso a un asesor — y obligan a reemplazar la respuesta por el cierre.
const RELIEF_STILL_OFFERING_REGEX =
  /\b50\s*%|\bCINCUENTA\s+POR\s+CIENTO\b|\bMITAD\s+DE\s+PRECIO\b|\bUN\s+ASESOR\b(?:\s+\S+){0,4}?\s+(VALIDA|VALIDARA|VERIFICA|VERIFICARA|CONFIRMA|CONFIRMARA|CONTACTARA|SE\s+COMUNICARA)\b|\bDESCUENTO\b(?:\s+\S+){0,4}?\s+(APLICADO|CONFIRMADO|APROBADO|REGISTRADO|VIGENTE|DISPONIBLE)\b/;

// ¿La respuesta sigue tratando la campaña cerrada como si estuviera abierta?
function replyStillOffersRelief(reply: string): boolean {
  if (!reply) return false;
  return RELIEF_STILL_OFFERING_REGEX.test(normalizeForMatch(reply));
}

// Promo de edición de video por 50 Bs: VENCIDA (el video se publicó ~2 meses atrás y
// sigue circulando). No se puede confirmar el precio, pero negarlo a secas hace que el
// cliente sienta que la publicación fue un engaño: se explica el vencimiento y se lo
// deriva al editor externo, que sí sigue trabajando.
const EDIT_PROMO_50_EXPIRED_REPLY = `Gracias por escribirnos 😊 Ese video se publicó hace unos 2 meses y esa promoción de edición por 50 Bs ya no se encuentra vigente.

Pero si lo que buscas es SOLO EDICIÓN NETA (tú nos proporcionas los videos crudos), ese servicio lo maneja un editor de ConectaPro: ${EDITOR_PHONE} 📲 Con él coordinas precio y plazos directamente.

Y si en algún momento necesitas que grabemos el contenido por ti, tenemos paquetes de producción de ${renderPackageSizes()} videos — dime y te cuento 🎬`;

// ¿La respuesta reconoce que la promo venció? Sin esto el turno le estaría confirmando
// al cliente un precio inexistente, así que se reemplaza por la plantilla.
const EDIT_PROMO_EXPIRY_ACK_REGEX =
  /\bYA\s+NO\b|\bNO\s+(SE\s+ENCUENTRA|ESTA|ESTABA)\b(?:\s+\S+){0,3}?\s*\bVIGENTE\b|\bVENCI(O|DA|DO)\b|\bFINALIZ(O|ADA|ADO)\b|\bTERMIN(O|ADA|ADO)\b|\bEXPIR(O|ADA|ADO)\b|\bHACE\b(?:\s+\S+){0,3}?\s*\bMESES\b/;

// Respuesta de reemplazo cuando la red de seguridad bloquea el formulario de leads de
// paquetes en una conversación que era de cursos (ver detectCourseContext). El cliente
// se queda con una pregunta abierta en vez del formulario de empresa/rubro/Instagram,
// que no aplica a cursos.
const COURSE_FORM_BLOCKED_REPLY = `Para el curso no necesito esos datos 😊 Cuéntame, ¿qué te gustaría saber? (fecha, precio o cómo reservar tu cupo)`;

// Afirmaciones de cupo/lugar reservado/confirmado/apartado/guardado. Solo son
// legítimas DESPUÉS de un comprobante recibido; antes, son una promesa que el
// negocio no puede cumplir (el cupo se reserva única y exclusivamente con el pago).
// Sobre normalizeForMatch (sin tildes, mayúsculas). Tolera hasta 3 palabras de por
// medio ("cupo YA FUE reservado", "cupo ya esta confirmado") para no depender de la
// redacción exacta del LLM.
const RESERVED_SPOT_STATE_REGEX =
  /\b(CUPO|LUGAR)\b(?:\s+\S+){0,3}?\s+(RESERVADO|CONFIRMADO|APARTADO|GUARDADO|ASEGURADO)\b/;

// El asistente afirma haber reservado/apartado/guardado el cupo/lugar por el cliente
// ("te reservo el cupo", "te reservamos tu lugar").
const RESERVED_SPOT_VERB_REGEX =
  /\bTE\s+(RESERVE|RESERVO|RESERVAMOS|APARTE|APARTO|APARTAMOS|GUARDE|GUARDO|GUARDAMOS)\b(?:\s+\S+){0,3}?\s+(CUPO|LUGAR)\b/;

// El cliente queda inscrito/registrado sin haber pagado.
const ENROLLED_CLAIM_REGEX = /\b(QUEDASTE|QUEDAS|ESTAS)\s+(INSCRITO|REGISTRADO)\b/;

// Ofertas de reservar SIN pago ("¿te reservo el cupo?", "¿quieres que te aparte el
// lugar?"): el bot no debe ofrecer algo que solo el pago habilita.
const RESERVATION_OFFER_REGEX =
  /\bTE\s+(RESERVO|APARTO|GUARDO)\b(?:\s+\S+){0,3}?\s+(CUPO|LUGAR)\b|\bQUIERES\s+QUE\s+TE\s+(RESERVE|APARTE|GUARDE)\b/;

function replyClaimsReservedSpot(reply: string): boolean {
  if (!reply) return false;
  const normalized = normalizeForMatch(reply);
  return (
    RESERVED_SPOT_STATE_REGEX.test(normalized) ||
    RESERVED_SPOT_VERB_REGEX.test(normalized) ||
    ENROLLED_CLAIM_REGEX.test(normalized) ||
    RESERVATION_OFFER_REGEX.test(normalized)
  );
}

// Reemplazo cuando el bot afirma/ofrece un cupo sin comprobante recibido: reconduce
// SIEMPRE al pago. El QR se fuerza en el mismo turno (intents.payment_qr = true), así
// que este texto acompaña una imagen que sí llega.
const RESERVATION_REQUIRES_PAYMENT_REPLY = `¡Genial que quieras sumarte! 🙌 El cupo se asegura con el pago, así que te paso el QR ahora mismo.

Cuando completes la transferencia, envíame por este chat:
📌 La foto o PDF de tu comprobante
📌 Tu nombre completo (verifica que esté bien escrito)
📌 Tu número de celular

Con eso el equipo valida el pago y te confirmamos tu cupo 😊`;

// Mismo paso del pago cuando el QR salió hace menos de 1 hora y no se reenvía: prometer
// "te paso el QR" sin que llegue nada era el reclamo (ver MEDIA_RESEND_WINDOW_HOURS).
const RESERVATION_QR_ABOVE_REPLY = `¡Genial que quieras sumarte! 🙌 El QR de pago está arriba en este chat 👆

Cuando completes la transferencia, envíame por este chat:
📌 La foto o PDF de tu comprobante
📌 Tu nombre completo (verifica que esté bien escrito)
📌 Tu número de celular

Con eso el equipo valida el pago y te confirmamos tu cupo 😊`;

// CIERRE DEL LEAD. Es el último mensaje que el cliente recibe del bot: a partir de aquí
// la conversación queda en manos del asesor y el bot se apaga (ver
// pauseBotForHumanHandoff). Por eso el acuse es obligatorio y va SIEMPRE antes del
// silencio: quedarse callado justo después de que alguien escribió sus datos es la peor
// forma de terminar un embudo que costó toda la conversación construir.
const LEAD_CLOSED_REPLY = `¡Gracias! 🙌 Un asesor ya tiene tus datos y se comunicará contigo lo más pronto posible 😊`;

// ¿La respuesta le confirma al cliente que una persona lo va a contactar? Se mira el
// sentido, no el texto exacto, para no pisar una redacción del LLM que ya cumple.
const LEAD_CLOSING_ACK_REGEX =
  /\bASESOR\b|\bSE\s+(COMUNICARA|CONTACTARA|PONDRA\s+EN\s+CONTACTO)\b|\bTE\s+(CONTACTA|CONTACTARA|CONTACTAMOS|ESCRIBE|ESCRIBIRA|LLAMA|LLAMARA)\b/;

// Cliente que dice tener algo YA acordado con una persona del equipo ("ayer quedamos en
// 80 Bs", "ya hablé con el asesor y me dio el ok"). El bot no puede confirmar ni negar
// ese acuerdo: cualquier cosa que diga sobre precios o paquetes contradice a su propio
// equipo delante del cliente. Devuelve la conversación a quien la venía llevando y se
// calla (la pausa la aplica pauseBotForHumanHandoff).
const PRIOR_AGREEMENT_REPLY = `¡Gracias por avisar! 😊 Le paso ahora mismo tu caso al asesor que te atendió para que lo retome justo donde quedaron.

Te escribe por aquí en un momento 🙌`;

// El texto de "¿Cómo trabajamos...?" es largo y el modelo lo copia a mano: puede cambiar
// una palabra, perder una negrita o cortarlo. Si la respuesta lo trae, se reemplaza ese
// bloque por la versión exacta, conservando lo que el modelo haya agregado antes o después
// (por ejemplo la línea que responde una pregunta concreta del cliente).
// El título con sus signos de pregunta: así se distingue el texto de una mención al pasar.
const HOW_WE_WORK_TITLE_REGEX =
  /\**\s*¿\s*c[oó]mo\s+trabajamos\s+con\s+nuestros\s+clientes\s*\?\s*\**/i;
// El final del bloque es "resultados reales.", pero desde que el texto termina con la
// línea de cierre ("Si deseas elegir un paquete, avísanos...") hay que tragársela también
// cuando el modelo la copió: si el bloque cortara antes, el reemplazo insertaría el texto
// exacto —que ya trae su cierre— y el cierre del modelo quedaría repetido debajo.
const HOW_WE_WORK_BLOCK_REGEX = new RegExp(
  `${HOW_WE_WORK_TITLE_REGEX.source}[\\s\\S]*?resultados\\s+reales\\.?\\**(?:\\s*\\**\\s*si\\s+(?:deseas|quieres|decides)[^\\n]*)?`,
  "i",
);

function applyExactHowWeWorkText(reply: string): string {
  if (!reply || !HOW_WE_WORK_TITLE_REGEX.test(reply)) return reply;
  if (HOW_WE_WORK_BLOCK_REGEX.test(reply)) {
    return reply.replace(HOW_WE_WORK_BLOCK_REGEX, HOW_WE_WORK_INFO);
  }
  // Tiene el título pero lo cortó antes del final: sale completo desde el título.
  return `${reply.slice(0, reply.search(HOW_WE_WORK_TITLE_REGEX))}${HOW_WE_WORK_INFO}`;
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

function getWebhookEvents(payload: Record<string, any>, batchHeader: boolean): Record<string, any>[] {
  const isBatch = payload.batch === true || batchHeader;

  if (isBatch && Array.isArray(payload.data)) return payload.data;
  return [payload];
}

const AUDIO_PLACEHOLDER = "🎙️ Audio recibido";

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

  // No depender de transcripciones de Kapso: el webhook descarga el audio y lo
  // transcribe por su cuenta (transcribeIncomingAudio).
  if (isIncomingAudioMessage(message)) return AUDIO_PLACEHOLDER;

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

    // Diagnóstico: registrar el origin de CADA saliente en system_logs para poder
    // ver en Supabase con qué origin llegan los mensajes manuales del celular vs los
    // del bot. Sirve para confirmar/ajustar la condición de apagado automático.
    await logSystemEvent({
      level: "info",
      eventType: "outbound_origin_seen",
      conversationId: conversationId ?? undefined,
      messageId: messageId ?? undefined,
      contactPhone: phone ?? undefined,
      metadata: {
        origin,
        direction: kapsoDirection,
        will_auto_pause: origin === "business_app",
        status: event.message?.kapso?.status ?? null,
      },
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

      // Primera respuesta humana tras notificar un lead: marca advisor_replied_at
      // (solo si aún estaba en null) para que el cron de leads sin atender deje de
      // escalar esta conversación. No se pisa en respuestas humanas posteriores.
      const { error: repliedError } = await supabase
        .from("kapso_conversations")
        .update({ advisor_replied_at: nowIso })
        .eq("kapso_conversation_id", conversationId)
        .is("advisor_replied_at", null);

      if (repliedError) {
        console.error("advisor_replied_at update failed", repliedError);
      }

      // Guardar el mensaje humano en el historial (para dar contexto al bot si se
      // reanuda y para la captura de lead durante el apagado). Si el texto es el
      // formulario de intake enviado a mano, dejar el marcador [INTAKE_FORM_SENT].
      const humanText = extractMessageText(event.message, event.conversation);
      const humanPhone = event.conversation?.phone_number ?? event.message?.to ?? null;

      if (humanText && humanPhone) {
        try {
          await saveOutboundMessage({
            conversationId,
            phone: humanPhone,
            content: humanText,
            rawPayload: { source: "business_app_manual", origin, message_id: messageId },
          });

          // Formulario de intake (laxo): contiene varios 📌 (los campos del formulario).
          const intakeFieldCount = (humanText.match(/📌/g) ?? []).length;
          if (intakeFieldCount >= 3) {
            await saveOutboundMessage({
              conversationId,
              phone: humanPhone,
              content: "[INTAKE_FORM_SENT] formulario de datos enviado manualmente (business_app)",
              rawPayload: { type: "intake_form", source: "business_app_manual" },
            });
          }

          // Un humano mandó una imagen/documento a mano (ej. el QR de pago, cuando el
          // envío automático falló). No sabemos CUÁL archivo mandó, así que se marca
          // un intent propio en vez de "payment_qr" — mezclarlos contaminaría la
          // matriz de decisión de comprobantes. Solo habilita que la siguiente imagen
          // del cliente se verifique con visión (ver manualHumanMediaSent más abajo).
          const humanMessageType = event.message?.type;
          const humanIsImage =
            humanMessageType === "image" || Boolean(event.message?.image);
          const humanIsDocument =
            humanMessageType === "document" || Boolean(event.message?.document);

          if (humanIsImage || humanIsDocument) {
            await saveOutboundMessage({
              conversationId,
              phone: humanPhone,
              content: "[MEDIA_SENT:manual_human] material enviado manualmente (business_app)",
              rawPayload: { type: "manual_media", source: "business_app_manual", message_id: messageId },
            });
          }
        } catch (saveError) {
          console.error("save manual business_app message failed", saveError);
        }
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
  const isAudio = isIncomingAudioMessage(event.message);
  // Referencia al adjunto. Kapso a veces expone una URL directa (kapso.media_url);
  // si no viene, queda el media id de Meta para descargarlo por API. El payload se
  // parsea crudo (snake_case), pero el SDK usa camelCase: aceptamos ambos.
  const mediaId =
    event.message?.image?.id ??
    event.message?.document?.id ??
    event.message?.audio?.id ??
    event.message?.voice?.id ??
    null;
  const mediaUrl =
    event.message?.kapso?.media_url ??
    event.message?.kapso?.mediaUrl ??
    event.message?.image?.link ??
    event.message?.document?.link ??
    event.message?.audio?.link ??
    event.message?.voice?.link ??
    getIncomingAudioMediaUrl(event.message) ??
    null;
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
    isAudio,
    mediaId,
    mediaUrl,
    messageId,
    conversationId,
    contactName,
    messageTimestamp,
    raw: event,
  };
}

async function normalizeIncomingMessages(
  payload: Record<string, any>,
  batchHeader: boolean,
): Promise<IncomingMessage[]> {
  const events = getWebhookEvents(payload, batchHeader);
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

// ---------------------------------------------------------------------------
// Máquina de estados del flujo de paquetes (fuente de verdad en kapso_conversations)
// browsing -> package_selected -> intake_sent -> lead_captured -> advisor_notified
// Reemplaza la inferencia frágil por marcadores de texto: el código decide el
// siguiente paso según el stage guardado, no el LLM.
// ---------------------------------------------------------------------------
type FlowStage =
  | "browsing"
  | "package_selected"
  | "intake_sent"
  | "lead_captured"
  | "advisor_notified";

const FLOW_STAGE_RANK: Record<FlowStage, number> = {
  browsing: 0,
  package_selected: 1,
  intake_sent: 2,
  lead_captured: 3,
  advisor_notified: 4,
};

type ConversationFlowState = {
  flowStage: FlowStage;
  selectedPackage: string | null;
  intakeFormSentAt: string | null;
  leadCapturedAt: string | null;
  advisorNotifiedAt: string | null;
};

const DEFAULT_FLOW_STATE: ConversationFlowState = {
  flowStage: "browsing",
  selectedPackage: null,
  intakeFormSentAt: null,
  leadCapturedAt: null,
  advisorNotifiedAt: null,
};

async function getConversationFlowState(
  conversationId?: string,
): Promise<ConversationFlowState> {
  if (!conversationId) return { ...DEFAULT_FLOW_STATE };

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("kapso_conversations")
    .select(
      "flow_stage, selected_package, intake_form_sent_at, lead_captured_at, advisor_notified_at",
    )
    .eq("kapso_conversation_id", conversationId)
    .maybeSingle();

  if (error || !data) {
    if (error) console.error("supabase get flow state failed", error);
    return { ...DEFAULT_FLOW_STATE };
  }

  return {
    flowStage: (data.flow_stage as FlowStage) ?? "browsing",
    selectedPackage: data.selected_package ?? null,
    intakeFormSentAt: data.intake_form_sent_at ?? null,
    leadCapturedAt: data.lead_captured_at ?? null,
    advisorNotifiedAt: data.advisor_notified_at ?? null,
  };
}

// Actualiza el estado de flujo sin retroceder de etapa: si el stage objetivo tiene
// menor rango que el actual, se conservan el resto de campos del patch pero NO se
// baja flow_stage (evita que un mensaje tardío regrese de advisor_notified a intake_sent).
async function advanceConversationFlowState(params: {
  conversationId?: string;
  phone: string;
  targetStage?: FlowStage;
  currentStage?: FlowStage;
  patch?: Record<string, any>;
}): Promise<void> {
  if (!params.conversationId) return;

  const supabase = getSupabaseClient();
  const patch: Record<string, any> = { ...(params.patch ?? {}) };

  if (params.targetStage) {
    const current = params.currentStage ?? "browsing";
    if (FLOW_STAGE_RANK[params.targetStage] > FLOW_STAGE_RANK[current]) {
      patch.flow_stage = params.targetStage;
    }
  }

  const { error } = await supabase.from("kapso_conversations").upsert(
    {
      kapso_conversation_id: params.conversationId,
      contact_phone: params.phone,
      updated_at: new Date().toISOString(),
      ...patch,
    },
    { onConflict: "kapso_conversation_id" },
  );

  if (error) {
    console.error("supabase advance flow state failed", error);
    await logSystemEvent({
      level: "error",
      eventType: "supabase_flow_state_update_failed",
      conversationId: params.conversationId,
      contactPhone: params.phone,
      errorMessage: error.message,
      metadata: { code: error.code, details: error.details },
    });
  }
}

// Etiqueta best-effort del paquete elegido a partir del texto del cliente.
// Solo para reporting/contexto; no condiciona el envío del formulario. Recorre el
// catálogo del paquete MAYOR al menor: si el cliente nombra dos ("¿el de 6 o el de 18?"), se
// queda con el de arriba, igual que antes. Se deriva de lib/packages.ts para que un
// cambio de oferta no deje esta etiqueta vieja.
function detectSelectedPackageName(text: string): string | null {
  if (!text) return null;
  const normalized = normalizeForMatch(text);

  for (const pkg of [...VIDEO_PACKAGES].reverse()) {
    const name = normalizeForMatch(pkg.name);
    if (
      new RegExp(`\\b${name}\\b`).test(normalized) ||
      containsExactNumber(normalized, [pkg.videos]) ||
      containsExactNumber(normalized, [pkg.price])
    ) {
      return name.toLowerCase();
    }
  }

  return null;
}

// Mensaje puramente de continuación ("ok", "y ahora", "cómo empezamos") sin datos
// ni preguntas concretas. Con el formulario ya enviado (flow_stage='intake_sent'),
// estos nudges se responden de forma determinista, sin depender del LLM.
const INTAKE_NUDGE_REGEX =
  /^(ok(ay)?|oka|listo|dale|ya|si|sí|bueno|bien|perfecto|de acuerdo|me parece( bien)?|y ahora|ahora que|y luego|entonces|y despues|y despu[eé]s|que sigue|como (empezamos|empiezo|seguimos|sigo|continuamos|procedemos|es|hago|hacemos|inicio|iniciamos))[\s?!.]*$/;

function isIntakeNudge(text: string): boolean {
  if (!text) return false;
  const normalized = text.trim().toLowerCase();
  if (normalized.length > 40) return false;
  return INTAKE_NUDGE_REGEX.test(normalized);
}

// Recordatorio conciso de los datos clave. Se envía como respuesta determinista a un
// nudge cuando el formulario ya fue enviado, para no repetir el formulario completo.
// Respuesta a quien ya dejó sus datos en la página y recibiría otra vez el formulario.
const WEB_LEAD_ALREADY_RECEIVED_REPLY = `¡Ya tenemos tus datos! 🙌 Un asesor los tiene y te hablará pronto 😊`;

// Va con el botón del formulario (ver lib/site-links.ts): los datos se llenan en la página.
const INTAKE_REMINDER = `¡Genial! 🙌 Para avanzar solo falta que llenes tus datos dentro de este botón 👇 Un asesor te hablará pronto 😊`;

// El lead llegó al asesor: avanza a advisor_notified. (Antes también cancelaba el
// seguimiento automático, que se eliminó en septiembre de 2026: nunca llegó a enviar nada.)
async function markLeadCaptured(
  conversationId?: string,
  phone?: string,
  currentStage?: FlowStage,
): Promise<void> {
  if (!conversationId || !phone) return;

  const nowIso = new Date().toISOString();

  await advanceConversationFlowState({
    conversationId,
    phone,
    targetStage: "advisor_notified",
    currentStage,
    patch: { lead_captured_at: nowIso, advisor_notified_at: nowIso },
  });
}

// Detecta de forma determinista si el texto contiene datos de lead: un teléfono
// plausible (7+ dígitos seguidos, tolerando espacios/guiones) más algo de texto.
// Respaldo del LLM SOLO en el flujo de apagado con formulario ya pedido (ver POST),
// donde un teléfono es, casi con certeza, el dato real del cliente.
function detectLeadDataHeuristic(text: string): boolean {
  if (!text) return false;
  // Junta dígitos separados por espacios/guiones/paréntesis para contar la longitud real.
  const digitRuns: string[] = text.match(/[\d][\d\s().-]{5,}\d/g) ?? [];
  const hasPhone = digitRuns.some(
    (run) => run.replace(/\D/g, "").length >= 7,
  );
  const hasText = /[a-zA-ZáéíóúñÁÉÍÓÚÑ]/.test(text);
  return hasPhone && hasText;
}

// Detecta de forma determinista que el cliente pide una llamada telefónica para
// cerrar la contratación ("quiero llamar para confirmar el paquete", "que me llamen").
// Respaldo del LLM: sirve incluso con el bot apagado, donde no se generan turnos.
function detectCallRequestHeuristic(text: string): boolean {
  if (!text) return false;
  const normalized = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

  // Exclusiones primero: el cliente pide NUESTRO número o rechaza las llamadas.
  // Estas frases contienen "llamar"/"numero" pero NO son una solicitud de llamada.
  const isExcluded =
    /\b(cual es|cuales son|me pasan|me pasas|me das|pasame|dame)\b[^.?!]{0,20}\b(su |el |un )?(numero|telefono|celular|contacto)\b/.test(
      normalized,
    ) ||
    /\bdonde (puedo|podria) llamar\b/.test(normalized) ||
    /\ba que numero (puedo |podria )?llamo?\b/.test(normalized) ||
    /\bno (quiero|deseo|me interesan?)\b[^.?!]{0,15}\bllamad/.test(normalized) ||
    /\bprefiero que no me llamen\b/.test(normalized) ||
    /\bno me llamen\b/.test(normalized);

  if (isExcluded) return false;

  // Pide una llamada / quiere cerrar por teléfono con un asesor.
  return (
    /\b(quiero|queria|puedo|podria|deseo|necesito|me gustaria|prefiero|quisiera)\s+(hacer\s+una\s+)?llamar\b/.test(
      normalized,
    ) ||
    /\b(llamenme|llamame|me pueden llamar|pueden llamarme|que me llamen|que me llame|que me llames|me pueden contactar|pueden contactarme|comuniquense conmigo)\b/.test(
      normalized,
    ) ||
    /\b(por|una|hacer una|mediante|en|mandar|manden)\s+(video)?llamada\b/.test(
      normalized,
    ) ||
    /\b(coordinar|cerrar|hablar|conversar|contratar|confirmar)\s+(por|via|mediante)\s+(telefono|llamada|celular)\b/.test(
      normalized,
    ) ||
    /\b(quiero|queria|deseo|necesito|me gustaria|quisiera|prefiero)\s+(hablar|conversar)\b/.test(
      normalized,
    ) ||
    /\bhablar\s+(por|con)\s+(telefono|llamada|un asesor|una asesora|alguien)\b/.test(
      normalized,
    )
  );
}

// Señales de que la conversación trata realmente de algún flujo de Conecta Pro
// (cursos, paquetes de producción, agente de IA) o de la logística de una compra.
const COMMERCIAL_CONTEXT_PATTERN =
  /\b(curso|cursos|capacitacion|clase|clases|taller|temario|cupo|cupos|inscri|capcut|edicion|editar|grabacion|grabar|filmacion|video|videos|reel|reels|spot|comercial|publicidad|publicitar|marketing|mercadeo|promocionar|community|redes sociales|manejo de redes|contenido|dron|drone|paquete|paquetes|servicio|servicios|cotiza|presupuesto|precio|precios|costo|cuanto cuesta|tarifa|promo|descuento|agente|agentes|chatbot|bot|automatizar|automatizacion|inteligencia artificial|\bia\b|whatsapp business|pago|pagar|pague|comprobante|deposito|transferencia|qr|yape|plin|banco|reserva|reservar|cita|agendar|agenda|visitar|visitarlos|reunion|reunirnos|oficina|direccion|ubicacion|horario|conecta ?pro|reembolso|asesor)\b/;

// Gate determinista para las alertas de lead y de derivación a asesor: solo se avisa por
// Telegram si la conversación tiene relación con algún flujo del negocio. Evita alertas
// falsas en chats ajenos (soporte de otro producto, temas internos, charla personal).
// Los avisos de pago NO pasan por aquí: ya tienen su propia validación.
function hasCommercialContext(params: {
  history: HistoryMessage[];
  lastMessageText?: string | null;
  materialSent?: boolean;
}): boolean {
  // Si el backend ya envió flyer, QR o formulario, el contexto comercial es un hecho.
  if (params.materialSent) return true;

  const normalize = (text: string) =>
    text
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "");

  // Solo se miran los mensajes del CLIENTE: las respuestas del asistente (empezando por
  // el saludo, que nombra las tres líneas) contienen siempre estas palabras y harían que
  // el gate diera true en cualquier conversación.
  const haystack = [
    ...params.history
      .slice(-12)
      .filter((message) => message.role === "user")
      .map((message) => message.content ?? ""),
    params.lastMessageText ?? "",
  ]
    .filter(Boolean)
    .map(normalize)
    .join("\n");

  return COMMERCIAL_CONTEXT_PATTERN.test(haystack);
}

// Origen del disparo del lead, para auditoría en los logs.
type LeadTrigger =
  | "intake_form"
  | "call_request_assistant"
  | "call_request_heuristic"
  | "ai_agent_form";

// Notifica un lead al grupo de Telegram y, si tuvo éxito, guarda el marcador
// [TELEGRAM_LEAD_SENT] para no repetir. Centralizado para reutilizarse desde el flujo
// normal, el de silencio y el de apagado del bot.
// `kind: "call_request"` cambia el encabezado a prioridad alta (el asesor debe llamar).
// `kind: "ai_agent"` marca el lead como de la LÍNEA C (agente de IA), para que el asesor
// sepa que va a cotizar un agente y no un paquete de video.
async function notifyLeadToTelegram(params: {
  history: HistoryMessage[];
  phone: string;
  contactName?: string | null;
  conversationId?: string;
  fallbackText?: string;
  summary?: string;
  kind?: "intake" | "call_request" | "ai_agent";
  trigger?: LeadTrigger;
  // El cliente pidió reunirse en la oficina: el asesor debe coordinarla en la llamada.
  wantsOfficeVisit?: boolean;
}): Promise<boolean> {
  const lastClientMessage =
    params.history.filter((message) => message.role === "user").slice(-1)[0]?.content ??
    params.fallbackText;

  const headline =
    params.kind === "call_request"
      ? "🔴 <b>PRIORIDAD ALTA</b>\n📞 <b>Lead — Solicita llamada</b>"
      : params.kind === "ai_agent"
        ? "🤖 <b>Lead — Agente de IA</b>"
        : "🟢 <b>Nuevo lead — Conecta Pro</b>";

  const notes = [
    params.wantsOfficeVisit
      ? "🏢 Quiere reunirse en la oficina — llámalo para coordinar día y hora (el bot NO agendó nada)"
      : null,
  ].filter((note): note is string => note !== null);

  const notified = await sendTelegramNotification(
    buildTelegramBody({
      headline,
      phone: params.phone,
      clientMessage: lastClientMessage,
      summary: params.summary,
      note: notes.length > 0 ? notes.join("\n") : undefined,
    }),
  );

  if (notified) {
    await saveOutboundMessage({
      conversationId: params.conversationId,
      phone: params.phone,
      content: "[TELEGRAM_LEAD_SENT] notificación de lead enviada a Telegram",
      rawPayload: {
        type: "telegram_notification",
        event: "lead",
        kind: params.kind ?? "intake",
        trigger: params.trigger ?? "intake_form",
      },
    });
  }

  return notified;
}

// Notifica un comprobante de pago al grupo de Telegram y guarda el marcador
// [TELEGRAM_PAYMENT_SENT:<messageId>] para deduplicar (ver hasTelegramPaymentBeenSent
// — ventana de 6h, no bloqueo permanente). Centralizada para invocarse desde un único
// punto determinista apenas se detecta el comprobante, ANTES de cualquier return
// temprano (debounce, off_topic, fallo de envío…) — la alerta no debe depender de que
// el bot llegue a responder por WhatsApp.
// Alerta 💰 inmediata (sin esperar datos del cliente): pagos de paquetes, comprobantes que ya
// traen el nombre, o el chat en atención humana. La que espera los datos la manda
// lib/payment-alerts.ts. Ambas llevan la etiqueta del pago (curso, paquete u otro).
async function notifyPaymentToTelegram(params: {
  phone: string;
  conversationId?: string;
  messageId?: string;
  clientMessage: string;
  reason: PaymentReason;
  // Datos ya extraídos; si faltan, se leen del mensaje del cliente.
  payer?: PayerData;
  contactName?: string | null;
  note?: string;
  verification?: string;
}): Promise<boolean> {
  const payer = params.payer ?? extractPayerData([params.clientMessage], params.reason);

  return sendPaymentAlert(getSupabaseClient(), {
    phone: params.phone,
    conversationId: params.conversationId,
    receiptMessageId: params.messageId ?? "unknown",
    tag: payer.tag,
    names: payer.names,
    phones: payer.phones,
    motive: payer.motive,
    profileName: params.contactName ?? null,
    clientMessage: params.clientMessage,
    verification: params.verification,
    note: params.note,
    timedOut: false,
  });
}

type AdvisorHandoffReason =
  | "undocumented_info"
  | "out_of_catalog"
  | "custom_quantity"
  | "prior_agreement"
  | "refund_old_date"
  | "course_topic_unconfirmed"
  | "package_addon"
  | "recruitment";

// Marcadores de dedup de los avisos a Telegram. El genérico cubre todos los motivos
// menos el lead por cantidad, que tiene el suyo (ver hasTelegramCustomQuantityBeenSent).
const HANDOFF_MARKER = "[TELEGRAM_HANDOFF_SENT]";
const CUSTOM_QUANTITY_MARKER = "[TELEGRAM_CUSTOM_QUANTITY_SENT]";
const PRIOR_AGREEMENT_MARKER = "[TELEGRAM_PRIOR_AGREEMENT_SENT]";
const PACKAGE_ADDON_MARKER = "[TELEGRAM_PACKAGE_ADDON_SENT]";

const ADVISOR_HANDOFF_REASON_LABEL: Record<AdvisorHandoffReason, string> = {
  out_of_catalog: "Servicio fuera del catálogo estándar",
  custom_quantity: "LEAD — pidió una cantidad de videos fuera de los paquetes",
  prior_agreement:
    "URGENTE — dice que ya acordó algo con el equipo (el bot NO respondió por encima)",
  undocumented_info: "Información no documentada",
  refund_old_date: "Posible reembolso — pagó fecha anterior del curso (26 de julio)",
  course_topic_unconfirmed: "Preguntó por un tema del curso fuera del temario confirmado",
  package_addon: "LEAD — quiere sumar un extra a su paquete (hay que cotizarlo)",
  recruitment: "Busca TRABAJO con Conecta Pro (modelo/editor/personal) — el bot no respondió",
};

// Aviso genérico "blanco" al asesor: cualquier situación (fuera de leads, llamadas, citas o
// pagos, que ya tienen su propio aviso) donde el bot necesita intervención humana. Se envía UNA
// sola vez por conversación por marcador: todos los motivos comparten [TELEGRAM_HANDOFF_SENT]
// menos el lead por cantidad, que usa [TELEGRAM_CUSTOM_QUANTITY_SENT] para no quedarse sin
// aviso — ver hasTelegramHandoffBeenSent y hasTelegramCustomQuantityBeenSent.
async function notifyAdvisorHandoffToTelegram(params: {
  history: HistoryMessage[];
  phone: string;
  contactName?: string | null;
  conversationId?: string;
  reason: AdvisorHandoffReason;
  lastMessageText: string;
  summary?: string;
  // Dato extra para el asesor (ej. cuántos videos pidió el cliente).
  note?: string;
}): Promise<boolean> {
  const notified = await sendTelegramNotification(
    buildTelegramBody({
      headline: `⚪ <b>Requiere asesor — Conecta Pro</b>\n🏷️ Motivo: ${ADVISOR_HANDOFF_REASON_LABEL[params.reason]}`,
      phone: params.phone,
      clientMessage: params.lastMessageText,
      summary: params.summary,
      note: params.note,
    }),
  );

  if (notified) {
    await saveOutboundMessage({
      conversationId: params.conversationId,
      phone: params.phone,
      content: `${handoffMarkerFor(params.reason)} aviso de derivación a asesor enviado a Telegram`,
      rawPayload: {
        type: "telegram_notification",
        event: "advisor_handoff",
        reason: params.reason,
      },
    });
  }

  return notified;
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

// Un turno queda obsoleto cuando el cliente sigue escribiendo mientras se
// procesaba: se descarta sin responder y su candado se marca como reemplazado,
// para no dejarlo colgado en "processing".
async function markReplyLockSuperseded(params: {
  lastMessageId?: string;
  conversationId?: string;
  phone?: string;
  stage: "debounce" | "pre_send";
}) {
  if (!params.lastMessageId) return;

  const supabase = getSupabaseClient();

  const { error } = await supabase
    .from("kapso_response_locks")
    .update({
      status: "superseded",
      response_text: `[SUPERSEDED:${params.stage}] llegó un mensaje más nuevo del cliente`,
      updated_at: new Date().toISOString(),
    })
    .eq("last_kapso_message_id", params.lastMessageId);

  if (error) {
    console.error("supabase supersede kapso_response_locks failed", error);

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
        stage: params.stage,
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

// Base común de las pausas automáticas. `minutes = null` deja la pausa indefinida
// (solo la levanta un humano con /resume); con minutos, el propio webhook la reanuda
// sola en el primer mensaje posterior al vencimiento (ver resumeBotIfPauseExpired).
async function applyBotPause(params: {
  conversationId?: string;
  reason: string;
  minutes: number | null;
  failureEventType: string;
  metadata?: Record<string, unknown>;
}): Promise<boolean> {
  if (!params.conversationId) return false;

  const supabase = getSupabaseClient();
  const nowIso = new Date().toISOString();
  const expiresAtIso = params.minutes
    ? new Date(Date.now() + params.minutes * 60_000).toISOString()
    : null;

  const { error } = await supabase
    .from("kapso_conversations")
    .update({
      bot_paused: true,
      bot_paused_at: nowIso,
      bot_pause_expires_at: expiresAtIso,
      bot_paused_reason: params.reason,
      bot_pause_mode: "auto",
      bot_pause_duration_minutes: params.minutes,
      updated_at: nowIso,
    })
    .eq("kapso_conversation_id", params.conversationId);

  if (error) {
    console.error("auto pause failed", { reason: params.reason, error });

    await logSystemEvent({
      level: "error",
      eventType: params.failureEventType,
      conversationId: params.conversationId,
      errorMessage: error.message,
      metadata: {
        code: error.code,
        details: error.details,
        pause_reason: params.reason,
        ...params.metadata,
      },
    });

    return false;
  }

  return true;
}

// TRASPASO A UN HUMANO — apagado del bot.
//
// Cuando el caso pasa a manos de una persona (pidió que lo llamen, cerró su lead — también
// quien quería reunirse en la oficina — o se derivó al asesor), el bot deja de hablar. No es un lujo:
// mientras el asesor no ha entrado todavía al chat, cada respuesta automática puede
// contradecir lo que esa persona ya acordó, repetir un formulario ya enviado o negar un
// precio que el equipo sí dio — y ahí se pierde al cliente, no antes.
//
// 12 horas es el MÍNIMO: cubre el caso real de que el pedido entre de tarde y el asesor
// lo atienda recién a la mañana siguiente. Al vencer, el bot se reactiva solo; un humano
// puede reactivarlo antes con /resume.
const HUMAN_HANDOFF_PAUSE_MINUTES = 12 * 60;

// Motivos de derivación que SÍ apagan el bot. Los que faltan quedan deliberadamente
// fuera, porque en esos casos el bot todavía tiene trabajo que hacer y apagarlo mata el
// embudo antes de cerrarlo:
//   - "out_of_catalog": le acaba de ofrecer elegir un paquete; si responde "el de 6",
//     alguien tiene que mandarle el formulario.
//   - "custom_quantity": le acaba de pedir los datos; el silencio llega cuando los mande
//     (lead_closed), no antes.
//   - "course_topic_unconfirmed": sigue vendiendo el curso y puede terminar pagando.
//   - "package_addon": le acaba de pedir permiso para tomarle los datos; si el bot se apaga,
//     el "dale" del cliente se queda sin respuesta y el lead muere ahí.
const PAUSE_ON_HANDOFF_REASONS: AdvisorHandoffReason[] = [
  "prior_agreement",
  "undocumented_info",
  "refund_old_date",
  "recruitment",
];

type HumanHandoffPauseReason =
  | "call_requested"
  | "lead_closed"
  | "advisor_handoff"
  | "prior_agreement";

async function pauseBotForHumanHandoff(params: {
  conversationId?: string;
  phone?: string;
  messageId?: string;
  reason: HumanHandoffPauseReason;
}): Promise<void> {
  const paused = await applyBotPause({
    conversationId: params.conversationId,
    reason: `human_handoff:${params.reason}`,
    minutes: HUMAN_HANDOFF_PAUSE_MINUTES,
    failureEventType: "bot_human_handoff_pause_failed",
    metadata: { handoff_reason: params.reason },
  });

  if (!paused) return;

  console.log("bot paused for human handoff", {
    conversationId: params.conversationId,
    reason: params.reason,
    minutes: HUMAN_HANDOFF_PAUSE_MINUTES,
  });

  await logSystemEvent({
    level: "info",
    eventType: "bot_paused_for_human_handoff",
    conversationId: params.conversationId,
    messageId: params.messageId,
    contactPhone: params.phone,
    metadata: {
      handoff_reason: params.reason,
      pause_minutes: HUMAN_HANDOFF_PAUSE_MINUTES,
    },
  });
}

// Pausa automática de la conversación cuando se sospecha un loop bot-contra-bot
// (ej. el número del "usuario" en realidad pertenece a otro asistente automatizado
// de otra empresa, y ambos bots se responden entre sí indefinidamente). Requiere
// intervención manual (/resume) para reanudar.
async function pauseBotForSuspectedLoop(conversationId?: string) {
  await applyBotPause({
    conversationId,
    reason: "suspected_bot_to_bot_loop",
    minutes: null,
    failureEventType: "bot_loop_auto_pause_failed",
  });
}

// Duración de la pausa automática por mensaje fuera de tema. Se usa una pausa con
// vencimiento (y no indefinida como las otras) para que un cliente que escribe algo
// ajeno y después pregunta por cursos no quede sin bot para siempre.
const OFF_TOPIC_PAUSE_MINUTES = 360;

// Pausa automática cuando el cliente escribe algo sin ninguna relación con Conecta Pro
// (soporte de otro producto, temas internos de un trabajo en curso, charla personal).
// El bot guarda silencio total y deja la conversación en manos de un humano; se reanuda
// sola al vencer la pausa, o antes con /resume.
async function pauseBotForOffTopic(conversationId?: string) {
  await applyBotPause({
    conversationId,
    reason: "off_topic_unrelated",
    minutes: OFF_TOPIC_PAUSE_MINUTES,
    failureEventType: "bot_off_topic_auto_pause_failed",
  });
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
    .filter((message) => !/^\[(MEDIA_SENT|LOCATION_|PAYMENT_ALERT_PENDING|LINK_SENT|SITE_VISIT)/.test(message.content.trim()));
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
  should_reply: z.boolean(),
  is_greeting: z.boolean(),
  explicit_resend_request: z.boolean(),
  payment_confirmation: z.boolean(),
  service_intake_requested: z.boolean(),
  lead_data_submitted: z.boolean(),
  call_request: z.boolean(),
  // El cliente quiere venir a la oficina / reunirse en persona. No agenda nada: dispara el
  // formulario y deja una nota para que el asesor coordine la reunión por llamada.
  office_visit_requested: z.boolean(),
  ai_agent_lead_submitted: z.boolean(),
  off_topic: z.boolean(),
  advisor_handoff: z.boolean(),
  advisor_handoff_reason: z
    .enum([
      "undocumented_info",
      "out_of_catalog",
      "custom_quantity",
      "prior_agreement",
      "refund_old_date",
      "course_topic_unconfirmed",
      "package_addon",
      "recruitment",
    ])
    .nullable(),
  // El cliente pide sumar algo a su paquete que ese paquete no incluye (dron, locución,
  // actores...). Es la mitad "inteligente" de la red de seguridad del dron: el código
  // detecta además por texto, y basta con que uno de los dos dispare.
  package_addon_requested: z.boolean(),
  // Qué pidió, en texto literal ("un video con dron"). Es lo que lee el asesor en la
  // alerta de Telegram para poder cotizar sin abrir el chat.
  package_addon_detail: z.string().nullable(),
  conversation_summary: z.string(),
  intents: z.object({
    course_flyer: z.boolean(),
    location_video: z.boolean(),
    payment_qr: z.boolean(),
    service_packages: z.boolean(),
    service_packages_promo: z.boolean(),
    ai_agent_flyer: z.boolean(),
  }),
});

type AssistantTurn = z.infer<typeof AssistantTurnSchema>;

const FALLBACK_ASSISTANT_TURN: AssistantTurn = {
  reply:
    "¡Hola! Somos ConectaPro😊 ¿En qué puedo ayudarte hoy? Tenemos *cursos presenciales*, *servicios de grabación y edición de video* para negocios o tu marca personal, y *agentes de IA para tu negocio* 🤖",
  should_reply: true,
  is_greeting: false,
  explicit_resend_request: false,
  payment_confirmation: false,
  service_intake_requested: false,
  lead_data_submitted: false,
  call_request: false,
  office_visit_requested: false,
  ai_agent_lead_submitted: false,
  // Si OpenAI falla no se puede juzgar la relevancia del mensaje: se asume que sí
  // viene al caso para no apagar el bot por un error de infraestructura.
  off_topic: false,
  advisor_handoff: false,
  advisor_handoff_reason: null,
  package_addon_requested: false,
  package_addon_detail: null,
  conversation_summary: "",
  intents: {
    course_flyer: false,
    location_video: false,
    payment_qr: false,
    service_packages: false,
    service_packages_promo: false,
    ai_agent_flyer: false,
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
      model: getChatModel(),
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
        // Con dos proveedores posibles, saber cuál falló es la mitad del diagnóstico.
        provider: resolveAiProvider().provider,
        model: resolveAiProvider().model,
      },
    });

    await alertIfOpenAiQuotaError(error, "respuestas del bot");

    return FALLBACK_ASSISTANT_TURN;
  }
}

// ALERTA DE SALDO. El 31 de agosto de 2026 la cuenta de OpenAI se quedó sin crédito y nadie
// se enteró: el bot respondía con el texto de respaldo a cada cliente. Volvió a pasar el 25 de
// septiembre. Ningún proveedor expone el saldo por API con una clave normal, así que se detecta
// en el momento en que falla una llamada por falta de crédito y se avisa al desarrollador por
// Telegram (como máximo una vez por hora, para no inundar el chat mientras dura el problema).
// El detector vive en lib/ai-provider.ts y cubre los dos proveedores, incluido el cupo diario
// del tier gratuito de OpenRouter.
const OPENAI_QUOTA_ALERT_EVERY_MINUTES = 60;

async function alertIfOpenAiQuotaError(
  error: unknown,
  source: string,
  // La transcripción de audios va siempre por OpenAI, aunque AI_PROVIDER sea openrouter: el
  // enlace de recarga no siempre es el del proveedor activo.
  billedTo: "active" | "openai" = "active",
): Promise<void> {
  const message = getErrorMessage(error);
  if (!isQuotaError(message)) return;

  try {
    const since = new Date(Date.now() - OPENAI_QUOTA_ALERT_EVERY_MINUTES * 60_000).toISOString();
    const { data } = await getSupabaseClient()
      .from("system_logs")
      .select("id")
      .eq("event_type", "openai_quota_alert_sent")
      .gte("created_at", since)
      .limit(1);
    if ((data ?? []).length > 0) return;

    const proveedor = billedTo === "openai" ? "openai" : resolveAiProvider().provider;
    const topUpUrl =
      billedTo === "openai"
        ? getTopUpUrl({ ...process.env, AI_PROVIDER: "openai" })
        : getTopUpUrl();

    const sent = await sendDeveloperAlert(
      [
        `🚨 <b>${proveedor === "openrouter" ? "OpenRouter" : "OpenAI"} SIN SALDO — Conecta Pro</b>`,
        "",
        `Falló: ${escapeTelegramHtml(source)}.`,
        "Mientras no se recargue, el bot responde con el mensaje de respaldo, no verifica comprobantes y no transcribe audios.",
        "",
        `👉 Recargar: ${topUpUrl}`,
        "",
        `🧾 Error: ${escapeTelegramHtml(message.slice(0, 200))}`,
      ].join("\n"),
    );

    await logSystemEvent({
      level: "critical",
      // Se conserva el nombre del evento: la ventana de 1 hora lo consulta y hay historial.
      eventType: "openai_quota_alert_sent",
      errorMessage: message.slice(0, 500),
      metadata: { source, telegram_sent: sent, provider: proveedor },
    });
  } catch (alertError) {
    console.error("openai quota alert failed", alertError);
  }
}

// Verificación por visión de que una imagen entrante es realmente un comprobante
// de pago. Antes bastaba con que fuera imagen + hubiera contexto de pago (QR o
// formulario enviado), así que cualquier selfie o captura disparaba el
// "¡Gracias por el comprobante!" y la alerta 💰 a Telegram.
type ReceiptCheck = {
  isReceipt: boolean;
  reason: string;
  source: "vision" | "fallback";
};

const RECEIPT_VISION_TIMEOUT_MS = 8000;

const ReceiptVisionSchema = z.object({
  is_receipt: z
    .boolean()
    .describe("true solo si la imagen es un comprobante/constancia de pago"),
  reason: z
    .string()
    .describe("Explicación de una frase corta, en español, de lo que se ve en la imagen"),
});

// Descarga los bytes de la imagen: URL directa de Kapso si vino en el webhook,
// si no el media id de Meta a través del proxy de Kapso.
async function downloadIncomingMedia(params: {
  mediaId?: string | null;
  mediaUrl?: string | null;
  signal: AbortSignal;
}): Promise<Uint8Array> {
  if (params.mediaUrl) {
    const response = await fetch(params.mediaUrl, {
      signal: params.signal,
      headers: params.mediaUrl.includes("kapso.ai")
        ? { "X-API-Key": getRequiredEnv("KAPSO_API_KEY") }
        : undefined,
    });

    if (!response.ok) {
      throw new Error(`media url fetch failed ${response.status}`);
    }

    return new Uint8Array(await response.arrayBuffer());
  }

  if (!params.mediaId) {
    throw new Error("no media reference in message");
  }

  const kapso = getKapsoClient();
  const buffer = await kapso.media.download({
    mediaId: params.mediaId,
    phoneNumberId: getRequiredEnv("KAPSO_PHONE_NUMBER_ID"),
    as: "arrayBuffer",
  });

  return new Uint8Array(buffer as ArrayBuffer);
}

async function classifyReceiptImage(params: {
  mediaId?: string | null;
  mediaUrl?: string | null;
  conversationId?: string;
  messageId?: string;
  phone?: string;
}): Promise<ReceiptCheck> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RECEIPT_VISION_TIMEOUT_MS);

  let check: ReceiptCheck;

  try {
    const image = await downloadIncomingMedia({
      mediaId: params.mediaId,
      mediaUrl: params.mediaUrl,
      signal: controller.signal,
    });

    const result = await generateText({
      model: getChatModel(),
      abortSignal: controller.signal,
      temperature: 0,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: [
                "Eres un verificador de comprobantes de pago para un negocio de Bolivia.",
                "Responde is_receipt = true SOLO si la imagen muestra evidencia de una",
                "transacción: monto pagado, fecha/hora de operación, nombre de un banco o",
                "billetera (Banco Unión, BNB, Mercantil Santa Cruz, BCP, Banco Económico,",
                "Banco Ganadero, BancoSol, Fassil, Tigo Money, pago por QR Simple, etc.),",
                "número de operación o una captura de pantalla de una app bancaria.",
                "Responde is_receipt = false para cualquier otra cosa: fotos de personas o",
                "selfies, memes, fotos de productos o lugares, documentos de identidad,",
                "capturas de chats o de redes sociales, o imágenes ilegibles.",
                "Ante la duda sobre si hay una transacción real, responde false.",
              ].join(" "),
            },
            { type: "image", image },
          ],
        },
      ],
      output: Output.object({ schema: ReceiptVisionSchema }),
    });

    check = {
      isReceipt: result.output.is_receipt,
      reason: result.output.reason.trim(),
      source: "vision",
    };
  } catch (error) {
    console.error("receipt vision check failed", error);
    await alertIfOpenAiQuotaError(error, "verificación de comprobantes");

    // Conservador a propósito: si no pudimos ver la imagen, preferimos el
    // comportamiento anterior (tratarla como comprobante) antes que perder un
    // pago real. El evento queda registrado para poder medirlo.
    check = {
      isReceipt: true,
      reason: "No se pudo verificar la imagen",
      source: "fallback",
    };

    await logSystemEvent({
      level: "warning",
      eventType: "receipt_vision_failed",
      conversationId: params.conversationId,
      messageId: params.messageId,
      contactPhone: params.phone,
      errorMessage: getErrorMessage(error),
      metadata: { fallback_used: true, had_media_url: Boolean(params.mediaUrl) },
    });
  } finally {
    clearTimeout(timeout);
  }

  await logSystemEvent({
    level: "info",
    eventType: "receipt_vision_check",
    conversationId: params.conversationId,
    messageId: params.messageId,
    contactPhone: params.phone,
    metadata: {
      is_receipt: check.isReceipt,
      detection_source: check.source,
      reason: check.reason,
    },
  });

  return check;
}

// TRANSCRIPCIÓN DE AUDIOS, en el propio webhook: la de Kapso se cobra aparte.
// Sin transcripción el bot no sabe qué dijo el cliente — en un mes llegaron 136 audios y 23
// terminaron en silencio total porque el modelo los marcó "fuera de tema".
// Va primero por Groq (Whisper, cuota gratuita) cuando hay GROQ_API_KEY; si Groq falla o
// se queda sin cuota, el mismo audio pasa a OpenAI para que el cliente no quede sin respuesta.
const AUDIO_TRANSCRIBE_TIMEOUT_MS = 20_000;
// Groq suele responder en un par de segundos: si tarda más se corta para dejarle tiempo
// al respaldo dentro del límite total.
const GROQ_TRANSCRIBE_TIMEOUT_MS = 8_000;

async function transcribeAudioWithTarget(
  target: TranscriptionTarget,
  audio: Uint8Array,
  signal: AbortSignal,
): Promise<string> {
  const result =
    target.provider === "groq"
      ? await transcribe({
          model: getTranscriptionModel(target),
          audio,
          abortSignal: AbortSignal.any([signal, AbortSignal.timeout(GROQ_TRANSCRIBE_TIMEOUT_MS)]),
          // Sin reintentos: una cuota agotada (429) pasa directo al respaldo.
          maxRetries: 0,
          providerOptions: { groq: { language: "es" } },
        })
      : await transcribe({
          model: getTranscriptionModel(target),
          audio,
          abortSignal: signal,
          providerOptions: { openai: { language: "es" } },
        });

  const text = result.text.trim();
  if (!text) throw new Error("empty transcription");

  return text;
}

async function transcribeIncomingAudio(message: IncomingMessage): Promise<void> {
  if (!message.isAudio) return;

  // Un reintento del webhook trae el mismo audio: si ya está guardado, no se vuelve a
  // transcribir (saveInboundMessage lo va a descartar como duplicado de todos modos).
  if (message.messageId) {
    const { data } = await getSupabaseClient()
      .from("kapso_messages")
      .select("id")
      .eq("kapso_message_id", message.messageId)
      .limit(1);
    if ((data ?? []).length > 0) return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AUDIO_TRANSCRIBE_TIMEOUT_MS);

  try {
    const audio = await downloadIncomingMedia({
      mediaId: message.mediaId,
      mediaUrl: message.mediaUrl,
      signal: controller.signal,
    });

    const targets = resolveTranscriptionTargets();
    let text = "";
    let usedTarget = targets[0];

    for (const [index, target] of targets.entries()) {
      try {
        text = await transcribeAudioWithTarget(target, audio, controller.signal);
        usedTarget = target;
        break;
      } catch (error) {
        if (index === targets.length - 1) throw error;

        console.error(`audio transcription failed with ${target.provider}, using fallback`, error);
        await logSystemEvent({
          level: "warning",
          eventType: "audio_transcription_fallback",
          conversationId: message.conversationId,
          messageId: message.messageId,
          contactPhone: message.from,
          errorMessage: getErrorMessage(error),
          metadata: { provider: target.provider, model: target.model },
        });
      }
    }

    message.text = `${AUDIO_PLACEHOLDER}\n\nTranscripción: ${text}`;

    await logSystemEvent({
      level: "info",
      eventType: "audio_transcribed",
      conversationId: message.conversationId,
      messageId: message.messageId,
      contactPhone: message.from,
      metadata: {
        chars: text.length,
        provider: usedTarget.provider,
        model: usedTarget.model,
        fallback_used: usedTarget !== targets[0],
      },
    });
  } catch (error) {
    console.error("audio transcription failed", error);
    message.audioUnreadable = true;
    // El último intento es siempre OpenAI (respaldo de Groq), aunque el proveedor activo
    // del bot sea OpenRouter: si falla por saldo, la recarga es la de OpenAI.
    await alertIfOpenAiQuotaError(error, "transcripción de audios", "openai");

    await logSystemEvent({
      level: "warning",
      eventType: "audio_transcription_failed",
      conversationId: message.conversationId,
      messageId: message.messageId,
      contactPhone: message.from,
      errorMessage: getErrorMessage(error),
      metadata: { had_media_url: Boolean(message.mediaUrl), had_media_id: Boolean(message.mediaId) },
    });
  } finally {
    clearTimeout(timeout);
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

// Instante del ÚLTIMO envío de un material a este teléfono, leyendo el marcador
// "[MEDIA_SENT:<intent>]" que deja sendMediaForIntent. Alimenta la ventana de reenvío
// (ver shouldResendMedia en lib/media-intents.ts). Mismo patrón que
// hasTelegramPaymentBeenSent: última fila por created_at.
//
// Con conversationId se acota a ESA conversación. Lo necesita el contexto de pago: un
// teléfono que recibió el QR hace tres meses, en otro chat, no está pagando ahora
// (ver lib/payment-context.ts).
async function getMediaIntentLastSentAt(
  phone: string,
  intent: MediaIntent,
  conversationId?: string,
): Promise<Date | null> {
  if (!phone) return null;

  const supabase = getSupabaseClient();

  let query = supabase
    .from("kapso_messages")
    .select("created_at")
    .eq("contact_phone", phone)
    .eq("direction", "outbound")
    .ilike("content", `[MEDIA_SENT:${intent}]%`);

  if (conversationId) query = query.eq("kapso_conversation_id", conversationId);

  const { data, error } = await query
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) {
    console.error("supabase read media intent last sent failed", error);

    await logSystemEvent({
      level: "error",
      eventType: "supabase_media_last_sent_failed",
      contactPhone: phone,
      errorMessage: error.message,
      metadata: { code: error.code, details: error.details, intent },
    });

    // Fail-open: ante un error de lectura preferimos reenviar el material antes que
    // dejar al cliente sin él.
    return null;
  }

  const rawTimestamp = (data ?? [])[0]?.created_at as string | undefined;
  if (!rawTimestamp) return null;

  const sentAt = new Date(rawTimestamp);

  return Number.isNaN(sentAt.getTime()) ? null : sentAt;
}

async function getMediaSentStatus(
  phone: string,
): Promise<Record<MediaIntent, boolean>> {
  const status: Record<MediaIntent, boolean> = {
    course_flyer: false,
    location_video: false,
    payment_qr: false,
    service_packages: false,
    service_packages_promo: false,
    ai_agent_flyer: false,
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

// Detecta la palabra clave de promoción del live (tolerando typos comunes) seguida
// del monto, y DEVUELVE ESE MONTO: en los lives, quien transmite anuncia un precio
// promocional distinto cada vez, y el cliente lo escribe al entrar al chat
// ("PROMO 350"). Ese monto es el precio que se le confirma y que viaja al asesor en
// la alerta de Telegram para que lo valide contra el comprobante.
function detectPromoAmount(text: string): number | null {
  if (!text) return null;

  const match = normalizeForMatch(text).match(PROMO_CANDIDATE_REGEX);
  if (!match) return null;

  const word = match[1];
  const isPromoWord =
    levenshteinDistance(word, "PROMO") <= PROMO_KEYWORD_MAX_DISTANCE ||
    levenshteinDistance(word, "PROMOCION") <= PROMOCION_KEYWORD_MAX_DISTANCE;

  if (!isPromoWord) return null;

  const amount = Number(match[2]);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

// --- Red de seguridad: elección de paquete -------------------------------
// Las cantidades, los precios y los nombres de los paquetes viven en lib/packages.ts
// (fuente única de verdad): al cambiar la oferta se edita solo ese archivo y tanto el
// prompt como estos detectores se actualizan solos.

// Palabras afirmativas / de selección que, junto a un tamaño de paquete válido,
// indican que el cliente ESTÁ eligiendo un paquete (intención clara de contratar).
const AFFIRMATIVE_CHOICE_REGEX =
  /\b(SI|QUIERO|EL DE|LOS DE|LAS|ME INTERESA|DAME|VA|DALE|ESE|ESA)\b/;

// Selección por REFERENCIA, sin decir número ni nombre: deícticos ("ese mismo"),
// ordinales ("el primero") y superlativos ("el más económico", "el básico"). Estas
// frases NO tienen sentido por sí solas: solo son una elección si el asistente ya
// presentó los paquetes en la conversación (ver detectPackagesPresented). Por eso
// viven separadas de AFFIRMATIVE_CHOICE_REGEX y nunca disparan sin contexto.
const CONTEXTUAL_CHOICE_REGEX =
  /\b(ESE|ESA|ESE MISMO|ESA MISMA|EL PRIMERO|LA PRIMERA|EL SEGUNDO|LA SEGUNDA|EL ULTIMO|EL BASICO|EL SENCILLO|EL SIMPLE|EL COMPLETO|EL GRANDE|EL CHICO|EL MENOR|EL MAYOR|EL MAS ECONOMICO|EL MAS BARATO|EL MAS CARO|EL MAS COMPLETO|EL ECONOMICO|EL BARATO)\b/;

// Petición de información genérica: "quiero información", "quiero saber más", "dame
// detalles". Contiene un verbo afirmativo ("quiero", "dame") pero NO señala ningún
// paquete concreto → no es una selección y no debe abrir el formulario.
const GENERIC_INFO_REGEX =
  /\b(INFORMACION|INFO|INFORMES|DETALLES|SABER|CONOCER|CONSULTAR|COTIZACION|PRESUPUESTO)\b/;

// Keywords de consulta: si aparecen (o hay "?"), el cliente está PREGUNTANDO, no
// eligiendo, y la red de seguridad no debe dispararse. Cubre precio ("cuánto cuesta
// el de 6") y consultas de contenido ("¿qué incluye el premium?", "cuál me conviene").
const PRICE_QUESTION_REGEX =
  /(\bCUANTO\b|\bCUANTOS\b|\bPRECIO\b|\bPRECIOS\b|\bCOSTO\b|\bCUESTA\b|\bCOSTA\b|\bVALE\b|\bQUE INCLUYE\b|\bQUE TRAE\b|\bCUAL\b|\bCUALES\b|\bDIFERENCIA\b|\?)/;

// Igual que PRICE_QUESTION_REGEX pero SIN el "?" suelto: un cliente que escribe
// "????" por impaciencia no está haciendo una pregunta de precio/contenido, y no
// debe suprimir la red de seguridad de interés genérico (ver detectGeneralPurchaseIntent).
const SPECIFIC_QUESTION_REGEX =
  /(\bCUANTO\b|\bCUANTOS\b|\bPRECIO\b|\bPRECIOS\b|\bCOSTO\b|\bCUESTA\b|\bCOSTA\b|\bVALE\b|\bQUE INCLUYE\b|\bQUE TRAE\b|\bCUAL\b|\bCUALES\b|\bDIFERENCIA\b|\bCOMO FUNCIONA\b)/;

// Verbos de contratación inequívocos: no requieren que se hayan presentado los
// paquetes en la conversación, porque contratar/coordinar/empezar ya expresa
// intención comercial por sí solo.
const CONTRACT_INTENT_REGEX =
  /\b(CONTRATAR|CONTRATARLOS|CONTRATO|COORDINAR|EMPEZAR|EMPIEZO|COMENZAR|COMIENZO|INICIAR)\b/;

// Señales de interés genérico (sin elegir 6 vs 12 vs 18) que, DESPUÉS de haberse
// presentado los paquetes, ya valen como intención de compra suficiente para
// forzar el formulario. Excluye deliberadamente "SI" y "VA" sueltos (demasiado
// ambiguos como respuesta de sí/no genérica fuera de contexto de paquetes).
const GENERIC_INTEREST_REGEX =
  /\b(ME INTERESA|ME INTERESAN|QUIERO|LO QUIERO|LOS QUIERO|DAME|DALE|ADELANTE|PROCEDAMOS|EMPECEMOS)\b/;

// Red de seguridad: interés genérico de contratar paquetes, sin elegir un
// paquete específico (cantidad, nombre, precio o referencia). Complementa a
// detectPackageSelection para no perder leads que dicen "me interesa" o
// "quiero contratar" sin especificar cantidad. A diferencia de
// detectPackageSelection, NO se suprime por GENERIC_INFO_REGEX: los paquetes ya
// se mostraron, así que "quiero saber los paquetes" + interés debe convertir,
// no volver a informar.
function detectGeneralPurchaseIntent(
  text: string,
  packagesPresented: boolean,
): boolean {
  if (!text) return false;

  const normalized = normalizeForMatch(text);

  if (SPECIFIC_QUESTION_REGEX.test(normalized)) return false;

  // "Coordinar/empezar" sobre la VISITA no es intención de contratar paquetes:
  // "coordinemos la cita", "vamos a coordinar la visita a la oficina". Solo se
  // descarta si el mensaje habla de la cita y no menciona paquetes.
  const isAboutAppointment =
    APPOINTMENT_KEYWORDS.test(normalized) &&
    !SERVICE_PACKAGES_KEYWORDS.test(normalized);

  if (CONTRACT_INTENT_REGEX.test(normalized)) return !isAboutAppointment;
  if (isAboutAppointment) return false;
  if (!packagesPresented) return false;

  return GENERIC_INTEREST_REGEX.test(normalized);
}

// Nombres propios de los paquetes tal como salen en el flyer. Como el cliente solo puede
// conocerlos DESPUÉS de ver el flyer, mencionar uno equivale a elegir un paquete →
// intención clara de contratar. Vive en lib/packages.ts, que excluye "CapCut Pro": ese es
// el curso, no el paquete Pro.
const PACKAGE_NAME_REGEX = PACKAGE_NAME_MATCH_REGEX;

// Detecta si el mensaje del cliente es una elección afirmativa de un paquete
// válido (6, 12 o 18), excluyendo preguntas de precio y montos en Bs (2500/3500/5500 no
// cuentan como cantidad porque no son el número exacto de videos).
function detectPackageChoice(text: string): boolean {
  if (!text) return false;

  const normalized = normalizeForMatch(text);

  if (PRICE_QUESTION_REGEX.test(normalized)) return false;
  if (!AFFIRMATIVE_CHOICE_REGEX.test(normalized)) return false;

  return containsExactNumber(normalized, PACKAGE_SIZES);
}

// Detecta si el cliente menciona el NOMBRE de un paquete (Básico/Normal/Pro). Basta
// con nombrarlo (no requiere frase afirmativa): conocer el nombre implica haber
// visto el flyer. Se excluye si es una consulta de precio ("cuánto cuesta el pro").
function detectPackageNameChoice(text: string): boolean {
  if (!text) return false;
  const normalized = normalizeForMatch(text);
  if (PRICE_QUESTION_REGEX.test(normalized)) return false;
  return PACKAGE_NAME_REGEX.test(normalized);
}

// ¿La respuesta que se va a enviar ES el formulario de intake? Se detecta por los
// campos obligatorios del formulario, no por igualdad exacta, para tolerar que el LLM
// lo reproduzca con un intro distinto. Reemplaza a la guarda por flag del LLM, que
// podía marcar service_intake_requested=true sin incluir realmente el formulario.
function replyContainsIntakeForm(reply: string): boolean {
  if (!reply) return false;
  const normalized = normalizeForMatch(reply);
  return (
    normalized.includes("NOMBRE DE TU EMPRESA") &&
    normalized.includes("RUBRO O SECTOR")
  );
}

// ¿El asistente ya PRESENTÓ los paquetes de producción en esta conversación?
// Es el contexto que habilita las selecciones por referencia ("ese", "el primero").
// Antes esto dependía solo de que se hubiera enviado el flyer como imagen; pero el
// bot también responde precios y paquetes por TEXTO, y en ese caso el cliente elige
// igual. Se mira el historial ya cargado en memoria: sin queries ni llamadas extra a
// OpenAI.
// Importante: exige contexto de PAQUETES (no de cursos), para que "el primero" o
// "el básico" en una conversación de cursos NO dispare el formulario. Un mensaje del bot
// sobre un curso no cuenta aunque nombre "Edición Persuasiva en CapCut Pro" o una fecha
// que coincide con una cantidad de paquete ("domingo 18"): contaba, y desde el curso de
// CapCut Pro (sep 2026) apagaba el QR y mandaba el formulario a quien quería su entrada.
function detectPackagesPresented(
  history: HistoryMessage[],
  flyerAlreadySent: boolean,
): boolean {
  if (flyerAlreadySent) return true;

  return history
    .filter((message) => message.role === "assistant")
    .some((message) => {
      const normalized = normalizeForMatch(message.content);

      // El marcador del flyer de paquetes también cuenta como presentación.
      if (normalized.includes("MEDIA_SENT:SERVICE_PACKAGES")) return true;
      // El texto de "¿Cómo trabajamos...?" sale junto con los flyers de paquetes.
      if (normalized.includes(HOW_WE_WORK_MARKER)) return true;
      // El mensaje con el botón a la página de paquetes (o a su formulario) también.
      const buttonKind = detectButtonTextKind(message.content);
      if (buttonKind === "packages" || buttonKind === "packages_form") return true;

      if (COURSE_KEYWORDS.test(normalized) && !/\bPAQUETES?\b/.test(normalized)) return false;

      const talksAboutPackages = SERVICE_PACKAGES_KEYWORDS.test(normalized);
      const showsTheOffer =
        containsExactNumber(normalized, PACKAGE_SIZES) ||
        containsExactNumber(normalized, PACKAGE_PRICES) ||
        PACKAGE_NAME_REGEX.test(normalized);

      return talksAboutPackages && showsTheOffer;
    });
}

// ¿La conversación está anclada en la línea de CURSOS? Red de seguridad determinista
// contra el bug real: el LLM llegó a mandar el formulario de leads de paquetes (📌
// Nombre, empresa, rubro...) a un cliente que solo había hablado de cursos, porque leyó
// "en ese estaba interesado" (sobre un curso) como si eligiera un paquete. El prompt ya
// aclara que el formulario es exclusivo de paquetes, pero esa regla es interpretable —
// esta función es la guarda dura: si la conversación está en cursos, el formulario no debe
// salir pase lo que pase el LLM (salvo que el cliente pida paquetes de forma explícita).
//
// Decide el ÚLTIMO mensaje del bot que habla de una sola línea: quien vio los paquetes y
// después preguntó por el curso está en el curso. Antes bastaba con haber recibido alguna
// vez el flyer de paquetes (se mira por teléfono, en cualquier conversación) para perder el
// contexto de cursos, y un "no sé si tendrían enchufe, yo edito en laptop" sobre el curso
// recibía el formulario de datos de empresa (18 sep 2026).
function detectCourseContext(
  history: HistoryMessage[],
  flyerCourseAlreadySent: boolean,
  packagesPresented: boolean,
): boolean {
  const assistantMessages = history.filter((message) => message.role === "assistant");

  for (let i = assistantMessages.length - 1; i >= 0; i--) {
    const line = classifyAssistantLine(assistantMessages[i].content);
    if (line) return line === "course";
  }

  if (packagesPresented) return false;
  return flyerCourseAlreadySent;
}

// ¿De qué línea habla este mensaje del bot? null = de ninguna en particular (saludo,
// agradecimiento, pedido de contexto).
function classifyAssistantLine(content: string): "course" | "packages" | null {
  const normalized = normalizeForMatch(content);

  // El saludo y las preguntas de orientación nombran las TRES líneas ("cursos
  // presenciales, servicios de grabación y agentes de IA"): eso es un menú, no una
  // conversación de cursos. Contarlo bloqueaba el formulario a clientes de paquetes
  // que respondían al saludo ("costos de marketing para mi negocio").
  if (SERVICE_PACKAGES_KEYWORDS.test(normalized) && AI_AGENT_KEYWORDS.test(normalized)) {
    return null;
  }

  // "Si decides elegir un paquete, aquí estoy" no presenta nada: hace falta el formulario,
  // el texto de cómo trabajamos, o "paquete" junto a un nombre, un precio o "videos".
  // El mensaje con el botón a una página también dice de qué línea se habla.
  const buttonKind = detectButtonTextKind(content);
  if (buttonKind === "courses") return "course";

  const presentsPackages =
    buttonKind !== null ||
    normalized.includes(HOW_WE_WORK_MARKER) ||
    replyContainsIntakeForm(content) ||
    (/\bPAQUETES?\b/.test(normalized) &&
      (PACKAGE_NAME_REGEX.test(normalized) ||
        containsExactNumber(normalized, PACKAGE_PRICES) ||
        /\bVIDEOS\b/.test(normalized)));
  if (presentsPackages) return "packages";

  return COURSE_KEYWORDS.test(normalized) ? "course" : null;
}

// ¿El asistente ya le hizo la pregunta de edición ambigua (paquete completo o solo
// edición)? Si ya la hizo, no se repite: el cliente decide con su respuesta.
function detectEditingClarifyAsked(history: HistoryMessage[]): boolean {
  return history
    .filter((message) => message.role === "assistant")
    .some((message) => normalizeForMatch(message.content).includes("PAQUETE COMPLETO:"));
}

// ¿Algún mensaje anterior del cliente ya aclaró si tiene los videos o si busca que se los
// graben? Entonces un "edición" posterior no es ambiguo.
function detectEditingClarifiedByClient(history: HistoryMessage[]): boolean {
  return history
    .filter((message) => message.role === "user")
    .some((message) => {
      const kind = detectEditingRequest(message.content);
      return kind === "editing_only" || kind === "packages";
    });
}

// Frases fijas con las que el asistente OFRECE el pago/reserva de un curso. Si
// aparecen en sus últimos mensajes, un afirmativo seco del cliente ("sí", "dale")
// significa "quiero pagar" — mismo patrón que APPOINTMENT_PROMPT_MARKERS. Es la red
// de seguridad para el bug real: el bot preguntó "¿te reservo el cupo mientras?", el
// cliente dijo "sí", y el LLM no marcó intents.payment_qr porque los ejemplos del
// prompt son mensajes explícitos del cliente, no una respuesta afirmativa a su propia
// oferta.
const PAYMENT_OFFER_PROMPT_MARKERS = [
  "TE PASO EL QR",
  "TE ENVIO EL QR",
  "TE MANDO EL QR",
  "QR DE PAGO",
  "ASEGURAR TU CUPO",
  "RESERVAR TU CUPO",
  "TE RESERVO EL CUPO",
  "APARTAR TU CUPO",
  "QUIERES INSCRIBIRTE",
  "QUIERES SUMARTE",
  "PREVENTA",
];

function detectPaymentOfferPending(history: HistoryMessage[]): boolean {
  return history
    .filter((message) => message.role === "assistant")
    .slice(-3)
    .some((message) => {
      const normalized = normalizeForMatch(message.content);
      return PAYMENT_OFFER_PROMPT_MARKERS.some((marker) =>
        normalized.includes(marker),
      );
    });
}

// Por qué se fuerza el QR en este turno. Solo "qr_request" (el cliente pidió el QR con
// todas las letras) lo manda aunque lo haya recibido hace un rato; los otros dos respetan
// la ventana de 1 hora: si el QR está arriba en el chat, el bot se lo recuerda.
type ForcedQrReason = CoursePaymentRequest | "offer_accepted";

// Red de seguridad determinista para el QR de pago de cursos, análoga a
// shouldForceIntakeForm para paquetes. Cubre tres casos: (1) el cliente pide el QR,
// (2) quiere pagar o reservar ("quiero pagar mi entrada", "reservar mi curso"), y (3)
// responde afirmativo a una oferta de pago que el propio bot acaba de hacer.
//
// IMPORTANTE: la intención explícita se evalúa ANTES de cualquier guarda de pregunta.
// PRICE_QUESTION_REGEX incluye un "?" suelto y bloquearía "¿cómo pago?" o "¿me pasas
// el QR?", que son intenciones reales de inscripción, no preguntas informativas.
function shouldForcePaymentQr(params: {
  // Lo que el cliente escribió desde la última respuesta del bot.
  text: string;
  history: HistoryMessage[];
  courseContext: boolean;
  packagesPresented: boolean;
  // El QR salió hace menos de 1 hora (MEDIA_RESEND_WINDOW_HOURS.payment_qr).
  qrSentRecently: boolean;
  // false cuando no hay ningún curso a la venta (p. ej. el único ya empezó).
  courseSellable: boolean;
}): ForcedQrReason | null {
  if (!params.courseSellable || !params.text) return null;

  // "Ahora quiero el paquete de 12" después de hablar del curso pide un paquete.
  if (hasStrongPackageSignal(params.text)) return null;

  // payment_qr es EXCLUSIVO de cursos (ver prompt). En una conversación de paquetes,
  // "quiero pagar" o "me pasas el QR" se refieren al adelanto del paquete, que coordina el
  // asesor: solo cuenta si el mensaje nombra el curso o su entrada ("quiero pagar mi
  // entrada del curso"). Los paquetes nunca tienen entradas ni cupos.
  if (params.packagesPresented && !params.courseContext && !mentionsCourse(params.text)) {
    return null;
  }

  const request = detectCoursePaymentRequest(params.text);
  if (request === "qr_request") return request;
  if (request === "pay_intent") return params.qrSentRecently ? null : request;

  // Afirmativo seco tras una oferta de pago del asistente, en conversación de curso.
  const normalized = normalizeForMatch(params.text);
  if (params.qrSentRecently) return null;
  if (!params.courseContext && !COURSE_KEYWORDS.test(normalized)) return null;
  if (!detectPaymentOfferPending(params.history)) return null;

  return acceptsPaymentOffer(params.text) ? "offer_accepted" : null;
}

// Un "sí" a la oferta del QR es corto y afirmativo desde la primera palabra ("si", "dale",
// "sí porfa", "ya quiero"). Con AFFIRMATIVE_CHOICE_REGEX, que busca en cualquier parte,
// "¿a qué hora son las clases?" o "no sé si tendrían enchufe" aceptaban el QR.
const PAYMENT_OFFER_ACCEPTANCE_REGEX =
  /^\W*(SI+|SIP|DALE|OK|OKEY|OKAY|YA|CLARO|BUENO|LISTO|PERFECTO|DE UNA|POR FAVOR|PORFA\w*|QUIERO|LO QUIERO|ME INTERESA|DAME|VA|VAMOS)\b/;

function acceptsPaymentOffer(text: string): boolean {
  const lines = normalizeForMatch(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.some((line) => line.includes("?"))) return false;

  return lines.some(
    (line) => line.split(/\s+/).length <= 6 && PAYMENT_OFFER_ACCEPTANCE_REGEX.test(line),
  );
}

// Todo lo que el cliente escribió desde la última respuesta del bot. Cuando escribe en
// ráfaga ("si quiero entrar" / "el qr porfavor" / "¿puedo llevar mi laptop?"), cada
// mensaje llega en su propio webhook y solo responde el último: mirando solo ese, el
// pedido del QR del mensaje del medio se perdía.
// Lo que el cliente escribió desde la ráfaga del comprobante (incluida) en adelante: sus
// datos de pago pueden llegar repartidos en varios turnos (el nombre en uno, el curso en otro).
// El comprobante se reconoce por la respuesta "¡Gracias por el comprobante!" del bot.
function textsSinceReceiptAsk(history: HistoryMessage[], fallback: string): string[] {
  const isAssistant = history.map((message) => message.role === "assistant");
  const askIndex = history
    .map(
      (message) =>
        message.role === "assistant" &&
        normalizeForMatch(message.content).includes("GRACIAS POR EL COMPROBANTE"),
    )
    .lastIndexOf(true);
  if (askIndex < 0) return [fallback];

  const batchStart = isAssistant.slice(0, askIndex).lastIndexOf(true) + 1;
  const texts = history
    .slice(batchStart)
    .filter((message) => message.role === "user")
    .map((message) => message.content);

  return texts.length > 0 ? texts : [fallback];
}

function getUnansweredClientText(history: HistoryMessage[], batchText: string): string {
  const lastAssistantIndex = history.map((message) => message.role).lastIndexOf("assistant");
  const pending = history
    .slice(lastAssistantIndex + 1)
    .filter((message) => message.role === "user")
    .map((message) => message.content);

  return pending.length > 0 ? pending.join("\n") : batchText;
}

// Señal INEQUÍVOCA de que el cliente quiere contratar paquetes de producción. Es lo
// único que puede abrir el formulario en una conversación de cursos y lo que habilita
// el aviso de cantidad fuera de catálogo.
function hasExplicitPackageIntent(text: string): boolean {
  if (!text) return false;
  const normalized = normalizeForMatch(text);

  // "Coordinar/empezar" referido a la visita no es intención de contratar paquetes.
  if (
    APPOINTMENT_KEYWORDS.test(normalized) &&
    !SERVICE_PACKAGES_KEYWORDS.test(normalized)
  ) {
    return false;
  }

  // Mismo criterio para los CURSOS, y por un motivo concreto: los dos cursos del catálogo
  // se llaman "creación de CONTENIDO" y "EDICIÓN en CapCut", y esas palabras están dentro
  // de SERVICE_PACKAGES_KEYWORDS. Sin esta guarda, "quiero el curso de creación de
  // contenido" contaba como intención explícita de paquetes, desactivaba el bloqueo de
  // cursos y le mandaba el formulario de datos de empresa a alguien que solo quiere un
  // curso. Solo una señal FUERTE de paquete gana: la palabra "paquete", una cantidad del
  // catálogo (6/12/18), un precio del catálogo (2500/3500/5500) o el nombre propio del
  // paquete. "Contenido", "edición" y "videos" a secas NO alcanzan.
  if (COURSE_KEYWORDS.test(normalized) && !hasStrongPackageSignal(text)) {
    return false;
  }

  return (
    SERVICE_PACKAGES_KEYWORDS.test(normalized) ||
    CONTRACT_INTENT_REGEX.test(normalized) ||
    detectPackagePriceMention(text) ||
    detectPackageChoice(text) ||
    detectPackageNameChoice(text)
  );
}

// Señales que un cliente solo puede producir si está hablando de los paquetes de la
// LÍNEA B, incluso si en el mismo mensaje nombra un curso ("hice el curso, ahora quiero
// un paquete de 12"). Deliberadamente NO incluye CONTENIDO, EDICION ni VIDEOS.
function hasStrongPackageSignal(text: string): boolean {
  if (!text) return false;
  const normalized = normalizeForMatch(text);

  if (
    /\bPAQUETE(S)?\b/.test(normalized) ||
    PACKAGE_NAME_REGEX.test(normalized) ||
    containsExactNumber(normalized, PACKAGE_PRICES)
  ) {
    return true;
  }

  // Si el mensaje habla de un curso, un 6, 12 o 18 suelto suele ser una fecha ("el curso
  // del 18"): solo cuenta como paquete si viene con la palabra "videos".
  if (mentionsCourse(text)) {
    const count = detectRequestedVideoCount(text);
    return count !== null && PACKAGE_SIZES.includes(count);
  }

  return containsExactNumber(normalized, PACKAGE_SIZES);
}

// Selección de un paquete por parte del cliente. Dos niveles de confianza:
//
//  1. Autosuficiente (no necesita contexto): el cliente nombra el paquete de forma
//     inequívoca — cantidad exacta 6/12/18 con frase afirmativa, nombre propio del
//     paquete (Básico/Normal/Pro), o el precio exacto (2500/3500/5500). Solo puede conocer
//     estos datos si ya vio la oferta, así que mencionarlos ES elegir.
//  2. Por referencia (requiere packagesPresented): deícticos, ordinales y superlativos
//     ("ese quiero", "el primero", "el más económico"). Sin la oferta a la vista no
//     significan nada, por eso se exige que el asistente ya haya presentado paquetes.
//
// En ambos niveles, una pregunta NUNCA es una selección (PRICE_QUESTION_REGEX).
function detectPackageSelection(
  text: string,
  packagesPresented: boolean,
): boolean {
  if (!text) return false;

  const normalized = normalizeForMatch(text);
  if (PRICE_QUESTION_REGEX.test(normalized)) return false;

  const selectsByName = detectPackageChoice(text) || detectPackageNameChoice(text);

  // "El paquete de 2500" / "el de 5500": el precio exacto identifica el paquete.
  const selectsByPrice =
    containsExactNumber(normalized, PACKAGE_PRICES) &&
    (AFFIRMATIVE_CHOICE_REGEX.test(normalized) ||
      SERVICE_PACKAGES_KEYWORDS.test(normalized));

  if (selectsByName || selectsByPrice) return true;

  if (!packagesPresented) return false;

  // "Quiero información" también es afirmativo, pero no señala ningún paquete.
  if (GENERIC_INFO_REGEX.test(normalized)) return false;

  return (
    CONTEXTUAL_CHOICE_REGEX.test(normalized) ||
    AFFIRMATIVE_CHOICE_REGEX.test(normalized)
  );
}

// Decisión unificada para forzar el formulario de intake: el cliente seleccionó un
// paquete de forma inequívoca (por número, nombre, precio o referencia en contexto)
// O expresó interés genérico de contratar sin especificar paquete (ver
// detectGeneralPurchaseIntent).
function shouldForceIntakeForm(
  text: string,
  history: HistoryMessage[],
  flyerAlreadySent: boolean,
): boolean {
  const presented = detectPackagesPresented(history, flyerAlreadySent);

  return (
    detectPackageSelection(text, presented) ||
    detectGeneralPurchaseIntent(text, presented)
  );
}

// Detecta la mención de un precio de paquete (2500, 3500 o 5500) como monto exacto.
// Excluye números mayores que lo contengan ("25000", "35000", "55000") por tokenización.
function detectPackagePriceMention(text: string): boolean {
  if (!text) return false;
  return containsExactNumber(normalizeForMatch(text), PACKAGE_PRICES);
}

type DetectedIntent =
  | "service_packages"
  | "course"
  | "office"
  | "ai_agent"
  | "editing_ambiguous";

// Verbos y fórmulas con las que un cliente PIDE algo de una línea concreta. Junto con la
// palabra clave de esa línea, son la señal mínima para aceptar un cambio de flujo.
const LINE_REQUEST_REGEX =
  /\b(QUIERO|QUISIERA|QUERIA|ME INTERESA|ME INTERESAN|NECESITO|BUSCO|TIENEN|TIENES|HAY|INFORMACION|INFO|INFORMES|DETALLES|PRECIO|PRECIOS|COSTO|CUANTO|CUANTOS|COMO FUNCIONA|QUE ES|MANDAME|MANDA|ENVIAME|ENVIA|PASAME|MUESTRAME|VER|CONTRATAR)\b/;

const LINE_KEYWORDS: Record<"course_flyer" | "service_packages" | "ai_agent_flyer", RegExp> =
  {
    course_flyer: COURSE_KEYWORDS,
    service_packages: SERVICE_PACKAGES_KEYWORDS,
    ai_agent_flyer: AI_AGENT_KEYWORDS,
  };

// ¿El cliente pidió EXPLÍCITAMENTE cambiar a otra línea de negocio? Exige la palabra
// clave de la línea destino MÁS un verbo de petición, o una frase larga sobre ella.
// Una mención suelta ("todo IA", "con IA") en medio de otro flujo NO alcanza: ahí el
// cliente está preguntando sobre lo que ya se está hablando.
function detectExplicitLineSwitch(
  text: string,
  targetLine: keyof typeof LINE_KEYWORDS,
): boolean {
  if (!text) return false;

  const normalized = normalizeForMatch(text);
  if (!LINE_KEYWORDS[targetLine].test(normalized)) return false;

  // "Quiero el curso de edición" nombra palabras de paquetes, pero pide un curso.
  if (
    targetLine === "service_packages" &&
    COURSE_KEYWORDS.test(normalized) &&
    !hasStrongPackageSignal(text)
  ) {
    return false;
  }

  const wordCount = normalized.trim().split(/\s+/).length;

  return LINE_REQUEST_REGEX.test(normalized) || wordCount >= 6;
}

// Detecta de forma determinista si el mensaje del cliente ya expresa una intención
// concreta (para no responder con el saludo genérico). Devuelve la primera que
// aplique según prioridad: agente de IA > edición ambigua > paquete nombrado > cursos >
// vocabulario de paquetes > oficina.
function detectExplicitIntent(text: string): DetectedIntent | null {
  if (!text) return null;

  const normalized = normalizeForMatch(text);

  // Primero el agente de IA: sus mensajes suelen traer palabras que también
  // aparecen en SERVICE_PACKAGES_KEYWORDS ("servicio", "edicion", "contenido").
  if (AI_AGENT_KEYWORDS.test(normalized)) return "ai_agent";

  // "Edición" sin aclarar si ya tiene los videos: se pregunta, no se manda el flyer.
  const editing = detectEditingRequest(text);
  if (editing === "ambiguous" && !mentionsExpiredEditPromo(text)) return "editing_ambiguous";

  // Antes que las señales de paquetes: "quiero dos cupos para el curso del 18" o "quiero
  // comprar mi entrada" piden un curso, aunque traigan un número o un "quiero".
  const strongPackageSignal = hasStrongPackageSignal(text);
  if (mentionsCourse(text) && !strongPackageSignal) return "course";

  if (
    detectPackagePriceMention(text) ||
    detectPackageChoice(text) ||
    detectPackageNameChoice(text) ||
    strongPackageSignal
  ) {
    return "service_packages";
  }
  // Antes que el vocabulario general de paquetes: "curso de edición" o "clases de
  // marketing" nombran palabras de paquetes, pero piden un curso.
  if (COURSE_KEYWORDS.test(normalized)) return "course";
  if (SERVICE_PACKAGES_KEYWORDS.test(normalized) && editing !== "editing_only") {
    return "service_packages";
  }
  if (APPOINTMENT_KEYWORDS.test(normalized)) return "office";

  return null;
}

const EXPLICIT_PAYMENT_PHRASES =
  /\b(COMPROBANTE|YA PAGUE|REALICE EL PAGO|HICE EL PAGO|PAGO REALIZADO|YA CANCELE|YA DEPOSITE|DEPOSITE|YA TRANSFERI|TRANSFERI)\b/;
const VAGUE_SEND_PHRASES = /\b(YA MANDE|YA PASE|YA ENVIE)\b/;

// ¿Ya salió el texto "¿Cómo trabajamos con nuestros clientes?" en esta conversación? El
// modelo solo ve los últimos 12 mensajes; esto le avisa aunque el texto haya quedado atrás,
// para que no lo repita entero cada vez que el cliente pregunta algo de los paquetes.
async function hasHowWeWorkBeenSent(conversationId?: string): Promise<boolean> {
  if (!conversationId) return false;

  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("kapso_messages")
    .select("id")
    .eq("kapso_conversation_id", conversationId)
    .eq("direction", "outbound")
    .ilike("content", "%trabajamos con nuestros clientes%")
    .limit(1);

  if (error) {
    console.error("supabase check how-we-work sent failed", error);
    return false;
  }

  return (data ?? []).length > 0;
}

async function hasIntakeFormBeenSent(conversationId?: string): Promise<boolean> {
  if (!conversationId) return false;

  const supabase = getSupabaseClient();

  // Fuente de verdad: columna de estado. Fallback al marcador de texto para
  // conversaciones anteriores a la migración (o si la columna aún no se pobló).
  const { data: conv } = await supabase
    .from("kapso_conversations")
    .select("intake_form_sent_at")
    .eq("kapso_conversation_id", conversationId)
    .maybeSingle();

  if (conv?.intake_form_sent_at) return true;

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

// ¿Un humano mandó a mano una imagen/documento desde WhatsApp Business en esta
// conversación (ej. el QR de pago, cuando el envío automático falló o no se marcó)?
// Habilita que la siguiente imagen del cliente se verifique con visión aunque
// mediaStatus.payment_qr siga en false — ver imageReceiptEligible.
async function hasManualHumanMediaBeenSent(conversationId?: string): Promise<boolean> {
  if (!conversationId) return false;

  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("kapso_messages")
    .select("id")
    .eq("kapso_conversation_id", conversationId)
    .eq("direction", "outbound")
    .ilike("content", "[MEDIA_SENT:manual_human]%")
    .limit(1);

  if (error) {
    console.error("supabase check manual human media sent failed", error);

    await logSystemEvent({
      level: "error",
      eventType: "supabase_manual_human_media_check_failed",
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

async function hasTelegramLeadBeenSent(conversationId?: string): Promise<boolean> {
  if (!conversationId) return false;

  const supabase = getSupabaseClient();

  // Fuente de verdad: columna advisor_notified_at. Fallback al marcador de texto
  // para conversaciones anteriores a la migración.
  const { data: conv } = await supabase
    .from("kapso_conversations")
    .select("advisor_notified_at")
    .eq("kapso_conversation_id", conversationId)
    .maybeSingle();

  if (conv?.advisor_notified_at) return true;

  const { data, error } = await supabase
    .from("kapso_messages")
    .select("id")
    .eq("kapso_conversation_id", conversationId)
    .eq("direction", "outbound")
    .ilike("content", "[TELEGRAM_LEAD_SENT]%")
    .limit(1);

  if (error) {
    console.error("supabase check telegram lead sent failed", error);
    return false;
  }

  return (data ?? []).length > 0;
}

// Lo que el cliente hizo en las páginas, según las marcas que dejan /api/leads y
// /api/site-visit en su conversación (ver lib/web-leads.ts):
//   - leadAt / leadPage: envió un formulario (paquetes u oficina). El bot no le vuelve a
//     pedir los datos ni le reenvía el botón del formulario.
//   - lastVisitAt: la última vez que abrió una página desde el botón. Si dice "ya lo envié"
//     y no hay lead, se sabe si al menos entró.
type WebActivity = {
  leadAt: Date | null;
  leadPage: string | null;
  lastVisitAt: Date | null;
  lastVisitPage: string | null;
};

async function getWebActivity(conversationId?: string): Promise<WebActivity> {
  const empty: WebActivity = { leadAt: null, leadPage: null, lastVisitAt: null, lastVisitPage: null };
  if (!conversationId) return empty;

  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("kapso_messages")
    .select("content, created_at")
    .eq("kapso_conversation_id", conversationId)
    .eq("direction", "outbound")
    .or(`content.like."${WEB_LEAD_MARKER_PREFIX}%",content.like."${SITE_VISIT_MARKER_PREFIX}%"`)
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) {
    console.error("supabase check web activity failed", error);
    return empty;
  }

  const activity = { ...empty };

  for (const row of data ?? []) {
    const content = String(row.content ?? "");
    const at = new Date(row.created_at);

    if (!activity.leadAt && content.startsWith(WEB_LEAD_MARKER_PREFIX)) {
      activity.leadAt = at;
      activity.leadPage = content.slice(WEB_LEAD_MARKER_PREFIX.length).trim().replace(/^\//, "");
    } else if (!activity.lastVisitAt && content.startsWith(SITE_VISIT_MARKER_PREFIX)) {
      activity.lastVisitAt = at;
      activity.lastVisitPage = /^\[SITE_VISIT:(\w+)\]/.exec(content)?.[1] ?? null;
    }
  }

  return activity;
}

// Ventana de dedup: 6 h. Antes el marcador [TELEGRAM_PAYMENT_SENT] bloqueaba para
// SIEMPRE cualquier pago posterior de la misma conversación (un cliente que pagara
// un segundo curso meses después nunca habría alertado). Con la ventana, 3 fotos
// del MISMO comprobante mandadas seguidas generan una sola alerta, pero un pago
// real posterior (fuera de la ventana) sí alerta.
const PAYMENT_ALERT_DEDUP_WINDOW_MINUTES = 360;

async function hasTelegramPaymentBeenSent(params: {
  conversationId?: string;
  messageId?: string;
}): Promise<boolean> {
  if (!params.conversationId) return false;

  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("kapso_messages")
    .select("content, created_at")
    .eq("kapso_conversation_id", params.conversationId)
    .eq("direction", "outbound")
    .ilike("content", "[TELEGRAM_PAYMENT_SENT%")
    .order("created_at", { ascending: false })
    .limit(5);

  if (error) {
    console.error("supabase check telegram payment sent failed", error);
    return false;
  }

  const rows = data ?? [];
  if (rows.length === 0) return false;

  // Mismo mensaje ya notificado (reintento/reproceso del webhook): siempre dedup,
  // sin importar cuánto tiempo pasó.
  if (params.messageId) {
    const sameMessage = rows.some((row) =>
      String(row.content ?? "").includes(`:${params.messageId}]`),
    );
    if (sameMessage) return true;
  }

  const mostRecent = rows[0];
  const ageMinutes =
    (Date.now() - new Date(mostRecent.created_at as string).getTime()) / 60_000;

  return ageMinutes < PAYMENT_ALERT_DEDUP_WINDOW_MINUTES;
}

// Quien quiere reunirse en la oficina deja sus datos turnos después de pedirlo. Este
// marcador conserva el pedido para que la alerta del lead avise al asesor que tiene que
// coordinar la reunión en la llamada.
const OFFICE_VISIT_MARKER = "[OFFICE_VISIT_REQUESTED]";

// Visita por un CURSO: no hay formulario que dispare una alerta de lead más adelante, así
// que el aviso al asesor sale en el mismo turno (una sola vez por conversación).
const COURSE_OFFICE_VISIT_ALERT_MARKER = "[TELEGRAM_COURSE_OFFICE_VISIT_SENT]";

// Alguien quiso pagar el curso cuando la preventa ya había cerrado (faltan menos de 10
// minutos para empezar). El bot ya no manda el QR, pero es una venta a punto de perderse:
// el equipo tiene esos minutos para pasarle el QR a mano o cobrarle en la puerta.
const PRESALE_CLOSED_QR_ALERT_MARKER = "[TELEGRAM_PRESALE_CLOSED_QR_SENT]";

async function notifyCourseOfficeVisitToTelegram(params: {
  phone: string;
  conversationId?: string;
  clientMessage: string;
  summary?: string;
}): Promise<void> {
  if (await hasTelegramMarkerBeenSent(params.conversationId, COURSE_OFFICE_VISIT_ALERT_MARKER)) {
    return;
  }

  const notified = await sendTelegramNotification(
    buildTelegramBody({
      headline: "🏢 <b>Quiere visitar la oficina — Curso</b>",
      phone: params.phone,
      clientMessage: params.clientMessage,
      summary: params.summary,
      contextLabel: "Curso — llamarlo para indicarle la hora de la visita",
      note: "📞 El bot NO agendó nada: le dijo que un asesor lo llama y le preguntó sus dudas del curso.",
    }),
  );

  if (notified) {
    await saveOutboundMessage({
      conversationId: params.conversationId,
      phone: params.phone,
      content: `${COURSE_OFFICE_VISIT_ALERT_MARKER} aviso de visita por curso enviado a Telegram`,
      rawPayload: { type: "telegram_notification", event: "course_office_visit" },
    });
  }
}

// Aviso al equipo cuando el corte de la preventa deja a un cliente sin QR. Va una sola
// vez por conversación: si insiste, el equipo ya fue avisado y está el chat abierto.
async function notifyPresaleClosedQrToTelegram(params: {
  phone: string;
  conversationId?: string;
  clientMessage: string;
  summary?: string;
  courseName: string;
  startsAtLabel: string;
  pricePresencial: number;
}): Promise<void> {
  if (await hasTelegramMarkerBeenSent(params.conversationId, PRESALE_CLOSED_QR_ALERT_MARKER)) {
    return;
  }

  const notified = await sendTelegramNotification(
    buildTelegramBody({
      headline: "⏰ <b>Quiere pagar y la preventa ya cerró — Curso</b>",
      phone: params.phone,
      clientMessage: params.clientMessage,
      summary: params.summary,
      contextLabel: `${params.courseName} — empieza ${params.startsAtLabel}`,
      note: `💸 El bot NO le mandó el QR (el corte es 10 min antes de empezar). Pásaselo a mano si le da el tiempo, o cóbrale ${params.pricePresencial} Bs en la puerta.`,
    }),
  );

  if (notified) {
    await saveOutboundMessage({
      conversationId: params.conversationId,
      phone: params.phone,
      content: `${PRESALE_CLOSED_QR_ALERT_MARKER} aviso de preventa cerrada enviado a Telegram`,
      rawPayload: { type: "telegram_notification", event: "presale_closed_qr" },
    });
  }
}

// ¿El bot ya mandó este mismo texto hace un momento? Pasaba 94 veces al mes: el cliente
// escribía justo después de la respuesta y el modelo repetía el bloque entero (paquetes,
// saludo, formulario). Repetirlo no le dice nada nuevo al cliente —lo tiene ahí arriba— y
// cuesta un mensaje de Meta, así que en ese caso no se envía nada.
async function wasSameReplySentRecently(
  conversationId: string | undefined,
  replyText: string,
): Promise<boolean> {
  if (!conversationId || !canSkipAsDuplicate(replyText)) return false;

  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("kapso_messages")
    .select("content")
    .eq("kapso_conversation_id", conversationId)
    .eq("direction", "outbound")
    .gte("created_at", new Date(Date.now() - DUPLICATE_REPLY_WINDOW_MS).toISOString())
    .order("created_at", { ascending: false })
    .limit(10);

  if (error) {
    console.error("supabase check duplicate reply failed", error);
    // Ante la duda se envía: perder una respuesta es peor que repetirla.
    return false;
  }

  return (data ?? []).some((row) => isSameReply(replyText, String(row.content ?? "")));
}

async function hasOfficeVisitBeenRequested(conversationId?: string): Promise<boolean> {
  if (!conversationId) return false;

  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("kapso_messages")
    .select("id")
    .eq("kapso_conversation_id", conversationId)
    .eq("direction", "outbound")
    .like("content", `${OFFICE_VISIT_MARKER}%`)
    .limit(1);

  if (error) {
    console.error("supabase check office visit requested failed", error);
    return false;
  }

  return (data ?? []).length > 0;
}

async function hasTelegramHandoffBeenSent(conversationId?: string): Promise<boolean> {
  return hasTelegramMarkerBeenSent(conversationId, HANDOFF_MARKER);
}

// El LEAD por cantidad fuera de los paquetes lleva marcador PROPIO: si compartiera el
// del handoff genérico, una conversación que ya derivó por otro motivo (una pregunta no
// documentada, por ejemplo) dejaría al asesor sin aviso justo cuando el cliente dice
// cuántos videos quiere comprar — que es el aviso que más importa.
async function hasTelegramCustomQuantityBeenSent(
  conversationId?: string,
): Promise<boolean> {
  return hasTelegramMarkerBeenSent(conversationId, CUSTOM_QUANTITY_MARKER);
}

// Mismo criterio para el extra pedido sobre un paquete (dron y compañía): es un LEAD con
// una cotización pendiente, y perderlo porque la conversación ya derivó antes por otro
// motivo dejaría al cliente esperando un precio que nadie le va a mandar.
async function hasTelegramPackageAddonBeenSent(
  conversationId?: string,
): Promise<boolean> {
  return hasTelegramMarkerBeenSent(conversationId, PACKAGE_ADDON_MARKER);
}

// Mismo criterio para el cliente que dice tener un acuerdo previo: es el aviso más
// urgente de todos (hay una persona del equipo que ya le prometió algo), así que no
// puede quedarse sin enviar porque la conversación ya haya derivado por otra cosa.
async function hasTelegramPriorAgreementBeenSent(
  conversationId?: string,
): Promise<boolean> {
  return hasTelegramMarkerBeenSent(conversationId, PRIOR_AGREEMENT_MARKER);
}

// Marcador de dedup que le toca a cada motivo.
function handoffMarkerFor(reason: AdvisorHandoffReason): string {
  if (reason === "custom_quantity") return CUSTOM_QUANTITY_MARKER;
  if (reason === "prior_agreement") return PRIOR_AGREEMENT_MARKER;
  if (reason === "package_addon") return PACKAGE_ADDON_MARKER;
  return HANDOFF_MARKER;
}

async function hasTelegramMarkerBeenSent(
  conversationId: string | undefined,
  marker: string,
): Promise<boolean> {
  if (!conversationId) return false;

  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("kapso_messages")
    .select("id")
    .eq("kapso_conversation_id", conversationId)
    .eq("direction", "outbound")
    .ilike("content", `${marker}%`)
    .limit(1);

  if (error) {
    console.error("supabase check telegram marker sent failed", { marker, error });
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

  // select("*") a propósito, no una lista de columnas: la vigencia se filtra en memoria
  // (ver isMediaAssetInWindow) para que la query siga funcionando exista o no la columna
  // starts_at/expires_at en la base. Pedir una columna inexistente devolvería 400 y esta
  // función caería a [] — es decir, se dejarían de enviar el QR de pago y TODOS los
  // demás materiales — si el código se desplegara antes de correr la migración.
  const { data, error } = await supabase
    .from("kapso_media_assets")
    .select("*")
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

  // Vigencia: un material con expires_at pasado (o starts_at futuro) deja de enviarse
  // aunque siga con is_active = true. Las filas sin fechas no cambian de comportamiento.
  const now = Date.now();
  const rows = data ?? [];
  const inWindow = rows.filter((asset) => isMediaAssetInWindow(asset, now));

  if (inWindow.length < rows.length) {
    console.log(
      "media assets skipped: out of validity window",
      intent,
      rows.length - inWindow.length,
    );
  }

  return inWindow
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

// Último envío de cada botón a las páginas (ver lib/site-links.ts) a este cliente, dentro de
// la ventana en que no se repite. Ante un error de lectura el botón vuelve a salir: un botón
// repetido molesta menos que un cliente sin el link.
async function getLinkButtonsLastSentAt(
  phone: string,
): Promise<Partial<Record<LinkButtonKind, Date>>> {
  if (!phone) return {};

  const supabase = getSupabaseClient();
  const since = new Date(Date.now() - LINK_BUTTON_RESEND_HOURS * 3_600_000).toISOString();

  const { data, error } = await supabase
    .from("kapso_messages")
    .select("content, created_at")
    .eq("contact_phone", phone)
    .eq("direction", "outbound")
    .like("content", `${LINK_SENT_MARKER_PREFIX}%`)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) {
    console.error("supabase read link buttons last sent failed", error);
    return {};
  }

  const lastSent: Partial<Record<LinkButtonKind, Date>> = {};

  for (const row of data ?? []) {
    const kind = /^\[LINK_SENT:(\w+)\]/.exec(String(row.content ?? ""))?.[1] as
      | LinkButtonKind
      | undefined;
    if (kind && !lastSent[kind]) lastSent[kind] = new Date(row.created_at);
  }

  return lastSent;
}

// Mensaje con un botón que abre /paquetes o /cursos. `bodyText` es la respuesta del bot
// cuando el botón viaja pegado a ella, o el texto corto del botón cuando sale aparte.
async function sendLinkButton(params: {
  kapso: WhatsAppClient;
  phoneNumberId: string;
  to: string;
  button: LinkButton;
  bodyText: string;
  footerText?: string;
}) {
  await params.kapso.messages.sendInteractiveCtaUrl({
    phoneNumberId: params.phoneNumberId,
    to: params.to,
    bodyText: params.bodyText,
    ...(params.footerText ? { footerText: params.footerText } : {}),
    parameters: { displayText: params.button.displayText, url: params.button.url },
  });
}

// Marcadores del botón enviado. [LINK_SENT:...] alimenta la ventana de no repetición de cada
// botón; [MEDIA_SENT:<intent>] lo registra como el material de su línea, porque el botón
// reemplazó a los flyers: así siguen funcionando la continuidad de línea, el "ya se le
// envió" que ve el modelo y la ventana de un día. Ambos quedan fuera del historial del
// modelo (ver getRecentConversationHistory).
async function saveLinkButtonSent(params: {
  conversationId?: string;
  phone: string;
  button: LinkButton;
  attachedToReply: boolean;
}) {
  // La visita a la oficina no es material de ninguna línea.
  const lineIntent: MediaIntent | null =
    params.button.kind === "courses"
      ? "course_flyer"
      : params.button.kind === "office"
        ? null
        : "service_packages";

  if (lineIntent) {
    await saveOutboundMessage({
      conversationId: params.conversationId,
      phone: params.phone,
      content: `[MEDIA_SENT:${lineIntent}] botón "${params.button.displayText}"`,
      rawPayload: {
        type: "link_button",
        intent: lineIntent,
        url: params.button.url,
        source: "link_button",
      },
    });
  }

  await saveOutboundMessage({
    conversationId: params.conversationId,
    phone: params.phone,
    content: `${linkSentMarker(params.button.kind)} ${params.button.url}`,
    rawPayload: {
      type: "link_button",
      kind: params.button.kind,
      url: params.button.url,
      display_text: params.button.displayText,
      attached_to_reply: params.attachedToReply,
      forced: params.button.forced,
    },
  });
}

// Resultado discriminado: antes `sendMediaForIntent` devolvía `boolean`, indistinguible
// entre "ya se había enviado" (benigno) y "no hay asset activo" / "falló Kapso"
// (crítico e invisible — el cliente nunca recibe el QR y nadie se entera). Ver
// notifyMediaFailureToTelegram, que usa este resultado para avisar solo en los casos
// críticos.
type MediaSendResult =
  | { status: "sent" }
  | { status: "skipped_already_sent" }
  | { status: "no_assets" }
  | { status: "send_failed"; error: string };

async function sendMediaForIntent(params: {
  intent: MediaIntent;
  conversationId?: string;
  phone: string;
  phoneNumberId: string;
  force?: boolean;
}): Promise<MediaSendResult> {
  // Intents con VENTANA de reenvío (hoy solo service_packages): el flyer de paquetes
  // vuelve a salir pasadas 24h del último envío —precios que cambian, cliente que
  // escribe al día siguiente o a la semana— pero no se repite dentro del mismo día,
  // que era la causa del spam (el cliente recibía las mismas 2 imágenes mientras
  // llenaba el formulario). El resto conserva el dedup permanente por teléfono.
  const hasWindow = MEDIA_RESEND_WINDOW_HOURS[params.intent] !== undefined;

  if (!params.force && hasWindow) {
    const lastSentAt = await getMediaIntentLastSentAt(params.phone, params.intent);
    const decision = shouldResendMedia({
      intent: params.intent,
      lastSentAt,
      now: new Date(),
    });

    if (!decision.send) {
      console.log(
        "media intent within resend window, skipping",
        params.intent,
        maskPhone(params.phone),
        decision.hoursSinceLastSent?.toFixed(1),
      );

      await logSystemEvent({
        level: "info",
        eventType: "media_resend_window_skip",
        conversationId: params.conversationId,
        contactPhone: params.phone,
        metadata: {
          intent: params.intent,
          reason: decision.reason,
          hours_since_last_sent: decision.hoursSinceLastSent,
          window_hours: decision.windowHours,
        },
      });

      return { status: "skipped_already_sent" };
    }
  } else if (!params.force) {
    const alreadySent = await hasMediaIntentBeenSent(params.phone, params.intent);
    if (alreadySent) {
      console.log(
        "media intent already sent, skipping",
        params.intent,
        maskPhone(params.phone),
      );
      return { status: "skipped_already_sent" };
    }
  }

  const assets = await getActiveMediaAssets(params.intent);

  if (assets.length === 0) {
    console.log("no active media assets found for intent", params.intent);
    return { status: "no_assets" };
  }

  let sentAny = false;
  let lastError = "unknown error";

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
      lastError = getErrorMessage(error);
      console.error("kapso media send/save failed", params.intent, asset.title, error);

      await logSystemEvent({
        level: "error",
        eventType: "media_send_failed",
        conversationId: params.conversationId,
        contactPhone: params.phone,
        errorMessage: lastError,
        metadata: {
          intent: params.intent,
          asset_title: asset.title,
          asset_url_present: Boolean(asset.url),
        },
      });
    }
  }

  return sentAny ? { status: "sent" } : { status: "send_failed", error: lastError };
}

// ¿Ya se avisó a Telegram que el envío automático de este intent falló en esta
// conversación? Evita repetir la alerta si el cliente insiste varias veces mientras
// el asset sigue inactivo o Kapso sigue fallando.
async function hasMediaFailureAlertBeenSent(
  conversationId: string | undefined,
  intent: MediaIntent,
): Promise<boolean> {
  if (!conversationId) return false;

  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("kapso_messages")
    .select("id")
    .eq("kapso_conversation_id", conversationId)
    .eq("direction", "outbound")
    .ilike("content", `[TELEGRAM_MEDIA_FAILURE_SENT:${intent}]%`)
    .limit(1);

  if (error) {
    console.error("supabase check media failure alert sent failed", error);
    return false;
  }

  return (data ?? []).length > 0;
}

// Avisa a Telegram cuando el envío AUTOMÁTICO de un material crítico (QR de pago,
// flyer de curso) falla, para que un humano lo mande a mano desde Kapso. Antes esto
// era invisible: el cliente nunca recibía el QR y nadie se enteraba — es la otra
// mitad del incidente real (paso 2 registra cuando un humano lo manda a mano; este
// paso avisa para que lo haga).
const MEDIA_FAILURE_ALERT_INTENTS: MediaIntent[] = ["payment_qr", "course_flyer"];

async function notifyMediaFailureToTelegram(params: {
  intent: MediaIntent;
  phone: string;
  conversationId?: string;
  reason: "no_assets" | "send_failed";
}): Promise<void> {
  if (!MEDIA_FAILURE_ALERT_INTENTS.includes(params.intent)) return;
  if (await hasMediaFailureAlertBeenSent(params.conversationId, params.intent)) return;

  const reasonLabel =
    params.reason === "no_assets"
      ? "no hay ningún material activo configurado para este intent"
      : "el envío por Kapso falló";

  const notified = await sendTelegramNotification(
    buildTelegramBody({
      headline: `⚠️ <b>Material NO enviado — Conecta Pro</b>\n🏷️ Intent: ${params.intent}`,
      phone: params.phone,
      note: `El sistema no pudo enviar "${params.intent}" a este cliente automáticamente (${reasonLabel}). Envíalo a mano desde Kapso lo antes posible.`,
    }),
  );

  if (notified) {
    await saveOutboundMessage({
      conversationId: params.conversationId,
      phone: params.phone,
      content: `[TELEGRAM_MEDIA_FAILURE_SENT:${params.intent}] alerta de fallo de envío enviada a Telegram`,
      rawPayload: { type: "telegram_notification", event: "media_failure", intent: params.intent, reason: params.reason },
    });
  }
}

// Kapso recibe el 200 apenas llega el mensaje; todo el trabajo (la espera de 2 minutos
// incluida) corre por detrás con `after`. Antes el webhook quedaba abierto hasta terminar
// de responder: con la espera nueva, Kapso habría cortado por timeout y reintentado.
export async function POST(request: Request) {
  // Escalación de leads sin atender, colgada del tráfico del webhook (el cron de Supabase
  // nunca corrió). Se ejecuta DESPUÉS de responder y como máximo una vez cada 10 minutos
  // entre todos los procesos (ver lib/unattended-leads.ts); nunca bloquea al cliente.
  after(async () => {
    try {
      await runUnattendedLeadChecks(getSupabaseClient());
    } catch (error) {
      console.error("unattended lead checks failed", error);
    }

    // Alertas 💰 que esperaban los datos del cliente y ya cumplieron los 20 minutos (ver
    // lib/payment-alerts.ts). Mismo mecanismo: colgado del tráfico, una vez cada 5 minutos.
    try {
      await runPendingPaymentAlertSweep(getSupabaseClient());
    } catch (error) {
      console.error("pending payment alerts sweep failed", error);
    }
  });

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

  // El cuerpo ya está leído: lo único que se necesitaba de `request` era la cabecera de lote.
  const batchHeader = request.headers.get("x-webhook-batch") === "true";

  after(async () => {
    try {
      await processWebhookEvent(payload, batchHeader);
    } catch (error) {
      console.error("webhook processing failed", error);

      await logSystemEvent({
        level: "critical",
        eventType: "webhook_processing_threw",
        errorMessage: getErrorMessage(error),
      });
    }
  });

  return new Response("ok", { status: 200 });
}

// El procesamiento real. Devuelve una Response solo por herencia del handler anterior: nadie
// la lee, el cliente de Kapso ya recibió su 200.
async function processWebhookEvent(
  payload: Record<string, any>,
  batchHeader: boolean,
): Promise<Response> {
  const events = getWebhookEvents(payload, batchHeader);
  const incomingMessages = await normalizeIncomingMessages(payload, batchHeader);

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
    // Antes de guardar: el texto transcrito es lo que queda en el historial y lo que lee
    // el modelo (y el asesor en las alertas).
    await transcribeIncomingAudio(message);

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

  // Si este cliente tiene una alerta 💰 esperando sus datos (nombre, celular, motivo), lo que
  // acaba de escribir puede completarla. Va ANTES de la espera de 2 minutos —el equipo no
  // tiene por qué enterarse tarde de un pago— y corre aunque el bot esté apagado acá.
  if (newMessages.length > 0 && lastMessage.conversationId) {
    try {
      await processPendingPaymentAlerts(getSupabaseClient(), {
        conversationId: lastMessage.conversationId,
      });
    } catch (error) {
      console.error("pending payment alert check failed", error);
    }
  }

  if (newMessages.length === 0) {
    console.log("all inbound messages were duplicates, no reply sent");
    return new Response("duplicate ignored", { status: 200 });
  }

  // COMPROBANTE EN RÁFAGA. El cliente suele mandar la foto del comprobante junto con un
  // texto ("Listo", "Gracias", "Es mañana a las 4pm no") y Kapso los entrega en el mismo
  // webhook. Antes solo se revisaba el ÚLTIMO mensaje, que era el texto: la imagen nunca se
  // verificaba ni se alertaba (4 comprobantes de curso perdidos así en septiembre 2026).
  // El comprobante candidato es la imagen/PDF más reciente del lote, esté donde esté.
  const receiptMedia =
    [...newMessages].reverse().find((message) => message.isImage || message.isDocument) ?? null;
  // Todo lo que el cliente escribió en este lote, para las frases de pago y los detectores.
  const batchText = newMessages.map((message) => message.text).join("\n");

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

    // Aunque el bot esté apagado (humano tomó el chat), la captura del lead debe
    // seguir funcionando: si ya se pidió el formulario y aún no se notificó el lead,
    // detectamos si el cliente envió sus datos y notificamos a Telegram — SIN responder
    // por WhatsApp. Gate para no gastar llamadas de OpenAI en cada mensaje pausado.
    let leadNotifiedWhilePaused = false;
    // Elevado fuera del try de leads para reutilizarlo también en la detección de
    // pago pausada (evita una segunda query idéntica).
    let intakeFormSentPaused = false;
    try {
      const [intakeFormSentPausedResult, telegramLeadSentPaused, officeVisitRequestedPaused] =
        await Promise.all([
          hasIntakeFormBeenSent(lastMessage.conversationId),
          hasTelegramLeadBeenSent(lastMessage.conversationId),
          hasOfficeVisitBeenRequested(lastMessage.conversationId),
        ]);
      intakeFormSentPaused = intakeFormSentPausedResult;

      // El pedido de llamada es 100% determinista: dispara el lead aunque nunca se
      // haya pedido el formulario y sin gastar una llamada a OpenAI.
      const callRequestPaused = detectCallRequestHeuristic(lastMessage.text);

      if (!telegramLeadSentPaused && (callRequestPaused || intakeFormSentPaused)) {
        const pausedHistory = await getRecentConversationHistory(
          lastMessage.conversationId,
          12,
        );

        // Respaldo determinista acotado: un teléfono + texto tras haber pedido el
        // formulario es, casi con certeza, el dato real del cliente.
        const heuristicLead =
          intakeFormSentPaused && detectLeadDataHeuristic(lastMessage.text);

        let llmLead = false;
        if (!callRequestPaused && !heuristicLead) {
          const pausedTurn = await generateAssistantTurn({
            history: pausedHistory,
            conversationId: lastMessage.conversationId,
            messageId: lastMessage.messageId,
            phone: lastMessage.from,
          });
          llmLead = pausedTurn.lead_data_submitted;
        }

        if (callRequestPaused || heuristicLead || llmLead) {
          const trigger: LeadTrigger = callRequestPaused
            ? "call_request_heuristic"
            : "intake_form";

          leadNotifiedWhilePaused = await notifyLeadToTelegram({
            history: pausedHistory,
            phone: lastMessage.from,
            contactName: lastMessage.contactName,
            conversationId: lastMessage.conversationId,
            fallbackText: lastMessage.text,
            kind: callRequestPaused ? "call_request" : "intake",
            trigger,
            wantsOfficeVisit: officeVisitRequestedPaused,
          });

          if (leadNotifiedWhilePaused) {
            await markLeadCaptured(
              lastMessage.conversationId,
              lastMessage.from,
            );
          }

          await logSystemEvent({
            level: "info",
            eventType: "lead_notified_while_paused",
            conversationId: lastMessage.conversationId,
            messageId: lastMessage.messageId,
            contactPhone: lastMessage.from,
            metadata: {
              detection: callRequestPaused
                ? "heuristic"
                : heuristicLead
                  ? "heuristic"
                  : "llm",
              trigger,
              call_request: callRequestPaused,
              notified: leadNotifiedWhilePaused,
            },
          });
        }
      }
    } catch (error) {
      console.error("lead capture while paused failed", error);
      await logSystemEvent({
        level: "error",
        eventType: "lead_capture_while_paused_failed",
        conversationId: lastMessage.conversationId,
        messageId: lastMessage.messageId,
        contactPhone: lastMessage.from,
        errorMessage: getErrorMessage(error),
      });
    }

    // Igual que con el lead, el comprobante de pago debe detectarse aunque un
    // humano ya haya tomado el chat — SIN responder por WhatsApp (reactivar al
    // bot mientras la secretaria está conversando generaría respuestas cruzadas).
    // 100% determinista: no llama a generateAssistantTurn, cero costo extra de OpenAI.
    let paymentNotifiedWhilePaused = false;
    try {
      const paymentMessagePaused = receiptMedia ?? lastMessage;
      const telegramPaymentSentPaused = await hasTelegramPaymentBeenSent({
        conversationId: lastMessage.conversationId,
        messageId: paymentMessagePaused.messageId,
      });

      if (!telegramPaymentSentPaused) {
        const [mediaStatusPaused, manualHumanMediaSentPaused] = await Promise.all([
          getMediaSentStatus(lastMessage.from),
          hasManualHumanMediaBeenSent(lastMessage.conversationId),
        ]);
        const normalizedPausedText = normalizeForMatch(batchText);
        const hasExplicitPaymentPhrasePaused =
          EXPLICIT_PAYMENT_PHRASES.test(normalizedPausedText);
        // manualHumanMediaSentPaused cubre el caso en que un humano ya tomó el chat
        // (por eso el bot está pausado) y le mandó el QR a mano — sin esto, el
        // comprobante que llegue después nunca calificaría.
        const hasPaymentContextPaused =
          mediaStatusPaused.payment_qr ||
          intakeFormSentPaused ||
          manualHumanMediaSentPaused;

        // Misma verificación por visión que en la rama normal: una imagen solo
        // cuenta como comprobante si de verdad se ve una transacción.
        const receiptCheckPaused =
          receiptMedia?.isImage && hasPaymentContextPaused
            ? await classifyReceiptImage({
                mediaId: receiptMedia.mediaId,
                mediaUrl: receiptMedia.mediaUrl,
                conversationId: lastMessage.conversationId,
                messageId: receiptMedia.messageId,
                phone: lastMessage.from,
              })
            : null;

        // Misma matriz que en la rama normal: la imagen la decide la visión; el
        // PDF solo cuenta si alguien (bot o humano) ya mandó el QR antes.
        const isPlausibleReceiptPaused =
          (Boolean(receiptMedia?.isImage) &&
            hasPaymentContextPaused &&
            (receiptCheckPaused === null || receiptCheckPaused.isReceipt)) ||
          (Boolean(receiptMedia?.isDocument) &&
            (mediaStatusPaused.payment_qr || manualHumanMediaSentPaused));

        if (isPlausibleReceiptPaused || hasExplicitPaymentPhrasePaused) {
          // Con el chat en atención humana no se le piden datos al cliente (lo atiende una
          // persona): la alerta sale ya, con la etiqueta que se pueda deducir.
          const paymentReasonPaused = resolvePaymentReason({
            courseContext: false,
            courseMaterialSent: mediaStatusPaused.payment_qr || manualHumanMediaSentPaused,
            intakeFormSent: intakeFormSentPaused,
            activeCourses: getActiveCourses(new Date()),
            recentMessages: [{ role: "user", content: batchText }],
          });
          const paymentContextLabelPaused = paymentReasonPaused.kind;

          paymentNotifiedWhilePaused = await notifyPaymentToTelegram({
            phone: lastMessage.from,
            conversationId: lastMessage.conversationId,
            messageId: paymentMessagePaused.messageId,
            clientMessage: batchText,
            reason: paymentReasonPaused,
            contactName: lastMessage.contactName,
            note: "El chat estaba en atención humana: el bot no le pidió datos al cliente.",
            verification:
              receiptCheckPaused?.source === "vision"
                ? receiptCheckPaused.reason
                : undefined,
          });

          await logSystemEvent({
            level: "info",
            eventType: "payment_notified_while_paused",
            conversationId: lastMessage.conversationId,
            messageId: lastMessage.messageId,
            contactPhone: lastMessage.from,
            metadata: {
              detection: !isPlausibleReceiptPaused
                ? "explicit_phrase"
                : receiptCheckPaused?.source === "vision"
                  ? "vision_confirmed"
                  : "media_heuristic",
              vision_reason: receiptCheckPaused?.reason ?? null,
              context_label: paymentContextLabelPaused,
              notified: paymentNotifiedWhilePaused,
            },
          });
        }
      }
    } catch (error) {
      console.error("payment capture while paused failed", error);
      await logSystemEvent({
        level: "error",
        eventType: "payment_capture_while_paused_failed",
        conversationId: lastMessage.conversationId,
        messageId: lastMessage.messageId,
        contactPhone: lastMessage.from,
        errorMessage: getErrorMessage(error),
      });
    }

    await logSystemEvent({
      level: "info",
      eventType: "bot_reply_skipped_paused",
      conversationId: lastMessage.conversationId,
      messageId: lastMessage.messageId,
      contactPhone: lastMessage.from,
      metadata: {
        reason: pauseState.reason ?? null,
        expires_at: pauseState.expiresAt ?? null,
        lead_notified_while_paused: leadNotifiedWhilePaused,
        payment_notified_while_paused: paymentNotifiedWhilePaused,
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

  const [
    history,
    mediaStatus,
    paymentAcknowledged,
    intakeFormSent,
    telegramLeadSent,
    telegramPaymentSent,
    officeVisitAlreadyRequested,
    telegramHandoffSent,
    telegramCustomQuantitySent,
    telegramPackageAddonSent,
    telegramPriorAgreementSent,
    flowState,
    manualHumanMediaSent,
    packagesLastSentAt,
    qrLastSentAt,
    howWeWorkSent,
    openPaymentAlert,
    coursesButtonLastSentAt,
    webActivity,
  ] = await Promise.all([
    getRecentConversationHistory(lastMessage.conversationId, 12),
    getMediaSentStatus(lastMessage.from),
    hasPaymentBeenAcknowledged(lastMessage.conversationId),
    hasIntakeFormBeenSent(lastMessage.conversationId),
    hasTelegramLeadBeenSent(lastMessage.conversationId),
    hasTelegramPaymentBeenSent({
      conversationId: lastMessage.conversationId,
      messageId: (receiptMedia ?? lastMessage).messageId,
    }),
    hasOfficeVisitBeenRequested(lastMessage.conversationId),
    hasTelegramHandoffBeenSent(lastMessage.conversationId),
    hasTelegramCustomQuantityBeenSent(lastMessage.conversationId),
    hasTelegramPackageAddonBeenSent(lastMessage.conversationId),
    hasTelegramPriorAgreementBeenSent(lastMessage.conversationId),
    getConversationFlowState(lastMessage.conversationId),
    hasManualHumanMediaBeenSent(lastMessage.conversationId),
    // Último envío del flyer de paquetes: define si este turno vuelve a mandarlo o
    // responde solo en texto (ventana de 24h, ver sendMediaForIntent).
    getMediaIntentLastSentAt(lastMessage.from, "service_packages"),
    // Último envío del QR: con menos de 1 hora el cliente lo tiene arriba en el chat.
    getMediaIntentLastSentAt(lastMessage.from, "payment_qr"),
    hasHowWeWorkBeenSent(lastMessage.conversationId),
    // Alerta 💰 esperando los datos del cliente (nombre, celular, motivo).
    getOpenPendingPaymentAlert(getSupabaseClient(), lastMessage.conversationId).catch(() => null),
    // Último botón de cursos (deja el marcador [MEDIA_SENT:course_flyer], ver saveLinkButtonSent).
    getMediaIntentLastSentAt(lastMessage.from, "course_flyer"),
    // ¿Ya dejó sus datos en el formulario de /paquetes?
    getWebActivity(lastMessage.conversationId),
  ]);

  // Promo del live (PROMO[monto]/PROMOCION[monto], con tolerancia a typos): primero
  // se revisa el mensaje actual; si no hay match, se busca la mención más reciente
  // dentro de la ventana de historial ya cargada (sin queries adicionales). El monto
  // anunciado en el live es el precio que se le confirma al cliente.
  const turnNow = new Date();

  // Misma decisión que aplicará el backend al enviar el material, calculada acá para
  // que el TEXTO que escribe el modelo sea coherente con lo que realmente sale.
  const packagesResendDecision = shouldResendMedia({
    intent: "service_packages",
    lastSentAt: packagesLastSentAt,
    now: turnNow,
  });
  // Botón de cursos: mismo criterio de un día que el de paquetes (ver MEDIA_RESEND_WINDOW_HOURS).
  const coursesButtonRecent =
    coursesButtonLastSentAt !== null &&
    turnNow.getTime() - coursesButtonLastSentAt.getTime() < LINK_BUTTON_RESEND_HOURS * 3_600_000;
  // Se le mandó el botón del formulario y los datos no llegaron (ni por la web ni por chat).
  const formButtonPending =
    flowState.flowStage === "intake_sent" && !flowState.advisorNotifiedAt && !webActivity.leadAt;
  const qrSentRecently = !shouldResendMedia({
    intent: "payment_qr",
    lastSentAt: qrLastSentAt,
    now: turnNow,
  }).send;
  const minutesSinceQr = qrLastSentAt
    ? Math.max(0, Math.round((turnNow.getTime() - qrLastSentAt.getTime()) / 60_000))
    : null;

  // Desambiguación con las PROMOS TEMPORALES de video (lib/promos.ts): esas también se
  // piden diciendo "promo" + su precio, y sin este filtro un "promo 1000" de la promo de
  // 4 videos se leería como promo del live y dispararía el QR del CURSO por 1.000 Bs.
  // Si el monto coincide con el de una promo de video vigente, no es la promo del live.
  // También se excluyen los montos de promos YA vencidas: "promo 999" sigue llegando
  // después del cierre y no es la promo de ningún live.
  const activePromoAmounts = [
    ...getActivePromoAmounts(turnNow),
    ...getExpiredPromoAmounts(turnNow),
  ];
  const detectLivePromoAmount = (text: string): number | null => {
    const amount = detectPromoAmount(text);
    if (amount === null) return null;
    return activePromoAmounts.includes(amount) ? null : amount;
  };

  let promoAmount = detectLivePromoAmount(lastMessage.text);
  if (promoAmount === null) {
    for (let i = history.length - 1; i >= 0; i--) {
      const candidate = history[i];
      if (candidate.role !== "user") continue;
      const found = detectLivePromoAmount(candidate.content);
      if (found !== null) {
        promoAmount = found;
        break;
      }
    }
  }

  const promoDetected = promoAmount !== null;

  const normalizedLastMessageText = normalizeForMatch(lastMessage.text);
  // Frase de pago en cualquier mensaje del lote ("[foto] + Comprobante + yo pagué").
  const hasExplicitPaymentPhrase = EXPLICIT_PAYMENT_PHRASES.test(normalizeForMatch(batchText));
  const hasVagueSendPhraseOnly =
    VAGUE_SEND_PHRASES.test(normalizedLastMessageText) &&
    !receiptMedia &&
    !hasExplicitPaymentPhrase;

  // Cursos: ¿hay algo que se pueda cobrar con QR ahora? Si el único curso vigente ya empezó
  // o es hoy (el día del curso solo se paga en la puerta), NO.
  const courseSellable = hasSellableCourse(turnNow);
  const courseInProgress = getInProgressCourses(turnNow).length > 0;
  const courseDayDoorReply = renderCourseDayDoorReply(turnNow);
  // Curso que empieza en minutos y ya no se cobra con QR. Existe solo dentro de la
  // ventana del corte (10 min antes del inicio): es el que el equipo todavía puede
  // rescatar a mano, así que es el que se nombra en el aviso de Telegram.
  const [doorSaleCourse] = getDoorSaleCourses(turnNow);

  // Cliente que viene por el video de la promo de edición a 50 Bs (ya vencida).
  const mentionsEditPromo50 = mentionsExpiredEditPromo(lastMessage.text);

  // Cliente que pregunta por la promo Exprés de 4 videos (999/1.000 Bs), ya finalizada.
  const mentionsExpressPromo =
    !mentionsEditPromo50 && mentionsExpiredVideoPromo(lastMessage.text, turnNow);

  // Enlace suelto: solo importa cuando NO hay nada más que explique el mensaje. Con
  // adjunto gana el flujo del comprobante; con la promo del live el link es la
  // acreditación de la transmisión; con la promo de 50 Bs gana esa explicación.
  const hasBareIncomingLink =
    containsIncomingLink(lastMessage.text) &&
    !receiptMedia &&
    !promoDetected &&
    !mentionsEditPromo50 &&
    !mentionsExpressPromo &&
    !hasExplicitPaymentPhrase;

  // Línea abierta de la conversación. Se calcula ANTES de generar el turno porque lo
  // necesitan la elegibilidad del comprobante, la red determinista del QR y la guarda
  // del cupo — todas corren antes o alrededor de la respuesta del modelo.
  const packagesPresented = detectPackagesPresented(
    history,
    mediaStatus.service_packages,
  );
  const courseContext = detectCourseContext(
    history,
    mediaStatus.course_flyer,
    packagesPresented,
  );

  // Lo que el cliente escribió desde la última respuesta del bot (puede venir en varios
  // webhooks si escribió en ráfaga).
  const unansweredClientText = getUnansweredClientText(history, batchText);

  // Red determinista del QR. Se calcula ANTES de generar el turno para que el texto del
  // modelo diga lo mismo que va a pasar: que el QR sale ahora, o que ya lo tiene arriba.
  const forcedQrReason = shouldForcePaymentQr({
    text: unansweredClientText,
    history,
    courseContext,
    packagesPresented,
    qrSentRecently,
    courseSellable,
  });

  // ¿Este turno es de CURSOS? La conversación ya está anclada en cursos, o el cliente nombra
  // el curso o la compra de su entrada. Un turno así nunca recibe el formulario de datos de
  // empresa (lo recibieron "quiero comprar mi entrada" y "me interesa curso", sep 2026).
  const courseTurn =
    (courseContext || mentionsCourse(unansweredClientText)) &&
    !hasStrongPackageSignal(unansweredClientText);

  // Estado real (ground truth del backend) de qué ya se envió a este teléfono.
  // Reemplaza la inferencia del LLM sobre el historial de texto.
  const contextParts: string[] = [
    // Fecha/hora actual y catálogo de cursos vigentes: única fuente de verdad, el
    // prompt estático ya no trae fechas ni precios fijos de cursos (ver lib/courses.ts).
    renderCourseContext(turnNow),
    // Promociones temporales vigentes: misma idea que los cursos — el prompt estático no
    // nombra ninguna promo, así que cuando su ventana pasa el modelo se queda sin
    // material para inventarla (ver lib/promos.ts).
    renderPromoContext(turnNow),
    // Campañas de apoyo (descuentos condicionados, como el 50% para los comerciantes de
    // la feria Barrio Lindo afectados por el incendio). Misma ventana de vigencia.
    renderReliefContext(turnNow),
    [
      "Estado real (ground truth del backend) de materiales ya enviados a este usuario:",
      `- course_flyer: ${mediaStatus.course_flyer ? "YA enviado antes" : "NUNCA enviado"}`,
      `- service_packages: ${mediaStatus.service_packages ? "YA enviado antes" : "NUNCA enviado"}`,
      `- service_packages_promo: ${mediaStatus.service_packages_promo ? "YA enviado antes" : "NUNCA enviado"}`,
      `- ai_agent_flyer: ${mediaStatus.ai_agent_flyer ? "YA enviado antes" : "NUNCA enviado"}`,
      // QR de pago: dentro de la hora no vuelve a salir (salvo que lo pida). Sin este aviso
      // el modelo escribía "te paso el QR 👇" y no llegaba nada.
      qrSentRecently && minutesSinceQr !== null && forcedQrReason === "qr_request"
        ? `- payment_qr: enviado hace ${minutesSinceQr} min, pero el cliente lo está pidiendo de nuevo: el sistema lo REENVÍA en este turno. Marca intents.payment_qr = true.`
        : qrSentRecently && minutesSinceQr !== null
        ? `- payment_qr: YA enviado hace ${minutesSinceQr} min — el cliente lo tiene arriba en el chat y en este turno NO vuelve a salir. Si quiere pagar, dile que el QR está arriba 👆 y pídele el comprobante + nombre completo + celular. NO escribas "te paso el QR" ni "aquí tienes el QR". Solo si pide explícitamente que se lo reenvíes (no le llegó, no lo encuentra) marca explicit_resend_request = true junto con intents.payment_qr = true.`
        : qrLastSentAt
          ? "- payment_qr: se le envió hace más de 1 hora. Si quiere pagar o reservar un curso a la venta, marca intents.payment_qr = true y el QR vuelve a salir."
          : "- payment_qr: NUNCA enviado.",
      "Confía en este estado (no en lo que infieras del historial de mensajes) para saber si algo ya se envió.",
      // course_flyer y service_packages ya no son imágenes: son el BOTÓN a la página de
      // cada línea (ver lib/site-links.ts). Dentro del día no se repite.
      ...(coursesButtonRecent
        ? ["El botón de cursos YA se le envió hace menos de un día: NO repitas el texto del botón ni marques intents.course_flyer. Responde sus dudas del curso en TEXTO corto. Solo si pide el link o la página de nuevo, usa el texto del botón de cursos y marca intents.course_flyer = true."]
        : []),
      ...(mediaStatus.service_packages && !packagesResendDecision.send
        ? ["El botón de paquetes YA se le envió hace menos de un día: NO repitas el texto del botón de paquetes ni marques intents.service_packages por una consulta general. Responde sus dudas en TEXTO corto con los datos de la LÍNEA B. Si elige un paquete o quiere contratar, SÍ responde con el texto del botón del formulario (FLUJO B intención clara). Solo si pide el link o la página de nuevo, usa el texto del botón de paquetes y marca intents.service_packages = true."]
        : []),
      // Con un curso con fecha cargada, la información va en el botón; sin ninguno, solo el
      // texto de que no hay fechas (sin botón, sin QR, sin ubicación).
      hasCourseWithDate(turnNow)
        ? `TEXTO DEL BOTÓN DE CURSOS (cópialo tal cual cuando el FLUJO A lo pida): "${renderCoursesButtonText(turnNow)}"`
        : `⚠️ NO HAY NINGÚN CURSO CON FECHA CARGADA. Ante CUALQUIER pregunta por los cursos (información, fechas, precios, temario, el link o la página, pagar o reservar), responde ÚNICA y EXACTAMENTE con este texto, sin agregar nada: "${renderNoCourseDatesText(turnNow)}" — y NO marques intents.course_flyer, intents.location_video ni intents.payment_qr.`,
      // El hueco del formulario web: sin esto el bot le volvía a pedir los datos por chat.
      ...(webActivity.leadAt
        ? [`Este cliente YA DEJÓ SUS DATOS en el formulario de la página de ${webActivity.leadPage === "oficina" ? "visita a la oficina" : "paquetes"} (${formatNowInBolivia(webActivity.leadAt)}) y el asesor ya los tiene. NUNCA le pidas el formulario ni sus datos otra vez, y NO marques service_intake_requested, lead_data_submitted ni office_visit_requested. Si pregunta por su pedido, dile que un asesor ya tiene sus datos y le hablará pronto. Sus otras dudas respóndelas con normalidad.`]
        : formButtonPending
          ? [
              // Lo que de verdad pasó en la página (marcas de /api/site-visit): no se adivina.
              webActivity.lastVisitAt
                ? `Se le envió el botón para que llene sus datos en la página. La ABRIÓ (${formatNowInBolivia(webActivity.lastVisitAt)}) pero sus datos TODAVÍA NO llegaron: no tocó "Enviar mis datos" o el envío falló. Si dice que ya los envió, dile con amabilidad que aún no nos llegaron y que vuelva a abrir el botón de arriba y toque 'Enviar mis datos' al final del formulario; si prefiere, puede escribirlos aquí. NO marques lead_data_submitted por ese mensaje.`
                : "Se le envió el botón para que llene sus datos en la página, pero todavía NO la abrió y sus datos no llegaron. Si dice que ya los envió, dile con amabilidad que aún no nos llegaron y que toque el botón de arriba para llenarlos; si prefiere, puede escribirlos aquí. NO marques lead_data_submitted por ese mensaje.",
            ]
          : []),
      ...(mediaStatus.service_packages_promo
        ? ["Como service_packages_promo YA fue enviado: la imagen de la promo temporal ya la tiene. No la presentes como novedad ni repitas todo su detalle; continúa la conversación desde ahí, salvo que el usuario la pida explícitamente de nuevo."]
        : []),
      ...(howWeWorkSent
        ? ['El texto "¿Cómo trabajamos con nuestros clientes?" YA se envió en esta conversación: NO lo repitas entero. Si pregunta algo de los paquetes o de cómo trabajamos, responde en pocas líneas con los datos de la LÍNEA B.']
        : []),
      ...(mediaStatus.ai_agent_flyer
        ? ["Como ai_agent_flyer YA fue enviado: no presentes el agente de IA como si fuera la primera vez ni repitas el texto completo del FLUJO C. Continúa la conversación desde donde quedó (juntar sus datos para la llamada del asesor), salvo que el usuario pida el flyer explícitamente de nuevo."]
        : []),
    ].join("\n"),
  ];

  // Páginas /paquetes y /cursos: el link lo pone el sistema con un botón (ver
  // lib/site-links.ts). Sin esta regla el modelo inventaba la URL o prometía "te paso el link".
  if (getSiteBaseUrl()) {
    contextParts.push(
      "PÁGINAS WEB DE CONECTA PRO: hay una página de paquetes (con el detalle de cada uno y el formulario de datos) y una de cursos (temario, fecha y precio). El sistema decide cuándo adjuntar el botón que las abre, igual que con los flyers. NUNCA escribas una URL de esas páginas ni prometas \"te paso el link\". Si el cliente pide el link o la página de los paquetes o de los cursos, responde en UNA línea corta que abajo tiene el botón para abrirla 👇, sin repetir el catálogo.",
    );
  }

  // Promo del live: el cliente llega con la palabra clave y el monto anunciado en la
  // transmisión. Ese monto ES el precio que se le confirma (lo fija quien hace el live,
  // no el catálogo), y el equipo lo valida después contra el comprobante.
  if (promoDetected) {
    contextParts.push(
      `PROMO DEL LIVE: este cliente viene de una transmisión en vivo y escribió la palabra clave de la promo con el monto anunciado: ${promoAmount} Bs. Ese es el precio promocional del CURSO para él. Confírmaselo usando ese número exacto (no des otro precio, no lo redondees, no menciones el precio normal del curso) y envíale el QR de pago marcando intents.payment_qr=true. Salúdalo reconociendo que viene del live, en 2 o 3 líneas como máximo.`,
    );
  }

  // El cliente quiere pagar un curso a la venta: el QR sale en este turno. Antes el modelo
  // a veces preguntaba "¿a qué curso te refieres?" y el QR no salía.
  if (forcedQrReason && !promoDetected) {
    contextParts.push(
      "El cliente QUIERE PAGAR o reservar un curso (o pidió el QR): el sistema le envía el QR de pago en este turno. Marca intents.payment_qr = true, responde afirmando el siguiente paso en 2 o 3 líneas y pídele que, tras pagar, envíe por este chat el comprobante + nombre completo + número de celular. El QR es el mismo para todos los cursos: si hay más de uno a la venta y no dijo cuál, NO lo frenes para preguntar; en la misma respuesta pregúntale a cuál se inscribe. NUNCA le pidas el formulario de datos de empresa.",
    );
  }

  // Comprobante de pago — matriz de decisión:
  //
  //   contexto previo               | IMAGEN             | PDF/DOCUMENTO
  //   -------------------------------|--------------------|---------------------------
  //   QR de pago ya enviado (bot)    | decide la visión   | sí cuenta (lo revisa un humano)
  //   QR enviado a mano por humano   | decide la visión   | sí cuenta (lo revisa un humano)
  //   solo formulario de intake      | decide la visión   | NO cuenta
  //   conversación anclada en cursos | decide la visión   | NO cuenta
  //   ninguno de los anteriores      | decide la visión * | NO cuenta
  //
  // * Antes una imagen sin contexto de pago ni se revisaba, y un comprobante que llegaba así
  //   se perdía. Ahora se revisa, pero ahí solo cuenta si la visión lo confirmó de verdad: si
  //   la verificación falla no se asume nada y se le pregunta al cliente qué es. La captura
  //   de la promo del live no se revisa: acredita la promo, no es un pago.
  //
  // El PDF no puede verificarse (el modelo de chat no acepta PDF), así que su única
  // garantía es que alguien (bot o humano) ya mandó el QR: sin eso, un PDF es
  // material del cliente (brief, cotización, guion), no un pago.
  //
  // manualHumanMediaSent cubre el caso en que un asesor mandó el QR a mano desde
  // Kapso (el envío automático falló o nunca se marcó): sin esto, mediaStatus.payment_qr
  // queda en false para siempre y el comprobante posterior nunca calificaba.
  //
  // Aparte de los archivos: el texto con una frase explícita de pago sí cuenta,
  // y las frases vagas ("ya mandé/pasé/envié") sin archivo no.
  // Se evalúa sobre `receiptMedia` (la imagen/PDF del lote), no sobre el último mensaje:
  // ver COMPROBANTE EN RÁFAGA más arriba.
  const imageHadPaymentContext =
    mediaStatus.payment_qr ||
    intakeFormSent ||
    manualHumanMediaSent ||
    courseContext ||
    hasExplicitPaymentPhrase;
  const imageReceiptEligible =
    Boolean(receiptMedia?.isImage) && (imageHadPaymentContext || !promoDetected);
  const documentReceiptEligible =
    Boolean(receiptMedia?.isDocument) && (mediaStatus.payment_qr || manualHumanMediaSent);

  const receiptCheck =
    imageReceiptEligible && receiptMedia
      ? await classifyReceiptImage({
          mediaId: receiptMedia.mediaId,
          mediaUrl: receiptMedia.mediaUrl,
          conversationId: lastMessage.conversationId,
          messageId: receiptMedia.messageId,
          phone: lastMessage.from,
        })
      : null;

  const rejectedByVision = receiptCheck !== null && !receiptCheck.isReceipt;
  // PDF sin QR previo: no es comprobante, pero tampoco se ignora — suele ser
  // material real del cliente que merece respuesta.
  const documentWithoutQr = Boolean(receiptMedia?.isDocument) && !documentReceiptEligible;
  const receiptRejected = rejectedByVision || documentWithoutQr;

  // Comprobante detectado de forma determinista: imagen elegible confirmada por
  // visión, o PDF con QR previo (del bot o mandado a mano). NO depende del LLM ni de
  // que el bot llegue a responder por WhatsApp — la alerta a Telegram es la única
  // forma en que un humano agenda al cliente, y no puede perderse por un debounce,
  // un mensaje off-topic o un fallo al enviar la respuesta.
  const receiptDetected =
    (imageReceiptEligible &&
      receiptCheck !== null &&
      receiptCheck.isReceipt &&
      (imageHadPaymentContext || receiptCheck.source === "vision")) ||
    documentReceiptEligible;

  // ¿Por qué pagó? Curso (y cuál), paquete o no se sabe — ver lib/payment-alerts.ts. Se
  // calcula del estado real de materiales enviados y de lo que se habló, no del LLM.
  const paymentReason = resolvePaymentReason({
    courseContext,
    courseMaterialSent: mediaStatus.payment_qr || manualHumanMediaSent || promoDetected,
    intakeFormSent,
    activeCourses: getActiveCourses(turnNow),
    recentMessages: history,
  });
  const paymentContextLabel = paymentReason.kind;

  // Respuesta fija al comprobante: pide justo los datos que faltan. Se fuerza después de
  // generar el turno (ver COMPROBANTE RECIBIDO más abajo).
  let receiptReplyTemplate: string | null = null;

  // La alerta 💰 sale ya si no hace falta preguntarle nada al cliente (paquetes, o ya mandó
  // su nombre junto con la foto); si no, queda pendiente hasta que mande sus datos o pasen
  // 20 minutos, y sale UNA vez con todo (lib/payment-alerts.ts). Un segundo comprobante con
  // una alerta todavía pendiente no abre otra.
  if (receiptDetected && !telegramPaymentSent && !openPaymentAlert) {
    const receiptMessageId = (receiptMedia ?? lastMessage).messageId ?? "unknown";
    const paymentConversationId = lastMessage.conversationId ?? firstMessage.conversationId;
    const payer = extractPayerData([unansweredClientText], paymentReason);
    const payerComplete = isPayerDataComplete(paymentReason, payer);
    const paymentNote = promoDetected
      ? `🎥 Promo del live — el cliente indicó ${promoAmount} Bs (verificar contra el comprobante)`
      : undefined;
    const verification = receiptCheck?.source === "vision" ? receiptCheck.reason : undefined;

    if (payerComplete) {
      await notifyPaymentToTelegram({
        phone: lastMessage.from,
        conversationId: paymentConversationId,
        messageId: receiptMessageId,
        clientMessage: batchText,
        reason: paymentReason,
        payer,
        contactName: lastMessage.contactName,
        note: paymentNote,
        verification,
      });
    } else {
      await savePendingPaymentAlert(getSupabaseClient(), {
        phone: lastMessage.from,
        conversationId: paymentConversationId,
        receiptMessageId,
        reason: paymentReason,
        clientMessage: batchText,
        verification,
        note: paymentNote,
      });
    }

    receiptReplyTemplate = renderReceiptReply(paymentReason, payerComplete);

    await logSystemEvent({
      level: "info",
      eventType: payerComplete ? "payment_notified_deterministic" : "payment_alert_pending",
      conversationId: lastMessage.conversationId,
      messageId: lastMessage.messageId,
      contactPhone: lastMessage.from,
      metadata: {
        detection: imageReceiptEligible ? "vision_confirmed" : "document_with_qr",
        context_label: paymentContextLabel,
        tag: payer.tag.kind,
        had_payment_context: imageHadPaymentContext,
      },
    });
  }

  if (receiptReplyTemplate) {
    contextParts.push(
      `El último mensaje del usuario es un COMPROBANTE DE PAGO (ya verificado). Marca payment_confirmation=true y responde EXACTAMENTE con este texto, sin agregar nada: "${receiptReplyTemplate}" No digas que el pago o el cupo ya quedó confirmado — la validación la hace el equipo. NUNCA le pidas el formulario de datos de paquetes.`,
    );
  } else if (receiptMedia && promoDetected && !receiptDetected) {
    // Cliente del live: junto con la palabra clave manda la captura de la
    // transmisión. Preguntarle "¿en qué te ayudo con esa imagen?" es justo lo que
    // no debe pasar — el contexto ya dice de dónde viene y qué está pidiendo.
    const mediaLabel = receiptMedia.isDocument ? "un DOCUMENTO/PDF" : "una IMAGEN";
    contextParts.push(
      `El último mensaje del usuario es ${mediaLabel} y viene de la PROMO DEL LIVE (ver arriba): es la captura de la transmisión con la que acredita la promoción. NO le preguntes qué es esa imagen, para qué te la envía ni en qué puedes ayudarlo con ella, y NO la trates como comprobante de pago (no marques payment_confirmation). Simplemente continúa: confírmale el precio promocional de ${promoAmount} Bs y envíale el QR (intents.payment_qr=true).`,
    );
  } else if (rejectedByVision && imageHadPaymentContext) {
    contextParts.push(
      "El último mensaje del usuario es una IMAGEN que NO es un comprobante de pago (se verificó su contenido). Ignórala por completo: no la menciones, no la describas, no agradezcas ningún comprobante y NO marques payment_confirmation. Continúa la conversación desde donde quedó, como si ese mensaje no hubiera llegado; si no había nada pendiente, responde de forma breve y natural.",
    );
  } else if (receiptMedia?.isImage && !receiptDetected) {
    // Imagen en un chat sin contexto de pago que no es un comprobante (o no se pudo
    // verificar): no se asume nada, se le pregunta qué es.
    contextParts.push(
      "El último mensaje del usuario es una IMAGEN y no es un comprobante de pago. No asumas nada sobre ella: pídele contexto con amabilidad sobre en qué puede ayudarle ese archivo y no marques payment_confirmation.",
    );
  } else if (documentWithoutQr) {
    contextParts.push(
      "El último mensaje del usuario es un DOCUMENTO/PDF y a este cliente NUNCA se le envió el QR de pago, así que NO puede ser un comprobante. NO marques payment_confirmation y NO agradezcas ningún comprobante. Pregúntale con amabilidad para qué te envía ese archivo o en qué te gustaría que te ayude con él.",
    );
  } else if (receiptMedia) {
    // Otro comprobante con la alerta ya enviada o pendiente (ej. el segundo cupo).
    contextParts.push(
      "El último mensaje del usuario es OTRO comprobante de pago (el anterior ya quedó registrado). Agradécelo en una línea sin repetir la plantilla completa. Si todavía faltan sus datos (nombre completo, celular y, si corresponde, el curso o el motivo del pago), pídeselos en esa misma línea. Marca payment_confirmation=true.",
    );
  } else if (hasExplicitPaymentPhrase) {
    contextParts.push(
      'El último mensaje del usuario usa una frase explícita de confirmación de pago ("comprobante", "ya pagué", "realicé el pago" o similar). Puedes marcar payment_confirmation=true si corresponde según el resto de la conversación.',
    );
  } else if (hasVagueSendPhraseOnly) {
    contextParts.push(
      'El último mensaje del usuario dice algo como "ya mandé"/"ya mande"/"ya pasé"/"ya pase"/"ya envié"/"ya envie" pero SIN adjuntar imagen/PDF/documento y SIN una frase explícita de pago ("comprobante", "ya pagué", "realicé el pago", "hice el pago"). Esto NO es un comprobante. NO marques payment_confirmation y NO digas "gracias por el comprobante" ni nada que suene a que ya recibiste o verificaste un archivo. Responde pidiendo con amabilidad que envíe la imagen o el PDF del comprobante, por ejemplo: "Para confirmar tu pago necesito que me envíes la imagen o el PDF de tu comprobante 😊."',
    );
  } else if (hasBareIncomingLink) {
    contextParts.push(
      "El último mensaje del usuario contiene un ENLACE/URL y no hay contexto previo que explique para qué lo envía. NO puedes abrirlo: NO describas, NO resumas ni asumas su contenido, y NO inventes nada sobre él (ni el negocio del cliente, ni el producto, ni de qué habla el video). Agradécele el envío y pídele con amabilidad que te cuente en qué te gustaría que le ayudes con ese enlace, ofreciéndole las líneas de Conecta Pro para orientarlo (cursos, paquetes de producción de contenido o agente de IA). No marques ningún intent de envío de material en este turno. Si el enlace viene junto con una pregunta clara, atiende la pregunta con el flujo que corresponda en vez de pedir contexto.",
    );
  }

  // DATOS DEL PAGO. Hay una alerta 💰 esperando que el cliente mande su nombre, su celular y,
  // si hace falta, el curso o el motivo (lib/payment-alerts.ts). Lo que escriba ahora son
  // esos datos: no es un lead de paquetes, y responderle como a uno (formulario, "un asesor
  // ya tiene tus datos") le pediría de nuevo lo que acaba de mandar.
  const payerDataPhase = openPaymentAlert !== null && !receiptMedia;
  const pendingPayer = openPaymentAlert
    ? extractPayerData(textsSinceReceiptAsk(history, unansweredClientText), openPaymentAlert.reason)
    : null;
  const pendingPayerComplete =
    openPaymentAlert !== null &&
    pendingPayer !== null &&
    isPayerDataComplete(openPaymentAlert.reason, pendingPayer);

  if (payerDataPhase && pendingPayer && openPaymentAlert) {
    contextParts.push(
      pendingPayerComplete
        ? `El cliente acaba de mandar los datos que le pedimos por su comprobante de pago. NO es un lead de paquetes: no marques lead_data_submitted ni service_intake_requested y no le pidas el formulario. Si solo mandó sus datos, responde EXACTAMENTE: "${renderPayerDataReceivedReply(pendingPayer.tag)}". Si además pregunta algo, respóndelo en una línea después de ese texto.`
        : `Estamos esperando los datos del comprobante de pago de este cliente. NO es un lead de paquetes: no marques lead_data_submitted ni service_intake_requested y no le pidas el formulario. Si su mensaje trae parte de esos datos, responde EXACTAMENTE: "${renderMissingPayerDataReply(openPaymentAlert.reason, pendingPayer)}". Si pregunta otra cosa, respóndela y recuérdale en una línea lo que falta.`,
    );
  }

  if (mentionsEditPromo50) {
    contextParts.push(
      "El cliente pregunta por la PROMOCIÓN DE EDICIÓN DE VIDEO POR 50 Bs. Esa promoción YA NO ESTÁ VIGENTE: el video donde se anunció se publicó hace aproximadamente 2 meses. Explícaselo con amabilidad y sin sonar cortante — el cliente vio el video y su pregunta es legítima. NUNCA le confirmes ese precio, no le des un monto alternativo y no le digas que un asesor puede hacerle ese precio. Después de explicarlo, derívalo: si lo que quiere es EDICIÓN NETA (él proporciona los videos crudos), ese servicio lo maneja un editor de ConectaPro al " +
        EDITOR_PHONE +
        `, y el precio, los plazos y la forma de pago los coordina directamente con él. Deja claro que ese servicio es DISTINTO de los paquetes de producción de Conecta Pro (grabación + edición, ${renderPackageSizes()} videos), que sí puedes ofrecerle si le interesa. NO marques intents.service_packages ni envíes el formulario de datos en este turno.`,
    );
  }

  if (mentionsExpressPromo) {
    contextParts.push(renderExpiredVideoPromoContext());
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

  if (officeVisitAlreadyRequested) {
    contextParts.push(
      "Este cliente YA pidió reunirse en la oficina en esta conversación. NO lo invites a venir, NO des horario ni anotes un día u hora: un asesor lo llamará y le indicará la hora. Si viene por servicios y todavía faltan sus datos, guíalo a completarlos; si viene por un curso, NO le pidas datos del negocio: responde sus dudas del curso. Si ya dio lo necesario, recuérdale con amabilidad que el asesor lo contactará.",
    );
  }

  // Audio que no se pudo transcribir: el bot no sabe qué dijo el cliente y no puede
  // inventarlo ni callarse (antes terminaba en silencio por "fuera de tema").
  const lastAudioUnreadable = Boolean(lastMessage.isAudio && lastMessage.audioUnreadable);
  if (lastAudioUnreadable) {
    contextParts.push(
      `El último mensaje del usuario es un AUDIO que no se pudo transcribir: no sabes qué dijo. NO inventes su contenido, NO lo marques off_topic y NO marques ningún intent. Si la conversación deja claro qué está esperando (por ejemplo sus datos o el QR), continúa desde ahí; si no, responde exactamente: "${AUDIO_UNREADABLE_REPLY}"`,
    );
  }

  // Edición ambigua: el cliente dice "edición" sin aclarar si ya tiene los videos o si
  // quiere que se los grabemos. Se pregunta UNA vez; si ya se preguntó o el cliente ya lo
  // aclaró antes, decide el modelo con lo que respondió.
  const editingRequest = detectEditingRequest(lastMessage.text);
  const editingNeedsClarification =
    editingRequest === "ambiguous" &&
    !mentionsEditPromo50 &&
    // "El básico, con edición" ya eligió un paquete: no hay nada que preguntar.
    !hasStrongPackageSignal(lastMessage.text) &&
    !courseContext &&
    // "Quería inscribirme al curso" + "De edición" en dos mensajes pide el curso de CapCut.
    !mentionsCourse(unansweredClientText) &&
    !mediaStatus.ai_agent_flyer &&
    !intakeFormSent &&
    !detectEditingClarifyAsked(history) &&
    !detectEditingClarifiedByClient(history.slice(0, -1));

  if (editingNeedsClarification) {
    contextParts.push(
      `El cliente habla de EDICIÓN sin aclarar si ya tiene sus videos grabados o si necesita que se los grabemos. NO elijas tú: responde EXACTAMENTE con el texto del flujo "CLIENTE DICE 'EDICIÓN' SIN ACLARAR QUÉ NECESITA", sin marcar intents.service_packages, sin formulario y sin el número del editor.`,
    );
  }

  // Anti-saludo: si es el primer contacto (aún no hay respuesta del asistente) pero
  // el mensaje ya trae intención concreta, se le indica al LLM que NO use el saludo
  // genérico y vaya directo al flujo. Ahorra un mensaje de WhatsApp (costo Meta).
  const hasAssistantHistory = history.some((message) => message.role === "assistant");
  const detectedIntent = detectExplicitIntent(lastMessage.text);

  if (!hasAssistantHistory && detectedIntent) {
    const intentDirective: Record<DetectedIntent, string> = {
      service_packages:
        `El cliente YA expresó intención de paquetes de producción en su mensaje (menciona un precio del catálogo (${renderPackagePrices()}), una cantidad de paquete (${renderPackageSizes()}), o palabras como paquetes/grabación/videos/publicidad/marketing/manejo de redes). NO es un saludo puro: marca is_greeting=false y responde con el FLUJO B consulta general (el texto fijo del botón de paquetes; el sistema adjunta el botón) y marca intents.service_packages=true.`,
      course:
        "El cliente YA preguntó por cursos en su mensaje. NO es un saludo puro: marca is_greeting=false, responde con el FLUJO A (cursos) y marca intents.course_flyer=true.",
      office:
        "El cliente YA preguntó por la oficina en su mensaje. NO es un saludo puro: marca is_greeting=false. Si quiere visitarnos o reunirse, usa el flujo \"CLIENTE QUIERE VISITARNOS\" (explicación + formulario); si solo pregunta dónde queda o el horario, usa el flujo \"PREGUNTA SOLO POR LA UBICACIÓN O EL HORARIO DE LA OFICINA\". NUNCA ofrezcas agendar un día y hora.",
      ai_agent:
        "El cliente YA expresó intención sobre el AGENTE DE IA en su mensaje (menciona agente, IA, chatbot, bot, automatizar mensajes o asistente virtual). NO es un saludo puro y NO es el flujo de paquetes de video, aunque haya usado palabras como servicio o edición: marca is_greeting=false, responde con el texto del FLUJO C (agente de IA) y marca intents.ai_agent_flyer=true. NUNCA des un precio: la cotización es personalizada y el flyer muestra el estimado. NUNCA prometas una demo o prueba ni ofrezcas Zoom: un asesor lo llama por WhatsApp con sus datos.",
      editing_ambiguous:
        "El cliente YA habló de EDICIÓN en su mensaje, pero sin aclarar si ya tiene los videos grabados. NO es un saludo puro: marca is_greeting=false y responde EXACTAMENTE con el texto del flujo \"CLIENTE DICE 'EDICIÓN' SIN ACLARAR QUÉ NECESITA\", sin marcar intents y sin el número del editor.",
    };

    contextParts.push(intentDirective[detectedIntent]);
  }

  const extraContext = contextParts.join("\n\n");

  // Ventana de agrupación: se espera a que el cliente termine de escribir. Si sigue
  // escribiendo, este turno se descarta y responde el webhook del mensaje más nuevo, que ya
  // verá todos los mensajes en el historial. La cuenta va desde que el CLIENTE mandó el
  // mensaje, no desde acá: lo que tardó Kapso en entregarlo ya es parte de la espera.
  const waitMs = computeReplyWaitMs({ lastMessageAt: lastMessageCreatedAt, now: new Date() });

  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  const isStale = async (stage: "debounce" | "pre_send"): Promise<boolean> => {
    const newerInbound = await getNewestInboundMessage(
      lastMessage.conversationId,
      lastMessage.messageId,
      lastMessageCreatedAt,
    );

    if (!newerInbound) return false;

    await markReplyLockSuperseded({
      lastMessageId: lastMessage.messageId,
      conversationId: lastMessage.conversationId,
      phone: lastMessage.from,
      stage,
    });

    await logSystemEvent({
      level: "info",
      eventType: "bot_reply_skipped_newer_inbound",
      conversationId: lastMessage.conversationId,
      messageId: lastMessage.messageId,
      contactPhone: lastMessage.from,
      metadata: {
        stage,
        current_kapso_message_id: lastMessage.messageId ?? null,
        current_created_at: lastMessageCreatedAt,
        newer_kapso_message_id: newerInbound.kapso_message_id,
        newer_created_at: newerInbound.created_at,
      },
    });

    return true;
  };

  if (await isStale("debounce")) {
    return new Response("newer inbound message exists, skipping stale reply", {
      status: 200,
    });
  }

  // Dos minutos son tiempo de sobra para que un asesor entre al chat desde WhatsApp Business
  // (eso apaga el bot). Se vuelve a mirar el estado: el de antes de la espera ya venció.
  const pauseStateAfterWait = await getBotPauseState(lastMessage.conversationId);

  if (pauseStateAfterWait.paused && !pauseStateAfterWait.expired) {
    await markReplyLockSent({
      lastMessageId: lastMessage.messageId,
      conversationId: lastMessage.conversationId,
      phone: lastMessage.from,
      responseText: "[SKIPPED:paused] el bot quedó en pausa durante la espera",
    });

    await logSystemEvent({
      level: "info",
      eventType: "bot_reply_skipped_paused_during_wait",
      conversationId: lastMessage.conversationId,
      messageId: lastMessage.messageId,
      contactPhone: lastMessage.from,
      metadata: {
        wait_ms: waitMs,
        reason: pauseStateAfterWait.reason ?? null,
        pause_check_failed: pauseStateAfterWait.failed ?? false,
      },
    });

    return new Response("bot paused during wait, skipping reply", { status: 200 });
  }

  await logSystemEvent({
    level: "info",
    eventType: "assistant_generation_started",
    conversationId: lastMessage.conversationId,
    messageId: lastMessage.messageId,
    contactPhone: lastMessage.from,
  });

  const generationStartedAt = Date.now();

  // Guardia determinista de la máquina de estados: si el formulario ya fue enviado
  // (flow_stage='intake_sent') y el lead aún no llegó al asesor, un mensaje de pura
  // continuación ("ok", "cómo empezamos") NO se manda al LLM — se responde con un
  // recordatorio fijo de los datos que faltan. Elimina la inconsistencia del modelo
  // ante mensajes similares en este punto del flujo.
  const isDeterministicIntakeNudge =
    flowState.flowStage === "intake_sent" &&
    !flowState.advisorNotifiedAt &&
    isIntakeNudge(lastMessage.text);

  // Reclutamiento (busca trabajo, no servicios): el bot no tiene nada que responder. Se
  // resuelve sin llamar al modelo — silencio + aviso al equipo, en la rama de derivación de
  // más abajo. No aplica sobre un comprobante ni sobre la promo del live.
  const recruitmentDetected =
    mentionsRecruitment(batchText) && !receiptMedia && !promoDetected && !hasExplicitPaymentPhrase;

  let turn: AssistantTurn;

  if (recruitmentDetected) {
    turn = {
      ...FALLBACK_ASSISTANT_TURN,
      reply: "",
      should_reply: false,
      advisor_handoff: true,
      advisor_handoff_reason: "recruitment",
      conversation_summary: "Busca trabajo con Conecta Pro (reclutamiento); el bot no respondió.",
    };
  } else if (isDeterministicIntakeNudge) {
    turn = {
      ...FALLBACK_ASSISTANT_TURN,
      reply: INTAKE_REMINDER,
      should_reply: true,
      is_greeting: false,
      conversation_summary: "",
    };

    await logSystemEvent({
      level: "info",
      eventType: "deterministic_intake_nudge",
      conversationId: lastMessage.conversationId,
      messageId: lastMessage.messageId,
      contactPhone: lastMessage.from,
      metadata: { client_message: lastMessage.text.slice(0, 200) },
    });
  } else {
    turn = await generateAssistantTurn({
      history,
      extraContext,
      conversationId: lastMessage.conversationId,
      messageId: lastMessage.messageId,
      phone: lastMessage.from,
    });
  }

  // ── SILENCIO INDEBIDO ───────────────────────────────────────────────────────
  //
  // Dos formas en que el modelo dejaba a un cliente real sin respuesta:
  //   1. off_topic sobre una consulta del negocio: en un mes, 71 de 159 silencios eran
  //      "¿cuánto cobran por publicidad?", "servicios de marketing", "más información"...
  //   2. should_reply=false fuera de la recolección de datos (el silencio solo existe para
  //      no contestar cada fragmento del formulario): "yo pagué, no estoy en el curso" +
  //      "Comprobante" quedó sin respuesta y sin alerta.
  // En ambos casos se le pide al modelo UNA segunda respuesta con la corrección explícita.
  const intakeInProgress =
    intakeFormSent ||
    flowState.flowStage === "intake_sent" ||
    turn.service_intake_requested ||
    replyContainsIntakeForm(turn.reply) ||
    history.some(
      (message) =>
        message.role === "assistant" &&
        normalizeForMatch(message.content).includes("CUANTOS MENSAJES RECIBEN"),
    );

  const offTopicOnBusiness =
    turn.off_topic && !promoDetected && hasBusinessVocabulary(batchText);
  const silencedOutsideIntake =
    !turn.should_reply &&
    !turn.off_topic &&
    !intakeInProgress &&
    !(
      turn.advisor_handoff &&
      (turn.advisor_handoff_reason === "undocumented_info" ||
        turn.advisor_handoff_reason === "recruitment")
    );

  if (offTopicOnBusiness || silencedOutsideIntake) {
    const correction = offTopicOnBusiness
      ? "CORRECCIÓN DEL BACKEND: el último mensaje del cliente SÍ es una consulta sobre Conecta Pro (publicidad, marketing, información, precios, cursos, pagos o similar). off_topic DEBE ser false y should_reply DEBE ser true. Responde con el flujo que corresponda."
      : "CORRECCIÓN DEL BACKEND: el cliente NO está llenando el formulario de datos, así que should_reply DEBE ser true. Responde a lo que escribió con el flujo que corresponda.";

    const retry = await generateAssistantTurn({
      history,
      extraContext: `${extraContext}\n\n${correction}`,
      conversationId: lastMessage.conversationId,
      messageId: lastMessage.messageId,
      phone: lastMessage.from,
    });

    const stillSilent = retry.off_topic || !retry.should_reply;
    // Último recurso: paquetes si habló de publicidad/servicios y todavía no recibió la
    // presentación (repetir el texto largo sería peor que el menú); si no, el menú.
    const fallbackToPackages =
      SERVICE_PACKAGES_KEYWORDS.test(normalizeForMatch(batchText)) &&
      !mentionsCourse(batchText) &&
      !howWeWorkSent;
    turn = stillSilent
      ? {
          ...retry,
          off_topic: false,
          should_reply: true,
          reply: fallbackToPackages ? PACKAGES_BUTTON_TEXT : FALLBACK_ASSISTANT_TURN.reply,
          intents: {
            ...FALLBACK_ASSISTANT_TURN.intents,
            service_packages: fallbackToPackages,
          },
        }
      : retry;

    await logSystemEvent({
      level: "info",
      eventType: offTopicOnBusiness ? "off_topic_overridden_business" : "silence_overridden_outside_intake",
      conversationId: lastMessage.conversationId,
      messageId: lastMessage.messageId,
      contactPhone: lastMessage.from,
      metadata: {
        retry_still_silent: stillSilent,
        client_message: batchText.slice(0, 200),
      },
    });
  }

  // Audio que no se pudo transcribir: nunca silencio, se le pide que lo escriba.
  if (lastAudioUnreadable && (turn.off_topic || !turn.should_reply)) {
    turn.off_topic = false;
    turn.should_reply = true;
    turn.reply = AUDIO_UNREADABLE_REPLY;
    turn.intents = { ...FALLBACK_ASSISTANT_TURN.intents };
  }

  // Pedido de llamada: se acepta tanto la clasificación del LLM como el respaldo
  // determinista, para que un "quiero llamar para confirmar el paquete" nunca se
  // quede sin avisar al asesor aunque el modelo chico no lo clasifique.
  const callRequestHeuristic = detectCallRequestHeuristic(lastMessage.text);
  const callRequested = turn.call_request || callRequestHeuristic;

  // Campaña de apoyo cerrada (feria Barrio Lindo): si el cliente escribe por ese motivo,
  // el turno se resuelve entero con el bot — no hay descuento que tramitar ni asesor al
  // que pasarle el caso. `reliefClosedReply` es el texto exacto del cierre, o null si el
  // mensaje no habla de ninguna campaña cerrada.
  const reliefClosedReply = getReliefClosedReply(lastMessage.text, turnNow);
  const mentionsClosedRelief = reliefClosedReply !== null;

  // VISITA A LA OFICINA. Dos tipos:
  //   - "business": viene por los servicios → formulario de datos del negocio.
  //   - "course":   viene por un curso (lo dice el mensaje, o la conversación es de cursos)
  //                 → sin formulario de negocio; se le preguntan sus dudas del curso y se
  //                 avisa al asesor para que lo llame y le indique la hora.
  // El detector de texto decide solo; el flag del modelo también, salvo en una conversación
  // de cursos, donde "¿dónde es?" suele ser la ubicación del curso y no una reunión.
  // `wantsOfficeVisit` suma lo que ya se había pedido antes: es la nota de la alerta del lead.
  const officeVisitDetectedKind = detectOfficeVisit(batchText);
  const officeVisitDetected = officeVisitDetectedKind !== null;
  const officeVisitKind: "business" | "course" | null =
    officeVisitDetectedKind === "course" || (officeVisitDetected && courseContext)
      ? "course"
      : officeVisitDetected || (turn.office_visit_requested && !courseContext)
        ? "business"
        : null;
  const officeVisitRequested = officeVisitKind !== null;
  turn.office_visit_requested = officeVisitRequested;
  const wantsOfficeVisit = officeVisitAlreadyRequested || officeVisitRequested;

  const explicitPackageIntent = hasExplicitPackageIntent(lastMessage.text);

  // ── EXTRA PEDIDO SOBRE UN PAQUETE (dron y compañía) ─────────────────────────
  //
  // Caso real que originó esto: "El paquete básico me gustaría que 1 video sea con dron".
  // El bot respondió SOLO el formulario (la red de seguridad de abajo detectó "básico" y
  // pisó la respuesta), y al repreguntar el cliente si costaba lo mismo, el modelo se
  // inventó que el dron venía incluido sin costo en ese paquete.
  //
  // La detección es doble a propósito: el flag del modelo MÁS un detector de texto. Un
  // flag solo no es una red de seguridad — el modelo es justamente la capa que falló.
  // Un falso positivo cuesta una alerta de más al asesor; un falso negativo es un precio
  // inventado delante del cliente.
  const packagesAlreadyPresented = detectPackagesPresented(
    history,
    mediaStatus.service_packages,
  );
  const droneRequested = detectDroneRequest(lastMessage.text);
  const chosenPackage = findPackageByName(lastMessage.text);

  // Si el paquete que nombró YA trae dron no hay nada que cotizar: es una buena noticia y
  // el flujo sigue siendo el normal de elección de paquete.
  const addonAlreadyIncluded = chosenPackage?.drone === true;

  // Sin contexto de paquetes abierto, "¿trabajan con dron?" es una consulta general y se
  // responde con el dato del catálogo, sin molestar a nadie. Lo que se atrapa aquí es el
  // dron pedido SOBRE un paquete: el mensaje lo nombra, o los paquetes ya se presentaron
  // y el cliente está eligiendo dentro de esa conversación.
  const packageAddonPending =
    (turn.package_addon_requested || droneRequested) &&
    !addonAlreadyIncluded &&
    (chosenPackage !== null || packagesAlreadyPresented);

  // ¿Es la PRIMERA vez en esta conversación? El aviso del extra se explica una sola vez.
  // Si el cliente acepta repitiendo el pedido ("sí, con dron"), volver a explicárselo y
  // volver a pedirle permiso lo dejaría dando vueltas sin llegar nunca al formulario.
  const packageAddonIsNew = packageAddonPending && !telegramPackageAddonSent;

  if (turn.should_reply && packageAddonPending) {
    turn.advisor_handoff = true;
    turn.advisor_handoff_reason = "package_addon";
    turn.intents.service_packages = true;

    if (droneRequested && !turn.package_addon_detail) {
      turn.package_addon_detail = "dron";
    }

    // Si el modelo ignoró el pedido del extra —el fallo original—, se le antepone el dato
    // correcto a su respuesta. Se ANTEPONE, no se reemplaza: lo que el modelo haya
    // contestado sobre lo demás sigue siendo válido y pisarlo fue justamente el bug.
    const replyMentionsDrone = /\b(DRON|DRONE|DRONES)\b/.test(
      normalizeForMatch(turn.reply),
    );

    if (droneRequested && !replyMentionsDrone && packageAddonIsNew) {
      turn.reply = turn.reply.trim()
        ? `${DRONE_ADDON_NOTICE}\n\n${turn.reply.trim()}`
        : `${DRONE_ADDON_NOTICE}\n\n¿Te paso unos datitos rápidos para que un asesor te contacte con el precio final? 😊`;

      await logSystemEvent({
        level: "info",
        eventType: "drone_notice_prepended_by_safety_net",
        conversationId: lastMessage.conversationId,
        messageId: lastMessage.messageId,
        contactPhone: lastMessage.from,
        metadata: {
          client_message: lastMessage.text.slice(0, 200),
          chosen_package: chosenPackage?.name ?? null,
        },
      });
    }
  }

  // Red de seguridad determinista: si el cliente eligió un paquete pero el LLM NO
  // marcó service_intake_requested, forzamos el envío del formulario. Cubre elección
  // por cantidad ("Si de 6 videos", "el de 18"), por nombre ("me interesa el básico",
  // "el pro") y afirmación tras ver el flyer ("me interesa ese") — casos que el
  // modelo chico a veces no clasifica como intención clara de contratar.
  // Guardas: no interferir con el silencio de intake, no duplicar si el LLM ya lo
  // marcó, y no reenviar si el formulario ya se envió antes en esta conversación.
  // La guarda mira el TEXTO que se va a enviar, no el flag del LLM: el modelo chico
  // a veces marca service_intake_requested=true pero responde otra cosa ("¡excelente
  // elección!"), y en ese caso el cliente se quedaba sin formulario.
  //
  // Y NO se fuerza cuando hay un extra pendiente de cotizar: ahí el bot primero explica
  // lo del extra y pide permiso ("¿te paso unos datitos?"). El formulario sale en el
  // turno siguiente, cuando el cliente acepta. Mandarlo pegado a la noticia de que su
  // extra no está incluido —o peor, EN LUGAR de esa noticia, como pasó— se lee como un
  // atropello y deja la pregunta del cliente sin responder.
  if (
    turn.should_reply &&
    !replyContainsIntakeForm(turn.reply) &&
    !intakeFormSent &&
    !packageAddonIsNew &&
    // Quien quiere visitarnos recibe su propia versión del formulario (ver más abajo).
    !officeVisitRequested &&
    // Un turno de cursos nunca: "quiero comprar mi entrada", "me interesa curso" o un "sí"
    // a la oferta del QR recibían el formulario de datos de empresa.
    !courseTurn &&
    !forcedQrReason &&
    shouldForceIntakeForm(lastMessage.text, history, mediaStatus.service_packages)
  ) {
    console.log("intake form forced by safety net (package choice detected)", {
      conversationId: lastMessage.conversationId,
      messageId: lastMessage.messageId,
    });

    turn.service_intake_requested = true;
    turn.reply = LEAD_INTAKE_FORM;
    turn.intents.service_packages = true;

    await logSystemEvent({
      level: "info",
      eventType: "intake_form_forced_by_safety_net",
      conversationId: lastMessage.conversationId,
      messageId: lastMessage.messageId,
      contactPhone: lastMessage.from,
      metadata: {
        client_message: lastMessage.text.slice(0, 200),
      },
    });
  }

  // Red de seguridad determinista: CANTIDAD FUERA DE LOS PAQUETES, dentro del rango
  // negociable. El cliente pidió una cantidad concreta que no está en el catálogo pero que
  // SÍ se puede coordinar (entre el mínimo y el máximo, o por encima del máximo): es un lead
  // y el asesor tiene que enterarse. El aviso a Telegram cuelga de advisor_handoff, así que
  // si el LLM no lo marcó — o lo marcó como "out_of_catalog", que es el caso contrario, el de
  // las cantidades por debajo del mínimo — se corrige aquí. No toca la respuesta al cliente:
  // esa la redacta el LLM siguiendo el CASO 2 del flujo. Marcar service_packages es seguro
  // aunque haya promo vigente: resolvePromoIntents desempata después y envía uno solo.
  const requestedVideoCount = detectRequestedVideoCount(lastMessage.text);
  const requestedQuantityIsNegotiable =
    requestedVideoCount !== null &&
    classifyVideoQuantity(requestedVideoCount) === "negotiable" &&
    // La cantidad de una promo vigente no es una cantidad fuera de catálogo: es la promo.
    !getActivePromoVideoCounts(turnNow).includes(requestedVideoCount);

  if (
    turn.should_reply &&
    requestedQuantityIsNegotiable &&
    (turn.intents.service_packages || explicitPackageIntent) &&
    (turn.advisor_handoff_reason === null ||
      turn.advisor_handoff_reason === "out_of_catalog")
  ) {
    turn.advisor_handoff = true;
    turn.advisor_handoff_reason = "custom_quantity";
    turn.intents.service_packages = true;

    await logSystemEvent({
      level: "info",
      eventType: "custom_quantity_handoff_forced",
      conversationId: lastMessage.conversationId,
      messageId: lastMessage.messageId,
      contactPhone: lastMessage.from,
      metadata: {
        requested_videos: requestedVideoCount,
        min_package_videos: MIN_PACKAGE_VIDEOS,
        max_package_videos: MAX_PACKAGE_VIDEOS,
        client_message: lastMessage.text.slice(0, 200),
      },
    });
  }

  // Red de seguridad de la PROMO DEL LIVE: el cliente ya dio la palabra clave con el
  // monto, así que el QR del curso debe salir sí o sí. El dedup de material evita que
  // se reenvíe si ya lo recibió antes.
  if (turn.should_reply && promoDetected && courseSellable && !turn.intents.payment_qr) {
    turn.intents.payment_qr = true;
    turn.intents.service_packages = false;
    turn.intents.service_packages_promo = false;

    console.log("payment_qr forced by safety net (live promo detected)", {
      conversationId: lastMessage.conversationId,
      messageId: lastMessage.messageId,
      promoAmount,
    });

    await logSystemEvent({
      level: "info",
      eventType: "payment_qr_forced_by_promo",
      conversationId: lastMessage.conversationId,
      messageId: lastMessage.messageId,
      contactPhone: lastMessage.from,
      metadata: {
        promo_amount: promoAmount,
        client_message: lastMessage.text.slice(0, 200),
      },
    });
  }

  // Red de seguridad determinista del QR de cursos (forcedQrReason, calculada antes de
  // generar el turno): el cliente pidió el QR, quiere pagar o reservar ("quiero pagar mi
  // entrada"), o dijo "sí" a una oferta de pago del propio bot — casos en que el LLM no
  // siempre marca el intent. Un pedido explícito del QR lo reenvía aunque lo haya recibido
  // hace un rato (forceQrResend); lo demás respeta la ventana de 1 hora.
  let forceQrResend = false;

  // ¿El QR sale de verdad en este turno? Dentro de la hora solo sale si se reenvía a pedido.
  // Las respuestas fijas que lo anuncian dependen de esto para no prometer en falso.
  const qrGoesOutThisTurn = () =>
    turn.intents.payment_qr &&
    courseSellable &&
    (!qrSentRecently || forceQrResend || turn.explicit_resend_request);

  if (turn.should_reply && forcedQrReason) {
    const markedByModel = turn.intents.payment_qr;

    turn.intents.payment_qr = true;
    turn.intents.service_packages = false;
    turn.intents.service_packages_promo = false;
    forceQrResend = forcedQrReason === "qr_request";

    if (!markedByModel || forceQrResend) {
      console.log("payment_qr forced by safety net", {
        conversationId: lastMessage.conversationId,
        messageId: lastMessage.messageId,
        reason: forcedQrReason,
      });

      await logSystemEvent({
        level: "info",
        eventType: "payment_qr_forced_by_safety_net",
        conversationId: lastMessage.conversationId,
        messageId: lastMessage.messageId,
        contactPhone: lastMessage.from,
        metadata: {
          reason: forcedQrReason,
          marked_by_model: markedByModel,
          qr_sent_recently: qrSentRecently,
          client_message: unansweredClientText.slice(0, 200),
        },
      });
    }
  }

  // PREVENTA CERRADA: quiso pagar y el QR ya no sale. Se avisa al equipo aunque el LLM
  // haya obedecido y NO haya marcado payment_qr — por eso mira también lo que el cliente
  // escribió: el aviso tiene que salir por el pedido del cliente, no por lo que el modelo
  // decidió hacer con él. Son minutos para pasarle el QR a mano o cobrarle en la puerta.
  if (
    turn.should_reply &&
    doorSaleCourse &&
    !turn.payment_confirmation &&
    (turn.intents.payment_qr || detectCoursePaymentRequest(unansweredClientText) !== null)
  ) {
    await notifyPresaleClosedQrToTelegram({
      phone: lastMessage.from,
      conversationId: lastMessage.conversationId,
      clientMessage: lastMessage.text,
      summary: turn.conversation_summary,
      courseName: doorSaleCourse.name,
      startsAtLabel: formatCourseDate(doorSaleCourse.startsAt),
      pricePresencial: doorSaleCourse.pricePresencial,
    });

    await logSystemEvent({
      level: "info",
      eventType: "presale_closed_payment_attempt",
      conversationId: lastMessage.conversationId,
      messageId: lastMessage.messageId,
      contactPhone: lastMessage.from,
      metadata: {
        course: doorSaleCourse.id,
        llm_marked_qr: turn.intents.payment_qr,
        client_message: lastMessage.text.slice(0, 200),
      },
    });
  }

  // CURSO EN MARCHA O PREVENTA CERRADA: ya no hay QR. Si lo único vigente es un curso que
  // ya empezó o al que le faltan menos de 10 minutos, el QR no sale aunque el modelo o una
  // red lo hayan marcado. Una respuesta que ofrece el cupo se reemplaza por la que informa
  // que el curso se está dictando, o, si todavía no empezó, por la que invita a pagar en
  // la puerta.
  if (!courseSellable && turn.intents.payment_qr) {
    turn.intents.payment_qr = false;

    const offersSale =
      /\b(QR|PREVENTA|RESERVA\w*|INSCRIBI\w*|CUPO)\b/.test(normalizeForMatch(turn.reply)) &&
      !turn.payment_confirmation;
    if (courseInProgress && offersSale) turn.reply = COURSE_IN_PROGRESS_NO_SALE_REPLY;
    else if (courseDayDoorReply && offersSale) turn.reply = courseDayDoorReply;

    await logSystemEvent({
      level: "info",
      eventType: "payment_qr_blocked_course_not_sellable",
      conversationId: lastMessage.conversationId,
      messageId: lastMessage.messageId,
      contactPhone: lastMessage.from,
      metadata: {
        course_in_progress: courseInProgress,
        course_day_door_sale: courseDayDoorReply !== null,
        reply_replaced: (courseInProgress || courseDayDoorReply !== null) && offersSale,
        client_message: lastMessage.text.slice(0, 200),
      },
    });
  }

  // Exclusividad cursos ↔ leads de paquetes: red de seguridad determinista contra el
  // bug real donde el LLM mandó el formulario de leads de paquetes (📌 Nombre, empresa,
  // rubro...) a un cliente que solo había hablado de cursos ("en ese estaba interesado"
  // sobre un curso se leyó como elegir un paquete). Si la conversación está anclada en
  // cursos y nunca se presentaron paquetes, el formulario NUNCA sale, aunque el LLM lo
  // haya marcado — salvo que el cliente pida paquetes de forma explícita en este mensaje.
  // Tampoco para quien quiere visitarnos desde una conversación de cursos: esa visita es
  // de tipo "course" y no lleva el formulario de negocio (ver VISITA A LA OFICINA).
  // courseTurn cubre además el mensaje que nombra el curso o su entrada aunque la
  // conversación venga de paquetes ("me interesa curso" tras ver los flyers de paquetes).
  if (
    courseTurn &&
    !explicitPackageIntent &&
    (turn.service_intake_requested || replyContainsIntakeForm(turn.reply))
  ) {
    const replacedCourseForm = replyContainsIntakeForm(turn.reply);

    console.log("intake form blocked by course flow", {
      conversationId: lastMessage.conversationId,
      messageId: lastMessage.messageId,
    });

    turn.service_intake_requested = false;
    turn.intents.service_packages = false;
    turn.intents.service_packages_promo = false;

    // Si el formulario ya venía dentro de la respuesta, se reemplaza — nunca se le queda al
    // cliente pidiendo datos de empresa por un curso. Si en este turno sale el QR, el
    // reemplazo es el paso del pago; si no, una pregunta abierta.
    if (replacedCourseForm) {
      turn.reply = !(turn.intents.payment_qr && courseSellable)
        ? COURSE_FORM_BLOCKED_REPLY
        : qrGoesOutThisTurn()
          ? RESERVATION_REQUIRES_PAYMENT_REPLY
          : RESERVATION_QR_ABOVE_REPLY;
    }

    await logSystemEvent({
      level: "info",
      eventType: "intake_form_blocked_by_course_flow",
      conversationId: lastMessage.conversationId,
      messageId: lastMessage.messageId,
      contactPhone: lastMessage.from,
      metadata: {
        reply_replaced: replacedCourseForm,
        client_message: lastMessage.text.slice(0, 200),
      },
    });
  }

  // Red de seguridad determinista contra el bug real: el bot preguntó "¿te reservo
  // el cupo mientras?", el cliente dijo "sí", y el LLM respondió que el cupo quedó
  // reservado — falso, el cupo se reserva única y exclusivamente con el pago. Si la
  // respuesta afirma o ES la que ofrece reservar sin que haya un comprobante en
  // registro, se reemplaza por el texto que reconduce al pago y se fuerza el QR.
  const receiptOnRecord = receiptDetected || hasExplicitPaymentPhrase || telegramPaymentSent;

  if (turn.should_reply && !receiptOnRecord && replyClaimsReservedSpot(turn.reply)) {
    console.log("reserved spot claim blocked (no receipt on record)", {
      conversationId: lastMessage.conversationId,
      messageId: lastMessage.messageId,
    });

    // Con el curso ya en marcha no hay cupo que cobrar: se informa, no se vende. El día del
    // curso, antes de empezar, el cupo se paga en la puerta.
    turn.intents.payment_qr = courseSellable;
    turn.intents.service_packages = false;
    turn.intents.service_packages_promo = false;
    turn.reply = courseSellable
      ? qrGoesOutThisTurn()
        ? RESERVATION_REQUIRES_PAYMENT_REPLY
        : RESERVATION_QR_ABOVE_REPLY
      : courseInProgress || !courseDayDoorReply
        ? COURSE_IN_PROGRESS_NO_SALE_REPLY
        : courseDayDoorReply;

    await logSystemEvent({
      level: "info",
      eventType: "reserved_spot_claim_blocked",
      conversationId: lastMessage.conversationId,
      messageId: lastMessage.messageId,
      contactPhone: lastMessage.from,
      metadata: {
        client_message: lastMessage.text.slice(0, 200),
      },
    });
  }

  // ── VISITA A LA OFICINA ──────────────────────────────────────────────────────
  //
  // Nadie viene a la oficina sin coordinar: no sabemos si habrá alguien para atender.
  // Antes el bot anotaba día y hora ("Anoto tu visita… escribe 'confirmar'") y hasta llegó
  // a prometer "un asesor te estará esperando" (caso kbyJ, a una hora en que la oficina ya
  // cerraba). Ahora quien quiere visitarnos recibe la explicación de que primero llama un
  // asesor y le indica la hora. Si viene por los servicios, se le pide el formulario de
  // datos (el de la LÍNEA C si viene por el agente de IA); si viene por un curso, solo se le
  // preguntan sus dudas del curso y se avisa al asesor (courseOfficeVisitToNotify).
  // También se corrige cualquier respuesta que invite a pasar o dé una reunión por hecha.
  const replyInvitesVisit = turn.should_reply && replyConfirmsAppointment(turn.reply);
  let courseOfficeVisitToNotify = false;

  if (
    turn.should_reply &&
    !mentionsClosedRelief &&
    (officeVisitKind === "course" || (!officeVisitRequested && replyInvitesVisit && courseContext))
  ) {
    const replyExplainsCall = /\bUN\s+ASESOR\s+TE\s+LLAMARA\b/.test(normalizeForMatch(turn.reply));
    // Sin el texto fijo no sale el botón "Agendar visita" (ver detectButtonTextKind).
    const replaced =
      replyInvitesVisit ||
      !replyExplainsCall ||
      replyContainsIntakeForm(turn.reply) ||
      detectButtonTextKind(turn.reply) !== "office";

    if (replaced) turn.reply = OFFICE_VISIT_COURSE_REPLY;
    turn.service_intake_requested = false;
    turn.lead_data_submitted = false;
    turn.intents.service_packages = false;
    turn.intents.service_packages_promo = false;
    turn.intents.location_video = false;
    // El asesor ya no se entera en este turno: el botón "Agendar visita" lleva a /oficina, y
    // el aviso llega cuando el cliente envía su nombre y sus dudas (como en los demás casos).
    courseOfficeVisitToNotify = false;

    await logSystemEvent({
      level: "info",
      eventType: "office_visit_course_handled",
      conversationId: lastMessage.conversationId,
      messageId: lastMessage.messageId,
      contactPhone: lastMessage.from,
      metadata: {
        detected_by_text: officeVisitDetected,
        reply_invited_visit: replyInvitesVisit,
        reply_replaced: replaced,
        client_message: batchText.slice(0, 200),
      },
    });
  } else if (
    turn.should_reply &&
    !mentionsClosedRelief &&
    (officeVisitKind === "business" || replyInvitesVisit)
  ) {
    const aiAgentLine = mediaStatus.ai_agent_flyer || turn.intents.ai_agent_flyer;
    const aiFormInHistory = history.some(
      (message) =>
        message.role === "assistant" &&
        normalizeForMatch(message.content).includes("CUANTOS MENSAJES RECIBEN"),
    );
    const formAlreadyRequested = aiAgentLine ? aiFormInHistory : intakeFormSent;
    const normalizedReply = normalizeForMatch(turn.reply);
    const replyExplainsCall = /\bUN\s+ASESOR\s+TE\s+LLAMARA\b/.test(normalizedReply);
    const replyHasForm = aiAgentLine
      ? normalizedReply.includes("CUANTOS MENSAJES RECIBEN")
      : replyContainsIntakeForm(turn.reply);

    let replaced = false;

    if (formAlreadyRequested) {
      if (replyInvitesVisit) {
        turn.reply = OFFICE_VISIT_PENDING_CALL_REPLY;
        replaced = true;
      }
    } else if (replyInvitesVisit || !replyExplainsCall || !replyHasForm) {
      // Si el cliente pidió también la ubicación, se conserva arriba del texto.
      const locationPrefix = turn.reply.includes(MAPS_OFICINA)
        ? `La oficina de Conecta Pro está aquí 📍\n${MAPS_OFICINA}\n\n`
        : "";
      turn.reply = `${locationPrefix}${aiAgentLine ? OFFICE_VISIT_AI_AGENT_REPLY : OFFICE_VISIT_INTAKE_REPLY}`;
      replaced = true;
    }

    if (!formAlreadyRequested && !aiAgentLine) turn.service_intake_requested = true;
    // El video de "cómo llegar" es del lugar de los cursos, nunca de la oficina.
    turn.intents.location_video = false;
    turn.intents.payment_qr = false;

    await logSystemEvent({
      level: "info",
      eventType: "office_visit_handled",
      conversationId: lastMessage.conversationId,
      messageId: lastMessage.messageId,
      contactPhone: lastMessage.from,
      metadata: {
        detected_by_text: officeVisitDetected,
        reply_invited_visit: replyInvitesVisit,
        ai_agent_line: aiAgentLine,
        form_already_requested: formAlreadyRequested,
        reply_replaced: replaced,
        client_message: batchText.slice(0, 200),
      },
    });
  }

  // ── EDICIÓN AMBIGUA ──────────────────────────────────────────────────────────
  // Si el cliente solo dijo "edición" y no se sabe si ya tiene los videos, se pregunta
  // antes de mandar paquetes o el número del editor (ver editingNeedsClarification).
  if (
    turn.should_reply &&
    editingNeedsClarification &&
    !officeVisitRequested &&
    !normalizeForMatch(turn.reply).includes("PAQUETE COMPLETO:")
  ) {
    turn.reply = EDITING_CLARIFY_REPLY;
    turn.is_greeting = false;
    turn.service_intake_requested = false;
    turn.intents.service_packages = false;
    turn.intents.service_packages_promo = false;

    await logSystemEvent({
      level: "info",
      eventType: "editing_clarification_forced",
      conversationId: lastMessage.conversationId,
      messageId: lastMessage.messageId,
      contactPhone: lastMessage.from,
      metadata: { client_message: lastMessage.text.slice(0, 200) },
    });
  }

  // Campaña de apoyo CERRADA (feria Barrio Lindo): quien escribe por el incendio recibe el
  // cierre y nada más. Este turno no genera lead ni alerta — no hay nada que un asesor
  // pueda tramitar, y pedirle sus datos a alguien que acaba de perder su mercadería para
  // después no darle nada sería peor que no responderle. Red determinista sobre el prompt:
  // si el LLM igual mandó el formulario o siguió ofreciendo el 50%, se reemplaza el texto.
  if (turn.should_reply && mentionsClosedRelief) {
    const replacedReply =
      replyContainsIntakeForm(turn.reply) || replyStillOffersRelief(turn.reply);

    const killedLeadFlags =
      turn.service_intake_requested || turn.lead_data_submitted || turn.call_request;

    turn.service_intake_requested = false;
    turn.lead_data_submitted = false;
    turn.call_request = false;
    turn.intents.service_packages = false;
    turn.intents.service_packages_promo = false;

    if (replacedReply) turn.reply = reliefClosedReply;

    if (replacedReply || killedLeadFlags) {
      console.log("relief campaign closed notice enforced", {
        conversationId: lastMessage.conversationId,
        messageId: lastMessage.messageId,
      });

      await logSystemEvent({
        level: "info",
        eventType: "relief_campaign_closed_notice",
        conversationId: lastMessage.conversationId,
        messageId: lastMessage.messageId,
        contactPhone: lastMessage.from,
        metadata: {
          reply_replaced: replacedReply,
          lead_flags_cleared: killedLeadFlags,
          client_message: lastMessage.text.slice(0, 200),
        },
      });
    }
  }

  // Promo Exprés (999/1.000 Bs) finalizada: si el LLM no avisó que terminó, o dejó
  // pasar la imagen de la promo / el formulario de leads, se corrige aquí.
  if (turn.should_reply && mentionsExpressPromo) {
    const acknowledgedExpiry = acknowledgesExpiredVideoPromo(turn.reply);
    const killedLeadFlags = turn.service_intake_requested || turn.lead_data_submitted;

    turn.service_intake_requested = false;
    turn.lead_data_submitted = false;
    turn.intents.service_packages_promo = false;

    if (!acknowledgedExpiry) turn.reply = EXPIRED_VIDEO_PROMO_REPLY;

    if (!acknowledgedExpiry || killedLeadFlags) {
      await logSystemEvent({
        level: "info",
        eventType: "express_promo_expired_notice",
        conversationId: lastMessage.conversationId,
        messageId: lastMessage.messageId,
        contactPhone: lastMessage.from,
        metadata: {
          reply_replaced: !acknowledgedExpiry,
          lead_flags_cleared: killedLeadFlags,
          client_message: lastMessage.text.slice(0, 200),
        },
      });
    }
  }

  // Promo de edición por 50 Bs: el cliente llega por un video que sigue circulando y
  // esperando un precio que ya no existe. Lo que no puede pasar es que se le confirme
  // ese precio o que el turno derive al formulario de paquetes: si el LLM no explicó el
  // vencimiento, se reemplaza el texto por la plantilla.
  if (turn.should_reply && mentionsEditPromo50) {
    const acknowledgedExpiry = EDIT_PROMO_EXPIRY_ACK_REGEX.test(normalizeForMatch(turn.reply));
    const gaveEditorPhone = turn.reply.includes(EDITOR_PHONE);
    const replacedReply = !acknowledgedExpiry || !gaveEditorPhone;

    const killedLeadFlags = turn.service_intake_requested || turn.lead_data_submitted;

    turn.service_intake_requested = false;
    turn.lead_data_submitted = false;
    turn.intents.service_packages = false;
    turn.intents.service_packages_promo = false;

    if (replacedReply) turn.reply = EDIT_PROMO_50_EXPIRED_REPLY;

    if (replacedReply || killedLeadFlags) {
      console.log("expired edit promo notice enforced", {
        conversationId: lastMessage.conversationId,
        messageId: lastMessage.messageId,
      });

      await logSystemEvent({
        level: "info",
        eventType: "edit_promo_50_expired_notice",
        conversationId: lastMessage.conversationId,
        messageId: lastMessage.messageId,
        contactPhone: lastMessage.from,
        metadata: {
          reply_replaced: replacedReply,
          acknowledged_expiry: acknowledgedExpiry,
          gave_editor_phone: gaveEditorPhone,
          lead_flags_cleared: killedLeadFlags,
          client_message: lastMessage.text.slice(0, 200),
        },
      });
    }
  }

  // CIERRE SECO: un "ya, gracias" no se responde. Antes el LLM lo leía como saludo y
  // devolvía la bienvenida entera a alguien que se estaba despidiendo (9 veces en 3 semanas,
  // sep 2026), y después se le contestaba "¡De nada!": un mensaje pagado que no hacía falta.
  // Ahora es silencio, sea cual sea lo que el modelo quiso responder.
  if (turn.should_reply && isClosingThanksOnly(unansweredClientText)) {
    console.log("closing thanks silenced", {
      conversationId: lastMessage.conversationId,
      messageId: lastMessage.messageId,
    });

    turn.is_greeting = false;
    turn.should_reply = false;
    turn.reply = "";
    turn.intents = { ...FALLBACK_ASSISTANT_TURN.intents };
    turn.service_intake_requested = false;

    await logSystemEvent({
      level: "info",
      eventType: "greeting_suppressed_closing_thanks",
      conversationId: lastMessage.conversationId,
      messageId: lastMessage.messageId,
      contactPhone: lastMessage.from,
      metadata: {
        client_message: lastMessage.text.slice(0, 200),
      },
    });
  }

  // Red de seguridad anti-saludo: si pese a la directiva el LLM devolvió el saludo
  // genérico (is_greeting=true) en el primer contacto pero el mensaje trae intención
  // de paquetes por precio/keywords, forzamos el Flujo B (info + flyer) en vez del
  // saludo. No pisa el caso de elección explícita de paquete (ya cubierto arriba, que
  // marca service_intake_requested). Solo aplica al caso de alta confianza (paquetes).
  if (
    turn.should_reply &&
    turn.is_greeting &&
    !turn.service_intake_requested &&
    !hasAssistantHistory &&
    detectedIntent === "service_packages"
  ) {
    console.log("generic greeting suppressed by safety net (package intent detected)", {
      conversationId: lastMessage.conversationId,
      messageId: lastMessage.messageId,
    });

    turn.is_greeting = false;
    turn.reply = PACKAGES_BUTTON_TEXT;
    turn.intents.service_packages = true;

    await logSystemEvent({
      level: "info",
      eventType: "greeting_suppressed_by_safety_net",
      conversationId: lastMessage.conversationId,
      messageId: lastMessage.messageId,
      contactPhone: lastMessage.from,
      metadata: {
        client_message: lastMessage.text.slice(0, 200),
      },
    });
  }

  // Misma red de seguridad para la LÍNEA C: el video promocional del agente de IA trae
  // clientes cuyo primer mensaje ya menciona agente/IA/chatbot. Si el LLM igual devolvió
  // el saludo genérico, forzamos el Flujo C (info + flyer) para no gastar un mensaje de
  // Meta en un saludo que el cliente no necesita.
  if (
    turn.should_reply &&
    turn.is_greeting &&
    !hasAssistantHistory &&
    detectedIntent === "ai_agent"
  ) {
    console.log("generic greeting suppressed by safety net (ai agent intent detected)", {
      conversationId: lastMessage.conversationId,
      messageId: lastMessage.messageId,
    });

    turn.is_greeting = false;
    turn.reply = AI_AGENT_INFO;
    turn.intents.ai_agent_flyer = true;

    await logSystemEvent({
      level: "info",
      eventType: "greeting_suppressed_by_safety_net_ai_agent",
      conversationId: lastMessage.conversationId,
      messageId: lastMessage.messageId,
      contactPhone: lastMessage.from,
      metadata: {
        client_message: lastMessage.text.slice(0, 200),
      },
    });
  }

  // COMPROBANTE RECIBIDO. La respuesta es la plantilla que pide justo los datos que faltan
  // (lib/payment-alerts.ts), sin depender del modelo: si la cambia o pide datos de más, el
  // pago queda sin etiquetar y la alerta sale incompleta. Después de pagar tampoco va el QR.
  if (receiptReplyTemplate) {
    turn.should_reply = true;
    turn.off_topic = false;
    turn.is_greeting = false;
    turn.reply = receiptReplyTemplate;
    turn.payment_confirmation = true;
    turn.service_intake_requested = false;
    turn.lead_data_submitted = false;
    turn.intents.payment_qr = false;
    turn.intents.service_packages = false;
    turn.intents.service_packages_promo = false;
    turn.intents.ai_agent_flyer = false;
  }

  // DATOS DEL PAGO. Si el cliente mandó (parte de) los datos que se le pidieron por su
  // comprobante, la respuesta es fija: el acuse, o lo que todavía falta. Una pregunta suya
  // ("¿a qué hora es?") la responde el modelo.
  if (payerDataPhase && openPaymentAlert && pendingPayer && !unansweredClientText.includes("?")) {
    const burst = extractPayerData([unansweredClientText], openPaymentAlert.reason);
    const sentData =
      burst.names.length > 0 ||
      burst.phones.length > 0 ||
      (openPaymentAlert.reason.kind === "course_unknown" && burst.tag.kind === "course") ||
      (openPaymentAlert.reason.kind === "unknown" && burst.tag.kind !== "unknown");

    if (sentData) {
      turn.should_reply = true;
      turn.off_topic = false;
      turn.is_greeting = false;
      turn.reply = pendingPayerComplete
        ? renderPayerDataReceivedReply(pendingPayer.tag)
        : renderMissingPayerDataReply(openPaymentAlert.reason, pendingPayer);
      turn.lead_data_submitted = false;
      turn.service_intake_requested = false;
      turn.intents.payment_qr = false;
      turn.intents.service_packages = false;
      turn.intents.service_packages_promo = false;
    }
  }

  // ALUMNO DE CURSO QUE MANDA SU NOMBRE Y CELULAR. Después del comprobante se le piden esos
  // datos para agregarlo al grupo del curso; el modelo los leía como un lead de paquetes
  // ("un asesor ya tiene tus datos" + alerta 🟢 falsa + bot apagado 12 h). Con contexto de
  // pago de curso y sin formulario de paquetes de por medio, no es un lead. Tampoco lo es
  // quien manda los datos de un pago de otro motivo (payerDataPhase).
  //
  // El QR y los flyers se leen de ESTA conversación y con ventana de tiempo. Antes venían de
  // mediaStatus, que consulta por teléfono y sin fecha: un QR de hace tres meses dejaba el
  // contexto de pago encendido para siempre y bloqueaba leads de paquetes legítimos
  // (26 sep 2026). La regla completa y sus pruebas están en lib/payment-context.ts.
  const [paymentQrSentAt, packagesMediaSentAt] = await Promise.all([
    getMediaIntentLastSentAt(lastMessage.from, "payment_qr", lastMessage.conversationId),
    getMediaIntentLastSentAt(lastMessage.from, "service_packages", lastMessage.conversationId),
  ]);

  const coursePaymentContext = isCoursePaymentContext({
    payerDataPhase,
    receiptDetected,
    paymentAcknowledged,
    telegramPaymentSent,
    paymentQrSentAt,
    manualHumanMediaSent,
    explicitPackageIntent,
    packagesMediaSentAt,
    intakeFormSent,
    officeVisitRequested,
    aiAgentFlyerSent: mediaStatus.ai_agent_flyer,
    now: new Date(),
  });

  if (
    coursePaymentContext &&
    (turn.lead_data_submitted || turn.service_intake_requested || replyContainsIntakeForm(turn.reply))
  ) {
    const normalizedReply = normalizeForMatch(turn.reply);
    const replaceReply =
      replyContainsIntakeForm(turn.reply) ||
      (LEAD_CLOSING_ACK_REGEX.test(normalizedReply) && !normalizedReply.includes("COMPROBANTE"));

    turn.lead_data_submitted = false;
    turn.service_intake_requested = false;
    turn.intents.service_packages = false;
    turn.intents.service_packages_promo = false;

    // "Nuestro equipo valida tu pago" solo si hay un pago que validar. Sin comprobante, el
    // cliente todavía tiene que pagar: se le indica el QR (un "sí" a "¿te paso el QR?"
    // recibía "ya tenemos tus datos, validamos tu pago", 18 sep 2026).
    const paymentOnRecord = paymentAcknowledged || telegramPaymentSent || receiptDetected;
    if (replaceReply && payerDataPhase && openPaymentAlert && pendingPayer) {
      turn.reply = pendingPayerComplete
        ? renderPayerDataReceivedReply(pendingPayer.tag)
        : renderMissingPayerDataReply(openPaymentAlert.reason, pendingPayer);
    } else if (replaceReply && paymentOnRecord) {
      turn.reply = COURSE_PAYER_DATA_REPLY;
    } else if (replaceReply && !courseSellable) {
      turn.reply = COURSE_FORM_BLOCKED_REPLY;
    } else if (replaceReply) {
      // El QR sale ahora, salvo que lo haya recibido hace menos de 1 hora (lo tiene arriba).
      turn.intents.payment_qr = true;
      turn.reply = qrGoesOutThisTurn()
        ? RESERVATION_REQUIRES_PAYMENT_REPLY
        : RESERVATION_QR_ABOVE_REPLY;
    }

    await logSystemEvent({
      level: "info",
      eventType: "course_payer_data_not_a_lead",
      conversationId: lastMessage.conversationId,
      messageId: lastMessage.messageId,
      contactPhone: lastMessage.from,
      // Qué señal encendió el contexto: sin esto, un bloqueo indebido solo se ve como
      // "el bot cambió de tema" y hay que reconstruirlo a mano desde los mensajes.
      metadata: {
        reply_replaced: replaceReply,
        client_message: batchText.slice(0, 200),
        payer_data_phase: payerDataPhase,
        receipt_detected: receiptDetected,
        payment_acknowledged: paymentAcknowledged,
        telegram_payment_sent: telegramPaymentSent,
        manual_human_media_sent: manualHumanMediaSent,
        payment_qr_sent_at: paymentQrSentAt?.toISOString() ?? null,
        packages_media_sent_at: packagesMediaSentAt?.toISOString() ?? null,
        explicit_package_intent: explicitPackageIntent,
      },
    });
  }

  // CIERRE DEL LEAD: el acuse SIEMPRE sale antes del silencio.
  //
  // Cuando el cliente termina de dar sus datos, el bot se apaga a continuación (el caso
  // pasa al asesor). Ese apagado solo es aceptable si el cliente recibe primero la
  // confirmación de que sus datos llegaron: si el LLM devolvió silencio, o una respuesta
  // que no confirma nada, se fuerza el acuse aquí.
  if (turn.lead_data_submitted) {
    const acknowledged =
      turn.should_reply && LEAD_CLOSING_ACK_REGEX.test(normalizeForMatch(turn.reply));

    if (!acknowledged) {
      turn.should_reply = true;
      turn.reply = LEAD_CLOSED_REPLY;

      console.log("lead closing acknowledgement forced before pause", {
        conversationId: lastMessage.conversationId,
        messageId: lastMessage.messageId,
      });

      await logSystemEvent({
        level: "info",
        eventType: "lead_closing_ack_forced",
        conversationId: lastMessage.conversationId,
        messageId: lastMessage.messageId,
        contactPhone: lastMessage.from,
        metadata: {
          client_message: lastMessage.text.slice(0, 200),
        },
      });
    }
  }

  // ACUERDO PREVIO — la red de seguridad más dura del sistema, y la última en aplicarse
  // para que gane sobre cualquier otra respuesta ya fijada.
  //
  // Viene de un caso real: un cliente que había cerrado 80 Bs por video con un asesor
  // escribió para coordinar, y el bot le contestó "nuestros paquetes son fijos: 6, 12 o
  // 18 videos". Contradecir al propio equipo delante del cliente costó la venta y la
  // recomendación. Cuando alguien afirma tener algo acordado, el bot no sabe qué se
  // acordó, no puede verificarlo y negarlo es peor que callarse: se limita a devolver el
  // chat a la persona que lo atendió.
  //
  // No aplica sobre un comprobante de pago (ese flujo tiene su propia respuesta y su
  // propio aviso, y ahí el "quedamos en 250" del cliente es el monto que ya pagó).
  const priorAgreementClaimed =
    mentionsPriorAgreement(lastMessage.text) &&
    !receiptDetected &&
    !turn.payment_confirmation;

  if (turn.should_reply && priorAgreementClaimed) {
    const killedFlags =
      turn.service_intake_requested ||
      turn.intents.service_packages ||
      turn.intents.service_packages_promo;

    turn.reply = PRIOR_AGREEMENT_REPLY;
    turn.service_intake_requested = false;
    turn.lead_data_submitted = false;
    turn.intents.service_packages = false;
    turn.intents.service_packages_promo = false;
    turn.intents.course_flyer = false;
    turn.intents.ai_agent_flyer = false;
    turn.advisor_handoff = true;
    turn.advisor_handoff_reason = "prior_agreement";

    console.log("prior agreement claim: reply replaced and bot handed to human", {
      conversationId: lastMessage.conversationId,
      messageId: lastMessage.messageId,
    });

    await logSystemEvent({
      level: "warning",
      eventType: "prior_agreement_claim_handoff",
      conversationId: lastMessage.conversationId,
      messageId: lastMessage.messageId,
      contactPhone: lastMessage.from,
      metadata: {
        lead_or_material_flags_cleared: killedFlags,
        client_message: lastMessage.text.slice(0, 200),
      },
    });
  }

  // Contexto comercial de la conversación: gate de las alertas de lead y de derivación a
  // asesor (los avisos de pago no pasan por aquí, tienen validación propia).
  const commercialMaterialSent =
    mediaStatus.course_flyer ||
    mediaStatus.service_packages ||
    mediaStatus.ai_agent_flyer ||
    mediaStatus.payment_qr ||
    intakeFormSent;

  const conversationIsCommercial = hasCommercialContext({
    history,
    lastMessageText: lastMessage.text,
    materialSent: commercialMaterialSent,
  });

  // Registro de cada alerta bloqueada por falta de contexto comercial, para poder auditar
  // en Supabase si el gate está silenciando algo que sí debía notificarse.
  const logTelegramSkippedNoContext = async (alert: string) =>
    logSystemEvent({
      level: "info",
      eventType: "telegram_skipped_no_commercial_context",
      conversationId: lastMessage.conversationId,
      messageId: lastMessage.messageId,
      contactPhone: lastMessage.from,
      metadata: {
        alert,
        client_message: lastMessage.text.slice(0, 200),
      },
    });

  // Mensaje fuera de tema: el cliente escribió algo sin relación con Conecta Pro (soporte
  // de otro producto, temas internos de un trabajo en curso, charla personal). El bot NO
  // responde y NO notifica nada; además apaga la conversación para que la atienda un
  // humano. Tiene prioridad sobre todo lo demás y hace su propio return.
  // La promo del live nunca es "fuera de tema": el cliente llega con una palabra clave
  // corta y una captura, justo el patrón que el modelo podría confundir con un mensaje
  // ajeno. Si el backend detectó la promo, manda el backend.
  if (turn.off_topic && promoDetected) {
    turn.off_topic = false;
    turn.should_reply = true;

    await logSystemEvent({
      level: "info",
      eventType: "off_topic_overridden_by_promo",
      conversationId: lastMessage.conversationId,
      messageId: lastMessage.messageId,
      contactPhone: lastMessage.from,
      metadata: {
        promo_amount: promoAmount,
        client_message: lastMessage.text.slice(0, 200),
      },
    });
  }

  if (turn.off_topic) {
    // Salvaguarda contra falsos positivos del modelo: si la conversación sí venía siendo
    // comercial (flyer/QR/formulario ya enviados o palabras de algún flujo), se guarda
    // silencio en este turno pero no se apaga el bot.
    if (!conversationIsCommercial) {
      await pauseBotForOffTopic(lastMessage.conversationId);
    }

    console.log("assistant reply silenced (off topic message)", {
      conversationId: lastMessage.conversationId,
      messageId: lastMessage.messageId,
      botPaused: !conversationIsCommercial,
    });

    await markReplyLockSent({
      lastMessageId: lastMessage.messageId,
      conversationId: lastMessage.conversationId,
      phone: lastMessage.from,
      responseText: "[SILENCED] mensaje fuera de tema",
    });

    await logSystemEvent({
      level: "info",
      eventType: "assistant_reply_skipped_off_topic",
      conversationId: lastMessage.conversationId,
      messageId: lastMessage.messageId,
      contactPhone: lastMessage.from,
      metadata: {
        duration_ms: Date.now() - generationStartedAt,
        bot_paused: !conversationIsCommercial,
        pause_minutes: conversationIsCommercial ? null : OFF_TOPIC_PAUSE_MINUTES,
        client_message: lastMessage.text.slice(0, 200),
      },
    });

    return new Response("off topic, no reply sent", { status: 200 });
  }

  // RECLUTAMIENTO: busca trabajo, no servicios. El bot se calla, avisa a una persona del
  // equipo (sin el filtro de contexto comercial: "¿siguen buscando modelos?" no tiene
  // palabras de venta y el aviso igual tiene que llegar) y se apaga en esa conversación.
  if (turn.advisor_handoff && turn.advisor_handoff_reason === "recruitment") {
    if (!telegramHandoffSent) {
      await notifyAdvisorHandoffToTelegram({
        history,
        phone: lastMessage.from,
        contactName: lastMessage.contactName,
        conversationId: lastMessage.conversationId,
        reason: "recruitment",
        lastMessageText: batchText,
        summary: turn.conversation_summary,
      });
    }

    await pauseBotForHumanHandoff({
      conversationId: lastMessage.conversationId,
      phone: lastMessage.from,
      messageId: lastMessage.messageId,
      reason: "advisor_handoff",
    });

    await markReplyLockSent({
      lastMessageId: lastMessage.messageId,
      conversationId: lastMessage.conversationId,
      phone: lastMessage.from,
      responseText: "[SILENCED] reclutamiento derivado a una persona del equipo",
    });

    await logSystemEvent({
      level: "info",
      eventType: "recruitment_handoff_no_reply",
      conversationId: lastMessage.conversationId,
      messageId: lastMessage.messageId,
      contactPhone: lastMessage.from,
      metadata: {
        detected_by_text: recruitmentDetected,
        advisor_notified: !telegramHandoffSent,
        client_message: batchText.slice(0, 200),
      },
    });

    return new Response("recruitment handoff, no reply sent", { status: 200 });
  }

  // Derivación silenciosa a asesor: el cliente preguntó algo que no está en la guía y el
  // modelo prefirió no inventar. El bot NO responde por WhatsApp; se avisa una sola vez
  // al asesor por Telegram (marcador [TELEGRAM_HANDOFF_SENT]) para que un humano atienda.
  // Tiene prioridad sobre el resto del flujo y hace su propio return.
  if (turn.advisor_handoff && turn.advisor_handoff_reason === "undocumented_info") {
    console.log("assistant reply silenced (advisor handoff, undocumented info)", {
      conversationId: lastMessage.conversationId,
      messageId: lastMessage.messageId,
    });

    if (!telegramHandoffSent && conversationIsCommercial) {
      await notifyAdvisorHandoffToTelegram({
        history,
        phone: lastMessage.from,
        contactName: lastMessage.contactName,
        conversationId: lastMessage.conversationId,
        reason: "undocumented_info",
        lastMessageText: lastMessage.text,
        summary: turn.conversation_summary,
      });
    } else if (!telegramHandoffSent) {
      await logTelegramSkippedNoContext("advisor_handoff:undocumented_info");
    }

    await markReplyLockSent({
      lastMessageId: lastMessage.messageId,
      conversationId: lastMessage.conversationId,
      phone: lastMessage.from,
      responseText: "[SILENCED] derivado a asesor (información no documentada)",
    });

    await logSystemEvent({
      level: "info",
      eventType: "assistant_handoff_no_reply",
      conversationId: lastMessage.conversationId,
      messageId: lastMessage.messageId,
      contactPhone: lastMessage.from,
      metadata: {
        duration_ms: Date.now() - generationStartedAt,
        advisor_notified: !telegramHandoffSent && conversationIsCommercial,
      },
    });

    return new Response("advisor handoff, no reply sent", { status: 200 });
  }

  // Silencio durante recolección de datos de lead: el modelo decide que este
  // mensaje del cliente todavía no amerita respuesta (llegó en medio de una
  // ráfaga de datos y no se cumple ninguna condición de cierre). Se libera el
  // lock sin enviar nada a WhatsApp, para no gastar mensajes/tokens en cada
  // fragmento que el cliente escribe por separado.
  if (!turn.should_reply) {
    console.log("assistant reply silenced (lead data accumulation)", {
      conversationId: lastMessage.conversationId,
      messageId: lastMessage.messageId,
    });

    // Aunque el bot guarde silencio, si el modelo detectó que el lead quedó completo
    // en este turno —o si el cliente pidió una llamada—, se notifica igual al asesor
    // (la notificación no debe depender de que se responda por WhatsApp).
    if (
      (turn.lead_data_submitted || callRequested || turn.ai_agent_lead_submitted) &&
      !telegramLeadSent &&
      !mentionsClosedRelief &&
      conversationIsCommercial
    ) {
      const isAiAgentLead =
        turn.ai_agent_lead_submitted && !callRequested && !turn.lead_data_submitted;

      await notifyLeadToTelegram({
        history,
        phone: lastMessage.from,
        contactName: lastMessage.contactName,
        conversationId: lastMessage.conversationId,
        fallbackText: lastMessage.text,
        summary: turn.conversation_summary,
        kind: isAiAgentLead
          ? "ai_agent"
          : callRequested && !turn.lead_data_submitted
            ? "call_request"
            : "intake",
        wantsOfficeVisit,
        trigger: turn.call_request
          ? "call_request_assistant"
          : callRequestHeuristic
            ? "call_request_heuristic"
            : isAiAgentLead
              ? "ai_agent_form"
              : "intake_form",
      });

      await markLeadCaptured(
        lastMessage.conversationId,
        lastMessage.from,
        flowState.flowStage,
      );
    } else if (
      (turn.lead_data_submitted || callRequested || turn.ai_agent_lead_submitted) &&
      !conversationIsCommercial
    ) {
      await logTelegramSkippedNoContext("lead:silenced_branch");
    }

    await markReplyLockSent({
      lastMessageId: lastMessage.messageId,
      conversationId: lastMessage.conversationId,
      phone: lastMessage.from,
      responseText: "[SILENCED] esperando más datos del cliente",
    });

    await logSystemEvent({
      level: "info",
      eventType: "assistant_reply_silenced",
      conversationId: lastMessage.conversationId,
      messageId: lastMessage.messageId,
      contactPhone: lastMessage.from,
      metadata: {
        duration_ms: Date.now() - generationStartedAt,
        lead_notified:
          (turn.lead_data_submitted || callRequested) && !telegramLeadSent,
        call_request: callRequested,
        lead_trigger: turn.call_request
          ? "call_request_assistant"
          : callRequestHeuristic
            ? "call_request_heuristic"
            : "intake_form",
      },
    });

    return new Response("reply silenced, accumulating lead data", { status: 200 });
  }

  // La información general de paquetes ya no se escribe en el chat: va en la página, detrás
  // del botón (ver lib/site-links.ts). Si el modelo (o una red de seguridad) igual escribe el
  // texto largo de "¿Cómo trabajamos...?" o pega el formulario 📌, se cambia por el texto
  // corto del botón. La visita a la oficina conserva su formulario: ahí el asesor llama.
  let replyText = applyExactHowWeWorkText(turn.reply);

  if (normalizeForMatch(replyText).includes(HOW_WE_WORK_MARKER)) {
    replyText = PACKAGES_BUTTON_TEXT;
    turn.intents.service_packages = true;
  } else if (replyContainsIntakeForm(replyText) && !turn.office_visit_requested) {
    replyText = PACKAGES_FORM_BUTTON_TEXT;
    turn.service_intake_requested = true;
    turn.intents.service_packages = true;
  }

  // Sin ningún curso con fecha cargada no hay botón de cursos: la respuesta es solo el texto
  // de que no hay fechas confirmadas, aunque el modelo haya querido mandar el botón o el
  // material del curso. Así el cliente no abre una página que solo dice "por confirmar".
  // También cuando el cliente pregunta por un curso y la respuesta igual le ofrece fecha,
  // cupo, preventa o QR (salvo que esté avisando un pago ya hecho).
  const courseReplyWithoutDates =
    !hasCourseWithDate(turnNow) &&
    !turn.payment_confirmation &&
    (turn.intents.course_flyer ||
      detectButtonTextKind(replyText) === "courses" ||
      (mentionsCourse(batchText) &&
        /\b(QR|PREVENTA|RESERVA\w*|CUPO|CUPOS|FECHA|FECHAS|INSCRIBI\w*)\b/.test(
          normalizeForMatch(replyText),
        ) &&
        !replyText.includes("no tenemos fechas oficiales confirmadas")));

  if (courseReplyWithoutDates) {
    replyText = renderNoCourseDatesText(turnNow);
    turn.intents.course_flyer = false;
    turn.intents.location_video = false;
    turn.intents.payment_qr = false;
  }

  // Ya dejó sus datos en la página: nunca se le vuelve a pedir el formulario.
  if (webActivity.leadAt && detectButtonTextKind(replyText) === "packages_form") {
    replyText = WEB_LEAD_ALREADY_RECEIVED_REPLY;
    turn.service_intake_requested = false;
  }

  // Guardia anti-loop bot-contra-bot: si las últimas 3 respuestas ya enviadas en
  // esta conversación son idénticas a la que se está por enviar ahora, es señal
  // de que el "usuario" del otro lado es en realidad otro asistente automatizado
  // respondiendo en bucle (ej. el número pertenece a otra empresa con su propio
  // bot). Se pausa la conversación en vez de seguir enviando la misma respuesta
  // indefinidamente, y se alerta al equipo para revisión manual.
  // Umbral en 3 (no 2): una respuesta fija como el saludo puede repetirse por
  // coincidencia con un cliente real que escribe mensajes distintos entre sí;
  // un bot-contra-bot real repite decenas de veces, así que 3 sigue detectando
  // el caso real sin pausar conversaciones humanas por una doble coincidencia.
  const trailingAssistantReplies = history
    .filter((message) => message.role === "assistant")
    .slice(-3)
    .map((message) => message.content.trim());

  const isSuspectedBotLoop =
    trailingAssistantReplies.length === 3 &&
    trailingAssistantReplies.every((content) => content === replyText.trim());

  if (isSuspectedBotLoop) {
    console.warn("suspected bot-to-bot loop detected, pausing conversation", {
      conversationId: lastMessage.conversationId,
      phone: maskPhone(lastMessage.from),
    });

    await pauseBotForSuspectedLoop(lastMessage.conversationId);

    await logSystemEvent({
      level: "critical",
      eventType: "bot_loop_suspected_paused",
      conversationId: lastMessage.conversationId,
      messageId: lastMessage.messageId,
      contactPhone: lastMessage.from,
      metadata: {
        repeated_reply_preview: replyText.slice(0, 200),
      },
    });

    return new Response("suspected bot loop, conversation paused", {
      status: 200,
    });
  }

  // Último control antes de enviar: cierra la ventana abierta durante la
  // generación (varios segundos de OpenAI). Si el cliente escribió mientras
  // tanto, esta respuesta ya nació vieja y la manda el turno del mensaje nuevo.
  if (await isStale("pre_send")) {
    return new Response("newer inbound message exists, skipping stale reply", {
      status: 200,
    });
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
  if (turn.intents.service_packages_promo) intentsToSend.add("service_packages_promo");
  if (turn.intents.ai_agent_flyer) intentsToSend.add("ai_agent_flyer");

  // --- Promo temporal de video (LÍNEA B) ---------------------------------------
  // Toda la resolución vive en lib/media-intents.ts, como función pura y probada:
  // vencimiento, exclusión con cursos / agente de IA, y el desempate con el flyer normal
  // de paquetes (sale exactamente uno de los dos). Aquí solo se aplica y se registra.
  const promoResolution = resolvePromoIntents({
    intents: [...intentsToSend],
    message: lastMessage.text,
    now: turnNow,
    courseFlyerMarked: turn.intents.course_flyer,
    aiAgentFlyerMarked: turn.intents.ai_agent_flyer,
  });

  if (promoResolution.reasons.length > 0) {
    intentsToSend.clear();
    for (const intent of promoResolution.intents) {
      intentsToSend.add(intent as MediaIntent);
    }

    console.log("promo intents resolved", {
      conversationId: lastMessage.conversationId,
      messageId: lastMessage.messageId,
      reasons: promoResolution.reasons,
      intents: promoResolution.intents,
    });

    await logSystemEvent({
      level: "info",
      eventType: "promo_intents_resolved",
      conversationId: lastMessage.conversationId,
      messageId: lastMessage.messageId,
      contactPhone: lastMessage.from,
      metadata: {
        reasons: promoResolution.reasons,
        resolved_intents: promoResolution.intents,
        client_message: lastMessage.text.slice(0, 200),
      },
    });
  }

  // Guarda determinista: el QR de pago es exclusivo del curso de Creación de
  // Contenido y nunca debe salir en un turno de paquetes de producción, aunque
  // el LLM haya clasificado mal y marcado ambos intents a la vez.
  if (
    intentsToSend.has("payment_qr") &&
    (turn.intents.service_packages ||
      intentsToSend.has("service_packages_promo") ||
      turn.service_intake_requested)
  ) {
    intentsToSend.delete("payment_qr");
    console.warn("payment_qr suppressed: co-occurred with service_packages flow", {
      conversationId: lastMessage.conversationId,
      messageId: lastMessage.messageId,
    });
  }

  // Guarda determinista: el video de ubicación es EXCLUSIVO del curso. Si el turno gira
  // en torno a la oficina (visita, cita, horario de atención) y no se está hablando de
  // cursos, no debe salir — son dos lugares distintos y confundirlos ya causó problemas.
  if (intentsToSend.has("location_video")) {
    const asksAboutOffice =
      APPOINTMENT_KEYWORDS.test(normalizedLastMessageText) &&
      !COURSE_KEYWORDS.test(normalizedLastMessageText);

    if (asksAboutOffice || turn.office_visit_requested) {
      intentsToSend.delete("location_video");
      console.warn("location_video suppressed: office flow, not a course location", {
        conversationId: lastMessage.conversationId,
        messageId: lastMessage.messageId,
      });
    }
  }

  // Guarda determinista: si un curso vigente se dicta excepcionalmente en otra ubicación,
  // el video de "cómo llegar" muestra la habitual y contradiría el link que se acaba de
  // dar — mandaría gente al lugar equivocado justo el día del curso. El prompt ya lo pide,
  // pero esto no puede depender del criterio del modelo. Se vuelve inerte solo cuando la
  // excepción vence (ver locationOverride.until en lib/courses.ts).
  if (intentsToSend.has("location_video") && hasActiveLocationOverride(new Date())) {
    intentsToSend.delete("location_video");
    console.warn("location_video suppressed: active course location override", {
      conversationId: lastMessage.conversationId,
      messageId: lastMessage.messageId,
    });
  }

  // Guarda determinista: el agente de IA (LÍNEA C) es un embudo independiente de los
  // cursos y de los paquetes de video. Si el LLM marcó el flyer de IA junto a otro de
  // esos flyers, el texto de la respuesta corresponde a uno solo — enviar ambos
  // confundiría al cliente con dos servicios distintos en el mismo turno.
  if (
    intentsToSend.has("ai_agent_flyer") &&
    (turn.intents.service_packages || turn.intents.course_flyer)
  ) {
    intentsToSend.delete("ai_agent_flyer");
    console.warn("ai_agent_flyer suppressed: co-occurred with another flow", {
      conversationId: lastMessage.conversationId,
      messageId: lastMessage.messageId,
      service_packages: turn.intents.service_packages,
      course_flyer: turn.intents.course_flyer,
    });
  }

  // Guarda determinista de CONTINUIDAD DE CONTEXTO: con un flujo ya abierto, una mención
  // suelta de otra línea ("todo IA" hablando de paquetes) no debe traer el material de esa
  // otra línea. Solo se acepta el cambio si el cliente lo pidió de forma explícita.
  // Se mira el material realmente enviado: la línea abierta es la que ya tiene material.
  // Una línea está abierta si YA se envió cualquiera de sus materiales — para la LÍNEA B
  // eso incluye la imagen de la promo temporal, que también la abre (ver LINE_MEDIA_INTENTS).
  const openLines = (
    ["course_flyer", "service_packages", "ai_agent_flyer"] as const
  ).filter((line) => LINE_MEDIA_INTENTS[line].some((intent) => mediaStatus[intent]));

  if (openLines.length > 0 && !turn.explicit_resend_request) {
    for (const line of ["course_flyer", "service_packages", "ai_agent_flyer"] as const) {
      const lineIntents = LINE_MEDIA_INTENTS[line].filter((intent) =>
        intentsToSend.has(intent),
      );

      if (lineIntents.length === 0) continue;
      if (openLines.includes(line)) continue;
      if (detectExplicitLineSwitch(lastMessage.text, line)) continue;

      for (const intent of lineIntents) intentsToSend.delete(intent);

      console.warn("line switch blocked: no explicit request from client", {
        conversationId: lastMessage.conversationId,
        messageId: lastMessage.messageId,
        from: openLines.join(","),
        to: line,
      });

      await logSystemEvent({
        level: "info",
        eventType: "line_switch_blocked",
        conversationId: lastMessage.conversationId,
        messageId: lastMessage.messageId,
        contactPhone: lastMessage.from,
        metadata: {
          open_lines: openLines,
          blocked_line: line,
          client_message: lastMessage.text.slice(0, 200),
        },
      });
    }
  }

  // Reenvío explícito: forzar (anular dedup) los intents detectados este turno.
  if (turn.explicit_resend_request) {
    for (const intent of intentsToSend) forcedIntents.add(intent);
  }

  // QR pedido con todas las letras: sale aunque lo haya recibido hace menos de 1 hora.
  if (forceQrResend && intentsToSend.has("payment_qr")) forcedIntents.add("payment_qr");

  // --- Botón a la página de la línea (ver lib/site-links.ts) ---------------------------
  // El botón ES el material de las líneas A y B: reemplaza a los flyers y al texto largo.
  // Se decide DESPUÉS de todas las guardas de arriba: sigue al material que de verdad sale
  // (cursos → /cursos, paquetes o formulario → /paquetes) y, sobre todo, al texto fijo de
  // botón de la respuesta, que siempre lleva el suyo. Los turnos de pago, de derivación a un
  // asesor o de cierre de lead no llevan botón: ahí el siguiente paso es otro (el QR, el
  // asesor) y un link solo distrae.
  const siteBaseUrl = getSiteBaseUrl();
  let linkButton: LinkButton | null = null;

  if (siteBaseUrl) {
    const linkPackageName =
      chosenPackage?.name ??
      VIDEO_PACKAGES.find(
        (pkg) =>
          packageSlug(pkg.name) ===
          (detectSelectedPackageName(lastMessage.text) ?? flowState.selectedPackage),
      )?.name ??
      null;

    linkButton = decideLinkButton({
      baseUrl: siteBaseUrl,
      phone: lastMessage.from,
      secret: getLeadLinkSecret(),
      intents: intentsToSend,
      // El recordatorio fijo del formulario también es el momento de ofrecer la página.
      serviceIntakeRequested: turn.service_intake_requested || isDeterministicIntakeNudge,
      packageName: linkPackageName,
      mentionedCourseIds: detectMentionedCourses(batchText, COURSES).map((course) => course.id),
      linkRequest: detectSiteLinkRequest(batchText),
      replyMentionsButton: replyMentionsButton(replyText),
      replyButtonKind: detectButtonTextKind(replyText),
      // Qué formulario abre "Agendar visita": el del curso, el del agente de IA o el de negocio.
      officeVisitType:
        replyText === OFFICE_COURSE_BUTTON_TEXT
          ? "curso"
          : mediaStatus.ai_agent_flyer || turn.intents.ai_agent_flyer
            ? "agente"
            : "negocio",
      blocked:
        intentsToSend.has("payment_qr") ||
        intentsToSend.has("ai_agent_flyer") ||
        turn.advisor_handoff ||
        turn.lead_data_submitted ||
        turn.ai_agent_lead_submitted ||
        callRequested ||
        turn.office_visit_requested ||
        // Viene de la página (mensaje prellenado): no se le devuelve el mismo link.
        isSitePrefilledMessage(lastMessage.text) ||
        // Deriva al editor (edición neta, o cliente fuera de la ciudad): los paquetes no van.
        replyText.includes(EDITOR_PHONE),
      lastSentAt: await getLinkButtonsLastSentAt(lastMessage.from),
      now: turnNow,
    });

    // Con el lead ya en manos del asesor, el formulario de paquetes no tiene nada que hacer.
    if (linkButton && linkButton.kind !== "courses" && telegramLeadSent && !linkButton.forced) {
      linkButton = null;
    }
  }

  // Ya no salen los flyers de cursos ni los de paquetes: la información está en la página.
  // Tampoco el video de cómo llegar si la respuesta no da la ubicación con su link: antes salía
  // con cada consulta de cursos, y ahora la ubicación va solo cuando la piden.
  intentsToSend.delete("course_flyer");
  intentsToSend.delete("service_packages");
  // Sin ningún curso con fecha cargada no sale NADA de cursos: ni el QR (no hay qué pagar)
  // ni el video de cómo llegar (no hay a dónde ir).
  if (!hasCourseWithDate(turnNow)) {
    intentsToSend.delete("payment_qr");
    intentsToSend.delete("location_video");
  }
  if (intentsToSend.has("location_video") && !/https?:\/\//i.test(replyText)) {
    intentsToSend.delete("location_video");
  }

  // El botón viaja pegado a la respuesta cuando cabe (no cuesta un mensaje aparte); si no,
  // sale solo al final del turno, después de todo el material.
  const mediaAfterReply = [...intentsToSend].some(
    (intent) => !MEDIA_BEFORE_REPLY.includes(intent),
  );
  const attachLinkButton =
    linkButton !== null && canAttachButtonToReply(replyText, mediaAfterReply);
  let linkButtonAttached = false;

  const sentIntents: MediaIntent[] = [];

  const sendIntentMedia = async (intent: MediaIntent) => {
    const mediaResult = await sendMediaForIntent({
      intent,
      conversationId: mediaConversationId,
      phone: lastMessage.from,
      phoneNumberId,
      force: forcedIntents.has(intent),
    });

    if (mediaResult.status === "sent") {
      sentIntents.push(intent);
    } else if (mediaResult.status === "no_assets" || mediaResult.status === "send_failed") {
      await notifyMediaFailureToTelegram({
        intent,
        phone: lastMessage.from,
        conversationId: mediaConversationId,
        reason: mediaResult.status,
      });
    }
  };

  // Material que va ANTES del texto: las imágenes de los paquetes. El texto que las sigue
  // ("¿Cómo trabajamos...?" o el formulario) ya no repite los precios. Si fallan, el texto
  // sale igual: sin respuesta sería peor.
  for (const intent of MEDIA_BEFORE_REPLY) {
    if (!intentsToSend.has(intent)) continue;
    try {
      await sendIntentMedia(intent);
    } catch (error) {
      console.error("media before reply failed", intent, error);
    }
  }

  // Última guarda antes de gastar el mensaje: si es exactamente lo que ya se envió hace
  // minutos, el texto NO se manda (el material de arriba sí salió, con su propio dedup). El
  // turno sigue igual: los avisos al equipo —lead, pago, visita— no dependen del envío.
  const isDuplicateReply = await wasSameReplySentRecently(mediaConversationId, replyText);

  if (isDuplicateReply) {
    console.log("duplicate reply skipped, nothing sent to the client");

    await logSystemEvent({
      level: "info",
      eventType: "bot_reply_skipped_duplicate",
      conversationId: lastMessage.conversationId,
      messageId: lastMessage.messageId,
      contactPhone: lastMessage.from,
      metadata: {
        media_sent_before_reply: sentIntents,
        reply_preview: replyText.slice(0, 120),
      },
    });
  } else {
    try {
      if (attachLinkButton && linkButton) {
        try {
          await sendLinkButton({
            kapso,
            phoneNumberId,
            to: lastMessage.from,
            button: linkButton,
            bodyText: replyText,
            // Si la respuesta ya habla del botón (los textos fijos), el pie lo repetiría.
            footerText: replyMentionsButton(replyText) ? undefined : linkButton.footerText,
          });
          linkButtonAttached = true;
        } catch (error) {
          // Sin botón, pero con respuesta: el texto sale igual como siempre.
          console.error("reply with link button failed, sending plain text", error);

          await logSystemEvent({
            level: "warning",
            eventType: "link_button_send_failed",
            conversationId: lastMessage.conversationId,
            messageId: lastMessage.messageId,
            contactPhone: lastMessage.from,
            errorMessage: getErrorMessage(error),
            metadata: { kind: linkButton.kind, attached_to_reply: true },
          });
        }
      }

      if (!linkButtonAttached) {
        await kapso.messages.sendText({
          phoneNumberId,
          to: lastMessage.from,
          body: replyText,
        });
      }

      console.log("Kapso SDK text sent successfully", {
        link_button: linkButton?.kind ?? null,
        attached: linkButtonAttached,
      });

      await logSystemEvent({
        level: "info",
        eventType: "reply_sent",
        conversationId: lastMessage.conversationId,
        messageId: lastMessage.messageId,
        contactPhone: lastMessage.from,
        metadata: {
          duration_ms: Date.now() - generationStartedAt,
          wait_ms: waitMs,
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
          media_sent_before_reply: sentIntents,
        },
      });

      return new Response("send failed", { status: 502 });
    }
  }

  try {
    // El texto repetido no se guarda en el historial: nunca llegó al cliente, y si quedara
    // guardado el bot creería habérselo dicho.
    if (!isDuplicateReply) {
      await saveOutboundMessage({
        conversationId: mediaConversationId,
        phone: lastMessage.from,
        content: replyText,
      });
    }

    await markReplyLockSent({
      lastMessageId: lastMessage.messageId,
      conversationId: lastMessage.conversationId,
      phone: lastMessage.from,
      responseText: isDuplicateReply
        ? "[SKIPPED:duplicate] el mismo texto ya se había enviado hace minutos"
        : replyText,
    });

    // Pedido de reunión en oficina: queda registrado para que la alerta del lead (que
    // llega cuando el cliente manda sus datos, turnos después) le avise al asesor.
    if (turn.office_visit_requested && !officeVisitAlreadyRequested) {
      await saveOutboundMessage({
        conversationId: mediaConversationId,
        phone: lastMessage.from,
        content: `${OFFICE_VISIT_MARKER} el cliente quiere reunirse en la oficina (se coordina por llamada)`,
        rawPayload: { type: "office_visit_request", kind: officeVisitKind },
      });
    }

    // Visita por un curso: sin formulario de por medio, el asesor se entera ahora.
    if (courseOfficeVisitToNotify) {
      await notifyCourseOfficeVisitToTelegram({
        phone: lastMessage.from,
        conversationId: mediaConversationId,
        clientMessage: batchText,
        summary: turn.conversation_summary,
      });
    }

    if (turn.service_intake_requested) {
      await saveOutboundMessage({
        conversationId: mediaConversationId,
        phone: lastMessage.from,
        content: "[INTAKE_FORM_SENT] formulario de datos para paquetes de producción",
        rawPayload: { type: "intake_form", source: "service_packages_intake" },
      });

      // Transición de estado: el formulario fue enviado -> intake_sent.
      await advanceConversationFlowState({
        conversationId: mediaConversationId,
        phone: lastMessage.from,
        targetStage: "intake_sent",
        currentStage: flowState.flowStage,
        patch: {
          intake_form_sent_at: new Date().toISOString(),
          selected_package:
            detectSelectedPackageName(lastMessage.text) ??
            flowState.selectedPackage ??
            null,
        },
      });
    }

    for (const intent of MEDIA_SEND_ORDER) {
      if (!intentsToSend.has(intent) || MEDIA_BEFORE_REPLY.includes(intent)) continue;
      await sendIntentMedia(intent);
    }

    // Botón a la página: si no viajó pegado a la respuesta, sale ahora, último en el turno.
    // Con la respuesta descartada por repetida tampoco sale: el cliente ya tiene todo arriba.
    if (linkButton && !isDuplicateReply) {
      let linkButtonSent = linkButtonAttached;

      if (!linkButtonAttached) {
        try {
          await sendLinkButton({
            kapso,
            phoneNumberId,
            to: lastMessage.from,
            button: linkButton,
            bodyText: linkButton.bodyText,
          });
          linkButtonSent = true;
        } catch (error) {
          console.error("link button send failed", linkButton.kind, error);

          await logSystemEvent({
            level: "warning",
            eventType: "link_button_send_failed",
            conversationId: lastMessage.conversationId,
            messageId: lastMessage.messageId,
            contactPhone: lastMessage.from,
            errorMessage: getErrorMessage(error),
            metadata: { kind: linkButton.kind, attached_to_reply: false },
          });
        }
      }

      if (linkButtonSent) {
        await saveLinkButtonSent({
          conversationId: mediaConversationId,
          phone: lastMessage.from,
          button: linkButton,
          attachedToReply: linkButtonAttached,
        });
      }
    }

    // Lead: el cliente envió sus datos de contratación, o pidió que un asesor lo
    // llame (intención de cierre igual de fuerte, sin pasar por el formulario).
    // Como los datos pueden haber llegado repartidos en varios mensajes (clientes
    // que responden campo por campo), se incluyen los últimos mensajes del cliente
    // y no solo el último, para que el asesor tenga el contexto completo.
    // Ambos disparadores comparten el marcador [TELEGRAM_LEAD_SENT]: el mismo
    // contacto nunca genera dos leads.
    // Solo se avisa si la conversación tiene contexto comercial real: un nombre y un
    // teléfono sueltos en un chat ajeno al negocio no son un lead.
    // Tampoco se avisa si el cliente escribe por una campaña de apoyo ya cerrada: ese
    // turno lo resuelve el bot entero, no hay nada que el asesor pueda gestionar.
    if (
      (turn.lead_data_submitted || callRequested || turn.ai_agent_lead_submitted) &&
      !telegramLeadSent &&
      !mentionsClosedRelief &&
      conversationIsCommercial
    ) {
      // El lead del agente de IA (LÍNEA C) solo se etiqueta como tal si no hubo además
      // un pedido de llamada ni datos de paquetes en el mismo turno: esos dos son
      // señales más urgentes/específicas para el asesor.
      const isAiAgentLead =
        turn.ai_agent_lead_submitted && !callRequested && !turn.lead_data_submitted;

      const trigger: LeadTrigger = turn.call_request
        ? "call_request_assistant"
        : callRequestHeuristic
          ? "call_request_heuristic"
          : isAiAgentLead
            ? "ai_agent_form"
            : "intake_form";

      await notifyLeadToTelegram({
        history,
        phone: lastMessage.from,
        contactName: lastMessage.contactName,
        conversationId: mediaConversationId,
        fallbackText: lastMessage.text,
        summary: turn.conversation_summary,
        kind: isAiAgentLead
          ? "ai_agent"
          : callRequested && !turn.lead_data_submitted
            ? "call_request"
            : "intake",
        wantsOfficeVisit,
        trigger,
      });

      await markLeadCaptured(
        mediaConversationId,
        lastMessage.from,
        flowState.flowStage,
      );
    } else if (
      (turn.lead_data_submitted || callRequested || turn.ai_agent_lead_submitted) &&
      !conversationIsCommercial
    ) {
      await logTelegramSkippedNoContext("lead");
    }

    // Pago: red de seguridad para el caso de FRASE explícita de pago sin archivo
    // ("ya pagué"), que `receiptDetected` no cubre porque no hay nada que verificar.
    // El caso normal (imagen/PDF confirmados) ya se notificó de forma determinista
    // más arriba, antes de cualquier return temprano — `!receiptDetected` evita
    // duplicar la alerta dentro del mismo request.
    // Con una alerta 💰 esperando los datos del cliente, ese comprobante ya tiene su alerta:
    // otra aquí sería un duplicado.
    if (
      turn.payment_confirmation &&
      !telegramPaymentSent &&
      !openPaymentAlert &&
      !receiptRejected &&
      !receiptDetected
    ) {
      await notifyPaymentToTelegram({
        phone: lastMessage.from,
        conversationId: mediaConversationId,
        messageId: lastMessage.messageId,
        clientMessage: lastMessage.text,
        reason: paymentReason,
        contactName: lastMessage.contactName,
        note: promoDetected
          ? `🎥 Promo del live — el cliente indicó ${promoAmount} Bs (verificar contra el comprobante)`
          : undefined,
        verification: receiptCheck?.source === "vision" ? receiptCheck.reason : undefined,
      });
    }

    // Oportunidad comercial fuera de catálogo (ej. "un solo video"/spot/comercial): el bot
    // ya respondió con normalidad (el catálogo de paquetes), pero se avisa también al asesor
    // por si vale la pena revisar el caso. Comparte el marcador [TELEGRAM_HANDOFF_SENT] con
    // el caso de silencio por información no documentada — un solo aviso por conversación.
    if (
      turn.advisor_handoff &&
      turn.advisor_handoff_reason === "out_of_catalog" &&
      !telegramHandoffSent
    ) {
      if (conversationIsCommercial) {
        await notifyAdvisorHandoffToTelegram({
          history,
          phone: lastMessage.from,
          contactName: lastMessage.contactName,
          conversationId: mediaConversationId,
          reason: "out_of_catalog",
          lastMessageText: lastMessage.text,
          summary: turn.conversation_summary,
        });
      } else {
        await logTelegramSkippedNoContext("advisor_handoff:out_of_catalog");
      }
    }

    // LEAD por cantidad fuera de los paquetes (ej. "quiero 15 videos", "necesito 30 al mes"):
    // el bot ya respondió que un asesor se comunicará y pidió los datos, pero el cierre lo hace
    // una persona — sin este aviso el lead se quedaría esperando. Marcador PROPIO
    // [TELEGRAM_CUSTOM_QUANTITY_SENT]: un aviso por conversación, y sin que se lo coma el
    // handoff genérico si la conversación ya derivó antes por otro motivo.
    if (
      turn.advisor_handoff &&
      turn.advisor_handoff_reason === "custom_quantity" &&
      !telegramCustomQuantitySent
    ) {
      if (conversationIsCommercial) {
        await notifyAdvisorHandoffToTelegram({
          history,
          phone: lastMessage.from,
          contactName: lastMessage.contactName,
          conversationId: mediaConversationId,
          reason: "custom_quantity",
          lastMessageText: lastMessage.text,
          summary: turn.conversation_summary,
          note: requestedVideoCount
            ? `🎬 Pidió ${requestedVideoCount} videos (los paquetes son de ${renderPackageSizes()}) — el precio lo defines tú`
            : `⚠️ Cantidad fuera de los paquetes (${renderPackageSizes()}) — revisar el chat`,
        });
      } else {
        await logTelegramSkippedNoContext("advisor_handoff:custom_quantity");
      }
    }

    // LEAD por un EXTRA sobre el paquete (dron en un paquete que no lo trae, locución,
    // actores...): el bot ya le dijo al cliente que un asesor le arma la cotización, así
    // que ese asesor tiene que enterarse sí o sí. Marcador propio por el mismo motivo que
    // el lead por cantidad: es una cotización pendiente y no puede perderse porque la
    // conversación haya derivado antes por otra cosa.
    if (
      turn.advisor_handoff &&
      turn.advisor_handoff_reason === "package_addon" &&
      !telegramPackageAddonSent
    ) {
      if (conversationIsCommercial) {
        const addonDetail = turn.package_addon_detail?.trim();

        await notifyAdvisorHandoffToTelegram({
          history,
          phone: lastMessage.from,
          contactName: lastMessage.contactName,
          conversationId: mediaConversationId,
          reason: "package_addon",
          lastMessageText: lastMessage.text,
          summary: turn.conversation_summary,
          note: [
            `🚁 Pidió sumar un extra${addonDetail ? `: ${addonDetail}` : ""}`,
            chosenPackage
              ? `📦 Sobre el paquete ${chosenPackage.name} (${chosenPackage.videos} videos — ${chosenPackage.price} Bs)`
              : null,
            "💰 El precio con el extra lo defines tú — el bot NO dio ninguna cifra",
          ]
            .filter(Boolean)
            .join("\n"),
        });
      } else {
        await logTelegramSkippedNoContext("advisor_handoff:package_addon");
      }
    }

    // ACUERDO PREVIO: el cliente afirma que ya cerró condiciones con alguien del equipo.
    // Es el aviso más urgente que emite el bot — hay una promesa humana de por medio que
    // el bot no conoce — y por eso lleva marcador propio y no compite con los demás.
    if (
      turn.advisor_handoff &&
      turn.advisor_handoff_reason === "prior_agreement" &&
      !telegramPriorAgreementSent
    ) {
      // Este aviso NO pasa por el gate de contexto comercial que usan los demás: decir
      // "ya acordamos algo con ustedes" ES contexto comercial, aunque el chat todavía no
      // tenga material enviado. Si no saliera, el cliente quedaría con el bot apagado y
      // sin nadie avisado — justo el escenario que esto viene a evitar.
      await notifyAdvisorHandoffToTelegram({
        history,
        phone: lastMessage.from,
        contactName: lastMessage.contactName,
        conversationId: mediaConversationId,
        reason: "prior_agreement",
        lastMessageText: lastMessage.text,
        summary: turn.conversation_summary,
        note: `⚠️ El cliente dice que ya acordó algo con el equipo. El bot NO le respondió con el catálogo y quedó apagado ${HUMAN_HANDOFF_PAUSE_MINUTES / 60} h — retoma tú el chat`,
      });
    }

    // Posible reembolso: el cliente pagó para el curso con la fecha anterior (26 de julio) y
    // ya no puede asistir por el cambio de fecha. El bot ya respondió avisando que un asesor
    // revisará el reembolso; aquí solo se notifica al equipo por Telegram para que le den
    // seguimiento. Comparte el marcador [TELEGRAM_HANDOFF_SENT] — un solo aviso por conversación.
    if (
      turn.advisor_handoff &&
      turn.advisor_handoff_reason === "refund_old_date" &&
      !telegramHandoffSent
    ) {
      if (conversationIsCommercial) {
        await notifyAdvisorHandoffToTelegram({
          history,
          phone: lastMessage.from,
          contactName: lastMessage.contactName,
          conversationId: mediaConversationId,
          reason: "refund_old_date",
          lastMessageText: lastMessage.text,
          summary: turn.conversation_summary,
        });
      } else {
        await logTelegramSkippedNoContext("advisor_handoff:refund_old_date");
      }
    }

    // Tema del curso fuera del temario confirmado: el bot ya respondió en positivo (sin
    // negar el tema ni comprometerse), y aquí se notifica al equipo por Telegram para que
    // un asesor confirme el detalle real con el cliente. Comparte el marcador
    // [TELEGRAM_HANDOFF_SENT] — un solo aviso por conversación.
    if (
      turn.advisor_handoff &&
      turn.advisor_handoff_reason === "course_topic_unconfirmed" &&
      !telegramHandoffSent
    ) {
      if (conversationIsCommercial) {
        await notifyAdvisorHandoffToTelegram({
          history,
          phone: lastMessage.from,
          contactName: lastMessage.contactName,
          conversationId: mediaConversationId,
          reason: "course_topic_unconfirmed",
          lastMessageText: lastMessage.text,
          summary: turn.conversation_summary,
        });
      } else {
        await logTelegramSkippedNoContext("advisor_handoff:course_topic_unconfirmed");
      }
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

  // APAGADO DEL BOT AL PASAR EL CASO A UN HUMANO. Va al final, después de enviar la
  // respuesta y de avisar por Telegram: el cliente recibe el mensaje de cierre ("un asesor
  // se comunicará contigo") y a partir de ahí el chat es del asesor. Los mensajes que
  // lleguen durante la pausa se guardan igual, y el lead o el comprobante se siguen
  // notificando — lo único que se apaga es la respuesta automática.
  //
  // El orden de los motivos va de más específico a más general: es solo la etiqueta que
  // queda registrada, la pausa es la misma.
  // El apagado por lead cerrado exige señal REAL de que hubo datos: el formulario ya pedido
  // en esta conversación, o datos de contacto en el propio mensaje. Si el modelo marca el
  // cierre por error en un turno temprano, el aviso al asesor sale igual (como siempre) pero
  // el bot NO se apaga sobre un chat que recién empieza.
  const leadActuallyClosed =
    (turn.lead_data_submitted || turn.ai_agent_lead_submitted) &&
    (intakeInProgress ||
      turn.service_intake_requested ||
      detectLeadDataHeuristic(lastMessage.text));

  const handoffReasonPauses =
    turn.advisor_handoff &&
    turn.advisor_handoff_reason !== null &&
    PAUSE_ON_HANDOFF_REASONS.includes(turn.advisor_handoff_reason);

  const humanHandoffPauseReason: HumanHandoffPauseReason | null =
    turn.advisor_handoff_reason === "prior_agreement"
      ? "prior_agreement"
      : callRequested
        ? "call_requested"
        : leadActuallyClosed
          ? "lead_closed"
          : handoffReasonPauses
            ? "advisor_handoff"
            : null;

  if (humanHandoffPauseReason) {
    await pauseBotForHumanHandoff({
      conversationId: lastMessage.conversationId,
      phone: lastMessage.from,
      messageId: lastMessage.messageId,
      reason: humanHandoffPauseReason,
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
      lead_data_submitted: turn.lead_data_submitted,
      call_request: callRequested,
      call_request_source: turn.call_request
        ? "assistant"
        : callRequestHeuristic
          ? "heuristic"
          : null,
      office_visit_requested: turn.office_visit_requested,
      audio_transcription_failed: lastAudioUnreadable,
      ai_agent_lead_submitted: turn.ai_agent_lead_submitted,
      relief_campaign_closed_notice: mentionsClosedRelief,
      advisor_handoff: turn.advisor_handoff,
      advisor_handoff_reason: turn.advisor_handoff_reason,
      human_handoff_pause_reason: humanHandoffPauseReason,
      detected_intents: turn.intents,
      sent_intents: sentIntents,
      link_button: linkButton?.kind ?? null,
      link_button_attached: linkButtonAttached,
    },
  });

  return new Response("ok", { status: 200 });
}
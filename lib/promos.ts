// Promociones temporales con vigencia propia, en el mismo espíritu que lib/courses.ts:
// una promo deja de anunciarse SOLA cuando pasa su ventana, sin cron y sin que nadie
// tenga que acordarse de apagar un flag.
//
// Por qué existe este archivo aparte del registro en kapso_media_assets:
//   - La IMAGEN vive en la base (kapso_media_assets, con starts_at/expires_at).
//   - El TEXTO y la VENTANA viven aquí, porque el modelo necesita el copy en el prompt
//     y el backend necesita poder apagar el intent aunque la fila de la base quede mal
//     configurada (o al revés). Son dos candados independientes sobre la misma fecha.
//
// PARA ACTUALIZAR: edita SOLO la lista PROMOS. Al vencer una promo se puede borrar de
// la lista o dejarla: pasada su ventana el sistema la ignora igual.

import { normalizeForMatch } from "./keywords.ts";
import { renderPackageSizes } from "./packages.ts";
import { PROMO_FORM_BUTTON_TEXT } from "./site-links.ts";

const BOLIVIA_TZ = "America/La_Paz";

// Intents de material promocional. Debe coincidir con MediaIntent en el webhook y con
// la columna `intent` de kapso_media_assets.
type PromoIntent = "service_packages_promo";

type Promo = {
  id: string;
  // Identificador en la página /paquetes (?p=<slug>) y en selected_package.
  slug: string;
  // Intent con el que está registrada la imagen en kapso_media_assets.
  intent: PromoIntent;
  name: string;
  // Nombre corto: título de la tarjeta en la web y lo que manda su formulario. Máx. 40.
  shortName: string;
  // ISO con offset de Bolivia (UTC-4, sin horario de verano).
  startsAt: string;
  // Instante EXCLUSIVO en que deja de estar vigente. Para una promo válida "los días
  // 6 y 7", esto es el 8 a las 00:00 hora de Bolivia.
  endsAt: string;
  // Precio promocional en Bs. Se usa además para desambiguar la promo del live
  // (ver getActivePromoAmounts).
  price: number;
  // Cantidad de videos de la promo. Es una cantidad que NO está en el catálogo normal
  // (ver lib/packages.ts), así que mientras la promo está vigente el backend tiene que
  // reconocerla como "esta promo" y no como un pedido fuera de los paquetes.
  videoCount: number;
  // Línea de negocio a la que pertenece: define con qué otros materiales es excluyente.
  line: "service_packages";
  // Copy que se inyecta al prompt. Una línea por viñeta.
  details: string[];
  // Lo que incluye y las condiciones, para la ficha de la promo en /paquetes.
  includes: string[];
  notes: string[];
  // Presentadora profesional opcional: precio adicional en Bs. Sin el campo, la promo no
  // la ofrece y el formulario no pregunta quién sale en los videos.
  presenterPrice?: number;
  // Texto LITERAL con el que se responde la promo por WhatsApp. Con este campo la promo NO
  // usa imagen: el webhook reemplaza la respuesta del modelo por este texto revisado, así
  // el cliente recibe siempre la misma oferta y no una paráfrasis.
  clientText?: string;
  // Otros nombres con los que los clientes piden ESTA promo (lo que dicen los asesores, los
  // anuncios o una promo anterior parecida). Van al prompt para que el modelo no responda
  // que "no está en el catálogo".
  nicknames?: string[];
  // Los mismos apodos como red determinista, sobre el texto ya normalizado (mayúsculas, sin
  // tildes). Un monto aproximado ("el de 1000 Bs") va aquí con contexto de dinero o de
  // paquete, nunca como número suelto: "tengo 1000 seguidores" no pide la promo.
  clientHints?: RegExp;
  // Montos que también identifican la promo (además de `price`). Solo los usa la
  // desambiguación con la PROMO DEL LIVE: "promo 1000" es esta promo, no el QR de un curso.
  aliasAmounts?: number[];
};

// Texto oficial de la promo de 4 videos por 999 Bs, tal cual lo entregó el equipo.
const PROMO_999_TEXT = `🚀 ¡PROMOCIÓN ESPECIAL PARA TU NEGOCIO!

🔥 4 VIDEOS PROFESIONALES POR SOLO 999 Bs.

✅ Estrategia de contenido para tu negocio.
✅ Creación de guiones persuasivos.
✅ 1 sesión de grabación (los 4 videos el mismo día).
✅ Edición profesional de los 4 videos.
✅ Administración y publicación en TikTok.

🎬 SERVICIOS ADICIONALES:

🎤 Presentadora profesional: +200 Bs. Para que sea la imagen de tus videos.

📈 Publicidad en TikTok Ads: +200 Bs. Invertimos ese monto en publicidad para que tus videos puedan llegar a muchas más personas y atraer potenciales clientes a tu negocio.

💰 Forma de pago: 50% al iniciar y 50% al finalizar.

⏳ Promoción válida hasta el 13 de noviembre.

🔥 ¡No solo creamos videos, creamos contenido para ayudarte a vender más!

📲 ¿Te gustaría reservar tu sesión de grabación y aprovechar esta promoción?`;

const PROMOS: Promo[] = [
  {
    id: "promo_4_videos_999_2026_10",
    slug: "promo-4-videos",
    intent: "service_packages_promo",
    name: "Promoción especial — 4 videos profesionales por 999 Bs",
    shortName: "Promo 4 videos",
    // Primera tanda: 16–24 de octubre. El equipo la relanzó el 7 de noviembre con la misma
    // oferta (más Publicidad en TikTok Ads) y la da por terminada el 13 de noviembre
    // inclusive: por eso vence el 14 a las 00:00 hora de Bolivia.
    startsAt: "2026-11-07T00:00:00-04:00",
    endsAt: "2026-11-14T00:00:00-04:00",
    price: 999,
    videoCount: 4,
    line: "service_packages",
    details: [
      "4 videos profesionales por 999 Bs (precio TOTAL de la promo, no mensual).",
      "Incluye: estrategia de contenido personalizada, creación de guiones persuasivos, grabación profesional de los 4 videos, edición profesional y administración de la cuenta de TikTok.",
      "Los 4 videos se graban el MISMO día y los protagonistas son los propietarios del negocio.",
      "Presentadora profesional OPCIONAL: 200 Bs adicionales (en total 1.199 Bs). También puede salir el cliente; recomendamos que salga el dueño del negocio para conectar con el público.",
      "Publicidad en TikTok Ads OPCIONAL: 200 Bs adicionales. Ese monto se invierte en publicidad para que los videos lleguen a más personas y atraigan clientes potenciales. Se puede sumar con la presentadora (999 + 200 + 200 = 1.399 Bs).",
      "Forma de pago: 50% al iniciar y 50% al finalizar el paquete.",
      "La promoción es válida SOLO hasta el 13 de noviembre (inclusive). Si el cliente pregunta hasta cuándo, díselo con esa fecha. A partir del 14 de noviembre ya no existe.",
      "Lo que no está en esta lista (dron, más videos, manejo de otras redes) NO viene en la promo: si lo pide, un asesor se lo cotiza aparte.",
      "La fecha de grabación la coordina un asesor después de que el cliente deja sus datos: NUNCA confirmes tú un día ni una hora.",
    ],
    includes: [
      "Estrategia de contenido personalizada",
      "Creación de guiones persuasivos",
      "Grabación profesional de los 4 videos",
      "Edición profesional",
      "Administración de tu cuenta de TikTok",
    ],
    notes: [
      "Los 4 videos se graban el mismo día.",
      "Los propietarios del negocio son los protagonistas: así se conecta mejor con el público.",
      "Forma de pago: 50% al iniciar y 50% al finalizar el paquete.",
      "Servicios adicionales opcionales: presentadora profesional (+200 Bs) y publicidad en TikTok Ads (+200 Bs).",
      "Promoción válida hasta el 13 de noviembre.",
    ],
    presenterPrice: 200,
    clientText: PROMO_999_TEXT,
    // Clientes reales (19–21 oct 2026): "paquete expres", "quisiera adquirir el paquete
    // express" y "tomar el paquete de 1000 bs" recibieron el catálogo, y al último el bot le
    // dijo que ese paquete no existía. Así la llaman los asesores y así se llamaba la promo
    // de agosto (Paquete Exprés, 4 videos por 1.000 Bs).
    nicknames: ["paquete exprés", "el paquete de 1000 Bs", "la promo de 1000"],
    clientHints:
      /\bEXPRES{1,2}\b|\b1\.?000\s*(BS|BOB|BOLIVIANOS?)\b|\b(PAQUETE|PROMO|PROMOCION|PLAN)\s+(DE\s+)?1\.?000\b/,
    aliasAmounts: [1000],
  },
  {
    id: "promo_bolivia_2026_08",
    slug: "promo-bolivia",
    intent: "service_packages_promo",
    name: "Promo por Bolivia — Paquete Exprés: 4 videos por 1.000 Bs",
    shortName: "Paquete Exprés",
    startsAt: "2026-08-06T00:00:00-04:00",
    endsAt: "2026-08-08T00:00:00-04:00",
    price: 1000,
    videoCount: 4,
    line: "service_packages",
    details: [
      "Paquete Exprés promocional: 4 videos por 1.000 Bs (precio total, no mensual).",
      "Incluye estrategia, guiones, grabación profesional, edición y publicación.",
      "Los 4 videos se graban en un solo día.",
      "Válida ÚNICAMENTE los días jueves 6 y viernes 7 de agosto de 2026 (hora de Bolivia).",
    ],
    includes: ["Estrategia", "Guiones", "Grabación profesional", "Edición", "Publicación"],
    notes: ["Los 4 videos se graban en un solo día."],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// CAMPAÑAS DE APOYO (descuentos condicionados a que el cliente cumpla un requisito)
//
// Distintas de PROMOS: no tienen precio fijo, ni cantidad de videos, ni flyer. Son un
// descuento sobre CUALQUIER paquete del catálogo, y solo aplican a quien cumple una
// condición que el bot NO puede verificar (ser comerciante de tal feria, haber perdido
// mercadería). Comparten con PROMOS la ventana de vigencia, así que también se apagan
// solas.
//
// TRES ESTADOS, no dos. Una campaña puede cerrarse ANTES de que expire su ventana (el
// equipo se saturó y no puede recibir más gente). En ese caso no basta con borrarla:
// los clientes siguen escribiendo por el mismo motivo durante semanas, y si la campaña
// simplemente "no existe" el bot los manda al embudo normal. Por eso `status: "closed"`
// mantiene los disparadores vivos pero cambia la respuesta a un cierre respetuoso, sin
// formulario de leads y sin alertar a nadie.
//
// PARA ACTUALIZAR: edita SOLO la lista RELIEF_CAMPAIGNS.

// Días durante los que se sigue respondiendo el cierre después de que la campaña acaba.
// Pasada esa gracia el bloque desaparece del prompt solo, sin dejar texto muerto.
const RELIEF_CLOSED_GRACE_DAYS = 60;

type ReliefCampaign = {
  id: string;
  name: string;
  // "active": el bot informa el descuento y deja que un asesor valide los requisitos.
  // "closed": la campaña ya no recibe gente; el bot solo comunica el cierre.
  status: "active" | "closed";
  startsAt: string;
  // Instante EXCLUSIVO en que deja de estar vigente (mismo criterio que Promo.endsAt).
  endsAt: string;
  // Requisitos que el asesor debe verificar antes de aplicar el descuento. Solo
  // relevantes mientras status === "active".
  requirements: string[];
  details: string[];
  // Motivo del cierre, para que el LLM lo comunique con sus palabras. Una línea por
  // viñeta del prompt.
  closedReason: string[];
  // Mensaje LITERAL de cierre. Lo usa la red determinista del webhook cuando el LLM se
  // desvía (por ejemplo si igual manda el formulario de leads), así que el cliente
  // recibe siempre el mismo texto revisado y no una improvisación.
  closedReply: string;
  // Palabras del cliente que hablan de esta campaña. Mientras está vigente marcan a
  // quien podría calificar; una vez cerrada son los disparadores del mensaje de cierre.
  // En ambos casos son una red determinista que no depende de que el LLM se dé cuenta.
  clientHints: RegExp;
};

const RELIEF_CAMPAIGNS: ReliefCampaign[] = [
  {
    id: "relief_feria_barrio_lindo_2026_08",
    name: "Apoyo a comerciantes de la feria Barrio Lindo — 50% de descuento",
    // CERRADA antes de que expire su ventana: el alcance superó la capacidad del equipo.
    status: "closed",
    startsAt: "2026-08-11T00:00:00-04:00",
    endsAt: "2026-09-12T00:00:00-04:00",
    requirements: [
      "Ser comerciante/emprendedor de la feria Barrio Lindo.",
      "Haber perdido mercadería en el incendio.",
    ],
    details: [
      "50% de descuento sobre CUALQUIER paquete de producción de video del catálogo (Básico, Normal o Pro).",
      "Es un apoyo por el incendio de la feria, no una promoción comercial: trátalo con respeto y sin euforia comercial (nada de '¡aprovecha!' ni '¡oferta imperdible!').",
    ],
    closedReason: [
      "El alcance fue mucho mayor al que esperábamos y desde hace más de una semana el equipo está completamente saturado, así que ya no podemos recibir a más personas en esta campaña.",
      "Cierra con un deseo sincero de recuperación y ánimo (bendiciones, fuerza para levantarse). No es un cierre comercial: es acompañar.",
    ],
    closedReply: `Lamento mucho lo que pasó en la feria 🙏

El apoyo que dimos a los comerciantes de la feria Barrio Lindo ya no se encuentra vigente. El alcance fue mucho mayor al que esperábamos y desde hace más de una semana el equipo está completamente saturado, así que no podemos recibir a más personas en esta campaña.

Muchas bendiciones en la recuperación y muchos ánimos para levantarse 💪`,
    clientHints:
      /\bBARRIO\s+LINDO\b|\bINCENDIO\b|\bSE\s+(ME\s+)?QUEMO\b|\bQUEMARON\b|\bPERDI\b(?:\s+\S+){0,3}?\s+MERCADERIA\b/,
  },
];

// ¿La campaña está dentro de su ventana en este instante? Igual que isPromoActive: la
// comparación es entre instantes absolutos, así que no depende de la zona del servidor.
function isWithinReliefWindow(campaign: ReliefCampaign, now: Date): boolean {
  const time = now.getTime();
  return (
    time >= new Date(campaign.startsAt).getTime() &&
    time < new Date(campaign.endsAt).getTime()
  );
}

// Campañas que el bot puede ofrecer. `status` manda sobre las fechas: una campaña
// cerrada nunca vuelve a estar vigente aunque su ventana no haya expirado todavía.
function getActiveReliefCampaigns(now: Date): ReliefCampaign[] {
  return RELIEF_CAMPAIGNS.filter(
    (campaign) => campaign.status === "active" && isWithinReliefWindow(campaign, now),
  );
}

// Campañas que ya no reciben gente pero de las que el bot todavía tiene que saber
// responder: las cerradas a mano y las que se les pasó la ventana. Los clientes siguen
// escribiendo por el mismo motivo durante semanas después del cierre.
function getClosedReliefCampaigns(now: Date): ReliefCampaign[] {
  return RELIEF_CAMPAIGNS.filter((campaign) => {
    if (getActiveReliefCampaigns(now).includes(campaign)) return false;

    // La gracia se cuenta desde el cierre real: el fin de la ventana, o ahora mismo si
    // se cerró antes de tiempo (en ese caso siempre está dentro de la gracia).
    const graceEnd =
      new Date(campaign.endsAt).getTime() +
      RELIEF_CLOSED_GRACE_DAYS * 24 * 60 * 60 * 1000;

    return now.getTime() < graceEnd;
  });
}

// ¿El cliente habló de alguna campaña de apoyo, vigente o recién cerrada? Red de
// seguridad determinista que no depende de que el LLM se dé cuenta: mientras la campaña
// estaba vigente marcaba a quien podía calificar, y ahora que está cerrada es lo que
// dispara el mensaje de cierre (y mata el formulario de leads).
function mentionsReliefCampaign(text: string, now: Date): boolean {
  if (!text) return false;
  const normalized = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase();
  return [...getActiveReliefCampaigns(now), ...getClosedReliefCampaigns(now)].some(
    (campaign) => campaign.clientHints.test(normalized),
  );
}

// Bloque de las campañas ya cerradas. No es lo mismo que "no existe ninguna": aquí el
// bot SÍ tiene que saber de qué le hablan, porque los clientes siguen escribiendo por el
// mismo motivo. Lo único que cambia es el desenlace: se acompaña y se cierra, sin pedir
// datos y sin pasar a nadie a un asesor.
function renderClosedReliefContext(closed: ReliefCampaign[]): string {
  const lines = [
    "CAMPAÑAS DE APOYO CERRADAS (ya NO están vigentes; no se puede acceder a ellas):",
  ];

  for (const campaign of closed) {
    lines.push(
      `- ${campaign.name} — CERRADA. Ya no admite nuevos casos.`,
      ...campaign.closedReason.map((reason) => `  • ${reason}`),
    );
  }

  lines.push(
    "- CÓMO RESPONDER: si el cliente menciona la feria, el incendio, que se le quemó o perdió su mercadería, o pregunta por este descuento, reconoce lo ocurrido con empatía en una línea y dile con claridad que la campaña ya no se encuentra vigente, explicándole el motivo (el equipo está saturado por el alcance que tuvo). Cierra deseándole una buena recuperación y dándole ánimos.",
    "- NUNCA insinúes que todavía podría alcanzarle, ni prometas excepciones, revisiones, cupos, listas de espera ni 'consultarlo con el equipo'. La campaña está cerrada: no hay nada pendiente que gestionar.",
    "- NUNCA envíes el formulario de datos de leads por este motivo, ni le pidas nombre, empresa, cargo ni rubro, ni le digas que un asesor lo contactará o validará su caso. No hay nada que verificar.",
    "- NUNCA des un monto con descuento ni hagas la resta. Los precios normales del catálogo los puedes seguir dando con normalidad si te los pregunta.",
    "- Si DESPUÉS del cierre el cliente muestra interés en contratar a precio normal, esa es una intención comercial nueva: sigue el FLUJO B de siempre con normalidad.",
  );

  return lines.join("\n");
}

// Bloque de contexto de las campañas de apoyo. Igual que renderPromoContext: si no hay
// ninguna vigente, el modelo se queda sin material para inventarla.
function renderReliefContext(now: Date): string {
  const active = getActiveReliefCampaigns(now);
  const closed = getClosedReliefCampaigns(now);

  if (active.length === 0 && closed.length === 0) {
    return [
      "CAMPAÑAS DE APOYO / DESCUENTOS CONDICIONADOS: NINGUNA vigente en este momento.",
      "- NUNCA ofrezcas ni menciones un descuento por incendio, desastre o pertenencia a una feria. Si el cliente lo pide, dile con amabilidad que esa campaña ya no está vigente y ofrécele los paquetes normales (FLUJO B).",
    ].join("\n");
  }

  if (active.length === 0) return renderClosedReliefContext(closed);

  const lines = [
    "CAMPAÑAS DE APOYO VIGENTES (fuente de verdad; si no aparece aquí, NO existe):",
  ];

  for (const campaign of active) {
    lines.push(
      `- ${campaign.name} — vigente hasta el ${formatPromoDay(
        new Date(new Date(campaign.endsAt).getTime() - 1).toISOString(),
      )} (hora de Bolivia).`,
      ...campaign.details.map((detail) => `  • ${detail}`),
      "  • REQUISITOS que el cliente debe cumplir:",
      ...campaign.requirements.map((requirement) => `    - ${requirement}`),
    );
  }

  lines.push(
    "- CÓMO RESPONDER: si el cliente menciona la feria, el incendio o pregunta por este descuento, reconoce lo ocurrido con empatía y en una línea, confírmale que el descuento existe y explícale los requisitos. Si aún no sabes si califica, pregúntaselo directamente: si es comerciante de la feria y si perdió mercadería.",
    "- NUNCA digas el monto final ni el precio ya rebajado, ni hagas la resta tú. Di que es 50% sobre el paquete que elija y que un asesor le confirma el monto exacto. Los precios normales del catálogo sí los puedes seguir dando con normalidad.",
    "- NUNCA confirmes que el descuento ya está aplicado ni que 'ya quedó registrado'. Tú no verificas nada: un asesor valida que sea comerciante afectado y recién ahí se aplica. Di algo como 'un asesor valida tu caso y te confirma el precio con el descuento'.",
    "- Si el cliente califica o dice que sí cumple, sigue el FLUJO B normal (pídele sus datos con el formulario de leads) para que un asesor lo contacte y verifique su caso.",
    "- Si el cliente NO es de la feria, no le ofrezcas el descuento ni se lo insinúes: sigue con los paquetes normales.",
    "- El descuento aplica SOLO a los paquetes de producción de video (LÍNEA B). NO aplica a los cursos ni al agente de IA. Si lo pide para un curso o para el agente, dile con amabilidad que esta campaña es solo para los paquetes de producción.",
    "- NUNCA extiendas la campaña más allá de su fecha de vigencia ni prometas mantenerla.",
  );

  // Puede haber una campaña vigente y otra recién cerrada a la vez: el bot necesita las
  // dos, para no ofrecer la cerrada ni negar la vigente.
  if (closed.length > 0) lines.push("", renderClosedReliefContext(closed));

  return lines.join("\n");
}

// Mensaje literal de cierre de la primera campaña cerrada que reconozca lo que dijo el
// cliente. Es lo que envía la red determinista del webhook cuando el LLM se desvía.
function getReliefClosedReply(text: string, now: Date): string | null {
  if (!text) return null;
  const normalized = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase();

  const match = getClosedReliefCampaigns(now).find((campaign) =>
    campaign.clientHints.test(normalized),
  );

  return match?.closedReply ?? null;
}

// ¿La promo está dentro de su ventana en este instante? La comparación es entre
// instantes absolutos (los ISO llevan offset -04:00), así que no depende de la zona
// horaria del servidor: en Vercel corre en UTC y da el mismo resultado.
function isPromoActive(promo: Promo, now: Date): boolean {
  const time = now.getTime();
  return (
    time >= new Date(promo.startsAt).getTime() && time < new Date(promo.endsAt).getTime()
  );
}

function getActivePromos(now: Date): Promo[] {
  return PROMOS.filter((promo) => isPromoActive(promo, now));
}

// ¿Hay alguna promo vigente registrada bajo este intent? Es el candado del lado del
// código: aunque la fila de kapso_media_assets siga con is_active = true, el intent no
// se envía fuera de la ventana.
function isPromoIntentActive(intent: PromoIntent, now: Date): boolean {
  return getActivePromos(now).some((promo) => promo.intent === intent);
}

// Montos de las promos vigentes. Los usa el webhook para no confundir "promo 1000"
// (esta promoción de videos) con la PROMO DEL LIVE, que usa la misma palabra clave
// seguida del precio del CURSO anunciado en la transmisión.
function getActivePromoAmounts(now: Date): number[] {
  return getActivePromos(now).flatMap((promo) => [promo.price, ...(promo.aliasAmounts ?? [])]);
}

// Precios exactos de las promos vigentes: un "999" suelto en el mensaje ya es la promo.
// Los montos aproximados (aliasAmounts) no, porque un 1000 suelto puede ser cualquier cosa.
function getActivePromoPrices(now: Date): number[] {
  return getActivePromos(now).map((promo) => promo.price);
}

// ¿El cliente nombró una promo vigente por uno de sus apodos ("paquete exprés", "el de
// 1000 Bs")? `normalized` ya viene en mayúsculas y sin tildes.
function mentionsActivePromoNickname(normalized: string, now: Date): boolean {
  return getActivePromos(now).some((promo) => promo.clientHints?.test(normalized) ?? false);
}

// Cantidades de video de las promos vigentes ("4 videos"). Mientras la promo está
// vigente esa cantidad identifica a la promo, no un pedido fuera de catálogo.
function getActivePromoVideoCounts(now: Date): number[] {
  return getActivePromos(now).map((promo) => promo.videoCount);
}

// Promos cuya ventana ya pasó. Los clientes siguen llegando por la publicación o el
// video, así que el bot tiene que reconocerlas y decir que terminaron.
function getExpiredPromos(now: Date): Promo[] {
  return PROMOS.filter((promo) => now.getTime() >= new Date(promo.endsAt).getTime());
}

// Montos (precio + alias) de las promos vencidas. El webhook los usa para que un
// "promo 999" o "promo 1000" no se lea como PROMO DEL LIVE y dispare el QR de un curso.
function getExpiredPromoAmounts(now: Date): number[] {
  return getExpiredPromos(now).flatMap((promo) => [promo.price, ...(promo.aliasAmounts ?? [])]);
}

const EXPIRED_PROMO_WORDS = /\b(PROMO|PROMOS|PROMOCION|PROMOCIONES|OFERTA|OFERTAS|EXPRES|EXPRESS)\b/;
const EXPIRED_PROMO_MONEY = /\b(BS|BOB|BOLIVIANOS?)\b/;
const EXPIRED_PROMO_VIDEOS = /\bVIDEOS?\b/;
// "vi la promoción" a secas: llegan por la publicación sin citar monto ni nombre.
const SAW_PROMO =
  /\b(VI|VIMOS|VIO|VEO|VIENDO)\b(?:\s+\S+){0,6}?\s*\b(PROMO|PROMOS|PROMOCION|PROMOCIONES|OFERTA)\b/;

// ¿El cliente pregunta por una promo de video que ya terminó ("la promo de 999", "el
// paquete exprés", "4 videos por 999", "vi la promoción")? Mientras haya una promo vigente
// devuelve false: ahí manda renderPromoContext.
function mentionsExpiredVideoPromo(text: string, now: Date): boolean {
  if (!text) return false;
  if (getActivePromos(now).length > 0) return false;

  const normalized = normalizeForMatch(text);
  const numbers = (normalized.replace(/(\d)[.,](\d)/g, "$1$2").match(/\d+/g) ?? []).map(Number);
  const hasPromoWord = EXPIRED_PROMO_WORDS.test(normalized);

  return getExpiredPromos(now).some((promo) => {
    const amounts = [promo.price, ...(promo.aliasAmounts ?? [])];
    const hasAmount = numbers.some((n) => amounts.includes(n));
    const hasVideoCount =
      numbers.includes(promo.videoCount) && EXPIRED_PROMO_VIDEOS.test(normalized);

    if (promo.clientHints?.test(normalized)) return true;
    // El monto necesita contexto: "999 Bs", "promo 999", "999 por 4 videos".
    if (hasAmount) {
      return hasPromoWord || EXPIRED_PROMO_MONEY.test(normalized) || EXPIRED_PROMO_VIDEOS.test(normalized);
    }
    if (hasVideoCount && hasPromoWord) return true;
    return SAW_PROMO.test(normalized) && !/\bCURSOS?\b/.test(normalized);
  });
}

const EXPIRED_VIDEO_PROMO_REPLY = `Gracias por escribirnos 😊 La promoción de los 4 videos por 999 Bs estuvo vigente hasta el 13 de noviembre y ya finalizó, así que por ahora no tenemos ninguna promoción vigente.

Si te interesa, tenemos nuestros paquetes de producción de ${renderPackageSizes()} videos (estrategia, guiones, grabación, edición y publicación) — dime y te cuento 🎬`;

// ¿La respuesta del modelo ya dice que la promo terminó?
const EXPIRED_VIDEO_PROMO_ACK =
  /\bYA\s+NO\b|\bNO\s+(SE\s+ENCUENTRA|ESTA|ESTABA|TENEMOS|HAY)\b(?:\s+\S+){0,3}?\s*\b(VIGENTE|PROMOCION|PROMO)\b|\bFINALIZ(O|ADA|ADO)\b|\bTERMIN(O|ADA|ADO)\b|\bVENCI(O|DA|DO)\b|\bEXPIR(O|ADA|ADO)\b/;

function acknowledgesExpiredVideoPromo(reply: string): boolean {
  return EXPIRED_VIDEO_PROMO_ACK.test(normalizeForMatch(reply));
}

// Contexto para el prompt del turno cuando el cliente nombra una promo vencida.
function renderExpiredVideoPromoContext(): string {
  return `El cliente pregunta por la PROMOCIÓN DE 4 VIDEOS (999 Bs / 1.000 Bs). Esa promoción YA FINALIZÓ (estuvo vigente hasta el 13 de noviembre) y NO tenemos ninguna promoción vigente. Díselo con amabilidad y claridad en la primera línea. NUNCA envíes su texto oficial, no confirmes ese precio, no des un monto alternativo, no prometas reactivarla ni digas que un asesor puede hacer ese precio. Después ofrécele los paquetes normales (${renderPackageSizes()} videos). NO marques intents.service_packages_promo ni envíes el formulario de datos.`;
}

// Promo vigente que se responde con su texto literal (clientText), si hay una.
function getActiveTextPromo(now: Date): Promo | null {
  return getActivePromos(now).find((promo) => promo.clientText) ?? null;
}

// Promo vigente por su slug (?p= de la página) o por su nombre corto (lo que manda el
// formulario). Vencida no se encuentra: el formulario de una promo pasada no se acepta.
function findActivePromo(key: string, now: Date): Promo | null {
  if (!key) return null;
  return (
    getActivePromos(now).find((promo) => promo.slug === key || promo.shortName === key) ?? null
  );
}

// Primeras líneas con contenido del texto oficial: bastan para reconocerlo en el historial
// aunque se haya guardado recortado.
const promoTextHeadline = (text: string) =>
  text
    .split("\n")
    .map((line) => normalizeForMatch(line).trim())
    .filter(Boolean)
    .slice(0, 2);

// ¿Este mensaje del bot es el texto oficial de alguna promo? Con esto el webhook sabe que
// el cliente ya vio la oferta (para no repetirla y para leer su "sí" como aceptación).
function isPromoClientText(text: string): boolean {
  if (!text) return false;
  const normalized = normalizeForMatch(text);
  return PROMOS.some(
    (promo) =>
      promo.clientText !== undefined &&
      promoTextHeadline(promo.clientText).every((line) => normalized.includes(line)),
  );
}

// "jueves 6 de agosto" en hora de Bolivia, para el copy del contexto.
function formatPromoDay(iso: string): string {
  return new Intl.DateTimeFormat("es-BO", {
    timeZone: BOLIVIA_TZ,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date(iso));
}

// Bloque que se inyecta en el contexto del prompt en CADA mensaje. Es la única fuente
// de verdad sobre promociones: el prompt estático no nombra ninguna, así que cuando la
// ventana pasa el modelo deja de tener con qué inventarla.
function renderPromoContext(now: Date): string {
  const active = getActivePromos(now);

  if (active.length === 0) {
    return [
      "PROMOCIONES TEMPORALES: NINGUNA vigente en este momento.",
      '- Si el cliente pregunta por promociones, ofertas o descuentos, dile con naturalidad que por ahora no hay una promoción activa y ofrécele los paquetes normales (FLUJO B). NUNCA inventes una promo, un precio promocional ni una fecha de promoción.',
      "- NO marques intents.service_packages_promo: no hay material promocional que enviar.",
    ].join("\n");
  }

  const lines = [
    "PROMOCIONES TEMPORALES VIGENTES (fuente de verdad; si una promo no aparece aquí, NO existe):",
  ];

  for (const promo of active) {
    lines.push(
      `- ${promo.name} — vigente desde el ${formatPromoDay(promo.startsAt)} hasta el final del día ${formatPromoDay(
        new Date(new Date(promo.endsAt).getTime() - 1).toISOString(),
      )} (hora de Bolivia).`,
      ...promo.details.map((detail) => `  • ${detail}`),
      ...(promo.nicknames?.length
        ? [
            `  • Los clientes también la llaman ${promo.nicknames.map((name) => `"${name}"`).join(", ")}: es ESTA misma promo (el precio correcto es ${promo.price} Bs). NUNCA respondas que ese paquete no existe o no está en el catálogo.`,
          ]
        : []),
    );
  }

  const textPromo = active.find((promo) => promo.clientText);
  const promoMentions = active
    .map((promo) => `los ${promo.videoCount} videos / los ${promo.price} Bs`)
    .join(" o ");

  lines.push(
    textPromo
      ? `- Esta promo pertenece a la LÍNEA B (paquetes de producción). Cuando el cliente pregunte por promociones, ofertas o descuentos, o mencione ${promoMentions}, o pida esta promo: marca intents.service_packages_promo = true. La promo NO tiene imagen: el sistema envía su TEXTO OFICIAL en lugar de tu respuesta, en un solo mensaje con el botón "Llenar mis datos" que abre directo el formulario de la promo. En ese turno no la redactes tú (pon una sola línea corta; se reemplaza igual).`
      : `- Esta promo pertenece a la LÍNEA B (paquetes de producción). Cuando el cliente pregunte por promociones, ofertas o descuentos, o mencione ${promoMentions}, o pida esta promo: responde con sus datos concretos (sí puedes decir el precio y qué incluye, están arriba) y marca intents.service_packages_promo = true.`,
    `- En ese turno marca intents.service_packages = false: la promo y el flyer normal de paquetes NUNCA salen juntos, se enviaría material contradictorio (la promo vs. los paquetes mensuales de ${renderPackageSizes()} videos).`,
    "- Si el cliente pregunta por los paquetes NORMALES sin mencionar promoción, sigue el FLUJO B de siempre (intents.service_packages = true) y, si viene al caso, menciona en UNA línea que hay una promo vigente por si le interesa. NO marques los dos intents a la vez.",
    `- La promo NO reemplaza a los paquetes de ${renderPackageSizes()} videos: es una oferta temporal adicional.`,
    `- EXCEPCIÓN al flujo "CANTIDAD FUERA DE LOS PAQUETES": mientras esta promo esté vigente, pedir ${active
      .map((promo) => promo.videoCount)
      .join(" o ")} videos NO es una cantidad fuera de los paquetes — es exactamente esta promo. En ese caso NO respondas que solo existen los paquetes de ${renderPackageSizes()}, NO marques advisor_handoff (ni "out_of_catalog" ni "custom_quantity") y NO ofrezcas cotización a medida: ofrécele la promo y marca intents.service_packages_promo = true.`,
    "- NUNCA prometas la promo para después de su última fecha de vigencia ni la extiendas.",
    "- Si el cliente pregunta por \"el paquete\" o \"la publicidad que vi\" sin decir cuál, y no queda claro si es la promo o los paquetes del catálogo, NO asumas: pregúntale en una línea si le interesa la promoción de los videos o los paquetes mensuales, y no marques ningún intent hasta que lo diga.",
  );

  if (textPromo) {
    lines.push(
      "- Si el texto oficial de la promo YA se le envió en esta conversación (está en el historial), NO vuelvas a marcar intents.service_packages_promo salvo que pida la promo otra vez con todas las letras: responde sus dudas en pocas líneas con los datos de arriba.",
      `- INICIATIVA PARA ADQUIRIR LA PROMO: si el cliente responde con interés o positivismo a la promo ("sí", "me interesa", "la quiero", "agéndame", "quiero aprovecharla", "qué fecha tienen", "cómo empezamos"), responde ÚNICA y EXACTAMENTE con este texto: "${PROMO_FORM_BUTTON_TEXT}" y marca service_intake_requested = true (NO marques intents.service_packages_promo en ese turno). El sistema adjunta el botón que abre el formulario de la promo. NUNCA pegues el formulario 📌 ni le pidas los datos por chat.`,
      ...(textPromo.presenterPrice
        ? [
            `- Si pregunta por la presentadora: son ${textPromo.presenterPrice} Bs adicionales (en total ${textPromo.price + textPromo.presenterPrice} Bs) y la puede elegir en el formulario. Recomendamos que salga el dueño del negocio.`,
            "- Si pregunta por la publicidad en TikTok Ads: son 200 Bs adicionales y ese monto se invierte en publicidad para que los videos lleguen a más personas; si le interesa, lo coordina el asesor al recibir sus datos.",
          ]
        : []),
      "- NUNCA confirmes una fecha ni una hora de grabación: el asesor la coordina cuando recibe sus datos.",
    );
  }

  return lines.join("\n");
}

export {
  PROMOS,
  RELIEF_CAMPAIGNS,
  getActiveReliefCampaigns,
  getClosedReliefCampaigns,
  getReliefClosedReply,
  mentionsReliefCampaign,
  renderReliefContext,
  getActivePromos,
  getActivePromoAmounts,
  getActivePromoPrices,
  getActivePromoVideoCounts,
  getActiveTextPromo,
  mentionsActivePromoNickname,
  findActivePromo,
  isPromoClientText,
  isPromoActive,
  isPromoIntentActive,
  renderPromoContext,
  getExpiredPromoAmounts,
  mentionsExpiredVideoPromo,
  acknowledgesExpiredVideoPromo,
  renderExpiredVideoPromoContext,
  EXPIRED_VIDEO_PROMO_REPLY,
};
export type { Promo, PromoIntent, ReliefCampaign };

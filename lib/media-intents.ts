// Resolución determinista del conflicto entre la promo temporal de video y el flyer
// normal de paquetes. Función PURA (sin red, sin base, sin reloj propio: el instante
// entra por parámetro) para poder probar cada consulta real del cliente.
//
// Qué garantiza, sin depender de cómo clasifique el LLM:
//   1. Fuera de la ventana de la promo, service_packages_promo NUNCA sale.
//   2. Una consulta de CURSOS nunca recibe la promo de servicios.
//   3. La promo y el flyer de paquetes nunca salen juntos: sale exactamente uno.
//   4. Si el cliente pide la promo por nombre, por precio o por su cantidad de videos,
//      el material que sale es el de la promo.
//
// El resto de la selección de materiales (QR, video de ubicación, cambio de línea)
// sigue en el webhook: aquí solo vive lo que la promo introduce.

import {
  COURSE_KEYWORDS,
  PROMO_REQUEST_KEYWORDS,
  VIDEO_WORD_KEYWORDS,
  containsExactNumber,
  normalizeForMatch,
} from "./keywords.ts";
import {
  getActivePromoAmounts,
  getActivePromoVideoCounts,
  isPromoIntentActive,
} from "./promos.ts";

const PROMO_INTENT = "service_packages_promo";
const PACKAGES_INTENT = "service_packages";

// Motivo por el que se descartó un material. Se registra en los logs del webhook para
// poder auditar después por qué un cliente recibió (o no) la promo.
type PromoResolutionReason =
  | "promo_out_of_window"
  | "promo_on_course_query"
  | "promo_on_other_line"
  | "packages_won_conflict"
  | "promo_won_conflict"
  | "packages_swapped_for_promo"
  | "promo_added_on_request";

type PromoResolution = {
  // Intents que quedan, en el mismo orden en que llegaron.
  intents: string[];
  reasons: PromoResolutionReason[];
};

// ¿El cliente está pidiendo la promo VIGENTE? Tres formas de nombrarla:
//   - por la palabra promo/oferta/descuento,
//   - por su precio ("el de 1000", "la de 1.000 bs"),
//   - por su cantidad de videos ("quiero los 4 videos") — se exige la palabra "video"
//     para no confundirlo con cualquier otro 4 del mensaje ("a las 4", "4 sucursales").
// Sin promo vigente siempre es false: "¿tienen promoción?" en agosto 9 no pide nada que
// exista. Y una consulta que menciona cursos tampoco cuenta (ver isCourseQuery).
function asksForActivePromo(message: string, now: Date): boolean {
  if (!message) return false;
  if (!isPromoIntentActive(PROMO_INTENT, now)) return false;

  const normalized = normalizeForMatch(message);
  if (isCourseQuery(message)) return false;

  if (PROMO_REQUEST_KEYWORDS.test(normalized)) return true;
  if (containsExactNumber(normalized, getActivePromoAmounts(now))) return true;

  return (
    VIDEO_WORD_KEYWORDS.test(normalized) &&
    containsExactNumber(normalized, getActivePromoVideoCounts(now))
  );
}

// ¿El mensaje habla de CURSOS? Basta con que los nombre: "¿tienen promoción de cursos?"
// y "quiero pagar el curso de creación de contenido" son LÍNEA A, aunque la segunda
// contenga además palabras de servicios ("contenido"). La promo de videos no sale en
// ninguna de las dos — ante la duda, el material de la otra línea no se envía.
function isCourseQuery(message: string): boolean {
  if (!message) return false;

  return COURSE_KEYWORDS.test(normalizeForMatch(message));
}

function resolvePromoIntents(params: {
  intents: readonly string[];
  message: string;
  now: Date;
  courseFlyerMarked: boolean;
  aiAgentFlyerMarked: boolean;
}): PromoResolution {
  const intents = [...params.intents];
  const reasons: PromoResolutionReason[] = [];

  const drop = (intent: string, reason: PromoResolutionReason) => {
    const index = intents.indexOf(intent);
    if (index >= 0) intents.splice(index, 1);
    reasons.push(reason);
  };

  const promoActive = isPromoIntentActive(PROMO_INTENT, params.now);
  const clientAsksForPromo = promoActive && asksForActivePromo(params.message, params.now);

  if (intents.includes(PROMO_INTENT)) {
    // 1. Vencimiento: candado del lado del código, independiente de expires_at en la
    //    base. Basta con que uno de los dos esté bien puesto para que la promo pare.
    if (!promoActive) {
      drop(PROMO_INTENT, "promo_out_of_window");
    } else if (isCourseQuery(params.message)) {
      // 2. La promo es de la LÍNEA B: una pregunta por cursos no la recibe.
      drop(PROMO_INTENT, "promo_on_course_query");
    } else if (params.courseFlyerMarked || params.aiAgentFlyerMarked) {
      // 3. Tampoco se mezcla con el material de las otras dos líneas.
      drop(PROMO_INTENT, "promo_on_other_line");
    }
  }

  // 4. Promo y flyer de paquetes son excluyentes: muestran ofertas distintas de la
  //    misma línea (4 videos puntuales vs. 6/14 al mes) y juntas dejan al cliente con
  //    dos promociones parecidas y dos precios que no cuadran. Gana la promo solo si el
  //    cliente la pidió; si no, gana el flyer, que es el embudo principal.
  if (intents.includes(PROMO_INTENT) && intents.includes(PACKAGES_INTENT)) {
    if (clientAsksForPromo) {
      drop(PACKAGES_INTENT, "promo_won_conflict");
    } else {
      drop(PROMO_INTENT, "packages_won_conflict");
    }
  }

  // 5. Caso inverso: el cliente pidió la promo pero el turno quedó con el flyer normal
  //    (el LLM no marcó la promo, o una red determinista forzó paquetes). Se cambia el
  //    material: sigue saliendo UNA sola imagen, la que el cliente pidió.
  if (
    clientAsksForPromo &&
    !intents.includes(PROMO_INTENT) &&
    intents.includes(PACKAGES_INTENT)
  ) {
    intents.splice(intents.indexOf(PACKAGES_INTENT), 1, PROMO_INTENT);
    reasons.push("packages_swapped_for_promo");
  }

  // 6. El cliente pidió la promo y el turno se quedó SIN material (el LLM no marcó nada,
  //    o respondió con el turno de fallback). Se agrega la promo, pero solo si no hay
  //    material de otra línea en juego: un "¿tienen promo?" dentro de un flujo de cursos
  //    o de pago no se convierte en una promo de videos.
  //    Ojo: esto NO se salta la continuidad de contexto — el webhook aplica después la
  //    guarda de cambio de línea, que bloquea la promo si la conversación ya tiene otra
  //    línea abierta y el cliente no pidió cambiarse de forma explícita.
  if (clientAsksForPromo && intents.length === 0) {
    intents.push(PROMO_INTENT);
    reasons.push("promo_added_on_request");
  }

  return { intents, reasons };
}

// --- Ventana de reenvío de material -------------------------------------------------
//
// Dos políticas para no repetir material que el cliente ya recibió:
//
//   a) Dedup PERMANENTE (por defecto): una vez enviado a ese teléfono, nunca más.
//      Sirve para material que no cambia (video de ubicación).
//   b) Dedup por VENTANA: el material vuelve a salir recién pasadas N horas del último
//      envío. Es el caso del flyer de paquetes, cuyos precios cambian: quien vuelve a
//      escribir al día siguiente o a la semana debe ver el flyer nuevo, pero quien sigue
//      la misma conversación (respondiendo el formulario, preguntando por un paquete) no
//      debe recibir las mismas imágenes cada dos mensajes.
//      El QR de pago también: con dedup permanente, quien lo había recibido alguna vez
//      (por otro curso, o días atrás sin llegar a pagar) no volvía a recibirlo nunca. El
//      bot le escribía "te paso el QR" y no llegaba nada (15 casos en septiembre 2026).
//      Dentro de la hora lo tiene arriba en el chat y el bot se lo recuerda.
const MEDIA_RESEND_WINDOW_HOURS: Readonly<Record<string, number>> = {
  service_packages: 24,
  payment_qr: 1,
};

type MediaResendReason =
  | "forced"
  | "never_sent"
  | "window_expired"
  | "within_window"
  | "already_sent";

type MediaResendDecision = {
  send: boolean;
  reason: MediaResendReason;
  // Solo cuando hay envío previo y el intent tiene ventana. Para logs y auditoría.
  hoursSinceLastSent?: number;
  windowHours?: number;
};

// Función PURA: el instante y el último envío entran por parámetro (sin base, sin reloj
// propio), igual que resolvePromoIntents.
function shouldResendMedia(params: {
  intent: string;
  lastSentAt: Date | null;
  now: Date;
  force?: boolean;
}): MediaResendDecision {
  // Reenvío explícito pedido por el cliente: siempre gana.
  if (params.force) return { send: true, reason: "forced" };

  if (!params.lastSentAt) return { send: true, reason: "never_sent" };

  const windowHours = MEDIA_RESEND_WINDOW_HOURS[params.intent];

  // Sin ventana configurada: dedup permanente, el comportamiento histórico.
  if (windowHours === undefined) return { send: false, reason: "already_sent" };

  const hoursSinceLastSent =
    (params.now.getTime() - params.lastSentAt.getTime()) / 3_600_000;

  // Fecha futura o corrida por reloj: se trata como envío reciente (no reenviar).
  if (hoursSinceLastSent >= windowHours) {
    return { send: true, reason: "window_expired", hoursSinceLastSent, windowHours };
  }

  return { send: false, reason: "within_window", hoursSinceLastSent, windowHours };
}

export {
  asksForActivePromo,
  isCourseQuery,
  resolvePromoIntents,
  shouldResendMedia,
  MEDIA_RESEND_WINDOW_HOURS,
  PROMO_INTENT,
};
export type { MediaResendDecision, MediaResendReason, PromoResolution, PromoResolutionReason };

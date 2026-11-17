// A QUIÉN SE LE DA EL QR Y CON QUÉ TEXTO.
//
// Función PURA (sin red, sin base, sin reloj) para poder probar cada pedido de QR real.
//
// EL BUG QUE ORIGINÓ ESTE MÓDULO (28 oct – 31 oct 2026). Un cliente pidió el QR cuatro veces
// ("Qr", "No me llegó ningún qr", "No me sale qr", "El qr no dio nunca"). Como no había ningún
// curso con fecha, el backend apagaba el envío del QR, pero el texto del modelo seguía
// diciendo "Aquí tienes el QR 👇 [QR de Pago]". Nunca llegó nada y nadie del equipo se enteró.
//
// La regla de negocio (la define el dueño): el QR no es solo de cursos. Se pide también para
// pagar paquetes de videos u otros motivos. Lo que decide es el CONTEXTO de la conversación:
//
//   - Es para un curso y no hay curso vendible  → no se da el QR y se dice que no hay fechas.
//   - Es para un curso y hay curso vendible      → flujo de cursos de siempre.
//   - Es para paquetes u otro motivo             → se da el QR y se piden nombre, celular y
//                                                  motivo para etiquetar el pago.
//   - No se sabe para qué                        → se pregunta antes de mandar nada.

type QrPurpose = "course" | "other" | "unknown";

type QrRoutingAction =
  // El mensaje no pide el QR ni pagar: este módulo no interviene.
  | "none"
  // Curso con fecha a la venta: lo resuelve el flujo de cursos existente.
  | "course_flow"
  // Curso pedido, pero no hay nada que cobrar.
  | "deny_no_course"
  // Paquetes u otro motivo: el QR sale.
  | "send_other"
  // No se sabe si es curso o paquete: se pregunta.
  | "ask_purpose";

type QrRoutingInput = {
  // ¿El cliente pidió el QR o dijo que quiere pagar? (detectCoursePaymentRequest !== null)
  asksForQr: boolean;
  // El mensaje actual nombra un curso o la compra de su entrada.
  mentionsCourseNow: boolean;
  // El mensaje actual habla inequívocamente de paquetes de video.
  strongPackageNow: boolean;
  // La conversación está anclada en cursos.
  courseContext: boolean;
  // La conversación está anclada en otra línea: paquetes, formulario, promo de videos.
  otherLineContext: boolean;
  // Hay un curso a la venta con QR.
  courseSellable: boolean;
};

function resolveQrPurpose(input: Omit<QrRoutingInput, "asksForQr" | "courseSellable">): QrPurpose {
  // Lo que dice AHORA gana sobre el historial.
  if (input.strongPackageNow && !input.mentionsCourseNow) return "other";
  if (input.mentionsCourseNow) return "course";

  if (input.courseContext && input.otherLineContext) return "unknown";
  if (input.courseContext) return "course";
  if (input.otherLineContext) return "other";

  return "unknown";
}

function decideQrRouting(input: QrRoutingInput): { purpose: QrPurpose; action: QrRoutingAction } {
  const purpose = resolveQrPurpose(input);

  if (!input.asksForQr) return { purpose, action: "none" };

  if (purpose === "course") {
    return { purpose, action: input.courseSellable ? "course_flow" : "deny_no_course" };
  }
  if (purpose === "other") return { purpose, action: "send_other" };

  return { purpose, action: "ask_purpose" };
}

// Textos fijos. Salen tal cual: el modelo no los reescribe, así que no puede prometer un QR
// que no sale ni pegar un marcador entre corchetes.
const QR_OTHER_SENT_REPLY =
  "¡Claro! 😊 Te envío el QR de pago 👇 Cuando hagas el pago, mándame por aquí el comprobante junto con tu nombre completo, tu número de celular y el motivo del pago (por ejemplo, el paquete de videos).";

const QR_OTHER_ABOVE_REPLY =
  "¡Claro! 😊 El QR de pago está arriba en este chat 👆 Cuando hagas el pago, mándame por aquí el comprobante junto con tu nombre completo, tu número de celular y el motivo del pago.";

const QR_ASK_PURPOSE_REPLY =
  "¡Claro! 😊 Para pasarte lo correcto, ¿el pago es por un *curso* o por un *paquete de videos*?";

const WAITLIST_SENTENCE =
  "Dejamos anotado tu interés y te avisamos apenas haya una fecha nueva 🙌";

export {
  decideQrRouting,
  resolveQrPurpose,
  QR_OTHER_SENT_REPLY,
  QR_OTHER_ABOVE_REPLY,
  QR_ASK_PURPOSE_REPLY,
  WAITLIST_SENTENCE,
};
export type { QrPurpose, QrRoutingAction, QrRoutingInput };

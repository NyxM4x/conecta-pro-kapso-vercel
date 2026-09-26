// ¿ESTE CLIENTE ESTÁ PAGANDO AHORA MISMO?
//
// La red de seguridad `course_payer_data_not_a_lead` del webhook usa esta decisión para no
// confundir el nombre y celular de un alumno que acaba de pagar un curso con un lead de
// paquetes (le mandaba "un asesor ya tiene tus datos", disparaba la alerta 🟢 falsa y
// apagaba el bot 12 h).
//
// EL BUG QUE ORIGINÓ ESTE MÓDULO (26 de septiembre de 2026). La guarda bloqueó un lead
// legítimo de paquetes. El cliente venía perfecto por el flujo —vio los dos flyers, preguntó
// por estrategia de contenido, pidió dron sobre el paquete básico— y cuando el bot le ofreció
// tomarle los datos contestó "A ver". En vez del formulario recibió "Para el curso no necesito
// esos datos". Dos defectos se combinaron:
//
//   1. La señal de "hay un pago en curso" venía de `getMediaSentStatus(phone)`, que consulta
//      por TELÉFONO y SIN ventana de tiempo. A ese número le habían mandado el QR el 20 de
//      junio, tres meses antes y en otra conversación. El contexto de pago le quedaba
//      encendido para siempre. Eran 115 teléfonos en esa situación, 67 de ellos con el QR
//      enviado hacía más de 30 días.
//   2. La intención de paquetes se medía solo sobre el ÚLTIMO mensaje del cliente. "A ver"
//      no contiene ninguna palabra de paquetes, así que la conversación entera se leyó como
//      contexto de curso.
//
// La corrección: las señales DÉBILES (el QR enviado, los flyers de paquetes) solo cuentan si
// son recientes y de ESTA conversación. Las señales FUERTES —comprobante recibido, pago
// reconocido, alerta 💰 ya enviada, fase de datos del pagador— siguen valiendo igual, porque
// ahí sí hay un pago concreto sobre la mesa.

// Un pago se resuelve en minutos u horas, nunca en meses. Seis horas cubre al cliente que
// recibe el QR, va al banco y vuelve más tarde el mismo día.
const PAYMENT_CONTEXT_WINDOW_HOURS = 6;

// ¿Este envío sigue siendo "de ahora"?
function isWithinPaymentWindow(
  sentAt: Date | null | undefined,
  now: Date,
  windowHours: number = PAYMENT_CONTEXT_WINDOW_HOURS,
): boolean {
  if (!sentAt) return false;

  const sentMs = sentAt.getTime();
  if (!Number.isFinite(sentMs)) return false;

  const elapsed = now.getTime() - sentMs;
  // Un reloj del proveedor adelantado deja el envío "en el futuro": recién ocurrió.
  if (elapsed < 0) return true;

  return elapsed <= windowHours * 3_600_000;
}

type CoursePaymentContextInput = {
  // Señales FUERTES: hay un pago concreto en curso.
  payerDataPhase: boolean;
  receiptDetected: boolean;
  paymentAcknowledged: boolean;
  telegramPaymentSent: boolean;
  // Señales DÉBILES: sugieren pago, pero envejecen.
  paymentQrSentAt: Date | null;
  manualHumanMediaSent: boolean;
  // Contexto de paquetes, que descarta el de curso.
  explicitPackageIntent: boolean;
  packagesMediaSentAt: Date | null;
  intakeFormSent: boolean;
  officeVisitRequested: boolean;
  aiAgentFlyerSent: boolean;
  now: Date;
  windowHours?: number;
};

function isCoursePaymentContext(input: CoursePaymentContextInput): boolean {
  // El cliente está completando los datos de un pago concreto: no hay nada que discutir.
  if (input.payerDataPhase) return true;

  const windowHours = input.windowHours ?? PAYMENT_CONTEXT_WINDOW_HOURS;

  const paymentSignal =
    input.receiptDetected ||
    input.paymentAcknowledged ||
    input.telegramPaymentSent ||
    // Ya acotada a la conversación por hasManualHumanMediaBeenSent.
    input.manualHumanMediaSent ||
    isWithinPaymentWindow(input.paymentQrSentAt, input.now, windowHours);

  if (!paymentSignal) return false;

  // La conversación viene de paquetes: un "A ver" o un "dale" no pierde ese contexto por no
  // repetir la palabra "paquetes".
  const packagesFlowActive =
    input.explicitPackageIntent ||
    isWithinPaymentWindow(input.packagesMediaSentAt, input.now, windowHours);

  return (
    !input.intakeFormSent &&
    !packagesFlowActive &&
    !input.officeVisitRequested &&
    !input.aiAgentFlyerSent
  );
}

export { PAYMENT_CONTEXT_WINDOW_HOURS, isCoursePaymentContext, isWithinPaymentWindow };
export type { CoursePaymentContextInput };

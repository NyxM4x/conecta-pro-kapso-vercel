// Pruebas del contexto de pago de curso.
//
//   npm test            (usa el type-stripping nativo de Node, sin dependencias)
//
// Se protegen los dos lados, porque arreglar uno rompiendo el otro no sirve de nada:
//
//   A) El lead de paquetes que se perdió el 26 de septiembre de 2026: un QR de hace tres
//      meses no puede convertir una conversación de paquetes en uno de cursos.
//   B) Lo que la guarda existía para proteger: el alumno que manda su nombre y celular
//      después de pagar un curso NO es un lead de paquetes.

import assert from "node:assert/strict";
import { PAYMENT_CONTEXT_WINDOW_HOURS, isCoursePaymentContext, isWithinPaymentWindow } from "./payment-context.ts";

let passed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
  } catch (error) {
    failures.push(`${name}\n    ${(error as Error).message.split("\n")[0]}`);
  }
}

const NOW = new Date("2026-09-26T07:52:48Z");
const haceMinutos = (n: number) => new Date(NOW.getTime() - n * 60_000);
const haceHoras = (n: number) => new Date(NOW.getTime() - n * 3_600_000);

// Conversación limpia: ninguna señal encendida.
const BASE = {
  payerDataPhase: false,
  receiptDetected: false,
  paymentAcknowledged: false,
  telegramPaymentSent: false,
  paymentQrSentAt: null,
  manualHumanMediaSent: false,
  explicitPackageIntent: false,
  packagesMediaSentAt: null,
  intakeFormSent: false,
  officeVisitRequested: false,
  aiAgentFlyerSent: false,
  now: NOW,
};

// --- la ventana ---

test("un envío de hace minutos está dentro de la ventana", () => {
  assert.equal(isWithinPaymentWindow(haceMinutos(13), NOW), true);
});

test("un envío de hace tres meses no", () => {
  assert.equal(isWithinPaymentWindow(new Date("2026-06-20T18:54:00Z"), NOW), false);
});

test("justo en el borde de la ventana todavía cuenta", () => {
  assert.equal(isWithinPaymentWindow(haceHoras(PAYMENT_CONTEXT_WINDOW_HOURS), NOW), true);
});

test("un minuto después del borde ya no", () => {
  assert.equal(isWithinPaymentWindow(haceHoras(PAYMENT_CONTEXT_WINDOW_HOURS + 0.02), NOW), false);
});

test("sin fecha no hay ventana", () => {
  assert.equal(isWithinPaymentWindow(null, NOW), false);
});

test("un reloj adelantado no invalida el envío", () => {
  assert.equal(isWithinPaymentWindow(new Date(NOW.getTime() + 30_000), NOW), true);
});

// --- A) el lead que se perdió ---

test("el QR de hace tres meses NO crea contexto de pago", () => {
  // Caso exacto del 26 sep 2026: QR del 20 de junio, cliente contesta "A ver".
  assert.equal(
    isCoursePaymentContext({ ...BASE, paymentQrSentAt: new Date("2026-06-20T18:54:00Z") }),
    false,
  );
});

test("los flyers de paquetes recién enviados bloquean el contexto de curso", () => {
  // Aunque el QR sea reciente: la conversación es de paquetes.
  assert.equal(
    isCoursePaymentContext({
      ...BASE,
      paymentQrSentAt: haceMinutos(20),
      packagesMediaSentAt: haceMinutos(13),
    }),
    false,
  );
});

test('"A ver" no pierde el contexto de paquetes por no nombrarlos', () => {
  // explicitPackageIntent es false porque solo mira el último mensaje; los flyers salvan el caso.
  assert.equal(
    isCoursePaymentContext({
      ...BASE,
      explicitPackageIntent: false,
      packagesMediaSentAt: haceMinutos(13),
      telegramPaymentSent: true,
    }),
    false,
  );
});

test("sin ninguna señal de pago no hay contexto de curso", () => {
  assert.equal(isCoursePaymentContext({ ...BASE }), false);
});

// --- B) lo que la guarda protege ---

test("el comprobante recibido SÍ crea contexto de pago", () => {
  assert.equal(isCoursePaymentContext({ ...BASE, receiptDetected: true }), true);
});

test("la fase de datos del pagador manda por encima de todo", () => {
  // Aunque la conversación venga de paquetes: se están completando datos de un pago real.
  assert.equal(
    isCoursePaymentContext({ ...BASE, payerDataPhase: true, packagesMediaSentAt: haceMinutos(1) }),
    true,
  );
});

test("el QR recién enviado SÍ crea contexto de pago", () => {
  assert.equal(isCoursePaymentContext({ ...BASE, paymentQrSentAt: haceMinutos(10) }), true);
});

test("el pago reconocido y la alerta enviada también", () => {
  assert.equal(isCoursePaymentContext({ ...BASE, paymentAcknowledged: true }), true);
  assert.equal(isCoursePaymentContext({ ...BASE, telegramPaymentSent: true }), true);
});

test("el material mandado a mano cuenta, ya viene acotado a la conversación", () => {
  assert.equal(isCoursePaymentContext({ ...BASE, manualHumanMediaSent: true }), true);
});

// --- los descartes de siempre, que no se tocaron ---

test("con el formulario ya enviado no se bloquea nada", () => {
  assert.equal(isCoursePaymentContext({ ...BASE, receiptDetected: true, intakeFormSent: true }), false);
});

test("pedir visita a la oficina descarta el contexto de curso", () => {
  assert.equal(isCoursePaymentContext({ ...BASE, receiptDetected: true, officeVisitRequested: true }), false);
});

test("el flyer del agente de IA también lo descarta", () => {
  assert.equal(isCoursePaymentContext({ ...BASE, receiptDetected: true, aiAgentFlyerSent: true }), false);
});

test("una intención explícita de paquetes lo descarta", () => {
  assert.equal(isCoursePaymentContext({ ...BASE, receiptDetected: true, explicitPackageIntent: true }), false);
});

test("los flyers de paquetes viejos ya no protegen", () => {
  // Conversación de paquetes de ayer que hoy termina pagando un curso: la guarda vuelve a valer.
  assert.equal(
    isCoursePaymentContext({ ...BASE, receiptDetected: true, packagesMediaSentAt: haceHoras(30) }),
    true,
  );
});

console.log(`${passed} pruebas de contexto de pago OK`);

if (failures.length > 0) {
  console.error(`\n${failures.length} FALLARON:`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}

// Pruebas de "¿pagó un curso o el combo?" y de la alerta de Telegram corta.
//
//   npm test            (usa el type-stripping nativo de Node, sin dependencias)

import assert from "node:assert/strict";
import { buildPaymentEvidence, judgePaymentAmount, sanitizeAmount } from "./course-payment-check.ts";
import { COURSES } from "./courses.ts";
import { buildPaymentAlertText, extractPayerData, renderReceiptReply, resolvePaymentReason } from "./payment-alerts.ts";

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

const antes = new Date("2026-11-18T10:00:00-04:00"); // combo vigente
const entreCursos = new Date("2026-11-25T10:00:00-04:00"); // sin combo

// --- Monto ----------------------------------------------------------------------------

test("500 Bs con combo vigente = combo; 300 Bs = un curso", () => {
  assert.deepEqual(
    [judgePaymentAmount({ amount: 500, webChoice: null, now: antes }).status, judgePaymentAmount({ amount: 500, webChoice: null, now: antes }).bundle],
    ["ok", true],
  );
  const single = judgePaymentAmount({ amount: 300, webChoice: null, now: antes });
  assert.equal(single.status, "ok");
  assert.equal(single.bundle, false);
});

test("500 Bs sin combo vigente es el precio en puerta de UN curso, no un combo", () => {
  const verdict = judgePaymentAmount({ amount: 500, webChoice: null, now: entreCursos });
  assert.equal(verdict.bundle, false);
  assert.match(verdict.text, /puerta/);
});

test("el monto y el botón de la web se cruzan: si no coinciden, aviso", () => {
  assert.equal(judgePaymentAmount({ amount: 300, webChoice: "combo", now: antes }).status, "warn");
  assert.equal(judgePaymentAmount({ amount: 500, webChoice: "capcut_pro", now: antes }).status, "warn");
  assert.equal(judgePaymentAmount({ amount: 500, webChoice: "combo", now: antes }).status, "ok");
  assert.equal(judgePaymentAmount({ amount: 300, webChoice: "capcut_pro", now: antes }).status, "ok");
});

test("un monto raro o ilegible no se da por bueno", () => {
  assert.equal(judgePaymentAmount({ amount: 450, webChoice: null, now: antes }).status, "warn");
  assert.equal(judgePaymentAmount({ amount: null, webChoice: null, now: antes }).status, "unread");
  assert.equal(sanitizeAmount("abc"), null);
  assert.equal(sanitizeAmount(-5), null);
  assert.equal(sanitizeAmount(1e9), null);
  assert.equal(sanitizeAmount("500"), 500);
});

test("un comprobante por varias personas: 1000 Bs = 2 combos, 900 Bs = 3 cupos (20 nov 2026, 'de dos')", () => {
  const dosCombos = judgePaymentAmount({ amount: 1000, webChoice: null, now: antes });
  assert.deepEqual([dosCombos.status, dosCombos.bundle, dosCombos.seats], ["ok", true, 2]);
  assert.match(dosCombos.text, /2 combos/);

  const tresCupos = judgePaymentAmount({ amount: 900, webChoice: null, now: antes });
  assert.deepEqual([tresCupos.status, tresCupos.bundle, tresCupos.seats], ["ok", false, 3]);

  // 1500 son 3 combos o 5 cursos: no se adivina.
  const ambiguo = judgePaymentAmount({ amount: 1500, webChoice: null, now: antes });
  assert.deepEqual([ambiguo.status, ambiguo.bundle, ambiguo.seats], ["warn", null, null]);

  // Un pago suelto sigue siendo de una persona.
  assert.equal(judgePaymentAmount({ amount: 500, webChoice: null, now: antes }).seats, 1);
  // Un saldo de paquete (1750 Bs) no es un múltiplo de nada.
  assert.equal(judgePaymentAmount({ amount: 1750, webChoice: null, now: antes }).status, "warn");
});

// --- La evidencia decide la etiqueta del pago -------------------------------------------

const ofrecidos = COURSES.map((course) => ({ id: course.id, name: course.name, startsAt: course.startsAt }));
const reason = resolvePaymentReason({
  courseContext: true,
  courseMaterialSent: true,
  intakeFormSent: false,
  activeCourses: COURSES,
  recentMessages: [],
});

test("el comprobante de 500 Bs etiqueta el pago como combo aunque el cliente no lo diga", () => {
  const evidence = buildPaymentEvidence({ amount: 500, bank: "Banco FIE", operation: "123", webChoice: null, now: antes });
  const payer = extractPayerData(["Juan Carlos Pérez Rojas"], reason, evidence);
  assert.equal(payer.tag.kind, "course_bundle");
  assert.match(renderReceiptReply(reason, true, evidence), /combo/);
});

test("el botón de un curso en la web fija cuál curso es, sin preguntar", () => {
  const evidence = buildPaymentEvidence({ amount: 300, bank: null, operation: null, webChoice: "capcut_pro", now: antes });
  const payer = extractPayerData(["Juan Carlos Pérez Rojas"], reason, evidence);
  assert.equal(payer.tag.kind, "course");
});

// --- Alerta corta ---------------------------------------------------------------------

test("la alerta del combo es corta y lleva monto, banco, operación y link", () => {
  const evidence = buildPaymentEvidence({ amount: 500, bank: "Banco FIE", operation: "998877", webChoice: "combo", now: antes });
  const payer = extractPayerData(["Juan Carlos Pérez Rojas"], reason, evidence);
  const text = buildPaymentAlertText({
    phone: "59171234567",
    tag: payer.tag,
    names: payer.names,
    phones: payer.phones,
    motive: payer.motive,
    profileName: null,
    clientMessage: "texto largo del cliente que ya no se repite",
    evidence,
    timedOut: false,
  });
  assert.match(text, /Combo: los dos cursos/);
  assert.match(text, /✅ 500 Bs = combo/);
  assert.match(text, /Banco FIE · Op\. 998877/);
  assert.match(text, /tocó pagar el combo/);
  assert.match(text, /wa\.me\/59171234567/);
  assert.doesNotMatch(text, /texto largo del cliente/);
  assert.ok(text.split("\n").length <= 10, "debe ser corta");
  assert.equal(ofrecidos.length, 2);
});

if (failures.length > 0) {
  console.error(`course-payment-check: ${failures.length} falla(s)`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}

console.log(`course-payment-check: ${passed} pruebas OK`);

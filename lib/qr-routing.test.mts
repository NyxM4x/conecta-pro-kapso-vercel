// Pruebas del enrutado del QR y de las guardas de salida.
//
//   npm test            (usa el type-stripping nativo de Node, sin dependencias)
//
// Cada caso sale de una conversación real (oct–nov 2026) o de una regla del dueño.

import assert from "node:assert/strict";
import { decideQrRouting, QR_ASK_PURPOSE_REPLY, QR_OTHER_SENT_REPLY } from "./qr-routing.ts";
import {
  getActiveBundle,
  getActiveCourses,
  getInProgressCourses,
  hasSellableCourse,
  renderCourseContext,
  renderQrAmountNote,
} from "./courses.ts";
import { shouldBlockReceiptThanks, stripPlaceholderBrackets } from "./reply-guards.ts";

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

const base = {
  asksForQr: true,
  mentionsCourseNow: false,
  strongPackageNow: false,
  courseContext: false,
  otherLineContext: false,
  courseSellable: false,
};

// --- Enrutado del QR ------------------------------------------------------------------

test("'Qr' / 'Mándame' sin contexto: se pregunta el motivo, no se promete ningún QR", () => {
  const result = decideQrRouting(base);
  assert.equal(result.action, "ask_purpose");
  assert.ok(!/QR de pago 👇/.test(QR_ASK_PURPOSE_REPLY));
});

test("QR para un curso sin curso vendible: se niega", () => {
  assert.equal(
    decideQrRouting({ ...base, courseContext: true, courseSellable: false }).action,
    "deny_no_course",
  );
  assert.equal(
    decideQrRouting({ ...base, mentionsCourseNow: true }).action,
    "deny_no_course",
  );
});

test("QR para un curso con fecha a la venta: sigue el flujo de cursos de siempre", () => {
  assert.equal(
    decideQrRouting({ ...base, courseContext: true, courseSellable: true }).action,
    "course_flow",
  );
});

test("QR en conversación de paquetes: SE ENVÍA aunque no haya cursos", () => {
  assert.equal(
    decideQrRouting({ ...base, otherLineContext: true, courseSellable: false }).action,
    "send_other",
  );
});

test("'quiero pagar el paquete de 12': se envía aunque la conversación venga de cursos", () => {
  assert.equal(
    decideQrRouting({ ...base, strongPackageNow: true, courseContext: true }).action,
    "send_other",
  );
});

test("lo que dice ahora gana: 'quiero pagar el curso' tras ver paquetes es de curso", () => {
  const result = decideQrRouting({ ...base, mentionsCourseNow: true, otherLineContext: true });
  assert.equal(result.purpose, "course");
});

test("conversación con cursos Y paquetes, sin decir cuál: se pregunta", () => {
  assert.equal(
    decideQrRouting({ ...base, courseContext: true, otherLineContext: true }).action,
    "ask_purpose",
  );
});

test("sin pedir el QR no se interviene", () => {
  assert.equal(decideQrRouting({ ...base, asksForQr: false, otherLineContext: true }).action, "none");
});

test("el texto del QR de otros motivos pide nombre, celular y motivo", () => {
  assert.match(QR_OTHER_SENT_REPLY, /nombre completo/);
  assert.match(QR_OTHER_SENT_REPLY, /celular/);
  assert.match(QR_OTHER_SENT_REPLY, /motivo/);
});

// --- Filtro de corchetes --------------------------------------------------------------

test("quita '[QR de Pago]' del caso real", () => {
  const out = stripPlaceholderBrackets(
    "Aquí tienes el QR para que realices el pago 👇 [QR de Pago] Cuando lo hagas, mándame el comprobante 😊",
  );
  assert.ok(!out.includes("["));
  assert.ok(!out.includes("  "));
  assert.match(out, /Aquí tienes el QR para que realices el pago 👇 Cuando lo hagas/);
});

test("no toca puntos suspensivos, paréntesis, emojis ni links", () => {
  const text = "Bueno..... déjame ver (opcional) 😊 https://ejemplo.com/a?b=1";
  assert.equal(stripPlaceholderBrackets(text), text);
});

test("puntos suspensivos solos quedan intactos", () => {
  assert.equal(stripPlaceholderBrackets("Hola..... ¿cómo estás?...."), "Hola..... ¿cómo estás?....");
});

test("respeta los marcadores internos", () => {
  assert.equal(
    stripPlaceholderBrackets("[MEDIA_SENT:payment_qr] QR"),
    "[MEDIA_SENT:payment_qr] QR",
  );
});

// --- Plantilla de comprobante ---------------------------------------------------------

const thanks = "¡Gracias por el comprobante! 😊 Nuestro equipo va a validar el pago.";

test("'Gracias por el comprobante' sin comprobante en este turno se bloquea", () => {
  assert.equal(
    shouldBlockReceiptThanks({
      reply: thanks,
      receiptThisTurn: false,
      explicitPaymentPhrase: false,
      receiptMedia: false,
    }),
    true,
  );
});

test("con comprobante verificado, con imagen o con frase de pago NO se bloquea", () => {
  for (const flag of ["receiptThisTurn", "explicitPaymentPhrase", "receiptMedia"] as const) {
    assert.equal(
      shouldBlockReceiptThanks({
        reply: thanks,
        receiptThisTurn: false,
        explicitPaymentPhrase: false,
        receiptMedia: false,
        [flag]: true,
      }),
      false,
    );
  }
});

test("otras respuestas nunca se bloquean", () => {
  assert.equal(
    shouldBlockReceiptThanks({
      reply: "¡Hola! Somos ConectaPro😊",
      receiptThisTurn: false,
      explicitPaymentPhrase: false,
      receiptMedia: false,
    }),
    false,
  );
});

// --- Combo de los dos cursos (noviembre 2026) ----------------------------------------

const antes = new Date("2026-11-18T10:00:00-04:00");
const domingo22 = new Date("2026-11-22T10:00:00-04:00");
const cierre22 = new Date("2026-11-22T15:55:00-04:00");
const entreCursos = new Date("2026-11-25T10:00:00-04:00");

test("el combo de 500 Bs existe hasta 10 minutos antes del primer curso", () => {
  assert.equal(getActiveBundle(antes)?.price, 500);
  assert.equal(getActiveBundle(domingo22)?.price, 500, "el mismo domingo, antes del corte, todavía vale");
  assert.equal(getActiveBundle(cierre22), null, "cerrada la preventa del primero ya no hay combo");
  assert.equal(getActiveBundle(entreCursos), null, "pasado el primer curso nadie paga los dos juntos");
});

test("el monto que acompaña al QR dice un curso o el combo, y luego solo un curso", () => {
  assert.match(renderQrAmountNote(antes) ?? "", /300 Bs un curso, o 500 Bs los dos cursos/);
  assert.match(renderQrAmountNote(entreCursos) ?? "", /300 Bs/);
  assert.doesNotMatch(renderQrAmountNote(entreCursos) ?? "", /combo/);
  assert.equal(renderQrAmountNote(new Date("2026-11-29T15:55:00-04:00")), null);
});

test("el contexto del bot trae el combo mientras existe y lo quita después", () => {
  assert.match(renderCourseContext(antes), /COMBO VIGENTE/);
  assert.doesNotMatch(renderCourseContext(entreCursos), /COMBO VIGENTE/);
});

// --- Domingo 22: gente que llega tarde o escribe a media clase -----------------------

test("el domingo 22 pasadas las 16:00 el curso 1 sigue 'en marcha' hasta las 21:30", () => {
  for (const hora of ["16:05", "17:45", "20:30", "21:29"]) {
    const ahora = new Date(`2026-11-22T${hora}:00-04:00`);
    assert.deepEqual(getInProgressCourses(ahora).map((c) => c.id), ["creacion_contenido"], hora);
    assert.deepEqual(getActiveCourses(ahora).map((c) => c.id), ["capcut_pro"], hora);
  }
});

test("a media clase el bot informa (ubicación y duración), no vende el curso en marcha", () => {
  const context = renderCourseContext(new Date("2026-11-22T17:45:00-04:00"));
  assert.match(context, /SE ESTÁN DICTANDO AHORA MISMO/);
  assert.match(context, /Creación de Contenido — HOY, empezó a las/);
  assert.match(context, /cuánto dura \(de 4 a 5 horas/);
  assert.match(context, /NUNCA digas que la fecha ya pasó/);
  // A quien no pagó se le ofrece la lista de espera, ya no TikTok.
  assert.match(context, /LISTA DE ESPERA/);
  assert.doesNotMatch(context.split("Edición de Videos")[0], /seguirnos en TikTok como @marketero7 para enterarse/);
  // El curso 2 sigue a la venta, sin combo.
  assert.match(context, /Edición de Videos Personalizada/);
  assert.doesNotMatch(context, /COMBO VIGENTE/);
  assert.equal(hasSellableCourse(new Date("2026-11-22T17:45:00-04:00")), true);
});

test("el lunes 23 el curso 1 ya no existe: solo se menciona el curso 2", () => {
  const ahora = new Date("2026-11-23T10:00:00-04:00");
  assert.deepEqual(getInProgressCourses(ahora), []);
  const context = renderCourseContext(ahora);
  assert.match(context, /Edición de Videos Personalizada/);
  assert.match(context, /Cursos SIN fecha vigente[\s\S]*Creación de Contenido/);
});

if (failures.length > 0) {
  console.error(`qr-routing: ${failures.length} falla(s)`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}

console.log(`qr-routing: ${passed} pruebas OK`);

// Pruebas de la alerta 💰 etiquetada (lib/payment-alerts.ts): qué se le pide al cliente, cómo
// se leen sus datos y cómo sale la alerta. La lista de /pagos tiene su propio test.
//
//   npm test            (usa el type-stripping nativo de Node, sin dependencias)
//
// Los mensajes de cliente son reales (chats de septiembre 2026), salvo que diga lo contrario.

import assert from "node:assert/strict";
import {
  buildPaymentAlertText,
  describeMissingPayerData,
  extractPayerData,
  isPayerDataComplete,
  renderMissingPayerDataReply,
  renderReceiptReply,
  resolvePaymentReason,
  toCourseRef,
} from "./payment-alerts.ts";
import type { PaymentReason } from "./payment-alerts.ts";
import { COURSES, detectMentionedCourses } from "./courses.ts";
import type { Course } from "./courses.ts";

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

// Dos fechas a la venta a la vez (los ids son los del catálogo real, para usar sus alias).
const catalog = (id: string) => COURSES.find((course) => course.id === id) as Course;
const CONTENIDO: Course = { ...catalog("creacion_contenido"), startsAt: "2026-10-04T16:00:00-04:00" };
const CAPCUT: Course = { ...catalog("capcut_pro"), startsAt: "2026-10-11T16:00:00-04:00" };
const DOS_CURSOS = [CONTENIDO, CAPCUT];

const reasonFor = (overrides: Partial<Parameters<typeof resolvePaymentReason>[0]>): PaymentReason =>
  resolvePaymentReason({
    courseContext: false,
    courseMaterialSent: false,
    intakeFormSent: false,
    activeCourses: DOS_CURSOS,
    recentMessages: [],
    ...overrides,
  });

// --- ¿De qué curso habla? ----------------------------------------------------

test("reconoce el curso por su nombre o por su día, no por un número suelto", () => {
  assert.deepEqual(detectMentionedCourses("es para el de capcut", DOS_CURSOS).map((c) => c.id), ["capcut_pro"]);
  assert.deepEqual(detectMentionedCourses("el curso de creación de contenido", DOS_CURSOS).map((c) => c.id), ["creacion_contenido"]);
  assert.deepEqual(detectMentionedCourses("el del domingo 11", DOS_CURSOS).map((c) => c.id), ["capcut_pro"]);
  assert.deepEqual(detectMentionedCourses("para el curso", DOS_CURSOS), []);
  assert.deepEqual(detectMentionedCourses("te pagué 450", DOS_CURSOS), []);
});

// --- ¿Por qué pagó? ------------------------------------------------------------

test("con un solo curso a la venta no hay nada que preguntar", () => {
  const reason = reasonFor({ courseContext: true, activeCourses: [CAPCUT] });
  assert.equal(reason.kind, "course");
});

test("con dos fechas, el curso del que habló el cliente decide", () => {
  const reason = reasonFor({
    courseMaterialSent: true,
    recentMessages: [
      { role: "assistant", content: "Tenemos el Curso de Creación de Contenido y el de Edición Persuasiva en CapCut Pro" },
      { role: "user", content: "Me interesa el de capcut" },
    ],
  });
  assert.equal(reason.kind, "course");
  assert.equal(reason.kind === "course" && reason.course.id, "capcut_pro");
});

test("con dos fechas y el bot nombrando las dos, no se sabe cuál", () => {
  const reason = reasonFor({
    courseContext: true,
    recentMessages: [
      { role: "assistant", content: "Tenemos el Curso de Creación de Contenido y el de Edición Persuasiva en CapCut Pro" },
      { role: "user", content: "Si esta bien me pasa su qr" },
    ],
  });
  assert.equal(reason.kind, "course_unknown");
});

test("formulario de paquetes sin conversación de cursos → paquete", () => {
  assert.equal(reasonFor({ intakeFormSent: true }).kind, "packages");
  // Pero si la conversación está en cursos, es un curso aunque haya llenado el formulario antes.
  assert.equal(reasonFor({ intakeFormSent: true, courseContext: true, activeCourses: [CAPCUT] }).kind, "course");
});

test("sin QR, sin formulario y sin hablar de cursos → motivo desconocido", () => {
  assert.equal(reasonFor({}).kind, "unknown");
});

// --- Datos que manda el cliente ------------------------------------------------

test("el caso real: nombre y celular después del comprobante completan un pago de curso", () => {
  const reason = reasonFor({ courseContext: true, activeCourses: [CAPCUT] });
  const data = extractPayerData(["📷 Imagen recibida\nEl comprobante", "Aleida Patricia Trujillo Rivera \nTel:68652085"], reason);
  assert.deepEqual(data.names, ["Aleida Patricia Trujillo Rivera"]);
  assert.deepEqual(data.phones, ["68652085"]);
  assert.equal(data.tag.kind, "course");
  assert.equal(isPayerDataComplete(reason, data), true);
});

test("solo el comprobante: falta el nombre", () => {
  const reason = reasonFor({ courseContext: true, activeCourses: [CAPCUT] });
  const data = extractPayerData(["📷 Imagen recibida", "El comprobante"], reason);
  assert.equal(isPayerDataComplete(reason, data), false);
  assert.deepEqual(describeMissingPayerData(reason, data), ["tu nombre completo"]);
});

test("dos fechas: con el nombre pero sin el curso todavía falta el curso", () => {
  const reason = reasonFor({ courseContext: true });
  const soloNombre = extractPayerData(["Carla Brigitte Zeitum Herrera"], reason);
  assert.equal(isPayerDataComplete(reason, soloNombre), false);
  assert.match(renderMissingPayerDataReply(reason, soloNombre), /para cuál curso es/);

  const conCurso = extractPayerData(["Carla Brigitte Zeitum Herrera", "es para el de capcut"], reason);
  assert.equal(isPayerDataComplete(reason, conCurso), true);
  assert.equal(conCurso.tag.kind === "course" && conCurso.tag.courseId, "capcut_pro");
  // La etiqueta lleva la fecha que se le ofreció.
  assert.equal(conCurso.tag.kind === "course" && conCurso.tag.courseStartsAt, CAPCUT.startsAt);
});

test("motivo desconocido: el cliente dice que es por un paquete", () => {
  const reason = reasonFor({});
  const data = extractPayerData(["Juan Carlos Rojas Pérez 71234567", "adelanto del paquete de 12 videos"], reason);
  assert.equal(data.tag.kind, "packages");
  assert.equal(isPayerDataComplete(reason, data), true);
});

test("motivo desconocido: un motivo libre queda como 'otro' con su texto", () => {
  const reason = reasonFor({});
  const data = extractPayerData(["María Estefani Gómez", "es por la asesoría que me dieron"], reason);
  assert.equal(data.tag.kind, "other");
  assert.equal(data.motive, "es por la asesoría que me dieron");
  assert.equal(isPayerDataComplete(reason, data), true);
});

test("una pregunta o un relleno no son el motivo del pago", () => {
  const reason = reasonFor({});
  const data = extractPayerData(["María Estefani Gómez", "¿a qué hora es?", "Listo, ahí está el comprobante", "gracias"], reason);
  assert.equal(data.motive, null);
  assert.equal(data.tag.kind, "unknown");
  assert.equal(isPayerDataComplete(reason, data), false);
});

// --- Lo que se le responde al cliente -------------------------------------------

test("al comprobante se le pide solo lo que falta", () => {
  const course: PaymentReason = { kind: "course", course: toCourseRef(CAPCUT) };
  assert.match(renderReceiptReply(course, false), /nombre completo .* número de teléfono/);
  assert.doesNotMatch(renderReceiptReply(course, false), /motivo/i);
  // Ya mandó el nombre junto con la foto: no se le vuelve a pedir.
  assert.doesNotMatch(renderReceiptReply(course, true), /nombre/);

  const unknownCourse: PaymentReason = { kind: "course_unknown", options: DOS_CURSOS.map(toCourseRef) };
  const askCourse = renderReceiptReply(unknownCourse, false);
  assert.match(askCourse, /¿Para cuál curso es\? Creación de Contenido \(04\/10\) o Edición Persuasiva en CapCut Pro \(11\/10\)/);

  const unknown: PaymentReason = { kind: "unknown", options: DOS_CURSOS.map(toCourseRef) };
  const askMotive = renderReceiptReply(unknown, false);
  assert.match(askMotive, /📌 Tu nombre completo\n📌 Tu número de celular\n📌 El motivo del pago/);

  assert.match(renderReceiptReply({ kind: "packages" }, false), /un asesor se comunicará contigo/);
});

// --- La alerta a Telegram ---------------------------------------------------------

test("la alerta lleva la etiqueta, el nombre, el celular y el link al chat", () => {
  const text = buildPaymentAlertText({
    phone: "59168652085",
    tag: { kind: "course", courseId: "capcut_pro", courseName: CAPCUT.name, courseStartsAt: CAPCUT.startsAt },
    names: ["Aleida Patricia Trujillo Rivera"],
    phones: ["68652085"],
    motive: null,
    profileName: null,
    clientMessage: "Aleida Patricia Trujillo Rivera\nTel:68652085",
    timedOut: false,
  });
  assert.match(text, /🏷️ <b>🎓 Curso de Edición Persuasiva en CapCut Pro — 11\/10<\/b>/);
  assert.match(text, /👤 Aleida Patricia Trujillo Rivera/);
  assert.match(text, /📱 68652085/);
  assert.match(text, /wa\.me\/59168652085/);
  assert.doesNotMatch(text, /No mandó sus datos/);
});

test("si no respondió en 20 min sale con el nombre de WhatsApp y lo avisa", () => {
  const text = buildPaymentAlertText({
    phone: "59177000000",
    tag: { kind: "course_unknown", options: DOS_CURSOS.map(toCourseRef) },
    names: [],
    phones: [],
    motive: null,
    profileName: "Carla <Z>",
    clientMessage: "📷 Imagen recibida",
    timedOut: true,
  });
  assert.match(text, /no se sabe cuál/);
  assert.match(text, /Carla &lt;Z&gt; <i>\(nombre de WhatsApp\)<\/i>/);
  assert.match(text, /No mandó sus datos en 20 min/);
});

console.log(`${passed} pruebas de alertas de pago OK`);

if (failures.length > 0) {
  console.error(`\n${failures.length} FALLARON:`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}

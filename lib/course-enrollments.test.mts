// Pruebas del botón "🎓 Inscritos del curso".
//
//   npm test            (usa el type-stripping nativo de Node, sin dependencias)
//
// Lo que se protege: que salgan TODOS los que pagaron el curso (aunque el bot no lo haya
// confirmado), que no se cuelen pagos de paquetes, y que el nombre y el celular que el alumno
// escribió se lean bien. Los textos de prueba son mensajes reales de septiembre de 2026.

import assert from "node:assert/strict";
import {
  buildCourseEnrollments,
  extractContactLines,
  getEnrollmentWindow,
  listReportableCourses,
  renderCourseEnrollments,
} from "./course-enrollments.ts";
import { COURSES } from "./courses.ts";
import type { Course } from "./courses.ts";
import type { PaymentEntry } from "./payments-report.ts";
import { chunkTelegramBlocks } from "./telegram.ts";

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

const payment = (over: Partial<PaymentEntry>): PaymentEntry => ({
  category: over.category ?? "confirmed",
  phone: over.phone ?? "59167293748",
  firstAt: over.firstAt ?? "2026-09-10T15:43:03Z",
  lastAt: over.lastAt ?? over.firstAt ?? "2026-09-10T15:43:03Z",
  kinds: over.kinds ?? { images: 1, documents: 0, texts: 0 },
  context: over.context ?? "🎓 Curso (se le envió el QR)",
  alerted: over.alerted ?? true,
  detail: over.detail ?? "",
});

const CURSO: Course = {
  id: "creacion_contenido",
  name: "Curso de Creación de Contenido",
  startsAt: "2026-09-13T16:00:00-04:00",
  pricePreventa: 300,
  pricePresencial: 450,
};
const CAPCUT: Course = { ...CURSO, id: "capcut_pro", name: "Curso de Edición en CapCut Pro", startsAt: "2026-08-16T16:00:00-04:00" };

// --- Nombre y celular -------------------------------------------------------

test("lee nombre y celular escritos juntos o en líneas separadas", () => {
  assert.deepEqual(extractContactLines("Carla Brigitte Zeitum Herrera \n67293748"), {
    names: ["Carla Brigitte Zeitum Herrera"],
    phones: ["67293748"],
  });
  assert.deepEqual(extractContactLines("Yoselin flores Peñaranda \nNúmero: 60967636"), {
    names: ["Yoselin flores Peñaranda"],
    phones: ["60967636"],
  });
});

test("un mensaje puede traer a dos inscritos", () => {
  assert.deepEqual(extractContactLines("Joryelina palma\nSusana Galean").names, [
    "Joryelina palma",
    "Susana Galean",
  ]);
  assert.deepEqual(
    extractContactLines("Guisselly Micaela Padilla Hinojoza \n Michael Basto Egue").names,
    ["Guisselly Micaela Padilla Hinojoza", "Michael Basto Egue"],
  );
});

test("quita prefijos y muletillas antes del nombre", () => {
  assert.deepEqual(extractContactLines("Nombre completo: Paola Britha Domínguez").names, ["Paola Britha Domínguez"]);
  assert.deepEqual(extractContactLines("Si Maria Estefani").names, ["Maria Estefani"]);
  assert.deepEqual(extractContactLines("Cel: 7654 3210").phones, ["76543210"]);
  assert.deepEqual(extractContactLines("+591 71234567").phones, ["71234567"]);
});

test("una frase de conversación no es un nombre", () => {
  for (const frase of [
    "Buenas tardes",
    "Ya muchas gracias",
    "Es mañana a las 4pm no",
    "Me pasa su Qr",
    "Pasando las clases yo pague pero mi hija es Dulce América Iporre Arce",
    "📷 Imagen recibida",
    "Ok",
    "O la china",
    "Drjara d",
    "debe salir",
    "Vengo del live",
    "Nadie se contacto conmigo",
  ]) {
    assert.deepEqual(extractContactLines(frase).names, [], frase);
  }
});

// --- Armado de la lista -----------------------------------------------------

test("junta pagos del mismo alumno y le pega los nombres que mandó después", () => {
  const enrollments = buildCourseEnrollments({
    payments: [payment({})],
    texts: [
      { phone: "59167293748", content: "Voy a querer 2 cupos porfa", createdAt: "2026-09-10T15:41:41Z" },
      { phone: "59167293748", content: "Carla Brigitte Zeitum Herrera \n67293748", createdAt: "2026-09-10T15:43:03Z" },
      { phone: "59167293748", content: "Paola Britha Domínguez", createdAt: "2026-09-10T15:53:57Z" },
    ],
    profileNames: new Map(),
  });

  assert.equal(enrollments.length, 1);
  assert.equal(enrollments[0].status, "confirmed");
  assert.deepEqual(enrollments[0].names, ["Carla Brigitte Zeitum Herrera", "Paola Britha Domínguez"]);
});

test("los pagos de paquetes o sin relación con el curso no se cuelan", () => {
  const enrollments = buildCourseEnrollments({
    payments: [
      payment({ phone: "1", context: "🎬 Paquetes (llenó/recibió formulario)" }),
      payment({ phone: "2", context: "🤖 Agente de IA" }),
      payment({ phone: "3", context: "❔ Sin contexto", category: "review", detail: '💬 "ya pagué"' }),
      payment({ phone: "4", category: "discarded" }),
      payment({ phone: "5", context: "❔ Sin contexto", category: "confirmed", detail: '💬 "ayer cancele para los cursos del domingo"' }),
    ],
    texts: [],
    profileNames: new Map(),
  });

  assert.deepEqual(enrollments.map((e) => e.phone), ["5"]);
});

test("con QR mandado a mano, el pago sin confirmar entra solo si escribió un nombre", () => {
  const manual = { context: "❔ Material enviado a mano (revisar)", category: "review" as const, alerted: false };
  const enrollments = buildCourseEnrollments({
    payments: [
      payment({ ...manual, phone: "59176382308", firstAt: "2026-09-13T16:50:30Z" }),
      payment({ ...manual, phone: "59177853325", firstAt: "2026-08-27T22:13:00Z" }),
    ],
    texts: [
      { phone: "59176382308", content: "Guisselly Micaela Padilla Hinojoza \n Michael Basto Egue", createdAt: "2026-09-13T16:50:30Z" },
      { phone: "59177853325", content: "Me sale en rojo", createdAt: "2026-08-27T22:13:00Z" },
    ],
    profileNames: new Map(),
  });

  assert.deepEqual(enrollments.map((e) => e.phone), ["59176382308"]);
});

test("un comprobante que el bot no confirmó queda en 'por revisar', no se pierde", () => {
  const enrollments = buildCourseEnrollments({
    payments: [payment({ category: "review", alerted: false, detail: "🧾 Sin verificar" })],
    texts: [],
    profileNames: new Map([["59167293748", "Carla Z."]]),
  });

  assert.equal(enrollments[0].status, "review");
  const text = renderCourseEnrollments({ course: CURSO, enrollments }).join("\n");
  assert.match(text, /Por revisar/);
  assert.match(text, /perfil: Carla Z\./);
});

// --- Fechas -----------------------------------------------------------------

test("la ventana de pagos arranca cuando terminó el curso anterior", () => {
  const { sinceIso, untilIso } = getEnrollmentWindow(CURSO, [CURSO, CAPCUT]);
  assert.equal(sinceIso, new Date("2026-08-16T17:30:00-04:00").toISOString());
  assert.equal(untilIso, new Date("2026-09-15T16:00:00-04:00").toISOString());
});

test("sin curso anterior cercano, la ventana es de 35 días", () => {
  const { sinceIso } = getEnrollmentWindow(CURSO, [CURSO]);
  assert.equal(sinceIso, new Date(new Date(CURSO.startsAt).getTime() - 35 * 24 * 3600_000).toISOString());
});

test("el botón ofrece cursos próximos o dictados en las últimas 2 semanas", () => {
  // Sobre cada curso REAL del catálogo, con su propia fecha: sigue valiendo cuando cambian.
  const DIA = 24 * 3600_000;
  for (const course of COURSES) {
    const inicio = new Date(course.startsAt).getTime();
    assert.ok(listReportableCourses(new Date(inicio - DIA)).includes(course), `${course.name}: próximo`);
    assert.ok(listReportableCourses(new Date(inicio + 13 * DIA)).includes(course), `${course.name}: hace 13 días`);
    assert.ok(!listReportableCourses(new Date(inicio + 15 * DIA)).includes(course), `${course.name}: hace 15 días`);
  }
});

// --- Mensajes de Telegram ---------------------------------------------------

test("la lista larga se parte sin cortar a ningún inscrito", () => {
  const enrollments = buildCourseEnrollments({
    payments: Array.from({ length: 90 }, (_, i) =>
      payment({ phone: `5916${String(i).padStart(7, "0")}`, firstAt: new Date(Date.UTC(2026, 8, 1, 12, i)).toISOString() }),
    ),
    texts: [],
    profileNames: new Map(),
  });
  const chunks = chunkTelegramBlocks(renderCourseEnrollments({ course: CURSO, enrollments }));

  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= 4096);
  assert.equal((chunks.join("\n").match(/abrir chat/g) ?? []).length, 90);
});

console.log(`${passed} pruebas de inscritos OK`);

if (failures.length > 0) {
  console.error(`\n${failures.length} FALLARON:`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}

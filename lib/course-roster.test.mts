// Pruebas de /inscritos, /porcobrar y /espera (lib/course-roster.ts).
//
//   npm test            (usa el type-stripping nativo de Node, sin dependencias)
//
// Lo que se protege: que cada pago sume a SU curso y edición, con los cupos que paga (1000 Bs de
// combo son dos personas); que lo que el bot no supo asignar quede aparte con botones y no
// sume hasta que el equipo diga de qué es; que la elección y la nota del equipo manden, se vean
// también en /pagos y se puedan cambiar; y que quien tocó pagar sin mandar comprobante salga en
// su propia lista.

import assert from "node:assert/strict";
import {
  applyTeamCorrections,
  buildCourseRoster,
  isValidChoice,
  parseRosterCallback,
  renderAssignmentResult,
  renderCourseRoster,
  renderCourseWaitlist,
  renderPendingPayments,
  shortKeyOf,
} from "./course-roster.ts";
import type { CourseIntent, RosterCorrection, RosterCourse, RosterMessage } from "./course-roster.ts";
import { renderPaymentsLedger } from "./payments-ledger.ts";
import type { LedgerEntry } from "./payments-ledger.ts";

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

const NOW = new Date("2026-11-21T14:00:00-04:00"); // sábado, víspera del primer curso

const CREACION: RosterCourse = {
  id: "creacion_contenido",
  name: "Curso de Creación de Contenido",
  startsAt: "2026-11-22T16:00:00-04:00",
  pricePreventa: 300,
  pricePresencial: 500,
};
const EDICION: RosterCourse = {
  id: "capcut_pro",
  name: "Curso de Edición de Videos Personalizada",
  startsAt: "2026-11-29T16:00:00-04:00",
  pricePreventa: 300,
  pricePresencial: 500,
};
const COURSES = [CREACION, EDICION];
const BUNDLE = { price: 500, courseIds: ["creacion_contenido", "capcut_pro"] };
const OPTIONS = COURSES.map(({ id, name, startsAt }) => ({ id, name, startsAt }));
const RENDER = { courses: COURSES, bundle: BUNDLE, now: NOW };

let seq = 0;
const entry = (over: Partial<LedgerEntry>): LedgerEntry => ({
  phone: "59170000001",
  status: "confirmed",
  paidAt: "2026-11-19T15:00:00Z",
  alerted: true,
  names: [],
  phones: [],
  profileName: null,
  tag: null,
  motive: null,
  context: "🎓 Curso (se le envió el QR)",
  evidence: "",
  messageIds: [`wamid.TEST${++seq}`],
  amount: null,
  ...over,
});

const build = (params: {
  entries: LedgerEntry[];
  corrections?: RosterCorrection[];
  intents?: CourseIntent[];
  now?: Date;
}) =>
  buildCourseRoster({
    entries: params.entries,
    corrections: params.corrections ?? [],
    intents: params.intents ?? [],
    profileNames: new Map([["59170000009", "Perfil Nueve"]]),
    courses: COURSES,
    bundle: BUNDLE,
    now: params.now ?? NOW,
  });

const courseOf = (roster: ReturnType<typeof build>, id: string) => roster.courses.find((c) => c.course.id === id)!;
const textOf = (messages: RosterMessage[]) => messages.map((m) => m.blocks.join("\n")).join("\n");
const assignMessages = (messages: RosterMessage[]) =>
  messages.filter((m) => m.keyboard?.inline_keyboard.flat().some((b) => b.callback_data.startsWith("ins:")));
const correction = (key: string, choice: string, over: Partial<RosterCorrection> = {}): RosterCorrection => ({
  key,
  choice,
  createdAt: "2026-11-21T12:00:00Z",
  by: null,
  ...over,
});

const UNKNOWN = { kind: "course_unknown" as const, options: OPTIONS };
const TAG_CREACION = { kind: "course" as const, courseId: "creacion_contenido", courseName: CREACION.name, courseStartsAt: CREACION.startsAt };
const TAG_EDICION = { kind: "course" as const, courseId: "capcut_pro", courseName: EDICION.name, courseStartsAt: EDICION.startsAt };

// --- Asignación automática ---------------------------------------------------------------

test("un pago etiquetado con el curso suma 1 inscrito a ese curso, con su nombre", () => {
  const roster = build({ entries: [entry({ tag: TAG_CREACION, names: ["Ana María Pérez"], amount: 300 })] });
  const creacion = courseOf(roster, "creacion_contenido");
  assert.equal(creacion.seats, 1);
  assert.equal(creacion.rows[0].names[0], "Ana María Pérez");
  assert.equal(courseOf(roster, "capcut_pro").seats, 0);
  assert.equal(roster.unassigned.length, 0);
});

test("el combo de 1000 Bs son 2 inscritos en CADA curso, y avisa si mandó 3 nombres", () => {
  const roster = build({
    entries: [
      entry({
        tag: { kind: "course_bundle", options: OPTIONS },
        names: ["Jherzid David García Tapia", "David García Impa", "Paula Rivero Bilbao"],
        amount: 1000,
      }),
    ],
  });
  assert.equal(courseOf(roster, "creacion_contenido").seats, 2);
  assert.equal(courseOf(roster, "capcut_pro").seats, 2);
  const row = courseOf(roster, "creacion_contenido").rows[0];
  assert.ok(row.combo);
  assert.ok(row.warnings.some((w) => w.includes("3 nombres para 2 cupos")), row.warnings.join(" | "));
});

test("sin monto, cuentan los nombres; un abono menor al precio es 1 cupo con aviso", () => {
  const roster = build({
    entries: [
      entry({ tag: TAG_EDICION, names: ["Joryelina Palma", "Susana Galean"], amount: null }),
      entry({ tag: TAG_EDICION, names: ["Luis Rojas Vaca"], amount: 100, phone: "59170000002" }),
    ],
  });
  const edicion = courseOf(roster, "capcut_pro");
  assert.equal(edicion.seats, 3);
  assert.ok(edicion.rows[1].warnings.some((w) => w.includes("Abonó 100 de 300")));
});

test("un pago de otra edición del curso (septiembre) o de paquetes no entra", () => {
  const roster = build({
    entries: [
      entry({ tag: { ...TAG_EDICION, courseStartsAt: "2026-09-20T16:00:00-04:00" } }),
      entry({ tag: { kind: "packages" }, amount: 2500 }),
    ],
  });
  assert.equal(courseOf(roster, "capcut_pro").seats, 0);
  assert.equal(roster.unassigned.length, 0);
});

// --- Por asignar ---------------------------------------------------------------------------

test("'no se sabe cuál curso' queda por asignar, no suma, y trae la pista del monto", () => {
  const roster = build({ entries: [entry({ tag: UNKNOWN, amount: 1000 })] });
  assert.equal(roster.unassigned.length, 1);
  assert.equal(courseOf(roster, "creacion_contenido").seats, 0);
  assert.match(roster.unassigned[0].hint ?? "", /2 combos/);
});

test("un saldo de paquete marcado como curso (1750 Bs) dice que no coincide con los precios", () => {
  const roster = build({ entries: [entry({ tag: UNKNOWN, amount: 1750 })] });
  assert.match(roster.unassigned[0].hint ?? "", /no coincide/);
});

test("'no se sabe cuál' de cuando no había fechas (sin opciones) no entra", () => {
  const roster = build({ entries: [entry({ tag: { kind: "course_unknown", options: [] } })] });
  assert.equal(roster.unassigned.length, 0);
});

test("un archivo sin alerta en un chat de cursos entra por asignar solo si es reciente", () => {
  const roster = build({
    entries: [
      entry({ tag: null, status: "review", alerted: false, paidAt: "2026-11-20T15:00:00Z" }),
      entry({ tag: null, status: "review", alerted: false, paidAt: "2026-10-20T15:00:00Z" }),
      entry({ tag: null, context: "🎬 Paquetes (llenó/recibió formulario)" }),
    ],
  });
  assert.equal(roster.unassigned.length, 1);
});

// --- Lo que decide el equipo -----------------------------------------------------------------

test("el equipo asigna el combo: pasa a los dos cursos con los cupos del monto", () => {
  const pago = entry({ tag: UNKNOWN, amount: 1000, names: ["Paula Rivero Bilbao"] });
  const roster = build({ entries: [pago], corrections: [correction(pago.messageIds[0], "combo", { by: "José" })] });
  assert.equal(roster.unassigned.length, 0);
  assert.equal(courseOf(roster, "creacion_contenido").seats, 2);
  assert.equal(courseOf(roster, "capcut_pro").rows[0].source, "team");
});

test("la nota del equipo es el contexto del pago y reemplaza los avisos automáticos", () => {
  const pago = entry({ tag: UNKNOWN, amount: 1000, names: ["A Uno Dos", "B Tres Cuatro", "C Cinco Seis"] });
  const roster = build({
    entries: [pago],
    corrections: [correction(pago.messageIds[0], "combo", { note: "Pagó 'de dos'; confirmar a la tercera" })],
  });
  const text = textOf(renderCourseRoster(roster, RENDER));
  assert.ok(text.includes("📝 Pagó 'de dos'; confirmar a la tercera"));
  assert.ok(!text.includes("3 nombres para 2 cupos"));
});

test("un botón posterior sin nota no borra la nota escrita antes", () => {
  const pago = entry({ tag: UNKNOWN, amount: 300 });
  const key = pago.messageIds[0];
  const roster = build({
    entries: [pago],
    corrections: [
      correction(key, "combo", { note: "Revisado a mano", createdAt: "2026-11-21T12:00:00Z" }),
      correction(key, "capcut_pro", { createdAt: "2026-11-21T12:05:00Z" }),
    ],
  });
  assert.equal(courseOf(roster, "capcut_pro").rows[0].note, "Revisado a mano");
  assert.equal(courseOf(roster, "creacion_contenido").rows.length, 0);
});

test("paquete o 'no es pago de curso' lo sacan de los cursos, y se puede corregir después", () => {
  const pago = entry({ tag: UNKNOWN, amount: 1750 });
  const key = pago.messageIds[0];

  const paquete = build({ entries: [pago], corrections: [correction(key, "paquetes")] });
  assert.equal(paquete.hidden[0].hiddenReason, "paquetes");
  assert.equal(paquete.unassigned.length, 0);
  assert.equal(courseOf(paquete, "creacion_contenido").seats, 0);
  assert.match(textOf(renderCourseRoster(paquete, RENDER)), /No son de curso: 🎬 1 de paquete/);

  const corregido = build({
    entries: [pago],
    corrections: [correction(key, "no"), correction(key, "capcut_pro", { createdAt: "2026-11-21T12:05:00Z" })],
  });
  assert.equal(corregido.hidden.length, 0);
  assert.equal(courseOf(corregido, "capcut_pro").rows.length, 1);
});

test("anotar un pago que ya era de paquetes no lo mete en /inscritos (la nota queda para /pagos)", () => {
  const pago = entry({ tag: { kind: "packages" }, amount: 999 });
  const roster = build({ entries: [pago], corrections: [correction(pago.messageIds[0], "paquetes", { note: "Promo 4 videos" })] });
  assert.equal(roster.hidden.length, 0);
  assert.equal(roster.unassigned.length, 0);
  const [revisado] = applyTeamCorrections([pago], [correction(pago.messageIds[0], "paquetes", { note: "Promo 4 videos" })], COURSES);
  assert.equal(revisado.teamNote, "Promo 4 videos");
});

test("el equipo también puede reasignar un pago que el bot ya había etiquetado", () => {
  const pago = entry({ tag: TAG_CREACION, amount: 300 });
  const roster = build({ entries: [pago], corrections: [correction(pago.messageIds[0], "capcut_pro")] });
  assert.equal(courseOf(roster, "creacion_contenido").seats, 0);
  assert.equal(courseOf(roster, "capcut_pro").seats, 1);
});

test("lo que revisó el equipo se ve también en /pagos, con la nota y el monto", () => {
  const pago = entry({ tag: UNKNOWN, amount: 1750 });
  const [revisado] = applyTeamCorrections(
    [pago],
    [correction(pago.messageIds[0], "paquetes", { note: "Saldo restante de un paquete de videos" })],
    COURSES,
  );
  const text = renderPaymentsLedger({
    entries: [revisado],
    range: { fromIso: "2026-11-14T04:00:00Z", toIso: "2026-11-21T18:00:00Z", label: "Últimos 7 días" },
  }).join("\n");
  assert.match(text, /🎬 Paquete de videos · ✍️ revisado · 💵 1750 Bs/);
  assert.match(text, /📝 Saldo restante de un paquete de videos/);
  assert.ok(!text.includes("no se sabe cuál"));
});

// --- Por cobrar ---------------------------------------------------------------------------------

test("tocó pagar y no mandó comprobante: sale en por cobrar; si pagó después, no", () => {
  const intents: CourseIntent[] = [
    { phone: "59170000009", kind: "pay_click", option: "combo", amount: 500, createdAt: "2026-11-20T13:14:00Z" },
    { phone: "59170000003", kind: "pay_click", option: "creacion_contenido", amount: 300, createdAt: "2026-11-20T13:14:00Z" },
  ];
  const roster = build({
    entries: [entry({ phone: "59170000003", paidAt: "2026-11-20T13:30:00Z", tag: UNKNOWN })],
    intents,
  });
  assert.deepEqual(roster.pending.map((p) => p.phone), ["59170000009"]);
  const text = renderPendingPayments(roster, RENDER).blocks.join("\n");
  assert.match(text, /POR COBRAR<\/b> · 1 persona/);
  assert.match(text, /Perfil Nueve/);
  assert.match(text, /Eligió Combo · 500 Bs/);
});

test("recibió el QR y no pagó: por cobrar, con su rótulo; uno de hace más de 14 días ya no", () => {
  const intents: CourseIntent[] = [
    { phone: "59170000004", kind: "qr", option: null, amount: null, createdAt: "2026-11-18T00:47:00Z" },
    { phone: "59170000005", kind: "qr", option: null, amount: null, createdAt: "2026-10-30T13:14:00Z" },
  ];
  const roster = build({ entries: [], intents });
  assert.deepEqual(roster.pending.map((p) => p.phone), ["59170000004"]);
  assert.match(renderPendingPayments(roster, RENDER).blocks.join("\n"), /Recibió el QR/);
});

// --- Cursos que se muestran y botones ------------------------------------------------------------

test("un curso dictado hace más de 3 días ya no se muestra", () => {
  const roster = build({ entries: [], now: new Date("2026-11-26T10:00:00-04:00") });
  assert.deepEqual(roster.courses.map((c) => c.course.id), ["capcut_pro"]);
});

test("los botones caben en Telegram (64 bytes), traen paquete y se leen de vuelta", () => {
  const pago = entry({ tag: UNKNOWN, messageIds: ["wamid.HBgLNTkxNzM2OTc3MTgVAgASGCBBNTVFRjg2RkFBNjdDMzAxQzk0MTE2QzNGMjhFMzk2NQA="] });
  const roster = build({ entries: [pago] });
  const [message] = assignMessages(renderCourseRoster(roster, RENDER));
  assert.ok(message);

  const buttons = message.keyboard!.inline_keyboard.flat();
  assert.deepEqual(
    buttons.map((b) => b.callback_data.split(":")[2]),
    ["creacion_contenido", "capcut_pro", "combo", "paquetes", "no"],
  );
  for (const button of buttons) {
    assert.ok(Buffer.byteLength(button.callback_data) <= 64, button.callback_data);
    const parsed = parseRosterCallback(button.callback_data);
    assert.equal(parsed?.shortKey, shortKeyOf(pago.messageIds[0]));
    assert.ok(roster.byShortKey.has(parsed!.shortKey));
  }
  assert.equal(parseRosterCallback("pagos:rango:hoy"), null);
});

test("no se aceptan opciones de cursos que ya no se muestran", () => {
  for (const choice of ["combo", "no", "paquetes", "capcut_pro"]) assert.ok(isValidChoice(choice, COURSES, NOW), choice);
  assert.ok(!isValidChoice("creacion_contenido", COURSES, new Date("2026-11-26T10:00:00-04:00")));
  assert.ok(!isValidChoice("cualquiera", COURSES, NOW));
});

// --- Lo que se ve en Telegram ----------------------------------------------------------------

test("primero el resumen, después un mensaje por curso y al final los por asignar", () => {
  const roster = build({
    entries: [
      entry({ tag: { kind: "course_bundle", options: OPTIONS }, names: ["Ana <b>Pérez</b> Soliz"], amount: 500 }),
      entry({ tag: UNKNOWN, amount: 1000 }),
    ],
    intents: [{ phone: "59170000009", kind: "pay_click", option: "combo", amount: 500, createdAt: "2026-11-20T13:14:00Z" }],
  });
  const messages = renderCourseRoster(roster, RENDER);
  assert.equal(messages.length, 4); // resumen + 2 cursos + 1 por asignar

  const summary = messages[0].blocks.join("\n");
  assert.match(summary, /INSCRITOS/);
  assert.match(summary, /Creación de Contenido \(22\/11\): <b>1 inscrito<\/b>/);
  assert.match(summary, /Pagos por asignar: <b>1<\/b>/);
  assert.match(summary, /Por cobrar: <b>1<\/b>/);
  assert.deepEqual(messages[0].keyboard?.inline_keyboard[0].map((b) => b.callback_data), ["menu:porcobrar", "menu:inscritos"]);

  const creacion = messages[1].blocks.join("\n");
  assert.match(creacion, /CREACIÓN DE CONTENIDO/);
  assert.match(creacion, /es mañana/);
  assert.match(creacion, /Combo \(los dos cursos\) · 💵 500 Bs · ✅/);
  assert.ok(creacion.includes("Ana &lt;b&gt;Pérez&lt;/b&gt; Soliz"));
  assert.ok(!creacion.includes("<b>Pérez</b>"));

  assert.match(messages[3].blocks.join("\n"), /PAGO POR ASIGNAR<\/b> \(1 de 1\)/);
});

test("un curso sin pagos lo dice en vez de quedar vacío", () => {
  const messages = renderCourseRoster(build({ entries: [] }), RENDER);
  assert.match(messages[1].blocks.join("\n"), /Todavía no hay inscritos/);
});

test("el resultado de un botón dice qué se eligió y cuántos cupos quedaron", () => {
  const pago = entry({ tag: UNKNOWN, amount: 1000, names: ["Paula Rivero Bilbao"] });
  const roster = build({ entries: [pago], corrections: [correction(pago.messageIds[0], "combo", { by: "José" })] });
  const row = roster.byShortKey.get(shortKeyOf(pago.messageIds[0]))!;
  const { text, keyboard } = renderAssignmentResult(row, "combo", { ...RENDER, by: "José" });
  assert.match(text, /Guardado<\/b> · 🎓 Combo \(los dos cursos\) · por José/);
  assert.match(text, /Combo × 2/);
  assert.equal(keyboard.inline_keyboard.flat().length, 5);

  const paquete = renderAssignmentResult(row, "paquetes", { ...RENDER, by: null });
  assert.match(paquete.text, /no suma inscritos/);
});

test("sin cursos con fecha, la lista lo dice y no manda botones", () => {
  const later = new Date("2026-12-10T10:00:00-04:00");
  const messages = renderCourseRoster(build({ entries: [], now: later }), { ...RENDER, now: later });
  assert.equal(messages.length, 1);
  assert.match(textOf(messages), /No hay ningún curso con fecha/);
  assert.equal(assignMessages(messages).length, 0);
});

// --- Lista de espera -----------------------------------------------------------------------------

test("la lista de espera muestra a cada persona una vez, marca a los inscritos y deja los números", () => {
  const blocks = renderCourseWaitlist(
    [
      { phone: "59170000001", createdAt: "2026-11-13T10:00:00Z", clientMessage: "cuando hay curso", profileName: "Ana" },
      { phone: "59170000001", createdAt: "2026-11-15T10:00:00Z", clientMessage: "y el curso?", profileName: "Ana" },
      { phone: "59170000002", createdAt: "2026-11-14T10:00:00Z", clientMessage: null, profileName: null },
      { phone: "59170000003", createdAt: "2026-11-14T11:00:00Z", clientMessage: null, profileName: "Luis" },
    ],
    NOW,
    new Set(["59170000003"]),
  );
  const text = blocks.join("\n");
  assert.match(text, /LISTA DE ESPERA<\/b> · 3 personas/);
  assert.match(text, /Luis ✅/);
  assert.match(text, /<code>70000001, 70000002<\/code>/);
  assert.ok(text.includes("y el curso?"));
  assert.ok(!text.includes("cuando hay curso"));
});

test("la lista de espera vacía explica cómo se llena", () => {
  assert.match(renderCourseWaitlist([], NOW).join("\n"), /Todavía no hay nadie/);
});

console.log(`${passed} pruebas de inscritos, por cobrar y lista de espera OK`);

if (failures.length > 0) {
  console.error(`\n${failures.length} FALLARON:`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}

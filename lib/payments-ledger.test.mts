// Pruebas de la lista global de pagos (/pagos, lib/payments-ledger.ts).
//
//   npm test            (usa el type-stripping nativo de Node, sin dependencias)
//
// Lo que se protege: que salgan TODOS los comprobantes del rango (aunque el bot no los haya
// confirmado), cada uno con su etiqueta; que no se cuele ruido (preguntas o publicidad con la
// palabra "pago"); y que los rangos de fechas sean días de calendario de Bolivia.

import assert from "node:assert/strict";
import {
  buildPaymentsLedger,
  parseCustomRange,
  renderPaymentsLedger,
  resolvePresetRange,
} from "./payments-ledger.ts";
import type { LedgerRange } from "./payments-ledger.ts";
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
  category: "confirmed",
  phone: "59167293748",
  firstAt: "2026-09-10T15:43:03Z",
  lastAt: over.firstAt ?? "2026-09-10T15:43:03Z",
  kinds: { images: 1, documents: 0, texts: 0 },
  context: "🎓 Curso (se le envió el QR)",
  alerted: true,
  detail: "",
  tag: null,
  taggedNames: [],
  taggedMotive: null,
  ...over,
});

const RANGO: LedgerRange = {
  fromIso: "2026-09-04T04:00:00.000Z",
  toIso: "2026-09-19T04:00:00.000Z",
  label: "Últimos 15 días",
};

const CAPCUT_TAG = {
  kind: "course" as const,
  courseId: "capcut_pro",
  courseName: "Curso de Edición Persuasiva en CapCut Pro",
  courseStartsAt: "2026-09-20T16:00:00-04:00",
};

// --- Armado de la lista -----------------------------------------------------

test("junta el pago con los nombres que el alumno mandó después", () => {
  const [entry] = buildPaymentsLedger({
    payments: [payment({})],
    texts: [
      { phone: "59167293748", content: "Voy a querer 2 cupos porfa", createdAt: "2026-09-10T15:41:41Z" },
      { phone: "59167293748", content: "Carla Brigitte Zeitum Herrera \n67293748", createdAt: "2026-09-10T15:43:03Z" },
      { phone: "59167293748", content: "Paola Britha Domínguez", createdAt: "2026-09-10T15:53:57Z" },
    ],
    profileNames: new Map(),
  });

  assert.equal(entry.status, "confirmed");
  assert.deepEqual(entry.names, ["Carla Brigitte Zeitum Herrera", "Paola Britha Domínguez"]);
});

test("los nombres de la alerta etiquetada van primero", () => {
  const [entry] = buildPaymentsLedger({
    payments: [payment({ tag: CAPCUT_TAG, taggedNames: ["Aleida Patricia Trujillo Rivera"] })],
    texts: [],
    profileNames: new Map(),
  });
  assert.deepEqual(entry.names, ["Aleida Patricia Trujillo Rivera"]);
});

test("es global: cursos, paquetes y sin etiqueta van en la misma lista", () => {
  const entries = buildPaymentsLedger({
    payments: [
      payment({ phone: "1", tag: CAPCUT_TAG }),
      payment({ phone: "2", tag: { kind: "packages" }, context: "🎬 Paquetes (llenó/recibió formulario)" }),
      payment({ phone: "3", tag: { kind: "other" }, taggedMotive: "es por la asesoría" }),
      payment({ phone: "4" }),
    ],
    texts: [],
    profileNames: new Map(),
  });
  assert.equal(entries.length, 4);
});

test("lo que el bot no confirmó queda 'por revisar', no se pierde", () => {
  const entries = buildPaymentsLedger({
    payments: [
      // Archivo sin verificar de un cliente con QR.
      payment({ phone: "1", category: "review", alerted: false, detail: "🧾 Sin verificar" }),
      // "Ya pagué" escrito en un chat de curso.
      payment({ phone: "2", category: "review", alerted: false, kinds: { images: 0, documents: 0, texts: 1 }, detail: '💬 "ya pagué"' }),
    ],
    texts: [],
    profileNames: new Map([["1", "Carla Z."]]),
  });
  assert.deepEqual(entries.map((e) => e.status), ["review", "review"]);
  const text = renderPaymentsLedger({ entries, range: RANGO }).join("\n");
  assert.match(text, /❓ por revisar/);
  assert.match(text, /perfil: Carla Z\./);
});

test("no se cuela ruido: descartados por visión, preguntas o publicidad con la palabra 'pago'", () => {
  const entries = buildPaymentsLedger({
    payments: [
      payment({ phone: "1", category: "discarded" }),
      payment({ phone: "2", category: "unrelated", context: "❔ Sin contexto" }),
      payment({
        phone: "3",
        category: "review",
        alerted: false,
        kinds: { images: 0, documents: 0, texts: 1 },
        context: "❔ Sin contexto",
        detail: '💬 "Disculpe si adquiero los paquetes incluyen publicidad pagada"',
      }),
    ],
    texts: [],
    profileNames: new Map(),
  });
  assert.equal(entries.length, 0);
});

// --- Cómo se ve -------------------------------------------------------------

test("cada comprobante muestra su etiqueta; sin etiqueta, el contexto detectado", () => {
  const entries = buildPaymentsLedger({
    payments: [
      payment({ phone: "59111111111", firstAt: "2026-09-18T15:26:00Z", tag: CAPCUT_TAG, taggedNames: ["Aleida Patricia Trujillo Rivera"] }),
      payment({ phone: "59122222222", firstAt: "2026-09-17T20:00:00Z", tag: { kind: "other" }, taggedMotive: "es por la asesoría" }),
      payment({ phone: "59133333333", firstAt: "2026-09-17T13:00:00Z" }),
    ],
    texts: [],
    profileNames: new Map(),
  });
  const text = renderPaymentsLedger({ entries, range: RANGO }).join("\n");

  assert.match(text, /🏷️ 🎓 Curso de Edición Persuasiva en CapCut Pro — 20\/09/);
  assert.match(text, /🏷️ ❔ Otro motivo/);
  assert.match(text, /📝 es por la asesoría/);
  assert.match(text, /🏷️ ❔ Sin etiqueta · 🎓 Curso \(se le envió el QR\)/);
  // Resumen por etiqueta y agrupado por día, lo más reciente arriba.
  assert.match(text, /🧾 3 comprobantes · ✅ 3 confirmados · ❓ 0 por revisar/);
  assert.ok(text.indexOf("18/09") < text.indexOf("17/09"));
});

test("la lista larga se parte sin cortar a ningún comprobante", () => {
  const entries = buildPaymentsLedger({
    payments: Array.from({ length: 90 }, (_, i) =>
      payment({ phone: `5916${String(i).padStart(7, "0")}`, firstAt: new Date(Date.UTC(2026, 8, 10, 12, i)).toISOString() }),
    ),
    texts: [],
    profileNames: new Map(),
  });
  const chunks = chunkTelegramBlocks(renderPaymentsLedger({ entries, range: RANGO }));

  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= 4096);
  assert.equal((chunks.join("\n").match(/abrir chat/g) ?? []).length, 90);
});

// --- Rangos de fechas -----------------------------------------------------------

// 19/09 10:00 en Bolivia.
const AHORA = new Date("2026-09-19T14:00:00Z");
const MEDIANOCHE_19 = "2026-09-19T04:00:00.000Z";

test("los botones de fecha usan días de calendario de Bolivia", () => {
  assert.deepEqual(resolvePresetRange("hoy", AHORA), { fromIso: MEDIANOCHE_19, toIso: AHORA.toISOString(), label: "Hoy" });
  assert.deepEqual(resolvePresetRange("ayer", AHORA), {
    fromIso: "2026-09-18T04:00:00.000Z",
    toIso: MEDIANOCHE_19,
    label: "Ayer",
  });
  // Últimos 7 días = hoy y los 6 anteriores.
  assert.equal(resolvePresetRange("7", AHORA)?.fromIso, "2026-09-13T04:00:00.000Z");
  assert.equal(resolvePresetRange("otro", AHORA), null);
});

test("rango escrito a mano: /pagos 10/09 18/09", () => {
  assert.deepEqual(parseCustomRange("10/09 18/09", AHORA), {
    fromIso: "2026-09-10T04:00:00.000Z",
    toIso: MEDIANOCHE_19,
    label: "10/09 al 18/09",
  });
  // Una sola fecha = ese día.
  assert.deepEqual(parseCustomRange("13/09", AHORA), {
    fromIso: "2026-09-13T04:00:00.000Z",
    toIso: "2026-09-14T04:00:00.000Z",
    label: "13/09",
  });
  // Sin año, una fecha "futura" es del año pasado (en enero, "20/12" es diciembre anterior).
  assert.equal(parseCustomRange("20/12", new Date("2027-01-05T14:00:00Z"))?.fromIso, "2026-12-20T04:00:00.000Z");
  // Hoy no se corta a medianoche: llega hasta ahora.
  assert.equal(parseCustomRange("19/09", AHORA)?.toIso, AHORA.toISOString());
});

test("fechas que no se entienden no arman lista", () => {
  for (const texto of ["", "ayer", "31/02", "18/09 10/09", "01/01 30/06", "10/09 12/09 14/09"]) {
    assert.equal(parseCustomRange(texto, AHORA), null, texto);
  }
});

console.log(`${passed} pruebas de la lista de pagos OK`);

if (failures.length > 0) {
  console.error(`\n${failures.length} FALLARON:`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}

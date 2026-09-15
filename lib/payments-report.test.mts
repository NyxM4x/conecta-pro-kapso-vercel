// Pruebas de la detección de pagos que alimenta el botón "🎓 Inscritos del curso".
//
//   npm test            (usa el type-stripping nativo de Node, sin dependencias)
//
// La garantía que importa: NINGÚN archivo ni mensaje de pago de un cliente se queda fuera
// de la lista, aunque el bot no lo haya verificado ni alertado. Los casos salen de
// comprobantes reales que en septiembre de 2026 no generaron alerta.

import assert from "node:assert/strict";
import { buildPaymentsReport, isPaymentClaim } from "./payments-report.ts";
import type { InboundCandidate, OutboundMarker, VisionVerdict } from "./payments-report.ts";

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

const PHONE = "59170000001";
const OTHER = "59170000002";

const inbound = (over: Partial<InboundCandidate>): InboundCandidate => ({
  messageId: over.messageId ?? `wamid.${Math.random()}`,
  conversationId: over.conversationId ?? "conv-1",
  phone: over.phone ?? PHONE,
  content: over.content ?? "📷 Imagen recibida",
  createdAt: over.createdAt ?? "2026-09-13T20:50:00Z",
  type: over.type ?? "image",
});

const marker = (content: string, createdAt: string, phone = PHONE, conversationId = "conv-1"): OutboundMarker => ({
  content,
  createdAt,
  phone,
  conversationId,
});

test("un comprobante que llegó junto a un 'Gracias' y nunca se verificó igual aparece", () => {
  const candidates = [
    inbound({ messageId: "img", createdAt: "2026-09-13T16:50:30Z" }),
    inbound({ messageId: "txt", content: "Gracias", type: "text", createdAt: "2026-09-13T16:50:30Z" }),
  ];
  const markers = [marker("[MEDIA_SENT:payment_qr] QR de pago cursos", "2026-09-12T10:00:00Z")];

  const entries = buildPaymentsReport({ candidates, markers, vision: new Map() });

  assert.equal(entries.length, 1);
  assert.equal(entries[0].category, "review");
  assert.match(entries[0].context, /Curso/);
});

test("con alerta enviada o visión positiva cuenta como comprobante", () => {
  const vision = new Map<string, VisionVerdict>([["ok", { isReceipt: true, reason: "comprobante" }]]);
  const entries = buildPaymentsReport({
    candidates: [
      inbound({ messageId: "ok", createdAt: "2026-09-10T15:00:00Z" }),
      inbound({ messageId: "alert", phone: OTHER, conversationId: "conv-2", createdAt: "2026-09-11T15:00:00Z" }),
    ],
    markers: [
      // La alerta quedó asociada al texto de la ráfaga, no a la imagen: igual cuenta.
      marker("[TELEGRAM_PAYMENT_SENT:wamid.texto] notificación", "2026-09-11T15:00:05Z", OTHER, "conv-2"),
    ],
    vision,
  });

  assert.deepEqual(entries.map((e) => e.category), ["confirmed", "confirmed"]);
});

test("un texto que afirma el pago entra aunque no traiga imagen", () => {
  const entries = buildPaymentsReport({
    candidates: [inbound({ content: "Buen di yo pague no estoy en el curso", type: "text" })],
    markers: [],
    vision: new Map(),
  });

  assert.equal(entries.length, 1);
  assert.equal(entries[0].category, "review");
});

test("pedir el QR no es un pago", () => {
  assert.equal(isPaymentClaim("Me pasa su Qr"), false);
  assert.equal(isPaymentClaim("Le pago por qr"), false);
  assert.equal(isPaymentClaim("Ya Ise mi cancelación"), true);
  assert.equal(isPaymentClaim("Ya deposite"), true);
  assert.equal(isPaymentClaim("Ahí le paso el comprobante"), true);
});

test("lo que la visión descartó se lista aparte, no se pierde", () => {
  const vision = new Map<string, VisionVerdict>([["selfie", { isReceipt: false, reason: "foto de personas" }]]);
  const entries = buildPaymentsReport({
    candidates: [inbound({ messageId: "selfie" })],
    markers: [marker("[MEDIA_SENT:payment_qr] QR", "2026-09-12T10:00:00Z")],
    vision,
  });

  assert.equal(entries[0].category, "discarded");
});

test("un archivo sin ningún contexto de pago va a 'otros', no a 'por revisar'", () => {
  const entries = buildPaymentsReport({ candidates: [inbound({})], markers: [], vision: new Map() });
  assert.equal(entries[0].category, "unrelated");
});

test("ningún pago de clientes distintos se pierde al agrupar", () => {
  const candidates = Array.from({ length: 120 }, (_, i) =>
    inbound({
      messageId: `m${i}`,
      phone: `5917${String(i).padStart(7, "0")}`,
      conversationId: `c${i}`,
      content: "Ya pagué, aquí está mi comprobante del curso de creación de contenido",
      type: "text",
      createdAt: new Date(Date.UTC(2026, 8, 1, 12, i)).toISOString(),
    }),
  );
  const entries = buildPaymentsReport({ candidates, markers: [], vision: new Map() });
  assert.equal(entries.length, 120);
});

console.log(`${passed} pruebas de pagos OK`);

if (failures.length > 0) {
  console.error(`\n${failures.length} FALLARON:`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}

// Pruebas del botón "📞 Llamadas y visitas".
//
//   npm test            (usa el type-stripping nativo de Node, sin dependencias)
//
// Lo que se protege: que llamadas y visitas salgan en UNA lista, cada persona una sola vez,
// con su tipo (llamada, visita de negocio, de curso o cita del flujo anterior); que el lead de
// quien solo llenó el formulario no se cuele; y que se separe bien quién ya fue contactado por
// el equipo desde WhatsApp Business.

import assert from "node:assert/strict";
import { buildPendingContacts, renderPendingContacts } from "./pending-contacts.ts";
import type { PendingContactsData } from "./pending-contacts.ts";

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

const NOW = new Date("2026-09-15T15:00:00Z");

type Request = PendingContactsData["requests"][number];
type Message = PendingContactsData["messages"][number];

const request = (over: Partial<Request> & Pick<Request, "conversationId" | "content" | "createdAt">): Request => ({
  phone: `5917000000${over.conversationId.length}`,
  kind: null,
  trigger: null,
  ...over,
});

const message = (over: Partial<Message> & Pick<Message, "conversationId" | "content" | "createdAt">): Message => ({
  direction: "outbound",
  byHuman: false,
  leadKind: null,
  ...over,
});

const data = (over: Partial<PendingContactsData>): PendingContactsData => ({
  requests: over.requests ?? [],
  messages: over.messages ?? [],
  profileNames: over.profileNames ?? new Map(),
});

test("un pedido por curso deja dos marcas pero aparece una sola vez, como curso", () => {
  const contacts = buildPendingContacts(
    data({
      requests: [
        request({ conversationId: "c1", content: "[OFFICE_VISIT_REQUESTED] x", createdAt: "2026-09-15T10:00:00Z", kind: "course" }),
        request({ conversationId: "c1", content: "[TELEGRAM_COURSE_OFFICE_VISIT_SENT] x", createdAt: "2026-09-15T10:00:01Z" }),
      ],
    }),
  );

  assert.equal(contacts.length, 1);
  assert.deepEqual(contacts[0].types, ["course"]);
});

test("el lead por pedido de llamada entra como llamada; el de solo formulario no entra", () => {
  const contacts = buildPendingContacts(
    data({
      requests: [
        request({ conversationId: "llama", content: "[TELEGRAM_LEAD_SENT] x", createdAt: "2026-09-14T10:00:00Z", kind: "call_request", trigger: "call_request_heuristic" }),
        // Datos + "llámenme" en el mismo turno: el lead sale como intake, pero pidió llamada.
        request({ conversationId: "datosyllama", content: "[TELEGRAM_LEAD_SENT] x", createdAt: "2026-09-14T11:00:00Z", kind: "intake", trigger: "call_request_assistant" }),
        request({ conversationId: "form", content: "[TELEGRAM_LEAD_SENT] x", createdAt: "2026-09-14T12:00:00Z", kind: "intake", trigger: "intake_form" }),
      ],
    }),
  );

  assert.deepEqual(contacts.map((c) => c.conversationId).sort(), ["datosyllama", "llama"]);
  assert.ok(contacts.every((c) => c.types.join() === "call"));
});

test("visita y llamada de la misma persona van juntas y cuenta el último pedido", () => {
  const contacts = buildPendingContacts(
    data({
      requests: [
        request({ conversationId: "c1", content: "[OFFICE_VISIT_REQUESTED] x", createdAt: "2026-09-14T10:00:00Z", kind: "business" }),
        request({ conversationId: "c1", content: "[TELEGRAM_LEAD_SENT] x", createdAt: "2026-09-14T16:00:00Z", kind: "call_request", trigger: "call_request_assistant" }),
      ],
      messages: [
        // El equipo le escribió por la visita, pero después pidió que lo llamen y nadie respondió.
        message({ conversationId: "c1", content: "Hola, te esperamos", createdAt: "2026-09-14T12:00:00Z", byHuman: true }),
        message({ conversationId: "c1", direction: "inbound", content: "mejor llámenme", createdAt: "2026-09-14T15:59:58Z" }),
      ],
    }),
  );

  assert.equal(contacts.length, 1);
  assert.deepEqual(contacts[0].types, ["business", "call"]);
  assert.equal(contacts[0].requestedAt, "2026-09-14T16:00:00Z");
  assert.equal(contacts[0].teamRepliedAt, null);
  assert.equal(contacts[0].requestText, "mejor llámenme");
});

test("sabe si el equipo ya le escribió y si dejó sus datos", () => {
  const contacts = buildPendingContacts(
    data({
      requests: [
        request({ conversationId: "c1", content: "[OFFICE_VISIT_REQUESTED] x", createdAt: "2026-09-14T10:00:00Z", kind: "business" }),
        request({ conversationId: "c2", content: "[OFFICE_VISIT_REQUESTED] x", createdAt: "2026-09-14T11:00:00Z", kind: "business" }),
      ],
      messages: [
        message({ conversationId: "c1", direction: "inbound", content: "Mañana ire a visitarlos", createdAt: "2026-09-14T09:59:58Z" }),
        message({ conversationId: "c1", content: "[TELEGRAM_LEAD_SENT] ok", createdAt: "2026-09-14T10:20:00Z", leadKind: "intake" }),
        message({ conversationId: "c1", content: "Hola, le llamo en un rato", createdAt: "2026-09-14T12:00:00Z", byHuman: true }),
        // El bot hablando después NO cuenta como contacto del equipo.
        message({ conversationId: "c2", content: "¡Con gusto te recibimos!", createdAt: "2026-09-14T11:00:05Z" }),
        // Un lead por pedido de llamada no significa que dejó sus datos.
        message({ conversationId: "c2", content: "[TELEGRAM_LEAD_SENT] ok", createdAt: "2026-09-14T11:10:00Z", leadKind: "call_request" }),
      ],
    }),
  );

  const c1 = contacts.find((c) => c.conversationId === "c1")!;
  const c2 = contacts.find((c) => c.conversationId === "c2")!;
  assert.equal(c1.leftData, true);
  assert.equal(c1.teamRepliedAt, "2026-09-14T12:00:00Z");
  assert.equal(c1.requestText, "Mañana ire a visitarlos");
  assert.equal(c2.teamRepliedAt, null);
  assert.equal(c2.leftData, false);
});

test("lista híbrida: por contactar con ficha completa primero, contactados en una línea", () => {
  const contacts = buildPendingContacts(
    data({
      requests: [
        request({ conversationId: "a", phone: "59170000001", content: "[TELEGRAM_APPOINTMENT_SENT] x", createdAt: "2026-09-10T10:00:00Z" }),
        request({ conversationId: "b", phone: "59170000002", content: "[OFFICE_VISIT_REQUESTED] x", createdAt: "2026-09-15T10:00:00Z", kind: "business" }),
        request({ conversationId: "c", phone: "59170000003", content: "[TELEGRAM_LEAD_SENT] x", createdAt: "2026-09-08T13:00:00Z", kind: "call_request", trigger: "call_request_heuristic" }),
      ],
      messages: [
        message({ conversationId: "a", content: "hola", createdAt: "2026-09-10T11:00:00Z", byHuman: true }),
        message({ conversationId: "c", direction: "inbound", content: "que me llamen", createdAt: "2026-09-08T12:59:00Z" }),
      ],
      profileNames: new Map([["59170000003", "Juan <Pérez>"]]),
    }),
  );
  const text = renderPendingContacts({ contacts, now: NOW }).join("\n");

  assert.match(text, /🔴 2 por contactar · ✅ 1 ya contactados/);
  assert.ok(text.indexOf("POR CONTACTAR") < text.indexOf("YA CONTACTADOS"));
  // El más antiguo primero: la llamada del 08/09 antes que la visita del 15/09.
  assert.ok(text.indexOf("📞 Llamada") < text.indexOf("🏢 Visita · Negocio"));
  assert.match(text, /<b>1\. 📞 Llamada<\/b>\n {5}👤 Juan &lt;Pérez&gt; · 📱 70000003/);
  assert.match(text, /🕒 08\/09 09:00 \(hace 7 días\)\n {5}🗨️ "que me llamen"/);
  assert.match(text, /🏢 Visita · Negocio<\/b> · ⏳ sin datos/);
  // Contactado: una sola línea con la numeración que sigue.
  assert.match(text, /<b>3\.<\/b> 📅 <i>sin nombre<\/i> · 70000001 · 💬 10\/09 07:00 · <a href="https:\/\/wa\.me\/59170000001">chat<\/a>/);
});

test("el audio transcrito se muestra sin el prefijo", () => {
  const contacts = buildPendingContacts(
    data({
      requests: [request({ conversationId: "c1", content: "[TELEGRAM_LEAD_SENT] x", createdAt: "2026-09-15T10:00:00Z", kind: "call_request" })],
      messages: [
        message({ conversationId: "c1", direction: "inbound", content: "🎙️ Audio recibido\n\nTranscripción: llámenme a las 5", createdAt: "2026-09-15T09:59:00Z" }),
      ],
    }),
  );
  const text = renderPendingContacts({ contacts, now: NOW }).join("\n");
  assert.match(text, /🗨️ "🎙️ llámenme a las 5"/);
});

test("sin pedidos en el período lo dice", () => {
  const text = renderPendingContacts({ contacts: [], now: NOW }).join("\n");
  assert.match(text, /🔴 0 por contactar · ✅ 0 ya contactados/);
  assert.match(text, /Nadie pidió una llamada ni visitar la oficina/);
});

console.log(`${passed} pruebas de llamadas y visitas OK`);

if (failures.length > 0) {
  console.error(`\n${failures.length} FALLARON:`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}

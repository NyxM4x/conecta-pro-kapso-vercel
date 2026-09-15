// Pruebas del botón "🏢 Visitas por coordinar".
//
//   npm test            (usa el type-stripping nativo de Node, sin dependencias)
//
// Lo que se protege: que cada pedido de visita aparezca una sola vez, con su tipo (negocio,
// curso o cita del flujo anterior), y que se separe bien quién ya fue contactado por el
// equipo desde WhatsApp Business.

import assert from "node:assert/strict";
import { buildOfficeVisits, renderOfficeVisits } from "./office-visits.ts";
import type { OfficeVisitData } from "./office-visits.ts";

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

const data = (over: Partial<OfficeVisitData>): OfficeVisitData => ({
  requests: over.requests ?? [],
  messages: over.messages ?? [],
  profileNames: over.profileNames ?? new Map(),
});

test("un pedido por curso deja dos marcas pero aparece una sola vez, como curso", () => {
  const visits = buildOfficeVisits(
    data({
      requests: [
        { conversationId: "c1", phone: "59170000001", content: "[OFFICE_VISIT_REQUESTED] x", createdAt: "2026-09-15T10:00:00Z", kind: "course" },
        { conversationId: "c1", phone: "59170000001", content: "[TELEGRAM_COURSE_OFFICE_VISIT_SENT] x", createdAt: "2026-09-15T10:00:01Z", kind: null },
      ],
    }),
  );

  assert.equal(visits.length, 1);
  assert.equal(visits[0].kind, "course");
});

test("sabe si el equipo ya le escribió y si dejó sus datos", () => {
  const visits = buildOfficeVisits(
    data({
      requests: [
        { conversationId: "c1", phone: "59170000001", content: "[OFFICE_VISIT_REQUESTED] x", createdAt: "2026-09-14T10:00:00Z", kind: "business" },
        { conversationId: "c2", phone: "59170000002", content: "[OFFICE_VISIT_REQUESTED] x", createdAt: "2026-09-14T11:00:00Z", kind: "business" },
      ],
      messages: [
        { conversationId: "c1", direction: "inbound", content: "Mañana ire a visitarlos", createdAt: "2026-09-14T09:59:58Z", byHuman: false },
        { conversationId: "c1", direction: "outbound", content: "[TELEGRAM_LEAD_SENT] ok", createdAt: "2026-09-14T10:20:00Z", byHuman: false },
        { conversationId: "c1", direction: "outbound", content: "Hola, le llamo en un rato", createdAt: "2026-09-14T12:00:00Z", byHuman: true },
        // El bot hablando después NO cuenta como contacto del equipo.
        { conversationId: "c2", direction: "outbound", content: "¡Con gusto te recibimos!", createdAt: "2026-09-14T11:00:05Z", byHuman: false },
      ],
    }),
  );

  const c1 = visits.find((v) => v.conversationId === "c1")!;
  const c2 = visits.find((v) => v.conversationId === "c2")!;
  assert.equal(c1.leftData, true);
  assert.equal(c1.teamRepliedAt, "2026-09-14T12:00:00Z");
  assert.equal(c1.requestText, "Mañana ire a visitarlos");
  assert.equal(c2.teamRepliedAt, null);
  assert.equal(c2.leftData, false);
});

test("la lista pone primero a los que nadie contactó", () => {
  const visits = buildOfficeVisits(
    data({
      requests: [
        { conversationId: "a", phone: "59170000001", content: "[TELEGRAM_APPOINTMENT_SENT] x", createdAt: "2026-09-10T10:00:00Z", kind: null },
        { conversationId: "b", phone: "59170000002", content: "[OFFICE_VISIT_REQUESTED] x", createdAt: "2026-09-15T10:00:00Z", kind: "business" },
      ],
      messages: [{ conversationId: "a", direction: "outbound", content: "hola", createdAt: "2026-09-10T11:00:00Z", byHuman: true }],
    }),
  );
  const text = renderOfficeVisits({ visits, now: NOW }).join("\n");

  assert.ok(text.indexOf("Nadie del equipo le escribió") < text.indexOf("El equipo ya le escribió"));
  assert.match(text, /Cita \(flujo anterior\)/);
  assert.match(text, /1 sin contactar · 💬 1 ya contactados/);
});

console.log(`${passed} pruebas de visitas OK`);

if (failures.length > 0) {
  console.error(`\n${failures.length} FALLARON:`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}

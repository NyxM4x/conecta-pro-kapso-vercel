// Pruebas de /cliente (lib/client-status.ts).
//
//   npm test            (usa el type-stripping nativo de Node, sin dependencias)

import assert from "node:assert/strict";
import { normalizeClientPhone, renderClientStatus, type ClientStatusData } from "./client-status.ts";

let passed = 0;
const test = (name: string, fn: () => void) => {
  try {
    fn();
    passed++;
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
};

const NOW = new Date("2026-10-15T15:00:00-04:00");
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

const base = (overrides: Partial<ClientStatusData> = {}): ClientStatusData => ({
  phone: "59171234567",
  conversation: { flowStage: "intake_sent", botPaused: false, botPauseExpiresAt: null, advisorNotifiedAt: null },
  events: [],
  ...overrides,
});

test("normaliza el celular como lo escribe el equipo", () => {
  assert.equal(normalizeClientPhone("71234567"), "59171234567");
  assert.equal(normalizeClientPhone("+591 7123 4567"), "59171234567");
  assert.equal(normalizeClientPhone("123"), null);
});

test("recibió el botón y abrió la página, pero sus datos no llegaron", () => {
  const text = renderClientStatus(
    base({
      events: [
        { content: "[SITE_VISIT:paquetes]", createdAt: minutesAgo(10) },
        { content: "[LINK_SENT:packages_form] https://x/paquetes", createdAt: minutesAgo(30) },
      ],
    }),
    NOW,
  );
  assert.match(text, /Recibió el botón «Llenar mis datos \(paquetes\)»/);
  assert.match(text, /Abrió la página \/paquetes/);
  assert.match(text, /Abrió la página pero sus datos NO llegaron/);
  // De lo más viejo a lo más nuevo.
  assert.ok(text.indexOf("Recibió el botón") < text.indexOf("Abrió la página /paquetes"));
});

test("recibió el botón y nunca abrió la página", () => {
  const text = renderClientStatus(
    base({ events: [{ content: "[LINK_SENT:packages] https://x", createdAt: minutesAgo(5) }] }),
    NOW,
  );
  assert.match(text, /Recibió el botón pero no abrió la página/);
});

test("envió sus datos por la página y el bot quedó apagado", () => {
  const text = renderClientStatus(
    base({
      conversation: {
        flowStage: "advisor_notified",
        botPaused: true,
        botPauseExpiresAt: new Date(NOW.getTime() + 12 * 3600_000).toISOString(),
        advisorNotifiedAt: minutesAgo(2),
      },
      events: [{ content: "[TELEGRAM_LEAD_SENT] lead recibido desde la página /oficina", createdAt: minutesAgo(2) }],
    }),
    NOW,
  );
  assert.match(text, /Envió sus datos en \/oficina \(visita\)/);
  assert.match(text, /Sus datos ya llegaron al asesor/);
  assert.match(text, /Bot apagado hasta/);
});

test("sin conversación", () => {
  assert.match(renderClientStatus(base({ conversation: null }), NOW), /No hay ninguna conversación/);
});

console.log(`${passed} pruebas de /cliente OK`);

// Pruebas de los rótulos de mensajes que no son texto (lib/incoming-labels.ts).
//
//   npm test            (usa el type-stripping nativo de Node, sin dependencias)
//
// Lo que se protege: que una ubicación, un sticker, un video o un contacto nunca vuelvan a
// llegar al bot como "🎙️ Audio recibido" (20 nov 2026: "No pude escuchar el audio" a una
// clienta que había mandado la ubicación de su salón).

import assert from "node:assert/strict";
import { labelNonTextMessage } from "./incoming-labels.ts";

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

test("la ubicación llega como ubicación, con su link de Maps (payload real de Kapso)", () => {
  const label = labelNonTextMessage({ type: "location", location: { latitude: -17.8996628, longitude: -63.2200005 } });
  assert.equal(label, "📍 Ubicación enviada — https://maps.google.com/?q=-17.8996628,-63.2200005");
  assert.ok(!label?.includes("Audio"));
});

test("si la ubicación trae nombre y dirección, también van", () => {
  assert.equal(
    labelNonTextMessage({ type: "location", location: { latitude: 1, longitude: 2, name: "Salón Vero", address: "Km 6 doble vía La Guardia" } }),
    "📍 Ubicación enviada — Salón Vero — Km 6 doble vía La Guardia — https://maps.google.com/?q=1,2",
  );
  assert.equal(labelNonTextMessage({ type: "location", location: {} }), "📍 Ubicación enviada");
});

test("sticker, video (con y sin texto) y contacto tienen su propio rótulo", () => {
  assert.equal(labelNonTextMessage({ type: "sticker", sticker: { animated: false } }), "😊 Sticker");
  assert.equal(labelNonTextMessage({ type: "video", video: {} }), "🎥 Video recibido");
  assert.equal(labelNonTextMessage({ type: "video", video: { caption: "  así lo quiero  " } }), "🎥 Video recibido: así lo quiero");
  assert.equal(
    labelNonTextMessage({ type: "contacts", contacts: [{ name: { formatted_name: "Fernando" }, phones: [{ phone: "+591 78505623" }] }] }),
    "👤 Contacto compartido — Fernando — +591 78505623",
  );
});

test("texto, imagen, documento y audio no se tocan (los rotula el webhook)", () => {
  for (const type of ["text", "image", "document", "audio", "interactive", "button"]) {
    assert.equal(labelNonTextMessage({ type }), null, type);
  }
  assert.equal(labelNonTextMessage(null), null);
});

console.log(`${passed} pruebas de rótulos de mensajes OK`);

if (failures.length > 0) {
  console.error(`\n${failures.length} FALLARON:`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}

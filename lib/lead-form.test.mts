// Pruebas del formulario de leads de /paquetes (lib/lead-form.ts).
//
//   npm test            (usa el type-stripping nativo de Node, sin dependencias)

import assert from "node:assert/strict";
import { LEAD_FIELDS, buildLeadTelegramMessage, validateLead } from "./lead-form.ts";

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

const COMPLETE = {
  name: "  Carla Zeitum ",
  company: "Café Aroma",
  role: "Dueña",
  sector: "Gastronomía",
  social: "@cafearoma",
  contentType: "Videos, Fotos",
  reference: "",
  packageName: "Normal",
  originPhone: "59171234567",
};

test("acepta un formulario completo y recorta espacios", () => {
  const result = validateLead(COMPLETE);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.lead.name, "Carla Zeitum");
});

test("el formulario no pide el número: lo pone el bot", () => {
  assert.ok(LEAD_FIELDS.every((field) => !/NUMERO|CELULAR|TELEFONO/i.test(field.label.normalize("NFD").replace(/[̀-ͯ]/g, ""))));
  assert.equal(validateLead({ ...COMPLETE, originPhone: undefined }).ok, true);
});

test("la referencia es opcional y lo demás es obligatorio", () => {
  const result = validateLead({ ...COMPLETE, role: " ", social: "" });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.deepEqual(result.errors, ["Cargo dentro de la empresa", "Instagram o redes sociales"]);
  }
});

test("rechaza un paquete vacío", () => {
  const result = validateLead({ ...COMPLETE, packageName: "" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.deepEqual(result.errors, ["Paquete"]);
});

test("el contacto es el WhatsApp del botón", () => {
  const result = validateLead({ ...COMPLETE, company: "<b>A&B</b>" });
  if (!result.ok) throw new Error("debía validar");
  const text = buildLeadTelegramMessage(result.lead, "Normal — 12 videos — 3500 Bs", { verified: true });
  assert.match(text, /🏢 Empresa: &lt;b&gt;A&amp;B&lt;\/b&gt;/);
  assert.match(text, /📞 WhatsApp: \+59171234567\n/);
  assert.match(text, /https:\/\/wa\.me\/59171234567/);
  assert.doesNotMatch(text, /sin verificar|Referencia/);
});

test("avisa si el número no viene firmado o si no hay número", () => {
  const signedOff = validateLead(COMPLETE);
  if (!signedOff.ok) throw new Error("debía validar");
  assert.match(buildLeadTelegramMessage(signedOff.lead, "x"), /sin verificar/);

  const noPhone = validateLead({ ...COMPLETE, originPhone: "" });
  if (!noPhone.ok) throw new Error("debía validar");
  assert.match(buildLeadTelegramMessage(noPhone.lead, "x"), /Sin número/);
});

test("marca al cliente que ya había dejado sus datos por chat", () => {
  const result = validateLead(COMPLETE);
  if (!result.ok) throw new Error("debía validar");
  assert.match(
    buildLeadTelegramMessage(result.lead, "x", { verified: true, alreadyLeadInChat: true }),
    /Ya había dejado sus datos por el chat/,
  );
});

console.log(`${passed} pruebas del formulario de leads OK`);

if (failures.length > 0) {
  console.error(`\n${failures.length} FALLARON:`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}

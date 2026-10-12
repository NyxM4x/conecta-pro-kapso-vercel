// Pruebas del formulario de leads de /paquetes (lib/lead-form.ts).
//
//   npm test            (usa el type-stripping nativo de Node, sin dependencias)

import assert from "node:assert/strict";
import { buildLeadTelegramMessage, toWhatsappDigits, validateLead } from "./lead-form.ts";

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
  phone: "712 345 67",
  sector: "Gastronomía",
  social: "@cafearoma",
  contentType: "Videos, Fotos",
  reference: "",
  packageName: "Normal",
};

test("acepta un formulario completo y recorta espacios", () => {
  const result = validateLead(COMPLETE);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.lead.name, "Carla Zeitum");
});

test("la referencia es opcional y lo demás es obligatorio", () => {
  const result = validateLead({ ...COMPLETE, role: " ", social: "" });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.deepEqual(result.errors, ["Cargo dentro de la empresa", "Instagram o redes sociales"]);
  }
});

test("rechaza un celular demasiado corto y un paquete vacío", () => {
  const result = validateLead({ ...COMPLETE, phone: "123", packageName: "" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.deepEqual(result.errors, ["Número de contacto personal", "Paquete"]);
});

test("completa el 591 solo en celulares bolivianos de 8 dígitos", () => {
  assert.equal(toWhatsappDigits("712 345 67"), "59171234567");
  assert.equal(toWhatsappDigits("+591 71234567"), "59171234567");
  assert.equal(toWhatsappDigits("+54 9 11 2345 6789"), "5491123456789");
});

test("el mensaje escapa HTML y avisa si abrió el link desde otro número", () => {
  const result = validateLead({ ...COMPLETE, company: "<b>A&B</b>", originPhone: "59170000000" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const text = buildLeadTelegramMessage(result.lead, "Normal — 12 videos — 3500 Bs");
  assert.match(text, /🏢 Empresa: &lt;b&gt;A&amp;B&lt;\/b&gt;/);
  assert.match(text, /https:\/\/wa\.me\/59171234567/);
  assert.match(text, /Abrió el link desde el WhatsApp: https:\/\/wa\.me\/59170000000/);
  assert.doesNotMatch(text, /Referencia/);
});

test("no repite el número de origen si es el mismo que dejó de contacto", () => {
  const result = validateLead({ ...COMPLETE, originPhone: "59171234567" });
  if (!result.ok) throw new Error("debía validar");
  assert.doesNotMatch(buildLeadTelegramMessage(result.lead, "x"), /Abrió el link/);
});

console.log(`${passed} pruebas del formulario de leads OK`);

if (failures.length > 0) {
  console.error(`\n${failures.length} FALLARON:`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}

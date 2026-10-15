// Pruebas del formulario de /oficina (lib/office-form.ts).
//
//   npm test            (usa el type-stripping nativo de Node, sin dependencias)

import assert from "node:assert/strict";
import { OFFICE_FORMS, buildOfficeVisitTelegramMessage, validateOfficeVisit } from "./office-form.ts";

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

test("ningún formulario de visita pide el número", () => {
  for (const form of Object.values(OFFICE_FORMS)) {
    for (const field of form.fields) {
      assert.doesNotMatch(field.label.normalize("NFD").replace(/[̀-ͯ]/g, ""), /NUMERO|CELULAR|TELEFONO/i);
    }
  }
});

test("el de curso solo exige el nombre", () => {
  const result = validateOfficeVisit({ visitType: "curso", name: " Ana ", originPhone: "59171234567" });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.visit.values.name, "Ana");
});

test("el de negocio exige nombre, empresa y rubro", () => {
  const result = validateOfficeVisit({ visitType: "negocio", name: "Ana" });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.deepEqual(result.errors, ["Nombre de tu empresa o emprendimiento", "Rubro o sector"]);
  }
});

test("un motivo desconocido no pasa", () => {
  assert.equal(validateOfficeVisit({ visitType: "otro", name: "Ana" }).ok, false);
});

test("el aviso al asesor dice que lo llame y trae lo que escribió", () => {
  const result = validateOfficeVisit({
    visitType: "agente",
    name: "Ana",
    business: "Café <Aroma>",
    messages: "80",
    originPhone: "59171234567",
  });
  if (!result.ok) throw new Error("debía validar");
  const text = buildOfficeVisitTelegramMessage(result.visit, { verified: true });
  assert.match(text, /Quiere reunirse en la oficina/);
  assert.match(text, /Motivo: <b>Agente de IA<\/b>/);
  assert.match(text, /Llámalo para coordinar/);
  assert.match(text, /Café &lt;Aroma&gt;/);
  assert.match(text, /wa\.me\/59171234567/);
  assert.doesNotMatch(text, /sin verificar|sucursal/);
});

console.log(`${passed} pruebas del formulario de oficina OK`);

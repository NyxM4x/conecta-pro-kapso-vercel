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
  socialNetwork: "Instagram",
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
    assert.deepEqual(result.errors, ["Cargo dentro de la empresa", "¿Con qué nombre te encontramos?"]);
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

test("el formulario de la promo guarda quién sale en los videos y la fecha tentativa", () => {
  const result = validateLead({
    ...COMPLETE,
    packageName: "Promo 4 videos",
    presenter: "presenter",
    preferredDate: "  sábado 25 por la mañana ",
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.lead.presenter, "presenter");
    assert.equal(result.lead.preferredDate, "sábado 25 por la mañana");
  }
});

test("una opción de presentadora inventada se descarta", () => {
  const result = validateLead({ ...COMPLETE, presenter: "<script>" });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.lead.presenter, undefined);
});

test("el lead de una promo llega a Telegram marcado como promo, con la presentadora", () => {
  const result = validateLead({ ...COMPLETE, packageName: "Promo 4 videos", presenter: "presenter" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const message = buildLeadTelegramMessage(result.lead, "Promo 4 videos — 4 videos — 999 Bs", {
    verified: true,
    promo: { presenterPrice: 200 },
  });
  assert.match(message, /PROMOCIÓN/);
  assert.match(message, /🎁 Promo: <b>Promo 4 videos — 4 videos — 999 Bs<\/b>/);
  assert.match(message, /Presentadora: <b>Sí<\/b> \(\+200 Bs\)/);
});

test("un lead de paquete normal no muestra nada de la promo", () => {
  const result = validateLead({ ...COMPLETE, presenter: "owner" });
  if (!result.ok) throw new Error("debía validar");
  const message = buildLeadTelegramMessage(result.lead, "Normal — 12 videos — 3500 Bs");
  assert.doesNotMatch(message, /PROMOCIÓN|Presentadora/);
});

console.log(`${passed} pruebas del formulario de leads OK`);

if (failures.length > 0) {
  console.error(`\n${failures.length} FALLARON:`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}

test("la red social es obligatoria y solo acepta TikTok, Facebook o Instagram", () => {
  const sinRed = validateLead({ ...COMPLETE, socialNetwork: "" });
  assert.equal(sinRed.ok, false);
  const invalida = validateLead({ ...COMPLETE, socialNetwork: "Twitter" });
  assert.equal(invalida.ok, false);
  for (const red of ["TikTok", "Facebook", "Instagram"]) {
    assert.equal(validateLead({ ...COMPLETE, socialNetwork: red }).ok, true);
  }
});

test("el mensaje a los asesores dice en qué red encontramos al cliente y con qué nombre", () => {
  const result = validateLead({ ...COMPLETE, socialNetwork: "TikTok" });
  assert.equal(result.ok, true);
  if (result.ok) {
    const message = buildLeadTelegramMessage(result.lead, "Normal");
    assert.match(message, /Red: <b>TikTok<\/b> — @cafearoma/);
  }
});

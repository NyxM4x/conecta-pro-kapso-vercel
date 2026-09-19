// Pruebas del extractor de nombre y celular (lib/contact-lines.ts), que usan la lista de
// pagos y la alerta 💰.
//
//   npm test            (usa el type-stripping nativo de Node, sin dependencias)
//
// Los textos de prueba son mensajes reales de septiembre de 2026.

import assert from "node:assert/strict";
import { extractContactLines } from "./contact-lines.ts";

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

test("lee nombre y celular escritos juntos o en líneas separadas", () => {
  assert.deepEqual(extractContactLines("Carla Brigitte Zeitum Herrera \n67293748"), {
    names: ["Carla Brigitte Zeitum Herrera"],
    phones: ["67293748"],
  });
  assert.deepEqual(extractContactLines("Yoselin flores Peñaranda \nNúmero: 60967636"), {
    names: ["Yoselin flores Peñaranda"],
    phones: ["60967636"],
  });
  assert.deepEqual(extractContactLines("Aleida Patricia Trujillo Rivera \nTel:68652085"), {
    names: ["Aleida Patricia Trujillo Rivera"],
    phones: ["68652085"],
  });
});

test("un mensaje puede traer a dos inscritos", () => {
  assert.deepEqual(extractContactLines("Joryelina palma\nSusana Galean").names, [
    "Joryelina palma",
    "Susana Galean",
  ]);
  assert.deepEqual(
    extractContactLines("Guisselly Micaela Padilla Hinojoza \n Michael Basto Egue").names,
    ["Guisselly Micaela Padilla Hinojoza", "Michael Basto Egue"],
  );
});

test("quita prefijos y muletillas antes del nombre", () => {
  assert.deepEqual(extractContactLines("Nombre completo: Paola Britha Domínguez").names, ["Paola Britha Domínguez"]);
  assert.deepEqual(extractContactLines("Si Maria Estefani").names, ["Maria Estefani"]);
  assert.deepEqual(extractContactLines("Cel: 7654 3210").phones, ["76543210"]);
  assert.deepEqual(extractContactLines("+591 71234567").phones, ["71234567"]);
});

test("una frase de conversación no es un nombre", () => {
  for (const frase of [
    "Buenas tardes",
    "Ya muchas gracias",
    "Es mañana a las 4pm no",
    "Me pasa su Qr",
    "Pasando las clases yo pague pero mi hija es Dulce América Iporre Arce",
    "📷 Imagen recibida",
    "Ok",
    "O la china",
    "Drjara d",
    "debe salir",
    "Vengo del live",
    "Nadie se contacto conmigo",
    "Así así ek deposito",
    "Ahí va la transferencia",
  ]) {
    assert.deepEqual(extractContactLines(frase).names, [], frase);
  }
});

console.log(`${passed} pruebas de nombre y celular OK`);

if (failures.length > 0) {
  console.error(`\n${failures.length} FALLARON:`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}

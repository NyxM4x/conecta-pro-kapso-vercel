// Pruebas del catálogo de paquetes y de la clasificación POR RANGO.
//
//   npm test            (usa el type-stripping nativo de Node, sin dependencias)
//
// Lo que se protege aquí es la regla de negocio nueva: una cantidad que no está en el
// flyer NO es automáticamente un "no". Por debajo del mínimo no hay servicio; del mínimo
// para arriba (incluidas las cantidades intermedias y las mayores al paquete más grande)
// hay lead y lo coordina un asesor humano.
//
// Las pruebas se escriben CONTRA EL RANGO, no contra 6/12/18: si mañana los paquetes
// pasan a 5 y 10 videos, deben seguir pasando sin tocarlas. Por eso casi ninguna
// menciona un número literal.

import assert from "node:assert/strict";
import {
  MAX_PACKAGE_VIDEOS,
  MIN_PACKAGE_VIDEOS,
  PACKAGE_NAMES,
  PACKAGE_PRICES,
  PACKAGE_SIZES,
  VIDEO_PACKAGES,
  classifyVideoQuantity,
  detectRequestedVideoCount,
  renderPackageCatalog,
  renderPackageFlyerLines,
  renderPackageSizes,
  renderQuantityExamples,
} from "./packages.ts";

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

// --- Coherencia del catálogo -------------------------------------------------

test("el catálogo está ordenado de menor a mayor y sin cantidades repetidas", () => {
  const ordenado = [...PACKAGE_SIZES].sort((a, b) => a - b);
  assert.deepEqual(PACKAGE_SIZES, ordenado);
  assert.equal(new Set(PACKAGE_SIZES).size, PACKAGE_SIZES.length);
});

test("los derivados salen del catálogo, no de una lista aparte", () => {
  assert.equal(PACKAGE_SIZES.length, VIDEO_PACKAGES.length);
  assert.equal(PACKAGE_PRICES.length, VIDEO_PACKAGES.length);
  assert.equal(MIN_PACKAGE_VIDEOS, PACKAGE_SIZES[0]);
  assert.equal(MAX_PACKAGE_VIDEOS, PACKAGE_SIZES[PACKAGE_SIZES.length - 1]);
});

test("los nombres para las regex están normalizados (sin tildes, en mayúsculas)", () => {
  for (const name of PACKAGE_NAMES) {
    assert.equal(name, name.toUpperCase(), name);
    assert.ok(!/[ÁÉÍÓÚÑ]/.test(name), name);
  }
});

test("el flyer nombra todos los paquetes con su cantidad y su precio", () => {
  const flyer = renderPackageFlyerLines();
  for (const pkg of VIDEO_PACKAGES) {
    assert.ok(flyer.includes(`${pkg.name}`), pkg.name);
    assert.ok(flyer.includes(`${pkg.videos} videos`), `${pkg.videos} videos`);
    assert.ok(flyer.includes(`${pkg.price} Bs`), `${pkg.price} Bs`);
  }
  assert.equal(flyer.split("\n").length, VIDEO_PACKAGES.length);
});

test("el indent del flyer se aplica a TODAS las líneas (sangría del prompt)", () => {
  for (const linea of renderPackageFlyerLines("  ").split("\n")) {
    assert.ok(linea.startsWith("  "), linea);
  }
});

test("la lista de cantidades usa la conjunción en español", () => {
  assert.ok(renderPackageSizes().includes(" o "));
  assert.ok(renderPackageSizes().startsWith(String(MIN_PACKAGE_VIDEOS)));
  assert.ok(renderPackageSizes().endsWith(String(MAX_PACKAGE_VIDEOS)));
  assert.ok(renderPackageCatalog().includes(String(PACKAGE_PRICES[0])));
});

// --- Clasificación por rango -------------------------------------------------

test("las cantidades del catálogo son paquetes, no casos especiales", () => {
  for (const size of PACKAGE_SIZES) {
    assert.equal(classifyVideoQuantity(size), "in_catalog", String(size));
  }
});

test("por debajo del mínimo NO hay servicio (incluye el video suelto)", () => {
  for (let n = 1; n < MIN_PACKAGE_VIDEOS; n++) {
    assert.equal(classifyVideoQuantity(n), "below_min", String(n));
  }
});

test("una cantidad intermedia del rango es negociable, no un rechazo", () => {
  const intermedias = [];
  for (let n = MIN_PACKAGE_VIDEOS + 1; n < MAX_PACKAGE_VIDEOS; n++) {
    if (!PACKAGE_SIZES.includes(n)) intermedias.push(n);
  }

  // Si el catálogo tuviera cantidades consecutivas no habría intermedias; hoy sí las hay
  // y son justo el caso que perdía leads.
  assert.ok(intermedias.length > 0);
  for (const n of intermedias) {
    assert.equal(classifyVideoQuantity(n), "negotiable", String(n));
  }
});

test("pedir MÁS que el paquete más grande también es negociable", () => {
  for (const extra of [1, 2, 12, MAX_PACKAGE_VIDEOS]) {
    assert.equal(
      classifyVideoQuantity(MAX_PACKAGE_VIDEOS + extra),
      "negotiable",
      String(MAX_PACKAGE_VIDEOS + extra),
    );
  }
});

test("cantidades imposibles no se clasifican como pedidos", () => {
  for (const n of [0, -3, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(classifyVideoQuantity(n), "invalid", String(n));
  }
});

test("los ejemplos del prompt caen en el caso que ilustran", () => {
  for (const raw of renderQuantityExamples("below_min").split(/,| o /)) {
    const n = Number(raw.trim());
    if (Number.isFinite(n)) assert.equal(classifyVideoQuantity(n), "below_min", raw);
  }
  for (const raw of renderQuantityExamples("negotiable").split(/,| o /)) {
    const n = Number(raw.trim());
    if (Number.isFinite(n)) assert.equal(classifyVideoQuantity(n), "negotiable", raw);
  }
});

// --- Detección de la cantidad pedida ----------------------------------------

test("lee la cantidad cuando el cliente la escribe con números", () => {
  assert.equal(detectRequestedVideoCount("quiero 15 videos al mes"), 15);
  assert.equal(detectRequestedVideoCount("necesito 30 VIDEOS"), 30);
  assert.equal(detectRequestedVideoCount("me sirven 7 videos?"), 7);
  assert.equal(detectRequestedVideoCount("20videos por mes"), 20);
});

test("lee la cantidad cuando la escribe con letras", () => {
  assert.equal(detectRequestedVideoCount("unos treinta videos al mes"), 30);
  assert.equal(detectRequestedVideoCount("quiero quince videos"), 15);
  assert.equal(detectRequestedVideoCount("necesito veinte reels"), 20);
});

test("un número sin la palabra video NO es una cantidad", () => {
  const frases = [
    "nos vemos a las 10",
    "tengo 3 sucursales",
    "mi número es 70123456",
    "el curso del 15",
  ];
  for (const frase of frases) {
    assert.equal(detectRequestedVideoCount(frase), null, frase);
  }
});

test("un precio del catálogo no se confunde con una cantidad de videos", () => {
  for (const price of PACKAGE_PRICES) {
    assert.equal(detectRequestedVideoCount(`${price} videos`), null, String(price));
    assert.equal(detectRequestedVideoCount(`vengo por los ${price} Bs`), null, String(price));
  }
});

test("una elección normal de paquete no dispara el caso negociable", () => {
  for (const size of PACKAGE_SIZES) {
    const detectado = detectRequestedVideoCount(`quiero el de ${size} videos`);
    assert.equal(detectado, size, String(size));
    assert.equal(classifyVideoQuantity(detectado as number), "in_catalog", String(size));
  }
});

// --- Resultado ---------------------------------------------------------------

if (failures.length > 0) {
  console.error(`\n${failures.length} FALLARON:`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}

console.log(`${passed} pruebas OK`);

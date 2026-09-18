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
  PACKAGE_NAME_MATCH_REGEX,
  PACKAGE_PRICES,
  PACKAGE_SIZES,
  PACKAGES_WITH_DRONE,
  PACKAGES_WITHOUT_DRONE,
  VIDEO_PACKAGES,
  classifyVideoQuantity,
  detectDroneRequest,
  detectRequestedVideoCount,
  findPackageByName,
  mentionsCatalogPackage,
  renderDroneClientLine,
  renderDroneRule,
  renderPackageCatalog,
  renderPackageFlyerLines,
  renderPackageIncludes,
  renderPackageSizes,
  renderQuantityExamples,
  renderSocialNetworksRule,
} from "./packages.ts";
import { normalizeForMatch } from "./keywords.ts";

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

// --- Dron --------------------------------------------------------------------
//
// Estas pruebas nacen de un caso real: el bot le dijo a un cliente que el dron venía
// incluido sin costo en el paquete más chico. No lo estaba. El prompt decía "según el
// paquete que elijas" sin decir cuál, y el modelo llenó el hueco con la versión que
// cerraba la venta. Igual que el resto del archivo, se escriben contra el catálogo y no
// contra "el Pro": si mañana el dron pasa al paquete mediano, deben seguir pasando.

test("cada paquete declara si trae dron y los dos grupos suman el catálogo", () => {
  for (const pkg of VIDEO_PACKAGES) {
    assert.equal(typeof pkg.drone, "boolean", pkg.name);
  }
  assert.equal(
    PACKAGES_WITH_DRONE.length + PACKAGES_WITHOUT_DRONE.length,
    VIDEO_PACKAGES.length,
  );
});

test("la regla del dron nombra los paquetes que lo traen y los que no", () => {
  const regla = renderDroneRule();
  for (const pkg of PACKAGES_WITH_DRONE) {
    assert.ok(regla.includes(pkg.name), pkg.name);
  }
  for (const pkg of PACKAGES_WITHOUT_DRONE) {
    assert.ok(regla.includes(pkg.name), pkg.name);
  }
});

test("el texto al cliente NUNCA vuelve a decir 'según el paquete que elijas'", () => {
  const linea = renderDroneClientLine();
  assert.ok(!/SEGUN EL PAQUETE/i.test(linea.normalize("NFD").replace(/[̀-ͯ]/g, "")));
  // Y sí nombra el paquete concreto: es el dato que faltaba.
  for (const pkg of PACKAGES_WITH_DRONE) {
    assert.ok(linea.includes(pkg.name), pkg.name);
  }
});

test("detecta el pedido de dron, incluso sin nombrarlo", () => {
  const frases = [
    "el paquete básico me gustaría que 1 video sea con dron",
    "quiero DRONE",
    "se puede con tomas aéreas?",
    "me gustaría una vista desde arriba del local",
    "incluye planos aereos?",
  ];
  for (const frase of frases) {
    assert.equal(detectDroneRequest(frase), true, frase);
  }
});

test("un rechazo explícito del dron NO cuenta como pedido", () => {
  const frases = [
    "sin dron está bien",
    "no quiero dron",
    "no necesitamos dron por ahora",
    "nada de drones",
    "el básico sin tomas aéreas",
  ];
  for (const frase of frases) {
    assert.equal(detectDroneRequest(frase), false, frase);
  }
});

test("una pregunta con 'no' adentro sigue siendo un pedido de dron", () => {
  // La trampa de las negaciones anchas: estas frases contienen "no" cerca de "dron"
  // pero son justo las que hay que atrapar.
  assert.equal(detectDroneRequest("no sé si el básico incluye dron"), true);
  assert.equal(detectDroneRequest("no me quedó claro lo del dron"), true);
});

test("un mensaje sin dron no dispara nada", () => {
  for (const frase of ["quiero el básico", "cuánto cuesta?", "hola"]) {
    assert.equal(detectDroneRequest(frase), false, frase);
  }
});

// --- Elección de paquete vs. cantidad suelta ---------------------------------

test("reconoce el paquete nombrado por nombre y por precio", () => {
  for (const pkg of VIDEO_PACKAGES) {
    assert.equal(mentionsCatalogPackage(`quiero el ${pkg.name}`), true, pkg.name);
    assert.equal(mentionsCatalogPackage(`el de ${pkg.price}`), true, String(pkg.price));
    assert.equal(findPackageByName(`me interesa el ${pkg.name}`)?.videos, pkg.videos, pkg.name);
  }
  assert.equal(mentionsCatalogPackage("quiero grabar videos"), false);
  assert.equal(findPackageByName("quiero grabar videos"), null);
});

test("'PRO' dentro de ConectaPro no se lee como el paquete Pro", () => {
  assert.equal(mentionsCatalogPackage("hola conectapro"), false);
  assert.equal(findPackageByName("hola conectapro"), null);
});

test("un número suelto DENTRO de un pedido de paquete no es la cantidad contratada", () => {
  // El bug real: "1 video" se leía como cantidad por debajo del mínimo y el bot
  // respondía "nuestros paquetes son fijos" a alguien que acababa de elegir uno.
  for (const pkg of VIDEO_PACKAGES) {
    assert.equal(
      detectRequestedVideoCount(`el paquete ${pkg.name} pero que 1 video sea con dron`),
      null,
      pkg.name,
    );
  }
});

test("una cantidad MAYOR sigue detectándose aunque se nombre un paquete", () => {
  // Este sí es un lead: no hay que silenciarlo por mencionar el catálogo.
  const grande = MAX_PACKAGE_VIDEOS + 2;
  assert.equal(
    detectRequestedVideoCount(`quiero ${grande} videos, más que el Pro`),
    grande,
  );
});

test("sin paquete nombrado, una cantidad chica se sigue detectando", () => {
  assert.equal(detectRequestedVideoCount("solo quiero 1 video"), 1);
  assert.equal(classifyVideoQuantity(1), "below_min");
});

// --- "CapCut Pro" es el curso, no el paquete Pro ------------------------------
//
// Desde el curso "Edición Persuasiva en CapCut Pro" (sep 2026), cada mensaje del bot sobre
// el curso contaba como paquetes presentados: el QR dejaba de salir y "quiero comprar mi
// entrada" recibía el formulario de datos de empresa.

test("'CapCut Pro' no es el paquete Pro", () => {
  const curso = normalizeForMatch("Curso de Edición Persuasiva en CapCut Pro");
  assert.equal(PACKAGE_NAME_MATCH_REGEX.test(curso), false);
  assert.equal(PACKAGE_NAME_MATCH_REGEX.test(normalizeForMatch("el curso de cap cut pro")), false);
  assert.equal(mentionsCatalogPackage("tener CapCut Pro activo"), false);
  assert.equal(findPackageByName("quiero el curso de capcut pro"), null);
});

test("el paquete Pro se sigue reconociendo por su nombre", () => {
  assert.equal(PACKAGE_NAME_MATCH_REGEX.test(normalizeForMatch("me interesa el pro")), true);
  assert.equal(findPackageByName("El pro mensual")?.name, "Pro");
  assert.equal(findPackageByName("el básico")?.name, "Básico");
  // Ni dentro de "ConectaPro".
  assert.equal(PACKAGE_NAME_MATCH_REGEX.test(normalizeForMatch("ConectaPro")), false);
});

test("lo que muestra cada flyer: el dron y los Ads solo en el paquete que los trae", () => {
  const lineas = renderPackageIncludes().split("\n");
  assert.equal(lineas.length, VIDEO_PACKAGES.length);
  for (const pkg of VIDEO_PACKAGES) {
    const linea = lineas.find((l) => l.startsWith(`• ${pkg.name} (`)) ?? "";
    assert.equal(/\bdron\b/i.test(linea), pkg.drone, pkg.name);
  }
  assert.ok(lineas.every((l) => /guiones/.test(l)));
});

test("las tres redes valen para cualquier paquete, aunque el flyer chico solo diga TikTok", () => {
  const regla = renderSocialNetworksRule();

  for (const red of ["Instagram", "Facebook", "TikTok"]) {
    assert.ok(regla.includes(red), `debe nombrar ${red}`);
  }
  assert.ok(regla.includes("CUALQUIERA de los paquetes"), "debe valer para todos los paquetes");
  assert.ok(regla.includes("SÍ"), "la respuesta al cliente es un sí");
  // La frase vieja solo puede aparecer PROHIBIDA, nunca como respuesta a dar.
  assert.ok(
    regla.includes('NO respondas que "un asesor le confirma el alcance"'),
    "debe prohibir explícitamente la derivación al asesor que se usaba antes",
  );
});

// --- Resultado ---------------------------------------------------------------

if (failures.length > 0) {
  console.error(`\n${failures.length} FALLARON:`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}

console.log(`${passed} pruebas OK`);

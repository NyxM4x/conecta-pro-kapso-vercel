// Catálogo de paquetes de producción (LÍNEA B) — FUENTE ÚNICA DE VERDAD.
//
// Antes las cantidades (6/12/18), los precios (2500/3500/5500) y los nombres
// (Básico/Normal/Pro) estaban escritos a mano en decenas de lugares: el prompt del
// LLM, los textos fijos que envía la red de seguridad y los detectores deterministas.
// Cambiar la oferta obligaba a cazar todas esas menciones y era cuestión de tiempo que
// una quedara vieja (el bot diciendo "6, 12 o 18" con otro catálogo vigente).
//
// Ahora se edita SOLO la lista VIDEO_PACKAGES de abajo: el prompt, las respuestas y los
// rangos mínimo/máximo se derivan de ella. No vuelvas a escribir un número de videos ni
// un precio a mano fuera de este archivo.

import { containsExactNumber, normalizeForMatch } from "./keywords.ts";

type VideoPackage = {
  // Nombre tal como aparece en el flyer.
  name: string;
  videos: number;
  // Precio mensual en Bs.
  price: number;
  // ¿Este paquete incluye grabación con dron? Hoy solo el más grande. Antes esto no
  // estaba escrito en ningún lado y el prompt decía "según el paquete que elijas" sin
  // decir cuál: el modelo llenaba el hueco solo y llegó a prometerle a un cliente que el
  // dron venía gratis en el paquete más chico. Un dato afirmativo aquí es lo que evita
  // que se lo vuelva a inventar.
  drone: boolean;
};

// ⚠️ EDITAR AQUÍ (y solo aquí) cuando cambie la oferta. Ordenado de menor a mayor.
const VIDEO_PACKAGES: VideoPackage[] = [
  { name: "Básico", videos: 6, price: 2500, drone: false },
  { name: "Normal", videos: 12, price: 3500, drone: false },
  { name: "Pro", videos: 18, price: 5500, drone: true },
];

// Cantidades exactas del catálogo (hoy 6, 12 y 18).
const PACKAGE_SIZES = VIDEO_PACKAGES.map((pkg) => pkg.videos);

// Precios conocidos (hoy 2500, 3500 y 5500). Se usan SOLO como disparadores de
// intención: si el cliente menciona uno de estos montos, viene interesado en paquetes.
const PACKAGE_PRICES = VIDEO_PACKAGES.map((pkg) => pkg.price);

// Nombres normalizados (sin tilde, en mayúsculas) para las regex de detección.
const PACKAGE_NAMES = VIDEO_PACKAGES.map((pkg) => normalizeForMatch(pkg.name));

// Extremos del catálogo: definen el RANGO negociable. Una cantidad que cae dentro del
// rango (o por encima del máximo) no se rechaza — se deriva a un asesor humano.
const MIN_PACKAGE_VIDEOS = Math.min(...PACKAGE_SIZES);
const MAX_PACKAGE_VIDEOS = Math.max(...PACKAGE_SIZES);

// "6, 12 o 18" / "2500, 3500 y 5500": une la lista con la conjunción natural en español.
function joinList(items: string[], conjunction: "o" | "y"): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(", ")} ${conjunction} ${items[items.length - 1]}`;
}

// "6, 12 o 18"
function renderPackageSizes(): string {
  return joinList(PACKAGE_SIZES.map(String), "o");
}

// "2500, 3500 y 5500"
function renderPackagePrices(): string {
  return joinList(PACKAGE_PRICES.map(String), "y");
}

// Bloque del flyer, tal cual se envía por WhatsApp:
//   📦 *Básico:* 6 videos — 2500 Bs
// El parámetro indent reproduce la sangría del prompt sin romper el bloque.
function renderPackageFlyerLines(indent = ""): string {
  return VIDEO_PACKAGES.map(
    (pkg) => `${indent}📦 *${pkg.name}:* ${pkg.videos} videos — ${pkg.price} Bs`,
  ).join("\n");
}

// Ejemplos de cómo el cliente elige un paquete POR SU NOMBRE, derivados del catálogo:
//   "me interesa el básico", "quiero el pro"
function renderPackageNameExamples(): string {
  const first = VIDEO_PACKAGES[0].name.toLowerCase();
  const last = VIDEO_PACKAGES[VIDEO_PACKAGES.length - 1].name.toLowerCase();
  return `"me interesa el ${first}", "quiero el ${last}"`;
}

// Los nombres sueltos, como los diría el cliente: "el básico", "el normal", "el pro"
function renderPackageNamesList(): string {
  return joinList(
    VIDEO_PACKAGES.map((pkg) => `"el ${pkg.name.toLowerCase()}"`),
    "o",
  );
}

// "Básico = 6 videos (2500 Bs); Normal = 12 videos (3500 Bs); Pro = 18 videos (5500 Bs)"
function renderPackageCatalog(): string {
  return VIDEO_PACKAGES.map(
    (pkg) => `${pkg.name} = ${pkg.videos} videos (${pkg.price} Bs)`,
  ).join("; ");
}

// "Básico=6 videos, Normal=12 videos, Pro=18 videos"
function renderPackageNameMap(): string {
  return VIDEO_PACKAGES.map((pkg) => `${pkg.name}=${pkg.videos} videos`).join(", ");
}

// "6 videos = 2500, 12 videos = 3500, 18 videos = 5500"
function renderPackagePriceMap(): string {
  return VIDEO_PACKAGES.map((pkg) => `${pkg.videos} videos = ${pkg.price}`).join(", ");
}

// ── DRON Y OTROS EXTRAS ──────────────────────────────────────────────────────
//
// El dron es el ÚNICO extra con una regla cerrada (viene o no viene según el paquete).
// Todo lo demás que un cliente pueda pedir encima de su paquete —locución, actores,
// fotos, locaciones extra, más revisiones— no tiene regla ni precio publicado: lo cotiza
// un asesor. Ver la política de extras en el SYSTEM_PROMPT.

const PACKAGES_WITH_DRONE = VIDEO_PACKAGES.filter((pkg) => pkg.drone);
const PACKAGES_WITHOUT_DRONE = VIDEO_PACKAGES.filter((pkg) => !pkg.drone);

// "el Pro (18 videos)" / "el Básico (6 videos) y el Normal (12 videos)"
function renderPackagesWithVideos(
  packages: VideoPackage[],
  conjunction: "o" | "y",
): string {
  return joinList(
    packages.map((pkg) => `el ${pkg.name} (${pkg.videos} videos)`),
    conjunction,
  );
}

// Línea de cara al CLIENTE: la que va en el flyer de texto de los paquetes. Reemplaza al
// viejo "trabajamos con dron según el paquete que elijas", que afirmaba que existía una
// regla sin decirla.
function renderDroneClientLine(): string {
  if (PACKAGES_WITH_DRONE.length === 0) {
    return "Las tomas con dron se cotizan aparte: un asesor te pasa el precio exacto.";
  }
  return `El dron viene incluido en ${renderPackagesWithVideos(PACKAGES_WITH_DRONE, "y")}. En los demás paquetes se puede sumar, y un asesor te pasa la cotización exacta.`;
}

// Regla completa para el SYSTEM_PROMPT: dato afirmativo, sin ambigüedad, en los dos
// sentidos (qué paquete lo trae y cuáles no).
function renderDroneRule(): string {
  if (PACKAGES_WITH_DRONE.length === 0) {
    return "DRON: ningún paquete lo incluye. Siempre se cotiza aparte.";
  }
  if (PACKAGES_WITHOUT_DRONE.length === 0) {
    return "DRON: incluido en todos los paquetes.";
  }
  return [
    `DRON: lo incluye ÚNICAMENTE ${renderPackagesWithVideos(PACKAGES_WITH_DRONE, "y")}.`,
    `${renderPackagesWithVideos(PACKAGES_WITHOUT_DRONE, "y").replace(/^el /, "El ")} NO lo incluyen.`,
  ].join(" ");
}

// "el Pro (18 videos)": los paquetes que traen dron, para nombrarlos en el prompt.
function renderPackagesWithDrone(): string {
  return renderPackagesWithVideos(PACKAGES_WITH_DRONE, "y");
}

// Vocabulario del dron, incluidas las formas indirectas con las que un cliente pide lo
// mismo sin nombrarlo ("tomas aéreas", "desde arriba").
const DRONE_WORDS = "DRON|DRONE|DRONES|TOMAS? AEREAS?|VISTAS? AEREAS?|PLANOS? AEREOS?|IMAGENES AEREAS|DESDE EL AIRE|DESDE ARRIBA";

const DRONE_REGEX = new RegExp(`\\b(${DRONE_WORDS})\\b`);

// Negaciones EXPLÍCITAS del dron. Deliberadamente estrechas: solo formas de rechazo
// inequívocas. Una regla amplia del tipo "NO … a menos de N caracteres de DRON" también
// se tragaba preguntas legítimas ("no sé si el básico incluye dron"), que son justo las
// que hay que atrapar.
const DRONE_NEGATION_REGEX = new RegExp(
  `\\b(SIN|NADA DE|NINGUN|NINGUNA|TAMPOCO)\\s+(EL\\s+|UN\\s+|UNA\\s+|LA\\s+|DE\\s+)?(${DRONE_WORDS})\\b` +
    `|\\bNO\\s+(LO\\s+|LA\\s+|ME\\s+|NOS\\s+)?(QUIERO|QUEREMOS|NECESITO|NECESITAMOS|INTERESA|INTERESAN|HACE FALTA|USEN|USAR|VA|VAN|ES CON)\\s+` +
    `(EL\\s+|UN\\s+|UNA\\s+|DE\\s+|CON\\s+|LO\\s+DEL\\s+)?(${DRONE_WORDS})\\b`,
);

// ¿El cliente está PIDIENDO dron? Es la mitad determinista de la red de seguridad: el
// LLM también marca su propio flag, y basta con que uno de los dos dispare. Se descartan
// los rechazos explícitos ("sin dron", "no quiero dron") para no alertar al asesor por
// un cliente que justamente dijo que no lo quiere.
function detectDroneRequest(text: string): boolean {
  if (!text) return false;

  const normalized = normalizeForMatch(text);

  if (!DRONE_REGEX.test(normalized)) return false;
  if (DRONE_NEGATION_REGEX.test(normalized)) return false;

  return true;
}

// Nombres de paquete como palabra completa: "PRO" no debe saltar dentro de "CONECTAPRO".
const PACKAGE_NAME_MATCH_REGEX = new RegExp(`\\b(${PACKAGE_NAMES.join("|")})\\b`);

// ¿El mensaje identifica un paquete del catálogo por su NOMBRE o por su PRECIO exacto?
function mentionsCatalogPackage(text: string): boolean {
  if (!text) return false;
  const normalized = normalizeForMatch(text);
  return (
    PACKAGE_NAME_MATCH_REGEX.test(normalized) ||
    containsExactNumber(normalized, PACKAGE_PRICES)
  );
}

// ¿Un paquete concreto del catálogo, elegido por nombre? Lo usa el flujo de extras para
// saber si lo que el cliente eligió ya trae dron o hay que cotizarlo.
function findPackageByName(text: string): VideoPackage | null {
  if (!text) return null;
  const normalized = normalizeForMatch(text);
  return (
    VIDEO_PACKAGES.find((pkg) =>
      new RegExp(`\\b${normalizeForMatch(pkg.name)}\\b`).test(normalized),
    ) ?? null
  );
}

// Ejemplos de cantidades para el prompt, derivados del catálogo real:
// - "below_min": cantidades por debajo del mínimo (2, 3, 4, 5 si el mínimo es 6).
// - "negotiable": cantidades dentro del rango que no son paquete, más una por encima
//   del máximo (7, 10, 15, 20 si el catálogo es 6/12/18).
function renderQuantityExamples(kind: "below_min" | "negotiable"): string {
  const examples: number[] = [];

  if (kind === "below_min") {
    for (let n = 2; n < MIN_PACKAGE_VIDEOS && examples.length < 5; n++) examples.push(n);
  } else {
    for (let n = MIN_PACKAGE_VIDEOS + 1; n < MAX_PACKAGE_VIDEOS && examples.length < 4; n++) {
      if (!PACKAGE_SIZES.includes(n)) examples.push(n);
    }
    examples.push(MAX_PACKAGE_VIDEOS + 2, MAX_PACKAGE_VIDEOS + 12);
  }

  return joinList(examples.map(String), "o");
}

type VideoQuantityClass =
  // Coincide exactamente con un paquete del catálogo.
  | "in_catalog"
  // Menos videos que el paquete más chico: no hay servicio (ni "un solo video").
  | "below_min"
  // Dentro del rango sin coincidir, o por encima del máximo: SÍ se coordina con un
  // asesor humano. Es una oportunidad comercial, no un caso a rechazar.
  | "negotiable"
  | "invalid";

function classifyVideoQuantity(count: number): VideoQuantityClass {
  if (!Number.isFinite(count) || !Number.isInteger(count) || count <= 0) return "invalid";
  if (PACKAGE_SIZES.includes(count)) return "in_catalog";
  if (count < MIN_PACKAGE_VIDEOS) return "below_min";
  return "negotiable";
}

// Cantidades escritas con letras, como las escriben los clientes por WhatsApp
// ("quiero quince videos", "unos treinta videos al mes").
const NUMBER_WORDS: Record<string, number> = {
  UN: 1, UNO: 1, UNA: 1, DOS: 2, TRES: 3, CUATRO: 4, CINCO: 5, SEIS: 6,
  SIETE: 7, OCHO: 8, NUEVE: 9, DIEZ: 10, ONCE: 11, DOCE: 12, TRECE: 13,
  CATORCE: 14, QUINCE: 15, DIECISEIS: 16, DIECISIETE: 17, DIECIOCHO: 18,
  DIECINUEVE: 19, VEINTE: 20, VEINTICINCO: 25, TREINTA: 30, CUARENTA: 40,
  CINCUENTA: 50, SESENTA: 60, SETENTA: 70, OCHENTA: 80, NOVENTA: 90, CIEN: 100,
};

const NUMBER_WORD_REGEX = new RegExp(
  `\\b(${Object.keys(NUMBER_WORDS).join("|")})\\s+(?:VIDEOS?|CLIPS?|REELS?)\\b`,
);
// Solo cuenta el número que ACOMPAÑA a la palabra "video(s)": un "10" suelto puede ser
// una hora ("a las 10"), un día o una cantidad de sucursales.
const NUMBER_DIGIT_REGEX = /\b(\d{1,4})\s*(?:VIDEOS?|CLIPS?|REELS?)\b/;

// Cantidad de videos que pide el cliente, o null si el mensaje no la explicita.
// Deliberadamente conservador: sin la palabra "video" cerca no se adivina nada.
function detectRequestedVideoCount(text: string): number | null {
  if (!text) return null;

  const normalized = normalizeForMatch(text).replace(/(\d)[.,](\d)/g, "$1$2");

  let count: number | null = null;

  const digits = normalized.match(NUMBER_DIGIT_REGEX);
  if (digits) {
    const parsed = Number(digits[1]);
    // "2500 videos" no es una cantidad: es el precio mal tipeado por el cliente.
    if (!PACKAGE_PRICES.includes(parsed)) count = parsed;
  }

  if (count === null) {
    const words = normalized.match(NUMBER_WORD_REGEX);
    if (words) count = NUMBER_WORDS[words[1]];
  }

  if (count === null) return null;

  // "El paquete básico, que 1 video sea con dron": el cliente YA eligió un paquete y ese
  // número es un detalle DENTRO de su pedido, no la cantidad que quiere contratar. Sin
  // esta guarda se leía como "1 video" → por debajo del mínimo → y el bot le respondía
  // "nuestros paquetes son fijos, no manejamos otras cantidades" a alguien que acababa de
  // elegir uno. Se limita a las cantidades por debajo del mínimo, que son las que
  // disparan esa respuesta de rechazo: una cantidad mayor ("20 videos, más que el Pro")
  // sigue siendo un lead real y debe detectarse aunque nombre un paquete.
  if (count < MIN_PACKAGE_VIDEOS && mentionsCatalogPackage(text)) return null;

  return count;
}

export {
  VIDEO_PACKAGES,
  PACKAGE_SIZES,
  PACKAGE_PRICES,
  PACKAGE_NAMES,
  PACKAGES_WITH_DRONE,
  PACKAGES_WITHOUT_DRONE,
  MIN_PACKAGE_VIDEOS,
  MAX_PACKAGE_VIDEOS,
  joinList,
  renderDroneClientLine,
  renderDroneRule,
  renderPackagesWithDrone,
  detectDroneRequest,
  mentionsCatalogPackage,
  findPackageByName,
  renderPackageSizes,
  renderPackagePrices,
  renderPackageFlyerLines,
  renderPackageNameExamples,
  renderPackageNamesList,
  renderPackageCatalog,
  renderPackageNameMap,
  renderPackagePriceMap,
  renderQuantityExamples,
  classifyVideoQuantity,
  detectRequestedVideoCount,
};
export type { VideoPackage, VideoQuantityClass };

// Pruebas de la promo temporal y del filtro de vigencia de materiales.
//
//   npm test            (usa el type-stripping nativo de Node, sin dependencias)
//
// Conviene correrlo también con TZ=UTC y TZ=America/La_Paz: el corte de vencimiento no
// debe depender de la zona horaria del servidor (Vercel corre en UTC).

import assert from "node:assert/strict";
import {
  getActivePromoAmounts,
  getActivePromos,
  isPromoIntentActive,
  renderPromoContext,
} from "./promos.ts";
import { isMediaAssetInWindow } from "./media-assets.ts";

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

const at = (iso: string) => new Date(iso);
const PROMO = "service_packages_promo" as const;

// --- Ventana de la promo (hora de Bolivia, UTC-4) ---------------------------

test("antes del 6 de agosto la promo NO está vigente", () => {
  assert.equal(isPromoIntentActive(PROMO, at("2026-08-05T23:59:59-04:00")), false);
});

test("el 6 de agosto a las 00:00 de Bolivia la promo YA está vigente", () => {
  assert.equal(isPromoIntentActive(PROMO, at("2026-08-06T00:00:00-04:00")), true);
});

test("el 7 de agosto a las 23:59 de Bolivia la promo SIGUE vigente", () => {
  assert.equal(isPromoIntentActive(PROMO, at("2026-08-07T23:59:59-04:00")), true);
});

test("el 8 de agosto a las 00:00 de Bolivia la promo YA NO está vigente", () => {
  assert.equal(isPromoIntentActive(PROMO, at("2026-08-08T00:00:00-04:00")), false);
});

test("el 8 de agosto a las 04:00 UTC (= 00:00 Bolivia) ya no está vigente", () => {
  assert.equal(isPromoIntentActive(PROMO, at("2026-08-08T04:00:00Z")), false);
});

test("el 8 de agosto a las 03:59 UTC (= 23:59 del 7 en Bolivia) sigue vigente", () => {
  assert.equal(isPromoIntentActive(PROMO, at("2026-08-08T03:59:00Z")), true);
});

test("mucho después (2027) la promo no revive", () => {
  assert.equal(isPromoIntentActive(PROMO, at("2027-08-06T12:00:00-04:00")), false);
});

// --- Monto de la promo (desambiguación con la promo del live) ---------------

test("durante la vigencia, 1000 figura como monto de promo activa", () => {
  assert.deepEqual(getActivePromoAmounts(at("2026-08-06T15:00:00-04:00")), [1000]);
});

test("vencida la promo, no hay montos activos (vuelve a mandar la promo del live)", () => {
  assert.deepEqual(getActivePromoAmounts(at("2026-08-08T00:00:01-04:00")), []);
});

// --- Contexto inyectado al prompt -------------------------------------------

test("vigente: el contexto trae precio, alcance y el intent correcto", () => {
  const context = renderPromoContext(at("2026-08-06T10:00:00-04:00"));
  assert.match(context, /1\.000 Bs/);
  assert.match(context, /4 videos/);
  assert.match(context, /un solo día/);
  assert.match(context, /intents\.service_packages_promo = true/);
  assert.match(context, /intents\.service_packages = false/);
});

test("vigente: el contexto dice que NO reemplaza a los paquetes normales", () => {
  const context = renderPromoContext(at("2026-08-06T10:00:00-04:00"));
  assert.match(context, /NO reemplaza a los paquetes de 6, 12 y 18 videos/);
});

test("vencida: el contexto ordena no inventar promos y no marcar el intent", () => {
  const context = renderPromoContext(at("2026-08-08T09:00:00-04:00"));
  assert.match(context, /NINGUNA vigente/);
  assert.match(context, /NUNCA inventes una promo/);
  assert.match(context, /NO marques intents\.service_packages_promo/);
  assert.doesNotMatch(context, /1\.000 Bs/);
});

test("vencida: getActivePromos queda vacío", () => {
  assert.equal(getActivePromos(at("2026-08-08T00:00:00-04:00")).length, 0);
});

// --- Filtro de vigencia de kapso_media_assets -------------------------------

const NOW = at("2026-08-06T12:00:00-04:00").getTime();
const AFTER = at("2026-08-08T00:00:00-04:00").getTime();

test("material sin fechas (flyers, QR, video de ubicación) siempre es válido", () => {
  assert.equal(isMediaAssetInWindow({}, NOW), true);
  assert.equal(isMediaAssetInWindow({ starts_at: null, expires_at: null }, AFTER), true);
});

test("material que aún no empieza no se envía", () => {
  assert.equal(
    isMediaAssetInWindow({ starts_at: "2026-08-06T00:00:00-04:00" }, at("2026-08-05T20:00:00-04:00").getTime()),
    false,
  );
});

test("la promo se envía dentro de su ventana", () => {
  assert.equal(
    isMediaAssetInWindow(
      { starts_at: "2026-08-06T00:00:00-04:00", expires_at: "2026-08-08T00:00:00-04:00" },
      NOW,
    ),
    true,
  );
});

test("expires_at es exclusivo: justo en ese instante ya no se envía", () => {
  assert.equal(
    isMediaAssetInWindow(
      { starts_at: "2026-08-06T00:00:00-04:00", expires_at: "2026-08-08T00:00:00-04:00" },
      AFTER,
    ),
    false,
  );
});

test("un segundo antes del vencimiento todavía se envía", () => {
  assert.equal(
    isMediaAssetInWindow(
      { starts_at: "2026-08-06T00:00:00-04:00", expires_at: "2026-08-08T00:00:00-04:00" },
      AFTER - 1000,
    ),
    true,
  );
});

test("el corte es el mismo en todos los formatos en que Supabase devuelve timestamptz", () => {
  const formatos = [
    "2026-08-08T04:00:00+00:00",
    "2026-08-08T04:00:00Z",
    "2026-08-08 04:00:00+00",
    "2026-08-08T00:00:00-04:00",
  ];

  for (const expires_at of formatos) {
    assert.equal(
      isMediaAssetInWindow({ expires_at }, at("2026-08-07T23:59:59-04:00").getTime()),
      true,
      expires_at,
    );
    assert.equal(isMediaAssetInWindow({ expires_at }, AFTER), false, expires_at);
  }
});

test("una fecha ilegible se ignora en vez de dejar al cliente sin material", () => {
  assert.equal(isMediaAssetInWindow({ expires_at: "no-es-una-fecha" }, AFTER), true);
  assert.equal(isMediaAssetInWindow({ starts_at: "" }, AFTER), true);
});

console.log(`TZ=${process.env.TZ ?? "(sistema)"} — ${passed} pruebas OK`);

if (failures.length > 0) {
  console.error(`\n${failures.length} FALLARON:`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}

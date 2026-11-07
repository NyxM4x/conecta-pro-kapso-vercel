// Pruebas de la promo temporal y del filtro de vigencia de materiales.
//
//   npm test            (usa el type-stripping nativo de Node, sin dependencias)
//
// Conviene correrlo también con TZ=UTC y TZ=America/La_Paz: el corte de vencimiento no
// debe depender de la zona horaria del servidor (Vercel corre en UTC).

import assert from "node:assert/strict";
import { renderPackageSizes } from "./packages.ts";
import { CTA_BODY_MAX_CHARS, PROMO_FORM_BUTTON_TEXT, canAttachButtonToReply } from "./site-links.ts";
import {
  EXPIRED_VIDEO_PROMO_REPLY,
  acknowledgesExpiredVideoPromo,
  getExpiredPromoAmounts,
  mentionsExpiredVideoPromo,
  PROMOS,
  findActivePromo,
  getActiveTextPromo,
  isPromoClientText,
  getActivePromoAmounts,
  getActivePromoPrices,
  getActivePromos,
  getActiveReliefCampaigns,
  getClosedReliefCampaigns,
  getReliefClosedReply,
  isPromoIntentActive,
  mentionsReliefCampaign,
  renderPromoContext,
  renderReliefContext,
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
  // Las cantidades salen del catálogo (lib/packages.ts), no escritas a mano: si cambian
  // los paquetes, este texto tiene que cambiar solo.
  assert.ok(
    context.includes(`NO reemplaza a los paquetes de ${renderPackageSizes()} videos`),
    context,
  );
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

// --- Campaña de apoyo de la feria Barrio Lindo (CERRADA) --------------------
//
// Se cerró a mano el 17 de agosto de 2026, antes de que expirara su ventana (que iba
// hasta el 12 de septiembre): el alcance superó la capacidad del equipo. Estas pruebas
// fijan las dos garantías que se pidieron — la campaña no se ofrece más, y los mismos
// disparadores ahora producen un cierre sin formulario y sin pasar el caso a un asesor.

const HOY = at("2026-08-17T10:00:00-04:00");

test("status closed manda sobre las fechas: hoy la campaña NO está vigente", () => {
  // Dentro de la ventana original (11 ago → 12 sep), pero cerrada a mano.
  assert.equal(getActiveReliefCampaigns(HOY).length, 0);
});

test("ni siquiera el día que arrancó la ventana la reabre", () => {
  assert.equal(getActiveReliefCampaigns(at("2026-08-11T00:00:00-04:00")).length, 0);
});

test("hoy sí figura como campaña CERRADA (el bot debe saber responderla)", () => {
  const closed = getClosedReliefCampaigns(HOY);
  assert.equal(closed.length, 1);
  assert.equal(closed[0].id, "relief_feria_barrio_lindo_2026_08");
});

test("pasada la gracia de 60 días el cierre desaparece solo del prompt", () => {
  // endsAt = 12 sep 2026; +60 días ≈ 11 nov. En enero ya no queda nada.
  assert.equal(getClosedReliefCampaigns(at("2027-01-15T10:00:00-04:00")).length, 0);
  assert.doesNotMatch(
    renderReliefContext(at("2027-01-15T10:00:00-04:00")),
    /Barrio Lindo/,
  );
});

test("los disparadores del cliente siguen reconociéndose tras el cierre", () => {
  for (const mensaje of [
    "hola, soy comerciante de la feria Barrio Lindo",
    "se me quemó todo en el incendio",
    "perdí toda mi mercadería",
    "quemaron mi puesto la semana pasada",
    "vi que tenían apoyo por el INCENDIO",
  ]) {
    assert.equal(mentionsReliefCampaign(mensaje, HOY), true, mensaje);
  }
});

test("un mensaje comercial normal no dispara el cierre", () => {
  assert.equal(mentionsReliefCampaign("quiero el paquete de 12 videos", HOY), false);
  assert.equal(mentionsReliefCampaign("", HOY), false);
});

test("getReliefClosedReply devuelve el texto de cierre, no un descuento", () => {
  const reply = getReliefClosedReply("soy de la feria barrio lindo", HOY);
  assert.ok(reply);
  assert.match(reply, /ya no se encuentra vigente/);
  assert.match(reply, /saturado/);
  assert.doesNotMatch(reply, /50\s*%/);
  assert.doesNotMatch(reply, /asesor/);
});

test("getReliefClosedReply es null si el mensaje no habla de la campaña", () => {
  assert.equal(getReliefClosedReply("cuánto cuesta el paquete pro", HOY), null);
});

test("el contexto de hoy ordena cerrar: sin 50%, sin formulario, sin asesor", () => {
  const context = renderReliefContext(HOY);
  assert.match(context, /CAMPAÑAS DE APOYO CERRADAS/);
  assert.match(context, /CERRADA\. Ya no admite nuevos casos/);
  assert.match(context, /NUNCA envíes el formulario de datos de leads/);
  assert.match(context, /NUNCA insinúes que todavía podría alcanzarle/);
  // Lo que el bot decía antes y ya no debe decir.
  assert.doesNotMatch(context, /50% de descuento sobre CUALQUIER paquete/);
  assert.doesNotMatch(context, /un asesor valida tu caso/);
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

// --- Promo de 4 videos por 999 Bs (texto oficial, sin imagen) ----------------------

const IN_999 = at("2026-11-10T12:00:00-04:00");
const PROMO_999 = PROMOS.find((promo) => promo.id === "promo_4_videos_999_2026_10")!;

test("la promo de 999 está vigente en su ventana y se responde con texto", () => {
  assert.equal(isPromoIntentActive(PROMO, IN_999), true);
  assert.equal(getActiveTextPromo(IN_999)?.id, PROMO_999.id);
  // 1000 es su apodo ("el paquete de 1000 Bs"): con él, "promo 1000" no es la promo del live.
  assert.deepEqual(getActivePromoAmounts(IN_999), [999, 1000]);
  // Como número suelto solo cuenta el precio exacto.
  assert.deepEqual(getActivePromoPrices(IN_999), [999]);
});

test("antes y después de su ventana la promo de 999 no existe", () => {
  assert.equal(getActiveTextPromo(at("2026-11-06T23:59:59-04:00")), null);
  assert.equal(getActiveTextPromo(at(PROMO_999.endsAt)), null);
  assert.equal(findActivePromo(PROMO_999.slug, at(PROMO_999.endsAt)), null);
});

test("la promo se encuentra por su slug (link del bot) y por su nombre corto (formulario)", () => {
  assert.equal(findActivePromo("promo-4-videos", IN_999)?.id, PROMO_999.id);
  assert.equal(findActivePromo("Promo 4 videos", IN_999)?.id, PROMO_999.id);
  assert.equal(findActivePromo("Pro", IN_999), null);
  assert.ok(PROMO_999.shortName.length <= 40);
});

test("el texto oficial trae el precio, los 4 videos y la presentadora", () => {
  const text = PROMO_999.clientText ?? "";
  assert.match(text, /4 VIDEOS PROFESIONALES POR SOLO 999 Bs/);
  assert.match(text, /Presentadora profesional: \+200 Bs/);
  assert.match(text, /Publicidad en TikTok Ads: \+200 Bs/);
  assert.match(text, /válida hasta el 13 de noviembre/);
  assert.match(text, /¿Te gustaría reservar tu sesión/);
});

test("el texto oficial y su botón caben en UN solo mensaje de WhatsApp", () => {
  // Si el texto crece por encima del límite, el botón saldría en un mensaje aparte (cuesta
  // un mensaje más): esta prueba avisa antes de que pase.
  const text = PROMO_999.clientText ?? "";
  assert.equal(canAttachButtonToReply(text, false), true);
  assert.ok(text.length <= CTA_BODY_MAX_CHARS);
});

test("el texto oficial se reconoce en el historial; otros mensajes no", () => {
  assert.equal(isPromoClientText(PROMO_999.clientText ?? ""), true);
  assert.equal(isPromoClientText("¡Hola! Tenemos paquetes de 6, 12 y 18 videos"), false);
  assert.equal(isPromoClientText(""), false);
});

test("el contexto de la promo de 999 explica el texto oficial y el botón al aceptar", () => {
  const context = renderPromoContext(IN_999);
  assert.match(context, /999 Bs/);
  assert.match(context, /TEXTO OFICIAL/);
  assert.ok(context.includes(PROMO_FORM_BUTTON_TEXT));
  assert.match(context, /200 Bs adicionales \(en total 1199 Bs\)/);
  assert.doesNotMatch(context, /1\.000 Bs/);
});

test("el contexto avisa que el paquete exprés y el de 1000 Bs son esta promo", () => {
  const context = renderPromoContext(IN_999);
  assert.match(context, /"paquete exprés"/);
  assert.match(context, /NUNCA respondas que ese paquete no existe/);
  assert.match(context, /NO asumas: pregúntale/);
});

// --- Promo de 999 finalizada ------------------------------------------------------

const AFTER_999 = at("2026-11-14T12:00:00-04:00");

test("la promo de 999 ya no está vigente después del 13 de noviembre", () => {
  assert.equal(getActiveTextPromo(AFTER_999), null);
  assert.equal(isPromoIntentActive(PROMO, AFTER_999), false);
  assert.match(renderPromoContext(AFTER_999), /NINGUNA vigente/);
});

test("clientes que nombran la promo vencida son reconocidos", () => {
  for (const frase of [
    "Hola vi la promoción",
    "la promo de 999",
    "promo 1000",
    "¿siguen con la promoción de 1.000 Bs?",
    "4 videos por 999",
    "el paquete exprés",
    "quiero la promo de 4 videos",
  ]) {
    assert.equal(mentionsExpiredVideoPromo(frase, AFTER_999), true, frase);
  }
});

test("mensajes sin relación con la promo vencida no se marcan", () => {
  for (const frase of [
    "hola",
    "el paquete de 2500 Bs",
    "somos 4 en el equipo",
    "vi el curso de la promoción",
    "tengo 1000 seguidores",
    "",
  ]) {
    assert.equal(mentionsExpiredVideoPromo(frase, AFTER_999), false, frase);
  }
});

test("con la promo vigente no se marca como vencida", () => {
  assert.equal(mentionsExpiredVideoPromo("vi la promoción", IN_999), false);
});

test("los montos de las promos vencidas se excluyen de la promo del live", () => {
  assert.deepEqual(getExpiredPromoAmounts(AFTER_999), [999, 1000, 1000]);
});

test("la promo vale TODO el 13 de noviembre y muere el 14 a las 00:00 (Bolivia)", () => {
  assert.notEqual(getActiveTextPromo(at("2026-11-13T23:59:59-04:00")), null);
  assert.equal(getActiveTextPromo(at("2026-11-14T00:00:00-04:00")), null);
  assert.match(EXPIRED_VIDEO_PROMO_REPLY, /13 de noviembre/);
});

test("la respuesta que avisa del fin se reconoce; la que confirma el precio no", () => {
  assert.equal(acknowledgesExpiredVideoPromo(EXPIRED_VIDEO_PROMO_REPLY), true);
  assert.equal(acknowledgesExpiredVideoPromo("Sí, son 4 videos por 999 Bs"), false);
});

console.log(`TZ=${process.env.TZ ?? "(sistema)"} — ${passed} pruebas OK`);

if (failures.length > 0) {
  console.error(`\n${failures.length} FALLARON:`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}

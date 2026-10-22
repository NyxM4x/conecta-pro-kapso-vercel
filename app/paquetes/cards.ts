// Datos de las tarjetas que comparten /paquetes y /promocion. Los paquetes salen de
// lib/packages.ts y las promos de lib/promos.ts: no repetir precios ni cantidades acá.

import { VIDEO_PACKAGES } from "../../lib/packages";
import { getActivePromos } from "../../lib/promos";
import { packageSlug } from "../../lib/site-links";
import type { PackageCard, PromoCard } from "./PackagesView";

// Frase corta por paquete para la tarjeta. Si se agrega un paquete sin frase, la tarjeta
// muestra solo lo que incluye.
const TAGLINES: Record<string, string> = {
  Básico: "Para empezar a tener presencia constante en redes.",
  Normal: "Para publicar seguido y crecer mes a mes.",
  Pro: "Todo incluido: redes, Ads y tomas con dron.",
};

// Video de la portada de la ficha de cada paquete (por slug), sin extensión: ".mp4" es el
// video comprimido y ".jpg" su primer cuadro. Los originales están en material-original/.
// Un paquete sin video muestra el degradado de siempre.
const PACKAGE_VIDEOS: Record<string, string> = {
  pro: "/paquetes/paquetePro",
  normal: "/paquetes/paqueteNormal",
};

function buildPackageCards(): PackageCard[] {
  return VIDEO_PACKAGES.map((pkg) => ({
    name: pkg.name,
    slug: packageSlug(pkg.name),
    videos: pkg.videos,
    price: pkg.price,
    drone: pkg.drone,
    includes: pkg.includes,
    tagline: TAGLINES[pkg.name] ?? "",
    video: PACKAGE_VIDEOS[packageSlug(pkg.name)] ?? null,
    period: pkg.period,
  }));
}

// Promos vigentes en este instante: pasada su ventana dejan de aparecer solas. Las páginas
// se arman en cada pedido (leen searchParams), así que no quedan cacheadas.
function buildPromoCards(now: Date): PromoCard[] {
  return getActivePromos(now).map((promo) => ({
    slug: promo.slug,
    shortName: promo.shortName,
    videos: promo.videoCount,
    price: promo.price,
    includes: promo.includes,
    notes: promo.notes,
    presenterPrice: promo.presenterPrice ?? null,
    // endsAt es exclusivo: el último día vigente es el instante anterior.
    validUntil: new Intl.DateTimeFormat("es-BO", {
      timeZone: "America/La_Paz",
      weekday: "long",
      day: "numeric",
      month: "long",
    }).format(new Date(new Date(promo.endsAt).getTime() - 1)),
  }));
}

// La query tal cual llegó (?wa=…&t=…&p=…&f=1), para pasar de una página a la otra sin
// perder el número firmado.
function toQueryString(params: Record<string, string | string[] | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (first) query.set(key, first);
  }
  const text = query.toString();
  return text ? `?${text}` : "";
}

export { buildPackageCards, buildPromoCards, toQueryString };

// Página de paquetes que se abre en el navegador interno de WhatsApp. El bot puede mandar
// el link con el número del cliente (firmado) y un paquete preseleccionado:
//   /paquetes?wa=59171234567&t=<firma>&p=pro&f=1
// f=1 abre la hoja directo en el formulario. El link lo arma lib/site-links.ts.
// p también puede ser el slug de una promo vigente (?p=promo-4-videos&f=1).
// Los paquetes salen de lib/packages.ts: no repetir precios ni cantidades acá.

import type { Metadata } from "next";
import { VIDEO_PACKAGES } from "../../lib/packages";
import { getActivePromos } from "../../lib/promos";
import { packageSlug } from "../../lib/site-links";
import { PackagesView, type PackageCard, type PromoCard } from "./PackagesView";
import "./paquetes.css";

export const metadata: Metadata = {
  title: "Paquetes | Conecta Pro",
  description: "Elige tu paquete de contenido y un asesor te atiende por WhatsApp.",
};

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

export default async function PaquetesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? "";

  const packages: PackageCard[] = VIDEO_PACKAGES.map((pkg) => ({
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

  // Promos vigentes en este instante (lib/promos.ts): pasada su ventana dejan de aparecer
  // solas. La página se arma en cada pedido (lee searchParams), así que no queda cacheada.
  const promos: PromoCard[] = getActivePromos(new Date()).map((promo) => ({
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

  const preselected = first(params.p).toLowerCase();
  const knownSlugs = [...packages.map((pkg) => pkg.slug), ...promos.map((promo) => promo.slug)];

  return (
    <PackagesView
      packages={packages}
      promos={promos}
      originPhone={first(params.wa).replace(/\D/g, "")}
      // Firma del número: /api/leads la verifica antes de cerrar el lead en el chat.
      originToken={first(params.t).replace(/[^0-9a-f]/gi, "").slice(0, 16)}
      initialSlug={knownSlugs.includes(preselected) ? preselected : null}
      openForm={first(params.f) === "1"}
      // Número del WhatsApp de Conecta Pro para el botón "Volver a WhatsApp" al terminar.
      // Sin la variable, ese botón no aparece.
      businessWhatsapp={(process.env.CONECTA_PRO_WHATSAPP ?? "").replace(/\D/g, "")}
    />
  );
}

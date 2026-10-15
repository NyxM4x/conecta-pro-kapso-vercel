// Página de paquetes que se abre en el navegador interno de WhatsApp. El bot puede mandar
// el link con el número del cliente (firmado) y un paquete preseleccionado:
//   /paquetes?wa=59171234567&t=<firma>&p=pro&f=1
// f=1 abre la hoja directo en el formulario. El link lo arma lib/site-links.ts.
// Los paquetes salen de lib/packages.ts: no repetir precios ni cantidades acá.

import type { Metadata } from "next";
import { VIDEO_PACKAGES } from "../../lib/packages";
import { packageSlug } from "../../lib/site-links";
import { PackagesView, type PackageCard } from "./PackagesView";
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
  }));

  const preselected = first(params.p).toLowerCase();

  return (
    <PackagesView
      packages={packages}
      originPhone={first(params.wa).replace(/\D/g, "")}
      // Firma del número: /api/leads la verifica antes de cerrar el lead en el chat.
      originToken={first(params.t).replace(/[^0-9a-f]/gi, "").slice(0, 16)}
      initialSlug={packages.some((pkg) => pkg.slug === preselected) ? preselected : null}
      openForm={first(params.f) === "1"}
      // Número del WhatsApp de Conecta Pro para el botón "Volver a WhatsApp" al terminar.
      // Sin la variable, ese botón no aparece.
      businessWhatsapp={(process.env.CONECTA_PRO_WHATSAPP ?? "").replace(/\D/g, "")}
    />
  );
}

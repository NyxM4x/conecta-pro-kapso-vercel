// Página de paquetes que se abre en el navegador interno de WhatsApp. El bot puede mandar
// el link con el número del cliente (firmado) y un paquete preseleccionado:
//   /paquetes?wa=59171234567&t=<firma>&p=pro&f=1
// f=1 abre la hoja directo en el formulario. El link lo arma lib/site-links.ts.
// Solo muestra los paquetes del catálogo: la promo vigente tiene su página, /promocion.
// Antes la promo iba arriba de los paquetes y quien pedía los paquetes veía primero la promo.

import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { buildPackageCards, buildPromoCards, toQueryString } from "./cards";
import { PackagesView } from "./PackagesView";
import "./paquetes.css";

export const metadata: Metadata = {
  title: "Paquetes | Conecta Pro",
  description: "Elige tu paquete de contenido y un asesor te atiende por WhatsApp.",
};

export default async function PaquetesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? "";

  const packages = buildPackageCards();
  const promos = buildPromoCards(new Date());
  const preselected = first(params.p).toLowerCase();

  // Links de la promo que el bot mandó antes de que existiera /promocion
  // (/paquetes?p=promo-4-videos&f=1): siguen abriendo la promo, con el número firmado.
  if (promos.some((promo) => promo.slug === preselected)) {
    redirect(`/promocion${toQueryString(params)}`);
  }

  return (
    <PackagesView
      view="packages"
      packages={packages}
      promos={promos}
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

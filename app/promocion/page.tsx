// Página de la promoción vigente (lib/promos.ts), aparte de /paquetes. El bot manda acá el
// botón "Llenar mis datos" de la promo, con el número firmado y la hoja ya en el formulario:
//   /promocion?wa=59171234567&t=<firma>&p=promo-4-videos&f=1
// Usa la misma vista, estilos y formulario que /paquetes (app/paquetes/PackagesView.tsx).
// Sin ninguna promo vigente no hay nada que mostrar: lleva a /paquetes.

import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { buildPackageCards, buildPromoCards, toQueryString } from "../paquetes/cards";
import { PackagesView } from "../paquetes/PackagesView";
import "../paquetes/paquetes.css";

export const metadata: Metadata = {
  title: "Promoción | Conecta Pro",
  description: "Promoción especial de videos para tu negocio. Deja tus datos y un asesor te agenda la fecha.",
};

export default async function PromocionPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? "";

  const promos = buildPromoCards(new Date());
  if (promos.length === 0) {
    // El ?p= de la promo vencida no sirve en /paquetes: se va, y queda el número firmado.
    const { p: _promo, f: _form, ...rest } = params;
    redirect(`/paquetes${toQueryString(rest)}`);
  }

  const preselected = first(params.p).toLowerCase();

  return (
    <PackagesView
      view="promo"
      packages={buildPackageCards()}
      promos={promos}
      originPhone={first(params.wa).replace(/\D/g, "")}
      originToken={first(params.t).replace(/[^0-9a-f]/gi, "").slice(0, 16)}
      initialSlug={promos.some((promo) => promo.slug === preselected) ? preselected : null}
      openForm={first(params.f) === "1"}
      businessWhatsapp={(process.env.CONECTA_PRO_WHATSAPP ?? "").replace(/\D/g, "")}
    />
  );
}

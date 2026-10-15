// Página para pedir una reunión en la oficina, que se abre desde el botón "Agendar visita"
// del bot:
//   /oficina?wa=59171234567&t=<firma>&tipo=negocio|agente|curso
// Es el mismo flujo que el bot seguía por chat, con sus textos (lib/office-form.ts): nadie
// viene sin coordinar, un asesor llama para acordar el día y la hora.

import type { Metadata } from "next";
import { OFFICE_FORMS, isOfficeVisitType } from "../../lib/office-form";
import { OfficeView } from "./OfficeView";
import "../paquetes/paquetes.css";
import "./oficina.css";

export const metadata: Metadata = {
  title: "Visítanos | Conecta Pro",
  description: "Agenda una reunión en la oficina de Conecta Pro: un asesor te llama para coordinarla.",
};

export default async function OficinaPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? "";
  const tipo = first(params.tipo);
  const visitType = isOfficeVisitType(tipo) ? tipo : "negocio";

  return (
    <OfficeView
      visitType={visitType}
      form={OFFICE_FORMS[visitType]}
      originPhone={first(params.wa).replace(/\D/g, "")}
      originToken={first(params.t).replace(/[^0-9a-f]/gi, "").slice(0, 16)}
      businessWhatsapp={(process.env.CONECTA_PRO_WHATSAPP ?? "").replace(/\D/g, "")}
    />
  );
}

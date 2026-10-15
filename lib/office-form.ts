// Formulario de la página /oficina: pedir una reunión en la oficina de Conecta Pro.
//
// Es el mismo flujo que el bot seguía por chat (OFFICE_VISIT_* en
// app/api/webhooks/kapso/route.ts), con sus mismos textos, pero dentro de la página: nadie
// viene sin coordinar, así que el cliente deja sus datos y un asesor lo llama para acordar
// el día y la hora. Tres casos, según a qué viene:
//   - negocio: los servicios de video → los datos del formulario de paquetes.
//   - agente:  el agente de IA        → los datos de la LÍNEA C.
//   - curso:   un curso               → solo su nombre y sus dudas del curso.
// El número no se pide: es el WhatsApp de quien tocó el botón del bot (?wa=).
//
// Sin dependencias de Next para que lo usen la página, /api/leads y las pruebas con Node.

import { escapeTelegramHtml } from "./telegram.ts";

type OfficeVisitType = "negocio" | "agente" | "curso";

type OfficeField = {
  key: string;
  label: string;
  placeholder: string;
  required: boolean;
  kind: "text" | "textarea";
  maxLength: number;
};

type OfficeForm = {
  // Para qué es la reunión, en la etiqueta y en el aviso al asesor.
  label: string;
  intro: string;
  fields: OfficeField[];
};

const BUSINESS_INTRO =
  "¡Con gusto te recibimos! 😊 Antes de confirmar una reunión en nuestra oficina, un asesor te llamará para coordinarla y conocer más de tu negocio. Así te atiende primero por llamada y llegan a la reunión con todo claro.";

const OFFICE_FORMS: Record<OfficeVisitType, OfficeForm> = {
  negocio: {
    label: "Servicios de video",
    intro: BUSINESS_INTRO,
    fields: [
      { key: "name", label: "Nombre", placeholder: "Tu nombre", required: true, kind: "text", maxLength: 80 },
      { key: "company", label: "Nombre de tu empresa o emprendimiento", placeholder: "Ej. Café Aroma", required: true, kind: "text", maxLength: 100 },
      { key: "role", label: "Cargo dentro de la empresa", placeholder: "Ej. Dueño, gerente, marketing", required: false, kind: "text", maxLength: 80 },
      { key: "sector", label: "Rubro o sector", placeholder: "Gastronomía, belleza, moda, salud…", required: true, kind: "text", maxLength: 80 },
      { key: "social", label: "Instagram o redes sociales", placeholder: "@tunegocio", required: false, kind: "text", maxLength: 150 },
      { key: "contentType", label: "¿Qué tipo de contenido te interesa?", placeholder: "Videos, contenido con creadores…", required: false, kind: "text", maxLength: 150 },
      { key: "reference", label: "¿Tienes alguna referencia de contenido que te guste?", placeholder: "Pega un link o descríbela (opcional)", required: false, kind: "textarea", maxLength: 500 },
    ],
  },
  agente: {
    label: "Agente de IA",
    intro: BUSINESS_INTRO,
    fields: [
      { key: "name", label: "Nombre", placeholder: "Tu nombre", required: true, kind: "text", maxLength: 80 },
      { key: "business", label: "Nombre de tu negocio y rubro", placeholder: "Ej. Café Aroma, gastronomía", required: true, kind: "text", maxLength: 150 },
      { key: "messages", label: "¿Cuántos mensajes reciben al día aproximadamente?", placeholder: "Ej. 50", required: false, kind: "text", maxLength: 60 },
      { key: "branches", label: "¿Tienen una sola sucursal o varias?", placeholder: "Ej. 2 sucursales", required: false, kind: "text", maxLength: 80 },
    ],
  },
  curso: {
    label: "Curso",
    intro:
      "¡Con gusto! 😊 Para visitarnos en la oficina, un asesor te llamará y te indicará la hora, así nos aseguramos de que alguien esté disponible para atenderte 📞 Mientras tanto, cuéntanos: ¿qué dudas tienes sobre el curso? Así el asesor te llama con todo listo.",
    fields: [
      { key: "name", label: "Nombre", placeholder: "Tu nombre", required: true, kind: "text", maxLength: 80 },
      { key: "doubts", label: "¿Qué dudas tienes sobre el curso?", placeholder: "Escribe tus dudas (opcional)", required: false, kind: "textarea", maxLength: 500 },
    ],
  },
};

function isOfficeVisitType(value: unknown): value is OfficeVisitType {
  return value === "negocio" || value === "agente" || value === "curso";
}

type OfficeVisitInput = {
  type: OfficeVisitType;
  values: Record<string, string>;
  // WhatsApp de quien tocó el botón del bot. Es el contacto.
  originPhone?: string;
};

function validateOfficeVisit(
  raw: Record<string, unknown>,
): { ok: true; visit: OfficeVisitInput } | { ok: false; errors: string[] } {
  if (!isOfficeVisitType(raw.visitType)) return { ok: false, errors: ["Motivo de la visita"] };

  const form = OFFICE_FORMS[raw.visitType];
  const errors: string[] = [];
  const values: Record<string, string> = {};

  for (const field of form.fields) {
    const value = typeof raw[field.key] === "string" ? (raw[field.key] as string).trim() : "";
    if (field.required && !value) errors.push(field.label);
    values[field.key] = value.slice(0, field.maxLength);
  }

  const visit: OfficeVisitInput = { type: raw.visitType, values };
  const origin = typeof raw.originPhone === "string" ? raw.originPhone.replace(/\D/g, "") : "";
  if (origin.length >= 7 && origin.length <= 15) visit.originPhone = origin;

  return errors.length > 0 ? { ok: false, errors } : { ok: true, visit };
}

// Aviso al grupo de asesores (parse_mode HTML). Mismo encabezado que el lead del chat con
// visita: el asesor tiene que llamarlo para coordinar día y hora.
function buildOfficeVisitTelegramMessage(
  visit: OfficeVisitInput,
  options: { verified?: boolean; alreadyLeadInChat?: boolean } = {},
): string {
  const e = (text: string) => escapeTelegramHtml(text);
  const form = OFFICE_FORMS[visit.type];

  const contactLines = visit.originPhone
    ? [
        `📞 WhatsApp: +${visit.originPhone}${options.verified ? "" : " (sin verificar)"}`,
        `👉 Abrir chat: https://wa.me/${visit.originPhone}`,
      ]
    : ["⚠️ Sin número: abrió la página sin pasar por el botón del bot"];

  const lines = [
    "🏢 <b>Quiere reunirse en la oficina — Conecta Pro</b>",
    `🎯 Motivo: <b>${e(form.label)}</b>`,
    "📞 Llámalo para coordinar el día y la hora (nadie le confirmó una cita)",
    "",
    ...contactLines,
  ];

  for (const field of form.fields) {
    const value = visit.values[field.key];
    if (value) lines.push(`• ${e(field.label)}: ${e(value)}`);
  }

  if (options.alreadyLeadInChat) {
    lines.push("", "ℹ️ Ya había dejado sus datos antes: es el mismo cliente, no un lead nuevo");
  }

  return lines.join("\n");
}

export {
  OFFICE_FORMS,
  buildOfficeVisitTelegramMessage,
  isOfficeVisitType,
  validateOfficeVisit,
};
export type { OfficeField, OfficeForm, OfficeVisitInput, OfficeVisitType };

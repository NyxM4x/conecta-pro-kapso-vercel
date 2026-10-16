// Formulario de leads de la página /paquetes: se abre desde el navegador interno de
// WhatsApp y el cliente deja los mismos datos que el bot pide por chat
// (LEAD_INTAKE_FIELDS en app/api/webhooks/kapso/route.ts). Si cambian esas preguntas,
// cambiarlas también acá.
//
// No se pide el número: el contacto es el WhatsApp de quien tocó el botón del bot, que
// Kapso ya conoce y viaja en el link (?wa=, ver lib/site-links.ts).
//
// Sin dependencias de Next ni de zod para que lo puedan usar la página (cliente), la ruta
// /api/leads (servidor) y las pruebas con Node a secas.

import { escapeTelegramHtml } from "./telegram.ts";

type LeadFieldKey =
  | "name"
  | "company"
  | "role"
  | "sector"
  | "social"
  | "contentType"
  | "reference";

type LeadField = {
  key: LeadFieldKey;
  label: string;
  placeholder: string;
  required: boolean;
  kind: "text" | "textarea" | "chips";
  maxLength: number;
};

const LEAD_FIELDS: LeadField[] = [
  { key: "name", label: "Nombre", placeholder: "Tu nombre", required: true, kind: "text", maxLength: 80 },
  { key: "company", label: "Nombre de tu empresa o emprendimiento", placeholder: "Ej. Café Aroma", required: true, kind: "text", maxLength: 100 },
  { key: "role", label: "Cargo dentro de la empresa", placeholder: "Ej. Dueño, gerente, marketing", required: true, kind: "text", maxLength: 80 },
  { key: "sector", label: "Rubro o sector", placeholder: "Gastronomía, belleza, moda, salud…", required: true, kind: "text", maxLength: 80 },
  { key: "social", label: "Instagram o redes sociales", placeholder: "@tunegocio", required: true, kind: "text", maxLength: 150 },
  { key: "contentType", label: "¿Qué tipo de contenido te interesa?", placeholder: "", required: true, kind: "chips", maxLength: 150 },
  { key: "reference", label: "¿Tienes alguna referencia de contenido que te guste?", placeholder: "Pega un link o descríbela (opcional)", required: false, kind: "textarea", maxLength: 500 },
];

// Opciones de "¿Qué tipo de contenido te interesa?". Sin "Fotos": no es un servicio que se
// ofrezca por separado (aunque el bot todavía lo nombra de ejemplo en LEAD_INTAKE_FIELDS).
const CONTENT_TYPE_OPTIONS = [
  "Videos",
  "Contenido con creadores",
  "Marca personal",
  "Marketing agresivo",
  "Incrementar ventas",
];

// Preguntas extra del formulario de una PROMOCIÓN (lib/promos.ts). Los paquetes del
// catálogo no las tienen: solo la promo ofrece presentadora y se agenda por fecha.
type PresenterChoice = "owner" | "presenter";

const PRESENTER_OPTIONS: { value: PresenterChoice; label: string }[] = [
  { value: "owner", label: "Saldrá el dueño del negocio (recomendado)" },
  { value: "presenter", label: "Quiero presentadora profesional" },
];

const PREFERRED_DATE_MAX_LENGTH = 80;

type LeadInput = Record<LeadFieldKey, string> & {
  // Nombre del paquete elegido, tal cual está en VIDEO_PACKAGES, o el nombre corto de la
  // promo (Promo.shortName).
  packageName: string;
  // WhatsApp de quien tocó el botón del bot (?wa=). Es el contacto del lead; falta solo si
  // alguien abrió la página sin pasar por el bot.
  originPhone?: string;
  // Solo en el formulario de una promo.
  presenter?: PresenterChoice;
  preferredDate?: string;
};

// Recorta y valida lo que manda el formulario. Devuelve los datos limpios o la lista de
// etiquetas que faltan / no son válidas, para mostrársela al cliente.
function validateLead(
  raw: Record<string, unknown>,
): { ok: true; lead: LeadInput } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const lead = {} as LeadInput;

  for (const field of LEAD_FIELDS) {
    const value = typeof raw[field.key] === "string" ? (raw[field.key] as string).trim() : "";
    if (field.required && !value) errors.push(field.label);
    lead[field.key] = value.slice(0, field.maxLength);
  }

  lead.packageName = typeof raw.packageName === "string" ? raw.packageName.trim().slice(0, 40) : "";
  if (!lead.packageName) errors.push("Paquete");

  const origin = typeof raw.originPhone === "string" ? raw.originPhone.replace(/\D/g, "") : "";
  if (origin.length >= 7 && origin.length <= 15) lead.originPhone = origin;

  // Extras de la promo: si vienen se guardan; que sean obligatorios lo decide /api/leads,
  // que es quien sabe si el paquete es una promo.
  if (PRESENTER_OPTIONS.some((option) => option.value === raw.presenter)) {
    lead.presenter = raw.presenter as PresenterChoice;
  }
  const preferredDate =
    typeof raw.preferredDate === "string" ? raw.preferredDate.trim().slice(0, PREFERRED_DATE_MAX_LENGTH) : "";
  if (preferredDate) lead.preferredDate = preferredDate;

  return errors.length > 0 ? { ok: false, errors: [...new Set(errors)] } : { ok: true, lead };
}

type LeadMessageOptions = {
  // La firma del link coincide: el número es de verdad el del chat que recibió el botón.
  verified?: boolean;
  // Ya había dejado sus datos por el chat: el asesor no debe tratarlo como un lead nuevo.
  alreadyLeadInChat?: boolean;
  // El lead es de una promoción: precio de la presentadora (si la promo la ofrece).
  promo?: { presenterPrice?: number };
};

// Mensaje del lead para el grupo de asesores (parse_mode HTML).
function buildLeadTelegramMessage(
  lead: LeadInput,
  packageLabel: string,
  options: LeadMessageOptions = {},
): string {
  const e = (text: string) => escapeTelegramHtml(text);

  const contactLines = lead.originPhone
    ? [
        `📞 WhatsApp: +${lead.originPhone}${options.verified ? "" : " (sin verificar)"}`,
        `👉 Abrir chat: https://wa.me/${lead.originPhone}`,
      ]
    : ["⚠️ Sin número: abrió la página sin pasar por el botón del bot"];

  const lines = [
    options.promo
      ? "🔥 <b>Nuevo lead de PROMOCIÓN desde la web — Conecta Pro</b>"
      : "🌐 <b>Nuevo lead desde la web — Conecta Pro</b>",
    `${options.promo ? "🎁 Promo" : "📦 Paquete"}: <b>${e(packageLabel)}</b>`,
  ];

  if (options.promo && lead.presenter) {
    lines.push(
      lead.presenter === "presenter"
        ? `🎤 Presentadora: <b>Sí</b>${options.promo.presenterPrice ? ` (+${options.promo.presenterPrice} Bs)` : ""}`
        : "🎤 Presentadora: No, sale el dueño del negocio",
    );
  }
  if (options.promo && lead.preferredDate) lines.push(`📅 Fecha tentativa: ${e(lead.preferredDate)}`);

  lines.push(
    "",
    `👤 Nombre: ${e(lead.name)}`,
    `🏢 Empresa: ${e(lead.company)}`,
    `💼 Cargo: ${e(lead.role)}`,
    ...contactLines,
    `🏷️ Rubro: ${e(lead.sector)}`,
    `📲 Redes: ${e(lead.social)}`,
    `🎬 Contenido: ${e(lead.contentType)}`,
  );

  if (lead.reference) lines.push(`✨ Referencia: ${e(lead.reference)}`);
  if (options.alreadyLeadInChat) {
    lines.push("", "ℹ️ Ya había dejado sus datos por el chat: es el mismo cliente, no un lead nuevo");
  }

  return lines.join("\n");
}

export {
  LEAD_FIELDS,
  CONTENT_TYPE_OPTIONS,
  PRESENTER_OPTIONS,
  PREFERRED_DATE_MAX_LENGTH,
  validateLead,
  buildLeadTelegramMessage,
};
export type { LeadField, LeadFieldKey, LeadInput, LeadMessageOptions, PresenterChoice };

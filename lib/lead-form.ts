// Formulario de leads de la página /paquetes: se abre desde el navegador interno de
// WhatsApp y el cliente deja los mismos datos que el bot pide por chat
// (LEAD_INTAKE_FIELDS en app/api/webhooks/kapso/route.ts). Si cambian esas preguntas,
// cambiarlas también acá.
//
// Sin dependencias de Next ni de zod para que lo puedan usar la página (cliente), la ruta
// /api/leads (servidor) y las pruebas con Node a secas.

import { escapeTelegramHtml } from "./telegram.ts";

type LeadFieldKey =
  | "name"
  | "company"
  | "role"
  | "phone"
  | "sector"
  | "social"
  | "contentType"
  | "reference";

type LeadField = {
  key: LeadFieldKey;
  label: string;
  placeholder: string;
  required: boolean;
  kind: "text" | "tel" | "textarea" | "chips";
  maxLength: number;
};

const LEAD_FIELDS: LeadField[] = [
  { key: "name", label: "Nombre", placeholder: "Tu nombre", required: true, kind: "text", maxLength: 80 },
  { key: "company", label: "Nombre de tu empresa o emprendimiento", placeholder: "Ej. Café Aroma", required: true, kind: "text", maxLength: 100 },
  { key: "role", label: "Cargo dentro de la empresa", placeholder: "Ej. Dueño, gerente, marketing", required: true, kind: "text", maxLength: 80 },
  { key: "phone", label: "Número de contacto personal", placeholder: "Ej. 71234567", required: true, kind: "tel", maxLength: 20 },
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

type LeadInput = Record<LeadFieldKey, string> & {
  // Nombre del paquete elegido, tal cual está en VIDEO_PACKAGES.
  packageName: string;
  // Número de WhatsApp con el que el bot mandó el link (?wa=), si vino.
  originPhone?: string;
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

  if (lead.phone && lead.phone.replace(/\D/g, "").length < 7) {
    errors.push("Número de contacto personal");
  }

  lead.packageName = typeof raw.packageName === "string" ? raw.packageName.trim().slice(0, 40) : "";
  if (!lead.packageName) errors.push("Paquete");

  const origin = typeof raw.originPhone === "string" ? raw.originPhone.replace(/\D/g, "") : "";
  if (origin.length >= 7 && origin.length <= 15) lead.originPhone = origin;

  return errors.length > 0 ? { ok: false, errors: [...new Set(errors)] } : { ok: true, lead };
}

// Celular para wa.me: los clientes lo escriben con espacios, guiones o sin el 591. Un
// número boliviano de 8 dígitos se completa con el código de país.
function toWhatsappDigits(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 8 && /^[67]/.test(digits)) return `591${digits}`;
  return digits;
}

// Mensaje del lead para el grupo de asesores (parse_mode HTML).
function buildLeadTelegramMessage(lead: LeadInput, packageLabel: string): string {
  const e = (text: string) => escapeTelegramHtml(text);
  const contact = toWhatsappDigits(lead.phone);

  const lines = [
    "🌐 <b>Nuevo lead desde la web — Conecta Pro</b>",
    `📦 Paquete: <b>${e(packageLabel)}</b>`,
    "",
    `👤 Nombre: ${e(lead.name)}`,
    `🏢 Empresa: ${e(lead.company)}`,
    `💼 Cargo: ${e(lead.role)}`,
    `📞 Contacto: ${e(lead.phone)}`,
    `👉 Abrir chat: https://wa.me/${contact}`,
    `🏷️ Rubro: ${e(lead.sector)}`,
    `📲 Redes: ${e(lead.social)}`,
    `🎬 Contenido: ${e(lead.contentType)}`,
  ];

  if (lead.reference) lines.push(`✨ Referencia: ${e(lead.reference)}`);

  // El número desde el que abrió el link puede no ser el que dejó como contacto.
  if (lead.originPhone && lead.originPhone !== contact) {
    lines.push("", `💬 Abrió el link desde el WhatsApp: https://wa.me/${lead.originPhone}`);
  }

  return lines.join("\n");
}

export {
  LEAD_FIELDS,
  CONTENT_TYPE_OPTIONS,
  validateLead,
  toWhatsappDigits,
  buildLeadTelegramMessage,
};
export type { LeadField, LeadFieldKey, LeadInput };

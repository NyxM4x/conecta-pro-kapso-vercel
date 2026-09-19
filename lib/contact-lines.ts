// NOMBRE Y CELULAR que un cliente escribe por el chat ("Aleida Patricia Trujillo Rivera ⏎
// Tel: 68652085"). Lo usan la lista de pagos (lib/course-enrollments.ts) y la alerta 💰
// (lib/payment-alerts.ts), que le pide esos datos al cliente después del comprobante.
// Vive aparte para que esos dos módulos no se importen entre sí.

const normalize = (text: string) =>
  String(text ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase();

// Celular boliviano: 8 dígitos que empiezan con 6 o 7, con o sin +591 y separadores.
const BOLIVIAN_MOBILE = /(?:\+?\s*591[\s-]*)?\b([67](?:[\s-]?\d){7})\b/g;

// Prefijos que la gente escribe antes del dato ("Nombre completo:", "Mi número es").
const FIELD_PREFIX =
  /^\s*(?:📌\s*)?(?:(?:MI\s+)?NOMBRE(?:\s+COMPLETO)?(?:\s+ES)?|NOMBRES?|SOY|(?:MI\s+)?(?:NUMERO|NRO|CELULAR|CEL|TELEFONO|TEL|WHATSAPP)(?:\s+DE\s+(?:CELULAR|TELEFONO))?(?:\s+ES)?)\s*[:.\-]?\s*/;

// Palabras que delatan una frase de conversación, no un nombre: saludos, pronombres, verbos
// y vocabulario del chat que aparecieron en los mensajes reales alrededor de los pagos.
const NOT_A_NAME = new RegExp(
  `\\b(${[
    "HOLA", "BUENAS", "BUENOS", "BUEN", "DIA", "DIAS", "TARDES", "NOCHES", "GRACIAS", "GRAC", "OKI", "OK", "OKEY", "LISTO", "SALUDOS",
    "CURSO", "CURSOS", "CLASE", "CLASES", "CREACION", "CONTENIDO", "EDICION", "CAPCUT", "LIVE", "PROMO", "TALLER",
    "QR", "PAGO", "PAGAR", "PAGUE", "PAGADO", "COMPROBANTE", "PRECIO", "DEVOLUCION", "CUPO", "CUPOS", "INSCRIBIR", "INSCRIPCION",
    "QUIERO", "QUISIERA", "QUERIA", "GUSTARIA", "SABER", "PUEDE", "PUEDO", "PUEDES", "PODRIA", "HACE", "HACER", "HICIERON", "ISIERON",
    "TENGO", "TIENE", "VOY", "VENGO", "VA", "ESTA", "ESTOY", "ESTAN", "ES", "SON", "ERA", "FUE", "SERA", "HAY",
    "ENVIO", "ENVIE", "MANDO", "MANDE", "PASO", "PASE", "LLEGO", "ESCRIBO", "ESPERO", "AVISA", "DIJE", "DICE", "SALE", "INTENTE",
    "CONTACTO", "CONMIGO", "CONTIGO", "NADIE", "ALGUIEN", "TODO", "TODOS", "NADA", "MAS", "MENOS", "AHORRA", "AHORA", "AUN", "RECIEN",
    "COMO", "CUANDO", "DONDE", "QUE", "QUIEN", "CUAL", "PORFA", "PORF", "FAVOR", "DISCULPE", "ESTIMADO", "ESTIMADA", "JOVEN", "SENORITA",
    "AHI", "AQUI", "ALLA", "ESO", "ESE", "ESA", "ESTE", "SOLO", "TAMBIEN", "PERO", "YA", "SI", "NO", "TE", "SE", "ME", "NOS",
    "EL", "MI", "MIS", "TU", "SU", "SUS", "USTED", "USTEDES", "YO", "PARA", "CON", "SIN", "UNA", "UN", "UNO", "POR", "EN", "AL", "LO", "LE",
    "MANANA", "HOY", "AYER", "HORA", "HORAS", "LUGAR", "UBICACION", "GRUPO", "AGREGAR", "NOMBRE", "NUMERO", "CELULAR", "TELEFONO",
    "HIJA", "HIJO", "AMIGA", "AMIGO", "OTRA", "OTRO", "PERSONA", "PERSONAS", "VIDEO", "VIDEOS", "IMAGEN", "RECIBIDA", "AUDIO", "DOCUMENTO",
    "WHATSAPP", "WHASTAPP", "WPP", "FACEBOOK", "TIKTOK", "INSTAGRAM", "META", "PANTALLA", "FOTO", "CONTRASENA", "CONFIGURACION",
    "PAQUETE", "PAQUETES", "MENSUALES", "GUION", "GRABAR", "ENTREVISTAS", "SUBIR", "OCULTARLO", "PORTAFOLIO", "ROJO", "ENVANO",
    "DEBE", "DEBO", "SALIR", "ENTRAR", "INGRESAR", "CUENTA", "CODIGO", "CORREO", "LINK", "ENLACE", "CHINA",
  ].join("|")})\\b`,
);

// Muletillas al inicio que no invalidan el nombre que sigue ("Si, Maria Estefani").
const LEADING_FILLER = /^\s*(?:SI|OK|YA|LISTO|AQUI|AHI|ES|SOY)\b[\s,.:]*/;

// Nombre y celular que aparecen en un mensaje. Un mensaje puede traer varios nombres, uno
// por línea ("Joryelina Palma ⏎ Susana Galean").
function extractContactLines(text: string): { names: string[]; phones: string[] } {
  const names: string[] = [];
  const phones: string[] = [];

  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line) continue;

    for (const match of line.matchAll(BOLIVIAN_MOBILE)) {
      phones.push(match[1].replace(/\D/g, ""));
    }

    // Se trabaja sobre la versión normalizada para detectar, pero se muestra lo que escribió.
    line = line.replace(BOLIVIAN_MOBILE, " ").replace(/\s+/g, " ").trim();
    let normalized = normalize(line);

    const prefix = normalized.match(FIELD_PREFIX);
    if (prefix && prefix[0].length > 0) {
      line = line.slice(prefix[0].length).trim();
      normalized = normalize(line);
    }

    const filler = normalized.match(LEADING_FILLER);
    if (filler && filler[0].length > 0) {
      line = line.slice(filler[0].length).trim();
      normalized = normalize(line);
    }

    // Un nombre: 2 a 6 palabras solo de letras, sin iniciales sueltas ("O la china", "Drjara d")
    // salvo partículas (de, la, y), con al menos dos palabras de 3+ letras.
    const tokens = normalized.split(/\s+/).filter(Boolean);
    const particles = new Set(["DE", "DEL", "LA", "LAS", "LOS", "Y"]);
    const looksLikeName =
      tokens.length >= 2 &&
      tokens.length <= 6 &&
      tokens.every((token) => /^[A-Z]+$/.test(token)) &&
      tokens.every((token) => token.length >= 2 || particles.has(token)) &&
      tokens.filter((token) => token.length >= 3 && !particles.has(token)).length >= 2 &&
      !NOT_A_NAME.test(normalized);

    if (looksLikeName) names.push(line.replace(/[.,;]+$/, ""));
  }

  return { names, phones };
}

export { extractContactLines };

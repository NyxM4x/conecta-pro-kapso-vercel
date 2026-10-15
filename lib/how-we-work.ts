// "¿Cómo trabajamos con nuestros clientes?" para la página /paquetes. Antes el bot lo mandaba
// como un texto largo por WhatsApp (HOW_WE_WORK_INFO en app/api/webhooks/kapso/route.ts);
// ahora va detrás del botón de paquetes. Son los mismos datos: si cambia uno, cambiar el otro.

type HowWeWorkStep = {
  title: string;
  text: string;
  points?: string[];
};

const HOW_WE_WORK_STEPS: HowWeWorkStep[] = [
  {
    title: "Forma de pago",
    text: "Para iniciar pedimos el 50% de adelanto y el 50% restante al finalizar el servicio acordado. Así organizamos la planificación, la producción y la edición del contenido.",
  },
  {
    title: "Días de grabación",
    text: "Grabamos una vez por semana, con un mínimo de 4 videos por sesión (muchas veces más, según la organización y la disponibilidad). Cada sesión dura de 2 a 3 horas.",
  },
  {
    title: "Guiones y planificación",
    text: "Llegamos con los guiones preparados, las ideas estructuradas y el contenido pensado para tu marca y para el cliente que quieres atraer, para que el día de grabación sea dinámico y productivo.",
  },
  {
    title: "Organización previa",
    text: "Antes de cada sesión coordinamos contigo para evitar retrasos por situaciones como:",
    points: [
      "Productos no disponibles",
      "Personal ocupado",
      "Atención a clientes durante la grabación",
      "Falta de preparación del espacio",
    ],
  },
  {
    title: "Publicación del contenido",
    text: "Nosotros publicamos los videos en TikTok, cuidando los horarios estratégicos, el rendimiento y la optimización de cada publicación. Además trabajamos con TikTok Ads para llegar a más personas.",
  },
  {
    title: "Comunicación y revisión",
    text: "Creamos un grupo de trabajo contigo: ahí enviamos los videos grabados, compartimos avances y te mandamos cada video antes de publicarlo. Si quieres un ajuste, lo corregimos antes de subirlo.",
  },
];

const HOW_WE_WORK_GOAL =
  "Más que solo grabar videos, buscamos ser un equipo estratégico para tu marca: contenido constante, organizado y enfocado en resultados reales.";

export { HOW_WE_WORK_GOAL, HOW_WE_WORK_STEPS };
export type { HowWeWorkStep };

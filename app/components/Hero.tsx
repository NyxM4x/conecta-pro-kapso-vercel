"use client";

// Portada que comparten /paquetes, /cursos y /oficina: el título gigante y la franja con el video,
// las cifras y el botón que baja a la sección de cada página. Los estilos están en
// app/paquetes/paquetes.css.

import { useEffect, useRef } from "react";

// ⚠️ CIFRAS DE EJEMPLO: reemplazarlas por los datos reales de Conecta Pro antes de publicar.
const HERO_STATS = [
  { value: "+50K", label: "Seguidores en redes" },
  { value: "+20", label: "Empresas confían en nosotros" },
  { value: "+500", label: "Videos producidos" },
];

// Video de portada de cada página, sin la extensión: "<ruta>.mp4" es el video comprimido y
// sin audio, "<ruta>.jpg" su primer cuadro (se ve mientras carga). Los originales están en
// material-original/, fuera de git.
const HERO_VIDEOS = {
  paquetes: "/paquetes/portadaPaquetes",
  cursos: "/cursos/portadaCursos",
} as const;

function Hero({
  title,
  copy,
  ctaLabel,
  ctaHref,
  video = "paquetes",
}: {
  title: string;
  copy: string;
  ctaLabel: string;
  ctaHref: string;
  video?: keyof typeof HERO_VIDEOS;
}) {
  const videoBase = HERO_VIDEOS[video];
  // React no siempre deja puesto el atributo muted en el HTML, y sin él el navegador
  // interno de WhatsApp (sobre todo en iPhone) bloquea el autoplay. Se fuerza acá.
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = true;
    video.play().catch(() => {});
  }, []);

  return (
    <>
      <section className="cp-hero">
        <div className="cp-topbar">
          <span>©2026</span>
          <span>CONECTA PRO</span>
        </div>
        <h1 className="cp-giant" aria-label={title}>
          {title.toUpperCase()}
        </h1>
      </section>

      <section className="cp-band">
        <div className="cp-band-video" aria-hidden>
          <video
            ref={videoRef}
            src={`${videoBase}.mp4`}
            poster={`${videoBase}.jpg`}
            autoPlay
            muted
            loop
            playsInline
            preload="auto"
          />
        </div>
        <ul className="cp-stats-row">
          {HERO_STATS.map((stat) => (
            <li key={stat.label}>
              <strong>{stat.value}</strong>
              <span>{stat.label}</span>
            </li>
          ))}
        </ul>
        <div className="cp-band-left">
          <p className="cp-band-copy">{copy}</p>
          <a className="cp-btn cp-btn-hero" href={ctaHref}>
            {ctaLabel} <span className="cp-btn-arrow" aria-hidden>↓</span>
          </a>
        </div>
      </section>
    </>
  );
}

export { Hero };

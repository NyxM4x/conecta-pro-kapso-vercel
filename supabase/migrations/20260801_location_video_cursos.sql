-- Video de ubicación de los CURSOS (no de la oficina: son dos lugares distintos).
-- Se envía cuando el bot marca intents.location_video, es decir al dar la ubicación
-- de un curso presencial. Correr una vez en el SQL Editor de Supabase.

insert into kapso_media_assets (business, intent, title, url, media_type, is_active, sort_order)
values (
  'conecta-pro',
  'location_video',
  'Cómo llegar al curso',
  'https://oeihvtbnfbewrjmydwgt.supabase.co/storage/v1/object/public/conecta-pro/cursos/video_ubicacion.mp4',
  'video',
  true,
  1
);

-- Verificación: debe devolver exactamente una fila activa.
-- select intent, title, url, is_active
-- from kapso_media_assets
-- where business = 'conecta-pro' and intent = 'location_video';

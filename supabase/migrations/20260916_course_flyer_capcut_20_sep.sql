-- Flyer de cursos (intent 'course_flyer') para el Curso de Edición Persuasiva en CapCut Pro
-- del domingo 20 de septiembre de 2026: cursos/imagen_2.png.
--
-- sendMediaForIntent envía TODAS las filas activas de un intent en el mismo turno, así que
-- los flyers viejos (CapCut del 16 de agosto, Creación de Contenido del 13 de septiembre)
-- se apagan: si no, el cliente recibiría fechas vencidas junto al flyer nuevo.
--
-- Sin expires_at a propósito: la imagen no tiene fecha ni precio, y un course_flyer sin
-- ninguna fila activa dispara la alerta "Material NO enviado" a Telegram en cada chat.
--
-- Correr una vez en el SQL Editor de Supabase. NO se ejecuta automáticamente.

-- ---------------------------------------------------------------------------
-- 0) ANTES (solo lectura): anota las URLs activas, son las que el paso 1 apaga.
-- ---------------------------------------------------------------------------
-- select id, title, url, is_active, sort_order
-- from kapso_media_assets
-- where business = 'conecta-pro' and intent = 'course_flyer'
-- order by sort_order;

-- ---------------------------------------------------------------------------
-- 1) Apaga los flyers de cursos anteriores (no se borran, por trazabilidad histórica).
-- ---------------------------------------------------------------------------
update kapso_media_assets
set is_active = false
where business = 'conecta-pro'
  and intent = 'course_flyer'
  and is_active = true
  and url <> 'https://oeihvtbnfbewrjmydwgt.supabase.co/storage/v1/object/public/conecta-pro/cursos/imagen_2.png';

-- ---------------------------------------------------------------------------
-- 2) Activa el flyer nuevo. Idempotente: si la fila ya existe se reactiva, si no se inserta.
-- ---------------------------------------------------------------------------
update kapso_media_assets
set is_active = true, sort_order = 1
where business = 'conecta-pro'
  and intent = 'course_flyer'
  and url = 'https://oeihvtbnfbewrjmydwgt.supabase.co/storage/v1/object/public/conecta-pro/cursos/imagen_2.png';

insert into kapso_media_assets (business, intent, title, url, media_type, is_active, sort_order)
select 'conecta-pro', 'course_flyer', 'Curso de Edición Persuasiva en CapCut Pro',
  'https://oeihvtbnfbewrjmydwgt.supabase.co/storage/v1/object/public/conecta-pro/cursos/imagen_2.png',
  'image', true, 1
where not exists (
  select 1 from kapso_media_assets
  where business = 'conecta-pro' and intent = 'course_flyer'
    and url = 'https://oeihvtbnfbewrjmydwgt.supabase.co/storage/v1/object/public/conecta-pro/cursos/imagen_2.png'
);

-- ---------------------------------------------------------------------------
-- 3) VERIFICACIÓN (solo lectura). Debe devolver exactamente 1 fila: imagen_2.png.
-- ---------------------------------------------------------------------------
-- select title, url, is_active, sort_order
-- from kapso_media_assets
-- where business = 'conecta-pro' and intent = 'course_flyer' and is_active = true;

-- ---------------------------------------------------------------------------
-- ROLLBACK: apaga imagen_2.png y reactiva por URL las filas anotadas en el paso 0.
-- ---------------------------------------------------------------------------
-- update kapso_media_assets set is_active = false
-- where business = 'conecta-pro' and intent = 'course_flyer'
--   and url = 'https://oeihvtbnfbewrjmydwgt.supabase.co/storage/v1/object/public/conecta-pro/cursos/imagen_2.png';
-- update kapso_media_assets set is_active = true
-- where business = 'conecta-pro' and intent = 'course_flyer'
--   and url in ('<url anotada en el paso 0>');

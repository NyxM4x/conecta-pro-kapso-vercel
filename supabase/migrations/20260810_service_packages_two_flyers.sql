-- El flyer de paquetes (intent 'service_packages') pasa de 1 imagen a 2: se retira
-- paquetes_mensuales.jpeg y se agregan packetes_mensuales1.jpeg y packetes_mensuales2.jpeg.
--
-- sendMediaForIntent recorre TODAS las filas activas de un intent, en orden de
-- sort_order, y las envía todas en el mismo turno (ver app/api/webhooks/kapso/route.ts).
-- Por eso basta con dejar 2 filas activas para que salgan las 2 imágenes juntas.
--
-- Correr una vez en el SQL Editor de Supabase. NO se ejecuta automáticamente.

-- ---------------------------------------------------------------------------
-- 1) Apaga el flyer antiguo (no se borra, por trazabilidad histórica).
-- ---------------------------------------------------------------------------
update kapso_media_assets
set is_active = false
where business = 'conecta-pro'
  and intent = 'service_packages'
  and url = 'https://oeihvtbnfbewrjmydwgt.supabase.co/storage/v1/object/public/conecta-pro/cursos/paquetes_mensuales.jpeg';

-- ---------------------------------------------------------------------------
-- 2) Inserta las 2 imágenes nuevas. Idempotente: si ya existe esa URL para ese
--    intent, no inserta de nuevo.
-- ---------------------------------------------------------------------------
insert into kapso_media_assets (business, intent, title, url, media_type, is_active, sort_order)
select 'conecta-pro', 'service_packages', 'Paquetes de producción (1/2)',
  'https://oeihvtbnfbewrjmydwgt.supabase.co/storage/v1/object/public/conecta-pro/cursos/packetes_mensuales1.jpeg',
  'image', true, 1
where not exists (
  select 1 from kapso_media_assets
  where business = 'conecta-pro' and intent = 'service_packages'
    and url = 'https://oeihvtbnfbewrjmydwgt.supabase.co/storage/v1/object/public/conecta-pro/cursos/packetes_mensuales1.jpeg'
);

insert into kapso_media_assets (business, intent, title, url, media_type, is_active, sort_order)
select 'conecta-pro', 'service_packages', 'Paquetes de producción (2/2)',
  'https://oeihvtbnfbewrjmydwgt.supabase.co/storage/v1/object/public/conecta-pro/cursos/packetes_mensuales2.jpeg',
  'image', true, 2
where not exists (
  select 1 from kapso_media_assets
  where business = 'conecta-pro' and intent = 'service_packages'
    and url = 'https://oeihvtbnfbewrjmydwgt.supabase.co/storage/v1/object/public/conecta-pro/cursos/packetes_mensuales2.jpeg'
);

-- ---------------------------------------------------------------------------
-- 3) VERIFICACIÓN (solo lectura). Debe devolver exactamente 2 filas activas,
--    packetes_mensuales1 con sort_order 1 y packetes_mensuales2 con sort_order 2.
-- ---------------------------------------------------------------------------
-- select intent, title, url, is_active, sort_order
-- from kapso_media_assets
-- where business = 'conecta-pro' and intent = 'service_packages'
-- order by sort_order;

-- ---------------------------------------------------------------------------
-- ROLLBACK (volver a la imagen única anterior):
-- ---------------------------------------------------------------------------
-- update kapso_media_assets set is_active = false
-- where business = 'conecta-pro' and intent = 'service_packages'
--   and url in (
--     'https://oeihvtbnfbewrjmydwgt.supabase.co/storage/v1/object/public/conecta-pro/cursos/packetes_mensuales1.jpeg',
--     'https://oeihvtbnfbewrjmydwgt.supabase.co/storage/v1/object/public/conecta-pro/cursos/packetes_mensuales2.jpeg'
--   );
-- update kapso_media_assets set is_active = true
-- where business = 'conecta-pro' and intent = 'service_packages'
--   and url = 'https://oeihvtbnfbewrjmydwgt.supabase.co/storage/v1/object/public/conecta-pro/cursos/paquetes_mensuales.jpeg';

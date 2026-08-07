-- Promo por Bolivia: imagen promocional de la LÍNEA B (paquetes de producción),
-- 4 videos por Bs 1.000, válida SOLO el 6 y 7 de agosto de 2026 (hora de Bolivia).
--
-- Añade además vigencia por fecha a kapso_media_assets, para que un material temporal
-- deje de enviarse solo, sin cron y sin depender de que alguien apague is_active.
-- Correr una vez en el SQL Editor de Supabase. NO se ejecuta automáticamente.

-- ---------------------------------------------------------------------------
-- 0) INSPECCIÓN previa (solo lectura). Ejecutar ANTES: muestra qué columnas
--    tiene hoy la tabla, y es lo que decide si el paso 4 (opcional) aplica.
-- ---------------------------------------------------------------------------
-- select column_name, data_type, is_nullable
-- from information_schema.columns
-- where table_name = 'kapso_media_assets'
-- order by ordinal_position;

-- ---------------------------------------------------------------------------
-- 1) Vigencia por fecha. Ambas columnas son NULLABLE y no se tocan las filas
--    existentes: una fila sin fechas (todas las actuales: flyers, QR, video de
--    ubicación) sigue siendo válida para siempre, exactamente como hasta hoy.
--
--    starts_at:  inclusivo — antes de ese instante el material aún no se envía.
--    expires_at: EXCLUSIVO — desde ese instante deja de enviarse.
--
--    Son timestamptz: se guarda un instante absoluto. Para vencer al final del
--    7 de agosto en Bolivia se usa 2026-08-08 00:00:00-04:00, así el corte es
--    correcto aunque el backend corra en UTC (Vercel).
-- ---------------------------------------------------------------------------
alter table kapso_media_assets
  add column if not exists starts_at timestamptz,
  add column if not exists expires_at timestamptz;

comment on column kapso_media_assets.starts_at is
  'Inicio de vigencia (inclusivo). NULL = sin fecha de inicio, válido desde siempre.';
comment on column kapso_media_assets.expires_at is
  'Fin de vigencia (EXCLUSIVO). NULL = sin vencimiento. El backend filtra por esta fecha al seleccionar materiales.';

-- ---------------------------------------------------------------------------
-- 2) Candado de unicidad SOLO para la promo. Índice PARCIAL: no toca ni valida
--    ninguna otra fila de la tabla (aunque hubiera duplicados históricos en
--    otros intents, este índice se crea igual). Hace que el insert de abajo sea
--    idempotente de verdad: un segundo intento simultáneo falla con error de
--    unicidad en vez de crear una fila duplicada.
-- ---------------------------------------------------------------------------
create unique index if not exists kapso_media_assets_service_packages_promo_uidx
  on kapso_media_assets (business, intent, url)
  where intent = 'service_packages_promo';

-- ---------------------------------------------------------------------------
-- 3) La imagen de la promo. Intent propio (service_packages_promo) para que NO
--    reemplace ni se mezcle con el flyer general de intent 'service_packages':
--    el backend envía uno u otro, nunca los dos en el mismo turno.
--    Idempotente: si ya existe esa URL para ese intent, no inserta de nuevo.
-- ---------------------------------------------------------------------------
insert into kapso_media_assets (
  business, intent, title, url, media_type, is_active, sort_order, starts_at, expires_at
)
select
  'conecta-pro',
  'service_packages_promo',
  'Promo por Bolivia — 4 videos por Bs 1.000',
  'https://oeihvtbnfbewrjmydwgt.supabase.co/storage/v1/object/public/conecta-pro/cursos/promo_bolivia.jpeg',
  'image',
  true,
  1,
  timestamptz '2026-08-06 00:00:00-04:00',
  timestamptz '2026-08-08 00:00:00-04:00'
where not exists (
  select 1
  from kapso_media_assets
  where business = 'conecta-pro'
    and intent = 'service_packages_promo'
    and url = 'https://oeihvtbnfbewrjmydwgt.supabase.co/storage/v1/object/public/conecta-pro/cursos/promo_bolivia.jpeg'
);

-- ---------------------------------------------------------------------------
-- 4) OPCIONAL — description y tags.
--
--    ⚠️ SI NO EJECUTAS ESTE BLOQUE, LA DESCRIPCIÓN Y LOS TAGS NO QUEDAN
--    GUARDADOS EN NINGÚN LADO. Y no hace falta que lo hagan: el backend NO lee
--    esas columnas. Que el agente encuentre la promo cuando preguntan por
--    promociones, grabación, edición, videos o precios NO depende de los tags,
--    sino del bloque de promociones que se inyecta al prompt en cada mensaje
--    (lib/promos.ts) y de las guardas de lib/media-intents.ts. Los tags serían
--    solo documentación para quien administre la tabla a mano.
--
--    Ejecutar SOLO si el paso 0 muestra que esas columnas no existen (se crean)
--    o que existen con estos mismos tipos (text y text[]). Si existen con OTRO
--    tipo, el update falla y aborta la transacción sin dañar nada.
-- ---------------------------------------------------------------------------
-- alter table kapso_media_assets
--   add column if not exists description text,
--   add column if not exists tags text[];
--
-- update kapso_media_assets
-- set
--   description = 'Paquete temporal de creación de contenido que incluye estrategia, guiones, grabación profesional, edición y publicación de 4 videos por Bs 1.000.',
--   tags = array['promo','bolivia','4 videos','grabacion','edicion','contenido','redes sociales','1000 bs']
-- where business = 'conecta-pro'
--   and intent = 'service_packages_promo';

-- ---------------------------------------------------------------------------
-- 5) VERIFICACIÓN (solo lectura).
-- ---------------------------------------------------------------------------
-- a) La promo quedó registrada y vigente hoy:
-- select intent, title, is_active, sort_order, starts_at, expires_at,
--        (now() >= coalesce(starts_at, now()) and now() < coalesce(expires_at, now() + interval '1 year')) as vigente_ahora
-- from kapso_media_assets
-- where business = 'conecta-pro' and intent = 'service_packages_promo';
--
-- b) Ningún material existente quedó con fechas por accidente (deben ser todas NULL):
-- select intent, title, starts_at, expires_at
-- from kapso_media_assets
-- where business = 'conecta-pro' and intent <> 'service_packages_promo';
--
-- c) El flyer general de paquetes sigue intacto y activo:
-- select intent, title, url, is_active, sort_order
-- from kapso_media_assets
-- where business = 'conecta-pro' and intent = 'service_packages';
--
-- d) El valor de `business` de la promo coincide con el del resto del negocio.
--    'conecta-pro' es el literal por el que filtra el backend (getActiveMediaAssets):
--    una fila con otro valor de business jamás se enviaría. La promo debe aparecer
--    en la MISMA fila de business que los demás materiales:
-- select business, intent, count(*) as filas
-- from kapso_media_assets
-- group by business, intent
-- order by business, intent;
--
-- e) No hay duplicados de la promo (debe devolver exactamente 1):
-- select count(*) as filas_promo
-- from kapso_media_assets
-- where business = 'conecta-pro' and intent = 'service_packages_promo';

-- ---------------------------------------------------------------------------
-- ROLLBACK (si hiciera falta retirar la promo antes de tiempo):
-- ---------------------------------------------------------------------------
-- update kapso_media_assets
-- set is_active = false
-- where business = 'conecta-pro' and intent = 'service_packages_promo';

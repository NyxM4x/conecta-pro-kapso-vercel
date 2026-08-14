-- Borra el marcador "[MEDIA_SENT:service_packages]" de tu(s) número(s) de prueba en
-- kapso_messages para poder volver a probar el envío de los 2 flyers con el mismo
-- número de WhatsApp, sin esperar a que venza la ventana.
--
-- Por qué sigue haciendo falta: el flyer de paquetes tiene una VENTANA DE REENVÍO de
-- 24 horas (MEDIA_RESEND_WINDOW_HOURS en lib/media-intents.ts). Dentro de esas 24h el
-- bot responde solo en texto y no repite las imágenes. Borrar el marcador deja al
-- número en estado "nunca enviado" y el siguiente mensaje vuelve a recibir los flyers.
--
-- Reemplaza el/los números en la lista de abajo por los que estés usando para probar
-- (formato tal cual aparece en contact_phone, normalmente con código de país, sin '+').
--
-- Correr una vez en el SQL Editor de Supabase. NO se ejecuta automáticamente.

delete from kapso_messages
where direction = 'outbound'
  and content ilike '[MEDIA_SENT:service_packages]%'
  and contact_phone in (
    -- '59177184455',
    -- '59179823884',
    -- '59177568188'
  );

-- ---------------------------------------------------------------------------
-- VERIFICACIÓN (solo lectura): debe devolver 0 filas para los números de la lista.
-- ---------------------------------------------------------------------------
-- select contact_phone, content, created_at
-- from kapso_messages
-- where direction = 'outbound'
--   and content ilike '[MEDIA_SENT:service_packages]%'
--   and contact_phone in ('59177184455', '59179823884', '59177568188');

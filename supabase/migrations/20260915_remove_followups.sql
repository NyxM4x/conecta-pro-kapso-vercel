-- Eliminación del seguimiento automático (reactivación de clientes que recibieron el
-- formulario y no lo completaron).
--
-- En la práctica nunca funcionó: al 15 de septiembre de 2026 kapso_followups tenía 268
-- filas, 0 enviadas (170 pendientes, 98 descartadas por lead ya capturado). Además su texto
-- hablaba solo de "paquetes de contenido", y hoy el formulario también lo reciben quienes
-- quieren visitar la oficina. Se decidió quitarlo: el webhook ya no programa seguimientos
-- y la ruta /api/followups/run fue borrada del código.
--
-- Correr una vez en el SQL Editor de Supabase. Es re-ejecutable.
-- NO toca el job 'unattended-leads' (alerta 🚨 de lead sin atender), que sigue activo.

-- 1) Apagar el job de pg_cron que llamaba a /api/followups/run.
select cron.unschedule(jobid)
from cron.job
where jobname = 'followups-run';

-- 2) Cerrar los seguimientos que quedaron pendientes, para que no parezcan trabajo en curso.
update kapso_followups
set status = 'skipped',
    skip_reason = 'feature_removed',
    updated_at = now()
where status = 'pending';

-- La tabla kapso_followups se conserva como historial; se puede borrar más adelante.
-- Verificación:
--   select jobname, active from cron.job;                       -- ya no aparece followups-run
--   select status, count(*) from kapso_followups group by 1;    -- sin 'pending'

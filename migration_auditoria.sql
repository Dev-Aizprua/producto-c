-- ============================================================
-- MIGRACIÓN: Auditoría de acciones
-- Ejecutar con:
-- npx wrangler d1 execute producto-c-db --remote --file=migration_auditoria.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS historial_acciones (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  negocio_id      INTEGER NOT NULL,
  usuario_id      INTEGER,              -- puede ser null (sesión legacy sin tabla usuarios)
  usuario_nombre  TEXT NOT NULL,        -- snapshot del nombre al momento de la acción
  rol             TEXT,                 -- snapshot del rol al momento de la acción
  accion          TEXT NOT NULL,        -- crear | editar | eliminar | desactivar | activar | cancelar | confirmar
  entidad         TEXT NOT NULL,        -- cita | servicio | usuario | negocio
  entidad_id      INTEGER,
  detalle         TEXT,                 -- descripción legible, ej: "Canceló la cita de María González"
  fecha           TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_historial_negocio ON historial_acciones(negocio_id, fecha DESC);
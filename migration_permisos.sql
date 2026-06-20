-- ============================================================
-- MIGRACIÓN: Permisos por rol — agregar usuario_id y rol a sesiones
-- Ejecutar con:
-- npx wrangler d1 execute producto-c-db --remote --file=migration_permisos.sql
-- ============================================================

ALTER TABLE panel_sessions ADD COLUMN usuario_id INTEGER;
ALTER TABLE panel_sessions ADD COLUMN rol TEXT DEFAULT 'admin';
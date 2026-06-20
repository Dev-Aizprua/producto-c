-- ============================================================
-- MIGRACIÓN: Visibilidad de seguimiento de abandonados
-- Ejecutar con:
-- npx wrangler d1 execute producto-c-db --remote --file=migration_seguimiento.sql
-- ============================================================

-- Tabla chats: cuándo se envió el seguimiento y si el cliente respondió después
ALTER TABLE chats ADD COLUMN seguimiento_fecha TEXT;
ALTER TABLE chats ADD COLUMN seguimiento_respondido INTEGER DEFAULT 0;

-- Tabla citas: mismo patrón para seguimientos de pago pendiente
ALTER TABLE citas ADD COLUMN seguimiento_fecha TEXT;
ALTER TABLE citas ADD COLUMN seguimiento_respondido INTEGER DEFAULT 0;
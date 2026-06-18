-- ============================================================
-- MIGRACIÓN: Sistema de usuarios multi-rol
-- Ejecutar con:
-- npx wrangler d1 execute producto-c-db --remote --file=migration_usuarios.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS usuarios (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  negocio_id      INTEGER NOT NULL,
  nombre          TEXT NOT NULL,
  usuario         TEXT NOT NULL,
  password_hash   TEXT NOT NULL,
  rol             TEXT NOT NULL DEFAULT 'recepcionista', -- admin | recepcionista | especialista
  activo          INTEGER NOT NULL DEFAULT 1,
  debe_cambiar_pass INTEGER NOT NULL DEFAULT 0,
  ultimo_acceso   TEXT,
  created_at      TEXT DEFAULT (datetime('now')),
  UNIQUE(negocio_id, usuario)
);

-- Insertar el admin actual de dental-demo como primer usuario
-- password_hash de 'admin' en SHA-256:
INSERT OR IGNORE INTO usuarios (negocio_id, nombre, usuario, password_hash, rol, activo)
SELECT id, 'Administrador', panel_usuario,
  panel_password, -- ya está en SHA-256 desde login.js
  'admin', 1
FROM negocios WHERE slug = 'dental-demo';
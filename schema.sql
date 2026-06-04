-- ============================================================
-- producto-c-db — Schema completo
-- Ejecutar: npx wrangler d1 execute producto-c-db --file=schema.sql
-- ============================================================

-- Negocios (un registro por cliente contratado)
CREATE TABLE IF NOT EXISTS negocios (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  slug             TEXT    NOT NULL UNIQUE,
  nombre           TEXT    NOT NULL,
  descripcion      TEXT,
  logo_url         TEXT,
  icono            TEXT    DEFAULT '💬',
  color_primary    TEXT    DEFAULT '#1a73e8',
  whatsapp_destino TEXT,
  telegram_chat_id TEXT,
  token            TEXT    NOT NULL,
  activo           INTEGER DEFAULT 1,
  created_at       TEXT    DEFAULT (datetime('now'))
);

-- Servicios (máx 10 por negocio)
CREATE TABLE IF NOT EXISTS servicios (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  negocio_id  INTEGER NOT NULL REFERENCES negocios(id),
  nombre      TEXT    NOT NULL,
  descripcion TEXT,
  precio      REAL    NOT NULL,
  imagen_url  TEXT,
  icono       TEXT    DEFAULT '🛎️',
  duracion    TEXT    DEFAULT '45 min',
  orden       INTEGER DEFAULT 0,
  activo      INTEGER DEFAULT 1,
  created_at  TEXT    DEFAULT (datetime('now'))
);

-- Citas / Reservas
CREATE TABLE IF NOT EXISTS citas (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  negocio_id       INTEGER NOT NULL REFERENCES negocios(id),
  servicio_id      INTEGER REFERENCES servicios(id),
  cliente_nombre   TEXT,
  cliente_tel      TEXT,
  fecha_cita       TEXT,
  total            REAL,
  estado_pago      TEXT    DEFAULT 'pendiente',  -- pendiente | pagado | cancelado
  metodo_pago      TEXT,                          -- visa | mastercard | clave
  referencia_pago  TEXT,
  session_token    TEXT,
  created_at       TEXT    DEFAULT (datetime('now'))
);

-- Chats (historial por sesión)
CREATE TABLE IF NOT EXISTS chats (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  negocio_id     INTEGER NOT NULL REFERENCES negocios(id),
  session_token  TEXT    NOT NULL,
  cliente_nombre TEXT,
  cliente_tel    TEXT,
  historial_json TEXT    DEFAULT '[]',
  fecha          TEXT    DEFAULT (datetime('now')),
  completado     INTEGER DEFAULT 0
);

-- Abandonados (sesiones sin completar pago)
CREATE TABLE IF NOT EXISTS abandonados (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  negocio_id       INTEGER NOT NULL REFERENCES negocios(id),
  session_token    TEXT,
  cliente_nombre   TEXT,
  cliente_tel      TEXT,
  ultimo_servicio  TEXT,
  fecha            TEXT    DEFAULT (datetime('now'))
);

-- Índices para consultas frecuentes
CREATE INDEX IF NOT EXISTS idx_negocios_slug      ON negocios(slug);
CREATE INDEX IF NOT EXISTS idx_servicios_negocio  ON servicios(negocio_id);
CREATE INDEX IF NOT EXISTS idx_citas_negocio      ON citas(negocio_id);
CREATE INDEX IF NOT EXISTS idx_chats_session      ON chats(session_token);
CREATE INDEX IF NOT EXISTS idx_chats_negocio      ON chats(negocio_id);
CREATE INDEX IF NOT EXISTS idx_abandonados_neg    ON abandonados(negocio_id);

-- ============================================================
-- Negocio de prueba (demo / piloto)
-- ============================================================
INSERT OR IGNORE INTO negocios (slug, nombre, descripcion, icono, color_primary, whatsapp_destino, token)
VALUES (
  'dental-demo',
  'Clínica Dental AI',
  'Tu clínica dental de confianza en Panamá',
  '🦷',
  '#1a73e8',
  '50799999999',
  'dental-demo-token-2026'
);

-- Servicios del negocio demo
INSERT OR IGNORE INTO servicios (negocio_id, nombre, descripcion, precio, icono, duracion, orden)
SELECT id, 'Limpieza Dental',   'Limpieza profunda y eliminación de sarro', 30,  '🪥', '45 min', 1 FROM negocios WHERE slug='dental-demo';
INSERT OR IGNORE INTO servicios (negocio_id, nombre, descripcion, precio, icono, duracion, orden)
SELECT id, 'Blanqueamiento',    'Blanqueamiento dental profesional',         80,  '✨', '60 min', 2 FROM negocios WHERE slug='dental-demo';
INSERT OR IGNORE INTO servicios (negocio_id, nombre, descripcion, precio, icono, duracion, orden)
SELECT id, 'Implante Dental',   'Implante de titanio de alta durabilidad',   250, '🦷', '90 min', 3 FROM negocios WHERE slug='dental-demo';
INSERT OR IGNORE INTO servicios (negocio_id, nombre, descripcion, precio, icono, duracion, orden)
SELECT id, 'Ortodoncia',        'Corrección dental con brackets o alineadores', 500, '😁', '120 min', 4 FROM negocios WHERE slug='dental-demo';
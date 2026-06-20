-- Tabla de horarios de atención configurables por negocio
CREATE TABLE IF NOT EXISTS horarios_atencion (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  negocio_id INTEGER NOT NULL,
  dia_semana INTEGER NOT NULL,  -- 0=domingo, 1=lunes ... 6=sabado
  hora_inicio TEXT NOT NULL,     -- "08:00"
  hora_fin TEXT NOT NULL,        -- "17:00"
  activo INTEGER DEFAULT 1
);

-- Columna para guardar la hora por separado (fecha_cita ya es ISO puro YYYY-MM-DD)
ALTER TABLE citas ADD COLUMN fecha_hora TEXT;
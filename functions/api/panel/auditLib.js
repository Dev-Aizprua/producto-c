// ============================================================
// functions/api/panel/auditLib.js
// Helper reutilizable — NO es un endpoint, se importa desde otros archivos
// Registra cada acción relevante en la tabla historial_acciones
// ============================================================

/**
 * Registra una acción en el historial de auditoría.
 * Nunca debe romper el flujo principal si falla — por eso usa try/catch interno.
 *
 * @param {object} env - context.env (acceso a D1)
 * @param {object} data - context.data (negocio_id, usuario_id, rol del middleware)
 * @param {string} accion - 'crear' | 'editar' | 'eliminar' | 'desactivar' | 'activar' | 'cancelar' | 'confirmar'
 * @param {string} entidad - 'cita' | 'servicio' | 'usuario' | 'negocio'
 * @param {number|null} entidad_id
 * @param {string} detalle - descripción legible para humanos
 */
export async function registrarAccion(env, data, accion, entidad, entidad_id, detalle) {
  try {
    // Resolver nombre del usuario que ejecuta la acción
    let usuarioNombre = 'Administrador';
    let rol = data.rol || 'admin';

    if (data.usuario_id) {
      const usr = await env.producto_c_db
        .prepare('SELECT nombre FROM usuarios WHERE id = ? LIMIT 1')
        .bind(data.usuario_id).first();
      if (usr) usuarioNombre = usr.nombre;
    }

    await env.producto_c_db
      .prepare(`INSERT INTO historial_acciones
                (negocio_id, usuario_id, usuario_nombre, rol, accion, entidad, entidad_id, detalle)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(data.negocio_id, data.usuario_id || null, usuarioNombre, rol, accion, entidad, entidad_id || null, detalle)
      .run();
  } catch (err) {
    // La auditoría NUNCA debe tumbar la acción principal
    console.error('Error registrando auditoría:', err.message);
  }
}
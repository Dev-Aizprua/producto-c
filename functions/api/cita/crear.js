// ============================================================
// functions/api/cita/crear.js
// POST /api/cita/crear
// Registra la cita en D1 después de un pago exitoso
// ============================================================

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try { body = await request.json(); }
  catch { return Response.json({ success: false, error: 'JSON inválido' }, { status: 400, headers: cors }); }

  const {
    slug, servicio_id, servicio_nombre,
    fecha_cita, total, estado_pago,
    metodo_pago, referencia_pago, session_token,
    cliente_nombre, cliente_tel,
  } = body;

  if (!slug) {
    return Response.json({ success: false, error: 'slug requerido' }, { status: 400, headers: cors });
  }

  try {
    // Obtener negocio
    const negocio = await env.producto_c_db
      .prepare('SELECT id FROM negocios WHERE slug = ? AND activo = 1 LIMIT 1')
      .bind(slug).first();

    if (!negocio) {
      return Response.json({ success: false, error: 'Negocio no encontrado' }, { status: 404, headers: cors });
    }

    // Insertar cita
    const result = await env.producto_c_db
      .prepare(`INSERT INTO citas
        (negocio_id, servicio_id, cliente_nombre, cliente_tel, fecha_cita, total, estado_pago, metodo_pago, referencia_pago, session_token)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        negocio.id,
        servicio_id || null,
        cliente_nombre || 'Cliente web',
        cliente_tel || '',
        fecha_cita || '',
        total || 0,
        estado_pago || 'pagado',
        metodo_pago || 'clave',
        referencia_pago || '',
        session_token || '',
      ).run();

    // Marcar el chat como completado
    if (session_token) {
      await env.producto_c_db
        .prepare('UPDATE chats SET completado = 1 WHERE session_token = ? AND negocio_id = ?')
        .bind(session_token, negocio.id).run();
    }

    return Response.json({
      success: true,
      cita_id: result.meta.last_row_id,
      mensaje: 'Cita registrada exitosamente',
    }, { headers: cors });

  } catch (err) {
    return Response.json(
      { success: false, error: 'Error interno', detail: err.message },
      { status: 500, headers: cors }
    );
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: cors });
}
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

    // Normalizar fecha — el frontend puede mandar texto como
    // "viernes 10 de julio de 2026 a las 11:00" o ya un ISO "2026-07-10"
    let fechaISO = fecha_cita || '';
    let horaISO  = null;

    // Si tiene formato de fecha larga, extraer la parte ISO y la hora
    const matchFechaLarga = fechaISO.match(/(\d{4}-\d{2}-\d{2})/);
    if (matchFechaLarga) {
      fechaISO = matchFechaLarga[1];
    }
    const matchHora = (fecha_cita || '').match(/(\d{1,2}):(\d{2})(?:\s*(AM|PM|am|pm))?/);
    if (matchHora) {
      let h = parseInt(matchHora[1]);
      const m = matchHora[2];
      const periodo = (matchHora[3] || '').toLowerCase();
      if (periodo === 'pm' && h < 12) h += 12;
      if (periodo === 'am' && h === 12) h = 0;
      horaISO = `${String(h).padStart(2,'0')}:${m}`;
    }

    // ── PROTECCIÓN ANTI-DUPLICADO ─────────────────────────────
    // chat.js ya pudo haber creado una cita para este session_token.
    // Si existe, actualizamos esa cita en vez de crear una segunda.
    let citaId = null;
    const citaExistente = session_token
      ? await env.producto_c_db.prepare(
          `SELECT id FROM citas WHERE session_token = ? AND negocio_id = ?
           ORDER BY id DESC LIMIT 1`
        ).bind(session_token, negocio.id).first()
      : null;

    if (citaExistente) {
      // Actualizar la cita que ya creó chat.js con el estado de pago y referencia
      await env.producto_c_db.prepare(
        `UPDATE citas SET
           estado_pago     = ?,
           metodo_pago     = ?,
           referencia_pago = ?,
           fecha_cita      = COALESCE(NULLIF(fecha_cita, ''), ?),
           fecha_hora      = COALESCE(fecha_hora, ?),
           canal           = 'web'
         WHERE id = ?`
      ).bind(
        estado_pago      || 'pagado',
        metodo_pago      || 'clave',
        referencia_pago  || '',
        fechaISO,
        horaISO,
        citaExistente.id
      ).run();
      citaId = citaExistente.id;
      console.log(`[CREAR_WEB] Cita actualizada id=${citaId} — no duplicada`);
    } else {
      // No existe cita previa — insertar normalmente
      const result = await env.producto_c_db.prepare(
        `INSERT INTO citas
          (negocio_id, servicio_id, cliente_nombre, cliente_tel,
           fecha_cita, fecha_hora, total, estado_pago, metodo_pago,
           referencia_pago, session_token, canal)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'web')`
      ).bind(
        negocio.id,
        servicio_id      || null,
        cliente_nombre   || 'Cliente web',
        cliente_tel      || '',
        fechaISO,
        horaISO,
        total            || 0,
        estado_pago      || 'pagado',
        metodo_pago      || 'clave',
        referencia_pago  || '',
        session_token    || '',
      ).run();
      citaId = result.meta.last_row_id;
      console.log(`[CREAR_WEB] Cita nueva insertada id=${citaId}`);
    }

    // Marcar el chat como completado
    if (session_token) {
      await env.producto_c_db
        .prepare('UPDATE chats SET completado = 1 WHERE session_token = ? AND negocio_id = ?')
        .bind(session_token, negocio.id).run();
    }

    return Response.json({
      success: true,
      cita_id: citaId,
      mensaje: citaExistente ? 'Cita actualizada con pago' : 'Cita registrada exitosamente',
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
// ============================================================
// functions/api/panel/citas.js
// GET  /api/panel/citas          → listar citas del negocio
// PUT  /api/panel/citas/:id      → actualizar estado de cita
// ============================================================

const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

export async function onRequestGet(context) {
  const { env, data } = context;
  try {
    const { results } = await env.producto_c_db
      .prepare(`SELECT c.*, s.nombre as servicio_nombre,
                COALESCE(c.canal, 'web') as canal
                FROM citas c
                LEFT JOIN servicios s ON c.servicio_id = s.id
                WHERE c.negocio_id = ?
                ORDER BY c.created_at DESC
                LIMIT 100`)
      .bind(data.negocio_id).all();

    return Response.json({ success: true, citas: results }, { headers: cors });
  } catch (err) {
    return Response.json({ success: false, error: err.message }, { status: 500, headers: cors });
  }
}

export async function onRequestPut(context) {
  const { request, env, data, params } = context;

  let body;
  try { body = await request.json(); }
  catch { return Response.json({ success: false, error: 'JSON inválido' }, { status: 400, headers: cors }); }

  const { cita_id, estado_pago } = body;

  const estadosValidos = ['esperando_pago', 'pago_por_verificar', 'confirmada', 'cancelada', 'expirada', 'pagado', 'pendiente'];
  if (!estadosValidos.includes(estado_pago)) {
    return Response.json({ success: false, error: 'Estado inválido' }, { status: 400, headers: cors });
  }

  try {
    await env.producto_c_db
      .prepare(`UPDATE citas SET estado_pago = ? WHERE id = ? AND negocio_id = ?`)
      .bind(estado_pago, cita_id, data.negocio_id).run();

    return Response.json({ success: true, mensaje: 'Estado actualizado' }, { headers: cors });
  } catch (err) {
    return Response.json({ success: false, error: err.message }, { status: 500, headers: cors });
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: cors });
}
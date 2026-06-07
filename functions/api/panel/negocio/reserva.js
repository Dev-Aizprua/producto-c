// ============================================================
// functions/api/panel/negocio/reserva.js
// PUT /api/panel/negocio/reserva
// Guarda el modo de reserva del negocio
// ============================================================

const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

export async function onRequestPut(context) {
  const { request, env, data } = context;

  let body;
  try { body = await request.json(); }
  catch { return Response.json({ success: false, error: 'JSON inválido' }, { status: 400, headers: cors }); }

  const { modo_reserva, monto_reserva } = body;

  const modosValidos = ['solo_cita', 'adelanto', 'pago_completo'];
  if (!modosValidos.includes(modo_reserva)) {
    return Response.json({ success: false, error: 'Modo inválido' }, { status: 400, headers: cors });
  }

  try {
    await env.producto_c_db
      .prepare('UPDATE negocios SET modo_reserva = ?, monto_reserva = ? WHERE id = ?')
      .bind(modo_reserva, monto_reserva || 5, data.negocio_id)
      .run();

    return Response.json({ success: true, mensaje: 'Modo de reserva actualizado' }, { headers: cors });
  } catch (err) {
    return Response.json({ success: false, error: err.message }, { status: 500, headers: cors });
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: cors });
}
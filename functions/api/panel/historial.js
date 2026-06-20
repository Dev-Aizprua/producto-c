// ============================================================
// functions/api/panel/historial.js
// GET /api/panel/historial  — últimas acciones del negocio
// ============================================================

const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

export async function onRequestGet({ env, data }) {
  try {
    const { results } = await env.producto_c_db
      .prepare(`SELECT id, usuario_nombre, rol, accion, entidad, entidad_id, detalle, fecha
                FROM historial_acciones
                WHERE negocio_id = ?
                ORDER BY fecha DESC
                LIMIT 50`)
      .bind(data.negocio_id).all();

    return Response.json({ success: true, historial: results }, { headers: cors });
  } catch (err) {
    return Response.json({ success: false, error: err.message }, { status: 500, headers: cors });
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: cors });
}
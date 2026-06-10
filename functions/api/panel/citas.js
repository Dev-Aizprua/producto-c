// ============================================================
// functions/api/panel/citas.js
// GET /api/panel/citas → listar citas del negocio
// ============================================================

const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
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

export async function onRequestOptions() {
  return new Response(null, { headers: cors });
}
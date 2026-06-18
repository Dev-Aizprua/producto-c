// ============================================================
// functions/api/panel/usuarios/cerrar-sesiones.js
// POST /api/panel/usuarios/cerrar-sesiones
// ============================================================

const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

export async function onRequestPost({ env, data }) {
  const negocio_id = data.negocio_id;
  try {
    await env.producto_c_db
      .prepare("UPDATE panel_sessions SET expira_at = '2000-01-01T00:00:00.000Z' WHERE negocio_id = ?")
      .bind(negocio_id).run();
    return Response.json({ success: true, mensaje: 'Todas las sesiones cerradas' }, { headers: cors });
  } catch (err) {
    return Response.json({ success: false, error: err.message }, { status: 500, headers: cors });
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: cors });
}
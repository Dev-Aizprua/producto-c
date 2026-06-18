// ============================================================
// functions/api/panel/usuarios/cerrar-sesiones.js
// POST /api/panel/usuarios/cerrar-sesiones
// Invalida todos los tokens de sesión del negocio
// ============================================================

const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

export async function onRequestPost(context) {
  const { request, env } = context;

  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace('Bearer ', '').trim();
  if (!token) {
    return Response.json({ success: false, error: 'No autorizado' }, { status: 401, headers: cors });
  }

  const now = new Date().toISOString();
  const session = await env.producto_c_db
    .prepare('SELECT negocio_id FROM panel_sessions WHERE token = ? AND expira_at > ? LIMIT 1')
    .bind(token, now).first();

  if (!session) {
    return Response.json({ success: false, error: 'Sesión no válida' }, { status: 401, headers: cors });
  }

  try {
    // Invalidar todos los tokens del negocio poniéndolos como expirados
    await env.producto_c_db
      .prepare("UPDATE panel_sessions SET expira_at = '2000-01-01T00:00:00.000Z' WHERE negocio_id = ?")
      .bind(session.negocio_id).run();

    return Response.json({ success: true, mensaje: 'Todas las sesiones cerradas' }, { headers: cors });
  } catch (err) {
    return Response.json({ success: false, error: err.message }, { status: 500, headers: cors });
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: cors });
}
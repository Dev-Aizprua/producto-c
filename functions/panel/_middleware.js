// ============================================================
// functions/api/panel/_middleware.js
// Protege todas las rutas /api/panel/* excepto /login
// Valida session token contra D1 tabla panel_sessions
// ============================================================

export async function onRequest(context) {
  const { request, env, next } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin':  '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    });
  }

  // Login no requiere autenticación
  const url = new URL(request.url);
  if (url.pathname.endsWith('/login')) return next();

  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.replace('Bearer ', '').trim();

  if (!token) {
    return Response.json({ success: false, error: 'Token requerido' }, { status: 401 });
  }

  try {
    const session = await env.producto_c_db
      .prepare('SELECT * FROM panel_sessions WHERE token = ? LIMIT 1')
      .bind(token).first();

    if (!session) {
      return Response.json({ success: false, error: 'Sesión inválida' }, { status: 401 });
    }

    if (new Date(session.expira_at) < new Date()) {
      await env.producto_c_db.prepare('DELETE FROM panel_sessions WHERE token = ?').bind(token).run();
      return Response.json({ success: false, error: 'Sesión expirada' }, { status: 401 });
    }

    context.data.negocio_id = session.negocio_id;
    context.data.session_token = token;
    return next();

  } catch (err) {
    return Response.json({ success: false, error: 'Error de autenticación' }, { status: 500 });
  }
}
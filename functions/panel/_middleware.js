// ============================================================
// functions/api/dashboard/_middleware.js
// PORTERO CENTRAL — intercepta todas las llamadas a /api/dashboard/
// Mismo sistema del Elegance Panel — sin cambios
// ============================================================

export async function onRequest(context) {
  const { request, env, next } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin':  '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    });
  }

  const authHeader = request.headers.get('Authorization') || '';
  const token      = authHeader.replace('Bearer ', '').trim();
  const tokenValido = env.ACCESS_TOKEN || '';

  if (!tokenValido) {
    return Response.json(
      { success: false, error: 'Panel no configurado — falta ACCESS_TOKEN en Variables de Entorno' },
      { status: 503 }
    );
  }

  if (token !== tokenValido) {
    return Response.json(
      { success: false, error: 'Acceso no autorizado' },
      { status: 401 }
    );
  }

  return next();
}
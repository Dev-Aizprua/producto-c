// ============================================================
// functions/api/panel/_middleware.js
// Protege todas las rutas /api/panel/* excepto /login
// Valida session token contra D1 tabla panel_sessions
// + Aplica permisos por rol (admin / recepcionista / especialista)
// ============================================================

// Matriz de permisos: qué puede tocar cada rol y con qué métodos.
// Si un endpoint no aparece en la lista del rol, se bloquea por defecto.
// '*' significa todos los métodos permitidos en ese endpoint.
const PERMISOS = {
  admin: {
    // Admin tiene acceso total — no se restringe nada
    all: true,
  },
  recepcionista: {
    rutas: {
      'negocio':        ['GET'],            // puede ver pero no editar configuración
      'servicios':       ['GET'],            // puede ver catálogo, no editarlo
      'citas':            ['GET', 'POST', 'PUT'],
      'chats':            ['GET', 'POST'],
      'usuarios/cambiar-password': ['POST'], // puede cambiar su propia contraseña
    },
  },
  especialista: {
    rutas: {
      'citas':  ['GET'],                     // solo ver su agenda
      'usuarios/cambiar-password': ['POST'],
    },
  },
};

function rutaPermitida(rol, pathname, method) {
  if (rol === 'admin') return true;
  const reglas = PERMISOS[rol];
  if (!reglas) return false; // rol desconocido => bloqueado

  // pathname viene como /api/panel/citas o /api/panel/usuarios/5
  const partes = pathname.replace(/^\/api\/panel\//, '').split('/');
  // Probar coincidencia exacta primero (ej: 'usuarios/cambiar-password')
  const rutaCompuesta = partes.slice(0, 2).join('/');
  const rutaSimple = partes[0];

  const metodosCompuesta = reglas.rutas[rutaCompuesta];
  if (metodosCompuesta) return metodosCompuesta.includes(method);

  const metodosSimple = reglas.rutas[rutaSimple];
  if (metodosSimple) return metodosSimple.includes(method);

  return false;
}

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

  const url = new URL(request.url);

  // Login no requiere autenticación
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

    const rol = session.rol || 'admin'; // sesiones viejas sin rol => admin (compat legacy)

    // ── Verificar permiso por rol ──────────────────────────────
    if (!rutaPermitida(rol, url.pathname, request.method)) {
      return Response.json(
        { success: false, error: 'No tienes permisos para realizar esta acción' },
        { status: 403 }
      );
    }

    context.data.negocio_id  = session.negocio_id;
    context.data.usuario_id  = session.usuario_id || null;
    context.data.rol         = rol;
    context.data.session_token = token;
    return next();

  } catch (err) {
    return Response.json({ success: false, error: 'Error de autenticación', detail: err.message }, { status: 500 });
  }
}
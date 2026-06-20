// ============================================================
// functions/api/panel/login.js
// POST /api/panel/login
// Valida contra tabla 'usuarios' (rol-aware). Si no hay usuarios
// creados aún para el negocio, hace fallback al sistema legacy
// (negocios.panel_usuario / panel_password) como admin.
// ============================================================

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

async function sha256(text) {
  const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try { body = await request.json(); }
  catch { return Response.json({ success: false, error: 'JSON inválido' }, { status: 400, headers: corsHeaders }); }

  const { slug, usuario, password } = body;
  if (!slug || !usuario || !password) {
    return Response.json({ success: false, error: 'Datos incompletos' }, { status: 400, headers: corsHeaders });
  }

  try {
    const negocio = await env.producto_c_db
      .prepare('SELECT id, slug, nombre, panel_usuario, panel_password FROM negocios WHERE slug = ? AND activo = 1 LIMIT 1')
      .bind(slug).first();

    if (!negocio) {
      return Response.json({ success: false, error: 'Negocio no encontrado' }, { status: 404, headers: corsHeaders });
    }

    const passwordHash = await sha256(password);
    let usuarioId = null;
    let rol = 'admin'; // fallback legacy siempre es admin
    let nombreUsuario = negocio.panel_usuario;

    // 1. Intentar autenticar contra tabla 'usuarios' (sistema nuevo con roles)
    const usuarioRow = await env.producto_c_db
      .prepare('SELECT id, nombre, usuario, password_hash, rol, activo FROM usuarios WHERE negocio_id = ? AND usuario = ? LIMIT 1')
      .bind(negocio.id, usuario.toLowerCase().trim()).first();

    if (usuarioRow) {
      if (!usuarioRow.activo) {
        return Response.json({ success: false, error: 'Usuario desactivado. Contacta al administrador.' }, { status: 403, headers: corsHeaders });
      }
      if (usuarioRow.password_hash !== passwordHash) {
        return Response.json({ success: false, error: 'Usuario o contraseña incorrectos' }, { status: 401, headers: corsHeaders });
      }
      usuarioId = usuarioRow.id;
      rol = usuarioRow.rol;
      nombreUsuario = usuarioRow.nombre;

      // Actualizar último acceso
      await env.producto_c_db
        .prepare("UPDATE usuarios SET ultimo_acceso = datetime('now') WHERE id = ?")
        .bind(usuarioRow.id).run();

    } else {
      // 2. Fallback legacy — solo si coincide con panel_usuario/panel_password del negocio
      if (usuario !== negocio.panel_usuario || passwordHash !== negocio.panel_password) {
        return Response.json({ success: false, error: 'Usuario o contraseña incorrectos' }, { status: 401, headers: corsHeaders });
      }
      rol = 'admin';
    }

    // Generar session token y guardarlo en D1 — ahora con usuario_id y rol
    const sessionToken = crypto.randomUUID();
    const expira = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(); // 8 horas

    await env.producto_c_db
      .prepare('INSERT OR REPLACE INTO panel_sessions (negocio_id, usuario_id, rol, token, expira_at) VALUES (?, ?, ?, ?, ?)')
      .bind(negocio.id, usuarioId, rol, sessionToken, expira).run();

    return Response.json({
      success: true,
      token: sessionToken,
      negocio: { id: negocio.id, slug: negocio.slug, nombre: negocio.nombre },
      usuario: { nombre: nombreUsuario, rol },
    }, { headers: corsHeaders });

  } catch (err) {
    return Response.json({ success: false, error: 'Error interno', detail: err.message }, { status: 500, headers: corsHeaders });
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: corsHeaders });
}
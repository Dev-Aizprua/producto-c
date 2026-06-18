// ============================================================
// functions/api/panel/usuarios/cambiar-password.js
// POST /api/panel/usuarios/cambiar-password
// El usuario cambia su propia contraseña verificando la actual
// ============================================================

const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}

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
    return Response.json({ success: false, error: 'Sesión expirada' }, { status: 401, headers: cors });
  }

  let body;
  try { body = await request.json(); }
  catch { return Response.json({ success: false, error: 'JSON inválido' }, { status: 400, headers: cors }); }

  const { password_actual, password_nueva } = body;

  if (!password_actual || !password_nueva) {
    return Response.json({ success: false, error: 'Debes enviar la contraseña actual y la nueva' }, { status: 400, headers: cors });
  }

  if (password_nueva.length < 8) {
    return Response.json({ success: false, error: 'La nueva contraseña debe tener mínimo 8 caracteres' }, { status: 400, headers: cors });
  }

  if (password_actual === password_nueva) {
    return Response.json({ success: false, error: 'La nueva contraseña debe ser diferente a la actual' }, { status: 400, headers: cors });
  }

  try {
    const hashActual = await sha256(password_actual);

    // Buscar el usuario admin del negocio (panel_password en negocios)
    // Primero intentar en tabla usuarios, luego fallback a negocios
    let usuarioRow = await env.producto_c_db
      .prepare('SELECT id, password_hash FROM usuarios WHERE negocio_id = ? AND activo = 1 ORDER BY id ASC LIMIT 1')
      .bind(session.negocio_id).first();

    if (usuarioRow) {
      // Verificar contraseña actual
      if (usuarioRow.password_hash !== hashActual) {
        return Response.json({ success: false, error: 'Contraseña actual incorrecta' }, { status: 401, headers: cors });
      }
      // Actualizar en tabla usuarios
      const hashNueva = await sha256(password_nueva);
      await env.producto_c_db
        .prepare('UPDATE usuarios SET password_hash = ?, debe_cambiar_pass = 0 WHERE id = ? AND negocio_id = ?')
        .bind(hashNueva, usuarioRow.id, session.negocio_id).run();
    } else {
      // Fallback: cambiar panel_password en negocios (sistema legacy)
      const negocio = await env.producto_c_db
        .prepare('SELECT id, panel_password FROM negocios WHERE id = ? LIMIT 1')
        .bind(session.negocio_id).first();

      if (!negocio || negocio.panel_password !== hashActual) {
        return Response.json({ success: false, error: 'Contraseña actual incorrecta' }, { status: 401, headers: cors });
      }
      const hashNueva = await sha256(password_nueva);
      await env.producto_c_db
        .prepare('UPDATE negocios SET panel_password = ? WHERE id = ?')
        .bind(hashNueva, session.negocio_id).run();
    }

    return Response.json({ success: true, mensaje: 'Contraseña actualizada exitosamente' }, { headers: cors });
  } catch (err) {
    return Response.json({ success: false, error: err.message }, { status: 500, headers: cors });
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: cors });
}
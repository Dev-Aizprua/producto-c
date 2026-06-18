// ============================================================
// functions/api/panel/usuarios/cambiar-password.js
// POST /api/panel/usuarios/cambiar-password
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

export async function onRequestPost({ request, env, data }) {
  const negocio_id = data.negocio_id;

  let body;
  try { body = await request.json(); }
  catch { return Response.json({ success: false, error: 'JSON inválido' }, { status: 400, headers: cors }); }

  const { password_actual, password_nueva } = body;
  if (!password_actual || !password_nueva)
    return Response.json({ success: false, error: 'Faltan datos' }, { status: 400, headers: cors });
  if (password_nueva.length < 8)
    return Response.json({ success: false, error: 'Mínimo 8 caracteres' }, { status: 400, headers: cors });
  if (password_actual === password_nueva)
    return Response.json({ success: false, error: 'La nueva contraseña debe ser diferente' }, { status: 400, headers: cors });

  try {
    const hashActual = await sha256(password_actual);

    // Buscar en tabla usuarios primero
    const usr = await env.producto_c_db
      .prepare('SELECT id, password_hash FROM usuarios WHERE negocio_id = ? AND activo = 1 ORDER BY id ASC LIMIT 1')
      .bind(negocio_id).first();

    if (usr) {
      if (usr.password_hash !== hashActual)
        return Response.json({ success: false, error: 'Contraseña actual incorrecta' }, { status: 401, headers: cors });
      const hashNueva = await sha256(password_nueva);
      await env.producto_c_db
        .prepare('UPDATE usuarios SET password_hash = ?, debe_cambiar_pass = 0 WHERE id = ? AND negocio_id = ?')
        .bind(hashNueva, usr.id, negocio_id).run();
    } else {
      // Fallback legacy: tabla negocios
      const negocio = await env.producto_c_db
        .prepare('SELECT id, panel_password FROM negocios WHERE id = ? LIMIT 1')
        .bind(negocio_id).first();
      if (!negocio || negocio.panel_password !== hashActual)
        return Response.json({ success: false, error: 'Contraseña actual incorrecta' }, { status: 401, headers: cors });
      const hashNueva = await sha256(password_nueva);
      await env.producto_c_db
        .prepare('UPDATE negocios SET panel_password = ? WHERE id = ?')
        .bind(hashNueva, negocio_id).run();
    }

    return Response.json({ success: true, mensaje: 'Contraseña actualizada' }, { headers: cors });
  } catch (err) {
    return Response.json({ success: false, error: err.message }, { status: 500, headers: cors });
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: cors });
}
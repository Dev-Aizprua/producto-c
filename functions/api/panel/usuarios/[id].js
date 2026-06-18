// ============================================================
// functions/api/panel/usuarios/[id].js
// PUT /api/panel/usuarios/:id
// ============================================================

const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}

export async function onRequestPut({ request, env, data, params }) {
  const negocio_id = data.negocio_id;
  const id = params.id;

  const existe = await env.producto_c_db
    .prepare('SELECT id FROM usuarios WHERE id = ? AND negocio_id = ? LIMIT 1')
    .bind(id, negocio_id).first();
  if (!existe)
    return Response.json({ success: false, error: 'Usuario no encontrado' }, { status: 404, headers: cors });

  let body;
  try { body = await request.json(); }
  catch { return Response.json({ success: false, error: 'JSON inválido' }, { status: 400, headers: cors }); }

  const { nombre, usuario, rol, activo, password, debe_cambiar_pass } = body;
  const updates = [], bindings = [];

  if (nombre !== undefined)            { updates.push('nombre = ?');            bindings.push(nombre.trim()); }
  if (usuario !== undefined)           { updates.push('usuario = ?');           bindings.push(usuario.toLowerCase().trim()); }
  if (rol !== undefined && ['admin','recepcionista','especialista'].includes(rol)) {
                                         updates.push('rol = ?');               bindings.push(rol); }
  if (activo !== undefined)            { updates.push('activo = ?');            bindings.push(activo ? 1 : 0); }
  if (debe_cambiar_pass !== undefined) { updates.push('debe_cambiar_pass = ?'); bindings.push(debe_cambiar_pass ? 1 : 0); }
  if (password !== undefined) {
    if (password.length < 8)
      return Response.json({ success: false, error: 'Mínimo 8 caracteres' }, { status: 400, headers: cors });
    updates.push('password_hash = ?');
    bindings.push(await sha256(password));
  }

  if (!updates.length)
    return Response.json({ success: false, error: 'Nada que actualizar' }, { status: 400, headers: cors });

  try {
    await env.producto_c_db
      .prepare(`UPDATE usuarios SET ${updates.join(', ')} WHERE id = ? AND negocio_id = ?`)
      .bind(...bindings, id, negocio_id).run();
    return Response.json({ success: true, mensaje: 'Usuario actualizado' }, { headers: cors });
  } catch (err) {
    return Response.json({ success: false, error: err.message }, { status: 500, headers: cors });
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: cors });
}
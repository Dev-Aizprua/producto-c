// ============================================================
// functions/api/panel/usuarios.js
// GET  /api/panel/usuarios  — lista usuarios del negocio
// POST /api/panel/usuarios  — crear nuevo usuario
// El middleware ya validó el token y pasó negocio_id en context.data
// ============================================================

const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}

export async function onRequestGet({ env, data }) {
  const negocio_id = data.negocio_id;
  try {
    const { results } = await env.producto_c_db
      .prepare(`SELECT id, nombre, usuario, rol, activo, ultimo_acceso, debe_cambiar_pass, created_at
                FROM usuarios WHERE negocio_id = ? ORDER BY rol ASC, nombre ASC`)
      .bind(negocio_id).all();
    return Response.json({ success: true, usuarios: results }, { headers: cors });
  } catch (err) {
    return Response.json({ success: false, error: err.message }, { status: 500, headers: cors });
  }
}

export async function onRequestPost({ request, env, data }) {
  const negocio_id = data.negocio_id;
  let body;
  try { body = await request.json(); }
  catch { return Response.json({ success: false, error: 'JSON inválido' }, { status: 400, headers: cors }); }

  const { nombre, usuario, password, rol } = body;
  if (!nombre || !usuario || !password)
    return Response.json({ success: false, error: 'Nombre, usuario y contraseña son obligatorios' }, { status: 400, headers: cors });
  if (!['admin','recepcionista','especialista'].includes(rol))
    return Response.json({ success: false, error: 'Rol inválido' }, { status: 400, headers: cors });
  if (password.length < 8)
    return Response.json({ success: false, error: 'Mínimo 8 caracteres' }, { status: 400, headers: cors });

  try {
    const existe = await env.producto_c_db
      .prepare('SELECT id FROM usuarios WHERE negocio_id = ? AND usuario = ? LIMIT 1')
      .bind(negocio_id, usuario.toLowerCase()).first();
    if (existe)
      return Response.json({ success: false, error: 'El usuario ya existe' }, { status: 409, headers: cors });

    const hash = await sha256(password);
    await env.producto_c_db
      .prepare('INSERT INTO usuarios (negocio_id, nombre, usuario, password_hash, rol, activo) VALUES (?,?,?,?,?,1)')
      .bind(negocio_id, nombre.trim(), usuario.toLowerCase().trim(), hash, rol).run();
    return Response.json({ success: true, mensaje: 'Usuario creado' }, { headers: cors });
  } catch (err) {
    return Response.json({ success: false, error: err.message }, { status: 500, headers: cors });
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: cors });
}
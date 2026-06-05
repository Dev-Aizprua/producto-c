// ============================================================
// functions/api/panel/servicios.js
// GET    /api/panel/servicios        → listar servicios
// POST   /api/panel/servicios        → crear servicio
// PUT    /api/panel/servicios?id=X   → editar servicio
// DELETE /api/panel/servicios?id=X   → eliminar servicio
// ============================================================

const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

export async function onRequestGet(context) {
  const { env, data } = context;
  try {
    const { results } = await env.producto_c_db
      .prepare('SELECT * FROM servicios WHERE negocio_id = ? ORDER BY orden ASC')
      .bind(data.negocio_id).all();
    return Response.json({ success: true, servicios: results }, { headers: cors });
  } catch (err) {
    return Response.json({ success: false, error: err.message }, { status: 500, headers: cors });
  }
}

export async function onRequestPost(context) {
  const { request, env, data } = context;
  let body;
  try { body = await request.json(); }
  catch { return Response.json({ success: false, error: 'JSON inválido' }, { status: 400, headers: cors }); }

  const { nombre, descripcion, precio, imagen_url, icono, duracion, orden } = body;
  if (!nombre || !precio) {
    return Response.json({ success: false, error: 'nombre y precio requeridos' }, { status: 400, headers: cors });
  }

  try {
    const result = await env.producto_c_db
      .prepare(`INSERT INTO servicios (negocio_id, nombre, descripcion, precio, imagen_url, icono, duracion, orden, activo)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`)
      .bind(data.negocio_id, nombre, descripcion || '', precio, imagen_url || '', icono || '🛎️', duracion || '45 min', orden || 0)
      .run();

    return Response.json({ success: true, id: result.meta.last_row_id }, { headers: cors });
  } catch (err) {
    return Response.json({ success: false, error: err.message }, { status: 500, headers: cors });
  }
}

export async function onRequestPut(context) {
  const { request, env, data } = context;
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  if (!id) return Response.json({ success: false, error: 'id requerido' }, { status: 400, headers: cors });

  let body;
  try { body = await request.json(); }
  catch { return Response.json({ success: false, error: 'JSON inválido' }, { status: 400, headers: cors }); }

  const { nombre, descripcion, precio, imagen_url, icono, duracion, orden, activo } = body;

  try {
    await env.producto_c_db
      .prepare(`UPDATE servicios SET
        nombre = ?, descripcion = ?, precio = ?, imagen_url = ?,
        icono = ?, duracion = ?, orden = ?, activo = ?
        WHERE id = ? AND negocio_id = ?`)
      .bind(nombre, descripcion, precio, imagen_url, icono, duracion, orden, activo ?? 1, id, data.negocio_id)
      .run();

    return Response.json({ success: true, mensaje: 'Servicio actualizado' }, { headers: cors });
  } catch (err) {
    return Response.json({ success: false, error: err.message }, { status: 500, headers: cors });
  }
}

export async function onRequestDelete(context) {
  const { request, env, data } = context;
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  if (!id) return Response.json({ success: false, error: 'id requerido' }, { status: 400, headers: cors });

  try {
    await env.producto_c_db
      .prepare('DELETE FROM servicios WHERE id = ? AND negocio_id = ?')
      .bind(id, data.negocio_id).run();

    return Response.json({ success: true, mensaje: 'Servicio eliminado' }, { headers: cors });
  } catch (err) {
    return Response.json({ success: false, error: err.message }, { status: 500, headers: cors });
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: cors });
}
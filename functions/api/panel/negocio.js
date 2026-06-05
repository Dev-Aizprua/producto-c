// ============================================================
// functions/api/panel/negocio.js
// GET  /api/panel/negocio  → leer datos del negocio
// PUT  /api/panel/negocio  → actualizar datos del negocio
// ============================================================

const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

export async function onRequestGet(context) {
  const { env, data } = context;
  try {
    const negocio = await env.producto_c_db
      .prepare('SELECT id, slug, nombre, descripcion, logo_url, icono, color_primary, whatsapp_destino FROM negocios WHERE id = ? LIMIT 1')
      .bind(data.negocio_id).first();

    return Response.json({ success: true, negocio }, { headers: cors });
  } catch (err) {
    return Response.json({ success: false, error: err.message }, { status: 500, headers: cors });
  }
}

export async function onRequestPut(context) {
  const { request, env, data } = context;
  let body;
  try { body = await request.json(); }
  catch { return Response.json({ success: false, error: 'JSON inválido' }, { status: 400, headers: cors }); }

  const { nombre, descripcion, logo_url, icono, color_primary, whatsapp_destino } = body;

  try {
    await env.producto_c_db
      .prepare(`UPDATE negocios SET
        nombre = ?, descripcion = ?, logo_url = ?, icono = ?,
        color_primary = ?, whatsapp_destino = ?
        WHERE id = ?`)
      .bind(nombre, descripcion, logo_url, icono, color_primary, whatsapp_destino, data.negocio_id)
      .run();

    return Response.json({ success: true, mensaje: 'Negocio actualizado' }, { headers: cors });
  } catch (err) {
    return Response.json({ success: false, error: err.message }, { status: 500, headers: cors });
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: cors });
}
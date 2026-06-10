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
      .prepare('SELECT id, slug, nombre, descripcion, logo_url, icono, color_primary, whatsapp_destino, modo_reserva, monto_reserva, wa_phone_id, telegram_chat_id FROM negocios WHERE id = ? LIMIT 1')
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

  const { nombre, descripcion, logo_url, icono, color_primary, whatsapp_destino,
          wa_phone_id, wa_token, telegram_chat_id } = body;

  // Construir SET dinámico — solo actualiza los campos que vienen en el body
  const campos = [];
  const valores = [];

  if (nombre            !== undefined) { campos.push('nombre = ?');             valores.push(nombre); }
  if (descripcion       !== undefined) { campos.push('descripcion = ?');        valores.push(descripcion); }
  if (logo_url          !== undefined) { campos.push('logo_url = ?');           valores.push(logo_url); }
  if (icono             !== undefined) { campos.push('icono = ?');              valores.push(icono); }
  if (color_primary     !== undefined) { campos.push('color_primary = ?');      valores.push(color_primary); }
  if (whatsapp_destino  !== undefined) { campos.push('whatsapp_destino = ?');   valores.push(whatsapp_destino); }
  if (wa_phone_id       !== undefined) { campos.push('wa_phone_id = ?');        valores.push(wa_phone_id); }
  if (wa_token !== undefined && wa_token !== null && wa_token !== '') {
                                         campos.push('wa_token = ?');           valores.push(wa_token); }
  if (telegram_chat_id  !== undefined) { campos.push('telegram_chat_id = ?');   valores.push(telegram_chat_id); }

  if (campos.length === 0) {
    return Response.json({ success: false, error: 'Nada que actualizar' }, { status: 400, headers: cors });
  }

  valores.push(data.negocio_id);

  try {
    await env.producto_c_db
      .prepare(`UPDATE negocios SET ${campos.join(', ')} WHERE id = ?`)
      .bind(...valores)
      .run();

    return Response.json({ success: true, mensaje: 'Negocio actualizado' }, { headers: cors });
  } catch (err) {
    return Response.json({ success: false, error: err.message }, { status: 500, headers: cors });
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: cors });
}
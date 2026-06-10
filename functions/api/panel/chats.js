// ============================================================
// functions/api/panel/chats.js
// GET /api/panel/chats → listar conversaciones del negocio
// ============================================================

const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

export async function onRequestGet(context) {
  const { env, data } = context;
  try {
    const { results } = await env.producto_c_db
      .prepare(`SELECT id, session_token, cliente_nombre, cliente_tel,
                  historial_json, fecha, completado,
                  COALESCE(canal, 'web') as canal
                FROM chats
                WHERE negocio_id = ?
                ORDER BY fecha DESC
                LIMIT 50`)
      .bind(data.negocio_id).all();

    // Parsear historial_json y calcular cantidad de mensajes
    const chats = results.map(c => ({
      ...c,
      historial: JSON.parse(c.historial_json || '[]'),
      total_mensajes: JSON.parse(c.historial_json || '[]').length,
      canal: c.canal || 'web',
      historial_json: undefined,
    }));

    return Response.json({ success: true, chats }, { headers: cors });
  } catch (err) {
    return Response.json({ success: false, error: err.message }, { status: 500, headers: cors });
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: cors });
}
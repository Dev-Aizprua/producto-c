// ============================================================
// functions/api/panel/seguimientos.js
// GET /api/panel/seguimientos
// Lista los seguimientos automáticos enviados por Valeria
// (chats abandonados + citas sin pagar) para que el dueño
// tenga visibilidad y pueda intervenir manualmente si hace falta.
// ============================================================

const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

export async function onRequestGet({ env, data }) {
  try {
    // ─── Chats abandonados con seguimiento enviado ────────────
    const chatsRes = await env.producto_c_db.prepare(
      `SELECT id, cliente_nombre, cliente_tel, seguimiento_fecha, seguimiento_respondido,
              'chat' as tipo
       FROM chats
       WHERE negocio_id = ? AND seguimiento_enviado = 1
       ORDER BY seguimiento_fecha DESC
       LIMIT 30`
    ).bind(data.negocio_id).all();

    // ─── Citas sin pagar con seguimiento enviado ──────────────
    const citasRes = await env.producto_c_db.prepare(
      `SELECT ci.id, ci.cliente_nombre, ci.cliente_tel, ci.seguimiento_fecha, ci.seguimiento_respondido,
              ci.total, ci.estado_pago, s.nombre as servicio_nombre,
              'cita' as tipo
       FROM citas ci
       LEFT JOIN servicios s ON s.id = ci.servicio_id
       WHERE ci.negocio_id = ? AND ci.seguimiento_enviado = 1
       ORDER BY ci.seguimiento_fecha DESC
       LIMIT 30`
    ).bind(data.negocio_id).all();

    const chats = (chatsRes.results || []).map(c => ({
      ...c,
      etiqueta: 'Conversación abandonada',
    }));
    const citas = (citasRes.results || []).map(c => ({
      ...c,
      etiqueta: c.servicio_nombre ? `Cita sin pagar — ${c.servicio_nombre}` : 'Cita sin pagar',
      // Si la cita ya no está en esperando_pago, significa que se resolvió
      convertido: !['esperando_pago'].includes(c.estado_pago),
    }));

    // Unir y ordenar por fecha de seguimiento descendente
    const todos = [...chats, ...citas].sort((a, b) =>
      new Date(b.seguimiento_fecha || 0) - new Date(a.seguimiento_fecha || 0)
    );

    return Response.json({ success: true, seguimientos: todos }, { headers: cors });
  } catch (err) {
    return Response.json({ success: false, error: err.message }, { status: 500, headers: cors });
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: cors });
}
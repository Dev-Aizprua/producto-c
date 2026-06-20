// ============================================================
// functions/api/seguimiento.js
// GET /api/seguimiento
// Llamado por cron-job.org cada 30-60 min.
// Detecta conversaciones abandonadas y citas sin pagar con
// más de 16h de inactividad — envía UN seguimiento con valor
// agregado vía Valeria, y marca seguimiento_enviado=1 para
// nunca repetir.
//
// Margen de seguridad: 16h disparo + 8h margen = 24h límite Meta
//
// CAMBIO (Fase 8 — visibilidad panel):
// Ahora también guarda seguimiento_fecha (timestamp real del envío)
// para que el panel pueda mostrar "seguimiento enviado hace X tiempo"
// en lugar de solo un booleano sin fecha.
// ============================================================

const HORAS_SEGUIMIENTO = 16;
const CHAT_ID_DUENO = "8483416774";

export async function onRequestGet(context) {
  const { request, env } = context;

  // Seguridad — mismo patrón que /api/health
  const tokenRecibido = request.headers.get("X-Health-Token") || "";
  const tokenEsperado = env.HEALTH_TOKEN || "";
  if (tokenEsperado && tokenRecibido !== tokenEsperado) {
    return new Response("Unauthorized", { status: 401 });
  }

  const resultados = { chatsAbandonados: 0, citasSinPagar: 0, errores: [] };

  try {
    // ─── CASO A: CHATS ABANDONADOS (sin cita creada) ─────────
    // completado=0 → nunca llegó a generar cita
    // seguimiento_enviado=0 → nunca se le envió seguimiento
    // fecha < ahora - 16h → pasó el umbral
    let chatsAbandonados = [];
    try {
      const res = await env.producto_c_db.prepare(
        `SELECT c.id, c.negocio_id, c.cliente_tel, c.cliente_nombre, c.historial_json, n.nombre as negocio_nombre,
                n.wa_phone_id, n.wa_token, n.telegram_chat_id
         FROM chats c
         JOIN negocios n ON n.id = c.negocio_id
         WHERE c.completado = 0
           AND c.seguimiento_enviado = 0
           AND c.canal = 'whatsapp'
           AND c.fecha < datetime('now', '-${HORAS_SEGUIMIENTO} hours')
           AND n.activo = 1`
      ).all();
      chatsAbandonados = res.results || [];
    } catch(e) { resultados.errores.push(`Chats: ${e.message}`); }

    // ─── CASO B: CITAS SIN PAGAR ──────────────────────────────
    let citasSinPagar = [];
    try {
      const res = await env.producto_c_db.prepare(
        `SELECT ci.id, ci.negocio_id, ci.cliente_tel, ci.cliente_nombre, ci.servicio_id, ci.fecha_cita, ci.total,
                n.nombre as negocio_nombre, n.wa_phone_id, n.wa_token, n.telegram_chat_id, n.slug,
                s.nombre as servicio_nombre
         FROM citas ci
         JOIN negocios n ON n.id = ci.negocio_id
         LEFT JOIN servicios s ON s.id = ci.servicio_id
         WHERE ci.estado_pago = 'esperando_pago'
           AND ci.seguimiento_enviado = 0
           AND ci.created_at < datetime('now', '-${HORAS_SEGUIMIENTO} hours')
           AND n.activo = 1`
      ).all();
      citasSinPagar = res.results || [];
    } catch(e) { resultados.errores.push(`Citas: ${e.message}`); }

    // ─── PROCESAR CHATS ABANDONADOS ───────────────────────────
    for (const chat of chatsAbandonados) {
      try {
        let historial = [];
        try { historial = JSON.parse(chat.historial_json || "[]"); } catch(e) {}

        // Detectar último servicio mencionado en la conversación para dar valor agregado
        let servicios = [];
        try {
          const svc = await env.producto_c_db.prepare(
            "SELECT nombre, descripcion FROM servicios WHERE negocio_id = ? AND activo = 1"
          ).bind(chat.negocio_id).all();
          servicios = svc.results || [];
        } catch(e) {}

        const historialTexto = historial.map(h => h.content).join(" ").toLowerCase();
        const servicioMencionado = servicios.find(s => historialTexto.includes(s.nombre.toLowerCase()));

        const primerNombre = chat.cliente_nombre ? chat.cliente_nombre.trim().split(/\s+/)[0] : null;
        const saludo = primerNombre ? `Hola ${primerNombre} 😊` : "Hola 😊";

        let mensajeSeguimiento;
        if (servicioMencionado) {
          mensajeSeguimiento = `${saludo} Hace unas horas consultaste sobre ${servicioMencionado.nombre.toLowerCase()}.${servicioMencionado.descripcion ? ` ${servicioMencionado.descripcion}.` : ""} Si todavía deseas reservar una cita o tienes alguna consulta, con gusto puedo ayudarte.`;
        } else {
          mensajeSeguimiento = `${saludo} Vi que nos escribiste hace unas horas. Si todavía tienes alguna consulta sobre nuestros tratamientos o deseas agendar una cita, con gusto puedo ayudarte.`;
        }

        await enviarMensajeWA(chat.wa_token, chat.wa_phone_id, chat.cliente_tel, mensajeSeguimiento);

        // Guardamos también el momento exacto del envío — antes solo había un booleano
        await env.producto_c_db.prepare(
          "UPDATE chats SET seguimiento_enviado = 1, seguimiento_fecha = datetime('now') WHERE id = ?"
        ).bind(chat.id).run();

        if (chat.telegram_chat_id && env.TELEGRAM_TOKEN) {
          await notificarTelegram(env.TELEGRAM_TOKEN, chat.telegram_chat_id,
            `🔄 <b>SEGUIMIENTO ENVIADO</b>\n📞 +${chat.cliente_tel}${primerNombre ? ` (${primerNombre})` : ""}\n💬 Conversación abandonada hace +${HORAS_SEGUIMIENTO}h\n\n<i>Valeria reactivó la conversación.</i>`
          );
        }

        resultados.chatsAbandonados++;
      } catch(e) { resultados.errores.push(`Chat ${chat.id}: ${e.message}`); }
    }

    // ─── PROCESAR CITAS SIN PAGAR ──────────────────────────────
    for (const cita of citasSinPagar) {
      try {
        const primerNombre = cita.cliente_nombre ? cita.cliente_nombre.trim().split(/\s+/)[0] : null;
        const saludo = primerNombre ? `Hola ${primerNombre} 😊` : "Hola 😊";
        const nombreServicio = cita.servicio_nombre || "tu cita";

        const mensajeSeguimiento = `${saludo} Tu solicitud para ${nombreServicio} (${cita.fecha_cita || "fecha pendiente"}) sigue activa y reservada a tu nombre. Si gustas confirmarla, aquí tienes el enlace de pago nuevamente:\n\nSi ya no deseas continuar, no hay problema — solo dímelo y la liberamos. 😊`;

        await enviarMensajeWA(cita.wa_token, cita.wa_phone_id, cita.cliente_tel, mensajeSeguimiento);

        // Guardamos también el momento exacto del envío
        await env.producto_c_db.prepare(
          "UPDATE citas SET seguimiento_enviado = 1, seguimiento_fecha = datetime('now') WHERE id = ?"
        ).bind(cita.id).run();

        if (cita.telegram_chat_id && env.TELEGRAM_TOKEN) {
          await notificarTelegram(env.TELEGRAM_TOKEN, cita.telegram_chat_id,
            `🔄 <b>SEGUIMIENTO ENVIADO — CITA SIN PAGAR</b>\n📞 +${cita.cliente_tel}${primerNombre ? ` (${primerNombre})` : ""}\n🦷 ${nombreServicio}\n💰 $${cita.total}\n\n<i>Valeria recordó el pago pendiente.</i>`
          );
        }

        resultados.citasSinPagar++;
      } catch(e) { resultados.errores.push(`Cita ${cita.id}: ${e.message}`); }
    }

    return Response.json({ ok: true, ...resultados, ts: new Date().toISOString() });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
}

// ─── HELPERS ─────────────────────────────────────────────────────
async function enviarMensajeWA(waToken, phoneNumberId, to, texto) {
  try {
    const res = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${waToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: texto } })
    });
    return await res.json();
  } catch(e) { console.log("Error enviarMensajeWA:", e.message); }
}

async function notificarTelegram(token, chatId, texto) {
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: texto, parse_mode: "HTML" })
    });
  } catch(e) {}
}
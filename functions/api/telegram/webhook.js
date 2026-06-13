// ============================================================
// functions/api/telegram/webhook.js
// POST /api/telegram/webhook
// Recibe callbacks de los botones inline enviados al dueño
// (Confirmar / Rechazar / Pausar Bot) y actualiza D1.
// ============================================================

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const update = await request.json();
    const callback = update.callback_query;

    // Solo procesamos callbacks de botones — ignoramos mensajes normales
    if (!callback) {
      return Response.json({ ok: true });
    }

    const data       = callback.data || "";
    const chatId     = callback.message?.chat?.id;
    const messageId  = callback.message?.message_id;
    const callbackId = callback.id;

    // Formato del data: "accion:citaId" o "pausar:numero:negocioId"
    const [accion, ...resto] = data.split(":");

    if (accion === "confirmar" || accion === "rechazar") {
      const citaId = resto[0];
      const nuevoEstado = accion === "confirmar" ? "confirmada" : "cancelada";

      try {
        await env.producto_c_db
          .prepare("UPDATE citas SET estado_pago = ? WHERE id = ?")
          .bind(nuevoEstado, citaId).run();
      } catch(e) {
        console.log("Error actualizando cita:", e.message);
      }

      // Editar el mensaje original quitando los botones y marcando el resultado
      const icono = accion === "confirmar" ? "✅" : "❌";
      const etiqueta = accion === "confirmar" ? "Confirmada" : "Cancelada";
      const textoOriginal = callback.message?.text || "";

      await editarMensajeTelegram(env.TELEGRAM_TOKEN, chatId, messageId,
        `${textoOriginal}\n\n${icono} <b>${etiqueta} por Eduardo</b>`,
        null // sin botones tras la acción
      );

      await responderCallback(env.TELEGRAM_TOKEN, callbackId, `Cita ${etiqueta.toLowerCase()}`);
      return Response.json({ ok: true });
    }

    if (accion === "pausar" || accion === "reanudar") {
      const numero    = resto[0];
      const negocioId = resto[1];
      const citaId    = resto[2]; // necesario para reconstruir Confirmar/Rechazar

      if (accion === "pausar") {
        try {
          await env.producto_c_db
            .prepare("INSERT OR REPLACE INTO modos_manual (numero, negocio_id) VALUES (?, ?)")
            .bind(numero, negocioId).run();
        } catch(e) { console.log("Error pausando bot:", e.message); }
      } else {
        try {
          await env.producto_c_db
            .prepare("DELETE FROM modos_manual WHERE numero = ?")
            .bind(numero).run();
        } catch(e) { console.log("Error reanudando bot:", e.message); }
      }

      // Reconstruir el teclado: Confirmar/Rechazar arriba (igual que antes)
      // + botón inferior cambia según el nuevo estado
      const filaSuperior = [
        { text: "✅ Confirmar Cita", callback_data: `confirmar:${citaId}` },
        { text: "❌ Rechazar/Cancelar", callback_data: `rechazar:${citaId}` }
      ];

      const filaInferior = accion === "pausar"
        ? [{ text: "✅ Activar Bot de Nuevo", callback_data: `reanudar:${numero}:${negocioId}:${citaId}` }]
        : [{ text: "🛑 Pausar Bot (Intervención Manual)", callback_data: `pausar:${numero}:${negocioId}:${citaId}` }];

      await editarTecladoTelegram(env.TELEGRAM_TOKEN, chatId, messageId, {
        inline_keyboard: [filaSuperior, filaInferior]
      });

      const textoConfirm = accion === "pausar" ? "🛑 Bot pausado" : "🤖 Bot reanudado";
      await responderCallback(env.TELEGRAM_TOKEN, callbackId, textoConfirm);
      return Response.json({ ok: true });
    }

    // Acción desconocida
    await responderCallback(env.TELEGRAM_TOKEN, callbackId, "Acción no reconocida");
    return Response.json({ ok: true });

  } catch (error) {
    console.error("Error webhook Telegram:", error.message);
    return Response.json({ ok: true }); // Telegram requiere 200 siempre
  }
}

// ─── HELPERS ─────────────────────────────────────────────────────

// Edita SOLO el teclado de botones, sin tocar el texto del mensaje
async function editarTecladoTelegram(token, chatId, messageId, replyMarkup) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/editMessageReplyMarkup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        reply_markup: replyMarkup
      })
    });
    const result = await res.json();
    if (!result.ok) console.log("Error editMessageReplyMarkup:", JSON.stringify(result));
  } catch(e) { console.log("Error editando teclado Telegram:", e.message); }
}

// Edita un mensaje existente — usado para quitar botones tras confirmar/rechazar
async function editarMensajeTelegram(token, chatId, messageId, texto, replyMarkup) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text: texto,
        parse_mode: "HTML",
        reply_markup: replyMarkup || { inline_keyboard: [] }
      })
    });
    const result = await res.json();
    if (!result.ok) console.log("Error editMessageText:", JSON.stringify(result));
  } catch(e) { console.log("Error editando mensaje Telegram:", e.message); }
}

// Responde al callback para quitar el "reloj de carga" del botón en Telegram
async function responderCallback(token, callbackId, texto) {
  try {
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callback_query_id: callbackId,
        text: texto
      })
    });
  } catch(e) {}
}
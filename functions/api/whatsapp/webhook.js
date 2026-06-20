// PRODUCTO C — WhatsApp Business API
// Recepcionista virtual multi-tenant para clínicas dentales
// v2: flujo de reserva completo con estados y links de pago

import { resolverFechaNatural, obtenerHoy, formatearFechaLegible } from "../fechas.js";

const VERIFY_TOKEN = "PRODUCTOC_WA_2026";

// ─── VERIFICACIÓN DEL WEBHOOK (GET) ──────────────────────────────
export async function onRequestGet(context) {
  const { searchParams } = new URL(context.request.url);
  const mode      = searchParams.get("hub.mode");
  const token     = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return new Response(challenge, { status: 200 });
  }
  return new Response("Error de verificación", { status: 403 });
}

// ─── RECEPCIÓN DE MENSAJES (POST) ────────────────────────────────
export async function onRequestPost(context) {
  const { env } = context;

  try {
    const body = await context.request.json();

    if (body.object !== "whatsapp_business_account") {
      return new Response("No es WhatsApp", { status: 200 });
    }

    const entry  = body.entry?.[0];
    const change = entry?.changes?.[0];

    // Ignorar notificaciones de status (delivered, read, sent)
    if (change?.value?.statuses) {
      return new Response("EVENT_RECEIVED", { status: 200 });
    }

    const value         = change?.value;
    const message       = value?.messages?.[0];
    if (!message) return new Response("EVENT_RECEIVED", { status: 200 });

    const from          = message.from;
    const tipo          = message.type;
    const phoneNumberId = value?.metadata?.phone_number_id;
    const contacto      = value?.contacts?.[0];
    const nombrePerfil  = contacto?.profile?.name || null;

    // ─── DIAGNÓSTICO DE RETRASO META ──────────────────────────
    // message.timestamp viene en segundos UNIX (string).
    // Si Meta tarda en entregar el webhook, este valor lo revela
    // sin depender de Telegram ni KV — solo logs por ahora.
    const delaySegundos = Math.floor(Date.now()/1000 - Number(message.timestamp || 0));
    if (delaySegundos > 60) {
      console.log(`[DELAY META] Webhook llegó con ${delaySegundos}s de retraso (${Math.floor(delaySegundos/60)} min) — from:${from}`);
    }
    // Alerta Telegram si el retraso supera 5 minutos (incidencia Meta probable)
    // Se dispara ANTES de identificar el negocio para no bloquear el flujo,
    // usando el chat_id del negocio demo como fallback si negocio aún no está cargado.
    // La notificación real se envía después de identificar el negocio (ver abajo).
    const _delayAlertaPendiente = delaySegundos > 300;

    // ─── IDENTIFICAR NEGOCIO POR wa_phone_id ─────────────────
    let negocio = null;
    try {
      negocio = await env.producto_c_db.prepare(
        "SELECT * FROM negocios WHERE wa_phone_id = ? AND activo = 1 LIMIT 1"
      ).bind(phoneNumberId).first();
    } catch(e) { console.log("Error buscando negocio:", e.message); }

    if (!negocio) {
      console.log(`Negocio no encontrado para phone_number_id: ${phoneNumberId}`);
      return new Response("EVENT_RECEIVED", { status: 200 });
    }

    const negocioId = negocio.id;
    const waToken   = negocio.wa_token;

    // ─── ALERTA DE RETRASO META ───────────────────────────────
    // Si el webhook llegó con >5 min de retraso, notificamos al dueño.
    // Posible causa: incidencia transitoria de Meta (error is_transient:true code:2).
    if (_delayAlertaPendiente && negocio.telegram_chat_id && env.TELEGRAM_TOKEN) {
      const minutos = Math.floor(delaySegundos / 60);
      const textoAlerta =
        `🚨 <b>WEBHOOK RETRASADO — ${minutos} min</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `⏱ Retraso: ${delaySegundos}s (${minutos} min)\n` +
        `📱 Negocio: ${negocio.nombre}\n` +
        `📞 Número origen: +${from}\n\n` +
        `⚠️ <i>Posible incidencia Meta/WhatsApp Business API. ` +
        `Si el bot dejó de responder, puede ser una falla transitoria del proveedor.</i>`;
      try {
        await notificarTelegram(env.TELEGRAM_TOKEN, negocio.telegram_chat_id, textoAlerta);
      } catch(e) { console.log("Error alerta delay Telegram:", e.message); }
    }

    // ─── MODO MANUAL ─────────────────────────────────────────
    try {
      const modoManual = await env.producto_c_db.prepare(
        "SELECT 1 FROM modos_manual WHERE numero = ? AND negocio_id = ? LIMIT 1"
      ).bind(from, negocioId).first();

      if (modoManual) {
        const textoCliente = message.text?.body || "[imagen/audio]";
        if (negocio.telegram_chat_id && env.TELEGRAM_TOKEN) {
          await notificarTelegram(env.TELEGRAM_TOKEN, negocio.telegram_chat_id,
            `🎮 <b>MODO MANUAL — ${negocio.nombre}</b>\n\nPaciente: +${from}\n💬 "${textoCliente}"\n\n<i>IA pausada.</i>`
          );
        }
        return new Response("EVENT_RECEIVED", { status: 200 });
      }
    } catch(e) {}

    // ─── MANEJO DE AUDIO CON GROQ WHISPER ────────────────────
    if (tipo === "audio" || tipo === "voice") {
      const audioId  = message.audio?.id || message.voice?.id;
      const duracion = message.audio?.duration || message.voice?.duration || 0;

      if (duracion > 20) {
        await enviarMensaje(waToken, phoneNumberId, from,
          "Solo proceso audios de hasta 20 segundos. ¿Puedes escribirme o enviar un audio más corto? 😊"
        );
        return new Response("EVENT_RECEIVED", { status: 200 });
      }

      try {
        const mediaRes  = await fetch(`https://graph.facebook.com/v21.0/${audioId}`, {
          headers: { "Authorization": `Bearer ${waToken}` }
        });
        const mediaData = await mediaRes.json();
        const audioRes  = await fetch(mediaData.url, {
          headers: { "Authorization": `Bearer ${waToken}` }
        });
        const audioBlob = await audioRes.arrayBuffer();

        const formData = new FormData();
        formData.append("file", new Blob([audioBlob], { type: "audio/ogg" }), "audio.ogg");
        formData.append("model", "whisper-large-v3");
        formData.append("language", "es");

        const whisperRes  = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
          method: "POST",
          headers: { "Authorization": `Bearer ${env.GROQ_API_KEY}` },
          body: formData
        });
        const whisperData = await whisperRes.json();
        const transcripcion = whisperData.text || "";

        if (!transcripcion) {
          await enviarMensaje(waToken, phoneNumberId, from, "No pude entender el audio. ¿Puedes escribirme?");
          return new Response("EVENT_RECEIVED", { status: 200 });
        }
        message.text = { body: transcripcion };
        message.type = "text";
      } catch(e) {
        await enviarMensaje(waToken, phoneNumberId, from, "No pude procesar el audio. ¿Puedes escribirme?");
        return new Response("EVENT_RECEIVED", { status: 200 });
      }
    }

    // ─── MENSAJES INTERACTIVOS Y BOTONES ─────────────────────
    if (tipo === "interactive") {
      const textoBoton = message.interactive?.button_reply?.title
                      || message.interactive?.list_reply?.title || "";
      if (textoBoton) { message.text = { body: textoBoton }; message.type = "text"; }
    }
    if (tipo === "button") {
      const textoBoton = message.button?.text || message.button?.payload || "";
      if (textoBoton) { message.text = { body: textoBoton }; message.type = "text"; }
    }

    if (!["text", "interactive", "button"].includes(message.type)) {
      await enviarMensaje(waToken, phoneNumberId, from,
        "Recibí tu mensaje. Por ahora proceso texto y audios cortos. ¿En qué puedo ayudarte?"
      );
      return new Response("EVENT_RECEIVED", { status: 200 });
    }

    const textoRecibido = message.text?.body || "";

    // ─── AUTO-DETECCIÓN DE PAGO ───────────────────────────────
    // pago-ok.html envía al paciente de vuelta a WhatsApp con este texto exacto.
    // Lo detectamos aquí para actualizar la cita sin depender del webhook de PF.
    if (textoRecibido.trim() === "PAGO_COMPLETADO" || textoRecibido.trim() === "He completado mi pago") {
      let citaActualizada = null;
      try {
        citaActualizada = await env.producto_c_db.prepare(
          `SELECT id FROM citas WHERE negocio_id = ? AND cliente_tel = ? AND estado_pago = 'esperando_pago'
           ORDER BY id DESC LIMIT 1`
        ).bind(negocioId, from).first();
      } catch(e) {}

      if (citaActualizada) {
        try {
          await env.producto_c_db.prepare(
            `UPDATE citas SET estado_pago = 'pago_por_verificar' WHERE id = ?`
          ).bind(citaActualizada.id).run();
        } catch(e) { console.log("Error actualizando pago:", e.message); }

        // Notificar a Telegram que hay un pago pendiente de verificación
        if (negocio.telegram_chat_id && env.TELEGRAM_TOKEN) {
          const textoTgPago =
            `🔵 <b>PAGO POR VERIFICAR</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `📞 Paciente: +${from}${nombrePerfil ? ` (${nombrePerfil})` : ""}\n` +
            `🆔 Cita #${citaActualizada.id}\n\n` +
            `💳 <i>El paciente reporta haber completado el pago. Verifica en Páguelo Fácil y confirma la cita desde los botones anteriores.</i>`;
          try {
            await notificarTelegram(env.TELEGRAM_TOKEN, negocio.telegram_chat_id, textoTgPago);
          } catch(e) {}
        }

        // Responder al paciente confirmando recepción
        await marcarLeido(waToken, phoneNumberId, message.id);
        await new Promise(r => setTimeout(r, 1500));
        await enviarMensaje(waToken, phoneNumberId, from,
          `✅ ¡Recibimos tu notificación de pago! Estamos verificando tu transacción y en breve confirmamos tu cita. 😊`
        );
        return new Response("EVENT_RECEIVED", { status: 200 });
      }

      // Si no hay cita esperando pago, dejar que el flujo normal lo maneje
    }

    let miId = null;
    try {
      const ins = await env.producto_c_db.prepare(
        "INSERT INTO buffer_wa (negocio_id, numero, contenido, fecha, procesado) VALUES (?, ?, ?, ?, 0)"
      ).bind(negocioId, from, textoRecibido, new Date().toISOString()).run();
      miId = ins.meta?.last_row_id;
    } catch(e) { console.log("Error buffer:", e.message); }

    await new Promise(r => setTimeout(r, 8000));

    // Limpiar mensajes atascados de más de 5 minutos
    try {
      await env.producto_c_db.prepare(
        `UPDATE buffer_wa SET procesado = 1 WHERE negocio_id = ? AND numero = ? AND procesado = 0 AND fecha < datetime('now', '-5 minutes')`
      ).bind(negocioId, from).run();
    } catch(e) {}

    let mensajesBuffer = [];
    try {
      const buf = await env.producto_c_db.prepare(
        "SELECT id, contenido FROM buffer_wa WHERE negocio_id = ? AND numero = ? AND procesado = 0 ORDER BY id ASC"
      ).bind(negocioId, from).all();
      mensajesBuffer = buf.results || [];
    } catch(e) { mensajesBuffer = [{ id: miId, contenido: textoRecibido }]; }

    if (!mensajesBuffer.length) return new Response("EVENT_RECEIVED", { status: 200 });

    const primerIdPendiente = mensajesBuffer[0].id;
    if (miId && miId !== primerIdPendiente) return new Response("EVENT_RECEIVED", { status: 200 });

    const textoConsolidado = mensajesBuffer.map(m => m.contenido).join(" ");
    const idsBuffer        = mensajesBuffer.map(m => m.id);
    const msgId            = message.id;

    try {
      await env.producto_c_db.prepare(
        `UPDATE buffer_wa SET procesado = 1 WHERE id IN (${idsBuffer.join(",")})`
      ).run();
    } catch(e) {}

    // ─── CARGAR SERVICIOS ─────────────────────────────────────
    let servicios = [];
    try {
      const svc = await env.producto_c_db.prepare(
        "SELECT id, nombre, descripcion, precio, duracion, imagen_url FROM servicios WHERE negocio_id = ? AND activo = 1 ORDER BY orden ASC"
      ).bind(negocioId).all();
      servicios = svc.results || [];
    } catch(e) {}

    const catalogoTexto = servicios.map(s =>
      `• ${s.nombre} — $${s.precio} — ${s.duracion} min`
    ).join("\n");

    // ─── CARGAR HISTORIAL ─────────────────────────────────────
    let historial = [];
    let nombrePaciente = nombrePerfil || null;
    let sessionToken   = null;

    try {
      const chatResult = await env.producto_c_db.prepare(
        `SELECT id, historial_json, cliente_nombre, session_token FROM chats
         WHERE negocio_id = ? AND cliente_tel = ? AND completado = 0
         ORDER BY id DESC LIMIT 1`
      ).bind(negocioId, from).first();

      if (chatResult?.historial_json) {
        historial = JSON.parse(chatResult.historial_json).slice(-20);
      }
      if (chatResult?.cliente_nombre && !nombrePaciente) {
        nombrePaciente = chatResult.cliente_nombre;
      }
      sessionToken = chatResult?.session_token || `wa_${from}_${Date.now()}`;
    } catch(e) {
      sessionToken = `wa_${from}_${Date.now()}`;
    }

    const textoLower      = textoConsolidado.toLowerCase();
    const esPrimerMensaje = historial.length === 0;
    const modoReserva     = negocio.modo_reserva || "solo_cita";
    const montoReserva    = negocio.monto_reserva || 0;

    // ─── DETECTAR PACIENTE RECURRENTE ────────────────────────
    // Es "recurrente" si ya tuvo alguna cita antes (cualquier estado),
    // sin importar que el chat actual sea nuevo (chat anterior completado=1).
    let esPacienteRecurrente = false;
    if (esPrimerMensaje) {
      try {
        const citaPrevia = await env.producto_c_db.prepare(
          `SELECT cliente_nombre FROM citas WHERE negocio_id = ? AND cliente_tel = ?
           ORDER BY id DESC LIMIT 1`
        ).bind(negocioId, from).first();
        if (citaPrevia) {
          esPacienteRecurrente = true;
          if (citaPrevia.cliente_nombre && !nombrePaciente) {
            nombrePaciente = citaPrevia.cliente_nombre;
          }
        }
      } catch(e) {}
    }

    // Solo primer nombre — para saludos naturales ("Hola Eduardo" no "Hola Eduardo Aizprua")
    const primerNombrePaciente = nombrePaciente ? nombrePaciente.trim().split(/\s+/)[0] : null;

    // ─── ENVIAR IMAGEN SI PACIENTE MENCIONA UN SERVICIO ──────
    const imagenesServicio = {
      "limpieza dental": "https://images.pexels.com/photos/6627483/pexels-photo-6627483.jpeg?w=600&auto=compress",
      "blanqueamiento":  "https://images.pexels.com/photos/3762453/pexels-photo-3762453.jpeg?w=600&auto=compress",
      "implante dental": "https://images.pexels.com/photos/3845625/pexels-photo-3845625.jpeg?w=600&auto=compress",
      "ortodoncia":      "https://images.pexels.com/photos/5355830/pexels-photo-5355830.jpeg?w=600&auto=compress",
    };

    const servicioMencionadoAhora = servicios.find(s =>
      textoLower.includes(s.nombre.toLowerCase())
    );

    const imagenYaEnviada = historial.some(h =>
      h.role === "assistant" &&
      servicioMencionadoAhora &&
      h.content.toLowerCase().includes(`[img:${servicioMencionadoAhora.nombre.toLowerCase()}]`)
    );

    if (servicioMencionadoAhora && !imagenYaEnviada) {
      const imgUrl = servicioMencionadoAhora.imagen_url ||
        imagenesServicio[servicioMencionadoAhora.nombre.toLowerCase()] || null;

      if (imgUrl) {
        const caption = `🦷 ${servicioMencionadoAhora.nombre}\n💰 Desde $${servicioMencionadoAhora.precio} USD | ⏱ ${servicioMencionadoAhora.duracion} min${servicioMencionadoAhora.descripcion ? `\n${servicioMencionadoAhora.descripcion}` : ""}`;
        await enviarImagen(waToken, phoneNumberId, from, imgUrl, caption);
        await new Promise(r => setTimeout(r, 800));
        // Marcador invisible en historial para no reenviar la imagen
        historial.push({ role: "assistant", content: `[img:${servicioMencionadoAhora.nombre.toLowerCase()}]` });
      }
    }

    // ─── DETECCIÓN DIRECTA DE CONFIRMACIÓN ───────────────────
    // Si el paciente confirma Y el historial ya tiene los 3 datos,
    // generamos el pago directamente sin depender de Groq
    const historialTexto = historial.map(h => h.content).join(" ").toLowerCase();

    const servicioDetectado = servicios.find(s =>
      textoLower.includes(s.nombre.toLowerCase()) ||
      historialTexto.includes(s.nombre.toLowerCase())
    );

    const palabrasConfirmacion = [
      "si", "sí", "dale", "listo", "perfecto", "confirmo", "confirmar",
      "acepto", "quiero pagar", "pagar", "me anoto", "apúntame", "apuntame",
      "de acuerdo", "claro", "okay", "ok", "correcto", "adelante",
      "proceder", "vamos", "hagámoslo", "hagamoslo", "cómo pago", "como pago",
      "si los datos", "datos correctos", "todo correcto", "está bien", "esta bien"
    ];
    const esConfirmacion = palabrasConfirmacion.some(p => textoLower.includes(p));

    // ─── RESOLVER FECHA DEL HISTORIAL CON MOTOR DE FECHAS ────
    // La IA NUNCA calcula fechas — el backend lo hace.
    const hoyMotor = obtenerHoy();
    const textoHistorialUsuario = historial.filter(h => h.role === "user").map(h => h.content).join(" ");
    const fechaResueltaHistorial = textoHistorialUsuario ? resolverFechaNatural(textoHistorialUsuario) : null;
    const tieneFecha = fechaResueltaHistorial !== null;

    // Extraer nombre del paciente del historial si lo tenemos
    // Preferir nombre del historial sobre el perfil de WA (que puede tener errores)
    const nombreDelHistorial = historial
      .filter(h => h.role === "user")
      .map(h => h.content)
      .join(" ");

    // Buscar patrón "mi nombre es X" o "soy X" en el historial
    // Soporta fin de línea, fin de string, signos de puntuación o emojis
    const matchNombre = nombreDelHistorial.match(
      /mi nombre (?:completo )?es\s+([A-Za-záéíóúÁÉÍÓÚüÜñÑ]+(?:\s[A-Za-záéíóúÁÉÍÓÚüÜñÑ]+){0,3})|soy\s+([A-Za-záéíóúÁÉÍÓÚüÜñÑ]+(?:\s[A-Za-záéíóúÁÉÍÓÚüÜñÑ]+){0,3})|me llamo\s+([A-Za-záéíóúÁÉÍÓÚüÜñÑ]+(?:\s[A-Za-záéíóúÁÉÍÓÚüÜñÑ]+){0,3})/i
    );
    if (matchNombre) {
      const nombreExtraido = (matchNombre[1] || matchNombre[2] || matchNombre[3] || "")
        .trim()
        .replace(/\s+(quiero|necesito|para|y|el|la|un|una).*$/i, ""); // cortar si sigue otra frase
      if (nombreExtraido.length > 3) nombrePaciente = nombreExtraido;
    } else {
      // Si el bot preguntó por el nombre y el siguiente mensaje del usuario
      // son solo 2-4 palabras (típico de "Eduardo Aizprua" sin más contexto),
      // usarlo como nombre directamente.
      const ultimoBotPreguntoNombre = historial.some(h =>
        h.role === "assistant" &&
        /nombre completo|tu nombre|cuál es tu nombre/i.test(h.content)
      );
      const ultimoMensajeUsuario = historial.filter(h => h.role === "user").slice(-1)[0]?.content || "";
      const palabrasNombre = ultimoMensajeUsuario.trim().split(/\s+/);
      const pareceSoloNombre = palabrasNombre.length >= 2 && palabrasNombre.length <= 4 &&
        /^[A-Za-záéíóúÁÉÍÓÚüÜñÑ\s]+$/.test(ultimoMensajeUsuario.trim());

      if (ultimoBotPreguntoNombre && pareceSoloNombre) {
        nombrePaciente = ultimoMensajeUsuario.trim();
      }
    }

    const nombreEnHistorial = nombrePaciente && nombrePaciente !== "Paciente WA";

    // Verificar que el bot ya presentó el resumen de confirmación
    // Evita disparar el link cuando Valeria apenas está recopilando datos
    const botYaPresentoResumen = historial.some(h =>
      h.role === "assistant" &&
      /confirmas|confirmar la cita|para confirmar|resumen/i.test(h.content) &&
      (servicioDetectado ? h.content.toLowerCase().includes(servicioDetectado.nombre.toLowerCase()) : true)
    );

    // Si tenemos los 3 datos, el bot ya presentó resumen Y el paciente confirma — actuar directamente
    if (esConfirmacion && servicioDetectado && tieneFecha && nombreEnHistorial && modoReserva !== "solo_cita" && botYaPresentoResumen) {

      // Verificar que NO existe ya una cita esperando_pago para este número
      // Evita generar link duplicado cuando el paciente dice "ok" o "gracias" después
      let citaExistente = null;
      try {
        citaExistente = await env.producto_c_db.prepare(
          `SELECT id FROM citas WHERE negocio_id = ? AND cliente_tel = ? AND estado_pago = 'esperando_pago' LIMIT 1`
        ).bind(negocioId, from).first();
      } catch(e) {}

      if (citaExistente) {
        // Ya tiene cita pendiente — responder amablemente sin generar nuevo link
        await marcarLeido(waToken, phoneNumberId, message.id);
        await enviarMensaje(waToken, phoneNumberId, from,
          `Tu cita ya está registrada y esperando el pago. Usa el enlace que te enviamos para confirmarla. 😊`
        );
        return new Response("EVENT_RECEIVED", { status: 200 });
      }

      const montoFinal = modoReserva === "adelanto" ? montoReserva : servicioDetectado.precio;

      // Resolver fecha con Motor de Fechas — no con regex
      const fechaResuelta = fechaResueltaHistorial;
      const fechaTexto = fechaResuelta
        ? fechaResuelta.texto
        : "Por confirmar";
      const fechaISO = fechaResuelta ? fechaResuelta.fecha : null;

      let citaIdDirecta = null;
      try {
        const insertRes = await env.producto_c_db.prepare(
          `INSERT INTO citas (negocio_id, servicio_id, cliente_nombre, cliente_tel,
           fecha_cita, total, estado_pago, metodo_pago, session_token, canal)
           VALUES (?, ?, ?, ?, ?, ?, 'esperando_pago', 'paguelofacil', ?, 'whatsapp')`
        ).bind(
          negocioId,
          servicioDetectado.id,
          nombrePaciente,
          from,
          fechaISO || fechaTexto,
          montoFinal,
          sessionToken
        ).run();
        citaIdDirecta = insertRes.meta?.last_row_id;
      } catch(e) { console.log("Error creando cita directa:", e.message); }

      // Generar link de pago
      let linkDirecto = null;
      try {
        const pfRes = await fetch("https://producto-c.pages.dev/api/pago/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            slug:        negocio.slug,
            descripcion: `Reserva ${servicioDetectado.nombre} - ${negocio.nombre}`,
            monto:       montoFinal,
            canal:       "whatsapp"
          })
        });
        if (pfRes.ok) {
          const pfData = await pfRes.json();
          if (pfData.url) linkDirecto = pfData.url;
        }
      } catch(e) { console.log("Error link directo:", e.message); }

      const montoTexto = modoReserva === "adelanto"
        ? `un adelanto de $${montoFinal}`
        : `el pago de $${montoFinal}`;

      let respuestaDirecta = `¡Perfecto, ${primerNombrePaciente || nombrePaciente}! Tu cita de ${servicioDetectado.nombre} está reservada. Para confirmarla necesito ${montoTexto}.`;

      if (linkDirecto) {
        respuestaDirecta += `\n\n💳 Enlace de pago seguro:\n${linkDirecto}\n\n_Una vez confirmado el pago, tu cita quedará lista. ✅_`;
      }

      // Notificación Telegram con botones de acción
      if (negocio.telegram_chat_id && env.TELEGRAM_TOKEN && citaIdDirecta) {
        const fechaDisplay = fechaTexto || "Por confirmar";
        const textoTg = `🔔 <b>NUEVA CITA REGISTRADA</b>\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n👤 Cliente: ${nombrePaciente}\n🦷 Servicio: ${servicioDetectado.nombre}\n📅 Fecha: ${fechaDisplay}\n💰 Total: $${montoFinal} USD\n📱 Canal: WhatsApp\n📞 +${from}\n\n⏳ Estado: Esperando pago`;
        await notificarTelegramConBotones(env.TELEGRAM_TOKEN, negocio.telegram_chat_id, textoTg, citaIdDirecta, from, negocioId);
      }

      // Guardar historial
      try {
        const nuevoH = [...historial,
          { role: "user", content: textoConsolidado },
          { role: "assistant", content: respuestaDirecta }
        ];
        const chatEx = await env.producto_c_db.prepare(
          `SELECT id FROM chats WHERE negocio_id = ? AND cliente_tel = ? AND completado = 0 LIMIT 1`
        ).bind(negocioId, from).first();

        if (chatEx) {
          await env.producto_c_db.prepare(
            `UPDATE chats SET historial_json = ?, fecha = ? WHERE id = ?`
          ).bind(JSON.stringify(nuevoH), new Date().toISOString(), chatEx.id).run();
        }
      } catch(e) {}

      await marcarLeido(waToken, phoneNumberId, message.id);
      await new Promise(r => setTimeout(r, 2500));
      await enviarMensaje(waToken, phoneNumberId, from, respuestaDirecta);
      return new Response("EVENT_RECEIVED", { status: 200 });
    }

    // ─── REAGENDAMIENTO ──────────────────────────────────────
    // Detectar intención de cambiar/mover una cita existente
    const palabrasReagendamiento = [
      "reagendar", "reagendarme", "cambiar cita", "cambiar mi cita",
      "mover cita", "mover mi cita", "cambiar la cita", "otra fecha",
      "otro día", "otro horario", "cambiar fecha", "cambiar el día",
      "reprogramar", "reprogramarme", "posponer", "adelantar la cita"
    ];

    const quiereReagendar = palabrasReagendamiento.some(p => textoLower.includes(p));

    if (quiereReagendar) {
      // Buscar cita más reciente activa de este número
      let citaActiva = null;
      try {
        citaActiva = await env.producto_c_db.prepare(
          `SELECT ci.id, ci.estado_pago, ci.fecha_cita, ci.total,
                  s.nombre as servicio_nombre
           FROM citas ci
           LEFT JOIN servicios s ON s.id = ci.servicio_id
           WHERE ci.negocio_id = ? AND ci.cliente_tel = ?
             AND ci.estado_pago IN ('esperando_pago','pago_por_verificar','pendiente_confirmacion','confirmada')
           ORDER BY ci.id DESC LIMIT 1`
        ).bind(negocioId, from).first();
      } catch(e) {}

      if (!citaActiva) {
        // No tiene ninguna cita activa
        const respNoTieneCita = `No encontré ninguna cita activa a tu nombre en este momento. Si deseas agendar una nueva cita, con gusto te ayudo. 😊`;
        await marcarLeido(waToken, phoneNumberId, message.id);
        await new Promise(r => setTimeout(r, 1500));
        await enviarMensaje(waToken, phoneNumberId, from, respNoTieneCita);
        return new Response("EVENT_RECEIVED", { status: 200 });
      }

      const estadosValeriaPuedeGestionar = ["esperando_pago", "pago_por_verificar", "pendiente_confirmacion"];

      if (estadosValeriaPuedeGestionar.includes(citaActiva.estado_pago)) {
        // Valeria puede gestionar el cambio — pide nueva fecha
        const respValeriaPuede =
          `Claro${primerNombrePaciente ? ` ${primerNombrePaciente}` : ""}, puedo ayudarte con eso 😊\n\n` +
          `Tu solicitud actual es para ${citaActiva.servicio_nombre || "tu servicio"} — ${citaActiva.fecha_cita || "fecha pendiente"}.\n\n` +
          `¿Para qué fecha y hora prefieres reagendarla?`;

        // Guardar en historial que está reagendando — para que Groq lo sepa en el siguiente turno
        try {
          const nuevoH = [...historial,
            { role: "user", content: textoConsolidado },
            { role: "assistant", content: respValeriaPuede },
            { role: "system", content: `[REAGENDAMIENTO_ACTIVO:citaId=${citaActiva.id}|servicio=${citaActiva.servicio_nombre || ""}|fechaActual=${citaActiva.fecha_cita || ""}]` }
          ];
          const chatEx = await env.producto_c_db.prepare(
            `SELECT id FROM chats WHERE negocio_id = ? AND cliente_tel = ? AND completado = 0 LIMIT 1`
          ).bind(negocioId, from).first();
          if (chatEx) {
            await env.producto_c_db.prepare(
              `UPDATE chats SET historial_json = ?, fecha = ? WHERE id = ?`
            ).bind(JSON.stringify(nuevoH), new Date().toISOString(), chatEx.id).run();
          } else {
            await env.producto_c_db.prepare(
              `INSERT INTO chats (negocio_id, session_token, cliente_nombre, cliente_tel, historial_json, fecha, completado, canal) VALUES (?, ?, ?, ?, ?, ?, 0, 'whatsapp')`
            ).bind(negocioId, sessionToken, nombrePaciente || "Paciente WA", from, JSON.stringify(nuevoH), new Date().toISOString()).run();
          }
        } catch(e) {}

        await marcarLeido(waToken, phoneNumberId, message.id);
        await new Promise(r => setTimeout(r, 1500));
        await enviarMensaje(waToken, phoneNumberId, from, respValeriaPuede);
        return new Response("EVENT_RECEIVED", { status: 200 });

      } else {
        // Estado: confirmada — deriva al dueño
        const respDeriva =
          `Con gusto${primerNombrePaciente ? ` ${primerNombrePaciente}` : ""}. Como tu cita ya está confirmada, nuestro equipo revisará la disponibilidad y te ayudará con el cambio. En breve te contactarán. 😊`;

        // Notificar a Telegram
        if (negocio.telegram_chat_id && env.TELEGRAM_TOKEN) {
          try {
            await notificarTelegram(env.TELEGRAM_TOKEN, negocio.telegram_chat_id,
              `🔄 <b>SOLICITUD DE REAGENDAMIENTO</b>\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n👤 Paciente: ${nombrePaciente || "Desconocido"}\n📞 +${from}\n🦷 Servicio: ${citaActiva.servicio_nombre || "N/A"}\n📅 Fecha actual: ${citaActiva.fecha_cita || "N/A"}\n💬 Solicitud: "${textoConsolidado}"\n\n⚠️ <i>Cita confirmada — requiere gestión manual.</i>`
            );
          } catch(e) {}
        }

        try {
          const nuevoH = [...historial,
            { role: "user", content: textoConsolidado },
            { role: "assistant", content: respDeriva }
          ];
          const chatEx = await env.producto_c_db.prepare(
            `SELECT id FROM chats WHERE negocio_id = ? AND cliente_tel = ? AND completado = 0 LIMIT 1`
          ).bind(negocioId, from).first();
          if (chatEx) {
            await env.producto_c_db.prepare(
              `UPDATE chats SET historial_json = ?, fecha = ? WHERE id = ?`
            ).bind(JSON.stringify(nuevoH), new Date().toISOString(), chatEx.id).run();
          }
        } catch(e) {}

        await marcarLeido(waToken, phoneNumberId, message.id);
        await new Promise(r => setTimeout(r, 1500));
        await enviarMensaje(waToken, phoneNumberId, from, respDeriva);
        return new Response("EVENT_RECEIVED", { status: 200 });
      }
    }

    // ─── DETECTAR NUEVA FECHA SI HAY REAGENDAMIENTO ACTIVO ───
    // Si el historial tiene [REAGENDAMIENTO_ACTIVO], el próximo mensaje
    // con fecha es la nueva fecha — actualizamos la cita en D1
    const reagendamientoActivo = historial.find(h =>
      h.role === "system" && h.content?.startsWith("[REAGENDAMIENTO_ACTIVO:")
    );

    if (reagendamientoActivo) {
      const matchCitaId = reagendamientoActivo.content.match(/citaId=(\d+)/);
      const citaId = matchCitaId ? matchCitaId[1] : null;

      // Resolver nueva fecha con Motor de Fechas
      const fechaNuevaResuelta = resolverFechaNatural(textoConsolidado);
      const tieneFechaNueva = fechaNuevaResuelta !== null;

      if (tieneFechaNueva && citaId) {
        const fechaNuevaTexto = fechaNuevaResuelta.texto;
        const fechaNuevaISO = fechaNuevaResuelta.fecha;
        try {
          await env.producto_c_db.prepare(
            `UPDATE citas SET fecha_cita = ? WHERE id = ?`
          ).bind(fechaNuevaISO || fechaNuevaTexto, citaId).run();
        } catch(e) {}

        const respConfirmacion =
          `Perfecto${primerNombrePaciente ? ` ${primerNombrePaciente}` : ""} 😊 He actualizado tu solicitud para el ${fechaNuevaTexto}. Un miembro del equipo te confirmará la disponibilidad en breve.`;

        if (negocio.telegram_chat_id && env.TELEGRAM_TOKEN) {
          try {
            await notificarTelegram(env.TELEGRAM_TOKEN, negocio.telegram_chat_id,
              `🔄 <b>FECHA REAGENDADA</b>\n📞 +${from}${nombrePaciente ? ` (${nombrePaciente})` : ""}\n🆔 Cita #${citaId}\n📅 Nueva solicitud: ${textoConsolidado}\n\n<i>Valeria actualizó la fecha — confirmar disponibilidad.</i>`
            );
          } catch(e) {}
        }

        // Limpiar marcador de reagendamiento activo del historial
        const nuevoH = [
          ...historial.filter(h => !h.content?.startsWith("[REAGENDAMIENTO_ACTIVO:")),
          { role: "user", content: textoConsolidado },
          { role: "assistant", content: respConfirmacion }
        ];
        try {
          const chatEx = await env.producto_c_db.prepare(
            `SELECT id FROM chats WHERE negocio_id = ? AND cliente_tel = ? AND completado = 0 LIMIT 1`
          ).bind(negocioId, from).first();
          if (chatEx) {
            await env.producto_c_db.prepare(
              `UPDATE chats SET historial_json = ?, fecha = ? WHERE id = ?`
            ).bind(JSON.stringify(nuevoH), new Date().toISOString(), chatEx.id).run();
          }
        } catch(e) {}

        await marcarLeido(waToken, phoneNumberId, message.id);
        await new Promise(r => setTimeout(r, 1500));
        await enviarMensaje(waToken, phoneNumberId, from, respConfirmacion);
        return new Response("EVENT_RECEIVED", { status: 200 });
      }
    }

    // ─── INTERCEPTACIÓN DE TEMAS CRÍTICOS ────────────────────
    // Estos temas Valeria NO puede responder — no tiene la información.
    // Se responde directo sin pasar por Groq para evitar alucinaciones.
    const temasCriticos = [
      // Financiamiento
      { palabras: ["cuota", "cuotas", "financiamiento", "financiar", "abono", "abonos",
                   "pagar en parte", "pagar en partes", "mensualidad", "mensualidades",
                   "crédito", "credito", "aplazado", "diferido"],
        respuesta: "No tengo información registrada sobre opciones de financiamiento o pagos en cuotas. Con gusto puedo solicitar que un miembro del equipo te contacte para confirmarlo. 😊 ¿Te puedo ayudar con algo más?"
      },
      // Descuentos y promociones
      { palabras: ["descuento", "descuentos", "promoción", "promocion", "oferta", "ofertas",
                   "rebaja", "rebajas", "precio especial", "más barato", "mas barato"],
        respuesta: "No tengo información sobre descuentos o promociones activas en este momento. Para confirmar si hay alguna disponible, un miembro del equipo puede ayudarte. ¿Te gustaría que registre tu consulta?"
      },
      // Garantías y seguros
      { palabras: ["garantía", "garantia", "garantías", "garantias", "seguro", "seguro médico",
                   "seguro dental", "cobertura", "aseguradora", "reembolso"],
        respuesta: "No tengo información registrada sobre garantías o coberturas de seguro. Te recomiendo consultar directamente con nuestro equipo para que te orienten correctamente. 😊"
      },
      // Cancelaciones y reembolsos
      { palabras: ["cancelar", "cancelación", "cancelacion", "reembolso", "devolver", "devolución",
                   "devolucion", "reprogramar", "cambiar cita", "reagendar"],
        respuesta: "Para cancelaciones o cambios de cita, lo mejor es que un miembro del equipo te asista directamente. ¿Gustas que registre tu solicitud para que te contacten?"
      },
      // Horarios y disponibilidad específica
      { palabras: ["horario", "horarios", "qué días", "que dias", "abren", "cierran",
                   "están abiertos", "estan abiertos", "días de atención", "dias de atencion"],
        respuesta: "No tengo los horarios de atención configurados en este momento. Un miembro del equipo puede confirmarte la disponibilidad exacta. ¿Te gustaría que registre tu interés?"
      }
    ];

    const temaCriticoDetectado = temasCriticos.find(t =>
      t.palabras.some(p => textoLower.includes(p))
    );

    if (temaCriticoDetectado) {
      await marcarLeido(waToken, phoneNumberId, message.id);
      await new Promise(r => setTimeout(r, 1500));
      await enviarMensaje(waToken, phoneNumberId, from, temaCriticoDetectado.respuesta);

      // Notificar a Telegram que el paciente hizo una consulta fuera del catálogo
      if (negocio.telegram_chat_id && env.TELEGRAM_TOKEN) {
        try {
          await notificarTelegram(env.TELEGRAM_TOKEN, negocio.telegram_chat_id,
            `⚠️ <b>CONSULTA FUERA DE CATÁLOGO</b>\n📞 +${from}${nombrePaciente ? ` (${nombrePaciente})` : ""}\n💬 "${textoConsolidado}"\n\n<i>Valeria derivó al equipo — responde si puedes.</i>`
          );
        } catch(e) {}
      }

      // Guardar en historial
      try {
        const nuevoH = [...historial,
          { role: "user", content: textoConsolidado },
          { role: "assistant", content: temaCriticoDetectado.respuesta }
        ];
        const chatEx = await env.producto_c_db.prepare(
          `SELECT id FROM chats WHERE negocio_id = ? AND cliente_tel = ? AND completado = 0 LIMIT 1`
        ).bind(negocioId, from).first();
        if (chatEx) {
          await env.producto_c_db.prepare(
            `UPDATE chats SET historial_json = ?, fecha = ? WHERE id = ?`
          ).bind(JSON.stringify(nuevoH), new Date().toISOString(), chatEx.id).run();
        } else {
          await env.producto_c_db.prepare(
            `INSERT INTO chats (negocio_id, session_token, cliente_nombre, cliente_tel, historial_json, fecha, completado, canal) VALUES (?, ?, ?, ?, ?, ?, 0, 'whatsapp')`
          ).bind(negocioId, sessionToken, nombrePaciente || "Paciente WA", from, JSON.stringify(nuevoH), new Date().toISOString()).run();
        }
      } catch(e) {}

      return new Response("EVENT_RECEIVED", { status: 200 });
    }

    // ─── CONSTRUIR SYSTEM PROMPT ─────────────────────────────
    let instruccionPago = "";
    if (modoReserva === "solo_cita") {
      instruccionPago = `El pago se realiza en la clínica. Cuando el paciente confirme nombre, servicio y fecha, responde EXACTAMENTE con esta etiqueta al final de tu mensaje (sin explicarla):
[CREAR_CITA:nombre=NOMBRE_PACIENTE|servicio=NOMBRE_SERVICIO|fecha=FECHA_HORA]`;
    } else if (modoReserva === "adelanto") {
      instruccionPago = `Se requiere adelanto de $${montoReserva} para confirmar. Cuando el paciente confirme nombre, servicio y fecha, responde con esta etiqueta al final (sin explicarla):
[GENERAR_PAGO:nombre=NOMBRE_PACIENTE|servicio=NOMBRE_SERVICIO|fecha=FECHA_HORA|monto=${montoReserva}]`;
    } else if (modoReserva === "pago_completo") {
      instruccionPago = `El pago completo confirma la cita. Cuando el paciente confirme nombre, servicio y fecha, responde con esta etiqueta al final (sin explicarla):
[GENERAR_PAGO:nombre=NOMBRE_PACIENTE|servicio=NOMBRE_SERVICIO|fecha=FECHA_HORA|monto=PRECIO_SERVICIO]`;
    }

    const systemPrompt = `Eres Valeria, recepcionista virtual de ${negocio.nombre}, una clínica odontológica en Panamá.

━━━ IDENTIDAD ━━━
Tu nombre es Valeria. Lo dices UNA SOLA VEZ al inicio si te presentas. Después conversas normalmente.
Eres cálida, profesional y cercana — como una secretaria experimentada de clínica privada.
Nunca suenas como un chatbot. Nunca usas frases robóticas.
Si preguntan si eres IA: "Soy Valeria, la asistente virtual de ${negocio.nombre}, disponible 24/7 para ayudarte 😊"

━━━ FECHA Y HORA ACTUAL (PANAMÁ) ━━━
HOY ES: ${hoyMotor.dia} ${hoyMotor.fecha} — hora actual: ${String(hoyMotor.hora).padStart(2,"0")}:${String(hoyMotor.minutos).padStart(2,"0")}
${fechaResueltaHistorial ? `FECHA SOLICITADA POR EL PACIENTE (ya calculada): ${fechaResueltaHistorial.texto}` : ""}

⚠️ REGLA CRÍTICA DE FECHAS: NUNCA calcules fechas por tu cuenta.
NUNCA decidas qué día es "mañana", "el próximo lunes" o "la otra semana".
El sistema ya calculó la fecha correcta. Úsala tal como aparece arriba.
Si el paciente menciona una fecha nueva que no aparece arriba, respóndele con una confirmación natural y espera — el sistema la calculará en el siguiente turno.

━━━ TONO SEGÚN EL PACIENTE ━━━
PACIENTE ACTUAL: ${nombrePaciente || "Nuevo"}
PRIMER CONTACTO: ${esPrimerMensaje ? "SÍ" : "NO"}
PACIENTE RECURRENTE (ya tuvo cita antes): ${esPacienteRecurrente ? "SÍ" : "NO"}

Si es PRIMER CONTACTO y NO es recurrente (paciente totalmente nuevo):
— Saluda con calidez y presenta. Ejemplo: "¡Hola! 😊 Bienvenido a ${negocio.nombre}. Soy Valeria, con mucho gusto te ayudo. ¿Qué tratamiento te interesa?"

Si es PRIMER CONTACTO pero SÍ es recurrente (volvió después de tiempo, chat anterior ya cerrado):
— Salúdalo por su PRIMER NOMBRE solamente, sin presentarte de nuevo (ya te conoce). Ejemplo: "¡Hola${primerNombrePaciente ? ` ${primerNombrePaciente}` : ""}! 😊 Qué gusto verte de nuevo. ¿En qué puedo ayudarte hoy?"

Si NO es primer contacto (conversación ya en curso):
— Ve directo y personal con su PRIMER NOMBRE, sin saludo repetido. Ejemplo: "Claro${primerNombrePaciente ? ` ${primerNombrePaciente}` : ""}, ¿en qué más te ayudo?"

⚠️ Usa siempre solo el PRIMER NOMBRE del paciente al dirigirte a él de forma natural. Nunca el nombre completo en la conversación — eso suena formal/robótico. El nombre completo solo se usa internamente para el registro de la cita.

━━━ CATÁLOGO DE SERVICIOS ━━━
${catalogoTexto || "Consultar disponibilidad con el equipo."}

━━━ REGLA DE HIERRO — LO QUE VALERIA NO SABE ━━━
NUNCA inventes información. Si no está explícitamente en este prompt o en el catálogo, no lo sabes.
Esto aplica sin excepción para:
• Financiamiento, cuotas, abonos, crédito
• Descuentos, promociones, ofertas
• Garantías, coberturas de seguro, reembolsos
• Horarios exactos de atención
• Disponibilidad real de especialistas
• Políticas de cancelación
• Procedimientos clínicos no descritos en el catálogo
• Cualquier característica de los servicios no mencionada explícitamente

Si el paciente pregunta algo de esta lista, responde:
"No tengo esa información registrada. Con gusto solicito que un miembro del equipo te confirme ese detalle. 😊"

━━━ DISPONIBILIDAD DE CITAS ━━━
NO confirmes disponibilidad de horarios — no tienes acceso a la agenda real.
Cuando el paciente proponga una fecha/hora, registra su solicitud y aclara que el equipo confirmará.
Ejemplo correcto: "Perfecto, registraré tu solicitud para el viernes 19 a las 2pm. Un miembro del equipo te confirmará la disponibilidad. 😊"
NUNCA digas: "El miércoles está disponible" o "Tenemos ese horario libre"

━━━ SOLO USA INFORMACIÓN CONFIRMADA — REGLA UNIVERSAL ━━━
Esta regla aplica a TODO, no solo a servicios:
Solo puedes hablar de lo que está explícitamente en este prompt o en el catálogo de servicios.
Esto incluye también información operativa: ubicación exacta, estacionamiento, instalaciones,
equipo médico, especialistas disponibles, comodidades, accesibilidad, parqueo, transporte,
formas de pago aceptadas (más allá de las que ya conoces), o cualquier dato sobre la clínica
que no se te haya dado explícitamente.

Si te preguntan algo de la clínica que no tienes confirmado — aunque parezca una pregunta simple
o inofensiva como "¿tienen estacionamiento?" o "¿dónde están ubicados?" —
NUNCA respondas con un sí, no, ni con ningún dato inventado.

Responde siempre: "Esa información no la tengo confirmada en este momento. Con gusto puedo
solicitar que un miembro del equipo te la confirme. ¿Te ayudo con algo más sobre nuestros tratamientos? 😊"

Al describir servicios específicamente, usa ÚNICAMENTE lo que aparece en el catálogo de abajo.
No agregues beneficios, características, duración de resultados, ni detalles clínicos que no estén escritos explícitamente.

━━━ CÓMO RESPONDER SEGÚN LA SITUACIÓN ━━━

CONSULTA DE PRECIO:
No respondas solo el número. Genera valor primero.
Ejemplo — si preguntan por limpieza:
"La limpieza dental tiene un costo de $30. Incluye evaluación básica y limpieza profesional realizada por nuestro equipo odontológico. ¿Te gustaría que revisemos horarios disponibles? 😊"

INTERÉS EN UN SERVICIO (sin preguntar precio):
Primero entiende para quién es y qué busca. Una pregunta a la vez.
Ejemplo: "Claro que sí 😊 ¿Es para ti o para algún familiar? Así te oriento mejor sobre el tratamiento."

MIEDO O NERVIOS AL TRATAMIENTO:
Valida primero, luego tranquiliza, luego invita.
Ejemplo: "Es completamente normal sentirse así — muchos de nuestros pacientes llegan con esa misma inquietud. Nuestro equipo está muy acostumbrado a trabajar con personas que vienen nerviosas. Si gustas, puedo ayudarte a coordinar una evaluación para que el especialista te explique todo con calma antes de comenzar. ¿Te funcionaría esta semana?"
⚠️ NUNCA uses "más cómodo" — usa siempre "más tranquilo/a", "con más confianza", o "más a gusto" para evitar asumir género del paciente.

OBJECIÓN DE PRECIO ("está muy caro" / "déjame pensarlo"):
Nunca presiones. Nunca inventes urgencia.
Si dice "está muy caro": "Entiendo perfectamente 😊 ¿Gustas que te explique qué incluye el tratamiento o si tenemos alguna alternativa que se ajuste mejor a lo que buscas?"
Si dice "déjame pensarlo": "Claro que sí, tómate tu tiempo. Si tienes alguna consulta o quieres revisar disponibilidad, aquí estaré con gusto para ayudarte."

DISPONIBILIDAD REAL (cuando existe):
Comunícala de forma natural y honesta.
Ejemplo: "Actualmente tenemos disponibilidad para esta semana. Si algún horario te funciona, puedo ayudarte a reservarlo."
NUNCA digas "quedan pocos cupos" si no es cierto.

━━━ FLUJO PARA AGENDAR — UNA PREGUNTA A LA VEZ ━━━
1. Entiende qué servicio le interesa
2. Pide nombre completo
3. Confirma fecha y hora
4. Muestra resumen y pregunta "¿Confirmas la cita?" — SIN etiqueta todavía
5. SOLO cuando el paciente responda SÍ o cualquier palabra de confirmación — incluye la etiqueta AL FINAL

⚠️ MUY IMPORTANTE: NUNCA incluyas la etiqueta en el mismo mensaje del resumen.
El resumen y la etiqueta siempre van en mensajes separados.
Primero preguntas si confirma. Cuando responde que sí, entonces incluyes la etiqueta.

Ejemplo CORRECTO:
Valeria: "Perfecto Eduardo. Resumen: Limpieza Dental, miércoles 9 AM, $30. ¿Confirmas la cita?"
Paciente: "Sí"
Valeria: "¡Listo! Aquí tu enlace de pago. [GENERAR_PAGO:...]"

Ejemplo INCORRECTO (nunca hacer esto):
Valeria: "Resumen... ¿Confirmas? 💳 Enlace: [GENERAR_PAGO:...]"

ETIQUETA DE ACCIÓN (invisible para el paciente — nunca la expliques):
${instruccionPago}

PALABRAS QUE ACTIVAN LA ETIQUETA EN EL SIGUIENTE MENSAJE:
sí, si, dale, listo, perfecto, confirmo, acepto, quiero pagar, pagar, me anoto, apúntame, de acuerdo, claro, okay, ok, correcto, adelante, vamos, hagámoslo, proceder

━━━ EXPRESIONES NATURALES DE PANAMÁ ━━━
Usa estas de forma natural (no todas juntas):
"Con mucho gusto" · "Claro que sí" · "Perfecto" · "Excelente" · "Déjame verificar"
"Ya te ayudo" · "Te explico" · "No te preocupes" · "Con gusto" · "Tenemos espacio disponible"

━━━ REGLAS TÉCNICAS ━━━
• Máximo 4 líneas por mensaje. Máximo 2 emojis por mensaje.
• Una sola pregunta por mensaje — nunca interrogues.
• Termina siempre con una pregunta o invitación concreta.
• NUNCA mencionar: Cloudflare, Groq, API, Workers, base de datos, sistema.
• NUNCA mostrar ni explicar las etiquetas al paciente.
• SÍ puedes enviar enlaces de pago — el sistema los genera con la etiqueta. NUNCA digas "no puedo enviar el enlace".
• Idioma: español panameño, cálido y profesional. Sin jerga exagerada.`;

    // ─── LLAMAR A GROQ ────────────────────────────────────────
    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: systemPrompt },
          ...historial,
          { role: "user", content: textoConsolidado }
        ],
        temperature: 0.5,
        max_tokens: 400
      })
    });

    const groqData = await groqRes.json();
    let respuesta  = groqData.choices?.[0]?.message?.content
      || "Un momento, déjame verificar eso. 😊";

    // ─── PROCESAR ETIQUETAS DE ACCIÓN ────────────────────────
    // Groq incluye etiquetas estructuradas — las procesamos antes de enviar

    // Extraer datos de etiqueta
    function extraerEtiqueta(texto, tipo) {
      const regex = new RegExp(`\\[${tipo}:([^\\]]+)\\]`);
      const match = texto.match(regex);
      if (!match) return null;
      const datos = {};
      match[1].split("|").forEach(par => {
        const [k, v] = par.split("=");
        if (k && v) datos[k.trim()] = v.trim();
      });
      return datos;
    }

    // Limpiar etiqueta del texto visible al paciente
    function limpiarEtiquetas(texto) {
      return texto.replace(/\[CREAR_CITA:[^\]]+\]/g, "").replace(/\[GENERAR_PAGO:[^\]]+\]/g, "").trim();
    }

    let citaCreada   = false;
    let linkPago     = null;
    let datosCita    = null;

    // ── CASO 1: CREAR CITA DIRECTA (solo_cita) ───────────────
    // Solo aplica en modo solo_cita — en adelanto/pago_completo siempre requiere pago
    const datosCrear = modoReserva === 'solo_cita' ? extraerEtiqueta(respuesta, "CREAR_CITA") : null;
    if (datosCrear) {
      const svcEncontrado = servicios.find(s =>
        s.nombre.toLowerCase() === (datosCrear.servicio || "").toLowerCase() ||
        (datosCrear.servicio || "").toLowerCase().includes(s.nombre.toLowerCase())
      );

      // Resolver fecha de la etiqueta con Motor de Fechas
      const fechaCrearResuelta = datosCrear.fecha ? resolverFechaNatural(datosCrear.fecha) : null;
      const fechaCrearISO = fechaCrearResuelta ? fechaCrearResuelta.fecha : null;
      const fechaCrearTexto = fechaCrearResuelta ? fechaCrearResuelta.texto : (datosCrear.fecha || "Por confirmar");

      try {
        await env.producto_c_db.prepare(
          `INSERT INTO citas (negocio_id, servicio_id, cliente_nombre, cliente_tel,
           fecha_cita, total, estado_pago, metodo_pago, session_token, canal)
           VALUES (?, ?, ?, ?, ?, ?, 'confirmada', 'en_clinica', ?, 'whatsapp')`
        ).bind(
          negocioId,
          svcEncontrado?.id || null,
          datosCrear.nombre || nombrePaciente || "Paciente WA",
          from,
          fechaCrearISO || fechaCrearTexto,
          svcEncontrado?.precio || 0,
          sessionToken
        ).run();
        citaCreada = true;
        datosCita  = datosCrear;
      } catch(e) { console.log("Error creando cita:", e.message); }

      respuesta = limpiarEtiquetas(respuesta);
    }

    // ── CASO 2: GENERAR LINK DE PAGO (adelanto / pago_completo)
    const datosGenerar = extraerEtiqueta(respuesta, "GENERAR_PAGO");
    if (datosGenerar) {
      const svcEncontrado = servicios.find(s =>
        s.nombre.toLowerCase() === (datosGenerar.servicio || "").toLowerCase() ||
        (datosGenerar.servicio || "").toLowerCase().includes(s.nombre.toLowerCase())
      );

      const montoFinal = parseFloat(datosGenerar.monto) || montoReserva || svcEncontrado?.precio || 0;
      let citaIdGenerar = null;
      const nombreCitaGenerar = datosGenerar.nombre || nombrePaciente || "Paciente WA";

      // Resolver fecha de la etiqueta con Motor de Fechas
      const fechaGenerarResuelta = datosGenerar.fecha ? resolverFechaNatural(datosGenerar.fecha) : null;
      const fechaCitaGenerarISO = fechaGenerarResuelta ? fechaGenerarResuelta.fecha : null;
      const fechaCitaGenerar = fechaGenerarResuelta ? fechaGenerarResuelta.texto : (datosGenerar.fecha || "Por confirmar");

      // Crear cita en estado "esperando_pago"
      try {
        const citaRes = await env.producto_c_db.prepare(
          `INSERT INTO citas (negocio_id, servicio_id, cliente_nombre, cliente_tel,
           fecha_cita, total, estado_pago, metodo_pago, session_token, canal)
           VALUES (?, ?, ?, ?, ?, ?, 'esperando_pago', 'paguelofacil', ?, 'whatsapp')`
        ).bind(
          negocioId,
          svcEncontrado?.id || null,
          nombreCitaGenerar,
          from,
          fechaCitaGenerarISO || fechaCitaGenerar,
          montoFinal,
          sessionToken
        ).run();
        citaIdGenerar = citaRes.meta?.last_row_id;
        datosCita = datosGenerar;

        // Generar link de Páguelo Fácil
        const pfRes = await fetch("https://producto-c.pages.dev/api/pago/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            slug:        negocio.slug,
            descripcion: `Reserva ${datosGenerar.servicio || "servicio"} - ${negocio.nombre}`,
            monto:       montoFinal,
            canal:       "whatsapp"
          })
        });

        if (pfRes.ok) {
          const pfData = await pfRes.json();
          if (pfData.url) linkPago = pfData.url;
        }
      } catch(e) { console.log("Error generando pago:", e.message); }

      respuesta = limpiarEtiquetas(respuesta);

      // Agregar link al mensaje
      if (linkPago) {
        respuesta += `\n\n💳 *Enlace de pago seguro:*\n${linkPago}\n\n_Una vez confirmado el pago, tu cita quedará reservada. ✅_`;
      }

      // Notificación Telegram con botones de acción
      if (negocio.telegram_chat_id && env.TELEGRAM_TOKEN && citaIdGenerar) {
        const nombreServicioTg = svcEncontrado?.nombre || datosGenerar.servicio || "Servicio";
        const textoTg = `🔔 <b>NUEVA CITA REGISTRADA</b>\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n👤 Cliente: ${nombreCitaGenerar}\n🦷 Servicio: ${nombreServicioTg}\n📅 Fecha: ${fechaCitaGenerar}\n💰 Total: $${montoFinal} USD\n📱 Canal: WhatsApp\n📞 +${from}\n\n⏳ Estado: Esperando pago`;
        await notificarTelegramConBotones(env.TELEGRAM_TOKEN, negocio.telegram_chat_id, textoTg, citaIdGenerar, from, negocioId);
      }
    }

    // ─── GUARDAR HISTORIAL ────────────────────────────────────
    try {
      console.log(`[CHAT] Guardando historial — negocioId:${negocioId} from:${from} sessionToken:${sessionToken}`);
      const nuevoHistorial = [
        ...historial,
        { role: "user",      content: textoConsolidado },
        { role: "assistant", content: respuesta }
      ];

      const chatExistente = await env.producto_c_db.prepare(
        `SELECT id FROM chats WHERE negocio_id = ? AND cliente_tel = ? AND completado = 0 LIMIT 1`
      ).bind(negocioId, from).first();

      if (chatExistente) {
        await env.producto_c_db.prepare(
          `UPDATE chats SET historial_json = ?, cliente_nombre = ?, fecha = ?, completado = ?
           WHERE id = ?`
        ).bind(
          JSON.stringify(nuevoHistorial),
          nombrePaciente || "Paciente WA",
          new Date().toISOString(),
          citaCreada ? 1 : 0,
          chatExistente.id
        ).run();
      } else {
        await env.producto_c_db.prepare(
          `INSERT INTO chats (negocio_id, session_token, cliente_nombre, cliente_tel,
           historial_json, fecha, completado, canal)
           VALUES (?, ?, ?, ?, ?, ?, 0, 'whatsapp')`
        ).bind(
          negocioId, sessionToken,
          nombrePaciente || "Paciente WA",
          from,
          JSON.stringify(nuevoHistorial),
          new Date().toISOString()
        ).run();
      }
    } catch(e) { console.log("Error guardando chat:", e.message, e.stack); }

    // ─── DELAY HUMANO + ENVIAR ────────────────────────────────
    await marcarLeido(waToken, phoneNumberId, msgId);
    const palabras = respuesta.split(" ").length;
    const delayMs  = Math.min(Math.max(palabras * 80, 1500), 5000);
    await new Promise(r => setTimeout(r, delayMs));
    await enviarMensaje(waToken, phoneNumberId, from, respuesta);

    // ─── NOTIFICAR TELEGRAM ───────────────────────────────────
    if (negocio.telegram_chat_id && env.TELEGRAM_TOKEN) {
      let textoTg = `📱 <b>WhatsApp — ${negocio.nombre}</b>\n\nPaciente: +${from}${nombrePaciente ? ` (${nombrePaciente})` : ""}\n💬 "${textoConsolidado}"`;

      if (citaCreada && datosCita) {
        textoTg += `\n\n✅ <b>CITA CREADA</b>\nServicio: ${datosCita.servicio}\nFecha: ${datosCita.fecha}`;
      } else if (linkPago && datosCita) {
        textoTg += `\n\n🔔 <b>ESPERANDO PAGO</b>\nServicio: ${datosCita.servicio}\nFecha: ${datosCita.fecha}\nLink enviado al paciente`;
      }

      try { await notificarTelegram(env.TELEGRAM_TOKEN, negocio.telegram_chat_id, textoTg); } catch(e) {}
    }

    return new Response("EVENT_RECEIVED", { status: 200 });

  } catch (error) {
    console.error("Error webhook.js:", error.message);
    return new Response("EVENT_RECEIVED", { status: 200 });
  }
}

// ─── HELPERS ─────────────────────────────────────────────────────
async function marcarLeido(waToken, phoneNumberId, messageId) {
  if (!messageId) return;
  try {
    await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${waToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", status: "read", message_id: messageId })
    });
  } catch(e) {}
}

// Nota: el indicador "escribiendo..." (typing_indicator) fue removido.
// Meta rechaza este campo para esta cuenta de WhatsApp Business
// (error code 100, enum no incluye typing_indicator). Probado con
// v21, v23, v25 y formato legacy status:typing — todos fallan.
// El delay humano sigue funcionando normalmente sin esto.

async function enviarMensaje(waToken, phoneNumberId, to, texto) {
  try {
    const res = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${waToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: texto } })
    });
    const result = await res.json();
    console.log("Meta response:", JSON.stringify(result));
    return result;
  } catch(e) { console.log("Error enviarMensaje:", e.message); }
}

async function notificarTelegram(token, chatId, texto) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: texto, parse_mode: "HTML" })
  });
}

// Notificación con botones inline — Confirmar / Rechazar / Pausar Bot
async function notificarTelegramConBotones(token, chatId, texto, citaId, numero, negocioId) {
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: texto,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ Confirmar Cita", callback_data: `confirmar:${citaId}` },
              { text: "❌ Rechazar/Cancelar", callback_data: `rechazar:${citaId}` }
            ],
            [
              { text: "🛑 Pausar Bot (Intervención Manual)", callback_data: `pausar:${numero}:${negocioId}:${citaId}` }
            ]
          ]
        }
      })
    });
  } catch(e) { console.log("Error notificarTelegramConBotones:", e.message); }
}

// ─── ENVIAR IMAGEN CON CAPTION ────────────────────────────────────
async function enviarImagen(waToken, phoneNumberId, to, imageUrl, caption) {
  try {
    const res = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${waToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "image",
        image: {
          link: imageUrl,
          caption: caption
        }
      })
    });
    const result = await res.json();
    console.log("Imagen enviada:", JSON.stringify(result));
    return result;
  } catch(e) { console.log("Error enviarImagen:", e.message); }
}
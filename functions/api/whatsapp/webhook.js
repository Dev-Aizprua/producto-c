// PRODUCTO C — WhatsApp Business API
// Recepcionista virtual multi-tenant para clínicas dentales
// v2: flujo de reserva completo con estados y links de pago

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
    if (textoRecibido.trim() === "He completado mi pago ✅") {
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

    // Detectar si el historial menciona una fecha/hora
    const tieneFecha = /mañana|lunes|martes|miércoles|jueves|viernes|sábado|domingo|\d{1,2}[\/:]\d{1,2}|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre|am|pm|tarde|mañana|mediodía/.test(historialTexto);

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

    // Si tenemos los 3 datos y el paciente confirma — actuar directamente
    if (esConfirmacion && servicioDetectado && tieneFecha && nombreEnHistorial && modoReserva !== "solo_cita") {

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

      // Extraer fecha aproximada del historial
      const fechaMatch = historialTexto.match(/mañana.*?(\d{1,2})\s*(am|pm|de la tarde|de la mañana)|(\d{1,2}[\/:]?\d{0,2})\s*(am|pm)/i);
      const fechaTexto = fechaMatch ? fechaMatch[0] : "Por confirmar";

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
          fechaTexto,
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
            descripcion: `Reserva ${servicioDetectado.nombre} — ${negocio.nombre}`,
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

      let respuestaDirecta = `¡Perfecto, ${nombrePaciente}! Tu cita de ${servicioDetectado.nombre} está reservada. Para confirmarla necesito ${montoTexto}.`;

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

    const systemPrompt = `Eres la recepcionista virtual de ${negocio.nombre}, una clínica dental en Panamá.

CATÁLOGO DE SERVICIOS:
${catalogoTexto || "Consultar disponibilidad."}

PACIENTE ACTUAL: ${nombrePaciente || "No identificado"}
PRIMER CONTACTO: ${esPrimerMensaje ? "SÍ — saluda calurosamente" : "NO"}

FLUJO DE RESERVA — ORDEN EXACTO:
1. Saluda y pregunta en qué puedes ayudar.
2. Presenta servicios con precios cuando pregunten.
3. Cuando quieran agendar: pide nombre completo, luego servicio, luego fecha y hora.
4. Cuando tengas nombre + servicio + fecha: muestra resumen y pregunta si confirma.
5. EN CUANTO el paciente diga sí, dale, listo, confirmo, quiero pagar, o cualquier aceptación — INMEDIATAMENTE incluye la etiqueta al final. NO pidas más confirmaciones. NO esperes más datos.

ETIQUETA DE ACCIÓN — incluir pegada al final de tu mensaje cuando el paciente confirme:
${instruccionPago}

PALABRAS QUE ACTIVAN LA ETIQUETA YA: si, sí, dale, listo, perfecto, confirmo, acepto, quiero pagar, pagar, me anoto, apúntame, de acuerdo, claro, okay, ok, correcto, adelante, proceder, vamos, hagámoslo

REGLAS:
• Máximo 4 líneas por mensaje. Máximo 2 emojis.
• Termina siempre con una pregunta o acción concreta.
• Nunca inventes disponibilidad — "verificamos con el equipo".
• Si preguntan si eres IA: "Soy la asistente virtual de ${negocio.nombre}, disponible 24/7."
• Idioma: español panameño, cálido y profesional.
• NUNCA mencionar: Cloudflare, Groq, API, base de datos.
• NUNCA mostrar ni explicar las etiquetas al paciente — son invisibles.
• SÍ PUEDES enviar enlaces de pago — el sistema los genera automáticamente con la etiqueta de acción. Si el paciente pide el link, pregunta o ya tiene los datos completos (nombre+servicio+fecha), incluye la etiqueta de acción — el sistema se encarga del resto. NUNCA digas "no puedo enviar enlaces" ni similar.`;

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
        temperature: 0.3,
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
          datosCrear.fecha || "Por confirmar",
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
      const fechaCitaGenerar  = datosGenerar.fecha || "Por confirmar";

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
          fechaCitaGenerar,
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
            descripcion: `Reserva ${datosGenerar.servicio || "servicio"} — ${negocio.nombre}`,
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
// ============================================================
// MONITOREO PROACTIVO 24/7 — Cron Trigger cada 10 minutos
// Cloudflare ejecuta este handler automáticamente.
// Verifica: Groq (IA) + D1 (base de datos)
// Notifica a Telegram si algo falla, con silenciador anti-spam.
// ============================================================

export async function scheduled(event, env, ctx) {
  ctx.waitUntil(ejecutarChequeoSalud(env));
}

async function ejecutarChequeoSalud(env) {
  const TELEGRAM_TOKEN  = env.TELEGRAM_TOKEN;
  const GROQ_API_KEY    = env.GROQ_API_KEY;
  const DB              = env.producto_c_db;

  // Chat ID del dueño — dental-demo (Eduardo)
  // En el futuro puede leerse de D1 para ser multi-tenant
  const CHAT_ID_DUENO   = "8483416774";

  // Silenciador: solo notificar si pasaron >20 min desde la última alerta
  // Se guarda en D1 tabla health_checks (la creamos si no existe)
  const MINUTOS_SILENCIO = 20;

  const errores = [];

  // ── CHEQUEO 1: D1 (base de datos) ────────────────────────
  try {
    await DB.prepare("SELECT 1").first();
  } catch(e) {
    errores.push(`🗄️ <b>D1 (Base de datos)</b>\n   Error: ${e.message}`);
  }

  // ── CHEQUEO 2: Groq (IA) — ping mínimo de 1 token ────────
  try {
    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1
      })
    });

    if (!groqRes.ok) {
      const groqData = await groqRes.json().catch(() => ({}));
      const codigo   = groqData.error?.code || groqRes.status;
      const mensaje  = groqData.error?.message || "Sin respuesta";

      if (groqRes.status === 429) {
        errores.push(`🤖 <b>Groq (IA)</b>\n   ⚠️ Rate limit excedido (429) — posible saturación`);
      } else {
        errores.push(`🤖 <b>Groq (IA)</b>\n   Error ${codigo}: ${mensaje.slice(0, 80)}`);
      }
    }
  } catch(e) {
    errores.push(`🤖 <b>Groq (IA)</b>\n   Sin conexión: ${e.message}`);
  }

  // ── Si todo está bien: silencio total, solo log ───────────
  if (errores.length === 0) {
    console.log(`[HEALTH CHECK] ✅ OK — ${new Date().toISOString()}`);
    return;
  }

  // ── Hay errores: verificar silenciador antes de notificar ─
  try {
    // Crear tabla si no existe (primera vez)
    await DB.prepare(`
      CREATE TABLE IF NOT EXISTS health_checks (
        id INTEGER PRIMARY KEY,
        ultima_alerta TEXT,
        ultimo_error TEXT
      )
    `).run();

    const registro = await DB.prepare(
      "SELECT ultima_alerta FROM health_checks WHERE id = 1"
    ).first();

    const ahora        = Date.now();
    const ultimaAlerta = registro?.ultima_alerta ? Number(registro.ultima_alerta) : 0;
    const minutosPasados = (ahora - ultimaAlerta) / 60000;

    if (minutosPasados < MINUTOS_SILENCIO) {
      console.log(`[HEALTH CHECK] ❌ Error detectado pero silenciado (última alerta hace ${Math.floor(minutosPasados)} min)`);
      return;
    }

    // Actualizar timestamp de última alerta
    if (registro) {
      await DB.prepare(
        "UPDATE health_checks SET ultima_alerta = ?, ultimo_error = ? WHERE id = 1"
      ).bind(String(ahora), errores.join(" | ")).run();
    } else {
      await DB.prepare(
        "INSERT INTO health_checks (id, ultima_alerta, ultimo_error) VALUES (1, ?, ?)"
      ).bind(String(ahora), errores.join(" | ")).run();
    }
  } catch(e) {
    console.log("[HEALTH CHECK] Error en silenciador:", e.message);
    // Si falla el silenciador, notificamos igual para no perder la alerta
  }

  // ── Enviar alerta a Telegram ──────────────────────────────
  const hora = new Date().toLocaleTimeString("es-PA", {
    timeZone: "America/Panama",
    hour: "2-digit",
    minute: "2-digit"
  });

  const textoAlerta =
    `🔴 <b>ALERTA DE SISTEMA — ${hora}</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    errores.join("\n\n") +
    `\n\n🕐 <i>Chequeo automático cada 10 min.\n` +
    `Próxima alerta en mín. ${MINUTOS_SILENCIO} min si persiste.</i>`;

  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CHAT_ID_DUENO,
        text: textoAlerta,
        parse_mode: "HTML"
      })
    });
    console.log(`[HEALTH CHECK] ❌ Alerta enviada a Telegram — ${errores.length} error(es)`);
  } catch(e) {
    console.log("[HEALTH CHECK] Error enviando alerta Telegram:", e.message);
  }
}
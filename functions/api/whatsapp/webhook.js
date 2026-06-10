// PRODUCTO C — WhatsApp Business API
// Recepcionista virtual multi-tenant para clínicas dentales
// Arquitectura: un webhook, múltiples clínicas identificadas por wa_phone_id

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

    const value   = body.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];

    if (!message) return new Response("EVENT_RECEIVED", { status: 200 });

    // ─── IGNORAR NOTIFICACIONES DE STATUS ────────────────────
    if (body.entry?.[0]?.changes?.[0]?.field === "statuses") {
      return new Response("EVENT_RECEIVED", { status: 200 });
    }

    const from         = message.from;
    const tipo         = message.type;
    const phoneNumberId = value?.metadata?.phone_number_id;
    const contacto     = value?.contacts?.[0];
    const nombrePerfil = contacto?.profile?.name || null;

    // ─── IDENTIFICAR NEGOCIO POR wa_phone_id ─────────────────
    // Cada clínica tiene su propio número WA → su propio phone_number_id
    let negocio = null;
    try {
      const result = await env.DB.prepare(
        "SELECT * FROM negocios WHERE wa_phone_id = ? AND activo = 1 LIMIT 1"
      ).bind(phoneNumberId).first();
      negocio = result;
    } catch(e) {
      console.log("Error buscando negocio:", e.message);
    }

    if (!negocio) {
      console.log(`Negocio no encontrado para phone_number_id: ${phoneNumberId}`);
      return new Response("EVENT_RECEIVED", { status: 200 });
    }

    const negocioId = negocio.id;
    const waToken   = negocio.wa_token;

    // ─── MODO MANUAL — dueño tomó control, IA en pausa ───────
    try {
      const modoManual = await env.DB.prepare(
        "SELECT 1 FROM modos_manual WHERE numero = ? AND negocio_id = ? LIMIT 1"
      ).bind(from, negocioId).first();

      if (modoManual) {
        const textoCliente = message.text?.body || message.button?.text || "[imagen/audio]";
        // Notificar al dueño por Telegram que llegó un mensaje en modo manual
        if (negocio.telegram_chat_id) {
          await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: negocio.telegram_chat_id,
              text: `🎮 <b>MODO MANUAL — ${negocio.nombre}</b>\n\nPaciente: +${from}\n💬 "${textoCliente}"\n\n<i>IA pausada. Responde directamente desde WhatsApp.</i>`,
              parse_mode: "HTML"
            })
          });
        }
        return new Response("EVENT_RECEIVED", { status: 200 });
      }
    } catch(e) { /* tabla puede no existir aún */ }

    // ─── MANEJO DE AUDIO CON GROQ WHISPER ────────────────────
    if (tipo === "audio") {
      const audioId      = message.audio?.id;
      const fileSize     = message.audio?.file_size || message.voice?.file_size || 0;
      const duracion     = message.audio?.duration || message.voice?.duration || 0;
      const esLargo      = duracion > 20 || fileSize > 120000;

      if (esLargo) {
        await enviarMensaje(waToken, phoneNumberId, from,
          "Disculpa, solo puedo procesar audios de hasta 20 segundos. ¿Puedes escribirme tu consulta o enviar un audio más corto? 😊"
        );
        return new Response("EVENT_RECEIVED", { status: 200 });
      }

      try {
        // 1. Obtener URL del audio desde Meta
        const mediaRes  = await fetch(`https://graph.facebook.com/v21.0/${audioId}`, {
          headers: { "Authorization": `Bearer ${waToken}` }
        });
        const mediaData = await mediaRes.json();

        // 2. Descargar audio
        const audioRes  = await fetch(mediaData.url, {
          headers: { "Authorization": `Bearer ${waToken}` }
        });
        if (!audioRes.ok) {
          await enviarMensaje(waToken, phoneNumberId, from, "No pude procesar el audio. ¿Puedes escribirme tu consulta?");
          return new Response("EVENT_RECEIVED", { status: 200 });
        }
        const audioBlob  = await audioRes.arrayBuffer();

        // 3. Transcribir con Groq Whisper
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

        // Continuar flujo con la transcripción como texto
        message.text = { body: transcripcion };
        message.type = "text";

      } catch(e) {
        console.log("Error transcribiendo audio:", e.message);
        await enviarMensaje(waToken, phoneNumberId, from, "No pude procesar el audio. ¿Puedes escribirme tu consulta?");
        return new Response("EVENT_RECEIVED", { status: 200 });
      }
    }

    // ─── MENSAJES INTERACTIVOS Y BOTONES ─────────────────────
    if (tipo === "interactive") {
      const buttonReply = message.interactive?.button_reply;
      const listReply   = message.interactive?.list_reply;
      const textoBoton  = buttonReply?.title || listReply?.title || "";
      if (textoBoton) {
        message.text = { body: textoBoton };
        message.type = "text";
      } else {
        await enviarMensaje(waToken, phoneNumberId, from, "Recibí tu selección. ¿En qué puedo ayudarte?");
        return new Response("EVENT_RECEIVED", { status: 200 });
      }
    }

    if (tipo === "button") {
      const textoBoton = message.button?.text || message.button?.payload || "";
      if (textoBoton) {
        message.text = { body: textoBoton };
        message.type = "text";
      } else {
        await enviarMensaje(waToken, phoneNumberId, from, "Recibí tu selección. ¿En qué puedo ayudarte?");
        return new Response("EVENT_RECEIVED", { status: 200 });
      }
    }

    // ─── OTROS TIPOS NO SOPORTADOS ────────────────────────────
    if (!["text", "audio", "image", "interactive", "button"].includes(tipo)) {
      await enviarMensaje(waToken, phoneNumberId, from,
        "Recibí tu mensaje. Por ahora proceso texto y audios. ¿En qué puedo ayudarte?"
      );
      return new Response("EVENT_RECEIVED", { status: 200 });
    }

    const textoRecibido = message.text?.body || "";

    // ─── DEBOUNCE — AGRUPAR MENSAJES MÚLTIPLES ───────────────
    // Igual que Kairós: ventana de 8s para consolidar mensajes rápidos
    let miId = null;
    try {
      const insertResult = await env.DB.prepare(
        "INSERT INTO buffer_wa (negocio_id, numero, contenido, fecha, procesado) VALUES (?, ?, ?, ?, 0)"
      ).bind(negocioId, from, textoRecibido, new Date().toISOString()).run();
      miId = insertResult.meta?.last_row_id;
    } catch(e) {
      console.log("Error buffer:", e.message);
    }

    // Esperar ventana de silencio
    await new Promise(r => setTimeout(r, 8000));

    // Leer todos los mensajes pendientes de este número
    let mensajesBuffer = [];
    try {
      const bufferResult = await env.DB.prepare(
        "SELECT id, contenido FROM buffer_wa WHERE negocio_id = ? AND numero = ? AND procesado = 0 ORDER BY id ASC"
      ).bind(negocioId, from).all();
      mensajesBuffer = bufferResult.results || [];
    } catch(e) {
      mensajesBuffer = [{ id: miId, contenido: textoRecibido }];
    }

    if (mensajesBuffer.length === 0) {
      return new Response("EVENT_RECEIVED", { status: 200 });
    }

    // Lock: solo el primer mensaje (id más bajo) procesa el lote
    const primerIdPendiente = mensajesBuffer[0].id;
    if (miId && miId !== primerIdPendiente) {
      return new Response("EVENT_RECEIVED", { status: 200 });
    }

    // Consolidar y marcar como procesados
    const textoConsolidado = mensajesBuffer.map(m => m.contenido).join(" ");
    const idsBuffer        = mensajesBuffer.map(m => m.id);
    const msgId            = idsBuffer[idsBuffer.length - 1] || null;

    try {
      await env.DB.prepare(
        `UPDATE buffer_wa SET procesado = 1 WHERE id IN (${idsBuffer.join(",")})`
      ).run();
    } catch(e) { console.log("Error marcando buffer:", e.message); }

    // ─── CARGAR SERVICIOS DEL NEGOCIO ────────────────────────
    let servicios = [];
    try {
      const svcResult = await env.DB.prepare(
        "SELECT nombre, descripcion, precio, duracion FROM servicios WHERE negocio_id = ? AND activo = 1 ORDER BY orden ASC"
      ).bind(negocioId).all();
      servicios = svcResult.results || [];
    } catch(e) { console.log("Sin servicios:", e.message); }

    const catalogoTexto = servicios.map(s =>
      `• ${s.nombre} — $${s.precio} — ${s.duracion} min${s.descripcion ? ` — ${s.descripcion}` : ""}`
    ).join("\n");

    // ─── CARGAR HISTORIAL DE CONVERSACIÓN ────────────────────
    let historial = [];
    let nombrePaciente = nombrePerfil || null;
    try {
      const chatResult = await env.DB.prepare(
        `SELECT historial_json, cliente_nombre FROM chats
         WHERE negocio_id = ? AND cliente_tel = ?
         ORDER BY id DESC LIMIT 1`
      ).bind(negocioId, from).first();

      if (chatResult?.historial_json) {
        const parsed = JSON.parse(chatResult.historial_json);
        // Últimos 20 mensajes para no exceder contexto
        historial = parsed.slice(-20);
      }
      if (chatResult?.cliente_nombre && !nombrePaciente) {
        nombrePaciente = chatResult.cliente_nombre;
      }
    } catch(e) { console.log("Sin historial:", e.message); }

    const esPrimerMensaje = historial.length === 0;
    const textoLower      = textoConsolidado.toLowerCase();

    // ─── CONSTRUIR SYSTEM PROMPT ─────────────────────────────
    const modoReserva = negocio.modo_reserva || "solo_cita";
    const montoReserva = negocio.monto_reserva || 0;

    let instruccionPago = "";
    if (modoReserva === "solo_cita") {
      instruccionPago = "El pago se realiza directamente en la clínica. NO menciones pagos en línea.";
    } else if (modoReserva === "adelanto") {
      instruccionPago = `Para confirmar la cita se requiere un adelanto de $${montoReserva}. Cuando el paciente confirme que quiere reservar, dile: "Para confirmar tu cita necesito un pequeño adelanto de $${montoReserva}. Te envío el enlace de pago seguro ahora mismo." Luego indica que generarás el enlace. NO inventes el enlace — el sistema lo genera automáticamente.`;
    } else if (modoReserva === "pago_completo") {
      instruccionPago = `El pago completo del servicio se realiza al reservar. Cuando el paciente confirme, dile que le enviarás el enlace de pago seguro por el total del servicio. NO inventes el enlace — el sistema lo genera automáticamente.`;
    }

    const systemPrompt = `Eres la recepcionista virtual de ${negocio.nombre}, una clínica dental en Panamá. Tu nombre es ${negocio.nombre.split(" ")[0]} IA.

Tu misión: responder consultas, presentar servicios y convertir conversaciones en citas confirmadas.

CATÁLOGO DE SERVICIOS:
${catalogoTexto || "Consultar disponibilidad directamente."}

INFORMACIÓN CLAVE:
• Paciente: ${nombrePaciente || "No identificado aún"}
• Primer mensaje: ${esPrimerMensaje ? "SÍ — saluda calurosamente" : "NO"}
• WhatsApp de contacto: ${negocio.whatsapp_destino || "disponible en la clínica"}

FLUJO DE ATENCIÓN:
1. SALUDO — Preséntate, pregunta en qué puedes ayudar.
2. CONSULTA — Responde preguntas sobre servicios, precios, duración, disponibilidad.
3. RESERVA — Cuando el paciente quiera agendar: pide nombre completo, servicio deseado y fecha/hora preferida.
4. CONFIRMACIÓN — ${instruccionPago}

PREGUNTAS FRECUENTES:
• Precios → mostrar catálogo con precios exactos
• Duración → indicar duración del servicio
• Disponibilidad → decir que confirmarás con el equipo y que dejen su nombre y servicio
• Ubicación / horarios → decir que el equipo les contactará para confirmar detalles

REGLAS DE ORO:
• Máximo 4 líneas por mensaje. Máximo 2 emojis.
• Siempre terminar con una pregunta o acción concreta.
• Nunca inventar disponibilidad de fechas — siempre "confirmamos con el equipo".
• Si preguntan si eres IA: "Soy la asistente virtual de ${negocio.nombre}, aquí para ayudarte 24/7."
• Idioma: español panameño, tono cálido y profesional.
• NUNCA mencionar: Cloudflare, Groq, API, sistema, base de datos.`;

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
      || "Un momento, déjame verificar eso con el equipo. 😊";

    // ─── DETECTAR INTENCIÓN DE RESERVA Y GENERAR LINK PAGO ───
    // Si el modo requiere pago y Groq indica que se va a generar un enlace,
    // generamos el link de Páguelo Fácil y lo adjuntamos al mensaje
    const quiereReservar = [
      "quiero reservar", "quiero agendar", "me anoto", "apúntame",
      "reservar", "agendar", "confirmar cita", "apartar"
    ].some(s => textoLower.includes(s));

    if (quiereReservar && (modoReserva === "adelanto" || modoReserva === "pago_completo")) {
      try {
        // Detectar servicio mencionado en el mensaje
        const servicioDetectado = servicios.find(s =>
          textoLower.includes(s.nombre.toLowerCase())
        );

        if (servicioDetectado) {
          const monto = modoReserva === "adelanto" ? montoReserva : servicioDetectado.precio;

          // Generar link de pago via Páguelo Fácil (mismo endpoint que el chat web)
          const pagoRes = await fetch(`https://producto-c.pages.dev/api/pago/config`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              slug: negocio.slug,
              servicio: servicioDetectado.nombre,
              monto: monto,
              canal: "whatsapp",
              cliente_tel: from
            })
          });

          if (pagoRes.ok) {
            const pagoData = await pagoRes.json();
            if (pagoData.url) {
              respuesta += `\n\n💳 Enlace de pago seguro:\n${pagoData.url}`;
            }
          }
        }
      } catch(e) {
        console.log("Error generando link pago:", e.message);
      }
    }

    // ─── GUARDAR/ACTUALIZAR HISTORIAL EN chats ────────────────
    try {
      const nuevoHistorial = [
        ...historial,
        { role: "user",      content: textoConsolidado },
        { role: "assistant", content: respuesta }
      ];

      // Buscar chat existente de esta sesión (mismo número, mismo negocio, hoy)
      const chatExistente = await env.DB.prepare(
        `SELECT id FROM chats WHERE negocio_id = ? AND cliente_tel = ? AND completado = 0 LIMIT 1`
      ).bind(negocioId, from).first();

      if (chatExistente) {
        await env.DB.prepare(
          `UPDATE chats SET historial_json = ?, cliente_nombre = ?, fecha = ? WHERE id = ?`
        ).bind(
          JSON.stringify(nuevoHistorial),
          nombrePaciente || "Paciente WA",
          new Date().toISOString(),
          chatExistente.id
        ).run();
      } else {
        await env.DB.prepare(
          `INSERT INTO chats (negocio_id, session_token, cliente_nombre, cliente_tel, historial_json, fecha, completado, canal)
           VALUES (?, ?, ?, ?, ?, ?, 0, 'whatsapp')`
        ).bind(
          negocioId,
          `wa_${from}_${Date.now()}`,
          nombrePaciente || "Paciente WA",
          from,
          JSON.stringify(nuevoHistorial),
          new Date().toISOString()
        ).run();
      }
    } catch(e) { console.log("Error guardando chat:", e.message); }

    // ─── DELAY HUMANO ─────────────────────────────────────────
    await marcarLeido(waToken, phoneNumberId, msgId);
    const palabras = respuesta.split(" ").length;
    const delayMs  = Math.min(Math.max(palabras * 80, 1500), 5000);
    await new Promise(r => setTimeout(r, delayMs));

    // ─── ENVIAR RESPUESTA ─────────────────────────────────────
    await enviarMensaje(waToken, phoneNumberId, from, respuesta);

    // ─── NOTIFICAR TELEGRAM AL DUEÑO ─────────────────────────
    if (negocio.telegram_chat_id) {
      try {
        await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: negocio.telegram_chat_id,
            text: `📱 <b>WhatsApp — ${negocio.nombre}</b>\n\nPaciente: +${from}${nombrePaciente ? ` (${nombrePaciente})` : ""}\n💬 "${textoConsolidado}"\n🤖 "${respuesta.substring(0, 200)}${respuesta.length > 200 ? "..." : ""}"`,
            parse_mode: "HTML"
          })
        });
      } catch(e) { console.log("Error Telegram:", e.message); }
    }

    return new Response("EVENT_RECEIVED", { status: 200 });

  } catch (error) {
    console.error("Error webhook.js:", error.message);
    return new Response("EVENT_RECEIVED", { status: 200 });
  }
}

// ─── MARCAR MENSAJE COMO LEÍDO (doble check azul) ───────────────
async function marcarLeido(waToken, phoneNumberId, messageId) {
  if (!messageId) return;
  try {
    await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${waToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId
      })
    });
  } catch(e) { console.log("Error marcarLeido:", e.message); }
}

// ─── ENVIAR MENSAJE A WHATSAPP ────────────────────────────────────
async function enviarMensaje(waToken, phoneNumberId, to, texto) {
  try {
    const res = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${waToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: texto }
      })
    });
    const result = await res.json();
    console.log("Meta response:", JSON.stringify(result));
    return result;
  } catch(e) {
    console.log("Error enviarMensaje:", e.message);
  }
}
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

    // ─── DEBOUNCE 8 SEGUNDOS ─────────────────────────────────
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
        "SELECT id, nombre, descripcion, precio, duracion FROM servicios WHERE negocio_id = ? AND activo = 1 ORDER BY orden ASC"
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

    // ─── DETECTAR DATOS DE RESERVA EN EL HISTORIAL ───────────
    // Extraemos nombre, servicio y fecha si ya fueron mencionados
    const historialTexto = historial.map(h => h.content).join(" ").toLowerCase();

    const servicioDetectado = servicios.find(s =>
      textoLower.includes(s.nombre.toLowerCase()) ||
      historialTexto.includes(s.nombre.toLowerCase())
    );

    // Detectar si el paciente quiere confirmar la reserva
    const palabrasConfirmacion = [
      "confirmo", "confirmar", "sí quiero", "si quiero", "me anoto",
      "apúntame", "apuntame", "quiero reservar", "quiero agendar",
      "reservar", "agendar", "apartar", "hagámoslo", "hagamoslo",
      "listo", "dale", "perfecto", "acepto", "de acuerdo"
    ];
    const quiereConfirmar = palabrasConfirmacion.some(p => textoLower.includes(p));

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

FLUJO DE RESERVA (sigue este orden exacto):
1. Saluda y pregunta en qué puedes ayudar.
2. Presenta servicios con precios cuando pregunten.
3. Cuando quieran agendar: pide nombre completo, servicio y fecha/hora preferida.
4. Cuando tengas los 3 datos confirmados: ${instruccionPago}

REGLAS:
• Máximo 4 líneas por mensaje. Máximo 2 emojis.
• Termina siempre con una pregunta o acción.
• Nunca inventes disponibilidad — "verificamos con el equipo".
• Si preguntan si eres IA: "Soy la asistente virtual de ${negocio.nombre}, disponible 24/7."
• Idioma: español panameño, cálido y profesional.
• NUNCA mencionar: Cloudflare, Groq, API, base de datos.
• NO expliques ni muestres las etiquetas [CREAR_CITA] o [GENERAR_PAGO] al paciente.`;

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

      // Crear cita en estado "esperando_pago"
      try {
        const citaRes = await env.producto_c_db.prepare(
          `INSERT INTO citas (negocio_id, servicio_id, cliente_nombre, cliente_tel,
           fecha_cita, total, estado_pago, metodo_pago, session_token, canal)
           VALUES (?, ?, ?, ?, ?, ?, 'esperando_pago', 'paguelofacil', ?, 'whatsapp')`
        ).bind(
          negocioId,
          svcEncontrado?.id || null,
          datosGenerar.nombre || nombrePaciente || "Paciente WA",
          from,
          datosGenerar.fecha || "Por confirmar",
          montoFinal,
          sessionToken
        ).run();
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
    }

    // ─── GUARDAR HISTORIAL ────────────────────────────────────
    try {
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
    } catch(e) { console.log("Error guardando chat:", e.message); }

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
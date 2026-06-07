// ============================================================
// functions/api/chat.js
// POST /api/chat
// Motor de IA conversacional con Groq LLaMA 3.3-70b
// Guarda historial en D1 tabla chats
// ============================================================

const GROQ_API = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL    = 'llama-3.3-70b-versatile';

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: 'JSON inválido' }, { status: 400, headers: corsHeaders });
  }

  const { slug, mensaje, sessionToken, historial = [] } = body;

  if (!slug || !mensaje) {
    return Response.json({ success: false, error: 'slug y mensaje requeridos' }, { status: 400, headers: corsHeaders });
  }

  try {
    // 1. Cargar negocio y servicios desde D1
    const negocio = await env.producto_c_db
      .prepare('SELECT * FROM negocios WHERE slug = ? AND activo = 1 LIMIT 1')
      .bind(slug)
      .first();

    if (!negocio) {
      return Response.json({ success: false, error: 'Negocio no encontrado' }, { status: 404, headers: corsHeaders });
    }

    const { results: servicios } = await env.producto_c_db
      .prepare('SELECT * FROM servicios WHERE negocio_id = ? AND activo = 1 ORDER BY orden ASC')
      .bind(negocio.id)
      .all();

    // 2. Construir system prompt con contexto del negocio
    const listaServicios = servicios.map(s =>
      `- ${s.nombre}: $${s.precio} USD (${s.duracion || 'consultar'})`
    ).join('\n');

    // Instrucción de pago según modo de reserva
    const modoReserva   = negocio.modo_reserva   || 'adelanto';
    const montoReserva  = negocio.monto_reserva  || 5;

    const instruccionPago =
      modoReserva === 'solo_cita'
        ? `POLÍTICA DE PAGO: Este negocio NO requiere pago anticipado. El cliente agenda su cita gratis y paga el servicio completo directamente en el negocio el día de la cita.`
      : modoReserva === 'adelanto'
        ? `POLÍTICA DE PAGO: Para reservar una cita se requiere un adelanto de $${montoReserva} USD. El cliente paga ese adelanto en línea ahora y el saldo restante lo paga en el negocio el día de la cita.`
      : `POLÍTICA DE PAGO: Este negocio requiere pago completo al momento de reservar. El cliente paga el total del servicio en línea para confirmar su cita.`;

    const systemPrompt = `Eres el asistente virtual de "${negocio.nombre}".
Tu trabajo es ayudar a los clientes a conocer los servicios disponibles, responder preguntas y agendar citas.

SERVICIOS DISPONIBLES:
${listaServicios || 'No hay servicios cargados aún.'}

${instruccionPago}

INSTRUCCIONES:
- Responde siempre en español, de forma amable y profesional.
- Sé breve (máximo 3 oraciones por respuesta).
- Si el cliente quiere agendar, confirma el servicio y la fecha.
- Si preguntan por precio, menciona el costo exacto del servicio.
- Si preguntan si tienen que pagar algo ahora, explica la política de pago claramente.
- Si no puedes ayudar con algo, sugiere llamar al negocio por WhatsApp.
- NUNCA inventes servicios ni precios que no estén en la lista.
- NUNCA menciones que eres una IA de Groq o cualquier proveedor externo.
- Cuando el cliente confirme un servicio, termina tu respuesta con: [MOSTRAR_RESUMEN]

NEGOCIO: ${negocio.nombre}
WHATSAPP: ${negocio.whatsapp_destino || 'No disponible'}`;

    // 3. Construir historial para Groq
    const mensajesGroq = [
      { role: 'system', content: systemPrompt },
      ...historial.slice(-6).map(m => ({
        role:    m.role === 'bot' ? 'assistant' : 'user',
        content: m.text,
      })),
      { role: 'user', content: mensaje },
    ];

    // 4. Llamar a Groq
    const groqRes = await fetch(GROQ_API, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.GROQ_API_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        model:       MODEL,
        messages:    mensajesGroq,
        max_tokens:  256,
        temperature: 0.6,
      }),
    });

    if (!groqRes.ok) {
      const err = await groqRes.text();
      throw new Error(`Groq error: ${err}`);
    }

    const groqData  = await groqRes.json();
    let respuesta   = groqData.choices?.[0]?.message?.content?.trim() || 'Disculpa, no pude procesar tu mensaje.';

    // 5. Detectar si hay que mostrar resumen
    let mostrarResumen = false;
    let servicioResumen = null;

    if (respuesta.includes('[MOSTRAR_RESUMEN]')) {
      respuesta = respuesta.replace('[MOSTRAR_RESUMEN]', '').trim();
      mostrarResumen = true;
      // Detectar cuál servicio eligió el cliente
      const msgLower = mensaje.toLowerCase();
      servicioResumen = servicios.find(s => msgLower.includes(s.nombre.toLowerCase())) || null;
    }

    // 6. Detectar si hay que mostrar carrusel
    const mostrarServicios = /servicio|agendar|cita|opciones|disponible/i.test(mensaje)
      && !mostrarResumen;

    // 7. Guardar en D1 tabla chats
    if (sessionToken) {
      try {
        const existente = await env.producto_c_db
          .prepare('SELECT id, historial_json FROM chats WHERE session_token = ? AND negocio_id = ? LIMIT 1')
          .bind(sessionToken, negocio.id)
          .first();

        const nuevoHistorial = [
          ...(existente ? JSON.parse(existente.historial_json || '[]') : []),
          { role: 'user', text: mensaje, ts: Date.now() },
          { role: 'bot',  text: respuesta, ts: Date.now() },
        ].slice(-20);

        if (existente) {
          await env.producto_c_db
            .prepare('UPDATE chats SET historial_json = ?, fecha = ? WHERE id = ?')
            .bind(JSON.stringify(nuevoHistorial), new Date().toISOString(), existente.id)
            .run();
        } else {
          await env.producto_c_db
            .prepare(`INSERT INTO chats (negocio_id, session_token, historial_json, fecha, completado)
                      VALUES (?, ?, ?, ?, 0)`)
            .bind(negocio.id, sessionToken, JSON.stringify(nuevoHistorial), new Date().toISOString())
            .run();
        }
      } catch (dbErr) {
        // No bloquear la respuesta si falla el guardado
        console.error('DB chat error:', dbErr.message);
      }
    }

    // 8. Responder al frontend
    return Response.json({
      success:         true,
      respuesta,
      mostrar_servicios: mostrarServicios,
      mostrar_resumen:   mostrarResumen,
      servicio:          servicioResumen ? {
        id:      servicioResumen.id,
        nombre:  servicioResumen.nombre,
        precio:  servicioResumen.precio,
        duracion:servicioResumen.duracion,
      } : null,
      servicios: mostrarServicios ? servicios.map(s => ({
        id: s.id, nombre: s.nombre, precio: s.precio,
        icono: s.icono, imagen_url: s.imagen_url, duracion: s.duracion,
      })) : [],
    }, { headers: corsHeaders });

  } catch (err) {
    return Response.json(
      { success: false, error: 'Error interno', detail: err.message },
      { status: 500, headers: corsHeaders }
    );
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: corsHeaders });
}
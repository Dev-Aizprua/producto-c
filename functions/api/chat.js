// ============================================================
// functions/api/chat.js  — Valeria Web v2
// POST /api/chat
// Actualizado para igualar el nivel del webhook de WhatsApp:
// - Modelo openai/gpt-oss-120b (igual que WA)
// - Temperature 0.3 (menos alucinaciones)
// - Personalidad Valeria completa
// - Catálogo estricto + sin equivalencias
// - Motor de Fechas (resolverFechaNatural desde fechas.js)
// - Agenda Real (verificarDisponibilidad desde agenda.js)
// - Filtro post-Groq 20 patrones con niveles
// - Protección de duplicados por sessionToken
// ============================================================

import { resolverFechaNatural } from './fechas.js';
import { verificarDisponibilidad } from './agenda.js';

const GROQ_API = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL    = 'openai/gpt-oss-120b';

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

// ─── FILTRO POST-GROQ (mismo que WhatsApp) ────────────────────────────────
// Si Groq inventa algo peligroso, se reemplaza antes de enviarlo al paciente.
const FILTROS_ALUCINACION = [
  // NIVEL CRÍTICO
  {
    nivel: "CRÍTICO",
    patron: /parece (que tiene|una|un|ser)|probablemente (tiene|es|necesita)|seguramente (tiene|necesita)|caries|gingivitis|periodontitis|absceso|infecci[oó]n.{0,20}(dental|muela)|necesita.{0,20}(extracci[oó]n|endodoncia)/i,
    reemplazo: "Para evaluar cualquier situación dental, lo mejor es agendar una cita con nuestro equipo. ¿Te gustaría que revisemos horarios disponibles? 😊"
  },
  {
    nivel: "CRÍTICO",
    patron: /le recomiendo (tomar|usar|medicarse)|debe (tomar|medicarse).{0,30}(pastilla|antibiótico|ibuprofeno|acetaminof[eé]n|analgésico)|necesita antibiótico/i,
    reemplazo: "Para consultas sobre medicación, te recomiendo comunicarte directamente con nuestro equipo. 😊"
  },
  {
    nivel: "CRÍTICO",
    patron: /resultado.{0,30}(garantizado|permanente|100%)|garant(ía|izamos).{0,40}(result|éxito)|quedar[aá].{0,30}completamente.{0,30}(curado|bien)|100% efectivo/i,
    reemplazo: "Los resultados dependen de la evaluación del equipo dental. Con gusto te orientan en la cita. 😊"
  },
  {
    nivel: "CRÍTICO",
    patron: /no (es|parece) (grave|serio|peligroso)|no debe preocuparse|es algo normal|no necesita tratamiento/i,
    reemplazo: "Para cualquier situación dental, lo más recomendable es que nuestro equipo la evalúe. ¿Deseas agendar? 😊"
  },
  // NIVEL ALTO
  {
    nivel: "ALTO",
    patron: /pag(o|ar|amos).{0,40}(partes|parcial|cuotas|plazos|meses|abono)|financiam/i,
    reemplazo: "No tengo información sobre opciones de financiamiento. Un miembro del equipo puede orientarte. 😊"
  },
  {
    nivel: "ALTO",
    patron: /descuento|rebaja|te (puedo|podemos) (dar|hacer|ofrecer).{0,30}(descuento|rebaja)/i,
    reemplazo: "No tengo información sobre descuentos activos. Un miembro del equipo puede confirmarte. 😊"
  },
  {
    nivel: "ALTO",
    patron: /promoci[oó]n.{0,30}(este mes|esta semana|especial|nuevos pacientes)|oferta especial|en descuento esta (semana|mes)/i,
    reemplazo: "No tengo información sobre promociones activas. Un miembro del equipo puede confirmarte. 😊"
  },
  {
    nivel: "ALTO",
    patron: /garant[ií]a.{0,30}(incluye|cubre|ofrecemos)|incluye.{0,30}garant[ií]a/i,
    reemplazo: "No tengo información sobre garantías. Te recomiendo consultar con nuestro equipo. 😊"
  },
  {
    nivel: "ALTO",
    patron: /puede cancelar (sin costo|gratis|sin penalización)|puede reprogramar ilimitadamente/i,
    reemplazo: "Para consultas sobre cancelaciones, un miembro del equipo puede orientarte. 😊"
  },
  // NIVEL MEDIO
  {
    nivel: "MEDIO",
    patron: /incluye.{0,60}(kit dental|cepillo gratis|radiograf[ií]a gratis|evaluaci[oó]n gratuita|diagn[oó]stico gratis)/i,
    reemplazo: "Para detalles sobre qué incluye el tratamiento, un miembro del equipo puede orientarte. 😊"
  },
  {
    nivel: "MEDIO",
    patron: /abrimos (hasta|desde).{0,20}las \d|trabajamos (domingos|feriados)|atendemos 24 horas/i,
    reemplazo: "Para confirmar nuestros horarios exactos, un miembro del equipo puede orientarte. 😊"
  },
  {
    nivel: "MEDIO",
    patron: /aceptamos.{0,30}(yappy|paypal|bitcoin|criptomoneda|zelle)|pagos? con.{0,20}(yappy|paypal|bitcoin)/i,
    reemplazo: "Para consultar los métodos de pago disponibles, un miembro del equipo puede confirmarte. 😊"
  },
  {
    nivel: "MEDIO",
    patron: /tenemos.{0,30}(ortodoncista|cirujano|periodoncista|especialista en)|contamos con.{0,30}especialista/i,
    reemplazo: "Para información sobre nuestro equipo, un miembro puede orientarte directamente. 😊"
  },
  {
    nivel: "MEDIO",
    patron: /tenemos.{0,30}(otra clínica|otra sede|dos sedes)|puede visitarnos en.{0,30}(calle|avenida|local)/i,
    reemplazo: "Para información sobre ubicaciones, un miembro del equipo puede orientarte. 😊"
  },
  {
    nivel: "MEDIO",
    patron: /seguro.{0,30}(cubre|aplica|acepta)|acepta(mos)?.{0,20}(seguro|póliza)/i,
    reemplazo: "No tengo información sobre coberturas de seguro. Un miembro del equipo puede orientarte. 😊"
  }
];

function aplicarFiltroPostGroq(respuesta) {
  for (const filtro of FILTROS_ALUCINACION) {
    if (filtro.patron.test(respuesta)) {
      console.log(`[FILTRO_WEB] Nivel ${filtro.nivel} activado`);
      return { respuesta: filtro.reemplazo, filtroActivado: true, nivel: filtro.nivel };
    }
  }
  return { respuesta, filtroActivado: false, nivel: null };
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try { body = await request.json(); }
  catch { return Response.json({ success: false, error: 'JSON inválido' }, { status: 400, headers: corsHeaders }); }

  const { slug, mensaje, sessionToken, historial = [] } = body;
  if (!slug || !mensaje) {
    return Response.json({ success: false, error: 'slug y mensaje requeridos' }, { status: 400, headers: corsHeaders });
  }

  try {
    // 1. Cargar negocio y servicios
    const negocio = await env.producto_c_db
      .prepare('SELECT * FROM negocios WHERE slug = ? AND activo = 1 LIMIT 1')
      .bind(slug).first();
    if (!negocio) return Response.json({ success: false, error: 'Negocio no encontrado' }, { status: 404, headers: corsHeaders });

    const { results: servicios } = await env.producto_c_db
      .prepare('SELECT * FROM servicios WHERE negocio_id = ? AND activo = 1 ORDER BY orden ASC')
      .bind(negocio.id).all();

    // 2. Motor de Fechas — resolver fecha del mensaje antes de Groq
    const fechaResuelta = resolverFechaNatural(mensaje);

    // 3. Protección de duplicados — verificar si ya tiene cita activa
    let citaActivaWeb = null;
    if (sessionToken) {
      try {
        citaActivaWeb = await env.producto_c_db.prepare(
          `SELECT id, estado_pago FROM citas WHERE negocio_id = ? AND session_token = ?
           AND estado_pago IN ('esperando_pago','pago_por_verificar','confirmada')
           ORDER BY id DESC LIMIT 1`
        ).bind(negocio.id, sessionToken).first();
      } catch(e) {}
    }

    // 4. System prompt — nivel Valeria completo
    const listaServicios = servicios.map(s =>
      `- ${s.nombre}: $${s.precio} USD | ${s.duracion || 'consultar'} | ${s.descripcion || ''}`
    ).join('\n');

    const modoReserva  = negocio.modo_reserva  || 'adelanto';
    const montoReserva = negocio.monto_reserva || 5;
    const instruccionPago =
      modoReserva === 'solo_cita'
        ? `POLÍTICA DE PAGO: No se requiere pago anticipado. El cliente agenda gratis y paga en el negocio el día de la cita.`
      : modoReserva === 'adelanto'
        ? `POLÍTICA DE PAGO: Se requiere adelanto de $${montoReserva} USD para reservar. El saldo se paga en el negocio.`
        : `POLÍTICA DE PAGO: Se requiere pago completo al reservar.`;

    const fechaContexto = fechaResuelta
      ? `FECHA DETECTADA EN EL MENSAJE: ${fechaResuelta.texto} (${fechaResuelta.fecha}${fechaResuelta.hora ? ` a las ${fechaResuelta.hora}` : ''}) — usa esta fecha exacta en tu respuesta, no calcules fechas tú mismo.`
      : `Si el paciente menciona una fecha o día, inclúyela en tu respuesta tal como él la dijo.`;

    const systemPrompt = `Eres Valeria, la secretaria virtual premium de "${negocio.nombre}". Atiendes el chat de la clínica dental con un tono cálido, profesional y panameño. Eres eficiente y amable — una sola pregunta a la vez.

CATÁLOGO DE SERVICIOS (ÚNICA FUENTE DE VERDAD):
${listaServicios || 'No hay servicios cargados.'}

${instruccionPago}

${fechaContexto}

━━━ CATÁLOGO — REGLAS DE USO ESTRICTO ━━━
REGLA 1 — SOLO LO QUE ESTÁ ESCRITO:
Al describir un servicio, usa ÚNICAMENTE el precio y descripción del catálogo. NUNCA agregues beneficios, resultados, garantías, duraciones de efectos ni detalles clínicos que no estén escritos.

REGLA 2 — SIN EQUIVALENCIAS NI MARCAS:
Si el paciente pregunta por un tratamiento que NO aparece EXACTAMENTE en el catálogo, responde:
"No tenemos ese tratamiento registrado en nuestro catálogo actual. ¿Te puedo ayudar con alguno de nuestros servicios disponibles? 😊"
Ejemplos: Invisalign ≠ Ortodoncia. Blanqueamiento láser ≠ Blanqueamiento. Corona ≠ Implante.

━━━ REGLA DE HIERRO — LO QUE VALERIA NO SABE ━━━
- NO conoces: financiamiento, pagos parciales, descuentos, promociones, garantías, seguros, horarios exactos, métodos de pago adicionales, especialistas por nombre, otras sedes.
- Si preguntan por algo que no está en el catálogo → "No tengo esa información registrada. Un miembro del equipo puede orientarte directamente. 😊"
- NUNCA inventes diagnósticos, síntomas, ni recomendaciones clínicas — eso lo hace el dentista.
- NUNCA confirmes disponibilidad antes de que el sistema la verifique.

━━━ FLUJO DE AGENDAMIENTO ━━━
1. Entiende qué servicio le interesa
2. Si no tienes el nombre del paciente, pídelo
3. Confirma fecha y hora con la fecha ya resuelta por el sistema
4. Muestra resumen y pregunta ¿Confirmas la cita? — termina con [MOSTRAR_RESUMEN]
5. SOLO cuando confirme → termina con [CREAR_CITA]

━━━ REGLAS DE COMUNICACIÓN ━━━
- Máximo 3 oraciones por respuesta
- Una sola pregunta a la vez
- Usa solo el primer nombre del paciente
- Nunca menciones que eres IA de Groq o cualquier proveedor externo
- Nunca hagas diagnósticos ni recomendaciones médicas

NEGOCIO: ${negocio.nombre}
WHATSAPP: ${negocio.whatsapp_destino || 'Consultar'}`;

    // 5. Construir mensajes para Groq
    const mensajesGroq = [
      { role: 'system', content: systemPrompt },
      ...historial.slice(-8).map(m => ({
        role: m.role === 'bot' ? 'assistant' : 'user',
        content: m.text,
      })),
      { role: 'user', content: mensaje },
    ];

    // 6. Llamar a Groq
    const groqRes = await fetch(GROQ_API, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, messages: mensajesGroq, max_tokens: 300, temperature: 0.3 }),
    });

    if (!groqRes.ok) throw new Error(`Groq error: ${await groqRes.text()}`);
    const groqData = await groqRes.json();
    let respuesta  = groqData.choices?.[0]?.message?.content?.trim() || 'Disculpa, no pude procesar tu mensaje.';

    // 7. Filtro post-Groq (mismo que WhatsApp)
    const filtroResult = aplicarFiltroPostGroq(respuesta);
    respuesta = filtroResult.respuesta;

    // 8. Detectar etiquetas de acción
    let mostrarResumen = false;
    let crearCita      = false;
    let servicioResumen = null;

    // Buscar el servicio en el mensaje actual Y en el historial reciente
    // Cuando el paciente dice "si confirmo", el servicio está en mensajes anteriores
    function detectarServicioEnContexto() {
      const textos = [
        mensaje,
        ...historial.slice(-6).map(m => m.text || '')
      ].join(' ').toLowerCase();
      return servicios.find(s => textos.includes(s.nombre.toLowerCase())) || null;
    }

    // Extraer fecha del historial — igual que en WhatsApp
    // Cuando el paciente confirma, la fecha está en un mensaje anterior de Valeria
    function extraerFechaDeHistorial() {
      const mensajesBot = historial.filter(m => m.role === 'bot').slice(-3);
      for (const msg of mensajesBot.reverse()) {
        const texto = msg.text || '';
        const match = texto.match(
          /(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\s+\d{1,2}\s+de\s+\w+\s+(?:de\s+\d{4}\s+)?a\s+las\s+[\d:]+\s*(?:AM|PM|am|pm)?/i
        );
        if (match) return resolverFechaNatural(match[0]);
      }
      return null;
    }

    if (respuesta.includes('[MOSTRAR_RESUMEN]')) {
      respuesta = respuesta.replace('[MOSTRAR_RESUMEN]', '').trim();
      mostrarResumen = true;
      servicioResumen = detectarServicioEnContexto();
    }

    if (respuesta.includes('[CREAR_CITA]')) {
      respuesta = respuesta.replace('[CREAR_CITA]', '').trim();
      crearCita = true;
      // Asegurar que tenemos servicio aunque Groq no lo repita en este mensaje
      if (!servicioResumen) servicioResumen = detectarServicioEnContexto();
      // Si Groq devolvió SOLO la etiqueta, dar respuesta de confirmación por defecto
      if (!respuesta) {
        const nombreSvc = servicioResumen?.nombre || 'tu cita';
        respuesta = `¡Listo! Tu cita de ${nombreSvc} ha sido registrada. En breve recibirás la confirmación. 😊`;
      }
    }

    // Si después del filtro y etiquetas la respuesta quedó vacía, dar fallback amigable
    if (!respuesta) respuesta = 'Entendido. ¿Te puedo ayudar con algo más? 😊';

    // Complementar fecha resuelta con la del historial si el mensaje actual no tiene fecha
    const fechaFinal = fechaResuelta || (crearCita || mostrarResumen ? extraerFechaDeHistorial() : null);

    // 9. Agenda Real — verificar disponibilidad si hay fecha y servicio
    let disponibilidadInfo = null;
    if (fechaFinal?.fecha && fechaFinal?.hora && servicioResumen) {
      const duracion = parseInt(servicioResumen.duracion) || 30;
      try {
        disponibilidadInfo = await verificarDisponibilidad(env, negocio.id, fechaFinal.fecha, fechaFinal.hora, duracion);
        if (!disponibilidadInfo.disponible) {
          const motivo = (disponibilidadInfo.motivo || "").toLowerCase();
          respuesta = motivo.includes("no hay atenci") || motivo.includes("ese d")
            ? `Lo siento, ese día no tenemos atención. Nuestro horario es lunes a viernes. ¿Te gustaría otro día? 😊`
            : `Lo siento, esa hora ya está reservada. ¿Puedes proponer otro horario? 😊`;
          mostrarResumen = false;
          crearCita = false;
        }
      } catch(e) { console.log('Agenda Real error:', e.message); }
    }

    // 10. Crear cita si se confirmó y pasa todas las validaciones
    let citaCreada = null;
    if (crearCita && sessionToken && !citaActivaWeb && fechaFinal?.fecha && servicioResumen) {
      try {
        const duracion = parseInt(servicioResumen.duracion) || 30;
        const disponible = await verificarDisponibilidad(env, negocio.id, fechaFinal.fecha, fechaFinal.hora || '09:00', duracion);
        if (disponible.disponible) {
          const estadoCita = modoReserva === 'solo_cita' ? 'confirmada' : 'esperando_pago';
          await env.producto_c_db.prepare(
            `INSERT INTO citas (negocio_id, servicio_id, cliente_nombre, cliente_tel,
             fecha_cita, fecha_hora, total, estado_pago, metodo_pago, session_token, canal)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'web', ?, 'web')`
          ).bind(
            negocio.id, servicioResumen.id, 'Paciente Web', sessionToken,
            fechaFinal.fecha, fechaFinal.hora || null,
            servicioResumen.precio, estadoCita, sessionToken
          ).run();
          citaCreada = { servicio: servicioResumen.nombre, fecha: fechaFinal.texto };
        }
      } catch(e) { console.log('Error creando cita web:', e.message); }
    }

    // 11. Detectar carrusel
    const mostrarServicios = /servicio|agendar|cita|opciones|disponible|tratamiento/i.test(mensaje) && !mostrarResumen;

    // 12. Guardar historial en D1
    if (sessionToken) {
      try {
        const existente = await env.producto_c_db
          .prepare('SELECT id, historial_json FROM chats WHERE session_token = ? AND negocio_id = ? AND completado = 0 LIMIT 1')
          .bind(sessionToken, negocio.id).first();

        const nuevoHistorial = [
          ...(existente ? JSON.parse(existente.historial_json || '[]') : []),
          { role: 'user', text: mensaje, ts: Date.now() },
          { role: 'bot',  text: respuesta, ts: Date.now() },
        ].slice(-20);

        if (existente) {
          await env.producto_c_db
            .prepare('UPDATE chats SET historial_json = ?, fecha = ? WHERE id = ?')
            .bind(JSON.stringify(nuevoHistorial), new Date().toISOString(), existente.id).run();
        } else {
          await env.producto_c_db
            .prepare(`INSERT INTO chats (negocio_id, session_token, cliente_nombre, cliente_tel, historial_json, fecha, completado, canal)
                      VALUES (?, ?, 'Paciente Web', ?, ?, ?, 0, 'web')`)
            .bind(negocio.id, sessionToken, sessionToken, JSON.stringify(nuevoHistorial), new Date().toISOString()).run();
        }
      } catch(e) { console.error('DB chat error:', e.message); }
    }

    // 13. Responder
    return Response.json({
      success: true,
      respuesta,
      mostrar_servicios: mostrarServicios,
      mostrar_resumen:   mostrarResumen,
      cita_creada:       citaCreada,
      filtro_activado:   filtroResult.filtroActivado,
      servicio: servicioResumen ? {
        id: servicioResumen.id, nombre: servicioResumen.nombre,
        precio: servicioResumen.precio, duracion: servicioResumen.duracion,
      } : null,
      fecha_resuelta: fechaFinal ? {
        fecha: fechaFinal.fecha, hora: fechaFinal.hora, texto: fechaFinal.texto
      } : null,
      servicios: mostrarServicios ? servicios.map(s => ({
        id: s.id, nombre: s.nombre, precio: s.precio,
        icono: s.icono, imagen_url: s.imagen_url, duracion: s.duracion,
      })) : [],
    }, { headers: corsHeaders });

  } catch(err) {
    return Response.json({ success: false, error: 'Error interno', detail: err.message }, { status: 500, headers: corsHeaders });
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: corsHeaders });
}
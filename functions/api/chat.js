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

// Motor de Fechas inline — evita problema de imports entre CF Pages Functions
// Versión simplificada de fechas.js suficiente para el chat web
function resolverFechaNatural(texto) {
  if (!texto) return null;
  try {
  const lower = texto.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();

  // Panama = UTC-5 fijo, sin horario de verano
  // Más simple y confiable que Intl.DateTimeFormat en CF Workers
  const ahoraUTC = new Date();
  const base = new Date(ahoraUTC.getTime() - (5 * 60 * 60 * 1000));

  const DIAS = { domingo:0, lunes:1, martes:2, miercoles:3, jueves:4, viernes:5, sabado:6 };
  const NOMBRES_DIAS = ["domingo","lunes","martes","miércoles","jueves","viernes","sábado"];
  const MESES = { enero:0,febrero:1,marzo:2,abril:3,mayo:4,junio:5,julio:6,agosto:7,septiembre:8,octubre:9,noviembre:10,diciembre:11 };
  const NOMBRES_MESES = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];

  function extraerHora(t) {
    const l = t.toLowerCase();
    const mT = l.match(/(\d{1,2})(?::(\d{2}))?\s*(?:de la tarde|de la noche|p\.?\s*m\.?)/);
    if (mT) { let h=parseInt(mT[1]); if(h<12)h+=12; return `${String(h).padStart(2,"0")}:${mT[2]||"00"}`; }
    const mM = l.match(/(\d{1,2})(?::(\d{2}))?\s*(?:de la ma[nñ]ana|a\.?\s*m\.?)/);
    if (mM) { let h=parseInt(mM[1]); if(h===12)h=0; return `${String(h).padStart(2,"0")}:${mM[2]||"00"}`; }
    if (l.includes("mediodia")||l.includes("mediod")) return "12:00";
    const mYM = l.match(/(\d{1,2})\s*y\s*media/);
    if (mYM) { let h=parseInt(mYM[1]); if(/tarde|noche/.test(l)&&h<12)h+=12; else if(h<=7)h+=12; return `${String(h).padStart(2,"0")}:30`; }
    const mHM = l.match(/(\d{1,2}):(\d{2})/);
    if (mHM) return `${String(parseInt(mHM[1])).padStart(2,"0")}:${mHM[2]}`;
    const mHS = l.match(/a las (\d{1,2})(?:\s|$)/);
    if (mHS) { const h=parseInt(mHS[1]); return `${String(h<=7?h+12:h).padStart(2,"0")}:00`; }
    return null;
  }

  function construir(fecha, hora) {
    const y=fecha.getFullYear(), m=fecha.getMonth(), d=fecha.getDate();
    const iso=`${y}-${String(m+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
    return { fecha:iso, dia:NOMBRES_DIAS[fecha.getDay()], hora, texto: hora ? `${NOMBRES_DIAS[fecha.getDay()]} ${d} de ${NOMBRES_MESES[m]} de ${y} a las ${hora}` : `${NOMBRES_DIAS[fecha.getDay()]} ${d} de ${NOMBRES_MESES[m]} de ${y}` };
  }

  // Día de semana (prioridad alta)
  for (const [nombre, num] of Object.entries(DIAS)) {
    if (new RegExp(`\\b${nombre}\\b`).test(lower)) {
      const r = new Date(base); let diff = num - base.getDay();
      if (/proximo|que viene/.test(lower)) { if(diff<=0)diff+=7; else diff+=7; }
      else { if(diff<0)diff+=7; }
      r.setDate(r.getDate()+diff);
      return construir(r, extraerHora(texto));
    }
  }

  // Mañana
  if (/\bmanana\b/.test(lower) && !/de la manana/.test(lower)) {
    const r=new Date(base); r.setDate(r.getDate()+1); return construir(r, extraerHora(texto));
  }
  // Hoy
  if (lower==="hoy" || /^hoy\b/.test(lower)) return construir(base, extraerHora(texto));

  // Fecha con mes escrito
  const tieneDia = Object.keys(DIAS).some(d=>new RegExp(`\\b${d}\\b`).test(lower));
  if (!tieneDia) {
    for (const [nombreMes, numMes] of Object.entries(MESES)) {
      if (lower.includes(nombreMes)) {
        const mn = texto.match(/(\d{1,2})\s*(?:de\s*)?(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)/i);
        if (mn) {
          const dia=parseInt(mn[1]), anio=base.getFullYear();
          const fc=new Date(anio,numMes,dia);
          if(fc<base)fc.setFullYear(anio+1);
          return construir(fc, extraerHora(texto));
        }
      }
    }
  }

  // Solo hora
  const horaEx = extraerHora(texto);
  if (horaEx) {
    const r=new Date(base); const [h,m]=horaEx.split(":").map(Number);
    if(h<base.getHours()||(h===base.getHours()&&m<=base.getMinutes()))r.setDate(r.getDate()+1);
    return construir(r, horaEx);
  }
  return null;
  } catch(e) {
    console.log('[MOTOR_FECHAS_WEB] Error:', e.message);
    return null;
  }
}

// verificarDisponibilidad inline — llama al endpoint existente via HTTP
async function verificarDisponibilidadWeb(env, negocioId, fechaISO, horaInicio, duracionMin) {
  try {
    // Importar directamente la lógica desde D1
    const horarios = await env.producto_c_db.prepare(
      `SELECT hora_inicio, hora_fin FROM horarios_atencion
       WHERE negocio_id = ? AND activo = 1
       AND dia_semana = (CAST(strftime('%w', ?) AS INTEGER))
       LIMIT 1`
    ).bind(negocioId, fechaISO).first();

    if (!horarios) return { disponible: false, motivo: "No hay atención configurada ese día" };

    const [hIni] = horaInicio.split(":").map(Number);
    const [hFin] = horarios.hora_fin.split(":").map(Number);
    const hFinCita = hIni + Math.ceil(duracionMin / 60);
    if (hFinCita > hFin) return { disponible: false, motivo: "La cita excede el horario de atención" };

    const choque = await env.producto_c_db.prepare(
      `SELECT id FROM citas WHERE negocio_id = ? AND fecha_cita = ? AND fecha_hora = ?
       AND estado_pago NOT IN ('cancelada','expirada') LIMIT 1`
    ).bind(negocioId, fechaISO, horaInicio).first();

    if (choque) return { disponible: false, motivo: "Horario ocupado por otra cita" };
    return { disponible: true };
  } catch(e) {
    console.log("verificarDisponibilidadWeb error:", e.message);
    return { disponible: true }; // En caso de error, permitir la cita
  }
}

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

  const { slug, mensaje, sessionToken, historial = [], fecha_guardada = null, servicio_guardado = null } = body;
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

    // 2a. Detección de servicio en el mensaje actual
    const msgLowerDetect = mensaje.toLowerCase();
    const servicioMencionadoAhora = servicios.find(s =>
      msgLowerDetect.includes(s.nombre.toLowerCase())
    );
    // La tarjeta con foto se activa desde aquí solo como fallback —
    // el trigger principal es mostrar_resumen (cuando Groq confirma el servicio).
    // Aquí solo lo marcamos si el usuario lo menciona Y el bot no lo ha
    // preguntado todavía (historial corto = primeros 2 mensajes del bot)
    const mensajesBot = historial.filter(m => m.role === 'bot').length;
    const mostrarTarjetaServicio = servicioMencionadoAhora && mensajesBot <= 2;

    // 2. Motor de Fechas — resolver fecha del mensaje antes de Groq
    const fechaResuelta = resolverFechaNatural(mensaje);

    // 2b. Verificar modo manual — si el bot está pausado no responder con IA
    let modoManualActivo = false;
    if (sessionToken) {
      try {
        const mm = await env.producto_c_db.prepare(
          `SELECT 1 FROM modos_manual WHERE numero = ? AND negocio_id = ? LIMIT 1`
        ).bind(sessionToken, negocio?.id || 0).first();
        if (mm) modoManualActivo = true;
      } catch(e) {}
    }

    if (modoManualActivo) {
      return Response.json({
        success: true,
        respuesta: 'En este momento un miembro de nuestro equipo está atendiendo tu consulta. En breve te responderemos. 😊',
        mostrar_servicios: false,
        mostrar_resumen: false,
        cita_creada: null,
        filtro_activado: false,
        servicio: null,
        fecha_resuelta: null,
        servicios: []
      }, { headers: corsHeaders });
    }

    // 3. Paciente recurrente — buscar por sessionToken
    let pacienteRecurrente = null;
    if (sessionToken && historial.length === 0) {
      // Solo al inicio de la conversación (historial vacío = primer mensaje)
      try {
        pacienteRecurrente = await env.producto_c_db.prepare(
          `SELECT c.cliente_nombre, s.nombre as ultimo_servicio, c.fecha_cita
           FROM citas c LEFT JOIN servicios s ON s.id = c.servicio_id
           WHERE c.session_token = ? AND c.negocio_id = ?
           AND c.estado_pago IN ('confirmada','esperando_pago','pagado')
           ORDER BY c.id DESC LIMIT 1`
        ).bind(sessionToken, negocio.id).first();
      } catch(e) {}
    }

    // 3b. Protección de duplicados — verificar si ya tiene cita activa
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

    // Contexto de paciente recurrente para el prompt
    const contextoRecurrente = pacienteRecurrente
      ? `PACIENTE RECURRENTE: Ya conocemos a este paciente. Nombre: ${pacienteRecurrente.cliente_nombre}. Último servicio: ${pacienteRecurrente.ultimo_servicio || 'desconocido'} el ${pacienteRecurrente.fecha_cita || 'fecha desconocida'}. Salúdalo por su nombre y pregunta si viene por el mismo tratamiento o algo diferente. NO le pidas el nombre — ya lo tienes.`
      : '';

    // Extraer nombre y teléfono del historial — escaneo directo de mensajes del usuario
    let nombreEnHistorial = '';
    let telEnHistorial    = '';
    const msgsUser = historial.filter(m => m.role === 'user').map(m => m.text || '');

    for (const txt of msgsUser) {
      if (telEnHistorial) break;
      const emailM = txt.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
      const telM   = txt.match(/\+?[\d][\d\s\-\(\)]{5,14}/);
      if (emailM) telEnHistorial = emailM[0];
      else if (telM && telM[0].replace(/\D/g,'').length >= 7) telEnHistorial = telM[0].replace(/[\s\-\(\)]/g,'').trim();
    }

    for (const txt of msgsUser) {
      if (nombreEnHistorial) break;
      const mExp = txt.match(/(?:mi nombre es|me llamo|soy)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)*)/i);
      if (mExp) { nombreEnHistorial = mExp[1].trim(); break; }
      const limpio = txt
        .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '')
        .replace(/\+?[\d][\d\s\-\(\)]{5,14}/g, '')
        .replace(/\b(mi nombre es|me llamo|soy|nombre|teléfono|telefono|celular|correo|email|número|numero|mi|es|y|el)\b/gi, '')
        .replace(/[^a-zA-ZáéíóúÁÉÍÓÚñÑ\s]/g, '')
        .replace(/\s+/g, ' ').trim();
      const palabras = limpio.split(' ').filter(p => p.length >= 2);
      if (palabras.length >= 1 && palabras.length <= 4 &&
          !/quiero|agendar|interesa|buenos|buenas|hola|limpieza|blanquea|implante|ortodon|martes|lunes|miércoles|jueves|viernes|tarde|mañana/i.test(limpio)) {
        nombreEnHistorial = palabras.join(' ');
      }
    }

    const contextoDatosCapturados = (nombreEnHistorial || telEnHistorial)
      ? `DATOS YA CAPTURADOS EN ESTA CONVERSACIÓN — NO VOLVER A PEDIR:${nombreEnHistorial ? ` Nombre: ${nombreEnHistorial}.` : ''}${telEnHistorial ? ` Teléfono: ${telEnHistorial}.` : ''} Usa estos datos directamente al confirmar la cita.`
      : '';

    const fechaContexto = fechaResuelta
      ? `FECHA DETECTADA EN EL MENSAJE: ${fechaResuelta.texto} (${fechaResuelta.fecha}${fechaResuelta.hora ? ` a las ${fechaResuelta.hora}` : ''}) — usa esta fecha exacta en tu respuesta, no calcules fechas tú mismo.`
      : `Si el paciente menciona una fecha o día, inclúyela en tu respuesta tal como él la dijo.`;

    const systemPrompt = `Eres Valeria, la secretaria virtual premium de "${negocio.nombre}". Atiendes el chat de la clínica dental con un tono cálido, profesional y panameño. Eres eficiente y amable — una sola pregunta a la vez.

CATÁLOGO DE SERVICIOS (ÚNICA FUENTE DE VERDAD):
${listaServicios || 'No hay servicios cargados.'}

${instruccionPago}

${fechaContexto}

${contextoRecurrente ? contextoRecurrente + '\n\n' : ''}${contextoDatosCapturados ? contextoDatosCapturados + '\n\n' : ''}━━━ CATÁLOGO — REGLAS DE USO ESTRICTO ━━━
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
1. Si es el PRIMER mensaje del paciente (historial vacío): saluda con calidez y pide nombre y teléfono en el mismo mensaje. Ejemplo: "¡Hola! Soy Valeria 😊 Antes de ayudarte, ¿me puedes indicar tu nombre y un número de teléfono o correo por si necesitamos confirmar algo?"
2. Una vez que tengas nombre y teléfono/correo: entiende qué servicio le interesa
3. Confirma fecha y hora con la fecha ya resuelta por el sistema
4. Muestra resumen y pregunta ¿Confirmas la cita? — termina con [MOSTRAR_RESUMEN]
5. SOLO cuando confirme → termina con [CREAR_CITA]

REGLAS DE CONTACTO:
- Si el paciente es RECURRENTE (ya lo conocemos) NO le pidas nombre ni teléfono — ya los tienes.
- Si el paciente da solo el nombre sin teléfono: agradece y pide el teléfono o correo en el siguiente mensaje.
- Si el paciente se niega a dar teléfono: acepta con amabilidad y continúa con el agendamiento.
- NUNCA vuelvas a pedir nombre o teléfono si el paciente ya los proporcionó en esta conversación — búscalos en el historial.
- ANTES de pedir confirmación de cita, revisa el historial. Si ya tienes nombre Y teléfono, procede directamente a confirmar la cita sin pedir nada más.

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
      body: JSON.stringify({ model: MODEL, messages: mensajesGroq, max_tokens: 500, temperature: 0.3 }),
    });

    if (!groqRes.ok) throw new Error(`Groq error: ${await groqRes.text()}`);
    const groqData = await groqRes.json();

    // Log para diagnóstico — ver qué devuelve Groq exactamente
    if (!groqData.choices?.[0]?.message?.content) {
      console.log('[GROQ_WEB] Respuesta vacía. finish_reason:',
        groqData.choices?.[0]?.finish_reason,
        '| error:', JSON.stringify(groqData.error || null));
    }

    let respuesta = groqData.choices?.[0]?.message?.content?.trim();

    // ── MODO EMERGENCIA CUANDO GROQ FALLA ───────────────────────────────────
    // Sin modelo — solo lógica determinista según el contexto de la conversación.
    // Cero alucinaciones porque no hay LLM involucrado.
    if (!respuesta) {
      console.log('[MODO_EMERGENCIA_WEB] Groq devolvió vacío — activando respuesta determinista');

      // Extraer nombre del historial de forma segura
      let nombreEmergencia = '';
      for (let i = 0; i < historial.length - 1; i++) {
        const msg = historial[i]; const sig = historial[i + 1];
        if (msg.role === 'bot' && /nombre|llamas/i.test(msg.text || '')) {
          const r = (sig?.text || '').trim();
          if (r.length < 40 && !/quiero|agendar|cita|blanquea|limpieza|implante|ortodon/i.test(r)) {
            nombreEmergencia = r.split(' ')[0]; break;
          }
        }
      }

      // Servicio: priorizar servicio_guardado (más confiable)
      const svcEmerg = servicio_guardado
        ? servicios.find(s => s.id === servicio_guardado.id || s.nombre === servicio_guardado.nombre)
        : servicioMencionadoAhora;

      // Detectar en qué etapa está la conversación y responder apropiadamente
      const tieneNombre   = nombreEmergencia.length > 0;
      const tieneServicio = !!svcEmerg;
      const tieneFecha    = !!fechaResuelta;
      const ultMsgBot     = historial.filter(m => m.role === 'bot').slice(-1)[0]?.text || '';
      const preguntaFecha = /fecha|hora|día|cuándo/i.test(ultMsgBot);
      const preguntaNombre = /nombre/i.test(ultMsgBot);

      if (tieneFecha && tieneServicio) {
        // Tenemos todo — generar resumen seguro
        respuesta = `Perfecto${nombreEmergencia ? `, ${nombreEmergencia}` : ''}. Resumen: ${svcEmerg.nombre}, ${fechaResuelta.texto}, $${svcEmerg.precio} USD. ¿Confirmas la cita? 😊 [MOSTRAR_RESUMEN]`;
      } else if (preguntaNombre && !tieneNombre) {
        respuesta = `Disculpa el retraso. ¿Me podrías repetir tu nombre, por favor? 😊`;
      } else if (preguntaFecha || (tieneServicio && tieneNombre && !tieneFecha)) {
        respuesta = `Disculpa, tuve un inconveniente técnico. ¿Me podrías repetir la fecha y hora que prefieres para tu cita? 😊`;
      } else if (tieneServicio && !tieneNombre) {
        respuesta = `Perfecto. Para continuar, ¿me podrías indicar tu nombre completo? 😊`;
      } else {
        respuesta = `Disculpa el inconveniente. ¿En qué servicio dental puedo ayudarte hoy? 😊`;
      }
    }

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
      // Buscar el servicio más reciente mencionado — priorizar mensaje actual
      // luego historial reciente de más nuevo a más viejo
      const fuentes = [
        mensaje,
        ...historial.slice(-6).reverse().map(m => m.text || '')
      ];
      for (const texto of fuentes) {
        const t = texto.toLowerCase();
        const encontrado = servicios.find(s => t.includes(s.nombre.toLowerCase()));
        if (encontrado) return encontrado;
      }
      return null;
    }

    // Extraer fecha del historial — igual que en WhatsApp
    // Cuando el paciente confirma, la fecha está en un mensaje anterior de Valeria
    function extraerFechaDeHistorial() {
      const mensajesBot = historial.filter(m => m.role === 'bot').slice(-3);
      for (const msg of mensajesBot.reverse()) {
        const texto = msg.text || '';
        // Acepta "a las 13:00", "a la 1:00 p.m.", "a las 9am", etc.
        const match = texto.match(
          /(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\s+\d{1,2}\s+de\s+\w+(?:\s+de\s+\d{4})?\s+a\s+la[s]?\s+[\d:]+\s*(?:p\.?\s*m\.?|a\.?\s*m\.?|PM|AM|pm|am)?/i
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
      mostrarResumen = false; // No mostrar resumen de nuevo al confirmar — ya se mostró antes
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
    // Buscar fecha en historial expandido si los métodos principales fallaron
    function extraerFechaDeHistorialExpandido() {
      // Busca en todos los mensajes del bot, no solo los últimos 3
      const todosMensajesBot = historial.filter(m => m.role === 'bot');
      for (const msg of [...todosMensajesBot].reverse()) {
        const texto = msg.text || '';
        // Patrón amplio: acepta "a la" / "a las" / "a las X:XX p.m."
        const match = texto.match(
          /(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\s+\d{1,2}\s+de\s+\w+(?:\s+de\s+\d{4})?\s+a\s+la[s]?\s+[\d:]+\s*(?:p\.?\s*m\.?|a\.?\s*m\.?|PM|AM|pm|am)?/i
        );
        if (match) {
          console.log('[FECHA_HISTORIAL_WEB] Encontrada:', match[0]);
          return resolverFechaNatural(match[0]);
        }
        // También buscar formato ISO en el texto
        const matchISO = texto.match(/(\d{4}-\d{2}-\d{2})/);
        if (matchISO) {
          const horaMatch = texto.match(/(\d{2}:\d{2})/);
          if (horaMatch) return { fecha: matchISO[1], hora: horaMatch[1], texto: matchISO[1] };
        }
      }
      return null;
    }

    // Fuente de verdad para fecha y servicio al confirmar:
    // 1. fecha_guardada del frontend (más confiable — guardada cuando llegó mostrar_resumen)
    // 2. fecha resuelta del mensaje actual
    // 3. extraída del historial como último recurso
    const fechaFinal = fecha_guardada
      || fechaResuelta
      || (crearCita || mostrarResumen ? extraerFechaDeHistorial() : null)
      || (crearCita ? extraerFechaDeHistorialExpandido() : null);

    // Servicio guardado por el frontend — evita depender de detectarServicioEnContexto
    // cuando el usuario confirma y no menciona el servicio en ese mensaje
    if (servicio_guardado && !servicioResumen) {
      // Verificar que el servicio guardado existe en el catálogo actual
      const svcGuardado = servicios.find(s => s.id === servicio_guardado.id || s.nombre === servicio_guardado.nombre);
      if (svcGuardado) {
        // No podemos reasignar servicioResumen directamente (const) — lo manejamos abajo
        console.log('[SERVICIO_GUARDADO]', svcGuardado.nombre);
      }
    }
    const servicioFinal = servicioResumen
      || (servicio_guardado ? servicios.find(s => s.id === servicio_guardado.id || s.nombre === servicio_guardado.nombre) : null);

    // 9. Agenda Real — verificar disponibilidad si hay fecha y servicio
    let disponibilidadInfo = null;
    if (fechaFinal?.fecha && fechaFinal?.hora && servicioResumen) {
      const duracion = parseInt(servicioResumen.duracion) || 30;
      try {
        disponibilidadInfo = await verificarDisponibilidadWeb(env, negocio.id, fechaFinal.fecha, fechaFinal.hora, duracion);
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
    if (crearCita) {
      console.log('[CREAR_CITA_WEB] crearCita=true | sessionToken:', !!sessionToken,
        '| citaActivaWeb:', !!citaActivaWeb,
        '| fechaFinal:', fechaFinal?.fecha || 'null',
        '| servicioResumen:', servicioResumen?.nombre || 'null');
    }
    if (crearCita && sessionToken && !citaActivaWeb && fechaFinal?.fecha && servicioFinal) {
      try {
        // Fuente de verdad para nombre y teléfono: el chat ya guardado en D1
        // que fue actualizado al inicio de la conversación con los datos correctos.
        // Evita depender del slice(-6) del historial que puede no incluir el mensaje inicial.
        let nombrePacienteWeb = 'Paciente Web';
        let telPacienteWeb    = sessionToken;

        try {
          const chatGuardado = await env.producto_c_db.prepare(
            `SELECT cliente_nombre, cliente_tel FROM chats
             WHERE session_token = ? AND negocio_id = ? ORDER BY id DESC LIMIT 1`
          ).bind(sessionToken, negocio.id).first();
          const esNombreInvalido = (n) => !n || ['Visitante Web','Paciente Web'].includes(n) ||
            /^(buen|buenos|buenas|hola|días|dia|tardes|noches|gracias|ok|si|sí|listo|perfecto|hola buenos|buen día|buenas tardes|buenas noches)/i.test(n.trim());
          if (chatGuardado?.cliente_nombre && !esNombreInvalido(chatGuardado.cliente_nombre)) {
            nombrePacienteWeb = chatGuardado.cliente_nombre;
          }
          if (chatGuardado?.cliente_tel && !chatGuardado.cliente_tel.includes('-')) {
            telPacienteWeb = chatGuardado.cliente_tel;
          }
        } catch(eChatLookup) {
          console.log('[CITA_WEB] Error leyendo chat para nombre/tel:', eChatLookup.message);
          // Fallback: intentar extraer del historial disponible
          const msgsCita = historial.filter(m => m.role === 'user').map(m => m.text || '');
          for (const txt of [...msgsCita, mensaje]) {
            const mExp = txt.match(/(?:mi nombre es|me llamo|soy)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)*)/i);
            if (mExp) { nombrePacienteWeb = mExp[1].trim(); break; }
            const telM = txt.match(/\+?[\d][\d\s\-\(\)]{5,14}/);
            if (telM && telM[0].replace(/\D/g,'').length >= 7) telPacienteWeb = telM[0].replace(/[\s\-\(\)]/g,'').trim();
          }
        }
        console.log('[CITA_WEB] nombre:', nombrePacienteWeb, '| tel:', telPacienteWeb);
        const duracion = parseInt(servicioResumen.duracion) || 30;
        const disponible = await verificarDisponibilidadWeb(env, negocio.id, fechaFinal.fecha, fechaFinal.hora || '09:00', duracion);
        if (disponible.disponible) {
          const estadoCita = modoReserva === 'solo_cita' ? 'confirmada' : 'esperando_pago';
          await env.producto_c_db.prepare(
            `INSERT INTO citas (negocio_id, servicio_id, cliente_nombre, cliente_tel,
             fecha_cita, fecha_hora, total, estado_pago, metodo_pago, session_token, canal)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'web', ?, 'web')`
          ).bind(
            negocio.id, servicioFinal.id, nombrePacienteWeb, telPacienteWeb,
            fechaFinal.fecha, fechaFinal.hora || null,
            servicioFinal.precio, estadoCita, sessionToken
          ).run();
          citaCreada = { servicio: servicioFinal.nombre, fecha: fechaFinal.texto };

          // Enriquecer el mensaje de confirmación si Groq lo dejó muy corto
          if (respuesta && respuesta.length < 50) {
            // Usar nombrePacienteWeb que ya fue extraído correctamente del historial
            const primerNombreConf = nombrePacienteWeb !== 'Paciente Web'
              ? nombrePacienteWeb.split(' ')[0] : '';
            const modoMsg = modoReserva === 'solo_cita'
              ? `Te esperamos el ${citaCreada.fecha}. Si necesitas reagendar, escríbenos con anticipación. 😊`
              : `Para confirmarla, completa el pago con el enlace que te enviamos. 😊`;
            respuesta = `¡Listo${primerNombreConf ? `, ${primerNombreConf}` : ''}! Tu cita de ${citaCreada.servicio} está registrada para el ${citaCreada.fecha}. ${modoMsg}`;
          }

          // Notificar Telegram — igual que WhatsApp
          try {
            if (negocio.telegram_chat_id && env.TELEGRAM_TOKEN) {
              const estadoTexto = estadoCita === 'confirmada' ? 'Confirmada ✅' : 'Esperando pago ⏳';
              const textoTg = `🌐 <b>NUEVA CITA — Canal Web</b>
` +
                `👤 Cliente: ${nombrePacienteWeb}
` +
                `🦷 Servicio: ${servicioFinal.nombre}
` +
                `📅 Fecha: ${fechaFinal.texto}
` +
                `💰 Total: $${servicioFinal.precio} USD
` +
                `📌 Estado: ${estadoTexto}`;

              // Buscar id de la cita recién creada para los botones
              const citaNueva = await env.producto_c_db.prepare(
                `SELECT id FROM citas WHERE negocio_id = ? AND session_token = ? ORDER BY id DESC LIMIT 1`
              ).bind(negocio.id, sessionToken).first();
              const citaIdTg = citaNueva?.id || 0;

              // Botones igual que WhatsApp
              await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  chat_id: negocio.telegram_chat_id,
                  text: textoTg,
                  parse_mode: 'HTML',
                  reply_markup: {
                    inline_keyboard: [
                      [
                        { text: '✅ Confirmar Cita', callback_data: `confirmar:${citaIdTg}` },
                        { text: '❌ Rechazar/Cancelar', callback_data: `rechazar:${citaIdTg}` }
                      ],
                      [
                        { text: '🛑 Pausar Bot Web', callback_data: `pausar:${sessionToken}:${negocio.id}:${citaIdTg}` }
                      ]
                    ]
                  }
                })
              });
            }
          } catch(e) { console.log('Error Telegram web:', e.message); }
        }
      } catch(e) { console.log('Error creando cita web:', e.message); }
    }

    // 11. Detectar carrusel general
    // No mostrar carrusel si se acaba de confirmar/crear una cita, mostrar resumen,
    // o si ya estamos mostrando la tarjeta de un servicio específico
    const mostrarServicios = /servicio|agendar|cita|opciones|disponible|tratamiento/i.test(mensaje)
      && !mostrarResumen && !crearCita && !citaCreada && !mostrarTarjetaServicio;

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
          let nombreActualizado = null;
          let telActualizado    = null;
          const mensajesUsuario = nuevoHistorial.filter(m => m.role === 'user').map(m => m.text || '');

          // Buscar teléfono o correo en todos los mensajes del usuario
          for (const txt of mensajesUsuario) {
            if (telActualizado) break;
            const emailM = txt.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
            const telM   = txt.match(/\+?[\d][\d\s\-\(\)]{5,14}/);
            if (emailM) telActualizado = emailM[0];
            else if (telM && telM[0].replace(/\D/g,'').length >= 7) {
              telActualizado = telM[0].replace(/[\s\-\(\)]/g,'').trim();
            }
          }

          // Buscar nombre: primero patrón explícito, luego limpieza
          for (const txt of mensajesUsuario) {
            if (nombreActualizado) break;
            const mExp = txt.match(/(?:mi nombre es|me llamo|soy)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)*)/i);
            if (mExp) { nombreActualizado = mExp[1].trim(); break; }
            const limpio = txt
              .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '')
              .replace(/\+?[\d][\d\s\-\(\)]{5,14}/g, '')
              .replace(/\b(mi nombre es|me llamo|soy|nombre|teléfono|telefono|celular|correo|email|número|numero|mi|es|y|el)\b/gi, '')
              .replace(/[^a-zA-ZáéíóúÁÉÍÓÚñÑ\s]/g, '')
              .replace(/\s+/g, ' ').trim();
            const palabras = limpio.split(' ').filter(p => p.length >= 2);
            if (palabras.length >= 1 && palabras.length <= 4 &&
                !/quiero|agendar|interesa|buen|buenas|buenos|hola|días|dia|tardes|tarde|noches|noche|gracias|confirmo|confirma|perfecto|entendido|claro|ok|listo|si|sí|limpieza|blanquea|implante|ortodon|martes|lunes|miércoles|jueves|viernes|mañana/i.test(limpio)) {
              nombreActualizado = palabras.join(' ');
            }
          }

          const nombreFinal = nombreActualizado || existente.cliente_nombre || 'Visitante Web';
          const telFinal    = telActualizado    || existente.cliente_tel    || 'web';
          await env.producto_c_db
            .prepare('UPDATE chats SET historial_json = ?, fecha = ?, cliente_nombre = ?, cliente_tel = ? WHERE id = ?')
            .bind(JSON.stringify(nuevoHistorial), new Date().toISOString(), nombreFinal, telFinal, existente.id).run();
        } else {
          await env.producto_c_db
            .prepare(`INSERT INTO chats (negocio_id, session_token, cliente_nombre, cliente_tel, historial_json, fecha, completado, canal)
                      VALUES (?, ?, ?, ?, ?, ?, 0, 'web')`)
            .bind(negocio.id, sessionToken, 'Visitante Web', 'web', JSON.stringify(nuevoHistorial), new Date().toISOString()).run();
        }
      } catch(e) { console.error('DB chat error:', e.message); }
    }

    // 13. Responder
    // Si se detectó servicio por primera vez, incluirlo para mostrar tarjeta con foto
    // Activar tarjeta de servicio también cuando hay resumen (foto antes del texto)
    // La tarjeta separada solo aparece sin resumen — cuando hay resumen el card visual lo cubre
    const debesMostrarTarjeta = mostrarTarjetaServicio && !mostrarResumen;
    const servicioParaFrontend = servicioResumen || (debesMostrarTarjeta ? servicioMencionadoAhora : null);

    return Response.json({
      success: true,
      respuesta,
      mostrar_servicios:       mostrarServicios,
      mostrar_resumen:         mostrarResumen,
      mostrar_tarjeta_servicio: debesMostrarTarjeta,
      cita_creada:             citaCreada,
      filtro_activado:         filtroResult.filtroActivado,
      servicio: servicioParaFrontend ? {
        id:        servicioParaFrontend.id,
        nombre:    servicioParaFrontend.nombre,
        precio:    servicioParaFrontend.precio,
        duracion:  servicioParaFrontend.duracion,
        icono:     servicioParaFrontend.icono,
        imagen_url: servicioParaFrontend.imagen_url,
        descripcion: servicioParaFrontend.descripcion,
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
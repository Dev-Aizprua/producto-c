// ============================================================
// functions/api/agenda.js
// Agenda Real — Producto C
// Calcula disponibilidad dinámica cruzando:
// - horarios_atencion (configuración del negocio)
// - citas existentes (estado != cancelada)
// - duracion del servicio solicitado
// ============================================================

const ESTADOS_OCUPAN_AGENDA = ["esperando_pago", "pago_por_verificar", "pendiente_confirmacion", "confirmada"];

// ─── VERIFICAR DISPONIBILIDAD ────────────────────────────────
// Entrada: negocioId, fechaISO ("2026-06-24"), horaInicio ("15:00"), duracionMin
// Salida: { disponible: true/false, motivo: "..." }
export async function verificarDisponibilidad(env, negocioId, fechaISO, horaInicio, duracionMin) {
  if (!fechaISO || !horaInicio) {
    return { disponible: false, motivo: "Fecha u hora no especificada" };
  }

  // Blindaje: forzar duracion a número entero sin importar el tipo de dato recibido
  const duracion = parseInt(duracionMin) || 30;

  const fecha = new Date(fechaISO + "T00:00:00");
  const diaSemana = fecha.getDay();

  // 1. Verificar que el día/hora esté dentro del horario de atención
  let horario = null;
  try {
    horario = await env.producto_c_db.prepare(
      `SELECT hora_inicio, hora_fin FROM horarios_atencion
       WHERE negocio_id = ? AND dia_semana = ? AND activo = 1 LIMIT 1`
    ).bind(negocioId, diaSemana).first();
  } catch(e) {}

  if (!horario) {
    return { disponible: false, motivo: "No hay atención configurada ese día" };
  }

  const minutosSolicitudInicio = horaAMinutos(horaInicio);
  const minutosSolicitudFin = minutosSolicitudInicio + duracion;
  const minutosAtencionInicio = horaAMinutos(horario.hora_inicio);
  const minutosAtencionFin = horaAMinutos(horario.hora_fin);

  if (minutosSolicitudInicio < minutosAtencionInicio || minutosSolicitudFin > minutosAtencionFin) {
    return { disponible: false, motivo: `Fuera de horario (atendemos ${horario.hora_inicio} - ${horario.hora_fin})` };
  }

  // 2. Verificar cruce con citas existentes ese día
  let citasDia = [];
  try {
    const res = await env.producto_c_db.prepare(
      `SELECT ci.fecha_cita, ci.fecha_hora, s.duracion
       FROM citas ci
       LEFT JOIN servicios s ON s.id = ci.servicio_id
       WHERE ci.negocio_id = ? AND ci.fecha_cita = ?
         AND ci.estado_pago IN ('${ESTADOS_OCUPAN_AGENDA.join("','")}')`
    ).bind(negocioId, fechaISO).all();
    citasDia = res.results || [];
  } catch(e) {}

  for (const cita of citasDia) {
    if (!cita.fecha_hora) continue; // citas viejas sin hora separada — ignorar en el cruce
    const inicioExistente = horaAMinutos(cita.fecha_hora);
    const finExistente = inicioExistente + (parseInt(cita.duracion) || 30);

    // Hay cruce si los rangos se superponen
    const haySolape = minutosSolicitudInicio < finExistente && minutosSolicitudFin > inicioExistente;
    if (haySolape) {
      return { disponible: false, motivo: "Horario ocupado por otra cita" };
    }
  }

  return { disponible: true, motivo: null };
}

function horaAMinutos(horaStr) {
  const [h, m] = horaStr.split(":").map(Number);
  return h * 60 + (m || 0);
}

// ─── ENDPOINT GET — consulta de disponibilidad (pruebas/panel) ─
export async function onRequestGet(context) {
  const { request, env } = context;
  const token = request.headers.get("X-Health-Token") || "";
  if (token !== (env.HEALTH_TOKEN || "")) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const negocioId = searchParams.get("negocio_id");
  const fecha = searchParams.get("fecha");
  const hora = searchParams.get("hora");
  const duracion = parseInt(searchParams.get("duracion") || "30");

  const resultado = await verificarDisponibilidad(env, negocioId, fecha, hora, duracion);
  return Response.json(resultado);
}

// ─── ENDPOINT POST — configurar horarios desde el panel ────────
export async function onRequestPost(context) {
  const { request, env } = context;
  const token = request.headers.get("X-Health-Token") || "";
  if (token !== (env.HEALTH_TOKEN || "")) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const body = await request.json();
    const { negocio_id, horarios } = body; // horarios: [{dia_semana, hora_inicio, hora_fin}]

    if (!negocio_id || !Array.isArray(horarios)) {
      return Response.json({ ok: false, error: "Datos inválidos" }, { status: 400 });
    }

    // Reemplazar configuración existente
    await env.producto_c_db.prepare(
      `DELETE FROM horarios_atencion WHERE negocio_id = ?`
    ).bind(negocio_id).run();

    for (const h of horarios) {
      await env.producto_c_db.prepare(
        `INSERT INTO horarios_atencion (negocio_id, dia_semana, hora_inicio, hora_fin, activo)
         VALUES (?, ?, ?, ?, 1)`
      ).bind(negocio_id, h.dia_semana, h.hora_inicio, h.hora_fin).run();
    }

    return Response.json({ ok: true, count: horarios.length });
  } catch(e) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}
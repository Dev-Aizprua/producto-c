// ============================================================
// functions/api/panel/servicios.js
// GET    /api/panel/servicios        → listar servicios
// POST   /api/panel/servicios        → crear servicio
// PUT    /api/panel/servicios?id=X   → editar servicio
// DELETE /api/panel/servicios?id=X   → eliminar servicio
// ============================================================

import { registrarAccion } from './auditLib.js';

const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

export async function onRequestGet(context) {
  const { env, data } = context;
  try {
    const { results } = await env.producto_c_db
      .prepare('SELECT * FROM servicios WHERE negocio_id = ? ORDER BY orden ASC')
      .bind(data.negocio_id).all();
    return Response.json({ success: true, servicios: results }, { headers: cors });
  } catch (err) {
    return Response.json({ success: false, error: err.message }, { status: 500, headers: cors });
  }
}

export async function onRequestPost(context) {
  const { request, env, data } = context;
  let body;
  try { body = await request.json(); }
  catch { return Response.json({ success: false, error: 'JSON inválido' }, { status: 400, headers: cors }); }

  const { nombre, descripcion, precio, imagen_url, icono, duracion, orden } = body;
  if (!nombre || !precio) {
    return Response.json({ success: false, error: 'nombre y precio requeridos' }, { status: 400, headers: cors });
  }

  try {
    const result = await env.producto_c_db
      .prepare(`INSERT INTO servicios (negocio_id, nombre, descripcion, precio, imagen_url, icono, duracion, orden, activo)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`)
      .bind(data.negocio_id, nombre, descripcion || '', precio, imagen_url || '', icono || '🛎️', duracion || '45 min', orden || 0)
      .run();

    const nuevoId = result.meta.last_row_id;
    await registrarAccion(env, data, 'crear', 'servicio', nuevoId, `Creó el servicio "${nombre}" — $${precio}`);

    return Response.json({ success: true, id: nuevoId }, { headers: cors });
  } catch (err) {
    return Response.json({ success: false, error: err.message }, { status: 500, headers: cors });
  }
}

export async function onRequestPut(context) {
  const { request, env, data } = context;
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  if (!id) return Response.json({ success: false, error: 'id requerido' }, { status: 400, headers: cors });

  let body;
  try { body = await request.json(); }
  catch { return Response.json({ success: false, error: 'JSON inválido' }, { status: 400, headers: cors }); }

  const { nombre, descripcion, precio, imagen_url, icono, duracion, orden, activo } = body;

  try {
    // Leer valores previos para detectar qué cambió (al menos el precio, que es lo más sensible)
    const servicioPrevio = await env.producto_c_db
      .prepare('SELECT nombre, precio, activo FROM servicios WHERE id = ? AND negocio_id = ? LIMIT 1')
      .bind(id, data.negocio_id).first();

    await env.producto_c_db
      .prepare(`UPDATE servicios SET
        nombre = ?, descripcion = ?, precio = ?, imagen_url = ?,
        icono = ?, duracion = ?, orden = ?, activo = ?
        WHERE id = ? AND negocio_id = ?`)
      .bind(nombre, descripcion, precio, imagen_url, icono, duracion, orden, activo ?? 1, id, data.negocio_id)
      .run();

    // ── Auditoría ──────────────────────────────────────────────
    if (servicioPrevio) {
      let detalle = `Editó el servicio "${nombre}"`;
      if (Number(servicioPrevio.precio) !== Number(precio)) {
        detalle = `Cambió el precio de "${servicioPrevio.nombre}" de $${servicioPrevio.precio} a $${precio}`;
      }
      const accionTipo = (servicioPrevio.activo === 1 && activo === 0) ? 'desactivar'
                        : (servicioPrevio.activo === 0 && activo === 1) ? 'activar'
                        : 'editar';
      if (accionTipo === 'desactivar') detalle = `Desactivó el servicio "${servicioPrevio.nombre}"`;
      if (accionTipo === 'activar')    detalle = `Activó el servicio "${servicioPrevio.nombre}"`;

      await registrarAccion(env, data, accionTipo, 'servicio', Number(id), detalle);
    }

    return Response.json({ success: true, mensaje: 'Servicio actualizado' }, { headers: cors });
  } catch (err) {
    return Response.json({ success: false, error: err.message }, { status: 500, headers: cors });
  }
}

export async function onRequestDelete(context) {
  const { request, env, data } = context;
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  if (!id) return Response.json({ success: false, error: 'id requerido' }, { status: 400, headers: cors });

  try {
    // Leer nombre antes de eliminar — si no, perdemos el dato para el log
    const servicio = await env.producto_c_db
      .prepare('SELECT nombre FROM servicios WHERE id = ? AND negocio_id = ? LIMIT 1')
      .bind(id, data.negocio_id).first();

    await env.producto_c_db
      .prepare('DELETE FROM servicios WHERE id = ? AND negocio_id = ?')
      .bind(id, data.negocio_id).run();

    await registrarAccion(env, data, 'eliminar', 'servicio', Number(id), `Eliminó el servicio "${servicio?.nombre || 'desconocido'}"`);

    return Response.json({ success: true, mensaje: 'Servicio eliminado' }, { headers: cors });
  } catch (err) {
    return Response.json({ success: false, error: err.message }, { status: 500, headers: cors });
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: cors });
}
// ============================================================
// functions/api/negocio/[slug].js
// GET /api/negocio/:slug
// Devuelve la config del negocio + sus servicios activos
// ============================================================

export async function onRequestGet(context) {
  const { params, env } = context;
  const slug = params.slug?.toLowerCase().trim();

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  if (!slug) {
    return Response.json({ success: false, error: 'Slug requerido' }, { status: 400, headers: corsHeaders });
  }

  try {
    // Buscar negocio por slug
    const negocio = await env.producto_c_db
      .prepare('SELECT * FROM negocios WHERE slug = ? AND activo = 1 LIMIT 1')
      .bind(slug)
      .first();

    if (!negocio) {
      return Response.json({ success: false, error: 'Negocio no encontrado' }, { status: 404, headers: corsHeaders });
    }

    // Cargar servicios activos del negocio
    const { results: servicios } = await env.producto_c_db
      .prepare('SELECT * FROM servicios WHERE negocio_id = ? AND activo = 1 ORDER BY orden ASC')
      .bind(negocio.id)
      .all();

    return Response.json({
      success: true,
      negocio: {
        id:              negocio.id,
        slug:            negocio.slug,
        nombre:          negocio.nombre,
        descripcion:     negocio.descripcion,
        logo_url:        negocio.logo_url,
        icono:           negocio.icono,
        color_primary:   negocio.color_primary,
        whatsapp_destino:negocio.whatsapp_destino,
        modo_reserva:    negocio.modo_reserva || 'adelanto',
        monto_reserva:   negocio.monto_reserva || 5,
        servicios:       servicios.map(s => ({
          id:         s.id,
          nombre:     s.nombre,
          descripcion:s.descripcion,
          precio:     s.precio,
          imagen_url: s.imagen_url,
          icono:      s.icono,
          duracion:   s.duracion,
        })),
      },
    }, { headers: corsHeaders });

  } catch (err) {
    return Response.json(
      { success: false, error: 'Error interno', detail: err.message },
      { status: 500, headers: corsHeaders }
    );
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
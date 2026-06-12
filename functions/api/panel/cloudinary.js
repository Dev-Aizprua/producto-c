// ============================================================
// functions/api/panel/cloudinary.js
// POST /api/panel/cloudinary → subir imagen de servicio
// Usa unsigned preset 'tienda' del cloud doaqu6s6c
// Sin necesidad de CLOUDINARY_API_KEY ni CLOUDINARY_SECRET
// Carpeta multi-tenant: producto-c/{slug}
// ============================================================

const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

const CLOUD_NAME = 'doaqu6s6c';
const PRESET     = 'tienda';

export async function onRequestPost(context) {
  const { request, env, data } = context;

  try {
    const formData = await request.formData();
    const file = formData.get('file');

    if (!file) {
      return Response.json({ success: false, error: 'No se recibió imagen' }, { status: 400, headers: cors });
    }

    // Validar tamaño (máx 10MB)
    if (file.size > 10 * 1024 * 1024) {
      return Response.json({ success: false, error: 'La imagen supera 10MB' }, { status: 400, headers: cors });
    }

    // Validar tipo
    const tiposPermitidos = ['image/jpeg','image/jpg','image/png','image/webp'];
    if (!tiposPermitidos.includes(file.type)) {
      return Response.json({ success: false, error: 'Formato no permitido. Usa JPG, PNG o WEBP' }, { status: 400, headers: cors });
    }

    // Carpeta multi-tenant — producto-c/{slug}
    const negocio = await env.producto_c_db
      .prepare('SELECT slug FROM negocios WHERE id = ? LIMIT 1')
      .bind(data.negocio_id).first();

    const carpeta = `producto-c/${negocio?.slug || 'general'}`;

    // Subir a Cloudinary con preset unsigned — sin API key ni secret
    const upload = new FormData();
    upload.append('file', file);
    upload.append('upload_preset', PRESET);
    upload.append('folder', carpeta);

    const res = await fetch(
      `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/image/upload`,
      { method: 'POST', body: upload }
    );

    if (!res.ok) {
      const err = await res.text();
      return Response.json({ success: false, error: 'Cloudinary: ' + err }, { status: 500, headers: cors });
    }

    const cloudData = await res.json();

    return Response.json({
      success:   true,
      url:       cloudData.secure_url,
      public_id: cloudData.public_id,
      width:     cloudData.width,
      height:    cloudData.height,
    }, { headers: cors });

  } catch (err) {
    return Response.json({ success: false, error: err.message }, { status: 500, headers: cors });
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: cors });
}
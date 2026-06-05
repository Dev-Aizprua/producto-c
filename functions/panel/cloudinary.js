// ============================================================
// functions/api/panel/cloudinary.js
// POST /api/panel/cloudinary/sign
// Genera firma SHA-1 para uploads directos desde el browser
// Cloud: doaqu6s6c — Carpeta: producto-c/{slug}
// ============================================================

const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

async function sha1(text) {
  const buffer = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function onRequestPost(context) {
  const { request, env, data } = context;

  let body;
  try { body = await request.json(); }
  catch { return Response.json({ success: false, error: 'JSON inválido' }, { status: 400, headers: cors }); }

  const { folder } = body;
  const timestamp = Math.round(Date.now() / 1000);
  const cloudName = env.CLOUDINARY_CLOUD || 'doaqu6s6c';
  const apiKey    = env.CLOUDINARY_API_KEY;
  const secret    = env.CLOUDINARY_SECRET;

  if (!secret || !apiKey) {
    return Response.json({ success: false, error: 'Cloudinary no configurado' }, { status: 503, headers: cors });
  }

  // Obtener slug del negocio para la carpeta
  const negocio = await env.producto_c_db
    .prepare('SELECT slug FROM negocios WHERE id = ? LIMIT 1')
    .bind(data.negocio_id).first();

  const carpeta = `producto-c/${negocio?.slug || 'general'}`;

  // Construir string a firmar
  const paramsToSign = `folder=${carpeta}&timestamp=${timestamp}`;
  const signature = await sha1(paramsToSign + secret);

  return Response.json({
    success: true,
    signature,
    timestamp,
    api_key: apiKey,
    cloud_name: cloudName,
    folder: carpeta,
    upload_url: `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
  }, { headers: cors });
}

export async function onRequestOptions() {
  return new Response(null, { headers: cors });
}
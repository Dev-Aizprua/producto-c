// ============================================================
// functions/api/panel/login.js
// POST /api/panel/login
// Valida usuario + password SHA-256, devuelve session token
// ============================================================

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

async function sha256(text) {
  const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try { body = await request.json(); }
  catch { return Response.json({ success: false, error: 'JSON inválido' }, { status: 400, headers: corsHeaders }); }

  const { slug, usuario, password } = body;
  if (!slug || !usuario || !password) {
    return Response.json({ success: false, error: 'Datos incompletos' }, { status: 400, headers: corsHeaders });
  }

  try {
    const negocio = await env.producto_c_db
      .prepare('SELECT id, slug, nombre, panel_usuario, panel_password FROM negocios WHERE slug = ? AND activo = 1 LIMIT 1')
      .bind(slug).first();

    if (!negocio) {
      return Response.json({ success: false, error: 'Negocio no encontrado' }, { status: 404, headers: corsHeaders });
    }

    const passwordHash = await sha256(password);

    if (usuario !== negocio.panel_usuario || passwordHash !== negocio.panel_password) {
      return Response.json({ success: false, error: 'Usuario o contraseña incorrectos' }, { status: 401, headers: corsHeaders });
    }

    // Generar session token y guardarlo en D1
    const sessionToken = crypto.randomUUID();
    const expira = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(); // 8 horas

    await env.producto_c_db
      .prepare('INSERT OR REPLACE INTO panel_sessions (negocio_id, token, expira_at) VALUES (?, ?, ?)')
      .bind(negocio.id, sessionToken, expira).run();

    return Response.json({
      success: true,
      token: sessionToken,
      negocio: { id: negocio.id, slug: negocio.slug, nombre: negocio.nombre },
    }, { headers: corsHeaders });

  } catch (err) {
    return Response.json({ success: false, error: 'Error interno', detail: err.message }, { status: 500, headers: corsHeaders });
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: corsHeaders });
}
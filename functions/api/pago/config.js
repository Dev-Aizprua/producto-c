// ============================================================
// functions/api/pago/config.js
// GET /api/pago/config
// Devuelve las credenciales de Páguelo Fácil desde secrets
// Las credenciales NUNCA se exponen en el frontend directamente
// ============================================================

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
};

export async function onRequestGet(context) {
  const { env } = context;

  const token = env.PAGUELO_FACIL_TOKEN;
  const cclw  = env.PAGUELO_FACIL_CCLW;

  if (!token || !cclw) {
    return Response.json(
      { success: false, error: 'Páguelo Fácil no configurado' },
      { status: 503, headers: cors }
    );
  }

  return Response.json({
    success: true,
    token,
    cclw,
    sandbox: true, // cambiar a false en producción
  }, { headers: cors });
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    }
  });
}
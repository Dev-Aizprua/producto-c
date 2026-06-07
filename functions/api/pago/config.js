// ============================================================
// functions/api/pago/config.js
// POST /api/pago/config
// Genera enlace de pago seguro via API de Páguelo Fácil
// El CCLW y TOKEN nunca se exponen al frontend
// ============================================================

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try { body = await request.json(); }
  catch { return Response.json({ success: false, error: 'JSON inválido' }, { status: 400, headers: cors }); }

  const { monto, descripcion, slug } = body;

  if (!monto || !descripcion) {
    return Response.json({ success: false, error: 'monto y descripcion requeridos' }, { status: 400, headers: cors });
  }

  const cclw  = env.PAGUELO_FACIL_CCLW;
  const token = env.PAGUELO_FACIL_TOKEN;

  if (!cclw || !token) {
    return Response.json({ success: false, error: 'Páguelo Fácil no configurado' }, { status: 503, headers: cors });
  }

  // URL de retorno — donde PF devuelve al cliente después del pago
  const returnUrl = `https://producto-c.pages.dev/${slug || 'dental-demo'}?pago=ok`;
  const returnUrlHex = Buffer.from(returnUrl).toString('hex');

  try {
    // Llamar a la API de PF para generar el enlace de pago
    const pfRes = await fetch('https://sandbox.paguelofacil.com/LinkDeamon.cfm', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': '*/*',
      },
      body: new URLSearchParams({
        CCLW:       cclw,
        CMTN:       parseFloat(monto).toFixed(2),
        CDSC:       descripcion,
        RETURN_URL: returnUrlHex,
      }).toString(),
    });

    const pfText = await pfRes.text();
    let pfData;
    try { pfData = JSON.parse(pfText); } catch { pfData = null; }

    if (pfData?.success && pfData?.data?.url) {
      return Response.json({
        success: true,
        url: pfData.data.url,
        code: pfData.data.code,
      }, { headers: cors });
    }

    // Si PF devuelve directamente una URL sin JSON
    if (pfText && pfText.startsWith('http')) {
      return Response.json({ success: true, url: pfText.trim() }, { headers: cors });
    }

    return Response.json({
      success: false,
      error: 'Error generando enlace de pago',
      detail: pfText,
    }, { status: 502, headers: cors });

  } catch (err) {
    return Response.json(
      { success: false, error: 'Error conectando con Páguelo Fácil', detail: err.message },
      { status: 500, headers: cors }
    );
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: cors });
}
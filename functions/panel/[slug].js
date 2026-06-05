// ============================================================
// functions/panel/[slug].js
// GET /panel/:slug → sirve el panel.html al browser
// ============================================================

export async function onRequestGet(context) {
  const panelHtml = await context.env.ASSETS.fetch(
    new Request('https://dummy/panel.html', context.request)
  );
  return new Response(panelHtml.body, {
    status: 200,
    headers: { 'Content-Type': 'text/html;charset=UTF-8' },
  });
}
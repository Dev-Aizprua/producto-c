// ============================================================
// functions/api/health.js
// GET /api/health
// Endpoint de monitoreo proactivo — llamado por cron-job.org
// cada 10 minutos. Verifica Groq + D1 y notifica a Telegram
// si algo falla. Incluye silenciador anti-spam (20 min).
// ============================================================

// Token secreto para que nadie externo pueda llamar este endpoint
// Configúralo en Cloudflare como secret: HEALTH_TOKEN
// Y en cron-job.org como header:  X-Health-Token: <valor>
const CHAT_ID_DUENO  = "8483416774";
const MINUTOS_SILENCIO = 20;

export async function onRequestGet(context) {
  const { request, env } = context;

  // ── Verificar token de seguridad ─────────────────────────
  const tokenRecibido = request.headers.get("X-Health-Token") || "";
  const tokenEsperado = env.HEALTH_TOKEN || "";

  if (tokenEsperado && tokenRecibido !== tokenEsperado) {
    return new Response("Unauthorized", { status: 401 });
  }

  const errores = [];

  // ── CHEQUEO 1: D1 ────────────────────────────────────────
  try {
    await env.producto_c_db.prepare("SELECT 1").first();
  } catch(e) {
    errores.push(`🗄️ <b>D1 (Base de datos)</b>\n   Error: ${e.message}`);
  }

  // ── CHEQUEO 2: Groq — ping mínimo de 1 token ─────────────
  try {
    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1
      })
    });

    if (!groqRes.ok) {
      const groqData = await groqRes.json().catch(() => ({}));
      const codigo   = groqData.error?.code || groqRes.status;
      const msg      = groqData.error?.message || "Sin respuesta";

      if (groqRes.status === 429) {
        errores.push(`🤖 <b>Groq (IA)</b>\n   ⚠️ Rate limit excedido (429) — posible saturación`);
      } else {
        errores.push(`🤖 <b>Groq (IA)</b>\n   Error ${codigo}: ${msg.slice(0, 80)}`);
      }
    }
  } catch(e) {
    errores.push(`🤖 <b>Groq (IA)</b>\n   Sin conexión: ${e.message}`);
  }

  // ── Todo bien: responder OK sin notificar ─────────────────
  if (errores.length === 0) {
    console.log(`[HEALTH] ✅ OK — ${new Date().toISOString()}`);
    return Response.json({ ok: true, status: "healthy", ts: new Date().toISOString() });
  }

  // ── Hay errores: verificar silenciador ───────────────────
  try {
    await env.producto_c_db.prepare(`
      CREATE TABLE IF NOT EXISTS health_checks (
        id INTEGER PRIMARY KEY,
        ultima_alerta TEXT,
        ultimo_error  TEXT
      )
    `).run();

    const registro       = await env.producto_c_db.prepare(
      "SELECT ultima_alerta FROM health_checks WHERE id = 1"
    ).first();

    const ahora          = Date.now();
    const ultimaAlerta   = registro?.ultima_alerta ? Number(registro.ultima_alerta) : 0;
    const minutosPasados = (ahora - ultimaAlerta) / 60000;

    if (minutosPasados < MINUTOS_SILENCIO) {
      console.log(`[HEALTH] ❌ Error silenciado (última alerta hace ${Math.floor(minutosPasados)} min)`);
      return Response.json({ ok: false, silenciado: true, errores });
    }

    // Actualizar timestamp
    if (registro) {
      await env.producto_c_db.prepare(
        "UPDATE health_checks SET ultima_alerta = ?, ultimo_error = ? WHERE id = 1"
      ).bind(String(ahora), errores.join(" | ")).run();
    } else {
      await env.producto_c_db.prepare(
        "INSERT INTO health_checks (id, ultima_alerta, ultimo_error) VALUES (1, ?, ?)"
      ).bind(String(ahora), errores.join(" | ")).run();
    }
  } catch(e) {
    console.log("[HEALTH] Error en silenciador:", e.message);
    // Si falla el silenciador notificamos igual
  }

  // ── Enviar alerta a Telegram ──────────────────────────────
  const hora = new Date().toLocaleTimeString("es-PA", {
    timeZone: "America/Panama",
    hour: "2-digit",
    minute: "2-digit"
  });

  const textoAlerta =
    `🔴 <b>ALERTA DE SISTEMA — ${hora}</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    errores.join("\n\n") +
    `\n\n🕐 <i>Chequeo automático cada 10 min.\n` +
    `Próxima alerta en mín. ${MINUTOS_SILENCIO} min si persiste.</i>`;

  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CHAT_ID_DUENO,
        text: textoAlerta,
        parse_mode: "HTML"
      })
    });
    console.log(`[HEALTH] ❌ Alerta Telegram enviada — ${errores.length} error(es)`);
  } catch(e) {
    console.log("[HEALTH] Error enviando Telegram:", e.message);
  }

  return Response.json({ ok: false, errores });
}
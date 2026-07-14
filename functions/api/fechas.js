// ============================================================
// functions/api/fechas.js
// Motor de Fechas — Producto C
// Resuelve lenguaje natural a fechas reales usando
// America/Panama como zona horaria base.
//
// REGLA CRÍTICA: La IA NUNCA calcula fechas.
// Este módulo es quien decide qué fecha es "mañana",
// "el próximo martes", "la otra semana", etc.
// ============================================================

const TIMEZONE = "America/Panama";

const DIAS_SEMANA = {
  domingo: 0, lunes: 1, martes: 2, miercoles: 3, miércoles: 3,
  jueves: 4, viernes: 5, sabado: 6, sábado: 6
};

const MESES = {
  enero: 0, febrero: 1, marzo: 2, abril: 3, mayo: 4, junio: 5,
  julio: 6, agosto: 7, septiembre: 8, octubre: 9, noviembre: 10, diciembre: 11
};

const NOMBRES_DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const NOMBRES_MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

// ─── FUNCIÓN PRINCIPAL: obtener fecha actual en Panamá ───────
export function obtenerHoy() {
  const ahora = new Date();
  // Usamos formatToParts — más confiable que new Date(toLocaleString()) en CF Workers
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  });
  const parts = fmt.formatToParts(ahora);
  const get = (type) => parseInt(parts.find(p => p.type === type).value);
  const year = get("year"), month = get("month") - 1, day = get("day");
  const hour = get("hour"), minute = get("minute");
  // Construimos el objeto Date con año/mes/día exactos de Panamá
  const enPanama = new Date(year, month, day, hour, minute);
  return {
    fecha: formatearISO(enPanama),
    dia: NOMBRES_DIAS[enPanama.getDay()],
    diaSemana: enPanama.getDay(), // 0=domingo, 6=sábado
    hora: hour,
    minutos: minute,
    timestamp: ahora.getTime()
  };
}

// ─── RESOLVER LENGUAJE NATURAL A FECHA ───────────────────────
// Entrada: "próximo martes", "mañana", "el 25 de junio", "3pm"
// Salida: { fecha: "2026-06-23", dia: "martes", hora: null, texto: "martes 23 de junio" }
export function resolverFechaNatural(texto) {
  if (!texto) return null;
  const lower = texto.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
  const hoy = obtenerHoy();
  // Construimos base con formatToParts para garantizar año correcto en CF Workers
  const _ahoraBase = new Date();
  const _fmtBase = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  });
  const _partsBase = _fmtBase.formatToParts(_ahoraBase);
  const _getB = (type) => parseInt(_partsBase.find(p => p.type === type).value);
  const base = new Date(_getB("year"), _getB("month") - 1, _getB("day"), _getB("hour"), _getB("minute"));

  // ── CASOS SIMPLES ─────────────────────────────────────────
  if (lower === "hoy") {
    return construirResultado(base, extraerHora(texto));
  }

  // ── DÍA DE LA SEMANA (PRIORIDAD ALTA) ─────────────────────
  // Se revisa ANTES que "mañana" porque "9 de la mañana" contiene
  // el substring "manana" y se confundía con el día siguiente.
  for (const [nombreDia, numeroDia] of Object.entries(DIAS_SEMANA)) {
    if (new RegExp(`\\b${nombreDia}\\b`).test(lower)) {
      const resultado = new Date(base);
      const hoyDia = base.getDay();
      let diff = numeroDia - hoyDia;

      const esProximo = /\bproximo\b|\bque viene\b/.test(lower);
      const esOtraSemana = /\bproxima semana\b|\botra semana\b|\bla otra semana\b/.test(lower);

      if (esProximo || esOtraSemana) {
        if (diff <= 0) diff += 7;
        else diff += 7;
      } else {
        // Sin modificador = el más cercano en el futuro (o hoy si coincide)
        if (diff < 0) diff += 7;
      }

      resultado.setDate(resultado.getDate() + diff);
      return construirResultado(resultado, extraerHora(texto));
    }
  }

  // "mañana" como DÍA (no como parte de "de la mañana") — límite de palabra
  if (/\bmanana\b/.test(lower) && !/de la manana|por la manana/.test(lower)) {
    const manana = new Date(base);
    manana.setDate(manana.getDate() + 1);
    return construirResultado(manana, extraerHora(texto));
  }

  if (lower.includes("pasado manana") || lower.includes("pasado mañana")) {
    const pasado = new Date(base);
    pasado.setDate(pasado.getDate() + 2);
    return construirResultado(pasado, extraerHora(texto));
  }

  // ── ESTA SEMANA / PRÓXIMA SEMANA ──────────────────────────
  const esSemana = lower.includes("esta semana");
  const proximaSemana = lower.includes("proxima semana") || lower.includes("otra semana") || lower.includes("la otra semana");

  // ── FECHA CON MES ESCRITO ("el 25 de junio", "25 junio") ─
  // IMPORTANTE: solo corre si NO hay día de semana en el texto.
  // Si Groq dice "jueves 26 de junio" y el bloque de día de semana ya corrió,
  // este bloque no debe sobreescribir con el número literal que Groq pudo alucinar.
  const tieneDiaSemanaEnTexto = Object.keys(DIAS_SEMANA).some(d => new RegExp(`\\b${d}\\b`).test(lower));
  if (!tieneDiaSemanaEnTexto) {
    for (const [nombreMes, numMes] of Object.entries(MESES)) {
      if (lower.includes(nombreMes)) {
        const matchNum = texto.match(/(\d{1,2})\s*(?:de\s*)?(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)/i);
        if (matchNum) {
          const dia = parseInt(matchNum[1]);
          const anio = base.getFullYear();
          const fechaCandidata = new Date(anio, numMes, dia);
          // Si ya pasó en este año, asumir el próximo año
          if (fechaCandidata < base && fechaCandidata.getMonth() === numMes) {
            fechaCandidata.setFullYear(anio + 1);
          }
          return construirResultado(fechaCandidata, extraerHora(texto));
        }
      }
    }
  }

  // ── FECHA NUMÉRICA ("25/06", "25-06", "25/6/2026") ───────
  const matchFechaNum = texto.match(/(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/);
  if (matchFechaNum) {
    const dia = parseInt(matchFechaNum[1]);
    const mes = parseInt(matchFechaNum[2]) - 1;
    const anio = matchFechaNum[3]
      ? (matchFechaNum[3].length === 2 ? 2000 + parseInt(matchFechaNum[3]) : parseInt(matchFechaNum[3]))
      : base.getFullYear();
    const fechaNum = new Date(anio, mes, dia);
    return construirResultado(fechaNum, extraerHora(texto));
  }

  // ── SOLO HORA (sin fecha específica = hoy o mañana) ───────
  const horaExtraida = extraerHora(texto);
  if (horaExtraida) {
    const resultado = new Date(base);
    const [h, m] = horaExtraida.split(":").map(Number);
    // Si la hora ya pasó hoy, asumir mañana
    if (h < base.getHours() || (h === base.getHours() && m <= base.getMinutes())) {
      resultado.setDate(resultado.getDate() + 1);
    }
    return construirResultado(resultado, horaExtraida);
  }

  // No se pudo resolver
  return null;
}

// ─── EXTRAER HORA DEL TEXTO ───────────────────────────────────
// "a las 3 de la tarde" → "15:00"
// "9am" → "09:00"
// "10:30" → "10:30"
export function extraerHora(texto) {
  if (!texto) return null;
  // Se normalizan acentos aquí (antes solo se hacía en resolverFechaNatural,
  // no en extraerHora). Bug encontrado en pruebas reales: "medio día"
  // escrito con tilde Y espacio — como lo escribe cualquier persona — no
  // coincidía con ninguna de las variantes que el código ya contemplaba
  // ("mediodía" pegado, "mediodia" sin tilde, "medio dia" sin tilde).
  // Con acentos normalizados, "medio día" y "medio dia" son la misma
  // cadena, así que basta un solo patrón para cubrir todas las variantes.
  const lower = texto.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  // Formato "X de la tarde / noche / mañana" — acepta pm, p.m, p. m.
  const matchTarde = lower.match(/(\d{1,2})(?::(\d{2}))?\s*(?:de la tarde|de la noche|p\.?\s*m\.?)/);
  if (matchTarde) {
    let h = parseInt(matchTarde[1]);
    const m = matchTarde[2] ? parseInt(matchTarde[2]) : 0;
    if (h < 12) h += 12;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }

  const matchManana = lower.match(/(\d{1,2})(?::(\d{2}))?\s*(?:de la manana|a\.?\s*m\.?)/);
  if (matchManana) {
    let h = parseInt(matchManana[1]);
    const m = matchManana[2] ? parseInt(matchManana[2]) : 0;
    if (h === 12) h = 0;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }

  // Formato "mediodía" / "medio día" / "mediodia" / "medio dia" — con
  // acentos ya normalizados arriba, un solo patrón cubre las 4 variantes
  if (/medio\s*dia/.test(lower)) {
    return "12:00";
  }

  // Formato "X y media" — con o sin am/pm/de la tarde explícito
  const matchYMedia = lower.match(/(\d{1,2})\s*y\s*media/);
  if (matchYMedia) {
    let h = parseInt(matchYMedia[1]);
    const esPM = /tarde|noche|p\.?\s*m\.?/.test(lower);
    const esAM = /mañana|a\.?\s*m\.?/.test(lower);
    if (esPM && h < 12) h += 12;
    else if (!esPM && !esAM && h <= 7) h += 12; // heurística: hora baja sin contexto = tarde
    return `${String(h).padStart(2, "0")}:30`;
  }

  // Formato HH:MM directo
  const matchHora = lower.match(/(\d{1,2}):(\d{2})/);
  if (matchHora) {
    return `${String(parseInt(matchHora[1])).padStart(2, "0")}:${matchHora[2]}`;
  }

  // Hora sola sin minutos ("a las 9", "a las 3")
  const matchHoraSola = lower.match(/a las (\d{1,2})(?:\s|$)/);
  if (matchHoraSola) {
    const h = parseInt(matchHoraSola[1]);
    // Heurística: si es <= 8 probablemente es PM (tarde)
    // Si es >= 9 probablemente es AM (mañana) — la clínica no abre de madrugada
    const hFinal = h <= 7 ? h + 12 : h;
    return `${String(hFinal).padStart(2, "0")}:00`;
  }

  return null;
}

// ─── FORMATEAR FECHA A ISO (YYYY-MM-DD) ──────────────────────
export function formatearISO(fecha) {
  const y = fecha.getFullYear();
  const m = String(fecha.getMonth() + 1).padStart(2, "0");
  const d = String(fecha.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// ─── FORMATEAR FECHA LEGIBLE ──────────────────────────────────
// "2026-06-23" → "martes 23 de junio de 2026"
export function formatearFechaLegible(fechaISO) {
  const [y, m, d] = fechaISO.split("-").map(Number);
  const fecha = new Date(y, m - 1, d);
  const dia = NOMBRES_DIAS[fecha.getDay()];
  const mes = NOMBRES_MESES[fecha.getMonth()];
  return `${dia} ${d} de ${mes} de ${y}`;
}

// ─── HELPER INTERNO ───────────────────────────────────────────
function construirResultado(fecha, hora) {
  const iso = formatearISO(fecha);
  const dia = NOMBRES_DIAS[fecha.getDay()];
  const mes = NOMBRES_MESES[fecha.getMonth()];
  const d = fecha.getDate();
  const y = fecha.getFullYear();

  return {
    fecha: iso,
    dia,
    hora: hora || null,
    texto: hora
      ? `${dia} ${d} de ${mes} de ${y} a las ${hora}`
      : `${dia} ${d} de ${mes} de ${y}`
  };
}

// ─── ENDPOINT GET /api/fechas (para pruebas) ─────────────────
export async function onRequestGet(context) {
  const { searchParams } = new URL(context.request.url);
  const texto = searchParams.get("texto") || "";
  const token = context.request.headers.get("X-Health-Token") || "";

  if (token !== (context.env.HEALTH_TOKEN || "")) {
    return new Response("Unauthorized", { status: 401 });
  }

  const hoy = obtenerHoy();
  const resuelto = texto ? resolverFechaNatural(texto) : null;

  return Response.json({
    hoy,
    resuelto,
    ejemplos: texto ? undefined : {
      "mañana": resolverFechaNatural("mañana"),
      "próximo lunes": resolverFechaNatural("próximo lunes"),
      "el viernes": resolverFechaNatural("el viernes"),
      "25 de julio": resolverFechaNatural("25 de julio"),
      "lunes a las 3 de la tarde": resolverFechaNatural("lunes a las 3 de la tarde"),
      "mañana a las 9am": resolverFechaNatural("mañana a las 9am")
    }
  });
}
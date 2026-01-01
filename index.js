import { firefox } from "playwright";
import OpenAI from "openai";
import axios from "axios";
import fs from "fs";
import crypto from "crypto";

/* ================= CONFIG ================= */
const GROUP_ID = process.env.GROUP_ID;
let COOKIE = process.env.ROBLOSECURITY;
const WEBHOOK = process.env.DISCORD_WEBHOOK;
const OPENAI_KEY = process.env.OPENAI_API_KEY;

// Responsável fixo no relatório (sempre menciona esse ID)
const RESPONSAVEL_FIXO = "<@1455692969322614895>";
const MOTIVO_FIXO = "Aceppt-all";

// Intervalo de verificação
// ✅ TESTE: 5s
// ✅ PRODUÇÃO: 5 min => set INTERVALO_MS=300000
const INTERVALO_MS = Number(process.env.INTERVALO_MS ?? 5000);

// Regras anti-spam (produção). No modo teste, exila com 1 evento.
const MODO_TESTE = String(process.env.MODO_TESTE ?? "1") === "1";

// Produção (quando MODO_TESTE=0)
const FAST_WINDOW_MS = Number(process.env.FAST_WINDOW_MS ?? 2000);   // 2s
const FAST_COUNT = Number(process.env.FAST_COUNT ?? 3);             // >2 em 2s => 3
const BURST_WINDOW_MS = Number(process.env.BURST_WINDOW_MS ?? 60000); // 60s
const BURST_COUNT = Number(process.env.BURST_COUNT ?? 10);          // 10 em 60s => exila

// Cooldown pra não “exilar mil vezes” o mesmo cara e spammar o Discord
const COOLDOWN_PUNICAO_MS = Number(process.env.COOLDOWN_PUNICAO_MS ?? 30 * 60 * 1000); // 30 min

// Arquivos de screenshot (mantém só anterior + atual)
const IMG_PREV = "audit_prev.png";
const IMG_CURR = "audit_curr.png";

// URL do audit log (configure route costuma ser mais estável)
const AUDIT_URL = `https://www.roblox.com/groups/configure?id=${GROUP_ID}#!/auditLog`;
/* ========================================= */

if (!GROUP_ID || !COOKIE || !WEBHOOK || !OPENAI_KEY) {
  console.error("❌ Faltando env: GROUP_ID / ROBLOSECURITY / DISCORD_WEBHOOK / OPENAI_API_KEY");
  process.exit(1);
}

// sanitiza cookie
COOKIE = COOKIE.trim();
if ((COOKIE.startsWith('"') && COOKIE.endsWith('"')) || (COOKIE.startsWith("'") && COOKIE.endsWith("'"))) {
  COOKIE = COOKIE.slice(1, -1).trim();
}
if (COOKIE.startsWith(".ROBLOSECURITY=")) {
  COOKIE = COOKIE.replace(".ROBLOSECURITY=", "").trim();
}

const openai = new OpenAI({ apiKey: OPENAI_KEY });

// Estado
let running = false;

// browser reusável
let browser = null;
let context = null;
let page = null;

// Dedup e anti-spam
const seenEvents = new Map(); // key -> firstSeenAt
const acoesPorAtor = new Map(); // ator -> [timestamps]
const punidosAte = new Map(); // ator -> lastPunishAt

// Token CSRF para requests Roblox (kick)
let XCSRF = null;

/* ================= HELPERS ================= */
async function enviarDiscord(msg) {
  try {
    await axios.post(WEBHOOK, { content: msg });
  } catch (e) {
    console.error("Erro ao enviar webhook:", e?.message || e);
  }
}

function sha256File(filepath) {
  const buf = fs.readFileSync(filepath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function safeUnlink(p) {
  try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
}

function safeRename(from, to) {
  try {
    if (fs.existsSync(to)) fs.unlinkSync(to);
    fs.renameSync(from, to);
  } catch (e) {
    console.error("Erro ao renomear arquivo:", e?.message || e);
  }
}

function nowBRDate() {
  return new Date().toLocaleDateString("pt-BR");
}

function formatarRelatorioExilio(exilado) {
  // EXATAMENTE no estilo que você pediu (*** ... ***)
  return `***Relatório de Exílio!

Responsável:
${RESPONSAVEL_FIXO}

Exilado(a):
${exilado}

Motivo:
${MOTIVO_FIXO}

Data: ${nowBRDate()}***`;
}

async function validarCookieHTTP() {
  const res = await axios.get("https://users.roblox.com/v1/users/authenticated", {
    headers: { Cookie: `.ROBLOSECURITY=${COOKIE}` },
    validateStatus: () => true
  });

  if (res.status !== 200) return { ok: false, status: res.status, body: res.data };
  return { ok: true, user: res.data };
}

async function closeSilently() {
  try { if (page && !page.isClosed()) await page.close(); } catch {}
  try { if (context) await context.close(); } catch {}
  try { if (browser) await browser.close(); } catch {}
  page = null; context = null; browser = null;
}

async function initBrowser() {
  await closeSilently();

  browser = await firefox.launch({ headless: true });
  context = await browser.newContext({
    viewport: { width: 1280, height: 720 }
  });

  await context.addCookies([{
    name: ".ROBLOSECURITY",
    value: COOKIE,
    domain: ".roblox.com",
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "None"
  }]);

  page = await context.newPage();

  await page.goto("https://www.roblox.com/home", {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });

  // Confirma login via fetch dentro do navegador
  const status = await page.evaluate(async () => {
    const r = await fetch("https://users.roblox.com/v1/users/authenticated", { credentials: "include" });
    return r.status;
  });

  if (status !== 200) {
    try { await page.screenshot({ path: "not_logged.png" }); } catch {}
    await closeSilently();
    throw new Error("Não está logado no Roblox dentro do navegador (cookie inválido/sem permissão).");
  }

  await page.goto(AUDIT_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(1500);
}

/* ========= Roblox HTTP (kick) + CSRF ========= */
async function robloxRequest(method, url, data = null) {
  const headers = {
    Cookie: `.ROBLOSECURITY=${COOKIE}`,
    Accept: "application/json",
    "Content-Type": "application/json"
  };
  if (XCSRF) headers["X-CSRF-TOKEN"] = XCSRF;

  let res = await axios({
    method,
    url,
    data,
    headers,
    validateStatus: () => true
  });

  // Se Roblox pedir CSRF, ele responde 403 e manda o token no header
  const newToken = res?.headers?.["x-csrf-token"];
  if (res.status === 403 && newToken) {
    XCSRF = newToken;

    res = await axios({
      method,
      url,
      data,
      headers: { ...headers, "X-CSRF-TOKEN": XCSRF },
      validateStatus: () => true
    });
  }

  return res;
}

async function getUserIdFromUsername(username) {
  const res = await axios({
    method: "POST",
    url: "https://users.roblox.com/v1/usernames/users",
    data: { usernames: [username], excludeBannedUsers: false },
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    validateStatus: () => true
  });

  if (res.status !== 200) return null;
  const id = res?.data?.data?.[0]?.id;
  return typeof id === "number" ? id : null;
}

async function searchUserId(keyword) {
  const url = `https://users.roblox.com/v1/users/search?keyword=${encodeURIComponent(keyword)}&limit=10`;
  const res = await axios.get(url, { validateStatus: () => true });

  if (res.status !== 200) return null;
  const list = res?.data?.data || [];

  // tenta match exato por username ou displayName (case-insensitive)
  const kw = String(keyword).toLowerCase();
  const exact = list.filter(u =>
    String(u?.name || "").toLowerCase() === kw ||
    String(u?.displayName || "").toLowerCase() === kw
  );

  if (exact.length === 1) return exact[0].id;

  // Se for ambíguo, NÃO escolhe no chute (pra não exilar o errado)
  return null;
}

async function resolveUserId(actorText) {
  // 1) tenta como username direto
  let id = await getUserIdFromUsername(actorText);
  if (id) return id;

  // 2) fallback: busca por keyword (pode bater em displayName)
  id = await searchUserId(actorText);
  if (id) return id;

  return null;
}

async function exilarDoGrupo(userId) {
  const url = `https://groups.roblox.com/v1/groups/${GROUP_ID}/users/${userId}`;
  return await robloxRequest("DELETE", url, null);
}

/* ================= CAPTURA ================= */
async function capturarAudit() {
  if (!page || page.isClosed()) {
    await initBrowser();
  }

  try {
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
  } catch {
    await initBrowser();
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
  }

  await page.waitForTimeout(2000);
  await page.screenshot({ path: IMG_CURR });
}

/* ================= IA (OCR VISUAL) ================= */
async function analisarImagem(filepath) {
  const base64 = fs.readFileSync(filepath).toString("base64");

  const response = await openai.responses.create({
    model: "gpt-4.1-mini",
    max_output_tokens: 400,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text:
`Leia o audit log do grupo Roblox (imagem).

Extraia SOMENTE eventos relacionados a pedidos de entrada (join requests):
- aceitar um pedido
- recusar um pedido
- aceitar todos (accept all)
- recusar todos (decline all)

Retorne UMA linha por evento no formato:
ATOR | TIPO | ALVO | TEMPO

Onde:
- TIPO deve ser exatamente um destes:
  JOIN_ACCEPT, JOIN_DECLINE, ACCEPT_ALL, DECLINE_ALL
- ALVO: username/display name afetado; para ACCEPT_ALL/DECLINE_ALL use "-"
- TEMPO: texto de data/hora exibido (se não existir, use "-")

Se NÃO houver nenhum evento desse tipo visível, responda exatamente:
SEM EVENTOS`
          },
          {
            type: "input_image",
            image_url: `data:image/png;base64,${base64}`
          }
        ]
      }
    ]
  });

  return (response.output_text || "").trim();
}

/* ================= DETECÇÃO ================= */
function pruneSeenEvents(now) {
  // evita crescer infinito (mantém só ~6h)
  const TTL = 6 * 60 * 60 * 1000;
  for (const [k, t] of seenEvents.entries()) {
    if (now - t > TTL) seenEvents.delete(k);
  }
}

function registrarAcao(ator, now) {
  if (!acoesPorAtor.has(ator)) acoesPorAtor.set(ator, []);
  const arr = acoesPorAtor.get(ator);
  arr.push(now);

  // poda pelo maior window que usamos
  const maxWindow = Math.max(FAST_WINDOW_MS, BURST_WINDOW_MS);
  const cut = now - maxWindow;
  while (arr.length && arr[0] < cut) arr.shift();
}

function contarNoWindow(arr, now, windowMs) {
  let c = 0;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (now - arr[i] <= windowMs) c++;
    else break;
  }
  return c;
}

function shouldPunishSpam(ator, now) {
  if (MODO_TESTE) return true;

  const arr = acoesPorAtor.get(ator) || [];
  const fast = contarNoWindow(arr, now, FAST_WINDOW_MS);
  const burst = contarNoWindow(arr, now, BURST_WINDOW_MS);

  if (fast >= FAST_COUNT) return true;
  if (burst >= BURST_COUNT) return true;

  return false;
}

function parseEventos(texto) {
  if (!texto) return [];
  const t = texto.trim();
  if (t === "SEM EVENTOS" || t === "SEM ALTERACOES") return [];

  const linhas = t.split("\n").map(l => l.trim()).filter(Boolean);
  const eventos = [];

  for (const linha of linhas) {
    if (!linha.includes("|")) continue;
    const parts = linha.split("|").map(p => p.trim());
    if (parts.length < 2) continue;

    const ator = parts[0] || "";
    const tipo = (parts[1] || "").toUpperCase();
    const alvo = parts[2] ?? "-";
    const tempo = parts[3] ?? "-";

    if (!ator) continue;
    if (!["JOIN_ACCEPT", "JOIN_DECLINE", "ACCEPT_ALL", "DECLINE_ALL"].includes(tipo)) continue;

    eventos.push({ ator, tipo, alvo, tempo, raw: linha });
  }

  return eventos;
}

/* ================= PUNIÇÃO ================= */
async function punirAtor(ator, motivoTag = "AUTO") {
  const now = Date.now();

  // cooldown por ator pra não spammar
  const last = punidosAte.get(ator);
  if (last && now - last < COOLDOWN_PUNICAO_MS) {
    console.log(`⏳ Cooldown ativo, não punindo novamente: ${ator}`);
    return;
  }

  // resolve userId
  const userId = await resolveUserId(ator);
  if (!userId) {
    console.error(`❌ Não consegui resolver userId para: "${ator}" (pulei para evitar exilar errado)`);
    return;
  }

  // tenta exilar
  const res = await exilarDoGrupo(userId);

  // sucesso comum: 200/204. Às vezes 404 se já não tá no grupo.
  const ok = (res.status >= 200 && res.status < 300) || res.status === 404;

  if (!ok) {
    console.error(`❌ Falha ao exilar ${ator} (id=${userId}) status=${res.status}`, res.data);
    return;
  }

  // marca punido e manda o relatório no formato exato
  punidosAte.set(ator, now);

  const relatorio = formatarRelatorioExilio(ator);
  await enviarDiscord(relatorio);

  console.log(`🚫 EXILADO: ${ator} (id=${userId}) motivo=${motivoTag} status=${res.status}`);
}

/* ================= MONITOR ================= */
async function monitorar() {
  if (running) return;
  running = true;

  try {
    // 1) screenshot atual
    await capturarAudit();

    // 2) compara com anterior (mantém só 2 imagens)
    if (fs.existsSync(IMG_PREV)) {
      const hPrev = sha256File(IMG_PREV);
      const hCurr = sha256File(IMG_CURR);

      if (hPrev === hCurr) {
        // igual => apaga a atual e não gasta OpenAI
        safeUnlink(IMG_CURR);
        return;
      }
    }

    // 3) OCR visual
    const texto = await analisarImagem(IMG_CURR);

    // 4) troca: atual vira anterior (sempre mantém 1 anterior)
    safeRename(IMG_CURR, IMG_PREV);

    // 5) parse + dedupe por evento
    const now = Date.now();
    pruneSeenEvents(now);

    const eventos = parseEventos(texto);
    if (!eventos.length) return;

    // identifica novos eventos (pra não repetir punição por histórico do audit log)
    const novos = [];
    for (const ev of eventos) {
      const key = `${ev.ator}||${ev.tipo}||${ev.alvo}||${ev.tempo}`;
      if (seenEvents.has(key)) continue;
      seenEvents.set(key, now);
      novos.push(ev);
    }

    if (!novos.length) return;

    // 6) processa: accept-all/decline-all = punição imediata
    const acceptAllActors = new Set();
    const spamActors = new Set();

    for (const ev of novos) {
      if (ev.tipo === "ACCEPT_ALL" || ev.tipo === "DECLINE_ALL") {
        acceptAllActors.add(ev.ator);
      } else if (ev.tipo === "JOIN_ACCEPT" || ev.tipo === "JOIN_DECLINE") {
        // conta ação por ator (pra detectar spam)
        registrarAcao(ev.ator, now);

        if (shouldPunishSpam(ev.ator, now)) {
          spamActors.add(ev.ator);
        }
      }
    }

    // prioridade: accept/decline all
    for (const ator of acceptAllActors) {
      await punirAtor(ator, "ALL");
    }

    // depois spam
    for (const ator of spamActors) {
      // evita punir 2x se já puniu por ALL
      if (acceptAllActors.has(ator)) continue;
      await punirAtor(ator, "SPAM");
    }

  } catch (err) {
    const msg = String(err?.message || err);
    console.error("Erro no monitor:", msg);

    if (msg.includes("Não está logado")) {
      await enviarDiscord(
        `⚠️ **BOT NÃO LOGADO NO ROBLOX**\n` +
        `Cookie inválido/expirado ou ROBLOSECURITY errada.\n` +
        `Dica: ROBLOSECURITY deve ser só o valor (sem ".ROBLOSECURITY=" e sem aspas).`
      );
    }

    try { await closeSilently(); } catch {}
  } finally {
    running = false;
  }
}

/* ================= START ================= */
(async () => {
  // Preflight: valida cookie via HTTP (sem Playwright)
  const chk = await validarCookieHTTP();
  if (!chk.ok) {
    await enviarDiscord(
      `❌ **ROBLOSECURITY INVÁLIDO/EXPIRADO** (HTTP ${chk.status})\n` +
      `Atualize o cookie.`
    );
    console.error("Cookie inválido/expirado:", chk.status);
    process.exit(1);
  }

  console.log(`✅ Cookie OK. Logado como: ${chk.user?.name || chk.user?.displayName || chk.user?.id}`);

  // inicia browser
  try {
    await initBrowser();
  } catch (e) {
    await enviarDiscord(
      `❌ **Falha ao logar no navegador**\n` +
      `Provável: cookie inválido no browser / sem permissão de audit log.\n` +
      `Erro: ${String(e?.message || e)}`
    );
    throw e;
  }

  console.log("🛡️ Auditoria visual Roblox ATIVA");
  console.log(`⏱️ INTERVALO_MS=${INTERVALO_MS} | MODO_TESTE=${MODO_TESTE ? "1" : "0"}`);

  setInterval(monitorar, INTERVALO_MS);
})();

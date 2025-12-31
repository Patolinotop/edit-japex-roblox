import axios from "axios";

// ================= CONFIG =================
const GROUP_ID = process.env.GROUP_ID;
const COOKIE = process.env.ROBLOSECURITY;
const WEBHOOK = process.env.DISCORD_WEBHOOK;

const TARGET_USER_ID = process.env.TARGET_USER_ID;
const TARGET_USER_NAME = process.env.TARGET_USER_NAME;

// Critérios (TESTE)
const LIMITE = 1;        // 1 ação (teste)
const JANELA_MS = 2000;  // 2 segundos
const INTERVALO = 1500;
// =========================================

// CSRF
let csrfToken = null;

// Cliente Roblox
const roblox = axios.create({
  headers: {
    Cookie: `.ROBLOSECURITY=${COOKIE}`,
    "Content-Type": "application/json",
    "User-Agent": "Roblox/WinInet",
    "X-Requested-With": "XMLHttpRequest",
    "Referer": "https://www.roblox.com/"
  },
  validateStatus: () => true // IMPORTANTE
});

// ================= FUNÇÕES =================

// Atualiza CSRF token automaticamente
async function refreshCSRF() {
  const res = await roblox.post("https://auth.roblox.com/v2/logout");
  csrfToken = res.headers["x-csrf-token"];
  roblox.defaults.headers["X-CSRF-TOKEN"] = csrfToken;
}

// GET pendentes
async function getPendentes() {
  const res = await roblox.get(
    `https://groups.roblox.com/v1/groups/${GROUP_ID}/join-requests?limit=10`
  );
  return res.data.data.length;
}

// EXILAR (COM CSRF)
async function exilarUsuario(userId) {
  if (!csrfToken) await refreshCSRF();

  const res = await roblox.delete(
    `https://groups.roblox.com/v1/groups/${GROUP_ID}/users/${userId}`
  );

  // Se token expirou, tenta de novo
  if (res.status === 403) {
    await refreshCSRF();
    await roblox.delete(
      `https://groups.roblox.com/v1/groups/${GROUP_ID}/users/${userId}`
    );
  }
}

// Discord
async function enviarRelatorio(motivo) {
  const agora = new Date().toLocaleString("pt-BR");

  const mensagem = `**> 『 RELATÓRIO DE DEMISSÃO 』
> =================================
> ➩ Responsável: <@1455692969322614895>
> ➩ Permissão concedida: <@1331505963622076476>
> =================================
> ➩ Militar rebaixado: ${TARGET_USER_NAME}
> ➩ Motivo: ${motivo}
> =================================
> ➩ Data e hora: ${agora}
> ➩ Comprovações: N/A
> =================================**`;

  await axios.post(WEBHOOK, { content: mensagem });
}

// ================= DETECÇÃO =================
let historicoAceite = [];
let ultimoPendentes = null;

async function monitorar() {
  try {
    const pendentes = await getPendentes();
    const agora = Date.now();

    if (ultimoPendentes !== null && pendentes < ultimoPendentes) {
      historicoAceite.push(agora);
    }

    historicoAceite = historicoAceite.filter(
      t => agora - t <= JANELA_MS
    );

    if (historicoAceite.length >= LIMITE) {
      await exilarUsuario(TARGET_USER_ID);
      await enviarRelatorio("Aceitação em massa suspeita (Accept All)");
      historicoAceite = [];
    }

    ultimoPendentes = pendentes;
  } catch (e) {
    console.error("Erro:", e.response?.status || e.message);
  }
}

// ================= START =================
(async () => {
  await refreshCSRF();
  console.log("🛡️ Anti Accept-All ativo com CSRF");
  setInterval(monitorar, INTERVALO);
})();

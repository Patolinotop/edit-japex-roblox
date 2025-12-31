import axios from "axios";

// ================= CONFIG =================
const GROUP_ID = process.env.GROUP_ID;
const COOKIE = process.env.ROBLOSECURITY;
const WEBHOOK = process.env.DISCORD_WEBHOOK;

// Usuário que será exilado quando o sistema detectar abuso
const TARGET_USER_ID = process.env.TARGET_USER_ID;
const TARGET_USER_NAME = process.env.TARGET_USER_NAME;

// Critérios
const LIMITE = 1;        // 4 ações
const JANELA_MS = 2000;  // em até 2 segundos
const INTERVALO = 1500;  // intervalo de checagem
// =========================================

// Cliente Roblox COM HEADERS (OBRIGATÓRIO)
const roblox = axios.create({
  headers: {
    Cookie: `.ROBLOSECURITY=${COOKIE}`,
    "Content-Type": "application/json",
    "User-Agent": "Roblox/WinInet",
    "X-Requested-With": "XMLHttpRequest",
    "Referer": "https://www.roblox.com/"
  }
});

// Estado
let historicoAceite = [];
let historicoRecusa = [];
let ultimoPendentes = null;

// ================= FUNÇÕES =================

// Ver quantos pedidos pendentes existem
async function getPendentes() {
  const { data } = await roblox.get(
    `https://groups.roblox.com/v1/groups/${GROUP_ID}/join-requests?limit=10`
  );
  return data.data.length;
}

// Exilar usuário do grupo
async function exilarUsuario(userId) {
  await roblox.delete(
    `https://groups.roblox.com/v1/groups/${GROUP_ID}/users/${userId}`
  );
}

// Enviar relatório no Discord (COM >)
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
async function monitorar() {
  try {
    const pendentes = await getPendentes();
    const agora = Date.now();

    if (ultimoPendentes !== null) {
      // ACEITES (pendentes diminuíram)
      if (pendentes < ultimoPendentes) {
        historicoAceite.push(agora);
      }

      // RECUSAS (pendentes aumentaram)
      if (pendentes > ultimoPendentes) {
        historicoRecusa.push(agora);
      }

      // Limpa histórico fora da janela
      historicoAceite = historicoAceite.filter(
        t => agora - t <= JANELA_MS
      );
      historicoRecusa = historicoRecusa.filter(
        t => agora - t <= JANELA_MS
      );

      // Detecta ACEITAÇÃO em massa
      if (historicoAceite.length >= LIMITE) {
        await exilarUsuario(TARGET_USER_ID);
        await enviarRelatorio(
          "Aceitação em massa suspeita (Accept All)"
        );
        historicoAceite = [];
      }

      // Detecta RECUSA em massa
      if (historicoRecusa.length >= LIMITE) {
        await exilarUsuario(TARGET_USER_ID);
        await enviarRelatorio(
          "Recusa em massa suspeita (Decline All)"
        );
        historicoRecusa = [];
      }
    }

    ultimoPendentes = pendentes;
  } catch (err) {
    console.error(
      "Erro:",
      err.response?.status || err.message
    );
  }
}

// ================= TESTE DE AUTH (RODA 1 VEZ) =================
async function testeAuth() {
  try {
    const { data } = await roblox.get(
      "https://users.roblox.com/v1/users/authenticated"
    );
    console.log("✅ Logado como:", data.name);
  } catch (e) {
    console.error(
      "❌ AUTH FALHOU:",
      e.response?.status
    );
  }
}

testeAuth();

// ================= LOOP =================
console.log("🛡️ Anti Accept/Decline All ATIVO");
setInterval(monitorar, INTERVALO);

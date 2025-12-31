import axios from "axios";

// ================= CONFIG =================
const GROUP_ID = process.env.GROUP_ID;
const COOKIE = process.env.ROBLOSECURITY;
const WEBHOOK = process.env.DISCORD_WEBHOOK;

const TARGET_USER_ID = process.env.TARGET_USER_ID;
const TARGET_USER_NAME = process.env.TARGET_USER_NAME;

// Critérios
const LIMITE = 1;          // 4 ações
const JANELA_MS = 2000;    // em até 2 segundos
const INTERVALO = 1500;    // checagem
// =========================================

// Cliente Roblox
const roblox = axios.create({
  headers: {
    Cookie: `.ROBLOSECURITY=${COOKIE}`,
    "Content-Type": "application/json"
  }
});

// Estado
let historicoAceite = [];
let historicoRecusa = [];
let ultimoPendentes = null;

// ================= FUNÇÕES =================
async function getPendentes() {
  const { data } = await roblox.get(
    `https://groups.roblox.com/v1/groups/${GROUP_ID}/join-requests?limit=10`
  );
  return data.data.length;
}

async function exilarUsuario(userId) {
  await roblox.delete(
    `https://groups.roblox.com/v1/groups/${GROUP_ID}/users/${userId}`
  );
}

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

    if (ultimoPendentes !== null) {
      const agora = Date.now();

      // ACEITES
      if (pendentes < ultimoPendentes) {
        historicoAceite.push(agora);
      }

      // RECUSAS
      if (pendentes > ultimoPendentes) {
        historicoRecusa.push(agora);
      }

      // Limpa histórico fora da janela
      historicoAceite = historicoAceite.filter(t => agora - t <= JANELA_MS);
      historicoRecusa = historicoRecusa.filter(t => agora - t <= JANELA_MS);

      // Verificação
      if (historicoAceite.length >= LIMITE) {
        await exilarUsuario(TARGET_USER_ID);
        await enviarRelatorio("Aceitação em massa suspeita (Accept All)");
        historicoAceite = [];
      }

      if (historicoRecusa.length >= LIMITE) {
        await exilarUsuario(TARGET_USER_ID);
        await enviarRelatorio("Recusa em massa suspeita (Decline All)");
        historicoRecusa = [];
      }
    }

    ultimoPendentes = pendentes;
  } catch (err) {
    console.error("Erro:", err.message);
  }
}

// ================= LOOP =================
console.log("🛡️ Anti-Accept/Decline-All ativo");
setInterval(monitorar, INTERVALO);

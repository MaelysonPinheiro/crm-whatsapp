import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import express from 'express';
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const db = require('./database');

const app = express();
const PORT = 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Variáveis globais de estado da conexão
let sock = null;
let qrCodeDataURL = '';
let statusConexao = 'desconectado'; // 'desconectado', 'gerando_qr', 'conectado'

// ==========================================
// 1. CONEXÃO WHATSAPP (BAILEYS)
// ==========================================
async function conectarWhatsApp() {
    statusConexao = 'gerando_qr';
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrCodeDataURL = await QRCode.toDataURL(qr);
            statusConexao = 'gerando_qr';
            console.log('⚡ Novo QR Code gerado. Acesse o painel web para escanear.');
        }

        if (connection === 'open') {
            statusConexao = 'conectado';
            qrCodeDataURL = '';
            console.log('🚀 WhatsApp conectado com sucesso!');
        }

        if (connection === 'close') {
            const deveReconectar = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            statusConexao = 'desconectado';
            console.log('🔌 Conexão fechada. Tentando reconectar...', deveReconectar);
            if (deveReconectar) {
                conectarWhatsApp();
            }
        }
    });

    // Escutando mensagens do WhatsApp
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message) return;

        const remetente = msg.key.remoteJid;

        // Ignora mensagens que não são de conversas privadas (ex: grupos)
        if (!remetente || !remetente.endsWith('@s.whatsapp.net')) return;

        const textoMensagem = msg.message.conversation || msg.message.extendedTextMessage?.text;
        const euFuiQueMandei = msg.key.fromMe;

        // Se a mensagem veio do próprio bot/empresa
        if (euFuiQueMandei) {
            db.get(
                `SELECT a.*, c.nome as consultor_nome FROM atendimentos a 
                 LEFT JOIN consultores c ON a.consultor_id = c.id 
                 WHERE a.cliente_telefone = ? AND a.status = 'aguardando'`,
                [remetente],
                async (err, atendimento) => {
                    if (atendimento) {
                        db.run(`UPDATE atendimentos SET status = 'em_atendimento' WHERE id = ?`, [atendimento.id]);
                        console.log(`✅ Atendimento de ${remetente} alterado para em_atendimento.`);
                    }
                }
            );
            return;
        }

        // Cliente mandou mensagem
        const clienteTelefone = remetente;
        const nomeCliente = msg.pushName || 'cliente';

        db.get(
            `SELECT * FROM atendimentos WHERE cliente_telefone = ? AND status != 'finalizado'`,
            [clienteTelefone],
            async (err, atendimento) => {
                if (err) return;

                if (!atendimento) {
                    // === LÓGICA ROUND-ROBIN (REVEZAMENTO JUSTO) ===
                    const queryRoundRobin = `
                        SELECT c.* FROM consultores c 
                        LEFT JOIN atendimentos a ON a.consultor_id = c.id 
                        WHERE c.ativo = 1 
                        GROUP BY c.id 
                        ORDER BY MAX(a.id) ASC, c.id ASC 
                        LIMIT 1
                    `;

                    db.get(queryRoundRobin, [], async (err, consultor) => {
                        const consultorId = consultor ? consultor.id : null;
                        const consultorNome = consultor ? consultor.nome : 'Sem consultor';

                        // Define limite de tempo: agora + 5 minutos
                        const limiteTempo = new Date(Date.now() + 5 * 60 * 1000).toISOString();

                        db.run(
                            `INSERT INTO atendimentos (cliente_telefone, consultor_id, status, limite_tempo) VALUES (?, ?, 'aguardando', ?)`,
                            [clienteTelefone, consultorId, limiteTempo],
                            async function (err) {
                                if (err) return;

                                // Resposta automática de boas-vindas
                                const mensagemSaudacao = `Olá, *${nomeCliente}*! Seja bem-vindo(a) à nossa empresa. 👋\n\nAguarde só um instante, já estamos te direcionando para um de nossos consultores!`;
                                await sock.sendMessage(clienteTelefone, { text: mensagemSaudacao });

                                console.log(`✨ Novo atendimento registrado para ${nomeCliente} (${clienteTelefone}) com o consultor ${consultorNome} [Round-Robin].`);
                            }
                        );
                    });
                }
            }
        );
    });
}

conectarWhatsApp();

// ==========================================
// 2. CRONJOB / VERIFICADOR DE TIMEOUT (CADA 10S)
// ==========================================
setInterval(() => {
    const agoraIso = new Date().toISOString();

    db.all(
        `SELECT a.*, c.nome as consultor_nome FROM atendimentos a 
         LEFT JOIN consultores c ON a.consultor_id = c.id 
         WHERE a.status = 'aguardando' AND a.limite_tempo IS NOT NULL AND a.limite_tempo <= ?`,
        [agoraIso],
        (err, expirados) => {
            if (err || !expirados || expirados.length === 0) return;

            expirados.forEach(atendimento => {
                console.log(`⏰ Tempo de 5 minutos esgotado para o atendimento #${atendimento.id}. Reatribuindo...`);

                const queryProximo = `
                    SELECT c.* FROM consultores c 
                    LEFT JOIN atendimentos a ON a.consultor_id = c.id 
                    WHERE c.ativo = 1 AND c.id != ? 
                    GROUP BY c.id 
                    ORDER BY MAX(a.id) ASC, c.id ASC 
                    LIMIT 1
                `;

                db.get(queryProximo, [atendimento.consultor_id || 0], (err, novoConsultor) => {
                    const novoConsultorId = novoConsultor ? novoConsultor.id : atendimento.consultor_id;
                    const novoLimite = new Date(Date.now() + 5 * 60 * 1000).toISOString();

                    db.run(
                        `UPDATE atendimentos SET consultor_id = ?, limite_tempo = ? WHERE id = ?`,
                        [novoConsultorId, novoLimite, atendimento.id],
                        (err) => {
                            if (!err) {
                                console.log(`🔄 Atendimento #${atendimento.id} reatribuído com sucesso.`);
                            }
                        }
                    );
                });
            });
        }
    );
}, 10000);

// ==========================================
// 3. ROTAS DA INTERFACE WEB (EXPRESS)
// ==========================================

app.get('/', (req, res) => {
    db.all(`SELECT * FROM consultores`, [], (err, consultores) => {
        if (err) return res.status(500).send('Erro ao buscar consultores');

        const queryAtendimentos = `
            SELECT a.id, a.cliente_telefone, a.status, a.limite_tempo, c.nome as consultor_nome 
            FROM atendimentos a 
            LEFT JOIN consultores c ON a.consultor_id = c.id 
            WHERE a.status != 'finalizado'
            ORDER BY a.id DESC
        `;

        db.all(queryAtendimentos, [], (err, atendimentos) => {
            if (err) return res.status(500).send('Erro ao buscar atendimentos');

            let tabelaConsultores = consultores.map(c => `
                <tr class="border-b border-gray-100 dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition">
                    <td class="py-3 px-4 font-mono text-xs text-gray-500">#${c.id}</td>
                    <td class="py-3 px-4 font-medium text-gray-800 dark:text-gray-200">${c.nome}</td>
                    <td class="py-3 px-4 text-gray-600 dark:text-gray-400 font-mono text-xs">${c.telefone}</td>
                    <td class="py-3 px-4">
                        <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${c.ativo ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400' : 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400'}">
                            <span class="w-1.5 h-1.5 rounded-full ${c.ativo ? 'bg-emerald-500' : 'bg-amber-500'}"></span>
                            ${c.ativo ? 'Online' : 'Em Pausa'}
                        </span>
                    </td>
                    <td class="py-3 px-4 text-right flex justify-end gap-1">
                        <form action="/alternar-status-consultor" method="POST" class="inline">
                            <input type="hidden" name="id" value="${c.id}">
                            <input type="hidden" name="novo_status" value="${c.ativo ? 0 : 1}">
                            <button type="submit" class="text-xs px-2.5 py-1 rounded bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300 transition">
                                ${c.ativo ? 'Pausar' : 'Ativar'}
                            </button>
                        </form>

                        <form action="/deletar-consultor" method="POST" class="inline" onsubmit="return confirm('Tem certeza que deseja excluir o vendedor ${c.nome}?');">
                            <input type="hidden" name="id" value="${c.id}">
                            <button type="submit" class="text-xs px-2.5 py-1 rounded bg-red-100 dark:bg-red-900/30 hover:bg-red-200 text-red-700 dark:text-red-400 transition">
                                🗑️ Excluir
                            </button>
                        </form>
                    </td>
                </tr>
            `).join('');

            let cardsAtendimentos = atendimentos.map(a => `
                <div class="bg-white dark:bg-gray-800 rounded-xl p-5 border border-gray-200/80 dark:border-gray-700 shadow-sm hover:shadow-md transition">
                    <div class="flex items-center justify-between mb-3">
                        <div class="flex items-center gap-2">
                            <div class="w-8 h-8 rounded-full bg-emerald-100 dark:bg-emerald-900/40 text-emerald-600 dark:text-emerald-400 flex items-center justify-center font-bold text-sm">
                                📱
                            </div>
                            <div>
                                <h4 class="font-bold text-gray-800 dark:text-gray-100 font-mono text-sm">${a.cliente_telefone.split('@')[0]}</h4>
                                <p class="text-xs text-gray-500 dark:text-gray-400">Responsável: <span class="font-medium text-gray-700 dark:text-gray-300">${a.consultor_nome || 'Nenhum'}</span></p>
                            </div>
                        </div>
                        <div class="flex flex-col items-end gap-1">
                            <span class="px-2.5 py-1 text-xs font-semibold rounded-full ${a.status === 'aguardando' ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400' : 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400'}">
                                ${a.status === 'aguardando' ? '⏳ Aguardando' : '💬 Em Atendimento'}
                            </span>
                            ${a.status === 'aguardando' && a.limite_tempo ? `
                                <span class="text-[11px] font-mono text-amber-600 dark:text-amber-400 font-bold" data-limite="${a.limite_tempo}">
                                    ⏱️ Calculando...
                                </span>
                            ` : ''}
                        </div>
                    </div>

                    <!-- RESPOSTAS RÁPIDAS -->
                    <div class="mb-3 flex flex-wrap gap-1.5">
                        <button onclick="preencherEEnviar('${a.cliente_telefone}', '⏳ Aguarde só um instante, por favor!')" class="text-[11px] bg-gray-100 dark:bg-gray-700 hover:bg-emerald-50 dark:hover:bg-emerald-900/30 hover:text-emerald-600 text-gray-600 dark:text-gray-300 px-2 py-1 rounded transition">
                            ⏳ Aguarde um instante
                        </button>
                        <button onclick="preencherEEnviar('${a.cliente_telefone}', '📍 Nosso endereço: Av. Principal, N 100.')" class="text-[11px] bg-gray-100 dark:bg-gray-700 hover:bg-emerald-50 dark:hover:bg-emerald-900/30 hover:text-emerald-600 text-gray-600 dark:text-gray-300 px-2 py-1 rounded transition">
                            📍 Localização
                        </button>
                        <button onclick="preencherEEnviar('${a.cliente_telefone}', '💳 Chave PIX CNPJ: 00.000.000/0001-00')" class="text-[11px] bg-gray-100 dark:bg-gray-700 hover:bg-emerald-50 dark:hover:bg-emerald-900/30 hover:text-emerald-600 text-gray-600 dark:text-gray-300 px-2 py-1 rounded transition">
                            💳 Chave PIX
                        </button>
                    </div>

                    <!-- CAMPO DE MENSAGEM -->
                    <form action="/enviar-mensagem-web" method="POST" class="flex gap-2 mb-3">
                        <input type="hidden" name="cliente_telefone" value="${a.cliente_telefone}">
                        <input type="text" id="input-${a.cliente_telefone}" name="mensagem" placeholder="Digite sua resposta..." required class="flex-1 px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500">
                        <button type="submit" class="bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-2 rounded-lg font-bold text-sm transition">
                            🚀
                        </button>
                    </form>

                    <!-- AÇÕES DO ATENDIMENTO -->
                    <div class="pt-2 border-t border-gray-100 dark:border-gray-700 flex justify-end">
                        <form action="/finalizar-atendimento" method="POST">
                            <input type="hidden" name="id" value="${a.id}">
                            <button type="submit" class="text-xs bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-900/40 px-3 py-1.5 rounded-lg font-semibold transition flex items-center gap-1">
                                ✅ Finalizar Atendimento
                            </button>
                        </form>
                    </div>
                </div>
            `).join('');

            let badgeStatus = '';
            if (statusConexao === 'conectado') {
                badgeStatus = `<span class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold bg-emerald-500 text-white cursor-pointer" onclick="abrirModalQR()">🟢 Conectado ao WhatsApp</span>`;
            } else if (statusConexao === 'gerando_qr') {
                badgeStatus = `<span class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold bg-amber-500 text-white cursor-pointer animate-pulse" onclick="abrirModalQR()">⚡ Escanear QR Code</span>`;
            } else {
                badgeStatus = `<span class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold bg-red-500 text-white cursor-pointer" onclick="abrirModalQR()">🔴 Desconectado</span>`;
            }

            res.send(`
                <!DOCTYPE html>
                <html lang="pt-br" class="dark">
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>CRM WhatsApp - Painel da Fila</title>
                    <script src="https://cdn.tailwindcss.com"></script>
                    <script>
                        tailwind.config = { darkMode: 'class' }
                    </script>
                </head>
                <body class="bg-gray-100 dark:bg-gray-900 text-gray-800 dark:text-gray-200 min-h-screen transition-colors duration-200">
                    
                    <header class="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 sticky top-0 z-10">
                        <div class="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
                            <div class="flex items-center gap-3">
                                <div class="w-10 h-10 rounded-xl bg-emerald-600 text-white flex items-center justify-center font-black text-xl shadow-lg shadow-emerald-600/30">
                                    K
                                </div>
                                <div>
                                    <h1 class="font-bold text-lg text-gray-900 dark:text-white leading-none">CRM WhatsApp</h1>
                                    <p class="text-xs text-gray-500 dark:text-gray-400 mt-1">Gestão de Fila & Atendimento Interno</p>
                                </div>
                            </div>
                            <div class="flex items-center gap-4">
                                ${badgeStatus}
                                <button onclick="document.documentElement.classList.toggle('dark')" class="p-2 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 transition">
                                    🌙 / ☀️
                                </button>
                            </div>
                        </div>
                    </header>

                    <main class="max-w-7xl mx-auto px-6 py-8 grid grid-cols-1 lg:grid-cols-12 gap-8">
                        
                        <section class="lg:col-span-5 space-y-6">
                            <div class="bg-white dark:bg-gray-800 rounded-2xl p-6 border border-gray-200 dark:border-gray-700 shadow-sm">
                                <h2 class="text-base font-bold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
                                    👤 Cadastrar Novo Vendedor
                                </h2>
                                <form action="/cadastrar-consultor" method="POST" class="space-y-3">
                                    <div>
                                        <label class="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-1">Nome do Vendedor</label>
                                        <input type="text" name="nome" placeholder="Ex: João Silva" required class="w-full px-3.5 py-2 text-sm border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg focus:ring-2 focus:ring-emerald-500 focus:outline-none">
                                    </div>
                                    <div>
                                        <label class="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-1">Telefone (DDD + Numero)</label>
                                        <input type="text" name="telefone" placeholder="Ex: 5561999999999" required class="w-full px-3.5 py-2 text-sm border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg focus:ring-2 focus:ring-emerald-500 focus:outline-none">
                                    </div>
                                    <button type="submit" class="w-full py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-sm rounded-lg shadow-md shadow-emerald-600/20 transition">
                                        Salvar Vendedor
                                    </button>
                                </form>
                            </div>

                            <div class="bg-white dark:bg-gray-800 rounded-2xl p-6 border border-gray-200 dark:border-gray-700 shadow-sm">
                                <h3 class="text-base font-bold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
                                    👥 Vendedores Cadastrados
                                </h3>
                                <div class="overflow-x-auto">
                                    <table class="w-full text-left border-collapse">
                                        <thead>
                                            <tr class="border-b border-gray-200 dark:border-gray-700 text-xs text-gray-400 uppercase">
                                                <th class="py-2 px-4">ID</th>
                                                <th class="py-2 px-4">Nome</th>
                                                <th class="py-2 px-4">Telefone</th>
                                                <th class="py-2 px-4">Status</th>
                                                <th class="py-2 px-4 text-right">Ação</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            ${tabelaConsultores || '<tr><td colspan="5" class="py-4 text-center text-sm text-gray-400">Nenhum vendedor cadastrado.</td></tr>'}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        </section>

                        <section class="lg:col-span-7 space-y-4">
                            <div class="flex items-center justify-between">
                                <h2 class="text-lg font-bold text-gray-900 dark:text-white flex items-center gap-2">
                                    📥 Fila de Atendimento ao Vivo
                                </h2>
                                <span class="text-xs bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-400 px-3 py-1 rounded-full font-bold">
                                    ${atendimentos.length} em aberto
                                </span>
                            </div>

                            <div class="space-y-4">
                                ${cardsAtendimentos || `
                                    <div class="bg-white dark:bg-gray-800 rounded-2xl p-8 border border-gray-200 dark:border-gray-700 text-center">
                                        <p class="text-4xl mb-2">🎉</p>
                                        <p class="font-bold text-gray-700 dark:text-gray-300">Fila limpa!</p>
                                        <p class="text-xs text-gray-400 mt-1">Nenhum cliente aguardando atendimento no momento.</p>
                                    </div>
                                `}
                            </div>
                        </section>
                    </main>

                    <!-- MODAL DO QR CODE -->
                    <div id="modalQR" class="fixed inset-0 bg-black/60 backdrop-blur-sm hidden items-center justify-center z-50 p-4">
                        <div class="bg-white dark:bg-gray-800 rounded-2xl max-w-sm w-full p-6 text-center shadow-2xl border border-gray-200 dark:border-gray-700">
                            <h3 class="text-lg font-bold text-gray-900 dark:text-white mb-2">Conexão do WhatsApp</h3>
                            <p class="text-xs text-gray-500 dark:text-gray-400 mb-4">Escaneie o QR Code abaixo pelo WhatsApp da empresa.</p>
                            
                            <div class="bg-gray-50 dark:bg-gray-700 p-4 rounded-xl flex items-center justify-center min-h-[220px] mb-4 border border-gray-200 dark:border-gray-600">
                                ${statusConexao === 'conectado' ? `
                                    <div class="text-center">
                                        <p class="text-4xl mb-2">✅</p>
                                        <p class="font-bold text-emerald-600 dark:text-emerald-400">Dispositivo Pareado!</p>
                                        <p class="text-xs text-gray-400 mt-1">Pronto para enviar e receber mensagens.</p>
                                    </div>
                                ` : qrCodeDataURL ? `
                                    <img src="${qrCodeDataURL}" alt="QR Code WhatsApp" class="w-52 h-52 rounded-lg shadow-sm">
                                ` : `
                                    <div class="text-center">
                                        <p class="text-2xl animate-spin mb-2">⚙️</p>
                                        <p class="text-xs text-gray-400">Iniciando serviço...</p>
                                    </div>
                                `}
                            </div>

                            <div class="flex gap-2">
                                ${statusConexao === 'conectado' ? `
                                    <form action="/desconectar-whatsapp" method="POST" class="w-full">
                                        <button type="submit" class="w-full py-2 bg-red-600 hover:bg-red-700 text-white text-xs font-bold rounded-lg transition">
                                            🔴 Desconectar WhatsApp
                                        </button>
                                    </form>
                                ` : ''}
                                <button onclick="fecharModalQR()" class="w-full py-2 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 text-gray-700 dark:text-gray-300 text-xs font-bold rounded-lg transition">
                                    Fechar
                                </button>
                            </div>
                        </div>
                    </div>

                    <script>
                        function abrirModalQR() {
                            document.getElementById('modalQR').classList.remove('hidden');
                            document.getElementById('modalQR').classList.add('flex');
                        }
                        function fecharModalQR() {
                            document.getElementById('modalQR').classList.add('hidden');
                            document.getElementById('modalQR').classList.remove('flex');
                        }
                        function preencherEEnviar(telefone, texto) {
                            const input = document.getElementById('input-' + telefone);
                            if (input) {
                                input.value = texto;
                                input.form.submit();
                            }
                        }

                        // Contagem Regressiva em tempo real nos cards
                        function atualizarTimers() {
                            const elementosTimer = document.querySelectorAll('[data-limite]');
                            elementosTimer.forEach(el => {
                                const limiteIso = el.getAttribute('data-limite');
                                const limiteData = new Date(limiteIso).getTime();
                                const agora = new Date().getTime();
                                const diferenca = limiteData - agora;

                                if (diferenca <= 0) {
                                    el.innerHTML = '⏱️ <span class="text-red-500 font-bold">Tempo Esgotado! Reatribuindo...</span>';
                                } else {
                                    const minutos = Math.floor((diferenca % (1000 * 60 * 60)) / (1000 * 60));
                                    const segundos = Math.floor((diferenca % (1000 * 60)) / 1000);
                                    el.innerHTML = \`⏱️ \${minutos.toString().padStart(2, '0')}:\${segundos.toString().padStart(2, '0')}\`;
                                }
                            });
                        }

                        setInterval(atualizarTimers, 1000);
                        atualizarTimers();

                        // Auto-Refresh da página a cada 5 segundos (Pausa se o modal do QR estiver aberto)
                        setInterval(() => {
                            const modalQR = document.getElementById('modalQR');
                            if (modalQR && modalQR.classList.contains('flex')) return;
                            window.location.reload();
                        }, 5000);
                    </script>
                </body>
                </html>
            `);
        });
    });
});

app.post('/cadastrar-consultor', (req, res) => {
    const { nome, telefone } = req.body;
    db.run(`INSERT INTO consultores (nome, telefone) VALUES (?, ?)`, [nome, telefone], (err) => {
        if (err) console.error(err.message);
        res.redirect('/');
    });
});

app.post('/alternar-status-consultor', (req, res) => {
    const { id, novo_status } = req.body;
    db.run(`UPDATE consultores SET ativo = ? WHERE id = ?`, [novo_status, id], (err) => {
        if (err) console.error(err.message);
        res.redirect('/');
    });
});

// EXCLUIR VENDEDOR
app.post('/deletar-consultor', (req, res) => {
    const { id } = req.body;
    db.run(`UPDATE atendimentos SET consultor_id = NULL WHERE consultor_id = ? AND status != 'finalizado'`, [id], (err) => {
        if (err) console.error(err.message);
        db.run(`DELETE FROM consultores WHERE id = ?`, [id], (err) => {
            if (err) console.error(err.message);
            res.redirect('/');
        });
    });
});

app.post('/enviar-mensagem-web', async (req, res) => {
    const { cliente_telefone, mensagem } = req.body;

    if (sock && statusConexao === 'conectado') {
        try {
            await sock.sendMessage(cliente_telefone, { text: mensagem });
            db.run(`UPDATE atendimentos SET status = 'em_atendimento' WHERE cliente_telefone = ? AND status = 'aguardando'`, [cliente_telefone]);
            console.log(`📤 Mensagem enviada pelo painel para ${cliente_telefone}: "${mensagem}"`);
        } catch (error) {
            console.error('Erro ao enviar mensagem:', error.message);
        }
    } else {
        console.log('⚠️ WhatsApp não está conectado.');
    }

    res.redirect('/');
});

app.post('/finalizar-atendimento', (req, res) => {
    const { id } = req.body;
    db.run(`UPDATE atendimentos SET status = 'finalizado' WHERE id = ?`, [id], (err) => {
        if (err) console.error(err.message);
        res.redirect('/');
    });
});

app.post('/desconectar-whatsapp', async (req, res) => {
    if (sock) {
        try {
            await sock.logout();
        } catch (e) {
            console.log('Sessão encerrada.');
        }
    }

    const authFolder = path.join(__dirname, 'auth_info_baileys');
    if (fs.existsSync(authFolder)) {
        fs.rmSync(authFolder, { recursive: true, force: true });
        console.log('🗑️ Credenciais removidas.');
    }

    statusConexao = 'desconectado';
    qrCodeDataURL = '';

    setTimeout(() => {
        conectarWhatsApp();
    }, 2000);

    res.redirect('/');
});

// Excluir Vendedor
app.post('/deletar-consultor', (req, res) => {
    const { id } = req.body;
    
    // Opcional: Atualiza os atendimentos ativos dele para ficarem sem consultor antes de deletar
    db.run(`UPDATE atendimentos SET consultor_id = NULL WHERE consultor_id = ? AND status != 'finalizado'`, [id], (err) => {
        if (err) console.error(err.message);
        
        // Deleta o consultor da tabela
        db.run(`DELETE FROM consultores WHERE id = ?`, [id], (err) => {
            if (err) console.error(err.message);
            res.redirect('/');
        });
    });
});

app.listen(PORT, () => {
    console.log(`🌐 Servidor CRM rodando em: http://localhost:${PORT}`);
});
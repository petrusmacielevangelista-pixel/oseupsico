/* ============================================================
   O SEU PSICO — Worker principal
   Rotas:
     /auth, /callback              → OAuth GitHub (Decap CMS)
     POST /api/psicologos/cadastro → cadastro de psicólogo (com foto)
     POST /api/psicologos/login    → login do psicólogo
     GET  /api/psicologos/me       → dados do próprio psicólogo (autenticado)
     PUT  /api/psicologos/me       → edita o próprio perfil (autenticado)
     GET  /api/psicologos          → lista pública (aprovados + licença ativa)
     GET  /api/psicologos/:id      → perfil público
     POST /api/psicologos/:id/avaliacoes      → envia avaliação (pública)
     GET  /api/psicologos/:id/avaliacoes      → lista avaliações publicadas
     GET  /api/avaliacoes/confirmar           → confirma e-mail, publica avaliação
     POST /api/admin/login                    → autenticação admin
     GET  /api/admin/psicologos               → lista completa (protegido)
     POST /api/admin/psicologos/:id/aprovar   → aprova/rejeita cadastro (protegido)
     POST /api/admin/psicologos/:id/licenca   → gerencia licença (protegido)
     DELETE /api/admin/avaliacoes/:id         → remove avaliação (protegido)
     GET  /api/admin/campanhas-email          → histórico de disparos (protegido)
     GET/POST/PUT/DELETE /api/psicologos/me/servicos → valores/serviços (autenticado)
     GET/POST/DELETE /api/psicologos/me/certificados → galeria de diplomas (autenticado)
     GET/POST/DELETE /api/psicologos/me/galeria → fotos e vídeos do perfil (autenticado)
     GET  /api/admin/campanhas-email/destinatarios → conta público-alvo (protegido)
     POST /api/admin/campanhas-email/preview  → renderiza HTML sem enviar (protegido)
     POST /api/admin/campanhas-email/imagem   → upload de imagem pro corpo do e-mail (protegido)
     POST /api/admin/campanhas-email/enviar   → dispara campanha (protegido)
   ============================================================ */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

/* ── Banco de dados ── */
// initDB roda ~10 comandos SQL sequenciais (criação de tabelas, migração,
// catálogo inicial). Medido: ~1.3s toda vez que executa por completo —
// cada instrução paga round-trip real de rede no D1, mesmo sendo
// "IF NOT EXISTS" e virando no-op. A memoização em memória (variável de
// módulo) não ajuda aqui porque o Workers não garante reaproveitar a
// mesma instância entre requisições nesse volume de tráfego — cada
// chamada mediu "nunca inicializada" mesmo em sequência imediata.
// Solução: 1 consulta rápida (~130ms) pra checar se a tabela principal já
// existe; só roda a criação completa na it primeira vez de verdade.
let dbInicializada = false;

async function initDB(db) {
  if (dbInicializada) return;

  const { results: tabelaExiste } = await db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='psicologos'`
  ).all();
  if (tabelaExiste.length > 0) {
    dbInicializada = true;
    return;
  }

  await db.prepare(
    `CREATE TABLE IF NOT EXISTS psicologos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      senha_hash TEXT NOT NULL,
      telefone TEXT,
      foto_url TEXT,
      cpf TEXT,
      rg TEXT,
      crp_numero TEXT NOT NULL,
      crp_estado TEXT NOT NULL,
      bio TEXT,
      graduacao_curso TEXT,
      graduacao_instituicao TEXT,
      graduacao_ano INTEGER,
      graduacao_mes_ano TEXT,
      pos_graduacoes TEXT,
      especialidades TEXT,
      abordagens TEXT,
      abordagem TEXT,
      projetos_relevantes TEXT,
      experiencias TEXT,
      anos_experiencia INTEGER,
      status_aprovacao TEXT NOT NULL DEFAULT 'pendente',
      licenca_status TEXT NOT NULL DEFAULT 'inativa',
      licenca_validade_ate TEXT,
      licenca_valor_mensal REAL,
      licenca_observacoes TEXT,
      hora_notificacao_diaria TEXT DEFAULT '18:00',
      receber_agenda_email INTEGER DEFAULT 0,
      horario_trabalho_inicio TEXT DEFAULT '08:00',
      horario_trabalho_fim TEXT DEFAULT '22:00',
      horario_trabalho_dias TEXT DEFAULT '[1,2,3,4,5,6]',
      video_apresentacao_url TEXT,
      idiomas TEXT,
      instagram TEXT,
      site_pessoal TEXT,
      atende_adultos INTEGER DEFAULT 1,
      atende_adolescentes INTEGER DEFAULT 0,
      atende_criancas INTEGER DEFAULT 0,
      atende_idosos INTEGER DEFAULT 0,
      idade_minima_criancas INTEGER,
      atende_presencial INTEGER DEFAULT 0,
      endereco_presencial TEXT,
      criado_em TEXT DEFAULT (datetime('now')),
      aprovado_em TEXT
    )`
  ).run();

  await db.prepare(
    `CREATE TABLE IF NOT EXISTS licenca_historico (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      psicologo_id INTEGER NOT NULL,
      acao TEXT NOT NULL,
      dias_adicionados INTEGER,
      validade_anterior TEXT,
      validade_nova TEXT,
      observacao TEXT,
      criado_em TEXT DEFAULT (datetime('now'))
    )`
  ).run();

  await db.prepare(
    `CREATE TABLE IF NOT EXISTS avaliacoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      psicologo_id INTEGER NOT NULL,
      avaliador_nome TEXT NOT NULL,
      avaliador_email TEXT NOT NULL,
      nota INTEGER NOT NULL,
      comentario TEXT,
      status TEXT NOT NULL DEFAULT 'pendente_verificacao',
      agendamento_id INTEGER,
      criado_em TEXT DEFAULT (datetime('now')),
      UNIQUE(psicologo_id, avaliador_email)
    )`
  ).run();

  // Migração incremental — quem já tinha a tabela criada antes do campo
  // agendamento_id existir. CREATE TABLE IF NOT EXISTS não adiciona coluna
  // em tabela já existente, então garantimos aqui (idempotente).
  try { await db.prepare('ALTER TABLE avaliacoes ADD COLUMN agendamento_id INTEGER').run(); } catch {}

  await db.prepare(
    `CREATE TABLE IF NOT EXISTS avaliacoes_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      avaliacao_id INTEGER NOT NULL,
      motivo TEXT,
      removido_em TEXT DEFAULT (datetime('now'))
    )`
  ).run();

  await db.prepare(
    `CREATE TABLE IF NOT EXISTS tokens_verificacao (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tipo TEXT NOT NULL,
      referencia_id INTEGER NOT NULL,
      token TEXT NOT NULL UNIQUE,
      expira_em TEXT NOT NULL,
      usado_em TEXT
    )`
  ).run();

  await db.prepare(
    `CREATE TABLE IF NOT EXISTS pacientes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      telefone TEXT,
      senha_hash TEXT,
      email_verificado INTEGER NOT NULL DEFAULT 0,
      email_verificado_em TEXT,
      criado_em TEXT DEFAULT (datetime('now'))
    )`
  ).run();

  // Horários recorrentes que o psicólogo disponibiliza (ex: toda
  // segunda das 9h às 12h). dia_semana: 0=domingo ... 6=sábado.
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS disponibilidades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      psicologo_id INTEGER NOT NULL,
      dia_semana INTEGER NOT NULL,
      hora_inicio TEXT NOT NULL,
      hora_fim TEXT NOT NULL,
      duracao_minutos INTEGER NOT NULL DEFAULT 50,
      ativo INTEGER NOT NULL DEFAULT 1,
      criado_em TEXT DEFAULT (datetime('now'))
    )`
  ).run();

  await db.prepare(
    `CREATE TABLE IF NOT EXISTS agendamentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      psicologo_id INTEGER NOT NULL,
      paciente_id INTEGER NOT NULL,
      data_hora TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pendente_verificacao',
      criado_em TEXT DEFAULT (datetime('now')),
      UNIQUE(psicologo_id, data_hora)
    )`
  ).run();

  // Catálogo de especialidades — gerenciável pelo admin, usado como opções
  // no formulário de cadastro do psicólogo (checkboxes).
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS especialidades_catalogo (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL UNIQUE
    )`
  ).run();

  // Compromissos criados manualmente pelo psicólogo direto na agenda (ex:
  // paciente que agendou por telefone/whatsapp) — diferente de `agendamentos`,
  // que só existe pra reservas feitas pelo próprio paciente com confirmação
  // por e-mail. Aqui não há verificação: é a agenda pessoal do psicólogo.
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS compromissos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      psicologo_id INTEGER NOT NULL,
      paciente_nome TEXT NOT NULL,
      descricao TEXT,
      data_hora TEXT NOT NULL,
      tipo TEXT DEFAULT 'avulso',
      serie_id TEXT,
      criado_em TEXT DEFAULT (datetime('now'))
    )`
  ).run();

  // Eventos de tracking do perfil público (visualização de página, clique no
  // WhatsApp) — base pro gráfico de "visibilidade" do psicólogo e pra badge
  // de "muito procurado".
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS eventos_perfil (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      psicologo_id INTEGER NOT NULL,
      tipo TEXT NOT NULL,
      criado_em TEXT DEFAULT (datetime('now'))
    )`
  ).run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_eventos_perfil_psico_data ON eventos_perfil (psicologo_id, criado_em)').run();

  // Configurações globais editáveis pelo admin (chave/valor) — hoje só o
  // limite de cliques/dia pra badge "muito procurado", mas serve pra
  // qualquer outro parâmetro futuro sem precisar migração de schema.
  await db.prepare(`CREATE TABLE IF NOT EXISTS configuracoes (chave TEXT PRIMARY KEY, valor TEXT)`).run();
  await db.prepare(`INSERT OR IGNORE INTO configuracoes (chave, valor) VALUES ('limite_muito_procurado', '5')`).run();

  // Histórico da "régua de e-mail" — cada disparo feito pelo admin pra um
  // recorte de psicólogos (ver /admin/psicologos.html, aba "E-mails").
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS campanhas_email (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      assunto TEXT NOT NULL,
      paragrafos TEXT NOT NULL,
      imagem_url TEXT,
      botao_texto TEXT,
      botao_link TEXT,
      publico TEXT NOT NULL,
      total_destinatarios INTEGER NOT NULL DEFAULT 0,
      enviado_em TEXT DEFAULT (datetime('now'))
    )`
  ).run();

  // Serviços/valores que o próprio psicólogo cadastra (aba "Valores" do
  // painel) — exibidos no perfil público de forma neutra (sem destaque
  // promocional), conforme Art. 20-d do Código de Ética (preço não pode
  // ser usado como propaganda).
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS servicos_precos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      psicologo_id INTEGER NOT NULL,
      nome TEXT NOT NULL,
      valor REAL,
      descricao TEXT,
      ordem INTEGER NOT NULL DEFAULT 0,
      criado_em TEXT DEFAULT (datetime('now'))
    )`
  ).run();

  // Certificados/diplomas (fotos) que o psicólogo sobe pro perfil público —
  // galeria simples, mesmo bucket R2 das fotos de perfil.
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS certificados (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      psicologo_id INTEGER NOT NULL,
      imagem_url TEXT NOT NULL,
      titulo TEXT,
      ordem INTEGER NOT NULL DEFAULT 0,
      criado_em TEXT DEFAULT (datetime('now'))
    )`
  ).run();

  // "Fotos e vídeos" do perfil (consultório, fotos profissionais, etc) —
  // separado de certificados (que são diplomas) e do vídeo de apresentação
  // (que é um link do YouTube/Vimeo, não upload). Fica em galeria própria
  // logo na aba Sobre, como no Doctoralia.
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS galeria_fotos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      psicologo_id INTEGER NOT NULL,
      imagem_url TEXT NOT NULL,
      ordem INTEGER NOT NULL DEFAULT 0,
      criado_em TEXT DEFAULT (datetime('now'))
    )`
  ).run();

  const { results: existentes } = await db.prepare('SELECT COUNT(*) as n FROM especialidades_catalogo').all();
  if (existentes[0].n === 0) {
    const iniciais = ['Ansiedade', 'Depressão', 'TDAH', 'Relacionamentos', 'Autoestima', 'Luto', 'Estresse', 'Burnout', 'TEA / Autismo', 'Trauma / TEPT'];
    for (const nome of iniciais) {
      await db.prepare('INSERT OR IGNORE INTO especialidades_catalogo (nome) VALUES (?)').bind(nome).run();
    }
  }

  dbInicializada = true;
}

/* ── Helpers ── */
async function hashSenha(senha, env) {
  const enc = new TextEncoder();
  const dados = enc.encode(senha + (env.SENHA_PEPPER || ''));
  const buf = await crypto.subtle.digest('SHA-256', dados);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function gerarToken() {
  return [...crypto.getRandomValues(new Uint8Array(24))].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Calcula a primeira vaga livre a partir de uma lista de disponibilidades
// recorrentes e um Set de horários já ocupados. Usado tanto na listagem
// pública (calcula pra todos de uma vez, evitando N chamadas separadas)
// quanto no endpoint de horários completos do perfil individual.
// Formata uma data local (sem componente de hora) como "AAAA-MM-DD" sem
// passar por toISOString/UTC — evita qualquer risco de a data mudar por
// causa de fuso horário, tanto no Worker (que roda em UTC) quanto se essa
// mesma lógica for reaproveitada em algum lugar que rode noutro fuso.
function formatarDataISO(data) {
  const ano = data.getFullYear();
  const mes = String(data.getMonth() + 1).padStart(2, '0');
  const dia = String(data.getDate()).padStart(2, '0');
  return `${ano}-${mes}-${dia}`;
}

// Domingo de Páscoa pelo algoritmo de Gauss/anônimo gregoriano — base pros
// feriados móveis (Carnaval, Sexta-feira Santa, Corpus Christi).
function calcularPascoa(ano) {
  const a = ano % 19, b = Math.floor(ano / 100), c = ano % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31);
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(ano, mes - 1, dia);
}

// Feriados nacionais brasileiros pra um ano — fixos + móveis (baseados na
// Páscoa). Usado tanto pra marcar visualmente a agenda quanto pra bloquear
// agendamento público nesses dias.
function feriadosBrasileiros(ano) {
  const pascoa = calcularPascoa(ano);
  const addDias = (data, dias) => { const d = new Date(data); d.setDate(d.getDate() + dias); return d; };
  return [
    { data: `${ano}-01-01`, nome: 'Confraternização Universal' },
    { data: formatarDataISO(addDias(pascoa, -47)), nome: 'Carnaval (segunda)' },
    { data: formatarDataISO(addDias(pascoa, -46)), nome: 'Carnaval (terça)' },
    { data: formatarDataISO(addDias(pascoa, -2)), nome: 'Sexta-feira Santa' },
    { data: `${ano}-04-21`, nome: 'Tiradentes' },
    { data: `${ano}-05-01`, nome: 'Dia do Trabalho' },
    { data: formatarDataISO(addDias(pascoa, 60)), nome: 'Corpus Christi' },
    { data: `${ano}-09-07`, nome: 'Independência do Brasil' },
    { data: `${ano}-10-12`, nome: 'Nossa Senhora Aparecida' },
    { data: `${ano}-11-02`, nome: 'Finados' },
    { data: `${ano}-11-15`, nome: 'Proclamação da República' },
    { data: `${ano}-11-20`, nome: 'Consciência Negra' },
    { data: `${ano}-12-25`, nome: 'Natal' },
  ];
}

function feriadosNoIntervalo(inicio, fim) {
  const anos = new Set([inicio.getFullYear(), fim.getFullYear()]);
  let todos = [];
  anos.forEach(a => todos.push(...feriadosBrasileiros(a)));
  const inicioStr = formatarDataISO(inicio), fimStr = formatarDataISO(fim);
  return todos.filter(f => f.data >= inicioStr && f.data <= fimStr);
}

// Gera os horários (de hora em hora) de um dia específico a partir do
// "Horário de trabalho" cadastrado pelo próprio psicólogo (campo
// obrigatório em Meu perfil) — substitui a antiga configuração de
// "horários recorrentes" por dia da semana individual.
function horariosDoDiaPeloTrabalho(psicologo, diaSemana) {
  const dias = JSON.parse(psicologo.horario_trabalho_dias || '[]');
  if (!dias.includes(diaSemana)) return [];
  const [hIni] = (psicologo.horario_trabalho_inicio || '08:00').split(':').map(Number);
  const [hFim] = (psicologo.horario_trabalho_fim || '22:00').split(':').map(Number);
  const horas = [];
  for (let h = hIni; h <= hFim; h++) horas.push(String(h).padStart(2, '0') + ':00');
  return horas;
}

// ocupadosSet deve conter os data_hora já normalizados pra "AAAA-MM-DD HH:MM"
// (16 caracteres) — agendamentos e compromissos guardam formatos com
// granularidade diferente (com/sem segundos), então quem monta o Set
// precisa normalizar antes de passar aqui.
function proximaVagaLivre(psicologo, ocupadosSet, diasAFrente = 15, feriadosSet = null) {
  const agora = new Date();
  for (let d = 1; d <= diasAFrente; d++) {
    const dia = new Date(agora);
    dia.setDate(dia.getDate() + d);
    if (feriadosSet && feriadosSet.has(formatarDataISO(dia))) continue;

    const horasDoDia = horariosDoDiaPeloTrabalho(psicologo, dia.getDay());
    for (const hora of horasDoDia) {
      const iso = `${formatarDataISO(dia)} ${hora}`;
      if (!ocupadosSet.has(iso)) return iso;
    }
  }
  return null;
}

function autenticadoAdmin(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace('Bearer ', '');
  let tokenDecodificado = '';
  try { tokenDecodificado = atob(token); } catch {}
  return !!token && tokenDecodificado.includes(env.ADMIN_PASS);
}

// Token do psicólogo: base64("psicologoId:timestamp:senha_pepper") — mesmo
// nível de segurança já usado no admin do projeto de Testes.
function autenticadoPsicologo(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace('Bearer ', '');
  let decodificado = '';
  try { decodificado = atob(token); } catch {}
  const [id, , pepper] = decodificado.split(':');
  if (!id || pepper !== (env.SENHA_PEPPER || '')) return null;
  return Number(id);
}

// Token do paciente: base64("paciente:pacienteId:timestamp:senha_pepper") — o
// prefixo "paciente" evita que um token de paciente seja aceito como se fosse
// de psicólogo (ou vice-versa) só porque o id numérico coincide.
function autenticadoPaciente(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace('Bearer ', '');
  let decodificado = '';
  try { decodificado = atob(token); } catch {}
  const [prefixo, id, , pepper] = decodificado.split(':');
  if (prefixo !== 'paciente' || !id || pepper !== (env.SENHA_PEPPER || '')) return null;
  return Number(id);
}

async function enviarEmailConfirmacaoAvaliacao(env, avaliacao, linkConfirmacao) {
  const html = `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:32px 0;">
    <tr><td align="center">
      <table width="500" cellpadding="0" cellspacing="0" style="max-width:500px;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
        <tr><td style="background:#1A1A1A;padding:28px;text-align:center;">
          <div style="font-size:20px;font-weight:800;color:#fff;">O Seu <span style="color:#F5C518;">Psico</span></div>
        </td></tr>
        <tr><td style="padding:32px;">
          <p style="font-size:15px;color:#555;line-height:1.7;margin:0 0 20px;">Olá, ${avaliacao.avaliador_nome}! Confirme seu e-mail pra publicar sua avaliação.</p>
          <table cellpadding="0" cellspacing="0"><tr><td style="background:#F5C518;border-radius:40px;padding:14px 28px;">
            <a href="${linkConfirmacao}" style="font-size:15px;font-weight:700;color:#1A1A1A;text-decoration:none;">Confirmar e publicar avaliação →</a>
          </td></tr></table>
          <p style="font-size:12px;color:#999;margin:20px 0 0;">Se você não fez essa avaliação, ignore este e-mail.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'O Seu Psico <naoresponder@oseupsico.com.br>',
      to: [avaliacao.avaliador_email],
      subject: 'Confirme sua avaliação · O Seu Psico',
      html,
    }),
  });
}

async function enviarEmailConfirmacaoAgendamento(env, paciente, dataHora, linkConfirmacao) {
  const dataFormatada = new Date(dataHora.replace(' ', 'T')).toLocaleString('pt-BR', { dateStyle: 'long', timeStyle: 'short' });
  const html = `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:32px 0;">
    <tr><td align="center">
      <table width="500" cellpadding="0" cellspacing="0" style="max-width:500px;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
        <tr><td style="background:#1A1A1A;padding:28px;text-align:center;">
          <div style="font-size:20px;font-weight:800;color:#fff;">O Seu <span style="color:#F5C518;">Psico</span></div>
        </td></tr>
        <tr><td style="padding:32px;">
          <p style="font-size:15px;color:#555;line-height:1.7;margin:0 0 12px;">Olá, ${paciente.nome}!</p>
          <p style="font-size:15px;color:#555;line-height:1.7;margin:0 0 20px;">Confirme seu horário: <strong>${dataFormatada}</strong>.</p>
          <table cellpadding="0" cellspacing="0"><tr><td style="background:#F5C518;border-radius:40px;padding:14px 28px;">
            <a href="${linkConfirmacao}" style="font-size:15px;font-weight:700;color:#1A1A1A;text-decoration:none;">Confirmar agendamento →</a>
          </td></tr></table>
          <p style="font-size:12px;color:#999;margin:20px 0 0;">Se você não solicitou esse agendamento, ignore este e-mail — ele expira em 24h e o horário fica livre de novo.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'O Seu Psico <naoresponder@oseupsico.com.br>',
      to: [paciente.email],
      subject: 'Confirme seu agendamento · O Seu Psico',
      html,
    }),
  });
}

async function enviarEmailRedefinirSenha(env, psicologo, linkRedefinir) {
  const html = `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:32px 0;">
    <tr><td align="center">
      <table width="500" cellpadding="0" cellspacing="0" style="max-width:500px;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
        <tr><td style="background:#1A1A1A;padding:28px;text-align:center;">
          <div style="font-size:20px;font-weight:800;color:#fff;">O Seu <span style="color:#F5C518;">Psico</span></div>
        </td></tr>
        <tr><td style="padding:32px;">
          <p style="font-size:15px;color:#555;line-height:1.7;margin:0 0 12px;">Olá, ${psicologo.nome}!</p>
          <p style="font-size:15px;color:#555;line-height:1.7;margin:0 0 20px;">Recebemos um pedido pra redefinir sua senha. Clique no botão abaixo pra criar uma nova.</p>
          <table cellpadding="0" cellspacing="0"><tr><td style="background:#F5C518;border-radius:40px;padding:14px 28px;">
            <a href="${linkRedefinir}" style="font-size:15px;font-weight:700;color:#1A1A1A;text-decoration:none;">Redefinir senha →</a>
          </td></tr></table>
          <p style="font-size:12px;color:#999;margin:20px 0 0;">Se você não pediu isso, ignore este e-mail — sua senha continua a mesma. Este link expira em 2 horas.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'O Seu Psico <naoresponder@oseupsico.com.br>',
      to: [psicologo.email],
      subject: 'Redefinir sua senha · O Seu Psico',
      html,
    }),
  });
}

function montarHtmlEmailBasico({ tituloBotao, linkBotao, paragrafos, imagemUrl }) {
  const corpo = paragrafos.map(p => `<p style="font-size:15px;color:#555;line-height:1.7;margin:0 0 16px;">${p}</p>`).join('');
  const imagem = imagemUrl ? `<img src="${imagemUrl}" alt="" style="width:100%;max-width:456px;border-radius:10px;display:block;margin:0 0 20px;" />` : '';
  const botao = linkBotao ? `
    <table cellpadding="0" cellspacing="0"><tr><td style="background:#F5C518;border-radius:40px;padding:14px 28px;">
      <a href="${linkBotao}" style="font-size:15px;font-weight:700;color:#1A1A1A;text-decoration:none;">${tituloBotao} →</a>
    </td></tr></table>` : '';
  return `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:32px 0;">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
        <tr><td style="background:#1A1A1A;padding:28px;text-align:center;">
          <div style="font-size:20px;font-weight:800;color:#fff;">O Seu <span style="color:#F5C518;">Psico</span></div>
        </td></tr>
        <tr><td style="padding:32px;">
          ${imagem}
          ${corpo}
          ${botao}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

async function enviarEmailBasico(env, { destinatario, assunto, tituloBotao, linkBotao, paragrafos, imagemUrl }) {
  const html = montarHtmlEmailBasico({ tituloBotao, linkBotao, paragrafos, imagemUrl });
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'O Seu Psico <naoresponder@oseupsico.com.br>', to: [destinatario], subject: assunto, html }),
  });
}

async function enviarEmailNovoAgendamentoPsicologo(env, psicologo, paciente, dataHora) {
  const dataFormatada = new Date(dataHora.replace(' ', 'T')).toLocaleString('pt-BR', { dateStyle: 'long', timeStyle: 'short' });
  await enviarEmailBasico(env, {
    destinatario: psicologo.email,
    assunto: 'Novo agendamento confirmado · O Seu Psico',
    paragrafos: [
      `Olá, ${psicologo.nome.split(' ')[0]}!`,
      `Você tem um novo agendamento confirmado com <strong>${paciente.nome}</strong> pra <strong>${dataFormatada}</strong>.`,
      paciente.telefone ? `Telefone: ${paciente.telefone}` : '',
    ].filter(Boolean),
    tituloBotao: 'Ver minha agenda',
    linkBotao: `${env.APP_ORIGIN || 'https://oseupsico.com.br'}/psicologos/painel.html`,
  });
}

async function enviarEmailCancelamentoParaPsicologo(env, psicologo, pacienteNome, dataHora) {
  const dataFormatada = new Date(dataHora.replace(' ', 'T')).toLocaleString('pt-BR', { dateStyle: 'long', timeStyle: 'short' });
  await enviarEmailBasico(env, {
    destinatario: psicologo.email,
    assunto: 'Agendamento cancelado · O Seu Psico',
    paragrafos: [
      `Olá, ${psicologo.nome.split(' ')[0]}.`,
      `O agendamento com <strong>${pacienteNome}</strong> pra <strong>${dataFormatada}</strong> foi cancelado pelo paciente.`,
    ],
    tituloBotao: 'Ver minha agenda',
    linkBotao: `${env.APP_ORIGIN || 'https://oseupsico.com.br'}/psicologos/painel.html`,
  });
}

async function enviarEmailCancelamentoParaPaciente(env, paciente, psicologoNome, dataHora) {
  const dataFormatada = new Date(dataHora.replace(' ', 'T')).toLocaleString('pt-BR', { dateStyle: 'long', timeStyle: 'short' });
  await enviarEmailBasico(env, {
    destinatario: paciente.email,
    assunto: 'Seu agendamento foi cancelado · O Seu Psico',
    paragrafos: [
      `Olá, ${paciente.nome.split(' ')[0]}.`,
      `Seu agendamento com <strong>${psicologoNome}</strong> pra <strong>${dataFormatada}</strong> foi cancelado.`,
    ],
    tituloBotao: 'Encontrar outro horário',
    linkBotao: `${env.APP_ORIGIN || 'https://oseupsico.com.br'}/psicologos/`,
  });
}

async function enviarEmailResumoDiario(env, psicologo, itens) {
  const listaHtml = itens.map(i => {
    const hora = new Date(i.data_hora.replace(' ', 'T')).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    return `<div style="padding:10px 14px;background:#F7F5F0;border-radius:10px;margin-bottom:8px;font-size:14px;color:#333;">
      <strong>${hora}</strong> — ${i.nome}${i.descricao ? `<div style="font-size:12px;color:#888;margin-top:2px;">${i.descricao}</div>` : ''}
    </div>`;
  }).join('');

  await enviarEmailBasico(env, {
    destinatario: psicologo.email,
    assunto: 'Sua agenda de amanhã · O Seu Psico',
    paragrafos: [
      `Olá, ${psicologo.nome.split(' ')[0]}! Aqui está sua agenda de amanhã:`,
      listaHtml,
    ],
    tituloBotao: 'Ver minha agenda completa',
    linkBotao: `${env.APP_ORIGIN || 'https://oseupsico.com.br'}/psicologos/painel.html`,
  });
}

// Recortes de público usados pela "régua de e-mail" do admin. Sempre parte
// de psicólogos aprovados (rejeitados/pendentes não recebem campanha).
// Os limiares (7 dias, 5 visualizações, 3 depoimentos) são fixos por ora —
// dá pra virar configuração editável (como limite_muito_procurado) se um
// dia precisar ajustar sem deploy.
async function resolverPublicoCampanha(env, publico) {
  const base = `FROM psicologos p WHERE p.status_aprovacao = 'aprovado'`;
  let sql;
  if (publico === 'licenca_vencendo') {
    sql = `SELECT p.id, p.nome, p.email ${base}
           AND p.licenca_validade_ate IS NOT NULL
           AND p.licenca_validade_ate BETWEEN date('now') AND date('now', '+7 days')`;
  } else if (publico === 'poucas_visualizacoes') {
    sql = `SELECT p.id, p.nome, p.email ${base}
           AND (SELECT COUNT(*) FROM eventos_perfil e WHERE e.psicologo_id = p.id AND e.tipo = 'visualizacao' AND e.criado_em >= datetime('now', '-7 days')) < 5`;
  } else if (publico === 'poucos_depoimentos') {
    sql = `SELECT p.id, p.nome, p.email ${base}
           AND (SELECT COUNT(*) FROM avaliacoes a WHERE a.psicologo_id = p.id AND a.status = 'publicado') < 3`;
  } else {
    sql = `SELECT p.id, p.nome, p.email ${base}`;
  }
  const { results } = await env.DB.prepare(sql).all();
  return results;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (pathname === '/login' || pathname === '/login/') {
      return Response.redirect(`${url.origin}/psicologos/painel.html`, 302);
    }

    if (pathname === '/auth') {
      const params = new URLSearchParams({
        client_id: env.GITHUB_CLIENT_ID,
        scope: 'repo,user',
        redirect_uri: `${url.origin}/callback`,
      });
      return Response.redirect(`https://github.com/login/oauth/authorize?${params}`, 302);
    }

    if (pathname === '/callback') {
      const code = url.searchParams.get('code');
      if (!code) return new Response('Código OAuth ausente.', { status: 400 });

      const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code }),
      });
      const { access_token, error } = await tokenRes.json();
      if (error || !access_token) return new Response('Erro ao obter token do GitHub.', { status: 500 });

      const content = JSON.stringify({ token: access_token, provider: 'github' });
      const html = `<!DOCTYPE html><html><body><script>
        (function(){
          function cb(e){
            window.opener.postMessage('authorization:github:success:${content.replace(/'/g, "\\'")}', e.origin);
          }
          window.addEventListener('message', cb, false);
          window.opener.postMessage('authorizing:github', '*');
        })();
      </script></body></html>`;
      return new Response(html, { headers: { 'Content-Type': 'text/html' } });
    }

    if (request.method === 'OPTIONS' && pathname.startsWith('/api/')) {
      return new Response(null, { status: 204, headers: CORS });
    }

    /* ── Fotos de perfil dos psicólogos (servidas do R2 pelo próprio Worker) ── */
    if (pathname.startsWith('/fotos/') && request.method === 'GET') {
      if (!env.FOTOS_BUCKET) return new Response('Não encontrada.', { status: 404 });
      const key = pathname.slice('/fotos/'.length);
      const objeto = await env.FOTOS_BUCKET.get(key);
      if (!objeto) return new Response('Não encontrada.', { status: 404 });
      return new Response(objeto.body, {
        headers: {
          'Content-Type': objeto.httpMetadata?.contentType || 'application/octet-stream',
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      });
    }

    /* ══════════════ API: Especialidades (catálogo) ══════════════ */

    if (pathname === '/api/especialidades' && request.method === 'GET') {
      await initDB(env.DB);
      const { results } = await env.DB.prepare('SELECT * FROM especialidades_catalogo ORDER BY nome').all();
      return json({ ok: true, especialidades: results });
    }

    if (pathname === '/api/admin/especialidades' && request.method === 'POST') {
      if (!autenticadoAdmin(request, env)) return json({ ok: false }, 401);
      await initDB(env.DB);
      const { nome } = await request.json();
      if (!nome || !nome.trim()) return json({ ok: false, error: 'Nome obrigatório.' }, 400);
      try {
        await env.DB.prepare('INSERT INTO especialidades_catalogo (nome) VALUES (?)').bind(nome.trim()).run();
        return json({ ok: true });
      } catch (e) {
        return json({ ok: false, error: 'Essa especialidade já existe.' }, 409);
      }
    }

    const especDeleteMatch = pathname.match(/^\/api\/admin\/especialidades\/(\d+)$/);
    if (especDeleteMatch && request.method === 'DELETE') {
      if (!autenticadoAdmin(request, env)) return json({ ok: false }, 401);
      await initDB(env.DB);

      const especialidade = await env.DB.prepare('SELECT nome FROM especialidades_catalogo WHERE id = ?').bind(especDeleteMatch[1]).first();
      await env.DB.prepare('DELETE FROM especialidades_catalogo WHERE id = ?').bind(especDeleteMatch[1]).run();

      // Desmarca essa especialidade de todo psicólogo que a tinha selecionada
      // — evita que um perfil público continue mostrando algo que o admin
      // já removeu do catálogo.
      if (especialidade) {
        const { results: afetados } = await env.DB.prepare(
          `SELECT id, especialidades FROM psicologos WHERE especialidades LIKE '%' || ? || '%'`
        ).bind(especialidade.nome).all();
        for (const p of afetados) {
          let lista = [];
          try { lista = JSON.parse(p.especialidades || '[]'); } catch { continue; }
          if (!lista.includes(especialidade.nome)) continue; // match do LIKE pode ser só substring de outro nome
          const novaLista = lista.filter(e => e !== especialidade.nome);
          await env.DB.prepare('UPDATE psicologos SET especialidades = ? WHERE id = ?')
            .bind(JSON.stringify(novaLista), p.id).run();
        }
      }

      return json({ ok: true });
    }

    /* ══════════════ API: Psicólogos ══════════════ */

    if (pathname === '/api/psicologos/cadastro' && request.method === 'POST') {
      try {
        await initDB(env.DB);
        const form = await request.formData();

        const nome = form.get('nome');
        const email = form.get('email');
        const senha = form.get('senha');
        const crpNumero = form.get('crp_numero');
        const crpEstado = form.get('crp_estado');
        const horarioInicio = form.get('horario_trabalho_inicio');
        const horarioFim = form.get('horario_trabalho_fim');
        const horarioDias = form.get('horario_trabalho_dias') || '[]';

        if (!nome || !email || !senha || !crpNumero || !crpEstado) {
          return json({ ok: false, error: 'Dados obrigatórios ausentes.' }, 400);
        }
        let horarioDiasArr = [];
        try { horarioDiasArr = JSON.parse(horarioDias); } catch {}
        if (!horarioInicio || !horarioFim || !horarioDiasArr.length) {
          return json({ ok: false, error: 'Informe seu horário de trabalho (início, fim e pelo menos um dia).' }, 400);
        }

        let fotoUrl = null;
        const foto = form.get('foto');
        if (foto && foto.size > 0) {
          if (!env.FOTOS_BUCKET) {
            return json({ ok: false, error: 'Upload de foto temporariamente indisponível — cadastre sem foto por enquanto ou tente novamente mais tarde.' }, 503);
          }
          if (foto.size > 5 * 1024 * 1024) {
            return json({ ok: false, error: 'Foto muito grande (máx. 5MB).' }, 400);
          }
          if (!['image/jpeg', 'image/png', 'image/webp'].includes(foto.type)) {
            return json({ ok: false, error: 'Formato de foto inválido — use JPG, PNG ou WEBP.' }, 400);
          }
          const ext = foto.type.split('/')[1];
          const key = `psicologos/${Date.now()}-${crypto.randomUUID()}.${ext}`;
          await env.FOTOS_BUCKET.put(key, await foto.arrayBuffer(), { httpMetadata: { contentType: foto.type } });
          // Caminho relativo servido pelo próprio Worker (rota /fotos/*) —
          // evita precisar configurar um subdomínio/DNS novo pro bucket.
          fotoUrl = `/fotos/${key}`;
        }

        const senhaHash = await hashSenha(senha, env);

        const posGraduacoes = form.get('pos_graduacoes') || '[]';
        const especialidades = form.get('especialidades') || '[]';
        const experiencias = form.get('experiencias') || '[]';

        const result = await env.DB.prepare(
          `INSERT INTO psicologos
           (nome, email, senha_hash, telefone, foto_url, cpf, rg, crp_numero, crp_estado, bio,
            graduacao_curso, graduacao_instituicao, graduacao_mes_ano, pos_graduacoes,
            especialidades, abordagem, experiencias,
            horario_trabalho_inicio, horario_trabalho_fim, horario_trabalho_dias)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          nome, email, senhaHash, form.get('telefone') || null, fotoUrl,
          form.get('cpf') || null, form.get('rg') || null, crpNumero, crpEstado,
          form.get('bio') || null, form.get('graduacao_curso') || null, form.get('graduacao_instituicao') || null,
          form.get('graduacao_mes_ano') || null, posGraduacoes,
          especialidades, form.get('abordagem') || null, experiencias,
          horarioInicio, horarioFim, horarioDias
        ).run();

        return json({ ok: true, id: result.meta.last_row_id });
      } catch (e) {
        if (String(e.message).includes('UNIQUE')) {
          return json({ ok: false, error: 'Já existe um cadastro com esse e-mail.' }, 409);
        }
        return json({ ok: false, error: e.message }, 500);
      }
    }

    if (pathname === '/api/psicologos/login' && request.method === 'POST') {
      try {
        await initDB(env.DB);
        const { email, senha } = await request.json();
        const senhaHash = await hashSenha(senha, env);
        const psicologo = await env.DB.prepare('SELECT id, nome FROM psicologos WHERE email = ? AND senha_hash = ?')
          .bind(email, senhaHash).first();
        if (!psicologo) return json({ ok: false, error: 'E-mail ou senha incorretos.' }, 401);
        const token = btoa(`${psicologo.id}:${Date.now()}:${env.SENHA_PEPPER || ''}`);
        return json({ ok: true, token, nome: psicologo.nome });
      } catch (e) {
        return json({ ok: false, error: e.message }, 500);
      }
    }

    if (pathname === '/api/psicologos/esqueci-senha' && request.method === 'POST') {
      try {
        await initDB(env.DB);
        const { email } = await request.json();
        const psicologo = await env.DB.prepare('SELECT id, nome FROM psicologos WHERE email = ?').bind(email).first();
        // Sempre responde ok, mesmo se o e-mail não existir — evita expor quais e-mails estão cadastrados.
        if (psicologo) {
          const token = gerarToken();
          const expira = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
          await env.DB.prepare(
            `INSERT INTO tokens_verificacao (tipo, referencia_id, token, expira_em) VALUES ('reset_senha', ?, ?, ?)`
          ).bind(psicologo.id, token, expira).run();
          const link = `${url.origin}/psicologos/redefinir-senha.html?token=${token}`;
          await enviarEmailRedefinirSenha(env, psicologo, link);
        }
        return json({ ok: true });
      } catch (e) {
        return json({ ok: false, error: e.message }, 500);
      }
    }

    if (pathname === '/api/psicologos/redefinir-senha' && request.method === 'POST') {
      try {
        await initDB(env.DB);
        const { token, senha } = await request.json();
        if (!token || !senha || senha.length < 6) return json({ ok: false, error: 'Senha precisa ter ao menos 6 caracteres.' }, 400);
        const registro = await env.DB.prepare(
          `SELECT * FROM tokens_verificacao WHERE token = ? AND tipo = 'reset_senha'`
        ).bind(token).first();
        if (!registro) return json({ ok: false, error: 'Link inválido.' }, 400);
        if (registro.usado_em) return json({ ok: false, error: 'Esse link já foi usado.' }, 400);
        if (new Date(registro.expira_em) < new Date()) return json({ ok: false, error: 'Esse link expirou. Solicite outro.' }, 400);

        const senhaHash = await hashSenha(senha, env);
        await env.DB.prepare('UPDATE psicologos SET senha_hash = ? WHERE id = ?').bind(senhaHash, registro.referencia_id).run();
        await env.DB.prepare(`UPDATE tokens_verificacao SET usado_em = datetime('now') WHERE id = ?`).bind(registro.id).run();
        return json({ ok: true });
      } catch (e) {
        return json({ ok: false, error: e.message }, 500);
      }
    }

    if (pathname === '/api/psicologos/me' && (request.method === 'GET' || request.method === 'PUT')) {
      const psicologoId = autenticadoPsicologo(request, env);
      if (!psicologoId) return json({ ok: false }, 401);
      await initDB(env.DB);

      if (request.method === 'GET') {
        const p = await env.DB.prepare('SELECT * FROM psicologos WHERE id = ?').bind(psicologoId).first();
        if (!p) return json({ ok: false }, 404);
        delete p.senha_hash;
        return json({ ok: true, psicologo: p });
      }

      // PUT — edita o próprio perfil (não mexe em aprovação/licença).
      // anos_experiencia NÃO é editável diretamente — é sempre calculado a
      // partir de graduacao_mes_ano (ver calcularAnosExperiencia), pra evitar
      // que o psicólogo informe um número que não bate com a formação.
      // crp_numero/crp_estado também não são editáveis aqui — foram
      // verificados pelo admin na aprovação; mudar exigiria nova checagem.
      const body = await request.json();

      // Horário de trabalho é obrigatório — é a partir dele que o site
      // calcula quais horários oferecer no perfil público. Só valida
      // quando o campo vem no corpo da requisição (a tela de edição
      // sempre manda os três juntos).
      if (body.horario_trabalho_inicio !== undefined || body.horario_trabalho_fim !== undefined || body.horario_trabalho_dias !== undefined) {
        if (!body.horario_trabalho_inicio || !body.horario_trabalho_fim) {
          return json({ ok: false, error: 'Informe o horário de trabalho (início e fim).' }, 400);
        }
        let diasArr = [];
        try { diasArr = JSON.parse(body.horario_trabalho_dias || '[]'); } catch {}
        if (!Array.isArray(diasArr) || !diasArr.length) {
          return json({ ok: false, error: 'Selecione ao menos um dia de trabalho.' }, 400);
        }
      }

      const campos = ['telefone', 'bio', 'cpf', 'rg', 'graduacao_curso', 'graduacao_instituicao', 'graduacao_mes_ano',
        'pos_graduacoes', 'especialidades', 'abordagem', 'experiencias', 'hora_notificacao_diaria', 'receber_agenda_email',
        'horario_trabalho_inicio', 'horario_trabalho_fim', 'horario_trabalho_dias',
        'video_apresentacao_url', 'idiomas', 'instagram', 'site_pessoal',
        'atende_adultos', 'atende_adolescentes', 'atende_criancas', 'atende_idosos', 'idade_minima_criancas',
        'atende_presencial', 'endereco_presencial'];
      const camposBooleanos = ['receber_agenda_email', 'atende_adultos', 'atende_adolescentes', 'atende_criancas', 'atende_idosos', 'atende_presencial'];
      const sets = [], binds = [];
      campos.forEach(c => {
        if (body[c] !== undefined) { sets.push(`${c} = ?`); binds.push(camposBooleanos.includes(c) ? (body[c] ? 1 : 0) : body[c]); }
      });
      if (!sets.length) return json({ ok: false, error: 'Nada pra atualizar.' }, 400);
      binds.push(psicologoId);
      await env.DB.prepare(`UPDATE psicologos SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
      return json({ ok: true });
    }

    /* ── Serviços/valores (aba "Valores" do painel) ── */

    if (pathname === '/api/psicologos/me/servicos' && request.method === 'GET') {
      const psicologoId = autenticadoPsicologo(request, env);
      if (!psicologoId) return json({ ok: false }, 401);
      await initDB(env.DB);
      const { results } = await env.DB.prepare(
        'SELECT id, nome, valor, descricao, ordem FROM servicos_precos WHERE psicologo_id = ? ORDER BY ordem, id'
      ).bind(psicologoId).all();
      return json({ ok: true, servicos: results });
    }

    if (pathname === '/api/psicologos/me/servicos' && request.method === 'POST') {
      const psicologoId = autenticadoPsicologo(request, env);
      if (!psicologoId) return json({ ok: false }, 401);
      await initDB(env.DB);
      const { nome, valor, descricao } = await request.json();
      if (!nome) return json({ ok: false, error: 'Informe o nome do serviço.' }, 400);
      const { results } = await env.DB.prepare('SELECT COALESCE(MAX(ordem), -1) + 1 as prox FROM servicos_precos WHERE psicologo_id = ?').bind(psicologoId).all();
      const r = await env.DB.prepare(
        'INSERT INTO servicos_precos (psicologo_id, nome, valor, descricao, ordem) VALUES (?, ?, ?, ?, ?)'
      ).bind(psicologoId, nome, valor || null, descricao || null, results[0].prox).run();
      return json({ ok: true, id: r.meta.last_row_id });
    }

    const servicoMatch = pathname.match(/^\/api\/psicologos\/me\/servicos\/(\d+)$/);
    if (servicoMatch && request.method === 'PUT') {
      const psicologoId = autenticadoPsicologo(request, env);
      if (!psicologoId) return json({ ok: false }, 401);
      await initDB(env.DB);
      const { nome, valor, descricao } = await request.json();
      if (!nome) return json({ ok: false, error: 'Informe o nome do serviço.' }, 400);
      await env.DB.prepare(
        'UPDATE servicos_precos SET nome = ?, valor = ?, descricao = ? WHERE id = ? AND psicologo_id = ?'
      ).bind(nome, valor || null, descricao || null, servicoMatch[1], psicologoId).run();
      return json({ ok: true });
    }

    if (servicoMatch && request.method === 'DELETE') {
      const psicologoId = autenticadoPsicologo(request, env);
      if (!psicologoId) return json({ ok: false }, 401);
      await initDB(env.DB);
      await env.DB.prepare('DELETE FROM servicos_precos WHERE id = ? AND psicologo_id = ?').bind(servicoMatch[1], psicologoId).run();
      return json({ ok: true });
    }

    /* ── Certificados/diplomas (galeria de fotos no perfil) ── */

    if (pathname === '/api/psicologos/me/certificados' && request.method === 'GET') {
      const psicologoId = autenticadoPsicologo(request, env);
      if (!psicologoId) return json({ ok: false }, 401);
      await initDB(env.DB);
      const { results } = await env.DB.prepare(
        'SELECT id, imagem_url, titulo, ordem FROM certificados WHERE psicologo_id = ? ORDER BY ordem, id'
      ).bind(psicologoId).all();
      return json({ ok: true, certificados: results });
    }

    if (pathname === '/api/psicologos/me/certificados' && request.method === 'POST') {
      const psicologoId = autenticadoPsicologo(request, env);
      if (!psicologoId) return json({ ok: false }, 401);
      if (!env.FOTOS_BUCKET) return json({ ok: false, error: 'Upload temporariamente indisponível.' }, 503);
      await initDB(env.DB);
      try {
        const form = await request.formData();
        const imagem = form.get('imagem');
        const titulo = form.get('titulo') || null;
        if (!imagem || !imagem.size) return json({ ok: false, error: 'Nenhuma imagem enviada.' }, 400);
        if (imagem.size > 4 * 1024 * 1024) return json({ ok: false, error: 'Imagem muito grande (máx. 4MB).' }, 400);
        const ext = (imagem.name || '').split('.').pop() || 'jpg';
        const key = `certificados/${psicologoId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
        await env.FOTOS_BUCKET.put(key, await imagem.arrayBuffer(), { httpMetadata: { contentType: imagem.type } });
        const { results } = await env.DB.prepare('SELECT COALESCE(MAX(ordem), -1) + 1 as prox FROM certificados WHERE psicologo_id = ?').bind(psicologoId).all();
        const r = await env.DB.prepare(
          'INSERT INTO certificados (psicologo_id, imagem_url, titulo, ordem) VALUES (?, ?, ?, ?)'
        ).bind(psicologoId, `${url.origin}/fotos/${key}`, titulo, results[0].prox).run();
        return json({ ok: true, id: r.meta.last_row_id, imagem_url: `${url.origin}/fotos/${key}` });
      } catch (e) {
        return json({ ok: false, error: e.message }, 500);
      }
    }

    const certificadoMatch = pathname.match(/^\/api\/psicologos\/me\/certificados\/(\d+)$/);
    if (certificadoMatch && request.method === 'DELETE') {
      const psicologoId = autenticadoPsicologo(request, env);
      if (!psicologoId) return json({ ok: false }, 401);
      await initDB(env.DB);
      const cert = await env.DB.prepare('SELECT imagem_url FROM certificados WHERE id = ? AND psicologo_id = ?').bind(certificadoMatch[1], psicologoId).first();
      await env.DB.prepare('DELETE FROM certificados WHERE id = ? AND psicologo_id = ?').bind(certificadoMatch[1], psicologoId).run();
      if (cert?.imagem_url && env.FOTOS_BUCKET) {
        const key = cert.imagem_url.split('/fotos/')[1];
        if (key) await env.FOTOS_BUCKET.delete(key).catch(() => {});
      }
      return json({ ok: true });
    }

    /* ── Fotos e vídeos (galeria geral do perfil — consultório, fotos profissionais) ── */

    if (pathname === '/api/psicologos/me/galeria' && request.method === 'GET') {
      const psicologoId = autenticadoPsicologo(request, env);
      if (!psicologoId) return json({ ok: false }, 401);
      await initDB(env.DB);
      const { results } = await env.DB.prepare(
        'SELECT id, imagem_url, ordem FROM galeria_fotos WHERE psicologo_id = ? ORDER BY ordem, id'
      ).bind(psicologoId).all();
      return json({ ok: true, galeria: results });
    }

    if (pathname === '/api/psicologos/me/galeria' && request.method === 'POST') {
      const psicologoId = autenticadoPsicologo(request, env);
      if (!psicologoId) return json({ ok: false }, 401);
      if (!env.FOTOS_BUCKET) return json({ ok: false, error: 'Upload temporariamente indisponível.' }, 503);
      await initDB(env.DB);
      try {
        const form = await request.formData();
        const imagem = form.get('imagem');
        if (!imagem || !imagem.size) return json({ ok: false, error: 'Nenhuma imagem enviada.' }, 400);
        if (imagem.size > 4 * 1024 * 1024) return json({ ok: false, error: 'Imagem muito grande (máx. 4MB).' }, 400);
        const ext = (imagem.name || '').split('.').pop() || 'jpg';
        const key = `galeria/${psicologoId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
        await env.FOTOS_BUCKET.put(key, await imagem.arrayBuffer(), { httpMetadata: { contentType: imagem.type } });
        const { results } = await env.DB.prepare('SELECT COALESCE(MAX(ordem), -1) + 1 as prox FROM galeria_fotos WHERE psicologo_id = ?').bind(psicologoId).all();
        const r = await env.DB.prepare(
          'INSERT INTO galeria_fotos (psicologo_id, imagem_url, ordem) VALUES (?, ?, ?)'
        ).bind(psicologoId, `${url.origin}/fotos/${key}`, results[0].prox).run();
        return json({ ok: true, id: r.meta.last_row_id, imagem_url: `${url.origin}/fotos/${key}` });
      } catch (e) {
        return json({ ok: false, error: e.message }, 500);
      }
    }

    const galeriaMatch = pathname.match(/^\/api\/psicologos\/me\/galeria\/(\d+)$/);
    if (galeriaMatch && request.method === 'DELETE') {
      const psicologoId = autenticadoPsicologo(request, env);
      if (!psicologoId) return json({ ok: false }, 401);
      await initDB(env.DB);
      const foto = await env.DB.prepare('SELECT imagem_url FROM galeria_fotos WHERE id = ? AND psicologo_id = ?').bind(galeriaMatch[1], psicologoId).first();
      await env.DB.prepare('DELETE FROM galeria_fotos WHERE id = ? AND psicologo_id = ?').bind(galeriaMatch[1], psicologoId).run();
      if (foto?.imagem_url && env.FOTOS_BUCKET) {
        const key = foto.imagem_url.split('/fotos/')[1];
        if (key) await env.FOTOS_BUCKET.delete(key).catch(() => {});
      }
      return json({ ok: true });
    }

    if (pathname === '/api/psicologos/me/foto' && request.method === 'POST') {
      const psicologoId = autenticadoPsicologo(request, env);
      if (!psicologoId) return json({ ok: false }, 401);
      if (!env.FOTOS_BUCKET) return json({ ok: false, error: 'Upload de foto temporariamente indisponível.' }, 503);
      await initDB(env.DB);
      try {
        const form = await request.formData();
        const foto = form.get('foto');
        if (!foto || !foto.size) return json({ ok: false, error: 'Nenhuma foto enviada.' }, 400);
        if (foto.size > 2 * 1024 * 1024) return json({ ok: false, error: 'Foto muito grande (máx. 2MB) — o app já reduz antes de enviar, tente outra imagem.' }, 400);
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(foto.type)) {
          return json({ ok: false, error: 'Formato de foto inválido — use JPG, PNG ou WEBP.' }, 400);
        }

        const atual = await env.DB.prepare('SELECT foto_url FROM psicologos WHERE id = ?').bind(psicologoId).first();

        const ext = foto.type.split('/')[1];
        const key = `psicologos/${Date.now()}-${crypto.randomUUID()}.${ext}`;
        await env.FOTOS_BUCKET.put(key, await foto.arrayBuffer(), { httpMetadata: { contentType: foto.type } });
        const fotoUrl = `/fotos/${key}`;

        await env.DB.prepare('UPDATE psicologos SET foto_url = ? WHERE id = ?').bind(fotoUrl, psicologoId).run();

        // Apaga a foto antiga do R2 só depois que a nova já foi salva com
        // sucesso no banco — evita ficar sem foto nenhuma se algo falhar no meio.
        if (atual?.foto_url && atual.foto_url.startsWith('/fotos/')) {
          const keyAntiga = atual.foto_url.slice('/fotos/'.length);
          await env.FOTOS_BUCKET.delete(keyAntiga).catch(() => {});
        }

        return json({ ok: true, foto_url: fotoUrl });
      } catch (e) {
        return json({ ok: false, error: e.message }, 500);
      }
    }

    if (pathname === '/api/psicologos' && request.method === 'GET') {
      await initDB(env.DB);
      const { results } = await env.DB.prepare(
        `SELECT p.id, p.nome, p.foto_url, p.bio, p.especialidades, p.abordagem,
                p.graduacao_curso, p.graduacao_instituicao, p.graduacao_mes_ano,
                p.horario_trabalho_inicio, p.horario_trabalho_fim, p.horario_trabalho_dias,
                (SELECT AVG(nota) FROM avaliacoes WHERE psicologo_id = p.id AND status = 'publicado') as avaliacao_media,
                (SELECT COUNT(*) FROM avaliacoes WHERE psicologo_id = p.id AND status = 'publicado') as total_avaliacoes
         FROM psicologos p
         WHERE status_aprovacao = 'aprovado' AND licenca_validade_ate >= date('now')
         ORDER BY criado_em DESC`
      ).all();

      // Calcula a "próxima vaga" de todos de uma vez (2 consultas no total,
      // não 2×N) — antes a página fazia uma chamada extra por psicólogo pra
      // esse mesmo cálculo, o que deixava a listagem lenta.
      let psicologos = results;
      if (results.length) {
        const ids = results.map(p => p.id);
        const placeholders = ids.map(() => '?').join(',');

        const { results: todosOcupadosAgendamentos } = await env.DB.prepare(
          `SELECT psicologo_id, data_hora FROM agendamentos
           WHERE psicologo_id IN (${placeholders}) AND status IN ('confirmado', 'pendente_verificacao') AND data_hora >= datetime('now')`
        ).bind(...ids).all();
        const { results: todosOcupadosCompromissos } = await env.DB.prepare(
          `SELECT psicologo_id, data_hora FROM compromissos WHERE psicologo_id IN (${placeholders}) AND data_hora >= datetime('now')`
        ).bind(...ids).all();
        // agendamentos guarda "AAAA-MM-DD HH:MM" e compromissos guarda com
        // segundos — normaliza os dois pros mesmos 16 caracteres antes de comparar.
        const todosOcupados = [...todosOcupadosAgendamentos, ...todosOcupadosCompromissos]
          .map(o => ({ psicologo_id: o.psicologo_id, data_hora: o.data_hora.slice(0, 16) }));

        // Os objetos retornados pelo D1 não são mutáveis com segurança —
        // criamos objetos novos em vez de atribuir campo direto neles.
        // Badge "muito procurado": cliques no WhatsApp nas últimas 24h >=
        // limite configurável pelo admin (tabela configuracoes).
        const config = await env.DB.prepare(`SELECT valor FROM configuracoes WHERE chave = 'limite_muito_procurado'`).first();
        const limite = Number(config?.valor) || 5;
        const { results: cliquesRecentes } = await env.DB.prepare(
          `SELECT psicologo_id, COUNT(*) as total FROM eventos_perfil
           WHERE psicologo_id IN (${placeholders}) AND tipo = 'whatsapp_click' AND criado_em >= datetime('now', '-1 day')
           GROUP BY psicologo_id`
        ).bind(...ids).all();
        const cliquesPorPsicologo = Object.fromEntries(cliquesRecentes.map(c => [Number(c.psicologo_id), c.total]));

        const hojeParaVaga = new Date();
        const fimParaVaga = new Date(hojeParaVaga); fimParaVaga.setDate(fimParaVaga.getDate() + 14);
        const feriadosSet = new Set(feriadosNoIntervalo(hojeParaVaga, fimParaVaga).map(f => f.data));

        psicologos = results.map(p => {
          const ocupadosSet = new Set(todosOcupados.filter(o => Number(o.psicologo_id) === Number(p.id)).map(o => o.data_hora));
          return {
            ...p,
            proxima_vaga: proximaVagaLivre(p, ocupadosSet, 14, feriadosSet),
            muito_procurado: (cliquesPorPsicologo[Number(p.id)] || 0) >= limite,
          };
        });
      }

      return json({ ok: true, psicologos });
    }

    const perfilMatch = pathname.match(/^\/api\/psicologos\/(\d+)$/);
    if (perfilMatch && request.method === 'GET') {
      await initDB(env.DB);
      const p = await env.DB.prepare(
        `SELECT id, nome, foto_url, bio, especialidades, abordagem, telefone, crp_numero, crp_estado,
                graduacao_curso, graduacao_instituicao, graduacao_mes_ano, pos_graduacoes,
                experiencias, projetos_relevantes,
                video_apresentacao_url, idiomas, instagram, site_pessoal,
                atende_adultos, atende_adolescentes, atende_criancas, atende_idosos, idade_minima_criancas,
                atende_presencial, endereco_presencial
         FROM psicologos
         WHERE id = ? AND status_aprovacao = 'aprovado' AND licenca_validade_ate >= date('now')`
      ).bind(perfilMatch[1]).first();
      if (!p) return json({ ok: false, error: 'Não encontrado.' }, 404);

      const { results: avals } = await env.DB.prepare(
        `SELECT nota FROM avaliacoes WHERE psicologo_id = ? AND status = 'publicado'`
      ).bind(perfilMatch[1]).all();
      const media = avals.length ? avals.reduce((s, a) => s + a.nota, 0) / avals.length : null;

      const { results: servicos } = await env.DB.prepare(
        `SELECT id, nome, valor, descricao FROM servicos_precos WHERE psicologo_id = ? ORDER BY ordem, id`
      ).bind(perfilMatch[1]).all();

      const { results: certificados } = await env.DB.prepare(
        `SELECT id, imagem_url, titulo FROM certificados WHERE psicologo_id = ? ORDER BY ordem, id`
      ).bind(perfilMatch[1]).all();

      const { results: galeria } = await env.DB.prepare(
        `SELECT id, imagem_url FROM galeria_fotos WHERE psicologo_id = ? ORDER BY ordem, id`
      ).bind(perfilMatch[1]).all();

      return json({ ok: true, psicologo: p, avaliacao_media: media, total_avaliacoes: avals.length, servicos, certificados, galeria });
    }

    // Tracking leve de visualização de perfil / clique no WhatsApp — público,
    // sem autenticação, chamado pelo próprio perfil.html. Base do gráfico de
    // "Visibilidade" e da badge "muito procurado".
    const eventoMatch = pathname.match(/^\/api\/psicologos\/(\d+)\/evento$/);
    if (eventoMatch && request.method === 'POST') {
      try {
        await initDB(env.DB);
        const { tipo } = await request.json();
        if (!['visualizacao', 'whatsapp_click'].includes(tipo)) return json({ ok: false }, 400);
        await env.DB.prepare('INSERT INTO eventos_perfil (psicologo_id, tipo) VALUES (?, ?)').bind(eventoMatch[1], tipo).run();
        return json({ ok: true });
      } catch {
        return json({ ok: true }); // tracking nunca deve quebrar a experiência do usuário
      }
    }

    if (pathname === '/api/psicologos/me/analytics' && request.method === 'GET') {
      const psicologoId = autenticadoPsicologo(request, env);
      if (!psicologoId) return json({ ok: false }, 401);
      await initDB(env.DB);
      const { results } = await env.DB.prepare(
        `SELECT date(criado_em) as dia, tipo, COUNT(*) as total
         FROM eventos_perfil
         WHERE psicologo_id = ? AND criado_em >= datetime('now', '-7 days')
         GROUP BY dia, tipo ORDER BY dia`
      ).bind(psicologoId).all();

      // Monta os últimos 7 dias com zero preenchido pros dias sem evento —
      // facilita desenhar o gráfico sem o front precisar tratar buracos.
      const dias = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date(); d.setDate(d.getDate() - i);
        dias.push(d.toISOString().slice(0, 10));
      }
      const porDia = dias.map(dia => {
        const visualizacoes = results.find(r => r.dia === dia && r.tipo === 'visualizacao')?.total || 0;
        const whatsapp = results.find(r => r.dia === dia && r.tipo === 'whatsapp_click')?.total || 0;
        return { dia, visualizacoes, whatsapp_clicks: whatsapp };
      });
      return json({ ok: true, dias: porDia });
    }

    /* ══════════════ API: Agenda / Disponibilidades (psicólogo autenticado) ══════════════ */

    if (pathname === '/api/psicologos/me/disponibilidades' && request.method === 'GET') {
      const psicologoId = autenticadoPsicologo(request, env);
      if (!psicologoId) return json({ ok: false }, 401);
      await initDB(env.DB);
      const { results } = await env.DB.prepare(
        'SELECT * FROM disponibilidades WHERE psicologo_id = ? AND ativo = 1 ORDER BY dia_semana, hora_inicio'
      ).bind(psicologoId).all();
      return json({ ok: true, disponibilidades: results });
    }

    if (pathname === '/api/psicologos/me/disponibilidades' && request.method === 'POST') {
      const psicologoId = autenticadoPsicologo(request, env);
      if (!psicologoId) return json({ ok: false }, 401);
      await initDB(env.DB);
      const { dia_semana, hora_inicio, hora_fim, duracao_minutos } = await request.json();
      if (dia_semana === undefined || !hora_inicio || !hora_fim) {
        return json({ ok: false, error: 'Dados obrigatórios ausentes.' }, 400);
      }
      await env.DB.prepare(
        `INSERT INTO disponibilidades (psicologo_id, dia_semana, hora_inicio, hora_fim, duracao_minutos)
         VALUES (?, ?, ?, ?, ?)`
      ).bind(psicologoId, dia_semana, hora_inicio, hora_fim, duracao_minutos || 50).run();
      return json({ ok: true });
    }

    const dispPutMatch = pathname.match(/^\/api\/psicologos\/me\/disponibilidades\/(\d+)$/);
    if (dispPutMatch && request.method === 'PUT') {
      const psicologoId = autenticadoPsicologo(request, env);
      if (!psicologoId) return json({ ok: false }, 401);
      await initDB(env.DB);
      const { dia_semana, hora_inicio, hora_fim, duracao_minutos } = await request.json();
      if (dia_semana === undefined || !hora_inicio || !hora_fim) {
        return json({ ok: false, error: 'Dados obrigatórios ausentes.' }, 400);
      }
      await env.DB.prepare(
        `UPDATE disponibilidades SET dia_semana = ?, hora_inicio = ?, hora_fim = ?, duracao_minutos = ?
         WHERE id = ? AND psicologo_id = ?`
      ).bind(dia_semana, hora_inicio, hora_fim, duracao_minutos || 50, dispPutMatch[1], psicologoId).run();
      return json({ ok: true });
    }

    const dispDeleteMatch = pathname.match(/^\/api\/psicologos\/me\/disponibilidades\/(\d+)$/);
    if (dispDeleteMatch && request.method === 'DELETE') {
      const psicologoId = autenticadoPsicologo(request, env);
      if (!psicologoId) return json({ ok: false }, 401);
      await initDB(env.DB);
      await env.DB.prepare('UPDATE disponibilidades SET ativo = 0 WHERE id = ? AND psicologo_id = ?')
        .bind(dispDeleteMatch[1], psicologoId).run();
      return json({ ok: true });
    }

    if (pathname === '/api/psicologos/me/agendamentos' && request.method === 'GET') {
      const psicologoId = autenticadoPsicologo(request, env);
      if (!psicologoId) return json({ ok: false }, 401);
      await initDB(env.DB);
      const { results } = await env.DB.prepare(
        `SELECT a.id, a.data_hora, a.status, p.nome as paciente_nome, p.telefone as paciente_telefone
         FROM agendamentos a JOIN pacientes p ON p.id = a.paciente_id
         WHERE a.psicologo_id = ? AND a.status = 'confirmado'
         ORDER BY a.data_hora`
      ).bind(psicologoId).all();
      return json({ ok: true, agendamentos: results });
    }

    const psicologoCancelaMatch = pathname.match(/^\/api\/psicologos\/me\/agendamentos\/(\d+)$/);
    if (psicologoCancelaMatch && request.method === 'DELETE') {
      const psicologoId = autenticadoPsicologo(request, env);
      if (!psicologoId) return json({ ok: false }, 401);
      await initDB(env.DB);

      const info = await env.DB.prepare(
        `SELECT a.data_hora, ps.nome as psicologo_nome, p.nome as paciente_nome, p.email as paciente_email
         FROM agendamentos a JOIN psicologos ps ON ps.id = a.psicologo_id JOIN pacientes p ON p.id = a.paciente_id
         WHERE a.id = ? AND a.psicologo_id = ? AND a.status = 'confirmado'`
      ).bind(psicologoCancelaMatch[1], psicologoId).first();
      if (!info) return json({ ok: false, error: 'Agendamento não encontrado.' }, 404);

      await env.DB.prepare(`UPDATE agendamentos SET status = 'cancelado' WHERE id = ?`).bind(psicologoCancelaMatch[1]).run();
      await enviarEmailCancelamentoParaPaciente(env, { nome: info.paciente_nome, email: info.paciente_email }, info.psicologo_nome, info.data_hora).catch(() => {});

      return json({ ok: true });
    }

    // Agenda unificada: agendamentos públicos confirmados + compromissos
    // manuais + feriados, todos com datas reais (não recorrentes), pra
    // alimentar o calendário do painel.
    if (pathname === '/api/psicologos/me/agenda' && request.method === 'GET') {
      const psicologoId = autenticadoPsicologo(request, env);
      if (!psicologoId) return json({ ok: false }, 401);
      await initDB(env.DB);

      const dias = Math.min(120, Math.max(1, Number(url.searchParams.get('dias')) || 14));
      const inicioParam = url.searchParams.get('inicio');
      const inicio = inicioParam ? new Date(inicioParam + 'T00:00:00') : new Date();
      inicio.setHours(0, 0, 0, 0);
      const fim = new Date(inicio); fim.setDate(fim.getDate() + dias);
      const inicioStr = formatarDataISO(inicio), fimStr = formatarDataISO(fim);

      const { results: agendamentos } = await env.DB.prepare(
        `SELECT a.id, a.data_hora, p.nome as paciente_nome, p.telefone as paciente_telefone
         FROM agendamentos a JOIN pacientes p ON p.id = a.paciente_id
         WHERE a.psicologo_id = ? AND a.status = 'confirmado' AND date(a.data_hora) >= ? AND date(a.data_hora) < ?
         ORDER BY a.data_hora`
      ).bind(psicologoId, inicioStr, fimStr).all();

      const { results: compromissos } = await env.DB.prepare(
        `SELECT id, paciente_nome, descricao, data_hora, tipo, serie_id FROM compromissos
         WHERE psicologo_id = ? AND date(data_hora) >= ? AND date(data_hora) < ?
         ORDER BY data_hora`
      ).bind(psicologoId, inicioStr, fimStr).all();

      const feriados = feriadosNoIntervalo(inicio, fim);

      return json({ ok: true, inicio: inicioStr, dias, agendamentos, compromissos, feriados });
    }

    if (pathname === '/api/psicologos/me/compromissos' && request.method === 'GET') {
      const psicologoId = autenticadoPsicologo(request, env);
      if (!psicologoId) return json({ ok: false }, 401);
      await initDB(env.DB);
      const { results } = await env.DB.prepare(
        'SELECT * FROM compromissos WHERE psicologo_id = ? ORDER BY data_hora'
      ).bind(psicologoId).all();
      return json({ ok: true, compromissos: results });
    }

    if (pathname === '/api/psicologos/me/compromissos' && request.method === 'POST') {
      const psicologoId = autenticadoPsicologo(request, env);
      if (!psicologoId) return json({ ok: false }, 401);
      await initDB(env.DB);
      const { paciente_nome, descricao, data_hora, tipo } = await request.json();
      if (!paciente_nome || !data_hora) return json({ ok: false, error: 'Nome do paciente e data/hora são obrigatórios.' }, 400);
      const TIPOS_VALIDOS = ['semanal', 'quinzenal', 'entrevista', 'avulso'];
      if (!TIPOS_VALIDOS.includes(tipo)) return json({ ok: false, error: 'Selecione um tipo: Semanal, Quinzenal, Entrevista ou Avulso.' }, 400);

      // Semanal/quinzenal: repete no mesmo dia da semana e horário até o fim
      // do ano corrente da data escolhida — todas as ocorrências ganham o
      // mesmo serie_id, o que permite editar/excluir "todos os outros
      // registros desse paciente" de uma vez depois. Entrevista/avulso: um
      // único registro, sem serie_id.
      const [dataBase, horaBase] = data_hora.split(' ');
      const passoDias = tipo === 'semanal' ? 7 : tipo === 'quinzenal' ? 14 : null;
      const serieId = passoDias ? crypto.randomUUID() : null;

      const datasOcorrencias = [dataBase];
      if (passoDias) {
        const inicio = new Date(dataBase + 'T00:00:00');
        const fimDoAno = new Date(inicio.getFullYear(), 11, 31);
        let cursor = new Date(inicio); cursor.setDate(cursor.getDate() + passoDias);
        while (cursor <= fimDoAno) {
          datasOcorrencias.push(formatarDataISO(cursor));
          cursor = new Date(cursor); cursor.setDate(cursor.getDate() + passoDias);
        }
      }

      // Não deixa criar em cima de um horário já ocupado — nem por outro
      // compromisso, nem por um agendamento público confirmado. Numa série
      // (semanal/quinzenal) isso pularia só as ocorrências em conflito, sem
      // travar a série inteira por causa de uma data.
      const { results: compromissosOcupados } = await env.DB.prepare(
        'SELECT data_hora FROM compromissos WHERE psicologo_id = ?'
      ).bind(psicologoId).all();
      const { results: agendamentosOcupados } = await env.DB.prepare(
        `SELECT data_hora FROM agendamentos WHERE psicologo_id = ? AND status IN ('confirmado', 'pendente_verificacao')`
      ).bind(psicologoId).all();
      const ocupadosSet = new Set([...compromissosOcupados, ...agendamentosOcupados].map(o => o.data_hora));

      const datasLivres = datasOcorrencias.filter(d => !ocupadosSet.has(`${d} ${horaBase}`));
      if (!datasLivres.length) {
        return json({ ok: false, error: 'Esse horário já está ocupado.' }, 409);
      }

      let primeiroId = null;
      for (let i = 0; i < datasLivres.length; i++) {
        const dataHoraOcorrencia = `${datasLivres[i]} ${horaBase}`;
        const result = await env.DB.prepare(
          `INSERT INTO compromissos (psicologo_id, paciente_nome, descricao, data_hora, tipo, serie_id) VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(psicologoId, paciente_nome, descricao || null, dataHoraOcorrencia, tipo, serieId).run();
        if (i === 0) primeiroId = result.meta.last_row_id;
      }
      const puladas = datasOcorrencias.length - datasLivres.length;
      return json({ ok: true, id: primeiroId, ocorrencias: datasLivres.length, puladas_por_conflito: puladas });
    }

    const compromissoMatch = pathname.match(/^\/api\/psicologos\/me\/compromissos\/(\d+)$/);
    if (compromissoMatch && request.method === 'PUT') {
      const psicologoId = autenticadoPsicologo(request, env);
      if (!psicologoId) return json({ ok: false }, 401);
      await initDB(env.DB);
      const { paciente_nome, descricao, data_hora, tipo, aplicar_serie } = await request.json();
      if (!paciente_nome || !data_hora) return json({ ok: false, error: 'Nome do paciente e data/hora são obrigatórios.' }, 400);
      const TIPOS_VALIDOS = ['semanal', 'quinzenal', 'entrevista', 'avulso'];
      if (!TIPOS_VALIDOS.includes(tipo)) return json({ ok: false, error: 'Selecione um tipo: Semanal, Quinzenal, Entrevista ou Avulso.' }, 400);

      const conflitoCompromisso = await env.DB.prepare(
        'SELECT id FROM compromissos WHERE psicologo_id = ? AND data_hora = ? AND id != ?'
      ).bind(psicologoId, data_hora, compromissoMatch[1]).first();
      const conflitoAgendamento = await env.DB.prepare(
        `SELECT id FROM agendamentos WHERE psicologo_id = ? AND data_hora = ? AND status IN ('confirmado', 'pendente_verificacao')`
      ).bind(psicologoId, data_hora).first();
      if (conflitoCompromisso || conflitoAgendamento) {
        return json({ ok: false, error: 'Esse horário já está ocupado.' }, 409);
      }

      if (aplicar_serie) {
        // Propaga nome/descrição/tipo pra todos os outros registros da mesma
        // série — mas NÃO a data/hora, que é específica de cada ocorrência.
        const atual = await env.DB.prepare('SELECT serie_id FROM compromissos WHERE id = ? AND psicologo_id = ?')
          .bind(compromissoMatch[1], psicologoId).first();
        if (atual?.serie_id) {
          await env.DB.prepare(
            `UPDATE compromissos SET paciente_nome = ?, descricao = ?, tipo = ? WHERE serie_id = ? AND psicologo_id = ?`
          ).bind(paciente_nome, descricao || null, tipo, atual.serie_id, psicologoId).run();
          // A ocorrência clicada também recebe a nova data/hora individualmente.
          await env.DB.prepare(
            `UPDATE compromissos SET data_hora = ? WHERE id = ? AND psicologo_id = ?`
          ).bind(data_hora, compromissoMatch[1], psicologoId).run();
          return json({ ok: true });
        }
      }

      await env.DB.prepare(
        `UPDATE compromissos SET paciente_nome = ?, descricao = ?, data_hora = ?, tipo = ? WHERE id = ? AND psicologo_id = ?`
      ).bind(paciente_nome, descricao || null, data_hora, tipo, compromissoMatch[1], psicologoId).run();
      return json({ ok: true });
    }

    if (compromissoMatch && request.method === 'DELETE') {
      const psicologoId = autenticadoPsicologo(request, env);
      if (!psicologoId) return json({ ok: false }, 401);
      await initDB(env.DB);
      const aplicarSerie = url.searchParams.get('serie') === '1';

      if (aplicarSerie) {
        const atual = await env.DB.prepare('SELECT serie_id FROM compromissos WHERE id = ? AND psicologo_id = ?')
          .bind(compromissoMatch[1], psicologoId).first();
        if (atual?.serie_id) {
          await env.DB.prepare('DELETE FROM compromissos WHERE serie_id = ? AND psicologo_id = ?')
            .bind(atual.serie_id, psicologoId).run();
          return json({ ok: true });
        }
      }

      await env.DB.prepare('DELETE FROM compromissos WHERE id = ? AND psicologo_id = ?')
        .bind(compromissoMatch[1], psicologoId).run();
      return json({ ok: true });
    }

    /* ══════════════ API: Conta do paciente ══════════════
       O paciente já podia existir sem senha (criado automaticamente ao
       agendar ou avaliar sem conta). O cadastro aqui "reivindica" essa linha
       existente (mesmo e-mail) definindo uma senha, em vez de duplicar. */

    if (pathname === '/api/pacientes/cadastro' && request.method === 'POST') {
      try {
        await initDB(env.DB);
        const { nome, email, telefone, senha } = await request.json();
        if (!nome || !email || !senha) return json({ ok: false, error: 'Nome, e-mail e senha são obrigatórios.' }, 400);
        if (senha.length < 6) return json({ ok: false, error: 'Senha precisa ter ao menos 6 caracteres.' }, 400);

        const existente = await env.DB.prepare('SELECT id, senha_hash FROM pacientes WHERE email = ?').bind(email).first();
        if (existente?.senha_hash) return json({ ok: false, error: 'Esse e-mail já tem uma conta — faça login.' }, 400);

        const senhaHash = await hashSenha(senha, env);
        if (existente) {
          await env.DB.prepare('UPDATE pacientes SET nome = ?, telefone = COALESCE(?, telefone), senha_hash = ? WHERE id = ?')
            .bind(nome, telefone || null, senhaHash, existente.id).run();
          return json({ ok: true, id: existente.id });
        }
        const result = await env.DB.prepare('INSERT INTO pacientes (nome, email, telefone, senha_hash) VALUES (?, ?, ?, ?)')
          .bind(nome, email, telefone || null, senhaHash).run();
        return json({ ok: true, id: result.meta.last_row_id });
      } catch (e) {
        return json({ ok: false, error: e.message }, 500);
      }
    }

    if (pathname === '/api/pacientes/login' && request.method === 'POST') {
      try {
        await initDB(env.DB);
        const { email, senha } = await request.json();
        const senhaHash = await hashSenha(senha, env);
        const paciente = await env.DB.prepare('SELECT id, nome FROM pacientes WHERE email = ? AND senha_hash = ?')
          .bind(email, senhaHash).first();
        if (!paciente) return json({ ok: false, error: 'E-mail ou senha incorretos.' }, 401);
        const token = btoa(`paciente:${paciente.id}:${Date.now()}:${env.SENHA_PEPPER || ''}`);
        return json({ ok: true, token, nome: paciente.nome });
      } catch (e) {
        return json({ ok: false, error: e.message }, 500);
      }
    }

    if (pathname === '/api/pacientes/esqueci-senha' && request.method === 'POST') {
      try {
        await initDB(env.DB);
        const { email } = await request.json();
        const paciente = await env.DB.prepare('SELECT id, nome, email FROM pacientes WHERE email = ? AND senha_hash IS NOT NULL').bind(email).first();
        if (paciente) {
          const token = gerarToken();
          const expira = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
          await env.DB.prepare(
            `INSERT INTO tokens_verificacao (tipo, referencia_id, token, expira_em) VALUES ('reset_senha_paciente', ?, ?, ?)`
          ).bind(paciente.id, token, expira).run();
          const link = `${url.origin}/minha-conta/redefinir-senha.html?token=${token}`;
          await enviarEmailRedefinirSenha(env, paciente, link);
        }
        return json({ ok: true });
      } catch (e) {
        return json({ ok: false, error: e.message }, 500);
      }
    }

    if (pathname === '/api/pacientes/redefinir-senha' && request.method === 'POST') {
      try {
        await initDB(env.DB);
        const { token, senha } = await request.json();
        if (!token || !senha || senha.length < 6) return json({ ok: false, error: 'Senha precisa ter ao menos 6 caracteres.' }, 400);
        const registro = await env.DB.prepare(
          `SELECT * FROM tokens_verificacao WHERE token = ? AND tipo = 'reset_senha_paciente'`
        ).bind(token).first();
        if (!registro) return json({ ok: false, error: 'Link inválido.' }, 400);
        if (registro.usado_em) return json({ ok: false, error: 'Esse link já foi usado.' }, 400);
        if (new Date(registro.expira_em) < new Date()) return json({ ok: false, error: 'Esse link expirou. Solicite outro.' }, 400);

        const senhaHash = await hashSenha(senha, env);
        await env.DB.prepare('UPDATE pacientes SET senha_hash = ? WHERE id = ?').bind(senhaHash, registro.referencia_id).run();
        await env.DB.prepare(`UPDATE tokens_verificacao SET usado_em = datetime('now') WHERE id = ?`).bind(registro.id).run();
        return json({ ok: true });
      } catch (e) {
        return json({ ok: false, error: e.message }, 500);
      }
    }

    if (pathname === '/api/pacientes/me' && request.method === 'GET') {
      const pacienteId = autenticadoPaciente(request, env);
      if (!pacienteId) return json({ ok: false }, 401);
      await initDB(env.DB);
      const p = await env.DB.prepare('SELECT id, nome, email, telefone FROM pacientes WHERE id = ?').bind(pacienteId).first();
      if (!p) return json({ ok: false }, 404);
      return json({ ok: true, paciente: p });
    }

    if (pathname === '/api/pacientes/me/agendamentos' && request.method === 'GET') {
      const pacienteId = autenticadoPaciente(request, env);
      if (!pacienteId) return json({ ok: false }, 401);
      await initDB(env.DB);
      const { results } = await env.DB.prepare(
        `SELECT a.id, a.data_hora, a.status, ps.id as psicologo_id, ps.nome as psicologo_nome, ps.foto_url as psicologo_foto
         FROM agendamentos a
         JOIN psicologos ps ON ps.id = a.psicologo_id
         WHERE a.paciente_id = (SELECT id FROM pacientes WHERE id = ?) AND a.status = 'confirmado'
         ORDER BY a.data_hora DESC`
      ).bind(pacienteId).all();
      return json({ ok: true, agendamentos: results });
    }

    const pacienteCancelaMatch = pathname.match(/^\/api\/pacientes\/me\/agendamentos\/(\d+)$/);
    if (pacienteCancelaMatch && request.method === 'DELETE') {
      const pacienteId = autenticadoPaciente(request, env);
      if (!pacienteId) return json({ ok: false }, 401);
      await initDB(env.DB);

      const info = await env.DB.prepare(
        `SELECT a.data_hora, ps.nome as psicologo_nome, ps.email as psicologo_email, p.nome as paciente_nome
         FROM agendamentos a JOIN psicologos ps ON ps.id = a.psicologo_id JOIN pacientes p ON p.id = a.paciente_id
         WHERE a.id = ? AND a.paciente_id = ? AND a.status = 'confirmado'`
      ).bind(pacienteCancelaMatch[1], pacienteId).first();
      if (!info) return json({ ok: false, error: 'Agendamento não encontrado.' }, 404);

      await env.DB.prepare(`UPDATE agendamentos SET status = 'cancelado' WHERE id = ?`).bind(pacienteCancelaMatch[1]).run();
      await enviarEmailCancelamentoParaPsicologo(env, { nome: info.psicologo_nome, email: info.psicologo_email }, info.paciente_nome, info.data_hora).catch(() => {});

      return json({ ok: true });
    }

    // Cruza com o banco do projeto Testes (participantes) pelo e-mail —
    // são dois D1 diferentes, ligados aqui só pra essa consulta de leitura.
    if (pathname === '/api/pacientes/me/testes' && request.method === 'GET') {
      const pacienteId = autenticadoPaciente(request, env);
      if (!pacienteId) return json({ ok: false }, 401);
      await initDB(env.DB);
      try {
        const paciente = await env.DB.prepare('SELECT email FROM pacientes WHERE id = ?').bind(pacienteId).first();
        if (!paciente || !env.TESTES_DB) return json({ ok: true, registros: [] });
        const { results } = await env.TESTES_DB.prepare(
          `SELECT tipo, identificador, faixa_geral, resultados, criado_em FROM participantes WHERE email = ? ORDER BY criado_em DESC`
        ).bind(paciente.email).all();
        return json({ ok: true, registros: results });
      } catch (e) {
        return json({ ok: true, registros: [], aviso: 'Não foi possível consultar os testes agora.' });
      }
    }

    /* ══════════════ API: Horários disponíveis + agendamento (público) ══════════════ */

    const horariosMatch = pathname.match(/^\/api\/psicologos\/(\d+)\/horarios-disponiveis$/);
    if (horariosMatch && request.method === 'GET') {
      await initDB(env.DB);
      const psicologoId = horariosMatch[1];
      const diasAFrente = 15;

      const psicologo = await env.DB.prepare(
        'SELECT horario_trabalho_inicio, horario_trabalho_fim, horario_trabalho_dias FROM psicologos WHERE id = ?'
      ).bind(psicologoId).first();
      if (!psicologo) return json({ ok: false, error: 'Não encontrado.' }, 404);

      // Bloqueia tanto agendamentos públicos (confirmados ou aguardando
      // confirmação) quanto compromissos que o próprio psicólogo marcou
      // manualmente na Agenda — ambos "travam" o horário pro site.
      const { results: ocupadosAgendamentos } = await env.DB.prepare(
        `SELECT data_hora FROM agendamentos WHERE psicologo_id = ? AND status IN ('confirmado', 'pendente_verificacao') AND data_hora >= datetime('now')`
      ).bind(psicologoId).all();
      const { results: ocupadosCompromissos } = await env.DB.prepare(
        `SELECT data_hora FROM compromissos WHERE psicologo_id = ? AND data_hora >= datetime('now')`
      ).bind(psicologoId).all();
      const ocupadosSet = new Set([...ocupadosAgendamentos, ...ocupadosCompromissos].map(o => o.data_hora.slice(0, 16)));

      const slots = [];
      const agora = new Date();
      const fimIntervalo = new Date(agora); fimIntervalo.setDate(fimIntervalo.getDate() + diasAFrente);
      const feriadosSet = new Set(feriadosNoIntervalo(agora, fimIntervalo).map(f => f.data));

      for (let d = 1; d <= diasAFrente; d++) {
        const dia = new Date(agora);
        dia.setDate(dia.getDate() + d);
        if (feriadosSet.has(formatarDataISO(dia))) continue; // feriado — não oferece horário público nesse dia

        horariosDoDiaPeloTrabalho(psicologo, dia.getDay()).forEach(hora => {
          const iso = `${formatarDataISO(dia)} ${hora}`;
          if (!ocupadosSet.has(iso)) slots.push(iso);
        });
      }

      slots.sort();
      return json({ ok: true, horarios: slots });
    }

    const agendarMatch = pathname.match(/^\/api\/psicologos\/(\d+)\/agendar$/);
    if (agendarMatch && request.method === 'POST') {
      try {
        await initDB(env.DB);
        const psicologoId = agendarMatch[1];
        const { nome, email, telefone, data_hora } = await request.json();
        if (!nome || !email || !data_hora) return json({ ok: false, error: 'Dados obrigatórios ausentes.' }, 400);

        let paciente = await env.DB.prepare('SELECT id FROM pacientes WHERE email = ?').bind(email).first();
        if (!paciente) {
          const r = await env.DB.prepare('INSERT INTO pacientes (nome, email, telefone) VALUES (?, ?, ?)')
            .bind(nome, email, telefone || null).run();
          paciente = { id: r.meta.last_row_id };
        }

        const result = await env.DB.prepare(
          `INSERT INTO agendamentos (psicologo_id, paciente_id, data_hora, status) VALUES (?, ?, ?, 'pendente_verificacao')`
        ).bind(psicologoId, paciente.id, data_hora).run();

        const token = gerarToken();
        const expira = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        await env.DB.prepare(
          `INSERT INTO tokens_verificacao (tipo, referencia_id, token, expira_em) VALUES ('agendamento', ?, ?, ?)`
        ).bind(result.meta.last_row_id, token, expira).run();

        const link = `${url.origin}/api/agendamentos/confirmar?token=${token}`;
        await enviarEmailConfirmacaoAgendamento(env, { nome, email }, data_hora, link);

        return json({ ok: true });
      } catch (e) {
        if (String(e.message).includes('UNIQUE')) {
          return json({ ok: false, error: 'Esse horário acabou de ser reservado por outra pessoa — escolha outro.' }, 409);
        }
        return json({ ok: false, error: e.message }, 500);
      }
    }

    if (pathname === '/api/agendamentos/confirmar' && request.method === 'GET') {
      await initDB(env.DB);
      const token = url.searchParams.get('token');
      const registro = await env.DB.prepare(
        `SELECT * FROM tokens_verificacao WHERE token = ? AND tipo = 'agendamento'`
      ).bind(token).first();

      if (!registro || registro.usado_em || new Date(registro.expira_em) < new Date()) {
        return Response.redirect(`${url.origin}/agendamento-confirmado.html?ok=0`, 302);
      }

      await env.DB.prepare(`UPDATE agendamentos SET status = 'confirmado' WHERE id = ?`).bind(registro.referencia_id).run();
      await env.DB.prepare(`UPDATE tokens_verificacao SET usado_em = datetime('now') WHERE id = ?`).bind(registro.id).run();
      await env.DB.prepare(
        `UPDATE pacientes SET email_verificado = 1, email_verificado_em = datetime('now')
         WHERE id = (SELECT paciente_id FROM agendamentos WHERE id = ?)`
      ).bind(registro.referencia_id).run();

      // Avisa o psicólogo por e-mail que tem um agendamento novo confirmado.
      const agendamentoInfo = await env.DB.prepare(
        `SELECT a.data_hora, a.psicologo_id, p.nome as paciente_nome, p.telefone as paciente_telefone, ps.nome as psicologo_nome, ps.email as psicologo_email
         FROM agendamentos a JOIN pacientes p ON p.id = a.paciente_id JOIN psicologos ps ON ps.id = a.psicologo_id
         WHERE a.id = ?`
      ).bind(registro.referencia_id).first();
      if (agendamentoInfo) {
        await enviarEmailNovoAgendamentoPsicologo(
          env,
          { nome: agendamentoInfo.psicologo_nome, email: agendamentoInfo.psicologo_email },
          { nome: agendamentoInfo.paciente_nome, telefone: agendamentoInfo.paciente_telefone },
          agendamentoInfo.data_hora
        ).catch(() => {}); // não deixa a confirmação falhar por causa do e-mail
      }

      return Response.redirect(`${url.origin}/agendamento-confirmado.html?ok=1`, 302);
    }

    /* ══════════════ API: Avaliações ══════════════ */

    const avalPostMatch = pathname.match(/^\/api\/psicologos\/(\d+)\/avaliacoes$/);
    if (avalPostMatch && request.method === 'POST') {
      try {
        await initDB(env.DB);
        const psicologoId = avalPostMatch[1];
        const { nome, email, nota, comentario } = await request.json();

        if (!nome || !email || !nota || nota < 1 || nota > 5) {
          return json({ ok: false, error: 'Dados obrigatórios ausentes ou nota inválida.' }, 400);
        }

        // Vincula a um agendamento concluído (sessão passada, confirmada)
        // desse mesmo e-mail com esse psicólogo, se existir — habilita o
        // selo de "paciente verificado" sem exigir cadastro prévio.
        const agendamento = await env.DB.prepare(
          `SELECT a.id FROM agendamentos a JOIN pacientes p ON p.id = a.paciente_id
           WHERE a.psicologo_id = ? AND p.email = ? AND a.status = 'confirmado' AND a.data_hora < datetime('now')
           ORDER BY a.data_hora DESC LIMIT 1`
        ).bind(psicologoId, email).first();

        const result = await env.DB.prepare(
          `INSERT INTO avaliacoes (psicologo_id, avaliador_nome, avaliador_email, nota, comentario, agendamento_id)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(psicologoId, nome, email, nota, comentario || null, agendamento?.id || null).run();

        const token = gerarToken();
        const expira = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        await env.DB.prepare(
          `INSERT INTO tokens_verificacao (tipo, referencia_id, token, expira_em) VALUES ('avaliacao', ?, ?, ?)`
        ).bind(result.meta.last_row_id, token, expira).run();

        const link = `${url.origin}/api/avaliacoes/confirmar?token=${token}`;
        await enviarEmailConfirmacaoAvaliacao(env, { avaliador_nome: nome, avaliador_email: email }, link);

        return json({ ok: true });
      } catch (e) {
        if (String(e.message).includes('UNIQUE')) {
          return json({ ok: false, error: 'Esse e-mail já avaliou este profissional.' }, 409);
        }
        return json({ ok: false, error: e.message }, 500);
      }
    }

    const avalGetMatch = pathname.match(/^\/api\/psicologos\/(\d+)\/avaliacoes$/);
    if (avalGetMatch && request.method === 'GET') {
      await initDB(env.DB);
      const { results } = await env.DB.prepare(
        `SELECT avaliador_nome, nota, comentario, criado_em,
                (agendamento_id IS NOT NULL) as verificado
         FROM avaliacoes WHERE psicologo_id = ? AND status = 'publicado' ORDER BY criado_em DESC`
      ).bind(avalGetMatch[1]).all();
      return json({ ok: true, avaliacoes: results });
    }

    // Admin — mesma lista, mas com o ID (necessário pra poder excluir) e
    // incluindo avaliações em qualquer status (não só publicadas).
    const avalAdminMatch = pathname.match(/^\/api\/admin\/psicologos\/(\d+)\/avaliacoes$/);
    if (avalAdminMatch && request.method === 'GET') {
      if (!autenticadoAdmin(request, env)) return json({ ok: false }, 401);
      await initDB(env.DB);
      const { results } = await env.DB.prepare(
        `SELECT id, avaliador_nome, avaliador_email, nota, comentario, status, criado_em FROM avaliacoes
         WHERE psicologo_id = ? ORDER BY criado_em DESC`
      ).bind(avalAdminMatch[1]).all();
      return json({ ok: true, avaliacoes: results });
    }

    if (pathname === '/api/avaliacoes/confirmar' && request.method === 'GET') {
      await initDB(env.DB);
      const token = url.searchParams.get('token');
      const registro = await env.DB.prepare(
        `SELECT * FROM tokens_verificacao WHERE token = ? AND tipo = 'avaliacao'`
      ).bind(token).first();

      if (!registro || registro.usado_em || new Date(registro.expira_em) < new Date()) {
        return Response.redirect(`${url.origin}/avaliacao-confirmada.html?ok=0`, 302);
      }

      await env.DB.prepare(`UPDATE avaliacoes SET status = 'publicado' WHERE id = ?`).bind(registro.referencia_id).run();
      await env.DB.prepare(`UPDATE tokens_verificacao SET usado_em = datetime('now') WHERE id = ?`).bind(registro.id).run();

      return Response.redirect(`${url.origin}/avaliacao-confirmada.html?ok=1`, 302);
    }

    /* ══════════════ API: Admin ══════════════ */

    if (pathname === '/api/admin/login' && request.method === 'POST') {
      const { usuario, senha } = await request.json();
      if (usuario === env.ADMIN_USER && senha === env.ADMIN_PASS) {
        return json({ ok: true, token: btoa(`${usuario}:${Date.now()}:${env.ADMIN_PASS}`) });
      }
      return json({ ok: false }, 401);
    }

    if (pathname === '/api/admin/configuracoes' && request.method === 'GET') {
      if (!autenticadoAdmin(request, env)) return json({ ok: false }, 401);
      await initDB(env.DB);
      const { results } = await env.DB.prepare('SELECT chave, valor FROM configuracoes').all();
      return json({ ok: true, configuracoes: Object.fromEntries(results.map(c => [c.chave, c.valor])) });
    }

    if (pathname === '/api/admin/configuracoes' && request.method === 'PUT') {
      if (!autenticadoAdmin(request, env)) return json({ ok: false }, 401);
      await initDB(env.DB);
      const body = await request.json();
      for (const [chave, valor] of Object.entries(body)) {
        await env.DB.prepare('INSERT INTO configuracoes (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor')
          .bind(chave, String(valor)).run();
      }
      return json({ ok: true });
    }

    if (pathname === '/api/admin/psicologos' && request.method === 'GET') {
      if (!autenticadoAdmin(request, env)) return json({ ok: false }, 401);
      await initDB(env.DB);
      const { results } = await env.DB.prepare('SELECT * FROM psicologos ORDER BY criado_em DESC').all();
      results.forEach(p => delete p.senha_hash);
      return json({ ok: true, psicologos: results });
    }

    const aprovarMatch = pathname.match(/^\/api\/admin\/psicologos\/(\d+)\/aprovar$/);
    if (aprovarMatch && request.method === 'POST') {
      if (!autenticadoAdmin(request, env)) return json({ ok: false }, 401);
      await initDB(env.DB);
      const { status } = await request.json(); // 'aprovado' | 'rejeitado'
      await env.DB.prepare(
        `UPDATE psicologos SET status_aprovacao = ?, aprovado_em = datetime('now') WHERE id = ?`
      ).bind(status, aprovarMatch[1]).run();
      return json({ ok: true });
    }

    const licencaMatch = pathname.match(/^\/api\/admin\/psicologos\/(\d+)\/licenca$/);
    if (licencaMatch && request.method === 'POST') {
      if (!autenticadoAdmin(request, env)) return json({ ok: false }, 401);
      await initDB(env.DB);
      const psicologoId = licencaMatch[1];
      const { acao, dias, validade_ate, observacao } = await request.json();

      const atual = await env.DB.prepare('SELECT licenca_validade_ate FROM psicologos WHERE id = ?').bind(psicologoId).first();
      let novaValidade = validade_ate || null;
      let diasAdicionados = dias || null;
      let novoStatus = 'ativa';

      if (acao === 'renovar' && dias) {
        const base = atual?.licenca_validade_ate && new Date(atual.licenca_validade_ate) > new Date()
          ? new Date(atual.licenca_validade_ate) : new Date();
        base.setDate(base.getDate() + Number(dias));
        novaValidade = base.toISOString().slice(0, 10);
      } else if (acao === 'suspender') {
        novoStatus = 'suspensa';
      } else if (acao === 'reativar') {
        novoStatus = 'ativa';
      }

      await env.DB.prepare(
        `UPDATE psicologos SET licenca_status = ?, licenca_validade_ate = COALESCE(?, licenca_validade_ate), licenca_observacoes = ? WHERE id = ?`
      ).bind(novoStatus, novaValidade, observacao || null, psicologoId).run();

      await env.DB.prepare(
        `INSERT INTO licenca_historico (psicologo_id, acao, dias_adicionados, validade_anterior, validade_nova, observacao)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(psicologoId, acao, diasAdicionados, atual?.licenca_validade_ate || null, novaValidade, observacao || null).run();

      return json({ ok: true });
    }

    const avalDeleteMatch = pathname.match(/^\/api\/admin\/avaliacoes\/(\d+)$/);
    if (avalDeleteMatch && request.method === 'DELETE') {
      if (!autenticadoAdmin(request, env)) return json({ ok: false }, 401);
      await initDB(env.DB);
      const { motivo } = await request.json().catch(() => ({}));
      await env.DB.prepare(`UPDATE avaliacoes SET status = 'removido_pelo_admin' WHERE id = ?`).bind(avalDeleteMatch[1]).run();
      await env.DB.prepare(`INSERT INTO avaliacoes_log (avaliacao_id, motivo) VALUES (?, ?)`).bind(avalDeleteMatch[1], motivo || null).run();
      return json({ ok: true });
    }

    /* ── Régua de e-mail (admin) ── */

    if (pathname === '/api/admin/campanhas-email/imagem' && request.method === 'POST') {
      if (!autenticadoAdmin(request, env)) return json({ ok: false }, 401);
      if (!env.FOTOS_BUCKET) return json({ ok: false, error: 'Upload de imagem temporariamente indisponível.' }, 503);
      try {
        const form = await request.formData();
        const imagem = form.get('imagem');
        if (!imagem || !imagem.size) return json({ ok: false, error: 'Nenhuma imagem enviada.' }, 400);
        const ext = (imagem.name || '').split('.').pop() || 'jpg';
        const key = `campanhas/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
        await env.FOTOS_BUCKET.put(key, await imagem.arrayBuffer(), { httpMetadata: { contentType: imagem.type } });
        return json({ ok: true, imagem_url: `${url.origin}/fotos/${key}` });
      } catch (e) {
        return json({ ok: false, error: e.message }, 500);
      }
    }

    if (pathname === '/api/admin/campanhas-email/destinatarios' && request.method === 'GET') {
      if (!autenticadoAdmin(request, env)) return json({ ok: false }, 401);
      await initDB(env.DB);
      const destinatarios = await resolverPublicoCampanha(env, url.searchParams.get('publico') || 'todos');
      return json({ ok: true, total: destinatarios.length, nomes: destinatarios.slice(0, 8).map(d => d.nome) });
    }

    if (pathname === '/api/admin/campanhas-email/preview' && request.method === 'POST') {
      if (!autenticadoAdmin(request, env)) return json({ ok: false }, 401);
      const { paragrafos, imagem_url, botao_texto, botao_link } = await request.json();
      const html = montarHtmlEmailBasico({ paragrafos: paragrafos || [], imagemUrl: imagem_url || null, tituloBotao: botao_texto || null, linkBotao: botao_link || null });
      return json({ ok: true, html });
    }

    if (pathname === '/api/admin/campanhas-email' && request.method === 'GET') {
      if (!autenticadoAdmin(request, env)) return json({ ok: false }, 401);
      await initDB(env.DB);
      const { results } = await env.DB.prepare('SELECT * FROM campanhas_email ORDER BY enviado_em DESC LIMIT 50').all();
      return json({ ok: true, campanhas: results });
    }

    if (pathname === '/api/admin/campanhas-email/enviar' && request.method === 'POST') {
      if (!autenticadoAdmin(request, env)) return json({ ok: false }, 401);
      await initDB(env.DB);
      const { assunto, paragrafos, imagem_url, botao_texto, botao_link, publico } = await request.json();
      if (!assunto || !Array.isArray(paragrafos) || !paragrafos.length) {
        return json({ ok: false, error: 'Assunto e ao menos um parágrafo são obrigatórios.' }, 400);
      }
      const destinatarios = await resolverPublicoCampanha(env, publico || 'todos');
      if (!destinatarios.length) return json({ ok: false, error: 'Nenhum psicólogo se encaixa nesse recorte.' }, 400);

      // Dispara em série (não em paralelo) pra não estourar o rate limit da
      // Resend — o volume aqui é baixo (algumas dezenas de psicólogos), não
      // milhares, então o tempo total é aceitável dentro do CPU time do Worker.
      let enviados = 0;
      for (const d of destinatarios) {
        try {
          await enviarEmailBasico(env, {
            destinatario: d.email, assunto, paragrafos,
            imagemUrl: imagem_url || null, tituloBotao: botao_texto || null, linkBotao: botao_link || null,
          });
          enviados++;
        } catch {}
      }

      await env.DB.prepare(
        `INSERT INTO campanhas_email (assunto, paragrafos, imagem_url, botao_texto, botao_link, publico, total_destinatarios)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(assunto, JSON.stringify(paragrafos), imagem_url || null, botao_texto || null, botao_link || null, publico || 'todos', enviados).run();

      return json({ ok: true, enviados, total: destinatarios.length });
    }

    // Meta tags dinâmicas (og:title/description/image) pro link de cada
    // psicólogo — sem isso, compartilhar o perfil no WhatsApp/Facebook
    // mostrava sempre o preview genérico "Perfil do Psicólogo · O Seu
    // Psico" (o <title> real só era setado via JS, depois que o link
    // preview já tinha sido gerado pelo servidor de quem compartilhou).
    if (pathname === '/psicologos/perfil.html' && url.searchParams.get('id')) {
      try {
        await initDB(env.DB);
        const p = await env.DB.prepare(
          `SELECT nome, foto_url, bio FROM psicologos WHERE id = ? AND status_aprovacao = 'aprovado' AND licenca_validade_ate >= date('now')`
        ).bind(url.searchParams.get('id')).first();
        if (p) {
          // env.ASSETS.fetch às vezes devolve um 307 interno (normaliza
          // "/perfil.html" -> "/perfil") em vez do HTML — segue esse
          // redirect manualmente antes de reescrever, senão o HTMLRewriter
          // roda em cima de uma resposta vazia.
          let assetResponse = await env.ASSETS.fetch(request);
          if ([301, 302, 307, 308].includes(assetResponse.status) && assetResponse.headers.get('Location')) {
            const redirectUrl = new URL(assetResponse.headers.get('Location'), url.origin);
            assetResponse = await env.ASSETS.fetch(new Request(redirectUrl, request));
          }
          const titulo = escapeHtml(`${p.nome} · O Seu Psico`);
          const descricao = escapeHtml((p.bio || 'Perfil de psicólogo verificado em O Seu Psico.').slice(0, 160));
          // og:image precisa ser URL absoluta — foto_url é salva como
          // caminho relativo (/fotos/...), então completa com a origem.
          const imagemBase = p.foto_url ? (p.foto_url.startsWith('http') ? p.foto_url : `${url.origin}${p.foto_url}`) : `${url.origin}/assets/logo.png`;
          const imagem = escapeHtml(imagemBase);
          return new HTMLRewriter()
            .on('head', { element(el) {
              el.append(
                `<meta property="og:title" content="${titulo}" />` +
                `<meta property="og:description" content="${descricao}" />` +
                `<meta property="og:image" content="${imagem}" />` +
                `<meta property="og:type" content="profile" />` +
                `<meta name="twitter:card" content="summary_large_image" />`,
                { html: true }
              );
            } })
            .on('title', { element(el) { el.setInnerContent(titulo); } })
            .transform(assetResponse);
        }
      } catch {} // qualquer erro aqui cai no fallback normal, sem quebrar a página
    }

    return env.ASSETS.fetch(request);
  },

  // Roda a cada hora cheia (config em wrangler.jsonc). Pra cada psicólogo
  // cujo horário preferido bate com a hora local atual (Brasil, UTC-3, sem
  // horário de verão desde 2019), monta a agenda de amanhã (agendamentos
  // confirmados + compromissos manuais) e só envia e-mail se houver algo —
  // silêncio total nos dias vazios, como pedido.
  async scheduled(event, env, ctx) {
    await initDB(env.DB);
    const agoraUTC = new Date();
    const horaLocal = (agoraUTC.getUTCHours() - 3 + 24) % 24;
    const horaLocalStr = String(horaLocal).padStart(2, '0') + ':00';

    const { results: psicologos } = await env.DB.prepare(
      `SELECT id, nome, email FROM psicologos
       WHERE status_aprovacao = 'aprovado' AND licenca_validade_ate >= date('now') AND receber_agenda_email = 1 AND hora_notificacao_diaria = ?`
    ).bind(horaLocalStr).all();

    for (const psicologo of psicologos) {
      const { results: agendamentosAmanha } = await env.DB.prepare(
        `SELECT a.data_hora, p.nome, NULL as descricao
         FROM agendamentos a JOIN pacientes p ON p.id = a.paciente_id
         WHERE a.psicologo_id = ? AND a.status = 'confirmado' AND date(a.data_hora) = date('now', '+1 day')`
      ).bind(psicologo.id).all();

      const { results: compromissosAmanha } = await env.DB.prepare(
        `SELECT data_hora, paciente_nome as nome, descricao
         FROM compromissos WHERE psicologo_id = ? AND date(data_hora) = date('now', '+1 day')`
      ).bind(psicologo.id).all();

      const itens = [...agendamentosAmanha, ...compromissosAmanha].sort((a, b) => a.data_hora.localeCompare(b.data_hora));
      if (!itens.length) continue; // agenda vazia amanhã — não envia nada

      await enviarEmailResumoDiario(env, psicologo, itens).catch(() => {});
    }
  },
};

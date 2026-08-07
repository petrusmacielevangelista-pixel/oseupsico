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
   ============================================================ */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

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
      crp_numero TEXT NOT NULL,
      crp_estado TEXT NOT NULL,
      bio TEXT,
      graduacao_curso TEXT,
      graduacao_instituicao TEXT,
      graduacao_ano INTEGER,
      pos_graduacoes TEXT,
      especialidades TEXT,
      abordagens TEXT,
      projetos_relevantes TEXT,
      anos_experiencia INTEGER,
      status_aprovacao TEXT NOT NULL DEFAULT 'pendente',
      licenca_status TEXT NOT NULL DEFAULT 'inativa',
      licenca_validade_ate TEXT,
      licenca_valor_mensal REAL,
      licenca_observacoes TEXT,
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
function proximaVagaLivre(disponibilidades, ocupadosSet, diasAFrente = 14) {
  const agora = new Date();
  for (let d = 1; d <= diasAFrente; d++) {
    const dia = new Date(agora);
    dia.setDate(dia.getDate() + d);
    const diaSemana = dia.getDay();

    const dispsDoDia = disponibilidades.filter(disp => disp.dia_semana === diaSemana);
    let melhorSlot = null;
    for (const disp of dispsDoDia) {
      const [hIni, mIni] = disp.hora_inicio.split(':').map(Number);
      const [hFim, mFim] = disp.hora_fim.split(':').map(Number);
      let cursor = new Date(dia); cursor.setHours(hIni, mIni, 0, 0);
      const fim = new Date(dia); fim.setHours(hFim, mFim, 0, 0);

      while (cursor < fim) {
        const iso = cursor.toISOString().slice(0, 16).replace('T', ' ');
        if (!ocupadosSet.has(iso) && (!melhorSlot || iso < melhorSlot)) melhorSlot = iso;
        cursor = new Date(cursor.getTime() + disp.duracao_minutos * 60000);
      }
    }
    if (melhorSlot) return melhorSlot;
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname;

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
      await env.DB.prepare('DELETE FROM especialidades_catalogo WHERE id = ?').bind(especDeleteMatch[1]).run();
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

        if (!nome || !email || !senha || !crpNumero || !crpEstado) {
          return json({ ok: false, error: 'Dados obrigatórios ausentes.' }, 400);
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
        const abordagens = form.get('abordagens') || '[]';

        const result = await env.DB.prepare(
          `INSERT INTO psicologos
           (nome, email, senha_hash, telefone, foto_url, crp_numero, crp_estado, bio,
            graduacao_curso, graduacao_instituicao, graduacao_ano, pos_graduacoes,
            especialidades, abordagens, projetos_relevantes, anos_experiencia)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          nome, email, senhaHash, form.get('telefone') || null, fotoUrl, crpNumero, crpEstado,
          form.get('bio') || null, form.get('graduacao_curso') || null, form.get('graduacao_instituicao') || null,
          form.get('graduacao_ano') ? Number(form.get('graduacao_ano')) : null, posGraduacoes,
          especialidades, abordagens, form.get('projetos_relevantes') || null,
          form.get('anos_experiencia') ? Number(form.get('anos_experiencia')) : null
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
      // partir de graduacao_ano (ver calcularAnosExperiencia), pra evitar
      // que o psicólogo informe um número que não bate com a formação.
      const body = await request.json();
      const campos = ['telefone', 'bio', 'graduacao_curso', 'graduacao_instituicao', 'graduacao_ano',
        'pos_graduacoes', 'especialidades', 'abordagens', 'projetos_relevantes'];
      const sets = [], binds = [];
      campos.forEach(c => {
        if (body[c] !== undefined) { sets.push(`${c} = ?`); binds.push(body[c]); }
      });
      if (!sets.length) return json({ ok: false, error: 'Nada pra atualizar.' }, 400);
      binds.push(psicologoId);
      await env.DB.prepare(`UPDATE psicologos SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
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
        `SELECT p.id, p.nome, p.foto_url, p.bio, p.especialidades, p.abordagens, p.anos_experiencia,
                p.graduacao_curso, p.graduacao_instituicao, p.graduacao_ano,
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

        const { results: todasDisponibilidades } = await env.DB.prepare(
          `SELECT * FROM disponibilidades WHERE psicologo_id IN (${placeholders}) AND ativo = 1`
        ).bind(...ids).all();

        const { results: todosOcupados } = await env.DB.prepare(
          `SELECT psicologo_id, data_hora FROM agendamentos
           WHERE psicologo_id IN (${placeholders}) AND status IN ('confirmado', 'pendente_verificacao') AND data_hora >= datetime('now')`
        ).bind(...ids).all();

        // Os objetos retornados pelo D1 não são mutáveis com segurança —
        // criamos objetos novos em vez de atribuir campo direto neles.
        psicologos = results.map(p => {
          const disponibilidades = todasDisponibilidades.filter(d => Number(d.psicologo_id) === Number(p.id));
          const ocupadosSet = new Set(todosOcupados.filter(o => Number(o.psicologo_id) === Number(p.id)).map(o => o.data_hora));
          return { ...p, proxima_vaga: proximaVagaLivre(disponibilidades, ocupadosSet) };
        });
      }

      return json({ ok: true, psicologos });
    }

    const perfilMatch = pathname.match(/^\/api\/psicologos\/(\d+)$/);
    if (perfilMatch && request.method === 'GET') {
      await initDB(env.DB);
      const p = await env.DB.prepare(
        `SELECT id, nome, foto_url, bio, especialidades, abordagens, anos_experiencia,
                graduacao_curso, graduacao_instituicao, graduacao_ano, pos_graduacoes, projetos_relevantes
         FROM psicologos
         WHERE id = ? AND status_aprovacao = 'aprovado' AND licenca_validade_ate >= date('now')`
      ).bind(perfilMatch[1]).first();
      if (!p) return json({ ok: false, error: 'Não encontrado.' }, 404);

      const { results: avals } = await env.DB.prepare(
        `SELECT nota FROM avaliacoes WHERE psicologo_id = ? AND status = 'publicado'`
      ).bind(perfilMatch[1]).all();
      const media = avals.length ? avals.reduce((s, a) => s + a.nota, 0) / avals.length : null;

      return json({ ok: true, psicologo: p, avaliacao_media: media, total_avaliacoes: avals.length });
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
      const { paciente_nome, descricao, data_hora } = await request.json();
      if (!paciente_nome || !data_hora) return json({ ok: false, error: 'Nome do paciente e data/hora são obrigatórios.' }, 400);
      const result = await env.DB.prepare(
        `INSERT INTO compromissos (psicologo_id, paciente_nome, descricao, data_hora) VALUES (?, ?, ?, ?)`
      ).bind(psicologoId, paciente_nome, descricao || null, data_hora).run();
      return json({ ok: true, id: result.meta.last_row_id });
    }

    const compromissoMatch = pathname.match(/^\/api\/psicologos\/me\/compromissos\/(\d+)$/);
    if (compromissoMatch && request.method === 'PUT') {
      const psicologoId = autenticadoPsicologo(request, env);
      if (!psicologoId) return json({ ok: false }, 401);
      await initDB(env.DB);
      const { paciente_nome, descricao, data_hora } = await request.json();
      if (!paciente_nome || !data_hora) return json({ ok: false, error: 'Nome do paciente e data/hora são obrigatórios.' }, 400);
      await env.DB.prepare(
        `UPDATE compromissos SET paciente_nome = ?, descricao = ?, data_hora = ? WHERE id = ? AND psicologo_id = ?`
      ).bind(paciente_nome, descricao || null, data_hora, compromissoMatch[1], psicologoId).run();
      return json({ ok: true });
    }

    if (compromissoMatch && request.method === 'DELETE') {
      const psicologoId = autenticadoPsicologo(request, env);
      if (!psicologoId) return json({ ok: false }, 401);
      await initDB(env.DB);
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
      const diasAFrente = 14;

      const { results: disponibilidades } = await env.DB.prepare(
        'SELECT * FROM disponibilidades WHERE psicologo_id = ? AND ativo = 1'
      ).bind(psicologoId).all();

      const { results: ocupados } = await env.DB.prepare(
        `SELECT data_hora FROM agendamentos WHERE psicologo_id = ? AND status IN ('confirmado', 'pendente_verificacao') AND data_hora >= datetime('now')`
      ).bind(psicologoId).all();
      const ocupadosSet = new Set(ocupados.map(o => o.data_hora));

      const slots = [];
      const agora = new Date();
      for (let d = 1; d <= diasAFrente; d++) {
        const dia = new Date(agora);
        dia.setDate(dia.getDate() + d);
        const diaSemana = dia.getDay();

        disponibilidades.filter(disp => disp.dia_semana === diaSemana).forEach(disp => {
          const [hIni, mIni] = disp.hora_inicio.split(':').map(Number);
          const [hFim, mFim] = disp.hora_fim.split(':').map(Number);
          let cursor = new Date(dia); cursor.setHours(hIni, mIni, 0, 0);
          const fim = new Date(dia); fim.setHours(hFim, mFim, 0, 0);

          while (cursor < fim) {
            const iso = cursor.toISOString().slice(0, 16).replace('T', ' ');
            if (!ocupadosSet.has(iso)) slots.push(iso);
            cursor = new Date(cursor.getTime() + disp.duracao_minutos * 60000);
          }
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

    return env.ASSETS.fetch(request);
  },
};

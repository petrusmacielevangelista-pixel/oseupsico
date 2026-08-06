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
async function initDB(db) {
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
      criado_em TEXT DEFAULT (datetime('now')),
      UNIQUE(psicologo_id, avaliador_email)
    )`
  ).run();

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

  // Catálogo de especialidades — gerenciável pelo admin, usado como opções
  // no formulário de cadastro do psicólogo (checkboxes).
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS especialidades_catalogo (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL UNIQUE
    )`
  ).run();

  const { results: existentes } = await db.prepare('SELECT COUNT(*) as n FROM especialidades_catalogo').all();
  if (existentes[0].n === 0) {
    const iniciais = ['Ansiedade', 'Depressão', 'TDAH', 'Relacionamentos', 'Autoestima', 'Luto', 'Estresse', 'Burnout', 'TEA / Autismo', 'Trauma / TEPT'];
    for (const nome of iniciais) {
      await db.prepare('INSERT OR IGNORE INTO especialidades_catalogo (nome) VALUES (?)').bind(nome).run();
    }
  }
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
          fotoUrl = `https://fotos.oseupsico.com.br/${key}`;
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

      // PUT — edita o próprio perfil (não mexe em aprovação/licença)
      const body = await request.json();
      const campos = ['telefone', 'bio', 'graduacao_curso', 'graduacao_instituicao', 'graduacao_ano',
        'pos_graduacoes', 'especialidades', 'abordagens', 'projetos_relevantes', 'anos_experiencia'];
      const sets = [], binds = [];
      campos.forEach(c => {
        if (body[c] !== undefined) { sets.push(`${c} = ?`); binds.push(body[c]); }
      });
      if (!sets.length) return json({ ok: false, error: 'Nada pra atualizar.' }, 400);
      binds.push(psicologoId);
      await env.DB.prepare(`UPDATE psicologos SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
      return json({ ok: true });
    }

    if (pathname === '/api/psicologos' && request.method === 'GET') {
      await initDB(env.DB);
      const { results } = await env.DB.prepare(
        `SELECT id, nome, foto_url, bio, especialidades, abordagens, anos_experiencia,
                graduacao_curso, graduacao_instituicao, graduacao_ano
         FROM psicologos
         WHERE status_aprovacao = 'aprovado' AND licenca_validade_ate >= date('now')
         ORDER BY criado_em DESC`
      ).all();
      return json({ ok: true, psicologos: results });
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

        const result = await env.DB.prepare(
          `INSERT INTO avaliacoes (psicologo_id, avaliador_nome, avaliador_email, nota, comentario)
           VALUES (?, ?, ?, ?, ?)`
        ).bind(psicologoId, nome, email, nota, comentario || null).run();

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
        `SELECT avaliador_nome, nota, comentario, criado_em FROM avaliacoes
         WHERE psicologo_id = ? AND status = 'publicado' ORDER BY criado_em DESC`
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

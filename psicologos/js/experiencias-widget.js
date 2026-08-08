// Widget de "Experiências de trabalho e vivências relevantes": lista
// repetível com título + período (MM/AAAA), usado tanto no cadastro quanto
// no painel do psicólogo. Guarda os itens como array de objetos
// { titulo, inicio, fim, atual } — serializado como JSON pro backend.
// No perfil público isso é renderizado como tópicos dentro de um único
// bloco de texto (não um heading por item).
function criarWidgetExperiencias(containerId) {
  let itens = [];
  const container = document.getElementById(containerId);

  function render() {
    const linhas = itens.map((it, i) => `
      <div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;background:#F7F5F0;padding:12px;border-radius:10px;margin-bottom:10px;">
        <div style="flex:2;min-width:180px;">
          <label style="font-size:0.78rem;font-weight:600;display:block;margin-bottom:4px;">Título</label>
          <input type="text" data-idx="${i}" data-campo="titulo" value="${(it.titulo || '').replace(/"/g, '&quot;')}" placeholder="Ex: Psicóloga clínica — Clínica X" style="width:100%;padding:8px;border-radius:6px;border:1px solid #ddd;" />
        </div>
        <div style="width:110px;">
          <label style="font-size:0.78rem;font-weight:600;display:block;margin-bottom:4px;">Início</label>
          <input type="text" data-idx="${i}" data-campo="inicio" value="${it.inicio || ''}" placeholder="MM/AAAA" maxlength="7" style="width:100%;padding:8px;border-radius:6px;border:1px solid #ddd;" />
        </div>
        <div style="width:110px;">
          <label style="font-size:0.78rem;font-weight:600;display:block;margin-bottom:4px;">Fim</label>
          <input type="text" data-idx="${i}" data-campo="fim" value="${it.fim || ''}" placeholder="MM/AAAA" maxlength="7" style="width:100%;padding:8px;border-radius:6px;border:1px solid #ddd;" ${it.atual ? 'disabled' : ''} />
        </div>
        <label style="display:flex;align-items:center;gap:4px;font-size:0.78rem;white-space:nowrap;padding-bottom:9px;">
          <input type="checkbox" data-idx="${i}" data-campo="atual" ${it.atual ? 'checked' : ''} /> Atual
        </label>
        <button type="button" data-idx="${i}" data-acao="remover" title="Remover" style="border:none;background:none;color:#991B1B;font-weight:800;font-size:1.1rem;cursor:pointer;padding-bottom:6px;">✕</button>
      </div>
    `).join('');

    container.innerHTML = linhas + `<button type="button" id="${containerId}-add" style="border:1.5px dashed #ccc;background:none;border-radius:8px;padding:8px 14px;cursor:pointer;font-size:0.85rem;color:#666;">+ Adicionar experiência</button>`;

    container.querySelectorAll('input[data-campo]').forEach(inp => {
      inp.addEventListener('input', () => {
        const idx = Number(inp.dataset.idx);
        const campo = inp.dataset.campo;
        if (campo === 'atual') { itens[idx].atual = inp.checked; render(); return; }
        itens[idx][campo] = inp.value;
      });
    });
    container.querySelectorAll('button[data-acao="remover"]').forEach(btn => {
      btn.addEventListener('click', () => { itens.splice(Number(btn.dataset.idx), 1); render(); });
    });
    const btnAdd = document.getElementById(`${containerId}-add`);
    if (btnAdd) btnAdd.addEventListener('click', () => { itens.push({ titulo: '', inicio: '', fim: '', atual: false }); render(); });
  }

  render();

  return {
    setItens(lista) { itens = Array.isArray(lista) ? lista.map(x => ({ ...x })) : []; render(); },
    getItens() {
      return itens
        .filter(it => it.titulo && it.titulo.trim())
        .map(it => ({ titulo: it.titulo.trim(), inicio: it.inicio || '', fim: it.atual ? '' : (it.fim || ''), atual: !!it.atual }));
    },
  };
}

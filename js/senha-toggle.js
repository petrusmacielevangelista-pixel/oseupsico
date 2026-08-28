// Adiciona um botão de "mostrar/ocultar senha" (ícone de olho) em todo
// campo type="password" da página. Autocontido (injeta seu próprio CSS),
// funciona em qualquer página independente de linkar /css/style.css —
// o admin/psicologos.html, por exemplo, não linka.
(function () {
  const ICONE_OLHO = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z"/><circle cx="12" cy="12" r="3"/></svg>';
  const ICONE_OLHO_FECHADO = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a20.32 20.32 0 0 1 5.06-5.94M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a20.32 20.32 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

  function aplicarToggle(input) {
    if (input.dataset.senhaToggleAplicado) return;
    input.dataset.senhaToggleAplicado = '1';

    const wrap = document.createElement('div');
    wrap.className = 'senha-toggle-wrap';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'senha-toggle-btn';
    btn.setAttribute('aria-label', 'Mostrar senha');
    btn.innerHTML = ICONE_OLHO;
    wrap.appendChild(btn);

    btn.addEventListener('click', () => {
      const vaiMostrar = input.type === 'password';
      input.type = vaiMostrar ? 'text' : 'password';
      btn.innerHTML = vaiMostrar ? ICONE_OLHO_FECHADO : ICONE_OLHO;
      btn.setAttribute('aria-label', vaiMostrar ? 'Ocultar senha' : 'Mostrar senha');
    });
  }

  const estilo = document.createElement('style');
  estilo.textContent = `
    .senha-toggle-wrap { position: relative; }
    .senha-toggle-wrap input { padding-right: 42px !important; width: 100%; box-sizing: border-box; }
    .senha-toggle-btn {
      position: absolute; right: 4px; top: 50%; transform: translateY(-50%);
      background: none; border: none; padding: 6px; cursor: pointer; color: #888; line-height: 0;
      display: flex; align-items: center; justify-content: center; border-radius: 6px;
    }
    .senha-toggle-btn:hover { color: #1A1A1A; }
    .senha-toggle-btn:focus-visible { outline: 2px solid #B8940A; outline-offset: 1px; }
  `;
  document.head.appendChild(estilo);

  function iniciar() {
    document.querySelectorAll('input[type="password"]').forEach(aplicarToggle);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', iniciar);
  } else {
    iniciar();
  }
})();

/**
 * O SEU PSICO — script.js
 */
(function () {
  'use strict';

  let CFG = null;

  async function loadConfig() {
    try {
      const r = await fetch('data/config.json', { cache: 'no-cache' });
      CFG = await r.json();
    } catch (e) {
      console.warn('Config not loaded', e);
      CFG = {};
    }
    init();
  }

  // De onde a pessoa veio e de que aparelho. A marca vai no começo do texto
  // pré-preenchido do link e a Sara a remove antes de a pessoa ver
  // (separarOrigem, no worker do bot). Formato: duas letras de origem — og
  // anúncio, ob blog, oi instagram, os site, op perfil — mais uma terceira
  // opcional de dispositivo: m celular, d computador. Então [ogm] é anúncio no
  // celular. Se o dispositivo não for detectado, sai [og], que o bot também
  // aceita.
  // Guardamos a origem em sessionStorage porque a pessoa pode navegar pelo site
  // antes de clicar, e aí os parâmetros da campanha já saíram da URL. O
  // dispositivo não precisa disso — é lido na hora.
  const ORIGEM_CHAVE = 'osp_origem';

  function origemDoVisitante() {
    try {
      const p = new URLSearchParams(location.search);
      const fonte = (p.get('utm_source') || '').toLowerCase();
      let marca = null;
      if (p.get('gclid') || fonte === 'google') marca = 'og';
      else if (fonte === 'instagram') marca = 'oi';
      else if (fonte === 'blog') marca = 'ob';
      if (marca) sessionStorage.setItem(ORIGEM_CHAVE, marca);
      return marca || sessionStorage.getItem(ORIGEM_CHAVE) || 'os';
    } catch (e) {
      return 'os';
    }
  }

  // Ponteiro grosso é toque: celular ou tablet. O Google Ads separa tablet de
  // celular, mas a conta não tem tráfego de tablet, então os dois caem em "m".
  function dispositivoDoVisitante() {
    try {
      return matchMedia('(pointer: coarse)').matches ? 'm' : 'd';
    } catch (e) {
      return '';
    }
  }

  function waLink() {
    const n = CFG.brand?.whatsapp || '';
    const marca = origemDoVisitante() + dispositivoDoVisitante();
    const texto = `[${marca}] ${CFG.brand?.whatsappMessage || ''}`;
    return `https://wa.me/${n}?text=${encodeURIComponent(texto)}`;
  }

  // ── Passagem para o WhatsApp no computador ─────────────────────
  // No celular o wa.me abre o aplicativo com a mensagem pronta. No computador
  // ele abre o WhatsApp Web, que exige estar logado ou escanear QR — e quem não
  // está logado desiste ali. Medido entre 13 e 23/10/2026: 61% dos cliques de
  // celular viraram conversa contra 22% dos de computador, e o computador não
  // gerou nenhum lead em 11 dias. Então no computador abrimos um painel com QR
  // e o número, em vez de jogar a pessoa direto no Web.
  //
  // O evento de conversão continua disparando normal: o ouvinte do gtag está
  // registrado no mesmo elemento e roda independente do preventDefault daqui.

  const QR_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
  let qrPromessa = null;

  // Carrega a biblioteca do QR só quando alguém no computador clica — não pesa
  // no carregamento da página, que é onde a gente precisa de velocidade.
  function carregarQr() {
    if (window.QRCode) return Promise.resolve(true);
    if (!qrPromessa) {
      qrPromessa = new Promise(resolve => {
        const s = document.createElement('script');
        s.src = QR_CDN;
        s.onload = () => resolve(true);
        s.onerror = () => resolve(false);
        document.head.appendChild(s);
      });
    }
    return qrPromessa;
  }

  function montaPainelWa() {
    const painel = document.createElement('div');
    painel.className = 'wa-pc';
    painel.hidden = true;
    painel.innerHTML = `
      <div class="wa-pc__fundo"></div>
      <div class="wa-pc__caixa" role="dialog" aria-modal="true" aria-labelledby="wa-pc-titulo">
        <button class="wa-pc__fechar" type="button" aria-label="Fechar">&times;</button>
        <h3 id="wa-pc-titulo">Falar no WhatsApp</h3>
        <p class="wa-pc__texto">Aponte a câmera do celular para o código e a conversa abre com a mensagem pronta.</p>
        <div class="wa-pc__qr"></div>
        <p class="wa-pc__ou">ou salve o número</p>
        <div class="wa-pc__numero">
          <strong class="wa-pc__fone"></strong>
          <button class="wa-pc__copiar" type="button">Copiar</button>
        </div>
        <a class="wa-pc__web" target="_blank" rel="noopener noreferrer">Já uso o WhatsApp Web — abrir por aqui</a>
      </div>`;
    document.body.appendChild(painel);

    const fechar = () => { painel.hidden = true; document.body.style.overflow = ''; };
    painel.querySelector('.wa-pc__fechar').addEventListener('click', fechar);
    painel.querySelector('.wa-pc__fundo').addEventListener('click', fechar);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') fechar(); });

    painel.querySelector('.wa-pc__copiar').addEventListener('click', function () {
      const fone = painel.querySelector('.wa-pc__fone').textContent;
      navigator.clipboard?.writeText(fone).then(() => {
        this.textContent = 'Copiado!';
        setTimeout(() => { this.textContent = 'Copiar'; }, 2000);
      }).catch(() => { this.textContent = fone; });
    });

    return painel;
  }

  let painelWa = null;

  function abrirPainelWa(link) {
    if (!painelWa) painelWa = montaPainelWa();
    painelWa.querySelector('.wa-pc__fone').textContent = formatPhone(CFG.brand?.whatsapp);
    painelWa.querySelector('.wa-pc__web').href = link;
    painelWa.hidden = false;
    document.body.style.overflow = 'hidden';

    const caixaQr = painelWa.querySelector('.wa-pc__qr');
    if (caixaQr.dataset.link === link) return;
    caixaQr.innerHTML = '';
    carregarQr().then(ok => {
      if (!ok || !window.QRCode) {
        // Sem a biblioteca o painel ainda serve: número, cópia e link do Web.
        caixaQr.remove();
        const ou = painelWa.querySelector('.wa-pc__ou');
        if (ou) ou.textContent = 'Mande uma mensagem para';
        return;
      }
      caixaQr.dataset.link = link;
      new window.QRCode(caixaQr, {
        text: link, width: 190, height: 190,
        colorDark: '#1A1A1A', colorLight: '#FFFFFF',
      });
    });
  }

  function initWhatsAppPc() {
    if (dispositivoDoVisitante() !== 'd') return;
    document.querySelectorAll('.js-wa').forEach(el => {
      el.addEventListener('click', function (e) {
        e.preventDefault();
        abrirPainelWa(this.href && this.href !== '#' ? this.href : waLink());
      });
    });
  }

  function set(sel, html) {
    const el = document.querySelector(sel);
    if (el) el.innerHTML = html;
  }

  // ── Render sections ────────────────────────────────────────────

  function formatPhone(raw) {
    const digits = (raw || '').replace(/^55/, '');
    const m = digits.match(/^(\d{2})(\d{4,5})(\d{4})$/);
    return m ? `(${m[1]}) ${m[2]}-${m[3]}` : raw;
  }

  function renderNavbar() {
    document.querySelectorAll('.js-wa').forEach(el => el.href = waLink());
    document.querySelectorAll('.js-ig').forEach(el => el.href = CFG.brand?.instagram || '#');
    set('#footer-wa-number', formatPhone(CFG.brand?.whatsapp));
  }

  function renderHero() {
    const h = CFG.hero || {};
    set('#hero-eyebrow', h.eyebrow || '');
    set('#hero-headline', h.headline || '');
    set('#hero-subheadline', h.subheadline || '');
    set('#hero-cta', h.cta || '');
    set('#hero-trust', h.trust || '');
  }

  function renderHow() {
    const h = CFG.howItWorks || {};
    set('#how-title', h.title || '');
    set('#how-subtitle', h.subtitle || '');
    const grid = document.querySelector('#how-steps');
    if (!grid || !h.steps) return;
    grid.innerHTML = h.steps.map((s, i) => `
      <div class="how-step fade-up fade-up-delay-${i + 1}">
        <div class="how-step__icon-wrap" aria-hidden="true">${s.icon}</div>
        <h3 class="how-step__title">${s.title}</h3>
        <p class="how-step__text">${s.text}</p>
      </div>
    `).join('');
    observe();
  }

  function renderBenefits() {
    const b = CFG.benefits || {};
    set('#benefits-title', b.title || '');
    set('#benefits-subtitle', b.subtitle || '');
    const grid = document.querySelector('#benefits-grid');
    if (!grid || !b.items) return;
    grid.innerHTML = b.items.map((item, i) => `
      <div class="benefit-card fade-up fade-up-delay-${(i % 3) + 1}" role="article">
        <span class="benefit-card__icon" aria-hidden="true">${item.icon}</span>
        <h3 class="benefit-card__title">${item.title}</h3>
        <p class="benefit-card__text">${item.text}</p>
      </div>
    `).join('');
    observe();
  }

  function renderSpecialties() {
    const s = CFG.specialties || {};
    set('#specialties-title', s.title || '');
    set('#specialties-subtitle', s.subtitle || '');
    const grid = document.querySelector('#specialties-grid');
    if (!grid || !s.items) return;
    grid.innerHTML = s.items.map(item => `
      <div class="specialty-pill fade-up">
        <span class="specialty-pill__icon" aria-hidden="true">${item.icon}</span>
        <span>${item.title}</span>
      </div>
    `).join('');
    observe();
  }

  function renderTestimonials() {
    const t = CFG.testimonials || {};
    set('#testimonials-title', t.title || '');
    set('#testimonials-subtitle', t.subtitle || '');
    const grid = document.querySelector('#testimonials-grid');
    if (!grid || !t.items) return;
    grid.innerHTML = t.items.map(item => {
      const avatar = item.photo
        ? `<img class="testimonial-card__avatar testimonial-card__avatar--photo" src="${item.photo}" alt="${item.name}" loading="lazy" />`
        : `<div class="testimonial-card__avatar" aria-hidden="true">${item.name.charAt(0)}</div>`;
      return `
        <article class="testimonial-card fade-up" role="article">
          <div class="testimonial-card__stars" aria-label="5 estrelas">★★★★★</div>
          <p class="testimonial-card__text">"${item.text}"</p>
          <div class="testimonial-card__author">
            ${avatar}
            <div>
              <div class="testimonial-card__name">${item.name}</div>
              <div class="testimonial-card__city">${item.city}</div>
            </div>
          </div>
        </article>
      `;
    }).join('');
    observe();
  }

  function renderFaq() {
    const f = CFG.faq || {};
    set('#faq-title', f.title || '');
    const list = document.querySelector('#faq-list');
    if (!list || !f.items) return;

    list.innerHTML = f.items.map((item, i) => `
      <div class="faq-item">
        <button class="faq-item__question"
                aria-expanded="false"
                aria-controls="faq-ans-${i}">
          <span>${item.question}</span>
          <span class="faq-item__icon" aria-hidden="true">+</span>
        </button>
        <div class="faq-item__answer" id="faq-ans-${i}" role="region">
          <p>${item.answer}</p>
        </div>
      </div>
    `).join('');

    list.querySelectorAll('.faq-item__question').forEach(btn => {
      btn.addEventListener('click', () => {
        const item = btn.closest('.faq-item');
        const isOpen = item.classList.contains('open');
        list.querySelectorAll('.faq-item').forEach(el => {
          el.classList.remove('open');
          el.querySelector('.faq-item__question').setAttribute('aria-expanded', 'false');
        });
        if (!isOpen) {
          item.classList.add('open');
          btn.setAttribute('aria-expanded', 'true');
        }
      });
    });

    injectFaqSchema(f.items);
  }

  function injectFaqSchema(items) {
    document.querySelector('#faq-schema')?.remove();
    const schema = {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: items.map(item => ({
        '@type': 'Question',
        name: item.question,
        acceptedAnswer: { '@type': 'Answer', text: item.answer },
      })),
    };
    const script = document.createElement('script');
    script.id = 'faq-schema';
    script.type = 'application/ld+json';
    script.textContent = JSON.stringify(schema);
    document.head.appendChild(script);
  }

  function renderCta() {
    const c = CFG.ctaFinal || {};
    set('#cta-headline', c.headline || '');
    set('#cta-subheadline', c.subheadline || '');
    set('#cta-btn', c.cta || '');
    set('#cta-note', c.note || '');
  }

  // ── Navbar scroll ──────────────────────────────────────────────
  function initNavbar() {
    const nav = document.querySelector('#navbar');
    if (!nav) return;
    const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 50);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    const burger = document.querySelector('#burger');
    const mobileNav = document.querySelector('#mobile-nav');
    const mobileClose = document.querySelector('#mobile-close');

    burger?.addEventListener('click', () => {
      mobileNav?.classList.add('open');
      burger.setAttribute('aria-expanded', 'true');
    });
    mobileClose?.addEventListener('click', () => {
      mobileNav?.classList.remove('open');
      burger?.setAttribute('aria-expanded', 'false');
    });
    mobileNav?.querySelectorAll('a').forEach(a =>
      a.addEventListener('click', () => mobileNav.classList.remove('open'))
    );
  }

  // ── Intersection observer ──────────────────────────────────────
  let obs;
  function observe() {
    if (!obs) {
      obs = new IntersectionObserver(entries => {
        entries.forEach(e => {
          if (e.isIntersecting) { e.target.classList.add('visible'); obs.unobserve(e.target); }
        });
      }, { threshold: 0.12, rootMargin: '0px 0px -32px 0px' });
    }
    document.querySelectorAll('.fade-up:not(.visible)').forEach(el => obs.observe(el));
  }

  // ── Counter animation ──────────────────────────────────────────
  function animateCounters() {
    document.querySelectorAll('.js-counter').forEach(el => {
      const target = parseInt(el.dataset.target, 10);
      const suffix = el.dataset.suffix || '';
      let current = 0;
      const step = Math.ceil(target / 50);
      const timer = setInterval(() => {
        current = Math.min(current + step, target);
        el.textContent = current + suffix;
        if (current >= target) clearInterval(timer);
      }, 30);
    });
  }

  const statsObs = new IntersectionObserver(entries => {
    entries.forEach(e => {
      if (e.isIntersecting) { animateCounters(); statsObs.disconnect(); }
    });
  }, { threshold: 0.5 });

  // ── Conversion tracking ────────────────────────────────────────
  function initTracking() {
    document.querySelectorAll('.js-wa').forEach(el => {
      el.addEventListener('click', function () {
        if (typeof gtag === 'function') {
          const inNav = !!this.closest('nav, .mobile-nav');
          const section = this.closest('section');
          gtag('event', 'whatsapp_click', {
            event_category: 'conversao',
            event_label: inNav ? 'navbar' : (section?.id || 'pagina'),
          });
          gtag('event', 'conversion', { send_to: 'AW-18384131981' });
        }
      });
    });

    document.querySelectorAll('.js-ig').forEach(el => {
      el.addEventListener('click', function () {
        if (typeof gtag === 'function') {
          gtag('event', 'instagram_click', { event_category: 'engajamento' });
        }
      });
    });
  }

  // ── Init ───────────────────────────────────────────────────────
  function init() {
    renderNavbar();
    renderHero();
    renderHow();
    renderBenefits();
    renderSpecialties();
    renderTestimonials();
    renderFaq();
    renderCta();
    initNavbar();
    initTracking();
    // Depois do initTracking, para o ouvinte do gtag já estar registrado
    // quando o nosso preventDefault entrar em cena.
    initWhatsAppPc();
    observe();

    const statsBar = document.querySelector('.stats-bar');
    if (statsBar) statsObs.observe(statsBar);

    document.querySelectorAll('.js-wa').forEach(el => el.href = waLink());
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadConfig);
  } else {
    loadConfig();
  }
})();

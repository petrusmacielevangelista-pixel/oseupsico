/**
 * O SEU PSICO — script.js
 */
(function () {
  'use strict';

  let CFG = null;

  async function loadConfig() {
    try {
      const r = await fetch('data/config.json?' + Date.now());
      CFG = await r.json();
    } catch (e) {
      console.warn('Config not loaded', e);
      CFG = {};
    }
    init();
  }

  function waLink() {
    const n = CFG.brand?.whatsapp || '';
    const m = encodeURIComponent(CFG.brand?.whatsappMessage || '');
    return `https://wa.me/${n}?text=${m}`;
  }

  function set(sel, html) {
    const el = document.querySelector(sel);
    if (el) el.innerHTML = html;
  }

  // ── Render sections ────────────────────────────────────────────

  function renderNavbar() {
    document.querySelectorAll('.js-wa').forEach(el => el.href = waLink());
    document.querySelectorAll('.js-ig').forEach(el => el.href = CFG.brand?.instagram || '#');
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
    grid.innerHTML = t.items.map(item => `
      <article class="testimonial-card fade-up" role="article">
        <div class="testimonial-card__stars" aria-label="5 estrelas">★★★★★</div>
        <p class="testimonial-card__text">"${item.text}"</p>
        <div class="testimonial-card__author">
          <div class="testimonial-card__avatar" aria-hidden="true">${item.name.charAt(0)}</div>
          <div>
            <div class="testimonial-card__name">${item.name}</div>
            <div class="testimonial-card__city">${item.city}</div>
          </div>
        </div>
      </article>
    `).join('');
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

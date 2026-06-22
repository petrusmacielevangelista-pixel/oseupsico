# O Seu Psico — Landing Page Institucional

## Estrutura
```
/
├── index.html          ← Landing page principal
├── robots.txt
├── css/style.css       ← Todo o design system (tokens, responsivo)
├── js/script.js        ← Renderização dinâmica, animações
├── data/config.json    ← ⭐ Edite aqui: textos, WhatsApp, conteúdo
└── assets/
    ├── logo.png        ← Logo já incluído
    └── og-image.jpg    ← Adicionar: imagem de compartilhamento (1200×630px)
```

## Personalizar

Abra `data/config.json` e altere:
- `brand.whatsapp` → número com DDI (ex: 5511999999999)
- `brand.instagram` → URL do Instagram
- `hero.headline` → título principal
- `testimonials.items` → depoimentos
- `faq.items` → perguntas e respostas
- Números na seção de stats → edite direto no `index.html` (atributos `data-target`)

## Publicar

**Vercel** (recomendado): arraste a pasta em vercel.com  
**Netlify**: arraste a pasta em netlify.com  
Ambos gratuitos e com HTTPS automático.

## Identidade visual
- Amarelo principal: `#F5C518`
- Preto: `#1A1A1A`
- Fonte display: Syne (Google Fonts)
- Fonte corpo: Inter (Google Fonts)

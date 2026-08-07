// Redimensiona e comprime uma foto no navegador antes do upload — mesmo
// padrão usado por LinkedIn/Doctoralia/etc pra fotos de perfil: reduz pro
// maior lado caber em ~480px e recomprime como JPEG de qualidade média,
// o que tipicamente leva um arquivo de vários MB pra menos de 150–250KB
// sem perda visível numa foto de perfil pequena. Evita sobrecarregar o
// R2/o Worker com uploads desnecessariamente grandes.
async function comprimirFoto(arquivo, { maxLado = 480, qualidade = 0.82 } = {}) {
  if (!arquivo || !arquivo.type.startsWith('image/')) return arquivo;

  const bitmap = await createImageBitmap(arquivo).catch(() => null);
  if (!bitmap) return arquivo; // navegador sem suporte — envia original, backend ainda valida tamanho/tipo

  let { width, height } = bitmap;
  if (width > maxLado || height > maxLado) {
    if (width >= height) { height = Math.round(height * (maxLado / width)); width = maxLado; }
    else { width = Math.round(width * (maxLado / height)); height = maxLado; }
  }

  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, width, height);

  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', qualidade));
  if (!blob) return arquivo;

  const nomeBase = (arquivo.name || 'foto').replace(/\.[^.]+$/, '');
  return new File([blob], `${nomeBase}.jpg`, { type: 'image/jpeg' });
}

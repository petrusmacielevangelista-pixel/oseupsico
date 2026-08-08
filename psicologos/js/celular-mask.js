// Máscara simples de celular brasileiro "(XX) XXXXX-XXXX" — aplicada
// enquanto a pessoa digita. Não impõe DDI (o número é sempre BR aqui,
// diferente do seletor de país usado no projeto de Testes).
function aplicarMascaraCelular(input) {
  input.addEventListener('input', () => {
    let v = input.value.replace(/\D/g, '').slice(0, 11);
    if (v.length > 6) v = `(${v.slice(0, 2)}) ${v.slice(2, 7)}-${v.slice(7)}`;
    else if (v.length > 2) v = `(${v.slice(0, 2)}) ${v.slice(2)}`;
    else if (v.length > 0) v = `(${v}`;
    input.value = v;
  });
}

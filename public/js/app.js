(function () {
  // Copy buttons: <button data-copy="#inputId">
  document.addEventListener('click', async (e) => {
    const copyBtn = e.target.closest('[data-copy]');
    if (copyBtn) {
      const input = document.querySelector(copyBtn.dataset.copy);
      if (!input) return;
      try { await navigator.clipboard.writeText(input.value); }
      catch { input.select(); document.execCommand('copy'); }
      const t = copyBtn.textContent; copyBtn.textContent = 'Copied!';
      setTimeout(() => (copyBtn.textContent = t), 1500);
      return;
    }
    const shareBtn = e.target.closest('[data-share]');
    if (shareBtn) {
      const url = shareBtn.dataset.share;
      if (navigator.share) navigator.share({ title: shareBtn.dataset.title || document.title, url }).catch(() => {});
      else { await navigator.clipboard.writeText(url).catch(() => {}); shareBtn.textContent = 'Link copied!'; }
      return;
    }
    const step = e.target.closest('[data-step]');
    if (step) {
      const input = step.parentElement.querySelector('input');
      const v = Math.min(Math.max((parseInt(input.value, 10) || 1) + parseInt(step.dataset.step, 10), 1), parseInt(input.max, 10) || 20);
      input.value = v;
      return;
    }
    const confirmBtn = e.target.closest('[data-confirm-btn]');
    if (confirmBtn && !confirm(confirmBtn.dataset.confirmBtn)) e.preventDefault();
  });

  // Forms needing confirmation: <form data-confirm="...">
  document.addEventListener('submit', (e) => {
    const msg = e.target.dataset.confirm;
    if (msg && !confirm(msg)) e.preventDefault();
  });

  // Product page: update price + stock note when a size is selected
  const price = document.getElementById('price');
  const note = document.getElementById('stock-note');
  function updateSize() {
    const sel = document.querySelector('input[name="variant_id"]:checked');
    if (!sel || !price) return;
    price.textContent = sel.dataset.price;
    const stock = parseInt(sel.dataset.stock, 10);
    if (note) note.textContent = stock <= 5 ? `Only ${stock} left` : 'In stock';
    const qty = document.getElementById('qty');
    if (qty) { qty.max = Math.min(20, stock); if (+qty.value > stock) qty.value = stock; }
  }
  document.querySelectorAll('input[name="variant_id"]').forEach((r) => r.addEventListener('change', updateSize));
  updateSize();

  // Admin: dynamic size rows
  const variants = document.getElementById('variants');
  const tpl = document.getElementById('variant-template');
  const addBtn = document.getElementById('add-variant');
  if (variants && tpl && addBtn) {
    addBtn.addEventListener('click', () => {
      variants.appendChild(tpl.content.cloneNode(true));
      variants.lastElementChild.querySelector('input[name="v_size[]"]').focus();
    });
    variants.addEventListener('click', (e) => {
      const rm = e.target.closest('.remove-variant');
      if (!rm) return;
      if (variants.querySelectorAll('.variant-row').length <= 1) return alert('A product needs at least one size.');
      rm.closest('.variant-row').remove();
    });
    document.getElementById('fill-price').addEventListener('click', () => {
      const first = variants.querySelector('input[name="v_price[]"]');
      const val = prompt('Price for all sizes:', first ? first.value : '');
      if (val !== null) variants.querySelectorAll('input[name="v_price[]"]').forEach((i) => (i.value = val));
    });
  }
})();

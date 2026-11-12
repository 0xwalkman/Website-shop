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
  const compareEl = document.getElementById('compare');
  const saveEl = document.getElementById('save');
  function updateSize() {
    const sel = document.querySelector('input[name="variant_id"]:checked');
    if (!sel || !price) return;
    price.textContent = sel.dataset.price;
    const onSale = Boolean(sel.dataset.compare);
    price.classList.toggle('on-sale', onSale);
    if (compareEl) { compareEl.hidden = !onSale; compareEl.textContent = sel.dataset.compare; }
    if (saveEl) { saveEl.hidden = !onSale; saveEl.textContent = onSale ? `Save ${sel.dataset.save}%` : ''; }
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
    // "+ Add a color": copies every size of the first color into new rows for a new color.
    const addColor = document.getElementById('add-color');
    if (addColor) addColor.addEventListener('click', () => {
      const name = prompt('New color name (e.g. Navy):');
      if (!name) return;
      const rows = [...variants.querySelectorAll('.variant-row')];
      const firstColor = rows.length ? rows[0].querySelector('input[name="v_color[]"]').value : '';
      const base = rows.filter((r) => r.querySelector('input[name="v_color[]"]').value === firstColor);
      (base.length ? base : [null]).forEach((src) => {
        variants.appendChild(tpl.content.cloneNode(true));
        const row = variants.lastElementChild;
        row.querySelector('input[name="v_color[]"]').value = name;
        if (src) for (const f of ['v_size[]', 'v_price[]', 'v_compare[]']) row.querySelector(`input[name="${f}"]`).value = src.querySelector(`input[name="${f}"]`).value;
      });
    });
    document.getElementById('fill-price').addEventListener('click', () => {
      const first = variants.querySelector('input[name="v_price[]"]');
      const val = prompt('Price for all sizes:', first ? first.value : '');
      if (val !== null) variants.querySelectorAll('input[name="v_price[]"]').forEach((i) => (i.value = val));
    });
  }
})();

// Cookie notice (informational: the store only uses essential cookies)
(function () {
  const note = document.getElementById('cookie-note');
  if (!note) return;
  try { if (localStorage.getItem('cookie-ok')) return; } catch { return; }
  note.hidden = false;
  document.getElementById('cookie-ok').addEventListener('click', () => {
    try { localStorage.setItem('cookie-ok', '1'); } catch {}
    note.hidden = true;
  });
})();

// Product page: color picker shows the sizes for the chosen color
(function () {
  const colors = document.getElementById('colors');
  if (!colors) return;
  colors.addEventListener('click', (e) => {
    const chip = e.target.closest('.color-chip');
    if (!chip) return;
    const color = chip.dataset.color;
    colors.querySelectorAll('.color-chip').forEach((c) => c.classList.toggle('active', c === chip));
    document.getElementById('color-name').textContent = color;
    let firstAvailable = null;
    document.querySelectorAll('.sizes .size').forEach((label) => {
      const match = label.dataset.color === color;
      label.hidden = !match;
      const input = label.querySelector('input');
      if (!match) input.checked = false;
      else if (!firstAvailable && !input.disabled) firstAvailable = input;
    });
    if (firstAvailable) { firstAvailable.checked = true; firstAvailable.dispatchEvent(new Event('change')); }
  });
})();

// Product page: swipeable photo gallery with thumbnails
(function () {
  const gallery = document.getElementById('gallery');
  if (!gallery) return;
  const thumbs = document.querySelectorAll('.thumb-btn');
  thumbs.forEach((t) => t.addEventListener('click', () => {
    gallery.scrollTo({ left: gallery.clientWidth * Number(t.dataset.slide), behavior: 'smooth' });
  }));
  gallery.addEventListener('scroll', () => {
    const i = Math.round(gallery.scrollLeft / gallery.clientWidth);
    thumbs.forEach((t, n) => t.classList.toggle('active', n === i));
  }, { passive: true });
})();

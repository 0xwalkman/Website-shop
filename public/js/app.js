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

/* ---------------- Cart: add without reloading, quick add, sticky bar ---------------- */
(function () {
  const csrf = (document.querySelector('meta[name="csrf-token"]') || {}).content;
  if (!csrf || !window.fetch) return; // without JS or fetch the normal forms still work

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const thumbInto = (box, image, name) => {
    box.replaceChildren();
    if (image) { const img = el('img'); img.src = image; img.alt = ''; box.append(img); } else box.append(el('span', null, (name || '?').slice(0, 1)));
  };

  // Cart badges in the header and the bottom tab bar
  const setCount = (n) => document.querySelectorAll('[data-cart-count]').forEach((b) => { b.textContent = n; b.hidden = !n; });

  // "Added to your cart" confirmation
  const toast = $('cart-toast');
  let toastTimer;
  function showToast(item) {
    if (!toast) return;
    thumbInto($('toast-thumb'), item.image, item.name);
    $('toast-item').textContent = `${item.name} · ${item.option}${item.qty > 1 ? ` × ${item.qty}` : ''}`;
    toast.hidden = false;
    requestAnimationFrame(() => toast.classList.add('show'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 6000);
  }
  function hideToast() { toast.classList.remove('show'); setTimeout(() => { toast.hidden = true; }, 250); }
  if (toast) toast.addEventListener('pointerenter', () => clearTimeout(toastTimer));

  async function addToCart(variantId, qty) {
    const res = await fetch('/cart/add', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrf, variant_id: String(variantId), qty: String(qty || 1) }),
    });
    let data;
    try { data = await res.json(); } catch { throw new Error('Something went wrong. Please try again.'); }
    if (!data.ok) throw new Error(data.error || 'Could not add this item.');
    setCount(data.cartCount);
    showToast(data.item);
    return data;
  }
  // Shows a loading label on a button and restores its original content (text or icon) afterwards.
  const busy = (btn, on, label) => {
    if (!btn) return;
    if (on) { btn._saved = [...btn.childNodes]; btn.replaceChildren(label || 'Adding…'); btn.disabled = true; btn.setAttribute('aria-busy', 'true'); }
    else if (btn._saved) { btn.replaceChildren(...btn._saved); btn._saved = null; btn.disabled = false; btn.removeAttribute('aria-busy'); }
  };

  /* ----- Product page: "Add to cart" without leaving the page ----- */
  const form = $('add-form');
  if (form) {
    let err = null;
    const showError = (msg) => {
      if (!err) { err = el('p', 'flash error small'); form.querySelector('.qty-row').after(err); }
      err.textContent = msg; err.hidden = !msg;
    };
    form.addEventListener('submit', async (e) => {
      if (e.submitter && e.submitter.name === 'buy_now') return; // "Buy now" goes straight to checkout
      e.preventDefault();
      const sel = form.querySelector('input[name="variant_id"]:checked');
      if (!sel) { showError('Pick your size first.'); form.querySelector('.sizes').scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
      const btn = form.querySelector('.actions .btn.outline');
      busy(btn, true); showError('');
      try { await addToCart(sel.value, form.querySelector('input[name="qty"]').value); }
      catch (ex) { showError(ex.message); }
      finally { busy(btn, false); }
    });

    // Sticky bar on phones once the main buttons scroll out of view
    const bar = $('sticky-buy');
    const actions = form.querySelector('.actions');
    if (bar && actions && 'IntersectionObserver' in window) {
      new IntersectionObserver(([entry]) => {
        const show = !entry.isIntersecting && entry.boundingClientRect.top < 0;
        bar.hidden = !show;
        document.body.classList.toggle('has-sticky', show);
      }).observe(actions);
      $('sticky-add').addEventListener('click', () => form.requestSubmit(form.querySelector('.actions .btn.outline')));
      form.addEventListener('change', (e) => {
        if (e.target.name === 'variant_id') $('sticky-price').textContent = e.target.dataset.price;
      });
    }
  }

  /* ----- Product cards: quick add with a size picker sheet ----- */
  const sheet = $('quick-sheet');
  let product = null, color = null, chosen = null;

  function renderSizes() {
    const box = $('qs-sizes');
    box.replaceChildren();
    const list = product.variants.filter((v) => !color || v.color === color);
    const available = list.filter((v) => v.stock > 0);
    if (chosen && !list.includes(chosen)) chosen = null;
    if (!chosen && available.length === 1) chosen = available[0]; // only one choice left: pick it
    for (const v of list) {
      const b = el('button', 'size-btn' + (v === chosen ? ' active' : ''), v.size);
      b.type = 'button';
      b.disabled = v.stock <= 0;
      b.setAttribute('aria-pressed', String(v === chosen));
      b.addEventListener('click', () => { chosen = v; renderSizes(); });
      box.append(b);
    }
    const shown = chosen || list[0];
    $('qs-price').textContent = shown ? shown.price : '';
    $('qs-was').hidden = !(shown && shown.was);
    $('qs-was').textContent = shown && shown.was ? shown.was : '';
    $('qs-price').classList.toggle('on-sale', Boolean(shown && shown.was));
    $('qs-stock').textContent = chosen ? (chosen.stock <= 5 ? `Only ${chosen.stock} left` : 'In stock') : '';
    const add = $('qs-add');
    add.disabled = !chosen;
    add.textContent = chosen ? `Add to cart · ${chosen.price}` : 'Select a size';
  }

  function renderColors() {
    const colors = [...new Set(product.variants.map((v) => v.color).filter(Boolean))];
    $('qs-colors-wrap').hidden = colors.length === 0;
    const box = $('qs-colors');
    box.replaceChildren();
    if (!colors.length) { color = null; return; }
    if (!color) color = colors.find((c) => product.variants.some((v) => v.color === c && v.stock > 0)) || colors[0];
    $('qs-color-name').textContent = color;
    for (const c of colors) {
      const b = el('button', 'color-chip' + (c === color ? ' active' : '') + (product.variants.some((v) => v.color === c && v.stock > 0) ? '' : ' soldout'));
      b.type = 'button';
      b.style.setProperty('--sw', c.toLowerCase().replace(/[^a-z]/g, ''));
      b.append(el('i'), document.createTextNode(c));
      b.addEventListener('click', () => { color = c; chosen = null; renderColors(); renderSizes(); });
      box.append(b);
    }
  }

  async function openQuickAdd(slug, trigger) {
    busy(trigger, true, '…');
    try {
      const res = await fetch(`/api/products/${encodeURIComponent(slug)}`, { headers: { Accept: 'application/json' } });
      product = await res.json();
      if (!product.ok) throw new Error();
    } catch { window.location.href = `/p/${slug}`; return; }
    finally { busy(trigger, false); }

    const inStock = product.variants.filter((v) => v.stock > 0);
    if (product.variants.length === 1 && inStock.length === 1) { // one-size item: add straight away
      try { await addToCart(inStock[0].id, 1); } catch (ex) { alert(ex.message); }
      return;
    }
    color = null; chosen = null;
    $('qs-name').textContent = product.name;
    thumbInto($('qs-thumb'), product.image, product.name);
    $('qs-details').href = `/p/${product.slug}`;
    $('qs-error').hidden = true;
    renderColors(); renderSizes();
    if (sheet.showModal) sheet.showModal(); else window.location.href = `/p/${slug}`;
  }

  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-quick-add]');
    if (t && sheet) { e.preventDefault(); openQuickAdd(t.dataset.quickAdd, t); }
  });
  if (sheet) {
    sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.close(); }); // tap outside closes
    $('qs-add').addEventListener('click', async () => {
      if (!chosen) return;
      const btn = $('qs-add');
      busy(btn, true);
      try { await addToCart(chosen.id, 1); sheet.close(); }
      catch (ex) { $('qs-error').textContent = ex.message; $('qs-error').hidden = false; }
      finally { busy(btn, false); renderSizes(); }
    });
  }
})();

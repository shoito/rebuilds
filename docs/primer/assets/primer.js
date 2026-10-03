// Primer pages: document view / slide view, glossary popovers, steppers, tabs, quizzes, Mermaid.
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  };

  const main = $('main');
  const sections = $$('main > section.s');
  const content = sections.filter((s) => !s.classList.contains('cover'));
  const homeHref = $('meta[name="primer-home"]')?.content || null;
  const h1 = $('main h1');
  const title = h1 ? h1.textContent.trim() : document.title;

  // Section ids and numbers
  content.forEach((s, i) => {
    if (!s.id) s.id = 'sec-' + (i + 1);
    const h = s.querySelector(':scope > h2');
    if (h && !h.querySelector('.num')) h.insertAdjacentHTML('afterbegin', `<span class="num">${String(i + 1).padStart(2, '0')}</span>`);
  });
  sections.forEach((s, i) => { if (!s.id) s.id = 'slide-' + (i + 1); });

  // Top bar
  const bar = document.createElement('header');
  bar.className = 'bar';
  bar.innerHTML = `
    ${homeHref ? `<a class="home" href="${homeHref}">← <span>題材の一覧</span></a>` : ''}
    <div class="title">${title}</div>
    <div class="controls">
      <button class="btn" id="view-btn" aria-pressed="false" title="表示を切り替える（S キー）">スライド表示</button>
      <button class="btn" id="theme-btn" title="明暗を切り替える">◐</button>
    </div>`;
  document.body.prepend(bar);
  const progress = document.createElement('div');
  progress.className = 'progress';
  document.body.prepend(progress);

  // Layout with table of contents
  const layout = document.createElement('div');
  layout.className = 'layout';
  main.before(layout);
  const toc = document.createElement('nav');
  toc.className = 'toc';
  toc.setAttribute('aria-label', '目次');
  toc.innerHTML = `<p class="toc-head">目次</p><ol>${content.map((s) => {
    const h = s.querySelector(':scope > h2');
    const text = h ? h.textContent.replace(/^\d+/, '').trim() : s.id;
    return `<li><a href="#${s.id}">${text}</a></li>`;
  }).join('')}</ol>`;
  layout.append(toc, main);
  $('.toc-head', toc).addEventListener('click', () => toc.classList.toggle('open'));
  const foot = document.createElement('footer');
  foot.className = 'foot';
  foot.innerHTML = 'S キーでスライド表示に切り替え。スライドでは ← → で進む、Esc で資料表示に戻る。';
  document.body.append(foot);

  // Deck navigation
  const deck = document.createElement('nav');
  deck.className = 'deck-nav';
  deck.setAttribute('aria-label', 'スライドの操作');
  deck.innerHTML = '<button class="btn" data-go="prev" aria-label="前へ">←</button><span class="count"></span><button class="btn" data-go="next" aria-label="次へ">→</button>';
  document.body.append(deck);

  // Theme
  const root = document.documentElement;
  const savedTheme = store.get('primer-theme');
  if (savedTheme) root.dataset.theme = savedTheme;
  const isDark = () => root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  $('#theme-btn').addEventListener('click', () => {
    root.dataset.theme = isDark() ? 'light' : 'dark';
    store.set('primer-theme', root.dataset.theme);
    rerenderMermaid();
  });

  // Glossary popovers: <a class="t" href="#g-xxx">term</a> pointing at <dt id="g-xxx">
  let pop = null;
  const closePop = () => { pop?.remove(); pop = null; };
  const openPop = (el) => {
    const id = (el.getAttribute('href') || '').slice(1) || el.dataset.term;
    const dt = id && document.getElementById(id);
    if (!dt) return;
    const dd = dt.nextElementSibling;
    closePop();
    pop = document.createElement('div');
    pop.className = 'pop';
    pop.setAttribute('role', 'tooltip');
    pop.innerHTML = `<strong>${dt.textContent}</strong>${dd ? dd.innerHTML : ''}`;
    document.body.append(pop);
    const r = el.getBoundingClientRect();
    const w = pop.offsetWidth;
    const left = Math.max(16, Math.min(r.left + scrollX, scrollX + innerWidth - w - 16));
    let top = r.bottom + scrollY + 6;
    if (r.bottom + pop.offsetHeight + 12 > innerHeight) top = r.top + scrollY - pop.offsetHeight - 6;
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
  };
  $$('.t').forEach((el) => {
    el.addEventListener('mouseenter', () => openPop(el));
    el.addEventListener('mouseleave', closePop);
    el.addEventListener('focus', () => openPop(el));
    el.addEventListener('blur', closePop);
    el.addEventListener('click', (e) => { e.preventDefault(); pop ? closePop() : openPop(el); });
  });
  addEventListener('scroll', closePop, { passive: true });

  // Steppers
  const steppers = $$('.stepper').map((box) => {
    const items = $$(':scope > ol > li', box);
    let i = 0;
    const nav = document.createElement('div');
    nav.className = 'nav';
    nav.innerHTML = '<button class="btn" data-s="prev">← 前</button><button class="btn" data-s="next">次 →</button><button class="btn" data-s="all">全部</button><span></span>';
    box.append(nav);
    const label = $('span', nav);
    const paint = () => {
      items.forEach((li, k) => { li.classList.toggle('on', k <= i); li.classList.toggle('cur', k === i); });
      label.textContent = `${i + 1} / ${items.length}`;
    };
    const api = {
      box,
      done: () => i >= items.length - 1,
      next: () => { if (i < items.length - 1) { i++; paint(); } },
      prev: () => { if (i > 0) { i--; paint(); } },
      reset: () => { i = 0; paint(); },
      finish: () => { i = items.length - 1; paint(); },
    };
    nav.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.s === 'next') api.next();
      if (b.dataset.s === 'prev') api.prev();
      if (b.dataset.s === 'all') api.finish();
    });
    paint();
    return api;
  });

  // Tabs: <div class="tabs"><div data-tab="Label">...</div>...</div>
  $$('.tabs').forEach((box, n) => {
    const panels = $$(':scope > [data-tab]', box);
    const list = document.createElement('div');
    list.setAttribute('role', 'tablist');
    panels.forEach((p, k) => {
      const b = document.createElement('button');
      b.setAttribute('role', 'tab');
      b.id = `tab-${n}-${k}`;
      b.textContent = p.dataset.tab;
      p.setAttribute('role', 'tabpanel');
      p.setAttribute('aria-labelledby', b.id);
      b.addEventListener('click', () => select(k));
      list.append(b);
    });
    box.prepend(list);
    const select = (k) => {
      $$('[role="tab"]', list).forEach((b, j) => b.setAttribute('aria-selected', String(j === k)));
      panels.forEach((p, j) => { p.hidden = j !== k; });
      renderMermaid();
    };
    select(0);
  });

  // Quizzes: <div class="quiz" data-answer="2"> (1-based)
  $$('.quiz').forEach((q) => {
    const answer = Number(q.dataset.answer) - 1;
    const opts = $$('.opts button', q);
    opts.forEach((b, k) => b.addEventListener('click', () => {
      opts.forEach((o) => o.classList.remove('right', 'wrong'));
      b.classList.add(k === answer ? 'right' : 'wrong');
      if (k !== answer) opts[answer].classList.add('right');
      q.classList.add('done');
    }));
  });

  // Mermaid, rendered lazily so hidden slides do not break layout
  const mermaidBlocks = $$('pre.mermaid');
  mermaidBlocks.forEach((b) => { b.dataset.src = b.textContent; });
  let mermaidLib = null;
  let mermaidTheme = null;
  async function renderMermaid() {
    const todo = mermaidBlocks.filter((b) => !b.dataset.processed && b.offsetParent !== null);
    if (!todo.length) return;
    if (!mermaidLib) mermaidLib = (await import('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs')).default;
    const theme = isDark() ? 'dark' : 'default';
    if (theme !== mermaidTheme) { mermaidLib.initialize({ startOnLoad: false, theme, fontFamily: getComputedStyle(document.body).fontFamily }); mermaidTheme = theme; }
    await mermaidLib.run({ nodes: todo });
  }
  function rerenderMermaid() {
    mermaidBlocks.forEach((b) => { if (b.dataset.processed) { b.removeAttribute('data-processed'); b.textContent = b.dataset.src; } });
    renderMermaid();
  }

  // Scrollspy for the document view
  const tocLinks = new Map($$('a', toc).map((a) => [a.getAttribute('href').slice(1), a]));
  let activeId = content[0]?.id;
  const spy = new IntersectionObserver((entries) => {
    entries.forEach((e) => { if (e.isIntersecting) activeId = e.target.id; });
    tocLinks.forEach((a, id) => a.classList.toggle('active', id === activeId));
  }, { rootMargin: '-80px 0px -65% 0px' });
  content.forEach((s) => spy.observe(s));

  // Slide view
  let cur = 0;
  const frags = (s) => $$('[data-frag]', s);
  function show(n, { fromBack = false } = {}) {
    cur = Math.max(0, Math.min(sections.length - 1, n));
    sections.forEach((s, k) => s.classList.toggle('cur', k === cur));
    const s = sections[cur];
    frags(s).forEach((f) => f.classList.toggle('shown', fromBack));
    steppers.filter((st) => s.contains(st.box)).forEach((st) => (fromBack ? st.finish() : st.reset()));
    s.scrollTop = 0;
    $('.count', deck).textContent = `${cur + 1} / ${sections.length}`;
    progress.style.width = `${((cur + 1) / sections.length) * 100}%`;
    history.replaceState(null, '', `${location.search}#${s.id}`);
    renderMermaid();
  }
  function next() {
    const s = sections[cur];
    const hidden = frags(s).find((f) => !f.classList.contains('shown'));
    if (hidden) { hidden.classList.add('shown'); return; }
    const st = steppers.find((x) => s.contains(x.box) && !x.done());
    if (st) { st.next(); return; }
    if (cur < sections.length - 1) show(cur + 1);
  }
  function prev() { if (cur > 0) show(cur - 1, { fromBack: true }); }

  const viewBtn = $('#view-btn');
  function setView(view, { keepPlace = true } = {}) {
    const slides = view === 'slides';
    const target = keepPlace ? (slides ? activeId : sections[cur]?.id) : null;
    document.body.classList.toggle('slides', slides);
    viewBtn.setAttribute('aria-pressed', String(slides));
    viewBtn.textContent = slides ? '資料表示' : 'スライド表示';
    const url = new URL(location.href);
    if (slides) url.searchParams.set('view', 'slides'); else url.searchParams.delete('view');
    history.replaceState(null, '', url);
    closePop();
    if (slides) {
      const k = sections.findIndex((s) => s.id === target);
      show(k >= 0 ? k : 0, { fromBack: false });
    } else {
      sections.forEach((s) => s.classList.remove('cur'));
      $$('[data-frag]').forEach((f) => f.classList.add('shown'));
      renderMermaid();
      if (target && content.some((s) => s.id === target)) document.getElementById(target).scrollIntoView();
    }
  }
  viewBtn.addEventListener('click', () => setView(document.body.classList.contains('slides') ? 'doc' : 'slides'));
  deck.addEventListener('click', (e) => {
    const b = e.target.closest('[data-go]');
    if (b) (b.dataset.go === 'next' ? next : prev)();
  });

  addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, select, [contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return;
    const slides = document.body.classList.contains('slides');
    if (e.key === 's' || e.key === 'S') { setView(slides ? 'doc' : 'slides'); e.preventDefault(); return; }
    if (!slides) return;
    if (['ArrowRight', 'PageDown', ' ', 'Enter'].includes(e.key)) { next(); e.preventDefault(); }
    else if (['ArrowLeft', 'PageUp', 'Backspace'].includes(e.key)) { prev(); e.preventDefault(); }
    else if (e.key === 'Home') { show(0); e.preventDefault(); }
    else if (e.key === 'End') { show(sections.length - 1, { fromBack: true }); e.preventDefault(); }
    else if (e.key === 'Escape') { setView('doc'); }
  });

  addEventListener('hashchange', () => {
    if (!document.body.classList.contains('slides')) return;
    const k = sections.findIndex((s) => s.id === location.hash.slice(1));
    if (k >= 0 && k !== cur) show(k);
  });

  let touchX = null;
  addEventListener('touchstart', (e) => { touchX = e.touches[0].clientX; }, { passive: true });
  addEventListener('touchend', (e) => {
    if (touchX === null || !document.body.classList.contains('slides')) return;
    const dx = e.changedTouches[0].clientX - touchX;
    if (Math.abs(dx) > 60) (dx < 0 ? next : prev)();
    touchX = null;
  });

  // Initial view comes from the URL so shared links open the same way
  const initial = new URLSearchParams(location.search).get('view') === 'slides' ? 'slides' : 'doc';
  const hashId = location.hash.slice(1);
  if (hashId) activeId = hashId;
  if (initial === 'slides') {
    document.body.classList.add('slides');
    const k = sections.findIndex((s) => s.id === hashId);
    viewBtn.setAttribute('aria-pressed', 'true');
    viewBtn.textContent = '資料表示';
    show(k >= 0 ? k : 0);
  } else {
    $$('[data-frag]').forEach((f) => f.classList.add('shown'));
    renderMermaid();
  }
})();

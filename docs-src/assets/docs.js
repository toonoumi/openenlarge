/* AUTO-COPIED to web/docs/docs.js — edit docs-src/assets/docs.js then regenerate. */
(function () {
  // Mobile sidebar toggle
  var btn = document.getElementById('menu-btn');
  var side = document.getElementById('sidebar');
  if (btn && side) {
    btn.addEventListener('click', function () {
      var open = side.classList.toggle('open');
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }
  // Build "On this page" TOC from h2/h3
  var list = document.getElementById('toc-list');
  var heads = document.querySelectorAll('article.prose h2, article.prose h3');
  if (list && heads.length) {
    heads.forEach(function (h) {
      if (!h.id) h.id = h.textContent.trim().toLowerCase()
        .replace(/[^a-z0-9一-鿿]+/g, '-').replace(/^-|-$/g, '');
      var a = document.createElement('a');
      a.href = '#' + h.id; a.textContent = h.textContent;
      a.style.paddingLeft = h.tagName === 'H3' ? '20px' : '10px';
      list.appendChild(a);
    });
    // Scroll-spy
    var links = list.querySelectorAll('a');
    var obs = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          links.forEach(function (l) { l.classList.remove('active'); });
          var m = list.querySelector('a[href="#' + e.target.id + '"]');
          if (m) m.classList.add('active');
        }
      });
    }, { rootMargin: '-70px 0px -70% 0px' });
    heads.forEach(function (h) { obs.observe(h); });
  }
})();

(() => {
  "use strict";

  const els = {
    grid: document.querySelector("#gallery-grid"),
    loading: document.querySelector("#loading-state"),
    closed: document.querySelector("#closed-state"),
    empty: document.querySelector("#empty-state"),
    error: document.querySelector("#error-state"),
    retry: document.querySelector("#retry-load"),
    loadMore: document.querySelector("#load-more"),
    pageLoader: document.querySelector("#page-loader"),
    end: document.querySelector("#collection-end"),
    sentinel: document.querySelector("#load-sentinel"),
    count: document.querySelector("#media-count"),
    lightbox: document.querySelector("#lightbox"),
    lightboxMedia: document.querySelector("#lightbox-media"),
    lightboxTitle: document.querySelector("#lightbox-title"),
    lightboxMeta: document.querySelector("#lightbox-meta"),
    lightboxOriginal: document.querySelector("#lightbox-original"),
    lightboxClose: document.querySelector("#lightbox-close"),
    lightboxPrev: document.querySelector("#lightbox-prev"),
    lightboxNext: document.querySelector("#lightbox-next")
  };

  const state = { items: [], ids: new Set(), cursor: "", loading: false, done: false, openIndex: -1 };
  let lastFocused = null;
  let touchStartX = 0;

  function safeUrl(value) {
    if (!value || typeof value !== "string") return "";
    try {
      const url = new URL(value, window.location.origin);
      return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
    } catch { return ""; }
  }

  function isVideo(item) {
    return item.type === "video" || String(item.mime || "").toLowerCase().startsWith("video/");
  }

  function formatDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }).format(date);
  }

  function fileLabel(item) {
    return isVideo(item) ? "Видео" : "Фотография";
  }

  function createCard(item, index) {
    const article = document.createElement("article");
    article.className = "gallery-card";
    article.setAttribute("role", "listitem");

    const button = document.createElement("button");
    button.type = "button";
    button.className = "gallery-card__media";
    button.dataset.index = String(index);
    const guest = String(item.guestName || "Момент гостя").trim() || "Момент гостя";
    button.setAttribute("aria-label", `Открыть: ${fileLabel(item)}, ${guest}`);

    const source = safeUrl(item.url);
    const thumbnail = safeUrl(item.thumbnailUrl);
    if (isVideo(item) && !thumbnail) {
      const placeholder = document.createElement("span");
      placeholder.className = "gallery-card__video-placeholder";
      placeholder.setAttribute("aria-hidden", "true");
      placeholder.innerHTML = '<span>B<span>&amp;</span>A</span><small>Видео гостя</small>';
      button.append(placeholder);
    } else {
      const image = document.createElement("img");
      image.src = thumbnail || source;
      image.alt = "";
      image.loading = "lazy";
      image.decoding = "async";
      image.fetchPriority = index < 4 ? "high" : "low";
      button.append(image);
    }

    if (isVideo(item)) {
      const badge = document.createElement("span");
      badge.className = "video-badge";
      badge.setAttribute("aria-hidden", "true");
      badge.innerHTML = '<svg viewBox="0 0 24 24"><path d="m9 7 8 5-8 5z"/></svg>';
      button.append(badge);
    }

    const shade = document.createElement("span");
    shade.className = "gallery-card__shade";
    const name = document.createElement("span");
    name.className = "gallery-card__name";
    name.textContent = guest;
    shade.append(name);
    button.append(shade);
    article.append(button);
    return article;
  }

  function setPanel(panel) {
    [els.loading, els.closed, els.empty, els.error].forEach((node) => { node.hidden = node !== panel; });
  }

  function updateCount() {
    if (!state.items.length) { els.count.textContent = ""; return; }
    const count = state.items.length;
    const mod10 = count % 10;
    const mod100 = count % 100;
    const word = mod10 === 1 && mod100 !== 11 ? "момент" : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? "момента" : "моментов";
    els.count.textContent = state.done ? `${count} ${word}` : `${count} и ещё`;
  }

  function renderItems(items) {
    const fragment = document.createDocumentFragment();
    items.forEach((item) => {
      const source = safeUrl(item.url);
      if (!source || item.id == null || state.ids.has(String(item.id))) return;
      const normalized = { ...item, url: source };
      const index = state.items.length;
      state.items.push(normalized);
      state.ids.add(String(item.id));
      fragment.append(createCard(normalized, index));
    });
    els.grid.append(fragment);
    els.grid.hidden = state.items.length === 0;
    updateCount();
  }

  async function loadPage({ reset = false } = {}) {
    if (state.loading || (state.done && !reset)) return;
    if (reset) {
      state.items = [];
      state.ids.clear();
      state.cursor = "";
      state.done = false;
      els.grid.replaceChildren();
      els.grid.hidden = true;
      els.end.hidden = true;
      setPanel(els.loading);
    }
    state.loading = true;
    els.loadMore.hidden = true;
    els.pageLoader.hidden = reset;
    if (!reset) els.pageLoader.hidden = false;

    try {
      const params = new URLSearchParams({ limit: "24" });
      if (state.cursor) params.set("cursor", state.cursor);
      const response = await fetch(`/api/gallery?${params}`, { headers: { Accept: "application/json" }, cache: "no-store" });
      if (response.status === 404 || response.status === 403) {
        setPanel(els.closed);
        state.done = true;
        return;
      }
      if (!response.ok) throw new Error(`Gallery request failed: ${response.status}`);
      const payload = await response.json();
      if (!payload || payload.enabled !== true) {
        setPanel(els.closed);
        state.done = true;
        return;
      }
      const items = Array.isArray(payload.items) ? payload.items : [];
      setPanel(null);
      renderItems(items);
      state.cursor = typeof payload.nextCursor === "string" ? payload.nextCursor : "";
      state.done = !state.cursor;
      if (!state.items.length) setPanel(els.empty);
      els.end.hidden = !state.done || !state.items.length;
      els.loadMore.hidden = state.done;
    } catch (error) {
      console.error(error);
      if (!state.items.length) setPanel(els.error);
      else els.loadMore.hidden = false;
    } finally {
      state.loading = false;
      els.loading.hidden = true;
      els.pageLoader.hidden = true;
      updateCount();
    }
  }

  function showLightbox(index) {
    const item = state.items[index];
    if (!item) return;
    state.openIndex = index;
    const source = safeUrl(item.url);
    const guest = String(item.guestName || "Момент гостя").trim() || "Момент гостя";
    const media = isVideo(item) ? document.createElement("video") : document.createElement("img");
    if (isVideo(item)) {
      media.controls = true;
      media.playsInline = true;
      media.preload = "metadata";
      const poster = safeUrl(item.thumbnailUrl);
      if (poster) media.poster = poster;
    } else {
      media.alt = `${fileLabel(item)} от гостя ${guest}`;
      media.decoding = "async";
    }
    media.src = source;
    els.lightboxMedia.replaceChildren(media);
    els.lightboxTitle.textContent = guest;
    els.lightboxMeta.textContent = [fileLabel(item), formatDate(item.createdAt)].filter(Boolean).join(" · ");
    els.lightboxOriginal.href = source;
    els.lightboxPrev.disabled = index === 0;
    els.lightboxNext.disabled = index === state.items.length - 1 && state.done;
    els.lightbox.hidden = false;
    document.documentElement.classList.add("lightbox-open");
    els.lightboxClose.focus({ preventScroll: true });
  }

  function closeLightbox() {
    const video = els.lightboxMedia.querySelector("video");
    if (video) video.pause();
    els.lightbox.hidden = true;
    els.lightboxMedia.replaceChildren();
    document.documentElement.classList.remove("lightbox-open");
    state.openIndex = -1;
    if (lastFocused instanceof HTMLElement) lastFocused.focus({ preventScroll: true });
  }

  async function moveLightbox(step) {
    const next = state.openIndex + step;
    if (next >= state.items.length && !state.done) await loadPage();
    if (state.items[next]) showLightbox(next);
  }

  els.grid.addEventListener("click", (event) => {
    const button = event.target.closest(".gallery-card__media");
    if (!button) return;
    lastFocused = button;
    showLightbox(Number(button.dataset.index));
  });
  els.retry.addEventListener("click", () => loadPage({ reset: true }));
  els.loadMore.addEventListener("click", () => loadPage());
  els.lightboxClose.addEventListener("click", closeLightbox);
  els.lightboxPrev.addEventListener("click", () => moveLightbox(-1));
  els.lightboxNext.addEventListener("click", () => moveLightbox(1));
  els.lightbox.addEventListener("click", (event) => { if (event.target === els.lightbox) closeLightbox(); });
  els.lightboxMedia.addEventListener("touchstart", (event) => { touchStartX = event.changedTouches[0].clientX; }, { passive: true });
  els.lightboxMedia.addEventListener("touchend", (event) => {
    const distance = event.changedTouches[0].clientX - touchStartX;
    if (Math.abs(distance) > 55) moveLightbox(distance < 0 ? 1 : -1);
  }, { passive: true });
  document.addEventListener("keydown", (event) => {
    if (els.lightbox.hidden) return;
    if (event.key === "Escape") closeLightbox();
    if (event.key === "ArrowLeft") moveLightbox(-1);
    if (event.key === "ArrowRight") moveLightbox(1);
    if (event.key === "Tab") {
      const focusable = [...els.lightbox.querySelectorAll("a[href],button:not(:disabled),video[controls]")];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });

  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting) && state.items.length && !state.done) loadPage();
    }, { rootMargin: "600px 0px" });
    observer.observe(els.sentinel);
  }

  loadPage({ reset: true });
})();

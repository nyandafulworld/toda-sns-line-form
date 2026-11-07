'use strict';
/*
 * 青年部SNS かんたん投稿（LIFF）
 * - LINEで開くとLINEログイン済みの状態で起動し、Googleログインは不要。
 * - 写真は端末内で縮小・再保存してから送る（位置情報などのExifは残らない）。
 * - config.js が未設定、または ?demo=1 のときはデモ表示。どこにも送信しない。
 */
(() => {
  const CFG = Object.assign({
    liffId: '',
    apiUrl: '',
    liffUrl: '',
    oaFriendUrl: '',
    oaName: '青年部SNSの公式アカウント',
    notice: '',
    socialProofMin: 3,
    maxPhotos: 10,
    maxEdge: 2048,
    jpegQuality: 0.88,
    maxContent: 3000,
  }, window.TODA_SNS_CONFIG || {});

  const params = new URLSearchParams(location.search);
  const DEMO = params.has('demo') || !CFG.liffId || !CFG.apiUrl;

  const RIGHTS = {
    ok: '画像の権利・写っている方の掲載許可を確認済み',
    pending: '未確認のものがある／相談したい',
  };
  const PILLARS = [
    { id: 'people', label: '人と商い', icon: '🤝', desc: '自己紹介、お店・会社の紹介、仕事へのこだわり' },
    { id: 'town', label: '戸田を動かす', icon: '🏮', desc: '青年部・委員会の活動報告、地域イベントのお知らせ' },
    { id: 'wisdom', label: '知恵とつながり', icon: '💡', desc: '仕事に役立つ工夫、勉強会の学び、交流での気づき' },
  ];
  const TEMPLATES = [
    { id: 'shop', label: 'お店・会社の紹介', text: '・紹介したいこと：\n・おすすめポイント：\n・場所・営業時間など：\n・ひとこと：' },
    { id: 'event', label: 'イベントのお知らせ', text: '・イベント名：\n・日時：\n・場所：\n・参加方法・料金：\n・ひとこと：' },
    { id: 'report', label: '活動の報告', text: '・何をしたか：\n・いつ・どこで：\n・よかったこと・反響：\n・ひとこと：' },
  ];
  const STEPS = ['受付', '制作中', '確認待ち', '予約済み', '公開済み'];
  const KEY = { draft: 'toda-sns:draft:v1', name: 'toda-sns:name:v1', demo: 'toda-sns:demo:v1' };

  const state = {
    view: 'boot',
    user: { name: '', picture: '' },
    home: null,
    isFriend: null,
    chatType: 'none',
    canShareTarget: false,
    photos: [],
    form: blankForm(),
    showMore: false,
    restored: false,
    last: null,
    busy: false,
  };

  function blankForm() {
    return { content: '', name: '', pillar: '', rights: '', links: '', wantedMode: 'auto', wantedDate: '', notes: '' };
  }

  /* ---------- 小道具 ---------- */
  const app = document.getElementById('app');
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const store = {
    get(k, fallback = null) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 容量不足などは無視 */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* noop */ } },
  };
  let toastTimer;
  function toast(msg, ms = 2600) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms);
  }
  function today() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function fmtDate(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  function pillarLabel(id) { return (PILLARS.find((p) => p.id === id) || {}).label || ''; }
  function shareUrl() { return CFG.liffUrl || (location.origin + location.pathname); }

  /* ---------- API ---------- */
  class ApiError extends Error {
    constructor(code, message) { super(message || code); this.code = code; }
  }

  const RealApi = {
    async call(action, body = {}) {
      let res;
      try {
        res = await fetch(CFG.apiUrl, {
          method: 'POST',
          // text/plain にするとプリフライトが発生せず Apps Script で受けられる
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify(Object.assign({ action }, body)),
          redirect: 'follow',
        });
      } catch (e) {
        throw new ApiError('network', '通信できませんでした。電波の良い場所でもう一度お試しください。');
      }
      let json;
      try { json = await res.json(); } catch { throw new ApiError('bad_response', 'サーバーの応答を読み取れませんでした。'); }
      if (!json.ok) throw new ApiError(json.error || 'error', json.message);
      return json;
    },
    idToken() {
      const t = window.liff && liff.getIDToken();
      if (!t) throw new ApiError('auth_expired', 'LINEのログイン情報を確認できませんでした。');
      return t;
    },
    home() { return this.call('home', { idToken: this.idToken() }); },
    mine() { return this.call('mine', { idToken: this.idToken() }); },
    start(submission) { return this.call('start', { idToken: this.idToken(), submission }); },
    async upload(uploadToken, index, blob) {
      const data = await blobToBase64(blob);
      return this.call('upload', { uploadToken, index, mimeType: 'image/jpeg', data });
    },
    finish(uploadToken) { return this.call('finish', { idToken: this.idToken(), uploadToken }); },
  };

  // デモ：この端末のブラウザ内だけで完結し、どこにも送信しない
  const DemoApi = {
    db() {
      const d = store.get(KEY.demo);
      if (d) return d;
      const seed = {
        seq: 2,
        subs: [
          { receiptNo: 'SNS-20261021-L001', createdAt: '2026-10-21T20:12:00+09:00', excerpt: '（例）新メニューが登場！ 商工祭のブースで販売します', status: '公開済み', publicUrl: 'https://www.instagram.com/toda_impulse/', photoCount: 3 },
          { receiptNo: 'SNS-20261102-L002', createdAt: '2026-11-02T12:40:00+09:00', excerpt: '（例）委員会で地域清掃に参加しました', status: '制作中', publicUrl: '', photoCount: 4 },
        ],
      };
      store.set(KEY.demo, seed);
      return seed;
    },
    async home() {
      await wait(250);
      const d = this.db();
      return { ok: true, profile: { name: store.get(KEY.name, '') }, stats: { monthCount: 7 + d.subs.length, monthPeople: 6 }, mineCount: d.subs.length };
    },
    async mine() { await wait(250); return { ok: true, items: this.db().subs.slice().reverse() }; },
    async start(sub) {
      await wait(300);
      const d = this.db();
      d.seq += 1;
      const ymd = today().replace(/-/g, '');
      const receiptNo = `SNS-${ymd}-L${String(d.seq).padStart(3, '0')}`;
      d.pending = { receiptNo, excerpt: sub.content.replace(/\s+/g, ' ').slice(0, 40), photoCount: sub.photoCount };
      store.set(KEY.demo, d);
      return { ok: true, receiptNo, uploadToken: 'demo' };
    },
    async upload() { await wait(380); return { ok: true }; },
    async finish() {
      await wait(300);
      const d = this.db();
      const p = d.pending;
      d.subs.push({ receiptNo: p.receiptNo, createdAt: new Date().toISOString(), excerpt: p.excerpt, status: '受付', publicUrl: '', photoCount: p.photoCount });
      delete d.pending;
      store.set(KEY.demo, d);
      return { ok: true, receiptNo: p.receiptNo };
    },
  };

  const Api = DEMO ? DemoApi : RealApi;

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1]);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }

  /* ---------- LIFF ---------- */
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.async = true; s.onload = resolve; s.onerror = () => reject(new Error('sdk'));
      document.head.appendChild(s);
    });
  }

  async function initLiff() {
    await loadScript('https://static.line-scdn.net/liff/edge/2/sdk.js');
    await liff.init({ liffId: CFG.liffId });
    if (!liff.isLoggedIn()) {
      liff.login({ redirectUri: location.href });
      return new Promise(() => {}); // ログイン画面へ移動
    }
    const profile = await liff.getProfile();
    state.user = { name: profile.displayName || '', picture: profile.pictureUrl || '' };
    const ctx = liff.getContext() || {};
    state.chatType = ctx.type || 'none';
    state.canShareTarget = liff.isApiAvailable && liff.isApiAvailable('shareTargetPicker');
    if (CFG.oaFriendUrl) {
      try { state.isFriend = (await liff.getFriendship()).friendFlag; } catch { state.isFriend = null; }
    }
  }

  async function relogin() {
    if (DEMO || !window.liff) return;
    try { liff.logout(); } catch { /* noop */ }
    liff.login({ redirectUri: location.href });
  }

  /* ---------- 画面遷移 ---------- */
  function go(view, { push = true } = {}) {
    state.view = view;
    if (push && view !== 'sending') history.pushState({ view }, '', location.href);
    render();
    window.scrollTo(0, 0);
  }
  window.addEventListener('popstate', (e) => {
    if (state.view === 'sending') { history.pushState({ view: 'sending' }, '', location.href); return; }
    const v = (e.state && e.state.view) || 'home';
    state.view = v === 'done' ? 'home' : v;
    render();
  });

  function render() {
    const views = { home: viewHome, form: viewForm, sending: viewSending, done: viewDone, mine: viewMine, error: viewError };
    (views[state.view] || viewHome)();
  }

  function demoBar() {
    if (DEMO && params.get('banner') === 'proto') return `<div class="demo-bar demo-bar--proto">${esc(CFG.notice || '試作版です')}</div>`;
    if (DEMO) return '<div class="demo-bar">デモ表示です。入力した内容はどこにも送信されません</div>';
    return CFG.notice ? `<div class="demo-bar demo-bar--proto">${esc(CFG.notice)}</div>` : '';
  }

  function avatar() {
    if (state.user.picture) return `<img class="avatar" src="${esc(state.user.picture)}" alt="">`;
    return `<span class="avatar" aria-hidden="true">${esc((state.user.name || '青')[0])}</span>`;
  }

  /* ---------- ホーム ---------- */
  function viewHome() {
    const h = state.home || {};
    const stats = h.stats || {};
    const n = Number(stats.monthCount || 0);
    const proof = n >= CFG.socialProofMin
      ? `<div class="proof"><span aria-hidden="true">🔥</span><span>今月はすでに <b>${n}件</b> の話題が届いています</span></div>`
      : '<div class="proof"><span aria-hidden="true">📣</span><span>今月の話題を募集しています。最初の1件をお待ちしています！</span></div>';
    const name = state.user.name ? `${esc(state.user.name)}さん、お疲れさまです！` : 'お疲れさまです！';
    app.innerHTML = `
      <section class="screen">
        ${demoBar()}
        <div class="brand"><div class="brand__mark">SNS</div><div class="brand__name"><strong>青年部SNS かんたん投稿</strong>戸田市商工会青年部</div></div>
        <div class="hello">
          <div class="hello__who">${avatar()}<span>${name}</span></div>
          <h1>写真と箇条書きを<br>送るだけで<em>OK</em></h1>
          <p>文章と画像はSNS担当が仕上げます。<br>Googleへのログインは不要です。</p>
        </div>
        ${proof}
        <div class="home-cta">
          <button class="cta" data-act="start" type="button"><span aria-hidden="true">📷</span><span>写真をえらんで はじめる</span></button>
          <p class="home-cta__note">入力は約1分・必須は4つだけ</p>
        </div>
        <h2 class="section-title">こんな話題を待っています <small>迷ったら選んでください</small></h2>
        <div class="themes">
          ${PILLARS.map((p) => `
            <button class="theme" type="button" data-act="theme" data-pillar="${p.id}">
              <span class="theme__icon" aria-hidden="true">${p.icon}</span>
              <span><span class="theme__label">${p.label}</span><br><span class="theme__desc">${p.desc}</span></span>
              <span class="theme__go" aria-hidden="true">›</span>
            </button>`).join('')}
        </div>
        <button class="linkrow" type="button" data-act="mine">
          <span class="linkrow__icon" aria-hidden="true">📋</span>
          <span class="linkrow__text"><b>マイ投稿</b><span>送った話題の進み具合を確認できます</span></span>
          <span class="theme__go" aria-hidden="true">›</span>
        </button>
        <div class="assure">
          <b>安心して送れるように</b>
          <ul>
            <li>送った内容を見られるのはSNS担当だけです。</li>
            <li>掲載の許可が確認できたものだけを公開します。</li>
            <li>公開前に、必要なときだけ内容の確認をお願いします。</li>
          </ul>
        </div>
      </section>`;
    $('[data-act="start"]').onclick = () => openForm();
    $$('[data-act="theme"]').forEach((b) => { b.onclick = () => openForm(b.dataset.pillar); });
    $('[data-act="mine"]').onclick = () => openMine();
  }

  /* ---------- フォーム ---------- */
  function openForm(pillar) {
    const draft = store.get(KEY.draft);
    if (draft && !state.form.content && (draft.content || draft.notes)) {
      state.form = Object.assign(blankForm(), draft);
      state.restored = true;
    }
    if (!state.form.name) state.form.name = store.get(KEY.name, '') || (state.home && state.home.profile && state.home.profile.name) || '';
    if (pillar) state.form.pillar = pillar;
    go('form');
  }

  let saveTimer;
  function saveDraft() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => store.set(KEY.draft, state.form), 400);
  }

  function missing() {
    const f = state.form;
    const list = [];
    if (!state.photos.some((p) => p.blob)) list.push('写真');
    if (f.content.trim().length < 5) list.push('伝えたいこと');
    if (!f.rights) list.push('掲載の許可');
    if (!f.name.trim()) list.push('お名前・所属');
    return list;
  }

  function viewForm() {
    const f = state.form;
    app.innerHTML = `
      <section class="screen">
        ${demoBar()}
        <div class="topbar">
          <button class="topbar__back" type="button" data-act="back" aria-label="もどる">‹</button>
          <div class="topbar__title">話題を送る</div>
          <span class="pill" id="remain"></span>
        </div>
        ${state.restored ? '<div class="restore"><span>前回の入力を復元しました（写真は選び直してください）</span><button type="button" data-act="clear-draft">消す</button></div>' : ''}

        <div class="card">
          <div class="card__head"><span class="step" data-step="photo">1</span><span class="card__title">写真（1〜10枚）</span><span class="req">必須</span></div>
          <div class="photos" id="photos"></div>
          <input class="file-input" id="file" type="file" accept="image/*" multiple>
          <p class="hint">1枚目が表紙の候補になります。写真は自動で縮小し、位置情報は消してから送ります。</p>
        </div>

        <div class="card">
          <div class="card__head"><span class="step" data-step="content">2</span><span class="card__title">伝えたいこと</span><span class="req">必須</span></div>
          <div class="chips" role="group" aria-label="テーマ">
            <span class="chips__label">テーマ（任意）</span>
            ${PILLARS.map((p) => `<button class="chip" type="button" data-pillar="${p.id}" aria-pressed="${f.pillar === p.id}">${p.icon} ${p.label}</button>`).join('')}
            <button class="chip" type="button" data-pillar="" aria-pressed="${!f.pillar}">おまかせ</button>
          </div>
          <div class="chips">
            <span class="chips__label">書き出しのひな形（タップで入ります）</span>
            ${TEMPLATES.map((t) => `<button class="chip chip--tpl" type="button" data-tpl="${t.id}">＋ ${t.label}</button>`).join('')}
          </div>
          <textarea id="content" maxlength="${CFG.maxContent}" placeholder="例）&#10;・新メニュー「〇〇うどん」が登場&#10;・11/23(月祝) 戸田駅前のイベントで販売&#10;・ひとこと：まずは出汁をひと口！">${esc(f.content)}</textarea>
          <div class="counter"><span id="count">0</span>文字</div>
          <p class="hint">箇条書きでOK。イベントは「名称・日時・場所」があると助かります。文章はSNS担当が整えます。</p>
        </div>

        <div class="card">
          <div class="card__head"><span class="step" data-step="rights">3</span><span class="card__title">掲載の許可</span><span class="req">必須</span></div>
          <div class="choice" role="radiogroup" aria-label="掲載の許可">
            <button class="choice__item" type="button" role="radio" data-rights="ok" aria-checked="${f.rights === 'ok'}">
              <span class="choice__mark"></span>
              <span><span class="choice__label">確認しました</span><br><span class="choice__desc">写っている方の許可と、画像の権利を確認済みです</span></span>
            </button>
            <button class="choice__item" type="button" role="radio" data-rights="pending" aria-checked="${f.rights === 'pending'}">
              <span class="choice__mark"></span>
              <span><span class="choice__label">まだ／相談したい</span><br><span class="choice__desc">確認がとれるまで公開しません。SNS担当からご相談します</span></span>
            </button>
          </div>
        </div>

        <div class="card">
          <div class="card__head"><span class="step" data-step="name">4</span><span class="card__title">お名前・所属</span><span class="req">必須</span></div>
          <input id="name" type="text" maxlength="100" autocomplete="name" placeholder="例）戸田太郎／とだ商店" value="${esc(f.name)}">
          <p class="hint">次回からは自動で入ります。</p>
        </div>

        <button class="more" type="button" data-act="more" aria-expanded="${state.showMore}">
          <span aria-hidden="true">${state.showMore ? '－' : '＋'}</span><span>もっと伝える <span class="opt">任意</span><br><small class="more__sub">載せたいリンク・希望の投稿日・補足</small></span>
        </button>
        <div class="card" id="more" ${state.showMore ? '' : 'hidden'}>
          <div class="field" style="margin-top:0">
            <label for="links">載せたいリンク・アカウント・連絡先 <span class="opt">任意</span></label>
            <input id="links" type="text" maxlength="500" placeholder="例）@toda_impulse ／ https://〜" value="${esc(f.links)}">
          </div>
          <div class="field">
            <label>希望の投稿日 <span class="opt">任意</span></label>
            <div class="seg" role="group" aria-label="希望の投稿日">
              <button type="button" data-wanted="auto" aria-pressed="${f.wantedMode === 'auto'}">おまかせ</button>
              <button type="button" data-wanted="asap" aria-pressed="${f.wantedMode === 'asap'}">なるべく早く</button>
              <button type="button" data-wanted="date" aria-pressed="${f.wantedMode === 'date'}">日付を選ぶ</button>
            </div>
            <input id="wantedDate" type="date" min="${today()}" value="${esc(f.wantedDate)}" ${f.wantedMode === 'date' ? '' : 'hidden'}>
            <p class="hint">希望日はできるだけ調整しますが、確約ではありません。</p>
          </div>
          <div class="field">
            <label for="notes">補足・要望 <span class="opt">任意</span></label>
            <textarea id="notes" maxlength="1500" style="min-height:90px" placeholder="例）写真の撮影者名を載せてほしい、価格は未定です など">${esc(f.notes)}</textarea>
          </div>
        </div>
      </section>
      <div class="dock"><div class="dock__inner">
        <button class="cta" id="submit" type="button">この内容で送る</button>
        <p class="dock__note" id="dockNote"></p>
      </div></div>`;

    $('[data-act="back"]').onclick = () => history.back();
    const clear = $('[data-act="clear-draft"]');
    if (clear) clear.onclick = () => { store.del(KEY.draft); const name = state.form.name; state.form = blankForm(); state.form.name = name; state.restored = false; render(); };

    const file = $('#file');
    file.onchange = () => { addFiles(Array.from(file.files || [])); file.value = ''; };

    $$('[data-pillar]').forEach((b) => {
      b.onclick = () => {
        state.form.pillar = b.dataset.pillar;
        $$('[data-pillar]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.pillar === state.form.pillar)));
        saveDraft();
      };
    });
    $$('[data-tpl]').forEach((b) => {
      b.onclick = () => {
        const t = TEMPLATES.find((x) => x.id === b.dataset.tpl);
        const ta = $('#content');
        ta.value = ta.value.trim() ? `${ta.value.replace(/\s+$/, '')}\n${t.text}` : t.text;
        state.form.content = ta.value;
        ta.focus();
        const firstBlank = ta.value.indexOf('：', ta.value.length - t.text.length) + 1;
        if (firstBlank > 0) ta.setSelectionRange(firstBlank, firstBlank);
        updateStatus(); saveDraft();
      };
    });
    const bind = (id, key) => {
      const el = $(`#${id}`);
      el.addEventListener('input', () => { state.form[key] = el.value; updateStatus(); saveDraft(); });
    };
    bind('content', 'content'); bind('name', 'name'); bind('links', 'links'); bind('notes', 'notes'); bind('wantedDate', 'wantedDate');

    $$('[data-rights]').forEach((b) => {
      b.onclick = () => {
        state.form.rights = b.dataset.rights;
        $$('[data-rights]').forEach((x) => x.setAttribute('aria-checked', String(x.dataset.rights === state.form.rights)));
        updateStatus(); saveDraft();
      };
    });
    $('[data-act="more"]').onclick = () => {
      state.showMore = !state.showMore;
      $('#more').hidden = !state.showMore;
      const btn = $('[data-act="more"]');
      btn.setAttribute('aria-expanded', String(state.showMore));
      btn.firstElementChild.textContent = state.showMore ? '－' : '＋';
    };
    $$('[data-wanted]').forEach((b) => {
      b.onclick = () => {
        state.form.wantedMode = b.dataset.wanted;
        $$('[data-wanted]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.wanted === state.form.wantedMode)));
        $('#wantedDate').hidden = state.form.wantedMode !== 'date';
        saveDraft();
      };
    });
    $('#submit').onclick = submit;
    renderPhotos();
    updateStatus();
  }

  function renderPhotos() {
    const box = $('#photos');
    if (!box) return;
    const tiles = state.photos.map((p, i) => {
      if (!p.blob) return `<div class="photo photo--busy">${p.error ? '読込失敗' : '準備中…'}</div>`;
      return `<div class="photo">
        <img src="${p.url}" alt="${i + 1}枚目の写真">
        <span class="photo__no">${i + 1}</span>
        ${i === 0 ? '<span class="photo__cover">表紙</span>' : ''}
        <button class="photo__del" type="button" data-del="${i}" aria-label="${i + 1}枚目を外す">×</button>
      </div>`;
    });
    if (state.photos.length < CFG.maxPhotos) {
      tiles.push(`<label class="photo photo--add" for="file"><span aria-hidden="true">＋</span>${state.photos.length ? '写真を追加' : '写真をえらぶ'}</label>`);
    }
    box.innerHTML = tiles.join('');
    $$('[data-del]', box).forEach((b) => {
      b.onclick = () => {
        const [removed] = state.photos.splice(Number(b.dataset.del), 1);
        if (removed && removed.url) URL.revokeObjectURL(removed.url);
        renderPhotos(); updateStatus();
      };
    });
  }

  async function addFiles(files) {
    const room = CFG.maxPhotos - state.photos.length;
    if (files.length > room) toast(`写真は${CFG.maxPhotos}枚までです。先頭の${room}枚を使います。`);
    const picked = files.slice(0, Math.max(0, room));
    const slots = picked.map(() => ({ blob: null }));
    state.photos.push(...slots);
    renderPhotos(); updateStatus();
    for (let i = 0; i < picked.length; i += 1) {
      try {
        Object.assign(slots[i], await prepareImage(picked[i]));
      } catch (e) {
        slots[i].error = true;
        toast('読み込めない写真がありました（HEIC形式など）。別の写真かスクリーンショットでお試しください。', 4200);
      }
      renderPhotos(); updateStatus();
    }
    // 読み込みに失敗した枠は外す
    const failed = state.photos.filter((p) => p.error);
    if (failed.length) {
      setTimeout(() => { state.photos = state.photos.filter((p) => !p.error); renderPhotos(); updateStatus(); }, 1800);
    }
  }

  async function decodeImage(file) {
    if ('createImageBitmap' in window) {
      try {
        const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
        return { source: bmp, width: bmp.width, height: bmp.height, cleanup: () => bmp.close && bmp.close() };
      } catch { /* 下の方法で再試行 */ }
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    try { await img.decode(); } catch (e) { URL.revokeObjectURL(url); throw e; }
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, cleanup: () => URL.revokeObjectURL(url) };
  }

  async function prepareImage(file) {
    if (file.type && !/^image\//.test(file.type)) throw new Error('not_image');
    const { source, width, height, cleanup } = await decodeImage(file);
    if (!width || !height) { cleanup(); throw new Error('decode'); }
    const scale = Math.min(1, CFG.maxEdge / Math.max(width, height));
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(source, 0, 0, w, h);
    cleanup();
    const blob = await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode'))), 'image/jpeg', CFG.jpegQuality));
    return { blob, width: w, height: h, url: URL.createObjectURL(blob) };
  }

  function updateStatus() {
    const miss = missing();
    const remain = $('#remain');
    if (!remain) return;
    remain.textContent = miss.length ? `必須 あと${miss.length}つ` : '送信できます';
    remain.className = miss.length ? 'pill' : 'pill pill--done';
    const done = {
      photo: state.photos.some((p) => p.blob),
      content: state.form.content.trim().length >= 5,
      rights: !!state.form.rights,
      name: !!state.form.name.trim(),
    };
    $$('[data-step]').forEach((s) => {
      const ok = done[s.dataset.step];
      s.classList.toggle('step--done', ok);
      s.textContent = ok ? '✓' : String(['photo', 'content', 'rights', 'name'].indexOf(s.dataset.step) + 1);
    });
    const count = $('#count');
    if (count) count.textContent = String(state.form.content.length);
    const btn = $('#submit');
    const busyPhoto = state.photos.some((p) => !p.blob && !p.error);
    btn.disabled = miss.length > 0 || busyPhoto || state.busy;
    $('#dockNote').textContent = busyPhoto ? '写真を準備しています…' : (miss.length ? `あと「${miss.join('」「')}」で送れます` : 'SNS担当に届きます。すぐには公開されません');
  }

  function wantedValue() {
    const f = state.form;
    if (f.wantedMode === 'asap') return 'なるべく早く';
    if (f.wantedMode === 'date' && f.wantedDate) return f.wantedDate;
    return '';
  }

  async function submit() {
    if (missing().length || state.busy) return;
    state.busy = true;
    const photos = state.photos.filter((p) => p.blob);
    const f = state.form;
    const submission = {
      name: f.name.trim(),
      content: f.content.trim(),
      pillar: pillarLabel(f.pillar),
      rights: RIGHTS[f.rights],
      links: f.links.trim(),
      wanted: wantedValue(),
      notes: f.notes.trim(),
      photoCount: photos.length,
    };
    state.sendProgress = { done: 0, total: photos.length, label: '受付を準備しています…' };
    go('sending', { push: false });
    try {
      const started = await Api.start(submission);
      for (let i = 0; i < photos.length; i += 1) {
        state.sendProgress.label = `写真を送っています（${i + 1} / ${photos.length}）`;
        updateSending();
        await withRetry(() => Api.upload(started.uploadToken, i, photos[i].blob));
        state.sendProgress.done = i + 1;
        updateSending();
      }
      state.sendProgress.label = '仕上げています…';
      updateSending();
      const fin = await withRetry(() => Api.finish(started.uploadToken));
      store.set(KEY.name, submission.name);
      store.del(KEY.draft);
      state.last = { receiptNo: fin.receiptNo || started.receiptNo, pillar: submission.pillar };
      photos.forEach((p) => p.url && URL.revokeObjectURL(p.url));
      state.photos = [];
      const keepName = submission.name;
      state.form = blankForm();
      state.form.name = keepName;
      state.restored = false;
      state.showMore = false;
      if (state.home && state.home.stats) state.home.stats.monthCount = Number(state.home.stats.monthCount || 0) + 1;
      state.busy = false;
      history.replaceState({ view: 'home' }, '', location.href);
      go('done');
    } catch (e) {
      state.busy = false;
      if (e.code === 'auth_expired') {
        toast('LINEのログインを更新します。入力内容は保存されています。', 3500);
        await wait(1200);
        relogin();
        return;
      }
      state.view = 'form';
      render();
      const msg = e.message || '送信できませんでした。';
      const box = document.createElement('div');
      box.className = 'error-box';
      box.textContent = `${msg} 入力内容は残っています。もう一度「この内容で送る」を押してください。`;
      $('.screen').insertBefore(box, $('.screen').children[DEMO ? 2 : 1]);
      window.scrollTo(0, 0);
    }
  }

  async function withRetry(fn, tries = 3) {
    let last;
    for (let i = 0; i < tries; i += 1) {
      try { return await fn(); } catch (e) {
        last = e;
        if (e.code && e.code !== 'network' && e.code !== 'bad_response') throw e;
        await wait(800 * (i + 1));
      }
    }
    throw last;
  }

  /* ---------- 送信中 ---------- */
  function viewSending() {
    app.innerHTML = `
      <section class="sending">
        <div class="sending__icon" aria-hidden="true">📮</div>
        <h2>送信しています</h2>
        <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="bar__fill" id="barFill"></div></div>
        <p id="sendLabel"></p>
        <p>画面を閉じずに、そのままお待ちください。</p>
      </section>`;
    updateSending();
  }
  function updateSending() {
    const p = state.sendProgress || { done: 0, total: 1, label: '' };
    const pct = Math.round(((p.done + 0.5) / (p.total + 1)) * 100);
    const fill = $('#barFill');
    if (fill) fill.style.width = `${Math.min(100, pct)}%`;
    const bar = $('.bar');
    if (bar) bar.setAttribute('aria-valuenow', String(pct));
    const label = $('#sendLabel');
    if (label) label.textContent = p.label;
  }

  /* ---------- 完了 ---------- */
  function viewDone() {
    const last = state.last || {};
    const canGroup = DEMO || state.chatType === 'group' || state.chatType === 'room' || state.canShareTarget;
    const groupLabel = 'グループに「送ったよ」と伝える';
    const showFriend = CFG.oaFriendUrl ? state.isFriend === false : DEMO;
    app.innerHTML = `
      <section class="screen">
        ${demoBar()}
        <div class="done-hero">
          <div class="done-hero__check" aria-hidden="true">✓</div>
          <h1>受付しました！</h1>
          <p>ありがとうございます。<br>SNS担当が文章と画像に仕上げます。</p>
          <div class="receipt">受付番号 <b>${esc(last.receiptNo || '')}</b></div>
        </div>
        ${canGroup ? `<div class="stack">
          <button class="cta cta--line" type="button" data-act="share"><span aria-hidden="true">💬</span><span>${groupLabel}</span></button>
          <p class="share-note">あなたの名前で、グループにひとこと投稿されます（内容は載りません）</p>
        </div>` : ''}
        <div class="card" style="margin-top:14px">
          <div class="card__head"><span class="card__title">このあとの流れ</span></div>
          <ol class="timeline">
            <li class="is-done"><span class="tl-dot">✓</span><span><span class="tl-title">受付</span><br><span class="tl-desc">いま完了しました</span></span></li>
            <li class="is-now"><span class="tl-dot" aria-hidden="true">✍️</span><span><span class="tl-title">SNS担当が投稿を作成</span><br><span class="tl-desc">届いた順に、文章と画像を仕上げます</span></span></li>
            <li><span class="tl-dot" aria-hidden="true">💬</span><span><span class="tl-title">内容の確認</span><br><span class="tl-desc">気になる点があるときだけ、LINEでご相談します</span></span></li>
            <li><span class="tl-dot" aria-hidden="true">🎉</span><span><span class="tl-title">公開のお知らせ</span><br><span class="tl-desc">公開されたら、LINEでお知らせします</span></span></li>
          </ol>
        </div>
        ${showFriend ? `<div class="friend"><span aria-hidden="true">🔔</span><p>公開のお知らせを受け取るには、${esc(CFG.oaName)}を友だち追加してください。</p><a href="${esc(CFG.oaFriendUrl || '#')}" data-act="friend">友だち追加</a></div>` : ''}
        <div class="stack">
          <button class="cta cta--ghost" type="button" data-act="again">もう1件送る</button>
          <button class="cta cta--ghost" type="button" data-act="mine">マイ投稿を見る</button>
          ${!DEMO && window.liff && liff.isInClient() ? '<button class="cta cta--ghost" type="button" data-act="close">閉じる</button>' : ''}
        </div>
      </section>`;
    const share = $('[data-act="share"]');
    if (share) share.onclick = () => shareToGroup(last);
    $('[data-act="again"]').onclick = () => openForm();
    $('[data-act="mine"]').onclick = () => openMine();
    const close = $('[data-act="close"]');
    if (close) close.onclick = () => liff.closeWindow();
    const friend = $('[data-act="friend"]');
    if (friend && DEMO) friend.onclick = (e) => { e.preventDefault(); toast('デモ：公式アカウントの友だち追加画面が開きます'); };
  }

  function groupMessage(last) {
    const theme = last.pillar ? `（テーマ：${last.pillar}）` : '';
    return `📷 青年部SNSに話題を送りました！${theme}\n\nLINEから1分で送れます。\nみなさんもお気軽にどうぞ👇\n${shareUrl()}`;
  }

  async function shareToGroup(last) {
    const text = groupMessage(last);
    if (DEMO) { toast(`デモ：グループに次のメッセージが送られます\n\n${text}`, 5200); return; }
    try {
      if (state.chatType === 'group' || state.chatType === 'room') {
        await liff.sendMessages([{ type: 'text', text }]);
        toast('グループに伝えました！');
      } else if (state.canShareTarget) {
        const res = await liff.shareTargetPicker([{ type: 'text', text }], { isMultiple: false });
        if (res) toast('送りました！');
      }
    } catch (e) {
      toast('送れませんでした。グループのトーク画面から開くとお知らせできます。', 3800);
    }
  }

  /* ---------- マイ投稿 ---------- */
  async function openMine() {
    go('mine');
  }

  async function viewMine() {
    app.innerHTML = `
      <section class="screen">
        ${demoBar()}
        <div class="topbar">
          <button class="topbar__back" type="button" data-act="back" aria-label="もどる">‹</button>
          <div class="topbar__title">マイ投稿</div>
        </div>
        <div id="mineBody"><p class="hint">読み込んでいます…</p></div>
      </section>`;
    $('[data-act="back"]').onclick = () => history.back();
    try {
      const res = await Api.mine();
      if (state.view !== 'mine') return;
      const items = res.items || [];
      const published = items.filter((x) => x.status === '公開済み').length;
      $('#mineBody').innerHTML = items.length ? `
        <div class="thanks">これまでに <b>${items.length}件</b> 送っていただきました${published ? `（公開 ${published}件）` : ''}
          <p>いつもありがとうございます！ 1件1件が、青年部を知ってもらうきっかけになっています。</p></div>
        ${items.map(itemCard).join('')}
        <div class="stack"><button class="cta" type="button" data-act="start">📷 新しい話題を送る</button></div>`
        : `<div class="empty"><div class="empty__icon" aria-hidden="true">🌱</div><p>まだ送った話題はありません。<br>最初の1件を送ってみませんか？</p>
           <button class="cta" type="button" data-act="start">📷 写真をえらんで はじめる</button></div>`;
      $('[data-act="start"]').onclick = () => openForm();
    } catch (e) {
      if (e.code === 'auth_expired') { relogin(); return; }
      $('#mineBody').innerHTML = `<div class="error-box">${esc(e.message || '読み込めませんでした。')}</div>`;
    }
  }

  function itemCard(x) {
    const stopped = x.status === '見送り';
    const idx = Math.max(0, STEPS.indexOf(x.status));
    const pub = x.status === '公開済み';
    return `<article class="sub">
      <div class="sub__meta"><span>${esc(fmtDate(x.createdAt))}・写真${Number(x.photoCount || 0)}枚</span><span>${esc(x.receiptNo)}</span></div>
      <p class="sub__text">${esc(x.excerpt || '')}</p>
      ${stopped ? '<div class="sub__status">⏸ 今回は掲載を見送りました。詳しくはSNS担当からご連絡します</div>' : `
      <div class="progress ${pub ? 'progress--published' : ''}">${STEPS.map((_, i) => `<span class="${i <= idx ? 'on' : ''}"></span>`).join('')}</div>
      <div class="progress-labels">${STEPS.map((s, i) => `<span class="${i === idx ? 'on' : ''}">${s}</span>`).join('')}</div>
      <div class="sub__status">${statusText(x)}${pub && x.publicUrl ? `<a href="${esc(x.publicUrl)}" target="_blank" rel="noopener">投稿を見る ›</a>` : ''}</div>`}
    </article>`;
  }

  function statusText(x) {
    switch (x.status) {
      case '受付': return '📨 受付しました。順番に作成します';
      case '制作中': return '✍️ SNS担当が作成しています';
      case '確認待ち': return '💬 内容の確認をお願いしています';
      case '予約済み': return `📅 投稿を予約しました${x.scheduledAt ? `（${esc(x.scheduledAt)}）` : ''}`;
      case '公開済み': return '🎉 公開されました！';
      default: return esc(x.status || '');
    }
  }

  /* ---------- エラー ---------- */
  function viewError() {
    app.innerHTML = `
      <section class="screen">
        <div class="empty"><div class="empty__icon" aria-hidden="true">⚠️</div>
          <p>${esc(state.errorMessage || '読み込めませんでした。')}</p>
          <button class="cta" type="button" data-act="retry">もう一度読み込む</button>
        </div>
      </section>`;
    $('[data-act="retry"]').onclick = () => location.reload();
  }

  /* ---------- 起動 ---------- */
  async function boot() {
    try {
      if (DEMO) {
        state.user = { name: '戸田 太郎', picture: '' };
        state.chatType = 'group';
      } else {
        await initLiff();
      }
      try { state.home = await Api.home(); } catch (e) {
        if (e.code === 'auth_expired') { relogin(); return; }
        state.home = null; // ホームの集計が取れなくても投稿はできるようにする
      }
      const q = new URLSearchParams(location.search);
      const first = q.get('view');
      history.replaceState({ view: 'home' }, '', location.href);
      const shot = DEMO ? q.get('shot') : null;
      if (shot) { await demoShot(shot); return; }
      if (first === 'form') openForm(q.get('pillar') || '');
      else if (first === 'mine') openMine();
      else go('home', { push: false });
    } catch (e) {
      state.errorMessage = 'LINEとの接続に失敗しました。LINEアプリからもう一度開いてください。';
      go('error', { push: false });
    }
  }

  // スクリーンショット・説明用：デモ時だけサンプル写真を入れられる
  if (DEMO) {
    window.__demoFill = async (opts = {}) => {
      const names = opts.photos || ['demo/demo-community-market.jpg', 'demo/demo-workshop.jpg', 'demo/demo-member-story.jpg'];
      const files = await Promise.all(names.map(async (n) => {
        const b = await (await fetch(n)).blob();
        return new File([b], n.split('/').pop(), { type: 'image/jpeg' });
      }));
      if (state.view !== 'form') openForm(opts.pillar || 'people');
      if (opts.pillar !== undefined) state.form.pillar = opts.pillar;
      state.form.content = opts.content ?? '・新メニュー「〇〇うどん」が登場\n・11/23(月祝) 戸田駅前のイベントで販売\n・ひとこと：まずは出汁をひと口！';
      state.form.rights = opts.rights ?? 'ok';
      state.form.name = opts.name ?? '戸田太郎／とだ商店';
      render();
      await addFiles(files);
    };
  }

  async function demoShot(shot) {
    if (shot === 'home') { go('home', { push: false }); return; }
    if (shot === 'form' || shot === 'form-bottom') {
      await window.__demoFill({ pillar: 'people' });
      await wait(400);
      if (shot === 'form-bottom') {
        const el = $('[data-rights="ok"]');
        if (el) window.scrollTo(0, el.closest('.card').offsetTop - 70);
      }
      return;
    }
    if (shot === 'empty') { openForm(); return; }
    if (shot === 'done') {
      state.last = { receiptNo: `SNS-${today().replace(/-/g, '')}-L010`, pillar: '人と商い' };
      go('done', { push: false });
      return;
    }
    if (shot === 'mine') { openMine(); return; }
    go('home', { push: false });
  }

  boot();
})();

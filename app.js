(function () {
  // 今日（日本時間）。月を読んだあとはサーバーの日付で上書きする
  var TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  var API_URL = String((window.EVENT_CONFIG && window.EVENT_CONFIG.apiUrl) || '');
  var WEEK = ['日', '月', '火', '水', '木', '金', '土'];
  var MAX_SIDE = 1600;
  var MAX_BYTES = 1500000;

  var state = {
    ym: TODAY.slice(0, 7),
    today: TODAY,
    events: [],
    needsPassphrase: false,
    requestNo: 0,
    loadedYm: null,     // カレンダーに読み込んである月（まだなら null）
    monthDirty: false,  // 登録・更新・削除のあと、カレンダーを読み直す
    calScroll: 0,       // 詳細ページに移る前のカレンダーのスクロール位置
    view: null,         // 'calendar' / 'detail:<ID>' / 'register'
    detailNo: 0,
    inAppHistory: false, // 直前の履歴がこの画面の中のもの（「‹ カレンダーに戻る」でブラウザの戻ると同じ動きにする）
    flash: '',          // 詳細ページの上に出すメッセージ（登録しました／更新しました）
    flyer: null, // { base64, mimeType }
    edit: null   // 編集中：{ event }。新規登録のときは null
  };

  // ---- 小さな道具 ----
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  /**
   * GAS の API（/exec）を呼ぶ。本文は { api, args } の JSON。
   * Content-Type を text/plain にして preflight を出さない（GAS は OPTIONS に応えられない）
   */
  function call(fn, args, onOk, onErr) {
    fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ api: fn, args: args }),
      redirect: 'follow'
    }).then(function (res) {
      if (!res.ok) throw new Error('通信に失敗しました（' + res.status + '）');
      return res.json();
    }).then(onOk, function (err) {
      onErr((err && err.message) || String(err));
    });
  }
  function addMonth(ym, n) {
    var y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7)) - 1 + n;
    y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
    return y + '-' + ('0' + (m + 1)).slice(-2);
  }
  function weekdayOf(date) {
    return new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))).getDay();
  }
  function dateLabel(date) {
    return Number(date.slice(5, 7)) + '月' + Number(date.slice(8, 10)) + '日';
  }
  function setMsg(node, text, kind) {
    node.textContent = text || '';
    node.className = 'msg' + (kind ? ' ' + kind : '');
  }

  /** ZOOM か会場か。住所・URL が http(s):// で始まる、または場所に zoom を含むなら ZOOM */
  function kindOf(s) {
    return /^https?:\/\//i.test(s.address || '') || /zoom/i.test(s.place || '') ? 'zoom' : 'venue';
  }

  // ---- メニュー（カレンダー／イベント登録の切替）。詳細ページはカレンダーの一部として扱う ----
  function showTab(name) {
    ['calendar', 'register'].forEach(function (t) {
      $('tab-' + t).classList.toggle('active', t === (name === 'detail' ? 'calendar' : name));
    });
    ['calendar', 'detail', 'register'].forEach(function (t) {
      $('panel-' + t).classList.toggle('active', t === name);
    });
    setMenuOpen(false);
    window.scrollTo(0, 0);
  }
  function setMenuOpen(open) {
    $('menu').hidden = !open;
    $('menu-btn').setAttribute('aria-expanded', String(open));
  }
  $('menu-btn').addEventListener('click', function (ev) {
    ev.stopPropagation();
    setMenuOpen($('menu').hidden);
  });
  document.addEventListener('click', function (ev) {
    if (!$('menu').hidden && !$('menu').contains(ev.target)) setMenuOpen(false);
  });
  $('tab-calendar').addEventListener('click', function () {
    clearHash(false);
    showCalendar();
  });
  $('tab-register').addEventListener('click', function () {
    clearHash(false);
    state.view = 'register';
    startForm(null);
    showTab('register');
  });

  // ---- 画面の切替（URL のハッシュ：#s=<イベントID> なら詳細ページ、無ければカレンダー） ----
  function route() {
    var m = /^#s=(.+)$/.exec(location.hash);
    var id = m ? decodeURIComponent(m[1]) : null;
    var view = id ? 'detail:' + id : 'calendar';
    if (state.view === view) return; // hashchange と popstate の両方が来ても1回だけ
    if (id) showDetail(id); else showCalendar();
  }
  function onHistory() {
    state.inAppHistory = true;
    route();
  }
  window.addEventListener('hashchange', onHistory);
  window.addEventListener('popstate', onHistory);

  /** 詳細ページへ（ハッシュを履歴に積むので、ブラウザの「戻る」でカレンダーに戻れる） */
  function goDetail(id) {
    var hash = '#s=' + encodeURIComponent(id);
    if (location.hash === hash) { state.view = null; route(); } else location.hash = hash;
  }

  /** ハッシュを外す（replace なら今の履歴を置き換え、そうでなければ積む）。画面の切替は呼んだ側で行う */
  function clearHash(replace) {
    if (!location.hash) return;
    var url = location.pathname + location.search;
    if (replace) history.replaceState(null, '', url); else history.pushState(null, '', url);
  }

  function showCalendar() {
    var back = state.view !== 'calendar';
    state.view = 'calendar';
    showTab('calendar');
    if (state.loadedYm !== state.ym || state.monthDirty) loadMonth(state.ym);
    else if (back) window.scrollTo(0, state.calScroll);
  }

  // ---- カレンダー ----
  $('prev').addEventListener('click', function () { setMsg($('cal-msg'), ''); loadMonth(addMonth(state.ym, -1)); });
  $('next').addEventListener('click', function () { setMsg($('cal-msg'), ''); loadMonth(addMonth(state.ym, 1)); });

  /** カードやチップをタップ → 詳細ページ */
  function openEvent(id) {
    state.calScroll = window.pageYOffset;
    goDetail(id);
  }

  function loadMonth(ym) {
    state.ym = ym;
    state.loadedYm = ym;
    state.monthDirty = false;
    state.events = [];
    var no = ++state.requestNo;
    $('month-label').textContent = Number(ym.slice(0, 4)) + '年' + Number(ym.slice(5, 7)) + '月';
    renderGrid();
    $('list-title').textContent = '';
    $('list').innerHTML = '';
    $('list').appendChild(el('div', 'status', '読み込み中…'));
    call('getMonth', [ym], function (res) {
      if (no !== state.requestNo) return;
      if (!res || !res.ok) { showListError((res && res.reason) || '読み込めませんでした'); return; }
      state.events = res.events;
      state.today = res.today;
      setNeedsPassphrase(res.needsPassphrase);
      renderGrid();
      renderList();
    }, function (err) {
      if (no !== state.requestNo) return;
      showListError('読み込めませんでした：' + err);
    });
  }

  function showListError(text) {
    $('list').innerHTML = '';
    $('list').appendChild(el('div', 'msg error', text));
  }

  function renderGrid() {
    var ym = state.ym;
    var y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7));
    var first = new Date(y, m - 1, 1).getDay();
    var days = new Date(y, m, 0).getDate();
    var byDate = {};
    state.events.forEach(function (s) { (byDate[s.date] = byDate[s.date] || []).push(s); });

    var body = $('grid-body');
    body.innerHTML = '';
    var tr = null;
    for (var i = 0; i < Math.ceil((first + days) / 7) * 7; i++) {
      if (i % 7 === 0) { tr = el('tr'); body.appendChild(tr); }
      var d = i - first + 1;
      var td = el('td');
      if (d < 1 || d > days) { td.className = 'empty'; tr.appendChild(td); continue; }
      var date = ym + '-' + ('0' + d).slice(-2);
      if (date === state.today) td.className = 'today';
      td.appendChild(el('div', 'day' + (i % 7 === 0 ? ' sun' : i % 7 === 6 ? ' sat' : ''), String(d)));
      (byDate[date] || []).forEach(function (s) {
        var kind = kindOf(s);
        // スマホのチップ：開始時刻／イベント名／主催者
        var chip = el('button', 'chip ' + kind);
        chip.type = 'button';
        chip.appendChild(el('span', 'ct', s.time));
        chip.appendChild(el('span', 'cn', s.title));
        if (s.organizer) chip.appendChild(el('span', 'cm', s.organizer));
        chip.title = s.time + ' ' + s.title + (s.organizer ? ' ' + s.organizer : '');
        chip.addEventListener('click', function () { openEvent(s.id); });
        td.appendChild(chip);

        // 700px 以上の4行：時間／場所／主催者／イベント名
        var box = el('button', 'cell-detail ' + kind);
        box.type = 'button';
        [['t', s.time], ['', s.place], ['', s.organizer], ['n', s.title]].forEach(function (p) {
          box.appendChild(el('span', p[0], p[1] || ' '));
        });
        box.addEventListener('click', function () { openEvent(s.id); });
        td.appendChild(box);
      });
      tr.appendChild(td);
    }
  }

  function renderList() {
    var list = $('list');
    list.innerHTML = '';
    var m = Number(state.ym.slice(5, 7));
    $('list-title').textContent = m + '月のイベント（' + state.events.length + '件）';
    if (!state.events.length) {
      list.appendChild(el('div', 'status', 'この月のイベントはありません'));
      return;
    }
    state.events.forEach(function (s) {
      var card = el('button', 'card ' + kindOf(s));
      card.type = 'button';
      card.id = 'card-' + s.id;
      fillHead(card, s);
      card.addEventListener('click', function () { openEvent(s.id); });
      list.appendChild(card);
    });
  }

  /** カードと詳細ページの見出し：日付（曜日）・開始時刻／イベント名／主催者／場所／参加予定人数 */
  function fillHead(node, s) {
    var when = el('div', 'when');
    var wd = weekdayOf(s.date);
    when.appendChild(document.createTextNode(dateLabel(s.date) + '（'));
    when.appendChild(el('span', wd === 0 ? 'sun' : wd === 6 ? 'sat' : '', WEEK[wd]));
    when.appendChild(document.createTextNode('） ' + s.time));
    node.appendChild(when);
    node.appendChild(el('div', 'title', s.title));
    if (s.organizer) node.appendChild(el('div', 'organizer', s.organizer));
    if (s.place) node.appendChild(el('div', 'meta', '場所：' + s.place));
    node.appendChild(el('div', 'count', '参加予定 ' + s.count + '名'));
  }

  /** 申込のあと、詳細ページとカレンダーの一覧の人数をそろえる */
  function setCount(id, n) {
    state.events.forEach(function (x) { if (x.id === id) x.count = n; });
    [$('detail').querySelector('.detail-head .count'), $('card-' + id) && $('card-' + id).querySelector('.count')]
      .forEach(function (node) { if (node) node.textContent = '参加予定 ' + n + '名'; });
  }

  // ---- 詳細ページ（#s=<ID>）。見出しは手元の情報で先に出し、画像と参加者は開いたときに取りに行く ----
  function showDetail(id) {
    state.view = 'detail:' + id;
    var no = ++state.detailNo;
    showTab('detail');
    setMsg($('d-msg'), state.flash, state.flash ? 'ok' : '');
    state.flash = '';
    var box = $('detail');
    box.innerHTML = '';
    var known = state.events.filter(function (x) { return x.id === id; })[0];
    if (known) {
      renderDetailHead(box, known);
      if (known.address) box.appendChild(whereBox(known.address));
    }
    box.appendChild(el('div', 'no-flyer', '読み込み中…'));
    call('getDetail', [id], function (res) {
      if (no !== state.detailNo) return;
      box.innerHTML = '';
      if (!res || !res.ok) {
        var notFound = res && /見つかりません/.test(res.reason || '');
        box.appendChild(el('div', notFound ? 'status' : 'msg error', notFound ? 'このイベントは見つかりません' : (res && res.reason) || '読み込めませんでした'));
        return;
      }
      var s = {};
      for (var k in res.event) s[k] = res.event[k];
      s.count = (res.participants || []).length;
      // #s=… を直接開いたとき：戻るとこのイベントの月のカレンダー
      if (state.loadedYm === null) state.ym = s.date.slice(0, 7);
      renderDetailHead(box, s);
      renderDetail(box, s, res);
      setCount(s.id, s.count);
    }, function (err) {
      if (no !== state.detailNo) return;
      box.innerHTML = '';
      box.appendChild(el('div', 'msg error', '読み込めませんでした：' + err));
    });
  }

  function renderDetailHead(box, s) {
    var head = el('div', 'detail-head ' + kindOf(s));
    fillHead(head, s);
    var edit = el('button', 'edit-btn', '編集');
    edit.type = 'button';
    edit.addEventListener('click', function () { openEdit(s); });
    head.appendChild(edit);
    box.appendChild(head);
  }

  $('d-back').addEventListener('click', function () {
    // 画面の中から来たならブラウザの「戻る」と同じ。#s=… を直接開いたときは、そのイベントの月のカレンダーへ
    if (state.inAppHistory) { history.back(); return; }
    clearHash(true);
    showCalendar();
  });

  function renderDetail(body, s, detail) {
    if (s.address) body.appendChild(whereBox(s.address));
    // メモ①・②：住所・URL の下、画像の上。空のメモは見出しごと出さない。textContent で入れる（HTML は解釈しない・リンクにしない）
    [['メモ①', s.memo1], ['メモ②', s.memo2]].forEach(function (m) {
      if (!m[1]) return;
      var memo = el('div', 'memo');
      memo.appendChild(el('h3', '', m[0]));
      memo.appendChild(el('div', 'memo-body', m[1]));
      body.appendChild(memo);
    });
    if (detail.flyer) {
      var img = el('img', 'flyer');
      img.alt = 'チラシ・広告';
      img.src = detail.flyer;
      body.appendChild(img);
    } else {
      body.appendChild(el('div', 'no-flyer', 'チラシ準備中'));
    }

    var participants = el('div', 'participants');
    if (s.date < state.today) {
      body.appendChild(el('div', 'ended', '終了'));
    } else {
      body.appendChild(applyForm(s, participants));
    }
    renderParticipants(participants, detail);
    body.appendChild(participants);
  }

  /** 住所なら地図、URL（ZOOM など）なら参加ボタン */
  function whereBox(address) {
    var box = el('div', 'where');
    var a = el('a', 'link-btn');
    a.target = '_blank';
    a.rel = 'noopener';
    if (/^https?:\/\//i.test(address)) {
      box.appendChild(el('div', '', 'オンライン開催'));
      a.href = address;
      a.textContent = /zoom/i.test(address) ? 'ZOOM に参加する' : '参加用のページを開く';
    } else {
      box.appendChild(el('div', '', '住所：' + address));
      a.href = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(address);
      a.textContent = '地図を開く';
    }
    box.appendChild(a);
    return box;
  }

  // ---- 編集（詳細ページ右上の「編集」→ 登録フォームに今の内容を入れて開く。合言葉は「更新する」「削除」のときにサーバーで照合） ----
  function openEdit(s) {
    // 詳細の読み込み前（カレンダーの情報だけで出した見出し）の「編集」：メモ①・②を持っていないので、
    // 先に詳細を取ってから開く（空のまま開いて更新するとメモが消えるため）
    if (s.memo1 == null || s.memo2 == null) {
      call('getDetail', [s.id], function (res) {
        if (!res || !res.ok) { setMsg($('d-msg'), (res && res.reason) || '編集画面を開けませんでした', 'error'); return; }
        openEdit(res.event);
      }, function (err) {
        setMsg($('d-msg'), '編集画面を開けませんでした：' + err, 'error');
      });
      return;
    }
    call('getFormOptions', [], function (opt) {
      state.needsPassphrase = !!(opt && opt.needsPassphrase);
      state.view = 'register';
      startForm(s);
      showTab('register');
    }, function (err) {
      setMsg($('d-msg'), '編集画面を開けませんでした：' + err, 'error');
    });
  }

  /** 申込フォーム：参加者名（必須）だけ */
  function applyForm(s, participants) {
    var form = el('form', 'form');
    form.noValidate = true;

    var f = el('div', 'field');
    var l = el('label', '', '参加者名');
    l.htmlFor = 'f-' + s.id + '-name';
    l.appendChild(el('span', 'req', '必須'));
    var nameInput = el('input');
    nameInput.type = 'text';
    nameInput.id = 'f-' + s.id + '-name';
    f.appendChild(l);
    f.appendChild(nameInput);
    form.appendChild(f);

    var btn = el('button', 'btn', '申し込む');
    btn.type = 'submit';
    btn.style.marginTop = '8px';
    form.appendChild(btn);
    var msg = el('div', 'msg');
    form.appendChild(msg);

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var name = nameInput.value.trim();
      if (!name) { setMsg(msg, '参加者名を入れてください', 'error'); return; }
      btn.disabled = true;
      setMsg(msg, '送信中…');
      call('addParticipant', [s.id, name], function (res) {
        btn.disabled = false;
        if (res && res.participants) renderParticipants(participants, res);
        if (!res || !res.ok) { setMsg(msg, (res && res.reason) || '申し込めませんでした', 'error'); return; }
        nameInput.value = '';
        setMsg(msg, '申し込みました', 'ok');
        s.count = res.participants.length;
        setCount(s.id, s.count);
      }, function (err) {
        btn.disabled = false;
        setMsg(msg, '申し込めませんでした：' + err, 'error');
      });
    });
    return form;
  }

  /** 参加者一覧：No.・参加者名の1つの表（申込順） */
  function renderParticipants(box, res) {
    var participants = res.participants || [];
    box.innerHTML = '';
    box.appendChild(el('h3', '', '参加予定 ' + participants.length + '名'));
    if (!participants.length) { box.appendChild(el('div', 'none', 'まだ申込はありません')); return; }
    var table = el('table');
    var head = el('tr');
    head.appendChild(el('th', 'no', 'No.'));
    head.appendChild(el('th', '', '参加者名'));
    table.appendChild(head);
    participants.forEach(function (p, i) {
      var tr = el('tr');
      tr.appendChild(el('td', 'no', String(i + 1)));
      tr.appendChild(el('td', '', p.name));
      table.appendChild(tr);
    });
    box.appendChild(table);
  }

  // ---- イベント登録・編集フォーム ----
  function setNeedsPassphrase(v) {
    state.needsPassphrase = !!v;
    // 登録・編集・削除のどれも、ここに入れた合言葉をサーバーで照合する
    $('r-pass-field').hidden = !state.needsPassphrase;
  }

  // ---- ZOOM（Web）で開催 ----
  // チェックすると場所に「ZOOM」を入れ、住所欄を URL 用の案内にする。外すと場所の「ZOOM…」を消す。
  // 保存するのは場所と住所・URL だけ（列は増やさない）。色分けは kindOf（場所に zoom、または URL）
  function syncZoom() {
    var on = $('r-zoom').checked;
    $('r-address-label').textContent = on ? 'ZOOM の URL' : '住所／ZOOM の URL';
    $('r-address').placeholder = on ? 'https://zoom.us/j/…' : '住所 ／ https://zoom.us/j/…';
  }
  $('r-zoom').addEventListener('change', function () {
    var place = $('r-place');
    if (this.checked && !/zoom/i.test(place.value)) place.value = 'ZOOM';
    if (!this.checked && /zoom/i.test(place.value)) place.value = '';
    syncZoom();
  });

  function clearFlyer() {
    $('r-flyer').value = '';
    state.flyer = null;
    $('r-preview').hidden = true;
    setMsg($('r-flyer-msg'), '');
  }

  /** s が null なら新規登録、あれば編集 */
  function startForm(s) {
    state.edit = s ? { event: s } : null;
    $('register-form').reset();
    clearFlyer();
    setMsg($('r-msg'), '');
    $('r-title').textContent = s ? 'イベント編集' : 'イベント登録';
    $('r-submit').textContent = s ? '更新する' : '保存';
    $('r-cancel').hidden = !s;
    $('r-delete-area').hidden = !s;
    $('r-delete-confirm').hidden = true;
    $('r-delete').hidden = false;
    setMsg($('r-delete-msg'), '');
    $('r-flyer-current').hidden = !(s && s.hasFlyer);
    if (s) {
      $('r-date').value = s.date;
      $('r-time').value = s.time;
      $('r-place').value = s.place || '';
      $('r-address').value = s.address || '';
      $('r-organizer').value = s.organizer || '';
      $('r-title-input').value = s.title || '';
      $('r-memo1').value = s.memo1 || '';
      $('r-memo2').value = s.memo2 || '';
    }
    $('r-zoom').checked = !!s && kindOf(s) === 'zoom';
    syncZoom();
    setNeedsPassphrase(state.needsPassphrase);
    if (!s) {
      call('getFormOptions', [], function (opt) {
        if (state.edit || !opt || !opt.ok) return;
        setNeedsPassphrase(opt.needsPassphrase);
      }, function () {});
    }
  }

  // 編集をやめる → 今の URL の画面（編集を始めた詳細ページ）に戻る
  $('r-cancel').addEventListener('click', function () {
    startForm(null);
    state.view = null;
    route();
  });

  // ---- 削除（編集画面の赤いボタン → 確認 → 合言葉をサーバーで照合して行を消す） ----
  $('r-delete').addEventListener('click', function () {
    setMsg($('r-delete-msg'), '');
    if (state.needsPassphrase && !$('r-pass').value.trim()) {
      setMsg($('r-delete-msg'), '削除するには上の合言葉の欄に合言葉を入れてください', 'error');
      return;
    }
    $('r-delete').hidden = true;
    $('r-delete-confirm').hidden = false;
  });
  $('r-delete-no').addEventListener('click', function () {
    $('r-delete-confirm').hidden = true;
    $('r-delete').hidden = false;
  });
  $('r-delete-yes').addEventListener('click', function () {
    var editing = state.edit;
    if (!editing) return;
    var btn = this;
    btn.disabled = true;
    setMsg($('r-delete-msg'), '削除しています…');
    call('deleteEvent', [editing.event.id, $('r-pass').value.trim()], function (res) {
      btn.disabled = false;
      if (!res || !res.ok) {
        $('r-delete-confirm').hidden = true;
        $('r-delete').hidden = false;
        setMsg($('r-delete-msg'), (res && res.reason) || '削除できませんでした', 'error');
        return;
      }
      // 削除したイベントの詳細（#s=…）の履歴は置き換えて、その月のカレンダーへ
      startForm(null);
      setMsg($('cal-msg'), '削除しました', 'ok');
      clearHash(true);
      state.ym = res.yearMonth;
      state.monthDirty = true;
      showCalendar();
    }, function (err) {
      btn.disabled = false;
      setMsg($('r-delete-msg'), '削除できませんでした：' + err, 'error');
    });
  });

  $('r-flyer').addEventListener('change', function () {
    var file = this.files && this.files[0];
    state.flyer = null;
    $('r-preview').hidden = true;
    setMsg($('r-flyer-msg'), '');
    if (!file) return;
    setMsg($('r-flyer-msg'), '画像を縮小しています…');
    shrinkImage(file, function (err, flyer) {
      if (err) {
        $('r-flyer').value = '';
        setMsg($('r-flyer-msg'), err, 'error');
        return;
      }
      state.flyer = flyer;
      $('r-preview').src = 'data:' + flyer.mimeType + ';base64,' + flyer.base64;
      $('r-preview').hidden = false;
      setMsg($('r-flyer-msg'), '縮小後 ' + flyer.width + '×' + flyer.height + 'px・約' + Math.round(flyer.bytes / 1024) + 'KB');
    });
  });

  /** 長辺 1600px に縮小し JPEG にする。1.5MB を超えるときは品質を下げる */
  function shrinkImage(file, done) {
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      URL.revokeObjectURL(url);
      var scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
      var w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale);
      var canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      var qualities = [0.85, 0.75, 0.65, 0.55, 0.45];
      for (var i = 0; i < qualities.length; i++) {
        var base64 = canvas.toDataURL('image/jpeg', qualities[i]).split(',')[1];
        var bytes = Math.floor(base64.length * 3 / 4) - (base64.slice(-2) === '==' ? 2 : base64.slice(-1) === '=' ? 1 : 0);
        if (bytes <= MAX_BYTES || i === qualities.length - 1) {
          if (bytes > MAX_BYTES) { done('画像が大きすぎて縮小できませんでした'); return; }
          done(null, { base64: base64, mimeType: 'image/jpeg', width: w, height: h, bytes: bytes });
          return;
        }
      }
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      done('この画像は読み込めません。JPEG か PNG の画像を選んでください');
    };
    img.src = url;
  }

  $('register-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var msg = $('r-msg');
    var payload = {
      date: $('r-date').value,
      time: $('r-time').value,
      place: $('r-place').value.trim(),
      address: $('r-address').value.trim(),
      organizer: $('r-organizer').value.trim(),
      title: $('r-title-input').value.trim(),
      memo1: $('r-memo1').value.trim(), // 中の改行は残す（前後の空白だけ取る）
      memo2: $('r-memo2').value.trim(),
      flyer: state.flyer ? { base64: state.flyer.base64, mimeType: state.flyer.mimeType } : null
    };
    var editing = state.edit;
    var pass = $('r-pass').value.trim();
    if (!payload.date) { setMsg(msg, '日付を入れてください', 'error'); return; }
    if (!payload.time) { setMsg(msg, '開始時刻を入れてください', 'error'); return; }
    if (!payload.title) { setMsg(msg, 'イベント名を入れてください', 'error'); return; }
    if (state.needsPassphrase && !pass) { setMsg(msg, '合言葉を入れてください', 'error'); return; }
    if ($('r-flyer').files.length && !state.flyer) { setMsg(msg, '画像の縮小が終わるまでお待ちください', 'error'); return; }

    $('r-submit').disabled = true;
    setMsg(msg, '保存中…');
    var fn = editing ? 'updateEvent' : 'addEvent';
    var args = editing ? [editing.event.id, payload, pass] : [payload, pass];
    call(fn, args, function (res) {
      $('r-submit').disabled = false;
      if (!res || !res.ok) {
        setMsg(msg, (res && res.reason) || '保存できませんでした', 'error');
        if (res && res.reason === '合言葉が違います') setNeedsPassphrase(true);
        return;
      }
      // 登録・更新したイベントの詳細ページへ。カレンダーは戻ったときに読み直す
      startForm(null);
      state.monthDirty = true;
      state.flash = editing ? '更新しました' : '登録しました';
      goDetail(res.id);
    }, function (err) {
      $('r-submit').disabled = false;
      setMsg(msg, '保存できませんでした：' + err, 'error');
    });
  });

  route();
})();

/* 화면 렌더링. 데이터는 이 브라우저의 localStorage에만 저장됩니다. */
(function () {
  'use strict';

  var KEY_TX = 'gb.txs.v1', KEY_OPT = 'gb.opts.v1', KEY_LOG = 'gb.log.v1', KEY_MONTH = 'gb.month';
  var COLORS = ['#1e6b52', '#c2703d', '#3f5fa8', '#b4a03a', '#8a4f9e', '#4f8fa0', '#a8475a', '#6b7a3a'];
  var KIND_LABEL = { living: '생활비', finance: '금융', income: '수입', invest: '저축·투자', excluded: '집계 제외' };

  var view = document.getElementById('view');
  var monthSel = document.getElementById('month');
  var monthWrap = document.getElementById('monthWrap');

  // ---------- 저장소 ----------
  function load(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
  function del(k) { try { localStorage.removeItem(k); } catch (e) { /* noop */ } }

  var state = {
    txs: load(KEY_TX, []),
    opts: Object.assign({}, Calc.DEFAULT_OPTS, load(KEY_OPT, {})),
    log: load(KEY_LOG, []),
    month: load(KEY_MONTH, null),
    filter: { kind: 'all', cat: 'all', q: '' },
    flash: null
  };

  // ---------- 유틸 ----------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function won(n) { return Math.round(n).toLocaleString('ko-KR') + '원'; }
  function man(n) {
    n = Math.round(n);
    var sign = n < 0 ? '-' : '', a = Math.abs(n);
    if (a >= 100000000) return sign + (a / 100000000).toFixed(1).replace(/\.0$/, '') + '억';
    if (a >= 10000) return sign + Math.round(a / 10000).toLocaleString('ko-KR') + '만';
    return sign + a.toLocaleString('ko-KR');
  }
  function pct(x) { return (x > 0 ? '+' : '') + (x * 100).toFixed(1) + '%'; }
  function cmp(cur, base) {
    if (base == null || !base) return '<span>비교 불가</span>';
    var r = (cur - base) / base;
    return '<span class="' + (r > 0 ? 'up' : 'down') + '">' + pct(r) + '</span>';
  }
  function ymLabel(ym) { return ym.slice(0, 4) + '년 ' + (+ym.slice(5, 7)) + '월'; }
  function shortYm(ym) { return (+ym.slice(5, 7)) + '월'; }

  // ---------- 라우팅 ----------
  function route() {
    var tab = (location.hash || '#dashboard').slice(1);
    if (!state.txs.length && tab !== 'settings') tab = 'upload';
    document.querySelectorAll('.tabs a').forEach(function (a) {
      var on = a.getAttribute('data-tab') === tab;
      a.classList.toggle('on', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    var months = Calc.months(state.txs);
    if (!state.month || months.indexOf(state.month) < 0) state.month = months[0] || null;
    monthWrap.hidden = !(state.txs.length && (tab === 'dashboard' || tab === 'transactions'));
    monthSel.innerHTML = months.map(function (m) {
      return '<option value="' + m + '"' + (m === state.month ? ' selected' : '') + '>' + ymLabel(m) + '</option>';
    }).join('');
    if (tab === 'transactions') renderTx();
    else if (tab === 'upload') renderUpload();
    else if (tab === 'settings') renderSettings();
    else renderDash();
  }
  window.addEventListener('hashchange', route);
  monthSel.addEventListener('change', function () { state.month = monthSel.value; save(KEY_MONTH, state.month); route(); });

  // ---------- 대시보드 ----------
  function renderDash() {
    var o = state.opts, s = Calc.summarize(state.txs, state.month, o);
    var html = '';

    html += '<section class="card toggles" aria-label="집계 옵션"><div class="opts">' +
      '<label class="check"><input type="checkbox" id="optFin"' + (o.splitFinance ? ' checked' : '') + '> 금융 지출(대출 상환·이자) 분리</label>' +
      '<label class="check"><input type="checkbox" id="optOne"' + (o.excludeOneOff ? ' checked' : '') + '> 일회성 지출 제외</label>' +
      '</div><span class="hint">일회성 = 여행/숙박 또는 한 번에 ' + man(o.oneOffMin) + '원 이상</span></section>';

    if (s.firstPartial) html += '<div class="msg">' + ymLabel(s.ym) + '은 데이터가 ' + s.firstDate.slice(5).replace('-', '/') + '부터라 한 달 전체가 아닙니다.</div>';

    var fcSub = s.partial ? won(s.living) + ' ÷ ' + s.elapsed + '일 × ' + s.dim + '일' : '마감된 달이라 실제 금액';
    html += '<section class="kpis" aria-label="요약">' +
      kpi('main', o.splitFinance ? '생활비 지출' : '전체 지출', won(s.living),
        '전월 ' + cmp(s.living, s.prevLiving) + ' · 3개월 평균 ' + cmp(s.living, s.avg3)) +
      kpi('', s.partial ? '월말 예상 생활비' : '월 생활비 (확정)', won(s.forecast), fcSub) +
      (o.splitFinance ? kpi('', '금융 지출', won(s.finance), '대출 상환·이자·수수료') : '') +
      kpi('', '수입', won(s.income), '타입이 수입인 거래') +
      kpi('', '저축·투자 이체', (s.invest > 0 ? '+' : '') + won(s.invest), '+는 저축·투자에서 돌아온 돈, -는 넣은 돈') +
      '</section>';

    // 추이 + 예산
    html += '<div class="row"><section class="card wide chart"><div class="head"><h2>월별 ' + (o.splitFinance ? '생활비' : '지출') + ' 추이</h2><span class="hint">최근 6개월' + (o.totalBudget ? ' · 점선 = 월 예산 ' + man(o.totalBudget) + '원' : '') + '</span></div>' + barChart(s.series, o.totalBudget, s.ym) + '</section>';
    html += '<section class="card side"><div class="head"><h2>예산 대비</h2><a href="#settings" class="hint">예산 설정</a></div>';
    if (o.totalBudget) html += budgetRow('월 생활비 전체', s.living, o.totalBudget);
    if (s.budgets.length) s.budgets.forEach(function (b) { html += budgetRow(b.cat, b.used, b.budget); });
    if (!o.totalBudget && !s.budgets.length) html += '<p class="empty">아직 예산이 없습니다. 설정에서 월 예산이나 카테고리 예산을 넣으면 여기서 진행률을 봅니다.</p>';
    html += '</section></div>';

    // 카테고리 + 증감
    html += '<div class="row"><section class="card half"><div class="head"><h2>카테고리별</h2><span class="hint">' + ymLabel(s.ym) + '</span></div>' + donut(s.byCat) + '</section>';
    html += '<section class="card half"><div class="head"><h2>전월보다 많이 쓴 항목</h2><span class="hint">' + shortYm(Calc.addMonths(s.ym, -1)) + ' 대비</span></div>';
    if (s.deltas.length) {
      html += '<div class="scroll"><table><thead><tr><th>카테고리</th><th class="num">이번 달</th><th class="num">전월</th><th class="num">증감</th></tr></thead><tbody>' +
        s.deltas.map(function (d) {
          return '<tr><td>' + esc(d.cat) + '</td><td class="num">' + won(d.cur) + '</td><td class="num">' + won(d.prev) + '</td><td class="num up">+' + man(d.diff) + (d.pct != null ? ' (' + pct(d.pct) + ')' : ' (신규)') + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    } else html += '<p class="empty">전월보다 늘어난 카테고리가 없습니다.</p>';
    html += '</section></div>';

    // 고정비 + 이상 지출
    html += '<div class="row"><section class="card half"><div class="head"><h2>고정비</h2><span class="hint">최근 3개월 매달 같은 곳, 금액 차이 20% 이내</span></div>';
    if (s.fixed.length) {
      html += s.fixed.map(function (f) {
        return '<div class="list-item"><span>' + esc(f.content) + ' <span class="chip">' + esc(f.cat) + '</span></span><span class="r">매월 ' + f.day + '일경 · ' + won(f.amount) + '</span></div>';
      }).join('');
      var tot = s.fixed.reduce(function (a, f) { return a + f.amount; }, 0);
      html += '<div class="list-item"><b>합계</b><b>' + won(tot) + '</b></div>';
    } else html += '<p class="empty">찾은 고정비가 없습니다.</p>';
    html += '</section><section class="card half"><div class="head"><h2>눈에 띄는 지출</h2><span class="hint">3개월 평균의 1.5배 이상 · 큰 결제</span></div>';
    if (s.alerts.length) {
      html += s.alerts.slice(0, 6).map(function (a) {
        return a.kind === 'cat'
          ? '<div class="alert"><span>' + esc(a.cat) + ' 이번 달 ' + won(a.amount) + '</span><b>평균의 ' + a.ratio.toFixed(1) + '배</b></div>'
          : '<div class="alert"><span>' + a.date.slice(5).replace('-', '/') + ' ' + esc(a.content) + ' <span class="chip">' + esc(a.cat) + '</span></span><b>' + won(a.amount) + '</b></div>';
      }).join('');
    } else html += '<p class="empty">' + (s.avg3 == null ? '비교할 이전 3개월 데이터가 부족합니다.' : '특별히 튄 지출이 없습니다.') + '</p>';
    html += '</section></div>';

    view.innerHTML = html;
    document.getElementById('optFin').onchange = function (e) { setOpt('splitFinance', e.target.checked); };
    document.getElementById('optOne').onchange = function (e) { setOpt('excludeOneOff', e.target.checked); };
  }

  function kpi(cls, label, value, sub) {
    return '<div class="card kpi ' + cls + '"><span class="label">' + label + '</span><span class="value">' + value + '</span><span class="sub">' + sub + '</span></div>';
  }
  function budgetRow(name, used, budget) {
    var r = budget ? used / budget : 0;
    return '<div class="budget"><div class="line"><span>' + esc(name) + '</span><span>' + man(used) + ' / ' + man(budget) + ' (' + Math.round(r * 100) + '%)</span></div>' +
      '<div class="bar" role="img" aria-label="' + esc(name) + ' 예산 ' + Math.round(r * 100) + '% 사용"><span class="' + (r > 1 ? 'over' : '') + '" style="width:' + Math.min(100, r * 100) + '%"></span></div></div>';
  }
  function setOpt(k, v) { state.opts[k] = v; save(KEY_OPT, state.opts); route(); }

  function barChart(series, budget, cur) {
    var W = 640, H = 240, pl = 8, pr = 8, pt = 24, pb = 30;
    var max = Math.max.apply(null, series.map(function (d) { return d.value; }).concat([budget || 0, 1]));
    var bw = (W - pl - pr) / series.length;
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="최근 6개월 지출 막대 차트">';
    series.forEach(function (d, i) {
      var h = (H - pt - pb) * d.value / max, x = pl + i * bw + bw * 0.22, w = bw * 0.56, y = H - pb - h;
      var on = d.ym === cur;
      svg += '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + Math.max(h, 0) + '" rx="6" fill="' + (on ? '#1e6b52' : '#cfd9d3') + '"><title>' + ymLabel(d.ym) + ' ' + won(d.value) + '</title></rect>';
      svg += '<text x="' + (x + w / 2) + '" y="' + (y - 6) + '" text-anchor="middle" font-size="12" font-weight="' + (on ? 700 : 500) + '" fill="#1c1c1a">' + man(d.value) + '</text>';
      svg += '<text x="' + (x + w / 2) + '" y="' + (H - 8) + '" text-anchor="middle" font-size="12" fill="#5f5e5a">' + shortYm(d.ym) + '</text>';
    });
    if (budget) {
      var by = H - pb - (H - pt - pb) * budget / max;
      svg += '<line x1="' + pl + '" x2="' + (W - pr) + '" y1="' + by + '" y2="' + by + '" stroke="#a64b14" stroke-width="1.5" stroke-dasharray="5 5"/>';
    }
    svg += '<line x1="' + pl + '" x2="' + (W - pr) + '" y1="' + (H - pb) + '" y2="' + (H - pb) + '" stroke="#cfcdc7"/></svg>';
    return svg;
  }

  function donut(byCat) {
    if (!byCat.length) return '<p class="empty">이 달 지출이 없습니다.</p>';
    var top = byCat.slice(0, 7), rest = byCat.slice(7);
    if (rest.length) top.push({ cat: '기타 ' + rest.length + '개', amount: rest.reduce(function (a, c) { return a + c.amount; }, 0), share: rest.reduce(function (a, c) { return a + c.share; }, 0) });
    var R = 60, C = 2 * Math.PI * R, off = 0;
    var svg = '<svg viewBox="0 0 170 170" role="img" aria-label="카테고리별 지출 비중"><g transform="rotate(-90 85 85)">';
    top.forEach(function (c, i) {
      var len = c.share * C;
      svg += '<circle cx="85" cy="85" r="' + R + '" fill="none" stroke="' + (COLORS[i] || '#bdbbb5') + '" stroke-width="26" stroke-dasharray="' + len + ' ' + (C - len) + '" stroke-dashoffset="' + (-off) + '"/>';
      off += len;
    });
    var total = byCat.reduce(function (a, c) { return a + c.amount; }, 0);
    svg += '</g><text x="85" y="82" text-anchor="middle" font-size="11" fill="#5f5e5a">합계</text><text x="85" y="100" text-anchor="middle" font-size="15" font-weight="800" fill="#1c1c1a">' + man(total) + '</text></svg>';
    var list = '<ul class="legend">' + top.map(function (c, i) {
      return '<li><span class="dot" style="background:' + (COLORS[i] || '#bdbbb5') + '"></span><span class="name">' + esc(c.cat) + '</span><span class="amt">' + won(c.amount) + '</span><span class="pct">' + (c.share * 100).toFixed(1) + '%</span></li>';
    }).join('') + '</ul>';
    return '<div class="donut-wrap">' + svg + list + '</div>';
  }

  // ---------- 거래 내역 ----------
  function renderTx() {
    var f = state.filter, o = state.opts;
    var rows = state.txs.filter(function (t) { return t.date.slice(0, 7) === state.month; });
    var cats = {};
    rows.forEach(function (t) { cats[t.cat] = 1; });
    var shown = rows.filter(function (t) {
      if (f.kind !== 'all' && Calc.kind(t, o) !== f.kind) return false;
      if (f.cat !== 'all' && t.cat !== f.cat) return false;
      if (f.q) { var q = f.q.toLowerCase(); if ((t.content + ' ' + t.memo + ' ' + t.pay).toLowerCase().indexOf(q) < 0) return false; }
      return true;
    });
    var sumShown = shown.reduce(function (a, t) { return a + t.amount; }, 0);

    var html = '<section class="card"><form class="filters" onsubmit="return false" aria-label="거래 필터">' +
      '<div class="field"><label for="fKind">구분</label><select id="fKind">' +
      ['all', 'living', 'finance', 'income', 'invest', 'excluded'].map(function (k) {
        return '<option value="' + k + '"' + (f.kind === k ? ' selected' : '') + '>' + (k === 'all' ? '전체' : KIND_LABEL[k]) + '</option>';
      }).join('') + '</select></div>' +
      '<div class="field"><label for="fCat">대분류</label><select id="fCat"><option value="all">전체</option>' +
      Object.keys(cats).sort().map(function (c) { return '<option' + (f.cat === c ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('') + '</select></div>' +
      '<div class="field grow"><label for="fQ">검색</label><input id="fQ" type="search" placeholder="가맹점, 메모, 결제수단" value="' + esc(f.q) + '"></div>' +
      '</form></section>';

    html += '<section class="card"><div class="head"><h2>' + ymLabel(state.month) + ' 거래 ' + shown.length.toLocaleString() + '건</h2><span class="hint">합계 ' + won(sumShown) + '</span></div>';
    html += '<div class="scroll"><table><thead><tr><th>날짜</th><th>내용</th><th>분류</th><th>구분</th><th>결제수단</th><th class="num">금액</th></tr></thead><tbody>';
    html += shown.slice(0, 500).map(function (t) {
      var k = Calc.kind(t, o), one = k === 'living' && Calc.isOneOff(t, o);
      return '<tr><td class="muted">' + t.date.slice(5).replace('-', '/') + ' ' + t.time.slice(0, 5) + '</td><td>' + esc(t.content) + (t.memo ? '<br><span class="hint">' + esc(t.memo) + '</span>' : '') + '</td>' +
        '<td>' + esc(t.cat) + ' <span class="hint">· ' + esc(t.sub) + '</span></td>' +
        '<td><span class="chip ' + k + '">' + KIND_LABEL[k] + '</span>' + (one ? ' <span class="chip">일회성</span>' : '') + '</td>' +
        '<td class="muted">' + esc(t.pay) + '</td><td class="num">' + won(t.amount) + '</td></tr>';
    }).join('');
    html += '</tbody></table></div>' + (shown.length > 500 ? '<p class="empty">500건까지만 표시합니다. 필터를 좁혀 주세요.</p>' : '') + '</section>';
    view.innerHTML = html;

    document.getElementById('fKind').onchange = function (e) { f.kind = e.target.value; renderTx(); };
    document.getElementById('fCat').onchange = function (e) { f.cat = e.target.value; renderTx(); };
    var q = document.getElementById('fQ');
    q.oninput = function (e) { f.q = e.target.value; clearTimeout(q._t); q._t = setTimeout(function () { renderTx(); var n = document.getElementById('fQ'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }, 250); };
  }

  // ---------- 엑셀 올리기 ----------
  function renderUpload() {
    var html = '';
    if (state.flash) { html += '<div class="msg' + (state.flash.err ? ' err' : '') + '" role="status">' + esc(state.flash.text) + '</div>'; state.flash = null; }
    html += '<section class="card"><h2>뱅크샐러드 엑셀 올리기</h2>' +
      '<label class="drop" id="drop" for="file"><strong>파일을 여기로 끌어다 놓기</strong><span>또는 눌러서 선택 · .xlsx</span>' +
      '<input id="file" class="sr" type="file" accept=".xlsx,.xls,.csv"></label>' +
      '<p class="note">\'가계부 내역\' 시트만 읽고 \'뱅샐현황\' 시트(개인정보·신용점수)는 읽지 않습니다. 같은 거래(날짜·시간·내용·금액·결제수단 동일)는 한 번만 넣으니, 기간이 겹치는 파일을 올려도 됩니다.</p></section>';

    if (state.txs.length) {
      var c = Calc.typeCounts(state.txs, state.opts);
      var dates = state.txs.map(function (t) { return t.date; }).sort();
      html += '<section class="card"><div class="head"><h2>저장된 데이터</h2><span class="hint">' + dates[0] + ' ~ ' + dates[dates.length - 1] + ' · ' + state.txs.length.toLocaleString() + '건</span></div><div class="stats">' +
        stat(c.living, '생활비 지출') + stat(c.finance, '금융 지출') + stat(c.income, '수입') + stat(c.invest, '저축·투자 이체') + stat(c.excluded, '집계 제외 (내 계좌·카드대금 등)') +
        '</div></section>';
    }
    if (state.log.length) {
      html += '<section class="card"><h2>올린 기록</h2>' + state.log.slice(0, 10).map(function (l) {
        return '<div class="list-item"><span>' + esc(l.name) + ' <span class="hint">' + esc(l.at) + '</span></span><span class="r">새로 ' + l.added + '건 · 중복 ' + l.dup + '건 제외</span></div>';
      }).join('') + '</section>';
    }
    view.innerHTML = html;

    var drop = document.getElementById('drop'), input = document.getElementById('file');
    input.onchange = function () { if (input.files[0]) readFile(input.files[0]); };
    ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('hover'); }); });
    ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('hover'); }); });
    drop.addEventListener('drop', function (e) { var f = e.dataTransfer.files[0]; if (f) readFile(f); });
  }
  function stat(n, t) { return '<div class="stat"><div class="n">' + n.toLocaleString() + '건</div><div class="t">' + t + '</div></div>'; }

  function readFile(file) {
    if (typeof XLSX === 'undefined') { state.flash = { err: true, text: '엑셀 읽기 도구를 불러오지 못했습니다. 인터넷 연결을 확인하고 새로고침해 주세요.' }; return route(); }
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var wb = XLSX.read(new Uint8Array(reader.result), { type: 'array' });
        var name = wb.SheetNames.indexOf('가계부 내역') >= 0 ? '가계부 내역' : null;
        if (!name) wb.SheetNames.forEach(function (n) {
          if (name) return;
          var hdr = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, range: 0 })[0] || [];
          if (hdr.indexOf('금액') >= 0 && hdr.indexOf('날짜') >= 0) name = n;
        });
        if (!name) throw new Error('\'가계부 내역\' 시트(날짜·금액 열)를 찾지 못했습니다.');
        var rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { raw: true });
        var txs = Calc.normalizeRows(rows);
        if (!txs.length) throw new Error('읽을 수 있는 거래가 없습니다.');
        var r = Calc.merge(state.txs, txs);
        state.txs = r.txs;
        if (!save(KEY_TX, state.txs)) throw new Error('브라우저 저장 공간이 부족해 저장하지 못했습니다.');
        state.log.unshift({ name: file.name, at: new Date().toLocaleString('ko-KR'), added: r.added, dup: r.dup });
        save(KEY_LOG, state.log.slice(0, 30));
        state.month = Calc.months(state.txs)[0];
        state.flash = { text: '새 거래 ' + r.added.toLocaleString() + '건을 넣었습니다' + (r.dup ? ' (중복 ' + r.dup.toLocaleString() + '건 제외)' : '') + '. 대시보드에서 확인하세요.' };
      } catch (e) {
        state.flash = { err: true, text: e.message || '파일을 읽지 못했습니다.' };
      }
      route();
    };
    reader.readAsArrayBuffer(file);
  }

  // ---------- 설정 ----------
  function renderSettings() {
    var o = state.opts, cats = {};
    state.txs.forEach(function (t) { if (Calc.kind(t, o) === 'living') cats[t.cat] = 1; });
    var html = '<section class="card"><h2>기준</h2><div class="grid2">' +
      field('oneOffMin', '일회성으로 볼 결제 금액 (원 이상)', o.oneOffMin) +
      field('totalBudget', '월 생활비 예산 (원, 0이면 안 씀)', o.totalBudget) +
      '</div></section>';
    html += '<section class="card"><h2>카테고리 예산 <span class="hint">비워 두면 표시하지 않음</span></h2><div class="grid2">' +
      Object.keys(cats).sort().map(function (c) {
        return '<div class="field"><label for="b_' + esc(c) + '">' + esc(c) + '</label><input type="number" min="0" step="10000" data-cat="' + esc(c) + '" id="b_' + esc(c) + '" value="' + (o.budgets[c] || '') + '"></div>';
      }).join('') + (Object.keys(cats).length ? '' : '<p class="empty">엑셀을 먼저 올리면 카테고리가 나타납니다.</p>') + '</div></section>';
    html += '<section class="card"><h2>데이터</h2><p class="note">데이터는 이 브라우저에만 있습니다. 다른 컴퓨터나 휴대폰에서는 엑셀을 다시 올려야 합니다.</p>' +
      '<button type="button" class="btn danger" id="wipe">저장된 거래 모두 삭제</button></section>';
    view.innerHTML = html;

    ['oneOffMin', 'totalBudget'].forEach(function (k) {
      document.getElementById(k).onchange = function (e) { state.opts[k] = Math.max(0, +e.target.value || 0); save(KEY_OPT, state.opts); };
    });
    view.querySelectorAll('input[data-cat]').forEach(function (inp) {
      inp.onchange = function () {
        var c = inp.getAttribute('data-cat'), v = +inp.value || 0;
        if (v > 0) state.opts.budgets[c] = v; else delete state.opts.budgets[c];
        save(KEY_OPT, state.opts);
      };
    });
    document.getElementById('wipe').onclick = function () {
      if (!window.confirm('저장된 거래와 올린 기록을 모두 지웁니다. 계속할까요?')) return;
      del(KEY_TX); del(KEY_LOG); del(KEY_MONTH);
      state.txs = []; state.log = []; state.month = null;
      location.hash = '#upload'; route();
    };
  }
  function field(k, label, v) {
    return '<div class="field"><label for="' + k + '">' + label + '</label><input type="number" min="0" step="10000" id="' + k + '" value="' + (v || 0) + '"></div>';
  }

  route();
})();

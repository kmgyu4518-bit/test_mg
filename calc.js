/* 가계부 계산 로직. 브라우저와 Node(검증용) 양쪽에서 동작합니다. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Calc = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var EXCLUDED_TRANSFER = ['내계좌이체', '카드대금'];
  var INVEST = ['저축', '투자'];
  var ONE_OFF_CATS = ['여행/숙박'];

  var DEFAULT_OPTS = {
    splitFinance: true,     // 금융(대출 상환·이자) 지출을 생활비와 분리
    excludeOneOff: false,   // 일회성 지출 제외
    oneOffMin: 300000,      // 한 번에 이 금액 이상이면 일회성
    totalBudget: 0,         // 월 생활비 예산 (0이면 미설정)
    budgets: {}             // 대분류별 예산
  };

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  // 엑셀 날짜: 일련번호(1900 체계) / Date / 문자열 모두 처리
  function toDateStr(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') {
      var ms = Math.round((v - 25569) * 86400000);
      var d = new Date(ms);
      return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
    }
    if (v instanceof Date) return v.getFullYear() + '-' + pad(v.getMonth() + 1) + '-' + pad(v.getDate());
    var m = String(v).match(/(\d{4})[-./](\d{1,2})[-./](\d{1,2})/);
    return m ? m[1] + '-' + pad(+m[2]) + '-' + pad(+m[3]) : null;
  }

  function toTimeStr(v) {
    if (v == null || v === '') return '00:00:00';
    if (typeof v === 'number') {
      var s = Math.round((v % 1) * 86400);
      return pad(Math.floor(s / 3600) % 24) + ':' + pad(Math.floor(s / 60) % 60) + ':' + pad(s % 60);
    }
    if (v instanceof Date) return pad(v.getHours()) + ':' + pad(v.getMinutes()) + ':' + pad(v.getSeconds());
    var m = String(v).match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    return m ? pad(+m[1]) + ':' + m[2] + ':' + (m[3] || '00') : '00:00:00';
  }

  function toNum(v) {
    if (typeof v === 'number') return v;
    var n = Number(String(v == null ? '' : v).replace(/[,\s원₩]/g, ''));
    return isFinite(n) ? n : 0;
  }

  // 시트 행(헤더를 키로 하는 객체) -> 거래
  function normalizeRows(rows) {
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var date = toDateStr(r['날짜']);
      if (!date || r['금액'] == null || r['금액'] === '') continue;
      out.push({
        date: date,
        time: toTimeStr(r['시간']),
        type: String(r['타입'] || '').trim(),
        cat: String(r['대분류'] || '미분류').trim(),
        sub: String(r['소분류'] || '미분류').trim(),
        content: String(r['내용'] || '').trim(),
        amount: toNum(r['금액']),
        currency: String(r['화폐'] || 'KRW').trim(),
        pay: String(r['결제수단'] || '').trim(),
        memo: r['메모'] == null ? '' : String(r['메모']).trim()
      });
    }
    return out;
  }

  function keyOf(t) { return [t.date, t.time, t.content, t.amount, t.pay].join('|'); }

  // 기존 + 새 거래 합치기 (같은 거래는 한 번만)
  function merge(existing, incoming) {
    var seen = {}, out = [], dup = 0, i;
    for (i = 0; i < existing.length; i++) { seen[keyOf(existing[i])] = 1; out.push(existing[i]); }
    for (i = 0; i < incoming.length; i++) {
      var k = keyOf(incoming[i]);
      if (seen[k]) { dup++; continue; }
      seen[k] = 1; out.push(incoming[i]);
    }
    out.sort(function (a, b) { return (b.date + b.time).localeCompare(a.date + a.time); });
    return { txs: out, added: incoming.length - dup, dup: dup };
  }

  // 거래 성격 구분
  function kind(t, opts) {
    if (t.type === '지출') return (opts.splitFinance && t.cat === '금융') ? 'finance' : 'living';
    if (t.type === '수입') return 'income';
    if (t.type === '이체') {
      if (INVEST.indexOf(t.cat) >= 0) return 'invest';
      return 'excluded'; // 내 계좌 이체, 카드대금, 일반 이체
    }
    return 'excluded';
  }

  function isOneOff(t, opts) {
    return ONE_OFF_CATS.indexOf(t.cat) >= 0 || -t.amount >= opts.oneOffMin;
  }

  // 생활비로 집계되는 거래인지 (일회성 제외 옵션 반영)
  function countsAsLiving(t, opts) {
    if (kind(t, opts) !== 'living') return false;
    if (opts.excludeOneOff && isOneOff(t, opts)) return false;
    return true;
  }

  function monthOf(date) { return date.slice(0, 7); }
  function addMonths(ym, n) {
    var y = +ym.slice(0, 4), m = +ym.slice(5, 7) - 1 + n;
    y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
    return y + '-' + pad(m + 1);
  }
  function daysIn(ym) { return new Date(+ym.slice(0, 4), +ym.slice(5, 7), 0).getDate(); }

  function months(txs) {
    var s = {};
    txs.forEach(function (t) { s[monthOf(t.date)] = 1; });
    return Object.keys(s).sort().reverse();
  }

  function sum(arr) { return arr.reduce(function (a, b) { return a + b; }, 0); }

  function livingByCat(txs, ym, opts) {
    var m = {};
    txs.forEach(function (t) {
      if (monthOf(t.date) === ym && countsAsLiving(t, opts)) m[t.cat] = (m[t.cat] || 0) - t.amount;
    });
    return m;
  }

  function median(a) {
    var s = a.slice().sort(function (x, y) { return x - y; }), h = Math.floor(s.length / 2);
    return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
  }

  // 고정비: 최근 3개월(선택 월 포함) 매달 같은 내용으로 나간 지출, 금액 편차 20% 이내
  function fixedCosts(txs, ym, opts) {
    var ms = [addMonths(ym, -2), addMonths(ym, -1), ym];
    var g = {};
    txs.forEach(function (t) {
      var k = kind(t, opts);
      if (t.type !== '지출' || (k !== 'living' && k !== 'finance')) return;
      var mm = monthOf(t.date);
      if (ms.indexOf(mm) < 0 || !t.content) return;
      var e = g[t.content] || (g[t.content] = { content: t.content, cat: t.cat, byMonth: {}, days: [] });
      e.byMonth[mm] = (e.byMonth[mm] || 0) - t.amount;
      e.days.push(+t.date.slice(8, 10));
    });
    var out = [];
    Object.keys(g).forEach(function (c) {
      var e = g[c];
      if (!ms.every(function (mm) { return e.byMonth[mm] > 0; })) return;
      var vals = ms.map(function (mm) { return e.byMonth[mm]; });
      var md = median(vals);
      if (!vals.every(function (v) { return Math.abs(v - md) <= md * 0.2; })) return;
      out.push({ content: c, cat: e.cat, amount: Math.round(sum(vals) / 3), day: Math.round(median(e.days)) });
    });
    return out.sort(function (a, b) { return b.amount - a.amount; });
  }

  // 대시보드 한 달 요약
  function summarize(txs, ym, opts) {
    opts = Object.assign({}, DEFAULT_OPTS, opts || {});
    var inMonth = txs.filter(function (t) { return monthOf(t.date) === ym; });
    var living = 0, finance = 0, income = 0, invest = 0;
    inMonth.forEach(function (t) {
      var k = kind(t, opts);
      if (k === 'living') { if (countsAsLiving(t, opts)) living -= t.amount; }
      else if (k === 'finance') finance -= t.amount;
      else if (k === 'income') income += t.amount;
      else if (k === 'invest') invest += t.amount;
    });

    // 월말 예상: 데이터 마지막 날짜가 이 달 안이면 누적 ÷ 경과일 × 월 일수
    var lastDate = txs.reduce(function (a, t) { return t.date > a ? t.date : a; }, '');
    var dim = daysIn(ym), elapsed = dim, partial = false;
    if (monthOf(lastDate) === ym) { elapsed = +lastDate.slice(8, 10); partial = elapsed < dim; }
    var forecast = partial ? Math.round(living / elapsed * dim) : living;

    var prev = addMonths(ym, -1);
    var series = [];
    for (var i = 5; i >= 0; i--) {
      var mm = addMonths(ym, -i);
      series.push({ ym: mm, value: sum(objVals(livingByCat(txs, mm, opts))) });
    }
    var prevLiving = series[4].value;
    // 데이터가 시작된 첫 달은 중간부터라 비교 기준에서 뺌
    var firstDate = txs.reduce(function (a, t) { return !a || t.date < a ? t.date : a; }, '');
    var firstFull = firstDate.slice(8, 10) === '01' ? monthOf(firstDate) : addMonths(monthOf(firstDate), 1);
    var hasHistory = addMonths(ym, -3) >= firstFull;
    var avg3 = hasHistory ? (series[2].value + series[3].value + series[4].value) / 3 : null;

    var cur = livingByCat(txs, ym, opts), prv = livingByCat(txs, prev, opts);
    var byCat = Object.keys(cur).map(function (c) {
      return { cat: c, amount: cur[c], share: living ? cur[c] / living : 0 };
    }).sort(function (a, b) { return b.amount - a.amount; });

    var cats = {};
    Object.keys(cur).concat(Object.keys(prv)).forEach(function (c) { cats[c] = 1; });
    var deltas = Object.keys(cats).map(function (c) {
      var a = cur[c] || 0, b = prv[c] || 0;
      return { cat: c, cur: a, prev: b, diff: a - b, pct: b ? (a - b) / b : null };
    }).filter(function (d) { return d.diff > 0; })
      .sort(function (a, b) { return b.diff - a.diff; }).slice(0, 5);

    // 이상 지출: 카테고리가 직전 3개월 평균의 1.5배 이상(5만원 이상일 때) + 한 번에 큰 결제
    var p1 = livingByCat(txs, addMonths(ym, -1), opts),
        p2 = livingByCat(txs, addMonths(ym, -2), opts),
        p3 = livingByCat(txs, addMonths(ym, -3), opts);
    var alerts = [];
    Object.keys(cur).forEach(function (c) {
      var avg = ((p1[c] || 0) + (p2[c] || 0) + (p3[c] || 0)) / 3;
      if (hasHistory && avg > 0 && cur[c] >= 50000 && cur[c] >= avg * 1.5)
        alerts.push({ kind: 'cat', cat: c, amount: cur[c], avg: avg, ratio: cur[c] / avg });
    });
    inMonth.forEach(function (t) {
      if (kind(t, opts) === 'living' && -t.amount >= opts.oneOffMin)
        alerts.push({ kind: 'big', cat: t.cat, date: t.date, content: t.content, amount: -t.amount });
    });
    alerts.sort(function (a, b) { return b.amount - a.amount; });
    var firstPartial = monthOf(firstDate) === ym && firstDate.slice(8, 10) !== '01';

    var budgets = Object.keys(opts.budgets || {}).filter(function (c) { return opts.budgets[c] > 0; })
      .map(function (c) { return { cat: c, budget: opts.budgets[c], used: cur[c] || 0 }; });

    return {
      ym: ym, living: living, finance: finance, income: income, invest: invest,
      forecast: forecast, partial: partial, elapsed: elapsed, dim: dim,
      prevLiving: prevLiving, avg3: avg3, series: series, byCat: byCat, deltas: deltas,
      alerts: alerts, fixed: fixedCosts(txs, ym, opts), budgets: budgets, totalBudget: opts.totalBudget,
      count: inMonth.length, firstPartial: firstPartial, firstDate: firstDate, lastDate: lastDate
    };
  }

  function objVals(o) { return Object.keys(o).map(function (k) { return o[k]; }); }

  function typeCounts(txs, opts) {
    opts = Object.assign({}, DEFAULT_OPTS, opts || {});
    var c = { living: 0, finance: 0, income: 0, invest: 0, excluded: 0 };
    txs.forEach(function (t) { c[kind(t, opts)]++; });
    return c;
  }

  return {
    DEFAULT_OPTS: DEFAULT_OPTS, normalizeRows: normalizeRows, merge: merge, kind: kind,
    isOneOff: isOneOff, countsAsLiving: countsAsLiving, summarize: summarize, months: months,
    addMonths: addMonths, typeCounts: typeCounts, EXCLUDED_TRANSFER: EXCLUDED_TRANSFER
  };
});

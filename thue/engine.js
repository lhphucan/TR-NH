/* Noir Tax — lõi đối soát chạy trong trình duyệt (port 1:1 từ TAX APP Python:
 * reconciliation.py + main.py/api_reconcile). Không gửi file đi đâu: mọi sao kê,
 * dữ liệu máy đọc và tính ngay trên máy người dùng.
 *
 * Thư viện cần có sẵn trên globalThis.TaxLibs (hoặc window): XLSX (SheetJS) để
 * đọc Excel/CSV, pdfjs (pdf.js) để đọc sao kê MB dạng PDF.
 *
 * Ngày giờ giữ dạng chuỗi 'YYYY-MM-DD HH:MM:SS' (so sánh chuỗi = so thời gian) để
 * không dính lệch múi giờ của Date.
 */
(function (root) {
  'use strict';

  const lib = (name) => {
    const libs = root.TaxLibs || {};
    const v = libs[name] || root[name];
    if (!v) throw new Error(`Thiếu thư viện ${name}.`);
    return v;
  };

  // =====================================================================
  // TIỆN ÍCH NGÀY GIỜ
  // =====================================================================
  const pad2 = (n) => String(n).padStart(2, '0');
  const pad4 = (n) => String(n).padStart(4, '0');

  function mkTime(y, mo, d, h = 0, mi = 0, s = 0) {
    if (!(y >= 1900 && y <= 2200 && mo >= 1 && mo <= 12 && d >= 1 && h <= 23 && mi <= 59 && s <= 59)) return null;
    const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    if (d > dim) return null;
    return `${pad4(y)}-${pad2(mo)}-${pad2(d)} ${pad2(h)}:${pad2(mi)}:${pad2(s)}`;
  }

  // Ngày từ ô Excel: chuỗi (ưu tiên ngày đứng trước — dayfirst như pandas) hoặc ô
  // kiểu ngày đã đọc thành {__date:{y,m,d,H,M,S}}. Trả 'YYYY-MM-DD HH:MM:SS' hoặc null.
  function parseDayFirst(v) {
    if (v == null) return null;
    if (typeof v === 'object' && v.__date) {
      const t = v.__date;
      return mkTime(t.y, t.m, t.d, t.H || 0, t.M || 0, Math.floor(t.S || 0));
    }
    const s = String(v).trim();
    if (!s) return null;
    // YYYY-MM-DD[ HH:MM[:SS]] (ISO, chuỗi Timestamp của pandas)
    let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?$/);
    if (m) return mkTime(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
    // DD/MM/YYYY[ HH:MM[:SS]] — dấu / - . đều được
    m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?$/);
    if (m) {
      const a = +m[1], b = +m[2];
      // dayfirst: thử ngày/tháng trước; tháng > 12 thì đảo (như dateutil)
      const t = mkTime(+m[3], b, a, +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
      if (t) return t;
      return mkTime(+m[3], a, b, +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
    }
    return null;
  }

  const dayOf = (t) => String(t).slice(0, 10);
  function dayNum(iso) {          // 'YYYY-MM-DD' -> số ngày (để cộng/trừ ngày)
    const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
    return Math.round(Date.UTC(y, m - 1, d) / 86400000);
  }
  function numDay(n) {
    const dt = new Date(n * 86400000);
    return `${pad4(dt.getUTCFullYear())}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
  }
  const addDays = (iso, k) => numDay(dayNum(iso) + k);

  // round() của Python: làm tròn nửa về số chẵn
  function pyRound(x) {
    const f = Math.floor(x), diff = x - f;
    if (diff > 0.5) return f + 1;
    if (diff < 0.5) return f;
    return (f % 2 === 0) ? f : f + 1;
  }

  // str() của Python cho 1 ô pandas: rỗng/NaN -> 'nan'
  function pyStr(v) {
    if (v == null || v === '') return 'nan';
    if (typeof v === 'number') return Number.isNaN(v) ? 'nan' : String(v);
    if (typeof v === 'object' && v.__date) {
      return parseDayFirst(v) || 'nan';
    }
    return String(v);
  }

  // Counter lồng theo ngày: Map(day -> Map(amount -> count)), giữ thứ tự chèn như dict
  function slotGet(slots, day, amt) {
    const c = slots.get(day);
    return c ? (c.get(amt) || 0) : 0;
  }
  function slotAdd(slots, day, amt, k) {
    let c = slots.get(day);
    if (!c) { c = new Map(); slots.set(day, c); }
    c.set(amt, (c.get(amt) || 0) + k);
  }
  const addTo = (obj, k, v) => { obj[k] = (obj[k] || 0) + v; };

  // =====================================================================
  // ĐỌC EXCEL / CSV (SheetJS) — trả mảng dòng như pandas header=None
  // =====================================================================
  function readSheetRows(bytes, filename) {
    const XLSX = lib('XLSX');
    const isCsv = /\.csv$/i.test(filename || '');
    let wb;
    if (isCsv) {
      const text = new TextDecoder('utf-8').decode(bytes).replace(/^﻿/, '');
      wb = XLSX.read(text, { type: 'string', raw: true });
    } else {
      wb = XLSX.read(bytes, { type: 'array', cellDates: false, cellNF: true, cellText: false });
    }
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws || !ws['!ref']) return [];
    const range = XLSX.utils.decode_range(ws['!ref']);
    const nCols = range.e.c + 1;
    const rows = [];
    for (let r = 0; r <= range.e.r; r++) {
      const row = new Array(nCols).fill(null);
      let any = false;
      for (let c = 0; c <= range.e.c; c++) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })];
        if (!cell || cell.v == null) continue;
        let v = cell.v;
        if (cell.t === 'd' && v instanceof Date) {
          v = { __date: { y: v.getFullYear(), m: v.getMonth() + 1, d: v.getDate(), H: v.getHours(), M: v.getMinutes(), S: v.getSeconds() } };
        } else if (cell.t === 'n' && cell.z && XLSX.SSF.is_date(cell.z)) {
          const p = XLSX.SSF.parse_date_code(v);
          if (p) v = { __date: { y: p.y, m: p.m, d: p.d, H: p.H, M: p.M, S: p.S } };
        } else if (cell.t === 'e') {
          v = null;
        }
        if (v === '') v = null;            // pandas coi ô '' là NaN
        row[c] = v;
        if (v != null) any = true;
      }
      rows.push(any ? row : row);
    }
    // pandas bỏ các dòng trống ở CUỐI sheet
    while (rows.length && rows[rows.length - 1].every(v => v == null)) rows.pop();
    return rows;
  }

  // =====================================================================
  // DỮ LIỆU MÁY
  // =====================================================================
  function parseMachineExcel(bytes, filename) {
    let rows;
    try {
      rows = readSheetRows(bytes, filename);
    } catch (e) {
      throw new Error(`Không thể đọc file dữ liệu máy: ${e.message || e}`);
    }
    if (!rows.length) throw new Error('Không tìm thấy đủ các cột (Thời gian, Phương thức, Số tiền). Các cột hiện tại: []');
    const header = rows[0].map((h, j) => (h == null ? `Unnamed: ${j}` : String(typeof h === 'object' ? pyStr(h) : h)));
    const data = rows.slice(1);
    const lower = header.map(h => h.toLowerCase());
    const findCol = (keys) => {
      const j = lower.findIndex(h => keys.some(k => h.includes(k)));
      return j < 0 ? null : j;
    };

    const colTime = findCol(['thời gian', 'ngày', 'time']);
    // Định danh máy: ưu tiên cột "Buồng chụp"; cột "Mã" thường rỗng 100%
    let colMachine = findCol(['buồng', 'buong', 'booth']);
    if (colMachine == null) {
      for (let j = 0; j < lower.length; j++) {
        if (['mã', 'máy', 'id', 'thiết bị'].some(k => lower[j].includes(k))) {
          if (data.some(r => r[j] != null)) { colMachine = j; break; }
        }
      }
    }
    const colMethod = findCol(['phương thức', 'thanh toán', 'method']);
    const colAmount = findCol(['số tiền', 'doanh thu', 'amount']);
    if (colTime == null || colMethod == null || colAmount == null) {
      throw new Error(`Không tìm thấy đủ các cột (Thời gian, Phương thức, Số tiền). Các cột hiện tại: [${header.map(h => `'${h}'`).join(', ')}]`);
    }
    const colStatus = findCol(['trạng thái', 'status']);

    const classify = (val) => {
      const s = pyStr(val).toLowerCase();
      if (['tiền mặt', 'cash', 'tien mat'].some(k => s.includes(k))) return 'Tiền mặt';
      if (['miễn phí', 'mien phi', 'free'].some(k => s.includes(k))) return 'Miễn phí';
      return 'Mã QR';
    };
    const toAmount = (val) => {
      const s = pyStr(val).replace(/[^\d.]/g, '');
      if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) return 0;
      return pyRound(parseFloat(s));
    };

    const records = [];
    for (const row of data) {
      if (colStatus != null && !/hoàn tất|thành công|success|completed/.test(pyStr(row[colStatus]).toLowerCase())) continue;
      const t = parseDayFirst(row[colTime]);
      if (!t) continue;
      let mid = '';
      if (colMachine != null) {
        const v = pyStr(row[colMachine]).trim();
        mid = v.toLowerCase() === 'nan' ? '' : v;
      }
      records.push({
        time: t,
        machine_id: mid,
        method: classify(row[colMethod]),
        amount: toAmount(row[colAmount]),
        original_time: pyStr(row[colTime]),
      });
    }
    return records;
  }

  // =====================================================================
  // SAO KÊ VIETINBANK (.xlsx)
  // =====================================================================
  function vtbInt(val) {       // '50,000' / 50000 -> 50000; rỗng -> null
    if (val == null) return null;
    if (typeof val === 'number') return Number.isFinite(val) ? pyRound(val) : null;
    const s = pyStr(val).trim();
    if (s === '' || s.toLowerCase() === 'nan') return null;
    const d = s.replace(/[^\d]/g, '');
    return /^\d+$/.test(d) ? parseInt(d, 10) : null;
  }

  function rowsText(rows, n) {
    return rows.slice(0, n).map(r => r.map(pyStr).join(' ')).join(' ').toLowerCase();
  }

  function isVtbRows(rows) {
    const text = rowsText(rows, 30);
    const hasBank = text.includes('vietinbank') || text.includes('cong thuong') || text.includes('công thương');
    const hasHdr = (text.includes('ghi nợ') && text.includes('ghi có')) ||
      (text.includes('debit') && text.includes('credit') && text.includes('nội dung giao dịch'));
    return hasBank && hasHdr;
  }

  function parseVtbRows(rows) {
    let hdrRow = null;
    let col = {};
    for (let i = 0; i < rows.length; i++) {
      const cells = rows[i].map(x => pyStr(x).trim().toLowerCase());
      const joined = cells.join(' | ');
      if ((joined.includes('ghi nợ') && joined.includes('ghi có')) || (joined.includes('debit') && joined.includes('credit'))) {
        col = {};
        cells.forEach((c, j) => {
          if (c === 'ngày giao dịch' || c === 'transaction date') col.time = j;
          else if (c === 'nội dung giao dịch' || c === 'transaction details' || c === 'nội dung') col.desc = j;
          else if (c === 'ghi nợ' || c === 'debit') col.debit = j;
          else if (c === 'ghi có' || c === 'credit') col.credit = j;
          else if (c === 'mã giao dịch' || c === 'reference no') col.ref = j;
        });
        if ('credit' in col && 'time' in col) { hdrRow = i; break; }
      }
    }
    if (hdrRow == null || !('credit' in col)) throw new Error("Không tìm thấy cột 'Ghi Có/Credit' trong sao kê Vietinbank.");

    const records = [];
    for (let i = hdrRow + 1; i < rows.length; i++) {
      const row = rows[i];
      const first = pyStr(row[0]).trim().toLowerCase();
      const cellTime = col.time < row.length ? pyStr(row[col.time]).trim() : '';
      if (first.includes('số dư cuối kỳ') || first.includes('ending balance') || first.includes('doanh số phát sinh')) break;
      if (first.includes('số dư đầu kỳ') || first.includes('beginning balance')) continue;
      const t = parseDayFirst(row[col.time]);
      if (!t) continue;
      const credit = (col.credit < row.length ? vtbInt(row[col.credit]) : null) || 0;
      const debit = (col.debit != null && col.debit < row.length ? vtbInt(row[col.debit]) : null) || 0;
      if (credit <= 0 && debit <= 0) continue;
      let desc = '';
      if (col.desc != null && col.desc < row.length) {
        desc = pyStr(row[col.desc]).trim();
        if (desc.toLowerCase() === 'nan') desc = '';
      }
      if (col.ref != null && col.ref < row.length) {
        const ref = pyStr(row[col.ref]).trim();
        if (ref && ref.toLowerCase() !== 'nan' && !desc.includes(ref)) desc = `${desc} ${ref}`.trim();
      }
      records.push({ time: t, amount: credit, debit, description: desc, original_time: cellTime });
    }
    return records;
  }

  function parseVtbBalances(rows) {
    let opening = null, closing = null;
    let balCol = null;
    for (let i = 0; i < rows.length && balCol == null; i++) {
      const cells = rows[i].map(x => pyStr(x).trim().toLowerCase());
      const j = cells.findIndex(c => c === 'số dư cuối' || c === 'balance');
      if (j >= 0) balCol = j;
    }
    const rowNum = (row) => {
      if (balCol != null && balCol < row.length) {
        const v = vtbInt(row[balCol]);
        if (v != null) return v;
      }
      for (let k = row.length - 1; k >= 0; k--) {
        const v = vtbInt(row[k]);
        if (v != null) return v;
      }
      return null;
    };
    for (const row of rows) {
      const first = pyStr(row[0]).trim().toLowerCase();
      if (opening == null && (first.includes('số dư đầu kỳ') || first.includes('beginning balance'))) opening = rowNum(row);
      if (first.includes('số dư cuối kỳ') || first.includes('ending balance')) closing = rowNum(row);
    }
    return [opening, closing];
  }

  // =====================================================================
  // SAO KÊ MB (.xlsx bản mới)
  // =====================================================================
  function numVnd(val) {       // 70000.0 / '48961945.' / '70,000' -> int
    if (val == null) return null;
    if (typeof val === 'number') return Number.isFinite(val) ? pyRound(val) : null;
    const s = pyStr(val).trim();
    if (s === '' || s.toLowerCase() === 'nan') return null;
    if (s.includes('.') && !s.includes(',')) {
      const f = Number(s);
      if (Number.isFinite(f) && /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return pyRound(f);
    }
    const d = s.replace(/[^\d]/g, '');
    return /^\d+$/.test(d) ? parseInt(d, 10) : null;
  }

  function isMbRows(rows) {
    const text = rowsText(rows, 25);
    const hasBank = text.includes('quân đội') || text.includes('quan doi') || text.includes('military') || text.includes('mbbank');
    const hasHdr = (text.includes('phát sinh nợ') && text.includes('phát sinh có')) ||
      (text.includes('debit') && text.includes('credit') && text.includes('nội dung'));
    return hasBank && hasHdr;
  }

  function mbLocate(rows) {
    for (let i = 0; i < Math.min(40, rows.length); i++) {
      const cells = rows[i].map(x => pyStr(x).trim().toLowerCase());
      const joined = cells.join(' ');
      if ((joined.includes('phát sinh nợ') || joined.includes('debit')) &&
          (joined.includes('phát sinh có') || joined.includes('credit'))) {
        const col = {};
        const setdef = (k, j) => { if (!(k in col)) col[k] = j; };
        cells.forEach((c, j) => {
          if (c.includes('ngày giao dịch') || c.includes('transaction dat')) col.time = j;
          else if (c.includes('số bút toán') || c.includes('transaction no')) col.txno = j;
          else if (c.includes('phát sinh nợ') || c === 'debit' || (c.includes('debit') && joined.includes('phát sinh nợ'))) setdef('debit', j);
          else if (c.includes('phát sinh có') || c === 'credit') setdef('credit', j);
          else if (c.includes('nội dung') || c === 'details') setdef('desc', j);
          else if (c.includes('thụ hưởng') || c.includes('chuyển') || c.includes('remitter')) setdef('remitter', j);
          else if (c.includes('ngân hàng đối tác')) setdef('bank', j);
        });
        if ('time' in col && 'credit' in col) return [i, col];
      }
    }
    return [null, null];
  }

  function parseMbXlsxRows(rows) {
    const [hdrRow, col] = mbLocate(rows);
    if (hdrRow == null) throw new Error("Không tìm thấy cột 'Phát sinh có/Credit' trong sao kê MB (.xlsx).");
    const records = [];
    for (let i = hdrRow + 1; i < rows.length; i++) {
      const row = rows[i];
      const cellTime = col.time < row.length ? pyStr(row[col.time]).trim() : '';
      const low0 = row.slice(0, 6).map(x => pyStr(x).toLowerCase()).join(' ');
      if (low0.includes('tổng phát sinh') || low0.includes('số dư cuối') || low0.includes('closing bal')) break;
      const t = parseDayFirst(row[col.time]);
      if (!t) continue;
      const credit = (col.credit < row.length ? numVnd(row[col.credit]) : null) || 0;
      const debit = (col.debit != null && col.debit < row.length ? numVnd(row[col.debit]) : null) || 0;
      if (credit <= 0 && debit <= 0) continue;
      let desc = '';
      if (col.desc != null && col.desc < row.length) {
        desc = pyStr(row[col.desc]).trim();
        if (desc.toLowerCase() === 'nan') desc = '';
      }
      if (col.remitter != null && col.remitter < row.length) {
        const rem = pyStr(row[col.remitter]).trim();
        if (rem && rem.toLowerCase() !== 'nan' && !desc.includes(rem)) desc = `${desc} ${rem}`.trim();
      }
      records.push({ time: t, amount: credit, debit, description: desc, original_time: cellTime });
    }
    return records;
  }

  function parseMbXlsxBalances(rows) {
    let opening = null, closing = null;
    const fromLabel = (v) => {
      const nums = String(v).match(/\d[\d.,]*/g);
      return nums ? numVnd(nums[nums.length - 1]) : null;
    };
    for (const row of rows) {
      for (const cell of row) {
        const v = pyStr(cell);
        const vl = v.toLowerCase();
        if (opening == null && (vl.includes('số dư đầu kỳ') || vl.includes('opening bala'))) opening = fromLabel(v);
        if (vl.includes('số dư cuối kỳ') || vl.includes('closing bal')) closing = fromLabel(v);
      }
    }
    return [opening, closing];
  }

  // =====================================================================
  // SAO KÊ MB (.pdf) — dò cột theo header Debit/Credit, neo theo dòng tiền
  // =====================================================================
  const MONEY_RE = /^[\d.,]*\d[.,]\d{2}$/;   // 80,000.00 / 1,572,000.00
  function cleanMoney(word) {
    if (!MONEY_RE.test(word)) return null;
    const c = word.slice(0, -3).replace(/[.,]/g, '');
    return /^\d+$/.test(c) ? parseInt(c, 10) : null;
  }

  // Tách nội dung trang PDF thành "từ" giống PyMuPDF get_text("words"):
  // [x0, y0, x1, y1, word], gốc toạ độ góc trên-trái, y0 = đường chân chữ − ascent.
  // Kèm các dòng chữ (để đọc Số dư đầu/cuối kỳ như page.get_text()).
  function pageWords(tc, vp, pdfjs) {
    const words = [];
    const lines = [];
    let cur = null;          // từ đang ghép dở (chữ dính liền giữa 2 mảnh)
    let prevEnd = null;      // {x, y, size} cuối mảnh trước
    let line = null;         // {y, text, endX}
    const flushLine = () => { if (line) { lines.push(line.text); line = null; } };
    for (const it of tc.items) {
      if (typeof it.str !== 'string') continue;
      const tx = pdfjs.Util.transform(vp.transform, it.transform);
      const size = Math.hypot(tx[2], tx[3]) || Math.hypot(tx[0], tx[1]) || 1;
      const x = tx[4], base = tx[5];
      const w = it.width * vp.scale;
      const st = tc.styles[it.fontName] || {};
      const asc = (st.ascent > 0.5 && st.ascent < 1.2) ? st.ascent : 0.89;
      const desc = (st.descent < 0 && st.descent > -0.6) ? -st.descent : 0.22;
      const y0 = base - asc * size, y1 = base + desc * size;
      const s = it.str;

      // dòng chữ (cho số dư)
      if (s.length) {
        if (line && Math.abs(line.y - base) < size * 0.5) {
          const gap = x - line.endX;
          line.text += (gap > size * 0.15 && !/\s$/.test(line.text) && !/^\s/.test(s)) ? ' ' + s : s;
          line.endX = x + w;
        } else {
          flushLine();
          line = { y: base, text: s, endX: x + w };
        }
      }
      if (it.hasEOL) flushLine();

      if (!s.length) { cur = null; prevEnd = null; continue; }
      const n = s.length;
      const cw = w / n;
      const sameLine = prevEnd && Math.abs(prevEnd.y - base) < size * 0.3 && Math.abs(x - prevEnd.x) < size * 0.2;
      const re = /\S+/g;
      let m;
      let firstTok = true;
      while ((m = re.exec(s))) {
        const wx0 = x + m.index * cw, wx1 = x + (m.index + m[0].length) * cw;
        if (firstTok && m.index === 0 && cur && sameLine) {
          cur[4] += m[0];
          cur[2] = wx1;
        } else {
          cur = [wx0, y0, wx1, y1, m[0]];
          words.push(cur);
        }
        firstTok = false;
      }
      if (/\s$/.test(s) || !/\S/.test(s)) cur = null;
      prevEnd = { x: x + w, y: base, size };
      if (it.hasEOL) { cur = null; prevEnd = null; }
    }
    flushLine();
    return { words, lines };
  }

  async function readPdfPages(bytes) {
    const pdfjs = lib('pdfjs');
    const doc = await pdfjs.getDocument({
      data: bytes.slice(), isEvalSupported: false, disableFontFace: true, verbosity: 0,
    }).promise;
    const pages = [];
    try {
      for (let n = 1; n <= doc.numPages; n++) {
        const page = await doc.getPage(n);
        const vp = page.getViewport({ scale: 1 });
        const tc = await page.getTextContent();
        pages.push(pageWords(tc, vp, pdfjs));
        page.cleanup();
      }
    } finally {
      await doc.destroy();
    }
    return pages;
  }

  function detectColumns(words) {
    let debitX = null, creditX = null, debitY = null;
    for (const w of words) {
      const t = w[4].trim().toLowerCase();
      if (t === 'debit' && debitX == null) { debitX = w[0]; debitY = w[1]; }
      else if (t === 'credit' && creditX == null && (debitY == null || Math.abs(w[1] - debitY) < 6)) creditX = w[0];
    }
    if (debitX == null || creditX == null || creditX <= debitX) return null;
    const right = words.filter(w => Math.abs(w[1] - debitY) < 6 && w[0] > creditX + 5).map(w => w[0]);
    const creditRight = right.length ? Math.min(...right) : creditX + (creditX - debitX);
    let detailsX = null;
    for (const w of words) if (w[4].trim().toLowerCase() === 'details' && Math.abs(w[1] - debitY) < 6) detailsX = w[0];
    if (detailsX == null) detailsX = creditRight;
    return [debitX, creditX, creditRight, detailsX];
  }

  function parseMbPdfPages(pages) {
    const records = [];
    let cols = null;
    for (const { words } of pages) {
      if (!words.length) continue;
      const det = detectColumns(words);
      if (det) cols = det;
      if (!cols) continue;
      const [debitX, creditX, creditRight] = cols;
      const contentLeft = creditX + 55;

      // BƯỚC 1 — neo: mỗi giao dịch đúng 1 dòng có số tiền ở cột Nợ/Có
      let anchors = [];
      for (const w of words) {
        const val = cleanMoney(w[4]);
        if (val == null) continue;
        const center = (w[0] + w[2]) / 2;
        const isDebit = debitX - 25 <= center && center < creditX - 5;
        const isCredit = creditX - 5 <= center && center < creditRight - 5;
        if (!(isDebit || isCredit)) continue;
        anchors.push({ y: w[1], date_str: '', credit: isCredit ? val : 0, debit: isDebit ? val : 0, desc_words: [] });
      }
      // Dòng "Tổng phát sinh" -> mọi thứ từ đó trở xuống là chân trang
      let stopY = null;
      for (const w of words) {
        if (w[4].toLowerCase().includes('tổng')) {
          const near = words.filter(x => Math.abs(x[1] - w[1]) < 4).map(x => x[4]).join(' ').toLowerCase();
          if (near.includes('tổng phát sinh')) { stopY = w[1]; break; }
        }
      }
      if (stopY != null) anchors = anchors.filter(a => a.y < stopY - 2);

      let headerY = null;
      for (const w of words) {
        if (w[4].trim().toLowerCase() === 'credit' && Math.abs(w[0] - creditX) < 2) { headerY = w[1]; break; }
      }
      const firstAnchorY = headerY != null ? headerY + 6 : null;

      // BƯỚC 2 — gán NGÀY + NỘI DUNG cho neo gần nhất theo Y
      if (anchors.length) {
        const ys = anchors.map(a => a.y);
        const nearest = (y) => {
          let bi = 0, bd = Math.abs(ys[0] - y);
          for (let i = 0; i < ys.length; i++) {
            const d = Math.abs(ys[i] - y);
            if (d < bd) { bi = i; bd = d; }
          }
          return bi;
        };
        for (const w of words) {
          const [x0, y, , , word] = w;
          if (stopY != null && y >= stopY - 2) continue;
          const val = cleanMoney(word);
          if (/^\d{2}\/\d{2}\/\d{4}$/.test(word) && x0 < debitX) {
            const a = anchors[nearest(y)];
            if (!a.date_str || x0 < 60) a.date_str = word;
            continue;
          }
          if (x0 >= contentLeft && val == null) {
            if (firstAnchorY != null && y < firstAnchorY) continue;
            anchors[nearest(y)].desc_words.push([y, x0, word]);
          }
        }
      }

      for (const tx of anchors) {
        if ((tx.credit <= 0 && tx.debit <= 0) || !tx.date_str) continue;
        const [d, m, y] = tx.date_str.split('/').map(Number);
        const t = mkTime(y, m, d);
        if (!t) continue;
        const dw = tx.desc_words.slice().sort((a, b) => (pyRound(a[0]) - pyRound(b[0])) || (a[1] - b[1]));
        records.push({
          time: t, amount: tx.credit, debit: tx.debit,
          description: dw.map(x => x[2]).join(' '),
          original_time: tx.date_str,
        });
      }
    }
    return records;
  }

  function parseMbPdfBalances(pages) {
    const BAL_RE = /([\d.,]+)\s*VND/i;
    const toInt = (s) => {
      s = s.replace(/[.,]/g, '');
      if (!/^\d+$/.test(s)) return null;
      return s.length > 2 ? parseInt(s.slice(0, -2), 10) : parseInt(s, 10);
    };
    let opening = null, closing = null;
    for (const { lines } of pages) {
      const low = lines.join('\n').toLowerCase();
      if (opening == null && (low.includes('dư đầu') || low.includes('opening balance'))) {
        for (const line of lines) {
          const ll = line.toLowerCase();
          if (ll.includes('dư đầu') || ll.includes('opening balance')) {
            const m = line.match(BAL_RE);
            if (m) opening = toInt(m[1]);
            break;
          }
        }
      }
      if (low.includes('dư cuối') || low.includes('closing balance')) {
        for (const line of lines) {
          const ll = line.toLowerCase();
          if (ll.includes('dư cuối') || ll.includes('closing balance')) {
            const m = line.match(BAL_RE);
            if (m) closing = toInt(m[1]);
            break;
          }
        }
      }
    }
    return [opening, closing];
  }

  // =====================================================================
  // NHẬN DIỆN & ĐỌC SAO KÊ
  // =====================================================================
  const isPdf = (name) => /\.pdf$/i.test(name || '');

  // Trả {kind:'bank', records, balances} hoặc {kind:'machine', records}
  async function routeFile(bytes, filename) {
    if (isPdf(filename)) {
      let pages;
      try {
        pages = await readPdfPages(bytes);
      } catch (e) {
        throw new Error(`Không thể đọc file PDF sao kê: ${e.message || e}`);
      }
      return { kind: 'bank', records: parseMbPdfPages(pages), balances: parseMbPdfBalances(pages) };
    }
    let rows = null;
    if (!/\.csv$/i.test(filename || '')) {
      try { rows = readSheetRows(bytes, filename); } catch (_) { rows = null; }
    }
    if (rows && isMbRows(rows)) return { kind: 'bank', records: parseMbXlsxRows(rows), balances: parseMbXlsxBalances(rows) };
    if (rows && isVtbRows(rows)) return { kind: 'bank', records: parseVtbRows(rows), balances: parseVtbBalances(rows) };
    return { kind: 'machine', records: parseMachineExcel(bytes, filename) };
  }

  // =====================================================================
  // PHÂN LOẠI NỘI DUNG CK
  // =====================================================================
  // Chốt với chủ hộ: CK về MÁY luôn có "PTB" trong nội dung; không có = doanh thu khác.
  const MACHINE_QR_MARKERS = ['ptb'];
  const NON_REVENUE = ['tra lai tien gui', 'lai tien gui', 'tra lãi', 'lãi tiền gửi'];
  const isMachineQr = (d) => MACHINE_QR_MARKERS.some(k => String(d || '').toLowerCase().includes(k));
  const isNonRevenue = (d) => NON_REVENUE.some(k => String(d || '').toLowerCase().includes(k));

  const byTime = (a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0);

  // =====================================================================
  // ĐỐI SOÁT — mode 'machine' (MINIBOOTH: máy không QR, doanh thu = tổng lượt máy)
  // =====================================================================
  function matchMachineMode(machineRecords, bankRecords) {
    const records = [];
    const warnings = [];
    const machine = (machineRecords || []).slice().sort(byTime);
    const bank = (bankRecords || []).slice().sort(byTime);
    const bankDebit = bank.reduce((a, b) => a + (b.debit || 0), 0);

    const creditItems = [];
    bank.forEach((b, i) => { if ((b.amount || 0) > 0) creditItems.push([i, b]); });
    const bankCredit = creditItems.reduce((a, [, b]) => a + b.amount, 0);
    const byDayAmt = new Map();     // day -> [[amt, idx]]
    for (const [i, b] of creditItems) {
      const d = dayOf(b.time);
      if (!byDayAmt.has(d)) byDayAmt.set(d, []);
      byDayAmt.get(d).push([b.amount, i]);
    }
    const used = new Set();
    const consume = (mTime, amt) => {
      const md = dayOf(mTime);
      for (const delta of [0, -1, 1, -2, 2]) {
        for (const [a, idx] of (byDayAmt.get(addDays(md, delta)) || [])) {
          if (a === amt && !used.has(idx)) { used.add(idx); return true; }
        }
      }
      return false;
    };

    let machineCash = 0, otherIncome = 0;
    const oir = [];
    for (const m of machine) {
      const amt = m.amount;
      const row = { time: m.time, machine_id: m.machine_id, method: m.method, amount: amt, status: 'Khớp', reason: '' };
      if (amt <= 0) {
        row.reason = 'Lượt chụp 0đ (Khuyến mãi/Miễn phí)';
        records.push(row);
        continue;
      }
      if (consume(m.time, amt)) {
        otherIncome += amt;
        row.status = 'Đã đối soát';
        row.reason = 'Khớp CK về ngân hàng (khách chuyển khoản đổi tiền mặt)';
        oir.push({
          time: m.time, date: m.original_time != null ? m.original_time : m.time, amount: amt,
          description: 'Chuyển khoản chụp ảnh', category: 'booth', is_machine_qr: true, is_loa: true,
        });
      } else {
        machineCash += amt;
        row.reason = 'Tiền mặt (không thấy CK khớp trên ngân hàng)';
      }
      records.push(row);
    }
    const machineTotal = machineCash + otherIncome;

    const unmatchedByDay = {};
    for (const [i, b] of creditItems) {
      if (used.has(i)) continue;
      addTo(unmatchedByDay, dayOf(b.time), b.amount);
      oir.push({
        time: b.time, date: b.original_time != null ? b.original_time : b.time, amount: b.amount,
        description: b.description || '', declared_desc: 'Chuyển khoản chụp ảnh',
        category: 'other', is_machine_qr: false, is_loa: false,
      });
    }
    const bankUnmatched = Object.values(unmatchedByDay).reduce((a, v) => a + v, 0);
    return {
      records, warnings, other_income: otherIncome, other_income_records: oir,
      totals: {
        machine_total: machineTotal, machine_cash: machineCash, machine_qr: 0,
        bank_credit: bankCredit, bank_debit: bankDebit, verified_qr: 0, unverified_qr: 0,
        booth_ck: otherIncome, other_biz_ck: bankUnmatched, bank_unmatched: bankUnmatched,
      },
      bank_unmatched_by_day: unmatchedByDay,
      mode: 'machine',
    };
  }

  // =====================================================================
  // ĐỐI SOÁT — mode 'bank' (máy có QR: tiền CK theo ngân hàng, tiền mặt theo máy)
  // =====================================================================
  function matchTransactions(machineRecords, bankRecords, mode = 'bank') {
    if (mode === 'machine') return matchMachineMode(machineRecords, bankRecords);
    const records = [];
    const warnings = [];
    const bankCredit = bankRecords.reduce((a, b) => a + (b.amount || 0), 0);
    const bankDebit = bankRecords.reduce((a, b) => a + (b.debit || 0), 0);

    const machine = (machineRecords || []).slice().sort(byTime);
    const machineCash = machine.filter(m => m.method === 'Tiền mặt').reduce((a, m) => a + m.amount, 0);
    const machineQr = machine.filter(m => m.method === 'Mã QR').reduce((a, m) => a + m.amount, 0);
    const machineTotal = machine.reduce((a, m) => a + m.amount, 0);
    const hasBank = bankRecords.length > 0;

    // LỚP KIỂM TRA: mỗi lượt QR máy ghép 1 khoản bank cùng tiền, ±2 ngày (chỉ bắt lỗi)
    const byAmount = new Map();      // amount -> [idx...] theo thứ tự gốc
    bankRecords.forEach((b, i) => {
      if (!byAmount.has(b.amount)) byAmount.set(b.amount, []);
      byAmount.get(b.amount).push(i);
    });
    const usedIdx = new Set();
    let verifiedQr = 0, unverifiedQr = 0;
    for (const m of machine) {
      const row = { time: m.time, machine_id: m.machine_id, method: m.method, amount: m.amount, status: 'Khớp', reason: '' };
      if (m.method === 'Tiền mặt') {
        row.reason = 'Tiền mặt (thu ngoài ngân hàng)';
      } else if (m.amount === 0) {
        row.reason = 'Lượt chụp 0đ (Khuyến mãi/Miễn phí)';
      } else {
        let ev = null, best = Infinity;
        if (hasBank) {
          const md = dayNum(m.time);
          for (const i of (byAmount.get(m.amount) || [])) {
            if (usedIdx.has(i)) continue;
            const dd = Math.abs(dayNum(bankRecords[i].time) - md);
            if (dd <= 2 && dd < best) { best = dd; ev = i; }
          }
        }
        if (ev != null) {
          usedIdx.add(ev);
          const b = bankRecords[ev];
          verifiedQr += 1;
          row.status = 'Đã đối soát';
          row.reason = `Khớp tiền về NH: ${b.description} (${b.original_time})`;
        } else {
          unverifiedQr += 1;
          row.status = 'Máy ghi - chưa thấy về NH';
          row.reason = 'Máy ghi lượt QR nhưng chưa thấy tiền về ngân hàng (±2 ngày) — kiểm tra máy sót log hay tiền về trễ';
          warnings.push(row);
        }
      }
      records.push(row);
    }

    // DOANH THU CK = mọi khoản bank credit, phân loại booth / other / non_revenue
    const slots = new Map();
    for (const m of machine) if (m.method === 'Mã QR' && m.amount > 0) slotAdd(slots, dayOf(m.time), m.amount, 1);
    const machineHasSlot = (bTime, amt) => {
      const bd = dayOf(bTime);
      for (const delta of [0, -1, 1, -2, 2]) {
        const d = addDays(bd, delta);
        if (slotGet(slots, d, amt) > 0) { slotAdd(slots, d, amt, -1); return true; }
      }
      return false;
    };
    const hasMachineData = machine.length > 0;
    const oir = [];
    if (hasBank) {
      for (const b of bankRecords.slice().sort(byTime)) {
        const amt = b.amount || 0;
        if (amt <= 0) continue;
        const desc = b.description;
        let category;
        if (isNonRevenue(desc)) category = 'non_revenue';
        else if (hasMachineData) category = machineHasSlot(b.time, amt) ? 'booth' : 'other';
        else if (isMachineQr(desc)) category = 'booth';
        else category = 'other';
        oir.push({
          time: b.time, date: b.original_time, amount: amt, description: desc,
          category, is_machine_qr: category === 'booth', is_loa: category === 'booth',
        });
      }
    }
    const otherIncome = oir.filter(r => r.is_loa).reduce((a, r) => a + r.amount, 0);
    const boothCk = oir.filter(r => r.category === 'booth').reduce((a, r) => a + r.amount, 0);
    const otherBizCk = oir.filter(r => r.category === 'other').reduce((a, r) => a + r.amount, 0);
    return {
      records, warnings, other_income: otherIncome, other_income_records: oir,
      totals: {
        machine_total: machineTotal, machine_cash: machineCash, machine_qr: machineQr,
        bank_credit: bankCredit, bank_debit: bankDebit, verified_qr: verifiedQr, unverified_qr: unverifiedQr,
        booth_ck: boothCk, other_biz_ck: otherBizCk,
      },
    };
  }

  // =====================================================================
  // NEO CK NGÂN HÀNG VỀ NGÀY MÁY (khớp mệnh giá, ±2 ngày)
  // =====================================================================
  function neoBankToMachineDay(machineRecords, bankRecords) {
    const slots = new Map();
    for (const m of machineRecords) if (m.method === 'Mã QR') slotAdd(slots, dayOf(m.time), m.amount, 1);
    const flat = [];
    for (const b of bankRecords) if ((b.amount || 0) > 0) flat.push([dayOf(b.time), b.amount]);
    flat.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const boothNeo = {}, otherNeo = {};
    for (const [iso, amt] of flat) {
      let placed = false;
      for (const delta of [0, -1, -2, 1]) {
        const ci = addDays(iso, delta);
        if (slotGet(slots, ci, amt) > 0) {
          slotAdd(slots, ci, amt, -1);
          addTo(boothNeo, ci, amt);
          placed = true;
          break;
        }
      }
      if (!placed) addTo(otherNeo, iso, amt);
    }
    const bankNeo = {};
    for (const [d, v] of Object.entries(boothNeo)) addTo(bankNeo, d, v);
    for (const [d, v] of Object.entries(otherNeo)) addTo(bankNeo, d, v);
    const machineUnmatched = {};
    for (const [iso, cnt] of slots) {
      let left = 0;
      for (const [k, v] of cnt) left += k * v;
      if (left > 0) machineUnmatched[iso] = left;
    }
    return [bankNeo, machineUnmatched, boothNeo, otherNeo];
  }

  // =====================================================================
  // PHÉP CÂN TỰ ĐỘNG
  // =====================================================================
  const fmtVnd = (n) => String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.') + 'đ';
  const isoToDmy = (iso) => { const p = String(iso).split('-'); return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : iso; };
  function topDay(byDay) {
    let top = null;
    for (const [k, v] of Object.entries(byDay)) if (top == null || v > byDay[top]) top = k;
    return top;
  }

  function balanceItem(pdfBalances, bankCredit, bankDebit, srcWord) {
    const valid = (pdfBalances || []).filter(([o, c]) => o != null && c != null);
    if (!valid.length) {
      return {
        level: 'ok', kind: 'balance', title: 'Không cân được số dư (thiếu dữ liệu)',
        detail: srcWord === 'PDF'
          ? 'Không đọc được Số dư đầu/cuối kỳ trên PDF (hoặc chưa upload PDF).'
          : 'Không đọc được Số dư đầu/cuối kỳ trên sao kê (hoặc chưa upload sao kê).',
        hint: '', jump_day: null,
      };
    }
    const sumDelta = valid.reduce((a, [o, c]) => a + (c - o), 0);
    const flow = bankCredit - bankDebit;
    const diff = sumDelta - flow;
    if (diff === 0) {
      return {
        level: 'ok', kind: 'balance', title: 'Số dư ngân hàng cân đối',
        detail: `Dư đầu + Tiền vào − Tiền ra = Dư cuối (khớp ${fmtVnd(flow)}).`, hint: '', jump_day: null,
      };
    }
    return {
      level: 'warn', kind: 'balance', title: 'Số dư ngân hàng KHÔNG khớp',
      detail: `Chênh ${fmtVnd(Math.abs(diff))}: biến động số dư trên sao kê (${fmtVnd(sumDelta)}) khác Tiền vào − Tiền ra đọc được (${fmtVnd(flow)}).`,
      hint: srcWord === 'PDF'
        ? 'Dấu hiệu ĐỌC SÓT/NHẦM giao dịch trong PDF. Kiểm tra file sao kê có bị thiếu trang, hoặc báo kỹ thuật để soi lại parser.'
        : 'Dấu hiệu ĐỌC SÓT/NHẦM giao dịch trong sao kê. Kiểm tra file có thiếu dòng, hoặc báo kỹ thuật để soi lại parser.',
      jump_day: null,
    };
  }

  function buildChecks(p) {
    const items = [balanceItem(p.pdf_balances, p.bank_credit, p.bank_debit, 'PDF')];
    if (p.has_machine && p.machine_qr > 0 && p.bank_machine_qr > 0) {
      const gap = Math.abs(p.machine_qr - p.bank_machine_qr);
      const thr = Math.max(500000, Math.trunc(p.machine_qr * 0.08));
      if (gap > thr) {
        const more = p.machine_qr > p.bank_machine_qr ? 'máy ghi NHIỀU hơn' : 'tiền về bank NHIỀU hơn';
        items.push({
          level: 'warn', kind: 'qr_pending', title: 'QR máy lệch nhiều so với QR thực về ngân hàng',
          detail: `QR máy (Excel) ${fmtVnd(p.machine_qr)} vs QR về bank ${fmtVnd(p.bank_machine_qr)} — lệch ${fmtVnd(gap)} (${more}).`,
          hint: 'Tiền vẫn tính đúng theo ngân hàng — cảnh báo này để rà MÁY: có thể máy sót log vài lượt, hoặc lượt cuối kỳ tiền về sang kỳ sau. Không ảnh hưởng số kê khai.',
          jump_day: null,
        });
      }
    }
    const mu = p.machine_unmatched_by_day || {};
    if (Object.keys(mu).length) {
      const top = topDay(mu);
      const total = Object.values(mu).reduce((a, v) => a + v, 0);
      const dmy = isoToDmy(top);
      items.push({
        level: 'warn', kind: 'qr_pending',
        title: `${Object.keys(mu).length} ngày có QR chưa khớp tiền về bank`,
        detail: `Tổng ${fmtVnd(total)} lượt QR máy chưa tìm thấy khoản ngân hàng khớp (±2 ngày). Ngày lệch nhiều nhất: ${dmy} (${fmtVnd(mu[top])}).`,
        hint: 'Nguyên nhân thường: (1) thiếu file sao kê kỳ đó → upload thêm PDF rồi đối soát lại; (2) tiền về trễ >2 ngày (nghỉ lễ) → chấp nhận, vẫn tính doanh thu. Số liệu KHÔNG sai, chỉ cần xác nhận.',
        jump_day: dmy,
      });
    }
    return { status: items.some(i => i.level === 'warn') ? 'warn' : 'ok', items };
  }

  function buildChecksMachine(p) {
    const items = [balanceItem(p.pdf_balances, p.bank_credit, p.bank_debit, 'sao kê')];
    const bu = p.bank_unmatched_by_day || {};
    if (p.has_machine && p.has_bank && Object.keys(bu).length) {
      const top = topDay(bu);
      const total = Object.values(bu).reduce((a, v) => a + v, 0);
      const dmy = isoToDmy(top);
      const thr = p.bank_credit ? Math.max(300000, Math.trunc(p.bank_credit * 0.05)) : 300000;
      items.push({
        level: total > thr ? 'warn' : 'ok', kind: 'qr_pending',
        title: `${Object.keys(bu).length} ngày có CK về bank chưa thấy lượt máy khớp`,
        detail: `Tổng ${fmtVnd(total)} CK về ngân hàng không tìm thấy lượt chụp máy cùng mệnh giá (±2 ngày). Ngày lệch nhiều nhất: ${dmy} (${fmtVnd(bu[top])}).`,
        hint: 'Máy MINIBOOTH ghi mọi lượt là tiền mặt. CK về bank mà máy KHÔNG có lượt tương ứng -> có thể nhân viên quên cho khách vào máy, hoặc CK không phải doanh thu chụp ảnh (khách chuyển nhầm/nạp khác). Soi các ngày này.',
        jump_day: dmy,
      });
    } else if (p.has_machine && p.has_bank) {
      items.push({
        level: 'ok', kind: 'qr_pending', title: 'Mọi CK về bank đều khớp lượt máy',
        detail: `Doanh thu máy ${fmtVnd(p.machine_total)}, trong đó ${fmtVnd(p.matched_ck)} khớp CK về bank — không có CK lạ.`,
        hint: '', jump_day: null,
      });
    }
    return { status: items.some(i => i.level === 'warn') ? 'warn' : 'ok', items };
  }

  // =====================================================================
  // ĐỐI SOÁT TOÀN KỲ — tương đương POST /api/reconcile
  // files: [{name, bytes:Uint8Array}] — route theo NỘI DUNG, không theo ô upload
  // =====================================================================
  async function reconcile(files, mode = 'bank', onProgress) {
    if (!files || !files.length) throw new Error('Phải cung cấp ít nhất 1 file (Excel hoặc PDF).');
    const machineRecords = [];
    const bankRecords = [];
    const pdfBalances = [];
    let k = 0;
    for (const f of files) {
      k += 1;
      if (onProgress) onProgress(`Đang đọc ${f.name} (${k}/${files.length})…`);
      if (!f.bytes || !f.bytes.length) continue;
      try {
        const r = await routeFile(f.bytes, f.name);
        if (r.kind === 'bank') {
          bankRecords.push(...r.records);
          pdfBalances.push(r.balances);
        } else {
          machineRecords.push(...r.records);
        }
      } catch (e) {
        throw new Error(`Lỗi đọc file '${f.name}': ${e.message || e}`);
      }
    }
    if (onProgress) onProgress('Đang đối soát…');

    mode = String(mode || 'bank').trim().toLowerCase();
    if (mode !== 'bank' && mode !== 'machine') mode = 'bank';
    const result = matchTransactions(machineRecords, bankRecords, mode);
    const { records, warnings, other_income: otherIncome, totals } = result;
    const oir = result.other_income_records || [];

    // Doanh thu chịu thuế = tiền mặt máy + CK khai (cả 2 mode cùng công thức)
    const taxableRevenue = totals.machine_cash + otherIncome;
    const verified = records.filter(r => r.status !== 'Máy ghi - chưa thấy về NH');
    const verifiedRevenue = verified.reduce((a, r) => a + r.amount, 0);
    const unverifiedRevenue = warnings.reduce((a, r) => a + r.amount, 0);

    const bankCreditByDay = {};
    for (const b of bankRecords) if ((b.amount || 0) > 0) addTo(bankCreditByDay, dayOf(b.time), b.amount);

    let bankNeo = {}, machineUnmatched = {}, boothNeo = {}, otherNeo = {};
    if (mode === 'bank') [bankNeo, machineUnmatched, boothNeo, otherNeo] = neoBankToMachineDay(machineRecords, bankRecords);

    // Sổ lưu chuyển tiền theo ngày
    const daily = {};
    const ensure = (d) => (daily[d] || (daily[d] = { cash: 0, transfer: 0, total: 0, expenses: [] }));
    if (mode === 'machine') {
      const transferByDay = {};
      for (const r of oir) {
        if (!r.is_loa) continue;
        const d = String(r.time || '').slice(0, 10);
        if (d) addTo(transferByDay, d, r.amount);
      }
      const machineByDay = {};
      for (const m of machineRecords) if (m.amount > 0) addTo(machineByDay, dayOf(m.time), m.amount);
      for (const [d, tot] of Object.entries(machineByDay)) {
        const tr = transferByDay[d] || 0;
        ensure(d).transfer += tr;
        ensure(d).cash += Math.max(0, tot - tr);
      }
    } else {
      for (const m of machineRecords) if (m.method === 'Tiền mặt') ensure(dayOf(m.time)).cash += m.amount;
      for (const r of oir) {
        if (!r.is_loa) continue;
        const d = String(r.time || '').slice(0, 10);
        if (d) ensure(d).transfer += r.amount;
      }
    }
    for (const d of Object.keys(daily)) daily[d].total = daily[d].cash + daily[d].transfer;

    // Góc nhìn MÁY theo ngày
    const machCashByDay = {}, machQrByDay = {};
    for (const m of machineRecords) {
      const d = dayOf(m.time);
      if (m.method === 'Tiền mặt') addTo(machCashByDay, d, m.amount);
      else if (m.method === 'Mã QR' && m.amount > 0) addTo(machQrByDay, d, m.amount);
    }

    // Sheet "CK ngân hàng theo ngày": ngày bank gốc; PTB hoặc khớp lượt QR máy ĐÚNG ngày
    const qrSlots = new Map();
    for (const m of machineRecords) if (m.method === 'Mã QR' && m.amount > 0) slotAdd(qrSlots, dayOf(m.time), m.amount, 1);
    const consumeSlot = (t, amt) => {
      const d = dayOf(t);
      if (slotGet(qrSlots, d, amt) > 0) { slotAdd(qrSlots, d, amt, -1); return true; }
      return false;
    };
    const bankPtbByDay = {}, bankOtherByDay = {};
    const pending = [];
    for (const b of bankRecords) {
      if (!((b.amount || 0) > 0)) continue;
      const d = dayOf(b.time);
      if (isMachineQr(b.description || '')) {
        addTo(bankPtbByDay, d, b.amount);
        consumeSlot(b.time, b.amount);
      } else {
        pending.push(b);
      }
    }
    for (const b of pending) {
      const d = dayOf(b.time);
      if (consumeSlot(b.time, b.amount)) addTo(bankPtbByDay, d, b.amount);
      else addTo(bankOtherByDay, d, b.amount);
    }

    // Chi tiêu (Ghi Nợ)
    for (const b of bankRecords) {
      if ((b.debit || 0) > 0) {
        const t = b.time || parseDayFirst(b.original_time);
        if (!t) continue;
        ensure(dayOf(t)).expenses.push({ amount: b.debit, description: b.description || '' });
      }
    }

    const dailyList = Object.keys(daily).sort().map(d => ({
      date: isoToDmy(d), cash: daily[d].cash, transfer: daily[d].transfer,
      total: daily[d].total, expenses: daily[d].expenses,
    }));

    let checks;
    if (mode === 'machine') {
      checks = buildChecksMachine({
        pdf_balances: pdfBalances, bank_credit: totals.bank_credit, bank_debit: totals.bank_debit,
        machine_total: totals.machine_total, matched_ck: otherIncome,
        bank_unmatched_by_day: result.bank_unmatched_by_day || {},
        has_machine: machineRecords.length > 0, has_bank: bankRecords.length > 0,
      });
    } else {
      checks = buildChecks({
        pdf_balances: pdfBalances, bank_credit: totals.bank_credit, bank_debit: totals.bank_debit,
        machine_qr: totals.machine_qr || 0, other_income: otherIncome,
        machine_unmatched_by_day: machineUnmatched, has_machine: machineRecords.length > 0,
        bank_machine_qr: oir.filter(r => r.is_machine_qr).reduce((a, r) => a + r.amount, 0),
      });
    }

    return {
      status: 'success',
      mode,
      summary: {
        total_machine: records.length,
        total_matched: verified.length,
        total_unmatched: warnings.length,
        total_revenue: taxableRevenue,
        machine_cash: totals.machine_cash,
        machine_qr: totals.machine_qr,
        machine_total: totals.machine_total || 0,
        booth_ck: totals.booth_ck || 0,
        other_biz_ck: totals.other_biz_ck || 0,
        bank_unmatched: totals.bank_unmatched || 0,
        total_matched_revenue: verifiedRevenue,
        total_unmatched_revenue: unverifiedRevenue,
        total_other_income: otherIncome,
        total_other_income_tx: otherIncome > 0 ? 1 : 0,
        bank_credit: totals.bank_credit,
        bank_debit: totals.bank_debit,
      },
      checks,
      daily_summary: dailyList,
      bank_credit_by_day: bankCreditByDay,
      bank_neo_by_day: bankNeo,
      booth_neo_by_day: boothNeo,
      other_neo_by_day: otherNeo,
      machine_unmatched_by_day: machineUnmatched,
      mach_cash_by_day: machCashByDay,
      mach_qr_by_day: machQrByDay,
      bank_ptb_by_day: bankPtbByDay,
      bank_other_by_day: bankOtherByDay,
      records,
      warnings,
      other_income: otherIncome,
      other_income_records: oir,
    };
  }

  root.TaxEngine = {
    reconcile,
    // để kiểm thử
    _t: { parseDayFirst, parseMachineExcel, readSheetRows, readPdfPages, parseMbPdfPages, parseMbPdfBalances, routeFile, matchTransactions },
  };
})(typeof window !== 'undefined' ? window : globalThis);

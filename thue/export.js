/* Noir Tax — xuất Excel trong trình duyệt (port từ TAX APP exporter.py).
 *  - buildS2A        : tờ khai S2A-HKD chi tiết, mỗi ngày 1 sheet (dùng mẫu thuế thật)
 *  - buildTaxDecl    : tờ khai S2A-HKD gọn 1 sheet cả kỳ (mẫu thuế thật)
 *  - buildDailyReport: báo cáo nội bộ theo ngày (4 sheet, không dùng mẫu)
 *
 * Mẫu S2A được mô phỏng thành MẢNG DÒNG rồi chèn/xóa dòng y như openpyxl
 * (insert_rows/delete_rows) để ra đúng bố cục bản Python; sau đó mới ghi ra sheet.
 * Cần ExcelJS trên globalThis.TaxLibs (hoặc window).
 */
(function (root) {
  'use strict';

  const lib = (name) => {
    const libs = root.TaxLibs || {};
    const v = libs[name] || root[name];
    if (!v) throw new Error(`Thiếu thư viện ${name}.`);
    return v;
  };

  const TNR = () => ({ name: 'Times New Roman', size: 12 });
  const THIN = () => ({ top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } });
  const MONEY = '#,##0';
  const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));

  // "%g" của Python: 3.0 -> '3', 1.5 -> '1.5'
  const fmtNum = (r) => String(Number.parseFloat(Number(r).toPrecision(6)));
  const fmtRate = (r) => fmtNum(r) + '%';
  // ROUND của Excel: nửa làm tròn ra xa số 0
  const xlRound = (x) => Math.sign(x) * Math.round(Math.abs(x) + 1e-9);

  // ---------- Mẫu S2A dạng mảng dòng ----------
  const MAX_COL = 4;   // mẫu chỉ dùng A–D

  function sheetToRows(ws) {
    const rows = [];
    for (let r = 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const cells = [];
      for (let c = 1; c <= MAX_COL; c++) {
        const cell = row.getCell(c);
        const isSlave = cell.isMerged && cell.master && cell.master.address !== cell.address;
        cells.push({ value: isSlave ? null : clone(cell.value), style: clone(cell.style) || {} });
      }
      rows.push({ height: row.height, cells });
    }
    return rows;
  }

  function cellText(rows, r, c) {          // str(cell.value) của Python (None -> 'None')
    const row = rows[r - 1];
    const cell = row && row.cells[c - 1];
    const v = cell ? cell.value : null;
    if (v == null) return 'None';
    if (typeof v === 'object') {
      if (v.richText) return v.richText.map(t => t.text).join('');
      if (v.formula) return '=' + v.formula;
      if (v.text != null) return String(v.text);
    }
    return String(v);
  }
  const hasValue = (rows, r, c) => { const cell = rows[r - 1] && rows[r - 1].cells[c - 1]; return !!(cell && cell.value != null && cell.value !== ''); };

  function findRowByText(rows, text, { col = 3, start = 1, exact = false } = {}) {
    const target = text.toLowerCase();
    for (let r = Math.max(1, start); r <= rows.length; r++) {
      if (!hasValue(rows, r, col)) continue;
      const v = cellText(rows, r, col).trim().toLowerCase();
      if (exact ? v === target : v.includes(target)) return r;
    }
    return null;
  }

  function cellAt(rows, r, c) {
    while (rows.length < r) rows.push({ height: null, cells: [] });
    const row = rows[r - 1];
    while (row.cells.length < c) row.cells.push(null);
    if (!row.cells[c - 1]) row.cells[c - 1] = { value: null, style: {} };
    return row.cells[c - 1];
  }
  function setCell(rows, r, c, value, style) {
    const cell = cellAt(rows, r, c);
    if (value !== undefined) cell.value = value;
    if (style) Object.assign(cell.style, style);   // gán đè từng thuộc tính như openpyxl
    return cell;
  }
  const insertRows = (rows, at, n) => rows.splice(at - 1, 0, ...Array.from({ length: n }, () => ({ height: null, cells: [] })));
  const deleteRows = (rows, at, n) => rows.splice(at - 1, n);

  // Điền thông tin người nộp thuế (nối sau nhãn có sẵn, giữ nguyên format mẫu)
  function fillHeader(rows, meta) {
    meta = meta || {};
    const append = (r, c, key) => {
      const v = String(meta[key] || '').trim();
      if (!v) return;
      const label = hasValue(rows, r, c) ? cellText(rows, r, c).replace(/\s+$/, '') : '';
      setCell(rows, r, c, label ? `${label} ${v}` : v);
    };
    append(1, 1, 'business_name');
    append(2, 1, 'address');
    append(3, 1, 'tax_code');
    append(5, 1, 'location');
    append(6, 1, 'period');
    const unit = String(meta.unit || 'VNĐ').trim();
    const d7 = (hasValue(rows, 7, 4) ? cellText(rows, 7, 4) : 'Đơn vị tính:').replace(/\s+$/, '');
    setCell(rows, 7, 4, `${d7} ${unit}`);
    const sign = String(meta.sign_date || '').trim();
    if (sign) setCell(rows, 189, 4, sign);
  }

  // Bước chung của 2 tờ khai: tên ngành, chèn dòng dữ liệu, xóa dòng thừa + ngành 2..5,
  // công thức tổng/thuế, ép chiều cao dòng phần chữ ký. writeRows: [{no, date, desc, amount}]
  function layoutS2A(rows, writeRows, industryName, gRate, tRate) {
    let anchor = findRowByText(rows, '1. ngành nghề');
    if (!anchor) anchor = 7;
    else setCell(rows, anchor, 3, `1. Ngành nghề: ${industryName}`);

    const start = anchor + 1;
    const n = writeRows.length;
    const center = { horizontal: 'center', vertical: 'middle' };
    if (n > 0) {
      insertRows(rows, start, n);
      writeRows.forEach((wr, i) => {
        const r = start + i;
        rows[r - 1].height = 28.5;
        setCell(rows, r, 1, wr.no, { border: THIN(), font: TNR(), alignment: center });
        setCell(rows, r, 2, wr.date, { border: THIN(), font: TNR(), alignment: center });
        setCell(rows, r, 3, wr.desc, { border: THIN(), font: TNR(), alignment: { horizontal: 'left', vertical: 'middle', wrapText: true } });
        setCell(rows, r, 4, wr.amount, { border: THIN(), font: TNR(), alignment: { horizontal: 'right', vertical: 'middle' }, numFmt: MONEY });
      });
    }
    const last = n > 0 ? start + n - 1 : anchor;

    // Xóa dòng trống thừa của mẫu (giữa dữ liệu và "Tổng cộng (1)")
    const tmp = findRowByText(rows, 'tổng cộng (1)', { start: last });
    if (tmp && tmp > last + 1) deleteRows(rows, last + 1, tmp - last - 1);

    // Xóa ngành nghề 2..5 không dùng (duyệt ngược)
    for (let s = 5; s >= 2; s--) {
      const delStart = findRowByText(rows, `${s}. ngành nghề`, { start: last });
      if (!delStart) continue;
      const tc = findRowByText(rows, `tổng cộng (${s})`, { start: delStart });
      if (!tc) continue;
      let end = null;
      for (let r = tc; r < Math.min(tc + 5, rows.length + 1); r++) {
        if (cellText(rows, r, 3).toLowerCase().includes('thuế tncn')) { end = r; break; }
      }
      deleteRows(rows, delStart, end ? end - delStart + 1 : tc - delStart + 1);
    }

    // Tổng cộng (1) + thuế suất + thuế phải nộp
    const totalRow = findRowByText(rows, 'tổng cộng (1)', { start: last });
    const rateG = findRowByText(rows, 'thuế gtgt', { start: last, exact: true });
    const rateT = findRowByText(rows, 'thuế tncn', { start: last, exact: true });
    const sumG = findRowByText(rows, 'tổng số thuế gtgt phải nộp', { start: last });
    const sumT = findRowByText(rows, 'tổng số thuế tncn phải nộp', { start: last });
    const right = { horizontal: 'right', vertical: 'middle' };
    const total = writeRows.reduce((a, w) => a + (Number(w.amount) || 0), 0);
    if (totalRow) {
      if (n > 0) setCell(rows, totalRow, 4, { formula: `SUM(D${start}:D${last})`, result: total });
      setCell(rows, totalRow, 4, undefined, { numFmt: MONEY, font: TNR(), alignment: right });
    }
    if (rateG) setCell(rows, rateG, 4, fmtRate(gRate), { font: TNR(), alignment: right });
    if (rateT) setCell(rows, rateT, 4, fmtRate(tRate), { font: TNR(), alignment: right });
    if (totalRow && sumG) {
      setCell(rows, sumG, 4, { formula: `ROUND(D${totalRow}*${fmtNum(gRate)}/100, 0)`, result: xlRound(total * gRate / 100) },
        { numFmt: MONEY, font: TNR(), alignment: right });
    }
    if (totalRow && sumT) {
      setCell(rows, sumT, 4, { formula: `ROUND(D${totalRow}*${fmtNum(tRate)}/100, 0)`, result: xlRound(total * tRate / 100) },
        { numFmt: MONEY, font: TNR(), alignment: right });
    }

    // Ép chiều cao dòng phần dưới (sau khi xóa dòng)
    for (let r = last + 1; r <= rows.length; r++) {
      const combined = (cellText(rows, r, 3) + ' ' + cellText(rows, r, 4)).toLowerCase();
      if (combined.includes('người đại diện')) rows[r - 1].height = 31.5;
      else if (combined.includes('ngày') && combined.includes('tháng') && combined.includes('năm')) rows[r - 1].height = 21.75;
      else rows[r - 1].height = 15.75;
    }
  }

  // Ghi mảng dòng ra 1 sheet mới, chép khung sheet mẫu (cột, ô gộp, trang in)
  function writeTemplateSheet(wb, base, name, rows) {
    const ws = wb.addWorksheet(name, {
      properties: clone(base.properties),
      pageSetup: clone(base.pageSetup),
      views: clone(base.views),
    });
    for (let c = 1; c <= MAX_COL + 1; c++) {
      const src = base.getColumn(c);
      const dst = ws.getColumn(c);
      if (src.width) dst.width = src.width;
      if (src.hidden) dst.hidden = true;
    }
    // Ô gộp của mẫu đều nằm ở phần đầu (hàng 1–9), trên vùng chèn -> giữ nguyên.
    // Gộp TRƯỚC rồi mới gán style, để ô phụ trong vùng gộp giữ style của mẫu.
    for (const m of (base.model.merges || [])) ws.mergeCells(m);
    rows.forEach((row, i) => {
      const r = ws.getRow(i + 1);
      if (row.height != null) r.height = row.height;
      row.cells.forEach((cell, j) => {
        if (!cell) return;
        const dst = r.getCell(j + 1);
        if (cell.value != null) dst.value = clone(cell.value);
        if (cell.style && Object.keys(cell.style).length) dst.style = clone(cell.style);
      });
    });
    return ws;
  }

  async function loadTemplate(templateBytes) {
    const ExcelJS = lib('ExcelJS');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(templateBytes);
    return { wb, base: wb.worksheets[0] };
  }

  const toDmy = (t) => { const [y, m, d] = String(t).slice(0, 10).split('-'); return `${d}/${m}/${y}`; };
  const toDmyDash = (t) => { const [y, m, d] = String(t).slice(0, 10).split('-'); return `${d}-${m}-${y}`; };
  const dashToIso = (s) => { const [d, m, y] = s.split('-'); return `${y}-${m}-${d}`; };

  // =====================================================================
  // TỜ KHAI S2A-HKD CHI TIẾT — mỗi ngày 1 sheet
  // =====================================================================
  async function buildS2A(templateBytes, p) {
    const gRate = Number(p.gtgt_rate != null ? p.gtgt_rate : 3);
    const tRate = Number(p.tncn_rate != null ? p.tncn_rate : 1.5);
    const industry = p.industry_name || 'Dịch vụ chụp ảnh có in hình';
    const { wb, base } = await loadTemplate(templateBytes);
    const baseRows = sheetToRows(base);
    fillHeader(baseRows, p.meta);

    const grouped = new Map();      // 'DD-MM-YYYY' -> [records]
    for (const r of (p.records || []).slice().sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0))) {
      const k = toDmyDash(r.time);
      if (!grouped.has(k)) grouped.set(k, []);
      grouped.get(k).push(r);
    }
    // Mỗi khoản CK khai = 1 dòng vào đúng ngày của nó
    const oiByDay = new Map();
    for (const o of (p.other_income_records || [])) {
      const k = toDmyDash(o.time);
      const custom = String(o.custom_desc || '').trim();
      if (!oiByDay.has(k)) oiByDay.set(k, []);
      oiByDay.get(k).push({
        date: toDmy(o.time), desc: custom ? custom.slice(0, 120) : 'Tiền chuyển khoản chụp ảnh',
        amount: Math.trunc(o.amount), ck_amount: Math.trunc(o.amount),
      });
    }
    for (const k of oiByDay.keys()) if (!grouped.has(k)) grouped.set(k, []);
    const days = [...grouped.keys()].sort((a, b) => (dashToIso(a) < dashToIso(b) ? -1 : 1));

    let pt = 1;
    for (const day of days) {
      const dayRecords = grouped.get(day);
      const extra = oiByDay.get(day) || [];
      // Mặt-bù (is_fill) dán ngay dưới dòng CK cùng mệnh giá; còn lại là lượt máy
      const fillPool = new Map();
      const machineRows = [];
      for (const r of dayRecords) {
        if (r.method === 'Tiền mặt' && r.is_fill) {
          const k = Math.trunc(r.fill_ck || 0);
          if (!fillPool.has(k)) fillPool.set(k, []);
          fillPool.get(k).push({ date: toDmy(r.time), desc: 'Tiền mặt bù lượt chụp ảnh', amount: r.amount, is_fill: true });
        } else {
          machineRows.push({ date: toDmy(r.time), desc: r.method === 'Tiền mặt' ? 'Tiền mặt chụp ảnh' : 'Tiền chuyển khoản chụp ảnh', amount: r.amount });
        }
      }
      const write = machineRows.slice();
      for (const er of extra) {
        write.push(er);
        const fills = fillPool.get(Math.trunc(er.ck_amount != null ? er.ck_amount : -1));
        if (fills && fills.length) write.push(fills.shift());
      }
      for (const left of fillPool.values()) write.push(...left);
      // Mặt-bù để trống số hiệu, không tăng bộ đếm PT
      for (const w of write) {
        if (w.is_fill) w.no = '';
        else { w.no = `PT${String(pt).padStart(3, '0')}`; pt += 1; }
      }
      const rows = clone(baseRows);
      layoutS2A(rows, write, industry, gRate, tRate);
      writeTemplateSheet(wb, base, day, rows);
    }
    wb.removeWorksheet(base.id);
    if (!wb.worksheets.length) wb.addWorksheet('Empty').getCell(1, 1).value = 'Không có dữ liệu';
    return wb.xlsx.writeBuffer();
  }

  // =====================================================================
  // TỜ KHAI S2A-HKD GỌN 1 SHEET CẢ KỲ — mỗi ngày tối đa 2 dòng (mặt / CK)
  // =====================================================================
  const dmyToIso = (dmy) => { const p = String(dmy || '').split('/'); return p.length === 3 ? `${p[2]}-${p[1].padStart(2, '0')}-${p[0].padStart(2, '0')}` : ''; };
  const isoToDmy = (iso) => { const p = String(iso || '').split('-'); return p.length === 3 ? `${p[2].padStart(2, '0')}/${p[1].padStart(2, '0')}/${p[0]}` : String(iso || ''); };

  async function buildTaxDecl(templateBytes, p) {
    const gRate = Number(p.gtgt_rate != null ? p.gtgt_rate : 3);
    const tRate = Number(p.tncn_rate != null ? p.tncn_rate : 1.5);
    const industry = p.industry_name || 'Dịch vụ chụp ảnh có in hình';
    const neo = p.bank_ck_neo_by_day || {};
    const cash = {}, transfer = {};
    for (const d of (p.daily_summary || [])) {
      const iso = dmyToIso(d.date);
      if (!iso) continue;
      cash[iso] = Math.trunc(d.cash || 0);
      transfer[iso] = Math.trunc(d.transfer || 0);
    }
    const allIso = [...new Set([...Object.keys(cash), ...Object.keys(transfer), ...Object.keys(neo)])].sort();
    const write = [];
    for (const iso of allIso) {
      const dmy = isoToDmy(iso);
      const c = Math.trunc(cash[iso] || 0);
      const t = Math.trunc(transfer[iso] || neo[iso] || 0);
      if (c > 0) write.push({ date: dmy, desc: 'Tiền mặt chụp ảnh', amount: c });
      if (t > 0) write.push({ date: dmy, desc: 'Tiền chuyển khoản chụp ảnh', amount: t });
    }
    write.forEach((w, i) => { w.no = `PT${String(i + 1).padStart(3, '0')}`; });

    const { wb, base } = await loadTemplate(templateBytes);
    const rows = sheetToRows(base);
    fillHeader(rows, p.meta);
    layoutS2A(rows, write, industry, gRate, tRate);
    writeTemplateSheet(wb, base, 'Ke khai S2A', rows);
    wb.removeWorksheet(base.id);
    return wb.xlsx.writeBuffer();
  }

  // =====================================================================
  // BÁO CÁO THEO NGÀY — workbook riêng, 4 sheet
  // =====================================================================
  async function buildDailyReport(p) {
    const ExcelJS = lib('ExcelJS');
    const meta = p.meta || {};
    const selfbooth = p.selfbooth_records || [];
    const bankPtb = p.bank_ptb_by_day || {};
    const bankOther = p.bank_other_by_day || {};
    const tnr = TNR();
    const tnrBold = { name: 'Times New Roman', size: 12, bold: true };
    const sub = { name: 'Times New Roman', size: 10, italic: true, color: { argb: 'FF71717A' } };
    const center = { horizontal: 'center', vertical: 'middle' };
    const right = { horizontal: 'right', vertical: 'middle' };
    const left = { horizontal: 'left', vertical: 'middle' };
    const headCell = { horizontal: 'center', vertical: 'middle', wrapText: true };
    const businessName = String(meta.business_name || '').trim();
    const period = String(meta.period || '').trim();

    const wb = new ExcelJS.Workbook();
    const put = (ws, r, c, value, font, alignment, money, border = true) => {
      const cell = ws.getCell(r, c);
      cell.value = value;
      if (font) cell.font = clone(font);
      if (border) cell.border = THIN();
      if (alignment) cell.alignment = clone(alignment);
      if (money) cell.numFmt = MONEY;
      return cell;
    };
    const docHeader = (ws, title, lastCol) => {
      ws.mergeCells(1, 1, 1, lastCol);
      put(ws, 1, 1, title, { name: 'Times New Roman', size: 14, bold: true }, center, false, false);
      let r = 2;
      if (businessName) { ws.mergeCells(r, 1, r, lastCol); put(ws, r, 1, `Hộ/Cá nhân kinh doanh: ${businessName}`, tnr, left, false, false); r += 1; }
      if (period) { ws.mergeCells(r, 1, r, lastCol); put(ws, r, 1, `Kỳ: ${period}`, tnr, left, false, false); r += 1; }
      return r + 1;
    };
    const finish = (ws, widths, headerRow, dataStart) => {
      widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
      ws.getRow(headerRow).height = 28.5;
      ws.views = [{ state: 'frozen', xSplit: 0, ySplit: dataStart - 1, topLeftCell: `A${dataStart}` }];
    };

    // ---- Sheet 1 & 2: theo ngày (góc nhìn máy) ----
    const headers = ['Ngày', 'Tiền mặt', 'CK photobooth', 'DT khác CK', 'Tổng thu', 'Chi tiêu', 'Thu ròng'];
    const widths = [13, 16, 16, 16, 16, 28, 16];
    const buildDaily = (ws, title, withDetail) => {
      const headerRow = docHeader(ws, title, headers.length);
      headers.forEach((h, i) => put(ws, headerRow, i + 1, h, tnrBold, headCell));
      let row = headerRow + 1;
      const dataStart = row;
      let gCash = 0, gBooth = 0, gOther = 0, gTotal = 0, gExp = 0;
      for (const day of (p.daily_summary || [])) {
        const cash = Math.trunc(day.cash || 0);
        const booth = Math.trunc(day.booth || 0);
        const other = Math.trunc(day.other || 0);
        const total = Math.trunc(day.total != null ? day.total : cash + booth);
        const expenses = day.expenses || [];
        const expSum = expenses.reduce((a, e) => a + Math.trunc(e.amount || 0), 0);
        gCash += cash; gBooth += booth; gOther += other; gTotal += total; gExp += expSum;
        [day.date || '', cash, booth, other, total, expSum, total - expSum].forEach((v, i) =>
          put(ws, row, i + 1, v, tnr, i === 0 ? center : right, i > 0));
        row += 1;
        if (withDetail) {
          for (const e of expenses) {
            const desc = String(e.description || '').trim();
            put(ws, row, 1, '', null, null, false);
            put(ws, row, 2, `  - Chi: ${desc.slice(0, 80)}`, sub, left, false);
            ws.mergeCells(row, 2, row, 5);
            for (let c = 2; c <= 5; c++) ws.getCell(row, c).border = THIN();
            put(ws, row, 6, Math.trunc(e.amount || 0), sub, right, true);
            ws.getCell(row, 7).border = THIN();
            row += 1;
          }
        }
      }
      put(ws, row, 1, 'TỔNG CỘNG', tnrBold, center, false);
      [gCash, gBooth, gOther, gTotal, gExp, gTotal - gExp].forEach((v, i) => put(ws, row, i + 2, v, tnrBold, right, true));
      finish(ws, widths, headerRow, dataStart);
    };
    buildDaily(wb.addWorksheet('Theo ngày'), 'BẢNG KÊ DOANH THU - CHI TIÊU THEO NGÀY', true);
    buildDaily(wb.addWorksheet('Tóm tắt theo ngày'), 'BẢNG KÊ DOANH THU - CHI TIÊU THEO NGÀY (TÓM TẮT)', false);

    // ---- Sheet 3: doanh thu selfbooth CK — từng giao dịch ----
    {
      const ws = wb.addWorksheet('Doanh thu selfbooth CK');
      const hs = ['Thời gian', 'Số tiền', 'Nội dung chuyển khoản'];
      const headerRow = docHeader(ws, 'BẢNG KÊ DOANH THU SELFBOOTH CHUYỂN KHOẢN', hs.length);
      hs.forEach((h, i) => put(ws, headerRow, i + 1, h, tnrBold, headCell));
      let row = headerRow + 1;
      const dataStart = row;
      let grand = 0;
      for (const r of selfbooth) {
        const amount = Math.trunc(r.amount || 0);
        grand += amount;
        put(ws, row, 1, String(r.time || '').trim(), tnr, center, false);
        put(ws, row, 2, amount, tnr, right, true);
        put(ws, row, 3, String(r.description || '').trim(), tnr, { horizontal: 'left', vertical: 'middle', wrapText: true }, false);
        row += 1;
      }
      put(ws, row, 1, 'TỔNG CỘNG', tnrBold, center, false);
      put(ws, row, 2, grand, tnrBold, right, true);
      ws.getCell(row, 3).border = THIN();
      finish(ws, [20, 16, 60], headerRow, dataStart);
    }

    // ---- Sheet 4: CK ngân hàng theo ngày (ngày bank gốc) ----
    {
      const ws = wb.addWorksheet('CK ngân hàng theo ngày');
      const hs = ['Ngày', 'CK từ máy (nội dung PTB)', 'Doanh thu khác'];
      const headerRow = docHeader(ws, 'BẢNG KÊ CHUYỂN KHOẢN NGÂN HÀNG THEO NGÀY (BANK GỐC)', hs.length);
      hs.forEach((h, i) => put(ws, headerRow, i + 1, h, tnrBold, headCell));
      let row = headerRow + 1;
      const dataStart = row;
      const days = [...new Set([...Object.keys(bankPtb), ...Object.keys(bankOther)])].sort();
      let gB = 0, gO = 0;
      for (const d of days) {
        const b = Math.trunc(bankPtb[d] || 0), o = Math.trunc(bankOther[d] || 0);
        gB += b; gO += o;
        put(ws, row, 1, isoToDmy(d), tnr, center, false);
        put(ws, row, 2, b, tnr, right, true);
        put(ws, row, 3, o, tnr, right, true);
        row += 1;
      }
      put(ws, row, 1, 'TỔNG CỘNG', tnrBold, center, false);
      put(ws, row, 2, gB, tnrBold, right, true);
      put(ws, row, 3, gO, tnrBold, right, true);
      row += 1;
      for (const line of [
        'Lấy THẲNG từ sao kê ngân hàng, theo NGÀY GỐC (không dịch/neo). CK từ máy = khoản có nội dung PTB/mã máy (Qaj/CASSO).',
        "Doanh thu khác = mọi CK còn lại. Dùng để đối chiếu tiền bank thực với máy báo (so cột 'CK từ máy' sheet này vs 'CK photobooth' sheet Theo ngày).",
      ]) {
        ws.mergeCells(row, 1, row, hs.length);
        put(ws, row, 1, line, sub, { horizontal: 'left', vertical: 'middle', wrapText: true }, false, false);
        row += 1;
      }
      finish(ws, [14, 34, 20], headerRow, dataStart);
    }
    return wb.xlsx.writeBuffer();
  }

  root.TaxExport = { buildS2A, buildTaxDecl, buildDailyReport };
})(typeof window !== 'undefined' ? window : globalThis);

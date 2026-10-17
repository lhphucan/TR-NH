/* Noir Tax — giao diện (bản web TR-NH). Logic như TAX APP Python cũ nhưng đối soát +
   xuất Excel chạy ngay trong trình duyệt (engine.js, export.js) — file không rời máy. */

// ---- State ----
let currentRecords = [];
let currentWarnings = [];
let currentOtherIncomeRecords = [];   // tất cả khoản thu nhập khác, mỗi khoản có is_loa
let currentMachineTotal = 0;          // doanh thu máy (summary.total_revenue)
let currentDailySummary = [];          // số liệu theo ngày (cho xuất báo cáo riêng)
let currentBankCreditByDay = {};       // tổng CK ngân hàng (credit) theo ngày NH ghi nhận (YYYY-MM-DD), từ PDF gốc
let currentBankNeoByDay = {};          // TỔNG CK ngân hàng đã NEO về ngày máy (booth+khác)
let currentBoothNeoByDay = {};         // CK PHOTOBOOTH đã neo (khớp lượt máy) — so máy từng ngày
let currentOtherNeoByDay = {};         // CK DOANH THU KHÁC (không khớp máy), cùng kiểu ngày
let currentMachCashByDay = {};         // TIỀN MẶT máy theo ngày (nguồn máy)
let currentMachQrByDay = {};           // CK photobooth = lượt QR MÁY theo ngày (nguồn máy)
let currentBankPtbByDay = {};          // CK bank có PTB/mã máy, NGÀY GỐC (sheet CK)
let currentBankOtherByDay = {};        // CK bank còn lại, NGÀY GỐC (sheet CK)
let confirmedIdx = new Set();         // index khoản KHÔNG-loa được user tick đưa vào
let nonLoaIndices = [];               // index các khoản không-loa (cho chọn tất cả)
let ledgerFilter = 'all';
let ledgerQuery = '';
let priceList = [];                    // bảng giá lượt chụp (mảng số), từ ô nhập
let fillPrice = {};                    // {index CK lạ -> giá lượt đã chọn để bù mặt}
const PRICE_STORE = 'pn_price_list';
let currentMode = 'bank';              // 'bank' = máy có QR (MB); 'machine' = máy không QR (MINIBOOTH)
let fillLocked = false;                // đã KHÓA phân bổ bù theo tổng (không random lại)
const FILL_STORE = 'pn_fill_alloc';    // lưu {sig, target, seed, prices:{oiKey->giá}} cố định

// ---- Helpers ----
const $ = (id) => document.getElementById(id);
const fmt = (n) => new Intl.NumberFormat('vi-VN').format(Math.round(n || 0));
const fmtMoney = (n) => fmt(n) + ' đ';
// Màu số tiền theo phương thức (style.css .m-tm / .m-ck): tiền mặt cam, chuyển khoản xanh lá
const mauPT = (m) => (m === 'Tiền mặt' ? 'm-tm' : 'm-ck');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let toastTimer;
function toast(msg, isErr = false) {
  const t = $('toast');
  const icon = isErr
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
  t.innerHTML = icon + '<span>' + esc(msg) + '</span>';
  t.classList.toggle('err', isErr);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3600);
}

// ---- Số ngày kê khai = số ngày phát sinh chứng từ (khớp số sheet trong file xuất) ----
// Mô hình tiền-theo-bank: doanh thu = TIỀN MẶT máy + CK bank khai. QR máy KHÔNG cộng
// (đã nằm trong CK bank) -> chỉ lấy record 'Tiền mặt' từ máy.
function cashRecords(records) {
  return (records || []).filter(r => r.method === 'Tiền mặt');
}

function countDays(records, oiRecords) {
  const days = new Set();
  cashRecords(records).forEach(r => days.add(String(r.time || '').slice(0, 10)));
  oiRecords.forEach(r => days.add(String(r.time || '').slice(0, 10)));
  days.delete('');
  return days.size;
}

// ---- Thuế: làm tròn THEO TỪNG NGÀY để khớp CHÍNH XÁC file Excel xuất ra ----
// Base mỗi ngày = tiền mặt máy + CK bank khai + tiền mặt BÙ (lượt CK trả thiếu).
function computeTax(records, oiIncluded, gRate, tRate, fillByDay) {
  const dayBase = {};
  const add = (time, amt) => {
    const d = String(time || '').slice(0, 10);
    if (d) dayBase[d] = (dayBase[d] || 0) + (amt || 0);
  };
  cashRecords(records).forEach(r => add(r.time, r.amount));
  oiIncluded.forEach(r => add(r.time, r.amount));
  Object.entries(fillByDay || {}).forEach(([d, amt]) => { if (d) dayBase[d] = (dayBase[d] || 0) + amt; });
  let base = 0, gtgt = 0, tncn = 0;
  Object.values(dayBase).forEach(b => {
    base += b;
    gtgt += Math.round(b * gRate / 100);
    tncn += Math.round(b * tRate / 100);
  });
  return { base, gtgt, tncn, total: gtgt + tncn };
}

// % thuế người dùng nhập (>=0)
function getRate(id, fallback) {
  const v = parseFloat($(id).value);
  return (isFinite(v) && v >= 0) ? v : fallback;
}
// Khoản thu nhập khác ĐƯỢC TÍNH vào kê khai: loa (auto) + non-loa đã tick
function includedOI() {
  return currentOtherIncomeRecords.filter((r, i) => r.is_loa || confirmedIdx.has(i));
}

// ---- Bảng giá lượt chụp (để bù tiền mặt cho CK trả thiếu) ----
function parsePriceList(str) {
  return String(str || '')
    .split(/[,;\s]+/)
    .map(s => parseInt(s.replace(/[^\d]/g, ''), 10))
    .filter(n => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
}
function loadPriceList() {
  try {
    const s = localStorage.getItem(PRICE_STORE) || '';
    if (s && $('priceList')) $('priceList').value = s;
    priceList = parsePriceList(s);
  } catch (_) { priceList = []; }
}
function savePriceList() {
  try { localStorage.setItem(PRICE_STORE, $('priceList').value.trim()); } catch (_) {}
}
// CK cần bù = mệnh giá NHỎ HƠN giá lượt lớn nhất (còn giá cao hơn nó để bù lên đủ lượt).
// CK >= giá lớn nhất -> không bù (chỉ tick khai thẳng). Kể cả CK đúng bằng 1 mức giá
// (vd 60k) vẫn cho bù LÊN lượt cao hơn (vd 120k) — theo yêu cầu MINIBOOTH.
function isOddCk(amount) {
  if (!priceList.length) return false;
  return amount < priceList[priceList.length - 1];   // nhỏ hơn lượt lớn nhất -> bù được
}
// Giá bù cho 1 khoản CK lạ. Chỉ bù nếu là CK lạ (trả thiếu). Trả giá lượt (> CK) hoặc null.
function pickFillPrice(ckAmount, mode) {
  if (!isOddCk(ckAmount)) return null;               // không phải CK trả thiếu -> không bù
  const cands = priceList.filter(p => p > ckAmount); // giá lượt LỚN HƠN CK (để bù dương)
  if (!cands.length) return null;
  if (mode === 'random') return cands[Math.floor(Math.random() * cands.length)];
  return cands[0];   // manual mặc định giá nhỏ nhất > CK (user đổi qua dropdown)
}
// Tổng tiền mặt bù (từ các CK lạ đã tick + đã chọn giá lượt)
function cashFillTotal() {
  let sum = 0;
  currentOtherIncomeRecords.forEach((r, i) => {
    if (confirmedIdx.has(i) && fillPrice[i] && fillPrice[i] > r.amount) {
      sum += (fillPrice[i] - r.amount);
    }
  });
  return sum;
}
// Tiền mặt bù theo ngày {YYYY-MM-DD -> tiền} (để tính thuế làm tròn theo ngày)
function cashFillByDay() {
  const map = {};
  currentOtherIncomeRecords.forEach((r, i) => {
    if (confirmedIdx.has(i) && fillPrice[i] && fillPrice[i] > r.amount) {
      const d = String(r.time || '').slice(0, 10);
      if (d) map[d] = (map[d] || 0) + (fillPrice[i] - r.amount);
    }
  });
  return map;
}

// ==========================================================================
// PHÂN BỔ TIỀN BÙ THEO TỔNG MONG MUỐN (khóa cố định, lưu để in lại y hệt)
// ==========================================================================
// Key ổn định 1 khoản CK (không dùng index vì upload lại có thể đổi thứ tự).
function oiKey(r) {
  return `${String(r.time || '').slice(0, 19)}|${r.amount}`;
}
// Các khoản CK LẠ đã TICK (có thể bù). Trả [{i, r, cands:[giá bù dương...]}].
function fillableTicked() {
  const out = [];
  currentOtherIncomeRecords.forEach((r, i) => {
    if (!confirmedIdx.has(i)) return;
    if (!isOddCk(r.amount)) return;
    const cands = priceList.filter(p => p > r.amount);   // giá lượt > CK -> bù dương
    if (cands.length) out.push({ i, r, cands });
  });
  return out;
}
// Trần bù (tổng lớn nhất) = Σ max(giá−CK); Sàn bù (nhỏ nhất, PHỦ HẾT mọi lượt) =
// Σ min(giá−CK) trên các lượt đã tick. Bù HẾT + đúng tổng chỉ được khi target ∈ [sàn, trần].
function fillCeiling() {
  return fillableTicked().reduce((a, x) => a + (Math.max(...x.cands) - x.r.amount), 0);
}
function fillFloor() {
  return fillableTicked().reduce((a, x) => a + (Math.min(...x.cands) - x.r.amount), 0);
}
// Phân bổ giá bù cho MỌI lượt đã tick (PHỦ HẾT, không bỏ sót) sao cho Σ(giá−CK) = target.
// Cách: khởi tạo mỗi lượt = giá NHỎ NHẤT > CK (tổng = sàn). Còn thiếu (target − sàn) thì
// nâng dần giá từng lượt lên mức cao hơn cho tới khi đủ. Random CÓ SEED để lặp y hệt.
// Trả {prices, filled, floor, ceil}. Chỉ đạt ĐÚNG target khi sàn ≤ target ≤ trần.
function allocFillByTarget(target, seed) {
  const rng = seededRng(seed);
  const items = fillableTicked();
  if (!items.length) return { prices: {}, filled: 0, floor: 0, ceil: 0 };
  // xáo trộn thứ tự lượt theo seed (khóa lại vẫn y hệt)
  for (let k = items.length - 1; k > 0; k--) {
    const j = Math.floor(rng() * (k + 1));
    [items[k], items[j]] = [items[j], items[k]];
  }
  // mỗi lượt: danh sách gain TĂNG DẦN (giá−CK), để nâng bậc
  const slots = items.map(it => {
    const gains = it.cands.map(p => ({ p, gain: p - it.r.amount }))
      .filter(x => x.gain > 0).sort((a, b) => a.gain - b.gain);
    return { i: it.i, gains, lvl: 0 };   // lvl 0 = giá nhỏ nhất (sàn)
  });
  const floor = slots.reduce((a, s) => a + s.gains[0].gain, 0);
  const ceil = slots.reduce((a, s) => a + s.gains[s.gains.length - 1].gain, 0);

  let filled = floor;   // bắt đầu ở sàn (mọi lượt đã có giá nhỏ nhất -> PHỦ HẾT)
  // Nâng bậc để tiến tới target mà KHÔNG vượt. Duyệt lặp: mỗi vòng chọn 1 lượt còn
  // nâng được + bước nâng không vượt remain, ưu tiên bước LỚN NHẤT vừa remain.
  let guard = 0;
  while (filled < target && guard++ < 100000) {
    const remain = target - filled;
    // ứng viên: (slot, deltaGain khi nâng 1 bậc) với delta ≤ remain
    let best = null;
    // duyệt theo thứ tự đã xáo (ổn định theo seed)
    for (const s of slots) {
      if (s.lvl >= s.gains.length - 1) continue;
      const delta = s.gains[s.lvl + 1].gain - s.gains[s.lvl].gain;
      if (delta <= remain && (!best || delta > best.delta)) best = { s, delta };
    }
    if (!best) break;   // không nâng thêm được mà không vượt -> dừng (gần nhất dưới target)
    best.s.lvl += 1;
    filled += best.delta;
  }
  const prices = {};
  slots.forEach(s => { prices[s.i] = s.gains[s.lvl].p; });   // mọi lượt đều có giá (phủ hết)
  return { prices, filled, floor, ceil };
}
function fillCurrentTotal() { return cashFillTotal(); }
function saveFillAlloc(target, seed) {
  try {
    localStorage.setItem(FILL_STORE, JSON.stringify({
      sig: dataSignature(), target, seed,
      // lưu theo oiKey (bền qua upload lại) -> giá lượt
      prices: Object.fromEntries(Object.entries(fillPrice)
        .filter(([i]) => confirmedIdx.has(+i))
        .map(([i, p]) => [oiKey(currentOtherIncomeRecords[+i]), p])),
      confirmed: [...confirmedIdx].map(i => oiKey(currentOtherIncomeRecords[i])),
    }));
  } catch (_) {}
}
function loadFillAlloc() {
  fillLocked = false;
  try {
    const raw = localStorage.getItem(FILL_STORE);
    if (!raw) return;
    const st = JSON.parse(raw);
    if (!st || st.sig !== dataSignature()) return;   // chỉ áp đúng bộ dữ liệu
    const confSet = new Set(st.confirmed || []);
    const priceByKey = st.prices || {};
    currentOtherIncomeRecords.forEach((r, i) => {
      const k = oiKey(r);
      if (confSet.has(k)) confirmedIdx.add(i);
      if (priceByKey[k]) fillPrice[i] = priceByKey[k];
    });
    if (st.target != null) { const el = $('fillTarget'); if (el) el.value = fmt(st.target); }
    fillLocked = true;
  } catch (_) {}
}

// Các lượt tiền mặt máy (để lập chữ ký bộ dữ liệu)
function cashLots() {
  const lots = [];
  currentRecords.forEach((r, idx) => {
    if (r.method === 'Tiền mặt' && r.amount > 0) lots.push({ idx, time: r.time, amount: r.amount });
  });
  return lots;
}
// Chữ ký bộ dữ liệu (để localStorage chỉ áp đúng bộ file đang mở)
function dataSignature() {
  const lots = cashLots();
  return `${lots.length}:${lots.reduce((a, l) => a + l.amount, 0)}`;
}
// PRNG có seed (mulberry32) — random CỐ ĐỊNH theo seed để load lại nhớ y hệt.
function seededRng(seed) {
  let s = seed >>> 0;
  return function () {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Ô thông tin phân bổ bù: đã bù / mong muốn + khoảng đạt được (sàn↔trần) + trạng thái khóa.
function renderFillInfo(target) {
  const info = $('fillAllocInfo');
  if (!info) return;
  const cur = fillCurrentTotal();
  const tickedN = fillableTicked().length;
  if (!target) {
    info.className = 'fill-alloc-info';
    info.textContent = tickedN ? `Đang bù ${fmtMoney(cur)} · ${tickedN} lượt đã tick (bù được ${fmtMoney(fillFloor())}–${fmtMoney(fillCeiling())})` : '';
    return;
  }
  const floor = fillFloor(), ceil = fillCeiling();
  if (cur === target) {
    info.className = 'fill-alloc-info ok';
    info.textContent = (fillLocked ? '🔒 Đã khóa · ' : '') + `Đã bù ĐÚNG ${fmtMoney(cur)} / mong muốn ${fmtMoney(target)} · phủ hết ${tickedN} lượt`;
  } else {
    info.className = 'fill-alloc-info warn';
    let msg = `Bù ${fmtMoney(cur)} / mong muốn ${fmtMoney(target)}. `;
    if (target < floor) msg += `Không thể — bù HẾT ${tickedN} lượt tối thiểu đã là ${fmtMoney(floor)}. Hãy nhập ≥ ${fmtMoney(floor)}, hoặc BỎ TICK bớt lượt.`;
    else if (target > ceil) msg += `Không đủ — ${tickedN} lượt tick chỉ bù tối đa ${fmtMoney(ceil)}. Hãy TICK THÊM lượt, hoặc nhập ≤ ${fmtMoney(ceil)}.`;
    else msg += `Bấm "Phân bổ tự động" để đạt đúng (khoảng đạt được: ${fmtMoney(floor)}–${fmtMoney(ceil)}).`;
    info.textContent = msg;
  }
}

function wireFillAlloc() {
  const alloc = $('fillAllocBtn'), reset = $('fillResetBtn'), inp = $('fillTarget');
  if (!alloc) return;
  alloc.addEventListener('click', () => {
    const target = parseInt(String(inp.value).replace(/[^\d]/g, ''), 10);
    if (!Number.isFinite(target) || target <= 0) { toast('Nhập tổng tiền mặt bù mong muốn.', true); return; }
    const ticked = fillableTicked();
    if (!ticked.length) { toast('Chưa tick lượt nào để bù. Tick ở bảng "Cần xác nhận" trước.', true); return; }
    if (!priceList.length) { toast('Chưa nhập bảng giá lượt chụp.', true); return; }
    const floor = fillFloor(), ceil = fillCeiling();
    if (target < floor) {
      toast(`Bù HẾT ${ticked.length} lượt tối thiểu đã là ${fmtMoney(floor)} > mong muốn. Bỏ tick bớt lượt, hoặc nhập ≥ ${fmtMoney(floor)}.`, true);
      renderFillInfo(target); return;
    }
    if (target > ceil) {
      toast(`${ticked.length} lượt tick chỉ bù tối đa ${fmtMoney(ceil)} < mong muốn. Tick thêm lượt, hoặc nhập ≤ ${fmtMoney(ceil)}.`, true);
      renderFillInfo(target); return;
    }
    const seed = (Date.now() & 0x7fffffff);   // seed mới mỗi lần bấm phân bổ
    ticked.forEach(x => { delete fillPrice[x.i]; });
    const { prices, filled } = allocFillByTarget(target, seed);
    Object.entries(prices).forEach(([i, p]) => { fillPrice[+i] = p; });
    fillLocked = true;
    saveFillAlloc(target, seed);
    renderConfirm();
    recompute();
    renderFillInfo(target);
    if (filled === target) toast(`Đã phân bổ + khóa: bù đúng ${fmtMoney(filled)}, phủ hết ${ticked.length} lượt.`);
    else toast(`Đạt gần nhất ${fmtMoney(filled)} / ${fmtMoney(target)} (mệnh giá bảng giá không cho khớp tuyệt đối).`, true);
  });
  reset.addEventListener('click', () => {
    fillLocked = false;
    try { localStorage.removeItem(FILL_STORE); } catch (_) {}
    // gỡ giá bù trên các lượt đã tick (giữ tick, chỉ bỏ bù)
    fillableTicked().forEach(x => { delete fillPrice[x.i]; });
    inp.value = '';
    renderConfirm();
    recompute();
    renderFillInfo(0);
    toast('Đã bỏ khóa phân bổ bù.');
  });
}

// ==========================================================================
// FILE INPUTS — drag/drop + filled state
// ==========================================================================
function wireDropzone(zoneId, inputId, labelId) {
  const zone = $(zoneId), input = $(inputId), label = $(labelId);
  const emptyText = 'Kéo thả hoặc nhấp để chọn (được nhiều file)';
  const setFiles = (files) => {
    const n = files ? files.length : 0;
    if (n === 0) {
      label.textContent = emptyText;
      zone.classList.remove('filled');
    } else if (n === 1) {
      label.textContent = files[0].name;
      zone.classList.add('filled');
    } else {
      // Nhiều file: liệt kê tên, xuống dòng cho dễ đọc
      label.innerHTML = `<strong>${n} file:</strong><br>` +
        Array.from(files).map(f => esc(f.name)).join('<br>');
      zone.classList.add('filled');
    }
  };
  input.addEventListener('change', () => setFiles(input.files));
  ['dragover', 'dragenter'].forEach(ev =>
    zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.add('dragover'); }));
  ['dragleave', 'dragend'].forEach(ev =>
    zone.addEventListener(ev, () => zone.classList.remove('dragover')));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('dragover');
    if (e.dataTransfer.files.length) { input.files = e.dataTransfer.files; setFiles(input.files); }
  });
}
wireDropzone('dz-excel', 'excelFile', 'lbl-excel');
wireDropzone('dz-pdf', 'pdfFile', 'lbl-pdf');

// ==========================================================================
// RECONCILE
// ==========================================================================
$('processBtn').addEventListener('click', async () => {
  const excelFiles = Array.from($('excelFile').files || []);
  const pdfFiles = Array.from($('pdfFile').files || []);
  if (!excelFiles.length && !pdfFiles.length) {
    toast('Vui lòng chọn ít nhất 1 file (Excel hoặc PDF).', true);
    return;
  }

  // Chế độ tính theo loại máy: 'bank' = máy CÓ QR/chuyển khoản (mặc định); 'machine' =
  // máy KHÔNG có QR (MINIBOOTH) -> doanh thu = tổng lượt máy, bank chỉ để tách + kiểm tra.
  const machineMode = $('modeMachine') && $('modeMachine').checked ? 'machine' : 'bank';
  currentMode = machineMode;

  $('loadingOverlay').classList.add('show');
  try {
    // Đọc + đối soát NGAY TRÊN MÁY (file không gửi đi đâu). Excel máy trước, sao kê sau.
    const needPdf = excelFiles.concat(pdfFiles).some(f => /\.pdf$/i.test(f.name));
    await ensureLibs(needPdf ? ['XLSX', 'pdfjs'] : ['XLSX']);
    const files = [];
    for (const f of excelFiles.concat(pdfFiles)) {
      files.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
    }
    const data = await TaxEngine.reconcile(files, machineMode, msg => { $('overlayText').textContent = msg; });
    renderAll(data, { excelFiles, pdfFiles });
    toast('Đối soát hoàn tất — ' + fmt(data.summary.total_machine) + ' chứng từ.');
  } catch (err) {
    console.error(err);
    toast(err.message || String(err), true);
  } finally {
    $('loadingOverlay').classList.remove('show');
    $('overlayText').textContent = 'Đang xử lý thuật toán đối soát…';
  }
});

// ==========================================================================
// RENDER
// ==========================================================================
function renderAll(data, files) {
  currentRecords = data.records || [];
  currentWarnings = data.warnings || [];
  currentOtherIncomeRecords = data.other_income_records || [];
  // Tiền theo bank: doanh thu = tiền mặt máy + CK bank đã khai. currentMachineTotal
  // giờ = TIỀN MẶT máy (không về bank); phần CK lấy từ includedOI (bank credit).
  currentMachineTotal = (data.summary && data.summary.machine_cash) || 0;
  confirmedIdx = new Set();
  fillPrice = {};
  loadFillAlloc();    // khôi phục phân bổ bù đã KHÓA (tick + giá lượt) nếu cùng bộ dữ liệu
  const s = data.summary;

  // Collapse upload panel → compact bar
  $('uploadGrid').classList.add('hidden');
  $('processBtn').classList.add('hidden');
  const chips = [];
  (files.excelFiles || []).forEach(f => chips.push(fileChip(f.name)));
  (files.pdfFiles || []).forEach(f => chips.push(fileChip(f.name)));
  $('fileChips').innerHTML = chips.join('');
  $('uploadSummary').classList.remove('hidden');

  // Reveal result
  $('resultSection').classList.remove('hidden');

  // Nhãn theo CHẾ ĐỘ tính (mode). currentMode set lúc submit; backend cũng trả data.mode.
  currentMode = (data.mode) || currentMode || 'bank';
  applyModeLabels(currentMode);

  // ③ Stat strip — phần TĨNH (không đổi theo % thuế / tick xác nhận)
  const cashTx = currentRecords.filter(r => r.method === 'Tiền mặt');
  const transferTx = currentRecords.filter(r => r.method === 'Mã QR');
  const verified = currentRecords.filter(r => r.status === 'Đã đối soát').length;
  // stCash set trong recompute() (động theo giảm/bù mặt) — không set tĩnh ở đây.
  $('stTransfer').textContent = fmtMoney(transferTx.reduce((a, r) => a + r.amount, 0));
  $('stTransferTx').textContent = fmt(transferTx.length) + ' giao dịch';
  $('stVerified').textContent = fmt(verified);
  $('stUnverified').textContent = fmt(currentWarnings.length);
  $('stWarnBox').classList.toggle('is-warn', currentWarnings.length > 0);

  // Tab counts
  $('cntReview').textContent = fmt(currentWarnings.length);
  $('cntReview').classList.toggle('hidden', currentWarnings.length === 0);
  $('cntLedger').textContent = fmt(currentRecords.length);

  // Panes tĩnh
  currentDailySummary = data.daily_summary || [];
  currentBankCreditByDay = data.bank_credit_by_day || {};
  currentBankNeoByDay = data.bank_neo_by_day || {};
  currentBoothNeoByDay = data.booth_neo_by_day || {};
  currentOtherNeoByDay = data.other_neo_by_day || {};
  currentMachCashByDay = data.mach_cash_by_day || {};
  currentMachQrByDay = data.mach_qr_by_day || {};
  currentBankPtbByDay = data.bank_ptb_by_day || {};
  currentBankOtherByDay = data.bank_other_by_day || {};
  renderReview();
  renderDaily();
  renderLedger();
  renderConfirm();

  // Gợi ý kỳ kê khai + ngày ký từ dữ liệu
  prefillPeriod();

  // Phần ĐỘNG (doanh thu + thuế + thu nhập khác) — tính lại theo % và tick
  recompute();

  // Kiểm tra chốt (3 phép cân) — ô cảnh báo thông minh
  renderChecks(data.checks);

  // Default tab: review if warnings exist, else daily
  switchTab(currentWarnings.length > 0 ? 'review' : 'daily');

  // Scroll result into view (smooth)
  $('resultSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Ô cảnh báo thông minh — hiện kết quả 3 phép cân. Mỗi mục có mức (xanh/vàng),
// mô tả, hướng dẫn sửa, và nút nhảy tới ngày/tab liên quan.
function renderChecks(checks) {
  const box = $('checksBox');
  if (!box) return;
  if (!checks || !checks.items || !checks.items.length) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  const warn = checks.status === 'warn';
  const head = warn
    ? '<div class="checks-head warn"><span class="checks-ic">⚠</span> Cần rà lại một số điểm trước khi xuất</div>'
    : '<div class="checks-head ok"><span class="checks-ic">✓</span> Số liệu đã cân đối — có thể xuất tờ khai</div>';

  const rows = checks.items.map((it, i) => {
    const cls = it.level === 'warn' ? 'chk-item warn' : 'chk-item ok';
    const hint = it.hint ? `<div class="chk-hint">${esc(it.hint)}</div>` : '';
    let jump = '';
    if (it.kind === 'classify') {
      jump = `<button class="chk-jump" data-act="confirm">Mở tab Cần xác nhận</button>`;
    } else if (it.kind === 'qr_pending' && it.jump_day) {
      jump = `<button class="chk-jump" data-act="day" data-day="${esc(it.jump_day)}">Xem ngày ${esc(it.jump_day)}</button>`;
    }
    return `<div class="${cls}">
      <div class="chk-title">${esc(it.title)}</div>
      <div class="chk-detail">${esc(it.detail)}</div>
      ${hint}${jump}
    </div>`;
  }).join('');

  box.className = warn ? 'checks-box warn' : 'checks-box ok';
  box.innerHTML = head + rows;
  box.classList.remove('hidden');

  // Nút nhảy
  box.querySelectorAll('.chk-jump').forEach(btn =>
    btn.addEventListener('click', () => {
      const act = btn.dataset.act;
      if (act === 'confirm') {
        const panel = $('confirmPanel');
        if (panel && !panel.classList.contains('hidden')) {
          panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else {
          switchTab('other');
          $('pane-other').scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      } else if (act === 'day') {
        switchTab('daily');
        highlightDailyRow(btn.dataset.day);
      }
    }));
}

// Nhảy tới + tô sáng dòng ngày trong tab Sổ tiền theo ngày
function highlightDailyRow(dmy) {
  const body = $('dailyBody');
  if (!body) return;
  $('pane-daily').scrollIntoView({ behavior: 'smooth', block: 'start' });
  body.querySelectorAll('tr').forEach(tr => {
    const c = tr.querySelector('td');
    if (c && c.textContent.trim() === dmy) {
      tr.classList.add('row-flash');
      setTimeout(() => tr.classList.remove('row-flash'), 2600);
      tr.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });
}

// Tính lại doanh thu quán + thuế (gọi khi load, đổi %, hoặc tick)
// Đổi nhãn UI theo chế độ tính. mode='machine' (MINIBOOTH): máy không có QR, CK về
// bank là "khách CK đổi tiền mặt" — không có "kinh doanh khác".
function applyModeLabels(mode) {
  const machine = mode === 'machine';
  const setLbl = (sel, txt) => { const el = document.querySelector(sel); if (el) el.textContent = txt; };
  // Ô "CK Photobooth" (nhãn cột trong hero)
  const boothCell = $('hfBooth') && $('hfBooth').closest('.tax-cell');
  if (boothCell) { const sp = boothCell.querySelector('span'); if (sp) sp.textContent = machine ? 'CK đổi tiền mặt' : 'CK Photobooth'; }
  // Ẩn ô "CK kinh doanh khác" ở chế độ máy-không-QR (không phát sinh KD khác)
  const otherCell = $('hfOtherBiz') && $('hfOtherBiz').closest('.tax-cell');
  if (otherCell) otherCell.classList.toggle('hidden', machine);
  // Nhãn stat "Doanh thu chuyển khoản"
  if ($('stOtherTx')) { /* text set trong recompute */ }
}

function recompute() {
  const inc = includedOI();                    // các khoản CK ĐƯỢC KHAI (booth + KD khác đã tick)
  const oiTotal = inc.reduce((a, r) => a + r.amount, 0);
  const cashFill = cashFillTotal();            // tiền mặt BÙ cho lượt CK trả thiếu
  const boothTotal = inc.filter(r => r.category === 'booth').reduce((a, r) => a + r.amount, 0);
  const otherBizTotal = inc.filter(r => r.category !== 'booth').reduce((a, r) => a + r.amount, 0);
  const cashBase = currentMachineTotal + cashFill;  // mặt máy + bù
  const base = cashBase + oiTotal;             // tiền mặt + CK khai
  const days = countDays(currentRecords, inc);

  // Hero — doanh thu quán = tiền mặt (máy + bù) + CK photobooth + CK kinh doanh khác (đã tick)
  $('heroRevenue').textContent = fmt(base);
  $('heroNote').textContent =
    'Tiền mặt ' + fmtMoney(cashBase) + '  +  CK ' + fmtMoney(oiTotal)
    + (cashFill ? '   (gồm ' + fmtMoney(cashFill) + ' mặt bù)' : '');
  $('hfMachine').textContent = fmtMoney(cashBase);
  $('hfBooth').textContent = fmtMoney(boothTotal);
  $('hfOtherBiz').textContent = fmtMoney(otherBizTotal);
  $('hfDays').textContent = fmt(days) + ' ngày';

  // Stat "Tiền mặt" — động theo bù mặt (không để lệch doanh thu)
  if ($('stCash')) {
    $('stCash').textContent = fmtMoney(cashBase);
    $('stCashTx').textContent = fmt(cashRecords(currentRecords).length) + ' lượt';
  }

  // Thuế (làm tròn theo ngày, khớp Excel)
  const g = getRate('rateGtgt', 3), t = getRate('rateTncn', 1.5);
  const tax = computeTax(currentRecords, inc, g, t, cashFillByDay());
  $('amtGtgt').textContent = fmtMoney(tax.gtgt);
  $('amtTncn').textContent = fmtMoney(tax.tncn);
  $('amtTotal').textContent = fmtMoney(tax.total);
  $('taxBaseNote').textContent = 'Trên doanh thu ' + fmtMoney(base);

  // Stat doanh thu chuyển khoản (từ ngân hàng, đã khai)
  $('stOther').textContent = fmtMoney(oiTotal);
  $('stOtherTx').textContent = fmt(inc.length) +
    (currentMode === 'machine' ? ' lượt CK đổi mặt' : ' khoản (từ ngân hàng)');

  // Tab doanh thu chuyển khoản = các khoản CK đã khai
  renderOther(inc);
  $('cntOther').textContent = fmt(inc.length);

  // Tab "Sổ tiền theo ngày" — cập nhật theo tick KD khác / bù / giảm mặt
  renderDaily();

  // Thông tin phân bổ bù (đã bù / mong muốn + nhắc thiếu)
  const ftEl = $('fillTarget');
  const fTarget = ftEl ? parseInt(String(ftEl.value).replace(/[^\d]/g, ''), 10) || 0 : 0;
  renderFillInfo(fTarget);
}

function fileChip(name) {
  return '<span class="file-chip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>' + esc(name) + '</span>';
}

const WARN_STATUS = 'Máy ghi - chưa thấy về NH';
function badge(status) {
  if (status === WARN_STATUS || status === 'Chưa đối soát') return '<span class="badge badge-warn">' + esc(status) + '</span>';
  if (status === 'Đã đối soát') return '<span class="badge badge-ok">Đã đối soát</span>';
  if (status === 'Ghi nhận') return '<span class="badge badge-ok">Ghi nhận</span>';
  return '<span class="badge badge-neutral">' + esc(status || 'Khớp') + '</span>';
}

function emptyPane(msg) {
  return '<tr><td colspan="9"><div class="pane-empty">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>' +
    '<p>' + esc(msg) + '</p></div></td></tr>';
}

function renderReview() {
  const body = $('reviewBody');
  if (!currentWarnings.length) {
    body.innerHTML = emptyPane('Tất cả giao dịch chuyển khoản đều đã đối soát khớp với sao kê.');
    return;
  }
  body.innerHTML = currentWarnings.map(r => `
    <tr class="row-warn">
      <td class="cell-mono">${esc(r.time)}</td>
      <td class="cell-strong">${esc(r.machine_id || '—')}</td>
      <td>${esc(r.method)}</td>
      <td class="cell-sub">${esc(r.reason)}</td>
      <td class="text-right cell-mono cell-strong ${mauPT(r.method)}">${fmtMoney(r.amount)}</td>
    </tr>`).join('');
}

function renderDaily() {
  const body = $('dailyBody');
  // GÓC NHÌN MÁY: mặt máy | CK photobooth (QR máy) | DT khác (bank không khớp máy).
  const daily = machineDailyForExport();
  if (!daily.length) { body.innerHTML = emptyPane('Không có dữ liệu theo ngày.'); return; }
  const rows = [];
  daily.forEach(d => {
    rows.push(`
      <tr>
        <td class="cell-strong">${esc(d.date)}</td>
        <td class="text-right cell-mono m-tm">${fmtMoney(d.cash)}</td>
        <td class="text-right cell-mono m-ck">${fmtMoney(d.booth)}</td>
        <td class="text-right cell-mono m-ck">${fmtMoney(d.other)}</td>
        <td class="text-right cell-mono cell-strong">${fmtMoney(d.total)}</td>
      </tr>`);
    (d.expenses || []).forEach(e => {
      rows.push(`
        <tr class="row-expense">
          <td class="indent">↳ Chi tiêu</td>
          <td colspan="3">${esc(e.description)}</td>
          <td class="text-right cell-mono m-ra">− ${fmtMoney(e.amount)}</td>
        </tr>`);
    });
  });
  body.innerHTML = rows.join('');
}

function renderOther(list) {
  const body = $('otherBody');
  const rows = list || [];
  if (!rows.length) {
    body.innerHTML = emptyPane('Chưa có khoản doanh thu chuyển khoản nào.');
    return;
  }
  // Map từng dòng về index thật trong currentOtherIncomeRecords (để sửa đúng khoản)
  body.innerHTML = rows.map(r => {
    const gi = currentOtherIncomeRecords.indexOf(r);
    const shown = (r.custom_desc != null && r.custom_desc !== '') ? r.custom_desc : r.description;
    return `
    <tr class="row-in">
      <td class="cell-strong cell-mono">${esc(r.date || r.time)}</td>
      <td class="cell-sub">
        <input type="text" class="desc-edit" data-idx="${gi}"
               value="${esc(shown)}" title="Sửa diễn giải sẽ hiện trong tờ khai">
      </td>
      <td class="text-right cell-mono amount-in">+ ${fmtMoney(r.amount)}</td>
    </tr>`;
  }).join('');
  wireDescEdit(body);
}

// Gắn sự kiện sửa diễn giải: lưu vào custom_desc theo index thật
function wireDescEdit(container) {
  container.querySelectorAll('.desc-edit').forEach(inp =>
    inp.addEventListener('change', () => {
      const i = parseInt(inp.dataset.idx, 10);
      if (Number.isNaN(i) || !currentOtherIncomeRecords[i]) return;
      currentOtherIncomeRecords[i].custom_desc = inp.value.trim();
    }));
}

// Đồng bộ trạng thái checkbox "Chọn tất cả" + đếm
function syncConfirmAll() {
  if (!nonLoaIndices.length) return;
  const checked = nonLoaIndices.filter(i => confirmedIdx.has(i)).length;
  const all = $('confirmAll');
  all.checked = checked === nonLoaIndices.length;
  all.indeterminate = checked > 0 && checked < nonLoaIndices.length;
  $('confirmCount').textContent = checked + '/' + nonLoaIndices.length + ' khoản đưa vào';
}

// Bảng "Cần xác nhận" — khoản KHÔNG có mã loa (mặc định không tính, chọn để thêm)
function renderConfirm() {
  const panel = $('confirmPanel'), body = $('confirmBody');
  const nonLoa = currentOtherIncomeRecords
    .map((r, i) => ({ r, i }))
    .filter(x => !x.r.is_loa);
  nonLoaIndices = nonLoa.map(x => x.i);
  if (!nonLoa.length) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');
  body.innerHTML = nonLoa.map(({ r, i }) => {
    const on = confirmedIdx.has(i);
    const shown = (r.custom_desc != null && r.custom_desc !== '') ? r.custom_desc : r.description;
    const tag = r.category === 'non_revenue'
      ? '<span class="cat-tag cat-lai">Lãi NH</span>'
      : (currentMode === 'machine'
          ? '<span class="cat-tag cat-other">CK chưa khớp máy</span>'
          : '<span class="cat-tag cat-other">KD khác</span>');
    // Cột bù lượt: CHỈ khoản KD khác + mệnh giá LẠ (không khớp bảng giá = trả thiếu).
    // CK đã đúng 1 giá lượt -> trả đủ, KHÔNG bù.
    let fillCell = '<td class="cell-faint">—</td>', fillAmtCell = '<td class="text-right cell-faint">—</td>';
    const canFill = r.category === 'other' && isOddCk(r.amount);
    if (canFill) {
      const cands = priceList.filter(p => p > r.amount);   // chỉ giá LỚN HƠN CK
      const chosen = fillPrice[i] || '';
      const opts = ['<option value="">— không bù —</option>']
        .concat(cands.map(p => `<option value="${p}" ${chosen == p ? 'selected' : ''}>Lượt ${fmtMoney(p)}</option>`))
        .join('');
      fillCell = `<td><select class="fill-sel" data-idx="${i}" ${on ? '' : 'disabled'}>${opts}</select></td>`;
      const cashAdd = (chosen && chosen > r.amount) ? (chosen - r.amount) : 0;
      fillAmtCell = `<td class="text-right cell-mono ${cashAdd ? 'm-tm cell-strong' : 'cell-faint'}">${cashAdd ? '+ ' + fmtMoney(cashAdd) : '—'}</td>`;
    }
    return `
    <tr class="${on ? 'row-confirmed' : 'row-pending'}">
      <td class="text-center"><input type="checkbox" class="chk" data-idx="${i}" ${on ? 'checked' : ''}></td>
      <td class="cell-strong cell-mono">${esc(r.date || r.time)}</td>
      <td>${tag}</td>
      <td class="cell-sub">
        <input type="text" class="desc-edit" data-idx="${i}"
               value="${esc(shown)}" title="Sửa diễn giải sẽ hiện trong tờ khai">
      </td>
      <td class="text-right cell-mono cell-strong m-ck">${fmtMoney(r.amount)}</td>
      ${fillCell}
      ${fillAmtCell}
    </tr>`;
  }).join('');
  wireDescEdit(body);
  body.querySelectorAll('.chk').forEach(c =>
    c.addEventListener('change', () => {
      const idx = parseInt(c.dataset.idx, 10);
      if (c.checked) {
        confirmedIdx.add(idx);
        // Kiểu random: tự chọn giá bù ngay khi tick (nếu chưa chọn)
        const rec = currentOtherIncomeRecords[idx];
        if ($('fillMode').value === 'random' && rec && rec.category === 'other' && !fillPrice[idx]) {
          const p = pickFillPrice(rec.amount, 'random');
          if (p) fillPrice[idx] = p;
        }
      } else {
        confirmedIdx.delete(idx);
        delete fillPrice[idx];
      }
      renderConfirm();          // vẽ lại để bật/tắt dropdown + cập nhật mặt bù
      syncConfirmAll();
      recompute();
    }));
  // Dropdown chọn giá lượt bù
  body.querySelectorAll('.fill-sel').forEach(sel =>
    sel.addEventListener('change', () => {
      const idx = parseInt(sel.dataset.idx, 10);
      const v = parseInt(sel.value, 10);
      if (Number.isFinite(v) && v > 0) fillPrice[idx] = v; else delete fillPrice[idx];
      renderConfirm();
      recompute();
    }));
  syncConfirmAll();
}

// Chọn tất cả / bỏ chọn tất cả khoản không-loa
$('confirmAll').addEventListener('change', () => {
  const on = $('confirmAll').checked;
  nonLoaIndices.forEach(i => { if (on) confirmedIdx.add(i); else confirmedIdx.delete(i); });
  $('confirmBody').querySelectorAll('.chk').forEach(c => {
    c.checked = on;
    c.closest('tr').className = on ? 'row-confirmed' : 'row-pending';
  });
  $('confirmAll').indeterminate = false;
  $('confirmCount').textContent = (on ? nonLoaIndices.length : 0) + '/' + nonLoaIndices.length + ' khoản đưa vào';
  recompute();
});

function renderLedger() {
  const body = $('ledgerBody');
  const q = ledgerQuery.toLowerCase();
  const rows = currentRecords.filter(r => {
    if (ledgerFilter === 'warn') { if (r.status !== WARN_STATUS) return false; }
    else if (ledgerFilter !== 'all') { if (r.method !== ledgerFilter) return false; }
    if (q) {
      const hay = (r.machine_id + ' ' + r.reason + ' ' + r.method).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  if (!rows.length) { body.innerHTML = emptyPane('Không có giao dịch khớp bộ lọc.'); return; }
  body.innerHTML = rows.map(r => `
    <tr class="${r.status === WARN_STATUS ? 'row-warn' : ''}">
      <td class="cell-mono">${esc(r.time)}</td>
      <td class="cell-strong">${esc(r.machine_id || '—')}</td>
      <td>${esc(r.method)}</td>
      <td class="cell-sub">${esc(r.reason)}</td>
      <td class="text-center">${badge(r.status)}</td>
      <td class="text-right cell-mono cell-strong ${mauPT(r.method)}">${fmtMoney(r.amount)}</td>
    </tr>`).join('');
}

// ==========================================================================
// TABS
// ==========================================================================
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tabpane').forEach(p => p.classList.toggle('active', p.id === 'pane-' + name));
}
document.querySelectorAll('.tab').forEach(t =>
  t.addEventListener('click', () => switchTab(t.dataset.tab)));

// Ledger search + filter
$('ledgerSearch').addEventListener('input', e => { ledgerQuery = e.target.value; renderLedger(); });
document.querySelectorAll('#methodChips .chip').forEach(c =>
  c.addEventListener('click', () => {
    document.querySelectorAll('#methodChips .chip').forEach(x => x.classList.remove('active'));
    c.classList.add('active');
    ledgerFilter = c.dataset.f;
    renderLedger();
  }));

// Đổi % thuế → tính lại live (web + dùng khi xuất Excel)
$('rateGtgt').addEventListener('input', recompute);
$('rateTncn').addEventListener('input', recompute);

// Reset (đối soát lại)
$('resetBtn').addEventListener('click', () => {
  $('uploadGrid').classList.remove('hidden');
  $('processBtn').classList.remove('hidden');
  $('uploadSummary').classList.add('hidden');
  $('resultSection').classList.add('hidden');
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

// ==========================================================================
// META — taxpayer info (collect, persist, prefill)
// ==========================================================================
const META_FIELDS = {
  mBusiness: 'business_name',
  mTaxcode: 'tax_code',
  mAddress: 'address',
  mLocation: 'location',
  mPeriod: 'period',
  mUnit: 'unit',
  mSignDate: 'sign_date',
};
const META_STORE = 'noir_meta';
// Field người dùng nhập 1 lần, lưu lại; kỳ + ngày ký phụ thuộc dữ liệu nên không lưu.
const META_PERSIST = ['mBusiness', 'mTaxcode', 'mAddress', 'mLocation', 'mUnit'];

function collectMeta() {
  const meta = {};
  for (const [id, key] of Object.entries(META_FIELDS)) {
    const el = $(id);
    if (el) meta[key] = el.value.trim();
  }
  if (!meta.unit) meta.unit = 'VNĐ';
  return meta;
}
function saveMeta() {
  const data = {};
  META_PERSIST.forEach(id => { if ($(id)) data[id] = $(id).value.trim(); });
  try { localStorage.setItem(META_STORE, JSON.stringify(data)); } catch (_) {}
}
function loadMeta() {
  try {
    const data = JSON.parse(localStorage.getItem(META_STORE) || '{}');
    Object.entries(data).forEach(([id, v]) => { if ($(id) && v) $(id).value = v; });
  } catch (_) {}
}
loadMeta();
loadPriceList();
wireFillAlloc();

// Sắp lại thứ tự trang cho đúng quy trình: ...Cần xác nhận -> [Tab kiểm tra] -> [Thuế]
// -> [Thông tin + Xuất] ở cuối. (HTML để Tab sau, JS kéo về đúng vị trí.)
(function reorderSections() {
  const ws = $('workspacePanel'), tax = $('taxPanel'), exp = $('exportPanel');
  if (ws && tax && exp && tax.parentNode) {
    tax.parentNode.insertBefore(ws, tax);   // Tab lên trước Thuế
    // exportPanel giữ nguyên ở cuối (đã sau tax trong DOM)
  }
})();

// Ô bảng giá: đổi -> parse lại + lưu + vẽ lại bảng cần xác nhận (dropdown bù cập nhật)
if ($('priceList')) {
  $('priceList').addEventListener('input', () => {
    priceList = parsePriceList($('priceList').value);
    savePriceList();
    renderConfirm();
    recompute();
  });
}
// Đổi kiểu bù (random/chọn tay): xóa lựa chọn bù cũ, vẽ lại
if ($('fillMode')) {
  $('fillMode').addEventListener('change', () => {
    fillPrice = {};
    // Random: tự gán giá bù cho các khoản KD khác đã tick
    if ($('fillMode').value === 'random') {
      currentOtherIncomeRecords.forEach((r, i) => {
        if (confirmedIdx.has(i) && r.category === 'other') {
          const p = pickFillPrice(r.amount, 'random');
          if (p) fillPrice[i] = p;
        }
      });
    }
    renderConfirm();
    recompute();
  });
}

// Tự gợi ý Kỳ kê khai + Ngày ký từ khoảng ngày của dữ liệu (chỉ điền nếu trống)
function prefillPeriod() {
  const dates = currentRecords.map(r => String(r.time || '').slice(0, 10)).filter(Boolean).sort();
  if (!dates.length) return;
  const last = dates[dates.length - 1];       // YYYY-MM-DD
  const [y, m, d] = last.split('-');
  if (!$('mPeriod').value.trim()) $('mPeriod').value = `Tháng ${m}/${y}`;
  if (!$('mSignDate').value.trim()) $('mSignDate').value = `Ngày ${d} tháng ${m} năm ${y}`;
}

// ==========================================================================
// EXPORT
// ==========================================================================
// Sinh record TIỀN MẶT BÙ cho mỗi lượt CK trả thiếu (đã tick + chọn giá lượt).
// Mỗi khoản -> 1 dòng tiền mặt = giá lượt − CK, GẮN cùng ngày với CK đó. Diễn giải
// nối 'lượt CK trả thiếu' để trên tờ khai hiểu 2 dòng (CK + mặt) là 1 lượt.
function fillCashRecords() {
  const out = [];
  currentOtherIncomeRecords.forEach((r, i) => {
    if (confirmedIdx.has(i) && fillPrice[i] && fillPrice[i] > r.amount) {
      out.push({
        time: r.time,
        machine_id: '',
        method: 'Tiền mặt',
        amount: fillPrice[i] - r.amount,
        status: 'Khớp',
        reason: 'Tiền mặt bù cho lượt chụp trả 1 phần qua CK',
        is_fill: true,          // đánh dấu là mặt BÙ (exporter dán ngay dưới CK, bỏ số hiệu)
        fill_ck: r.amount,      // mệnh giá CK thiếu tương ứng (để ghép cặp đúng)
      });
    }
  });
  return out;
}

// Báo cáo theo ngày GÓC NHÌN MÁY (sheet "Theo ngày"/"Tóm tắt" + tab web). Số liệu:
//   cash  = TIỀN MẶT máy (lượt 'Tiền mặt') + bù − giảm, theo ngày máy.
//   booth = CK PHOTOBOOTH = lượt 'Mã QR' MÁY, theo ngày máy.
//   other = DT KHÁC = CK bank KHÔNG khớp lượt máy (other_neo), luôn hiện để đối chiếu.
//   total = cash + booth (KHÔNG cộng DT khác) — như tab web.
// Khác dailySummaryForExport (nguồn BANK, cho tờ khai S2A/thuế).
function machineDailyForExport() {
  const isoToDmy = (iso) => { const p = String(iso).slice(0, 10).split('-'); return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : iso; };
  const byDmy = {};
  const ensure = (dmy) => (byDmy[dmy] || (byDmy[dmy] = { date: dmy, cash: 0, booth: 0, other: 0, total: 0, expenses: [] }));
  // Tiền mặt máy + CK photobooth (QR máy) theo ngày máy
  Object.entries(currentMachCashByDay || {}).forEach(([iso, v]) => { ensure(isoToDmy(iso)).cash += Number(v || 0); });
  Object.entries(currentMachQrByDay || {}).forEach(([iso, v]) => { ensure(isoToDmy(iso)).booth += Number(v || 0); });
  // DT khác = CK bank không khớp máy (other_neo)
  Object.entries(currentOtherNeoByDay || {}).forEach(([iso, v]) => { ensure(isoToDmy(iso)).other += Number(v || 0); });
  // Tiền mặt BÙ -> cộng cash
  Object.entries(cashFillByDay()).forEach(([iso, amt]) => { ensure(isoToDmy(iso)).cash += Number(amt || 0); });
  // Chi tiêu (từ daily_summary backend, gắn theo ngày)
  (currentDailySummary || []).forEach(d => {
    if (d.expenses && d.expenses.length) ensure(d.date).expenses = d.expenses;
  });
  Object.values(byDmy).forEach(d => { d.total = d.cash + d.booth; });   // tổng = mặt + photobooth
  const dparts = (s) => String(s).split(/[\/\-]/);
  return Object.values(byDmy).sort((a, b) => {
    const pa = dparts(a.date), pb = dparts(b.date);
    return new Date(pa[2], pa[1] - 1, pa[0]) - new Date(pb[2], pb[1] - 1, pb[0]);
  });
}

// Daily summary cho EXPORT: cộng thêm (1) CK 'KD khác' đã tick vào transfer,
// (2) tiền mặt BÙ vào cash — theo đúng ngày. daily_summary gốc từ backend chỉ có
// booth (mặc định khai); phần user tick/bù thêm phải gộp vào đây để export khớp.
function dailySummaryForExport() {
  // map ngày DD-MM-YYYY -> bản sao. other_ck = phần CK DOANH THU KHÁC (không phải
  // photobooth) đã tick — tách riêng để sheet theo ngày có cột riêng; transfer VẪN gộp
  // (booth + khác) để tờ khai S2A 6 tháng dùng như cũ.
  const byDmy = {};
  (currentDailySummary || []).forEach(d => {
    byDmy[d.date] = { date: d.date, cash: d.cash || 0, transfer: d.transfer || 0,
                      other_ck: 0, other_all: 0, total: d.total || 0, expenses: d.expenses || [] };
  });
  // ISO 'YYYY-MM-DD' -> 'DD/MM/YYYY' (gạch CHÉO, KHỚP định dạng date của backend
  // daily_summary). Dùng gạch nối trước gây LỆCH khóa -> tách hàng riêng, DT khác = 0.
  const isoToDmy = (iso) => { const p = String(iso).slice(0, 10).split('-'); return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : iso; };
  const ensure = (dmy) => (byDmy[dmy] || (byDmy[dmy] = { date: dmy, cash: 0, transfer: 0, other_ck: 0, other_all: 0, total: 0, expenses: [] }));
  // other_all = MỌI CK doanh thu khác (không khớp máy) theo ngày — để HIỂN THỊ đối chiếu
  // (luôn có số, không cần tick). Nguồn: other_neo_by_day từ backend (cùng kiểu ngày).
  Object.entries(currentOtherNeoByDay || {}).forEach(([iso, amt]) => {
    ensure(isoToDmy(iso)).other_all += Number(amt || 0);
  });
  // other_ck = phần KD khác ĐÃ TICK khai -> cộng transfer (vào Tổng thu) VÀ other_ck.
  currentOtherIncomeRecords.forEach((r, i) => {
    if (r.category !== 'booth' && confirmedIdx.has(i)) {
      const d = ensure(isoToDmy(r.time));
      d.transfer += r.amount;
      d.other_ck += r.amount;
    }
  });
  // Tiền mặt bù -> cộng cash
  Object.entries(cashFillByDay()).forEach(([iso, amt]) => { ensure(isoToDmy(iso)).cash += amt; });
  Object.values(byDmy).forEach(d => { d.total = d.cash + d.transfer; });
  // Sắp theo ngày. date dạng 'DD/MM/YYYY' (gạch chéo) -> split cả '/' và '-' cho chắc.
  const dparts = (s) => String(s).split(/[\/\-]/);
  return Object.values(byDmy).sort((a, b) => {
    const pa = dparts(a.date), pb = dparts(b.date);
    return new Date(pa[2], pa[1] - 1, pa[0]) - new Date(pb[2], pb[1] - 1, pb[0]);
  });
}

// ==========================================================================
// NẠP THƯ VIỆN THEO NHU CẦU (trang mở nhanh; chỉ tải khi đối soát / xuất)
// ==========================================================================
window.TaxLibs = window.TaxLibs || {};
const LIB_SRC = {
  XLSX: 'vendor/xlsx.full.min.js',
  ExcelJS: 'vendor/exceljs.min.js',
};
const libLoading = {};
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error('Không tải được ' + src + ' — kiểm tra mạng rồi thử lại.'));
    document.head.appendChild(el);
  });
}
function ensureLib(name) {
  if (window.TaxLibs[name]) return Promise.resolve();
  if (!libLoading[name]) {
    libLoading[name] = (async () => {
      if (name === 'pdfjs') {
        const pdfjs = await import(new URL('vendor/pdf.min.mjs', location.href).href);
        pdfjs.GlobalWorkerOptions.workerSrc = new URL('vendor/pdf.worker.min.mjs', location.href).href;
        window.TaxLibs.pdfjs = pdfjs;
      } else {
        await loadScript(LIB_SRC[name]);
        window.TaxLibs[name] = window[name];
      }
    })().catch(e => { delete libLoading[name]; throw e; });
  }
  return libLoading[name];
}
function ensureLibs(names) { return Promise.all(names.map(ensureLib)); }

let templateBytes = null;
async function loadTemplate() {
  if (templateBytes) return templateBytes;
  const res = await fetch('S2A-HKD_Template.xlsx', { cache: 'no-cache' });
  if (!res.ok) throw new Error('Không tải được mẫu tờ khai S2A-HKD.');
  templateBytes = new Uint8Array(await res.arrayBuffer());
  return templateBytes;
}

function downloadXlsx(buf, filename) {
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// Chạy 1 lượt xuất: hiện chờ, dựng file tại chỗ, tải về
async function runExport(label, filename, build, doneMsg) {
  $('overlayText').textContent = label;
  $('loadingOverlay').classList.add('show');
  try {
    await ensureLib('ExcelJS');
    downloadXlsx(await build(), filename);
    toast(doneMsg);
    return true;
  } catch (err) {
    console.error(err);
    toast(err.message || String(err), true);
    return false;
  } finally {
    $('loadingOverlay').classList.remove('show');
    $('overlayText').textContent = 'Đang xử lý thuật toán đối soát…';
  }
}

// ==========================================================================
// EXPORT
// ==========================================================================
async function doExport() {
  if (!currentRecords.length && !includedOI().length) { toast('Chưa có dữ liệu để xuất.', true); return; }
  const ok = await runExport('Đang tạo tờ khai S2A-HKD…', 'S2A_HKD.xlsx', async () =>
    TaxExport.buildS2A(await loadTemplate(), {
      // Tiền theo bank: S2A ghi TIỀN MẶT máy + tiền mặt BÙ + CK bank khai. QR máy
      // KHÔNG gửi (đã trong other_income_records = bank credit) -> tránh đếm 2 lần.
      records: cashRecords(currentRecords).concat(fillCashRecords()),
      other_income_records: includedOI(),
      meta: collectMeta(),
      gtgt_rate: getRate('rateGtgt', 3),
      tncn_rate: getRate('rateTncn', 1.5),
    }), 'Đã tạo tờ khai S2A-HKD.');
  if (ok) saveMeta();
}
$('exportBtn').addEventListener('click', doExport);

// Doanh thu KHÁC (mọi CK không phải photobooth) đã tick khai, gom theo ngày ISO
// (YYYY-MM-DD). Dùng cho cột riêng trong sheet "CK ngân hàng theo ngày".
function otherBizByDay() {
  const map = {};
  includedOI().forEach(r => {
    if (r.category === 'booth') return;         // chỉ khoản KHÔNG phải photobooth
    const d = String(r.time || '').slice(0, 10);
    if (d) map[d] = (map[d] || 0) + Number(r.amount || 0);
  });
  return map;
}

async function doExportDaily() {
  if (!currentDailySummary.length) { toast('Chưa có dữ liệu theo ngày để xuất.', true); return; }
  await runExport('Đang tạo báo cáo theo ngày…', 'Bao_cao_theo_ngay.xlsx', () =>
    TaxExport.buildDailyReport({
      // Sheet "Theo ngày"/"Tóm tắt" = GÓC NHÌN MÁY (mặt máy | CK photobooth=QR máy | DT khác).
      daily_summary: machineDailyForExport(),
      selfbooth_records: includedOI(),
      // Sheet "CK ngân hàng theo ngày" = BANK NGUYÊN BẢN, NGÀY GỐC.
      bank_ptb_by_day: currentBankPtbByDay,
      bank_other_by_day: currentBankOtherByDay,
      meta: collectMeta(),
    }), 'Đã tạo báo cáo theo ngày.');
}
$('exportDailyBtn').addEventListener('click', doExportDaily);

// Xuất tờ khai S2A-HKD gọn 1 sheet cả kỳ (mỗi ngày: Tiền mặt / Chuyển khoản chụp ảnh)
async function doExportTax() {
  if (!currentDailySummary.length) { toast('Chưa có dữ liệu để xuất.', true); return; }
  const ok = await runExport('Đang tạo tờ khai S2A-HKD (cả kỳ)…', 'To_khai_S2A_6thang.xlsx', async () =>
    TaxExport.buildTaxDecl(await loadTemplate(), {
      daily_summary: dailySummaryForExport(),
      bank_ck_neo_by_day: currentBankNeoByDay,
      meta: collectMeta(),
      gtgt_rate: getRate('rateGtgt', 3),
      tncn_rate: getRate('rateTncn', 1.5),
    }), 'Đã tạo tờ khai S2A-HKD (cả kỳ, 1 sheet).');
  if (ok) saveMeta();
}
const exportTaxBtn = $('exportTaxBtn');
if (exportTaxBtn) exportTaxBtn.addEventListener('click', doExportTax);

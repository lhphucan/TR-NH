// ===== Trang nhân viên: in ảnh thẻ và ảnh ghép frame qua phần mềm in ở máy quầy =====
// Nhân viên chỉ bấm "In": hiện khổ giấy cần đặt, bấm In là in. Không cài đặt gì:
// - máy in = máy in mặc định của Windows ở máy quầy (phần mềm in tự lấy);
// - thông số in = "bộ chuẩn" admin cài một lần trong phần mềm in (không gửi loại giấy / chất lượng);
//   popup ghi loại giấy + ngày cài để nhìn là biết, máy chưa cài thì không cho in;
// - khổ giấy theo ấn phẩm: ảnh thẻ tờ 10×15 (4×6 inch), frame theo khổ in của frame (A5 / A4).
// Web dựng sẵn nguyên tờ giấy đúng DPI máy in (720 với Epson L8050), giấy dọc, rồi gửi như
// app In ảnh Lens (D:\Lenticular App\IN-TU-WEB.md). In đúng 100%, có lề: máy in bỏ ~3 mm sát mép.
// Dùng chung: driveToken, db, br, dbPath, currentData, userRole, Swal, Toast, escapeHTML (admin.js);
// FR (frame-core.js); FK_FRAMES, fkLoadFrames (frame-khach.js); nvUp, nvTen, nvGio (frame-nv.js).

const IN_AGENT = 'http://localhost:9100';
const IN_DPI = 720;                 // Epson L8050; máy in khác DPI thì phần mềm in chặn và báo
const IN_BAN_TOI_THIEU = '2.3.0';   // 2.3.0: chỉ nhận lệnh từ trang của tiệm
const IN_BAN_TU_CAP_NHAT = '2.4.0'; // từ bản này phần mềm in tự cập nhật, nhân viên không phải làm gì
const IN_BAN_CHUAN = '2.5.0';       // từ bản này có bộ chuẩn (/settings trả chuan, chuanAt)
const IN_CHUA_CAI = 'Chuột phải biểu tượng phần mềm in (góc phải dưới màn hình) → "Cài thông số in…", chọn preset giấy đúng rồi bấm OK.';
const IN_TAI = 'https://github.com/lhphucan/TR-NH/releases/latest/download/LenticularPrintAgent.exe';
const IN_GIAY = {
    '4x6': { ten: '10×15', mo: '10×15 cm (4×6 inch)', w: 101.6, h: 152.4 },
    A5: { ten: 'A5', mo: 'A5 (148×210 mm)', w: 148, h: 210 },
    A4: { ten: 'A4', mo: 'A4 (210×297 mm)', w: 210, h: 297 }
};
let IN_DANG = false;   // đang in: khoá nút, bấm nhầm hai lần không in trùng

const inBanCu = (v, toi) => { const a = String(v || '0').split('.').map(Number), b = toi.split('.').map(Number); for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) < (b[i] || 0); } return false; };

// Khổ in của ảnh ghép: theo frame khách dùng (bản xếp, hoặc bản ghi album với yêu cầu cũ)
function inKhoGhep(cId, up) {
    let fid = (up.nv && up.nv.bo && up.nv.bo.frame) || (up.bo && up.bo.frame) || '';
    if (!fid) {
        const id = Array.isArray(up.drive) && up.drive[0] && up.drive[0].id;
        const fr = ((currentData && currentData[cId]) || {}).framed || {};
        Object.values(fr).forEach(l => Object.values(l || {}).forEach(v => { if (v && v.id === id && v.frame) fid = v.frame; }));
    }
    const f = typeof FK_FRAMES !== 'undefined' && FK_FRAMES && FK_FRAMES[fid];
    return f ? (f.kho || FR.khoDoan(f.w, f.h)) : '';
}

// Nút "In · A5" / "In · 10×15"
function inNut(kho, onclick) {
    const g = IN_GIAY[kho];
    return `<button type="button" class="up-btn ghost in-nut" onclick="${onclick}" title="In qua phần mềm in ở máy quầy">In${g ? ' · ' + g.ten : ''}</button>`;
}
const inDaIn = up => up && up.daIn && up.daIn.at ? `đã in ${nvGio(up.daIn.at)}` : '';

async function inGhep(cId, uId, ban) {
    const up = nvUp(cId, uId);
    if (!up) return;
    // Mặc định in bản tiệm chỉnh nếu có, không thì bản khách (đã được ghép lại đủ 100%)
    const nv = up.nv && up.nv.id ? up.nv : null;
    if (!ban) ban = nv ? 'tiem' : 'khach';
    const id = ban === 'tiem' ? nv && nv.id : Array.isArray(up.drive) && up.drive[0] && up.drive[0].id;
    await fkLoadFrames().catch(() => {});
    await inLam({ cId, uId, id, kho: inKhoGhep(cId, up), ban, viec: 'ảnh ghép frame' + (ban === 'tiem' ? ' (bản tiệm chỉnh)' : '') });
}

async function inThe(cId, uId) {
    const up = nvUp(cId, uId);
    const id = up && Array.isArray(up.drive) && up.drive[0] && up.drive[0].id;
    await inLam({ cId, uId, id, kho: '4x6', viec: 'ảnh thẻ' });
}

async function inLam({ cId, uId, id, kho, ban, viec }) {
    if (userRole === 'viewer' || IN_DANG || !id) return;
    // Khổ chưa biết (frame chưa chọn khổ in): hỏi một lần cho lần in này
    if (!IN_GIAY[kho]) {
        const r = await Swal.fire({ title: 'Frame chưa có khổ in', text: 'Admin chọn khổ in trong quản lý frame để lần sau tự nhận. Lần này in khổ nào?',
            input: 'radio', inputOptions: { A5: 'A5', A4: 'A4' }, inputValue: 'A5', showCancelButton: true,
            confirmButtonText: 'Tiếp', cancelButtonText: '<span style="color:#111">Huỷ</span>', confirmButtonColor: '#111', cancelButtonColor: '#fff' });
        if (!r.isConfirmed) return;
        kho = r.value;
    }
    const g = IN_GIAY[kho];

    IN_DANG = true;
    try {
        // Phần mềm in ở máy quầy có chạy không, đủ mới không, đã cài bộ chuẩn chưa
        let st = null;
        try { st = await (await fetch(IN_AGENT + '/health', { cache: 'no-store' })).json(); } catch (e) {}
        if (!st || !st.ok) return inBaoTai('Chưa mở phần mềm in', 'Máy này chưa cài hoặc chưa bật phần mềm in.');
        inGhiMayQuay();
        if (inBanCu(st.version, IN_BAN_TOI_THIEU)) return inBaoTai('Cần cập nhật phần mềm in', `Máy đang chạy bản ${st.version}, cần bản ${IN_BAN_TOI_THIEU} trở lên.`);
        const ch = await inDocChuan(st.version);
        if (ch && !ch.chuan) {
            inKiemBanMay();
            return Swal.fire({ title: 'Máy này chưa cài thông số in', text: IN_CHUA_CAI, icon: 'warning', confirmButtonText: 'Đóng', confirmButtonColor: '#111' });
        }

        const ok = await Swal.fire({
            title: 'In ' + viec,
            html: `<div class="in-giay"><b>${escapeHTML(g.ten)}</b><span>Đặt giấy ${escapeHTML(g.mo)} vào máy in</span></div>${ch ? `<div class="in-chuan">${escapeHTML(inMoTaChuan(ch))}</div>` : ''}`,
            showCancelButton: true, confirmButtonText: 'In', cancelButtonText: '<span style="color:#111">Huỷ</span>', confirmButtonColor: '#111', cancelButtonColor: '#fff'
        });
        if (!ok.isConfirmed) return;

        Swal.fire({ title: 'Đang chuẩn bị tờ in...', allowOutsideClick: false, showConfirmButton: false, didOpen: () => Swal.showLoading() });
        const blob = await inTaiAnh(id);
        const u = URL.createObjectURL(blob);
        let png, W, H;
        try {
            const im = await FR.loadImg(u);
            ({ png, W, H } = await inDungTo(im, g));
            im.src = '';
        } finally { URL.revokeObjectURL(u); }

        Swal.update({ title: 'Đang gửi lệnh in...' });
        const res = await fetch(IN_AGENT + '/print', {
            method: 'POST', body: png,
            headers: {
                'Content-Type': 'image/png', 'X-Copies': '1', 'X-Dialog': '0', 'X-Paper-As-Is': '1', 'X-Src-Dpi': String(IN_DPI),
                'X-Width-Mm': (W / IN_DPI * 25.4).toFixed(3), 'X-Height-Mm': (H / IN_DPI * 25.4).toFixed(3),
                'X-Job-Name': encodeURIComponent(`${viec} ${g.ten} #${cId.split('_')[1].slice(-4)}`), 'X-User': encodeURIComponent(nvTen())
            }
        });
        const d = await res.json().catch(() => ({}));
        if (d.cancelled) { Swal.close(); return; }
        if (!res.ok || !d.ok) throw new Error(d.error || 'Phần mềm in báo lỗi');
        await db.ref(dbPath + br + '/' + cId + '/client_uploads/' + uId + '/daIn').set({ at: Date.now(), by: nvTen(), kho, ban: ban || null }).catch(() => {});
        Swal.close();
        Toast.fire({ icon: 'success', title: `Đã gửi lệnh in ${g.ten}` });
    } catch (e) {
        Swal.fire({ title: 'Chưa in được', text: e.message, icon: 'error', confirmButtonColor: '#111' });
    } finally {
        IN_DANG = false;
    }
}

// Bộ chuẩn của máy in mặc định: { chuan, chuanAt, media, printer }. Bản cũ (< 2.5.0) hoặc
// không đọc được -> null (in như trước, không có dòng kiểm).
async function inDocChuan(ban) {
    if (inBanCu(ban, IN_BAN_CHUAN)) return null;
    try {
        const d = await (await fetch(IN_AGENT + '/settings?printer=', { cache: 'no-store' })).json();
        return d && d.ok && d.settings && typeof d.settings.chuan === 'boolean' ? d.settings : null;
    } catch (e) { return null; }
}

// "Thông số in: Epson Premium Semigloss · cài 17/10 16:05"
function inMoTaChuan(ch) {
    const t = ch.chuanAt ? new Date(ch.chuanAt) : null;
    const p = n => String(n).padStart(2, '0');
    const luc = t && !isNaN(t) ? `cài ${p(t.getDate())}/${p(t.getMonth() + 1)} ${p(t.getHours())}:${p(t.getMinutes())}` : '';
    const giay = ch.media && ch.media !== 'Chưa chọn' ? ch.media : '';
    return 'Thông số in: ' + [giay, luc].filter(Boolean).join(' · ');
}

function inBaoTai(tieuDe, chu) {
    Swal.fire({ title: tieuDe, icon: 'warning', confirmButtonColor: '#111', confirmButtonText: 'Đóng',
        html: `${escapeHTML(chu)}<br><br><a href="${IN_TAI}" target="_blank" rel="noopener" style="color:#111; font-weight:700;">Tải phần mềm in</a>
            <div style="font-size:12px; color:#71717a; margin-top:8px;">Tải xong nhấp đúp để cài (tự thay bản cũ), rồi bấm In lại.</div>` });
}

// Ảnh gốc trên Drive qua quyền của tiệm (đúng từng byte, không qua bản thu nhỏ)
async function inTaiAnh(id) {
    const url = 'https://www.googleapis.com/drive/v3/files/' + id + '?alt=media';
    let res = await fetch(url, { headers: { Authorization: 'Bearer ' + await driveToken() } });
    if (res.status === 401) { _driveToken = ''; res = await fetch(url, { headers: { Authorization: 'Bearer ' + await driveToken() } }); }
    if (!res.ok) throw new Error('Không tải được ảnh gốc (HTTP ' + res.status + ')');
    return res.blob();
}

// Nguyên tờ giấy dọc ở DPI máy in; ảnh ngang thì xoay cho khớp giấy. Ảnh phủ đúng cả tờ
// (ảnh đã đúng khổ), thu / phóng một lần bằng trình duyệt cho mịn.
async function inDungTo(im, g) {
    const W = Math.round(g.w / 25.4 * IN_DPI), H = Math.round(g.h / 25.4 * IN_DPI);
    const iw = im.naturalWidth, ih = im.naturalHeight, ngang = iw > ih;
    const tiLe = Math.max(iw, ih) / Math.min(iw, ih), tiLeGiay = Math.max(g.w, g.h) / Math.min(g.w, g.h);
    if (Math.abs(tiLe - tiLeGiay) > tiLeGiay * 0.02) throw new Error(`Ảnh ${iw}×${ih} không đúng tỉ lệ khổ ${g.ten}, in ra sẽ méo. Kiểm tra khổ in của frame.`);
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, W, H);
    x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
    if (ngang) { x.translate(W, 0); x.rotate(Math.PI / 2); x.drawImage(im, 0, 0, H, W); }
    else x.drawImage(im, 0, 0, W, H);
    const png = await new Promise(r => c.toBlob(r, 'image/png'));
    c.width = c.height = 0;
    if (!png) throw new Error('Máy không dựng được tờ in (thiếu bộ nhớ)');
    return { png, W, H };
}

// ---------- Báo phần mềm in ở máy quầy đã cũ ----------
// Mở trang nhân viên ở máy quầy: hỏi phần mềm in trên máy đó, bản cũ hơn 2.4.0 (chưa biết tự
// cập nhật) thì hiện một dòng nhắc tải bản mới. Chỉ hỏi ở máy quầy (từng dùng app In ảnh Lens
// hoặc nút In): máy khác hỏi localhost thì Chrome bật hộp xin quyền "mạng cục bộ" vô cớ.
const inLaMayQuay = () => { try { return localStorage.getItem('pn_may_in') === '1' || Object.keys(localStorage).some(k => k.startsWith('lenticular_')); } catch (e) { return false; } };
function inGhiMayQuay() { try { localStorage.setItem('pn_may_in', '1'); } catch (e) {} }

async function inKiemBanMay() {
    if (!userRole || userRole === 'viewer' || !inLaMayQuay()) return;
    let st = null;
    try {
        const ac = new AbortController();
        setTimeout(() => ac.abort(), 2500);
        st = await (await fetch(IN_AGENT + '/health', { cache: 'no-store', signal: ac.signal })).json();
    } catch (e) { return; }   // phần mềm in chưa bật: để lúc bấm In hãy báo
    if (!st || !st.ok) return;
    inGhiMayQuay();
    let html = '';
    if (inBanCu(st.version, IN_BAN_TU_CAP_NHAT)) {
        html = `<span>Phần mềm in trên máy này là bản <b>${escapeHTML(st.version)}</b>, đã cũ. Tải bản mới, nhấp đúp file tải về <b>một lần</b> — từ bản ${IN_BAN_TU_CAP_NHAT} máy tự cập nhật.</span>
            <a class="in-ban-cu-nut" href="${IN_TAI}" target="_blank" rel="noopener">Tải bản mới</a>`;
    } else {
        // Máy vừa tự lên 2.5.0 (hoặc mới cài) mà chưa có bộ chuẩn: nhắc ngay, khỏi đợi lúc bấm In
        const ch = await inDocChuan(st.version);
        if (ch && !ch.chuan) html = `<span><b>Máy này chưa cài thông số in.</b> ${escapeHTML(IN_CHUA_CAI)}</span>`;
    }
    let bar = document.getElementById('in-ban-cu');
    if (!html) { if (bar) bar.remove(); return; }
    if (!bar) {
        const menu = document.querySelector('.admin-menu');
        if (!menu) return;
        menu.insertAdjacentHTML('afterend', '<div id="in-ban-cu" class="in-ban-cu"></div>');
        bar = document.getElementById('in-ban-cu');
    }
    bar.innerHTML = html;
}
// Chờ đăng nhập xong (userRole có giá trị) rồi kiểm một lần
(function cho(n) { if (typeof userRole !== 'undefined' && userRole) inKiemBanMay(); else if (n < 60) setTimeout(() => cho(n + 1), 1000); })(0);

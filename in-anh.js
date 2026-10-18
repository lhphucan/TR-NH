// ===== Trang nhân viên: in ảnh thẻ và ảnh ghép frame qua phần mềm in ở máy quầy =====
// Nhân viên chỉ bấm "In": hiện khổ giấy cần đặt, bấm In là in. Không cài đặt gì:
// - máy in = máy in mặc định của Windows ở máy quầy (phần mềm in tự lấy);
// - thông số in = "bộ chuẩn" admin cài một lần trong phần mềm in (không gửi loại giấy / chất lượng);
//   popup ghi loại giấy + ngày cài để nhìn là biết, máy chưa cài thì không cho in;
// - khổ giấy theo ấn phẩm: ảnh thẻ tờ 10×15 (4×6 inch), frame theo khổ in của frame (A5 / A4).
// Web dựng sẵn nguyên tờ giấy đúng DPI máy in (720 với Epson L8050), giấy dọc, rồi gửi như
// app In ảnh Lens (D:\Lenticular App\IN-TU-WEB.md). In đúng 100%, có lề: máy in bỏ ~3 mm sát mép.
// Dựng tờ in (IN_DPI, IN_GIAY, IN_LE_FRAME_MM, inDungTo) ở in-to.js, dùng chung với in từ xa (may-in.html).
// Dùng chung: driveToken, db, br, dbPath, currentData, userRole, Swal, Toast, escapeHTML (admin.js);
// FR (frame-core.js); FK_FRAMES, fkLoadFrames (frame-khach.js); nvUp, nvTen, nvGio (frame-nv.js).

const IN_AGENT = 'http://localhost:9100';
const IN_BAN_TOI_THIEU = '2.3.0';   // 2.3.0: chỉ nhận lệnh từ trang của tiệm
const IN_BAN_TU_CAP_NHAT = '2.4.0'; // từ bản này phần mềm in tự cập nhật, nhân viên không phải làm gì
const IN_BAN_CHUAN = '2.5.0';       // từ bản này có bộ chuẩn (/settings trả chuan, chuanAt)
const IN_BAN_XA = '2.6.0';          // từ bản này laptop quầy nhận lệnh in từ xa (trang ẩn may-in.html)
const IN_CHUA_CAI = 'Chuột phải biểu tượng phần mềm in (chữ N trên ô đen, góc phải dưới màn hình; không thấy thì bấm ^ cạnh đồng hồ) → "Cài thông số in…", chọn preset giấy đúng rồi bấm OK.';
const IN_TAI = 'https://github.com/lhphucan/TR-NH/releases/latest/download/LenticularPrintAgent.exe';
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
    let up = nvUp(cId, uId);
    if (!up) return;
    // Mặc định in bản tiệm chỉnh nếu có, không thì bản khách (đã được ghép lại đủ 100%)
    const nv = up.nv && up.nv.id ? up.nv : null;
    if (!ban) ban = nv ? 'tiem' : 'khach';
    // Bản khách còn là bản tạm (máy khách thiếu bộ nhớ ghép nhỏ, việc ngầm "Bản in 100%" chưa xong):
    // máy quầy ghép bản 100% ngay rồi mới in. In từ xa thì laptop quầy tự ghép (may-in.html).
    if (ban === 'khach' && up.bo && up.du && !up.du.xong && !(userRole === 'admin' && !inLaMayQuay())) {
        up = await inChoBan100(cId, uId, up);
        if (!up) return;
    }
    const id = ban === 'tiem' ? nv && nv.id : Array.isArray(up.drive) && up.drive[0] && up.drive[0].id;
    await fkLoadFrames().catch(() => {});
    await inLam({ cId, uId, id, kho: inKhoGhep(cId, up), ban, le: IN_LE_FRAME_MM, viec: 'ảnh ghép frame' + (ban === 'tiem' ? ' (bản tiệm chỉnh)' : '') });
}

async function inChoBan100(cId, uId, up) {
    Swal.fire({ title: 'Đang ghép bản in 100%...', text: 'Máy khách chỉ gửi được bản nhỏ. Máy này ghép lại bản đủ nét trước khi in.',
        allowOutsideClick: false, showConfirmButton: false, didOpen: () => Swal.showLoading() });
    try { await duLam(br, cId, uId); } catch (e) {}
    const moi = (await db.ref(dbPath + br + '/' + cId + '/client_uploads/' + uId).once('value')).val() || up;
    Swal.close();
    if (moi.du && moi.du.xong) return moi;
    const du = moi.du || {};
    const vi = du.dang && du.dang.by !== LE_MAY && Date.now() - (du.dang.at || 0) < 120000 ? 'Máy khác đang ghép bản 100%, đợi chút rồi bấm In lại. '
        : du.loi ? 'Chưa ghép được: ' + du.loi + '. ' : '';
    const r = await Swal.fire({ title: 'Chưa có bản in 100%', text: `${vi}Bản đang có chỉ ${+du.pt || 0}% cỡ in, in ra sẽ kém nét.`, icon: 'warning', showCancelButton: true,
        confirmButtonText: 'Vẫn in bản này', cancelButtonText: '<span style="color:#111">Đợi</span>', confirmButtonColor: '#111', cancelButtonColor: '#fff' });
    return r.isConfirmed ? moi : null;
}

async function inThe(cId, uId, ban) {
    const up = nvUp(cId, uId);
    // Mặc định in bản tiệm chỉnh nếu có (the-nv.js), không thì tờ khách gửi
    const nv = up && up.nv && up.nv.id ? up.nv : null;
    if (!ban) ban = nv ? 'tiem' : 'khach';
    const id = ban === 'tiem' ? nv && nv.id : up && Array.isArray(up.drive) && up.drive[0] && up.drive[0].id;
    await inLam({ cId, uId, id, kho: '4x6', ban, viec: 'ảnh thẻ' + (ban === 'tiem' ? ' (bản tiệm chỉnh)' : '') });
}

async function inLam({ cId, uId, id, kho, ban, viec, le = 0 }) {
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
    // Admin ở máy không phải máy quầy (điện thoại, máy ở nhà): in tại quán qua laptop quầy.
    // Không thử gọi phần mềm in trên máy này: Chrome sẽ bật hộp xin quyền "mạng cục bộ" vô cớ.
    if (userRole === 'admin' && !inLaMayQuay()) return inXa({ cId, uId, id, kho, ban, viec, le });

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
            ({ png, W, H } = await inDungTo(im, g, le));
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

// ---------- Báo phần mềm in ở máy quầy đã cũ ----------
// Mở trang nhân viên ở máy quầy: hỏi phần mềm in trên máy đó, bản cũ hơn 2.4.0 (chưa biết tự
// cập nhật) thì hiện một dòng nhắc tải bản mới. Chỉ hỏi ở máy quầy (từng dùng app In ảnh Lens
// hoặc nút In): máy khác hỏi localhost thì Chrome bật hộp xin quyền "mạng cục bộ" vô cớ.
const inLaMayQuay = () => { try { return localStorage.getItem('pn_may_in') === '1' || Object.keys(localStorage).some(k => k.startsWith('lenticular_')); } catch (e) { return false; } };
function inGhiMayQuay() { try { localStorage.setItem('pn_may_in', '1'); } catch (e) {} }

async function inKiemBanMay() {
    // Phần mềm in mở trang này kèm ?ghep=1 ("Bật in từ xa" ở biểu tượng chữ N): đây chắc chắn là máy quầy
    if (/[?&]ghep=1\b/.test(location.search)) inGhiMayQuay();
    if (!userRole || userRole === 'viewer' || !inLaMayQuay()) return;
    let st = null;
    try {
        const ac = new AbortController();
        setTimeout(() => ac.abort(), 2500);
        st = await (await fetch(IN_AGENT + '/health', { cache: 'no-store', signal: ac.signal })).json();
    } catch (e) { return; }   // phần mềm in chưa bật: để lúc bấm In hãy báo
    if (!st || !st.ok) return;
    inGhiMayQuay();
    if (!inBanCu(st.version, IN_BAN_XA)) inXaGhep().catch(() => {});
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

// ---------- In từ xa (chỉ admin): gửi lệnh tới laptop quầy, laptop tự in ----------
// Lệnh: in_xa/<cơ sở>/J_<giờ> = { cId, uId, id (ảnh trên Drive), kho, le, ban, viec, ten (khách), by, at,
//        tt: cho | nhan | dang | xong | loi, may, nhanAt, inAt, xongAt, loi }
// Laptop báo đang bật: may_in/<cơ sở>/<mã máy> = { at, ban, giay (khổ in lần trước), giayAt } mỗi 30 giây.
// Laptop: phần mềm in 2.6.0 chạy trang ẩn may-in.html (không cần mở Chrome). Luật Firebase: chỉ admin tạo lệnh.
const IN_XA_SONG = 90000;   // laptop báo trong 90 giây gần nhất = đang bật
const inXaGio = t => t ? new Date(t).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : '';
const inXaMay = ds => Object.values(ds || {}).filter(x => x && x.at).sort((a, b) => b.at - a.at)[0] || null;

async function inXa({ cId, uId, id, kho, ban, viec, le }) {
    const g = IN_GIAY[kho], co = br, ten = (branchesCache[co] || {}).name || co;
    const c = (currentData && currentData[cId]) || {};
    const up = (c.client_uploads || {})[uId] || {};
    const tam = (!ban || ban === 'khach') && up.bo && up.du && !up.du.xong;
    let may = null;
    const ve = () => {
        const el = document.getElementById('inxa-may'); if (!el) return;
        const song = may && Date.now() - may.at < IN_XA_SONG;
        const lech = song && may.giay && IN_GIAY[may.giay] && may.giay !== kho;
        const ngay = t => new Date(t).toDateString() === new Date().toDateString() ? 'hôm nay' : new Date(t).toLocaleDateString('vi-VN');
        el.innerHTML = song
            ? `<span class="inxa-cham"></span><b>Laptop ${escapeHTML(ten)}: đang bật</b><br><span>${may.giay && IN_GIAY[may.giay] ? `Lần in trước: giấy ${IN_GIAY[may.giay].ten} lúc ${inXaGio(may.giayAt)}` : 'Chưa in lần nào'}</span>`
            : `<span class="inxa-cham tat"></span><b>Laptop ${escapeHTML(ten)}: ${may ? 'đang tắt' : 'chưa bật in từ xa'}</b><br><span>${may ? `Bật lần cuối lúc ${inXaGio(may.at)} ${ngay(may.at)}` : 'Laptop quán chưa ghép (phần mềm in 2.6.0, mở trang nhân viên một lần)'}</span>`;
        const canh = document.getElementById('inxa-canh');
        canh.style.display = lech ? '' : 'none';
        if (lech) canh.innerText = `Khay có thể đang là giấy ${IN_GIAY[may.giay].ten}, lần này cần ${g.ten}. Gọi quán đổi giấy trước khi in.`;
        document.getElementById('inxa-ghi').style.display = song || !may ? 'none' : '';
        const nut = Swal.getConfirmButton();
        if (nut) { nut.disabled = !song; nut.innerText = lech ? 'Vẫn in' : 'In tại quán ' + ten; }
    };
    const mayRef = db.ref('may_in/' + co);
    const nghe = sn => { may = inXaMay(sn.val()); ve(); };
    mayRef.on('value', nghe, () => {});
    const hen = setInterval(ve, 10000);   // laptop vừa tắt: quá 90 giây thì đổi sang "đang tắt"
    let ok;
    try {
        ok = await Swal.fire({
            title: 'In ' + viec,
            html: `<div class="in-giay"><b>${escapeHTML(g.ten)}</b><span>Giấy ${escapeHTML(g.mo)}</span></div>
                <div class="inxa-may" id="inxa-may"></div>
                <div class="inxa-canh" id="inxa-canh" style="display:none"></div>
                <div class="inxa-ghi" id="inxa-ghi" style="display:none">Nhờ quán bật laptop (không cần mở trang nào), vài giây sau bảng này tự đổi sang "đang bật".</div>
                ${tam ? `<div class="inxa-ghi">Khách gửi bản nhỏ (${+up.du.pt || 0}%): laptop sẽ ghép bản in 100% trước khi in, thêm khoảng 1 phút.</div>` : ''}`,
            showCancelButton: true, confirmButtonText: 'In tại quán ' + ten, cancelButtonText: '<span style="color:#111">Huỷ</span>',
            confirmButtonColor: '#111', cancelButtonColor: '#fff', didOpen: ve
        });
    } finally { mayRef.off('value', nghe); clearInterval(hen); }
    if (!ok.isConfirmed) return;
    const job = { cId, uId, id, kho, le: le || 0, ban: ban || null, viec, ten: c.name || 'Khách', by: nvTen(), at: Date.now(), tt: 'cho' };
    const ref = db.ref('in_xa/' + co + '/J_' + job.at);
    try { await ref.set(job); }
    catch (e) { return Swal.fire({ title: 'Chưa gửi được lệnh in', text: e.message, icon: 'error', confirmButtonColor: '#111' }); }
    inXaTheoDoi(ref, job, ten, g);
}

// Theo dõi lệnh: Đã gửi lệnh → Laptop đã nhận → Đang in → Đã in. Đóng bảng thì laptop vẫn in tiếp.
function inXaTheoDoi(ref, job, ten, g) {
    let v = job;
    const buoc = (xong, dang, chu, t) => `<div class="inxa-b${xong ? ' xong' : dang ? ' dang' : ''}"><i>${xong ? '✓' : ''}</i>${chu}<small>${xong ? inXaGio(t) : ''}</small></div>`;
    const ve = () => {
        const el = document.getElementById('inxa-buoc'); if (!el) return;
        const tt = v.tt;
        el.innerHTML = buoc(true, false, 'Đã gửi lệnh', v.at)
            + buoc(!!v.nhanAt, tt === 'cho', 'Laptop đã nhận', v.nhanAt)
            + buoc(tt === 'xong', tt === 'dang' || (tt === 'nhan' && !!v.buoc), tt === 'dang' ? 'Đang in...' : tt === 'nhan' && v.buoc ? v.buoc + '...' : 'Đang in', v.inAt)
            + buoc(tt === 'xong', false, 'Đã in', v.xongAt);
        const loi = document.getElementById('inxa-loi');
        loi.style.display = tt === 'loi' ? '' : 'none';
        if (tt === 'loi') loi.innerText = v.loi || 'Laptop báo lỗi';
        document.getElementById('inxa-cho').style.display = tt === 'cho' && Date.now() - v.at > 30000 ? '' : 'none';
        const nut = Swal.getConfirmButton();
        if (nut) nut.innerText = tt === 'xong' || tt === 'loi' ? 'Đóng' : 'Đóng (vẫn in tiếp)';
    };
    const nghe = sn => {
        const moi = sn.val(); if (!moi) return;
        const vua = v.tt !== 'xong' && moi.tt === 'xong';
        v = moi; ve();
        if (vua && !document.getElementById('inxa-buoc')) Toast.fire({ icon: 'success', title: `Đã in tại quán ${ten}` });
    };
    ref.on('value', nghe, () => {});
    const hen = setInterval(ve, 5000);
    Swal.fire({
        title: 'In tại quán ' + ten,
        html: `<div class="inxa-tom">${escapeHTML(String(job.viec || '').replace(/^./, x => x.toUpperCase()))} · ${escapeHTML(g.ten)} · khách ${escapeHTML(job.ten)}</div>
            <div class="inxa-buoc" id="inxa-buoc"></div>
            <div class="inxa-canh" id="inxa-loi" style="display:none"></div>
            <div class="inxa-ghi" id="inxa-cho" style="display:none">Laptop chưa nhận lệnh. Kiểm tra laptop quán có đang bật và có mạng không.</div>`,
        confirmButtonText: 'Đóng (vẫn in tiếp)', confirmButtonColor: '#fff', customClass: { confirmButton: 'inxa-dong' }, didOpen: ve
    }).then(() => {
        clearInterval(hen);
        // đóng bảng rồi vẫn nghe tới khi xong / lỗi để báo một dòng
        if (v.tt === 'xong' || v.tt === 'loi') ref.off('value', nghe);
        else setTimeout(() => ref.off('value', nghe), 10 * 60000);
    });
}

// ---------- Laptop quán: tự ghép in từ xa ----------
// Máy quầy có phần mềm in 2.6.0: trao phiên đăng nhập nhân viên đang mở cho phần mềm in để nó tự đăng
// nhập ngầm nhận lệnh in từ xa (kể cả khi tắt Chrome). Không bao giờ ghép bằng tài khoản admin.
async function inXaGhep() {
    const u = auth && auth.currentUser;
    if (!u || userRole === 'admin' || userRole === 'viewer' || !br || !u.refreshToken) return;
    const s = await (await fetch(IN_AGENT + '/ghep', { cache: 'no-store' })).json().catch(() => null);
    if (s && s.ghep && s.uid === u.uid && s.branch === br) return;
    await fetch(IN_AGENT + '/ghep', { method: 'POST', headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ rt: u.refreshToken, uid: u.uid, branch: br, ten: (branchesCache[br] || {}).name || br }) });
}

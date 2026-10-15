// ===== Trang nhân viên: xem và chỉnh lại ảnh ghép frame khách gửi =====
// Dùng lại đúng trình ghép của trang khách (frame-khach.js) để bản tiệm chỉnh ra
// y như cách khách ghép. File này nạp TRƯỚC frame-khach.js: bù các thứ trang
// khách lấy từ app.js, rồi thêm màn xem hai bản và phần lưu bản tiệm chỉnh.
// Khách gửi kèm bản xếp (client_uploads/<mã>/bo = { lot, frame, o: [{ id, s, ox, oy, r }] }).
// Bản tiệm chỉnh nằm ở client_uploads/<mã>/nv = { id, name, time, at, by, bo, tai },
// chỉ giữ một bản: chỉnh tiếp thì thay bản cũ. Album khách thấy qua framed/<lượt>/N_<giờ>.

// ---------- Bù cho frame-khach.js (trang khách có sẵn trong app.js) ----------
window.FK_NV = true;
var _alb = [], _albLabels = [], _albBranch = '';
var BRANCHES_CACHE = {};
window._albCtx = null;
function moLop() {}
function dongLop() {}
function albZoom() {}
function laDienThoai() { return false; }
// Giống app.js: ảnh lẻ màu frame và bản ghép khung có sẵn của máy chụp
const ANH_LOC = /^PN-(.+?)_(.+?)(\.[a-z0-9]+)?$/i;
function laAnhLoc(name) { return ANH_LOC.test(String(name || '')); }
function banGhepIds(list) {
    const sized = list.filter(x => parseInt(x.size || 0) > 0 && !laAnhLoc(x.name));
    if (sized.length < 3) return new Set();
    const asc = sized.map(x => parseInt(x.size)).sort((a, b) => a - b);
    const base = asc[Math.floor(asc.length / 4)];
    return new Set(sized.filter(x => parseInt(x.size) >= base * 3).map(x => x.id));
}

// ---------- Trạng thái ----------
let NV = null;        // đang chỉnh: { br, cId, uId, goc (bản xếp của khách), ky (dấu lúc mở/lưu) }
let NV_KHACH = [];    // thẻ "Ảnh khách tải lên": [{ id, name, rieng }]; rieng = ảnh gửi in, Drive không công khai
const NV_NAP = {};    // ảnh riêng đang/đã nạp: mã -> Promise
const NV_LOI = new Set();
let NVX = null;       // màn xem: { cId, uId, ban: 'khach' | 'tiem', nv }

const nvUp = (cId, uId) => ((currentData && currentData[cId] && currentData[cId].client_uploads) || {})[uId] || null;
const nvGio = t => new Date(t).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
const nvTen = () => { const u = auth && auth.currentUser; return u ? String(u.displayName || (u.email || '').split('@')[0] || 'nhân viên').slice(0, 30) : 'nhân viên'; };
const nvTenFrame = id => (FK_FRAMES && FK_FRAMES[id] && FK_FRAMES[id].name) || '';
// Bản đang mở để chỉnh: bản tiệm (chỉnh tiếp) nếu có, không thì bản khách
const nvBo = up => (up && up.nv && up.nv.bo) || (up && up.bo) || null;
// Nạp danh sách frame sớm để thẻ khách ghi được tên frame (frame-khach.js nạp sau file này)
document.addEventListener('DOMContentLoaded', () => fkLoadFrames().catch(() => {}));

// ---------- Dòng ảnh ghép trong thẻ khách ----------
function nvHang(cId, uId, up) {
    const e = escapeHTML;
    const khach = Array.isArray(up.drive) && up.drive[0];
    const nv = up.nv && up.nv.id ? up.nv : null;
    const fr = up.bo ? nvTenFrame(up.bo.frame) : '';
    const chip = (ban, id, ten, phu, xanh) => `
        <button type="button" class="nv-chip${xanh ? ' tiem' : ''}" onclick="nvXem('${cId}', '${uId}', '${ban}')" title="Bấm để xem to">
            <span class="nv-chip-im">${id ? `<img src="${e(FR.gUrl(id, 160))}" alt="" loading="lazy">` : ''}</span>
            <span class="nv-chip-tx"><b>${ten}</b><small>${phu}</small></span>
        </button>`;
    return `
        <div class="nv-hang" data-up="${e(uId)}">
            <div class="nv-hang-r">
                <div class="nv-hang-ti">
                    <b>Ảnh ghép frame</b>
                    <small>${[gioGui(up.time), e(fr), up.took != null ? `${+up.took || 0}s · ${+up.mb || 0} MB` : ''].filter(Boolean).join(' · ')}</small>
                </div>
                ${khach ? chip('khach', khach.id, 'Bản khách', up.tai ? 'đã tải ' + nvGio(up.tai) : 'bấm để xem') : ''}
                ${nv ? chip('tiem', nv.id, 'Bản tiệm chỉnh', e(nv.by || '') + ' · ' + (nv.tai ? 'đã tải ' + nvGio(nv.tai) : nvGio(nv.at)), true) : ''}
                <span class="nv-hang-nut">
                    ${up.bo ? `<button type="button" class="up-btn ${nv ? 'ghost' : 'solid'}" onclick="nvMo('${cId}', '${uId}')">${nv ? 'Chỉnh tiếp' : 'Chỉnh lại'}</button>` : ''}
                    ${up.folder ? `<a href="${e(up.folder)}" target="_blank" rel="noopener" class="up-btn ghost nv-thumuc" title="Mở thư mục lượt chụp" aria-label="Mở thư mục"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linejoin="round"/></svg></a>` : ''}
                </span>
            </div>
            ${up.du && up.du.hong && !up.du.xong ? viecDongHong('Bản in 100%', up.du, `duLamLai('${cId}', '${uId}')`) : ''}
            ${up.le && Array.isArray(up.le.photos) ? leDongTrangThai(cId, uId, up.le) : ''}
        </div>`;
}

// ---------- Bản đủ nét: máy quán ghép lại khi máy khách phải ghép nhỏ ----------
// Frame của tiệm 27 triệu điểm, Safari trên iPhone chỉ dựng được tấm ~16,7 triệu
// điểm nên bản khách gửi chỉ ~70% cỡ frame. Khách gửi kèm du = { pt } và bản xếp:
// trang nhân viên đang mở tự ghép lại đúng bản xếp đó ở cỡ đủ từ ảnh gốc, thay vào
// chỗ bản khách (client_uploads drive[0] và album khách), bản nhỏ cho vào thùng rác.
// Chạy chung vòng quét với ảnh lẻ màu frame (leQuet trong admin.js), giữ chỗ du.dang.
async function duLamLai(cId, uId) {
    if (userRole === 'viewer') return;
    await db.ref(dbPath + br + '/' + cId + '/client_uploads/' + uId + '/du').update(Object.assign({}, VIEC_SACH));
    Toast.fire({ icon: 'info', title: 'Đang làm lại' });
    setTimeout(leQuet, 500);
}

// Việc còn dở trong danh sách đang xem (máy khác đang làm trong 2 phút thì để nó làm)
function duViec() {
    if (dbPath !== 'data/' || !currentData || userRole === 'viewer') return null;
    for (const [cId, c] of Object.entries(currentData)) {
        for (const [uId, up] of Object.entries((c && c.client_uploads) || {})) {
            const du = up && up.kind === 'frame' && up.bo && up.du;
            if (du && viecToiLuot(du)) return { cId, uId };
        }
    }
    return null;
}

async function duTai(id, urls) {
    const url = 'https://www.googleapis.com/drive/v3/files/' + id + '?alt=media';
    let res = await fetch(url, { headers: { Authorization: 'Bearer ' + await driveToken() } });
    if (res.status === 401) { _driveToken = ''; res = await fetch(url, { headers: { Authorization: 'Bearer ' + await driveToken() } }); }
    if (!res.ok) throw new Error('không tải được ảnh gốc (HTTP ' + res.status + ')');
    const u = URL.createObjectURL(await res.blob());
    urls.push(u);
    return u;
}

async function duLam(b, cId, uId) {
    const goc = 'data/' + b + '/' + cId + '/client_uploads/' + uId;
    const ref = db.ref(goc + '/du');
    const tx = await ref.child('dang').transaction(cur => (cur && cur.by !== LE_MAY && Date.now() - (cur.at || 0) < 120000) ? undefined : { by: LE_MAY, at: Date.now() });
    if (!tx.committed) return;
    const up = (await db.ref(goc).once('value')).val();
    if (!up || !up.du || up.du.xong || !up.bo) { await ref.child('dang').remove().catch(() => {}); return; }
    // Ghép to mất cả chục giây: báo vẫn đang làm để máy khác không làm trùng
    const giu = setInterval(() => ref.child('dang').set({ by: LE_MAY, at: Date.now() }).catch(() => {}), 30000);
    const urls = [];
    try {
        const bo = up.bo;
        await fkLoadFrames();
        const f = FK_FRAMES[bo.frame];
        if (!f) throw new Error('frame đã bị xoá');
        const frame = Object.assign({ id: bo.frame }, f);
        const loc = await fkFilterFor(frame);
        // Bản gốc đúng từng byte qua quyền Drive của tiệm: frame, lớp PNG, ảnh từng ô
        const lop = {};
        for (const l of FR.layersOf(frame)) {
            const id = l.k === 'frame' ? frame.file : l.k === 'fx' ? l.file : null;
            if (id && !lop[id]) lop[id] = await duTai(id, urls);
        }
        const anh = [];
        for (let i = 0; i < frame.slots.length; i++) {
            const o = bo.o && bo.o[i];
            if (!o || !o.id) { anh.push(null); continue; }
            const src = await duTai(o.id, urls);
            const im = await FR.loadImg(src);
            anh.push({ src, iw: im.naturalWidth, ih: im.naturalHeight, s: +o.s || 1, ox: +o.ox || 0, oy: +o.oy || 0, r: +o.r || 0 });
            im.src = '';
        }
        const cv = FR.canvasFor(frame.w, frame.h);
        if (!cv) throw new Error('máy không đủ bộ nhớ');
        const pt = Math.round(cv.s * 100);
        if (pt <= (+up.du.pt || 0)) { cv.c.width = cv.c.height = 0; throw new Error(`máy thiếu bộ nhớ (${pt}%)`); }
        await FR.compose(cv.x, cv.s, frame, l => lop[l.k === 'frame' ? frame.file : l.file], anh, p => p.src, null, loc && loc.baked);
        let blob = await new Promise(r => cv.c.toBlob(r, 'image/png'));
        if (!blob) blob = await new Promise(r => cv.c.toBlob(r, 'image/jpeg', 1));
        const W = cv.c.width;
        cv.c.width = cv.c.height = 0;
        if (!blob) throw new Error('không xuất được ảnh');
        const cu = Array.isArray(up.drive) && up.drive[0];
        const ten = String((cu && cu.name) || 'GHEP FRAME').replace(/\.[a-z0-9]+$/i, '') + '_100' + (blob.type === 'image/png' ? '.png' : '.jpg');
        const token = await driveToken();
        const fm = await FR.upload(blob, ten, token, bo.lot);
        if (!fm || !fm.id) throw new Error('Drive không nhận ảnh');
        await FR.makePublic(fm.id, token).catch(() => {});
        // Album khách: bản ghép trỏ sang bản đủ nét
        const nhanh = 'data/' + b + '/' + cId;
        const frs = (await db.ref(nhanh + '/framed/' + bo.lot).once('value')).val() || {};
        for (const [k, v] of Object.entries(frs)) if (v && cu && v.id === cu.id) await db.ref(nhanh + '/framed/' + bo.lot + '/' + k + '/id').set(fm.id).catch(() => {});
        const xong = { 'drive/0': { id: fm.id, name: fm.name || ten }, 'du/xong': true, 'du/cu': cu ? cu.id : null, 'du/w': W, 'du/at': Date.now() };
        xong['du/daThu'] = up.du.thu || null;
        Object.keys(VIEC_SACH).forEach(k => { xong['du/' + k] = null; });
        await db.ref(goc).update(xong);
        // Bản nhỏ vào thùng rác Drive (còn khôi phục được 30 ngày)
        if (cu && cu.id) fetch('https://www.googleapis.com/drive/v3/files/' + cu.id, {
            method: 'PATCH', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true })
        }).catch(() => {});
    } catch (e) {
        await viecLoi(ref, up.du, e);
    } finally {
        clearInterval(giu);
        urls.forEach(u => URL.revokeObjectURL(u));
    }
}

// ---------- Màn xem: ảnh to, đổi giữa bản khách và bản tiệm, tải bản đang xem ----------
function nvXem(cId, uId, ban, nvMoi) {
    const up = nvUp(cId, uId);
    if (!up) return;
    NVX = { cId, uId, ban, nv: nvMoi || null };
    if (!document.getElementById('nvx')) {
        document.body.insertAdjacentHTML('beforeend', `
        <div id="nvx" class="nvx" style="display:none;" onclick="if (event.target === this) nvXemDong()">
            <div class="nvx-box">
                <div class="nvx-head">
                    <div class="nvx-ti"><b id="nvx-ten"></b><small id="nvx-phu"></small></div>
                    <button type="button" class="nvx-x" onclick="nvXemDong()" aria-label="Đóng"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" fill="none"/></svg></button>
                </div>
                <div class="nvx-seg" id="nvx-seg"></div>
                <div class="nvx-anh"><img id="nvx-img" alt=""></div>
                <div class="nvx-foot">
                    <span id="nvx-tt"></span>
                    <button type="button" class="nvx-btn" id="nvx-tai" onclick="nvTai(this)"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>Tải bản này</button>
                    <button type="button" class="nvx-btn den" id="nvx-chinh" onclick="nvMo(NVX.cId, NVX.uId)"></button>
                </div>
            </div>
        </div>`);
        document.addEventListener('keydown', ev => { if (ev.key === 'Escape' && NVX && !NV) nvXemDong(); });
    }
    document.getElementById('nvx').style.display = 'flex';
    document.body.style.overflow = 'hidden';
    nvXemVe();
}

// Bản tiệm lấy từ dữ liệu sống; vừa lưu xong mà dữ liệu chưa về (còn bản cũ,
// đã cho vào thùng rác) thì dùng bản vừa lưu
function nvXemNv() {
    const up = nvUp(NVX.cId, NVX.uId) || {};
    const song = up.nv && up.nv.id ? up.nv : null;
    if (NVX.nv && (!song || (NVX.nv.at || 0) > (song.at || 0))) return NVX.nv;
    return song;
}

function nvXemVe() {
    if (!NVX) return;
    const up = nvUp(NVX.cId, NVX.uId) || {};
    const c = currentData[NVX.cId] || {};
    const nv = nvXemNv();
    if (!nv) NVX.ban = 'khach';
    const tiem = NVX.ban === 'tiem';
    const khach = Array.isArray(up.drive) && up.drive[0];
    const id = tiem ? nv.id : khach && khach.id;
    const bo = nvBo(up);
    document.getElementById('nvx-ten').innerText = 'Ảnh ghép · ' + (c.name || 'Khách');
    document.getElementById('nvx-phu').innerText = bo && nvTenFrame(bo.frame) ? 'Frame ' + nvTenFrame(bo.frame) : '';
    const seg = document.getElementById('nvx-seg');
    seg.style.display = nv ? '' : 'none';
    seg.innerHTML = nv ? `
        <button type="button" class="${tiem ? '' : 'on'}" onclick="NVX.ban = 'khach'; nvXemVe()">Bản khách · ${escapeHTML(gioGui(up.time))}</button>
        <button type="button" class="${tiem ? 'on' : ''}" onclick="NVX.ban = 'tiem'; nvXemVe()">Bản tiệm chỉnh · ${escapeHTML(nv.by || '')} ${nvGio(nv.at)}</button>` : '';
    const img = document.getElementById('nvx-img');
    img.src = id ? FR.gUrl(id, 1600) : '';
    const tai = tiem ? (nv.tai || (NVX.taiT && nv.id === (NVX.nv || {}).id ? NVX.taiT : 0)) : (up.tai || NVX.taiK);
    document.getElementById('nvx-tt').innerText = (tiem ? `Bản tiệm chỉnh · ${nv.by || ''} lúc ${nvGio(nv.at)}` : `Bản khách · gửi lúc ${gioGui(up.time)}`)
        + (tai ? ` · đã tải lúc ${nvGio(tai)}` : ' · chưa tải');
    document.getElementById('nvx-tai').disabled = !id;
    const chinh = document.getElementById('nvx-chinh');
    chinh.style.display = up.bo ? '' : 'none';
    chinh.innerText = nv ? 'Chỉnh tiếp' : 'Chỉnh lại';
}

function nvXemDong() {
    document.getElementById('nvx').style.display = 'none';
    document.getElementById('nvx-img').src = '';
    NVX = null;
    document.body.style.overflow = '';
}

async function nvTai(btn) {
    if (!NVX) return;
    const { cId, uId } = NVX;
    const up = nvUp(cId, uId) || {};
    const tiem = NVX.ban === 'tiem';
    const nv = nvXemNv();
    const id = tiem ? nv && nv.id : Array.isArray(up.drive) && up.drive[0] && up.drive[0].id;
    if (!id) return;
    const cu = btn.innerHTML;
    btn.disabled = true;
    btn.innerText = 'Đang tải...';
    try {
        const url = 'https://www.googleapis.com/drive/v3/files/' + id + '?alt=media';
        let res = await fetch(url, { headers: { Authorization: 'Bearer ' + await driveToken() } });
        if (res.status === 401) { _driveToken = ''; res = await fetch(url, { headers: { Authorization: 'Bearer ' + await driveToken() } }); }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const blob = await res.blob();
        const ten = ((currentData[cId] || {}).name || 'Khach').replace(/[^\p{L}\p{N} _-]/gu, '').trim().replace(/\s+/g, '_') || 'Khach';
        const duoi = /png/.test(blob.type) ? 'png' : 'jpg';
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${ten}_${cId.split('_')[1].slice(-4)}_GHEP_${tiem ? 'TIEM' : 'KHACH'}.${duoi}`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
        // Ghi giờ tải để ai cũng biết bản nào đã tải về in
        const at = Date.now();
        await db.ref(dbPath + br + '/' + cId + '/client_uploads/' + uId + (tiem ? '/nv/tai' : '/tai')).set(at).catch(() => {});
        // Dữ liệu sống có thể về sau: giữ sẵn giờ tải để màn xem hiện ngay
        if (NVX) { if (tiem) { if (NVX.nv) NVX.nv.tai = at; NVX.taiT = at; } else NVX.taiK = at; }
        Toast.fire({ icon: 'success', title: 'Đã tải ' + (tiem ? 'bản tiệm chỉnh' : 'bản khách') });
    } catch (e) {
        Swal.fire({ title: 'Không tải được', text: e.message, icon: 'error', confirmButtonColor: '#111' });
    } finally {
        btn.disabled = false;
        btn.innerHTML = cu;
        if (NVX) nvXemVe();
    }
}

// ---------- Mở trình ghép với bản xếp của khách ----------
async function nvMo(cId, uId) {
    if (userRole === 'viewer') return Toast.fire({ icon: 'error', title: 'Tài khoản chỉ xem thu nhập' });
    const up = nvUp(cId, uId);
    const bo = nvBo(up);
    if (!bo || !bo.lot || !bo.frame) return;
    Swal.fire({ title: 'Đang mở bản ghép...', allowOutsideClick: false, showConfirmButton: false, didOpen: () => Swal.showLoading() });
    try {
        await fkLoadFrames();
        const f = FK_FRAMES[bo.frame];
        if (!f) throw new Error('Frame khách dùng đã bị xoá khỏi danh sách frame.');
        const files = (await driveQuery(`'${bo.lot}' in parents and trashed=false and mimeType contains 'image/'`, 'files(id,name,size)'))
            .sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true }));
        _alb = files;
        window._albCtx = { fid: bo.lot, branch: br, clientId: cId, url: '' };
        // Ảnh khách tải lên: ảnh chọn từ máy lúc ghép (trong thư mục lượt) và ảnh gửi in
        const gui = [];
        Object.values(currentData[cId].client_uploads || {}).forEach(u => {
            if (u && u.kind !== 'frame' && u.kind !== 'anhthe' && Array.isArray(u.drive)) u.drive.forEach(d => d && d.id && gui.push({ id: d.id, name: d.name, rieng: true }));
        });
        NV_KHACH = files.filter(x => laAnhKhach(x.name)).map(x => ({ id: x.id, name: x.name })).concat(gui);
        NV = { br, cId, uId, goc: up.bo };
        FK_GOI = 'cao';   // nhân viên dùng được mọi frame
        fkBuild();
        nvGan();
        FKF = Object.assign({ id: bo.frame }, f);
        FKP = FKF.slots.map(() => null);
        FK_SEL = -1; FK_ED = -1;
        document.getElementById('fk-ed').classList.remove('on');
        FKB = await fkFilterFor(FKF);
        [FKF.file, ...fkFxFiles()].forEach(id => fkPrefetch(id).catch(() => {}));
        document.getElementById('fk-modal').style.display = 'flex';
        document.body.style.overflow = 'hidden';
        fkStep('comp');
        document.getElementById('fk-title').innerText = 'Chỉnh lại ảnh ghép · ' + (currentData[cId].name || 'Khách');
        await nvDat(bo);
        NV.ky = nvKy();
        FK_SEL = 0;          // chọn sẵn ô 1: bảng bên phải có ngay nút của ô
        NV_TAB = 'album';
        fkRender();
        const thieu = FKF.slots.filter((_, i) => bo.o && bo.o[i] && !FKP[i]).length;
        Swal.close();
        if (thieu) Toast.fire({ icon: 'warning', title: `${thieu} ô không mở được ảnh, chọn lại giúp` });
    } catch (e) {
        NV = null;
        Swal.fire({ title: 'Chưa mở được', text: e.message, icon: 'error', confirmButtonColor: '#111' });
    }
}

// Đặt ảnh theo bản xếp. chi: chỉ đặt lại một ô
async function nvDat(bo, chi) {
    const o = (bo && bo.o) || [];
    await Promise.all(FKF.slots.map(async (_, i) => {
        if (chi != null && i !== chi) return;
        const p = o[i];
        if (!p || !p.id) { FKP[i] = null; return; }
        try {
            await nvNap(p.id);
            await fkSetPhoto(i, p.id, { s: +p.s || 1, ox: +p.ox || 0, oy: +p.oy || 0, r: +p.r || 0 });
        } catch (e) { FKP[i] = null; }
    }));
}

// Ảnh khách gửi in không công khai: tải bằng quyền Drive của tiệm rồi dùng như
// ảnh trong máy (frame-khach.js nhận ra qua FK_LOCAL)
function nvNap(id) {
    const k = NV_KHACH.find(x => x.id === id);
    if (!k || !k.rieng || FK_LOCAL.some(x => x.id === id)) return Promise.resolve();
    if (NV_NAP[id]) return NV_NAP[id];
    NV_NAP[id] = (async () => {
        const url = 'https://www.googleapis.com/drive/v3/files/' + id + '?alt=media';
        let res = await fetch(url, { headers: { Authorization: 'Bearer ' + await driveToken() } });
        if (res.status === 401) { _driveToken = ''; res = await fetch(url, { headers: { Authorization: 'Bearer ' + await driveToken() } }); }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const blob = await res.blob();
        const file = new File([blob], k.name || 'anh.jpg', { type: blob.type || 'image/jpeg' });
        const p = await FR.shrink(file, 1600, 'image/jpeg');
        FK_LOCAL.push({ id, file, url: URL.createObjectURL(p.blob), full: URL.createObjectURL(file), iw: p.nw, ih: p.nh });
    })().catch(e => { NV_LOI.add(id); delete NV_NAP[id]; throw e; });
    return NV_NAP[id];
}

// Danh sách cho thẻ "Ảnh khách tải lên" (frame-khach.js gọi khi vẽ bảng chọn)
function nvAnhKhach() {
    const can = NV_KHACH.filter(x => x.rieng && !NV_LOI.has(x.id) && !NV_NAP[x.id] && !FK_LOCAL.some(l => l.id === x.id));
    if (can.length) Promise.all(can.map(x => nvNap(x.id).catch(() => {}))).then(() => { if (FK_PK && FK_TAB === 'may') fkPkGrid(); if (NV && NV_TAB === 'may') nvLuoiVe(); });
    return NV_KHACH.map(x => {
        if (!x.rieng) return { id: x.id, src: fkThumb(x.id) };
        const l = FK_LOCAL.find(y => y.id === x.id);
        return l ? { id: x.id, src: l.url } : null;
    }).filter(Boolean);
}

function nvAnhKhachChu() {
    if (NV_KHACH.some(x => x.rieng && !NV_LOI.has(x.id) && !FK_LOCAL.some(l => l.id === x.id))) return 'Đang tải ảnh khách gửi...';
    return NV_KHACH.length ? 'Không mở được ảnh khách gửi.' : 'Khách chưa tải ảnh nào lên.';
}

// Dấu của bản xếp đang có: khác dấu lúc mở là có thay đổi chưa lưu
function nvKy() {
    return JSON.stringify(FKP.map(p => p && [p.id, +(+p.s).toFixed(4), +(+p.ox).toFixed(4), +(+p.oy).toFixed(4), p.r]));
}

// ---------- Một màn kiểu máy tính ----------
// Trình ghép của khách làm cho điện thoại: chạm ô mở màn chỉnh riêng, chọn ảnh mở
// bảng riêng. Máy tính đủ rộng nên gộp một màn: frame bên trái (bấm ô để chọn,
// kéo để dời, lăn chuột để phóng to), bên phải là nút của ô đang chọn và lưới ảnh
// luôn hiện sẵn, bấm ảnh là đặt vào ô.
let NV_TAB = 'album';

function nvGan() {
    if (document.getElementById('nv-pan')) return;
    const m = document.getElementById('fk-modal');
    m.classList.add('nv-pc');
    m.querySelector('.fr-head .fr-x').setAttribute('onclick', 'nvDong()');
    const comp = document.getElementById('fk-comp');
    const st = document.getElementById('fk-stage');
    const foot = comp.querySelector('.fk-foot');
    comp.insertAdjacentHTML('afterbegin', `
        <div id="nv-trai"><div id="nv-khung"></div>
            <p class="nv-goiy">Bấm ô để chọn · kéo để dời ảnh · lăn chuột để phóng to</p></div>
        <div id="nv-pan">
            <div class="nvp-o">
                <div class="nvp-ti"><b id="nvp-so"></b><small id="nvp-nguon"></small></div>
                <div id="nvp-co">
                    <label class="nvp-lb" for="nvp-zoom">Phóng to <span id="nvp-pt"></span></label>
                    <input type="range" id="nvp-zoom" min="1" max="4" step="0.01" value="1" oninput="fkZoom(this.value)">
                    <div class="nvp-hang">
                        <button type="button" class="fr-btn" onclick="fkOp('rot')">Xoay 90°</button>
                        <button type="button" class="fr-btn" id="nvp-ve-o" onclick="nvVeO()">Như bản khách</button>
                        <button type="button" class="fr-btn danger" onclick="fkOp('del')">Bỏ ảnh</button>
                    </div>
                </div>
                <p class="fr-hint" id="nvp-trong">Ô trống: bấm một ảnh bên dưới để đặt vào ô này.</p>
            </div>
            <div class="nvp-tabs">
                <button type="button" class="fr-tab" id="nvp-t-album" onclick="nvTab('album')">Ảnh lượt chụp</button>
                <button type="button" class="fr-tab" id="nvp-t-may" onclick="nvTab('may')">Ảnh khách tải lên</button>
            </div>
            <p class="fr-hint nvp-gt">Bấm ảnh để đặt vào ô đang chọn.</p>
            <div id="nvp-luoi" class="nvp-luoi"></div>
        </div>`);
    document.getElementById('nv-khung').appendChild(st);
    document.getElementById('nv-pan').appendChild(foot);
    const done = document.getElementById('fk-done');
    done.innerText = 'Lưu bản chỉnh';
    done.insertAdjacentHTML('beforebegin', '<button type="button" class="fr-btn" id="nv-ve" onclick="nvVe()">Cả frame như bản khách</button>');
    nvGanKeo(st);
}

// Bấm ô để chọn, kéo để dời ảnh của ô, lăn chuột để phóng to ô dưới con trỏ
function nvGanKeo(st) {
    let keo = null;
    const oAt = e => {
        const r = st.getBoundingClientRect(), k = st.clientWidth / FKF.w;
        return { i: FR.slotAt(FKF.slots, (e.clientX - r.left) / k, (e.clientY - r.top) / k), k };
    };
    st.addEventListener('pointerdown', e => {
        if (!NV || !FKF) return;
        const { i, k } = oAt(e);
        if (i < 0) return;
        const doi = FK_SEL !== i;
        FK_SEL = i;
        if (FKP[i]) { keo = { i, k, x: e.clientX, y: e.clientY, ox: FKP[i].ox, oy: FKP[i].oy }; st.setPointerCapture(e.pointerId); }
        if (doi) nvRender();
    });
    st.addEventListener('pointermove', e => {
        if (!keo || !FKP[keo.i]) return;
        const s = FKF.slots[keo.i], p = FKP[keo.i];
        // Đổi độ dời trên màn sang trục của ô (ô có thể đang xoay)
        const ang = -s.rot * Math.PI / 180;
        const dx = (e.clientX - keo.x) / keo.k, dy = (e.clientY - keo.y) / keo.k;
        p.ox = keo.ox + (dx * Math.cos(ang) - dy * Math.sin(ang)) / s.w;
        p.oy = keo.oy + (dx * Math.sin(ang) + dy * Math.cos(ang)) / s.h;
        FR.clamp(s, p);
        nvKhungVe();
    });
    const het = () => { keo = null; };
    st.addEventListener('pointerup', het);
    st.addEventListener('pointercancel', het);
    st.addEventListener('wheel', e => {
        if (!NV || !FKF) return;
        const { i } = oAt(e);
        if (i < 0 || !FKP[i]) return;
        e.preventDefault();
        const doi = FK_SEL !== i;
        FK_SEL = i;
        FKP[i].s *= e.deltaY < 0 ? 1.06 : 1 / 1.06;
        FR.clamp(FKF.slots[i], FKP[i]);
        nvKhungVe();
        if (doi) nvRender(); else nvBangVe();
    }, { passive: false });
}

// frame-khach.js gọi qua fkRender
function nvRender() {
    if (!FKF || !document.getElementById('nv-pan')) return;
    nvKhungVe();
    nvBangVe();
    nvLuoiVe();
    const n = FKP.filter(Boolean).length;
    document.getElementById('fk-prog').innerText = `${n}/${FKF.slots.length} ô có ảnh`;
    document.getElementById('fk-done').disabled = n === 0;
}

// Frame to vừa khung bên trái, ô đang chọn có viền, mỗi ô ghi số
function nvKhungVe() {
    const st = document.getElementById('fk-stage'), box = document.getElementById('nv-trai');
    if (!FKF || !st || !box) return;
    const W = Math.max(160, Math.min(box.clientWidth - 48, (box.clientHeight - 64) * FKF.w / FKF.h));
    st.style.width = W + 'px';
    st.style.height = (W * FKF.h / FKF.w) + 'px';
    const k = W / FKF.w;
    st.innerHTML = fkStageHtml(k)
        + FKF.slots.map((s, i) => `<div class="nv-o${i === FK_SEL ? ' on' : ''}" style="${FR.boxCss(s, k)}"><b style="transform:rotate(${-s.rot}deg)">${i + 1}</b></div>`).join('');
}

// Phần trên bảng phải: ô đang chọn, ảnh gì, phóng bao nhiêu
function nvBangVe() {
    if (!FKF) return;
    const i = FK_SEL, p = FKP[i];
    document.getElementById('nvp-so').innerText = i >= 0 ? `Ô ${i + 1} / ${FKF.slots.length}` : 'Bấm chọn một ô';
    document.getElementById('nvp-nguon').innerText = !p ? (i >= 0 ? 'chưa có ảnh' : '') : nvTenAnh(p.id);
    document.getElementById('nvp-co').style.display = p ? '' : 'none';
    document.getElementById('nvp-trong').style.display = i >= 0 && !p ? '' : 'none';
    if (p) {
        document.getElementById('nvp-zoom').value = p.s;
        document.getElementById('nvp-pt').innerText = Math.round(p.s * 100) + '%';
    }
    const goc = NV && NV.goc && NV.goc.o && NV.goc.o[i];
    document.getElementById('nvp-ve-o').disabled = !goc;
}

// "Ảnh 7 · lượt chụp" / "Ảnh khách tải lên": số giống cách album khách đánh số
function nvTenAnh(id) {
    const j = fkPhotos().findIndex(x => x.id === id);
    if (j >= 0) return `Ảnh ${j + 1} · lượt chụp`;
    return NV_KHACH.some(x => x.id === id) ? 'Ảnh khách tải lên' : '';
}

function nvTab(t) {
    NV_TAB = t;
    nvLuoiVe();
}

// Lưới ảnh luôn hiện: ảnh nào đang ở ô nào ghi số ô, ảnh của ô đang chọn có viền
function nvLuoiVe() {
    const luoi = document.getElementById('nvp-luoi');
    if (!luoi || !FKF) return;
    document.getElementById('nvp-t-album').classList.toggle('on', NV_TAB === 'album');
    document.getElementById('nvp-t-may').classList.toggle('on', NV_TAB === 'may');
    const at = {};
    FKP.forEach((p, i) => { if (p) (at[p.id] = at[p.id] || []).push(i + 1); });
    const dang = FK_SEL >= 0 && FKP[FK_SEL] ? FKP[FK_SEL].id : '';
    const list = NV_TAB === 'album'
        ? fkPhotos().map((x, j) => ({ id: x.id, src: fkThumb(x.id), ten: 'Ảnh ' + (j + 1) }))
        : nvAnhKhach().map((x, j) => Object.assign({ ten: 'Khách ' + (j + 1) }, x));
    luoi.innerHTML = list.map(x => `
        <button type="button" class="nvp-anh${x.id === dang ? ' on' : ''}" data-id="${escapeHTML(x.id)}" title="Đặt vào ô đang chọn">
            <span class="nvp-anh-ph"><img src="${escapeHTML(x.src)}" alt="" loading="lazy" decoding="async"></span>
            <span class="nvp-anh-ten">${escapeHTML(x.ten)}</span>
            ${at[x.id] ? `<span class="nvp-anh-o">ô ${at[x.id].join(', ')}</span>` : ''}
        </button>`).join('')
        || `<p class="fr-hint" style="grid-column:1/-1;">${escapeHTML(NV_TAB === 'album' ? 'Lượt chụp chưa có ảnh nào.' : nvAnhKhachChu())}</p>`;
    luoi.querySelectorAll('.nvp-anh').forEach(b => b.onclick = () => nvChon(b.dataset.id));
}

async function nvChon(id) {
    if (FK_SEL < 0) return Toast.fire({ icon: 'info', title: 'Bấm chọn một ô trên frame trước' });
    const i = FK_SEL;
    try {
        await nvNap(id);
        await fkSetPhoto(i, id);
    } catch (e) {
        return Swal.fire({ title: 'Chưa mở được ảnh', text: 'Thử lại giúp mình nhé.', icon: 'error', confirmButtonColor: '#111' });
    }
    nvRender();
}

async function nvVe() {
    if (!NV || !NV.goc) return;
    await nvDat(NV.goc);
    nvRender();
    Toast.fire({ icon: 'info', title: 'Đã về như bản khách' });
}

async function nvVeO() {
    if (!NV || !NV.goc || FK_SEL < 0) return;
    await nvDat(NV.goc, FK_SEL);
    nvRender();
}

async function nvDong() {
    if (NV && NV.ky !== nvKy()) {
        const r = await Swal.fire({ title: 'Chưa lưu bản chỉnh', text: 'Đóng thì mất các chỗ vừa sửa.', icon: 'warning', showCancelButton: true,
                                    confirmButtonText: 'Bỏ, đóng lại', cancelButtonText: '<span style="color:#111">Chỉnh tiếp</span>', confirmButtonColor: '#111', cancelButtonColor: '#fff' });
        if (!r.isConfirmed) return;
    }
    NV = null;
    fkClose();
    // Màn xem vẫn mở bên dưới thì giữ khoá cuộn trang
    if (NVX) document.body.style.overflow = 'hidden';
}

// Gọi từ fkExport khi đã ghép xong bản cỡ in (FK_RES)
async function nvLuu(btn) {
    if (!NV || !FK_RES) return;
    // Máy này cũng thiếu bộ nhớ, ghép không đủ cỡ frame: báo trước khi lưu
    if (FK_RES.w < FKF.w) {
        const r = await Swal.fire({ title: 'Ảnh chưa đủ cỡ in', icon: 'warning', showCancelButton: true,
            text: `Máy này chỉ ghép được ${Math.round(FK_RES.w / FKF.w * 100)}%. Nên lưu trên máy khác.`,
            confirmButtonText: 'Vẫn lưu', cancelButtonText: '<span style="color:#111">Huỷ</span>', confirmButtonColor: '#111', cancelButtonColor: '#fff' });
        if (!r.isConfirmed) return;
    }
    const { cId, uId } = NV;
    const nhanh = NV.br;
    const c = currentData[cId] || {};
    const up = nvUp(cId, uId) || {};
    const bo = { lot: _albCtx.fid, frame: FKF.id, o: FKP.map(p => p ? { id: p.id, s: p.s, ox: p.ox, oy: p.oy, r: p.r } : null) };
    const token = await driveToken();
    const now = new Date();
    const hhmmss = [now.getHours(), now.getMinutes(), now.getSeconds()].map(x => String(x).padStart(2, '0')).join('');
    const cName = String(c.name || 'Khach').replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 40) || 'Khach';
    const duoi = FK_RES.blob.type === 'image/png' ? '.png' : '.jpg';
    const name = `${cName}_${cId.split('_')[1].slice(-4)}_GHEP FRAME TIEM CHINH_${hhmmss}${duoi}`;
    const f = await FR.upload(FK_RES.blob, name, token, bo.lot, v => { btn.innerText = `Đang lưu ${Math.round(v * 100)}%`; });
    if (!f || !f.id) throw new Error('Drive không nhận ảnh');
    await FR.makePublic(f.id, token).catch(() => {});
    const time = now.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) + ' ' + now.toLocaleDateString('vi-VN');
    const nv = { id: f.id, name: f.name || name, time, at: Date.now(), by: nvTen(), bo };
    const goc = dbPath + nhanh + '/' + cId;
    await db.ref(goc + '/client_uploads/' + uId + '/nv').set(nv);
    // Hiện trong album khách, cạnh bản khách tự ghép
    await db.ref(goc + '/framed/' + bo.lot + '/N_' + uId.replace(/^U_/, '')).set({ time, id: f.id, frame: FKF.id, nv: true }).catch(() => {});
    // Chỉ giữ một bản tiệm chỉnh: bản trước cho vào thùng rác Drive
    const cu = up.nv && up.nv.id;
    if (cu && cu !== f.id) fetch('https://www.googleapis.com/drive/v3/files/' + cu, {
        method: 'PATCH', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true })
    }).catch(() => {});
    NV = null;
    fkClose();
    nvXem(cId, uId, 'tiem', nv);
    Toast.fire({ icon: 'success', title: 'Đã lưu bản tiệm chỉnh' });
}

// ---------- Theo dõi việc ngầm ----------
// Việc tự chạy nên không ai phải canh, nhưng vẫn cần một chỗ xem: việc nào đang
// chờ, đang làm, đang thử lại vì lỗi gì, hỏng hẳn, và việc chờ lâu mà chưa máy
// nào nhận (thường là không máy quán nào mở trang nhân viên). Nhân viên xem cơ sở
// của mình, admin xem mọi cơ sở. Đọc 3 ngày gần nhất mỗi lần mở / bấm Tải lại.
const VIEC_NGAY = 3;
const VIEC_CHO_LAU = 10 * 60000;
let VIEC_DS = [], VIEC_AN_XONG = true;

function viecTrangThai(v, gui) {
    const now = Date.now();
    if (v.xong) return { k: 5, mau: '#a1a1aa', chu: 'Xong' + (v.xongAt || v.at ? ' ' + nvGio(v.xongAt || v.at) : '') + (v.daThu ? ` · sau ${v.daThu} lần lỗi` : '') };
    if (v.hong) return { k: 0, mau: '#ef4444', chu: `Hỏng hẳn (${v.thu || 0} lần)` };
    if (v.dang && now - (v.dang.at || 0) < 120000) return { k: 3, mau: '#52525b', chu: 'Đang làm' };
    if (v.thu) return { k: 1, mau: '#18181b', chu: `Thử lại lần ${v.thu + 1}` + (v.sau ? ' lúc ' + nvGio(v.sau) : '') };
    if (gui && now - gui > VIEC_CHO_LAU) return { k: 2, mau: '#18181b', chu: 'Chờ lâu – chưa máy quán nào nhận' };
    return { k: 4, mau: '#71717a', chu: 'Đang chờ' };
}

// Cơ sở được xem: admin mọi cơ sở, nhân viên cơ sở của mình
const viecCoSo = () => userRole === 'admin' ? Object.keys(branchesCache || {}) : (br ? [br] : []);

async function viecTai() {
    const tu = 'S_' + (Date.now() - VIEC_NGAY * 864e5);
    const ds = [];
    for (const b of viecCoSo()) {
        const d = (await db.ref('data/' + b).orderByKey().startAt(tu).once('value')).val() || {};
        Object.entries(d).forEach(([cId, c]) => Object.entries((c && c.client_uploads) || {}).forEach(([uId, u]) => {
            if (!u || u.kind !== 'frame') return;
            const gui = parseInt(uId.split('_')[1]) || 0;
            const chung = { b, cId, uId, gui, ten: c.name || 'Khách', ma: cId.split('_')[1].slice(-4), coSo: (branchesCache[b] || {}).name || b };
            if (u.le && u.le.photos) {
                const tong = Object.keys(u.le.photos).length;
                ds.push(Object.assign({ loai: 'le', viec: `Ảnh lẻ màu ${u.le.ten || 'frame'} (${Math.min(u.le.n || 0, tong)}/${tong})`, v: u.le, st: viecTrangThai(u.le, gui) }, chung));
            }
            if (u.du) ds.push(Object.assign({ loai: 'du', viec: `Bản in 100% (khách ${+u.du.pt || 0}%)`, v: u.du, st: viecTrangThai(u.du, gui) }, chung));
        }));
    }
    VIEC_DS = ds.sort((x, y) => x.st.k - y.st.k || y.gui - x.gui);
}

async function viecMo() {
    if (userRole === 'viewer') return;
    if (!document.getElementById('vx')) {
        document.body.insertAdjacentHTML('beforeend', `
        <div id="vx" class="nvx" style="display:none;" onclick="if (event.target === this) viecDong()">
            <div class="nvx-box vx-box">
                <div class="nvx-head">
                    <div class="nvx-ti"><b>Việc ngầm</b><small id="vx-phu"></small></div>
                    <button type="button" class="nvx-btn vx-lai" onclick="viecMoLai()">Tải lại</button>
                    <button type="button" class="nvx-x" onclick="viecDong()" aria-label="Đóng"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" fill="none"/></svg></button>
                </div>
                <div class="vx-tom" id="vx-tom"></div>
                <div class="vx-ds" id="vx-ds"></div>
            </div>
        </div>`);
    }
    document.getElementById('vx-phu').innerText = (userRole === 'admin' ? 'Mọi cơ sở' : ((branchesCache[br] || {}).name || br)) + ` · ${VIEC_NGAY} ngày gần nhất`;
    document.getElementById('vx').style.display = 'flex';
    document.body.style.overflow = 'hidden';
    await viecMoLai();
}

async function viecMoLai() {
    document.getElementById('vx-ds').innerHTML = '<p class="fr-hint" style="padding:16px;">Đang tải...</p>';
    try { await viecTai(); } catch (e) { document.getElementById('vx-ds').innerHTML = `<p class="fr-hint" style="padding:16px;">Chưa tải được: ${escapeHTML(e.message)}</p>`; return; }
    viecVe();
}

function viecVe() {
    const dem = [0, 0, 0, 0, 0, 0];
    VIEC_DS.forEach(x => dem[x.st.k]++);
    const chip = (n, chu, mau) => n ? `<span class="vx-chip" style="color:${mau};"><b>${n}</b> ${chu}</span>` : '';
    document.getElementById('vx-tom').innerHTML = (chip(dem[0], 'hỏng hẳn', '#ef4444') + chip(dem[1], 'đang thử lại', '#18181b') + chip(dem[2], 'chờ lâu', '#18181b')
        + chip(dem[3], 'đang làm', '#52525b') + chip(dem[4], 'đang chờ', '#52525b') + chip(dem[5], 'xong', '#a1a1aa') || '<span class="vx-chip">Không có việc nào</span>')
        + `<label class="vx-an"><input type="checkbox" ${VIEC_AN_XONG ? 'checked' : ''} onchange="VIEC_AN_XONG = this.checked; viecVe()"> Ẩn việc đã xong</label>`;
    const nhieuCoSo = userRole === 'admin';
    const ds = VIEC_DS.filter(x => !(VIEC_AN_XONG && x.st.k === 5));
    document.getElementById('vx-ds').innerHTML = ds.map(x => `
        <div class="vx-dong">
            <div><b>#${escapeHTML(x.ma)} ${escapeHTML(x.ten)}</b><small>${nhieuCoSo ? escapeHTML(x.coSo) + ' · ' : ''}gửi ${nvGio(x.gui)} ${getDStr(new Date(x.gui)).slice(0, 5)}</small></div>
            <div>${escapeHTML(x.viec)}</div>
            <div><b style="color:${x.st.mau};">${escapeHTML(x.st.chu)}</b>${x.v.loi && !x.v.xong ? `<small>${escapeHTML(x.v.loi)}</small>` : ''}</div>
            <div>${x.st.k <= 2 ? `<button type="button" class="up-btn ghost" onclick="viecLamLai('${x.b}', '${x.cId}', '${x.uId}', '${x.loai}')">THỬ LẠI NGAY</button>` : ''}</div>
        </div>`).join('') || `<p class="fr-hint" style="padding:16px;">${VIEC_DS.length ? 'Mọi việc đã xong.' : 'Không có việc ngầm nào trong ' + VIEC_NGAY + ' ngày qua.'}</p>`;
}

async function viecLamLai(b, cId, uId, loai) {
    if (userRole === 'viewer') return;
    const goc = 'data/' + b + '/' + cId + '/client_uploads/' + uId + '/' + loai;
    await db.ref(goc).update(Object.assign(loai === 'le' ? { xong: null, n: 0, xongAt: null, daThu: null } : {}, VIEC_SACH));
    Toast.fire({ icon: 'info', title: b === br ? 'Đang làm lại' : 'Đã xếp lại, máy quán của cơ sở đó sẽ làm' });
    if (b === br) setTimeout(leQuet, 500);
    setTimeout(viecMoLai, 1500);
}

function viecDong() {
    document.getElementById('vx').style.display = 'none';
    document.body.style.overflow = '';
}

// Số đỏ trên nút "Việc ngầm": việc hỏng hẳn / đang thử lại trong danh sách đang xem
function viecDem() {
    const so = document.getElementById('viec-so');
    if (!so || userRole === 'viewer' || dbPath !== 'data/') return;
    let n = 0;
    Object.values(currentData || {}).forEach(c => Object.values((c && c.client_uploads) || {}).forEach(u => {
        [u && u.le, u && u.du].forEach(v => { if (v && !v.xong && (v.hong || v.thu)) n++; });
    }));
    so.innerText = n || '';
    so.style.display = n ? '' : 'none';
}
setInterval(viecDem, 20000);

// ===== Trang nhân viên: ảnh thẻ khách gửi in — xem, in, chỉnh lại y hệt khách đã làm =====
// Khách gửi (anh-the-khach.js) kèm the = { v, goc: mã ảnh gốc trên Drive, may: ảnh từ máy khách, st: trạng thái }
// st (anh-the.html trangThai): thông số tách nền + khổ, nền, 3 thanh chỉnh, độ gọn tóc, số ảnh + mọi nét sửa tay.
// "Chỉnh lại" mở anh-the.html?nv=1 trong khung phủ cả màn: máy quầy tách nền đúng thông số máy khách đã dùng
// rồi áp lại trạng thái (nét sửa tay theo toạ độ lớp người nên phải cùng thông số). Lưu = bản tiệm chỉnh:
// tờ in vào cùng thư mục với tờ khách gửi (thư mục lượt chụp -> album khách thấy), giữ cả hai bản, chỉ giữ
// một bản tiệm (bản trước vào thùng rác Drive), nút In mặc định in bản tiệm. Như ảnh ghép frame (frame-nv.js).
// Yêu cầu cũ (chưa có the) chỉ xem / tải / in được.
// Dùng chung: escapeHTML, gioGui, currentData, dbPath, br, driveToken, Swal, Toast (admin.js);
// FR (frame-core.js); nvUp, nvGio, nvTen, nvXem (frame-nv.js); inNut, inDaIn, inTaiAnh (in-anh.js).

const THE_BAN = '9ffe31ad';   // số của anh-the.html (cong-cu/gan-so-ban.js gắn): máy quầy bỏ bản cũ trong bộ nhớ đệm
let THEX = null;      // { cId, uId, nhanh, st0 } màn chỉnh đang mở
let THEX_SAN = false, THEX_HOI = null, THEX_LUU = false;

// Tóm tắt trạng thái: "8 ảnh 3.5×4.5 · nền xanh"
function theTomTat(st) {
    try {
        const o = typeof st === 'string' ? JSON.parse(st) : st;
        const so = Object.entries(o.so || {}).filter(([, v]) => v > 0).map(([k, v]) => `${v} ảnh ${k}`).join(', ');
        return so;
    } catch (e) { return ''; }
}

// Một dòng gọn như ảnh ghép frame: bản khách / bản tiệm, In, Chỉnh lại / Chỉnh tiếp, thư mục
function theHang(cId, uId, up) {
    const e = escapeHTML;
    const khach = Array.isArray(up.drive) && up.drive[0];
    const nv = up.nv && up.nv.id ? up.nv : null;
    const phu = [gioGui(up.time), up.the ? theTomTat(up.the.st) : '', up.took != null ? `${+up.took || 0}s · ${+up.mb || 0} MB` : '', inDaIn(up)].filter(Boolean).join(' · ');
    const chip = (ban, id, ten, p, den) => `
        <button type="button" class="nv-chip${den ? ' tiem' : ''}" onclick="nvXem('${cId}', '${uId}', '${ban}')" title="Bấm để xem to">
            <span class="nv-chip-im">${id ? `<img src="${e(FR.gUrl(id, 160))}" alt="" loading="lazy" onerror="this.remove()">` : ''}</span>
            <span class="nv-chip-tx"><b>${ten}</b><small>${p}</small></span>
        </button>`;
    return `
        <div class="nv-hang" data-up="${e(uId)}">
            <div class="nv-hang-r">
                <div class="nv-hang-ti">
                    <b>Ảnh thẻ</b>
                    <small title="${phu}">${phu}</small>
                </div>
                ${khach ? chip('khach', khach.id, 'Bản khách', up.tai ? 'đã tải ' + nvGio(up.tai) : 'bấm để xem') : ''}
                ${nv ? chip('tiem', nv.id, 'Bản tiệm chỉnh', e(nv.by || '') + ' · ' + (nv.tai ? 'đã tải ' + nvGio(nv.tai) : nvGio(nv.at)), true) : ''}
                <span class="nv-hang-nut">
                    ${khach ? inNut('4x6', `inThe('${cId}', '${uId}')`) : ''}
                    ${up.the ? `<button type="button" class="up-btn ${nv ? 'ghost' : 'solid'}" onclick="theMo('${cId}', '${uId}')">${nv ? 'Chỉnh tiếp' : 'Chỉnh lại'}</button>` : ''}
                    ${up.folder ? `<a href="${e(up.folder)}" target="_blank" rel="noopener" class="up-btn ghost nv-thumuc" title="Mở thư mục" aria-label="Mở thư mục"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linejoin="round"/></svg></a>` : ''}
                </span>
            </div>
        </div>`;
}

// ---------- Màn chỉnh: anh-the.html?nv=1 trong khung phủ cả màn ----------
function theKhung() {
    let lop = document.getElementById('thex');
    if (lop) return lop;
    document.body.insertAdjacentHTML('beforeend', `
        <div id="thex" class="thex" style="display:none;">
            <div class="thex-cho" id="thex-cho"><div class="thex-xoay"></div><b id="thex-chu">Đang mở ảnh thẻ...</b></div>
            <iframe id="thex-khung" title="Chỉnh lại ảnh thẻ" src="./anh-the.html?nv=1&v=${THE_BAN}"></iframe>
        </div>`);
    return document.getElementById('thex');
}
const theGui = m => { const k = document.getElementById('thex-khung'); if (k && k.contentWindow) k.contentWindow.postMessage(m, location.origin); };

async function theMo(cId, uId) {
    if (userRole === 'viewer') return;
    const up = nvUp(cId, uId);
    if (!up) return;
    if (!up.the || !up.the.goc || !up.the.st) return Swal.fire({ title: 'Chưa chỉnh lại được', text: 'Yêu cầu này gửi từ bản cũ, chưa lưu cách khách làm. Chỉ xem, tải, in được.', icon: 'info', confirmButtonColor: '#111' });
    const nv = up.nv && up.nv.id && up.nv.the && up.nv.the.st ? up.nv : null;
    const st = nv ? nv.the.st : up.the.st;
    const lop = theKhung();
    lop.style.display = 'block';
    document.body.style.overflow = 'hidden';
    document.getElementById('thex-cho').style.display = 'flex';
    document.getElementById('thex-chu').innerText = 'Đang tải ảnh gốc...';
    THEX = { cId, uId, nhanh: br, st0: st };
    theGui({ t: 'xoa' });   // khung còn ảnh lần mở trước (có thể của khách khác): xoá ngay
    try {
        const blob = await inTaiAnh(up.the.goc);
        // Chờ trang ảnh thẻ sẵn sàng (lần đầu tải phần mềm)
        for (let i = 0; !THEX_SAN && i < 600; i++) await new Promise(r => setTimeout(r, 100));
        if (!THEX_SAN) throw new Error('Trang ảnh thẻ chưa mở được');
        if (!THEX || THEX.uId !== uId) return;
        document.getElementById('thex-cho').style.display = 'none';
        theGui({ t: 'nap', blob, ten: 'goc.jpg', nguon: { id: up.the.goc }, st });
    } catch (e) {
        theAn();
        Swal.fire({ title: 'Chưa mở được', text: e.message, icon: 'error', confirmButtonColor: '#111' });
    }
}

function theAn() {
    theGui({ t: 'xoa' });
    const lop = document.getElementById('thex');
    if (lop) lop.style.display = 'none';
    document.body.style.overflow = '';
    THEX = null;
}

// Nút × của trang ảnh thẻ gọi thẳng hàm này (cùng nguồn). Chỉnh mà chưa lưu thì hỏi.
window.atDongTuKhung = async () => {
    if (!THEX || THEX_LUU) return;
    const st = await new Promise(ok => { THEX_HOI = ok; theGui({ t: 'hoi' }); setTimeout(() => { if (THEX_HOI) { THEX_HOI = null; ok(''); } }, 1500); });
    if (st && st !== THEX.st0) {
        const r = await Swal.fire({ title: 'Đóng mà không lưu?', text: 'Chỗ vừa chỉnh sẽ mất.', icon: 'warning', showCancelButton: true,
            confirmButtonText: 'Đóng', cancelButtonText: '<span style="color:#111">Ở lại</span>', confirmButtonColor: '#111', cancelButtonColor: '#fff' });
        if (!r.isConfirmed) return;
    }
    theAn();
};

window.addEventListener('message', async e => {
    const k = document.getElementById('thex-khung');
    if (e.origin !== location.origin || !k || e.source !== k.contentWindow || !e.data) return;
    const m = e.data;
    if (m.t === 'san') THEX_SAN = true;
    else if (m.t === 'dong') window.atDongTuKhung();
    else if (m.t === 'st' && THEX_HOI) { const c = THEX_HOI; THEX_HOI = null; c(m.st || ''); }
    else if (m.t === 'gui') {
        try { await theLuu(m); theGui({ t: 'gui-xong' }); }
        catch (er) { Swal.fire({ title: 'Chưa lưu được', text: er.message, icon: 'error', confirmButtonColor: '#111' }); theGui({ t: 'gui-loi', msg: er.message }); }
    }
});

// Lưu bản tiệm chỉnh: tờ in vào cùng thư mục tờ khách gửi, ghi nv (kèm trạng thái để Chỉnh tiếp)
async function theLuu(m) {
    if (!THEX || !(m.blob instanceof Blob) || !m.st) throw new Error('Không có ảnh để lưu');
    const { cId, uId, nhanh } = THEX;
    const up = nvUp(cId, uId) || {};
    if (!up.the || !up.the.goc) throw new Error('Yêu cầu này không chỉnh lại được');
    const c = currentData[cId] || {};
    const thuMuc = (String(up.folder || '').match(/folders\/([\w-]+)/) || [])[1];
    if (!thuMuc) throw new Error('Không thấy thư mục của yêu cầu này');
    THEX_LUU = true;
    Swal.fire({ title: 'Đang lưu bản tiệm chỉnh...', allowOutsideClick: false, showConfirmButton: false, didOpen: () => Swal.showLoading() });
    try {
        const token = await driveToken();
        const now = new Date();
        const hhmmss = [now.getHours(), now.getMinutes(), now.getSeconds()].map(x => String(x).padStart(2, '0')).join('');
        const cName = String(c.name || 'Khach').replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 40) || 'Khach';
        const kho = String(m.kho || '').replace(/[^\dx.]/g, '').slice(0, 10);
        const name = `${cName}_${cId.split('_')[1].slice(-4)}_ANH THE ${kho} TIEM CHINH_${hhmmss}.jpg`;
        const f = await FR.upload(m.blob, name, token, thuMuc, v => Swal.update({ title: `Đang lưu ${Math.round(v * 100)}%` }));
        if (!f || !f.id) throw new Error('Drive không nhận ảnh');
        await FR.makePublic(f.id, token).catch(() => {});
        const time = now.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) + ' ' + now.toLocaleDateString('vi-VN');
        const nv = { id: f.id, name: f.name || name, time, at: Date.now(), by: nvTen(), the: { v: 1, goc: up.the.goc, st: m.st } };
        await db.ref(dbPath + nhanh + '/' + cId + '/client_uploads/' + uId + '/nv').set(nv);
        // Chỉ giữ một bản tiệm chỉnh: bản trước vào thùng rác Drive
        const cu = up.nv && up.nv.id;
        if (cu && cu !== f.id) fetch('https://www.googleapis.com/drive/v3/files/' + cu, {
            method: 'PATCH', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true })
        }).catch(() => {});
        Swal.close();
        theAn();
        nvXem(cId, uId, 'tiem', nv);
        Toast.fire({ icon: 'success', title: 'Đã lưu bản tiệm chỉnh' });
    } finally { THEX_LUU = false; }
}

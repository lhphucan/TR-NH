// ===== Trang khách: làm ảnh thẻ (anh-the.html mở trong khung phủ toàn màn hình) =====
// Nhân viên bật cho từng khách (data/<cơ sở>/<phiên>/the = true), giống frame cao cấp.
// Bật rồi thì khung ảnh thẻ được tạo ẩn ngay để phần mềm tải ngầm, khách bấm là dùng luôn.
// Dùng chung với app.js: db, gsCall, guiLenDrive, getDStr, BRANCHES_CACHE, banGhepIds, laAnhLoc, Swal; FR (frame-core.js).

let AT = null;          // { fid, branch, clientId } của phiên đang mở
let AT_REF = null;      // theo dõi nhân viên bật/tắt ảnh thẻ
let AT_KHUNG = null;    // iframe anh-the.html
let AT_SAN = false;     // trang ảnh thẻ đã sẵn sàng nhận tin
let AT_ALBUM = null;    // ảnh của lượt chụp: [{ id, name }]

function atSessionReady(data, branch) {
    const btn = document.getElementById('at-entry');
    if (!btn) return;
    if (AT_REF) { AT_REF.off(); AT_REF = null; }
    btn.style.display = 'none';
    const links = Object.values((data && data.links) || {}).map(l => String((l && l.url) || ''));
    const fid = links.reverse().map(u => (u.match(/folders\/([\w-]+)/) || [])[1]).find(Boolean) || '';
    AT = { fid, branch, clientId: data.id };
    AT_ALBUM = null;
    AT_REF = db.ref('data/' + branch + '/' + data.id + '/the');
    AT_REF.on('value', s => {
        const on = s.val() === true;
        btn.style.display = on ? '' : 'none';
        if (on) atTao();   // tải ngầm phần mềm ảnh thẻ ngay khi được bật
    }, () => { btn.style.display = 'none'; });
}

// Tạo khung ẩn một lần; trang ảnh thẻ tự tải phần mềm khi rảnh
function atTao() {
    if (AT_KHUNG) return;
    const lop = document.createElement('div');
    lop.id = 'at-lop';
    lop.innerHTML = '<iframe id="at-khung" src="./anh-the.html" title="Làm ảnh thẻ" allow="clipboard-write"></iframe>';
    document.body.appendChild(lop);
    AT_KHUNG = lop.firstElementChild;
}

const atGui = m => { if (AT_KHUNG && AT_KHUNG.contentWindow) AT_KHUNG.contentWindow.postMessage(m, location.origin); };

async function atOpen() {
    if (!AT) return;
    atTao();
    document.getElementById('at-lop').classList.add('on');
    document.body.classList.add('at-mo');
    // nút Back của điện thoại đóng màn ảnh thẻ: dùng chung cơ chế "màn đang mở" của trang khách (app.js)
    if (typeof moLop === 'function') moLop('anhthe', atDong);
    if (AT_SAN) { await atNapAlbum(); atGui({ t: 'mo' }); }
}

function atDong() {
    const lop = document.getElementById('at-lop');
    if (!lop || !lop.classList.contains('on')) return;
    lop.classList.remove('on');
    document.body.classList.remove('at-mo');
}

// Ảnh của lượt chụp (bỏ bản ghép khung có sẵn và ảnh lẻ màu frame), gửi danh sách cho trang ảnh thẻ
async function atNapAlbum() {
    if (AT_ALBUM === null && AT.fid) {
        try {
            const list = (await gsCall({ action: 'album', folder: AT.fid })).images || [];
            const ghep = banGhepIds(list);
            AT_ALBUM = list.filter(x => !ghep.has(x.id) && !laAnhLoc(x.name)).map(x => ({ id: x.id, name: x.name }));
        } catch (e) { AT_ALBUM = null; }
    }
    atGui({ t: 'album', anh: (AT_ALBUM || []).map(x => ({ id: x.id, name: x.name, thumb: FR.gUrl(x.id, 400) })) });
}

window.addEventListener('message', async e => {
    if (e.origin !== location.origin || !AT_KHUNG || e.source !== AT_KHUNG.contentWindow || !e.data) return;
    const m = e.data;
    if (m.t === 'san') {
        AT_SAN = true;
        if (document.getElementById('at-lop').classList.contains('on')) { await atNapAlbum(); atGui({ t: 'mo' }); }
    } else if (m.t === 'dong') {
        // đóng ngay (không đợi trình duyệt lùi trang: iPhone có lúc bỏ qua lệnh lùi gửi từ trong khung), rồi dọn lịch sử
        atDong(); if (typeof dongLop === 'function') dongLop('anhthe');
    } else if (m.t === 'lay') {
        // Ảnh gốc của máy chụp (nét nhất) để làm ảnh thẻ
        try {
            const r = await fetch(FR.gUrl(m.id));
            if (!r.ok) throw new Error('Không tải được ảnh (' + r.status + ')');
            atGui({ t: 'anh', id: m.id, blob: await r.blob() });
        } catch (er) { atGui({ t: 'anh', id: m.id, loi: 'Chưa tải được ảnh, kiểm tra mạng rồi thử lại nhé.' }); }
    } else if (m.t === 'gui') {
        try { await atGuiTiem(m); atGui({ t: 'gui-xong' }); }
        catch (er) {
            // khách bấm Xem lại thì không báo lỗi
            if (er.message) Swal.close();
            atGui({ t: 'gui-loi', huy: !er.message, msg: er.message || '' });
        }
    }
});

// Tờ in ảnh thẻ vào thư mục lượt chụp + yêu cầu in bên nhân viên (như ảnh ghép frame)
async function atGuiTiem(m) {
    if (!(m.blob instanceof Blob)) throw new Error('Không có ảnh để gửi');
    const ok = await Swal.fire({ title: 'Gửi ảnh thẻ cho tiệm?', text: 'Tiệm sẽ in đúng tờ ảnh này' + (m.so ? ' (' + m.so + ')' : '') + '.', icon: 'question', showCancelButton: true,
                                 confirmButtonText: 'Gửi', cancelButtonText: '<span style="color:#111">Xem lại</span>', confirmButtonColor: '#111', cancelButtonColor: '#fff' });
    if (!ok.isConfirmed) throw new Error('');
    const { branch, clientId, fid } = AT;
    const data = (await db.ref('data/' + branch + '/' + clientId).once('value')).val() || {};
    const bName = (BRANCHES_CACHE[branch] && BRANCHES_CACHE[branch].name) || branch;
    const maKh = String(clientId).split('_')[1].slice(-4);
    const cName = String(data.name || 'Khach').replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 40) || 'Khach';
    const now = new Date();
    const hhmmss = [now.getHours(), now.getMinutes(), now.getSeconds()].map(x => String(x).padStart(2, '0')).join('');
    const kho = String(m.kho || '').replace(/[^\dx.]/g, '').slice(0, 10);
    const file = new File([m.blob], `${cName}_${maKh}_ANH THE ${kho}_${hhmmss}.jpg`, { type: 'image/jpeg' });
    const batDau = Date.now();
    Swal.fire({ title: 'Đang gửi ảnh thẻ...', allowOutsideClick: false, showConfirmButton: false, didOpen: () => Swal.showLoading() });
    const where = { branch: bName, day: getDStr(now).replace(/\//g, '-'), client: `${cName} - ${maKh}` };
    if (fid) where.lot = fid;
    const sent = await guiLenDrive([file], where);
    const up = sent.files[0];
    if (!up || !up.id) throw new Error((up && up.err) || 'Không gửi được ảnh');
    const time = now.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) + ' ' + now.toLocaleDateString('vi-VN');
    await db.ref('data/' + branch + '/' + clientId + '/client_uploads/U_' + Date.now()).set({
        time, drive: [{ id: up.id, name: up.name }], folder: sent.folderUrl, kind: 'anhthe',
        took: Math.round((Date.now() - batDau) / 1000), mb: Math.round(m.blob.size / 104857.6) / 10, via: sent.via || ''
    });
    await Swal.fire({ title: 'Đã gửi cho tiệm', text: 'Nhân viên sẽ in ảnh thẻ giúp bạn.', icon: 'success', confirmButtonColor: '#111' });
}

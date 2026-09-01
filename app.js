// Key thật đọc từ config/imgbb_key (đổi được trong trang Quản lý của admin),
// hằng số dưới chỉ dùng khi chưa đặt hoặc không đọc được.
const IMGBB_FALLBACK_KEY = 'c15b60c02964bf3cebe1cf861ac30b19';
let IMGBB_API_KEY = IMGBB_FALLBACK_KEY;
let db;

try {
    const firebaseConfig = { apiKey: "AIzaSyAcih83r2AhH85J3Pp31i7qq8OkuRAIyxw", databaseURL: "https://tra-anh-khach-default-rtdb.asia-southeast1.firebasedatabase.app", projectId: "tra-anh-khach" };
    firebase.initializeApp(firebaseConfig);
    db = firebase.database();
} catch (error) {
    console.error("Firebase init error");
}

let currentClientId = null;
let BRANCHES_CACHE = {};
let liveRef = null;      // ref đang lắng nghe phiên hiện tại
let liveHandler = null;  // callback để gỡ đúng listener
let lastLinkCount = 0;   // để biết tiệm vừa đẩy thêm ảnh mới
let isFirstLiveRender = true; // lần vẽ đầu không báo "ảnh mới"
let pastSessions = [];   // các lượt chụp trước của cùng SĐT (mọi cơ sở)
// Khai báo ở đây vì window.onload gọi loadDriveEndpoint() ngay từ đầu file:
// let không được hoisting nên để dưới sẽ lỗi và biến mãi rỗng.
let GS_URL = '';
let currentClientName = '';  // tên trên PHIÊN đang mở, không phải ô nhập

function loadImgbbKey() {
    return db.ref('config/imgbb_key').once('value')
        .then(s => { const k = (s.val() || '').trim(); if (k) IMGBB_API_KEY = k; })
        .catch(() => { /* không đọc được -> giữ key dự phòng */ });
}

function loadBranches() {
    return db.ref('branches').once('value').then(snap => {
        BRANCHES_CACHE = snap.val() || {};
        const sel = document.getElementById('branch');
        sel.innerHTML = '';
        Object.keys(BRANCHES_CACHE).forEach(id => {
            if (BRANCHES_CACHE[id].active === false) return;
            const opt = document.createElement('option');
            opt.value = id;
            opt.innerText = BRANCHES_CACHE[id].name;
            sel.appendChild(opt);
        });
    }).catch(() => showError("Không tải được danh sách cơ sở."));
}

window.onload = () => {
    loadImgbbKey();
    loadDriveEndpoint();
    loadBranches().then(() => {
        if(localStorage.getItem('pn_name')) document.getElementById('name').value = localStorage.getItem('pn_name');
        if(localStorage.getItem('pn_phone')) document.getElementById('phone').value = localStorage.getItem('pn_phone');

        const sel = document.getElementById('branch');
        const urlBranch = new URLSearchParams(window.location.search).get('br');
        if (urlBranch && BRANCHES_CACHE[urlBranch] && BRANCHES_CACHE[urlBranch].active !== false) {
            // QR quét vào: khoá đúng cơ sở, không cho khách đổi nhầm
            sel.value = urlBranch;
            sel.disabled = true;
            sel.style.background = '#f4f4f5';
            sel.style.color = '#111';
            sel.style.border = '1px dashed #d4d4d8';
        } else if (localStorage.getItem('pn_branch')) {
            sel.value = localStorage.getItem('pn_branch');
        }

        restoreSession(sel.value);
    });
};

// Load lại trang -> vào thẳng album của phiên gần nhất (nếu vẫn còn trong ngày)
function restoreSession(currentBranch) {
    const savedId = localStorage.getItem('pn_client_id');
    const savedBranch = localStorage.getItem('pn_branch');
    if (!savedId || !savedBranch) return;

    // QR trỏ cơ sở khác -> không khôi phục phiên của cơ sở cũ
    if (currentBranch && savedBranch !== currentBranch) return;

    // Chỉ giữ phiên trong ngày, hôm sau khách chụp lại thì tra mới
    const ts = parseInt(savedId.split('_')[1]);
    if (!ts || getDStr(new Date(ts)) !== getDStr(new Date())) return clearSavedSession();

    db.ref('data/' + savedBranch + '/' + savedId).once('value').then(snap => {
        if (!snap.exists()) return clearSavedSession(); // tiệm đã xoá phiên
        attachLive(savedId, savedBranch);
        // Nạp lịch sử các lượt trước để F5 vẫn thấy đủ như lúc tra cứu
        const ph = normalizePhone((snap.val() || {}).phone);
        if (ph) loadHistory(ph).then(h => { if (currentClientId === savedId) { pastSessions = h.filter(x => x.id !== savedId); renderData(Object.assign({}, snap.val(), { id: savedId }), savedBranch); } });
    }).catch(() => { /* mất mạng -> để khách tra thủ công */ });
}

function showError(msg) {
    if (typeof Swal !== 'undefined') Swal.fire({ icon: 'warning', title: 'Thông báo', text: msg, confirmButtonColor: '#111' });
    else alert(msg);
}

function getDStr(dObj) { return String(dObj.getDate()).padStart(2, '0') + '/' + String(dObj.getMonth() + 1).padStart(2, '0') + '/' + dObj.getFullYear(); }

// Dữ liệu trong DB ai cũng ghi được -> luôn escape trước khi nhét vào innerHTML
function escapeHTML(str) {
    return String(str == null ? '' : str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Chỉ cho http/https -> chặn javascript:, data: trong href
function safeUrl(u) {
    const s = String(u == null ? '' : u).trim();
    return /^https?:\/\//i.test(s) ? s : '#';
}

// Dùng khi URL nằm trong chuỗi innerHTML
function safeUrlAttr(u) { return escapeHTML(safeUrl(u)); }

// ===== Lưu ảnh khách gửi vào Drive của tiệm =====
// Apps Script chỉ cấp mã truy cập ngắn hạn; ảnh đi thẳng lên Drive API vì đẩy
// cả file qua Apps Script chậm gấp 6-10 lần và rất thất thường.
function loadDriveEndpoint() {
    return db.ref('config/gs_url').once('value')
        .then(s => { GS_URL = (s.val() || '').trim(); })
        .catch(() => { GS_URL = ''; });
}

// Apps Script thỉnh thoảng trả trang HTML trung gian thay vì JSON -> thử lại
async function gsCall(params, tries) {
    if (!GS_URL) throw new Error('Chưa cấu hình nơi lưu ảnh');
    const url = GS_URL + '?' + new URLSearchParams(params).toString();
    for (let i = 0; i < (tries || 3); i++) {
        try {
            const txt = await (await fetch(url)).text();
            if (txt.trim().startsWith('{')) {
                const d = JSON.parse(txt);
                if (d.ok) return d;
                throw new Error(d.error || 'Lỗi không rõ');
            }
        } catch (e) {
            if (i === (tries || 3) - 1) throw e;
        }
        await new Promise(r => setTimeout(r, 700));
    }
    throw new Error('Không kết nối được nơi lưu ảnh');
}

// Đẩy một ảnh lên Drive, trả về id file
async function driveUpload(file, token, folderId) {
    const boundary = 'pn' + Date.now() + Math.random().toString(36).slice(2);
    const meta = { name: file.name || 'anh.jpg', parents: [folderId] };
    const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${file.type || 'image/jpeg'}\r\n\r\n`;
    const body = new Blob([head, file, `\r\n--${boundary}--`]);

    const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'multipart/related; boundary=' + boundary },
        body
    });
    if (!res.ok) {
        const err = new Error('Drive từ chối (HTTP ' + res.status + ')');
        // 429 quá nhanh, 5xx Google trục trặc -> thử lại được
        err.retryable = res.status === 429 || res.status >= 500;
        throw err;
    }
    return await res.json();
}

// Mạng chập chờn hay Google trục trặc vài giây thì thử lại, đừng bắt khách
// gửi lại cả lượt vì một ảnh hỏng tạm thời.
async function driveUploadRetry(file, token, folderId, tries) {
    let last;
    for (let i = 0; i < (tries || 3); i++) {
        try {
            return await driveUpload(file, token, folderId);
        } catch (e) {
            last = e;
            // Sai token hoặc file hỏng thì thử lại cũng vô ích
            if (e.retryable === false) throw e;
            if (i < (tries || 3) - 1) await new Promise(r => setTimeout(r, 800 * (i + 1)));
        }
    }
    throw last;
}

// Đầu số di động Việt Nam đang lưu hành (sau chuyển đổi 11 số về 10 số)
const VN_PREFIX = /^0(3[2-9]|5[2689]|7[06-9]|8[1-9]|9[0-9])\d{7}$/;

// Trả về SĐT dạng chuẩn 10 số, hoặc '' nếu không hợp lệ.
// Chấp nhận +84 / 84 ở đầu, khoảng trắng, dấu chấm, gạch ngang.
function normalizePhone(raw) {
    let d = String(raw || '').replace(/\D/g, '');
    if (d.startsWith('840') && d.length === 12) d = d.slice(2);        // 840xxxxxxxxx
    else if (d.startsWith('84') && (d.length === 11 || d.length === 10)) d = '0' + d.slice(2); // 84xxxxxxxxx
    else if (d.length === 9) d = '0' + d;                              // thiếu số 0 đầu
    if (d.length !== 10) return '';
    if (!VN_PREFIX.test(d)) return '';
    // Chặn số bịa kiểu 0000000000, 0111111111, 0123456789
    if (/^(\d)\1{9}$/.test(d)) return '';
    if (/^0(12345678|23456789)\d?$/.test(d)) return '';
    return d;
}

// ===== Chống spam tạo phiên (theo thiết bị) =====
const SPAM_MAX_PER_DAY = 3;       // tối đa 3 phiên mới/ngày/thiết bị
const SPAM_COOLDOWN_MS = 120000;  // chờ 2 phút giữa 2 lần tạo
const SESSION_MAX_PER_DAY = 3;    // tối đa 3 lượt/ngày cho cùng SĐT (đọc từ máy chủ)

// Trả null nếu được phép tạo, hoặc chuỗi thông báo nếu bị chặn
function spamGuardCheck() {
    const todayStr = getDStr(new Date());
    let log;
    try { log = JSON.parse(localStorage.getItem('pn_create_log') || '{}'); } catch (_) { log = {}; }
    if (log.date !== todayStr) log = { date: todayStr, count: 0, last: 0 };

    const now = Date.now();
    if (log.last && (now - log.last) < SPAM_COOLDOWN_MS) {
        const wait = Math.ceil((SPAM_COOLDOWN_MS - (now - log.last)) / 1000);
        return `Bạn thao tác quá nhanh. Vui lòng chờ ${wait} giây rồi thử lại.`;
    }
    if (log.count >= SPAM_MAX_PER_DAY) {
        return `Bạn đã tạo tối đa ${SPAM_MAX_PER_DAY} lượt tra cứu hôm nay. Vui lòng liên hệ tiệm nếu cần hỗ trợ.`;
    }
    return null;
}

function spamGuardRecord() {
    const todayStr = getDStr(new Date());
    let log;
    try { log = JSON.parse(localStorage.getItem('pn_create_log') || '{}'); } catch (_) { log = {}; }
    if (log.date !== todayStr) log = { date: todayStr, count: 0, last: 0 };
    log.count += 1;
    log.last = Date.now();
    localStorage.setItem('pn_create_log', JSON.stringify(log));
}

function checkData() {
    if (!db) return showError("Không thể kết nối đến hệ thống. Vui lòng kiểm tra lại mạng!");

    const branch = document.getElementById('branch').value;
    const name = document.getElementById('name').value.trim();
    const phone = document.getElementById('phone').value.trim();
    
    // SĐT là khoá định danh phiên -> bắt buộc, nếu không khách này sẽ khớp nhầm phiên của khách khác
    const rawDigits = phone.replace(/\D/g, '');
    if (!rawDigits) return showError("Vui lòng nhập Số điện thoại.");

    // Kiểm tra theo đầu số nhà mạng: trước chỉ đếm 9-11 chữ số nên số bịa vẫn lọt,
    // khách gõ nhầm cũng tạo phiên mà sau này không tra lại được.
    const phoneDigits = normalizePhone(phone);
    if (!phoneDigits) {
        return showError(rawDigits.length !== 10
            ? "Số điện thoại phải có 10 số. Vui lòng kiểm tra lại."
            : "Số điện thoại không đúng. Vui lòng kiểm tra lại đầu số.");
    }

    localStorage.setItem('pn_name', name);
    localStorage.setItem('pn_phone', phone);
    localStorage.setItem('pn_branch', branch);

    document.getElementById('spinner').style.display = 'block';
    document.getElementById('btn-text').innerText = '';
    document.getElementById('btn-submit').disabled = true;

    const todayStr = getDStr(new Date());

    // Quét mọi cơ sở: khách xem được ảnh cũ ở bất kỳ đâu đã chụp.
    // Trước chỉ tìm phiên trong ngày ở một cơ sở nên hôm sau vào lại là mất ảnh.
    loadHistory(phoneDigits).then(history => {
        // Phiên hôm nay ở ĐÚNG cơ sở đang quét -> mở thẳng phiên đó
        const today = history.filter(h => h.branch === branch && getDStr(new Date(h.ts)) === todayStr);

        if (today.length) {
            attachLive(today[0].id, branch, history);
        } else if (history.length) {
            // Có ảnh cũ nhưng chưa chụp hôm nay -> hiện lịch sử, không tự tạo phiên rác
            renderHistory(history, branch);
        } else {
            createSession(branch, name, phoneDigits);
        }
    }).catch(error => {
        showError("Lỗi kết nối máy chủ. Vui lòng thử lại.");
        document.getElementById('spinner').style.display = 'none';
        document.getElementById('btn-text').innerText = 'TRA CỨU';
        document.getElementById('btn-submit').disabled = false;
    });
}

// Quét mọi cơ sở, trả về các lượt chụp của một SĐT, mới nhất trước.
// Dùng orderByChild để Firebase lọc ở máy chủ — tải cả nhánh về máy khách tốn
// hàng trăm KB và càng ngày càng nặng.
function loadHistory(phoneDigits) {
    const ids = Object.keys(BRANCHES_CACHE);

    // SĐT trong DB lưu không đồng nhất (thiếu số 0 đầu, có dấu cách) -> dò vài dạng
    const variants = [phoneDigits];
    if (phoneDigits.startsWith('0')) variants.push(phoneDigits.slice(1));
    variants.push(phoneDigits.replace(/(\d{4})(\d{3})(\d{3})/, '$1 $2 $3'));

    const jobs = [];
    ids.forEach(bid => variants.forEach(v => {
        jobs.push(
            db.ref('data/' + bid).orderByChild('phone').equalTo(v).once('value')
              .then(snap => ({ bid, snap })).catch(() => null)
        );
    }));

    return Promise.all(jobs).then(results => {
        const seen = {}, out = [];
        results.forEach(r => {
            if (!r) return;
            r.snap.forEach(child => {
                const key = r.bid + '/' + child.key;
                if (seen[key]) return;
                const data = child.val();
                if (!data) return;
                const ts = parseInt(child.key.split('_')[1]);
                if (!ts) return;
                // Xác nhận lại sau chuẩn hoá: query khớp chuỗi thô nên vẫn phải lọc
                const dbPhone = normalizePhone(data.phone) || String(data.phone || '').replace(/\D/g, '');
                if (dbPhone !== phoneDigits) return;
                seen[key] = 1;
                out.push({ id: child.key, branch: r.bid, ts, data });
            });
        });
        return out.sort((a, b) => b.ts - a.ts);
    }).catch(() => []);
}

function resetSubmitBtn() {
    document.getElementById('spinner').style.display = 'none';
    document.getElementById('btn-text').innerText = 'TRA CỨU';
    document.getElementById('btn-submit').disabled = false;
}

// Tạo phiên mới — luôn vào cơ sở đang quét QR, không phải cơ sở của ảnh cũ đang xem
function createSession(branch, name, phoneDigits) {
    const blocked = spamGuardCheck();
    if (blocked) { resetSubmitBtn(); return showError(blocked); }

    // Chặn theo SĐT đọc từ máy chủ: đếm theo thiết bị vô dụng vì khách quét bằng
    // Zalo / Chrome / Google Lens là mỗi nơi một localStorage.
    return loadHistory(phoneDigits).then(history => {
        const todayStr = getDStr(new Date());
        const todayCount = history.filter(h => getDStr(new Date(h.ts)) === todayStr).length;
        if (todayCount >= SESSION_MAX_PER_DAY) {
            resetSubmitBtn();
            showError(`Số điện thoại này đã có ${todayCount} lượt chụp hôm nay. Vui lòng báo nhân viên nếu cần thêm.`);
            return;
        }
        return doCreateSession(branch, name, phoneDigits, history);
    });
}

function doCreateSession(branch, name, phoneDigits, history) {
    const newId = "S_" + Date.now();
    const newData = {
        // Rules giới hạn độ dài -> cắt để không bị từ chối ghi
        name: (name || "Khách hàng").slice(0, 60),
        phone: phoneDigits,
        status: "new",
        time: new Date().toLocaleTimeString('vi-VN', {hour: '2-digit', minute:'2-digit'})
    };

    return db.ref('data/' + branch + '/' + newId).set(newData).then(() => {
        spamGuardRecord();
        attachLive(newId, branch, history);
    }).catch(() => {
        showError("Không tạo được phiên. Vui lòng thử lại hoặc báo nhân viên.");
        resetSubmitBtn();
    });
}

// Khách bấm "Tôi vừa chụp hôm nay" ở màn lịch sử
function startNewSession() {
    const branch = document.getElementById('branch').value;
    const bName = (BRANCHES_CACHE[branch] && BRANCHES_CACHE[branch].name) || branch;
    const name = document.getElementById('name').value.trim() || localStorage.getItem('pn_name') || '';
    const phoneDigits = normalizePhone(document.getElementById('phone').value);
    if (!phoneDigits) return showError("Vui lòng nhập lại số điện thoại.");

    const ask = (typeof Swal !== 'undefined')
        ? Swal.fire({
            title: 'Bạn vừa chụp hôm nay?',
            html: `Tạo lượt chụp mới tại <b>${escapeHTML(bName)}</b>.<br><span style="font-size:13px;color:#666">Nếu chỉ muốn xem ảnh cũ, hãy chọn Không.</span>`,
            icon: 'question', showCancelButton: true,
            confirmButtonText: 'Đúng, tôi vừa chụp', cancelButtonText: '<span style="color:#111">Không</span>',
            confirmButtonColor: '#111', cancelButtonColor: '#fff'
          }).then(r => r.isConfirmed)
        : Promise.resolve(confirm('Bạn vừa chụp hôm nay tại ' + bName + '?'));

    ask.then(yes => { if (yes) createSession(branch, name, phoneDigits); });
}

// Khách đã chụp trước đây nhưng chưa có phiên hôm nay: hiện lịch sử để xem lại ảnh
function renderHistory(history, branch) {
    detachLive();
    currentClientId = null;
    currentClientName = '';
    document.getElementById('form-ui').style.display = 'none';
    document.getElementById('result-ui').style.display = 'block';
    document.getElementById('upload-box').style.display = 'none';
    setSocialLinks(branch);
    resetSubmitBtn();

    const bName = (BRANCHES_CACHE[branch] && BRANCHES_CACHE[branch].name) || branch;
    let html = '';

    history.forEach((h, idx) => {
        const d = h.data;
        const dateStr = getDStr(new Date(h.ts));
        const isToday = dateStr === getDStr(new Date());
        const hbName = (BRANCHES_CACHE[h.branch] && BRANCHES_CACHE[h.branch].name) || h.branch;
        const links = d.links ? Object.keys(d.links) : [];
        const open = idx === 0; // lần gần nhất mở sẵn, các lần cũ thu gọn

        let inner = '';
        if (links.length) {
            links.forEach((lid, i) => {
                const l = d.links[lid] || {};
                inner += `<div class="link-row"><span style="font-size:12px; color:#666; font-weight:600;">Ảnh gốc ${i+1}</span><a href="${safeUrlAttr(l.url)}" target="_blank" rel="noopener noreferrer" class="view-btn" onclick="askRating('${escapeHTML(h.branch)}')">Lưu ảnh</a></div>`;
            });
        } else {
            inner = `<div class="hist-empty">Tiệm chưa gửi ảnh cho lượt này</div>`;
        }

        html += `<div class="hist-group">
            <button onclick="toggleHistory(${idx})" class="hist-head">
                <span>
                    <span class="hist-date">${isToday ? 'Hôm nay' : dateStr}</span>
                    <span class="hist-meta">${escapeHTML(hbName)} · ${links.length} ảnh</span>
                </span>
                <span id="hist-arrow-${idx}" class="hist-arrow" style="transform:rotate(${open ? 180 : 0}deg);">▼</span>
            </button>
            <div id="hist-body-${idx}" class="hist-body" style="display:${open ? 'block' : 'none'};">${inner}</div>
        </div>`;
    });

    html += `<div class="new-session">
        <p>Bạn vừa chụp tại <b>${escapeHTML(bName)}</b> hôm nay?</p>
        <button onclick="startNewSession()" class="primary-btn" style="padding:13px; font-size:13px;">TẠO LƯỢT CHỤP MỚI</button>
    </div>`;

    document.getElementById('album-list').innerHTML = html;
}

function toggleHistory(idx) {
    const body = document.getElementById('hist-body-' + idx);
    const arrow = document.getElementById('hist-arrow-' + idx);
    if (!body) return;
    const show = body.style.display === 'none';
    body.style.display = show ? 'block' : 'none';
    if (arrow) arrow.style.transform = 'rotate(' + (show ? 180 : 0) + 'deg)';
}

function setSocialLinks(branch) {
    const social = (BRANCHES_CACHE[branch] && BRANCHES_CACHE[branch].social) || {};
    document.getElementById('link-fb').href = safeUrl(social.fb);
    document.getElementById('link-ig').href = safeUrl(social.ig);
    document.getElementById('link-tk').href = safeUrl(social.tk);
    document.getElementById('link-map').href = safeUrl(social.map);
}

// Lắng nghe realtime đúng phiên của khách: tiệm đẩy ảnh xong là hiện luôn, không cần F5
function attachLive(clientId, branch, history) {
    detachLive();
    // Lịch sử các lượt chụp trước, hiện dưới album hôm nay
    pastSessions = (history || []).filter(h => !(h.branch === branch && h.id === clientId));

    // Nhớ phiên để lần sau mở lại vào thẳng album (ngày lấy từ chính id S_<ts>)
    localStorage.setItem('pn_client_id', clientId);
    localStorage.setItem('pn_branch', branch);

    liveRef = db.ref('data/' + branch + '/' + clientId);
    liveHandler = liveRef.on('value', snap => {
        const data = snap.val();
        if (!data) {
            // Tiệm đã xoá/chuyển phiên -> quay về form, không giữ phiên chết
            detachLive();
            clearSavedSession();
            backToForm();
            return showError("Phiên chụp không còn tồn tại. Vui lòng tra cứu lại.");
        }
        data.id = clientId;

        const n = data.links ? Object.keys(data.links).length : 0;
        const hadBefore = lastLinkCount;
        renderData(data, branch);

        // Ảnh mới về sau khi đã xem màn album -> báo cho khách biết
        if (!isFirstLiveRender && n > hadBefore && typeof Swal !== 'undefined') {
            Swal.fire({ icon: 'success', title: 'Ảnh đã sẵn sàng', text: 'Tiệm vừa gửi ảnh cho bạn.', confirmButtonColor: '#111', timer: 2500, timerProgressBar: true });
        }
        lastLinkCount = n;
        isFirstLiveRender = false;
    }, () => {
        showError("Mất kết nối với máy chủ. Vui lòng kiểm tra mạng.");
    });
}

function detachLive() {
    if (liveRef && liveHandler) liveRef.off('value', liveHandler);
    liveRef = null; liveHandler = null;
    lastLinkCount = 0; isFirstLiveRender = true;
}

function clearSavedSession() {
    localStorage.removeItem('pn_client_id');
}

// Khách bấm "Tra cứu tài khoản khác" -> quên phiên cũ, nếu không reload sẽ vào lại album cũ
function lookupAnother() {
    detachLive();
    pastSessions = [];
    clearSavedSession();
    location.reload();
}

function backToForm() {
    currentClientId = null;
    currentClientName = '';
    document.getElementById('result-ui').style.display = 'none';
    document.getElementById('form-ui').style.display = 'block';
    document.getElementById('spinner').style.display = 'none';
    document.getElementById('btn-text').innerText = 'TRA CỨU';
    document.getElementById('btn-submit').disabled = false;
}

function renderData(data, branch) {
    currentClientId = data.id;
    // Tên lấy từ phiên đang mở: ô nhập và localStorage có thể còn tên khách trước
    currentClientName = data.name || '';
    document.getElementById('form-ui').style.display = 'none';
    document.getElementById('result-ui').style.display = 'block';

    document.getElementById('upload-box').style.display = 'block';
    setSocialLinks(branch);

    const idTs = data.id.split('_')[1] || '';
    const ts = parseInt(idTs) || Date.now();
    const dateStr = getDStr(new Date(ts));
    const safeBranch = escapeHTML(branch);

    let html = `<div style="padding: 18px; background: #fafafa; border: 1px solid #e5e5e5; border-radius: 14px; position:relative;">
        <div style="position: absolute; top: 15px; right: 15px; border: 1px solid #e5e5e5; padding: 2px 6px; border-radius: 4px; background: #fff; font-size: 11px; font-family: monospace; color: #888;">#${escapeHTML(idTs.slice(-4))}</div>
        <div style="font-size: 14px; color: #111; margin-bottom: 12px;">Ngày chụp: <b>${dateStr}</b></div>`;

    if (data.links && Object.keys(data.links).length > 0) {
        Object.keys(data.links).forEach((linkId, index) => {
            const l = data.links[linkId] || {};
            html += `<div class="link-row"><span style="font-size:12px; color:#666; font-weight:600;">Ảnh gốc ${index+1}</span><a href="${safeUrlAttr(l.url)}" target="_blank" rel="noopener noreferrer" class="view-btn" onclick="askRating('${safeBranch}')">Lưu ảnh</a></div>`;
        });
    } else {
        html += `<div style="font-size:12px; color:#888; text-align:center; padding:15px; background:#fff; border:1px dashed #d4d4d8; border-radius:8px; margin-top:10px;">
            <div style="width: 8px; height: 8px; background: #111; border-radius: 50%; animation: pulse 1.5s infinite; display:inline-block; margin-right:5px;"></div>
            Đang đồng bộ ảnh...
        </div>`;
    }

    if (data.client_uploads && Object.keys(data.client_uploads).length > 0) {
        html += `<div style="margin-top: 15px; padding-top: 15px; border-top: 1px dashed #e5e5e5;"><b style="font-size: 12px; color: #111; text-transform: uppercase;">Ảnh bạn đã yêu cầu in:</b>`;
        Object.keys(data.client_uploads).forEach((uploadId) => {
            const u = data.client_uploads[uploadId] || {};
            const n = (Array.isArray(u.links) ? u.links.length : 0) + (Array.isArray(u.drive) ? u.drive.length : 0);
            html += `<div class="link-row" style="background: #fff;"><span style="font-size:12px; color:#666;">Gửi lúc: ${escapeHTML(u.time)}</span><span style="font-size: 12px; color: #111; font-weight: 600;">${n} ảnh</span></div>`;
        });
        html += `</div>`;
    }

    html += `</div>`;

    // Các lượt chụp trước của cùng SĐT, mọi cơ sở — thu gọn, bấm mới mở
    if (pastSessions.length) {
        html += `<div class="hist-section">
            <p class="hist-title">Các lần chụp trước</p>`;
        pastSessions.forEach((h, idx) => {
            const d = h.data || {};
            const hDate = getDStr(new Date(h.ts));
            const hbName = (BRANCHES_CACHE[h.branch] && BRANCHES_CACHE[h.branch].name) || h.branch;
            const lids = d.links ? Object.keys(d.links) : [];
            let inner = '';
            if (lids.length) {
                lids.forEach((lid, i) => {
                    const l = d.links[lid] || {};
                    inner += `<div class="link-row"><span style="font-size:12px; color:#666; font-weight:600;">Ảnh gốc ${i+1}</span><a href="${safeUrlAttr(l.url)}" target="_blank" rel="noopener noreferrer" class="view-btn" onclick="askRating('${escapeHTML(h.branch)}')">Lưu ảnh</a></div>`;
                });
            } else {
                inner = `<div class="hist-empty">Lượt này chưa có ảnh</div>`;
            }
            html += `<div class="hist-group">
                <button onclick="toggleHistory(${idx})" class="hist-head">
                    <span>
                        <span class="hist-date">${hDate}</span>
                        <span class="hist-meta">${escapeHTML(hbName)} · ${lids.length} ảnh</span>
                    </span>
                    <span id="hist-arrow-${idx}" class="hist-arrow">▼</span>
                </button>
                <div id="hist-body-${idx}" class="hist-body" style="display:none;">${inner}</div>
            </div>`;
        });
        html += `</div>`;
    }

    document.getElementById('album-list').innerHTML = html;
    resetSubmitBtn();
}

async function sendToShop() {
    const files = document.getElementById('cFile').files;
    if (files.length === 0) return showError("Vui lòng chọn ảnh cần in.");
    if (!currentClientId) return showError("Không tìm thấy phiên chụp.");
    
    const btn = document.getElementById('btn-send');
    // Căn giữa bằng flex: .spinner có margin:0 auto nên nếu để display:block
    // nó đẩy chữ lệch hẳn sang một bên.
    const hint = document.getElementById('send-hint');
    const setBtnLoading = (done, total) => {
        btn.innerHTML = `<span style="display:flex; align-items:center; justify-content:center; gap:8px;">
            <span class="spinner" style="display:block; flex:none; margin:0; border-top-color:#111; border-color: rgba(0,0,0,0.15);"></span>
            <span>ĐANG TẢI ${done}/${total} ẢNH</span>
        </span>`;
        // Ảnh lớn có thể lâu -> nói rõ để khách không tưởng treo mà đóng trang
        if (hint) {
            hint.style.display = 'block';
            hint.innerText = done < total
                ? `Đang gửi ảnh ${done + 1}/${total}. Vui lòng không đóng trang.`
                : 'Đang hoàn tất...';
        }
    };
    setBtnLoading(0, files.length);
    btn.style.background = "#fff"; btn.style.color = "#111"; btn.style.border = "1px solid #111";
    btn.disabled = true;

    const branch = document.getElementById('branch').value;

    try {
        let uploadedUrls = [];   // ảnh lưu trên imgbb (đường dự phòng)
        let driveFiles = [];     // ảnh lưu trên Drive: {id, name}
        let folderUrl = '';
        let lastErr = '';

        if (GS_URL) {
            // Xin token + thư mục MỘT lần cho cả lượt gửi
            const bName = (BRANCHES_CACHE[branch] && BRANCHES_CACHE[branch].name) || branch;
            const day = getDStr(new Date()).replace(/\//g, '-');
            const maKh = String(currentClientId).split('_')[1].slice(-4);

            // Mỗi khách một thư mục riêng, kèm tên để nhân viên nhận ra ngay.
            // Phải lấy tên của PHIÊN đang mở — ô nhập và localStorage còn giữ tên
            // của lượt tra cứu trước nên dễ ghi nhầm sang khách khác.
            const cName = (currentClientName || 'Khach')
                            .replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 40) || 'Khach';
            const info = await gsCall({ action: 'folder', branch: bName, day, client: `${cName} - ${maKh}` });
            folderUrl = info.folderUrl || '';

            // Khách gửi nhiều đợt vào cùng thư mục: thêm giờ gửi để tên không trùng,
            // Drive không ghi đè mà tạo file thứ hai cùng tên.
            const now = new Date();
            const hhmmss = String(now.getHours()).padStart(2, '0') + String(now.getMinutes()).padStart(2, '0')
                       + String(now.getSeconds()).padStart(2, '0');

            for (let i = 0; i < files.length; i++) {
                try {
                    const ext = (files[i].name.match(/\.[a-z0-9]+$/i) || ['.jpg'])[0];
                    const renamed = new File([files[i]], `${cName}_${maKh}_${hhmmss}_${String(i + 1).padStart(2, '0')}${ext}`, { type: files[i].type });
                    const r = await driveUploadRetry(renamed, info.token, info.folderId);
                    driveFiles.push({ id: r.id, name: r.name });
                } catch (e) {
                    lastErr = e.message;
                }
                setBtnLoading(i + 1, files.length);
            }
        } else {
            // Chưa cấu hình Drive -> dùng imgbb như trước
            for (let i = 0; i < files.length; i++) {
                const formData = new FormData(); formData.append("image", files[i]);
                const response = await fetch(`https://api.imgbb.com/1/upload?key=${IMGBB_API_KEY}`, { method: 'POST', body: formData });
                const resData = await response.json();
                // Rules chỉ nhận https -> ép về https (imgbb phục vụ cả 2)
                if (resData.success) uploadedUrls.push(String(resData.data.url).replace(/^http:\/\//i, 'https://'));
                else lastErr = (resData.error && resData.error.message) || '';
                setBtnLoading(i + 1, files.length);
            }
        }

        const okCount = driveFiles.length + uploadedUrls.length;
        if (okCount === 0) {
            if (/rate limit/i.test(lastErr)) {
                return showError("Hệ thống ảnh đang quá tải. Vui lòng báo nhân viên để được hỗ trợ.");
            }
            return showError("Không gửi được ảnh. Vui lòng thử lại hoặc báo nhân viên.");
        }

        const record = {
            time: new Date().toLocaleTimeString('vi-VN', {hour: '2-digit', minute:'2-digit'}) + ' ' + new Date().toLocaleDateString('vi-VN')
        };
        if (driveFiles.length) {
            record.drive = driveFiles;
            if (folderUrl) record.folder = folderUrl;
        }
        if (uploadedUrls.length) record.links = uploadedUrls;

        // Ảnh đã nằm trên Drive rồi; nếu ghi vào hệ thống hỏng thì tiệm không thấy
        // yêu cầu in, phải báo đúng để khách biết mà nhờ nhân viên.
        try {
            await db.ref('data/' + branch + '/' + currentClientId + '/client_uploads/U_' + Date.now()).set(record);
        } catch (e) {
            return showError(`Đã gửi ${okCount} ảnh nhưng chưa báo được cho tiệm. Vui lòng báo nhân viên kiểm tra giúp.`);
        }

        const missed = files.length - okCount;
        const doneMsg = missed > 0
            ? `Đã gửi ${okCount}/${files.length} ảnh. ${missed} ảnh lỗi, bạn gửi lại giúp tiệm nhé.`
            : 'Yêu cầu in ảnh đã được gửi đến tiệm.';

        if(typeof Swal !== 'undefined') Swal.fire({title: 'Hoàn tất', text: doneMsg, icon: missed > 0 ? 'warning' : 'success', confirmButtonColor: '#111'});
        else alert(doneMsg);

        document.getElementById('cFile').value = "";
        document.getElementById('cName').innerText = "Chưa có tệp";
        // Không refresh thủ công: listener realtime của phiên tự vẽ lại
    } catch (error) {
        showError("Không thể tải ảnh. Kiểm tra lại kết nối mạng!");
    } finally {
        btn.innerHTML = `GỬI ẢNH CHO TIỆM`;
        btn.style.background = "#111"; btn.style.color = "#fff"; btn.style.border = "none";
        btn.disabled = false;
        if (hint) hint.style.display = 'none';
    }
}

function askRating(br) {
    if (localStorage.getItem('pn_rated')) return;
    setTimeout(() => {
        if(typeof Swal !== 'undefined') {
            Swal.fire({
                title: 'Đánh giá dịch vụ', text: 'Tặng tiệm 5 sao trên Google Maps để ủng hộ PHOTONOIR bạn nhé!', icon: 'info',
                showCancelButton: true, confirmButtonText: 'Đánh giá ngay', cancelButtonText: '<span style="color:#111">Để sau</span>', confirmButtonColor: '#111', cancelButtonColor: '#fff'
            }).then(r => { if(r.isConfirmed) { localStorage.setItem('pn_rated', '1'); const m = safeUrl(BRANCHES_CACHE[br] && BRANCHES_CACHE[br].social && BRANCHES_CACHE[br].social.map); if (m !== '#') window.open(m, '_blank', 'noopener'); }});
        }
    }, 2000);
}

const IMGBB_API_KEY = 'c15b60c02964bf3cebe1cf861ac30b19'; 
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

// ===== Chống spam tạo phiên (theo thiết bị) =====
const SPAM_MAX_PER_DAY = 3;       // tối đa 3 phiên mới/ngày/thiết bị
const SPAM_COOLDOWN_MS = 120000;  // chờ 2 phút giữa 2 lần tạo

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
    const phoneDigits = phone.replace(/\D/g, '');
    if (!phoneDigits) return showError("Vui lòng nhập Số điện thoại.");
    if (phoneDigits.length < 9 || phoneDigits.length > 11) return showError("Số điện thoại không hợp lệ. Vui lòng kiểm tra lại.");

    localStorage.setItem('pn_name', name);
    localStorage.setItem('pn_phone', phone);
    localStorage.setItem('pn_branch', branch);

    document.getElementById('spinner').style.display = 'block';
    document.getElementById('btn-text').innerText = '';
    document.getElementById('btn-submit').disabled = true;

    const todayStr = getDStr(new Date());

    db.ref('data/' + branch).once('value', (snap) => {
        let foundData = null;
        let foundTs = -1;

        snap.forEach(child => {
            const data = child.val();
            if (!data) return;

            const ts = parseInt(child.key.split('_')[1]);
            if (!ts) return; // id hỏng -> bỏ qua, không coi là hôm nay
            const dStr = getDStr(new Date(ts));

            // So theo chữ số để "0901 234 567" và "0901234567" là một
            const dbPhone = String(data.phone || '').replace(/\D/g, '');
            if (!dbPhone) return; // phiên thiếu SĐT -> không cho ai khớp vào

            // Lọc theo SĐT và phải CÙNG NGÀY HÔM NAY, lấy phiên mới nhất
            if (dbPhone === phoneDigits && dStr === todayStr && ts > foundTs) {
                foundData = data;
                foundData.id = child.key;
                foundTs = ts;
            }
        });

        if (foundData) {
            attachLive(foundData.id, branch);
        } else {
            // Tạo phiên mới -> kiểm tra chống spam trước
            const blocked = spamGuardCheck();
            if (blocked) {
                document.getElementById('spinner').style.display = 'none';
                document.getElementById('btn-text').innerText = 'TRA CỨU';
                document.getElementById('btn-submit').disabled = false;
                return showError(blocked);
            }

            const newId = "S_" + Date.now();
            const newData = {
                // Rules giới hạn độ dài -> cắt để không bị từ chối ghi
                name: (name || "Khách hàng").slice(0, 60),
                phone: phoneDigits,
                status: "new",
                time: new Date().toLocaleTimeString('vi-VN', {hour: '2-digit', minute:'2-digit'})
            };

            db.ref('data/' + branch + '/' + newId).set(newData).then(() => {
                spamGuardRecord();
                attachLive(newId, branch);
            }).catch(() => {
                showError("Không tạo được phiên. Vui lòng thử lại hoặc báo nhân viên.");
                document.getElementById('spinner').style.display = 'none';
                document.getElementById('btn-text').innerText = 'TRA CỨU';
                document.getElementById('btn-submit').disabled = false;
            });
        }
    }).catch(error => {
        showError("Lỗi kết nối máy chủ. Vui lòng thử lại.");
        document.getElementById('spinner').style.display = 'none';
        document.getElementById('btn-text').innerText = 'TRA CỨU';
        document.getElementById('btn-submit').disabled = false;
    });
}

// Lắng nghe realtime đúng phiên của khách: tiệm đẩy ảnh xong là hiện luôn, không cần F5
function attachLive(clientId, branch) {
    detachLive();

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
    clearSavedSession();
    location.reload();
}

function backToForm() {
    currentClientId = null;
    document.getElementById('result-ui').style.display = 'none';
    document.getElementById('form-ui').style.display = 'block';
    document.getElementById('spinner').style.display = 'none';
    document.getElementById('btn-text').innerText = 'TRA CỨU';
    document.getElementById('btn-submit').disabled = false;
}

function renderData(data, branch) {
    currentClientId = data.id;
    document.getElementById('form-ui').style.display = 'none';
    document.getElementById('result-ui').style.display = 'block';

    const social = (BRANCHES_CACHE[branch] && BRANCHES_CACHE[branch].social) || {};
    document.getElementById('link-fb').href = safeUrl(social.fb);
    document.getElementById('link-ig').href = safeUrl(social.ig);
    document.getElementById('link-tk').href = safeUrl(social.tk);
    document.getElementById('link-map').href = safeUrl(social.map);

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
            const n = Array.isArray(u.links) ? u.links.length : 0;
            html += `<div class="link-row" style="background: #fff;"><span style="font-size:12px; color:#666;">Gửi lúc: ${escapeHTML(u.time)}</span><span style="font-size: 12px; color: #111; font-weight: 600;">${n} ảnh</span></div>`;
        });
        html += `</div>`;
    }

    html += `</div>`;
    document.getElementById('album-list').innerHTML = html;

    document.getElementById('spinner').style.display = 'none';
    document.getElementById('btn-text').innerText = 'TRA CỨU ALBUM';
    document.getElementById('btn-submit').disabled = false;
}

async function sendToShop() {
    const files = document.getElementById('cFile').files;
    if (files.length === 0) return showError("Vui lòng chọn ảnh cần in.");
    if (!currentClientId) return showError("Không tìm thấy phiên chụp.");
    
    const btn = document.getElementById('btn-send');
    btn.innerHTML = `<div class="spinner" style="display:block; border-top-color:#111; border-color: rgba(0,0,0,0.1);"></div> ĐANG TẢI LÊN...`;
    btn.style.background = "#fff"; btn.style.color = "#111"; btn.style.border = "1px solid #111";
    btn.disabled = true;

    const branch = document.getElementById('branch').value;

    try {
        let uploadedUrls = [];
        let lastErr = '';
        for (let i = 0; i < files.length; i++) {
            const formData = new FormData(); formData.append("image", files[i]);
            const response = await fetch(`https://api.imgbb.com/1/upload?key=${IMGBB_API_KEY}`, { method: 'POST', body: formData });
            const resData = await response.json();
            // Rules chỉ nhận https -> ép về https (imgbb phục vụ cả 2)
            if (resData.success) uploadedUrls.push(String(resData.data.url).replace(/^http:\/\//i, 'https://'));
            else lastErr = (resData.error && resData.error.message) || '';
        }

        if (uploadedUrls.length === 0) {
            // Hết lượt tải của dịch vụ ảnh -> không phải lỗi mạng của khách, báo cho đúng
            if (/rate limit/i.test(lastErr)) {
                return showError("Hệ thống ảnh đang quá tải. Vui lòng báo nhân viên để được hỗ trợ.");
            }
            return showError("Không tải được ảnh. Vui lòng thử lại hoặc báo nhân viên.");
        }

        await db.ref('data/' + branch + '/' + currentClientId + '/client_uploads/U_' + Date.now()).set({
            time: new Date().toLocaleTimeString('vi-VN', {hour: '2-digit', minute:'2-digit'}) + ' ' + new Date().toLocaleDateString('vi-VN'),
            links: uploadedUrls
        });

        const missed = files.length - uploadedUrls.length;
        const doneMsg = missed > 0
            ? `Đã gửi ${uploadedUrls.length}/${files.length} ảnh. ${missed} ảnh lỗi, bạn gửi lại giúp tiệm nhé.`
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

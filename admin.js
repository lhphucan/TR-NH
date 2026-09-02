// Key dự phòng khi chưa đặt key trong Quản lý. Key thật đọc từ config/imgbb_key
// để hết lượt tải là đổi được ngay trên web, không phải sửa code rồi push lại.
const IMGBB_FALLBACK_KEY = 'c15b60c02964bf3cebe1cf861ac30b19';
let IMGBB_API_KEY = IMGBB_FALLBACK_KEY;

// Apps Script cấp mã truy cập để đọc ảnh khách gửi trong Drive của tiệm
let GS_URL = '';
const GS_KEY = '0vRhkkYveiToxF9yK4sG4rWacTaMbfNl';

// Máy đồng bộ ảnh chụp của từng cơ sở (thư mục trong mục "Máy tính" của Drive)
const BOOTH_BY_BRANCH = { phucyen: 'SelfboothPY', vinhyen: 'SelfboothVY', xuanhoa: 'SelfboothXH' };
const PHOTO_ROOT = '用户照片文件';   // thư mục chứa các lượt chụp
const EDITED_NAME = '实时精修';      // thư mục ảnh đã tinh chỉnh, gửi cho khách

let _driveToken = '';        // token dùng lại trong 50 phút, đỡ gọi Apps Script mỗi lần
let _driveTokenAt = 0;
const _shootCache = {};      // { 'phucyen|20260902': { at, list } }

async function driveToken() {
    if (_driveToken && Date.now() - _driveTokenAt < 50 * 60 * 1000) return _driveToken;
    const d = await gsCall({ action: 'token' });
    _driveToken = d.token;
    _driveTokenAt = Date.now();
    return _driveToken;
}

async function driveQuery(q, fields) {
    const token = await driveToken();
    const url = 'https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent(q)
              + '&fields=' + (fields || 'files(id,name)') + '&pageSize=200&orderBy=name desc';
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) {
        if (res.status === 401) { _driveToken = ''; }  // token hết hạn -> xin lại lần sau
        throw new Error('Drive từ chối (HTTP ' + res.status + ')');
    }
    return (await res.json()).files || [];
}

// Drive mặc định trả ảnh cỡ 220px (~46 KB) dù ô chỉ rộng 44-150px.
// Xin đúng cỡ cần: ô ảnh mẫu 44px chỉ tốn 12 KB, nhẹ gấp gần 4 lần.
function thumbAt(url, size) {
    return String(url || '').replace(/=s\d+(-c)?$/, '=s' + size);
}

// Tìm ảnh ghép khung trong một lượt.
// Tên file không đáng tin: máy chụp đặt IMG_4673.JPG hay 195960(H006...).jpg
// tuỳ lúc. Nhưng ảnh ghép nặng hơn hẳn — đo được 22,5 MB so với trung bình
// 3,8 MB trong cùng thư mục, trong khi lượt không có ảnh ghép thì file lớn
// nhất chỉ hơn trung bình 1,3-1,8 lần.
function findFramed(imgs) {
    const byName = imgs.filter(x => /selfbooth|noir/i.test(x.name));
    // Google không tạo thumbnail cho mọi file (PNG ghép 23 MB thường không có)
    // -> trong các ảnh ghép, ưu tiên cái xem trước được
    if (byName.length) return byName.find(x => x.thumbnailLink) || byName[0];

    const sized = imgs.filter(x => parseInt(x.size || 0) > 0);
    if (sized.length < 3) return null;

    // Lấy mốc từ ảnh chụp thường: dùng trung vị nửa nhỏ thay vì trung bình,
    // vì một lượt có thể có vài bản ghép cùng cỡ lớn, chúng tự kéo trung bình
    // lên rồi làm chính mình không vượt ngưỡng.
    const asc = sized.slice().sort((a, b) => parseInt(a.size) - parseInt(b.size));
    const base = parseInt(asc[Math.floor(asc.length / 4)].size);
    const framed = sized.filter(x => parseInt(x.size) >= base * 3);
    if (!framed.length) return null;

    // Nhiều bản ghép -> ưu tiên bản xem trước được
    return framed.find(x => x.thumbnailLink) || framed[0];
}

// Ảnh mẫu của thư mục đã gửi khách — nhìn là biết đã trả đúng ảnh chưa,
// khỏi phải mở Drive kiểm tra.
const _folderThumb = {};   // { folderId: url | null }

async function loadLinkThumbs() {
    if (!GS_URL) return;
    const boxes = Array.from(document.querySelectorAll('.link-thumb[data-fid]:empty'));
    if (!boxes.length) return;

    // Gom các thư mục chưa biết ảnh mẫu, tránh gọi lại cái đã có
    const need = [...new Set(boxes.map(b => b.getAttribute('data-fid')))].filter(f => !(f in _folderThumb));

    // Đánh dấu đang tải để không nhìn như ô trắng bị lỗi
    boxes.forEach(b => { if (!(b.getAttribute('data-fid') in _folderThumb)) b.classList.add('loading'); });

    const show = fid => {
        const url = _folderThumb[fid];
        document.querySelectorAll(`.link-thumb[data-fid="${fid}"]`).forEach(b => {
            b.classList.remove('loading');
            if (url) {
                // Không đặt referrerpolicy: Google từ chối phục vụ ảnh khi thiếu referrer
                b.innerHTML = `<img src="${escapeHTML(url)}" alt="" title="Bấm để xem lớn" loading="lazy" decoding="async"
                                    onclick="zoomShoot('${escapeHTML(url)}', 'Ảnh đã gửi khách')"
                                    onerror="this.parentNode.classList.add('empty'); this.remove();">`;
            } else {
                b.classList.add('empty');
                b.title = 'Không đọc được ảnh trong thư mục này';
            }
        });
    };

    // Hỏi song song và hiện ngay từng cái xong, thay vì chờ hết mới vẽ:
    // gọi lần lượt 5 thư mục mất 2,4 giây, song song còn 0,6 giây
    await Promise.all(need.map(async fid => {
        try {
            const imgs = await driveQuery(
                `'${fid}' in parents and mimeType contains 'image/' and trashed=false`,
                'files(id,name,size,thumbnailLink)'
            );
            // Ưu tiên ảnh ghép khung: đó là thứ khách nhận được
            const pick = findFramed(imgs) || imgs[Math.floor(imgs.length / 2)];
            // Ô rộng 44px, không cần ảnh 220px
            _folderThumb[fid] = (pick && thumbAt(pick.thumbnailLink, 100)) || null;
        } catch (e) {
            _folderThumb[fid] = null;
        }
        show(fid);
    }));

    // Thư mục đã biết từ trước thì hiện ngay
    boxes.forEach(b => { const fid = b.getAttribute('data-fid'); if (fid in _folderThumb) show(fid); });
}

// Liệt kê lượt chụp trong ngày của một cơ sở, mới nhất trước.
// Đọc thẳng Drive API vì để Apps Script quét thư mục mất tới 80 giây.
async function listShoots(branchId, ymd) {
    const key = branchId + '|' + ymd;
    const c = _shootCache[key];
    if (c && Date.now() - c.at < 60000) return c.list;   // dùng lại trong 1 phút

    const boothName = BOOTH_BY_BRANCH[branchId];
    if (!boothName) throw new Error('Chưa biết máy chụp của cơ sở này');

    // Có thể tồn tại nhiều thư mục trùng tên -> lấy cái thật sự chứa ảnh
    const booths = await driveQuery(`name='${boothName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
    let rootId = null;
    for (const b of booths) {
        const sub = await driveQuery(`'${b.id}' in parents and name='${PHOTO_ROOT}' and trashed=false`);
        if (sub.length) { rootId = sub[0].id; break; }
    }
    if (!rootId) throw new Error('Không tìm thấy thư mục ảnh của ' + boothName);

    const shoots = await driveQuery(`'${rootId}' in parents and name contains '${ymd}' and trashed=false`);

    // Lấy thư mục đã tinh chỉnh + ảnh xem trước, chạy song song cho nhanh
    const list = await Promise.all(shoots.map(async s => {
        const item = { folderName: s.name, time: s.name.substring(8, 10) + ':' + s.name.substring(10, 12) };
        try {
            const ed = await driveQuery(`'${s.id}' in parents and name='${EDITED_NAME}' and trashed=false`);
            if (!ed.length) return item;                  // chưa tinh chỉnh xong
            item.id = ed[0].id;
            item.url = 'https://drive.google.com/drive/folders/' + ed[0].id;
            const imgs = await driveQuery(
                `'${ed[0].id}' in parents and mimeType contains 'image/' and trashed=false`,
                'files(id,name,size,thumbnailLink)'
            );
            item.count = imgs.length;
            // Lấy ảnh giữa lượt: nhân viên chỉ cần nhìn mặt khách để xác nhận,
            // mà ảnh đầu/cuối hay là ảnh thử hoặc ảnh hỏng. Bỏ ảnh ghép khung
            // vì nó gộp nhiều pose nhỏ, khó nhìn rõ mặt.
            const framed = findFramed(imgs);
            const real = framed ? imgs.filter(x => x.id !== framed.id) : imgs;
            const pool = real.length ? real : imgs;
            pool.sort((a, b) => a.name.localeCompare(b.name));
            const mid = pool[Math.floor(pool.length / 2)];
            // Thẻ rộng 150px -> ảnh 220px là vừa, không cần đổi
            item.thumbs = [mid && mid.thumbnailLink].filter(Boolean);
        } catch (e) { /* lượt này lỗi thì bỏ qua, không chặn cả danh sách */ }
        return item;
    }));

    list.sort((a, b) => b.folderName.localeCompare(a.folderName));
    _shootCache[key] = { at: Date.now(), list };
    return list;
}

// Apps Script thỉnh thoảng trả trang HTML trung gian thay vì JSON -> thử lại
async function gsCall(params, tries) {
    if (!GS_URL) throw new Error('Chưa cấu hình nơi lưu ảnh');
    // Mã dùng chung với Apps Script: link web app buộc phải cho mọi người gọi
    // (khách chưa đăng nhập vẫn gửi ảnh được), nên cần thứ này chặn người ngoài.
    const url = GS_URL + '?' + new URLSearchParams(Object.assign({ k: GS_KEY }, params)).toString();
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
let userRole = ''; let dbPath = 'data/'; let br = null;
let currentData = {}; let previousCount = 0; let isFirstLoad = true;
let db, auth;
let branchesCache = {};
let editingBranchId = null;
let editingAccountUid = null;
let _restoreDrafts = {};
let liveQuery = null;      // query đang lắng nghe danh sách khách
let fullDataCache = null;  // toàn bộ dữ liệu, chỉ tải khi làm báo cáo

const firebaseConfig = { apiKey: "AIzaSyAcih83r2AhH85J3Pp31i7qq8OkuRAIyxw", databaseURL: "https://tra-anh-khach-default-rtdb.asia-southeast1.firebasedatabase.app", projectId: "tra-anh-khach" };

try {
    firebase.initializeApp(firebaseConfig);
    db = firebase.database();
    auth = firebase.auth();
} catch (error) {
    console.error("Firebase Error:", error);
}

const LOGIN_DOMAIN = '@photonoir.local';
function toLoginEmail(username) {
    const u = username.trim().toLowerCase();
    return u.includes('@') ? u : u + LOGIN_DOMAIN;
}

function escapeHTML(str) {
    if (!str) return '';
    return String(str).replace(/[&<>'"]/g, tag => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    }[tag] || tag));
}

let Toast;
try {
    Toast = Swal.mixin({
        toast: true, position: 'top-end', showConfirmButton: false, timer: 2500,
        timerProgressBar: true, background: '#111', color: '#fff', iconColor: '#fff',
        didOpen: (el) => { const c = el.closest('.swal2-container'); if (c) c.style.zIndex = '3000'; }
    });
} catch (e) {
    Toast = { fire: (args) => alert(args.title) };
}

function getDStr(dObj) { return String(dObj.getDate()).padStart(2, '0') + '/' + String(dObj.getMonth() + 1).padStart(2, '0') + '/' + dObj.getFullYear(); }

window.onload = () => {
    const remembered = localStorage.getItem('pn_remember_user');
    if (remembered) {
        document.getElementById('login-email').value = remembered;
        document.getElementById('login-remember').checked = true;
    }
    auth.onAuthStateChanged(async (user) => {
        if (!user) return;
        try {
            const snap = await db.ref('users/' + user.uid).once('value');
            const profile = snap.val();
            if (!profile) { await auth.signOut(); return; }
            userRole = profile.role;
            br = (profile.role === 'admin') ? null : profile.branch;
            await setupUI();
        } catch (e) {
            console.error(e);
            auth.signOut();
        }
    });
};

function showLoginError(msg) {
    if (typeof Swal !== 'undefined') Swal.fire({ icon: 'error', title: msg, confirmButtonColor: '#111' });
    else alert(msg);
}

// Đổi ngày phải tải lại từ máy chủ: chỉ giữ sẵn các phiên gần nhất nên ngày cũ
// có thể chưa nằm trong đó, lọc suông sẽ ra danh sách trống.
function applyDateFilter() {
    isFirstLoad = true; previousCount = 0;
    load();
}

function clearDateFilter() {
    const fp = document.getElementById('date-filter')._flatpickr;
    if(fp) fp.clear();
    LOAD_LIMIT = LOAD_LIMIT_BASE;
    isFirstLoad = true; previousCount = 0;
    load();
}

function login() {
    const username = document.getElementById('login-email').value.trim();
    const pass = document.getElementById('login-pass').value;
    if (!username || !pass) return showLoginError("Vui lòng nhập tên đăng nhập và mật khẩu.");
    const email = toLoginEmail(username);

    auth.signInWithEmailAndPassword(email, pass).then(async (cred) => {
        const snap = await db.ref('users/' + cred.user.uid).once('value');
        const profile = snap.val();
        if (!profile) {
            await auth.signOut();
            return showLoginError("Tài khoản chưa được cấp quyền truy cập cơ sở nào.");
        }
        userRole = profile.role;
        br = (profile.role === 'admin') ? null : profile.branch;
        if (document.getElementById('login-remember').checked) {
            localStorage.setItem('pn_remember_user', username);
        } else {
            localStorage.removeItem('pn_remember_user');
        }
        await setupUI();
        Toast.fire({ icon: 'success', title: 'Đăng nhập thành công' });
    }).catch(() => showLoginError("Sai tên đăng nhập hoặc mật khẩu!"));
}

function logout() {
    if (typeof Swal !== 'undefined') {
        Swal.fire({
            title: 'Đăng xuất?', icon: 'question', showCancelButton: true, confirmButtonColor: '#111', confirmButtonText: 'Đăng xuất', cancelButtonText: '<span style="color:#111">Hủy</span>'
        }).then((r) => { if (r.isConfirmed) { auth.signOut().then(() => location.reload()); }});
    } else {
        if(confirm("Bạn có chắc chắn muốn đăng xuất?")) { auth.signOut().then(() => location.reload()); }
    }
}

async function setupUI() {
    document.body.classList.add('role-' + userRole);
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('admin-box').style.display = 'block';
    document.getElementById('role-badge').innerText = userRole === 'admin' ? "ADMIN" : (userRole === 'viewer' ? "XEM THU NHẬP" : "NHÂN VIÊN");

    flatpickr("#date-filter", { mode: "range", dateFormat: "d/m/Y", locale: "vn", defaultDate: new Date() });

    // Key imgbb đặt trong Quản lý; theo dõi realtime để đổi key là các máy khác nhận ngay
    db.ref('config/imgbb_key').on('value', s => {
        const k = (s.val() || '').trim();
        IMGBB_API_KEY = k || IMGBB_FALLBACK_KEY;
        const inp = document.getElementById('imgbb-key-input');
        if (inp && inp !== document.activeElement) inp.value = k;
    }, () => { /* không đọc được -> dùng key dự phòng */ });

    // Nơi lưu ảnh khách gửi: có link Apps Script thì dùng Drive, để trống thì imgbb
    db.ref('config/gs_url').on('value', s => {
        GS_URL = (s.val() || '').trim();
        const inp = document.getElementById('gs-url-input');
        if (inp && inp !== document.activeElement) inp.value = GS_URL;
    }, () => { GS_URL = ''; });

    const bSnap = await db.ref('branches').once('value');
    branchesCache = bSnap.val() || {};
    renderBranchTabs();
    populateAccountBranchSelect();
    if (userRole === 'admin') loadAccountList();
    if (userRole === 'viewer') {
        // load() đã chạy trong renderBranchTabs → currentData sẵn sàng; mở bảng doanh thu inline
        setTimeout(openRevenueModal, 300);
    }
}

function renderBranchTabs() {
    const wrap = document.getElementById('branch-tabs');
    wrap.innerHTML = '';
    if (userRole === 'admin') {
        const ids = Object.keys(branchesCache);
        ids.forEach((id, i) => {
            const btn = document.createElement('button');
            btn.className = 'tab-btn' + (i === 0 ? ' active' : '');
            btn.id = 'btn-' + id;
            btn.innerText = branchesCache[id].name || id;
            btn.onclick = () => switchB(id);
            wrap.appendChild(btn);
        });
        wrap.style.display = ids.length ? 'flex' : 'none';
        if (!br || !branchesCache[br]) br = ids[0] || null;
    } else {
        wrap.style.display = 'none';
    }
    renderClearTargetOptions();
    if (db && br) load();
}

function renderClearTargetOptions() {
    const sel = document.getElementById('clear-target');
    sel.innerHTML = '';
    if (userRole === 'admin') {
        Object.keys(branchesCache).forEach(id => {
            const opt = document.createElement('option');
            opt.value = id;
            opt.innerText = 'Chỉ dọn ' + (branchesCache[id].name || id);
            sel.appendChild(opt);
        });
        const allOpt = document.createElement('option');
        allOpt.value = 'all';
        allOpt.style.fontWeight = 'bold';
        allOpt.innerText = 'DỌN SẠCH TẤT CẢ CƠ SỞ';
        sel.appendChild(allOpt);
    } else if (br && branchesCache[br]) {
        const opt = document.createElement('option');
        opt.value = br;
        opt.innerText = 'Chỉ dọn ' + (branchesCache[br].name || br);
        sel.appendChild(opt);
    }
}

function switchB(name) { br = name; isFirstLoad = true; previousCount = 0; LOAD_LIMIT = LOAD_LIMIT_BASE; fullDataCache = null; document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active')); const b2 = document.getElementById('btn-'+name); if (b2) b2.classList.add('active'); load(); }

function toggleTrash() {
    if (dbPath === 'data/') { 
        dbPath = 'trash/'; 
        document.getElementById('btn-trash').innerHTML = '<svg class="icon-svg" style="margin-right:4px;" viewBox="0 0 24 24"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg> Quay lại'; 
        document.getElementById('btn-trash').style.color = '#18181b'; 
    } else { 
        dbPath = 'data/'; 
        document.getElementById('btn-trash').innerHTML = '<svg class="icon-svg" style="margin-right:4px;" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg> Thùng rác'; 
        document.getElementById('btn-trash').style.color = '#52525b'; 
    }
    isFirstLoad = true; previousCount = 0; LOAD_LIMIT = LOAD_LIMIT_BASE; load();
}

function openRevenueModal() {
    if(userRole !== 'admin' && userRole !== 'viewer') return Toast.fire({icon: 'error', title: 'Không có quyền xem thu nhập'});
    
    setTimeout(() => {
        const now = new Date();
        flatpickr("#rev-date-range", { mode: "range", dateFormat: "d/m/Y", locale: "vn", defaultDate: now });
        
        flatpickr("#rev-month-val", {
            plugins: [ new monthSelectPlugin({ shorthand: true, dateFormat: "m/Y", altFormat: "m/Y" }) ],
            locale: "vn",
            defaultDate: now
        });
        
        document.getElementById('rev-year-picker').value = String(now.getFullYear());
        
        calcRevenue();
        calcRevenueByMonth();
        calcRevenueByYear();
    }, 100);

    document.getElementById('revenue-modal').style.display = 'flex';
}

// Danh sách chỉ tải các phiên gần nhất -> báo cáo phải đọc riêng, nếu không
// doanh thu tháng/năm và Excel sẽ thiếu dữ liệu cũ.
// Đọc cả nhánh là 377 KB (Phúc Yên) nên chỉ lấy đúng khoảng cần: id phiên là
// S_<timestamp> nên lọc theo khoảng key được.
function withFullData(fn, fromTs, toTs) {
    if (dbPath !== 'data/') return fn(currentData);       // thùng rác không phân trang

    const key = br + '|' + (fromTs || 0) + '|' + (toTs || 0);
    if (fullDataCache && fullDataCache._key === key) return fn(fullDataCache.data);

    let q = db.ref('data/' + br).orderByKey();
    if (fromTs) q = q.startAt('S_' + fromTs);
    if (toTs && toTs !== Infinity) q = q.endAt('S_' + toTs);

    Toast.fire({ icon: 'info', title: 'Đang tải dữ liệu...' });
    return q.once('value').then(snap => {
        const all = snap.val() || {};
        fullDataCache = { _key: key, data: all };
        fn(all);
    }).catch(err => Swal.fire('Lỗi', 'Không tải được dữ liệu: ' + err.message, 'error'));
}

function calcRevenue() {
    const fp = document.getElementById('rev-date-range')._flatpickr;
    let fTs = 0, tTs = Infinity;
    let titleStr = "KHOẢNG THỜI GIAN";

    if (fp && fp.selectedDates.length > 0) {
        fTs = new Date(fp.selectedDates[0]).setHours(0,0,0,0);
        tTs = fp.selectedDates.length > 1 ? new Date(fp.selectedDates[1]).setHours(23,59,59,999) : new Date(fp.selectedDates[0]).setHours(23,59,59,999);
        
        const d1 = getDStr(fp.selectedDates[0]);
        if (fp.selectedDates.length > 1) titleStr = `TỪ ${d1} ĐẾN ${getDStr(fp.selectedDates[1])}`;
        else titleStr = `NGÀY ${d1}`;
    } else {
        return Toast.fire({ icon: 'warning', title: 'Vui lòng chọn ngày!' });
    }

    withFullData(all => {
        let dTotal = 0, dCash = 0, dTrans = 0, dCount = 0, dFree = 0;
        let dUnknown = 0, dUnknownN = 0;

        if (all && dbPath === 'data/') {
            Object.keys(all).forEach(id => {
                const c = all[id];
                const ts = parseInt(id.split('_')[1]);
                if (!ts) return; // id hỏng -> không tính vào doanh thu

                if (ts >= fTs && ts <= tTs) {
                    const isFree = (c.price === 'Miễn phí');
                    const priceVal = isFree ? 0 : (parseInt((c.price||'').replace(/\D/g, ''), 10) || 0);

                    dCount++;
                    if (isFree) dFree++;
                    dTotal += priceVal;
                    if (c.payment === 'Tiền mặt') dCash += priceVal;
                    if (c.payment === 'Chuyển khoản') dTrans += priceVal;
                    // Có giá mà quên chọn hình thức TT -> không vào cột nào, tổng lệch
                    if (!isFree && priceVal > 0 && c.payment !== 'Tiền mặt' && c.payment !== 'Chuyển khoản') { dUnknown += priceVal; dUnknownN++; }
                }
            });
        }

        document.getElementById('rev-day-title').innerText = titleStr;
        document.getElementById('rev-day-count').innerText = dCount + ' lượt';
        document.getElementById('rev-day-free').innerText = dFree + ' miễn phí';
        document.getElementById('rev-day-cash').innerText = dCash.toLocaleString('vi-VN') + ' ₫';
        document.getElementById('rev-day-trans').innerText = dTrans.toLocaleString('vi-VN') + ' ₫';
        document.getElementById('rev-day-total').innerText = dTotal.toLocaleString('vi-VN') + ' ₫';
        const dUnkEl = document.getElementById('rev-day-unknown');
        if (dUnkEl) {
            dUnkEl.style.display = dUnknown ? 'block' : 'none';
            dUnkEl.innerText = dUnknown ? ('⚠ Chưa chọn hình thức TT: ' + dUnknown.toLocaleString('vi-VN') + ' ₫ (' + dUnknownN + ' lượt)') : '';
        }
    }, fTs, tTs);
}

function calcRevenueByMonth() {
    const mStrInput = document.getElementById('rev-month-val').value; 
    if(!mStrInput) return Toast.fire({ icon: 'warning', title: 'Vui lòng chọn tháng!' });
    const targetMonth = mStrInput;

    // Chỉ tải đúng tháng đó thay vì cả nhánh (377 KB ở Phúc Yên)
    const mParts = targetMonth.split('/').map(Number);
    const mFrom = new Date(mParts[1], mParts[0] - 1, 1).getTime();
    const mTo = new Date(mParts[1], mParts[0], 0, 23, 59, 59, 999).getTime();

    withFullData(all => {
        let mTotal = 0, mCash = 0, mTrans = 0, mCount = 0, mFree = 0;
        let mUnknown = 0, mUnknownN = 0;

        if (all && dbPath === 'data/') {
            Object.keys(all).forEach(id => {
                const c = all[id];
                const ts = parseInt(id.split('_')[1]);
                if (!ts) return;
                const dObj = new Date(ts);
                const cMm = String(dObj.getMonth() + 1).padStart(2, '0');
                const cYyyy = String(dObj.getFullYear());
                const cStr = `${cMm}/${cYyyy}`;

                if (cStr === targetMonth) {
                    const isFree = (c.price === 'Miễn phí');
                    const priceVal = isFree ? 0 : (parseInt((c.price||'').replace(/\D/g, ''), 10) || 0);

                    mCount++;
                    if (isFree) mFree++;
                    mTotal += priceVal;
                    if (c.payment === 'Tiền mặt') mCash += priceVal;
                    if (c.payment === 'Chuyển khoản') mTrans += priceVal;
                    // Có giá mà quên chọn hình thức TT -> không vào cột nào, tổng lệch
                    if (!isFree && priceVal > 0 && c.payment !== 'Tiền mặt' && c.payment !== 'Chuyển khoản') { mUnknown += priceVal; mUnknownN++; }
                }
            });
        }

        document.getElementById('rev-month-title').innerText = `THÁNG ${targetMonth}`;
        document.getElementById('rev-month-count').innerText = mCount + ' lượt';
        document.getElementById('rev-month-free').innerText = mFree + ' miễn phí';
        document.getElementById('rev-month-cash').innerText = mCash.toLocaleString('vi-VN') + ' ₫';
        document.getElementById('rev-month-trans').innerText = mTrans.toLocaleString('vi-VN') + ' ₫';
        document.getElementById('rev-month-total').innerText = mTotal.toLocaleString('vi-VN') + ' ₫';
        const mUnkEl = document.getElementById('rev-month-unknown');
        if (mUnkEl) {
            mUnkEl.style.display = mUnknown ? 'block' : 'none';
            mUnkEl.innerText = mUnknown ? ('⚠ Chưa chọn hình thức TT: ' + mUnknown.toLocaleString('vi-VN') + ' ₫ (' + mUnknownN + ' lượt)') : '';
        }
    }, mFrom, mTo);
}

function calcRevenueByYear() {
    const yyyy = document.getElementById('rev-year-picker').value;
    const yFrom = yyyy ? new Date(+yyyy, 0, 1).getTime() : 0;
    const yTo = yyyy ? new Date(+yyyy, 11, 31, 23, 59, 59, 999).getTime() : 0;
    withFullData(all => {
        let yTotal = 0, yCash = 0, yTrans = 0, yCount = 0, yFree = 0;
        let yUnknown = 0, yUnknownN = 0;

        if (all && dbPath === 'data/' && yyyy) {
            Object.keys(all).forEach(id => {
                const c = all[id];
                const ts = parseInt(id.split('_')[1]);
                if (!ts) return;
                const dObj = new Date(ts);

                if (String(dObj.getFullYear()) === yyyy) {
                    const isFree = (c.price === 'Miễn phí');
                    const priceVal = isFree ? 0 : (parseInt((c.price||'').replace(/\D/g, ''), 10) || 0);

                    yCount++;
                    if (isFree) yFree++;
                    yTotal += priceVal;
                    if (c.payment === 'Tiền mặt') yCash += priceVal;
                    if (c.payment === 'Chuyển khoản') yTrans += priceVal;
                    // Có giá mà quên chọn hình thức TT -> không vào cột nào, tổng lệch
                    if (!isFree && priceVal > 0 && c.payment !== 'Tiền mặt' && c.payment !== 'Chuyển khoản') { yUnknown += priceVal; yUnknownN++; }
                }
            });
        }

        document.getElementById('rev-year-title').innerText = `NĂM ${yyyy}`;
        document.getElementById('rev-year-count').innerText = yCount + ' lượt';
        document.getElementById('rev-year-free').innerText = yFree + ' miễn phí';
        document.getElementById('rev-year-total').innerText = yTotal.toLocaleString('vi-VN') + ' ₫';
        const yUnkEl = document.getElementById('rev-year-unknown');
        if (yUnkEl) {
            yUnkEl.style.display = yUnknown ? 'block' : 'none';
            yUnkEl.innerText = yUnknown ? ('⚠ Chưa chọn hình thức TT: ' + yUnknown.toLocaleString('vi-VN') + ' ₫ (' + yUnknownN + ' lượt)') : '';
        }
        document.getElementById('rev-year-cash').innerText = yCash.toLocaleString('vi-VN') + ' ₫';
        document.getElementById('rev-year-trans').innerText = yTrans.toLocaleString('vi-VN') + ' ₫';
    }, yFrom, yTo);
}

// Chỉ tải N phiên gần nhất: dựng lại cả nghìn thẻ mỗi lần DB đổi làm admin đứng hình.
// Firebase lọc sẵn ở máy chủ nên không tải thừa về rồi mới bỏ.
// Máy tính bảng và máy cũ chậm hẳn từ khoảng 5.000 phần tử DOM; mỗi thẻ khách
// khoảng 49 phần tử nên 60 phiên là ~2.900 — vẫn phủ hết một ca làm việc.
const LOAD_LIMIT_BASE = 60;
let LOAD_LIMIT = LOAD_LIMIT_BASE;
const LOAD_LIMIT_STEP = 60;

// Tóm tắt ca hôm nay: trước phải cuộn hết danh sách mới biết còn sót gì
function renderTodayBar() {
    const bar = document.getElementById('today-bar');
    if (!bar) return;
    if (dbPath !== 'data/' || !currentData) { bar.style.display = 'none'; return; }

    // Theo khoảng ngày đang xem, không phải luôn là hôm nay
    const fp = document.getElementById('date-filter')._flatpickr;
    let fTs = 0, tTs = Infinity, label = 'Tất cả';

    if (fp && fp.selectedDates.length > 0) {
        fTs = new Date(fp.selectedDates[0]).setHours(0, 0, 0, 0);
        tTs = fp.selectedDates.length > 1
            ? new Date(fp.selectedDates[1]).setHours(23, 59, 59, 999)
            : new Date(fp.selectedDates[0]).setHours(23, 59, 59, 999);
        const d1 = getDStr(fp.selectedDates[0]);
        label = (fp.selectedDates.length > 1) ? `${d1} → ${getDStr(fp.selectedDates[1])}`
              : (d1 === getDStr(new Date()) ? 'Hôm nay' : d1);
    }

    let n = 0, noPrice = 0, noLink = 0, revenue = 0, pending = 0;
    Object.keys(currentData).forEach(id => {
        const ts = parseInt(id.split('_')[1]);
        if (!ts || ts < fTs || ts > tTs) return;
        const c = currentData[id];
        n++;
        if (!c.price) noPrice++;
        if (!c.links) noLink++;
        if (c.client_uploads) pending++;
        if (c.price && c.price !== 'Miễn phí') revenue += parseInt(String(c.price).replace(/\D/g, ''), 10) || 0;
    });

    if (!n) { bar.style.display = 'none'; return; }

    const chip = (label, val, cls, filter) => {
        const tag = filter ? 'button' : 'span';
        const attr = filter ? ` type="button" onclick="filterToday('${filter}')"` : '';
        return `<${tag} class="today-chip${cls ? ' ' + cls : ''}"${attr}>${label} <b>${val}</b></${tag}>`;
    };

    bar.style.display = 'block';
    bar.innerHTML = `<div class="today-bar">
        <span class="label">${escapeHTML(label)}</span>
        ${chip('Khách', n, '', 'all')}
        ${noPrice ? chip('Chưa nhập tiền', noPrice, 'warn', 'noprice') : ''}
        ${noLink ? chip('Chưa trả ảnh', noLink, 'warn', 'nolink') : ''}
        ${pending ? chip('Yêu cầu in', pending, 'warn', 'pending') : ''}
        ${(!noPrice && !noLink) ? chip('Đã xong', '✓', 'ok', '') : ''}
        <span class="today-total admin-only">${revenue.toLocaleString('vi-VN')} ₫</span>
    </div>`;
}

// Bấm vào con số trên thanh hôm nay -> lọc thẳng ra các phiên đó
function filterToday(kind) {
    // Lọc trong đúng khoảng ngày đang xem, không mặc định hôm nay
    const fp = document.getElementById('date-filter')._flatpickr;
    let fTs = 0, tTs = Infinity;
    if (fp && fp.selectedDates.length > 0) {
        fTs = new Date(fp.selectedDates[0]).setHours(0, 0, 0, 0);
        tTs = fp.selectedDates.length > 1
            ? new Date(fp.selectedDates[1]).setHours(23, 59, 59, 999)
            : new Date(fp.selectedDates[0]).setHours(23, 59, 59, 999);
    }

    document.getElementById('search-box').value = '';
    let shown = 0;

    document.querySelectorAll('.date-group').forEach(group => {
        const head = group.querySelector('.date-header span:first-child');
        const parts = head.innerText.split(', ').pop().trim().split('/');
        const groupTs = new Date(`${parts[2]}-${parts[1]}-${parts[0]}T12:00:00`).getTime();
        const inRange = groupTs >= fTs && groupTs <= tTs;
        let anyCard = false;

        group.querySelectorAll('.client-card').forEach(card => {
            let ok = inRange;
            if (ok && kind === 'noprice') ok = card.classList.contains('card-no-price');
            if (ok && kind === 'nolink') ok = !card.querySelector('.link-manager .link-row');
            if (ok && kind === 'pending') ok = !!card.querySelector('[onclick^="delClientUp"]');
            card.style.display = ok ? 'flex' : 'none';
            if (ok) { anyCard = true; shown++; }
        });
        group.style.display = anyCard ? 'block' : 'none';
    });

    const empty = document.getElementById('empty-msg');
    document.querySelector('.empty-text').innerText = 'Không có phiên nào khớp.';
    empty.style.display = shown ? 'none' : 'block';
    if (shown) Toast.fire({ icon: 'info', title: `Đang xem ${shown} phiên` });
}

// Cập nhật tại chỗ một thẻ khách, không dựng lại DOM.
// Bỏ qua ô mà người dùng đang gõ để không cướp con trỏ.
function patchCard(clientId, c) {
    if (!c) return;
    const priceInp = document.getElementById('price_' + clientId);
    if (!priceInp) return; // thẻ không nằm trong danh sách đang hiển thị
    const card = priceInp.closest('.client-card');
    if (!card) return;

    const active = document.activeElement;
    const pVal = c.price ? normalizePrice(c.price) : '';
    const isFree = (pVal === 'Miễn phí');

    if (priceInp !== active) {
        priceInp.value = pVal;
        priceInp.disabled = isFree;
    }

    const paySel = document.getElementById('payment_' + clientId);
    if (paySel && paySel !== active) {
        paySel.value = isFree ? 'Miễn phí' : (c.payment || '');
        paySel.classList.toggle('is-empty', !paySel.value);
    }

    card.classList.toggle('card-no-price', !pVal && dbPath === 'data/');

    const badge = card.querySelector('.badge');
    if (badge) {
        const isDone = c.status === 'completed';
        badge.className = 'badge ' + (isDone ? 'done' : 'pending');
        badge.innerText = isDone ? 'ĐÃ TRẢ ẢNH' : 'ĐANG CHỤP';
    }

    // Máy khác vừa sửa link -> cập nhật ô, trừ ô đang gõ dở
    if (c.links) {
        Object.keys(c.links).forEach(lid => {
            const li = document.getElementById('lnk_' + clientId + '_' + lid);
            if (li && li !== active) {
                const u = c.links[lid].url || '';
                li.value = u;
                li.setAttribute('data-orig', u);
            }
        });
    }

    // Tên hoặc SĐT đổi -> huy hiệu khách quen và ô tìm kiếm phải dựng lại
    const h4 = card.querySelector('h4 span');
    if (h4 && h4.innerText !== (c.name || 'Khách hàng')) return true;
    const search = card.getAttribute('data-search') || '';
    if (c.phone && search.indexOf(String(c.phone)) === -1) return true;

    // Số ảnh hoặc yêu cầu in đổi -> cấu trúc thẻ khác, phải vẽ đầy đủ
    const shownLinks = card.querySelectorAll('.link-manager .link-row').length;
    const realLinks = c.links ? Object.keys(c.links).length : 0;
    const shownUploads = card.querySelectorAll('[onclick^="delClientUp"]').length;
    const realUploads = c.client_uploads ? Object.keys(c.client_uploads).length : 0;
    return (shownLinks !== realLinks || shownUploads !== realUploads);
}

function loadMore() {
    LOAD_LIMIT += LOAD_LIMIT_STEP;
    isFirstLoad = true; previousCount = 0;
    load();
    Toast.fire({ icon: 'info', title: 'Đang tải thêm phiên cũ...' });
}

function load() {
    if (liveQuery) { liveQuery.off(); liveQuery = null; }
    db.ref('data/' + br).off(); db.ref('trash/' + br).off();

    // Chọn ngày thì tải đúng khoảng ngày đó, không thì lấy các phiên gần nhất.
    // Id phiên là S_<timestamp> nên lọc theo khoảng key được.
    const fp0 = document.getElementById('date-filter') && document.getElementById('date-filter')._flatpickr;
    if (fp0 && fp0.selectedDates.length > 0) {
        const from = new Date(fp0.selectedDates[0]).setHours(0, 0, 0, 0);
        const to = fp0.selectedDates.length > 1
            ? new Date(fp0.selectedDates[1]).setHours(23, 59, 59, 999)
            : new Date(fp0.selectedDates[0]).setHours(23, 59, 59, 999);
        liveQuery = db.ref(dbPath + br).orderByKey()
                      .startAt('S_' + from).endAt('S_' + to);
    } else {
        liveQuery = db.ref(dbPath + br).orderByKey().limitToLast(LOAD_LIMIT);
    }
    liveQuery.on('value', snap => {
        const list = document.getElementById('list-content');
        const trashHeader = document.getElementById('trash-header');

        // Realtime vẽ lại toàn bộ danh sách -> giữ link đang gõ dở của từng khách
        const draftLinks = {};
        document.querySelectorAll('textarea[id^="new_"]').forEach(t => {
            if (t.value.trim()) draftLinks[t.id] = t.value;
        });

        const newData = snap.val();

        // Sửa 1 ô giá mà vẽ lại cả 200 thẻ (~10.000 phần tử) làm trang khựng vài giây.
        // Nếu chỉ vài khách đổi và số lượng không đổi -> chỉ thay đúng thẻ đó.
        if (!isFirstLoad && currentData && newData && list.children.length) {
            const oldKeys = Object.keys(currentData), newKeys = Object.keys(newData);
            if (oldKeys.length === newKeys.length && newKeys.every(k => currentData[k])) {
                const changed = newKeys.filter(k => JSON.stringify(currentData[k]) !== JSON.stringify(newData[k]));
                if (changed.length && changed.length <= 5) {
                    currentData = newData;
                    fullDataCache = null;
                    // patchCard trả true nếu cấu trúc thẻ đổi (thêm/bớt ảnh) -> cần vẽ đầy đủ
                    const needFull = changed.map(id => patchCard(id, newData[id])).some(Boolean);
                    if (!needFull) { renderTodayBar(); return; }
                }
            }
        }

        list.innerHTML = ""; document.getElementById('empty-msg').style.display = 'none';
        currentData = newData;
        fullDataCache = null; // dữ liệu vừa đổi -> báo cáo phải đọc lại, không dùng số cũ
        _restoreDrafts = draftLinks;

        if(!currentData) { 
            document.querySelector('.empty-text').innerText = (dbPath === 'trash/') ? "Thùng rác đang trống." : "Chưa có dữ liệu nào.";
            document.getElementById('empty-msg').style.display = 'block';
            trashHeader.style.display = 'none'; previousCount = 0; _restoreDrafts = {}; return;
        }

        if (dbPath === 'trash/') {
            trashHeader.style.display = 'flex';
            trashHeader.innerHTML = `<div class="trash-notice" style="width:100%;"><div style="display:flex; align-items:center; gap:12px;"><svg class="icon-svg" viewBox="0 0 24 24"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg><div><b style="font-size:14px; font-family:'Inter';">THÙNG RÁC</b></div></div><div><label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-weight:600; font-size:12px;"><input type="checkbox" onclick="toggleSelectAllTrash(this)" style="width:16px; height:16px; cursor:pointer;"> CHỌN TẤT CẢ</label><button onclick="deleteSelectedTrash()" style="background:#fff; color:#ef4444; border:none; padding: 6px 12px; border-radius:6px; cursor:pointer; font-weight:700; font-size:11px; margin-top:8px; width:100%; font-family:'Inter';">XÓA MỤC ĐÃ CHỌN</button></div></div>`;
        } else { trashHeader.style.display = 'none'; }

        const currentCount = Object.keys(currentData).length;
        if(!isFirstLoad && currentCount > previousCount && dbPath === 'data/') { Toast.fire({ icon: 'info', title: 'Có khách hàng mới!' });}
        previousCount = currentCount; isFirstLoad = false;
        
        const groupedData = {};
        Object.keys(currentData).forEach(clientId => {
            const client = currentData[clientId];
            // Không fallback Date.now(): id hỏng sẽ bị gom nhầm vào hôm nay
            const timestamp = parseInt(clientId.split('_')[1]);
            if (!timestamp) return;
            const dateStr = getDStr(new Date(timestamp));
            if(!groupedData[dateStr]) groupedData[dateStr] = { timestamp: timestamp, clients: [] };
            groupedData[dateStr].clients.push({ id: clientId, ...client, ts: timestamp });
        });

        const sortedDates = Object.keys(groupedData).sort((a, b) => groupedData[b].timestamp - groupedData[a].timestamp);
        const todayStr = getDStr(new Date());

        // Đếm số lần chụp theo SĐT để đánh dấu khách quen — nhân viên không có
        // cách nào biết ai từng đến, dù hơn 200 khách đã quay lại
        const visitCount = {};
        Object.values(currentData).forEach(c => {
            const p = String(c.phone || '').replace(/\D/g, '');
            if (p.length >= 9) visitCount[p] = (visitCount[p] || 0) + 1;
        });

        sortedDates.forEach(date => {
            const groupDiv = document.createElement('div'); groupDiv.className = 'date-group';
            const dateLabel = (date === todayStr) ? "Hôm nay, " + date : date;
            let html = `<div class="date-header"><span style="display:flex; align-items:center;"><svg class="icon-sm" style="margin-right:6px;" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg> ${dateLabel}</span><span style="font-size:12px; color:#71717a;">${groupedData[date].clients.length} khách</span></div>`;
            
            groupedData[date].clients.sort((a, b) => b.ts - a.ts).forEach(client => {
                const isDone = client.status === 'completed'; const maKh = client.id.split('_')[1].slice(-4); const safeName = escapeHTML(client.name || "Khách hàng");

                let linksHtml = '';
                if (client.links) {
                    Object.keys(client.links).forEach(linkId => {
                        const lUrl = escapeHTML(client.links[linkId].url || '');
                        // Link thư mục Drive -> nạp ảnh mẫu để nhân viên biết đã gửi ảnh gì
                        const fid = (String(client.links[linkId].url || '').match(/folders\/([\w-]+)/) || [])[1];
                        linksHtml += `<div class="link-row">
                            ${fid ? `<div class="link-thumb" id="lt_${client.id}_${linkId}" data-fid="${escapeHTML(fid)}"></div>` : ''}
                            <span class="time-label">${escapeHTML((client.links[linkId].addedAt || '').split(' ')[0])}</span>
                            <input type="text" id="lnk_${client.id}_${linkId}" value="${lUrl}" data-orig="${lUrl}"
                                   onchange="updateLink('${client.id}', '${linkId}')"
                                   onkeydown="if(event.key==='Enter'){this.blur();}"
                                   title="Sửa link rồi bấm Enter hoặc click ra ngoài để lưu">
                            <button onclick="deleteLink('${client.id}', '${linkId}')" class="btn-del-link">XÓA</button>
                        </div>`;
                    });
                }

                let clientUploadsHtml = '';
                if (client.client_uploads && dbPath === 'data/') {
                    Object.keys(client.client_uploads).forEach(uId => {
                        const up = client.client_uploads[uId];
                        // Ảnh cũ nằm trên imgbb (links), ảnh mới nằm trên Drive (drive)
                        const upLinks = Array.isArray(up.links) ? up.links : [];
                        const upDrive = Array.isArray(up.drive) ? up.drive : [];
                        const upCount = upLinks.length + upDrive.length;

                        let imgLinks = "";
                        upLinks.forEach((l, i) => {
                            imgLinks += `<a href="${escapeHTML(l)}" target="_blank" rel="noopener" style="color:#111; font-size:12px; font-weight:600; text-decoration:underline; margin-right:12px; display:inline-block; margin-top:5px;">Ảnh gốc ${i+1}</a>`;
                        });
                        upDrive.forEach((d, i) => {
                            imgLinks += `<a href="https://drive.google.com/file/d/${escapeHTML(d.id)}/view" target="_blank" rel="noopener" style="color:#111; font-size:12px; font-weight:600; text-decoration:underline; margin-right:12px; display:inline-block; margin-top:5px;">Ảnh gốc ${upLinks.length + i + 1}</a>`;
                        });
                        clientUploadsHtml += `
                            <div style="background:#fafafa; border:1px dashed #d4d4d8; padding:12px 15px; border-radius:10px; margin-bottom:12px;">
                                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; flex-wrap:wrap; gap:10px;">
                                    <span style="font-size:12px; font-weight:700; color:#111; display:flex; align-items:center; gap:6px; text-transform:uppercase;">
                                        <svg class="icon-sm" viewBox="0 0 24 24"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"></polyline><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"></path></svg>
                                        Yêu cầu in (${up.time.split(' ')[1] || ''})
                                    </span>
                                    <div style="display:flex; gap:8px;">
                                        ${up.folder ? `<a href="${escapeHTML(up.folder)}" target="_blank" rel="noopener" class="up-btn ghost">MỞ THƯ MỤC</a>` : ''}
                                        <button onclick="downloadAllUploads('${client.id}', '${uId}', this)" class="up-btn solid">TẢI TẤT CẢ (${upCount})</button>
                                        <button onclick="delClientUp('${client.id}', '${uId}')" class="up-btn danger">Hoàn tất (Xóa)</button>
                                    </div>
                                </div>
                                <div style="display:flex; flex-wrap:wrap;">${imgLinks}</div>
                            </div>`;
                    });
                }

                let actionButtons = (dbPath === 'trash/') ? 
                    `<button class="btn-restore admin-only" onclick="restoreCustomer('${client.id}', '${safeName}')"><svg class="icon-svg" style="margin-right:4px;" viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path><polyline points="9 22 9 12 15 12 15 22"></polyline></svg> KHÔI PHỤC</button>
                    <button class="btn-del-client admin-only" onclick="hardDeleteCustomer('${client.id}', '${safeName}')" style="margin-top:10px;"><svg class="icon-svg" style="margin-right:4px;" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg> XÓA VĨNH VIỄN</button>` :
                    `<button class="btn-move-client admin-only" onclick="moveCustomer('${client.id}', '${safeName}')"><svg class="icon-svg" style="margin-right:4px;" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"></circle><polyline points="12 16 16 12 12 8"></polyline><line x1="8" y1="12" x2="16" y2="12"></line></svg> CHUYỂN CƠ SỞ KHÁC</button>
                    <button class="btn-del-client admin-only" onclick="softDeleteCustomer('${client.id}', '${safeName}')"><svg class="icon-svg" style="margin-right:4px;" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg> CHUYỂN VÀO THÙNG RÁC</button>`;

                // Chỉ thêm được ảnh khi link đã trả là thư mục Drive
                const hasDriveFolder = client.links && Object.values(client.links)
                    .some(l => /drive\.google\.com\/drive\/folders\//.test(String(l.url || '')));
                const cPhone = String(client.phone || '').replace(/\D/g, '');
                const visits = (cPhone.length >= 9 && visitCount[cPhone]) || 0;
                const pVal = client.price ? normalizePrice(client.price) : ""; const pmVal = client.payment || "";
                const isFree = (pVal === 'Miễn phí');

                html += `
                    <div class="client-card${(!pVal && dbPath === 'data/') ? ' card-no-price' : ''}" data-search="${client.name ? client.name.toLowerCase() : ''} ${client.phone} ${maKh}">
                        <div class="client-info">
                            ${(dbPath === 'trash/') ? `<div style="margin-bottom:10px; display:flex; align-items:center; gap:10px;"><input type="checkbox" class="trash-checkbox" value="${client.id}" style="width:16px; height:16px; cursor:pointer;"><span style="font-size:12px; font-weight:600; color:#666;">CHỌN XÓA</span></div>` : ''}
                            <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:8px;">
                                <div style="font-size: 11px; color: #a1a1aa; font-family: monospace; font-weight: 600;">#${maKh}</div>
                                <span class="badge ${isDone ? 'done' : 'pending'}">${isDone ? 'ĐÃ TRẢ ẢNH' : 'ĐANG CHỤP'}</span>
                            </div>
                            <h4 class="client-name">
                                <span>${escapeHTML(client.name || 'Khách hàng')}</span>
                                ${visits > 1 ? `<span class="badge-loyal" title="Khách đã đến ${visits} lần">Khách quen · ${visits}</span>` : ''}
                            </h4>
                            <div style="font-size: 13px; color: #52525b; margin-bottom: 5px; display:flex; align-items:center;"><svg class="icon-sm" style="margin-right:6px;" viewBox="0 0 24 24"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path></svg> <span>${escapeHTML(client.phone)}</span>
                                ${(dbPath === 'data/') ? `<button onclick="editClientInfo('${client.id}')" class="btn-edit-info admin-only" title="Sửa tên và số điện thoại">Sửa</button>` : ''}
                            </div>
                            <div style="font-size: 13px; color: #52525b; margin-bottom: 15px; display:flex; align-items:center;"><svg class="icon-sm" style="margin-right:6px;" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg> ${client.time}</div>
                            
                            <div style="margin-top:auto;">
                                <div style="font-size:11px; font-weight:600; color:#a1a1aa; margin-bottom:5px; text-transform:uppercase;">Thu nhập:</div>
                                <div style="display:flex; gap:5px;">
                                    <input type="text" id="price_${client.id}" class="price-input" value="${pVal}" placeholder="Nhập tiền" list="price-list" inputmode="numeric" ${isFree ? 'disabled' : ''} onchange="updateMoney('${client.id}')" onkeydown="if(event.key==='Enter'){this.blur();}">
                                    <select id="payment_${client.id}" class="price-select${(!isFree && !pmVal) ? ' is-empty' : ''}" onchange="updatePayment('${client.id}')">
                                        <option value="" ${(!isFree && !pmVal) ? 'selected' : ''}>Chọn hình thức</option>
                                        <option value="Tiền mặt" ${(pmVal === 'Tiền mặt' && !isFree) ? 'selected' : ''}>Tiền mặt</option>
                                        <option value="Chuyển khoản" ${(pmVal === 'Chuyển khoản' && !isFree) ? 'selected' : ''}>Chuyển khoản</option>
                                        <option value="Miễn phí" ${isFree ? 'selected' : ''}>Miễn phí</option>
                                    </select>
                                </div>
                            </div>

                            <div style="margin-top:15px; padding-top:15px; border-top:1px dashed #e4e4e7;">
                                ${actionButtons}
                            </div>
                        </div>

                        <div class="link-manager">
                            ${clientUploadsHtml}
                            <div style="font-size:12px; font-weight:700; text-transform:uppercase; margin-bottom:10px; display:flex; align-items:center;"><svg class="icon-sm" style="margin-right:6px;" viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg> ẢNH ĐÃ TRẢ KHÁCH (${client.links ? Object.keys(client.links).length : 0})</div>
                            <div style="flex-grow:1; display:flex; flex-direction:column; gap:5px;">
                                ${linksHtml}
                                ${(dbPath === 'data/' && hasDriveFolder) ? `
                                <div class="add-to-folder">
                                    <label for="addfolder_input_${client.id}" id="addfolder_${client.id}" class="add-folder-btn">
                                        <svg class="icon-sm" style="margin-right:6px;" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>
                                        THÊM ẢNH GHÉP VÀO THƯ MỤC KHÁCH
                                    </label>
                                    <input type="file" id="addfolder_input_${client.id}" multiple accept="image/*" style="display:none;"
                                           onchange="addToClientFolder('${client.id}', this)">
                                </div>` : ''}
                                ${(dbPath === 'data/') ? `
                                <div class="shoot-picker" id="shoots_${client.id}" data-ts="${client.ts}">
                                    <button type="button" class="shoot-load" onclick="loadShootPicker('${client.id}')">
                                        <svg class="icon-sm" style="margin-right:6px;" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>
                                        ${client.links ? 'GỬI THÊM LƯỢT CHỤP' : 'XEM ẢNH VỪA CHỤP'}
                                    </button>
                                </div>` : ''}
                            </div>

                            ${(dbPath === 'data/') ? `
                            <div class="add-box">
                                <div style="display: flex; gap: 10px; margin-bottom: 10px; flex-wrap: wrap;">
                                    <div style="flex-grow:1; display:flex; gap:10px; background:#fafafa; border:1px dashed #d4d4d8; padding:8px 12px; border-radius:8px; align-items:center;">
                                        <label for="file_${client.id}" style="cursor:pointer; background:#111; color:#fff; padding:6px 12px; border-radius:6px; font-size:11px; font-weight:600; white-space:nowrap; transition:0.2s;">Chọn file</label>
                                        <input type="file" id="file_${client.id}" multiple accept="image/*" style="display: none;" onchange="document.getElementById('fname_${client.id}').innerText = this.files.length > 0 ? this.files.length + ' tệp đã chọn' : 'Chưa có tệp'">
                                        <span id="fname_${client.id}" style="font-size: 11px; color: #666; font-weight:500;">Chưa có tệp</span>
                                    </div>
                                    <button id="btn_up_${client.id}" onclick="uploadPhotosToImgBB('${client.id}')" class="btn btn-add"><svg class="icon-svg" style="margin-right:4px;" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg> TẢI LÊN</button>
                                </div>
                                <div style="display: flex; gap: 10px;">
                                    <textarea id="new_${client.id}" placeholder="Dán link GG Drive vào đây... (Có thể dán nhiều link cách nhau bằng nút Enter)"></textarea>
                                    <button onclick="addLink('${client.id}')" class="btn btn-add" style="height: auto; align-self: stretch;"><svg class="icon-svg" viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg></button>
                                </div>
                            </div>
                            ` : ''}
                        </div>
                    </div>`;
                    });
                    html += `</div>`;
                    groupDiv.innerHTML = html;
                    document.getElementById('list-content').appendChild(groupDiv);
                });

                // Đang lọc ngày thì đã tải đủ ngày đó, không cần nút tải thêm
                const fpNow = document.getElementById('date-filter')._flatpickr;
                const filtering = fpNow && fpNow.selectedDates.length > 0;
                if (!filtering && currentCount >= LOAD_LIMIT) {
                    const more = document.createElement('div');
                    more.style.cssText = 'text-align:center; padding:20px 0 10px;';
                    more.innerHTML = `<button onclick="loadMore()" style="background:#fff; border:1px solid #d4d4d8; color:#52525b; padding:10px 20px; border-radius:8px; cursor:pointer; font-weight:600; font-size:12px; font-family:'Inter';">TẢI THÊM PHIÊN CŨ HƠN</button>
                        <div style="font-size:11px; color:#a1a1aa; margin-top:8px;">Đang hiển thị ${currentCount} phiên gần nhất</div>`;
                    document.getElementById('list-content').appendChild(more);
                }

                // Trả lại link đang gõ dở sau khi DOM dựng lại
                Object.keys(_restoreDrafts).forEach(id => {
                    const t = document.getElementById(id);
                    if (t) t.value = _restoreDrafts[id];
                });
                _restoreDrafts = {};

                filterData();   // gọi renderTodayBar() ở cuối
                loadLinkThumbs();  // nạp ảnh mẫu ngầm, không chặn hiển thị danh sách
            }, err => {
                // Không có nhánh lỗi thì mất quyền đọc chỉ hiện danh sách trống, không ai biết vì sao
                document.querySelector('.empty-text').innerText = 'Không tải được dữ liệu: ' + err.message;
                document.getElementById('empty-msg').style.display = 'block';
            });
        }

        function updateMoney(clientId) {
            const inp = document.getElementById('price_' + clientId);
            const paySel = document.getElementById('payment_' + clientId);

            // Chỉ giữ số -> "50.000 đ" (cột riêng lo phần Miễn phí)
            const numStr = inp.value.replace(/\D/g, '');
            const pVal = numStr ? parseInt(numStr, 10).toLocaleString('vi-VN') + ' đ' : '';
            inp.value = pVal;

            // Gõ số mà đang Miễn phí -> chuyển về Tiền mặt
            let payment = paySel.value;
            if (pVal && (payment === 'Miễn phí' || !payment)) { payment = 'Tiền mặt'; paySel.value = 'Tiền mặt'; }

            const card = inp.closest('.client-card');
            if (card) card.classList.toggle('card-no-price', !pVal && payment !== 'Miễn phí' && dbPath === 'data/');
            db.ref(dbPath + br + '/' + clientId).update({ price: pVal, payment });
        }

        function updatePayment(clientId) {
            const inp = document.getElementById('price_' + clientId);
            const paySel = document.getElementById('payment_' + clientId);
            // Chưa chọn thì để chữ gợi ý mờ, chọn rồi thì đậm như giá trị thật
            if (paySel) paySel.classList.toggle('is-empty', !paySel.value);
            const card = inp.closest('.client-card');

            if (paySel.value === 'Miễn phí') {
                inp.value = 'Miễn phí';
                inp.disabled = true;
                if (card) card.classList.remove('card-no-price');
                // Ghi đúng 'Miễn phí' — trước lưu 'Tiền mặt' làm CSV báo nhầm là có thu tiền mặt
                db.ref(dbPath + br + '/' + clientId).update({ price: 'Miễn phí', payment: 'Miễn phí' });
            } else {
                // Chuyển từ Miễn phí sang TM/CK -> xoá để điền lại
                inp.disabled = false;
                if (inp.value === 'Miễn phí') inp.value = '';
                const pVal = inp.value.trim();
                if (card) card.classList.toggle('card-no-price', !pVal && dbPath === 'data/');
                db.ref(dbPath + br + '/' + clientId).update({ price: pVal, payment: paySel.value });
                if (!pVal) inp.focus();
            }
        }

        function toggleSelectAllTrash(cb) { const boxes = document.querySelectorAll('.trash-checkbox'); boxes.forEach(b => b.checked = cb.checked); }

        function deleteSelectedTrash() {
            if (userRole !== 'admin') return Toast.fire({ icon: 'error', title: 'Chỉ Quản trị viên thao tác được' });
            const selected = Array.from(document.querySelectorAll('.trash-checkbox:checked')).map(cb => cb.value);
            if (selected.length === 0) return Toast.fire({ icon: 'warning', title: 'Chưa chọn mục nào!' });
            
            Swal.fire({ title: 'Xóa vĩnh viễn?', text: `Đang chọn ${selected.length} mục. Nhập XOA để xác nhận.`, icon: 'warning', input: 'text', inputPlaceholder: 'Nhập XOA...', showCancelButton: true, confirmButtonColor: '#111', cancelButtonColor: '#fff', confirmButtonText: 'Xóa Tất Cả', cancelButtonText: '<span style="color:#111">Hủy</span>' }).then(async r => {
                if (r.isConfirmed) {
                    if (r.value === 'XOA') {
                        for (const id of selected) { await db.ref('trash/' + br + '/' + id).remove(); }
                        Toast.fire({ icon: 'success', title: 'Đã xóa các mục đã chọn' });
                    } else { Swal.fire({title: 'Thất bại', text: 'Sai mã xác nhận!', icon: 'error', confirmButtonColor: '#111'}); }
                }
            });
        }

        function filterData() {
            const query = document.getElementById('search-box').value.toLowerCase().trim();
            const fp = document.getElementById('date-filter')._flatpickr;
            let fTs = 0, tTs = Infinity;

            if (fp && fp.selectedDates.length > 0) {
                fTs = new Date(fp.selectedDates[0]).setHours(0,0,0,0);
                tTs = fp.selectedDates.length > 1 ? new Date(fp.selectedDates[1]).setHours(23,59,59,999) : new Date(fp.selectedDates[0]).setHours(23,59,59,999);
            }

            let visibleGroupCount = 0;

            document.querySelectorAll('.date-group').forEach(group => {
                let hasVisibleCard = false;
                const headerText = group.querySelector('.date-header span:first-child').innerText;
                const dateParts = headerText.split(', ').pop().trim().split('/'); 
                const groupTs = new Date(`${dateParts[2]}-${dateParts[1]}-${dateParts[0]}T12:00:00`).getTime();

                if (groupTs >= fTs && groupTs <= tTs) {
                    group.querySelectorAll('.client-card').forEach(card => {
                        const text = card.getAttribute('data-search');
                        if(text.includes(query)) { card.style.display = 'flex'; hasVisibleCard = true; } 
                        else card.style.display = 'none';
                    });
                } else {
                    group.querySelectorAll('.client-card').forEach(c => c.style.display = 'none');
                }

                if (hasVisibleCard) { group.style.display = 'block'; visibleGroupCount++; } 
                else { group.style.display = 'none'; }
            });
            
            document.querySelector('.empty-text').innerText = "Không tìm thấy dữ liệu khớp với bộ lọc.";
            document.getElementById('empty-msg').style.display = (visibleGroupCount === 0 && document.getElementById('list-content').innerHTML !== "") ? 'block' : 'none';

            // Đổi ngày xem thì thanh tóm tắt phải tính lại theo ngày đó
            renderTodayBar();
        }

        function exportExcel() {
            if(userRole !== 'admin') return Toast.fire({ icon: 'error', title: 'Không có quyền' });
            if(!currentData) return Toast.fire({ icon: 'warning', title: 'Không có dữ liệu!' });

            Swal.fire({
                title: 'Tùy chọn Xuất Excel',
                html: `
                    <div style="text-align:left; font-family:'Inter'; margin-top:10px;">
                        <label style="font-size:12px; font-weight:600; color:#666; display:block; margin-bottom:5px;">Chọn khoảng ngày xuất dữ liệu:</label>
                        <input type="text" id="swal-excel-range" class="search-box" style="width:100%; margin-bottom:15px; height:40px; padding:0 12px; border:1px solid #d4d4d8; border-radius:8px; font-family:'Inter'; box-sizing:border-box; text-align:center;" placeholder="Để trống để xuất toàn bộ thời gian...">
                        <div style="font-size:11px; color:#888; text-align:center;">* Không chọn gì hệ thống tự động xuất TẤT CẢ.</div>
                    </div>
                `,
                showCancelButton: true,
                confirmButtonText: 'Xuất Dữ Liệu',
                cancelButtonText: '<span style="color:#111">Hủy</span>',
                confirmButtonColor: '#111',
                didOpen: () => {
                    flatpickr("#swal-excel-range", {
                        mode: "range",
                        dateFormat: "d/m/Y",
                        locale: "vn",
                        defaultDate: document.getElementById('date-filter').value
                    });
                }
            }).then((result) => {
                if(result.isConfirmed) {
                    const fp = document.getElementById('swal-excel-range')._flatpickr;
                    let fTs = 0, tTs = Infinity, fStr = "";

                    if (fp && fp.selectedDates.length > 0) {
                        fTs = new Date(fp.selectedDates[0]).setHours(0,0,0,0);
                        tTs = fp.selectedDates.length > 1 ? new Date(fp.selectedDates[1]).setHours(23,59,59,999) : new Date(fp.selectedDates[0]).setHours(23,59,59,999);
                        fStr = getDStr(fp.selectedDates[0]);
                    }

                    // Xuất từ dữ liệu ĐẦY ĐỦ, không phải 200 phiên đang hiển thị
                    withFullData(allData => {
                    let csvContent = "data:text/csv;charset=utf-8," + String.fromCharCode(0xFEFF) + "Ngày,Giờ,Mã KH,Họ Tên,SĐT,Giá Tiền,Nguồn Tiền,Cơ Sở\n";
                    let count = 0;

                    // Dấu " trong tên khách sẽ làm vỡ cột -> nhân đôi theo chuẩn CSV
                    const csvCell = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;

                    Object.keys(allData || {}).forEach(id => {
                        const ts = parseInt(id.split('_')[1]);
                        if (!ts) return; // id hỏng -> bỏ, tránh xuất sai ngày
                        if (ts >= fTs && ts <= tTs) {
                            const c = allData[id];
                            const d = getDStr(new Date(ts));
                            const mk = id.split('_')[1].slice(-4);
                            const price = c.price ? normalizePrice(c.price) : '0';
                            // Dữ liệu cũ lưu 'Tiền mặt' cho khách miễn phí -> xuất đúng bản chất
                            const payment = (price === 'Miễn phí') ? 'Miễn phí' : (c.payment || '');
                            const cosoStr = (branchesCache[br] && branchesCache[br].name) || br;
                            csvContent += [d, c.time, '#' + mk, c.name, c.phone, price, payment, cosoStr].map(csvCell).join(',') + "\n";
                            count++;
                        }
                    });

                    if(count === 0) return Toast.fire({ icon: 'warning', title: 'Không có dữ liệu trong khoảng này!' });

                    const link = document.createElement("a"); link.setAttribute("href", encodeURI(csvContent)); 
                    let fileName = "PHOTONOIR_Report";
                    if (fp && fp.selectedDates.length > 1) fileName += "_" + fStr.replace(/\//g,'') + "_den_" + getDStr(fp.selectedDates[1]).replace(/\//g,'');
                    else if (fStr) fileName += "_" + fStr.replace(/\//g,'');
                    else fileName += "_All";

                    link.setAttribute("download", fileName + ".csv"); document.body.appendChild(link); link.click();
                    Toast.fire({ icon: 'success', title: `Đã xuất ${count} khách hàng` });
                    }, fTs, tTs);
                }
            });
        }

        function priceIsValid(v) {
            const low = (v || '').toLowerCase().trim();
            if (low === 'miễn phí' || low === 'mien phi') return true;
            const n = (v || '').replace(/\D/g, '');
            return n !== '' && parseInt(n, 10) > 0;
        }

        function normalizePrice(raw) {
            const v = (raw || '').trim();
            const numStr = v.replace(/\D/g, '');
            // Có chữ mà không có số -> Miễn phí. Có số -> "50.000 đ". Trống -> ''.
            if (!numStr) return /[a-zA-ZÀ-ỹ]/.test(v) ? 'Miễn phí' : '';
            return parseInt(numStr, 10).toLocaleString('vi-VN') + ' đ';
        }

        // Tra ve true neu da co gia hop le (hoac vua nhap xong trong popup), false neu huy
        function requirePrice(clientId) {
            const inp = document.getElementById('price_' + clientId);
            const paySel = document.getElementById('payment_' + clientId);
            // Đã có giá hợp lệ -> qua luôn
            if (inp && priceIsValid(inp.value)) return Promise.resolve(true);
            // Mở popup chọn tiền (đồng bộ thiết kế web)
            return openPriceModal(clientId, paySel ? paySel.value : 'Tiền mặt');
        }

        async function uploadPhotosToImgBB(clientId) {
            // Giữ file TRƯỚC khi hỏi tiền: ghi giá -> listener realtime vẽ lại DOM -> input bị reset
            const fileInput = document.getElementById('file_' + clientId);
            const files = Array.from(fileInput ? fileInput.files : []);
            if (files.length === 0) return Swal.fire({title: 'Lỗi', text: 'Chưa chọn ảnh nào!', icon: 'warning', confirmButtonColor: '#111'});

            if (!(await requirePrice(clientId))) return;

            // DOM có thể đã vẽ lại -> lấy lại nút theo id
            const btn = document.getElementById('btn_up_' + clientId);
            if (!btn) return;

            btn.innerHTML = `<svg class="icon-svg" style="margin-right:4px; animation: spin 1s infinite linear;" viewBox="0 0 24 24"><line x1="12" y1="2" x2="12" y2="6"></line><line x1="12" y1="18" x2="12" y2="22"></line><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"></line><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"></line><line x1="2" y1="12" x2="6" y2="12"></line><line x1="18" y1="12" x2="22" y2="12"></line><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"></line><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"></line></svg> ĐANG TẢI...`;
            btn.disabled = true;

            try {
                const now = new Date().toLocaleTimeString('vi-VN',{hour:'2-digit',minute:'2-digit'}) + ' ' + new Date().toLocaleDateString('vi-VN');
                let okCount = 0, lastErr = '';
                for (let i = 0; i < files.length; i++) {
                    const formData = new FormData();
                    formData.append("image", files[i]);
                    const response = await fetch("https://api.imgbb.com/1/upload?key=" + IMGBB_API_KEY, { method: 'POST', body: formData });
                    const data = await response.json();

                    if (data.success) {
                        const url = String(data.data.url).replace(/^http:\/\//i, 'https://');
                        const linkId = "L_" + Date.now() + "_" + i;
                        await db.ref(dbPath + br + '/' + clientId + '/links/' + linkId).set({ url: url, addedAt: now });
                        okCount++;
                    } else {
                        lastErr = (data.error && data.error.message) || '';
                    }
                }

                // Trước đây không tải được ảnh nào vẫn báo "hoàn tất" và đánh dấu đã trả ảnh:
                // nhân viên tưởng xong, khách không có ảnh.
                if (okCount === 0) {
                    const msg = /rate limit/i.test(lastErr)
                        ? 'Dịch vụ ảnh (imgbb) đã hết lượt tải. Vào Quản lý để đổi API key mới.'
                        : ('Không tải được ảnh nào.' + (lastErr ? ' (' + lastErr + ')' : ''));
                    Swal.fire({ title: 'Tải lên thất bại', text: msg, icon: 'error', confirmButtonColor: '#111' });
                    return;
                }

                await db.ref(dbPath + br + '/' + clientId).update({ status: "completed" });
                const failed = files.length - okCount;
                if (failed > 0) {
                    Swal.fire({ title: 'Tải lên một phần', text: `Đã tải ${okCount}/${files.length} ảnh. ${failed} ảnh lỗi, vui lòng tải lại.`, icon: 'warning', confirmButtonColor: '#111' });
                } else {
                    Toast.fire({ icon: 'success', title: 'Tải lên hoàn tất!' });
                }
                const fi = document.getElementById('file_' + clientId);
                if (fi) fi.value = "";
                const fn = document.getElementById('fname_' + clientId);
                if (fn) fn.innerText = 'Chưa có tệp';
            } catch (error) {
                if(typeof Swal !== 'undefined') Swal.fire({title: 'Lỗi', text: 'Không thể kết nối tải ảnh.', icon: 'error', confirmButtonColor: '#111'});
                else alert('Lỗi tải ảnh');
            } finally {
                const b = document.getElementById('btn_up_' + clientId);
                if (b) {
                    b.innerHTML = `<svg class="icon-svg" style="margin-right:4px;" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg> TẢI LÊN`;
                    b.disabled = false;
                }
            }
        }

        async function addLink(clientId) {
            // Đọc link TRƯỚC khi hỏi tiền: ghi giá -> listener realtime vẽ lại DOM -> textarea bị xoá trắng
            const ta = document.getElementById('new_' + clientId);
            const text = ta ? ta.value.trim() : '';
            if(!text) return Toast.fire({ icon: 'warning', title: 'Chưa dán link!' });
            const urls = text.split(/\n/).map(u => u.trim()).filter(u => u !== "");
            if(urls.length === 0) return;

            if (!(await requirePrice(clientId))) return;
            const now = new Date();
            const timeStr = now.toLocaleTimeString('vi-VN', {hour: '2-digit', minute:'2-digit'}) + ' ' + now.toLocaleDateString('vi-VN', {day:'2-digit', month:'2-digit'});
            
            urls.forEach((url, index) => {
                const linkId = "L_" + Date.now() + "_" + index; 
                db.ref(dbPath + br + '/' + clientId + '/links/' + linkId).set({ url: url, addedAt: timeStr });
            });
            db.ref(dbPath + br + '/' + clientId).update({ status: "completed" });
            const taAfter = document.getElementById('new_' + clientId);
            if (taAfter) taAfter.value = "";
            Toast.fire({ icon: 'success', title: 'Đã lưu link' });
        }

        // Hiện các lượt chụp cùng ngày để chọn thẳng, không phải mở Drive copy link
        async function loadShootPicker(clientId) {
            const box = document.getElementById('shoots_' + clientId);
            if (!box) return;
            if (!GS_URL) return Toast.fire({ icon: 'warning', title: 'Chưa cấu hình nơi lưu ảnh trong Quản lý' });

            // Mỗi khung thêm ~150 phần tử và cả chục ảnh; quên đóng vài cái là
            // trang nặng hẳn trên máy yếu -> chỉ giữ một khung mở
            document.querySelectorAll('.shoot-picker').forEach(el => {
                const id = el.id.replace('shoots_', '');
                if (id !== clientId && el.querySelector('.shoot-row')) closeShootPicker(id);
            });

            const ts = parseInt(box.getAttribute('data-ts')) || Date.now();
            const d = new Date(ts);
            const ymd = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');

            box.innerHTML = '<div class="shoot-loading">Đang đọc ảnh vừa chụp...</div>';
            try {
                const list = await listShoots(br, ymd);
                if (!list.length) {
                    box.innerHTML = `<div class="shoot-loading">Không có lượt chụp nào ngày ${getDStr(d)}
                        <button type="button" class="shoot-load" style="margin-top:8px;" onclick="loadShootPicker('${clientId}')">Thử lại</button></div>`;
                    return;
                }
                renderShootPicker(clientId, list, ts);
            } catch (e) {
                box.innerHTML = `<div class="shoot-loading">Không đọc được: ${escapeHTML(e.message)}
                    <button type="button" class="shoot-load" style="margin-top:8px;" onclick="loadShootPicker('${clientId}')">Thử lại</button></div>`;
            }
        }

        function renderShootPicker(clientId, list, clientTs) {
            const box = document.getElementById('shoots_' + clientId);
            if (!box) return;

            // Lượt đã gán cho khách khác thì đánh dấu, tránh hai khách chung một thư mục.
            // Bỏ qua chính khách đang xem: gửi thêm lượt nữa cho họ là chuyện bình thường.
            const taken = {};
            const mine = {};
            Object.keys(currentData || {}).forEach(cid => {
                const c = currentData[cid];
                if (!c.links) return;
                if (cid === clientId) {
                    Object.values(c.links).forEach(l => {
                        const m = String(l.url || '').match(/folders\/([\w-]+)/);
                        if (m) mine[m[1]] = true;
                    });
                    return;
                }
                Object.values(c.links).forEach(l => {
                    const m = String(l.url || '').match(/folders\/([\w-]+)/);
                    if (m) taken[m[1]] = c.name || 'khách khác';
                });
            });

            const ready = list.filter(s => s.id);
            const notReady = list.filter(s => !s.id);

            // Gần giờ khách quét nhất lên đầu — khách thường quét ngay sau khi chụp
            ready.sort((a, b) => Math.abs(shootTs(a, clientTs) - clientTs) - Math.abs(shootTs(b, clientTs) - clientTs));

            let html = `<div class="shoot-head">
                <span>Chọn ảnh trả khách</span>
                <span style="display:flex; gap:2px;">
                    <button type="button" class="shoot-close" onclick="refreshShootPicker('${clientId}')" title="Xem lượt chụp mới nhất">⟳</button>
                    <button type="button" class="shoot-close" onclick="closeShootPicker('${clientId}')" title="Đóng">✕</button>
                </span>
            </div><div class="shoot-row">`;
            ready.forEach(s => {
                const diff = Math.round((shootTs(s, clientTs) - clientTs) / 60000);
                const abs = Math.abs(diff);
                // Quá 90 phút thì đọc theo giờ cho gọn, chênh lớn thế thường không phải khách này
                const gap = abs >= 90 ? `${Math.round(abs / 60)} giờ` : `${abs} phút`;
                const diffText = diff === 0 ? 'cùng lúc' : (diff > 0 ? `sau ${gap}` : `trước ${gap}`);
                const who = taken[s.id];
                const isMine = mine[s.id];
                html += `<div class="shoot-card${who ? ' taken' : ''}${isMine ? ' mine' : ''}">
                    <div class="shoot-thumb"${s.thumbs && s.thumbs.length ? ` onclick="zoomShoot('${escapeHTML(s.thumbs[0])}', '${s.time}')"` : ''}>${s.thumbs && s.thumbs.length
                        ? `<img src="${escapeHTML(s.thumbs[0])}" alt="" loading="lazy" decoding="async" onerror="this.parentNode.classList.add('empty'); this.remove();">` : '<span>—</span>'}</div>
                    <div class="shoot-time">${s.time}</div>
                    <div class="shoot-diff">${diffText}</div>
                    <div class="shoot-count">${s.count || 0} ảnh</div>
                    ${isMine ? `<div class="shoot-mine">✓ Đã gửi khách này</div>`
                             : (who ? `<div class="shoot-taken">Đã trả cho ${escapeHTML(who)}</div>` : '')}
                    ${isMine ? '' : `<button type="button" class="shoot-pick${who ? ' again' : ''}"
                            onclick="pickShoot('${clientId}', '${escapeHTML(s.url)}', ${who ? `'${escapeHTML(who)}'` : 'null'})">
                        ${who ? 'CHỌN LẠI' : 'CHỌN'}
                    </button>`}
                </div>`;
            });
            html += '</div>';

            if (notReady.length) {
                html += `<div class="shoot-note">${notReady.length} lượt chưa tinh chỉnh xong (${notReady.map(s => s.time).join(', ')}) — sửa xong sẽ hiện ở đây</div>`;
            }
            box.innerHTML = html;
        }

        // Giờ chụp lấy từ tên thư mục dạng 20260902210042
        function shootTs(s, fallback) {
            const n = s.folderName || '';
            if (!/^\d{14}/.test(n)) return fallback;
            return new Date(+n.slice(0, 4), +n.slice(4, 6) - 1, +n.slice(6, 8),
                            +n.slice(8, 10), +n.slice(10, 12), +n.slice(12, 14)).getTime();
        }

        // Đẩy ảnh ghép Canva vào đúng thư mục đã gửi khách, khỏi mở Drive tìm lại
        async function addToClientFolder(clientId, input) {
            const files = Array.from(input.files || []);
            input.value = '';
            if (!files.length) return;

            const c = currentData && currentData[clientId];
            const links = c && c.links ? Object.values(c.links).map(l => l.url) : [];
            const folderId = links.map(u => (String(u).match(/folders\/([\w-]+)/) || [])[1]).find(Boolean);
            if (!folderId) return Swal.fire({ title: 'Chưa có thư mục', text: 'Khách này chưa được gán thư mục ảnh trên Drive.', icon: 'warning', confirmButtonColor: '#111' });

            const btn = document.getElementById('addfolder_' + clientId);
            const old = btn ? btn.innerHTML : '';
            if (btn) { btn.classList.add('busy'); btn.innerHTML = 'ĐANG GỬI 0/' + files.length; }

            let ok = 0, lastErr = '';
            try {
                const token = await driveToken();
                for (let i = 0; i < files.length; i++) {
                    try {
                        await driveUploadAdmin(files[i], token, folderId);
                        ok++;
                    } catch (e) { lastErr = e.message; }
                    if (btn) btn.innerHTML = `ĐANG GỬI ${i + 1}/${files.length}`;
                }
            } catch (e) {
                lastErr = e.message;
            } finally {
                if (btn) { btn.classList.remove('busy'); btn.innerHTML = old; }
            }

            // Thêm ảnh ghép xong thì ảnh mẫu phải đổi theo, nếu không nhân viên
            // nhìn vào vẫn tưởng chưa ghép
            if (ok) {
                delete _folderThumb[folderId];
                document.querySelectorAll(`.link-thumb[data-fid="${folderId}"]`).forEach(el => {
                    el.innerHTML = ''; el.classList.remove('empty'); el.removeAttribute('title');
                });
                loadLinkThumbs();
            }

            if (ok === files.length) Toast.fire({ icon: 'success', title: `Đã thêm ${ok} ảnh vào thư mục khách` });
            else if (ok) Swal.fire({ title: 'Gửi một phần', text: `Đã thêm ${ok}/${files.length} ảnh. Số còn lại lỗi: ${lastErr}`, icon: 'warning', confirmButtonColor: '#111' });
            else Swal.fire({ title: 'Không gửi được', text: lastErr || 'Không rõ lỗi', icon: 'error', confirmButtonColor: '#111' });
        }

        async function driveUploadAdmin(file, token, folderId) {
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
                if (res.status === 401) _driveToken = '';
                throw new Error('Drive từ chối (HTTP ' + res.status + ')');
            }
            return await res.json();
        }

        // Khách vừa chụp xong mà danh sách còn nhớ bản cũ -> bỏ nhớ, đọc lại Drive
        function refreshShootPicker(clientId) {
            const box = document.getElementById('shoots_' + clientId);
            const ts = box ? parseInt(box.getAttribute('data-ts')) : 0;
            if (ts) {
                const d = new Date(ts);
                const ymd = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
                delete _shootCache[br + '|' + ymd];
            }
            loadShootPicker(clientId);
        }

        // Thu lại về nút bấm, khỏi chiếm chỗ khi chưa cần
        function closeShootPicker(clientId) {
            const box = document.getElementById('shoots_' + clientId);
            if (!box) return;
            // Khách đã có link thì lần bấm sau là để gửi thêm lượt nữa
            const c = currentData && currentData[clientId];
            const label = (c && c.links) ? 'GỬI THÊM LƯỢT CHỤP' : 'XEM ẢNH VỪA CHỤP';
            box.innerHTML = `<button type="button" class="shoot-load" onclick="loadShootPicker('${clientId}')">
                <svg class="icon-sm" style="margin-right:6px;" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>
                ${label}
            </button>`;
        }

        // Xem to để chắc chắn đúng khách trước khi gửi link
        function zoomShoot(thumbUrl, time) {
            // Ô hiển thị dùng ảnh nhỏ cho nhẹ; xem to thì xin lại bản lớn
            const big = thumbAt(thumbUrl, 1200);
            Swal.fire({
                title: 'Lượt chụp ' + escapeHTML(time || ''),
                imageUrl: big,
                imageAlt: '',
                width: 'auto',
                showConfirmButton: false,
                showCloseButton: true,
                customClass: { image: 'shoot-zoom-img' }
            });
        }

        function pickShoot(clientId, url, takenBy) {
            const go = () => {
                const ta = document.getElementById('new_' + clientId);
                if (ta) ta.value = url;
                addLink(clientId);
            };

            // Hai người chụp chung một lượt thì đều cần link — cho gán lại, chỉ hỏi
            // để tránh gán nhầm sang khách không liên quan.
            if (!takenBy) return go();
            Swal.fire({
                title: 'Lượt này đã trả rồi',
                html: `Đã gửi cho <b>${escapeHTML(takenBy)}</b>.<br>
                       <span style="font-size:13px;color:#666">Chọn tiếp nếu hai người chụp chung một lượt.</span>`,
                icon: 'question', showCancelButton: true,
                confirmButtonText: 'Vẫn gửi cho khách này',
                cancelButtonText: '<span style="color:#111">Hủy</span>',
                confirmButtonColor: '#111'
            }).then(r => { if (r.isConfirmed) go(); });
        }

        // Khách nhập nhầm SĐT thì không tra lại được ảnh; trước phải xoá phiên rồi
        // bảo khách tạo lại, mất luôn ảnh đã trả.
        function editClientInfo(clientId) {
            if (userRole !== 'admin') return Toast.fire({ icon: 'error', title: 'Chỉ Quản trị viên sửa được' });
            const c = currentData && currentData[clientId];
            if (!c) return;

            Swal.fire({
                title: 'Sửa thông tin khách',
                html: `
                    <div style="text-align:left; font-family:'Inter'; margin-top:6px;">
                        <label style="font-size:11px; font-weight:700; color:#666; display:block; margin-bottom:5px; text-transform:uppercase;">Họ tên</label>
                        <input id="swal-name" class="swal2-input" style="margin:0 0 12px; width:100%; font-family:'Inter';" value="${escapeHTML(c.name || '')}" maxlength="60">
                        <label style="font-size:11px; font-weight:700; color:#666; display:block; margin-bottom:5px; text-transform:uppercase;">Số điện thoại</label>
                        <input id="swal-phone" class="swal2-input" style="margin:0; width:100%; font-family:'Inter';" inputmode="numeric" value="${escapeHTML(c.phone || '')}" maxlength="15">
                    </div>`,
                showCancelButton: true,
                confirmButtonText: 'Lưu',
                cancelButtonText: '<span style="color:#111">Hủy</span>',
                confirmButtonColor: '#111',
                preConfirm: () => {
                    const name = (document.getElementById('swal-name').value || '').trim();
                    const phoneRaw = (document.getElementById('swal-phone').value || '').trim();
                    const digits = phoneRaw.replace(/\D/g, '');
                    if (!name) { Swal.showValidationMessage('Chưa nhập tên'); return false; }
                    if (digits.length < 9 || digits.length > 11) { Swal.showValidationMessage('Số điện thoại phải 9-11 số'); return false; }
                    return { name: name.slice(0, 60), phone: digits };
                }
            }).then(r => {
                if (!r.isConfirmed || !r.value) return;
                if (r.value.name === c.name && r.value.phone === String(c.phone || '')) return;
                db.ref(dbPath + br + '/' + clientId).update(r.value)
                  .then(() => Toast.fire({ icon: 'success', title: 'Đã cập nhật' }))
                  .catch(err => Swal.fire('Lỗi', 'Không lưu được: ' + err.message, 'error'));
            });
        }

        // Nhân viên sửa lại link đã dán (dán nhầm thư mục, đổi link chia sẻ...)
        function updateLink(clientId, linkId) {
            const inp = document.getElementById('lnk_' + clientId + '_' + linkId);
            if (!inp) return;
            const url = inp.value.trim();
            const orig = inp.getAttribute('data-orig') || '';
            if (url === orig) return; // không đổi gì

            if (!url) {
                inp.value = orig;
                return Toast.fire({ icon: 'warning', title: 'Link trống. Dùng nút XÓA nếu muốn bỏ.' });
            }
            if (!/^https?:\/\//i.test(url)) {
                inp.value = orig;
                return Toast.fire({ icon: 'warning', title: 'Link phải bắt đầu bằng http:// hoặc https://' });
            }

            db.ref(dbPath + br + '/' + clientId + '/links/' + linkId).update({ url }).then(() => {
                inp.setAttribute('data-orig', url);
                Toast.fire({ icon: 'success', title: 'Đã cập nhật link' });
            }).catch(err => {
                inp.value = orig;
                Swal.fire('Lỗi', 'Không lưu được: ' + err.message, 'error');
            });
        }

        function deleteLink(clientId, linkId) {
            // Chọn nhầm thư mục thì phải gỡ được ngay, là việc hằng ngày của nhân viên
            if (userRole === 'viewer') return Toast.fire({ icon: 'error', title: 'Tài khoản chỉ xem thu nhập' });

            Swal.fire({ title: 'Xóa ảnh này?', icon: 'warning', showCancelButton: true, confirmButtonColor: '#111', cancelButtonColor: '#fff', confirmButtonText: 'Xóa', cancelButtonText: '<span style="color:#111">Hủy</span>' }).then(r => { if(r.isConfirmed) { db.ref(dbPath + br + '/' + clientId + '/links/' + linkId).remove(); Toast.fire({ icon: 'success', title: 'Đã xóa' }); }}); 
        }

        // Tải toàn bộ ảnh khách gửi trong một yêu cầu in.
        // Tải lần lượt từng file thay vì gộp zip: không cần thư viện ngoài và
        // không vướng CORS của imgbb (thẻ <a download> không đọc nội dung ảnh).
        async function downloadAllUploads(cId, uId, btn) {
            const up = currentData && currentData[cId] && currentData[cId].client_uploads && currentData[cId].client_uploads[uId];
            const imgbbLinks = (up && Array.isArray(up.links)) ? up.links : [];
            const driveItems = (up && Array.isArray(up.drive)) ? up.drive : [];
            // Ảnh cũ trên imgbb và ảnh mới trên Drive dùng chung một nút
            const items = imgbbLinks.map(u => ({ kind: 'url', url: u }))
                            .concat(driveItems.map(d => ({ kind: 'drive', id: d.id })));
            if (!items.length) return Toast.fire({ icon: 'warning', title: 'Không có ảnh để tải' });

            const name = (currentData[cId].name || 'Khach').replace(/[^\p{L}\p{N} _-]/gu, '').trim().replace(/\s+/g, '_') || 'Khach';
            const maKh = cId.split('_')[1].slice(-4);

            const oldHtml = btn ? btn.innerHTML : '';
            if (btn) { btn.disabled = true; }

            // Ảnh Drive nằm trong thư mục riêng tư -> xin mã truy cập một lần cho cả lượt
            let token = '';
            if (driveItems.length) {
                if (btn) btn.innerHTML = 'ĐANG CHUẨN BỊ...';
                try {
                    token = (await gsCall({ action: 'token' })).token;
                } catch (e) {
                    if (btn) { btn.disabled = false; btn.innerHTML = oldHtml; }
                    return Swal.fire({ title: 'Không tải được', text: 'Không lấy được quyền đọc ảnh: ' + e.message, icon: 'error', confirmButtonColor: '#111' });
                }
            }

            let ok = 0, failed = 0, done = 0;
            const PARALLEL = 4; // ảnh khách gửi thường 2-4 MB, tải tuần tự mất cả phút

            // Phải tải nội dung ảnh về rồi mới lưu được: thuộc tính download bị
            // bỏ qua với ảnh khác tên miền, trình duyệt sẽ mở tab xem thay vì tải.
            const fetchOne = async (it) => {
                const url = it.kind === 'drive'
                    ? 'https://www.googleapis.com/drive/v3/files/' + it.id + '?alt=media'
                    : it.url;
                const opt = it.kind === 'drive' ? { headers: { Authorization: 'Bearer ' + token } } : {};
                const res = await fetch(url, opt);
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return await res.blob();
            };

            const saveBlob = (blob, fileName) => {
                const objUrl = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = objUrl;
                a.download = fileName;
                document.body.appendChild(a);
                a.click();
                a.remove();
                setTimeout(() => URL.revokeObjectURL(objUrl), 10000);
            };

            // Tải song song theo lô, nhưng lưu file theo đúng thứ tự ảnh
            for (let start = 0; start < items.length; start += PARALLEL) {
                const batch = items.slice(start, start + PARALLEL);
                const results = await Promise.all(batch.map(async (it) => {
                    try {
                        const blob = await fetchOne(it);
                        done++;
                        if (btn) btn.innerHTML = `ĐANG TẢI ${done}/${items.length}...`;
                        return { blob };
                    } catch (e) {
                        done++;
                        if (btn) btn.innerHTML = `ĐANG TẢI ${done}/${items.length}...`;
                        return { err: true };
                    }
                }));

                results.forEach((r, k) => {
                    const i = start + k;
                    if (r.err) { failed++; return; }
                    const src = items[i].kind === 'drive' ? (r.blob.type || '') : String(items[i].url);
                    const ext = items[i].kind === 'drive'
                        ? ((r.blob.type || '').split('/')[1] || 'jpg').replace('jpeg', 'jpg')
                        : (src.match(/\.(jpe?g|png|webp|gif|bmp|heic)(?:\?|$)/i) || [, 'jpg'])[1];
                    saveBlob(r.blob, `${name}_${maKh}_${String(i + 1).padStart(2, '0')}.${ext}`);
                    ok++;
                });
            }

            if (btn) { btn.disabled = false; btn.innerHTML = oldHtml; }

            if (ok === 0) {
                Swal.fire({ title: 'Không tải được', text: 'Ảnh có thể đã bị xoá khỏi imgbb. Thử bấm vào từng link để kiểm tra.', icon: 'error', confirmButtonColor: '#111' });
            } else if (failed > 0) {
                Swal.fire({ title: 'Tải một phần', text: `Đã tải ${ok}/${items.length} ảnh. ${failed} ảnh lỗi (có thể đã bị xoá).`, icon: 'warning', confirmButtonColor: '#111' });
            } else {
                Toast.fire({ icon: 'success', title: `Đã tải ${ok} ảnh` });
            }
        }

        function delClientUp(cId, uId) {
            // Đánh dấu in xong là việc hằng ngày của nhân viên, không phải việc quản trị.
            // Trước đây chặn admin rồi thoát im lặng: nhân viên bấm không thấy gì xảy ra.
            if (userRole === 'viewer') return Toast.fire({ icon: 'error', title: 'Tài khoản chỉ xem thu nhập' });
            Swal.fire({ title: 'Xóa yêu cầu in?', showCancelButton: true, confirmButtonText: 'Xóa', cancelButtonText: '<span style="color:#111">Hủy</span>', confirmButtonColor: '#111' }).then(r => {
                if(r.isConfirmed) {
                    db.ref(dbPath + br + '/' + cId + '/client_uploads/' + uId).remove();
                    Toast.fire({ icon: 'success', title: 'Đã xóa yêu cầu in' });
                }
            });
        }

        function softDeleteCustomer(clientId, clientName) { 
            if (userRole !== 'admin') return Toast.fire({ icon: 'error', title: 'Chỉ Quản trị viên thao tác được' }); 
            Swal.fire({ title: 'Chuyển vào Thùng Rác?', text: "Khách hàng " + clientName, icon: 'warning', showCancelButton: true, confirmButtonColor: '#111', cancelButtonColor: '#fff', confirmButtonText: 'Chuyển', cancelButtonText: '<span style="color:#111">Hủy</span>' }).then(r => {
                if (r.isConfirmed) {
                    db.ref('data/' + br + '/' + clientId).once('value').then(snap => db.ref('trash/' + br + '/' + clientId).set(snap.val()).then(() => db.ref('data/' + br + '/' + clientId).remove())).then(() => Toast.fire({ icon: 'success', title: 'Đã chuyển thùng rác' })).catch(err => Swal.fire('Lỗi', err.message, 'error'));
                }
            }); 
        }

        function restoreCustomer(clientId, clientName) { 
            if (userRole !== 'admin') return Toast.fire({ icon: 'error', title: 'Chỉ Quản trị viên thao tác được' }); 
            db.ref('trash/' + br + '/' + clientId).once('value').then(snap => db.ref('data/' + br + '/' + clientId).set(snap.val()).then(() => db.ref('trash/' + br + '/' + clientId).remove())).then(() => Toast.fire({ icon: 'success', title: "Đã khôi phục " + clientName })).catch(err => Swal.fire('Lỗi', err.message, 'error')); 
        }

        function hardDeleteCustomer(clientId, clientName) { 
            if (userRole !== 'admin') return Toast.fire({ icon: 'error', title: 'Chỉ Quản trị viên thao tác được' }); 
            Swal.fire({ title: 'Xóa Vĩnh Viễn?', text: "Nhập chữ XOA để xác nhận xóa khách " + clientName, icon: 'warning', input: 'text', inputPlaceholder: 'Nhập XOA...', showCancelButton: true, confirmButtonColor: '#111', cancelButtonColor: '#fff', confirmButtonText: 'Xóa', cancelButtonText: '<span style="color:#111">Hủy</span>' }).then(r => {
                if (r.isConfirmed) {
                    if(r.value === 'XOA') { db.ref('trash/' + br + '/' + clientId).remove().then(() => Toast.fire({ icon: 'success', title: 'Đã xóa vĩnh viễn' })); } 
                    else { Swal.fire({title: 'Thất bại', text: 'Sai mã xác nhận!', icon: 'error', confirmButtonColor: '#111'}); }
                }
            }); 
        }
        
        function openClearModal() {
            if(userRole !== 'admin') return Swal.fire({title: 'Từ chối', text: 'Chỉ Admin mới thao tác được!', icon: 'error', confirmButtonColor: '#111'});
            document.getElementById('clear-pass').value = '';
            document.getElementById('clear-modal').style.display = 'flex';
        }

        function executeClearData() {
            const target = document.getElementById('clear-target').value;
            const pass = document.getElementById('clear-pass').value;
            if (pass !== 'XOA') return Swal.fire({title: 'Thất bại', text: 'Mã xác nhận không chính xác!', icon: 'error', confirmButtonColor: '#111'});

            let confirmMsg = target === 'all' ? "TẤT CẢ CƠ SỞ" : ((branchesCache[target] && branchesCache[target].name) || target);

            Swal.fire({ title: 'DỌN SẠCH HỆ THỐNG', text: "Hành động này sẽ XÓA SẠCH VÀ VĨNH VIỄN toàn bộ dữ liệu của " + confirmMsg + ".\nBạn chắc chắn chứ?", icon: 'error', showCancelButton: true, confirmButtonColor: '#111', cancelButtonColor: '#fff', confirmButtonText: 'TÔI CHẮC CHẮN XÓA', cancelButtonText: '<span style="color:#111">Hủy</span>' }).then(r => {
                if (r.isConfirmed) {
                    if (target === 'all') {
                        Object.keys(branchesCache).forEach(id => { db.ref('data/' + id).remove(); db.ref('trash/' + id).remove(); });
                    } else {
                        db.ref('data/' + target).remove(); db.ref('trash/' + target).remove();
                    }
                    document.getElementById('clear-modal').style.display = 'none';
                    Swal.fire({title: 'Hoàn tất!', text: "Đã dọn sạch hệ thống cho " + confirmMsg, icon: 'success', confirmButtonColor: '#111'});
                }
            });
        }

function moveCustomer(clientId, clientName) {
    if (userRole !== 'admin') return Toast.fire({ icon: 'error', title: 'Chỉ Quản trị viên thao tác được' });
    const targets = Object.keys(branchesCache).filter(id => id !== br);
    if (targets.length === 0) return Toast.fire({ icon: 'warning', title: 'Không có cơ sở khác để chuyển.' });

    const options = {};
    targets.forEach(id => { options[id] = branchesCache[id].name || id; });

    Swal.fire({
        title: 'Chuyển cơ sở khác',
        text: `Chuyển khách hàng ${clientName} sang cơ sở nào?`,
        icon: 'question',
        input: 'select',
        inputOptions: options,
        showCancelButton: true,
        confirmButtonColor: '#111',
        cancelButtonColor: '#fff',
        confirmButtonText: 'Chuyển Ngay',
        cancelButtonText: '<span style="color:#111">Hủy</span>'
    }).then(r => {
        if (!r.isConfirmed || !r.value) return;
        const targetBranch = r.value;
        db.ref(dbPath + br + '/' + clientId).once('value').then(snap => {
            const data = snap.val();
            if (data) {
                db.ref(dbPath + targetBranch + '/' + clientId).set(data).then(() => {
                    db.ref(dbPath + br + '/' + clientId).remove().then(() => {
                        Toast.fire({ icon: 'success', title: 'Đã chuyển thành công' });
                    });
                });
            }
        }).catch(err => Swal.fire('Lỗi', err.message, 'error'));
    });
}

// Gọi thử imgbb bằng ảnh 1x1 để biết key sống hay đã hết lượt
async function testImgbbKey(key) {
    // Ảnh 64x64 vẽ bằng canvas: imgbb từ chối ảnh 1x1 với lỗi "forbidden",
    // dễ tưởng nhầm là key hỏng hoặc mạng bị chặn.
    const cv = document.createElement('canvas');
    cv.width = 64; cv.height = 64;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#18181b';
    ctx.fillRect(0, 0, 64, 64);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(16, 16, 32, 32);

    const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
    if (!blob) return { ok: false, kind: 'other', msg: 'Không tạo được ảnh thử trên trình duyệt này.' };

    const fd = new FormData();
    fd.append('image', blob, 'photonoir-test.png');

    const res = await fetch('https://api.imgbb.com/1/upload?key=' + encodeURIComponent(key), { method: 'POST', body: fd });
    const data = await res.json();
    if (data.success) return { ok: true };

    // imgbb trả nhiều loại lỗi khác nhau, phân biệt để không đổ oan cho key
    const msg = (data.error && data.error.message) || '';
    if (/invalid api/i.test(msg)) return { ok: false, kind: 'key', msg: 'Key không tồn tại hoặc đã bị huỷ. Kiểm tra lại chuỗi vừa dán.' };
    if (/rate limit/i.test(msg)) return { ok: false, kind: 'limit', msg: 'Key đúng nhưng đã hết lượt tải. Cần tạo key mới trên api.imgbb.com.' };
    if (/forbidden/i.test(msg)) return { ok: false, kind: 'network', msg: 'imgbb từ chối lượt kiểm tra này, không phải lỗi key. Cứ thử gửi một ảnh thật từ trang khách để chắc chắn.' };
    return { ok: false, kind: 'other', msg: msg || 'Không rõ lỗi từ imgbb.' };
}

async function checkImgbbKey() {
    const key = (document.getElementById('imgbb-key-input').value || '').trim();
    if (!key) return Toast.fire({ icon: 'warning', title: 'Chưa nhập key' });

    const btn = document.getElementById('btn-check-key');
    const old = btn.innerHTML; btn.disabled = true; btn.innerHTML = 'ĐANG KIỂM TRA...';
    try {
        const r = await testImgbbKey(key);
        if (r.ok) {
            Swal.fire({ title: 'Key dùng được', text: 'Tải ảnh thử thành công. Bấm Lưu để áp dụng.', icon: 'success', confirmButtonColor: '#111' });
        } else if (r.kind === 'network') {
            // Không phải lỗi key -> đừng để nhân viên tưởng key hỏng mà đi tạo key mới
            Swal.fire({ title: 'Chưa kiểm tra được', text: r.msg, icon: 'warning', confirmButtonColor: '#111' });
        } else {
            Swal.fire({ title: 'Key không dùng được', text: r.msg, icon: 'error', confirmButtonColor: '#111' });
        }
    } catch (e) {
        Swal.fire({ title: 'Lỗi', text: 'Không gọi được imgbb: ' + e.message, icon: 'error', confirmButtonColor: '#111' });
    } finally { btn.disabled = false; btn.innerHTML = old; }
}

function saveImgbbKey() {
    if (userRole !== 'admin') return Toast.fire({ icon: 'error', title: 'Chỉ Quản trị viên được đổi' });
    const key = (document.getElementById('imgbb-key-input').value || '').trim();
    if (key && !/^[a-zA-Z0-9]{20,64}$/.test(key)) {
        return Swal.fire({ title: 'Key không hợp lệ', text: 'Key imgbb là chuỗi chữ và số, thường 32 ký tự.', icon: 'warning', confirmButtonColor: '#111' });
    }
    db.ref('config/imgbb_key').set(key)
        .then(() => Toast.fire({ icon: 'success', title: key ? 'Đã lưu key mới' : 'Đã xoá key, dùng key mặc định' }))
        .catch(err => Swal.fire('Lỗi', 'Không lưu được: ' + err.message, 'error'));
}

async function checkDriveUrl() {
    const url = (document.getElementById('gs-url-input').value || '').trim();
    if (!url) return Toast.fire({ icon: 'warning', title: 'Chưa nhập link' });
    if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url)) {
        return Swal.fire({ title: 'Link không đúng', text: 'Link phải có dạng https://script.google.com/macros/s/.../exec', icon: 'warning', confirmButtonColor: '#111' });
    }

    const btn = document.getElementById('btn-check-drive');
    const old = btn.innerHTML; btn.disabled = true; btn.innerHTML = 'ĐANG KIỂM TRA...';
    const saved = GS_URL;
    try {
        GS_URL = url;
        await gsCall({ action: 'token' });
        Swal.fire({ title: 'Kết nối được', text: 'Đã lấy được quyền ghi vào Drive. Bấm Lưu để áp dụng.', icon: 'success', confirmButtonColor: '#111' });
    } catch (e) {
        Swal.fire({ title: 'Không kết nối được', text: e.message + '. Kiểm tra lại quyền truy cập của bản triển khai (phải là "Bất kỳ ai").', icon: 'error', confirmButtonColor: '#111' });
    } finally {
        GS_URL = saved;
        btn.disabled = false; btn.innerHTML = old;
    }
}

function saveDriveUrl() {
    if (userRole !== 'admin') return Toast.fire({ icon: 'error', title: 'Chỉ Quản trị viên được đổi' });
    const url = (document.getElementById('gs-url-input').value || '').trim();
    if (url && !/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url)) {
        return Swal.fire({ title: 'Link không đúng', text: 'Link phải có dạng https://script.google.com/macros/s/.../exec', icon: 'warning', confirmButtonColor: '#111' });
    }
    db.ref('config/gs_url').set(url)
        .then(() => Toast.fire({ icon: 'success', title: url ? 'Đã lưu — ảnh mới sẽ vào Drive' : 'Đã xoá — quay lại dùng imgbb' }))
        .catch(err => Swal.fire('Lỗi', 'Không lưu được: ' + err.message, 'error'));
}

function openManageModal() {
    if (userRole !== 'admin') return Toast.fire({ icon: 'error', title: 'Chỉ Quản trị viên được xem' });
    resetBranchForm();
    resetAccountForm();
    populateAccountBranchSelect();
    loadBranchList();
    loadAccountList();
    document.getElementById('manage-modal').style.display = 'flex';
}

function populateAccountBranchSelect() {
    const sel = document.getElementById('new-acc-branch');
    if (!sel) return;
    sel.innerHTML = '';
    Object.keys(branchesCache).forEach(id => {
        const opt = document.createElement('option');
        opt.value = id;
        opt.innerText = branchesCache[id].name || id;
        sel.appendChild(opt);
    });
}

function resetBranchForm() {
    editingBranchId = null;
    document.getElementById('new-branch-id').value = '';
    document.getElementById('new-branch-name').value = '';
    document.getElementById('new-branch-fb').value = '';
    document.getElementById('new-branch-ig').value = '';
    document.getElementById('new-branch-tk').value = '';
    document.getElementById('new-branch-map').value = '';
    document.getElementById('new-branch-id').disabled = false;
    document.getElementById('branch-form-label').innerText = 'Thêm cơ sở mới';
    document.getElementById('branch-submit-btn').innerText = 'Tạo cơ sở';
    document.getElementById('branch-cancel-btn').style.display = 'none';
}

function cancelEditBranch() { resetBranchForm(); }

function editBranch(branchId) {
    if (userRole !== 'admin') return Toast.fire({ icon: 'error', title: 'Chỉ Quản trị viên thao tác được' });
    const b = branchesCache[branchId] || {};
    const s = b.social || {};
    editingBranchId = branchId;
    document.getElementById('new-branch-id').value = branchId;
    document.getElementById('new-branch-id').disabled = true;
    document.getElementById('new-branch-name').value = b.name || '';
    document.getElementById('new-branch-fb').value = s.fb || '';
    document.getElementById('new-branch-ig').value = s.ig || '';
    document.getElementById('new-branch-tk').value = s.tk || '';
    document.getElementById('new-branch-map').value = s.map || '';
    document.getElementById('branch-form-label').innerText = 'Sửa cơ sở: ' + (b.name || branchId);
    document.getElementById('branch-submit-btn').innerText = 'Lưu thay đổi';
    document.getElementById('branch-cancel-btn').style.display = 'block';
    document.getElementById('new-branch-name').focus();
}

function submitBranchForm() {
    if (userRole !== 'admin') return Toast.fire({ icon: 'error', title: 'Chỉ Quản trị viên thao tác được' });
    const name = document.getElementById('new-branch-name').value.trim();
    if (!name) return Toast.fire({ icon: 'warning', title: 'Vui lòng nhập tên hiển thị.' });
    const social = {
        fb: document.getElementById('new-branch-fb').value.trim(),
        ig: document.getElementById('new-branch-ig').value.trim(),
        tk: document.getElementById('new-branch-tk').value.trim(),
        map: document.getElementById('new-branch-map').value.trim()
    };

    if (editingBranchId) {
        const branchId = editingBranchId;
        db.ref('branches/' + branchId).update({ name, social }).then(() => {
            branchesCache[branchId] = Object.assign({}, branchesCache[branchId], { name, social });
            renderBranchTabs();
            populateAccountBranchSelect();
            loadBranchList();
            resetBranchForm();
            Toast.fire({ icon: 'success', title: 'Đã cập nhật cơ sở' });
        }).catch(err => Swal.fire('Lỗi', err.message, 'error'));
        return;
    }

    const branchId = document.getElementById('new-branch-id').value.trim().toLowerCase();
    if (!branchId || !/^[a-z0-9]+$/.test(branchId)) return Toast.fire({ icon: 'warning', title: 'Mã cơ sở không hợp lệ (chỉ chữ thường/số, không dấu/khoảng trắng).' });
    if (branchesCache[branchId]) return Toast.fire({ icon: 'warning', title: 'Mã cơ sở này đã tồn tại.' });

    db.ref('branches/' + branchId).set({
        name, social, active: true, createdAt: Date.now(), createdBy: auth.currentUser.uid
    }).then(() => {
        branchesCache[branchId] = { name, social, active: true };
        renderBranchTabs();
        populateAccountBranchSelect();
        loadBranchList();
        resetBranchForm();
        Toast.fire({ icon: 'success', title: 'Đã tạo cơ sở mới' });
    }).catch(err => Swal.fire('Lỗi', err.message, 'error'));
}

function loadBranchList() {
    const wrap = document.getElementById('branch-list');
    if (!wrap) return;
    wrap.innerHTML = '';
    Object.keys(branchesCache).forEach(id => {
        const b = branchesCache[id];
        const row = document.createElement('div');
        row.style.cssText = 'display:flex; justify-content:space-between; align-items:center; background:#fff; border:1px solid #e5e5e5; border-radius:8px; padding:8px 12px; font-size:12px;';
        row.innerHTML = `<div><b>${b.name || id}</b><div style="color:#888; font-size:11px; font-family:monospace;">${id}</div></div>
            <div style="display:flex; gap:6px;">
                <button onclick="editBranch('${id}')" style="background:#fff; color:#111; border:1px solid #d4d4d8; padding:6px 10px; border-radius:6px; cursor:pointer; font-weight:700; font-size:11px;">Sửa</button>
                <button onclick="deleteBranch('${id}')" style="background:#fff; color:#ef4444; border:1px solid #fee2e2; padding:6px 10px; border-radius:6px; cursor:pointer; font-weight:700; font-size:11px;">Xóa</button>
            </div>`;
        wrap.appendChild(row);
    });
}

function deleteBranch(branchId) {
    if (userRole !== 'admin') return Toast.fire({ icon: 'error', title: 'Chỉ Quản trị viên thao tác được' });
    const name = (branchesCache[branchId] && branchesCache[branchId].name) || branchId;
    Swal.fire({
        title: 'Xóa cơ sở "' + name + '"?',
        html: 'Hành động này XÓA VĨNH VIỄN toàn bộ dữ liệu khách (data + thùng rác) của cơ sở này.<br><b>Không thể hoàn tác.</b><br><br>Nhập <b>XOA</b> để xác nhận.',
        icon: 'error', input: 'text', inputPlaceholder: 'Nhập XOA...',
        showCancelButton: true, confirmButtonColor: '#111', cancelButtonColor: '#fff',
        confirmButtonText: 'Xóa cơ sở', cancelButtonText: '<span style="color:#111">Hủy</span>'
    }).then(r => {
        if (!r.isConfirmed) return;
        if (r.value !== 'XOA') return Swal.fire({ title: 'Thất bại', text: 'Sai mã xác nhận!', icon: 'error', confirmButtonColor: '#111' });
        Promise.all([
            db.ref('branches/' + branchId).remove(),
            db.ref('data/' + branchId).remove(),
            db.ref('trash/' + branchId).remove()
        ]).then(() => {
            delete branchesCache[branchId];
            if (br === branchId) br = Object.keys(branchesCache)[0] || null;
            renderBranchTabs();
            populateAccountBranchSelect();
            loadBranchList();
            Toast.fire({ icon: 'success', title: 'Đã xóa cơ sở ' + name });
        }).catch(err => Swal.fire('Lỗi', err.message, 'error'));
    });
}

function resetAccountForm() {
    editingAccountUid = null;
    document.getElementById('new-acc-email').value = '';
    document.getElementById('new-acc-pass').value = '';
    document.getElementById('new-acc-email').disabled = false;
    document.getElementById('new-acc-pass').style.display = '';
    document.getElementById('new-acc-role').value = 'staff';
    document.getElementById('acc-form-label').innerText = 'Thêm tài khoản';
    document.getElementById('acc-submit-btn').innerText = 'Tạo tài khoản';
    document.getElementById('acc-cancel-btn').style.display = 'none';
}

function cancelEditAccount() { resetAccountForm(); }

function editAccount(uid) {
    if (userRole !== 'admin') return Toast.fire({ icon: 'error', title: 'Chỉ Quản trị viên thao tác được' });
    db.ref('users/' + uid).once('value').then(snap => {
        const u = snap.val();
        if (!u) return;
        editingAccountUid = uid;
        const displayName = u.username || (u.email || uid).replace(LOGIN_DOMAIN, '');
        document.getElementById('new-acc-email').value = displayName;
        document.getElementById('new-acc-email').disabled = true;
        document.getElementById('new-acc-pass').value = '';
        document.getElementById('new-acc-pass').style.display = 'none'; // không đổi mật khẩu client-side
        document.getElementById('new-acc-role').value = u.role || 'staff';
        if (u.branch && u.branch !== '*') document.getElementById('new-acc-branch').value = u.branch;
        document.getElementById('acc-form-label').innerText = 'Sửa tài khoản: ' + displayName;
        document.getElementById('acc-submit-btn').innerText = 'Lưu thay đổi';
        document.getElementById('acc-cancel-btn').style.display = 'block';
        document.getElementById('new-acc-role').focus();
    });
}

function submitAccountForm() {
    if (userRole !== 'admin') return Toast.fire({ icon: 'error', title: 'Chỉ Quản trị viên thao tác được' });
    const branch = document.getElementById('new-acc-branch').value;
    const role = document.getElementById('new-acc-role').value;
    const branchVal = (role === 'admin') ? '*' : branch;

    // Chế độ SỬA: chỉ đổi role + branch (không đổi username/password client-side)
    if (editingAccountUid) {
        db.ref('users/' + editingAccountUid).update({ role, branch: branchVal }).then(() => {
            Toast.fire({ icon: 'success', title: 'Đã cập nhật tài khoản' });
            resetAccountForm();
            loadAccountList();
        }).catch(err => Swal.fire('Lỗi', err.message, 'error'));
        return;
    }

    // Chế độ TẠO MỚI
    const username = document.getElementById('new-acc-email').value.trim();
    const password = document.getElementById('new-acc-pass').value;
    if (!username || !password) return Toast.fire({ icon: 'warning', title: 'Vui lòng nhập tên đăng nhập và mật khẩu.' });
    if (password.length < 6) return Toast.fire({ icon: 'warning', title: 'Mật khẩu tối thiểu 6 ký tự.' });
    const email = toLoginEmail(username);

    const creatorUid = auth.currentUser.uid;
    const secondaryApp = firebase.initializeApp(firebase.apps[0].options, 'Secondary' + Date.now());
    secondaryApp.auth().createUserWithEmailAndPassword(email, password).then(cred => {
        const newUid = cred.user.uid;
        return db.ref('users/' + newUid).set({
            role, branch: branchVal, email, username, createdAt: Date.now(), createdBy: creatorUid
        }).then(() => secondaryApp.auth().signOut()).then(() => secondaryApp.delete());
    }).then(() => {
        Toast.fire({ icon: 'success', title: 'Đã tạo tài khoản ' + username });
        resetAccountForm();
        loadAccountList();
    }).catch(err => {
        secondaryApp.delete().catch(() => {});
        Swal.fire('Lỗi', err.message, 'error');
    });
}

function loadAccountList() {
    const wrap = document.getElementById('account-list');
    if (!wrap) return;
    db.ref('users').once('value').then(snap => {
        const users = snap.val() || {};
        wrap.innerHTML = '';
        Object.keys(users).forEach(uid => {
            const u = users[uid];
            const branchLabel = u.role === 'admin' ? 'Mọi cơ sở' : ((branchesCache[u.branch] && branchesCache[u.branch].name) || u.branch);
            const roleLabel = u.role === 'admin' ? 'Quản trị' : (u.role === 'viewer' ? 'Chỉ xem thu nhập' : 'Nhân viên');
            const row = document.createElement('div');
            row.style.cssText = 'display:flex; justify-content:space-between; align-items:center; background:#fafafa; border:1px solid #e5e5e5; border-radius:8px; padding:8px 12px; font-size:12px;';
            const displayName = u.username || (u.email || uid).replace(LOGIN_DOMAIN, '');
            row.innerHTML = `<div><b>${displayName}</b><div style="color:#888; font-size:11px;">${roleLabel} · ${branchLabel}</div></div>
                <div style="display:flex; gap:6px;">
                    <button onclick="editAccount('${uid}')" style="background:#fff; color:#111; border:1px solid #d4d4d8; padding:6px 10px; border-radius:6px; cursor:pointer; font-weight:700; font-size:11px;">Sửa</button>
                    <button onclick="revokeAccount('${uid}')" style="background:#fff; color:#ef4444; border:1px solid #fee2e2; padding:6px 10px; border-radius:6px; cursor:pointer; font-weight:700; font-size:11px;">Thu hồi</button>
                </div>`;
            wrap.appendChild(row);
        });
    });
}

function showQRCode() {
    if (!br || !branchesCache[br]) return Toast.fire({ icon: 'warning', title: 'Chưa chọn cơ sở.' });
    const name = branchesCache[br].name || br;
    // URL trang khách = thư mục hiện tại + index.html, kèm ?br= để khoá đúng cơ sở
    const base = window.location.href.replace(/admin\.html.*$/i, '').replace(/[^/]*$/, '');
    const clientUrl = base + 'index.html?br=' + encodeURIComponent(br);
    const qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=800x800&data=' + encodeURIComponent(clientUrl);

    document.getElementById('qr-title').innerText = 'MÃ QR ' + name.toUpperCase();
    document.getElementById('qr-image').src = qrUrl;
    document.getElementById('qr-download').href = qrUrl;
    document.getElementById('qr-modal').style.display = 'flex';
}

function revokeAccount(uid) {
    if (userRole !== 'admin') return Toast.fire({ icon: 'error', title: 'Chỉ Quản trị viên thao tác được' });
    if (uid === auth.currentUser.uid) return Toast.fire({ icon: 'warning', title: 'Không thể tự thu hồi quyền của chính mình.' });
    Swal.fire({ title: 'Thu hồi quyền truy cập?', text: 'Tài khoản sẽ không đọc/ghi được dữ liệu nào nữa (vẫn đăng nhập được nhưng vô hiệu). Để xóa hẳn tài khoản, vào Firebase Console > Authentication.', icon: 'warning', showCancelButton: true, confirmButtonColor: '#111', cancelButtonColor: '#fff', confirmButtonText: 'Thu hồi', cancelButtonText: '<span style="color:#111">Hủy</span>' }).then(r => {
        if (r.isConfirmed) {
            db.ref('users/' + uid).remove().then(() => { Toast.fire({ icon: 'success', title: 'Đã thu hồi quyền' }); loadAccountList(); });
        }
    });
}

// ===== Popup nhập tiền (đồng bộ thiết kế web) =====
let _priceResolve = null, _priceClientId = null, _paySelected = 'Tiền mặt';

function fmtMoneyStr(raw) {
    const v = (raw || '').trim();
    const num = v.replace(/\D/g, '');
    if (!num) return /[a-zA-ZÀ-ỹ]/.test(v) ? 'Miễn phí' : '';
    return parseInt(num, 10).toLocaleString('vi-VN') + ' đ';
}

// Mức giá hay dùng nhất của chính cơ sở này, để bấm một chạm thay vì gõ 6 chữ số
function renderQuickPrice() {
    const box = document.getElementById('quick-price');
    if (!box) return;
    const freq = {};
    Object.values(currentData || {}).forEach(c => {
        const v = parseInt(String(c.price || '').replace(/\D/g, ''), 10);
        if (v > 0) freq[v] = (freq[v] || 0) + 1;
    });
    const top = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 4)
                      .map(x => parseInt(x[0], 10)).sort((a, b) => a - b);
    if (!top.length) { box.innerHTML = ''; return; }
    box.innerHTML = top.map(v =>
        `<button type="button" onclick="pickQuickPrice(${v})">${Math.round(v / 1000)}k</button>`
    ).join('');
}

function pickQuickPrice(v) {
    const inp = document.getElementById('price-amount-input');
    if (inp) inp.value = v.toLocaleString('vi-VN');
    confirmPrice();
}

function openPriceModal(clientId, currentPay) {
    _priceClientId = clientId;
    _paySelected = (currentPay === 'Chuyển khoản') ? 'Chuyển khoản' : 'Tiền mặt';
    document.getElementById('price-amount-input').value = '';
    renderQuickPrice();
    selectPay(_paySelected);
    document.getElementById('price-modal').style.display = 'flex';
    setTimeout(() => { const a = document.getElementById('price-amount-input'); if (a && a.style.display !== 'none') a.focus(); }, 100);
    return new Promise(resolve => { _priceResolve = resolve; });
}

function selectPay(method) {
    _paySelected = method;
    document.querySelectorAll('#price-modal .pay-opt').forEach(b => b.classList.toggle('active', b.getAttribute('data-pay') === method));
    // Miễn phí: ẩn ô tiền; TM/CK: hiện ô tiền
    document.getElementById('price-amount-wrap').style.display = (method === 'Miễn phí') ? 'none' : 'block';
    if (method !== 'Miễn phí') renderQuickPrice();
}

function confirmPrice() {
    let price, payment;
    if (_paySelected === 'Miễn phí') {
        price = 'Miễn phí'; payment = 'Miễn phí';
    } else {
        price = fmtMoneyStr(document.getElementById('price-amount-input').value);
        if (!price || price === 'Miễn phí') return Toast.fire({ icon: 'warning', title: 'Nhập số tiền hợp lệ.' });
        payment = _paySelected;
    }
    const cid = _priceClientId;

    // Cập nhật giao diện NGAY, không chờ máy chủ trả lời (Firebase tự đồng bộ nền,
    // có hàng đợi khi mất mạng). Chờ ở đây làm popup treo mấy giây.
    const inp = document.getElementById('price_' + cid);
    const paySel = document.getElementById('payment_' + cid);
    if (inp) { inp.value = price; const card = inp.closest('.client-card'); if (card) card.classList.toggle('card-no-price', !price); }
    if (paySel) { paySel.value = payment; paySel.disabled = (price === 'Miễn phí'); paySel.classList.toggle('is-empty', !payment); }
    document.getElementById('price-modal').style.display = 'none';
    if (_priceResolve) { _priceResolve(true); _priceResolve = null; }

    db.ref(dbPath + br + '/' + cid).update({ price, payment })
        .catch(err => Swal.fire('Lỗi', 'Không lưu được giá: ' + err.message, 'error'));
}

function cancelPrice() {
    document.getElementById('price-modal').style.display = 'none';
    if (_priceResolve) { _priceResolve(false); _priceResolve = null; }
}

// Hủy modal -> resolve false (không trả ảnh)
document.addEventListener('click', (e) => {
    const m = document.getElementById('price-modal');
    if (!m || m.style.display !== 'flex') return;
    // nút Hủy đã có onclick đóng; bắt thêm khi click nền ngoài
    if (e.target === m) { m.style.display = 'none'; if (_priceResolve) { _priceResolve(false); _priceResolve = null; } }
});

// Auto-format khi gõ số trong popup (chỉ giữ số)
document.addEventListener('input', (e) => {
    if (e.target && e.target.id === 'price-amount-input') {
        const num = e.target.value.replace(/\D/g, '');
        e.target.value = num ? parseInt(num, 10).toLocaleString('vi-VN') : '';
    }
});

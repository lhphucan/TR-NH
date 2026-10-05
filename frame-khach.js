// ===== Trang khách: ghép ảnh của lượt chụp vào frame của tiệm rồi gửi tiệm in =====
// Dùng chung với app.js: db, gsCall, getDStr, BRANCHES_CACHE, _alb, _albCtx,
// albZoom, laDienThoai, Swal. Mỗi lượt chụp chỉ gửi được một ảnh ghép: đánh
// dấu ở data/<cơ sở>/<phiên>/framed/<mã thư mục lượt chụp>.

let FK_FRAMES = null;   // frame đọc từ Firebase
let FKF = null;         // frame đang ghép
let FKP = [];           // ảnh của từng ô: { id, url, iw, ih, s, ox, oy, r }
let FK_SEL = -1;        // ô vừa chỉnh: thanh phóng to và nút xoay tác động vào ô này
let FK_PK = null;       // bảng chọn ảnh đang mở
let FK_RES = null;      // ảnh ghép xong: { blob, view, w, h }
let FK_LOCAL = [];      // ảnh khách chọn từ máy (đã tải về chỉnh xong): { id, file, url, full, iw, ih }
let FK_TAB = 'album';   // bảng chọn ảnh đang ở thẻ nào: album | may
let FK_SESSION = null;  // lượt chụp mới nhất của phiên đang mở, cho nút ghép ở ngoài album
let FKB = null;         // bộ lọc màu của frame đang ghép: { id, name, baked } hoặc null
let FK_GOI = '';        // gói frame của lượt: 'cao' thì dùng được frame cao cấp
let FK_GOI_REF = null;  // theo dõi gói: nhân viên mở khoá là máy khách mở ngay
const FK_FILT = {};     // bộ lọc đã nạp, theo mã
const FK_PVF = {};      // ảnh xem trước đã lọc: '<mã lọc>|<mã ảnh>' -> { url }

const fkEsc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fkPrev = id => FR.gUrl(id, 1600);   // để xem và kéo
const fkThumb = id => FR.gUrl(id, 600);   // trong bảng chọn ảnh

async function fkLoadFrames() {
    if (!FK_FRAMES) {
        try { FK_FRAMES = (await db.ref('frames').once('value')).val() || {}; }
        catch (e) { FK_FRAMES = {}; }
    }
    return FK_FRAMES;
}

// Khách chỉ thấy frame đang dùng của đúng cơ sở mình chụp
function fkFramesFor(br) {
    return Object.keys(FK_FRAMES || {}).map(id => Object.assign({ id }, FK_FRAMES[id]))
        .filter(f => f.on !== false && (f.all || (f.branches && f.branches[br])) && f.file && f.prev && (f.slots || []).length)
        .sort(FR.frameOrder);
}

// Ảnh để ghép: ảnh chụp trong lượt, bỏ các bản ghép khung có sẵn của máy chụp
// (cách nhận bản ghép ở banGhepIds trong app.js)
function fkPhotos() {
    const list = _alb || [];
    const ghep = banGhepIds(list);
    return list.filter(x => !ghep.has(x.id) && !laAnhLoc(x.name));
}

// ---------- Tải trước bản gốc ----------
// Khách mất một hai phút kéo chỉnh; trong lúc đó tải sẵn frame gốc và ảnh gốc ở
// nền, bấm "Ghép xong" là gần như không còn phải chờ mạng. Hai luồng một lúc để
// không giành hết mạng của ảnh xem trước.
const FK_ORIG = {};   // mã file -> { p: Promise<địa chỉ blob>, got, total, done }
let fkQ = [], fkQRun = 0;
function fkQueue(job) { return new Promise((ok, no) => { fkQ.push({ job, ok, no }); fkQNext(); }); }
function fkQNext() {
    while (fkQRun < 2 && fkQ.length) {
        const x = fkQ.shift();
        fkQRun++;
        x.job().then(x.ok, x.no).finally(() => { fkQRun--; fkQNext(); });
    }
}

function fkPrefetch(id) {
    if (FK_ORIG[id]) return FK_ORIG[id].p;
    const o = FK_ORIG[id] = { got: 0, total: 0, done: false };
    o.p = fkQueue(async () => {
        const res = await fetch(FR.gUrl(id));
        if (!res.ok) throw new Error('HTTP ' + res.status);
        o.total = +res.headers.get('content-length') || 0;
        let blob;
        if (res.body && res.body.getReader) {
            // Đọc từng phần để biết đã tải được bao nhiêu, hiện cho khách
            const rd = res.body.getReader(), parts = [];
            for (;;) {
                const { done, value } = await rd.read();
                if (done) break;
                parts.push(value);
                o.got += value.length;
            }
            blob = new Blob(parts, { type: res.headers.get('content-type') || 'image/jpeg' });
        } else { blob = await res.blob(); o.got = blob.size; }
        if (!o.total) o.total = o.got;
        o.done = true;
        return URL.createObjectURL(blob);
    });
    o.p.catch(() => { delete FK_ORIG[id]; });   // lỗi thì lần sau tải lại
    return o.p;
}

// Bản gốc để ghép: lấy bản đã tải sẵn, tải sẵn hỏng thì đọc thẳng từ Google
async function fkOrigUrl(id) {
    try { return await fkPrefetch(id); } catch (e) { return FR.gUrl(id); }
}

const fkMB = n => (n / 1048576).toLocaleString('vi-VN', { maximumFractionDigits: 1, minimumFractionDigits: n < 10485760 ? 1 : 0 });

// Bộ lọc màu gán cho frame (config/filters/<mã>). Không có hoặc đọc lỗi thì ghép ảnh màu gốc.
async function fkFilterFor(f) {
    if (!f || !f.filter) return null;
    if (FK_FILT[f.filter] !== undefined) return FK_FILT[f.filter];
    try {
        const rec = (await db.ref('config/filters/' + f.filter).once('value')).val();
        const baked = rec ? await FR.loadFilter(rec) : null;
        FK_FILT[f.filter] = baked ? { id: f.filter, name: String(rec.name || 'Màu frame'), baked } : null;
    } catch (e) { FK_FILT[f.filter] = null; }
    return FK_FILT[f.filter];
}

// Ảnh xem trước mang màu của frame (bản nhỏ, chỉ để xem và kéo)
async function fkPreviewFiltered(id, src) {
    const key = FKB.id + '|' + id;
    if (FK_PVF[key]) return FK_PVF[key];
    const im = await FR.loadImg(src);
    const c = document.createElement('canvas');
    c.width = im.naturalWidth; c.height = im.naturalHeight;
    c.getContext('2d').drawImage(im, 0, 0);
    FR.filterCanvas(c, FKB.baked);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
    c.width = c.height = 0;
    FK_PVF[key] = { url: URL.createObjectURL(blob), iw: im.naturalWidth, ih: im.naturalHeight };
    return FK_PVF[key];
}

// Mỗi lần gửi một bản ghi riêng, chỉ tạo mới chứ không sửa xoá được
function fkFramedRef() {
    return db.ref('data/' + _albCtx.branch + '/' + _albCtx.clientId + '/framed/' + _albCtx.fid + '/G_' + Date.now());
}

async function frOpen() {
    if (!window._albCtx || !_albCtx.clientId) return;
    fkBuild();
    document.getElementById('fk-modal').style.display = 'flex';
    document.body.style.overflow = 'hidden';
    fkStep('pick');
    // Gói frame của đúng lượt này; nhân viên đổi gói thì danh sách mở khoá ngay
    if (FK_GOI_REF) FK_GOI_REF.off();
    FK_GOI_REF = db.ref('data/' + _albCtx.branch + '/' + _albCtx.clientId + '/goi');
    let dau = true;
    FK_GOI_REF.on('value', s => {
        FK_GOI = s.val() === 'cao' ? 'cao' : '';
        fkListRender();
        // Chỉ có một frame dùng được thì vào luôn (lần đầu mở)
        if (dau) { dau = false; const ok = fkFramesFor(_albCtx.branch).filter(f => !fkKhoa(f)); if (ok.length === 1 && fkFramesFor(_albCtx.branch).length === 1) fkOpenFrame(ok[0].id); }
    }, () => { FK_GOI = ''; fkListRender(); });
}

const fkKhoa = f => !!f.cao && FK_GOI !== 'cao';

function fkListRender() {
    const box = document.getElementById('fk-list');
    if (!box) return;
    box.innerHTML = fkFramesFor(_albCtx.branch).map(f => `
        <button class="fr-fitem${fkKhoa(f) ? ' khoa' : ''}" onclick="fkOpenFrame('${fkEsc(f.id)}')">
            <span class="fr-fimg">${FR.thumbHtml(f)}${fkKhoa(f) ? `<span class="fr-lock"><svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path></svg></span>` : ''}</span>
            <b>${fkEsc(f.name)}</b>
            <span class="fr-meta">${fkKhoa(f) ? 'Frame cao cấp · hỏi nhân viên' : f.slots.length + ' ảnh'}</span>
        </button>`).join('');
}

function fkClose() {
    document.getElementById('fk-modal').style.display = 'none';
    if (FK_GOI_REF) { FK_GOI_REF.off(); FK_GOI_REF = null; }
    if (document.getElementById('fk-ed')) { document.getElementById('fk-ed').classList.remove('on'); FK_ED = -1; }
    // Album vẫn đang mở bên dưới: giữ khoá cuộn trang
    if (document.getElementById('alb-modal').style.display !== 'flex') document.body.style.overflow = '';
}

function fkStep(s) {
    ['pick', 'comp', 'res'].forEach(x => document.getElementById('fk-' + x).classList.toggle('fr-hidden', x !== s));
    document.getElementById('fk-modal').dataset.step = s;
    // Nút đổi frame nằm trên thanh đầu, chỉ hiện ở màn ghép khi có từ 2 frame
    document.getElementById('fk-back').style.display = s === 'comp' && FKF && fkFramesFor(_albCtx.branch).length > 1 ? '' : 'none';
    document.getElementById('fk-title').innerText = s === 'pick' ? 'Chọn frame' : s === 'comp' ? 'Ghép ảnh vào frame' : 'Ảnh ghép';
}

function fkBuild() {
    if (document.getElementById('fk-modal')) return;
    document.body.insertAdjacentHTML('beforeend', `
    <div id="fk-modal" class="fr-modal" style="display:none;">
        <div class="fr-head">
            <h3 id="fk-title">Chọn frame</h3>
            <button class="fr-btn fk-hbtn" id="fk-back" onclick="fkStep('pick')">Đổi frame</button>
            <button class="fr-x" onclick="fkClose()" aria-label="Đóng">&times;</button>
        </div>
        <div class="fr-body"><div class="fr-wrap">
            <div id="fk-pick" class="fr-card"><div id="fk-list" class="fr-flist"></div></div>

            <div id="fk-comp" class="fr-card fk-comp fr-hidden">
                <div id="fk-rot" class="fk-rot fr-hidden">⟳ Xoay ngang điện thoại để xem frame to hơn</div>
                <div id="fk-stage" class="fr-stage"></div>
                <p class="fr-hint fk-tip">Chạm ô trống để chọn ảnh, chạm ô có ảnh để chỉnh.</p>
                <div class="fk-foot">
                    <span id="fk-prog"></span>
                    <button class="fr-btn solid" id="fk-done" onclick="fkExport()" disabled>Ghép xong</button>
                </div>
            </div>

            <div id="fk-res" class="fr-card fr-res fr-hidden">
                <img id="fk-res-img" alt="">
                <p class="fr-hint" id="fk-res-info"></p>
                <div class="fr-bar fr-hidden" id="fk-bar"><span></span></div>
                <button class="fr-btn solid fr-big" id="fk-send" style="margin-top:12px;" onclick="fkSend()">Gửi cho tiệm in</button>
                <div class="fr-row" style="margin-top:8px;">
                    <button class="fr-btn" style="flex:1;" onclick="fkStep('comp'); fkRender();">‹ Sửa tiếp</button>
                    <button class="fr-btn" style="flex:1;" onclick="fkSave()">Lưu về máy</button>
                </div>
            </div>
        </div></div>
    </div>

    <div id="fk-ed" class="fk-ed">
        <div class="fr-head">
            <button class="fr-btn solid" onclick="fkEdClose()">Xong</button>
            <h3 id="fk-ed-title" style="text-align:center;"></h3>
            <button class="fr-btn fk-nav" onclick="fkEdGo(-1)" aria-label="Ô trước">‹</button>
            <button class="fr-btn fk-nav" onclick="fkEdGo(1)" aria-label="Ô sau">›</button>
        </div>
        <div id="fk-ed-view" class="fk-ed-view"><div id="fk-ed-in" class="fk-ed-in"></div></div>
        <div class="fk-ed-tools" id="fk-ed-tools">
            <div id="fk-ed-has">
                <label class="fr-label">Phóng to</label>
                <input type="range" id="fk-ed-zoom" min="1" max="4" step="0.01" value="1" oninput="fkZoom(this.value)">
                <div class="fr-row" style="margin-top:10px;">
                    <button class="fr-btn" style="flex:1;" onclick="fkEdChange()">Đổi ảnh</button>
                    <button class="fr-btn" style="flex:1;" onclick="fkOp('rot')">Xoay 90°</button>
                    <button class="fr-btn danger" style="flex:1;" onclick="fkOp('del')">Bỏ ảnh</button>
                </div>
                <p class="fr-hint" style="text-align:center;">Kéo để dời ảnh, chụm hai ngón để phóng to.</p>
            </div>
            <button class="fr-btn solid fr-big" id="fk-ed-add" onclick="fkPkOpen(FK_ED, 'fill')">+ Chọn ảnh cho ô này</button>
        </div>
    </div>

    <div id="fk-pk" class="fr-pk" style="display:none;">
        <div class="fr-head">
            <h3 id="fk-pk-title">Chọn ảnh</h3>
            <button class="fr-x" onclick="fkPkClose()" aria-label="Đóng">&times;</button>
        </div>
        <div id="fk-mini" class="fr-mini"></div>
        <div class="fr-tabs">
            <button type="button" class="fr-tab" id="fk-tab-album" onclick="fkTab('album')">Ảnh lượt chụp</button>
            <button type="button" class="fr-tab" id="fk-tab-may" onclick="fkTab('may')">Ảnh trong máy</button>
        </div>
        <input type="file" id="fk-file" class="fr-hidden" multiple
               accept=".jpg,.jpeg,.png,.heic,.heif,.webp,image/jpeg,image/png,image/heic,image/heif,image/webp" onchange="fkAddLocal(this)">
        <div id="fk-pk-grid" class="fr-pk-grid"></div>
        <div class="fr-pk-foot" id="fk-pk-foot">
            <span id="fk-pk-count"></span>
            <button class="fr-btn" id="fk-pk-rep" onclick="fkPkRepeat()" style="display:none;">Lặp đủ ô</button>
            <button class="fr-btn solid" id="fk-pk-ok" onclick="fkPkDone()" disabled>Chọn</button>
        </div>
    </div>`);
    fkBindStage();
    fkBindEd();
    // Xoay máy: vẽ lại cho frame vừa khung mới
    window.addEventListener('resize', () => { if (FKF && !document.getElementById('fk-comp').classList.contains('fr-hidden')) fkRender(); });
}

async function fkOpenFrame(id) {
    const f = (FK_FRAMES || {})[id];
    if (!f) return;
    if (fkKhoa(f)) {
        return Swal.fire({ title: 'Frame cao cấp', text: 'Bạn hỏi nhân viên để mở frame này nhé.', icon: 'info', confirmButtonColor: '#111' });
    }
    FKF = Object.assign({ id }, f);
    FKP = FKF.slots.map(() => null);
    FK_SEL = -1;
    FK_ED = -1;
    document.getElementById('fk-ed').classList.remove('on');
    FKB = await fkFilterFor(FKF);
    [FKF.file, ...fkFxFiles()].forEach(id => fkPrefetch(id).catch(() => {}));
    fkStep('comp');
    fkRestoring = true;
    fkRender();
    try { await fkDraftRestore(); } finally { fkRestoring = false; }
    fkRender();
}

// Cỡ khung ghép: vừa bề ngang, và khi xoay ngang máy thì vừa cả chiều cao còn lại
// (trừ thanh đầu, thanh dưới) để không phải cuộn mới thấy hết frame.
function fkK() {
    const st = document.getElementById('fk-stage');
    const wrap = st.parentElement;
    const foot = wrap.querySelector('.fk-foot'), head = document.querySelector('#fk-modal .fr-head');
    const tip = wrap.querySelector('.fk-tip'), rot = document.getElementById('fk-rot');
    const ngang = fkNgang();
    const availH = window.innerHeight - (head ? head.offsetHeight : 0) - 16
                 - (ngang ? 0 : (foot ? foot.offsetHeight : 0) + (tip ? tip.offsetHeight + 8 : 0)
                              + (rot && !rot.classList.contains('fr-hidden') ? rot.offsetHeight + 8 : 0) + 8);
    const fullW = wrap.clientWidth - (ngang && foot ? foot.offsetWidth + 10 : 0);
    const W = Math.max(160, Math.min(fullW, availH * FKF.w / FKF.h));
    st.style.width = W + 'px';
    st.style.height = (W * FKF.h / FKF.w) + 'px';
    return W / FKF.w;
}

// Điện thoại xoay ngang (màn thấp): bố cục ngang, nút Ghép xong sang bên phải
function fkNgang() { return !!(window.matchMedia && window.matchMedia('(orientation: landscape) and (max-height: 520px)').matches); }

// HTML của frame + ảnh các ô ở tỷ lệ k (điểm màn hình trên 1 điểm frame)
function fkStageHtml(k) {
    // Vẽ đúng thứ tự lớp admin xếp: lớp sau nằm trên lớp trước
    let html = '';
    FR.layersOf(FKF).forEach((l, j) => {
        const z = 2 + j * 2;
        if (l.k === 'photos') { html += fkSlotsHtml(k, z); return; }
        const id = l.k === 'frame' ? FKF.prev : l.prev;
        if (id) html += `<img class="fr-frame" src="${FR.gUrl(id)}" alt="" style="z-index:${z}; opacity:${l.op == null ? 1 : l.op}">`;
    });
    const marks = FKF.slots.map((s, i) => FKP[i] ? '' : `
        <div class="fr-cmark" style="${FR.boxCss(s, k)} z-index:60;"><span class="fr-plus" style="transform:rotate(${-s.rot}deg); font-size:${fkPlus(s, k)}px">+</span></div>`).join('');
    return html + marks;
}

// Dấu + vừa với ô: khoảng 1/4 cạnh ngắn, không quá to ở ô nhỏ
function fkPlus(s, k) { return Math.round(Math.max(12, Math.min(34, Math.min(s.w, s.h) * k * 0.26))); }

function fkSlotsHtml(k, z) {
    return FKF.slots.map((s, i) => {
        const p = FKP[i];
        let img = '';
        if (p) {
            const g = FR.geom(s, p);
            img = `<img src="${p.url}" alt="" style="width:${p.iw * g.cover * p.s * k}px; height:${p.ih * g.cover * p.s * k}px;
                   transform:translate(-50%,-50%) translate(${p.ox * s.w * k}px,${p.oy * s.h * k}px) rotate(${p.r}deg);">`;
        }
        return `<div class="fr-cslot" style="${FR.boxCss(s, k)} z-index:${z};">${img}</div>`;
    }).join('');
}

// File gốc của các lớp PNG thêm (lấp lánh, sticker...)
const fkFxFiles = () => FR.layersOf(FKF).filter(l => l.k === 'fx' && l.file).map(l => l.file);

function fkRender() {
    if (!FKF) return;
    // Frame khổ ngang trên điện thoại cầm dọc: gợi ý xoay ngang cho to
    const cam = window.matchMedia && window.matchMedia('(hover: none) and (pointer: coarse)').matches;
    document.getElementById('fk-rot').classList.toggle('fr-hidden', !(cam && FKF.w > FKF.h * 1.15 && window.innerHeight > window.innerWidth));
    const k = fkK();
    document.getElementById('fk-stage').innerHTML = fkStageHtml(k);

    const n = FKP.filter(Boolean).length;
    document.getElementById('fk-prog').innerText = `${n}/${FKF.slots.length} ô có ảnh`;
    document.getElementById('fk-done').disabled = n === 0;
    if (FK_ED >= 0) fkEdRender();
    fkDraftLater();
}

// ---------- Màn chỉnh một ô ----------
// Ô trên điện thoại chỉ còn 40-70 điểm, kéo hay chụm trong đó gần như không
// được. Chạm ô có ảnh thì mở ô đó to gần hết màn, phần frame xung quanh mờ đi.
let FK_ED = -1, FK_EDK = 1;

function fkEdOpen(i) {
    FK_ED = i;
    FK_SEL = i;
    document.getElementById('fk-ed').classList.add('on');
    fkEdRender();
}

function fkEdClose() {
    document.getElementById('fk-ed').classList.remove('on');
    FK_ED = -1;
    FK_SEL = -1;
    fkRender();
}

function fkEdGo(d) {
    const n = FKF.slots.length;
    FK_ED = (FK_ED + d + n) % n;
    FK_SEL = FK_ED;
    fkEdRender();
}

function fkEdChange() { fkPkOpen(FK_ED, 'replace'); }

function fkEdRender() {
    if (FK_ED < 0 || !FKF) return;
    const i = FK_ED, s = FKF.slots[i], p = FKP[i];
    FK_SEL = i;
    const view = document.getElementById('fk-ed-view');
    const VW = view.clientWidth, VH = view.clientHeight;
    // Ô có thể xoay: lấy khung bao để ô luôn nằm trọn trong màn
    const a = (s.rot || 0) * Math.PI / 180;
    const bw = Math.abs(s.w * Math.cos(a)) + Math.abs(s.h * Math.sin(a));
    const bh = Math.abs(s.w * Math.sin(a)) + Math.abs(s.h * Math.cos(a));
    const k = FK_EDK = Math.min(VW * 0.86 / bw, VH * 0.86 / bh);
    const inner = document.getElementById('fk-ed-in');
    inner.style.width = FKF.w * k + 'px';
    inner.style.height = FKF.h * k + 'px';
    inner.style.left = (VW / 2 - s.cx * k) + 'px';
    inner.style.top = (VH / 2 - s.cy * k) + 'px';
    inner.innerHTML = fkStageHtml(k) + `<div class="fk-ed-hole" style="${FR.boxCss(s, k)}"></div>`;
    document.getElementById('fk-ed-title').innerText = `Ô ${i + 1}/${FKF.slots.length}`;
    document.getElementById('fk-ed-has').style.display = p ? '' : 'none';
    document.getElementById('fk-ed-add').style.display = p ? 'none' : '';
    if (p) document.getElementById('fk-ed-zoom').value = p.s;
}

// Kéo để dời, chụm hai ngón hoặc lăn chuột để phóng to ảnh của ô đang chỉnh
function fkBindEd() {
    const view = document.getElementById('fk-ed-view');
    const pts = new Map();
    let pan = null, pinch = null;
    view.addEventListener('pointerdown', e => {
        if (FK_ED < 0 || !FKP[FK_ED]) return;
        pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
        view.setPointerCapture(e.pointerId);
        if (pts.size === 2) {
            const [a, b] = [...pts.values()];
            pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), s: FKP[FK_ED].s };
            pan = null;
        } else pan = { x: e.clientX, y: e.clientY, ox: FKP[FK_ED].ox, oy: FKP[FK_ED].oy };
    });
    view.addEventListener('pointermove', e => {
        if (!pts.has(e.pointerId) || FK_ED < 0 || !FKP[FK_ED]) return;
        pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const s = FKF.slots[FK_ED], p = FKP[FK_ED];
        if (pinch && pts.size >= 2) {
            const [a, b] = [...pts.values()];
            p.s = pinch.s * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d;
        } else if (pan) {
            // Đổi độ dời trên màn sang trục của ô (ô có thể đang xoay)
            const ang = -s.rot * Math.PI / 180;
            const dx = (e.clientX - pan.x) / FK_EDK, dy = (e.clientY - pan.y) / FK_EDK;
            p.ox = pan.ox + (dx * Math.cos(ang) - dy * Math.sin(ang)) / s.w;
            p.oy = pan.oy + (dx * Math.sin(ang) + dy * Math.cos(ang)) / s.h;
        } else return;
        FR.clamp(s, p); fkEdRender();
    });
    const up = e => {
        pts.delete(e.pointerId);
        if (pts.size < 2) pinch = null;
        if (pts.size === 0) { pan = null; fkRender(); }
    };
    view.addEventListener('pointerup', up);
    view.addEventListener('pointercancel', up);
    view.addEventListener('wheel', e => {
        if (FK_ED < 0 || !FKP[FK_ED]) return;
        e.preventDefault();
        FKP[FK_ED].s *= e.deltaY < 0 ? 1.08 : 1 / 1.08;
        FR.clamp(FKF.slots[FK_ED], FKP[FK_ED]); fkRender();
    }, { passive: false });
    window.addEventListener('resize', () => { if (FK_ED >= 0) fkEdRender(); });
}

// Khung ghép chính chỉ để xem tổng thể và chạm: ô trống thì chọn ảnh, ô có ảnh
// thì mở màn chỉnh ô. Không kéo trên khung nhỏ nữa, hết cảnh chạm nhầm.
function fkBindStage() {
    const st = document.getElementById('fk-stage');
    let tap = null;
    st.addEventListener('pointerdown', e => {
        if (!FKF) return;
        const r = st.getBoundingClientRect(), k = st.clientWidth / FKF.w;
        tap = { i: FR.slotAt(FKF.slots, (e.clientX - r.left) / k, (e.clientY - r.top) / k), x: e.clientX, y: e.clientY };
    });
    st.addEventListener('pointermove', e => { if (tap && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > 10) tap = null; });
    st.addEventListener('pointercancel', () => { tap = null; });
    st.addEventListener('pointerup', () => {
        if (tap && tap.i >= 0) {
            if (FKP[tap.i]) fkEdOpen(tap.i);
            else fkPkOpen(tap.i, 'fill');
        }
        tap = null;
    });
}

// Đặt ảnh vào ô. Cỡ ảnh lấy từ bản 1600 (cùng tỷ lệ với bản gốc nên phép tính không đổi)
async function fkSetPhoto(i, id, keep) {
    const loc = FK_LOCAL.find(x => x.id === id);
    if (loc) {
        const url = FKB ? (await fkPreviewFiltered(id, loc.url)).url : loc.url;
        FKP[i] = Object.assign({ id, url, full: loc.full, local: true, iw: loc.iw, ih: loc.ih, s: 1, ox: 0, oy: 0, r: 0 }, keep || {});
        FR.clamp(FKF.slots[i], FKP[i]);
        return;
    }
    fkPrefetch(id).catch(() => {});   // tải sẵn bản gốc trong lúc khách chỉnh
    let url = fkPrev(id), iw, ih;
    if (FKB) ({ url, iw, ih } = await fkPreviewFiltered(id, url));
    else { const im = await FR.loadImg(url); iw = im.naturalWidth; ih = im.naturalHeight; }
    FKP[i] = Object.assign({ id, url, iw, ih, s: 1, ox: 0, oy: 0, r: 0 }, keep || {});
    FR.clamp(FKF.slots[i], FKP[i]);
}

function fkZoom(v) {
    if (FK_SEL < 0 || !FKP[FK_SEL]) return;
    FKP[FK_SEL].s = parseFloat(v);
    FR.clamp(FKF.slots[FK_SEL], FKP[FK_SEL]);
    if (FK_ED >= 0) fkEdRender(); else fkRender();
}

function fkOp(op) {
    if (FK_SEL < 0 || !FKP[FK_SEL]) return;
    if (op === 'rot') { FKP[FK_SEL].r = (FKP[FK_SEL].r + 90) % 360; FKP[FK_SEL].ox = FKP[FK_SEL].oy = 0; FR.clamp(FKF.slots[FK_SEL], FKP[FK_SEL]); }
    if (op === 'del') FKP[FK_SEL] = null;
    fkRender();
}

// ---------- Bảng chọn ảnh ----------
// fill: chạm ô trống -> chọn nhiều ảnh, điền vào ô đó rồi lần lượt các ô trống sau nó
// replace: chạm ô có ảnh -> chọn một ảnh để thay
// Trong lúc chọn, phía trên có frame thu nhỏ đánh số ô; ảnh đang nằm trong frame
// ghi đúng số ô của nó, để khách biết đổi ảnh nào ở ô nào.
function fkPkOpen(slot, mode) {
    let targets = [slot];
    if (mode === 'fill') {
        const n = FKF.slots.length;
        for (let j = 1; j < n; j++) { const t = (slot + j) % n; if (!FKP[t]) targets.push(t); }
    }
    FK_PK = { mode, slot, targets, picked: [] };
    document.getElementById('fk-pk-title').innerText = mode === 'replace' ? `Chọn ảnh thay cho ô ${slot + 1}` : 'Chọn ảnh';
    document.getElementById('fk-pk-foot').classList.toggle('fr-hidden', mode === 'replace');
    // Lượt chụp không có ảnh nào thì mở thẳng thẻ ảnh trong máy
    if (!fkPhotos().length) FK_TAB = 'may';
    // Mở bảng trước rồi mới vẽ frame thu nhỏ: bảng còn ẩn thì đo bề rộng ra 0,
    // các số ô dồn hết vào một góc
    document.getElementById('fk-pk').style.display = 'flex';
    fkTab(FK_TAB);
    fkMini();
    fkPkCount();
}

// Hai nguồn ảnh: ảnh của lượt chụp trên Drive, và ảnh trong máy khách (thường
// là ảnh đã tải về chỉnh màu, chỉnh da xong mới muốn ghép)
function fkTab(t) {
    FK_TAB = t;
    document.getElementById('fk-tab-album').classList.toggle('on', t === 'album');
    document.getElementById('fk-tab-may').classList.toggle('on', t === 'may');
    fkPkGrid();
}

function fkPkGrid() {
    if (!FK_PK) return;
    const mode = FK_PK.mode;
    // Ảnh nào đang nằm ở ô nào: ghi đúng số ô
    const at = {};
    FKP.forEach((p, i) => { if (p) (at[p.id] = at[p.id] || []).push(i + 1); });
    const list = FK_TAB === 'album'
        ? fkPhotos().map(x => ({ id: x.id, src: fkThumb(x.id) }))
        : FK_LOCAL.map(x => ({ id: x.id, src: x.url }));
    const item = x => {
        const j = FK_PK.picked.indexOf(x.id);
        return `<button type="button" class="fr-pk-item${j >= 0 ? ' on' : ''}" data-id="${fkEsc(x.id)}">
            <span class="fr-pk-ph"><img src="${x.src}" alt="" loading="lazy" decoding="async"></span>
            ${mode === 'fill' ? `<span class="fr-pk-tick">${j >= 0 ? FK_PK.targets[j] + 1 : ''}</span>` : ''}
            ${at[x.id] ? `<span class="fr-pk-used">${at[x.id].join(', ')}</span>` : ''}
        </button>`;
    };
    const add = FK_TAB === 'may'
        ? `<label for="fk-file" class="fr-pk-item fr-pk-add"><span class="fr-pk-ph"><span>+ Chọn ảnh trong máy</span></span></label>` : '';
    const grid = document.getElementById('fk-pk-grid');
    grid.innerHTML = add + list.map(item).join('')
        + (FK_TAB === 'album' && !list.length ? '<p class="fr-hint" style="grid-column:1/-1;">Lượt chụp chưa có ảnh nào.</p>' : '');
    grid.querySelectorAll('.fr-pk-item[data-id]').forEach(b => b.onclick = () => fkPkTap(b));
}

// Ảnh khách chọn từ máy: giữ nguyên file gốc để ghép, chỉ làm bản nhỏ để xem
async function fkAddLocal(inp) {
    const files = Array.from(inp.files || []);
    inp.value = '';
    if (!files.length) return;
    const added = [];
    let bad = 0;
    for (const file of files) {
        try {
            const p = await FR.shrink(file, 1600, 'image/jpeg');
            const x = { id: 'L' + Date.now() + '_' + FK_LOCAL.length, file, url: URL.createObjectURL(p.blob), full: URL.createObjectURL(file), iw: p.nw, ih: p.nh };
            FK_LOCAL.push(x);
            added.push(x.id);
        } catch (e) { bad++; }
    }
    if (bad) Swal.fire({ toast: true, position: 'bottom', timer: 2600, showConfirmButton: false, icon: 'warning', title: `${bad} ảnh không mở được trên máy này` });
    if (!FK_PK) return;
    // Đổi ảnh một ô mà chọn đúng một ảnh -> đặt luôn, khỏi chạm thêm lần nữa
    if (FK_PK.mode === 'replace' && added.length === 1) {
        const i = FK_PK.slot;
        fkPkClose();
        await fkSetPhoto(i, added[0]);
        FK_SEL = i;
        return fkRender();
    }
    // Điền ô trống: tự tick luôn các ảnh vừa chọn, còn bao nhiêu ô thì tick bấy nhiêu
    if (FK_PK.mode === 'fill') added.forEach(id => { if (FK_PK.picked.length < FK_PK.targets.length) FK_PK.picked.push(id); });
    fkPkGrid();
    fkMini();
    fkPkCount();
}

// Frame thu nhỏ đánh số ô; ô đang đổi (hoặc các ô sắp điền) được tô đậm
function fkMini() {
    const box = document.getElementById('fk-mini');
    const W = Math.min((box.parentElement.clientWidth || window.innerWidth) - 32, 300);
    const k = W / FKF.w;
    box.style.width = W + 'px';
    box.style.height = (FKF.h * k) + 'px';
    const on = new Set(FK_PK.mode === 'replace' ? [FK_PK.slot] : FK_PK.targets.slice(0, Math.max(1, FK_PK.picked.length)));
    // Số ô nằm trên frame để luôn đọc được
    box.innerHTML = `<img src="${FR.gUrl(FKF.prev)}" alt="" style="z-index:1;">`
        + FKF.slots.map((s, i) => `<div class="fr-mslot${on.has(i) ? ' on' : ''}" style="${FR.boxCss(s, k)} z-index:2;">
            <b style="transform:rotate(${-s.rot}deg)">${i + 1}</b></div>`).join('');
}

function fkPkClose() {
    document.getElementById('fk-pk').style.display = 'none';
    FK_PK = null;
}

async function fkPkTap(b) {
    const id = b.dataset.id;
    if (FK_PK.mode === 'replace') {
        const i = FK_PK.slot;
        fkPkClose();
        try { await fkSetPhoto(i, id); } catch (e) { Swal.fire({ title: 'Chưa mở được ảnh', text: 'Thử lại giúp mình nhé.', icon: 'error', confirmButtonColor: '#111' }); }
        FK_SEL = i;
        fkRender();
        return;
    }
    const at = FK_PK.picked.indexOf(id);
    if (at >= 0) FK_PK.picked.splice(at, 1);
    else if (FK_PK.picked.length < FK_PK.targets.length) FK_PK.picked.push(id);
    else return Swal.fire({ toast: true, position: 'bottom', timer: 2000, showConfirmButton: false, icon: 'info', title: `Chỉ còn ${FK_PK.targets.length} ô trống` });
    // Dấu tick ghi số ô mà ảnh sẽ vào
    document.querySelectorAll('#fk-pk-grid .fr-pk-item[data-id]').forEach(el => {
        const j = FK_PK.picked.indexOf(el.dataset.id);
        el.classList.toggle('on', j >= 0);
        const t = el.querySelector('.fr-pk-tick');
        if (t) t.innerText = j >= 0 ? String(FK_PK.targets[j] + 1) : '';
    });
    fkMini();
    fkPkCount();
}

function fkPkCount() {
    if (!FK_PK || FK_PK.mode !== 'fill') return;
    const n = FK_PK.picked.length, max = FK_PK.targets.length;
    document.getElementById('fk-pk-count').innerText = n ? `Đã chọn ${n}/${max} ảnh` : `Chọn tối đa ${max} ảnh`;
    document.getElementById('fk-pk-ok').disabled = !n;
    // Chọn ít ảnh hơn số ô: cho lặp lại các ảnh đã chọn cho đủ ô (kiểu dải ảnh in đôi)
    const rep = document.getElementById('fk-pk-rep');
    rep.style.display = n && n < max ? '' : 'none';
    rep.innerText = `Lặp đủ ${max} ô`;
}

// Điền lần lượt 1-2-3-1-2-3... cho tới hết ô trống
function fkPkRepeat() {
    if (!FK_PK || !FK_PK.picked.length) return;
    const src = FK_PK.picked.slice();
    FK_PK.picked = FK_PK.targets.map((_, j) => src[j % src.length]);
    fkPkDone();
}

async function fkPkDone() {
    if (!FK_PK || !FK_PK.picked.length) return;
    const jobs = FK_PK.picked.map((id, j) => fkSetPhoto(FK_PK.targets[j], id).catch(() => null));
    const first = FK_PK.targets[0];
    fkPkClose();
    document.getElementById('fk-prog').innerText = 'Đang đặt ảnh...';
    await Promise.all(jobs);
    FK_SEL = first;
    fkRender();
}

// ---------- Lưu nháp ----------
// iPhone hay tải lại trang khi khách chuyển sang Zalo rồi quay lại: ghép dở là
// mất. Lưu trên máy khách theo lượt chụp và frame; chỉ lưu mã ảnh và vị trí.
let fkDraftT = 0, fkRestoring = false;
const fkDraftKey = () => 'pn_fdraft_' + _albCtx.fid + '_' + FKF.id;

function fkDraftLater() {
    if (fkRestoring) return;   // đang mở lại nháp: chưa lưu, kẻo lưu đè khung trống lên nháp
    clearTimeout(fkDraftT);
    fkDraftT = setTimeout(() => {
        if (!FKF) return;
        try {
            if (!FKP.some(Boolean)) return localStorage.removeItem(fkDraftKey());
            // Ảnh trong máy chỉ sống trong trang, tải lại là mất: ghi dấu để báo khách chọn lại
            localStorage.setItem(fkDraftKey(), JSON.stringify({ at: Date.now(), photos: FKP.map(p => p && (p.local ? { local: true } : { id: p.id, s: p.s, ox: p.ox, oy: p.oy, r: p.r })) }));
        } catch (e) { /* máy chặn lưu thì thôi */ }
    }, 400);
}

async function fkDraftRestore() {
    let d = null;
    try { d = JSON.parse(localStorage.getItem(fkDraftKey()) || 'null'); } catch (e) {}
    if (!d || !Array.isArray(d.photos) || d.photos.length !== FKF.slots.length) return;
    if (Date.now() - d.at > 7 * 24 * 3600 * 1000) return;
    const ok = new Set(fkPhotos().map(x => x.id));
    await Promise.all(d.photos.map((p, i) => p && ok.has(p.id) ? fkSetPhoto(i, p.id, { s: p.s, ox: p.ox, oy: p.oy, r: p.r }).catch(() => null) : null));
    const mat = d.photos.filter(p => p && p.local).length;
    if (FKP.some(Boolean) || mat) Swal.fire({ toast: true, position: 'bottom', timer: 3500, showConfirmButton: false, icon: 'info',
        title: 'Đã mở lại bản đang ghép dở' + (mat ? ` — ${mat} ảnh từ máy cần chọn lại` : '') });
}

// ---------- Ghép, gửi, lưu ----------
async function fkExport() {
    const empty = FKP.filter(x => !x).length;
    if (empty) {
        const r = await Swal.fire({ title: `Còn ${empty} ô chưa có ảnh`, text: 'Vẫn ghép luôn?', icon: 'question', showCancelButton: true,
                                    confirmButtonText: 'Vẫn ghép', cancelButtonText: '<span style="color:#111">Chọn thêm ảnh</span>', confirmButtonColor: '#111', cancelButtonColor: '#fff' });
        if (!r.isConfirmed) return;
    }
    const btn = document.getElementById('fk-done');
    btn.disabled = true;
    try {
        btn.innerText = 'Đang kiểm tra máy...';
        const cv = FR.canvasFor(FKF.w, FKF.h);
        if (!cv) throw new Error('Máy này không đủ bộ nhớ để ghép ảnh cỡ in.');
        const n = FKP.filter(Boolean).length;
        // Bản gốc chưa tải xong thì chờ, nút ghi rõ đã tải bao nhiêu MB để khách
        // biết web đang chạy chứ không treo
        const need = [FKF.file, ...fkFxFiles(), ...new Set(FKP.filter(p => p && !p.local).map(p => p.id))];
        need.forEach(id => fkPrefetch(id).catch(() => {}));
        // Ảnh chưa bắt đầu tải thì lấy dung lượng có sẵn trong danh sách album
        const coSan = id => +(((_alb || []).find(x => x.id === id) || {}).size || 0);
        const tick = () => {
            const os = need.map(id => FK_ORIG[id]);
            if (!os.some(o => o && !o.done)) return;
            const got = os.reduce((a, o) => a + (o ? o.got : 0), 0);
            const sizes = need.map((id, j) => (os[j] && os[j].total) || coSan(id));
            btn.innerText = sizes.every(Boolean) ? `Đang tải ảnh gốc ${fkMB(got)}/${fkMB(sizes.reduce((a, b) => a + b, 0))} MB`
                                                 : `Đang tải ảnh gốc ${fkMB(got)} MB...`;
        };
        tick();
        const iv = setInterval(tick, 300);
        const goc = {};
        try { for (const id of need) goc[id] = await fkOrigUrl(id); } finally { clearInterval(iv); }
        // Ghép từ bản gốc của frame và của từng ảnh chụp
        await FR.compose(cv.x, cv.s, FKF, l => goc[l.k === 'frame' ? FKF.file : l.file], FKP, p => p.local ? p.full : goc[p.id],
                         i => { btn.innerText = `Đang ghép ảnh ${FKP.slice(0, i + 1).filter(Boolean).length}/${n}...`; },
                         FKB && FKB.baked);
        btn.innerText = 'Đang xuất ảnh...';
        let blob = await new Promise(r => cv.c.toBlob(r, 'image/png'));
        // PNG cỡ in quá nặng với một số máy -> lùi về JPEG chất lượng tối đa
        if (!blob) blob = await new Promise(r => cv.c.toBlob(r, 'image/jpeg', 1));
        const W = cv.c.width, H = cv.c.height;
        cv.c.width = cv.c.height = 0;
        if (!blob) throw new Error('Máy không xuất được ảnh.');

        // Ảnh xem lại vẽ riêng bản nhỏ: hiện ảnh 27 triệu điểm trên màn sẽ treo máy cũ
        const pv = document.createElement('canvas');
        const ps = Math.min(1, 1400 / FKF.w);
        pv.width = Math.round(FKF.w * ps); pv.height = Math.round(FKF.h * ps);
        await FR.compose(pv.getContext('2d'), ps, FKF, l => FR.gUrl(l.k === 'frame' ? FKF.prev : l.prev), FKP, p => p.url);
        const pvBlob = await new Promise(r => pv.toBlob(r, 'image/jpeg', 0.9));
        pv.width = pv.height = 0;

        if (FK_RES) URL.revokeObjectURL(FK_RES.view);
        FK_RES = { blob, view: URL.createObjectURL(pvBlob), w: W, h: H };
        document.getElementById('fk-res-img').src = FK_RES.view;
        document.getElementById('fk-res-info').innerText = cv.s < 1
            ? `Máy bạn giới hạn bộ nhớ nên ảnh ghép cỡ ${W} × ${H} (${Math.round(cv.s * 100)}% cỡ frame), vẫn đủ nét để in.`
            : 'Bạn xem kỹ rồi hãy gửi nhé.';
        fkStep('res');
    } catch (e) {
        Swal.fire({ title: 'Chưa ghép được', text: e.message, icon: 'error', confirmButtonColor: '#111' });
    } finally {
        btn.disabled = false;
        btn.innerText = 'Ghép xong';
    }
}

async function fkSend() {
    if (!FK_RES) return;
    const ok = await Swal.fire({ title: 'Gửi ảnh ghép cho tiệm?', text: 'Tiệm sẽ in đúng ảnh này.', icon: 'question', showCancelButton: true,
                                 confirmButtonText: 'Gửi', cancelButtonText: '<span style="color:#111">Xem lại</span>', confirmButtonColor: '#111', cancelButtonColor: '#fff' });
    if (!ok.isConfirmed) return;

    const btn = document.getElementById('fk-send'), bar = document.getElementById('fk-bar');
    const size = FK_RES.blob.size;
    const set = v => { bar.firstElementChild.style.width = Math.round(v * 100) + '%'; btn.innerText = `Đang gửi ${fkMB(v * size)}/${fkMB(size)} MB`; };
    btn.disabled = true;
    bar.classList.remove('fr-hidden');
    set(0);
    const { branch, clientId, fid } = _albCtx;
    try {
        const data = (await db.ref('data/' + branch + '/' + clientId).once('value')).val() || {};
        const bName = (BRANCHES_CACHE[branch] && BRANCHES_CACHE[branch].name) || branch;
        const maKh = String(clientId).split('_')[1].slice(-4);
        const cName = String(data.name || 'Khach').replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 40) || 'Khach';
        const now = new Date();
        const hhmmss = [now.getHours(), now.getMinutes(), now.getSeconds()].map(x => String(x).padStart(2, '0')).join('');
        const duoi = FK_RES.blob.type === 'image/png' ? '.png' : '.jpg';
        const file = new File([FK_RES.blob], `${cName}_${maKh}_GHEP FRAME_${hhmmss}${duoi}`, { type: FK_RES.blob.type || 'image/png' });
        // Lưu vào thư mục lượt chụp, đúng thư mục tiệm đã trả ảnh cho khách:
        // thư mục đó vốn mở cho khách xem nên ảnh ghép hiện luôn trong album
        const batDau = Date.now();
        const sent = await guiLenDrive([file], { branch: bName, day: getDStr(now).replace(/\//g, '-'), client: `${cName} - ${maKh}`, lot: _albCtx.fid }, (i, v) => set(v * 0.95));
        const up = sent.files[0];
        if (!up || !up.id) throw new Error((up && up.err) || 'Không gửi được ảnh');
        const info = { folderUrl: sent.folderUrl };
        // Cho xem công khai để ảnh ghép hiện được trong album của khách
        if (sent.token) await FR.makePublic(up.id, sent.token).catch(() => {});
        else await gsCall({ action: 'publish', id: up.id }).catch(() => {});

        const time = now.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) + ' ' + now.toLocaleDateString('vi-VN');
        // Frame có màu: giao việc làm ảnh lẻ màu frame cho máy tính quán (trang nhân
        // viên đang mở tự làm). Điện thoại khách hay bị tắt giữa chừng nên không làm ở đây.
        const anhDrive = [...new Map(FKP.filter(p => p && !p.local).map(p => [p.id, p])).values()]
            .map(p => ({ id: p.id, name: ((_alb || []).find(x => x.id === p.id) || {}).name || 'anh.jpg' }));
        const rec = { time, drive: [{ id: up.id, name: up.name }], folder: info.folderUrl, kind: 'frame',
                      took: Math.round((Date.now() - batDau) / 1000), mb: Math.round(size / 104857.6) / 10, via: sent.via || '' };
        if (FKB && anhDrive.length) rec.le = { filter: FKB.id, ten: fkTenLoc(), lot: _albCtx.fid, photos: anhDrive };
        // Yêu cầu in: bên nhân viên hiện như ảnh khách gửi, có giờ và nút tải bản gốc
        await db.ref('data/' + branch + '/' + clientId + '/client_uploads/U_' + Date.now()).set(rec);
        // Ghi để ảnh ghép hiện trong album khách; ghi sau cùng để lỡ hỏng thì tiệm vẫn nhận được ảnh
        await fkFramedRef().set({ time, id: up.id, frame: FKF.id }).catch(() => {});
        set(1);
        try { localStorage.removeItem(fkDraftKey()); } catch (e) {}

        // Ảnh khách chọn từ máy không có trên Drive: máy quán không lấy được, làm
        // ngay trên điện thoại (thường chỉ một vài ảnh)
        const le = FKB && FKP.some(p => p && p.local) ? await fkSendSingles({ bName, now, cName, maKh }, btn, bar) : null;

        fkClose();
        await Swal.fire({ title: 'Đã gửi cho tiệm', icon: 'success', confirmButtonColor: '#111',
            text: 'Ảnh ghép đã nằm trong album của bạn, nhân viên sẽ in giúp bạn.'
                + (FKB && anhDrive.length ? ` Ảnh lẻ màu ${FKB.name} sẽ có trong album sau ít phút.` : '')
                + (le && le.err ? ` ${le.err} ảnh từ máy chưa lưu được màu ${FKB.name}.` : '') });
    } catch (e) {
        Swal.fire({ title: 'Chưa gửi được', text: e.message || 'Kiểm tra mạng rồi thử lại giúp mình nhé.', icon: 'error', confirmButtonColor: '#111' });
    } finally {
        btn.disabled = false;
        btn.innerText = 'Gửi cho tiệm in';
        bar.classList.add('fr-hidden');
    }
}

// Ảnh lẻ mang màu frame: đủ độ phân giải gốc, JPEG 95% (đổi màu thì phải lưu
// lại file mới, 95% mắt thường không phân biệt được với ảnh gốc của máy chụp).
// Tên PN-<tên bộ lọc>_<tên ảnh gốc> để album ghi "Ảnh 3 · Noir" và không lưu trùng.
// Tên màu trong tên file ảnh lẻ: PN-<tên màu>_<tên ảnh gốc>.jpg (máy quán dùng đúng tên này)
function fkTenLoc() { return String(FKB.name).replace(/[\\/:*?"<>|_]/g, ' ').trim().slice(0, 30) || 'Mau'; }

// Chỉ còn làm cho ảnh khách chọn từ máy; ảnh của lượt chụp do máy quán làm
async function fkSendSingles(w, btn, bar) {
    const seen = new Set(), list = [];
    FKP.forEach(p => { if (p && p.local && !seen.has(p.id)) { seen.add(p.id); list.push(p); } });
    const ten = fkTenLoc();
    const daCo = new Set((_alb || []).map(x => x.name));
    let ok = 0, err = 0;
    for (let k = 0; k < list.length; k++) {
        const p = list[k];
        btn.innerText = `Đang lưu ảnh lẻ ${k + 1}/${list.length}`;
        bar.firstElementChild.style.width = Math.round(k / list.length * 100) + '%';
        const goc = p.local ? ((FK_LOCAL.find(x => x.id === p.id) || {}).file || {}).name || 'anh.jpg'
                            : ((_alb || []).find(x => x.id === p.id) || {}).name || 'anh.jpg';
        const name = `PN-${ten}_${goc.replace(/\.[a-z0-9]+$/i, '')}.jpg`;
        if (daCo.has(name)) { ok++; continue; }   // lần gửi trước đã lưu rồi
        try {
            const im = await FR.loadImg(p.local ? p.full : await fkOrigUrl(p.id));
            const cv = FR.canvasFor(im.naturalWidth, im.naturalHeight);
            if (!cv) throw new Error('Máy không đủ bộ nhớ');
            cv.x.drawImage(im, 0, 0, cv.c.width, cv.c.height);
            im.src = '';
            FR.filterCanvas(cv.c, FKB.baked);
            const blob = await new Promise(r => cv.c.toBlob(r, 'image/jpeg', 0.95));
            cv.c.width = cv.c.height = 0;
            if (!blob) throw new Error('Không xuất được ảnh');
            const sent = await guiLenDrive([new File([blob], name, { type: 'image/jpeg' })],
                { branch: w.bName, day: getDStr(w.now).replace(/\//g, '-'), client: `${w.cName} - ${w.maKh}`, lot: _albCtx.fid });
            const f = sent.files[0];
            if (!f || !f.id) throw new Error((f && f.err) || 'Không gửi được');
            if (sent.token) await FR.makePublic(f.id, sent.token).catch(() => {});
            else await gsCall({ action: 'publish', id: f.id }).catch(() => {});
            daCo.add(name);
            ok++;
        } catch (e) { err++; }
    }
    bar.firstElementChild.style.width = '100%';
    return { ok, err };
}

async function fkSave() {
    if (!FK_RES) return;
    const name = 'PHOTONOIR Anh ghep frame' + (FK_RES.blob.type === 'image/png' ? '.png' : '.jpg');
    const file = new File([FK_RES.blob], name, { type: FK_RES.blob.type });
    try {
        if (laDienThoai() && navigator.canShare && navigator.canShare({ files: [file] })) return await navigator.share({ files: [file] });
    } catch (e) { if (e.name === 'AbortError') return; }
    const u = URL.createObjectURL(FK_RES.blob);
    const a = document.createElement('a');
    a.href = u; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 10000);
}

// ---------- Nút ghép ngay ở trang phiên, ngoài album ----------
// Khách tải ảnh về chỉnh xong rồi mới muốn ghép: quay lại trang là thấy nút ở chỗ
// Yêu cầu in ảnh, khỏi phải mở album. Ghép cho lượt chụp mới nhất của phiên.
async function frSessionReady(data, branch) {
    const btn = document.getElementById('fk-entry');
    if (!btn) return;
    btn.style.display = 'none';
    const links = Object.values((data && data.links) || {}).map(l => String((l && l.url) || ''));
    const last = links.reverse().map(u => (u.match(/folders\/([\w-]+)/) || [])[1]).find(Boolean);
    FK_SESSION = last ? { fid: last, branch, clientId: data.id } : null;
    if (!FK_SESSION) return;
    await fkLoadFrames();
    if (fkFramesFor(branch).length) btn.style.display = '';
}

async function frOpenSession() {
    if (!FK_SESSION) return;
    const btn = document.getElementById('fk-entry');
    const old = btn.innerText;
    btn.disabled = true;
    btn.innerText = 'ĐANG MỞ...';
    try {
        window._albCtx = { fid: FK_SESSION.fid, branch: FK_SESSION.branch, clientId: FK_SESSION.clientId, url: '' };
        _alb = (await gsCall({ action: 'album', folder: FK_SESSION.fid })).images || [];
        _albBranch = FK_SESSION.branch;
        await frOpen();
    } catch (e) {
        Swal.fire({ title: 'Chưa mở được', text: 'Kiểm tra mạng rồi thử lại giúp mình nhé.', icon: 'error', confirmButtonColor: '#111' });
    } finally {
        btn.disabled = false;
        btn.innerText = old;
    }
}

// ---------- Ảnh ghép trong album khách ----------
// Dòng "Ảnh ghép frame" cho mỗi lượt đã gửi, bấm là xem lớn và lưu về máy
function frRows(d, branch) {
    const items = [];
    Object.values((d && d.framed) || {}).forEach(v => {
        if (!v) return;
        if (typeof v.id === 'string') items.push(v);   // kiểu cũ: một lượt một bản
        else Object.values(v).forEach(x => { if (x && typeof x.id === 'string') items.push(x); });
    });
    return items.map(x => `
        <div class="link-row"><span style="font-size:12px; color:#666; font-weight:600;">Ảnh ghép frame${x.time ? ' · ' + fkEsc(String(x.time).split(' ')[0]) : ''}</span>
        <button type="button" class="view-btn" onclick="frView('${fkEsc(x.id)}', '${fkEsc(branch)}')">Xem &amp; lưu ảnh</button></div>`).join('');
}

function frView(id, branch) {
    _alb = [{ id, name: 'ghep.png', size: 0 }];
    _albLabels = ['Anh ghep frame'];
    _albBranch = branch || '';
    albZoom(0);
}

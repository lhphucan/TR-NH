// ===== Trang quản lý: dựng frame cho khách ghép ảnh =====
// Dùng chung với admin.js: db, driveToken(), branchesCache, userRole, Toast, Swal.
// Frame lưu hai nơi: file PNG trên Drive (thư mục "PHOTONOIR - Frame", để ai có
// link cũng xem được vì trang khách không đăng nhập Google), thông tin ô và
// cơ sở dùng trên Firebase frames/<id>.

const FRAME_FOLDER = 'PHOTONOIR - Frame';

let FA_LIST = {};     // frames trên Firebase
let FA = null;        // frame đang sửa
let FA_SEL = -1;      // ô đang chọn

function faEsc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

async function openFrameManager() {
    if (userRole !== 'admin') return Toast.fire({ icon: 'error', title: 'Chỉ admin được dựng frame' });
    let m = document.getElementById('fa-modal');
    if (!m) {
        document.body.insertAdjacentHTML('beforeend', `
        <div id="fa-modal" class="fr-modal">
            <div class="fr-head">
                <h3>Frame cho khách ghép ảnh</h3>
                <button class="fr-x" onclick="closeFrameManager()" aria-label="Đóng">&times;</button>
            </div>
            <div class="fr-body"><div class="fr-wrap">
                <div class="fr-card">
                    <h4>Frame đã có</h4>
                    <div id="fa-list" class="fr-flist"></div>
                    <div class="fr-row" style="margin-top:12px;">
                        <label class="fr-btn solid" for="fa-file">+ Thêm frame PNG</label>
                        <input type="file" id="fa-file" accept=".png,image/png" class="fr-hidden" onchange="faUpload(this)">
                    </div>
                    <p class="fr-hint">Xuất frame từ Canva dạng PNG, bật <b>Nền trong suốt</b>, các lỗ đặt ảnh để trống. Up lên là trang tự tìm lỗ và tạo sẵn ô.</p>
                </div>

                <div class="fr-card fr-hidden" id="fa-edit">
                    <h4>Dựng ô ảnh</h4>
                    <div class="fr-row" style="margin-bottom:10px; align-items:flex-end;">
                        <div style="flex:1; min-width:180px;">
                            <label class="fr-label">Tên frame</label>
                            <input type="text" id="fa-name">
                        </div>
                        <div>
                            <label class="fr-label">Frame nằm</label>
                            <div class="fr-row">
                                <button class="fr-btn" id="fa-front" onclick="faSetFront(true)">Trên ảnh</button>
                                <button class="fr-btn" id="fa-back" onclick="faSetFront(false)">Dưới ảnh</button>
                            </div>
                        </div>
                        <div>
                            <label class="fr-label">Cho khách dùng</label>
                            <div class="fr-row">
                                <button class="fr-btn" id="fa-on" onclick="faSetOn(true)">Đang dùng</button>
                                <button class="fr-btn" id="fa-off" onclick="faSetOn(false)">Ẩn</button>
                            </div>
                        </div>
                    </div>
                    <label class="fr-label">Cơ sở dùng frame này</label>
                    <div class="fr-row" id="fa-branches" style="margin-bottom:10px;"></div>
                    <p class="fr-hint" style="margin:0 0 10px;">
                        <b>Trên ảnh</b>: frame đục lỗ đè lên, viền che mép ảnh. <b>Dưới ảnh</b>: frame làm nền, ảnh đè lên.
                        Vùng sọc xám là chỗ ảnh khách sẽ nằm.<br>
                        Kéo trên chỗ trống để vẽ ô mới. Kéo ô để dời. Chấm ở góc đổi cả rộng lẫn cao, chấm ở cạnh chỉ kéo một chiều, chấm xanh phía dưới để xoay.
                    </p>
                    <div id="fa-stage" class="fr-stage"><div id="fa-fill"></div><img class="fr-frame" id="fa-img" alt=""><div id="fa-slots"></div></div>

                    <div id="fa-slotpanel" class="fr-tool">
                        <div class="fr-grid5">
                            <div><label class="fr-label">Trái</label><input type="number" id="fa-sx" oninput="faSlotInput()"></div>
                            <div><label class="fr-label">Trên</label><input type="number" id="fa-sy" oninput="faSlotInput()"></div>
                            <div><label class="fr-label">Rộng</label><input type="number" id="fa-sw" oninput="faSlotInput()"></div>
                            <div><label class="fr-label">Cao</label><input type="number" id="fa-sh" oninput="faSlotInput()"></div>
                            <div><label class="fr-label">Góc (°)</label><input type="number" id="fa-sr" oninput="faSlotInput()"></div>
                        </div>
                        <div class="fr-row" style="margin-top:10px;">
                            <button class="fr-btn" onclick="faSlotOp('rot90')">Xoay 90°</button>
                            <button class="fr-btn" onclick="faSlotOp('swap')">Đổi dọc / ngang</button>
                            <button class="fr-btn" onclick="faSlotOp('dup')">Nhân bản ô</button>
                            <button class="fr-btn danger" onclick="faSlotOp('del')">Xoá ô</button>
                        </div>
                    </div>

                    <div class="fr-row" style="margin-top:14px;">
                        <span id="fa-count" class="fr-hint" style="margin:0; flex:1;"></span>
                        <button class="fr-btn" onclick="faRedetect()">Tự nhận lại lỗ</button>
                        <button class="fr-btn danger" onclick="faDelete()">Xoá frame</button>
                        <button class="fr-btn solid" id="fa-save" onclick="faSave()">Lưu frame</button>
                    </div>
                    <div class="fr-bar fr-hidden" id="fa-bar"><span></span></div>
                </div>
            </div></div>
        </div>`);
        faBindStage();
        window.addEventListener('resize', () => { if (FA && document.getElementById('fa-modal').style.display !== 'none') faRender(); });
        m = document.getElementById('fa-modal');
    }
    m.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    await faLoad();
}

function closeFrameManager() {
    document.getElementById('fa-modal').style.display = 'none';
    document.body.style.overflow = '';
}

async function faLoad() {
    const box = document.getElementById('fa-list');
    box.innerHTML = '<p class="fr-hint">Đang tải...</p>';
    try { FA_LIST = (await db.ref('frames').once('value')).val() || {}; }
    catch (e) { box.innerHTML = '<p class="fr-hint">Không đọc được danh sách frame. Kiểm tra đã dán luật Firebase mới chưa.</p>'; return; }
    faRenderList();
}

function faRenderList() {
    const ids = Object.keys(FA_LIST).sort((a, b) => b.localeCompare(a));
    const box = document.getElementById('fa-list');
    box.innerHTML = ids.map(id => {
        const f = FA_LIST[id];
        const cs = Object.keys(f.branches || {}).filter(b => f.branches[b]).map(b => (branchesCache[b] && branchesCache[b].name) || b);
        return `<div class="fr-fwrap">
            <button class="fr-fitem${f.on === false ? ' off' : ''}" onclick="faOpen('${faEsc(id)}')">
                <span class="fr-fimg"><img src="${FR.gUrl(f.prev)}" alt="" loading="lazy"></span>
                <b>${faEsc(f.name)}</b>
                <span class="fr-meta">${(f.slots || []).length} ô · ${f.on === false ? 'đang ẩn' : 'đang dùng'}</span>
                <span class="fr-meta">${cs.length ? faEsc(cs.join(', ')) : 'chưa chọn cơ sở'}</span>
            </button>
            <button class="fr-fdel" onclick="faDelete('${faEsc(id)}')" aria-label="Xoá frame">✕</button>
        </div>`;
    }).join('') || '<p class="fr-hint">Chưa có frame nào.</p>';
}

// Up frame mới: chưa lên Drive ngay, chỉ lên khi bấm Lưu
async function faUpload(inp) {
    const file = inp.files[0];
    inp.value = '';
    if (!file) return;
    try {
        const p = await FR.shrink(file, 1600, 'image/png');
        const branches = {};
        Object.keys(branchesCache).forEach(b => { branches[b] = true; });
        FA = { id: 'F_' + Date.now(), isNew: true, name: file.name.replace(/\.png$/i, ''), w: p.nw, h: p.nh,
               front: true, on: true, branches, slots: [], blob: file, prevBlob: p.blob };
        FA.slots = await FR.detectHoles(FA.prevBlob, FA.w, FA.h);
        FA_SEL = -1;
        faShow(URL.createObjectURL(FA.prevBlob));
        Toast.fire({ icon: 'success', title: FA.slots.length ? `Tìm thấy ${FA.slots.length} lỗ, đã tạo sẵn ô` : 'Không thấy lỗ trong suốt, kéo trên frame để vẽ ô' });
    } catch (e) { Swal.fire({ title: 'Không đọc được file frame', text: e.message, icon: 'error', confirmButtonColor: '#111' }); }
}

function faOpen(id) {
    const f = FA_LIST[id];
    if (!f) return;
    FA = JSON.parse(JSON.stringify(Object.assign({ branches: {}, slots: [] }, f)));
    FA.id = id;
    FA.on = f.on !== false;
    FA_SEL = -1;
    faShow(FR.gUrl(f.prev));
}

function faShow(src) {
    document.getElementById('fa-edit').classList.remove('fr-hidden');
    document.getElementById('fa-name').value = FA.name;
    document.getElementById('fa-img').src = src;
    document.getElementById('fa-branches').innerHTML = Object.keys(branchesCache).map(b => `
        <label class="fr-check"><input type="checkbox" data-b="${faEsc(b)}" ${FA.branches[b] ? 'checked' : ''}
               onchange="FA.branches[this.dataset.b] = this.checked"> ${faEsc(branchesCache[b].name || b)}</label>`).join('');
    faSetOn(FA.on !== false);
    faSetFront(FA.front !== false);
    document.getElementById('fa-edit').scrollIntoView({ behavior: 'smooth' });
}

function faSetFront(v) {
    FA.front = v;
    document.getElementById('fa-front').classList.toggle('solid', v);
    document.getElementById('fa-back').classList.toggle('solid', !v);
    faRender();
}

// Ẩn thay vì xoá: frame theo mùa, hết đợt thì ẩn, đợt sau bật lại
function faSetOn(v) {
    FA.on = v;
    document.getElementById('fa-on').classList.toggle('solid', v);
    document.getElementById('fa-off').classList.toggle('solid', !v);
}

function faK() {
    const st = document.getElementById('fa-stage');
    st.style.height = (st.clientWidth * FA.h / FA.w) + 'px';
    return st.clientWidth / FA.w;
}

// 8 chấm kéo như Canva: hx, hy là phía của chấm (-1 trái/trên, 1 phải/dưới,
// 0 là không đổi chiều đó). Góc đổi cả hai chiều, cạnh chỉ đổi một chiều.
const FA_HANDLES = [
    ['nw', -1, -1, '0%', '0%', 'nwse'], ['n', 0, -1, '50%', '0%', 'ns'], ['ne', 1, -1, '100%', '0%', 'nesw'],
    ['e', 1, 0, '100%', '50%', 'ew'], ['se', 1, 1, '100%', '100%', 'nwse'], ['s', 0, 1, '50%', '100%', 'ns'],
    ['sw', -1, 1, '0%', '100%', 'nesw'], ['w', -1, 0, '0%', '50%', 'ew']
];

function faRender() {
    if (!FA) return;
    const k = faK();
    // Ảnh giả: frame trên ảnh thì nó nằm dưới frame, frame dưới ảnh thì nằm trên
    const fill = document.getElementById('fa-fill');
    fill.style.cssText = `position:absolute; inset:0; z-index:${FA.front ? 1 : 3};`;
    fill.innerHTML = FA.slots.map(s => `<div class="fr-efill" style="${FR.boxCss(s, k)}"></div>`).join('');
    document.getElementById('fa-img').style.zIndex = 2;
    const ctl = document.getElementById('fa-slots');
    ctl.style.cssText = 'position:absolute; inset:0; z-index:4;';

    const handles = FA_HANDLES.map(([n, hx, hy, l, t, c]) =>
        `<span class="fr-h ${n}${hx && hy ? '' : ' side'}" data-act="rs" data-hx="${hx}" data-hy="${hy}" style="left:${l}; top:${t}; cursor:${c}-resize;"></span>`).join('')
        + '<span class="fr-h rt" data-act="rt" style="left:50%; top:calc(100% + 28px);"></span>';
    ctl.innerHTML = FA.slots.map((s, i) => `
        <div class="fr-eslot${i === FA_SEL ? ' sel' : ''}" data-i="${i}" style="${FR.boxCss(s, k)}">
            <span class="fr-num">${i + 1}</span>
            ${i === FA_SEL ? handles : ''}
        </div>`).join('');
    document.getElementById('fa-count').innerText = FA.slots.length + ' ô ảnh';
    const pn = document.getElementById('fa-slotpanel');
    pn.classList.toggle('on', FA_SEL >= 0);
    if (FA_SEL >= 0) {
        const s = FA.slots[FA_SEL];
        const put = (id, v) => { const el = document.getElementById(id); if (el !== document.activeElement) el.value = Math.round(v); };
        put('fa-sx', s.cx - s.w / 2); put('fa-sy', s.cy - s.h / 2); put('fa-sw', s.w); put('fa-sh', s.h); put('fa-sr', s.rot);
    }
}

function faSlotInput() {
    if (FA_SEL < 0) return;
    const s = FA.slots[FA_SEL];
    const n = id => parseFloat(document.getElementById(id).value);
    const w = n('fa-sw'), h = n('fa-sh'), x = n('fa-sx'), y = n('fa-sy'), r = n('fa-sr');
    if (w > 10) s.w = w;
    if (h > 10) s.h = h;
    if (!isNaN(x)) s.cx = x + s.w / 2;
    if (!isNaN(y)) s.cy = y + s.h / 2;
    if (!isNaN(r)) s.rot = ((r % 360) + 360) % 360;
    faRender();
}

function faSlotOp(op) {
    if (FA_SEL < 0) return;
    const s = FA.slots[FA_SEL];
    if (op === 'rot90') s.rot = (s.rot + 90) % 360;
    if (op === 'swap') { const t = s.w; s.w = s.h; s.h = t; }
    if (op === 'dup') { FA.slots.push(Object.assign({}, s, { cx: s.cx + FA.w * 0.03, cy: s.cy + FA.h * 0.03 })); FA_SEL = FA.slots.length - 1; }
    if (op === 'del') { FA.slots.splice(FA_SEL, 1); FA_SEL = -1; }
    faRender();
}

// Kéo trên khung: vẽ ô mới, dời ô, đổi cỡ, xoay
function faBindStage() {
    const st = document.getElementById('fa-stage');
    let act = null;
    const pt = e => { const r = st.getBoundingClientRect(), k = st.clientWidth / FA.w;
                      return { x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k, k }; };

    st.addEventListener('pointerdown', e => {
        if (!FA) return;
        const p = pt(e);
        const h = e.target.closest('[data-act]');
        const sl = e.target.closest('.fr-eslot');
        if (h && FA_SEL >= 0) {
            // Nhớ trạng thái lúc bắt đầu kéo: tính từ đó cho khỏi trôi dần
            const s = FA.slots[FA_SEL];
            act = { kind: h.dataset.act, hx: +h.dataset.hx || 0, hy: +h.dataset.hy || 0, cx: s.cx, cy: s.cy, w: s.w, h: s.h, px: p.x, py: p.y };
        } else if (sl) {
            FA_SEL = +sl.dataset.i;
            const s = FA.slots[FA_SEL];
            act = { kind: 'mv', px: p.x, py: p.y, cx: s.cx, cy: s.cy };
        } else act = { kind: 'new', x0: p.x, y0: p.y, made: false };
        st.setPointerCapture(e.pointerId);
        faRender();
    });

    st.addEventListener('pointermove', e => {
        if (!act) return;
        const p = pt(e);
        const min = 30 / p.k;   // không cho ô nhỏ hơn khoảng 30 điểm trên màn
        if (act.kind === 'new') {
            const w = Math.abs(p.x - act.x0), h = Math.abs(p.y - act.y0);
            if (!act.made) {
                if (w < min && h < min) return;
                FA.slots.push({ cx: 0, cy: 0, w: 1, h: 1, rot: 0 });
                FA_SEL = FA.slots.length - 1;
                act.made = true;
            }
            const s = FA.slots[FA_SEL];
            s.w = Math.max(min, w); s.h = Math.max(min, h);
            s.cx = Math.min(p.x, act.x0) + s.w / 2; s.cy = Math.min(p.y, act.y0) + s.h / 2;
        } else {
            const s = FA.slots[FA_SEL];
            if (!s) return;
            if (act.kind === 'mv') {
                s.cx = act.cx + (p.x - act.px);
                s.cy = act.cy + (p.y - act.py);
            } else if (act.kind === 'rs') {
                // Như Canva: cạnh đối diện đứng yên. Tính theo quãng tay đã kéo,
                // đổi sang trục của chính ô vì ô có thể đang xoay.
                const a = s.rot * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
                const dx = p.x - act.px, dy = p.y - act.py;
                const lx = dx * cos + dy * sin, ly = -dx * sin + dy * cos;
                const w = act.hx ? Math.max(min, act.w + act.hx * lx) : act.w;
                const h = act.hy ? Math.max(min, act.h + act.hy * ly) : act.h;
                const mx = act.hx * (w - act.w) / 2, my = act.hy * (h - act.h) / 2;
                s.w = w; s.h = h;
                s.cx = act.cx + mx * cos - my * sin;
                s.cy = act.cy + mx * sin + my * cos;
            } else if (act.kind === 'rt') {
                // Chấm xoay nằm dưới ô; hít vào góc vuông khi lệch dưới 4 độ
                let d = Math.atan2(p.y - s.cy, p.x - s.cx) * 180 / Math.PI - 90;
                d = ((d % 360) + 360) % 360;
                for (const q of [0, 90, 180, 270, 360]) if (Math.abs(d - q) < 4) d = q % 360;
                s.rot = Math.round(d);
            }
        }
        faRender();
    });

    const end = () => { act = null; };
    st.addEventListener('pointerup', end);
    st.addEventListener('pointercancel', end);
}

async function faRedetect() {
    if (!FA) return;
    if (FA.slots.length) {
        const r = await Swal.fire({ title: 'Tìm lại lỗ?', text: 'Các ô đang có sẽ bị thay hết.', icon: 'question', showCancelButton: true,
                                    confirmButtonText: 'Tìm lại', cancelButtonText: '<span style="color:#111">Huỷ</span>', confirmButtonColor: '#111', cancelButtonColor: '#fff' });
        if (!r.isConfirmed) return;
    }
    try {
        // Frame đã lưu thì lấy bản xem trước trên Drive để dò
        const blob = FA.prevBlob || await (await fetch(FR.gUrl(FA.prev))).blob();
        FA.slots = await FR.detectHoles(blob, FA.w, FA.h);
        FA_SEL = -1;
        faRender();
        Toast.fire({ icon: 'success', title: `Tìm thấy ${FA.slots.length} lỗ` });
    } catch (e) { Toast.fire({ icon: 'error', title: 'Không dò được: ' + e.message }); }
}

// Thư mục chứa frame trên Drive, chưa có thì tạo
async function faFolder(token) {
    const q = `name='${FRAME_FOLDER}' and mimeType='application/vnd.google-apps.folder' and 'root' in parents and trashed=false`;
    const r = await fetch('https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent(q) + '&fields=files(id)',
                          { headers: { Authorization: 'Bearer ' + token } });
    if (!r.ok) throw new Error('Drive từ chối (HTTP ' + r.status + ')');
    const f = (await r.json()).files || [];
    if (f.length) return f[0].id;
    const c = await fetch('https://www.googleapis.com/drive/v3/files?fields=id', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: FRAME_FOLDER, mimeType: 'application/vnd.google-apps.folder', parents: ['root'] })
    });
    if (!c.ok) throw new Error('Không tạo được thư mục frame (HTTP ' + c.status + ')');
    return (await c.json()).id;
}

async function faSave() {
    if (!FA) return;
    FA.name = document.getElementById('fa-name').value.trim() || 'Frame';
    if (!FA.slots.length) return Toast.fire({ icon: 'warning', title: 'Frame chưa có ô ảnh nào' });
    if (!Object.values(FA.branches).some(Boolean)) return Toast.fire({ icon: 'warning', title: 'Chọn ít nhất một cơ sở dùng frame' });

    const btn = document.getElementById('fa-save'), bar = document.getElementById('fa-bar');
    btn.disabled = true;
    const rec = {
        name: FA.name.slice(0, 60), w: FA.w, h: FA.h, front: !!FA.front, on: FA.on !== false, branches: FA.branches,
        slots: FA.slots.map(s => ({ cx: Math.round(s.cx), cy: Math.round(s.cy), w: Math.round(s.w), h: Math.round(s.h), rot: +s.rot || 0 })),
        file: FA.file || '', prev: FA.prev || '', at: Date.now()
    };
    try {
        if (FA.isNew) {
            // Frame mới: đưa PNG gốc và bản xem trước lên Drive trước, rồi mới ghi Firebase
            btn.innerText = 'ĐANG TẢI FRAME LÊN...';
            bar.classList.remove('fr-hidden');
            const set = v => { bar.firstElementChild.style.width = Math.round(v * 100) + '%'; };
            const token = await driveToken();
            const folder = await faFolder(token);
            const ten = rec.name.replace(/[\\/:*?"<>|]/g, '_');
            const full = await FR.upload(FA.blob, ten + '.png', token, folder, v => set(v * 0.9));
            const prev = await FR.upload(FA.prevBlob, ten + ' (xem truoc).png', token, folder, v => set(0.9 + v * 0.1));
            await FR.makePublic(full.id, token);
            await FR.makePublic(prev.id, token);
            rec.file = full.id; rec.prev = prev.id;
        }
        await db.ref('frames/' + FA.id).set(rec);
        FA.isNew = false; FA.file = rec.file; FA.prev = rec.prev;
        delete FA.blob;
        Toast.fire({ icon: 'success', title: `Đã lưu frame "${rec.name}"` });
        await faLoad();
    } catch (e) {
        Swal.fire({ title: 'Chưa lưu được', text: e.message + (/PERMISSION|permission/.test(e.message) ? ' — kiểm tra đã dán luật Firebase mới chưa.' : ''), icon: 'error', confirmButtonColor: '#111' });
    } finally {
        btn.disabled = false;
        btn.innerText = 'Lưu frame';
        bar.classList.add('fr-hidden');
        bar.firstElementChild.style.width = '0';
    }
}

async function faDelete(id) {
    id = id || (FA && FA.id);
    if (!id) return;
    const f = FA_LIST[id] || (FA && FA.id === id ? FA : null);
    const r = await Swal.fire({ title: 'Xoá frame?', text: `"${f ? f.name : ''}" sẽ mất hẳn. Muốn tạm cất thì chọn Ẩn thay vì xoá.`, icon: 'warning',
                                showCancelButton: true, confirmButtonText: 'Xoá', cancelButtonText: '<span style="color:#111">Huỷ</span>', confirmButtonColor: '#dc2626', cancelButtonColor: '#fff' });
    if (!r.isConfirmed) return;
    try {
        if (FA_LIST[id]) await db.ref('frames/' + id).remove();
        // Bỏ file trên Drive vào thùng rác (lấy lại được trong 30 ngày)
        if (f && (f.file || f.prev)) {
            const token = await driveToken().catch(() => '');
            for (const fid of [f.file, f.prev].filter(Boolean)) {
                fetch('https://www.googleapis.com/drive/v3/files/' + fid, {
                    method: 'PATCH', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true })
                }).catch(() => {});
            }
        }
        if (FA && FA.id === id) { FA = null; document.getElementById('fa-edit').classList.add('fr-hidden'); }
        Toast.fire({ icon: 'success', title: 'Đã xoá frame' });
        await faLoad();
    } catch (e) { Swal.fire({ title: 'Chưa xoá được', text: e.message, icon: 'error', confirmButtonColor: '#111' }); }
}

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
                            <label class="fr-label">Màu ảnh khách</label>
                            <div class="fr-row">
                                <select id="fa-filter" class="fr-select" onchange="FA.filter = this.value"></select>
                                <button class="fr-btn" onclick="ftOpen()">Bộ lọc…</button>
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
                    <div class="fr-row">
                        <button class="fr-btn" id="fa-all" onclick="faSetAll(true)">Mọi cơ sở</button>
                        <button class="fr-btn" id="fa-some" onclick="faSetAll(false)">Chọn cơ sở</button>
                    </div>
                    <div class="fr-row" id="fa-branches" style="margin-top:8px;"></div>
                    <p class="fr-hint" id="fa-all-hint" style="margin:6px 0 10px;"></p>
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
    try {
        FA_LIST = (await db.ref('frames').once('value')).val() || {};
        FT_LIST = (await db.ref('config/filters').once('value')).val() || {};
    }
    catch (e) { box.innerHTML = '<p class="fr-hint">Không đọc được danh sách frame. Kiểm tra đã dán luật Firebase mới chưa.</p>'; return; }
    faRenderList();
}

function faRenderList() {
    const ids = Object.keys(FA_LIST).sort((a, b) => b.localeCompare(a));
    const box = document.getElementById('fa-list');
    box.innerHTML = ids.map(id => {
        const f = FA_LIST[id];
        const cs = f.all ? ['Mọi cơ sở'] : Object.keys(f.branches || {}).filter(b => f.branches[b]).map(b => (branchesCache[b] && branchesCache[b].name) || b);
        return `<div class="fr-fwrap">
            <button class="fr-fitem${f.on === false ? ' off' : ''}" onclick="faOpen('${faEsc(id)}')">
                <span class="fr-fimg"><img src="${FR.gUrl(f.prev)}" alt="" loading="lazy"></span>
                <b>${faEsc(f.name)}</b>
                <span class="fr-meta">${(f.slots || []).length} ô · ${f.on === false ? 'đang ẩn' : 'đang dùng'}${f.filter && FT_LIST[f.filter] ? ' · ' + faEsc(FT_LIST[f.filter].name) : ''}</span>
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
        FA = { id: 'F_' + Date.now(), isNew: true, name: file.name.replace(/\.png$/i, ''), w: p.nw, h: p.nh,
               front: true, on: true, all: true, branches: {}, slots: [], blob: file, prevBlob: p.blob };
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
    FA.all = f.all === true;
    FA_SEL = -1;
    faShow(FR.gUrl(f.prev));
}

function faShow(src) {
    document.getElementById('fa-edit').classList.remove('fr-hidden');
    document.getElementById('fa-name').value = FA.name;
    document.getElementById('fa-img').src = src;
    faSetAll(FA.all !== false);
    faSetOn(FA.on !== false);
    faSetFront(FA.front !== false);
    faFilterSelect();
    document.getElementById('fa-edit').scrollIntoView({ behavior: 'smooth' });
}

// Danh sách bộ lọc trong ô "Màu ảnh khách"
function faFilterSelect() {
    const sel = document.getElementById('fa-filter');
    if (!sel || !FA) return;
    const ids = Object.keys(FT_LIST).sort((a, b) => String(FT_LIST[a].name).localeCompare(String(FT_LIST[b].name)));
    if (FA.filter && !FT_LIST[FA.filter]) FA.filter = '';   // bộ lọc đã bị xoá
    sel.innerHTML = '<option value="">Màu gốc</option>' + ids.map(id => `<option value="${faEsc(id)}">${faEsc(FT_LIST[id].name)}</option>`).join('');
    sel.value = FA.filter || '';
}

function faSetFront(v) {
    FA.front = v;
    document.getElementById('fa-front').classList.toggle('solid', v);
    document.getElementById('fa-back').classList.toggle('solid', !v);
    faRender();
}

// Mặc định mọi cơ sở, kể cả cơ sở mở sau này: khỏi phải nhớ quay lại tích thêm.
// Chỉ khi cần giới hạn mới chọn cơ sở, chạm tên để bật/tắt.
function faSetAll(v) {
    FA.all = v;
    document.getElementById('fa-all').classList.toggle('solid', v);
    document.getElementById('fa-some').classList.toggle('solid', !v);
    const box = document.getElementById('fa-branches');
    box.classList.toggle('fr-hidden', v);
    box.innerHTML = Object.keys(branchesCache).map(b => `
        <button type="button" class="fr-btn fr-chip${FA.branches[b] ? ' on' : ''}" data-b="${faEsc(b)}"
                onclick="faToggleBranch(this)">${faEsc(branchesCache[b].name || b)}</button>`).join('');
    document.getElementById('fa-all-hint').innerText = v
        ? 'Khách ở mọi cơ sở đều thấy frame này, kể cả cơ sở mở sau.'
        : 'Chạm tên cơ sở để bật hoặc tắt.';
}

function faToggleBranch(el) {
    const b = el.dataset.b;
    FA.branches[b] = !FA.branches[b];
    el.classList.toggle('on', !!FA.branches[b]);
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
    if (!FA.all && !Object.values(FA.branches).some(Boolean)) return Toast.fire({ icon: 'warning', title: 'Chọn ít nhất một cơ sở dùng frame' });
    // Chỉ giữ cơ sở đang bật cho gọn dữ liệu
    const branches = {};
    if (!FA.all) Object.keys(FA.branches).forEach(b => { if (FA.branches[b]) branches[b] = true; });

    const btn = document.getElementById('fa-save'), bar = document.getElementById('fa-bar');
    btn.disabled = true;
    const rec = {
        name: FA.name.slice(0, 60), w: FA.w, h: FA.h, front: !!FA.front, on: FA.on !== false, all: FA.all !== false, branches,
        slots: FA.slots.map(s => ({ cx: Math.round(s.cx), cy: Math.round(s.cy), w: Math.round(s.w), h: Math.round(s.h), rot: +s.rot || 0 })),
        file: FA.file || '', prev: FA.prev || '', filter: FA.filter || '', at: Date.now()
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


// ===== Thư viện bộ lọc màu =====
// config/filters/<mã> = { name, adj: { b, c, s, w, f }, lut: mã ảnh Hald trên Drive, at }
// Frame chọn một bộ lọc: ảnh khách trong frame và ảnh lẻ khách nhận đều mang màu đó.
let FT_LIST = {};
let FT = null;          // bộ lọc đang sửa
let FT_LUT = null;      // LUT vừa tải lên, chưa lưu: { lut, blob }
let FT_LUTCUR = null;   // LUT đang dùng của bộ lọc đang sửa (đã đọc)
let FT_SAMPLE = null;   // ảnh mẫu để xem trước
let ftT = 0;
const FT_SLIDERS = [['b', 'Sáng', -100, 100], ['c', 'Tương phản', -100, 100], ['s', 'Bão hoà (−100 = đen trắng)', -100, 100], ['w', 'Ấm / lạnh', -100, 100], ['f', 'Phai', 0, 100]];

function ftOpen() {
    let m = document.getElementById('ft-modal');
    if (!m) {
        document.body.insertAdjacentHTML('beforeend', `
        <div id="ft-modal" class="fr-modal" style="z-index:4100;">
            <div class="fr-head">
                <h3>Bộ lọc màu</h3>
                <button class="fr-x" onclick="ftClose()" aria-label="Đóng">&times;</button>
            </div>
            <div class="fr-body"><div class="fr-wrap">
                <div class="fr-card">
                    <div class="fr-row" id="ft-list"></div>
                    <div class="fr-row" style="margin-top:10px;"><button class="fr-btn solid" onclick="ftNew()">+ Bộ lọc mới</button></div>
                </div>
                <div class="fr-card fr-hidden" id="ft-edit">
                    <label class="fr-label">Tên bộ lọc</label>
                    <input type="text" id="ft-name" placeholder="Ví dụ: Noir">
                    <div class="ft-prev">
                        <div><span class="fr-label">Gốc</span><canvas id="ft-a"></canvas></div>
                        <div><span class="fr-label">Sau khi lọc</span><canvas id="ft-b"></canvas></div>
                    </div>
                    <div class="fr-row" style="margin:6px 0 12px;">
                        <label class="fr-btn" for="ft-sample">Đổi ảnh mẫu</label>
                        <input type="file" id="ft-sample" accept="image/*" class="fr-hidden" onchange="ftSample(this)">
                    </div>
                    <div id="ft-sliders"></div>
                    <h4 style="margin-top:16px;">LUT (bảng màu)</h4>
                    <p class="fr-hint" id="ft-lut-st"></p>
                    <div class="fr-row">
                        <button class="fr-btn" onclick="ftHaldDownload()">Tải ảnh mẫu LUT</button>
                        <label class="fr-btn" for="ft-lut">Tải LUT lên</label>
                        <input type="file" id="ft-lut" accept=".png,.cube,image/png" class="fr-hidden" onchange="ftLutUpload(this)">
                        <button class="fr-btn danger" id="ft-lut-del" onclick="ftLutClear()">Bỏ LUT</button>
                    </div>
                    <p class="fr-hint">
                        <b>Lấy đúng màu bộ lọc Canva:</b> bấm <b>Tải ảnh mẫu LUT</b> → trên Canva tạo thiết kế <b>đúng 512 × 512 px</b>,
                        thả ảnh mẫu phủ kín → áp đúng bộ lọc và các thanh chỉnh hay dùng → tải về <b>PNG</b> → bấm <b>Tải LUT lên</b>.
                        Chỉ lấy được phần đổi màu; tối góc, hạt, làm nét thì không.<br>
                        Cũng nhận file <b>.cube</b> (LUT của Lightroom/Photoshop). Thanh chỉnh ở trên áp trước, LUT áp sau.
                    </p>
                    <div class="fr-row" style="margin-top:14px;">
                        <span style="flex:1;"></span>
                        <button class="fr-btn danger" onclick="ftDelete()">Xoá bộ lọc</button>
                        <button class="fr-btn solid" id="ft-save" onclick="ftSave()">Lưu bộ lọc</button>
                    </div>
                </div>
            </div></div>
        </div>`);
        m = document.getElementById('ft-modal');
    }
    m.style.display = 'flex';
    ftRenderList();
}

function ftClose() {
    document.getElementById('ft-modal').style.display = 'none';
    faFilterSelect();
    if (FA_LIST && document.getElementById('fa-list')) faRenderList();
}

function ftRenderList() {
    const ids = Object.keys(FT_LIST).sort((a, b) => String(FT_LIST[a].name).localeCompare(String(FT_LIST[b].name)));
    document.getElementById('ft-list').innerHTML = ids.map(id => `
        <button type="button" class="fr-btn fr-chip${FT && FT.id === id ? ' on' : ''}" onclick="ftOpenOne('${faEsc(id)}')">${faEsc(FT_LIST[id].name)}${FT_LIST[id].lut ? ' · LUT' : ''}</button>`).join('')
        || '<p class="fr-hint" style="margin:0;">Chưa có bộ lọc nào.</p>';
}

function ftNew() {
    FT = { id: 'L_' + Date.now(), isNew: true, name: '', adj: { b: 0, c: 0, s: 0, w: 0, f: 0 }, lut: '' };
    FT_LUT = null; FT_LUTCUR = null;
    ftShow();
}

async function ftOpenOne(id) {
    const r = FT_LIST[id];
    if (!r) return;
    FT = { id, name: r.name || '', adj: Object.assign({ b: 0, c: 0, s: 0, w: 0, f: 0 }, r.adj || {}), lut: r.lut || '' };
    FT_LUT = null; FT_LUTCUR = null;
    ftShow();
    if (FT.lut) {
        try { FT_LUTCUR = FR.lutFromHald(await FR.loadImg(FR.gUrl(FT.lut))); }
        catch (e) { Toast.fire({ icon: 'error', title: 'Không đọc được LUT đang dùng' }); }
        ftLutStatus(); ftPreview();
    }
}

function ftShow() {
    document.getElementById('ft-edit').classList.remove('fr-hidden');
    document.getElementById('ft-name').value = FT.name;
    document.getElementById('ft-sliders').innerHTML = FT_SLIDERS.map(([k, label, lo, hi]) => `
        <div class="ft-sl">
            <label class="fr-label">${label} <b id="ft-v-${k}">${FT.adj[k] || 0}</b></label>
            <input type="range" min="${lo}" max="${hi}" step="1" value="${FT.adj[k] || 0}" oninput="ftAdj('${k}', this.value)">
        </div>`).join('');
    ftLutStatus();
    ftRenderList();
    ftPreview();
}

function ftAdj(k, v) {
    FT.adj[k] = +v;
    document.getElementById('ft-v-' + k).innerText = v;
    clearTimeout(ftT);
    ftT = setTimeout(ftPreview, 60);
}

function ftLutStatus() {
    const st = document.getElementById('ft-lut-st');
    const lut = FT_LUT ? FT_LUT.lut : FT_LUTCUR;
    st.innerText = FT_LUT ? 'Đã đọc LUT mới (chưa lưu).' : (FT.lut ? (lut ? 'Đang dùng LUT.' : 'Đang đọc LUT...') : 'Chưa có LUT: chỉ dùng các thanh chỉnh.');
    document.getElementById('ft-lut-del').style.display = (FT.lut || FT_LUT) ? '' : 'none';
}

// Ảnh mẫu mặc định: dải màu + dải xám + màu da, đủ để thấy bộ lọc đổi gì
function ftDefaultSample() {
    const c = document.createElement('canvas');
    c.width = 600; c.height = 400;
    const x = c.getContext('2d');
    for (let i = 0; i < 600; i++) { x.fillStyle = `hsl(${i * 360 / 600},80%,55%)`; x.fillRect(i, 0, 1, 130); }
    const g = x.createLinearGradient(0, 0, 600, 0); g.addColorStop(0, '#000'); g.addColorStop(1, '#fff');
    x.fillStyle = g; x.fillRect(0, 130, 600, 90);
    ['#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#ffdbac', '#3c2e28'].forEach((col, i) => { x.fillStyle = col; x.fillRect(i * 100, 220, 100, 180); });
    return c;
}

async function ftSample(inp) {
    const f = inp.files[0];
    inp.value = '';
    if (!f) return;
    try {
        const p = await FR.shrink(f, 700, 'image/jpeg');
        FT_SAMPLE = await FR.loadImg(URL.createObjectURL(p.blob));
        ftPreview();
    } catch (e) { Toast.fire({ icon: 'error', title: 'Không mở được ảnh mẫu' }); }
}

function ftPreview() {
    if (!FT) return;
    const src = FT_SAMPLE || ftDefaultSample();
    const W = src.naturalWidth || src.width, H = src.naturalHeight || src.height;
    const a = document.getElementById('ft-a'), b = document.getElementById('ft-b');
    [a, b].forEach(c => { c.width = W; c.height = H; c.getContext('2d').drawImage(src, 0, 0); });
    const baked = FR.bakeFilter({ adj: FT.adj }, FT_LUT ? FT_LUT.lut : FT_LUTCUR);
    if (baked) FR.filterCanvas(b, baked);
}

function ftHaldDownload() {
    FR.haldIdentity().toBlob(blob => {
        const u = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = u; a.download = 'PHOTONOIR LUT mau 512.png';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(u), 10000);
    }, 'image/png');
}

async function ftLutUpload(inp) {
    const f = inp.files[0];
    inp.value = '';
    if (!f) return;
    try {
        let lut, blob;
        if (/\.cube$/i.test(f.name)) {
            lut = FR.lutFromCube(await f.text());
        } else {
            const u = URL.createObjectURL(f);
            try { lut = FR.lutFromHald(await FR.loadImg(u)); } finally { URL.revokeObjectURL(u); }
            // Ảnh Hald đúng cỡ 512 thì lưu nguyên file, khỏi qua thêm một lần chuyển đổi
            if (lut.N === 64) blob = f;
        }
        if (FR.lutIsIdentity(lut)) {
            const r = await Swal.fire({ title: 'LUT này không đổi màu gì', text: 'Có vẻ ảnh mẫu chưa được áp bộ lọc trên Canva. Vẫn dùng?', icon: 'warning',
                                        showCancelButton: true, confirmButtonText: 'Vẫn dùng', cancelButtonText: '<span style="color:#111">Chọn lại</span>', confirmButtonColor: '#111', cancelButtonColor: '#fff' });
            if (!r.isConfirmed) return;
        }
        if (!blob) blob = await new Promise(r => FR.lutToHald(lut).toBlob(r, 'image/png'));
        FT_LUT = { lut, blob };
        ftLutStatus(); ftPreview();
        Toast.fire({ icon: 'success', title: 'Đã đọc LUT, xem trước bên trên' });
    } catch (e) { Swal.fire({ title: 'Không đọc được LUT', text: e.message, icon: 'error', confirmButtonColor: '#111' }); }
}

function ftLutClear() {
    FT_LUT = null; FT_LUTCUR = null; FT.lut = '';
    ftLutStatus(); ftPreview();
}

async function ftSave() {
    if (!FT) return;
    FT.name = document.getElementById('ft-name').value.trim();
    if (!FT.name) return Toast.fire({ icon: 'warning', title: 'Đặt tên cho bộ lọc' });
    if (!FT_LUT && !FT.lut && !FR.hasAdj(FT.adj)) return Toast.fire({ icon: 'warning', title: 'Bộ lọc chưa đổi gì: kéo thanh chỉnh hoặc tải LUT' });
    const btn = document.getElementById('ft-save');
    btn.disabled = true; btn.innerText = 'ĐANG LƯU...';
    try {
        const old = FT_LIST[FT.id] && FT_LIST[FT.id].lut;
        if (FT_LUT) {
            const token = await driveToken();
            const folder = await faFolder(token);
            const up = await FR.upload(FT_LUT.blob, 'LUT ' + FT.name.replace(/[\\/:*?"<>|]/g, '_') + '.png', token, folder);
            await FR.makePublic(up.id, token);
            FT.lut = up.id;
        }
        const rec = { name: FT.name.slice(0, 40), adj: FT.adj, lut: FT.lut || '', at: Date.now() };
        await db.ref('config/filters/' + FT.id).set(rec);
        FT_LIST[FT.id] = rec;
        // LUT cũ không còn ai dùng -> bỏ vào thùng rác Drive
        if (old && old !== rec.lut) driveToken().then(t => fetch('https://www.googleapis.com/drive/v3/files/' + old, {
            method: 'PATCH', headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) })).catch(() => {});
        if (FT_LUT) { FT_LUTCUR = FT_LUT.lut; FT_LUT = null; }
        FT.isNew = false;
        ftLutStatus(); ftRenderList();
        Toast.fire({ icon: 'success', title: `Đã lưu bộ lọc "${rec.name}"` });
    } catch (e) {
        Swal.fire({ title: 'Chưa lưu được', text: e.message, icon: 'error', confirmButtonColor: '#111' });
    } finally {
        btn.disabled = false; btn.innerText = 'Lưu bộ lọc';
    }
}

async function ftDelete() {
    if (!FT) return;
    if (FT.isNew) { FT = null; document.getElementById('ft-edit').classList.add('fr-hidden'); return; }
    const dung = Object.values(FA_LIST || {}).filter(f => f.filter === FT.id).map(f => f.name);
    const r = await Swal.fire({ title: `Xoá bộ lọc "${FT.name}"?`, icon: 'warning',
        text: dung.length ? `Đang dùng ở: ${dung.join(', ')}. Các frame này sẽ về màu gốc.` : 'Không frame nào đang dùng bộ lọc này.',
        showCancelButton: true, confirmButtonText: 'Xoá', cancelButtonText: '<span style="color:#111">Huỷ</span>', confirmButtonColor: '#dc2626', cancelButtonColor: '#fff' });
    if (!r.isConfirmed) return;
    try {
        await db.ref('config/filters/' + FT.id).remove();
        for (const [fid, f] of Object.entries(FA_LIST || {})) if (f.filter === FT.id) await db.ref('frames/' + fid + '/filter').set('');
        const lut = FT_LIST[FT.id] && FT_LIST[FT.id].lut;
        if (lut) driveToken().then(t => fetch('https://www.googleapis.com/drive/v3/files/' + lut, {
            method: 'PATCH', headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) })).catch(() => {});
        delete FT_LIST[FT.id];
        Object.values(FA_LIST || {}).forEach(f => { if (f.filter === FT.id) f.filter = ''; });
        FT = null;
        document.getElementById('ft-edit').classList.add('fr-hidden');
        ftRenderList();
        Toast.fire({ icon: 'success', title: 'Đã xoá bộ lọc' });
    } catch (e) { Swal.fire({ title: 'Chưa xoá được', text: e.message, icon: 'error', confirmButtonColor: '#111' }); }
}

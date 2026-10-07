// ===== Lõi xử lý ảnh thẻ (phòng thử, chưa đưa lên web) =====
// Các bước: tìm mặt -> xoay thẳng -> cắt vùng đầu vai -> AI xoá phông (MODNet)
// -> làm sạch mép theo màu phông -> làm gọn viền tóc -> cắt đúng khổ -> đặt nền.
// Mô hình dùng được cho kinh doanh: MODNet (Apache-2.0), MediaPipe FaceLandmarker (Apache-2.0).
import { FilesetResolver, FaceLandmarker } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs';

const TF = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1/dist/transformers.min.js';
let SEG = null, SEG_KIEU = '', FACE = null;
// AI xoá phông chạy ở luồng riêng (anhthe-ai.js) để trang không đứng trong lúc chờ.
// Máy không mở được luồng riêng thì chạy ngay trên trang (SEG).
let LUONG = null, LUONG_ID = 0, LUONG_BAO = null;
const LUONG_CHO = {};

function moLuong(kieu) {
    return new Promise((ok, no) => {
        let w;
        try { w = new Worker(new URL('./anhthe-ai.js', import.meta.url), { type: 'module' }); } catch (e) { return no(e); }
        w.onmessage = e => {
            const m = e.data;
            if (m.t === 'tai') LUONG_BAO && LUONG_BAO('Đang tải phần mềm...', { buoc: 'tai', da: m.da, tong: m.tong });
            else if (m.t === 'san') ok(w);
            else if (m.id && LUONG_CHO[m.id]) {
                const c = LUONG_CHO[m.id]; delete LUONG_CHO[m.id];
                m.t === 'loi' ? c.no(new Error(m.msg)) : c.ok(m.a);
            } else if (m.t === 'loi') no(new Error(m.msg));
        };
        w.onerror = e => { e.preventDefault && e.preventDefault(); no(new Error(e.message || 'Không mở được luồng riêng')); };
        w.postMessage({ t: 'nap', kieu, url: new URL('./ai/hivision_modnet.onnx', import.meta.url).href });
    });
}

// Cỡ AI nhìn ảnh (cạnh ngắn). 'lai' = khối từ 512 + viền tóc từ 768 (chấm P3M-500: tốt nhất, không ảnh hỏng; 768 một mình hỏng 8/62 ảnh)
const CO_NHIN = 512;   // cách xoá phông mới chỉ cần 512 (nhanh); 'lai' = 512 + viền 768
// Kết hợp 2 cỡ: MODNet dạy ở 512 nên nhìn 512 hiểu đúng hình khối (mũ, tay, áo); nhìn 768 nét sợi
// tóc hơn nhưng hay nhầm mảng lớn (mất mũ, mất tay, dính mảng nền). Lấy khối từ 512, chi tiết viền từ 768.
async function chayAI(vung, VW, VH, co) {
    co = co || CO_NHIN;
    if (co !== 'lai') return chayAI1(vung, VW, VH, co);
    const a5 = await chayAI1(vung, VW, VH, 512), a7 = await chayAI1(vung, VW, VH, 768);
    // Dải viền của 512 (nới rộng ~2,5% cạnh ảnh): trong dải dùng 768, ngoài dải dùng 512
    const n = VW * VH, d = new Float32Array(n);
    for (let i = 0; i < n; i++) d[i] = a5[i] > 5 && a5[i] < 250 ? 1 : 0;
    const R = Math.max(4, Math.round(0.025 * Math.min(VW, VH)));
    let w = boxBlur(boxBlur(d, VW, VH, R), VW, VH, R);
    const out = new Uint8Array(n);
    // Hai cỡ lệch nhau quá nhiều (768 nhầm cả mảng sát viền) thì tin 512
    for (let i = 0; i < n; i++) { const t = Math.min(1, w[i] * 4) * (1 - ss(0.35, 0.7, Math.abs(a5[i] - a7[i]) / 255)); out[i] = Math.round(a5[i] * (1 - t) + a7[i] * t); }
    return out;
}

// Trả mặt nạ người (0-255) cỡ VW×VH
async function chayAI1(vung, VW, VH, co) {
    const d = vung.getContext('2d').getImageData(0, 0, VW, VH);
    if (LUONG) {
        const id = ++LUONG_ID;
        return new Promise((ok, no) => { LUONG_CHO[id] = { ok, no }; LUONG.postMessage({ t: 'chay', id, w: VW, h: VH, co, data: d.data.buffer }, [d.data.buffer]); });
    }
    const { RawImage } = await import(TF);
    const ip = SEG.processor && (SEG.processor.image_processor || (SEG.processor.components || {}).image_processor || (SEG.processor.components || {}).feature_extractor);
    if (ip) ip.size = { shortest_edge: co };
    let kq = await SEG(new RawImage(d.data, VW, VH, 4));
    if (Array.isArray(kq)) kq = kq[0];
    if (kq.width !== VW || kq.height !== VH) kq = await kq.resize(VW, VH);
    const a = new Uint8Array(VW * VH), c = kq.channels;
    for (let i = 0; i < a.length; i++) a[i] = c === 4 ? kq.data[i * 4 + 3] : kq.data[i * c];
    return a;
}

// kieu: 'fp32' (26 MB, gốc) | 'q8' (~7 MB, nhẹ cho điện thoại)
export async function napMoHinh(bao, kieu) {
    kieu = kieu || 'fp32';
    LUONG_BAO = bao;
    if (!(LUONG || SEG) || SEG_KIEU !== kieu) {
        bao && bao('Đang tải phần mềm...', { buoc: 'tai' });
        if (LUONG) { LUONG.terminate(); LUONG = null; }
        try { LUONG = await moLuong(kieu); SEG_KIEU = kieu; } catch (e) { LUONG = null; }
    }
    if (!LUONG && kieu.startsWith('hivision')) throw new Error('Máy này không chạy được AI ảnh thẻ');
    if (!LUONG && (!SEG || SEG_KIEU !== kieu)) {
        const { pipeline, env } = await import(TF);
        // Mở qua http trong wifi (phòng thử trên điện thoại) thì trình duyệt không cho bộ nhớ đệm: tải lại mỗi lần
        if (!self.isSecureContext || typeof caches === 'undefined') env.useBrowserCache = false;
        // Báo số MB đã tải (lần đầu trên máy khách); lần sau lấy từ bộ nhớ máy, rất nhanh
        const tep = {};
        const tienDo = p => {
            if (p.status !== 'progress' || !p.total) return;
            tep[p.file] = p;
            const v = Object.values(tep), da = v.reduce((x, y) => x + y.loaded, 0), tong = v.reduce((x, y) => x + y.total, 0);
            bao && bao('Đang tải phần mềm...', { buoc: 'tai', da, tong });
        };
        // Chỉ WASM: chạy được mọi máy (WebGPU treo trên máy không có chip đồ hoạ thật)
        SEG = await pipeline('background-removal', 'Xenova/modnet', { dtype: kieu, device: 'wasm', progress_callback: tienDo });
        SEG_KIEU = kieu;
    }
    await napMat(bao);
}

// Chỉ phần tìm mặt (ghép mặt gốc vào ảnh AI không cần AI xoá phông)
export async function napMat(bao) {
    if (FACE) return;
    bao && bao('Đang tải phần mềm...', { buoc: 'tai' });
    const fs = await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm');
    FACE = await FaceLandmarker.createFromOptions(fs, {
        baseOptions: { modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task', delegate: 'CPU' },
        runningMode: 'IMAGE', numFaces: 1
    });
}

const veCanvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };

// ---------- 1. Tìm mặt ----------
// Trả toạ độ trên ảnh gốc: mắt trái/phải, cằm, đỉnh trán (điểm 10), mép mặt trái/phải
function timMat(nguon, W, H) {
    const k = Math.min(1, 1600 / Math.max(W, H));
    const c = veCanvas(Math.round(W * k), Math.round(H * k));
    c.getContext('2d').drawImage(nguon, 0, 0, c.width, c.height);
    const r = FACE.detect(c);
    if (!r.faceLandmarks || !r.faceLandmarks.length) return null;
    const L = r.faceLandmarks[0];
    const P = i => ({ x: L[i].x * W, y: L[i].y * H });
    const tb = ids => { const ps = ids.map(P); return { x: ps.reduce((a, p) => a + p.x, 0) / ps.length, y: ps.reduce((a, p) => a + p.y, 0) / ps.length }; };
    return {
        matT: tb([33, 133, 159, 145]), matP: tb([263, 362, 386, 374]),   // trái/phải theo ảnh
        cam: P(152), tran: P(10), maT: P(234), maP: P(454)
    };
}

// Đủ 478 điểm mặt (toạ độ ảnh gốc), không thấy mặt thì null
function diemMat(nguon, W, H) {
    const k = Math.min(1, 1600 / Math.max(W, H));
    const c = veCanvas(Math.round(W * k), Math.round(H * k));
    c.getContext('2d').drawImage(nguon, 0, 0, c.width, c.height);
    const r = FACE.detect(c);
    c.width = c.height = 0;
    if (!r.faceLandmarks || !r.faceLandmarks.length) return null;
    return r.faceLandmarks[0].map(p => ({ x: p.x * W, y: p.y * H }));
}

// ---------- Ghép mặt thật vào ảnh AI ----------
// AI tạo ảnh vẽ lại cả mặt nên mặt hơi khác người thật. Lấy phần trong mặt (mắt, mày, mũi,
// miệng, má) từ ảnh gốc, đặt đúng chỗ mặt trong ảnh AI, chỉnh màu da theo ánh sáng ảnh AI,
// viền mềm. Tóc, tai, cằm, cổ, áo, nền giữ của AI.
// Viền mặt MediaPipe (theo vòng)
const VIEN_MAT = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
export async function ghepMat(blobAI, blobGoc, opt) {
    // thu: co viền mặt vào giữa; mau: mức chỉnh màu da theo ảnh AI; bong: mức nén chỗ bóng dầu
    opt = Object.assign({ thu: 0.9, mau: 1, bong: 0.75 }, opt || {});
    await napMat();
    const ai = await createImageBitmap(blobAI, { imageOrientation: 'from-image' });
    const goc = await createImageBitmap(blobGoc, { imageOrientation: 'from-image' });
    const W = ai.width, H = ai.height;
    const q = diemMat(ai, W, H), p = diemMat(goc, goc.width, goc.height);
    if (!q || !p) { ai.close(); goc.close(); throw new Error('Không tìm thấy khuôn mặt trong ảnh'); }
    // Đặt mặt gốc lên mặt AI: phóng, xoay, dời (khớp bình phương nhỏ nhất trên 468 điểm mặt)
    const n = 468;
    let mpx = 0, mpy = 0, mqx = 0, mqy = 0;
    for (let i = 0; i < n; i++) { mpx += p[i].x; mpy += p[i].y; mqx += q[i].x; mqy += q[i].y; }
    mpx /= n; mpy /= n; mqx /= n; mqy /= n;
    let sa = 0, sb = 0, sn = 0;
    for (let i = 0; i < n; i++) {
        const px = p[i].x - mpx, py = p[i].y - mpy, qx = q[i].x - mqx, qy = q[i].y - mqy;
        sa += px * qx + py * qy; sb += px * qy - py * qx; sn += px * px + py * py;
    }
    const ca = sa / sn, sb2 = sb / sn;
    const tx = mqx - (ca * mpx - sb2 * mpy), ty = mqy - (sb2 * mpx + ca * mpy);
    const doi = pt => ({ x: ca * pt.x - sb2 * pt.y + tx, y: sb2 * pt.x + ca * pt.y + ty });
    // Ảnh gốc đã đặt khớp, cùng cỡ ảnh AI
    const g = veCanvas(W, H), gx = g.getContext('2d');
    gx.imageSmoothingQuality = 'high';
    gx.setTransform(ca, sb2, -sb2, ca, tx, ty); gx.drawImage(goc, 0, 0); gx.setTransform(1, 0, 0, 1, 0, 0);
    goc.close();
    // Mặt nạ: viền mặt co vào giữa (chừa mép mặt, chân tóc cho AI), viền mềm
    const vien = VIEN_MAT.map(i => doi(p[i]));
    const cx = vien.reduce((s, v) => s + v.x, 0) / vien.length, cy = vien.reduce((s, v) => s + v.y, 0) / vien.length;
    const m = veCanvas(W, H), mx = m.getContext('2d');
    mx.fillStyle = '#fff'; mx.beginPath();
    vien.forEach((v, i) => { const x = cx + (v.x - cx) * opt.thu, y = cy + (v.y - cy) * opt.thu; i ? mx.lineTo(x, y) : mx.moveTo(x, y); });
    mx.closePath(); mx.fill();
    const md = mx.getImageData(0, 0, W, H).data;
    m.width = m.height = 0;
    let A = new Float32Array(W * H);
    for (let i = 0; i < A.length; i++) A[i] = md[i * 4] / 255;
    const rongMat = Math.hypot(q[454].x - q[234].x, q[454].y - q[234].y);
    const r = Math.max(2, Math.round(rongMat * 0.035));
    A = boxBlur(boxBlur(boxBlur(A, W, H, r), W, H, r), W, H, r);
    // Chỉnh màu: da mặt gốc theo trung bình, độ tương phản của da mặt AI (cùng vùng)
    const c = veCanvas(W, H), x = c.getContext('2d');
    x.drawImage(ai, 0, 0); ai.close();
    const dA = x.getImageData(0, 0, W, H), a = dA.data, b = gx.getImageData(0, 0, W, H).data;
    g.width = g.height = 0;
    const tk = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];   // [tổng AI, bình phương AI, tổng gốc, bình phương gốc]
    let dem = 0;
    for (let i = 0; i < A.length; i++) {
        if (A[i] < 0.98) continue;
        dem++;
        for (let j = 0; j < 3; j++) { const u = a[i * 4 + j], v = b[i * 4 + j]; tk[j][0] += u; tk[j][1] += u * u; tk[j][2] += v; tk[j][3] += v * v; }
    }
    const bd = tk.map(t => {
        const ma = t[0] / dem, sa2 = Math.sqrt(Math.max(1, t[1] / dem - ma * ma)), mg = t[2] / dem, sg = Math.sqrt(Math.max(1, t[3] / dem - mg * mg));
        return v => v + opt.mau * ((v - mg) * (sa2 / sg) + ma - v);
    });
    // Giảm bóng dầu (mũi, trán loá do đèn khi chụp): chỗ sáng hơn mức sáng nhất của da mặt AI thì nén lại
    const sang = (r0, g0, b0) => 0.299 * r0 + 0.587 * g0 + 0.114 * b0;
    const hist = new Uint32Array(256);
    for (let i = 0; i < A.length; i++) if (A[i] >= 0.98) hist[Math.min(255, Math.round(sang(a[i * 4], a[i * 4 + 1], a[i * 4 + 2])))]++;
    let nguong = 255;
    for (let v = 255, s = 0; v >= 0; v--) { s += hist[v]; if (s > dem * 0.05) { nguong = v; break; } }
    for (let i = 0; i < A.length; i++) {
        const w = A[i]; if (w <= 0.002) continue;
        const v = [0, 1, 2].map(j => bd[j](b[i * 4 + j]));
        const L = sang(v[0], v[1], v[2]);
        const k = opt.bong && L > nguong ? (nguong + (L - nguong) * (1 - opt.bong)) / L : 1;
        for (let j = 0; j < 3; j++) a[i * 4 + j] = Math.round(a[i * 4 + j] * (1 - w) + Math.max(0, Math.min(255, v[j] * k)) * w);
    }
    x.putImageData(dA, 0, 0);
    return c;
}

// ---------- 2. Bản đồ màu phông theo vùng + làm sạch mép ----------
function banDoPhong(g, a, W, H) {
    const S = 16, gw = Math.ceil(W / S), gh = Math.ceil(H / S);
    const sum = new Float64Array(gw * gh * 3), cnt = new Float64Array(gw * gh);
    for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
        const i = y * W + x; if (a[i] > 0.03) continue;
        const c = ((y / S) | 0) * gw + ((x / S) | 0);
        sum[c * 3] += g[i * 4]; sum[c * 3 + 1] += g[i * 4 + 1]; sum[c * 3 + 2] += g[i * 4 + 2]; cnt[c]++;
    }
    let map = new Float64Array(gw * gh * 3), ok = new Uint8Array(gw * gh);
    for (let c = 0; c < gw * gh; c++) if (cnt[c] > 3) { ok[c] = 1; for (let j = 0; j < 3; j++) map[c * 3 + j] = sum[c * 3 + j] / cnt[c]; }
    for (let it = 0; it < 600; it++) {
        let doi = 0; const m2 = map.slice(), k2 = ok.slice();
        for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
            const c = y * gw + x; if (ok[c]) continue;
            let n = 0; const s = [0, 0, 0];
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= gw || yy >= gh) continue; const e = yy * gw + xx; if (!ok[e]) continue; n++; for (let j = 0; j < 3; j++) s[j] += map[e * 3 + j]; }
            if (n) { for (let j = 0; j < 3; j++) m2[c * 3 + j] = s[j] / n; k2[c] = 1; doi++; }
        }
        map = m2; ok = k2; if (!doi) break;
    }
    for (let it = 0; it < 3; it++) { const m2 = map.slice(); for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) { let n = 0; const s = [0, 0, 0]; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= gw || yy >= gh) continue; n++; for (let j = 0; j < 3; j++) s[j] += map[(yy * gw + xx) * 3 + j]; } for (let j = 0; j < 3; j++) m2[(y * gw + x) * 3 + j] = s[j] / n; } map = m2; }
    return (x, y, j) => {
        const fx = Math.min(gw - 1.001, Math.max(0, x / S - 0.5)), fy = Math.min(gh - 1.001, Math.max(0, y / S - 0.5));
        const x0 = fx | 0, y0 = fy | 0, dx = fx - x0, dy = fy - y0, v = (xx, yy) => map[(yy * gw + xx) * 3 + j];
        return (v(x0, y0) * (1 - dx) + v(x0 + 1, y0) * dx) * (1 - dy) + (v(x0, y0 + 1) * (1 - dx) + v(x0 + 1, y0 + 1) * dx) * dy;
    };
}

function boxBlur(a, W, H, r) {
    if (r < 1) return a.slice();
    const t = new Float32Array(a.length), o = new Float32Array(a.length), n = 2 * r + 1;
    for (let y = 0; y < H; y++) { let s = 0; const row = y * W;
        for (let x = -r; x <= r; x++) s += a[row + Math.min(W - 1, Math.max(0, x))];
        for (let x = 0; x < W; x++) { t[row + x] = s / n; s += a[row + Math.min(W - 1, x + r + 1)] - a[row + Math.max(0, x - r)]; } }
    for (let x = 0; x < W; x++) { let s = 0;
        for (let y = -r; y <= r; y++) s += t[Math.min(H - 1, Math.max(0, y)) * W + x];
        for (let y = 0; y < H; y++) { o[y * W + x] = s / n; s += t[Math.min(H - 1, y + r + 1) * W + x] - t[Math.max(0, y - r) * W + x]; } }
    return o;
}

// Lọc dẫn hướng (guided filter, He 2010) trên mặt nạ a với ảnh xám làm hướng; sửa tại chỗ
function tinhVien(a, g, W, H) {
    const n = W * H, r = Math.max(3, Math.round(0.006 * Math.min(W, H))), eps = 0.004;
    const I = new Float32Array(n), Ip = new Float32Array(n), II = new Float32Array(n);
    for (let i = 0; i < n; i++) { const v = (0.299 * g[i * 4] + 0.587 * g[i * 4 + 1] + 0.114 * g[i * 4 + 2]) / 255; I[i] = v; Ip[i] = v * a[i]; II[i] = v * v; }
    const mI = boxBlur(I, W, H, r), mp = boxBlur(a, W, H, r), mIp = boxBlur(Ip, W, H, r), mII = boxBlur(II, W, H, r);
    const A = new Float32Array(n), Bb = new Float32Array(n);
    for (let i = 0; i < n; i++) { const va = mII[i] - mI[i] * mI[i], cv = mIp[i] - mI[i] * mp[i]; A[i] = cv / (va + eps); Bb[i] = mp[i] - A[i] * mI[i]; }
    const mA = boxBlur(A, W, H, r), mB = boxBlur(Bb, W, H, r);
    // chỉ thay ở dải viền (mặt nạ trung bình không phải 0 hay 1), trộn mềm theo độ "viền"
    for (let i = 0; i < n; i++) {
        const m = mp[i]; if (m < 0.002 || m > 0.998) continue;
        // chỉ cho thu mép vào (sửa mép loang); nới ra tối đa 0,08 để khỏi lan vào phông sáng giống da
        const q = Math.max(0, Math.min(a[i] + 0.08, mA[i] * I[i] + mB[i]));
        const t = Math.min(1, 4 * m * (1 - m) * 1.5);
        a[i] = a[i] * (1 - t) + q * t;
    }
}

// Làm nét mặt nạ AI theo ảnh gốc (lọc dẫn hướng bán kính nhỏ): MODNet tính ở ảnh nhỏ rồi phóng to nên
// mép tóc thành dải mờ nhoè; lọc theo độ sáng ảnh thật để mép bám đúng từng sợi tóc. Trả mảng mới.
function lamNet(a, g, W, H, r, eps) {
    const n = W * H, I = new Float32Array(n), Ip = new Float32Array(n), II = new Float32Array(n);
    for (let i = 0; i < n; i++) { const v = (0.299 * g[i * 4] + 0.587 * g[i * 4 + 1] + 0.114 * g[i * 4 + 2]) / 255; I[i] = v; Ip[i] = v * a[i]; II[i] = v * v; }
    const mI = boxBlur(I, W, H, r), mp = boxBlur(a, W, H, r), mIp = boxBlur(Ip, W, H, r), mII = boxBlur(II, W, H, r);
    const A = new Float32Array(n), Bb = new Float32Array(n);
    for (let i = 0; i < n; i++) { const va = mII[i] - mI[i] * mI[i], cv = mIp[i] - mI[i] * mp[i]; A[i] = cv / (va + eps); Bb[i] = mp[i] - A[i] * mI[i]; }
    const mA = boxBlur(A, W, H, r), mB = boxBlur(Bb, W, H, r), o = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const m = mp[i];
        if (m < 0.002 || m > 0.998) { o[i] = a[i]; continue; }
        o[i] = Math.max(0, Math.min(1, mA[i] * I[i] + mB[i]));
    }
    return o;
}

// Giữ khối liền lớn nhất (ngưỡng 0.3), xoá mọi mảnh tách rời
function boDao(a, W, H) {
    const nhan = new Int32Array(W * H), st = new Int32Array(W * H);
    let so = 0, lon = 0, nLon = 0;
    for (let i0 = 0; i0 < W * H; i0++) {
        if (nhan[i0] || a[i0] <= 0.3) continue;
        so++; let n = 0, top = 0; st[top++] = i0; nhan[i0] = so;
        while (top) {
            const i = st[--top]; n++; const x = i % W;
            for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W]) {
                if (j < 0 || j >= W * H || nhan[j] || a[j] <= 0.3) continue;
                nhan[j] = so; st[top++] = j;
            }
        }
        if (n > nLon) { nLon = n; lon = so; }
    }
    // mép mềm quanh khối chính có nhãn 0 (a<=0.3): giữ nếu sát khối chính
    const giu = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) if (nhan[i] === lon) giu[i] = 1;
    const gan = boxBlur(Float32Array.from(giu), W, H, 3);
    for (let i = 0; i < W * H; i++) if (!giu[i] && (nhan[i] || gan[i] <= 0)) a[i] = 0;
}

const ss = (e0, e1, v) => { const t = Math.max(0, Math.min(1, (v - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

// ---------- 3. Xử lý một ảnh: trả về lớp người (RGBA, nền trong suốt) + mốc khuôn mặt ----------
// opt.gon: 0 = giữ sợi tóc, càng lớn càng gọn (khoảng 4-12)
// Màu nền lệnh AI yêu cầu (lenh-ai.js): trắng #FFFFFF, xanh #1F5FBF, xanh nhạt #CFE3F7
const NEN_AI = [[255, 255, 255], [31, 95, 191], [207, 227, 247]];
// Viền trên và hai bên nửa trên ảnh gần như một màu tuyệt đối -> trả mã màu nền, không thì null.
// Ảnh chụp thật trước phông trơn vẫn có bóng, chuyển sáng tối nên không lọt.
function nenTron(goc, W, H) {
    const s = Math.min(1, 240 / Math.max(W, H)), w = Math.max(8, Math.round(W * s)), h = Math.max(8, Math.round(H * s));
    const c = veCanvas(w, h), x = c.getContext('2d');
    x.drawImage(goc, 0, 0, w, h);
    const d = x.getImageData(0, 0, w, h).data, ds = [];
    const lay = (xx, yy) => { const i = (yy * w + xx) * 4; ds.push([d[i], d[i + 1], d[i + 2]]); };
    const bx = Math.max(2, Math.round(w * 0.04)), by = Math.max(2, Math.round(h * 0.04));
    for (let yy = 0; yy < by; yy++) for (let xx = 0; xx < w; xx++) lay(xx, yy);
    for (let yy = by; yy < h * 0.45; yy++) for (let xx = 0; xx < bx; xx++) { lay(xx, yy); lay(w - 1 - xx, yy); }
    c.width = c.height = 0;
    const giua = j => { const a = ds.map(p => p[j]).sort((p, q) => p - q); return a[a.length >> 1]; };
    const M = [giua(0), giua(1), giua(2)];
    const gan = ds.filter(p => Math.abs(p[0] - M[0]) + Math.abs(p[1] - M[1]) + Math.abs(p[2] - M[2]) < 18).length;
    // Chỉ nhận khi đúng màu nền đã yêu cầu AI vẽ (trắng, xanh, xanh nhạt): tường trắng ngà, tường
    // xám phẳng chụp thật cũng đều màu nhưng lệch mã màu nên vẫn xoá phông như thường
    const dungMau = NEN_AI.some(n => Math.abs(M[0] - n[0]) + Math.abs(M[1] - n[1]) + Math.abs(M[2] - n[2]) < 15);
    return gan / ds.length > 0.97 && dungMau ? '#' + M.map(v => v.toString(16).padStart(2, '0')).join('') : null;
}

export async function xuLy(blob, opt, bao) {
    opt = Object.assign({ gon: 8 }, opt || {});
    const t0 = performance.now();
    const goc = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    let W = goc.width, H = goc.height;
    const TG = {}, moc = k => TG[k] = Math.round(performance.now() - t0);
    bao && bao('Đang tìm khuôn mặt...', { buoc: 'mat' });
    let m = timMat(goc, W, H);
    if (!m) throw new Error('Không tìm thấy khuôn mặt trong ảnh');
    // Ảnh đã làm nền sẵn (AI tạo ảnh trả về nền trơn tuyệt đối): giữ nguyên, chỉ căn khổ.
    // Tách lại nền trắng quanh áo trắng, tóc mảnh dễ sót viền.
    const nenGoc = opt.giuNen === false ? null : nenTron(goc, W, H);

    // Xoay cho đầu thẳng: trung bình độ nghiêng của đường nối hai mắt và đường giữa mặt
    // (trán -> cằm), đỡ lệch khi hai mắt không đều. Nghiêng quá 10° thì chỉ xoay 10° và báo.
    const gocMat = Math.atan2(m.matP.y - m.matT.y, m.matP.x - m.matT.x);
    const gocGiua = Math.atan2(-(m.cam.x - m.tran.x), m.cam.y - m.tran.y);
    const MAX = 10 * Math.PI / 180, gocDo = (gocMat + gocGiua) / 2;
    const goc0 = Math.max(-MAX, Math.min(MAX, gocDo)), nghieng = Math.abs(gocDo) > MAX;
    let anh = goc, tamXoay = null;   // tâm xoay (toạ độ ảnh gốc): để lúc xuất dựng lại đúng ở độ phân giải đầy đủ
    if (Math.abs(goc0) > 0.3 * Math.PI / 180) {
        const c = veCanvas(W, H), x = c.getContext('2d');
        const cx = (m.matT.x + m.matP.x) / 2, cy = (m.matT.y + m.matP.y) / 2;
        tamXoay = [cx, cy];
        if (nenGoc) { x.fillStyle = nenGoc; x.fillRect(0, 0, W, H); }
        x.translate(cx, cy); x.rotate(-goc0); x.translate(-cx, -cy); x.drawImage(goc, 0, 0);
        anh = c;
        // Xoay luôn các điểm mặt theo cùng góc (khỏi chạy tìm mặt lần hai)
        const co = Math.cos(goc0), si = Math.sin(goc0);
        const xoayDiem = p => ({ x: cx + (p.x - cx) * co + (p.y - cy) * si, y: cy - (p.x - cx) * si + (p.y - cy) * co });
        m = Object.fromEntries(Object.entries(m).map(([kk, p]) => [kk, xoayDiem(p)]));
    }

    // Vùng đầu vai: chạy AI riêng vùng này cho nét
    const mat = { x: (m.matT.x + m.matP.x) / 2, y: (m.matT.y + m.matP.y) / 2 };
    const fh = m.cam.y - m.tran.y;                     // trán -> cằm
    const vx0 = Math.max(0, Math.round(mat.x - 2.1 * fh)), vx1 = Math.min(W, Math.round(mat.x + 2.1 * fh));
    const vy0 = Math.max(0, Math.round(m.tran.y - 1.6 * fh)), vy1 = Math.min(H, Math.round(m.cam.y + 1.9 * fh));
    // Ảnh điện thoại 12 triệu điểm: thu vùng đầu vai về tối đa 1600 điểm (in 300dpi
    // khổ lớn nhất cần ~1300), đỡ tốn bộ nhớ và nhanh hơn nhiều trên điện thoại
    const sc = Math.min(1, (opt.toiDa || 1600) / Math.max(vx1 - vx0, vy1 - vy0));
    const VW = Math.round((vx1 - vx0) * sc), VH = Math.round((vy1 - vy0) * sc);
    const X = v => (v - vx0) * sc, Y = v => (v - vy0) * sc;
    const vung = veCanvas(VW, VH);
    vung.getContext('2d').drawImage(anh, vx0, vy0, vx1 - vx0, vy1 - vy0, 0, 0, VW, VH);
    // Trả bộ nhớ ảnh gốc ngay (điện thoại yếu)
    if (anh !== goc) anh.width = anh.height = 0;
    goc.close();
    moc('mat');
    if (nenGoc) {
        // Đỉnh đầu: hàng trên cùng khác màu nền ở dải giữa mặt
        const d = vung.getContext('2d').getImageData(0, 0, VW, VH).data;
        const N = [1, 3, 5].map(j => parseInt(nenGoc.slice(j, j + 2), 16));
        const cxv = X(mat.x), rong = Math.max(4, (m.maP.x - m.maT.x) * sc * 0.35);
        let dinh = Y(m.tran.y) - 0.4 * fh * sc;
        for (let y = 0; y < VH; y++) {
            let co = 0;
            for (let x = Math.round(cxv - rong); x <= Math.round(cxv + rong); x++) {
                if (x < 0 || x >= VW) continue;
                const i = (y * VW + x) * 4;
                if (Math.abs(d[i] - N[0]) + Math.abs(d[i + 1] - N[1]) + Math.abs(d[i + 2] - N[2]) > 60) co++;
            }
            if (co > rong * 0.6) { dinh = y; break; }
        }
        moc('ai');
        return {
            B: null, nenGoc, gon: opt.gon, TG, nguoi: vung, xoay: +(goc0 * 180 / Math.PI).toFixed(1), nghieng,
            mat: { x: cxv, y: Y(mat.y) }, cam: Y(m.cam.y), dinh, tran: Y(m.tran.y),
            matT: { x: X(m.matT.x), y: Y(m.matT.y) }, matP: { x: X(m.matP.x), y: Y(m.matP.y) },
            ms: Math.round(performance.now() - t0)
        };
    }
    bao && bao('Đang xoá phông...', { buoc: 'ai', TG });
    const ad = await chayAI(vung, VW, VH, opt.nhin);
    const g = vung.getContext('2d').getImageData(0, 0, VW, VH);
    const gd = g.data;
    const aAI = new Float32Array(VW * VH);
    for (let i = 0; i < VW * VH; i++) aAI[i] = ad[i] / 255;

    moc('ai');
    // Giữ lại kết quả AI: đổi mức gọn tóc chỉ làm lại phần sau, không chạy AI lại
    const B = { g0: g, aAI, VW, VH, sc, X0: vx0, Y0: vy0, m, mat, fh, goc0, nghieng, vung: opt.dbg ? vung : null, tam: tamXoay };
    const r = await hoanThien(B, opt, bao, TG, moc);
    r.ms = Math.round(performance.now() - t0);
    return r;
}

// Đổi mức gọn tóc trên ảnh đã xử lý: nhanh (không chạy lại AI)
export async function lamLai(r, gon, bao, them) {
    const t0 = performance.now();
    const r2 = await hoanThien(r.B, Object.assign({ gon }, them || {}), bao);
    r2.ms = r.ms; r2.msLai = Math.round(performance.now() - t0);
    return r2;
}

// ===== CÁCH XOÁ PHÔNG CHÍNH (07/10/2026, chủ tiệm chọn) =====
// Không cắt gọt mặt nạ AI: tóc giữ nguyên mặt nạ MODNet (đủ sợi, đủ lọn, liền mạch), chỉ sửa MÀU sợi mờ cho
// đúng màu tóc (tách màu phông ra, tìm màu tóc theo nhiều tầm - tìm gần không thấy thì sợi giữ màu phông sáng
// thành vệt trắng). Vai, áo (mép mờ hẹp) dùng mép gọn có làm mềm. Gọn tóc = mức làm nhạt sợi cực mờ (hơi sương).
// Bước retouch tóc cho ảnh thẻ làm riêng, sau bước này.
function tachMoi(B, opt) {
    const { aAI, VW, VH, sc, m, mat, fh, goc0 } = B, N = VW * VH;
    const X = v => (v - B.X0) * sc, Y = v => (v - B.Y0) * sc;
    const g = new ImageData(new Uint8ClampedArray(B.g0.data), VW, VH), gd = g.data;
    const mo3 = (a, r) => boxBlur(boxBlur(boxBlur(a, VW, VH, r), VW, VH, r), VW, VH, r);
    const sF = Math.min(VW, VH) / 1600;
    // 1. màu phông / màu tóc quanh mỗi điểm theo nhiều tầm: gần -> xa -> màu chung cả ảnh
    // Màu biến đổi chậm: tính trên lưới thu nhỏ q lần (nhanh gấp ~q² lần, điện thoại), đọc lại nội suy
    const q = Math.max(1, Math.round(4 * sF)), w2 = Math.ceil(VW / q), h2 = Math.ceil(VH / q), n2 = w2 * h2;
    const mo3n = (a, r) => boxBlur(boxBlur(boxBlur(a, w2, h2, r), w2, h2, r), w2, h2, r);
    const rr = Math.max(2, Math.round(10 * sF / q));
    const tim = (lay) => {
        const k = new Float32Array(n2), cc = [0, 1, 2].map(() => new Float32Array(n2)), tb = [0, 0, 0]; let tong = 0;
        for (let y = 0, i = 0; y < VH; y++) for (let x = 0; x < VW; x++, i++) {
            if (!lay(aAI[i])) continue; const e = ((y / q) | 0) * w2 + ((x / q) | 0);
            k[e]++; tong++; for (let c = 0; c < 3; c++) { cc[c][e] += gd[i * 4 + c]; tb[c] += gd[i * 4 + c]; }
        }
        const k1 = mo3n(k, rr), k2 = mo3n(k, rr * 4);
        return cc.map((a, c) => { const o1 = mo3n(a, rr), o2 = mo3n(a, rr * 4), g2 = tong ? tb[c] / tong : 128;
            for (let i = 0; i < n2; i++) o1[i] = k1[i] > 1e-3 ? o1[i] / k1[i] : k2[i] > 1e-4 ? o2[i] / k2[i] : g2; return o1; });
    };
    const PBn = tim(v => v < 0.05), PFn = tim(v => v > 0.97);
    const doc = (A, c, x, y) => {   // nội suy song tuyến
        const fx = Math.max(0, Math.min(w2 - 1.001, x / q - 0.5)), fy = Math.max(0, Math.min(h2 - 1.001, y / q - 0.5));
        const x0 = fx | 0, y0 = fy | 0, tx = fx - x0, ty = fy - y0, a = A[c], i = y0 * w2 + x0;
        return (a[i] * (1 - tx) + a[i + 1] * tx) * (1 - ty) + (a[i + w2] * (1 - tx) + a[i + w2 + 1] * tx) * ty;
    };
    // 2. độ trong: tóc = mặt nạ AI (làm nhạt hơi sương theo Gọn tóc); vai, áo = mép gọn có làm mềm
    const khu = opt.khu ?? 0;   // làm nhạt hơi sương (thử nghiệm, mặc định tắt)
    const yCam = Y(m.cam.y);
    // chia vùng tóc / vai: biến đổi chậm nên tính trên lưới nhỏ (nhanh trên điện thoại)
    const m0 = new Float32Array(n2), dem = new Float32Array(n2);
    for (let y = 0, i = 0; y < VH; y++) for (let x = 0; x < VW; x++, i++) { const e = ((y / q) | 0) * w2 + ((x / q) | 0); dem[e]++; if (aAI[i] > 0.1 && aAI[i] < 0.9) m0[e]++; }
    for (let e = 0; e < n2; e++) m0[e] = dem[e] ? m0[e] / dem[e] : 0;
    const dai = mo3n(m0, Math.max(1, Math.round(5 * sF / q)));     // dải mờ rộng = tóc (cả tóc dài rủ dưới cằm)
    const cung = new Float32Array(N); for (let i = 0; i < N; i++) cung[i] = aAI[i] > 0.5 ? 1 : 0;
    const fv = Math.max(1, Math.round((0.8 + (opt.mem ?? 30) / 100 * 4) * sF));
    const than = mo3(cung, fv);
    const wH = new Float32Array(n2);
    for (let y = 0, e = 0; y < h2; y++) { const tren = 1 - ss(yCam - 0.02 * VH, yCam + 0.06 * VH, (y + 0.5) * q); for (let x = 0; x < w2; x++, e++) wH[e] = Math.max(tren, ss(0.55, 0.85, dai[e])); }
    const wHmA = [mo3n(wH, Math.max(1, Math.round(6 * sF / q)))];
    // Làm nét mép tóc (opt.net 0-1): mặt nạ AI tính ở 512 rồi phóng to nên mép tóc thành dải mờ ~20 điểm
    // ảnh (như phủ lớp nhoè); lọc theo ảnh gốc để mép bám đúng sợi tóc thật
    let aH = aAI;
    if (opt.net > 0) {
        const aN = lamNet(aAI, gd, VW, VH, Math.max(2, Math.round((opt.rNet ?? 1.5) * sF)), opt.epsNet ?? 0.0005);
        aH = new Float32Array(N); for (let i = 0; i < N; i++) aH[i] = aAI[i] * (1 - opt.net) + aN[i] * opt.net;
    }
    // Sợi tóc mảnh (1-2 điểm ảnh) mặt nạ AI tính ở ảnh nhỏ thấy lúc có lúc không -> sợi đứt quãng. Sát quanh tóc,
    // tính độ trong từ chính ảnh gốc: phông trơn biết màu B, tóc biết màu F; điểm lệch từ B về phía F là sợi.
    // a = (C-B)·(F-B) / |F-B|². Bám từng sợi ở độ nét gốc nên liền mạch. Chỉ ở dải sát tóc, trên cằm.
    const wHm0 = y => 1 - ss(yCam - 0.02 * VH, yCam + 0.06 * VH, y);
    if (opt.soiAnh !== false) {
        // vùng sát tóc tính trên lưới nhỏ (biến đổi chậm); dải sát khối tóc đặc tính ở cỡ thật (hẹp)
        const gan = new Float32Array(n2); for (let y = 0, i = 0; y < VH; y++) for (let x = 0; x < VW; x++, i++) if (aAI[i] > 0.08) gan[((y / q) | 0) * w2 + ((x / q) | 0)] = 1;
        const ganN = mo3n(gan, Math.max(1, Math.round(0.02 * Math.min(VW, VH) / q))), ganA = [ganN];
        const dac = new Float32Array(N); for (let i = 0; i < N; i++) dac[i] = aAI[i] > 0.85 ? 1 : 0;
        // độ sần của phông quanh mỗi chỗ (độ lệch sáng các điểm phông trong ô): phông trơn (quán) thì phục hồi sợi,
        // phông sần (tường, vải có vân) thì vân phông bị nhận nhầm thành sợi -> tắt ở chỗ đó
        const s1 = new Float32Array(n2), s2 = new Float32Array(n2), sd = new Float32Array(n2);
        for (let y = 0, i = 0; y < VH; y++) for (let x = 0; x < VW; x++, i++) { if (aAI[i] >= 0.05) continue; const e = ((y / q) | 0) * w2 + ((x / q) | 0), L = 0.299 * gd[i * 4] + 0.587 * gd[i * 4 + 1] + 0.114 * gd[i * 4 + 2]; s1[e] += L; s2[e] += L * L; sd[e]++; }
        const lech = new Float32Array(n2); for (let e = 0; e < n2; e++) lech[e] = sd[e] > 3 ? Math.sqrt(Math.max(0, s2[e] / sd[e] - (s1[e] / sd[e]) ** 2)) : 0;
        const sanM = mo3n(lech, Math.max(1, Math.round(8 * sF / q)));
        const khoi = boxBlur(boxBlur(dac, VW, VH, Math.max(2, Math.round((opt.soiCach ?? 3) * sF))), VW, VH, Math.max(2, Math.round((opt.soiCach ?? 3) * sF)));
        if (aH === aAI) aH = Float32Array.from(aAI);
        for (let y = 0, i = 0; y < VH; y++) for (let x = 0; x < VW; x++, i++) {
            if (aH[i] >= 0.95 || (khoi[i] >= 0.3 && (opt.boSuong === false || aAI[i] >= 0.85))) continue;
            const e = ((y / q) | 0) * w2 + ((x / q) | 0);   // ô gần nhất (nhanh; các trường này biến đổi chậm)
            const gM = ganN[e] * (1 - ss(opt.sanTu ?? 1.4, opt.sanDen ?? 2.4, sanM[e])); if (gM < 0.03) continue;
            let tu = 0, mau = 0;
            for (let c = 0; c < 3; c++) { const Bc = PBn[c][e], Fc = PFn[c][e], d = Fc - Bc; tu += (gd[i * 4 + c] - Bc) * d; mau += d * d; }
            if (mau < (opt.mauMin ?? 2500)) continue;     // tóc và phông quá gần màu (tóc nâu, phông nâu): không đoán được, đoán là ra vệt cam lốm đốm
            const ac = Math.max(0, Math.min(1, tu / mau));
            const v = ss(opt.soiTu ?? 0.06, opt.soiDen ?? 0.3, ac) * Math.min(1, ac * (opt.soiK ?? 1.5)) * ss(0.03, 0.25, gM) * wHm0(y) * (1 - ss(0.05, 0.3, khoi[i]));   // không đụng dải sát mép khối tóc đặc (nâng lên thì thành viền tối)
            if (v > aH[i] && khoi[i] < 0.3) aH[i] = v;
            else if (opt.boSuong !== false && v <= aH[i]) {
                // BỚT SƯƠNG: AI cho là "nửa tóc" nhưng ảnh gốc vẫn là màu phông -> lớp sương xám quanh tóc; hạ về
                // mức ảnh gốc cho phép. Sợi thật (ảnh gốc lệch về màu tóc) giữ nguyên.
                const cho = Math.min(1, ac * (opt.soiK ?? 1.5)), g2 = ss(0.03, 0.25, gM) * wHm0(y) * (1 - ss(0.6, 0.85, aAI[i]));   // cả dải sát mép, trừ lõi tóc chắc
                if (aH[i] > cho + 0.04) aH[i] = aH[i] * (1 - g2) + cho * g2;
            }
        }
    }
    // TÓC GẦN MÀU PHÔNG (tóc sáng trên phông be, nâu trên nâu): mép mờ của AI ở đó không đáng tin - giữ mờ thì thành
    // vệt sáng như bôi lên tóc. Chỗ tương phản thấp: dứt khoát độ trong (tóc thì đặc, không thì bỏ).
    if (opt.dutKhoat !== false) {
        if (aH === aAI) aH = Float32Array.from(aAI);
        for (let y = 0, i = 0; y < VH; y++) { const tren = wHm0(y); for (let x = 0; x < VW; x++, i++) {
            const v = aH[i]; if (v <= 0.02 || v >= 0.98 || tren <= 0) continue;
            const e = ((y / q) | 0) * w2 + ((x / q) | 0); let dd = 0; for (let c = 0; c < 3; c++) { const t = PFn[c][e] - PBn[c][e]; dd += t * t; }
            const lc = (1 - ss(1500, 4000, dd)) * tren; if (lc <= 0.01) continue;
            aH[i] = v * (1 - lc) + ss(0.4, 0.7, v) * lc;
        } }
    }
    // ---- Phần nặng tính MỘT LẦN, giữ lại; hai thanh (Gọn tóc, Độ mềm viền) chỉ chạy phần nhẹ (dung) nên kéo là ăn ngay ----
    const wh = new Float32Array(N);
    for (let y = 0, i = 0; y < VH; y++) for (let x = 0; x < VW; x++, i++) wh[i] = doc(wHmA, 0, x, y);
    // 4. màu mép (không phụ thuộc hai thanh): tách màu phông, kẹp quanh màu tóc gần đó
    let window_tp = 1;
    for (let i = 0; i < N; i++) {
        const p = i * 4, a = aAI[i];
        if (aH[i] <= 0.003 && a <= 0.003 && wh[i] > 0.99) continue;
        const tim2 = aH[i] - a;
        if (tim2 > 0.03 && !opt.khongMau) {
            const x = i % VW, y = (i / VW) | 0, k = Math.min(1, tim2 / Math.max(0.05, aH[i]));
            for (let c = 0; c < 3; c++) { const Fc = doc(PFn, c, x, y), Bc = doc(PBn, c, x, y), al = Math.max(0.15, a);
                let F = (gd[p + c] - (1 - al) * Bc) / al; F = Math.max(Fc - 45, Math.min(Fc + 45, F));
                gd[p + c] = Math.round(Math.max(0, Math.min(255, F * (1 - k) + Fc * k))); }
        } else if (a < 0.97 && !opt.khongMau) for (let c = 0; c < 3; c++) {
            const x = i % VW, y = (i / VW) | 0;
            const C = gd[p + c], Bc = doc(PBn, c, x, y), Fc = doc(PFn, c, x, y), al = Math.max(0.15, a);
            let F = (C - (1 - al) * Bc) / al;
            F = Math.max(Fc - 45, Math.min(Fc + 45, F));
            // tóc gần màu phông (nâu/nâu): tách màu không đáng tin, ra vệt cam lốm đốm -> nghiêng về màu tóc gần đó
            if (c === 0) { let dd = 0; for (let c2 = 0; c2 < 3; c2++) { const t = doc(PFn, c2, x, y) - doc(PBn, c2, x, y); dd += t * t; } window_tp = ss(900, 4000, dd); }
            F = Fc * (1 - window_tp) + F * window_tp;
            if (a < 0.3) F = Fc * (1 - ss(0.15, 0.3, a)) + F * ss(0.15, 0.3, a);
            gd[p + c] = Math.round(Math.max(0, Math.min(255, F)));
        }
    }
    const mau = gd;                       // màu đã sửa, dùng lại cho mọi lần kéo thanh
    const aH0 = aH, thanMem = new Map();
    let cham = null;                      // chấm lẻ li ti cần bỏ (tính lần đầu, dùng lại)
    const cxv = X(mat.x), rong = Math.max(4, (m.maP.x - m.maT.x) * sc * 0.35);
    const dung = (gon, mem) => {
        // Gọn tóc (0-14) = thu hẹp dải mờ (đường cong độ trong); Độ mềm viền = bán kính mềm mép vai, áo
        const hep = opt.hep ?? Math.max(0, Math.min(14, gon ?? 0)) / 14 * 0.35;
        const fv = Math.max(1, Math.round((0.8 + (mem ?? 30) / 100 * 4) * sF));
        let than = thanMem.get(fv); if (!than) { than = mo3(cung, fv); thanMem.set(fv, than); }
        const af = new Float32Array(N);
        for (let i = 0; i < N; i++) {
            let v = aH0[i];
            if (hep > 0 && v > 0 && v < 1) v = ss(hep, 1 - hep * 0.6, v);
            if (khu > 0 && v > 0 && v < 1) v *= ss(khu * 0.4, khu, v);
            af[i] = v * wh[i] + than[i] * (1 - wh[i]);
        }
        // 3. bỏ chấm lẻ li ti (không bỏ lọn tóc) - tính một lần
        if (!cham) {
            cham = new Uint8Array(N);
            const lab = new Uint8Array(N), st = new Int32Array(N), nho = Math.round((opt.nho ?? 0.0015) * N);
            for (let i0 = 0; i0 < N; i0++) {
                if (lab[i0] || af[i0] <= 0.3) continue;
                let top = 0; const ds = []; st[top++] = i0; lab[i0] = 1;
                while (top) { const i = st[--top]; if (ds.length <= nho) ds.push(i); const x = i % VW;
                    for (const j of [x > 0 ? i - 1 : -1, x < VW - 1 ? i + 1 : -1, i - VW, i + VW]) { if (j < 0 || j >= N || lab[j] || af[j] <= 0.3) continue; lab[j] = 1; st[top++] = j; } }
                if (ds.length <= nho) for (const i of ds) cham[i] = 1;
            }
        }
        const out = new ImageData(VW, VH), od = out.data;
        for (let i = 0; i < N; i++) {
            const v = cham[i] ? 0 : af[i], p = i * 4;
            if (v <= 0.003) continue;
            od[p] = mau[p]; od[p + 1] = mau[p + 1]; od[p + 2] = mau[p + 2]; od[p + 3] = Math.round(Math.min(1, v) * 255);
        }
        const nguoi = veCanvas(VW, VH); nguoi.getContext('2d').putImageData(out, 0, 0);
        let dinh = Y(m.tran.y) - 0.4 * fh * sc;
        for (let y = 0; y < VH; y++) {
            let co = 0; for (let x = Math.round(cxv - rong); x <= Math.round(cxv + rong); x++) { if (x >= 0 && x < VW && af[y * VW + x] > 0.5 && !cham[y * VW + x]) co++; }
            if (co > rong * 0.6) { dinh = y; break; }
        }
        return {
            B, gon, mem, dung, af, dbg: opt.dbg ? { vung: B.vung, aAI, a: af, af, mem: null, VW, VH } : undefined, nguoi, hoaVien: 0.1,
            xoay: +(goc0 * 180 / Math.PI).toFixed(1), nghieng: B.nghieng,
            mat: { x: cxv, y: Y(mat.y) }, cam: yCam, dinh, tran: Y(m.tran.y), matT: { x: X(m.matT.x), y: Y(m.matT.y) }, matP: { x: X(m.matP.x), y: Y(m.matP.y) }
        };
    };
    const kq = dung(opt.gon, opt.mem);
    // tính sẵn các mức Độ mềm viền lúc rảnh (từng mức một, không làm đứng trang) để kéo thanh là ăn ngay
    const fvs = [...new Set(Array.from({ length: 11 }, (_, k) => Math.max(1, Math.round((0.8 + k / 10 * 4) * sF))))];
    const sau = () => { const fv = fvs.find(v => !thanMem.has(v)); if (fv === undefined) return; thanMem.set(fv, mo3(cung, fv)); setTimeout(sau, 50); };
    if (typeof setTimeout !== 'undefined') setTimeout(sau, 300);
    return kq;
}

// ===== RETOUCH TÓC CHO ẢNH THẺ (làm trên kết quả tách, không đụng bước tách) =====
// muc: 0 Tự nhiên (giữ nguyên tách) | 2 Gọn | 3 Rất gọn. Đường bao tóc trơn theo dáng cũ, bỏ sợi bay ngoài phom
// (cọ mềm, có khoảng đệm giữ ngọn tự nhiên), bù tóc chỗ lọt phông trong phom, trả lại tóc bị xoá nhầm, dựng lại chỏm.
function suaTocLoi(r0, muc, opt3) {
    const TAT = (typeof globalThis !== 'undefined' && globalThis.__tat) || {};   // chẩn đoán: tắt từng bước
    const { aAI, VW, VH } = r0.B, af = r0.af, N = VW * VH;
    const src = r0.nguoi.getContext('2d').getImageData(0, 0, VW, VH).data;
    const ss = (e0, e1, v) => { const t = Math.max(0, Math.min(1, (v - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
    const blur = (a, W, H, r) => { let o = a; const n = W * H;
        for (let k = 0; k < 3; k++) { const t = new Float32Array(n), u = new Float32Array(n);
            for (let y = 0; y < H; y++) { let s = 0; const h = y * W; for (let x = -r; x <= r; x++) s += o[h + Math.min(W - 1, Math.max(0, x))];
                for (let x = 0; x < W; x++) { t[h + x] = s / (2 * r + 1); s += o[h + Math.min(W - 1, x + r + 1)] - o[h + Math.max(0, x - r)]; } }
            for (let x = 0; x < W; x++) { let s = 0; for (let y = -r; y <= r; y++) s += t[Math.min(H - 1, Math.max(0, y)) * W + x];
                for (let y = 0; y < H; y++) { u[y * W + x] = s / (2 * r + 1); s += t[Math.min(H - 1, y + r + 1) * W + x] - t[Math.max(0, y - r) * W + x]; } }
            o = u; } return o; };
    const t0 = performance.now();
    // mức (% bề rộng mặt): bỏ phần lồi mảnh hơn | lấp chỗ lõm hẹp hơn | làm trơn viền | độ mềm viền
    // [bỏ lồi, lấp lõm, làm trơn, độ mềm, KHOẢNG ĐỆM giữ mép tự nhiên] (% bề rộng mặt)
    const P = { 1: [1.2, 0, 0.6, 0.5, 1.6], 2: [2.2, 2.5, 1.2, 0.6, 1.0], 3: [3.2, 5, 2.2, 0.7, 0.5] }[muc];
    const k = Math.min(1, 700 / Math.max(VW, VH)), w = Math.round(VW * k), h = Math.round(VH * k), n = w * h;
    // mặt nạ nhỏ từ kết quả tách
    const nho = arr => { const o = new Float32Array(n), d = new Float32Array(n);
        for (let y = 0; y < VH; y++) for (let x = 0; x < VW; x++) { const e = Math.min(h - 1, (y * k) | 0) * w + Math.min(w - 1, (x * k) | 0); o[e] += arr[y * VW + x]; d[e]++; }
        for (let e = 0; e < n; e++) o[e] = d[e] ? o[e] / d[e] : 0; return o; };
    const As = nho(af);
    const M0 = new Float32Array(n); for (let i = 0; i < n; i++) M0[i] = As[i] > 0.5 ? 1 : 0;
    const fw = Math.hypot(r0.matP.x - r0.matT.x, r0.matP.y - r0.matT.y) * 2.2 * k;
    const R = p => Math.max(1, Math.round(p / 100 * fw));
    const ng = (a, t) => { const o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = a[i] > t ? 1 : 0; return o; };
    const co = (a, r) => ng(blur(a, w, h, r), 0.88), no = (a, r) => ng(blur(a, w, h, r), 0.12);
    let M = no(co(M0, R(P[0])), R(P[0]));                              // bỏ phần lồi mảnh (sợi, chùm bay)
    if (P[1] > 0) M = co(no(M, R(P[1])), R(P[1]));                     // lấp chỗ lõm hẹp
    M = ng(blur(M, w, h, R(P[2])), 0.5);                               // làm trơn viền (cỡ nhỏ)
    // vùng được sửa: trên cằm (chuyển dần), hoặc dải tóc rủ dưới cằm (dải mờ rộng của AI = tóc)
    const yC = r0.cam * k;
    const mo = new Float32Array(n); { const a2 = nho(aAI); for (let i = 0; i < n; i++) mo[i] = a2[i] > 0.1 && a2[i] < 0.9 ? 1 : 0; }
    const dai = blur(mo, w, h, Math.max(2, Math.round(0.012 * fw * 4)));
    const sua = new Float32Array(n);
    for (let y = 0, i = 0; y < h; y++) { const tren = 1 - ss(yC - 0.02 * h, yC + 0.05 * h, y); for (let x = 0; x < w; x++, i++) sua[i] = Math.max(tren, ss(0.5, 0.8, dai[i])); }
    const suaM = blur(sua, w, h, 2);
    // phom mềm (cọ mềm) + chỗ cần lấp
    // chỉ lấp chỗ thiếu từ giữa mắt-cằm trở lên (đỉnh, hai bên trên); khoảng hở đuôi tóc - cổ là nền thật, không lấp
    const yLap = (r0.mat.y + 0.5 * (r0.cam - r0.mat.y)) * k;
    const lap = new Float32Array(n); for (let i = 0; i < n; i++) lap[i] = M[i] > 0.5 && M0[i] < 0.5 ? suaM[i] * (1 - ss(yLap - 0.03 * h, yLap, (i / w) | 0)) : 0;
    // dưới đó phom không được nở ra ngoài tóc thật
    for (let i = 0; i < n; i++) if (((i / w) | 0) >= yLap && M0[i] < 0.5) M[i] = 0;
    // phom nới ra một khoảng đệm: ngọn tóc tự nhiên ở mép giữ nguyên, chỉ sợi bay xa hơn mới mờ dần
    let phom = blur(ng(blur(M, w, h, R(P[4])), 0.1), w, h, R(P[3]) + R(P[4]));
    // mỗi chỗ lấp: chọn một độ dời vào trong khối tóc (lấy mảng tóc chắc, chung cho cả chỗ)
    const lab = new Int32Array(n), st = new Int32Array(n), cmp = [];
    for (let i0 = 0; i0 < n; i0++) { if (lap[i0] < 0.5 || lab[i0]) continue;
        const id = cmp.length + 1; let top = 0, sx = 0, sy = 0, dem = 0; st[top++] = i0; lab[i0] = id;
        while (top) { const i = st[--top], x = i % w, y = (i / w) | 0; sx += x; sy += y; dem++;
            for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) { if (j < 0 || j >= n || lab[j] || lap[j] < 0.5) continue; lab[j] = id; st[top++] = j; } }
        cmp.push({ cx: sx / dem, cy: sy / dem, dt: dem }); }
    // màu tóc (trên trán) và màu da (giữa mặt) của chính người này: mẫu lấp phải giống tóc hơn giống da
    const tb = (lay) => { let r = 0, g = 0, b = 0, d = 0; for (let y = 0; y < VH; y += 2) for (let x = 0; x < VW; x += 2) { const i = y * VW + x; if (af[i] > 0.95 && lay(x, y)) { r += src[i * 4]; g += src[i * 4 + 1]; b += src[i * 4 + 2]; d++; } } return d ? [r / d, g / d, b / d] : null; };
    const cxm = (r0.matT.x + r0.matP.x) / 2, fwF = fw / k;
    const toc = tb((x, y) => y < r0.tran - 0.03 * fwF) || tb((x, y) => y < r0.mat.y && Math.abs(x - cxm) > 0.55 * fwF);
    const da = tb((x, y) => Math.abs(x - cxm) < 0.15 * fwF && y > r0.mat.y + 0.1 * fwF && y < r0.cam - 0.15 * fwF);
    const kc = (j, m) => Math.hypot(src[j * 4] - m[0], src[j * 4 + 1] - m[1], src[j * 4 + 2] - m[2]);
    // màu phông cũ (ảnh gốc chỗ AI chắc là nền): mẫu lấp không được giống phông hơn giống tóc
    const g0 = r0.B.g0.data;
    let pr = 0, pg = 0, pb = 0, pd = 0; for (let i = 0; i < N; i += 3) if (aAI[i] < 0.03) { pr += g0[i * 4]; pg += g0[i * 4 + 1]; pb += g0[i * 4 + 2]; pd++; }
    const phong = pd ? [pr / pd, pg / pd, pb / pd] : null;
    // ===== TRẢ LẠI TÓC BỊ XOÁ NHẦM (quy luật chung) =====
    // Chỗ đường bao AI LÕM vào so với đường bao trơn (đỉnh, hai bên trên tầm mắt) = chỗ nghi bị mất. Hỏi ảnh gốc:
    // rõ là phông (tóc–phông tương phản cao và điểm gần màu phông) -> khe thật, không trả; không rõ -> tóc thật bị
    // xoá nhầm -> trả lại đúng điểm ảnh gốc. Chỗ lõm quá lớn thì không đoán, báo lại.
    const tra = new Float32Array(n); let soTra = 0, quaLon = 0;
    if (!TAT.tra && opt3 !== 'khongtra' && P[1] > 0 && toc && phong) {
        const Rt = R(P[1] * 1.8 + 1), Mt = co(no(M0, Rt), Rt), yT = r0.mat.y * k;
        const dF = [toc[0] - phong[0], toc[1] - phong[1], toc[2] - phong[2]], d2 = dF[0] ** 2 + dF[1] ** 2 + dF[2] ** 2;
        const tuongPhan = ss(1500, 4000, d2);               // 0: tóc gần màu phông (khó), 1: khác hẳn (dễ)
        const lom = new Uint8Array(n); for (let i = 0; i < n; i++) if (((i / w) | 0) < yT && Mt[i] > 0.5 && M0[i] < 0.5) lom[i] = 1;
        const lab2 = new Int32Array(n), st2 = new Int32Array(n), gioiHan = (0.12 * fw) ** 2;
        for (let i0 = 0; i0 < n; i0++) { if (!lom[i0] || lab2[i0]) continue;
            const ds = []; let top = 0; st2[top++] = i0; lab2[i0] = 1;
            while (top) { const i = st2[--top], x = i % w; ds.push(i);
                for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) { if (j < 0 || j >= n || lab2[j] || !lom[j]) continue; lab2[j] = 1; st2[top++] = j; } }
            if (ds.length > gioiHan) { quaLon++; continue; }
            for (const i of ds) {
                const x = i % w, y = (i / w) | 0, j = Math.min(VH - 1, Math.round(y / k)) * VW + Math.min(VW - 1, Math.round(x / k));
                const t = ((g0[j * 4] - phong[0]) * dF[0] + (g0[j * 4 + 1] - phong[1]) * dF[1] + (g0[j * 4 + 2] - phong[2]) * dF[2]) / Math.max(1, d2);
                const roPhong = tuongPhan * (1 - ss(0.15, 0.4, t));
                tra[i] = (1 - roPhong) * (1 - ss(yT - 0.04 * h, yT, y));
                if (tra[i] > 0.5) { M[i] = 1; soTra++; }
            }
        }
        phom = blur(ng(blur(M, w, h, R(P[4])), 0.1), w, h, R(P[3]) + R(P[4]));
    }
    const kcG = (j, m) => Math.hypot(g0[j * 4] - m[0], g0[j * 4 + 1] - m[1], g0[j * 4 + 2] - m[2]);
    const laToc = j => af[j] > 0.95 && aAI[j] > 0.9 && (!toc || !da || (kc(j, toc) < 0.8 * kc(j, da) && kc(j, toc) < 70)) && (!phong || !toc || kcG(j, toc) < 0.7 * kcG(j, phong));
    const Bw = blur(M0, w, h, Math.max(3, R(3)));
    for (const c of cmp) {
        const x = Math.round(c.cx), y = Math.round(c.cy);
        let gx = Bw[y * w + Math.min(w - 1, x + 1)] - Bw[y * w + Math.max(0, x - 1)], gy = Bw[Math.min(h - 1, y + 1) * w + x] - Bw[Math.max(0, y - 1) * w + x];
        const gl = Math.hypot(gx, gy) || 1; gx /= gl; gy /= gl;
        const d0 = 2 * Math.sqrt(c.dt / Math.PI) + 3; let tot = -1, ox = 0, oy = 0;
        for (const g of [0, 0.35, -0.35, 0.7, -0.7]) for (const hs of [1.2, 1.7, 2.4]) {
            const ca = Math.cos(g), sa = Math.sin(g), vx = (gx * ca - gy * sa) * d0 * hs, vy = (gx * sa + gy * ca) * d0 * hs;
            let ok = 0, all = 0;
            for (let yy = Math.max(0, y - 20); yy < Math.min(h, y + 20); yy += 2) for (let xx = Math.max(0, x - 20); xx < Math.min(w, x + 20); xx += 2) {
                if (lab[yy * w + xx] !== lab[y * w + x]) continue; all++;
                const tx = Math.round(xx + vx), ty = Math.round(yy + vy);
                if (tx >= 0 && ty >= 0 && tx < w && ty < h && As[ty * w + tx] > 0.95 && laToc(Math.min(VH - 1, Math.round(ty / k)) * VW + Math.min(VW - 1, Math.round(tx / k)))) ok++; }
            const s = all ? ok / all : 0; if (s > tot + 0.02) { tot = s; ox = vx; oy = vy; } }
        c.dx = Math.round(ox / k); c.dy = Math.round(oy / k); c.tot = tot;
    }
    // phóng lên cỡ thật
    const len = arr => { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d').createImageData(w, h);
        for (let i = 0; i < n; i++) { const v = Math.max(0, Math.min(255, arr[i] * 255)); g.data[i * 4] = g.data[i * 4 + 1] = g.data[i * 4 + 2] = v; g.data[i * 4 + 3] = 255; }
        c.getContext('2d').putImageData(g, 0, 0); const o = document.createElement('canvas'); o.width = VW; o.height = VH;
        const ox = o.getContext('2d'); ox.imageSmoothingQuality = 'high'; ox.drawImage(c, 0, 0, VW, VH);
        const d = ox.getImageData(0, 0, VW, VH).data, r = new Float32Array(N); for (let i = 0; i < N; i++) r[i] = d[i * 4] / 255; return r; };
    const PH = len(phom), SU = len(suaM), LP = len(blur(lap, w, h, 1)), TR = len(blur(tra, w, h, 1));
    // BÙ TÓC TRONG PHOM: phần nửa trong suốt nằm trong phom tóc (lọt phông, sương) đắp đặc bằng tóc thật
    const PI = len(blur(M, w, h, R(P[3]))), MBf = len(blur(M, w, h, Math.max(2, R(3))));
    const sau = Math.max(3, Math.round(0.015 * fw / k));
    // VÙNG TAI (theo điểm mặt): hai bên ngoài mép mặt, từ trên lông mày xuống cằm. Retouch không đụng vào đây:
    // khe giữa tóc mai và vành tai là dáng thật, vành tai lồi ra không phải sợi bay
    const cxF = cxm, yTai0 = r0.mat.y - 0.24 * fwF, yTai1 = r0.cam;
    const vungTai = (x, y) => ss(0.36, 0.44, Math.abs(x - cxF) / fwF) * ss(yTai0 - 0.06 * fwF, yTai0, y) * (1 - ss(yTai1 - 0.05 * fwF, yTai1, y));
    const yMay = r0.mat.y - 0.18 * fwF;   // ngang lông mày: trả lại tóc chỉ ở phía trên
    // HAI LỚP: lớp NGƯỜI (ảnh tách, chỉ làm mờ sợi bay) nằm TRÊN; lớp TÓC BỔ SUNG (trả lại, lấp, bù) nằm DƯỚI.
    // Tóc bổ sung chỉ lộ ra ở chỗ lớp người trong suốt, không bao giờ đè lên tai, mặt, tóc thật.
    // VÀNH TAI: trong vùng tai, khối màu da đặc (vành tai) + nới ra một chút -> bảo vệ, không làm mờ.
    // Lọn tóc lòa xòa cạnh thái dương (màu tóc) vẫn được làm mờ như chỗ khác.
    const TAI = new Float32Array(N);
    if (toc && da) {
        const laDa = new Float32Array(N);
        for (let y = Math.max(0, Math.floor(yTai0 - 0.06 * fwF)); y < Math.min(VH, yTai1); y++) for (let x = 0; x < VW; x++) {
            const i = y * VW + x; if (af[i] < 0.5 || vungTai(x, y) < 0.05) continue;
            const dt = kc(i, toc), dd = kc(i, da); if (dd < dt) laDa[i] = 1; }
        const rT = Math.max(2, Math.round(0.02 * fwF));
        const mo2 = boxBlur(boxBlur(laDa, VW, VH, rT), VW, VH, rT);
        for (let i = 0; i < N; i++) TAI[i] = ss(0.04, 0.2, mo2[i]);
    }
    const out = new ImageData(VW, VH), od = out.data;
    for (let y = 0; y < VH; y++) for (let x = 0; x < VW; x++) {
        const i = y * VW + x, p = i * 4;
        const eZ = vungTai(x, y);
        // chỉ làm mờ điểm có màu tóc; da (tai, mặt, cổ) giữ nguyên
        // làm mờ sợi bay: cả vùng tai vẫn làm (lọn tóc lòa xòa cạnh thái dương), nhưng ở đó chỉ điểm CHẮC là màu tóc
        // (kiểm tra chặt hơn) để vành tai không bị làm trong suốt
        let s = SU[i] * (1 - TAI[i]);
        if (toc && da && s > 0 && af[i] > 0.02) { const dt = kc(i, toc), dd = kc(i, da); s *= ss(0.42, 0.58, dd / (dt + dd + 1e-3)); }
        const a0 = af[i];
        // lớp người: ngoài phom tóc mờ dần
        const aA = TAT.mo ? a0 : a0 * (1 - s) + a0 * PH[i] * s;
        // lớp tóc bổ sung (dưới)
        let aB = 0, rB = 0, gB = 0, bB = 0;
        const dat = (t, j, nguon) => { if (t > aB) { aB = t; rB = nguon[j * 4]; gB = nguon[j * 4 + 1]; bB = nguon[j * 4 + 2]; } };
        const sB = SU[i] * (1 - eZ);
        const lp = LP[i] * sB;
        if (!TAT.lap && lp > 0.02) {
            const L = lab[Math.min(h - 1, (y * k) | 0) * w + Math.min(w - 1, (x * k) | 0)] || lab[Math.min(h - 1, ((y * k) | 0) + 1) * w + Math.min(w - 1, (x * k) | 0)];
            const c = L ? cmp[L - 1] : null;
            if (c && c.tot > 0.5) {
                const tx = Math.max(0, Math.min(VW - 1, x + c.dx)), ty = Math.max(0, Math.min(VH - 1, y + c.dy)), j = ty * VW + tx;
                if (laToc(j)) dat(lp * PH[i], j, src);
            }
        }
        const tr = TR[i] * sB * (1 - ss(yMay - 0.03 * fwF, yMay, y));
        if (tr > 0.02 && af[i] < 0.95) dat(tr * PH[i], i, g0);   // trả lại điểm ảnh gốc
        if (!TAT.bu && opt3 && sB > 0.01 && af[i] < 0.95) {
            const dac = ss(0.5, 0.9, PI[i]) * sB;
            if (dac > 0.01 && dac > aB) {
                const gx = MBf[y * VW + Math.min(VW - 1, x + 1)] - MBf[y * VW + Math.max(0, x - 1)], gy = MBf[Math.min(VH - 1, y + 1) * VW + x] - MBf[Math.max(0, y - 1) * VW + x];
                const gl = Math.hypot(gx, gy) || 1; let jj = -1;
                for (let d = 2; d < sau * 6; d += 2) { const tx = Math.round(x + gx / gl * d), ty = Math.round(y + gy / gl * d);
                    if (tx < 0 || ty < 0 || tx >= VW || ty >= VH) break; const j = ty * VW + tx; if (laToc(j)) { jj = j; break; } }
                if (jj >= 0) dat(dac, jj, src);
            }
        }
        // ghép: người TRÊN, tóc bổ sung DƯỚI
        const aO = aA + aB * (1 - aA);
        if (aO <= 0.002) { od[p + 3] = 0; continue; }
        const wA = aA / aO, wB = aB * (1 - aA) / aO;
        od[p] = src[p] * wA + rB * wB; od[p + 1] = src[p + 1] * wA + gB * wB; od[p + 2] = src[p + 2] * wA + bB * wB;
        od[p + 3] = Math.round(Math.min(1, aO) * 255);
    }
    // ===== DỰNG LẠI CHỎM ĐẦU =====
    // Chỏm đầu luôn là một vòm tròn liền; chỗ khuyết trên chỏm là AI xoá nhầm (tóc sáng lẫn màu phông).
    // 1) nối viền ngoài: đường bao trên mới = bao lồi dưới của đỉnh tóc từng cột (vòm trơn, không lõm)
    // 2) dựng phần trong: lấp bằng vân tóc thật ngay bên dưới (lật gương qua mép cũ, sợi tóc nối tiếp liền)
    let soChom = 0;
    if (!TAT.chom && opt3 && muc >= 2 && toc && phong) {
        const yE = r0.tran + 0.05 * fw / k, lim = 0.3 * fw / k, pts = [];
        // chỉ vùng CHỎM (đỉnh tóc nằm trên chân tóc trán); hai bên đầu không đụng
        const yCu = new Float32Array(VW).fill(-1);
        for (let x = 0; x < VW; x++) for (let y = 0; y < yE - 4; y++) { const i = y * VW + x;
            if (af[i] > 0.9 && af[i + VW] > 0.9 && af[i + 2 * VW] > 0.9 && af[i + 3 * VW] > 0.9) { yCu[x] = y; pts.push([x, y]); break; } }
        // bỏ gai: mảng lốm đốm đặc nổi cao hơn hẳn đỉnh tóc hai bên (trung vị cửa sổ) không phải chỏm
        { const rw = Math.max(3, Math.round(0.06 * fw / k)), cao = 0.025 * fw / k, giu = [];
          for (const p of pts) { const ys = []; for (let t = -rw; t <= rw; t++) { const u = p[0] + t; if (u >= 0 && u < VW && yCu[u] >= 0) ys.push(yCu[u]); }
              ys.sort((a, b) => a - b); const md = ys[ys.length >> 1]; if (p[1] < md - cao) yCu[p[0]] = md; else giu.push(p); }
          pts.length = 0; pts.push(...giu); }
        if (pts.length > 10) {
            const H = [];
            for (const p of pts) { while (H.length >= 2) { const [o, q] = [H[H.length - 2], H[H.length - 1]]; if ((q[0] - o[0]) * (p[1] - o[1]) - (q[1] - o[1]) * (p[0] - o[0]) <= 0) H.pop(); else break; } H.push(p); }
            const yV = new Float32Array(VW).fill(-1); let hi = 0;
            for (let x = 0; x < VW; x++) { if (yCu[x] === -1) continue; while (hi < H.length - 2 && H[hi + 1][0] < x) hi++;
                const [x0, y0] = H[hi], [x1, y1] = H[Math.min(hi + 1, H.length - 1)]; yV[x] = x1 === x0 ? y0 : y0 + (y1 - y0) * (x - x0) / (x1 - x0); }
            const rv = Math.max(2, Math.round(0.04 * fw / k)), yM = new Float32Array(VW).fill(-1);
            for (let x = 0; x < VW; x++) { if (yV[x] < 0) continue; let sm = 0, d = 0; for (let t = -rv; t <= rv; t++) { const u = x + t; if (u >= 0 && u < VW && yV[u] >= 0) { sm += yV[u]; d++; } } yM[x] = Math.min(yV[x] + 0.3 * rv, sm / d); }
            // QUY LUẬT CHUNG: chỗ lõm mà ảnh gốc RÕ LÀ PHÔNG (tóc–phông tương phản cao) là dáng thật (khe giữa mái, sóng
            // tóc) -> giữ; KHÔNG RÕ (tóc sáng lẫn phông) -> AI xoá nhầm -> dựng lại
            const dF = [toc[0] - phong[0], toc[1] - phong[1], toc[2] - phong[2]], d2 = dF[0] ** 2 + dF[1] ** 2 + dF[2] ** 2, tuongPhan = ss(1500, 4000, d2);
            const lam = new Float32Array(VW);
            for (let x = 0; x < VW; x++) {
                if (yCu[x] < 0) continue; const g = yCu[x] - yM[x]; if (g < 1.5 || g > lim) continue;
                let ro = 0, dm = 0;
                for (let y = Math.ceil(yM[x]); y < yCu[x]; y++) { const j = y * VW + x;
                    const t = ((g0[j * 4] - phong[0]) * dF[0] + (g0[j * 4 + 1] - phong[1]) * dF[1] + (g0[j * 4 + 2] - phong[2]) * dF[2]) / Math.max(1, d2);
                    ro += tuongPhan * (1 - ss(0.15, 0.4, t)); dm++; }
                lam[x] = dm ? 1 - ss(0.4, 0.7, ro / dm) : 0;
            }
            // mượt theo chiều ngang (không cắt dọc cứng giữa cột làm / không làm)
            const lamM = new Float32Array(VW);
            for (let x = 0; x < VW; x++) { let sm = 0, d = 0; for (let t = -rv; t <= rv; t++) { const u = x + t; if (u >= 0 && u < VW) { sm += lam[u]; d++; } } lamM[x] = sm / d; }
            const mem = Math.max(1.5, 0.012 * fw / k);
            // khe hẹp trên chỏm (bề ngang nhỏ) thì chắc chắn là khuyết do xoá nhầm, lấp dù màu gốc giống phông
            const hep = Math.round(0.12 * fw / k); let x0 = -1;
            for (let x = 0; x <= VW; x++) { const lom = x < VW && yCu[x] >= 0 && yCu[x] - yM[x] > 2;
                if (lom && x0 < 0) x0 = x; if (!lom && x0 >= 0) { if (x - x0 <= hep) for (let u = x0; u < x; u++) lam[u] = 1; x0 = -1; } }
            for (let x = 0; x < VW; x++) { let sm = 0, d = 0; for (let t = -rv; t <= rv; t++) { const u = x + t; if (u >= 0 && u < VW) { sm += lam[u]; d++; } } lamM[x] = sm / d; }
            for (let x = 0; x < VW; x++) {
                if (yCu[x] < 0) continue;
                // lỗ thủng / chấm lọt phông ngay dưới đỉnh tóc đặc: nằm trong tóc rồi, luôn lấp đặc bằng tóc chắc bên dưới
                const sau0 = Math.round(0.08 * fw / k);
                for (let y = Math.max(0, Math.round(yCu[x])); y < Math.min(VH - 1, yCu[x] + sau0); y++) {
                    const p = (y * VW + x) * 4, a0 = od[p + 3] / 255; if (a0 > 0.97) continue;
                    let ys = y + 1; while (ys < VH - 1 && ys < y + 2 * sau0 && af[ys * VW + x] < 0.95) ys++;
                    if (af[ys * VW + x] < 0.95) continue;
                    const q = (ys * VW + x) * 4;
                    for (let c = 0; c < 3; c++) od[p + c] = Math.round(od[p + c] * a0 + od[q + c] * (1 - a0));
                    od[p + 3] = 255; soChom++;
                }
                const w = lamM[x]; if (w < 0.02) continue;
                const yMoi = yM[x], yC = yCu[x], g = yC - yMoi;
                // trên vòm mới: bỏ mảng lốm đốm
                for (let y = 0; y < Math.floor(yMoi - mem); y++) { const p = (y * VW + x) * 4; if (od[p + 3] > 0) od[p + 3] = Math.round(od[p + 3] * (1 - w * (1 - ss(yMoi - mem - 0.02 * fw / k, yMoi - mem, y)))); }
                // dưới vòm: lỗ thủng, chấm xanh lọt phông trong lớp tóc sát chỏm -> lấp đặc bằng tóc chắc ngay bên dưới
                const sau = Math.round(0.08 * fw / k);
                for (let y = Math.max(0, Math.ceil(yMoi + mem)); y < Math.min(VH - 1, yC + sau); y++) {
                    const p = (y * VW + x) * 4, a0 = od[p + 3] / 255; if (a0 > 0.97) continue;
                    let ys = y + 1; while (ys < VH - 1 && ys < y + 2 * sau && af[ys * VW + x] < 0.95) ys++;
                    if (af[ys * VW + x] < 0.95) continue;
                    const q = (ys * VW + x) * 4, aa = a0 + (1 - a0) * w, mx = (aa - a0) / Math.max(1e-3, aa);
                    for (let c = 0; c < 3; c++) od[p + c] = Math.round(od[p + c] * (1 - mx) + od[q + c] * mx);
                    od[p + 3] = Math.round(aa * 255); soChom++;
                }
                if (g < 1.5) continue;
                for (let y = Math.max(0, Math.floor(yMoi - mem)); y < yC; y++) {
                    const al = w * ss(yMoi - mem, yMoi + mem, y); if (al <= 0.01) continue;
                    let ys = Math.round(2 * yC - y + 2); while (ys < VH - 1 && af[ys * VW + x] < 0.95 && ys < yC + 3 * g + 10) ys++;
                    ys = Math.min(VH - 1, ys);
                    const p = (y * VW + x) * 4, q = (ys * VW + x) * 4, a0 = od[p + 3] / 255, aa = a0 + al * (1 - a0), mx = al * (1 - a0) / Math.max(1e-3, aa);
                    for (let c = 0; c < 3; c++) od[p + c] = Math.round(od[p + c] * (1 - mx) + od[q + c] * mx);
                    od[p + 3] = Math.round(aa * 255); soChom++;
                }
            }
        }
    }
    const nguoi = document.createElement('canvas'); nguoi.width = VW; nguoi.height = VH; nguoi.getContext('2d').putImageData(out, 0, 0);
    return Object.assign({}, r0, { nguoi, muc, _goc: r0 });
}

export function suaToc(r, muc) {
    const goc = r && r._goc ? r._goc : r;
    if (!goc || !goc.af || !muc) return goc;
    return suaTocLoi(goc, muc, true);
}

// Đoán kiểu tóc để chọn mức sửa mặc định: 'xoan' (lọn xoăn) -> Tự nhiên; 'dai' (tóc rủ quá cằm) -> Rất gọn; còn lại -> Gọn
export function doanToc(r) {
    const goc = r && r._goc ? r._goc : r; if (!goc || !goc.af) return 'ngan';
    const { aAI, VW, VH } = goc.B;
    const fw = Math.hypot(goc.matP.x - goc.matT.x, goc.matP.y - goc.matT.y) * 2.2, cx = (goc.matT.x + goc.matP.x) / 2;
    // tóc dài: dưới cằm, ngoài cổ có nhiều mép mờ rộng của AI (sợi tóc); vai áo thì mép gọn
    let mo = 0;
    for (let y = Math.round(goc.cam); y < Math.min(VH, goc.cam + 0.4 * fw); y++) for (let x = 0; x < VW; x++) {
        if (Math.abs(x - cx) < 0.28 * fw) continue; const v = aAI[y * VW + x]; if (v > 0.1 && v < 0.9) mo++; }
    const dai = mo / (fw * fw);
    // xoăn: vùng tóc trên trán lỗ chỗ (tỉ lệ điểm nửa trong suốt trong vùng tóc)
    let nua = 0, toc = 0;
    for (let y = 0; y < goc.tran; y++) for (let x = Math.max(0, Math.round(cx - 0.7 * fw)); x < Math.min(VW, cx + 0.7 * fw); x++) {
        const v = aAI[y * VW + x]; if (v > 0.1) { toc++; if (v < 0.9) nua++; } }
    const xoan = toc ? nua / toc : 0;
    // (đo trên 26 ảnh mẫu: tóc thưa/hói cũng lỗ chỗ như tóc xoăn -> chỉ nhận xoăn khi vừa lỗ chỗ vừa nhiều sợi rủ)
    const kq = xoan > 0.28 && dai > 0.08 ? 'xoan' : dai > 0.055 ? 'dai' : 'ngan';
    if (typeof window !== 'undefined' && window.__doanDo) window.__doanDo.push([+xoan.toFixed(3), +dai.toFixed(3), kq]);
    return kq;
}

// Kéo thanh Gọn tóc / Độ mềm viền: chỉ chạy phần nhẹ trên kết quả đã tính sẵn (vài chục mili giây), kéo là ăn ngay
export function chinhNhanh(r, gon, mem) { return r && r.dung ? r.dung(gon, mem) : r; }

async function hoanThien(B, opt, bao, TG, moc) {
    TG = TG || {}; moc = moc || (() => {});
    if (opt.cachTach !== 'cu') {
        bao && bao('Đang làm sạch viền...', { buoc: 'vien', TG });
        await new Promise(ok => setTimeout(ok, 30));
        const r = tachMoi(B, opt); r.TG = TG; moc('mau');
        return r;
    }
    const { aAI, VW, VH, sc, m, mat, fh, goc0 } = B;
    const X = v => (v - B.X0) * sc, Y = v => (v - B.Y0) * sc;
    const g = new ImageData(new Uint8ClampedArray(B.g0.data), VW, VH);
    const gd = g.data;
    bao && bao('Đang làm sạch viền...', { buoc: 'vien', TG });
    // nhường một nhịp cho trang vẽ màn chờ trước khi tính nặng
    await new Promise(ok => setTimeout(ok, 30));
    const bg = banDoPhong(gd, aAI, VW, VH);
    // Mép: điểm gần màu phông ở chỗ AI chưa chắc thì trong suốt
    const a = new Float32Array(VW * VH);
    for (let y = 0, i = 0; y < VH; y++) for (let x = 0; x < VW; x++, i++) {
        const v = aAI[i];
        if (v <= 0 || v >= 0.995) { a[i] = v; continue; }
        const d = Math.hypot(gd[i * 4] - bg(x, y, 0), gd[i * 4 + 1] - bg(x, y, 1), gd[i * 4 + 2] - bg(x, y, 2));
        const ka = ss(10, 46, d), tin = ss(0.6, 0.95, v);
        a[i] = v * (ka + (1 - ka) * tin);
    }
    // Tinh viền: ép mép mặt nạ bám theo mép thật trong ảnh (lọc dẫn hướng theo độ sáng),
    // chỉ trong dải sát viền. Sửa mép mờ loang (áo trắng sát nền sáng), sợi tóc rõ hơn.
    tinhVien(a, gd, VW, VH);
    // Tự nhiên: dùng nguyên mặt nạ MODNet (mép mờ dần như thật), chỉ gỡ màu phông cũ ở mép
    if (opt.tho) a.set(aAI);
    // Vùng tóc mỏng: quanh điểm có nhiều điểm AI phân vân (dải mờ rộng, nhiều sợi). Mép vai, áo
    // chỉ mờ 2-4 điểm ảnh nên không lọt. Dùng để giữ tóc rủ xa má và không co mép ở dải tóc.
    const rc = Math.max(2, Math.round(0.0025 * Math.min(VW, VH)));
    let mem = null;
    if (opt.coMoi !== false) {
        const m0 = new Float32Array(VW * VH);
        for (let i = 0; i < m0.length; i++) m0[i] = aAI[i] > 0.1 && aAI[i] < 0.9 ? 1 : 0;
        mem = boxBlur(m0, VW, VH, Math.max(4, rc * 2));
    }
    const laToc = i => mem && mem[i] > (opt.nguongMo || 0.85);
    // Gọn: bỏ sợi mảnh hơn bán kính R, viền tròn, mép mềm 2px
    moc('phong');
    let af = a;
    // Vùng giữ quanh khối tóc (bước gọn): ngoài vùng này là tóc bay xa, bỏ
    let giu = null;
    // điểm tóc rủ được giữ lại sau bước gọn: lấy màu tóc thật, không lấy màu loang
    const tocRu = new Uint8Array(VW * VH);
    if (opt.gon > 0) {
        const R = Math.max(1, Math.round(opt.gon * Math.min(VW, VH) / 1000));
        // Khối tóc: làm mờ rồi cắt 2 lần, bỏ sợi mảnh hơn R, viền trơn
        let than = af;
        for (let it = 0; it < 2; it++) { than = boxBlur(than, VW, VH, R); for (let i = 0; i < than.length; i++) than[i] = than[i] > 0.5 ? 1 : 0; }
        if (opt.kieuGon === 'cu') af = boxBlur(than, VW, VH, 2);
        else {
            // Khối tóc chỉ dùng để chọn tóc bay xa cần bỏ. Mép khối tóc giữ đúng sợi thật của
            // AI (không cắt ngang sợi thành viền trơn như kéo cắt), nhạt dần trong dải hẹp D.
            const D = Math.max(2, Math.round(R * (opt.dai || 0.4)));
            const vung = boxBlur(boxBlur(than, VW, VH, D), VW, VH, D);
            af = new Float32Array(a.length); giu = new Float32Array(a.length);
            // Gọt theo độ đậm (mặc định): không khoét theo khoảng cách tới khối tóc (khoét vậy làm lọn tóc rủ
            // thành khe + sợi đứt). Vùng giữ chỉ còn dùng cho cách cũ (opt.kieuGon='xa').
            const loG = 0.035 * (opt.gon || 0), damG = opt.kieuGon !== 'xa';
            for (let i = 0; i < af.length; i++) { giu[i] = ss(0.02, 0.35, vung[i]); af[i] = damG ? a[i] * ss(loG * 0.5, loG + 0.4, a[i]) : a[i] * giu[i]; }
        }
        // giữ lại phần AI chắc chắn (tránh gọn ăn vào tai, vai)
        // Chỉ bảo vệ vùng quanh mặt (tai, tóc mai): ở đó AI chắc thì giữ. Chỗ khác để gọn cắt
        // cục lồi nhỏ ở viền (chấm bi, hoa văn phông dính vào đầu, vai)
        const ecx = X(mat.x), ecy = (Y(m.tran.y) + Y(m.cam.y)) / 2;
        const erx = 0.8 * (m.maP.x - m.maT.x) * sc, ery = 0.75 * fh * sc;
        for (let y = 0, i = 0; y < VH; y++) for (let xx = 0; xx < VW; xx++, i++) {
            if (!(aAI[i] > 0.98 && a[i] > 0.98)) continue;
            const ex = (xx - ecx) / erx, ey = (y - ecy) / ery;
            if (ex * ex + ey * ey < 1) af[i] = 1;
        }
        // Gọn chỉ được cắt bớt, không được lấp khe hẹp (khe giữa lọn tóc và cổ là phông)
        const aRong = boxBlur(a, VW, VH, 1);
        // Chỉ chặn ở chỗ gần như chắc là phông (a thấp); chỗ AI phân vân (áo trắng sát
        // phông sáng) giữ mép gọn sắc của bước trên, không để mép mờ loang ra
        // Điểm so màu thấy gần như chắc là phông thì gọn không được giữ (nếu giữ, điểm phông bị
        // tô màu tóc thành vệt viền đen quanh tóc); chuyển mềm để mép không răng cưa
        for (let i = 0; i < af.length; i++) if (aRong[i] < 0.3) af[i] = Math.min(af[i], ss(0.05, 0.3, aRong[i]));
        // Lọn tóc rủ dưới tầm mắt, sát hai bên má (xuống cằm, vai) là tóc thật: giữ lại với độ
        // mềm tự nhiên, chỉ bỏ sợi rất mờ. Càng xuống thấp càng giữ nhiều. Gọn chỉ dọn đỉnh và
        // hai bên đầu (tóc con, tóc rối); ngoài xa hai bên vai vẫn dọn (vật lạ dính vai).
        const yMat = Y(mat.y), yCam = Y(m.cam.y), cxm = X(mat.x), mw = (m.maP.x - m.maT.x) * sc;
        for (let y = Math.max(0, Math.round(yMat)); y < VH; y++) {
            const wy = ss(yMat, yCam, y);
            if (wy <= 0) continue;
            for (let xx = 0; xx < VW; xx++) {
                const i = y * VW + xx, k = a[i];
                // Dải tóc mỏng (tóc dài rủ xuống vai, xa má tới ~1,5 lần bề rộng mặt): giữ cả sợi mờ.
                // Chỗ khác chỉ giữ sát má, sợi rõ (không giữ viền mờ ở mép vai áo)
                const toc = laToc(i);
                if (k <= (toc ? 0.08 : 0.2)) continue;
                const wx = 1 - (toc ? ss(1.3 * mw, 1.7 * mw, Math.abs(xx - cxm)) : ss(0.75 * mw, 1.15 * mw, Math.abs(xx - cxm)));
                if (wx <= 0) continue;
                const v = (toc ? ss(0.08, 0.3, k) : ss(0.2, 0.45, k)) * k * wy * wx;
                if (v > af[i]) { af[i] = v; tocRu[i] = 1; }
            }
        }
    }
    // Thu mép vào ~1,5 điểm ảnh, mép mềm: bỏ phần mặt nạ lấn ra phông (AI ảnh thẻ hay lấn
    // 1-2 điểm), nếu không phần lấn bị tô màu tóc thành vệt viền đen
    if (opt.gon > 0 && opt.thu !== 0) {
        const mo = boxBlur(af, VW, VH, rc);
        // Không co dải tóc mỏng: co vào là xoá mất cả dải, thành miếng khuyết ở mép tóc
        // Chỉ co dưới cằm (vai, áo: chỗ AI hay lấn ra nền thành viền tối). Trên cằm là tóc: co vào thì
        // lọn tóc mỏng bị khoét thành khe, sợi đứt (đo: 0,90 -> 0,24 ở lọn tóc rủ ảnh phông nâu)
        // chuyển dần quanh cằm (dừng đột ngột ngay cằm thì thành bậc, mảng khuyết vuông)
        const yC0 = Y(m.cam.y) - 0.15 * fh * sc, yC1 = Y(m.cam.y) + 0.15 * fh * sc;
        for (let i = 0; i < af.length; i++) {
            if (laToc(i)) continue;
            const wC = opt.coTren ? 1 : ss(yC0, yC1, i / VW | 0); if (wC <= 0) continue;
            if (af[i] > 0 && af[i] < 1 || mo[i] < 1) af[i] = af[i] * (1 - wC) + Math.min(af[i], ss(0.55, 0.95, mo[i])) * wC;
        }
    }
    // Dải tóc: lấy mép mềm nguyên bản của MODNet (mờ dần như thật, chủ tiệm thích). Mép vai, áo
    // (dải mờ hẹp) giữ mép gọn đã xử lý ở trên.
    // Gọt tóc con theo ĐỘ ĐẬM (mặc định): sợi rõ giữ nguyên dù ở xa, chỉ sợi mờ như bóng ma nhạt dần.
    // Cách cũ gọt theo KHOẢNG CÁCH tới khối tóc (opt.kieuGon='xa') tỉa cụt sợi theo một đường trơn, trông giả.
    const theoDam = opt.kieuGon !== 'xa';
    const lo = 0.035 * (opt.gon || 0);
    // nhạt dần chậm (ngọn sợi mờ dần, không đứt cụt)
    const gotDam = v => lo > 0 ? v * ss(lo * 0.5, lo + 0.4, v) : v;
    // Mặt nạ MODNet đã làm nét theo ảnh gốc (opt.lamNet=false: dùng nguyên mặt nạ nhoè như trước)
    const aN = opt.lamNet === false ? aAI : lamNet(aAI, gd, VW, VH, Math.max(2, Math.round((opt.rNet || 0.0015) * Math.min(VW, VH))), opt.epsNet || 0.0002);
    // Chỉ làm nét ở vùng tóc (trên cằm): dưới cằm là áo, lọc theo ảnh sẽ bám cả đường may vai áo thành vệt + khe
    if (aN !== aAI) { const yC = Math.max(0, Math.min(VH, Math.round(Y(m.cam.y)))); aN.set(aAI.subarray(yC * VW), yC * VW); }
    const tocGoc = i => theoDam ? gotDam(aN[i]) : aN[i] * (giu ? giu[i] : 1);
    if (opt.tocMem !== false && mem) for (let i = 0; i < af.length; i++) {
        if (!laToc(i)) continue;
        const v = tocGoc(i);
        if (theoDam || v > af[i]) af[i] = v;
    }
    // Độ mềm viền (thanh 0-100): pha mép đã xử lý (sắc, gọn) với mép nguyên bản của MODNet (mờ dần
    // như thật). 0 = sắc như cũ, 100 = mềm như MODNet. Tóc bay xa (ngoài vùng giữ của Gọn) vẫn bỏ.
    // Kiểu Photoshop (mặc định): mép trơn cắt gọn rồi làm mềm (feather) vài điểm ảnh; thanh Độ mềm viền
    // là bán kính làm mềm. Chỗ có sợi tóc thật (mặt nạ lởm chởm, nhiều sợi) giữ nguyên, không cắt.
    // Mép mờ của AI rộng ~1% ảnh (24-30 điểm ảnh ở vùng 2500) nên trông như phủ một lớp nhoè.
    // ĐỒNG ĐỀU (mặc định, như thanh Contrast của Select and Mask): cùng một đường cong độ trong cho mọi điểm
    // ở mép, không cắt, không chia vùng. Dải mờ hẹp lại đều khắp đường viền, sợi tóc liền mạch, nhạt dần ở ngọn.
    // Chia vùng (sắc chỗ này, mềm chỗ kia) như kiểu 'ps' làm mép không đều, sợi đứt: mắt thấy giả ngay.
    if (opt.kieuMem !== 'cu' && opt.kieuMem !== 'ps') {
        const c = (opt.tuongPhan ?? 0.4) * (1 - Math.max(0, Math.min(1, (opt.mem ?? 30) / 100)));
        const sF = Math.min(VW, VH) / 1600, rL = Math.max(2, Math.round((opt.rTp ?? 3) * sF));
        // Chỉ làm hẹp phần mờ rộng của mép (lớp nhoè); chi tiết sợi tóc (phần chênh so với bản mờ) giữ nguyên,
        // không thì sợi tóc bay mờ thành từng mảng đặc lốm đốm
        const thap = boxBlur(boxBlur(af, VW, VH, rL), VW, VH, rL);
        for (let i = 0; i < af.length; i++) {
            const L = thap[i]; if (L <= 0 || L >= 1) continue;
            af[i] = Math.max(0, Math.min(1, ss(c, 1 - c, L) + (af[i] - L)));
        }
        af.set(boxBlur(af, VW, VH, Math.max(1, Math.round(0.8 * sF))));
    }
    if (opt.kieuMem === 'ps') {
        const n = VW * VH, sF = Math.min(VW, VH) / 1600;
        const f = Math.max(1, Math.round((0.8 + ((opt.mem ?? 30) / 100) * 6) * sF));
        const cung = new Float32Array(n);
        // Làm trơn trước khi cắt (như thanh Smooth của Photoshop): mép nhấp nhô quanh 50% cắt cứng sẽ thành vệt + khe
        const afm = boxBlur(af, VW, VH, Math.max(1, Math.round((opt.tron ?? 2) * sF)));
        for (let i = 0; i < n; i++) cung[i] = afm[i] > 0.5 ? 1 : 0;
        // Bỏ đường quá mảnh (1-2 điểm ảnh, vd mép mờ của AI dọc vai áo): cắt cứng thì thành vệt sáng rõ
        const mo1 = boxBlur(cung, VW, VH, Math.max(1, Math.round(1.5 * sF)));
        for (let i = 0; i < n; i++) cung[i] = mo1[i] > 0.5 ? 1 : 0;
        const mem2 = boxBlur(boxBlur(cung, VW, VH, f), VW, VH, f);
        const b2 = boxBlur(af, VW, VH, Math.max(1, Math.round(2 * sF)));
        const tx = new Float32Array(n);
        for (let i = 0; i < n; i++) tx[i] = Math.abs(af[i] - b2[i]);
        const tb = boxBlur(tx, VW, VH, Math.max(2, Math.round(3 * sF)));
        // Hai loại mép: mép trơn (vai, áo, tóc mượt) cắt gọn + làm mềm như Photoshop; vùng nhiều sợi tóc (mặt nạ
        // lởm chởm, hoặc dải tóc mờ rộng) giữ mép mềm liên tục như cũ. Cắt gọn vùng sợi thì thủng lỗ, sợi rời.
        // Trọng số chuyển mượt (làm mờ), không gạch ranh giới cứng. Sọc áo dưới cằm không tính là sợi.
        const yCam2 = Y(m.cam.y), kS = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            const tren = (i / VW | 0) < yCam2;
            kS[i] = Math.max(tren ? ss(opt.soiTu || 0.02, opt.soiDen || 0.07, tb[i]) : 0, laToc(i) ? 1 : 0);
        }
        const kM = boxBlur(boxBlur(kS, VW, VH, Math.max(2, Math.round(3 * sF))), VW, VH, Math.max(2, Math.round(3 * sF)));
        for (let i = 0; i < n; i++) { const k = Math.min(1, kM[i] * 1.5); af[i] = mem2[i] * (1 - k) + af[i] * k; }
        // So màu phông (tắt mặc định: tóc gần màu phông thì khoét lỗ lốm đốm)
        if (opt.soMau === true) for (let y = 0, i = 0; y < VH; y++) for (let x = 0; x < VW; x++, i++) {
            const v = af[i]; if (v <= 0.01 || v >= 0.995 || y >= yCam2) continue;
            const d = Math.hypot(gd[i * 4] - bg(x, y, 0), gd[i * 4 + 1] - bg(x, y, 1), gd[i * 4 + 2] - bg(x, y, 2));
            af[i] = v * ss(opt.mauTu ?? 6, opt.mauDen ?? 28, d);
        }
    }
    const mm = opt.kieuMem === 'cu' ? Math.max(0, Math.min(1, (opt.mem || 0) / 100)) : 0;
    if (mm > 0) for (let i = 0; i < af.length; i++) {
        const goc = laToc(i) ? tocGoc(i) : aN[i] * (giu ? giu[i] : 1);
        af[i] = af[i] * (1 - mm) + goc * mm;
    }
    // Bỏ mảnh rời (lọn tóc đứt, vệt phông): chỉ giữ khối người lớn nhất
    moc('gon');
    boDao(af, VW, VH);
    // Màu mép: loang màu từ phần chắc chắn là người ra mép (mép tóc lấy màu tóc), không dính màu phông cũ
    const CH = 0.97, rb = Math.max(3, Math.round(Math.min(VW, VH) / 220));
    // Màu loang vốn mờ: tính trên ảnh thu nhỏ f lần cho nhanh (điện thoại), rồi nội suy lại
    const loang = (r, f) => {
        const w2 = Math.ceil(VW / f), h2 = Math.ceil(VH / f), n2 = w2 * h2;
        const wv = new Float32Array(n2), kr = [0, 1, 2].map(() => new Float32Array(n2));
        for (let y = 0, i = 0; y < VH; y++) for (let x = 0; x < VW; x++, i++) {
            if (!(a[i] > CH && aAI[i] > 0.9)) continue;
            const e = ((y / f) | 0) * w2 + ((x / f) | 0);
            wv[e]++; for (let j = 0; j < 3; j++) kr[j][e] += gd[i * 4 + j];
        }
        // blur 3 lượt ~ Gaussian: không tạo khối vuông sắc cạnh như box blur 1 lượt
        const rr = Math.max(1, Math.round(r / f));
        const mo3 = m => boxBlur(boxBlur(boxBlur(m, w2, h2, rr), w2, h2, rr), w2, h2, rr);
        const W = mo3(wv), C = kr.map(mo3);
        // lấy mẫu song tuyến: [trọng số, r, g, b] tại điểm (x, y) của ảnh lớn
        return (x, y) => {
            const fx = Math.min(w2 - 1.001, Math.max(0, (x + 0.5) / f - 0.5)), fy = Math.min(h2 - 1.001, Math.max(0, (y + 0.5) / f - 0.5));
            const x0 = fx | 0, y0 = fy | 0, dx = fx - x0, dy = fy - y0;
            const i00 = y0 * w2 + x0, i10 = i00 + 1, i01 = i00 + w2, i11 = i01 + 1;
            const k00 = (1 - dx) * (1 - dy), k10 = dx * (1 - dy), k01 = (1 - dx) * dy, k11 = dx * dy;
            const v = m => (m[i00] * k00 + m[i10] * k10 + m[i01] * k01 + m[i11] * k11) / (f * f);
            return [v(W), v(C[0]), v(C[1]), v(C[2])];
        };
    };
    moc('dao');
    const L1 = loang(rb, 2), L2 = loang(rb * 4, 4);
    moc('loang');
    // Ghép màu: gỡ màu phông khỏi điểm bán trong suốt
    for (let y = 0, i = 0; y < VH; y++) for (let x = 0; x < VW; x++, i++) {
        const v = af[i], p = i * 4;
        if (v <= 0.01) { gd[p + 3] = 0; continue; }
        if (opt.loang !== false && (v < 0.99 || a[i] <= CH)) {
            // trộn mượt loang gần (ưu tiên) và loang xa, tránh vệt cắt ngang
            const l1 = L1(x, y), l2 = L2(x, y), lw = l1[0] * 8 + l2[0];
            if (lw > 0.002) {
                // Mép: ưu tiên màu thật của ngọn tóc (đã gỡ màu phông); chỉ chỗ gần như là phông
                // mới lấy màu loang từ trong ra. Lấy màu loang nhiều thì ngọn tóc bị tô đậm thành viền đen.
                // Mặc định giữ màu thật từng điểm ảnh (như Photoshop: làm mềm chỉ đổi độ trong, không
                // đổi màu), chỉ trừ phần màu phông lẫn vào theo độ trong cuối. Cách cũ (opt.kieuMau='cu')
                // tô mép bằng màu loang (màu tóc trung bình) nên mất kết cấu sợi, như phủ một lớp nhoè.
                // Mặc định tô màu tóc cho sợi mảnh (cách cũ): giữ màu gốc thì sợi tóc mảnh lẫn màu phông sáng, viền xám
                const giuMau = opt.kieuMau === 'goc';
                const aa = giuMau ? Math.max(v, 0.15) : Math.max(a[i], 0.22);
                const tr = giuMau ? ss(0.02, 0.12, v) : opt.gon > 0 ? ss(0.1, 0.45, a[i]) : Math.pow(Math.min(1, a[i]), 2);
                for (let j = 0; j < 3; j++) {
                    const B = bg(x, y, j), C = gd[p + j], Lc = (l1[j + 1] * 8 + l2[j + 1]) / lw;
                    // gỡ màu phông, nhưng không cho đậm/nhạt quá màu tóc bên trong (đoán độ trong
                    // thấp hơn thật thì công thức gỡ quá tay, ra viền đen)
                    let F = B + (C - B) / aa;
                    F = Math.max(Math.min(C, Lc), Math.min(Math.max(C, Lc), F));
                    gd[p + j] = Math.round(Lc * (1 - tr) + F * tr);
                }
            }
        }
        gd[p + 3] = Math.round(v * 255);
    }
    moc('mau');
    const nguoi = veCanvas(VW, VH);
    nguoi.getContext('2d').putImageData(g, 0, 0);

    // Đỉnh đầu: hàng trên cùng có tóc trong dải giữa mặt
    const cxv = X(mat.x), rong = Math.max(4, (m.maP.x - m.maT.x) * sc * 0.35);
    let dinh = Y(m.tran.y) - 0.4 * fh * sc;
    for (let y = 0; y < VH; y++) {
        let co = 0; for (let x = Math.round(cxv - rong); x <= Math.round(cxv + rong); x++) { if (x >= 0 && x < VW && af[y * VW + x] > 0.5) co++; }
        if (co > rong * 0.6) { dinh = y; break; }
    }
    const dbg = opt.dbg ? { vung: B.vung, aAI, a, af, mem, VW, VH } : undefined;
    return {
        B, gon: opt.gon, dbg, TG, nguoi, xoay: +(goc0 * 180 / Math.PI).toFixed(1), nghieng: B.nghieng,
        // toạ độ trong khung "nguoi"
        mat: { x: cxv, y: Y(mat.y) }, cam: Y(m.cam.y), dinh, tran: Y(m.tran.y), matT: { x: X(m.matT.x), y: Y(m.matT.y) }, matP: { x: X(m.matP.x), y: Y(m.matP.y) }
    };
}

// ---------- 4. Cắt đúng khổ, đặt nền ----------
// kho: { w, h } (mm); dau: tỉ lệ (đỉnh đầu -> cằm) / chiều cao ảnh; tren: khoảng trên đỉnh đầu / chiều cao
// lech: { x: dời ngang (tỉ lệ bề rộng ảnh), xoay: độ } do khách kéo, xoay bằng tay
export function catThe(r, kho, nen, dau, tren, dpi, lech) {
    dpi = dpi || 300;
    // Ảnh đã có nền sẵn: phần ngoài ảnh tô đúng màu nền đó
    if (r.nenGoc) nen = r.nenGoc;
    const OW = Math.round(kho.w / 25.4 * dpi), OH = Math.round(kho.h / 25.4 * dpi);
    const c = veCanvas(OW, OH), x = c.getContext('2d');
    x.fillStyle = nen; x.fillRect(0, 0, OW, OH);
    const k = (dau * OH) / (r.cam - r.dinh);          // phóng để đầu đúng tỉ lệ khung
    const ox = OW / 2 + ((lech && lech.x) || 0) * OW - r.mat.x * k, oy = tren * OH - r.dinh * k;
    // Lớp người cỡ khung, hoà viền: mép tóc, mép vai ánh nhẹ màu nền mới (như chụp thật
    // trước phông đó), hết cảm giác cắt dán. Chỉ ở mép 1-3 điểm ảnh, không đụng mặt.
    const p = veCanvas(OW, OH), px = p.getContext('2d');
    px.imageSmoothingQuality = 'high';
    if (lech && lech.xoay) {
        // xoay quanh giữa mặt
        const tx = ox + r.mat.x * k, ty = oy + r.mat.y * k;
        px.translate(tx, ty); px.rotate(lech.xoay * Math.PI / 180); px.translate(-tx, -ty);
    }
    px.drawImage(r.nguoi, ox, oy, r.nguoi.width * k, r.nguoi.height * k);
    px.setTransform(1, 0, 0, 1, 0, 0);
    // đang kéo thanh (r._nhanh): bỏ bước hoà viền (nặng) cho mượt tay, thả tay vẽ đủ
    if (r._nhanh) { x.drawImage(p, 0, 0); p.width = p.height = 0; return c; }
    const d = px.getImageData(0, 0, OW, OH), pd = d.data, n = OW * OH;
    const A = new Float32Array(n); for (let i = 0; i < n; i++) A[i] = pd[i * 4 + 3] / 255;
    const Ab = boxBlur(boxBlur(A, OW, OH, Math.max(1, Math.round(OW / 240))), OW, OH, Math.max(1, Math.round(OW / 240)));
    const N = [1, 3, 5].map(j => parseInt(nen.slice(j, j + 2), 16));
    for (let i = 0; i < n; i++) {
        if (A[i] <= 0) continue;
        // 25%: 45% làm mép tóc ám màu nền mới thành dải lem khi soi gần
        const w = (r.hoaVien ?? 0.25) * Math.max(0, 1 - Ab[i]);
        if (w <= 0.003) continue;
        for (let j = 0; j < 3; j++) pd[i * 4 + j] = pd[i * 4 + j] * (1 - w) + N[j] * w;
    }
    px.putImageData(d, 0, 0);
    x.drawImage(p, 0, 0);
    p.width = p.height = 0;
    return c;
}

// ---------- 5b. Tờ in 10x15 nhiều khổ ----------
// ds: [{ c: ảnh thẻ, so: số tấm }]. Xếp theo hàng (khổ to trước), thử tờ dọc và ngang,
// chọn chiều xếp được nhiều hơn. Trả { c, xep: số tấm đã xếp, tong: số tấm muốn xếp }.
export function xepTo(ds, dpi) {
    dpi = dpi || 300;
    const gap = Math.round(2 / 25.4 * dpi);
    const tam = [];
    ds.filter(d => d.so > 0).sort((a, b) => b.c.height - a.c.height).forEach(d => { for (let i = 0; i < d.so; i++) tam.push(d.c); });
    const thu = (PW, PH) => {
        const vi = []; let x = gap, y = gap, hang = 0;
        for (const t of tam) {
            if (x + t.width + gap > PW) { x = gap; y += hang + gap; hang = 0; }
            if (y + t.height + gap > PH || t.width + 2 * gap > PW) break;
            vi.push([t, x, y]); x += t.width + gap; hang = Math.max(hang, t.height);
        }
        return { PW, PH, vi };
    };
    const doc = thu(Math.round(4 * dpi), Math.round(6 * dpi)), ngang = thu(Math.round(6 * dpi), Math.round(4 * dpi));
    const T = doc.vi.length >= ngang.vi.length ? doc : ngang;
    const c = veCanvas(T.PW, T.PH), x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, T.PW, T.PH);
    // canh giữa cả khối ảnh trên tờ
    const mx = T.vi.reduce((m, [t, a]) => Math.max(m, a + t.width), 0), my = T.vi.reduce((m, [t, , b]) => Math.max(m, b + t.height), 0);
    const dx = Math.round((T.PW - gap - mx) / 2), dy = Math.round((T.PH - gap - my) / 2);
    x.strokeStyle = '#bbb'; x.lineWidth = 1;
    for (const [t, a, b] of T.vi) { x.drawImage(t, a + dx, b + dy); x.strokeRect(a + dx - 0.5, b + dy - 0.5, t.width + 1, t.height + 1); }
    return { c, xep: T.vi.length, tong: tam.length };
}

// ---------- 5. Tờ in 10x15 (4x6 inch), nhiều ảnh, có đường cắt ----------
export function toIn(anh, kho, so, dpi) {
    dpi = dpi || 300;
    const gap = Math.round(2 / 25.4 * dpi), w = anh.width, h = anh.height;
    // Tờ 10x15: thử cả dọc lẫn ngang, chọn chiều xếp được nhiều ảnh hơn
    const vua = (PW, PH) => ({ PW, PH, cot: Math.max(1, Math.floor((PW - gap) / (w + gap))), hang: Math.max(1, Math.floor((PH - gap) / (h + gap))) });
    const doc = vua(Math.round(4 * dpi), Math.round(6 * dpi)), ngang = vua(Math.round(6 * dpi), Math.round(4 * dpi));
    const { PW, PH, cot, hang } = doc.cot * doc.hang >= ngang.cot * ngang.hang ? doc : ngang;
    const c = veCanvas(PW, PH), x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, PW, PH);
    const n = Math.min(so || cot * hang, cot * hang);
    const tw = cot * w + (cot - 1) * gap, th = Math.ceil(n / cot) * h + (Math.ceil(n / cot) - 1) * gap;
    const x0 = (PW - tw) / 2, y0 = (PH - th) / 2;
    x.strokeStyle = '#bbb'; x.lineWidth = 1;
    for (let i = 0; i < n; i++) {
        const px = x0 + (i % cot) * (w + gap), py = y0 + Math.floor(i / cot) * (h + gap);
        x.drawImage(anh, px, py);
        x.strokeRect(px - 0.5, py - 0.5, w + 1, h + 1);   // đường cắt
    }
    return { c, so: n };
}

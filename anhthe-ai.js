// ===== Luồng riêng chạy AI xoá phông =====
// Chạy ở luồng riêng để trang không bị đứng: vòng xoay, đếm ngược giây vẫn chạy.
// kieu 'fp32' | 'q8': MODNet gốc qua transformers.js (Xenova/modnet)
// kieu 'hivision' | 'hivision-rgb': MODNet huấn luyện riêng cho ảnh thẻ nền trơn
//   (HivisionIDPhotos, Apache-2.0), chạy thẳng bằng onnxruntime-web
import { pipeline, RawImage, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1/dist/transformers.min.js';
// Mở qua http trong wifi (phòng thử trên điện thoại) thì trình duyệt không cho bộ nhớ đệm: tải lại mỗi lần
if (!self.isSecureContext || typeof caches === 'undefined') env.useBrowserCache = false;

const ORT = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';
let SEG = null, HV = null, KIEU = '';

// Tải tệp AI có báo tiến độ, giữ trong bộ nhớ đệm trình duyệt (lần sau không tải lại)
async function taiTep(url, bao) {
    let kho = null;
    try { if (self.isSecureContext && typeof caches !== 'undefined') kho = await caches.open('pn-anhthe-ai'); } catch (e) {}
    if (kho) { const co = await kho.match(url); if (co) return new Uint8Array(await co.arrayBuffer()); }
    const r = await fetch(url);
    if (!r.ok) throw new Error('Không tải được tệp AI (' + r.status + ')');
    const tong = +r.headers.get('content-length') || 0, doc = r.body.getReader(), phan = [];
    let da = 0;
    for (;;) { const { done, value } = await doc.read(); if (done) break; phan.push(value); da += value.length; bao(da, tong); }
    const out = new Uint8Array(da); let o = 0; for (const p of phan) { out.set(p, o); o += p.length; }
    if (kho) { try { await kho.put(url, new Response(out)); } catch (e) {} }
    return out;
}

async function napHivision(url) {
    const ort = await import(ORT + 'ort.wasm.min.mjs');
    ort.env.wasm.wasmPaths = ORT;
    const tep = await taiTep(url, (da, tong) => self.postMessage({ t: 'tai', da, tong }));
    return { ort, s: await ort.InferenceSession.create(tep, { executionProviders: ['wasm'] }) };
}

// Ảnh RGBA w×h -> mặt nạ 0-255 w×h bằng hivision_modnet (vào 512×512, chuẩn hoá về -1..1)
async function chayHivision(data, w, h, rgb) {
    const N = 512;
    const goc = new OffscreenCanvas(w, h); goc.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(data), w, h), 0, 0);
    const nho = new OffscreenCanvas(N, N), nx = nho.getContext('2d');
    nx.imageSmoothingQuality = 'high'; nx.drawImage(goc, 0, 0, N, N);
    const d = nx.getImageData(0, 0, N, N).data, t = new Float32Array(3 * N * N), n = N * N;
    // HivisionIDPhotos đọc ảnh bằng OpenCV nên thứ tự kênh mặc định là B, G, R
    const kenh = rgb ? [0, 1, 2] : [2, 1, 0];
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) t[c * n + i] = (d[i * 4 + kenh[c]] / 255 - 0.5) / 0.5;
    const { ort, s } = HV;
    const ra = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', t, [1, 3, N, N]) });
    const m = ra[s.outputNames[0]].data;
    // phóng mặt nạ về cỡ vùng ảnh
    const mc = new OffscreenCanvas(N, N), md = mc.getContext('2d').createImageData(N, N);
    for (let i = 0; i < n; i++) { const v = Math.max(0, Math.min(255, m[i] * 255)); md.data[i * 4] = md.data[i * 4 + 1] = md.data[i * 4 + 2] = v; md.data[i * 4 + 3] = 255; }
    mc.getContext('2d').putImageData(md, 0, 0);
    const lon = new OffscreenCanvas(w, h), lx = lon.getContext('2d');
    lx.imageSmoothingQuality = 'high'; lx.drawImage(mc, 0, 0, w, h);
    const ld = lx.getImageData(0, 0, w, h).data, a = new Uint8Array(w * h);
    for (let i = 0; i < a.length; i++) a[i] = ld[i * 4];
    return a;
}

self.onmessage = async e => {
    const m = e.data;
    if (m.t === 'nap') {
        try {
            KIEU = m.kieu || 'fp32';
            if (KIEU.startsWith('hivision')) {
                HV = HV || await napHivision(m.url);
            } else {
                // Báo số MB đã tải (lần đầu trên máy khách); lần sau lấy từ bộ nhớ máy, rất nhanh
                const tep = {};
                const tienDo = p => {
                    if (p.status !== 'progress' || !p.total) return;
                    tep[p.file] = p;
                    const v = Object.values(tep);
                    self.postMessage({ t: 'tai', da: v.reduce((x, y) => x + y.loaded, 0), tong: v.reduce((x, y) => x + y.total, 0) });
                };
                // Chỉ WASM: chạy được mọi máy (WebGPU treo trên máy không có chip đồ hoạ thật)
                SEG = SEG || await pipeline('background-removal', 'Xenova/modnet', { dtype: KIEU, device: 'wasm', progress_callback: tienDo });
            }
            self.postMessage({ t: 'san' });
        } catch (err) { self.postMessage({ t: 'loi', msg: String(err && err.message || err) }); }
        return;
    }
    if (m.t === 'chay') {
        try {
            let a;
            if (KIEU.startsWith('hivision')) a = await chayHivision(m.data, m.w, m.h, KIEU === 'hivision-rgb');
            else {
                // Cỡ AI nhìn ảnh (cạnh ngắn), mặc định của MODNet là 512
                const ip = SEG.processor && (SEG.processor.image_processor || (SEG.processor.components || {}).image_processor || (SEG.processor.components || {}).feature_extractor);
                if (m.co && ip) ip.size = { shortest_edge: m.co };
                let kq = await SEG(new RawImage(new Uint8ClampedArray(m.data), m.w, m.h, 4));
                if (Array.isArray(kq)) kq = kq[0];
                if (kq.width !== m.w || kq.height !== m.h) kq = await kq.resize(m.w, m.h);
                // Chỉ trả kênh trong suốt (mặt nạ người)
                a = new Uint8Array(m.w * m.h); const c = kq.channels;
                for (let i = 0; i < a.length; i++) a[i] = c === 4 ? kq.data[i * 4 + 3] : kq.data[i * c];
            }
            self.postMessage({ t: 'xong', id: m.id, a }, [a.buffer]);
        } catch (err) { self.postMessage({ t: 'loi', id: m.id, msg: String(err && err.message || err) }); }
    }
};

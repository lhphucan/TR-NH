// ===== Ghép ảnh vào frame: phần dùng chung cho trang quản lý và trang khách =====
// Frame là ảnh PNG đục lỗ trong suốt. Mỗi ô ảnh lưu theo toạ độ thật của frame:
// tâm (cx, cy), rộng w, cao h, góc xoay rot (độ). Ảnh trong ô lưu theo ô:
// s là độ phóng (1 = vừa phủ kín ô), ox/oy là độ dời tính theo bề rộng/cao ô,
// r là góc xoay ảnh (bội 90). Khung xem trên màn và ảnh xuất ra dùng chung các
// phép tính dưới đây, chỉ khác tỷ lệ, nên chỗ khách thấy là chỗ được in.

const FR = (() => {

    // Ảnh trên Drive lấy thẳng từ Google bằng mã file. =s0 là bản gốc nguyên vẹn
    // (đã đối chiếu mã băm, khớp từng byte). File phải để chế độ ai có link cũng xem.
    const gUrl = (id, size) => 'https://lh3.googleusercontent.com/d/' + id + '=s' + (size || 0);

    function loadImg(src) {
        return new Promise((ok, fail) => {
            const im = new Image();
            // Ảnh Google cho phép đọc chéo; thiếu dòng này thì vẽ vào khung xong không xuất được
            if (/^https?:/.test(src)) im.crossOrigin = 'anonymous';
            im.onload = () => ok(im);
            im.onerror = () => fail(new Error('Không đọc được ảnh'));
            im.src = src;
        });
    }

    // Bản nhỏ để xem cho nhẹ; bản gốc chỉ mở lúc ghép thật
    async function shrink(blob, maxSide, type) {
        const u = URL.createObjectURL(blob);
        try {
            const im = await loadImg(u);
            const nw = im.naturalWidth, nh = im.naturalHeight;
            const k = Math.min(1, maxSide / Math.max(nw, nh));
            const c = document.createElement('canvas');
            c.width = Math.round(nw * k); c.height = Math.round(nh * k);
            c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
            const out = await new Promise(r => c.toBlob(r, type, 0.88));
            c.width = c.height = 0;
            return { blob: out, nw, nh };
        } finally { URL.revokeObjectURL(u); }
    }

    // Máy yếu có giới hạn cỡ khung vẽ (iPhone khoảng 16,7 triệu điểm ảnh), vượt
    // thì không báo lỗi mà ra ảnh trắng. Thử thật trên máy đang dùng rồi mới vẽ.
    function canvasFor(W, H) {
        for (const s of [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3]) {
            const w = Math.round(W * s), h = Math.round(H * s);
            try {
                const c = document.createElement('canvas');
                c.width = w; c.height = h;
                const x = c.getContext('2d');
                if (!x) continue;
                x.fillStyle = '#ff0000';
                x.fillRect(w - 1, h - 1, 1, 1);
                const d = x.getImageData(w - 1, h - 1, 1, 1).data;
                if (d[0] === 255 && d[3] === 255) { x.clearRect(w - 1, h - 1, 1, 1); return { c, x, s }; }
                c.width = c.height = 0;
            } catch (e) { /* thử cỡ nhỏ hơn */ }
        }
        return null;
    }

    // ---------- Tự nhận lỗ đục ----------
    // Tìm các vùng trong suốt khép kín rồi tạo sẵn ô cho từng vùng. Vùng chạm
    // mép ảnh là nền ngoài frame, không phải lỗ. Vùng quá nhỏ là vết trong suốt
    // lặt vặt (khe chữ, bóng đổ), bỏ.
    async function detectHoles(prevBlob, W, H) {
        const u = URL.createObjectURL(prevBlob);
        let w, h, px;
        try {
            const im = await loadImg(u);
            w = im.naturalWidth; h = im.naturalHeight;
            const c = document.createElement('canvas'); c.width = w; c.height = h;
            const x = c.getContext('2d');
            x.drawImage(im, 0, 0);
            px = x.getImageData(0, 0, w, h).data;
            c.width = c.height = 0;
        } finally { URL.revokeObjectURL(u); }

        const N = w * h, clear = new Uint8Array(N), seen = new Uint8Array(N), stack = new Int32Array(N);
        for (let i = 0; i < N; i++) clear[i] = px[i * 4 + 3] < 128 ? 1 : 0;

        const holes = [];
        for (let start = 0; start < N; start++) {
            if (!clear[start] || seen[start]) continue;
            let sp = 0, count = 0, edge = false;
            const pts = [];
            stack[sp++] = start; seen[start] = 1;
            while (sp) {
                const p = stack[--sp], x = p % w, y = (p - x) / w;
                count++;
                if (x === 0 || y === 0 || x === w - 1 || y === h - 1) edge = true;
                if (!(x & 1) && !(y & 1)) pts.push(x, y);   // lấy mẫu cách điểm cho nhanh
                if (x > 0 && clear[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack[sp++] = p - 1; }
                if (x < w - 1 && clear[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack[sp++] = p + 1; }
                if (y > 0 && clear[p - w] && !seen[p - w]) { seen[p - w] = 1; stack[sp++] = p - w; }
                if (y < h - 1 && clear[p + w] && !seen[p + w]) { seen[p + w] = 1; stack[sp++] = p + w; }
            }
            if (edge || count < N * 0.004) continue;
            holes.push(fitRect(pts));
        }

        // Đổi về cỡ frame thật, chừa thêm mép để viền frame che, không lộ khe trắng
        const k = W / w, bleed = Math.round(Math.max(W, H) * 0.003);
        const slots = holes.map(r => ({ cx: r.cx * k, cy: r.cy * k, w: r.w * k + bleed * 2, h: r.h * k + bleed * 2, rot: r.rot }));
        // Xếp theo hàng từ trên xuống, trong hàng từ trái sang
        slots.sort((a, b) => Math.abs(a.cy - b.cy) < Math.min(a.h, b.h) / 2 ? a.cx - b.cx : a.cy - b.cy);
        return slots.map(s => ({ cx: Math.round(s.cx), cy: Math.round(s.cy), w: Math.round(s.w), h: Math.round(s.h), rot: s.rot }));
    }

    // Hình chữ nhật nhỏ nhất ôm được vùng lỗ, kể cả lỗ đục nghiêng
    function fitRect(pts) {
        const n = pts.length / 2;
        const box = deg => {
            const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
            let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
            for (let i = 0; i < n; i++) {
                const x = pts[i * 2], y = pts[i * 2 + 1];
                const u = x * c + y * s, v = -x * s + y * c;
                if (u < u0) u0 = u; if (u > u1) u1 = u;
                if (v < v0) v0 = v; if (v > v1) v1 = v;
            }
            // +2: điểm lấy mẫu cách 2, mép thật nằm xa hơn điểm mẫu cuối
            return { deg, u0, u1, v0, v1, area: (u1 - u0 + 2) * (v1 - v0 + 2) };
        };
        let best = box(0);
        for (let d = -45; d < 45; d += 1) { const b = box(d); if (b.area < best.area - 1e-6) best = b; }
        for (let d = best.deg - 1; d <= best.deg + 1; d += 0.1) { const b = box(d); if (b.area < best.area - 1e-6) best = b; }
        // Lệch dưới 1,5 độ coi như thẳng: lỗ đục thẳng là chuyện thường
        if (Math.abs(best.deg) < 1.5) best = box(0);
        const a = best.deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
        const mu = (best.u0 + best.u1) / 2 + 0.5, mv = (best.v0 + best.v1) / 2 + 0.5;
        return { cx: mu * c - mv * s, cy: mu * s + mv * c, w: best.u1 - best.u0 + 2, h: best.v1 - best.v0 + 2,
                 rot: Math.round(((best.deg % 360) + 360) % 360 * 10) / 10 };
    }

    // ---------- Ảnh trong ô ----------
    // Ảnh luôn phủ kín ô (như ảnh đại diện mạng xã hội): khỏi lộ khe trắng khi in
    function geom(slot, p) {
        const odd = p.r % 180 !== 0;
        const iw = odd ? p.ih : p.iw, ih = odd ? p.iw : p.ih;
        const cover = Math.max(slot.w / iw, slot.h / ih);
        const dw = iw * cover * p.s, dh = ih * cover * p.s;
        return { cover, maxX: Math.max(0, (dw - slot.w) / 2), maxY: Math.max(0, (dh - slot.h) / 2) };
    }

    function clamp(slot, p) {
        if (!p) return;
        p.s = Math.min(4, Math.max(1, p.s));
        const g = geom(slot, p);
        p.ox = Math.max(-g.maxX / slot.w, Math.min(g.maxX / slot.w, p.ox));
        p.oy = Math.max(-g.maxY / slot.h, Math.min(g.maxY / slot.h, p.oy));
    }

    // Điểm (toạ độ frame) rơi vào ô nào, ô có thể đang xoay
    function slotAt(slots, fx, fy) {
        for (let i = slots.length - 1; i >= 0; i--) {
            const s = slots[i], a = -s.rot * Math.PI / 180;
            const dx = fx - s.cx, dy = fy - s.cy;
            const lx = dx * Math.cos(a) - dy * Math.sin(a), ly = dx * Math.sin(a) + dy * Math.cos(a);
            if (Math.abs(lx) <= s.w / 2 && Math.abs(ly) <= s.h / 2) return i;
        }
        return -1;
    }

    // Vị trí ô trên màn khi frame hiện với tỷ lệ k
    function boxCss(s, k) {
        return `left:${(s.cx - s.w / 2) * k}px; top:${(s.cy - s.h / 2) * k}px; width:${s.w * k}px; height:${s.h * k}px; transform:rotate(${s.rot}deg);`;
    }

    // ---------- Ghép thành ảnh ----------
    // frame: { w, h, front, slots }; frameSrc: link ảnh frame; photos[i]: ảnh của
    // ô i hoặc null; photoSrc(p): link ảnh để vẽ (bản nhỏ khi xem, bản gốc khi ghép)
    // baked: bảng màu của bộ lọc frame (tuỳ chọn), áp riêng vùng từng ô ngay sau khi vẽ ảnh
    async function compose(ctx, sc, frame, frameSrc, photos, photoSrc, onStep, baked) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, frame.w * sc, frame.h * sc);

        const fImg = await loadImg(frameSrc);
        if (!frame.front) ctx.drawImage(fImg, 0, 0, frame.w * sc, frame.h * sc);

        for (let i = 0; i < frame.slots.length; i++) {
            const p = photos[i];
            if (!p) continue;
            if (onStep) onStep(i);
            // Mở từng ảnh gốc một rồi bỏ ngay: sáu ảnh 12 MP mở cùng lúc là
            // gần 300 MB, iPhone cũ đóng trang ngay.
            const im = await loadImg(photoSrc(p));
            const s = frame.slots[i], g = geom(s, p);
            ctx.save();
            ctx.translate(s.cx * sc, s.cy * sc);
            ctx.rotate(s.rot * Math.PI / 180);
            ctx.beginPath();
            ctx.rect(-s.w / 2 * sc, -s.h / 2 * sc, s.w * sc, s.h * sc);
            ctx.clip();
            ctx.translate(p.ox * s.w * sc, p.oy * s.h * sc);
            ctx.rotate(p.r * Math.PI / 180);
            const dw = p.iw * g.cover * p.s * sc, dh = p.ih * g.cover * p.s * sc;
            ctx.drawImage(im, -dw / 2, -dh / 2, dw, dh);
            ctx.restore();
            im.src = '';
            if (baked) filterSlot(ctx, s, sc, baked);
        }

        if (frame.front) ctx.drawImage(fImg, 0, 0, frame.w * sc, frame.h * sc);
        fImg.src = '';
    }

    // ---------- Tải file lớn lên Drive ----------
    // Gửi từng đoạn 2 MB: mạng đứt giữa chừng thì hỏi Drive đã nhận tới đâu rồi
    // gửi tiếp từ đó, không phải gửi lại cả file 10-20 MB. Đã đo trên trang thật:
    // đọc được mã 308 và phần đã nhận, gửi lặp một đoạn cũng không hỏng file.
    async function upload(blob, name, token, folderId, onProgress) {
        const total = blob.size;
        const init = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json; charset=UTF-8',
                       'X-Upload-Content-Type': blob.type || 'image/png', 'X-Upload-Content-Length': String(total) },
            body: JSON.stringify({ name, parents: [folderId] })
        });
        if (!init.ok) throw new Error('Drive từ chối (HTTP ' + init.status + ')');
        const loc = init.headers.get('Location');
        if (!loc) throw new Error('Không mở được phiên tải lên');
        return uploadTo(loc, blob, onProgress);
    }

    // Đẩy file vào một đường gửi đã mở sẵn. Trang khách dùng đường do Apps Script
    // mở trên máy chủ: không cần chìa khoá Drive, đường đó chỉ gửi được đúng
    // một file vào đúng một thư mục, không đọc hay xoá được gì.
    async function uploadTo(loc, blob, onProgress) {
        const total = blob.size;
        const CH = 2 * 1024 * 1024;   // phải là bội của 256 KB
        const doneAt = r => { const rg = r.headers.get('Range'); return rg ? parseInt(rg.split('-')[1], 10) + 1 : 0; };
        let off = 0, fails = 0;
        while (true) {
            const end = Math.min(off + CH, total);
            try {
                const r = await fetch(loc, { method: 'PUT', headers: { 'Content-Range': `bytes ${off}-${end - 1}/${total}` }, body: blob.slice(off, end) });
                if (r.status === 200 || r.status === 201) { if (onProgress) onProgress(1); return await r.json(); }
                if (r.status === 308) { off = doneAt(r); fails = 0; if (onProgress) onProgress(off / total); continue; }
                if (r.status === 404 || r.status === 410) throw Object.assign(new Error('Phiên tải lên đã hết hạn'), { fatal: true });
                throw new Error('HTTP ' + r.status);
            } catch (e) {
                if (e.fatal || ++fails > 6) throw e;
                await new Promise(r => setTimeout(r, 1000 * fails));
                // Hỏi Drive đã nhận tới đâu rồi gửi tiếp từ đó
                try {
                    const q = await fetch(loc, { method: 'PUT', headers: { 'Content-Range': `bytes */${total}` } });
                    if (q.status === 200 || q.status === 201) return await q.json();
                    if (q.status === 308) off = doneAt(q);
                } catch (e2) { /* vẫn mất mạng, vòng sau thử tiếp */ }
            }
        }
    }

    // Cho ai có link cũng xem: trang khách không đăng nhập Google, phải vậy mới đọc được
    async function makePublic(id, token) {
        const r = await fetch('https://www.googleapis.com/drive/v3/files/' + id + '/permissions', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
            body: JSON.stringify({ role: 'reader', type: 'anyone' })
        });
        if (!r.ok) throw new Error('Không mở quyền xem được (HTTP ' + r.status + ')');
    }


    // ---------- Bộ lọc màu cho ảnh khách ----------
    // Một bộ lọc gồm chỉnh số (sáng, tương phản, bão hoà, ấm/lạnh, phai) và/hoặc
    // một bảng tra màu (LUT). Hai phần được gộp sẵn thành một bảng 3 chiều rồi áp
    // cho từng điểm ảnh, nên máy nào cũng ra cùng một màu — không dựa vào bộ lọc
    // có sẵn của trình duyệt (iPhone đời cũ không có).

    // LUT lưu dạng ảnh Hald cấp 8: ảnh vuông 512x512 chứa đủ 64x64x64 màu.
    // Màu thứ i (đọc từ trái sang phải, trên xuống dưới) là r = i % 64,
    // g = (i / 64) % 64, b = i / 4096, mỗi nấc nhân 255/63.
    // Đưa ảnh này lên Canva, áp bộ lọc, tải về PNG là được đúng bảng màu của Canva.
    const HALD_N = 64, HALD_W = 512;

    function haldIdentity() {
        const c = document.createElement('canvas');
        c.width = c.height = HALD_W;
        const x = c.getContext('2d');
        const im = x.createImageData(HALD_W, HALD_W), d = im.data;
        for (let i = 0; i < HALD_N * HALD_N * HALD_N; i++) {
            const p = i * 4;
            d[p] = Math.round((i % HALD_N) * 255 / (HALD_N - 1));
            d[p + 1] = Math.round((Math.floor(i / HALD_N) % HALD_N) * 255 / (HALD_N - 1));
            d[p + 2] = Math.round(Math.floor(i / (HALD_N * HALD_N)) * 255 / (HALD_N - 1));
            d[p + 3] = 255;
        }
        x.putImageData(im, 0, 0);
        return c;
    }

    // Đọc LUT từ ảnh Hald (ảnh mẫu đã lọc). Nhận mọi cấp: cạnh ảnh = cấp^3.
    function lutFromHald(im) {
        const W = im.naturalWidth || im.width, H = im.naturalHeight || im.height;
        const L = Math.round(Math.cbrt(W));
        if (W !== H || L * L * L !== W || L < 4 || L > 16) {
            throw new Error(`Ảnh LUT phải là ảnh vuông đúng cỡ của ảnh mẫu (512 × 512). Ảnh này ${W} × ${H}: kiểm tra Canva đã tải về đúng cỡ chưa.`);
        }
        const N = L * L;
        const c = document.createElement('canvas');
        c.width = W; c.height = H;
        const x = c.getContext('2d');
        x.drawImage(im, 0, 0);
        const d = x.getImageData(0, 0, W, H).data;
        const t = new Float32Array(N * N * N * 3);
        for (let i = 0; i < N * N * N; i++) { t[i * 3] = d[i * 4]; t[i * 3 + 1] = d[i * 4 + 1]; t[i * 3 + 2] = d[i * 4 + 2]; }
        c.width = c.height = 0;
        return { N, t };
    }

    // Đọc file .cube (Lightroom, Photoshop, các gói LUT trên mạng)
    function lutFromCube(text) {
        let N = 0, lo = [0, 0, 0], hi = [1, 1, 1];
        const vals = [];
        String(text).split(/\r?\n/).forEach(line => {
            const s = line.trim();
            if (!s || s[0] === '#') return;
            const p = s.split(/\s+/);
            if (p[0] === 'LUT_3D_SIZE') N = parseInt(p[1]);
            else if (p[0] === 'DOMAIN_MIN') lo = p.slice(1, 4).map(Number);
            else if (p[0] === 'DOMAIN_MAX') hi = p.slice(1, 4).map(Number);
            else if (/^[-+.\d]/.test(p[0]) && p.length >= 3) vals.push(+p[0], +p[1], +p[2]);
        });
        if (!N) throw new Error('File .cube không có LUT_3D_SIZE (chỉ nhận LUT 3D)');
        if (vals.length !== N * N * N * 3) throw new Error(`File .cube thiếu dữ liệu: cần ${N * N * N} dòng màu, có ${vals.length / 3}`);
        const t = new Float32Array(vals.length);
        // Thứ tự trong .cube giống ảnh Hald: đỏ đổi nhanh nhất, xanh dương chậm nhất
        for (let i = 0; i < vals.length; i++) {
            const ch = i % 3;
            t[i] = Math.max(0, Math.min(255, (vals[i] - lo[ch]) / ((hi[ch] - lo[ch]) || 1) * 255));
        }
        return { N, t };
    }

    // Tra màu trong một bảng 3 chiều, nội suy giữa 8 điểm lưới gần nhất
    function lutSample(lut, r, g, b, out) {
        const N = lut.N, t = lut.t, k = (N - 1) / 255, N2 = N * N;
        const rf = Math.min(N - 1, Math.max(0, r * k)), gf = Math.min(N - 1, Math.max(0, g * k)), bf = Math.min(N - 1, Math.max(0, b * k));
        const r0 = rf | 0, g0 = gf | 0, b0 = bf | 0;
        const r1 = r0 < N - 1 ? r0 + 1 : r0, g1 = g0 < N - 1 ? g0 + 1 : g0, b1 = b0 < N - 1 ? b0 + 1 : b0;
        const dr = rf - r0, dg = gf - g0, db = bf - b0;
        for (let c = 0; c < 3; c++) {
            const v000 = t[(r0 + g0 * N + b0 * N2) * 3 + c], v100 = t[(r1 + g0 * N + b0 * N2) * 3 + c];
            const v010 = t[(r0 + g1 * N + b0 * N2) * 3 + c], v110 = t[(r1 + g1 * N + b0 * N2) * 3 + c];
            const v001 = t[(r0 + g0 * N + b1 * N2) * 3 + c], v101 = t[(r1 + g0 * N + b1 * N2) * 3 + c];
            const v011 = t[(r0 + g1 * N + b1 * N2) * 3 + c], v111 = t[(r1 + g1 * N + b1 * N2) * 3 + c];
            const a = v000 + (v100 - v000) * dr, bb = v010 + (v110 - v010) * dr;
            const cc = v001 + (v101 - v001) * dr, dd = v011 + (v111 - v011) * dr;
            const e = a + (bb - a) * dg, f = cc + (dd - cc) * dg;
            out[c] = e + (f - e) * db;
        }
        return out;
    }

    // Ảnh Hald 512 của một LUT bất kỳ (để lưu file .cube về cùng một dạng)
    function lutToHald(lut) {
        const c = document.createElement('canvas');
        c.width = c.height = HALD_W;
        const x = c.getContext('2d');
        const im = x.createImageData(HALD_W, HALD_W), d = im.data, o = [0, 0, 0];
        for (let i = 0; i < HALD_N * HALD_N * HALD_N; i++) {
            lutSample(lut, (i % HALD_N) * 255 / (HALD_N - 1), (Math.floor(i / HALD_N) % HALD_N) * 255 / (HALD_N - 1),
                      Math.floor(i / (HALD_N * HALD_N)) * 255 / (HALD_N - 1), o);
            d[i * 4] = o[0]; d[i * 4 + 1] = o[1]; d[i * 4 + 2] = o[2]; d[i * 4 + 3] = 255;
        }
        x.putImageData(im, 0, 0);
        return c;
    }

    // LUT có thật sự đổi màu không (ảnh mẫu tải lên mà quên áp bộ lọc thì báo)
    function lutIsIdentity(lut) {
        const N = lut.N;
        let maxd = 0;
        // Bảng nhỏ (file .cube 2-17 nấc) xét hết; bảng lớn lấy mẫu cho nhanh
        const step = N * N * N > 40000 ? 7 : 1;
        for (let i = 0; i < N * N * N; i += step) {
            const id = [(i % N), Math.floor(i / N) % N, Math.floor(i / (N * N))].map(v => v * 255 / (N - 1));
            for (let c = 0; c < 3; c++) maxd = Math.max(maxd, Math.abs(lut.t[i * 3 + c] - id[c]));
        }
        return maxd < 4;
    }

    // Chỉnh số một màu. a: { b sáng, c tương phản, s bão hoà, w ấm/lạnh: -100..100; f phai: 0..100 }
    function adjustRGB(r, g, b, a, out) {
        if (a.b) { const k = a.b * 1.28; r += k; g += k; b += k; }
        if (a.c) {
            const C = a.c * 2.55, f = (259 * (C + 255)) / (255 * (259 - C));
            r = f * (r - 128) + 128; g = f * (g - 128) + 128; b = f * (b - 128) + 128;
        }
        if (a.s) {
            const y = 0.299 * r + 0.587 * g + 0.114 * b, k = 1 + a.s / 100;
            r = y + (r - y) * k; g = y + (g - y) * k; b = y + (b - y) * k;
        }
        if (a.w) { r += a.w * 0.35; b -= a.w * 0.35; }
        if (a.f) {
            // Phai: nâng vùng tối lên, ảnh bớt đen sâu như phim để lâu
            const k = a.f / 100 * 0.3;
            r = r * (1 - k) + 255 * k * 0.5; g = g * (1 - k) + 255 * k * 0.5; b = b * (1 - k) + 255 * k * 0.5;
        }
        out[0] = r < 0 ? 0 : r > 255 ? 255 : r;
        out[1] = g < 0 ? 0 : g > 255 ? 255 : g;
        out[2] = b < 0 ? 0 : b > 255 ? 255 : b;
        return out;
    }

    function hasAdj(a) { return !!a && ['b', 'c', 's', 'w', 'f'].some(k => +a[k]); }

    // Gộp chỉnh số + LUT thành một bảng duy nhất: áp từng điểm ảnh chỉ còn một lần tra
    function bakeFilter(rec, lut) {
        const a = (rec && rec.adj) || {};
        if (!lut && !hasAdj(a)) return null;
        const N = lut ? Math.min(HALD_N, Math.max(33, lut.N)) : 33;
        const t = new Float32Array(N * N * N * 3), o = [0, 0, 0], step = 255 / (N - 1);
        for (let bi = 0; bi < N; bi++) for (let gi = 0; gi < N; gi++) for (let ri = 0; ri < N; ri++) {
            adjustRGB(ri * step, gi * step, bi * step, a, o);
            if (lut) lutSample(lut, o[0], o[1], o[2], o);
            const i = (ri + gi * N + bi * N * N) * 3;
            t[i] = o[0]; t[i + 1] = o[1]; t[i + 2] = o[2];
        }
        return { N, t };
    }

    // Áp bảng màu cho một vùng chữ nhật của khung vẽ. inside(x, y) (tuỳ chọn) chỉ
    // lọc các điểm thuộc ô ảnh. Làm từng dải 256 dòng cho nhẹ bộ nhớ máy cũ.
    function filterRect(ctx, x0, y0, w, h, baked, inside) {
        x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
        w = Math.min(ctx.canvas.width - x0, Math.ceil(w)); h = Math.min(ctx.canvas.height - y0, Math.ceil(h));
        if (w <= 0 || h <= 0) return;
        const o = [0, 0, 0];
        for (let y = y0; y < y0 + h; y += 256) {
            const bh = Math.min(256, y0 + h - y);
            const im = ctx.getImageData(x0, y, w, bh), d = im.data;
            for (let yy = 0; yy < bh; yy++) for (let xx = 0; xx < w; xx++) {
                if (inside && !inside(x0 + xx + 0.5, y + yy + 0.5)) continue;
                const p = (yy * w + xx) * 4;
                lutSample(baked, d[p], d[p + 1], d[p + 2], o);
                d[p] = o[0]; d[p + 1] = o[1]; d[p + 2] = o[2];
            }
            ctx.putImageData(im, x0, y);
        }
    }

    // Lọc đúng vùng một ô (ô có thể xoay): không đụng phần frame nằm quanh ô
    function filterSlot(ctx, s, sc, baked) {
        const cx = s.cx * sc, cy = s.cy * sc, hw = s.w * sc / 2 + 1, hh = s.h * sc / 2 + 1;
        const a = (s.rot || 0) * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
        const ex = Math.abs(hw * cos) + Math.abs(hh * sin), ey = Math.abs(hw * sin) + Math.abs(hh * cos);
        filterRect(ctx, cx - ex, cy - ey, ex * 2, ey * 2, baked, (x, y) => {
            const dx = x - cx, dy = y - cy;
            return Math.abs(dx * cos + dy * sin) <= hw && Math.abs(-dx * sin + dy * cos) <= hh;
        });
    }

    function filterCanvas(c, baked) { filterRect(c.getContext('2d'), 0, 0, c.width, c.height, baked); }

    // Bộ lọc lưu trên Firebase config/filters/<id> = { name, adj, lut (mã file ảnh Hald trên Drive) }
    async function loadFilter(rec) {
        if (!rec) return null;
        const lut = rec.lut ? lutFromHald(await loadImg(gUrl(rec.lut))) : null;
        return bakeFilter(rec, lut);
    }

    return { gUrl, loadImg, shrink, canvasFor, detectHoles, fitRect, geom, clamp, slotAt, boxCss, compose, upload, uploadTo, makePublic,
             haldIdentity, lutFromHald, lutFromCube, lutToHald, lutIsIdentity, bakeFilter, hasAdj, filterRect, filterSlot, filterCanvas, loadFilter };
})();

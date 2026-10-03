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
    async function compose(ctx, sc, frame, frameSrc, photos, photoSrc, onStep) {
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

    return { gUrl, loadImg, shrink, canvasFor, detectHoles, fitRect, geom, clamp, slotAt, boxCss, compose, upload, uploadTo, makePublic };
})();

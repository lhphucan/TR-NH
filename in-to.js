// ===== Dựng tờ in: dùng chung cho in tại quầy (in-anh.js) và in từ xa (may-in.html, laptop quán) =====
// Hai đường in phải ra tờ giống hệt nhau nên chỉ có một chỗ dựng tờ.
const IN_DPI = 720;                 // Epson L8050; máy in khác DPI thì phần mềm in chặn và báo
const IN_GIAY = {
    '4x6': { ten: '10×15', mo: '10×15 cm (4×6 inch)', w: 101.6, h: 152.4 },
    A5: { ten: 'A5', mo: 'A5 (148×210 mm)', w: 148, h: 210 },
    A4: { ten: 'A4', mo: 'A4 (210×297 mm)', w: 210, h: 297 }
};

// Nguyên tờ giấy dọc ở DPI máy in; ảnh ngang thì xoay cho khớp giấy. Thu / phóng một lần bằng
// trình duyệt cho mịn.
// le = 0 (tờ ảnh thẻ, đã tự chừa lề): ảnh phủ đúng cả tờ.
// le > 0 (ảnh ghép frame, thiết kế sát mép): như app In ảnh Lens (PAPER_SAFE_MARGIN_MM), không để
// hình chạm dải le mm sát mép giấy, nơi Epson không in tới (lề cứng ~3 mm) -> thu ảnh vừa khung
// giấy trừ le mỗi cạnh, giữ tỉ lệ, đặt giữa tờ. Đủ toàn bộ thiết kế, viền trắng đều 4 cạnh.
const IN_LE_FRAME_MM = 3.5;
async function inDungTo(im, g, le = 0) {
    const W = Math.round(g.w / 25.4 * IN_DPI), H = Math.round(g.h / 25.4 * IN_DPI);
    const iw = im.naturalWidth, ih = im.naturalHeight, ngang = iw > ih;
    const tiLe = Math.max(iw, ih) / Math.min(iw, ih), tiLeGiay = Math.max(g.w, g.h) / Math.min(g.w, g.h);
    if (Math.abs(tiLe - tiLeGiay) > tiLeGiay * 0.02) throw new Error(`Ảnh ${iw}×${ih} không đúng tỉ lệ khổ ${g.ten}, in ra sẽ méo. Kiểm tra khổ in của frame.`);
    // Chỗ ảnh nằm trên tờ (theo chiều giấy, sau khi xoay)
    let dw = W, dh = H;
    if (le > 0) {
        const L = le / 25.4 * IN_DPI, fw = ngang ? ih : iw, fh = ngang ? iw : ih;
        const s = Math.min((W - 2 * L) / fw, (H - 2 * L) / fh);
        dw = Math.round(fw * s); dh = Math.round(fh * s);
    }
    const ox = Math.round((W - dw) / 2), oy = Math.round((H - dh) / 2);
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, W, H);
    x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
    if (ngang) { x.translate(ox + dw, oy); x.rotate(Math.PI / 2); x.drawImage(im, 0, 0, dh, dw); }
    else x.drawImage(im, ox, oy, dw, dh);
    const png = await new Promise(r => c.toBlob(r, 'image/png'));
    c.width = c.height = 0;
    if (!png) throw new Error('Máy không dựng được tờ in (thiếu bộ nhớ)');
    return { png, W, H };
}

const IMGBB_API_KEY = 'd47a0ff216df7f718f898c65afa1cc17'; 
const PASS_STAFF = "123456"; const PASS_ADMIN = "Anle123456";
let userRole = ''; let dbPath = 'data/'; let br = 'phucyen';
let currentData = {}; let previousCount = 0; let isFirstLoad = true;
let db;

const BRANCH_NAMES = { 'phucyen': 'Cơ sở Phúc Yên', 'vinhyen': 'Cơ sở Vĩnh Yên' };

function escapeHTML(str) {
    if (!str) return '';
    return str.replace(/[&<>'"]/g, 
        tag => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            "'": '&#39;',
            '"': '&quot;'
        }[tag] || tag)
    );
}

try {
    const firebaseConfig = { apiKey: "AIzaSyAcih83r2AhH85J3Pp31i7qq8OkuRAIyxw", databaseURL: "https://tra-anh-khach-default-rtdb.asia-southeast1.firebasedatabase.app", projectId: "tra-anh-khach" };
    firebase.initializeApp(firebaseConfig);
    db = firebase.database();
} catch (error) {
    console.error("Firebase Error:", error);
}

let Toast;
try {
    Toast = Swal.mixin({
        toast: true, position: 'top-end', showConfirmButton: false, timer: 2500,
        timerProgressBar: true, background: '#111', color: '#fff', iconColor: '#fff'
    });
} catch (e) {
    Toast = { fire: (args) => alert(args.title) };
}

function getDStr(dObj) { return String(dObj.getDate()).padStart(2, '0') + '/' + String(dObj.getMonth() + 1).padStart(2, '0') + '/' + dObj.getFullYear(); }

window.onload = () => {
    const savedRole = localStorage.getItem('pn_admin_role');
    if (savedRole === 'admin' || savedRole === 'staff') { userRole = savedRole; setupUI(); }
};

function clearDateFilter() { 
    const fp = document.getElementById('date-filter')._flatpickr;
    if(fp) fp.clear();
    filterData(); 
}

function login() {
    try {
        const p = document.getElementById('pass').value;
        if(p === PASS_ADMIN || p === PASS_STAFF) {
            userRole = (p === PASS_ADMIN) ? 'admin' : 'staff';
            localStorage.setItem('pn_admin_role', userRole);
            setupUI();
            Toast.fire({ icon: 'success', title: 'Đăng nhập thành công' });
        } else {
            if (typeof Swal !== 'undefined') Swal.fire({ icon: 'error', title: 'Sai mã bảo mật!', confirmButtonColor: '#111' });
            else alert("Sai mã bảo mật! Vui lòng kiểm tra lại.");
        }
    } catch (e) { alert("Lỗi: " + e.message); }
}

function logout() {
    if (typeof Swal !== 'undefined') {
        Swal.fire({
            title: 'Đăng xuất?', icon: 'question', showCancelButton: true, confirmButtonColor: '#111', confirmButtonText: 'Đăng xuất', cancelButtonText: '<span style="color:#111">Hủy</span>'
        }).then((r) => { if (r.isConfirmed) { localStorage.removeItem('pn_admin_role'); location.reload(); }});
    } else {
        if(confirm("Bạn có chắc chắn muốn đăng xuất?")) { localStorage.removeItem('pn_admin_role'); location.reload(); }
    }
}

function setupUI() {
    document.body.classList.add('role-' + userRole);
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('admin-box').style.display = 'block';
    document.getElementById('role-badge').innerText = userRole === 'admin' ? "ADMIN" : "NHÂN VIÊN";
    
    flatpickr("#date-filter", { mode: "range", dateFormat: "d/m/Y", locale: "vn", defaultDate: new Date() });
    
    if (db) load();
}

function switchB(name) { br = name; isFirstLoad = true; previousCount = 0; document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active')); document.getElementById('btn-'+name).classList.add('active'); load(); }

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
    isFirstLoad = true; previousCount = 0; load();
}

function openRevenueModal() {
    if(userRole !== 'admin') return Toast.fire({icon: 'error', title: 'Chỉ Quản trị viên được xem'});
    
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

    let dTotal = 0, dCash = 0, dTrans = 0, dCount = 0, dFree = 0;

    if(currentData && dbPath === 'data/') {
        Object.keys(currentData).forEach(id => {
            const c = currentData[id];
            const ts = parseInt(id.split('_')[1]) || Date.now();
            
            if (ts >= fTs && ts <= tTs) {
                const isFree = (c.price === 'Miễn phí');
                const priceVal = isFree ? 0 : (parseInt((c.price||'').replace(/\D/g, ''), 10) || 0);
                
                dCount++;
                if (isFree) dFree++;
                dTotal += priceVal;
                if (c.payment === 'Tiền mặt') dCash += priceVal;
                if (c.payment === 'Chuyển khoản') dTrans += priceVal;
            }
        });
    }

    document.getElementById('rev-day-title').innerText = titleStr;
    document.getElementById('rev-day-count').innerText = dCount + ' lượt';
    document.getElementById('rev-day-free').innerText = dFree + ' miễn phí';
    document.getElementById('rev-day-cash').innerText = dCash.toLocaleString('vi-VN') + ' ₫';
    document.getElementById('rev-day-trans').innerText = dTrans.toLocaleString('vi-VN') + ' ₫';
    document.getElementById('rev-day-total').innerText = dTotal.toLocaleString('vi-VN') + ' ₫';
}

function calcRevenueByMonth() {
    const mStrInput = document.getElementById('rev-month-val').value; 
    if(!mStrInput) return Toast.fire({ icon: 'warning', title: 'Vui lòng chọn tháng!' });
    const targetMonth = mStrInput; 

    let mTotal = 0, mCash = 0, mTrans = 0, mCount = 0, mFree = 0;

    if(currentData && dbPath === 'data/') {
        Object.keys(currentData).forEach(id => {
            const c = currentData[id];
            const ts = parseInt(id.split('_')[1]) || Date.now();
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
            }
        });
    }
    
    document.getElementById('rev-month-title').innerText = `THÁNG ${targetMonth}`;
    document.getElementById('rev-month-count').innerText = mCount + ' lượt';
    document.getElementById('rev-month-free').innerText = mFree + ' miễn phí';
    document.getElementById('rev-month-cash').innerText = mCash.toLocaleString('vi-VN') + ' ₫';
    document.getElementById('rev-month-trans').innerText = mTrans.toLocaleString('vi-VN') + ' ₫';
    document.getElementById('rev-month-total').innerText = mTotal.toLocaleString('vi-VN') + ' ₫';
}

function calcRevenueByYear() {
    const yyyy = document.getElementById('rev-year-picker').value;
    let yTotal = 0, yCash = 0, yTrans = 0, yCount = 0, yFree = 0;

    if(currentData && dbPath === 'data/' && yyyy) {
        Object.keys(currentData).forEach(id => {
            const c = currentData[id];
            const ts = parseInt(id.split('_')[1]) || Date.now();
            const dObj = new Date(ts);

            if (String(dObj.getFullYear()) === yyyy) {
                const isFree = (c.price === 'Miễn phí');
                const priceVal = isFree ? 0 : (parseInt((c.price||'').replace(/\D/g, ''), 10) || 0);
                
                yCount++;
                if (isFree) yFree++;
                yTotal += priceVal;
                if (c.payment === 'Tiền mặt') yCash += priceVal;
                if (c.payment === 'Chuyển khoản') yTrans += priceVal;
            }
        });
    }
    
    document.getElementById('rev-year-title').innerText = `NĂM ${yyyy}`;
    document.getElementById('rev-year-count').innerText = yCount + ' lượt';
    document.getElementById('rev-year-free').innerText = yFree + ' miễn phí';
    document.getElementById('rev-year-total').innerText = yTotal.toLocaleString('vi-VN') + ' ₫';
    document.getElementById('rev-year-cash').innerText = yCash.toLocaleString('vi-VN') + ' ₫';
    document.getElementById('rev-year-trans').innerText = yTrans.toLocaleString('vi-VN') + ' ₫';
}

function load() {
    db.ref('data/' + br).off(); db.ref('trash/' + br).off();
    db.ref(dbPath + br).on('value', snap => {
        const list = document.getElementById('list-content');
        const trashHeader = document.getElementById('trash-header');
        list.innerHTML = ""; document.getElementById('empty-msg').style.display = 'none';
        currentData = snap.val();
        
        if(!currentData) { 
            document.querySelector('.empty-text').innerText = (dbPath === 'trash/') ? "Thùng rác đang trống." : "Chưa có dữ liệu nào.";
            document.getElementById('empty-msg').style.display = 'block';
            trashHeader.style.display = 'none'; previousCount = 0; return; 
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
            const timestamp = parseInt(clientId.split('_')[1]) || Date.now();
            const dateStr = getDStr(new Date(timestamp));
            if(!groupedData[dateStr]) groupedData[dateStr] = { timestamp: timestamp, clients: [] };
            groupedData[dateStr].clients.push({ id: clientId, ...client, ts: timestamp });
        });

        const sortedDates = Object.keys(groupedData).sort((a, b) => groupedData[b].timestamp - groupedData[a].timestamp);
        const todayStr = getDStr(new Date());

        sortedDates.forEach(date => {
            const groupDiv = document.createElement('div'); groupDiv.className = 'date-group';
            const dateLabel = (date === todayStr) ? "Hôm nay, " + date : date;
            let html = `<div class="date-header"><span style="display:flex; align-items:center;"><svg class="icon-sm" style="margin-right:6px;" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg> ${dateLabel}</span><span style="font-size:12px; color:#71717a;">${groupedData[date].clients.length} khách</span></div>`;
            
            groupedData[date].clients.sort((a, b) => b.ts - a.ts).forEach(client => {
                const isDone = client.status === 'completed'; const maKh = client.id.split('_')[1].slice(-4); const safeName = escapeHTML(client.name || "Khách hàng"); 

                let linksHtml = '';
                if (client.links) {
                    Object.keys(client.links).forEach(linkId => {
                        linksHtml += `<div class="link-row">
                            <span class="time-label">${client.links[linkId].addedAt.split(' ')[0]}</span>
                            <input type="text" value="${client.links[linkId].url}" readonly>
                            <button onclick="deleteLink('${client.id}', '${linkId}')" class="btn-del-link admin-only">XÓA</button>
                        </div>`;
                    });
                }

                let clientUploadsHtml = '';
                if (client.client_uploads && dbPath === 'data/') {
                    Object.keys(client.client_uploads).forEach(uId => {
                        const up = client.client_uploads[uId];
                        let imgLinks = "";
                        up.links.forEach((l, i) => {
                            imgLinks += `<a href="${l}" target="_blank" style="color:#111; font-size:12px; font-weight:600; text-decoration:underline; margin-right:12px; display:inline-block; margin-top:5px;">Ảnh gốc ${i+1}</a>`;
                        });
                        clientUploadsHtml += `
                            <div style="background:#fafafa; border:1px dashed #d4d4d8; padding:12px 15px; border-radius:10px; margin-bottom:12px;">
                                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; flex-wrap:wrap; gap:10px;">
                                    <span style="font-size:12px; font-weight:700; color:#111; display:flex; align-items:center; gap:6px; text-transform:uppercase;">
                                        <svg class="icon-sm" viewBox="0 0 24 24"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"></polyline><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"></path></svg>
                                        Yêu cầu in (${up.time.split(' ')[1] || ''})
                                    </span>
                                    <button onclick="delClientUp('${client.id}', '${uId}')" class="btn-del-link" style="padding: 0 10px; height:28px;">Hoàn tất in</button>
                                </div>
                                <div style="display:flex; flex-wrap:wrap;">${imgLinks}</div>
                            </div>`;
                    });
                }

                let actionButtons = (dbPath === 'trash/') ? 
                    `<button class="btn-restore admin-only" onclick="restoreCustomer('${client.id}', '${safeName}')"><svg class="icon-svg" style="margin-right:4px;" viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path><polyline points="9 22 9 12 15 12 15 22"></polyline></svg> KHÔI PHỤC</button>
                    <button class="btn-del-client admin-only" onclick="hardDeleteCustomer('${client.id}', '${safeName}')" style="margin-top:10px;"><svg class="icon-svg" style="margin-right:4px;" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg> XÓA VĨNH VIỄN</button>` :
                    `<button class="btn-move-client admin-only" onclick="moveCustomer('${client.id}', '${safeName}', '${br === 'phucyen' ? 'vinhyen' : 'phucyen'}')"><svg class="icon-svg" style="margin-right:4px;" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"></circle><polyline points="12 16 16 12 12 8"></polyline><line x1="8" y1="12" x2="16" y2="12"></line></svg> CHUYỂN CƠ SỞ</button>
                    <button class="btn-del-client admin-only" onclick="softDeleteCustomer('${client.id}', '${safeName}')" style="margin-top:10px;"><svg class="icon-svg" style="margin-right:4px;" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg> THÙNG RÁC</button>`;

                const pVal = client.price || ""; const pmVal = client.payment || "Tiền mặt";
                const isFree = (pVal === 'Miễn phí');

                html += `
                    <div class="client-card" data-search="${client.name ? client.name.toLowerCase() : ''} ${client.phone} ${maKh}">
                        <div class="client-info">
                            ${(dbPath === 'trash/') ? `<div style="margin-bottom:10px; display:flex; align-items:center; gap:10px;"><input type="checkbox" class="trash-checkbox" value="${client.id}" style="width:16px; height:16px; cursor:pointer;"><span style="font-size:12px; font-weight:600; color:#666;">CHỌN XÓA</span></div>` : ''}
                            <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:8px;">
                                <div style="font-size: 11px; color: #a1a1aa; font-family: monospace; font-weight: 600;">#${maKh}</div>
                                <span class="badge ${isDone ? 'done' : 'pending'}">${isDone ? 'ĐÃ TRẢ ẢNH' : 'ĐANG CHỤP'}</span>
                            </div>
                            <h4 style="margin: 0 0 5px 0; font-size: 16px;">${safeName}</h4>
                            <div style="font-size: 13px; color: #52525b; margin-bottom: 5px; display:flex; align-items:center;"><svg class="icon-sm" style="margin-right:6px;" viewBox="0 0 24 24"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path></svg> ${client.phone}</div>
                            <div style="font-size: 13px; color: #52525b; margin-bottom: 15px; display:flex; align-items:center;"><svg class="icon-sm" style="margin-right:6px;" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg> ${client.time}</div>
                            
                            <div style="margin-top:auto;">
                                <div style="font-size:11px; font-weight:600; color:#a1a1aa; margin-bottom:5px; text-transform:uppercase;">Doanh thu:</div>
                                <div style="display:flex; gap:5px;">
                                    <input type="text" id="price_${client.id}" class="price-input" value="${pVal}" placeholder="VD: 50.000" list="price-list" onchange="updateMoney('${client.id}')">
                                    <select id="payment_${client.id}" class="price-select" onchange="updateMoney('${client.id}')" ${isFree ? 'disabled' : ''}>
                                        <option value="Tiền mặt" ${pmVal === 'Tiền mặt' ? 'selected' : ''}>Tiền mặt</option>
                                        <option value="Chuyển khoản" ${pmVal === 'Chuyển khoản' ? 'selected' : ''}>Chuyển khoản</option>
                                    </select>
                                </div>
                            </div>
                            <div style="margin-top: 20px; border-top: 1px dashed #e4e4e7; padding-top: 15px;">
                                ${actionButtons}
                            </div>
                        </div>

                        <div class="link-manager">
                            ${clientUploadsHtml}
                            <details class="link-details" ${!client.links || Object.keys(client.links).length <= 2 ? 'open' : ''}>
                                <summary style="font-size:12px; font-weight:700; text-transform:uppercase; margin-bottom:10px; display:flex; align-items:center; cursor:pointer; list-style:none; outline:none; user-select:none;">
                                    <svg class="icon-sm" style="margin-right:6px;" viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg> 
                                    ẢNH ĐÃ TRẢ KHÁCH (${client.links ? Object.keys(client.links).length : 0})
                                    <svg class="icon-svg toggle-icon" style="margin-left:auto; transition: transform 0.2s;" viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"></polyline></svg>
                                </summary>
                                <div style="flex-grow:1; display:flex; flex-direction:column; gap:5px; margin-bottom:10px;">${linksHtml}</div>
                            </details>
                            
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

        filterData();
    });
}

function updateMoney(clientId) {
    let pVal = document.getElementById('price_' + clientId).value.trim();
    const paySel = document.getElementById('payment_' + clientId);
    
    if (pVal === 'Miễn phí') { paySel.disabled = true; paySel.value = 'Tiền mặt'; } 
    else { paySel.disabled = false; }
    
    db.ref(dbPath + br + '/' + clientId).update({ price: pVal, payment: paySel.value });
}


function toggleSelectAllTrash(cb) { const boxes = document.querySelectorAll('.trash-checkbox'); boxes.forEach(b => b.checked = cb.checked); }

function deleteSelectedTrash() {
    if(userRole !== 'admin') return;
    const selected = Array.from(document.querySelectorAll('.trash-checkbox:checked')).map(cb => cb.value);
    if (selected.length === 0) return Toast.fire({ icon: 'warning', title: 'Chưa chọn mục nào!' });
    
    Swal.fire({ title: 'Xóa vĩnh viễn?', text: `Đang chọn ${selected.length} mục. Nhập XOA để xác nhận.`, icon: 'warning', input: 'text', inputPlaceholder: 'Nhập XOA...', showCancelButton: true, confirmButtonColor: '#111', cancelButtonColor: '#fff', confirmButtonText: 'Xóa Tất Cả', cancelButtonText: '<span style="color:#111">Hủy</span>' }).then(async r => {
        if (r.isConfirmed) {
            if (r.value === 'XOA') {
                const deletePromises = selected.map(id => db.ref('trash/' + br + '/' + id).remove());
                await Promise.all(deletePromises);
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

            let csvContent = "data:text/csv;charset=utf-8," + String.fromCharCode(0xFEFF) + "Ngày,Giờ,Mã KH,Họ Tên,SĐT,Giá Tiền,Nguồn Tiền,Cơ Sở\n";
            let count = 0;
            
            Object.keys(currentData).forEach(id => {
                const ts = parseInt(id.split('_')[1]) || Date.now();
                if (ts >= fTs && ts <= tTs) {
                    const c = currentData[id]; 
                    const d = getDStr(new Date(ts)); 
                    const mk = id.split('_')[1].slice(-4);
                    const price = c.price || '0';
                    const payment = c.payment || '';
                    const cosoStr = br === 'phucyen' ? 'Phúc Yên' : 'Vĩnh Yên';
                    csvContent += `"${d}","${c.time}","#${mk}","${c.name}","${c.phone}","${price}","${payment}","${cosoStr}"\n`;
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
        }
    });
}

async function uploadPhotosToImgBB(clientId) {
    const fileInput = document.getElementById('file_' + clientId);
    const files = fileInput.files;
    const btn = document.getElementById('btn_up_' + clientId);

    if (files.length === 0) return Swal.fire({title: 'Lỗi', text: 'Chưa chọn ảnh nào!', icon: 'warning', confirmButtonColor: '#111'});

    btn.innerHTML = `<svg class="icon-svg" style="margin-right:4px; animation: spin 1s infinite linear;" viewBox="0 0 24 24"><line x1="12" y1="2" x2="12" y2="6"></line><line x1="12" y1="18" x2="12" y2="22"></line><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"></line><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"></line><line x1="2" y1="12" x2="6" y2="12"></line><line x1="18" y1="12" x2="22" y2="12"></line><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"></line><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"></line></svg> ĐANG TẢI...`;
    btn.disabled = true;

    try {
        const now = new Date().toLocaleTimeString('vi-VN',{hour:'2-digit',minute:'2-digit'}) + ' ' + new Date().toLocaleDateString('vi-VN');
        for (let i = 0; i < files.length; i++) {
            const formData = new FormData();
            formData.append("image", files[i]);
            const response = await fetch("https://api.imgbb.com/1/upload?key=" + IMGBB_API_KEY, { method: 'POST', body: formData });
            const data = await response.json();

            if (data.success) {
                const url = data.data.url;
                const linkId = "L_" + Date.now() + "_" + i;
                await db.ref(dbPath + br + '/' + clientId + '/links/' + linkId).set({ url: url, addedAt: now });
            }
        }
        await db.ref(dbPath + br + '/' + clientId).update({ status: "completed" });
        Toast.fire({ icon: 'success', title: 'Tải lên hoàn tất!' });
        fileInput.value = ""; 
        document.getElementById('fname_'+clientId).innerText = 'Chưa có tệp';
    } catch (error) {
        if(typeof Swal !== 'undefined') Swal.fire({title: 'Lỗi', text: 'Không thể kết nối tải ảnh.', icon: 'error', confirmButtonColor: '#111'});
        else alert('Lỗi tải ảnh');
    } finally {
        btn.innerHTML = `<svg class="icon-svg" style="margin-right:4px;" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg> TẢI LÊN`;
        btn.disabled = false;
    }
}

function addLink(clientId) {
    const text = document.getElementById('new_' + clientId).value.trim();
    if(!text) return Toast.fire({ icon: 'warning', title: 'Chưa dán link!' });
    const urls = text.split(/\n/).map(u => u.trim()).filter(u => u !== ""); 
    if(urls.length === 0) return;
    const now = new Date();
    const timeStr = now.toLocaleTimeString('vi-VN', {hour: '2-digit', minute:'2-digit'}) + ' ' + now.toLocaleDateString('vi-VN', {day:'2-digit', month:'2-digit'});
    
    urls.forEach((url, index) => {
        const linkId = "L_" + Date.now() + "_" + index; 
        db.ref(dbPath + br + '/' + clientId + '/links/' + linkId).set({ url: url, addedAt: timeStr });
    });
    db.ref(dbPath + br + '/' + clientId).update({ status: "completed" });
    document.getElementById('new_' + clientId).value = ""; 
    Toast.fire({ icon: 'success', title: 'Đã lưu link' });
}

function deleteLink(clientId, linkId) { 
    if(userRole !== 'admin') return; 
    Swal.fire({ title: 'Xóa ảnh này?', icon: 'warning', showCancelButton: true, confirmButtonColor: '#111', cancelButtonColor: '#fff', confirmButtonText: 'Xóa', cancelButtonText: '<span style="color:#111">Hủy</span>' }).then(r => { if(r.isConfirmed) { db.ref(dbPath + br + '/' + clientId + '/links/' + linkId).remove(); Toast.fire({ icon: 'success', title: 'Đã xóa' }); }}); 
}

function delClientUp(cId, uId) {
    if(userRole !== 'admin') return;
    Swal.fire({ title: 'Xóa yêu cầu in?', showCancelButton: true, confirmButtonText: 'Xóa', cancelButtonText: '<span style="color:#111">Hủy</span>', confirmButtonColor: '#111' }).then(r => {
        if(r.isConfirmed) {
            db.ref(dbPath + br + '/' + cId + '/client_uploads/' + uId).remove();
            Toast.fire({ icon: 'success', title: 'Đã xóa yêu cầu in' });
        }
    });
}

function softDeleteCustomer(clientId, clientName) { 
    if(userRole !== 'admin') return; 
    Swal.fire({ title: 'Chuyển vào Thùng Rác?', text: "Khách hàng " + clientName, icon: 'warning', showCancelButton: true, confirmButtonColor: '#111', cancelButtonColor: '#fff', confirmButtonText: 'Chuyển', cancelButtonText: '<span style="color:#111">Hủy</span>' }).then(r => {
        if (r.isConfirmed) {
            db.ref('data/' + br + '/' + clientId).once('value').then(snap => db.ref('trash/' + br + '/' + clientId).set(snap.val()).then(() => db.ref('data/' + br + '/' + clientId).remove())).then(() => Toast.fire({ icon: 'success', title: 'Đã chuyển thùng rác' })).catch(err => Swal.fire('Lỗi', err.message, 'error'));
        }
    }); 
}

function restoreCustomer(clientId, clientName) { 
    if(userRole !== 'admin') return; 
    db.ref('trash/' + br + '/' + clientId).once('value').then(snap => db.ref('data/' + br + '/' + clientId).set(snap.val()).then(() => db.ref('trash/' + br + '/' + clientId).remove())).then(() => Toast.fire({ icon: 'success', title: "Đã khôi phục " + clientName })).catch(err => Swal.fire('Lỗi', err.message, 'error')); 
}

function hardDeleteCustomer(clientId, clientName) { 
    if(userRole !== 'admin') return; 
    Swal.fire({ title: 'Xóa Vĩnh Viễn?', text: "Nhập chữ XOA để xác nhận xóa khách " + clientName, icon: 'warning', input: 'text', inputPlaceholder: 'Nhập XOA...', showCancelButton: true, confirmButtonColor: '#111', cancelButtonColor: '#fff', confirmButtonText: 'Xóa', cancelButtonText: '<span style="color:#111">Hủy</span>' }).then(r => {
        if (r.isConfirmed) {
            if(r.value === 'XOA') { db.ref('trash/' + br + '/' + clientId).remove().then(() => Toast.fire({ icon: 'success', title: 'Đã xóa vĩnh viễn' })); } 
            else { Swal.fire({title: 'Thất bại', text: 'Sai mã xác nhận!', icon: 'error', confirmButtonColor: '#111'}); }
        }
    }); 
}

function moveCustomer(clientId, clientName, targetBranch) {
    if(userRole !== 'admin') return;
    const targetName = targetBranch === 'phucyen' ? 'Cơ sở Phúc Yên' : 'Cơ sở Vĩnh Yên';
    Swal.fire({
        title: 'Chuyển Cơ Sở?',
        text: `Chuyển khách hàng ${clientName} sang ${targetName}?`,
        icon: 'question',
        showCancelButton: true,
        confirmButtonColor: '#111',
        cancelButtonColor: '#fff',
        confirmButtonText: 'Chuyển Ngay',
        cancelButtonText: '<span style="color:#111">Hủy</span>'
    }).then(r => {
        if (r.isConfirmed) {
            db.ref(dbPath + br + '/' + clientId).once('value').then(snap => {
                const data = snap.val();
                if(data) {
                    db.ref(dbPath + targetBranch + '/' + clientId).set(data).then(() => {
                        db.ref(dbPath + br + '/' + clientId).remove().then(() => {
                            Toast.fire({ icon: 'success', title: 'Đã chuyển thành công' });
                        });
                    });
                }
            }).catch(err => Swal.fire('Lỗi', err.message, 'error'));
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

    let confirmMsg = target === 'all' ? "TẤT CẢ CƠ SỞ" : (target === 'phucyen' ? "PHÚC YÊN" : "VĨNH YÊN");
    
    Swal.fire({ title: 'DỌN SẠCH HỆ THỐNG', text: "Hành động này sẽ XÓA SẠCH VÀ VĨNH VIỄN toàn bộ dữ liệu của " + confirmMsg + ".\nBạn chắc chắn chứ?", icon: 'error', showCancelButton: true, confirmButtonColor: '#111', cancelButtonColor: '#fff', confirmButtonText: 'TÔI CHẮC CHẮN XÓA', cancelButtonText: '<span style="color:#111">Hủy</span>' }).then(r => {
        if (r.isConfirmed) {
            if (target === 'all') { db.ref('data/phucyen').remove(); db.ref('data/vinhyen').remove(); db.ref('trash/phucyen').remove(); db.ref('trash/vinhyen').remove(); } 
            else { db.ref('data/' + target).remove(); db.ref('trash/' + target).remove(); }
            document.getElementById('clear-modal').style.display = 'none';
            Swal.fire({title: 'Hoàn tất!', text: "Đã dọn sạch hệ thống cho " + confirmMsg, icon: 'success', confirmButtonColor: '#111'});
        }
    });
}

function showQRCode() {
    const title = br === 'phucyen' ? "MÃ QR CƠ SỞ PHÚC YÊN" : "MÃ QR CƠ SỞ VĨNH YÊN";
    const url = `https://lhphucan.github.io/TR-NH/?br=${br}`;
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=800x800&data=${encodeURIComponent(url)}`;
    
    document.getElementById('qr-title').innerText = title;
    document.getElementById('qr-image').src = qrUrl;
    document.getElementById('qr-download').href = qrUrl;
    
    document.getElementById('qr-modal').style.display = 'flex';
}

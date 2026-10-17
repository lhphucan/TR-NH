/* Noir Tax — chỉ tài khoản QUẢN TRỊ (admin) dùng được trang này.
 * Dùng chung phiên đăng nhập Firebase với trang quản lý (cùng tên miền): chưa đăng
 * nhập hoặc vai trò khác 'admin' thì giữ công cụ ẩn và chỉ đường về trang quản lý.
 * Lưu ý: chặn ở giao diện; dữ liệu thuế vốn không lưu trên máy chủ nên không có gì
 * để lộ, lớp này để nhân viên/người lạ không dùng được công cụ. */
(function () {
  'use strict';
  const firebaseConfig = { apiKey: "AIzaSyAcih83r2AhH85J3Pp31i7qq8OkuRAIyxw", databaseURL: "https://tra-anh-khach-default-rtdb.asia-southeast1.firebasedatabase.app", projectId: "tra-anh-khach" };
  const gate = document.getElementById('gate');
  const main = document.getElementById('appMain');
  const msg = document.getElementById('gateMsg');
  const link = document.getElementById('gateLink');

  function deny(text) {
    main.classList.add('hidden');
    gate.classList.remove('hidden');
    msg.textContent = text;
    link.classList.remove('hidden');
  }
  function allow() {
    gate.classList.add('hidden');
    main.classList.remove('hidden');
  }

  if (typeof firebase === 'undefined') {
    deny('Không tải được hệ thống đăng nhập — kiểm tra mạng rồi tải lại trang.');
    return;
  }
  if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
  const auth = firebase.auth();
  const db = firebase.database();

  auth.onAuthStateChanged(async (user) => {
    if (!user) return deny('Cần đăng nhập tài khoản quản trị ở trang quản lý trước.');
    try {
      const snap = await db.ref('users/' + user.uid + '/role').once('value');
      if (snap.val() === 'admin') allow();
      else deny('Trang khai thuế chỉ dành cho tài khoản quản trị (admin).');
    } catch (e) {
      console.error(e);
      deny('Không kiểm tra được quyền tài khoản — tải lại trang hoặc đăng nhập lại.');
    }
  });
})();

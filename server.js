const express = require('express');
const multer = require('multer');
const nodemailer = require('nodemailer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_FILE = path.join(__dirname, 'data.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Khởi tạo file dữ liệu, ưu tiên env vars cho SMTP
function initDataFile() {
  let data = { smtp: { host: '', port: 587, user: '', pass: '', from: '' }, recipients: [] };
  if (fs.existsSync(DATA_FILE)) {
    try { data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')); } catch(e) {}
  }
  if (process.env.SMTP_HOST) data.smtp.host = process.env.SMTP_HOST;
  if (process.env.SMTP_PORT) data.smtp.port = parseInt(process.env.SMTP_PORT);
  if (process.env.SMTP_USER) data.smtp.user = process.env.SMTP_USER;
  if (process.env.SMTP_PASS) data.smtp.pass = process.env.SMTP_PASS;
  if (process.env.SMTP_FROM) data.smtp.from = process.env.SMTP_FROM;
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}
initDataFile();

function loadData() {
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// Cấu hình multer lưu file upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    // Giữ nguyên tên file gốc, xử lý encoding
    const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const safeName = Date.now() + '_' + originalName;
    cb(null, safeName);
  }
});
const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── API: Lấy cấu hình ─────────────────────────────────────────
app.get('/api/config', (req, res) => {
  const data = loadData();
  // Ẩn mật khẩu khi trả về
  const safeSmtp = { ...data.smtp, pass: data.smtp.pass ? '••••••••' : '' };
  res.json({ smtp: safeSmtp, recipients: data.recipients });
});

// ─── API: Lưu cấu hình SMTP ────────────────────────────────────
app.post('/api/config/smtp', (req, res) => {
  const data = loadData();
  const { host, port, user, pass, from } = req.body;
  data.smtp = {
    host: host || data.smtp.host,
    port: parseInt(port) || data.smtp.port,
    user: user || data.smtp.user,
    from: from || data.smtp.from,
    // Chỉ cập nhật pass nếu người dùng nhập mới (không phải placeholder)
    pass: (pass && pass !== '••••••••') ? pass : data.smtp.pass
  };
  saveData(data);
  res.json({ success: true, message: 'Đã lưu cấu hình SMTP' });
});

// ─── API: Quản lý danh sách người nhận ────────────────────────
app.get('/api/recipients', (req, res) => {
  res.json(loadData().recipients);
});

app.post('/api/recipients', (req, res) => {
  const data = loadData();
  const { name, email, department } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Email không hợp lệ' });
  const newRecipient = { id: Date.now().toString(), name: name || '', email, department: department || '' };
  data.recipients.push(newRecipient);
  saveData(data);
  res.json({ success: true, recipient: newRecipient });
});

app.put('/api/recipients/:id', (req, res) => {
  const data = loadData();
  const idx = data.recipients.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Không tìm thấy' });
  data.recipients[idx] = { ...data.recipients[idx], ...req.body };
  saveData(data);
  res.json({ success: true, recipient: data.recipients[idx] });
});

app.delete('/api/recipients/:id', (req, res) => {
  const data = loadData();
  data.recipients = data.recipients.filter(r => r.id !== req.params.id);
  saveData(data);
  res.json({ success: true });
});

// ─── API: Đọc & trích xuất nội dung file ─────────────────────
const uploadTemp = multer({ dest: UPLOADS_DIR, limits: { fileSize: 25 * 1024 * 1024 } });

function extractDocInfo(text, filename) {
  const result = { so_vb: '', ngay_vb: '', ve_viec: '' };

  // Log để debug (xem text thực sự đọc được)
  console.log('=== TEXT TỪ PDF ===\n' + text.substring(0, 800) + '\n==================');

  // ── Số văn bản ──────────────────────────────────────────────
  // Đặc thù văn bản PXNL: "Số: 612/PXNL" — chỉ lấy phần số/mã
  // Tránh nhầm với "Số trang", "Số lượng", v.v.
  const soMatch = text.match(/[Ss]ố\s*:\s*(\d+\s*\/\s*[A-Za-zÀ-ỹĐđ][A-Za-zÀ-ỹĐđ0-9\-]*)/);
  if (soMatch) {
    result.so_vb = soMatch[1].replace(/\s+/g, '').trim(); // bỏ khoảng trắng trong số
  }

  // ── Ngày văn bản ────────────────────────────────────────────
  // Mẫu PXNL: "Lâm Đồng, ngày 08 tháng 6 năm 2026"
  // Ưu tiên mẫu đầy đủ "ngày DD tháng M năm YYYY"
  const ngayMatch = text.match(/ngày\s+(\d{1,2})\s+tháng\s+(\d{1,2})\s+năm\s+(\d{4})/i);
  if (ngayMatch) {
    const d = ngayMatch[1].padStart(2,'0');
    const mo = ngayMatch[2].padStart(2,'0');
    const y = ngayMatch[3];
    result.ngay_vb = `${y}-${mo}-${d}`;
  }

  // ── Về việc ─────────────────────────────────────────────────
  // Mẫu PXNL: "V/v thực hiện các hạng mục..." (có thể xuống nhiều dòng)
  const vvMatch = text.match(/V\/v\s+([\s\S]{5,400}?)(?:\n\s*\n|\nKính|\nNhận|\nNơi|$)/i);
  if (vvMatch) {
    result.ve_viec = 'V/v ' + vvMatch[1].replace(/[\r\n]+/g,' ').replace(/\s+/g,' ').trim();
    // Giới hạn độ dài hợp lý
    if (result.ve_viec.length > 200) result.ve_viec = result.ve_viec.substring(0, 200).trim();
  }
  if (!result.ve_viec) {
    result.ve_viec = filename
      .replace(/\.[^.]+$/, '')
      .replace(/[_\-]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  console.log('>>> KẾT QUẢ TRÍCH XUẤT:');
  console.log('    Số VB :', result.so_vb);
  console.log('    Ngày  :', result.ngay_vb, '(YYYY-MM-DD → ngày/tháng/năm)');
  console.log('    V/v   :', result.ve_viec.substring(0, 80));
  return result;
}

app.post('/api/parse-file', uploadTemp.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Không có file' });

  const filePath = req.file.path;
  const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
  const ext = path.extname(originalName).toLowerCase();

  try {
    let text = '';

    if (ext === '.pdf') {
      const buf = fs.readFileSync(filePath);
      const data = await pdfParse(buf);
      text = data.text || '';
    } else if (ext === '.docx' || ext === '.doc') {
      const result = await mammoth.extractRawText({ path: filePath });
      text = result.value || '';
    } else {
      // Với file khác (ảnh, zip...) chỉ dùng tên file
      text = '';
    }

    fs.unlinkSync(filePath); // Xóa file tạm ngay

    const info = extractDocInfo(text, originalName);
    res.json({ success: true, ...info, filename: originalName });

  } catch (err) {
    try { fs.unlinkSync(filePath); } catch(e) {}
    res.status(500).json({ error: 'Không đọc được file: ' + err.message });
  }
});

// ─── API: Kiểm tra kết nối SMTP ───────────────────────────────
app.post('/api/test-smtp', async (req, res) => {
  const data = loadData();
  const { smtp } = data;
  if (!smtp.host || !smtp.user || !smtp.pass) {
    return res.status(400).json({ error: 'Chưa cấu hình SMTP đầy đủ' });
  }
  try {
    const transporter = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.port === 465,
      auth: { user: smtp.user, pass: smtp.pass },
      tls: { rejectUnauthorized: false },
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 20000
    });
    await transporter.verify();
    res.json({ success: true, message: 'Kết nối SMTP thành công!' });
  } catch (err) {
    res.status(500).json({ error: 'Lỗi kết nối: ' + err.message });
  }
});

// ─── API: Gửi email ────────────────────────────────────────────
app.post('/api/send', upload.single('file'), async (req, res) => {
  const data = loadData();
  const { smtp } = data;

  if (!smtp.host || !smtp.user || !smtp.pass) {
    return res.status(400).json({ error: 'Chưa cấu hình SMTP. Vào Cài đặt để thiết lập.' });
  }

  const { so_vb, ngay_vb, ve_viec, to_emails, noi_dung_them } = req.body;
  const file = req.file;

  if (!to_emails) return res.status(400).json({ error: 'Chưa chọn người nhận' });

  // Xây dựng nội dung email
  // Định dạng ngày: 08/6/2026
  let ngayFormatted = '____________';
  if (ngay_vb) {
    const [y, mo, d] = ngay_vb.split('-');
    ngayFormatted = `${parseInt(d)}/${parseInt(mo)}/${y}`;
  }
  const subject = `Thông báo số ${so_vb || '____'} ngày ${ngayFormatted}`;

  const bodyText = `Kính gửi CBCNV PXNL

Thông báo số ${so_vb || '____________'} ngày ${ngayFormatted}
${ve_viec || '____________________________________________'}
${noi_dung_them ? '\n' + noi_dung_them : ''}

Trân trọng.`;

  const bodyHtml = `
<div style="font-family: Arial, sans-serif; font-size: 14px; color: #222; max-width: 680px; margin: 0 auto; padding: 10px;">
  <p style="margin: 0 0 16px 0;">Kính gửi <strong>CBCNV PXNL</strong></p>
  <p style="margin: 0 0 6px 0;">Thông báo số <strong>${so_vb || '____________'}</strong> ngày <strong>${ngayFormatted}</strong></p>
  <p style="margin: 0 0 16px 0; font-style: italic;">${ve_viec || ''}</p>
  ${noi_dung_them ? `<p style="margin: 0 0 16px 0;">${noi_dung_them.replace(/\n/g, '<br>')}</p>` : ''}
  <p style="margin: 0;">Trân trọng./.</p>
</div>`;

  // Danh sách người nhận
  const toList = Array.isArray(to_emails) ? to_emails : [to_emails];
  const toAddresses = toList.join(', ');

  try {
    const transporter = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.port === 465,
      auth: { user: smtp.user, pass: smtp.pass },
      tls: { rejectUnauthorized: false },
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 20000
    });

    const mailOptions = {
      from: `"${smtp.from || 'PXNL Thông báo'}" <${smtp.user}>`,
      to: toAddresses,
      subject,
      text: bodyText,
      html: bodyHtml,
    };

    if (file) {
      const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
      mailOptions.attachments = [{
        filename: originalName,
        path: file.path
      }];
    }

    const info = await transporter.sendMail(mailOptions);

    // Xóa file upload sau khi gửi xong
    if (file) {
      setTimeout(() => {
        try { fs.unlinkSync(file.path); } catch (e) {}
      }, 5000);
    }

    res.json({
      success: true,
      message: `Đã gửi thành công tới ${toList.length} người nhận!`,
      messageId: info.messageId
    });
  } catch (err) {
    // Xóa file nếu gửi lỗi
    if (file) try { fs.unlinkSync(file.path); } catch (e) {}
    res.status(500).json({ error: 'Lỗi gửi mail: ' + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n✅ Phần mềm gửi mail đang chạy tại: http://localhost:${PORT}\n`);
});

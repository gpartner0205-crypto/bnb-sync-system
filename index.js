require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { google } = require('googleapis');

const app = express();
app.use(express.json());

// 取得主機設定的 Port，若無則預設 3000
const PORT = process.env.PORT || 3000;

// 1. 初始化 Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

// 2. 解析 Google 金鑰 JSON
let googleKey;
try {
  googleKey = JSON.parse(process.env.GOOGLE_KEY_JSON);
} catch (e) {
  console.error('❌ 解析 GOOGLE_KEY_JSON 失敗，請確認環境變數格式正確。');
  process.exit(1);
}

// 3. 初始化 Google Calendar API
const auth = new google.auth.GoogleAuth({
  credentials: googleKey,
  scopes: ['https://www.googleapis.com/auth/calendar'],
});
const calendar = google.calendar({ version: 'v3', auth });

/**
 * 新增訂房並同步至 Google 日曆
 */
async function addBooking({ guestName, guestPhone, roomName, checkIn, checkOut, totalPrice, source = 'Direct' }) {
  console.log(`\n⏳ 開始處理 ${guestName} 的訂房手續...`);

  const { data: rooms, error: roomError } = await supabase
    .from('bms_rooms')
    .select('id, room_name');

  if (roomError) {
    throw new Error(`讀取房間資料庫失敗: ${roomError.message}`);
  }

  const room = rooms.find(r => r.room_name.trim() === roomName.trim());

  if (!room) {
    throw new Error(`找不到房間：${roomName}，請確認資料庫已有該房間名稱。`);
  }

  console.log('📅 正在同步至 Google 日曆...');
  const event = {
    summary: `[訂房] ${guestName} - ${roomName}`,
    description: `顧客姓名: ${guestName}\n電話: ${guestPhone}\n房型: ${roomName}\n總金額: $${totalPrice}\n來源: ${source}`,
    start: { date: checkIn },
    end: { date: checkOut },
  };

  const gRes = await calendar.events.insert({
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    resource: event,
  });

  const googleEventId = gRes.data.id;
  console.log(`✅ Google 日曆同步成功！Event ID: ${googleEventId}`);

  console.log('💾 正在寫入 Supabase 資料庫...');
  const { data: booking, error: bookingError } = await supabase
    .from('bookings')
    .insert([
      {
        guest_name: guestName,
        guest_phone: guestPhone,
        room_id: room.id,
        check_in: checkIn,
        check_out: checkOut,
        total_price: totalPrice,
        source: source,
        google_event_id: googleEventId
      }
    ])
    .select();

  if (bookingError) throw bookingError;

  console.log('🎉 訂房完成！');
  return booking[0];
}

// 建立一個健康檢查與接收訂房的 API 路由
app.get('/', (req, res) => {
  res.send('民宿訂房與 Google 日曆同步服務正在運行中 🚀');
});

app.post('/api/booking', async (req, res) => {
  try {
    const result = await addBooking(req.body);
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('❌ 處理訂房失敗：', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 啟動伺服器，讓程式保持常駐，不會提早結束
app.listen(PORT, () => {
  console.log(`伺服器已啟動，正在傾聽 Port: ${PORT}`);
});

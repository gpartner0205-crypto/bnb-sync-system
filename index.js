require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { google } = require('googleapis');

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
  try {
    console.log(`\n⏳ 開始處理 ${guestName} 的訂房手續...`);

    const { data: room, error: roomError } = await supabase
      .from('rooms')
      .select('id')
      .eq('room_name', roomName)
      .single();

    if (roomError || !room) {
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

    console.log('🎉 訂房完成且已同步資料庫與 Google 日曆！');
    console.log('訂房資料：', booking[0]);

  } catch (err) {
    console.error('❌ 處理訂房失敗：', err.message);
  }
}

// 執行測試訂房
addBooking({
  guestName: '陳小明',
  guestPhone: '0912345678',
  roomName: '101 雙人房',
  checkIn: '2026-08-15',
  checkOut: '2026-08-17',
  totalPrice: 4000,
  source: '官方LINE'
});

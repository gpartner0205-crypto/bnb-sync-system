require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
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

// 4. LINE 機器人設定
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};
const lineClient = new line.messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});

// 5. 初始化 Express 伺服器
const app = express();

/**
 * 核心：新增訂房並同步至 Google 日曆與 Supabase
 */
async function addBooking({ guestName, guestPhone, roomName, checkIn, checkOut, totalPrice, source = '官方LINE' }) {
  try {
    const { data: rooms, error: roomError } = await supabase
      .from('bms_rooms')
      .select('id, room_name');

    if (roomError) throw new Error(`讀取房間資料庫失敗: ${roomError.message}`);
    const room = rooms.find(r => r.room_name.trim() === roomName.trim());
    if (!room) throw new Error(`找不到房間：${roomName}，請確認資料庫已有該房間名稱。`);

    const event = {
      summary: `[訂房] ${guestName} - ${roomName}`,
      description: `顧客姓名: ${guestName}\n電話: ${guestPhone}\n房型: ${roomName}\n總金額: $${totalPrice}`,
      start: { date: checkIn },
      end: { date: checkOut },
    };

    const gRes = await calendar.events.insert({ calendarId: process.env.GOOGLE_CALENDAR_ID, resource: event });
    const { data: booking, error: bookingError } = await supabase
      .from('bookings')
      .insert([{ guest_name: guestName, guest_phone: guestPhone, room_id: room.id, check_in: checkIn, check_out: checkOut, total_price: totalPrice, source: source, google_event_id: gRes.data.id }])
      .select();

    if (bookingError) throw bookingError;
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// 6. LINE Webhook 接收路由
app.post('/webhook', line.middleware(lineConfig), (req, res) => {
  Promise.all(req.body.events.map(handleEvent)).then((result) => res.json(result)).catch((err) => { console.error(err); res.status(500).end(); });
});

// 7. 處理 LINE 訊息
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return Promise.resolve(null);

  const userText = event.message.text.trim();
  const parts = userText.split(' ');

  // --- 新增：開關房功能 ---
  if (parts.length === 3 && (parts[2] === '開' || parts[2] === '關')) {
    const roomName = parts[0];
    const dateCode = parts[1];
    const action = parts[2];
    
    let targetDates = [];
    try {
        if (dateCode.length === 8) {
            targetDates.push(`${dateCode.substring(0, 4)}-${dateCode.substring(4, 6)}-${dateCode.substring(6, 8)}`);
        } else if (dateCode.length === 12) {
            targetDates.push(`${dateCode.substring(0, 4)}-${dateCode.substring(4, 6)}-${dateCode.substring(6, 8)}`);
            targetDates.push(`${dateCode.substring(0, 4)}-${dateCode.substring(8, 10)}-${dateCode.substring(10, 12)}`);
        }

        if (action === '關') {
            for (let d of targetDates) {
                await calendar.events.insert({
                    calendarId: process.env.GOOGLE_CALENDAR_ID,
                    resource: { summary: `[關房] ${roomName}`, start: { date: d }, end: { date: d } }
                });
            }
            return lineClient.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: `🔒 已關閉 ${roomName} (${targetDates.join(', ')})` }] });
        } else {
            let count = 0;
            for (let d of targetDates) {
                const list = await calendar.events.list({ calendarId: process.env.GOOGLE_CALENDAR_ID, timeMin: `${d}T00:00:00Z`, timeMax: `${d}T23:59:59Z`, q: `[關房] ${roomName}` });
                for (let e of list.data.items) { await calendar.events.delete({ calendarId: process.env.GOOGLE_CALENDAR_ID, eventId: e.id }); count++; }
            }
            return lineClient.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: `🔓 已開啟 ${roomName} (${targetDates.join(', ')})，共刪除 ${count} 筆關房紀錄。` }] });
        }
    } catch (err) {
        return lineClient.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: `❌ 錯誤：${err.message}` }] });
    }
  }

  // --- 原有訂房功能 ---
  if (userText.startsWith('訂房')) {
    const p = userText.split(' ');
    if (p.length < 8) return lineClient.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: '格式錯誤，請用：訂房 [姓名] [電話] [房型] [入住] [退房] [金額]' }] });
    
    const result = await addBooking({ guestName: p[1], guestPhone: p[2], roomName: `${p[3]} ${p[4]}`, checkIn: p[5], checkOut: p[6], totalPrice: parseInt(p[7], 10) });
    return lineClient.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: result.success ? '✅ 訂房成功！' : `❌ 失敗：${result.error}` }] });
  }

  return lineClient.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: '可用指令：\n[房號] [日期碼] 開/關\n訂房 [姓名] [電話] [房型] [入住] [退房] [金額]' }] });
}

app.get('/', (req, res) => res.status(200).send('Bot Running'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 伺服器已啟動 Port ${PORT}`));

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

// 4. LINE 機器人設定（使用最新版 SDK 寫法）
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
    console.log(`\n⏳ 開始處理 ${guestName} 的訂房手續...`);

    const { data: rooms, error: roomError } = await supabase
      .from('bms_rooms')
      .select('id, room_name');

    if (roomError) {
      throw new Error(`讀取房間資料庫失敗: ${roomError.message}`);
    }

    const room = rooms.find(r => r.room_name.trim() === roomName.trim());

    if (!room) {
      console.log('目前資料庫裡的房間列表：', rooms.map(r => `"${r.room_name}"`));
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
      return { success: true, booking: booking[0] };

  } catch (err) {
    console.error('❌ 處理訂房失敗：', err.message);
    return { success: false, error: err.message };
  }
}

// 6. LINE Webhook 接收路由
app.post('/webhook', line.middleware(lineConfig), (req, res) => {
  Promise
    .all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

// 7. 處理 LINE 傳進來的訊息事件
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  const userText = event.message.text.trim();

  // 測試指令範例：「訂房 陳小明 0912345678 101 雙人房 2026-08-15 2026-08-17 4000」
  if (userText.startsWith('訂房')) {
    const parts = userText.split(' ');
    
    if (parts.length < 8) {
      return lineClient.replyMessage({
        replyToken: event.replyToken,
        messages: [{
          type: 'text',
          text: '格式錯誤！請依照以下格式輸入：\n訂房 [姓名] [電話] [房型] [入住日] [退房日] [金額]\n例如：訂房 陳小明 0912345678 101 雙人房 2026-08-15 2026-08-17 4000'
        }]
      });
    }

    const guestName = parts[1];
    const guestPhone = parts[2];
    const roomName = `${parts[3]} ${parts[4]}`; // 組合「101 雙人房」
    const checkIn = parts[5];
    const checkOut = parts[6];
    const totalPrice = parseInt(parts[7], 10);

    // 執行訂房程序
    const result = await addBooking({
      guestName,
      guestPhone,
      roomName,
      checkIn,
      checkOut,
      totalPrice,
      source: '官方LINE'
    });

    if (result.success) {
      return lineClient.replyMessage({
        replyToken: event.replyToken,
        messages: [{
          type: 'text',
          text: `✅ 訂房成功！\n客人：${guestName}\n房型：${roomName}\n入住：${checkIn} ~ ${checkOut}\n已同步至 Google 日曆與資料庫。`
        }]
      });
    } else {
      return lineClient.replyMessage({
        replyToken: event.replyToken,
        messages: [{
          type: 'text',
          text: `❌ 訂房失敗：${result.error}`
        }]
      });
    }
  }

  // 一般對話回覆
  return lineClient.replyMessage({
    replyToken: event.replyToken,
    messages: [{
      type: 'text',
      text: `您傳送的是：「${userText}」。\n如需訂房請輸入「訂房 姓名 電話 房型 入住日 退房日 金額」`
    }]
  });
}

// 讓 UptimeRobot 訪問根網址時回傳 200 成功
app.get('/', (req, res) => {
  res.status(200).send('B&B Bot is running successfully!');
});

// 8. 啟動伺服器監聽 Port
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 伺服器已啟動，正在監聽 Port ${PORT}`);
});

// farm-telegram-bot — Cloudflare Worker (production-ready baseline)
// Fixes applied:
// - Separate ADMIN_USER_ID (permissions) from ADMIN_CHAT_ID (where to send admin notifications)
// - Robust extraction of chat_id / from_id for message and callback_query
// - Telegram API calls log HTTP errors (status + body) for easier debugging
// - Removed parse_mode="Markdown" from dynamic/admin messages to avoid underscore/entity parsing failures
// - Booking IDs use hyphens instead of underscores

export default {
  async fetch(request, env, ctx) {
    // SAFETY: never let an unhandled error return 500 to Telegram.
    // We log the error, but respond 200 OK so Telegram doesn't disable webhook.
    try {
      const url = new URL(request.url);
      // Health check / any other path
      if (url.pathname !== "/webhook") {
        return new Response("OK", { status: 200 });
      }
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405 });
      }
      let update;
      try {
        update = await request.json();
      } catch (e) {
        console.log("JSON error", String(e));
        return new Response("OK", { status: 200 });
      }
      // --- Update helpers (message + callback_query) ---
      function getChatId(u) {
        return u?.message?.chat?.id ?? u?.callback_query?.message?.chat?.id ?? null;
      }
    function getFromId(u) {
      return u?.message?.from?.id ?? u?.callback_query?.from?.id ?? null;
    }

    function isAdminUserId(userId) {
      if (!env.ADMIN_USER_ID) return false;
      return String(userId) === String(env.ADMIN_USER_ID);
    }

    const incomingChatId = getChatId(update);
    const incomingFromId = getFromId(update);

    console.log("INCOMING", {
      hasMessage: Boolean(update?.message),
      hasCallback: Boolean(update?.callback_query),
      chatId: incomingChatId,
      fromId: incomingFromId,
    });

    const TELEGRAM = `https://api.telegram.org/bot${env.BOT_TOKEN}`;

    // --- Telegram helpers ---
    async function callTelegram(method, payload) {
      const res = await fetch(`${TELEGRAM}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });

      const body = await res.text().catch(() => "");
      if (!res.ok) {
        console.log("TG_ERROR", method, res.status, body, payload);
      }
      return { ok: res.ok, status: res.status, body };
    }

    async function sendMessage(chatId, text, keyboard = null) {
      const payload = { chat_id: chatId, text };
      if (keyboard) payload.reply_markup = keyboard;
      await callTelegram("sendMessage", payload);
    }

    async function editMessageText(chatId, messageId, text, keyboard = null) {
      const payload = { chat_id: chatId, message_id: messageId, text };
      if (keyboard) payload.reply_markup = keyboard;
      await callTelegram("editMessageText", payload);
    }

    async function answerCallbackQuery(callbackQueryId, text, showAlert = false) {
      const payload = { callback_query_id: callbackQueryId, text, show_alert: showAlert };
      await callTelegram("answerCallbackQuery", payload);
    }

    // --- KV helpers for bookings ---
    async function getBooking(bookingId) {
      const raw = await env.BOOKINGS.get(`booking:${bookingId}`);
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch (e) {
        console.log("BOOKINGS parse error", String(e));
        return null;
      }
    }

    async function saveBooking(booking) {
      if (!booking?.id) return;
      await env.BOOKINGS.put(`booking:${booking.id}`, JSON.stringify(booking));
    }

    // Booking ID without underscores (prevents Markdown/entity issues even if parse_mode is used elsewhere)
    function generateBookingId(data) {
      const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      const eventPart = data?.data?.date || "na";
      const ts = Date.now();
      return `bk-${eventPart}-${today}-${ts}`;
    }

    async function createBooking(data) {
      const id = generateBookingId(data);
      const booking = {
        id,
        type: data.type || "unknown",
        chatId: data.chatId,
        status: "new",
        createdAt: Date.now(),
        people: data.people || 0,
        data: data.data || {},
      };
      await saveBooking(booking);
      return booking;
    }

    // === ADMIN FLOW ==========================================================
    // Admin inline keyboard for booking approval / rejection
    function buildAdminBookingKeyboard(bookingId) {
      return {
        inline_keyboard: [
          [
            { text: "✅ Подтвердить", callback_data: `confirm:${bookingId}` },
            { text: "❌ Отклонить", callback_data: `cancel:${bookingId}` },
          ],
        ],
      };
    }

    // Callback handlers (admin actions)
    async function handleAdminBookingAction(callbackQuery) {
      const data = callbackQuery.data || "";
      const cbId = callbackQuery.id;
      const msg = callbackQuery.message;
      const chatId = msg?.chat?.id;
      const messageId = msg?.message_id;

      const parts = data.split(":");
      const action = parts[0];
      const bookingId = parts[1];

      const booking = await getBooking(bookingId);
      if (!booking) {
        await answerCallbackQuery(cbId, "Заявка не найдена.");
        return;
      }

      if (action === "confirm") {
        if (booking.status === "confirmed") {
          await answerCallbackQuery(cbId, "Заявка уже подтверждена.");
          return;
        }

        booking.status = "confirmed";
        await saveBooking(booking);

        let adminText = `Заявка ${booking.id} подтверждена.\n\n`;
        if (booking.data) {
          if (booking.data.date) adminText += `Дата: ${booking.data.date}\n`;
          if (booking.data.time) adminText += `Время: ${booking.data.time}\n`;
          if (booking.data.name) adminText += `Имя: ${booking.data.name}\n`;
          if (booking.data.people) adminText += `Гостей: ${booking.data.people}\n`;
          if (booking.data.contact) adminText += `Контакт: ${booking.data.contact}\n`;
        }
        adminText += `\nСтатус: ✅ подтверждена`;

        if (chatId && messageId) {
          await editMessageText(chatId, messageId, adminText);
        }

        if (booking.chatId) {
          const userText = `Ваша заявка ${booking.id} подтверждена.`;
          await sendMessage(booking.chatId, userText);
        }

        await answerCallbackQuery(cbId, "Заявка подтверждена.");
        return;
      }

      if (action === "cancel") {
        if (booking.status === "cancelled") {
          await answerCallbackQuery(cbId, "Заявка уже отклонена.");
          return;
        }

        booking.status = "cancelled";
        await saveBooking(booking);

        let adminText = `Заявка ${booking.id} отклонена.\n\n`;
        if (booking.data) {
          if (booking.data.date) adminText += `Дата: ${booking.data.date}\n`;
          if (booking.data.time) adminText += `Время: ${booking.data.time}\n`;
          if (booking.data.name) adminText += `Имя: ${booking.data.name}\n`;
          if (booking.data.people) adminText += `Гостей: ${booking.data.people}\n`;
          if (booking.data.contact) adminText += `Контакт: ${booking.data.contact}\n`;
        }
        adminText += `\nСтатус: ❌ отклонена`;

        if (chatId && messageId) {
          await editMessageText(chatId, messageId, adminText);
        }

        if (booking.chatId) {
          await sendMessage(
            booking.chatId,
            `Ваша заявка ${booking.id} отклонена. Если это ошибка — свяжитесь с нами.`
          );
        }

        await answerCallbackQuery(cbId, "Заявка отклонена.");
        return;
      }

      await answerCallbackQuery(cbId, "Неизвестное действие.");
    }

    // --- Handle callback_query first (ADMIN FLOW) ---
    if (update.callback_query) {
      const callbackQuery = update.callback_query;
      const fromId = callbackQuery?.from?.id;

      if (!isAdminUserId(fromId)) {
        await answerCallbackQuery(callbackQuery.id, "Недостаточно прав.");
        return new Response("OK");
      }

      const data = callbackQuery.data || "";

      if (data.startsWith("confirm:") || data.startsWith("cancel:")) {
        await handleAdminBookingAction(callbackQuery);
        return new Response("OK");
      }

      await answerCallbackQuery(callbackQuery.id, "Неизвестная команда.");
      return new Response("OK");
    }
    // === /ADMIN FLOW =========================================================

    // === USER FLOW ===========================================================
    // --- Handle normal messages (ignore non-message updates like web_app_data only) ---
    const message = update.message;
    if (!message) {
      return new Response("OK");
    }

    const chatId = message.chat.id;
    const text = message.text || "";
    const userKey = `user:${chatId}`;
    const now = Date.now();

    // --- Session state in KV (STATE) ---
    let sessionRaw = await env.STATE.get(userKey);
    let session = {};
    if (sessionRaw) {
      try {
        session = JSON.parse(sessionRaw);
      } catch (e) {
        console.log("STATE parse error", String(e));
        session = {};
      }
    }

    if (session.expiresAt && now > session.expiresAt) {
      await env.STATE.delete(userKey);
      session = {};
    }

    async function setState(newState) {
      newState.expiresAt = Date.now() + 600000; // 10 minutes
      await env.STATE.put(userKey, JSON.stringify(newState));
      session = newState;
    }

    async function clearState() {
      await env.STATE.delete(userKey);
      session = {};
    }

    // --- Keyboards ---
    function buildMainKeyboard() {
      const rows = [
        [{ text: "📅 Записаться на экскурсию" }],
        [{ text: "🐄 Экскурсии" }, { text: "📅 Расписание" }],
        [{ text: "🛒 Продукция" }, { text: "📍 Как добраться" }],
        [{ text: "🔄 Сбросить заявку" }],
        [{ text: "🏡 Главное меню" }],
      ];
      return { keyboard: rows, resize_keyboard: true };
    }

    // Flow keyboard используется ТОЛЬКО во время экскурсионного флоу.
    // Важно: НЕ использовать remove_keyboard, чтобы пользователь
    // всегда мог нажать "🔄 Сбросить заявку" или "🏡 Главное меню".
    function buildFlowKeyboard() {
      return {
        keyboard: [[{ text: "🔄 Сбросить заявку" }, { text: "🏡 Главное меню" }]],
        resize_keyboard: true,
      };
    }


    // Step keyboard for ex_people:
    // - people selection only (no free input)
    // - keeps reset/menu always available
    function buildExPeopleKeyboard() {
      return {
        keyboard: [
          [{ text: "1" }, { text: "2" }, { text: "3" }],
          [{ text: "4" }, { text: "5" }, { text: "6" }],
          [{ text: "6–10" }, { text: "более 11" }],
          [{ text: "🔄 Сбросить заявку" }, { text: "🏡 Главное меню" }],
        ],
        resize_keyboard: true,
      };
    }

    const mainKeyboard = buildMainKeyboard();
    const flowKeyboard = buildFlowKeyboard();
    const exPeopleKeyboard = buildExPeopleKeyboard();

    // --- Global actions (must work in any state) ---
    // Глобальный сброс заявки. Должен срабатывать В ЛЮБОМ состоянии, включая ex_* шаги.
    if (text === "🔄 Сбросить заявку") {
      await clearState();
      await sendMessage(chatId, "Заявка сброшена. Можете начать заново.", mainKeyboard);
      return new Response("OK");
    }

    // Start / main menu (also exits any flow)
    if (text.startsWith("/start") || text === "🏡 Главное меню") {
      await clearState();
      await sendMessage(chatId, "Добро пожаловать на Ферму Голубой Коровы!\n\nВыберите действие:", mainKeyboard);
      return new Response("OK");
    }

    // Info blocks
    if (text === "🐄 Экскурсии") {
      await sendMessage(
        chatId,
        "Ферма Голубой Коровы приглашает вас на экскурсии:\n\n" +
          "1) Обзорная экскурсия — 1 час\n" +
          "— знакомство с коровами, козами, ламами\n" +
          "— кормление животных\n" +
          "— прогулка по территории\n\n" +
          "2) Гастро-тур — 1.5 часа\n" +
          "— дегустация сыра и свежего молока\n" +
          "— мини-лекция о сыроварне\n\n" +
          "3) Семейная экскурсия — 1 час\n" +
          "— формат для детей\n" +
          "— дружелюбные животные\n",
        mainKeyboard
      );
      return new Response("OK");
    }

    if (text === "📅 Расписание") {
      await sendMessage(
        chatId,
        "Экскурсии каждый день по предварительной записи с 10:00 до 18:00.\n" +
          "Магазин работает с 11:00 до 17:00.\n" +
          "Бронируйте заранее.",
        mainKeyboard
      );
      return new Response("OK");
    }

    if (text === "📍 Как добраться") {
      await sendMessage(
        chatId,
        "Адрес:\nПсковская область, Печорский район,\nдеревня Подлесье, Центральная 10.\n\n" +
          "В навигатор: Ферма Голубой Коровы\n" +
          "От Пскова → 55 минут\nОт Изборска → 20 минут\nОт Печор → 15 минут",
        mainKeyboard
      );
      return new Response("OK");
    }

    if (text === "🛒 Продукция") {
      await sendMessage(
        chatId,
        "Наша продукция:\n" +
          "— выдержанные сыры\n— сыры\n— сырники\n— масло сливочное\n— говядина и телятина\n\n" +
          "Купить можно в фермерском магазине.",
        mainKeyboard
      );
      return new Response("OK");
    }

    // --- Excursion booking flow (no capacity control) ---
    // Вход в экскурсионный сценарий.
    // ВАЖНО: сразу показываем flow keyboard, чтобы кнопки были доступны с первого шага.
    if (text === "📅 Записаться на экскурсию") {
      await setState({ step: "ex_name" });
      await sendMessage(
        chatId,
        "Как вас зовут?\n\nВы можете в любой момент сбросить заявку или вернуться в главное меню.",
        flowKeyboard
      );
      return new Response("OK");
    }

    // Каждый шаг экскурсионного флоу ОБЯЗАН использовать flowKeyboard.
    // Это гарантирует, что пользователь не застрянет в сценарии.
    if (session.step === "ex_name") {
      session.name = text;
      session.step = "ex_date";
      await setState(session);
      await sendMessage(chatId, "На какую дату хотите записаться?", flowKeyboard);
      return new Response("OK");
    }

    if (session.step === "ex_date") {
      session.date = text;
      session.step = "ex_time";
      await setState(session);
      await sendMessage(chatId, "Во сколько? (например, 11:30 / 15:30 (летом))", flowKeyboard);
      return new Response("OK");
    }

    if (session.step === "ex_time") {
      session.time = text;
      session.step = "ex_people";
      await setState(session);
      await sendMessage(chatId, "Сколько гостей будет?", exPeopleKeyboard);
      return new Response("OK");
    }

    if (session.step === "ex_people") {
      // Only accept button values
      const allowed = new Set(["1", "2", "3", "4", "5", "6", "6–10", "более 11"]);
      if (!allowed.has(text)) {
        await sendMessage(
          chatId,
          "Пожалуйста, выберите количество гостей кнопкой ниже.",
          exPeopleKeyboard
        );
        return new Response("OK");
      }

      // Keep stored value compatible with existing parseInt behavior downstream
      // - "6–10" => "6-10"
      // - "более 11" => "11+"
      session.people = text === "6–10" ? "6-10" : text === "более 11" ? "11+" : text;

      session.step = "ex_contact";
      await setState(session);
      await sendMessage(chatId, "Ваш телефон или Telegram?", flowKeyboard);
      return new Response("OK");
    }

    if (session.step === "ex_contact") {
      session.contact = text;

      const peopleNum = parseInt(session.people || "0", 10) || 0;

      const bookingData = {
        type: "excursion",
        chatId,
        people: peopleNum,
        data: {
          name: session.name,
          date: session.date,
          time: session.time,
          people: session.people,
          contact: session.contact,
        },
      };

      const booking = await createBooking(bookingData);

      const msg =
        "Новая заявка на экскурсию:\n\n" +
        `ID: ${booking.id}\n` +
        `Имя: ${session.name}\n` +
        `Дата: ${session.date}\n` +
        `Время: ${session.time}\n` +
        `Гостей: ${session.people}\n` +
        `Контакт: ${session.contact}`;

      if (env.ADMIN_CHAT_ID) {
        await callTelegram("sendMessage", {
          chat_id: env.ADMIN_CHAT_ID,
          text: msg,
          reply_markup: buildAdminBookingKeyboard(booking.id),
        });
      } else {
        console.log("ADMIN_CHAT_ID is empty — cannot notify admin");
      }

      await sendMessage(chatId, "Спасибо! Ваша заявка отправлена. Мы свяжемся с вами для подтверждения.", mainKeyboard);
      await clearState();
      return new Response("OK");
    }

    // Fallback
    await sendMessage(chatId, "Спасибо! Мы свяжемся с вами.", mainKeyboard);
    } catch (err) {
      console.log("UNHANDLED_WEBHOOK_ERROR", String(err), err?.stack || "");
      // IMPORTANT: always 200 OK for Telegram
      return new Response("OK", { status: 200 });
    }
    return new Response("OK");
    // === /USER FLOW ==========================================================
  },
};

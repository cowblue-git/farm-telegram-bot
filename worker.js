// farm-telegram-bot — Cloudflare Worker (production-ready baseline)
// Fixes applied:
// - Separate ADMIN_USER_ID (permissions) from ADMIN_CHAT_ID (where to send admin notifications)
// - Robust extraction of chat_id / from_id for message and callback_query
// - Telegram API calls log HTTP errors (status + body) for easier debugging
// - Removed parse_mode="Markdown" from dynamic/admin messages to avoid underscore/entity parsing failures
// - Booking IDs use hyphens instead of underscores

export default {
  async fetch(request, env, ctx) {
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
      return (
        u?.message?.chat?.id ??
        u?.callback_query?.message?.chat?.id ??
        null
      );
    }

    function getFromId(u) {
      return (
        u?.message?.from?.id ??
        u?.callback_query?.from?.id ??
        null
      );
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

    // --- New Year events definitions ---
    const winterEvents = [
      { id: "ny-03", label: "03.01 — Ёлка у Снежной королевы", date: "03.01", title: "Ёлка у Снежной королевы" },
      { id: "ny-04", label: "04.01 — Дегустация «Мир холодца и студня» (Коллагеновый день)", date: "04.01", title: "Дегустация «Мир холодца и студня» (Коллагеновый день)" },
      { id: "ny-05", label: "05.01 — Сырные традиции народов мира: Индия, Италия, Франция", date: "05.01", title: "Сырные традиции народов мира: Индия, Италия, Франция" },
      { id: "ny-06", label: "06.01 — Детская программа «Коза-Дереза и её африканские родственники»", date: "06.01", title: "Детская программа «Коза-Дереза и её африканские родственники»" },
      { id: "ny-07", label: "07.01 — «От носа до хвоста»: дегустация сыров и стейки", date: "07.01", title: "«От носа до хвоста»: дегустация сыров и стейки" },
      { id: "ny-08", label: "08.01 — Дегустация «Пицца и каннеллони»", date: "08.01", title: "Дегустация «Пицца и каннеллони»" },
      { id: "ny-09", label: "09.01 — Русский день. «Зимние традиции и угощения»", date: "09.01", title: "Русский день. «Зимние традиции и угощения»" },
    ];

    // --- KV helpers for events & bookings ---
    async function getEventState(eventId) {
      const key = `event:${eventId}`;
      let raw = await env.EVENTS.get(key);
      let state = null;

      if (raw) {
        try { state = JSON.parse(raw); } catch (e) { console.log("EVENTS parse error", String(e)); }
      }
      if (!state) {
        state = { capacity: 40, booked: 0 };
        await env.EVENTS.put(key, JSON.stringify(state));
      }
      return { key, state };
    }

    async function saveEventState(key, state) {
      await env.EVENTS.put(key, JSON.stringify(state));
    }

    async function getBooking(bookingId) {
      const raw = await env.BOOKINGS.get(`booking:${bookingId}`);
      if (!raw) return null;
      try { return JSON.parse(raw); } catch (e) { console.log("BOOKINGS parse error", String(e)); return null; }
    }

    async function saveBooking(booking) {
      if (!booking?.id) return;
      await env.BOOKINGS.put(`booking:${booking.id}`, JSON.stringify(booking));
    }

    // Booking ID without underscores (prevents Markdown/entity issues even if parse_mode is used elsewhere)
    function generateBookingId(data) {
      const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      const eventPart =
        (data?.data?.date) ||
        data?.nyEventDate ||
        "na";
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
        nyEventId: data.nyEventId || null,
        createdAt: Date.now(),
        people: data.people || 0,
        data: data.data || {},
      };
      await saveBooking(booking);
      return booking;
    }

    // --- Admin inline keyboards ---
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

    function buildAdminEventsMenuKeyboard() {
      return {
        inline_keyboard: [
          [{ text: "📊 Все мероприятия", callback_data: "events:all" }],
          [
            { text: "03.01", callback_data: "events:ny-03" },
            { text: "04.01", callback_data: "events:ny-04" },
            { text: "05.01", callback_data: "events:ny-05" },
          ],
          [
            { text: "06.01", callback_data: "events:ny-06" },
            { text: "07.01", callback_data: "events:ny-07" },
            { text: "08.01", callback_data: "events:ny-08" },
          ],
          [{ text: "09.01", callback_data: "events:ny-09" }],
        ],
      };
    }

    // --- /events summary + detail ---
    async function sendEventsSummaryMessage(chatId) {
      const lines = [];
      for (const ev of winterEvents) {
        const { state } = await getEventState(ev.id);
        const free = state.capacity - state.booked;
        const status = free <= 0 ? "приём закрыт" : `свободно ${free}`;
        lines.push(`${ev.date} — ${ev.title}: ${state.booked}/${state.capacity} (${status})`);
      }
      await sendMessage(chatId, "Сводка по новогодним мероприятиям:\n\n" + lines.join("\n"));
    }

    async function sendEventDetailMessage(chatId, eventId) {
      const ev = winterEvents.find(e => e.id === eventId);
      if (!ev) {
        await sendMessage(chatId, "Мероприятие не найдено.");
        return;
      }

      const { state } = await getEventState(ev.id);
      const confirmedSeats = state.booked;
      const free = state.capacity - confirmedSeats;

      let bookingsText = "";
      let list;
      try {
        list = await env.BOOKINGS.list({ prefix: "booking:" });
      } catch (e) {
        console.log("BOOKINGS list error", String(e));
        list = { keys: [] };
      }

      for (const key of list.keys || []) {
        const raw = await env.BOOKINGS.get(key.name);
        if (!raw) continue;
        let b;
        try { b = JSON.parse(raw); } catch { continue; }
        if (b.type !== "ny_event" || b.nyEventId !== eventId) continue;

        const people = parseInt(b.people || "0", 10) || 0;
        const name = b?.data?.name ? b.data.name : "без имени";
        const status = b.status || "new";
        bookingsText += `- ${b.id} — ${status} — ${name}, ${people} гость(я)\n`;
      }

      const header =
        `Мероприятие: ${ev.title} (${ev.date})\n` +
        `Всего мест: ${state.capacity}\n` +
        `Занято (подтверждено): ${confirmedSeats}\n` +
        `Свободно: ${free}\n\n` +
        `Заявки:\n`;

      const text = bookingsText ? header + bookingsText : header + "пока нет заявок.";
      await sendMessage(chatId, text);
    }

    // --- Callback handlers ---
    async function handleEventsSummaryCallback(callbackQuery) {
      const data = callbackQuery.data;
      const cbId = callbackQuery.id;
      const fromChatId = callbackQuery.message.chat.id;

      const suffix = data.split(":")[1];
      if (suffix === "all") {
        await sendEventsSummaryMessage(fromChatId);
        await answerCallbackQuery(cbId, "Сводка отправлена сообщением.");
        return;
      }

      const eventId = suffix; // e.g. ny-03
      await sendEventDetailMessage(fromChatId, eventId);
      await answerCallbackQuery(cbId, "Детали мероприятия отправлены.");
    }

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

        if (booking.type === "ny_event" && booking.nyEventId) {
          const { key, state } = await getEventState(booking.nyEventId);
          const people = parseInt(booking.people || "0", 10) || 0;

          if (people <= 0) {
            await answerCallbackQuery(cbId, "Некорректное количество гостей.");
            return;
          }
          if (state.booked + people > state.capacity) {
            const free = state.capacity - state.booked;
            await answerCallbackQuery(cbId, `Недостаточно мест. Свободно: ${free < 0 ? 0 : free}.`);
            return;
          }

          state.booked += people;
          await saveEventState(key, state);
        }

        booking.status = "confirmed";
        await saveBooking(booking);

        let adminText = `Заявка ${booking.id} подтверждена.\n\n`;
        if (booking.type === "ny_event" && booking.nyEventId) {
          const ev = winterEvents.find(e => e.id === booking.nyEventId);
          if (ev) adminText += `Мероприятие: ${ev.title} (${ev.date})\n`;
        }
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
          let userText = `Ваша заявка ${booking.id} подтверждена.`;
          if (booking.type === "ny_event" && booking.nyEventId) {
            const ev = winterEvents.find(e => e.id === booking.nyEventId);
            if (ev) userText += `\nМероприятие: ${ev.title} (${ev.date}).`;
          } else {
            if (booking?.data?.date) userText += `\nДата: ${booking.data.date}`;
            if (booking?.data?.time) userText += `\nВремя: ${booking.data.time}`;
          }
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
        if (booking.type === "ny_event" && booking.nyEventId) {
          const ev = winterEvents.find(e => e.id === booking.nyEventId);
          if (ev) adminText += `Мероприятие: ${ev.title} (${ev.date})\n`;
        }
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
          await sendMessage(booking.chatId, `Ваша заявка ${booking.id} отклонена. Если это ошибка — свяжитесь с нами.`);
        }

        await answerCallbackQuery(cbId, "Заявка отклонена.");
        return;
      }

      await answerCallbackQuery(cbId, "Неизвестное действие.");
    }

    // --- Handle callback_query first ---
    if (update.callback_query) {
      const callbackQuery = update.callback_query;
      const fromId = callbackQuery?.from?.id;

      if (!isAdminUserId(fromId)) {
        await answerCallbackQuery(callbackQuery.id, "Недостаточно прав.");
        return new Response("OK");
      }

      const data = callbackQuery.data || "";
      if (data.startsWith("events:")) {
        await handleEventsSummaryCallback(callbackQuery);
        return new Response("OK");
      }

      if (data.startsWith("confirm:") || data.startsWith("cancel:")) {
        await handleAdminBookingAction(callbackQuery);
        return new Response("OK");
      }

      await answerCallbackQuery(callbackQuery.id, "Неизвестная команда.");
      return new Response("OK");
    }

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
      try { session = JSON.parse(sessionRaw); } catch (e) { console.log("STATE parse error", String(e)); session = {}; }
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

    // --- Main keyboard (admin gets extra button) ---
    function buildMainKeyboard(isAdminUser) {
      const rows = [
        [{ text: "📅 Записаться на экскурсию" }],
        [{ text: "❄ Новогодние мероприятия" }],
        [{ text: "🐄 Экскурсии" }, { text: "📅 Расписание" }],
        [{ text: "🛒 Продукция" }, { text: "📍 Как добраться" }],
        [{ text: "🔄 Сбросить заявку" }],
      ];
      if (isAdminUser) rows.push([{ text: "📊 Сводка по мероприятиям" }]);
      rows.push([{ text: "🏡 Главное меню" }]);
      return { keyboard: rows, resize_keyboard: true };
    }

    const isAdminUser = isAdminUserId(message?.from?.id);
    const mainKeyboard = buildMainKeyboard(isAdminUser);
    const noKeyboard = { remove_keyboard: true };

    // Admin-only events menu command (/events)
    if (text === "/events" && isAdminUser) {
      await sendMessage(chatId, "Выберите день:", buildAdminEventsMenuKeyboard());
      return new Response("OK");
    }

    // Admin-only events menu command (button)
    if (text === "📊 Сводка по мероприятиям") {
      if (!isAdminUser) {
        await sendMessage(chatId, "Этот раздел доступен только администратору.");
        return new Response("OK");
      }
      await sendMessage(chatId, "Выберите день:", buildAdminEventsMenuKeyboard());
      return new Response("OK");
    }

    // Reset
    if (text === "🔄 Сбросить заявку") {
      await clearState();
      await sendMessage(chatId, "Заявка сброшена. Можете начать заново.", mainKeyboard);
      return new Response("OK");
    }

    async function startNyMenu(targetChatId) {
      await setState({ step: "ny_choose" });

      const winterKeyboard = {
        keyboard: [
          [{ text: winterEvents[0].label }],
          [{ text: winterEvents[1].label }],
          [{ text: winterEvents[2].label }],
          [{ text: winterEvents[3].label }],
          [{ text: winterEvents[4].label }],
          [{ text: winterEvents[5].label }],
          [{ text: winterEvents[6].label }],
          [{ text: "🏡 Главное меню" }],
        ],
        resize_keyboard: true,
      };

      await sendMessage(targetChatId, "Выберите дату и новогоднее мероприятие:", winterKeyboard);
    }

    // Start / deep-link / main menu
    if (text.startsWith("/start") || text === "🏡 Главное меню") {
      if (text.startsWith("/start")) {
        const parts = text.split(" ");
        const param = parts[1];

        if (param === "ny-menu") {
          await startNyMenu(chatId);
          return new Response("OK");
        }

        if (param && param.startsWith("ny-")) {
          const ev = winterEvents.find(e => e.id === param);
          if (ev) {
            const { state } = await getEventState(ev.id);
            if (state.booked >= state.capacity) {
              await sendMessage(chatId, `К сожалению, на ${ev.title} (${ev.date}) запись уже завершена.\n\nПожалуйста, выберите другое мероприятие.`, mainKeyboard);
              await clearState();
              return new Response("OK");
            }

            const newSession = { step: "ny_name", nyEventId: ev.id, nyEventTitle: ev.title, nyEventDate: ev.date };
            await setState(newSession);

            await sendMessage(chatId, `Вы выбрали ${ev.label}.\n\nКак вас зовут?`, noKeyboard);
            return new Response("OK");
          }
        }
      }

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

    // --- New Year events flow ---
    if (text === "❄ Новогодние мероприятия") {
      await startNyMenu(chatId);
      return new Response("OK");
    }

    if (session.step === "ny_choose") {
      const chosen = winterEvents.find(ev => ev.label === text);
      if (!chosen) {
        await sendMessage(chatId, "Пожалуйста, выберите мероприятие из списка кнопок.");
        return new Response("OK");
      }

      const { state } = await getEventState(chosen.id);
      if (state.booked >= state.capacity) {
        await sendMessage(chatId, `К сожалению, на ${chosen.title} (${chosen.date}) запись уже завершена.\n\nПожалуйста, выберите другое мероприятие.`, mainKeyboard);
        await clearState();
        return new Response("OK");
      }

      session.step = "ny_name";
      session.nyEventId = chosen.id;
      session.nyEventTitle = chosen.title;
      session.nyEventDate = chosen.date;
      await setState(session);

      await sendMessage(chatId, `Вы выбрали ${chosen.label}.\n\nКак вас зовут?`, noKeyboard);
      return new Response("OK");
    }

    if (session.step === "ny_name") {
      session.name = text;
      session.step = "ny_people";
      await setState(session);
      await sendMessage(chatId, "Сколько гостей планируете привезти?", noKeyboard);
      return new Response("OK");
    }

    if (session.step === "ny_people") {
      session.people = text;
      session.step = "ny_contact";
      await setState(session);
      await sendMessage(chatId, "Оставьте, пожалуйста, контакт (телефон или Telegram):", noKeyboard);
      return new Response("OK");
    }

    if (session.step === "ny_contact") {
      session.contact = text;

      const peopleNum = parseInt(session.people || "0", 10) || 0;

      const username =
        message?.from?.username
          ? `@${message.from.username}`
          : "нет";

      const bookingData = {
        type: "ny_event",
        chatId,
        nyEventId: session.nyEventId,
        people: peopleNum,
        data: {
          name: session.name,
          date: session.nyEventDate,
          people: session.people,
          contact: session.contact,
          nyEventTitle: session.nyEventTitle,
          username,
        },
      };

      const booking = await createBooking(bookingData);

      // Admin notification (plain text, safe)
      const adminText =
        "Новая заявка на НОВОГОДНЕЕ мероприятие:\n\n" +
        `ID: ${booking.id}\n` +
        `Мероприятие: ${session.nyEventTitle}\n` +
        `Дата: ${session.nyEventDate}\n\n` +
        `Имя: ${session.name}\n` +
        `Гостей: ${session.people}\n` +
        `Контакт: ${session.contact}\n` +
        `Telegram: ${username}`;

      if (env.ADMIN_CHAT_ID) {
        await callTelegram("sendMessage", {
          chat_id: env.ADMIN_CHAT_ID,
          text: adminText,
          reply_markup: buildAdminBookingKeyboard(booking.id),
        });
      } else {
        console.log("ADMIN_CHAT_ID is empty — cannot notify admin");
      }

      await sendMessage(chatId, "Спасибо! Ваша заявка на новогоднее мероприятие отправлена. Мы свяжемся с вами для подтверждения.", mainKeyboard);
      await clearState();
      return new Response("OK");
    }

    // --- Excursion booking flow (no capacity control) ---
    if (text === "📅 Записаться на экскурсию") {
      await setState({ step: "ex_name" });
      await sendMessage(chatId, "Как вас зовут?", noKeyboard);
      return new Response("OK");
    }

    if (session.step === "ex_name") {
      session.name = text;
      session.step = "ex_date";
      await setState(session);
      await sendMessage(chatId, "На какую дату хотите записаться?", noKeyboard);
      return new Response("OK");
    }

    if (session.step === "ex_date") {
      session.date = text;
      session.step = "ex_time";
      await setState(session);
      await sendMessage(chatId, "Во сколько? (например, 11:30 / 15:30 (летом))", noKeyboard);
      return new Response("OK");
    }

    if (session.step === "ex_time") {
      session.time = text;
      session.step = "ex_people";
      await setState(session);
      await sendMessage(chatId, "Сколько гостей будет?", noKeyboard);
      return new Response("OK");
    }

    if (session.step === "ex_people") {
      session.people = text;
      session.step = "ex_contact";
      await setState(session);
      await sendMessage(chatId, "Ваш телефон или Telegram?", noKeyboard);
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
    return new Response("OK");
  },
};

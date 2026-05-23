const TelegramBot = require("node-telegram-bot-api");
const mongoose = require("mongoose");
const http = require("http");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_ID = parseInt(process.env.ADMIN_ID || "7693096273", 10);

if (!BOT_TOKEN) throw new Error("BOT_TOKEN is required");
if (!MONGODB_URI) throw new Error("MONGODB_URI is required");

// ─── Mongoose Models ─────────────────────────────────────────────────────────

const userSchema = new mongoose.Schema({
  telegramId: { type: Number, required: true, unique: true },
  username: String,
  firstName: String,
  balance: { type: Number, default: 0 },
  referralCode: { type: String, unique: true },
  referredBy: { type: Number, default: null },
  referralCount: { type: Number, default: 0 },
  state: { type: String, default: null },
  stateMeta: { type: mongoose.Schema.Types.Mixed, default: null },
  banned: { type: Boolean, default: false },
}, { timestamps: true });

const taskSchema = new mongoose.Schema({
  userId: { type: Number, required: true },
  type: { type: String, required: true },
  amount: { type: Number, required: true },
  proof: { type: String, required: true },
  status: { type: String, enum: ["pending", "approved", "rejected"], default: "pending" },
}, { timestamps: true });

const withdrawSchema = new mongoose.Schema({
  userId: { type: Number, required: true },
  amount: { type: Number, required: true },
  address: { type: String, required: true },
  status: { type: String, enum: ["pending", "approved", "rejected"], default: "pending" },
}, { timestamps: true });

const User = mongoose.model("User", userSchema);
const Task = mongoose.model("Task", taskSchema);
const Withdrawal = mongoose.model("Withdrawal", withdrawSchema);

// ─── Task Definitions ─────────────────────────────────────────────────────────

const TASKS = [
  { id: "gmail",   label: "Gmail",   amount: 0.17, emoji: "📧" },
  { id: "outlook", label: "Outlook", amount: 0.21, emoji: "📨" },
  { id: "yahoo",   label: "Yahoo",   amount: 0.15, emoji: "📩" },
  { id: "hotmail", label: "Hotmail", amount: 0.18, emoji: "📬" },
];

const TASK_MAP = Object.fromEntries(TASKS.map(t => [t.id, t]));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function genReferralCode(telegramId) {
  return "REF" + telegramId.toString(36).toUpperCase();
}

async function getOrCreateUser(msg) {
  const { id, first_name, username } = msg.from;
  let user = await User.findOne({ telegramId: id });
  if (!user) {
    user = await User.create({
      telegramId: id,
      firstName: first_name || "مستخدم",
      username: username || null,
      referralCode: genReferralCode(id),
    });
  } else {
    user.firstName = first_name || user.firstName;
    user.username = username || user.username;
    await user.save();
  }
  return user;
}

function fmt(n) {
  return Number(n).toFixed(2);
}

// ─── Keyboards ────────────────────────────────────────────────────────────────

const MAIN_MENU = {
  reply_markup: {
    keyboard: [
      ["📋 المهام", "💰 رصيدي"],
      ["💸 السحب", "👥 الإحالة"],
      ["🏆 لوحة الصدارة"],
    ],
    resize_keyboard: true,
  },
};

function tasksKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        ...TASKS.map(t => ([{
          text: `${t.emoji} ${t.label} — $${t.amount}`,
          callback_data: `task_select:${t.id}`,
        }])),
        [{ text: "🔙 رجوع", callback_data: "back_main" }],
      ],
    },
  };
}

function backKeyboard(data) {
  return {
    reply_markup: {
      inline_keyboard: [[{ text: "🔙 رجوع", callback_data: data }]],
    },
  };
}

// ─── Bot ──────────────────────────────────────────────────────────────────────

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// /start
bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  const user = await getOrCreateUser(msg);
  const refCode = match && match[1] ? match[1].trim() : null;

  if (refCode && !user.referredBy) {
    const referrer = await User.findOne({ referralCode: refCode });
    if (referrer && referrer.telegramId !== user.telegramId) {
      user.referredBy = referrer.telegramId;
      await user.save();
      referrer.balance += 0.05;
      referrer.referralCount += 1;
      await referrer.save();
      bot.sendMessage(referrer.telegramId,
        `🎉 انضم مستخدم جديد عبر رابط إحالتك!\n💵 تم إضافة *$0.05* لرصيدك.`,
        { parse_mode: "Markdown" }
      ).catch(() => {});
    }
  }

  const welcome =
    `🤖 *أهلاً وسهلاً ${user.firstName}!*\n\n` +
    `مرحباً بك في بوت الأرباح 💰\n` +
    `أكمل المهام البسيطة واكسب USDT مباشرةً!\n\n` +
    `📋 *المهام المتاحة:*\n` +
    TASKS.map(t => `   ${t.emoji} ${t.label} — $${t.amount}`).join("\n") + "\n\n" +
    `👥 ادعُ أصدقاءك واكسب *$0.05* لكل إحالة\n` +
    `💸 الحد الأدنى للسحب: *$0.20 USDT*\n\n` +
    `اختر من القائمة أدناه للبدء 👇`;

  bot.sendMessage(msg.chat.id, welcome, { parse_mode: "Markdown", ...MAIN_MENU });
});

// Main menu buttons
bot.on("message", async (msg) => {
  if (!msg.text || msg.text.startsWith("/")) return;
  const chatId = msg.chat.id;
  const user = await getOrCreateUser(msg);

  // Block banned users
  if (user.banned) {
    bot.sendMessage(chatId, "🚫 تم حظرك من استخدام البوت.");
    return;
  }

  // State machine: waiting for proof or withdraw input
  if (user.state === "awaiting_proof") {
    const task = TASK_MAP[user.stateMeta?.taskId];
    if (!task) {
      user.state = null; user.stateMeta = null; await user.save();
      return;
    }
    const proof = msg.text.trim();
    const taskDoc = await Task.create({
      userId: user.telegramId,
      type: task.id,
      amount: task.amount,
      proof,
    });

    user.state = null; user.stateMeta = null;
    await user.save();

    bot.sendMessage(chatId,
      `✅ *تم إرسال إثباتك بنجاح!*\n\n` +
      `المهمة: ${task.emoji} ${task.label}\n` +
      `المبلغ: $${task.amount}\n\n` +
      `⏳ سيتم مراجعتها من قِبل المشرف وإضافة الرصيد عند الموافقة.`,
      { parse_mode: "Markdown", ...MAIN_MENU }
    );

    // Notify admin
    const pending = await Task.find({ userId: user.telegramId });
    const taskIndex = pending.length - 1;
    bot.sendMessage(ADMIN_ID,
      `📬 *طلب مهمة جديد*\n\n` +
      `المستخدم: ${user.firstName} (ID: \`${user.telegramId}\`)\n` +
      `المهمة: ${task.emoji} ${task.label} — $${task.amount}\n` +
      `الإثبات:\n${proof}\n\n` +
      `للموافقة: /approve ${user.telegramId} ${taskIndex}\n` +
      `للرفض: /reject ${user.telegramId} ${taskIndex}`,
      { parse_mode: "Markdown" }
    ).catch(() => {});
    return;
  }

  if (user.state === "awaiting_withdraw_amount") {
    const amount = parseFloat(msg.text.trim());
    if (isNaN(amount) || amount < 0.20) {
      bot.sendMessage(chatId, "❌ الحد الأدنى للسحب هو *$0.20*. أدخل مبلغاً صحيحاً:", { parse_mode: "Markdown" });
      return;
    }
    if (amount > user.balance) {
      bot.sendMessage(chatId, `❌ رصيدك الحالي *$${fmt(user.balance)}* غير كافٍ.`, { parse_mode: "Markdown" });
      return;
    }
    user.state = "awaiting_withdraw_address";
    user.stateMeta = { amount };
    await user.save();
    bot.sendMessage(chatId, `📮 أدخل عنوان محفظتك (USDT TRC20):`, { parse_mode: "Markdown" });
    return;
  }

  if (user.state === "awaiting_withdraw_address") {
    const address = msg.text.trim();
    const amount = user.stateMeta?.amount;
    if (!address || address.length < 10) {
      bot.sendMessage(chatId, "❌ عنوان المحفظة غير صحيح. حاول مرة أخرى:");
      return;
    }

    user.balance -= amount;
    user.state = null; user.stateMeta = null;
    await user.save();

    const wd = await Withdrawal.create({ userId: user.telegramId, amount, address });

    bot.sendMessage(chatId,
      `✅ *تم إرسال طلب السحب!*\n\n` +
      `المبلغ: *$${fmt(amount)} USDT*\n` +
      `العنوان: \`${address}\`\n\n` +
      `⏳ سيتم معالجة طلبك خلال 24 ساعة.`,
      { parse_mode: "Markdown", ...MAIN_MENU }
    );

    bot.sendMessage(ADMIN_ID,
      `💸 *طلب سحب جديد*\n\n` +
      `المستخدم: ${user.firstName} (ID: \`${user.telegramId}\`)\n` +
      `المبلغ: *$${fmt(amount)} USDT*\n` +
      `العنوان: \`${address}\`\n` +
      `رقم الطلب: \`${wd._id}\``,
      { parse_mode: "Markdown" }
    ).catch(() => {});
    return;
  }

  // Normal menu navigation
  const text = msg.text;

  if (text === "📋 المهام") {
    bot.sendMessage(chatId,
      `📋 *المهام المتاحة*\n\n` +
      `أكمل المهمة وأرسل إثباتاً (البريد الإلكتروني / لقطة شاشة).\n` +
      `اختر المهمة التي تريد إكمالها:`,
      { parse_mode: "Markdown", ...tasksKeyboard() }
    );
    return;
  }

  if (text === "💰 رصيدي") {
    const tasks = await Task.find({ userId: user.telegramId });
    const approved = tasks.filter(t => t.status === "approved").length;
    const pending  = tasks.filter(t => t.status === "pending").length;
    bot.sendMessage(chatId,
      `💰 *رصيدك الحالي*\n\n` +
      `💵 الرصيد: *$${fmt(user.balance)} USDT*\n\n` +
      `📋 المهام المكتملة: ${approved}\n` +
      `⏳ المهام قيد المراجعة: ${pending}\n` +
      `👥 الإحالات: ${user.referralCount}`,
      { parse_mode: "Markdown", ...MAIN_MENU }
    );
    return;
  }

  if (text === "💸 السحب") {
    if (user.balance < 0.20) {
      bot.sendMessage(chatId,
        `❌ *رصيدك غير كافٍ للسحب*\n\n` +
        `رصيدك الحالي: *$${fmt(user.balance)} USDT*\n` +
        `الحد الأدنى للسحب: *$0.20 USDT*\n\n` +
        `أكمل المزيد من المهام لزيادة رصيدك! 💪`,
        { parse_mode: "Markdown", ...MAIN_MENU }
      );
      return;
    }
    user.state = "awaiting_withdraw_amount";
    user.stateMeta = null;
    await user.save();
    bot.sendMessage(chatId,
      `💸 *طلب سحب*\n\n` +
      `رصيدك الحالي: *$${fmt(user.balance)} USDT*\n` +
      `الحد الأدنى: $0.20\n\n` +
      `أدخل المبلغ الذي تريد سحبه:`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  if (text === "👥 الإحالة") {
    const botInfo = await bot.getMe();
    const link = `https://t.me/${botInfo.username}?start=${user.referralCode}`;
    bot.sendMessage(chatId,
      `👥 *نظام الإحالة*\n\n` +
      `ادعُ أصدقاءك واكسب *$0.05 USDT* عن كل شخص يسجل عبر رابطك!\n\n` +
      `🔗 رابط الإحالة الخاص بك:\n\`${link}\`\n\n` +
      `👤 إجمالي إحالاتك: *${user.referralCount}*\n` +
      `💰 أرباح الإحالات: *$${fmt(user.referralCount * 0.05)} USDT*`,
      { parse_mode: "Markdown", ...MAIN_MENU }
    );
    return;
  }

  if (text === "🏆 لوحة الصدارة") {
    const top = await User.find().sort({ balance: -1 }).limit(10);
    let msg2 = `🏆 *أفضل 10 مستخدمين*\n\n`;
    const medals = ["🥇", "🥈", "🥉"];
    top.forEach((u, i) => {
      const medal = medals[i] || `${i + 1}.`;
      const name = u.firstName || u.username || "مستخدم";
      msg2 += `${medal} ${name} — *$${fmt(u.balance)}*\n`;
    });
    bot.sendMessage(chatId, msg2, { parse_mode: "Markdown", ...MAIN_MENU });
    return;
  }
});

// Callback queries (inline buttons)
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  const user = await getOrCreateUser(query.message);
  bot.answerCallbackQuery(query.id).catch(() => {});

  if (data === "back_main") {
    bot.sendMessage(chatId, "🏠 القائمة الرئيسية", MAIN_MENU);
    return;
  }

  if (data.startsWith("task_select:")) {
    const taskId = data.split(":")[1];
    const task = TASK_MAP[taskId];
    if (!task) return;

    // Check if user already has a pending task of this type
    const existing = await Task.findOne({ userId: user.telegramId, type: taskId, status: "pending" });
    if (existing) {
      bot.sendMessage(chatId,
        `⏳ لديك بالفعل مهمة ${task.emoji} ${task.label} قيد المراجعة.\nانتظر حتى يتم مراجعتها.`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    user.state = "awaiting_proof";
    user.stateMeta = { taskId };
    await user.save();

    const instructions = {
      gmail:   "1. أنشئ حساب Gmail جديد\n2. أكمل التحقق من الهاتف\n3. أرسل البريد الإلكتروني للحساب كإثبات",
      outlook: "1. أنشئ حساب Outlook جديد\n2. أكمل إعداد الحساب\n3. أرسل البريد الإلكتروني للحساب كإثبات",
      yahoo:   "1. أنشئ حساب Yahoo جديد\n2. أكمل التحقق\n3. أرسل البريد الإلكتروني للحساب كإثبات",
      hotmail: "1. أنشئ حساب Hotmail جديد\n2. أكمل إعداد الحساب\n3. أرسل البريد الإلكتروني للحساب كإثبات",
    };

    bot.sendMessage(chatId,
      `${task.emoji} *مهمة ${task.label} — $${task.amount} USDT*\n\n` +
      `📌 *التعليمات:*\n${instructions[taskId]}\n\n` +
      `✏️ أرسل الآن إثباتك (البريد الإلكتروني أو لقطة الشاشة نصاً):`,
      { parse_mode: "Markdown", ...backKeyboard("back_main") }
    );
    return;
  }
});

// ─── Admin Commands ───────────────────────────────────────────────────────────

// /approve <userId> <taskIndex>
bot.onText(/\/approve (\d+) (\d+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const userId = parseInt(match[1]);
  const taskIndex = parseInt(match[2]);

  const tasks = await Task.find({ userId }).sort({ createdAt: 1 });
  const task = tasks[taskIndex];
  if (!task) {
    bot.sendMessage(msg.chat.id, `❌ المهمة غير موجودة.`);
    return;
  }
  if (task.status !== "pending") {
    bot.sendMessage(msg.chat.id, `⚠️ هذه المهمة تمت معالجتها بالفعل (${task.status}).`);
    return;
  }

  task.status = "approved";
  await task.save();

  const user = await User.findOne({ telegramId: userId });
  if (user) {
    user.balance += task.amount;
    await user.save();

    bot.sendMessage(userId,
      `✅ *تمت الموافقة على مهمتك!*\n\n` +
      `المهمة: ${TASK_MAP[task.type]?.emoji || ""} ${task.type}\n` +
      `💵 تم إضافة *$${task.amount} USDT* لرصيدك!\n` +
      `رصيدك الحالي: *$${fmt(user.balance)} USDT*`,
      { parse_mode: "Markdown", ...MAIN_MENU }
    ).catch(() => {});
  }

  bot.sendMessage(msg.chat.id, `✅ تمت الموافقة على المهمة وإضافة $${task.amount} للمستخدم ${userId}.`);
});

// /reject <userId> <taskIndex>
bot.onText(/\/reject (\d+) (\d+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const userId = parseInt(match[1]);
  const taskIndex = parseInt(match[2]);

  const tasks = await Task.find({ userId }).sort({ createdAt: 1 });
  const task = tasks[taskIndex];
  if (!task) {
    bot.sendMessage(msg.chat.id, `❌ المهمة غير موجودة.`);
    return;
  }
  if (task.status !== "pending") {
    bot.sendMessage(msg.chat.id, `⚠️ هذه المهمة تمت معالجتها بالفعل (${task.status}).`);
    return;
  }

  task.status = "rejected";
  await task.save();

  const user = await User.findOne({ telegramId: userId });
  if (user) {
    bot.sendMessage(userId,
      `❌ *تم رفض مهمتك*\n\n` +
      `المهمة: ${TASK_MAP[task.type]?.emoji || ""} ${task.type}\n\n` +
      `يرجى التأكد من اتباع التعليمات بشكل صحيح وإعادة المحاولة.`,
      { parse_mode: "Markdown", ...MAIN_MENU }
    ).catch(() => {});
  }

  bot.sendMessage(msg.chat.id, `❌ تم رفض مهمة المستخدم ${userId}.`);
});

// /addbalance <userId> <amount>
bot.onText(/\/addbalance (\d+) ([\d.]+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const userId = parseInt(match[1]);
  const amount = parseFloat(match[2]);

  if (isNaN(amount) || amount <= 0) {
    bot.sendMessage(msg.chat.id, "❌ المبلغ غير صحيح.");
    return;
  }

  const user = await User.findOne({ telegramId: userId });
  if (!user) {
    bot.sendMessage(msg.chat.id, `❌ المستخدم ${userId} غير موجود.`);
    return;
  }

  user.balance += amount;
  await user.save();

  bot.sendMessage(msg.chat.id,
    `✅ *تم إضافة الرصيد*\n\n` +
    `المستخدم: ${user.firstName} (\`${userId}\`)\n` +
    `المبلغ المضاف: *$${fmt(amount)} USDT*\n` +
    `الرصيد الجديد: *$${fmt(user.balance)} USDT*`,
    { parse_mode: "Markdown" }
  );

  bot.sendMessage(userId,
    `🎁 *تم إضافة رصيد إلى حسابك!*\n\n` +
    `💵 المبلغ المضاف: *$${fmt(amount)} USDT*\n` +
    `💰 رصيدك الحالي: *$${fmt(user.balance)} USDT*`,
    { parse_mode: "Markdown", ...MAIN_MENU }
  ).catch(() => {});
});

// /withdrawals
bot.onText(/\/withdrawals/, async (msg) => {
  if (msg.from.id !== ADMIN_ID) return;
  const wds = await Withdrawal.find({ status: "pending" }).sort({ createdAt: 1 }).limit(20);
  if (!wds.length) { bot.sendMessage(msg.chat.id, "✅ لا توجد طلبات سحب معلقة."); return; }
  let text = `💸 *طلبات السحب المعلقة (${wds.length})*\n\n`;
  for (const w of wds) {
    const user = await User.findOne({ telegramId: w.userId }, "firstName");
    text += `👤 ${user?.firstName || "مستخدم"} (\`${w.userId}\`)\n` +
            `💵 المبلغ: *$${fmt(w.amount)} USDT*\n` +
            `📮 العنوان: \`${w.address}\`\n` +
            `🆔 الطلب: \`${w._id}\`\n\n`;
  }
  bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
});

// /pending
bot.onText(/\/pending/, async (msg) => {
  if (msg.from.id !== ADMIN_ID) return;
  const tasks = await Task.find({ status: "pending" }).sort({ createdAt: 1 }).limit(20);
  if (!tasks.length) { bot.sendMessage(msg.chat.id, "✅ لا توجد مهام معلقة."); return; }
  let text = `⏳ *المهام قيد المراجعة (${tasks.length})*\n\n`;
  for (const t of tasks) {
    const user = await User.findOne({ telegramId: t.userId }, "firstName");
    const taskDef = TASK_MAP[t.type];
    const userTasks = await Task.find({ userId: t.userId }).sort({ createdAt: 1 });
    const index = userTasks.findIndex(x => x._id.equals(t._id));
    text += `${taskDef?.emoji || ""} *${taskDef?.label || t.type}* — $${t.amount}\n` +
            `👤 ${user?.firstName || "مستخدم"} (\`${t.userId}\`)\n` +
            `📝 ${t.proof}\n` +
            `✅ /approve ${t.userId} ${index}  ❌ /reject ${t.userId} ${index}\n\n`;
  }
  bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
});

// /users
bot.onText(/\/users/, async (msg) => {
  if (msg.from.id !== ADMIN_ID) return;
  const users = await User.find().sort({ createdAt: -1 }).limit(20);
  if (!users.length) { bot.sendMessage(msg.chat.id, "لا يوجد مستخدمون بعد."); return; }
  let text = `👥 *آخر ${users.length} مستخدم*\n\n`;
  users.forEach((u, i) => {
    const status = u.banned ? " 🚫" : "";
    text += `${i + 1}. ${u.firstName}${status}\n` +
            `   ID: \`${u.telegramId}\` | 💰 $${fmt(u.balance)} | 👥 ${u.referralCount}\n`;
  });
  bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
});

// /ban <userId>
bot.onText(/\/ban (\d+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const userId = parseInt(match[1]);
  const user = await User.findOne({ telegramId: userId });
  if (!user) { bot.sendMessage(msg.chat.id, `❌ المستخدم ${userId} غير موجود.`); return; }
  if (user.banned) { bot.sendMessage(msg.chat.id, `⚠️ المستخدم ${userId} محظور بالفعل.`); return; }
  user.banned = true;
  await user.save();
  bot.sendMessage(msg.chat.id, `🚫 *تم حظر المستخدم*\n\nالاسم: ${user.firstName}\nID: \`${userId}\``, { parse_mode: "Markdown" });
  bot.sendMessage(userId, `🚫 *تم حظرك من استخدام البوت.*\nللاستفسار تواصل مع الإدارة.`, { parse_mode: "Markdown" }).catch(() => {});
});

// /unban <userId>
bot.onText(/\/unban (\d+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const userId = parseInt(match[1]);
  const user = await User.findOne({ telegramId: userId });
  if (!user) { bot.sendMessage(msg.chat.id, `❌ المستخدم ${userId} غير موجود.`); return; }
  if (!user.banned) { bot.sendMessage(msg.chat.id, `⚠️ المستخدم ${userId} غير محظور.`); return; }
  user.banned = false;
  await user.save();
  bot.sendMessage(msg.chat.id, `✅ *تم رفع الحظر عن المستخدم*\n\nالاسم: ${user.firstName}\nID: \`${userId}\``, { parse_mode: "Markdown" });
  bot.sendMessage(userId, `✅ *تم رفع الحظر عن حسابك!*\nيمكنك الآن استخدام البوت مجدداً.`, { parse_mode: "Markdown", ...MAIN_MENU }).catch(() => {});
});

// /removebalance <userId> <amount>
bot.onText(/\/removebalance (\d+) ([\d.]+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const userId = parseInt(match[1]);
  const amount = parseFloat(match[2]);

  if (isNaN(amount) || amount <= 0) {
    bot.sendMessage(msg.chat.id, "❌ المبلغ غير صحيح.");
    return;
  }

  const user = await User.findOne({ telegramId: userId });
  if (!user) {
    bot.sendMessage(msg.chat.id, `❌ المستخدم ${userId} غير موجود.`);
    return;
  }

  if (amount > user.balance) {
    bot.sendMessage(msg.chat.id,
      `❌ رصيد المستخدم *$${fmt(user.balance)}* أقل من المبلغ المطلوب خصمه.`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  user.balance -= amount;
  await user.save();

  bot.sendMessage(msg.chat.id,
    `✅ *تم خصم الرصيد*\n\n` +
    `المستخدم: ${user.firstName} (\`${userId}\`)\n` +
    `المبلغ المخصوم: *$${fmt(amount)} USDT*\n` +
    `الرصيد الجديد: *$${fmt(user.balance)} USDT*`,
    { parse_mode: "Markdown" }
  );

  bot.sendMessage(userId,
    `⚠️ *تم خصم رصيد من حسابك*\n\n` +
    `💵 المبلغ المخصوم: *$${fmt(amount)} USDT*\n` +
    `💰 رصيدك الحالي: *$${fmt(user.balance)} USDT*`,
    { parse_mode: "Markdown", ...MAIN_MENU }
  ).catch(() => {});
});

// /broadcast <message>
bot.onText(/\/broadcast (.+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const text = match[1].trim();
  const users = await User.find({}, "telegramId");

  let sent = 0, failed = 0;
  for (const user of users) {
    try {
      await bot.sendMessage(user.telegramId, `📢 *رسالة من الإدارة*\n\n${text}`, { parse_mode: "Markdown" });
      sent++;
    } catch {
      failed++;
    }
  }

  bot.sendMessage(msg.chat.id,
    `📢 *تم إرسال البث*\n\n✅ نجح: ${sent}\n❌ فشل: ${failed}\n👤 الإجمالي: ${users.length}`,
    { parse_mode: "Markdown" }
  );
});

// /stats
bot.onText(/\/stats/, async (msg) => {
  if (msg.from.id !== ADMIN_ID) return;

  const totalUsers = await User.countDocuments();
  const totalTasks = await Task.countDocuments();
  const pendingTasks = await Task.countDocuments({ status: "pending" });
  const approvedTasks = await Task.countDocuments({ status: "approved" });
  const rejectedTasks = await Task.countDocuments({ status: "rejected" });
  const totalWithdrawals = await Withdrawal.countDocuments();
  const pendingWithdrawals = await Withdrawal.countDocuments({ status: "pending" });

  const totalPaid = await Task.aggregate([
    { $match: { status: "approved" } },
    { $group: { _id: null, total: { $sum: "$amount" } } },
  ]);

  const paid = totalPaid[0]?.total || 0;

  bot.sendMessage(msg.chat.id,
    `📊 *إحصائيات البوت*\n\n` +
    `👤 إجمالي المستخدمين: *${totalUsers}*\n\n` +
    `📋 *المهام:*\n` +
    `   الكل: ${totalTasks}\n` +
    `   ✅ موافق عليها: ${approvedTasks}\n` +
    `   ⏳ قيد المراجعة: ${pendingTasks}\n` +
    `   ❌ مرفوضة: ${rejectedTasks}\n\n` +
    `💸 *السحوبات:*\n` +
    `   الكل: ${totalWithdrawals}\n` +
    `   ⏳ قيد المعالجة: ${pendingWithdrawals}\n\n` +
    `💵 إجمالي المدفوع: *$${fmt(paid)} USDT*`,
    { parse_mode: "Markdown" }
  );
});

// ─── Connect & Start ──────────────────────────────────────────────────────────

mongoose.connection.on("connected", () => console.log("✅ MongoDB connected"));
mongoose.connection.on("error", (err) => console.error("⚠️  MongoDB error:", err.message));
mongoose.connection.on("disconnected", () => console.warn("⚠️  MongoDB disconnected"));

mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 10000 })
  .catch(err => console.error("❌ MongoDB initial connection failed:", err.message));

console.log("🤖 Bot is running...");

// Minimal HTTP server so the workflow port check passes
const PORT = process.env.PORT || 8080;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "ok", bot: "running" }));
}).listen(PORT, () => console.log(`🌐 HTTP health server on port ${PORT}`));

bot.on("polling_error", (err) => console.error("Polling error:", err.message));

process.on("SIGTERM", async () => {
  await bot.stopPolling();
  await mongoose.disconnect();
  process.exit(0);
});

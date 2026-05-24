const TelegramBot = require("node-telegram-bot-api");
const mongoose = require("mongoose");
const http = require("http");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_ID = parseInt(process.env.ADMIN_ID || "7693096273", 10);
const RECOVERY_EMAIL = "amermm1560@gmail.com";

if (!BOT_TOKEN) throw new Error("BOT_TOKEN is required");
if (!MONGODB_URI) throw new Error("MONGODB_URI is required");

// ─── Mongoose Models ───────────────────────────────────────────────────────────────────

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

const accountSchema = new mongoose.Schema({
  firstName: { type: String, required: true },
  lastName: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  birthdate: { type: String, default: null },
  assigned: { type: Boolean, default: false },
  assignedTo: { type: Number, default: null },
  assignedAt: { type: Date, default: null },
}, { timestamps: true });

const taskSchema = new mongoose.Schema({
  userId: { type: Number, required: true },
  amount: { type: Number, required: true },
  accountEmail: { type: String, required: true },
  accountId: { type: mongoose.Schema.Types.ObjectId, ref: "Account" },
  status: { type: String, enum: ["pending", "approved", "rejected"], default: "pending" },
}, { timestamps: true });

const withdrawSchema = new mongoose.Schema({
  userId: { type: Number, required: true },
  amount: { type: Number, required: true },
  address: { type: String, required: true },
  status: { type: String, enum: ["pending", "approved", "rejected"], default: "pending" },
}, { timestamps: true });

const User = mongoose.model("User", userSchema);
const Account = mongoose.model("Account", accountSchema);
const Task = mongoose.model("Task", taskSchema);
const Withdrawal = mongoose.model("Withdrawal", withdrawSchema);

// ─── Auto Generate Account Data ───────────────────────────────────────────────

const firstNames = ["James","John","Robert","Michael","William","David","Richard","Joseph","Thomas","Charles","Emma","Olivia","Ava","Isabella","Sophia","Mia","Charlotte","Amelia","Harper","Evelyn","Liam","Noah","Oliver","Elijah","Benjamin","Lucas","Mason","Ethan","Aiden","Logan"];
const lastNames = ["Smith","Johnson","Williams","Brown","Jones","Garcia","Miller","Davis","Wilson","Taylor","Anderson","Thomas","Jackson","White","Harris","Martin","Thompson","Young","Robinson","Lewis","Walker","Hall","Allen","King","Wright","Scott","Green","Baker","Adams","Nelson"];

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generatePassword() {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let pass = "";
  for (let i = 0; i < 12; i++) pass += chars[randomInt(0, chars.length - 1)];
  return pass;
}

function generateBirthdate() {
  const day = String(randomInt(1, 28)).padStart(2, "0");
  const month = String(randomInt(1, 12)).padStart(2, "0");
  const year = randomInt(1985, 2000);
  return `${day}.${month}.${year}`;
}

function generateAccountData() {
  const first = firstNames[randomInt(0, firstNames.length - 1)];
  const last = lastNames[randomInt(0, lastNames.length - 1)];
  const num = randomInt(100, 9999);
  const sep = [".", "_", ""][randomInt(0, 2)];
  const email = `${first.toLowerCase()}${sep}${last.toLowerCase()}${num}@gmail.com`;
  const password = generatePassword();
  const birthdate = generateBirthdate();
  return { firstName: first, lastName: last, email, password, birthdate };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function genReferralCode(id) {
  return "REF" + id.toString(36).toUpperCase();
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

function fmt(n) { return Number(n).toFixed(2); }

// ─── Keyboards ────────────────────────────────────────────────────────────────

const MAIN_MENU = {
  reply_markup: {
    keyboard: [
      ["➕ أنشئ حساب Gmail جديد", "📋 حساباتي"],
      ["💰 الرصيد", "👥 الإحالات الخاصة بي"],
      ["⚙️ الإعدادات", "💬 مساعدة"],
    ],
    resize_keyboard: true,
  },
};

function confirmKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "✅ تم", callback_data: "task_done" }],
        [{ text: "🚫 إلغاء التسجيل", callback_data: "task_cancel" }],
        [{ text: "❓ كيفية إنشاء حساب", callback_data: "task_help" }],
      ],
    },
  };
}

// ─── Bot ──────────────────────────────────────────────────────────────────────

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// /start
bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  const user = await getOrCreateUser(msg);
  const available = await Account.countDocuments({ assigned: false });

  bot.sendMessage(msg.chat.id,
    `👋 *أهلاً ${user.firstName}!*\n\n` +
    `💰 *اكسب من إنشاء حسابات Gmail!*\n\n` +
    `📌 *كيف يعمل البوت:*\n` +
    `1️⃣ اضغط "أنشئ حساب Gmail جديد"\n` +
    `2️⃣ ستحصل على بيانات جاهزة\n` +
    `3️⃣ سجّل الحساب باستخدام البيانات\n` +
    `4️⃣ اضغط "تم" واحصل على $0.17\n\n` +
    `📦 الحسابات المتاحة: *${available}*\n` +
    `💵 السعر لكل حساب: *$0.145 - $0.17*`,
    { parse_mode: "Markdown", ...MAIN_MENU }
  );
});

// Messages
bot.on("message", async (msg) => {
  if (!msg.text || msg.text.startsWith("/")) return;
  const chatId = msg.chat.id;
  const user = await getOrCreateUser(msg);

  if (user.banned) {
    bot.sendMessage(chatId, "🚫 تم حظرك من استخدام البوت.");
    return;
  }

  const text = msg.text;

  if (text === "➕ أنشئ حساب Gmail جديد") {
    const pending = await Task.findOne({ userId: user.telegramId, status: "pending" });
    if (pending) {
      bot.sendMessage(chatId,
        `⏳ *لديك حساب قيد المراجعة*\n\n📧 الإيميل: \`${pending.accountEmail}\`\n\nانتظر حتى تتم مراجعته أولاً.`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    const account = await Account.findOneAndUpdate(
      { assigned: false },
      { assigned: true, assignedTo: user.telegramId, assignedAt: new Date() },
      { new: true }
    );

    if (!account) {
      bot.sendMessage(chatId,
        `❌ *لا توجد حسابات متاحة حالياً*\n\nيرجى المحاولة لاحقاً أو التواصل مع الإدارة.`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    user.state = "awaiting_confirmation";
    user.stateMeta = { accountId: account._id.toString() };
    await user.save();

    bot.sendMessage(chatId,
      `📧 *قم بتسجيل حساب Gmail باستخدام البيانات المحددة، واحصل على $0.145 إلى $0.17*\n\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `👤 الاسم: *${account.firstName}*\n` +
      `👤 اللقب: *${account.lastName}*\n` +
      `🎂 تاريخ الميلاد: *${account.birthdate || "01.01.1990"}*\n` +
      `📧 البريد الإلكتروني: \`${account.email}\`\n` +
      `🔑 كلمة المرور: \`${account.password}\`\n` +
      `📩 إيميل الاستعادة: \`${RECOVERY_EMAIL}\`\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `🔒 *تأكد من استخدام البيانات المحددة وإضافة إيميل الاستعادة، وإلا فلن يتم الدفع مقابل الحساب*`,
      { parse_mode: "Markdown", ...confirmKeyboard() }
    );
    return;
  }

  if (text === "📋 حساباتي") {
    const tasks = await Task.find({ userId: user.telegramId }).sort({ createdAt: -1 }).limit(10);
    if (!tasks.length) {
      bot.sendMessage(chatId, `📋 *لا توجد حسابات بعد*\n\nاضغط "أنشئ حساب Gmail جديد" للبدء!`, { parse_mode: "Markdown", ...MAIN_MENU });
      return;
    }
    let txt = `📋 *حساباتك*\n\n`;
    for (const t of tasks) {
      const statusEmoji = t.status === "approved" ? "✅" : t.status === "rejected" ? "❌" : "⏳";
      txt += `${statusEmoji} \`${t.accountEmail}\` — $${fmt(t.amount)}\n`;
    }
    bot.sendMessage(chatId, txt, { parse_mode: "Markdown", ...MAIN_MENU });
    return;
  }

  if (text === "💰 الرصيد") {
    const approved = await Task.countDocuments({ userId: user.telegramId, status: "approved" });
    const pending = await Task.countDocuments({ userId: user.telegramId, status: "pending" });
    bot.sendMessage(chatId,
      `💰 *رصيدك*\n\n` +
      `💵 الرصيد: *$${fmt(user.balance)} USDT*\n\n` +
      `✅ حسابات مقبولة: ${approved}\n` +
      `⏳ قيد المراجعة: ${pending}\n\n` +
      `💸 الحد الأدنى للسحب: *$0.20 USDT*`,
      { parse_mode: "Markdown", ...MAIN_MENU }
    );
    return;
  }

  if (text === "👥 الإحالات الخاصة بي") {
    const botInfo = await bot.getMe();
    const link = `https://t.me/${botInfo.username}?start=${user.referralCode}`;
    bot.sendMessage(chatId,
      `👥 *الإحالات الخاصة بك*\n\n` +
      `🔗 رابطك:\n\`${link}\`\n\n` +
      `👤 إجمالي الإحالات: *${user.referralCount}*`,
      { parse_mode: "Markdown", ...MAIN_MENU }
    );
    return;
  }

  if (text === "⚙️ الإعدادات") {
    bot.sendMessage(chatId,
      `⚙️ *الإعدادات*\n\n` +
      `👤 الاسم: ${user.firstName}\n` +
      `🆔 ID: \`${user.telegramId}\`\n` +
      `💰 الرصيد: $${fmt(user.balance)}\n\n` +
      `للسحب أرسل: /withdraw`,
      { parse_mode: "Markdown", ...MAIN_MENU }
    );
    return;
  }

  if (text === "💬 مساعدة") {
    bot.sendMessage(chatId,
      `💬 *المساعدة*\n\n` +
      `❓ *كيف أنشئ حساب Gmail؟*\n` +
      `1. افتح accounts.google.com\n` +
      `2. اضغط "إنشاء حساب"\n` +
      `3. أدخل البيانات المعطاة بالضبط\n` +
      `4. أضف إيميل الاستعادة: \`${RECOVERY_EMAIL}\`\n` +
      `5. ارجع للبوت واضغط "تم"\n\n` +
      `⚠️ *تنبيهات:*\n` +
      `• استخدم البيانات المحددة فقط\n` +
      `• أضف إيميل الاستعادة المحدد\n` +
      `• الحسابات المكررة ستُرفض\n\n` +
      `للتواصل مع الدعم: @admin`,
      { parse_mode: "Markdown", ...MAIN_MENU }
    );
    return;
  }

  if (user.state === "awaiting_withdraw_amount") {
    const amount = parseFloat(text.trim());
    if (isNaN(amount) || amount < 0.20) {
      bot.sendMessage(chatId, "❌ الحد الأدنى $0.20. أدخل مبلغاً صحيحاً:");
      return;
    }
    if (amount > user.balance) {
      bot.sendMessage(chatId, `❌ رصيدك *$${fmt(user.balance)}* غير كافٍ.`, { parse_mode: "Markdown" });
      return;
    }
    user.state = "awaiting_withdraw_address";
    user.stateMeta = { amount };
    await user.save();
    bot.sendMessage(chatId, `📮 أدخل عنوان محفظتك *(USDT TRC20)*:`, { parse_mode: "Markdown" });
    return;
  }

  if (user.state === "awaiting_withdraw_address") {
    const address = text.trim();
    const amount = user.stateMeta?.amount;
    if (!address || address.length < 10) {
      bot.sendMessage(chatId, "❌ عنوان غير صحيح. حاول مرة أخرى:");
      return;
    }
    user.balance -= amount;
    user.state = null; user.stateMeta = null;
    await user.save();
    await Withdrawal.create({ userId: user.telegramId, amount, address });
    bot.sendMessage(chatId,
      `✅ *تم إرسال طلب السحب!*\n\n💵 المبلغ: *$${fmt(amount)} USDT*\n📮 العنوان: \`${address}\`\n\n⏳ سيتم المعالجة خلال 24 ساعة.`,
      { parse_mode: "Markdown", ...MAIN_MENU }
    );
    bot.sendMessage(ADMIN_ID,
      `💸 *طلب سحب جديد*\n\n👤 ${user.firstName} (\`${user.telegramId}\`)\n💵 $${fmt(amount)} USDT\n📮 \`${address}\``,
      { parse_mode: "Markdown" }
    ).catch(() => {});
    return;
  }
});

// Callbacks
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  const user = await getOrCreateUser(query.message);
  bot.answerCallbackQuery(query.id).catch(() => {});

  if (data === "task_done") {
    if (user.state !== "awaiting_confirmation") {
      bot.sendMessage(chatId, "❌ لا يوجد حساب نشط.");
      return;
    }
    const accountId = user.stateMeta?.accountId;
    const account = await Account.findById(accountId);
    if (!account) {
      bot.sendMessage(chatId, "❌ حدث خطأ. حاول مرة أخرى.");
      return;
    }
    const task = await Task.create({
      userId: user.telegramId,
      amount: 0.17,
      accountEmail: account.email,
      accountId: account._id,
    });
    user.state = null; user.stateMeta = null;
    await user.save();
    bot.sendMessage(chatId,
      `✅ *تم إرسال طلبك!*\n\n📧 الإيميل: \`${account.email}\`\n💵 المبلغ: *$0.17 USDT*\n\n⏳ سيتم المراجعة خلال 24 ساعة.`,
      { parse_mode: "Markdown", ...MAIN_MENU }
    );
    const tasks = await Task.find({ userId: user.telegramId });
    const taskIndex = tasks.length - 1;
    bot.sendMessage(ADMIN_ID,
      `📬 *طلب Gmail جديد*\n\n👤 ${user.firstName} (\`${user.telegramId}\`)\n📧 الإيميل: \`${account.email}\`\n🔑 كلمة المرور: \`${account.password}\`\n👤 الاسم: ${account.firstName} ${account.lastName}\n\n✅ /approve ${user.telegramId} ${taskIndex}\n❌ /reject ${user.telegramId} ${taskIndex}`,
      { parse_mode: "Markdown" }
    ).catch(() => {});
    return;
  }

  if (data === "task_cancel") {
    const accountId = user.stateMeta?.accountId;
    if (accountId) {
      await Account.findByIdAndUpdate(accountId, { assigned: false, assignedTo: null, assignedAt: null });
    }
    user.state = null; user.stateMeta = null;
    await user.save();
    bot.sendMessage(chatId, "🚫 تم إلغاء التسجيل.", MAIN_MENU);
    return;
  }

  if (data === "task_help") {
    bot.sendMessage(chatId,
      `❓ *كيفية إنشاء حساب Gmail*\n\n` +
      `1. افتح: accounts.google.com\n` +
      `2. اضغط "إنشاء حساب"\n` +
      `3. أدخل الاسم واللقب المحددين\n` +
      `4. أدخل الإيميل وكلمة المرور المحددين\n` +
      `5. أضف إيميل الاستعادة: \`${RECOVERY_EMAIL}\`\n` +
      `6. ارجع واضغط ✅ تم`,
      { parse_mode: "Markdown" }
    );
    return;
  }
});

// /withdraw
bot.onText(/\/withdraw/, async (msg) => {
  const user = await getOrCreateUser(msg);
  if (user.balance < 0.20) {
    bot.sendMessage(msg.chat.id, `❌ رصيدك *$${fmt(user.balance)}* أقل من الحد الأدنى $0.20`, { parse_mode: "Markdown" });
    return;
  }
  user.state = "awaiting_withdraw_amount";
  user.stateMeta = null;
  await user.save();
  bot.sendMessage(msg.chat.id, `💸 *طلب سحب*\n\nرصيدك: *$${fmt(user.balance)} USDT*\nأدخل المبلغ:`, { parse_mode: "Markdown" });
});

// ─── Admin Commands ───────────────────────────────────────────────────────────

// /generate N — يولّد N حساب تلقائياً
bot.onText(/\/generate (\d+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const count = Math.min(parseInt(match[1]), 100);
  let added = 0, failed = 0;
  for (let i = 0; i < count; i++) {
    const data = generateAccountData();
    try {
      await Account.create(data);
      added++;
    } catch {
      failed++;
    }
  }
  const total = await Account.countDocuments({ assigned: false });
  bot.sendMessage(msg.chat.id,
    `✅ *تم توليد الحسابات*\n\n` +
    `➕ تمت الإضافة: *${added}*\n` +
    `❌ فشل (مكرر): *${failed}*\n` +
    `📦 الحسابات المتاحة الآن: *${total}*`,
    { parse_mode: "Markdown" }
  );
});

// /addaccount
bot.onText(/\/addaccount (\S+) (\S+) (\S+) (\S+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const [, firstName, lastName, email, password] = match;
  try {
    await Account.create({ firstName, lastName, email, password });
    const total = await Account.countDocuments({ assigned: false });
    bot.sendMessage(msg.chat.id,
      `✅ *تم إضافة الحساب*\n\n👤 ${firstName} ${lastName}\n📧 \`${email}\`\n🔑 \`${password}\`\n\n📦 الحسابات المتاحة: *${total}*`,
      { parse_mode: "Markdown" }
    );
  } catch {
    bot.sendMessage(msg.chat.id, "❌ الإيميل موجود بالفعل.");
  }
});

// /approve
bot.onText(/\/approve (\d+) (\d+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const userId = parseInt(match[1]);
  const taskIndex = parseInt(match[2]);
  const tasks = await Task.find({ userId }).sort({ createdAt: 1 });
  const task = tasks[taskIndex];
  if (!task) { bot.sendMessage(msg.chat.id, "❌ المهمة غير موجودة."); return; }
  if (task.status !== "pending") { bot.sendMessage(msg.chat.id, `⚠️ تمت معالجتها (${task.status}).`); return; }
  task.status = "approved";
  await task.save();
  const user = await User.findOne({ telegramId: userId });
  if (user) {
    user.balance += task.amount;
    await user.save();
    bot.sendMessage(userId,
      `✅ *تمت الموافقة على حسابك!*\n\n📧 \`${task.accountEmail}\`\n💵 تم إضافة *$${task.amount} USDT*!\n💰 رصيدك: *$${fmt(user.balance)} USDT*`,
      { parse_mode: "Markdown", ...MAIN_MENU }
    ).catch(() => {});
  }
  bot.sendMessage(msg.chat.id, `✅ تمت الموافقة وإضافة $${task.amount} للمستخدم.`);
});

// /reject
bot.onText(/\/reject (\d+) (\d+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const userId = parseInt(match[1]);
  const taskIndex = parseInt(match[2]);
  const tasks = await Task.find({ userId }).sort({ createdAt: 1 });
  const task = tasks[taskIndex];
  if (!task) { bot.sendMessage(msg.chat.id, "❌ المهمة غير موجودة."); return; }
  if (task.status !== "pending") { bot.sendMessage(msg.chat.id, `⚠️ تمت معالجتها (${task.status}).`); return; }
  task.status = "rejected";
  await task.save();
  if (task.accountId) {
    await Account.findByIdAndUpdate(task.accountId, { assigned: false, assignedTo: null, assignedAt: null });
  }
  const user = await User.findOne({ telegramId: userId });
  if (user) {
    bot.sendMessage(userId,
      `❌ *تم رفض الحساب*\n\n📧 \`${task.accountEmail}\`\n\nتأكد من استخدام البيانات المحددة وإعادة المحاولة.`,
      { parse_mode: "Markdown", ...MAIN_MENU }
    ).catch(() => {});
  }
  bot.sendMessage(msg.chat.id, `❌ تم الرفض وإعادة الحساب للمتاح.`);
});

// /pending
bot.onText(/\/pending/, async (msg) => {
  if (msg.from.id !== ADMIN_ID) return;
  const tasks = await Task.find({ status: "pending" }).sort({ createdAt: 1 }).limit(20);
  if (!tasks.length) { bot.sendMessage(msg.chat.id, "✅ لا توجد طلبات معلقة."); return; }
  let text = `⏳ *الطلبات المعلقة (${tasks.length})*\n\n`;
  for (const t of tasks) {
    const user = await User.findOne({ telegramId: t.userId }, "firstName");
    const account = await Account.findById(t.accountId);
    const userTasks = await Task.find({ userId: t.userId }).sort({ createdAt: 1 });
    const index = userTasks.findIndex(x => x._id.equals(t._id));
    text += `📧 \`${t.accountEmail}\`\n🔑 \`${account?.password || "غير متاح"}\`\n👤 ${account?.firstName} ${account?.lastName}\n👤 ${user?.firstName} (\`${t.userId}\`)\n✅ /approve ${t.userId} ${index}  ❌ /reject ${t.userId} ${index}\n\n`;
  }
  bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
});

// /accounts
bot.onText(/\/accounts/, async (msg) => {
  if (msg.from.id !== ADMIN_ID) return;
  const available = await Account.countDocuments({ assigned: false });
  const assigned = await Account.countDocuments({ assigned: true });
  bot.sendMessage(msg.chat.id,
    `📦 *الحسابات*\n\n✅ متاح: *${available}*\n🔒 مُعيَّن: *${assigned}*\n📊 الإجمالي: *${available + assigned}*`,
    { parse_mode: "Markdown" }
  );
});

// /addbalance
bot.onText(/\/addbalance (\d+) ([\d.]+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const user = await User.findOne({ telegramId: parseInt(match[1]) });
  if (!user) { bot.sendMessage(msg.chat.id, "❌ المستخدم غير موجود."); return; }
  user.balance += parseFloat(match[2]);
  await user.save();
  bot.sendMessage(msg.chat.id, `✅ تم. الرصيد الجديد: $${fmt(user.balance)}`);
  bot.sendMessage(user.telegramId, `🎁 تم إضافة $${match[2]} لرصيدك!\nرصيدك: $${fmt(user.balance)}`, MAIN_MENU).catch(() => {});
});

// /ban /unban
bot.onText(/\/ban (\d+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const user = await User.findOne({ telegramId: parseInt(match[1]) });
  if (!user) { bot.sendMessage(msg.chat.id, "❌ غير موجود."); return; }
  user.banned = true; await user.save();
  bot.sendMessage(msg.chat.id, `🚫 تم حظر ${user.firstName}.`);
  bot.sendMessage(user.telegramId, "🚫 تم حظرك.").catch(() => {});
});

bot.onText(/\/unban (\d+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const user = await User.findOne({ telegramId: parseInt(match[1]) });
  if (!user) { bot.sendMessage(msg.chat.id, "❌ غير موجود."); return; }
  user.banned = false; await user.save();
  bot.sendMessage(msg.chat.id, `✅ تم رفع الحظر عن ${user.firstName}.`);
  bot.sendMessage(user.telegramId, "✅ تم رفع الحظر!", MAIN_MENU).catch(() => {});
});

// /users
bot.onText(/\/users/, async (msg) => {
  if (msg.from.id !== ADMIN_ID) return;
  const users = await User.find().sort({ createdAt: -1 }).limit(20);
  let text = `👥 *المستخدمون*\n\n`;
  users.forEach((u, i) => {
    text += `${i + 1}. ${u.firstName}${u.banned ? " 🚫" : ""} | $${fmt(u.balance)} | \`${u.telegramId}\`\n`;
  });
  bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
});

// /stats
bot.onText(/\/stats/, async (msg) => {
  if (msg.from.id !== ADMIN_ID) return;
  const totalUsers = await User.countDocuments();
  const pendingTasks = await Task.countDocuments({ status: "pending" });
  const approvedTasks = await Task.countDocuments({ status: "approved" });
  const availableAccounts = await Account.countDocuments({ assigned: false });
  const paid = await Task.aggregate([{ $match: { status: "approved" } }, { $group: { _id: null, total: { $sum: "$amount" } } }]);
  bot.sendMessage(msg.chat.id,
    `📊 *الإحصائيات*\n\n👤 المستخدمون: *${totalUsers}*\n📦 الحسابات المتاحة: *${availableAccounts}*\n✅ طلبات مقبولة: *${approvedTasks}*\n⏳ قيد المراجعة: *${pendingTasks}*\n💵 إجمالي المدفوع: *$${fmt(paid[0]?.total || 0)} USDT*`,
    { parse_mode: "Markdown" }
  );
});

// /broadcast
bot.onText(/\/broadcast (.+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const users = await User.find({}, "telegramId");
  let sent = 0, failed = 0;
  for (const u of users) {
    try { await bot.sendMessage(u.telegramId, `📢 *رسالة من الإدارة*\n\n${match[1]}`, { parse_mode: "Markdown" }); sent++; }
    catch { failed++; }
  }
  bot.sendMessage(msg.chat.id, `📢 ✅ ${sent} نجح | ❌ ${failed} فشل`);
});

// /withdrawals
bot.onText(/\/withdrawals/, async (msg) => {
  if (msg.from.id !== ADMIN_ID) return;
  const wds = await Withdrawal.find({ status: "pending" }).limit(20);
  if (!wds.length) { bot.sendMessage(msg.chat.id, "✅ لا توجد طلبات سحب."); return; }
  let text = `💸 *طلبات السحب*\n\n`;
  for (const w of wds) {
    const u = await User.findOne({ telegramId: w.userId }, "firstName");
    text += `👤 ${u?.firstName} (\`${w.userId}\`)\n💵 $${fmt(w.amount)}\n📮 \`${w.address}\`\n\n`;
  }
  bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
});

// ─── Auto Cancel After 20 Minutes ────────────────────────────────────────────

async function cancelExpiredAssignments() {
  const expireTime = new Date(Date.now() - 20 * 60 * 1000); // 20 دقيقة
  const expiredAccounts = await Account.find({
    assigned: true,
    assignedAt: { $lt: expireTime },
  });

  for (const account of expiredAccounts) {
    const user = await User.findOne({ telegramId: account.assignedTo });

    // تحقق إن المستخدم لا يزال في حالة انتظار تأكيد هذا الحساب
    if (user && user.state === "awaiting_confirmation" &&
        user.stateMeta?.accountId === account._id.toString()) {
      user.state = null;
      user.stateMeta = null;
      await user.save();

      // أرسل إشعار للمستخدم
      bot.sendMessage(user.telegramId,
        `⏰ *انتهت مهلة التسجيل!*\n\n` +
        `لم تؤكد إنشاء الحساب خلال 20 دقيقة.\n` +
        `تم إلغاء الطلب تلقائياً.\n\n` +
        `اضغط "أنشئ حساب Gmail جديد" للمحاولة مجدداً.`,
        { parse_mode: "Markdown", ...MAIN_MENU }
      ).catch(() => {});
    }

    // أعد الحساب للمتاح
    await Account.findByIdAndUpdate(account._id, {
      assigned: false,
      assignedTo: null,
      assignedAt: null,
    });
  }

  if (expiredAccounts.length > 0) {
    console.log(`🔄 تم إلغاء ${expiredAccounts.length} حساب منتهي الصلاحية`);
  }
}

// شغّل الفحص كل دقيقة
setInterval(cancelExpiredAssignments, 60 * 1000);

// ─── Connect ──────────────────────────────────────────────────────────────────

mongoose.connection.on("connected", () => console.log("✅ MongoDB connected"));
mongoose.connection.on("error", err => console.error("⚠️ MongoDB error:", err.message));
mongoose.connection.on("disconnected", () => console.warn("⚠️ MongoDB disconnected"));

mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 10000 })
  .catch(err => console.error("❌ MongoDB connection failed:", err.message));

console.log("🤖 Bot is running...");

const PORT = process.env.PORT || 8080;
http.createServer((req, res) => {
  res.writeHead(200); res.end(JSON.stringify({ status: "ok" }));
}).listen(PORT, () => console.log(`🌐 HTTP server on port ${PORT}`));

bot.on("polling_error", err => console.error("Polling error:", err.message));
process.on("SIGTERM", async () => {
  await bot.stopPolling();
  await mongoose.disconnect();
  process.exit(0);
});

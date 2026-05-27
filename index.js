const TelegramBot = require("node-telegram-bot-api");
const mongoose = require("mongoose");
const http = require("http");
const dns = require("dns").promises;
const crypto = require("crypto");

// --- إعدادات متغيرات البيئة ---
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_ID = parseInt(process.env.ADMIN_ID || "7693096273", 10);
const RECOVERY_EMAIL = process.env.RECOVERY_EMAIL || "ryal2422@gmail.com";

// مفتاح التشفير (يجب تعيينه في Railway بطول 64 حرفاً ورقمًا Hex، أو سيستخدم هذا الافتراضي مؤقتاً)
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"; 
const IV_LENGTH = 16;

if (!BOT_TOKEN) throw new Error("BOT_TOKEN is required");
if (!MONGODB_URI) throw new Error("MONGODB_URI is required");

// ─── Models ───────────────────────────────────────────────────────────────────

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
  password: { type: String, required: true }, // سيتم تخزينه مشفراً
  assigned: { type: Boolean, default: false },
  assignedTo: { type: Number, default: null },
  assignedAt: { type: Date, default: null },
}, { timestamps: true });

const taskSchema = new mongoose.Schema({
  userId: { type: Number, required: true },
  amount: { type: Number, required: true },
  accountEmail: { type: String, required: true },
  accountId: { type: mongoose.Schema.Types.ObjectId, ref: "Account" },
  backupCodes: { type: String, default: "" }, // إضافة حقل حفظ أكواد الطوارئ مشفرة
  status: { type: String, enum: ["pending", "approved", "rejected"], default: "pending" },
  autoChecked: { type: Boolean, default: false },
  checkResult: { type: String, default: null },
  submittedAt: { type: Date, default: Date.now },
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

// ─── وظائف التشفير لحماية البيانات ───────────────────────────────────────────

function encrypt(text) {
  if (!text) return "";
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv("aes-256-cbc", Buffer.from(ENCRYPTION_KEY, "hex"), iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  return iv.toString("hex") + ":" + encrypted;
}

function decrypt(text) {
  if (!text) return "";
  try {
    const textParts = text.split(":");
    const iv = Buffer.from(textParts.shift(), "hex");
    const encryptedText = Buffer.from(textParts.join(":"), "hex");
    const decipher = crypto.createDecipheriv("aes-256-cbc", Buffer.from(ENCRYPTION_KEY, "hex"), iv);
    let decrypted = decipher.update(encryptedText, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch (err) {
    return "خطأ في فك التشفير";
  }
}

function escapeHtml(text) {
  if (!text) return "";
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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

// ─── Auto Check Email ─────────────────────────────────────────────────────────

async function verifyEmail(email) {
  try {
    const emailRegex = /^[a-zA-Z0-9._%+-]+@gmail\.com$/;
    if (!emailRegex.test(email)) {
      return { valid: false, reason: "صيغة الإيميل غير صحيحة" };
    }
    const mxRecords = await dns.resolveMx("gmail.com");
    if (!mxRecords || mxRecords.length === 0) {
      return { valid: false, reason: "تعذر التحقق من النطاق" };
    }
    const existingTask = await Task.findOne({ accountEmail: email, status: { $in: ["pending", "approved"] } });
    if (existingTask) {
      return { valid: false, reason: "هذا الإيميل مستخدم بالفعل في النظام" };
    }
    return { valid: true, reason: "الإيميل صحيح" };
  } catch (err) {
    return { valid: false, reason: "خطأ في التحقق" };
  }
}

// ─── Auto Review Task after 72 hours ─────────────────────────────────────────

async function autoReviewTasks() {
  const seventyTwoHoursAgo = new Date(Date.now() - 72 * 60 * 60 * 1000);
  const expiredTasks = await Task.find({
    status: "pending",
    submittedAt: { $lte: seventyTwoHoursAgo },
    autoChecked: false,
  });

  for (const task of expiredTasks) {
    const result = await verifyEmail(task.accountEmail);
    task.autoChecked = true;
    task.checkResult = result.reason;

    if (result.valid) {
      task.status = "approved";
      await task.save();
      const user = await User.findOne({ telegramId: task.userId });
      if (user) {
        user.balance += task.amount;
        await user.save();
        bot.sendMessage(task.userId,
          `✅ <b>تمت الموافقة على حسابك تلقائياً!</b>\n\n` +
          `📧 الإيميل: <code>${escapeHtml(task.accountEmail)}</code>\n` +
          `💵 تم إضافة <b>$${task.amount} USDT</b> لرصيدك!\n` +
          `💰 رصيدك الحالي: <b>$${fmt(user.balance)} USDT</b>`,
          { parse_mode: "HTML", ...MAIN_MENU }
        ).catch(() => {});
      }
      bot.sendMessage(ADMIN_ID,
        `✅ <b>تمت الموافقة التلقائية</b>\n\n📧 <code>${escapeHtml(task.accountEmail)}</code>\n👤 <code>${task.userId}</code>\n💵 $${task.amount} USDT`,
        { parse_mode: "HTML" }
      ).catch(() => {});
    } else {
      task.status = "rejected";
      await task.save();
      if (task.accountId) {
        await Account.findByIdAndUpdate(task.accountId, { assigned: false, assignedTo: null, assignedAt: null });
      }
      const user = await User.findOne({ telegramId: task.userId });
      if (user) {
        bot.sendMessage(task.userId,
          `❌ <b>تم رفض حسابك تلقائياً</b>\n\n📧 <code>${escapeHtml(task.accountEmail)}</code>\nالسبب: ${escapeHtml(result.reason)}\n\nيمكنك المحاولة مرة أخرى.`,
          { parse_mode: "HTML", ...MAIN_MENU }
        ).catch(() => {});
      }
      bot.sendMessage(ADMIN_ID,
        `❌ <b>تم الرفض التلقائي</b>\n\n📧 <code>${escapeHtml(task.accountEmail)}</code>\n👤 <code>${task.userId}</code>\nالسبب: ${escapeHtml(result.reason)}`,
        { parse_mode: "HTML" }
      ).catch(() => {});
    }
  }
}

setInterval(autoReviewTasks, 60 * 60 * 1000);

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

const CONFIRM_MENU = {
  reply_markup: {
    keyboard: [
      ["✅ تم التفعيل والإنشاء"],
      ["❌ إلغاء إنشاء الحساب"],
    ],
    resize_keyboard: true,
  },
};

// ─── Bot ──────────────────────────────────────────────────────────────────────

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// /start
bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  const user = await getOrCreateUser(msg);
  const refCode = match && match[1] ? match[1].trim() : null;

  if (user.state) {
    const accountId = user.stateMeta?.accountId;
    if (accountId) await Account.findByIdAndUpdate(accountId, { assigned: false, assignedTo: null });
    user.state = null; user.stateMeta = null; await user.save();
  }

  if (refCode && !user.referredBy) {
    const referrer = await User.findOne({ referralCode: refCode });
    if (referrer && referrer.telegramId !== user.telegramId) {
      user.referredBy = referrer.telegramId;
      await user.save();
      referrer.referralCount += 1;
      await referrer.save();
      bot.sendMessage(referrer.telegramId, `🎉 انضم مستخدم جديد عبر رابط إحالتك!`).catch(() => {});
    }
  }

  bot.sendMessage(msg.chat.id,
    `👋 <b>أهلاً ${escapeHtml(user.firstName)}!</b>\n\n` +
    `💰 <b>اكسب من إنشاء حسابات Gmail!</b>\n\n` +
    `📌 <b>كيف يعمل البوت:</b>\n` +
    `1️⃣ اضغط "أنشئ حساب Gmail جديد"\n` +
    `2️⃣ ستحصل على بيانات جاهزة ومخصصة.\n` +
    `3️⃣ سجّل الحساب في جوجل باستخدام البيانات بالترتيب.\n` +
    `4️⃣ <b>قم بتفعيل ميزة التحقق بخطوتين (2FA) واستخرج أكواد الطوارئ الـ 8 للحساب لتسليمها والحصول على المكافأة.</b>\n\n` +
    `💵 السعر لكل حساب مطابق للشروط: <b>$0.17 USDT</b>`,
    { parse_mode: "HTML", ...MAIN_MENU }
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

  // ─── أنشئ حساب Gmail جديد ───────────────────────────────────────────────────
  if (text === "➕ أنشئ حساب Gmail جديد") {
    const pending = await Task.findOne({ userId: user.telegramId, status: "pending" });
    if (pending) {
      const timeLeft = Math.ceil((pending.submittedAt.getTime() + 72 * 60 * 60 * 1000 - Date.now()) / (60 * 60 * 1000));
      bot.sendMessage(chatId,
        `⏳ <b>لديك حساب قيد المراجعة</b>\n\n` +
        `📧 الإيميل: <code>${escapeHtml(pending.accountEmail)}</code>\n` +
        `⏰ الوقت المتبقي: <b>${timeLeft > 0 ? timeLeft : 0} ساعة</b>\n\n` +
        `انتظر حتى تتم مراجعته تلقائياً.`,
        { parse_mode: "HTML" }
      );
      return;
    }

    const account = await Account.findOneAndUpdate(
      { assigned: false },
      { assigned: true, assignedTo: user.telegramId, assignedAt: new Date() },
      { new: true }
    );

    if (!account) {
      bot.sendMessage(chatId, `❌ <b>لا توجد حسابات متاحة حالياً بالمستودع</b>\n\nيرجى المحاولة لاحقاً.`, { parse_mode: "HTML" });
      return;
    }

    user.state = "awaiting_confirmation";
    user.stateMeta = { accountId: account._id.toString() };
    await user.save();

    // تعديل الفصل البرمجي: الاسم واللقب منفصلان وبدون أي نصوص ملتصقة بالـ 2FA هنا
    bot.sendMessage(chatId,
      `📧 <b>قم بتسجيل حساب Gmail باستخدام البيانات المحددة:</b>\n\n` +
      `👤 الاسم الأول: <code>${escapeHtml(account.firstName)}</code>\n` +
      `👥 اللقب/العائلة: <code>${escapeHtml(account.lastName)}</code>\n` +
      `📧 البريد الإلكتروني: <code>${escapeHtml(account.email)}</code>\n` +
      `🔑 كلمة المرور: <code>${escapeHtml(decrypt(account.password))}</code>\n` +
      `🔗 بريد الاستعادة الإلزامي: <code>${escapeHtml(RECOVERY_EMAIL)}</code>\n\n` +
      `⚠️ <b>تنبيه هام جداً:</b> أنشئ الحساب بالمعلومات السابقة تماماً دون تغيير، وعند الانتهاء اضغط الزر بالأسفل للتحقق وجلب الأكواد.`,
      { parse_mode: "HTML", ...CONFIRM_MENU }
    );
    return;
  }

  // ─── استقبال أكواد الطوارئ (2FA) بعد نجاح الفحص الأول ────────────────────────
  if (user.state === "awaiting_gmail_backup_codes") {
    if (text === "❌ إلغاء إنشاء الحساب") {
      const accountId = user.stateMeta?.accountId;
      if (accountId) await Account.findByIdAndUpdate(accountId, { assigned: false, assignedTo: null });
      user.state = null; user.stateMeta = null; await user.save();
      bot.sendMessage(chatId, "🚫 تم إلغاء العملية وعودة الحساب للمستودع.", MAIN_MENU).catch(() => {});
      return;
    }

    const backupCodes = text.trim();
    if (backupCodes.length < 8) {
      bot.sendMessage(chatId, "⚠️ صيغة رموز الطوارئ تبدو خاطئة. يرجى إرسال الـ 8 رموز الاحتياطية المستخرجة من جوجل بشكل كامل:");
      return;
    }

    const accountId = user.stateMeta?.accountId;
    const account = await Account.findById(accountId);
    if (!account) {
      user.state = null; user.stateMeta = null; await user.save();
      bot.sendMessage(chatId, "❌ حدث خطأ، لم نتمكن من العثور على بيانات الحساب المرتبط.", MAIN_MENU);
      return;
    }

    // إنشاء المهمة وحفظ الأكواد مشفرة بأمان
    const task = await Task.create({
      userId: user.telegramId,
      amount: 0.17,
      accountEmail: account.email,
      accountId: account._id,
      backupCodes: encrypt(backupCodes),
      submittedAt: new Date(),
    });

    user.state = null; user.stateMeta = null; await user.save();

    bot.sendMessage(chatId,
      `✅ <b>تم استلام رموز الأمان وإرسال طلبك بنجاح!</b>\n\n` +
      `📧 الإيميل: <code>${escapeHtml(account.email)}</code>\n` +
      `💵 القيمة: <b>$0.17 USDT</b>\n\n` +
      `⏳ سيتم مراجعة البيانات والأكواد تلقائياً خلال 72 ساعة وضخ الرصيد لمحفظتك فوراً.`,
      { parse_mode: "HTML", ...MAIN_MENU }
    );

    const userTasks = await Task.find({ userId: user.telegramId });
    const taskIndex = userTasks.length - 1;

    bot.sendMessage(ADMIN_ID,
      `📬 <b>طلب مراجعة Gmail جديد (2FA)</b>\n\n` +
      `👤 المستخدم: ${escapeHtml(user.firstName)} (<code>${user.telegramId}</code>)\n` +
      `📧 الإيميل: <code>${escapeHtml(account.email)}</code>\n` +
      `🔑 الباسورد: <code>${escapeHtml(decrypt(account.password))}</code>\n` +
      `🚨 <b>رموز الطوارئ المستلمة:</b>\n<code>${escapeHtml(backupCodes)}</code>\n\n` +
      `للموافقة اليدوية: /approve ${user.telegramId} ${taskIndex}\n` +
      `للرفض اليدوي: /reject ${user.telegramId} ${taskIndex}`,
      { parse_mode: "HTML" }
    ).catch(() => {});
    return;
  }

  // ─── زر تم التفعيل والإنشاء ───────────────────────────────────────────────────
  if (text === "✅ تم التفعيل والإنشاء" || text === "✅ تم") {
    if (user.state !== "awaiting_confirmation") {
      bot.sendMessage(chatId, "❌ لا يوجد حساب نشط مخصص لك حالياً.", MAIN_MENU);
      return;
    }

    const accountId = user.stateMeta?.accountId;
    const account = await Account.findById(accountId);

    if (!account) {
      bot.sendMessage(chatId, "❌ حدث خطأ، الرجاء المحاولة مرة أخرى.", MAIN_MENU);
      return;
    }

    bot.sendMessage(chatId, `🔍 <b>جاري فحص حالة البريد الإلكتروني والـ MX تلقائياً...</b>`, { parse_mode: "HTML" });

    const verification = await verifyEmail(account.email);

    if (!verification.valid) {
      await Account.findByIdAndUpdate(accountId, { assigned: false, assignedTo: null, assignedAt: null });
      user.state = null; user.stateMeta = null; await user.save();
      bot.sendMessage(chatId,
        `❌ <b>فشل الفحص تلقائياً:</b> ${escapeHtml(verification.reason)}\n\nتأكد من إنشاء الحساب جيداً ثم حاول مرة أخرى لاحقاً.`,
        { parse_mode: "HTML", ...MAIN_MENU }
      );
      return;
    }

    // الانتقال للخطوة التالية المنفصلة لطلب أكواد الأمان (الـ 2FA) لمنع تداخل الرسائل
    user.state = "awaiting_gmail_backup_codes";
    await user.save();

    bot.sendMessage(chatId,
      `✅ <b>فحص البريد سليم تماماً!</b>\n\n` +
      `🔒 <b>الخطوة الأخيرة والأهم (تأمين الحساب):</b>\n` +
      `يرجى التوجه فوراً لإعدادات حساب Google الموضح أعلاه، وتفعيل ميزة <b>(التحقق بخطوتين - 2FA)</b> ثم استخراج <b>رموز النسخ الاحتياطي الـ 8 (Backup Codes)</b> وإرسالها كاملة كرسالة نصية واحدة هنا في الشات:`,
      { parse_mode: "HTML", reply_markup: { keyboard: [["❌ إلغاء إنشاء الحساب"]], resize_keyboard: true } }
    );
    return;
  }

  // ─── زر إلغاء إنشاء الحساب ───────────────────────────────────────────────────
  if (text === "❌ إلغاء إنشاء الحساب") {
    const accountId = user.stateMeta?.accountId;
    if (accountId) {
      await Account.findByIdAndUpdate(accountId, { assigned: false, assignedTo: null, assignedAt: null });
    }
    user.state = null; user.stateMeta = null; await user.save();
    bot.sendMessage(chatId, "🚫 تم إلغاء العملية بنجاح وعاد الحساب للمستودع العام.", MAIN_MENU);
    return;
  }

  // ─── حساباتي ──────────────────────────────────────────────────────────────────
  if (text === "📋 حساباتي") {
    const tasks = await Task.find({ userId: user.telegramId }).sort({ createdAt: -1 }).limit(10);
    if (!tasks.length) {
      bot.sendMessage(chatId, `📋 <b>لا توجد حسابات مسجلة باسمك بعد</b>\n\nاضغط "أنشئ حساب Gmail جديد" للبدء الآن!`, { parse_mode: "HTML", ...MAIN_MENU });
      return;
    }
    let txt = `📋 <b>سجل حساباتك المرفوعة:</b>\n\n`;
    for (const t of tasks) {
      const statusEmoji = t.status === "approved" ? "✅" : t.status === "rejected" ? "❌" : "⏳";
      const timeLeft = t.status === "pending" ? Math.ceil((t.submittedAt.getTime() + 72 * 60 * 60 * 1000 - Date.now()) / (60 * 60 * 1000)) : null;
      txt += `${statusEmoji} <code>${escapeHtml(t.accountEmail)}</code> — $${fmt(t.amount)}`;
      if (timeLeft !== null && timeLeft > 0) txt += ` (متبقي ${timeLeft}س)`;
      txt += `\n`;
    }
    bot.sendMessage(chatId, txt, { parse_mode: "HTML", ...MAIN_MENU });
    return;
  }

  // ─── الرصيد ───────────────────────────────────────────────────────────────────
  if (text === "💰 الرصيد") {
    const approved = await Task.countDocuments({ userId: user.telegramId, status: "approved" });
    const pending = await Task.countDocuments({ userId: user.telegramId, status: "pending" });
    bot.sendMessage(chatId,
      `💰 <b>تفاصيل رصيدك المالي:</b>\n\n` +
      `💵 الرصيد المتاح: <b>$${fmt(user.balance)} USDT</b>\n\n` +
      `✅ حسابات مقبولة: ${approved}\n` +
      `⏳ قيد المراجعة: ${pending}\n` +
      `👥 نظام الإحالات: ${user.referralCount}\n\n` +
      `💸 الحد الأدنى لطلب السحب: <b>$0.20 USDT</b>`,
      { parse_mode: "HTML", ...MAIN_MENU }
    );
    return;
  }

  // ─── الإحالات ─────────────────────────────────────────────────────────────────
  if (text === "👥 الإحالات الخاصة بي") {
    const botInfo = await bot.getMe();
    const link = `https://t.me/${botInfo.username}?start=${user.referralCode}`;
    bot.sendMessage(chatId,
      `👥 <b>نظام مشاركة الأرباح والإحالات:</b>\n\n` +
      `🔗 رابط الإحالة الخاص بك:\n<code>${link}</code>\n\n` +
      `👤 إجمالي عدد الإحالات المسجلة عن طريقك: <b>${user.referralCount} إحالة</b>`,
      { parse_mode: "HTML", ...MAIN_MENU }
    );
    return;
  }

  // ─── الإعدادات ────────────────────────────────────────────────────────────────
  if (text === "⚙️ الإعدادات") {
    bot.sendMessage(chatId,
      `⚙️ <b>إعدادات حسابك الشخصي:</b>\n\n` +
      `👤 الاسم: ${escapeHtml(user.firstName)}\n` +
      `🆔 معرف التليجرام: <code>${user.telegramId}</code>\n` +
      `💰 رصيدك الكلي: $${fmt(user.balance)}\n\n` +
      `لطلب سحب الأرباح الآن أرسل أمر السحب: /withdraw`,
      { parse_mode: "HTML", ...MAIN_MENU }
    );
    return;
  }

  // ─── المساعدة ─────────────────────────────────────────────────────────────────
  if (text === "💬 مساعدة") {
    bot.sendMessage(chatId,
      `💬 <b>دليل المساعدة والتعليمات الفنية:</b>\n\n` +
      `❓ <b>كيف تنشئ حساب الجيميل المطلوب؟</b>\n` +
      `1. افتح متصفحك أو تطبيق Gmail ثم اضغط إنشاء حساب جديد.\n` +
      `2. انقل الاسم واللقب المعطى لك من البوت بدقة.\n` +
      `3. ضع عنوان البريد وكلمة المرور المتوفرة.\n` +
      `4. اربط الحساب ببريد الاستعادة الإلزامي.\n` +
      `5. <b>قم بتفعيل ميزة التحقق بخطوتين (2FA) وانسخ رموز الطوارئ الثمانية وقم بتسليمها للبوت للتأكيد وضمان القبول.</b>\n\n` +
      `💬 للدعم والمساعدة المباشرة تواصل معنا عبر: @admin`,
      { parse_mode: "HTML", ...MAIN_MENU }
    );
    return;
  }

  // ─── عمليات معالجة السحب المالي رقمياً ──────────────────────────────────────────
  if (user.state === "awaiting_withdraw_amount") {
    const amount = parseFloat(text.trim());
    if (isNaN(amount) || amount < 0.20) {
      bot.sendMessage(chatId, "❌ الحد الأدنى للسحب هو $0.20 USDT. يرجى إدخال مبلغ صحيح:");
      return;
    }
    if (amount > user.balance) {
      bot.sendMessage(chatId, `❌ عذراً رصيدك الحالي <b>$${fmt(user.balance)}</b> غير كافٍ لتغطية المعاملة.`, { parse_mode: "HTML" });
      return;
    }
    user.state = "awaiting_withdraw_address";
    user.stateMeta = { amount };
    await user.save();
    bot.sendMessage(chatId, `📮 ممتاز، أرسل الآن عنوان محفظتك لاستقبال الرصيد <b>(USDT TRC20)</b>:`, { parse_mode: "HTML" });
    return;
  }

  if (user.state === "awaiting_withdraw_address") {
    const address = text.trim();
    const amount = user.stateMeta?.amount;
    if (!address || address.length < 10) {
      bot.sendMessage(chatId, "❌ عنوان المحفظة المدخل يبدو غير سليم، يرجى المحاولة مرة أخرى بالتأكيد:");
      return;
    }
    user.balance -= amount;
    user.state = null; user.stateMeta = null;
    await user.save();
    await Withdrawal.create({ userId: user.telegramId, amount, address });
    bot.sendMessage(chatId,
      `✅ <b>تم قيد وتسجيل طلب السحب الخاص بك بنجاح!</b>\n\n` +
      `💵 المبلغ المستقطع: <b>$${fmt(amount)} USDT</b>\n` +
      `📮 عنوان الإرسال: <code>${escapeHtml(address)}</code>\n\n` +
      `⏳ جاري مراجعة التحويل وإرسال الأموال لمحفظتك خلال 24 ساعة كحد أقصى.`,
      { parse_mode: "HTML", ...MAIN_MENU }
    );
    bot.sendMessage(ADMIN_ID,
      `💸 <b>طلب سحب مالي جديد معلق</b>\n\n` +
      `👤 المستخدم: ${escapeHtml(user.firstName)} (<code>${user.telegramId}</code>)\n` +
      `💵 القيمة الإجمالية: $${fmt(amount)} USDT\n` +
      `📮 المحفظة المستهدفة: <code>${escapeHtml(address)}</code>`,
      { parse_mode: "HTML" }
    ).catch(() => {});
    return;
  }
});

// ─── Admin Commands ───────────────────────────────────────────────────────────

// إضافة حسابات للمستودع (يقوم الكود بتشفير كلمة المرور تلقائياً قبل الحفظ لزيادة الأمان)
bot.onText(/\/addaccount (\S+) (\S+) (\S+) (\S+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const [, firstName, lastName, email, password] = match;
  try {
    await Account.create({ firstName, lastName, email, password: encrypt(password) });
    const total = await Account.countDocuments({ assigned: false });
    bot.sendMessage(msg.chat.id,
      `✅ <b>تم إضافة الحساب للمستودع وتشفيره</b>\n\n👤 ${escapeHtml(firstName)} ${escapeHtml(lastName)}\n📧 <code>${escapeHtml(email)}</code>\n🔑 <code>${escapeHtml(password)}</code>\n\n📦 إجمالي الحسابات الجاهزة للتوزيع المتاحة: <b>${total}</b>`,
      { parse_mode: "HTML" }
    );
  } catch (err) {
    bot.sendMessage(msg.chat.id, "❌ فشل الإدخال، هذا الإيميل مكرر أو موجود مسبقاً في قاعدة البيانات.");
  }
});

bot.onText(/\/approve (\d+) (\d+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const userId = parseInt(match[1]);
  const taskIndex = parseInt(match[2]);
  const tasks = await Task.find({ userId }).sort({ createdAt: 1 });
  const task = tasks[taskIndex];
  if (!task) { bot.sendMessage(msg.chat.id, "❌ المهمة غير موجودة."); return; }
  if (task.status !== "pending") { bot.sendMessage(msg.chat.id, `⚠️ تمت معالجتها سابقاً (${task.status}).`); return; }
  task.status = "approved";
  await task.save();
  const user = await User.findOne({ telegramId: userId });
  if (user) {
    user.balance += task.amount;
    await user.save();
    bot.sendMessage(userId,
      `✅ <b>تهانينا، تمت الموافقة وقبول حسابك يدوياً من الإدارة!</b>\n\n📧 <code>${escapeHtml(task.accountEmail)}</code>\n💵 تم إضافة <b>$${task.amount} USDT</b> لحسابك!\n💰 رصيدك الإجمالي الحالي: <b>$${fmt(user.balance)} USDT</b>`,
      { parse_mode: "HTML", ...MAIN_MENU }
    ).catch(() => {});
  }
  bot.sendMessage(msg.chat.id, `✅ تمت الموافقة بنجاح وضخ $${task.amount} لرصيد المستخدم.`);
});

bot.onText(/\/reject (\d+) (\d+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const userId = parseInt(match[1]);
  const taskIndex = parseInt(match[2]);
  const tasks = await Task.find({ userId }).sort({ createdAt: 1 });
  const task = tasks[taskIndex];
  if (!task) { bot.sendMessage(msg.chat.id, "❌ المهمة غير موجودة."); return; }
  if (task.status !== "pending") { bot.sendMessage(msg.chat.id, `⚠️ تمت معالجتها مسبقاً (${task.status}).`); return; }
  task.status = "rejected";
  await task.save();
  if (task.accountId) {
    await Account.findByIdAndUpdate(task.accountId, { assigned: false, assignedTo: null, assignedAt: null });
  }
  const user = await User.findOne({ telegramId: userId });
  if (user) {
    bot.sendMessage(userId,
      `❌ <b>عذراً، رفضت الإدارة حسابك المرفوع بعد مراجعته يدوياً</b>\n\n📧 <code>${escapeHtml(task.accountEmail)}</code>\n\nيرجى مراجعة إعدادات الأمان أو الأكواد المرفوعة والمحاولة مرة أخرى بحساب أخر وسليم.`,
      { parse_mode: "HTML", ...MAIN_MENU }
    ).catch(() => {});
  }
  bot.sendMessage(msg.chat.id, `❌ تم رفض الطلب وإعادة قالب البيانات للمستودع بنجاح.`);
});

bot.onText(/\/pending/, async (msg) => {
  if (msg.from.id !== ADMIN_ID) return;
  const tasks = await Task.find({ status: "pending" }).sort({ createdAt: 1 }).limit(20);
  if (!tasks.length) { bot.sendMessage(msg.chat.id, "✅ لا توجد أي طلبات مراجعة معلقة بالمستودع."); return; }
  let text = `⏳ <b>قائمة الحسابات المعلقة والمطروحة للمراجعة (${tasks.length}):</b>\n\n`;
  for (const t of tasks) {
    const user = await User.findOne({ telegramId: t.userId }, "firstName");
    const account = await Account.findById(t.accountId);
    const userTasks = await Task.find({ userId: t.userId }).sort({ createdAt: 1 });
    const index = userTasks.findIndex(x => x._id.equals(t._id));
    const timeLeft = Math.ceil((t.submittedAt.getTime() + 72 * 60 * 60 * 1000 - Date.now()) / (60 * 60 * 1000));
    const backupPlain = t.backupCodes ? decrypt(t.backupCodes) : "لم تسلم أكواد أمان بعد";
    
    text += `📧 البريد: <code>${escapeHtml(t.accountEmail)}</code>\n🔑 كلمة المرور: <code>${escapeHtml(account ? decrypt(account.password) : "غير متاح")}</code>\n🚨 <b>الأكواد:</b>\n<code>${escapeHtml(backupPlain)}</code>\n👤 العميل: ${escapeHtml(user?.firstName)} (<code>${t.userId}</code>)\n⏰ متبقي للمراجعة التلقائية: ${timeLeft > 0 ? timeLeft : 0} ساعة\n✅ قبول: /approve ${t.userId} ${index} | ❌ رفض: /reject ${t.userId} ${index}\n\n━━━━━━━━━━━━━━━━━━\n\n`;
  }
  bot.sendMessage(msg.chat.id, text, { parse_mode: "HTML" });
});

bot.onText(/\/accounts/, async (msg) => {
  if (msg.from.id !== ADMIN_ID) return;
  const available = await Account.countDocuments({ assigned: false });
  const assigned = await Account.countDocuments({ assigned: true });
  bot.sendMessage(msg.chat.id,
    `📦 <b>مستودع قوالب البيانات الحالية:</b>\n\n✅ متاح وجاهز للتوزيع: <b>${available}</b>\n🔒 تحت الإنشاء/معين لعميل: <b>${assigned}</b>\n📊 إجمالي المخزون: <b>${available + assigned}</b>`,
    { parse_mode: "HTML" }
  );
});

bot.onText(/\/addbalance (\d+) ([\d.]+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const user = await User.findOne({ telegramId: parseInt(match[1]) });
  if (!user) { bot.sendMessage(msg.chat.id, "❌ هذا الآيدي غير مسجل في البوت."); return; }
  user.balance += parseFloat(match[2]);
  await user.save();
  bot.sendMessage(msg.chat.id, `✅ تم الإضافة بنجاح. الرصيد الجديد الحالي للعميل: $${fmt(user.balance)}`);
  bot.sendMessage(user.telegramId, `🎁 <b>لقد تم شحن حسابك بمكافأة مالية إضافية من الإدارة!</b>\n💵 القيمة المضافة: $${match[2]} USDT\n💰 رصيدك الكلي الحالي: $${fmt(user.balance)} USDT`, { parse_mode: "HTML", ...MAIN_MENU }).catch(() => {});
});

bot.onText(/\/ban (\d+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const user = await User.findOne({ telegramId: parseInt(match[1]) });
  if (!user) { bot.sendMessage(msg.chat.id, "❌ المستخدم غير موجود بالخادم."); return; }
  user.banned = true; await user.save();
  bot.sendMessage(msg.chat.id, `🚫 تم تفعيل الحظر بالكامل عن العميل ${escapeHtml(user.firstName)}.`);
  bot.sendMessage(user.telegramId, "🚫 عذراً، تم حظر حسابك بالكامل من استخدام خدمات هذا البوت نتيجة مخالفة السياسات.").catch(() => {});
});

bot.onText(/\/unban (\d+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const user = await User.findOne({ telegramId: parseInt(match[1]) });
  if (!user) { bot.sendMessage(msg.chat.id, "❌ غير موجود بالخادم."); return; }
  user.banned = false; await user.save();
  bot.sendMessage(msg.chat.id, `✅ تم إلغاء ورفع الحظر بنجاح عن ${escapeHtml(user.firstName)}.`);
  bot.sendMessage(user.telegramId, "✅ أهلاً بك مجدداً، تم رفع الحظر عن حسابك بنجاح ويمكنك معاودة العمل!", { parse_mode: "HTML", ...MAIN_MENU }).catch(() => {});
});

bot.onText(/\/users/, async (msg) => {
  if (msg.from.id !== ADMIN_ID) return;
  const users = await User.find().sort({ createdAt: -1 }).limit(20);
  let text = `👥 <b>آخر 20 مستخدم مسجل بالنظام:</b>\n\n`;
  users.forEach((u, i) => {
    text += `${i + 1}. ${escapeHtml(u.firstName)}${u.banned ? " 🚫" : ""} | الرصيد: $${fmt(u.balance)} | آيدي: <code>${u.telegramId}</code>\n`;
  });
  bot.sendMessage(msg.chat.id, text, { parse_mode: "HTML" });
});

bot.onText(/\/stats/, async (msg) => {
  if (msg.from.id !== ADMIN_ID) return;
  const totalUsers = await User.countDocuments();
  const pendingTasks = await Task.countDocuments({ status: "pending" });
  const approvedTasks = await Task.countDocuments({ status: "approved" });
  const availableAccounts = await Account.countDocuments({ assigned: false });
  const paid = await Task.aggregate([{ $match: { status: "approved" } }, { $group: { _id: null, total: { $sum: "$amount" } } }]);
  bot.sendMessage(msg.chat.id,
    `📊 <b>لوحة الإحصائيات والتحليلات الإدارية الشاملة:</b>\n\n👤 عدد المستخدمين الكلي: <b>${totalUsers}</b>\n📦 الحسابات المتاحة للتوزيع: <b>${availableAccounts}</b>\n✅ إجمالي الحسابات المقبولة: <b>${approvedTasks}</b>\n⏳ طلبات قيد المراجعة والانتظار: <b>${pendingTasks}</b>\n💵 إجمالي المبالغ المدفوعة والموزعة: <b>$${fmt(paid[0]?.total || 0)} USDT</b>`,
    { parse_mode: "HTML" }
  );
});

bot.onText(/\/broadcast (.+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const users = await User.find({}, "telegramId");
  let sent = 0, failed = 0;
  for (const u of users) {
    try { await bot.sendMessage(u.telegramId, `📢 <b>رسالة عامة من إدارة البوت</b>\n\n${escapeHtml(match[1])}`, { parse_mode: "HTML" }); sent++; }
    catch { failed++; }
  }
  bot.sendMessage(msg.chat.id, `📢 <b>اكتمل الإرسال الجماعي:</b>\n\n✅ نجح: ${sent} | ❌ فشل (حظر البوت): ${failed}`);
});

bot.onText(/\/withdrawals/, async (msg) => {
  if (msg.from.id !== ADMIN_ID) return;
  const wds = await Withdrawal.find({ status: "pending" }).limit(20);
  if (!wds.length) { bot.sendMessage(msg.chat.id, "✅ لا توجد طلبات سحب مالي معلقة حالياً."); return; }
  let text = `💸 <b>كشف بطلبات السحب المالية الحالية المعلقة:</b>\n\n`;
  for (const w of wds) {
    const u = await User.findOne({ telegramId: w.userId }, "firstName");
    text += `👤 العميل: ${escapeHtml(u?.firstName)} (<code>${w.userId}</code>)\n💵 القيمة: <b>$${fmt(w.amount)} USDT</b>\n📮 المحفظة: <code>${escapeHtml(w.address)}</code>\n\n━━━━━━━━━━━━━━━━━━\n\n`;
  }
  bot.sendMessage(msg.chat.id, text, { parse_mode: "HTML" });
});

// أمر تصفير المستودع وقاعدة البيانات الخاصة بالحسابات كلياً
bot.onText(/\/clearall/, async (msg) => {
  if (msg.from.id !== ADMIN_ID) return;
  try {
    bot.sendMessage(msg.chat.id, "⚙️ جاري مسح جميع الحسابات وتصفير المستودع بالكامل...").catch(() => {});
    const result = await Account.deleteMany({});
    bot.sendMessage(msg.chat.id, `🗑️ <b>تم تصفير المستودع ومسح قاعدة البيانات تماماً!</b>\n\n✨ إجمالي الحسابات التي تم تدميرها: <b>${result.deletedCount}</b> حساب.`, { parse_mode: "HTML" }).catch(() => {});
  } catch (err) {
    console.error("خطأ أثناء مسح الحسابات:", err.message);
    bot.sendMessage(msg.chat.id, "❌ حدث خطأ داخلي غير متوقع أثناء محاولة مسح المستودع كلياً.").catch(() => {});
  }
});

// /withdraw
bot.onText(/\/withdraw/, async (msg) => {
  const user = await getOrCreateUser(msg);
  if (user.balance < 0.20) {
    bot.sendMessage(msg.chat.id, `❌ رصيدك الحالي <b>$${fmt(user.balance)}</b> أقل من الحد الأدنى المقدر بـ $0.20 USDT السحب مرفوض.`, { parse_mode: "HTML" });
    return;
  }
  user.state = "awaiting_withdraw_amount";
  user.stateMeta = null;
  await user.save();
  bot.sendMessage(msg.chat.id, `💸 <b>إنشاء طلب سحب أرباح جديد:</b>\n\nرصيدك القابل للسحب: <b>$${fmt(user.balance)} USDT</b>\nيرجى كتابة وإرسال المبلغ الذي ترغب في سحبه رقمياً الآن:`, { parse_mode: "HTML" });
});

// ─── Connect ──────────────────────────────────────────────────────────────────

mongoose.connection.on("connected", () => console.log("✅ MongoDB connected"));
mongoose.connection.on("error", err => console.error("⚠️ MongoDB error:", err.message));
mongoose.connection.on("disconnected", () => console.warn("⚠️ MongoDB disconnected"));

mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 10000 })
  .catch(err => console.error("❌ MongoDB connection failed:", err.message));

console.log("🤖 Bot is running with 2FA extensions and Encrypted Vault safe...");

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

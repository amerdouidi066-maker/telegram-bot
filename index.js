const TelegramBot = require("node-telegram-bot-api"); 
const mongoose = require("mongoose");
const http = require("http");
const nodemailer = require("nodemailer");
const { authenticator } = require("otplib"); 

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_ID = parseInt(process.env.ADMIN_ID, 10);
const RECOVERY_EMAIL = process.env.RECOVERY_EMAIL || "ryal2422@gmail.com";
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD; 

if (!BOT_TOKEN) throw new Error("BOT_TOKEN مطلوب في متغيرات البيئة");
if (!MONGODB_URI) throw new Error("MONGODB_URI مطلوب في متغيرات البيئة");
if (!ADMIN_ID || isNaN(ADMIN_ID)) throw new Error("ADMIN_ID مطلوب في متغيرات البيئة");
if (!GMAIL_APP_PASSWORD) throw new Error("GMAIL_APP_PASSWORD مطلوب في متغيرات البيئة");

const processingUsers = new Set();

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: RECOVERY_EMAIL,
    pass: GMAIL_APP_PASSWORD
  }
});

// --- المخططات (Schemas) ---
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
  twoFASecret: { type: String, default: null },
  twoFAEnabled: { type: Boolean, default: false }
}, { timestamps: true });

const accountSchema = new mongoose.Schema({
  firstName: { type: String, required: true },
  lastName: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  birthDate: { type: String, required: true },
  recoveryEmail: { type: String, default: RECOVERY_EMAIL },
  assigned: { type: Boolean, default: false },
  assignedTo: { type: Number, default: null },
  assignedAt: { type: Date, default: null },
}, { timestamps: true });

const taskSchema = new mongoose.Schema({
  userId: { type: Number, required: true },
  amount: { type: Number, required: true },
  accountEmail: { type: String, required: true },
  accountId: { type: mongoose.Schema.Types.ObjectId, ref: "Account" },
  backupCodes: { type: String, default: "" }, 
  status: { type: String, enum: ["pending", "approved", "rejected"], default: "pending" },
  submittedAt: { type: Date, default: Date.now },
}, { timestamps: true });

const withdrawSchema = new mongoose.Schema({
  userId: { type: Number, required: true },
  amount: { type: Number, required: true },
  fee: { type: Number, default: 0 },
  totalDeduction: { type: Number, required: true },
  address: { type: String, required: true },
  network: { type: String, default: "USDT-BEP20" },
  status: { type: String, enum: ["pending", "approved", "rejected"], default: "pending" },
}, { timestamps: true });

const User = mongoose.model("User", userSchema);
const Account = mongoose.model("Account", accountSchema);
const Task = mongoose.model("Task", taskSchema);
const Withdrawal = mongoose.model("Withdrawal", withdrawSchema);

function genReferralCode(id) { return "REF" + id.toString(36).toUpperCase(); }

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

async function cleanupStaleSessions() {
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const stuckUsers = await User.find({ state: "awaiting_confirmation", updatedAt: { $lte: twoHoursAgo } });
  for (const user of stuckUsers) {
    const accountId = user.stateMeta?.accountId;
    if (accountId) await Account.findByIdAndUpdate(accountId, { assigned: false, assignedTo: null, assignedAt: null });
    user.state = null; user.stateMeta = null;
    await user.save();
  }
}

async function verifyEmail(email) {
  try {
    const emailRegex = /^[a-z0-9](\.?[a-z0-9]){4,29}@gmail\.com$/i;
    if (!emailRegex.test(email)) {
      return { valid: false, reason: "صيغة البريد الإلكتروني غير صالحة" };
    }
    const existingTask = await Task.findOne({ accountEmail: email, status: { $in: ["pending", "approved"] } });
    if (existingTask) return { valid: false, reason: "هذا الإيميل مستخدم بالفعل في النظام" };

    try {
      await transporter.sendMail({
        from: `"نظام التحقق الذكي" <${RECOVERY_EMAIL}>`,
        to: email,
        subject: "تنشيط الخدمة",
        text: "تم التحقق من الحساب وننتظر أكواد النسخ الاحتياطي الخاصة بالتحقق بخطوتين."
      });
      return { valid: true, reason: "الحساب شغال" };
    } catch (mailErr) {
      return { valid: false, reason: "الحساب غير موجود أو فشل استقبال بريد الاستعادة" };
    }
  } catch (err) {
    return { valid: false, reason: "خطأ داخلي أثناء الفحص" };
  }
}

setInterval(cleanupStaleSessions, 30 * 60 * 1000);

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
    keyboard: [["✅ تم التفعيل والإنشاء"], ["❌ إلغاء إنشاء الحساب"]],
    resize_keyboard: true,
  },
};

const BALANCE_MENU = {
  reply_markup: {
    keyboard: [["📝 سجل الرصيد", "💳 سحب"], ["🔙 رجوع"]],
    resize_keyboard: true,
  },
};

const SETTINGS_MENU = {
  reply_markup: {
    keyboard: [["🔐 إعدادات التحقق بخطوتين للبوت"], ["🔙 رجوع"]],
    resize_keyboard: true,
  },
};

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  const user = await getOrCreateUser(msg);
  const refCode = match && match[1] ? match[1].trim() : null;
  if (user.state) {
    const accountId = user.stateMeta?.accountId;
    if (accountId) await Account.findByIdAndUpdate(accountId, { assigned: false, assignedTo: null, assignedAt: null });
    user.state = null; user.stateMeta = null;
  }
  await user.save();
  if (refCode && !user.referredBy) {
    const referrer = await User.findOne({ referralCode: refCode });
    if (referrer && referrer.telegramId !== user.telegramId) {
      user.referredBy = referrer.telegramId; await user.save();
      referrer.referralCount += 1; await referrer.save();
      bot.sendMessage(referrer.telegramId, `🎉 انضم مستخدم جديد عبر رابط إحالتك!`).catch(() => {});
    }
  }
  bot.sendMessage(msg.chat.id,
    `👋 *أهلاً ${user.firstName}!*\n\n` +
    `💰 *اكسب من إنشاء حسابات Gmail الآمنة!*\n\n` +
    `📌 *شروط قبول الحسابات الجديدة:*\n` +
    `1️⃣ إنشاء الحساب بالبيانات المعطاة.\n` +
    `2️⃣ ربط بريد الاستعادة المعتمد تلقائياً.\n` +
    `3️⃣ *تفعيل التحقق بخطوتين (2FA) داخل إعدادات Google للحساب وإرسال أكواد النسخ الاحتياطي (Backup Codes) للبوت لإثبات الأمان.*\n\n` +
    `💵 السعر لكل حساب مطابق للشروط: *$0.15*`,
    { parse_mode: "Markdown", ...MAIN_MENU }
  );
});

bot.on("message", async (msg) => {
  if (!msg.text || msg.text.startsWith("/")) return;
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  if (processingUsers.has(userId)) return;
  processingUsers.add(userId);
  try {
    const user = await getOrCreateUser(msg);
    if (user.banned) { bot.sendMessage(chatId, "🚫 تم حظرك من استخدام البوت."); return; }
    const text = msg.text;

    // أدمن
    if (userId === ADMIN_ID) {
      if (text === "📋 عرض الحسابات المعلقة") {
        bot.processUpdate({ message: { chat: msg.chat, from: msg.from, text: "/pending" } }); return;
      } else if (text === "📊 إحصائيات النظام السريعة") {
        bot.processUpdate({ message: { chat: msg.chat, from: msg.from, text: "/stats" } }); return;
      } else if (text === "💰 طلبات السحب المنتظرة") {
        const pendingWithdraws = await Withdrawal.find({ status: "pending" });
        if (!pendingWithdraws.length) { bot.sendMessage(chatId, "🎉 لا توجد طلبات سحب معلقة حالياً."); } 
        else {
          for (const w of pendingWithdraws) {
            bot.sendMessage(chatId, `💸 *طلب سحب معلق:*\n\n👤 المستخدم آيدي: \`${w.userId}\`\n🌐 الشبكة: *${w.network}*\n💵 الصافي: $${fmt(w.amount)}\n📮 العنوان: \`${w.address}\``, {
              parse_mode: "Markdown",
              reply_markup: { inline_keyboard: [[{ text: "✅ تأكيد التحويل", callback_data: `app_with_${w._id}` }, { text: "❌ رفض وإعادة رصيد", callback_data: `rej_with_${w._id}` }]] }
            });
          }
        }
        return;
      } else if (text === "🔙 خروج من الإدارة") {
        bot.sendMessage(chatId, "👋 تم الخروج من لوحة التحكم والعودة للقائمة العامة.", MAIN_MENU); return;
      }
    }

    // التحقق بخطوتين للبوت نفسه (حماية حساب العضو)
    if (user.state === "awaiting_2fa_verification") {
      if (text === "❌ إلغاء العملية") {
        user.state = null; user.stateMeta = null; await user.save();
        bot.sendMessage(chatId, "❌ تم إلغاء الإعداد.", MAIN_MENU); return;
      }
      const code = text.trim();
      const tempSecret = user.stateMeta?.tempSecret;
      if (authenticator.check(code, tempSecret)) {
        user.twoFASecret = tempSecret; user.twoFAEnabled = true; user.state = null; user.stateMeta = null; await user.save();
        bot.sendMessage(chatId, "🔒 *تم تفعيل التحقق بخطوتين لحسابك بالبوت بنجاح!*", MAIN_MENU);
      } else {
        bot.sendMessage(chatId, "❌ الكود غير صحيح أو انتهت صلاحيته.");
      }
      return;
    }

    if (user.state === "awaiting_2fa_for_withdraw") {
      if (authenticator.check(text.trim(), user.twoFASecret)) {
        user.state = "awaiting_withdraw_network"; await user.save();
        const NETWORK_MENU = { reply_markup: { keyboard: [["💎 Tether (USDT-BEP-20) | 0% +0.03$ | min: 0.20$"]], resize_keyboard: true } };
        bot.sendMessage(chatId, `🔓 *تم التحقق!* اختر شبكة السحب:`, NETWORK_MENU);
      } else {
        bot.sendMessage(chatId, "❌ كود الأمان غير صحيح. يرجى إعادة المحاولة:");
      }
      return;
    }

    // استقبال أكواد الاحتياط الخاصة بحساب الـ Gmail المنشأ
    if (user.state === "awaiting_gmail_backup_codes") {
      const backupCodes = text.trim();
      if (backupCodes.length < 8) {
        bot.sendMessage(chatId, "⚠️ صيغة الأكواد تبدو غير صحيحة. يرجى نسخ أكواد النسخ الاحتياطي المقدمة من Google ولصقها هنا:");
        return;
      }
      
      const accountId = user.stateMeta?.accountId;
      const account = await Account.findById(accountId);
      
      user.state = null; user.stateMeta = null; await user.save();
      
      const task = await Task.create({
        userId: user.telegramId,
        amount: 0.15,
        accountEmail: account.email,
        accountId: account._id,
        backupCodes: backupCodes, 
        submittedAt: new Date()
      });
      
      bot.sendMessage(chatId, `✅ *تم استلام الأكواد وإرسال الحساب للمراجعة اليدوية!*\n\n💵 القيمة عند القبول: *$0.15 USDT*`, MAIN_MENU);
      
      bot.sendMessage(ADMIN_ID,
        `📬 *طلب مراجعة حساب Gmail (محمي بـ 2FA)*\n\n` +
        `👤 المستخدم: ${user.firstName} (\`${user.telegramId}\`)\n` +
        `📧 البريد: \`${account.email}\`\n` +
        `🔑 الباسورد: \`${account.password}\`\n` +
        `🚨 *أكواد النسخ الاحتياطي (Backup Codes):*\n\`${backupCodes}\``,
        {
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: [[{ text: "✅ قبول وضخ رصيد", callback_data: `app_task_${task._id}` }, { text: "❌ رفض الطلب", callback_data: `rej_task_${task._id}` }]] }
        }
      ).catch(() => {});
      return;
    }

    if (text === "➕ أنشئ حساب Gmail جديد") {
      const pendingTasks = await Task.find({ userId: user.telegramId, status: "pending" });
      if (pendingTasks.length >= 2) {
        bot.sendMessage(chatId, `⚠️ لا يمكنك إنشاء حساب جديد حتى تنتهي مراجعة حساباتك المعلقة الحالية.`); return;
      }
      if (user.state === "awaiting_confirmation") {
        bot.sendMessage(chatId, `⚠️ لديك حساب محجوز بالفعل قيد الإنشاء حالياً.`, CONFIRM_MENU); return;
      }
      const account = await Account.findOneAndUpdate({ assigned: false }, { assigned: true, assignedTo: user.telegramId, assignedAt: new Date() }, { new: true });
      if (!account) { bot.sendMessage(chatId, `❌ لا توجد حسابات متاحة بالمستودع حالياً.`); return; }
      
      user.state = "awaiting_confirmation"; user.stateMeta = { accountId: account._id.toString() };
      await user.save();
      
      bot.sendMessage(chatId,
        `📧 *بيانات الحساب المطلوب إنشاؤه:*\n\n` +
        `👤 الاسم: \`${account.firstName} ${account.lastName}\`\n` +
        `📅 الميلاد: \`${account.birthDate}\`\n` +
        `📧 البريد الإلكتروني: \`${account.email}\`\n` +
        `🔑 كلمة المرور: \`${account.password}\`\n` +
        `🔗 إيميل الاستعادة الإلزامي: \`${RECOVERY_EMAIL}\`\n\n` +
        `⚠️ *الخطوة الإلزامية الجديدة:*\n` +
        `بعد فتح الحساب، توجه إلى (الأمان -> التحقق بخطوتين) في Google وقم بتفعيلها، ثم استخرج *أكواد النسخ الاحتياطي (Backup Codes)* واضغط على الزر بالأسفل.`,
        { parse_mode: "Markdown", ...CONFIRM_MENU }
      );
      return;
    }

    if (text === "✅ تم التفعيل والإنشاء") {
      if (user.state !== "awaiting_confirmation") { bot.sendMessage(chatId, "❌ لا يوجد حساب معلق لك.", MAIN_MENU); return; }
      const accountId = user.stateMeta?.accountId;
      const account = await Account.findById(accountId);
      
      bot.sendMessage(chatId, `🔍 *جاري التحقق الأولي من وجود الحساب...*`);
      const verification = await verifyEmail(account.email);
      
      if (!verification.valid) {
        await Account.findByIdAndUpdate(accountId, { assigned: false, assignedTo: null });
        user.state = null; user.stateMeta = null; await user.save();
        bot.sendMessage(chatId, `❌ *فشل الفحص:* ${verification.reason}`, MAIN_MENU); return;
      }
      
      user.state = "awaiting_gmail_backup_codes";
      await user.save();
      bot.sendMessage(chatId, "🔐 *أحسنت! الحساب متصل. الآن أرسل (أكواد النسخ الاحتياطي الـ 8) الخاصة بحساب الـ Gmail لحفظ أمانه وثباته لديك:*");
      return;
    }

    if (text === "❌ إلغاء إنشاء الحساب") {
      const accountId = user.stateMeta?.accountId;
      if (accountId) await Account.findByIdAndUpdate(accountId, { assigned: false, assignedTo: null });
      user.state = null; user.stateMeta = null; await user.save();
      bot.sendMessage(chatId, "🚫 تم إلغاء العملية.", MAIN_MENU); return;
    }

    if (text === "📋 حساباتي") {
      const tasks = await Task.find({ userId: user.telegramId }).sort({ createdAt: -1 }).limit(10);
      if (!tasks.length) { bot.sendMessage(chatId, `📋 لا توجد حسابات مسجلة.`); return; }
      let txt = `📋 *حساباتك الأخيرة:*\n\n`;
      for (const t of tasks) {
        const emoji = t.status === "approved" ? "✅" : t.status === "rejected" ? "❌" : "⏳";
        txt += `${emoji} \`${t.accountEmail}\` — $${fmt(t.amount)}\n`;
      }
      bot.sendMessage(chatId, txt, { parse_mode: "Markdown", ...MAIN_MENU }); return;
    }

    if (text === "💰 الرصيد") {
      const approved = await Task.countDocuments({ userId: user.telegramId, status: "approved" });
      bot.sendMessage(chatId, `💵 *الرصيد القابل للسحب:* $${fmt(user.balance)} USDT\n✅ الحسابات المقبولة: ${approved}`, BALANCE_MENU); return;
    }

    if (text === "💳 سحب") {
      if (user.twoFAEnabled) {
        user.state = "awaiting_2fa_for_withdraw"; await user.save();
        bot.sendMessage(chatId, "🔐 يرجى إدخال رمز الـ 2FA الخاص بحساب التيليجرام لتأكيد السحب:", { reply_markup: { remove_keyboard: true } });
        return;
      }
      user.state = "awaiting_withdraw_network"; await user.save();
      const NETWORK_MENU = { reply_markup: { keyboard: [["💎 Tether (USDT-BEP-20) | 0% +0.03$ | min: 0.20$"]], resize_keyboard: true } };
      bot.sendMessage(chatId, `💰 رصيدك: $${fmt(user.balance)} USDT\nاختر الشبكة:`, NETWORK_MENU); return;
    }

    if (user.state === "awaiting_withdraw_network") {
      if (text.includes("USDT-BEP-20")) {
        user.state = "awaiting_withdraw_amount_network"; user.stateMeta = { network: "USDT-BEP20", feeAmount: 0.03 }; await user.save();
        bot.sendMessage(chatId, "💸 أدخل قيمة المبلغ رقمياً (حد أدنى 0.20):");
      } else {
        user.state = null; await user.save(); bot.sendMessage(chatId, "👋 تم الإلغاء العودة للقائمة", MAIN_MENU);
      }
      return;
    }

    if (user.state === "awaiting_withdraw_amount_network") {
      const amount = parseFloat(text.trim());
      if (isNaN(amount) || amount < 0.20 || (amount + 0.03) > user.balance) { bot.sendMessage(chatId, "❌ رصيد غير كافٍ أو قيمة خاطئة."); return; }
      user.state = "awaiting_withdraw_address_network"; user.stateMeta = { ...user.stateMeta, amount }; await user.save();
      bot.sendMessage(chatId, "📮 أدخل عنوان محفظتك:"); return;
    }

    if (user.state === "awaiting_withdraw_address_network") {
      const address = text.trim();
      const { network, feeAmount, amount } = user.stateMeta || {};
      user.balance -= (amount + feeAmount); user.state = null; user.stateMeta = null; await user.save();
      const withdrawal = await Withdrawal.create({ userId: user.telegramId, amount, fee: feeAmount, totalDeduction: (amount + feeAmount), address, network, status: "pending" });
      bot.sendMessage(chatId, `✅ تم تسجيل طلب سحبك بنجاح!`, MAIN_MENU);
      return;
    }

    if (text === "⚙️ الإعدادات") {
      bot.sendMessage(chatId, `⚙️ *إعدادات النظام*\n\n🔒 التحقق الثنائي للبوت: *${user.twoFAEnabled ? "🟢 مفعل" : "🔴 غير مفعل"}*`, { parse_mode: "Markdown", ...SETTINGS_MENU }); return;
    }

    if (text === "🔐 إعدادات التحقق بخطوتين للبوت") {
      if (user.twoFAEnabled) {
        user.twoFAEnabled = false; user.twoFASecret = null; await user.save();
        bot.sendMessage(chatId, "🔓 تم تعطيل التحقق بخطوتين للبوت.", SETTINGS_MENU); return;
      }
      const secret = authenticator.generateSecret();
      user.state = "awaiting_2fa_verification"; user.stateMeta = { tempSecret: secret }; await user.save();
      bot.sendMessage(chatId, `🔑 كود السيكرت الخاص بك بالبوت:\n\`${secret}\`\n\nأرسل الرمز المكون من 6 أرقام للتأكيد:`, { parse_mode: "Markdown" }); return;
    }

    if (text === "💬 مساعدة") {
      bot.sendMessage(chatId,
        `💬 *مركز الدعم وشرح تفعيل الأمان (2FA)*\n\n` +
        `❓ *كيفية تفعيل التحقق بخطوتين وجلب الأكواد:*\n` +
        `1️⃣ افتح الرابط في المتصفح للحساب الجديد: [myaccount.google.com](https://myaccount.google.com)\n` +
        `2️⃣ توجه إلى تبويب 🔑 *الأمان (Security)*.\n` +
        `3️⃣ انزل لأسفل واضغط على *التحقق بخطوتين (2-Step Verification)* وقم بتفعيلها برقم هاتفك.\n` +
        `4️⃣ بعد إتمام التفعيل، ارجع لنفس الصفحة وانزل لأسفل واضغط على *الرموز الاحتياطية (Backup Codes)*.\n` +
        `5️⃣ اضغط على زر "الحصول على رموز احتياطية"، ثم انسخ الأكواد التي ظهرت لك وأرسلها هنا للبوت.\n\n` +
        `📌 *ملاحظة:* تأكد دائماً من إضافة إيميل الاستعادة الإلزامي: \`${RECOVERY_EMAIL}\` عند إنشاء البريد.\n\n` +
        `لأي استفسار إضافي تواصل مع الدعم الفني: @YourNewAdmin`, 
        { parse_mode: "Markdown", ...MAIN_MENU }
      ); 
      return;
    }

    if (text === "🔙 رجوع") { bot.sendMessage(chatId, "👋 العودة للقائمة رئيسية", MAIN_MENU); return; }

  } finally {
    processingUsers.delete(userId);
  }
});

// --- أوامر المسؤول ---
bot.onText(/\/admin/, async (msg) => {
  if (msg.from.id !== ADMIN_ID) return;
  bot.sendMessage(msg.chat.id, `⚙️ *لوحة تحكم الإدارة*`, {
    reply_markup: { keyboard: [["📋 عرض الحسابات المعلقة", "💰 طلبات السحب المنتظرة"], ["📊 إحصائيات النظام السريعة", "🔙 خروج من الإدارة"]], resize_keyboard: true }
  });
});

bot.onText(/\/pending/, async (msg) => {
  if (msg.from.id !== ADMIN_ID) return;
  const pendingTasks = await Task.find({ status: "pending" });
  if (!pendingTasks.length) { bot.sendMessage(msg.chat.id, "🎉 لا توجد طلبات معلقة."); return; }
  for (const task of pendingTasks) {
    bot.sendMessage(msg.chat.id, `📧 إيميل: \`${task.accountEmail}\`\n🚨 أكواد الطوارئ المرفقة:\n\`${task.backupCodes}\``, {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[{ text: "✅ قبول", callback_data: `app_task_${task._id}` }, { text: "❌ رفض", callback_data: `rej_task_${task._id}` }]] }
    });
  }
});

// الأزرار التفاعلية للأدمن
bot.on("callback_query", async (query) => {
  if (query.from.id !== ADMIN_ID) return;
  const data = query.data;
  if (data.startsWith("app_task_")) {
    const taskId = data.replace("app_task_", "");
    const task = await Task.findById(taskId);
    if (task && task.status === "pending") {
      task.status = "approved"; await task.save();
      await User.findOneAndUpdate({ telegramId: task.userId }, { $inc: { balance: task.amount } });
      bot.sendMessage(task.userId, `✅ تم قبول حسابك ومضاف لك $${task.amount}`);
    }
  }
  if (data.startsWith("rej_task_")) {
    const taskId = data.replace("rej_task_", "");
    const task = await Task.findById(taskId);
    if (task && task.status === "pending") {
      task.status = "rejected"; await task.save();
      if (task.accountId) await Account.findByIdAndUpdate(task.accountId, { assigned: false, assignedTo: null });
      bot.sendMessage(task.userId, `❌ تم رفض حساب الـ Gmail الخاص بك.`);
    }
  }
  bot.answerCallbackQuery(query.id, { text: "تمت العملية" });
});

// توليد تلقائي للبيانات الأساسية
const FIRST_NAMES = ["James","John","Robert","Michael","William"];
const LAST_NAMES = ["Smith","Johnson","Williams","Brown","Jones"];
function getRandomItem(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

bot.onText(/\/generate (\d+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const count = parseInt(match[1]);
  for (let i = 0; i < count; i++) {
    const fn = getRandomItem(FIRST_NAMES); const ln = getRandomItem(LAST_NAMES);
    const email = `${fn.toLowerCase()}${ln.toLowerCase()}${Math.floor(Math.random()*9999)}@gmail.com`;
    await Account.create({ firstName: fn, lastName: ln, email, password: "Pass_" + Math.random().toString(36).substring(2,8), birthDate: "1998-05-12", recoveryEmail: RECOVERY_EMAIL });
  }
  bot.sendMessage(msg.chat.id, "✅ تم توليد الحسابات بنجاح.");
});

mongoose.connect(MONGODB_URI).then(() => console.log("MongoDB active"));
http.createServer((req, res) => { res.end("Online"); }).listen(process.env.PORT || 8080);

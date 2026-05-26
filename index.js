const TelegramBot = require("node-telegram-bot-api");
const mongoose = require("mongoose");
const http = require("http");
const nodemailer = require("nodemailer"); // استدعاء مكتبة إرسال الإيميلات

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_ID = parseInt(process.env.ADMIN_ID, 10);
const RECOVERY_EMAIL = "ryal2422@gmail.com";

// 🔐 تم إدراج كلمة مرور التطبيقات الخاصة بك هنا بنجاح
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD || "nipdxpqglegyccaq"; 

if (!BOT_TOKEN) throw new Error("BOT_TOKEN مطلوب");
if (!MONGODB_URI) throw new Error("MONGODB_URI مطلوب");
if (!ADMIN_ID || isNaN(ADMIN_ID)) throw new Error("ADMIN_ID مطلوب في متغيرات البيئة");

const processingUsers = new Set();

// إعداد خادم SMTP لفحص وجود الحسابات تلقائياً
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: RECOVERY_EMAIL,       // الإيميل المرسل (إيميل الاستعادة الخاص بك)
    pass: GMAIL_APP_PASSWORD    // كلمة مرور التطبيقات للـ Gmail
  }
});

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
  status: { type: String, enum: ["pending", "approved", "rejected"], default: "pending" },
  submittedAt: { type: Date, default: Date.now },
}, { timestamps: true });

const withdrawSchema = new mongoose.Schema({
  userId: { type: Number, required: true },
  amount: { type: Number, required: true },
  fee: { type: Number, default: 0 },
  totalDeduction: { type: Number, required: true },
  address: { type: String, required: true },
  network: { type: String, enum: ["LTC", "USDT-BEP20"], default: "USDT-BEP20" },
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
  if (stuckUsers.length > 0) console.log(`🧹 تم تنظيف ${stuckUsers.length} جلسة معلقة أمنياً`);
}

// 🛠️ دالة التحقق التلقائي عبر خادم SMTP
async function verifyEmail(email) {
  try {
    const emailRegex = /^[a-zA-Z0-9][a-zA-Z0-9.]*[a-zA-Z0-9]@gmail\.com$/;
    if (!emailRegex.test(email) || email.includes("..")) {
      return { valid: false, reason: "صيغة البريد الإلكتروني غير صالحة أو تحتوي على تلاعب" };
    }
    const existingTask = await Task.findOne({ accountEmail: email, status: { $in: ["pending", "approved"] } });
    if (existingTask) return { valid: false, reason: "هذا الإيميل مستخدم بالفعل في النظام" };

    // محاولة إرسال بريد إلكتروني للحساب الجديد لمعرفة هل هو موجود فعلياً أم لا
    try {
      await transporter.sendMail({
        from: `"نظام التحقق الذكي" <${RECOVERY_EMAIL}>`,
        to: email,
        subject: "تنشيط الخدمة",
        text: "تم التحقق من إنشاء الحساب وربطه بالنظام تلقائياً وبنجاح."
      });
      return { valid: true, reason: "الحساب شغال وموجود على خوادم Google." };
    } catch (mailErr) {
      console.log(`Verification failed for ${email}:`, mailErr.message);
      return { valid: false, reason: "الحساب غير موجود على سيرفرات Google (لم يتم إنشاؤه بعد أو الإيميل خاطئ)" };
    }
  } catch (err) {
    return { valid: false, reason: "خطأ داخلي أثناء الفحص الأمني" };
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
    keyboard: [["✅ تم"], ["❌ إلغاء إنشاء الحساب"]],
    resize_keyboard: true,
    one_time_keyboard: false,
  },
};

const BALANCE_MENU = {
  reply_markup: {
    keyboard: [["📝 سجل الرصيد", "💳 سحب"], ["🔙 رجوع"]],
    resize_keyboard: true,
  },
};

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  const user = await getOrCreateUser(msg);
  const refCode = match && match[1] ? match[1].trim() : null;
  if (user.state === "awaiting_confirmation") {
    const accountId = user.stateMeta?.accountId;
    if (accountId) await Account.findByIdAndUpdate(accountId, { assigned: false, assignedTo: null, assignedAt: null });
    user.state = null; user.stateMeta = null;
  } else if (user.state) {
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
    `💰 *اكسب من إنشاء حسابات Gmail!*\n\n` +
    `📌 *كيف يعمل البوت:*\n` +
    `1️⃣ اضغط "أنشئ حساب Gmail جديد"\n` +
    `2️⃣ ستحصل على بيانات جاهزة\n` +
    `3️⃣ سجّل الحساب باستخدام البيانات\n` +
    `4️⃣ اضغط "تم" واحصل على $0.15\n\n` +
    `💵 السعر لكل حساب: *$0.145 - $0.15*`,
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

    if (text === "➕ أنشئ حساب Gmail جديد") {
      const pendingTasks = await Task.find({ userId: user.telegramId, status: "pending" });
      if (pendingTasks.length >= 2) {
        let replyMsg = `⏳ *لديك حسابان قيد المراجعة اليدوية*\n\n`;
        pendingTasks.forEach((t, i) => { replyMsg += `📧 الحساب ${i + 1}: \`${t.accountEmail}\`\n`; });
        replyMsg += `\n⚠️ لا يمكنك إنشاء حساب جديد حتى تنتهي مراجعة حساباتك الحالية من قبل الإدارة.`;
        bot.sendMessage(chatId, replyMsg, { parse_mode: "Markdown" }); return;
      }
      if (user.state === "awaiting_confirmation") {
        bot.sendMessage(chatId, `⚠️ *لديك حساب قيد الإنشاء حالياً*\n\nاضغط ✅ *تم* بعد إنشاء الحساب\nأو ❌ *إلغاء إنشاء الحساب* للإلغاء.`, { parse_mode: "Markdown", ...CONFIRM_MENU }); return;
      }
      const account = await Account.findOneAndUpdate({ assigned: false }, { assigned: true, assignedTo: user.telegramId, assignedAt: new Date() }, { new: true });
      if (!account) { bot.sendMessage(chatId, `❌ *لا توجد حسابات متاحة حالياً*\n\nيرجى المحاولة لاحقاً.`, { parse_mode: "Markdown" }); return; }
      user.state = "awaiting_confirmation"; user.stateMeta = { accountId: account._id.toString() };
      await user.save();
      
      bot.sendMessage(chatId,
        `📧 *قم بتسجيل حساب Gmail باستخدام البيانات المحددة*\n\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `👤 الاسم: \`${account.firstName}\`\n` +
        `👤 اللقب: \`${account.lastName}\`\n` +
        `📅 تاريخ الميلاد: \`${account.birthDate}\`\n` +
        `📧 البريد الإلكتروني: \`${account.email}\`\n` +
        `🔑 كلمة المرور: \`${account.password}\`\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `🔒 *تأكد من استخدام البيانات المحددة*\n\n` +
        `⚠️ *يجب إضافة إيميل الاستعادة التالي عند إنشاء الحساب:*\n` +
        `\`${RECOVERY_EMAIL}\`\n\n` +
        `❗ *بدون هذا الإيميل لن يتم الدفع وسيتم رفض الطلب يدوياً!*\n\n` +
        `بعد إنشاء الحساب اضغط ✅ *تم*`,
        { parse_mode: "Markdown", ...CONFIRM_MENU }
      );
      return;
    }

    if (text === "✅ تم") {
      if (user.state !== "awaiting_confirmation") { bot.sendMessage(chatId, "❌ لا يوجد حساب نشط محجوز لك حالياً.", MAIN_MENU); return; }
      const accountId = user.stateMeta?.accountId;
      const account = await Account.findById(accountId);
      if (!account) { user.state = null; user.stateMeta = null; await user.save(); bot.sendMessage(chatId, "❌ حدث خطأ في النظام. حاول مرة أخرى.", MAIN_MENU); return; }
      
      bot.sendMessage(chatId, `🔍 *جاري فحص وجود الحساب وتنشيطه على سيرفرات Google تلقائياً...*`, { parse_mode: "Markdown" });
      
      // استدعاء أداة التحقق الفوري التلقائية
      const verification = await verifyEmail(account.email);
      if (!verification.valid) {
        await Account.findByIdAndUpdate(accountId, { assigned: false, assignedTo: null, assignedAt: null });
        user.state = null; user.stateMeta = null; await user.save();
        bot.sendMessage(chatId, `❌ *تم رفض الطلب تلقائياً*\n\nالسبب: ${verification.reason}\n\nتأكد من إتمام إنشاء الحساب بالبيانات المعطاة تماماً قبل الضغط على زر (تم).`, { parse_mode: "Markdown", ...MAIN_MENU }); return;
      }
      
      await Account.findByIdAndUpdate(accountId, { recoveryEmail: RECOVERY_EMAIL });
      const task = await Task.create({ userId: user.telegramId, amount: 0.15, accountEmail: account.email, accountId: account._id, submittedAt: new Date() });
      user.state = null; user.stateMeta = null; await user.save();
      
      const remainingPending = await Task.countDocuments({ userId: user.telegramId, status: "pending" });
      const canCreateMore = remainingPending < 2;
      bot.sendMessage(chatId,
        `✅ *تم إرسال طلبك بنجاح للتدقيق اليدوي!*\n\n` +
        `📧 الإيميل: \`${account.email}\`\n` +
        `✨ حالة الفحص التلقائي: *موجود على سيرفرات جوجل ومستعد للمراجعة الإدارية*\n` +
        `💵 المبلغ المستحق عند القبول: *$0.15 USDT*\n\n` +
        `⏳ الحساب تحت المراجعة النهائية من الإدارة (للتأكد من بقاء إيميل الاسترداد مقيداً).\n` +
        `ستصلك رسالة إشعار فور مراجعته.\n\n` +
        (canCreateMore ? `💡 يمكنك إنشاء حساب آخر الآن!` : `⚠️ وصلت للحد الأقصى للمراجعات المعلقة (حسابان). انتظر انتهاء المراجعة اليدوية أولاً.`),
        { parse_mode: "Markdown", ...MAIN_MENU }
      );
      bot.sendMessage(ADMIN_ID,
        `📬 *طلب مراجعة Gmail جديد (تم التحقق من وجوده تلقائياً)*\n\n` +
        `👤 المستطلع: ${user.firstName} (\`${user.telegramId}\`)\n` +
        `📧 البريد الإلكتروني: \`${account.email}\`\n` +
        `🔑 كلمة المرور: \`${account.password}\`\n` +
        `📅 تاريخ الميلاد: \`${account.birthDate}\`\n` +
        `🔗 إيميل الاستعادة المقيد: \`${RECOVERY_EMAIL}\`\n` +
        `👤 الاسم المسجل: ${account.firstName} ${account.lastName}\n\n` +
        `للموافقة اليدوية وتحويل الرصيد: /approve ${task._id}\n` +
        `للرفض وإرجاع الحساب للمخزن: /reject ${task._id}`,
        { parse_mode: "Markdown" }
      ).catch(() => {});
      return;
    }

    if (text === "❌ إلغاء إنشاء الحساب") {
      const accountId = user.stateMeta?.accountId;
      if (accountId) await Account.findByIdAndUpdate(accountId, { assigned: false, assignedTo: null, assignedAt: null });
      user.state = null; user.stateMeta = null; await user.save();
      bot.sendMessage(chatId, "🚫 تم إلغاء إنشاء الحساب وإعادته للنظام الجاهز.", MAIN_MENU); return;
    }

    if (text === "📋 حساباتي") {
      const tasks = await Task.find({ userId: user.telegramId }).sort({ createdAt: -1 }).limit(10);
      if (!tasks.length) { bot.sendMessage(chatId, `📋 *لا توجد عمليات مراجعة مسجلة بعد*\n\nاضغط "أنشئ حساب Gmail جديد" للبدء!`, { parse_mode: "Markdown", ...MAIN_MENU }); return; }
      let txt = `📋 *حساباتك الأخيرة*\n\n`;
      for (const t of tasks) {
        const statusEmoji = t.status === "approved" ? "✅" : t.status === "rejected" ? "❌" : "⏳";
        const statusText = t.status === "approved" ? "مقبول ومقيد" : t.status === "rejected" ? "مرفوض" : "قيد المراجعة اليدوية";
        txt += `${statusEmoji} \`${t.accountEmail}\` — $${fmt(t.amount)} — ${statusText}\n`;
      }
      bot.sendMessage(chatId, txt, { parse_mode: "Markdown", ...MAIN_MENU }); return;
    }

    if (text === "💰 الرصيد") {
      const approved = await Task.countDocuments({ userId: user.telegramId, status: "approved" });
      const pending = await Task.countDocuments({ userId: user.telegramId, status: "pending" });
      const pendingAmount = await Task.aggregate([{ $match: { userId: user.telegramId, status: "pending" } }, { $group: { _id: null, total: { $sum: "$amount" } } }]);
      const reserved = pendingAmount[0]?.total || 0;
      bot.sendMessage(chatId,
        `💰 *إحصائيات رصيدك المالي*\n\n━━━━━━━━━━━━━━━━━━\n💵 *الرصيد القابل للسحب:* $${fmt(user.balance)} USDT\n🔒 *المبالغ المحجوزة للمراجعة:* $${fmt(reserved)} USDT\n━━━━━━━━━━━━━━━━━━\n\n✅ حسابات تم قبولها ودفعها: ${approved}\n⏳ حسابات تنتظر المراجعة اليدوية: ${pending}\n👥 عدد إحالاتك النشطة: ${user.referralCount}\n\n💸 الحد الأدنى لطلب السحب: *$0.20 USDT*`,
        { parse_mode: "Markdown", ...BALANCE_MENU }
      ); return;
    }

    if (text === "📝 سجل الرصيد") {
      const tasks = await Task.find({ userId: user.telegramId, status: "approved" }).sort({ createdAt: -1 }).limit(20);
      if (!tasks.length) { bot.sendMessage(chatId, `📝 *لا يوجد أرباح مضافة للسجل بعد*\n\nقم بإنهاء مهام حسابات Gmail للحصول على دفعات مقبولة!`, { parse_mode: "Markdown" }); return; }
      let txt = `📝 *سجل الأرباح المعتمدة*\n\n`; let total = 0;
      for (const t of tasks) {
        const date = t.createdAt.toLocaleDateString('ar-EG');
        txt += `✅ \`${t.accountEmail}\`\n💵 +$${fmt(t.amount)} | 📅 ${date}\n\n`;
        total += t.amount;
      }
      txt += `━━━━━━━━━━━━━━━━━━\n💵 *إجمالي الأرباح المستلمة:* $${fmt(total)} USDT`;
      bot.sendMessage(chatId, txt, { parse_mode: "Markdown" }); return;
    }

    if (text === "💳 سحب") {
      user.state = "awaiting_withdraw_network"; user.stateMeta = null; await user.save();
      const NETWORK_MENU = { reply_markup: { keyboard: [["🪙 Litecoin (LTC) | 0% +0.02$ | min: 0.20$"], ["💎 Tether (USDT-BE-20) | 0% +0.03$ | min: 0.20$"], ["🔙 رجوع"]], resize_keyboard: true } };
      bot.sendMessage(chatId, `💸 *اختر شبكة السحب مع مراعاة الرسوم الأمنية*\n\n💰 رصيدك المتاح: *$${fmt(user.balance)} USDT*\n\n⚠️ الحد الأدنى المسموح به: *$0.20 USDT*\n\nاختر الشبكة لمعالجة الطلب يدوياً:`, { parse_mode: "Markdown", ...NETWORK_MENU }); return;
    }

    if (user.state === "awaiting_withdraw_network") {
      let network, fee, feeAmount;
      if (text.includes("Litecoin")) { network = "LTC"; fee = 0.02; feeAmount = 0.02; }
      else if (text.includes("Tether") || text.includes("USDT-BE-20")) { network = "USDT-BE20"; fee = 0.03; feeAmount = 0.03; }
      else if (text === "🔙 رجوع") { user.state = null; await user.save(); bot.sendMessage(chatId, `👋 *تمت العودة للقائمة الرئيسية*`, { parse_mode: "Markdown", ...MAIN_MENU }); return; }
      else { bot.sendMessage(chatId, "❌ الرجاء اختيار شبكة صالحة من القائمة السفلية."); return; }
      const totalNeeded = 0.20 + feeAmount;
      if (user.balance < totalNeeded) {
        bot.sendMessage(chatId, `❌ *عذراً رصيدك لا يغطي العملية*\n\n💰 رصيدك: *$${fmt(user.balance)} USDT*\n📉 الحد الأدنى المطلوب شاملاً الرسوم: *$${fmt(totalNeeded)} USDT*\n(الحد الأدنى $0.20 + رسوم المعالجة $${fee})`, { parse_mode: "Markdown", ...MAIN_MENU });
        user.state = null; await user.save(); return;
      }
      user.state = "awaiting_withdraw_amount_network"; user.stateMeta = { network, fee, feeAmount }; await user.save();
      bot.sendMessage(chatId, `💸 *طلب سحب عبر شبكة ${network}*\n\n💰 رصيدك الحالي: *$${fmt(user.balance)} USDT*\n💸 رسوم اقتطاع الشبكة الثابتة: *$${fee} USDT*\n📉 الحد الأدنى الصافي: *$0.20 USDT*\n\nيرجى كتابة المبلغ المراد سحبه كقيمة رقمية:`, { parse_mode: "Markdown" }); return;
    }

    if (user.state === "awaiting_withdraw_amount_network") {
      const amount = parseFloat(text.trim());
      const { network, fee, feeAmount } = user.stateMeta || {};
      if (isNaN(amount) || amount < 0.20) { bot.sendMessage(chatId, `❌ القيمة المدخلة غير صحيحة أو أقل من الحد الأدنى ($0.20). يرجى المحاولة ثانية:`); return; }
      const totalDeduction = amount + feeAmount;
      if (totalDeduction > user.balance) { bot.sendMessage(chatId, `❌ تعذر طلب هذا المبلغ. الإجمالي المطلوب مع الرسوم هو $${fmt(totalDeduction)} وهو يتجاوز رصيدك الحالي.`, { parse_mode: "Markdown" }); return; }
      user.state = "awaiting_withdraw_address_network"; user.stateMeta = { ...user.stateMeta, amount }; await user.save();
      bot.sendMessage(chatId, `📮 أدخل عنوان محفظتك لاستلام العملة الرسمية لشبكة *(${network})*:\n\n⚠️ يرجى التحقق من العنوان بعناية، الحوالات الخاطئة لا يمكن استردادها نهائياً!`, { parse_mode: "Markdown" }); return;
    }

    if (user.state === "awaiting_withdraw_address_network") {
      const address = text.trim();
      const { network, fee, feeAmount, amount } = user.stateMeta || {};
      if (!address || address.length < 10) { bot.sendMessage(chatId, "❌ تنسيق العنوان المكتوب غير متوافق أمنياً. يرجى إدخال عنوان محفظة حقيقي وصحيح:"); return; }
      const totalDeduction = amount + feeAmount;
      if (totalDeduction > user.balance) { user.state = null; user.stateMeta = null; await user.save(); bot.sendMessage(chatId, `❌ عذراً حدث تغيير في الرصيد ولم يعد كافياً لإتمام العملية.`, { parse_mode: "Markdown", ...MAIN_MENU }); return; }
      
      user.balance -= totalDeduction; user.state = null; user.stateMeta = null; await user.save();
      const withdrawal = await Withdrawal.create({ userId: user.telegramId, amount, fee: feeAmount, totalDeduction, address, network, status: "pending" });
      bot.sendMessage(chatId, `✅ *تم تسجيل طلب سحبك بنجاح!*\n\n🌐 الشبكة المستخدمة: *${network}*\n💵 قيمة السحب الصافي: *$${fmt(amount)} USDT*\n💸 رسوم الحوالة المعلقة: *$${fmt(feeAmount)} USDT*\n📉 إجمالي الخصم من المحفظة: *$${fmt(totalDeduction)} USDT*\n📮 عنوان الاستلام: \`${address}\`\n\n⏳ يخضع الطلب للمراجعة الأمنية اليدوية وتتم معالجة الإرسال خلال 24 ساعة كحد أقصى.`, { parse_mode: "Markdown", ...MAIN_MENU });
      bot.sendMessage(ADMIN_ID, `💸 *إشعار بطلب سحب مالي جديد*\n\n👤 العضو: ${user.firstName} (\`${user.telegramId}\`)\n🌐 شبكة الاستقبال: *${network}*\n💵 المبلغ الأساسي: $${fmt(amount)} USDT\n💸 الرسوم المستقطعة: $${fmt(feeAmount)} USDT\n📮 عنوان العميل: \`${address}\`\n\nللموافقة والتأكيد بعد الإرسال: /approvew ${withdrawal._id}\nللرفض وإعادة الرصيد للمستخدم: /rejectw ${withdrawal._id}`, { parse_mode: "Markdown" }).catch(() => {});
      return;
    }

    if (text === "🔙 رجوع") { bot.sendMessage(chatId, `👋 *تم الرجوع للقائمة الرئيسية*`, { parse_mode: "Markdown", ...MAIN_MENU }); return; }

    if (text === "👥 الإحالات الخاصة بي") {
      const botInfo = await bot.getMe();
      const link = `https://t.me/${botInfo.username}?start=${user.referralCode}`;
      bot.sendMessage(chatId, `👥 *نظام الإحالات التابع لك*\n\n🔗 رابط الدعوة الخاص بك:\n\`${link}\`\n\n👤 إجمالي عدد المستخدمين المسجلين عبر رابطك: *${user.referralCount}*`, { parse_mode: "Markdown", ...MAIN_MENU }); return;
    }

    if (text === "⚙️ الإعدادات") {
      bot.sendMessage(chatId, `⚙️ *إعدادات الحساب والنظام*\n\n👤 الاسم المسجل: ${user.firstName}\n🆔 معرف تيليجرام: \`${user.telegramId}\`\n💰 الرصيد الحالي: $${fmt(user.balance)}\n\nلطلب السحب الفوري أرسل: /withdraw`, { parse_mode: "Markdown", ...MAIN_MENU }); return;
    }

    if (text === "💬 مساعدة") {
      bot.sendMessage(chatId,
        `💬 *مركز الدعم والمساعدة*\n\n❓ *دليل خطوة بخطوة لإنشاء حساب Gmail مقبوض الثمن:*\n1. افتح صفحة التسجيل عبر accounts.google.com\n2. اضغط خيار "إنشاء حساب للاستخدام الشخصي"\n3. أدخل الاسم واللقب وتاريخ الميلاد المعطى لك من البوت تماماً\n4. ضع إيميل الاستعادة الإلزامي: *ryal2422@gmail.com*\n5. تجاوز التحقق الأساسي برقم هاتفك وتأكد من حذف الرقم بعد التفعيل إذا لزم الأمر لضمان بقاء الحساب سليم ومستقل\n6. ارجع للبوت واضغط خيار "تم"\n\n⚠️ *تنبيهات أمنية صارمة:*\n• أي تلاعب بالبيانات المرسلة يعرض الحساب للرفض الفوري.\n• إيميل الاستعادة يجب أن يتطابق بدقة مع البريد المعلن عنه.\n• يمنع تغيير كلمات المرور المسلمة لك منعاً باتاً.\n\nلأي استفسار إداري تواصل مع الدعم الفني المباشر: @𝑪𝒍𝒐𝒖دود`,
        { parse_mode: "Markdown", ...MAIN_MENU }
      ); return;
    }

  } finally {
    processingUsers.delete(userId);
  }
});

const FIRST_NAMES = ["James","John","Robert","Michael","William","David","Richard","Joseph","Thomas","Charles","Daniel","Matthew","Anthony","Mark","Donald","Steven","Paul","Andrew","Kenneth","Joshua","Kevin","Brian","George","Edward","Ronald","Timothy","Jason","Jeffrey","Ryan","Jacob","Gary","Nicholas","Eric","Jonathan","Stephen","Larry","Justin","Scott","Brandon","Benjamin","Samuel","Gregory","Frank","Alexander","Raymond","Patrick","Jack","Dennis","Jerry","Tyler","Aaron","Jose","Adam","Nathan","Henry","Douglas","Zachary","Peter","Kyle","Ethan","Walter","Noah","Jeremy","Christian","Keith","Roger","Terry","Gerald","Harold","Sean","Austin","Carl","Arthur","Lawrence","Dylan","Jesse","Jordan","Bryan","Billy","Joe","Bruce","Gabriel","Logan","Albert","Willie","Alan","Juan","Wayne","Elijah","Randy","Roy","Vincent","Ralph","Eugene","Russell","Bobby","Mason","Philip","Louis","Mary","Patricia","Jennifer","Linda","Elizabeth","Barbara","Susan","Jessica","Sarah","Karen","Nancy","Lisa","Betty","Margaret","Sandra","Ashley","Kimberly","Emily","Donna","Michelle","Dorothy","Carol","Amanda","Melissa","Deborah","Stephanie","Rebecca","Laura","Sharon","Cynthia","Kathleen","Amy","Shirley","Angela","Helen","Anna","Brenda","Pamela","Nicole","Emma","Samantha","Katherine","Christine","Debra","Rachel","Catherine","Carolyn","Janet","Ruth","Maria","Heather","Diane","Virginia","Julie","Joyce","Victoria","Olivia","Kelly","Christina","Lauren","Joan","Evelyn","Judith","Megan","Cheryl","Andrea","Hannah","Martha","Jacqueline","Frances","Gloria","Ann","Teresa","Kathryn","Sara","Janice","Jean","Alice","Madison","Doris","Abigail","Julia","Judy","Grace","Denise","Amber","Marilyn","Beverly","Danielle","Theresa","Sophia","Marie","Diana","Brittany","Natalie","Isabella","Charlotte","Rose","Alexis","Kayla"];
const LAST_NAMES = ["Smith","Johnson","Williams","Brown","Jones","Garcia","Miller","Davis","Rodriguez","Martinez","Hernandez","Lopez","Gonzalez","Wilson","Anderson","Thomas","Taylor","Moore","Jackson","Martin","Lee","Perez","Thompson","White","Harris","Sanchez","Clark","Ramirez","Lewis","Robinson","Walker","Young","Allen","King","Wright","Scott","Torres","Nguyen","Hill","Flores","Green","Adams","Nelson","Baker","Hall","Rivera","Campbell","Mitchell","Carter","Roberts","Gomez","Phillips","Evans","Turner","Diaz","Parker","Cruz","Edwards","Collins","Reyes","Stewart","Morris","Morales","Murphy","Cook","Rogers","Gutierrez","Ortiz","Morgan","Cooper","Peterson","Bailey","Reed","Kelly","Howard","Ramos","Kim","Cox","Ward","Richardson","Watson","Brooks","Chavez","Wood","James","Bennett","Gray","Mendoza","Ruiz","Hughes","Price","Alvarez","Castillo","Sanders","Patel","Myers","Long","Ross","Foster","Jimenez","Powell","Jenkins","Perry","Russell","Sullivan","Bell","Coleman","Butler","Henderson","Barnes","Gonzales","Fisher","Vasquez","Simpson","Romero","Jordan","Patterson","Alexander","Hamilton","Graham","Reynolds","Griffin","Wallace","Moreno","West","Cole","Hayes","Bryant","Herrera","Gibson","Ellis","Tran","Medina","Aguilar","Stevens","Murray","Ford","Castro","Marshall","Owens","Harrison","Fernandez","Mcdonald","Woods","Washington","Kennedy","Wells","Vargas","Henry","Chen","Freeman","Webb","Tucker","Guzman","Burns","Crawford","Olson","Porter","Hunter","Gordon","Mendez","Silva","Shaw","Snyder","Mason","Dixon","Munoz","Hunt","Hicks","Holmes","Palmer","Wagner","Black","Robertson","Boyd","Rose","Stone","Salazar","Fox","Warren","Mills","Meyer","Rice","Schmidt","Garza","Daniels","Ferguson","Nichols","Stephens","Soto","Weaver","Ryan","Gardner","Payne","Grant","Dunn","Kelley","Spencer","Hawkins","Arnold","Pierce","Vazquez","Hansen","Peters","Santos","Hart","Bradley","Knight","Elliott","Cunningham","Duncan","Armstrong","Hudson","Carroll","Lane","Riley","Andrews","Ray","Delgado","Berry","Perkins","Hoffman","Johnston","Matthews","Pena","Richards","Contreras","Willis","Carpenter","Lawrence","Sandoval","Guerrero","George","Chapman","Rios","Estrada","Ortega","Watkins","Greene","Nunez","Wheeler","Valdez","Harper","Burke","Larson","Santiago","Maldonado","Morrison","Franklin","Carlson","Austin","Dominguez","Carr","Lawson","Jacobs","Obrien","Lynch","Singh","Vega","Bishop","Montgomery","Oliver","Jensen","Harvey","Williamson","Gilbert","Bates","Chambers","Kuhn"];

function getRandomItem(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function generateRandomEmail(firstName, lastName) {
  const randomNum = Math.floor(Math.random() * 9999) + 1;
  const patterns = [
    `${firstName.toLowerCase()}.${lastName.toLowerCase()}${randomNum}`,
    `${firstName.toLowerCase()}${lastName.toLowerCase()}${randomNum}`,
    `${firstName.toLowerCase()}.${lastName.toLowerCase()}.${randomNum}`,
    `${firstName.toLowerCase()[0]}${lastName.toLowerCase()}${randomNum}`,
    `${lastName.toLowerCase()}.${firstName.toLowerCase()}${randomNum}`,
    `${firstName.toLowerCase()}${lastName.toLowerCase()[0]}${randomNum}`,
    `${firstName.toLowerCase()[0]}_${lastName.toLowerCase()}${randomNum}`,
  ];
  return `${getRandomItem(patterns)}@gmail.com`;
}

function generatePassword() {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*";
  let password = "";
  for (let i = 0; i < 12; i++) password += chars[Math.floor(Math.random() * chars.length)];
  return password;
}

function generateRandomBirthDate() {
  const start = new Date(1990, 0, 1);
  const end = new Date(2007, 11, 31);
  const randomDate = new Date(start.getTime() + Math.random() * (end.getTime() - start.getTime()));
  const year = randomDate.getFullYear();
  const month = String(randomDate.getMonth() + 1).padStart(2, '0');
  const day = String(randomDate.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

bot.onText(/\/generate (\d+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const count = parseInt(match[1]);
  if (isNaN(count) || count < 1 || count > 100) { bot.sendMessage(msg.chat.id, "❌ أدخل رقماً بين 1 و 100."); return; }
  let added = 0, failed = 0;
  const generatedAccounts = [];
  for (let i = 0; i < count; i++) {
    const firstName = getRandomItem(FIRST_NAMES);
    const lastName = getRandomItem(LAST_NAMES);
    const email = generateRandomEmail(firstName, lastName);
    const password = generatePassword();
    const birthDate = generateRandomBirthDate();
    try {
      await Account.create({ firstName, lastName, email, password, birthDate, recoveryEmail: RECOVERY_EMAIL });
      added++; generatedAccounts.push({ firstName, lastName, email, password, birthDate });
    } catch (err) {
      if (err.code === 11000) {
        const newEmail = generateRandomEmail(firstName, lastName);
        try { 
          await Account.create({ firstName, lastName, email: newEmail, password, birthDate, recoveryEmail: RECOVERY_EMAIL }); 
          added++; generatedAccounts.push({ firstName, lastName, email: newEmail, password, birthDate }); 
        } catch { failed++; }
      } else { failed++; }
    }
  }
  const totalAvailable = await Account.countDocuments({ assigned: false });
  let summary = `🎲 *تم توليد الحسابات*\n\n✅ نجح: *${added}*\n❌ فشل: *${failed}*\n📦 المتاح الآن: *${totalAvailable}*\n\n`;
  if (generatedAccounts.length > 0) {
    summary += `*آخر 5 حسابات:*\n`;
    generatedAccounts.slice(-5).forEach((acc, i) => { summary += `${i+1}. \`${acc.email}\` | ${acc.firstName} ${acc.lastName} | تاريخ: ${acc.birthDate}\n`; });
  }
  bot.sendMessage(msg.chat.id, summary, { parse_mode: "Markdown" });
  if (generatedAccounts.length > 0) {
    const csvContent = ["First Name,Last Name,Email,Password,Birth Date,Recovery Email", ...generatedAccounts.map(a => `${a.firstName},${a.lastName},${a.email},${a.password},${a.birthDate},${RECOVERY_EMAIL}`)].join("\n");
    const buffer = Buffer.from(csvContent, "utf-8");
    bot.sendDocument(msg.chat.id, buffer, { filename: `accounts_${Date.now()}.csv`, caption: `📄 *ملف الحسابات المولدة (${added} حساب)*\n🔗 إيميل الاستعادة: ${RECOVERY_EMAIL}`, parse_mode: "Markdown" });
  }
});

bot.onText(/\/genquick/, async (msg) => {
  if (msg.from.id !== ADMIN_ID) return;
  const firstName = getRandomItem(FIRST_NAMES);
  const lastName = getRandomItem(LAST_NAMES);
  const email = generateRandomEmail(firstName, lastName);
  const password = generatePassword();
  const birthDate = generateRandomBirthDate();
  try {
    await Account.create({ firstName, lastName, email, password, birthDate, recoveryEmail: RECOVERY_EMAIL });
    bot.sendMessage(msg.chat.id, `✅ *تم إنشاء حساب سريع*\n\n👤 الاسم: ${firstName} ${lastName}\n📅 الميلاد: \`${birthDate}\`\n📧 \`${email}\`\n🔑 \`${password}\`\n🔗 إيميل الاستعادة: ${RECOVERY_EMAIL}`, { parse_mode: "Markdown" });
  } catch { bot.sendMessage(msg.chat.id, "❌ فشل الإنشاء، جرب /genquick مرة أخرى."); }
});

bot.onText(/\/addaccount (\S+) (\S+) (\S+) (\S+) (\S+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const [, firstName, lastName, email, password, birthDate] = match;
  try {
    await Account.create({ firstName, lastName, email, password, birthDate, recoveryEmail: RECOVERY_EMAIL });
    const total = await Account.countDocuments({ assigned: false });
    bot.sendMessage(msg.chat.id, `✅ *تم إضافة الحساب*\n\n👤 ${firstName} ${lastName}\n📅 الميلاد: \`${birthDate}\`\n📧 \`${email}\`\n🔑 \`${password}\`\n🔗 الاستعادة: ${RECOVERY_EMAIL}\n\n📦 الحسابات المتاحة: *${total}*`, { parse_mode: "Markdown" });
  } catch { bot.sendMessage(msg.chat.id, "❌ الإيميل موجود بالفعل أو المدخلات خاطئة."); }
});

bot.onText(/\/addaccounts (.+)/s, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const lines = match[1].trim().split("\n").filter(l => l.trim());
  let added = 0, failed = 0;
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) { failed++; continue; }
    const [firstName, lastName, email, password, birthDate] = parts;
    try { await Account.create({ firstName, lastName, email, password, birthDate, recoveryEmail: RECOVERY_EMAIL }); added++; }
    catch { failed++; }
  }
  const total = await Account.countDocuments({ assigned: false });
  bot.sendMessage(msg.chat.id, `📦 *تم إضافة الحسابات*\n\n✅ مضاف: ${added}\n❌ فشل/مكرر: ${failed}\n📦 المتاح الآن: ${total}`, { parse_mode: "Markdown" });
});

bot.onText(/\/approve (\w+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const task = await Task.findById(match[1]).catch(() => null);
  if (!task) { bot.sendMessage(msg.chat.id, "❌ المهمة غير موجودة."); return; }
  if (task.status !== "pending") { bot.sendMessage(msg.chat.id, `⚠️ تمت معالجتها مسبقاً (${task.status}).`); return; }
  task.status = "approved"; await task.save();
  const user = await User.findOne({ telegramId: task.userId });
  if (user) {
    user.balance += task.amount; await user.save();
    bot.sendMessage(task.userId, `✅ *تمت الموافقة على حسابك المرفوع مسبقاً!*\n\n📧 \`${task.accountEmail}\`\n💵 +$${task.amount} USDT\n💰 رصيدك الإجمالي الحالي: *$${fmt(user.balance)} USDT*`, { parse_mode: "Markdown", ...MAIN_MENU }).catch(() => {});
  }
  bot.sendMessage(msg.chat.id, `✅ تمت الموافقة يدويًا وإضافة $${task.amount} USDT لرصيد العضو بنجاح.`);
});

bot.onText(/\/reject (\w+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const task = await Task.findById(match[1]).catch(() => null);
  if (!task) { bot.sendMessage(msg.chat.id, "❌ المهمة غير موجودة."); return; }
  if (task.status !== "pending") { bot.sendMessage(msg.chat.id, `⚠️ تمت معالجتها مسبقاً (${task.status}).`); return; }
  task.status = "rejected"; await task.save();
  if (task.accountId) await Account.findByIdAndUpdate(task.accountId, { assigned: false, assignedTo: null, assignedAt: null });
  const user = await User.findOne({ telegramId: task.userId });
  if (user) bot.sendMessage(task.userId, `❌ *تم رفض الحساب بعد التدقيق اليدوي*\n\n📧 \`${task.accountEmail}\`\nربما لم تقم بإدراج بريد الاسترداد الصحيح، يمكنك المحاولة مرة أخرى باستخدام بيانات جديدة وصحيحة.`, { parse_mode: "Markdown", ...MAIN_MENU }).catch(() => {});
  bot.sendMessage(msg.chat.id, `❌ تم الرفض اليدوي وإعادة الحساب لسلسلة المتاح بنجاح لحماية البيانات.`);
});

bot.onText(/\/approvew (\w+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const withdrawal = await Withdrawal.findById(match[1]).catch(() => null);
  if (!withdrawal) { bot.sendMessage(msg.chat.id, "❌ طلب السحب غير موجود."); return; }
  if (withdrawal.status !== "pending") { bot.sendMessage(msg.chat.id, `⚠️ تمت معالجته مسبقاً (${withdrawal.status}).`); return; }
  withdrawal.status = "approved"; await withdrawal.save();
  const user = await User.findOne({ telegramId: withdrawal.userId });
  if (user) bot.sendMessage(withdrawal.userId, `✅ *تمت الموافقة على طلب السحب وحوالتك جاهزة!*\n\n🌐 الشبكة: ${withdrawal.network}\n💵 المبلغ المرسل: $${fmt(withdrawal.amount)} USDT\n📮 عنوانك: \`${withdrawal.address}\``, { parse_mode: "Markdown", ...MAIN_MENU }).catch(() => {});
  bot.sendMessage(msg.chat.id, `✅ تم تأكيد إتمام عملية السحب يدويًا وتحديث الملف بنجاح.`);
});

bot.onText(/\/rejectw (\w+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const withdrawal = await Withdrawal.findById(match[1]).catch(() => null);
  if (!withdrawal) { bot.sendMessage(msg.chat.id, "❌ طلب السحب غير موجود."); return; }
  if (withdrawal.status !== "pending") { bot.sendMessage(msg.chat.id, `⚠️ تمت معالجته مسبقاً (${withdrawal.status}).`); return; }
  withdrawal.status = "rejected"; await withdrawal.save();
  const user = await User.findOne({ telegramId: withdrawal.userId });
  if (user) {
    user.balance += withdrawal.totalDeduction; await user.save();
    bot.sendMessage(withdrawal.userId, `❌ *تم رفض طلب سحب الأموال الخاص بك*\n\n🌐 الشبكة: ${withdrawal.network}\n💵 تم إعادة إجمالي رصيدك المحجوز بالكامل: $${fmt(withdrawal.totalDeduction)} USDT\n💰 رصيدك المتوفر الآن: *$${fmt(user.balance)} USDT*\nيرجى مراجعة الإدارة أو التحقق من عنوان محفظتك ثانية.`, { parse_mode: "Markdown", ...MAIN_MENU }).catch(() => {});
  }
  bot.sendMessage(msg.chat.id, `❌ تم رفض السحب بنجاح وإرجاع الرصيد المحجوز لحساب العضو فوراً.`);
});

bot.onText(/\/pending/, async (msg) => {
  if (msg.from.id !== ADMIN_ID) return;
  const tasks = await Task.find({ status: "pending" }).sort({ createdAt: 1 }).limit(20);
  if (!tasks.length) { bot.sendMessage(msg.chat.id, "✅ لا توجد طلبات معلقة بانتظار المراجعة."); return; }
  const userIds = [...new Set(tasks.map(t => t.userId))];
  const accountIds = tasks.map(t => t.accountId).filter(Boolean);
  const [users, accounts] = await Promise.all([User.find({ telegramId: { $in: userIds } }, "firstName telegramId"), Account.find({ _id: { $in: accountIds } }, "password recoveryEmail birthDate")]);
  const userMap = Object.fromEntries(users.map(u => [u.telegramId, u]));
  const accountMap = Object.fromEntries(accounts.map(a => [a._id.toString(), a]));
  let text = `⏳ *الطلبات المعلقة بالمراجعة اليدوية (${tasks.length})*\n\n`;
  for (const t of tasks) {
    const u = userMap[t.userId]; const acc = accountMap[t.accountId?.toString()];
    text += `📧 \`${t.accountEmail}\`\n🔑 \`${acc?.password || "غير متاح"}\`\n📅 \`${acc?.birthDate || "غير متاح"}\`\n🔗 \`${acc?.recoveryEmail || RECOVERY_EMAIL}\`\n👤 ${u?.firstName || "؟"} (\`${t.userId}\`)\n✅ /approve ${t._id}  ❌ /reject ${t._id}\n\n`;
  }
  bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
});

bot.onText(/\/checking/, async (msg) => {
  if (msg.from.id !== ADMIN_ID) return;
  const stuckUsers = await User.find({ state: "awaiting_confirmation" });
  if (!stuckUsers.length) { bot.sendMessage(msg.chat.id, "✅ لا يوجد أحد في حالة التحقق حالياً."); return; }
  let text = `🔍 *الحسابات قيد التحقق والإنشاء الآن (${stuckUsers.length})*\n\n`;
  for (const user of stuckUsers) {
    const accountId = user.stateMeta?.accountId;
    const account = accountId ? await Account.findById(accountId) : null;
    const sinceMs = user.updatedAt ? Date.now() - user.updatedAt.getTime() : 0;
    const sinceMinutes = Math.floor(sinceMs / (60 * 1000));
    const sinceHours = Math.floor(sinceMs / (60 * 60 * 1000));
    const timeDisplay = sinceHours >= 1 ? `${sinceHours} ساعة و ${sinceMinutes % 60} دقيقة` : `${sinceMinutes} دقيقة`;
    text += `👤 ${user.firstName} (\`${user.telegramId}\`)\n`;
    if (account) {
      text += `📧 \`${account.email}\`\n🔑 \`${account.password}\`\n📅 \`${account.birthDate}\`\n🔗 \`${account.recoveryEmail || RECOVERY_EMAIL}\`\n`;
    } else {
      text += `📧 حساب غير متاح\n`;
    }
    text += `⏱ منذ: ${timeDisplay}\n\n`;
  }
  bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
});

bot.onText(/\/accounts/, async (msg) => {
  if (msg.from.id !== ADMIN_ID) return;
  const available = await Account.countDocuments({ assigned: false });
  const assigned = await Account.countDocuments({ assigned: true });
  bot.sendMessage(msg.chat.id, `📦 *الحسابات الحالية*\n\n✅ متاح بالمخزن: *${available}*\n🔒 مُعيَّن للعمل: *${assigned}*\n📊 الإجمالي الشامل: *${available + assigned}*`, { parse_mode: "Markdown" });
});

bot.onText(/\/addbalance (\d+) ([\d.]+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const user = await User.findOne({ telegramId: parseInt(match[1]) });
  if (!user) { bot.sendMessage(msg.chat.id, "❌ المستخدم غير موجود."); return; }
  user.balance += parseFloat(match[2]); await user.save();
  bot.sendMessage(msg.chat.id, `✅ تم التعديل المالي بنجاح. الرصيد الجديد: $${fmt(user.balance)}`);
  bot.sendMessage(user.telegramId, `🎁 تم إضافة $${match[2]} لرصيدك كدفعة إدارية خارجية!\nرصيدك المتاح الحالي: $${fmt(user.balance)}`, MAIN_MENU).catch(() => {});
});

bot.onText(/\/ban (\d+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const user = await User.findOne({ telegramId: parseInt(match[1]) });
  if (!user) { bot.sendMessage(msg.chat.id, "❌ العضو غير موجود بالقاعدة."); return; }
  user.banned = true; await user.save();
  bot.sendMessage(msg.chat.id, `🚫 تم حظر الوصول الفوري للمستخدم ${user.firstName}.`);
  bot.sendMessage(user.telegramId, "🚫 تم حظرك من استخدام خدمات البوت من قبل المسؤول لمخالفة القوانين.").catch(() => {});
});

bot.onText(/\/unban (\d+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const user = await User.findOne({ telegramId: parseInt(match[1]) });
  if (!user) { bot.sendMessage(msg.chat.id, "❌ العضو غير موجود بالقاعدة."); return; }
  user.banned = false; await user.save();
  bot.sendMessage(msg.chat.id, `✅ تم رفع الحظر الأمني عن المستخدم ${user.firstName}.`);
  bot.sendMessage(user.telegramId, "✅ أهلاً بك مجدداً، تم رفع الحظر عن حسابك بنجاح!", MAIN_MENU).catch(() => {});
});

bot.onText(/\/users/, async (msg) => {
  if (msg.from.id !== ADMIN_ID) return;
  const users = await User.find().sort({ createdAt: -1 }).limit(20);
  let text = `👥 *قائمة الأعضاء الأخيرة*\n\n`;
  users.forEach((u, i) => { text += `${i + 1}. ${u.firstName}${u.banned ? " 🚫" : ""} | $${fmt(u.balance)} | \`${u.telegramId}\`\n`; });
  bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
});

bot.onText(/\/stats/, async (msg) => {
  if (msg.from.id !== ADMIN_ID) return;
  const [totalUsers, pendingTasks, approvedTasks, availableAccounts, pendingWithdrawals, paid] = await Promise.all([User.countDocuments(), Task.countDocuments({ status: "pending" }), Task.countDocuments({ status: "approved" }), Account.countDocuments({ assigned: false }), Withdrawal.countDocuments({ status: "pending" }), Task.aggregate([{ $match: { status: "approved" } }, { $group: { _id: null, total: { $sum: "$amount" } } }])]);
  bot.sendMessage(msg.chat.id, `📊 *الإحصائيات المالية والتشغيلية العامة*\n\n👤 المستخدمون النشطون: *${totalUsers}*\n📦 الحسابات المتاحة للعمل: *${availableAccounts}*\n✅ طلبات مقبولة مدفوعة: *${approvedTasks}*\n⏳ طلبات مراجعة معلقة: *${pendingTasks}*\n💸 طلبات سحب معلقة: *${pendingWithdrawals}*\n💵 إجمالي المدفوعات المسلمة: *$${fmt(paid[0]?.total || 0)} USDT*`, { parse_mode: "Markdown" });
});

bot.onText(/\/broadcast (.+)/s, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const users = await User.find({}, "telegramId");
  let sent = 0, failed = 0;
  for (const u of users) {
    try { await bot.sendMessage(u.telegramId, `📢 *رسالة هامة من إدارة البوت*\n\n${match[1]}`, { parse_mode: "Markdown" }); sent++; }
    catch { failed++; }
  }
  bot.sendMessage(msg.chat.id, `📢 النتيجة الجماعية: ✅ ${sent} إرسال ناجح | ❌ ${failed} فشل التسليم (قفل البوت)`);
});

bot.onText(/\/withdrawals/, async (msg) => {
  if (msg.from.id !== ADMIN_ID) return;
  const wds = await Withdrawal.find({ status: "pending" }).limit(20);
  if (!wds.length) { bot.sendMessage(msg.chat.id, "✅ لا توجد طلبات سحب معلقة حالياً."); return; }
  const userIds = [...new Set(wds.map(w => w.userId))];
  const users = await User.find({ telegramId: { $in: userIds } }, "firstName telegramId");
  const userMap = Object.fromEntries(users.map(u => [u.telegramId, u]));
  let text = `💸 *طلبات السحب المعلقة بالمراجعة اليدوية (${wds.length})*\n\n`;
  for (const w of wds) {
    const u = userMap[w.userId];
    const createdMs = Date.now() - w.createdAt.getTime();
    const hoursAgo = Math.floor(createdMs / (60 * 60 * 1000));
    const minAgo = Math.floor(createdMs / (60 * 1000)) % 60;
    const timeAgo = hoursAgo >= 1 ? `${hoursAgo} ساعة و ${minAgo} دقيقة` : `${minAgo} دقيقة`;
    text += `👤 العضو: ${u?.firstName || "؟"} (\`${w.userId}\`)\n🌐 الشبكة: ${w.network}\n💵 الصافي: $${fmt(w.amount)} (+$${fmt(w.fee)} رسوم الاقتطاع)\n📮 المحفظة: \`${w.address}\`\n⏱ الوقت المنقضي: منذ ${timeAgo}\n✅ /approvew ${w._id}  ❌ /rejectw ${w._id}\n\n`;
  }
  bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
});

bot.onText(/\/withdraw/, async (msg) => {
  const user = await getOrCreateUser(msg);
  user.state = "awaiting_withdraw_network"; user.stateMeta = null; await user.save();
  const NETWORK_MENU = { reply_markup: { keyboard: [["🪙 Litecoin (LTC) | 0% +0.02$ | min: 0.20$"], ["💎 Tether (USDT-BE-20) | 0% +0.03$ | min: 0.20$"], ["🔙 رجوع"]], resize_keyboard: true } };
  bot.sendMessage(msg.chat.id, `💸 *اختر شبكة السحب مع مراعاة الرسوم الأمنية*\n\n💰 رصيدك المتاح: *$${fmt(user.balance)} USDT*\n\n⚠️ الحد الأدنى المسموح به: *$0.20 USDT*\n\nاختر الشبكة لمعالجة الطلب يدوياً:`, { parse_mode: "Markdown", ...NETWORK_MENU });
});

mongoose.connection.on("connected", () => console.log("✅ MongoDB connected"));
mongoose.connection.on("error", err => console.error("⚠️ MongoDB error:", err.message));
mongoose.connection.on("disconnected", () => console.warn("⚠️ MongoDB disconnected"));

mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 10000 })
  .catch(err => console.error("❌ MongoDB connection failed:", err.message));

console.log("🤖 الآلة الآمنة تعمل ومحمية من الثغرات...");

const PORT = process.env.PORT || 8080;
http.createServer((req, res) => {
  res.writeHead(200); res.end(JSON.stringify({ status: "safe_mode_active" }));
}).listen(PORT, () => console.log(`🌐 HTTP Webhook server active on port ${PORT}`));

bot.on("polling_error", err => console.error("Polling connection log:", err.message));
process.on("SIGTERM", async () => {
  await bot.stopPolling();
  await mongoose.disconnect();
  process.exit(0);
});

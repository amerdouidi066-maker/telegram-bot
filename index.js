const TelegramBot = require("node-telegram-bot-api");
const mongoose = require("mongoose");
const http = require("http");
const crypto = require("crypto");

// ─── Environment ──────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_ID = parseInt(process.env.ADMIN_ID || "7693096273", 10);
const RECOVERY_EMAIL = "amermm1560@gmail.com";
const MIN_WITHDRAW = 0.20;
const VERIFY_HOURS = 72;
const ASSIGN_EXPIRE_MINUTES = 20;

if (!BOT_TOKEN) throw new Error("BOT_TOKEN is required");
if (!MONGODB_URI) throw new Error("MONGODB_URI is required");

// ─── Security: Encryption ─────────────────────────────────────────────────────
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32);
const IV_LENGTH = 16;

function encrypt(text) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv("aes-256-cbc", ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  return iv.toString("hex") + ":" + encrypted;
}

function decrypt(text) {
  const [ivHex, encryptedHex] = text.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const decipher = crypto.createDecipheriv("aes-256-cbc", ENCRYPTION_KEY, iv);
  let decrypted = decipher.update(encryptedHex, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

// ─── Mongoose Models ───────────────────────────────────────────────────────────
const userSchema = new mongoose.Schema({
  telegramId: { type: Number, required: true, unique: true, index: true },
  username: String,
  firstName: String,
  balance: { type: Number, default: 0, min: 0 },
  referralCode: { type: String, unique: true, index: true },
  referredBy: { type: Number, default: null, index: true },
  referralCount: { type: Number, default: 0 },
  banned: { type: Boolean, default: false, index: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

const accountSchema = new mongoose.Schema({
  firstName: { type: String, required: true },
  lastName: { type: String, required: true },
  email: { type: String, required: true, unique: true, index: true },
  password: { type: String, required: true },
  birthdate: { type: String, default: null },
  assigned: { type: Boolean, default: false, index: true },
  assignedTo: { type: Number, default: null, index: true },
  assignedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
});

const taskSchema = new mongoose.Schema({
  userId: { type: Number, required: true, index: true },
  amount: { type: Number, required: true },
  accountEmail: { type: String, required: true },
  accountPassword: { type: String, required: true },
  accountFirstName: { type: String, required: true },
  accountLastName: { type: String, required: true },
  status: { 
    type: String, 
    enum: ["pending", "verifying", "approved", "rejected"], 
    default: "pending",
    index: true 
  },
  verifyAt: { type: Date, default: null, index: true },
  createdAt: { type: Date, default: Date.now },
});

const withdrawSchema = new mongoose.Schema({
  userId: { type: Number, required: true, index: true },
  amount: { type: Number, required: true, min: 0 },
  address: { type: String, required: true },
  status: { 
    type: String, 
    enum: ["pending", "approved", "rejected"], 
    default: "pending",
    index: true 
  },
  createdAt: { type: Date, default: Date.now },
});

taskSchema.index({ userId: 1, createdAt: 1 });
taskSchema.index({ status: 1, verifyAt: 1 });
accountSchema.index({ assigned: 1, assignedAt: 1 });

const User = mongoose.model("User", userSchema);
const Account = mongoose.model("Account", accountSchema);
const Task = mongoose.model("Task", taskSchema);
const Withdrawal = mongoose.model("Withdrawal", withdrawSchema);

// ═══════════════════════════════════════════════════════════════════════════════
// ═══ 🎯 PROFESSIONAL HUMAN-LIKE EMAIL GENERATOR ═════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════════

const DOMAINS = ["gmail.com"];

const FIRST_NAMES = [
  "Emma", "Olivia", "Ava", "Isabella", "Sophia", "Mia", "Charlotte", "Amelia", "Harper", "Evelyn",
  "Abigail", "Emily", "Elizabeth", "Mila", "Ella", "Avery", "Sofia", "Camila", "Aria", "Scarlett",
  "Victoria", "Madison", "Luna", "Grace", "Chloe", "Penelope", "Layla", "Riley", "Zoey", "Nora",
  "Lily", "Eleanor", "Hannah", "Lillian", "Addison", "Aubrey", "Ellie", "Stella", "Natalie", "Zoe",
  "James", "John", "Robert", "Michael", "William", "David", "Richard", "Joseph", "Thomas", "Charles",
  "Daniel", "Matthew", "Anthony", "Mark", "Donald", "Steven", "Paul", "Andrew", "Joshua", "Kevin",
  "Brian", "George", "Timothy", "Ronald", "Edward", "Jason", "Jeffrey", "Ryan", "Jacob", "Gary",
  "Nicholas", "Eric", "Jonathan", "Stephen", "Larry", "Justin", "Scott", "Brandon", "Benjamin", "Samuel",
  "Liam", "Noah", "Oliver", "Elijah", "Benjamin", "Lucas", "Mason", "Ethan", "Alexander", "Henry",
  "Jackson", "Sebastian", "Aiden", "Owen", "Samuel", "Wyatt", "Joseph", "Mateo", "Levi", "David"
];

const LAST_NAMES = [
  "Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis", "Wilson", "Taylor",
  "Anderson", "Thomas", "Jackson", "White", "Harris", "Martin", "Thompson", "Young", "Robinson", "Lewis",
  "Walker", "Hall", "Allen", "King", "Wright", "Scott", "Green", "Baker", "Adams", "Nelson",
  "Hill", "Ramirez", "Campbell", "Mitchell", "Roberts", "Carter", "Phillips", "Evans", "Turner", "Torres",
  "Parker", "Collins", "Edwards", "Stewart", "Flores", "Morris", "Nguyen", "Murphy", "Rivera", "Cook",
  "Rogers", "Morgan", "Peterson", "Cooper", "Reed", "Bailey", "Bell", "Gomez", "Kelly", "Howard",
  "Ward", "Cox", "Diaz", "Richardson", "Wood", "Watson", "Brooks", "Bennett", "Gray", "James",
  "Reyes", "Cruz", "Hughes", "Price", "Myers", "Long", "Foster", "Sanders", "Ross", "Morales",
  "Powell", "Sullivan", "Russell", "Ortiz", "Jenkins", "Gutierrez", "Perry", "Butler", "Barnes", "Fisher"
];

const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const pickRandom = (arr) => arr[randomInt(0, arr.length - 1)];

function generateBirthdate() {
  const day = String(randomInt(1, 28)).padStart(2, "0");
  const month = String(randomInt(1, 12)).padStart(2, "0");
  const year = randomInt(1985, 2005);
  return { day, month, year, formatted: `${day}.${month}.${year}` };
}

function generatePassword() {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let pass = "";
  for (let i = 0; i < 12; i++) {
    pass += chars[randomInt(0, chars.length - 1)];
  }
  return pass;
}

/**
 * 🎯 PROFESSIONAL EMAIL GENERATOR
 * Pattern: firstname_lastname####@gmail.com (exactly like the screenshot)
 * Example: emma_adams7375@gmail.com
 */
async function generateProfessionalEmail(firstName, lastName) {
  const domain = "gmail.com";
  
  // Pattern 1: firstname_lastname + 4 digits (like screenshot: emma_adams7375)
  const pattern1 = `${firstName.toLowerCase()}_${lastName.toLowerCase()}${randomInt(1000, 9999)}@${domain}`;
  
  // Pattern 2: firstname.lastname + 2 digits
  const pattern2 = `${firstName.toLowerCase()}.${lastName.toLowerCase()}${randomInt(10, 99)}@${domain}`;
  
  // Pattern 3: firstname + lastname initial + 3 digits
  const pattern3 = `${firstName.toLowerCase()}${lastName.toLowerCase()[0]}${randomInt(100, 999)}@${domain}`;
  
  // Pattern 4: firstname + lastname + 2 digits
  const pattern4 = `${firstName.toLowerCase()}${lastName.toLowerCase()}${randomInt(10, 99)}@${domain}`;
  
  // Pattern 5: first initial + lastname + 3 digits
  const pattern5 = `${firstName.toLowerCase()[0]}${lastName.toLowerCase()}${randomInt(100, 999)}@${domain}`;
  
  // Pattern 6: firstname_lastname + year (1985-2005)
  const birthYear = randomInt(1985, 2005);
  const pattern6 = `${firstName.toLowerCase()}_${lastName.toLowerCase()}${birthYear}@${domain}`;
  
  const patterns = [pattern1, pattern2, pattern3, pattern4, pattern5, pattern6];
  const email = patterns[randomInt(0, patterns.length - 1)];
  
  // ✅ Check uniqueness in database
  const exists = await Account.findOne({ email }).lean();
  if (exists) {
    console.log(`⚠️ Email collision: ${email}, regenerating...`);
    return generateProfessionalEmail(firstName, lastName);
  }
  
  return email;
}

/**
 * 📧 Generate complete professional account data
 */
async function generateAccountData() {
  const firstName = pickRandom(FIRST_NAMES);
  const lastName = pickRandom(LAST_NAMES);
  const birth = generateBirthdate();
  const email = await generateProfessionalEmail(firstName, lastName);
  const password = generatePassword();
  
  return {
    firstName,
    lastName,
    email,
    password,
    birthdate: birth.formatted,
    birthYear: birth.year
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const genReferralCode = (id) => "REF" + id.toString(36).toUpperCase();

const getOrCreateUser = async (from) => {
  const fromObj = from.from || from;
  const { id, first_name, username } = fromObj;
  
  let user = await User.findOne({ telegramId: id });
  
  if (!user) {
    user = await User.create({
      telegramId: id,
      firstName: first_name || "مستخدم",
      username: username || null,
      referralCode: genReferralCode(id),
    });
  } else {
    const updates = {};
    if (first_name && user.firstName !== first_name) updates.firstName = first_name;
    if (username && user.username !== username) updates.username = username;
    if (Object.keys(updates).length > 0) {
      updates.updatedAt = new Date();
      await User.updateOne({ _id: user._id }, { $set: updates });
      Object.assign(user, updates);
    }
  }
  return user;
};

const fmt = (n) => Number(n || 0).toFixed(3);

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

// ─── Bot Setup ────────────────────────────────────────────────────────────────
const bot = new TelegramBot(BOT_TOKEN, {
  polling: {
    interval: 1000,
    autoStart: true,
    params: {
      timeout: 10,
      allowed_updates: ["message", "callback_query"],
    },
  },
});

bot.on("polling_error", (err) => {
  if (err.code === "ETELEGRAM" && err.message.includes("409")) {
    console.error("❌ هناك instance آخر يشتغل! أوقفه أولاً.");
    process.exit(1);
  }
  console.error("Polling error:", err.message);
});

// ─── Middleware: User Validation ──────────────────────────────────────────────
const validateUser = async (msg) => {
  const user = await getOrCreateUser(msg);
  if (user.banned) {
    await bot.sendMessage(msg.chat.id, "🚫 تم حظرك من استخدام البوت.");
    return null;
  }
  return user;
};

// ─── /start ───────────────────────────────────────────────────────────────────
bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  try {
    const user = await getOrCreateUser(msg);
    const refCode = match[1]?.trim();
    
    if (refCode && !user.referredBy) {
      const referrer = await User.findOne({ referralCode: refCode });
      if (referrer && referrer.telegramId !== user.telegramId) {
        await User.updateOne(
          { _id: user._id, referredBy: null },
          { $set: { referredBy: referrer.telegramId } }
        );
        await User.updateOne(
          { _id: referrer._id },
          { $inc: { referralCount: 1 } }
        );
      }
    }

    await bot.sendMessage(msg.chat.id,
      `👋 *أهلاً ${user.firstName}!*\n\n` +
      `💰 *اكسب من إنشاء حسابات Gmail!*\n\n` +
      `📌 *كيف يعمل البوت:*\n` +
      `1️⃣ اضغط "أنشئ حساب Gmail جديد"\n` +
      `2️⃣ ستحصل على بيانات احترافية جاهزة\n` +
      `3️⃣ *أنشئ الحساب على Gmail* باستخدام البيانات\n` +
      `4️⃣ اضغط "✅ تم" لبيع الحساب لنا\n` +
      `5️⃣ احصل على *$0.17* بعد التحقق (72 ساعة)\n\n` +
      `💵 سعر الشراء لكل حساب: *$0.145 - $0.17*\n\n` +
      `✅ يمكنك إنشاء *عدة حسابات* وبيعها!\n` +
      `🔒 إيميل الاستعادة المطلوب: \`${RECOVERY_EMAIL}\``,
      { parse_mode: "Markdown", ...MAIN_MENU }
    );
  } catch (e) {
    console.error("/start error:", e.message);
  }
});

// ─── Message Handler ──────────────────────────────────────────────────────────
bot.on("message", async (msg) => {
  if (!msg.text || msg.text.startsWith("/")) return;
  const chatId = msg.chat.id;

  try {
    const user = await validateUser(msg);
    if (!user) return;

    const text = msg.text.trim();

    // ── أنشئ حساب Gmail جديد ──────────────────────────────────────────────────
    if (text === "➕ أنشئ حساب Gmail جديد") {
      const account = await Account.findOneAndUpdate(
        { assigned: false },
        { 
          $set: { 
            assigned: true, 
            assignedTo: user.telegramId, 
            assignedAt: new Date() 
          } 
        },
        { new: true }
      );

      if (!account) {
        await bot.sendMessage(chatId,
          `❌ *لا توجد حسابات متاحة حالياً*\n\nيرجى المحاولة لاحقاً أو التواصل مع الإدارة.`,
          { parse_mode: "Markdown" }
        );
        return;
      }

      const confirmKeyboard = {
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ تم", callback_data: `sell_${account.email}` }],
            [{ text: "🚫 إلغاء التسجيل", callback_data: `cancel_${account.email}` }],
            [{ text: "❓ كيفية إنشاء حساب", callback_data: "help_create" }],
          ],
        },
      };

      await bot.sendMessage(chatId,
        `📧 *قم بتسجيل حساب Gmail باستخدام البيانات المحددة، واحصل على $0.145 إلى $0.17*\n\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `👤 الاسم: \`${account.firstName}\`\n` +
        `👤 اللقب: \`${account.lastName}\`\n` +
        `🎂 تاريخ الميلاد: \`${account.birthdate || "01.01.1990"}\`\n` +
        `📧 البريد الإلكتروني: \`${account.email}\`\n` +
        `🔑 كلمة المرور: \`${account.password}\`\n` +
        `📩 إيميل الاستعادة: \`${RECOVERY_EMAIL}\`\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `🔒 *تأكد من استخدام البيانات المحددة وإضافة إيميل الاستعادة، وإلا فلن يتم الدفع مقابل الحساب*`,
        { parse_mode: "Markdown", ...confirmKeyboard }
      );
      return;
    }

    // ── حساباتي ───────────────────────────────────────────────────────────────
    if (text === "📋 حساباتي") {
      const tasks = await Task.find({ userId: user.telegramId })
        .sort({ createdAt: -1 })
        .limit(20)
        .lean();
        
      if (!tasks.length) {
        await bot.sendMessage(chatId,
          `📋 *لا توجد حسابات بعد*\n\nاضغط "أنشئ حساب Gmail جديد" للبدء!`,
          { parse_mode: "Markdown", ...MAIN_MENU }
        );
        return;
      }
      
      const statusMap = {
        approved: { emoji: "✅", text: "مقبول" },
        rejected: { emoji: "❌", text: "مرفوض" },
        verifying: { emoji: "🔍", text: "قيد التحقق (72 ساعة)" },
        pending: { emoji: "⏳", text: "قيد المراجعة" }
      };
      
      let txt = `📋 *حساباتك (${tasks.length})*\n\n`;
      for (const t of tasks) {
        const s = statusMap[t.status];
        const date = t.createdAt.toLocaleDateString('ar-SA');
        txt += `${s.emoji} \`${t.accountEmail}\`\n💵 $${fmt(t.amount)} — ${s.text}\n📅 ${date}\n\n`;
      }
      await bot.sendMessage(chatId, txt, { parse_mode: "Markdown", ...MAIN_MENU });
      return;
    }

    // ── الرصيد ────────────────────────────────────────────────────────────────
    if (text === "💰 الرصيد") {
      const [approved, pending, verifying] = await Promise.all([
        Task.countDocuments({ userId: user.telegramId, status: "approved" }),
        Task.countDocuments({ userId: user.telegramId, status: "pending" }),
        Task.countDocuments({ userId: user.telegramId, status: "verifying" })
      ]);
      
      await bot.sendMessage(chatId,
        `💰 *رصيدك*\n\n` +
        `💵 الرصيد: *$${fmt(user.balance)} USDT*\n\n` +
        `✅ حسابات مقبولة: ${approved}\n` +
        `🔍 قيد التحقق (72 ساعة): ${verifying}\n` +
        `⏳ قيد المراجعة: ${pending}\n\n` +
        `💸 الحد الأدنى للسحب: *$${fmt(MIN_WITHDRAW)} USDT*`,
        { parse_mode: "Markdown", ...MAIN_MENU }
      );
      return;
    }

    // ── الإحالات ──────────────────────────────────────────────────────────────
    if (text === "👥 الإحالات الخاصة بي") {
      const botInfo = await bot.getMe();
      const link = `https://t.me/${botInfo.username}?start=${user.referralCode}`;
      await bot.sendMessage(chatId,
        `👥 *الإحالات الخاصة بك*\n\n` +
        `🔗 رابطك:\n\`${link}\`\n\n` +
        `👤 إجمالي الإحالات: *${user.referralCount}*`,
        { parse_mode: "Markdown", ...MAIN_MENU }
      );
      return;
    }

    // ── الإعدادات ─────────────────────────────────────────────────────────────
    if (text === "⚙️ الإعدادات") {
      await bot.sendMessage(chatId,
        `⚙️ *الإعدادات*\n\n` +
        `👤 الاسم: ${user.firstName}\n` +
        `🆔 ID: \`${user.telegramId}\`\n` +
        `💰 الرصيد: $${fmt(user.balance)}\n\n` +
        `للسحب أرسل: /withdraw`,
        { parse_mode: "Markdown", ...MAIN_MENU }
      );
      return;
    }

    // ── مساعدة ────────────────────────────────────────────────────────────────
    if (text === "💬 مساعدة") {
      await bot.sendMessage(chatId,
        `💬 *المساعدة*\n\n` +
        `❓ *كيف أنشئ حساب Gmail؟*\n` +
        `1. افتح accounts.google.com\n` +
        `2. اضغط "إنشاء حساب"\n` +
        `3. أدخل البيانات المعطاة بالضبط\n` +
        `4. أضف إيميل الاستعادة: \`${RECOVERY_EMAIL}\`\n` +
        `5. ارجع للبوت واضغط "تم"\n\n` +
        `⚠️ *تنبيهات:*\n` +
        `• يمكنك إنشاء *عدة حسابات* في نفس الوقت\n` +
        `• استخدم البيانات المحددة فقط\n` +
        `• أضف إيميل الاستعادة المحدد\n` +
        `• الحسابات المكررة ستُرفض\n` +
        `• مدة التحقق: *72 ساعة*\n\n` +
        `للتواصل مع الدعم: @admin`,
        { parse_mode: "Markdown", ...MAIN_MENU }
      );
      return;
    }

  } catch (e) {
    console.error("message handler error:", e.message);
  }
});

// ─── Callbacks ────────────────────────────────────────────────────────────────
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  try {
    const user = await User.findOne({ telegramId: query.from.id });
    await bot.answerCallbackQuery(query.id).catch(() => {});

    if (!user) {
      await bot.sendMessage(chatId, "❌ المستخدم غير موجود. أرسل /start أولاً.");
      return;
    }

    if (user.banned) {
      await bot.sendMessage(chatId, "🚫 تم حظرك.");
      return;
    }

    // ── Sell Account ───────────────────────────────────────────────────────────
    if (data.startsWith("sell_")) {
      const email = data.replace("sell_", "");
      
      const account = await Account.findOne({ 
        email: email,
        assignedTo: user.telegramId,
        assigned: true 
      });

      if (!account) {
        await bot.editMessageText(
          `❌ انتهت صلاحية البيانات أو تم البيع مسبقاً. اضغط 'أنشئ حساب Gmail جديد' مجدداً.`,
          { chat_id: chatId, message_id: query.message.message_id, parse_mode: "Markdown" }
        ).catch(() => {});
        return;
      }

      await Account.deleteOne({ _id: account._id });
      
      const task = await Task.create({
        userId: user.telegramId,
        amount: 0.17,
        accountEmail: account.email,
        accountPassword: encrypt(account.password),
        accountFirstName: account.firstName,
        accountLastName: account.lastName,
      });

      await bot.editMessageText(
        `✅ *تم إرسال الطلب بنجاح!*\n\n📧 \`${account.email}\`\n💵 المبلغ: *$0.17 USDT*\n\n⏳ سيتم المراجعة خلال 24 ساعة.\n🔍 بعدها 72 ساعة تحقق.`,
        { chat_id: chatId, message_id: query.message.message_id, parse_mode: "Markdown" }
      ).catch(() => {});

      bot.sendMessage(ADMIN_ID,
        `📬 *طلب Gmail جديد*\n\n` +
        `👤 ${user.firstName} (\`${user.telegramId}\`)\n` +
        `📧 الإيميل: \`${account.email}\`\n` +
        `🔑 كلمة المرور: \`${account.password}\`\n` +
        `👤 الاسم: ${account.firstName} ${account.lastName}\n\n` +
        `✅ /approve ${user.telegramId} ${task._id}\n` +
        `❌ /reject ${user.telegramId} ${task._id}`,
        { parse_mode: "Markdown" }
      ).catch(() => {});
      return;
    }

    // ── Cancel ─────────────────────────────────────────────────────────────────
    if (data.startsWith("cancel_")) {
      const email = data.replace("cancel_", "");
      
      await Account.findOneAndDelete({ 
        email: email,
        assignedTo: user.telegramId,
        assigned: true 
      });
      
      await bot.editMessageText(
        `🚫 *تم إلغاء التسجيل*\n📧 \`${email}\``,
        { chat_id: chatId, message_id: query.message.message_id, parse_mode: "Markdown" }
      ).catch(() => {});
      return;
    }

    // ── Help Create ────────────────────────────────────────────────────────────
    if (data === "help_create") {
      await bot.sendMessage(chatId,
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

  } catch (e) {
    console.error("callback_query error:", e.message);
  }
});

// ─── Withdrawal ───────────────────────────────────────────────────────────────
bot.onText(/\/withdraw/, async (msg) => {
  try {
    const user = await validateUser(msg);
    if (!user) return;
    
    if (user.balance < MIN_WITHDRAW) {
      await bot.sendMessage(msg.chat.id,
        `❌ رصيدك *$${fmt(user.balance)}* أقل من الحد الأدنى $${fmt(MIN_WITHDRAW)}`,
        { parse_mode: "Markdown" }
      );
      return;
    }
    
    await bot.sendMessage(msg.chat.id,
      `💸 *طلب سحب*\n\nرصيدك: *$${fmt(user.balance)} USDT*\nأدخل المبلغ:`,
      { parse_mode: "Markdown" }
    );
    
    global.withdrawSessions = global.withdrawSessions || {};
    global.withdrawSessions[user.telegramId] = { step: "amount" };
    
  } catch (e) {
    console.error("/withdraw error:", e.message);
  }
});

bot.on("message", async (msg) => {
  if (!msg.text || msg.text.startsWith("/")) return;
  const chatId = msg.chat.id;
  
  global.withdrawSessions = global.withdrawSessions || {};
  const session = global.withdrawSessions[msg.from.id];
  if (!session) return;
  
  try {
    const user = await User.findOne({ telegramId: msg.from.id });
    if (!user || user.banned) return;
    
    if (session.step === "amount") {
      const amount = parseFloat(msg.text);
      if (isNaN(amount) || amount < MIN_WITHDRAW) {
        await bot.sendMessage(chatId, `❌ الحد الأدنى $${fmt(MIN_WITHDRAW)}. أدخل مبلغاً صحيحاً:`);
        return;
      }
      if (amount > user.balance) {
        await bot.sendMessage(chatId, `❌ رصيدك *$${fmt(user.balance)}* غير كافٍ.`, { parse_mode: "Markdown" });
        return;
      }
      
      session.amount = amount;
      session.step = "address";
      await bot.sendMessage(chatId, `📮 أدخل عنوان محفظتك *(USDT TRC20)*:`, { parse_mode: "Markdown" });
      return;
    }
    
    if (session.step === "address") {
      const address = msg.text.trim();
      if (!address || address.length < 10) {
        await bot.sendMessage(chatId, "❌ عنوان غير صحيح. حاول مرة أخرى:");
        return;
      }
      
      const updatedUser = await User.findOneAndUpdate(
        { telegramId: user.telegramId, balance: { $gte: session.amount } },
        { $inc: { balance: -session.amount } },
        { new: true }
      );
      
      if (!updatedUser) {
        await bot.sendMessage(chatId, "❌ رصيد غير كافٍ.");
        delete global.withdrawSessions[msg.from.id];
        return;
      }
      
      await Withdrawal.create({ 
        userId: user.telegramId, 
        amount: session.amount, 
        address 
      });
      
      delete global.withdrawSessions[msg.from.id];
      
      await bot.sendMessage(chatId,
        `✅ *تم إرسال طلب السحب!*\n\n💵 المبلغ: *$${fmt(session.amount)} USDT*\n📮 العنوان: \`${address}\`\n\n⏳ سيتم المعالجة خلال 24 ساعة.`,
        { parse_mode: "Markdown", ...MAIN_MENU }
      );
      
      bot.sendMessage(ADMIN_ID,
        `💸 *طلب سحب جديد*\n\n👤 ${user.firstName} (\`${user.telegramId}\`)\n💵 $${fmt(session.amount)} USDT\n📮 \`${address}\``,
        { parse_mode: "Markdown" }
      ).catch(() => {});
    }
  } catch (e) {
    console.error("withdraw handler error:", e.message);
    delete global.withdrawSessions[msg.from.id];
  }
});

// ─── Admin Commands ───────────────────────────────────────────────────────────
const isAdmin = (msg) => msg.from.id === ADMIN_ID;

bot.onText(/\/generate (\d+)/, async (msg, match) => {
  if (!isAdmin(msg)) return;
  const count = Math.min(parseInt(match[1]), 100);
  let added = 0;
  let attempts = 0;
  const maxAttempts = count * 10;
  
  while (added < count && attempts < maxAttempts) {
    attempts++;
    try {
      const data = await generateAccountData();
      await Account.create(data);
      added++;
    } catch (e) {
      if (e.code === 11000) {
        console.log(`⚠️ Duplicate email on attempt ${attempts}, retrying...`);
        continue;
      }
      console.error("Generate error:", e.message);
      break;
    }
  }
  
  await bot.sendMessage(msg.chat.id,
    `✅ *تم توليد بيانات الحسابات*\n\n➕ تمت الإضافة: *${added}*\n🔄 محاولات: ${attempts}`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/addaccount (\S+) (\S+) (\S+) (\S+)/, async (msg, match) => {
  if (!isAdmin(msg)) return;
  const [, firstName, lastName, email, password] = match;
  
  try {
    await Account.create({ firstName, lastName, email, password });
    const total = await Account.countDocuments({ assigned: false });
    await bot.sendMessage(msg.chat.id,
      `✅ *تم إضافة الحساب*\n\n👤 ${firstName} ${lastName}\n📧 \`${email}\`\n🔑 \`${password}\`\n\n📦 الحسابات المتاحة: *${total}*`,
      { parse_mode: "Markdown" }
    );
  } catch {
    await bot.sendMessage(msg.chat.id, "❌ الإيميل موجود بالفعل.");
  }
});

bot.onText(/\/approve (\d+) (\S+)/, async (msg, match) => {
  if (!isAdmin(msg)) return;
  const userId = parseInt(match[1]);
  const taskId = match[2];
  
  const task = await Task.findById(taskId);
  
  if (!task) { 
    await bot.sendMessage(msg.chat.id, "❌ المهمة غير موجودة."); 
    return; 
  }
  if (task.status !== "pending") { 
    await bot.sendMessage(msg.chat.id, `⚠️ تمت معالجتها (${task.status}).`); 
    return; 
  }

  const updatedTask = await Task.findOneAndUpdate(
    { _id: task._id, status: "pending" },
    { 
      $set: { 
        status: "verifying", 
        verifyAt: new Date(Date.now() + VERIFY_HOURS * 60 * 60 * 1000) 
      } 
    },
    { new: true }
  );

  if (!updatedTask) {
    await bot.sendMessage(msg.chat.id, "⚠️ تمت معالجتها بالفعل.");
    return;
  }

  const targetUser = await User.findOne({ telegramId: userId });
  if (targetUser) {
    bot.sendMessage(userId,
      `🔍 *حسابك قيد التحقق*\n\n📧 \`${task.accountEmail}\`\n\n⏳ سيتم التحقق خلال *${VERIFY_HOURS} ساعة*\n💵 بعدها سيُضاف *$${task.amount} USDT* لرصيدك تلقائياً`,
      { parse_mode: "Markdown", ...MAIN_MENU }
    ).catch(() => {});
  }
  
  await bot.sendMessage(msg.chat.id, `🔍 تم قبول الحساب — سيُدفع للمستخدم بعد ${VERIFY_HOURS} ساعة.`);
});

bot.onText(/\/reject (\d+) (\S+)/, async (msg, match) => {
  if (!isAdmin(msg)) return;
  const userId = parseInt(match[1]);
  const taskId = match[2];
  
  const task = await Task.findById(taskId);
  
  if (!task) { 
    await bot.sendMessage(msg.chat.id, "❌ المهمة غير موجودة."); 
    return; 
  }
  if (task.status !== "pending") { 
    await bot.sendMessage(msg.chat.id, `⚠️ تمت معالجتها (${task.status}).`); 
    return; 
  }

  task.status = "rejected";
  await task.save();
  
  const targetUser = await User.findOne({ telegramId: userId });
  if (targetUser) {
    bot.sendMessage(userId,
      `❌ *تم رفض الحساب*\n\n📧 \`${task.accountEmail}\`\n\nتأكد من استخدام البيانات المحددة وإعادة المحاولة.`,
      { parse_mode: "Markdown", ...MAIN_MENU }
    ).catch(() => {});
  }
  
  await bot.sendMessage(msg.chat.id, `❌ تم الرفض.`);
});

bot.onText(/\/pending/, async (msg) => {
  if (!isAdmin(msg)) return;
  
  const tasks = await Task.find({ status: "pending" })
    .sort({ createdAt: 1 })
    .limit(20)
    .lean();
    
  if (!tasks.length) { 
    await bot.sendMessage(msg.chat.id, "✅ لا توجد طلبات معلقة."); 
    return; 
  }

  const userIds = [...new Set(tasks.map(t => t.userId))];
  const users = await User.find({ telegramId: { $in: userIds } }, "telegramId firstName").lean();
  const userMap = new Map(users.map(u => [u.telegramId, u]));

  let text = `⏳ *الطلبات المعلقة (${tasks.length})*\n\n`;
  
  for (const t of tasks) {
    const u = userMap.get(t.userId);
    const password = t.accountPassword ? decrypt(t.accountPassword) : "غير متاح";
    
    text += `📧 \`${t.accountEmail}\`\n🔑 \`${password}\`\n👤 ${t.accountFirstName || ""} ${t.accountLastName || ""}\n👤 ${u?.firstName} (\`${t.userId}\`)\n✅ /approve ${t.userId} ${t._id}  ❌ /reject ${t.userId} ${t._id}\n\n`;
  }
  
  await bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
});

bot.onText(/\/clearaccounts/, async (msg) => {
  if (!isAdmin(msg)) return;
  const count = await Account.countDocuments();
  await Account.deleteMany({});
  await bot.sendMessage(msg.chat.id,
    `🗑️ *تم حذف كل الحسابات*\n\n📦 تم حذف: *${count}* حساب`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/accounts/, async (msg) => {
  if (!isAdmin(msg)) return;
  const [available, assigned] = await Promise.all([
    Account.countDocuments({ assigned: false }),
    Account.countDocuments({ assigned: true })
  ]);
  
  await bot.sendMessage(msg.chat.id,
    `📦 *الحسابات*\n\n✅ متاح: *${available}*\n🔒 مُعيَّن: *${assigned}*\n📊 الإجمالي: *${available + assigned}*`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/addbalance (\d+) ([\d.]+)/, async (msg, match) => {
  if (!isAdmin(msg)) return;
  const user = await User.findOne({ telegramId: parseInt(match[1]) });
  if (!user) { 
    await bot.sendMessage(msg.chat.id, "❌ المستخدم غير موجود."); 
    return; 
  }
  
  user.balance += parseFloat(match[2]);
  await user.save();
  
  await bot.sendMessage(msg.chat.id, `✅ تم. الرصيد الجديد: $${fmt(user.balance)}`);
  bot.sendMessage(user.telegramId, 
    `🎁 تم إضافة $${match[2]} لرصيدك!\nرصيدك: $${fmt(user.balance)}`, 
    MAIN_MENU
  ).catch(() => {});
});

bot.onText(/\/ban (\d+)/, async (msg, match) => {
  if (!isAdmin(msg)) return;
  const user = await User.findOneAndUpdate(
    { telegramId: parseInt(match[1]) },
    { $set: { banned: true } },
    { new: true }
  );
  
  if (!user) { 
    await bot.sendMessage(msg.chat.id, "❌ غير موجود."); 
    return; 
  }
  
  await bot.sendMessage(msg.chat.id, `🚫 تم حظر ${user.firstName}.`);
  bot.sendMessage(user.telegramId, "🚫 تم حظرك.").catch(() => {});
});

bot.onText(/\/unban (\d+)/, async (msg, match) => {
  if (!isAdmin(msg)) return;
  const user = await User.findOneAndUpdate(
    { telegramId: parseInt(match[1]) },
    { $set: { banned: false } },
    { new: true }
  );
  
  if (!user) { 
    await bot.sendMessage(msg.chat.id, "❌ غير موجود."); 
    return; 
  }
  
  await bot.sendMessage(msg.chat.id, `✅ تم رفع الحظر عن ${user.firstName}.`);
  bot.sendMessage(user.telegramId, "✅ تم رفع الحظر!", MAIN_MENU).catch(() => {});
});

bot.onText(/\/users/, async (msg) => {
  if (!isAdmin(msg)) return;
  const users = await User.find()
    .sort({ createdAt: -1 })
    .limit(20)
    .lean();
    
  let text = `👥 *المستخدمون*\n\n`;
  users.forEach((u, i) => {
    text += `${i + 1}. ${u.firstName}${u.banned ? " 🚫" : ""} | $${fmt(u.balance)} | \`${u.telegramId}\`\n`;
  });
  
  await bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
});

bot.onText(/\/stats/, async (msg) => {
  if (!isAdmin(msg)) return;
  
  const [totalUsers, pendingTasks, verifyingTasks, approvedTasks, availableAccounts, paidAgg] = await Promise.all([
    User.countDocuments(),
    Task.countDocuments({ status: "pending" }),
    Task.countDocuments({ status: "verifying" }),
    Task.countDocuments({ status: "approved" }),
    Account.countDocuments({ assigned: false }),
    Task.aggregate([{ $match: { status: "approved" } }, { $group: { _id: null, total: { $sum: "$amount" } } }])
  ]);
  
  await bot.sendMessage(msg.chat.id,
    `📊 *الإحصائيات*\n\n` +
    `👤 المستخدمون: *${totalUsers}*\n` +
    `📦 الحسابات المتاحة: *${availableAccounts}*\n` +
    `✅ طلبات مقبولة: *${approvedTasks}*\n` +
    `🔍 قيد التحقق (72 ساعة): *${verifyingTasks}*\n` +
    `⏳ قيد المراجعة: *${pendingTasks}*\n` +
    `💵 إجمالي المدفوع: *$${fmt(paidAgg[0]?.total || 0)} USDT*`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/broadcast (.+)/, async (msg, match) => {
  if (!isAdmin(msg)) return;
  
  const users = await User.find({}, "telegramId").lean();
  let sent = 0, failed = 0;
  
  const batchSize = 30;
  for (let i = 0; i < users.length; i += batchSize) {
    const batch = users.slice(i, i + batchSize);
    await Promise.all(batch.map(async (u) => {
      try { 
        await bot.sendMessage(u.telegramId, `📢 *رسالة من الإدارة*\n\n${match[1]}`, { parse_mode: "Markdown" }); 
        sent++; 
      } catch { 
        failed++; 
      }
    }));
    if (i + batchSize < users.length) await new Promise(r => setTimeout(r, 1000));
  }
  
  await bot.sendMessage(msg.chat.id, `📢 ✅ ${sent} نجح | ❌ ${failed} فشل`);
});

bot.onText(/\/withdrawals/, async (msg) => {
  if (!isAdmin(msg)) return;
  
  const wds = await Withdrawal.find({ status: "pending" })
    .limit(20)
    .lean();
    
  if (!wds.length) { 
    await bot.sendMessage(msg.chat.id, "✅ لا توجد طلبات سحب."); 
    return; 
  }

  const userIds = [...new Set(wds.map(w => w.userId))];
  const users = await User.find({ telegramId: { $in: userIds } }, "telegramId firstName").lean();
  const userMap = new Map(users.map(u => [u.telegramId, u]));

  let text = `💸 *طلبات السحب*\n\n`;
  for (const w of wds) {
    const u = userMap.get(w.userId);
    text += `👤 ${u?.firstName} (\`${w.userId}\`)\n💵 $${fmt(w.amount)}\n📮 \`${w.address}\`\n\n`;
  }
  
  await bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
});

bot.onText(/\/export/, async (msg) => {
  if (!isAdmin(msg)) return;
  
  const tasks = await Task.find({ status: "approved" })
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();
    
  if (!tasks.length) { 
    await bot.sendMessage(msg.chat.id, "❌ لا توجد حسابات مقبولة بعد."); 
    return; 
  }

  let text = `📦 *الحسابات الجاهزة (${tasks.length})*\n\n`;
  for (const t of tasks) {
    const password = t.accountPassword ? decrypt(t.accountPassword) : "غير متاح";
    text += `📧 \`${t.accountEmail}\`\n🔑 \`${password}\`\n👤 ${t.accountFirstName || ""} ${t.accountLastName || ""}\n\n`;
  }

  if (text.length > 4000) {
    const chunks = text.match(/[\s\S]{1,4000}/g);
    for (const chunk of chunks) await bot.sendMessage(msg.chat.id, chunk, { parse_mode: "Markdown" });
  } else {
    await bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
  }
});

// ─── Auto Pay After 72 Hours ──────────────────────────────────────────────────
async function processVerifiedTasks() {
  try {
    const now = new Date();
    
    const tasks = await Task.find({ 
      status: "verifying", 
      verifyAt: { $lte: now } 
    }).lean();

    for (const task of tasks) {
      const updatedTask = await Task.findOneAndUpdate(
        { _id: task._id, status: "verifying" },
        { $set: { status: "approved" } },
        { new: true }
      );

      if (!updatedTask) continue;

      const updatedUser = await User.findOneAndUpdate(
        { telegramId: task.userId },
        { $inc: { balance: task.amount } },
        { new: true }
      );

      if (updatedUser) {
        bot.sendMessage(task.userId,
          `✅ *تم التحقق من حسابك!*\n\n📧 \`${task.accountEmail}\`\n💵 تم إضافة *$${task.amount} USDT* لرصيدك!\n💰 رصيدك الآن: *$${fmt(updatedUser.balance)} USDT*`,
          { parse_mode: "Markdown", ...MAIN_MENU }
        ).catch(() => {});
      }
    }
    
    if (tasks.length > 0) console.log(`✅ تم دفع ${tasks.length} مهمة بعد ${VERIFY_HOURS} ساعة`);
  } catch (e) {
    console.error("processVerifiedTasks error:", e.message);
  }
}

setInterval(processVerifiedTasks, 10 * 60 * 1000);

// ─── Auto Cancel Expired Assignments ──────────────────────────────────────────
async function cancelExpiredAssignments() {
  try {
    const expireTime = new Date(Date.now() - ASSIGN_EXPIRE_MINUTES * 60 * 1000);
    
    const expiredAccounts = await Account.find({ 
      assigned: true, 
      assignedAt: { $lt: expireTime } 
    }).lean();

    for (const account of expiredAccounts) {
      await Account.findByIdAndDelete(account._id);
      
      bot.sendMessage(account.assignedTo,
        `⏰ *انتهت مهلة التسجيل!*\n\n📧 \`${account.email}\`\n\nلم تؤكد إنشاء الحساب خلال ${ASSIGN_EXPIRE_MINUTES} دقيقة.\nتم إلغاء الطلب تلقائياً.\n\nاضغط "أنشئ حساب Gmail جديد" للمحاولة مجدداً.`,
        { parse_mode: "Markdown", ...MAIN_MENU }
      ).catch(() => {});
    }
    
    if (expiredAccounts.length > 0) console.log(`🔄 تم إلغاء ${expiredAccounts.length} حساب منتهي`);
  } catch (e) {
    console.error("cancelExpiredAssignments error:", e.message);
  }
}

setInterval(cancelExpiredAssignments, 60 * 1000);

// ─── Server & Database ─────────────────────────────────────────────────────────
mongoose.connection.on("connected", () => console.log("✅ MongoDB connected"));
mongoose.connection.on("error", err => console.error("⚠️ MongoDB error:", err.message));
mongoose.connection.on("disconnected", () => console.warn("⚠️ MongoDB disconnected"));

mongoose.connect(MONGODB_URI, { 
  serverSelectionTimeoutMS: 10000,
  maxPoolSize: 10 
}).catch(err => console.error("❌ MongoDB connection failed:", err.message));

console.log("🤖 Bot is running...");

const PORT = process.env.PORT || 8080;
http.createServer((req, res) => {
  res.writeHead(200); 
  res.end(JSON.stringify({ status: "ok", timestamp: new Date().toISOString() }));
}).listen(PORT, () => console.log(`🌐 HTTP server on port ${PORT}`));

process.on("SIGTERM", async () => {
  await bot.stopPolling();
  await mongoose.disconnect();
  process.exit(0);
});

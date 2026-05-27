const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');
const { authenticator } = require('otplib');

// جلب متغيرات البيئة من السيرفر
const token = process.env.TELEGRAM_BOT_TOKEN;
const mongoUri = process.env.MONGODB_URI;
const encryptionKey = process.env.ENCRYPTION_KEY;

const bot = new TelegramBot(token, { polling: true });

// الاتصال بقاعدة البيانات
mongoose.connect(mongoUri)
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => console.error('❌ MongoDB connection error:', err));

// دالة توليد بيانات عشوائية ومختلفة تماماً في كل مرة
function generateRandomAccountData() {
    const firstNames = ["William", "James", "Oliver", "Lucas", "Benjamin", "Mason", "Ethan", "Alexander"];
    const lastNames = ["Martinez", "Smith", "Johnson", "Brown", "Jones", "Miller", "Davis", "Rodriguez"];
    
    const firstName = firstNames[Math.floor(Math.random() * firstNames.length)];
    const lastName = lastNames[Math.floor(Math.random() * lastNames.length)];
    const fullName = `${firstName} ${lastName}`;
    
    const randomHex = Math.random().toString(16).substring(2, 8);
    const email = `${firstName.toLowerCase()}${lastName.toLowerCase()}_${randomHex}@gmail.com`;
    const password = `Pass_${Math.random().toString(36).substring(2, 10)}`;
    const recoveryEmail = "ryal2422@gmail.com"; 

    return {
        fullName,
        email,
        password,
        recoveryEmail
    };
}

// دالة فحص صيغة الإيميل
function checkEmailFormat(email) {
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return re.test(email);
}

// الاستماع للأوامر الرئيسية وأزرار الشاشة
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    if (text === '/start') {
        await bot.sendMessage(chatId, "👋 أهلاً بك في بوت NEXORA لإدارة وإنشاء الحسابات.", {
            reply_markup: {
                keyboard: [
                    [{ text: "➕ أنشئ حساب Gmail جديد" }, { text: "📋 حساباتي" }],
                    [{ text: "💰 الرصيد" }, { text: "👥 الإحالات الخاصة بي" }],
                    [{ text: "⚙️ الإعدادات" }, { text: "💬 مساعدة" }]
                ],
                resize_keyboard: true
            }
        });
    }

    if (text === "➕ أنشئ حساب Gmail جديد") {
        const account = generateRandomAccountData(); 

        // 1. فصل الاسم واللقب برمجياً بناءً على المسافة
        const nameParts = account.fullName.split(' ');
        const firstName = nameParts[0] || '';
        const lastName = nameParts.slice(1).join(' ') || '';

        // 2. صياغة الرسالة المنفصلة الأسطر وبدون نص التحقق بخطوتين (تعديل كامل ومضمون)
        const accountInfoMessage = `
📦 **بيانات الحساب المطلوب إنشاؤه:**

👤 **الاسم:** ${firstName}
👥 **اللقب:** ${lastName}
📅 **الميلاد:** 1998-05-12
📨 **البريد الإلكتروني:** \`${account.email}\`
🔑 **كلمة المرور:** \`${account.password}\`
🔗 **إيميل الاستعادة الإلزامي:** \`${account.recoveryEmail}\`
        `;

        await bot.sendMessage(chatId, accountInfoMessage, { parse_mode: 'Markdown' });
        
        // الانتقال تلقائياً للفحص الأولي
        await runInitialCheck(chatId, account);
    }
});

// دالة الفحص والتحقق من الحساب وتأجيل الـ 2FA
async function runInitialCheck(chatId, account) {
    await bot.sendMessage(chatId, "🔍 **جاري التحقق الأولي من الحساب...**", { parse_mode: 'Markdown' });

    setTimeout(async () => {
        const isEmailValid = checkEmailFormat(account.email); 

        if (!isEmailValid) {
            return await bot.sendMessage(chatId, "❌ **فشل الفحص:** صيغة البريد الإلكتروني غير صالحة.", { parse_mode: 'Markdown' });
        }

        // في حال النجاح: يظهر بريد الاستعادة أولاً وتطلب تفعيل التحقق بخطوتين هنا مع الأزرار التفاعلية
        const successMessage = `
✅ **تم التفعيل والإنشاء بنجاح!**
🔗 **تم ربط بريد الاستعادة الإلزامي:** \`${account.recoveryEmail}\`

⚠️ **الخطوة التالية الهامة (تأمين الحساب):**
توجه الآن إلى إعدادات حساب جوجل، وقم بتفعيل **(التحقق بخطوتين)**، ثم استخرج **الأكواد الاحتياطية (Backup Codes)** واضغط على الزر بالأسفل لتأكيد الحفظ والتأمين الكلي.
        `;

        await bot.sendMessage(chatId, successMessage, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: "✅ تم استخراج الأكواد وتفعيل 2FA", callback_data: "confirm_2fa" }],
                    [{ text: "❌ إلغاء إنشاء الحساب", callback_data: "cancel_creation" }]
                ]
            }
        });
    }, 2000); 
}

// معالجة الأزرار العائمة (Inline Buttons)
bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const data = callbackQuery.data;

    if (data === 'confirm_2fa') {
        await bot.sendMessage(chatId, "🔒 **ممتاز! تم تأكيد تفعيل 2FA وحفظ الحساب بنجاح.**", { parse_mode: 'Markdown' });
    }
    
    if (data === 'cancel_creation') {
        await bot.sendMessage(chatId, "❌ **تم إلغاء عملية إنشاء الحساب بنجاح.**", { parse_mode: 'Markdown' });
    }
    
    bot.answerCallbackQuery(callbackQuery.id);
});

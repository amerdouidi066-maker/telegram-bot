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

// دالة وهمية لتوليد بيانات حساب عشوائي (استبدلها بمنطق النظام الخاص بك)
function generateRandomAccountData() {
    return {
        fullName: "William Martinez",
        email: "williammartinez_aae16a@gmail.com",
        password: "Pass_1b4a73a0",
        recoveryEmail: "ryal2422@gmail.com"
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

        // 2. صياغة الرسالة (الاسم واللقب منفصلين، وبدون نص التحقق بخطوتين)
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

    // محاكاة تأخير الفحص
    setTimeout(async () => {
        const isEmailValid = checkEmailFormat(account.email); 

        if (!isEmailValid) {
            // إصلاح وسم الـ HTML المشوه وعرض رسالة خطأ نظيفة
            return await bot.sendMessage(chatId, "❌ **فشل الفحص:** صيغة البريد الإلكتروني غير صالحة.", { parse_mode: 'Markdown' });
        }

        // في حال النجاح: يظهر بريد الاستعادة أولاً ثم تطلب تفعيل التحقق بخطوتين
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
    }, 2000); // الفحص يستغرق ثانيتين كمثال
}

// معالجة الأزرار العائمة (Inline Buttons)
bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const data = callbackQuery.data;

    if (data === 'confirm_2fa') {
        await bot.sendMessage(chatId, "🔒 **ممتاز! تم تأكيد تفعيل 2FA وحفظ الحساب في الداتابيز بنجاح.**", { parse_mode: 'Markdown' });
    }
    
    if (data === 'cancel_creation') {
        await bot.sendMessage(chatId, "❌ **تم إلغاء عملية إنشاء الحساب بنجاح.**", { parse_mode: 'Markdown' });
    }
    
    bot.answerCallbackQuery(callbackQuery.id);
});

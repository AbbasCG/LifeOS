<?php

namespace Database\Seeders\Demo;

/**
 * Hand-written, bilingual demo content for a product designer who also studies data science, trains for a
 * half marathon, saves for an emergency fund and is learning Arabic calligraphy. Every entry is [en, ar].
 * Relative dates (days from "today" in the demo user's timezone) keep the demo fresh whenever it is seeded.
 */
class DemoContent
{
    /** @var array<string, array{0: string, 1: string, 2: string}> key => [en, ar, color] */
    public const CATEGORIES = [
        'work' => ['Work', 'العمل', '#4f46e5'],
        'study' => ['Study', 'الدراسة', '#0ea5e9'],
        'health' => ['Health', 'الصحة', '#16a34a'],
        'personal' => ['Personal', 'شخصي', '#f59e0b'],
        'finance' => ['Finance', 'المال', '#db2777'],
    ];

    /**
     * key => [en, ar, description en, description ar, color, status, due (days), milestones [[en, ar, done]]]
     *
     * @var array<string, array<int, mixed>>
     */
    public const PROJECTS = [
        'website' => ['Website redesign', 'إعادة تصميم الموقع', 'New marketing site with a design system and faster pages.', 'موقع تسويقي جديد بنظام تصميم وصفحات أسرع.', '#4f46e5', 'active', 24, [['Discovery & interviews', 'الاستكشاف والمقابلات', true], ['Wireframes approved', 'اعتماد المخططات', true], ['Visual design', 'التصميم المرئي', false], ['Launch', 'الإطلاق', false]]],
        'reporting' => ['Q4 client reporting', 'تقارير العملاء للربع الرابع', 'Quarterly dashboards and the executive summary for three clients.', 'لوحات ربع سنوية وملخص تنفيذي لثلاثة عملاء.', '#7c3aed', 'active', 9, [['Collect data', 'جمع البيانات', true], ['Draft dashboards', 'مسودة اللوحات', false], ['Executive summary', 'الملخص التنفيذي', false]]],
        'certificate' => ['Data science certificate', 'شهادة علم البيانات', 'Ten-module online programme with a capstone project.', 'برنامج إلكتروني من عشر وحدات مع مشروع تخرج.', '#0ea5e9', 'active', 40, [['Python foundations', 'أساسيات بايثون', true], ['Statistics', 'الإحصاء', true], ['Machine learning', 'تعلم الآلة', true], ['Capstone', 'مشروع التخرج', false]]],
        'app' => ['Habit tracker app', 'تطبيق تتبع العادات', 'Weekend side project: a small React Native app.', 'مشروع جانبي في عطلات نهاية الأسبوع: تطبيق React Native صغير.', '#14b8a6', 'active', 60, [['Prototype', 'النموذج الأولي', true], ['Sync & auth', 'المزامنة وتسجيل الدخول', false], ['Beta test', 'اختبار تجريبي', false]]],
        'marathon' => ['Half-marathon training', 'التدريب لنصف الماراثون', '12-week plan towards the city half marathon.', 'خطة من ١٢ أسبوعاً لنصف ماراثون المدينة.', '#16a34a', 'active', 45, [['Base mileage', 'المسافة الأساسية', true], ['Tempo block', 'مرحلة السرعة', false], ['Taper & race', 'التخفيف والسباق', false]]],
        'office' => ['Home office setup', 'تجهيز المكتب المنزلي', 'Desk, lighting and cable management.', 'مكتب وإضاءة وتنظيم الأسلاك.', '#f59e0b', 'completed', -12, [['Order desk', 'طلب المكتب', true], ['Lighting', 'الإضاءة', true], ['Cable management', 'تنظيم الأسلاك', true]]],
        'fund' => ['Emergency fund', 'صندوق الطوارئ', 'Six months of expenses in a separate savings account.', 'مصاريف ستة أشهر في حساب ادخار منفصل.', '#db2777', 'active', 120, [['Budget review', 'مراجعة الميزانية', true], ['Automate transfers', 'أتمتة التحويلات', true], ['Reach €6,000', 'الوصول إلى ٦٠٠٠ يورو', false]]],
        'calligraphy' => ['Arabic calligraphy course', 'دورة الخط العربي', 'Naskh basics with a weekly evening class.', 'أساسيات خط النسخ مع درس مسائي أسبوعي.', '#a16207', 'paused', 75, [['Tools & posture', 'الأدوات والجلسة', true], ['Single letters', 'الحروف المفردة', false], ['Connected words', 'الكلمات المتصلة', false]]],
    ];

    /**
     * key => [en, ar, target, progress, due (days), color]
     *
     * @var array<string, array<int, mixed>>
     */
    /** goal key => [[en, ar, done]] */
    public const GOAL_MILESTONES = [
        'half' => [['Run 10 km without stopping', 'الركض ١٠ كم دون توقف', true], ['Run 16 km', 'الركض ١٦ كم', true], ['Run 19 km at race pace', 'الركض ١٩ كم بسرعة السباق', false], ['Race day', 'يوم السباق', false]],
        'app' => [['Clickable prototype', 'نموذج أولي تفاعلي', true], ['Offline sync', 'المزامنة دون اتصال', false], ['Recruit 20 beta testers', 'استقطاب ٢٠ مختبراً تجريبياً', false], ['Store listing and screenshots', 'صفحة المتجر واللقطات', false]],
        'blog' => [['Pick six topics', 'اختيار ستة مواضيع', true], ['Article on design tokens', 'مقال عن رموز التصميم', true], ['Article on accessible colour', 'مقال عن الألوان سهلة الوصول', false], ['Article on Arabic typography', 'مقال عن الطباعة العربية', false]],
        'promotion' => [['Lead the redesign launch', 'قيادة إطلاق إعادة التصميم', false], ['Mentor a junior designer', 'توجيه مصمم مبتدئ', true], ['Present the design system to leadership', 'عرض نظام التصميم على الإدارة', false]],
    ];

    /** [en, ar] */
    public const FOCUS_NOTES = [
        ['Got through the hardest part; next step is clear.', 'تجاوزت الجزء الأصعب؛ الخطوة التالية واضحة.'],
        ['Phone in another room helped a lot.', 'إبعاد الهاتف إلى غرفة أخرى ساعد كثيراً.'],
        ['Started slow, found flow after 20 minutes.', 'بداية بطيئة، ثم تركيز كامل بعد ٢٠ دقيقة.'],
        ['Need data from Sam before continuing.', 'أحتاج بيانات من سام قبل المتابعة.'],
    ];

    /** [en, ar] */
    public const REFLECTIONS = [
        ['Good morning block; afternoon meetings drained me.', 'فترة صباحية جيدة؛ اجتماعات الظهيرة أرهقتني.'],
        ['Slept badly, kept tasks small.', 'نمت بشكل سيئ، فأبقيت المهام صغيرة.'],
        ['Long run in the morning, sharp all day.', 'جري طويل صباحاً، وتركيز عالٍ طوال اليوم.'],
        ['Too much context switching.', 'تنقل كثير بين المهام.'],
        ['Finished early and read for an hour.', 'أنهيت مبكراً وقرأت لمدة ساعة.'],
    ];

    public const GOALS = [
        'promotion' => ['Get promoted to senior designer', 'الترقية إلى مصمم أول', 100, 65, 150, '#4f46e5'],
        'certificate' => ['Finish the data science certificate', 'إكمال شهادة علم البيانات', 10, 9, 40, '#0ea5e9'],
        'books' => ['Read 24 books this year', 'قراءة ٢٤ كتاباً هذا العام', 24, 21, 68, '#8b5cf6'],
        'half' => ['Run a half marathon', 'الركض في نصف ماراثون', 21, 14, 45, '#16a34a'],
        'workouts' => ['150 workouts this year', '١٥٠ تمريناً هذا العام', 150, 118, 68, '#22c55e'],
        'fund' => ['Save €6,000 emergency fund', 'ادخار ٦٠٠٠ يورو للطوارئ', 6000, 4200, 120, '#db2777'],
        'debt' => ['Pay off the car loan', 'سداد قرض السيارة', 100, 40, 300, '#be185d'],
        'meditation' => ['Meditate 100 days', 'التأمل ١٠٠ يوم', 100, 63, 50, '#06b6d4'],
        'blog' => ['Publish 6 design articles', 'نشر ٦ مقالات عن التصميم', 6, 2, 90, '#f97316'],
        'app' => ['Launch the habit tracker beta', 'إطلاق النسخة التجريبية من تطبيق العادات', 100, 30, 60, '#14b8a6'],
    ];

    /**
     * key => [en, ar, recurrence, routine, pattern] — pattern: success rate per 100 and the current streak in periods.
     *
     * @var array<string, array<int, mixed>>
     */
    public const HABITS = [
        'water' => ['Drink 2 litres of water', 'شرب لترين من الماء', 'daily', 'morning', 90, 12],
        'reading' => ['Read 20 pages', 'قراءة ٢٠ صفحة', 'daily', 'evening', 80, 9],
        'meditate' => ['Meditate 10 minutes', 'التأمل ١٠ دقائق', 'daily', 'morning', 75, 23],
        'steps' => ['Walk 8,000 steps', 'المشي ٨٠٠٠ خطوة', 'daily', 'anytime', 70, 4],
        'journal' => ['Evening journal', 'تدوين المساء', 'daily', 'evening', 55, 0],
        'nophone' => ['No phone after 22:00', 'لا هاتف بعد الساعة ٢٢', 'daily', 'evening', 50, 2],
        'stretch' => ['Stretch after work', 'تمارين الإطالة بعد العمل', 'daily', 'evening', 65, 0],
        'arabic' => ['Calligraphy practice', 'تمرين الخط', 'weekly', 'weekend', 80, 3],
        'budget' => ['Weekly budget check', 'مراجعة الميزانية الأسبوعية', 'weekly', 'weekend', 90, 6],
        'longrun' => ['Long run', 'الجري لمسافة طويلة', 'weekly', 'weekend', 85, 5],
    ];

    /**
     * [en, ar, project, goal, category, priority, estimate, state, tags]
     * state: done:N (completed N days ago), open:N (due in N days), overdue:N (due N days ago), doing:N (in progress, due in N),
     * inbox, someday (todo, no date), cancelled, daily:N / weekly:N (recurring, due in N days).
     *
     * @var list<array<int, mixed>>
     */
    public const TASKS = [
        // Website redesign
        ['Interview five customers', 'مقابلة خمسة عملاء', 'website', 'promotion', 'work', 'high', 240, 'done:18', ['research']],
        ['Synthesize interview notes', 'تلخيص ملاحظات المقابلات', 'website', 'promotion', 'work', 'medium', 120, 'done:15', ['research']],
        ['Sitemap and content inventory', 'خريطة الموقع وجرد المحتوى', 'website', null, 'work', 'medium', 90, 'done:13', []],
        ['Wireframes for the home page', 'مخططات الصفحة الرئيسية', 'website', 'promotion', 'work', 'high', 180, 'done:9', ['design']],
        ['Wireframe review with marketing', 'مراجعة المخططات مع التسويق', 'website', null, 'work', 'medium', 60, 'done:7', ['meeting']],
        ['Design system: colour and type tokens', 'نظام التصميم: ألوان وخطوط', 'website', 'promotion', 'work', 'high', 150, 'done:3', ['design']],
        ['Design system: components', 'نظام التصميم: المكونات', 'website', 'promotion', 'work', 'high', 300, 'doing:4', ['design']],
        ['Home page visual design', 'التصميم المرئي للصفحة الرئيسية', 'website', 'promotion', 'work', 'urgent', 240, 'open:2', ['design']],
        ['Pricing page copy review', 'مراجعة نص صفحة الأسعار', 'website', null, 'work', 'medium', 45, 'open:6', ['content']],
        ['Accessibility audit of prototypes', 'تدقيق إمكانية الوصول للنماذج', 'website', null, 'work', 'medium', 90, 'open:10', ['a11y']],
        ['Hand-off notes for developers', 'ملاحظات التسليم للمطورين', 'website', null, 'work', 'low', 60, 'open:16', []],
        ['Launch checklist', 'قائمة الإطلاق', 'website', null, 'work', 'low', 30, 'someday', []],
        // Q4 reporting
        ['Export analytics for client A', 'تصدير تحليلات العميل أ', 'reporting', null, 'work', 'medium', 60, 'done:6', ['data']],
        ['Export analytics for client B', 'تصدير تحليلات العميل ب', 'reporting', null, 'work', 'medium', 60, 'done:5', ['data']],
        ['Clean revenue spreadsheet', 'تنظيف جدول الإيرادات', 'reporting', null, 'work', 'high', 90, 'overdue:2', ['data']],
        ['Draft Q4 dashboards', 'مسودة لوحات الربع الرابع', 'reporting', 'promotion', 'work', 'urgent', 180, 'doing:1', ['data']],
        ['Executive summary slides', 'شرائح الملخص التنفيذي', 'reporting', 'promotion', 'work', 'high', 120, 'open:3', ['slides']],
        ['Send reports to clients', 'إرسال التقارير للعملاء', 'reporting', null, 'work', 'high', 30, 'open:8', []],
        ['Invoice client C', 'إصدار فاتورة للعميل ج', 'reporting', null, 'finance', 'urgent', 20, 'overdue:4', ['admin']],
        // Certificate
        ['Module 7: model evaluation', 'الوحدة ٧: تقييم النماذج', 'certificate', 'certificate', 'study', 'medium', 180, 'done:20', ['course']],
        ['Module 8: feature engineering', 'الوحدة ٨: هندسة الخصائص', 'certificate', 'certificate', 'study', 'medium', 180, 'done:12', ['course']],
        ['Module 9: clustering', 'الوحدة ٩: التجميع', 'certificate', 'certificate', 'study', 'medium', 150, 'done:4', ['course']],
        ['Module 9 quiz', 'اختبار الوحدة ٩', 'certificate', 'certificate', 'study', 'high', 45, 'done:2', ['course']],
        ['Capstone: choose a dataset', 'مشروع التخرج: اختيار البيانات', 'certificate', 'certificate', 'study', 'high', 60, 'doing:2', ['capstone']],
        ['Capstone: exploratory analysis', 'مشروع التخرج: التحليل الاستكشافي', 'certificate', 'certificate', 'study', 'high', 240, 'open:7', ['capstone']],
        ['Capstone: write-up', 'مشروع التخرج: التقرير', 'certificate', 'certificate', 'study', 'medium', 180, 'open:21', ['capstone']],
        ['Review statistics flashcards', 'مراجعة بطاقات الإحصاء', 'certificate', null, 'study', 'low', 25, 'daily:0', ['course']],
        ['Watch lecture on gradient boosting', 'مشاهدة محاضرة عن التعزيز التدريجي', 'certificate', null, 'study', 'medium', 50, 'overdue:1', ['course']],
        // App side project
        ['Set up project repository', 'إنشاء مستودع المشروع', 'app', 'app', 'personal', 'medium', 45, 'done:25', ['dev']],
        ['Build habit list screen', 'بناء شاشة قائمة العادات', 'app', 'app', 'personal', 'medium', 180, 'done:17', ['dev']],
        ['Streak calculation', 'حساب السلاسل', 'app', 'app', 'personal', 'high', 120, 'done:10', ['dev']],
        ['Login with email link', 'تسجيل الدخول برابط البريد', 'app', 'app', 'personal', 'high', 180, 'doing:6', ['dev']],
        ['Offline sync', 'المزامنة دون اتصال', 'app', 'app', 'personal', 'medium', 240, 'open:14', ['dev']],
        ['App icon and splash screen', 'أيقونة التطبيق وشاشة البداية', 'app', null, 'personal', 'low', 60, 'someday', ['design']],
        ['Invite ten beta testers', 'دعوة عشرة مختبرين', 'app', 'app', 'personal', 'medium', 30, 'open:25', []],
        // Marathon
        ['Buy new running shoes', 'شراء حذاء جري جديد', 'marathon', 'half', 'health', 'medium', 60, 'done:14', ['gear']],
        ['10 km tempo run', 'جري ١٠ كم بسرعة متوسطة', 'marathon', 'half', 'health', 'high', 60, 'done:5', ['run']],
        ['16 km long run', 'جري طويل ١٦ كم', 'marathon', 'half', 'health', 'high', 100, 'done:1', ['run']],
        ['Book physio check-up', 'حجز موعد علاج طبيعي', 'marathon', 'half', 'health', 'medium', 15, 'overdue:3', ['health']],
        ['Plan race-day nutrition', 'خطة التغذية ليوم السباق', 'marathon', 'half', 'health', 'low', 30, 'open:30', []],
        ['Register for the half marathon', 'التسجيل في نصف الماراثون', 'marathon', 'half', 'health', 'urgent', 15, 'open:1', ['admin']],
        // Office (completed project)
        ['Order standing desk', 'طلب مكتب قابل للوقوف', 'office', null, 'personal', 'medium', 30, 'done:28', []],
        ['Install desk lamp', 'تركيب مصباح المكتب', 'office', null, 'personal', 'low', 30, 'done:22', []],
        ['Cable management', 'تنظيم الأسلاك', 'office', null, 'personal', 'low', 60, 'done:14', []],
        // Fund
        ['Review monthly subscriptions', 'مراجعة الاشتراكات الشهرية', 'fund', 'fund', 'finance', 'medium', 45, 'done:11', ['budget']],
        ['Cancel unused streaming service', 'إلغاء خدمة بث غير مستخدمة', 'fund', 'fund', 'finance', 'low', 10, 'done:10', ['budget']],
        ['Set up automatic transfer', 'إعداد تحويل تلقائي', 'fund', 'fund', 'finance', 'high', 20, 'done:8', ['budget']],
        ['Compare savings account rates', 'مقارنة أسعار حسابات الادخار', 'fund', 'fund', 'finance', 'medium', 40, 'open:5', ['budget']],
        ['Extra car loan payment', 'دفعة إضافية لقرض السيارة', 'fund', 'debt', 'finance', 'medium', 15, 'open:12', ['debt']],
        ['Pay credit card bill', 'دفع فاتورة البطاقة', null, null, 'finance', 'high', 10, 'weekly:3', ['bills']],
        // Calligraphy (paused)
        ['Buy reed pens and ink', 'شراء أقلام القصب والحبر', 'calligraphy', null, 'study', 'low', 30, 'done:30', []],
        ['Practice letter alif to dal', 'تمرين الحروف من الألف إلى الدال', 'calligraphy', null, 'study', 'low', 45, 'someday', ['practice']],
        ['Watch naskh spacing lesson', 'مشاهدة درس المسافات في النسخ', 'calligraphy', null, 'study', 'low', 30, 'cancelled', []],
        // Blog & career
        ['Article: designing for RTL', 'مقال: التصميم من اليمين لليسار', null, 'blog', 'work', 'medium', 180, 'doing:9', ['writing']],
        ['Article outline: design tokens', 'مخطط مقال: رموز التصميم', null, 'blog', 'work', 'low', 45, 'inbox', ['writing']],
        ['Update portfolio case study', 'تحديث دراسة حالة في ملف الأعمال', null, 'promotion', 'work', 'medium', 120, 'open:11', ['career']],
        ['Prepare for performance review', 'التحضير لتقييم الأداء', null, 'promotion', 'work', 'high', 90, 'open:4', ['career']],
        ['Ask Maya for feedback', 'طلب ملاحظات من مايا', null, 'promotion', 'work', 'medium', 15, 'done:2', ['career']],
        // Personal & household
        ['Renew passport', 'تجديد جواز السفر', null, null, 'personal', 'high', 60, 'overdue:6', ['admin']],
        ['Book dentist appointment', 'حجز موعد طبيب الأسنان', null, null, 'health', 'medium', 10, 'done:9', []],
        ['Plan mum’s birthday dinner', 'التخطيط لعشاء عيد ميلاد أمي', null, null, 'personal', 'high', 45, 'open:5', ['family']],
        ['Call grandparents', 'الاتصال بالجد والجدة', null, null, 'personal', 'medium', 30, 'weekly:2', ['family']],
        ['Grocery shopping', 'التسوق للبقالة', null, null, 'personal', 'low', 45, 'weekly:1', ['home']],
        ['Water plants', 'سقي النباتات', null, null, 'personal', 'low', 10, 'daily:0', ['home']],
        ['Fix leaking kitchen tap', 'إصلاح صنبور المطبخ', null, null, 'personal', 'medium', 40, 'inbox', ['home']],
        ['Sort out winter clothes', 'ترتيب ملابس الشتاء', null, null, 'personal', 'low', 60, 'someday', ['home']],
        ['Return library books', 'إعادة كتب المكتبة', null, 'books', 'personal', 'low', 20, 'done:3', []],
        ['Finish “Atomic Habits”', 'إنهاء كتاب «العادات الذرية»', null, 'books', 'personal', 'medium', 120, 'done:6', ['reading']],
        ['Start “Deep Work”', 'البدء في كتاب «العمل العميق»', null, 'books', 'personal', 'low', 60, 'doing:12', ['reading']],
        ['Book weekend trip', 'حجز رحلة نهاية الأسبوع', null, null, 'personal', 'low', 30, 'inbox', ['travel']],
        ['Meditation course: lesson 5', 'دورة التأمل: الدرس ٥', null, 'meditation', 'health', 'low', 20, 'done:1', []],
        ['Meal prep for the week', 'تحضير وجبات الأسبوع', null, null, 'health', 'medium', 90, 'weekly:4', ['home']],
        ['Schedule annual health check', 'جدولة الفحص الصحي السنوي', null, null, 'health', 'medium', 15, 'inbox', ['health']],
        ['Back up laptop', 'نسخ احتياطي للحاسوب', null, null, 'personal', 'medium', 30, 'done:16', []],
        ['Clean up email inbox', 'تنظيف صندوق البريد', null, null, 'work', 'low', 30, 'done:0', ['admin']],
        ['Team retro notes', 'ملاحظات اجتماع المراجعة', null, null, 'work', 'medium', 30, 'done:0', ['meeting']],
        ['Reply to recruiter', 'الرد على مسؤول التوظيف', null, null, 'work', 'low', 15, 'cancelled', []],
        ['Expense report for October', 'تقرير مصاريف أكتوبر', null, null, 'finance', 'medium', 30, 'done:0', ['admin']],
        ['Mentor session prep', 'التحضير لجلسة الإرشاد', null, 'promotion', 'work', 'medium', 30, 'open:2', ['career']],
        // Earlier work, so period-over-period analytics have a realistic baseline.
        ['Competitor research', 'دراسة المنافسين', 'website', null, 'work', 'medium', 120, 'done:34', ['research']],
        ['Kick-off workshop', 'ورشة الانطلاق', 'website', 'promotion', 'work', 'high', 90, 'done:38', ['meeting']],
        ['Module 5: regression', 'الوحدة ٥: الانحدار', 'certificate', 'certificate', 'study', 'medium', 180, 'done:44', ['course']],
        ['Module 6: classification', 'الوحدة ٦: التصنيف', 'certificate', 'certificate', 'study', 'medium', 180, 'done:31', ['course']],
        ['Q3 client reports', 'تقارير العملاء للربع الثالث', 'reporting', null, 'work', 'high', 240, 'done:52', ['data']],
        ['App wireframes', 'مخططات التطبيق', 'app', 'app', 'personal', 'medium', 120, 'done:40', ['design']],
        ['8 km easy run', 'جري سهل ٨ كم', 'marathon', 'half', 'health', 'medium', 50, 'done:36', ['run']],
        ['Open savings account', 'فتح حساب ادخار', 'fund', 'fund', 'finance', 'high', 30, 'done:47', ['budget']],
        ['Finish “The Design of Everyday Things”', 'إنهاء كتاب «تصميم الأشياء اليومية»', null, 'books', 'personal', 'low', 120, 'done:33', ['reading']],
        ['Quarterly goals check-in', 'مراجعة الأهداف الفصلية', null, 'promotion', 'work', 'medium', 45, 'done:42', ['career']],
    ];

    /** @return array{0: string, 1: string} */
    public static function pick(array $pair, bool $ar): string
    {
        return $ar ? $pair[1] : $pair[0];
    }
}

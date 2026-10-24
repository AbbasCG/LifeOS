<?php

namespace App\Integrations;

use App\Integrations\Calendar\CalendarProviders;
use App\Integrations\Calendar\ConnectedProvider;

/**
 * Every integration LifeOS shows in the Connected Accounts Hub, grouped by category. Implemented providers report
 * whether the server is configured; planned ones explain why they are not available yet. Nothing here is simulated:
 * a provider is only connectable when it is implemented and its OAuth client is configured.
 */
class ConnectedCatalog
{
    public const CATEGORIES = ['calendars', 'tasks', 'productivity', 'email', 'future'];

    /** Implemented provider name => hub category. */
    private const IMPLEMENTED = ['google' => 'calendars', 'outlook' => 'calendars', 'google_tasks' => 'tasks', 'microsoft_todo' => 'tasks', 'todoist' => 'tasks'];

    /**
     * Not implemented yet: key => [category, label, en, ar, planned access].
     */
    private const PLANNED = [
        'notion' => ['productivity', 'Notion', 'Planned: import pages from one database you pick (Notion public integration with explicit page access). Needs a Notion OAuth app.', 'مخطط: استيراد صفحات من قاعدة بيانات تختارها (تكامل Notion عام بوصول محدد للصفحات). يتطلب تطبيق OAuth من Notion.', 'Read content of pages you share with LifeOS'],
        'gmail' => ['email', 'Gmail', 'Planned and privacy-first: only sender, subject and date of messages you star or label, never message bodies — and never sent to an AI provider without your explicit consent.', 'مخطط مع أولوية الخصوصية: المرسل والموضوع والتاريخ فقط للرسائل التي تميزها بنجمة أو تصنيف، دون نص الرسائل — ولا تُرسل إلى مزود ذكاء اصطناعي دون موافقتك الصريحة.', 'gmail.metadata (headers only)'],
        'outlook_mail' => ['email', 'Outlook Mail', 'Planned and privacy-first: flagged messages as follow-ups (sender, subject, date only), never bodies, never shared with AI without consent.', 'مخطط مع أولوية الخصوصية: الرسائل المعلّمة كمتابعات (المرسل والموضوع والتاريخ فقط)، دون النص، ولا مشاركة مع الذكاء الاصطناعي دون موافقة.', 'Mail.ReadBasic'],
        'apple_calendar' => ['future', 'Apple Calendar (iCloud)', 'Feasible through CalDAV with an app-specific password (Apple offers no OAuth for iCloud Calendar). Planned as a read-only import.', 'ممكن عبر CalDAV بكلمة مرور خاصة بالتطبيق (لا توفر Apple خدمة OAuth لتقويم iCloud). مخطط كاستيراد للقراءة فقط.', 'CalDAV read'],
        'ics_feed' => ['future', 'Calendar subscription (ICS)', 'Planned: subscribe to a read-only .ics URL (school, sports, public holidays).', 'مخطط: الاشتراك في رابط .ics للقراءة فقط (مدرسة، رياضة، عطلات رسمية).', 'Public or secret feed URL'],
    ];

    public function __construct(private CalendarProviders $providers) {}

    /**
     * @param  callable(ConnectedProvider): array<string, mixed>  $present  shape of an implemented provider (adds accounts)
     * @return list<array{key: string, providers: list<array<string, mixed>>}>
     */
    public function categories(callable $present): array
    {
        $groups = array_fill_keys(self::CATEGORIES, []);
        foreach (self::IMPLEMENTED as $name => $category) {
            if ($provider = $this->providers->get($name)) {
                $groups[$category][] = $present($provider);
            }
        }
        foreach (self::PLANNED as $key => [$category, $label, $en, $ar, $access]) {
            $groups[$category][] = ['provider' => $key, 'label' => $label, 'category' => $category, 'status' => 'planned', 'configured' => false, 'implemented' => false, 'note' => ['en' => $en, 'ar' => $ar], 'scopes' => $access, 'accounts' => []];
        }

        return array_map(fn (string $key) => ['key' => $key, 'providers' => $groups[$key]], self::CATEGORIES);
    }
}

<?php

namespace App\Integrations\Emc;

use App\Integrations\Webhooks\PermanentWebhookException;
use App\Models\Task;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\Validator;
use Illuminate\Validation\Rule;

/**
 * One validated EMC ticket event (schema_version 1, see docs/EMC_INTEGRATION.md). Built only from a verified delivery body; anything that
 * breaks the contract is a PermanentWebhookException: retrying cannot make it valid, so the delivery fails at once and nothing is applied.
 */
final class EmcTicketEvent
{
    public const TYPES = ['ticket.assigned', 'ticket.updated', 'ticket.closed', 'ticket.unassigned'];

    /** EMC priority (lower-cased) => LifeOS priority. Anything else becomes medium. */
    public const PRIORITIES = ['low' => 'low', 'normal' => 'medium', 'medium' => 'medium', 'high' => 'high', 'urgent' => 'urgent', 'critical' => 'urgent'];

    /** Largest version accepted: stays exact in JSON numbers and in a PostgreSQL bigint. */
    private const MAX_VERSION = 9007199254740991;

    private function __construct(
        public readonly string $eventId,
        public readonly string $type,
        public readonly string $externalId,
        public readonly int $version,
        public readonly string $title,
        public readonly string $priority,
        public readonly ?CarbonImmutable $dueAt,
        public readonly bool $dueAllDay,
        public readonly ?string $url,
        public readonly ?string $assignee,
    ) {}

    /**
     * @param  string  $deliveryId  the delivery id the receiver accepted (X-LifeOS-Delivery); the body's event_id must equal it
     * @param  string  $timezone  the owner's account timezone, for a date-only deadline
     */
    public static function fromJson(string $raw, string $deliveryId, string $timezone): self
    {
        $body = json_decode($raw, true, 32);
        if (! is_array($body) || array_is_list($body)) {
            throw new PermanentWebhookException('The body is not a JSON object.');
        }
        $instant = 'regex:/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})$/D';
        $validator = Validator::make($body, [
            'schema_version' => ['required', 'integer', Rule::in([1])],
            'event_id' => ['required', 'string', 'regex:/^[A-Za-z0-9._:\-]{1,120}$/D'],
            'type' => ['required', 'string', Rule::in(self::TYPES)],
            'occurred_at' => ['required', 'string', $instant, 'date'],
            'ticket' => ['required', 'array'],
            'ticket.external_id' => ['required', 'string', 'regex:/^[A-Za-z0-9._:\/#\-]{1,200}$/D'],
            'ticket.version' => ['required', 'integer', 'min:1', 'max:'.self::MAX_VERSION],
            'ticket.title' => ['required', 'string', 'max:500'],
            'ticket.priority' => ['required', 'string', 'max:40'],
            'ticket.due_at' => ['nullable', 'string', $instant, 'date', 'prohibits:ticket.due_date'],
            'ticket.due_date' => ['nullable', 'string', 'date_format:Y-m-d', 'after_or_equal:1970-01-01', 'before:2100-01-01'],
            'ticket.url' => ['nullable', 'string', 'max:1000'],
            'ticket.assignee_id' => ['nullable', 'string', 'max:200'],
        ]);
        if ($validator->fails()) {
            // Field names only: the values may be ticket content and the message ends up in last_error.
            throw new PermanentWebhookException('Invalid EMC event: '.implode(', ', array_keys($validator->errors()->messages())).'.');
        }
        if (! is_int($body['ticket']['version'])) {
            throw new PermanentWebhookException('Invalid EMC event: ticket.version must be a JSON integer.');
        }
        if (! hash_equals($deliveryId, $body['event_id'])) {
            throw new PermanentWebhookException('The body event_id does not match the delivery id.');
        }
        $title = trim(preg_replace('/[\x00-\x1F\x7F]+/u', ' ', $body['ticket']['title']) ?? '');
        if ($title === '') {
            throw new PermanentWebhookException('Invalid EMC event: ticket.title.');
        }
        $dueDate = $body['ticket']['due_date'] ?? null;
        $dueAt = $dueDate !== null ? Task::endOfDay($dueDate, $timezone)
            : (isset($body['ticket']['due_at']) ? CarbonImmutable::parse($body['ticket']['due_at'])->utc()->startOfSecond() : null);

        return new self(
            eventId: $body['event_id'],
            type: $body['type'],
            externalId: $body['ticket']['external_id'],
            version: $body['ticket']['version'],
            title: mb_substr($title, 0, 200),
            priority: self::PRIORITIES[mb_strtolower(trim($body['ticket']['priority']))] ?? 'medium',
            dueAt: $dueAt,
            dueAllDay: $dueDate !== null,
            url: self::safeUrl($body['ticket']['url'] ?? null),
            assignee: isset($body['ticket']['assignee_id']) ? mb_substr($body['ticket']['assignee_id'], 0, 200) : null,
        );
    }

    /** The state of the ticket for this person after the event. */
    public function state(): string
    {
        return match ($this->type) {
            'ticket.closed' => 'closed',
            'ticket.unassigned' => 'unassigned',
            default => 'assigned',
        };
    }

    /**
     * An https link without credentials, on an allowed host when a list is configured; anything else is dropped (the event still applies).
     */
    private static function safeUrl(?string $url): ?string
    {
        if ($url === null || $url === '' || ! filter_var($url, FILTER_VALIDATE_URL)) {
            return null;
        }
        $parts = parse_url($url);
        if (($parts['scheme'] ?? '') !== 'https' || empty($parts['host']) || isset($parts['user']) || isset($parts['pass'])) {
            return null;
        }
        $allowed = array_filter(array_map(fn ($h) => mb_strtolower(trim((string) $h)), (array) config('integrations.emc.allowed_url_hosts', [])));
        if ($allowed !== [] && ! in_array(mb_strtolower($parts['host']), $allowed, true)) {
            return null;
        }

        return $url;
    }
}

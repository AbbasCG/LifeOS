<?php

namespace App\Jobs;

use App\Models\FocusSession;
use App\Models\User;
use App\Models\WeeklyReview;
use App\Services\AutomationEngine;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;

/**
 * Run event-driven automation rules outside the request. Safe to retry: runs are deduplicated per rule and subject.
 */
class FireAutomations implements ShouldQueue
{
    use Queueable;

    public int $tries = 3;

    public array $backoff = [60, 300];

    public function __construct(public int $userId, public string $trigger, public int $subjectId) {}

    public function handle(AutomationEngine $engine): void
    {
        $user = User::find($this->userId);
        $subject = match ($this->trigger) {
            'focus_completed' => FocusSession::where('user_id', $this->userId)->find($this->subjectId),
            'weekly_review_completed' => WeeklyReview::where('user_id', $this->userId)->find($this->subjectId),
            default => null,
        };
        if ($user && $subject) {
            $engine->fire($user, $this->trigger, $subject);
        }
    }
}

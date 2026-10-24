<?php

namespace Tests\Unit;

use App\Services\HabitStreaks;
use Carbon\CarbonImmutable;
use PHPUnit\Framework\TestCase;

class HabitStreaksTest extends TestCase
{
    public function test_daily_streak_counts_consecutive_days_including_today(): void
    {
        $result = (new HabitStreaks)->calculate(['2027-03-08', '2027-03-09', '2027-03-10', '2027-03-05'], 'daily', CarbonImmutable::parse('2027-03-10'));

        $this->assertSame(3, $result['current_streak']);
        $this->assertSame(3, $result['longest_streak']);
        $this->assertTrue($result['done_today']);
    }

    public function test_daily_streak_survives_until_today_is_over(): void
    {
        $result = (new HabitStreaks)->calculate(['2027-03-08', '2027-03-09'], 'daily', CarbonImmutable::parse('2027-03-10'));

        $this->assertSame(2, $result['current_streak']);
        $this->assertFalse($result['done_today']);
        $this->assertFalse($result['done_this_period']);
    }

    public function test_missed_day_breaks_the_current_streak_but_keeps_longest(): void
    {
        $result = (new HabitStreaks)->calculate(['2027-03-01', '2027-03-02', '2027-03-03', '2027-03-04', '2027-03-08'], 'daily', CarbonImmutable::parse('2027-03-10'));

        $this->assertSame(0, $result['current_streak']);
        $this->assertSame(4, $result['longest_streak']);
    }

    public function test_weekly_streak_counts_consecutive_weeks(): void
    {
        $result = (new HabitStreaks)->calculate(['2027-02-22', '2027-03-03', '2027-03-04', '2027-03-10'], 'weekly', CarbonImmutable::parse('2027-03-11'));

        $this->assertSame(3, $result['current_streak']);
        $this->assertSame(3, $result['longest_streak']);
        $this->assertTrue($result['done_this_period']);
    }

    public function test_empty_history(): void
    {
        $result = (new HabitStreaks)->calculate([], 'daily', CarbonImmutable::parse('2027-03-10'));

        $this->assertSame(['current_streak' => 0, 'longest_streak' => 0, 'done_today' => false, 'done_this_period' => false], $result);
    }
}

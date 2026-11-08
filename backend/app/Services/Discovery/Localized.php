<?php

namespace App\Services\Discovery;

/** Picks the text for a person's language from an {ar, nl, en} map, falling back to English, then Arabic, then Dutch. */
class Localized
{
    public const LANGUAGES = ['ar', 'nl', 'en'];

    /** @param  array<string, string>  $text */
    public static function pick(array $text, string $language): string
    {
        foreach ([$language, 'en', 'ar', 'nl'] as $candidate) {
            if (isset($text[$candidate]) && $text[$candidate] !== '') {
                return $text[$candidate];
            }
        }

        return '';
    }

    /** The language of a person's saved preferences: one of ar, nl, en (anything else is English). */
    public static function of(?array $preferences): string
    {
        $language = $preferences['language'] ?? 'en';

        return in_array($language, self::LANGUAGES, true) ? $language : 'en';
    }
}

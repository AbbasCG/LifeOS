<?php

namespace App\Integrations\Calendar;

/**
 * Result of reading one calendar or task list. A full read replaces everything the collection had in the sync window;
 * an incremental read only upserts and removes what changed since the previous token.
 */
final class ChangeSet
{
    /**
     * @param  list<array<string, mixed>>  $upserts
     * @param  list<string>  $removed  external ids that were deleted, cancelled, or moved out of scope
     */
    public function __construct(
        public readonly array $upserts,
        public readonly array $removed,
        public readonly ?string $nextToken,
        public readonly bool $full,
    ) {}
}

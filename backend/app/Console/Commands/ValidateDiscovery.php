<?php

namespace App\Console\Commands;

use App\Services\Discovery\DiscoveryRegistry;
use App\Services\Discovery\InvalidDiscoveryContentException;
use Illuminate\Console\Command;

class ValidateDiscovery extends Command
{
    protected $signature = 'lifeos:discovery:validate';

    protected $description = 'Check every release, feature and tour file (all three languages, in-app links, media paths) and that the media files exist and are small.';

    public function handle(DiscoveryRegistry $registry): int
    {
        try {
            $releases = $registry->releases();
            $features = $registry->features();
            $tours = $registry->tours();
        } catch (InvalidDiscoveryContentException $e) {
            $this->error($e->getMessage());

            return self::FAILURE;
        }
        $problems = [];
        $public = base_path('../frontend/public');
        foreach ($this->media([...array_values($releases), ...array_values($features)]) as $src) {
            $file = $public.$src;
            if (! is_file($file)) {
                $problems[] = "Missing file: {$src}";

                continue;
            }
            $limit = str_ends_with($src, '.mp4') || str_ends_with($src, '.webm') ? config('discovery.max_video_bytes') : config('discovery.max_image_bytes');
            if (filesize($file) > $limit) {
                $problems[] = sprintf('Too large: %s (%d bytes, limit %d)', $src, filesize($file), $limit);
            }
        }
        foreach ($problems as $problem) {
            $this->error($problem);
        }
        $this->info(sprintf('%d release(s), %d feature(s), %d tour(s): %s.', count($releases), count($features), count($tours), $problems ? 'problems found' : 'ok'));

        return $problems ? self::FAILURE : self::SUCCESS;
    }

    /**
     * @param  list<array<string, mixed>>  $entries
     * @return list<string>
     */
    private function media(array $entries): array
    {
        $paths = [];
        $collect = function (?array $media) use (&$paths): void {
            foreach (['src', 'poster', 'captions'] as $field) {
                if (isset($media[$field])) {
                    $paths[] = $media[$field];
                }
            }
        };
        foreach ($entries as $entry) {
            $collect($entry['image'] ?? null);
            $collect($entry['video'] ?? null);
            foreach ($entry['items'] ?? [] as $item) {
                $collect($item['image'] ?? null);
                $collect($item['video'] ?? null);
            }
        }

        return array_values(array_unique($paths));
    }
}

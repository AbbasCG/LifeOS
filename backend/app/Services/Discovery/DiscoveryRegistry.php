<?php

namespace App\Services\Discovery;

/**
 * The single list of product announcements, features and tours, loaded from reviewed JSON files and validated:
 *
 *   resources/discovery/releases/<key>.json    what changed in one release (New / Improved / Fixed / Important)
 *   resources/discovery/features/<id>.json     something a person can try, with where it lives and who can use it
 *   resources/discovery/tours/<id>.json        a short guided tour of one screen or flow
 *
 * Every text exists in Arabic, Dutch and English. Links and routes are in-app paths only, media comes from /discovery/
 * (the app's own files, as the content security policy requires), and a tour step has no field that could perform an action:
 * unknown keys are rejected, so a file cannot smuggle one in. An invalid file fails the tests and `lifeos:discovery:validate`.
 */
class DiscoveryRegistry
{
    public const ITEM_TYPES = ['new', 'improved', 'fixed', 'important'];

    public const IMPORTANCE = ['normal', 'important'];

    public const SURFACES = ['web', 'mobile'];

    public const CATEGORIES = ['general', 'today', 'tasks', 'calendar', 'focus', 'assistant', 'planning', 'insights', 'settings', 'integrations'];

    public const PLACEMENTS = ['auto', 'top', 'bottom', 'start', 'end'];

    /** Things a tour step may ask the app to reveal before it highlights a target. */
    public const REVEALS = ['sidebar'];

    /** Put on every text of a generated draft (scripts/release-notes-draft.sh): text that still carries it is unfinished and is refused. */
    public const DRAFT_MARK = '⟦DRAFT⟧';

    public const SLUG = '/^[a-z0-9][a-z0-9-]{1,62}$/D';

    private const ROUTE = '#^/(?!/)[A-Za-z0-9/_-]*(\?[A-Za-z0-9=&_-]*)?$#D';

    private const MEDIA = '#^/discovery/[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9._-]*\.(png|jpe?g|webp|avif|mp4|webm|vtt)$#D';

    /** @var array<string, array<string, mixed>>|null */
    private ?array $releases = null;

    /** @var array<string, array<string, mixed>> */
    private array $features = [];

    /** @var array<string, array<string, mixed>> */
    private array $tours = [];

    public function __construct(private ?string $directory = null) {}

    /** @return array<string, array<string, mixed>> keyed by release key, newest first */
    public function releases(): array
    {
        $this->load();

        return $this->releases;
    }

    /** @return array<string, mixed>|null */
    public function release(string $key): ?array
    {
        return $this->releases()[$key] ?? null;
    }

    /** @return array<string, array<string, mixed>> */
    public function features(): array
    {
        $this->load();

        return $this->features;
    }

    /** @return array<string, mixed>|null */
    public function feature(string $id): ?array
    {
        return $this->features()[$id] ?? null;
    }

    /** @return array<string, array<string, mixed>> */
    public function tours(): array
    {
        $this->load();

        return $this->tours;
    }

    /** @return array<string, mixed>|null */
    public function tour(string $id): ?array
    {
        return $this->tours()[$id] ?? null;
    }

    /**
     * A fingerprint of everything a person would read for this release: the release itself, the features that arrived with it or that
     * its items name, and the tours of those features. An administrator approves one fingerprint; changed text has another one.
     */
    public function fingerprint(string $key): ?string
    {
        $release = $this->release($key);
        if ($release === null) {
            return null;
        }
        $ids = array_keys(array_filter($this->features(), fn (array $f) => $f['since'] === $key));
        foreach ($release['items'] as $item) {
            if (isset($item['feature'])) {
                $ids[] = $item['feature'];
            }
        }
        $ids = array_values(array_unique($ids));
        sort($ids);
        $features = array_map(fn (string $id) => $this->features()[$id], $ids);
        $tours = [];
        foreach ($features as $feature) {
            if ($feature['tour']) {
                $tours[$feature['tour']] = $this->tours()[$feature['tour']];
            }
        }
        ksort($tours);

        return hash('sha256', json_encode([$release, $features, $tours], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
    }

    /** The feature that owns a hint id, or null. */
    public function hintFeature(string $hintId): ?string
    {
        foreach ($this->features() as $id => $feature) {
            foreach ($feature['hints'] as $hint) {
                if ($hint['id'] === $hintId) {
                    return $id;
                }
            }
        }

        return null;
    }

    private function load(): void
    {
        if ($this->releases !== null) {
            return;
        }
        $base = rtrim($this->directory ?? config('discovery.path') ?: resource_path('discovery'), '/');
        $rawFeatures = $this->read($base.'/features');
        $rawTours = $this->read($base.'/tours');
        $rawReleases = $this->read($base.'/releases');

        $tours = [];
        foreach ($rawTours as $file => $data) {
            $tours[$data['id'] ?? ''] = $this->normalizeTour($file, $data);
        }
        $features = [];
        foreach ($rawFeatures as $file => $data) {
            $features[$data['id'] ?? ''] = $this->normalizeFeature($file, $data, $tours);
        }
        $releases = [];
        foreach ($rawReleases as $file => $data) {
            $releases[$data['key'] ?? ''] = $this->normalizeRelease($file, $data, $features);
        }
        $hintIds = [];
        foreach ($features as $id => $feature) {
            foreach ($feature['hints'] as $hint) {
                if (isset($hintIds[$hint['id']])) {
                    throw new InvalidDiscoveryContentException("features/{$id}.json: the hint id \"{$hint['id']}\" is already used by \"{$hintIds[$hint['id']]}\".");
                }
                $hintIds[$hint['id']] = $id;
            }
            if (! isset($releases[$feature['since']])) {
                throw new InvalidDiscoveryContentException("features/{$id}.json: \"since\" names the release \"{$feature['since']}\", which does not exist.");
            }
        }
        // A release may mention only features that arrived with it or earlier ones, never a feature of a later (maybe unpublished) release.
        foreach ($releases as $key => $release) {
            foreach ($release['items'] as $item) {
                $since = isset($item['feature']) ? $releases[$features[$item['feature']]['since']] : null;
                if ($since && $since['date'] > $release['date']) {
                    throw new InvalidDiscoveryContentException("releases/{$key}.json: the feature \"{$item['feature']}\" belongs to the later release \"{$since['key']}\".");
                }
            }
        }
        uasort($releases, fn (array $a, array $b) => [$b['date'], $b['key']] <=> [$a['date'], $a['key']]);
        $this->tours = $tours;
        $this->features = $features;
        $this->releases = $releases;
    }

    /** @return array<string, array<string, mixed>> decoded files keyed by file name */
    private function read(string $directory): array
    {
        $out = [];
        $files = glob($directory.'/*.json') ?: [];
        sort($files);
        foreach ($files as $path) {
            $name = basename($path);
            $data = json_decode((string) file_get_contents($path), true);
            if (! is_array($data) || array_is_list($data)) {
                throw new InvalidDiscoveryContentException(basename($directory).'/'.$name.' is not a JSON object.');
            }
            $out[$name] = $data;
        }

        return $out;
    }

    /**
     * @param  array<string, mixed>  $data
     * @param  array<string, array<string, mixed>>  $features
     * @return array<string, mixed>
     */
    private function normalizeRelease(string $file, array $data, array $features): array
    {
        $where = "releases/{$file}";
        $this->only($data, ['key', 'date', 'revision', 'importance', 'audiences', 'title', 'summary', 'items'], $where);
        $key = $this->slug($data['key'] ?? null, "{$where}: key");
        if ($file !== $key.'.json') {
            throw new InvalidDiscoveryContentException("{$where}: the file name must be {$key}.json.");
        }
        $date = $data['date'] ?? null;
        $parsed = is_string($date) ? \DateTimeImmutable::createFromFormat('!Y-m-d', $date) : false;
        if ($parsed === false || $parsed->format('Y-m-d') !== $date) {
            throw new InvalidDiscoveryContentException("{$where}: date must be YYYY-MM-DD.");
        }
        $importance = $data['importance'] ?? 'normal';
        $this->oneOf($importance, self::IMPORTANCE, "{$where}: importance");
        $items = $data['items'] ?? null;
        if (! is_array($items) || ! array_is_list($items) || $items === []) {
            throw new InvalidDiscoveryContentException("{$where}: items must be a non-empty list.");
        }
        $normalized = [];
        $minClient = 1;
        foreach ($items as $i => $item) {
            $normalized[] = $this->normalizeItem($where."/items[{$i}]", $item, $features);
            if (isset($normalized[$i]['feature'])) {
                $minClient = max($minClient, $features[$normalized[$i]['feature']]['client_version']);
            }
        }

        return [
            'key' => $key, 'date' => $date, 'revision' => $this->int($data['revision'] ?? 1, 1, 10000, "{$where}: revision"),
            'importance' => $importance, 'audiences' => $this->audiences($data['audiences'] ?? null, $where),
            'title' => $this->text($data['title'] ?? null, "{$where}: title", 120), 'summary' => $this->text($data['summary'] ?? null, "{$where}: summary", 400),
            'items' => $normalized, 'min_client' => $minClient,
        ];
    }

    /**
     * @param  array<string, array<string, mixed>>  $features
     * @return array<string, mixed>
     */
    private function normalizeItem(string $where, mixed $item, array $features): array
    {
        if (! is_array($item)) {
            throw new InvalidDiscoveryContentException("{$where} must be an object.");
        }
        $this->only($item, ['type', 'feature', 'title', 'body', 'image', 'video', 'link'], $where);
        $this->oneOf($item['type'] ?? null, self::ITEM_TYPES, "{$where}: type");
        $out = ['type' => $item['type']];
        if (isset($item['feature'])) {
            if (! is_string($item['feature']) || ! isset($features[$item['feature']])) {
                throw new InvalidDiscoveryContentException("{$where}: feature \"".(is_string($item['feature']) ? $item['feature'] : '?').'" does not exist.');
            }
            $out['feature'] = $item['feature'];
        }
        // An item that names a feature may omit its own text; it then reads as the feature's name and description.
        foreach (['title' => 140, 'body' => 600] as $field => $max) {
            if (isset($item[$field])) {
                $out[$field] = $this->text($item[$field], "{$where}: {$field}", $max);
            } elseif (! isset($out['feature'])) {
                throw new InvalidDiscoveryContentException("{$where}: {$field} is required when no feature is named.");
            }
        }
        if (isset($item['image'])) {
            $out['image'] = $this->image($item['image'], "{$where}: image");
        }
        if (isset($item['video'])) {
            $out['video'] = $this->video($item['video'], "{$where}: video");
        }
        if (isset($item['link'])) {
            $out['link'] = $this->route($item['link'], "{$where}: link");
        }

        return $out;
    }

    /**
     * @param  array<string, mixed>  $data
     * @param  array<string, array<string, mixed>>  $tours
     * @return array<string, mixed>
     */
    private function normalizeFeature(string $file, array $data, array $tours): array
    {
        $where = "features/{$file}";
        $this->only($data, ['id', 'category', 'name', 'description', 'route', 'since', 'client_version', 'new_days', 'requires', 'tour', 'hints', 'image', 'video', 'audiences'], $where);
        $id = $this->slug($data['id'] ?? null, "{$where}: id");
        if ($file !== $id.'.json') {
            throw new InvalidDiscoveryContentException("{$where}: the file name must be {$id}.json.");
        }
        $this->oneOf($data['category'] ?? 'general', self::CATEGORIES, "{$where}: category");
        $requires = $data['requires'] ?? [];
        if (! is_array($requires) || ! array_is_list($requires)) {
            throw new InvalidDiscoveryContentException("{$where}: requires must be a list.");
        }
        foreach ($requires as $requirement) {
            if (! is_string($requirement) || ! FeatureGate::isValid($requirement)) {
                throw new InvalidDiscoveryContentException("{$where}: unknown requirement \"".(is_string($requirement) ? $requirement : '?').'" (an unknown requirement would make the feature unavailable).');
            }
        }
        $tour = $data['tour'] ?? null;
        if ($tour !== null && (! is_string($tour) || ! isset($tours[$tour]))) {
            throw new InvalidDiscoveryContentException("{$where}: tour \"".(is_string($tour) ? $tour : '?').'" does not exist.');
        }
        $hints = [];
        foreach ($data['hints'] ?? [] as $i => $hint) {
            $hints[] = $this->hint($hint, "{$where}/hints[{$i}]");
        }
        $out = [
            'id' => $id, 'category' => $data['category'] ?? 'general', 'name' => $this->text($data['name'] ?? null, "{$where}: name", 80),
            'description' => $this->text($data['description'] ?? null, "{$where}: description", 300), 'route' => $this->route($data['route'] ?? null, "{$where}: route"),
            'since' => $this->slug($data['since'] ?? null, "{$where}: since"), 'client_version' => $this->int($data['client_version'] ?? 1, 1, 10000, "{$where}: client_version"),
            'new_days' => $this->int($data['new_days'] ?? 14, 1, 60, "{$where}: new_days"), 'requires' => $requires, 'tour' => $tour, 'hints' => $hints,
            'audiences' => $this->audiences($data['audiences'] ?? null, $where),
        ];
        if (isset($data['image'])) {
            $out['image'] = $this->image($data['image'], "{$where}: image");
        }
        if (isset($data['video'])) {
            $out['video'] = $this->video($data['video'], "{$where}: video");
        }

        return $out;
    }

    /** @return array<string, mixed> */
    private function hint(mixed $hint, string $where): array
    {
        if (! is_array($hint)) {
            throw new InvalidDiscoveryContentException("{$where} must be an object.");
        }
        $this->only($hint, ['id', 'target', 'route', 'text'], $where);

        return [
            'id' => $this->slug($hint['id'] ?? null, "{$where}: id"), 'target' => $this->slug($hint['target'] ?? null, "{$where}: target"),
            'route' => $this->route($hint['route'] ?? null, "{$where}: route"), 'text' => $this->text($hint['text'] ?? null, "{$where}: text", 220),
        ];
    }

    /**
     * @param  array<string, mixed>  $data
     * @return array<string, mixed>
     */
    private function normalizeTour(string $file, array $data): array
    {
        $where = "tours/{$file}";
        $this->only($data, ['id', 'version', 'title', 'steps'], $where);
        $id = $this->slug($data['id'] ?? null, "{$where}: id");
        if ($file !== $id.'.json') {
            throw new InvalidDiscoveryContentException("{$where}: the file name must be {$id}.json.");
        }
        $steps = $data['steps'] ?? null;
        if (! is_array($steps) || ! array_is_list($steps) || $steps === [] || count($steps) > 12) {
            throw new InvalidDiscoveryContentException("{$where}: steps must be a list of 1 to 12 steps.");
        }
        $out = [];
        foreach ($steps as $i => $step) {
            $at = "{$where}/steps[{$i}]";
            if (! is_array($step)) {
                throw new InvalidDiscoveryContentException("{$at} must be an object.");
            }
            // No "action", "click" or "submit" key exists: a tour only points at things and explains them.
            $this->only($step, ['target', 'route', 'reveal', 'title', 'body', 'placement', 'optional'], $at);
            if (isset($step['reveal'])) {
                $this->oneOf($step['reveal'], self::REVEALS, "{$at}: reveal");
            }
            $this->oneOf($step['placement'] ?? 'auto', self::PLACEMENTS, "{$at}: placement");
            $out[] = [
                'target' => $this->slug($step['target'] ?? null, "{$at}: target"), 'route' => isset($step['route']) ? $this->route($step['route'], "{$at}: route") : null,
                'reveal' => $step['reveal'] ?? null, 'title' => $this->text($step['title'] ?? null, "{$at}: title", 80), 'body' => $this->text($step['body'] ?? null, "{$at}: body", 300),
                'placement' => $step['placement'] ?? 'auto', 'optional' => (bool) ($step['optional'] ?? false),
            ];
        }

        return ['id' => $id, 'version' => $this->int($data['version'] ?? 1, 1, 1000, "{$where}: version"), 'title' => $this->text($data['title'] ?? null, "{$where}: title", 100), 'steps' => $out];
    }

    // ---- field validators ----

    /** @param  array<string, mixed>  $data @param  list<string>  $allowed */
    private function only(array $data, array $allowed, string $where): void
    {
        $unknown = array_diff(array_keys($data), $allowed);
        if ($unknown !== []) {
            throw new InvalidDiscoveryContentException("{$where}: unknown field(s): ".implode(', ', $unknown).'.');
        }
    }

    private function slug(mixed $value, string $where): string
    {
        if (! is_string($value) || ! preg_match(self::SLUG, $value)) {
            throw new InvalidDiscoveryContentException("{$where} must be lower-case letters, digits and hyphens (2 to 63 characters).");
        }

        return $value;
    }

    private function int(mixed $value, int $min, int $max, string $where): int
    {
        if (! is_int($value) || $value < $min || $value > $max) {
            throw new InvalidDiscoveryContentException("{$where} must be a whole number from {$min} to {$max}.");
        }

        return $value;
    }

    /** @param  list<string>  $allowed */
    private function oneOf(mixed $value, array $allowed, string $where): void
    {
        if (! is_string($value) || ! in_array($value, $allowed, true)) {
            throw new InvalidDiscoveryContentException("{$where} must be one of: ".implode(', ', $allowed).'.');
        }
    }

    /** @return array<string, string> */
    private function text(mixed $value, string $where, int $max): array
    {
        if (! is_array($value) || array_diff(Localized::LANGUAGES, array_keys($value)) !== [] || array_diff(array_keys($value), Localized::LANGUAGES) !== []) {
            throw new InvalidDiscoveryContentException("{$where} needs exactly the languages ar, nl and en.");
        }
        $out = [];
        foreach (Localized::LANGUAGES as $language) {
            $text = $value[$language];
            if (! is_string($text) || trim($text) === '' || mb_strlen($text) > $max) {
                throw new InvalidDiscoveryContentException("{$where} ({$language}) must be a non-empty text of at most {$max} characters.");
            }
            if (str_contains($text, self::DRAFT_MARK)) {
                throw new InvalidDiscoveryContentException("{$where} ({$language}) still has the draft marker ".self::DRAFT_MARK.': write the real text before it can ship.');
            }
            $out[$language] = trim($text);
        }

        return $out;
    }

    private function route(mixed $value, string $where): string
    {
        if (! is_string($value) || ! preg_match(self::ROUTE, $value)) {
            throw new InvalidDiscoveryContentException("{$where} must be a path inside LifeOS (it starts with a single /, with no address or scheme).");
        }

        return $value;
    }

    /** @return list<string> */
    private function audiences(mixed $value, string $where): array
    {
        $value ??= self::SURFACES;
        if (! is_array($value) || ! array_is_list($value) || $value === [] || array_diff($value, self::SURFACES) !== []) {
            throw new InvalidDiscoveryContentException("{$where}: audiences must be a non-empty list of: ".implode(', ', self::SURFACES).'.');
        }

        return array_values(array_unique($value));
    }

    /** @return array{src: string, alt: array<string, string>} */
    private function image(mixed $value, string $where): array
    {
        if (! is_array($value)) {
            throw new InvalidDiscoveryContentException("{$where} must be an object.");
        }
        $this->only($value, ['src', 'alt'], $where);

        return ['src' => $this->media($value['src'] ?? null, ['png', 'jpg', 'jpeg', 'webp', 'avif'], "{$where}.src"), 'alt' => $this->text($value['alt'] ?? null, "{$where}.alt", 160)];
    }

    /** @return array<string, mixed> */
    private function video(mixed $value, string $where): array
    {
        if (! is_array($value)) {
            throw new InvalidDiscoveryContentException("{$where} must be an object.");
        }
        $this->only($value, ['src', 'poster', 'captions', 'label'], $where);
        $out = [
            'src' => $this->media($value['src'] ?? null, ['mp4', 'webm'], "{$where}.src"), 'poster' => $this->media($value['poster'] ?? null, ['png', 'jpg', 'jpeg', 'webp', 'avif'], "{$where}.poster"),
            'label' => $this->text($value['label'] ?? null, "{$where}.label", 160),
        ];
        if (isset($value['captions'])) {
            $out['captions'] = $this->media($value['captions'], ['vtt'], "{$where}.captions");
        }

        return $out;
    }

    /** @param  list<string>  $extensions */
    private function media(mixed $value, array $extensions, string $where): string
    {
        if (! is_string($value) || ! preg_match(self::MEDIA, $value) || ! in_array(strtolower(pathinfo($value, PATHINFO_EXTENSION)), $extensions, true)) {
            throw new InvalidDiscoveryContentException("{$where} must be a file under /discovery/<folder>/ (".implode(', ', $extensions).').');
        }

        return $value;
    }
}

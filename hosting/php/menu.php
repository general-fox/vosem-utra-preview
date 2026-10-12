<?php
declare(strict_types=1);

require_once __DIR__.'/auth.php';

final class CafeMenuException extends RuntimeException {
    public function __construct(public int $status, string $message, public string $errorCode) { parent::__construct($message); }
}

function cafe_trim(string $value): string { return preg_replace('/^[\s\p{Z}\x{FEFF}]+|[\s\p{Z}\x{FEFF}]+$/u', '', $value) ?? ''; }
function cafe_text_length(string $value): int {
    preg_match_all('/./us', $value, $characters);
    $length = 0;
    foreach ($characters[0] as $character) $length += strlen($character) === 4 ? 2 : 1;
    return $length;
}
function cafe_text_field(mixed $value, string $field, int $maximum, int $minimum = 0): string {
    if (!is_string($value) || preg_match('//u', $value) !== 1 || preg_match('/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/', $value)
        || cafe_text_length($value) > $maximum || cafe_text_length(cafe_trim($value)) < $minimum) {
        throw new CafeMenuException(400, 'Проверьте поле «'.$field.'».', 'invalid_item');
    }
    return cafe_trim($value);
}
require_once __DIR__.'/menu-categories.php';
require_once __DIR__.'/menu-availability.php';

function cafe_drink_text(mixed $value): string {
    if (!is_string($value) || preg_match('//u', $value) !== 1 || cafe_text_length($value) > 80 || cafe_trim($value) === ''
        || preg_match('/[\x00-\x1f\x7f-\x{009f}\x{2028}\x{2029}]/u', $value)) {
        throw new CafeMenuException(400, 'Проверьте раздел и названия добавок напитка.', 'invalid_drink');
    }
    return cafe_trim($value);
}

function cafe_drink_price(mixed $value): int|float {
    if ((!is_int($value) && !is_float($value)) || !is_finite((float)$value) || $value < 0 || $value > 1000000) {
        throw new CafeMenuException(400, 'Проверьте цены напитка и добавок.', 'invalid_drink');
    }
    $cents = $value * 100;
    if (abs($cents - round($cents)) > PHP_FLOAT_EPSILON * max(1, abs($cents)) * 4) {
        throw new CafeMenuException(400, 'Проверьте цены напитка и добавок.', 'invalid_drink');
    }
    return round($cents) / 100;
}

/** Mirrors normalizeDrink in menu-drinks-model.js; unknown metadata is discarded. */
function cafe_normalize_drink(mixed $value): ?array {
    if ($value === null) return null;
    if (!is_array($value) || array_is_list($value) || !is_array($value['variants'] ?? null) || !array_is_list($value['variants'])
        || count($value['variants']) < 1 || count($value['variants']) > 10) {
        throw new CafeMenuException(400, 'Проверьте объёмы напитка.', 'invalid_drink');
    }
    $section = cafe_drink_text($value['section'] ?? null);
    $volumes = []; $variants = [];
    foreach ($value['variants'] as $variant) {
        if (!is_array($variant) || array_is_list($variant) || !is_int($variant['volumeMl'] ?? null) || $variant['volumeMl'] < 1
            || $variant['volumeMl'] > 5000 || in_array($variant['volumeMl'], $volumes, true)) {
            throw new CafeMenuException(400, 'Проверьте объёмы напитка.', 'invalid_drink');
        }
        $volumes[] = $variant['volumeMl'];
        $variants[] = ['volumeMl'=>$variant['volumeMl'], 'price'=>cafe_drink_price($variant['price'] ?? null)];
    }
    $rawAddons = array_key_exists('addons', $value) ? $value['addons'] : [];
    if (!is_array($rawAddons) || !array_is_list($rawAddons) || count($rawAddons) > 12) {
        throw new CafeMenuException(400, 'Проверьте добавки напитка.', 'invalid_drink');
    }
    $names = []; $addons = [];
    foreach ($rawAddons as $addon) {
        if (!is_array($addon) || array_is_list($addon)) throw new CafeMenuException(400, 'Проверьте добавки напитка.', 'invalid_drink');
        $name = cafe_drink_text($addon['name'] ?? null);
        if (in_array($name, $names, true)) throw new CafeMenuException(400, 'Названия добавок не должны повторяться.', 'invalid_drink');
        $names[] = $name;
        $addons[] = ['name'=>$name, 'price'=>cafe_drink_price($addon['price'] ?? null)];
    }
    $drink = ['section'=>$section, 'variants'=>$variants, 'addons'=>$addons];
    if (array_key_exists('childFriendly', $value)) {
        if (!is_bool($value['childFriendly'])) throw new CafeMenuException(400, 'Проверьте отметку детского напитка.', 'invalid_drink');
        $drink['childFriendly'] = $value['childFriendly'];
    }
    if (array_key_exists('sectionOrder', $value)) {
        if (!is_int($value['sectionOrder']) || $value['sectionOrder'] < 0 || $value['sectionOrder'] > 10000) {
            throw new CafeMenuException(400, 'Проверьте порядок подгруппы напитков.', 'invalid_drink');
        }
        $drink['sectionOrder'] = $value['sectionOrder'];
    }
    return $drink;
}

/** Keep the JSON contract shared with the menu editor and public menu client. */
function cafe_validate_items(mixed $items, ?array $categories = null, bool $migrateLegacy = false): array {
    if ($categories === null) { $categories = cafe_default_categories(); $migrateLegacy = true; }
    $categoryIds = array_column($categories, 'id');
    if (!is_array($items) || !array_is_list($items) || count($items) > 300) throw new CafeMenuException(400, 'Меню должно содержать не более 300 позиций.', 'invalid_items');
    $ids = []; $validated = []; $sources = [];
    foreach ($items as $index => $item) {
        if (!is_array($item) || array_is_list($item)) throw new CafeMenuException(400, 'Некорректная позиция '.($index + 1).'.', 'invalid_item');
        $id = cafe_text_field($item['id'] ?? null, 'идентификатор', 100, 1);
        if (!preg_match('/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/D', $id) || isset($ids[$id])) throw new CafeMenuException(400, 'Идентификаторы позиций должны быть уникальными.', 'invalid_id');
        $ids[$id] = true;
        $source = array_key_exists('source', $item) ? cafe_menu_source($item['source']) : null;
        $category = $item['category'] ?? null;
        if ($migrateLegacy && in_array($category, ['signature', 'eggs', 'porridge', 'sweet'], true)) $category = 'breakfast';
        if (!(($category === null && $source !== null) || (is_string($category) && in_array($category, $categoryIds, true)))) throw new CafeMenuException(400, 'Выберите группу меню.', 'invalid_category');
        $drink = cafe_normalize_drink($item['drink'] ?? null);
        $price = $drink !== null ? $drink['variants'][0]['price'] : ($item['price'] ?? null);
        if ((!is_int($price) && !is_float($price)) || !is_finite((float)$price) || $price < 0 || $price > 1000000 || abs($price * 100 - round($price * 100)) > 0.00001) throw new CafeMenuException(400, 'Укажите корректную цену в рублях.', 'invalid_price');
        if (!is_bool($item['published'] ?? null)) throw new CafeMenuException(400, 'Укажите видимость позиции.', 'invalid_published');
        if (array_key_exists('hiddenOnSite', $item) && !is_bool($item['hiddenOnSite'])) throw new CafeMenuException(400, 'Укажите видимость позиции.', 'invalid_visibility');
        $availableForOrder = array_key_exists('availableForOrder', $item) ? $item['availableForOrder'] : true;
        if (!is_bool($availableForOrder)) throw new CafeMenuException(400, 'Укажите доступность позиции для заказа.', 'invalid_availability');
        if (!is_int($item['order'] ?? null) || $item['order'] < 0 || $item['order'] > 100000) throw new CafeMenuException(400, 'Укажите корректный порядок позиции.', 'invalid_order');
        $image = cafe_text_field($item['image'] ?? null, 'фотография', 250);
        if ($image !== '') {
            if (!str_starts_with($image, '/')) $image = '/'.$image;
            if (!preg_match('~^/(menu-images|uploads)/[a-zA-Z0-9][a-zA-Z0-9._-]*\.(?:jpe?g|png|webp)$~iD', $image) || str_contains($image, '..')) throw new CafeMenuException(400, 'Загрузите фотографию JPG, PNG или WebP.', 'invalid_image');
        }
        $entry = ['id'=>$id, 'name'=>cafe_text_field($item['name'] ?? null, 'название', 160, 1), 'description'=>cafe_text_field($item['description'] ?? null, 'описание', 2000), 'price'=>$price, 'category'=>$category, 'image'=>$image, 'published'=>$item['published'], 'availableForOrder'=>$availableForOrder, 'order'=>$item['order']];
        if ($drink !== null) { $entry['drink'] = $drink; $entry['availableForOrder'] = false; }
        if (array_key_exists('hiddenOnSite', $item)) $entry['hiddenOnSite'] = $item['hiddenOnSite'];
        if (($item['hiddenOnSite'] ?? false) === true) { $entry['published'] = false; $entry['availableForOrder'] = false; }
        if ($source !== null) {
            $entry['source'] = $source; $key = cafe_source_key($entry['source']);
            if (($entry['source']['testOnly'] ?? false) === true) $entry['availableForOrder'] = false;
            if ($category === null) { $entry['published'] = false; $entry['availableForOrder'] = false; }
            if (isset($sources[$key])) throw new CafeMenuException(400, 'Позиция источника повторяется.', 'invalid_source');
            $sources[$key] = true;
        }
        $validated[] = $entry;
    }
    return $validated;
}

function cafe_request_body(int $limit, string $tooLargeMessage = 'Файл или запрос слишком большой.'): string {
    $length = $_SERVER['CONTENT_LENGTH'] ?? '';
    if (is_numeric($length) && (float)$length > $limit) throw new CafeMenuException(413, $tooLargeMessage, 'too_large');
    $body = file_get_contents('php://input', false, null, 0, $limit + 1);
    if ($body === false) throw new CafeMenuException(400, 'Загрузка прервана.', 'aborted');
    if (strlen($body) > $limit) throw new CafeMenuException(413, $tooLargeMessage, 'too_large');
    return $body;
}
function cafe_json_body(bool $allowEmpty = false): array {
    $body = cafe_request_body(1024 * 1024);
    if ($allowEmpty && $body === '') return [];
    if (trim(explode(';', $_SERVER['CONTENT_TYPE'] ?? '')[0]) !== 'application/json') throw new CafeMenuException(415, 'Ожидается JSON.', 'content_type');
    try {
        if (!str_starts_with(ltrim($body), '{')) throw new RuntimeException();
        $value = json_decode($body, true, 64, JSON_THROW_ON_ERROR);
        if (!is_array($value)) throw new RuntimeException();
        return $value;
    } catch (Throwable) { throw new CafeMenuException(400, 'Некорректный JSON.', 'invalid_json'); }
}
function cafe_json_response(array $value, int $status = 200): void {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    header('X-Robots-Tag: noindex, nofollow');
    $body = json_encode($value, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
    header('Content-Length: '.strlen($body));
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'HEAD') echo $body;
}

final class CafeMenu {
    public const MAX_IMAGE_BYTES = 100 * 1024 * 1024;
    public readonly CafeAuth $auth;
    private string $dataDir;
    private string $menuFile;
    private string $seedPath;
    private string $uploadsDir;
    private array $config;
    private CafeMenuAvailability $availability;
    public function __construct(string $privateDir, array $config) {
        $this->dataDir = $privateDir.'/admin-data';
        $this->menuFile = $this->dataDir.'/menu.json';
        $this->seedPath = $privateDir.'/app/seed/menu.json';
        $this->uploadsDir = $this->dataDir.'/uploads';
        $this->config = $config;
        // Mail configuration failure must not break regular administrator login.
        if (is_file(__DIR__.'/password-reset-mail.php')) {
            require_once __DIR__.'/password-reset-mail.php';
            try {
                $resetMail = cafe_reset_mail($privateDir, $config);
                if ($resetMail) $config['password_reset_sender'] = $resetMail->enqueue(...);
            } catch (Throwable) { /* Recovery remains unavailable until private SMTP settings are fixed. */ }
        }
        $this->auth = new CafeAuth($this->dataDir, $config);
        $this->availability = new CafeMenuAvailability($privateDir, $config);
    }
    private function menuLock(callable $operation): mixed {
        if (!is_dir($this->dataDir) && !@mkdir($this->dataDir, 0700, true) && !is_dir($this->dataDir)) throw new RuntimeException('Menu storage unavailable');
        return CafeStorage::locked($this->dataDir.'/menu.lock', $operation);
    }
    private function readSaved(): array {
        try {
            $saved = CafeStorage::readJson($this->menuFile);
            if (!is_array($saved) || !is_int($saved['revision'] ?? null) || $saved['revision'] < 1 || $saved['revision'] >= 9007199254740991) throw new RuntimeException();
            return cafe_normalize_persisted_catalog($saved) + ['revision'=>$saved['revision']];
        } catch (Throwable) { throw new CafeMenuException(503, 'Сохранённое меню временно недоступно.', 'menu_unavailable'); }
    }
    /** Called only while holding menu.lock; retain exact pre-migration bytes for recovery. */
    private function backupBeforeChange(int $revision, string $kind): void {
        $bytes = file_get_contents($this->menuFile);
        if ($bytes === false) throw new RuntimeException('Cannot read menu migration backup.');
        $path = $this->dataDir.'/menu-before-'.$kind.'-'.gmdate('Ymd-His').'-'.$revision.'-'.bin2hex(random_bytes(6)).'.json';
        $stream = @fopen($path, 'xb');
        if (!$stream) throw new RuntimeException('Cannot create menu migration backup.');
        @chmod($path, 0600); $complete = false;
        try {
            for ($offset = 0; $offset < strlen($bytes); $offset += $written) {
                $written = fwrite($stream, substr($bytes, $offset));
                if (!$written) throw new RuntimeException('Cannot write menu migration backup.');
            }
            if (!fflush($stream) || (function_exists('fsync') && !fsync($stream))) throw new RuntimeException('Cannot flush menu migration backup.');
            $complete = true;
        } finally { fclose($stream); if (!$complete) @unlink($path); }
    }
    public function read(): array {
        if (!is_file($this->menuFile)) {
            $this->menuLock(function (): void {
                if (is_file($this->menuFile)) return;
                $seed = CafeStorage::readJson($this->seedPath);
                CafeStorage::atomicJson($this->menuFile, cafe_normalize_persisted_catalog($seed) + ['revision'=>1]);
            });
        }
        $saved=$this->readSaved();
        try {
            if (cafe_catalog_needs_editor_migration(CafeStorage::readJson($this->menuFile))) {
                $this->menuLock(function (): void {
                    $current = $this->readSaved();
                    if (!cafe_catalog_needs_editor_migration(CafeStorage::readJson($this->menuFile))) return;
                    $this->backupBeforeChange($current['revision'], 'editor-rules');
                    $current['revision']++;
                    CafeStorage::atomicJson($this->menuFile, $current);
                });
                $saved = $this->readSaved();
            }
        } catch (Throwable) { throw new CafeMenuException(503, 'Сохранённое меню временно недоступно.', 'menu_unavailable'); }
        $testItems=$this->config['kds_test_items'] ?? [];
        if ($testItems) {
            $this->menuLock(function () use($testItems): void {
                $current=$this->readSaved(); $ids=array_column($current['items'],'id');
                $markerFile=$this->dataDir.'/kds-test-seed.json';
                $marker=is_file($markerFile) ? CafeStorage::readJson($markerFile) : ['version'=>1,'ids'=>[]];
                if (!is_array($marker) || ($marker['version'] ?? null)!==1 || !is_array($marker['ids'] ?? null) || !array_is_list($marker['ids'])) throw new CafeMenuException(503, 'Сохранённое меню временно недоступно.', 'menu_unavailable');
                $processed=$marker['ids']; $extra=[]; $categoryIds=array_column($current['categories'],'id');
                foreach ($testItems as $item) {
                    if (in_array($item['id'],$processed,true)) continue;
                    // Record existing entries too: a later explicit deletion must remain a deletion.
                    $processed[]=$item['id'];
                    if (in_array($item['id'],$ids,true)) continue;
                    if (in_array($item['category'] ?? null,['signature','eggs','porridge','sweet'],true)) $item['category']='breakfast';
                    if (!in_array($item['category'] ?? null,$categoryIds,true)) continue; // Never recreate a deleted group or publish in an arbitrary replacement.
                    $extra[]=$item;
                }
                if ($extra) {
                    $current['items'] = cafe_validate_items(cafe_derive_website_item_flags(array_merge($current['items'],$extra)), $current['categories'], true);
                    $current['revision']++;
                    CafeStorage::atomicJson($this->menuFile, $current);
                }
                // Written last: after a crash, existing IDs are recognized without inserting duplicates.
                if ($processed !== $marker['ids'] || !is_file($markerFile)) CafeStorage::atomicJson($markerFile,['version'=>1,'ids'=>$processed]);
            });
            $saved=$this->readSaved();
        }
        return $saved;
    }
    public function published(): array {
        return $this->catalog()['items'];
    }
    /** Same lock as catalog edits. Always acquire this before an orders DB transaction. */
    public function withLockedSnapshot(callable $operation): mixed {
        $this->read(); // Seed, if necessary, before entering the non-reentrant lock.
        return $this->menuLock(fn(): mixed => $operation($this->orderable($this->readSaved())));
    }
    /** Published items and their revision must come from one authoritative read. */
    public function catalog(): array {
        $menu = $this->orderable($this->read());
        $items = array_values(array_filter($menu['items'], static fn(array $item): bool => $item['published'] && $item['category'] !== null));
        if (($this->config['delivery_enabled'] ?? true) !== true) {
            $items = array_values(array_filter($items, static fn(array $item): bool => ($item['source']['testOnly'] ?? false) !== true && !str_starts_with($item['id'], 'kds-test-')));
            foreach ($items as &$item) $item['availableForOrder'] = false;
            unset($item);
        }
        usort($items, static fn(array $left, array $right): int => $left['order'] <=> $right['order']);
        return ['categories'=>$menu['categories'], 'items'=>$items, 'revision'=>$menu['revision']];
    }
    private function orderable(array $menu): array {
        if (isset($this->config['orderable_ids'])) foreach($menu['items'] as &$item) {
            if (!in_array($item['id'],$this->config['orderable_ids'],true)) $item['availableForOrder']=false;
        }
        return $this->availability->decorate($menu, true);
    }
    public function update(array $items, mixed $revision, ?array $categories = null, ?array $sourceCategories = null, ?array $categoryMappings = null): array {
        if (!is_int($revision) || $revision < 1 || $revision >= 9007199254740991) throw new CafeMenuException(400, 'Некорректная версия меню.', 'invalid_revision');
        $this->read();
        return $this->menuLock(function () use ($items, $revision, $categories, $sourceCategories, $categoryMappings): array {
            $menu = $this->readSaved();
            if ($revision !== $menu['revision']) throw new CafeMenuException(409, 'Меню уже изменено в другой вкладке. Загрузите актуальную версию.', 'conflict');
            $tree = cafe_validate_categories($categories ?? $menu['categories']);
            foreach ($tree as $category) if (isset($category['source'])) throw new CafeMenuException(400, 'Группы сайта создаются вручную. Дерево кассы хранится отдельно.', 'manual_category_required');
            foreach ($tree as $category) if ($category['parentId'] !== null) throw new CafeMenuException(400, 'Группы сайта располагаются на одном уровне, без подгрупп.', 'flat_site_groups');
            if ($categoryMappings !== null && $categoryMappings !== []) throw new CafeMenuException(400, 'Выберите группу сайта в карточке каждого блюда.', 'manual_assignment_required');
            if ($sourceCategories !== null && cafe_validate_categories($sourceCategories) != $menu['sourceCategories']) throw new CafeMenuException(400, 'Группы кассы изменяются только при выгрузке из базы.', 'immutable_source');
            $previous = array_column($menu['items'], null, 'id');
            foreach ($items as &$item) {
                if (!is_array($item) || !is_string($item['id'] ?? null)) continue; // Report malformed items through the common validator below.
                if (!isset($previous[$item['id']])) {
                    if (($this->config['manual_menu_enabled'] ?? false) !== true) throw new CafeMenuException(400, 'Новые блюда добавляются только при выгрузке из базы кассы.', 'import_only');
                    if (array_key_exists('source', $item)) throw new CafeMenuException(400, 'Источник блюда нельзя задать вручную.', 'immutable_source');
                }
                $savedSource = $previous[$item['id']]['source'] ?? null;
                if (array_key_exists('source', $item)) {
                    if ($item['source'] === null || cafe_menu_source($item['source']) != $savedSource) throw new CafeMenuException(400, 'Привязка блюда к кассе изменяется только при выгрузке из базы.', 'immutable_source');
                } elseif ($savedSource !== null) {
                    // Older editors may omit source metadata; importing again must still find these records.
                    $item['source'] = $savedSource;
                }
            }
            unset($item);
            $items = cafe_validate_items(cafe_derive_website_item_flags($items), $tree, $categories === null);
            $updated = cafe_normalize_persisted_catalog(['categories'=>$tree, 'sourceCategories'=>$menu['sourceCategories'], 'categoryMappings'=>[], 'items'=>$items]) + ['revision'=>$revision + 1];
            CafeStorage::atomicJson($this->menuFile, $updated);
            return $updated;
        });
    }
    /** Add the packaged beverage menu without replacing existing editor changes. */
    public function importDrinks(mixed $revision, bool $dryRun = false): array {
        if (($this->config['manual_menu_enabled'] ?? false) !== true) throw new CafeMenuException(403, 'Ручное меню отключено.', 'manual_menu_disabled');
        if (!is_int($revision) || $revision < 1 || $revision >= 9007199254740991) throw new CafeMenuException(400, 'Некорректная версия меню.', 'invalid_revision');
        require_once __DIR__.'/drinks-import.php';
        if (!is_file($this->menuFile)) throw new CafeMenuException(503, 'Сначала загрузите сохранённое меню.', 'menu_unavailable');
        return $this->menuLock(function () use ($revision, $dryRun): array {
            $current = CafeStorage::readJson($this->menuFile);
            if (!is_array($current) || !is_int($current['revision'] ?? null)) throw new CafeMenuException(503, 'Сохранённое меню временно недоступно.', 'menu_unavailable');
            if ($revision !== $current['revision']) throw new CafeMenuException(409, 'Меню уже изменено в другой вкладке. Загрузите актуальную версию.', 'conflict');
            $seedFile = dirname($this->seedPath).'/drinks.json';
            if (!is_file($seedFile) || is_link($seedFile) || filesize($seedFile) > 1048576) throw new CafeMenuException(503, 'Шаблон напитков временно недоступен.', 'drinks_seed_unavailable');
            $updated = cafe_merge_drinks_catalog($current, CafeStorage::readJson($seedFile));
            if ($updated === $current) return $current;
            $updated['revision'] = $current['revision'] + 1;
            if (!$dryRun) {
                $this->backupBeforeChange($current['revision'], 'drinks-import');
                CafeStorage::atomicJson($this->menuFile, $updated);
            }
            return $updated;
        });
    }
    /** CLI imports share the editor lock and never touch credentials or order state. */
    public function importKdsGroup(array $sourceMenu, string $organizationId, string $externalId): array {
        if (PHP_SAPI !== 'cli') throw new CafeMenuException(403, 'Импорт доступен только оператору сервера.', 'offline_only');
        require_once __DIR__.'/menu-import.php';
        $this->read();
        return $this->menuLock(function () use ($sourceMenu, $organizationId, $externalId): array {
            $current = $this->readSaved();
            $updated = cafe_import_kds_group($current, $sourceMenu, $organizationId, $externalId);
            if ($updated === array_diff_key($current, ['revision'=>true])) return $current;
            $updated['revision'] = $current['revision'] + 1;
            CafeStorage::atomicJson($this->menuFile, $updated);
            return $updated;
        });
    }
    private function peer(): string { return $_SERVER['REMOTE_ADDR'] ?? 'unknown'; }
    private function token(): ?string { return is_string($_COOKIE['vosem_admin'] ?? null) ? $_COOKIE['vosem_admin'] : null; }
    private function deviceToken(): ?string { return is_string($_COOKIE['vosem_admin_device'] ?? null) ? $_COOKIE['vosem_admin_device'] : null; }
    private function origin(): void {
        $expected = $this->config['public_origin'] ?? 'https://vosem-utra.ru';
        if (($_SERVER['HTTP_ORIGIN'] ?? '') !== $expected || ($_SERVER['HTTP_SEC_FETCH_SITE'] ?? '') === 'cross-site') throw new CafeMenuException(403, 'Запрос должен быть отправлен с этого сайта.', 'origin');
    }
    private function requireSession(bool $csrf = false): array {
        $session = $this->auth->session($this->token());
        if (!$session) throw new CafeMenuException(401, 'Войдите в панель управления.', 'unauthorized');
        $provided = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? '';
        if ($csrf && (!is_string($provided) || !is_string($session['csrfToken'] ?? null) || !hash_equals($session['csrfToken'], $provided))) throw new CafeMenuException(403, 'Сессия устарела. Обновите страницу и повторите действие.', 'csrf');
        return $session;
    }
    private function cookie(string $token, int $seconds, string $name = 'vosem_admin'): void {
        setcookie($name, $token, ['expires'=>$seconds > 0 ? time() + $seconds : time() - 3600, 'path'=>'/api/admin', 'secure'=>!($this->config['allow_http_dev'] ?? false), 'httponly'=>true, 'samesite'=>'Strict']);
    }
    public function storeImage(string $bytes, string $mime): string {
        $extensions = ['image/jpeg'=>'jpg', 'image/png'=>'png', 'image/webp'=>'webp'];
        if (!isset($extensions[$mime])) throw new CafeMenuException(415, 'Поддерживаются JPG, PNG и WebP.', 'invalid_image_type');
        if (strlen($bytes) > self::MAX_IMAGE_BYTES) throw new CafeMenuException(413, 'Фотография должна быть не больше 100 МБ.', 'too_large');
        if (!function_exists('imagecreatefromstring') || !function_exists('imagewebp')) throw new CafeMenuException(503, 'Загрузка фотографий требует настройки сервера.', 'image_setup_required');
        $info = @getimagesizefromstring($bytes);
        if (!$info || ($info['mime'] ?? '') !== $mime || $info[0] < 1 || $info[1] < 1 || $info[0] > 6000 || $info[1] > 6000 || $info[0] * $info[1] > 12000000) throw new CafeMenuException(400, 'Загрузите корректную фотографию до 12 мегапикселей.', 'invalid_image');
        $image = @imagecreatefromstring($bytes);
        if (!$image) throw new CafeMenuException(400, 'Файл не соответствует формату фотографии.', 'invalid_image');
        // Decode and re-encode: no submitted metadata, PHP text or other trailing payload is retained.
        if (!is_dir($this->uploadsDir) && !@mkdir($this->uploadsDir, 0700, true) && !is_dir($this->uploadsDir)) { imagedestroy($image); throw new RuntimeException('Image storage unavailable'); }
        $random = bin2hex(random_bytes(16));
        $name = substr($random,0,8).'-'.substr($random,8,4).'-4'.substr($random,13,3).'-a'.substr($random,17,3).'-'.substr($random,20,12).'.'.$extensions[$mime];
        $file = $this->uploadsDir.'/'.$name;
        $stream = @fopen($file, 'x+b');
        if (!$stream) { imagedestroy($image); throw new RuntimeException('Image storage unavailable'); }
        @chmod($file, 0600);
        try {
            imagealphablending($image, false); imagesavealpha($image, true);
            $written = match ($mime) { 'image/jpeg'=>imagejpeg($image, $stream, 90), 'image/png'=>imagepng($image, $stream, 6), 'image/webp'=>imagewebp($image, $stream, 90) };
            if (!$written || !fflush($stream) || fstat($stream)['size'] > self::MAX_IMAGE_BYTES) throw new CafeMenuException(400, 'После обработки фотография превышает 100 МБ.', 'invalid_image');
        } catch (Throwable $error) { fclose($stream); imagedestroy($image); @unlink($file); throw $error; }
        fclose($stream); imagedestroy($image);
        return '/uploads/'.$name;
    }
    private function serveImage(string $pathname, string $method): void {
        if (!in_array($method, ['GET','HEAD'], true)) throw new CafeMenuException(405, 'Метод не поддерживается.', 'method');
        $name = substr($pathname, strlen('/uploads/'));
        if (!preg_match('/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.(jpg|png|webp)$/D', $name, $match)) throw new CafeMenuException(404, 'Фотография не найдена.', 'not_found');
        $root = realpath($this->uploadsDir); $file = realpath($this->uploadsDir.'/'.$name);
        if (!$root || !$file || dirname($file) !== $root || !is_file($file)) throw new CafeMenuException(404, 'Фотография не найдена.', 'not_found');
        header('Content-Type: '.($match[1] === 'jpg' ? 'image/jpeg' : 'image/'.$match[1]));
        header('Content-Length: '.filesize($file));
        header('Cache-Control: public, max-age=31536000, immutable');
        header("Content-Security-Policy: default-src 'none'; sandbox");
        header('X-Content-Type-Options: nosniff');
        if ($method !== 'HEAD') readfile($file);
    }
    /** Return false only when the route belongs to the page/static controller. */
    public function dispatch(string $pathname, string $method): bool {
        if (!str_starts_with($pathname, '/api/') && !str_starts_with($pathname, '/uploads/') && $pathname !== '/data/menu.json') return false;
        try {
            if (str_starts_with($pathname, '/uploads/')) { $this->serveImage($pathname, $method); return true; }
            if (str_starts_with($pathname, '/api/admin/') && !($this->config['allow_http_dev'] ?? false)
                && (empty($_SERVER['HTTPS']) || $_SERVER['HTTPS'] === 'off')) throw new CafeMenuException(400, 'Для входа используйте защищённое соединение HTTPS.', 'https_required');
            if (!in_array($method, ['GET','HEAD'], true)) $this->origin();
            if (in_array($pathname, ['/api/menu','/data/menu.json'], true) && in_array($method, ['GET','HEAD'], true)) { cafe_json_response($this->catalog()); return true; }
            if ($pathname === '/api/admin/session' && $method === 'GET') { cafe_json_response($this->auth->status($this->token(), $this->deviceToken())); return true; }
            if (($this->config['auth_mode'] ?? '') === 'password' &&
                ($pathname === '/api/admin/resume' || $pathname === '/api/admin/verify' || str_starts_with($pathname, '/api/admin/enroll/'))) {
                throw new CafeMenuException(404, 'Войдите с почтой и паролем.', 'not_found');
            }
            if ($method === 'POST' && in_array($pathname, ['/api/admin/password-reset/request','/api/admin/password-reset/verify','/api/admin/password-reset/complete'], true)) {
                $body = cafe_json_body();
                $result = match ($pathname) {
                    '/api/admin/password-reset/request'=>$this->auth->requestPasswordReset($body, $this->peer()),
                    '/api/admin/password-reset/verify'=>$this->auth->verifyPasswordReset($body, $this->peer()),
                    default=>$this->auth->completePasswordReset($body, $this->peer()),
                };
                cafe_json_response($result, str_ends_with($pathname, '/request') ? 202 : 200); return true;
            }
            if ($pathname === '/api/admin/activity' && $method === 'POST') { cafe_json_response($this->auth->activity($this->token(), $_SERVER['HTTP_X_CSRF_TOKEN'] ?? null)); return true; }
            if ($pathname === '/api/admin/resume' && $method === 'POST') { cafe_json_response($this->auth->resume($this->deviceToken(), $this->peer()), 202); return true; }
            if ($pathname === '/api/admin/forget-device' && $method === 'POST') {
                if ($this->auth->session($this->token())) $this->requireSession(true);
                $this->auth->logout($this->token(), $this->peer()); $this->cookie('', 0);
                $this->auth->forgetDevice($this->deviceToken()); $this->cookie('', 0, 'vosem_admin_device');
                cafe_json_response(['forgotten' => true]); return true;
            }
            if ($pathname === '/api/admin/enroll/start' && $method === 'POST') { cafe_json_response($this->auth->enrollStart(cafe_json_body(), $this->peer())); return true; }
            if ($pathname === '/api/admin/enroll/cancel' && $method === 'POST') { cafe_json_response($this->auth->enrollCancel(cafe_json_body(), $this->peer())); return true; }
            if (in_array($pathname, ['/api/admin/login','/api/admin/verify','/api/admin/enroll/confirm'], true) && $method === 'POST') {
                $body = cafe_json_body();
                $result = match ($pathname) {
                    '/api/admin/login'=>$this->auth->login($body, $this->peer(), $this->token()),
                    '/api/admin/verify'=>$this->auth->verify($body, $this->peer(), $this->deviceToken()),
                    default=>$this->auth->enrollConfirm($body, $this->peer()),
                };
                if (($result['mfaRequired'] ?? false) || ($result['enrollmentRequired'] ?? false) || ($result['passwordChangeRequired'] ?? false)) cafe_json_response($result, 202);
                else {
                    $this->cookie($result['token'], (int)(($this->config['session_ms'] ?? 28800000) / 1000));
                    $this->auth->forgetDevice($this->deviceToken());
                    $this->cookie($result['deviceToken'] ?? '', $result['deviceMaxAge'] ?? 0, 'vosem_admin_device');
                    unset($result['token'], $result['deviceToken'], $result['deviceMaxAge']); cafe_json_response($result);
                }
                return true;
            }
            if ($pathname === '/api/admin/logout' && $method === 'POST') {
                $body = cafe_json_body(true);
                if ($this->auth->session($this->token())) $this->requireSession(true);
                $this->auth->logout($this->token(), $this->peer()); $this->cookie('', 0);
                if (($body['forgetDevice'] ?? false) === true) {
                    $this->auth->forgetDevice($this->deviceToken()); $this->cookie('', 0, 'vosem_admin_device');
                }
                cafe_json_response($this->auth->status(null, $this->deviceToken())); return true;
            }
            if ($pathname === '/api/admin/menu' && $method === 'GET') { $this->requireSession(); cafe_json_response($this->availability->decorate($this->read())); return true; }
            if ($pathname === '/api/admin/sync-availability' && $method === 'POST') {
                if (($this->config['keeper_enabled'] ?? true) !== true) throw new CafeMenuException(404, 'Адрес API не найден.', 'not_found');
                $this->requireSession(true); cafe_json_body(true);
                $this->availability->sync(fn(callable $save) => $this->auth->authorizedOperation($this->token(), $_SERVER['HTTP_X_CSRF_TOKEN'] ?? null, $save));
                $this->auth->audit('menu.availability-synced', $this->peer());
                cafe_json_response($this->availability->decorate($this->read())); return true;
            }
            if ($pathname === '/api/admin/menu/drinks-import' && $method === 'POST') {
                $this->requireSession(true); $body = cafe_json_body();
                $updated = $this->auth->authorizedOperation($this->token(), $_SERVER['HTTP_X_CSRF_TOKEN'] ?? null, fn() => $this->importDrinks($body['revision'] ?? null));
                $this->auth->audit('menu.drinks-imported', $this->peer(), ['revision'=>$updated['revision'], 'count'=>count($updated['items'])]);
                cafe_json_response($this->availability->decorate($updated)); return true;
            }
            if ($pathname === '/api/admin/menu' && $method === 'PUT') {
                $this->requireSession(true); $body = cafe_json_body();
                if (!is_array($body['items'] ?? null)) throw new CafeMenuException(400, 'Проверьте список блюд.', 'invalid_items');
                $categories = array_key_exists('categories', $body) ? cafe_validate_categories($body['categories']) : null;
                foreach (['sourceCategories','categoryMappings'] as $key) if (array_key_exists($key, $body) && !is_array($body[$key])) throw new CafeMenuException(400, 'Проверьте связи групп.', 'invalid_category_mapping');
                $updated = $this->auth->authorizedOperation($this->token(), $_SERVER['HTTP_X_CSRF_TOKEN'] ?? null, fn() => $this->update($body['items'], $body['revision'] ?? null, $categories, $body['sourceCategories'] ?? null, $body['categoryMappings'] ?? null));
                $this->auth->audit('menu.updated', $this->peer(), ['revision'=>$updated['revision'], 'count'=>count($updated['items'])]);
                cafe_json_response($this->availability->decorate($updated)); return true;
            }
            if ($pathname === '/api/admin/upload' && $method === 'POST') {
                $this->requireSession(true);
                $bytes = cafe_request_body(self::MAX_IMAGE_BYTES, 'Фотография должна быть не больше 100 МБ.');
                $mime = trim(explode(';', $_SERVER['CONTENT_TYPE'] ?? '')[0]);
                $url = $this->auth->authorizedOperation($this->token(), $_SERVER['HTTP_X_CSRF_TOKEN'] ?? null, fn() => $this->storeImage($bytes, $mime));
                $this->auth->audit('image.uploaded', $this->peer()); cafe_json_response(['url'=>$url], 201); return true;
            }
            throw new CafeMenuException(404, 'Адрес API не найден.', 'not_found');
        } catch (CafeMenuException|CafeAuthException $error) {
            if (($error->retryAfter ?? 0) > 0) header('Retry-After: '.$error->retryAfter);
            cafe_json_response(['error'=>$error->getMessage(), 'code'=>$error->errorCode], $error->status);
        } catch (Throwable) {
            // No exception text: a transport/parser error can contain submitted secrets.
            error_log('Cafe API request failed.');
            cafe_json_response(['error'=>'Не удалось выполнить действие. Попробуйте ещё раз.', 'code'=>'server_error'], 500);
        }
        return true;
    }
}

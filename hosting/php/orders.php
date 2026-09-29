<?php
declare(strict_types=1);

/** Guest ordering. This library never sends messages, payments or webhooks. */
final class CafeOrderException extends RuntimeException
{
    public function __construct(public int $status, string $message, public string $errorCode, public array $details = [], public ?int $retryAfter = null) { parent::__construct($message); }
}

final class CafeOrders
{
    private ?PDO $db = null;
    private string $directory;
    private array $config;
    private array $site;
    private Closure $menuProvider;
    private ?DateTimeZone $zone = null;
    private bool $enabled = false;
    private const QUOTE_SECONDS = 300;
    private const GUEST_SECONDS = 28800;
    private const BODY_LIMIT = 32768;

    public function __construct(string $privateDir, array $siteConfig, callable $menuProvider, ?array $ordersConfig = null)
    {
        $this->directory = rtrim($privateDir, '/\\').'/orders-data';
        $this->site = $siteConfig;
        $this->menuProvider = Closure::fromCallable($menuProvider);
        if ($ordersConfig === null && is_file($privateDir.'/orders-config.php')) {
            $loaded = require $privateDir.'/orders-config.php';
            $ordersConfig = is_array($loaded) ? $loaded : [];
        }
        $this->config = $ordersConfig ?? [];
        try { $this->enabled = $this->validateConfig(); } catch (Throwable) { $this->enabled = false; }
    }

    /** Deliberately fictional conditions, enabled only on the explicit local development host. */
    public static function developmentConfig(): array
    {
        $week = array_fill(1, 7, [['00:00', '24:00']]);
        return [
            'enabled'=>true, 'mode'=>'development', 'termsApproved'=>false,
            'notice'=>'Тестовое оформление: только вымышленные данные. Это не заказ в кофейню; расписание и условия демонстрационные.',
            'timezone'=>'Europe/Moscow', 'cafeAddress'=>'Тестовый адрес самовывоза, не адрес исполнения заказа', 'cafePhone'=>'+70000000000', 'defaultCity'=>'Тестовый город',
            'schedule'=>['acceptance'=>$week, 'pickup'=>$week, 'delivery'=>$week], 'closedDates'=>[],
            'minDelayMinutes'=>['pickup'=>30, 'delivery'=>60], 'slotMinutes'=>30, 'maxPreorderDays'=>7, 'allowPreorderOutsideHours'=>true,
            'maxLines'=>50, 'maxQuantity'=>99, 'minimumSubtotalMinor'=>['pickup'=>0, 'delivery'=>0],
            'delivery'=>['mode'=>'confirm_by_phone', 'feeMinor'=>null, 'freeFromMinor'=>null, 'zoneNotice'=>'Тестовый режим. В рабочем режиме сотрудник вручную подтверждает адрес и зону доставки.'],
            'consent'=>['version'=>'development-example-v1', 'text'=>'Использую только вымышленные данные в тестовом оформлении.', 'url'=>'/order-terms.html'],
            'paymentNotice'=>'Онлайн-оплата не подключена. Тестовые заказы не исполняются.',
        ];
    }

    private function now(): int { return isset($this->site['orders_clock']) ? (int)($this->site['orders_clock'])() : time(); }
    private function iso(int $time): string { return (new DateTimeImmutable('@'.$time))->setTimezone($this->zone ?? new DateTimeZone('UTC'))->format(DateTimeInterface::ATOM); }
    private static function json(mixed $value): string { return json_encode($value, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR); }
    private static function canonical(mixed $value): mixed
    {
        if (!is_array($value)) return $value;
        if (!array_is_list($value)) ksort($value, SORT_STRING);
        foreach ($value as $key=>$item) $value[$key] = self::canonical($item);
        return $value;
    }
    private static function digest(mixed $value): string { return hash('sha256', self::json(self::canonical($value))); }
    private static function token(mixed $token): bool { return is_string($token) && preg_match('/^[a-f0-9]{64}$/D', $token) === 1; }
    private function devAllowed(): bool
    {
        $origin = parse_url((string)($this->site['public_origin'] ?? ''));
        return ($this->site['allow_http_dev'] ?? false) === true && is_array($origin) && ($origin['scheme'] ?? '') === 'http'
            && in_array($origin['host'] ?? '', ['localhost', '127.0.0.1', '[::1]', '::1'], true)
            && !isset($origin['user']) && !isset($origin['pass']) && !isset($origin['query']) && !isset($origin['fragment']) && (!isset($origin['path']) || $origin['path'] === '');
    }
    private function secureConfigured(): bool
    {
        $origin = parse_url((string)($this->site['public_origin'] ?? ''));
        return $this->devAllowed() || (is_array($origin) && ($origin['scheme'] ?? '') === 'https' && !empty($origin['host']) && !isset($origin['user']) && !isset($origin['pass']) && !isset($origin['query']) && !isset($origin['fragment']) && (!isset($origin['path']) || $origin['path'] === ''));
    }
    private function validateConfig(): bool
    {
        $c = $this->config;
        if (($c['enabled'] ?? false) !== true || !$this->secureConfigured()) return false;
        $mode = $c['mode'] ?? 'production';
        if (!in_array($mode, ['production', 'development'], true) || ($mode === 'development' ? !$this->devAllowed() : ($c['termsApproved'] ?? false) !== true)) return false;
        try { $this->zone = new DateTimeZone($c['timezone'] ?? ''); } catch (Throwable) { return false; }
        if (!in_array($c['timezone'] ?? '', DateTimeZone::listIdentifiers(), true)) return false;
        foreach (['cafeAddress', 'cafePhone', 'paymentNotice'] as $field) if (!is_string($c[$field] ?? null) || trim($c[$field]) === '' || strlen($c[$field]) > 3000) return false;
        foreach (['maxLines'=>[1,50], 'maxQuantity'=>[1,99], 'slotMinutes'=>[5,120], 'maxPreorderDays'=>[0,30]] as $field=>$range) if (!is_int($c[$field] ?? null) || $c[$field] < $range[0] || $c[$field] > $range[1]) return false;
        if (1440 % $c['slotMinutes'] !== 0 || !is_bool($c['allowPreorderOutsideHours'] ?? null)) return false;
        foreach (['pickup', 'delivery'] as $type) {
            if (!is_int($c['minDelayMinutes'][$type] ?? null) || $c['minDelayMinutes'][$type] < 0 || $c['minDelayMinutes'][$type] > 1440) return false;
            if (!is_int($c['minimumSubtotalMinor'][$type] ?? null) || $c['minimumSubtotalMinor'][$type] < 0 || $c['minimumSubtotalMinor'][$type] > 100000000) return false;
        }
        foreach (['acceptance', 'pickup', 'delivery'] as $type) {
            if (!is_array($c['schedule'][$type] ?? null)) return false;
            foreach (range(1, 7) as $day) {
                $intervals = $c['schedule'][$type][$day] ?? null;
                if (!is_array($intervals) || count($intervals) > 8) return false;
                $lastEnd = -1;
                foreach ($intervals as $interval) {
                    if (!is_array($interval) || count($interval) !== 2 || !array_is_list($interval)) return false;
                    [$start, $end] = $interval;
                    if (!is_string($start) || !is_string($end) || !preg_match('/^(?:[01]\d|2[0-3]):[0-5]\d$/D', $start) || !preg_match('/^(?:(?:[01]\d|2[0-3]):[0-5]\d|24:00)$/D', $end)) return false;
                    $s = self::minute($start); $e = self::minute($end);
                    if ($s >= $e || $s < $lastEnd) return false;
                    $lastEnd = $e;
                }
            }
        }
        if (!is_array($c['closedDates'] ?? null) || count($c['closedDates']) > 366) return false;
        foreach ($c['closedDates'] as $date) if (!is_string($date) || !preg_match('/^\d{4}-\d{2}-\d{2}$/D', $date) || (new DateTimeImmutable($date))->format('Y-m-d') !== $date) return false;
        if (!in_array($c['delivery']['mode'] ?? '', ['fixed', 'confirm_by_phone'], true) || !is_string($c['delivery']['zoneNotice'] ?? null) || trim($c['delivery']['zoneNotice']) === '') return false;
        if ($c['delivery']['mode'] === 'fixed' && (!is_int($c['delivery']['feeMinor'] ?? null) || $c['delivery']['feeMinor'] < 0 || $c['delivery']['feeMinor'] > 100000000)) return false;
        if (($c['delivery']['freeFromMinor'] ?? null) !== null && (!is_int($c['delivery']['freeFromMinor']) || $c['delivery']['freeFromMinor'] < 0 || $c['delivery']['freeFromMinor'] > 100000000)) return false;
        if ($c['delivery']['mode'] === 'confirm_by_phone' && (($c['delivery']['feeMinor'] ?? null) !== null || ($c['delivery']['freeFromMinor'] ?? null) !== null)) return false;
        foreach (['text', 'version', 'url'] as $field) if (!is_string($c['consent'][$field] ?? null) || trim($c['consent'][$field]) === '') return false;
        if (!preg_match('~^/(?!/)[a-zA-Z0-9/_-]+\.html$~D', $c['consent']['url'])) return false;
        return true;
    }
    private static function minute(string $value): int { return (int)substr($value, 0, 2) * 60 + (int)substr($value, 3, 2); }
    private function requireEnabled(): void { if (!$this->enabled) throw new CafeOrderException(503, 'Приём заказов через сайт пока не подключён.', 'ordering_disabled'); }

    private function database(): PDO
    {
        if ($this->db !== null) return $this->db;
        if (!is_dir($this->directory) && !@mkdir($this->directory, 0700, true) && !is_dir($this->directory)) throw new RuntimeException('Order storage unavailable');
        $real = realpath($this->directory); $web = realpath((string)($this->site['document_root'] ?? ($_SERVER['DOCUMENT_ROOT'] ?? '')));
        if (!$real || ($web && ($real === $web || str_starts_with(strtolower(str_replace('\\', '/', $real)).'/', strtolower(str_replace('\\', '/', $web)).'/')))) throw new RuntimeException('Order storage must be private');
        $db = new PDO('sqlite:'.$this->directory.'/orders.sqlite', null, null, [PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE=>PDO::FETCH_ASSOC]);
        @chmod($this->directory.'/orders.sqlite', 0600);
        $db->exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;');
        $db->exec('CREATE TABLE IF NOT EXISTS guests (token_hash TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS rate_buckets (bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS quotes (token_hash TEXT PRIMARY KEY, guest_hash TEXT NOT NULL, payload_hash TEXT NOT NULL, snapshot TEXT NOT NULL, expires_at INTEGER NOT NULL, order_id TEXT);
            CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, number TEXT UNIQUE NOT NULL, guest_hash TEXT NOT NULL, idempotency_hash TEXT UNIQUE NOT NULL, payload_hash TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN (\'new\',\'processing\',\'accepted\',\'cancelled\')), created_at INTEGER NOT NULL, original_request TEXT NOT NULL, snapshot TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS order_history (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT NOT NULL REFERENCES orders(id), event TEXT NOT NULL, author TEXT NOT NULL, created_at INTEGER NOT NULL, snapshot TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), channel TEXT, status TEXT NOT NULL, created_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), event TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, payload TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS orders_created ON orders(created_at DESC);
            CREATE INDEX IF NOT EXISTS quotes_expiry ON quotes(expires_at);
            CREATE INDEX IF NOT EXISTS guests_expiry ON guests(expires_at);');
        return $this->db = $db;
    }
    private function statement(string $sql, array $parameters = []): PDOStatement { $s = $this->database()->prepare($sql); $s->execute($parameters); return $s; }
    private function transaction(callable $operation): mixed
    {
        $db = $this->database(); $db->exec('BEGIN IMMEDIATE');
        try { $value = $operation(); $db->exec('COMMIT'); return $value; }
        catch (Throwable $error) { $db->exec('ROLLBACK'); throw $error; }
    }
    private function limit(string $action, string $peer, int $peerMax, int $globalMax): void
    {
        $this->transaction(function () use ($action, $peer, $peerMax, $globalMax): void {
            $now = $this->now(); $this->statement('DELETE FROM rate_buckets WHERE expires_at <= ?', [$now]);
            $buckets = [$action.':peer:'.hash('sha256', $peer)=>$peerMax, $action.':global'=>$globalMax];
            foreach ($buckets as $key=>$max) {
                $row = $this->statement('SELECT count,expires_at FROM rate_buckets WHERE bucket=?', [$key])->fetch();
                if ($row && (int)$row['count'] >= $max) throw new CafeOrderException(429, 'Слишком много запросов. Повторите позже.', 'rate_limited', [], max(1, (int)$row['expires_at'] - $now));
            }
            foreach ($buckets as $key=>$max) $this->statement('INSERT INTO rate_buckets(bucket,count,expires_at) VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET count=count+1', [$key, $now + 900]);
            $this->statement('DELETE FROM quotes WHERE expires_at <= ? AND order_id IS NULL', [$now - 3600]);
            $this->statement('DELETE FROM guests WHERE expires_at <= ?', [$now]);
        });
    }
    private function guest(?string $token, ?string $csrf = null): string
    {
        if (!self::token($token)) throw new CafeOrderException(403, 'Обновите страницу оформления и повторите запрос.', 'csrf');
        $hash = hash('sha256', $token);
        $row = $this->statement('SELECT csrf,expires_at FROM guests WHERE token_hash=?', [$hash])->fetch();
        if (!$row || (int)$row['expires_at'] <= $this->now() || ($csrf !== null && !hash_equals($row['csrf'], $csrf))) throw new CafeOrderException(403, 'Обновите страницу оформления и повторите запрос.', 'csrf');
        return $hash;
    }

    public function settings(?string $token = null, string $peer = 'unknown'): array
    {
        $base = ['enabled'=>$this->enabled, 'mode'=>$this->config['mode'] ?? 'production', 'notice'=>$this->enabled ? ($this->config['notice'] ?? '') : 'Приём заказов через сайт пока не подключён. Условия оформления готовятся.', 'serverNow'=>$this->iso($this->now()), 'csrfToken'=>null, 'settings'=>null, 'availability'=>['pickup'=>['asap'=>false,'slots'=>[]], 'delivery'=>['asap'=>false,'slots'=>[]]]];
        if (!$this->enabled) return $base;
        $this->limit('settings', $peer, 120, 3000);
        $session = $this->transaction(function () use ($token): array {
            $hash = self::token($token) ? hash('sha256', $token) : '';
            $row = $this->statement('SELECT csrf,expires_at FROM guests WHERE token_hash=?', [$hash])->fetch();
            if ($row && (int)$row['expires_at'] > $this->now()) return ['token'=>$token, 'csrf'=>$row['csrf']];
            $token = bin2hex(random_bytes(32)); $csrf = bin2hex(random_bytes(32));
            $this->statement('INSERT INTO guests VALUES(?,?,?)', [hash('sha256', $token), $csrf, $this->now() + self::GUEST_SECONDS]);
            return ['token'=>$token, 'csrf'=>$csrf];
        });
        $base['csrfToken'] = $session['csrf']; $base['_guestToken'] = $session['token'];
        $base['settings'] = ['currency'=>'RUB'] + array_intersect_key($this->config, array_flip(['timezone','cafeAddress','cafePhone','defaultCity','maxLines','maxQuantity','minimumSubtotalMinor','delivery','consent','paymentNotice']));
        foreach (['pickup','delivery'] as $type) $base['availability'][$type] = $this->availability($type);
        return $base;
    }
    private function open(string $type, int $timestamp): bool
    {
        $date = (new DateTimeImmutable('@'.$timestamp))->setTimezone($this->zone);
        if (in_array($date->format('Y-m-d'), $this->config['closedDates'], true)) return false;
        $minute = (int)$date->format('G') * 60 + (int)$date->format('i');
        foreach ($this->config['schedule'][$type][(int)$date->format('N')] as [$start,$end]) if ($minute >= self::minute($start) && $minute < self::minute($end)) return true;
        return false;
    }
    private function availability(string $type): array
    {
        $now = $this->now(); $min = $now + $this->config['minDelayMinutes'][$type] * 60;
        $asap = $this->open('acceptance', $now) && $this->open($type, $now) && $this->open($type, $min);
        $slots = [];
        if ($this->open('acceptance', $now) || $this->config['allowPreorderOutsideHours']) {
            $day = (new DateTimeImmutable('@'.$now))->setTimezone($this->zone)->setTime(0,0);
            for ($n=0; $n <= $this->config['maxPreorderDays']; $n++, $day=$day->modify('+1 day')) {
                $end = $day->modify('+1 day')->getTimestamp();
                for ($time=$day->getTimestamp(); $time < $end; $time += 60) {
                    $local = (new DateTimeImmutable('@'.$time))->setTimezone($this->zone);
                    if (((int)$local->format('G') * 60 + (int)$local->format('i')) % $this->config['slotMinutes'] === 0 && $time >= $min && $this->open($type, $time)) $slots[] = $local->format(DateTimeInterface::ATOM);
                }
            }
        }
        return ['asap'=>$asap, 'slots'=>$slots];
    }
    private static function field(mixed $value, string $name, int $max, bool $required = false): string
    {
        if (!is_string($value) || preg_match('/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/', $value) || !preg_match('//u', $value)) throw new CafeOrderException(422, 'Проверьте поля заказа.', 'invalid_order', ['field'=>$name]);
        $value = preg_replace('/^\s+|\s+$/u', '', $value);
        if (($required && $value === '') || preg_match_all('/./us', $value) > $max) throw new CafeOrderException(422, 'Проверьте поля заказа.', 'invalid_order', ['field'=>$name]);
        return $value;
    }
    private function draft(array $body): array
    {
        $rawItems = $body['items'] ?? null;
        if (!is_array($rawItems) || !array_is_list($rawItems) || count($rawItems) < 1 || count($rawItems) > $this->config['maxLines']) throw new CafeOrderException(422, 'Проверьте состав корзины.', 'invalid_order', ['field'=>'items']);
        $items = []; $ids = [];
        foreach ($rawItems as $item) {
            if (!is_array($item) || !is_string($item['id'] ?? null) || !preg_match('/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/D', $item['id']) || !is_int($item['quantity'] ?? null) || $item['quantity'] < 1 || $item['quantity'] > $this->config['maxQuantity'] || isset($ids[$item['id']])) throw new CafeOrderException(422, 'Проверьте состав корзины.', 'invalid_order', ['field'=>'items']);
            $ids[$item['id']] = true; $items[] = ['id'=>$item['id'], 'quantity'=>$item['quantity']];
        }
        usort($items, static fn(array $a,array $b): int => strcmp($a['id'], $b['id']));
        $f = $body['fulfilment'] ?? null;
        if (!is_array($f) || !in_array($f['type'] ?? null, ['pickup','delivery'], true) || !in_array($f['timing'] ?? null, ['asap','scheduled'], true)) throw new CafeOrderException(422, 'Выберите способ получения и время.', 'invalid_order', ['field'=>'fulfilment']);
        if ($f['timing'] === 'asap') {
            if (!array_key_exists('requestedAt', $f) || $f['requestedAt'] !== null) throw new CafeOrderException(422, 'Для ближайшего времени дата не указывается.', 'invalid_time');
            $requested = null; $now = $this->now();
            if (!$this->open('acceptance', $now) || !$this->open($f['type'], $now) || !$this->open($f['type'], $now + $this->config['minDelayMinutes'][$f['type']] * 60)) throw new CafeOrderException(422, 'Ближайшее время недоступно. Выберите время из расписания.', 'invalid_time');
        } else {
            $raw = $f['requestedAt'] ?? null;
            if (!is_string($raw) || !preg_match('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::00)?(?:Z|[+-]\d{2}:\d{2})$/D', $raw)) throw new CafeOrderException(422, 'Укажите дату и время из расписания.', 'invalid_time');
            try { $date = new DateTimeImmutable($raw); } catch (Throwable) { throw new CafeOrderException(422, 'Укажите дату и время из расписания.', 'invalid_time'); }
            $errors = DateTimeImmutable::getLastErrors();
            if ($errors && ($errors['warning_count'] || $errors['error_count'])) throw new CafeOrderException(422, 'Укажите корректную дату и время.', 'invalid_time');
            $date = $date->setTimezone($this->zone); $now = $this->now();
            $last = (new DateTimeImmutable('@'.$now))->setTimezone($this->zone)->modify('+'.$this->config['maxPreorderDays'].' days')->format('Y-m-d');
            if ((!$this->open('acceptance', $now) && !$this->config['allowPreorderOutsideHours']) || $date->getTimestamp() < $now + $this->config['minDelayMinutes'][$f['type']] * 60 || $date->format('Y-m-d') > $last || ((int)$date->format('G') * 60 + (int)$date->format('i')) % $this->config['slotMinutes'] !== 0 || !$this->open($f['type'], $date->getTimestamp())) throw new CafeOrderException(422, 'Выбранное время уже недоступно. Выберите другой слот.', 'invalid_time');
            $requested = $date->format(DateTimeInterface::ATOM);
        }
        $address = null;
        if ($f['type'] === 'delivery') {
            if (!is_array($f['address'] ?? null)) throw new CafeOrderException(422, 'Укажите адрес доставки.', 'invalid_order', ['field'=>'address']);
            $address = [];
            foreach (['city'=>100,'streetHouse'=>250,'apartment'=>50,'entrance'=>30,'floor'=>30,'intercom'=>50] as $key=>$max) $address[$key] = self::field($f['address'][$key] ?? '', 'address.'.$key, $max, in_array($key,['city','streetHouse'],true));
        } elseif (!array_key_exists('address', $f) || $f['address'] !== null) throw new CafeOrderException(422, 'Для самовывоза адрес доставки не нужен.', 'invalid_order', ['field'=>'address']);
        $courier = self::field($f['courierInstructions'] ?? '', 'courierInstructions', 1000);
        if ($f['type'] === 'pickup') $courier = '';
        $contact = $body['contact'] ?? null;
        if (!is_array($contact)) throw new CafeOrderException(422, 'Укажите телефон.', 'invalid_order', ['field'=>'phone']);
        $phone = self::field($contact['phone'] ?? '', 'phone', 40, true);
        if (!preg_match('/^\+?[0-9 ()-]+$/D', $phone)) throw new CafeOrderException(422, 'Укажите российский номер телефона.', 'invalid_order', ['field'=>'phone']);
        $digits = preg_replace('/\D/', '', $phone);
        if (strlen($digits) === 11 && $digits[0] === '8' && !str_starts_with($phone, '+')) $digits = '7'.substr($digits, 1);
        if (!preg_match('/^7\d{10}$/D', $digits)) throw new CafeOrderException(422, 'Укажите российский номер телефона с кодом +7.', 'invalid_order', ['field'=>'phone']);
        if (($body['consent']['accepted'] ?? null) !== true || ($body['consent']['version'] ?? null) !== $this->config['consent']['version']) throw new CafeOrderException(422, 'Подтвердите актуальные условия оформления.', 'consent_required');
        return ['items'=>$items, 'fulfilment'=>['type'=>$f['type'],'timing'=>$f['timing'],'requestedAt'=>$requested,'address'=>$address,'courierInstructions'=>$courier], 'contact'=>['phone'=>'+'.$digits,'name'=>self::field($contact['name'] ?? '', 'name', 100)], 'orderComment'=>self::field($body['orderComment'] ?? '', 'orderComment', 1000), 'consent'=>['accepted'=>true,'version'=>$this->config['consent']['version']]];
    }
    private function calculate(array $draft): array
    {
        $menu = ($this->menuProvider)();
        if (!is_array($menu) || !is_array($menu['items'] ?? null) || !is_int($menu['revision'] ?? null)) throw new CafeOrderException(503, 'Актуальное меню недоступно. Попробуйте позже.', 'menu_unavailable');
        $catalog = []; foreach ($menu['items'] as $item) $catalog[$item['id']] = $item;
        $lines = []; $unavailable = []; $subtotal = 0;
        foreach ($draft['items'] as $line) {
            $item = $catalog[$line['id']] ?? null;
            if (!$item || ($item['published'] ?? false) !== true || ($item['availableForOrder'] ?? true) !== true) { $unavailable[] = ['id'=>$line['id'],'available'=>false]; continue; }
            $price = $item['price'] ?? null;
            if ((!is_int($price) && !is_float($price)) || !is_finite((float)$price) || $price < 0 || $price > 1000000 || abs($price * 100 - round($price * 100)) > 0.00001) throw new CafeOrderException(503, 'Цена блюда требует проверки. Попробуйте позже.', 'menu_unavailable');
            $minor = (int)round($price * 100, 0, PHP_ROUND_HALF_UP); $total = $minor * $line['quantity']; $subtotal += $total;
            $lines[] = ['id'=>$line['id'],'name'=>$item['name'],'quantity'=>$line['quantity'],'unitPriceMinor'=>$minor,'lineTotalMinor'=>$total];
        }
        if ($unavailable) throw new CafeOrderException(409, 'Некоторые блюда временно недоступны. Проверьте корзину.', 'item_unavailable', ['items'=>$unavailable]);
        $minimum = $this->config['minimumSubtotalMinor'][$draft['fulfilment']['type']];
        if ($subtotal < $minimum) throw new CafeOrderException(422, 'Сумма блюд меньше минимальной для выбранного способа получения.', 'minimum_not_met', ['minimumSubtotalMinor'=>$minimum,'subtotalMinor'=>$subtotal]);
        $delivery = $this->config['delivery'];
        $fee = $draft['fulfilment']['type'] === 'pickup' ? 0 : ($delivery['mode'] === 'confirm_by_phone' ? null : (($delivery['freeFromMinor'] ?? null) !== null && $subtotal >= $delivery['freeFromMinor'] ? 0 : $delivery['feeMinor']));
        return ['menuRevision'=>$menu['revision'],'currency'=>'RUB','items'=>$lines,'subtotalMinor'=>$subtotal,'deliveryFeeMinor'=>$fee,'totalMinor'=>$fee === null ? null : $subtotal + $fee,'fulfilment'=>$draft['fulfilment']];
    }
    private function saveQuote(array $draft, array $snapshot, string $guest): array
    {
        $token = bin2hex(random_bytes(32)); $expires = $this->now() + self::QUOTE_SECONDS;
        $quote = ['quoteId'=>$token,'expiresAt'=>$this->iso($expires)] + $snapshot;
        $this->statement('INSERT INTO quotes(token_hash,guest_hash,payload_hash,snapshot,expires_at) VALUES(?,?,?,?,?)', [hash('sha256',$token),$guest,self::digest($draft),self::json($snapshot),$expires]);
        return $quote;
    }
    public function quote(array $body, ?string $guestToken, string $csrf, string $peer): array
    {
        $this->requireEnabled(); $guest = $this->guest($guestToken, $csrf); $this->limit('quote', $peer, 60, 1200);
        $draft = $this->draft($body); $snapshot = $this->calculate($draft);
        return ['quote'=>$this->transaction(fn(): array => $this->saveQuote($draft,$snapshot,$guest))];
    }
    public function create(array $body, ?string $guestToken, string $csrf, string $peer): array
    {
        $this->requireEnabled(); $guest = $this->guest($guestToken, $csrf);
        $key = $body['idempotencyKey'] ?? null; $quoteId = $body['quoteId'] ?? null;
        if (!is_string($key) || !preg_match('/^(?:[a-f0-9]{32,64}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/Di', $key) || !self::token($quoteId)) throw new CafeOrderException(422, 'Обновите расчёт заказа.', 'invalid_order');
        $keyHash = hash('sha256', $key); $payload = self::digest($body);
        // Completed retries do not depend on current menu, opening hours or expired quotes.
        $previous = $this->statement('SELECT guest_hash,payload_hash,snapshot FROM orders WHERE idempotency_hash=?', [$keyHash])->fetch();
        if ($previous) return $this->replay($previous,$guest,$payload);
        $this->limit('create', $peer, 12, 240);
        $result = $this->transaction(function () use ($body,$guest,$keyHash,$quoteId,$payload): array {
            $previous = $this->statement('SELECT guest_hash,payload_hash,snapshot FROM orders WHERE idempotency_hash=?', [$keyHash])->fetch();
            if ($previous) return $this->replay($previous,$guest,$payload);
            $stored = $this->statement('SELECT * FROM quotes WHERE token_hash=?', [hash('sha256',$quoteId)])->fetch();
            if (!$stored || !hash_equals($stored['guest_hash'],$guest) || (int)$stored['expires_at'] <= $this->now()) throw new CafeOrderException(410, 'Расчёт устарел. Получите актуальную сумму.', 'quote_expired');
            if ($stored['order_id'] !== null) throw new CafeOrderException(409, 'Этот расчёт уже отправлен. Повторите первоначальный запрос.', 'quote_used');
            $draft = $this->draft($body); $snapshot = $this->calculate($draft);
            if (!hash_equals($stored['payload_hash'],self::digest($draft)) || !hash_equals(self::digest(json_decode($stored['snapshot'],true,512,JSON_THROW_ON_ERROR)),self::digest($snapshot))) {
                // Commit a replacement quote, then report a conflict outside the transaction.
                return ['_changed'=>$this->saveQuote($draft,$snapshot,$guest)];
            }
            $id = bin2hex(random_bytes(16)); $now = $this->now(); $number = (new DateTimeImmutable('@'.$now))->setTimezone($this->zone)->format('ymd').'-'.strtoupper(bin2hex(random_bytes(4)));
            $order = ['number'=>$number,'status'=>'new','createdAt'=>$this->iso($now),'payment'=>['method'=>null,'status'=>'not_configured','paidAmountMinor'=>null]] + $snapshot;
            $this->statement('INSERT INTO orders VALUES(?,?,?,?,?,?,?,?,?)', [$id,$number,$guest,$keyHash,$payload,'new',$now,self::json($draft),self::json($order)]);
            $this->statement('INSERT INTO order_history(order_id,event,author,created_at,snapshot) VALUES(?,?,?,?,?)', [$id,'created','guest',$now,self::json(['request'=>$draft,'order'=>$order])]);
            $this->statement('INSERT INTO notifications(id,order_id,channel,status,created_at) VALUES(?,?,NULL,?,?)', [bin2hex(random_bytes(16)),$id,'pending',$now]);
            $this->statement('INSERT INTO outbox VALUES(?,?,?,?,?,?)', [bin2hex(random_bytes(16)),$id,'order.created','pending',$now,self::json(['orderId'=>$id])]);
            $this->statement('UPDATE quotes SET order_id=? WHERE token_hash=?', [$id,hash('sha256',$quoteId)]);
            return ['order'=>$order,'_replayed'=>false];
        });
        if (isset($result['_changed'])) throw new CafeOrderException(409, 'Условия или состав заказа изменились. Проверьте новый расчёт и отправьте ещё раз.', 'quote_changed', ['quote'=>$result['_changed']]);
        return $result;
    }
    private function replay(array $previous, string $guest, string $payload): array
    {
        if (!hash_equals($previous['guest_hash'],$guest) || !hash_equals($previous['payload_hash'],$payload)) throw new CafeOrderException(409, 'Ключ отправки уже использован для другого запроса.', 'idempotency_conflict');
        return ['order'=>json_decode($previous['snapshot'],true,512,JSON_THROW_ON_ERROR),'_replayed'=>true];
    }
    /** Only call behind the existing authenticated MFA administrator boundary. No public route. */
    public function list(int $limit = 50, int $offset = 0): array
    {
        $limit = max(1,min(100,$limit)); $offset = max(0,min(100000,$offset));
        $rows = $this->database()->query('SELECT snapshot,original_request FROM orders ORDER BY created_at DESC,id DESC LIMIT '.$limit.' OFFSET '.$offset)->fetchAll();
        return ['orders'=>array_map(static fn(array $row): array => ['order'=>json_decode($row['snapshot'],true,512,JSON_THROW_ON_ERROR),'request'=>json_decode($row['original_request'],true,512,JSON_THROW_ON_ERROR)],$rows)];
    }

    public function checkRequestSecurity(?string $origin, ?string $fetchSite, bool $https, string $peer, bool $mutation): void
    {
        $dev = $this->devAllowed() && in_array($peer,['127.0.0.1','::1'],true);
        if (!$https && !$dev) throw new CafeOrderException(400, 'Оформление доступно только через HTTPS.', 'https_required');
        if ($mutation && ($origin !== ($this->site['public_origin'] ?? '') || in_array($fetchSite,['cross-site','same-site'],true))) throw new CafeOrderException(403, 'Запрос должен быть отправлен с этого сайта.', 'origin');
        if (!$mutation && $fetchSite === 'cross-site') throw new CafeOrderException(403, 'Откройте оформление на сайте кофейни.', 'origin');
    }
    private static function response(array $value, int $status = 200): void
    {
        http_response_code($status); header('Content-Type: application/json; charset=utf-8'); header('Cache-Control: no-store'); header('X-Content-Type-Options: nosniff'); header('X-Robots-Tag: noindex, nofollow');
        echo self::json($value);
    }
    private static function body(): array
    {
        if (strtolower(trim(explode(';',$_SERVER['CONTENT_TYPE'] ?? '')[0])) !== 'application/json') throw new CafeOrderException(415,'Отправьте JSON-запрос.','content_type');
        if ((int)($_SERVER['CONTENT_LENGTH'] ?? 0) > self::BODY_LIMIT) throw new CafeOrderException(413,'Слишком большой запрос.','too_large');
        $raw = file_get_contents('php://input',false,null,0,self::BODY_LIMIT+1);
        if ($raw === false || strlen($raw) > self::BODY_LIMIT) throw new CafeOrderException(413,'Слишком большой запрос.','too_large');
        try { $object = json_decode($raw,false,32,JSON_THROW_ON_ERROR); $body = json_decode($raw,true,32,JSON_THROW_ON_ERROR); }
        catch (Throwable) { throw new CafeOrderException(400,'Некорректный JSON-запрос.','invalid_json'); }
        if (!is_object($object) || !is_array($body)) throw new CafeOrderException(400,'Некорректный JSON-запрос.','invalid_json');
        return $body;
    }
    public function dispatch(string $path, string $method): bool
    {
        if (!in_array($path,['/api/ordering','/api/orders/quote','/api/orders'],true)) return false;
        try {
            $peer = (string)($_SERVER['REMOTE_ADDR'] ?? 'unknown');
            $this->checkRequestSecurity($_SERVER['HTTP_ORIGIN'] ?? null,$_SERVER['HTTP_SEC_FETCH_SITE'] ?? null,!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off',$peer,$method !== 'GET');
            $token = is_string($_COOKIE['vosem_order_guest'] ?? null) ? $_COOKIE['vosem_order_guest'] : null;
            if ($path === '/api/ordering' && $method === 'GET') {
                $result = $this->settings($token,$peer);
                if (isset($result['_guestToken'])) { setcookie('vosem_order_guest',$result['_guestToken'],['expires'=>time()+self::GUEST_SECONDS,'path'=>'/api','secure'=>!$this->devAllowed(),'httponly'=>true,'samesite'=>'Strict']); unset($result['_guestToken']); }
                self::response($result); return true;
            }
            if ($method !== 'POST' || $path === '/api/ordering') throw new CafeOrderException(405,'Метод не поддерживается.','method');
            $csrf = (string)($_SERVER['HTTP_X_CSRF_TOKEN'] ?? ''); $body = self::body();
            $result = $path === '/api/orders/quote' ? $this->quote($body,$token,$csrf,$peer) : $this->create($body,$token,$csrf,$peer);
            $status = $path === '/api/orders' && !($result['_replayed'] ?? false) ? 201 : 200; unset($result['_replayed']); self::response($result,$status);
        } catch (CafeOrderException $error) {
            if ($error->retryAfter !== null) header('Retry-After: '.$error->retryAfter);
            self::response(['error'=>$error->getMessage(),'code'=>$error->errorCode] + ($error->details ? ['details'=>$error->details] : []),$error->status);
        } catch (Throwable) {
            // Neither personal data nor exception strings belong in shared hosting logs.
            error_log('Cafe order API request failed.'); self::response(['error'=>'Не удалось сохранить запрос. Повторите отправку с прежним ключом.','code'=>'server_error'],503);
        }
        return true;
    }
}

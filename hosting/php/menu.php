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

/** Keep the JSON contract shared with the menu editor and public menu client. */
function cafe_validate_items(mixed $items): array {
    if (!is_array($items) || !array_is_list($items) || count($items) > 300) throw new CafeMenuException(400, 'Меню должно содержать не более 300 позиций.', 'invalid_items');
    $ids = []; $validated = [];
    foreach ($items as $index => $item) {
        if (!is_array($item) || array_is_list($item)) throw new CafeMenuException(400, 'Некорректная позиция '.($index + 1).'.', 'invalid_item');
        $id = cafe_text_field($item['id'] ?? null, 'идентификатор', 100, 1);
        if (!preg_match('/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/D', $id) || isset($ids[$id])) throw new CafeMenuException(400, 'Идентификаторы позиций должны быть уникальными.', 'invalid_id');
        $ids[$id] = true;
        $category = $item['category'] ?? null;
        if (!is_string($category) || !in_array($category, ['signature', 'eggs', 'porridge', 'sweet'], true)) throw new CafeMenuException(400, 'Выберите категорию завтрака.', 'invalid_category');
        $price = $item['price'] ?? null;
        if ((!is_int($price) && !is_float($price)) || !is_finite((float)$price) || $price < 0 || $price > 1000000 || abs($price * 100 - round($price * 100)) > 0.00001) throw new CafeMenuException(400, 'Укажите корректную цену в рублях.', 'invalid_price');
        if (!is_bool($item['published'] ?? null)) throw new CafeMenuException(400, 'Укажите видимость позиции.', 'invalid_published');
        $availableForOrder = array_key_exists('availableForOrder', $item) ? $item['availableForOrder'] : true;
        if (!is_bool($availableForOrder)) throw new CafeMenuException(400, 'Укажите доступность позиции для заказа.', 'invalid_availability');
        if (!is_int($item['order'] ?? null) || $item['order'] < 0 || $item['order'] > 100000) throw new CafeMenuException(400, 'Укажите корректный порядок позиции.', 'invalid_order');
        $image = cafe_text_field($item['image'] ?? null, 'фотография', 250);
        if ($image !== '') {
            if (!str_starts_with($image, '/')) $image = '/'.$image;
            if (!preg_match('~^/(menu-images|uploads)/[a-zA-Z0-9][a-zA-Z0-9._-]*\.(?:jpe?g|png|webp)$~iD', $image) || str_contains($image, '..')) throw new CafeMenuException(400, 'Загрузите фотографию JPG, PNG или WebP.', 'invalid_image');
        }
        $validated[] = ['id'=>$id, 'name'=>cafe_text_field($item['name'] ?? null, 'название', 160, 1), 'description'=>cafe_text_field($item['description'] ?? null, 'описание', 2000), 'price'=>$price, 'category'=>$category, 'image'=>$image, 'published'=>$item['published'], 'availableForOrder'=>$availableForOrder, 'order'=>$item['order']];
    }
    return $validated;
}

function cafe_request_body(int $limit): string {
    $length = $_SERVER['CONTENT_LENGTH'] ?? '';
    if (is_numeric($length) && (float)$length > $limit) throw new CafeMenuException(413, 'Файл или запрос слишком большой.', 'too_large');
    $body = file_get_contents('php://input', false, null, 0, $limit + 1);
    if ($body === false) throw new CafeMenuException(400, 'Загрузка прервана.', 'aborted');
    if (strlen($body) > $limit) throw new CafeMenuException(413, 'Файл или запрос слишком большой.', 'too_large');
    return $body;
}
function cafe_json_body(): array {
    if (trim(explode(';', $_SERVER['CONTENT_TYPE'] ?? '')[0]) !== 'application/json') throw new CafeMenuException(415, 'Ожидается JSON.', 'content_type');
    $body = cafe_request_body(1024 * 1024);
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
    public readonly CafeAuth $auth;
    private string $dataDir;
    private string $menuFile;
    private string $seedPath;
    private string $uploadsDir;
    private array $config;
    public function __construct(string $privateDir, array $config) {
        $this->dataDir = $privateDir.'/admin-data';
        $this->menuFile = $this->dataDir.'/menu.json';
        $this->seedPath = $privateDir.'/app/seed/menu.json';
        $this->uploadsDir = $this->dataDir.'/uploads';
        $this->config = $config;
        $this->auth = new CafeAuth($this->dataDir, $config);
    }
    private function menuLock(callable $operation): mixed {
        if (!is_dir($this->dataDir) && !@mkdir($this->dataDir, 0700, true) && !is_dir($this->dataDir)) throw new RuntimeException('Menu storage unavailable');
        return CafeStorage::locked($this->dataDir.'/menu.lock', $operation);
    }
    private function readSaved(): array {
        try {
            $saved = CafeStorage::readJson($this->menuFile);
            if (!is_array($saved) || !is_int($saved['revision'] ?? null) || $saved['revision'] < 1 || $saved['revision'] >= 9007199254740991) throw new RuntimeException();
            return ['items'=>cafe_validate_items($saved['items'] ?? null), 'revision'=>$saved['revision']];
        } catch (Throwable) { throw new CafeMenuException(503, 'Сохранённое меню временно недоступно.', 'menu_unavailable'); }
    }
    public function read(): array {
        if (!is_file($this->menuFile)) {
            $this->menuLock(function (): void {
                if (is_file($this->menuFile)) return;
                $seed = CafeStorage::readJson($this->seedPath);
                CafeStorage::atomicJson($this->menuFile, ['items'=>cafe_validate_items($seed['items'] ?? null), 'revision'=>1]);
            });
        }
        return $this->readSaved();
    }
    public function published(): array {
        return $this->catalog()['items'];
    }
    /** Same lock as catalog edits. Always acquire this before an orders DB transaction. */
    public function withLockedSnapshot(callable $operation): mixed {
        $this->read(); // Seed, if necessary, before entering the non-reentrant lock.
        return $this->menuLock(fn(): mixed => $operation($this->readSaved()));
    }
    /** Published items and their revision must come from one authoritative read. */
    public function catalog(): array {
        $menu = $this->read();
        $items = array_values(array_filter($menu['items'], static fn(array $item): bool => $item['published']));
        usort($items, static fn(array $left, array $right): int => $left['order'] <=> $right['order']);
        return ['items'=>$items, 'revision'=>$menu['revision']];
    }
    public function update(array $items, mixed $revision): array {
        $items = cafe_validate_items($items);
        if (!is_int($revision) || $revision < 1 || $revision >= 9007199254740991) throw new CafeMenuException(400, 'Некорректная версия меню.', 'invalid_revision');
        $this->read();
        return $this->menuLock(function () use ($items, $revision): array {
            $menu = $this->readSaved();
            if ($revision !== $menu['revision']) throw new CafeMenuException(409, 'Меню уже изменено в другой вкладке. Загрузите актуальную версию.', 'conflict');
            $updated = ['items'=>$items, 'revision'=>$revision + 1];
            CafeStorage::atomicJson($this->menuFile, $updated);
            return $updated;
        });
    }
    private function peer(): string { return $_SERVER['REMOTE_ADDR'] ?? 'unknown'; }
    private function token(): ?string { return is_string($_COOKIE['vosem_admin'] ?? null) ? $_COOKIE['vosem_admin'] : null; }
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
    private function cookie(string $token, int $seconds): void {
        setcookie('vosem_admin', $token, ['expires'=>$seconds > 0 ? time() + $seconds : time() - 3600, 'path'=>'/api/admin', 'secure'=>!($this->config['allow_http_dev'] ?? false), 'httponly'=>true, 'samesite'=>'Strict']);
    }
    public function storeImage(string $bytes, string $mime): string {
        $extensions = ['image/jpeg'=>'jpg', 'image/png'=>'png', 'image/webp'=>'webp'];
        if (!isset($extensions[$mime])) throw new CafeMenuException(415, 'Поддерживаются JPG, PNG и WebP.', 'invalid_image_type');
        if (strlen($bytes) > 5 * 1024 * 1024) throw new CafeMenuException(413, 'Файл или запрос слишком большой.', 'too_large');
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
            if (!$written || !fflush($stream) || fstat($stream)['size'] > 5 * 1024 * 1024) throw new CafeMenuException(400, 'После обработки фотография слишком большая.', 'invalid_image');
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
            if ($pathname === '/api/admin/session' && $method === 'GET') { cafe_json_response($this->auth->status($this->token())); return true; }
            if ($pathname === '/api/admin/enroll/start' && $method === 'POST') { cafe_json_response($this->auth->enrollStart(cafe_json_body(), $this->peer())); return true; }
            if ($pathname === '/api/admin/enroll/cancel' && $method === 'POST') { cafe_json_response($this->auth->enrollCancel(cafe_json_body(), $this->peer())); return true; }
            if (in_array($pathname, ['/api/admin/login','/api/admin/verify','/api/admin/enroll/confirm'], true) && $method === 'POST') {
                $body = cafe_json_body();
                $result = match ($pathname) {
                    '/api/admin/login'=>$this->auth->login($body, $this->peer(), $this->token()),
                    '/api/admin/verify'=>$this->auth->verify($body, $this->peer()),
                    default=>$this->auth->enrollConfirm($body, $this->peer()),
                };
                if (($result['mfaRequired'] ?? false) || ($result['enrollmentRequired'] ?? false)) cafe_json_response($result, 202);
                else {
                    $this->cookie($result['token'], (int)(($this->config['session_ms'] ?? 28800000) / 1000));
                    unset($result['token']); cafe_json_response($result);
                }
                return true;
            }
            if ($pathname === '/api/admin/logout' && $method === 'POST') {
                $this->requireSession(true); $this->auth->logout($this->token(), $this->peer()); $this->cookie('', 0);
                cafe_json_response(['authenticated'=>false]); return true;
            }
            if ($pathname === '/api/admin/menu' && $method === 'GET') { $this->requireSession(); cafe_json_response($this->read()); return true; }
            if ($pathname === '/api/admin/menu' && $method === 'PUT') {
                $this->requireSession(true); $body = cafe_json_body();
                $items = cafe_validate_items($body['items'] ?? null);
                $updated = $this->update($items, $body['revision'] ?? null);
                $this->auth->audit('menu.updated', $this->peer(), ['revision'=>$updated['revision'], 'count'=>count($items)]);
                cafe_json_response($updated); return true;
            }
            if ($pathname === '/api/admin/upload' && $method === 'POST') {
                $this->requireSession(true);
                $url = $this->storeImage(cafe_request_body(5 * 1024 * 1024), trim(explode(';', $_SERVER['CONTENT_TYPE'] ?? '')[0]));
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

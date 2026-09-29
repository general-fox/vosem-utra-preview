<?php
declare(strict_types=1);

require_once __DIR__.'/telegram.php';
require_once __DIR__.'/staff-orders.php';

function cafe_staff_body(): array {
    if (strtolower(trim(explode(';', $_SERVER['CONTENT_TYPE'] ?? '')[0])) !== 'application/json') throw new CafeOrderException(415, 'Ожидается JSON.', 'content_type');
    $raw = cafe_request_body(65536);
    try {
        if (!str_starts_with(ltrim($raw), '{')) throw new RuntimeException();
        $body = json_decode($raw, true, 32, JSON_THROW_ON_ERROR);
        if (!is_array($body)) throw new RuntimeException();
        return $body;
    } catch (Throwable) { throw new CafeOrderException(400, 'Некорректный запрос.', 'invalid_json'); }
}

/** API authority is always checked by the server, never by a deep-link parameter. */
function cafe_staff_dispatch(string $path, string $method, string $privateDir, array $config, CafeOrders $orders, ?callable $telegramConfig = null): bool {
    if (!str_starts_with($path, '/api/staff/') && $path !== '/api/telegram/webhook') return false;
    $requestId = bin2hex(random_bytes(8));
    header('X-Request-Id: '.$requestId);
    try {
        $config['telegram_environment'] = $orders->environment();
        $telegram = new CafeTelegram($privateDir, $config, $orders->connection(), null, $telegramConfig);
        $peer = (string)($_SERVER['REMOTE_ADDR'] ?? 'unknown');
        $https = !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off';
        if ($path === '/api/telegram/webhook') {
            if (!$https) throw new CafeOrderException(400, 'Требуется HTTPS.', 'https_required');
            if ($method !== 'POST') throw new CafeOrderException(405, 'Метод не поддерживается.', 'method');
            // Telegram sends server-to-server requests, not browser Origin headers.
            $secret = (string)($_SERVER['HTTP_X_TELEGRAM_BOT_API_SECRET_TOKEN'] ?? '');
            $telegram->verifyWebhookSecret($secret);
            $result = $telegram->webhook($secret, cafe_staff_body());
            cafe_json_response($result); return true;
        }
        $telegram->checkRequestSecurity($_SERVER['HTTP_ORIGIN'] ?? null, $_SERVER['HTTP_SEC_FETCH_SITE'] ?? null, $https, $peer, $method !== 'GET');
        if ($path === '/api/staff/session' && $method === 'POST') {
            $body = cafe_staff_body();
            if (!is_string($body['initData'] ?? null)) throw new CafeOrderException(400, 'Откройте приложение из Telegram.', 'init_data');
            cafe_json_response($telegram->authenticate($body['initData'], $peer)); return true;
        }
        $authorization = (string)($_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '');
        if (!preg_match('/^Bearer ([a-f0-9]{64})$/D', $authorization, $match)) throw new CafeOrderException(401, 'Откройте приложение заново из Telegram.', 'session_required');
        $bearer = $match[1]; $actor = $telegram->session($bearer);
        if ($path === '/api/staff/session' && $method === 'GET') { cafe_json_response(['staff'=>$actor]); return true; }
        if ($path === '/api/staff/logout' && $method === 'POST') { $telegram->logout($bearer); cafe_json_response(['ok'=>true]); return true; }
        if ($path === '/api/staff/settings' && $method === 'GET') {
            $settings = $orders->staffSettings();
            $settings['staff'] = $actor['role'] === 'manager' ? $telegram->activeStaff() : [];
            cafe_json_response($settings); return true;
        }
        if ($path === '/api/staff/notifications' && $method === 'GET') { cafe_json_response($telegram->diagnostics($actor)); return true; }
        if (preg_match('~^/api/staff/notifications/([1-9][0-9]{0,15})/retry$~D', $path, $match) && $method === 'POST') {
            $telegram->retryNotification($actor, (int)$match[1]); cafe_json_response(['ok'=>true]); return true;
        }
        $staff = new CafeStaffOrders($orders, $config, static fn(string $id): ?array => $telegram->staffMember($id));
        if ($path === '/api/staff/orders/search' && $method === 'POST') { cafe_json_response($staff->search(cafe_staff_body(), $actor)); return true; }
        if (preg_match('~^/api/staff/orders/([a-f0-9]{32})(?:/(claim|release|reassign|contact-attempts|accept|cancel))?$~D', $path, $match)) {
            $id = $match[1]; $action = $match[2] ?? '';
            if ($method === 'GET' && $action === '') { cafe_json_response($staff->detail($id, $actor)); return true; }
            if (($action === '' && $method === 'PATCH') || ($action !== '' && $method === 'POST')) {
                $body = cafe_staff_body();
                if ($action === 'accept') {
                    $key = $_SERVER['HTTP_IDEMPOTENCY_KEY'] ?? null;
                    if (!is_string($key) || $key === '' || (isset($body['idempotencyKey']) && $key !== $body['idempotencyKey'])) throw new CafeOrderException(400, 'Некорректный ключ повторной отправки.', 'idempotency_key');
                    $body['idempotencyKey'] = $key;
                }
                cafe_json_response($staff->command($action ?: 'save', $id, $body, $actor)); return true;
            }
            throw new CafeOrderException(405, 'Метод не поддерживается.', 'method');
        }
        if (preg_match('~^/api/staff/events/([a-f0-9-]{32,36})/retry$~D', $path, $match) && $method === 'POST') { cafe_json_response($staff->retry($match[1], cafe_staff_body(), $actor)); return true; }
        throw new CafeOrderException(404, 'Адрес API не найден.', 'not_found');
    } catch (Throwable $error) {
        if ($error instanceof CafeOrderException || $error instanceof CafeTelegramException || $error instanceof CafeMenuException) {
            $status = $error->status; $code = $error->errorCode; $message = $error->getMessage();
            $details = $error->details ?? [];
            if (($error->retryAfter ?? null) !== null) header('Retry-After: '.$error->retryAfter);
        } else {
            $status = 503; $code = 'server_error'; $message = 'Сервис временно недоступен. Обновите данные и повторите действие.'; $details = [];
            error_log('Cafe staff API failed; request '.$requestId.'.');
        }
        cafe_json_response(['code'=>$code, 'message'=>$message, 'error'=>$message, 'requestId'=>$requestId] + ($details ? ['details'=>$details] : []), $status);
        return true;
    }
}

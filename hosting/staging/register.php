<?php
declare(strict_types=1);
// No loyalty provider, CAPTCHA request, session or personal data collection on staging.
http_response_code(503);
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
header('X-Robots-Tag: noindex, nofollow');
echo json_encode(['IsSuccess'=>false, 'Message'=>'Регистрация в клубе на тестовом стенде отключена. Данные в систему кофейни не отправляются.'], JSON_UNESCAPED_UNICODE);

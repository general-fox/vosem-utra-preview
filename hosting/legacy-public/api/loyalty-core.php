<?php
declare(strict_types=1);

// Opt-in diagnostics; the local server supplies a path outside the web root.
function loyalty_log(string $event, array $details = []): void {
    $path = getenv('LOYALTY_DEBUG_LOG');
    if (!$path) return;
    $entry = ['time'=>gmdate('c'),'request_id'=>$GLOBALS['loyalty_request_id'] ?? 'cli','event'=>$event,'details'=>$details];
    $line = json_encode($entry, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
    if (@file_put_contents($path, $line.PHP_EOL, FILE_APPEND | LOCK_EX) === false) error_log('Loyalty diagnostic log could not be written.');
}

function loyalty_redact(string $text, array $payload, string $apiKey): string {
    // Decode JSON first so escaped Cyrillic and phone numbers are also redacted.
    $decoded = json_decode($text, true);
    if (json_last_error() === JSON_ERROR_NONE) $text = json_encode($decoded, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
    $secrets = array_filter(array_merge([$apiKey], array_values($payload)), static fn($v) => is_string($v) && $v !== '');
    usort($secrets, static fn($a,$b) => strlen($b) <=> strlen($a));
    $text = str_replace($secrets, '[redacted]', $text);
    $text = preg_replace('/(?:\+7|8)[\s()\d-]{10,20}/', '[phone redacted]', $text);
    return substr($text, 0, 32768);
}

function loyalty_payload(array $input): array {
    if (($input['Consent'] ?? null) !== true) {
        throw new InvalidArgumentException('Для регистрации нужно согласие на обработку персональных данных.');
    }
    $payload = [];
    foreach (['LastName', 'FirstName', 'MiddleName', 'Comment'] as $field) {
        $value = $input[$field] ?? '';
        $controlCharacters = $field === 'Comment' ? '/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/u' : '/[\x00-\x1F\x7F]/u';
        if (!is_string($value) || preg_match('//u', $value) !== 1 || preg_match($controlCharacters, $value)) {
            throw new InvalidArgumentException('Проверьте заполнение текстовых полей.');
        }
        $value = trim($value);
        if ($field === 'Comment') $value = str_replace(["\r\n", "\r"], "\n", $value);
        $limit = $field === 'Comment' ? 500 : 100;
        if (preg_match_all('/./us', $value) > $limit) throw new InvalidArgumentException('В одном из полей слишком длинный текст.');
        $payload[$field] = $value;
    }
    if ($payload['LastName'] === '' || $payload['FirstName'] === '') throw new InvalidArgumentException('Укажите фамилию и имя.');
    $phone = $input['Phone'] ?? '';
    if (!is_string($phone)) throw new InvalidArgumentException('Проверьте номер телефона.');
    $digits = preg_replace('/\D/', '', $phone);
    if (strlen($digits) === 10) $digits = '7' . $digits;
    if (strlen($digits) === 11 && $digits[0] === '8') $digits = '7' . substr($digits,1);
    if (!preg_match('/^7\d{10}$/D', $digits)) throw new InvalidArgumentException('Введите номер телефона: +7 и 10 цифр.');
    $birth = $input['BirthDate'] ?? '';
    if (!is_string($birth) || !preg_match('/^\d{4}-\d{2}-\d{2}$/D', $birth)) throw new InvalidArgumentException('Укажите корректную дату рождения.');
    $date = DateTimeImmutable::createFromFormat('!Y-m-d', $birth, new DateTimeZone('Europe/Moscow'));
    if (!$date || $date->format('Y-m-d') !== $birth || $birth < '1900-01-01' || $date > new DateTimeImmutable('today', new DateTimeZone('Europe/Moscow'))) {
        throw new InvalidArgumentException('Укажите корректную дату рождения.');
    }
    $payload['Phone'] = '+' . $digits;
    $payload['BirthDate'] = $birth;
    $payload['Email'] = ''; // The form intentionally has no email field.
    $payload['Allergies'] = ''; // The separate field was removed from the form.
    return $payload;
}

function loyalty_result(string $body, int $status): array {
    $data = json_decode($body, true);
    if ($status >= 500 || $status < 200 || $status >= 300 && $status < 400) return ['IsSuccess'=>false,'Outcome'=>'unknown','Message'=>'Сервис не подтвердил регистрацию. Уточните результат у кофейни перед повторной отправкой.'];
    if (!is_array($data) || !array_key_exists('IsSuccess', $data) || !is_bool($data['IsSuccess'])) {
        return ['IsSuccess'=>false,'Outcome'=>'unknown','Message'=>'Сервис не подтвердил результат регистрации. Уточните у кофейни перед повторной отправкой.'];
    }
    if ($data['IsSuccess'] === true && $status >= 200 && $status < 300) return ['IsSuccess'=>true];
    $message = isset($data['Message']) && is_string($data['Message']) ? trim($data['Message']) : '';
    return ['IsSuccess'=>false,'Message'=>$message !== '' ? $message : 'Регистрация не завершена. Попробуйте позже.'];
}

function loyalty_send(array $payload, string $apiKey): array {
    if (!function_exists('curl_init')) throw new RuntimeException('transport_unavailable');
    $curl = curl_init('https://flexbonus.pro/api/v1/AccountScript/1/OnCreateClient');
    curl_setopt_array($curl, [
        CURLOPT_POST=>true,
        CURLOPT_POSTFIELDS=>json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR),
        CURLOPT_HTTPHEADER=>['Content-Type: application/json','Accept: application/json','ApiKey: '.$apiKey],
        CURLOPT_RETURNTRANSFER=>true,
        CURLOPT_FOLLOWLOCATION=>false,
        CURLOPT_CONNECTTIMEOUT=>8,
        CURLOPT_TIMEOUT=>25,
        CURLOPT_SSL_VERIFYPEER=>true,
        CURLOPT_SSL_VERIFYHOST=>2,
        CURLOPT_PROTOCOLS=>CURLPROTO_HTTPS,
    ]);
    $body = curl_exec($curl);
    $status = (int)curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
    $errno = curl_errno($curl);
    $failed = $errno !== 0 || $body === false;
    loyalty_log('flexbonus_response', [
        'http_status'=>$status,
        'curl_errno'=>$errno,
        'curl_error'=>loyalty_redact(curl_error($curl),$payload,$apiKey),
        'duration_ms'=>(int)round(curl_getinfo($curl,CURLINFO_TOTAL_TIME)*1000),
        'body_bytes'=>$body === false ? 0 : strlen($body),
        'body_redacted'=>$body === false ? null : loyalty_redact($body,$payload,$apiKey),
    ]);
    curl_close($curl);
    if ($failed) throw new RuntimeException('transport_unknown');
    $result = loyalty_result($body, $status);
    if (isset($result['Message'])) $result['Message'] = str_replace($apiKey, '[скрыто]', $result['Message']);
    return $result;
}

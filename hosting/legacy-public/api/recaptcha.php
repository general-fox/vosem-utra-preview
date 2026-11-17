<?php
declare(strict_types=1);

function captcha_config(): array {
    $path = dirname(__DIR__,2).'/vosem-utra-private/recaptcha.php';
    $config = is_file($path) ? require $path : [];
    if (!is_array($config)) $config = [];
    $app = dirname(__DIR__,2).'/vosem-utra-private/app';
    $deployment = is_file($app.'/deployment.php') ? require $app.'/deployment.php' : [];
    $features = is_file($app.'/features.php') ? require $app.'/features.php' : [];
    $callsOnStaging = ($deployment['staging'] ?? false) === true
        && ($deployment['publicOrigin'] ?? '') === 'https://test888.ru'
        && ($features['phone_any_number_enabled'] ?? false) === true;
    return [
        'site_key'=>getenv('RECAPTCHA_SITE_KEY') ?: ($config['site_key'] ?? ''),
        'secret_key'=>getenv('RECAPTCHA_SECRET_KEY') ?: ($config['secret_key'] ?? ''),
        'mode'=>($config['mode'] ?? 'checkbox') === 'invisible' ? 'invisible' : 'checkbox',
        // Only the explicit any-number staging build accepts test888.ru.
        'hostnames'=>$callsOnStaging ? ['test888.ru'] : ['vosem-utra.ru','www.vosem-utra.ru'],
    ];
}

function captcha_verify($token): bool {
    $config = captcha_config();
    if (!$config['site_key'] || !$config['secret_key'] || !function_exists('curl_init')) throw new RuntimeException('captcha_not_configured');
    if (!is_string($token) || trim($token) === '' || strlen($token) > 8192) return false;
    $curl = curl_init('https://www.recaptcha.net/recaptcha/api/siteverify');
    curl_setopt_array($curl,[
        CURLOPT_POST=>true,
        CURLOPT_POSTFIELDS=>http_build_query(['secret'=>$config['secret_key'],'response'=>$token]),
        CURLOPT_RETURNTRANSFER=>true,CURLOPT_CONNECTTIMEOUT=>8,CURLOPT_TIMEOUT=>15,
        CURLOPT_SSL_VERIFYPEER=>true,CURLOPT_SSL_VERIFYHOST=>2,CURLOPT_FOLLOWLOCATION=>false,
        CURLOPT_HTTPHEADER=>['Content-Type: application/x-www-form-urlencoded'],
    ]);
    $body = curl_exec($curl);
    $status = (int)curl_getinfo($curl,CURLINFO_RESPONSE_CODE);
    $errno = curl_errno($curl);
    curl_close($curl);
    if ($errno || $status !== 200 || $body === false) {
        loyalty_log('recaptcha_transport_error',['http_status'=>$status,'curl_errno'=>$errno]);
        throw new RuntimeException('captcha_unavailable');
    }
    $data = json_decode($body,true);
    $passed = is_array($data) && ($data['success'] ?? false) === true && in_array($data['hostname'] ?? '',$config['hostnames'],true);
    loyalty_log('recaptcha_verification',['passed'=>$passed]);
    return $passed;
}

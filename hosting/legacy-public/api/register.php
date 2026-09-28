<?php
declare(strict_types=1);
ini_set('display_errors', '0');
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
require __DIR__.'/loyalty-core.php';
require __DIR__.'/recaptcha.php';
require __DIR__.'/consent-log.php';
$GLOBALS['loyalty_request_id'] = bin2hex(random_bytes(8));
header('X-Request-ID: '.$GLOBALS['loyalty_request_id']);
loyalty_log('request_received', ['method'=>$_SERVER['REQUEST_METHOD'] ?? '']);

function reply(array $body, int $status = 200): void {
    loyalty_log('local_response', ['http_status'=>$status,'is_success'=>$body['IsSuccess'] ?? null]);
    http_response_code($status);
    echo json_encode($body, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}
session_name('vosem_loyalty');
ini_set('session.use_only_cookies', '1');
ini_set('session.gc_maxlifetime', '3600');
// Reject clear-text production requests even when the web-server redirect is missing.
$https = !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off';
$loopback = in_array($_SERVER['REMOTE_ADDR'] ?? '', ['127.0.0.1','::1'], true);
if (!$https && !$loopback) reply(['IsSuccess'=>false,'Message'=>'Для регистрации используйте защищённое соединение HTTPS.'],400);
session_set_cookie_params(['lifetime'=>0,'path'=>'/','secure'=>!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off','httponly'=>true,'samesite'=>'Strict']);
ini_set('session.use_strict_mode', '1');
if (!session_start()) reply(['IsSuccess'=>false,'Message'=>'Не удалось открыть защищённую сессию. Попробуйте позже.'],503);
if (isset($_SESSION['touched']) && time() - $_SESSION['touched'] > 3600) {
    $_SESSION = [];
    session_regenerate_id(true);
}
$_SESSION['touched'] = time();
if (empty($_SESSION['csrf'])) $_SESSION['csrf'] = bin2hex(random_bytes(32));
$method = $_SERVER['REQUEST_METHOD'] ?? '';
if ($method === 'GET') {
    $config = captcha_config();
    if (empty($config['site_key']) || empty($config['secret_key']) || !function_exists('curl_init')) reply(['IsSuccess'=>false,'Message'=>'Проверка временно недоступна. Свяжитесь с кофейней.'],503);
    reply(['csrf'=>$_SESSION['csrf'],'recaptchaSiteKey'=>$config['site_key'],'recaptchaMode'=>$config['mode'],'consentVersion'=>CONSENT_VERSION]);
}
if (!in_array($method,['POST','DELETE'],true)) { header('Allow: GET, POST, DELETE'); reply(['IsSuccess'=>false,'Message'=>'Метод не поддерживается.'],405); }
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
$expectedOrigin = ($https ? 'https://' : 'http://').($_SERVER['HTTP_HOST'] ?? '');
if ($origin !== '' && $origin !== $expectedOrigin) reply(['IsSuccess'=>false,'Message'=>'Недопустимый источник запроса.'],403);
$csrf = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? '';
if (!is_string($csrf) || !hash_equals($_SESSION['csrf'], $csrf)) reply(['IsSuccess'=>false,'Message'=>'Обновите страницу и попробуйте ещё раз.'],403);
if ($method === 'DELETE') {
    $_SESSION = [];
    session_destroy();
    setcookie(session_name(),'', ['expires'=>time()-3600,'path'=>'/','secure'=>$https,'httponly'=>true,'samesite'=>'Strict']);
    reply(['IsSuccess'=>true]);
}
if (stripos($_SERVER['CONTENT_TYPE'] ?? '', 'application/json') !== 0) reply(['IsSuccess'=>false,'Message'=>'Неверный формат запроса.'],415);
$raw = file_get_contents('php://input', false, null, 0, 16385);
if ($raw === false || strlen($raw) > 16384) reply(['IsSuccess'=>false,'Message'=>'Слишком большой запрос.'],413);
$input = json_decode($raw,true);
if (!is_array($input)) reply(['IsSuccess'=>false,'Message'=>'Не удалось прочитать данные формы.'],400);
if (($input['ConsentVersion']??null)!==CONSENT_VERSION) reply(['IsSuccess'=>false,'Message'=>'Текст согласия обновился. Обновите страницу и ознакомьтесь с ним повторно.'],409);
if (($input['CaptchaConsent']??null)!==true) reply(['IsSuccess'=>false,'Message'=>'Для отправки пройдите проверку от спама.'],422);
try { $payload = loyalty_payload($input); }
catch (InvalidArgumentException $e) { reply(['IsSuccess'=>false,'Message'=>$e->getMessage()],422); }

// HMAC fingerprint and response only; never store the submitted personal fields.
$fingerprint = hash_hmac('sha256', json_encode($payload,JSON_UNESCAPED_UNICODE), $_SESSION['csrf']);
if (isset($_SESSION['last']) && $_SESSION['last']['hash'] === $fingerprint && $_SESSION['last']['expires'] > time()) {
    loyalty_log('cached_result', ['upstream_called'=>false,'expires'=>gmdate('c',$_SESSION['last']['expires']),'is_success'=>$_SESSION['last']['result']['IsSuccess'] ?? null]);
    reply($_SESSION['last']['result']);
}
if (isset($_SESSION['attempt']) && time() - $_SESSION['attempt'] < 5) reply(['IsSuccess'=>false,'Message'=>'Подождите несколько секунд перед повторной отправкой.'],429);
$apiKey = getenv('FLEXBONUS_API_KEY') ?: '';
$privatePath = dirname(__DIR__,2).'/vosem-utra-private/loyalty.php';
if ($apiKey === '' && is_file($privatePath)) {
    $config = require $privatePath;
    $apiKey = is_array($config) && is_string($config['api_key'] ?? null) ? $config['api_key'] : '';
}
if ($apiKey === '' || !function_exists('curl_init')) reply(['IsSuccess'=>false,'Message'=>'Регистрация временно недоступна. Попробуйте позже.'],503);
$_SESSION['attempt'] = time();
try {
    if (!captcha_verify($input['RecaptchaToken'] ?? null)) reply(['IsSuccess'=>false,'Message'=>'Подтвердите, что вы не робот, ещё раз.'],422);
} catch (Throwable $e) {
    loyalty_log('recaptcha_unavailable',['configured'=>!empty(captcha_config()['secret_key'])]);
    reply(['IsSuccess'=>false,'Message'=>'Проверка «Я не робот» временно недоступна. Попробуйте позже.'],503);
}
loyalty_log('flexbonus_request_started', ['method'=>'POST']);
try { $receipt = consent_record($payload); }
catch (Throwable $e) { reply(['IsSuccess'=>false,'Message'=>'Не удалось сохранить согласие. Анкета не отправлена. Свяжитесь с кофейней.'],503); }
try { $result = loyalty_send($payload,$apiKey); }
catch (Throwable $e) {
    loyalty_log('handler_exception', ['class'=>get_class($e),'message'=>loyalty_redact($e->getMessage(),$payload,$apiKey)]);
    consent_result($receipt,'unknown');
    $result = ['IsSuccess'=>false,'Outcome'=>'unknown','Receipt'=>$receipt,'Message'=>'Не удалось получить подтверждение регистрации. Возможно, данные уже приняты. Уточните у кофейни перед повторной отправкой.'];
    $_SESSION['last'] = ['hash'=>$fingerprint,'expires'=>time()+600,'result'=>$result];
    reply($result,502);
}
consent_result($receipt, $result['IsSuccess']===true ? 'confirmed' : (($result['Outcome']??'')==='unknown' ? 'unknown' : 'rejected'));
$result['Receipt'] = $receipt;
// Never automatically repeat a request with an uncertain upstream outcome.
if ($result['IsSuccess'] === true || ($result['Outcome']??'')==='unknown') $_SESSION['last'] = ['hash'=>$fingerprint,'expires'=>time()+3600,'result'=>$result];
reply($result);
